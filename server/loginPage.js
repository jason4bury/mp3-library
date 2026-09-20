const fs = require('fs');
const path = require('path');
const { getLoginBackgroundPool } = require('./loginBackground');

// login.html is a static template with a `<!--MOSAIC_TILES-->` placeholder inside the
// .bg-mosaic div. Read once at startup — it's a small file that never changes at runtime — and
// re-render the placeholder per request with actual <img> tags for whatever the currently
// persisted background pool is. Rendering the tiles into the initial HTML (instead of the old
// approach of shipping an empty page and having client-side JS fetch the picture list and build
// the grid afterwards) is what makes the mosaic show up immediately on first paint rather than
// popping in a beat after the page loads.
const TEMPLATE_PATH = path.join(__dirname, '..', 'public', 'login.html');
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

// Matches the grid-template-columns column count in login.html's <style> (14 columns) — enough
// rows on top of that to comfortably cover a rotated, oversized grid on any screen size. Tiles
// repeat the pool in a shuffled order if the library has fewer pictures than this.
const GRID_COLUMNS = 14;
const GRID_ROWS = 10;
const TILE_COUNT = GRID_COLUMNS * GRID_ROWS;

function shuffledTileOrder(poolSize) {
  const order = Array.from({ length: TILE_COUNT }, (_, i) => i % poolSize);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function renderLoginPage() {
  const pool = getLoginBackgroundPool();
  let mosaicHtml = '';
  if (pool.length) {
    mosaicHtml =
      `<div class="bg-mosaic-grid">` +
      shuffledTileOrder(pool.length)
        .map((poolIdx) => `<img src="/api/login-background/image/${poolIdx}" alt="">`)
        .join('') +
      `</div>`;
  }
  // With no pictures yet (fresh install, no rescan has found any artist photos or album art),
  // mosaicHtml stays empty and the plain dark background from login.html's own CSS shows
  // through unchanged — nothing broken, nothing to configure.
  return template.replace('<!--MOSAIC_TILES-->', mosaicHtml);
}

module.exports = { renderLoginPage };
