# Plan 011: Add durable conversation sessions and a bounded assistant loop

> Executor: read this file fully, check drift, then implement one verified offline milestone. Update this plan's status in `plans/README.md` only after its gates pass. This is **not implemented** at handoff. Live paid inference remains a separate acceptance gate.
>
> Drift check: `git diff --stat 4d2bbfd..HEAD -- scripts/cli.ts packages/terminal packages/operator packages/inference packages/runtime packages/memory tests package.json tsconfig.json`. Compare the excerpts below with current source before coding. Resolve intervening changes before applying this plan; do not overwrite another builder's work.

## Status and purpose

- Status: **Offline core DONE (2026-11-10)**; live inference/streaming acceptance remains open. Evidence: `pnpm check` now 274 tests pass (265 at the core milestone, +9 for unknown-attempt resolution, agent display names and encrypted session backup; the core 35 new were: 12 journal, 12 runner, 7 tools, 3 terminal integration, 1 Ink application session); `pnpm test:e2e` 11 pass; `git diff --check` clean. `pnpm contract:check` passed on 2026-11-10 (fmt, Clippy, contract tests, six sandbox scenarios; no contract file changed). No paid call, upload, payment or owner transaction occurred. Remaining limits: disabled by default; real provider adapter wiring is untested live; no streaming; unknown attempts are resolved by the owner with `/session resolve` and sessions have an encrypted owner backup/restore (`pnpm conversations:backup|backup:verify|restore`), both added after the core milestone and tested offline only; the Ink loop is covered by a synthetic application test (natural text, escaped reply, session label, canceled prompt, Ctrl+C after dispatch), but there is no real-terminal capture.
- Priority: P0 for the product; effort L; change risk HIGH because model suggestions meet authorization and charged-request boundaries.
- Category: direction / runtime architecture.
- Planned at: `4d2bbfd2aadb9e8c25db3f5fd0ea32b70dd2e972`, 2026-11-09.
- Depends on: the implemented foundations in plans 001–003 and 008–010. Continues the unfinished model-loop portion of plan 005; does not claim to complete all of 004–007.

Persistara's real terminal UI and NEAR/0G mission engine work, but ordinary text reaches an unknown-command response. The missing component is a conversation/session coordinator, not a UI redesign or an API-key toggle. The first milestone must establish private durable sessions, valid model/tool history, bounded execution and explicit unknown-outcome handling without buying credits or making real model requests.

The user wants the CLI to be the primary product, with the interaction quality of modern coding CLIs. Preserve its existing composer/menu/paging and copper/neutral design. Further companion web redesign is deferred. NEAR owns authority/spending; 0G stores authenticated ciphertext; the model does not gain wallet keys or unrestricted tools. Chat sessions and committed long-term memory are different datasets.

## Current code and conventions

All paths are relative to the Persistara repository (configured checkout `/Users/ram/Desktop/persistara`), not the separate Sofer repository.

1. `packages/terminal/src/application.tsx:123` owns the current interactive application loop:

   ```ts
   const line = await store.ask("Command", "command"); if (line === null) break;
   let args: string[] = [];
   try { args = words(line); if (!args.length) continue; if (!await shell.dispatch(args)) break; }
   catch (error) { store.print(errorText(error), "warning"); }
   ```

2. `packages/terminal/src/shell.ts:59` implements existing operator commands. At line 67, unknown commands print `Unknown terminal command. AI chat is not available yet. Use /help for the implemented workflow.` This is the missing routing point, not evidence that a model answered. Known commands still need their current authentication and review behavior.

3. `packages/terminal/src/application-state.ts` holds bounded **ephemeral UI** state. It has no durable session store. `ApplicationStore.ask` resets input; form/approval replies are excluded from command history; multiline paste is one input value. Reuse these protections.

4. `packages/inference/src/provider.ts` already defines:

   ```ts
   export interface InferenceRequest {
     operationId: string;
     messages: ChatMessage[];
     tools?: ToolDefinition[];
     maxOutputTokens?: number;
   }
   export interface InferenceProvider {
     complete(request: InferenceRequest, options?: CallOptions): Promise<InferenceResult>;
   }
   ```

   `ChatMessage` includes assistant tool calls and matching tool-result IDs. `InferenceResult` includes text, tool calls, usage and verified evidence. Preserve valid tool-message ordering; do not inject raw SDK response objects into history.

5. `packages/inference/src/near-ai.ts:43` implements `NearAiProvider`. It validates request/output bounds and advertised tools, requires `NEARAI_API_KEY` and `NEARAI_MODEL`, then invokes an isolated worker marked `effect: "may-charge"`. `near-ai-worker.ts:35` currently sends `stream: false`; it verifies model/gateway evidence, E2EE and a model-bound response signature before returning usable output. Live acceptance is still unverified. Do not weaken this contract or add automatic paid retries.

6. `packages/terminal/src/client.ts` owns current-owner/session/scope checks (`current`, `authorize`, `list`, `detail`) and explicit reviewed economic actions. `packages/operator/src/workspace.ts` constructs the single shared engine; `packages/operator/src/memory.ts` wires committed keyword recall/rebuild. Keep authorization outside model judgment.

7. Follow the private SQLite/migration/scope/transaction pattern in `packages/runtime/src/journal.ts`, integer/canonical helpers in `packages/near/src/protocol.ts`, typed `ProviderError` in `packages/protocol/src/providers.ts`, and private-file helpers in `packages/memory/src/files.ts`. Private directories/files are 0700/0600, symlinks are rejected and network work stays outside DB transactions. The owner machine is the trusted plaintext runtime; existing mission journals already contain private plaintext. Document conversation retention/custody rather than claiming a new encryption/portable-backup scheme.

8. Tests use `node:test` / strict assertions. See `tests/terminal-application.test.tsx`, `tests/terminal.test.ts`, `tests/durable-memory.test.ts` and disposable `tests/fixtures/commerce-support.ts` / `owner-support.ts`. Synthetic wallets/transport/evidence remain test-only. Node 24.22.2, pnpm 10.26.0, strict NodeNext TypeScript and existing dependency pins are the baseline.

## Scope

In scope (proposed new paths are not existing APIs):

- New `packages/conversation/src/types.ts`, `journal.ts`, `runner.ts`, `tools.ts` and `service.ts` for the bounded conversation domain.
- New `packages/operator/src/conversation.ts` for provider readiness, explicit live opt-in and dependency injection; minimal wiring in `workspace.ts` only if required.
- Minimal changes to `scripts/cli.ts`, `packages/terminal/src/application.tsx`, `application-state.ts`, `shell.ts`, `render.ts` and `client.ts` to route text/session actions and preserve the owner boundary.
- New `tests/conversation-journal.test.ts`, `conversation.test.ts`, `conversation-tools.test.ts`, `tests/fixtures/conversation-support.ts`; focused additions to existing terminal tests.
- `docs/TERMINAL.md`, `docs/SECURITY.md`, `README.md`, this plan and `plans/README.md` for exact behavior/limits after implementation.

Out of scope: contract source/deployment/state migration; existing funded accounts/keys/journals; cryptographic protocol changes; 0G uploads/memory checkpoint publication; browser redesign/auth changes; generic shell/filesystem/fetch tools; automatic payments or owner mutations; daemon/Telegram; embeddings; public hosting/submission; provider switching; dependency upgrades; live paid inference. If a boundary must expand, report the concrete reason and resolve scope before changing it.

## Exact verification commands

| Gate | Command | Expected result |
| --- | --- | --- |
| Install if needed | `pnpm install --frozen-lockfile` | Exit 0; no unrequested dependency/lock changes |
| Existing baseline | `pnpm check` | Exit 0; at least the existing 230 tests pass |
| Journal step | `pnpm build && ./node_modules/node/bin/node --test dist/tests/conversation-journal.test.js` | New journal tests pass offline |
| Runner/tool step | `pnpm build && ./node_modules/node/bin/node --test dist/tests/conversation.test.js dist/tests/conversation-tools.test.js` | New bounded-loop tests pass offline |
| Terminal integration | `pnpm build && ./node_modules/node/bin/node --test dist/tests/terminal-application.test.js dist/tests/terminal.test.js` | Existing and new UI/controller boundaries pass |
| Browser regressions | `pnpm exec playwright install chromium` then `pnpm test:e2e` | Exit 0; existing 11 browser tests remain green |
| Contract regressions | `pnpm contract:check` | Exit 0; formatting/Clippy, 34 Rust tests and six sandbox scenarios remain green |
| Final scope | `git diff --check` and `git status --short` | No whitespace errors or unrelated/private files |

New conversation test paths above are deliverables to create, not commands claimed to exist at handoff. Build once before filtered Node test commands; do not run multiple compilers into the same `dist/` concurrently. HTTP/browser/sandbox checks need loopback permission. Tests require no production `.env`, wallets, public funds or AI credits. The baseline CI at handoff is <https://github.com/JemIIahh/persistara/actions/runs/42582132526>.

## Ordered implementation

### 1. Establish private session identities and a journal

Create scope-bound session and turn types. Scope includes owner, agent, chain, contract and checked authority code hash. A selected session belongs to one scope and is private owner-runtime data. Preserve immutable user-request IDs, monotonic message order and per-turn versions. Use an explicit SQLite schema version and transactional append/projection updates, not loose JSON files or a second mission database.

Journal normalized messages, inference attempts and tool actions separately. Each inference attempt needs a stable operation ID, request digest/model/caps, queued/dispatched/terminal status, optional observed completion ID, evidence/usage and failure code. Persist intent **before** invoking a provider. A dispatched attempt interrupted by a process exit becomes outcome-unknown on reopen. Never turn restart into an automatic replacement request.

Use CAS plus a renewable fenced lease for one active turn per session. A second process must not submit for the same live lease or a dispatched unknown attempt. New session state must not repurpose/delete the canonical mission, memory, commission, signer or owner journals. Do not put API credentials, wallet material, hidden model reasoning or full attestation blobs into messages/receipts.

**Verify:** journal-step command above. Cover fresh/reopened state, wrong scope/key ownership, migration rejection, immutable request conflict, stale revision/fence, concurrent acquisition, crash after dispatch, corrupt records and refusal of insecure/symlink paths. Confirm old journals are untouched.

### 2. Build an injected, bounded conversation coordinator

Make the runner depend on `InferenceProvider`, the session journal, an owner-authorized tool port and `AbortSignal`. Do not import the concrete SDK into React or construct a fixture provider in production code. Normalize assistant/tool history through the existing provider types and validation.

For this first milestone, default to at most **four model rounds per turn**, **four tool calls per round**, **1,024 output tokens per call**, and the existing **128-message / 256 KB request limit**. Validate/persist caps as integers. Reject an over-cap tool batch before executing any of it. If history cannot fit, return a clear context-limit state; do not silently drop unresolved tool results or invent a model-generated compaction without another journaled request. A verified `finishReason: "length"` response is explicitly limited/partial, not a completed answer or permission for another automatic charged call.

Persist dispatch before `complete`, then persist the verified result before using a tool request. Preserve tool-call IDs and argument digests. Re-observing a completed tool action must reuse its recorded outcome; the same ID with changed arguments is a conflict. Record new message/tool state transactionally before the next model round. Reject unknown tools, invalid schemas, mismatched results and failed evidence.

On timeout, cancellation, disconnection or process loss after possible submission, retain the existing attempt as unknown unless there is positive evidence it was not submitted. Unknown attempts remain fenced with an inspectable ID. Cancellation cannot retract a request already accepted by a provider. Never automatically resubmit a charged request or describe an unknown bill as zero cost. Store token usage when known; request/token caps are not a USD spending guarantee. Live provider-specific price/cap validation follows in another acceptance milestone.

**Verify:** runner/tool-step command. Test reply-only turns, multi-round tools, ordering, duplicate/conflicting calls, bounds, corrupt/unverified replies, cancellation before/after dispatch, lost completion IDs, process reopen, lease loss and no duplicate provider invocation. A test-only scripted provider lives only under `tests/fixtures/` and has explicit synthetic provenance.

### 3. Advertise only three read-only assistant tools initially

Implement `mission_list`, `mission_detail` and `memory_recall`. Use explicit schemas and bounded arguments/results. Obtain current owner/session/scope authorization through the existing `TerminalClient` boundary before private reads; do not hand raw journals, keyrings or filesystem paths to a model tool.

Mission tools use the existing controller projections. Memory recall uses the existing committed-head/index path and returns source/revision/freshness metadata as **untrusted data**. Bound serialized results (for example 16 KB per result); if a meaningful result cannot fit, return an explicit limit outcome rather than silently chopping provenance or settlement fields.

There is no `dispatch_command`, arbitrary URL fetch, filesystem reader, upload, reservation, payment, pause/rotation or memory-write tool in this milestone. Natural-language suggestions can describe proposed work; they cannot invoke operator commands. Existing manual commands/reviews remain available to the human.

**Verify:** tool-step tests. Wrong scope, expired owner proof, missing/corrupt memory cache and oversized results fail without new effects. A retrieved source containing `/reserve`, “ignore policy” or fake approval text cannot reach signing/upload/payment. Assert fake economic counters remain zero.

### 4. Route conversations without disturbing commands or review input

Add a small conversation port to both application and plain command loops. Leading `/` commands retain operator behavior; unknown slash commands remain errors, not model requests. Preserve documented bare command aliases where their grammar matches; treat other ordinary input as conversation text. Do not reinterpret an answer to `TerminalIO.ask` as a new chat turn or command.

Provide explicit `/sessions`, `/session new`, and `/session open <id>` actions with scope/owner checks, selected-session indication and durable reopen. Keep `--resume <mission-id>` as **mission** selection; do not silently change it into conversation resume. Do not write durable chat state in `ApplicationStore`; it remains only the renderer/draft buffer. Never persist form/approval input as command history.

At live-provider-disabled/missing configuration, show an actionable AI-not-enabled/readiness message and make **zero** provider calls. A key's presence alone does not authorize new spending. Production live completion requires explicit operator opt-in plus configured limits; keep it disabled until the separate live acceptance is authorized. The no-credit milestone may exercise the full route with injected fixtures in tests only. Never ship a default canned “hello” reply or silently switch providers.

Use the current spinner/elapsed feedback for the non-streaming adapter. Verified streaming is deferred; do not render simulated token streams or execute tools based on provisional deltas. Escape model output exactly as other untrusted text. Preserve plain/JSON/operator behavior, narrow layout, paste handling, original-key connection, payment review and terminal cleanup.

**Verify:** terminal integration command and new conversation tests. Test natural text, known/unknown slash commands, no-configuration/no-opt-in, owner expiry, session switching/reopen, injected replies, quoted command input, prompt cancellation and malicious multiline paste. A fixture-assisted conversation can inspect saved work, exit and reopen its stored history with matching IDs; normal production startup without credentials shows no synthetic answer.

### 5. Close the offline milestone and document the live gate

Run all final verification commands in sequence. Update docs/index with what actually passed, test/fixture distinctions, local conversation custody/retention, the fact that the existing memory-only/portable kits do not yet back up chat sessions, limits and unknown paid-request behavior. Record a clearly labeled fixture transcript for the new conversation loop and real terminal captures only for real behaviors exercised.

Do not run `pnpm spike:inference` or any upload/payment command during this offline milestone. A later live gate must obtain inference access, check a current model's attestation/E2EE/tool/signature support, impose explicit usage limits and verify one small real conversation/tool round before enabling broader use. The current contract treasury does not purchase inference credits.

**Verify:** `pnpm check`, browser/contract gates, `git diff --check`, scope review and secret scan. Existing production-source commands still work; no funded-state artifact or key entered the diff. Mark plan 011 complete only for the offline core, and leave live inference/streaming acceptance explicitly open.

## Done criteria

- [x] Private scope-bound sessions reopen in a fresh process with valid message/tool ordering and stable IDs.
- [x] One session turn has bounded rounds/context/tools, persisted intent and no duplicate request after unknown outcomes.
- [x] Only the three read-only tools are advertised; owner/scoping checks remain outside the model.
- [x] Existing commands, question/review input, paste handling and terminal restoration keep working.
- [x] No configuration/opt-in means zero model requests and no fabricated answer.
- [x] Test-only injection demonstrates a conversation → read-only tool → reply → exit/reopen workflow, distinctly labeled synthetic.
- [x] All verification commands pass; docs and index accurately distinguish offline completion from unexecuted live acceptance. (`pnpm contract:check` exit 0 with Rust 1.96.0 and checksum-verified cargo-near 0.22.0.)
- [x] No contract deployment, owner transaction, 0G upload, credential export or paid inference was performed for this milestone.

## Stop conditions and maintenance

Stop and report the concrete issue if code excerpts/semantics drift, a new design requires touching funded state/keys or dropping evidence checks, a model can reach an economic/generic command path, corruption requires deleting state to continue, or paid outcome reconciliation would require inventing a replacement ID. A missing API key/credit is **not** a reason to stop the independent offline core. Never ask the operator to paste a key/seed into chat.

Keep source imports/validation and API compatibility pinned. Future streaming must preserve provisional/final evidence distinction; future mutating tools need reviewed capabilities backed by existing durable domain services; future daemon work must honor the same fences and session authority. Do not claim local transcript persistence equals encrypted 0G memory publication or off-device recovery.

Git convention observed: small descriptive commits on `main` (e.g. `Build interactive terminal application with persistent composer`), with the configured checkout fast-forwarded after a tested push. For implementation, inspect current working trees first and use an isolated feature branch if needed. This handoff authorizes no blanket publication/deployment; follow the current operator's instructions for commit/push/release actions.
