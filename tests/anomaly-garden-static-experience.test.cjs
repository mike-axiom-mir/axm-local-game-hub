'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createDeskServer, renderDesk } = require('../integrations/anomaly-garden-static/experience.cjs');
const { listenLoopback } = require('../integrations/anomaly-garden-static/bridge.cjs');

function admission(overrides = {}) {
  return {
    schema: 'axm.local-game-hub.anomaly-garden-static-admission/v0.1',
    provider: {
      repository: 'mike-axiom-mir/axm-anomaly-garden',
      revision: 'e9af55a1d1494f3d4f639e16b3bb06279ae8c4ea',
      packageName: 'axm-anomaly-garden',
      version: '0.16.0',
      browserEntry: 'index.html'
    },
    runtime: {
      files: [],
      fileCount: 8,
      bytes: 123456,
      closureSha256: 'a'.repeat(64),
      host: '127.0.0.1',
      externalNetworkAllowed: false
    },
    provenance: [],
    authority: {
      catalogMutation: false,
      providerDiscovery: false,
      providerDownload: false,
      providerInstall: false,
      providerMutation: false,
      merge: false,
      canon: false
    },
    receiptSha256: 'b'.repeat(64),
    providerRoot: '/not/exposed',
    admittedPaths: new Set(['index.html']),
    ...overrides
  };
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('desk exposes admitted identity and keeps launch explicitly human-owned', () => {
  const html = renderDesk(admission(), 'http://127.0.0.1:4444/');
  assert.match(html, /Verified\. Still yours to open\./);
  assert.match(html, /Open verified Anomaly Garden/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:4444\/"/);
  assert.match(html, /NOT IN CATALOG/);
  assert.match(html, /NO AUTO-INSTALL/);
  assert.match(html, /NOT CANON/);
  assert.match(html, /e9af55a1d1494f3d4f639e16b3bb06279ae8c4ea/);
  assert.match(html, new RegExp('a'.repeat(64)));
  assert.match(html, new RegExp('b'.repeat(64)));
  assert.doesNotMatch(html, /\/not\/exposed/);
  assert.doesNotMatch(html, /<script/i);
});

test('desk escapes displayed provider fields rather than creating markup', () => {
  const sample = admission();
  sample.provider = { ...sample.provider, packageName: '<img src=x onerror=alert(1)>' };
  const html = renderDesk(sample, 'http://127.0.0.1:4444/?x=<unsafe>');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:4444\/\?x=&lt;unsafe&gt;"/);
});

test('desk is loopback-read-only presentation with explicit browser policy', async () => {
  const server = createDeskServer(admission(), 'http://127.0.0.1:4555/');
  const url = await listenLoopback(server, 0);
  try {
    const get = await request(url);
    assert.equal(get.status, 200);
    assert.match(get.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(get.headers['cache-control'], 'no-store');
    assert.match(get.body, /Open verified Anomaly Garden/);

    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');

    const post = await request(url, { method: 'POST' });
    assert.equal(post.status, 405);

    const unknown = await request(`${url}unknown`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
