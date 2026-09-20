const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');
const db = require('./db');
const { regenerateLoginBackground } = require('./loginBackground');
const { importArtistPhotosToDb } = require('./artistPhotos');

// MUSIC_DIR may be a single path or several, separated by commas —
// e.g. MUSIC_DIR=/music/collection1,/music/collection2
const MUSIC_DIRS = (process.env.MUSIC_DIR || '/music')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

function albumKeyFor(albumArtist, artist, album) {
  const a = (albumArtist || artist || '').trim().toLowerCase();
  const b = (album || '').trim().toLowerCase();
  if (!b) return null;
  return `${a}::${b}`;
}

// Recursively walk a directory, yielding .mp3 file paths. Async (fs.promises.readdir) rather
// than the sync fs.readdirSync this used to call — Node is single-threaded, so a synchronous
// walk over a big library (or a slow network share) blocks the ENTIRE server, including the
// very request that's supposed to report scan progress, for as long as the walk takes. That's
// what made a rescan look like it wasn't doing anything: the UI genuinely couldn't hear back
// from the server until the whole directory tree had already been walked. Awaiting readdir
// yields control back to the event loop between directories, so status updates (see runScan
// below) can actually reach the browser while a big scan is still working through its files.
// onDirError(dir, err) is called (rather than throwing) if a directory can't be read, so one
// bad folder doesn't abort the whole scan.
async function* walk(dir, onDirError) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read directory ${dir}: ${err.message}`);
    if (onDirError) onDirError(dir, err);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, onDirError);
    } else if (entry.isFile() && /\.mp3$/i.test(entry.name)) {
      yield full;
    }
  }
}

// Walk every configured music directory, yielding .mp3 file paths across all of them.
async function* walkAll(dirs, onDirError) {
  for (const dir of dirs) {
    yield* walk(dir, onDirError);
  }
}

function firstOf(val) {
  if (Array.isArray(val)) return val.length ? val[0] : null;
  return val || null;
}

async function scanFile(filepath) {
  const stat = fs.statSync(filepath);
  const metadata = await mm.parseFile(filepath, { duration: true, skipCovers: false });
  const common = metadata.common || {};
  const format = metadata.format || {};

  const titleMissing = !common.title;
  const title = common.title || path.basename(filepath, path.extname(filepath));
  const artist = common.artist || common.artists?.join(', ') || null;
  const albumArtist = common.albumartist || null;
  const album = common.album || null;
  const year = common.year || (common.date ? parseInt(String(common.date).slice(0, 4), 10) : null) || null;
  const genre = firstOf(common.genre);
  const trackNo = common.track && common.track.no ? common.track.no : null;
  const discNo = common.disk && common.disk.no ? common.disk.no : null;
  const duration = format.duration || null;
  const bitrate = format.bitrate ? Math.round(format.bitrate) : null;

  const albumKey = albumKeyFor(albumArtist, artist, album);
  const picture = common.picture && common.picture.length ? common.picture[0] : null;

  return {
    filepath,
    filename: path.basename(filepath),
    title,
    artist,
    album_artist: albumArtist,
    album,
    year: year ? parseInt(year, 10) : null,
    genre,
    track_no: trackNo,
    disc_no: discNo,
    duration,
    bitrate,
    filesize: stat.size,
    album_key: albumKey,
    title_missing: titleMissing ? 1 : 0,
    mtime: Math.round(stat.mtimeMs),
    picture,
  };
}

// added_at is intentionally NOT in the ON CONFLICT DO UPDATE SET list below — that's what makes
// it "when this track was first added" rather than "when it was last scanned": a fresh insert
// stores it, but a rescan hitting an existing row (the ON CONFLICT branch) leaves it untouched.
const upsertTrack = db.prepare(`
  INSERT INTO tracks (filepath, filename, title, artist, album_artist, album, year, genre,
    track_no, disc_no, duration, bitrate, filesize, album_key, title_missing, mtime, last_scanned, added_at)
  VALUES (@filepath, @filename, @title, @artist, @album_artist, @album, @year, @genre,
    @track_no, @disc_no, @duration, @bitrate, @filesize, @album_key, @title_missing, @mtime, @last_scanned, @added_at)
  ON CONFLICT(filepath) DO UPDATE SET
    filename=excluded.filename, title=excluded.title, artist=excluded.artist,
    album_artist=excluded.album_artist, album=excluded.album, year=excluded.year,
    genre=excluded.genre, track_no=excluded.track_no, disc_no=excluded.disc_no,
    duration=excluded.duration, bitrate=excluded.bitrate, filesize=excluded.filesize,
    album_key=excluded.album_key, title_missing=excluded.title_missing,
    mtime=excluded.mtime, last_scanned=excluded.last_scanned
`);

const getTrackByPath = db.prepare(`SELECT id, mtime FROM tracks WHERE filepath = ?`);
const getCover = db.prepare(`SELECT album_key FROM album_covers WHERE album_key = ?`);
const upsertCover = db.prepare(`
  INSERT INTO album_covers (album_key, mime, data, source_track_id)
  VALUES (@album_key, @mime, @data, @source_track_id)
  ON CONFLICT(album_key) DO UPDATE SET mime=excluded.mime, data=excluded.data, source_track_id=excluded.source_track_id
`);
const allFilepaths = db.prepare(`SELECT id, filepath FROM tracks`);
const deleteTrack = db.prepare(`DELETE FROM tracks WHERE id = ?`);
const clearScanErrors = db.prepare(`DELETE FROM scan_errors`);
const insertScanError = db.prepare(`
  INSERT INTO scan_errors (filepath, message, occurred_at) VALUES (@filepath, @message, @occurred_at)
`);
const updateStatus = db.prepare(`
  UPDATE scan_status SET status=@status, started_at=@started_at, finished_at=@finished_at,
    files_found=@files_found, files_processed=@files_processed, files_added=@files_added,
    files_updated=@files_updated, files_removed=@files_removed, errors=@errors, last_error=@last_error
  WHERE id = 1
`);

let scanning = false;

function getScanStatus() {
  return db.prepare(`SELECT * FROM scan_status WHERE id = 1`).get();
}

async function runScan() {
  if (scanning) return getScanStatus();
  scanning = true;

  const status = {
    status: 'running',
    started_at: Date.now(),
    finished_at: null,
    files_found: 0,
    files_processed: 0,
    files_added: 0,
    files_updated: 0,
    files_removed: 0,
    errors: 0,
    last_error: null,
  };
  updateStatus.run(status);
  clearScanErrors.run();

  // Pushes the current status to the DB (so GET /api/scan/status can see it) at most a few
  // times a second — frequent enough that the progress bar feels live, rare enough not to
  // hammer SQLite with a write per file on a library with tens of thousands of tracks. `force`
  // bypasses the throttle for the handful of updates that always need to land immediately
  // (a directory-read failure, or the very last file).
  let lastStatusWrite = 0;
  function pushStatus(force) {
    const now = Date.now();
    if (!force && now - lastStatusWrite < 400) return;
    lastStatusWrite = now;
    updateStatus.run(status);
  }

  try {
    // Phase 1: a quick pass that only lists directories, to get a file count up front — so the
    // frontend can show real "X of Y" progress (and a percentage) during phase 2, instead of an
    // open-ended counter with no sense of how much is left. This is cheap even on a slow or
    // network-mounted library, since it skips the expensive part (phase 2's per-file ID3
    // parsing) entirely; it just counts. A directory-read failure here isn't recorded (walk()
    // already logs it to the console) — phase 2 walks the same tree and records it into
    // scan_errors there, so it isn't double-counted.
    for await (const _file of walkAll(MUSIC_DIRS, () => {})) {
      status.files_found++;
      pushStatus(false);
    }
    pushStatus(true);

    // Phase 2: walk again, this time actually reading tags and writing to the DB. Files added or
    // removed on disk between phase 1 and phase 2 (rare, since this whole scan is usually
    // seconds to a couple of minutes) just mean files_processed ends up slightly off from
    // files_found — harmless, since it's only ever used for the progress display.
    const seen = new Set();

    for await (const filepath of walkAll(MUSIC_DIRS, (dir, err) => {
      status.errors++;
      insertScanError.run({ filepath: dir, message: `Cannot read directory: ${err.message}`, occurred_at: Date.now() });
      pushStatus(true);
    })) {
      seen.add(filepath);
      try {
        const existing = getTrackByPath.get(filepath);
        const stat = fs.statSync(filepath);
        const mtime = Math.round(stat.mtimeMs);

        if (existing && existing.mtime === mtime) {
          status.files_processed++;
        } else {
          const track = await scanFile(filepath);
          const { picture, ...trackRow } = track;
          trackRow.last_scanned = Date.now();
          trackRow.added_at = Date.now();
          upsertTrack.run(trackRow);

          if (track.album_key && picture) {
            const hasCover = getCover.get(track.album_key);
            if (!hasCover) {
              const trackId = getTrackByPath.get(filepath).id;
              upsertCover.run({
                album_key: track.album_key,
                mime: picture.format || 'image/jpeg',
                data: Buffer.from(picture.data),
                source_track_id: trackId,
              });
            }
          }

          if (existing) status.files_updated++;
          else status.files_added++;
          status.files_processed++;
        }
      } catch (err) {
        status.errors++;
        status.last_error = `${filepath}: ${err.message}`;
        insertScanError.run({ filepath, message: err.message, occurred_at: Date.now() });
        console.error(`Error scanning ${filepath}: ${err.message}`);
      }
      pushStatus(false);
    }

    // Remove DB entries for files that no longer exist on disk.
    // (.all() rather than .iterate() — better-sqlite3 can't run another
    // statement, like the delete below, while an iterate() cursor is open.)
    for (const row of allFilepaths.all()) {
      if (!seen.has(row.filepath)) {
        deleteTrack.run(row.id);
        status.files_removed++;
      }
    }

    status.status = 'idle';
    status.finished_at = Date.now();
    pushStatus(true);

    // Re-import artist photos from disk into the DB, then refresh the login page's background
    // picture set from that fresh import — a rescan is the ONLY trigger for either (see
    // artistPhotos.js and loginBackground.js; also run once at server startup — see index.js).
    // Failure here (e.g. artist-pictures dir unreadable) shouldn't mark the whole scan as
    // failed, so each is caught locally.
    try {
      importArtistPhotosToDb();
    } catch (err) {
      console.error('Failed to import artist photos:', err);
    }
    try {
      regenerateLoginBackground();
    } catch (err) {
      console.error('Failed to refresh login background:', err);
    }
  } catch (err) {
    status.status = 'error';
    status.last_error = err.message;
    status.finished_at = Date.now();
    updateStatus.run(status);
    console.error('Scan failed:', err);
  } finally {
    scanning = false;
  }

  return getScanStatus();
}

module.exports = { runScan, getScanStatus, MUSIC_DIRS };
