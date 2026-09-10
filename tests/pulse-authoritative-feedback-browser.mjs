import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PORT = 18843;
const origin = `http://127.0.0.1:${PORT}`;
const artifactDir = path.resolve('test-artifacts/pulse-authoritative-feedback');
await fs.mkdir(artifactDir, { recursive: true });

const server = spawn(process.execPath, ['games/012-pulse-choir/runtime/server.js'], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    AXM_PLAYERS_JSON: JSON.stringify([
      { id: 'p1', seatId: 'seat-1', name: 'Axiom', type: 'human' },
      { id: 'p2', seatId: 'seat-2', name: 'Mir', type: 'human' },
      { id: 'p3', seatId: 'seat-3', name: 'Wildcard', type: 'human' }
    ])
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`, { cache: 'no-store' });
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Pulse Choir server did not become ready.\n${serverLog}`);
}

async function waitForPhase(expected) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/observe?player=p1`, { cache: 'no-store' });
    const packet = await response.json();
    if (packet.observation && packet.observation.phase === expected) return packet.observation;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for phase ${expected}`);
}

const errors = [];
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('requestfailed', request => errors.push(`requestfailed: ${request.url()} · ${request.failure()?.errorText || 'unknown'}`));

  await page.goto(`${origin}/controller.html?room=AXM1&player=p1`, { waitUntil: 'domcontentloaded' });
  await page.locator('#dot.ok').waitFor({ timeout: 4000 });
  await page.locator('#start.ready').click();
  await page.locator('body:not(.waiting)').waitFor({ timeout: 4000 });

  const heldResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().method() === 'POST');
  await page.locator('#pulse').click();
  const heldResponse = await heldResponsePromise;
  const heldPacket = await heldResponse.json();
  if (heldResponse.status() !== 409 || heldPacket.reason !== 'round-not-playing') {
    throw new Error(`countdown pulse did not expose authoritative hold: ${heldResponse.status()} ${JSON.stringify(heldPacket)}`);
  }
  await page.getByText('PULSE HELD', { exact: true }).waitFor();
  await page.getByText(/ROUND NOT PLAYING/).waitFor();
  await page.screenshot({ path: path.join(artifactDir, 'pulse-held-countdown-mobile.png'), fullPage: true });

  await waitForPhase('playing');
  await page.waitForFunction(() => document.querySelector('#start')?.textContent === 'PLAYING');

  const bufferedResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().method() === 'POST' && response.status() === 200);
  await page.locator('#pulse').click();
  const bufferedResponse = await bufferedResponsePromise;
  const bufferedPacket = await bufferedResponse.json();
  if (bufferedPacket.ok !== true || bufferedPacket.buffered !== true) {
    throw new Error(`playing pulse was not authoritatively buffered: ${JSON.stringify(bufferedPacket)}`);
  }
  await page.getByText('BUFFER ACCEPTED', { exact: true }).waitFor();
  await page.getByText(/SERVER RECEIPT · EARLY PRESS · 0\.24S WINDOW/).waitFor();

  const mobileMetrics = await page.evaluate(() => {
    const pulse = document.querySelector('#pulse').getBoundingClientRect();
    const receipt = document.querySelector('#pulseReceipt').getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      pulseWidth: pulse.width,
      pulseHeight: pulse.height,
      receiptWidth: receipt.width,
      receiptHeight: receipt.height,
      separated: pulse.bottom <= receipt.top + 1
    };
  });
  if (mobileMetrics.scrollWidth - mobileMetrics.viewportWidth > 1) throw new Error(`mobile horizontal overflow: ${mobileMetrics.scrollWidth - mobileMetrics.viewportWidth}px`);
  if (Math.min(mobileMetrics.pulseWidth, mobileMetrics.pulseHeight) < 44) throw new Error(`pulse target below 44px: ${JSON.stringify(mobileMetrics)}`);
  if (!mobileMetrics.separated) throw new Error(`pulse receipt overlaps action button: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, 'pulse-buffer-accepted-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().method() === 'POST' && response.status() === 200);
  await page.locator('#pulse').click();
  const desktopPacket = await (await desktopResponsePromise).json();
  if (desktopPacket.buffered !== true) throw new Error('desktop repeat did not remain in the same authoritative buffer path');
  await page.getByText('BUFFER ACCEPTED', { exact: true }).waitFor();
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (desktopOverflow > 1) throw new Error(`desktop horizontal overflow: ${desktopOverflow}px`);
  await page.screenshot({ path: path.join(artifactDir, 'pulse-buffer-accepted-desktop.png'), fullPage: true });

  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({
    ok: true,
    surface: 'real Pulse Choir server + exact phone controller HTML/CSS/JS',
    authoritativeHold: 'countdown pulse -> HTTP 409 round-not-playing -> PULSE HELD',
    authoritativeBuffer: 'playing pulse -> HTTP 200 buffered:true -> BUFFER ACCEPTED',
    bufferWindowMs: 240,
    mobile: mobileMetrics,
    desktopOverflowPx: desktopOverflow,
    browserErrors: 0
  }, null, 2));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
