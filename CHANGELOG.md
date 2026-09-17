# Changelog

All notable changes to this project are documented here, most recent first.
This project doesn't follow a formal version number — entries are grouped by
when the work happened instead.

## 2026-09-17

- Added this changelog.

## 2026-09-15

- Login page background mosaic now mixes in album cover art alongside artist
  pictures (previously artist photos only), so it stays varied even on a
  library with few curated artist pictures.
- Mosaic grid made denser — 140 small tiles instead of 63 larger ones.
- The mosaic is now rendered directly into the login page's HTML on the
  server, instead of being fetched and built by client-side JavaScript after
  the page loads — it's there on first paint instead of popping in a moment
  later.

## 2026-09-14

- **Queue management**: "Play next" and "Add to queue" buttons on every
  track row (Tracks tab, an artist's Albums & Tracks list, Album detail);
  remove and drag-to-reorder directly in the Now Playing panel. Queuing a
  track already elsewhere in the queue moves it rather than duplicating it.
- Added `GET /healthz` (checks the process is up and the database is
  readable) and wired it into the Dockerfile as a container `HEALTHCHECK`,
  so `docker ps`/Portainer show a real health status.
- Replaced express-session's default in-memory session store with a small
  custom store backed by the existing SQLite database — logins now survive
  a container restart, and the "MemoryStore is not designed for a
  production environment" warning is gone.
- Performance: artist photos are now imported into the database (once at
  startup and again after every rescan) instead of being read from disk on
  every request — the Artists page and login background went from a live
  filesystem read per photo to a plain DB lookup.
- Performance: fixed a slower general app-load bottleneck caused by an
  uncached synchronous disk read per artist and an over-fetching API call;
  ~24x faster on repeat lookups in a synthetic 600-artist benchmark. No
  database engine change was needed.

## 2026-09-12

- Login page background: a tiled, rotated mosaic of random artist pictures
  behind the sign-in card (Jellyfin-style), refreshed only when a library
  rescan finishes.

## Earlier

The initial build, covering:

- Core library scanning: recursive walk of one or more `MUSIC_DIR` folders,
  ID3 tag reading, embedded cover art extraction, all stored in SQLite.
- Search and filtering: full-text search plus artist/album/year/genre
  filters, with live suggestions in the topbar search box.
- Playback: a built-in streaming player with seeking, volume/mute,
  keyboard shortcuts, shuffle, "Shuffle All", "Rediscover" (biased toward
  unplayed tracks), and an optional gapless crossfade.
- Radio: an ad-hoc similar-artist queue built from Last.fm data, with a
  same-genre/same-artist fallback when no Last.fm key is configured.
- Artist and Album detail pages, with Last.fm bios/tags/similar artists and
  hover-to-preview photos and cover art throughout the app.
- Playlists: create, rename, delete, drag-and-drop or multi-select
  building, M3U/M3U8 import and export, smart (auto-updating) playlists,
  and one-click generation by Artist/Genre/Year/Decade (single pick or
  bulk, as fixed or auto-updating playlists).
- Favorites and play counts, a dedicated play History tab, and a "listening
  recap" (top tracks/artists this week, "on this day" in past years).
- A Now Playing panel showing the active queue for any source (playlist,
  Tracks tab, Shuffle All, Radio, History, etc.), with resume-on-reload of
  the last track, position, and full queue.
- Last.fm scrobbling (now-playing updates and scrobbles) via an in-app
  account connection flow.
- A library Health tab: missing tags, missing cover art, artists without a
  matched photo, scan errors, and possible duplicate tracks.
- A Stats tab: library totals, listening habits, and ranked breakdowns by
  decade, year, genre, artist, and album.
- One-click SQLite database backup download.
- Username/password login with a session cookie, for safely exposing the
  app to the internet.
- Docker packaging via `docker-compose.yml`, with music/pictures folders
  and app settings configured through a single `.env` file.
