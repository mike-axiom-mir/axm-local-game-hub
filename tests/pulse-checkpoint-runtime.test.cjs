'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const core = require('../games/012-pulse-choir/runtime/game-core');
const checkpoints = require('../games/012-pulse-choir/runtime/checkpoint-store');
const { createRuntime } = require('../games/012-pulse-choir/runtime/server');

function request(port, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axm-pulse-runtime-'));
  const filePath = path.join(directory, 'show.json');
  const rejectedBytes = Buffer.from('{rejected-runtime-state');
  fs.writeFileSync(filePath, rejectedBytes);
  const roster = core.normalizeRoster([]);
  let now = 50_000;
  const runtime = createRuntime({
    clock: () => now,
    env: { AXM_GAME_SESSION_ID: 'runtime-test' },
    manualTick: true,
    roster,
    checkpoint: { filePath, saveIntervalMs: 1, ttlMs: 60_000 }
  });

  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen(0, '127.0.0.1', resolve);
  });

  try {
    assert.ok(fs.readFileSync(filePath).equals(rejectedBytes), 'listen autosave must preserve held bytes');
    const port = runtime.server.address().port;
    const health = await request(port, 'GET', '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.recovery.status, 'held-corrupt');
    assert.strictEqual(health.body.recovery.writesBlocked, true);
    assert.ok(!JSON.stringify(health.body).includes(directory), 'LAN-visible state must not expose host paths');

    now += 100;
    const fresh = await request(port, 'POST', '/api/new-show');
    assert.strictEqual(fresh.status, 200);
    assert.strictEqual(fresh.body.recovery.status, 'saved');
    assert.strictEqual(fresh.body.recovery.writesBlocked, false);
    assert.ok(fresh.body.recovery.quarantineRef.startsWith('show.json.rejected-'));

    const quarantinePath = path.join(directory, fresh.body.recovery.quarantineRef);
    assert.ok(fs.readFileSync(quarantinePath).equals(rejectedBytes), 'new-show preserves exact rejected bytes');
    const installed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(installed.schema, checkpoints.CHECKPOINT_SCHEMA);
    assert.ok(/^[a-f0-9]{64}$/.test(installed.checkpointDigest));
    process.stdout.write('pulse checkpoint runtime passed: 11 assertions\n');
  } finally {
    await new Promise(resolve => runtime.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
