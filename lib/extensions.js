require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const unzipper = require('unzipper');
const db = require('./db');

const EXT_DIR = path.join(__dirname, '..', 'data', 'extensions');
const MANIFEST = 'pylox-extension.json';
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

// Core modules an extension is allowed to require by short name.
const CORE_LIBS = {
  db: require('./db'),
  baseurl: require('./baseurl'),
  i18n: require('./i18n'),
  mailer: require('./mailer'),
  archive: require('./archive'),
};

function ensureDir() {
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });
}

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

// Recursively locate a manifest file, so archives that wrap everything in a
// top-level folder (the common case) still work.
function findManifest(root, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  if (entries.some((e) => e.isFile() && e.name === MANIFEST)) return root;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const found = findManifest(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function readManifest(dir) {
  const file = path.join(dir, MANIFEST);
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('Manifest is not an object');
  if (!data.id || !ID_RE.test(String(data.id))) throw new Error('Manifest has an invalid or missing "id"');
  if (!data.name) throw new Error('Manifest is missing "name"');
  const main = data.main || 'index.js';
  if (!fs.existsSync(path.join(dir, main))) throw new Error(`Entry file "${main}" not found`);
  const out = {
    id: String(data.id),
    name: String(data.name),
    version: String(data.version || '0.0.0'),
    author: data.author ? String(data.author) : '',
    description: data.description ? String(data.description) : '',
    main,
    icon: data.icon ? String(data.icon) : null,
    homepage: data.homepage ? String(data.homepage) : null,
    defaultEnabled: data.defaultEnabled === true || data.enabled === true,
    settings: Array.isArray(data.settings) ? data.settings : [],
  };
  return out;
}

class ExtensionManager {
  constructor() {
    this.extensions = new Map(); // id -> record for loaded (enabled) extensions
    this.hooks = new Map(); // hookName -> [fn]
    this.authProviders = []; // { extension, id, label, icon, url, order }
    this.adminSections = []; // { extension, id, label, url }
    this.loadErrors = new Map(); // id -> message
    this.rootRouter = express.Router();

    // Stable middleware that always dispatches to the *current* router, so a
    // reload can swap route tables without remounting on the app.
    this.middleware = (req, res, next) => this.rootRouter(req, res, next);
  }

  // ── Manifest / disk helpers ───────────────────────────────────────────────

  discover() {
    ensureDir();
    const found = [];
    let entries = [];
    try { entries = fs.readdirSync(EXT_DIR, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const dir = path.join(EXT_DIR, entry.name);
      if (!fs.existsSync(path.join(dir, MANIFEST))) continue;
      try {
        found.push({ manifest: readManifest(dir), dir });
      } catch (err) {
        console.error(`[extensions] Ignoring "${entry.name}": ${err.message}`);
      }
    }
    return found;
  }

  ensureDbRow(manifest) {
    const row = db.prepare('SELECT id FROM extensions WHERE id = ?').get(manifest.id);
    if (row) {
      db.prepare('UPDATE extensions SET name=?, version=?, author=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(manifest.name, manifest.version, manifest.author, manifest.description, manifest.id);
    } else {
      db.prepare('INSERT INTO extensions (id, name, version, author, description, enabled, settings) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(manifest.id, manifest.name, manifest.version, manifest.author, manifest.description, manifest.defaultEnabled ? 1 : 0, '{}');
    }
  }

  // ── Loading / unloading ───────────────────────────────────────────────────

  loadAll() {
    this.unloadAll();
    this.loadErrors.clear();
    const manifests = this.discover();
    for (const { manifest } of manifests) {
      try { this.ensureDbRow(manifest); } catch (e) { console.error('[extensions] db sync:', e.message); }
    }
    const rows = db.prepare('SELECT * FROM extensions').all();
    for (const row of rows) {
      const match = manifests.find((m) => m.manifest.id === row.id);
      if (!match || !row.enabled) continue;
      try {
        this.loadOne(match.manifest, match.dir);
      } catch (err) {
        this.loadErrors.set(row.id, err.message);
        console.error(`[extensions] Failed to load "${row.id}": ${err.message}`);
      }
    }
    this.buildRouter();
    return this.extensions.size;
  }

  reload() {
    return this.loadAll();
  }

  loadOne(manifest, dir) {
    const ext = {
      id: manifest.id,
      manifest,
      dir,
      rootRouter: express.Router(),
      router: express.Router(),
      instance: null,
    };

    const api = this._createApi(ext);
    const entry = path.resolve(dir, manifest.main);
    const mod = require(entry);
    const register = typeof mod === 'function' ? mod : (mod && mod.register);
    if (typeof register !== 'function') {
      throw new Error('Entry file must export a function or a { register(api) } object');
    }
    register(api);
    ext.instance = mod;
    ext.entry = entry;

    this.extensions.set(ext.id, ext);
    return ext;
  }

  unloadAll() {
    // Drop require cache for every file that lived inside an extension folder
    // so a reload (or re-enable) picks up fresh code.
    const roots = [...this.extensions.values()].map((e) => e.dir);
    for (const dir of roots) {
      const prefix = dir.toLowerCase();
      for (const key of Object.keys(require.cache)) {
        if (key.toLowerCase().startsWith(prefix)) delete require.cache[key];
      }
    }
    this.extensions.clear();
    this.hooks.clear();
    this.authProviders = [];
    this.adminSections = [];
  }

  buildRouter() {
    const router = express.Router();
    for (const ext of this.extensions.values()) {
      router.use(ext.rootRouter);
      router.use('/extensions/' + ext.id, ext.router);
    }
    this.rootRouter = router;
  }

  _createApi(ext) {
    const self = this;
    const manifest = ext.manifest;
    const router = ext.router;

    const api = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      dir: ext.dir,
      express,

      // Namespaced router — mounted at /extensions/<id>.
      router,

      // Resolve a core library (or any installed npm module) by name.
      require(name) {
        return CORE_LIBS[name] || require(name);
      },

      get db() { return db; },

      // Absolute route on the panel app (e.g. '/auth/oauth/:provider').
      // Usage: api.route('get', '/path', handler) or api.route('/path', handler).
      route(method, routePath, ...handlers) {
        const methods = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'head', 'options'];
        if (typeof method === 'string' && methods.includes(method.toLowerCase()) && routePath) {
          ext.rootRouter[method.toLowerCase()](routePath, ...handlers);
        } else {
          ext.rootRouter.get(method, routePath, ...handlers);
        }
        return api;
      },

      // Serve a folder relative to the extension dir under its namespace.
      static(urlPath, dirRel) {
        router.use(urlPath, express.static(path.resolve(ext.dir, dirRel || urlPath)));
        return api;
      },

      // Extension-scoped persisted settings.
      getSetting(key, def) { return getSetting(manifest.id, key, def); },
      setSetting(key, value) { return setSetting(manifest.id, key, value); },
      getSettings() { return getSettings(manifest.id); },

      // Hooks let an extension inject markup into core views.
      on(hook, fn) {
        if (typeof hook !== 'string' || typeof fn !== 'function') return api;
        if (!self.hooks.has(hook)) self.hooks.set(hook, []);
        self.hooks.get(hook).push(fn);
        return api;
      },

      // Register a third-party authentication provider.
      addAuthProvider(provider) {
        if (!provider || !provider.id) return api;
        self.authProviders.push(Object.assign({
          extension: manifest.id,
          label: provider.label || provider.id,
          icon: provider.icon || null,
          url: provider.url || ('/auth/oauth/' + provider.id),
          order: Number.isFinite(provider.order) ? provider.order : 100,
        }, provider));
        return api;
      },

      // Register an extra link inside the admin tab bar.
      addAdminSection(section) {
        if (!section || !section.id || !section.url) return api;
        self.adminSections.push({
          extension: manifest.id,
          id: section.id,
          label: section.label || section.id,
          url: section.url,
          order: Number.isFinite(section.order) ? section.order : 100,
        });
        return api;
      },

      log(...args) { console.log(`[ext:${manifest.id}]`, ...args); },
      error(...args) { console.error(`[ext:${manifest.id}]`, ...args); },
    };

    return api;
  }

  // ── Introspection for views / admin ───────────────────────────────────────

  isEnabled(id) {
    const row = safeGet('SELECT enabled FROM extensions WHERE id = ?', id);
    return !!(row && row.enabled);
  }

  getAuthProviders() {
    return this.authProviders.slice().sort((a, b) => a.order - b.order);
  }

  getAdminSections() {
    return this.adminSections.slice().sort((a, b) => a.order - b.order);
  }

  renderHook(name, req, res) {
    const handlers = this.hooks.get(name);
    if (!handlers || !handlers.length) return '';
    let html = '';
    for (const fn of handlers) {
      try {
        const out = fn(req, res);
        if (typeof out === 'string') html += out;
      } catch (err) {
        console.error(`[extensions] hook "${name}" failed:`, err.message);
      }
    }
    return html;
  }

  list() {
    const rows = db.prepare('SELECT * FROM extensions').all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out = [];
    for (const { manifest, dir } of this.discover()) {
      const row = byId.get(manifest.id);
      let settings = {};
      try { settings = row ? JSON.parse(row.settings || '{}') : {}; } catch {}
      out.push({
        ...manifest,
        dir,
        settings_schema: manifest.settings || [],
        enabled: row ? !!row.enabled : false,
        installed: true,
        loaded: this.extensions.has(manifest.id),
        missing: false,
        error: this.loadErrors.get(manifest.id) || null,
        settings,
        keys: Object.keys(settings).length,
        installed_at: row ? row.installed_at : null,
      });
    }
    for (const row of rows) {
      if (out.some((e) => e.id === row.id)) continue;
      let settings = {};
      try { settings = JSON.parse(row.settings || '{}'); } catch {}
      out.push({
        id: row.id, name: row.name, version: row.version, author: row.author,
        description: row.description, dir: null, enabled: !!row.enabled,
        installed: false, loaded: false, missing: true, error: 'Files not found',
        settings, keys: Object.keys(settings).length, installed_at: row.installed_at,
        defaultEnabled: false, settings_schema: [],
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return this.list().find((e) => e.id === id) || null;
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  setEnabled(id, enabled) {
    const row = db.prepare('SELECT id FROM extensions WHERE id = ?').get(id);
    if (!row) return false;
    db.prepare('UPDATE extensions SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(enabled ? 1 : 0, id);
    this.reload();
    return true;
  }

  saveSettings(id, values) {
    const row = db.prepare('SELECT settings FROM extensions WHERE id = ?').get(id);
    if (!row) return false;
    let current = {};
    try { current = JSON.parse(row.settings || '{}'); } catch {}
    const next = Object.assign({}, current, values);
    db.prepare('UPDATE extensions SET settings=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(next), id);
    this.reload();
    return true;
  }

  uninstall(id) {
    if (!ID_RE.test(String(id))) return false;
    const dir = path.join(EXT_DIR, id);
    const inUse = [...this.extensions.values()].some((e) => e.dir === dir);
    if (inUse) this.unloadAll();
    rmrf(dir);
    db.prepare('DELETE FROM extensions WHERE id = ?').run(id);
    this.loadAll();
    return true;
  }

  // Extract a .zip upload and install the extension it contains.
  async installFromZip(zipPath) {
    ensureDir();
    const tmp = path.join(EXT_DIR, '.tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(tmp, { recursive: true });
    try {
      await extractZip(zipPath, tmp);
      const root = findManifest(tmp);
      if (!root) throw new Error(`No ${MANIFEST} found in archive`);
      const manifest = readManifest(root);

      const dest = path.join(EXT_DIR, manifest.id);
      rmrf(dest);
      // Move the folder that holds the manifest into its final location.
      fs.renameSync(root, dest);

      this.ensureDbRow(manifest);
      // A freshly installed extension is enabled so the admin can configure it.
      db.prepare('UPDATE extensions SET enabled=1, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(manifest.id);
      this.reload();
      return manifest;
    } finally {
      rmrf(tmp);
    }
  }
}

// ── Settings storage helpers ────────────────────────────────────────────────
function safeGet(sql, ...params) {
  try { return db.prepare(sql).get(...params); } catch { return undefined; }
}

function getSettings(id) {
  const row = safeGet('SELECT settings FROM extensions WHERE id = ?', id);
  let s = {};
  try { s = JSON.parse((row && row.settings) || '{}'); } catch {}
  return s;
}

function getSetting(id, key, def) {
  const s = getSettings(id);
  return s[key] !== undefined ? s[key] : def;
}

function setSetting(id, key, value) {
  const s = getSettings(id);
  s[key] = value;
  db.prepare('UPDATE extensions SET settings=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(s), id);
  return value;
}

// ── ZIP extraction with path traversal protection ───────────────────────────
function extractZip(zipPath, dest) {
  return new Promise((resolve, reject) => {
    const destResolved = path.resolve(dest);
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };

    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        const rel = String(entry.path || '').replace(/\\/g, '/');
        const target = path.resolve(destResolved, rel);
        if (target !== destResolved && !target.startsWith(destResolved + path.sep)) {
          entry.autodrain();
          return;
        }
        if (entry.type === 'Directory') {
          fs.mkdirSync(target, { recursive: true });
          entry.autodrain();
          return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const out = fs.createWriteStream(target);
        out.on('error', finish);
        entry.pipe(out).on('finish', () => {}).on('error', finish);
      })
      .on('close', () => finish())
      .on('error', finish);
  });
}

const manager = new ExtensionManager();
manager.EXT_DIR = EXT_DIR;
manager.MANIFEST = MANIFEST;

module.exports = manager;
