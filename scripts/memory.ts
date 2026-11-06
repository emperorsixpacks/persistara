import { resolve } from "node:path";
import { NearAuthorityReader } from "../packages/near/src/client.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { createOwnerBackup, decodePrivateKeyring, encodePrivateKeyring, verifyOwnerBackup } from "../packages/memory/src/backup.js";
import { assertBinding, type MemoryBinding } from "../packages/memory/src/binding.js";
import { MemoryKeyring } from "../packages/memory/src/keyring.js";
import { MemoryRecallIndex } from "../packages/memory/src/index.js";
import { readPrivateFile, writePrivateFile } from "../packages/memory/src/files.js";
import { rebuildFromOwnerBackup, recallCommitted } from "../packages/memory/src/recovery.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { storageConfig } from "../packages/protocol/src/config.js";
import { MemoryError } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { loadEnvironment, printFailure } from "./common.js";

function argumentsOf(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]; const value = argv[i + 1];
    if (!name || !["--keyring", "--bundle", "--secret-file", "--state-dir", "--query"].includes(name) || !value || result.has(name)) throw new MemoryError("INVALID_INPUT", "Invalid or duplicate memory command argument");
    result.set(name, value);
  }
  return result;
}
function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new MemoryError("INVALID_INPUT", `Missing ${name}`);
  return value;
}
function publicBinding(): MemoryBinding {
  if (!process.env.NEAR_AGENT_ID || !process.env.NEAR_AUTHORITY_CONTRACT) throw new ProviderError("NOT_CONFIGURED", "Configure the public NEAR agent and authority contract first");
  const storage = storageConfig(process.env);
  const binding: MemoryBinding = { agentId: process.env.NEAR_AGENT_ID, authorityNetwork: "near:testnet", chainId: "testnet", contractId: process.env.NEAR_AUTHORITY_CONTRACT,
    storageNetwork: `0g:16602:${storage.mode}` };
  assertBinding(binding); return binding;
}
async function main(): Promise<void> {
  loadEnvironment();
  const [command, ...argv] = process.argv.slice(2);
  const args = argumentsOf(argv);
  const binding = publicBinding();
  if (command === "keys") {
    const keys = MemoryKeyring.create();
    await writePrivateFile(required(args, "--keyring"), encodePrivateKeyring(binding, keys));
    console.log(JSON.stringify({ status: "created", agentId: binding.agentId, activeEpoch: 1, backupRequired: true })); return;
  }
  if (command === "backup") {
    const paths = [required(args, "--keyring"), required(args, "--bundle"), required(args, "--secret-file")].map((path) => resolve(path));
    if (new Set(paths).size !== paths.length) throw new MemoryError("INVALID_INPUT", "Keyring, backup and secret must use separate files");
    const keys = decodePrivateKeyring(await readPrivateFile(paths[0]!), binding);
    const backup = createOwnerBackup(binding, keys);
    await writePrivateFile(paths[2]!, Buffer.from(backup.recoverySecret));
    await writePrivateFile(paths[1]!, backup.bundle);
    const verified = verifyOwnerBackup(await readPrivateFile(paths[1]!), Buffer.from(await readPrivateFile(paths[2]!)).toString("utf8").trim(), binding, keys);
    console.log(JSON.stringify({ status: "backup-keyring-verified", agentId: binding.agentId, ...verified, checkpointRecovery: "not-yet-tested" })); return;
  }
  if (command === "verify-backup") {
    const verified = verifyOwnerBackup(await readPrivateFile(required(args, "--bundle")), Buffer.from(await readPrivateFile(required(args, "--secret-file"))).toString("utf8").trim(), binding);
    console.log(JSON.stringify({ status: "backup-format-and-authentication-verified", agentId: binding.agentId, ...verified, checkpointRecovery: "run-memory-recover" })); return;
  }
  if (command !== "recover" && command !== "recall") throw new MemoryError("INVALID_INPUT", "Unknown memory command");
  const reader = new NearAuthorityReader(new NearRpc({ kind: "testnet", chainId: "testnet", contractId: binding.contractId, rpcUrl: process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org" }));
  const heads = { get: async (agentId: string) => (await reader.agent(agentId)).head };
  const state = resolve(required(args, "--state-dir"));
  const index = new MemoryRecallIndex(resolve(state, "recall.sqlite"), binding);
  try {
    if (command === "recall") {
      console.log(JSON.stringify(await recallCommitted(index, heads, binding.agentId, required(args, "--query")), null, 2)); return;
    }
    const { uploaderKeyFile: _unused, ...storage } = storageConfig(process.env);
    const adapter = new ZeroGBlobStore(storage);
    const readOnlyBlobs = { get: (ref: Parameters<ZeroGBlobStore["get"]>[0]) => adapter.get(ref), put: async (): Promise<never> => { throw new MemoryError("INVALID_INPUT", "Recovery has no upload capability"); } };
    const result = await rebuildFromOwnerBackup({ binding, bundle: await readPrivateFile(required(args, "--bundle")), recoverySecret: Buffer.from(await readPrivateFile(required(args, "--secret-file"))).toString("utf8").trim(), blobs: readOnlyBlobs, heads, index });
    console.log(JSON.stringify({ status: "recovered", agentId: binding.agentId, checkpointVersion: result.version, recordCount: result.recordCount,
      currentFacts: result.currentCount, recoveredEpochs: result.recoveredEpochs, evidence: "finalized-NEAR-head-and-authenticated-provider-reads" }, null, 2));
  } finally { index.close(); }
}
main().catch((error: unknown) => {
  if (error instanceof MemoryError) { console.error(JSON.stringify({ status: "failed", code: error.code })); process.exitCode = 1; }
  else printFailure(error);
});
