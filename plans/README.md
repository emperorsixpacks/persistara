# Persistara execution plan

Prepared 2026-11-06 against Sofer `542813f`. The user delegated product and technical decisions. First-release target: a complete hackathon workflow with explicit production follow-up, not a demo assembled from unverified feature claims.

## Order and status

| Plan | Deliverable | Depends on | Status |
| --- | --- | --- | --- |
| 001 | New repo, provenance, memory protocol and adversarial foundation tests | — | DONE — 20 tests pass; private GitHub repo created |
| 002 | Live 0G storage adapter and verified private inference spike | 001 | IN PROGRESS — adapters and 38 offline tests pass; live gates await credentials/funds |
| 003 | NEAR registry, revocation, budgeted treasury and escrow | 001 | TODO |
| 004 | Recoverable indexed memory and owner recovery workflow | 002, 003 | TODO |
| 005 | Durable missions, signed worker protocol, authenticated API | 003, 004 | TODO |
| 006 | Operational console, live demo, release evidence | 005 | TODO |

Plans 002 and 003 are independent after 001. This is a dependency observation, not permission to spawn other agents. Keep work single-agent unless the operator authorizes delegation.

Foundation evidence: `pnpm check` completed with 20 passing tests in three suites; eight reviewed source hashes matched; tracked-file and whitespace checks passed. Initial implementation commit: `950b82c`. Remote: https://github.com/JemIIahh/persistara (private). Live-provider and contract acceptance gates remain unexecuted.

Provider milestone evidence (2026-11-06): isolated Node 24.22.2; pinned 0G SDK 1.2.13 and NEAR AI SDK 0.2.1 import successfully; 38 tests in seven suites pass. Read-only Galileo RPC reports the expected chain ID, and the public NEAR AI catalog is reachable. No paid upload/inference, real storage proof roundtrip, or live TEE verification has been completed. See `docs/INTEGRATIONS.md` for setup and acceptance commands.

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

Contract, provider, API, and browser scripts named in later plans are **planned interfaces**, not existing commands. Each plan's first implementation step must add its script and document its toolchain. Do not report them passing until they exist and have actually run.
