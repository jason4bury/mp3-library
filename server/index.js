require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const db = require('./db');
const { requireAuth, login, logout, me } = require('./auth');
const apiRoutes = require('./routes/api');
const { runScan, getScanStatus } = require('./scanner');
const { regenerateLoginBackground, getLoginBackgroundImageAt } = require('./loginBackground');
const { renderLoginPage } = require('./loginPage');
const { importArtistPhotosToDb } = require('./artistPhotos');
const SqliteSessionStore = require('./sqliteSessionStore');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // needed if running behind a reverse proxy for cookies to work over https

app.use(express.json());
app.use(
  session({
    store: new SqliteSessionStore(),
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
    },
  })
);

// Public auth endpoints
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', me);

// GET /healthz — plain, unauthenticated health check for uptime monitoring (Uptime Kuma, a
// Docker HEALTHCHECK — see the Dockerfile, a reverse proxy's own health probe, etc.). A
// monitoring tool has no session cookie, so this deliberately sits outside requireAuth, same as
// the login-background routes above. Kept minimal on purpose — this just confirms the process
// is up and SQLite is actually readable, not a deep diagnostic; that's what the in-app Health
// tab (GET /api/health/summary) is for.
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    const scan = getScanStatus();
    res.json({
      status: 'ok',
      uptime_seconds: Math.round(process.uptime()),
      scan_status: scan ? scan.status : null,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// Public — serves the actual image bytes for one tile of the login page's background mosaic,
// by its index into the currently-persisted pool (see loginBackground.js). Deliberately NOT
// behind requireAuth, since it needs to render before the user has signed in. The pool itself
// only changes when a rescan finishes — this just serves whatever's currently persisted, so
// repeat calls (every page load) return the same pictures until the next rescan.
app.get('/api/login-background/image/:idx', (req, res) => {
  const idx = Number.parseInt(req.params.idx, 10);
  const photo = Number.isInteger(idx) ? getLoginBackgroundImageAt(idx) : null;
  if (!photo) return res.status(404).end();
  res.set('Content-Type', photo.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(photo.data);
});

// Everything else under /api requires a session
app.use('/api', requireAuth, apiRoutes);

// Static frontend — login.html is public, everything else requires auth. Server-rendered (not
// a plain sendFile) so the background mosaic's <img> tags are already in the HTML the browser
// gets back — see server/loginPage.js.
app.get('/login.html', (req, res) => {
  res.type('html').send(renderLoginPage());
});
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path.startsWith('/api/')) return next();
  return requireAuth(req, res, next);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`MP3 library server listening on port ${PORT}`);

  // Import artist photos into the DB on every boot (not just on a rescan) — this is what
  // makes the fix take effect immediately on an existing, already-scanned library rather than
  // leaving artist_photos empty until the user happens to click Rescan. Cheap on repeat boots:
  // importArtistPhotosToDb() skips any photo whose file hasn't changed since it was last
  // imported (see its mtime check), so this only costs real disk time on the very first run
  // and whenever a photo has actually changed.
  try {
    const result = importArtistPhotosToDb();
    console.log(
      `Artist photos: ${result.imported} imported, ${result.unchanged} unchanged, ${result.removed} removed (${result.total} total)`
    );
    regenerateLoginBackground();
  } catch (err) {
    console.error('Failed to import artist photos on startup:', err);
  }

  const status = getScanStatus();
  if (!status || status.files_processed === 0) {
    console.log('No tracks in database yet — starting an initial scan...');
    runScan().catch((err) => console.error('Initial scan failed:', err));
  }
});
