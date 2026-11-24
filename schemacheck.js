const initSqlJs = require('sql.js');
const fs = require('fs');
const dbPath = 'C:/Users/usuario/Documents/Proyecto predeterminado/panel/data/panel.db';
initSqlJs().then((SQL) => {
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const r = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='eggs'");
  if (r && r[0] && r[0].values && r[0].values[0]) {
    console.log(r[0].values[0][0]);
  } else {
    console.log('none');
  }
});
