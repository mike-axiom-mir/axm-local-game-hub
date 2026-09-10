'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'games', '002-robo-pong', 'runtime', 'neon-pong-duet-client.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/<script id="duet-serve-feedback">([\s\S]*?)<\/script>/);
assert.ok(match, 'Duet observer script must remain embedded in the real client');
const script = match[1];

function node(initialHidden = true) {
  const classes = new Set();
  return {
    hidden: initialHidden,
    textContent: '',
    offsetWidth: 20,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    style: {
      values: new Map(),
      left: '',
      top: '',
      setProperty(name, value) { this.values.set(name, value); }
    }
  };
}

async function harness(player = 'screen', now = 10000) {
  const nodes = {
    serveCue: node(true),
    serveCountdown: node(false),
    controllerServeStatus: node(true),
    returnImpact: node(false),
    returnImpactLabel: node(false),
    controllerReturnStatus: node(true)
  };
  const requests = [];
  let source = null;
  class FakeEventSource {
    constructor(url) { this.url = url; this.onmessage = null; source = this; }
  }
  class FakeDate extends Date { static now() { return now; } }
  const context = {
    URLSearchParams,
    Date: FakeDate,
    location: { search: player === 'screen' ? '' : '?player=' + player, pathname: '/' },
    document: { getElementById(id) { return nodes[id] || null; } },
    EventSource: FakeEventSource,
    setTimeout() { return 1; },
    clearTimeout() {},
    fetch(url, options) {
      requests.push({ url, options: options || null });
      return Promise.resolve({ json: () => Promise.resolve({ phase: 'ready', serveIn: 0 }) });
    }
  };
  vm.runInNewContext(script, context, { filename: 'duet-observer.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, requests, source };
}

function emit(h, state) {
  assert.ok(h.source && typeof h.source.onmessage === 'function');
  h.source.onmessage({ data: JSON.stringify(state) });
}

function returnState(overrides = {}) {
  return {
    phase: 'running',
    serveIn: 0,
    width: 1200,
    height: 800,
    event: 'MIKE RETURN',
    eventAt: 10000,
    ball: { lastTouch: 'p1' },
    paddles: { p1: { x: 300, y: 730 }, p2: { x: 900, y: 70 } },
    players: {
      p1: { name: 'Mike', color: '#46d7e7' },
      p2: { name: 'Nova', color: '#ff3dd8' }
    },
    ...overrides
  };
}

test('authoritative player return becomes a localized shared-screen impact without mutation', async () => {
  const h = await harness('screen');
  assert.equal(h.source.url, '/events?room=AXM1');
  assert.deepEqual(h.requests.map(item => item.url), ['/state?room=AXM1']);
  assert.ok(h.requests.every(item => !item.options || !item.options.method));

  emit(h, returnState());
  assert.equal(h.nodes.returnImpact.classList.contains('show'), true);
  assert.equal(h.nodes.returnImpact.style.left, '25%');
  assert.equal(h.nodes.returnImpact.style.top, '91.25%');
  assert.equal(h.nodes.returnImpact.style.values.get('--impact-color'), '#46d7e7');
  assert.equal(h.nodes.returnImpactLabel.textContent, 'MIKE · RETURN');
  assert.equal(h.nodes.controllerReturnStatus.hidden, true, 'spectator must not receive a seat-owned receipt');
});

test('phone receipt follows the exact returning seat and relay return semantics', async () => {
  const h = await harness('p1');
  emit(h, returnState({ event: 'MIKE · RELAY 4/12' }));
  assert.equal(h.nodes.returnImpactLabel.textContent, 'MIKE · RELAY TOUCH');
  assert.equal(h.nodes.controllerReturnStatus.hidden, false);
  assert.equal(h.nodes.controllerReturnStatus.textContent, 'YOUR RELAY TOUCH CONFIRMED');

  emit(h, returnState({ event: 'NOVA RETURN', eventAt: 10001, ball: { lastTouch: 'p2' } }));
  assert.equal(h.nodes.controllerReturnStatus.hidden, true, 'P1 must not claim P2 return feedback');
  assert.equal(h.nodes.returnImpactLabel.textContent, 'NOVA · RETURN');
});

test('stale, non-return, and malformed states do not invent impact', async () => {
  const stale = await harness('p2', 13000);
  emit(stale, returnState());
  assert.equal(stale.nodes.returnImpact.classList.contains('show'), false, 'old event must not replay as a fresh hit');
  assert.equal(stale.nodes.controllerReturnStatus.hidden, true);

  const score = await harness('p1');
  emit(score, returnState({ event: 'MIKE +1' }));
  assert.equal(score.nodes.returnImpact.classList.contains('show'), false, 'score text is not a paddle return receipt');

  const malformed = await harness('p1');
  emit(malformed, returnState({ width: 0 }));
  assert.equal(malformed.nodes.returnImpact.classList.contains('show'), false, 'invalid geometry must fail closed');
});