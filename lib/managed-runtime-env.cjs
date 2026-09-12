'use strict';

const POLICY = 'axm.local-game-hub.managed-runtime-env/v1';

const INHERITED_KEYS = Object.freeze([
  'PATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
]);

const MANAGED_KEYS = Object.freeze([
  'PORT',
  'HOST',
  'AXM_FOREST_HOST',
  'AXM_ROBO_PONG_HOST',
  'AXM_PLAYERS_JSON',
  'AXM_MANAGED_BY_GAME_HUB',
  'AXM_GAME_ID',
  'AXM_GAME_HUB_CALLBACK_URL',
]);

const inheritedSet = new Set(INHERITED_KEYS.map((key) => key.toUpperCase()));
const managedSet = new Set(MANAGED_KEYS);

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function buildManagedRuntimeEnv(parentEnv, managedValues) {
  assertPlainObject(parentEnv, 'parent environment');
  assertPlainObject(managedValues, 'managed runtime values');

  const env = Object.create(null);

  for (const [key, value] of Object.entries(parentEnv)) {
    if (!inheritedSet.has(String(key).toUpperCase())) continue;
    if (typeof value !== 'string') continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(managedValues)) {
    if (!managedSet.has(key)) throw new Error(`unsupported managed runtime environment key: ${key}`);
    if (typeof value !== 'string') throw new TypeError(`managed runtime environment ${key} must be a string`);
    env[key] = value;
  }

  for (const key of MANAGED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(managedValues, key)) {
      throw new Error(`missing managed runtime environment key: ${key}`);
    }
  }

  env.AXM_MANAGED_RUNTIME_ENV_POLICY = POLICY;
  return Object.freeze(env);
}

module.exports = {
  POLICY,
  INHERITED_KEYS,
  MANAGED_KEYS,
  buildManagedRuntimeEnv,
};
