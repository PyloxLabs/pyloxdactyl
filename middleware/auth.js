const db = require('../lib/db');
const { parsePermissions } = require('../lib/permissions');

function authRequired(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/auth/login');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy();
    return res.redirect('/auth/login');
  }
  req.user = user;
  res.locals.user = user;
  res.locals.isLoggedIn = true;
  next();
}

function adminRequired(req, res, next) {
  if (!req.user || !req.user.root_admin) {
    return res.status(403).render('errors/403');
  }
  next();
}

function guestOnly(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }
  next();
}

function apiKeyAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: (req.t && req.t('routes.middleware.unauthorized')) || 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  const key = db.prepare('SELECT ak.*, u.id as uid, u.username, u.root_admin FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.token = ?').get(token);
  if (!key) {
    return res.status(401).json({ error: (req.t && req.t('routes.middleware.invalidApiKey')) || 'Invalid API key' });
  }
  db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(key.id);
  req.apiKey = key;
  req.user = { id: key.uid, username: key.username, root_admin: key.root_admin };
  next();
}

// Resolves a server and grants access to its owner, root admins, and granted
// subusers. The subuser's permission list is exposed as req.serverPermissions
// (null means full access).
function serverAccess(req, res, next) {
  const serverId = req.params.serverId || req.params.id;
  if (!serverId) return next();
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) return res.status(404).render('errors/404');

  const isOwner = server.user_id === req.user.id;
  let permissions = null;
  if (!req.user.root_admin && !isOwner) {
    const sub = db.prepare('SELECT permissions FROM subusers WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
    if (!sub) return res.status(403).render('errors/403');
    permissions = parsePermissions(sub.permissions);
  }

  req.server = server;
  req.serverPermissions = permissions;
  req.isServerOwner = !!(req.user.root_admin || isOwner);
  res.locals.server = server;
  res.locals.serverPermissions = permissions;
  res.locals.isServerOwner = req.isServerOwner;
  next();
}

// Restricts a route to the server owner (or a root admin). Intended to run
// after serverAccess.
function requireServerOwner(req, res, next) {
  if (req.isServerOwner) return next();
  return res.status(403).render('errors/403');
}

// Restricts a route to holders of a specific subuser permission. Owners and
// root admins always pass, since their permission list is null.
function requirePermission(permission) {
  return (req, res, next) => {
    const perms = req.serverPermissions;
    if (perms === null || perms === undefined) return next();
    if (perms.includes(permission)) return next();
    return res.status(403).render('errors/403');
  };
}

module.exports = { authRequired, adminRequired, guestOnly, apiKeyAuth, serverAccess, requireServerOwner, requirePermission };