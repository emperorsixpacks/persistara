# Persistara

**Agents that carry their memory and work forward.**

Persistara is a new successor to Sofer: a workspace for owner-controlled agents with recoverable encrypted memory, durable missions, bounded spending, and accountable agent-to-agent work.

The selected stack is **NEAR ownership and settlement + 0G encrypted storage + NEAR AI inference**. This repository starts fresh. It selectively adapts reviewed Sofer primitives; it is not a renamed copy or a claim that old work was built during the hackathon.

Repository: https://github.com/JemIIahh/persistara. Development visibility: private; the hackathon release must be public by its submission deadline.

## Current implementation

Implemented: typed storage and registry boundaries, authenticated memory encryption, encrypted manifests, idempotent memory writes, checkpoint conflict handling, recovery from a committed head, and a local disk-backed blob adapter. Provider adapters connect the pinned 0G and NEAR AI SDKs through isolated processes, with strict evidence validation and reproducible diagnostic/spike commands. A Rust NEAR authority contract now implements owner/delegate permissions, revocation, memory checkpoints, native budgets, escrow, callbacks and timeout refunds.

NEAR clients now wire memory checkpoints and job reservation/acceptance through a restricted signer process and a durable SQLite transaction journal. Finalized reads and same-transaction reconciliation keep uncertain outcomes separate from success or failure.

Owner recovery now includes encrypted backup bundles, historical keyrings, authenticated snapshot restoration and a private full-text recall cache with source/revision metadata. A separate-process drill restores after deleting the original runtime state. See [recovery commands and boundaries](docs/RECOVERY.md).

Durable memory writes now journal encrypted intents, ciphertext roots and exact checkpoint attempts before external effects. Interrupted uploads are probed without re-uploading; interrupted checkpoints reconcile through the same signer journal. Leases fence stale processes. See [write, resume and reconciliation commands](docs/MEMORY-WRITES.md), including the cases that remain unknown and must not be retried.

Owner-controlled runtime/memory-key rotation now prepares verified replacement backups, drains and holds the original journals, atomically revokes/advances authority, and verifies restricted account-key replacement. Owner signing stays outside the runtime through reviewable unsigned requests. A new sandbox flow writes under the new epoch and recovers historical memory after both runtimes are removed. See [owner rotation and signing boundaries](docs/OWNER-ROTATION.md).

Real 0G Turbo acceptance now passes: an application-encrypted specimen was uploaded, finalized, retrieved with a Merkle proof and decrypted, then retrieved/decrypted in another process without uploader credentials. Durable acceptance intents fence resubmission after interruption; the uploader enforces a per-transaction testnet cost ceiling. See [sanitized live evidence](docs/evidence/0g-testnet-2026-11-07.json).

Public NEAR acceptance now passes on `authority.persistara-owner.testnet`: a restricted runtime committed memory backed by real Turbo blobs, a clean process recovered the first record from an encrypted owner backup, and a fictional job settled 0.01 testnet NEAR once. Stale checkpoints and over-budget reservations were rejected by the contract. External owner/specialist signing uses the official NEAR CLI keychain. See [public deployment, recovery and settlement evidence](docs/evidence/near-0g-testnet-2026-11-07.json).

**Not implemented yet:** embeddings, durable mission worker, signed specialist protocol, authenticated API, product console or browser owner-wallet signing integration. Two-fact/source/revision recovery, live key rotation, physical cross-machine/off-device backup drills and the five-trial benchmark remain release gates. NEAR AI credentials/credits and paid inference are deferred. The live specimen tests mechanical storage/settlement, not research output or model quality. Local fixtures and disposable NEAR sandbox results remain separate from public-chain evidence.

## Development

- Node.js >=24.22.1. pnpm downloads the pinned project-local Node 24.22.2 runtime; the global installation is unchanged.
- pnpm 10.26.0.
- For contracts: Rust 1.96.0 (selected by `rust-toolchain.toml`) and cargo-near 0.22.0. See [contract setup and exact semantics](docs/CONTRACTS.md).

```sh
pnpm install
pnpm check
```

`pnpm check` typechecks, builds, and runs **142 TypeScript tests in 20 suites**. No credentials, faucet, or network is needed to execute those tests after installation.

Verification covers authenticated encryption, owner backup binding, historical key recovery, concurrent revisions, cache corruption, failed/contended rebuilds, provider contracts, signer restart/reconciliation and finalized client semantics. Offline tests remain separate from deployed-WASM sandbox tests and public NEAR/0G acceptance evidence.

For provider setup, run `pnpm provider:doctor` and follow [live integration instructions](docs/INTEGRATIONS.md). Missing prerequisites exit nonzero; the commands never silently substitute test fixtures.

Run `pnpm memory:recover:fixture` for an explicitly local clean-process recovery drill. Live `pnpm memory:recover` requires the configured public deployment, owner backup and real 0G references; it never falls back to that fixture.

Run `pnpm memory:writes:fixture` for an explicitly local process-exit drill at upload/checkpoint boundaries. Fresh processes reconcile each interruption and observe one record upload, one manifest upload and one checkpoint effect. Live write commands use configured providers; they never substitute this fixture.

```sh
pnpm contract:check
```

Contract checks pass **34 Rust unit tests and four sandbox scenarios**, plus formatting, Clippy and optimized WASM compilation. Application scenarios commit memory, settle once, reconcile interruptions, rotate runtime/memory keys, reject revoked keys, and recover in a fresh process after removing runtime keys/journals. They use explicitly synthetic local storage. These tests require no AI credentials or public funds. Review [contract rules](docs/CONTRACTS.md), the pre-public-deployment state-layout change, and [client recovery limits](docs/NEAR-CLIENTS.md) before public funding.

## Build specification

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
- [Durable memory writes and interrupted-operation reconciliation](docs/MEMORY-WRITES.md)
- [Owner-controlled runtime and memory-key rotation](docs/OWNER-ROTATION.md)

## License and provenance

Apache-2.0. Adapted Sofer code is attributed in `NOTICE` and `migration/provenance.json`. The original source repository remains separate. Existing source is baseline; the hackathon submission must identify this repository's newly implemented NEAR integration and its exact diff.
