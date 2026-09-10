#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { buildManagedRuntimeEnv } = require('./lib/managed-runtime-env.cjs');

const ROOT = __dirname;
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const LAN_MODE = process.argv.includes('--lan') || process.env.AXM_GAME_HUB_LAN === '1';
const HOST = LAN_MODE ? '0.0.0.0' : '127.0.0.1';
const HUB_PORT = Number(process.env.AXM_GAME_HUB_PORT || 8890);
const GAME_PORT_BASE = Number(process.env.AXM_GAME_PORT_BASE || 8900);
const OPEN_BROWSER = process.argv.includes('--open') && process.env.AXM_GAME_HUB_NO_OPEN !== '1';
const MAX_BODY_BYTES = 12 * 1024;
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

let active = null;
let shuttingDown = false;

function privateLanAddress() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (/virtual|vethernet|wsl|loopback/i.test(name)) continue;
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal || address.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: address.address });
    }
  }
  candidates.sort((a, b) => {
    const rank = value => /wi-?fi|wireless|wlan/i.test(value.name) ? 0 : /ethernet/i.test(value.name) ? 1 : 2;
    return rank(a) - rank(b);
  });
  return candidates.length ? candidates[0].address : null;
}

function json(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (_) { reject(new Error('invalid JSON')); }
    });
    request.on('error', reject);
  });
}

function containedGameEntry(game) {
  const gameRoot = path.resolve(ROOT, 'games', game.id);
  const entry = path.resolve(gameRoot, game.serverEntry);
  if (!entry.startsWith(gameRoot + path.sep) || !/\.(?:c?js|mjs)$/i.test(entry) || !fs.existsSync(entry)) {
    throw new Error('declared game server is missing or unsafe');
  }
  return entry;
}

function roster(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: 'p' + (index + 1),
    seatId: 'seat_' + (index + 1),
    seat_id: 'seat_' + (index + 1),
    slot: index + 1,
    name: 'Player ' + (index + 1),
    display_name: 'Player ' + (index + 1),
    type: 'human'
  }));
}

function runtimeGet(port, requestPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath || '/', timeout: timeoutMs || 700 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    request.on('timeout', () => request.destroy(new Error('runtime request timed out')));
    request.on('error', reject);
  });
}

async function waitForRuntime(port, requestPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await runtimeGet(port, requestPath, 600);
      if (response.status >= 200 && response.status < 500) return response;
      lastError = new Error('runtime returned HTTP ' + response.status);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError || new Error('game runtime did not become ready');
}

async function launcherState(port) {
  try {
    const response = await runtimeGet(port, '/api/launcher-state', 800);
    if (response.status !== 200) return null;
    return JSON.parse(response.body);
  } catch (_) { return null; }
}

function runtimeUrl(host, port, requestPath) {
  const route = String(requestPath || '/').startsWith('/') ? String(requestPath || '/') : '/' + requestPath;
  return 'http://' + host + ':' + port + route;
}

function playerPath(template, index) {
  return String(template || '/').replace(/\{player\}/g, 'p' + (index + 1));
}

function activeView() {
  if (!active) return null;
  return {
    gameId: active.game.id,
    name: active.game.name,
    status: active.status,
    sourceStatus: active.game.status,
    port: active.port,
    playUrl: active.playUrl || null,
    lanPlayUrl: active.lanPlayUrl || null,
    controllers: active.controllers || [],
    startedAt: active.startedAt,
    exit: active.exit || null,
    diagnostic: active.diagnostic || null
  };
}

async function stopActive(reason) {
  if (!active) return null;
  const current = active;
  active = null;
  if (current.child && current.child.exitCode === null && !current.child.killed) {
    current.child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => current.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 900))
    ]);
    if (current.child.exitCode === null && !current.child.killed) current.child.kill('SIGKILL');
  }
  return { gameId: current.game.id, reason: reason || 'host-stop' };
}

async function startGame(gameId) {
  const game = CATALOG.games.find(item => item.id === String(gameId || ''));
  if (!game) throw new Error('unknown game package');
  await stopActive('next-game-selected');
  const port = GAME_PORT_BASE + Number(game.portOffset || 0);
  const entry = containedGameEntry(game);
  const players = roster(game.defaultHumanSeats);
  const logTail = [];
  const child = childProcess.spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    env: buildManagedRuntimeEnv(process.env, {
      PORT: String(port),
      HOST,
      AXM_FOREST_HOST: HOST,
      AXM_ROBO_PONG_HOST: HOST,
      AXM_PLAYERS_JSON: JSON.stringify(players),
      AXM_MANAGED_BY_GAME_HUB: '1',
      AXM_GAME_ID: game.id,
      AXM_GAME_HUB_CALLBACK_URL: 'http://127.0.0.1:' + HUB_PORT
    }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const capture = chunk => {
    logTail.push(String(chunk).replace(/[\r\n]+/g, ' ').slice(0, 500));
    while (logTail.length > 8) logTail.shift();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  active = { game, child, port, status: 'starting', startedAt: Date.now(), controllers: [] };
  child.once('exit', (code, signal) => {
    if (!active || active.child !== child) return;
    active.status = code === 0 && shuttingDown ? 'stopped' : 'runtime-ended';
    active.exit = { code, signal: signal || null };
    active.diagnostic = logTail.join(' | ').slice(0, 1600) || null;
  });
  try {
    await waitForRuntime(port, game.readyPath);
    if (!active || active.child !== child || child.exitCode !== null) throw new Error('game runtime ended during launch');
    const metadata = await launcherState(port);
    const lanAddress = LAN_MODE ? privateLanAddress() : null;
    const playPath = game.playPath || metadata && metadata.partyScreenLinks && metadata.partyScreenLinks.all || '/';
    active.playUrl = runtimeUrl('127.0.0.1', port, playPath);
    active.lanPlayUrl = lanAddress ? runtimeUrl(lanAddress, port, playPath) : null;
    const metadataLinks = metadata && Array.isArray(metadata.controllerLinks) ? metadata.controllerLinks : [];
    active.controllers = players.map((player, index) => {
      const found = metadataLinks.find(link => link.player === player.id || link.seatId === player.seatId || link.seatId === player.seat_id);
      const route = found && (found.localPath || found.url) || playerPath(game.controllerPath, index);
      return {
        seat: player.seatId,
        player: player.id,
        label: 'Player ' + (index + 1),
        url: runtimeUrl('127.0.0.1', port, route),
        lanUrl: lanAddress ? runtimeUrl(lanAddress, port, route) : null
      };
    });
    active.status = 'ready';
    return activeView();
  } catch (error) {
    const diagnostic = logTail.join(' | ').slice(0, 1600);
    await stopActive('launch-failed');
    throw new Error(error.message + (diagnostic ? ' · ' + diagnostic : ''));
  }
}

function hubInfo() {
  const lanAddress = LAN_MODE ? privateLanAddress() : null;
  return {
    ok: true,
    schema: 'axm.local-game-hub-health/v1',
    status: 'EXPERIMENTAL',
    distribution: CATALOG.distribution,
    internetRequired: false,
    accountRequired: false,
    telemetry: false,
    lanMode: LAN_MODE,
    hubUrl: 'http://127.0.0.1:' + HUB_PORT + '/',
    lanHubUrl: lanAddress ? 'http://' + lanAddress + ':' + HUB_PORT + '/' : null,
    games: CATALOG.games.length,
    active: activeView()
  };
}

const staticFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
  ['/catalog.json', 'catalog.json'],
  ['/vendor/qrcode.js', 'vendor/qrcode.js'],
  ['/vendor/QRCODE_GENERATOR_NOTICE.txt', 'vendor/QRCODE_GENERATOR_NOTICE.txt']
]);

function serveStatic(response, pathname) {
  const relative = staticFiles.get(pathname);
  if (!relative) return false;
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return false;
  response.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': /\.(?:html|js|css|json)$/i.test(file) ? 'no-store' : 'public, max-age=86400',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  });
  fs.createReadStream(file).pipe(response);
  return true;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, hubInfo());
    if (request.method === 'GET' && url.pathname === '/api/catalog') return json(response, 200, CATALOG);
    if (request.method === 'GET' && url.pathname === '/api/status') return json(response, 200, { ok: true, active: activeView(), lanMode: LAN_MODE });
    if (request.method === 'POST' && url.pathname === '/api/launch') {
      const body = await readBody(request);
      return json(response, 200, { ok: true, active: await startGame(body.gameId) });
    }
    if (request.method === 'POST' && url.pathname === '/api/stop') return json(response, 200, { ok: true, stopped: await stopActive('host-stop') });
    if (request.method === 'GET' && serveStatic(response, url.pathname)) return;
    return json(response, 404, { ok: false, error: 'route not found' });
  } catch (error) {
    return json(response, 400, { ok: false, error: String(error.message || error).slice(0, 1800) });
  }
});

function openBrowser(url) {
  try {
    if (process.platform === 'win32') childProcess.spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') childProcess.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else childProcess.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {}
}

server.listen(HUB_PORT, HOST, () => {
  const info = hubInfo();
  console.log('AXM Local Game Hub · EXPERIMENTAL proof of start');
  console.log('Local: ' + info.hubUrl);
  if (info.lanHubUrl) console.log('Same Wi-Fi: ' + info.lanHubUrl);
  console.log('Internet/account/telemetry: none');
  if (OPEN_BROWSER) setTimeout(() => openBrowser(info.hubUrl), 120);
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopActive('hub-shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1200).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
