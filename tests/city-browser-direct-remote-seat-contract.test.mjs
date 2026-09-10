import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RemoteSeatAdmission,
  RemoteSeatBridgeError,
  assertCityBrowserDirectProvider,
  createLoopbackRoboPongSubmitter,
  createSeatInputEnvelope,
  describeRemoteSeatBridge,
  validateSeatInputEnvelope,
} from "../integrations/city-browser-direct/robo-pong-remote-seat.mjs";

class FakePeer {
  constructor(messages = []) { this.messages = [...messages]; }
  async receive() {
    if (!this.messages.length) throw new Error("no fake message");
    return this.messages.shift();
  }
}

class FakeManualBrowserPeer {}
const goodProvider = {
  ManualBrowserPeer: FakeManualBrowserPeer,
  describeBrowserDirectCapability() {
    return {
      id: "axm.browser-direct/v1",
      signaling: "manual-copy-paste",
      transport: "WebRTC-DataChannel",
      iceServers: [],
      relayFallback: false,
      accountRequired: false,
      failureCode: "DIRECT_CONNECTION_UNAVAILABLE",
      limits: { tokenBytes: 65536, messageBytes: 65536 },
    };
  },
};

test("provider admission pins the reviewed direct-only boundary", () => {
  assert.equal(assertCityBrowserDirectProvider(goodProvider).id, "axm.browser-direct/v1");
  const bridge = describeRemoteSeatBridge(goodProvider);
  assert.equal(bridge.defaultEnabled, false);
  assert.equal(bridge.relayFallback, false);
  assert.equal(bridge.accountRequired, false);
  assert.equal(bridge.authority.inputSubmission, "EXPLICIT_SELECTED_SEAT_ONLY");
  assert.equal(bridge.authority.merge, false);
  assert.equal(bridge.authority.canon, false);
});

test("missing or widened providers fail closed", () => {
  assert.throws(() => assertCityBrowserDirectProvider(null), (error) => error instanceof RemoteSeatBridgeError && error.code === "PROVIDER_UNAVAILABLE");
  const widened = { ...goodProvider, describeBrowserDirectCapability: () => ({ ...goodProvider.describeBrowserDirectCapability(), relayFallback: true }) };
  assert.throws(() => assertCityBrowserDirectProvider(widened), (error) => error.code === "INCOMPATIBLE_PROVIDER");
});

test("remote seat envelopes use exact game, seat, type and field contracts", () => {
  const envelope = createSeatInputEnvelope({ sessionId: "session-a", player: "p2", sequence: 7, left: true, right: false, power: true });
  assert.equal(validateSeatInputEnvelope(envelope, { sessionId: "session-a", allowedPlayers: new Set(["p2"]) }), envelope);
  assert.throws(() => createSeatInputEnvelope({ sessionId: "s", player: "p9", sequence: 1 }), (error) => error.code === "INVALID_REMOTE_INPUT");
  assert.throws(() => createSeatInputEnvelope({ sessionId: "s", player: "p1", sequence: 1, left: 1 }), (error) => error.code === "INVALID_REMOTE_INPUT");
  assert.throws(() => validateSeatInputEnvelope({ ...envelope, extra: true }), (error) => error.code === "INVALID_REMOTE_INPUT");
  assert.throws(() => validateSeatInputEnvelope({ ...envelope, build: "other" }), (error) => error.code === "WRONG_GAME_BUILD");
});

test("admission accepts only explicitly selected seats and increasing sequences", async () => {
  const first = createSeatInputEnvelope({ sessionId: "session-b", player: "p1", sequence: 1, right: true });
  const replay = structuredClone(first);
  const wrongSeat = createSeatInputEnvelope({ sessionId: "session-b", player: "p2", sequence: 2, left: true });
  const peer = new FakePeer([first, replay, wrongSeat]);
  const submitted = [];
  const admission = new RemoteSeatAdmission({
    peer,
    sessionId: "session-b",
    allowedPlayers: ["p1"],
    submitInput: async (entry) => { submitted.push(entry); return { ok: true, player: entry.player }; },
  });
  const receipt = await admission.receiveOnce();
  assert.equal(receipt.status, "ACCEPTED_INPUT_SUBMISSION");
  assert.equal(receipt.player, "p1");
  assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/u);
  assert.equal(receipt.authority.seatAssignmentAutomatic, false);
  await assert.rejects(() => admission.receiveOnce(), (error) => error.code === "REPLAYED_INPUT");
  await assert.rejects(() => admission.receiveOnce(), (error) => error.code === "SEAT_NOT_ADMITTED");
  assert.equal(submitted.length, 1);
});

test("replacing the peer admission does not reopen an already consumed sequence", async () => {
  const envelope = createSeatInputEnvelope({ sessionId: "session-reconnect", player: "p1", sequence: 1, right: true });
  const submitted = [];
  const submitInput = async (entry) => { submitted.push(entry); return { ok: true, player: entry.player }; };

  const firstAdmission = new RemoteSeatAdmission({
    peer: new FakePeer([envelope]),
    sessionId: "session-reconnect",
    allowedPlayers: ["p1"],
    submitInput,
  });
  await firstAdmission.receiveOnce();

  const replacementAdmission = new RemoteSeatAdmission({
    peer: new FakePeer([structuredClone(envelope)]),
    sessionId: "session-reconnect",
    allowedPlayers: ["p1"],
    submitInput,
  });
  await assert.rejects(() => replacementAdmission.receiveOnce(), (error) => error.code === "REPLAYED_INPUT");
  assert.equal(submitted.length, 1);
});

test("wrong application session is rejected before game submission", async () => {
  const peer = new FakePeer([createSeatInputEnvelope({ sessionId: "wrong", player: "p1", sequence: 1, left: true })]);
  let calls = 0;
  const admission = new RemoteSeatAdmission({
    peer,
    sessionId: "expected",
    allowedPlayers: ["p1"],
    submitInput: async () => { calls += 1; return { ok: true, player: "p1" }; },
  });
  await assert.rejects(() => admission.receiveOnce(), (error) => error.code === "WRONG_SESSION");
  assert.equal(calls, 0);
});

test("game submission is confined to explicit loopback HTTP", async () => {
  assert.throws(() => createLoopbackRoboPongSubmitter({ baseUrl: "https://example.com/" }), (error) => error.code === "INVALID_GAME_ENDPOINT");
  assert.throws(() => createLoopbackRoboPongSubmitter({ baseUrl: "http://127.0.0.1:8793/admin" }), (error) => error.code === "INVALID_GAME_ENDPOINT");
  const calls = [];
  const submit = createLoopbackRoboPongSubmitter({
    baseUrl: "http://127.0.0.1:8793/",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, async json() { return { ok: true, player: "p4" }; } };
    },
  });
  assert.deepEqual(await submit({ player: "p4", input: { left: false, right: true, power: false } }), { ok: true, player: "p4" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8793/input?player=p4");
  assert.equal(calls[0].options.method, "POST");
});

test("machine-readable integration binding matches executable constants", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const record = JSON.parse(fs.readFileSync(path.join(here, "../integrations/city-browser-direct/integration.json"), "utf8"));
  const bridge = describeRemoteSeatBridge(goodProvider);
  assert.equal(record.provider.headCommit, "256f670d832633159a3d91b9e4f522a438e966b4");
  assert.equal(record.provider.capability, bridge.provider.id);
  assert.equal(record.consumer.game, bridge.game.id);
  assert.equal(record.consumer.gameBuild, bridge.game.build);
  assert.equal(record.bridge.relayFallback, bridge.relayFallback);
  assert.equal(record.authority.merge, false);
  assert.equal(record.authority.canon, false);
});
