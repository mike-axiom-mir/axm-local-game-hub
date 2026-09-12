'use strict';

const fs = require('fs');
const path = require('path');

const CATALOG_SCHEMA = 'axm.local-game-catalog/v1';
const ID_PATTERN = /^\d{3}-[a-z0-9][a-z0-9-]*$/;

function fail(message) {
  throw new Error('catalog contract: ' + message);
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(label + ' is unreadable: ' + error.message);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(label + ' is invalid JSON: ' + error.message);
  }
}

function same(actual, expected, label) {
  if (actual !== expected) {
    fail(label + ' drifted (catalog=' + JSON.stringify(actual) + ', manifest=' + JSON.stringify(expected) + ')');
  }
}

function manifestProjection(manifest) {
  return {
    id: manifest.game_id,
    slot: manifest.slot,
    name: manifest.name,
    status: manifest.status,
    version: manifest.version,
    description: manifest.description,
    minPlayers: manifest.min_players,
    maxPlayers: manifest.max_players,
    phoneControllers: manifest.controls && manifest.controls.phone_controller,
    touch: manifest.controls && manifest.controls.touch,
    keyboard: manifest.controls && manifest.controls.keyboard,
    sharedScreen: manifest.controls && manifest.controls.shared_screen,
    serverEntry: manifest.launch && manifest.launch.server_entry,
    readyPath: manifest.launch && manifest.launch.ready_path
  };
}

function discoverManifestIds(root) {
  const gamesRoot = path.join(root, 'games');
  if (!fs.existsSync(gamesRoot)) fail('games directory is missing');
  return fs.readdirSync(gamesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(id => fs.existsSync(path.join(gamesRoot, id, 'game.manifest.json')))
    .sort();
}

function validateCatalog(catalog, root) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) fail('catalog root must be an object');
  if (catalog.schema !== CATALOG_SCHEMA) fail('unsupported schema ' + JSON.stringify(catalog.schema));
  if (!Array.isArray(catalog.games)) fail('games must be an array');

  const seenIds = new Set();
  const seenSlots = new Set();
  const seenOffsets = new Set();
  const projectedIds = [];

  for (const game of catalog.games) {
    if (!game || typeof game !== 'object' || Array.isArray(game)) fail('every game entry must be an object');
    if (typeof game.id !== 'string' || !ID_PATTERN.test(game.id)) fail('unsafe or invalid game id ' + JSON.stringify(game.id));
    if (seenIds.has(game.id)) fail('duplicate game id ' + game.id);
    seenIds.add(game.id);
    projectedIds.push(game.id);

    if (typeof game.slot !== 'string' || !/^\d{3}$/.test(game.slot)) fail(game.id + ' has invalid slot');
    if (seenSlots.has(game.slot)) fail('duplicate slot ' + game.slot);
    seenSlots.add(game.slot);

    if (!Number.isInteger(game.portOffset) || game.portOffset < 0) fail(game.id + ' has invalid portOffset');
    if (seenOffsets.has(game.portOffset)) fail('duplicate portOffset ' + game.portOffset);
    seenOffsets.add(game.portOffset);

    if (!Number.isInteger(game.defaultHumanSeats) || game.defaultHumanSeats < game.minPlayers || game.defaultHumanSeats > game.maxPlayers) {
      fail(game.id + ' defaultHumanSeats is outside the declared player range');
    }

    const gameRoot = path.resolve(root, 'games', game.id);
    const gamesRoot = path.resolve(root, 'games');
    if (!gameRoot.startsWith(gamesRoot + path.sep)) fail(game.id + ' escapes the games root');
    const manifestPath = path.join(gameRoot, 'game.manifest.json');
    const manifest = readJson(manifestPath, game.id + ' manifest');
    const expected = manifestProjection(manifest);

    for (const key of Object.keys(expected)) same(game[key], expected[key], game.id + '.' + key);

    const serverEntry = path.resolve(gameRoot, String(game.serverEntry || ''));
    if (!serverEntry.startsWith(gameRoot + path.sep) || !/\.(?:c?js|mjs)$/i.test(serverEntry) || !fs.existsSync(serverEntry)) {
      fail(game.id + ' serverEntry is missing or unsafe');
    }
  }

  const manifestIds = discoverManifestIds(root);
  projectedIds.sort();
  if (JSON.stringify(projectedIds) !== JSON.stringify(manifestIds)) {
    fail('catalog membership drifted (catalog=' + projectedIds.join(',') + ', manifests=' + manifestIds.join(',') + ')');
  }
  return catalog;
}

function loadValidatedCatalog(root) {
  const resolvedRoot = path.resolve(root);
  const catalog = readJson(path.join(resolvedRoot, 'catalog.json'), 'catalog.json');
  return validateCatalog(catalog, resolvedRoot);
}

module.exports = { CATALOG_SCHEMA, discoverManifestIds, loadValidatedCatalog, manifestProjection, validateCatalog };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const catalog = loadValidatedCatalog(root);
  process.stdout.write(JSON.stringify({
    ok: true,
    schema: 'axm.local-game-catalog-contract-check/v1',
    catalogSchema: catalog.schema,
    games: catalog.games.map(game => game.id)
  }, null, 2) + '\n');
}
