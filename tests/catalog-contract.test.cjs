'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { loadValidatedCatalog } = require('../lib/catalog-contract.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

function copyContractFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axm-game-catalog-'));
  const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'catalog.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

  for (const game of catalog.games) {
    const sourceRoot = path.join(REPO_ROOT, 'games', game.id);
    const targetRoot = path.join(root, 'games', game.id);
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, 'game.manifest.json'), path.join(targetRoot, 'game.manifest.json'));
    const targetEntry = path.join(targetRoot, game.serverEntry);
    fs.mkdirSync(path.dirname(targetEntry), { recursive: true });
    fs.writeFileSync(targetEntry, '// contract fixture\n');
  }
  return root;
}

function editJson(file, mutate) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(value);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

test('current assembled catalog agrees with every game manifest', () => {
  const catalog = loadValidatedCatalog(REPO_ROOT);
  assert.equal(catalog.games.length, 4);
});

test('shared catalog fields cannot drift from the canonical game manifest', () => {
  const root = copyContractFixture();
  editJson(path.join(root, 'catalog.json'), catalog => { catalog.games[0].name = 'Drifted title'; });
  assert.throws(() => loadValidatedCatalog(root), /002-robo-pong\.name drifted/);
});

test('a manifest cannot exist without a catalog projection', () => {
  const root = copyContractFixture();
  editJson(path.join(root, 'catalog.json'), catalog => { catalog.games.pop(); });
  assert.throws(() => loadValidatedCatalog(root), /catalog membership drifted/);
});

test('duplicate runtime port offsets fail closed', () => {
  const root = copyContractFixture();
  editJson(path.join(root, 'catalog.json'), catalog => { catalog.games[1].portOffset = catalog.games[0].portOffset; });
  assert.throws(() => loadValidatedCatalog(root), /duplicate portOffset/);
});
