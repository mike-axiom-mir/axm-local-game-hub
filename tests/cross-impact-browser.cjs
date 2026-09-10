'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'games/003-robo-pong-cross/runtime');
const evidenceDir = process.env.AXM_EVIDENCE_DIR || path.join(root, 'cross-impact-evidence');
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
  assert.equal(response.ok, true, 'test precondition patch must be accepted');
  return response.json();
}
async function readState() {
  const response = await fetch(base + '/state?room=AXM1');
  assert.equal(response.ok, true);
  return response.json();
}
function observePage(page, receipts) {
  page.on('pageerror', (error) => receipts.pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') receipts.consoleErrors.push(message.text()); });
  page.on('requestfailed', (request) => receipts.requestFailures.push({ url: request.url(), error: request.failure() && request.failure().errorText }));
}
function classifyBrowserNoise(receipts) {
  const expectedRequestFailures = receipts.requestFailures.filter((entry) => /\/aetherglass\/axm-(?:aetherglass|components|lighting-director)\.(?:css|js)$/.test(entry.url));
  const unexpectedRequestFailures = receipts.requestFailures.filter((entry) => !expectedRequestFailures.includes(entry));
  const expectedConsoleErrors = receipts.consoleErrors.filter((message) => /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/.test(message));
  const unexpectedConsoleErrors = receipts.consoleErrors.filter((message) => !expectedConsoleErrors.includes(message));
  return { expectedRequestFailures, unexpectedRequestFailures, expectedConsoleErrors, unexpectedConsoleErrors };
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

    const sharedContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const shared = await sharedContext.newPage();
    observePage(shared, receipts);
    await shared.goto(base + '/?room=AXM1&player=screen', { waitUntil: 'domcontentloaded' });

    const start = await readState();
    const bossBefore = start.mission.boss;
    const coreBefore = start.mission.core;

    // Test mode establishes only the collision precondition. The following boss
    // decrement is produced by the real 60 Hz diamondBounce -> damageBoss path.
    await patchState({
      phase: 'running',
      mission: { relayChain: ['p1', 'p2', 'p3'], relayArmed: true },
      ball: { x: 220, y: 220, vx: 0, vy: 0, active: true, serveAt: 0 }
    });
    await shared.waitForFunction(() => document.querySelector('#relayCoachAction') && /STRIKE THE WARDEN/.test(document.querySelector('#relayCoachAction').textContent));
    await wait(120);
    await patchState({ ball: { x: 500, y: 500, vx: 180, vy: 130, active: true, serveAt: 0 } });
    await shared.waitForFunction(() => document.querySelector('#crossImpact') && document.querySelector('#crossImpact').classList.contains('active') && /WARDEN HIT/.test(document.querySelector('#crossImpactLabel').textContent));
    const afterWarden = await readState();
    assert.equal(afterWarden.mission.boss, bossBefore - 1, 'real diamond collision must remove exactly one Warden point');
    assert.equal(afterWarden.mission.relayArmed, false, 'real Warden hit must disarm relay');
    assert.deepEqual(afterWarden.mission.relayChain, [], 'real Warden hit must clear relay chain');
    assert.equal((await shared.locator('#crossImpactLabel').innerText()).trim(), 'WARDEN HIT · -1');
    assert.match((await shared.locator('#crossImpactDetail').innerText()).trim(), new RegExp(`${bossBefore - 1} / ${bossBefore} WARDEN · RELAY RESET`));
    await shared.waitForFunction(() => /FIRST TOUCH/.test(document.querySelector('#relayCoachAction').textContent));
    const sharedRects = await shared.evaluate(() => {
      const impact = document.querySelector('.cross-impact-copy').getBoundingClientRect();
      const coach = document.querySelector('#relayCoach').getBoundingClientRect();
      return { impact: { top: impact.top, bottom: impact.bottom }, coach: { top: coach.top, bottom: coach.bottom } };
    });
    assert.ok(sharedRects.impact.top >= sharedRects.coach.bottom + 8, 'impact receipt must stay clear of relay coaching');
    await shared.screenshot({ path: path.join(evidenceDir, 'cross-warden-impact-desktop.png'), fullPage: true });

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const phone = await phoneContext.newPage();
    observePage(phone, receipts);
    await phone.goto(base + '/?room=AXM1&player=p2', { waitUntil: 'domcontentloaded' });

    // Establish an observed pre-hit baseline in the phone observer before the
    // canonical miss. Merely finding the DOM node is insufficient: it is mounted
    // before the first SSE state and could otherwise miss the delta by design.
    await patchState({
      mission: { relayChain: ['p1'], relayArmed: false },
      ball: { x: 500, y: 220, vx: 0, vy: 0, active: true, serveAt: 0 }
    });
    await phone.waitForFunction(() => document.querySelector('#relayControllerCue') && /YOUR TOUCH ADVANCES RELAY/.test(document.querySelector('#relayControllerCue').textContent));
    const phoneBaseline = await readState();
    assert.equal(phoneBaseline.mission.core, coreBefore, 'phone baseline must observe the pre-miss core value');

    // Test mode establishes the miss position only. checkGoals -> coopMiss owns
    // the actual canonical core decrement on the next real simulation tick.
    await patchState({ ball: { x: 500, y: 1040, vx: 0, vy: 0, active: true, serveAt: 0 } });
    await phone.waitForFunction(() => document.querySelector('#crossImpactPhone') && document.querySelector('#crossImpactPhone').classList.contains('active') && /CORE HIT/.test(document.querySelector('#crossImpactPhoneLabel').textContent));
    const afterCore = await readState();
    assert.equal(afterCore.mission.core, coreBefore - 1, 'real missed edge must remove exactly one shared-core point');
    assert.equal((await phone.locator('#crossImpactPhoneLabel').innerText()).trim(), 'CORE HIT · -1');
    assert.match((await phone.locator('#crossImpactPhoneDetail').innerText()).trim(), new RegExp(`${coreBefore - 1} / ${coreBefore} CORE · RELAY RESET`));
    const phoneGeometry = await phone.evaluate(() => {
      const toast = document.querySelector('#crossImpactPhone').getBoundingClientRect();
      const controls = document.querySelector('#controls').getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, toastBottom: toast.bottom, controlsTop: controls.top };
    });
    assert.equal(phoneGeometry.scrollWidth, phoneGeometry.innerWidth, 'impact feedback must not create phone overflow');
    assert.ok(phoneGeometry.toastBottom <= phoneGeometry.controlsTop - 8, 'phone consequence receipt must stay clear of movement/power controls');
    await phone.screenshot({ path: path.join(evidenceDir, 'cross-core-impact-phone.png'), fullPage: true });

    const browserNoise = classifyBrowserNoise(receipts);
    assert.equal(receipts.pageErrors.length, 0, 'impact realization must not produce page errors: ' + receipts.pageErrors.join(' | '));
    assert.equal(browserNoise.unexpectedConsoleErrors.length, 0, 'impact realization introduced unexpected console errors: ' + browserNoise.unexpectedConsoleErrors.join(' | '));
    assert.equal(browserNoise.unexpectedRequestFailures.length, 0, 'impact realization introduced unexpected request failures: ' + JSON.stringify(browserNoise.unexpectedRequestFailures));

    const report = {
      ok: true,
      health,
      gameplayEvidence: {
        warden: { before: bossBefore, after: afterWarden.mission.boss, path: 'real tick: diamondBounce -> damageBoss' },
        core: { before: coreBefore, after: afterCore.mission.core, path: 'real tick: checkGoals -> coopMiss' }
      },
      presentation: {
        wardenLabel: 'WARDEN HIT · -1',
        coreLabel: 'CORE HIT · -1',
        nextRelayAction: 'FIRST TOUCH',
        sharedRects,
        phoneGeometry
      },
      browserNoise: {
        knownPreExistingAetherglass404s: browserNoise.expectedRequestFailures,
        knownPreExisting404ConsoleCount: browserNoise.expectedConsoleErrors.length,
        unexpectedRequestFailures: browserNoise.unexpectedRequestFailures,
        unexpectedConsoleErrors: browserNoise.unexpectedConsoleErrors
      },
      pageErrors: receipts.pageErrors
    };
    fs.writeFileSync(path.join(evidenceDir, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    await phoneContext.close();
    await sharedContext.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(1000)]);
    if (child.exitCode == null) child.kill('SIGKILL');
    if (child.exitCode && child.exitCode !== 0) console.error(serverLog);
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
