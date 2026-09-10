import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as cityBrowserDirect from "axm-city-browser-direct";
import {
  RemoteSeatAdmission,
  createLoopbackRoboPongSubmitter,
  createRemoteSeatPeer,
  createSeatInputEnvelope,
  sendRemoteSeatInput,
} from "../integrations/city-browser-direct/robo-pong-remote-seat.mjs";

// Test-only simulated RTC adapted from axm-city-multiplayer
// browser/tests/manual_webrtc.test.mjs at provider head
// 256f670d832633159a3d91b9e4f522a438e966b4 (Apache-2.0).
class FakeChannel extends EventTarget {
  constructor(label) { super(); this.label = label; this.readyState = "connecting"; this.peer = null; }
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
  send(data) { queueMicrotask(() => this.peer.dispatchEvent(new MessageEvent("message", { data }))); }
  close() { this.readyState = "closed"; }
}

const registry = new Map();
let nextId = 1;
class FakeRTC extends EventTarget {
  constructor(config) {
    super();
    assert.deepEqual(config, { iceServers: [] });
    this.id = String(nextId++);
    this.iceGatheringState = "complete";
    this.connectionState = "new";
    this.localDescription = null;
    this.hostChannel = null;
    registry.set(this.id, this);
  }
  createDataChannel(label) { this.hostChannel = new FakeChannel(label); return this.hostChannel; }
  async createOffer() { return { type: "offer", sdp: `offer:${this.id}` }; }
  async createAnswer() { return { type: "answer", sdp: `answer:${this.remoteId}:${this.id}` }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) {
    if (value.type === "offer") {
      this.remoteId = value.sdp.split(":")[1];
      const host = registry.get(this.remoteId);
      this.guestChannel = new FakeChannel(host.hostChannel.label);
      host.hostChannel.peer = this.guestChannel;
      this.guestChannel.peer = host.hostChannel;
      queueMicrotask(() => this.dispatchEvent(Object.assign(new Event("datachannel"), { channel: this.guestChannel })));
    } else {
      const [, hostId, guestId] = value.sdp.split(":");
      assert.equal(hostId, this.id);
      const guest = registry.get(guestId);
      this.connectionState = guest.connectionState = "connected";
      this.hostChannel.open();
      guest.guestChannel.open();
    }
  }
  close() { this.connectionState = "closed"; }
}

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

function hubRoot() {
  const configured = process.env.AXM_HUB_ROOT;
  if (configured) return path.resolve(configured);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

test("installed City browser transport drives one ordinary Robo Pong Cross seat", { timeout: 15000 }, async () => {
  const port = await findFreePort();
  const serverPath = path.join(hubRoot(), "games/003-robo-pong-cross/runtime/robo-pong-cross-server.cjs");
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      AXM_ROBO_PONG_HOST: "127.0.0.1",
      PORT: String(port),
      AXM_PLAYERS_JSON: JSON.stringify([
        { display_name: "Remote", type: "human" },
        { display_name: "Nova", type: "adapter" },
        { display_name: "Gemini", type: "adapter" },
        { display_name: "Codex", type: "adapter" },
      ]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    const base = `http://127.0.0.1:${port}`;
    const health = await waitForJson(`${base}/health`);
    assert.equal(health.version, "0.1.1-cross");
    await postJson(`${base}/start`);
    const before = await waitForJson(`${base}/state`);
    assert.equal(before.players.p1.kind, "human");
    const startX = before.paddles.p1.x;

    const host = createRemoteSeatPeer(cityBrowserDirect, { rtcFactory: FakeRTC });
    const guest = createRemoteSeatPeer(cityBrowserDirect, { rtcFactory: FakeRTC });
    const offer = await host.createOffer({ expiresInSeconds: 60 });
    const answer = await guest.acceptOffer(offer);
    await host.acceptAnswer(answer);
    await Promise.all([host.waitForOpen(), guest.waitForOpen()]);

    const admission = new RemoteSeatAdmission({
      peer: host,
      sessionId: "hub-seat-ci",
      allowedPlayers: ["p1"],
      submitInput: createLoopbackRoboPongSubmitter({ baseUrl: `${base}/` }),
    });

    const move = createSeatInputEnvelope({ sessionId: "hub-seat-ci", player: "p1", sequence: 1, right: true });
    sendRemoteSeatInput(guest, move);
    const moveReceipt = await admission.receiveOnce();
    assert.equal(moveReceipt.player, "p1");
    assert.equal(moveReceipt.sequence, 1);
    assert.equal(moveReceipt.authority.gameRuleMutation, false);

    await new Promise((resolve) => setTimeout(resolve, 180));
    const moved = await waitForJson(`${base}/state`);
    assert.ok(moved.paddles.p1.x > startX + 20, `expected remote p1 input to move paddle right from ${startX}, got ${moved.paddles.p1.x}`);

    const stop = createSeatInputEnvelope({ sessionId: "hub-seat-ci", player: "p1", sequence: 2 });
    sendRemoteSeatInput(guest, stop);
    await admission.receiveOnce();

    sendRemoteSeatInput(guest, stop);
    await assert.rejects(() => admission.receiveOnce(), (error) => error.code === "REPLAYED_INPUT");

    host.close();
    guest.close();
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (stderr) process.stderr.write(stderr);
  }
});
