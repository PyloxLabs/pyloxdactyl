const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'msi', 'com', 'scr', 'pif', 'cpl', 'bat', 'cmd',
  'bin', 'elf', 'out', 'run', 'app', 'appimage', 'apk', 'deb', 'rpm',
  'dll', 'so', 'dylib', 'o', 'a',
  'jar', 'war',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'vbs', 'wsf', 'py',
]);

function isExecutable(name) {
  if (!name || typeof name !== 'string') return false;
  const base = name.split(/[\\/]/).pop();
  if (!base) return false;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

module.exports = { isExecutable, EXECUTABLE_EXTENSIONS };
