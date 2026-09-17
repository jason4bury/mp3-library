// Optional Last.fm enrichment for the Artist Info tab: bio, tags, similar artists, listener
// stats. Requires a free API key (LASTFM_API_KEY) — see README. Results are cached in SQLite
// so we don't hit Last.fm's API on every page view.
//
// This file also holds the (separate, also optional) scrobbling support — submitting your
// plays back to your own Last.fm account — which additionally needs LASTFM_API_SECRET, since
// unlike the read-only artist.getinfo/album.getinfo calls above, auth.getToken/getSession and
// track.updateNowPlaying/scrobble are signed, authenticated calls. See README for setup.
const crypto = require('crypto');
const db = require('./db');

const API_BASE = 'https://ws.audioscrobbler.com/2.0/';
const USER_AGENT = 'mp3-library-selfhosted/1.0 (+personal use)';

const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — bios/tags rarely change
const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1000; // 1 day — in case the artist name gets fixed
const ERROR_TTL_MS = 60 * 60 * 1000; // 1 hour — don't hammer Last.fm if it's down

function normalizeKey(name) {
  return (name || '').trim().toLowerCase();
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// Last.fm appends a "Read more on Last.fm" link to bio summary/content — strip it and any
// other markup, since we render this as plain text.
function cleanBio(html) {
  if (!html) return '';
  let text = html.replace(/<a\s+href="[^"]*">Read more on Last\.fm<\/a>\.?/i, '');
  text = text.replace(/<[^>]+>/g, '');
  return text.trim();
}

function parseArtistInfo(body) {
  const a = body.artist;
  const tags = toArray(a.tags && a.tags.tag)
    .map((t) => ({ name: t.name, url: t.url }))
    .filter((t) => t.name);
  const similar = toArray(a.similar && a.similar.artist)
    .map((s) => ({ name: s.name, url: s.url }))
    .filter((s) => s.name);

  return {
    name: a.name,
    url: a.url,
    listeners: a.stats ? parseInt(a.stats.listeners, 10) || 0 : 0,
    playcount: a.stats ? parseInt(a.stats.playcount, 10) || 0 : 0,
    bio_summary: cleanBio(a.bio && a.bio.summary),
    tags,
    similar,
  };
}

function parseAlbumInfo(body) {
  const al = body.album;
  const tags = toArray(al.tags && al.tags.tag)
    .map((t) => ({ name: t.name, url: t.url }))
    .filter((t) => t.name);
  const images = toArray(al.image).filter((i) => i && i['#text']);
  const image = images.length ? (images.find((i) => i.size === 'extralarge') || images[images.length - 1])['#text'] : '';
  const artistName = typeof al.artist === 'string' ? al.artist : (al.artist && al.artist.name) || '';

  return {
    name: al.name,
    artist: artistName,
    url: al.url,
    listeners: al.listeners ? parseInt(al.listeners, 10) || 0 : 0,
    playcount: al.playcount ? parseInt(al.playcount, 10) || 0 : 0,
    image,
    wiki_summary: cleanBio(al.wiki && al.wiki.summary),
    tags,
  };
}

const getCacheRow = db.prepare(`SELECT * FROM lastfm_cache WHERE artist_key = ?`);
const upsertCacheRow = db.prepare(`
  INSERT INTO lastfm_cache (artist_key, artist_name, status, data, fetched_at)
  VALUES (@artist_key, @artist_name, @status, @data, @fetched_at)
  ON CONFLICT(artist_key) DO UPDATE SET
    artist_name=excluded.artist_name, status=excluded.status, data=excluded.data, fetched_at=excluded.fetched_at
`);

const getAlbumCacheRow = db.prepare(`SELECT * FROM lastfm_album_cache WHERE album_key = ?`);
const upsertAlbumCacheRow = db.prepare(`
  INSERT INTO lastfm_album_cache (album_key, artist_name, album_name, status, data, fetched_at)
  VALUES (@album_key, @artist_name, @album_name, @status, @data, @fetched_at)
  ON CONFLICT(album_key) DO UPDATE SET
    artist_name=excluded.artist_name, album_name=excluded.album_name, status=excluded.status,
    data=excluded.data, fetched_at=excluded.fetched_at
`);

function ttlFor(status) {
  if (status === 'ok') return FOUND_TTL_MS;
  if (status === 'not_found') return NOT_FOUND_TTL_MS;
  return ERROR_TTL_MS;
}

function isFresh(row) {
  return row && Date.now() - row.fetched_at < ttlFor(row.status);
}

// Returns one of:
//   { configured: false }                                             — no API key set
//   { configured: true, status: 'ok', artist: {...}, cached, stale }
//   { configured: true, status: 'not_found', cached, stale }
//   { configured: true, status: 'error', message, cached, stale }
async function getArtistInfo(artistName, { force = false } = {}) {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) return { configured: false };

  const key = normalizeKey(artistName);
  const cached = getCacheRow.get(key);

  if (!force && isFresh(cached)) {
    return {
      configured: true,
      status: cached.status,
      cached: true,
      artist: cached.data ? JSON.parse(cached.data) : null,
    };
  }

  try {
    const url = new URL(API_BASE);
    url.searchParams.set('method', 'artist.getinfo');
    url.searchParams.set('artist', artistName);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('format', 'json');
    url.searchParams.set('autocorrect', '1');

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const body = await res.json();

    if (body.error) {
      // Last.fm error code 6 = "The artist you supplied could not be found"
      const status = body.error === 6 ? 'not_found' : 'error';
      upsertCacheRow.run({ artist_key: key, artist_name: artistName, status, data: null, fetched_at: Date.now() });
      return { configured: true, status, cached: false, message: body.message };
    }

    const parsed = parseArtistInfo(body);
    upsertCacheRow.run({
      artist_key: key,
      artist_name: artistName,
      status: 'ok',
      data: JSON.stringify(parsed),
      fetched_at: Date.now(),
    });
    return { configured: true, status: 'ok', cached: false, artist: parsed };
  } catch (err) {
    console.error(`Last.fm lookup failed for "${artistName}": ${err.message}`);
    // A transient network/API error — serve a stale cached copy if we have one rather than nothing.
    if (cached && cached.data) {
      return { configured: true, status: cached.status, cached: true, stale: true, artist: JSON.parse(cached.data) };
    }
    return { configured: true, status: 'error', cached: false, message: err.message };
  }
}

// Same shape as getArtistInfo, but for one album (album.getinfo) — cached by album_key (the
// same "<artist>::<album>" key already used for cover art), since an album name alone isn't
// a stable enough cache key across artists.
//   { configured: false }
//   { configured: true, status: 'ok', album: {...}, cached, stale }
//   { configured: true, status: 'not_found', cached, stale }
//   { configured: true, status: 'error', message, cached, stale }
async function getAlbumInfo(artistName, albumName, albumKey, { force = false } = {}) {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) return { configured: false };
  if (!albumKey) return { configured: true, status: 'error', cached: false, message: 'Missing album key' };

  const cached = getAlbumCacheRow.get(albumKey);

  if (!force && isFresh(cached)) {
    return {
      configured: true,
      status: cached.status,
      cached: true,
      album: cached.data ? JSON.parse(cached.data) : null,
    };
  }

  try {
    const url = new URL(API_BASE);
    url.searchParams.set('method', 'album.getinfo');
    url.searchParams.set('artist', artistName);
    url.searchParams.set('album', albumName);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('format', 'json');
    url.searchParams.set('autocorrect', '1');

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const body = await res.json();

    if (body.error) {
      // Last.fm error code 6 = "not found" (covers both a bad artist and a bad album match)
      const status = body.error === 6 ? 'not_found' : 'error';
      upsertAlbumCacheRow.run({
        album_key: albumKey, artist_name: artistName, album_name: albumName,
        status, data: null, fetched_at: Date.now(),
      });
      return { configured: true, status, cached: false, message: body.message };
    }

    const parsed = parseAlbumInfo(body);
    upsertAlbumCacheRow.run({
      album_key: albumKey,
      artist_name: artistName,
      album_name: albumName,
      status: 'ok',
      data: JSON.stringify(parsed),
      fetched_at: Date.now(),
    });
    return { configured: true, status: 'ok', cached: false, album: parsed };
  } catch (err) {
    console.error(`Last.fm album lookup failed for "${artistName} - ${albumName}": ${err.message}`);
    if (cached && cached.data) {
      return { configured: true, status: cached.status, cached: true, stale: true, album: JSON.parse(cached.data) };
    }
    return { configured: true, status: 'error', cached: false, message: err.message };
  }
}

// ---------- Scrobbling ----------
// Last.fm's API signature scheme: sort every param (except format/callback) by key, concatenate
// key+value pairs with no delimiter, append the shared secret, then md5 the result.
function sign(params, secret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback' && params[k] !== undefined && params[k] !== null)
    .sort();
  const base = keys.map((k) => `${k}${params[k]}`).join('') + secret;
  return crypto.createHash('md5').update(base, 'utf8').digest('hex');
}

function scrobblingConfigured() {
  return !!(process.env.LASTFM_API_KEY && process.env.LASTFM_API_SECRET);
}

// Reads a fetch Response as JSON, but doesn't let a non-JSON body (a proxy/CDN error page, a
// network intermediary blocking the request, Last.fm itself being down) surface as a cryptic
// "Unexpected token" parse error — that's a much more confusing message than just saying the
// request itself failed.
async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Last.fm request failed (HTTP ${res.status}): ${text.slice(0, 200) || 'empty response'}`);
  }
}

async function callSigned(method, params, { httpMethod = 'GET' } = {}) {
  const apiKey = process.env.LASTFM_API_KEY;
  const secret = process.env.LASTFM_API_SECRET;
  const allParams = { method, api_key: apiKey, ...params };
  allParams.api_sig = sign(allParams, secret);
  allParams.format = 'json';

  if (httpMethod === 'GET') {
    const url = new URL(API_BASE);
    Object.entries(allParams).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    return readJson(res);
  }
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(allParams).toString(),
  });
  return readJson(res);
}

const getAuthRow = db.prepare(`SELECT session_key, username, connected_at FROM lastfm_auth WHERE id = 1`);
const setAuthRow = db.prepare(`
  INSERT INTO lastfm_auth (id, session_key, username, connected_at) VALUES (1, @session_key, @username, @connected_at)
  ON CONFLICT(id) DO UPDATE SET session_key=excluded.session_key, username=excluded.username, connected_at=excluded.connected_at
`);
const clearAuthRow = db.prepare(`DELETE FROM lastfm_auth WHERE id = 1`);

// { configured: false }                                        — LASTFM_API_KEY/SECRET not set
// { configured: true, connected: false }                       — configured but not connected
// { configured: true, connected: true, username, connected_at }
function getScrobbleStatus() {
  if (!scrobblingConfigured()) return { configured: false, connected: false };
  const row = getAuthRow.get();
  if (!row || !row.session_key) return { configured: true, connected: false };
  return { configured: true, connected: true, username: row.username, connected_at: row.connected_at };
}

// Step 1 of the connect flow: get a token and the URL to send the user to on last.fm to
// authorize it. No callback URL is registered on the Last.fm API account, so after approving,
// last.fm just shows the user a plain "you're done" page — completeAuth (step 2 below) is what
// the user triggers back in this app once they've done that.
async function startAuth() {
  if (!scrobblingConfigured()) throw new Error('Last.fm scrobbling is not configured (need LASTFM_API_KEY and LASTFM_API_SECRET)');
  const body = await callSigned('auth.getToken', {});
  if (body.error) throw new Error(body.message || 'Failed to get a Last.fm token');
  const token = body.token;
  const authUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(process.env.LASTFM_API_KEY)}&token=${encodeURIComponent(token)}`;
  return { token, authUrl };
}

// Step 2: exchange the (now-authorized) token for a permanent session key and store it.
async function completeAuth(token) {
  if (!scrobblingConfigured()) throw new Error('Last.fm scrobbling is not configured (need LASTFM_API_KEY and LASTFM_API_SECRET)');
  const body = await callSigned('auth.getSession', { token });
  if (body.error) throw new Error(body.message || 'Failed to complete Last.fm authorization — did you approve it on last.fm first?');
  const { key, name } = body.session;
  setAuthRow.run({ session_key: key, username: name, connected_at: Date.now() });
  return { username: name };
}

function disconnect() {
  clearAuthRow.run();
}

// Fire-and-forget style — callers should not let a scrobble failure interrupt playback, so both
// of these swallow their own errors (logging only) and simply return whether it happened.
async function updateNowPlaying({ artist, track, album }) {
  const row = getAuthRow.get();
  if (!row || !row.session_key || !scrobblingConfigured()) return { ok: false, reason: 'not_connected' };
  try {
    const body = await callSigned(
      'track.updateNowPlaying',
      { artist, track, album: album || undefined, sk: row.session_key },
      { httpMethod: 'POST' }
    );
    if (body.error) throw new Error(body.message || `Last.fm error ${body.error}`);
    return { ok: true };
  } catch (err) {
    console.error('Last.fm now-playing update failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

async function scrobble({ artist, track, album, timestamp }) {
  const row = getAuthRow.get();
  if (!row || !row.session_key || !scrobblingConfigured()) return { ok: false, reason: 'not_connected' };
  try {
    const body = await callSigned(
      'track.scrobble',
      { artist, track, album: album || undefined, timestamp, sk: row.session_key },
      { httpMethod: 'POST' }
    );
    if (body.error) throw new Error(body.message || `Last.fm error ${body.error}`);
    return { ok: true };
  } catch (err) {
    console.error('Last.fm scrobble failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  getArtistInfo,
  getAlbumInfo,
  getScrobbleStatus,
  startAuth,
  completeAuth,
  disconnect,
  updateNowPlaying,
  scrobble,
};
