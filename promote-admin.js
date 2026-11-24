'use strict';

// Promotes a user to root admin (or demotes with a second argument of 0).
// Usage: node promote-admin.js <email> [0|1]
// Run this from the panel folder, and stop the panel first: it keeps the
// database in memory and rewrites it every 5 seconds, which overwrites any
// change made underneath a running panel.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const db = require('./lib/db');

const email = process.argv[2];
const flag = process.argv[3] === undefined ? 1 : (Number(process.argv[3]) ? 1 : 0);

if (!email) {
  console.error('usage: node promote-admin.js <email> [0|1]');
  process.exit(1);
}

function waitReady() {
  return new Promise((resolve) => {
    (function poll() {
      if (db.ready()) return resolve();
      setTimeout(poll, 100);
    })();
  });
}

waitReady().then(() => {
  const user = db.prepare('SELECT id, username, root_admin FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error('No user found with email ' + email);
    process.exit(1);
  }
  db.prepare('UPDATE users SET root_admin = ? WHERE id = ?').run(flag, user.id);
  db.save();
  const check = db.prepare('SELECT root_admin FROM users WHERE id = ?').get(user.id);
  console.log(user.username + ' <' + email + '> root_admin: ' + user.root_admin + ' -> ' + check.root_admin);
  process.exit(0);
}).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
