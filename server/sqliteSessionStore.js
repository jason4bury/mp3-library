const session = require('express-session');
const db = require('./db');

// A minimal express-session Store backed by the app's existing SQLite database (see the
// `sessions` table in db.js) — used instead of express-session's default MemoryStore, which
// logs "MemoryStore is not designed for a production environment" on startup. That warning is
// mostly academic for a single-user, single-process app like this one (sessions here are only
// ever created on an actual successful login, not on every anonymous request, so there's no
// real unbounded growth), but MemoryStore has one real downside that matters: it forgets every
// logged-in session the moment the container restarts. Storing sessions in the same SQLite
// file the rest of the app already uses fixes both — no extra service (Redis etc.), no extra
// dependency, and logins now survive a restart/redeploy.
//
// Implements the handful of methods express-session's Store actually needs: get/set/destroy
// (required), touch (keeps a session's expiry rolling forward on activity without express-
// session having to call set() again), and all/length/clear (optional, but cheap to support and
// occasionally useful — e.g. from a Node shell for debugging who's logged in).

const getStmt = db.prepare(`SELECT data, expires FROM sessions WHERE sid = ?`);
const setStmt = db.prepare(`
  INSERT INTO sessions (sid, expires, data) VALUES (@sid, @expires, @data)
  ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data
`);
const touchStmt = db.prepare(`UPDATE sessions SET expires = ? WHERE sid = ?`);
const destroyStmt = db.prepare(`DELETE FROM sessions WHERE sid = ?`);
const pruneStmt = db.prepare(`DELETE FROM sessions WHERE expires IS NOT NULL AND expires < ?`);
const allStmt = db.prepare(`SELECT data FROM sessions WHERE expires IS NULL OR expires >= ?`);
const countStmt = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE expires IS NULL OR expires >= ?`);
const clearStmt = db.prepare(`DELETE FROM sessions`);

// A cookie only carries an expiry when the session has a maxAge (ours always does — see the
// session() config in index.js) — this app never issues expiry-less session cookies, but fall
// back to a conservative 1 day rather than storing a row that never expires, just in case.
function expiresOf(sessionData) {
  const raw = sessionData && sessionData.cookie && sessionData.cookie.expires;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Date.now() + 24 * 60 * 60 * 1000;
}

class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super(options);
    this._prune();
    // Sweep expired rows periodically rather than only on access, so a session nobody ever
    // revisits doesn't just sit in the table forever. unref() so this timer alone can't keep
    // the process alive.
    const interval = options.pruneIntervalMs || 15 * 60 * 1000;
    this._pruneTimer = setInterval(() => this._prune(), interval);
    if (this._pruneTimer.unref) this._pruneTimer.unref();
  }

  _prune() {
    try {
      pruneStmt.run(Date.now());
    } catch (err) {
      console.error('Session prune failed:', err.message);
    }
  }

  get(sid, cb) {
    try {
      const row = getStmt.get(sid);
      if (!row) return cb(null, null);
      if (row.expires != null && row.expires < Date.now()) {
        destroyStmt.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sessionData, cb) {
    try {
      setStmt.run({ sid, expires: expiresOf(sessionData), data: JSON.stringify(sessionData) });
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      destroyStmt.run(sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  touch(sid, sessionData, cb) {
    try {
      touchStmt.run(expiresOf(sessionData), sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  all(cb) {
    try {
      cb(null, allStmt.all(Date.now()).map((r) => JSON.parse(r.data)));
    } catch (err) {
      cb(err);
    }
  }

  length(cb) {
    try {
      cb(null, countStmt.get(Date.now()).n);
    } catch (err) {
      cb(err);
    }
  }

  clear(cb) {
    try {
      clearStmt.run();
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }
}

module.exports = SqliteSessionStore;
