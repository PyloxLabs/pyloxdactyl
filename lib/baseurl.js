const db = require('./db');

// Resolve the panel's public base URL for a request.
// Priority: admin "Application URL" setting > APP_URL/PANEL_URL env >
// forwarded headers (reverse proxy) > the request host. This keeps email
// links/logo assets pointed at a reachable, non-localhost URL in production.
function resolveBaseUrl(req) {
  const appUrl = String(db.getSetting('app_url', '') || '').trim();
  if (appUrl) return appUrl.replace(/\/+$/, '');

  const env = String(process.env.APP_URL || process.env.PANEL_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');

  const proto = String(req.headers['x-forwarded-proto'] || (req.protocol || 'http')).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers['host'] || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  return '';
}

// True when a URL points at loopback/private address that email recipients
// typically cannot reach.
function isLocalHostname(url) {
  if (!url) return true;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch (e) {
    return true;
  }
}

module.exports = { resolveBaseUrl, isLocalHostname };