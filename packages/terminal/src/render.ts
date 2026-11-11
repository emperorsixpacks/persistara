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
export type TerminalTone = "brand" | "muted" | "success" | "warning";
/** Only application-owned escapes are introduced, after untrusted content is escaped. */
export function terminalOutput(text: string, tone?: TerminalTone, color = false) {
  const safe = terminalText(text, 100_000);
  const codes = { brand: "1;38;2;236;169;130", muted: "90", success: "38;2;143;188;174", warning: "33" };
  return color && tone ? `\x1b[${codes[tone]}m${safe}\x1b[0m` : safe;
}
export function terminalColor(isTTY: boolean, env: Record<string, string | undefined>) { return isTTY && env.NO_COLOR === undefined && env.TERM !== "dumb"; }
export const terminalCommands = ["connect", "status", "missions", "new", "open", "run", "resume", "review", "cancel", "activity", "commission", "quote", "delivery", "reserve", "settle", "reconcile", "receipt", "export-request", "export-dossier", "memory", "memory-recover", "pause", "resume-agent", "owner-reconcile", "owner-cancel", "disconnect", "help", "exit"];
export function completeCommand(line: string): [string[], string] {
  if (!/^\/?[a-z-]*$/.test(line)) return [[], line];
  const prefix = line.startsWith("/") ? "/" : "", matches = terminalCommands.map(c => prefix + c).filter(c => c.startsWith(line));
  return [matches, line];
}
export function nearAmount(value: string) {
  const n = BigInt(value), unit = 10n ** 24n, fraction = (n % unit).toString().padStart(24, "0").replace(/0+$/, "");
  return `${n / unit}${fraction ? "." + fraction : ""} NEAR`;
}
export function parseNear(value: string) {
  if (!/^(0|[1-9]\d{0,12})(?:\.\d{1,24})?$/.test(value)) throw new ProviderError("INVALID_INPUT", "Enter a positive NEAR amount with at most 24 fractional digits");
  const [whole, fraction = ""] = value.split("."); const amount = BigInt(whole!) * 10n ** 24n + BigInt(fraction.padEnd(24, "0"));
  if (amount <= 0n) throw new ProviderError("INVALID_INPUT", "Enter a positive NEAR amount"); return amount.toString();
}
/**
 * Human-facing agent name in NEAR subaccount style. Contracts built from this source register `name.owner.testnet` directly and
 * those IDs are shown unchanged. A legacy registry ID `owner.testnet:research` (the format of the existing testnet deployment)
 * is shown as `research.owner.testnet`. Display only: nothing is created, resolved or authorized from the shown text, and the
 * registry ID stays canonical for the contract, journals and scope checks.
 */
export function agentDisplayName(agentId: string) {
  const split = agentId.indexOf(":");
  const owner = agentId.slice(0, split), name = agentId.slice(split + 1);
  return split > 0 && name && !name.includes(":") ? `${name}.${owner}` : agentId;
}
export function statusText(result: Awaited<ReturnType<TerminalClient["status"]>>) {
  const v = result.view;
  return [`${agentDisplayName(v.agentId)}  |  NEAR testnet  |  ${v.paused ? "PAUSED" : "ACTIVE"}`,
    `Owner ${v.owner}  |  ${result.authenticated ? "connected" : "use /connect"}`,
    `Treasury ${nearAmount(v.balances.available)} available  |  ${nearAmount(v.balances.reserved)} reserved`,
    `Memory checkpoint ${v.checkpointVersion} / epoch ${v.keyEpoch}  |  local backup ${v.backup.status}`,
    `Restricted runtime ${v.runtimeKeys.some(key => key.ready) ? "ready" : "needs attention"}  |  local rotation hold ${v.localRotationHold === null ? "unknown" : v.localRotationHold ? "active" : "clear"}`,
    "AI conversation: off unless the operator enables it (see docs/TERMINAL.md). Source missions use no inference.",
    ...(result.pendingOwner ? [`Owner request ${result.pendingOwner.request.id}: ${result.pendingOwner.state} — reconcile before another handoff.`] : [])].join("\n");
}
export function homeText(result: Awaited<ReturnType<TerminalClient["status"]>>) {
  const v = result.view;
  return [`  Workspace   ${agentDisplayName(v.agentId)}`,
    `  NEAR        Testnet · ${v.paused ? "paused" : "active"} · ${nearAmount(v.balances.available)} available`,
    `  Owner       ${result.authenticated ? "Connected" : "Not connected"}`,
    `  Memory      Checkpoint ${v.checkpointVersion} · local backup ${v.backup.status}`,
    `  Runtime     ${v.runtimeKeys.some(key => key.ready) ? "Ready" : "Needs attention"} · rotation ${v.localRotationHold === null ? "unknown" : v.localRotationHold ? "on hold" : "clear"}`,
    ...(result.pendingOwner ? [`  Pending     ${result.pendingOwner.request.id} · ${result.pendingOwner.state}`] : [])].join("\n");
}
function stateText(value: string) { return ({ awaiting_review: "Needs review", queued: "Ready", running: "Collecting sources" } as Record<string, string>)[value] ?? value.replaceAll("_", " "); }
export function missionListText(missions: Mission[], numbered = false) {
  if (!missions.length) return "No missions yet. Use /new to save your first brief.";
  if (numbered) return ["Saved missions", ...missions.map((m, i) => `\n  ${i + 1}. ${m.brief.title}\n     ${stateText(m.commission?.state ?? m.state)} · ${m.capturedCount}/${m.sourceCount} sources · ${nearAmount(m.budget.spent)} spent`), "\nUse /open <number> to inspect a mission, then /run or /review."].join("\n");
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
export function reviewText(review: TerminalReview, full = false) {
  if (review.kind === "connect" && !full) return [review.title, `  Account    ${review.details.account}`, `  Network    ${review.details.network ?? "NEAR testnet"}`, ...(review.details.agent ? [`  Agent      ${review.details.agent}`] : []), ...(review.details.contract ? [`  Contract   ${review.details.contract}`] : []), `  Owner key  ${review.details.publicKey}`, `\n${review.details.effect}`, "The official NEAR CLI signs through its external keychain."].join("\n");
  return [review.title, ...Object.entries(review.details).map(([key, value]) => `${key}: ${value}`), `Review digest: ${review.digest}`, ...(review.costs ? ["This action may spend testnet funds or gas."] : [])].join("\n");
}
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
const allHelp = `Persistara — owner-controlled agents on NEAR, encrypted memory on 0G

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
  --plain (readline instead of the terminal application),
  --approve-login (off-chain only), --approve-digest <exact-review-digest>,
  --acknowledge-costs. Noninteractive actions refuse implicit financial approval.
Memory write/resume and specialist fulfill/deliver/retry-payout forwarding require
--acknowledge-costs; use their documented canonical requests and journals.

No AI chat, model synthesis, conversational sessions, enrollment wizard, daemon or
Telegram bridge is claimed yet. Ordinary text never receives a fake model answer.`;
const helpTopics: Record<string, string> = {
  missions: `Missions\n  /missions           List saved work; /open <number> selects a row\n  /new                Save a brief and approved source URLs\n  /run [id|number]    Collect remaining sources; Ctrl+C retains progress\n  /review             Inspect and approve the exact local dossier\n  /cancel             Cancel local collection before review\n  /activity           View durable events\n  /export-dossier <file>  Save a new private artifact file\n\nSource collection uses no AI, upload or payment.\nFor shell scripts and exact IDs: ./bin/persistara --help all`,
  specialist: `Specialist work\n  /commission [id|number] <NEAR>  Prepare an encrypted request\n  /export-request <file>         Save a new private request file\n  /quote <file>                  Import a signed specialist quote\n  /reserve                       Review price before upload/reservation\n  /delivery <file>               Verify and inspect the delivery\n  /settle                        Review artifact and price before payment\n  /reconcile                     Observe the existing operation\n  /receipt                       Inspect its fingerprints and receipts\n\nFunds or gas require explicit review. Pending does not mean paid.\nUse /help all for the separate worker's operational commands.`,
  memory: `Memory and recovery\n  /memory <query>      Recall committed records with sources\n  /memory-recover      Rebuild the cache from the existing owner backup\n\nPortable kit: ./bin/persistara recovery verify|recover ...\nUse /help all and docs/TERMINAL.md for full file-based commands.\nLocal backup verification does not prove off-device custody.`,
  controls: `Owner controls\n  /status                   Check finalized authority and readiness\n  /connect                  Sign in with the original owner\n  /disconnect               End the in-memory session\n  /pause  /resume-agent      Review a transaction; testnet gas applies\n  /owner-reconcile <id> [hash]  Check an existing wallet handoff\n  /owner-cancel <id>         Cancel before wallet handoff\n\nAn unknown wallet result must be reconciled, never sent again.`,
};
export const terminalHelp = `Getting started\n  /connect     Sign in with the registered owner wallet\n  /missions    Browse saved work\n  /new         Create a source mission\n  /status      Check connections, memory and budget\n\nExplore\n  /help missions     /help specialist\n  /help memory       /help controls\n  /help all          Full command reference\n\n/ opens commands. Tab completes. /exit closes the workspace.\nUse --plain for readline. No AI chat yet; source work needs no credits.`;
export function terminalHelpFor(topic?: string) {
  if (!topic) return terminalHelp;
  if (topic === "all") return allHelp;
  if (!Object.hasOwn(helpTopics, topic)) return "Choose /help missions, specialist, memory, controls or all.";
  return helpTopics[topic]!;
}
