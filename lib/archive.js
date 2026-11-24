const COMPRESSED_EXTENSIONS = new Set([
  'zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz', 'tbz2', 'txz', 'lz', 'lzma', 'lzo', 'zst',
]);

// Does the given file name look like a compressed archive? Uses the last
// extension so multi-part names like "world.tar.gz" are detected via "gz".
function isCompressed(name) {
  if (!name || typeof name !== 'string') return false;
  const base = name.split(/[\\/]/).pop();
  if (!base) return false;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return COMPRESSED_EXTENSIONS.has(ext);
}

module.exports = { isCompressed, COMPRESSED_EXTENSIONS };
