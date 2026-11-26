const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const db = require('./db');

// Strip any protocol and port that admins may have pasted into the FQDN field
// so we never end up with addresses like "http://host:8080:8080".
function nodeHost(node) {
  let host = String((node && node.fqdn) || '').trim();
  host = host.replace(/^[a-z]+:\/\//i, '');
  host = host.replace(/\/.*$/, '');
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end !== -1) host = host.slice(0, end + 1);
  } else {
    host = host.replace(/:\d+$/, '');
  }
  return host;
}

// Compose a daemon base URL from a node row.
function daemonBaseUrl(node) {
  const scheme = node.scheme || 'http';
  const listen = String(node.daemon_listen || '8080');
  const port = parseInt(String(listen).split(':').pop(), 10) || 8080;
  return `${scheme}://${nodeHost(node)}:${port}`;
}

// Lightweight connectivity probe against a server's node. Resolves true when
// the daemon answers the authenticated /api/info endpoint, false otherwise.
async function pingNode(uuid) {
  const node = getNodeForServer(uuid);
  if (!node || !node.fqdn || !node.daemon_token) return false;
  try {
    await request(node, 'GET', '/api/info', null, { timeout: QUICK_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

// Resolve the node that a server is hosted on.
function getNodeForServer(uuid) {
  const srv = db.prepare('SELECT node_id FROM servers WHERE uuid = ?').get(uuid);
  if (!srv || !srv.node_id) return null;
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(srv.node_id);
  return node || null;
}

// Timeouts. Live calls (status/stats/ping) sit on page renders and polling
// loops, so they must fail fast; long operations (install, upload, download,
// backups) legitimately take minutes.
const QUICK_TIMEOUT = 5000;
const LONG_TIMEOUT = 300000;

// REST wrapper with x-daemon-token auth.
function request(node, method, path, body, options) {
  return new Promise((resolve, reject) => {
    if (!node || !node.fqdn || !node.daemon_token) {
      return reject(new Error('Daemon node is not configured'));
    }
    const lib = (node.scheme || 'http') === 'https' ? https : http;
    const url = daemonBaseUrl(node) + path;
    const parts = new URL(url);
    const payload = body ? JSON.stringify(body) : null;

    const req = lib.request({
      hostname: parts.hostname,
      port: parts.port || (parts.protocol === 'https:' ? 443 : 80),
      path: parts.pathname + parts.search,
      method,
      rejectUnauthorized: false,
      timeout: (options && options.timeout) || LONG_TIMEOUT,
      headers: {
        'x-daemon-token': node.daemon_token,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const err = new Error((json && json.error) ? json.error : `Daemon error ${res.statusCode}: ${data}`);
        err.statusCode = res.statusCode;
        if (json && typeof json === 'object') {
          err.code = json.code;
          err.data = json;
        }
        reject(err);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Daemon request timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── File management ─────────────────────────────────────────────────
function fileList(uuid, relPath, options) {
  const node = getNodeForServer(uuid);
  const q = relPath ? `?path=${encodeURIComponent(relPath)}` : '';
  return request(node, 'GET', `/api/servers/${uuid}/files${q}`, null, options || { timeout: QUICK_TIMEOUT });
}

// Reading a file feeds the editor page, so it must be bounded — but it still
// gets more headroom than a listing in case the file is large.
async function fileRead(uuid, relPath, options) {
  const node = getNodeForServer(uuid);
  const url = `${daemonBaseUrl(node)}/api/servers/${uuid}/files/read?path=${encodeURIComponent(relPath || '')}`;
  return new Promise((resolve, reject) => {
    const lib = (node.scheme || 'http') === 'https' ? https : http;
    const parts = new URL(url);
    const req = lib.request({
      hostname: parts.hostname,
      port: parts.port || (parts.protocol === 'https:' ? 443 : 80),
      path: parts.pathname + parts.search,
      method: 'GET',
      rejectUnauthorized: false,
      headers: { 'x-daemon-token': node.daemon_token },
      timeout: (options && options.timeout) || 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(Buffer.concat(chunks));
        } else {
          const err = new Error(`Daemon error ${res.statusCode}`);
          err.status = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Daemon read timed out')); });
    req.on('error', reject);
    req.end();
  });
}

function fileWrite(uuid, relPath, content, encoding) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/files/write`, { path: relPath, content, encoding });
}

function fileMkdir(uuid, relPath) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/files/mkdir`, { path: relPath });
}

function fileDelete(uuid, relPath) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/files/delete`, { path: relPath });
}

function fileUpload(uuid, relPath, buffer) {
  const node = getNodeForServer(uuid);
  const url = `${daemonBaseUrl(node)}/api/servers/${uuid}/files/upload?path=${encodeURIComponent(relPath)}`;
  return new Promise((resolve, reject) => {
    const lib = (node.scheme || 'http') === 'https' ? https : http;
    const parts = new URL(url);
    const req = lib.request({
      hostname: parts.hostname,
      port: parts.port || (parts.protocol === 'https:' ? 443 : 80),
      path: parts.pathname + parts.search,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'x-daemon-token': node.daemon_token,
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        reject(new Error((json && json.error) ? json.error : `Daemon error ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

function fileRename(uuid, relPath, newName) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/files/rename`, { path: relPath, newName });
}

function fileMove(uuid, relPath, toDir) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/files/move`, { path: relPath, toDir });
}

function fileCopy(uuid, relPath, newName) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/files/copy`, { path: relPath, newName });
}

function fileChmod(uuid, relPath, mode) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/files/chmod`, { path: relPath, mode });
}

function fileCompress(uuid, relPath, name) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/files/compress`, { path: relPath, name });
}

function fileExtract(uuid, relPath) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/files/extract`, { path: relPath });
}

// Stream a file (or zipped folder) from the daemon straight to an express response.
function fileDownload(uuid, relPath, res) {
  const node = getNodeForServer(uuid);
  return new Promise((resolve, reject) => {
    if (!node || !node.fqdn || !node.daemon_token) {
      return reject(new Error('Daemon node is not configured'));
    }
    const lib = (node.scheme || 'http') === 'https' ? https : http;
    const url = `${daemonBaseUrl(node)}/api/servers/${uuid}/files/download?path=${encodeURIComponent(relPath || '')}`;
    const parts = new URL(url);
    const req = lib.request({
      hostname: parts.hostname,
      port: parts.port || (parts.protocol === 'https:' ? 443 : 80),
      path: parts.pathname + parts.search,
      method: 'GET',
      rejectUnauthorized: false,
      headers: { 'x-daemon-token': node.daemon_token },
    }, (upstream) => {
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        upstream.resume();
        return reject(new Error(`Daemon error ${upstream.statusCode}`));
      }
      res.status(200);
      if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
      if (upstream.headers['content-disposition']) res.setHeader('Content-Disposition', upstream.headers['content-disposition']);
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      upstream.pipe(res);
      upstream.on('end', resolve);
      upstream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// Lightweight sanity check that a file on disk is a complete zip archive.
function looksLikeZip(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size < 22) return false;
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      if (head[0] !== 0x50 || head[1] !== 0x4b) return false;
      const tailLen = Math.min(stat.size, 0x10000 + 22);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);
      for (let i = tail.length - 22; i >= 0; i -= 1) {
        if (tail.readUInt32LE(i) === 0x06054b50) return true;
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// Ask the daemon to zip the server's entire data directory (honouring the
// given ignore patterns) and stream it straight into destPath. Resolves with
// the size in bytes once the archive has been fully written. Falls back to the
// generic directory-download route for daemons that predate /backup.
function backupServer(uuid, ignored, destPath) {
  const node = getNodeForServer(uuid);
  if (!node || !node.fqdn || !node.daemon_token) {
    return Promise.reject(new Error('Daemon node is not configured'));
  }

  const lib = (node.scheme || 'http') === 'https' ? https : http;

  function attempt(routePath) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, size) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve(size);
      };

      const parts = new URL(`${daemonBaseUrl(node)}${routePath}`);
      const req = lib.request({
        hostname: parts.hostname,
        port: parts.port || (parts.protocol === 'https:' ? 443 : 80),
        path: parts.pathname + parts.search,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: 300000,
        headers: { 'x-daemon-token': node.daemon_token },
      }, (upstream) => {
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
          let body = '';
          upstream.on('data', (c) => { body += c; });
          upstream.on('end', () => {
            let message = `Daemon error ${upstream.statusCode}`;
            try {
              const j = JSON.parse(body);
              if (j && j.error) message = j.error;
            } catch {
              const text = String(body).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
              if (text) message += `: ${text}`;
            }
            const err = new Error(message);
            err.statusCode = upstream.statusCode;
            done(err);
          });
          upstream.on('error', done);
          return;
        }
        const output = fs.createWriteStream(destPath);
        output.on('finish', () => {
          try {
            const size = fs.statSync(destPath).size;
            if (!looksLikeZip(destPath)) {
              try { fs.unlinkSync(destPath); } catch { /* ignore */ }
              return done(new Error('The daemon returned an incomplete or corrupt archive'));
            }
            done(null, size);
          } catch (e) { done(e); }
        });
        output.on('error', done);
        upstream.on('error', done);
        upstream.pipe(output);
      });
      req.on('timeout', () => req.destroy(new Error('Daemon request timed out')));
      req.on('error', done);
      req.end();
    });
  }

  const q = ignored ? `?ignored=${encodeURIComponent(ignored)}` : '';
  return attempt(`/api/servers/${uuid}/backup${q}`).catch((err) => {
    // The dedicated backup route may be missing (older daemon) or erroring; the
    // generic download route can still stream the whole server directory.
    if (err.statusCode === 404 || err.statusCode === 405 || err.statusCode === 500) {
      return attempt(`/api/servers/${uuid}/files/download?path=${encodeURIComponent('/')}`);
    }
    throw err;
  });
}

// Upload a local backup archive to the daemon and have it replace the server's
// data directory with the archive's contents. Resolves with the daemon's JSON.
function restoreBackup(uuid, backupPath) {
  const node = getNodeForServer(uuid);
  return new Promise((resolve, reject) => {
    if (!node || !node.fqdn || !node.daemon_token) {
      return reject(new Error('Daemon node is not configured'));
    }
    if (!looksLikeZip(backupPath)) {
      return reject(new Error('This backup file is incomplete or corrupt. Please create a new backup and try again.'));
    }
    let size;
    try { size = fs.statSync(backupPath).size; } catch (e) { return reject(e); }

    const lib = (node.scheme || 'http') === 'https' ? https : http;
    const parts = new URL(`${daemonBaseUrl(node)}/api/servers/${uuid}/restore`);
    const req = lib.request({
      hostname: parts.hostname,
      port: parts.port || (parts.protocol === 'https:' ? 443 : 80),
      path: parts.pathname + parts.search,
      method: 'POST',
      rejectUnauthorized: false,
      timeout: 600000,
      headers: {
        'x-daemon-token': node.daemon_token,
        'Content-Type': 'application/zip',
        'Content-Length': size,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        reject(new Error((json && json.error) ? json.error : `Daemon error ${res.statusCode}: ${data}`));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Daemon request timed out')); });
    req.on('error', reject);
    const stream = fs.createReadStream(backupPath);
    stream.on('error', reject);
    stream.pipe(req);
  });
}

// Build the container config for a server from its DB row + egg, matching
// what the daemon's POST /api/servers expects.
function buildServerConfig(uuid) {
  const srv = db.prepare('SELECT * FROM servers WHERE uuid = ?').get(uuid);
  if (!srv) throw new Error('Server not found in database');

  const DEFAULT_IMAGE = 'ghcr.io/pterodactyl/yolks:java_17';

  // Basic check for a usable Docker image reference (no whitespace, non-empty,
  // no uppercase in the repository path, must look like name[:tag] or host/name[:tag]).
  function isValidImageRef(img) {
    if (!img || typeof img !== 'string') return false;
    const s = img.trim();
    if (!s || /\s/.test(s)) return false;
    if (/[A-Z]/.test(s)) return false;
    return /^[a-z0-9._\/:-]+$/.test(s);
  }

  let egg = null;
  if (srv.egg_id) egg = db.prepare('SELECT * FROM eggs WHERE id = ?').get(srv.egg_id);

  // The egg's configured stop command (e.g. "stop" for Minecraft, "^C" for a
  // signal) and its startup detection line. Both live in egg.config: `stop` is
  // a plain string, while `startup` is itself a JSON string like
  // '{"done": ")! For help, type "}'. The daemon writes the stop command to the
  // console for a graceful shutdown, and reports "starting" until the startup
  // line shows up in the console, after which it flips to "running".
  let stopCommand = '';
  let startupDone = '';
  if (egg && egg.config) {
    try {
      const eggConfig = typeof egg.config === 'string' ? JSON.parse(egg.config) : egg.config;
      if (eggConfig && typeof eggConfig.stop === 'string') stopCommand = eggConfig.stop.trim();
      let startup = eggConfig && eggConfig.startup;
      if (typeof startup === 'string') { try { startup = JSON.parse(startup); } catch { startup = null; } }
      if (startup && typeof startup.done === 'string') startupDone = startup.done;
    } catch {}
  }

  let image = srv.image || (egg && egg.docker_image) || '';
  if (!isValidImageRef(image) && egg && egg.docker_images) {
    try {
      const map = JSON.parse(egg.docker_images);
      // Pterodactyl v2 eggs store values as the real image refs (keys are labels),
      // so prefer values, then fall back to keys.
      const candidates = [...Object.values(map), ...Object.keys(map)];
      image = candidates.find(isValidImageRef) || '';
    } catch {}
  }
  image = String(image).trim();
  if (!isValidImageRef(image)) image = DEFAULT_IMAGE;

  // Every allocation assigned to the server is published by its container.
  // The first (primary) allocation still drives SERVER_PORT / SERVER_IP.
  const serverAllocs = db.prepare('SELECT * FROM allocations WHERE server_id = ? ORDER BY id').all(srv.id);
  const primaryAlloc = srv.allocation_id
    ? (serverAllocs.find((a) => a.id === srv.allocation_id) || db.prepare('SELECT * FROM allocations WHERE id = ?').get(srv.allocation_id))
    : null;
  let port = 25565;
  if (primaryAlloc && primaryAlloc.port) port = primaryAlloc.port;

  // Build the container environment. Start with the built-in variables, layer
  // the egg's variable defaults on top, then apply any per-server overrides.
  const envMap = {
    SERVER_MEMORY: String(srv.memory),
    SERVER_PORT: String(port),
    SERVER_NAME: String(srv.name),
    SERVER_ID: String(srv.id),
    SERVER_UUID: String(srv.uuid),
  };
  if (egg) {
    const eggVars = db.prepare('SELECT env_var, default_value FROM egg_variables WHERE egg_id = ?').all(egg.id);
    for (const v of eggVars) {
      if (v.env_var) envMap[v.env_var] = v.default_value == null ? '' : String(v.default_value);
    }
  }
  const vars = db.prepare('SELECT * FROM server_variables WHERE server_id = ?').all(srv.id);
  for (const v of vars) {
    if (v.env_var) envMap[v.env_var] = v.value == null ? '' : String(v.value);
  }

  // Mirrors the daemon's renderStartup(); resolves {{VAR}} placeholders using
  // the merged env so install scripts can safely consume $STARTUP.
  function renderVars(text, e) {
    return String(text || '').replace(/\{\{\s*\.?([A-Za-z0-9_]+)\s*\}\}/g, (m, k) => (e[k] == null ? '' : String(e[k])));
  }

  const nodeRow = db.prepare('SELECT * FROM nodes WHERE id = ?').get(srv.node_id);
  const startupRaw = String(srv.startup_command || (egg ? egg.startup : '') || '').replace(/\r/g, '');
  envMap.STARTUP = renderVars(startupRaw, envMap);
  envMap.TZ = db.getSetting('timezone', 'UTC');
  let serverIp = '';
  if (primaryAlloc && primaryAlloc.ip) serverIp = primaryAlloc.ip;
  if (!serverIp && nodeRow && nodeRow.fqdn) serverIp = nodeRow.fqdn;
  if (serverIp) envMap.SERVER_IP = String(serverIp);

  const env = Object.keys(envMap).map((k) => `${k}=${envMap[k]}`);

  return {
    uuid: srv.uuid,
    name: srv.name,
    image,
    env,
    memory: srv.memory || 1024,
    swap: srv.swap || 0,
    cpu: srv.cpu || 100,
    io: srv.io || 500,
    disk: srv.disk || 0,
    ports: serverAllocs.length
      ? serverAllocs.map((a) => ({ ip: a.ip, container: a.port, host: a.port }))
      : [{ container: port, host: port }],
    startup: startupRaw,
    stopCommand,
    startupDone,
    sftpPassword: srv.sftp_password || '',
  };
}

// Push (or update) the SFTP password the daemon uses to authenticate the given
// server when clients connect over SFTP.
function setSftpPassword(uuid, password) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/sftp/password`, { password });
}

async function ensureServerOnDaemon(uuid) {
  const node = getNodeForServer(uuid);
  const result = await request(node, 'POST', '/api/servers', buildServerConfig(uuid));
  return result;
}

async function createServer(uuid, config) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', '/api/servers', config || buildServerConfig(uuid));
}

// Re-apply a server's config after an allocation change. Uses a short timeout
// so an unreachable node cannot stall the panel request; the DB change still
// stands and the daemon picks up the new ports on its next config refresh.
function syncServerConfig(uuid) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', '/api/servers', buildServerConfig(uuid), { timeout: QUICK_TIMEOUT });
}

// Extract the egg's install spec ({ script, container, entrypoint }) from the
// stored install_script JSON. Returns null when the egg has no installer.
function getInstallSpec(egg) {
  if (!egg || !egg.install_script) return null;

  let spec = egg.install_script;
  try { spec = JSON.parse(egg.install_script); } catch { /* raw script string */ }

  // Stored as the full { script, container, entrypoint } object.
  if (spec && typeof spec === 'object') {
    if (!spec.script) return null;
    return {
      script: String(spec.script),
      container: spec.container || '',
      entrypoint: spec.entrypoint || 'ash',
    };
  }

  // Stored as a plain script string.
  if (typeof spec === 'string' && spec.trim()) {
    return { script: spec, container: '', entrypoint: 'ash' };
  }

  return null;
}

// Run the server's egg installation script on the daemon.
async function installServer(uuid) {
  const srv = db.prepare('SELECT * FROM servers WHERE uuid = ?').get(uuid);
  if (!srv) throw new Error('Server not found in database');
  const egg = srv.egg_id ? db.prepare('SELECT * FROM eggs WHERE id = ?').get(srv.egg_id) : null;
  const spec = getInstallSpec(egg);
  if (!spec) throw new Error('This server\'s egg does not define an installation script.');

  const node = getNodeForServer(uuid);
  const cfg = buildServerConfig(uuid);
  // Reinstall removes the server from the daemon first, so make sure it exists
  // (and has a container) before running the installation script.
  await request(node, 'POST', '/api/servers', cfg);
  return request(node, 'POST', `/api/servers/${uuid}/install`, {
    install: spec,
    env: cfg.env,
  });
}

async function startServer(uuid) {
  await ensureServerOnDaemon(uuid);
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/start`);
}

async function restartServer(uuid) {
  await ensureServerOnDaemon(uuid);
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/restart`);
}

async function stopServer(uuid) {
  // Do NOT call ensureServerOnDaemon here: pushing the config while the server
  // is running used to recreate the container out from under it, which made a
  // running server impossible to stop cleanly. The daemon already has the egg's
  // stop command from the last create/start.
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/stop`);
}

async function killServer(uuid) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/kill`);
}

async function removeServer(uuid) {
  const node = getNodeForServer(uuid);
  return request(node, 'DELETE', `/api/servers/${uuid}`);
}

async function getServerStatus(uuid) {
  const node = getNodeForServer(uuid);
  try {
    const info = await request(node, 'GET', `/api/servers/${uuid}/status`, null, { timeout: QUICK_TIMEOUT });
    return info.status || 'not_created';
  } catch {
    // Unreachable node: the caller cannot tell "no container" from "node is
    // down" unless we return null instead of a fake not_created status.
    return null;
  }
}

async function getServerStatusInfo(uuid) {
  const node = getNodeForServer(uuid);
  try {
    return await request(node, 'GET', `/api/servers/${uuid}/status`, null, { timeout: QUICK_TIMEOUT });
  } catch {
    return { status: null, unreachable: true };
  }
}

async function getServerUptime(uuid) {
  const node = getNodeForServer(uuid);
  try {
    const info = await request(node, 'GET', `/api/servers/${uuid}/status`, null, { timeout: QUICK_TIMEOUT });
    if ((info.status === 'running' || info.status === 'starting') && info.startedAt) {
      const since = new Date(info.startedAt).getTime();
      if (!isNaN(since) && since > 0) return Math.max(0, Math.floor((Date.now() - since) / 1000));
    }
    return 0;
  } catch {
    return 0;
  }
}

// Core stats fetch. Unlike getServerStats below it does not swallow failures,
// so callers can tell "the daemon answered" from "the node is unreachable".
async function fetchServerStats(uuid) {
  const node = getNodeForServer(uuid);
  // Piggyback the panel's limits so the daemon's monitor has them even for
  // containers that predate the limit labels (no restart needed).
  const srv = db.prepare('SELECT memory, cpu, disk FROM servers WHERE uuid = ?').get(uuid);
  const q = srv ? `?memory=${srv.memory || 0}&cpu=${srv.cpu || 0}&disk=${srv.disk || 0}` : '';
  const info = await request(node, 'GET', `/api/servers/${uuid}/stats${q}`, null, { timeout: QUICK_TIMEOUT });
  return { node, data: info || {} };
}

async function getServerStats(uuid) {
  try {
    return (await fetchServerStats(uuid)).data;
  } catch {
    return {};
  }
}

// Node reachability circuit breaker. When a node's TCP port is unreachable the
// OS socket connect does not fail for ~2s, so a page render that talks to a
// dead node stalls for seconds on every request. Once a stats call to a node
// fails we remember it for a short window and answer instantly (with empty
// stats) instead of retrying the doomed connect on every render. A single
// success clears the breaker immediately so recovery is not delayed.
const STATS_TIMEOUT_MS = 3000;  // Increased from 1500: Minecraft boot can make Docker stats slow
const NODE_COOLDOWN_MS = 15000;
const nodeCooldownUntil = new Map();

function nodeBreakerKey(node) {
  if (!node) return null;
  return String(node.id != null ? node.id : nodeHost(node));
}

function nodeCoolingDown(node) {
  const key = nodeBreakerKey(node);
  return key ? (nodeCooldownUntil.get(key) || 0) > Date.now() : false;
}

function markNodeUnreachable(node) {
  const key = nodeBreakerKey(node);
  if (key) nodeCooldownUntil.set(key, Date.now() + NODE_COOLDOWN_MS);
}

function clearNodeUnreachable(node) {
  const key = nodeBreakerKey(node);
  if (key) nodeCooldownUntil.delete(key);
}

// Bound a live stats call so a page render or polling loop never waits on a
// slow or unreachable node. Returns {} when the daemon does not answer in time.
function getServerStatsSafe(uuid, timeoutMs) {
  const ms = Math.min(timeoutMs || STATS_TIMEOUT_MS, STATS_TIMEOUT_MS);
  const node = getNodeForServer(uuid);
  if (nodeCoolingDown(node)) return Promise.resolve({});
  let settled = false;
  const inflight = fetchServerStats(uuid).then((r) => {
    settled = true;
    clearNodeUnreachable(r.node);
    return r.data;
  }).catch(() => {
    // A late failure after the timeout already fired must not bubble as an
    // unhandled rejection; it just means the node stayed unreachable.
    if (!settled) markNodeUnreachable(node);
    return null;
  });
  return Promise.race([
    inflight,
    new Promise((resolve) => {
      const t = setTimeout(() => {
        if (!settled) markNodeUnreachable(node);
        resolve({});
      }, ms);
      if (t.unref) t.unref();
    }),
  ]).then((v) => (v == null ? {} : v));
}

// Push a server's limits to its node so the daemon can enforce them.
async function setServerLimits(uuid) {
  const node = getNodeForServer(uuid);
  const srv = db.prepare('SELECT memory, cpu, disk FROM servers WHERE uuid = ?').get(uuid);
  if (!node || !srv) return null;
  return request(node, 'POST', `/api/servers/${uuid}/limits`, {
    memory: srv.memory || 0,
    cpu: srv.cpu || 0,
    disk: srv.disk || 0,
  });
}

async function sendCommand(uuid, command) {
  const node = getNodeForServer(uuid);
  return request(node, 'POST', `/api/servers/${uuid}/exec`, { command });
}

// ─── Console WebSocket ────────────────────────────────────────────────
// Returns a URL for the panel to proxy the console through, plus a helper
// to build a ws client to the daemon. The node's daemon_token is passed as
// a query param which is how the daemon authenticates WebSocket clients.
function getConsoleWsUrl(uuid) {
  const node = getNodeForServer(uuid);
  if (!node || !node.fqdn || !node.daemon_token) return null;
  return `${daemonBaseUrl(node).replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(node.daemon_token)}&server=${encodeURIComponent(uuid)}`;
}

function connectConsoleWs(uuid, options = {}) {
  const url = getConsoleWsUrl(uuid);
  if (!url) return null;
  const replay = options.replay === false ? '&replay=0' : '';
  return new WebSocket(`${url}${replay}`);
}

module.exports = {
  daemonBaseUrl,
  nodeHost,
  pingNode,
  getNodeForServer,
  getConsoleWsUrl,
  connectConsoleWs,
  createServer,
  syncServerConfig,
  ensureServerOnDaemon,
  installServer,
  getInstallSpec,
  startServer,
  stopServer,
  killServer,
  restartServer,
  removeServer,
  getServerStatus,
  getServerStatusInfo,
  getServerUptime,
  getServerStats,
  getServerStatsSafe,
  setServerLimits,
  sendCommand,
  fileList,
  fileRead,
  fileWrite,
  fileMkdir,
  fileDelete,
  fileUpload,
  fileRename,
  fileMove,
  fileCopy,
  fileChmod,
  fileCompress,
  fileExtract,
  fileDownload,
  backupServer,
  restoreBackup,
  setSftpPassword,
};
