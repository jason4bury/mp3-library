const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../db');
const { runScan, getScanStatus } = require('../scanner');
const { hasArtistPhoto, getArtistPhoto, getDiagnostics: getArtistPhotoDiagnostics, normalize: normalizeArtistName } = require('../artistPhotos');
const { buildFtsQuery } = require('../search');
const { getArtistInfo, getAlbumInfo, getScrobbleStatus, startAuth, completeAuth, disconnect, updateNowPlaying, scrobble } = require('../lastfm');
const pkg = require('../../package.json');

const router = express.Router();

const SORTABLE_FIELDS = new Set(['title', 'artist', 'album', 'year', 'genre', 'track_no', 'duration', 'play_count', 'last_played_at', 'added_at']);

// GET /api/about — app name/version/description for the About dialog
router.get('/about', (req, res) => {
  res.json({ name: pkg.name, version: pkg.version, description: pkg.description });
});

// Builds the WHERE/FROM clause shared by GET /api/tracks and smart playlists (which are just
// a saved copy of these same filters, re-run live instead of a fixed track list).
function trackFilterClause(filters) {
  const { q, artist, album, year, genre, favorite, decade } = filters || {};
  const where = [];
  const params = {};

  if (artist) {
    where.push('t.artist = @artist');
    params.artist = artist;
  }
  if (album) {
    where.push('t.album = @album');
    params.album = album;
  }
  if (year) {
    where.push('t.year = @year');
    params.year = parseInt(year, 10);
  }
  if (genre) {
    where.push('t.genre = @genre');
    params.genre = genre;
  }
  if (favorite) {
    where.push('t.favorite = 1');
  }
  // decade is a starting year (e.g. 1990 for "the 1990s") — used by the "generate one playlist
  // per decade" bulk action, since a single `year` filter can't express a 10-year span.
  if (decade !== undefined && decade !== null && decade !== '') {
    const decadeStart = parseInt(decade, 10);
    where.push('t.year >= @decadeStart AND t.year < @decadeEnd');
    params.decadeStart = decadeStart;
    params.decadeEnd = decadeStart + 10;
  }

  const ftsQuery = buildFtsQuery(q);
  let fromClause = 'tracks t';
  if (ftsQuery) {
    fromClause = 'tracks t JOIN tracks_fts f ON f.rowid = t.id';
    where.push('tracks_fts MATCH @ftsQuery');
    params.ftsQuery = ftsQuery;
  }

  return { fromClause, whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// GET /api/tracks — search & filter
router.get('/tracks', (req, res) => {
  const { q, artist, album, year, genre, favorite, sort = 'artist', dir = 'asc', page = '1', pageSize = '50' } = req.query;

  const { fromClause, whereClause, params } = trackFilterClause({ q, artist, album, year, genre, favorite });
  const sortField = SORTABLE_FIELDS.has(sort) ? sort : 'artist';
  const sortDir = dir === 'desc' ? 'DESC' : 'ASC';

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));
  const offset = (pageNum - 1) * size;

  const totalRow = db.prepare(`SELECT COUNT(*) as n FROM ${fromClause} ${whereClause}`).get(params);

  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.artist, t.album_artist, t.album, t.year, t.genre,
              t.track_no, t.disc_no, t.duration, t.bitrate, t.album_key, t.favorite, t.play_count, t.last_played_at, t.added_at
       FROM ${fromClause} ${whereClause}
       ORDER BY t.${sortField} COLLATE NOCASE ${sortDir}, t.disc_no ASC, t.track_no ASC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: size, offset });

  res.json({ total: totalRow.n, page: pageNum, pageSize: size, tracks: rows });
});

// GET /api/tracks/shuffle-all — every track in the library (ignoring any filters currently
// applied on-screen), pre-randomized server-side, for the Tracks tab's "Shuffle All" button.
// Deliberately separate from GET /api/tracks rather than an "all" pageSize there, since that
// route's pageSize is capped at 200 for normal paginated browsing.
router.get('/tracks/shuffle-all', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, title, artist, album, album_key, duration FROM tracks ORDER BY RANDOM()`
    )
    .all();
  res.json({ tracks: rows });
});

// GET /api/tracks/rediscover — a shuffled queue biased toward tracks you haven't played
// recently (or ever), for the "🌱 Rediscover" button. Unlike Shuffle All (even odds across the
// whole library), this pulls a bounded candidate pool — never-played tracks first, then the
// least-recently-played — and only shuffles the *order* within that pool, so it surfaces
// neglected tracks instead of just being another full-library shuffle.
router.get('/tracks/rediscover', (req, res) => {
  const pool = db
    .prepare(
      `SELECT id, title, artist, album, album_key, duration FROM tracks
       ORDER BY (last_played_at IS NOT NULL) ASC, last_played_at ASC, RANDOM()
       LIMIT 150`
    )
    .all();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  res.json({ tracks: pool });
});

// GET /api/tracks/by-ids?ids=3,1,2 — bulk lookup used to restore a saved queue (the "Now
// Playing" queue snapshot in app.js — see saveQueueSnapshot/restoreResumeState) on page load,
// for queue types that have no other way to reconstruct their exact track list (Tracks tab,
// Shuffle All, Rediscover, Radio, History, recap "On this day" — a real saved playlist instead
// re-fetches live via GET /api/playlists/:id, which also picks up any changes since). Returns
// tracks in the SAME ORDER as the ids given (not id order), silently skipping any id that no
// longer exists (a track deleted since the queue was saved) rather than erroring — the caller
// just ends up with a shorter queue. Must stay before /tracks/:id below, same reasoning as
// /tracks/shuffle-all and /tracks/rediscover.
router.get('/tracks/by-ids', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n))
    .slice(0, 5000); // sanity cap — a saved queue this large is not a realistic case
  if (!ids.length) return res.json({ tracks: [] });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, title, artist, album, album_key, duration, favorite, play_count, last_played_at
       FROM tracks WHERE id IN (${placeholders})`
    )
    .all(...ids);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  res.json({ tracks: ordered });
});

// GET /api/tracks/:id — single-track lookup, used to restore "resume where you left off"
// state on page load. Must stay after the /tracks/shuffle-all and /tracks/rediscover routes
// above, or Express would match those literal paths as this :id param instead.
router.get('/tracks/:id', (req, res) => {
  const track = db
    .prepare(
      `SELECT id, title, artist, album, album_key, duration, favorite, play_count, last_played_at
       FROM tracks WHERE id = ?`
    )
    .get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  res.json(track);
});

// GET /api/tracks/:id/radio — a "start a radio from this track" queue: the track itself first,
// then a shuffled mix of tracks by artists similar to it. Similar-artist data comes from
// whatever's already cached from Artist Info page views (GET /api/artists/:name/lastfm) — this
// deliberately does NOT trigger a fresh Last.fm fetch, so Radio stays fast and still works
// (falling back to same-genre, then same-artist, tracks) even with no Last.fm key configured or
// an artist Last.fm has never heard of. Has its own path segment after :id, so — unlike
// /tracks/shuffle-all and /tracks/rediscover above — it doesn't need to come before the bare
// /tracks/:id route; Express only matches that one when there's nothing after the id.
router.get('/tracks/:id/radio', (req, res) => {
  const seed = db.prepare(`SELECT id, title, artist, album, album_key, duration, genre FROM tracks WHERE id = ?`).get(req.params.id);
  if (!seed) return res.status(404).json({ error: 'Track not found' });

  const candidateArtists = [seed.artist].filter(Boolean);
  let usedSimilarArtists = false;

  if (seed.artist) {
    const cacheKey = seed.artist.trim().toLowerCase();
    const cached = db.prepare(`SELECT data, status FROM lastfm_cache WHERE artist_key = ?`).get(cacheKey);
    if (cached && cached.status === 'ok' && cached.data) {
      try {
        const parsed = JSON.parse(cached.data);
        (parsed.similar || []).forEach((s) => {
          if (s.name && !candidateArtists.some((a) => a.toLowerCase() === s.name.toLowerCase())) {
            candidateArtists.push(s.name);
          }
        });
        usedSimilarArtists = candidateArtists.length > 1;
      } catch {
        // Malformed cache row — just fall through to the genre/same-artist fallback below.
      }
    }
  }

  let pool = [];
  if (candidateArtists.length > 1) {
    const placeholders = candidateArtists.map(() => '?').join(',');
    pool = db
      .prepare(
        `SELECT id, title, artist, album, album_key, duration FROM tracks
         WHERE artist COLLATE NOCASE IN (${placeholders})
         ORDER BY RANDOM() LIMIT 80`
      )
      .all(...candidateArtists);
  }

  // Top up (or, with no Last.fm data at all, entirely fill) the pool from the same genre, or
  // failing that just more of the same artist, so Radio always has something to play.
  if (pool.length < 15) {
    const seen = new Set(pool.map((t) => t.id));
    const extra = seed.genre
      ? db.prepare(`SELECT id, title, artist, album, album_key, duration FROM tracks WHERE genre = ? ORDER BY RANDOM() LIMIT 80`).all(seed.genre)
      : db.prepare(`SELECT id, title, artist, album, album_key, duration FROM tracks WHERE artist = ? ORDER BY RANDOM() LIMIT 80`).all(seed.artist);
    extra.forEach((t) => {
      if (!seen.has(t.id)) {
        pool.push(t);
        seen.add(t.id);
      }
    });
  }

  pool = pool.filter((t) => t.id !== seed.id);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const { genre, ...seedTrack } = seed;
  res.json({ tracks: [seedTrack, ...pool.slice(0, 49)], used_similar_artists: usedSimilarArtists });
});

// GET /api/quick-search?q= — lightweight autocomplete for the topbar search box: a handful of
// top matches each of artists, albums and tracks, for a suggestions dropdown as the user
// types. Deliberately simple LIKE queries rather than the tracks_fts index (which only covers
// track rows) — fast enough for a short, capped list, and this also needs to match distinct
// artist/album names, not just tracks.
router.get('/quick-search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ artists: [], albums: [], tracks: [] });
  const like = `%${q}%`;

  const artists = db
    .prepare(
      `SELECT artist, COUNT(*) as track_count FROM tracks
       WHERE artist LIKE @like AND artist IS NOT NULL AND artist != ''
       GROUP BY artist COLLATE NOCASE ORDER BY artist COLLATE NOCASE ASC LIMIT 5`
    )
    .all({ like });

  const albums = db
    .prepare(
      `SELECT album, album_key, artist, MIN(year) as year FROM tracks
       WHERE album LIKE @like AND album IS NOT NULL
       GROUP BY album_key ORDER BY album COLLATE NOCASE ASC LIMIT 5`
    )
    .all({ like });

  const tracks = db
    .prepare(
      `SELECT id, title, artist, album, album_key FROM tracks
       WHERE title LIKE @like AND title IS NOT NULL
       ORDER BY title COLLATE NOCASE ASC LIMIT 5`
    )
    .all({ like });

  res.json({ artists, albums, tracks });
});

// PUT /api/tracks/:id/favorite — toggle, or set explicitly with { favorite: true|false }
router.put('/tracks/:id/favorite', (req, res) => {
  const track = db.prepare(`SELECT id, favorite FROM tracks WHERE id = ?`).get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });

  const next = req.body && typeof req.body.favorite === 'boolean' ? (req.body.favorite ? 1 : 0) : (track.favorite ? 0 : 1);
  db.prepare(`UPDATE tracks SET favorite = ? WHERE id = ?`).run(next, req.params.id);
  res.json({ id: track.id, favorite: !!next });
});

// GET /api/artists — distinct artists with counts, alphabetical, optional ?q= filter.
// Pass ?photos=0 to skip the has_photo lookup — used by callers that only need the artist
// names/counts (the Tracks-tab filter dropdown, the playlist-generator's artist picker), since
// resolving has_photo for every artist means a disk lookup per artist (cached, but still real
// work on a cold cache) that those callers just throw away.
router.get('/artists', (req, res) => {
  const { q, photos } = req.query;
  let where = "WHERE artist IS NOT NULL AND artist != ''";
  const params = {};
  if (q) {
    where += ' AND artist LIKE @q';
    params.q = `%${q}%`;
  }
  const rows = db
    .prepare(
      `SELECT artist, COUNT(*) as track_count, COUNT(DISTINCT album) as album_count
       FROM tracks ${where}
       GROUP BY artist COLLATE NOCASE
       ORDER BY artist COLLATE NOCASE ASC`
    )
    .all(params);

  if (photos === '0') return res.json({ artists: rows });

  const withPhotos = rows.map((r) => ({ ...r, has_photo: hasArtistPhoto(r.artist) }));
  res.json({ artists: withPhotos });
});

// GET /api/artists/:name — albums + tracks for one artist
router.get('/artists/:name', (req, res) => {
  const artist = req.params.name;
  const albums = db
    .prepare(
      `SELECT album, album_key, MIN(year) as year, COUNT(*) as track_count
       FROM tracks WHERE artist = @artist AND album IS NOT NULL
       GROUP BY album COLLATE NOCASE ORDER BY year ASC, album COLLATE NOCASE ASC`
    )
    .all({ artist });

  const tracks = db
    .prepare(
      `SELECT id, title, album, year, track_no, disc_no, duration, album_key, favorite, play_count, last_played_at
       FROM tracks WHERE artist = @artist
       ORDER BY year ASC, album COLLATE NOCASE ASC, disc_no ASC, track_no ASC`
    )
    .all({ artist });

  res.json({
    artist,
    has_photo: hasArtistPhoto(artist),
    albums,
    tracks,
  });
});

// GET /api/artists/:name/lastfm — cached Last.fm bio/tags/similar-artists lookup.
// Pass ?refresh=1 to bypass the cache and re-fetch from Last.fm.
router.get('/artists/:name/lastfm', async (req, res) => {
  try {
    const result = await getArtistInfo(req.params.name, { force: req.query.refresh === '1' });
    res.json(result);
  } catch (err) {
    console.error('Last.fm route error:', err);
    res.status(500).json({ configured: true, status: 'error', message: err.message });
  }
});

// GET /api/albums — distinct albums, optional ?artist=
router.get('/albums', (req, res) => {
  const { artist } = req.query;
  let where = "WHERE album IS NOT NULL AND album != ''";
  const params = {};
  if (artist) {
    where += ' AND artist = @artist';
    params.artist = artist;
  }
  const rows = db
    .prepare(
      `SELECT album, album_key, artist, MIN(year) as year, COUNT(*) as track_count
       FROM tracks ${where}
       GROUP BY album COLLATE NOCASE, artist COLLATE NOCASE
       ORDER BY album COLLATE NOCASE ASC`
    )
    .all(params);
  res.json({ albums: rows });
});

// GET /api/albums/:albumKey — full metadata + track listing for one album
router.get('/albums/:albumKey', (req, res) => {
  const albumKey = req.params.albumKey;
  const meta = db
    .prepare(
      `SELECT album, artist, MIN(year) as year, COUNT(*) as track_count
       FROM tracks WHERE album_key = @albumKey GROUP BY album_key`
    )
    .get({ albumKey });
  if (!meta) return res.status(404).json({ error: 'Album not found' });

  const tracks = db
    .prepare(
      `SELECT id, title, artist, album, year, genre, track_no, disc_no, duration, favorite, play_count, last_played_at
       FROM tracks WHERE album_key = @albumKey
       ORDER BY disc_no ASC, track_no ASC`
    )
    .all({ albumKey });

  const hasCover = !!db.prepare(`SELECT 1 FROM album_covers WHERE album_key = ?`).get(albumKey);

  res.json({
    album_key: albumKey,
    album: meta.album,
    artist: meta.artist,
    year: meta.year,
    track_count: meta.track_count,
    has_cover: hasCover,
    has_photo: hasArtistPhoto(meta.artist),
    tracks,
  });
});

// GET /api/albums/:albumKey/lastfm — cached Last.fm album lookup (wiki/tags/listener stats).
// Pass ?refresh=1 to bypass the cache and re-fetch from Last.fm.
router.get('/albums/:albumKey/lastfm', async (req, res) => {
  try {
    const albumKey = req.params.albumKey;
    const meta = db.prepare(`SELECT album, artist FROM tracks WHERE album_key = ? LIMIT 1`).get(albumKey);
    if (!meta) return res.status(404).json({ error: 'Album not found' });
    const result = await getAlbumInfo(meta.artist, meta.album, albumKey, { force: req.query.refresh === '1' });
    res.json(result);
  } catch (err) {
    console.error('Last.fm album route error:', err);
    res.status(500).json({ configured: true, status: 'error', message: err.message });
  }
});

// ---------- Last.fm scrobbling (separate from, and optional on top of, the read-only Last.fm
// enrichment above — needs LASTFM_API_SECRET as well as LASTFM_API_KEY) ----------

// GET /api/lastfm/status — whether scrobbling is configured (both env vars set) and, if so,
// whether it's connected to an account yet.
router.get('/lastfm/status', (req, res) => {
  res.json(getScrobbleStatus());
});

// POST /api/lastfm/auth/start — step 1 of connecting: get a token + the last.fm URL to send
// the user to so they can approve it.
router.post('/lastfm/auth/start', async (req, res) => {
  try {
    const result = await startAuth();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/lastfm/auth/complete — step 2: after the user has approved the token on last.fm,
// exchange it for a permanent session key.
router.post('/lastfm/auth/complete', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const result = await completeAuth(token);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/lastfm/auth/disconnect
router.post('/lastfm/auth/disconnect', (req, res) => {
  disconnect();
  res.json({ ok: true });
});

// POST /api/lastfm/now-playing — { trackId }. Silently no-ops (never an error the frontend
// needs to handle) if scrobbling isn't configured/connected, since this rides along with every
// track play and must never get in the way of actually listening to it.
router.post('/lastfm/now-playing', async (req, res) => {
  const track = db.prepare(`SELECT title, artist, album FROM tracks WHERE id = ?`).get(req.body && req.body.trackId);
  if (!track || !track.title || !track.artist) return res.json({ ok: false, reason: 'missing_tags' });
  const result = await updateNowPlaying({ artist: track.artist, track: track.title, album: track.album });
  res.json(result);
});

// POST /api/lastfm/scrobble — { trackId, timestamp }. The client is what decides WHEN to call
// this (after Last.fm's own "played at least half the track, or 4 minutes, whichever is
// lower, and the track is over 30 seconds" rule) — this endpoint just submits it.
router.post('/lastfm/scrobble', async (req, res) => {
  const { trackId, timestamp } = req.body || {};
  const track = db.prepare(`SELECT title, artist, album FROM tracks WHERE id = ?`).get(trackId);
  if (!track || !track.title || !track.artist) return res.json({ ok: false, reason: 'missing_tags' });
  const result = await scrobble({ artist: track.artist, track: track.title, album: track.album, timestamp: timestamp || Math.floor(Date.now() / 1000) });
  res.json(result);
});

// GET /api/years — distinct years for filter dropdown
router.get('/years', (req, res) => {
  const rows = db
    .prepare(`SELECT DISTINCT year FROM tracks WHERE year IS NOT NULL ORDER BY year DESC`)
    .all();
  res.json({ years: rows.map((r) => r.year) });
});

// GET /api/genres — distinct genres for filter dropdown
router.get('/genres', (req, res) => {
  const rows = db
    .prepare(`SELECT DISTINCT genre FROM tracks WHERE genre IS NOT NULL AND genre != '' ORDER BY genre COLLATE NOCASE ASC`)
    .all();
  res.json({ genres: rows.map((r) => r.genre) });
});

// GET /api/cover/track/:id — embedded album cover art for a track
router.get('/cover/track/:id', (req, res) => {
  const track = db.prepare(`SELECT album_key FROM tracks WHERE id = ?`).get(req.params.id);
  if (!track || !track.album_key) return res.status(404).end();
  const cover = db.prepare(`SELECT mime, data FROM album_covers WHERE album_key = ?`).get(track.album_key);
  if (!cover) return res.status(404).end();
  res.set('Content-Type', cover.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(cover.data);
});

// GET /api/cover/album/:albumKey — embedded album cover art, looked up directly by album_key
// (used for the hover-preview thumbnail on the Artist Info tab, where we already have the
// album_key from /api/artists/:name and don't want to look up a representative track id).
router.get('/cover/album/:albumKey', (req, res) => {
  const cover = db.prepare(`SELECT mime, data FROM album_covers WHERE album_key = ?`).get(req.params.albumKey);
  if (!cover) return res.status(404).end();
  res.set('Content-Type', cover.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(cover.data);
});

// GET /api/artist-photo/:name — artist picture, served from the artist_photos DB table (see
// artistPhotos.js) rather than read from disk on every request.
router.get('/artist-photo/:name', (req, res) => {
  const photo = getArtistPhoto(req.params.name);
  if (!photo) return res.status(404).end();
  res.set('Content-Type', photo.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(photo.data);
});

// Shared by /api/stream/:id below — bumps the running play_count/last_played_at total on
// tracks (used for sorting/the Health-adjacent stats) and logs an individual event to
// play_history (used for the History tab's real, chronological log).
const bumpPlayCount = db.prepare(`UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?`);
const insertPlayHistory = db.prepare(`INSERT INTO play_history (track_id, played_at) VALUES (?, ?)`);
function recordPlay(trackId) {
  const now = Date.now();
  bumpPlayCount.run(now, trackId);
  insertPlayHistory.run(trackId, now);
}

// GET /api/stream/:id — stream the actual mp3 with Range support
router.get('/stream/:id', (req, res) => {
  const track = db.prepare(`SELECT filepath, filesize FROM tracks WHERE id = ?`).get(req.params.id);
  if (!track) return res.status(404).end();
  if (!fs.existsSync(track.filepath)) return res.status(404).json({ error: 'File missing on disk' });

  const stat = fs.statSync(track.filepath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
    if (Number.isNaN(start) || start >= fileSize) start = 0;
    if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;

    // A request starting at byte 0 is a real play (from-the-start, or the initial fetch before
    // any seeking) — a later range starting mid-file is just a seek, and shouldn't count again.
    if (start === 0) {
      recordPlay(req.params.id);
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'audio/mpeg',
    });
    fs.createReadStream(track.filepath, { start, end }).pipe(res);
  } else {
    recordPlay(req.params.id);
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(track.filepath).pipe(res);
  }
});

// POST /api/scan — trigger a rescan (runs in the background)
router.post('/scan', (req, res) => {
  const status = getScanStatus();
  if (status.status === 'running') {
    return res.json({ ok: true, message: 'Scan already running', status });
  }
  runScan().catch((err) => console.error('Background scan failed:', err));
  res.json({ ok: true, message: 'Scan started' });
});

// GET /api/scan/status — poll current scan progress
router.get('/scan/status', (req, res) => {
  res.json(getScanStatus());
});

// GET /api/history — paginated real play-history log (one row per playback start), most
// recent first, for the History tab. Distinct from tracks.last_played_at (most-recent-only per
// track): this is every individual play.
router.get('/history', (req, res) => {
  const { page = '1', pageSize = '50' } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));
  const offset = (pageNum - 1) * size;

  const totalRow = db.prepare(`SELECT COUNT(*) as n FROM play_history`).get();
  const rows = db
    .prepare(
      `SELECT h.id as history_id, h.played_at, t.id, t.title, t.artist, t.album, t.album_key, t.duration
       FROM play_history h JOIN tracks t ON t.id = h.track_id
       ORDER BY h.played_at DESC, h.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ limit: size, offset });

  res.json({ total: totalRow.n, page: pageNum, pageSize: size, items: rows });
});

// GET /api/history/recap — a small "listening recap" panel shown above the History tab's play
// log: how much you've listened to in the last 7 days, your top tracks/artists in that window,
// and anything you were playing on this same calendar day in a previous year. All computed from
// play_history, so it's only as far back as that table goes (see its comment in db.js).
router.get('/history/recap', (req, res) => {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const weekTotals = db
    .prepare(`SELECT COUNT(*) as plays, COUNT(DISTINCT track_id) as unique_tracks FROM play_history WHERE played_at >= ?`)
    .get(sevenDaysAgo);

  const topTracks = db
    .prepare(
      `SELECT t.id, t.title, t.artist, t.album, COUNT(*) as play_count
       FROM play_history h JOIN tracks t ON t.id = h.track_id
       WHERE h.played_at >= ?
       GROUP BY h.track_id ORDER BY play_count DESC, MAX(h.played_at) DESC LIMIT 5`
    )
    .all(sevenDaysAgo);

  const topArtists = db
    .prepare(
      `SELECT t.artist, COUNT(*) as play_count
       FROM play_history h JOIN tracks t ON t.id = h.track_id
       WHERE h.played_at >= ? AND t.artist IS NOT NULL AND t.artist != ''
       GROUP BY t.artist COLLATE NOCASE ORDER BY play_count DESC LIMIT 5`
    )
    .all(sevenDaysAgo);

  // "On this day": same month+day as today, any earlier year. SQLite's strftime works directly
  // on played_at once converted from ms to a unix-seconds timestamp.
  const onThisDayRows = db
    .prepare(
      `SELECT h.played_at, strftime('%Y', h.played_at / 1000, 'unixepoch') as play_year,
              t.id, t.title, t.artist, t.album, t.album_key
       FROM play_history h JOIN tracks t ON t.id = h.track_id
       WHERE strftime('%m-%d', h.played_at / 1000, 'unixepoch') = strftime('%m-%d', 'now')
         AND strftime('%Y', h.played_at / 1000, 'unixepoch') != strftime('%Y', 'now')
       ORDER BY h.played_at DESC LIMIT 100`
    )
    .all();

  // Group into { year, tracks: [...] } (deduped per track within a year), most recent year first.
  const byYear = new Map();
  for (const row of onThisDayRows) {
    if (!byYear.has(row.play_year)) byYear.set(row.play_year, new Map());
    byYear.get(row.play_year).set(row.id, row); // last write per track id wins (fine, same track)
  }
  const onThisDay = [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, tracksById]) => ({
      year: parseInt(year, 10),
      tracks: [...tracksById.values()].slice(0, 8).map(({ play_year, ...t }) => t),
    }));

  res.json({
    week: { plays: weekTotals.plays, unique_tracks: weekTotals.unique_tracks, top_tracks: topTracks, top_artists: topArtists },
    on_this_day: onThisDay,
  });
});

// GET /api/backup — downloads a consistent snapshot of the SQLite database. Uses the SQLite
// Online Backup API (db.backup()) rather than copying library.db directly, since WAL mode
// keeps recent writes in a separate -wal file that a plain file copy could miss.
router.get('/backup', async (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmpPath = path.join(os.tmpdir(), `mp3-library-backup-${stamp}-${process.pid}.db`);
  try {
    await db.backup(tmpPath);
    res.download(tmpPath, `mp3-library-backup-${stamp}.db`, (err) => {
      fs.unlink(tmpPath, () => {});
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Backup download failed' });
      }
    });
  } catch (err) {
    console.error('Backup error:', err);
    fs.unlink(tmpPath, () => {});
    if (!res.headersSent) res.status(500).json({ error: 'Backup failed' });
  }
});

// GET /api/stats — quick library summary for the home view (About modal) and the Stats tab
router.get('/stats', (req, res) => {
  const totals = db
    .prepare(
      `SELECT COUNT(*) as tracks,
              COUNT(DISTINCT artist) as artists,
              COUNT(DISTINCT album) as albums,
              COALESCE(SUM(duration), 0) as total_duration,
              COALESCE(SUM(filesize), 0) as total_size,
              COALESCE(AVG(NULLIF(bitrate, 0)), 0) as avg_bitrate,
              COALESCE(AVG(NULLIF(duration, 0)), 0) as avg_duration,
              COALESCE(SUM(duration * play_count), 0) as total_listened,
              COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) as favorites_count,
              COALESCE(SUM(CASE WHEN play_count IS NULL OR play_count = 0 THEN 1 ELSE 0 END), 0) as unplayed_count
       FROM tracks`
    )
    .get();

  const by_decade = db
    .prepare(
      `SELECT (CAST(year AS INTEGER) / 10) * 10 as decade, COUNT(*) as count
       FROM tracks
       WHERE year IS NOT NULL AND year > 0
       GROUP BY decade
       ORDER BY decade ASC`
    )
    .all();

  const by_year = db
    .prepare(
      `SELECT year, COUNT(*) as count
       FROM tracks
       WHERE year IS NOT NULL AND year > 0
       GROUP BY year
       ORDER BY year ASC`
    )
    .all();

  const top_genres = db
    .prepare(
      `SELECT genre, COUNT(*) as count
       FROM tracks
       WHERE genre IS NOT NULL AND genre != ''
       GROUP BY genre
       ORDER BY count DESC
       LIMIT 10`
    )
    .all();

  const top_genres_by_size = db
    .prepare(
      `SELECT genre, COALESCE(SUM(filesize), 0) as size
       FROM tracks
       WHERE genre IS NOT NULL AND genre != ''
       GROUP BY genre
       ORDER BY size DESC
       LIMIT 10`
    )
    .all();

  const top_artists = db
    .prepare(
      `SELECT artist, COUNT(*) as count
       FROM tracks
       WHERE artist IS NOT NULL AND artist != ''
       GROUP BY artist
       ORDER BY count DESC
       LIMIT 10`
    )
    .all();

  const top_artists_by_albums = db
    .prepare(
      `SELECT artist, COUNT(DISTINCT album) as count
       FROM tracks
       WHERE artist IS NOT NULL AND artist != '' AND album IS NOT NULL AND album != ''
       GROUP BY artist
       ORDER BY count DESC
       LIMIT 10`
    )
    .all();

  const top_artists_by_size = db
    .prepare(
      `SELECT artist, COALESCE(SUM(filesize), 0) as size
       FROM tracks
       WHERE artist IS NOT NULL AND artist != ''
       GROUP BY artist
       ORDER BY size DESC
       LIMIT 10`
    )
    .all();

  const top_albums = db
    .prepare(
      `SELECT album, album_key, artist, COUNT(*) as count
       FROM tracks
       WHERE album IS NOT NULL AND album != '' AND album_key IS NOT NULL
       GROUP BY album_key
       ORDER BY count DESC
       LIMIT 10`
    )
    .all();

  const most_played = db
    .prepare(
      `SELECT id, title, artist, play_count
       FROM tracks
       WHERE play_count IS NOT NULL AND play_count > 0
       ORDER BY play_count DESC, title COLLATE NOCASE ASC
       LIMIT 10`
    )
    .all();

  const favorites_by_genre = db
    .prepare(
      `SELECT genre, COUNT(*) as count
       FROM tracks
       WHERE favorite = 1 AND genre IS NOT NULL AND genre != ''
       GROUP BY genre
       ORDER BY count DESC
       LIMIT 5`
    )
    .all();

  const largest_track = db
    .prepare(`SELECT id, title, artist, filesize FROM tracks WHERE filesize IS NOT NULL AND filesize > 0 ORDER BY filesize DESC LIMIT 1`)
    .get();

  const smallest_track = db
    .prepare(`SELECT id, title, artist, filesize FROM tracks WHERE filesize IS NOT NULL AND filesize > 0 ORDER BY filesize ASC LIMIT 1`)
    .get();

  res.json({
    ...totals,
    // format.bitrate from music-metadata (and this column) is stored in bits/sec — convert to kbps for display
    avg_bitrate: Math.round((totals.avg_bitrate || 0) / 1000),
    avg_tracks_per_album: totals.albums ? totals.tracks / totals.albums : 0,
    by_decade,
    by_year,
    top_genres,
    top_genres_by_size,
    top_artists,
    top_artists_by_albums,
    top_artists_by_size,
    top_albums,
    most_played,
    favorites_by_genre,
    largest_track: largest_track || null,
    smallest_track: smallest_track || null,
  });
});

// ---------- Library health ----------

const HEALTH_ISSUE_TYPES = {
  missing_title: `t.title_missing = 1`,
  missing_artist: `t.artist IS NULL`,
  missing_album: `t.album IS NULL`,
  missing_year: `t.year IS NULL`,
  missing_genre: `(t.genre IS NULL OR t.genre = '')`,
  no_cover: `(t.album_key IS NULL OR t.album_key NOT IN (SELECT album_key FROM album_covers))`,
};

// A "possible duplicate" is two or more tracks sharing the same artist + title, compared
// case-insensitively and trimmed — deliberately simple (no fuzzy matching, no filesize/duration
// comparison) so it stays easy to reason about, at the cost of missing duplicates whose tags
// differ slightly (a stray space, a "(Remastered)" suffix on only one copy) and of occasionally
// flagging genuinely different recordings that happen to share a title (a live version, a cover).
const DUPLICATE_GROUPS_SQL = `
  SELECT LOWER(TRIM(artist)) as artist_key, LOWER(TRIM(title)) as title_key, COUNT(*) as n
  FROM tracks
  WHERE artist IS NOT NULL AND TRIM(artist) != '' AND title IS NOT NULL AND TRIM(title) != ''
  GROUP BY artist_key, title_key
  HAVING COUNT(*) > 1
`;

// GET /api/health/summary — counts for the health dashboard
router.get('/health/summary', (req, res) => {
  const totalTracks = db.prepare(`SELECT COUNT(*) as n FROM tracks`).get().n;

  const counts = {};
  for (const [type, clause] of Object.entries(HEALTH_ISSUE_TYPES)) {
    counts[type] = db.prepare(`SELECT COUNT(*) as n FROM tracks t WHERE ${clause}`).get().n;
  }

  const scanErrorCount = db.prepare(`SELECT COUNT(*) as n FROM scan_errors`).get().n;
  const duplicateTrackCount = db
    .prepare(DUPLICATE_GROUPS_SQL)
    .all()
    .reduce((sum, g) => sum + g.n, 0);

  const artistRows = db
    .prepare(`SELECT DISTINCT artist FROM tracks WHERE artist IS NOT NULL AND artist != ''`)
    .all();
  const artistsWithoutPhoto = artistRows.filter((r) => !hasArtistPhoto(r.artist)).length;

  const scanStatus = getScanStatus();

  res.json({
    total_tracks: totalTracks,
    issues: { ...counts, scan_error: scanErrorCount, duplicates: duplicateTrackCount },
    artists_total: artistRows.length,
    artists_without_photo: artistsWithoutPhoto,
    last_scan: {
      status: scanStatus.status,
      started_at: scanStatus.started_at,
      finished_at: scanStatus.finished_at,
      files_found: scanStatus.files_found,
      files_processed: scanStatus.files_processed,
      errors: scanStatus.errors,
    },
  });
});

// GET /api/health/artist-photo-diagnostics — resolved ARTIST_PICTURES_DIR path, whether it's
// readable, and the folder names actually found there. Meant to answer "why aren't my artist
// pictures showing up?" without shell access: folderCount 0 means the mount/path is wrong;
// folders present but not matching artist names means it's a naming mismatch.
router.get('/health/artist-photo-diagnostics', (req, res) => {
  res.json(getArtistPhotoDiagnostics());
});

// GET /api/health/issues?type=...&page=&pageSize= — paginated details for one issue type
router.get('/health/issues', (req, res) => {
  const { type, page = '1', pageSize = '50' } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));
  const offset = (pageNum - 1) * size;

  if (type === 'scan_error') {
    const total = db.prepare(`SELECT COUNT(*) as n FROM scan_errors`).get().n;
    const rows = db
      .prepare(`SELECT id, filepath, message, occurred_at FROM scan_errors ORDER BY occurred_at DESC LIMIT ? OFFSET ?`)
      .all(size, offset);
    return res.json({ total, page: pageNum, pageSize: size, items: rows });
  }

  if (type === 'no_artist_photo') {
    const artistRows = db
      .prepare(`SELECT DISTINCT artist FROM tracks WHERE artist IS NOT NULL AND artist != '' ORDER BY artist COLLATE NOCASE ASC`)
      .all();
    const missing = artistRows
      .filter((r) => !hasArtistPhoto(r.artist))
      .map((r) => ({ artist: r.artist, normalized: normalizeArtistName(r.artist) }));
    const total = missing.length;
    const items = missing.slice(offset, offset + size);
    return res.json({ total, page: pageNum, pageSize: size, items });
  }

  // Paginates over duplicate GROUPS (not individual tracks) — each item is one artist+title
  // group along with every track filed under it, so the UI can show them side by side for
  // comparison rather than as one long flat list.
  if (type === 'duplicates') {
    const groups = db.prepare(`${DUPLICATE_GROUPS_SQL} ORDER BY n DESC, artist_key ASC, title_key ASC`).all();
    const total = groups.length;
    const pageGroups = groups.slice(offset, offset + size);
    const getGroupTracks = db.prepare(
      `SELECT id, title, artist, album, year, genre, duration, filepath, filesize
       FROM tracks
       WHERE LOWER(TRIM(artist)) = @artist_key AND LOWER(TRIM(title)) = @title_key
       ORDER BY filepath COLLATE NOCASE ASC`
    );
    const items = pageGroups.map((g) => {
      const tracks = getGroupTracks.all(g);
      return { artist: tracks[0].artist, title: tracks[0].title, tracks };
    });
    return res.json({ total, page: pageNum, pageSize: size, items });
  }

  const clause = HEALTH_ISSUE_TYPES[type];
  if (!clause) return res.status(400).json({ error: 'Unknown issue type' });

  const total = db.prepare(`SELECT COUNT(*) as n FROM tracks t WHERE ${clause}`).get().n;
  const rows = db
    .prepare(
      `SELECT t.id, t.filepath, t.filename, t.title, t.artist, t.album, t.year, t.genre
       FROM tracks t WHERE ${clause}
       ORDER BY t.filepath COLLATE NOCASE ASC
       LIMIT ? OFFSET ?`
    )
    .all(size, offset);
  res.json({ total, page: pageNum, pageSize: size, items: rows });
});

// ---------- Playlists ----------

const nowMs = () => Date.now();

// A smart playlist stores a filter set (the same shape as GET /api/tracks) instead of a fixed
// track list — its contents are re-computed live every time it's opened, so it stays current as
// the library changes (new files matching it, tags edited, etc).
function parseSmartQuery(playlist) {
  try {
    return JSON.parse(playlist.smart_query || '{}');
  } catch {
    return {};
  }
}

function smartPlaylistAgg(filters) {
  const { fromClause, whereClause, params } = trackFilterClause(filters);
  const randomCount = filters && filters.randomCount;
  if (randomCount) {
    // Count/duration have to reflect the same randomly-picked subset the track list will show,
    // not every eligible track — otherwise the playlist card would show a bigger count/duration
    // than the (randomly capped) list you actually get when you open it.
    return db
      .prepare(
        `SELECT COUNT(*) as track_count, COALESCE(SUM(duration), 0) as total_duration FROM (
           SELECT t.duration as duration FROM ${fromClause} ${whereClause} ORDER BY RANDOM() LIMIT @randomCount
         )`
      )
      .get({ ...params, randomCount });
  }
  return db.prepare(`SELECT COUNT(*) as track_count, COALESCE(SUM(t.duration), 0) as total_duration FROM ${fromClause} ${whereClause}`).get(params);
}

function smartPlaylistTracks(filters) {
  const { fromClause, whereClause, params } = trackFilterClause(filters);
  const randomCount = filters && filters.randomCount;
  // A plain smart playlist always lists every matching track in a stable order. One with
  // randomCount set instead picks that many tracks at RANDOM from the matching set — and since
  // this runs fresh every time the playlist is opened, it's a different random pick each time,
  // not a fixed subset saved once.
  const orderClause = randomCount
    ? 'ORDER BY RANDOM() LIMIT @randomCount'
    : 'ORDER BY t.artist COLLATE NOCASE ASC, t.disc_no ASC, t.track_no ASC';
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.artist, t.album, t.year, t.track_no, t.duration, t.album_key, t.filepath
       FROM ${fromClause} ${whereClause}
       ${orderClause}`
    )
    .all(randomCount ? { ...params, randomCount } : params);
  // Smart playlist entries aren't real playlist_tracks rows (nothing to reorder/remove), but the
  // frontend expects the same shape as a regular playlist's track list.
  return rows.map((t, i) => ({ ...t, playlist_track_id: null, position: i }));
}

// GET /api/playlists — all playlists with track counts + total duration
router.get('/playlists', (req, res) => {
  const playlists = db.prepare(`SELECT * FROM playlists ORDER BY updated_at DESC`).all();
  const result = playlists.map((p) => {
    if (p.is_smart) {
      const agg = smartPlaylistAgg(parseSmartQuery(p));
      return { id: p.id, name: p.name, created_at: p.created_at, updated_at: p.updated_at, is_smart: true, ...agg };
    }
    const agg = db
      .prepare(
        `SELECT COUNT(pt.id) as track_count, COALESCE(SUM(t.duration), 0) as total_duration
         FROM playlist_tracks pt LEFT JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?`
      )
      .get(p.id);
    return { id: p.id, name: p.name, created_at: p.created_at, updated_at: p.updated_at, is_smart: false, ...agg };
  });
  res.json({ playlists: result });
});

// POST /api/playlists — create a new playlist { name }
router.post('/playlists', (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  if (!name) return res.status(400).json({ error: 'A playlist name is required' });
  const ts = nowMs();
  const result = db
    .prepare(`INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)`)
    .run(name, ts, ts);
  res.json({ id: result.lastInsertRowid, name, created_at: ts, updated_at: ts, track_count: 0 });
});

// Normalizes a raw { q, artist, album, year, genre, favorite, decade, randomCount } payload
// into the shape stored in smart_query, shared by the single and bulk smart-playlist creation
// routes. randomCount (optional) caps the playlist to that many RANDOM tracks from the
// matching set, re-rolled fresh every time the playlist is opened (see smartPlaylistTracks) —
// everything else here still narrows down WHICH tracks are eligible to be picked.
function normalizeSmartFilters(f) {
  f = f || {};
  const randomCount = parseInt(f.randomCount, 10);
  return {
    q: f.q ? String(f.q) : '',
    artist: f.artist ? String(f.artist) : '',
    album: f.album ? String(f.album) : '',
    year: f.year ? String(f.year) : '',
    genre: f.genre ? String(f.genre) : '',
    favorite: !!f.favorite,
    decade: f.decade !== undefined && f.decade !== null && f.decade !== '' ? parseInt(f.decade, 10) : null,
    randomCount: Number.isFinite(randomCount) && randomCount > 0 ? randomCount : null,
  };
}

// POST /api/playlists/smart — create a smart (auto-updating) playlist from a filter set:
// { name, filters: { q, artist, album, year, genre, favorite, decade } } — the same fields the
// Tracks tab already filters on. Also used by the Playlists tab's Artist/Genre/Year/Decade
// generator buttons, which populate filters from a value the user picked from a dropdown of
// what's actually in the library. Its contents are computed live, never stored as fixed tracks.
router.post('/playlists/smart', (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  if (!name) return res.status(400).json({ error: 'A playlist name is required' });

  const filters = normalizeSmartFilters(req.body && req.body.filters);

  const ts = nowMs();
  const result = db
    .prepare(`INSERT INTO playlists (name, created_at, updated_at, is_smart, smart_query) VALUES (?, ?, ?, 1, ?)`)
    .run(name, ts, ts, JSON.stringify(filters));

  const agg = smartPlaylistAgg(filters);
  res.json({ id: result.lastInsertRowid, name, created_at: ts, updated_at: ts, is_smart: true, filters, ...agg });
});

// POST /api/playlists/fixed/bulk — create one *regular* (non-smart) playlist per item, e.g.
// "one per decade/year/genre/artist" from the Playlists tab's generator buttons, restoring the
// original bulk-generate-all behavior but as playlists that don't change afterward: each one's
// matching tracks are captured into playlist_tracks right now, at creation time, so it stays
// exactly as generated even as the library changes later (unlike a smart playlist, which is a
// live, ever-changing view over the same filters).
// Body: { items: [{ name, filters }, ...] } — an item whose name exactly matches an existing
// playlist (of any kind) is skipped rather than overwritten or duplicated.
router.post('/playlists/fixed/bulk', (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'items must be a non-empty array' });

  const existingNames = new Set(db.prepare(`SELECT name FROM playlists`).all().map((p) => p.name));
  const ts = nowMs();
  const insertPlaylist = db.prepare(`INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)`);
  const insertTrack = db.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`);

  let created = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const item of items) {
      const name = (item && item.name ? String(item.name) : '').trim();
      if (!name || existingNames.has(name)) {
        skipped++;
        continue;
      }
      const filters = normalizeSmartFilters(item.filters);
      const tracks = smartPlaylistTracks(filters);
      const playlistResult = insertPlaylist.run(name, ts, ts);
      tracks.forEach((t, i) => insertTrack.run(playlistResult.lastInsertRowid, t.id, i));
      existingNames.add(name);
      created++;
    }
  });
  run();

  res.json({ created, skipped, total: items.length });
});

// POST /api/playlists/import — create a playlist from an uploaded .m3u/.m3u8 file's contents.
// Body: { name, content } — content is the raw text of the file (read client-side, since an
// imported playlist rarely came from this container: paths from another player, or a Windows
// path, won't match tracks.filepath byte-for-byte). Tracks are matched by exact filepath first
// (works for a playlist this app itself exported), falling back to matching by filename alone.
router.post('/playlists/import', (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  const content = (req.body && typeof req.body.content === 'string') ? req.body.content : '';
  if (!name) return res.status(400).json({ error: 'A playlist name is required' });
  if (!content.trim()) return res.status(400).json({ error: 'That file appears to be empty' });

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.replace(/^﻿/, '').trim())
    .filter((l) => l && !l.startsWith('#'));

  if (!lines.length) return res.status(400).json({ error: 'No track entries found in that file' });

  const allTracks = db.prepare(`SELECT id, filepath FROM tracks`).all();
  const byExactPath = new Map();
  const byFilename = new Map(); // lowercase basename -> [track ids]
  for (const t of allTracks) {
    byExactPath.set(t.filepath, t.id);
    const base = t.filepath.split(/[\\/]/).pop().toLowerCase();
    if (!byFilename.has(base)) byFilename.set(base, []);
    byFilename.get(base).push(t.id);
  }

  let matched = 0;
  let ambiguous = 0;
  let skipped = 0;
  const matchedIds = [];

  for (const line of lines) {
    const normalized = line.replace(/\\/g, '/');
    const exactId = byExactPath.get(line) ?? byExactPath.get(normalized);
    if (exactId != null) {
      matchedIds.push(exactId);
      matched++;
      continue;
    }
    const base = normalized.split('/').pop().toLowerCase();
    const candidates = byFilename.get(base);
    if (candidates && candidates.length === 1) {
      matchedIds.push(candidates[0]);
      matched++;
    } else if (candidates && candidates.length > 1) {
      matchedIds.push(candidates[0]); // best-effort — several tracks share this filename
      matched++;
      ambiguous++;
    } else {
      skipped++;
    }
  }

  const ts = nowMs();
  const playlist = db.prepare(`INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)`).run(name, ts, ts);
  const playlistId = playlist.lastInsertRowid;

  const insertTrack = db.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`);
  const insertAll = db.transaction((ids) => {
    ids.forEach((trackId, index) => insertTrack.run(playlistId, trackId, index));
  });
  insertAll(matchedIds);

  res.json({ id: playlistId, name, total_lines: lines.length, matched, ambiguous, skipped });
});

// GET /api/playlists/:id — ordered tracks in a playlist
router.get('/playlists/:id', (req, res) => {
  const playlist = db.prepare(`SELECT * FROM playlists WHERE id = ?`).get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  if (playlist.is_smart) {
    const filters = parseSmartQuery(playlist);
    return res.json({ ...playlist, is_smart: true, filters, tracks: smartPlaylistTracks(filters) });
  }

  const tracks = db
    .prepare(
      `SELECT pt.id as playlist_track_id, pt.position, t.id, t.title, t.artist, t.album, t.year,
              t.track_no, t.duration, t.album_key
       FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       WHERE pt.playlist_id = ?
       ORDER BY pt.position ASC`
    )
    .all(req.params.id);

  res.json({ ...playlist, is_smart: false, tracks });
});

// PATCH /api/playlists/:id — rename { name }
router.patch('/playlists/:id', (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  if (!name) return res.status(400).json({ error: 'A playlist name is required' });
  const result = db
    .prepare(`UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?`)
    .run(name, nowMs(), req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ ok: true });
});

// DELETE /api/playlists/:id
router.delete('/playlists/:id', (req, res) => {
  const result = db.prepare(`DELETE FROM playlists WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ ok: true });
});

function requireEditablePlaylist(req, res) {
  const playlist = db.prepare(`SELECT id, is_smart FROM playlists WHERE id = ?`).get(req.params.id);
  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found' });
    return null;
  }
  if (playlist.is_smart) {
    res.status(400).json({ error: "Smart playlists update automatically from their saved filters and can't be edited by hand" });
    return null;
  }
  return playlist;
}

// POST /api/playlists/:id/tracks — append a track { track_id }
router.post('/playlists/:id/tracks', (req, res) => {
  if (!requireEditablePlaylist(req, res)) return;

  const trackId = req.body && req.body.track_id;
  const track = db.prepare(`SELECT id FROM tracks WHERE id = ?`).get(trackId);
  if (!track) return res.status(400).json({ error: 'Track not found' });

  const maxPos = db
    .prepare(`SELECT COALESCE(MAX(position), -1) as maxPos FROM playlist_tracks WHERE playlist_id = ?`)
    .get(req.params.id).maxPos;

  const result = db
    .prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`)
    .run(req.params.id, trackId, maxPos + 1);

  db.prepare(`UPDATE playlists SET updated_at = ? WHERE id = ?`).run(nowMs(), req.params.id);

  res.json({ ok: true, playlist_track_id: result.lastInsertRowid });
});

// POST /api/playlists/:id/tracks/bulk — append several tracks at once { track_ids: [...] },
// for the Tracks tab's multi-select "add to playlist" action.
router.post('/playlists/:id/tracks/bulk', (req, res) => {
  if (!requireEditablePlaylist(req, res)) return;

  const ids = Array.isArray(req.body && req.body.track_ids)
    ? req.body.track_ids.map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n))
    : [];
  if (!ids.length) return res.status(400).json({ error: 'track_ids must be a non-empty array' });

  const trackExists = db.prepare(`SELECT 1 FROM tracks WHERE id = ?`);
  const validIds = ids.filter((id) => trackExists.get(id));

  const maxPos = db
    .prepare(`SELECT COALESCE(MAX(position), -1) as maxPos FROM playlist_tracks WHERE playlist_id = ?`)
    .get(req.params.id).maxPos;

  const insertTrack = db.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`);
  const insertAll = db.transaction((trackIds) => {
    trackIds.forEach((trackId, i) => insertTrack.run(req.params.id, trackId, maxPos + 1 + i));
  });
  insertAll(validIds);

  db.prepare(`UPDATE playlists SET updated_at = ? WHERE id = ?`).run(nowMs(), req.params.id);
  res.json({ ok: true, added: validIds.length });
});

// DELETE /api/playlists/:id/tracks/:playlistTrackId — remove one entry
router.delete('/playlists/:id/tracks/:playlistTrackId', (req, res) => {
  if (!requireEditablePlaylist(req, res)) return;
  const result = db
    .prepare(`DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?`)
    .run(req.params.playlistTrackId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Playlist entry not found' });
  db.prepare(`UPDATE playlists SET updated_at = ? WHERE id = ?`).run(nowMs(), req.params.id);
  res.json({ ok: true });
});

// PUT /api/playlists/:id/reorder — { order: [playlist_track_id, ...] } in the new order
router.put('/playlists/:id/reorder', (req, res) => {
  if (!requireEditablePlaylist(req, res)) return;
  const order = (req.body && req.body.order) || [];
  if (!Array.isArray(order) || !order.length) {
    return res.status(400).json({ error: 'order must be a non-empty array of playlist_track_id values' });
  }

  const update = db.prepare(`UPDATE playlist_tracks SET position = ? WHERE id = ? AND playlist_id = ?`);
  const applyReorder = db.transaction((ids) => {
    ids.forEach((playlistTrackId, index) => {
      update.run(index, playlistTrackId, req.params.id);
    });
  });
  applyReorder(order);

  db.prepare(`UPDATE playlists SET updated_at = ? WHERE id = ?`).run(nowMs(), req.params.id);
  res.json({ ok: true });
});

// GET /api/playlists/:id/export.m3u8 — download as an M3U8 playlist file
router.get('/playlists/:id/export.m3u8', (req, res) => {
  const playlist = db.prepare(`SELECT * FROM playlists WHERE id = ?`).get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const tracks = playlist.is_smart
    ? smartPlaylistTracks(parseSmartQuery(playlist))
    : db
        .prepare(
          `SELECT t.filepath, t.title, t.artist, t.duration
           FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
           WHERE pt.playlist_id = ? ORDER BY pt.position ASC`
        )
        .all(req.params.id);

  const lines = ['#EXTM3U'];
  for (const t of tracks) {
    const label = [t.artist, t.title].filter(Boolean).join(' - ') || t.filepath;
    lines.push(`#EXTINF:${Math.round(t.duration || 0)},${label}`);
    lines.push(t.filepath);
  }

  const safeName = playlist.name.replace(/[^a-z0-9 _-]/gi, '').trim() || 'playlist';
  res.set('Content-Type', 'audio/x-mpegurl');
  res.set('Content-Disposition', `attachment; filename="${safeName}.m3u8"`);
  res.send(lines.join('\n') + '\n');
});

module.exports = router;
