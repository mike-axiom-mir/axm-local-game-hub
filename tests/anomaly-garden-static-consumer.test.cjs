'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  BridgeError,
  createStaticServer,
  listenLoopback,
  loadContract,
  verifyProviderRoot
} = require('../integrations/anomaly-garden-static/bridge.cjs');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function write(root, relativePath, content) {
  const full = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axm-anomaly-provider-'));
  write(root, 'package.json', JSON.stringify({ name: 'axm-anomaly-garden', version: '0.16.0', private: true }, null, 2));
  write(root, 'README.md', '# fixture\n');
  write(root, 'LICENSE', 'Apache-2.0 fixture\n');
  write(root, 'THIRD_PARTY.json', '{"schema":"fixture","entries":[]}\n');
  write(root, 'index.html', options.index || '<!doctype html><link rel="stylesheet" href="styles.css"><main id="world"></main><script src="app.js"></script>');
  write(root, 'styles.css', options.css || 'body{background:#000} .mark{background-image:url("dot.svg")}');
  write(root, 'dot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  write(root, 'app.js', 'document.querySelector("#world").textContent="ready";');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'AXM Fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return { root, revision: git(root, ['rev-parse', 'HEAD']) };
}

function testContract(revision) {
  const base = loadContract();
  return {
    ...base,
    provider: { ...base.provider, revision }
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof BridgeError && error.code === code, `expected ${code}`);
}

test('admits a clean exact provider checkout and derives the complete local runtime closure', () => {
  const { root, revision } = fixture();
  const admission = verifyProviderRoot(root, { contract: testContract(revision) });
  assert.equal(admission.provider.revision, revision);
  assert.equal(admission.provider.version, '0.16.0');
  assert.deepEqual(admission.runtime.files.map((item) => item.path), ['app.js', 'dot.svg', 'index.html', 'styles.css']);
  assert.equal(admission.runtime.fileCount, 4);
  assert.ok(admission.runtime.bytes > 0);
  assert.match(admission.runtime.closureSha256, /^[0-9a-f]{64}$/);
  assert.match(admission.receiptSha256, /^[0-9a-f]{64}$/);
  assert.equal(admission.authority.catalogMutation, false);
  assert.equal(admission.authority.canon, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('same clean checkout yields the same closure and receipt identity', () => {
  const { root, revision } = fixture();
  const contract = testContract(revision);
  const a = verifyProviderRoot(root, { contract });
  const b = verifyProviderRoot(root, { contract });
  assert.equal(a.runtime.closureSha256, b.runtime.closureSha256);
  assert.equal(a.receiptSha256, b.receiptSha256);
  fs.rmSync(root, { recursive: true, force: true });
});

test('refuses provider revision substitution', () => {
  const { root, revision } = fixture();
  const wrong = `${revision[0] === '0' ? '1' : '0'}${revision.slice(1)}`;
  expectCode(() => verifyProviderRoot(root, { contract: testContract(wrong) }), 'PROVIDER_REVISION_MISMATCH');
  fs.rmSync(root, { recursive: true, force: true });
});

test('refuses tracked runtime drift even when HEAD still names the expected commit', () => {
  const { root, revision } = fixture();
  fs.appendFileSync(path.join(root, 'app.js'), '\n// changed after commit\n');
  expectCode(() => verifyProviderRoot(root, { contract: testContract(revision) }), 'PROVIDER_TRACKED_DRIFT');
  fs.rmSync(root, { recursive: true, force: true });
});

test('refuses external runtime references rather than silently granting network authority', () => {
  const { root, revision } = fixture({ index: '<!doctype html><script src="https://example.invalid/runtime.js"></script>' });
  expectCode(() => verifyProviderRoot(root, { contract: testContract(revision) }), 'PROVIDER_EXTERNAL_REFERENCE');
  fs.rmSync(root, { recursive: true, force: true });
});

test('refuses symlinked runtime files', { skip: process.platform === 'win32' }, () => {
  const { root } = fixture();
  fs.unlinkSync(path.join(root, 'app.js'));
  fs.symlinkSync('dot.svg', path.join(root, 'app.js'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'replace runtime with symlink']);
  const revision = git(root, ['rev-parse', 'HEAD']);
  expectCode(() => verifyProviderRoot(root, { contract: testContract(revision) }), 'PROVIDER_FILE_TYPE');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loopback server exposes only admitted runtime bytes and fails closed on later drift', async () => {
  const { root, revision } = fixture();
  const admission = verifyProviderRoot(root, { contract: testContract(revision) });
  const server = createStaticServer(admission);
  const url = await listenLoopback(server, 0);
  try {
    const index = await fetch(url);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /id="world"/);

    const provenance = await fetch(new URL('README.md', url));
    assert.equal(provenance.status, 404);

    fs.appendFileSync(path.join(root, 'app.js'), '\n// post-admission drift\n');
    const drifted = await fetch(new URL('app.js', url));
    assert.equal(drifted.status, 409);
    assert.deepEqual(await drifted.json(), { ok: false, code: 'PROVIDER_RUNTIME_DRIFT' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
