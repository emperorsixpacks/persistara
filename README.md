# Persistara

**Agents that carry their memory and work forward.**

Persistara is a new successor to Sofer: a terminal-first workspace for owner-controlled agents with recoverable encrypted memory, durable missions, bounded spending, and accountable agent-to-agent work.

The selected stack is **NEAR ownership and settlement + 0G encrypted storage + NEAR AI inference**. This repository starts fresh. It selectively adapts reviewed Sofer primitives; it is not a renamed copy or a claim that old work was built during the hackathon.

Repository: https://github.com/JemIIahh/persistara. Development visibility: private; the hackathon release must be public by its submission deadline.

## Install

You do **not** need to clone the repository. Run one command:

```sh
curl -fsSL https://raw.githubusercontent.com/JemIIahh/persistara/main/install.sh | bash
```

Then open a new terminal and run `persistara --help`. It builds the CLI, adds `persistara` to your PATH and creates a private workspace in `~/.persistara-workspace`. It needs `git` and either `pnpm` or Node.js, and no `sudo`. To remove it: `curl -fsSL <same url> | bash -s -- --uninstall` (your workspace is kept).

- **Repository still private?** The URL above only works for everyone once the repository is public. Collaborators with GitHub access can run the same script without cloning: `gh api repos/JemIIahh/persistara/contents/install.sh -H "Accept: application/vnd.github.raw" | bash`.
- **Want to read it first?** `curl -fsSL <url> -o install.sh && less install.sh && bash install.sh`. Preview with `--dry-run`; pin a version with `--ref <tag-or-commit>`.
- **What it does not do:** it does not deploy a contract or create accounts. You still need your own deployed authority, its exact WASM and your NEAR account. See [INSTALL.md](docs/INSTALL.md) for every change it makes and what you still need.

## Start in the terminal

The primary interface is now an interactive terminal application with a persistent composer, command picker, scrollable session and live working/status feedback. In the configured project:

```sh
pnpm build
./bin/persistara
```

After building, run `pnpm cli` for normal use, or `pnpm cli:dev` to rebuild source changes. Connect through the external original-owner NEAR CLI keychain, then use `/new`, `/run`, `/review`, `/missions` and `/open 1`. `/help` starts small; topic help and Tab completion make other workflows discoverable. The same terminal supports signed specialist quote/delivery review, bounded reservation/settlement, receipts, source-aware memory recall and recovery. Interrupted source work resumes under the same durable mission ID. No browser or AI credits are required for this implemented workflow. See [terminal setup, commands and exact limits](docs/TERMINAL.md).

Real native acceptance verified owner login, memory-cache recovery and a source mission interrupted after its first capture, resumed/reviewed/reopened in fresh CLI processes with the same artifact. No upload, transaction or inference was used. See [terminal acceptance evidence](docs/evidence/native-terminal-2026-11-08.json).

**AI chat is disabled by default and only partly live-verified.** A durable conversation/session core with three read-only tools is tested offline with clearly labeled synthetic providers. One real non-streaming NEAR AI request (fictional data) has passed full attestation, encryption, signature and tool-call verification ([evidence](docs/evidence/inference-spike-2026-11-11.json)); streaming failed its one live attempt and stays off, and chat in the real terminal against a live workspace has not yet been run. Enabling it needs deliberate operator opt-in and your own key (see [terminal docs](docs/TERMINAL.md#conversation-sessions-offline-core) and [acceptance runbook](docs/INFERENCE-ACCEPTANCE.md)). This release is an interactive mission workspace; it does not claim complete Sofer conversational/daemon/Telegram parity. The web console remains available, and further visual redesign is deferred.

## Current implementation

Implemented: typed storage and registry boundaries, authenticated memory encryption, encrypted manifests, idempotent memory writes, checkpoint conflict handling, recovery from a committed head, and a local disk-backed blob adapter. Provider adapters connect the pinned 0G and NEAR AI SDKs through isolated processes, with strict evidence validation and reproducible diagnostic/spike commands. A Rust NEAR authority contract now implements owner/delegate permissions, revocation, memory checkpoints, native budgets, escrow, callbacks and timeout refunds.

NEAR clients now wire memory checkpoints and job reservation/acceptance through a restricted signer process and a durable SQLite transaction journal. Finalized reads and same-transaction reconciliation keep uncertain outcomes separate from success or failure.

Owner recovery now includes encrypted backup bundles, historical keyrings, authenticated snapshot restoration and a private full-text recall cache with source/revision metadata. A separate-process drill restores after deleting the original runtime state. See [recovery commands and boundaries](docs/RECOVERY.md).

A portable encrypted owner recovery kit now covers both historical memory keys and the separate buyer delivery-recipient key, with immutable signed commission descriptors. Its verify/recover CLI requires an independently checked fingerprint, never loads the original `.env` during restore, and uses public reads only. Physical off-device custody remains unverified until a real separate-device drill is observed. See [kit export, transfer and restore commands](docs/RECOVERY-KIT.md).

Durable memory writes now journal encrypted intents, ciphertext roots and exact checkpoint attempts before external effects. Interrupted uploads are probed without re-uploading; interrupted checkpoints reconcile through the same signer journal. Leases fence stale processes. See [write, resume and reconciliation commands](docs/MEMORY-WRITES.md), including the cases that remain unknown and must not be retried.

Owner-controlled runtime/memory-key rotation now prepares verified replacement backups, drains and holds the original journals, atomically revokes/advances authority, and verifies restricted account-key replacement. Owner signing stays outside the runtime through reviewable unsigned requests. A new sandbox flow writes under the new epoch and recovers historical memory after both runtimes are removed. See [owner rotation and signing boundaries](docs/OWNER-ROTATION.md).

Real 0G Turbo acceptance now passes: an application-encrypted specimen was uploaded, finalized, retrieved with a Merkle proof and decrypted, then retrieved/decrypted in another process without uploader credentials. Durable acceptance intents fence resubmission after interruption; the uploader enforces a per-transaction testnet cost ceiling. See [sanitized live evidence](docs/evidence/0g-testnet-2026-11-07.json).

Public NEAR acceptance now passes on `authority.persistara-owner.testnet`: a restricted runtime committed memory backed by real Turbo blobs, a clean process recovered the first record from an encrypted owner backup, and a fictional job settled 0.01 testnet NEAR once. Stale checkpoints and over-budget reservations were rejected by the contract. External owner/specialist signing uses the official NEAR CLI keychain. See [public deployment, recovery and settlement evidence](docs/evidence/near-0g-testnet-2026-11-07.json).

The local owner console now connects external NEAR wallets, verifies the original registered owner through a one-time NEP-413 proof, displays finalized authority/runtime/backup readiness and supports reviewed pause/resume requests. Its durable journal fences unknown wallet handoffs across restart. The real original owner's off-chain CLI-keychain proof passes; four browser tests use a clearly labeled disposable wallet, and actual pause/resume receipts pass against deployed WASM in sandbox. Real browser-provider approval remains unverified. See [owner console setup, custody and recovery limits](docs/OWNER-CONSOLE.md).

The redesigned mission desk now persists zero-spend source-collection briefs, captures approved public HTTPS sources, saves a local dossier and records review of its exact fingerprint. Fenced worker leases retain progress across interruptions; completed source captures are not fetched again on resume. The owner-authenticated API exposes journal-backed missions, source artifacts and replayable event cursors. A real two-source NEAR/0G documentation mission completed without AI, upload or public transaction. See [mission setup and recovery limits](docs/MISSIONS.md) and [sanitized live evidence](docs/evidence/mission-source-dossier-2026-11-07.json).

[Optional web-console design and explicitly labeled fixture captures](docs/CONSOLE-DESIGN.md).

Signed specialist commissioning now links one curated worker to a mission through domain-bound NEP-413 quotes and delivery receipts. Separate JWE recipient keys protect briefs/dossiers on 0G; exact owner review precedes bounded NEAR acceptance, and finalized payout callbacks determine payment completion. The separate worker CLI keeps wallet signing in the official external keychain. Fixed upload/job intents and canonical signer journals survive interruption without replacement effects. Public testnet acceptance completed a real two-source encrypted delivery and paid 0.01 NEAR once, retained across a host restart; a fresh process decrypted the result using a copied recipient key without runtime/uploader credentials. See [sanitized live commissioning evidence](docs/evidence/specialist-commission-2026-11-07.json) and [setup, signed-file exchange and recovery limits](docs/COMMISSIONS.md).

**Not implemented yet:** AI conversation/reasoning and conversational session resumption, daemon/Telegram integration, embeddings, model-driven research/synthesis, multi-tenant/SSE mission API, browser new-agent enrollment or rotation execution. Two-fact/source/revision recovery, live key rotation, physical cross-machine/off-device backup drills and the five-trial benchmark remain release gates. NEAR AI credentials/credits and paid inference are deferred. The live specimen tests mechanical storage/settlement, not research output or model quality. Local fixtures and disposable NEAR sandbox results remain separate from public-chain evidence.

## Development

- Node.js >=24.22.1. pnpm downloads the pinned project-local Node 24.22.2 runtime; the global installation is unchanged.
- pnpm 10.26.0.
- For contracts: Rust 1.96.0 (selected by `rust-toolchain.toml`) and cargo-near 0.22.0. See [contract setup and exact semantics](docs/CONTRACTS.md).

```sh
pnpm install
pnpm check
```

`pnpm check` typechecks, builds, and runs **230 TypeScript tests in 34 suites**, including local HTTP security checks. No credentials, faucet, or public network is needed to execute those tests after installation; the HTTP tests bind temporary loopback ports.

Verification covers authenticated encryption, owner backup binding, historical key recovery, concurrent revisions, cache corruption, failed/contended rebuilds, provider contracts, signer restart/reconciliation and finalized client semantics. Offline tests remain separate from deployed-WASM sandbox tests and public NEAR/0G acceptance evidence.

For provider setup, run `pnpm provider:doctor` and follow [live integration instructions](docs/INTEGRATIONS.md). Missing prerequisites exit nonzero; the commands never silently substitute test fixtures.

Run `pnpm memory:recover:fixture` for an explicitly local clean-process recovery drill. Live `pnpm memory:recover` requires the configured public deployment, owner backup and real 0G references; it never falls back to that fixture.

Run `pnpm memory:writes:fixture` for an explicitly local process-exit drill at upload/checkpoint boundaries. Fresh processes reconcile each interruption and observe one record upload, one manifest upload and one checkpoint effect. Live write commands use configured providers; they never substitute this fixture.

```sh
pnpm contract:check
```

Contract checks pass **34 Rust unit tests and six sandbox scenarios**, plus formatting, Clippy and optimized WASM compilation. Application scenarios commit memory, settle once, reconcile interruptions, rotate runtime/memory keys, reject revoked keys, and recover in a fresh process after removing runtime keys/journals. The fifth scenario validates external owner pause/resume signing and exact finalized receipt reconciliation without supplying owner/runtime secrets to the application. The sixth scenario verifies externally signed specialist envelopes, restart after reservation/acceptance, one actual sandbox payout and recipient-key recovery after original buyer state is removed. Storage and source/backup readiness fixtures remain explicit. These tests require no AI credentials or public funds. Review [contract rules](docs/CONTRACTS.md), the pre-public-deployment state-layout change, and [client recovery limits](docs/NEAR-CLIENTS.md) before public funding.

Run `pnpm owner:console` to build and serve the existing agent's mission desk and owner controls at **http://127.0.0.1:3377**. It requires the configured public deployment and owner-local recovery files; it has no fake fallback. `pnpm web:build` builds the browser assets with a server-module boundary guard. `pnpm test:e2e` runs 11 explicitly labeled Chromium fixture tests after installing the pinned test browser (`pnpm exec playwright install chromium`).

Run `pnpm missions:recover:fixture` for a clearly labeled three-process source-dossier crash/recovery/review drill. It uses synthetic public text and advances the fixture clock beyond the lease; it has no live-network, AI, upload or payment effect. `pnpm runtime:test` runs mission, commission, specialist and commission-HTTP invariants separately.

## Build specification

- [Native terminal setup and workflows](docs/TERMINAL.md)
- [Product and first release](docs/PRODUCT.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Security and failure model](docs/SECURITY.md)
- [Source selection and attribution](docs/MIGRATION.md)
- [Execution order and release gates](plans/README.md)
- [Verified integration references](docs/REFERENCES.md)
- [Provider setup and live acceptance](docs/INTEGRATIONS.md)
- [NEAR authority, accounting and settlement](docs/CONTRACTS.md)
- [NEAR client setup and transaction recovery](docs/NEAR-CLIENTS.md)
- [Owner backups, recovery and private recall](docs/RECOVERY.md)
- [Portable encrypted owner recovery kit](docs/RECOVERY-KIT.md)
- [Durable memory writes and interrupted-operation reconciliation](docs/MEMORY-WRITES.md)
- [Owner-controlled runtime and memory-key rotation](docs/OWNER-ROTATION.md)
- [Local owner wallet connection and controls](docs/OWNER-CONSOLE.md)
- [Durable source missions and interrupted-work recovery](docs/MISSIONS.md)
- [Signed specialist commissioning and encrypted delivery](docs/COMMISSIONS.md)
- [Console design direction and visual review](docs/CONSOLE-DESIGN.md)

## License and provenance

Apache-2.0. Adapted Sofer code is attributed in `NOTICE` and `migration/provenance.json`. The original source repository remains separate. Existing source is baseline; the hackathon submission must identify this repository's newly implemented NEAR integration and its exact diff.
