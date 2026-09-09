'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MANIFEST_NAME = 'FILE_INTEGRITY.json';
const BUILD_RECEIPT_NAME = 'BUILD_RECEIPT.json';
const DISTRIBUTION_SOURCE_NAME = 'DISTRIBUTION_SOURCE.json';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPlainObject(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function validateRelativePath(value) {
  assert(typeof value === 'string' && value.length > 0, 'manifest path must be a non-empty string');
  assert(!value.includes('\0'), `manifest path contains NUL: ${JSON.stringify(value)}`);
  assert(!value.includes('\\'), `manifest path must use POSIX separators: ${value}`);
  assert(!value.startsWith('/'), `manifest path must be relative: ${value}`);
  assert(!/^[A-Za-z]:/.test(value), `manifest path must not contain a Windows drive prefix: ${value}`);
  const parts = value.split('/');
  assert(parts.every((part) => part !== '' && part !== '.' && part !== '..'), `manifest path contains an unsafe segment: ${value}`);
  return value;
}

function validateManifestStructure(manifest) {
  assertPlainObject(manifest, 'integrity manifest');
  assert(manifest.schema === 'axm.file-integrity/v1', `unsupported integrity schema: ${manifest.schema}`);
  assert(manifest.algorithm === 'sha256', `unsupported integrity algorithm: ${manifest.algorithm}`);
  assert(typeof manifest.distribution === 'string' && manifest.distribution.length > 0, 'manifest distribution must be non-empty');
  assert(typeof manifest.version === 'string' && manifest.version.length > 0, 'manifest version must be non-empty');
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest files must be a non-empty array');

  const seen = new Set();
  for (const [index, entry] of manifest.files.entries()) {
    assertPlainObject(entry, `manifest files[${index}]`);
    const rel = validateRelativePath(entry.path);
    assert(rel !== MANIFEST_NAME, `${MANIFEST_NAME} must not recursively seal itself`);
    assert(!seen.has(rel), `duplicate manifest path: ${rel}`);
    seen.add(rel);
    assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, `invalid byte count for ${rel}`);
    assert(typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256), `invalid sha256 for ${rel}`);
  }

  return seen;
}

function validateContractIdentity(manifest, buildReceipt, source) {
  assertPlainObject(buildReceipt, 'build receipt');
  assertPlainObject(source, 'distribution source');
  assert(buildReceipt.schema === 'axm.focused-distribution-build-receipt/v1', `unsupported build receipt schema: ${buildReceipt.schema}`);
  assert(source.schema === 'axm.focused-distribution/v1', `unsupported distribution source schema: ${source.schema}`);
  assert(buildReceipt.distribution === manifest.distribution, 'build receipt distribution does not match integrity manifest');
  assert(source.id === manifest.distribution, 'distribution source id does not match integrity manifest');
  assert(buildReceipt.version === manifest.version, 'build receipt version does not match integrity manifest');
  assert(source.version === manifest.version, 'distribution source version does not match integrity manifest');

  const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
  assert(manifestPaths.has(BUILD_RECEIPT_NAME), `${BUILD_RECEIPT_NAME} must be sealed by the integrity manifest`);
  assert(manifestPaths.has(DISTRIBUTION_SOURCE_NAME), `${DISTRIBUTION_SOURCE_NAME} must be sealed by the integrity manifest`);

  assertPlainObject(buildReceipt.assembledBeforeReceipt, 'build receipt assembledBeforeReceipt');
  assert(Number.isSafeInteger(buildReceipt.assembledBeforeReceipt.files) && buildReceipt.assembledBeforeReceipt.files >= 0,
    'build receipt assembledBeforeReceipt.files must be a non-negative safe integer');
  const expectedSealedFiles = buildReceipt.assembledBeforeReceipt.files + 1;
  assert(manifest.files.length === expectedSealedFiles,
    `sealed file count ${manifest.files.length} does not match build receipt expectation ${expectedSealedFiles}`);
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function assertNoSymlinkComponents(root, rel) {
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current);
    assert(!stat.isSymbolicLink(), `sealed path crosses a symbolic link: ${rel}`);
  }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifySealedFile(root, entry) {
  const rel = validateRelativePath(entry.path);
  const absolute = path.join(root, ...rel.split('/'));

  try {
    await assertNoSymlinkComponents(root, rel);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`sealed file is missing: ${rel}`);
    throw error;
  }

  const stat = await fsp.lstat(absolute);
  assert(stat.isFile(), `sealed path is not a regular file: ${rel}`);
  assert(stat.size === entry.bytes, `byte count mismatch for ${rel}: expected ${entry.bytes}, got ${stat.size}`);
  const digest = await sha256File(absolute);
  assert(digest === entry.sha256, `sha256 mismatch for ${rel}: expected ${entry.sha256}, got ${digest}`);
}

async function verifyDistribution(rootPath) {
  const root = path.resolve(rootPath);
  const rootStat = await fsp.lstat(root);
  assert(rootStat.isDirectory(), `distribution root is not a directory: ${root}`);
  assert(!rootStat.isSymbolicLink(), `distribution root must not be a symbolic link: ${root}`);

  const [manifest, buildReceipt, source] = await Promise.all([
    readJson(path.join(root, MANIFEST_NAME), MANIFEST_NAME),
    readJson(path.join(root, BUILD_RECEIPT_NAME), BUILD_RECEIPT_NAME),
    readJson(path.join(root, DISTRIBUTION_SOURCE_NAME), DISTRIBUTION_SOURCE_NAME),
  ]);

  validateManifestStructure(manifest);
  validateContractIdentity(manifest, buildReceipt, source);

  for (const entry of manifest.files) {
    await verifySealedFile(root, entry);
  }

  return {
    distribution: manifest.distribution,
    version: manifest.version,
    sealedFiles: manifest.files.length,
    algorithm: manifest.algorithm,
  };
}

async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  try {
    const result = await verifyDistribution(root);
    process.stdout.write(`PASS ${result.distribution} ${result.version}: verified ${result.sealedFiles} sealed files with ${result.algorithm}; ${MANIFEST_NAME} is self-excluded by contract.\n`);
  } catch (error) {
    process.stderr.write(`FAIL package integrity: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  validateRelativePath,
  validateManifestStructure,
  validateContractIdentity,
  verifyDistribution,
};

if (require.main === module) {
  void main();
}
