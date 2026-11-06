# 005 — Execute bounded research missions and reconcile every effect

Priority P0 · risk high · effort two days. Depends on 003 and 004. Project: Persistara, NEAR authority/economics + 0G encrypted artifacts + NEAR AI inference. First workflow is a research desk hiring one curated source-gathering specialist.

## Current state and scope

The new repo has crypto/memory primitives, not a mission runner. Sofer's original `brain/loop.ts` and tests are behavioral references only: provider types, history and in-process concurrency are unsuitable as the durable mission state. Build `packages/runtime`, `apps/worker`, `apps/api`, and signed task envelopes. Preserve `packages/protocol/src/tools.ts` provenance while upgrading validation/outcomes.

## Required model

Mission records: objective, deliverable criteria, owner/agent, policy snapshot, budget, state/version, artifact references, and cancellation/approval events. Action records: stable operation ID, canonical request digest, policy/delegate generation, lease fence, observed external reference, attempts and outcome. Use integer amounts with asset and network identity.

Persist actions before submitting effects. States include `queued`, `authorized`, `submitted`, `unknown`, `confirmed`, `failed`, `canceled`. Unknown outcomes are reconciled before replay. Do not claim exactly-once external execution. Use contract deduplication plus durable outbox/reconciliation.

## Steps

1. Add SQLite journal migrations and repositories for missions, actions, events, leases, cursors and artifacts. Use transactional append/projection updates, one writer owner, and fenced leases. Add `runtime:test` and migration commands with fixtures.
2. Reimplement provider-neutral tool loop, cancellation, compaction and bounded rounds. Preserve tool result ordering and valid history under streaming failures. Record enough normalized message/tool state to resume without duplicating completed actions; do not store hidden chain-of-thought.
3. Implement narrow research capabilities: permitted public web retrieval with URL/network controls, source extraction, memory recall, artifact creation, quote request, job reservation, delivery inspection, and settlement request. No unrestricted shell, no key-store filesystem access, no arbitrary host fetch.
4. Define signed, expiring task/quote/delivery envelopes with recipient, operation ID, criteria hash, sequence and network-bound amounts. Use standard signature/key handling. Model evaluations may recommend acceptance but cannot change authorized amount/recipient.
5. Connect treasury reservation and receipt reconciliation. Check authorization before each new effect and fence stale workers. Crash recovery consults the durable action and on-chain state; it never invents a new operation merely to make a retry succeed.
6. Build API authentication with NEAR owner challenge, domain/origin and nonce binding, short-lived sessions, request limits, agent resource scoping, and no secrets in browser payloads. Add mission/memory/artifact/event endpoints with replayable SSE cursors and explicit pending/error states.
7. Run a mission from brief to sourced artifact and native-NEAR settlement. Exercise owner intervention, dispute, expiry, cancellation, and provider outages. UI-ready projections come from durable state, not transient model text.

## Verification and done criteria

`pnpm check`, contract tests, and new `pnpm runtime:test` pass. Fault-injection tests kill/restart at intent persistence, quote, reservation submission, delivery, payout submission, and callback reconciliation. Assert no duplicate job/payout, no lost confirmed artifact, and correct unknown-state reconciliation.

Negative tests cover expired leases, two workers racing, malicious retrieved instructions requesting a policy change/payment, unauthorized API access, replayed login challenge, cross-owner mission IDs, malformed tools, and event-cursor replay. Reviewer can inspect every money-affecting operation and its evidence.

## Stop conditions

An action can execute without persisted authorization; an owner key reaches model tools; an unresolved payment is retried as a new request; user/session scoping is only in the browser; a worker continues after lease revocation. Fix these before adding the console.
