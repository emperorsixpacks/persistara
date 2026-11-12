#!/usr/bin/env node
/** persistara wallet add|list|remove|check|near-cli. Keys are stored encrypted (see packages/owner/src/keystore.ts) and never printed. */
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, JsonRpcProvider } from "near-api-js";
import { walletAdd, walletCheck, walletList, walletRemove, type WalletCommandDeps } from "../packages/operator/src/wallet-commands.js";
import { readPrivateFile } from "../packages/memory/src/files.js";
import { keystoreDirectory } from "../packages/owner/src/keystore.js";
import { isObject } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { unlockKeystore } from "../packages/terminal/src/keystore-wallet.js";
import { readSecret } from "../packages/terminal/src/secret.js";
import { loadEnvironment, printUserFailure } from "./common.js";

const USAGE = `Usage: persistara wallet <command>
  add [--account NAME.testnet] [--key-file PATH | --from-near-credentials]
        Import an existing owner key into the encrypted key store. With no source flag it asks you to paste the key (hidden).
  list                      Show stored accounts and public keys
  remove NAME.testnet       Delete a stored key (asks you to confirm)
  check [--account NAME]    Prove your passphrase unlocks the stored key
  near-cli                  Use the official NEAR CLI keychain instead (guided)
Keys are encrypted with your passphrase in ${"~/.persistara-signer"} (override with PERSISTARA_SIGNER_DIR). A forgotten passphrase cannot be recovered; keep your own backup of the key.`;

function parse(argv: string[]) {
  const [command, ...rest] = argv; const options: { account?: string; keyFile?: string; fromNearCredentials: boolean; positional: string[] } = { fromNearCredentials: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--from-near-credentials") options.fromNearCredentials = true;
    else if (a === "--account" || a === "--key-file") { const v = rest[++i]; if (!v || v.startsWith("--")) throw new ProviderError("INVALID_INPUT", `${a} needs a value`); if (a === "--account") options.account = v; else options.keyFile = resolve(v); }
    else if (a.startsWith("--")) throw new ProviderError("INVALID_INPUT", `Unknown option ${a}`);
    else options.positional.push(a);
  }
  return { command, options };
}
async function readCredentials(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new ProviderError("INVALID_INPUT", "The NEAR credentials file is not a small regular file");
  const handle = await open(path, "r"); try { return await handle.readFile("utf8"); } finally { await handle.close(); }
}
async function main() {
  loadEnvironment();
  const { command, options } = parse(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") { console.log(USAGE); return; }
  const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org" });
  const deps: WalletCommandDeps = {
    directory: keystoreDirectory(), interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    config: { ...(process.env.NEAR_OWNER_ACCOUNT ? { account: process.env.NEAR_OWNER_ACCOUNT } : {}), ...(process.env.NEAR_AUTHORITY_CONTRACT ? { contract: process.env.NEAR_AUTHORITY_CONTRACT } : {}), ...(process.env.NEAR_AGENT_ID ? { agentId: process.env.NEAR_AGENT_ID } : {}) },
    say: (t) => console.log(t), warn: (t) => console.error(t), secret: (prompt) => readSecret(prompt),
    readKeyFile: (path, kind) => kind === "private" ? readPrivateFile(path, 4096).then((b) => Buffer.from(b).toString("utf8")) : readCredentials(path),
    credentialsPath: (account) => join(homedir(), ".near-credentials", "testnet", `${account}.json`),
    chain: {
      fullAccessKeys: async (account) => (await new Account(account, provider).getAccessKeyList()).keys.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key),
      ownerKeyOf: async (contract, agentId) => { const v = await provider.callFunction<Record<string, unknown>>({ contractId: contract, method: "get_agent", args: { agent_id: agentId }, blockQuery: { finality: "optimistic" } }); return isObject(v) && typeof v.ownerKey === "string" ? v.ownerKey : null; },
    },
    unlockCheck: (account, passphrase) => unlockKeystore(account, keystoreDirectory(), passphrase),
  };
  if (command === "add") await walletAdd(deps, { account: options.account, keyFile: options.keyFile, fromNearCredentials: options.fromNearCredentials });
  else if (command === "list") await walletList(deps);
  else if (command === "remove") await walletRemove(deps, options.positional[0] ?? options.account);
  else if (command === "check") await walletCheck(deps, options.account);
  else { console.error(USAGE); process.exitCode = 2; }
}
main().catch(printUserFailure);
