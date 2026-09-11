# Portable Causal Loop provider

This is an optional transfer boundary around the existing Local Game Hub Causal Loop consumer from PR #13. It lets a caller use the deterministic one-file provider from `mike-axiom-mir/axm-casual-loop` PR #17 without retaining the provider source checkout at consumption time.

The bridge is deliberately narrow:

```text
caller-selected causal-loop-process.pyz
  + caller-retained SHA-256
  -> exact local byte admission
  -> private staged copy
  -> existing Hub PR #13 descriptor gate
  -> existing Hub PR #13 run + independent replay verification
  -> sealed portable-consumer observation
```

It does not add Causal Loop to the four-game catalog, modify the active-game slot, discover/download/install a provider, or give a provider merge/CANON authority.

## Exact tested lineage

Consumer prerequisite:

- Local Game Hub PR #13 head `339156d99a752845587698f396c1a2e749ccaebe`;
- that lane owns the live Causal Loop capability descriptor, bounded process invocation, scenario validation, and run/replay agreement checks.

Portable provider:

- `mike-axiom-mir/axm-casual-loop` PR #17 head `b14c4fad2af9f1843394c05d21a78df791c757ef`;
- process prerequisite PR #8 head `cb2793fbb48efd750670bd9d08abe5a0bfa233df`;
- artifact contract `axm.causal-loop.portable-process/v1`;
- Python 3.11+;
- standard library only;
- no runtime network service required.

The provider-side lane proves that unchanged trusted source builds byte-identical ZIP applications and that a copied artifact emits the same NDJSON responses as its source entrypoint. This consumer adds a separate downstream proof that the Hub can use that distribution boundary directly.

## Build the provider from the reviewed provider checkout

From exact Causal Loop PR #17 source:

```bash
python scripts/build_causal_loop_portable.py build \
  --output causal-loop-process.pyz

python scripts/build_causal_loop_portable.py verify \
  causal-loop-process.pyz

sha256sum causal-loop-process.pyz
```

Retain the SHA-256 separately from the artifact if substitution matters to your use case. SHA-256 is content identity, not an authorship signature.

## Consume it through the Hub boundary

Prepare one scenario JSON value, for example:

```json
{
  "timedInfluences": [
    { "atWave": 2, "action": "BLOCK_DOOR" },
    { "atWave": 3, "action": "TRIGGER_ALARM" }
  ],
  "maxWaves": 64
}
```

Then invoke the bridge explicitly:

```bash
node integrations/causal-loop-portable/consumer.cjs \
  --artifact /absolute/path/causal-loop-process.pyz \
  --sha256 <caller-retained-sha256> \
  --python python3 \
  < scenario.json
```

The bridge requires an absolute regular non-symlink `.pyz`, bounds it to 4 MiB, reads it through one opened file descriptor, detects ordinary pathname/file replacement during admission, verifies the caller-provided digest, and writes those exact admitted bytes into a private temporary file before execution. The original caller pathname is not executed after admission.

The staged provider receives only the same small compatibility environment used by PR #13. The existing Hub consumer then requires the exact capability ID, schemas, engine signature, train-loop identity, action vocabulary, bounds, deterministic/offline properties, and closed provider authority before it will run a scenario. It separately asks the provider to replay-verify the returned receipt.

The emitted `axm.local-game-hub.causal-loop-portable-observation/v1` binds the selected provider lineage, admitted artifact digest/size, existing Causal Loop result, and the consumer authority ceiling. It intentionally contains no temporary execution path.

## Failure behavior

The bridge returns `HOLD` for an absent/unsafe artifact, wrong digest, unstable pathname/file identity, invalid scenario, failed provider start, incompatible live descriptor, timeout/output violation, or run/replay disagreement. A missing portable provider has no effect on ordinary Hub startup or bundled games because this tool executes only when a caller invokes it.

## Truth and authority boundary

This is local interoperability, not hostile-code containment. A deliberately malicious Python ZIP application still executes with the operating-system permissions of the caller. Staging exact bytes reduces mutable-path ambiguity; it does not create a sandbox, signature, trusted producer identity, or filesystem/process isolation.

The caller chooses both the artifact and expected digest. There is no automatic download, installation, provider selection, execution, catalog mutation, game mutation, merge, release, or CANON authority. The provider remains optional and no provider runtime code is copied into Local Game Hub source.

The dedicated CI proof exercises clean Ubuntu runners across Node 18/22 and Python 3.11/3.13. Windows, macOS, hostile filesystem races beyond the observed admission checks, producer signatures, physical devices, and arbitrary future provider versions are outside this lane.
