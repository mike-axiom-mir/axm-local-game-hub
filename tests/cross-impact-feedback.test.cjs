'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'games/003-robo-pong-cross/runtime/neon-pong-cross-client.html'), 'utf8');
const match = html.match(/<script id="crossRelayCoachScript">\s*([\s\S]*?)\s*<\/script>/);
assert.ok(match, 'Cross page must contain the bounded relay/impact observer');
const moduleBox = { exports: {} };
vm.runInNewContext(match[1], { module: moduleBox, URLSearchParams, setTimeout, clearTimeout }, { filename: 'crossRelayCoachScript' });
const observer = moduleBox.exports;

function state(overrides) {
  const base = {
    arenaId: 'relay-protocol',
    phase: 'running',
    playMode: 'coop',
    mission: {
      boss: 12,
      bossMax: 12,
      core: 6,
      coreMax: 6,
      relayChain: ['p1', 'p2', 'p3'],
      relayArmed: true
    }
  };
  if (!overrides) return base;
  const next = Object.assign({}, base, overrides);
  next.mission = Object.assign({}, base.mission, overrides.mission || {});
  return next;
}

test('authoritative Warden loss becomes a bounded success impact with exact remaining truth', () => {
  const before = state();
  const after = state({ mission: { boss: 11, relayChain: [], relayArmed: false } });
  const beforeReceipt = JSON.stringify(before);
  const afterReceipt = JSON.stringify(after);
  const view = observer.deriveImpact(before, after);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), {
    visible: true,
    kind: 'warden',
    amount: 1,
    remaining: 11,
    max: 12,
    label: 'WARDEN HIT · -1',
    detail: '11 / 12 WARDEN · RELAY RESET'
  });
  assert.equal(JSON.stringify(before), beforeReceipt, 'projection must not mutate prior canonical state');
  assert.equal(JSON.stringify(after), afterReceipt, 'projection must not mutate next canonical state');
});

test('two-point Warden consequence preserves the exact server delta rather than assuming one damage', () => {
  const view = observer.deriveImpact(state(), state({ mission: { boss: 10, relayChain: [], relayArmed: false } }));
  assert.equal(view.kind, 'warden');
  assert.equal(view.amount, 2);
  assert.equal(view.remaining, 10);
});

test('core loss becomes a distinct danger impact and preserves the exact core count', () => {
  const before = state({ mission: { relayChain: ['p1'], relayArmed: false } });
  const after = state({ mission: { core: 5, relayChain: [], relayArmed: false } });
  const view = observer.deriveImpact(before, after);
  assert.equal(view.visible, true);
  assert.equal(view.kind, 'core');
  assert.equal(view.label, 'CORE HIT · -1');
  assert.equal(view.detail, '5 / 6 CORE · RELAY RESET');
});

test('final canonical blows remain visible through gameover', () => {
  const warden = observer.deriveImpact(state({ mission: { boss: 1 } }), state({ phase: 'gameover', mission: { boss: 0, relayChain: [], relayArmed: false } }));
  const core = observer.deriveImpact(state({ mission: { core: 1 } }), state({ phase: 'gameover', mission: { core: 0, relayChain: [], relayArmed: false } }));
  assert.equal(warden.label, 'WARDEN HIT · -1');
  assert.equal(warden.remaining, 0);
  assert.equal(core.label, 'CORE HIT · -1');
  assert.equal(core.remaining, 0);
});

test('resets, arena changes, unchanged state, versus, and malformed counters invent no impact', () => {
  assert.equal(observer.deriveImpact(state(), state({ phase: 'ready', mission: { boss: 8 } })).visible, false, 'ready/reset state must not look like damage');
  assert.equal(observer.deriveImpact(state(), state({ arenaId: 'cathedral-cross', mission: { boss: 8 } })).visible, false, 'arena swap must not look like damage');
  assert.equal(observer.deriveImpact(state(), state()).visible, false, 'unchanged state must stay quiet');
  assert.equal(observer.deriveImpact(state(), state({ playMode: 'versus', mission: { boss: 11 } })).visible, false, 'versus must not get co-op consequence feedback');
  assert.equal(observer.deriveImpact(state(), state({ mission: { boss: 'bad' } })).visible, false, 'malformed counters must fail closed');
});

test('impact feedback reuses the prerequisite observer state stream instead of adding a second feed', () => {
  const observerSource = match[1];
  assert.equal((observerSource.match(/new root\.EventSource/g) || []).length, 1);
  assert.match(observerSource, /var previous = lastState; lastState = state;/);
  assert.doesNotMatch(html, /src="cross-impact-feedback\.js"/);
});
