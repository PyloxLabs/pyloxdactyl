const Docker = require('dockerode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const NETWORK_NAME = process.env.DOCKER_NETWORK || 'pylox-servers';

// Absolute host path where the panel stores a server's container files.
function serverHome(uuid) {
  const dir = path.join(__dirname, '..', 'data', uuid, 'home', 'container');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Resolve the primary allocation port for a server (falls back to 25565)
function resolveAllocationPort(server) {
  if (server.allocation_port) return server.allocation_port;
  if (server.allocation_id) {
    try {
      const alloc = require('./db').prepare('SELECT * FROM allocations WHERE id = ?').get(server.allocation_id);
      if (alloc && alloc.port) return alloc.port;
    } catch {}
  }
  return 25565;
}

async function ensureNetwork() {
  try {
    await docker.getNetwork(NETWORK_NAME).inspect();
  } catch {
    await docker.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge' });
    console.log(`[Docker] Created network: ${NETWORK_NAME}`);
  }
}

async function createServer(server, egg) {
  await ensureNetwork();

  const containerName = `pylox-server-${server.uuid}`;
  const memory = server.memory * 1024 * 1024;
  const cpuShares = server.cpu * 1024;

  const env = [
    `SERVER_MEMORY=${server.memory}`,
    `SERVER_PORT=${resolveAllocationPort(server)}`,
    `SERVER_NAME=${server.name}`,
    `PANEL_URL=${process.env.APP_URL || 'http://localhost:6000'}`,
    `DAEMON_SECRET=${process.env.DAEMON_SECRET || 'default-secret'}`,
    `SERVER_ID=${server.id}`,
    `SERVER_UUID=${server.uuid}`,
  ];

  // Load server env variables
  const vars = require('./db').prepare('SELECT * FROM server_variables WHERE server_id = ?').all(server.id);
  for (const v of vars) {
    env.push(`${v.env_var}=${v.value || ''}`);
  }

  let image = egg ? egg.docker_image : '';
  if (!image && egg && egg.docker_images) {
    try { image = Object.keys(JSON.parse(egg.docker_images))[0] || ''; } catch {}
  }
  if (!image) image = server.image || 'ghcr.io/pterodactyl/yolks:java_17';

  const hostHome = serverHome(server.uuid);

  // Build startup command, substituting egg placeholder variables ({{VAR}})
  let startup = server.startup_command || (egg ? egg.startup : '') || '';
  const envMap = {};
  for (const e of env) { const i = e.indexOf('='); if (i > 0) envMap[e.slice(0, i)] = e.slice(i + 1); }
  startup = startup.replace(/\{\{([^}]+)\}\}/g, (m, key) => envMap[key] !== undefined ? envMap[key] : '');

  const container = await docker.createContainer({
    Image: image,
    name: containerName,
    Env: env,
    Hostname: server.uuid.substring(0, 12),
    ExposedPorts: {},
    HostConfig: {
      Memory: memory,
      CpuShares: cpuShares,
      NetworkMode: NETWORK_NAME,
      Binds: [
        `${hostHome}:/home/container`
      ],
      PortBindings: {},
      RestartPolicy: { Name: 'unless-stopped' },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [NETWORK_NAME]: {}
      }
    },
    Labels: {
      'pylox.panel': 'true',
      'pylox.server.id': String(server.id),
      'pylox.server.uuid': server.uuid,
    },
    WorkingDir: '/home/container',
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: ['export HOME=/home/container; echo "[Pylox] Starting: ' + startup.replace(/"/g, '\\"') + '" && exec ' + startup],
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    StopTimeout: 60,
  });

  return container;
}

// Look up the server + egg from the database and create the Docker container
// if it doesn't already exist. Returns the container.
async function ensureServerContainer(uuid) {
  const db = require('./db');
  const srv = db.prepare('SELECT * FROM servers WHERE uuid = ?').get(uuid);
  if (!srv) throw new Error('Server not found in database');

  const existing = await new Promise((resolve) => {
    docker.getContainer(`pylox-server-${uuid}`).inspect((err, info) => {
      if (err || !info) return resolve(null);
      resolve(docker.getContainer(`pylox-server-${uuid}`));
    });
  });
  if (existing) return existing;

  const egg = srv.egg_id
    ? db.prepare('SELECT * FROM eggs WHERE id = ?').get(srv.egg_id)
    : null;

  return createServer(srv, egg);
}

async function startServer(uuid) {
  const container = await ensureServerContainer(uuid);
  await container.start();
  return container;
}

async function stopServer(uuid) {
  const container = docker.getContainer(`pylox-server-${uuid}`);
  try { await container.stop({ t: 60 }); } catch (e) { /* already stopped */ }
}

async function killServer(uuid) {
  const container = docker.getContainer(`pylox-server-${uuid}`);
  try { await container.kill(); } catch (e) { /* already stopped */ }
}

async function removeServer(uuid) {
  const container = docker.getContainer(`pylox-server-${uuid}`);
  try {
    await container.stop({ t: 10 });
  } catch {}
  try {
    await container.remove({ v: true });
  } catch {}
}

async function restartServer(uuid) {
  const container = docker.getContainer(`pylox-server-${uuid}`);
  await container.restart({ t: 30 });
}

async function getServerStatus(uuid) {
  try {
    const container = docker.getContainer(`pylox-server-${uuid}`);
    const info = await container.inspect();
    return info.State.Status;
  } catch {
    return 'not_created';
  }
}

async function getResourceUsage(uuid) {
  try {
    const container = docker.getContainer(`pylox-server-${uuid}`);
    const stats = await container.stats({ stream: false });
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100;
    return {
      cpu: Math.round(cpuPercent * 100) / 100,
      memory: stats.memory_stats.usage || 0,
      memory_limit: stats.memory_stats.limit || 0,
      network_rx: stats.networks ? Object.values(stats.networks).reduce((a, n) => a + n.rx_bytes, 0) : 0,
      network_tx: stats.networks ? Object.values(stats.networks).reduce((a, n) => a + n.tx_bytes, 0) : 0,
      disk_read: stats.blkio_stats.io_service_bytes_recursive?.find(x => x.op === 'Read')?.value || 0,
      disk_write: stats.blkio_stats.io_service_bytes_recursive?.find(x => x.op === 'Write')?.value || 0,
    };
  } catch {
    return { cpu: 0, memory: 0, memory_limit: 0, network_rx: 0, network_tx: 0 };
  }
}

async function sendCommand(uuid, command) {
  const container = docker.getContainer(`pylox-server-${uuid}`);
  const exec = await container.exec({
    Cmd: ['/bin/bash', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
  });
  return exec;
}

async function listContainers() {
  const containers = await docker.listContainers({ filters: { label: ['pylox.panel=true'] } });
  return containers;
}

async function getDockerInfo() {
  try {
    const info = await docker.info();
    return {
      containers_running: info.ContainersRunning,
      containers_stopped: info.ContainersStopped,
      images: info.Images,
      server_version: info.ServerVersion,
    };
  } catch {
    return null;
  }
}

module.exports = {
  docker,
  ensureNetwork,
  createServer,
  startServer,
  stopServer,
  killServer,
  removeServer,
  restartServer,
  getServerStatus,
  getResourceUsage,
  sendCommand,
  listContainers,
  getDockerInfo,
};
