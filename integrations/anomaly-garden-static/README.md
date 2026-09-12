# Anomaly Garden static consumer

This is an optional Local Game Hub consumer for the completed Anomaly Garden v0.16 browser world.

It does **not** copy Anomaly Garden into this repository, add it to the Hub catalog, download it, install it, or make it a default runtime. The operator supplies one explicit local Git checkout. The bridge admits only the pinned provider revision from `contract.json`, verifies the provider package identity and clean tracked runtime bytes, derives the browser runtime closure from local HTML/CSS references, and serves only those admitted files on `127.0.0.1`.

## Verify an explicit provider checkout

```text
node integrations/anomaly-garden-static/bridge.cjs verify /absolute/path/to/axm-anomaly-garden
```

A matching clean checkout returns `READY` plus deterministic file, closure, provenance, and receipt hashes. A missing provider, wrong Git revision, tracked drift, symlinked runtime file, unsafe path, external runtime reference, incompatible package identity, or widened bridge contract returns `HOLD`.

## Run the admitted browser world

```text
node integrations/anomaly-garden-static/bridge.cjs serve /absolute/path/to/axm-anomaly-garden
```

The bridge prints a loopback URL and keeps serving until it is stopped. The HTTP surface is GET/HEAD only, serves only the verified runtime closure, rechecks each file against its admitted byte/hash identity on every request, and sends a content policy that refuses runtime network connections.

## Exact provider evidence for v0.1

- provider repository: `mike-axiom-mir/axm-anomaly-garden`
- pinned provider commit: `e9af55a1d1494f3d4f639e16b3bb06279ae8c4ea`
- provider package identity: `axm-anomaly-garden@0.16.0`
- provider browser entry: `index.html`
- provider license/provenance inputs retained in the admission receipt: `LICENSE`, `THIRD_PARTY.json`, `README.md`, `package.json`

CI checks out that exact provider commit, runs the provider's complete deterministic regression suite and completion study, verifies the bridge, then loads the admitted world through this bridge in real Chromium and performs real Step + anomaly intervention actions.

## Authority boundary

The bridge has no catalog mutation, automatic provider discovery, download, install, provider-source mutation, merge, or CANON authority. It does not authenticate provider authorship merely because Git/SHA-256 identities match. The pinned Git commit is a content/lineage selection boundary; Mike remains the merge/CANON gate.

This v0.1 bridge is intentionally outside the sealed `0.1.0-proof-of-start` four-game distribution. It is reviewable post-seal integration work, not a silent reseal or a claim that Anomaly Garden is already a fifth canonical Hub game.
