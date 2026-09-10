import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const serverPath = path.join(root, 'games', '002-robo-pong', 'runtime', 'neon-pong-duet-server.cjs');
const port = 8793;
const origin = `http://127.0.0.1:${port}`;
const artifacts = process.env.AXM_SCREENSHOT_DIR || path.join(root, 'test-artifacts', 'duet-return-impact');
fs.mkdirSync(artifacts, { recursive: true });

const child = spawn(process.execPath, [serverPath], {
  cwd: path.dirname(serverPath),
  env: {
    ...process.env,
    PORT: String(port),
    AXM_ROBO_PONG_HOST: '127.0.0.1',
    AXM_TEST_MODE: '1',
    AXM_GAME_MODE: 'human-vs-human',
    AXM_GAME_PLAY_MODE: 'versus'
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

async function state() {
  const response = await fetch(origin + '/state?room=AXM1');
  assert.equal(response.ok, true);
  return response.json();
}

async function waitForState(predicate, message, timeout = 2500) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await state();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message + (last ? ' Last state: ' + JSON.stringify({ phase: last.phase, serveIn: last.serveIn, event: last.event, eventAt: last.eventAt, ball: last.ball }) : ''));
}

async function post(pathname, body) {
  const response = await fetch(origin + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  assert.equal(response.ok, true, `${pathname} must succeed`);
  return response.json();
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
let screen;
let phone;
let stage = 'boot';
try {
  stage = 'wait-server';
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  screen = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const screenErrors = [];
  const phoneErrors = [];
  screen.on('pageerror', error => screenErrors.push(error.message));
  phone.on('pageerror', error => phoneErrors.push(error.message));

  stage = 'load-surfaces';
  await screen.goto(origin + '/?room=AXM1&player=screen', { waitUntil: 'domcontentloaded' });
  await phone.goto(origin + '/?room=AXM1&player=p1', { waitUntil: 'domcontentloaded' });
  await screen.waitForSelector('#startButton:not([disabled])');
  await screen.click('#startButton');
  stage = 'wait-live-serve';
  const live = await waitForState(current => current.phase === 'running' && current.serveIn === 0, 'serve never became live', 3000);
  assert.equal(live.playMode, 'versus');

  await screen.waitForFunction(() => document.getElementById('connection').textContent.startsWith('LIVE'));
  await phone.waitForFunction(() => document.getElementById('connection').textContent.startsWith('LIVE'));

  stage = 'seed-return-precondition';
  const p1 = live.paddles.p1;
  await post('/test/set', {
    phase: 'running',
    ball: { x: p1.x, y: p1.y - 35, vx: 0, vy: 900, lastTouch: null }
  });

  stage = 'wait-authoritative-return';
  const returned = await waitForState(
    current => current.ball.lastTouch === 'p1' && / RETURN$/.test(current.event || ''),
    'real physics loop did not produce a P1 return'
  );

  stage = 'wait-presentations';
  await screen.waitForSelector('#returnImpact.show', { timeout: 1200 });
  await phone.waitForSelector('#controllerReturnStatus:not([hidden])', { timeout: 1200 });

  stage = 'measure-presentations';
  const screenReceipt = await screen.evaluate(() => {
    const impact = document.getElementById('returnImpact');
    const label = document.getElementById('returnImpactLabel');
    return {
      label: label.textContent,
      left: impact.style.left,
      top: impact.style.top,
      color: impact.style.getPropertyValue('--impact-color'),
      visible: impact.classList.contains('show')
    };
  });
  const phoneReceipt = await phone.evaluate(() => {
    const status = document.getElementById('controllerReturnStatus');
    const controls = document.getElementById('controls').getBoundingClientRect();
    const receipt = status.getBoundingClientRect();
    return {
      text: status.textContent,
      hidden: status.hidden,
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      receiptBottom: receipt.bottom,
      controlsTop: controls.top
    };
  });

  stage = 'capture-evidence';
  await screen.screenshot({ path: path.join(artifacts, 'duet-return-impact-screen.png'), fullPage: true });
  await phone.screenshot({ path: path.join(artifacts, 'duet-return-impact-phone.png'), fullPage: true });

  stage = 'assert-evidence';
  assert.equal(screenReceipt.visible, true);
  assert.match(screenReceipt.label, / · RETURN$/);
  assert.equal(phoneReceipt.text, 'YOUR RETURN CONFIRMED');
  assert.equal(phoneReceipt.hidden, false);
  assert.equal(phoneReceipt.scrollWidth, phoneReceipt.innerWidth, '390px controller must not overflow horizontally');
  assert.ok(phoneReceipt.receiptBottom <= phoneReceipt.controlsTop, 'return receipt must stay clear of movement controls');
  assert.deepEqual(screenErrors, [], 'shared screen must have no page errors');
  assert.deepEqual(phoneErrors, [], 'phone controller must have no page errors');

  const receipt = {
    ok: true,
    authoritativeEvent: returned.event,
    authoritativeEventAt: returned.eventAt,
    authoritativeLastTouch: returned.ball.lastTouch,
    canonicalScore: returned.scores,
    screen: screenReceipt,
    phone: phoneReceipt,
    pageErrors: { screen: screenErrors, phone: phoneErrors },
    screenshots: ['duet-return-impact-screen.png', 'duet-return-impact-phone.png']
  };
  fs.writeFileSync(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  const failure = { ok: false, stage, error: String(error && error.stack || error), serverStderr: stderr };
  try { if (screen) await screen.screenshot({ path: path.join(artifacts, 'failure-screen.png'), fullPage: true }); } catch (captureError) { failure.screenCaptureError = String(captureError); }
  try { if (phone) await phone.screenshot({ path: path.join(artifacts, 'failure-phone.png'), fullPage: true }); } catch (captureError) { failure.phoneCaptureError = String(captureError); }
  fs.writeFileSync(path.join(artifacts, 'failure.json'), JSON.stringify(failure, null, 2) + '\n');
  console.error(JSON.stringify(failure, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  await stopServer();
}