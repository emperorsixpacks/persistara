# 005 — Execute bounded research missions and reconcile every effect

Priority P0 · risk high · effort two days. Depends on 003 and 004. Project: Persistara, NEAR authority/economics + 0G encrypted artifacts + NEAR AI inference. First workflow is a research desk hiring one curated source-gathering specialist.

## Current state and scope

Active no-credit milestone (2026-11-07): implement a complete owner-authenticated source-dossier workflow: persist a bounded brief and zero-NEAR budget, explicitly run an HTTPS-only source collector, retain captured sources, interrupt/recover with fenced leases, assemble a local artifact and record owner review. No inference, model quality assessment, specialist hiring, payment, memory checkpoint or 0G upload is implied by this mode. Existing canonical NEAR/storage journals remain separate. The source-only path remains available alongside the later commissioning milestone below. The model tool loop remains deferred. The console will expose actual journal projections and preserve the existing owner controls.

Design update: use Tender's local interface as a visual reference for its application shell, navigation, type hierarchy, task cards and detail composition. Implement Persistara's own source and code-native artwork with graphite surfaces, copper highlights and cool neutral text. Do not copy Tender source, brand assets or its red accent. Verify desktop, mobile, keyboard, empty/loading/failure and interrupted states.

The source-only mission journal/worker and owner-authenticated local API are now implemented. The signed specialist-commerce milestone is now implemented; the model-driven runner remains unimplemented. Sofer's original `brain/loop.ts` and tests are behavioral references only: provider types, history and in-process concurrency are unsuitable as the durable mission state. Build `packages/runtime`, `apps/worker`, `apps/api`, and signed task envelopes. Preserve `packages/protocol/src/tools.ts` provenance while upgrading validation/outcomes.

## Required model

Active commissioning milestone: attach one curated self-operated source specialist to an immutable mission. Use domain-bound NEP-413 profile/quote/delivery messages and standard JWE `RSA-OAEP-256` / `A256GCM` recipient encryption. A separate specialist CLI retains its wallet in the official NEAR CLI keychain and its recipient key in its private state directory. Owner wallet keys never enter the host. Offline blob preparation precedes quote review; owner acknowledgement precedes brief upload/reservation and exact-delivery acknowledgement precedes settlement. Existing contract WASM and canonical runtime signer journal remain unchanged.

The specialist exchange initially uses downloadable/importable signed files, so no unconfigured remote service or silent fixture is required. All dispatched uploads, reservations, delivery submissions and acceptances have immutable IDs and persisted outcomes; read-only reconciliation cannot issue replacement effects. Complete the no-AI path and restart/finality/crypto/scope tests before bounded public-testnet acceptance. UI keeps the graphite/copper design and labels signed identity, encrypted delivery and finalized payment separately.

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


## Source-only milestone evidence

Implemented: versioned mission/source/event/artifact tables, one immutable brief per request ID, private scope binding, bounded zero-spend inputs, expiring fenced leases, cancellation/shutdown, retained captures, explicit public-read retries, one transactional dossier, exact-digest review and replayable event cursors. The redesigned console consumes these actual projections. Verification: 179 TypeScript tests, eight browser tests, three-process abrupt-exit/recovery fixture, 34 Rust tests and five sandbox scenarios. A real original-owner CLI-keychain login completed a two-source public-documentation dossier with zero spending, no AI and no upload. See `docs/MISSIONS.md` and its sanitized evidence. This does not satisfy the remaining model-loop, SSE, memory-publication or golden-demo requirements above.


## Signed commissioning milestone evidence

Implemented the separate curated specialist executor/CLI, domain-bound signed profile/quote/delivery protocol, standard recipient JWE, schema-2 mission links, private commission journal, authenticated API, native quote/artifact review and callback-aware settlement projections. Unknown uploads, reservations, external delivery handoffs and acceptances retain original IDs/roots/journal identities. Existing jobs survive new-worker policy removal; conclusively failed payouts have explicit fixed-recipient retry with durable per-attempt fencing. Verification: 199 TypeScript tests, 11 Chromium tests, 34 Rust tests and six sandbox scenarios; the new actual-WASM flow exits/restarts after reservation and acceptance, pays once and recovers via copied recipient material after original state removal. Storage/source fixtures remain labeled. See `docs/COMMISSIONS.md` for precise custody, deadline, dispute and indefinitely unknown cases. The model runner, SSE, memory publication, full intervention UI and golden release remain incomplete.
