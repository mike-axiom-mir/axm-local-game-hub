# Optional Causal Loop provider

This bridge consumes, but does not copy, the Causal Loop train-platform engine.
It was tested against `mike-axiom-mir/axm-casual-loop` PR #8 at exact head
`cb2793fbb48efd750670bd9d08abe5a0bfa233df`. The machine-readable consumer
declaration is `integrations/causal-loop-consumer-v1.json`.

## Configure locally

The provider requires Python 3.11 or newer. Point the Hub at an explicitly
reviewed checkout:

```text
AXM_CAUSAL_LOOP_ENTRY=/absolute/path/to/axm-casual-loop/scripts/causal_loop_ndjson.py
AXM_CAUSAL_LOOP_PYTHON=python3
```

`AXM_CAUSAL_LOOP_ENTRY` is required and must name an absolute, regular `.py`
file. Symbolic links fail closed. `AXM_CAUSAL_LOOP_PYTHON` is optional and
defaults to `python3`. The Hub uses argument-vector process spawning, never a
shell command string.

Configuration does not alter `catalog.json`, add a bundled game, consume the
active-game slot, or make the provider mandatory. Without configuration the
discovery route returns `provider_not_configured` with status `HOLD`.

## Discover, run, and verify

Inspect the live provider contract:

```text
GET /api/capabilities/causal-loop
```

The Hub admits only the pinned v1 NDJSON schemas, train-platform loop/version,
engine signature, action list, limits, deterministic/offline properties, and
non-authoritative flags.

Run a bounded scenario:

```json
{
  "timedInfluences": [
    { "atWave": 2, "action": "BLOCK_DOOR" },
    { "atWave": 3, "action": "TRIGGER_ALARM" }
  ],
  "maxWaves": 64
}
```

Send it to:

```text
POST /api/capabilities/causal-loop/run
```

The Hub first performs live capability discovery, then requests an uncommitted
run receipt, then makes a separate provider invocation to replay-verify that
receipt. The result is `PASS` only when the receipt hashes and replay response
agree. Identical scenarios retain identical provider input and receipt hashes.

## Failure and trust boundary

Invalid input, missing configuration, unsafe entry paths, incompatible live
descriptors, spawn failures, timeouts, oversized output, malformed NDJSON, and
run/verification disagreement return `HOLD`. A provider process receives only
`PATH`, basic OS/temp/home variables, and Python encoding controls from the Hub;
unrelated Hub environment variables are not forwarded.

This is local process interoperability, not hostile-code isolation. Descriptor
and replay agreement prove behavior claimed by that configured process; they do
not prove authorship or make an unreviewed provider safe. The bridge does not
commit history, write canonical Hub/game state, merge work, or declare CANON.
