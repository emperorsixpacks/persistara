#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalWorkspace } from "../packages/operator/src/workspace.js";
import { terminalMemory } from "../packages/operator/src/memory.js";
import { terminalConversation } from "../packages/operator/src/conversation.js";
import { TerminalClient } from "../packages/terminal/src/client.js";
import { NearCliWallet } from "../packages/terminal/src/wallet.js";
import { KeystoreWallet, unlockKeystore } from "../packages/terminal/src/keystore-wallet.js";
import { keystoreDirectory, readKeystoreEntry } from "../packages/owner/src/keystore.js";
import { readSecret } from "../packages/terminal/src/secret.js";
import { TerminalShell, errorText, inputJson, reviewApproval, type TerminalIO } from "../packages/terminal/src/shell.js";
import { terminalHelp, terminalHelpFor, terminalJson, terminalText, parseNear, statusText, missionText, missionListText, commissionText, commandExitCode } from "../packages/terminal/src/render.js";
import { createPlainTerminal } from "../packages/terminal/src/plain.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { assertRuntime } from "../packages/protocol/src/config.js";
import { loadEnvironment } from "./common.js";

interface Options { project: string; resume?: string; interactive: boolean; plain: boolean; json: boolean; approveLogin: boolean; approveDigest?: string; acknowledgeCosts: boolean; args: string[] }
function options(argv: string[]): Options {
  const result: Options = { project: fileURLToPath(new URL("../../", import.meta.url)), interactive: false, plain: false, json: false, approveLogin: false, acknowledgeCosts: false, args: [] }, seen = new Set<string>();
  let i = 0;
  for (; i < argv.length; i++) {
    const flag = argv[i]!; if (!flag.startsWith("--") || flag === "--help") break;
    if (seen.has(flag)) throw new ProviderError("INVALID_INPUT", "Duplicate terminal option"); seen.add(flag);
    if (flag === "--project" || flag === "--resume" || flag === "--approve-digest") {
      const value = argv[++i]; if (!value || value.startsWith("--")) throw new ProviderError("INVALID_INPUT", "Terminal option requires a value");
      if (flag === "--project") result.project = resolve(value); else if (flag === "--resume") result.resume = value; else if (/^[a-f0-9]{64}$/.test(value)) result.approveDigest = value; else throw new ProviderError("INVALID_INPUT", "Approval requires an exact SHA-256 review digest");
    } else if (flag === "--json") result.json = true;
    else if (flag === "--interactive") result.interactive = true;
    else if (flag === "--plain") result.plain = true;
    else if (flag === "--approve-login") result.approveLogin = true;
    else if (flag === "--acknowledge-costs") result.acknowledgeCosts = true;
    else throw new ProviderError("INVALID_INPUT", "Unknown terminal option; use --help");
  }
  result.args = argv.slice(i); return result;
}
const forwarded: Record<string, string> = { specialist: "specialist.js", recovery: "recovery-kit.js", doctor: "provider-doctor.js", wallet: "wallet.js" };
async function forward(args: string[], project: string, acknowledgeCosts: boolean) {
  const [command, action, ...rest] = args;
  let script = forwarded[command!], values = args.slice(1);
  if (command === "wallet" && action === "near-cli") { script = "wallet-setup.js"; values = []; }
  if (command === "memory") {
    if (["write", "resume", "reconcile", "cancel"].includes(action ?? "")) { script = "memory-write.js"; values = [action === "reconcile" ? "reconcile" : action!, ...rest]; }
    else { script = "memory.js"; values = args.slice(1); }
  }
  if (!script) return false;
  if (((command === "memory" && ["write", "resume"].includes(action ?? "")) || (command === "specialist" && ["fulfill", "deliver", "retry-payout"].includes(action ?? ""))) && !acknowledgeCosts) throw new ProviderError("INVALID_INPUT", "This operational command can spend testnet storage funds or gas. Put --acknowledge-costs before the command after reviewing its documented request");
  if (command === "doctor" && values.length === 0) values = ["--storage-only"];
  const exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...values], { cwd: project, stdio: "inherit" });
    const stop = () => { child.kill("SIGTERM"); }; process.once("SIGINT", stop); process.once("SIGTERM", stop);
    child.once("error", reject); child.once("exit", code => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); done(code ?? 1); });
  });
  process.exitCode = exitCode; return true;
}
async function oneShot(client: TerminalClient, args: string[], preview?: (text: string) => void) {
  const [command, action, id, ...rest] = args;
  if (["status", "info", "init"].includes(command ?? "")) { if (args.length !== 1) throw new ProviderError("INVALID_INPUT", "Unexpected status arguments"); return { ...await client.status(), ...(command === "init" ? { setup: "existing-workspace-check-only", enrollmentCreated: false } : {}) }; }
  if (!["missions", "activity", "mission", "commission", "owner"].includes(command ?? "")) throw new ProviderError("INVALID_INPUT", "Unknown command; use --help");
  await client.connect();
  if (command === "missions" && args.length === 1) return client.list();
  if (command === "activity" && args.length === 1) return client.activity();
  if (command === "mission") {
    if (action === "create" && id === "--file" && rest.length === 1) return client.create(await inputJson(rest[0]!));
    if (!id || rest.length) throw new ProviderError("INVALID_INPUT", "Use mission show|run|resume|review|cancel <id>, or create --file <brief.json>");
    if (action === "show") return client.detail(id);
    if (action === "run" || action === "resume") return client.run(id);
    if (action === "review") { preview?.(missionText(await client.detail(id))); return client.review(id); }
    if (action === "cancel") return client.cancel(id);
  }
  if (command === "commission") {
    if (!id) throw new ProviderError("INVALID_INPUT", "Choose a commission ID");
    if (action === "create" && rest.length === 1) return client.commission(id, parseNear(rest[0]!));
    if (["quote", "delivery"].includes(action ?? "") && rest[0] === "--file" && rest.length === 2) return action === "quote" ? client.importQuote(id, await inputJson(rest[1]!)) : client.importDelivery(id, await inputJson(rest[1]!));
    if (rest.length) throw new ProviderError("INVALID_INPUT", "Unexpected commission arguments");
    if (action === "show") return client.commissionView(id);
    if (action === "request") return client.request(id);
    if (action === "reserve") return client.reserve(id);
    if (action === "settle") { const c = await client.commissionView(id); preview?.(missionText(await client.detail(c.missionId))); return client.settle(id); }
    if (action === "reconcile") return client.reconcile(id);
  }
  if (command === "owner") {
    if (action === "prepare" && (id === "pause" || id === "resume") && !rest.length) return client.prepareOwner(id === "pause");
    if (action === "pause" && !id) return client.ownerChange(true);
    if (action === "resume" && !id) return client.ownerChange(false);
    if (action === "reconcile" && id && rest.length <= 1) return client.reconcileOwner(id, rest[0]);
    if (action === "cancel" && id && !rest.length) return client.cancelOwner(id);
  }
  throw new ProviderError("INVALID_INPUT", "Unknown command or arguments; use --help");
}
async function main() {
  assertRuntime(); const opts = options(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(opts.args[0] ?? "")) { if (opts.args.length > 2) throw new ProviderError("INVALID_INPUT", "Choose one help topic"); console.log(terminalHelpFor(opts.args[1])); return; }
  if (opts.args[0] === "chat") throw new ProviderError("NOT_CONFIGURED", "AI conversation is not enabled in this release; use the interactive mission workspace");
  process.chdir(opts.project);
  if (await forward(opts.args, opts.project, opts.acknowledgeCosts)) return;
  const interactive = opts.interactive || opts.args.length === 0;
  if (interactive && opts.json) throw new ProviderError("INVALID_INPUT", "Choose an interactive terminal or one JSON command");
  if (interactive && !process.stdin.isTTY && !opts.interactive) { console.log(terminalHelp); process.exitCode = 2; return; }
  loadEnvironment();
  const workspace = await createLocalWorkspace(), controller = new AbortController();
  // Owner key custody: a stored encrypted key (persistara wallet add) is unlocked once here, before the full-screen app owns the terminal.
  // It is only decrypted inside the isolated signer process. Without a stored key, or when not interactive, the external NEAR CLI keychain is used.
  const owner = workspace.config.signerId, nearCli = new NearCliWallet(process.env.NEAR_CLI_BIN || "near", undefined, controller.signal);
  const stored = await readKeystoreEntry(owner, keystoreDirectory()).catch(() => null);
  let passphrase: string | null = null;
  const canPrompt = Boolean(interactive && !opts.json && process.stdin.isTTY && process.stdout.isTTY);
  if (stored && canPrompt) {
    const typed = await readSecret(`Key store passphrase for ${owner} (Enter to skip): `);
    if (typed) { try { await unlockKeystore(owner, keystoreDirectory(), typed); passphrase = typed; } catch { process.stderr.write("That passphrase did not unlock the key store; continuing locked (owner sign-in will be unavailable).\n"); } }
  }
  const wallet = stored && canPrompt ? new KeystoreWallet(owner, keystoreDirectory(), () => passphrase, nearCli) : nearCli;
  let application: ReturnType<(typeof import("../packages/terminal/src/application.js"))["createTerminalApplication"]> | null = null;
  let plain: ReturnType<typeof createPlainTerminal> | null = null;
  let conversations: { close(): void } | null = null;
  const stop = () => { controller.abort(); application?.closeInput(); plain?.rl.close(); void workspace.missions.close(); process.exitCode = 130; };
  const useApplication = interactive && !opts.plain && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb" && process.env.INK_SCREEN_READER !== "true";
  if (useApplication) application = (await import("../packages/terminal/src/application.js")).createTerminalApplication({ agentId: workspace.config.agentId, project: opts.project, interrupt: stop });
  else plain = createPlainTerminal();
  const io = application?.io ?? plain!.io;
  // Machine-readable stdout contains one result; reviews/errors go to stderr.
  const reviewIO: TerminalIO = { ...io, print: (text, tone) => { if (opts.json) process.stderr.write(terminalText(text) + "\n"); else io.print(text, tone); } };
  const client = new TerminalClient(workspace, wallet, reviewApproval(reviewIO, { interactive: interactive || Boolean(process.stdin.isTTY && !opts.json), approveLogin: opts.approveLogin, acknowledgeCosts: opts.acknowledgeCosts, ...(opts.approveDigest ? { approveDigest: opts.approveDigest } : {}) }));
  process.once("SIGINT", stop); process.once("SIGTERM", stop); plain?.rl.once("SIGINT", stop);
  try {
    if (interactive) { const memory = terminalMemory(workspace), conversation = terminalConversation(workspace, client, memory); conversations = conversation; const shell = new TerminalShell(client, io, memory, false, conversation); shell.selected = opts.resume ?? null; if (application) await application.run(client, shell, controller.signal); else await shell.loop(controller.signal); }
    else {
      const result = await oneShot(client, opts.args, opts.json ? undefined : text => io.print(text));
      if (opts.json) process.stdout.write(terminalJson(result) + "\n");
      else if (["status", "info", "init"].includes(opts.args[0] ?? "")) io.print(statusText(result as Awaited<ReturnType<TerminalClient["status"]>>) + (opts.args[0] === "init" ? "\nExisting setup checked; no new agent was enrolled. Use /connect next." : ""));
      else if (opts.args[0] === "missions") io.print(missionListText(result as Awaited<ReturnType<TerminalClient["list"]>>));
      else if (opts.args[0] === "mission") io.print(missionText(result as Awaited<ReturnType<TerminalClient["detail"]>>));
      else if (opts.args[0] === "commission" && opts.args[1] !== "request") io.print(commissionText(result as Awaited<ReturnType<TerminalClient["commissionView"]>>));
      else io.print(terminalJson(result));
      if (!controller.signal.aborted) process.exitCode = commandExitCode(opts.args, result);
    }
  } finally { conversations?.close(); plain?.rl.close(); try { await client.close(); } finally { await application?.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); } }
}
main().catch(error => { console.error(terminalText(errorText(error))); if (process.exitCode !== 130) process.exitCode = error instanceof ProviderError && error.code === "NOT_CONFIGURED" ? 2 : 1; });
