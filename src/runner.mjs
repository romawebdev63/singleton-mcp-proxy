import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink, appendFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerType, startStdioServer } from 'mcp-proxy';

const PACKAGE_ENTRY = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function config() {
  const url = process.env.SINGLETON_MCP_URL || 'http://127.0.0.1:8892/mcp';
  const transportName = (process.env.SINGLETON_MCP_TRANSPORT || 'stream').toLowerCase();
  if (!['stream', 'sse'].includes(transportName)) {
    throw new Error('SINGLETON_MCP_TRANSPORT must be "stream" or "sse".');
  }

  let command;
  try {
    command = JSON.parse(process.env.SINGLETON_MCP_COMMAND || '');
  } catch {
    command = null;
  }
  if (!Array.isArray(command) || command.length === 0 || !command.every((x) => typeof x === 'string')) {
    command = process.platform === 'win32'
      ? ['npx.cmd', '-y', 'browser-search-mcp']
      : ['npx', '-y', 'browser-search-mcp'];
  }

  const baseStateDir = process.env.SINGLETON_MCP_STATE_DIR || join(homedir(), '.singleton-mcp-proxy');
  // One supervisor per endpoint, even if separate OpenCode entries differ in transport settings.
  const key = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const stateDir = join(baseStateDir, key);
  return {
    url,
    transport: transportName === 'sse' ? ServerType.SSE : ServerType.HTTPStream,
    command,
    startTimeoutMs: positiveInt(process.env.SINGLETON_MCP_START_TIMEOUT_MS, 300000),
    retryMs: positiveInt(process.env.SINGLETON_MCP_RETRY_MS, 1500),
    stateDir,
    lockFile: join(stateDir, 'supervisor.json'),
    logFile: join(stateDir, 'server.log'),
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function endpointAddress(urlString) {
  const url = new URL(urlString);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('SINGLETON_MCP_URL must be an http:// or https:// URL.');
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  };
}

function tcpReady(urlString, timeoutMs = 700) {
  const { host, port } = endpointAddress(urlString);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function waitForEndpoint(url, timeoutMs, retryMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpReady(url)) return;
    await sleep(retryMs);
  }
  throw new Error(`Timed out waiting for TCP endpoint ${url} after ${timeoutMs} ms. See supervisor log for server startup errors.`);
}

async function readLock(lockFile) {
  try { return JSON.parse(await readFile(lockFile, 'utf8')); }
  catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

async function acquireSupervisorLock(cfg) {
  await mkdir(cfg.stateDir, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const handle = await open(cfg.lockFile, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const lock = await readLock(cfg.lockFile);
      if (lock && pidAlive(lock.pid)) return false;
      // Exclusive-create and lock-file write are separate operations. Give a new,
      // temporarily empty lock time to receive its PID before treating it as stale.
      if (!lock) {
        try {
          const info = await stat(cfg.lockFile);
          if (Date.now() - info.mtimeMs < 5000) {
            await sleep(100);
            continue;
          }
        } catch (statError) {
          if (statError?.code === 'ENOENT') continue;
          throw statError;
        }
      }
      // The recorded owner is dead or the malformed lock is old.
      try { await unlink(cfg.lockFile); } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') await sleep(100); }
    }
  }
  return false;
}

async function spawnTarget(cfg) {
  const [command, ...args] = cfg.command;
  await appendFile(cfg.logFile, `\n[${new Date().toISOString()}] starting: ${JSON.stringify(cfg.command)}\n`);
  // Windows command shims (.cmd/.bat) need a shell; on POSIX the command is spawned directly.
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logStream = createWriteStream(cfg.logFile, { flags: 'a' });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  child.once('close', () => logStream.end());
  child.on('error', async (error) => {
    await appendFile(cfg.logFile, `[${new Date().toISOString()}] spawn error: ${error.stack || error}\n`).catch(() => {});
  });
  child.on('exit', async (code, signal) => {
    await appendFile(cfg.logFile, `[${new Date().toISOString()}] server process exited code=${code} signal=${signal}\n`).catch(() => {});
  });
  return child;
}

async function supervise() {
  const cfg = config();
  const acquired = await acquireSupervisorLock(cfg);
  if (!acquired) return; // Another supervisor already owns this endpoint/configuration.

  let child = null;
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    const lock = await readLock(cfg.lockFile);
    if (lock?.pid === process.pid) await unlink(cfg.lockFile).catch(() => {});
  };
  process.once('SIGINT', () => { void cleanup(); process.exit(0); });
  process.once('SIGTERM', () => { void cleanup(); process.exit(0); });
  await appendFile(cfg.logFile, `[${new Date().toISOString()}] supervisor started pid=${process.pid}, endpoint=${cfg.url}\n`);
  while (!stopping) {
    if (await tcpReady(cfg.url)) {
      await sleep(1000);
      continue;
    }

    if (!child) {
      child = await spawnTarget(cfg);
      const startedChild = child;
      startedChild.once('exit', () => {
        if (child === startedChild) child = null;
      });
      startedChild.once('error', () => {
        if (child === startedChild) child = null;
      });
    }
    await sleep(cfg.retryMs);
  }
}

async function ensureSupervisor(cfg) {
  await mkdir(cfg.stateDir, { recursive: true });
  // A short-lived detached supervisor is shared by all local stdio bridge processes.
  const args = [PACKAGE_ENTRY, '--supervisor'];
  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

export async function main() {
  if (process.argv.includes('--supervisor')) {
    await supervise();
    return;
  }
  const cfg = config();
  await ensureSupervisor(cfg);
  await waitForEndpoint(cfg.url, cfg.startTimeoutMs, cfg.retryMs);
  await startStdioServer({ serverType: cfg.transport, url: cfg.url });
}
