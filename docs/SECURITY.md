# Security, recovery, and evidence model

## Protected assets and trusted components

Protected: owner authority, treasury balance, memory plaintext, recovery material, specialist deliverables, and the integrity of mission/receipt history. Trust the owner's execution machine and explicitly configured signer service in the first release. The application is not protected against a fully compromised owner machine. 0G holds ciphertext. NEAR state and transactions are public.

Use separate owner, specialist wallet, NEAR runtime, 0G uploader, memory and commission recipient keys. Encrypting a storage wallet to itself does not implement NEAR ownership authorization. The model process receives tool capabilities, not raw keys. Do not grant it filesystem access to key stores or a general shell escape.

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

## Conversation sessions

Chat history is private owner-runtime plaintext in its own SQLite journal, scoped to owner/agent/contract/code hash, outside every backup. Model output and tool results are untrusted data and are escaped before display. The model only sees three read-only tools that re-check the original owner per call; economic and owner actions remain human-reviewed commands. Provider requests are journaled before dispatch; an interrupted charged request is outcome-unknown and fenced, never auto-retried. Offline tests use synthetic providers only; live attestation/E2EE/tool behavior is unverified.

## Crypto choices

Use application-owned AES-256-GCM envelopes with authenticated context and bounded canonical encodings. Random 32-byte memory keys are never derived from addresses, passwords alone, or wallet signatures without a reviewed scheme. Commission briefs/deliveries use standard JWE RSA-OAEP-256 / A256GCM through pinned jose with distinct 3072-bit recipient keys and authenticated scope/purpose context. Neither wallet signatures nor addresses derive these secrets. Memory backups do not contain commission recipient keys; recovery custody must be verified separately.

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
- Source mission interruption: retain captures under immutable public-read operation IDs and fence stale/canceled workers with expiring leases. Only uncommitted unauthenticated public GETs may be repeated explicitly; no payment/upload capability exists in this worker. DNS pinning, exact HTTPS origins, public IPv4, certificate checks, byte/deadline bounds and no redirects restrict retrieval. Briefs/excerpts are plaintext in the private local mission journal, not encrypted memory backups. See [mission custody and limits](MISSIONS.md).
- Specialist commission interruption: fixed signed-task/quote bindings, immutable roots, canonical signer identity and persisted dispatch markers fence repeat uploads/reservations/deliveries/acceptance. Unknown outcomes only observe existing effects. Payout callbacks, not acceptance receipts, establish payment. Explicit retry of a conclusively failed payout stays bound to the original recipient/amount/attempt; unknown retries are fenced. See [commerce limits and custody](COMMISSIONS.md).
- NEAR signer interruption: its private SQLite journal binds exact arguments, nonce and signed transaction before broadcast. A submitted/unknown row fences new signing until reconciled; use one dedicated key and journal per agent. A dropped/unseen transaction can remain unknown because expiry proofs and nonce replacement are not implemented. See [client recovery limits](NEAR-CLIENTS.md).
- Paused/revoked runtime: stop new effects and checkpoint writes; handle already submitted transactions according to observed finality.
- Owner wallet handoff: persist the reviewed request before calling the external wallet. Cancellation, disconnection or a lost response does not prove absence of broadcast. Retain one pending operation across restart; only a matching finalized receipt resolves it. Without a recoverable hash it may remain fenced indefinitely. Loopback owner sessions bind the original registered full-access key, origin and one-time NEP-413 challenge; mutation routes also require CSRF. See [console controls and limits](OWNER-CONSOLE.md).
- Planned key replacement: retain verified historical-key backups, drain pending work and hold both journals. Atomic owner-only begin/finish calls prevent repeated epoch changes; the owner wallet remains external. Observe old-key removal and restricted replacement at one finalized block. Do not release the memory barrier until authority completes; do not claim recovery verified until a new-epoch checkpoint and unchanged history are authenticated. Emergency revocation remains available without a graceful drain. See [owner rotation](OWNER-ROTATION.md).

The [portable recovery kit](RECOVERY-KIT.md) encrypts memory and buyer-recipient material under a new independent random secret using the existing AES-256-GCM envelope. Its authenticated context binds kit UUID, owner/key, complete agent/contract/code/network scope, checkpoint and active epoch. An independently supplied ciphertext fingerprint prevents silent replacement of the kit/secret pair. Restore validates all memory/delivery content before publication, refuses existing state directories and has no signer/uploader capability. Encrypted exports may be read from non-POSIX media; secrets and restored plaintext require private POSIX permissions. Local restoration and a caller-supplied hostname do not prove physical off-device custody.

The native terminal signs a CLI-domain owner challenge through the external official NEAR CLI keychain; no owner wallet key enters its process. `persistara wallet` only checks prerequisites and launches the CLI's own import prompts with the user's terminal attached; it never reads, stores or forwards a key. Storing an encrypted owner key inside Persistara was considered and deliberately not done, because it would put the owner key in the same process as the model-facing chat loop. Sessions are memory-only. Current owner/scope/authority checks precede local private reads and new effects. Financial review digests bind the selected immutable quote/artifact; unattended cost authorization is separate from off-chain login consent. Owner handoffs are persisted before the external CLI call and unresolved outcomes cannot be resent. Native command output escapes control/OSC/bidirectional characters from untrusted content; JSON retains their escaped values. No terminal command history is persisted and ordinary text never invokes a model or shell. Signal shutdown stops the owned source worker, retains progress and closes journals after the command drains. See [terminal boundaries](TERMINAL.md).

## Production boundary

The full terminal renderer keeps a bounded in-memory transcript and command-only history, with no disk persistence. Forms and typed review responses are excluded from those buffers; authentication tokens/proofs stay inside the original controller/wallet boundary. It renders escaped text, handles bracketed paste as a single input value, resets the composer at every question and ignores queued input while work runs. Enter in the command picker can dispatch a command but cannot answer its later approval prompt. Source/dossier text cannot drive keyboard actions. Paging retains complete review fields within the bounded session; clearing the view is unavailable during a review. The renderer restores screen/cursor/paste modes after command drain, and Ctrl+C preserves existing unknown-operation fences. `--plain` remains the accessibility/fallback route. Terminal session scrollback is not a portable recovery backup or a conversational transcript.

The local terminal/console workspace may retry a temporary public `status`, `block` or `query` read once on the same configured RPC endpoint, with bounded timeouts. Response identity/size, finalized block/code/key checks and owner-session checks still fail closed. Malformed responses, wallet invocation, uploads and transaction submissions are outside this retry policy. Other RPC clients retain the single-attempt default. Short login summaries keep the exact key/scope/purpose visible and offer the complete message/domain/digest through `details`; inspection never approves an action. Financial reviews retain full exact request fields. Numbered interactive mission choices bind the displayed durable IDs rather than querying a new list at dispatch.

Owner recovery uses a separately generated random secret to encrypt a network/contract/agent-bound historical keyring. The bundle restores memory keys, not wallet ownership or treasury control. Recall is a private plaintext cache on the trusted owner machine, with source-bearing untrusted results and no execution capability. Backups must be verified and copied off the runtime machine; a locally generated pair alone does not establish off-device protection. See [recovery controls and remaining gates](RECOVERY.md).

The current authority contract binds ownership to the registration account and signing key. Owner-key rotation and cross-owner transfer are not implemented. Storage credit is prepaid and cannot yet be withdrawn; it is separate from purchasing funds. Dispute resolution is buyer-controlled, with a bounded refund timeout, and does not protect specialists against a malicious buyer. These limitations must be visible before any public funding flow. See [contract rules](CONTRACTS.md).

Production launch requires independent contract/crypto review, measured storage availability, operational recovery drills, deployed session/signer isolation, adversarial tests, actual provider quotas/costs, backup monitoring, and a documented incident procedure. A successful hackathon demo is evidence of its demonstrated paths, not a blanket production guarantee.
