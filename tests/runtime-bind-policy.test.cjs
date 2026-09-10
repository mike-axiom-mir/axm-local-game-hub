'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const AFFECTED_GAMES = new Set(['002-robo-pong', '003-robo-pong-cross', '006-lumenwake']);

function lanIpv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) return address.address;
    }
  }
  return null;
}

function request(hostname, port, requestPath, options) {
  const settings = options || {};
  const body = settings.body === undefined ? null : Buffer.from(JSON.stringify(settings.body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname,
      port,
      path: requestPath,
      method: settings.method || 'GET',
      timeout: settings.timeoutMs || 1200,
      headers: body ? {
        'content-type': 'application/json',
        'content-length': body.length,
      } : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function reachable(hostname, port, requestPath) {
  try {
    const response = await request(hostname, port, requestPath, { timeoutMs: 900 });
    return response.status >= 200 && response.status < 500;
  } catch (_) {
    return false;
  }
}

async function waitForHub(port, child, log) {
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Hub exited before readiness: ' + log.join(''));
    try {
      const response = await request('127.0.0.1', port, '/api/health', { timeoutMs: 500 });
      if (response.status === 200) return;
      lastError = new Error('Hub returned HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Hub did not become ready');
}

function startHub(lanMode, hubPort, gamePortBase) {
  const args = [path.join(ROOT, 'server.cjs')];
  if (lanMode) args.push('--lan');
  const child = childProcess.spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      AXM_GAME_HUB_PORT: String(hubPort),
      AXM_GAME_PORT_BASE: String(gamePortBase),
      AXM_GAME_HUB_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const log = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => log.push(String(chunk)));
  return { child, log };
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1800)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function exerciseMode(t, lanMode, seed) {
  const lanAddress = lanIpv4();
  assert.ok(lanAddress, 'real bind-policy evidence requires one non-loopback IPv4 interface');

  const hubPort = 20000 + seed;
  const gamePortBase = 22000 + seed;
  const { child, log } = startHub(lanMode, hubPort, gamePortBase);
  t.after(async () => stopProcess(child));
  await waitForHub(hubPort, child, log);

  const games = CATALOG.games.filter((game) => AFFECTED_GAMES.has(game.id));
  assert.equal(games.length, AFFECTED_GAMES.size, 'affected game set must stay explicit and complete');

  for (const game of games) {
    const launched = await request('127.0.0.1', hubPort, '/api/launch', {
      method: 'POST',
      body: { gameId: game.id },
      timeoutMs: 8000,
    });
    assert.equal(launched.status, 200, `${game.id} must launch through the real Hub: ${launched.body}`);

    const gamePort = gamePortBase + Number(game.portOffset || 0);
    assert.equal(await reachable('127.0.0.1', gamePort, game.readyPath), true,
      `${game.id} must remain reachable on loopback`);
    assert.equal(await reachable(lanAddress, gamePort, game.readyPath), lanMode,
      `${game.id} network reachability must match Hub LAN mode`);

    const stopped = await request('127.0.0.1', hubPort, '/api/stop', {
      method: 'POST',
      body: {},
      timeoutMs: 4000,
    });
    assert.equal(stopped.status, 200, `${game.id} must stop cleanly after bind-policy evidence`);
  }
}

test('default Hub mode keeps managed game runtimes loopback-only', async (t) => {
  await exerciseMode(t, false, 311 + (process.pid % 200));
});

test('explicit LAN mode makes the same managed runtimes reachable on the host LAN address', async (t) => {
  await exerciseMode(t, true, 711 + (process.pid % 200));
});
