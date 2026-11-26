const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../lib/db');
const install = require('../lib/install');

const router = express.Router();

// The wizard only exists while the freshly created database has no admin.
// Once setup is done it sends everyone back to the regular auth pages.
router.use((req, res, next) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  if (!db.isFirstRun()) return res.redirect('/auth/login');
  next();
});

function renderError(req, res, error, values) {
  return res.render('install/index', { error, values });
}

router.get('/', (req, res) => {
  renderError(req, res, null, { username: '', email: '' });
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const error = install.validateAdminInput(body, req.t);
  if (error) {
    return renderError(req, res, error, { username: body.username || '', email: body.email || '' });
  }
  if (!db.isFirstRun()) return res.redirect('/auth/login');

  const username = String(body.username).trim();
  const email = String(body.email).trim();
  const exists = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (exists) {
    return renderError(req, res, req.t('routes.auth.usernameOrEmailTaken'), { username, email });
  }

  const hash = bcrypt.hashSync(String(body.password), 10);
  db.prepare('INSERT INTO users (uuid, username, email, password, root_admin) VALUES (?, ?, ?, ?, 1)').run(uuidv4(), username, email, hash);
  db.markInstalled();

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

module.exports = router;
