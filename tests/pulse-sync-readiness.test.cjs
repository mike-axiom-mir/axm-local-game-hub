'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../games/012-pulse-choir/runtime/game-core.js');
const readiness = require('../games/012-pulse-choir/runtime/sync-readiness.js');

test('projects the real 1.9 second authoritative sync window without changing it', () => {
  const roster = core.normalizeRoster([]);
  const state = core.createInitialState(roster, { seed: 12026, now: 1000 });
  state.core.charge = 100;
  state.clockMs = 1000;
  assert.equal(core.openSync(state, 1000), true);
  assert.equal(state.sync.endsAt - state.sync.openedAt, core.METRICS.syncWindowMs);
  const before = JSON.stringify(state.sync);
  const model = readiness.deriveSyncReadiness(state);
  assert.equal(model.active, true);
  assert.equal(model.totalMs, 1900);
  assert.equal(model.remainingMs, 1900);
  assert.equal(model.totalCount, Object.keys(state.players).length);
  assert.equal(model.readyCount, 0);
  assert.equal(JSON.stringify(state.sync), before, 'projection must not mutate authoritative sync state');
});

test('reports exact ready and waiting seats from the authoritative pulse receipt list', () => {
  const state = {
    clockMs: 1500,
    sync: { openedAt: 1000, endsAt: 2900, pulses: [{ player: 'p2', at: 1300 }] },
    players: {
      p2: { id: 'p2', name: 'Mir' },
      p1: { id: 'p1', name: 'Axiom' },
      p3: { id: 'p3', name: 'Wildcard' }
    }
  };
  const model = readiness.deriveSyncReadiness(state);
  assert.equal(model.remainingMs, 1400);
  assert.equal(model.readyCount, 1);
  assert.equal(model.totalCount, 3);
  assert.deepEqual(model.players.map(player => [player.id, player.ready]), [['p1', false], ['p2', true], ['p3', false]]);
  assert.equal(model.complete, false);
  assert.equal(model.urgent, false);
});

test('makes the final 700ms visibly urgent until every seat is ready', () => {
  const base = {
    clockMs: 2250,
    sync: { openedAt: 1000, endsAt: 2900, pulses: [{ player: 'p1' }] },
    players: { p1: { id: 'p1', name: 'Axiom' }, p2: { id: 'p2', name: 'Mir' } }
  };
  const waiting = readiness.deriveSyncReadiness(base);
  assert.equal(waiting.remainingMs, 650);
  assert.equal(waiting.urgent, true);
  const complete = readiness.deriveSyncReadiness({ ...base, sync: { ...base.sync, pulses: [{ player: 'p1' }, { player: 'p2' }] } });
  assert.equal(complete.complete, true);
  assert.equal(complete.urgent, false);
  assert.equal(complete.readyCount, 2);
});

test('holds malformed or expired timing instead of inventing a countdown', () => {
  assert.equal(readiness.deriveSyncReadiness({ sync: { openedAt: 1, endsAt: 'later' }, players: {} }).active, false);
  const expired = readiness.deriveSyncReadiness({ clockMs: 3000, sync: { openedAt: 1000, endsAt: 2900, pulses: [] }, players: {} });
  assert.equal(expired.active, false);
  assert.equal(expired.remainingMs, 0);
  assert.equal(readiness.secondsLabel(650), '0.7s LEFT');
});
