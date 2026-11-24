function normalizeDockerImages(data) {
  if (data.docker_images && typeof data.docker_images === 'object' && !Array.isArray(data.docker_images)) {
    const out = {};
    for (const [entryKey, entryVal] of Object.entries(data.docker_images)) {
      const label = String(entryKey);
      const ref = typeof entryVal === 'string' && entryVal.trim() ? entryVal.trim() : entryKey;
      out[ref] = label;
    }
    return out;
  }
  if (Array.isArray(data.docker_images)) {
    const out = {};
    for (const img of data.docker_images) {
      if (typeof img === 'string') out[img] = img;
      else if (img && img.image) out[img.image] = img.docker_image || img.name || img.image;
    }
    if (Object.keys(out).length > 0) return out;
  }
  if (data.docker_image) {
    const map = {};
    map[data.docker_image] = data.docker_image;
    return map;
  }
  return {};
}

function parseEggJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }

  if (!data || typeof data !== 'object' || !data.name) {
    if (data && typeof data === 'object' && data.egg && data.egg.name) data = data.egg;
    else if (Array.isArray(data) && data[0] && data[0].name) data = data[0];
  }
  if (!data || !data.name) throw new Error('Not a valid egg file (missing "name").');

  const dockerImages = normalizeDockerImages(data);
  const dockerImagesJson = JSON.stringify(dockerImages);
  const firstImage = Object.keys(dockerImages)[0] || data.docker_image || 'ghcr.io/pterodactyl/yolks:alpine';

  const metaVersion = (data.meta && data.meta.version) || '';
  let source = 'Pterodactyl/Pelican';
  if (/pelican/i.test(metaVersion)) source = 'Pelican';
  else if (/PTDL_v1|pterodactyl/i.test(metaVersion)) source = 'Pterodactyl';
  else if (data._comment) source = 'Pterodactyl';
  else if (metaVersion === 'PTDL_v2') source = 'Pelican';

  const variables = Array.isArray(data.variables) ? data.variables : [];

  return {
    source,
    name: String(data.name).trim(),
    author: data.author || '',
    description: data.description || '',
    features: JSON.stringify(Array.isArray(data.features) ? data.features : []),
    docker_image: firstImage,
    docker_images: dockerImagesJson,
    file_denylist: JSON.stringify(Array.isArray(data.file_denylist) ? data.file_denylist : []),
    config: JSON.stringify(data.config && typeof data.config === 'object' ? data.config : {}),
    install_script: JSON.stringify(
      data.scripts && data.scripts.installation && typeof data.scripts.installation === 'object'
        ? {
            ...data.scripts.installation,
            script: typeof data.scripts.installation.script === 'string'
              ? data.scripts.installation.script.replace(/\r\n?/g, '\n')
              : data.scripts.installation.script,
          }
        : null
    ),
    startup: data.startup || '',
    variables: variables.map((v, i) => ({
      name: v.name || v.env_variable || `Variable ${i + 1}`,
      description: v.description || '',
      env_var: v.env_variable || v.env_var || '',
      default_value: (v.default_value === undefined || v.default_value === null) ? '' : String(v.default_value),
      user_viewable: v.user_viewable === undefined ? 1 : (v.user_viewable ? 1 : 0),
      user_editable: v.user_editable === undefined ? 1 : (v.user_editable ? 1 : 0),
      rules: v.rules || '',
      field_type: v.field_type || '',
      sort_order: i,
    })),
  };
}

module.exports = { parseEggJson, normalizeDockerImages };
