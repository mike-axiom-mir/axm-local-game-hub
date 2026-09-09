'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  gitBlobSha1,
  validateManifestStructure,
  verifyDistribution,
} = require('../tools/verify-file-integrity.cjs');

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axm-hub-integrity-'));
  const payload = Buffer.from('sealed game payload\n');
  const source = { schema: 'axm.focused-distribution/v1', id: 'fixture-hub', version: 'test-v1' };
  const buildReceipt = {
    schema: 'axm.focused-distribution-build-receipt/v1',
    distribution: 'fixture-hub',
    version: 'test-v1',
    assembledBeforeReceipt: { files: 2, bytes: payload.length },
  };

  await fs.writeFile(path.join(root, 'payload.txt'), payload);
  await fs.writeFile(path.join(root, 'DISTRIBUTION_SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'BUILD_RECEIPT.json'), `${JSON.stringify(buildReceipt, null, 2)}\n`);

  const entries = [];
  for (const rel of ['payload.txt', 'DISTRIBUTION_SOURCE.json', 'BUILD_RECEIPT.json']) {
    const bytes = await fs.readFile(path.join(root, rel));
    entries.push({ path: rel, bytes: bytes.length, sha256: digest(bytes) });
  }
  const manifest = {
    schema: 'axm.file-integrity/v1', algorithm: 'sha256', distribution: 'fixture-hub', version: 'test-v1', files: entries,
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'FILE_INTEGRITY.json'), manifestBuffer);
  return { root, manifest, manifestBuffer };
}

test('accepts an exact sealed distribution', async (t) => {
  const { root } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await verifyDistribution(root);
  assert.equal(result.sealedFiles, 3);
  assert.equal(result.amendments, 0);
});

test('rejects content tampering even when file length is unchanged', async (t) => {
  const { root } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'payload.txt'), Buffer.from('sealed game payloae\n'));
  await assert.rejects(() => verifyDistribution(root), /sha256 mismatch for payload\.txt/);
});

test('accepts an explicit amendment only when it is bound to the exact base seal', async (t) => {
  const { root, manifest, manifestBuffer } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const changed = Buffer.from('updated game payload\n');
  await fs.writeFile(path.join(root, 'payload.txt'), changed);
  const old = manifest.files.find((entry) => entry.path === 'payload.txt');
  const amendments = {
    schema: 'axm.file-integrity-amendments/v1',
    base: { manifest: 'FILE_INTEGRITY.json', gitBlobSha1: gitBlobSha1(manifestBuffer) },
    amendments: [{
      path: 'payload.txt',
      sourceCommit: '1'.repeat(40),
      reason: 'intentional fixture update',
      previous: { bytes: old.bytes, sha256: old.sha256 },
      current: { bytes: changed.length, sha256: digest(changed) },
    }],
  };
  await fs.writeFile(path.join(root, 'FILE_INTEGRITY_AMENDMENTS.json'), `${JSON.stringify(amendments, null, 2)}\n`);
  const result = await verifyDistribution(root);
  assert.equal(result.amendments, 1);
});

test('rejects an amendment detached from the base manifest or its previous seal', async (t) => {
  const { root, manifest, manifestBuffer } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = manifest.files.find((entry) => entry.path === 'payload.txt');
  const amendment = {
    schema: 'axm.file-integrity-amendments/v1',
    base: { manifest: 'FILE_INTEGRITY.json', gitBlobSha1: '0'.repeat(40) },
    amendments: [{
      path: 'payload.txt', sourceCommit: '1'.repeat(40), reason: 'fixture',
      previous: { bytes: old.bytes, sha256: old.sha256 }, current: { bytes: old.bytes, sha256: old.sha256 },
    }],
  };
  await fs.writeFile(path.join(root, 'FILE_INTEGRITY_AMENDMENTS.json'), `${JSON.stringify(amendment, null, 2)}\n`);
  await assert.rejects(() => verifyDistribution(root), /does not match checkout/);

  amendment.base.gitBlobSha1 = gitBlobSha1(manifestBuffer);
  amendment.amendments[0].previous.sha256 = 'f'.repeat(64);
  await fs.writeFile(path.join(root, 'FILE_INTEGRITY_AMENDMENTS.json'), `${JSON.stringify(amendment, null, 2)}\n`);
  await assert.rejects(() => verifyDistribution(root), /previous seal does not match base manifest/);
});

test('rejects byte-length drift before hashing', async (t) => {
  const { root } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.appendFile(path.join(root, 'payload.txt'), 'extra');
  await assert.rejects(() => verifyDistribution(root), /byte count mismatch for payload\.txt/);
});

test('rejects a missing sealed file', async (t) => {
  const { root } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.rm(path.join(root, 'payload.txt'));
  await assert.rejects(() => verifyDistribution(root), /sealed file is missing: payload\.txt/);
});

test('rejects traversal, Windows-style paths, duplicates, and recursive self-sealing', () => {
  const base = { schema: 'axm.file-integrity/v1', algorithm: 'sha256', distribution: 'fixture-hub', version: 'test-v1' };
  const entry = { bytes: 0, sha256: '0'.repeat(64) };
  assert.throws(() => validateManifestStructure({ ...base, files: [{ path: '../outside', ...entry }] }), /unsafe segment/);
  assert.throws(() => validateManifestStructure({ ...base, files: [{ path: 'C:\\outside', ...entry }] }), /POSIX separators|Windows drive/);
  assert.throws(() => validateManifestStructure({ ...base, files: [{ path: 'a', ...entry }, { path: 'a', ...entry }] }), /duplicate manifest path/);
  assert.throws(() => validateManifestStructure({ ...base, files: [{ path: 'FILE_INTEGRITY.json', ...entry }] }), /must not recursively seal itself/);
});

test('rejects manifest/build/source identity drift and sealed-count drift', async (t) => {
  const { root } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, 'BUILD_RECEIPT.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  receipt.assembledBeforeReceipt.files = 99;
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(() => verifyDistribution(root), /sealed file count 3 does not match build receipt expectation 100/);
});

test('rejects symlink substitution for a sealed file', async (t) => {
  if (process.platform === 'win32') t.skip('symlink creation may require elevated Windows privileges');
  const { root } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'other.txt');
  await fs.writeFile(target, 'sealed game payload\n');
  await fs.rm(path.join(root, 'payload.txt'));
  await fs.symlink(target, path.join(root, 'payload.txt'));
  await assert.rejects(() => verifyDistribution(root), /symbolic link/);
});
