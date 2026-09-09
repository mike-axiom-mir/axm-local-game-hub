'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'games/003-robo-pong-cross/runtime/neon-pong-cross-client.html'), 'utf8');
const match = html.match(/<script id="crossRelayCoachScript">\s*([\s\S]*?)\s*<\/script>/);
assert.ok(match, 'Cross page must contain the bounded inline relay coach');
const moduleBox = { exports: {} };
vm.runInNewContext(match[1], { module: moduleBox, URLSearchParams, setTimeout, clearTimeout }, { filename: 'crossRelayCoachScript' });
const coach = moduleBox.exports;

function baseState() {
  return {
    phase: 'running',
    playMode: 'coop',
    players: {
      p1: { participant: true, team: 'relay', side: 'bottom', name: 'Axiom', color: '#46d7e7' },
      p2: { participant: true, team: 'relay', side: 'top', name: 'Mir', color: '#ff3dd8' },
      p3: { participant: true, team: 'relay', side: 'left', name: 'Nova', color: '#69dc9a' },
      p4: { participant: true, team: 'warden', side: 'right', name: 'Warden', color: '#f2877f' }
    },
    mission: { relayChain: [], relayArmed: false }
  };
}

test('three-seat co-op excludes the host Warden and shows all relay seats as opening options', () => {
  const view = coach.derive(baseState(), 'screen');
  assert.equal(view.visible, true);
  assert.equal(view.required, 3);
  assert.deepEqual(Array.from(view.teamIds), ['p1', 'p2', 'p3']);
  assert.deepEqual(Array.from(view.eligible), ['p1', 'p2', 'p3']);
  assert.match(view.action, /FIRST TOUCH/);
  assert.equal(view.sides.some((entry) => entry.id === 'p4'), false);
});

test('after one touch, the hitter is told to pass while a new teammate is told their touch advances relay', () => {
  const state = baseState();
  state.mission.relayChain = ['p1'];
  const hitter = coach.derive(state, 'p1');
  const next = coach.derive(state, 'p2');
  assert.deepEqual(Array.from(hitter.eligible), ['p2', 'p3']);
  assert.equal(hitter.controllerAction, 'PASS TO · MIR / NOVA');
  assert.equal(next.controllerAction, 'YOUR TOUCH ADVANCES RELAY · 1/3');
});

test('armed state stops advertising next-touch seats and tells players to strike the Warden', () => {
  const state = baseState();
  state.mission.relayChain = ['p1', 'p2', 'p3'];
  state.mission.relayArmed = true;
  const view = coach.derive(state, 'p3');
  assert.equal(view.armed, true);
  assert.deepEqual(Array.from(view.eligible), []);
  assert.match(view.action, /STRIKE THE WARDEN/);
  assert.match(view.controllerAction, /DRIVE THE LIGHT INTO THE WARDEN/);
});

test('four-player co-op preserves the server contract of three distinct relay touches', () => {
  const state = baseState();
  state.players.p4 = { participant: true, team: 'relay', side: 'right', name: 'Sol', color: '#f0bd63' };
  state.mission.relayChain = ['p1', 'p2'];
  const view = coach.derive(state, 'screen');
  assert.equal(view.required, 3);
  assert.deepEqual(Array.from(view.eligible), ['p3', 'p4']);
  assert.equal(view.action, 'NEXT TOUCH · ANY NEW TEAMMATE');
});

test('versus mode never invents relay guidance', () => {
  const state = baseState();
  state.playMode = 'versus';
  assert.equal(coach.derive(state, 'p1').visible, false);
});

test('relay realization stays inline so the existing server needs no new static-file authority', () => {
  assert.match(html, /id="crossRelayCoachStyle"/);
  assert.match(html, /id="crossRelayCoachScript"/);
  assert.ok(html.indexOf('crossRelayCoachScript') < html.indexOf('neon-pong-cross.js'));
  assert.doesNotMatch(html, /src="cross-relay-coach\.js"/);
});
