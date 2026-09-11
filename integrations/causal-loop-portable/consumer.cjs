'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  CAPABILITY_ID,
  inspectProvider,
  runVerifiedScenario,
} = require('../../lib/causal-loop-provider.cjs');

const OBSERVATION_SCHEMA = 'axm.local-game-hub.causal-loop-portable-observation/v1';
const PORTABLE_PROVIDER_HEAD = 'b14c4fad2af9f1843394c05d21a78df791c757ef';
const PORTABLE_PROVIDER_PR = 17;
const PORTABLE_PROVIDER_REPOSITORY = 'mike-axiom-mir/axm-casual-loop';
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_SCENARIO_BYTES = 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/i;

const CLOSED_AUTHORITY = Object.freeze({
  automaticExecution: false,
  automaticSelection: false,
  installation: false,
  catalogMutation: false,
  gameMutation: false,
  merge: false,
  canon: false,
});

class PortableProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortableProviderError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEnvironment(source) {
  const result = {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'HOME', 'TMPDIR', 'TEMP', 'TMP']) {
    if (typeof source[key] === 'string') result[key] = source[key];
  }
  return result;
}

function sameObservedFile(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

async function readPinnedArtifact(artifactPath, expectedSha256) {
  if (typeof artifactPath !== 'string' || !path.isAbsolute(artifactPath)) {
    throw new PortableProviderError('artifact_path_not_absolute', 'Portable provider path must be absolute.');
  }
  if (path.extname(artifactPath).toLowerCase() !== '.pyz') {
    throw new PortableProviderError('artifact_extension', 'Portable provider must be a .pyz file.');
  }
  if (typeof expectedSha256 !== 'string' || !SHA256_RE.test(expectedSha256)) {
    throw new PortableProviderError('artifact_digest_format', 'Expected portable provider SHA-256 must be 64 hexadecimal characters.');
  }

  let pathnameStat;
  try {
    pathnameStat = await fs.lstat(artifactPath);
  } catch (_) {
    throw new PortableProviderError('artifact_missing', 'Portable provider file is unavailable.');
  }
  if (pathnameStat.isSymbolicLink() || !pathnameStat.isFile()) {
    throw new PortableProviderError('artifact_unsafe', 'Portable provider must be a regular non-symlink file.');
  }
  if (pathnameStat.size < 1 || pathnameStat.size > MAX_ARTIFACT_BYTES) {
    throw new PortableProviderError('artifact_size', `Portable provider must be between 1 and ${MAX_ARTIFACT_BYTES} bytes.`);
  }

  let handle;
  try {
    handle = await fs.open(artifactPath, 'r');
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || !sameObservedFile(pathnameStat, openedBefore)) {
      throw new PortableProviderError('artifact_unstable', 'Portable provider identity changed before admission.');
    }
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    let pathnameAfter;
    try {
      pathnameAfter = await fs.lstat(artifactPath);
    } catch (_) {
      throw new PortableProviderError('artifact_unstable', 'Portable provider pathname disappeared during admission.');
    }
    if (pathnameAfter.isSymbolicLink() || !pathnameAfter.isFile() ||
        !sameObservedFile(openedBefore, openedAfter) || !sameObservedFile(openedAfter, pathnameAfter) ||
        bytes.length !== openedAfter.size) {
      throw new PortableProviderError('artifact_unstable', 'Portable provider changed during admission.');
    }
    const digest = sha256(bytes);
    if (digest !== expectedSha256.toLowerCase()) {
      throw new PortableProviderError('artifact_digest_mismatch', 'Portable provider bytes do not match the caller-pinned SHA-256.');
    }
    return { bytes, digest };
  } finally {
    if (handle) await handle.close();
  }
}

async function admitPortableArtifact({ artifactPath, expectedSha256, python = 'python3', env = process.env }) {
  if (typeof python !== 'string' || !python.trim()) {
    throw new PortableProviderError('python_invalid', 'Python executable must be a non-empty command name or path.');
  }
  const admitted = await readPinnedArtifact(artifactPath, expectedSha256);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axm-hub-causal-portable-'));
  const stagedPath = path.join(root, 'causal-loop-process.pyz');
  try {
    await fs.writeFile(stagedPath, admitted.bytes, { flag: 'wx', mode: 0o600 });
    const staged = await fs.readFile(stagedPath);
    if (sha256(staged) !== admitted.digest || staged.length !== admitted.bytes.length) {
      throw new PortableProviderError('artifact_stage_mismatch', 'Private staged provider bytes do not match admitted bytes.');
    }
    return {
      digest: admitted.digest,
      bytes: admitted.bytes.length,
      providerHead: PORTABLE_PROVIDER_HEAD,
      config: {
        entry: stagedPath,
        python,
        env: safeEnvironment(env),
      },
      cleanup: async () => fs.rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

function failureObservation(error, configured) {
  return {
    schema: OBSERVATION_SCHEMA,
    status: 'HOLD',
    configured,
    capabilityId: CAPABILITY_ID,
    provider: {
      repository: PORTABLE_PROVIDER_REPOSITORY,
      pullRequest: PORTABLE_PROVIDER_PR,
      headSha: PORTABLE_PROVIDER_HEAD,
      sourceCheckoutRequired: false,
    },
    error: {
      code: error && typeof error.code === 'string' ? error.code : 'portable_provider_failure',
      detail: error && typeof error.message === 'string' ? error.message : 'Portable provider admission failed.',
    },
    authority: CLOSED_AUTHORITY,
  };
}

function sealObservation(body) {
  return {
    ...body,
    observationSha256: sha256(Buffer.from(JSON.stringify(body), 'utf8')),
  };
}

async function consumePortableScenario({ artifactPath, expectedSha256, scenario, python = 'python3', env = process.env }) {
  let admission;
  try {
    admission = await admitPortableArtifact({ artifactPath, expectedSha256, python, env });
    const inspected = await inspectProvider({ config: admission.config });
    if (inspected.status !== 'PASS') {
      return sealObservation({
        ...failureObservation(
          new PortableProviderError(
            inspected.error && inspected.error.code ? inspected.error.code : 'provider_describe_hold',
            inspected.error && inspected.error.detail ? inspected.error.detail : 'Portable provider did not pass the inherited live descriptor gate.',
          ),
          true,
        ),
        provider: {
          repository: PORTABLE_PROVIDER_REPOSITORY,
          pullRequest: PORTABLE_PROVIDER_PR,
          headSha: PORTABLE_PROVIDER_HEAD,
          artifactSha256: admission.digest,
          artifactBytes: admission.bytes,
          sourceCheckoutRequired: false,
        },
      });
    }

    const result = await runVerifiedScenario(scenario, { config: admission.config });
    const body = {
      schema: OBSERVATION_SCHEMA,
      status: result.status,
      configured: true,
      capabilityId: CAPABILITY_ID,
      provider: {
        repository: PORTABLE_PROVIDER_REPOSITORY,
        pullRequest: PORTABLE_PROVIDER_PR,
        headSha: PORTABLE_PROVIDER_HEAD,
        artifactSha256: admission.digest,
        artifactBytes: admission.bytes,
        sourceCheckoutRequired: false,
      },
      compatibility: {
        inheritedConsumer: 'axm.local-game-hub.causal-loop-result/v1',
        descriptorStatus: inspected.status,
        engineSignature: inspected.capability.engine.engineSignature,
      },
      result,
      authority: CLOSED_AUTHORITY,
    };
    return sealObservation(body);
  } catch (error) {
    return sealObservation(failureObservation(error, Boolean(artifactPath)));
  } finally {
    if (admission) await admission.cleanup();
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--artifact', '--sha256', '--python'].includes(key) || typeof value !== 'string') {
      throw new PortableProviderError('cli_usage', 'Usage: consumer.cjs --artifact /absolute/provider.pyz --sha256 <sha256> [--python python3]');
    }
    if (key === '--artifact') parsed.artifactPath = value;
    if (key === '--sha256') parsed.expectedSha256 = value;
    if (key === '--python') parsed.python = value;
  }
  if (!parsed.artifactPath || !parsed.expectedSha256) {
    throw new PortableProviderError('cli_usage', 'Usage: consumer.cjs --artifact /absolute/provider.pyz --sha256 <sha256> [--python python3]');
  }
  return parsed;
}

async function readScenarioFromStdin(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_SCENARIO_BYTES) {
      throw new PortableProviderError('scenario_input_limit', `Scenario input exceeds ${MAX_SCENARIO_BYTES} bytes.`);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    throw new PortableProviderError('scenario_json', 'Scenario stdin must contain one valid JSON value.');
  }
}

async function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    const scenario = await readScenarioFromStdin();
    result = await consumePortableScenario({ ...args, scenario });
  } catch (error) {
    result = sealObservation(failureObservation(error, false));
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CLOSED_AUTHORITY,
  MAX_ARTIFACT_BYTES,
  OBSERVATION_SCHEMA,
  PORTABLE_PROVIDER_HEAD,
  PortableProviderError,
  admitPortableArtifact,
  consumePortableScenario,
  readPinnedArtifact,
};
