const nodemailer = require('nodemailer');
const db = require('./db');
const baseurl = require('./baseurl');

// Read the SMTP settings currently stored in the panel database.
function getConfig() {
  return {
    host: db.getSetting('smtp_host', ''),
    port: parseInt(db.getSetting('smtp_port', '587'), 10) || 587,
    encryption: db.getSetting('smtp_encryption', 'tls'),
    username: db.getSetting('smtp_username', ''),
    password: db.getSetting('smtp_password', ''),
    fromEmail: db.getSetting('smtp_from_email', ''),
    fromName: db.getSetting('smtp_from_name', 'Panel'),
  };
}

// Build a nodemailer transport from a config object (stored or form-provided).
function buildTransport(cfg) {
  const options = { host: cfg.host, port: Number(cfg.port) || 587 };
  if (cfg.encryption === 'ssl') {
    options.secure = true;
  } else {
    options.secure = false;
    if (cfg.encryption === 'none') {
      options.ignoreTLS = true;
    } else {
      options.requireTLS = true;
    }
  }
  if (cfg.username) {
    options.auth = { user: cfg.username, pass: cfg.password || '' };
  }
  return nodemailer.createTransport(options);
}

// Send an email. `config` may be passed to test unsaved form values, otherwise
// the persisted settings are used. Rejects with an Error if sending fails.
function sendMail({ to, subject, text, html, config }) {
  const cfg = config || getConfig();
  if (!cfg.host) return Promise.reject(new Error('SMTP host is not configured'));
  const from = cfg.fromEmail
    ? { name: cfg.fromName || 'Panel', address: cfg.fromEmail }
    : { name: cfg.fromName || 'Panel', address: cfg.username || '' };
  if (!from.address) return Promise.reject(new Error('SMTP from-email is not configured'));
  const transporter = buildTransport(cfg);
  return transporter.sendMail({ to, subject, text, html, from });
}

// ── HTML email template ─────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build an absolute URL for a panel asset/route. Prefers the panel's app_url
// setting, otherwise falls back to `fallbackBase` (e.g. the request host).
function absoluteUrl(relative, fallbackBase) {
  const base = String(db.getSetting('app_url', '') || fallbackBase || '').replace(/\/+$/, '');
  if (!base) return null;
  if (/^https?:\/\//i.test(relative)) return relative;
  if (!relative.startsWith('/')) return base + '/' + relative;
  return base + relative;
}

// Render a full, client-safe HTML email. `body` is an array of paragraph
// objects: { text } for escaped plain text or { html } for trusted markup.
function renderHtmlEmail({ title, greeting, body, buttonText, buttonUrl, note, baseUrl }) {
  const siteName = escapeHtml(db.getSetting('site_name', 'Panel'));
  const logoPath = absoluteUrl(db.getSetting('branding_page_logo', '/static/img/Pylox_no_bg.png'), baseUrl);
  const logo = logoPath
    ? `<img src="${escapeHtml(logoPath)}" alt="${siteName}" width="64" height="64" style="display:block;width:64px;height:64px;margin:0 auto 8px;border-radius:12px;object-fit:contain">`
    : '';

  const paragraphs = (Array.isArray(body) ? body : [{ text: body }]).map((p) => {
    if (p.html) {
      return `<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#334155">${p.html}</p>`;
    }
    return `<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#334155">${escapeHtml(p.text || '')}</p>`;
  }).join('\n');

  const button = buttonText && buttonUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 18px"><tr><td style="border-radius:10px;background:#4f46e5;padding:0"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(buttonText)}</a></td></tr></table>`
    : '';

  const noteHtml = note
    ? `<div style="margin-top:24px;padding:12px 16px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0"><p style="margin:0;font-size:12px;line-height:1.6;color:#64748b">${escapeHtml(note)}</p></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:36px 16px">
    <tr>
      <td align="center" style="padding:12px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

          <!-- Header -->
          <tr>
            <td align="center" style="padding:0 0 20px">
              ${logo}
              <div style="font-size:16px;font-weight:700;color:#312e81">${siteName}</div>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">
              <div style="padding:36px 40px 32px">
                <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#0f172a">${escapeHtml(title)}</h1>
                ${greeting ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#475569">${escapeHtml(greeting)}</p>` : ''}
                ${paragraphs}
                ${button}
                ${noteHtml}
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:18px 4px 0">
              <p style="margin:0;text-align:center;font-size:11px;line-height:1.6;color:#94a3b8">${siteName} &middot; Powered by Pylox</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Render the matching plain-text fallback.
function renderTextEmail({ title, greeting, body, buttonUrl, buttonText }) {
  const lines = [];
  lines.push(title);
  lines.push('');
  if (greeting) lines.push(greeting);
  const paragraphs = Array.isArray(body) ? body : [{ text: body }];
  for (const p of paragraphs) {
    lines.push(p.text || (p.html ? p.html.replace(/<[^>]+>/g, '') : ''));
  }
  if (buttonText && buttonUrl) {
    lines.push('');
    lines.push(`${buttonText}: ${buttonUrl}`);
  }
  return lines.join('\n');
}

// High-level sender that composes the branded HTML + text pair from the panel
// settings. Accepts the same `config` override as sendMail.
function sendTemplateEmail({ to, subject, title, greeting, body, buttonText, buttonUrl, note, baseUrl, config }) {
  if (baseurl.isLocalHostname(baseUrl)) {
    console.warn(`[mailer] Emails reference a local address (${baseUrl || 'none'}). Set "Application URL" in Admin > Settings so reset links and the logo resolve to a public URL.`);
  }
  const html = renderHtmlEmail({ title, greeting, body, buttonText, buttonUrl, note, baseUrl });
  const text = renderTextEmail({ title, greeting, body, buttonText, buttonUrl });
  return sendMail({ to, subject, text, html, config });
}

// Simple mail-sending helper used by the rest of the panel.
async function deliver({ to, subject, text, html }) {
  await sendMail({ to, subject, text, html });
}

module.exports = { sendMail, deliver, getConfig, sendTemplateEmail, absoluteUrl, renderHtmlEmail, renderTextEmail };