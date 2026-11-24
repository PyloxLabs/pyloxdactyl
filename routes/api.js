const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { apiKeyAuth } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { authRequired } = require('../middleware/auth');
const daemonLib = require('../lib/daemon');

// Suspended servers expose nothing through the client API either, matching the
// locked-down panel overview.
function clientServerNotSuspended(req, res, next) {
  const server = db.prepare('SELECT suspended FROM servers WHERE uuid = ? AND user_id = ?').get(req.params.uuid, req.user.id);
  if (!server) return res.status(404).json({ error: (req.t && req.t('routes.api.serverNotFound')) || 'Server not found' });
  if (server.suspended) {
    return res.status(403).json({ error: (req.t && req.t('server.power.suspended')) || 'Server is suspended. Contact an administrator to unsuspend it.' });
  }
  next();
}

// Client API (requires API key)
router.get('/client', apiKeyAuth, (req, res) => {
  const servers = db.prepare(`
    SELECT s.*, n.name as node_name, n.fqdn, n.scheme, a.ip as allocation_ip, a.port as allocation_port
    FROM servers s
    LEFT JOIN nodes n ON s.node_id = n.id
    LEFT JOIN allocations a ON s.allocation_id = a.id
    WHERE s.user_id = ?
  `).all(req.user.id);
  res.json({ data: servers });
});

router.get('/client/server/:uuid', apiKeyAuth, clientServerNotSuspended, (req, res) => {
  const server = db.prepare(`
    SELECT s.*, n.name as node_name, n.fqdn, n.scheme, a.ip as allocation_ip, a.port as allocation_port
    FROM servers s
    LEFT JOIN nodes n ON s.node_id = n.id
    LEFT JOIN allocations a ON s.allocation_id = a.id
    WHERE s.uuid = ? AND s.user_id = ?
  `).get(req.params.uuid, req.user.id);
  if (!server) return res.status(404).json({ error: (req.t && req.t('routes.api.serverNotFound')) || 'Server not found' });
  res.json({ data: server });
});

router.post('/client/server/:uuid/power', apiKeyAuth, clientServerNotSuspended, async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE uuid = ? AND user_id = ?').get(req.params.uuid, req.user.id);
  if (!server) return res.status(404).json({ error: (req.t && req.t('routes.api.serverNotFound')) || 'Server not found' });
  if (server.suspended) return res.status(403).json({ error: (req.t && req.t('server.power.suspended')) || 'Server is suspended' });

  const { signal } = req.body;
  try {
    switch (signal) {
      case 'start': await daemonLib.startServer(server.uuid); break;
      case 'stop': await daemonLib.stopServer(server.uuid); break;
      case 'restart': await daemonLib.restartServer(server.uuid); break;
      case 'kill': await daemonLib.killServer(server.uuid); break;
      default: return res.status(400).json({ error: (req.t && req.t('routes.api.invalidSignal')) || 'Invalid signal' });
    }
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Server variables
router.get('/client/server/:uuid/variables', apiKeyAuth, clientServerNotSuspended, (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE uuid = ? AND user_id = ?').get(req.params.uuid, req.user.id);
  if (!server) return res.status(404).json({ error: (req.t && req.t('routes.api.serverNotFound')) || 'Server not found' });
  const variables = db.prepare('SELECT * FROM server_variables WHERE server_id = ?').all(server.id);
  res.json({ data: variables });
});

// Server databases
router.get('/client/server/:uuid/databases', apiKeyAuth, clientServerNotSuspended, (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE uuid = ? AND user_id = ?').get(req.params.uuid, req.user.id);
  if (!server) return res.status(404).json({ error: (req.t && req.t('routes.api.serverNotFound')) || 'Server not found' });
  const databases = db.prepare('SELECT id, name, username, host, port FROM databases WHERE server_id = ?').all(server.id);
  res.json({ data: databases });
});

// Server backups
router.get('/client/server/:uuid/backups', apiKeyAuth, clientServerNotSuspended, (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE uuid = ? AND user_id = ?').get(req.params.uuid, req.user.id);
  if (!server) return res.status(404).json({ error: (req.t && req.t('routes.api.serverNotFound')) || 'Server not found' });
  const backups = db.prepare('SELECT id, name, size, created_at FROM backups WHERE server_id = ?').all(server.id);
  res.json({ data: backups });
});

// Account API key management
router.get('/keys', authRequired, (req, res) => {
  const keys = db.prepare("SELECT id, memo, last_used_at, created_at FROM api_keys WHERE user_id = ? AND source IN ('user', 'mobile')").all(req.user.id);
  res.render('account/api-keys', { keys, token: null });
});

router.post('/keys/create', authRequired, (req, res) => {
  const { memo } = req.body;
  const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  db.prepare("INSERT INTO api_keys (user_id, token, memo, source, created_by) VALUES (?, ?, ?, 'user', ?)").run(req.user.id, token, memo || (req.t && req.t('routes.api.defaultApiKeyMemo')) || 'API Key', req.user.id);
  res.render('account/api-keys', { keys: db.prepare("SELECT id, memo, last_used_at, created_at FROM api_keys WHERE user_id = ? AND source IN ('user', 'mobile')").all(req.user.id), token });
});

router.post('/keys/:id/delete', authRequired, (req, res) => {
  db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ? AND source IN ('user', 'mobile')").run(req.params.id, req.user.id);
  res.redirect('/api/keys');
});

module.exports = router;