# Live inference acceptance runbook

**Status: not executed.** No real model request, attestation, E2EE exchange, signature check or tool call has been verified. The conversation core (plan 011) is tested offline with synthetic providers only. This runbook is the separate, spend-authorized gate that must pass before `PERSISTARA_AI_CHAT=enabled` is used for real work. It is for the owner/operator; an agent must not run the paid steps without explicit current authorization.

NEAR treasury funds and NEAR AI usage credits are different. The contract treasury does not buy inference credits, and Persistara's token caps are **not** a USD guarantee.

## Preconditions

1. `pnpm check` and `pnpm contract:check` pass on the commit being accepted.
2. An account and API key exist at `https://cloud.near.ai` with a **small** credit balance and any usage cap the provider offers. Decide the maximum you are willing to lose before step 3.
3. The key lives only in the ignored `.env` (or another protected local file), never in chat, a commit, a log or a screenshot. Check `git status` shows no secret file.
4. Existing live state (funded authority, journals, keys) is not touched by any step below.

## Steps

| # | Action | Cost | Pass criteria |
| --- | --- | --- | --- |
| 1 | `pnpm inference:models` | Free (catalog read) | Lists models. A catalog entry is **not** evidence of TEE support. Pick one candidate for `NEARAI_MODEL`. |
| 2 | Set `NEARAI_MODEL` in `.env`; leave `PERSISTARA_AI_CHAT` unset. Run `pnpm cli --plain`, send `hello`. | Free | AI-not-enabled message, no model request. Confirms the key alone does not enable spending. |
| 3 | `pnpm spike:inference` | **Paid, one request**, fictional specimen, 256-token cap | Exit 0 with `status: verified_inference_and_tool_call`: gateway + model attestation, TLS binding, E2EE and response signature verified, and the `report_ready` tool call returned. Report saved under `.persistara/spikes/`; `intent.json` records the request before dispatch. |
| 4 | Only if 3 passed: set `PERSISTARA_AI_CHAT=enabled`, connect the owner, send one message that needs a lookup (for example "what saved missions do I have?"). | **Paid, up to 2 requests** | One saved session, one `mission_list` lookup with an untrusted-data result, a final reply, a known-usage line. `/sessions` then a fresh process and `/session open 1` show the same history and IDs. |
| 5 | Record sanitized evidence in `docs/evidence/` (model, completion IDs, usage, elapsed, date). No key, prompt content you consider private, or raw attestation blobs. | Free | Evidence file committed; plan 011 and README updated to say what actually passed. |

Run each paid step once. Do not loop or script retries.

## Stop conditions

- Step 3 reports any unverified or failed evidence, an unsupported model, or no tool call: **stop**. Do not weaken the attestation/E2EE/signature checks, switch provider or model silently, or enable chat to get a greeting. Pick another model from the catalog and repeat from step 3 only after deciding to spend again.
- A step times out, is canceled or the process dies after dispatch: the attempt is **outcome unknown** and may have been billed. Check the provider dashboard for the actual charge. Do not resubmit to "see if it worked". In chat, the session is fenced; start `/session new`.
- Spend reaches your decided maximum, or a key appears anywhere outside protected files: stop and rotate the key.

## After acceptance

Passing this gate enables only the three read-only tools in the current milestone. Still open afterward: verified streaming, richer reviewed agent actions, per-request price validation, and a real-terminal capture. (Owner resolution of unknown attempts and encrypted chat-session backup exist offline; neither has been exercised against live inference.)
