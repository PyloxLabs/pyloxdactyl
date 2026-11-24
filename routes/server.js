const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { authRequired, serverAccess, requireServerOwner, requirePermission } = require('../middleware/auth');
const { PERMISSION_GROUPS, parsePermissions, sanitizePermissions, defaultSection } = require('../lib/permissions');
const daemonLib = require('../lib/daemon');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const unzipper = require('unzipper');
const mime = require('mime-types');
const { isExecutable } = require('../lib/executable');
const { isCompressed } = require('../lib/archive');

const upload = multer({ dest: path.join(__dirname, '..', 'data', 'uploads') });

function genSftpPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

// Accept a single `file` or repeated `files` entries from a form body.
function filesParam(body) {
  const raw = body.files === undefined ? body.file : body.files;
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// A suspended server is fully locked down in the client panel. This guard runs
// before every server route, so no tab (console, files, backups, network,
// schedules, startup, settings, users), power action, download, or polling
// endpoint can be reached until an administrator unsuspends the server.
router.use('/:serverId', authRequired, serverAccess, (req, res, next) => {
  if (req.server && req.server.suspended) {
    return res.status(403).render('server/suspended', { title: req.t('server.suspended.title') });
  }
  next();
});

// Server console
router.get('/:serverId', authRequired, serverAccess, async (req, res) => {
  // Subusers without console access are sent to the first section they can use.
  if (req.serverPermissions && !req.serverPermissions.includes('console.view')) {
    const section = defaultSection(req.serverPermissions);
    if (section) return res.redirect(`/server/${req.server.id}/${section}`);
    return res.status(403).render('errors/403');
  }
  let status = 'not_created';
  let resources = { cpu: 0, memory: 0, memory_limit: 0 };
  let uptime = 0;
  let daemonConnected = false;
  try {
    // Single round trip: /stats already carries the live status and start time.
    // Bounded so an unreachable node cannot stall the console page render.
    const stats = await daemonLib.getServerStatsSafe(req.server.uuid, 2500);
    resources = stats || {};
    daemonConnected = !!(stats && (typeof stats.status === 'string' || stats.cpu !== undefined));
    if (daemonConnected) {
      status = typeof stats.status === 'string' ? stats.status : 'not_created';
      if (status === 'running' && stats.startedAt) {
        const since = new Date(stats.startedAt).getTime();
        if (!isNaN(since) && since > 0) uptime = Math.max(0, Math.floor((Date.now() - since) / 1000));
      }
    }
  } catch {}
  if (!daemonConnected) {
    // The daemon is unreachable, so its status is unknown rather than absent.
    status = 'reconnecting';
  }

  // Keep the DB in step with what the daemon (which owns Docker) reports. Skip
  // this while reconnecting, since the transient status is not authoritative.
  if (daemonConnected) {
    const dbStatus = status === 'not_created' ? 'offline' : status;
    if (dbStatus && dbStatus !== req.server.status) {
      try { db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(dbStatus, req.server.id); } catch (_) { /* ignore */ }
      req.server.status = dbStatus;
    }
  }

  const allocation = req.server.allocation_id 
    ? db.prepare('SELECT * FROM allocations WHERE id = ?').get(req.server.allocation_id) 
    : null;
  const node = req.server.node_id
    ? db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.server.node_id)
    : null;

  res.render('server/console', { status, resources, allocation, node, uptime, daemonConnected });
});

// Server files
router.get('/:serverId/files', authRequired, serverAccess, requirePermission('files.read'), async (req, res) => {
  const dirPath = req.query.dir || '/';

  let files = [];
  let filesError = null;
  try {
    const data = await daemonLib.fileList(req.server.uuid, dirPath);
    if (data && data.exists === false) {
      // The daemon answered, but it does not see this directory on disk.
      filesError = dirPath === '/'
        ? 'The node could not find this server\'s data directory on disk.'
        : `The node could not find "${dirPath}" on disk.`;
    } else {
      files = (data && data.files) ? data.files : [];
    }
  } catch (e) {
    // Previously this was swallowed and rendered as an empty folder, which hid
    // real failures (unreachable node, 404, timeout, permission errors).
    console.error('[files] list:', e.message);
    filesError = e.message || 'Could not load files from the node.';
  }

  res.render('server/files', { files, currentPath: dirPath, isExecutable, isCompressed, filesError });
});

// File upload
router.post('/:serverId/files/upload', authRequired, serverAccess, requirePermission('files.write'), upload.array('files', 20), async (req, res) => {
  const dir = req.body.dir || '/';
  const base = dir === '/' ? '' : dir;

  try {
    for (const file of req.files) {
      const buffer = fs.readFileSync(file.path);
      const remotePath = `${base}/${file.originalname}`.replace(/\/+/g, '/');
      await daemonLib.fileUpload(req.server.uuid, remotePath, buffer);
      try { fs.unlinkSync(file.path); } catch {}
    }
  } catch (e) {
    console.error('[files] upload:', e.message);
  }
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(dir)}`);
});

// File edit
router.get('/:serverId/files/edit', authRequired, serverAccess, requirePermission('files.write'), async (req, res) => {
  let filePath = req.query.path;
  if (!filePath) return res.redirect(`/server/${req.server.id}/files`);
  if (req.query.newfile) {
    filePath = `${filePath === '/' ? '' : filePath}/${req.query.newfile}`.replace(/\/+/g, '/');
  }

  if (isExecutable(filePath) || isCompressed(filePath)) return res.status(403).render('errors/403');

  let content = '';
  try {
    content = (await daemonLib.fileRead(req.server.uuid, filePath)).toString('utf8');
  } catch (e) {
    // 404 means the file does not exist yet, which is the normal "new file"
    // case. Any other failure (unreachable node, timeout, daemon error) must
    // NOT render an empty editor: saving it would silently wipe the real file.
    if (!(e && e.status === 404)) {
      const dir = path.posix.dirname(filePath) || '/';
      return res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(dir)}`);
    }
  }

  res.render('server/file-edit', { filePath, content });
});

router.post('/:serverId/files/edit', authRequired, serverAccess, requirePermission('files.write'), async (req, res) => {
  const filePath = req.body.path;
  const content = req.body.content;
  if (isExecutable(filePath) || isCompressed(filePath)) {
    if (req.headers['x-requested-with'] === 'XMLHttpRequest') return res.status(403).json({ ok: false });
    return res.status(403).render('errors/403');
  }
  try {
    await daemonLib.fileWrite(req.server.uuid, filePath, content);
  } catch (e) {
    console.error('[files] write:', e.message);
    if (req.headers['x-requested-with'] === 'XMLHttpRequest') return res.status(500).json({ ok: false });
  }
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') return res.json({ ok: true });
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(path.dirname(filePath))}`);
});

// File delete
router.post('/:serverId/files/delete', authRequired, serverAccess, requirePermission('files.delete'), async (req, res) => {
  const files = filesParam(req.body);
  const redirectDir = req.body.dir || (files[0] && path.dirname(files[0])) || '/';
  try {
    for (const file of files) await daemonLib.fileDelete(req.server.uuid, file);
  } catch (e) {
    console.error('[files] delete:', e.message);
  }
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(redirectDir)}`);
});

// Create a new folder
router.post('/:serverId/files/mkdir', authRequired, serverAccess, requirePermission('files.write'), async (req, res) => {
  const { dir, name } = req.body;
  const base = dir === '/' ? '' : dir;
  const remotePath = `${base}/${(name || '').trim()}`.replace(/\/+/g, '/');
  try {
    await daemonLib.fileMkdir(req.server.uuid, remotePath);
  } catch (e) {
    console.error('[files] mkdir:', e.message);
  }
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(dir || '/')}`);
});

// Rename a file or folder
router.post('/:serverId/files/rename', authRequired, serverAccess, requirePermission('files.write'), async (req, res) => {
  const { file, name } = req.body;
  const redirectDir = path.dirname(file);
  try {
    await daemonLib.fileRename(req.server.uuid, file, name);
  } catch (e) {
    console.error('[files] rename:', e.message);
  }
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(redirectDir)}`);
});

// Move a file or folder into another directory
router.post('/:serverId/files/move', authRequired, serverAccess, requirePermission('files.write'), async (req, res) => {
  const files = filesParam(req.body);
  const toDir = req.body.toDir || '/';
  const redirectDir = files[0] ? path.dirname(files[0]) : '/';
  try {
    for (const file of files) await daemonLib.fileMove(req.server.uuid, file, toDir);
  } catch (e) {
    console.error('[files] move:', e.message);
  }
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(redirectDir)}`);
});

// Change permissions
router.post('/:serverId/files/permissions', authRequired, serverAccess, requirePermission('files.write'), async (req, res) => {
  const { file, mode } = req.body;
  const redirectDir = path.dirname(file);
  try {
    await daemonLib.fileChmod(req.server.uuid, file, mode);
  } catch (e) {
    console.error('[files] chmod:', e.message);
  }
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(redirectDir)}`);
});

// Archive (zip) a file or folder
router.post('/:serverId/files/archive', authRequired, serverAccess, requirePermission('files.write'), async (req, res) => {
  const files = filesParam(req.body);
  const redirectDir = files[0] ? path.dirname(files[0]) : '/';
  try {
    for (const file of files) await daemonLib.fileCompress(req.server.uuid, file);
  } catch (e) {
    console.error('[files] compress:', e.message);
  }
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(redirectDir)}`);
});

// Unarchive (extract) an archive into its containing directory
router.post('/:serverId/files/extract', authRequired, serverAccess, requirePermission('files.write'), async (req, res) => {
  const file = req.body.file || filesParam(req.body)[0];
  const redirectDir = file ? path.dirname(file) : '/';
  try {
    await daemonLib.fileExtract(req.server.uuid, file);
  } catch (e) {
    console.error('[files] extract:', e.message);
  }
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(redirectDir)}`);
});

// Duplicate a file or folder
router.post('/:serverId/files/duplicate', authRequired, serverAccess, requirePermission('files.write'), async (req, res) => {
  const { file } = req.body;
  const redirectDir = path.dirname(file);
  const base = path.basename(file);
  try {
    let copyName = `${base} - copy`;
    // Avoid colliding with an existing sibling by suffixing a counter.
    try {
      const listing = await daemonLib.fileList(req.server.uuid, redirectDir);
      const names = new Set(((listing && listing.files) || []).map((f) => f.name));
      if (names.has(copyName)) {
        let i = 2;
        while (names.has(`${base} - copy ${i}`)) i += 1;
        copyName = `${base} - copy ${i}`;
      }
    } catch {}
    await daemonLib.fileCopy(req.server.uuid, file, copyName);
  } catch (e) {
    console.error('[files] copy:', e.message);
  }
  res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(redirectDir)}`);
});

// Download a file (folders are streamed as a zip)
router.get('/:serverId/files/download', authRequired, serverAccess, requirePermission('files.read'), async (req, res) => {
  const file = req.query.path;
  if (!file) return res.redirect(`/server/${req.server.id}/files`);
  try {
    await daemonLib.fileDownload(req.server.uuid, file, res);
  } catch (e) {
    console.error('[files] download:', e.message);
    if (!res.headersSent) res.redirect(`/server/${req.server.id}/files?dir=${encodeURIComponent(path.dirname(file))}`);
  }
});

// Server databases
router.get('/:serverId/databases', authRequired, serverAccess, requirePermission('databases.view'), (req, res) => {
  const databases = db.prepare('SELECT * FROM databases WHERE server_id = ?').all(req.server.id);
  res.render('server/databases', { databases });
});

router.post('/:serverId/databases/create', authRequired, serverAccess, requirePermission('databases.create'), (req, res) => {
  const { name } = req.body;
  const dbName = `s${req.server.id}_${name.replace(/[^a-zA-Z0-9_]/g, '')}`;
  const dbUser = `u${Math.random().toString(36).substring(2, 10)}`;
  const dbPass = require('crypto').randomBytes(16).toString('hex');
  
  db.prepare('INSERT INTO databases (server_id, name, username, password) VALUES (?, ?, ?, ?)').run(req.server.id, dbName, dbUser, dbPass);
  res.redirect(`/server/${req.server.id}/databases`);
});

router.post('/:serverId/databases/delete', authRequired, serverAccess, requirePermission('databases.delete'), (req, res) => {
  const { databaseId } = req.body;
  db.prepare('DELETE FROM databases WHERE id = ? AND server_id = ?').run(databaseId, req.server.id);
  res.redirect(`/server/${req.server.id}/databases`);
});

// Server backups
const backupsDir = path.join(__dirname, '..', 'data', 'backups');

// Human-readable byte size (e.g. "1.2 MB").
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

router.get('/:serverId/backups', authRequired, serverAccess, requirePermission('backups.view'), (req, res) => {
  const backups = db.prepare('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC').all(req.server.id);
  for (const b of backups) b.sizeText = formatBytes(b.size);
  const error = typeof req.query.error === 'string' ? req.query.error : null;
  const message = typeof req.query.message === 'string' ? req.query.message : null;
  const success = typeof req.query.success === 'string' ? req.query.success : null;
  res.render('server/backups', { backups, error, message, success });
});

router.post('/:serverId/backups/create', authRequired, serverAccess, requirePermission('backups.create'), async (req, res) => {
  const name = (req.body.name || '').trim() || `backup-${Date.now()}`;
  const ignored = (req.body.ignored || '').trim();
  const locked = req.body.locked ? 1 : 0;
  const backupFile = `${req.server.uuid}-${Date.now()}.zip`;
  const backupPath = path.join(backupsDir, backupFile);

  try {
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const size = await daemonLib.backupServer(req.server.uuid, ignored, backupPath);
    db.prepare('INSERT INTO backups (server_id, name, file, size, ignored_files, locked) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.server.id, name, backupFile, size || 0, ignored || null, locked);
  } catch (e) {
    console.error('[backups] create:', e.message);
    try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    return res.redirect(`/server/${req.server.id}/backups?error=${encodeURIComponent(e.message)}`);
  }
  res.redirect(`/server/${req.server.id}/backups`);
});

router.post('/:serverId/backups/delete', authRequired, serverAccess, requirePermission('backups.delete'), (req, res) => {
  const { backupId, password } = req.body;
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(backupId, req.server.id);
  if (backup && backup.locked) {
    return res.redirect(`/server/${req.server.id}/backups?error=${encodeURIComponent('locked')}`);
  }
  if (!password || !bcrypt.compareSync(String(password), req.user.password)) {
    return res.redirect(`/server/${req.server.id}/backups?error=${encodeURIComponent('password')}`);
  }
  if (backup && backup.file) {
    const bp = path.join(backupsDir, backup.file);
    try { fs.unlinkSync(bp); } catch {}
  }
  db.prepare('DELETE FROM backups WHERE id = ?').run(backupId);
  res.redirect(`/server/${req.server.id}/backups?success=deleted`);
});

router.post('/:serverId/backups/lock', authRequired, serverAccess, requirePermission('backups.create'), (req, res) => {
  const { backupId } = req.body;
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(backupId, req.server.id);
  if (backup) {
    db.prepare('UPDATE backups SET locked = ? WHERE id = ?').run(backup.locked ? 0 : 1, backup.id);
  }
  res.redirect(`/server/${req.server.id}/backups`);
});

router.post('/:serverId/backups/restore', authRequired, serverAccess, requirePermission('backups.restore'), async (req, res) => {
  const { backupId, password } = req.body;
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(backupId, req.server.id);
  if (!backup || !backup.file) {
    return res.redirect(`/server/${req.server.id}/backups?error=${encodeURIComponent('missing')}`);
  }
  if (!password || !bcrypt.compareSync(String(password), req.user.password)) {
    return res.redirect(`/server/${req.server.id}/backups?error=${encodeURIComponent('password')}`);
  }
  const bp = path.join(backupsDir, backup.file);
  if (!fs.existsSync(bp)) {
    return res.redirect(`/server/${req.server.id}/backups?error=${encodeURIComponent('missing')}`);
  }

  try {
    let wasRunning = false;
    try { wasRunning = (await daemonLib.getServerStatus(req.server.uuid)) === 'running'; } catch {}
    if (wasRunning) await daemonLib.stopServer(req.server.uuid);

    await daemonLib.restoreBackup(req.server.uuid, bp);

    if (wasRunning && !req.server.suspended) {
      try { await daemonLib.startServer(req.server.uuid); } catch (e) { console.error('[backups] restart after restore:', e.message); }
    }
  } catch (e) {
    console.error('[backups] restore:', e.message);
    return res.redirect(`/server/${req.server.id}/backups?error=restore&message=${encodeURIComponent(e.message)}`);
  }
  res.redirect(`/server/${req.server.id}/backups?success=restored`);
});

router.get('/:serverId/backups/download', authRequired, serverAccess, requirePermission('backups.view'), (req, res) => {
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(req.query.id, req.server.id);
  if (!backup || !backup.file) return res.redirect(`/server/${req.server.id}/backups`);
  const bp = path.join(backupsDir, backup.file);
  if (!fs.existsSync(bp)) return res.redirect(`/server/${req.server.id}/backups?error=${encodeURIComponent('missing')}`);
  const safeName = (backup.name || 'backup').replace(/[^a-zA-Z0-9._-]+/g, '_');
  res.download(bp, `${safeName}.zip`);
});

// Server network allocations
function allocationLimit(server) {
  const limit = parseInt(server.allocation_limit, 10);
  return Number.isFinite(limit) && limit > 0 ? limit : 0; // 0 = unlimited
}

function allocationsAtLimit(server) {
  const limit = allocationLimit(server);
  if (!limit) return false;
  const count = db.prepare('SELECT COUNT(*) as c FROM allocations WHERE server_id = ?').get(server.id).c;
  return Number(count) >= limit;
}

function networkRedirect(req, query) {
  return `/server/${req.server.id}/network${query ? '?' + query : ''}`;
}

// Pick the next free allocation automatically. Prefer another address on the
// same IP as the primary allocation, then fall back to any free port on the node.
function pickFreeAllocation(server) {
  const primary = server.allocation_id
    ? db.prepare('SELECT * FROM allocations WHERE id = ?').get(server.allocation_id)
    : null;
  let alloc = null;
  if (primary && primary.ip) {
    alloc = db.prepare(`
      SELECT * FROM allocations
      WHERE node_id = ? AND server_id IS NULL AND ip = ?
      ORDER BY port ASC LIMIT 1
    `).get(server.node_id, primary.ip);
  }
  if (!alloc) {
    alloc = db.prepare(`
      SELECT * FROM allocations
      WHERE node_id = ? AND server_id IS NULL
      ORDER BY ip, port ASC LIMIT 1
    `).get(server.node_id);
  }
  return alloc || null;
}

async function syncAllocationConfig(req) {
  try {
    await daemonLib.syncServerConfig(req.server.uuid);
    return '';
  } catch (e) {
    console.error('[network] refresh container config:', e.message);
    return '&warning=sync';
  }
}

router.get('/:serverId/network', authRequired, serverAccess, requirePermission('network.view'), (req, res) => {
  const allocations = db.prepare(`
    SELECT a.*, n.name AS node_name FROM allocations a
    LEFT JOIN nodes n ON a.node_id = n.id
    WHERE a.server_id = ?
    ORDER BY CASE WHEN a.id = ? THEN 0 ELSE 1 END, a.ip, a.port
  `).all(req.server.id, req.server.allocation_id || -1);
  const freeAllocations = db.prepare(`
    SELECT a.*, n.name AS node_name FROM allocations a
    LEFT JOIN nodes n ON a.node_id = n.id
    WHERE a.server_id IS NULL AND a.node_id = ?
    ORDER BY a.ip, a.port
  `).all(req.server.node_id);
  const primary = req.server.allocation_id
    ? db.prepare('SELECT ip FROM allocations WHERE id = ?').get(req.server.allocation_id)
    : null;
  const error = typeof req.query.error === 'string' ? req.query.error : null;
  const success = typeof req.query.success === 'string' ? req.query.success : null;
  const warning = typeof req.query.warning === 'string' ? req.query.warning : null;
  res.render('server/network', {
    allocations,
    freeAllocations,
    autoAssignIp: primary && primary.ip ? primary.ip : null,
    allocationLimit: allocationLimit(req.server),
    canAdd: !allocationsAtLimit(req.server),
    error, success, warning,
  });
});

router.post('/:serverId/network/add', authRequired, serverAccess, requirePermission('network.create'), async (req, res) => {
  // The client never supplies a port: the next free allocation is chosen here.
  if (allocationsAtLimit(req.server)) {
    return res.redirect(networkRedirect(req, 'error=limit'));
  }
  const alloc = pickFreeAllocation(req.server);
  if (!alloc) return res.redirect(networkRedirect(req, 'error=nofree'));
  // The guard also protects against a concurrent assignment of the same row.
  const result = db.prepare(`
    UPDATE allocations SET server_id = ?
    WHERE id = ? AND server_id IS NULL AND node_id = ?
  `).run(req.server.id, alloc.id, req.server.node_id);
  if (!result.changes) return res.redirect(networkRedirect(req, 'error=nofree'));
  const warning = await syncAllocationConfig(req);
  res.redirect(networkRedirect(req, `success=added${warning}`));
});

router.post('/:serverId/network/primary', authRequired, serverAccess, requirePermission('network.create'), async (req, res) => {
  const allocationId = parseInt(req.body.allocation_id, 10);
  if (!Number.isInteger(allocationId) || allocationId <= 0) {
    return res.redirect(networkRedirect(req, 'error=invalid'));
  }
  const alloc = db.prepare('SELECT * FROM allocations WHERE id = ?').get(allocationId);
  if (!alloc || Number(alloc.server_id) !== Number(req.server.id) || Number(alloc.node_id) !== Number(req.server.node_id)) {
    return res.redirect(networkRedirect(req, 'error=invalid'));
  }
  db.prepare('UPDATE servers SET allocation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(allocationId, req.server.id);
  const warning = await syncAllocationConfig(req);
  res.redirect(networkRedirect(req, `success=primary${warning}`));
});

router.post('/:serverId/network/delete', authRequired, serverAccess, requirePermission('network.delete'), async (req, res) => {
  const allocationId = parseInt(req.body.allocation_id, 10);
  const primaryId = Number(req.server.allocation_id) || -1;
  if (!Number.isInteger(allocationId) || allocationId <= 0) {
    return res.redirect(networkRedirect(req, 'error=invalid'));
  }
  // The primary allocation belongs to the server's identity: admins change it.
  if (allocationId === primaryId) {
    return res.redirect(networkRedirect(req, 'error=primary'));
  }
  const result = db.prepare(`
    UPDATE allocations SET server_id = NULL
    WHERE id = ? AND server_id = ? AND id <> ?
  `).run(allocationId, req.server.id, primaryId);
  if (!result.changes) return res.redirect(networkRedirect(req, 'error=invalid'));
  const warning = await syncAllocationConfig(req);
  res.redirect(networkRedirect(req, `success=deleted${warning}`));
});

// Server schedules
router.get('/:serverId/schedules', authRequired, serverAccess, requirePermission('schedules.view'), (req, res) => {
  const tasks = db.prepare('SELECT * FROM schedule_tasks WHERE server_id = ?').all(req.server.id);
  res.render('server/schedules', { tasks });
});

router.post('/:serverId/schedules/create', authRequired, serverAccess, requirePermission('schedules.manage'), (req, res) => {
  const { action, cron } = req.body;
  db.prepare('INSERT INTO schedule_tasks (server_id, action, cron) VALUES (?, ?, ?)').run(req.server.id, action, cron);
  res.redirect(`/server/${req.server.id}/schedules`);
});

router.post('/:serverId/schedules/delete', authRequired, serverAccess, requirePermission('schedules.manage'), (req, res) => {
  db.prepare('DELETE FROM schedule_tasks WHERE id = ? AND server_id = ?').run(req.body.taskId, req.server.id);
  res.redirect(`/server/${req.server.id}/schedules`);
});

// Server startup / egg variables
function loadEggForServer(server) {
  return server.egg_id ? db.prepare('SELECT * FROM eggs WHERE id = ?').get(server.egg_id) : null;
}

// Available docker images for an egg, as [{ image, label }].
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
  } catch (_) { /* fall through */ }
  if (out.length === 0 && egg.docker_image) out.push({ image: egg.docker_image, label: null });
  return out;
}

router.get('/:serverId/startup', authRequired, serverAccess, requirePermission('startup.view'), (req, res) => {
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
  res.render('server/startup', {
    egg,
    variables,
    startupCommand,
    saved: req.query.saved === '1',
    eggImages: eggImageList(egg),
    currentImage: req.server.image || null,
  });
});

router.post('/:serverId/startup', authRequired, serverAccess, requirePermission('startup.edit'), (req, res) => {
  const egg = loadEggForServer(req.server);
  if (egg) {
    const variables = db.prepare('SELECT * FROM egg_variables WHERE egg_id = ?').all(egg.id);
    for (const v of variables) {
      if (!v.user_editable) continue;
      const val = req.body[`var_${v.env_var}`];
      if (val === undefined) continue;
      const existing = db.prepare('SELECT id FROM server_variables WHERE server_id = ? AND env_var = ?').get(req.server.id, v.env_var);
      if (existing) db.prepare('UPDATE server_variables SET value = ? WHERE id = ?').run(val, existing.id);
      else db.prepare('INSERT INTO server_variables (server_id, env_var, value) VALUES (?, ?, ?)').run(req.server.id, v.env_var, val);
    }
  }
  if (req.body.image) {
    db.prepare('UPDATE servers SET image = ? WHERE id = ?').run(req.body.image, req.server.id);
  }
  db.save();
  // Autosave requests get a JSON response instead of a redirect.
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ ok: true });
  }
  // The daemon receives the updated variables on the next (re)start, since
  // startServer() pushes the full config before starting the container.
  res.redirect(`/server/${req.server.id}/startup?saved=1`);
});

// Server settings
router.get('/:serverId/settings', authRequired, serverAccess, requirePermission('settings.view'), async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.server.node_id);
  const sftpPort = (node && node.sftp_port) || 2022;
  const sftp = {
    address: 'sftp://' + ((node && node.fqdn) || 'localhost') + ':' + sftpPort,
    username: req.server.uuid,
  };
  if (!req.server.sftp_password) {
    const password = genSftpPassword();
    db.prepare('UPDATE servers SET sftp_password = ? WHERE id = ?').run(password, req.server.id);
    req.server.sftp_password = password;
    daemonLib.setSftpPassword(req.server.uuid, password).catch(() => {});
  }
  sftp.password = req.server.sftp_password;
  // The daemon names game containers "pylox-<uuid>" and stores their data in
  // /var/lib/rubityle/<uuid>, so show that UUID (the server's own UUID) rather
  // than Docker's internal 64-character container ID.
  const containerId = req.server.uuid;
  res.render('server/settings', { sftp, containerId, notice: req.query.notice, installStatus: req.server.install_status, installError: req.server.install_error });
});

router.post('/:serverId/sftp/regenerate', authRequired, serverAccess, requireServerOwner, async (req, res) => {
  const password = genSftpPassword();
  db.prepare('UPDATE servers SET sftp_password = ? WHERE id = ?').run(password, req.server.id);
  try {
    await daemonLib.setSftpPassword(req.server.uuid, password);
  } catch (e) {
    console.error('[files] push sftp password:', e.message);
  }
  res.redirect(`/server/${req.server.id}/settings?notice=sftpregenerated`);
});

router.post('/:serverId/settings', authRequired, serverAccess, requireServerOwner, (req, res) => {
  const { name, description } = req.body;
  db.prepare('UPDATE servers SET name=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, description, req.server.id);
  res.redirect(`/server/${req.server.id}/settings`);
});

// Server resources API (for console polling)
router.get('/:serverId/api/resources', authRequired, serverAccess, requirePermission('console.view'), async (req, res) => {
  let resources = {};
  let status = null;
  let uptime = 0;
  let connected = false;
  try {
    // One round trip: the daemon's /stats already carries the live status and
    // started-at timestamp, so we no longer ping and re-query /status on top.
    // Bounded so a stalled node cannot hang the polling request.
    resources = await daemonLib.getServerStatsSafe(req.server.uuid, 2500);
    if (resources && (typeof resources.status === 'string' || resources.cpu !== undefined)) {
      connected = true;
      if (typeof resources.status === 'string') status = resources.status;
      if (status === 'running' && resources.startedAt) {
        const since = new Date(resources.startedAt).getTime();
        if (!isNaN(since) && since > 0) uptime = Math.max(0, Math.floor((Date.now() - since) / 1000));
      }
      // Keep the DB in step with the daemon (which owns Docker) so a server
      // stopped by resource-limit enforcement does not stay "running" in the UI.
      if (status) {
        const dbStatus = status === 'not_created' ? 'offline' : status;
        if (dbStatus !== req.server.status) {
          try { db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(dbStatus, req.server.id); } catch (_) { /* ignore */ }
          req.server.status = dbStatus;
        }
      }
    }
  } catch {}
  res.json({
    cpu: Number(resources.cpu) || 0,
    memory: Number(resources.memory) || 0,
    memory_limit: Number(resources.memory_limit) || 0,
    disk: Number(resources.disk) || 0,
    disk_limit: (Number(req.server.disk) || 0) * 1024 * 1024,
    network_rx: Number(resources.network_rx) || 0,
    network_tx: Number(resources.network_tx) || 0,
    status,
    uptime,
    connected,
  });
});

// Server power actions
router.post('/:serverId/power', authRequired, serverAccess, requirePermission('console.power'), async (req, res) => {
  const { action } = req.body;
  const isAjax = req.get('X-Requested-With') === 'XMLHttpRequest';
  console.log('[power]', action, req.server.uuid);
  if (req.server.suspended) {
    const message = req.t('server.power.suspended');
    if (isAjax) return res.status(409).json({ ok: false, status: null, code: 'suspended', error: message });
    return res.redirect(`/server/${req.server.id}`);
  }
  let status = null;
  try {
    let result;
    switch (action) {
      case 'start': result = await daemonLib.startServer(req.server.uuid); break;
      case 'stop': result = await daemonLib.stopServer(req.server.uuid); break;
      case 'restart': result = await daemonLib.restartServer(req.server.uuid); break;
      case 'kill': result = await daemonLib.killServer(req.server.uuid); break;
      default: throw new Error('Unknown power action');
    }
    // The daemon's response is the source of truth for the post-action status.
    // Fall back to the optimistic guess only if the daemon did not report one.
    status = (result && result.status)
      || (action === 'stop' || action === 'kill' ? 'offline' : 'starting');
    if (status === 'not_created') status = 'offline';
    db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.server.id);
  } catch (e) {
    console.error('[power]', action, e.message);
    let message = e.message;
    if (e.code === 'disk_limit_blocked') {
      message = req.t('server.power.diskBlocked', {
        used: (e.data && e.data.used_mb) || 0,
        total: (e.data && e.data.limit_mb) || 0,
      });
    }
    if (isAjax) {
      return res.status(409).json({ ok: false, status: null, code: e.code || 'error', error: message });
    }
    return res.redirect(`/server/${req.server.id}`);
  }
  if (isAjax) {
    return res.json({ ok: true, status });
  }
  res.redirect(`/server/${req.server.id}`);
});

// Report whether the server's Minecraft EULA has already been accepted. The
// console checks this before prompting, since the daemon replays recent log
// history (which may still contain an old EULA notice) on connect.
router.get('/:serverId/eula', authRequired, serverAccess, requirePermission('console.view'), async (req, res) => {
  let accepted = false;
  try {
    const content = (await daemonLib.fileRead(req.server.uuid, '/eula.txt')).toString('utf8');
    accepted = /^\s*eula\s*=\s*true\s*$/mi.test(content);
  } catch (e) { /* no eula.txt yet => not accepted */ }
  res.json({ accepted });
});

// Minecraft EULA prompt shown on the console tab.
// Accepted: flip eula=false to eula=true in the server root, then restart.
// Declined: stop the server.
router.post('/:serverId/eula', authRequired, serverAccess, requirePermission('console.command'), async (req, res) => {
  const action = req.body && req.body.action;
  const isAjax = req.get('X-Requested-With') === 'XMLHttpRequest';
  if (req.server.suspended) {
    const message = req.t('server.power.suspended');
    if (isAjax) return res.status(409).json({ ok: false, error: message });
    return res.redirect(`/server/${req.server.id}`);
  }
  try {
    if (action === 'accept') {
      let content = '';
      try {
        content = (await daemonLib.fileRead(req.server.uuid, '/eula.txt')).toString('utf8');
      } catch (e) {
        content = '';
      }
      // Flip the existing eula= line to true, preserving comments and formatting.
      if (/^\s*eula\s*=/mi.test(content)) {
        content = content.replace(/^(\s*eula\s*=\s*).*$/mi, '$1true');
      } else {
        if (content && !/\n$/.test(content)) content += '\n';
        content += 'eula=true\n';
      }
      await daemonLib.fileWrite(req.server.uuid, '/eula.txt', content);
      let result;
      try { result = await daemonLib.restartServer(req.server.uuid); } catch (e) { result = null; }
      // The daemon reports the post-restart status (starting/running); use it
      // rather than assuming the server is already running.
      let eulaStatus = (result && result.status) || 'starting';
      if (eulaStatus === 'not_created') eulaStatus = 'starting';
      db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eulaStatus, req.server.id);
    } else {
      // The server usually exits on its own after logging the EULA notice, so a
      // stop failure here is harmless — we still mark it offline.
      try { await daemonLib.stopServer(req.server.uuid); } catch (e) { console.error('[eula] stop:', e.message); }
      db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('offline', req.server.id);
    }
  } catch (e) {
    console.error('[eula]', e.message);
    if (isAjax) return res.status(500).json({ ok: false, error: e.message });
    return res.redirect(`/server/${req.server.id}`);
  }
  if (isAjax) return res.json({ ok: true });
  res.redirect(`/server/${req.server.id}`);
});

// Server reinstall: run the egg's installation script in a disposable container.
// Runs in the background so the request returns immediately and progress is
// streamed to the server console.
router.post('/:serverId/reinstall', authRequired, serverAccess, requireServerOwner, (req, res) => {
  const serverId = req.server.id;
  const uuid = req.server.uuid;
  db.prepare('UPDATE servers SET install_status = "installing", install_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(serverId);

  (async () => {
    try {
      // Remove the existing runtime container so it is recreated cleanly.
      await daemonLib.removeServer(uuid).catch(() => {});
      await daemonLib.installServer(uuid);
      db.prepare('UPDATE servers SET install_status = "installed", install_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(serverId);
    } catch (e) {
      console.error('[reinstall]', e.message);
      db.prepare('UPDATE servers SET install_status = "install_failed", install_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(String(e.message).slice(0, 500), serverId);
    }
  })();

  res.redirect(`/server/${serverId}/settings?notice=reinstallstarted`);
});

// Server terminal
router.get('/:serverId/terminal', authRequired, serverAccess, requirePermission('console.view'), (req, res) => {
  res.render('server/terminal');
});

// Server users (subusers): the owner grants another panel account access to the
// server by email, choosing which permissions they hold.
function loadSubusers(serverId) {
  const rows = db.prepare(`
    SELECT su.id, su.permissions, su.created_at, u.username, u.email
    FROM subusers su
    JOIN users u ON su.user_id = u.id
    WHERE su.server_id = ?
    ORDER BY su.created_at ASC
  `).all(serverId);
  for (const row of rows) row.permissions = parsePermissions(row.permissions);
  return rows;
}

router.get('/:serverId/users', authRequired, serverAccess, requireServerOwner, (req, res) => {
  res.render('server/users', {
    subusers: loadSubusers(req.server.id),
    permissionGroups: PERMISSION_GROUPS,
    notice: typeof req.query.notice === 'string' ? req.query.notice : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.post('/:serverId/users/grant', authRequired, serverAccess, requireServerOwner, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const permissions = sanitizePermissions(req.body.permissions);
  const base = `/server/${req.server.id}/users`;

  const target = email ? db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email) : null;
  if (!target) return res.redirect(`${base}?error=notfound`);
  if (target.id === req.server.user_id) return res.redirect(`${base}?error=owner`);
  if (permissions.length === 0) return res.redirect(`${base}?error=noperms`);

  const existing = db.prepare('SELECT id FROM subusers WHERE server_id = ? AND user_id = ?').get(req.server.id, target.id);
  if (existing) {
    db.prepare('UPDATE subusers SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), existing.id);
    db.save();
    return res.redirect(`${base}?notice=updated`);
  }

  db.prepare('INSERT INTO subusers (server_id, user_id, permissions) VALUES (?, ?, ?)').run(req.server.id, target.id, JSON.stringify(permissions));
  db.save();
  res.redirect(`${base}?notice=granted`);
});

router.post('/:serverId/users/:subId/update', authRequired, serverAccess, requireServerOwner, (req, res) => {
  const base = `/server/${req.server.id}/users`;
  const sub = db.prepare('SELECT * FROM subusers WHERE id = ? AND server_id = ?').get(req.params.subId, req.server.id);
  if (!sub) return res.redirect(`${base}?error=notfound`);
  const permissions = sanitizePermissions(req.body.permissions);
  if (permissions.length === 0) return res.redirect(`${base}?error=noperms`);
  db.prepare('UPDATE subusers SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), sub.id);
  db.save();
  res.redirect(`${base}?notice=updated`);
});

router.post('/:serverId/users/:subId/delete', authRequired, serverAccess, requireServerOwner, (req, res) => {
  db.prepare('DELETE FROM subusers WHERE id = ? AND server_id = ?').run(req.params.subId, req.server.id);
  db.save();
  res.redirect(`/server/${req.server.id}/users?notice=removed`);
});

module.exports = router;
