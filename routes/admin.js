const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../lib/db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const daemonLib = require('../lib/daemon');
const mailer = require('../lib/mailer');
const baseurl = require('../lib/baseurl');
const extensions = require('../lib/extensions');

const eggUpload = multer({ dest: path.join(__dirname, '..', 'data', 'uploads') });
const brandUpload = multer({ dest: path.join(__dirname, '..', 'data', 'uploads') });
const extensionUpload = multer({
  dest: path.join(__dirname, '..', 'data', 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.use(authRequired, adminRequired);

function grab(v, def) {
  return (v === undefined || v === null || v === '') ? def : v;
}

function nonNegativeInt(v, def) {
  const n = parseInt(grab(v, def), 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// Docker images offered by an egg, as [{ image, label }].
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
      for (const [ref, label] of Object.entries(parsed)) {
        out.push({ image: ref, label: typeof label === 'string' ? label : null });
      }
    }
  } catch (_) { /* fall through to the legacy single image */ }
  if (out.length === 0 && egg.docker_image) out.push({ image: egg.docker_image, label: null });
  return out;
}

// Normalize the daemon listen address to just a port (default 8080)
function normalizeListen(v) {
  const s = (v === undefined || v === null) ? '' : String(v);
  return s.replace(/^0\.0\.0\.0:/, '').trim() || '8080';
}

const { parseEggJson } = require('../lib/egg-import');


// Query the daemon's /api/info endpoint to detect node resources (requires the daemon token)
function fetchNodeResources(node) {
  return new Promise((resolve) => {
    if (!node || !node.fqdn || !node.daemon_token) return resolve(null);
    const scheme = node.scheme || 'https';
    const listen = node.daemon_listen || '8080';
    const port = parseInt(String(listen).split(':').pop(), 10) || 8080;

    const lib = scheme === 'http' ? http : https;
    const req = lib.get({
      hostname: daemonLib.nodeHost(node),
      port,
      path: '/api/info',
      timeout: 4000,
      rejectUnauthorized: false,
      headers: { 'x-daemon-token': node.daemon_token },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const info = JSON.parse(body);
          resolve({
            memory_mb: Math.max(0, Math.floor((parseInt(info.total_memory, 10) || 0) / 1024 / 1024)),
            cpu_cores: parseInt(info.cpus, 10) || 0,
            disk_gb: Math.max(0, Math.floor((parseInt(info.total_disk, 10) || 0) / 1024 / 1024 / 1024)),
          });
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Update a node's stored resources from the daemon (called when the node is online)
async function syncNodeResources(node) {
  if (!node || !node.id) return;
  const detected = await fetchNodeResources(node);
  if (!detected) return;
  try {
    db.prepare('UPDATE nodes SET memory=?, cpu=?, disk=? WHERE id=?').run(
      detected.memory_mb, detected.cpu_cores, detected.disk_gb, node.id
    );
    node.memory = detected.memory_mb;
    node.cpu = detected.cpu_cores;
    node.disk = detected.disk_gb;
    console.log(`[admin] Detected resources for node ${node.id}: ${detected.memory_mb}MB / ${detected.cpu_cores} vcores / ${detected.disk_gb}GB`);
  } catch (e) {
    console.error('[admin] sync node resources:', e.message);
  }
}

// ── Node reachability cache ─────────────────────────────────────────
// Health is probed in the background and cached, so a page render never waits
// on an unreachable node. A failed probe is bounded by NODE_PROBE_TIMEOUT_MS,
// so a missing node fails fast instead of hanging until the browser gives up.
const NODE_PROBE_TIMEOUT_MS = 1500;  // per-request cap for /health and /api/info
const NODE_STATUS_TTL_MS = 10000;    // how long a health result is trusted
const NODE_RESOURCE_TTL_MS = 60000;  // how often host resources are re-detected

const nodeStatus = new Map();        // id -> { at, online }
const nodeProbes = new Map();        // id -> Promise<boolean> (in flight)
const nodeResourceSync = new Map();  // id -> last sync timestamp

// Ping the daemon's /health endpoint to determine if a node is actually reachable
function checkNodeHealth(node) {
  return new Promise((resolve) => {
    if (!node || !node.fqdn) return resolve(false);
    const scheme = node.scheme || 'https';
    const listen = node.daemon_listen || '8080';
    const bindPort = String(listen).split(':').pop();
    const port = parseInt(bindPort, 10) || 8080;

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

async function probeNode(node) {
  const online = await checkNodeHealth(node);
  nodeStatus.set(node.id, { at: Date.now(), online });
  return online;
}

// Re-detect a node's host resources at most once per TTL. Runs in the
// background: /api/info is slow (it asks Docker), so it must never sit on a
// page-render path. Triggered from the nodes pages, matching the previous
// behaviour of syncing when an admin looks at a node.
function syncNodeResourcesThrottled(node) {
  if (!node || !node.id) return;
  const last = nodeResourceSync.get(node.id) || 0;
  if (Date.now() - last < NODE_RESOURCE_TTL_MS) return;
  nodeResourceSync.set(node.id, Date.now());
  syncNodeResources(node).catch(() => {});
}

function refreshNode(node) {
  let probe = nodeProbes.get(node.id);
  if (!probe) {
    probe = probeNode(node).finally(() => nodeProbes.delete(node.id));
    nodeProbes.set(node.id, probe);
  }
  return probe;
}

// Cached node health. A stale value is returned immediately and refreshed in
// the background. A cold cache also returns immediately (reported offline)
// while the probe runs in the background, so a page render never waits even on
// the very first look at an unreachable node.
function nodeOnline(node) {
  const cached = nodeStatus.get(node.id);
  if (cached) {
    if (Date.now() - cached.at > NODE_STATUS_TTL_MS) refreshNode(node);
    return cached.online;
  }
  refreshNode(node);
  const pending = nodeStatus.get(node.id);
  return pending ? pending.online : false;
}

// Warm the cache at startup and keep it fresh so page loads read from memory.
function refreshAllNodes() {
  let nodes = [];
  try { nodes = db.prepare('SELECT * FROM nodes').all(); } catch (_) { return; }
  nodes.forEach((n) => { refreshNode(n); });
}
setInterval(refreshAllNodes, NODE_STATUS_TTL_MS).unref();
setTimeout(refreshAllNodes, 100).unref();

// ── Admin Dashboard ─────────────────────────────────────────────
router.get('/', (req, res) => {
  const count = (q) => { try { return db.prepare(q).get().c; } catch { return 0; } };

  const totalUsers = count('SELECT COUNT(*) as c FROM users');
  const totalServers = count('SELECT COUNT(*) as c FROM servers');
  const totalNodes = count('SELECT COUNT(*) as c FROM nodes');
  const totalLocations = count('SELECT COUNT(*) as c FROM locations');
  const totalEggs = count('SELECT COUNT(*) as c FROM eggs');
  const totalNests = count('SELECT COUNT(*) as c FROM nests');
  const totalAllocations = count('SELECT COUNT(*) as c FROM allocations');
  const usedAllocations = count('SELECT COUNT(*) as c FROM allocations WHERE server_id IS NOT NULL');
  const totalMemory = count('SELECT COALESCE(SUM(memory),0) as c FROM servers');
  const totalDisk = count('SELECT COALESCE(SUM(disk),0) as c FROM servers');

  const recentUsers = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 5').all();
  const recentServers = db.prepare('SELECT s.*, u.username, n.name as node_name FROM servers s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN nodes n ON s.node_id = n.id ORDER BY s.created_at DESC LIMIT 5').all();

  const usersByDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count FROM users
    WHERE created_at >= date('now', '-7 days') GROUP BY day ORDER BY day
  `).all();

  res.render('admin/dashboard', {
    section: 'dashboard',
    totalUsers, totalServers, totalNodes, totalLocations, totalEggs,
    totalNests, totalAllocations, usedAllocations, totalMemory, totalDisk,
    recentUsers, recentServers, usersByDay,
  });
});

// ── Locations ───────────────────────────────────────────────────
router.get('/locations', (req, res) => {
  const locations = db.prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM nodes WHERE location_id = l.id) as node_count,
      (SELECT COUNT(*) FROM servers s JOIN nodes n ON s.node_id = n.id WHERE n.location_id = l.id) as server_count
    FROM locations l ORDER BY l.\`long\`
  `).all();
  res.render('admin/locations', { section: 'locations', locations, notice: req.query.notice });
});

router.post('/locations/create', (req, res) => {
  const { short, long } = req.body;
  try {
    db.prepare('INSERT INTO locations (short, `long`) VALUES (?, ?)').run(short.trim(), long.trim());
  } catch (e) { console.error('[admin] create location:', e.message); }
  res.redirect('/admin/locations');
});

router.get('/locations/:id', (req, res) => {
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
  if (!loc) return res.redirect('/admin/locations');
  const nodes = db.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM servers s WHERE s.node_id = n.id) as server_count
    FROM nodes n WHERE n.location_id = ? ORDER BY n.name
  `).all(loc.id);
  res.render('admin/location-edit', { section: 'locations', loc, nodes });
});

router.post('/locations/:id', (req, res) => {
  const { short, long } = req.body;
  try {
    db.prepare('UPDATE locations SET short = ?, `long` = ? WHERE id = ?').run(short.trim(), long.trim(), req.params.id);
  } catch (e) { console.error('[admin] update location:', e.message); }
  res.redirect('/admin/locations');
});

router.post('/locations/:id/delete', (req, res) => {
  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE location_id = ?').get(req.params.id).c;
  if (nodeCount > 0) return res.redirect('/admin/locations');
  db.prepare('DELETE FROM locations WHERE id = ?').run(req.params.id);
  res.redirect('/admin/locations');
});

// ── Nodes ───────────────────────────────────────────────────────
router.get('/nodes', async (req, res) => {
  const locations = db.prepare('SELECT * FROM locations ORDER BY `long`').all();
  if (locations.length === 0) {
    return res.redirect('/admin/locations?notice=nolocations');
  }
  const nodes = db.prepare(`
    SELECT n.*, l.\`long\` as location_name,
      (SELECT COUNT(*) FROM servers WHERE node_id = n.id) as server_count,
      (SELECT COUNT(*) FROM allocations WHERE node_id = n.id) as allocation_count
    FROM nodes n LEFT JOIN locations l ON n.location_id = l.id ORDER BY n.name
  `).all();
  await Promise.all(nodes.map(async (n) => {
    n.online = await nodeOnline(n);
    if (n.online) syncNodeResourcesThrottled(n);
  }));
  res.render('admin/nodes', { section: 'nodes', nodes, locations });
});

router.post('/nodes/create', (req, res) => {
  const { location_id, name, fqdn, scheme, memory, disk, cpu, disk_overallocate, memory_overallocate, daemon_token, daemon_listen, sftp_port, daemon_type } = req.body;
  let nodeId = null;
  try {
    const result = db.prepare(`INSERT INTO nodes (location_id, name, fqdn, scheme, memory, disk, cpu, disk_overallocate, memory_overallocate, daemon_token, daemon_listen, sftp_port, daemon_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      location_id, name, fqdn, scheme || 'https', grab(memory, 8192), grab(disk, 102400),
      grab(cpu, 8), grab(disk_overallocate, 0), grab(memory_overallocate, 0),
      daemon_token || uuidv4(), normalizeListen(daemon_listen), grab(sftp_port, 2022), daemon_type === 'oxlify' ? 'oxlify' : 'rubityle'
    );
    nodeId = result.lastInsertRowid;
  } catch (e) { console.error('[admin] create node:', e.message); }
  if (nodeId && daemon_type !== 'oxlify') {
    return res.redirect(`/admin/nodes/${nodeId}?setup=1`);
  }
  res.redirect('/admin/nodes');
});

router.get('/nodes/:id', async (req, res) => {
  const node = db.prepare('SELECT n.*, l.`long` as location_name FROM nodes n LEFT JOIN locations l ON n.location_id = l.id WHERE n.id = ?').get(req.params.id);
  if (!node) return res.redirect('/admin/nodes');
  node.daemon_listen = normalizeListen(node.daemon_listen);
  const isOnline = await nodeOnline(node);
  if (isOnline) syncNodeResourcesThrottled(node);
  const locations = db.prepare('SELECT * FROM locations ORDER BY `long`').all();
  const nodeAllocs = db.prepare(`
    SELECT a.*, s.name as server_name, u.username AS server_owner
    FROM allocations a LEFT JOIN servers s ON a.server_id = s.id LEFT JOIN users u ON s.user_id = u.id
    WHERE a.node_id = ? ORDER BY a.ip, a.port
  `).all(node.id);
  const nodeServers = db.prepare(`
    SELECT s.*, u.username, e.name as egg_name
    FROM servers s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN eggs e ON s.egg_id = e.id
    WHERE s.node_id = ? ORDER BY s.name
  `).all(node.id);
  const memAlloc = db.prepare('SELECT COALESCE(SUM(memory),0) as c FROM servers WHERE node_id = ?').get(node.id).c;
  const diskAlloc = db.prepare('SELECT COALESCE(SUM(disk),0) as c FROM servers WHERE node_id = ?').get(node.id).c;
  const baseurl = require('../lib/baseurl');
  const appUrl = baseurl.resolveBaseUrl(req);
  res.render('admin/node-edit', { section: 'nodes', node, nodeOnline: isOnline, locations, nodeAllocs, nodeServers, memAlloc, diskAlloc, query: req.query, appUrl });
});

router.post('/nodes/:id', (req, res) => {
  const { location_id, name, fqdn, scheme, memory, disk, cpu, disk_overallocate, memory_overallocate, daemon_token, daemon_listen, sftp_port, daemon_type } = req.body;
  try {
    db.prepare(`UPDATE nodes SET location_id=?, name=?, fqdn=?, scheme=?, memory=?, disk=?, cpu=?, disk_overallocate=?, memory_overallocate=?, daemon_token=?, daemon_listen=?, sftp_port=?, daemon_type=? WHERE id=?`).run(
      location_id, name, fqdn, scheme, grab(memory, 0), grab(disk, 0), grab(cpu, 0),
      grab(disk_overallocate, 0), grab(memory_overallocate, 0), daemon_token, normalizeListen(daemon_listen), grab(sftp_port, 2022), daemon_type === 'oxlify' ? 'oxlify' : 'rubityle', req.params.id
    );
  } catch (e) { console.error('[admin] update node:', e.message); }
  res.redirect(`/admin/nodes/${req.params.id}`);
});

// Expands a port spec like "25565,25566,25565-25570" into a de-duplicated list of port numbers.
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

router.post('/nodes/:id/allocations', (req, res) => {
  const { ip, ports } = req.body;
  const stmt = db.prepare('INSERT OR IGNORE INTO allocations (node_id, ip, port) VALUES (?, ?, ?)');
  for (const port of expandPorts(ports)) stmt.run(req.params.id, ip, port);
  res.redirect(`/admin/nodes/${req.params.id}`);
});

router.post('/nodes/:id/allocations/:allocId/delete', (req, res) => {
  db.prepare('DELETE FROM allocations WHERE id = ? AND node_id = ? AND server_id IS NULL').run(req.params.allocId, req.params.id);
  res.redirect(`/admin/nodes/${req.params.id}`);
});

router.get('/nodes/:id/setup', (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).send('Not found');
  const token = req.query.token || req.headers['x-setup-token'];
  if (token && node.daemon_token && token !== node.daemon_token) {
    return res.status(403).send('Forbidden');
  }
  if (node.daemon_type === 'oxlify') {
    return res.status(400).send('Not applicable');
  }
  const scheme = node.scheme || 'https';
  const fqdn = node.fqdn || '';
  const listenPort = node.daemon_listen || '8080';
  const daemonToken = node.daemon_token || '';
  const config = {
    port: parseInt(String(listenPort).split(':').pop(), 10) || 8080,
    sftp_port: node.sftp_port || 2022,
    token: daemonToken,
    docker_socket: '/var/run/docker.sock',
    docker_network: 'pylox-servers',
    data_dir: '/var/lib/rubityle',
    log_dir: '/var/log/rubityle'
  };
  const script = `#!/bin/bash
cat > config.json << 'EOF'
${JSON.stringify(config, null, 2)}
EOF
echo "config.json written successfully"
`;
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="setup.sh"');
  res.send(script);
});

router.post('/nodes/:id/delete', (req, res) => {
  const serverCount = db.prepare('SELECT COUNT(*) as c FROM servers WHERE node_id = ?').get(req.params.id).c;
  if (serverCount === 0) {
    db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/nodes');
});

// ── Allocations (global) ────────────────────────────────────────
router.get('/allocations', (req, res) => {
  const allocations = db.prepare('SELECT a.*, n.name as node_name FROM allocations a LEFT JOIN nodes n ON a.node_id = n.id ORDER BY a.ip, a.port').all();
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY name').all();
  res.render('admin/allocations', { section: 'allocations', allocations, nodes });
});

router.post('/allocations/create', (req, res) => {
  const { node_id, ip, ports } = req.body;
  const stmt = db.prepare('INSERT OR IGNORE INTO allocations (node_id, ip, port) VALUES (?, ?, ?)');
  for (const port of expandPorts(ports)) stmt.run(node_id, ip, port);
  res.redirect('/admin/allocations');
});

router.post('/allocations/:id/delete', (req, res) => {
  db.prepare('DELETE FROM allocations WHERE id = ? AND server_id IS NULL').run(req.params.id);
  res.redirect('/admin/allocations');
});

// ── Servers ─────────────────────────────────────────────────────
router.get('/servers', (req, res) => {
  const search = (req.query.search || '').trim();
  let servers;
  if (search) {
    servers = db.prepare(`
      SELECT s.*, u.username, n.name as node_name, e.name as egg_name
      FROM servers s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN nodes n ON s.node_id = n.id LEFT JOIN eggs e ON s.egg_id = e.id
      WHERE s.name LIKE ? OR u.username LIKE ? OR s.uuid LIKE ?
      ORDER BY s.created_at DESC
    `).all(`%${search}%`, `%${search}%`, `%${search}%`);
  } else {
    servers = db.prepare(`
      SELECT s.*, u.username, n.name as node_name, e.name as egg_name
      FROM servers s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN nodes n ON s.node_id = n.id LEFT JOIN eggs e ON s.egg_id = e.id
      ORDER BY s.created_at DESC
    `).all();
  }
  const users = db.prepare('SELECT * FROM users ORDER BY username').all();
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY name').all();
  const allocations = db.prepare('SELECT a.*, n.name as node_name FROM allocations a LEFT JOIN nodes n ON a.node_id = n.id WHERE a.server_id IS NULL ORDER BY a.ip, a.port').all();
  const eggs = db.prepare('SELECT * FROM eggs ORDER BY name').all();
  const nests = db.prepare('SELECT * FROM nests ORDER BY name').all();
  res.render('admin/servers', { section: 'servers', servers, users, nodes, allocations, eggs, nests, search, notice: req.query.notice });
});

router.post('/servers/create', async (req, res) => {
  const { user_id, node_id, allocation_id, name, description, egg_id, memory, swap, disk, cpu, io, database_limit, backups_limit, allocation_limit, startup, image } = req.body;
  const serverUuid = uuidv4();
  const sftpPassword = crypto.randomBytes(18).toString('base64url');
  const egg = egg_id ? db.prepare('SELECT * FROM eggs WHERE id = ?').get(egg_id) : null;
  let notice = '';
  try {
    const result = db.prepare(`INSERT INTO servers (uuid, user_id, node_id, allocation_id, name, description, egg_id, image, startup_command, memory, swap, disk, cpu, io, database_limit, backups_limit, allocation_limit, sftp_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      serverUuid, user_id, node_id, allocation_id || null, name, description || '',
      egg_id || null, image || (egg ? egg.docker_image : null), startup || (egg ? egg.startup : ''),
      grab(memory, 1024), grab(swap, 0), grab(disk, 10240),
      grab(cpu, 100), grab(io, 500), grab(database_limit, 0), grab(backups_limit, 3),
      nonNegativeInt(allocation_limit, 0), sftpPassword
    );
    if (allocation_id) {
      db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(result.lastInsertRowid, allocation_id);
    }
    // Provision the container on the daemon so the server is ready to start.
    try {
      await daemonLib.createServer(serverUuid);
      notice = 'provisioned';
    } catch (e) {
      console.error('[admin] provision server on daemon:', e.message);
      notice = 'provisionfailed:' + encodeURIComponent(e.message);
    }
    // Run the egg's installation script in the background so files (server jar,
    // etc.) are downloaded without blocking the request.
    if (daemonLib.getInstallSpec(egg)) {
      db.prepare('UPDATE servers SET install_status = ?, install_error = NULL WHERE id = ?').run('installing', result.lastInsertRowid);
      daemonLib.installServer(serverUuid).then(() => {
        db.prepare('UPDATE servers SET install_status = ? WHERE id = ?').run('installed', result.lastInsertRowid);
      }).catch((e) => {
        console.error('[admin] install server:', e.message);
        db.prepare('UPDATE servers SET install_status = ?, install_error = ? WHERE id = ?').run('install_failed', String(e.message).slice(0, 500), result.lastInsertRowid);
      });
    } else {
      console.error(`[admin] egg ${egg_id} has no installation script; skipping install for ${serverUuid}`);
    }
  } catch (e) {
    console.error('[admin] create server:', e.message);
    notice = 'createfailed:' + encodeURIComponent(e.message);
  }
  res.redirect(`/admin/servers?notice=${notice}`);
});

router.get('/servers/:id', (req, res) => {
  const srvServer = db.prepare(`
    SELECT s.*, u.username, u.email as user_email, n.name as node_name, e.name as egg_name,
      a.ip as alloc_ip, a.port as alloc_port
    FROM servers s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN nodes n ON s.node_id = n.id
    LEFT JOIN eggs e ON s.egg_id = e.id
    LEFT JOIN allocations a ON s.allocation_id = a.id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!srvServer) return res.redirect('/admin/servers');

  const users = db.prepare('SELECT * FROM users ORDER BY username').all();
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY name').all();
  const eggs = db.prepare('SELECT * FROM eggs ORDER BY name').all();
  const nests = db.prepare('SELECT * FROM nests ORDER BY name').all();
  const freeAllocs = db.prepare('SELECT a.*, n.name as node_name FROM allocations a LEFT JOIN nodes n ON a.node_id = n.id WHERE a.server_id IS NULL OR a.server_id = ? ORDER BY a.ip, a.port').all(srvServer.id);
  const srvAllocs = db.prepare('SELECT a.*, n.name as node_name FROM allocations a LEFT JOIN nodes n ON a.node_id = n.id WHERE a.server_id = ? ORDER BY a.ip, a.port').all(srvServer.id);
  const databases = db.prepare('SELECT * FROM databases WHERE server_id = ?').all(srvServer.id);

  // Docker image choices for the Startup tab, keyed by egg id so the form can
  // refresh them when a different egg is selected.
  const eggImagesByEgg = {};
  for (const egg of eggs) eggImagesByEgg[egg.id] = eggImageList(egg);
  const eggImages = srvServer.egg_id ? (eggImagesByEgg[srvServer.egg_id] || []) : [];
  const selectedImage = srvServer.image || (eggImages[0] && eggImages[0].image) || '';
  const isCustomImage = !selectedImage || !eggImages.some(im => im.image === selectedImage);

  let eggVars = [];
  if (srvServer.egg_id) {
    eggVars = db.prepare('SELECT * FROM egg_variables WHERE egg_id = ? ORDER BY sort_order, id').all(srvServer.egg_id);
    for (const v of eggVars) {
      const cur = db.prepare('SELECT value FROM server_variables WHERE server_id = ? AND env_var = ?').get(srvServer.id, v.env_var);
      v.current_value = cur ? cur.value : v.default_value;
    }
  }

  const memAlloc = db.prepare('SELECT COALESCE(SUM(memory),0) as c FROM servers WHERE node_id = ?').get(srvServer.node_id).c;
  const diskAlloc = db.prepare('SELECT COALESCE(SUM(disk),0) as c FROM servers WHERE node_id = ?').get(srvServer.node_id).c;
  const nodeData = nodes.find(n => n.id === srvServer.node_id) || null;
  // Transfer is only possible when another node exists besides the current one.
  const otherNodes = nodes.filter(n => Number(n.id) !== Number(srvServer.node_id));

  res.render('admin/server-edit', {
    section: 'servers', srvServer, users, nodes, eggs, nests,
    freeAllocs, srvAllocs, databases, eggVars, memAlloc, diskAlloc, nodeData,
    eggImagesByEgg, eggImages, selectedImage, isCustomImage,
    otherNodes, canTransfer: otherNodes.length > 0,
  });
});

router.post('/servers/:id/details', (req, res) => {
  const { name, description, user_id, node_id, allocation_id } = req.body;
  try {
    db.prepare('UPDATE servers SET name=?, description=?, user_id=?, node_id=?, allocation_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
      name, description || '', user_id, node_id, allocation_id || null, req.params.id
    );
    if (allocation_id) db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(req.params.id, allocation_id);
  } catch (e) { console.error('[admin] update server details:', e.message); }
  res.redirect(`/admin/servers/${req.params.id}#details`);
});

router.post('/servers/:id/build', (req, res) => {
  const { memory, swap, disk, cpu, io, database_limit, backups_limit, allocation_limit } = req.body;
  try {
    db.prepare('UPDATE servers SET memory=?, swap=?, disk=?, cpu=?, io=?, database_limit=?, backups_limit=?, allocation_limit=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
      grab(memory, 0), grab(swap, 0), grab(disk, 0), grab(cpu, 0),
      grab(io, 0), grab(database_limit, 0), grab(backups_limit, 0),
      nonNegativeInt(allocation_limit, 0), req.params.id
    );
  } catch (e) { console.error('[admin] update server build:', e.message); }
  res.redirect(`/admin/servers/${req.params.id}#build`);
});

router.post('/servers/:id/startup', (req, res) => {
  const { startup, image, egg_id } = req.body;
  try {
    db.prepare('UPDATE servers SET startup_command=?, image=?, egg_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
      startup || '', image || null, egg_id || null, req.params.id
    );
    if (egg_id) {
      const egg = db.prepare('SELECT * FROM eggs WHERE id = ?').get(egg_id);
      if (egg && !image) db.prepare('UPDATE servers SET image=? WHERE id=?').run(egg.docker_image, req.params.id);
    }
    const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    const variables = db.prepare('SELECT * FROM egg_variables WHERE egg_id = ?').all(srv.egg_id);
    for (const v of variables) {
      const val = req.body[`var_${v.env_var}`];
      if (val !== undefined) {
        const existing = db.prepare('SELECT id FROM server_variables WHERE server_id = ? AND env_var = ?').get(srv.id, v.env_var);
        if (existing) db.prepare('UPDATE server_variables SET value = ? WHERE id = ?').run(val, existing.id);
        else db.prepare('INSERT INTO server_variables (server_id, env_var, value) VALUES (?, ?, ?)').run(srv.id, v.env_var, val);
      }
    }
  } catch (e) { console.error('[admin] update server startup:', e.message); }
  res.redirect(`/admin/servers/${req.params.id}#startup`);
});

router.post('/servers/:id/network/assign', (req, res) => {
  const { allocation_id } = req.body;
  try {
    const alloc = db.prepare('SELECT * FROM allocations WHERE id = ?').get(allocation_id);
    if (alloc && (!alloc.server_id || alloc.server_id == req.params.id)) {
      db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(req.params.id, allocation_id);
    }
  } catch (e) { console.error('[admin] assign allocation:', e.message); }
  res.redirect(`/admin/servers/${req.params.id}#network`);
});

router.post('/servers/:id/network/primary', (req, res) => {
  const { allocation_id } = req.body;
  try {
    db.prepare('UPDATE servers SET allocation_id = ? WHERE id = ?').run(allocation_id, req.params.id);
    db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(req.params.id, allocation_id);
    const srv = db.prepare('SELECT allocation_id FROM servers WHERE id = ?').get(req.params.id);
    if (srv) db.prepare('UPDATE allocations SET server_id = NULL WHERE server_id = ? AND id <> ?').run(req.params.id, srv.allocation_id);
  } catch (e) { console.error('[admin] set primary allocation:', e.message); }
  res.redirect(`/admin/servers/${req.params.id}#network`);
});

router.post('/servers/:id/network/:allocId/unassign', (req, res) => {
  db.prepare('UPDATE allocations SET server_id = NULL WHERE id = ? AND server_id = ?').run(req.params.allocId, req.params.id);
  const srv = db.prepare('SELECT allocation_id FROM servers WHERE id = ?').get(req.params.id);
  if (srv && srv.allocation_id == req.params.allocId) {
    db.prepare('UPDATE servers SET allocation_id = NULL WHERE id = ?').run(req.params.id);
  }
  res.redirect(`/admin/servers/${req.params.id}#network`);
});

router.post('/servers/:id/databases', (req, res) => {
  const { name, username, password, host, port, connections } = req.body;
  try {
    const srv = db.prepare('SELECT database_limit FROM servers WHERE id = ?').get(req.params.id);
    const dbCount = db.prepare('SELECT COUNT(*) as c FROM databases WHERE server_id = ?').get(req.params.id).c;
    if (srv && dbCount < srv.database_limit) {
      db.prepare('INSERT INTO databases (server_id, name, username, password, host, port) VALUES (?, ?, ?, ?, ?, ?)').run(
        req.params.id, name, username, password, host || '127.0.0.1', port || 3306
      );
    }
  } catch (e) { console.error('[admin] create database:', e.message); }
  res.redirect(`/admin/servers/${req.params.id}#databases`);
});

router.post('/servers/:id/databases/:dbId/delete', (req, res) => {
  db.prepare('DELETE FROM databases WHERE id = ? AND server_id = ?').run(req.params.dbId, req.params.id);
  res.redirect(`/admin/servers/${req.params.id}#databases`);
});

router.post('/servers/:id/reinstall', (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (srv) {
    db.prepare('UPDATE servers SET status = ?, install_status = ?, install_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('installing', 'installing', srv.id);
    (async () => {
      try {
        await daemonLib.removeServer(srv.uuid).catch(() => {});
        await daemonLib.installServer(srv.uuid);
        db.prepare('UPDATE servers SET install_status = ?, install_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('installed', srv.id);
      } catch (e) {
        console.error('[admin] reinstall server:', e.message);
        db.prepare('UPDATE servers SET install_status = ?, install_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('install_failed', String(e.message).slice(0, 500), srv.id);
      }
    })();
  }
  res.redirect(`/admin/servers/${req.params.id}#manage`);
});

router.post('/servers/:id/transfer', async (req, res) => {
  const { node_id } = req.body;
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  const targetNode = node_id ? db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id) : null;
  if (srv && targetNode && Number(node_id) !== Number(srv.node_id)) {
    try {
      db.prepare('UPDATE servers SET node_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(node_id, srv.id);
      const freeAlloc = db.prepare('SELECT * FROM allocations WHERE node_id = ? AND server_id IS NULL ORDER BY id LIMIT 1').get(node_id);
      if (freeAlloc) db.prepare('UPDATE allocations SET server_id = ? WHERE id = ?').run(srv.id, freeAlloc.id);
      await daemonLib.removeServer(srv.uuid).catch(() => {});
    } catch (e) { console.error('[admin] transfer server:', e.message); }
  }
  res.redirect(`/admin/servers/${req.params.id}#manage`);
});

router.post('/servers/:id/delete', async (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (srv) {
    try { await daemonLib.removeServer(srv.uuid); } catch {}
    db.prepare('UPDATE allocations SET server_id = NULL WHERE server_id = ?').run(srv.id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(srv.id);
  }
  res.redirect('/admin/servers');
});

// Suspension is a panel-side flag kept separate from the daemon-reported
// status, so status polling can never silently unsuspend a server.
router.post('/servers/:id/suspend', async (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (srv && !srv.suspended) {
    try { await daemonLib.stopServer(srv.uuid); } catch (e) { console.error('[admin] suspend server:', e.message); }
    db.prepare("UPDATE servers SET suspended = 1, status = 'offline', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(srv.id);
  }
  res.redirect(`/admin/servers/${req.params.id}#manage`);
});

router.post('/servers/:id/unsuspend', (req, res) => {
  db.prepare('UPDATE servers SET suspended = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.redirect(`/admin/servers/${req.params.id}#manage`);
});

// ── Databases (global) ──────────────────────────────────────────
router.get('/databases', (req, res) => {
  const databases = db.prepare(`
    SELECT d.*, s.name as server_name, s.uuid as server_uuid,
      u.username as owner, n.name as node_name
    FROM databases d
    LEFT JOIN servers s ON d.server_id = s.id
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN nodes n ON s.node_id = n.id
    ORDER BY d.id DESC
  `).all();
  const databaseHosts = db.prepare('SELECT * FROM database_hosts ORDER BY name').all();
  const servers = db.prepare(`
    SELECT s.*, u.username as owner FROM servers s
    LEFT JOIN users u ON s.user_id = u.id ORDER BY s.name
  `).all();
  res.render('admin/databases', {
    section: 'databases', databases, databaseHosts, servers,
    notice: req.query.notice,
  });
});

router.post('/databases/create', (req, res) => {
  const { server_id, name, username, password, database_host_id, host, port } = req.body;
  try {
    let dbHost = host || '127.0.0.1';
    let dbPort = parseInt(port, 10) || 3306;
    let hostId = null;
    if (database_host_id) {
      const h = db.prepare('SELECT * FROM database_hosts WHERE id = ?').get(database_host_id);
      if (h) { dbHost = h.host; dbPort = h.port || 3306; hostId = h.id; }
    }
    if (server_id && name && username && password) {
      db.prepare('INSERT INTO databases (server_id, database_host_id, name, username, password, host, port) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        server_id, hostId, name, username, password, dbHost, dbPort
      );
    }
  } catch (e) { console.error('[admin] create database:', e.message); }
  res.redirect('/admin/databases');
});

router.post('/databases/:id', (req, res) => {
  const { name, username, password, database_host_id } = req.body;
  try {
    const row = db.prepare('SELECT * FROM databases WHERE id = ?').get(req.params.id);
    if (row) {
      let dbHost = row.host;
      let dbPort = row.port;
      let hostId = row.database_host_id || null;
      if (database_host_id) {
        const h = db.prepare('SELECT * FROM database_hosts WHERE id = ?').get(database_host_id);
        if (h) { dbHost = h.host; dbPort = h.port || 3306; hostId = h.id; }
      } else if (database_host_id === '') {
        hostId = null;
      }
      db.prepare('UPDATE databases SET name=?, username=?, password=?, host=?, port=?, database_host_id=? WHERE id=?').run(
        name || row.name, username || row.username,
        (password && password.length > 0) ? password : row.password,
        dbHost, dbPort, hostId, req.params.id
      );
    }
  } catch (e) { console.error('[admin] update database:', e.message); }
  res.redirect('/admin/databases');
});

router.post('/databases/:id/delete', (req, res) => {
  db.prepare('DELETE FROM databases WHERE id = ?').run(req.params.id);
  res.redirect('/admin/databases');
});

// ── Database Hosts ──────────────────────────────────────────────
router.post('/database-hosts/create', (req, res) => {
  const { name, host, port, username, password } = req.body;
  try {
    if (name && host) {
      db.prepare('INSERT INTO database_hosts (name, host, port, username, password) VALUES (?, ?, ?, ?, ?)').run(
        name, host, parseInt(port, 10) || 3306, username || '', password || ''
      );
    }
  } catch (e) { console.error('[admin] create database host:', e.message); }
  res.redirect('/admin/databases');
});

router.post('/database-hosts/:id', (req, res) => {
  const { name, host, port, username, password } = req.body;
  try {
    const row = db.prepare('SELECT * FROM database_hosts WHERE id = ?').get(req.params.id);
    if (row) {
      db.prepare('UPDATE database_hosts SET name=?, host=?, port=?, username=?, password=? WHERE id=?').run(
        name || row.name, host || row.host, parseInt(port, 10) || row.port || 3306,
        username !== undefined ? username : row.username,
        (password !== undefined && password !== '') ? password : row.password,
        req.params.id
      );
    }
  } catch (e) { console.error('[admin] update database host:', e.message); }
  res.redirect('/admin/databases');
});

router.post('/database-hosts/:id/delete', (req, res) => {
  db.prepare('UPDATE databases SET database_host_id = NULL WHERE database_host_id = ?').run(req.params.id);
  db.prepare('DELETE FROM database_hosts WHERE id = ?').run(req.params.id);
  res.redirect('/admin/databases');
});

// ── Users ───────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  const search = (req.query.search || '').trim();
  let users;
  if (search) {
    users = db.prepare('SELECT * FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY created_at DESC').all(`%${search}%`, `%${search}%`);
  } else {
    users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  }
  res.render('admin/users', { section: 'users', users, search });
});

// MUST be registered before POST /users/:id so "create" is not parsed as an id
router.post('/users/create', (req, res) => {
  const { username, email, password, root_admin } = req.body;
  if (!username || !email || !password) return res.redirect('/admin/users');
  try {
    db.prepare('INSERT INTO users (uuid, username, email, password, root_admin) VALUES (?, ?, ?, ?, ?)').run(
      uuidv4(), username.trim(), email.trim(), bcrypt.hashSync(password, 10), root_admin ? 1 : 0
    );
  } catch (e) { console.error('[admin] create user:', e.message); }
  res.redirect('/admin/users');
});

router.get('/users/:id', (req, res) => {
  const editUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!editUser) return res.redirect('/admin/users');
  const servers = db.prepare('SELECT s.*, n.name as node_name FROM servers s LEFT JOIN nodes n ON s.node_id = n.id WHERE s.user_id = ?').all(editUser.id);
  const userApiKeys = db.prepare('SELECT * FROM api_keys WHERE user_id = ?').all(editUser.id);
  res.render('admin/user-edit', { section: 'users', editUser, servers, userApiKeys });
});

router.post('/users/:id', (req, res) => {
  const { username, email, password, root_admin } = req.body;
  try {
    if (password && password.length > 0) {
      db.prepare('UPDATE users SET username=?, email=?, password=?, root_admin=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
        username, email, bcrypt.hashSync(password, 10), root_admin ? 1 : 0, req.params.id
      );
    } else {
      db.prepare('UPDATE users SET username=?, email=?, root_admin=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
        username, email, root_admin ? 1 : 0, req.params.id
      );
    }
  } catch (e) { console.error('[admin] update user:', e.message); }
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.redirect('/admin/users');
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.redirect('/admin/users');
});

// ── API Keys ────────────────────────────────────────────────────
router.get('/api-keys', (req, res) => {
  const search = (req.query.search || '').trim();
  const base = `
    SELECT ak.*, u.username, u.email
    FROM api_keys ak LEFT JOIN users u ON ak.user_id = u.id
    WHERE ak.source = 'admin' AND ak.created_by = ?
  `;
  let apiKeys;
  if (search) {
    apiKeys = db.prepare(base + ` AND (u.username LIKE ? OR u.email LIKE ? OR ak.memo LIKE ?) ORDER BY ak.created_at DESC`)
      .all(req.user.id, `%${search}%`, `%${search}%`, `%${search}%`);
  } else {
    apiKeys = db.prepare(base + ` ORDER BY ak.created_at DESC`).all(req.user.id);
  }
  const users = db.prepare('SELECT id, username, email FROM users ORDER BY username').all();
  res.render('admin/api-keys', {
    section: 'apikeys', apiKeys, users, search,
    token: req.query.token || null, notice: req.query.notice,
  });
});

router.post('/api-keys/create', (req, res) => {
  const { user_id, memo } = req.body;
  let token = null;
  try {
    if (user_id) {
      token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
      db.prepare("INSERT INTO api_keys (user_id, token, memo, source, created_by) VALUES (?, ?, ?, 'admin', ?)").run(user_id, token, memo || 'API Key', req.user.id);
    }
  } catch (e) { console.error('[admin] create api key:', e.message); }
  res.redirect('/admin/api-keys' + (token ? '?token=' + token : ''));
});

router.post('/api-keys/:id/delete', (req, res) => {
  db.prepare("DELETE FROM api_keys WHERE id = ? AND source = 'admin' AND created_by = ?").run(req.params.id, req.user.id);
  res.redirect('/admin/api-keys');
});

// ── Nests ───────────────────────────────────────────────────────
router.get('/nests', (req, res) => {
  const nests = db.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM eggs WHERE nest_id = n.id) as egg_count,
      (SELECT COUNT(*) FROM servers s LEFT JOIN eggs e ON s.egg_id = e.id WHERE e.nest_id = n.id) as server_count,
      u.username as author
    FROM nests n LEFT JOIN users u ON n.author_id = u.id ORDER BY n.name
  `).all();
  res.render('admin/nests', { section: 'nests', nests, notice: req.query.notice });
});

router.post('/nests/create', (req, res) => {
  const { name, description } = req.body;
  try {
    db.prepare('INSERT INTO nests (uuid, author_id, name, description) VALUES (?, ?, ?, ?)').run(
      uuidv4(), req.user.id, name, description || ''
    );
  } catch (e) { console.error('[admin] create nest:', e.message); }
  res.redirect('/admin/nests');
});

router.get('/nests/:id', (req, res) => {
  const nest = db.prepare('SELECT n.*, u.username as author FROM nests n LEFT JOIN users u ON n.author_id = u.id WHERE n.id = ?').get(req.params.id);
  if (!nest) return res.redirect('/admin/nests');
  const nestEggs = db.prepare('SELECT e.*, (SELECT COUNT(*) FROM servers WHERE egg_id = e.id) as server_count FROM eggs e WHERE e.nest_id = ? ORDER BY e.name').all(nest.id);
  res.render('admin/nest-edit', { section: 'nests', nest, nestEggs });
});

router.post('/nests/:id', (req, res) => {
  const { name, description } = req.body;
  try {
    db.prepare('UPDATE nests SET name=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, description || '', req.params.id);
  } catch (e) { console.error('[admin] update nest:', e.message); }
  res.redirect(`/admin/nests/${req.params.id}`);
});

router.post('/nests/:id/delete', (req, res) => {
  const eggCount = db.prepare('SELECT COUNT(*) as c FROM eggs WHERE nest_id = ?').get(req.params.id).c;
  if (eggCount === 0) {
    db.prepare('DELETE FROM nests WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/nests');
});

// ── Eggs ────────────────────────────────────────────────────────
// Import a pterodactyl/pelican egg (JSON) file
router.post('/eggs/import', eggUpload.single('egg_file'), (req, res) => {
  const redirectTo = req.body.redirect_to || '/admin/eggs';
  const targetNestId = req.body.nest_id ? parseInt(req.body.nest_id) : null;

  if (!req.file) {
    return res.redirect(`${redirectTo}?notice=noeggfile`);
  }

  let eggData;
  try {
    const text = fs.readFileSync(req.file.path, 'utf8');
    eggData = parseEggJson(text);
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.redirect(`${redirectTo}?notice=badegg:${encodeURIComponent(e.message)}`);
  } finally {
    if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch {}
  }

  try {
    let nestId = targetNestId;
    if (!nestId) {
      // Try to auto-create a nest matching the egg's source/name if no target was chosen
      let nest = db.prepare('SELECT id FROM nests WHERE name = ?').get(eggData.name);
      if (!nest) {
        const result = db.prepare('INSERT INTO nests (uuid, author_id, name, description) VALUES (?, ?, ?, ?)').run(
          uuidv4(), req.user.id, eggData.name, eggData.description || ''
        );
        nestId = result.lastInsertRowid;
      } else {
        nestId = nest.id;
      }
    }

    const result = db.prepare(`INSERT INTO eggs
      (name, description, docker_image, docker_images, startup, features, file_denylist, config, install_script, author, nest_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      eggData.name, eggData.description, eggData.docker_image, eggData.docker_images,
      eggData.startup, eggData.features, eggData.file_denylist, eggData.config,
      eggData.install_script, eggData.author, nestId
    );

    const eggId = result.lastInsertRowid;
    const varStmt = db.prepare(`INSERT INTO egg_variables
      (egg_id, name, description, env_var, default_value, user_viewable, user_editable, rules, sort_order, field_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const v of eggData.variables) {
      varStmt.run(eggId, v.name, v.description, v.env_var, v.default_value, v.user_viewable, v.user_editable, v.rules, v.sort_order, v.field_type);
    }

    res.redirect(`/admin/eggs/${eggId}?notice=imported:${eggData.source}`);
  } catch (e) {
    console.error('[admin] import egg:', e.message);
    res.redirect(`${redirectTo}?notice=badegg:${encodeURIComponent(e.message)}`);
  }
});

router.get('/eggs', (req, res) => {
  const nestFilter = req.query.nest ? parseInt(req.query.nest) : null;
  let eggs;
  if (nestFilter) {
    eggs = db.prepare(`
      SELECT e.*, n.name as nest_name, (SELECT COUNT(*) FROM servers WHERE egg_id = e.id) as server_count
      FROM eggs e LEFT JOIN nests n ON e.nest_id = n.id WHERE e.nest_id = ? ORDER BY e.name
    `).all(nestFilter);
  } else {
    eggs = db.prepare(`
      SELECT e.*, n.name as nest_name, (SELECT COUNT(*) FROM servers WHERE egg_id = e.id) as server_count
      FROM eggs e LEFT JOIN nests n ON e.nest_id = n.id ORDER BY e.name
    `).all();
  }
  const nests = db.prepare('SELECT * FROM nests ORDER BY name').all();
  res.render('admin/eggs', { section: 'eggs', eggs, nests, nestFilter, notice: req.query.notice });
});

router.post('/eggs/create', (req, res) => {
  const { name, description, docker_image, startup, nest_id } = req.body;
  try {
    db.prepare(`INSERT INTO eggs (name, description, docker_image, docker_images, startup, nest_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      name, description || '', docker_image || '', JSON.stringify({ [docker_image]: docker_image }), startup || '', nest_id || null
    );
  } catch (e) { console.error('[admin] create egg:', e.message); }
  res.redirect(nest_id ? `/admin/nests/${nest_id}` : '/admin/eggs');
});

router.get('/eggs/:id', (req, res) => {
  const egg = db.prepare('SELECT e.*, n.name as nest_name FROM eggs e LEFT JOIN nests n ON e.nest_id = n.id WHERE e.id = ?').get(req.params.id);
  if (!egg) return res.redirect('/admin/eggs');
  const nests = db.prepare('SELECT * FROM nests ORDER BY name').all();
  const variables = db.prepare('SELECT * FROM egg_variables WHERE egg_id = ? ORDER BY sort_order, id').all(egg.id);

  let eggImages = [];
  try { eggImages = Object.entries(JSON.parse(egg.docker_images || '{}')).map(([image, label]) => ({ image, label: typeof label === 'string' ? label : image })); } catch {}

  res.render('admin/egg-edit', {
    section: 'eggs', egg, nests, variables, eggImages,
    eggFeatures: egg.features || '[]',
    eggFileDenylist: egg.file_denylist || '[]',
    eggConfig: egg.config || '{}',
    eggInstall: egg.install_script || 'null',
    notice: req.query.notice,
  });
});

router.post('/eggs/:id', (req, res) => {
  const { name, description, docker_image, startup, nest_id, author, features, file_denylist } = req.body;
  const dockerImages = req.body.docker_images && req.body.docker_images.trim() ? req.body.docker_images.trim() : JSON.stringify({ [docker_image]: docker_image });
  try {
    db.prepare(`UPDATE eggs SET name=?, description=?, docker_image=?, docker_images=?, startup=?, nest_id=?, author=?, features=?, file_denylist=?, config=?, install_script=? WHERE id=?`).run(
      name, description || '', docker_image || '', dockerImages, startup || '', nest_id || null,
      author || '', features || '[]', file_denylist || '[]',
      req.body.config || '{}', req.body.install_script || 'null', req.params.id
    );
  } catch (e) { console.error('[admin] update egg:', e.message); }
  res.redirect(`/admin/eggs/${req.params.id}`);
});

router.post('/eggs/:id/variables', (req, res) => {
  const { name, description, env_var, default_value, rules, user_viewable, user_editable, field_type } = req.body;
  try {
    db.prepare('INSERT INTO egg_variables (egg_id, name, description, env_var, default_value, rules, user_viewable, user_editable, field_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.params.id, name, description || '', env_var, default_value || '', rules || '',
      user_viewable ? 1 : 0, user_editable ? 1 : 0, field_type || ''
    );
  } catch (e) { console.error('[admin] create variable:', e.message); }
  res.redirect(`/admin/eggs/${req.params.id}`);
});

router.post('/eggs/:id/variables/:varId', (req, res) => {
  const { name, description, env_var, default_value, rules, sort_order, user_viewable, user_editable, field_type } = req.body;
  try {
    db.prepare('UPDATE egg_variables SET name=?, description=?, env_var=?, default_value=?, rules=?, sort_order=?, user_viewable=?, user_editable=?, field_type=? WHERE id=?').run(
      name, description || '', env_var, default_value || '', rules || '', sort_order || 0,
      user_viewable ? 1 : 0, user_editable ? 1 : 0, field_type || '', req.params.varId
    );
  } catch (e) { console.error('[admin] update variable:', e.message); }
  res.redirect(`/admin/eggs/${req.params.id}`);
});

router.post('/eggs/:id/variables/:varId/delete', (req, res) => {
  db.prepare('DELETE FROM egg_variables WHERE id = ?').run(req.params.varId);
  res.redirect(`/admin/eggs/${req.params.id}`);
});

router.post('/eggs/:id/delete', (req, res) => {
  const serverCount = db.prepare('SELECT COUNT(*) as c FROM servers WHERE egg_id = ?').get(req.params.id).c;
  if (serverCount === 0) {
    db.prepare('DELETE FROM eggs WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/eggs');
});

// ── Panel Settings ──────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const settings = {
    site_name: db.getSetting('site_name', 'Panel'),
    timezone: db.getSetting('timezone', 'UTC'),
    default_language: db.getSetting('default_language', 'en'),
    show_server_description: db.getSetting('show_server_description', '1'),
    two_factor_auth: db.getSetting('two_factor_auth', 'None'),
    smtp_host: db.getSetting('smtp_host', ''),
    smtp_port: db.getSetting('smtp_port', '587'),
    smtp_encryption: db.getSetting('smtp_encryption', 'tls'),
    smtp_username: db.getSetting('smtp_username', ''),
    smtp_password: db.getSetting('smtp_password', ''),
    smtp_from_email: db.getSetting('smtp_from_email', ''),
    smtp_from_name: db.getSetting('smtp_from_name', 'Panel'),
    captcha_provider: db.getSetting('captcha_provider', 'Disabled'),
    cloudflare_turnstile_site_key: db.getSetting('cloudflare_turnstile_site_key', ''),
    cloudflare_turnstile_secret_key: db.getSetting('cloudflare_turnstile_secret_key', ''),
    hcaptcha_site_key: db.getSetting('hcaptcha_site_key', ''),
    hcaptcha_secret_key: db.getSetting('hcaptcha_secret_key', ''),
    google_recaptcha_site_key: db.getSetting('google_recaptcha_site_key', ''),
    google_recaptcha_secret_key: db.getSetting('google_recaptcha_secret_key', ''),
    branding_page_logo: db.getSetting('branding_page_logo', '/static/img/Pylox_no_bg.png'),
    branding_favicon: db.getSetting('branding_favicon', '/static/img/Pylox_no_bg.png'),
  };
  res.render('admin/settings', { section: 'settings', settings });
});

router.post('/settings', brandUpload.fields([{ name: 'page_logo' }, { name: 'favicon' }]), (req, res) => {
  const { site_name, timezone, default_language, show_server_description, two_factor_auth, smtp_host, smtp_port, smtp_encryption, smtp_username, smtp_password, smtp_from_email, smtp_from_name, captcha_provider, cloudflare_turnstile_site_key, cloudflare_turnstile_secret_key, hcaptcha_site_key, hcaptcha_secret_key, google_recaptcha_site_key, google_recaptcha_secret_key } = req.body;

  db.setSetting('site_name', site_name || 'Panel');
  db.setSetting('timezone', timezone || 'UTC');
  db.setSetting('default_language', default_language || 'en');
  db.setSetting('show_server_description', show_server_description === '0' ? '0' : '1');
  db.setSetting('two_factor_auth', ['None', 'Admin Only', 'All Users'].includes(two_factor_auth) ? two_factor_auth : 'None');
  db.setSetting('smtp_host', smtp_host || '');
  db.setSetting('smtp_port', smtp_port || '587');
  db.setSetting('smtp_encryption', smtp_encryption || 'tls');
  db.setSetting('smtp_username', smtp_username || '');
  if (smtp_password) db.setSetting('smtp_password', smtp_password);
  db.setSetting('smtp_from_email', smtp_from_email || '');
  db.setSetting('smtp_from_name', smtp_from_name || 'Panel');
  db.setSetting('captcha_provider', ['Disabled', 'Cloudflare Turnstile', 'HCaptcha', 'Google Recaptcha'].includes(captcha_provider) ? captcha_provider : 'Disabled');
  db.setSetting('cloudflare_turnstile_site_key', cloudflare_turnstile_site_key || '');
  db.setSetting('cloudflare_turnstile_secret_key', cloudflare_turnstile_secret_key || '');
  db.setSetting('hcaptcha_site_key', hcaptcha_site_key || '');
  db.setSetting('hcaptcha_secret_key', hcaptcha_secret_key || '');
  db.setSetting('google_recaptcha_site_key', google_recaptcha_site_key || '');
  db.setSetting('google_recaptcha_secret_key', google_recaptcha_secret_key || '');

  const uploadsDir = path.join(__dirname, '..', 'public', 'uploads', 'branding');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  if (req.files && req.files.page_logo) {
    const f = req.files.page_logo[0];
    const ext = path.extname(f.originalname) || '.png';
    const name = 'page-logo' + ext;
    fs.renameSync(f.path, path.join(uploadsDir, name));
    db.setSetting('branding_page_logo', '/static/uploads/branding/' + name);
  }

  if (req.files && req.files.favicon) {
    const f = req.files.favicon[0];
    const ext = path.extname(f.originalname) || '.png';
    const name = 'favicon' + ext;
    fs.renameSync(f.path, path.join(uploadsDir, name));
    db.setSetting('branding_favicon', '/static/uploads/branding/' + name);
  }

  res.redirect('/admin/settings');
});

// Reset both branding images (Page Logo and Favicon) to the defaults.
router.post('/settings/reset-branding', (req, res) => {
  db.setSetting('branding_page_logo', '/static/img/Pylox_no_bg.png');
  db.setSetting('branding_favicon', '/static/img/Pylox_no_bg.png');
  res.redirect('/admin/settings');
});

// Test SMTP using the current form values (not necessarily saved yet).
router.post('/settings/test-smtp', (req, res) => {
  const cfg = {
    host: String(req.body.smtp_host || '').trim(),
    port: parseInt(req.body.smtp_port, 10) || 587,
    encryption: req.body.smtp_encryption || 'tls',
    username: String(req.body.smtp_username || '').trim(),
    password: req.body.smtp_password || db.getSetting('smtp_password', ''),
    fromEmail: String(req.body.smtp_from_email || '').trim(),
    fromName: String(req.body.smtp_from_name || 'Panel').trim(),
  };
  if (!cfg.host || !cfg.fromEmail) {
    return res.status(400).json({ error: req.t('admin.settings.testConfigError') });
  }
  const siteName = db.getSetting('site_name', 'Panel');
  const baseUrl = baseurl.resolveBaseUrl(req);
  mailer.sendTemplateEmail({
    to: req.user.email,
    subject: req.t('mail.testSubject', { siteName }),
    title: req.t('mail.testTitle'),
    greeting: req.t('mail.testGreeting', { username: req.user.username }),
    body: [{ text: req.t('mail.testBody', { siteName }) }],
    note: req.t('mail.testNote'),
    config: cfg,
    baseUrl,
  }).then(() => {
    res.json({ ok: true });
  }).catch((err) => {
    res.status(500).json({ error: (err && err.message ? err.message : String(err)).substring(0, 500) });
  });
});

// ── Extensions ──────────────────────────────────────────────────
router.get('/extensions', (req, res) => {
  let list = [];
  try { list = extensions.list(); } catch (e) { console.error('[admin] list extensions:', e.message); }
  res.render('admin/extensions', {
    section: 'extensions',
    extensionsList: list,
    notice: req.query.notice || null,
    errorMsg: req.query.error || null,
  });
});

// Upload a .zip extension. Registered before /extensions/:id so "upload" is not
// treated as an extension id.
router.post('/extensions/upload', extensionUpload.single('extension'), async (req, res) => {
  if (!req.file) return res.redirect('/admin/extensions?error=' + encodeURIComponent(req.t('admin.extensions.noFile')));

  const zipPath = req.file.path;
  const cleanup = () => { try { fs.unlinkSync(zipPath); } catch {} };

  const isZip = /\.zip$/i.test(req.file.originalname || '') ||
    req.file.mimetype === 'application/zip' ||
    req.file.mimetype === 'application/x-zip-compressed';
  if (!isZip) {
    cleanup();
    return res.redirect('/admin/extensions?error=' + encodeURIComponent(req.t('admin.extensions.notZip')));
  }

  try {
    const manifest = await extensions.installFromZip(zipPath);
    cleanup();
    res.redirect('/admin/extensions/' + manifest.id + '?notice=' + encodeURIComponent(req.t('admin.extensions.installed')));
  } catch (e) {
    console.error('[admin] install extension:', e.message);
    cleanup();
    res.redirect('/admin/extensions?error=' + encodeURIComponent(e.message));
  }
});

router.get('/extensions/:id', (req, res) => {
  const ext = extensions.get(req.params.id);
  if (!ext) return res.redirect('/admin/extensions');
  res.render('admin/extension-edit', {
    section: 'extensions',
    ext,
    notice: req.query.notice || null,
  });
});

router.post('/extensions/:id', (req, res) => {
  const ext = extensions.get(req.params.id);
  if (!ext) return res.redirect('/admin/extensions');

  const values = {};
  for (const field of (ext.settings_schema || [])) {
    const key = field.key;
    if (!key) continue;
    const type = field.type || 'text';
    if (type === 'boolean') {
      values[key] = (req.body[key] === 'on' || req.body[key] === '1' || req.body[key] === 'true') ? true : false;
    } else if (type === 'password') {
      // Keep the existing secret when the field is left blank.
      const v = req.body[key];
      if (v !== undefined && v !== '') values[key] = String(v);
    } else {
      if (req.body[key] !== undefined) values[key] = String(req.body[key]);
    }
  }

  try {
    extensions.saveSettings(req.params.id, values);
  } catch (e) {
    console.error('[admin] save extension settings:', e.message);
  }
  res.redirect('/admin/extensions/' + req.params.id + '?notice=' + encodeURIComponent(req.t('admin.extensions.saved')));
});

router.post('/extensions/:id/toggle', (req, res) => {
  const ext = extensions.get(req.params.id);
  if (ext) {
    try { extensions.setEnabled(req.params.id, !ext.enabled); } catch (e) { console.error('[admin] toggle extension:', e.message); }
  }
  res.redirect('/admin/extensions');
});

router.post('/extensions/:id/delete', (req, res) => {
  try { extensions.uninstall(req.params.id); } catch (e) { console.error('[admin] delete extension:', e.message); }
  res.redirect('/admin/extensions');
});

module.exports = router;