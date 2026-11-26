require('dotenv').config();
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const install = require('./install');

const DRIVER = String(process.env.DB_DRIVER || 'sqlite').trim().toLowerCase();

const dbDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dbDir, 'panel.db');

// ─────────────────────────────────────────────────────────────────────────────
// SQLite adapter (sql.js wrapper that mimics the better-sqlite3 API)
// ─────────────────────────────────────────────────────────────────────────────
class SqliteAdapter {
  constructor(sqlJsDb) {
    this.db = sqlJsDb;
  }

  exec(sql) {
    this.db.run(sql);
  }

  prepare(sql) {
    const db = this.db;
    return {
      run(...params) {
        db.run(sql, params);
        const result = db.exec('SELECT last_insert_rowid() as id');
        const lastInsertRowid = result.length > 0 ? result[0].values[0][0] : 0;
        return { lastInsertRowid, changes: db.getRowsModified() };
      },
      get(...params) {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const cols = stmt.getColumnNames();
          const vals = stmt.get();
          stmt.free();
          const row = {};
          cols.forEach((c, i) => row[c] = vals[i]);
          return row;
        }
        stmt.free();
        return undefined;
      },
      all(...params) {
        const rows = [];
        const stmt = db.prepare(sql);
        stmt.bind(params);
        while (stmt.step()) {
          const cols = stmt.getColumnNames();
          const vals = stmt.get();
          const row = {};
          cols.forEach((c, i) => row[c] = vals[i]);
          rows.push(row);
        }
        stmt.free();
        return rows;
      }
    };
  }

  pragma(p) {
    try { this.db.run(`PRAGMA ${p}`); } catch {}
  }

  tableColumns(table) {
    return this.prepare(`PRAGMA table_info(${table})`).all();
  }

  save() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
    // sql.js' export() reopens the underlying connection, which resets
    // connection-level pragmas. Re-enable foreign key enforcement so
    // ON DELETE CASCADE / SET NULL constraints keep working after a save.
    this.pragma('foreign_keys = ON');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MySQL adapter. Presents the same synchronous API as SqliteAdapter while the
// actual driver (mysql2) runs in a worker thread. See mysql-sync*.js.
// ─────────────────────────────────────────────────────────────────────────────
class MysqlAdapter {
  constructor(connection) {
    this.conn = connection;
  }

  // Translate the handful of SQLite-specific statements used by the panel.
  normalize(sql) {
    return sql
      .replace(/INSERT\s+OR\s+IGNORE/gi, 'INSERT IGNORE')
      .replace(/INSERT\s+OR\s+REPLACE/gi, 'REPLACE')
      .replace(/date\(\s*'now'\s*,\s*'-(\d+)\s+days?'\s*\)/gi, 'DATE_SUB(CURDATE(), INTERVAL $1 DAY)');
  }

  static clean(params) {
    return params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p;
    });
  }

  exec(sql) {
    this.conn.request({ method: 'exec', sql });
  }

  prepare(sql) {
    const q = this.normalize(sql);
    const conn = this.conn;
    return {
      run(...params) {
        const r = conn.request({ method: 'run', sql: q, params: MysqlAdapter.clean(params) });
        return { lastInsertRowid: r.insertId, changes: r.affectedRows };
      },
      get(...params) {
        const rows = conn.request({ method: 'get', sql: q, params: MysqlAdapter.clean(params) });
        return Array.isArray(rows) ? rows[0] : rows;
      },
      all(...params) {
        const rows = conn.request({ method: 'all', sql: q, params: MysqlAdapter.clean(params) });
        return Array.isArray(rows) ? rows : [];
      }
    };
  }

  pragma() {}

  tableColumns(table) {
    return this.prepare('SHOW COLUMNS FROM `' + table + '`').all().map((r) => ({ name: r.Field }));
  }

  save() {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────
const SQLITE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      root_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      memo TEXT,
      allowed_ips TEXT DEFAULT '[]',
      source VARCHAR(20) NOT NULL DEFAULT 'user',
      created_by INTEGER,
      last_used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ssh_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      short TEXT UNIQUE NOT NULL,
      long TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      fqdn TEXT NOT NULL,
      scheme TEXT DEFAULT 'https',
      memory INTEGER NOT NULL,
      disk INTEGER NOT NULL,
      cpu INTEGER NOT NULL,
      disk_overallocate INTEGER DEFAULT 0,
      memory_overallocate INTEGER DEFAULT 0,
      daemon_token TEXT NOT NULL,
      daemon_listen TEXT DEFAULT '8080',
      public INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      daemon_type TEXT DEFAULT 'rubityle',
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      allocation_id INTEGER,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'offline',
      suspended INTEGER DEFAULT 0,
      install_status TEXT DEFAULT 'installed',
      install_error TEXT,
      startup_command TEXT,
      egg_id INTEGER,
      image TEXT,
      memory INTEGER DEFAULT 1024,
      disk INTEGER DEFAULT 10240,
      cpu INTEGER DEFAULT 100,
      io INTEGER DEFAULT 500,
      databases INTEGER DEFAULT 0,
      database_limit INTEGER DEFAULT 0,
      backups_limit INTEGER DEFAULT 3,
      allocation_limit INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (allocation_id) REFERENCES allocations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      ip TEXT NOT NULL,
      port INTEGER NOT NULL,
      ip_alias TEXT,
      server_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL,
      UNIQUE(node_id, port)
    );

    CREATE TABLE IF NOT EXISTS server_variables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      env_var TEXT NOT NULL,
      value TEXT,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS database_hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 3306,
      username TEXT,
      password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS databases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      database_host_id INTEGER,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      host TEXT DEFAULT '127.0.0.1',
      port INTEGER DEFAULT 3306,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (database_host_id) REFERENCES database_hosts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      file TEXT,
      size INTEGER DEFAULT 0,
      ignored_files TEXT,
      locked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedule_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      payload TEXT,
      is_active INTEGER DEFAULT 1,
      cron TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subusers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      permissions TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS eggs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      docker_image TEXT,
      startup TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      author_id INTEGER,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS egg_variables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      egg_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      env_var TEXT NOT NULL,
      default_value TEXT,
      user_viewable INTEGER DEFAULT 1,
      user_editable INTEGER DEFAULT 1,
      rules TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (egg_id) REFERENCES eggs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS panel_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS extensions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT,
      author TEXT,
      description TEXT,
      enabled INTEGER DEFAULT 0,
      settings TEXT DEFAULT '{}',
      installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `;

// MySQL schema. Same columns as the SQLite one, with MySQL-compatible types and
// an ordering that satisfies foreign keys (MySQL requires referenced tables to
// exist first, so the circular servers <-> allocations link is added via ALTER).
const MYSQL_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "uuid VARCHAR(191) UNIQUE NOT NULL," +
    "username VARCHAR(191) UNIQUE NOT NULL," +
    "email VARCHAR(191) UNIQUE NOT NULL," +
    "password VARCHAR(255) NOT NULL," +
    "root_admin INT DEFAULT 0," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS locations (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "short VARCHAR(191) UNIQUE NOT NULL," +
    "`long` VARCHAR(255) NOT NULL," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS nodes (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "location_id INT NOT NULL," +
    "name VARCHAR(255) NOT NULL," +
    "fqdn VARCHAR(255) NOT NULL," +
    "scheme VARCHAR(20) DEFAULT 'https'," +
    "memory INT NOT NULL," +
    "disk INT NOT NULL," +
    "cpu INT NOT NULL," +
    "disk_overallocate INT DEFAULT 0," +
    "memory_overallocate INT DEFAULT 0," +
    "daemon_token VARCHAR(255) NOT NULL," +
    "daemon_listen VARCHAR(20) DEFAULT '8080'," +
    "public INT DEFAULT 1," +
    "daemon_type VARCHAR(20) DEFAULT 'rubityle'," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS allocations (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "node_id INT NOT NULL," +
    "ip VARCHAR(45) NOT NULL," +
    "port INT NOT NULL," +
    "ip_alias VARCHAR(255)," +
    "server_id INT," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE," +
    "UNIQUE KEY uniq_node_port (node_id, port)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS servers (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "uuid VARCHAR(191) UNIQUE NOT NULL," +
    "user_id INT NOT NULL," +
    "node_id INT NOT NULL," +
    "allocation_id INT," +
    "name VARCHAR(255) NOT NULL," +
    "description TEXT," +
    "status VARCHAR(50) DEFAULT 'offline'," +
    "suspended TINYINT(1) DEFAULT 0," +
    "install_status VARCHAR(50) DEFAULT 'installed'," +
    "install_error TEXT," +
    "startup_command TEXT," +
    "egg_id INT," +
    "image TEXT," +
    "memory INT DEFAULT 1024," +
    "disk INT DEFAULT 10240," +
    "cpu INT DEFAULT 100," +
    "io INT DEFAULT 500," +
    "`databases` INT DEFAULT 0," +
    "database_limit INT DEFAULT 0," +
    "backups_limit INT DEFAULT 3," +
    "allocation_limit INT DEFAULT 0," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE," +
    "FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE," +
    "FOREIGN KEY (allocation_id) REFERENCES allocations(id) ON DELETE SET NULL" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS api_keys (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "user_id INT NOT NULL," +
    "token VARCHAR(191) UNIQUE NOT NULL," +
    "memo TEXT," +
    "allowed_ips VARCHAR(1000) DEFAULT '[]'," +
    "source VARCHAR(20) NOT NULL DEFAULT 'user'," +
    "created_by INT," +
    "last_used_at DATETIME," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS ssh_keys (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "user_id INT NOT NULL," +
    "name VARCHAR(255) NOT NULL," +
    "public_key TEXT NOT NULL," +
    "fingerprint VARCHAR(255)," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS server_variables (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "server_id INT NOT NULL," +
    "env_var VARCHAR(255) NOT NULL," +
    "value TEXT," +
    "FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS database_hosts (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "name VARCHAR(255) NOT NULL," +
    "host VARCHAR(255) NOT NULL," +
    "port INT DEFAULT 3306," +
    "username VARCHAR(255)," +
    "password VARCHAR(255)," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS databases (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "server_id INT NOT NULL," +
    "database_host_id INT," +
    "name VARCHAR(255) NOT NULL," +
    "username VARCHAR(255) NOT NULL," +
    "password VARCHAR(255) NOT NULL," +
    "host VARCHAR(255) DEFAULT '127.0.0.1'," +
    "port INT DEFAULT 3306," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE," +
    "FOREIGN KEY (database_host_id) REFERENCES database_hosts(id) ON DELETE SET NULL" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS backups (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "server_id INT NOT NULL," +
    "name VARCHAR(255) NOT NULL," +
    "file VARCHAR(255)," +
    "size BIGINT DEFAULT 0," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS schedule_tasks (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "server_id INT NOT NULL," +
    "action VARCHAR(50) NOT NULL," +
    "payload TEXT," +
    "is_active INT DEFAULT 1," +
    "cron VARCHAR(255)," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS subusers (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "server_id INT NOT NULL," +
    "user_id INT NOT NULL," +
    "permissions VARCHAR(1000) DEFAULT '[]'," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE," +
    "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS eggs (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "name VARCHAR(255) NOT NULL," +
    "description TEXT," +
    "docker_image TEXT," +
    "startup TEXT," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS nests (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "uuid VARCHAR(191) UNIQUE NOT NULL," +
    "author_id INT," +
    "name VARCHAR(255) NOT NULL," +
    "description TEXT," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS egg_variables (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "egg_id INT NOT NULL," +
    "name VARCHAR(255) NOT NULL," +
    "description TEXT," +
    "env_var VARCHAR(255) NOT NULL," +
    "default_value TEXT," +
    "user_viewable INT DEFAULT 1," +
    "user_editable INT DEFAULT 1," +
    "rules TEXT," +
    "sort_order INT DEFAULT 0," +
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "FOREIGN KEY (egg_id) REFERENCES eggs(id) ON DELETE CASCADE" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS panel_settings (" +
    "`key` VARCHAR(191) PRIMARY KEY," +
    "value TEXT" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS extensions (" +
    "id VARCHAR(191) PRIMARY KEY," +
    "name VARCHAR(255) NOT NULL," +
    "version VARCHAR(50)," +
    "author VARCHAR(255)," +
    "description TEXT," +
    "enabled INT DEFAULT 0," +
    "settings TEXT," +
    "installed_at DATETIME DEFAULT CURRENT_TIMESTAMP," +
    "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
].join(';\n');

// ─────────────────────────────────────────────────────────────────────────────
// Migrations (shared across drivers; column checks go through the adapter)
// ─────────────────────────────────────────────────────────────────────────────
function runMigrations(wrapper) {
  const eggCols = wrapper.tableColumns('eggs');
  if (!eggCols.some(c => c.name === 'nest_id')) {
    wrapper.exec('ALTER TABLE eggs ADD COLUMN nest_id INTEGER');
  }
  if (!eggCols.some(c => c.name === 'author')) {
    wrapper.exec('ALTER TABLE eggs ADD COLUMN author TEXT');
  }
  if (!eggCols.some(c => c.name === 'features')) {
    wrapper.exec('ALTER TABLE eggs ADD COLUMN features TEXT');
  }
  if (!eggCols.some(c => c.name === 'docker_images')) {
    wrapper.exec('ALTER TABLE eggs ADD COLUMN docker_images TEXT');
  }
  if (!eggCols.some(c => c.name === 'file_denylist')) {
    wrapper.exec('ALTER TABLE eggs ADD COLUMN file_denylist TEXT');
  }
  if (!eggCols.some(c => c.name === 'config')) {
    wrapper.exec('ALTER TABLE eggs ADD COLUMN config TEXT');
  }
  if (!eggCols.some(c => c.name === 'install_script')) {
    wrapper.exec('ALTER TABLE eggs ADD COLUMN install_script TEXT');
  }
  const varCols = wrapper.tableColumns('egg_variables');
  if (!varCols.some(c => c.name === 'field_type')) {
    wrapper.exec('ALTER TABLE egg_variables ADD COLUMN field_type TEXT');
  }
  const serverCols = wrapper.tableColumns('servers');
  if (!serverCols.some(c => c.name === 'swap')) {
    wrapper.exec('ALTER TABLE servers ADD COLUMN swap INTEGER DEFAULT 0');
  }
  if (!serverCols.some(c => c.name === 'install_error')) {
    wrapper.exec('ALTER TABLE servers ADD COLUMN install_error TEXT');
  }
  if (!serverCols.some(c => c.name === 'sftp_password')) {
    wrapper.exec('ALTER TABLE servers ADD COLUMN sftp_password TEXT');
  }
  if (!serverCols.some(c => c.name === 'suspended')) {
    wrapper.exec('ALTER TABLE servers ADD COLUMN suspended INTEGER DEFAULT 0');
  }
  // 0 means unlimited additional allocations for existing and new servers.
  if (!serverCols.some(c => c.name === 'allocation_limit')) {
    wrapper.exec('ALTER TABLE servers ADD COLUMN allocation_limit INTEGER DEFAULT 0');
  }
  const backupCols = wrapper.tableColumns('backups');
  if (!backupCols.some(c => c.name === 'ignored_files')) {
    wrapper.exec('ALTER TABLE backups ADD COLUMN ignored_files TEXT');
  }
  if (!backupCols.some(c => c.name === 'locked')) {
    wrapper.exec('ALTER TABLE backups ADD COLUMN locked INTEGER DEFAULT 0');
  }
  const existingDbCols = wrapper.tableColumns('databases');
  if (!existingDbCols.some(c => c.name === 'database_host_id')) {
    wrapper.exec('ALTER TABLE databases ADD COLUMN database_host_id INTEGER');
  }
  const nodeCols = wrapper.tableColumns('nodes');
  if (!nodeCols.some(c => c.name === 'sftp_port')) {
    wrapper.exec('ALTER TABLE nodes ADD COLUMN sftp_port INTEGER DEFAULT 2022');
  }
  if (!nodeCols.some(c => c.name === 'daemon_type')) {
    wrapper.exec("ALTER TABLE nodes ADD COLUMN daemon_type TEXT DEFAULT 'rubityle'");
  }
  const apiKeyCols = wrapper.tableColumns('api_keys');
  if (!apiKeyCols.some(c => c.name === 'source')) {
    wrapper.exec("ALTER TABLE api_keys ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'user'");
  }
  if (!apiKeyCols.some(c => c.name === 'created_by')) {
    wrapper.exec('ALTER TABLE api_keys ADD COLUMN created_by INTEGER');
  }
  // Reclassify keys created before the source tracking existed. Rows inserted
  // by the current code always have created_by set, so this runs only once.
  wrapper.exec("UPDATE api_keys SET source = 'mobile', created_by = user_id WHERE created_by IS NULL AND memo LIKE 'Pyloxdactyl APP:%'");
  wrapper.exec("UPDATE api_keys SET source = 'admin', created_by = user_id WHERE created_by IS NULL AND (memo IS NULL OR memo NOT LIKE 'Pyloxdactyl APP:%') AND user_id IN (SELECT id FROM users WHERE root_admin = 1)");
  const userCols = wrapper.tableColumns('users');
  if (!userCols.some(c => c.name === 'totp_secret')) {
    wrapper.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
  }
  if (!userCols.some(c => c.name === 'totp_enabled')) {
    wrapper.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0');
  }
  if (!userCols.some(c => c.name === 'language')) {
    wrapper.exec("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'en'");
  }
  if (!userCols.some(c => c.name === 'reset_token')) {
    wrapper.exec('ALTER TABLE users ADD COLUMN reset_token TEXT');
  }
  if (!userCols.some(c => c.name === 'reset_token_expires')) {
    wrapper.exec('ALTER TABLE users ADD COLUMN reset_token_expires TEXT');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────
async function initSqlite() {
  const SQL = await initSqlJs();
  let sqlDb;
  const isNewDatabase = !fs.existsSync(dbPath);

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  const wrapper = new SqliteAdapter(sqlDb);
  wrapper.pragma('journal_mode = WAL');
  wrapper.pragma('foreign_keys = ON');
  wrapper.exec(SQLITE_SCHEMA);
  runMigrations(wrapper);
  if (isNewDatabase) {
    wrapper.prepare('INSERT OR IGNORE INTO panel_settings (`key`, value) VALUES (?, ?)').run(install.SETTINGS.createdAt, install.stamp());
  }
  wrapper.save();
  console.log('[DB] SQLite database initialized at', dbPath);

  // Auto-save every 5 seconds
  setInterval(() => {
    try {
      if (_db) _db.save();
    } catch (err) {
      console.error('[DB] Auto-save failed:', err && err.message ? err.message : err);
    }
  }, 5000);

  return wrapper;
}

function initMysql() {
  const MysqlSyncConnection = require('./mysql-sync');
  const connection = new MysqlSyncConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pylox',
    charset: 'utf8mb4',
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 10000,
  }, {
    timeoutMs: Number(process.env.DB_QUERY_TIMEOUT) || 30000,
  });

  const wrapper = new MysqlAdapter(connection);
  let isNewDatabase = false;
  try {
    wrapper.prepare('SELECT `key` FROM panel_settings LIMIT 1').get();
  } catch (err) {
    isNewDatabase = true;
  }
  wrapper.exec(MYSQL_SCHEMA);

  // servers <-> allocations is a circular reference, so add the reverse link
  // after both tables exist. Ignore the error when it is already present.
  try {
    wrapper.exec('ALTER TABLE allocations ADD CONSTRAINT fk_allocations_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL');
  } catch (e) {
    if (!/duplicate|already exists|errno: 1826/i.test(e.message)) throw e;
  }

  runMigrations(wrapper);
  if (isNewDatabase) {
    wrapper.prepare('INSERT OR IGNORE INTO panel_settings (`key`, value) VALUES (?, ?)').run(install.SETTINGS.createdAt, install.stamp());
  }
  console.log(`[DB] MySQL database initialized at ${process.env.DB_HOST || '127.0.0.1'}:${Number(process.env.DB_PORT) || 3306}/${process.env.DB_NAME || 'pylox'}`);
  return wrapper;
}

async function initDB() {
  if (DRIVER === 'mysql') return initMysql();
  if (DRIVER !== 'sqlite') {
    console.warn(`[DB] Unknown DB_DRIVER "${DRIVER}", falling back to sqlite`);
  }
  return initSqlite();
}

function userSettingKey(userId, key) {
  return `user:${userId}:${key}`;
}

// Initialize asynchronously; queries made before `_inner` is ready throw.
let dbReady = false;
const dbProxy = {
  _inner: null,
  exec(sql) { this._inner.exec(sql); },
  prepare(sql) { return this._inner.prepare(sql); },
  pragma(p) { this._inner.pragma(p); },
  save() { this._inner.save(); },
};

let _db = null;

initDB().then(db => {
  dbProxy._inner = db;
  _db = db;
  dbReady = true;
}).catch(err => {
  console.error('[DB] Init failed:', err.message || err);
  process.exit(1);
});

module.exports = {
  driver: DRIVER,
  ready() { return dbReady; },
  exec(sql) { if (dbProxy._inner) dbProxy._inner.exec(sql); },
  prepare(sql) {
    if (dbProxy._inner) return dbProxy._inner.prepare(sql);
    throw new Error('Database not ready');
  },
  pragma(p) { if (dbProxy._inner) dbProxy._inner.pragma(p); },
  save() { if (dbProxy._inner) dbProxy._inner.save(); },
  isFirstRun() { return install.isFirstRun(module.exports); },
  markInstalled() { return install.markInstalled(module.exports); },
  getSetting(key, def) {
    if (!dbProxy._inner) return def;
    const row = dbProxy._inner.prepare('SELECT value FROM panel_settings WHERE `key` = ?').get(key);
    return row ? row.value : def;
  },
  setSetting(key, value) {
    if (!dbProxy._inner) return;
    const row = dbProxy._inner.prepare('SELECT `key` FROM panel_settings WHERE `key` = ?').get(key);
    if (row) dbProxy._inner.prepare('UPDATE panel_settings SET value = ? WHERE `key` = ?').run(String(value), key);
    else dbProxy._inner.prepare('INSERT INTO panel_settings (`key`, value) VALUES (?, ?)').run(key, String(value));
  },
  // Namespaced settings for a single account, stored in the same server-side
  // table so preferences (e.g. dashboard card order) follow the user across
  // devices instead of living in a browser's localStorage.
  getUserSetting(userId, key, def) {
    if (!dbProxy._inner) return def;
    const row = dbProxy._inner.prepare('SELECT value FROM panel_settings WHERE `key` = ?').get(userSettingKey(userId, key));
    return row ? row.value : def;
  },
  setUserSetting(userId, key, value) {
    if (!dbProxy._inner) return;
    const k = userSettingKey(userId, key);
    const row = dbProxy._inner.prepare('SELECT `key` FROM panel_settings WHERE `key` = ?').get(k);
    if (row) dbProxy._inner.prepare('UPDATE panel_settings SET value = ? WHERE `key` = ?').run(String(value), k);
    else dbProxy._inner.prepare('INSERT INTO panel_settings (`key`, value) VALUES (?, ?)').run(k, String(value));
  },
};
