// First-run installation helpers shared by the database layer, routes and tests.
// A first run is a database that was created by this version of the panel and
// has neither completed setup nor an existing root administrator.

const SETTINGS = {
  createdAt: 'first_run_db_created_at',
  completedAt: 'install_completed_at'
};

function stamp() {
  return new Date().toISOString();
}

function isFirstRun(db) {
  if (!db || typeof db.ready !== 'function' || !db.ready()) return false;
  if (typeof db.getSetting !== 'function') return false;
  if (!db.getSetting(SETTINGS.createdAt, null)) return false;
  if (db.getSetting(SETTINGS.completedAt, null)) return false;
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM users WHERE root_admin = 1').get();
    return Number(row && row.c) === 0;
  } catch (err) {
    return false;
  }
}

function markInstalled(db) {
  if (!db || typeof db.setSetting !== 'function') return;
  db.setSetting(SETTINGS.completedAt, stamp());
  if (typeof db.save === 'function') db.save();
}

function validateAdminInput(body, t) {
  const translate = typeof t === 'function' ? t : (key) => key;
  const data = body || {};
  if (!data.username || !data.email || !data.password) return translate('routes.auth.allFieldsRequired');
  if (data.password !== data.password_confirm) return translate('routes.auth.passwordsDontMatch');
  if (String(data.password).length < 8) return translate('routes.auth.passwordTooShort');
  return null;
}

module.exports = { SETTINGS, stamp, isFirstRun, markInstalled, validateAdminInput };
