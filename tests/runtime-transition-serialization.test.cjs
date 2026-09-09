'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const GAME_OFFSETS = [2, 3, 6, 12];

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function close(server) {
  if (!server || !server.listening) return;
  server.close();
  await once(server, 'close');
}

async function reserveEphemeralPort() {
  const server = await listen(0);
  const port = server.address().port;
  await close(server);
  return port;
}

async function findGamePortBase() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    const held = [];
    try {
      for (const offset of GAME_OFFSETS) held.push(await listen(base + offset));
      await Promise.all(held.map(close));
      return base;
    } catch (_) {
      await Promise.all(held.map(close));
    }
  }
  throw new Error('could not find an unused local game-port range');
}

function requestJson(port, method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: body ? {
        'content-type': 'application/json',
        'content-length': body.length,
      } : {},
      timeout: 8000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        } catch (error) {
          reject(new Error(`invalid JSON response (${response.statusCode}): ${text.slice(0, 300)}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`request timed out: ${method} ${pathname}`)));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function waitUntil(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('condition did not become true before timeout');
}

async function portIsClosed(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = value => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    socket.setTimeout(500, () => finish(true));
  });
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (_) {}
}

test('concurrent launch requests preserve the one-active-game contract', { timeout: 30000 }, async t => {
  const hubPort = await reserveEphemeralPort();
  const gameBase = await findGamePortBase();
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      AXM_GAME_HUB_PORT: String(hubPort),
      AXM_GAME_PORT_BASE: String(gameBase),
      AXM_GAME_HUB_NO_OPEN: '1',
      AXM_GAME_HUB_LAN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(() => killProcessTree(child));

  await waitUntil(async () => {
    const response = await requestJson(hubPort, 'GET', '/api/health');
    return response.status === 200;
  });

  const [first, second] = await Promise.all([
    requestJson(hubPort, 'POST', '/api/launch', { gameId: '002-robo-pong' }),
    requestJson(hubPort, 'POST', '/api/launch', { gameId: '003-robo-pong-cross' }),
  ]);

  assert.equal(first.status, 200, `first concurrent launch failed: ${JSON.stringify(first.body)}`);
  assert.equal(second.status, 200, `second concurrent launch failed: ${JSON.stringify(second.body)}`);

  const status = await requestJson(hubPort, 'GET', '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.active.gameId, '003-robo-pong-cross');
  assert.equal(status.body.active.status, 'ready');

  await waitUntil(() => portIsClosed(gameBase + 2));
  assert.equal(await portIsClosed(gameBase + 2), true, 'superseded runtime is still listening');
  assert.equal(await portIsClosed(gameBase + 3), false, 'current runtime is not listening');

  const stopped = await requestJson(hubPort, 'POST', '/api/stop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.stopped.gameId, '003-robo-pong-cross');
  await waitUntil(() => portIsClosed(gameBase + 3));
});
