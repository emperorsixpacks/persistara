#!/usr/bin/env node
/**
 * Owner-run, one-shot testnet deployment (see docs/DEPLOY-TESTNET.md). Reads the OWNER key only from a private key file you
 * name, signs with near-api-js inside this short-lived process (never the chat or agent process), and never stores or prints it.
 * Without --execute it only reads chain state and prints what it would do.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions } from "near-api-js";
import { readPrivateFile, writePrivateFile } from "../packages/memory/src/files.js";
import { deployTestnet, type AgentSnapshot, type DeployChain } from "../packages/near/src/deploy.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { isObject } from "../packages/protocol/src/memory.js";
import { loadEnvironment, printFailure } from "./common.js";

const KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const FLAGS = new Set(["--owner", "--owner-key-file", "--contract", "--agent-name", "--worker", "--wasm", "--expected-hash", "--contract-key-file", "--runtime-key-file", "--rpc"]);
const GAS = 100n * 10n ** 12n;

function parse(argv: string[]) {
  const values = new Map<string, string>(); let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    if (name === "--execute") { execute = true; continue; }
    const value = argv[++i];
    if (!FLAGS.has(name) || !value || value.startsWith("--") || values.has(name)) throw new ProviderError("INVALID_INPUT", `Invalid or duplicate argument ${name}. See docs/DEPLOY-TESTNET.md`);
    values.set(name, value);
  }
  return { values, execute };
}
async function loadKey(path: string, what: string) {
  const text = Buffer.from(await readPrivateFile(path, 512)).toString("utf8").trim();
  if (!KEY.test(text)) throw new ProviderError("INVALID_INPUT", `${what} file is not a valid ed25519 key`);
  return KeyPair.fromString(text as Parameters<typeof KeyPair.fromString>[0]);
}
const missing = (error: unknown) => isObject(error) && error.code === "ENOENT";

async function main() {
  loadEnvironment();
  const { values, execute } = parse(process.argv.slice(2));
  const need = (name: string) => { const v = values.get(name); if (!v) throw new ProviderError("INVALID_INPUT", `Missing ${name}`); return v; };
  const owner = need("--owner"), contract = need("--contract"), rpc = new URL(values.get("--rpc") ?? process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
  if (rpc.protocol !== "https:" || rpc.username || rpc.password) throw new ProviderError("INVALID_INPUT", "RPC URL must be https without credentials");
  const project = fileURLToPath(new URL("../../", import.meta.url)); // defaults never depend on the current directory
  const manifest = JSON.parse(await readFile(resolve(project, "contracts/artifacts/authority-manifest.json"), "utf8")) as { codeHashBase58?: string };
  const expectedHash = values.get("--expected-hash") ?? manifest.codeHashBase58 ?? "";
  const wasm = new Uint8Array(await readFile(resolve(values.get("--wasm") ?? resolve(project, "contracts/artifacts/persistara_authority-name-owner.wasm"))));
  const ownerKey = await loadKey(resolve(need("--owner-key-file")), "Owner key");
  const contractKeyFile = resolve(values.get("--contract-key-file") ?? `.persistara/keys/${contract}.key`), runtimeKeyFile = resolve(values.get("--runtime-key-file") ?? ".persistara/keys/near-runtime-v2.key");

  const provider = new JsonRpcProvider({ url: rpc.toString() }), ownerAccount = new Account(owner, provider, new KeyPairSigner(ownerKey));
  let contractKey: KeyPair | null = null, runtimeKey: KeyPair | null = null;
  try { contractKey = await loadKey(contractKeyFile, "Contract account key"); } catch (error) { if (!missing(error)) throw error; }
  try { runtimeKey = await loadKey(runtimeKeyFile, "Runtime key"); } catch (error) { if (!missing(error)) throw error; }
  const contractAccount = () => { if (!contractKey) throw new ProviderError("INVALID_INPUT", "Missing contract account key"); return new Account(contract, provider, new KeyPairSigner(contractKey)); };
  const send = (account: Account, receiverId: string, list: Parameters<Account["signAndSendTransaction"]>[0]["actions"]) => account.signAndSendTransaction({ receiverId, actions: list, waitUntil: "FINAL", throwOnFailure: true });
  const view = (account: string) => new Account(account, provider);

  const chain: DeployChain = {
    nowMs: () => Date.now(),
    balance: (account) => view(account).getBalance(),
    accountExists: async (account) => { try { await view(account).getState(); return true; } catch (error) { if (error instanceof Error && error.constructor.name === "AccountDoesNotExistError") return false; throw error; } },
    codeHash: async (account) => { const state = await view(account).getState() as unknown as { codeHash?: string; code_hash?: string }; const h = state.codeHash ?? state.code_hash ?? null; return h && h !== "11111111111111111111111111111111" ? h : null; },
    fullAccessKeys: async (account) => (await view(account).getAccessKeyList()).keys.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key),
    functionCallKeys: async (account) => (await view(account).getAccessKeyList()).keys.flatMap((k) => { const p = k.access_key.permission as unknown; const call = isObject(p) && isObject(p.FunctionCall) ? p.FunctionCall : null; return call ? [{ publicKey: k.public_key, receiver: String(call.receiver_id), methods: Array.isArray(call.method_names) ? call.method_names.map(String) : [] }] : []; }),
    agent: async (c, id) => { const value = await provider.callFunction<Record<string, unknown>>({ contractId: c, method: "get_agent", args: { agent_id: id }, blockQuery: { finality: "optimistic" } }); return isObject(value) ? value as unknown as AgentSnapshot : null; },
    createContractAccount: async (c, pk, amount) => { await send(ownerAccount, c, [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(PublicKey.from(pk))]); },
    deployAndInit: async (c, code) => { await send(contractAccount(), c, [actions.deployContract(code), actions.functionCall("new", {}, GAS, 0n)]); },
    ownerCall: async (c, method, args, deposit) => { await send(ownerAccount, c, [actions.functionCall(method, args, GAS, deposit)]); },
    addRuntimeKey: async (o, pk, c, methods, allowance) => { await send(ownerAccount, o, [actions.addFunctionCallAccessKey(PublicKey.from(pk), c, methods, allowance)]); },
  };
  const spec = (run: boolean) => ({ owner, ownerPublicKey: ownerKey.getPublicKey().toString(), contract, agentName: values.get("--agent-name") ?? "research", worker: values.get("--worker") ?? `worker.${owner}`,
    wasm, expectedHash, runtimePublicKey: runtimeKey ? runtimeKey.getPublicKey().toString() : null, contractPublicKey: contractKey ? contractKey.getPublicKey().toString() : null, contractKeyAvailable: contractKey !== null, execute: run });
  if (execute) { // every guard runs silently first, so a typo never leaves stray key files behind
    await deployTestnet(spec(false), chain, () => {});
    if (!contractKey) { contractKey = KeyPair.fromRandom("ed25519"); await writePrivateFile(contractKeyFile, Buffer.from(`${contractKey.toString()}\n`)); }
    if (!runtimeKey) { runtimeKey = KeyPair.fromRandom("ed25519"); await writePrivateFile(runtimeKeyFile, Buffer.from(`${runtimeKey.toString()}\n`)); }
  }
  console.log(execute ? "EXECUTING on NEAR testnet." : "DRY RUN: reading chain state only; nothing will be signed or sent.");
  const result = await deployTestnet(spec(execute), chain, (line) => console.log(line));
  console.log(execute ? "\nDone. Put these in .env (comment out the old values), set NEAR_RUNTIME_KEY_FILE to the runtime key file, then verify with pnpm contract:fetch, pnpm near:doctor and pnpm cli --plain status:" : "\nRe-run with --execute to do this. Values you will put in .env afterwards:");
  for (const [name, value] of Object.entries(result.env)) console.log(`${name}=${value}`);
  console.log(`NEAR_RUNTIME_KEY_FILE=${runtimeKeyFile}`);
}
main().catch(printFailure);
