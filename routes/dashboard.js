const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const daemonLib = require('../lib/daemon');
const { authRequired } = require('../middleware/auth');

const DASH_SORTS = ['name-asc', 'name-desc', 'newest', 'oldest', 'status', 'memory', 'disk', 'cpu', 'custom'];

// Dashboard card order and the active sort are per-account settings kept in the
// panel database, so a reorder on one device shows up on every other device.
function loadDashPrefs(userId) {
  const prefs = { sort: null, orders: { mine: [], all: [] } };
  try {
    const raw = db.getUserSetting(userId, 'dashboard', '');
    if (!raw) return prefs;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return prefs;
    if (DASH_SORTS.indexOf(saved.sort) !== -1) prefs.sort = saved.sort;
    if (saved.orders && typeof saved.orders === 'object') {
      ['mine', 'all'].forEach((mode) => {
        if (Array.isArray(saved.orders[mode])) prefs.orders[mode] = saved.orders[mode].map(String);
      });
    }
  } catch (_) { /* corrupt setting: fall back to defaults */ }
  return prefs;
}

function saveDashPrefs(userId, prefs) {
  db.setUserSetting(userId, 'dashboard', JSON.stringify(prefs));
}

function listServers(showAll, userId) {
  const base = `
    SELECT s.*, u.username as owner_username, n.name as node_name, n.fqdn, n.scheme, a.ip as allocation_ip, a.port as allocation_port
    FROM servers s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN nodes n ON s.node_id = n.id
    LEFT JOIN allocations a ON s.allocation_id = a.id
  `;
  if (showAll) {
    return db.prepare(`${base} ORDER BY s.created_at DESC`).all();
  }
  // Owned servers plus any the user has been granted access to as a subuser.
  return db.prepare(`${base} WHERE s.user_id = ? OR EXISTS (SELECT 1 FROM subusers su WHERE su.server_id = s.id AND su.user_id = ?) ORDER BY s.created_at DESC`).all(userId, userId);
}

// Convert raw daemon stats into the resource shape the dashboard cards render.
function toResources(server, stats) {
  return {
    cpu: Math.round((Number(stats.cpu) || 0) * 10) / 10,
    mem_used: Math.round((Number(stats.memory) || 0) / 1024 / 1024),
    mem_limit: Number(server.memory) || 0,
    disk_used: Math.round((Number(stats.disk) || 0) / 1024 / 1024),
    disk_limit: Number(server.disk) || 0,
  };
}

// Query a server's daemon stats, giving up quickly so a slow or unreachable
// node can never stall the whole dashboard render.
function getStatsSafe(uuid, timeoutMs) {
  return daemonLib.getServerStatsSafe(uuid, timeoutMs || 2500);
}

// Attach live resource usage to each server by querying its node's daemon. The
// daemon also reports the authoritative status (it owns Docker), so we sync the
// DB row when it differs — this keeps the dashboard in step with the console
// when a server is stopped automatically (e.g. resource-limit enforcement).
async function withResources(servers) {
  return Promise.all(servers.map(async (s) => {
    const stats = await getStatsSafe(s.uuid);
    let live = stats && stats.status;
    if (live === 'not_created') live = 'offline';
    if (live && live !== s.status) {
      try { db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(live, s.id); } catch (_) { /* ignore */ }
      s.status = live;
    }
    return Object.assign({}, s, { res: toResources(s, stats) });
  }));
}

router.get('/', authRequired, async (req, res) => {
  const showAll = req.user.root_admin && req.query.all === '1';
  const servers = await withResources(listServers(showAll, req.user.id));
  const showServerDescription = db.getSetting ? db.getSetting('show_server_description', '1') !== '0' : true;
  res.render('dashboard', { servers, showAll, showServerDescription, dashPrefs: loadDashPrefs(req.user.id) });
});

router.get('/servers', authRequired, async (req, res) => {
  const showAll = req.user.root_admin && req.query.all === '1';
  const showServerDescription = db.getSetting ? db.getSetting('show_server_description', '1') !== '0' : true;
  res.json({
    servers: await withResources(listServers(showAll, req.user.id)),
    showAll,
    showServerDescription,
    dashPrefs: loadDashPrefs(req.user.id),
  });
});

router.get('/preferences', authRequired, (req, res) => {
  res.json(loadDashPrefs(req.user.id));
});

router.post('/preferences', authRequired, (req, res) => {
  const prefs = loadDashPrefs(req.user.id);
  const body = req.body || {};

  if (DASH_SORTS.indexOf(body.sort) !== -1) prefs.sort = body.sort;

  if ((body.mode === 'mine' || body.mode === 'all') && Array.isArray(body.order)) {
    const seen = new Set();
    const order = [];
    for (const value of body.order) {
      const id = String(value);
      if (!/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      if (order.length >= 2000) break;
    }
    prefs.orders[body.mode] = order;
  }

  saveDashPrefs(req.user.id, prefs);
  res.json({ ok: true, preferences: prefs });
});

// Lightweight polling endpoint that returns only live resource usage.
router.get('/stats', authRequired, async (req, res) => {
  const showAll = req.user.root_admin && req.query.all === '1';
  const servers = await withResources(listServers(showAll, req.user.id));
  res.json({ servers: servers.map((s) => Object.assign({ id: s.id, status: s.status }, s.res)) });
});

module.exports = router;
