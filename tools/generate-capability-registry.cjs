#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_SCHEMA = 'axm.public-capability/v1';
const RECEIPT_SCHEMA = 'axm.local-game-hub.capability-registry-receipt/v1';
const REPO_PROVIDER = 'axm-local-game-hub';
const EXPERIMENTAL_STATUS = 'EXPERIMENTAL';
const DEFAULT_OUTPUT = path.join('registry', 'capabilities.jsonl');
const DEFAULT_RECEIPT = path.join('registry', 'capabilities.receipt.json');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function readRegularFile(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, relativePath);
  if (absolute !== resolvedRoot && !absolute.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`source path escapes repository root: ${relativePath}`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`source must be a regular file: ${relativePath}`);
  }
  const bytes = fs.readFileSync(absolute);
  return { absolute, bytes, sha256: sha256(bytes) };
}

function readJsonSource(root, relativePath) {
  const source = readRegularFile(root, relativePath);
  let value;
  try {
    value = JSON.parse(source.bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
  return { ...source, value, canonicalSha256: sha256(Buffer.from(canonical(value), 'utf8')) };
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value;
}

function normalizeProviders(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function capabilityRow(id, providers, consumers, evidenceIds) {
  requireString(id, 'capability id');
  const providerList = normalizeProviders(providers);
  const consumerList = normalizeProviders(consumers);
  return {
    schema: REGISTRY_SCHEMA,
    id,
    providers: providerList,
    consumers: consumerList,
    provider_statuses: providerList.map(provider => ({ id: provider, status: EXPERIMENTAL_STATUS })),
    source_evidence: normalizeProviders(evidenceIds),
    truth: {
      declaration_is_runtime_proof: false,
      generated_from_repo_state: true,
      grants_authority: false,
    },
  };
}

function addProvider(map, id, provider, evidenceId) {
  if (!map.has(id)) map.set(id, { providers: new Set(), consumers: new Set(), evidence: new Set() });
  const row = map.get(id);
  row.providers.add(provider);
  row.evidence.add(evidenceId);
}

function addConsumer(map, id, consumer, evidenceId) {
  if (!map.has(id)) map.set(id, { providers: new Set(), consumers: new Set(), evidence: new Set() });
  const row = map.get(id);
  row.consumers.add(consumer);
  row.evidence.add(evidenceId);
}

function validateCatalog(catalog) {
  assertPlainObject(catalog, 'catalog');
  if (catalog.schema !== 'axm.local-game-catalog/v1') throw new Error(`unsupported catalog schema: ${catalog.schema}`);
  const distribution = assertPlainObject(catalog.distribution, 'catalog.distribution');
  if (requireString(distribution.id, 'catalog.distribution.id') !== REPO_PROVIDER) {
    throw new Error(`unexpected distribution id: ${distribution.id}`);
  }
  requireString(distribution.name, 'catalog.distribution.name');
  requireString(distribution.version, 'catalog.distribution.version');
  requireString(distribution.status, 'catalog.distribution.status');
  const policy = assertPlainObject(catalog.policy, 'catalog.policy');
  requireBoolean(policy.internetRequired, 'catalog.policy.internetRequired');
  requireBoolean(policy.accountRequired, 'catalog.policy.accountRequired');
  requireBoolean(policy.telemetry, 'catalog.policy.telemetry');
  requireSafeInteger(policy.activeGameLimit, 'catalog.policy.activeGameLimit');
  requireBoolean(policy.qrControllers, 'catalog.policy.qrControllers');
  if (!Array.isArray(catalog.games) || catalog.games.length === 0) throw new Error('catalog.games must be a non-empty array');
  return { distribution, policy, games: catalog.games };
}

function validateGameBinding(catalogGame, manifest, manifestPath) {
  assertPlainObject(catalogGame, 'catalog game');
  assertPlainObject(manifest, manifestPath);
  const id = requireString(catalogGame.id, 'catalog game id');
  if (!/^\d{3}-[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`unsafe game id: ${id}`);
  const checks = [
    ['game_id', id, manifest.game_id],
    ['slot', catalogGame.slot, manifest.slot],
    ['name', catalogGame.name, manifest.name],
    ['status', catalogGame.status, manifest.status],
    ['version', catalogGame.version, manifest.version],
    ['min_players', catalogGame.minPlayers, manifest.min_players],
    ['max_players', catalogGame.maxPlayers, manifest.max_players],
  ];
  for (const [field, expected, actual] of checks) {
    if (expected !== actual) throw new Error(`${manifestPath} ${field} does not match catalog (${JSON.stringify(actual)} != ${JSON.stringify(expected)})`);
  }
  return id;
}

function deriveRegistry(root) {
  const catalogSource = readJsonSource(root, 'catalog.json');
  const { policy, games } = validateCatalog(catalogSource.value);
  const sources = [{ id: 'catalog', path: 'catalog.json', canonical_sha256: catalogSource.canonicalSha256 }];
  const cap = new Map();

  if (policy.internetRequired === false) addProvider(cap, 'game-hub.offline-after-download', REPO_PROVIDER, 'catalog');
  if (policy.accountRequired === false) addProvider(cap, 'game-hub.accountless-runtime', REPO_PROVIDER, 'catalog');
  if (policy.qrControllers === true) addProvider(cap, 'game-hub.qr-controller-routing', REPO_PROVIDER, 'catalog');
  if (policy.activeGameLimit === 1) addProvider(cap, 'game-hub.single-active-game-launcher', REPO_PROVIDER, 'catalog');

  const seenGames = new Set();
  for (const catalogGame of games) {
    const id = requireString(catalogGame.id, 'catalog game id');
    if (!/^\d{3}-[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`unsafe game id: ${id}`);
    if (seenGames.has(id)) throw new Error(`duplicate catalog game id: ${id}`);
    seenGames.add(id);
    const manifestPath = path.posix.join('games', id, 'game.manifest.json');
    const manifestSource = readJsonSource(root, manifestPath);
    const manifest = manifestSource.value;
    validateGameBinding(catalogGame, manifest, manifestPath);
    const evidenceId = `manifest:${id}`;
    sources.push({ id: evidenceId, path: manifestPath, canonical_sha256: manifestSource.canonicalSha256 });

    const launch = assertPlainObject(manifest.launch, `${manifestPath}.launch`);
    if (launch.start_command === 'managed-by-game-hub') addProvider(cap, 'game-hub.managed-game-launch', id, evidenceId);
    if (launch.local_only_default === true) addProvider(cap, 'game-hub.local-only-default', id, evidenceId);

    const join = assertPlainObject(manifest.join, `${manifestPath}.join`);
    if (join.supports_qr === true) addProvider(cap, 'game.join.qr', id, evidenceId);
    if (join.supports_lan_link === true) addProvider(cap, 'game.join.lan-link', id, evidenceId);
    if (join.supports_room_code === true) addProvider(cap, 'game.join.room-code', id, evidenceId);

    const controls = assertPlainObject(manifest.controls, `${manifestPath}.controls`);
    const controlMap = [
      ['phone_controller', 'game.controls.phone-controller'],
      ['keyboard', 'game.controls.keyboard'],
      ['mouse', 'game.controls.mouse'],
      ['touch', 'game.controls.touch'],
      ['shared_screen', 'game.controls.shared-screen'],
      ['gamepad', 'game.controls.gamepad'],
    ];
    for (const [field, capability] of controlMap) {
      if (controls[field] === true) addProvider(cap, capability, id, evidenceId);
    }
    if (typeof controls.intent_protocol === 'string' && controls.intent_protocol.trim()) {
      addConsumer(cap, controls.intent_protocol, id, evidenceId);
    }
    if (typeof controls.adapter_observation === 'string' && controls.adapter_observation.trim()) {
      addConsumer(cap, controls.adapter_observation, id, evidenceId);
    }

    if (Array.isArray(manifest.allowed_seat_types) && manifest.allowed_seat_types.includes('adapter')) {
      addProvider(cap, 'game.seat.adapter', id, evidenceId);
    }

    const session = assertPlainObject(manifest.session, `${manifestPath}.session`);
    if (session.passes_seat_map === true) addProvider(cap, 'game.session.seat-map', id, evidenceId);
    if (session.returns_result_summary === true) addProvider(cap, 'game.session.result-summary', id, evidenceId);
    if (session.drop_in_out_later === true) addProvider(cap, 'game.session.drop-in-out', id, evidenceId);

    const rules = assertPlainObject(manifest.rules, `${manifestPath}.rules`);
    if (rules.local_authoritative_state === true) addProvider(cap, 'game.state.local-authoritative', id, evidenceId);
    if (rules.clients_send_input_intentions === true) addProvider(cap, 'game.input.intent-only-client', id, evidenceId);

    const verification = manifest.verification && manifest.verification.game_night;
    if (verification && typeof verification === 'object') {
      if (verification.disconnect_recovery === 'verified') addProvider(cap, 'game.session.disconnect-recovery', id, evidenceId);
      if (verification.adapter_state_interface === 'verified') addProvider(cap, 'game.seat.adapter-state-interface', id, evidenceId);
      if (verification.blocking_overlay_escape === 'verified') addProvider(cap, 'game.ui.blocking-overlay-escape', id, evidenceId);
    }
  }

  const rows = [...cap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => capabilityRow(id, [...value.providers], [...value.consumers], [...value.evidence]));

  const registryText = rows.map(row => canonical(row)).join('\n') + '\n';
  const sortedSources = sources.sort((a, b) => a.id.localeCompare(b.id));
  const receiptPayload = {
    schema: RECEIPT_SCHEMA,
    generator: 'tools/generate-capability-registry.cjs',
    inputs: sortedSources,
    output: {
      path: DEFAULT_OUTPUT,
      records: rows.length,
      sha256: sha256(Buffer.from(registryText, 'utf8')),
    },
    truth: {
      declarations_are_runtime_proof: false,
      grants_authority: false,
      source_is_catalog_and_game_manifests: true,
    },
  };
  const receiptText = JSON.stringify(receiptPayload, null, 2) + '\n';
  return { rows, registryText, receipt: receiptPayload, receiptText };
}

function writeOrCheck(root, check = false) {
  const result = deriveRegistry(root);
  const targets = [
    [DEFAULT_OUTPUT, result.registryText],
    [DEFAULT_RECEIPT, result.receiptText],
  ];
  const stale = [];
  for (const [relative, expected] of targets) {
    const absolute = path.join(root, relative);
    if (check) {
      const actual = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
      if (actual !== expected) stale.push(relative);
    } else {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, expected, 'utf8');
    }
  }
  if (check && stale.length) throw new Error(`stale generated registry: ${stale.join(', ')}`);
  return result;
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const unknown = argv.filter(arg => arg !== '--check');
  if (unknown.length) throw new Error(`unknown arguments: ${unknown.join(' ')}`);
  const root = path.resolve(__dirname, '..');
  const result = writeOrCheck(root, check);
  const verb = check ? 'verified' : 'wrote';
  process.stdout.write(`capability-registry: ${verb} ${result.rows.length} records, sha256:${result.receipt.output.sha256}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`capability-registry: ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  canonical,
  deriveRegistry,
  writeOrCheck,
};
