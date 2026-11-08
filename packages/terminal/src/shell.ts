import { randomUUID } from "node:crypto";
import { writePrivateFile } from "../../memory/src/files.js";
import { readRecoveryPublicFile } from "../../recovery/src/files.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { MemoryError } from "../../protocol/src/memory.js";
import type { TerminalClient, TerminalReview } from "./client.js";
import { missionListText, missionText, commissionText, parseNear, reviewText, statusText, terminalHelp, terminalJson, terminalText } from "./render.js";

export interface TerminalIO { print(text: string): void; ask(prompt: string): Promise<string | null> }
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
  if (error instanceof ProviderError || error instanceof MemoryError) return `${error.code}: ${error.message}${error.code === "AUTHORIZATION_FAILED" ? " Use /connect to verify the original owner again." : ""}`;
  return "The local command could not complete. Check its documented arguments and the retained operation state.";
}
export function reviewApproval(io: TerminalIO, options: { interactive: boolean; approveLogin: boolean; approveDigest?: string; acknowledgeCosts: boolean; json?: boolean }) {
  return async (review: TerminalReview) => {
    if (review.kind === "connect" && options.approveLogin) return true;
    if (!options.interactive) return review.kind !== "connect" && options.approveDigest === review.digest && (!review.costs || options.acknowledgeCosts);
    io.print(terminalText("\n" + reviewText(review)));
    const answer = await io.ask(`Type ${review.kind} to approve, or press Enter to cancel: `);
    return answer?.trim() === review.kind;
  };
}
export class TerminalShell {
  selected: string | null = null;
  constructor(readonly client: TerminalClient, private readonly io: TerminalIO, private readonly memory: TerminalMemory, private readonly json = false) {}
  private print(value: unknown) { this.io.print(this.json ? terminalJson(value) : terminalText(typeof value === "string" ? value : terminalJson(value), 100_000)); }
  private async connected() { if (!this.client.authenticated()) await this.client.connect(); }
  private mission(id?: string) { const selected = id ?? this.selected; if (!selected) throw new ProviderError("INVALID_INPUT", "Select a mission with /open or /new first"); return selected; }
  private async commissionId() { const detail = await this.client.detail(this.mission()); if (!detail.commission) throw new ProviderError("OPERATION_CONFLICT", "Select a specialist commission first"); return detail.commission.id; }
  async dispatch(argv: string[]): Promise<boolean> {
    const [raw = "help", ...args] = argv, named = raw.replace(/^\//, ""), command = named === "resume" ? "run" : named;
    if (["status", "info", "init", "help", "connect", "disconnect", "new", "missions", "activity", "reserve", "settle", "reconcile", "receipt", "memory-recover", "pause", "resume-agent", "exit", "quit"].includes(command) && args.length) throw new ProviderError("INVALID_INPUT", "Unexpected command arguments; use /help");
    if (["exit", "quit"].includes(command)) return false;
    if (["help", "-h", "--help"].includes(command)) { this.print(terminalHelp); return true; }
    if (command === "status" || command === "info" || command === "init") { const result = await this.client.status(); this.print(this.json ? result : statusText(result) + (command === "init" ? "\nExisting workspace checked. This command does not enroll a new agent. Use /connect next." : "")); return true; }
    if (command === "connect") { this.print(await this.client.connect()); return true; }
    if (command === "disconnect") { this.client.disconnect(); this.print("Owner disconnected. Saved work is retained."); return true; }
    if (!["missions", "new", "open", "run", "review", "cancel", "activity", "commission", "quote", "delivery", "reserve", "settle", "reconcile", "receipt", "export-request", "export-dossier", "memory", "memory-recover", "pause", "resume-agent", "owner-reconcile", "owner-cancel"].includes(command)) { this.print("Unknown terminal command. AI chat is not available yet. Use /help for the implemented workflow."); return true; }
    await this.connected();
    if (command === "missions") { const rows = await this.client.list(); this.print(this.json ? rows : missionListText(rows)); }
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
    else this.print("Unknown terminal command. AI chat is not available yet. Use /help for the implemented workflow.");
    return true;
  }
  async loop(signal: AbortSignal) {
    this.print("PERSISTARA / TERMINAL\nDurable missions, recoverable memory, bounded commerce.\nNo AI inference is used. Type /help for commands.");
    try { await this.dispatch(["status"]); } catch (error) { this.io.print(terminalText(errorText(error))); }
    while (!signal.aborted) {
      const line = await this.io.ask(this.selected ? `persistara [${this.selected.slice(-8)}]> ` : "persistara> "); if (line === null) break;
      try { const args = words(line); if (args.length && !await this.dispatch(args)) break; }
      catch (error) { this.io.print(terminalText(errorText(error))); }
    }
  }
}
