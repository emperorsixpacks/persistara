# 009 — Make the terminal readable and dependable

User feedback (2026-11-09): the native terminal opens with repeated headings, a wall of help and raw login internals; an intermittent NEAR read also interrupted connection. Improve the existing command workspace before adding more surfaces. No AI conversation or enrollment claim is part of this change.

Deliver a compact home screen, short task-oriented help with topic/all expansion, command completion, readable connection/success states, numbered saved-mission selection and restrained optional terminal color. Keep plain/NO_COLOR/non-TTY output usable and JSON unchanged. Untrusted text must be escaped before application-owned styling. Login shows account, scope, exact original public key and no-transaction purpose; the full signed message and digest remain inspectable with `details` before approval. Never compress monetary/action review fields or change their approval requirements.

Use the existing pinned script runtime without changing the user's global Node or shell configuration. Avoid rebuilding at every normal launch; keep an explicit build-and-run development command. An unbuilt launcher gives actionable setup guidance.

Opt the shared local workspace into at most two bounded read-only RPC attempts against the same configured endpoint, with a short backoff and per-attempt timeout. Retry temporary connection failures/HTTP 429/502/503/504 only; do not retry malformed JSON/envelopes, integrity failures, wallet signing, uploads or transaction submissions. Existing RPC clients retain the single-attempt default. Preserve finalized block/code/key checks, unknown-operation fencing and private journals.

Verify failed-read recovery, exhausted/malformed reads, no broadcast retry, login detail/approval behavior, stable numbered selection, escaping/plain/color behavior and narrow help output. Run TypeScript checks and required contract checks. Smoke-test actual startup/help/authenticated saved-mission listing without inference/upload/transactions. Record fixture vs live boundaries and remaining limitations in the plan index.

## Verified — 2026-11-09

224 TypeScript tests / 33 suites, 11 browser regressions, formatting/Clippy, 34 Rust tests and six deployed-WASM scenarios pass. Actual native startup, short help, external original-owner login and the numbered saved-mission list pass against the existing public workspace. The first displayed row reopens the same previously completed source dossier. Running pnpm through the installed host Node 22.22.2 uses the pinned project runtime without the previous engine warning. No global shell/runtime settings changed; no paid effect, upload or inference occurred. Fixture transport tests cover transient success, exhaustion, malformed envelopes, redaction and non-retry of broadcasts. This does not establish provider uptime, conversational-agent parity, enrollment, browser-provider approval or off-device recovery.
