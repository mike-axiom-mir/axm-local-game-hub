#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { URL } = require('node:url');

const CONTRACT_PATH = path.join(__dirname, 'contract.json');
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 16 * 1024 * 1024;
const PROVENANCE_FILES = ['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY.json'];

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function hold(code, message) {
  throw new BridgeError(code, message);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(file, code) {
  let body;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (error) {
    hold(code, `cannot read ${path.basename(file)}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    hold(code, `invalid JSON in ${path.basename(file)}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) hold(code, `${path.basename(file)} must contain one object`);
  return parsed;
}

function loadContract() {
  const contract = readJson(CONTRACT_PATH, 'CONTRACT_INVALID');
  if (contract.schema !== 'axm.local-game-hub.anomaly-garden-static-consumer/v0.1') hold('CONTRACT_INVALID', 'unexpected bridge contract schema');
  if (!contract.provider || !/^[0-9a-f]{40}$/.test(contract.provider.revision || '')) hold('CONTRACT_INVALID', 'provider revision must be an exact 40-hex Git commit');
  if (!contract.runtime || contract.runtime.host !== '127.0.0.1' || contract.runtime.externalNetworkAllowed !== false) hold('CONTRACT_INVALID', 'bridge runtime authority widened');
  if (!contract.authority || Object.values(contract.authority).some((value) => value !== false)) hold('CONTRACT_INVALID', 'bridge authority must remain closed');
  return contract;
}

function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
    windowsHide: true,
    env: {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || '',
      WINDIR: process.env.WINDIR || '',
      HOME: process.env.HOME || '',
      USERPROFILE: process.env.USERPROFILE || ''
    }
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : String(result.stderr || '').trim();
    hold('PROVIDER_GIT_UNAVAILABLE', `provider Git check failed: ${detail || `exit ${result.status}`}`);
  }
  return String(result.stdout || '').trim();
}

function normalizeLocalReference(reference, fromPath) {
  const raw = String(reference || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  if (raw.includes('\\')) hold('PROVIDER_REFERENCE_UNSAFE', `backslash reference refused in ${fromPath}`);
  if (/[?#]/.test(raw)) hold('PROVIDER_REFERENCE_UNSAFE', `query/hash reference refused in ${fromPath}: ${raw}`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('/')) {
    hold('PROVIDER_EXTERNAL_REFERENCE', `non-local runtime reference refused in ${fromPath}: ${raw}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    hold('PROVIDER_REFERENCE_UNSAFE', `invalid escaped reference in ${fromPath}: ${raw}`);
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), decoded));
  if (!joined || joined === '.' || joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) {
    hold('PROVIDER_REFERENCE_UNSAFE', `runtime reference escapes provider root: ${raw}`);
  }
  return joined;
}

function htmlReferences(text, fromPath) {
  const refs = [];
  const pattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(pattern)) {
    const normalized = normalizeLocalReference(match[1], fromPath);
    if (normalized) refs.push(normalized);
  }
  return refs;
}

function cssReferences(text, fromPath) {
  const refs = [];
  const pattern = /url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi;
  for (const match of text.matchAll(pattern)) {
    const raw = match[2];
    if (/^data:/i.test(raw)) continue;
    const normalized = normalizeLocalReference(raw, fromPath);
    if (normalized) refs.push(normalized);
  }
  return refs;
}

function readRegularBounded(root, relativePath) {
  const full = path.resolve(root, ...relativePath.split('/'));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (full !== root && !full.startsWith(prefix)) hold('PROVIDER_PATH_ESCAPE', `path escapes provider root: ${relativePath}`);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    hold('PROVIDER_FILE_MISSING', `${relativePath}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) hold('PROVIDER_FILE_TYPE', `${relativePath} must be a regular non-symlink file`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_FILE_BYTES) hold('PROVIDER_FILE_SIZE', `${relativePath} exceeds the ${MAX_FILE_BYTES}-byte file ceiling`);
  let real;
  try {
    real = fs.realpathSync(full);
  } catch (error) {
    hold('PROVIDER_FILE_MISSING', `${relativePath}: ${error.message}`);
  }
  if (real !== full) hold('PROVIDER_FILE_ALIAS', `${relativePath} resolves through an alias/symlink`);
  const bytes = fs.readFileSync(full);
  if (bytes.length !== stat.size) hold('PROVIDER_FILE_DRIFT', `${relativePath} changed while being read`);
  return { full, bytes, bytesCount: bytes.length, sha256: sha256(bytes) };
}

function verifyProviderRoot(providerRoot, options = {}) {
  const contract = options.contract || loadContract();
  if (!path.isAbsolute(providerRoot || '')) hold('PROVIDER_ROOT_REQUIRED', 'provider root must be an explicit absolute path');
  let rootStat;
  try {
    rootStat = fs.lstatSync(providerRoot);
  } catch (error) {
    hold('PROVIDER_ROOT_MISSING', error.message);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) hold('PROVIDER_ROOT_TYPE', 'provider root must be a real directory, not a symlink');
  const root = fs.realpathSync(providerRoot);

  const expectedRevision = options.expectedRevision || contract.provider.revision;
  if (!/^[0-9a-f]{40}$/.test(expectedRevision)) hold('PROVIDER_REVISION_INVALID', 'expected provider revision must be 40 lowercase hex characters');
  const observedRevision = runGit(root, ['rev-parse', 'HEAD']);
  if (observedRevision !== expectedRevision) hold('PROVIDER_REVISION_MISMATCH', `expected ${expectedRevision}, observed ${observedRevision}`);

  const packageRecord = readJson(path.join(root, 'package.json'), 'PROVIDER_PACKAGE_INVALID');
  const expectedPackageName = options.expectedPackageName || contract.provider.packageName;
  const expectedVersion = options.expectedVersion || contract.provider.version;
  if (packageRecord.name !== expectedPackageName || packageRecord.version !== expectedVersion || packageRecord.private !== true) {
    hold('PROVIDER_PACKAGE_MISMATCH', `expected private ${expectedPackageName}@${expectedVersion}`);
  }

  const entry = options.browserEntry || contract.provider.browserEntry;
  const queue = [entry];
  const runtime = new Map();
  while (queue.length) {
    const relativePath = queue.shift();
    if (runtime.has(relativePath)) continue;
    const record = readRegularBounded(root, relativePath);
    runtime.set(relativePath, record);
    if ([...runtime.values()].reduce((sum, item) => sum + item.bytesCount, 0) > MAX_RUNTIME_BYTES) {
      hold('PROVIDER_RUNTIME_TOO_LARGE', `runtime closure exceeds ${MAX_RUNTIME_BYTES} bytes`);
    }
    const text = /\.html?$/i.test(relativePath) || /\.css$/i.test(relativePath) ? record.bytes.toString('utf8') : null;
    const refs = /\.html?$/i.test(relativePath) ? htmlReferences(text, relativePath) : /\.css$/i.test(relativePath) ? cssReferences(text, relativePath) : [];
    for (const ref of refs) if (!runtime.has(ref) && !queue.includes(ref)) queue.push(ref);
  }

  const provenance = [];
  for (const relativePath of PROVENANCE_FILES) {
    const record = readRegularBounded(root, relativePath);
    provenance.push({ path: relativePath, bytes: record.bytesCount, sha256: record.sha256 });
  }
  const trackedPaths = [...runtime.keys(), ...PROVENANCE_FILES];
  const dirty = runGit(root, ['status', '--porcelain=v1', '--untracked-files=no', '--', ...trackedPaths]);
  if (dirty) hold('PROVIDER_TRACKED_DRIFT', `provider tracked bytes differ from ${expectedRevision}`);

  const runtimeFiles = [...runtime.entries()].map(([relativePath, record]) => ({
    path: relativePath,
    bytes: record.bytesCount,
    sha256: record.sha256
  })).sort((a, b) => a.path.localeCompare(b.path));
  const closureIdentity = sha256(Buffer.from(canonical(runtimeFiles)));
  const receiptBody = {
    schema: 'axm.local-game-hub.anomaly-garden-static-admission/v0.1',
    provider: {
      repository: contract.provider.repository,
      revision: observedRevision,
      packageName: packageRecord.name,
      version: packageRecord.version,
      browserEntry: entry
    },
    runtime: {
      files: runtimeFiles,
      fileCount: runtimeFiles.length,
      bytes: runtimeFiles.reduce((sum, item) => sum + item.bytes, 0),
      closureSha256: closureIdentity,
      host: '127.0.0.1',
      externalNetworkAllowed: false
    },
    provenance,
    authority: contract.authority
  };
  return Object.freeze({
    ...receiptBody,
    receiptSha256: sha256(Buffer.from(canonical(receiptBody))),
    providerRoot: root,
    admittedPaths: new Set(runtimeFiles.map((item) => item.path))
  });
}

function contentType(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  })[ext] || 'application/octet-stream';
}

function createStaticServer(admission) {
  if (!admission || admission.schema !== 'axm.local-game-hub.anomaly-garden-static-admission/v0.1' || !(admission.admittedPaths instanceof Set)) {
    hold('ADMISSION_REQUIRED', 'a verified Anomaly Garden admission receipt is required');
  }
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const relativePath = pathname === '/' ? admission.provider.browserEntry : pathname.replace(/^\/+/, '');
    if (!relativePath || relativePath.includes('\\') || relativePath.includes('..') || !admission.admittedPaths.has(relativePath)) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end('not admitted');
    }
    let record;
    try {
      record = readRegularBounded(admission.providerRoot, relativePath);
    } catch (error) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, code: error.code || 'PROVIDER_RUNTIME_DRIFT' }));
    }
    const admitted = admission.runtime.files.find((item) => item.path === relativePath);
    if (!admitted || admitted.bytes !== record.bytesCount || admitted.sha256 !== record.sha256) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, code: 'PROVIDER_RUNTIME_DRIFT' }));
    }
    const headers = {
      'Content-Type': contentType(relativePath),
      'Content-Length': String(record.bytes.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    res.end(record.bytes);
  });
  return server;
}

async function listenLoopback(server, port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) hold('PORT_INVALID', 'port must be an integer from 0 through 65535');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}/`;
}

function publicReceipt(admission) {
  const { providerRoot, admittedPaths, ...safe } = admission;
  return safe;
}

async function main(argv) {
  const [command, providerRoot, portText] = argv;
  if (!['verify', 'serve'].includes(command) || !providerRoot) {
    process.stderr.write('usage: bridge.cjs verify|serve ABSOLUTE_PROVIDER_ROOT [PORT]\n');
    process.exitCode = 2;
    return;
  }
  let admission;
  try {
    admission = verifyProviderRoot(providerRoot);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'HOLD', code: error.code || 'VERIFY_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
    return;
  }
  if (command === 'verify') {
    process.stdout.write(`${JSON.stringify({ status: 'READY', admission: publicReceipt(admission) })}\n`);
    return;
  }
  const port = portText === undefined ? 0 : Number(portText);
  const server = createStaticServer(admission);
  const url = await listenLoopback(server, port);
  process.stdout.write(`${JSON.stringify({
    schema: 'axm.local-game-hub.anomaly-garden-static-serve/v0.1',
    status: 'READY',
    url,
    providerRevision: admission.provider.revision,
    runtimeClosureSha256: admission.runtime.closureSha256,
    admissionReceiptSha256: admission.receiptSha256,
    authority: admission.authority
  })}\n`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ status: 'HOLD', code: error.code || 'BRIDGE_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BridgeError,
  canonical,
  createStaticServer,
  listenLoopback,
  loadContract,
  publicReceipt,
  sha256,
  verifyProviderRoot
};
