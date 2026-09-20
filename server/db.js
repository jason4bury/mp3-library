const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'library.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filepath TEXT UNIQUE NOT NULL,
  filename TEXT,
  title TEXT,
  artist TEXT,
  album_artist TEXT,
  album TEXT,
  year INTEGER,
  genre TEXT,
  track_no INTEGER,
  disc_no INTEGER,
  duration REAL,
  bitrate INTEGER,
  filesize INTEGER,
  album_key TEXT,
  title_missing INTEGER DEFAULT 0,
  mtime INTEGER,
  last_scanned INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
CREATE INDEX IF NOT EXISTS idx_tracks_year ON tracks(year);
CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
CREATE INDEX IF NOT EXISTS idx_tracks_album_key ON tracks(album_key);

CREATE TABLE IF NOT EXISTS album_covers (
  album_key TEXT PRIMARY KEY,
  mime TEXT,
  data BLOB,
  source_track_id INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title, artist, album, album_artist, genre, content='tracks', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
  VALUES (new.id, new.title, new.artist, new.album, new.album_artist, new.genre);
END;

CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
  VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, old.genre);
END;

CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
  VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, old.genre);
  INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
  VALUES (new.id, new.title, new.artist, new.album, new.album_artist, new.genre);
END;

CREATE TABLE IF NOT EXISTS scan_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT DEFAULT 'idle',
  started_at INTEGER,
  finished_at INTEGER,
  files_found INTEGER DEFAULT 0,
  files_processed INTEGER DEFAULT 0,
  files_added INTEGER DEFAULT 0,
  files_updated INTEGER DEFAULT 0,
  files_removed INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  last_error TEXT
);
INSERT OR IGNORE INTO scan_status (id, status) VALUES (1, 'idle');

-- One row per file that failed to scan on the most recent scan run.
CREATE TABLE IF NOT EXISTS scan_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filepath TEXT,
  message TEXT,
  occurred_at INTEGER
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id),
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  position INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);

-- Keep playlists clean when a track is removed from the library, or a playlist is deleted.
CREATE TRIGGER IF NOT EXISTS tracks_ad_playlist_cleanup AFTER DELETE ON tracks BEGIN
  DELETE FROM playlist_tracks WHERE track_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS playlists_ad_cleanup AFTER DELETE ON playlists BEGIN
  DELETE FROM playlist_tracks WHERE playlist_id = old.id;
END;

-- One row per play (each time playback actually starts from the beginning — see
-- recordPlay() in routes/api.js), for the History tab's real, chronological play log. This is
-- separate from tracks.play_count/last_played_at (a running total + most-recent-only per
-- track): play_history keeps every individual play event.
CREATE TABLE IF NOT EXISTS play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  played_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_history_track ON play_history(track_id);

CREATE TRIGGER IF NOT EXISTS tracks_ad_history_cleanup AFTER DELETE ON tracks BEGIN
  DELETE FROM play_history WHERE track_id = old.id;
END;

-- Cached Last.fm artist lookups (bio/tags/similar artists), keyed by lowercased artist name.
CREATE TABLE IF NOT EXISTS lastfm_cache (
  artist_key TEXT PRIMARY KEY,
  artist_name TEXT,
  status TEXT,
  data TEXT,
  fetched_at INTEGER
);

-- Cached Last.fm album lookups (wiki/tags/listener stats), keyed by the same album_key used
-- for cover art (tracks.album_key: "<artist>::<album>", lowercased).
CREATE TABLE IF NOT EXISTS lastfm_album_cache (
  album_key TEXT PRIMARY KEY,
  artist_name TEXT,
  album_name TEXT,
  status TEXT,
  data TEXT,
  fetched_at INTEGER
);

-- Express session storage — backs the app's login sessions with this same SQLite file instead
-- of express-session's default in-memory store, which leaks memory over time and (more to the
-- point for a single-container hobby app) forgets every logged-in session on a restart. See
-- sqliteSessionStore.js for the Store implementation; expires is a unix-ms timestamp, indexed
-- so pruning expired rows stays cheap even if this table isn't emptied often.
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  expires INTEGER,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

-- A single row holding the signed-in Last.fm account's session key (for scrobbling), once
-- connected via the Settings modal's "Connect Last.fm" flow. No row = not connected. The
-- session key doesn't expire on Last.fm's side, so this persists until the user disconnects.
CREATE TABLE IF NOT EXISTS lastfm_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_key TEXT,
  username TEXT,
  connected_at INTEGER
);

-- A single row holding the current set of artist photos shown as the login page's tiled
-- background mosaic. Regenerated only when a library rescan finishes (see
-- loginBackground.js + the runScan() hook in scanner.js) — never on a plain page load —
-- so the background stays put between rescans instead of shuffling on every visit. Stores
-- artist_photos.artist_key values (see below), not filepaths.
CREATE TABLE IF NOT EXISTS login_background (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  images TEXT,
  generated_at INTEGER
);

-- Artist photos imported from ARTIST_PICTURES_DIR, keyed by the same normalized name used to
-- match a track's artist tag to a photo folder (see artistPhotos.js's normalize()). Populated
-- once at server startup and again at the end of every rescan — see
-- importArtistPhotosToDb() — rather than read from disk per request, the same BLOB-in-SQLite
-- pattern already used for embedded album cover art (album_covers above). This is what lets the
-- Artists tab, an artist's own page, the Album page, the Health tab, and the actual image route
-- all serve photos as a plain indexed DB read instead of a live filesystem read every time.
CREATE TABLE IF NOT EXISTS artist_photos (
  artist_key TEXT PRIMARY KEY,
  real_name TEXT,
  mime TEXT,
  data BLOB,
  source_mtime INTEGER,
  imported_at INTEGER
);
`);

// --- Migrations for columns added after the initial release ---
// (CREATE TABLE IF NOT EXISTS above doesn't add new columns to a table that
// already exists on disk, so an existing library.db needs an explicit ALTER.)
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('tracks', 'title_missing', 'INTEGER DEFAULT 0');
ensureColumn('tracks', 'favorite', 'INTEGER DEFAULT 0');
ensureColumn('tracks', 'play_count', 'INTEGER DEFAULT 0');
ensureColumn('tracks', 'last_played_at', 'INTEGER');
// Set only when a track is first inserted (see scanner.js's upsertTrack — it's deliberately left
// out of the ON CONFLICT DO UPDATE clause so a rescan never touches it), so it reflects when the
// app first saw the file rather than a metadata-tag "date". Existing rows from before this
// column existed stay NULL — there's no way to know when they were really added — and only show
// up in "recently added" once a full flow's gone through: NULL sorts them last either way.
ensureColumn('tracks', 'added_at', 'INTEGER');
ensureColumn('playlists', 'is_smart', 'INTEGER DEFAULT 0');
ensureColumn('playlists', 'smart_query', 'TEXT');

module.exports = db;
