# Persistara

**Agents that carry their memory and work forward.**

Persistara is a new successor to Sofer: a workspace for owner-controlled agents with recoverable encrypted memory, durable missions, bounded spending, and accountable agent-to-agent work.

The selected stack is **NEAR ownership and settlement + 0G encrypted storage + NEAR AI inference**. This repository starts fresh. It selectively adapts reviewed Sofer primitives; it is not a renamed copy or a claim that old work was built during the hackathon.

Repository: https://github.com/JemIIahh/persistara. Development visibility: private; the hackathon release must be public by its submission deadline.

## Current implementation

Implemented: typed storage and registry boundaries, authenticated memory encryption, encrypted manifests, idempotent memory writes, checkpoint conflict handling, recovery from a committed head, and a local disk-backed blob adapter. Provider adapters now connect the pinned 0G and NEAR AI SDKs through isolated processes, with strict evidence validation and reproducible diagnostic/spike commands.

**Not implemented yet:** NEAR contracts, durable mission worker, authenticated API, or product console. **Live-provider acceptance is pending** funded testnet uploader and NEAR AI credentials; no upload transaction or paid inference has been performed. Galileo RPC identity and the public NEAR AI model catalog have been checked. Local/in-memory test adapters are fixtures, not blockchain deployments.

## Development

- Node.js >=24.22.1. pnpm downloads the pinned project-local Node 24.22.2 runtime; the global installation is unchanged.
- pnpm 10.26.0.

```sh
pnpm install
pnpm check
```

`pnpm check` typechecks, builds, and runs the foundation tests. No credentials, faucet, or network is needed to execute those tests after installation.

Verification: **38 tests passing**, covering authenticated encryption, memory recovery, concurrency, corruption, provider contracts, evidence rejection and worker cancellation. These are offline tests; they are not evidence of a deployed NEAR or 0G integration.

For provider setup, run `pnpm provider:doctor` and follow [live integration instructions](docs/INTEGRATIONS.md). Missing prerequisites exit nonzero; the commands never silently substitute test fixtures.

## Build specification

- [Product and first release](docs/PRODUCT.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Security and failure model](docs/SECURITY.md)
- [Source selection and attribution](docs/MIGRATION.md)
- [Execution order and release gates](plans/README.md)
- [Verified integration references](docs/REFERENCES.md)
- [Provider setup and live acceptance](docs/INTEGRATIONS.md)

## License and provenance

Apache-2.0. Adapted Sofer code is attributed in `NOTICE` and `migration/provenance.json`. The original source repository remains separate. Existing source is baseline; the hackathon submission must identify this repository's newly implemented NEAR integration and its exact diff.
