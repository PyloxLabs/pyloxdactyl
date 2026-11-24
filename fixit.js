const initSqlJs = require('sql.js');
const fs = require('fs');
const dbPath = 'C:/Users/usuario/Documents/Proyecto predeterminado/panel/data/panel.db';
function fixedBlock(eol) {
  return [
    '\tPROJECTS_JSON=`curl --user-agent "${USER_AGENT}"  -s https://fill.papermc.io/v3/projects/${PROJECT}`',
    '\tLATEST_VERSION=`echo "${PROJECTS_JSON}" | jq -r \'.versions | to_entries | .[0].value[0]\'`',
    '\tRESOLVED_VERSION=`echo "${PROJECTS_JSON}" | jq -r --arg VERSION "${MINECRAFT_VERSION}" \'.versions as $v | ($v[$VERSION][0]) // ([$v[][] | select(. == $VERSION)] | .[0]) // ([$v[][] | select(startswith($VERSION))] | .[0]) // empty\'`',
    '',
    '\tif [ -n "${RESOLVED_VERSION}" ]; then',
    '\t\techo -e "Version is valid. Using version ${RESOLVED_VERSION}"',
    '\t\tMINECRAFT_VERSION=${RESOLVED_VERSION}',
    '\telse',
    '\t\techo -e "Specified version not found. Defaulting to the latest ${PROJECT} version"',
    '\t\tMINECRAFT_VERSION=${LATEST_VERSION}',
    '\tfi',
  ].join(eol);
}
initSqlJs().then((SQL) => {
  const backup = dbPath + '.bak-' + Date.now();
  fs.copyFileSync(dbPath, backup);
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const res = db.exec("SELECT id, name, install_script FROM eggs WHERE install_script LIKE '%VER_EXISTS%'");
  if (!res.length) return console.log('no eggs');
  for (const row of res[0].values) {
    const [id, name, raw] = row;
    let spec; try { spec = JSON.parse(raw); } catch { continue; }
    if (spec.script.includes('RESOLVED_VERSION')) continue;
    const eol = spec.script.includes('\r\n') ? '\r\n' : '\n';
    const lines = spec.script.split(/\r?\n/);
    const start = lines.findIndex(l => l.includes('VER_EXISTS='));
    const endMark = lines.findIndex(l => l.includes('MINECRAFT_VERSION=${LATEST_VERSION}'));
    let fi = -1;
    for (let i = endMark; i < lines.length; i++) { if (/^\s*fi\s*$/.test(lines[i])) { fi = i; break; } }
    if (start < 0 || fi < 0) continue;
    const next = [...lines.slice(0, start), ...fixedBlock(eol).split(eol), ...lines.slice(fi + 1)];
    spec.script = next.join(eol);
    db.run('UPDATE eggs SET install_script = ? WHERE id = ?', [JSON.stringify(spec), id]);
    console.log(`patched egg ${id}`);
  }
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  console.log('done, backup=' + backup);
}).catch(e=>{console.error(e);process.exit(1);});
