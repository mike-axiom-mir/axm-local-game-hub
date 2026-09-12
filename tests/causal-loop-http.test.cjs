'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function request(port, method, pathname, value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? null : JSON.stringify(value);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForHub(port) {
  let last;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { return await request(port, 'GET', '/api/health'); }
    catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw last || new Error('Hub did not start');
}

test('real Hub API consumes and independently replays the configured provider receipt', { timeout: 20_000 }, async (t) => {
  const entry = process.env.AXM_CAUSAL_LOOP_ENTRY;
  if (!entry) return t.skip('set AXM_CAUSAL_LOOP_ENTRY to run the real cross-repository smoke test');
  const port = 31000 + Math.floor(Math.random() * 10000);
  const child = childProcess.spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, AXM_GAME_HUB_PORT: String(port), AXM_GAME_PORT_BASE: String(port + 100), AXM_GAME_HUB_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', (chunk) => { diagnostics += chunk; });
  child.stderr.on('data', (chunk) => { diagnostics += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
  });

  const health = await waitForHub(port);
  assert.equal(health.status, 200, diagnostics);
  assert.equal(health.body.games, 4);
  assert.equal(health.body.active, null);
  assert.equal(health.body.externalCapabilities[0].configured, true);
  assert.equal(health.body.externalCapabilities[0].capabilityId, 'axm.causal-loop.train-platform.process/v1');

  const discovered = await request(port, 'GET', '/api/capabilities/causal-loop');
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.status, 'PASS');
  assert.equal(discovered.body.capability.provider.repository, 'mike-axiom-mir/axm-casual-loop');

  const scenario = { timedInfluences: [{ atWave: 2, action: 'BLOCK_DOOR' }, { atWave: 3, action: 'TRIGGER_ALARM' }], maxWaves: 64 };
  const first = await request(port, 'POST', '/api/capabilities/causal-loop/run', scenario);
  const second = await request(port, 'POST', '/api/capabilities/causal-loop/run', scenario);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'PASS');
  assert.equal(first.body.verification.replayMatches, true);
  assert.equal(first.body.receiptHash, first.body.verification.verifiedReceiptHash);
  assert.equal(first.body.receiptHash, second.body.receiptHash);
  assert.equal(first.body.inputHash, second.body.inputHash);

  const status = await request(port, 'GET', '/api/status');
  assert.equal(status.body.active, null, 'the one-shot capability process must not consume the active game slot');
});

test('unconfigured Hub advertises an explicit hold without changing the game catalog', { timeout: 10_000 }, async (t) => {
  const port = 41000 + Math.floor(Math.random() * 8000);
  const env = { ...process.env, AXM_GAME_HUB_PORT: String(port), AXM_GAME_PORT_BASE: String(port + 100), AXM_GAME_HUB_NO_OPEN: '1' };
  delete env.AXM_CAUSAL_LOOP_ENTRY;
  const child = childProcess.spawn(process.execPath, ['server.cjs'], { cwd: ROOT, env, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
  });
  const health = await waitForHub(port);
  assert.equal(health.body.externalCapabilities[0].configured, false);
  const discovered = await request(port, 'GET', '/api/capabilities/causal-loop');
  assert.equal(discovered.body.status, 'HOLD');
  assert.equal(discovered.body.error.code, 'provider_not_configured');
  const catalog = await request(port, 'GET', '/api/catalog');
  assert.equal(catalog.body.games.length, 4);
});
