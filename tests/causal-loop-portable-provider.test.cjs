'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ENGINE_SIGNATURE } = require('../lib/causal-loop-provider.cjs');
const {
  CLOSED_AUTHORITY,
  PORTABLE_PROVIDER_HEAD,
  admitPortableArtifact,
  consumePortableScenario,
} = require('../integrations/causal-loop-portable/consumer.cjs');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function providerSource() {
  return `'use strict';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const authority = { commitsHistory: false, writesCanonicalState: false, merges: false, declaresCanon: false };
  const base = { schema: 'axm.causal-loop.process-response/v1', requestId: request.requestId, status: 'PASS', capabilityId: 'axm.causal-loop.train-platform.process/v1', authority };
  if (request.op === 'describe') base.capability = {
    schema: 'axm.capability/v1', capabilityId: 'axm.causal-loop.train-platform.process/v1',
    provider: { repository: 'mike-axiom-mir/axm-casual-loop', module: 'fixture', entrypoint: 'fixture', licenseFile: 'LICENSE' },
    protocol: { transport: 'ndjson-stdio', requestSchema: 'axm.causal-loop.process-request/v1', responseSchema: 'axm.causal-loop.process-response/v1', operations: ['describe', 'run', 'verify'] },
    engine: { loopId: 'axm.train-platform-loop/v0.01', loopVersion: '0.08', receiptSchema: 'axm.causal-loop.run-receipt/v0.08', engineSignature: '${ENGINE_SIGNATURE}', allowedActions: ['WAIT', 'BLOCK_DOOR', 'TRIGGER_ALARM', 'TALK_TO_PASSENGER'], maxTimedInfluences: 64, maxWavesLimit: 256 },
    properties: { deterministic: true, headless: true, offline: true, thirdPartyDependencies: false }, authority,
  };
  if (request.op === 'run') Object.assign(base, { inputHash: 'b'.repeat(64), receiptHash: 'a'.repeat(64), executionMaxWaves: request.maxWaves, executionStatus: 'converged', replayMatches: true, receipt: { fixture: true } });
  if (request.op === 'verify') Object.assign(base, { verifiedReceiptHash: 'a'.repeat(64), replayedReceiptHash: 'a'.repeat(64), executionMaxWaves: request.maxWaves, executionStatus: 'converged', replayMatches: true });
  process.stdout.write(JSON.stringify(base) + '\\n');
});
`;
}

async function portableFixture(t, bytes = Buffer.from(providerSource(), 'utf8')) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axm-hub-portable-test-'));
  const artifactPath = path.join(root, 'provider.pyz');
  await fs.writeFile(artifactPath, bytes);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { artifactPath, expectedSha256: digest(bytes), bytes };
}

test('admits caller-pinned regular pyz bytes into a private staged copy', async (t) => {
  const fixture = await portableFixture(t, Buffer.from('portable-provider-bytes'));
  const admission = await admitPortableArtifact({
    ...fixture,
    python: process.execPath,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, AXM_PRIVATE_TEST_SECRET: 'must-not-cross' },
  });
  t.after(admission.cleanup);

  assert.equal(admission.digest, fixture.expectedSha256);
  assert.equal(admission.bytes, fixture.bytes.length);
  assert.equal(admission.providerHead, PORTABLE_PROVIDER_HEAD);
  assert.equal(path.extname(admission.config.entry), '.pyz');
  assert.equal(path.dirname(admission.config.entry).startsWith(os.tmpdir()), true);
  assert.equal(digest(await fs.readFile(admission.config.entry)), fixture.expectedSha256);
  assert.equal(admission.config.env.AXM_PRIVATE_TEST_SECRET, undefined);
  assert.equal(admission.config.env.PYTHONUNBUFFERED, '1');
});

test('refuses portable bytes that do not match the caller pin', async (t) => {
  const fixture = await portableFixture(t, Buffer.from('wrong-digest-provider'));
  await assert.rejects(
    () => admitPortableArtifact({ ...fixture, expectedSha256: '0'.repeat(64), python: process.execPath }),
    (error) => error && error.code === 'artifact_digest_mismatch',
  );
});

test('refuses a symlinked portable provider pathname', async (t) => {
  const fixture = await portableFixture(t, Buffer.from('symlink-provider'));
  const linkPath = path.join(path.dirname(fixture.artifactPath), 'linked.pyz');
  await fs.symlink(fixture.artifactPath, linkPath);
  await assert.rejects(
    () => admitPortableArtifact({ artifactPath: linkPath, expectedSha256: fixture.expectedSha256, python: process.execPath }),
    (error) => error && error.code === 'artifact_unsafe',
  );
});

test('reuses the inherited live Causal Loop contract through only the admitted pyz', async (t) => {
  const fixture = await portableFixture(t);
  const scenario = { timedInfluences: [{ atWave: 2, action: 'BLOCK_DOOR' }], maxWaves: 64 };
  const first = await consumePortableScenario({ ...fixture, scenario, python: process.execPath });
  const second = await consumePortableScenario({ ...fixture, scenario, python: process.execPath });

  assert.equal(first.status, 'PASS');
  assert.deepEqual(first, second);
  assert.equal(first.provider.headSha, PORTABLE_PROVIDER_HEAD);
  assert.equal(first.provider.artifactSha256, fixture.expectedSha256);
  assert.equal(first.provider.sourceCheckoutRequired, false);
  assert.equal(first.compatibility.engineSignature, ENGINE_SIGNATURE);
  assert.equal(first.result.receiptHash, 'a'.repeat(64));
  assert.equal(first.result.verification.replayedReceiptHash, first.result.receiptHash);
  assert.deepEqual(first.authority, CLOSED_AUTHORITY);
  assert.match(first.observationSha256, /^[a-f0-9]{64}$/);
});

test('machine-readable portable consumer record pins the exact provider lineage', async () => {
  const record = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'integrations', 'causal-loop-portable-consumer-v1.json'), 'utf8'));
  assert.equal(record.schema, 'axm.capability-consumer/v1');
  assert.equal(record.requires.capabilityId, 'axm.causal-loop.train-platform.process/v1');
  assert.equal(record.testedProvider.pullRequest, 17);
  assert.equal(record.testedProvider.headSha, PORTABLE_PROVIDER_HEAD);
  assert.equal(record.distribution.format, 'python-zipapp');
  assert.equal(record.distribution.callerPinnedSha256, true);
  assert.equal(record.distribution.sourceCheckoutRequired, false);
  assert.equal(record.authority.automaticDownload, false);
  assert.equal(record.authority.automaticExecution, false);
  assert.equal(record.authority.canon, false);
});
