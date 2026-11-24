const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../lib/db');
const totp = require('../lib/totp');
const daemonLib = require('../lib/daemon');
const { PERMISSION_GROUPS, parsePermissions, sanitizePermissions } = require('../lib/permissions');
const { isExecutable } = require('../lib/executable');
const { isCompressed } = require('../lib/archive');
const { parseEggJson } = require('../lib/egg-import');

const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-secret';
const backupsDir = path.join(__dirname, '..', 'data', 'backups');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    uuid: u.uuid,
    username: u.username,
    email: u.email,
    root_admin: !!u.root_admin,
    language: u.language || 'en',
    totp_enabled: !!u.totp_enabled,
    created_at: u.created_at,
  };
}

function panelInfo() {
  return {
    name: db.getSetting('site_name', 'Panel'),
    version: require('../package.json').version,
  };
}

function signChallenge(obj) {
  const data = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyChallenge(token) {
  const raw = String(token || '');
  const idx = raw.lastIndexOf('.');
  if (idx < 1) return null;
  const data = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload || !payload.uid) return null;
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function issueApiKey(userId, installId) {
  const tag = String(installId || 'device').replace(/[^\w.:-]/g, '').slice(0, 64) || 'device';
  const memo = `Pyloxdactyl APP:${tag}`;
  try { db.prepare("DELETE FROM api_keys WHERE user_id = ? AND memo = ? AND source = 'mobile'").run(userId, memo); } catch (_) {}
  const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  db.prepare("INSERT INTO api_keys (user_id, token, memo, source, created_by) VALUES (?, ?, ?, 'mobile', ?)").run(userId, token, memo, userId);
  try { db.save(); } catch (_) {}
  return token;
}

function auth(req, res, next) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    const key = db.prepare(
      'SELECT ak.*, u.id as uid FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.token = ?'
    ).get(token);
    if (!key) return res.status(401).json({ error: 'Invalid API key' });
    db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(key.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(key.uid);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.apiKey = key;
    req.user = user;
    return next();
  }
  if (req.session && req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      req.user = user;
      req.sessionAuth = true;
      return next();
    }
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function adminOnly(req, res, next) {
  if (!req.user || !req.user.root_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function serverAccess(req, res, next) {
  const srv = db.prepare(`
    SELECT s.*, n.name as node_name, n.fqdn, n.scheme, a.ip as allocation_ip, a.port as allocation_port
    FROM servers s
    LEFT JOIN nodes n ON s.node_id = n.id
    LEFT JOIN allocations a ON s.allocation_id = a.id
    WHERE s.uuid = ?
  `).get(req.params.uuid);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  // Suspended servers expose nothing to clients until an administrator
  // unsuspends them (the panel overview is locked down too).
  if (srv.suspended) return res.status(403).json({ error: 'Server is suspended. Contact an administrator to unsuspend it.' });

  const isOwner = srv.user_id === req.user.id;
  let perms = null;
  if (!req.user.root_admin && !isOwner) {
    const sub = db.prepare('SELECT permissions FROM subusers WHERE server_id = ? AND user_id = ?').get(srv.id, req.user.id);
    if (!sub) return res.status(404).json({ error: 'Server not found' });
    perms = parsePermissions(sub.permissions);
  }
  req.server = srv;
  req.perms = perms;
  req.isOwner = !!(req.user.root_admin || isOwner);
  next();
}

function can(permission) {
  return (req, res, next) => {
    if (req.perms === null || req.perms === undefined || req.perms.includes(permission)) return next();
    return res.status(403).json({ error: `Missing permission: ${permission}` });
  };
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function grab(v, def) {
  return (v === undefined || v === null || v === '') ? def : v;
}

function normalizeListen(v) {
  const s = (v === undefined || v === null) ? '' : String(v);
  return s.replace(/^0\.0\.0\.0:/, '').trim() || '8080';
}

function expandPorts(spec) {
  const ports = new Set();
  for (const part of String(spec || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let start = parseInt(m[1], 10);
      let end = parseInt(m[2], 10);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      if (start > end) { const t = start; start = end; end = t; }
      if (end - start > 65535) end = start + 65535;
      for (let p = start; p <= end; p++) ports.add(p);
    } else {
      const p = parseInt(s, 10);
      if (!Number.isNaN(p)) ports.add(p);
    }
  }
  return [...ports];
}

const NODE_PROBE_TIMEOUT_MS = 1500;
const NODE_STATUS_TTL_MS = 10000;
const nodeStatus = new Map();
const nodeProbes = new Map();

function checkNodeHealth(node) {
  return new Promise((resolve) => {
    if (!node || !node.fqdn) return resolve(false);
    const scheme = node.scheme || 'https';
    const listen = node.daemon_listen || '8080';
    const port = parseInt(String(listen).split(':').pop(), 10) || 8080;
    const lib = scheme === 'http' ? http : https;
    const req = lib.get({
      hostname: daemonLib.nodeHost(node),
      port,
      path: '/health',
      timeout: NODE_PROBE_TIMEOUT_MS,
      rejectUnauthorized: false,
    }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function nodeOnline(node) {
  const cached = nodeStatus.get(node.id);
  if (cached && Date.now() - cached.at <= NODE_STATUS_TTL_MS) return Promise.resolve(cached.online);
  let probe = nodeProbes.get(node.id);
  if (!probe) {
    probe = checkNodeHealth(node)
      .then((online) => {
        nodeStatus.set(node.id, { at: Date.now(), online });
        return online;
      })
      .finally(() => nodeProbes.delete(node.id));
    nodeProbes.set(node.id, probe);
  }
  if (cached) return Promise.resolve(cached.online);
  return probe;
}

function liveStats(uuid) {
  return daemonLib.getServerStatsSafe(uuid, 2500).then((stats) => {
    if (!stats || (typeof stats.status !== 'string' && stats.cpu === undefined)) {
      return { connected: false, status: null };
    }
    let status = typeof stats.status === 'string' ? stats.status : null;
    if (status === 'not_created') status = 'offline';
    let uptime = 0;
    if (status === 'running' && stats.startedAt) {
      const since = new Date(stats.startedAt).getTime();
      if (!isNaN(since) && since > 0) uptime = Math.max(0, Math.floor((Date.now() - since) / 1000));
    }
    return {
      connected: true,
      status,
      uptime,
      cpu: Number(stats.cpu) || 0,
      memory: Number(stats.memory) || 0,
      memory_limit: Number(stats.memory_limit) || 0,
      disk: Number(stats.disk) || 0,
      network_rx: Number(stats.network_rx) || 0,
      network_tx: Number(stats.network_tx) || 0,
      started_at: stats.startedAt || null,
      container_id: stats.containerId || null,
    };
  });
}

router.get('/ping', (req, res) => {
  res.json({ ok: true, panel: 'pylox-panel', ...panelInfo() });
});

router.post('/auth/login', authLimiter, (req, res) => {
  const { identifier, password, totp: totpCode, challenge, installId } = req.body || {};

  if (challenge) {
    const payload = verifyChallenge(challenge);
    if (!payload) return res.status(400).json({ error: 'Session expired. Sign in again.' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      return res.status(400).json({ error: 'Session expired. Sign in again.' });
    }
    if (!totp.verify(String(totpCode || ''), user.totp_secret)) {
      return res.status(401).json({ error: 'Invalid two-factor code.', require2fa: true, challenge });
    }
    const apiKey = issueApiKey(user.id, installId);
    if (req.session) req.session.userId = user.id;
    return res.json({ ok: true, require2fa: false, user: publicUser(user), apiKey, ...panelInfo() });
  }

  const ident = String(identifier || '').trim();
  if (!ident || !password) return res.status(400).json({ error: 'Username/email and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(ident, ident);
  if (!user || !bcrypt.compareSync(String(password), user.password)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  if (user.totp_enabled && user.totp_secret) {
    return res.json({
      ok: false,
      require2fa: true,
      challenge: signChallenge({ uid: user.id, exp: Date.now() + 10 * 60 * 1000 }),
    });
  }
  const apiKey = issueApiKey(user.id, installId);
  if (req.session) req.session.userId = user.id;
  res.json({ ok: true, require2fa: false, user: publicUser(user), apiKey, ...panelInfo() });
});

router.post('/auth/logout', auth, (req, res) => {
  if (req.apiKey) {
    try { db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.apiKey.id); } catch (_) {}
  }
  if (req.session && req.sessionAuth) {
    try { req.session.destroy(); } catch (_) {}
  }
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.get('/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user), panel: panelInfo() });
});

router.post('/me/email', auth, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !EMAIL_RE.test(String(email).trim())) return res.status(400).json({ error: 'Invalid email address.' });
  if (!password || !bcrypt.compareSync(String(password), req.user.password)) {
    return res.status(401).json({ error: 'Password is incorrect.' });
  }
  const normalized = String(email).trim();
  const exists = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(normalized, req.user.id);
  if (exists) return res.status(409).json({ error: 'That email is already in use.' });
  db.prepare('UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(normalized, req.user.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true, email: normalized });
});

router.post('/me/password', auth, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body || {};
  if (!current_password || !bcrypt.compareSync(String(current_password), req.user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!new_password || String(new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  if (new_password !== confirm_password) return res.status(400).json({ error: 'New passwords do not match.' });
  const hash = bcrypt.hashSync(String(new_password), 10);
  db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.user.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/me/2fa/setup', auth, async (req, res) => {
  try {
    const secret = totp.generateSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, req.user.id);
    try { db.save(); } catch (_) {}
    const issuer = db.getSetting('site_name', 'Panel');
    const otpauth = totp.otpauthUrl(secret, req.user.email, issuer);
    const QRCode = require('qrcode');
    const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 });
    res.json({ ok: true, secret, otpauth, qr });
  } catch (err) {
    res.status(500).json({ error: 'Two-factor setup failed.' });
  }
});

router.post('/me/2fa/enable', auth, (req, res) => {
  const { code } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.totp_secret) return res.status(400).json({ error: 'Set up two-factor authentication first.' });
  if (!totp.verify(String(code || ''), user.totp_secret)) return res.status(400).json({ error: 'Invalid two-factor code.' });
  db.prepare('UPDATE users SET totp_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/me/2fa/disable', auth, (req, res) => {
  const { password } = req.body || {};
  if (!password || !bcrypt.compareSync(String(password), req.user.password)) {
    return res.status(401).json({ error: 'Password is incorrect.' });
  }
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.user.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

function listServers(userId, all) {
  const base = `
    SELECT s.*, u.username as owner_username, n.name as node_name, n.fqdn, n.scheme, a.ip as allocation_ip, a.port as allocation_port
    FROM servers s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN nodes n ON s.node_id = n.id
    LEFT JOIN allocations a ON s.allocation_id = a.id
  `;
  if (all) return db.prepare(`${base} ORDER BY s.created_at DESC`).all();
  return db.prepare(`${base} WHERE s.user_id = ? OR EXISTS (SELECT 1 FROM subusers su WHERE su.server_id = s.id AND su.user_id = ?) ORDER BY s.created_at DESC`).all(userId, userId);
}

router.get('/servers', auth, async (req, res) => {
  const all = req.user.root_admin && req.query.all === '1';
  const servers = listServers(req.user.id, all);
  for (const s of servers) delete s.sftp_password;
  if (req.query.live === '1') {
    await Promise.all(servers.map(async (s) => {
      const live = await liveStats(s.uuid);
      if (live.connected && live.status && live.status !== s.status) {
        try { db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(live.status, s.id); } catch (_) {}
        s.status = live.status;
      }
      s.live = live;
    }));
    try { db.save(); } catch (_) {}
  }
  res.json({ data: servers });
});

router.get('/servers/:uuid', auth, serverAccess, async (req, res) => {
  const srv = req.server;
  const live = await liveStats(srv.uuid);
  if (live.connected && live.status && live.status !== srv.status) {
    try { db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(live.status, srv.id); } catch (_) {}
    srv.status = live.status;
    try { db.save(); } catch (_) {}
  }
  const egg = srv.egg_id ? db.prepare('SELECT id, name, startup FROM eggs WHERE id = ?').get(srv.egg_id) : null;
  srv.live = live;
  srv.egg_name = egg ? egg.name : null;
  srv.permissions = req.perms;
  srv.is_owner = req.isOwner;
  delete srv.sftp_password;
  res.json({ data: srv });
});

router.post('/servers/:uuid/power', auth, serverAccess, can('console.power'), async (req, res) => {
  const { action } = req.body || {};
  if (req.server.suspended) return res.status(409).json({ ok: false, code: 'suspended', error: 'Server is suspended. Contact an administrator.' });
  try {
    let result;
    switch (action) {
      case 'start': result = await daemonLib.startServer(req.server.uuid); break;
      case 'stop': result = await daemonLib.stopServer(req.server.uuid); break;
      case 'restart': result = await daemonLib.restartServer(req.server.uuid); break;
      case 'kill': result = await daemonLib.killServer(req.server.uuid); break;
      default: return res.status(400).json({ error: 'Unknown power action.' });
    }
    let status = (result && result.status) || (action === 'stop' || action === 'kill' ? 'offline' : 'starting');
    if (status === 'not_created') status = 'offline';
    db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.server.id);
    try { db.save(); } catch (_) {}
    res.json({ ok: true, status });
  } catch (e) {
    res.status(409).json({ ok: false, code: e.code || 'error', error: e.message });
  }
});

router.get('/servers/:uuid/resources', auth, serverAccess, can('console.view'), async (req, res) => {
  const live = await liveStats(req.server.uuid);
  if (live.connected && live.status && live.status !== req.server.status) {
    try { db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(live.status, req.server.id); } catch (_) {}
    req.server.status = live.status;
    try { db.save(); } catch (_) {}
  }
  res.json({
    cpu: live.cpu || 0,
    memory: live.memory || 0,
    memory_limit: live.memory_limit || (Number(req.server.memory) || 0) * 1024 * 1024,
    disk: live.disk || 0,
    disk_limit: (Number(req.server.disk) || 0) * 1024 * 1024,
    network_rx: live.network_rx || 0,
    network_tx: live.network_tx || 0,
    status: live.status,
    uptime: live.uptime || 0,
    connected: live.connected,
  });
});

router.get('/servers/:uuid/eula', auth, serverAccess, can('console.view'), async (req, res) => {
  let accepted = false;
  try {
    const content = (await daemonLib.fileRead(req.server.uuid, '/eula.txt')).toString('utf8');
    accepted = /^\s*eula\s*=\s*true\s*$/mi.test(content);
  } catch (_) {}
  res.json({ accepted });
});

router.post('/servers/:uuid/eula', auth, serverAccess, can('console.command'), async (req, res) => {
  const action = req.body && req.body.action;
  if (req.server.suspended) return res.status(409).json({ error: 'Server is suspended. Contact an administrator.' });
  try {
    if (action === 'accept') {
      let content = '';
      try { content = (await daemonLib.fileRead(req.server.uuid, '/eula.txt')).toString('utf8'); } catch (_) { content = ''; }
      if (/^\s*eula\s*=/mi.test(content)) {
        content = content.replace(/^(\s*eula\s*=\s*).*$/mi, '$1true');
      } else {
        if (content && !/\n$/.test(content)) content += '\n';
        content += 'eula=true\n';
      }
      await daemonLib.fileWrite(req.server.uuid, '/eula.txt', content);
      let result = null;
      try { result = await daemonLib.restartServer(req.server.uuid); } catch (_) {}
      let eulaStatus = (result && result.status) || 'starting';
      if (eulaStatus === 'not_created' || eulaStatus === 'offline') eulaStatus = 'starting';
      db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eulaStatus, req.server.id);
    } else {
      try { await daemonLib.stopServer(req.server.uuid); } catch (_) {}
      db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('offline', req.server.id);
    }
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/servers/:uuid/files', auth, serverAccess, can('files.read'), async (req, res) => {
  const dirPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : '/';
  try {
    const data = await daemonLib.fileList(req.server.uuid, dirPath);
    if (data && data.exists === false) {
      return res.status(404).json({ error: `Directory not found on disk: ${dirPath}` });
    }
    res.json({ data: (data && data.files) ? data.files : [], path: dirPath });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not load files from the node.' });
  }
});

router.get('/servers/:uuid/file', auth, serverAccess, can('files.write'), async (req, res) => {
  const filePath = String(req.query.path || '');
  if (!filePath) return res.status(400).json({ error: 'Path is required.' });
  if (isExecutable(filePath) || isCompressed(filePath)) return res.status(403).json({ error: 'This file type cannot be edited.' });
  try {
    const content = (await daemonLib.fileRead(req.server.uuid, filePath)).toString('utf8');
    res.json({ path: filePath, content });
  } catch (e) {
    if (e && e.status === 404) return res.status(404).json({ error: 'File not found.' });
    res.status(502).json({ error: e.message || 'Could not read file.' });
  }
});

router.post('/servers/:uuid/file', auth, serverAccess, can('files.write'), async (req, res) => {
  const { path: filePath, content, encoding } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'Path is required.' });
  if (isExecutable(filePath) || isCompressed(filePath)) return res.status(403).json({ error: 'This file type cannot be edited.' });
  let data = content;
  if (encoding === 'base64') {
    data = Buffer.from(String(content || ''), 'base64').toString('utf8');
  }
  try {
    await daemonLib.fileWrite(req.server.uuid, filePath, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not save file.' });
  }
});

router.post('/servers/:uuid/file/upload', auth, serverAccess, can('files.write'), express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
  const filePath = String(req.query.path || '');
  if (!filePath) return res.status(400).json({ error: 'Path is required.' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Empty upload body.' });
  }
  try {
    await daemonLib.fileUpload(req.server.uuid, filePath, req.body);
    res.json({ ok: true, size: req.body.length });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Upload failed.' });
  }
});

router.get('/servers/:uuid/file/download', auth, serverAccess, can('files.read'), async (req, res) => {
  const filePath = String(req.query.path || '');
  if (!filePath) return res.status(400).json({ error: 'Path is required.' });
  try {
    await daemonLib.fileDownload(req.server.uuid, filePath, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message || 'Download failed.' });
  }
});

router.post('/servers/:uuid/files/delete', auth, serverAccess, can('files.delete'), async (req, res) => {
  const files = Array.isArray(req.body && req.body.paths) ? req.body.paths : [];
  if (files.length === 0) return res.status(400).json({ error: 'No files selected.' });
  try {
    for (const file of files) await daemonLib.fileDelete(req.server.uuid, file);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Delete failed.' });
  }
});

router.post('/servers/:uuid/files/mkdir', auth, serverAccess, can('files.write'), async (req, res) => {
  const { dir, name } = req.body || {};
  const base = dir === '/' || !dir ? '' : dir;
  const remotePath = `${base}/${String(name || '').trim()}`.replace(/\/+/g, '/');
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Name is required.' });
  try {
    await daemonLib.fileMkdir(req.server.uuid, remotePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not create folder.' });
  }
});

router.post('/servers/:uuid/files/rename', auth, serverAccess, can('files.write'), async (req, res) => {
  const { file, name } = req.body || {};
  if (!file || !name) return res.status(400).json({ error: 'File and new name are required.' });
  try {
    await daemonLib.fileRename(req.server.uuid, file, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Rename failed.' });
  }
});

router.post('/servers/:uuid/files/move', auth, serverAccess, can('files.write'), async (req, res) => {
  const files = Array.isArray(req.body && req.body.paths) ? req.body.paths : [];
  const toDir = (req.body && req.body.toDir) || '/';
  if (files.length === 0) return res.status(400).json({ error: 'No files selected.' });
  try {
    for (const file of files) await daemonLib.fileMove(req.server.uuid, file, toDir);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Move failed.' });
  }
});

router.post('/servers/:uuid/files/permissions', auth, serverAccess, can('files.write'), async (req, res) => {
  const { file, mode } = req.body || {};
  if (!file || !mode) return res.status(400).json({ error: 'File and mode are required.' });
  try {
    await daemonLib.fileChmod(req.server.uuid, file, mode);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Chmod failed.' });
  }
});

router.post('/servers/:uuid/files/duplicate', auth, serverAccess, can('files.write'), async (req, res) => {
  const { file } = req.body || {};
  if (!file) return res.status(400).json({ error: 'File is required.' });
  const redirectDir = path.posix.dirname(file) || '/';
  try {
    let copyName = `${path.posix.basename(file)} - copy`;
    try {
      const listing = await daemonLib.fileList(req.server.uuid, redirectDir);
      const names = new Set(((listing && listing.files) || []).map((f) => f.name));
      if (names.has(copyName)) {
        let i = 2;
        while (names.has(`${path.posix.basename(file)} - copy ${i}`)) i += 1;
        copyName = `${path.posix.basename(file)} - copy ${i}`;
      }
    } catch (_) {}
    await daemonLib.fileCopy(req.server.uuid, file, copyName);
    res.json({ ok: true, name: copyName });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Duplicate failed.' });
  }
});

router.post('/servers/:uuid/files/archive', auth, serverAccess, can('files.write'), async (req, res) => {
  const files = Array.isArray(req.body && req.body.paths) ? req.body.paths : [];
  if (files.length === 0) return res.status(400).json({ error: 'No files selected.' });
  try {
    for (const file of files) await daemonLib.fileCompress(req.server.uuid, file);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Archive failed.' });
  }
});

router.post('/servers/:uuid/files/extract', auth, serverAccess, can('files.write'), async (req, res) => {
  const file = req.body && req.body.file;
  if (!file) return res.status(400).json({ error: 'File is required.' });
  try {
    await daemonLib.fileExtract(req.server.uuid, file);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Extract failed.' });
  }
});

router.get('/servers/:uuid/databases', auth, serverAccess, can('databases.view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM databases WHERE server_id = ?').all(req.server.id);
  res.json({ data: rows, limit: Number(req.server.database_limit) || 0 });
});

router.post('/servers/:uuid/databases', auth, serverAccess, can('databases.create'), (req, res) => {
  const name = String((req.body && req.body.name) || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!name) return res.status(400).json({ error: 'Database name is required.' });
  const dbName = `s${req.server.id}_${name}`;
  const dbUser = `u${Math.random().toString(36).substring(2, 10)}`;
  const dbPass = crypto.randomBytes(16).toString('hex');
  try {
    db.prepare('INSERT INTO databases (server_id, name, username, password) VALUES (?, ?, ?, ?)').run(req.server.id, dbName, dbUser, dbPass);
    try { db.save(); } catch (_) {}
    res.json({ ok: true, database: { name: dbName, username: dbUser, password: dbPass } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:uuid/databases/delete', auth, serverAccess, can('databases.delete'), (req, res) => {
  const { databaseId } = req.body || {};
  db.prepare('DELETE FROM databases WHERE id = ? AND server_id = ?').run(databaseId, req.server.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.get('/servers/:uuid/backups', auth, serverAccess, can('backups.view'), (req, res) => {
  const backups = db.prepare('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC').all(req.server.id);
  for (const b of backups) b.size_text = formatBytes(b.size);
  res.json({ data: backups, limit: Number(req.server.backups_limit) || 0 });
});

router.post('/servers/:uuid/backups', auth, serverAccess, can('backups.create'), async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim() || `backup-${Date.now()}`;
  const ignored = String((req.body && req.body.ignored) || '').trim();
  const locked = req.body && req.body.locked ? 1 : 0;
  const backupFile = `${req.server.uuid}-${Date.now()}.zip`;
  const backupPath = path.join(backupsDir, backupFile);
  try {
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const size = await daemonLib.backupServer(req.server.uuid, ignored, backupPath);
    db.prepare('INSERT INTO backups (server_id, name, file, size, ignored_files, locked) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.server.id, name, backupFile, size || 0, ignored || null, locked);
    try { db.save(); } catch (_) {}
    const row = db.prepare('SELECT * FROM backups WHERE server_id = ? AND file = ?').get(req.server.id, backupFile);
    res.json({ ok: true, data: row });
  } catch (e) {
    try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:uuid/backups/:id/lock', auth, serverAccess, can('backups.create'), (req, res) => {
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(req.params.id, req.server.id);
  if (!backup) return res.status(404).json({ error: 'Backup not found.' });
  db.prepare('UPDATE backups SET locked = ? WHERE id = ?').run(backup.locked ? 0 : 1, backup.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true, locked: !backup.locked });
});

router.post('/servers/:uuid/backups/:id/delete', auth, serverAccess, can('backups.delete'), (req, res) => {
  const { password } = req.body || {};
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(req.params.id, req.server.id);
  if (!backup) return res.status(404).json({ error: 'Backup not found.' });
  if (backup.locked) return res.status(409).json({ error: 'Backup is locked.' });
  if (!password || !bcrypt.compareSync(String(password), req.user.password)) {
    return res.status(401).json({ error: 'Password is incorrect.' });
  }
  if (backup.file) {
    try { fs.unlinkSync(path.join(backupsDir, backup.file)); } catch (_) {}
  }
  db.prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/servers/:uuid/backups/:id/restore', auth, serverAccess, can('backups.restore'), async (req, res) => {
  const { password } = req.body || {};
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(req.params.id, req.server.id);
  if (!backup || !backup.file) return res.status(404).json({ error: 'Backup not found.' });
  if (!password || !bcrypt.compareSync(String(password), req.user.password)) {
    return res.status(401).json({ error: 'Password is incorrect.' });
  }
  const bp = path.join(backupsDir, backup.file);
  if (!fs.existsSync(bp)) return res.status(404).json({ error: 'Backup file is missing on disk.' });
  try {
    let wasRunning = false;
    try { wasRunning = (await daemonLib.getServerStatus(req.server.uuid)) === 'running'; } catch (_) {}
    if (wasRunning) await daemonLib.stopServer(req.server.uuid);
    await daemonLib.restoreBackup(req.server.uuid, bp);
    if (wasRunning && !req.server.suspended) {
      try { await daemonLib.startServer(req.server.uuid); } catch (_) {}
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/servers/:uuid/backups/:id/download', auth, serverAccess, can('backups.view'), (req, res) => {
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(req.params.id, req.server.id);
  if (!backup || !backup.file) return res.status(404).json({ error: 'Backup not found.' });
  const bp = path.join(backupsDir, backup.file);
  if (!fs.existsSync(bp)) return res.status(404).json({ error: 'Backup file is missing on disk.' });
  const safeName = (backup.name || 'backup').replace(/[^a-zA-Z0-9._-]+/g, '_');
  res.download(bp, `${safeName}.zip`);
});

function loadEggForServer(server) {
  return server.egg_id ? db.prepare('SELECT * FROM eggs WHERE id = ?').get(server.egg_id) : null;
}

function eggImageList(egg) {
  const out = [];
  if (!egg) return out;
  try {
    const parsed = JSON.parse(egg.docker_images || '');
    if (Array.isArray(parsed)) {
      for (const img of parsed) {
        const ref = typeof img === 'string' ? img : img && img.image;
        if (ref) out.push({ image: ref, label: (img && typeof img === 'object' && img.label) || null });
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const [ref, label] of Object.entries(parsed)) out.push({ image: ref, label: typeof label === 'string' ? label : null });
    }
  } catch (_) {}
  if (out.length === 0 && egg.docker_image) out.push({ image: egg.docker_image, label: null });
  return out;
}

router.get('/servers/:uuid/startup', auth, serverAccess, can('startup.view'), (req, res) => {
  const egg = loadEggForServer(req.server);
  let variables = [];
  if (egg) {
    variables = db.prepare('SELECT * FROM egg_variables WHERE egg_id = ? ORDER BY sort_order, id').all(egg.id)
      .filter(v => v.user_viewable);
    for (const v of variables) {
      const cur = db.prepare('SELECT value FROM server_variables WHERE server_id = ? AND env_var = ?').get(req.server.id, v.env_var);
      v.current_value = cur ? cur.value : v.default_value;
    }
  }
  const startupCommand = req.server.startup_command || (egg ? egg.startup : '') || '';
  res.json({
    egg: egg ? { id: egg.id, name: egg.name } : null,
    variables,
    startup_command: startupCommand,
    egg_images: eggImageList(egg),
    current_image: req.server.image || null,
    can_edit: req.perms === null || req.perms === undefined || req.perms.includes('startup.edit'),
  });
});

router.post('/servers/:uuid/startup', auth, serverAccess, can('startup.edit'), (req, res) => {
  const egg = loadEggForServer(req.server);
  const vars = (req.body && req.body.vars) || {};
  if (egg) {
    const eggVars = db.prepare('SELECT * FROM egg_variables WHERE egg_id = ?').all(egg.id);
    for (const v of eggVars) {
      if (!v.user_editable) continue;
      const val = vars[v.env_var];
      if (val === undefined) continue;
      const existing = db.prepare('SELECT id FROM server_variables WHERE server_id = ? AND env_var = ?').get(req.server.id, v.env_var);
      if (existing) db.prepare('UPDATE server_variables SET value = ? WHERE id = ?').run(val, existing.id);
      else db.prepare('INSERT INTO server_variables (server_id, env_var, value) VALUES (?, ?, ?)').run(req.server.id, v.env_var, val);
    }
  }
  const image = req.body && req.body.image;
  if (image) db.prepare('UPDATE servers SET image = ? WHERE id = ?').run(image, req.server.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.get('/servers/:uuid/schedules', auth, serverAccess, can('schedules.view'), (req, res) => {
  const tasks = db.prepare('SELECT * FROM schedule_tasks WHERE server_id = ?').all(req.server.id);
  res.json({ data: tasks });
});

router.post('/servers/:uuid/schedules', auth, serverAccess, can('schedules.manage'), (req, res) => {
  const { action, cron } = req.body || {};
  if (!action || !cron) return res.status(400).json({ error: 'Action and cron expression are required.' });
  db.prepare('INSERT INTO schedule_tasks (server_id, action, cron) VALUES (?, ?, ?)').run(req.server.id, action, cron);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/servers/:uuid/schedules/delete', auth, serverAccess, can('schedules.manage'), (req, res) => {
  const { taskId } = req.body || {};
  db.prepare('DELETE FROM schedule_tasks WHERE id = ? AND server_id = ?').run(taskId, req.server.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.get('/servers/:uuid/settings', auth, serverAccess, can('settings.view'), async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.server.node_id);
  const sftpPort = (node && node.sftp_port) || 2022;
  if (!req.server.sftp_password) {
    const password = crypto.randomBytes(18).toString('base64url');
    db.prepare('UPDATE servers SET sftp_password = ? WHERE id = ?').run(password, req.server.id);
    req.server.sftp_password = password;
    try { db.save(); } catch (_) {}
    daemonLib.setSftpPassword(req.server.uuid, password).catch(() => {});
  }
  const stats = await daemonLib.getServerStatsSafe(req.server.uuid, 2500);
  res.json({
    name: req.server.name,
    description: req.server.description || '',
    sftp: {
      address: `sftp://${(node && node.fqdn) || 'localhost'}:${sftpPort}`,
      username: req.server.uuid,
      password: req.server.sftp_password,
    },
    container_id: stats && stats.containerId ? stats.containerId : null,
    install_status: req.server.install_status,
    install_error: req.server.install_error || null,
    is_owner: req.isOwner,
  });
});

router.post('/servers/:uuid/settings', auth, serverAccess, (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the server owner can do this.' });
  const { name, description } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
  db.prepare('UPDATE servers SET name=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, description || '', req.server.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/servers/:uuid/sftp/regenerate', auth, serverAccess, (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the server owner can do this.' });
  const password = crypto.randomBytes(18).toString('base64url');
  db.prepare('UPDATE servers SET sftp_password = ? WHERE id = ?').run(password, req.server.id);
  daemonLib.setSftpPassword(req.server.uuid, password).catch(() => {});
  try { db.save(); } catch (_) {}
  res.json({ ok: true, password });
});

router.post('/servers/:uuid/reinstall', auth, serverAccess, (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the server owner can do this.' });
  const serverId = req.server.id;
  const uuid = req.server.uuid;
  db.prepare('UPDATE servers SET install_status = "installing", install_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(serverId);
  (async () => {
    try {
      await daemonLib.removeServer(uuid).catch(() => {});
      await daemonLib.installServer(uuid);
      db.prepare('UPDATE servers SET install_status = "installed", install_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(serverId);
    } catch (e) {
      db.prepare('UPDATE servers SET install_status = "install_failed", install_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(String(e.message).slice(0, 500), serverId);
    }
    try { db.save(); } catch (_) {}
  })();
  res.json({ ok: true });
});

router.get('/servers/:uuid/users', auth, serverAccess, (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the server owner can manage users.' });
  const rows = db.prepare(`
    SELECT su.id, su.permissions, su.created_at, u.username, u.email
    FROM subusers su
    JOIN users u ON su.user_id = u.id
    WHERE su.server_id = ?
    ORDER BY su.created_at ASC
  `).all(req.server.id);
  for (const row of rows) row.permissions = parsePermissions(row.permissions);
  res.json({ data: rows, permission_groups: PERMISSION_GROUPS });
});

router.post('/servers/:uuid/users', auth, serverAccess, (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the server owner can manage users.' });
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const permissions = sanitizePermissions(req.body && req.body.permissions);
  const target = email ? db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email) : null;
  if (!target) return res.status(404).json({ error: 'No account with that email was found.' });
  if (target.id === req.server.user_id) return res.status(409).json({ error: 'That user already owns this server.' });
  if (permissions.length === 0) return res.status(400).json({ error: 'Select at least one permission.' });

  const existing = db.prepare('SELECT id FROM subusers WHERE server_id = ? AND user_id = ?').get(req.server.id, target.id);
  if (existing) {
    db.prepare('UPDATE subusers SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), existing.id);
  } else {
    db.prepare('INSERT INTO subusers (server_id, user_id, permissions) VALUES (?, ?, ?)').run(req.server.id, target.id, JSON.stringify(permissions));
  }
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/servers/:uuid/users/:subId/update', auth, serverAccess, (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the server owner can manage users.' });
  const sub = db.prepare('SELECT * FROM subusers WHERE id = ? AND server_id = ?').get(req.params.subId, req.server.id);
  if (!sub) return res.status(404).json({ error: 'User not found on this server.' });
  const permissions = sanitizePermissions(req.body && req.body.permissions);
  if (permissions.length === 0) return res.status(400).json({ error: 'Select at least one permission.' });
  db.prepare('UPDATE subusers SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), sub.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/servers/:uuid/users/:subId/delete', auth, serverAccess, (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the server owner can manage users.' });
  db.prepare('DELETE FROM subusers WHERE id = ? AND server_id = ?').run(req.params.subId, req.server.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.use('/admin', auth, adminOnly);

router.get('/admin/overview', (req, res) => {
  const count = (q) => { try { return db.prepare(q).get().c; } catch (_) { return 0; } };
  res.json({
    counts: {
      users: count('SELECT COUNT(*) as c FROM users'),
      servers: count('SELECT COUNT(*) as c FROM servers'),
      nodes: count('SELECT COUNT(*) as c FROM nodes'),
      locations: count('SELECT COUNT(*) as c FROM locations'),
      eggs: count('SELECT COUNT(*) as c FROM eggs'),
      nests: count('SELECT COUNT(*) as c FROM nests'),
      allocations: count('SELECT COUNT(*) as c FROM allocations'),
      used_allocations: count('SELECT COUNT(*) as c FROM allocations WHERE server_id IS NOT NULL'),
      memory: count('SELECT COALESCE(SUM(memory),0) as c FROM servers'),
      disk: count('SELECT COALESCE(SUM(disk),0) as c FROM servers'),
    },
    recent_users: db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 5').all().map(publicUser),
    recent_servers: db.prepare(`
      SELECT s.id, s.uuid, s.name, s.status, s.memory, s.disk, s.created_at, u.username, n.name as node_name
      FROM servers s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN nodes n ON s.node_id = n.id
      ORDER BY s.created_at DESC LIMIT 5
    `).all(),
  });
});

router.get('/admin/users', (req, res) => {
  const search = String(req.query.search || '').trim();
  let users;
  if (search) {
    users = db.prepare('SELECT * FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY created_at DESC').all(`%${search}%`, `%${search}%`);
  } else {
    users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  }
  res.json({ data: users.map(publicUser) });
});

router.post('/admin/users', (req, res) => {
  const { username, email, password, root_admin } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'Username, email and password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(String(email).trim(), String(username).trim());
  if (exists) return res.status(409).json({ error: 'Username or email is already in use.' });
  db.prepare('INSERT INTO users (uuid, username, email, password, root_admin) VALUES (?, ?, ?, ?, ?)').run(
    uuidv4(), String(username).trim(), String(email).trim(), bcrypt.hashSync(String(password), 10), root_admin ? 1 : 0
  );
  try { db.save(); } catch (_) {}
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND email = ?').get(String(username).trim(), String(email).trim());
  res.json({ ok: true, user: publicUser(user) });
});

router.get('/admin/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const servers = db.prepare('SELECT s.*, n.name as node_name FROM servers s LEFT JOIN nodes n ON s.node_id = n.id WHERE s.user_id = ?').all(user.id);
  const apiKeys = db.prepare('SELECT id, memo, last_used_at, created_at FROM api_keys WHERE user_id = ?').all(user.id);
  res.json({ user: publicUser(user), servers, api_keys: apiKeys });
});

router.post('/admin/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { username, email, password, root_admin } = req.body || {};
  if (!username || !email) return res.status(400).json({ error: 'Username and email are required.' });
  try {
    if (password && String(password).length > 0) {
      if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      db.prepare('UPDATE users SET username=?, email=?, password=?, root_admin=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
        username, email, bcrypt.hashSync(String(password), 10), root_admin ? 1 : 0, user.id
      );
    } else {
      db.prepare('UPDATE users SET username=?, email=?, root_admin=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
        username, email, root_admin ? 1 : 0, user.id
      );
    }
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'Username or email is already in use.' });
  }
});

router.post('/admin/users/:id/delete', (req, res) => {
  if (parseInt(req.params.id, 10) === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

function adminServerOptions() {
  return {
    users: db.prepare('SELECT id, username, email FROM users ORDER BY username').all(),
    nodes: db.prepare('SELECT id, name FROM nodes ORDER BY name').all(),
    eggs: db.prepare('SELECT id, name, nest_id, docker_image, startup FROM eggs ORDER BY name').all(),
    nests: db.prepare('SELECT id, name FROM nests ORDER BY name').all(),
    allocations: db.prepare(`
      SELECT a.*, n.name as node_name FROM allocations a LEFT JOIN nodes n ON a.node_id = n.id
      WHERE a.server_id IS NULL ORDER BY a.ip, a.port LIMIT 1000
    `).all(),
  };
}

router.get('/admin/servers', (req, res) => {
  const search = String(req.query.search || '').trim();
  let servers;
  const base = `
    SELECT s.*, u.username, n.name as node_name, e.name as egg_name
    FROM servers s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN nodes n ON s.node_id = n.id LEFT JOIN eggs e ON s.egg_id = e.id
  `;
  if (search) {
    servers = db.prepare(`${base} WHERE s.name LIKE ? OR u.username LIKE ? OR s.uuid LIKE ? ORDER BY s.created_at DESC`)
      .all(`%${search}%`, `%${search}%`, `%${search}%`);
  } else {
    servers = db.prepare(`${base} ORDER BY s.created_at DESC`).all();
  }
  for (const s of servers) delete s.sftp_password;
  res.json({ data: servers, options: adminServerOptions() });
});

router.post('/admin/servers', async (req, res) => {
  const { user_id, node_id, allocation_id, name, description, egg_id, memory, swap, disk, cpu, io, database_limit, backups_limit, startup, image } = req.body || {};
  if (!user_id || !node_id || !name) return res.status(400).json({ error: 'Owner, node and name are required.' });
  const serverUuid = uuidv4();
  const sftpPassword = crypto.randomBytes(18).toString('base64url');
  const egg = egg_id ? db.prepare('SELECT * FROM eggs WHERE id = ?').get(egg_id) : null;
  let provision = null;
  try {
    const result = db.prepare(`INSERT INTO servers (uuid, user_id, node_id, allocation_id, name, description, egg_id, image, startup_command, memory, swap, disk, cpu, io, database_limit, backups_limit, sftp_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      serverUuid, user_id, node_id, allocation_id || null, name, description || '',
      egg_id || null, image || (egg ? egg.docker_image : null), startup || (egg ? egg.startup : ''),
      grab(memory, 1024), grab(swap, 0), grab(disk, 10240),
      grab(cpu, 100), grab(io, 500), grab(database_limit, 0), grab(backups_limit, 3),
      sftpPassword
    );
    if (allocation_id) {
      db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(result.lastInsertRowid, allocation_id);
    }
    try { db.save(); } catch (_) {}
    try {
      await daemonLib.createServer(serverUuid);
      provision = { ok: true };
    } catch (e) {
      provision = { ok: false, error: e.message };
    }
    if (daemonLib.getInstallSpec(egg)) {
      db.prepare('UPDATE servers SET install_status = ?, install_error = NULL WHERE id = ?').run('installing', result.lastInsertRowid);
      daemonLib.installServer(serverUuid).then(() => {
        db.prepare('UPDATE servers SET install_status = ? WHERE id = ?').run('installed', result.lastInsertRowid);
      }).catch((e) => {
        db.prepare('UPDATE servers SET install_status = ?, install_error = ? WHERE id = ?').run('install_failed', String(e.message).slice(0, 500), result.lastInsertRowid);
      });
    }
    const created = db.prepare('SELECT * FROM servers WHERE id = ?').get(result.lastInsertRowid);
    res.json({ ok: true, server: created, provision });
  } catch (e) {
    res.status(500).json({ error: e.message, provision });
  }
});

router.get('/admin/servers/:id', (req, res) => {
  const srv = db.prepare(`
    SELECT s.*, u.username, u.email as user_email, n.name as node_name, e.name as egg_name,
      a.ip as alloc_ip, a.port as alloc_port
    FROM servers s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN nodes n ON s.node_id = n.id
    LEFT JOIN eggs e ON s.egg_id = e.id
    LEFT JOIN allocations a ON s.allocation_id = a.id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!srv) return res.status(404).json({ error: 'Server not found.' });

  const freeAllocs = db.prepare('SELECT a.*, n.name as node_name FROM allocations a LEFT JOIN nodes n ON a.node_id = n.id WHERE a.server_id IS NULL OR a.server_id = ? ORDER BY a.ip, a.port LIMIT 500').all(srv.id);
  const srvAllocs = db.prepare('SELECT a.*, n.name as node_name FROM allocations a LEFT JOIN nodes n ON a.node_id = n.id WHERE a.server_id = ? ORDER BY a.ip, a.port').all(srv.id);
  const databases = db.prepare('SELECT * FROM databases WHERE server_id = ?').all(srv.id);

  let eggVars = [];
  if (srv.egg_id) {
    eggVars = db.prepare('SELECT * FROM egg_variables WHERE egg_id = ? ORDER BY sort_order, id').all(srv.egg_id);
    for (const v of eggVars) {
      const cur = db.prepare('SELECT value FROM server_variables WHERE server_id = ? AND env_var = ?').get(srv.id, v.env_var);
      v.current_value = cur ? cur.value : v.default_value;
    }
  }

  const memAlloc = db.prepare('SELECT COALESCE(SUM(memory),0) as c FROM servers WHERE node_id = ?').get(srv.node_id).c;
  const diskAlloc = db.prepare('SELECT COALESCE(SUM(disk),0) as c FROM servers WHERE node_id = ?').get(srv.node_id).c;

  res.json({
    server: srv,
    options: adminServerOptions(),
    free_allocations: freeAllocs,
    server_allocations: srvAllocs,
    databases,
    egg_variables: eggVars,
    node_mem_allocated: memAlloc,
    node_disk_allocated: diskAlloc,
  });
});

router.post('/admin/servers/:id/details', (req, res) => {
  const { name, description, user_id, node_id, allocation_id } = req.body || {};
  if (!name || !user_id || !node_id) return res.status(400).json({ error: 'Name, owner and node are required.' });
  try {
    db.prepare('UPDATE servers SET name=?, description=?, user_id=?, node_id=?, allocation_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
      name, description || '', user_id, node_id, allocation_id || null, req.params.id
    );
    if (allocation_id) db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(req.params.id, allocation_id);
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/build', (req, res) => {
  const { memory, swap, disk, cpu, io, database_limit, backups_limit } = req.body || {};
  db.prepare('UPDATE servers SET memory=?, swap=?, disk=?, cpu=?, io=?, database_limit=?, backups_limit=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
    grab(memory, 0), grab(swap, 0), grab(disk, 0), grab(cpu, 0),
    grab(io, 0), grab(database_limit, 0), grab(backups_limit, 0), req.params.id
  );
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/admin/servers/:id/startup', (req, res) => {
  const { startup, image, egg_id, vars } = req.body || {};
  try {
    db.prepare('UPDATE servers SET startup_command=?, image=?, egg_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
      startup || '', image || null, egg_id || null, req.params.id
    );
    if (egg_id) {
      const egg = db.prepare('SELECT * FROM eggs WHERE id = ?').get(egg_id);
      if (egg && !image) db.prepare('UPDATE servers SET image=? WHERE id=?').run(egg.docker_image, req.params.id);
    }
    const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (srv && srv.egg_id && vars) {
      const eggVars = db.prepare('SELECT * FROM egg_variables WHERE egg_id = ?').all(srv.egg_id);
      for (const v of eggVars) {
        const val = vars[v.env_var];
        if (val === undefined) continue;
        const existing = db.prepare('SELECT id FROM server_variables WHERE server_id = ? AND env_var = ?').get(srv.id, v.env_var);
        if (existing) db.prepare('UPDATE server_variables SET value = ? WHERE id = ?').run(val, existing.id);
        else db.prepare('INSERT INTO server_variables (server_id, env_var, value) VALUES (?, ?, ?)').run(srv.id, v.env_var, val);
      }
    }
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/network/assign', (req, res) => {
  const { allocation_id } = req.body || {};
  try {
    const alloc = db.prepare('SELECT * FROM allocations WHERE id = ?').get(allocation_id);
    if (alloc && (!alloc.server_id || alloc.server_id == req.params.id)) {
      db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(req.params.id, allocation_id);
      try { db.save(); } catch (_) {}
      return res.json({ ok: true });
    }
    res.status(409).json({ error: 'Allocation is already in use.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/network/primary', (req, res) => {
  const { allocation_id } = req.body || {};
  try {
    db.prepare('UPDATE servers SET allocation_id = ? WHERE id = ?').run(allocation_id, req.params.id);
    db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(req.params.id, allocation_id);
    db.prepare('UPDATE allocations SET server_id = NULL WHERE server_id = ? AND id <> ?').run(req.params.id, allocation_id);
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/network/:allocId/unassign', (req, res) => {
  db.prepare('UPDATE allocations SET server_id = NULL WHERE id = ? AND server_id = ?').run(req.params.allocId, req.params.id);
  const srv = db.prepare('SELECT allocation_id FROM servers WHERE id = ?').get(req.params.id);
  if (srv && srv.allocation_id == req.params.allocId) {
    db.prepare('UPDATE servers SET allocation_id = NULL WHERE id = ?').run(req.params.id);
  }
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/admin/servers/:id/databases', (req, res) => {
  const { name, username, password, host, port } = req.body || {};
  try {
    const srv = db.prepare('SELECT database_limit FROM servers WHERE id = ?').get(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Server not found.' });
    const dbCount = db.prepare('SELECT COUNT(*) as c FROM databases WHERE server_id = ?').get(req.params.id).c;
    if (srv.database_limit <= 0 || dbCount >= srv.database_limit) {
      return res.status(409).json({ error: 'Database limit reached for this server.' });
    }
    db.prepare('INSERT INTO databases (server_id, name, username, password, host, port) VALUES (?, ?, ?, ?, ?, ?)').run(
      req.params.id, name, username, password, host || '127.0.0.1', port || 3306
    );
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/databases/:dbId/delete', (req, res) => {
  db.prepare('DELETE FROM databases WHERE id = ? AND server_id = ?').run(req.params.dbId, req.params.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/admin/servers/:id/reinstall', (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!srv) return res.status(404).json({ error: 'Server not found.' });
  db.prepare('UPDATE servers SET status = ?, install_status = ?, install_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('installing', 'installing', srv.id);
  (async () => {
    try {
      await daemonLib.removeServer(srv.uuid).catch(() => {});
      await daemonLib.installServer(srv.uuid);
      db.prepare('UPDATE servers SET install_status = ?, install_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('installed', srv.id);
    } catch (e) {
      db.prepare('UPDATE servers SET install_status = ?, install_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('install_failed', String(e.message).slice(0, 500), srv.id);
    }
    try { db.save(); } catch (_) {}
  })();
  res.json({ ok: true });
});

router.post('/admin/servers/:id/transfer', async (req, res) => {
  const { node_id } = req.body || {};
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!srv) return res.status(404).json({ error: 'Server not found.' });
  if (!node_id || node_id == srv.node_id) return res.status(400).json({ error: 'Pick a different node.' });
  try {
    db.prepare('UPDATE servers SET node_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(node_id, srv.id);
    const freeAlloc = db.prepare('SELECT * FROM allocations WHERE node_id = ? AND server_id IS NULL ORDER BY id LIMIT 1').get(node_id);
    if (freeAlloc) db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(srv.id, freeAlloc.id);
    await daemonLib.removeServer(srv.uuid).catch(() => {});
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/delete', async (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (srv) {
    try { await daemonLib.removeServer(srv.uuid); } catch (_) {}
    db.prepare('UPDATE allocations SET server_id = NULL WHERE server_id = ?').run(srv.id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(srv.id);
    try { db.save(); } catch (_) {}
  }
  res.json({ ok: true });
});

router.get('/admin/nodes', async (req, res) => {
  const nodes = db.prepare(`
    SELECT n.*, l.\`long\` as location_name,
      (SELECT COUNT(*) FROM servers WHERE node_id = n.id) as server_count,
      (SELECT COUNT(*) FROM allocations WHERE node_id = n.id) as allocation_count
    FROM nodes n LEFT JOIN locations l ON n.location_id = l.id ORDER BY n.name
  `).all();
  const locations = db.prepare('SELECT * FROM locations ORDER BY `long`').all();
  await Promise.all(nodes.map(async (n) => { n.online = await nodeOnline(n); }));
  res.json({ data: nodes, options: { locations } });
});

router.post('/admin/nodes', (req, res) => {
  const { location_id, name, fqdn, scheme, memory, disk, cpu, disk_overallocate, memory_overallocate, daemon_token, daemon_listen, sftp_port, daemon_type } = req.body || {};
  if (!location_id || !name || !fqdn) return res.status(400).json({ error: 'Location, name and FQDN are required.' });
  try {
    db.prepare(`INSERT INTO nodes (location_id, name, fqdn, scheme, memory, disk, cpu, disk_overallocate, memory_overallocate, daemon_token, daemon_listen, sftp_port, daemon_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      location_id, name, fqdn, scheme || 'https', grab(memory, 8192), grab(disk, 102400),
      grab(cpu, 8), grab(disk_overallocate, 0), grab(memory_overallocate, 0),
      daemon_token || uuidv4(), normalizeListen(daemon_listen), grab(sftp_port, 2022), daemon_type === 'oxlify' ? 'oxlify' : 'rubityle'
    );
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/nodes/:id', async (req, res) => {
  const node = db.prepare('SELECT n.*, l.`long` as location_name FROM nodes n LEFT JOIN locations l ON n.location_id = l.id WHERE n.id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found.' });
  node.daemon_listen = normalizeListen(node.daemon_listen);
  node.online = await nodeOnline(node);
  const locations = db.prepare('SELECT * FROM locations ORDER BY `long`').all();
  const allocations = db.prepare(`
    SELECT a.*, s.name as server_name, u.username AS server_owner
    FROM allocations a LEFT JOIN servers s ON a.server_id = s.id LEFT JOIN users u ON s.user_id = u.id
    WHERE a.node_id = ? ORDER BY a.ip, a.port
  `).all(node.id);
  const servers = db.prepare(`
    SELECT s.*, u.username, e.name as egg_name
    FROM servers s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN eggs e ON s.egg_id = e.id
    WHERE s.node_id = ? ORDER BY s.name
  `).all(node.id);
  const memAlloc = db.prepare('SELECT COALESCE(SUM(memory),0) as c FROM servers WHERE node_id = ?').get(node.id).c;
  const diskAlloc = db.prepare('SELECT COALESCE(SUM(disk),0) as c FROM servers WHERE node_id = ?').get(node.id).c;
  res.json({ node, allocations, servers, locations, mem_allocated: memAlloc, disk_allocated: diskAlloc });
});

router.post('/admin/nodes/:id', (req, res) => {
  const { location_id, name, fqdn, scheme, memory, disk, cpu, disk_overallocate, memory_overallocate, daemon_token, daemon_listen, sftp_port, daemon_type } = req.body || {};
  if (!location_id || !name || !fqdn) return res.status(400).json({ error: 'Location, name and FQDN are required.' });
  try {
    db.prepare(`UPDATE nodes SET location_id=?, name=?, fqdn=?, scheme=?, memory=?, disk=?, cpu=?, disk_overallocate=?, memory_overallocate=?, daemon_token=?, daemon_listen=?, sftp_port=?, daemon_type=? WHERE id=?`).run(
      location_id, name, fqdn, scheme || 'https', grab(memory, 0), grab(disk, 0), grab(cpu, 0),
      grab(disk_overallocate, 0), grab(memory_overallocate, 0), daemon_token, normalizeListen(daemon_listen), grab(sftp_port, 2022), daemon_type === 'oxlify' ? 'oxlify' : 'rubityle', req.params.id
    );
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/nodes/:id/delete', (req, res) => {
  const serverCount = db.prepare('SELECT COUNT(*) as c FROM servers WHERE node_id = ?').get(req.params.id).c;
  if (serverCount > 0) return res.status(409).json({ error: 'Move or delete this node\'s servers first.' });
  db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/admin/nodes/:id/allocations', (req, res) => {
  const { ip, ports } = req.body || {};
  if (!ip || !ports) return res.status(400).json({ error: 'IP and ports are required.' });
  const expanded = expandPorts(ports);
  if (expanded.length === 0) return res.status(400).json({ error: 'No valid ports in range.' });
  const stmt = db.prepare('INSERT OR IGNORE INTO allocations (node_id, ip, port) VALUES (?, ?, ?)');
  for (const port of expanded) stmt.run(req.params.id, ip, port);
  try { db.save(); } catch (_) {}
  res.json({ ok: true, added: expanded.length });
});

router.post('/admin/nodes/:id/allocations/:allocId/delete', (req, res) => {
  const result = db.prepare('DELETE FROM allocations WHERE id = ? AND node_id = ? AND server_id IS NULL').run(req.params.allocId, req.params.id);
  if (result.changes === 0) return res.status(409).json({ error: 'Allocation is in use or does not exist.' });
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.get('/admin/locations', (req, res) => {
  const locations = db.prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM nodes WHERE location_id = l.id) as node_count,
      (SELECT COUNT(*) FROM servers s JOIN nodes n ON s.node_id = n.id WHERE n.location_id = l.id) as server_count
    FROM locations l ORDER BY l.\`long\`
  `).all();
  res.json({ data: locations });
});

router.get('/admin/locations/:id', (req, res) => {
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const nodes = db.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM servers s WHERE s.node_id = n.id) as server_count
    FROM nodes n WHERE n.location_id = ? ORDER BY n.name
  `).all(loc.id);
  res.json({ location: loc, nodes });
});

router.post('/admin/locations', (req, res) => {
  const { short, long } = req.body || {};
  if (!short || !long) return res.status(400).json({ error: 'Short code and long name are required.' });
  try {
    db.prepare('INSERT INTO locations (short, `long`) VALUES (?, ?)').run(String(short).trim(), String(long).trim());
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/locations/:id', (req, res) => {
  const { short, long } = req.body || {};
  if (!short || !long) return res.status(400).json({ error: 'Short code and long name are required.' });
  db.prepare('UPDATE locations SET short = ?, `long` = ? WHERE id = ?').run(String(short).trim(), String(long).trim(), req.params.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/admin/locations/:id/delete', (req, res) => {
  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE location_id = ?').get(req.params.id).c;
  if (nodeCount > 0) return res.status(409).json({ error: 'Delete the nodes in this location first.' });
  db.prepare('DELETE FROM locations WHERE id = ?').run(req.params.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

const SETTINGS_KEYS = [
  'site_name', 'timezone', 'default_language', 'two_factor_auth',
  'smtp_host', 'smtp_port', 'smtp_encryption', 'smtp_username', 'smtp_from_email', 'smtp_from_name',
  'captcha_provider', 'cloudflare_turnstile_site_key', 'cloudflare_turnstile_secret_key',
  'hcaptcha_site_key', 'hcaptcha_secret_key', 'google_recaptcha_site_key', 'google_recaptcha_secret_key',
];

const SETTINGS_DEFAULTS = {
  site_name: 'Panel', timezone: 'UTC', default_language: 'en', two_factor_auth: 'None',
  smtp_host: '', smtp_port: '587', smtp_encryption: 'tls', smtp_username: '',
  smtp_from_email: '', smtp_from_name: 'Panel', captcha_provider: 'Disabled',
  cloudflare_turnstile_site_key: '', cloudflare_turnstile_secret_key: '',
  hcaptcha_site_key: '', hcaptcha_secret_key: '',
  google_recaptcha_site_key: '', google_recaptcha_secret_key: '',
};

router.get('/admin/settings', (req, res) => {
  const settings = {};
  for (const key of SETTINGS_KEYS) settings[key] = db.getSetting(key, SETTINGS_DEFAULTS[key]);
  settings.smtp_password_set = !!db.getSetting('smtp_password', '');
  res.json({ data: settings });
});

router.post('/admin/settings', (req, res) => {
  const body = req.body || {};
  for (const key of SETTINGS_KEYS) {
    if (body[key] === undefined) continue;
    if (key === 'two_factor_auth' && !['None', 'Admin Only', 'All Users'].includes(body[key])) continue;
    if (key === 'captcha_provider' && !['Disabled', 'Cloudflare Turnstile', 'HCaptcha', 'Google Recaptcha'].includes(body[key])) continue;
    db.setSetting(key, body[key] === '' ? SETTINGS_DEFAULTS[key] : body[key]);
  }
  if (body.smtp_password) db.setSetting('smtp_password', body.smtp_password);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.get('/admin/nests', (req, res) => {
  const nests = db.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM eggs WHERE nest_id = n.id) as egg_count,
      (SELECT COUNT(*) FROM servers s LEFT JOIN eggs e ON s.egg_id = e.id WHERE e.nest_id = n.id) as server_count,
      u.username as author
    FROM nests n LEFT JOIN users u ON n.author_id = u.id ORDER BY n.name
  `).all();
  res.json({ data: nests });
});

router.post('/admin/nests', (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nest name is required.' });
  db.prepare('INSERT INTO nests (uuid, author_id, name, description) VALUES (?, ?, ?, ?)').run(
    uuidv4(), req.user.id, name, description || ''
  );
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/admin/nests/:id/delete', (req, res) => {
  const eggCount = db.prepare('SELECT COUNT(*) as c FROM eggs WHERE nest_id = ?').get(req.params.id).c;
  if (eggCount > 0) return res.status(409).json({ error: 'Delete this nest\'s eggs first.' });
  db.prepare('DELETE FROM nests WHERE id = ?').run(req.params.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.get('/admin/eggs', (req, res) => {
  const nestFilter = req.query.nest ? parseInt(req.query.nest, 10) : null;
  let eggs;
  if (nestFilter) {
    eggs = db.prepare(`
      SELECT e.id, e.name, e.description, e.docker_image, e.startup, e.nest_id, e.author, n.name as nest_name,
        (SELECT COUNT(*) FROM servers WHERE egg_id = e.id) as server_count
      FROM eggs e LEFT JOIN nests n ON e.nest_id = n.id WHERE e.nest_id = ? ORDER BY e.name
    `).all(nestFilter);
  } else {
    eggs = db.prepare(`
      SELECT e.id, e.name, e.description, e.docker_image, e.startup, e.nest_id, e.author, n.name as nest_name,
        (SELECT COUNT(*) FROM servers WHERE egg_id = e.id) as server_count
      FROM eggs e LEFT JOIN nests n ON e.nest_id = n.id ORDER BY e.name
    `).all();
  }
  const nests = db.prepare('SELECT id, name FROM nests ORDER BY name').all();
  res.json({ data: eggs, options: { nests } });
});

router.post('/admin/eggs', (req, res) => {
  const { name, description, docker_image, startup, nest_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Egg name is required.' });
  try {
    const dockerImages = JSON.stringify(docker_image ? { [docker_image]: docker_image } : {});
    const result = db.prepare(`INSERT INTO eggs (name, description, docker_image, docker_images, startup, nest_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      String(name).trim(), description || '', docker_image || '', dockerImages, startup || '', nest_id || null
    );
    try { db.save(); } catch (_) {}
    const egg = db.prepare('SELECT * FROM eggs WHERE id = ?').get(result.lastInsertRowid);
    res.json({ ok: true, egg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/eggs/import', (req, res) => {
  const { egg: raw, nest_id } = req.body || {};
  if (!raw) return res.status(400).json({ error: 'Egg file content is required.' });
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  let eggData;
  try { eggData = parseEggJson(text); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    let nestId = nest_id || null;
    if (!nestId) {
      const nest = db.prepare('SELECT id FROM nests WHERE name = ?').get(eggData.name);
      nestId = nest
        ? nest.id
        : db.prepare('INSERT INTO nests (uuid, author_id, name, description) VALUES (?, ?, ?, ?)').run(
            uuidv4(), req.user.id, eggData.name, eggData.description || ''
          ).lastInsertRowid;
    }
    const result = db.prepare(`INSERT INTO eggs
      (name, description, docker_image, docker_images, startup, features, file_denylist, config, install_script, author, nest_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      eggData.name, eggData.description, eggData.docker_image, eggData.docker_images,
      eggData.startup, eggData.features, eggData.file_denylist, eggData.config,
      eggData.install_script, eggData.author, nestId
    );
    const varStmt = db.prepare(`INSERT INTO egg_variables
      (egg_id, name, description, env_var, default_value, user_viewable, user_editable, rules, sort_order, field_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const v of eggData.variables) {
      varStmt.run(result.lastInsertRowid, v.name, v.description, v.env_var, v.default_value, v.user_viewable, v.user_editable, v.rules, v.sort_order, v.field_type);
    }
    try { db.save(); } catch (_) {}
    const egg = db.prepare('SELECT * FROM eggs WHERE id = ?').get(result.lastInsertRowid);
    res.json({ ok: true, egg, variables: eggData.variables.length, nest_id: nestId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/eggs/:id', (req, res) => {
  const egg = db.prepare('SELECT e.*, n.name as nest_name FROM eggs e LEFT JOIN nests n ON e.nest_id = n.id WHERE e.id = ?').get(req.params.id);
  if (!egg) return res.status(404).json({ error: 'Egg not found.' });
  const nests = db.prepare('SELECT id, name FROM nests ORDER BY name').all();
  const variables = db.prepare('SELECT * FROM egg_variables WHERE egg_id = ? ORDER BY sort_order, id').all(egg.id);
  let eggImages = [];
  try { eggImages = Object.entries(JSON.parse(egg.docker_images || '{}')).map(([image, label]) => ({ image, label: typeof label === 'string' ? label : image })); } catch (_) {}
  res.json({ egg, variables, egg_images: eggImages, options: { nests } });
});

router.post('/admin/eggs/:id', (req, res) => {
  const { name, description, docker_image, startup, nest_id, author, features, file_denylist, config, install_script } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Egg name is required.' });
  try {
    const existing = db.prepare('SELECT * FROM eggs WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Egg not found.' });
    const dockerImages = (req.body && req.body.docker_images && String(req.body.docker_images).trim())
      || existing.docker_images
      || JSON.stringify({ [docker_image || '']: docker_image || '' });
    db.prepare(`UPDATE eggs SET name=?, description=?, docker_image=?, docker_images=?, startup=?, nest_id=?, author=?, features=?, file_denylist=?, config=?, install_script=? WHERE id=?`).run(
      name, description || '', docker_image || '', dockerImages, startup || '', nest_id || null,
      author || '', features || '[]', file_denylist || '[]',
      config || '{}', install_script || 'null', req.params.id
    );
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/eggs/:id/variables', (req, res) => {
  const { name, description, env_var, default_value, rules, user_viewable, user_editable, field_type } = req.body || {};
  if (!name || !env_var) return res.status(400).json({ error: 'Name and environment variable are required.' });
  try {
    db.prepare('INSERT INTO egg_variables (egg_id, name, description, env_var, default_value, rules, user_viewable, user_editable, field_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.params.id, name, description || '', env_var, default_value || '', rules || '',
      user_viewable ? 1 : 0, user_editable ? 1 : 0, field_type || ''
    );
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/eggs/:id/variables/:varId', (req, res) => {
  const { name, description, env_var, default_value, rules, sort_order, user_viewable, user_editable, field_type } = req.body || {};
  if (!name || !env_var) return res.status(400).json({ error: 'Name and environment variable are required.' });
  try {
    db.prepare('UPDATE egg_variables SET name=?, description=?, env_var=?, default_value=?, rules=?, sort_order=?, user_viewable=?, user_editable=?, field_type=? WHERE id=?').run(
      name, description || '', env_var, default_value || '', rules || '', sort_order || 0,
      user_viewable ? 1 : 0, user_editable ? 1 : 0, field_type || '', req.params.varId
    );
    try { db.save(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/eggs/:id/variables/:varId/delete', (req, res) => {
  db.prepare('DELETE FROM egg_variables WHERE id = ?').run(req.params.varId);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.post('/admin/eggs/:id/delete', (req, res) => {
  const serverCount = db.prepare('SELECT COUNT(*) as c FROM servers WHERE egg_id = ?').get(req.params.id).c;
  if (serverCount > 0) return res.status(409).json({ error: 'Delete this egg\'s servers first.' });
  db.prepare('DELETE FROM eggs WHERE id = ?').run(req.params.id);
  try { db.save(); } catch (_) {}
  res.json({ ok: true });
});

router.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

module.exports = router;
