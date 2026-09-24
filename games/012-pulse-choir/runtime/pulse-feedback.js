(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PulseChoirPulseFeedback = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BUFFER_WINDOW_MS = 240;

  function normalizeReason(reason) {
    return String(reason || 'not-admitted').trim().toLowerCase();
  }

  function heldReceipt(reason) {
    const normalized = normalizeReason(reason);
    const details = {
      'round-not-playing': 'ROUND NOT PLAYING · wait for the live round',
      'already-pulsed': 'ALREADY LOCKED · no second pulse admitted',
      'stale-sequence': 'STALE INPUT · controller sequence was not admitted',
      'unknown-player': 'UNKNOWN SEAT · reconnect from the shared screen'
    };
    return {
      kind: 'held',
      title: 'PULSE HELD',
      detail: details[normalized] || ('NOT ADMITTED · ' + normalized.replace(/-/g, ' ').toUpperCase()),
      aria: 'Pulse held by the server. ' + (details[normalized] || normalized.replace(/-/g, ' ')),
      vibration: [24]
    };
  }

  function lockedReceipt(hits, total) {
    const safeHits = Math.max(0, Math.floor(Number(hits) || 0));
    const safeTotal = Math.max(safeHits, Math.floor(Number(total) || 0));
    return {
      kind: 'locked',
      title: 'PULSE LOCKED',
      detail: safeTotal ? (safeHits + ' / ' + safeTotal + ' JOINED · YOU ARE IN') : 'SERVER RECEIPT · YOUR PULSE JOINED',
      aria: safeTotal
        ? ('Pulse locked. ' + safeHits + ' of ' + safeTotal + ' players joined. You are in.')
        : 'Pulse locked. The server admitted your pulse.',
      vibration: [18, 28, 35]
    };
  }

  function actionReceipt(packet, playerId) {
    if (!packet || packet.ok !== true) return heldReceipt(packet && packet.reason);
    if (packet.buffered === true) {
      return {
        kind: 'buffered',
        title: 'BUFFER ACCEPTED',
        detail: 'SERVER RECEIPT · EARLY PRESS · ' + (BUFFER_WINDOW_MS / 1000).toFixed(2) + 'S WINDOW',
        aria: 'Early pulse accepted by the server. The buffer window is ' + (BUFFER_WINDOW_MS / 1000).toFixed(2) + ' seconds.',
        vibration: [12, 28, 12]
      };
    }
    if (packet.pulsed === true) {
      const state = packet.state || {};
      const sync = state.sync || null;
      const pulses = sync && Array.isArray(sync.pulses) ? sync.pulses : [];
      const selfPresent = !sync || !playerId || pulses.some(item => item && item.player === playerId);
      const total = Object.keys(state.players || {}).length;
      if (!selfPresent) return heldReceipt('server-receipt-mismatch');
      return lockedReceipt(pulses.length || 1, total);
    }
    return null;
  }

  function observationReceipt(observation, playerId) {
    if (!observation || observation.phase !== 'playing' || !observation.sync || !observation.player) return null;
    const player = observation.player;
    if (playerId && player.id !== playerId) return null;
    if (player.pulsedSyncId !== observation.sync.id) return null;
    const pulses = Array.isArray(observation.sync.pulses) ? observation.sync.pulses : [];
    const total = (Array.isArray(observation.teammates) ? observation.teammates.length : 0) + 1;
    return lockedReceipt(pulses.length, total);
  }

  return {
    BUFFER_WINDOW_MS,
    actionReceipt,
    heldReceipt,
    observationReceipt
  };
});
