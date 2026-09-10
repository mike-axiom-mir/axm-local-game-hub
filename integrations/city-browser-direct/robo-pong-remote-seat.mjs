const PROVIDER_ID = "axm.browser-direct/v1";
const BRIDGE_SCHEMA = "axm.local-game-hub.remote-seat-input/v0.1";
const RECEIPT_SCHEMA = "axm.local-game-hub.remote-seat-admission/v0.1";
const GAME_ID = "axm.local-game-hub.robo-pong-cross";
const GAME_BUILD = "0.1.1-cross";
const MAX_ENVELOPE_BYTES = 4096;
const PLAYER_IDS = new Set(["p1", "p2", "p3", "p4"]);
const ENVELOPE_KEYS = ["build", "gameId", "input", "player", "schema", "sequence", "sessionId"];
const INPUT_KEYS = ["left", "power", "right"];

export class RemoteSeatBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RemoteSeatBridgeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RemoteSeatBridgeError(code, message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_REMOTE_INPUT", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_REMOTE_INPUT", `${label} fields do not match the v0.1 contract`);
  }
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    fail("INVALID_REMOTE_INPUT", `${name} must be 1-128 characters`);
  }
  return value;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) fail("CRYPTO_UNAVAILABLE", "Web Crypto SHA-256 is unavailable");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertCityBrowserDirectProvider(provider) {
  if (!provider || typeof provider.ManualBrowserPeer !== "function" || typeof provider.describeBrowserDirectCapability !== "function") {
    fail("PROVIDER_UNAVAILABLE", "axm-city-browser-direct provider exports are unavailable");
  }
  const descriptor = provider.describeBrowserDirectCapability();
  const valid = descriptor
    && descriptor.id === PROVIDER_ID
    && descriptor.signaling === "manual-copy-paste"
    && descriptor.transport === "WebRTC-DataChannel"
    && Array.isArray(descriptor.iceServers)
    && descriptor.iceServers.length === 0
    && descriptor.relayFallback === false
    && descriptor.accountRequired === false
    && descriptor.failureCode === "DIRECT_CONNECTION_UNAVAILABLE"
    && descriptor.limits?.tokenBytes === 65536
    && descriptor.limits?.messageBytes === 65536;
  if (!valid) fail("INCOMPATIBLE_PROVIDER", "browser-direct provider contract does not match the reviewed v1 boundary");
  return descriptor;
}

export function describeRemoteSeatBridge(provider) {
  const providerDescriptor = assertCityBrowserDirectProvider(provider);
  return {
    schema: BRIDGE_SCHEMA,
    status: "EXPERIMENTAL",
    game: { id: GAME_ID, build: GAME_BUILD },
    provider: providerDescriptor,
    transportUse: "one-explicit-remote-seat-input-envelope-at-a-time",
    gameAdmission: "existing-robo-pong-cross-/input-route",
    defaultEnabled: false,
    providerInstallAutomatic: false,
    seatAssignmentAutomatic: false,
    relayFallback: false,
    accountRequired: false,
    authority: {
      inputSubmission: "EXPLICIT_SELECTED_SEAT_ONLY",
      gameRuleMutation: false,
      gamePackageMutation: false,
      merge: false,
      canon: false,
    },
  };
}

export function createRemoteSeatPeer(provider, { rtcFactory, iceTimeoutMs = 5000 } = {}) {
  assertCityBrowserDirectProvider(provider);
  return new provider.ManualBrowserPeer({ gameId: GAME_ID, build: GAME_BUILD, rtcFactory, iceTimeoutMs });
}

export function createSeatInputEnvelope({ sessionId, player, sequence, left = false, right = false, power = false }) {
  requiredText(sessionId, "sessionId");
  if (!PLAYER_IDS.has(player)) fail("INVALID_REMOTE_INPUT", "player must be p1, p2, p3, or p4");
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail("INVALID_REMOTE_INPUT", "sequence must be a positive safe integer");
  for (const [name, value] of Object.entries({ left, right, power })) {
    if (typeof value !== "boolean") fail("INVALID_REMOTE_INPUT", `${name} must be boolean`);
  }
  const envelope = {
    schema: BRIDGE_SCHEMA,
    gameId: GAME_ID,
    build: GAME_BUILD,
    sessionId,
    player,
    sequence,
    input: { left, right, power },
  };
  if (new TextEncoder().encode(stableJson(envelope)).byteLength > MAX_ENVELOPE_BYTES) {
    fail("INVALID_REMOTE_INPUT", "remote input envelope exceeds 4 KiB");
  }
  return envelope;
}

export function validateSeatInputEnvelope(value, { sessionId, allowedPlayers } = {}) {
  exactKeys(value, ENVELOPE_KEYS, "remote input envelope");
  exactKeys(value.input, INPUT_KEYS, "remote input payload");
  if (value.schema !== BRIDGE_SCHEMA || value.gameId !== GAME_ID || value.build !== GAME_BUILD) {
    fail("WRONG_GAME_BUILD", "remote input does not target the reviewed Robo Pong Cross build");
  }
  requiredText(value.sessionId, "sessionId");
  if (sessionId !== undefined && value.sessionId !== sessionId) fail("WRONG_SESSION", "remote input session does not match");
  if (!PLAYER_IDS.has(value.player)) fail("INVALID_REMOTE_INPUT", "player must be p1, p2, p3, or p4");
  if (allowedPlayers && !allowedPlayers.has(value.player)) fail("SEAT_NOT_ADMITTED", "remote input targets a seat not admitted by this bridge");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail("INVALID_REMOTE_INPUT", "sequence must be a positive safe integer");
  for (const key of INPUT_KEYS) if (typeof value.input[key] !== "boolean") fail("INVALID_REMOTE_INPUT", `${key} must be boolean`);
  if (new TextEncoder().encode(stableJson(value)).byteLength > MAX_ENVELOPE_BYTES) fail("INVALID_REMOTE_INPUT", "remote input envelope exceeds 4 KiB");
  return value;
}

export function sendRemoteSeatInput(peer, envelope) {
  if (!peer || typeof peer.send !== "function") fail("PROVIDER_UNAVAILABLE", "browser-direct peer send boundary is unavailable");
  validateSeatInputEnvelope(envelope);
  peer.send(envelope);
}

function normalizeAllowedPlayers(values) {
  const selected = new Set(values || []);
  if (!selected.size) fail("SEAT_NOT_ADMITTED", "at least one explicit remote seat must be admitted");
  for (const player of selected) if (!PLAYER_IDS.has(player)) fail("SEAT_NOT_ADMITTED", "allowed remote seats must be p1-p4");
  return selected;
}

async function sealReceipt(body) {
  const canonical = stableJson(body);
  return { ...body, receiptSha256: await sha256Hex(canonical) };
}

export class RemoteSeatAdmission {
  constructor({ peer, sessionId, allowedPlayers, submitInput }) {
    if (!peer || typeof peer.receive !== "function") fail("PROVIDER_UNAVAILABLE", "browser-direct peer receive boundary is unavailable");
    requiredText(sessionId, "sessionId");
    if (typeof submitInput !== "function") fail("INVALID_CONFIGURATION", "submitInput must be a function");
    this.peer = peer;
    this.sessionId = sessionId;
    this.allowedPlayers = normalizeAllowedPlayers(allowedPlayers);
    this.submitInput = submitInput;
    this.lastSequence = new Map();
  }

  async receiveOnce(timeoutMs = 10000) {
    const envelope = validateSeatInputEnvelope(await this.peer.receive(timeoutMs), {
      sessionId: this.sessionId,
      allowedPlayers: this.allowedPlayers,
    });
    const previous = this.lastSequence.get(envelope.player) || 0;
    if (envelope.sequence <= previous) fail("REPLAYED_INPUT", "remote input sequence is not newer than the last admitted input");

    const result = await this.submitInput({ player: envelope.player, input: envelope.input });
    if (!result || result.ok !== true || result.player !== envelope.player) {
      fail("GAME_INPUT_REJECTED", "Robo Pong Cross did not admit the selected seat input");
    }
    this.lastSequence.set(envelope.player, envelope.sequence);

    const body = {
      schema: RECEIPT_SCHEMA,
      status: "ACCEPTED_INPUT_SUBMISSION",
      providerCapability: PROVIDER_ID,
      gameId: GAME_ID,
      build: GAME_BUILD,
      sessionId: this.sessionId,
      player: envelope.player,
      sequence: envelope.sequence,
      input: envelope.input,
      target: "robo-pong-cross:/input",
      authority: {
        seatAssignmentAutomatic: false,
        gameRuleMutation: false,
        gamePackageMutation: false,
        merge: false,
        canon: false,
      },
    };
    return sealReceipt(body);
  }
}

function loopbackBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("INVALID_GAME_ENDPOINT", "game endpoint must be an absolute loopback URL"); }
  const allowedHost = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !allowedHost || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    fail("INVALID_GAME_ENDPOINT", "game endpoint must be plain HTTP on loopback with no credentials/path/query/fragment");
  }
  return url;
}

export function createLoopbackRoboPongSubmitter({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 3000 }) {
  const base = loopbackBaseUrl(baseUrl);
  if (typeof fetchImpl !== "function") fail("INVALID_CONFIGURATION", "fetch is unavailable");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) fail("INVALID_CONFIGURATION", "timeoutMs must be 100-30000");

  return async ({ player, input }) => {
    validateSeatInputEnvelope(createSeatInputEnvelope({ sessionId: "loopback-validation", player, sequence: 1, ...input }));
    const target = new URL(`/input?player=${encodeURIComponent(player)}`, base);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ left: input.left, right: input.right, power: input.power }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) fail("GAME_INPUT_TIMEOUT", "Robo Pong Cross input admission timed out");
      fail("GAME_INPUT_UNAVAILABLE", `Robo Pong Cross input admission failed: ${error?.message || "unknown error"}`);
    } finally {
      clearTimeout(timer);
    }
    let payload;
    try { payload = await response.json(); } catch { fail("GAME_INPUT_REJECTED", "Robo Pong Cross returned non-JSON input evidence"); }
    if (!response.ok || payload?.ok !== true || payload?.player !== player) fail("GAME_INPUT_REJECTED", "Robo Pong Cross rejected the selected seat input");
    return { ok: true, player };
  };
}

export const REMOTE_SEAT_CONTRACT = Object.freeze({
  providerId: PROVIDER_ID,
  bridgeSchema: BRIDGE_SCHEMA,
  receiptSchema: RECEIPT_SCHEMA,
  gameId: GAME_ID,
  gameBuild: GAME_BUILD,
  maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
});
