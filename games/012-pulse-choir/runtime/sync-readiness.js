(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PulseChoirSyncReadiness = api;
    api.install(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function deriveSyncReadiness(state) {
    if (!state || typeof state !== 'object' || !state.sync || typeof state.sync !== 'object') {
      return { active: false, players: [], readyCount: 0, totalCount: 0, remainingMs: 0, totalMs: 0, progress: 0, urgent: false, complete: false };
    }

    const openedAt = finite(state.sync.openedAt, NaN);
    const endsAt = finite(state.sync.endsAt, NaN);
    const clockMs = finite(state.clockMs, NaN);
    if (![openedAt, endsAt, clockMs].every(Number.isFinite) || endsAt < openedAt) {
      return { active: false, players: [], readyCount: 0, totalCount: 0, remainingMs: 0, totalMs: 0, progress: 0, urgent: false, complete: false };
    }

    const pulsed = new Set(Array.isArray(state.sync.pulses) ? state.sync.pulses.map(item => item && item.player).filter(Boolean) : []);
    const players = Object.values(state.players || {})
      .filter(player => player && typeof player.id === 'string')
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(player => ({ id: player.id, name: String(player.name || player.id).slice(0, 40), ready: pulsed.has(player.id) }));

    const totalMs = Math.max(1, endsAt - openedAt);
    const remainingMs = Math.max(0, Math.min(totalMs, endsAt - clockMs));
    const readyCount = players.filter(player => player.ready).length;
    const totalCount = players.length;
    const complete = totalCount > 0 && readyCount === totalCount;
    return {
      active: remainingMs > 0,
      players,
      readyCount,
      totalCount,
      remainingMs,
      totalMs,
      progress: Math.max(0, Math.min(1, remainingMs / totalMs)),
      urgent: remainingMs <= 700 && !complete,
      complete
    };
  }

  function secondsLabel(milliseconds) {
    return (Math.max(0, Number(milliseconds) || 0) / 1000).toFixed(1) + 's LEFT';
  }

  function ensureSurface(document) {
    const banner = document.getElementById('syncBanner');
    if (!banner) return null;
    let surface = document.getElementById('syncReadiness');
    if (surface) return surface;

    const style = document.createElement('style');
    style.id = 'syncReadinessStyle';
    style.textContent = [
      '.sync-readiness{display:grid!important;gap:6px!important;margin-top:9px!important;font:850 9px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.05em}',
      '.sync-readiness[hidden]{display:none!important}',
      '.sync-readiness-meta{display:flex;align-items:center;justify-content:center;gap:9px;margin:0!important}',
      '.sync-readiness-clock{min-width:72px;color:#fff;font-size:15px;letter-spacing:.02em;font-variant-numeric:tabular-nums}',
      '.sync-readiness-count{padding:4px 7px;border:1px solid #ffffff30;border-radius:999px;color:#d7dcff;background:#ffffff0a}',
      '.sync-readiness-roster{display:flex;justify-content:center;gap:5px;flex-wrap:wrap;margin:0!important;padding:0;list-style:none}',
      '.sync-readiness-roster li{display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border:1px solid #ffffff20;border-radius:999px;background:#040815a8;color:#adb4d5;white-space:nowrap}',
      '.sync-readiness-roster li.ready{border-color:#66f7ff70;color:#eaffff;background:#0c3440b5}',
      '.sync-readiness-roster b{color:inherit;font-size:10px}',
      '.sync-readiness-track{display:block!important;width:100%;height:4px;margin:0!important;border:0;border-radius:99px;background:#ffffff12;overflow:hidden}',
      '.sync-readiness-track>span{display:block;height:100%;width:var(--sync-left,0%);border-radius:inherit;background:linear-gradient(90deg,#ff6bc7,#ffdd69,#66f7ff);transition:width .09s linear}',
      '.sync-banner.sync-urgent{border-color:#ffdd6999;box-shadow:0 0 54px #ffdd6940,inset 0 0 25px #ff67c31c}',
      '.sync-banner.sync-complete{border-color:#a9ff6b99;box-shadow:0 0 58px #a9ff6b42,inset 0 0 25px #66f7ff18}',
      '.sync-banner.sync-complete .sync-readiness-count{border-color:#a9ff6b80;color:#e9ffd8}',
      '@media(max-width:620px){.sync-readiness{font-size:8px}.sync-readiness-roster li{padding:3px 5px}.sync-readiness-clock{font-size:13px}}',
      '@media(prefers-reduced-motion:reduce){.sync-readiness-track>span{transition:none}}'
    ].join('');
    document.head.appendChild(style);

    surface = document.createElement('section');
    surface.id = 'syncReadiness';
    surface.className = 'sync-readiness';
    surface.hidden = true;
    surface.innerHTML = '<div class="sync-readiness-meta" aria-hidden="true"><b class="sync-readiness-clock" id="syncReadinessClock">0.0s LEFT</b><span class="sync-readiness-count" id="syncReadinessCount">0 / 0 READY</span></div><ul class="sync-readiness-roster" id="syncReadinessRoster" aria-hidden="true"></ul><span class="sync-readiness-track" aria-hidden="true"><span id="syncReadinessFill"></span></span><span class="sr-only" id="syncReadinessAnnouncer" aria-live="polite"></span>';
    banner.appendChild(surface);
    return surface;
  }

  function renderReadiness(document, model, announcementState) {
    const banner = document.getElementById('syncBanner');
    const surface = ensureSurface(document);
    if (!banner || !surface) return;
    surface.hidden = !model.active;
    banner.classList.toggle('sync-urgent', Boolean(model.active && model.urgent));
    banner.classList.toggle('sync-complete', Boolean(model.active && model.complete));
    if (!model.active) return;

    const clock = document.getElementById('syncReadinessClock');
    const count = document.getElementById('syncReadinessCount');
    const roster = document.getElementById('syncReadinessRoster');
    const fill = document.getElementById('syncReadinessFill');
    const announcer = document.getElementById('syncReadinessAnnouncer');
    clock.textContent = secondsLabel(model.remainingMs);
    count.textContent = model.complete ? 'ALL ' + model.totalCount + ' READY' : model.readyCount + ' / ' + model.totalCount + ' READY';
    fill.style.setProperty('--sync-left', (model.progress * 100).toFixed(1) + '%');
    fill.style.width = (model.progress * 100).toFixed(1) + '%';
    roster.innerHTML = model.players.map(player => '<li class="' + (player.ready ? 'ready' : 'waiting') + '"><b>' + (player.ready ? '✓' : '○') + '</b><span>' + escapeHtml(player.name) + '</span></li>').join('');

    const waiting = model.players.filter(player => !player.ready).map(player => player.name);
    banner.setAttribute('aria-label', model.complete
      ? 'Synchronization window. All ' + model.totalCount + ' players ready.'
      : 'Synchronization window. ' + model.readyCount + ' of ' + model.totalCount + ' players ready. Waiting for ' + waiting.join(', ') + '.');

    const signature = model.readyCount + '/' + model.totalCount + ':' + (model.complete ? 'complete' : 'waiting');
    if (announcer && announcementState.signature !== signature) {
      announcementState.signature = signature;
      announcer.textContent = model.complete
        ? 'Perfect synchronization ready. All players joined.'
        : model.readyCount + ' of ' + model.totalCount + ' players joined the synchronization window.';
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  }

  function pathOf(input, base) {
    try {
      const raw = typeof input === 'string' ? input : input && input.url;
      return raw ? new URL(raw, base || 'http://127.0.0.1/').pathname : '';
    } catch (_) {
      return '';
    }
  }

  function install(window) {
    if (!window || !window.document || typeof window.fetch !== 'function') return false;
    if (window.__AXM_PULSE_SYNC_READINESS_INSTALLED__) return true;
    window.__AXM_PULSE_SYNC_READINESS_INSTALLED__ = true;
    const document = window.document;
    const nativeFetch = window.fetch.bind(window);
    const announcementState = { signature: '' };
    ensureSurface(document);

    window.fetch = async function () {
      const args = Array.prototype.slice.call(arguments);
      const response = await nativeFetch.apply(null, args);
      if (pathOf(args[0], window.location && window.location.href) === '/api/state' && response && typeof response.clone === 'function') {
        try {
          response.clone().json().then(packet => {
            const model = deriveSyncReadiness(packet && packet.state);
            renderReadiness(document, model, announcementState);
          }).catch(function () {});
        } catch (_) {}
      }
      return response;
    };
    return true;
  }

  return { deriveSyncReadiness, secondsLabel, renderReadiness, install };
});
