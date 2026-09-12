'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  createStaticServer,
  listenLoopback,
  publicReceipt,
  verifyProviderRoot
} = require('../integrations/anomaly-garden-static/bridge.cjs');

async function main() {
  const providerRoot = process.env.AXM_ANOMALY_GARDEN_ROOT;
  assert.ok(providerRoot && path.isAbsolute(providerRoot), 'AXM_ANOMALY_GARDEN_ROOT must be an absolute provider checkout');

  const admission = verifyProviderRoot(providerRoot);
  const server = createStaticServer(admission);
  const url = await listenLoopback(server, 0);
  const expectedOrigin = new URL(url).origin;
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const externalRequests = [];
  const requestUrls = [];
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), failure: request.failure() }));
    page.on('request', (request) => {
      requestUrls.push(request.url());
      let origin;
      try {
        origin = new URL(request.url()).origin;
      } catch {
        origin = 'invalid';
      }
      if (origin !== expectedOrigin) externalRequests.push(request.url());
    });

    const response = await page.goto(url, { waitUntil: 'load' });
    assert.ok(response, 'expected a navigation response');
    assert.equal(response.status(), 200);
    await page.waitForSelector('#world');
    await page.waitForFunction(() => document.querySelector('#tick')?.textContent?.trim() === '0');
    assert.match(await page.title(), /Anomaly Garden/i);

    await page.click('#step');
    await page.waitForFunction(() => document.querySelector('#tick')?.textContent?.trim() === '1');
    const fingerprint = (await page.locator('#metric-fingerprint').textContent()).trim();
    assert.match(fingerprint, /^[0-9a-f-]{8}$/i);

    await page.click('button[data-anomaly="gravity-slip"]');
    await page.click('#step');
    await page.waitForFunction(() => document.querySelector('#tick')?.textContent?.trim() === '2');
    const truthText = (await page.locator('#truth-list').innerText()).trim();
    assert.ok(truthText.length > 0, 'machine truth panel should remain populated after a real intervention and step');

    assert.deepEqual(externalRequests, [], 'browser must not request any non-loopback origin');
    assert.deepEqual(pageErrors, [], 'browser page errors must remain empty');
    assert.deepEqual(consoleErrors, [], 'browser console errors must remain empty');
    assert.deepEqual(failedRequests, [], 'browser request failures must remain empty');

    const artifactsDir = path.resolve(process.env.AXM_EVIDENCE_DIR || path.join(process.cwd(), 'artifacts'));
    fs.mkdirSync(artifactsDir, { recursive: true });
    const screenshotPath = path.join(artifactsDir, 'anomaly-garden-static-consumer.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const receipt = {
      schema: 'axm.local-game-hub.anomaly-garden-static-browser-proof/v0.1',
      status: 'PASS',
      provider: publicReceipt(admission).provider,
      runtimeClosureSha256: admission.runtime.closureSha256,
      admissionReceiptSha256: admission.receiptSha256,
      runtimeFiles: admission.runtime.fileCount,
      runtimeBytes: admission.runtime.bytes,
      browser: {
        engine: 'chromium',
        requests: requestUrls.length,
        externalRequests: externalRequests.length,
        pageErrors: pageErrors.length,
        consoleErrors: consoleErrors.length,
        failedRequests: failedRequests.length,
        observedTick: 2,
        observedFingerprint: fingerprint,
        machineTruthPanelPopulated: true
      },
      authority: admission.authority
    };
    fs.writeFileSync(path.join(artifactsDir, 'anomaly-garden-static-consumer.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
