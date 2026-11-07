# Security, recovery, and evidence model

## Protected assets and trusted components

Protected: owner authority, treasury balance, memory plaintext, recovery material, specialist deliverables, and the integrity of mission/receipt history. Trust the owner's execution machine and explicitly configured signer service in the first release. The application is not protected against a fully compromised owner machine. 0G holds ciphertext. NEAR state and transactions are public.

Use separate owner, NEAR runtime, 0G uploader, and memory keys. Encrypting a storage wallet to itself does not implement NEAR ownership authorization. The model process receives tool capabilities, not raw keys. Do not grant it filesystem access to key stores or a general shell escape.

## Required controls

| Boundary | Required behavior | Release evidence |
| --- | --- | --- |
| Memory encryption | Authenticate content and context; reject every invalid envelope | Wrong key, truncation, tamper, swapped agent/purpose/epoch tests |
| Manifest checkpoint | Authorized CAS; no stale-owner/delegate overwrite | Concurrent writers and revocation integration tests |
| Money | Reserve before work; include pending spend; callback-aware payout state | Accounting conservation and duplicate/failed transfer tests |
| Mission execution | Persist effects and reconcile unknown outcomes | Crash at each side-effect boundary; no duplicate settlement |
| API | Owner-authenticated, replay-resistant sessions; agent resource scoping | Cross-owner access, expired session, origin and replay tests |
| Retrieval | Source-bearing untrusted data; revisions explicit | Injection fixture cannot authorize payment or change policy |
| Evidence | Precise verified/unverified/failed/unsupported states | Corrupted signature and unavailable evidence cases |
| Recovery | Owner-held keys plus committed head, no original cache | Fresh-runtime recovery fixture and live artifact evidence |

## Crypto choices

Use application-owned AES-256-GCM envelopes with authenticated context and bounded canonical encodings. Random 32-byte memory keys are never derived from addresses, passwords alone, or wallet signatures without a reviewed scheme. A later key-wrapping implementation must use a standard library and documented recipient/recovery model; do not invent DH or a threshold network.

0G SDK encryption exists, but current docs describe a wrong-key ciphertext fallback. The application envelope therefore remains the authenticated boundary regardless of storage adapter behavior. SDK storage proofs verify ciphertext consistency; they do not authorize readers.

Never persist decrypted content or private keys to receipts/logs. API secrets are redacted at the host boundary. Encrypted blob deletion and key revocation cannot retract historical ciphertext or plaintext another party already obtained. Present forgetting as logical retraction plus future-access changes, not guaranteed physical erasure.

## Failure behavior

- 0G unavailable: do not advance NEAR head; retain a retryable write intent.
- NEAR checkpoint outcome unknown: reconcile final chain state; do not announce committed memory.
- Memory write interruption: preserve encrypted intents, fixed roots and exact checkpoint attempts in the canonical write journal. Dispatched uploads are probed, never automatically repeated. Read-only reconciliation cannot sign or upload. A missing/replaced signer-journal identity fences old checkpoint attempts; lease loss fences further journal mutations. An already dispatched effect may complete late. See [durable write limits](MEMORY-WRITES.md).
- Index unavailable: recover from authenticated blobs; no silent cross-agent fallback.
- Key missing: require recovery material; no automatic plaintext mode or generated replacement key.
- Wrong key or modified envelope: typed failure; no partial content to the model.
- Inference unavailable/unverified: show exact evidence state; never fake a verification badge.
- Runtime crashes during payment: reconcile existing reservation/payout; do not create a new job for the same operation.
- NEAR signer interruption: its private SQLite journal binds exact arguments, nonce and signed transaction before broadcast. A submitted/unknown row fences new signing until reconciled; use one dedicated key and journal per agent. A dropped/unseen transaction can remain unknown because expiry proofs and nonce replacement are not implemented. See [client recovery limits](NEAR-CLIENTS.md).
- Paused/revoked runtime: stop new effects and checkpoint writes; handle already submitted transactions according to observed finality.
- Planned key replacement: retain verified historical-key backups, drain pending work and hold both journals. Atomic owner-only begin/finish calls prevent repeated epoch changes; the owner wallet remains external. Observe old-key removal and restricted replacement at one finalized block. Do not release the memory barrier until authority completes; do not claim recovery verified until a new-epoch checkpoint and unchanged history are authenticated. Emergency revocation remains available without a graceful drain. See [owner rotation](OWNER-ROTATION.md).

## Production boundary

Owner recovery uses a separately generated random secret to encrypt a network/contract/agent-bound historical keyring. The bundle restores memory keys, not wallet ownership or treasury control. Recall is a private plaintext cache on the trusted owner machine, with source-bearing untrusted results and no execution capability. Backups must be verified and copied off the runtime machine; a locally generated pair alone does not establish off-device protection. See [recovery controls and remaining gates](RECOVERY.md).

The current authority contract binds ownership to the registration account and signing key. Owner-key rotation and cross-owner transfer are not implemented. Storage credit is prepaid and cannot yet be withdrawn; it is separate from purchasing funds. Dispute resolution is buyer-controlled, with a bounded refund timeout, and does not protect specialists against a malicious buyer. These limitations must be visible before any public funding flow. See [contract rules](CONTRACTS.md).

Production launch requires independent contract/crypto review, measured storage availability, operational recovery drills, deployed session/signer isolation, adversarial tests, actual provider quotas/costs, backup monitoring, and a documented incident procedure. A successful hackathon demo is evidence of its demonstrated paths, not a blanket production guarantee.
