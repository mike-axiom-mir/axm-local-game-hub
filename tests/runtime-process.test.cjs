'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');

const { hasExited, terminateChild } = require('../lib/runtime-process.cjs');

function spawnFixture(source) {
  return spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
}

async function readyChild(source) {
  const child = spawnFixture(source);
  await once(child.stdout, 'data');
  return child;
}

async function ensureDead(child) {
  if (!hasExited(child)) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
  }
}

test('graceful runtime exit is observed before stop completes', async t => {
  const child = await readyChild(`
    process.on('SIGTERM', () => process.exit(0));
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `);
  t.after(() => ensureDead(child));

  const result = await terminateChild(child, { graceMs: 500, forceMs: 500 });

  assert.equal(result.exited, true);
  assert.equal(result.forced, false);
  assert.equal(child.exitCode, 0);
  assert.equal(hasExited(child), true);
});

test('stubborn runtime is force-killed and its exit is observed', async t => {
  const child = await readyChild(`
    process.on('SIGTERM', () => {});
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `);
  t.after(() => ensureDead(child));

  const result = await terminateChild(child, { graceMs: 100, forceMs: 1000 });

  assert.equal(result.exited, true);
  assert.equal(result.forced, true);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(hasExited(child), true);
});

test('an already-ended runtime remains a no-op', async () => {
  const child = spawnFixture(`process.exit(17);`);
  await once(child, 'exit');

  const result = await terminateChild(child, { graceMs: 10, forceMs: 10 });

  assert.equal(result.exited, true);
  assert.equal(result.forced, false);
  assert.equal(child.exitCode, 17);
});

test('stop fails closed when neither signal produces exit evidence', async () => {
  class UnstoppableFixture extends EventEmitter {
    constructor() {
      super();
      this.exitCode = null;
      this.signalCode = null;
      this.signals = [];
    }

    kill(signal) {
      this.signals.push(signal);
      return true;
    }
  }

  const child = new UnstoppableFixture();
  await assert.rejects(
    terminateChild(child, { graceMs: 5, forceMs: 5 }),
    /did not exit after SIGTERM .* and SIGKILL/,
  );
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(hasExited(child), false);
});
