# Capability discovery contract

This repository exposes a generated, machine-readable view of capabilities that are already declared by the Local Game Hub catalog and packaged game manifests.

The registry is **discovery evidence, not runtime proof or authority**. It does not make another AXM repository a runtime dependency, does not promote anything to CANON, and does not infer capabilities that are absent from the source manifests.

## Generated surfaces

- `registry/capabilities.jsonl` — one `axm.public-capability/v1` declaration per discovered capability.
- `registry/capabilities.receipt.json` — generator identity, canonical parsed-JSON hashes for `catalog.json` and each catalog game manifest, record count, and exact registry SHA-256.
- `.axm/discovery-public.json` — explicit consent for bounded public discovery of this already-public repository.

Regenerate locally with Node.js 18+:

```bash
node tools/generate-capability-registry.cjs
```

Verify that committed generated files still match the source state without rewriting them:

```bash
node tools/generate-capability-registry.cjs --check
```

The generator fails closed if a catalog game has an unsafe/path-like identifier, if a required manifest is missing, or if shared identity fields such as game id, slot, name, status, version, or player bounds disagree between catalog and manifest.

## What becomes discoverable

The generator derives bounded provider declarations from explicit booleans and verified manifest fields such as QR/LAN/room-code joining, input methods, adapter seats, result summaries, local authoritative state, disconnect recovery, and managed local launch.

When a manifest names an existing protocol such as `axm-semantic-input-v1` or `axm-seat-screen-semantics-v1`, the registry records the game as a **consumer** of that exact identifier instead of inventing a duplicate name. That makes provider/consumer matching possible across repository boundaries while the game remains independently runnable.

## Discovery Buddy compatibility

The JSONL shape follows the public capability registry already used by `mike-axiom-mir/axm-collaboration-platform`: every row carries `id`, `providers`, and `consumers`, plus explicit truth metadata.

The integration workflow additionally exercises the output against the dependency-free Discovery Buddy scanner from `mike-axiom-mir/axm-discovery-buddy` PR #5, pinned to commit `1a94fc2481d1cfc9234dea7c86af4777126d3924`. The pin is evidence of the tested consumer contract, not a runtime dependency. Updating that pin should be an explicit compatibility decision backed by a passing integration run.

## Truth boundary

A registry declaration means only that the current catalog/manifests declare the corresponding capability or protocol relationship and that generation completed deterministically. It does **not** prove device coverage, user experience quality, network reachability, safety, release readiness, or CANON status.
