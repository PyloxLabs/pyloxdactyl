const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../lib/db');
const totp = require('../lib/totp');
const mailer = require('../lib/mailer');
const baseurl = require('../lib/baseurl');
const { guestOnly } = require('../middleware/auth');

// On a fresh install the panel URL must lead to setup, not the login form.
function redirectToInstall(req, res, next) {
  if (db.isFirstRun && db.isFirstRun()) return res.redirect('/install');
  next();
}

router.get('/login', guestOnly, redirectToInstall, (req, res) => {
  const require2fa = !!(req.session && req.session.pending2faUserId);
  res.render('auth/login', { error: null, require2fa });
});

router.post('/login', guestOnly, redirectToInstall, (req, res) => {
  const { email, password, totp: totpCode } = req.body || {};

  if (req.session && req.session.pending2faUserId) {
    const pending = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.pending2faUserId);
    if (!pending || !pending.totp_enabled || !pending.totp_secret) {
      delete req.session.pending2faUserId;
      return res.render('auth/login', { error: req.t('routes.auth.sessionExpired'), require2fa: false });
    }
    if (!totp.verify(totpCode, pending.totp_secret)) {
      return res.render('auth/login', { error: req.t('routes.auth.invalidTwoFactorCode'), require2fa: true });
    }
    delete req.session.pending2faUserId;
    req.session.userId = pending.id;
    return res.redirect('/dashboard');
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(email, email);
  if (!user || !bcrypt.compareSync(password || '', user.password)) {
    return res.render('auth/login', { error: req.t('routes.auth.invalidCredentials'), require2fa: false });
  }
  if (user.totp_enabled && user.totp_secret) {
    req.session.pending2faUserId = user.id;
    return res.render('auth/login', { error: null, require2fa: true });
  }
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

router.get('/register', guestOnly, redirectToInstall, (req, res) => {
  res.render('auth/register', { error: null });
});

router.post('/register', guestOnly, redirectToInstall, (req, res) => {
  const { username, email, password, password_confirm } = req.body;
  if (!username || !email || !password) {
    return res.render('auth/register', { error: req.t('routes.auth.allFieldsRequired') });
  }
  if (password !== password_confirm) {
    return res.render('auth/register', { error: req.t('routes.auth.passwordsDontMatch') });
  }
  if (password.length < 8) {
    return res.render('auth/register', { error: req.t('routes.auth.passwordTooShort') });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (exists) {
    return res.render('auth/register', { error: req.t('routes.auth.usernameOrEmailTaken') });
  }
  const hash = bcrypt.hashSync(password, 10);
  const isFirstUser = db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0;
  db.prepare('INSERT INTO users (uuid, username, email, password, root_admin) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), username, email, hash, isFirstUser ? 1 : 0);
  // Creating the first account through the regular register page also finishes setup.
  if (isFirstUser && db.markInstalled) db.markInstalled();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function findByResetToken(token) {
  if (!token) return null;
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  if (!user) return null;
  const expires = Number(user.reset_token_expires);
  if (!expires || expires <= Math.floor(Date.now() / 1000)) return null;
  return user;
}

router.get('/forgot-password', guestOnly, (req, res) => {
  res.render('auth/forgot', { error: null, sent: false });
});

router.post('/forgot-password', guestOnly, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.render('auth/forgot', { error: req.t('routes.auth.emailRequired'), sent: false });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Math.floor((Date.now() + RESET_TOKEN_TTL_MS) / 1000);
    db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, String(expires), user.id);

    const siteName = db.getSetting('site_name', 'Pyloxdactyl');
    const baseUrl = baseurl.resolveBaseUrl(req);
    const link = `${baseUrl}/auth/reset-password?token=${token}`;

    try {
      await mailer.sendTemplateEmail({
        to: user.email,
        subject: req.t('mail.resetSubject', { siteName }),
        title: req.t('mail.resetTitle'),
        greeting: req.t('mail.resetGreeting', { username: user.username }),
        body: [{ text: req.t('mail.resetBody', { siteName }) }],
        buttonText: req.t('mail.resetButton'),
        buttonUrl: link,
        note: `${req.t('mail.resetFallback')} ${link}\n\n${req.t('mail.emailFooter', { siteName })}`,
        baseUrl,
      });
    } catch (err) {
      console.error('[auth] failed to send reset email:', err.message);
    }
  }

  // Always show the same result so accounts can't be enumerated.
  res.render('auth/forgot', { error: null, sent: true });
});

router.get('/reset-password', guestOnly, (req, res) => {
  const token = String(req.query.token || '');
  const user = findByResetToken(token);
  res.render('auth/reset', { token, error: user ? null : req.t('routes.auth.invalidResetToken'), valid: !!user, success: false });
});

router.post('/reset-password', guestOnly, (req, res) => {
  const token = String(req.body.token || '');
  const { password, password_confirm } = req.body;
  const user = findByResetToken(token);
  if (!user) {
    return res.render('auth/reset', { token, error: req.t('routes.auth.invalidResetToken'), valid: false, success: false });
  }
  if (!password || password.length < 8) {
    return res.render('auth/reset', { token, error: req.t('routes.auth.passwordTooShort'), valid: true, success: false });
  }
  if (password !== password_confirm) {
    return res.render('auth/reset', { token, error: req.t('routes.auth.passwordsDontMatch'), valid: true, success: false });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, user.id);
  res.render('auth/reset', { token: null, error: null, valid: false, success: true });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/auth/login');
});

module.exports = router;