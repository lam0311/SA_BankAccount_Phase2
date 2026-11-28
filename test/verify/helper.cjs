const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { existsSync, readFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { join, resolve } = require('node:path');
const Redis = require('ioredis');

const ROOT_DIR = resolve(__dirname, '../..');

function loadEnv() {
  const env = {};
  const envPath = join(ROOT_DIR, '.env');
  if (!existsSync(envPath)) return env;

  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function createRedis(dotEnv = loadEnv()) {
  const host = process.env.REDIS_HOST || dotEnv.REDIS_HOST || '127.0.0.1';
  const port = Number(process.env.REDIS_PORT || dotEnv.REDIS_PORT || 6379);
  return new Redis({ host, port, maxRetriesPerRequest: 2 });
}

async function clearRedisPrefix(redis, pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

async function getFreePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => (err ? fail(err) : ok(port)));
    });
  });
}

async function waitForServer(child, baseUrl, getLogs, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode}: ${getLogs()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/accounts`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server start timeout: ${getLogs()}`);
}

async function withServer(fn, extraEnv = {}) {
  const dotEnv = loadEnv();
  const redis = createRedis(dotEnv);
  const externalBase = process.env.VERIFY_BASE_URL;

  if (externalBase) {
    try {
      return await fn({ baseUrl: externalBase, redis });
    } finally {
      await redis.quit();
    }
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;
  let logs = '';

  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...dotEnv,
      NODE_ENV: 'test',
      PORT: String(port),
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(Number(process.env.REDIS_PORT || dotEnv.REDIS_PORT || 6379)),
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '7200',
      BCRYPT_ROUNDS: '4',
      RATE_LIMIT_ENABLED: 'true',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-4000);
  });
  child.stderr.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-4000);
  });

  try {
    await waitForServer(child, baseUrl, () => logs);
    return await fn({ baseUrl, redis });
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    if (redis.status === 'ready') {
      await redis.quit();
    } else {
      redis.disconnect();
    }
  }
}

async function req(baseUrl, method, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }

  const t0 = performance.now();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ms = Number((performance.now() - t0).toFixed(2));

  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, ms, json };
}

async function registerAndLogin(baseUrl, redis, prefix) {
  const ts = Date.now();
  const email = `${prefix}_${ts}_${Math.floor(Math.random() * 1000)}@bank.local`;
  const password = 'Password123!';

  await clearRedisPrefix(redis, 'rl:auth:*');
  const reg = await req(baseUrl, 'POST', '/auth/register', {
    body: {
      fullName: `verify ${prefix}`,
      email,
      password,
      confirmPassword: password,
    },
  });
  if (reg.status !== 201) {
    throw new Error(`register failed: status=${reg.status}`);
  }

  await clearRedisPrefix(redis, 'rl:auth:*');
  const login = await req(baseUrl, 'POST', '/auth/login', {
    body: { email, password },
  });
  if (login.status !== 200) {
    throw new Error(`login failed: status=${login.status}`);
  }

  return {
    email,
    password,
    userId: login.json.data.user.id,
    accessToken: login.json.data.accessToken,
    refreshToken: login.json.data.refreshToken,
  };
}

module.exports = {
  ROOT_DIR,
  loadEnv,
  createRedis,
  clearRedisPrefix,
  withServer,
  req,
  registerAndLogin,
};
