# Optional City browser-direct remote seat bridge

Status: **EXPERIMENTAL / explicit opt-in**.

This bridge connects one reviewed capability from `axm-city-multiplayer` to an
existing Local Game Hub player door. It does not add a second network stack and
it does not change Robo Pong Cross physics or seat rules.

## Exact provider

- repository: `mike-axiom-mir/axm-city-multiplayer`
- historical evidence PR: `#18` — `Package the direct browser transport for clean local consumers`
- exact provider-package head used by this proof: `256f670d832633159a3d91b9e4f522a438e966b4`
- package: `axm-city-browser-direct@0.1.0`
- capability: `axm.browser-direct/v1`
- underlying reviewed browser transport head: `4f317c7c3e1b163a48dcbff3ea612bc04846cb1a`
- license: Apache-2.0

The provider work was later consolidated into the City Multiplayer main line;
this integration keeps its exact historical evidence pin so the published proof
remains reproducible. No provider bytes are vendored into this repository. The
provider package must be deliberately obtained from reviewed source bytes (or a
later head that is separately reviewed and adapted). Nothing here discovers,
installs, or executes a provider automatically.

## What the bridge actually does

The City provider owns manual copy/paste WebRTC signaling and one direct ordered
DataChannel with **no STUN, TURN, relay, rendezvous, account, or cloud fallback**.
This adapter owns only a small application envelope on that channel:

`remote browser input -> exact session/seat/sequence admission -> existing Robo Pong Cross POST /input route`

The local game still decides whether the selected seat is human-controlled and
whether the input is accepted. An accepted input can affect live game state in
the same way as an ordinary local controller input; the bridge does not gain a
separate game-mutation API.

Replay state is deliberately owned by the caller's application session, not by
one WebRTC peer object. Replacing a failed/disconnected peer therefore must
reuse the same `sequenceState`. An admission without that explicit state fails
closed with `REPLAY_STATE_REQUIRED`.

The sequence is consumed **before** the bridge crosses the game-submission
side-effect boundary. If the game changed state but its acknowledgement was
lost, the same sequence cannot be retried through a replacement peer and apply
the input a second time. A definitely rejected or unavailable submission also
consumes that sequence; the sender must advance to a newer sequence.

## Consumer shape

Import the reviewed provider module and this adapter into the **local host
browser**. Create one caller-owned sequence state for the application session,
then reuse it whenever the direct peer is replaced:

```js
import * as cityBrowserDirect from "./manual_webrtc.mjs";
import {
  RemoteSeatAdmission,
  createLoopbackRoboPongSubmitter,
  createRemoteSeatPeer,
  createRemoteSeatSequenceState,
} from "./robo-pong-remote-seat.mjs";

const sequenceState = createRemoteSeatSequenceState({
  sessionId: "a caller-chosen application session id",
  allowedPlayers: ["p1"],
});

const peer = createRemoteSeatPeer(cityBrowserDirect);
const offerToken = await peer.createOffer({ expiresInSeconds: 600 });
// Send offerToken to the intended remote player and paste their answer into:
// await peer.acceptAnswer(answerToken); await peer.waitForOpen();

const admission = new RemoteSeatAdmission({
  peer,
  sessionId: "a caller-chosen application session id",
  allowedPlayers: ["p1"],
  sequenceState,
  submitInput: createLoopbackRoboPongSubmitter({
    baseUrl: "http://127.0.0.1:8793/",
  }),
});

// Deliberate receive/admit step; no background auto-admission is created.
const receipt = await admission.receiveOnce();

// If the direct peer is replaced, construct the next admission with the same
// sequenceState. sequenceState.snapshot() returns an inspectable JSON-safe
// continuation record if the host chooses to store it explicitly.
```

The remote side creates input with `createSeatInputEnvelope(...)` and sends it
through `sendRemoteSeatInput(...)`. Every envelope binds the exact game/build,
caller-chosen application session, selected seat, and a strictly increasing
per-seat sequence number. Replayed/out-of-order input is rejected before the
local game endpoint is called, including after direct-peer replacement when the
same caller-owned sequence state is reused.

A sequence-state snapshot is schema/game/build/session/seat checked when
restored. It is not signed, freshness-authenticated, or automatically persisted.
Restoring an old-but-valid snapshot can therefore reopen older sequence
numbers. Process-crash-safe persistence and anti-rollback storage are outside
this bridge's demonstrated guarantee.

## Why the local endpoint is loopback-only

The bridge submits to Robo Pong Cross only through plain HTTP on
`127.0.0.1`, `localhost`, or `::1`. That keeps the WebRTC boundary responsible
for remote transport while the existing game server remains the player-input
admission authority on the host machine. This adapter refuses arbitrary remote
HTTP targets, paths, credentials, query strings, and fragments.

## Truth and security boundary

A successful receipt means a message crossed the selected direct DataChannel,
matched this bridge's exact session/seat/sequence contract, and was accepted by
the existing local input route. It does **not** authenticate the human behind a
browser, prove honest input, prove internet/NAT reachability, or grant a player
a different seat. Manual signaling tokens can expose network candidates to the
person receiving them.

The caller-owned sequence state demonstrates replay continuity across a
replacement direct peer while that state remains available. It does not prove
process-restart durability or freshness of a restored snapshot. Because sequence
consumption happens before game submission, an ambiguous outcome fails closed
against duplicate application but can intentionally sacrifice that one input.

`iceServers: []` remains deliberate. Direct routing can fail, especially across
NAT/CGNAT/firewalls; `DIRECT_CONNECTION_UNAVAILABLE` is an honest outcome. No
relay is silently introduced.

The bridge has no automatic provider selection/install, game-rule or package
rewrite, merge, release, promotion, or CANON authority. Merge/integration is
governed by the repository `AGENTS.md` root gate and evidence available at the
current state.

## MergeAgent revalidation

On 2026-09-12 this stacked replay-continuity lane was merged with the
consolidated Local Game Hub technical main line before integration review. That
preserves the original regression/repair history while ensuring inherited
workflows exercise the actual combined repository. This reconciliation does not
add a relay, widen seat authority, modify the canonical four-game catalog, or
turn the bridge on by default.
