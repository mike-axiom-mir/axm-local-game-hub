'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { publicReceipt } = require('../integrations/anomaly-garden-static/bridge.cjs');
const { startExperience } = require('../integrations/anomaly-garden-static/experience.cjs');

async function main() {
  const providerRoot = process.env.AXM_ANOMALY_GARDEN_ROOT;
  assert.ok(providerRoot && path.isAbsolute(providerRoot), 'AXM_ANOMALY_GARDEN_ROOT must be an absolute provider checkout');
  const artifactsDir = path.resolve(process.env.AXM_EVIDENCE_DIR || path.join(process.cwd(), 'artifacts'));
  fs.mkdirSync(artifactsDir, { recursive: true });

  const experience = await startExperience(providerRoot);
  const allowedOrigins = new Set([new URL(experience.deskUrl).origin, new URL(experience.gameUrl).origin]);
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const unexpectedOrigins = [];
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), failure: request.failure() }));
    page.on('request', (request) => {
      try {
        const origin = new URL(request.url()).origin;
        if (!allowedOrigins.has(origin)) unexpectedOrigins.push(request.url());
      } catch {
        unexpectedOrigins.push(request.url());
      }
    });

    const response = await page.goto(experience.deskUrl, { waitUntil: 'load' });
    assert.ok(response && response.status() === 200, 'desk should load successfully');
    assert.match(await page.title(), /Verified External World/);
    assert.equal((await page.locator('#provider-identity').textContent()).trim(), 'axm-anomaly-garden@0.16.0');
    assert.equal((await page.locator('#provider-revision').textContent()).trim(), 'e9af55a1d1494f3d4f639e16b3bb06279ae8c4ea');

    const launch = page.locator('#launch-world');
    const desktopBox = await launch.boundingBox();
    assert.ok(desktopBox && desktopBox.height >= 44, `desktop launch target too small: ${desktopBox?.height}`);
    const desktopWidth = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(desktopWidth.scroll <= desktopWidth.inner + 1, `desktop overflow: ${JSON.stringify(desktopWidth)}`);
    await page.screenshot({ path: path.join(artifactsDir, 'anomaly-external-launch-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBox = await launch.boundingBox();
    assert.ok(mobileBox && mobileBox.height >= 44, `mobile launch target too small: ${mobileBox?.height}`);
    const mobileWidth = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(mobileWidth.scroll <= mobileWidth.inner + 1, `mobile overflow: ${JSON.stringify(mobileWidth)}`);
    assert.match(await page.locator('body').innerText(), /NOT IN CATALOG/);
    assert.match(await page.locator('body').innerText(), /NOT CANON/);
    await page.screenshot({ path: path.join(artifactsDir, 'anomaly-external-launch-mobile.png'), fullPage: true });

    await Promise.all([
      page.waitForURL(`${experience.gameUrl}**`),
      launch.click()
    ]);
    await page.waitForSelector('#world');
    await page.waitForFunction(() => document.querySelector('#tick')?.textContent?.trim() === '0');
    assert.match(await page.title(), /Anomaly Garden/i);

    await page.click('#step');
    await page.waitForFunction(() => document.querySelector('#tick')?.textContent?.trim() === '1');
    await page.click('button[data-anomaly="gravity-slip"]');
    await page.click('#step');
    await page.waitForFunction(() => document.querySelector('#tick')?.textContent?.trim() === '2');
    const truthText = (await page.locator('#truth-list').innerText()).trim();
    assert.ok(truthText.length > 0, 'machine truth panel should remain populated after explicit launch and real play actions');
    const fingerprint = (await page.locator('#metric-fingerprint').textContent()).trim();
    assert.match(fingerprint, /^[0-9a-f-]{8}$/i);
    await page.screenshot({ path: path.join(artifactsDir, 'anomaly-external-launch-world.png'), fullPage: true });

    assert.deepEqual(unexpectedOrigins, [], 'experience must not request any non-loopback/external origin');
    assert.deepEqual(pageErrors, [], 'browser page errors must remain empty');
    assert.deepEqual(consoleErrors, [], 'browser console errors must remain empty');
    assert.deepEqual(failedRequests, [], 'browser request failures must remain empty');

    const safe = publicReceipt(experience.admission);
    const receipt = {
      schema: 'axm.local-game-hub.anomaly-garden-external-launch-proof/v0.1',
      status: 'PASS',
      provider: safe.provider,
      runtimeClosureSha256: safe.runtime.closureSha256,
      admissionReceiptSha256: safe.receiptSha256,
      experience: {
        humanGateObserved: true,
        launchTargetDesktopPx: desktopBox.height,
        launchTargetMobilePx: mobileBox.height,
        desktopHorizontalOverflowPx: Math.max(0, desktopWidth.scroll - desktopWidth.inner),
        mobileHorizontalOverflowPx: Math.max(0, mobileWidth.scroll - mobileWidth.inner),
        observedTickAfterLaunch: 2,
        observedFingerprint: fingerprint,
        machineTruthPanelPopulated: true,
        unexpectedOrigins: unexpectedOrigins.length,
        pageErrors: pageErrors.length,
        consoleErrors: consoleErrors.length,
        failedRequests: failedRequests.length
      },
      authority: safe.authority
    };
    fs.writeFileSync(path.join(artifactsDir, 'anomaly-external-launch-proof.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await browser.close();
    await experience.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
