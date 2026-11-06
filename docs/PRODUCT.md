# Product specification

Decision date: 2026-11-06. Working brand: **Persistara**, pronounced persist-AH-ra. The name evokes continuity; it is not a claim of trademark or domain availability. Initial collision searches found no obvious directly competing agent product under this exact name.

## The product

An owner gives a persistent agent a mission and a bounded budget. The agent remembers relevant preferences, commissions a specialist when useful, produces a sourced artifact, and settles the job with a reviewable record. It can resume after interruption and recover its committed memory on another machine with owner-held recovery material.

Primary users: independent researchers, small technical teams, and operators running specialist agents. First use case: a research desk that commissions a source-gathering specialist to produce a competitor brief. This gives memory, delegation, artifact review, budgets, and payment one coherent reason to exist.

The first release is a complete hackathon application with a foundation intended for later production hardening. It must not be presented as audited custody infrastructure. Deadline from the current handbook: 2026-11-14 23:59 UTC. Runtime outages and provider delays affect the schedule; required quality gates do not become optional when time is short.

## Differentiation from Sofer

| Sofer baseline | Persistara release requirement |
| --- | --- |
| Conversational process with tool calls | Persisted mission and action state with resumable execution |
| Memory delegated to MemWal | Portable encrypted memory protocol and rebuildable retrieval index |
| Runtime holds chain signer | Separate signer boundary; treasury contract enforces permissions and budgets |
| Market primitives exposed as tools | One complete request, quote, reservation, delivery, review, settlement flow |
| Several surfaces and overlapping claims | One operational console that displays actual state and evidence |
| Ad hoc messaging encryption | Signed task envelopes and reviewed encryption; no custom key agreement |

## First-release capabilities

1. Register a NEAR-owned agent with a stable agent ID and revocable runtime key.
2. Save and recall encrypted facts; show source, creation time, revision, and freshness.
3. Recover committed memory on a clean runtime using a registry head and owner recovery material. Rebuild the retrieval index rather than depending on a particular database.
4. Start a research mission with explicit deliverable criteria, provider constraints, and a native-NEAR budget.
5. Commission one specialist through signed, expiring quotes; reserve funds and receive an encrypted artifact.
6. Review concrete output criteria and sources. The model's quality judgment is advisory; the contract does not prove output truth.
7. Settle or enter an explicit dispute/timeout path. Display transaction finality and unknown outcomes accurately.
8. Pause/revoke the agent and demonstrate that a stale runtime cannot reserve more money or advance the memory head.
9. Inspect receipts that distinguish source provenance, storage integrity, contract settlement, and verified inference evidence.

## Main product experience

- **Onboarding:** connect owner account, create agent, back up recovery material, fund testnet treasury, verify integrations. Explain the recovery step before accepting a claim of portability.
- **Mission desk:** brief, output criteria, maximum spend, worker quote, mission timeline, remaining budget, artifact preview, review controls.
- **Memory:** searchable facts with sources, revisions, and export/recovery actions. Distinguish pending local writes from committed memory.
- **Controls:** delegate permissions, contract budgets, owner pause, expiry, and key epoch.
- **Evidence:** readable receipts with explorer links and precise verification status. No badge implying a property that was not checked.

## Golden demo

Create an agent; remember a preference; fund its treasury; commission a bounded research task; interrupt the worker; resume it; recover memory into a clean runtime; receive the sourced report; settle once; then attempt an over-budget reservation and demonstrate the contract rejection. Show actual NEAR and 0G testnet references alongside the report. Keep inference verification distinct from research correctness.

## Release metrics

- A new reviewer completes the documented happy path without private team knowledge.
- Every committed memory is recoverable from the recorded head and correct keys; corrupted/wrong-key content is rejected.
- Duplicate action delivery and process restarts cause no duplicate reservation or payout.
- Unauthorized, expired, paused, and over-budget requests are rejected by NEAR contracts, not just the UI.
- Provider outages leave explicit retryable/unknown states and a recoverable mission; no false success.
- Run a documented five-trial live-provider benchmark and report actual latency, cost, failure rate, and recovery time. Set numerical performance claims only after measurement.

## Deferred expansion

Stablecoin/Intents funding, multiple worker markets, reusable skills marketplace, cross-owner agent sale, automated reputation weighting, shared multi-agent memory, and hosted multi-tenant execution follow the first complete loop. These are product expansion, not excuses to omit failure handling in the initial scope.

No token launch is needed. No new consensus or cryptography is needed. Arbitrary shell execution is not exposed to the initial research workflow.
