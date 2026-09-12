import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";

const hubRoot = path.resolve(process.env.AXM_HUB_ROOT || ".");
const siteRoot = path.resolve(process.env.AXM_BROWSER_BRIDGE_SITE || ".");

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForJson(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message || "not ready"}`);
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`POST ${url} failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function startStaticServer() {
  const port = await findFreePort();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const names = {
      "/": "test_harness.html",
      "/test_harness.html": "test_harness.html",
      "/manual_webrtc.mjs": "manual_webrtc.mjs",
      "/robo-pong-remote-seat.mjs": "robo-pong-remote-seat.mjs",
    };
    const name = names[url.pathname];
    if (!name) { response.writeHead(404); response.end("not found"); return; }
    try {
      const bytes = await fs.readFile(path.join(siteRoot, name));
      const type = name.endsWith(".mjs") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      response.end(bytes);
    } catch (error) {
      response.writeHead(500); response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${port}` };
}

const gamePort = await findFreePort();
const gameServerPath = path.join(hubRoot, "games/003-robo-pong-cross/runtime/robo-pong-cross-server.cjs");
const gameChild = spawn(process.execPath, [gameServerPath], {
  cwd: path.dirname(gameServerPath),
  env: {
    ...process.env,
    AXM_ROBO_PONG_HOST: "127.0.0.1",
    PORT: String(gamePort),
    AXM_PLAYERS_JSON: JSON.stringify([
      { display_name: "Remote", type: "human" },
      { display_name: "Nova", type: "adapter" },
      { display_name: "Gemini", type: "adapter" },
      { display_name: "Codex", type: "adapter" },
    ]),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gameStderr = "";
gameChild.stderr.on("data", (chunk) => { gameStderr += chunk; });

const staticServer = await startStaticServer();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const host = await context.newPage();
const guest = await context.newPage();
const pageErrors = [];
for (const page of [host, guest]) {
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(`console: ${message.text()}`); });
}

try {
  const gameBase = `http://127.0.0.1:${gamePort}`;
  const health = await waitForJson(`${gameBase}/health`);
  assert.equal(health.version, "0.1.1-cross");
  await postJson(`${gameBase}/start`);
  const before = await waitForJson(`${gameBase}/state`);
  assert.equal(before.players.p1.kind, "human");
  const startX = before.paddles.p1.x;

  await Promise.all([
    host.goto(`${staticServer.origin}/test_harness.html`),
    guest.goto(`${staticServer.origin}/test_harness.html`),
  ]);
  await Promise.all([
    host.waitForFunction(() => window.AXM_READY === true),
    guest.waitForFunction(() => window.AXM_READY === true),
  ]);

  const offer = await host.evaluate(async () => {
    window.peer = window.bridge.createRemoteSeatPeer(window.cityBrowserDirect);
    return window.peer.createOffer({ expiresInSeconds: 60 });
  });
  const answer = await guest.evaluate(async (token) => {
    window.peer = window.bridge.createRemoteSeatPeer(window.cityBrowserDirect);
    return window.peer.acceptOffer(token);
  }, offer);
  await host.evaluate((token) => window.peer.acceptAnswer(token), answer);
  await Promise.all([
    host.evaluate(() => window.peer.waitForOpen()),
    guest.evaluate(() => window.peer.waitForOpen()),
  ]);

  await host.evaluate((baseUrl) => {
    window.admission = new window.bridge.RemoteSeatAdmission({
      peer: window.peer,
      sessionId: "browser-seat-ci",
      allowedPlayers: ["p1"],
      submitInput: window.bridge.createLoopbackRoboPongSubmitter({ baseUrl }),
    });
  }, `${gameBase}/`);

  await guest.evaluate(() => {
    const envelope = window.bridge.createSeatInputEnvelope({
      sessionId: "browser-seat-ci",
      player: "p1",
      sequence: 1,
      right: true,
    });
    window.bridge.sendRemoteSeatInput(window.peer, envelope);
  });
  const receipt = await host.evaluate(() => window.admission.receiveOnce());
  assert.equal(receipt.status, "ACCEPTED_INPUT_SUBMISSION");
  assert.equal(receipt.player, "p1");
  assert.equal(receipt.sequence, 1);
  assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/u);

  await new Promise((resolve) => setTimeout(resolve, 200));
  const moved = await waitForJson(`${gameBase}/state`);
  assert.ok(moved.paddles.p1.x > startX + 20, `expected browser-direct p1 input to move paddle right from ${startX}, got ${moved.paddles.p1.x}`);

  await guest.evaluate(() => {
    const envelope = window.bridge.createSeatInputEnvelope({
      sessionId: "browser-seat-ci",
      player: "p1",
      sequence: 2,
    });
    window.bridge.sendRemoteSeatInput(window.peer, envelope);
  });
  await host.evaluate(() => window.admission.receiveOnce());

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    status: "PASS",
    provider: "axm.browser-direct/v1",
    game: "axm.local-game-hub.robo-pong-cross",
    build: health.version,
    player: "p1",
    startX,
    movedX: moved.paddles.p1.x,
    directOnly: true,
  }));
} finally {
  await browser.close();
  await new Promise((resolve) => staticServer.server.close(resolve));
  gameChild.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => gameChild.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (gameChild.exitCode === null && gameChild.signalCode === null) gameChild.kill("SIGKILL");
  if (gameStderr) process.stderr.write(gameStderr);
}
