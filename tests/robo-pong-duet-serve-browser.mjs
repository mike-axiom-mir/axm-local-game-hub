import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const serverPath = path.join(root, 'games', '002-robo-pong', 'runtime', 'neon-pong-duet-server.cjs');
const port = 8792;
const origin = `http://127.0.0.1:${port}`;
const artifacts = process.env.AXM_SCREENSHOT_DIR || path.join(root, 'test-artifacts', 'duet-serve-readiness');

const child = spawn(process.execPath, [serverPath], {
  cwd: path.dirname(serverPath),
  env: {
    ...process.env,
    PORT: String(port),
    AXM_ROBO_PONG_HOST: '127.0.0.1',
    AXM_TEST_MODE: '1',
    AXM_GAME_MODE: 'human-vs-human'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin + '/health');
      if (response.ok) return;
    } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Duet server did not become healthy. ' + stderr);
}

async function stopServer() {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  const screen = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const screenErrors = [];
  screen.on('pageerror', error => screenErrors.push(error.message));
  await screen.goto(origin + '/?room=AXM1&player=screen', { waitUntil: 'domcontentloaded' });
  await screen.waitForSelector('#startButton:not([disabled])');
  await screen.click('#startButton');
  await screen.waitForSelector('#serveCue:not([hidden])', { timeout: 1500 });
  const countdown = await screen.locator('#serveCountdown').textContent();
  assert.match(countdown || '', /^0\.[1-9]$|^1\.0$/, 'screen must show bounded authoritative serve time');
  const stateDuringCue = await (await fetch(origin + '/state?room=AXM1')).json();
  assert.equal(stateDuringCue.phase, 'running');
  assert.ok(stateDuringCue.serveIn > 0, 'visible cue must correspond to live server serveIn');
  await screen.screenshot({ path: path.join(artifacts, 'duet-serve-screen.png'), fullPage: true });
  await screen.waitForFunction(() => document.getElementById('serveCue').hidden === true, null, { timeout: 2500 });
  assert.deepEqual(screenErrors, [], 'shared screen must have no page errors');

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phoneErrors = [];
  phone.on('pageerror', error => phoneErrors.push(error.message));
  await phone.goto(origin + '/?room=AXM1&player=p1', { waitUntil: 'domcontentloaded' });
  await phone.evaluate(async () => {
    const response = await fetch('/reset', { method: 'POST' });
    if (!response.ok) throw new Error('reset failed: ' + response.status);
  });
  await phone.waitForSelector('#controllerServeStatus:not([hidden])', { timeout: 1500 });
  const phoneCue = await phone.locator('#controllerServeStatus').textContent();
  assert.match(phoneCue || '', /^LIGHT IN (?:0\.[1-9]|1\.0)s · PREPARE$/);
  const overflow = await phone.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(overflow.scrollWidth, overflow.innerWidth, '390px controller must not overflow horizontally');
  await phone.screenshot({ path: path.join(artifacts, 'duet-serve-phone.png'), fullPage: true });
  assert.deepEqual(phoneErrors, [], 'phone controller must have no page errors');

  console.log(JSON.stringify({
    ok: true,
    screenCountdown: countdown,
    authoritativeServeInMs: stateDuringCue.serveIn,
    phoneCue,
    overflow,
    screenshots: ['duet-serve-screen.png', 'duet-serve-phone.png']
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await stopServer();
}
