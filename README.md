# AXM Local Game Hub

**EXPERIMENTAL proof of start** — a small, self-contained local game-night
launcher from the AXM Collaboration Platform.

One computer hosts the game. Friends or family can join supported games with
phones on the same trusted Wi-Fi by scanning the visible seat QR codes.

## What is included

- Robo Pong for familiar local two-player play
- Robo Pong Cross for three- or four-player play
- Lumenwake cooperative play
- Pulse Choir cooperative rhythm play
- QR phone-controller routing
- a Node.js built-in local run engine

The games are young. Their original `WORKING TEST`, `PLAYABLE ALPHA`, or other
experimental labels remain visible. This repository proves a usable local
route; it does not claim the catalog is finished.

## Start on one computer

1. Install Node.js 18 or newer.
2. Download or clone this repository.
3. Double-click `START_GAME_HUB.cmd` on Windows.
4. Choose a game in the page that opens.

No npm install, account, subscription, cloud service, telemetry, or internet
connection is required after download.

## Start a local game night with phones

1. Put the host computer and phones on the same trusted Wi-Fi.
2. Double-click `START_LAN_GAME_NIGHT.cmd`.
3. If Windows Firewall asks, allow Node.js only on **private** networks.
4. Choose a game and open its shared game screen.
5. Let each player scan one visible seat QR code.

LAN mode deliberately makes the game reachable by devices on the same network.
Do not enable it on an untrusted public Wi-Fi network.

## Package truth

- Current version: `0.1.0-proof-of-start`
- Runtime dependency: Node.js 18+ only
- Active-game limit: one game at a time
- Internet required while playing: no
- Account required: no
- Telemetry: no
- Physical-phone and low-end-hardware coverage: still needs broader real-device
  testing

`FILE_INTEGRITY.json` records the SHA-256 digest of every assembled file, and
`BUILD_RECEIPT.json` records the exact focused source selection.

Read [LICENSE_STATUS.md](LICENSE_STATUS.md) before redistributing or
incorporating the package into another product.

## Optional Causal Loop capability

The Hub can consume the deterministic train-platform process adapter proposed
in `mike-axiom-mir/axm-casual-loop` PR #8. This is an optional local lab
boundary, not a fifth bundled game: the four-game catalog and one-active-game
rule remain unchanged.

Set `AXM_CAUSAL_LOOP_ENTRY` to the adapter's absolute
`scripts/causal_loop_ndjson.py` path before starting the Hub. Set
`AXM_CAUSAL_LOOP_PYTHON` only when `python3` is not the right Python 3.11+
executable. Then use:

- `GET /api/capabilities/causal-loop` to inspect compatibility;
- `POST /api/capabilities/causal-loop/run` with `timedInfluences` and optional
  `maxWaves` to run and immediately replay-verify a receipt.

The provider is started without a shell and receives only a small runtime
environment allowlist. Missing, malformed, timed-out, or incompatible providers
return an explicit `HOLD`; normal Hub startup and bundled games keep working.
Read [docs/CAUSAL_LOOP_PROVIDER.md](docs/CAUSAL_LOOP_PROVIDER.md) for the exact
contract, example, and trust boundary.
