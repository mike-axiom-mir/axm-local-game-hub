'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'games', '002-robo-pong', 'runtime', 'neon-pong-duet-client.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/<script id="duet-serve-feedback">([\s\S]*?)<\/script>/);
assert.ok(match, 'serve feedback script must remain embedded in the real Duet client');
const script = match[1];

function node(initialHidden = true) {
  return {
    hidden: initialHidden,
    textContent: '',
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); }
    }
  };
}

async function harness(player) {
  const nodes = {
    serveCue: node(true),
    serveCountdown: node(false),
    controllerServeStatus: node(true)
  };
  const requests = [];
  let source = null;

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      source = this;
    }
  }

  const context = {
    URLSearchParams,
    location: { search: player === 'screen' ? '' : '?player=' + player, pathname: '/' },
    document: { getElementById(id) { return nodes[id]; } },
    EventSource: FakeEventSource,
    fetch(url, options) {
      requests.push({ url, options: options || null });
      return Promise.resolve({ json: () => Promise.resolve({ phase: 'ready', serveIn: 0 }) });
    }
  };
  vm.runInNewContext(script, context, { filename: 'duet-serve-feedback.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, requests, source };
}

function emit(h, state) {
  assert.ok(h.source && typeof h.source.onmessage === 'function', 'SSE consumer must be attached');
  h.source.onmessage({ data: JSON.stringify(state) });
}

test('shared screen exposes only authoritative running serve countdown', async () => {
  const h = await harness('screen');
  assert.equal(h.source.url, '/events?room=AXM1');
  assert.deepEqual(h.requests.map(item => item.url), ['/state?room=AXM1']);
  assert.ok(h.requests.every(item => !item.options || !item.options.method), 'observer must not mutate runtime state');

  emit(h, { phase: 'running', serveIn: 950 });
  assert.equal(h.nodes.serveCue.hidden, false);
  assert.equal(h.nodes.serveCountdown.textContent, '1.0');
  assert.equal(h.nodes.serveCue.style.values.get('--serve-progress'), 0.95);
  assert.equal(h.nodes.controllerServeStatus.hidden, true, 'shared screen must not invent a phone-controller cue');

  emit(h, { phase: 'paused', serveIn: 700 });
  assert.equal(h.nodes.serveCue.hidden, true, 'paused state must suppress stale countdown presentation');
});

test('phone seat gets the same server-derived readiness without changing authority', async () => {
  const h = await harness('p1');
  emit(h, { phase: 'running', serveIn: 280 });
  assert.equal(h.nodes.serveCue.hidden, false);
  assert.equal(h.nodes.serveCountdown.textContent, '0.3');
  assert.equal(h.nodes.controllerServeStatus.hidden, false);
  assert.equal(h.nodes.controllerServeStatus.textContent, 'LIGHT IN 0.3s · PREPARE');

  emit(h, { phase: 'running', serveIn: 0 });
  assert.equal(h.nodes.serveCue.hidden, true);
  assert.equal(h.nodes.controllerServeStatus.hidden, true);
  assert.equal(h.nodes.serveCue.style.values.get('--serve-progress'), 0);
});

test('malformed or missing serve timing fails closed as no countdown', async () => {
  const h = await harness('p2');
  emit(h, { phase: 'running', serveIn: 'not-a-number' });
  assert.equal(h.nodes.serveCue.hidden, true);
  assert.equal(h.nodes.controllerServeStatus.hidden, true);
  emit(h, { phase: 'ready', serveIn: 900 });
  assert.equal(h.nodes.serveCue.hidden, true);
});
