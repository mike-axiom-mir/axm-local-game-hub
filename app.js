(function () {
  'use strict';

  var state = { catalog: null, health: null, active: null };
  var $ = function (id) { return document.getElementById(id); };

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

  function gameCard(game) {
    var card = document.createElement('article');
    card.className = 'game-card';
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
    start.textContent = 'Start ' + game.name;
    start.addEventListener('click', async function () {
      document.querySelectorAll('.start-game').forEach(function (button) { button.disabled = true; });
      start.textContent = 'Starting local runtime…';
      try {
        var result = await call('/api/launch', { gameId: game.id });
        renderRuntime(result.active);
        $('runtimePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast(game.name + ' is ready. Open the screen and scan visible seats.');
      } catch (error) {
        toast('Launch failed: ' + error.message);
      } finally {
        document.querySelectorAll('.start-game').forEach(function (button) { button.disabled = false; });
        start.textContent = 'Start ' + game.name;
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
      if (!state.active && status.active) renderRuntime(status.active);
      if (state.active && !status.active) renderRuntime(null);
    } catch (_) {}
  }

  async function boot() {
    try {
      var results = await Promise.all([call('/api/health'), call('/api/catalog')]);
      renderHealth(results[0]);
      renderCatalog(results[1]);
      setInterval(refreshStatus, 2500);
    } catch (error) {
      $('gameGrid').textContent = 'Local engine unavailable: ' + error.message;
      $('hubMode').textContent = 'LOCAL ENGINE ERROR';
    }
  }

  boot();
})();

