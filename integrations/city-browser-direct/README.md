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

## Consumer shape

Import the reviewed provider module and this adapter into the **local host
browser**. Then create the host peer and explicitly admit only the seat(s) you
intend to expose:

```js
import * as cityBrowserDirect from "./manual_webrtc.mjs";
import {
  RemoteSeatAdmission,
  createLoopbackRoboPongSubmitter,
  createRemoteSeatPeer,
} from "./robo-pong-remote-seat.mjs";

const peer = createRemoteSeatPeer(cityBrowserDirect);
const offerToken = await peer.createOffer({ expiresInSeconds: 600 });
// Send offerToken to the intended remote player and paste their answer into:
// await peer.acceptAnswer(answerToken); await peer.waitForOpen();

const admission = new RemoteSeatAdmission({
  peer,
  sessionId: "a caller-chosen application session id",
  allowedPlayers: ["p1"],
  submitInput: createLoopbackRoboPongSubmitter({
    baseUrl: "http://127.0.0.1:8793/",
  }),
});

// Deliberate receive/admit step; no background auto-admission is created.
const receipt = await admission.receiveOnce();
```

The remote side creates input with `createSeatInputEnvelope(...)` and sends it
through `sendRemoteSeatInput(...)`. Every envelope binds the exact game/build,
caller-chosen application session, selected seat, and a strictly increasing
per-seat sequence number. Replayed/out-of-order input is rejected before the
local game endpoint is called.

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

`iceServers: []` remains deliberate. Direct routing can fail, especially across
NAT/CGNAT/firewalls; `DIRECT_CONNECTION_UNAVAILABLE` is an honest outcome. No
relay is silently introduced.

The bridge has no automatic provider selection/install, game-rule or package
rewrite, merge, release, promotion, or CANON authority. Merge/integration is
governed by the repository `AGENTS.md` root gate and evidence available at the
current state.

## MergeAgent revalidation

On 2026-09-12 this lane was retargeted onto the consolidated Local Game Hub
technical main line. This documentation-only reconciliation commit exists to
force fresh pull-request verification against that current base; it does not
widen the bridge's runtime authority or default activation surface.
