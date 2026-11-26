require('dotenv').config();

// Crash protection - prevent the panel from dying on transient errors
process.on('uncaughtException', (err) => {
  console.error('[Pylox Panel] Uncaught exception:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Pylox Panel] Unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const { parsePermissions } = require('./lib/permissions');

const app = express();
const server = http.createServer(app);

// WebSocket for console
const wss = new WebSocket.Server({ server, path: '/ws/console' });

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(morgan('tiny'));
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));
app.use(cookieParser());

// Static files
const CACHEABLE = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|mp3|mp4)$/i;
const staticOptions = {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (CACHEABLE.test(filePath)) {
      // Logo, avatars, fonts, etc. — cache hard, they rarely change
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // CSS/JS — always revalidate so updates show up right away (304, no body)
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
};
app.use('/static', express.static(path.join(__dirname, 'public'), staticOptions));
app.use('/public', express.static(path.join(__dirname, 'public'), staticOptions));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), staticOptions));

// Session (in-memory store for simplicity). The store is kept on a variable so
// the console WebSocket upgrade handler can resolve session cookies too.
const sessionStore = new session.MemoryStore();
// Periodically prune expired sessions to prevent memory leak
setInterval(() => {
  try {
    if (typeof sessionStore.all === 'function') {
      sessionStore.all((err, sessions) => {
        if (err || !sessions) return;
        const now = Date.now();
        Object.keys(sessions).forEach((sid) => {
          const sess = sessions[sid];
          if (sess && sess.cookie && sess.cookie.expires) {
            const exp = new Date(sess.cookie.expires).getTime();
            if (exp < now) {
              sessionStore.destroy(sid, () => {});
            }
          }
        });
      });
    }
  } catch (_) {}
}, 60 * 60 * 1000);

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-secret',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, secure: false },
}));

// Rate limiting
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Global template vars
const db = require('./lib/db');
const i18n = require('./lib/i18n');
const baseurl = require('./lib/baseurl');
const extensions = require('./lib/extensions');
const gravatarUrl = (email, size = 64, fallback = 'identicon') => {
  const hash = crypto.createHash('md5').update(String(email || '').trim().toLowerCase()).digest('hex');
  const s = Math.max(1, Math.min(512, Number(size) || 64));
  return `https://www.gravatar.com/avatar/${hash}?s=${s}&d=${encodeURIComponent(fallback)}&r=g`;
};
app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.isLoggedIn = false;
  res.locals.isFirstRun = db.isFirstRun ? db.isFirstRun() : false;
  if (req.session && req.session.userId) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (u) { res.locals.user = u; res.locals.isLoggedIn = true; }
  }

  // i18n: per-user language, else panel default, else English
  let lang = 'en';
  if (res.locals.user && res.locals.user.language) {
    lang = res.locals.user.language;
  } else if (db.getSetting) {
    lang = db.getSetting('default_language', 'en');
  }
  lang = i18n.resolve(lang);
  const t = i18n.makeT(lang);
  req.t = t;
  res.locals.t = t;
  res.locals.lang = lang;
  res.locals.i18nDict = i18n.dict(lang);
  res.locals.i18nLangs = i18n.SUPPORTED;
  res.locals.i18nNames = i18n.LANGUAGE_NAMES;

  res.locals.gravatar = gravatarUrl;
  res.locals.currentPath = req.path;
  res.locals.baseUrl = baseurl.resolveBaseUrl(req);
  res.locals.siteName = (db.getSetting && db.getSetting('site_name', 'Pyloxdactyl')) || 'Pyloxdactyl';
  res.locals.favicon = (db.getSetting && db.getSetting('branding_favicon', '/static/img/Pylox_no_bg.png')) || '/static/img/Pylox_no_bg.png';
  res.locals.pageLogo = (db.getSetting && db.getSetting('branding_page_logo', '/static/img/Pylox_no_bg.png')) || '/static/img/Pylox_no_bg.png';
  res.locals.panelVersion = (require('./package.json').version) || '0.0.0';

  // Extensions: expose registered auth providers, admin tabs and a helper that
  // lets core views render markup injected by extensions.
  res.locals.authProviders = extensions.getAuthProviders();
  res.locals.adminSections = extensions.getAdminSections();
  res.locals.extensionHook = (name) => extensions.renderHook(name, req, res);
  next();
});

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/install', require('./routes/install'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/server', require('./routes/server'));
app.use('/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));
app.use('/account', require('./routes/account'));
app.use('/api/mobile', require('./routes/mobile-api'));

// Extensions (loaded from data/extensions). Mounted before the 404 handler so
// extensions can register routes such as /auth/oauth/:provider. The middleware
// dispatches to the manager's current router, which is swapped on reload.
app.use(extensions.middleware);

// Root redirect
app.get('/', (req, res) => {
  if (db.isFirstRun()) return res.redirect('/install');
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  res.redirect('/auth/login');
});

// 404
app.use((req, res) => { res.status(404).render('errors/404'); });

// Error handler
app.use((err, req, res, next) => {
  console.error('[Pylox Panel] Route error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).render('errors/500');
});

// WebSocket connection handling
// The panel proxies the game server console through the daemon, which is the
// component that actually owns Docker access.
const daemonLib = require('./lib/daemon');

// Resolve the panel user behind a console WebSocket upgrade: either an
// API-key `token` query parameter (mobile app) or the session cookie sent by
// the browser. Returns null when neither proves a logged-in user.
function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function resolveConsoleUser(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (token) {
    const key = db.prepare('SELECT ak.id as key_id, u.* FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.token = ?').get(token);
    if (!key) return Promise.resolve(null);
    db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(key.key_id);
    return Promise.resolve(key);
  }
  const cookies = parseCookieHeader(req.headers.cookie);
  const raw = cookies['connect.sid'];
  if (!raw) return Promise.resolve(null);
  let value = raw;
  try { value = decodeURIComponent(raw); } catch (_) {}
  if (!value.startsWith('s:')) return Promise.resolve(null);
  const body = value.slice(2);
  const idx = body.lastIndexOf('.');
  if (idx < 1) return Promise.resolve(null);
  const sid = body.slice(0, idx);
  const sig = body.slice(idx + 1);
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'change-me-secret')
    .update(sid)
    .digest('base64')
    .replace(/=+$/, '');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return Promise.resolve(null);
  return new Promise((resolve) => {
    sessionStore.get(sid, (err, sess) => {
      if (err || !sess || !sess.userId) return resolve(null);
      resolve(db.prepare('SELECT * FROM users WHERE id = ?').get(sess.userId) || null);
    });
  });
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const serverUuid = url.searchParams.get('server');
  const clientWantsHistory = url.searchParams.get('replay') !== '0';
  if (!serverUuid) { ws.close(); return; }

  const srv = db.prepare('SELECT * FROM servers WHERE uuid = ?').get(serverUuid);
  if (!srv) { ws.close(); return; }

  const sessionUser = await resolveConsoleUser(req).catch(() => null);
  if (!sessionUser || ws.readyState !== WebSocket.OPEN) {
    try { ws.close(); } catch (_) {}
    return;
  }

  // null = full access (owner or root admin); otherwise the subuser's grants.
  let panelPermissions = null;
  if (!sessionUser.root_admin && srv.user_id !== sessionUser.id) {
    const sub = db.prepare('SELECT permissions FROM subusers WHERE server_id = ? AND user_id = ?').get(srv.id, sessionUser.id);
    panelPermissions = sub ? parsePermissions(sub.permissions) : null;
    // A subuser without console access cannot attach to the console socket.
    if (!sub || !panelPermissions.includes('console.view')) { ws.close(); return; }
  }
  ws.panelPermissions = panelPermissions;

  // i18n for console status messages (fall back to panel default)
  let lang = sessionUser.language || db.getSetting('default_language', 'en');
  lang = i18n.resolve(lang);
  const t = i18n.makeT(lang);

  // Suspended servers have no console: the overview page is locked down and
  // direct socket connections must be rejected as well.
  if (srv.suspended) {
    if (ws.readyState === WebSocket.OPEN) ws.send(t('server.power.suspended'));
    ws.close();
    return;
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const dwsUrl = daemonLib.getConsoleWsUrl(serverUuid);
  if (!dwsUrl) {
    ws.send(t('server.ws.daemonNotConfigured'));
    ws.close();
    return;
  }

  let dws = null;
  let reconnecting = false;
  let daemonHistorySent = false;

  const connectDaemon = () => {
    // Replay history once per panel client session. Daemon reconnects and
    // browser socket reconnects must not paste the same log block again.
    const replay = clientWantsHistory && !daemonHistorySent;
    if (replay) daemonHistorySent = true;
    dws = daemonLib.connectConsoleWs(serverUuid, { replay });
    if (!dws) { ws.send(t('server.ws.couldNotConnect')); ws.close(); return; }

    dws.on('open', () => {
      reconnecting = false;
      ws.send(t('server.ws.connected'));
    });

    dws.on('message', (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.event === 'console') {
        const text = String(msg.data || '');
        text.split('\n').filter(l => l.trim()).forEach(line => {
          if (ws.readyState === WebSocket.OPEN) ws.send(line);
        });
      } else if (msg.event === 'status') {
        ws.send(t('server.ws.status', { status: msg.status }));
      } else if (msg.event === 'error') {
        if (!reconnecting) ws.send(t('server.ws.daemonError', { message: msg.message }));
      }
    });

    dws.on('error', () => {
      if (!reconnecting && ws.readyState === WebSocket.OPEN) {
        ws.send(t('server.ws.attachFailed'));
      }
    });

    dws.on('close', () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(t('server.ws.disconnected'));
      reconnecting = true;
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        reconnecting = false;
        connectDaemon();
      }, 3000);
    });
  };

  // Make sure the daemon knows about this server before attaching so the
  // console works even when the container has not been provisioned yet.
  daemonLib.ensureServerOnDaemon(serverUuid)
    .catch(() => {})
    .then(() => { if (ws.readyState === WebSocket.OPEN) connectDaemon(); });

  // Forward panel client messages to the daemon using its JSON protocol.
  ws.on('message', (data) => {
    const msg = data.toString().trim();
    const cmd = msg.split(' ')[0];

    if (!dws || dws.readyState !== WebSocket.OPEN) {
      ws.send(t('server.ws.notConnected'));
      return;
    }

    const power = ['start', 'stop', 'restart', 'kill', 'status'];
    const perms = ws.panelPermissions;
    if (power.includes(cmd)) {
      if (perms && cmd !== 'status' && !perms.includes('console.power')) {
        ws.send(t('server.ws.noPermission'));
        return;
      }
      if (cmd !== 'status') {
        const current = db.prepare('SELECT suspended FROM servers WHERE id = ?').get(srv.id);
        if (current && current.suspended) {
          ws.send(t('server.power.suspended'));
          return;
        }
      }
      dws.send(JSON.stringify({ action: cmd }));
    } else {
      if (perms && !perms.includes('console.command')) {
        ws.send(t('server.ws.noPermission'));
        return;
      }
      dws.send(JSON.stringify({ action: 'command', command: msg }));
    }
  });

  ws.on('close', () => {
    if (dws) { try { dws.close(); } catch {} }
  });
});

// Heartbeat for WS
setInterval(() => {
  try {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  } catch (err) {
    console.error('[WS] Heartbeat error:', err && err.message ? err.message : err);
  }
}, 30000);

// Keep every node's resource limits in sync with the panel. The daemon enforces
// RAM/CPU/disk limits, but the database here is the source of truth — this
// closes the gap for servers that were already running before limits were set.
function startLimitSync() {
  const sync = () => {
    let servers = [];
    try {
      servers = db.prepare('SELECT id, uuid, status FROM servers WHERE node_id IS NOT NULL').all();
    } catch (_) {
      return;
    }
    for (const s of servers) {
      daemonLib.setServerLimits(s.uuid).catch(() => { /* node offline */ });
      daemonLib.getServerStatusInfo(s.uuid).then((info) => {
        // An unreachable node must not be reported as offline — leave the DB
        // row untouched so a transient outage does not flip every server.
        if (!info || info.unreachable || !info.status) return;
        let live = info.status;
        if (live === 'not_created') live = 'offline';
        if (live !== s.status) {
          try { db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(live, s.id); } catch (_) { /* ignore */ }
        }
      }).catch(() => { /* node offline */ });
    }
  };
  sync();
  setInterval(sync, 60000);
}

// Wait for DB to be ready, then start server
function startServer() {
  if (db.prepare && typeof db.prepare('SELECT 1').get === 'function') {
    // Load enabled extensions now that the database is available.
    try {
      const loaded = extensions.loadAll();
      console.log(`[Pylox Panel] Loaded ${loaded} extension(s)`);
    } catch (err) {
      console.error('[Pylox Panel] Extension load failed:', err.message);
    }
    const PORT = process.env.APP_PORT || 7956;
    server.listen(PORT, () => {
      console.log(`[Pylox Panel] Running on http://localhost:${PORT}`);
      console.log(`[Pylox Panel] WebSocket on ws://localhost:${PORT}/console`);
    });
    startLimitSync();
  } else {
    setTimeout(startServer, 100);
  }
}

// Give DB a moment to initialize
setTimeout(startServer, 500);