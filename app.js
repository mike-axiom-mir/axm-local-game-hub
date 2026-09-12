(function () {
  'use strict';

  var state = { catalog: null, health: null, active: null };
  var $ = function (id) { return document.getElementById(id); };
  var hostNavigation = { index: 0, gamepadLatched: false, gamepadConnected: false };

  function toast(message) {
    var box = $('toast');
    box.textContent = message;
    box.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { box.classList.remove('show'); }, 3200);
  }

  async function call(route, body) {
    var response = await fetch(route, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    var value = await response.json();
    if (!response.ok || value.ok === false) throw new Error(value.error || ('HTTP ' + response.status));
    return value;
  }

  function qr(target, url) {
    target.textContent = '';
    if (!url || typeof window.qrcode !== 'function') {
      var fallback = document.createElement('span');
      fallback.textContent = 'QR unavailable';
      target.appendChild(fallback);
      return;
    }
    try {
      var code = window.qrcode(0, 'M');
      code.addData(url);
      code.make();
      var image = document.createElement('img');
      image.alt = 'QR code for ' + url;
      image.src = code.createDataURL(5, 3);
      target.appendChild(image);
    } catch (_) {
      var error = document.createElement('span');
      error.textContent = 'QR failed';
      target.appendChild(error);
    }
  }

  function tag(text) {
    var span = document.createElement('span');
    span.textContent = text;
    return span;
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function ensureHostNavigator() {
    if ($('hostNavigator')) return;
    var shelf = $('games');
    if (!shelf) return;

    var style = document.createElement('style');
    style.textContent = [
      '.host-navigator{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:-.35rem 0 1rem;padding:.7rem .85rem;border:1px solid var(--line);border-radius:.8rem;background:rgba(7,17,31,.72);color:var(--muted);font:700 .58rem/1.45 ui-monospace,monospace}',
      '.host-navigator b{color:var(--text);letter-spacing:.05em}.host-nav-keys{display:flex;align-items:center;gap:.38rem;flex-wrap:wrap}.host-nav-key{padding:.25rem .42rem;border:1px solid var(--line2);border-radius:.38rem;background:rgba(111,228,239,.06);color:var(--cyan)}',
      '.host-runtime-state{white-space:nowrap;color:var(--mint)}.host-runtime-state[data-state="ended"]{color:var(--danger)}',
      '.game-card{position:relative;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}',
      '.game-card.is-nav-focus{border-color:var(--cyan);box-shadow:0 0 0 2px rgba(111,228,239,.17),0 22px 60px rgba(0,0,0,.25);transform:translateY(-2px)}',
      '.game-card.is-running{border-color:rgba(131,236,192,.62);box-shadow:0 0 0 1px rgba(131,236,192,.16),0 22px 60px rgba(0,0,0,.24)}',
      '.running-status{position:absolute;top:.85rem;right:.85rem;padding:.3rem .45rem;border:1px solid rgba(131,236,192,.38);border-radius:999px;background:rgba(31,91,73,.18);color:var(--mint);font:800 .5rem/1 ui-monospace,monospace;letter-spacing:.08em}',
      '.start-game:focus-visible,.button:focus-visible,.controller-card a:focus-visible,.join-card a:focus-visible{outline:3px solid rgba(111,228,239,.72);outline-offset:3px}',
      '@media(max-width:620px){.host-navigator{align-items:flex-start;flex-direction:column}.host-runtime-state{white-space:normal}}',
      '@media(prefers-reduced-motion:reduce){.game-card{transition:none}.game-card.is-nav-focus{transform:none}}'
    ].join('');
    document.head.appendChild(style);

    var navigator = document.createElement('div');
    navigator.className = 'host-navigator';
    navigator.id = 'hostNavigator';
    navigator.setAttribute('aria-label', 'Host game selection controls');
    navigator.innerHTML = '<div><b>HOST CONTROLS</b> · focus a game, then <span class="host-nav-keys"><span class="host-nav-key">ARROWS</span><span>move</span><span class="host-nav-key">ENTER</span><span>start</span><span class="host-nav-key">GAMEPAD</span><span>D-PAD + A</span></span></div><span class="host-runtime-state" id="hostRuntimeState" data-state="idle">READY · CHOOSE A GAME</span><span class="sr-host-status" id="hostNavStatus" role="status" aria-live="polite" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0"></span>';
    var grid = $('gameGrid');
    shelf.insertBefore(navigator, grid);
  }

  function startButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('.start-game'));
  }

  function announceHost(message) {
    if ($('hostNavStatus')) $('hostNavStatus').textContent = message;
  }

  function setHostFocus(index, source) {
    var buttons = startButtons();
    if (!buttons.length) return;
    hostNavigation.index = Math.max(0, Math.min(buttons.length - 1, index));
    buttons.forEach(function (button, buttonIndex) {
      var card = button.closest ? button.closest('.game-card') : button.parentNode;
      if (card) card.classList.toggle('is-nav-focus', buttonIndex === hostNavigation.index);
    });
    var chosen = buttons[hostNavigation.index];
    chosen.focus({ preventScroll: true });
    if (source === 'gamepad') chosen.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    announceHost('Selected ' + (chosen.dataset.gameName || chosen.textContent) + '. Press Enter or gamepad A to start.');
  }

  function directionalIndex(currentIndex, direction) {
    var buttons = startButtons();
    if (!buttons.length) return currentIndex;
    var current = buttons[currentIndex] || buttons[0];
    var currentRect = current.getBoundingClientRect();
    var cx = currentRect.left + currentRect.width / 2;
    var cy = currentRect.top + currentRect.height / 2;
    var bestIndex = currentIndex;
    var bestScore = Infinity;

    buttons.forEach(function (button, index) {
      if (index === currentIndex) return;
      var rect = button.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      var primary;
      var secondary;
      if (direction === 'left' && x < cx - 4) { primary = cx - x; secondary = Math.abs(y - cy); }
      else if (direction === 'right' && x > cx + 4) { primary = x - cx; secondary = Math.abs(y - cy); }
      else if (direction === 'up' && y < cy - 4) { primary = cy - y; secondary = Math.abs(x - cx); }
      else if (direction === 'down' && y > cy + 4) { primary = y - cy; secondary = Math.abs(x - cx); }
      else return;
      var score = primary + secondary * 2.4;
      if (score < bestScore) { bestScore = score; bestIndex = index; }
    });
    return bestIndex;
  }

  function onHostKeydown(event) {
    if (!event.target || !event.target.classList || !event.target.classList.contains('start-game')) return;
    var buttons = startButtons();
    var currentIndex = buttons.indexOf(event.target);
    if (currentIndex < 0) return;
    var nextIndex = currentIndex;
    if (event.key === 'ArrowLeft') nextIndex = directionalIndex(currentIndex, 'left');
    else if (event.key === 'ArrowRight') nextIndex = directionalIndex(currentIndex, 'right');
    else if (event.key === 'ArrowUp') nextIndex = directionalIndex(currentIndex, 'up');
    else if (event.key === 'ArrowDown') nextIndex = directionalIndex(currentIndex, 'down');
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = buttons.length - 1;
    else return;
    event.preventDefault();
    setHostFocus(nextIndex, 'keyboard');
  }

  function pollGamepads() {
    if (navigator.getGamepads) {
      var pads = Array.prototype.slice.call(navigator.getGamepads() || []).filter(Boolean);
      hostNavigation.gamepadConnected = pads.length > 0;
      if (pads.length) {
        var pad = pads[0];
        var left = pad.buttons[14] && pad.buttons[14].pressed || (pad.axes[0] || 0) < -0.65;
        var right = pad.buttons[15] && pad.buttons[15].pressed || (pad.axes[0] || 0) > 0.65;
        var up = pad.buttons[12] && pad.buttons[12].pressed || (pad.axes[1] || 0) < -0.65;
        var down = pad.buttons[13] && pad.buttons[13].pressed || (pad.axes[1] || 0) > 0.65;
        var accept = pad.buttons[0] && pad.buttons[0].pressed;
        var engaged = left || right || up || down || accept;
        if (engaged && !hostNavigation.gamepadLatched) {
          var buttons = startButtons();
          if (buttons.length) {
            if (left) setHostFocus(directionalIndex(hostNavigation.index, 'left'), 'gamepad');
            else if (right) setHostFocus(directionalIndex(hostNavigation.index, 'right'), 'gamepad');
            else if (up) setHostFocus(directionalIndex(hostNavigation.index, 'up'), 'gamepad');
            else if (down) setHostFocus(directionalIndex(hostNavigation.index, 'down'), 'gamepad');
            else if (accept) (buttons[hostNavigation.index] || buttons[0]).click();
          }
        }
        hostNavigation.gamepadLatched = engaged;
      } else {
        hostNavigation.gamepadLatched = false;
      }
    }
    window.requestAnimationFrame(pollGamepads);
  }

  function activeFingerprint(active) {
    if (!active) return 'none';
    return [active.gameId || '', active.status || '', active.startedAt || '', active.exit && active.exit.code, active.exit && active.exit.signal].join('|');
  }

  function syncActiveGame(active) {
    var ready = active && active.status === 'ready';
    document.querySelectorAll('.game-card').forEach(function (card) {
      var running = !!(ready && card.dataset.gameId === active.gameId);
      card.classList.toggle('is-running', running);
      var badge = card.querySelector('.running-status');
      if (running && !badge) {
        badge = document.createElement('span');
        badge.className = 'running-status';
        badge.textContent = 'RUNNING NOW';
        card.appendChild(badge);
      } else if (!running && badge) {
        badge.remove();
      }
      var button = card.querySelector('.start-game');
      if (button) button.textContent = running ? 'Restart ' + button.dataset.gameName : 'Start ' + button.dataset.gameName;
    });

    var status = $('hostRuntimeState');
    if (!status) return;
    if (ready) {
      status.dataset.state = 'running';
      status.textContent = 'RUNNING · ' + active.name;
    } else if (active && active.status === 'runtime-ended') {
      status.dataset.state = 'ended';
      status.textContent = 'RUNTIME ENDED · CHOOSE A GAME TO RESTART';
    } else {
      status.dataset.state = 'idle';
      status.textContent = 'READY · CHOOSE A GAME';
    }
  }

  function gameCard(game) {
    var card = document.createElement('article');
    card.className = 'game-card';
    card.dataset.gameId = game.id;
    var number = document.createElement('span');
    number.className = 'game-number';
    number.textContent = game.slot || 'GAME';
    var title = document.createElement('h3');
    title.textContent = game.name;
    var description = document.createElement('p');
    description.textContent = game.description;
    var meta = document.createElement('div');
    meta.className = 'game-meta';
    meta.appendChild(tag(game.minPlayers + '–' + game.maxPlayers + ' players'));
    meta.appendChild(tag('PHONE QR'));
    if (game.keyboard) meta.appendChild(tag('KEYBOARD'));
    if (game.sharedScreen) meta.appendChild(tag('SHARED SCREEN'));
    var status = document.createElement('p');
    status.className = 'source-status';
    status.textContent = 'SOURCE STATUS · ' + game.status;
    var start = document.createElement('button');
    start.className = 'start-game';
    start.type = 'button';
    start.dataset.gameName = game.name;
    start.textContent = 'Start ' + game.name;
    start.addEventListener('focus', function () {
      var buttons = startButtons();
      var index = buttons.indexOf(start);
      if (index >= 0) {
        hostNavigation.index = index;
        buttons.forEach(function (button, buttonIndex) {
          var candidate = button.closest ? button.closest('.game-card') : button.parentNode;
          if (candidate) candidate.classList.toggle('is-nav-focus', buttonIndex === index);
        });
      }
    });
    start.addEventListener('click', async function () {
      document.querySelectorAll('.start-game').forEach(function (button) { button.disabled = true; });
      start.textContent = 'Starting local runtime…';
      try {
        var result = await call('/api/launch', { gameId: game.id });
        renderRuntime(result.active);
        $('runtimePanel').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
        toast(game.name + ' is ready. Open the screen and scan visible seats.');
      } catch (error) {
        toast('Launch failed: ' + error.message);
      } finally {
        document.querySelectorAll('.start-game').forEach(function (button) { button.disabled = false; });
        syncActiveGame(state.active);
      }
    });
    card.append(number, title, description, meta, status, start);
    return card;
  }

  function renderCatalog(catalog) {
    state.catalog = catalog;
    var grid = $('gameGrid');
    grid.textContent = '';
    catalog.games.forEach(function (game) { grid.appendChild(gameCard(game)); });
    syncActiveGame(state.active);
  }

  function controllerCard(controller) {
    var card = document.createElement('article');
    card.className = 'controller-card';
    var qrBox = document.createElement('div');
    qrBox.className = 'qr-box';
    var chosen = state.health && state.health.lanMode && controller.lanUrl ? controller.lanUrl : controller.url;
    qr(qrBox, chosen);
    var copy = document.createElement('div');
    var title = document.createElement('b');
    title.textContent = controller.label;
    var link = document.createElement('a');
    link.href = chosen;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = chosen;
    copy.append(title, link);
    card.append(qrBox, copy);
    return card;
  }

  function renderRuntime(active) {
    state.active = active || null;
    syncActiveGame(state.active);
    var panel = $('runtimePanel');
    if (!active || active.status !== 'ready') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $('runtimeTitle').textContent = active.name + ' is ready';
    $('runtimeDescription').textContent = 'Original status: ' + active.sourceStatus + '. One managed local runtime is active.';
    var chosenPlay = state.health && state.health.lanMode && active.lanPlayUrl ? active.lanPlayUrl : active.playUrl;
    $('playGame').href = chosenPlay;
    $('controllerExplanation').textContent = state.health && state.health.lanMode
      ? 'Phones on this Wi-Fi can scan one visible seat each. The shared screen never occupies a seat.'
      : 'Local mode is active. Use START_LAN_GAME_NIGHT.cmd before scanning from phones on the same Wi-Fi.';
    var grid = $('controllerGrid');
    grid.textContent = '';
    active.controllers.forEach(function (controller) { grid.appendChild(controllerCard(controller)); });
  }

  function renderHealth(health) {
    state.health = health;
    $('hubMode').textContent = health.lanMode ? 'LAN GAME NIGHT · READY' : 'ONE-MACHINE MODE · READY';
    var address = health.lanMode && health.lanHubUrl ? health.lanHubUrl : health.hubUrl;
    $('hubAddress').href = address;
    $('hubAddress').textContent = address;
    $('joinExplanation').textContent = health.lanMode
      ? 'Phones on the same Wi-Fi can scan this door, then scan one declared player seat after the host launches a game.'
      : 'This run is limited to one computer. Restart with START_LAN_GAME_NIGHT.cmd to expose QR controls on the same Wi-Fi.';
    qr($('hubQr'), address);
    renderRuntime(health.active);
  }

  $('stopGame').addEventListener('click', async function () {
    $('stopGame').disabled = true;
    try {
      await call('/api/stop', {});
      renderRuntime(null);
      toast('The game runtime stopped. The Hub remains ready.');
    } catch (error) { toast('Stop failed: ' + error.message); }
    finally { $('stopGame').disabled = false; }
  });

  async function refreshStatus() {
    try {
      var status = await call('/api/status');
      if (activeFingerprint(state.active) !== activeFingerprint(status.active)) {
        var previous = state.active;
        renderRuntime(status.active);
        if (previous && status.active && status.active.status === 'runtime-ended') {
          toast(status.active.name + ' ended. Choose a game to restart when ready.');
        }
      }
    } catch (_) {}
  }

  async function boot() {
    ensureHostNavigator();
    document.addEventListener('keydown', onHostKeydown);
    window.addEventListener('gamepadconnected', function () {
      hostNavigation.gamepadConnected = true;
      announceHost('Gamepad connected. Use D-pad or left stick to choose a game and A to start.');
    });
    window.addEventListener('gamepaddisconnected', function () {
      hostNavigation.gamepadConnected = false;
      hostNavigation.gamepadLatched = false;
    });
    window.requestAnimationFrame(pollGamepads);
    try {
      var results = await Promise.all([call('/api/health'), call('/api/catalog')]);
      renderHealth(results[0]);
      renderCatalog(results[1]);
      setInterval(refreshStatus, 2500);
    } catch (error) {
      $('gameGrid').textContent = 'Local engine unavailable: ' + error.message;
      $('hubMode').textContent = 'LOCAL ENGINE ERROR';
      if ($('hostRuntimeState')) {
        $('hostRuntimeState').dataset.state = 'ended';
        $('hostRuntimeState').textContent = 'LOCAL ENGINE ERROR';
      }
    }
  }

  boot();
})();
