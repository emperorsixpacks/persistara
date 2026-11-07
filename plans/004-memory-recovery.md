# 004 — Deliver private recall and owner-controlled recovery

Priority P0 · risk high · effort one to two days. Depends on 002 and 003. Source baseline Sofer `542813f`; current new-code boundaries are `MemoryService`, `BlobStore`, and `MemoryHeadStore`.

## Intent

A committed memory survives loss of the original runtime and index. Recovery requires a finalized NEAR checkpoint and valid owner-held decryption material. Do not promise recovery from the agent ID alone or imply that changing an owner field erases old keys.

## Implementation checkpoint

Owner backup/keyring modules, schema-1-compatible schema 2 manifests, authenticated snapshot recovery and a private lexical recall index are implemented. Recovery commands are read-only with respect to NEAR/0G; a local separate-process drill and the deployed-WASM sandbox flow verify removal of the original keys/journal/index before restoration. See `docs/RECOVERY.md` for exact commands, trust boundaries and test evidence.

Durable memory-upload intents and interrupted-operation reconciliation are now implemented with encrypted write-ahead data, fixed roots, exact checkpoint plans, signer-journal identity binding and fenced leases. Read-only reconciliation is separate from an explicit resume. The abrupt-process-exit drill and deployed-WASM sandbox verify these paths; see `docs/MEMORY-WRITES.md`.

The owner revocation/epoch activation workflow is now implemented with verified replacement backups, persistent journal barriers, idempotent owner-only contract operations and finalized account-key checks. Unsigned owner requests keep wallet signing outside the runtime. A deployed-WASM scenario rejects the old runtime, writes under the new epoch and restores four records from a new backup after removing both runtimes. See `docs/OWNER-ROTATION.md` for owner commands, interruption/abort behavior and limits.

This milestone deliberately keeps plan 004 IN PROGRESS. The first real sourced memory was encrypted/uploaded to Turbo, checkpointed on public NEAR, and recovered in a separate clean process from only its backup/secret and public identifiers. That one-record drill does not complete the two-fact/source/revision acceptance, live rotation, cross-machine/off-device backup drill or five-trial measurements. Embeddings, wallet integration and safe resolution of indefinitely unknown outcomes also remain. No live write path may bypass those gates merely because a smaller drill passes.

## Scope

Extend `packages/memory/src`, add index and recovery/keyring modules and `memory:recover` verification scripts. Wire live 0G and NEAR adapters without changing their trust boundaries. Do not add shared public indexes or cross-owner agent transfer. Existing application encryption, operation deduplication, read-before-checkpoint, and CAS tests remain required.

## Steps

1. Define a versioned owner recovery bundle with explicit agent/network binding and key epochs. Use a reviewed standard library for wrapping keys to a separately generated recovery secret; never use a public address as secret material. Provide backup verification and offline instructions. Do not log keys or return them to the model.
2. Persist write intents and final checkpoint outcomes in the runtime journal. Recover unresolved writes by checking NEAR state; do not convert orphaned uploads into committed memories.
3. Add an agent/epoch-scoped local full-text index, embeddings adapter, and retrieval ranking with source citations, revision lineage, and freshness. Hide superseded facts from default recall while preserving historical export. All text entering retrieval remains untrusted data.
4. Store the index as a rebuildable cache in the owner-controlled runtime. Raw text and vectors may not be uploaded to an untrusted remote index. Bound manifest size, write batching, and retrieval limits after live latency measurements.
5. Implement recovery into a new state directory: verify chain/network and finalized head, decrypt manifest, verify every blob/context/record, import revision history, regenerate required embeddings, then atomically publish the replacement index. Preserve the previous healthy index on a partial rebuild failure.
6. Implement delegate revocation and future-key-epoch rotation with a keyring that can read authorized historical epochs. A revoked process with an old key can still read ciphertext it already has; express revocation as preventing new writes/future access where the key model permits it.

## Verification

Run `pnpm check` plus the new `pnpm memory:recover` scenario. Tests cover a missing blob, invalid manifest signature/context, wrong recovery bundle, cross-network/agent import, superseded facts, stale checkpoints, corrupt cached vectors, interrupted index rebuild, two writers, and lost checkpoint response.

Live acceptance: create two sourced memories, commit to NEAR with 0G references, stop the original runtime, use an empty state directory with only owner recovery material and public agent/network identifiers, rebuild recall, and produce both facts with correct sources. Record elapsed time and provider calls. A fresh class instance in one test process is not sufficient for the live acceptance.

## Done criteria

Recovery works in a separate process/state directory and does not require original index files, hidden DB records, or uploader private keys. Key backup verification exists. Revocation blocks stale delegate writes at the contract. Tests fail closed under invalid keys/content; README accurately states machine/key trust and observable metadata.

## Stop conditions

Recovery relies on a secret stored only on the original machine; plaintext/vector data crosses a provider boundary without an explicit policy; key rotation strands historical memories; manifest growth exceeds the measured cap. Resolve these before advertising portable memory.
