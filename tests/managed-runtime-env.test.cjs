'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { POLICY, buildManagedRuntimeEnv } = require('../lib/managed-runtime-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const HUB_PORT = 18890;
const GAME_PORT_BASE = 18900;
const MANAGED = Object.freeze({
  PORT: '19002',
  HOST: '127.0.0.1',
  AXM_FOREST_HOST: '127.0.0.1',
  AXM_ROBO_PONG_HOST: '127.0.0.1',
  AXM_PLAYERS_JSON: '[]',
  AXM_MANAGED_BY_GAME_HUB: '1',
  AXM_GAME_ID: 'fixture-game',
  AXM_GAME_HUB_CALLBACK_URL: 'http://127.0.0.1:18890',
});

function request(method, requestPath, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: requestPath,
      method,
      timeout: 1200,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': payload.length,
      } : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, text, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHub(child) {
  let last = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Hub exited early with ${child.exitCode}`);
    try {
      const response = await request('GET', '/api/health');
      if (response.status === 200) return response.body;
      last = new Error(`health returned ${response.status}`);
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw last || new Error('Hub did not become ready');
}

function parseProcEnvironment(pid) {
  const bytes = fs.readFileSync(`/proc/${pid}/environ`);
  const env = Object.create(null);
  for (const entry of bytes.toString('utf8').split('\0')) {
    if (!entry) continue;
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return env;
}

async function waitForManagedChild(hubPid) {
  const childrenFile = `/proc/${hubPid}/task/${hubPid}/children`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const text = fs.readFileSync(childrenFile, 'utf8').trim();
    const pids = text ? text.split(/\s+/).map(Number).filter(Number.isSafeInteger) : [];
    for (const pid of pids) {
      try {
        const env = parseProcEnvironment(pid);
        if (env.AXM_MANAGED_BY_GAME_HUB === '1') return { pid, env };
      } catch (_) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('managed child process was not observable under /proc');
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('managed runtime environment copies only bounded compatibility state and exact Hub controls', () => {
  const env = buildManagedRuntimeEnv({
    PATH: '/safe/path',
    HOME: '/home/example',
    LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'secret',
    GITHUB_TOKEN: 'secret',
    NODE_OPTIONS: '--require ./unexpected.js',
    HTTP_PROXY: 'http://proxy.invalid',
    AXM_GAME_ID: 'parent-must-not-win',
  }, MANAGED);

  assert.equal(env.PATH, '/safe/path');
  assert.equal(env.HOME, '/home/example');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.AXM_GAME_ID, 'fixture-game');
  assert.equal(env.AXM_MANAGED_RUNTIME_ENV_POLICY, POLICY);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(Object.isFrozen(env), true);
});

test('managed runtime environment rejects undeclared control widening', () => {
  assert.throws(
    () => buildManagedRuntimeEnv({}, { ...MANAGED, UNREVIEWED_CHILD_AUTHORITY: '1' }),
    /unsupported managed runtime environment key/,
  );
  const incomplete = { ...MANAGED };
  delete incomplete.AXM_GAME_ID;
  assert.throws(() => buildManagedRuntimeEnv({}, incomplete), /missing managed runtime environment key: AXM_GAME_ID/);
});

test('Hub does not leak unrelated parent environment into a managed game', { skip: process.platform !== 'linux' }, async () => {
  const inheritedPath = process.env.PATH || '';
  const hub = childProcess.spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      AXM_GAME_HUB_PORT: String(HUB_PORT),
      AXM_GAME_PORT_BASE: String(GAME_PORT_BASE),
      AXM_GAME_HUB_NO_OPEN: '1',
      AXM_ENV_SECRET_SENTINEL: 'should-never-cross-runtime-boundary',
      GITHUB_TOKEN: 'sentinel-github-token',
      OPENAI_API_KEY: 'sentinel-openai-key',
      AWS_SECRET_ACCESS_KEY: 'sentinel-aws-secret',
      SSH_AUTH_SOCK: '/tmp/sentinel-agent.sock',
      NODE_OPTIONS: '--no-warnings',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  hub.stdout.on('data', (chunk) => { logs += chunk; });
  hub.stderr.on('data', (chunk) => { logs += chunk; });

  try {
    await waitForHub(hub);
    const launched = await request('POST', '/api/launch', { gameId: '002-robo-pong' });
    assert.equal(launched.status, 200, `launch failed: ${launched.text}\n${logs}`);
    assert.equal(launched.body && launched.body.active && launched.body.active.gameId, '002-robo-pong');

    const observed = await waitForManagedChild(hub.pid);
    assert.equal(observed.env.AXM_MANAGED_BY_GAME_HUB, '1');
    assert.equal(observed.env.AXM_GAME_ID, '002-robo-pong');
    assert.equal(observed.env.HOST, '127.0.0.1');
    assert.equal(observed.env.AXM_ROBO_PONG_HOST, '127.0.0.1');
    assert.equal(observed.env.AXM_MANAGED_RUNTIME_ENV_POLICY, POLICY);
    if (inheritedPath) assert.equal(observed.env.PATH, inheritedPath);

    for (const forbidden of [
      'AXM_ENV_SECRET_SENTINEL',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'SSH_AUTH_SOCK',
      'NODE_OPTIONS',
    ]) {
      assert.equal(observed.env[forbidden], undefined, `${forbidden} crossed into managed child ${observed.pid}`);
    }
  } finally {
    try { await request('POST', '/api/stop'); } catch (_) {}
    await terminate(hub);
  }
});
