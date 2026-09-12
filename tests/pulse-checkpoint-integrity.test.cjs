'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../games/012-pulse-choir/runtime/game-core');
const checkpoints = require('../games/012-pulse-choir/runtime/checkpoint-store');

let assertions = 0;
function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  assertions += 1;
}

function makeState(roster, now) {
  return core.createInitialState(roster, { seed: 12026, now });
}

function makeStore(filePath, roster, clock) {
  return checkpoints.createCheckpointStore({
    clock,
    env: { AXM_GAME_SESSION_ID: 'test-session' },
    filePath,
    roster,
    saveIntervalMs: 1,
    ttlMs: 60_000
  });
}

function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axm-pulse-checkpoint-'));
  const filePath = path.join(directory, 'show.json');
  const roster = core.normalizeRoster([]);
  let now = 10_000;

  try {
    const initial = makeState(roster, now);
    const writer = makeStore(filePath, roster, () => now);
    check(writer.save(initial, true), 'valid state saves');

    const sealed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    equal(sealed.schema, checkpoints.CHECKPOINT_SCHEMA, 'writer emits current schema');
    check(/^[a-f0-9]{64}$/.test(sealed.stateDigest), 'state is content-bound');
    check(/^[a-f0-9]{64}$/.test(sealed.checkpointDigest), 'envelope is content-bound');

    const tampered = JSON.parse(JSON.stringify(sealed));
    tampered.state.score += 500;
    fs.writeFileSync(filePath, JSON.stringify(tampered));
    now += 100;
    const tamperedStore = makeStore(filePath, roster, () => now);
    const rejected = tamperedStore.load();
    equal(rejected.state, null, 'tampered state is not restored');
    equal(rejected.recovery.status, 'held-invalid', 'tampered state enters a write hold');
    equal(rejected.recovery.lastError, 'checkpoint-state-digest', 'tampering has an exact refusal');
    const rejectedBytes = fs.readFileSync(filePath);
    check(!tamperedStore.save(initial, true), 'routine save cannot overwrite held evidence');
    check(fs.readFileSync(filePath).equals(rejectedBytes), 'held bytes remain exact');

    const recovery = tamperedStore.clear();
    check(recovery.cleared, 'explicit clear releases the hold');
    check(recovery.quarantined, 'explicit clear quarantines rejected bytes');
    check(fs.existsSync(recovery.quarantinePath), 'quarantine is retained locally');
    check(fs.readFileSync(recovery.quarantinePath).equals(rejectedBytes), 'quarantine preserves exact bytes');
    equal(tamperedStore.info().quarantineRef, path.basename(recovery.quarantinePath), 'public recovery state exposes only a local reference');
    check(!JSON.stringify(tamperedStore.info()).includes(directory), 'public recovery state does not expose an absolute host path');
    check(tamperedStore.save(initial, true), 'saving resumes only after explicit recovery');

    const valid = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const envelopeTamper = JSON.parse(JSON.stringify(valid));
    envelopeTamper.savedAt -= 1;
    fs.writeFileSync(filePath, JSON.stringify(envelopeTamper));
    const envelopeStore = makeStore(filePath, roster, () => now);
    equal(envelopeStore.load().recovery.lastError, 'checkpoint-envelope-digest', 'metadata tampering is rejected');

    fs.writeFileSync(filePath, '{broken');
    const corruptStore = makeStore(filePath, roster, () => now);
    equal(corruptStore.load().recovery.status, 'held-corrupt', 'malformed JSON enters a write hold');
    check(!corruptStore.save(initial, true), 'malformed bytes cannot be overwritten by autosave');

    const legacy = {
      schema: checkpoints.LEGACY_CHECKPOINT_SCHEMA,
      gameId: core.GAME_ID,
      savedAt: now,
      sessionId: 'legacy-session',
      rosterFingerprint: checkpoints.rosterFingerprint(roster),
      roster: checkpoints.rosterShape(roster),
      state: initial
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy));
    const legacyStore = makeStore(filePath, roster, () => now);
    const migrated = legacyStore.load();
    check(Boolean(migrated.state), 'structurally valid legacy state remains recoverable');
    equal(migrated.recovery.status, 'migrated-unsealed-v1', 'legacy trust is explicitly labeled');
    equal(migrated.recovery.sourceSchema, checkpoints.LEGACY_CHECKPOINT_SCHEMA, 'migration exposes its source schema');
    check(legacyStore.save(migrated.state, true), 'next save seals migrated state as v2');
    equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).schema, checkpoints.CHECKPOINT_SCHEMA, 'migration converges to v2');

    const repeat = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const repeatStore = makeStore(filePath, roster, () => now);
    check(Boolean(repeatStore.load().state), 'valid sealed state restores');
    equal(JSON.parse(fs.readFileSync(filePath, 'utf8')), repeat, 'load does not rewrite canonical bytes');

    const extraField = JSON.parse(JSON.stringify(repeat));
    extraField.projection = true;
    extraField.checkpointDigest = checkpoints.digest(Object.fromEntries(Object.entries(extraField).filter(([key]) => key !== 'checkpointDigest')));
    fs.writeFileSync(filePath, JSON.stringify(extraField));
    const extraStore = makeStore(filePath, roster, () => now);
    equal(extraStore.load().recovery.lastError, 'checkpoint-envelope-shape', 'unknown envelope fields fail closed');

    fs.writeFileSync(filePath, JSON.stringify({ ...repeat, schema: 'axm.pulse-choir-checkpoint/v999' }));
    const schemaStore = makeStore(filePath, roster, () => now);
    equal(schemaStore.load().recovery.lastError, 'checkpoint-schema', 'unknown checkpoint versions fail closed');

    const wrongRoster = core.normalizeRoster([{ id: 'p1', slot: 1, seatId: 'other', name: 'Other', type: 'human' }]);
    fs.writeFileSync(filePath, JSON.stringify(repeat));
    const rosterStore = makeStore(filePath, wrongRoster, () => now);
    equal(rosterStore.load().recovery.lastError, 'roster-mismatch', 'wrong-roster state fails closed');
    check(rosterStore.info().writesBlocked, 'wrong-roster bytes cannot be overwritten');

    const nonJson = makeState(roster, now);
    nonJson.projection = undefined;
    const nonJsonStore = makeStore(path.join(directory, 'non-json.json'), roster, () => now);
    check(!nonJsonStore.save(nonJson, true), 'non-portable state cannot be sealed');
    equal(nonJsonStore.info().lastError, 'checkpoint-non-json-value', 'non-portable refusal is explicit');

    const expiredPath = path.join(directory, 'expired.json');
    now = 20_000;
    const expiredWriter = makeStore(expiredPath, roster, () => now);
    check(expiredWriter.save(makeState(roster, now), true), 'expiry fixture saves');
    now += 60_001;
    const expiredStore = makeStore(expiredPath, roster, () => now);
    equal(expiredStore.load().recovery.status, 'expired', 'expired valid state is distinguished from corruption');
    check(!expiredStore.info().writesBlocked, 'expiry does not create an integrity hold');
    check(expiredStore.save(makeState(roster, now), true), 'fresh state may replace an expired checkpoint');

    const futurePath = path.join(directory, 'future.json');
    const futureWriter = makeStore(futurePath, roster, () => now + 600_001);
    check(futureWriter.save(makeState(roster, now + 600_001), true), 'future fixture saves');
    const futureStore = makeStore(futurePath, roster, () => now);
    equal(futureStore.load().recovery.lastError, 'checkpoint-future', 'future checkpoints fail closed');
    check(futureStore.info().writesBlocked, 'future checkpoint bytes remain held');

    const oversizedPath = path.join(directory, 'oversized.json');
    fs.writeFileSync(oversizedPath, 'x');
    fs.truncateSync(oversizedPath, checkpoints.MAX_CHECKPOINT_BYTES + 1);
    const oversizedStore = makeStore(oversizedPath, roster, () => now);
    equal(oversizedStore.load().recovery.lastError, 'checkpoint-size', 'oversized checkpoints fail before parsing');
    check(oversizedStore.info().writesBlocked, 'oversized checkpoint remains held');
    const oversizedRecovery = oversizedStore.clear();
    check(oversizedRecovery.quarantined, 'oversized rejected state is quarantined without loading it as state');
    equal(fs.statSync(oversizedRecovery.quarantinePath).size, checkpoints.MAX_CHECKPOINT_BYTES + 1, 'oversized quarantine preserves exact length');

    process.stdout.write(`pulse checkpoint integrity passed: ${assertions} assertions\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

run();
