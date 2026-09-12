'use strict';

const childProcess = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HUB_PORT = 18890;
const GAME_PORT_BASE = 18900;

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: route,
      method,
      timeout: 2500,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': payload.length
      } : undefined
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try { value = JSON.parse(text); }
        catch (error) { return reject(new Error(`invalid JSON from ${route}: ${text.slice(0, 200)}`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`${method} ${route} -> ${res.statusCode}: ${text.slice(0, 500)}`));
        }
        resolve(value);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${route}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHub() {
  let last;
  for (let i = 0; i < 60; i += 1) {
    try { return await request('GET', '/api/health'); }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw last || new Error('hub did not start');
}

async function main() {
  const log = [];
  const hub = childProcess.spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AXM_GAME_HUB_PORT: String(HUB_PORT),
      AXM_GAME_PORT_BASE: String(GAME_PORT_BASE),
      AXM_GAME_HUB_NO_OPEN: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const capture = chunk => {
    log.push(String(chunk).trim());
    while (log.length > 30) log.shift();
  };
  hub.stdout.on('data', capture);
  hub.stderr.on('data', capture);

  try {
    const health = await waitForHub();
    if (!health.ok || health.games !== 4) throw new Error(`unexpected hub health: ${JSON.stringify(health)}`);
    const catalog = await request('GET', '/api/catalog');
    if (!catalog || !Array.isArray(catalog.games) || catalog.games.length !== 4) throw new Error('expected four catalog games');

    for (const game of catalog.games) {
      const launched = await request('POST', '/api/launch', { gameId: game.id });
      if (!launched.ok || !launched.active || launched.active.status !== 'ready') {
        throw new Error(`game did not reach ready: ${game.id} ${JSON.stringify(launched)}`);
      }
      if (launched.active.gameId !== game.id || !launched.active.playUrl) {
        throw new Error(`invalid active projection for ${game.id}`);
      }
      const status = await request('GET', '/api/status');
      if (!status.active || status.active.gameId !== game.id || status.active.status !== 'ready') {
        throw new Error(`status mismatch for ${game.id}`);
      }
      const stopped = await request('POST', '/api/stop', {});
      if (!stopped.ok) throw new Error(`stop failed for ${game.id}`);
      process.stdout.write(`PLAYTEST_READY ${game.id}\n`);
    }

    process.stdout.write('PLAYTEST_FULL_BUILD_PASS\n');
  } finally {
    if (hub.exitCode === null) hub.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => hub.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    if (hub.exitCode === null) hub.kill('SIGKILL');
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
