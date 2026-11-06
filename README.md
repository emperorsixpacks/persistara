# Persistara

**Agents that carry their memory and work forward.**

Persistara is a new successor to Sofer: a workspace for owner-controlled agents with recoverable encrypted memory, durable missions, bounded spending, and accountable agent-to-agent work.

The selected stack is **NEAR ownership and settlement + 0G encrypted storage + NEAR AI inference**. This repository starts fresh. It selectively adapts reviewed Sofer primitives; it is not a renamed copy or a claim that old work was built during the hackathon.

## Current implementation

This is the foundation milestone, not the finished application. Implemented: typed storage and registry boundaries, authenticated memory encryption, encrypted manifests, idempotent memory writes, checkpoint conflict handling, recovery from a committed head, and a local disk-backed blob adapter. Tests exercise corruption, incorrect keys, cross-agent substitution, replay/conflict cases, and recovery without the original memory-service instance.

**Not implemented yet:** live NEAR contracts, live 0G adapter, NEAR AI inference, durable mission worker, authenticated API, or product console. Local/in-memory adapters in tests are explicitly test fixtures, not blockchain deployments. No live network transaction has been performed.

## Development

- Node.js 22.22 or newer for this foundation. The planned verified NEAR AI SDK adapter has a higher runtime requirement; see `docs/ARCHITECTURE.md` before integrating it.
- pnpm 10.26.0.

```sh
pnpm install
pnpm check
```

`pnpm check` typechecks, builds, and runs the foundation tests. No credentials, faucet, or network is needed to execute those tests after installation.

## Build specification

- [Product and first release](docs/PRODUCT.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Security and failure model](docs/SECURITY.md)
- [Source selection and attribution](docs/MIGRATION.md)
- [Execution order and release gates](plans/README.md)
- [Verified integration references](docs/REFERENCES.md)

## License and provenance

Apache-2.0. Adapted Sofer code is attributed in `NOTICE` and `migration/provenance.json`. The original source repository remains separate. Existing source is baseline; the hackathon submission must identify this repository's newly implemented NEAR integration and its exact diff.
