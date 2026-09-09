'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../runtime/lumenwake-core.cjs');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'runtime', 'lumenwake-client.html');

function runningGame(now = 10_000) {
  const game = Core.create([
    { display_name: 'Carrier', type: 'human' },
    { display_name: 'Cover', type: 'human' }
  ], now - 7_000, { seed: 42 });
  game.phase = 'running';
  game.startedAt = now - 1_000;
  game.endsAt = now + 60_000;
  game.nextShardAt = Number.POSITIVE_INFINITY;
  game.nextEnemyAt = Number.POSITIVE_INFINITY;
  game.shards = [];
  game.enemies = [{
    id: 'g-test', x: 70, y: 32, hp: 2, speed: 0,
    stunnedUntil: 0, hitAt: 0, targetId: 'core'
  }];
  return game;
}

test('Gloom exposes the exact authoritative carrier or core target', () => {
  const now = 10_000;
  const game = runningGame(now);
  game.players.p1.carried = ['cyan'];

  Core.step(game, {}, 0.016, now);
  assert.equal(game.enemies[0].targetId, 'p1');

  game.players.p1.carried = [];
  Core.step(game, {}, 0.016, now + 16);
  assert.equal(game.enemies[0].targetId, 'core');
});

test('authoritative state exposes accepted Pulse and Dash cooldowns', () => {
  const now = 20_000;
  const game = runningGame(now);
  game.enemies[0].x = game.players.p1.x + 4;
  game.enemies[0].y = game.players.p1.y;

  Core.step(game, {
    p1: { action: true, dash: true, updatedAt: now },
    p2: { updatedAt: now }
  }, 0.016, now);

  assert.equal(game.players.p1.pulseReadyAt, now + 1_650);
  assert.equal(game.players.p1.dashReadyAt, now + 3_400);
  assert.equal(game.players.p1.stats.pulses, 1);
});

test('browser surface compiles and keeps feedback subordinate to server state', () => {
  const html = fs.readFileSync(CLIENT, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'lumenwake-client.inline.js' }));
  assert.match(html, /TARGET LINES SHOW GLOOM INTENT/);
  assert.match(html, /mine\.pulseReadyAt/);
  assert.match(html, /mine\.dashReadyAt/);
  assert.match(html, /e\.targetId/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /prefers-reduced-motion:reduce/);
});
