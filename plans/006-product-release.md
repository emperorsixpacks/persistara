# 006 — Ship the operational product and demonstrate its real boundaries

Priority P0/P1 · risk medium · effort one to two days after integration. Depends on 005. First release: a complete hackathon research-mission workflow on NEAR testnet with 0G storage and precisely labeled inference evidence. This is not an audited production custody launch.

## Scope

Create `apps/console` using the authenticated API from 005. Add browser acceptance tests, operational runbook, sanitized evidence bundle, reproducible judge README, and draft submission assets. Existing Sofer web work remains separate. When implementing a website with Sites, read the applicable Sites skill and follow its local-source workflow; do not assume a publish action is authorized by this implementation plan alone.

## Experience and visual direction

Updated by the owner on 2026-11-07: take Tender as a visual-quality reference with a different palette. The implemented design uses graphite surfaces, copper highlights, cool neutral text, an application sidebar, task cards and a dedicated dossier/timeline layout. Preserve clear typography, spacing and artifact/evidence hierarchy. Brand symbol should express continuity without a generic robot face. Use a code-native mark unless generated imagery has a concrete role. Respect reduced motion, keyboard navigation, contrast, small screens, and readable monetary values.

Primary navigation: Missions, Memory, Controls, Evidence. The first screen helps the user start or resume a mission. A mission combines objective, timeline, budget/reservations, worker quote, sourced artifact preview, review actions, and precise settlement status. Keep provider implementation details in inspectable evidence panels, not mandatory onboarding prose.

## Steps

1. Build a real design system and representative API-backed screens before visual polish. Add explicit loading, empty, paused, revoked, offline, retrying, unknown-payment, and failed-verification states.
2. Implement onboarding: connect owner, register agent, backup/recovery verification, testnet treasury funding, provider readiness. A read-only visitor can inspect a sanitized demo without access to owner controls.
3. Implement the complete mission flow and signed worker artifact preview. Pending reservations are distinguished from settled spending; no browser-only budget enforcement.
4. Implement memory sources/revisions and separate-process recovery action. Make clear that the agent ID without recovery material cannot decrypt memory.
5. Implement controls and evidence. Evidence names exactly which property was checked: ciphertext integrity, NEAR finality, signer authority, or inference signature/attestation. No aggregate badge asserts report truth or runtime attestation.
6. Add `web:build` and `test:e2e` scripts. Test the product in a real browser at desktop and mobile sizes. Run keyboard/accessibility checks on mission review and recovery controls.
7. Perform the golden live demo: remember -> mission -> commission -> interrupt -> resume -> recover on clean runtime -> review artifact -> settle -> reject an over-budget request. Store sanitized transaction roots, explorer links, dependency versions and verification reports.
8. Rewrite README around implemented behavior, exact setup, fixtures vs live paths, costs, prerequisites, and known limitations. Document imported baseline and the new NEAR integration diff. Prepare X demo text/video and the exact submission payload for user review. Follow current hackathon handbook for any final publishing/submission requirements.

## Release gates

- Existing `pnpm check`, contract and runtime checks plus new `pnpm web:build` and `pnpm test:e2e` pass.
- No fixture is used silently in the live demo; missing credentials produce an actionable prerequisite state.
- Complete journey is captured with actual network evidence and a reproducible reviewer command sequence.
- Public logs/evidence contain no secrets, private prompts, plaintext memory, or hidden model reasoning.
- Failure/recovery runbook and production-follow-up issues exist. Performance claims match measured trials.
- User has a concrete release candidate to review before irreversible publication or final hackathon submission where confirmation is required.

## Stop conditions and production follow-up

Do not release if P0 money/recovery invariants fail, a mock is labeled live, evidence is fabricated, or a private key is in tracked files/browser bundles. Defer secondary animations/features before weakening those gates. Mainnet, third-party contract review, multi-tenant isolation, key-management operations, and availability/cost monitoring are subsequent production work.


## Commissioning console checkpoint

The mission detail now supports signed task export, quote import/exact-cost review, encrypted delivery import/preview, digest-bound settlement and read-only reconciliation with pending/failed/paid callback distinctions. Existing graphite/copper design and mobile/keyboard behavior are preserved. Eleven browser-fixture tests pass; quote, desktop-delivery and phone-settlement captures in `docs/images` were visually inspected. Current total: 199 TypeScript tests, 34 Rust tests and six sandbox scenarios. This is a local owner-host milestone; public hosting, actual browser-wallet approval, model-driven golden demo, off-device custody, benchmarks and submission artifacts remain release gates.
