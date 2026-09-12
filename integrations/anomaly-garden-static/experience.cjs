#!/usr/bin/env node
'use strict';

const http = require('node:http');
const {
  createStaticServer,
  listenLoopback,
  publicReceipt,
  verifyProviderRoot
} = require('./bridge.cjs');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderDesk(admission, gameUrl) {
  const receipt = publicReceipt(admission);
  const provider = receipt.provider || {};
  const runtime = receipt.runtime || {};
  const revision = escapeHtml(provider.revision || 'unknown');
  const version = escapeHtml(provider.version || 'unknown');
  const packageName = escapeHtml(provider.packageName || 'unknown');
  const closure = escapeHtml(runtime.closureSha256 || 'unknown');
  const receiptSha = escapeHtml(receipt.receiptSha256 || 'unknown');
  const fileCount = Number.isSafeInteger(runtime.fileCount) ? runtime.fileCount : 0;
  const runtimeBytes = Number.isSafeInteger(runtime.bytes) ? runtime.bytes : 0;
  const launchUrl = escapeHtml(gameUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AXM · Verified External World</title>
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #070a0f; color: #eef4ff; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 18% 12%, rgba(110,155,255,.18), transparent 34rem), linear-gradient(145deg,#070a0f,#101726 55%,#080b10); }
main { width: min(1040px, calc(100% - 32px)); margin: 0 auto; padding: 38px 0 54px; }
.eyebrow { letter-spacing: .16em; text-transform: uppercase; font-size: .76rem; font-weight: 800; color: #b7c8ff; }
h1 { margin: 10px 0 8px; font-size: clamp(2rem, 6vw, 4.6rem); line-height: .95; max-width: 13ch; }
.lede { margin: 0; max-width: 68ch; color: #c5cfdf; font-size: 1.05rem; line-height: 1.6; }
.boundaries { display: flex; gap: 8px; flex-wrap: wrap; margin: 22px 0 28px; }
.chip { border: 1px solid rgba(184,204,255,.28); background: rgba(13,22,40,.72); border-radius: 999px; padding: 8px 11px; font-size: .73rem; font-weight: 800; letter-spacing: .08em; }
.grid { display: grid; grid-template-columns: 1.2fr .8fr; gap: 16px; }
.panel { border: 1px solid rgba(184,204,255,.18); background: rgba(8,14,25,.78); box-shadow: 0 24px 70px rgba(0,0,0,.22); border-radius: 18px; padding: 20px; }
.panel h2 { margin: 0 0 8px; font-size: 1rem; text-transform: uppercase; letter-spacing: .08em; }
.identity { display: grid; gap: 12px; margin-top: 16px; }
.row { min-width: 0; border-top: 1px solid rgba(184,204,255,.13); padding-top: 11px; }
.row:first-child { border-top: 0; padding-top: 0; }
.label { display:block; color:#93a2ba; font-size:.72rem; text-transform:uppercase; letter-spacing:.11em; font-weight:800; margin-bottom:5px; }
.value { display:block; overflow-wrap:anywhere; font-family: ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.9rem; }
.action { display:flex; flex-direction:column; gap:12px; justify-content:space-between; min-height:100%; }
.launch { display:flex; align-items:center; justify-content:center; min-height:52px; padding:13px 16px; border-radius:14px; text-decoration:none; color:#081018; background:#eef4ff; font-weight:900; letter-spacing:.02em; text-align:center; }
.launch:hover { transform: translateY(-1px); }
.launch:focus-visible { outline: 3px solid #fff; outline-offset: 4px; }
.note { color:#a9b4c6; line-height:1.55; font-size:.9rem; }
.truth { margin-top:16px; border-left:3px solid #9db5ff; padding:2px 0 2px 12px; color:#cbd6e7; line-height:1.5; }
@media (max-width: 720px) { main { width:min(100% - 24px, 1040px); padding-top:24px; } .grid { grid-template-columns:1fr; } h1 { font-size:clamp(2.25rem,12vw,3.4rem); } .panel { padding:17px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior:auto !important; transition:none !important; animation:none !important; } }
@media (prefers-contrast: more) { .panel,.chip { border-color: currentColor; } .lede,.note,.truth { color:#fff; } }
</style>
</head>
<body>
<main>
  <div class="eyebrow">AXM Local Game Hub · External world desk</div>
  <h1>Verified. Still yours to open.</h1>
  <p class="lede">This exact local Anomaly Garden checkout passed the existing admission bridge. Nothing was downloaded, installed, added to the Hub catalog, or promoted by reaching this page.</p>
  <div class="boundaries" aria-label="Authority boundaries">
    <span class="chip">LOCAL ONLY</span><span class="chip">EXPLICIT CHECKOUT</span><span class="chip">NOT IN CATALOG</span><span class="chip">NO AUTO-INSTALL</span><span class="chip">NOT CANON</span>
  </div>
  <section class="grid">
    <div class="panel" aria-labelledby="identity-title">
      <h2 id="identity-title">Admitted identity</h2>
      <div class="identity">
        <div class="row"><span class="label">Provider</span><span class="value" id="provider-identity">${packageName}@${version}</span></div>
        <div class="row"><span class="label">Pinned revision</span><span class="value" id="provider-revision">${revision}</span></div>
        <div class="row"><span class="label">Runtime closure · ${fileCount} files · ${runtimeBytes} bytes</span><span class="value" id="runtime-closure">${closure}</span></div>
        <div class="row"><span class="label">Admission receipt</span><span class="value" id="admission-receipt">${receiptSha}</span></div>
      </div>
    </div>
    <div class="panel action">
      <div>
        <h2>Human gate</h2>
        <p class="note">The verified runtime is already held on loopback. Opening it is a separate human action; closing this process stops both local surfaces.</p>
      </div>
      <a class="launch" id="launch-world" href="${launchUrl}">Open verified Anomaly Garden</a>
    </div>
  </section>
  <p class="truth"><strong>Truth ceiling:</strong> admission proves selected local bytes matched the pinned reviewed revision. It does not authenticate authorship, sandbox hostile code, adopt this world into the canonical four-game Hub, or grant merge/CANON authority.</p>
</main>
</body>
</html>`;
}

function createDeskServer(admission, gameUrl) {
  if (!admission || admission.schema !== 'axm.local-game-hub.anomaly-garden-static-admission/v0.1') {
    throw Object.assign(new Error('verified Anomaly Garden admission is required'), { code: 'ADMISSION_REQUIRED' });
  }
  const html = Buffer.from(renderDesk(admission, gameUrl));
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      return res.end();
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(html.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(html);
  });
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function startExperience(providerRoot, options = {}) {
  const admission = verifyProviderRoot(providerRoot);
  const gameServer = createStaticServer(admission);
  let deskServer;
  try {
    const gameUrl = await listenLoopback(gameServer, options.gamePort ?? 0);
    deskServer = createDeskServer(admission, gameUrl);
    const deskUrl = await listenLoopback(deskServer, options.deskPort ?? 0);
    return Object.freeze({
      admission,
      gameServer,
      deskServer,
      gameUrl,
      deskUrl,
      async close() {
        await closeServer(deskServer);
        await closeServer(gameServer);
      }
    });
  } catch (error) {
    await closeServer(deskServer);
    await closeServer(gameServer);
    throw error;
  }
}

async function main(argv) {
  const [providerRoot, deskPortText] = argv;
  if (!providerRoot) {
    process.stderr.write('usage: experience.cjs ABSOLUTE_PROVIDER_ROOT [DESK_PORT]\n');
    process.exitCode = 2;
    return;
  }
  const deskPort = deskPortText === undefined ? 0 : Number(deskPortText);
  let experience;
  try {
    experience = await startExperience(providerRoot, { deskPort });
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'HOLD', code: error.code || 'EXPERIENCE_HELD', message: error.message })}\n`);
    process.exitCode = 1;
    return;
  }
  const safe = publicReceipt(experience.admission);
  process.stdout.write(`${JSON.stringify({
    schema: 'axm.local-game-hub.anomaly-garden-external-launch/v0.1',
    status: 'READY_FOR_HUMAN',
    deskUrl: experience.deskUrl,
    gameUrl: experience.gameUrl,
    providerRevision: safe.provider.revision,
    runtimeClosureSha256: safe.runtime.closureSha256,
    admissionReceiptSha256: safe.receiptSha256,
    authority: safe.authority
  })}\n`);
  const shutdown = async () => {
    await experience.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ status: 'HOLD', code: error.code || 'EXPERIENCE_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createDeskServer, escapeHtml, renderDesk, startExperience };
