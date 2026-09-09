'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const REQUEST_SCHEMA = 'axm.causal-loop.process-request/v1';
const RESPONSE_SCHEMA = 'axm.causal-loop.process-response/v1';
const CAPABILITY_ID = 'axm.causal-loop.train-platform.process/v1';
const ENGINE_SIGNATURE = '6cefb89e614353a1289f1661dc08d950f8c9b89dea218d5670fa5ae056c334b9';
const ALLOWED_ACTIONS = Object.freeze(['WAIT', 'BLOCK_DOOR', 'TRIGGER_ALARM', 'TALK_TO_PASSENGER']);
const MAX_OUTPUT_BYTES = 1_200_000;
const DEFAULT_TIMEOUT_MS = 5_000;

class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const allowed = [...required, ...optional];
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.includes(key));
}

function safeEnvironment(source) {
  const result = { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'HOME', 'TMPDIR', 'TEMP', 'TMP']) {
    if (typeof source[key] === 'string') result[key] = source[key];
  }
  return result;
}

async function configuredProvider(env = process.env) {
  const entry = env.AXM_CAUSAL_LOOP_ENTRY;
  if (!entry) throw new ProviderError('provider_not_configured', 'Set AXM_CAUSAL_LOOP_ENTRY to the provider adapter file.');
  if (!path.isAbsolute(entry)) throw new ProviderError('provider_path_not_absolute', 'AXM_CAUSAL_LOOP_ENTRY must be an absolute path.');
  if (path.extname(entry).toLowerCase() !== '.py') throw new ProviderError('provider_entry_type', 'The configured provider entry must be a Python file.');
  let stat;
  try {
    stat = await fs.lstat(entry);
  } catch (_) {
    throw new ProviderError('provider_entry_missing', 'The configured provider entry is unavailable.');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProviderError('provider_entry_unsafe', 'The configured provider entry must be a regular file, not a symbolic link.');
  }
  return {
    entry,
    python: env.AXM_CAUSAL_LOOP_PYTHON || 'python3',
    env: safeEnvironment(env),
  };
}

function parseOneResponse(stdout, expectedRequestId) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 1) throw new ProviderError('provider_output_shape', 'Provider must emit exactly one NDJSON response.');
  let response;
  try {
    response = JSON.parse(lines[0]);
  } catch (_) {
    throw new ProviderError('provider_output_json', 'Provider emitted invalid JSON.');
  }
  if (!exactKeys(response, ['schema', 'requestId', 'status', 'capabilityId', 'authority'], ['capability', 'error', 'inputHash', 'receiptHash', 'executionMaxWaves', 'executionStatus', 'replayMatches', 'receipt', 'verifiedReceiptHash', 'replayedReceiptHash'])) {
    throw new ProviderError('provider_response_contract', 'Provider response fields do not match the pinned process contract.');
  }
  if (response.schema !== RESPONSE_SCHEMA || response.requestId !== expectedRequestId || response.capabilityId !== CAPABILITY_ID) {
    throw new ProviderError('provider_response_identity', 'Provider response identity does not match the pinned process contract.');
  }
  if (!['PASS', 'HOLD'].includes(response.status)) throw new ProviderError('provider_response_status', 'Provider returned an unsupported status.');
  return response;
}

async function invoke(request, options = {}) {
  const config = options.config || await configuredProvider(options.env);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(config.python, [config.entry], {
      cwd: options.cwd || process.cwd(),
      env: config.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let exceeded = false;
    let timedOut = false;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', () => finish(reject, new ProviderError('provider_spawn_failed', 'The configured provider process could not be started.')));
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
        exceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.once('close', (code, signal) => {
      if (timedOut) return finish(reject, new ProviderError('provider_timeout', 'Provider did not answer within the local timeout.'));
      if (exceeded) return finish(reject, new ProviderError('provider_output_limit', 'Provider output exceeded the local limit.'));
      if (signal || (code !== 0 && code !== 1)) return finish(reject, new ProviderError('provider_exit', 'Provider process ended without a valid response.'));
      if (stderrBytes > MAX_OUTPUT_BYTES) return finish(reject, new ProviderError('provider_stderr_limit', 'Provider diagnostic output exceeded the local limit.'));
      try {
        finish(resolve, parseOneResponse(stdout.toString('utf8'), request.requestId));
      } catch (error) {
        finish(reject, error);
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function assertDescriptor(response) {
  if (response.status !== 'PASS' || !response.capability) throw new ProviderError('provider_describe_hold', 'Provider did not accept capability discovery.');
  const capability = response.capability;
  const authority = capability.authority || {};
  const protocol = capability.protocol || {};
  const engine = capability.engine || {};
  const properties = capability.properties || {};
  const operations = Array.isArray(protocol.operations) ? [...protocol.operations].sort() : [];
  if (!exactKeys(authority, ['commitsHistory', 'writesCanonicalState', 'merges', 'declaresCanon']) ||
      !exactKeys(properties, ['deterministic', 'headless', 'offline', 'thirdPartyDependencies']) ||
      !exactKeys(protocol, ['transport', 'requestSchema', 'responseSchema', 'operations']) ||
      capability.schema !== 'axm.capability/v1' || capability.capabilityId !== CAPABILITY_ID ||
      !capability.provider || capability.provider.repository !== 'mike-axiom-mir/axm-casual-loop' ||
      protocol.transport !== 'ndjson-stdio' || protocol.requestSchema !== REQUEST_SCHEMA ||
      protocol.responseSchema !== RESPONSE_SCHEMA || operations.join(',') !== 'describe,run,verify' ||
      engine.engineSignature !== ENGINE_SIGNATURE || engine.loopId !== 'axm.train-platform-loop/v0.01' ||
      engine.loopVersion !== '0.08' || engine.receiptSchema !== 'axm.causal-loop.run-receipt/v0.08' ||
      JSON.stringify(engine.allowedActions) !== JSON.stringify(ALLOWED_ACTIONS) ||
      engine.maxTimedInfluences !== 64 || engine.maxWavesLimit !== 256 ||
      properties.deterministic !== true || properties.headless !== true || properties.offline !== true ||
      properties.thirdPartyDependencies !== false || authority.commitsHistory !== false ||
      authority.writesCanonicalState !== false || authority.merges !== false || authority.declaresCanon !== false) {
    throw new ProviderError('provider_incompatible', 'Provider descriptor does not match the pinned Causal Loop v1 contract.');
  }
  return capability;
}

function hold(error, configured, schema = 'axm.local-game-hub.external-capability/v1') {
  const code = error instanceof ProviderError ? error.code : 'provider_failure';
  const detail = error instanceof ProviderError ? error.message : 'Provider inspection failed.';
  return {
    schema,
    status: 'HOLD',
    configured,
    capabilityId: CAPABILITY_ID,
    error: { code, detail },
  };
}

async function inspectProvider(options = {}) {
  let config;
  try {
    config = options.config || await configuredProvider(options.env);
    const response = await invoke({ schema: REQUEST_SCHEMA, requestId: 'hub-describe-v1', op: 'describe' }, { ...options, config });
    const capability = assertDescriptor(response);
    return {
      schema: 'axm.local-game-hub.external-capability/v1',
      status: 'PASS',
      configured: true,
      capabilityId: CAPABILITY_ID,
      capability,
    };
  } catch (error) {
    return hold(error, Boolean(config || (options.env || process.env).AXM_CAUSAL_LOOP_ENTRY));
  }
}

function validateScenario(value) {
  if (!exactKeys(value, ['timedInfluences'], ['maxWaves'])) throw new ProviderError('invalid_scenario', 'Scenario must contain timedInfluences and optional maxWaves only.');
  if (!Array.isArray(value.timedInfluences) || value.timedInfluences.length > 64) {
    throw new ProviderError('invalid_scenario', 'timedInfluences must be an array of at most 64 items.');
  }
  for (const item of value.timedInfluences) {
    if (!exactKeys(item, ['atWave', 'action']) || !Number.isInteger(item.atWave) || item.atWave < 0 || item.atWave >= 256 || !ALLOWED_ACTIONS.includes(item.action)) {
      throw new ProviderError('invalid_scenario', 'Each influence must contain a valid atWave and allowed action.');
    }
  }
  const maxWaves = value.maxWaves === undefined ? 64 : value.maxWaves;
  if (!Number.isInteger(maxWaves) || maxWaves < 1 || maxWaves > 256) throw new ProviderError('invalid_scenario', 'maxWaves must be an integer from 1 through 256.');
  return { timedInfluences: value.timedInfluences, maxWaves };
}

function requestStem(scenario) {
  return crypto.createHash('sha256').update(JSON.stringify(scenario)).digest('hex').slice(0, 20);
}

async function runVerifiedScenario(value, options = {}) {
  let config;
  try {
    const scenario = validateScenario(value);
    config = options.config || await configuredProvider(options.env);
    const described = await invoke({ schema: REQUEST_SCHEMA, requestId: 'hub-describe-v1', op: 'describe' }, { ...options, config });
    const capability = assertDescriptor(described);
    const stem = requestStem(scenario);
    const run = await invoke({ schema: REQUEST_SCHEMA, requestId: `hub-run-${stem}`, op: 'run', ...scenario }, { ...options, config });
    if (!run.receipt || !run.receiptHash || !run.inputHash) throw new ProviderError('provider_run_incomplete', 'Provider run did not return a complete receipt.');
    const verification = await invoke({ schema: REQUEST_SCHEMA, requestId: `hub-verify-${stem}`, op: 'verify', receipt: run.receipt, maxWaves: scenario.maxWaves }, { ...options, config });
    const verified = verification.status === 'PASS' && verification.replayMatches === true &&
      verification.verifiedReceiptHash === run.receiptHash && verification.replayedReceiptHash === run.receiptHash;
    if (!verified) throw new ProviderError('provider_verification_mismatch', 'Provider could not reproduce the returned run receipt.');
    return {
      schema: 'axm.local-game-hub.causal-loop-result/v1',
      status: run.status === 'PASS' ? 'PASS' : 'HOLD',
      capability: {
        capabilityId: capability.capabilityId,
        repository: capability.provider.repository,
        engineSignature: capability.engine.engineSignature,
      },
      scenario,
      inputHash: run.inputHash,
      receiptHash: run.receiptHash,
      run,
      verification,
      authority: capability.authority,
    };
  } catch (error) {
    return hold(error, Boolean(config || (options.env || process.env).AXM_CAUSAL_LOOP_ENTRY), 'axm.local-game-hub.causal-loop-result/v1');
  }
}

module.exports = {
  ALLOWED_ACTIONS,
  CAPABILITY_ID,
  ENGINE_SIGNATURE,
  ProviderError,
  configuredProvider,
  inspectProvider,
  invoke,
  runVerifiedScenario,
  validateScenario,
};
