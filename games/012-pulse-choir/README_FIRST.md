# Pulse Choir

Pulse Choir is a compact, playable Game Night prototype built from the Run 111 Game Production Atlas.

Player promise: **read the room, build a shared rhythm, and turn one synchronized decision into a spectacular team payoff.**

After the opening round, the server-owned **LIVE CONDUCTOR** reads the bounded show receipt and announces why the next three-act Setlist is an OPENING, RECONNECT, LOCK-IN, or HEADLINER plan. Its cue, reason, and exact acts appear before the room starts; this is deterministic authored adaptation, not opaque machine learning.

Human seats can then steer that transparent next-round plan with **ROOM SIGNAL**. Each human gets one replaceable vote for TOGETHER, BOLD, or FLOW; the host resolves the tally with a stable tie order, shows the winning count and reason on both surfaces, and locks the exact three acts before Start. AI seats cannot vote.

The upgraded 30-second truth is:

`move → collect distinct beats → bank safely or complete a TRIAD → chain the multiplier → pulse together → earn shields → survive the next glitch`

Gameplay stakes:

- Banking one or two beats is fast and safe.
- Carrying Spark + Chord + Wild creates a TRIAD worth a large score and charge bonus, but a full carry slows you down.
- Banking again within 6.5 seconds raises the room multiplier.
- Taking an unshielded glitch hit breaks the chain.
- A perfect synchronized surge gives every player a one-hit choir shield.

Start it through Game Hub, or run it directly:

```powershell
$env:PORT=8802
node runtime/server.js
```

Then open `http://127.0.0.1:8802/`. The direct-development roster contains one human and two AI seats. Game Hub owns the real selected roster when it launches the package.

## Restart truth

Pulse Choir writes local `axm.pulse-choir-checkpoint/v2` envelopes. The state and
the complete checkpoint metadata have separate SHA-256 bindings. On restart the
server verifies both bindings, the roster identity, the state contract, the
expiry window, and the exact envelope shape before resuming play.

Malformed, altered, wrong-roster, or future-dated checkpoints enter a write
hold. Routine ticks and shutdown autosaves cannot overwrite those bytes. The
existing explicit **New Show** action releases the hold by preserving the exact
rejected bytes under a content-addressed local quarantine name before creating
fresh state. Recovery status exposes only the quarantine filename, never its
absolute host path.

Legacy v1 checkpoints remain loadable after structural validation, but their
unsealed origin is labeled `migrated-unsealed-v1`; the next successful save
converges them to v2. Hashes provide local integrity evidence, not signatures,
account identity, or authority.

Keyboard controls on the shared screen:

- P1: `WASD` + `Space`
- P2: arrow keys + `Enter`
- P3: `IJKL` + `O`
- P4: numpad `8456` + numpad `0`
- `H`: help, `M`: reduced motion, `C`: high contrast, `Esc`: close an overlay

The phone controller uses a touch joystick, one large PULSE button, and the three ROOM SIGNAL choices while waiting between rounds. It is browser-viewport tested; physical-phone QA remains pending.

This is a playable adaptive alpha, not a claim of finished balance or proven replay value. Its deterministic rules, transparent Conductor, server authority, manifest, HTTP lifecycle, responsive surfaces, authored arena art, and shortest player journey are verifiable. Human playtest judgment remains the next gate.
