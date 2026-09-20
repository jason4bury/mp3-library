function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login.html');
}

function login(req, res) {
  const { username, password } = req.body || {};
  const expectedUser = process.env.APP_USERNAME || 'admin';
  const expectedPass = process.env.APP_PASSWORD || 'change-me';

  if (username === expectedUser && password === expectedPass) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Invalid username or password' });
}

function logout(req, res) {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
}

function me(req, res) {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
}

module.exports = { requireAuth, login, logout, me };
