# Owner recovery and private recall

This milestone implements encrypted owner backups, historical memory keyrings, authenticated snapshot recovery and a private full-text recall cache. [Durable encrypted write intents and reconciliation](MEMORY-WRITES.md) are also implemented. No AI credits are required. Public NEAR/0G recovery acceptance, embeddings and the complete owner rotation workflow remain release gates; plan 004 is in progress.

## What the backup recovers

The backup contains memory encryption keys and their epochs. It binds them to agent ID, authority network/chain, contract and storage network. It contains **no NEAR owner key, runtime signing key, 0G uploader key, API credential or treasury authority**. Restoring memory does not restore a lost blockchain wallet or change the contract's registered owner key.

`createOwnerBackup` generates an independent random 32-byte recovery secret and encrypts the private keyring using the existing Node AES-256-GCM envelope. A fresh 12-byte nonce and 16-byte authentication tag protect each envelope. The authenticated context includes the agent, backup UUID, full SHA-256 of its network/contract binding, active epoch and `recovery` purpose. The encrypted payload repeats the full binding, which is checked again after decryption. No key comes from a public address, wallet signature, password or concatenated key material.

The owner must keep **both the encrypted bundle and its recovery secret**. Copy them to separately protected backup locations outside the runtime machine. Generating files on the same machine is preparation for a backup, not evidence of off-device protection. Keep the secret out of chat, application logs, source control and command-line arguments. Commands accept a secret **file path** and print metadata only.

Keyrings support up to 64 retained epochs. The in-memory keyring copies key bytes, hides its key map behind JavaScript private fields, and redacts generic JSON serialization. The explicit private export is plaintext key material for a protected owner/runtime file or the encrypted bundle; it must never enter model tools or receipts. Files require private permissions and directories mode 0700. File creation is exclusive, so existing material is not overwritten. This policy is tested on macOS and Linux; Windows file-permission behavior is not a supported recovery target yet.

## Owner commands

Set the public `NEAR_AGENT_ID`, `NEAR_AUTHORITY_CONTRACT` and chosen `ZG_STORAGE_MODE` in the ignored environment file. These fields bind the backup. Offline key/backup commands validate their structure; they do not prove the account/contract exists or submit a transaction.

```sh
pnpm memory:keys --keyring .persistara/keys/memory-keyring.json

pnpm memory:backup \
  --keyring .persistara/keys/memory-keyring.json \
  --bundle /path/to/private-owner-backup/memory.bundle \
  --secret-file /path/to/separate-private-secret/recovery.key

pnpm memory:backup:verify \
  --bundle /path/to/private-owner-backup/memory.bundle \
  --secret-file /path/to/separate-private-secret/recovery.key
```

Replace the example paths with protected owner-selected locations. A successful backup command verifies that the saved files reproduce the original keyring. `backup:verify` checks format, binding and authenticated decryption. Neither result alone proves those keys can recover the current checkpoint. That stronger check is `memory:recover` below.

If a destination exists, the command fails instead of replacing it. If a multi-file export is interrupted, a newly created secret or bundle file may remain; the original keyring is preserved. Verify a complete pair before relying on it. Do not discard the old valid backup during a failed export.

## Recover into a clean state directory

```sh
pnpm memory:recover \
  --bundle /path/to/private-owner-backup/memory.bundle \
  --secret-file /path/to/separate-private-secret/recovery.key \
  --state-dir .persistara/recovered-runtime

pnpm memory:recall \
  --state-dir .persistara/recovered-runtime \
  --query 'dated primary sources'
```

The live command uses the configured HTTPS NEAR testnet RPC, checks its chain identity, and reads finalized agent state. It downloads referenced ciphertext through the proof-checking 0G adapter, verifies digest/length and AES-GCM context, then validates the complete manifest, every record and revision lineage. It rereads the finalized head before publishing; if memory advanced during recovery, publication stops. It never scans storage for orphaned uploads or treats an unreferenced object as committed memory.

Recovery has no upload or checkpoint signing capability and does not load an uploader, owner or runtime signing key. It requires the owner recovery secret and public provider identifiers. The NEAR RPC remains a trusted state source; this implementation is not a light client. Storage unavailability, wrong keys, missing historical keys, corruption, wrong scope or a changing checkpoint produce errors without publishing partial recall.

The live command has no fixture fallback. Missing public deployment settings exit with `NOT_CONFIGURED`; unavailable providers fail. A public deployment and real 0G ciphertext are still needed to execute its live acceptance gate.

## Search cache and revision behavior

`MemoryRecallIndex` is a disposable **plaintext SQLite/FTS5 cache on the trusted owner machine**. Do not upload it to 0G or a remote index. Its WAL and database files stay inside the private state directory. Anyone who compromises that machine or can read the cache can read its contents; at-rest disk protection remains an operator responsibility.

Rebuilds validate all records first, then replace rows, full-text postings and checkpoint metadata in one SQLite transaction with full synchronization. A failed insertion rolls back to the previous cache. Older checkpoints and conflicting records at a fixed checkpoint are rejected. Searches serialize their bounded integrity checks with publication, so rows and metadata share a consistent local snapshot. Contention reports `INDEX_BUSY`; it is not a corrupted-cache or successful-query result.

Every recall supplies the expected finalized head. A missing/older cache reports `INDEX_STALE` and returns no stale facts. Content digests, record/column checks, SQLite checks and FTS integrity checks detect cache corruption; rebuild from authenticated source data. For damaged metadata or an unusable database, recover into a new directory before retiring the old state. Do not rename a live SQLite/WAL file to simulate atomic publication.

Search is lexical: normalized literal terms joined with AND, Unicode tokenization and BM25 ranking. Query text cannot inject SQL or FTS operators. It supports at most 16 terms, 512 query bytes and 20 returned matches. There is no embedding/vector or semantic-search claim in this milestone.

Default recall hides explicitly superseded records while preserving historical export. `includeSuperseded` exposes history with `revisionState` and `supersededBy`. Concurrent revisions of one fact remain two current branches until an owner resolves them; no timestamp silently picks a winner. Results carry source reference, memory ID, creation time, record age and an explicit `untrusted: true` flag. Record age describes when the memory was saved, not when its external source was last updated or whether it is true. Retrieval never authorizes tools, policy changes or payment.

Release caps: 1,000 manifest entries, 16 MiB recovered plaintext, 64 retained keys. A larger dataset fails without replacing a healthy cache. These are conservative bounds, not measured live-performance claims.

## Manifest compatibility and epoch preparation

New manifests use schema 2 and record each entry's encryption epoch. Schema 1 manifests remain readable: their entries inherit the manifest epoch. An append creates a new v2 manifest without rewriting old ciphertext. Recovery returns each record's epoch and verifies all required keys exist before proceeding. Older software that understands only schema 1 must be upgraded before new writes.

`MemoryKeyring.nextEpoch()` prepares a new key and preserves historical keys. It does not mutate the old keyring, activate a chain epoch, revoke a runtime, or automatically update an existing backup. Before a future live rotation: prepare and verify the new backup, preserve all historical keys, revoke the old runtime grant/access key, activate the next owner-authorized chain epoch, provision a separate runtime key, and verify the next committed checkpoint and recovery. The orchestration and failure drill for that full live sequence are still pending.

A stale backup cannot decrypt newer-epoch memory. Revocation cannot make an old runtime forget keys or plaintext it already obtained. New keys protect future envelopes; they do not physically erase historical ciphertext or caches.

## Verification and evidence boundaries

```sh
pnpm check
pnpm memory:recover:fixture
pnpm contract:check
```

The explicitly labeled local recovery drill creates random memory keys, an encrypted owner bundle and separate secret, writes three records across two epochs, deletes the original runtime directory, then starts another process to restore into a fresh directory and verify current/historical sourced recall. It uses local disk checkpoints and ciphertext, so it makes no blockchain or 0G claim.

The deployed-WASM sandbox scenario uses actual NEAR restricted keys/checkpoints and native settlement with explicitly synthetic blob storage. It now backs up random memory keys, commits three records including a revision, settles a job once, removes original runtime keys/journal/index, and restores sourced recall from the backup in a fresh process. This is separate from the real 0G/public-testnet acceptance gate.

Before the full release, complete owner rotation orchestration, real-provider clean-machine recovery, cost/latency measurements, mission integration and independent review. Durable writes use a separate private journal; the generic foundation writer is not the durable live mission service. Owner backup recovery restores committed memory, while unfinished local writes additionally require their original write/signer journals. Neither recovery nor a missing root authorizes retrying an uncertain paid upload.

Primary references: [Node authenticated encryption](https://nodejs.org/api/crypto.html), [SQLite atomic transactions](https://www.sqlite.org/atomiccommit.html), [FTS5](https://www.sqlite.org/fts5.html). Implementation uses the pinned project runtime and has no new cryptographic dependency.
