const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const db = require('./db');

const ARTIST_PICTURES_DIR = process.env.ARTIST_PICTURES_DIR || '/artist-pictures';
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;
const PREFERRED_NAMES = ['folder.jpg', 'folder.jpeg', 'folder.png', 'artist.jpg', 'cover.jpg'];

let folderIndex = null; // normalized name -> { realName, dir }
let indexedAt = 0;
const INDEX_TTL_MS = 5 * 60 * 1000; // rebuild at most every 5 minutes

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildIndex() {
  const index = new Map();
  let entries;
  try {
    entries = fs.readdirSync(ARTIST_PICTURES_DIR, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read artist pictures dir ${ARTIST_PICTURES_DIR}: ${err.message}`);
    folderIndex = index;
    indexedAt = Date.now();
    return index;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const key = normalize(entry.name);
    if (key) index.set(key, { realName: entry.name, dir: path.join(ARTIST_PICTURES_DIR, entry.name) });
  }
  folderIndex = index;
  indexedAt = Date.now();
  return index;
}

function getIndex(forceRefresh = false) {
  if (forceRefresh || !folderIndex || Date.now() - indexedAt > INDEX_TTL_MS) {
    return buildIndex();
  }
  return folderIndex;
}

function findImageInDir(dir) {
  let files;
  try {
    files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  } catch {
    return null;
  }
  const names = files.map((f) => f.name);

  for (const preferred of PREFERRED_NAMES) {
    const match = names.find((n) => n.toLowerCase() === preferred);
    if (match) return path.join(dir, match);
  }
  const anyImage = names.find((n) => IMAGE_EXT.test(n));
  return anyImage ? path.join(dir, anyImage) : null;
}

// A Windows/host-style path (a drive letter like "D:/..." or any backslash) showing up as the
// CONTAINER-internal ARTIST_PICTURES_DIR is a dead giveaway that ARTIST_PICTURES_DIR and
// ARTIST_PICTURES_HOST_DIR got mixed up in .env — the container has no D: drive, so this path
// can never resolve no matter how the volume itself is mounted.
function looksLikeHostPath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.includes('\\');
}

// Self-diagnostic info for the Health tab, so a "no photos are matching" report can be
// narrowed down without needing to open a shell in the container: is the directory even
// readable (mount/permissions problem), and if so, what folder names does it actually see
// (naming-mismatch problem)? Deliberately forces a fresh disk read — this is the one place
// that's SUPPOSED to reflect live disk state, since its whole job is diagnosing what's out
// there right now, unlike everything below which reads from the DB import instead.
function getDiagnostics() {
  let dirReadable = true;
  let error = null;
  try {
    fs.accessSync(ARTIST_PICTURES_DIR, fs.constants.R_OK);
  } catch (err) {
    dirReadable = false;
    error = err.message;
  }
  const index = getIndex(true);
  const folders = [...index.values()].map((v) => v.realName).sort((a, b) => a.localeCompare(b));
  return {
    dir: ARTIST_PICTURES_DIR,
    dirReadable,
    error,
    looksLikeHostPath: looksLikeHostPath(ARTIST_PICTURES_DIR),
    folderCount: folders.length,
    folders: folders.slice(0, 300),
  };
}

// Returns { name, filepath, mtime } for every artist folder that has a matching photo — the
// raw, live-from-disk view. Nothing in a normal request path calls this any more (see the
// DB-backed section below) — it's used only by importArtistPhotosToDb() and the Health tab's
// diagnostics, both deliberately infrequent.
function listAllArtistPhotos() {
  const index = getIndex(true); // force a fresh read — this only runs at import time, not per-request
  const results = [];
  for (const entry of index.values()) {
    const imagePath = findImageInDir(entry.dir);
    if (!imagePath) continue;
    try {
      const stat = fs.statSync(imagePath);
      results.push({ name: entry.realName, filepath: imagePath, mtime: stat.mtimeMs });
    } catch {
      // file vanished between readdir and stat — skip it
    }
  }
  return results;
}

// ---------- DB-backed photo storage (what every request actually reads) ----------
//
// Artist photos are imported into the artist_photos table (see db.js) — once at server
// startup, and again at the end of every rescan (see scanner.js and index.js) — rather than
// read from ARTIST_PICTURES_DIR on demand. Before this existed, opening the Artists tab, an
// artist's own page, or the Health tab meant a live filesystem read (a directory listing, then
// a full file stream to actually serve the image) for every artist shown, on every visit — slow
// on any setup, and much worse if ARTIST_PICTURES_DIR is a network share. Everything below is a
// plain indexed SQLite read instead, same pattern the app already uses for embedded album cover
// art (album_covers).

const hasPhotoStmt = db.prepare(`SELECT 1 FROM artist_photos WHERE artist_key = ?`);
const getPhotoStmt = db.prepare(`SELECT mime, data FROM artist_photos WHERE artist_key = ?`);
const upsertPhotoStmt = db.prepare(`
  INSERT INTO artist_photos (artist_key, real_name, mime, data, source_mtime, imported_at)
  VALUES (@artist_key, @real_name, @mime, @data, @source_mtime, @imported_at)
  ON CONFLICT(artist_key) DO UPDATE SET
    real_name = excluded.real_name, mime = excluded.mime, data = excluded.data,
    source_mtime = excluded.source_mtime, imported_at = excluded.imported_at
`);
const deletePhotoStmt = db.prepare(`DELETE FROM artist_photos WHERE artist_key = ?`);
const allPhotoKeysStmt = db.prepare(`SELECT artist_key, source_mtime FROM artist_photos`);

// Cheap existence check (an indexed point lookup, no BLOB read) — for the has_photo flag shown
// on the Artists grid, an artist's own page, the Album page, and the Health tab.
function hasArtistPhoto(artistName) {
  const key = normalize(artistName);
  if (!key) return false;
  return !!hasPhotoStmt.get(key);
}

// Returns { mime, data } for an artist's photo (looked up by raw artist name, normalized the
// same way as everywhere else in the app), or null. Used to actually serve the image bytes.
function getArtistPhoto(artistName) {
  const key = normalize(artistName);
  if (!key) return null;
  return getPhotoStmt.get(key) || null;
}

// Same as getArtistPhoto, but for a caller that already has a normalized key rather than a raw
// artist name — the login background image route, which stores keys (see loginBackground.js).
function getArtistPhotoByKey(key) {
  if (!key) return null;
  return getPhotoStmt.get(key) || null;
}

// Refreshes artist_photos from disk. The only place this module still touches
// ARTIST_PICTURES_DIR for photo CONTENT outside of getDiagnostics() — called once at server
// startup and once at the end of every rescan (never from a request handler), so requests never
// pay filesystem cost for photos at all. Skips re-reading a file whose mtime hasn't changed
// since it was last imported, and removes rows for artist folders that no longer match anything
// (renamed or deleted on disk since the last import).
function importArtistPhotosToDb() {
  const found = listAllArtistPhotos();
  const existing = new Map(allPhotoKeysStmt.all().map((r) => [r.artist_key, r.source_mtime]));
  const seenKeys = new Set();
  let imported = 0;
  let unchanged = 0;

  const removed = db.transaction(() => {
    for (const photo of found) {
      const key = normalize(photo.name);
      if (!key) continue;
      seenKeys.add(key);
      if (existing.get(key) === photo.mtime) {
        unchanged++;
        continue;
      }
      let data;
      try {
        data = fs.readFileSync(photo.filepath);
      } catch (err) {
        console.error(`Could not read artist photo ${photo.filepath}: ${err.message}`);
        continue;
      }
      upsertPhotoStmt.run({
        artist_key: key,
        real_name: photo.name,
        mime: mime.lookup(photo.filepath) || 'image/jpeg',
        data,
        source_mtime: photo.mtime,
        imported_at: Date.now(),
      });
      imported++;
    }
    let removedCount = 0;
    for (const key of existing.keys()) {
      if (!seenKeys.has(key)) {
        deletePhotoStmt.run(key);
        removedCount++;
      }
    }
    return removedCount;
  })();

  return { imported, unchanged, removed, total: seenKeys.size };
}

module.exports = {
  hasArtistPhoto,
  getArtistPhoto,
  getArtistPhotoByKey,
  importArtistPhotosToDb,
  listAllArtistPhotos,
  getDiagnostics,
  ARTIST_PICTURES_DIR,
  normalize,
};
