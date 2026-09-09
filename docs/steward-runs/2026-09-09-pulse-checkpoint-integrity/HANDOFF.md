# Pulse Choir checkpoint integrity handoff

Status: **EXPERIMENTAL / HOLD for human review**

## Lane

- Repository: `mike-axiom-mir/axm-local-game-hub`
- Base: `main` at `3d228b2f6c6ac84c99a60bb74aba42145336f366`
- Branch: `automation/pulse-checkpoint-integrity-hold-20260909-1527`
- Scope: Pulse Choir same-host restart state only
- Merge, promotion, and CANON authority: none

## Reproduced truth gap

The exact base checkpoint writer emitted no state or envelope digest. After a
valid save, changing only `state.score` to `500` still produced a successful
restore:

```json
{"base":"3d228b2","stateDigestPresent":false,"tamperedScoreRestored":500,"status":"restored"}
```

Malformed or structurally invalid checkpoint bytes returned fresh runtime state
without blocking the server's ordinary listen/tick/shutdown autosaves. Those
autosaves could replace the rejected evidence.

## Implemented contract

- `axm.pulse-choir-checkpoint/v2` separately SHA-256-binds canonical state and
  the complete checkpoint envelope.
- Admission verifies exact fields, state shape, roster identity, time bounds,
  and both digests before resume.
- Rejected bytes enter a write hold; ordinary autosave cannot replace them.
- The existing explicit New Show action preserves held bytes under a
  content-addressed local quarantine filename before resetting.
- LAN-visible recovery state exposes the quarantine filename but never the
  absolute host path.
- Structurally valid v1 checkpoints are accepted with the explicit
  `migrated-unsealed-v1` label and converge to v2 on the next save.
- No account, network, cloud, telemetry, model, merge, or canonical authority
  was added.

## Evidence

- Focused integrity and mutation suite: 43 assertions pass.
- HTTP runtime restart/recovery suite: 11 assertions pass.
- Listen autosave hold, health projection, explicit New Show quarantine, and v2
  replacement are exercised through the real server boundary.
- JavaScript syntax, JSON parsing, changed distribution integrity entries, and
  `git diff --check`: pass.
- The repository's complete inherited `FILE_INTEGRITY.json` still reports its
  pre-existing `LICENSE_STATUS.md` mismatch. That file is unchanged here and
  open PR #5 owns the distribution-drift repair lane.
- Remote CI: pending at receipt commit; the pull-request report carries the
  exact-head result.

## Coordination

Immediate claim scans found no Pulse Choir checkpoint, restart, quarantine, or
autosave-integrity PR or branch. Open PR #2 is the catalog contract, #3 is
capability discovery, #4 is host-controller UX, and #5 is package-integrity
verification. This lane does not replace any of them.

## Known limit

SHA-256 detects mutation but is not a signature. A privileged local actor can
rewrite state and recompute hashes. Quarantine remains on the same device, and
there is no cross-machine recovery or automatic reconciliation.
