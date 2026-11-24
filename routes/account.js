const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const crypto = require('crypto');
const db = require('../lib/db');
const i18n = require('../lib/i18n');
const totp = require('../lib/totp');
const { authRequired } = require('../middleware/auth');

router.use(authRequired);

router.get('/', (req, res) => {
  res.render('account/settings', { title: req.t('common.settings') });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function passwordOk(user, password) {
  return !!password && bcrypt.compareSync(String(password), user.password);
}

router.post('/email', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: req.t('routes.account.invalidEmail') });
  }
  if (!passwordOk(req.user, password)) {
    return res.status(401).json({ error: req.t('routes.account.passwordIncorrect') });
  }
  const normalized = String(email).trim();
  const exists = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(normalized, req.user.id);
  if (exists) return res.status(409).json({ error: req.t('routes.account.emailInUse') });
  db.prepare('UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(normalized, req.user.id);
  db.save();
  res.json({ ok: true, email: normalized });
});

router.post('/password', (req, res) => {
  const { current_password, new_password, confirm_password } = req.body || {};
  if (!passwordOk(req.user, current_password)) {
    return res.status(401).json({ error: req.t('routes.account.currentPasswordIncorrect') });
  }
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: req.t('routes.account.newPasswordTooShort') });
  }
  if (new_password !== confirm_password) {
    return res.status(400).json({ error: req.t('routes.account.newPasswordsDontMatch') });
  }
  const hash = bcrypt.hashSync(String(new_password), 10);
  db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.user.id);
  db.save();
  res.json({ ok: true });
});

router.post('/language', (req, res) => {
  const { language } = req.body || {};
  if (!i18n.SUPPORTED.includes(language)) {
    return res.status(400).json({ error: req.t('account.language.invalid') });
  }
  db.prepare('UPDATE users SET language = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(String(language), req.user.id);
  db.save();
  res.json({ ok: true, language });
});

router.post('/2fa/setup', async (req, res) => {
  try {
    const secret = totp.generateSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, req.user.id);
    db.save();
    const issuer = (db.getSetting && db.getSetting('site_name', 'Panel')) || 'Panel';
    const otpauth = totp.otpauthUrl(secret, req.user.email, issuer);
    const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 });
    res.json({ ok: true, secret, otpauth, qr });
  } catch (err) {
    console.error('[2FA] setup failed:', err);
    res.status(500).json({ error: req.t('routes.account.twoFactorSetupFailed') });
  }
});

router.post('/2fa/enable', (req, res) => {
  const { code } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.totp_secret) {
    return res.status(400).json({ error: req.t('routes.account.twoFactorSetupFirst') });
  }
  if (!totp.verify(code, user.totp_secret)) {
    return res.status(400).json({ error: req.t('routes.account.invalidTwoFactorCode') });
  }
  db.prepare('UPDATE users SET totp_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  db.save();
  res.json({ ok: true });
});

router.post('/2fa/disable', (req, res) => {
  const { password } = req.body || {};
  if (!passwordOk(req.user, password)) {
    return res.status(401).json({ error: req.t('routes.account.passwordIncorrect') });
  }
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.user.id);
  db.save();
  res.json({ ok: true });
});

// SSH keys
const SSH_KEY_TYPES = /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/;

function sshFingerprint(publicKey) {
  try {
    const blob = publicKey.trim().split(/\s+/)[1];
    const digest = crypto.createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '');
    return 'SHA256:' + digest;
  } catch {
    return null;
  }
}

function sshKeysFor(userId) {
  return db.prepare('SELECT id, name, public_key, fingerprint, created_at FROM ssh_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

router.get('/ssh-keys', (req, res) => {
  res.render('account/ssh-keys', { keys: sshKeysFor(req.user.id), error: null });
});

router.post('/ssh-keys/create', (req, res) => {
  const { name, public_key } = req.body || {};
  const key = String(public_key || '').trim().replace(/\r?\n/g, ' ');
  const label = String(name || '').trim() || req.t('routes.account.defaultSshKeyLabel');

  if (!key) {
    return res.status(400).render('account/ssh-keys', { keys: sshKeysFor(req.user.id), error: req.t('routes.account.pastePublicKey') });
  }
  if (!SSH_KEY_TYPES.test(key)) {
    return res.status(400).render('account/ssh-keys', { keys: sshKeysFor(req.user.id), error: req.t('routes.account.invalidSshKey') });
  }
  const fingerprint = sshFingerprint(key);
  db.prepare('INSERT INTO ssh_keys (user_id, name, public_key, fingerprint) VALUES (?, ?, ?, ?)').run(req.user.id, label, key, fingerprint);
  db.save();
  res.redirect('/account/ssh-keys');
});

router.post('/ssh-keys/:id/delete', (req, res) => {
  db.prepare('DELETE FROM ssh_keys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  db.save();
  res.redirect('/account/ssh-keys');
});

module.exports = router;