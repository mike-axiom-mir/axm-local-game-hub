# AXM Local Game Hub

[![Apache License 2.0](https://img.shields.io/badge/license-Apache--2.0-3b82f6)](LICENSE) ![Local first](https://img.shields.io/badge/local--first-yes-16a085) ![Status experimental](https://img.shields.io/badge/status-experimental-f59e0b)

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

Repository content is licensed under the [Apache License 2.0](LICENSE), except
where a file or preserved third-party notice states otherwise. Read
[LICENSE_STATUS.md](LICENSE_STATUS.md) for the exact boundary.

Explore the wider family in the [AXM Public Project Map](https://github.com/mike-axiom-mir/axm-collaboration-platform/blob/main/docs/PUBLIC_PROJECTS.md).

