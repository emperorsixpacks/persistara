# Persistara

**Agents that carry their memory and work forward.**

Persistara is a new successor to Sofer: a workspace for owner-controlled agents with recoverable encrypted memory, durable missions, bounded spending, and accountable agent-to-agent work.

The selected stack is **NEAR ownership and settlement + 0G encrypted storage + NEAR AI inference**. This repository starts fresh. It selectively adapts reviewed Sofer primitives; it is not a renamed copy or a claim that old work was built during the hackathon.

Repository: https://github.com/JemIIahh/persistara. Development visibility: private; the hackathon release must be public by its submission deadline.

## Current implementation

Implemented: typed storage and registry boundaries, authenticated memory encryption, encrypted manifests, idempotent memory writes, checkpoint conflict handling, recovery from a committed head, and a local disk-backed blob adapter. Provider adapters connect the pinned 0G and NEAR AI SDKs through isolated processes, with strict evidence validation and reproducible diagnostic/spike commands. A Rust NEAR authority contract now implements owner/delegate permissions, revocation, memory checkpoints, native budgets, escrow, callbacks and timeout refunds.

NEAR clients now wire memory checkpoints and job reservation/acceptance through a restricted signer process and a durable SQLite transaction journal. Finalized reads and same-transaction reconciliation keep uncertain outcomes separate from success or failure.

Owner recovery now includes encrypted backup bundles, historical keyrings, authenticated snapshot restoration and a private full-text recall cache with source/revision metadata. A separate-process drill restores after deleting the original runtime state. See [recovery commands and boundaries](docs/RECOVERY.md).

**Not implemented yet:** durable memory-upload intents, full owner epoch-rotation orchestration, embeddings, durable mission worker, authenticated API, or product console. Public NEAR testnet deployment and live-provider acceptance remain pending. The 0G uploader has 0.5 testnet 0G; NEAR AI credentials/credits are deferred. No upload transaction or paid inference has been performed. Local fixtures and the disposable NEAR sandbox are separate from public-chain acceptance evidence.

## Development

- Node.js >=24.22.1. pnpm downloads the pinned project-local Node 24.22.2 runtime; the global installation is unchanged.
- pnpm 10.26.0.
- For contracts: Rust 1.96.0 (selected by `rust-toolchain.toml`) and cargo-near 0.22.0. See [contract setup and exact semantics](docs/CONTRACTS.md).

```sh
pnpm install
pnpm check
```

`pnpm check` typechecks, builds, and runs **77 TypeScript tests in 13 suites**. No credentials, faucet, or network is needed to execute those tests after installation.

Verification covers authenticated encryption, owner backup binding, historical key recovery, concurrent revisions, cache corruption, failed/contended rebuilds, provider contracts, signer restart/reconciliation and finalized client semantics. Offline tests remain separate from deployed-WASM sandbox tests and public NEAR/0G acceptance evidence.

For provider setup, run `pnpm provider:doctor` and follow [live integration instructions](docs/INTEGRATIONS.md). Missing prerequisites exit nonzero; the commands never silently substitute test fixtures.

Run `pnpm memory:recover:fixture` for an explicitly local clean-process recovery drill. Live `pnpm memory:recover` requires the configured public deployment, owner backup and real 0G references; it never falls back to that fixture.

```sh
pnpm contract:check
```

Contract checks pass **25 Rust unit tests and three sandbox scenarios**, plus formatting, Clippy and optimized WASM compilation. The application scenario commits memory, settles a native payment, prevents duplicate acceptance, and recovers memory in a fresh process without its signer key or journal. It uses explicitly synthetic local storage. These tests require no AI credentials or public funds. Review [contract rules](docs/CONTRACTS.md) and [client setup/recovery limits](docs/NEAR-CLIENTS.md) before public funding.

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

## License and provenance

Apache-2.0. Adapted Sofer code is attributed in `NOTICE` and `migration/provenance.json`. The original source repository remains separate. Existing source is baseline; the hackathon submission must identify this repository's newly implemented NEAR integration and its exact diff.
