# Persistara execution plan

Prepared 2026-11-06 against Sofer `542813f`. The user delegated product and technical decisions. First-release target: a complete hackathon workflow with explicit production follow-up, not a demo assembled from unverified feature claims.

## Order and status

| Plan | Deliverable | Depends on | Status |
| --- | --- | --- | --- |
| 001 | New repo, provenance, memory protocol and adversarial foundation tests | — | DONE — 20 tests pass; private GitHub repo created |
| 002 | Live 0G storage adapter and verified private inference spike | 001 | DEFERRED at user request — AI credits can be arranged later; uploader has 0.5 testnet 0G |
| 003 | NEAR registry, revocation, budgeted treasury and escrow | 001 | IN PROGRESS — contracts and durable clients pass locally; public testnet gate remains |
| 004 | Recoverable indexed memory and owner recovery workflow | 002, 003 | IN PROGRESS — backups, sourced recall, durable writes and owner rotation pass locally/sandbox; live-provider and wallet-integration gates remain |
| 005 | Durable missions, signed worker protocol, authenticated API | 003, 004 | TODO |
| 006 | Operational console, live demo, release evidence | 005 | TODO |

Plans 002 and 003 are independent after 001. This is a dependency observation, not permission to spawn other agents. Keep work single-agent unless the operator authorizes delegation.

Foundation evidence: `pnpm check` completed with 20 passing tests in three suites; eight reviewed source hashes matched; tracked-file and whitespace checks passed. Initial implementation commit: `950b82c`. Remote: https://github.com/JemIIahh/persistara (private). Public live-provider and contract acceptance gates remain unexecuted.

Provider milestone evidence (2026-11-06): isolated Node 24.22.2; pinned 0G SDK 1.2.13 and NEAR AI SDK 0.2.1 import successfully; 38 tests in seven suites pass. Read-only Galileo RPC reports the expected chain ID, and the public NEAR AI catalog is reachable. No paid upload/inference, real storage proof roundtrip, or live TEE verification has been completed. See `docs/INTEGRATIONS.md` for setup and acceptance commands.

Contract milestone evidence (2026-11-06): optimized authority WASM builds with Rust 1.96.0 / near-sdk 5.30.1 / cargo-near 0.22.0. The initial 25 unit tests and two deployed-WASM scenarios passed; GitHub CI for `8614e57` succeeded. See `docs/CONTRACTS.md` for artifact checksum, accounting and release limitations.

Client milestone evidence (2026-11-06): `pnpm check` passes 58 TypeScript tests; `pnpm contract:check` passes formatting, Clippy, 25 contract unit tests and three sandbox scenarios. The new scenario runs the actual TypeScript client/isolated signer against deployed WASM, commits memory with an injected lost response, reserves and settles a native job once, reconciles without the signer key, then removes the journal and recovers memory in a fresh process. Storage is explicitly synthetic local ciphertext storage. This is not real 0G recovery, owner backup implementation, or public testnet acceptance. `docs/NEAR-CLIENTS.md` records the private-journal/key requirements and unresolved dropped-transaction limitation. Plan 003 remains in progress until public testnet evidence exists; AI credits remain deferred.

Owner recovery milestone evidence (2026-11-06): `pnpm check` passes 77 TypeScript tests in 13 suites. `pnpm memory:recover:fixture` creates and verifies a random-secret owner backup, deletes the original runtime keyring/index, and restores three records across two key epochs in another process; default recall returns two current facts with sources. `pnpm contract:check` passes formatting, Clippy, 25 Rust unit tests and three deployed-WASM sandbox scenarios. Its application scenario now verifies the same backup-based restoration after removing original runtime state, using actual NEAR checkpoints and explicitly synthetic storage. The live recovery CLI exits 2 with `NOT_CONFIGURED` when public settings are absent; it has no fixture fallback. See `docs/RECOVERY.md` for encryption, private-cache and revision semantics. Plan 004 remains in progress: durable upload intents/unknown-outcome reconciliation, full owner rotation, embeddings, public NEAR/real 0G clean-machine recovery and measurements are pending. No paid inference or real upload was performed.

Durable memory-write milestone evidence (2026-11-07): `pnpm check` passes 109 TypeScript tests in 16 suites. Encrypted write intents, deterministic prepared roots, exact checkpoint plans, stable signer-journal identities and renewable fenced leases survive restart. Tests cover unavailable roots, lost upload/checkpoint responses, preflight failures, canonical duplicates/conflicts, failed transactions, CAS rebasing, journal failures/corruption, lease takeover/renewal failure and no plaintext/key logging. `pnpm memory:writes:fixture` abruptly exits separate processes after upload and checkpoint effects; fresh processes reconcile and observe one record upload, one manifest upload and one emulated checkpoint. `pnpm contract:check` passes 25 Rust tests and three sandbox scenarios; its application flow now reconciles the durable memory intent in another process before appending more records, settling once and recovering from an owner backup. Synthetic storage remains explicit. The 0G SDK preparation worker computes a real Merkle root without network/key access; no real upload or paid inference was run. See `docs/MEMORY-WRITES.md` for commands, cancellation limits, journal custody and indefinitely unknown cases. Plan 004 remains in progress for real-provider acceptance, full owner rotation, embeddings and measurements; AI credits remain deferred.

Owner rotation milestone evidence (2026-11-07): `pnpm check` passes 126 TypeScript tests in 18 suites. `pnpm contract:check` passes formatting, Clippy, 34 Rust unit tests and four deployed-WASM sandbox scenarios. Owner preparation preserves historical keys, verifies replacement backups, and holds canonical memory/signer journals before emitting immutable unsigned wallet requests. New owner-only contract methods atomically pause/revoke/advance one epoch and idempotently complete under the explicit resume policy; runtime signing scope remains unchanged. Finalized reads pin contract, rotation and account keys to one block. Tests cover partial preparation, missing/replaced material or journals, pending outcomes, stale authority, scope/finality errors, secret redaction, atomic request-issuance/abort exclusion and schema-1-to-2 memory-journal migration. The new sandbox flow executes owner requests externally, rejects a reinstalled revoked key for memory and spending, commits under epoch 2, removes both runtimes/journals, then recovers four records across two epochs from the updated owner backup. Storage is synthetic; no owner key enters application input. Local WASM is 288,692 bytes, SHA-256 `e1ca18486c58e92b46cb6920ef66a3517cd4a2132355e91dc6c6168f4e138375`. The pre-public-deployment root-state layout changed; deploy a fresh authority for acceptance, as in-place migration is not implemented. See `docs/OWNER-ROTATION.md`. Public NEAR/real 0G acceptance, reviewed wallet integration, embeddings and measurements remain pending; no NEAR AI credits or public funds were used.

## Release priorities

P0: ownership, encrypted recovery, bounded money, crash reconciliation, complete real-provider workflow. P1: clear operational UI and exact evidence. P2: additional models, markets, cross-chain funding, multi-tenant hosting.

Suggested calendar: foundation and provider spikes Nov 6–7; contracts Nov 7–9; recovery and mission loop Nov 9–11; console and failure drills Nov 11–13; submission evidence Nov 14. Dates are a sequencing target, not a promise that unverified dependencies work.

Do not skip a P0 gate to preserve a date. Reduce secondary features instead. A local deterministic fixture must remain visibly separate from live-provider acceptance evidence.

## Deferred or rejected approaches

- Whole-tree copy and search/replace: carries broken trust assumptions and Sui-specific behavior.
- A full-access wallet exposed to the model: bypasses the product's spending-policy promise.
- NEAR pointers advertised as proof of storage availability, privacy, or report truth: false property attribution.
- Reusing current messaging crypto: unsupported key-agreement construction and downgrade behavior.
- A mandatory token, a new cryptographic protocol, or a general-purpose autonomous operating system in v1: unnecessary to deliver the selected user workflow.

## Verification inventory

Existing foundation commands: `pnpm install`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm check`.

Provider diagnostic/spike commands, `near:doctor`, `near:reconcile`, and `contract:build`, `contract:test`, `contract:sandbox`, `contract:check` now exist. The NEAR doctor fails with exit 2 when public deployment configuration is absent, rather than using a fixture. API and browser scripts named in later plans remain **planned interfaces**. Each plan's first implementation step must add its script and document its toolchain. Do not report a command passing until it has actually run.

Owner commands now include `memory:keys`, `memory:backup`, `memory:backup:verify`, `memory:recover`, and `memory:recall`. `memory:recover:fixture` is an explicitly local separate-process drill; it does not satisfy the live acceptance gate. Backup verification proves keyring restoration, while committed-memory recovery additionally requires the finalized head and all referenced ciphertext.

Durable write commands now include `memory:write`, `memory:resume`, `memory:writes:reconcile`, and `memory:writes:cancel`; they require the canonical state directory and separate memory keyring. `memory:writes:fixture` is an explicitly local abrupt-process-exit drill. Read-only reconciliation may update local journal state but cannot upload or submit. Unavailable roots and unresolved NEAR transactions do not authorize a replacement effect.

Owner rotation commands now include `owner:rotation:prepare`, `owner:rotation:next`, `owner:rotation:verify`, and `owner:rotation:abort`. They prepare/verify private local material, hold the original journals and produce reviewable unsigned owner requests. Actual owner signing stays outside the runtime; no command loads an owner key or automatically submits those requests. The complete deployed-WASM flow is part of `contract:check`, with explicitly synthetic storage. Public wallet signing/integration and provider acceptance are separate release gates.
