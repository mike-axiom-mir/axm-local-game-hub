'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CAPABILITY_ID,
  ENGINE_SIGNATURE,
  inspectProvider,
  runVerifiedScenario,
} = require('../lib/causal-loop-provider.cjs');

const AUTHORITY = { commitsHistory: false, writesCanonicalState: false, merges: false, declaresCanon: false };

function providerSource(options = {}) {
  const signature = options.signature || ENGINE_SIGNATURE;
  const verifyHash = options.verifyHash || 'a'.repeat(64);
  return `
'use strict';
if (process.env.AXM_PRIVATE_TEST_SECRET) throw new Error('private environment crossed process boundary');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const authority = ${JSON.stringify(AUTHORITY)};
  const base = { schema: 'axm.causal-loop.process-response/v1', requestId: request.requestId, status: 'PASS', capabilityId: '${CAPABILITY_ID}', authority };
  if (request.op === 'describe') base.capability = {
    schema: 'axm.capability/v1', capabilityId: '${CAPABILITY_ID}',
    provider: { repository: 'mike-axiom-mir/axm-casual-loop', module: 'fixture', entrypoint: 'fixture', licenseFile: 'LICENSE' },
    protocol: { transport: 'ndjson-stdio', requestSchema: 'axm.causal-loop.process-request/v1', responseSchema: 'axm.causal-loop.process-response/v1', operations: ['describe', 'run', 'verify'] },
    engine: { loopId: 'axm.train-platform-loop/v0.01', loopVersion: '0.08', receiptSchema: 'axm.causal-loop.run-receipt/v0.08', engineSignature: '${signature}', allowedActions: ['WAIT', 'BLOCK_DOOR', 'TRIGGER_ALARM', 'TALK_TO_PASSENGER'], maxTimedInfluences: 64, maxWavesLimit: 256 },
    properties: { deterministic: true, headless: true, offline: true, thirdPartyDependencies: false }, authority,
  };
  if (request.op === 'run') Object.assign(base, { inputHash: 'b'.repeat(64), receiptHash: 'a'.repeat(64), executionMaxWaves: request.maxWaves, executionStatus: 'converged', replayMatches: true, receipt: { fixture: true } });
  if (request.op === 'verify') Object.assign(base, { verifiedReceiptHash: '${verifyHash}', replayedReceiptHash: '${verifyHash}', executionMaxWaves: request.maxWaves, executionStatus: 'converged', replayMatches: true });
  process.stdout.write(JSON.stringify(base) + '\\n');
});
`;
}

async function fixture(t, source = providerSource()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axm-hub-provider-'));
  const entry = path.join(root, 'adapter.py');
  await fs.writeFile(entry, source);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { AXM_CAUSAL_LOOP_ENTRY: entry, AXM_CAUSAL_LOOP_PYTHON: process.execPath, PATH: process.env.PATH, HOME: process.env.HOME, AXM_PRIVATE_TEST_SECRET: 'must-not-cross-boundary' };
}

test('holds clearly when the optional provider is not configured', async () => {
  const result = await inspectProvider({ env: {} });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.configured, false);
  assert.equal(result.error.code, 'provider_not_configured');
});

test('accepts only an absolute regular provider entry', async () => {
  const result = await inspectProvider({ env: { AXM_CAUSAL_LOOP_ENTRY: 'relative/adapter.py' } });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.error.code, 'provider_path_not_absolute');
});

test('pins the complete live descriptor before running and verifying a scenario', async (t) => {
  const env = await fixture(t);
  const discovered = await inspectProvider({ env });
  assert.equal(discovered.status, 'PASS');
  assert.equal(discovered.capability.engine.engineSignature, ENGINE_SIGNATURE);

  const scenario = { timedInfluences: [{ atWave: 2, action: 'BLOCK_DOOR' }], maxWaves: 64 };
  const result = await runVerifiedScenario(scenario, { env });
  assert.equal(result.status, 'PASS');
  assert.equal(result.capability.capabilityId, CAPABILITY_ID);
  assert.equal(result.receiptHash, 'a'.repeat(64));
  assert.equal(result.verification.verifiedReceiptHash, result.receiptHash);
  assert.deepEqual(result.authority, AUTHORITY);
});

test('holds on a semantically incompatible provider descriptor', async (t) => {
  const env = await fixture(t, providerSource({ signature: 'f'.repeat(64) }));
  const result = await inspectProvider({ env });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.error.code, 'provider_incompatible');
});

test('holds when run and verification receipts disagree', async (t) => {
  const env = await fixture(t, providerSource({ verifyHash: 'c'.repeat(64) }));
  const result = await runVerifiedScenario({ timedInfluences: [] }, { env });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.error.code, 'provider_verification_mismatch');
});

test('refuses invalid scenarios before invoking the provider', async () => {
  const result = await runVerifiedScenario({ timedInfluences: [{ atWave: -1, action: 'INVENT_OUTCOME' }] }, { env: {} });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.schema, 'axm.local-game-hub.causal-loop-result/v1');
  assert.equal(result.configured, false);
  assert.equal(result.error.code, 'invalid_scenario');
});

test('bounds a provider that does not answer', async (t) => {
  const env = await fixture(t, `setInterval(() => {}, 1000); process.stdin.resume();\n`);
  const result = await inspectProvider({ env, timeoutMs: 60 });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.error.code, 'provider_timeout');
});

test('machine-readable consumer declaration pins the tested provider head', async () => {
  const value = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'integrations', 'causal-loop-consumer-v1.json'), 'utf8'));
  assert.equal(value.schema, 'axm.capability-consumer/v1');
  assert.equal(value.requires.capabilityId, CAPABILITY_ID);
  assert.equal(value.requires.engineSignature, ENGINE_SIGNATURE);
  assert.equal(value.testedProvider.headSha, 'cb2793fbb48efd750670bd9d08abe5a0bfa233df');
  assert.equal(value.properties.optional, true);
  assert.equal(value.properties.defaultGameCatalogUnchanged, true);
});
