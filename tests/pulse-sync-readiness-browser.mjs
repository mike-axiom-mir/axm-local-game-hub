import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PORT = 18842;
const origin = `http://127.0.0.1:${PORT}`;
const artifactDir = path.resolve('test-artifacts/pulse-sync-readiness');
await fs.mkdir(artifactDir, { recursive: true });

const server = spawn(process.execPath, ['games/012-pulse-choir/runtime/server.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), AXM_PLAYERS_JSON: JSON.stringify([
    { id: 'p1', seatId: 'seat-1', name: 'Axiom', type: 'human' },
    { id: 'p2', seatId: 'seat-2', name: 'Mir', type: 'human' },
    { id: 'p3', seatId: 'seat-3', name: 'Wildcard', type: 'ai' }
  ]) },
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

const errors = [];
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('requestfailed', request => errors.push(`requestfailed: ${request.url()} · ${request.failure()?.errorText || 'unknown'}`));

  let clockMs = 10500;
  let allReady = false;
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const packet = await response.json();
    const ids = Object.keys(packet.state.players || {}).sort();
    const pulses = (allReady ? ids : ids.slice(0, 1)).map((player, index) => ({ player, at: 10200 + index * 60 }));
    packet.state.phase = 'playing';
    packet.state.clockMs = clockMs;
    packet.state.sync = { id: 'sync-visual-evidence', openedAt: 10000, endsAt: 11900, pulses };
    for (const player of Object.values(packet.state.players || {})) player.pulsedSyncId = pulses.some(item => item.player === player.id) ? packet.state.sync.id : null;
    await route.fulfill({ response, body: JSON.stringify(packet), headers: { ...response.headers(), 'content-type': 'application/json; charset=utf-8' } });
  });

  await page.goto(`${origin}/games/012/?room=AXM1&player=screen`, { waitUntil: 'networkidle' });
  const banner = page.locator('#syncBanner');
  await banner.waitFor({ state: 'visible' });
  await page.getByText('1 / 3 READY', { exact: true }).waitFor();
  await page.getByText('1.4s LEFT', { exact: true }).waitFor();
  const labels = await page.locator('#syncReadinessRoster li').allTextContents();
  if (!labels.some(label => label.includes('Axiom') && label.includes('✓'))) throw new Error(`ready seat not legible: ${labels.join(' | ')}`);
  if (!labels.some(label => label.includes('Mir') && label.includes('○'))) throw new Error(`waiting seat not legible: ${labels.join(' | ')}`);
  await page.screenshot({ path: path.join(artifactDir, 'pulse-sync-readiness-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`mobile horizontal overflow: ${overflow}px`);
  await page.screenshot({ path: path.join(artifactDir, 'pulse-sync-readiness-mobile.png'), fullPage: true });

  allReady = true;
  clockMs = 11200;
  await page.getByText('ALL 3 READY', { exact: true }).waitFor({ timeout: 4000 });
  const completeClass = await banner.evaluate(node => node.classList.contains('sync-complete'));
  if (!completeClass) throw new Error('all-ready state did not produce the complete realization');
  const aria = await banner.getAttribute('aria-label');
  if (!aria || !aria.includes('All 3 players ready')) throw new Error(`all-ready accessible status missing: ${aria}`);

  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({
    ok: true,
    surface: 'real Pulse Choir server + shared-screen HTML/CSS/app',
    authoritativeCoreWindowMs: 1900,
    visualHarness: 'real state packets with only sync timing/pulse fields replaced for bounded perceptual coverage',
    desktop: '1/3 ready · 1.4s left · named ready/waiting seats',
    mobileOverflowPx: overflow,
    completion: '3/3 ready',
    browserErrors: 0
  }, null, 2));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
