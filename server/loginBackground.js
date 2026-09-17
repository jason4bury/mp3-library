const db = require('./db');
const { getArtistPhotoByKey } = require('./artistPhotos');

// How many distinct pictures to pull into the pool each time the background refreshes — split
// between curated artist photos (artist_photos) and embedded album cover art (album_covers), so
// a library with plenty of one but little of the other still ends up with a well-populated,
// varied mosaic. The mosaic itself (see loginPage.js) repeats/shuffles this pool out to as many
// tiles as the grid needs, so this doesn't need to match the tile count exactly.
const MAX_IMAGES = 40;

const getRow = db.prepare(`SELECT images, generated_at FROM login_background WHERE id = 1`);
const upsertRow = db.prepare(`
  INSERT INTO login_background (id, images, generated_at) VALUES (1, @images, @generated_at)
  ON CONFLICT(id) DO UPDATE SET images = excluded.images, generated_at = excluded.generated_at
`);

// Picks straight out of artist_photos/album_covers (already-imported DB tables) rather than the
// filesystem — this is a random SELECT, not a disk walk.
const randomArtistKeys = db.prepare(`SELECT artist_key AS key FROM artist_photos ORDER BY RANDOM() LIMIT ?`);
const randomAlbumKeys = db.prepare(`SELECT album_key AS key FROM album_covers ORDER BY RANDOM() LIMIT ?`);
// Album covers have no dedicated lookup-by-key helper elsewhere (unlike artist photos, reused
// from artistPhotos.js below), so prepare one here.
const getAlbumImageStmt = db.prepare(`SELECT mime, data FROM album_covers WHERE album_key = ?`);

// Picks a fresh random mix of artist photos + album covers and persists it — this is the ONLY
// place the login background changes. Called from scanner.js once a rescan finishes successfully
// (and once at server startup — see index.js), so ordinary page loads/login attempts always see
// whatever was last picked, not a fresh shuffle every time someone hits the login page. Also
// self-migrates an older, artist-photo-only pool (a plain array of key strings) to the new
// {type, key} shape automatically, since this always overwrites the persisted row.
function regenerateLoginBackground() {
  const artistQuota = Math.ceil(MAX_IMAGES / 2);
  let artists = randomArtistKeys.all(artistQuota).map((r) => ({ type: 'artist', key: r.key }));
  let albums = randomAlbumKeys.all(MAX_IMAGES - artists.length).map((r) => ({ type: 'album', key: r.key }));
  if (artists.length + albums.length < MAX_IMAGES) {
    // One side came up short of its quota (few/no curated artist photos, or no scanned albums
    // with embedded art yet) — let the other side fill the rest of the pool instead of settling
    // for fewer total pictures than are actually available.
    artists = randomArtistKeys.all(MAX_IMAGES - albums.length).map((r) => ({ type: 'artist', key: r.key }));
  }
  const pool = artists.concat(albums);
  upsertRow.run({ images: JSON.stringify(pool), generated_at: Date.now() });
  return pool.length;
}

// Returns the currently-persisted pool as [{type: 'artist'|'album', key}, ...] (may be empty
// before the first rescan/startup import has found any artist photos or album art).
function getLoginBackgroundPool() {
  const row = getRow.get();
  if (!row || !row.images) return [];
  try {
    const pool = JSON.parse(row.images);
    return Array.isArray(pool) ? pool.filter((entry) => entry && entry.type && entry.key) : [];
  } catch {
    return [];
  }
}

// Fetches the actual image bytes for one pool entry by its index into getLoginBackgroundPool() —
// used to serve GET /api/login-background/image/:idx.
function getLoginBackgroundImageAt(idx) {
  const pool = getLoginBackgroundPool();
  const entry = pool[idx];
  if (!entry) return null;
  if (entry.type === 'album') return getAlbumImageStmt.get(entry.key) || null;
  return getArtistPhotoByKey(entry.key);
}

module.exports = { regenerateLoginBackground, getLoginBackgroundPool, getLoginBackgroundImageAt };
