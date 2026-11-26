const test = require('node:test');
const assert = require('node:assert/strict');
const { SETTINGS, isFirstRun, markInstalled, validateAdminInput } = require('../lib/install');

function fakeDb({ created = null, completed = null, adminCount = 0 } = {}) {
  const settings = {};
  if (created) settings[SETTINGS.createdAt] = created;
  if (completed) settings[SETTINGS.completedAt] = completed;
  return {
    ready() { return true; },
    getSetting(key, def) {
      return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : def;
    },
    setSetting(key, value) { settings[key] = String(value); },
    save() {},
    prepare() { return { get() { return { c: adminCount }; } }; },
    settings
  };
}

const t = (key) => key;

test('first run requires a newly created database', () => {
  assert.equal(isFirstRun(fakeDb()), false);
  assert.equal(isFirstRun(fakeDb({ created: '2026-01-01T00:00:00.000Z' })), true);
});

test('first run ends once a root administrator exists', () => {
  assert.equal(isFirstRun(fakeDb({ created: '2026-01-01T00:00:00.000Z', adminCount: 1 })), false);
});

test('first run ends once install is marked complete', () => {
  const db = fakeDb({ created: '2026-01-01T00:00:00.000Z' });
  assert.equal(isFirstRun(db), true);
  markInstalled(db);
  assert.ok(db.settings[SETTINGS.completedAt]);
  assert.equal(isFirstRun(db), false);
});

test('admin form validation matches the registration rules', () => {
  assert.equal(validateAdminInput({ username: 'a', email: 'a@b.co', password: '12345678', password_confirm: '12345678' }, t), null);
  assert.equal(validateAdminInput({ email: 'a@b.co', password: '12345678', password_confirm: '12345678' }, t), 'routes.auth.allFieldsRequired');
  assert.equal(validateAdminInput({ username: 'a', email: 'a@b.co', password: '12345678', password_confirm: 'different' }, t), 'routes.auth.passwordsDontMatch');
  assert.equal(validateAdminInput({ username: 'a', email: 'a@b.co', password: 'short', password_confirm: 'short' }, t), 'routes.auth.passwordTooShort');
});
