# Persistara takeover guide

Prepared 2026-11-09 against code commit `4d2bbfd2aadb9e8c25db3f5fd0ea32b70dd2e972`. This is a repository handoff, not a fresh audit or a statement that the whole product is complete. No source code or live state was changed while preparing it.

## Update 2026-11-13 (newest; read before the 2026-11-12 section)

The owner approved a throwaway faucet account, and the previously untested live paths were run end to end on NEAR testnet: `near:deploy` (dry run and `--execute`), the `name.owner` contract (its on-chain hash equals the committed artifact `A2N6rTX3…`), `status`, `wallet add --from-near-credentials`, `wallet list/check`, wrong-passphrase refusal, and `near:deploy --owner-from-keystore`. Evidence: `docs/evidence/e2e-testnet-2026-11-13.md`. Three bugs it found are fixed with tests (resume balance guard, `policy: null` shape, unhelpful network error). The throwaway account's key stayed outside the repo; the owner's real account and live deployment were not touched. Still not run: interactive `/connect` in the full-screen app, and a paid chat turn.

Traps: pass `--project <dir>` to `persistara` to test against another deployment, because the default workspace's owner journal is bound to the live contract and rejects others (`INTEGRITY_FAILED: Owner operation journal is invalid or changed`). The public RPC `rpc.testnet.near.org` drops connections from some hosts; re-run resumable tools or pass `--rpc https://test.rpc.fastnear.com`. Testnet account names must end in `.testnet`.

## Update 2026-11-12 (read this first; the sections below describe the 2026-11-09 baseline)

34 commits since `4d2bbfd`, all on `main`, tested with `pnpm check` (**327 tests / 56 suites**) and `pnpm contract:check` (35 Rust tests + six sandbox scenarios, passed 2026-11-11). Nothing pushed as of this update except up to `575c953`; the push and making the repo public are the owner's decisions.

**Hackathon facts (from `HACKATHON.md`, recheck the live copy before submitting):** development and submission end **2026-11-14T23:59:00Z**. The repo must be public by then; the owner posts the demo on X; submission is one POST after the owner confirms the exact payload. Never push, make public, post, sign, deploy to mainnet or submit without the owner's explicit yes. Judging agents reproduce from a clean clone, so every claim must be reproducible without secrets: see the README's "Verify it yourself".

**Done since the baseline**
- Plan 011 offline core: durable conversation journal, bounded runner, three read-only tools, terminal routing; owner resolution of lost outcomes (`/session resolve`); encrypted session backup/restore (`pnpm conversations:*`); `pnpm conversation:demo` (synthetic, pinned by a test). Chat is **off by default** (`PERSISTARA_AI_CHAT=enabled` plus key and model).
- Live inference: one real non-streaming request passed full verification ([evidence](../docs/evidence/inference-spike-2026-11-11.json)); streaming failed its one attempt and stays off (`NEARAI_STREAM`). Chat in the real terminal against a live workspace has **not** been run.
- Contract: agents register as `name.owner` (35 Rust tests, sandbox passed); committed prebuilt artifact `contracts/artifacts/persistara_authority-name-owner.wasm` (hash `A2N6rTX3…`, manifest + test). **Not deployed.** The live testnet contract `authority.persistara-owner.testnet` is untouched and still uses `owner:name` IDs (code hash `GCPU1ej…`).
- Setup: `install.sh` (one-line install, workspace in `~/.persistara-workspace`), [GETTING-STARTED](../docs/GETTING-STARTED.md), [DEPLOY-TESTNET](../docs/DEPLOY-TESTNET.md) with `pnpm near:deploy` (resumable, dry run default, near-api-js; read paths checked against live testnet, **signing path never run on testnet**), `pnpm contract:fetch` (recover deployed WASM against a supplied hash), `pnpm near:runtime-key`.
- Owner custody: `persistara wallet add|list|remove|check` imports an existing key into an encrypted store (`~/.persistara-signer`, AES-256-GCM + scrypt); sign-in runs in a separate short-lived signer process, verified against the project's own NEP-413 verifier. `persistara wallet near-cli` keeps the NEAR CLI path. **Owner pause/resume still needs the NEAR CLI.** Not run with a real account in a real terminal; no independent review.
- TUI: footer shows why the NEAR check failed; `/copy` copies the last output (system tool, else OSC 52). Mouse highlight-to-copy is not implemented (terminal setting).

**Open, in priority order**
1. Owner decisions pending: push `main` and make the repo public; demo video + X post; the submission payload (name, lead, email, team size, tracks, a mainnet NEAR address, repo and post links). 25 commits carry a personal author email; rewriting history was not done.
2. Owner-run checks that need their key: `wallet add`, startup passphrase, `/connect`, then the paid acceptance steps in INFERENCE-ACCEPTANCE (step 4: chat in the real terminal), then optionally the testnet deployment.
3. Unbuilt: signing pause/resume with the key store, verified streaming, fresh-agent enrollment tooling beyond `near:deploy`, mainnet support, in-app mouse selection.

**Traps learned the hard way**
- **The client requires the local contract WASM's SHA-256 to equal the on-chain code hash, and builds are not reproducible.** Never run `pnpm contract:build`/`contract:check` in a workspace tied to a deployment (they overwrite the file); recover it with `pnpm contract:fetch --expected-hash <recorded hash>`. A run with the wrong file creates empty journals bound to the wrong hash ("Owner operation journal is invalid or changed"); remove them only if they hold no operations.
- An unintended pnpm 12 run once rewrote `packageManager`, the lockfile and `pnpm-workspace.yaml`, breaking clean installs. Check `git diff package.json pnpm-lock.yaml pnpm-workspace.yaml` after pnpm commands; the pinned version is 10.26.0.
- `HOME` is not passed to isolated workers (empty environment); give them absolute paths.
- Background-task "exit code 0" notices can be a wrapper's `echo`; read the log's real exit line.
- Pause/resume, uploads and payments are owner actions: never broadcast them without current authorization.

## Start here

Persistara is a new successor to Sofer: **NEAR authority/budgets/settlement + application-encrypted 0G storage + planned NEAR AI conversation/reasoning**. The CLI is the primary product. It now has a real Ink/React terminal application, but it is still a command-driven mission workspace. Typing `hello` currently produces the chat-unavailable message. Adding an API key or credits alone will not implement the missing conversation loop.

**Recommended next work: [011 — durable conversation/session core](011-conversation-engine.md).** Build and test that core with explicitly injected offline fixtures first. Do not wait for AI credits to implement it, and do not display fixture replies as real user-facing AI.

Read in order: this guide → [AGENTS](../AGENTS.md) → [product](../docs/PRODUCT.md) → [architecture](../docs/ARCHITECTURE.md) → [security](../docs/SECURITY.md) → plan 011. Read the domain guide before changing money, recovery or signing behavior.

## Repository and workspaces

| Item | Snapshot / instruction |
| --- | --- |
| Repository | <https://github.com/JemIIahh/persistara> |
| Branch / visibility | `main`; **private** at handoff |
| Canonical configured checkout | `/Users/ram/Desktop/persistara` |
| Earlier agent staging checkout | `/private/tmp/persistara`; temporary, not a runtime/recovery dependency |
| Separate original project | `/Users/ram/Desktop/sofer`; do not develop Persistara there or overwrite its unrelated work |
| Latest verified code | `4d2bbfd` (this documentation may be a later descendant) |
| Fully green baseline CI | <https://github.com/JemIIahh/persistara/actions/runs/42582132526> |

The previous coding environment started in the Sofer directory and allowed source writes there and in temporary directories. That did **not** make Sofer the target project. Check your own filesystem permissions; if staging is needed, keep one authoritative branch and sync a clean checkout by fast-forward. Never overwrite someone else's new changes. Work single-agent unless the operator authorizes delegation.

The user has delegated ordinary product/technical decisions and dislikes repeated permission questions. Continue authorized reversible development. This handoff push was explicitly requested. Publishing the private repository, exposing the owner host publicly, moving secrets, broadcasting owner transactions and submitting the hackathon entry are distinct actions; honor the current operator's authorization and existing review boundaries.

## Product decisions to preserve

- Keep Persistara separate from Sofer. Selective adaptations are recorded in `NOTICE` and `migration/provenance.json`; do not copy the old application wholesale.
- Keep the native terminal application as the primary surface. The user explicitly wanted the interaction quality of modern coding CLIs, not another colored readline header.
- Preserve its persistent composer, command picker, paging, keyboard editing, scoped status and real working/elapsed feedback. Use independent Persistara artwork and copper/neutral styling.
- The web console is a companion. The user disliked its appearance and deferred further web redesign until the important workflows work. Do not spend the next milestone redesigning it again.
- Keep AI access/credits deferred until available. No fake chat, silent provider fallback or paid test call merely to make a screenshot work.
- Prioritize one complete demonstrated workflow over claims about broad autonomy. NEAR finality, 0G ciphertext integrity, encryption authorization, source truth and inference verification are separate properties.

## Verified and unfinished state

| Area | Implemented / verified | Still open |
| --- | --- | --- |
| Terminal | Interactive TTY app; `--plain`; JSON/operator routes; real owner login, saved-mission reopening/paging, normal exit and Ctrl+C terminal restoration | Model chat, persistent conversation sessions, daemon lifecycle, Telegram |
| Source missions | Immutable briefs, private SQLite state, bounded approved-source collection, leases/fences, retained captures, interrupted resume, digest-bound local review | Model-driven planning/synthesis and integrated memory publication |
| NEAR | Public testnet authority; restricted runtime; budgets/escrow/callbacks; real settlement and over-budget/stale-CAS rejection | Live rotation acceptance, broader intervention UX, production review; no mainnet claim |
| 0G | Real Turbo encrypted uploads, proof/digest/decryption and fresh-process reads; bounded upload intents | Standard storage live acceptance, larger availability/performance measurements |
| Memory | Encrypted records/manifests, historical keys, sourced keyword recall, durable writes, backup/kit recovery | Larger live two-fact/revision drill, physical second-device restore, live rotation, embeddings |
| Specialist | Curated self-operated source worker; signed profile/quote/delivery files; JWE; real 0.01 NEAR payout once; delivery recovery | Automated transport, fuller dispute/refund/owner-recovery UI; signed-file exchange is current transport |
| Owner controls | Original-key NEP-413 auth; reviewed pause/resume; durable wallet handoff and exact receipt reconciliation; sandbox controls | Actual browser-provider approval, new-agent enrollment and rotation UI |
| Inference | Pinned NEAR AI SDK adapter, strict request/output/tool/evidence validation and paid spike command | Live model/TEE/tool-call acceptance; conversation loop and streaming adapter are not wired |
| Release | Private repo, CI, test suites, sanitized evidence and screenshots | Complete golden demo, five-trial cost/latency measurements, fresh-user packaging, public companion deployment/repo/video/submission |

Baseline checks passed: **230 TypeScript tests / 34 suites; 11 browser fixture tests; 34 Rust unit tests / six deployed-WASM sandbox scenarios**. These do not imply live browser-wallet approval, paid inference or physical off-device custody. The current CI run linked above passed both application and contract jobs.

## Setup and first-hour checks

For a fresh source checkout, authenticate to the private repository through the operator's normal GitHub workflow:

```sh
git clone https://github.com/JemIIahh/persistara.git
cd persistara
pnpm install --frozen-lockfile
pnpm check
pnpm web:build
```

Pinned tooling: pnpm **10.26.0**, project Node **24.22.2**, Rust **1.96.0**, cargo-near **0.22.0**. `pnpm` installs the declared Node runtime; `bin/persistara` prefers that local runtime. Keep global Node/shell configuration unchanged. Strict TypeScript uses NodeNext, exact optional properties and unchecked-index checks. JSX is `react-jsx`. New dependencies must be deliberate and pinned.

Additional gates:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
pnpm contract:check
```

`pnpm contract:check` needs the pinned Rust/cargo-near setup and sandbox binary; see [CONTRACTS](../docs/CONTRACTS.md). It does not submit public transactions. Local HTTP/browser/sandbox tests need loopback permission. First installation downloads toolchains/packages. No AI key/credits are needed for these checks. Do not run multiple TypeScript builds writing `dist/` concurrently.

On the existing configured machine:

```sh
cd /Users/ram/Desktop/persistara
./bin/persistara --help
./bin/persistara --json status
pnpm cli
```

In the app: `/connect` → type `connect` for an off-chain owner proof → `/missions` → `/open 1`. PgUp/PgDn reaches the full dossier/fingerprint. `/exit` closes normally. Ctrl+C stops owned work and exits 130. `./bin/persistara --plain` is the readline fallback. `pnpm cli` does not rebuild; use `pnpm cli:dev` after source edits. Global options precede the command.

Fresh clones lack `.env`, private state and the local WASM. Offline tests still work. Live startup requires deliberate configuration and `pnpm contract:build` if the checked artifact is absent. `persistara init` checks an **existing** workspace; it does not enroll a new agent. Do not generate replacement keys/journals to make an existing funded workspace open.

## Code map

| Path | Role / next-builder relevance |
| --- | --- |
| `scripts/cli.ts`, `bin/persistara` | CLI flags, runtime selection, TTY/plain routing, shutdown and fixed operator forwarding |
| `packages/terminal/src/application.tsx` | Ink view, keyboard/paste adapter, `runApplicationSession`; current text enters `TerminalShell.dispatch` |
| `packages/terminal/src/application-state.ts` | Bounded **ephemeral** transcript/draft/history, picker and question state; not durable chat storage |
| `packages/terminal/src/plain.ts` | EOF-safe readline adapter; preserve buffered-input handling |
| `packages/terminal/src/shell.ts` | Existing commands, nested questions and `reviewApproval`; unknown text currently has no chat route |
| `packages/terminal/src/client.ts`, `wallet.ts` | Owner/session/scope checks, exact reviews, external official NEAR CLI keychain; keep wallet keys external |
| `packages/operator/src/workspace.ts`, `memory.ts` | Shared CLI/console engine and read-only memory recall/rebuild wiring |
| `packages/inference/src/provider.ts`, `near-ai.ts`, `near-ai-worker.ts`, `evidence.ts` | Provider contract; isolated paid request; strict final evidence; currently `stream: false` |
| `packages/runtime/src/` | Canonical mission journal/service, leases and source worker; reuse for missions |
| `packages/commerce/src/` | Signed commission state, encryption, specialist execution and payout reconciliation |
| `packages/near/src/` | Restricted isolated signer, stable transaction identities and final-state checks |
| `packages/memory/src/`, `packages/recovery/src/` | Memory protocol/index/write journal, backups and portable kit |
| `packages/owner/src/` | Original-owner proof, loopback host, CSRF and wallet operation journal |
| `apps/console/` | Companion web client and explicit browser fixtures; server-module boundary guard |
| `contracts/authority/`, `contracts/integration-tests/` | Funded authority logic and actual-WASM acceptance scenarios |
| `tests/terminal-application.test.tsx`, `terminal.test.ts` | UI/key/paste/session boundaries and native controller tests |
| `tests/fixtures/commerce-support.ts`, `owner-support.ts` | Disposable fake transport/wallet helpers; never production fallback |

## Public deployment and preserved live work

These identifiers are public; re-read finalized state before treating any balance/epoch/grant as current:

| Item | Existing identifier |
| --- | --- |
| Network / authority | NEAR testnet / `authority.persistara-owner.testnet` |
| Owner / agent | `persistara-owner.testnet` / `persistara-owner.testnet:research` |
| Curated worker | `worker.persistara-owner.testnet` |
| 0G network | Galileo, chain ID `16602`, Turbo storage (`0g:16602:turbo`) |
| Dedicated uploader | `0x189109C53C71069850A7ABC19E8BFD11EFC679dE` |
| Authority code hash | `GCPU1ejMZ6CPDLyT4k9GorYuXtAv5sn49jXWVzDMsKYQ` |
| Accepted local WASM SHA-256 | `e1ca18486c58e92b46cb6920ef66a3517cd4a2132355e91dc6c6168f4e138375` (288,692 bytes) |

The local WASM is a checked non-reproducible build artifact, not a reproducible-build claim. Do **not** redeploy/replace the funded authority or invent a migration as part of chat/UI work. Some early paragraphs in domain docs describe historical pre-deployment gates; use their later dated acceptance sections, current code and evidence rather than treating the oldest paragraph as current status.

Last observed snapshot on 2026-11-09: checkpoint 1, key epoch 1, generation 3; treasury 0.08 NEAR available, zero reserved, 0.02 NEAR lifetime paid across distinct acceptance jobs. This is testnet state, not an AI-credit balance. Delegate expiry and gas allowance are finite; inspect `--json status` before live work.

Preserve these existing acceptance records:

- Source mission `mission:a5546463-9d6a-437d-967d-231a3d75c90e`: completed source dossier.
- Commission/mission `commission:58840546-9dc5-4305-8b21-8f50a00b5293` / `mission:58840546-9dc5-4305-8b21-8f50a00b5293`: paid 0.01 NEAR, payout attempt 1. Do not pay it again.
- Terminal interrupted/resumed mission `mission:18c0ae55-cfd7-458a-ab6b-c2b055410135`: completed; artifact digest `386988bd4829485dc37f047b2c21a1c7ed2c2a10b10b565d3ae00f4d5ab64cc8`.

See [NEAR/0G acceptance](../docs/evidence/near-0g-testnet-2026-11-07.json), [specialist acceptance](../docs/evidence/specialist-commission-2026-11-07.json), [native mission acceptance](../docs/evidence/native-terminal-2026-11-08.json), and [terminal application acceptance](../docs/evidence/terminal-application-2026-11-09.json). Live checks already proved these individual paths; do not rerun charged acceptance just to reproduce a status report.

## Private state and custody

The following are **locations/types only**, not secrets. None should be committed, pasted into a handoff, uploaded as diagnostic logs or sent to the model. Source control does not contain this state.

| Location | Purpose |
| --- | --- |
| `.env` | Local public configuration and optional provider credential; ignored |
| `.persistara/owner-console/wallet.sqlite` | Canonical owner-wallet handoffs; preserve pending/unknown rows |
| `.persistara/missions/research/missions.sqlite` | Mission briefs, retained captures, artifacts and events |
| `.persistara/commerce/research/commissions.sqlite` | Signed commission state and outcome fences |
| `.persistara/runtime/research/` | Canonical memory-write journal and rebuildable recall cache |
| Configured `NEAR_JOURNAL_FILE`, otherwise `.persistara/near/<scope>/authority.sqlite` | Stable restricted-signer journal; never replace to bypass an unknown operation |
| `.persistara/keys/near-runtime.key`, `0g-uploader.key` | Separate runtime and storage-upload credentials |
| `.persistara/keys/memory-keyring.json` | Historical memory encryption keys |
| `.persistara/recovery/research.bundle` + `.persistara/keys/research-recovery.secret` | Encrypted owner memory backup and separate secret |
| `.persistara/commerce/research/keys/recipient.key` | Buyer delivery-recipient key; **not** in the memory-only backup |
| `.persistara/specialist/keys/recipient.key` | Separate worker delivery-recipient key |
| `.persistara/recovery/kits/portable-v1/` | Existing encrypted portable kit/manifest/transfer instructions |
| `.persistara/keys/portable-v1.secret` | Separate portable-kit secret; keep outside its export directory |

Owner and worker wallet signing keys stay in the **external official NEAR CLI keychain / external wallet**. Do not locate/export/read their private keys through application tooling. The contract requires the original registration key; another full-access key on the same account is insufficient.

Preserve 0700 private directories and 0600 secret/journal files; reject symlinks as existing helpers do. Do not delete SQLite WAL/SHM files, force-clear dispatched markers, re-encrypt fixed intents or fabricate new IDs to escape unknown outcomes. Use the documented reconciliation path. Missing hashes/dropped transactions may remain unresolved indefinitely; no proof-based nonce replacement is implemented.

The portable kit has been verified only in a fresh process **on the same machine**. Real off-device custody is still false. It does not contain owner/worker wallets, runtime/uploader credentials or pending signer journals. Read [RECOVERY-KIT](../docs/RECOVERY-KIT.md) before transfer/restore. No need to open a secret to learn the architecture.

## AI dependency and next milestone

The provider adapter exists, but there is no durable conversation coordinator, session store, agent tool loop or UI chat route. Current `NearAiProvider.complete` requires `NEARAI_API_KEY`, a verified supported `NEARAI_MODEL`, and strict model-bound evidence. The worker sends a single non-streamed paid request and checks it before returning usable text/tools. Live inference/tool calling has **not** passed acceptance. The example model is not a promise of support.

Build plan 011 offline first. Later, configure credentials through protected local files/operator UI, set explicit usage limits, and run the documented small paid spike only when inference access and spending authorization exist. NEAR treasury funding and NEAR AI usage credits are separate. Do not weaken attestation/E2EE/signature checks to get a greeting, silently use a different provider, automatically retry an uncertain charged request or execute provisional streamed tool calls.

## Remaining order after the first chat/session milestone

1. Validate live model/tool/evidence support and add verified streaming/cost controls; connect richer agent actions through existing reviews.
2. Complete persistent sessions/background lifecycle and guided existing/fresh-agent setup. Fresh enrollment is not implemented today.
3. Complete live sourced revision recovery, live runtime/memory rotation, and a genuinely separate-device restore. Keyword recall already works; embeddings are later work.
4. Improve specialist transport and remaining dispute/refund controls; retain signed scope/expiry and exact-price/delivery review.
5. Observe real browser-provider approvals, finish enrollment/rotation UX, then revisit companion design and secure public hosting.
6. Run the full live golden demo and repeated cost/latency trials; finish fresh-user runbooks, public-release review, video and submission assets. Recheck the hackathon's current requirements before publication/submission; old calendar targets in docs are not authoritative current rules.

Telegram, multiple worker markets, stablecoins, cross-owner transfer, hosted multi-tenancy and mainnet/audited production custody are later expansion. Do not describe them as shipped. Do not turn the owner-local loopback server into a public multi-tenant service by changing a bind address.

## Known operational lessons

- `pnpm cli` intentionally starts compiled code; use `pnpm cli:dev` or `pnpm build` after edits. Do not change global Node merely to resolve a project runtime warning.
- Real Enter may arrive as empty input, CR or LF in Ink; multiline paste must remain a single data value. Regression tests cover both. Do not restore the old “reject all CR/LF” bug.
- Plain input can reach EOF during startup readiness. `createPlainTerminal` drains buffered lines after close without reopening readline; preserve that test.
- The shared local workspace retries only temporary `status`/`block`/`query` reads once at the same endpoint (8-second attempts, 200 ms backoff). It never retries uploads, signing or broadcasts. RPC outages still fail closed.
- CI's old cargo-near installer hit repeated GitHub download HTTP 504s. Current CI uses official release-API downloads, verifies the pinned archive digest, and bounds retries. Preserve tool versions/checksum; do not “fix” CI by changing contract behavior or skipping sandbox checks.
- Tests marked fixtures, sandbox and live evidence are different levels of evidence. Historical reports are not guarantees of current balances, uptime, model support or external backup custody.

## Handoff checklist for the next builder

Confirm branch/working tree and inspect any new changes since `4d2bbfd`; run the appropriate baseline gates; read plan 011 and its drift check; implement that bounded milestone without paid calls; keep the terminal and existing mission/payment/recovery paths working; update its status/evidence only after the stated checks pass. If a live resource is missing, continue independent offline engineering rather than inventing success or asking for keys in chat.

Suggested first instruction to the successor:

> Work in the Persistara repository, not Sofer. Read `plans/HANDOFF.md` and `plans/011-conversation-engine.md`, inspect drift from the recorded baseline, then build the offline durable conversation/session core. Preserve the terminal application and canonical mission/payment/recovery boundaries. Do not make paid inference calls or replace live keys/journals/contracts. Run the plan's gates and report completed offline behavior separately from remaining live acceptance.
