'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'games/003-robo-pong-cross/runtime');
const evidenceDir = process.env.AXM_EVIDENCE_DIR || path.join(root, 'cross-relay-evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
const port = 8793;
const base = `http://127.0.0.1:${port}`;

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitHealth() {
  for (let i = 0; i < 80; i += 1) {
    try { const response = await fetch(base + '/health'); if (response.ok) return response.json(); } catch (error) {}
    await wait(100);
  }
  throw new Error('Cross server did not become healthy');
}
async function patchState(patch) {
  const response = await fetch(base + '/test/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  assert.equal(response.ok, true, 'test state patch must be accepted');
  return response.json();
}
async function visibleText(page, selector) { await page.locator(selector).waitFor({ state: 'visible' }); return (await page.locator(selector).innerText()).trim(); }
function observePage(page, receipts) {
  page.on('pageerror', (error) => receipts.pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') receipts.consoleErrors.push(message.text()); });
  page.on('requestfailed', (request) => receipts.requestFailures.push({ url: request.url(), error: request.failure() && request.failure().errorText }));
}

(async () => {
  const roster = [
    { seat_id: 'seat_1', slot: 1, type: 'human', display_name: 'MIKE' },
    { seat_id: 'seat_2', slot: 2, type: 'human', display_name: 'NOVA' },
    { seat_id: 'seat_3', slot: 3, type: 'human', display_name: 'CODEX' }
  ];
  const child = spawn(process.execPath, [path.join(runtime, 'neon-pong-cross-server.cjs')], {
    cwd: runtime,
    env: Object.assign({}, process.env, { PORT: String(port), AXM_ROBO_PONG_HOST: '127.0.0.1', AXM_TEST_MODE: '1', AXM_GAME_PLAY_MODE: 'coop', AXM_PLAYERS_JSON: JSON.stringify(roster) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

  let browser;
  const receipts = { pageErrors: [], consoleErrors: [], requestFailures: [] };
  try {
    const health = await waitHealth();
    assert.equal(health.playMode, 'coop');
    assert.equal(health.seatCount, 3);
    const launchOptions = { headless: true };
    if (process.env.AXM_BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.AXM_BROWSER_EXECUTABLE;
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const shared = await context.newPage();
    observePage(shared, receipts);
    await shared.goto(base + '/?room=AXM1&player=screen', { waitUntil: 'domcontentloaded' });

    await patchState({ phase: 'running', mission: { relayChain: ['p1'], relayArmed: false } });
    await shared.waitForFunction(() => document.querySelector('#relayCoachAction') && /NEXT TOUCH/.test(document.querySelector('#relayCoachAction').textContent));
    assert.equal(await visibleText(shared, '#relayCoachAction'), 'NEXT TOUCH · ANY NEW TEAMMATE');
    assert.equal(await shared.locator('.relay-edge-top').isVisible(), true, 'p2 top edge should be eligible');
    assert.equal(await shared.locator('.relay-edge-left').isVisible(), true, 'p3 left edge should be eligible');
    assert.equal(await shared.locator('.relay-edge-bottom').isVisible(), false, 'p1 already touched and must not remain eligible');
    assert.equal(await shared.locator('.relay-edge-right').isVisible(), false, 'host Warden must never be advertised as a relay touch');
    assert.match(await shared.locator('#relayCoachChain').innerText(), /MIKE/);
    await shared.screenshot({ path: path.join(evidenceDir, 'cross-relay-shared.png'), fullPage: true });

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const phone = await phoneContext.newPage();
    observePage(phone, receipts);
    await phone.goto(base + '/?room=AXM1&player=p2', { waitUntil: 'domcontentloaded' });
    await phone.waitForFunction(() => document.querySelector('#relayControllerCue') && /YOUR TOUCH/.test(document.querySelector('#relayControllerCue').textContent));
    assert.equal(await visibleText(phone, '#relayControllerCue'), 'YOUR TOUCH ADVANCES RELAY · 1/3');
    const mobileOverflow = await phone.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    assert.equal(mobileOverflow.scrollWidth, mobileOverflow.innerWidth, 'phone relay cue must not create horizontal overflow');
    await phone.screenshot({ path: path.join(evidenceDir, 'cross-relay-phone.png'), fullPage: true });

    await patchState({ mission: { relayChain: ['p1', 'p2', 'p3'], relayArmed: true } });
    await shared.waitForFunction(() => /STRIKE THE WARDEN/.test(document.querySelector('#relayCoachAction').textContent));
    await phone.waitForFunction(() => /DRIVE THE LIGHT INTO THE WARDEN/.test(document.querySelector('#relayControllerCue').textContent));
    assert.equal(await shared.locator('.relay-edge-top').isVisible(), false);
    assert.equal(receipts.pageErrors.length, 0, 'relay realization must not produce page errors: ' + receipts.pageErrors.join(' | '));

    const report = { ok: true, health, sharedAction: 'NEXT TOUCH · ANY NEW TEAMMATE', phoneAction: 'YOUR TOUCH ADVANCES RELAY · 1/3', armedAction: 'RELAY ARMED', mobileOverflow, receipts };
    fs.writeFileSync(path.join(evidenceDir, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
    await phoneContext.close(); await context.close();
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(1000)]);
    if (child.exitCode == null) child.kill('SIGKILL');
    if (child.exitCode && child.exitCode !== 0) console.error(serverLog);
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
