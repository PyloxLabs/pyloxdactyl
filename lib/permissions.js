// Per-server subuser permissions. A server owner can grant another panel
// account access to their server by email; each grant stores a JSON list of
// permission keys (the `subusers.permissions` column). Owners and root admins
// implicitly hold every permission — for them `req.serverPermissions` is null.

const GROUPS = ['console', 'files', 'databases', 'backups', 'network', 'schedules', 'startup', 'settings'];

const PERMISSIONS = [
  { key: 'console.view', group: 'console' },
  { key: 'console.command', group: 'console' },
  { key: 'console.power', group: 'console' },
  { key: 'files.read', group: 'files' },
  { key: 'files.write', group: 'files' },
  { key: 'files.delete', group: 'files' },
  { key: 'databases.view', group: 'databases' },
  { key: 'databases.create', group: 'databases' },
  { key: 'databases.delete', group: 'databases' },
  { key: 'backups.view', group: 'backups' },
  { key: 'backups.create', group: 'backups' },
  { key: 'backups.delete', group: 'backups' },
  { key: 'backups.restore', group: 'backups' },
  { key: 'network.view', group: 'network' },
  { key: 'network.create', group: 'network' },
  { key: 'network.delete', group: 'network' },
  { key: 'schedules.view', group: 'schedules' },
  { key: 'schedules.manage', group: 'schedules' },
  { key: 'startup.view', group: 'startup' },
  { key: 'startup.edit', group: 'startup' },
  { key: 'settings.view', group: 'settings' },
];

const VALID_KEYS = new Set(PERMISSIONS.map((p) => p.key));

// Grouped catalog used by the Users page to render checkbox sections.
const PERMISSION_GROUPS = GROUPS.map((id) => ({
  id,
  perms: PERMISSIONS.filter((p) => p.group === id),
}));

function sanitizePermissions(list) {
  const arr = Array.isArray(list) ? list : list === undefined || list === null ? [] : [list];
  const out = [];
  for (const raw of arr) {
    const key = String(raw);
    if (VALID_KEYS.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

// Parse the JSON blob stored in subusers.permissions into a clean key list.
function parsePermissions(raw) {
  if (Array.isArray(raw)) return sanitizePermissions(raw);
  try {
    return sanitizePermissions(JSON.parse(raw || '[]'));
  } catch (_) {
    return [];
  }
}

// Null (owner/root admin) counts as full access.
function can(permissions, key) {
  return permissions === null || permissions === undefined || permissions.includes(key);
}

// Preferred server sections in landing order, each gated by a permission.
const SECTION_PERMISSIONS = [
  { section: '', perm: 'console.view' },
  { section: 'files', perm: 'files.read' },
  { section: 'databases', perm: 'databases.view' },
  { section: 'backups', perm: 'backups.view' },
  { section: 'network', perm: 'network.view' },
  { section: 'schedules', perm: 'schedules.view' },
  { section: 'startup', perm: 'startup.view' },
  { section: 'settings', perm: 'settings.view' },
];

// The first server section a subuser is allowed to open, or null if none.
// Owners/root admins land on the console ('').
function defaultSection(permissions) {
  if (permissions === null || permissions === undefined) return '';
  const found = SECTION_PERMISSIONS.find((s) => permissions.includes(s.perm));
  return found ? found.section : null;
}

module.exports = { GROUPS, PERMISSIONS, PERMISSION_GROUPS, VALID_KEYS, SECTION_PERMISSIONS, sanitizePermissions, parsePermissions, can, defaultSection };
