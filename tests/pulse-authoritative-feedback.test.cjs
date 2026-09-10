'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const feedback = require('../games/012-pulse-choir/runtime/pulse-feedback');
const core = require('../games/012-pulse-choir/runtime/game-core');

test('feedback buffer policy stays aligned with authoritative game core', () => {
  assert.equal(feedback.BUFFER_WINDOW_MS, core.METRICS.pulseBufferMs);
});

test('buffered action becomes a truthful server receipt without mutating packet state', () => {
  const packet = {
    ok: true,
    buffered: true,
    state: { phase: 'playing', players: { p1: { id: 'p1' } } }
  };
  const before = JSON.stringify(packet);
  const receipt = feedback.actionReceipt(packet, 'p1');
  assert.equal(receipt.kind, 'buffered');
  assert.equal(receipt.title, 'BUFFER ACCEPTED');
  assert.match(receipt.detail, /SERVER RECEIPT/);
  assert.match(receipt.detail, /0\.24S WINDOW/);
  assert.equal(JSON.stringify(packet), before);
});

test('active pulse receipt derives joined count from authoritative response state', () => {
  const packet = {
    ok: true,
    pulsed: true,
    state: {
      players: { p1: { id: 'p1' }, p2: { id: 'p2' }, p3: { id: 'p3' } },
      sync: { id: 'sync-7', pulses: [{ player: 'p2', at: 100 }, { player: 'p1', at: 120 }] }
    }
  };
  const receipt = feedback.actionReceipt(packet, 'p1');
  assert.equal(receipt.kind, 'locked');
  assert.equal(receipt.title, 'PULSE LOCKED');
  assert.match(receipt.detail, /2 \/ 3 JOINED/);
  assert.match(receipt.detail, /YOU ARE IN/);
});

test('observation receipt stays visible only while this exact seat is in the active sync', () => {
  const observation = {
    phase: 'playing',
    player: { id: 'p1', pulsedSyncId: 'sync-9' },
    teammates: [{ id: 'p2' }, { id: 'p3' }],
    sync: { id: 'sync-9', pulses: [{ player: 'p1', at: 100 }] }
  };
  assert.equal(feedback.observationReceipt(observation, 'p1').kind, 'locked');
  assert.equal(feedback.observationReceipt({ ...observation, sync: { id: 'sync-10', pulses: [] } }, 'p1'), null);
  assert.equal(feedback.observationReceipt({ ...observation, phase: 'results' }, 'p1'), null);
});

test('rejected and mismatched pulse paths fail closed as held receipts', () => {
  const rejected = feedback.actionReceipt({ ok: false, reason: 'already-pulsed' }, 'p1');
  assert.equal(rejected.kind, 'held');
  assert.match(rejected.detail, /ALREADY LOCKED/);

  const mismatch = feedback.actionReceipt({
    ok: true,
    pulsed: true,
    state: {
      players: { p1: { id: 'p1' }, p2: { id: 'p2' } },
      sync: { id: 'sync-11', pulses: [{ player: 'p2', at: 100 }] }
    }
  }, 'p1');
  assert.equal(mismatch.kind, 'held');
  assert.match(mismatch.detail, /NOT ADMITTED/);
});
