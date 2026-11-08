import type { Mission, MissionDetail } from "../../runtime/src/types.js";
import type { TerminalClient, TerminalReview } from "./client.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { isObject } from "../../protocol/src/memory.js";
import type { CommissionView } from "../../commerce/src/types.js";
import { commissionReviews } from "./client.js";

/** Remote excerpts, filenames and briefs must never execute terminal escape/OSC/bidi sequences. */
export function terminalText(value: unknown, maximum = 12_000): string {
  const full = String(value), text = full.slice(0, maximum);
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + (full.length > maximum ? "\n[display truncated]" : "");
}
export function terminalJson(value: unknown) { return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`); }
export function nearAmount(value: string) {
  const n = BigInt(value), unit = 10n ** 24n, fraction = (n % unit).toString().padStart(24, "0").replace(/0+$/, "");
  return `${n / unit}${fraction ? "." + fraction : ""} NEAR`;
}
export function parseNear(value: string) {
  if (!/^(0|[1-9]\d{0,12})(?:\.\d{1,24})?$/.test(value)) throw new ProviderError("INVALID_INPUT", "Enter a positive NEAR amount with at most 24 fractional digits");
  const [whole, fraction = ""] = value.split("."); const amount = BigInt(whole!) * 10n ** 24n + BigInt(fraction.padEnd(24, "0"));
  if (amount <= 0n) throw new ProviderError("INVALID_INPUT", "Enter a positive NEAR amount"); return amount.toString();
}
export function statusText(result: Awaited<ReturnType<TerminalClient["status"]>>) {
  const v = result.view;
  return ["PERSISTARA / TERMINAL", `${v.agentId}  |  NEAR testnet  |  ${v.paused ? "PAUSED" : "ACTIVE"}`,
    `Owner ${v.owner}  |  ${result.authenticated ? "connected" : "use /connect"}`,
    `Treasury ${nearAmount(v.balances.available)} available  |  ${nearAmount(v.balances.reserved)} reserved`,
    `Memory checkpoint ${v.checkpointVersion} / epoch ${v.keyEpoch}  |  local backup ${v.backup.status}`,
    `Restricted runtime ${v.runtimeKeys.some(key => key.ready) ? "ready" : "needs attention"}  |  local rotation hold ${v.localRotationHold === null ? "unknown" : v.localRotationHold ? "active" : "clear"}`,
    "AI conversation: unavailable in this release. Source missions use no inference.",
    ...(result.pendingOwner ? [`Owner request ${result.pendingOwner.request.id}: ${result.pendingOwner.state} — reconcile before another handoff.`] : [])].join("\n");
}
export function missionListText(missions: Mission[]) {
  if (!missions.length) return "No missions yet. Use /new to save your first brief.";
  return missions.map(m => `${m.id}\n  ${m.commission?.state ?? m.state}  ${m.capturedCount}/${m.sourceCount} sources  ${nearAmount(m.budget.spent)} spent\n  ${m.brief.title}`).join("\n\n");
}
export function missionText(d: MissionDetail) {
  const m = d.mission, artifact = d.artifact ?? (d.commission?.artifact ? { digest: d.commission.artifactDigest!, value: d.commission.artifact } : null);
  return [m.id, `${m.commission?.state ?? m.state}  |  ${m.capturedCount}/${m.sourceCount} sources  |  ${nearAmount(m.budget.spent)} spent`,
    m.brief.title, `Objective: ${m.brief.objective}`, `Review criteria: ${m.brief.criteria}`,
    ...(d.commission ? [`Specialist ${d.commission.worker} / ${nearAmount(d.commission.amountYoctoNear)} / ${d.commission.state}`, `Delivery verified: ${d.commission.deliveryVerified}; owner reviewed: ${d.commission.reviewed}; payout attempt: ${d.commission.receipt.payoutAttempt ?? "pending"}`] : []),
    ...(artifact ? [`Artifact SHA-256: ${artifact.digest}`, ...artifact.value.sources.flatMap(s => [`\n[UNTRUSTED SOURCE] ${s.title}`, s.url, `Captured ${new Date(s.capturedAt).toISOString()} / ${s.byteLength} bytes / ${s.contentSha256}`, s.excerpt.slice(0, 3000)])] : d.sources.map(s => `${s.ordinal + 1}. ${s.state} — ${s.url}`)),
    "\nCollection/signatures do not establish source truth. Inspect the dossier before review."].join("\n");
}
export function reviewText(review: TerminalReview) { return [review.title, ...Object.entries(review.details).map(([key, value]) => `${key}: ${value}`), `Review digest: ${review.digest}`, ...(review.costs ? ["This action may spend testnet funds or gas."] : [])].join("\n"); }
export function commissionText(c: CommissionView) {
  const reviews = commissionReviews(c);
  return [c.id, `${c.state}  |  ${c.worker}  |  ${nearAmount(c.amountYoctoNear)}`,
    `Quote signature ${c.signatureVerified ? "verified" : "pending"} / encrypted delivery ${c.deliveryVerified ? "verified" : "pending"} / owner review ${c.reviewed ? "recorded" : "pending"}`,
    `Payout attempt ${c.receipt.payoutAttempt ?? "pending"}; ${c.state === "paid" ? "finalized paid" : "payment not finalized"}`,
    `Quote SHA-256: ${c.quoteDigest ?? "pending"}`, `Artifact SHA-256: ${c.artifactDigest ?? "pending"}`,
    `Reservation transaction: ${c.receipt.reservationHash ?? "pending"}`, `Acceptance transaction: ${c.receipt.acceptanceHash ?? "pending"}`,
    ...(reviews.reservation ? [`Reservation review digest: ${reviews.reservation}`] : []), ...(reviews.settlement ? [`Settlement review digest: ${reviews.settlement}`] : []),
    ...(c.failureCode ? [`Recorded failure: ${c.failureCode}. Reconcile this same operation.`] : [])].join("\n");
}
/** Exit 3 means observe the existing effect; it never means retry with a replacement ID. */
export function commandExitCode(args: readonly string[], result: unknown): number {
  if (!isObject(result)) return 0;
  const [command, action] = args;
  if (command === "mission" && ["run", "resume"].includes(action ?? "") && isObject(result.mission)) return result.mission.state === "blocked" ? 1 : result.mission.state === "interrupted" ? 3 : 0;
  if ((command === "owner" && ["pause", "resume", "reconcile"].includes(action ?? "")) || (command === "commission" && ["reserve", "settle", "reconcile"].includes(action ?? ""))) {
    if (["dispatched", "unknown", "uploading_brief", "reserving", "settling", "payout_pending"].includes(String(result.state))) return 3;
    if (["failed", "payout_failed", "disputed", "refunded", "canceled"].includes(String(result.state))) return 1;
    if (command === "commission" && action === "settle" && result.state !== "paid") return result.failureCode ? 1 : 3;
  }
  return 0;
}
export const terminalHelp = `Persistara — owner-controlled agents on NEAR, encrypted memory on 0G

Interactive commands (leading / is optional):
  /connect                 verify the original owner through the external NEAR CLI keychain
  /status                  finalized authority, budget and local backup readiness
  /missions                list saved missions
  /new                     create a bounded source mission
  /open <mission-id>        inspect/select a saved mission
  /run [mission-id]         run or resume remaining sources; Ctrl+C retains progress
  /review [mission-id]      inspect and record exact local-dossier review
  /cancel [mission-id]      cancel local source work before review
  /activity                durable event history
  /commission [id] <NEAR>   prepare an encrypted request for a source specialist
  /quote <file>             import a signed quote for the selected commission
  /delivery <file>          verify an encrypted specialist delivery
  /reserve                 review exact quote/costs before reservation
  /settle                  review exact artifact/price before acceptance
  /reconcile               observe the existing commission; no replacement effects
  /receipt                 inspect quote/artifact fingerprints and transaction receipts
  /export-request <file>    save the encrypted specialist request (exclusive/private)
  /export-dossier <file>    save the selected authenticated dossier (exclusive/private)
  /memory <query>           recall committed sourced memory from the private cache
  /memory-recover          rebuild the cache using the existing owner memory backup
  /pause  /resume-agent     review a zero-deposit owner action; gas still costs NEAR
  /owner-reconcile <id> <hash>  reconcile a retained wallet handoff
  /owner-cancel <id>        cancel an owner request before wallet handoff
  /disconnect  /help  /exit

Other entry points:
  persistara init           check the existing local setup; no new account is created
  persistara status        public finalized status
  persistara missions      owner-authenticated list
  persistara mission show|run|review|cancel <id>
  persistara mission create --file <brief.json>  (include a stable requestId)
  persistara commission show|request|reserve|settle|reconcile <commission-id>
  persistara commission quote|delivery <commission-id> --file <signed.json>
  persistara owner prepare pause|resume  (then approve its exact digest)
  persistara owner pause|resume|reconcile|cancel ...
  persistara recovery prepare|verify|recover ...  (portable recovery-kit CLI)
  persistara specialist init|quote|fulfill|deliver|reconcile|retry-payout ...
  persistara memory keys|backup|verify-backup|recover|recall ...
  persistara memory write|resume|reconcile|cancel ...
  persistara doctor         storage-only provider diagnostics (no inference)

Put global options before the command: --project <directory>, --resume <mission-id>, --json,
  --approve-login (off-chain only), --approve-digest <exact-review-digest>,
  --acknowledge-costs. Noninteractive actions refuse implicit financial approval.
Memory write/resume and specialist fulfill/deliver/retry-payout forwarding require
--acknowledge-costs; use their documented canonical requests and journals.

No AI chat, model synthesis, conversational sessions, enrollment wizard, daemon or
Telegram bridge is claimed yet. Ordinary text never receives a fake model answer.`;
