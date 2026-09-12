'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECKPOINT_SCHEMA = 'axm.pulse-choir-checkpoint/v2';
const LEGACY_CHECKPOINT_SCHEMA = 'axm.pulse-choir-checkpoint/v1';
const STATE_SCHEMA = 'axm.pulse-choir-state/v1';
const SHOW_SCHEMA = 'axm.pulse-choir-show-arc/v1';
const GAME_ID = '012-pulse-choir';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SAVE_INTERVAL_MS = 500;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const VALID_PHASES = new Set(['lobby', 'countdown', 'playing', 'results']);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const V2_FIELDS = ['checkpointDigest', 'gameId', 'roster', 'rosterFingerprint', 'savedAt', 'schema', 'sessionId', 'state', 'stateDigest'].sort();

function finite(value) {
  return Number.isFinite(Number(value));
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value, seen) {
  const active = seen || new Set();
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('checkpoint-non-json-value');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('checkpoint-non-json-value');
  if (active.has(value)) throw new Error('checkpoint-cyclic-value');
  active.add(value);
  let result;
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    if (names.some(name => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) throw new Error('checkpoint-array-shape');
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error('checkpoint-sparse-array');
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('checkpoint-active-value');
    }
    result = '[' + value.map(item => canonicalJson(item, active)).join(',') + ']';
  } else {
    if (!plainRecord(value)) throw new Error('checkpoint-object-shape');
    const ownNames = Object.getOwnPropertyNames(value);
    const enumerableNames = Object.keys(value);
    if (ownNames.length !== enumerableNames.length) throw new Error('checkpoint-hidden-value');
    const keys = enumerableNames.sort();
    result = '{' + keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('checkpoint-active-value');
      return JSON.stringify(key) + ':' + canonicalJson(descriptor.value, active);
    }).join(',') + '}';
  }
  active.delete(value);
  return result;
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function rawDigest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileDigest(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function exactFields(value, expected) {
  return plainRecord(value) && Object.keys(value).sort().join('\n') === expected.join('\n');
}

function rosterShape(roster) {
  return (Array.isArray(roster) ? roster : []).map(seat => ({
    id: String(seat.id || ''),
    slot: Number(seat.slot || 0),
    seatId: String(seat.seatId || seat.seat_id || ''),
    name: String(seat.name || seat.display_name || ''),
    type: seat.type === 'ai' ? 'ai' : 'human'
  })).sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
}

function rosterFingerprint(roster) {
  return digest(rosterShape(roster));
}

function rosterFromState(state) {
  if (!state || !state.players || typeof state.players !== 'object') return [];
  return Object.values(state.players).map(player => ({
    id: player.id,
    slot: Number(String(player.id || '').replace(/\D/g, '')),
    seatId: player.seatId,
    name: player.name,
    type: player.type
  }));
}

function validateState(state, expectedFingerprint) {
  if (!plainRecord(state)) return 'state-not-object';
  if (state.schema !== STATE_SCHEMA || state.gameId !== GAME_ID) return 'state-schema';
  if (!VALID_PHASES.has(state.phase)) return 'state-phase';
  if (!finite(state.clockMs) || !finite(state.revision) || Number(state.revision) < 0) return 'state-clock';
  if (!plainRecord(state.players)) return 'state-players';
  const players = Object.values(state.players);
  if (!players.length || players.length > 4) return 'state-player-count';
  if (players.some(player => !plainRecord(player) || !player.id || !finite(player.lastSequence))) return 'state-player-shape';
  if (rosterFingerprint(rosterFromState(state)) !== expectedFingerprint) return 'roster-mismatch';
  if (!plainRecord(state.show) || state.show.schema !== SHOW_SCHEMA || !Array.isArray(state.show.history) || state.show.history.length > 6) return 'state-show';
  if (!plainRecord(state.setlist) || state.setlist.schema !== 'axm.pulse-choir-live-setlist/v1' || !Array.isArray(state.setlist.acts)) return 'state-setlist';
  if (!Array.isArray(state.beats) || !Array.isArray(state.events) || !Array.isArray(state.inputLedger) || !Array.isArray(state.pulseLedger)) return 'state-lists';
  try { canonicalJson(state); } catch (error) { return error.message; }
  return null;
}

function shiftDeadline(value, delta) {
  return finite(value) && Number(value) > 0 ? Number(value) + delta : value;
}

function restoreState(state, now) {
  const restored = JSON.parse(canonicalJson(state));
  const previousClock = Number(restored.clockMs || now);
  const delta = Math.max(0, Number(now) - previousClock);
  restored.phaseEndsAt = shiftDeadline(restored.phaseEndsAt, delta);
  restored.roundEndsAt = shiftDeadline(restored.roundEndsAt, delta);
  restored.nextGlitchAt = shiftDeadline(restored.nextGlitchAt, delta);
  if (restored.harmony) restored.harmony.expiresAt = shiftDeadline(restored.harmony.expiresAt, delta);
  if (restored.core) restored.core.glowUntil = shiftDeadline(restored.core.glowUntil, delta);
  Object.values(restored.players || {}).forEach(player => {
    player.input = { x: 0, y: 0, expiresAt: 0 };
    player.vx = 0;
    player.vy = 0;
    player.pulseBufferedUntil = 0;
    player.stunnedUntil = shiftDeadline(player.stunnedUntil, delta);
    if (player.ai) player.ai.nextDecisionAt = shiftDeadline(player.ai.nextDecisionAt, delta);
  });
  if (restored.sync) {
    restored.sync.openedAt = shiftDeadline(restored.sync.openedAt, delta);
    restored.sync.endsAt = shiftDeadline(restored.sync.endsAt, delta);
    if (Array.isArray(restored.sync.pulses)) restored.sync.pulses.forEach(pulse => { pulse.at = shiftDeadline(pulse.at, delta); });
  }
  if (restored.glitch) {
    restored.glitch.warningUntil = shiftDeadline(restored.glitch.warningUntil, delta);
    restored.glitch.activeUntil = shiftDeadline(restored.glitch.activeUntil, delta);
  }
  if (restored.setlist) {
    restored.setlist.advanceAt = shiftDeadline(restored.setlist.advanceAt, delta);
    (restored.setlist.acts || []).forEach(act => {
      if (act.status === 'active') {
        act.startedAt = shiftDeadline(act.startedAt, delta);
        act.endsAt = shiftDeadline(act.endsAt, delta);
      }
    });
  }
  restored.clockMs = Number(now);
  if (restored.phase === 'playing' && finite(restored.roundEndsAt)) restored.timeLeftMs = Math.max(0, Number(restored.roundEndsAt) - Number(now));
  return restored;
}

function parsePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envelopeBody(envelope) {
  const body = Object.assign({}, envelope);
  delete body.checkpointDigest;
  return body;
}

function createCheckpointStore(options) {
  const settings = options || {};
  const env = settings.env || process.env;
  const clock = typeof settings.clock === 'function' ? settings.clock : () => Date.now();
  const fingerprint = rosterFingerprint(settings.roster || []);
  const disabled = settings.disabled === true || /^(?:0|false|off)$/i.test(String(env.PULSE_CHOIR_CHECKPOINT || ''));
  const ttlMs = parsePositive(settings.ttlMs === undefined ? env.PULSE_CHOIR_RECOVERY_TTL_MS : settings.ttlMs, DEFAULT_TTL_MS);
  const saveIntervalMs = parsePositive(settings.saveIntervalMs === undefined ? env.PULSE_CHOIR_SAVE_INTERVAL_MS : settings.saveIntervalMs, DEFAULT_SAVE_INTERVAL_MS);
  const filePath = path.resolve(String(settings.filePath || env.PULSE_CHOIR_STATE_FILE || path.join(env.PULSE_CHOIR_DATA_DIR || path.join(os.tmpdir(), 'axm-pulse-choir'), 'show-' + fingerprint.slice(0, 16) + '.json')));
  const publicState = {
    schema: CHECKPOINT_SCHEMA,
    status: disabled ? 'disabled' : 'fresh',
    verified: false,
    writesBlocked: false,
    restoredAt: null,
    sourceSavedAt: null,
    sourceAgeMs: null,
    sourceSchema: null,
    heldDigest: null,
    quarantineRef: null,
    lastSavedAt: null,
    lastError: null
  };
  let lastSaveAttemptAt = -Infinity;
  let held = false;

  function info() {
    return Object.assign({}, publicState);
  }

  function hold(raw, error, corrupt) {
    held = true;
    publicState.status = corrupt ? 'held-corrupt' : 'held-invalid';
    publicState.verified = false;
    publicState.writesBlocked = true;
    try { publicState.heldDigest = raw ? rawDigest(raw) : fileDigest(filePath); }
    catch (_) { publicState.heldDigest = null; }
    publicState.lastError = String(error || 'checkpoint-read-failed').slice(0, 120);
    return { state: null, recovery: info() };
  }

  function load() {
    if (disabled) return { state: null, recovery: info() };
    if (held) return { state: null, recovery: info() };
    if (!fs.existsSync(filePath)) return { state: null, recovery: info() };
    let raw;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CHECKPOINT_BYTES) throw new Error('checkpoint-size');
      raw = fs.readFileSync(filePath);
      const envelope = JSON.parse(raw.toString('utf8'));
      if (!plainRecord(envelope) || envelope.gameId !== GAME_ID) throw new Error('checkpoint-schema');
      publicState.sourceSchema = typeof envelope.schema === 'string' ? envelope.schema : null;
      if (envelope.schema === CHECKPOINT_SCHEMA) {
        if (!exactFields(envelope, V2_FIELDS)) throw new Error('checkpoint-envelope-shape');
        if (!DIGEST_PATTERN.test(envelope.stateDigest) || digest(envelope.state) !== envelope.stateDigest) throw new Error('checkpoint-state-digest');
        if (!DIGEST_PATTERN.test(envelope.checkpointDigest) || digest(envelopeBody(envelope)) !== envelope.checkpointDigest) throw new Error('checkpoint-envelope-digest');
        publicState.verified = true;
      } else if (envelope.schema !== LEGACY_CHECKPOINT_SCHEMA) {
        throw new Error('checkpoint-schema');
      }
      if (envelope.rosterFingerprint !== fingerprint) throw new Error('roster-mismatch');
      if (!finite(envelope.savedAt)) throw new Error('checkpoint-time');
      const ageMs = Number(clock()) - Number(envelope.savedAt);
      if (ageMs > ttlMs) {
        publicState.status = 'expired';
        publicState.sourceSavedAt = Number(envelope.savedAt);
        publicState.sourceAgeMs = ageMs;
        return { state: null, recovery: info() };
      }
      if (ageMs < -5 * 60 * 1000) throw new Error('checkpoint-future');
      const validation = validateState(envelope.state, fingerprint);
      if (validation) throw new Error(validation);
      const now = Number(clock());
      publicState.status = envelope.schema === LEGACY_CHECKPOINT_SCHEMA ? 'migrated-unsealed-v1' : 'restored';
      publicState.verified = envelope.schema === CHECKPOINT_SCHEMA;
      publicState.restoredAt = now;
      publicState.sourceSavedAt = Number(envelope.savedAt);
      publicState.sourceAgeMs = Math.max(0, ageMs);
      publicState.lastError = null;
      return { state: restoreState(envelope.state, now), recovery: info() };
    } catch (error) {
      return hold(raw, error && error.message, error instanceof SyntaxError);
    }
  }

  function save(state, force) {
    if (disabled || held) return false;
    const now = Number(clock());
    if (!force && now - lastSaveAttemptAt < saveIntervalMs) return false;
    lastSaveAttemptAt = now;
    const validation = validateState(state, fingerprint);
    if (validation) {
      publicState.lastError = validation;
      return false;
    }
    let serialized;
    try {
      const stateCopy = JSON.parse(canonicalJson(state));
      const envelope = {
        schema: CHECKPOINT_SCHEMA,
        gameId: GAME_ID,
        savedAt: now,
        sessionId: String(env.AXM_GAME_SESSION_ID || 'standalone').slice(0, 120),
        rosterFingerprint: fingerprint,
        roster: rosterShape(settings.roster || []),
        state: stateCopy,
        stateDigest: digest(stateCopy)
      };
      envelope.checkpointDigest = digest(envelope);
      serialized = canonicalJson(envelope);
    } catch (error) {
      publicState.lastError = String(error && error.message || 'checkpoint-encode-failed').slice(0, 120);
      return false;
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CHECKPOINT_BYTES) {
      publicState.lastError = 'checkpoint-size';
      return false;
    }
    const directory = path.dirname(filePath);
    const temporary = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    try {
      fs.mkdirSync(directory, { recursive: true });
      const descriptor = fs.openSync(temporary, 'wx');
      try {
        fs.writeFileSync(descriptor, serialized, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, filePath);
      try {
        const directoryDescriptor = fs.openSync(directory, 'r');
        try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
      } catch (_) {}
      publicState.status = 'saved';
      publicState.verified = true;
      publicState.sourceSchema = CHECKPOINT_SCHEMA;
      publicState.lastSavedAt = now;
      publicState.lastError = null;
      return true;
    } catch (error) {
      publicState.lastError = String(error && error.message || 'checkpoint-write-failed').slice(0, 120);
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
      return false;
    }
  }

  function clear() {
    if (disabled) return { cleared: false, quarantined: false, reason: 'disabled' };
    try {
      let quarantinePath = null;
      if (held) {
        const directory = path.dirname(filePath);
        fs.mkdirSync(directory, { recursive: true });
        if (!fs.existsSync(filePath)) throw new Error('checkpoint-held-source-missing');
        const rejectedDigest = fileDigest(filePath);
        quarantinePath = filePath + '.rejected-' + rejectedDigest + '.bin';
        if (fs.existsSync(quarantinePath)) {
          if (fileDigest(quarantinePath) !== rejectedDigest) throw new Error('checkpoint-quarantine-conflict');
          fs.unlinkSync(filePath);
        } else {
          fs.renameSync(filePath, quarantinePath);
        }
      } else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      const quarantined = held;
      held = false;
      publicState.status = 'fresh';
      publicState.verified = false;
      publicState.writesBlocked = false;
      publicState.restoredAt = null;
      publicState.sourceSavedAt = null;
      publicState.sourceAgeMs = null;
      publicState.sourceSchema = null;
      publicState.heldDigest = null;
      publicState.quarantineRef = quarantinePath ? path.basename(quarantinePath) : null;
      publicState.lastSavedAt = null;
      publicState.lastError = null;
      lastSaveAttemptAt = -Infinity;
      return { cleared: true, quarantined, quarantinePath };
    } catch (error) {
      publicState.lastError = String(error && error.message || 'checkpoint-clear-failed').slice(0, 120);
      return { cleared: false, quarantined: false, reason: publicState.lastError };
    }
  }

  return { clear, filePath, fingerprint, info, load, save, ttlMs };
}

module.exports = {
  CHECKPOINT_SCHEMA,
  LEGACY_CHECKPOINT_SCHEMA,
  DEFAULT_SAVE_INTERVAL_MS,
  DEFAULT_TTL_MS,
  MAX_CHECKPOINT_BYTES,
  canonicalJson,
  createCheckpointStore,
  digest,
  restoreState,
  rosterFingerprint,
  rosterShape,
  validateState
};
