import { randomUUID } from "node:crypto";
import { writePrivateFile } from "../../memory/src/files.js";
import { readRecoveryPublicFile } from "../../recovery/src/files.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { MemoryError } from "../../protocol/src/memory.js";
import type { TerminalClient, TerminalReview } from "./client.js";
import { AI_DISABLED_MESSAGE, sessionListText, transcriptText, turnText, type TerminalConversation } from "./conversation.js";
import { missionListText, missionText, commissionText, parseNear, reviewText, statusText, homeText, terminalHelpFor, terminalJson, terminalText, type TerminalTone } from "./render.js";

export interface TerminalIO { print(text: string, tone?: TerminalTone): void; ask(prompt: string): Promise<string | null>; /** Optional real working-state label for interactive UIs. */ busy?(label: string): void }
export interface TerminalMemory { recall(query: string): Promise<unknown>; recover(): Promise<unknown> }
export function words(line: string): string[] {
  const result: string[] = []; let value = "", quote = "", started = false;
  for (const c of line) {
    if (quote) { if (c === quote) quote = ""; else value += c; started = true; }
    else if (c === "\"" || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { result.push(value); value = ""; started = false; } }
    else { value += c; started = true; }
  }
  if (quote) throw new ProviderError("INVALID_INPUT", "Close the quoted argument"); if (started) result.push(value); return result;
}
export async function inputJson(path: string) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readRecoveryPublicFile(path, 32_768))) as unknown; }
  catch { throw new ProviderError("INVALID_INPUT", "Choose a bounded regular UTF-8 JSON file"); }
}
export function errorText(error: unknown) {
  if (error instanceof ProviderError && error.code === "UPSTREAM_ERROR") return `Connection check failed: ${error.message}. Use /status to check again; reconcile any pending action before retrying it. [UPSTREAM_ERROR]`;
  if (error instanceof ProviderError || error instanceof MemoryError) return `${error.code}: ${error.message}${error.code === "AUTHORIZATION_FAILED" ? " Use /connect to verify the original owner again." : ""}`;
  return "The local command could not complete. Check its documented arguments and the retained operation state.";
}
export function reviewApproval(io: TerminalIO, options: { interactive: boolean; approveLogin: boolean; approveDigest?: string; acknowledgeCosts: boolean; json?: boolean }) {
  return async (review: TerminalReview) => {
    if (review.kind === "connect" && options.approveLogin) return true;
    if (!options.interactive) return review.kind !== "connect" && options.approveDigest === review.digest && (!review.costs || options.acknowledgeCosts);
    io.print(terminalText("\n" + reviewText(review)), "brand");
    for (;;) {
      const answer = await io.ask(`Type ${review.kind} to approve, details to inspect, or Enter to cancel: `);
      if (answer?.trim() === "details") { io.print(terminalText(reviewText(review, true))); continue; }
      return answer?.trim() === review.kind;
    }
  };
}
const NO_ARGS = new Set(["status", "info", "init", "connect", "disconnect", "missions", "new", "activity", "reserve", "settle", "reconcile", "receipt", "memory-recover", "pause", "resume-agent", "exit", "quit", "sessions"]);
const MISSION_REF = new Set(["open", "run", "resume", "review", "cancel"]);
const FREE_ARGS = new Set(["memory", "commission", "quote", "delivery", "export-request", "export-dossier", "owner-reconcile", "owner-cancel"]);
const HELP_TOPICS = new Set(["missions", "specialist", "memory", "controls", "all"]);
export type TerminalRoute = { kind: "command"; args: string[] } | { kind: "chat"; text: string };
export class TerminalShell {
  selected: string | null = null;
  /** Selected conversation session (private owner-runtime chat state, not a mission and not committed memory). */
  session: string | null = null;
  private missionRows: string[] = [];
  private sessionRows: string[] = [];
  constructor(readonly client: TerminalClient, private readonly io: TerminalIO, private readonly memory: TerminalMemory, private readonly json = false, private readonly conversation?: TerminalConversation) {}
  /**
   * Leading "/" is always an operator command (unknown ones are errors, never model requests). Bare words stay commands only when the
   * first word is a documented command and its arguments fit that command's grammar; everything else is ordinary conversation text.
   */
  route(line: string): TerminalRoute {
    const text = line.trim(); if (!text) return { kind: "command", args: [] };
    if (text.startsWith("/")) return { kind: "command", args: words(text) };
    let args: string[]; try { args = words(text); } catch { return { kind: "chat", text }; }
    const [first = "", ...rest] = args, only = rest[0] ?? "";
    if (NO_ARGS.has(first) && !rest.length) return { kind: "command", args };
    if (first === "help" && (!rest.length || (rest.length === 1 && HELP_TOPICS.has(only)))) return { kind: "command", args };
    if (MISSION_REF.has(first) && (!rest.length || (rest.length === 1 && /^(\d{1,3}|mission:[a-f0-9-]{36})$/.test(only)))) return { kind: "command", args };
    if (FREE_ARGS.has(first) && rest.length) return { kind: "command", args };
    return { kind: "chat", text };
  }
  /** Single entry point for both the interactive application and the plain loop. */
  async handle(line: string, signal?: AbortSignal): Promise<boolean> {
    const route = this.route(line);
    if (route.kind === "command") return route.args.length ? this.dispatch(route.args) : true;
    return this.chat(route.text, signal);
  }
  private chatReady() { return this.conversation?.readiness() ?? { enabled: false, message: AI_DISABLED_MESSAGE }; }
  private async chat(text: string, signal?: AbortSignal) {
    const ready = this.chatReady(); const port = this.conversation;
    if (!ready.enabled || !port) { this.io.print(terminalText(ready.message), "warning"); return true; }
    await this.connected(); await this.client.current();
    if (!this.session) { this.session = (await port.create()).id; this.io.print(`Started conversation session ${this.session.slice(-8)}. /sessions lists saved conversations.`, "muted"); }
    const result = await port.send(this.session, text, { ...(signal ? { signal } : {}), onPhase: (phase, detail) => this.io.busy?.(phase === "model" ? "Waiting for the model" : `Looking up ${terminalText(detail ?? "saved data", 40)}`) });
    for (const part of turnText(result)) this.io.print(terminalText(part.text, 100_000), part.tone);
    return true;
  }
  private sessionId(value: string | undefined) {
    if (!value) throw new ProviderError("INVALID_INPUT", "Use /session open <number or full ID>");
    if (/^\d{1,3}$/.test(value)) { const id = this.sessionRows[Number(value) - 1]; if (!id) throw new ProviderError("INVALID_INPUT", "Choose a row number from /sessions, or use the full session ID"); return id; }
    return value;
  }
  private async sessions(command: string, args: string[]) {
    const ready = this.chatReady(); const port = this.conversation;
    if (!ready.enabled || !port) { this.io.print(terminalText(ready.message), "warning"); return; }
    await this.connected(); await this.client.current();
    if (command === "sessions") { const rows = await port.list(); this.sessionRows = rows.map(row => row.id); this.print(this.json ? rows : sessionListText(rows, this.session)); return; }
    if (args[0] === "new" && args.length === 1) { this.session = (await port.create()).id; this.print(this.json ? { session: this.session } : `Started conversation session ${this.session.slice(-8)}. Type a message to begin.`); return; }
    if (args[0] === "open" && args.length === 2) { const detail = await port.open(this.sessionId(args[1])); this.session = detail.session.id; this.print(this.json ? detail : transcriptText(detail)); return; }
    throw new ProviderError("INVALID_INPUT", "Use /session new or /session open <number or full ID>");
  }
  private print(value: unknown) { this.io.print(this.json ? terminalJson(value) : terminalText(typeof value === "string" ? value : terminalJson(value), 100_000)); }
  private async connect() {
    this.io.print("Checking the registered owner on NEAR testnet…", "muted");
    const result = await this.client.connect();
    this.io.print(`Connected as ${result.owner}. Session lasts 10 minutes.`, "success");
  }
  private async connected() { if (!this.client.authenticated()) await this.connect(); }
  private mission(id?: string) {
    const selected = id ?? this.selected; if (!selected) throw new ProviderError("INVALID_INPUT", "Select a mission with /open or /new first");
    if (/^\d+$/.test(selected)) { const value = this.missionRows[Number(selected) - 1]; if (!value) throw new ProviderError("INVALID_INPUT", "Choose a row number from /missions, or use the full mission ID"); return value; }
    return selected;
  }
  private async commissionId() { const detail = await this.client.detail(this.mission()); if (!detail.commission) throw new ProviderError("OPERATION_CONFLICT", "Select a specialist commission first"); return detail.commission.id; }
  async dispatch(argv: string[]): Promise<boolean> {
    const [raw = "help", ...args] = argv, named = raw.replace(/^\//, ""), command = named === "resume" ? "run" : named;
    if (["status", "info", "init", "connect", "disconnect", "new", "missions", "activity", "reserve", "settle", "reconcile", "receipt", "memory-recover", "pause", "resume-agent", "exit", "quit", "sessions"].includes(command) && args.length) throw new ProviderError("INVALID_INPUT", "Unexpected command arguments; use /help");
    if (["exit", "quit"].includes(command)) return false;
    if (["help", "-h", "--help"].includes(command)) { if (args.length > 1) throw new ProviderError("INVALID_INPUT", "Use /help [missions|specialist|memory|controls|all]"); this.print(terminalHelpFor(args[0])); return true; }
    if (command === "status" || command === "info" || command === "init") { const result = await this.client.status(); this.print(this.json ? result : statusText(result) + (command === "init" ? "\nExisting workspace checked. This command does not enroll a new agent. Use /connect next." : "")); return true; }
    if (command === "connect") { await this.connect(); this.io.print("Next: /missions to browse saved work, or /new to start.", "muted"); return true; }
    if (command === "disconnect") { this.client.disconnect(); this.print("Owner disconnected. Saved work is retained."); return true; }
    if (command === "sessions" || command === "session") { await this.sessions(command, args); return true; }
    if (!["missions", "new", "open", "run", "review", "cancel", "activity", "commission", "quote", "delivery", "reserve", "settle", "reconcile", "receipt", "export-request", "export-dossier", "memory", "memory-recover", "pause", "resume-agent", "owner-reconcile", "owner-cancel"].includes(command)) { this.print("Unknown terminal command. Use /help for the available commands."); return true; }
    await this.connected();
    if (command === "missions") { const rows = await this.client.list(); this.missionRows = rows.map(row => row.id); this.print(this.json ? rows : missionListText(rows, true)); }
    else if (command === "new") {
      const title = await this.io.ask("Mission title: "); if (!title) return true;
      const objective = await this.io.ask("Objective: "); if (!objective) return true;
      const criteria = await this.io.ask("Review criteria: "); if (!criteria) return true;
      const sources = await this.io.ask("Approved source URLs (comma separated, maximum 6): "); if (!sources) return true;
      const result = await this.client.create({ requestId: randomUUID(), title, objective, criteria, sources: sources.split(",").map(s => s.trim()) }); this.selected = result.mission.id; this.print(this.json ? result : missionText(result));
    }
    else if (["open", "run", "review", "cancel"].includes(command)) {
      if (args.length > 1) throw new ProviderError("INVALID_INPUT", "Choose one mission ID");
      const id = this.mission(args[0]); this.selected = id;
      if (command === "run" && !this.json) this.print(`Running ${id}. Captures are saved. Ctrl+C stops this terminal and retains progress.`);
      if (command === "review" && !this.json) this.print(missionText(await this.client.detail(id)));
      const result = command === "run" ? await this.client.run(id) : command === "review" ? await this.client.review(id) : command === "cancel" ? await this.client.cancel(id) : await this.client.detail(id);
      this.print(this.json ? result : missionText(result));
    }
    else if (command === "activity") this.print(await this.client.activity());
    else if (command === "commission") {
      if (args.length < 1 || args.length > 2) throw new ProviderError("INVALID_INPUT", "Use /commission [mission-id] <maximum NEAR>");
      const id = this.mission(args.length === 2 ? args[0] : undefined), amount = parseNear(args.at(-1)!);
      this.selected = id; const value = await this.client.commission(id, amount); this.print(this.json ? value : commissionText(value));
      if (!this.json) this.print("Encrypted request prepared locally. Use /export-request, then import the specialist's signed quote. No upload or reservation occurred.");
    }
    else if (command === "quote" || command === "delivery") {
      if (args.length !== 1) throw new ProviderError("INVALID_INPUT", "Choose one signed JSON file"); const id = await this.commissionId(), value = await inputJson(args[0]!);
      const result = command === "quote" ? await this.client.importQuote(id, value) : await this.client.importDelivery(id, value);
      this.print(this.json ? result : commissionText(result));
      if (command === "delivery" && !this.json) this.print(missionText(await this.client.detail(this.mission())));
    }
    else if (["reserve", "settle", "reconcile", "receipt"].includes(command)) {
      const id = await this.commissionId();
      if (command === "settle" && !this.json) this.print(missionText(await this.client.detail(this.mission())));
      const result = command === "reserve" ? await this.client.reserve(id) : command === "settle" ? await this.client.settle(id) : command === "reconcile" ? await this.client.reconcile(id) : await this.client.commissionView(id);
      this.print(this.json ? result : commissionText(result));
    }
    else if (command === "export-request" || command === "export-dossier") {
      if (args.length !== 1) throw new ProviderError("INVALID_INPUT", "Choose one new private output file");
      const detail = command === "export-dossier" ? await this.client.detail(this.mission()) : null;
      const value = command === "export-request" ? await this.client.request(await this.commissionId()) : detail?.artifact ?? (detail?.commission?.artifact ? { digest: detail.commission.artifactDigest, value: detail.commission.artifact } : null);
      if (!value) throw new ProviderError("OPERATION_CONFLICT", "No local dossier is ready; open the verified delivery first");
      await writePrivateFile(args[0]!, Buffer.from(JSON.stringify(value, null, 2))); this.print({ status: "private_export_saved", file: args[0] });
    }
    else if (command === "memory") { if (!args.length) throw new ProviderError("INVALID_INPUT", "Use /memory <search terms>"); await this.client.current(); this.print(await this.memory.recall(args.join(" "))); }
    else if (command === "memory-recover") { await this.client.current(); this.print(await this.memory.recover()); }
    else if (command === "pause" || command === "resume-agent") this.print(await this.client.ownerChange(command === "pause"));
    else if (command === "owner-reconcile") { if (args.length < 1 || args.length > 2) throw new ProviderError("INVALID_INPUT", "Use /owner-reconcile <operation-id> [transaction-hash]"); this.print(await this.client.reconcileOwner(args[0]!, args[1])); }
    else if (command === "owner-cancel") { if (args.length !== 1) throw new ProviderError("INVALID_INPUT", "Use /owner-cancel <operation-id>"); this.print(await this.client.cancelOwner(args[0]!)); }
    else this.print("Unknown terminal command. Use /help for the available commands.");
    return true;
  }
  async loop(signal: AbortSignal) {
    this.io.print("\nPersistara  /  Research workspace", "brand");
    this.io.print("─".repeat(48), "muted");
    try { this.print(homeText(await this.client.status())); } catch (error) { this.io.print(terminalText(errorText(error)), "warning"); }
    this.io.print(`\n  Start with /connect, then /missions or /new.\n  /help shows the basics. Tab completes commands.\n  ${this.chatReady().enabled ? "Type a message to talk with your agent; /session new starts a fresh conversation." : "AI chat is not enabled; source missions need no credits."}\n`, "muted");
    while (!signal.aborted) {
      const line = await this.io.ask(this.selected ? `persistara [${this.selected.slice(-8)}]> ` : "persistara> "); if (line === null) break;
      try { if (!await this.handle(line, signal)) break; }
      catch (error) { this.io.print(terminalText(errorText(error)), "warning"); }
    }
  }
}
