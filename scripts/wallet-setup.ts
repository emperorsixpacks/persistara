#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { walletSetup, type WalletSetupDeps } from "../packages/operator/src/wallet-setup.js";
import { loadEnvironment, printFailure } from "./common.js";

const run: WalletSetupDeps["run"] = (binary, args) => new Promise((resolve) => {
  const child = spawn(binary, args, { stdio: "inherit" }); child.on("error", () => resolve(127)); child.on("exit", (code) => resolve(code ?? 1));
});
const has: WalletSetupDeps["has"] = (binary) => new Promise((resolve) => {
  const child = spawn(binary, ["--version"], { stdio: "ignore" }); child.on("error", () => resolve(false)); child.on("exit", (code) => resolve(code === 0));
});
async function accountExists(owner: string) {
  const rpc = new URL(process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org");
  if (rpc.protocol !== "https:" || rpc.username || rpc.password) return false;
  try {
    const response = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "persistara", method: "query", params: { request_type: "view_account", finality: "final", account_id: owner } }) });
    const value = await response.json() as { result?: { amount?: unknown }; error?: unknown };
    return response.ok && !value.error && typeof value.result?.amount === "string";
  } catch { return false; }
}
async function main() {
  loadEnvironment();
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "setup")) { console.error("Use: persistara wallet [setup]"); process.exitCode = 2; return; }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const result = await walletSetup({ owner: process.env.NEAR_OWNER_ACCOUNT ?? "", binary: process.env.NEAR_CLI_BIN || "near", interactive, has, run, accountExists,
      ask: async (question) => rl ? await rl.question(question).catch(() => null) : null, say: (text) => console.log(text) });
    process.exitCode = result.status === "import-finished" ? 0 : 1;
  } finally { rl?.close(); }
}
main().catch(printFailure);
