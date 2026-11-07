import { resolve } from "node:path";
import { OwnerMemoryRotation } from "../packages/memory/src/rotation.js";
import { readPrivateFile } from "../packages/memory/src/files.js";
import { nearConfig } from "../packages/near/src/config.js";
import { IsolatedNearSigner } from "../packages/near/src/isolated.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { NearRotationReader } from "../packages/near/src/rotation.js";
import { storageConfig } from "../packages/protocol/src/config.js";
import { isObject, MemoryError } from "../packages/protocol/src/memory.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { loadEnvironment, printFailure } from "./common.js";
import { publicMemoryBinding } from "./memory-config.js";

async function main(): Promise<void> {
  loadEnvironment();
  const [command, ...argv] = process.argv.slice(2);
  if (!command || !["prepare", "next", "verify", "abort"].includes(command)) throw new MemoryError("INVALID_INPUT", "Unknown owner rotation command");
  const allowed = command === "prepare" ? ["--state-dir", "--memory-state-dir", "--keyring", "--bundle", "--secret-file", "--operation-id", "--resume", "--gas-allowance"] : ["--state-dir"];
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]; const value = argv[i + 1];
    if (!name || !allowed.includes(name) || !value || args.has(name)) throw new MemoryError("INVALID_INPUT", "Invalid owner rotation argument");
    args.set(name, value);
  }
  const required = (name: string): string => { const value = args.get(name); if (!value) throw new MemoryError("INVALID_INPUT", "Missing owner rotation argument"); return value; };
  const binding = publicMemoryBinding();
  let config = nearConfig(process.env);
  const stateDir = resolve(required("--state-dir"));
  if (command !== "prepare") {
    const intent: unknown = JSON.parse(Buffer.from(await readPrivateFile(resolve(stateDir, "intent.json"))).toString());
    if (!isObject(intent) || typeof intent.oldPublicKey !== "string" || typeof intent.oldNearJournal !== "string" || typeof intent.oldRuntimeFile !== "string") throw new MemoryError("INVALID_INPUT", "Owner rotation intent is invalid");
    // Public old-key identity/paths remain available after the operator activates the replacement configuration.
    config = nearConfig({ ...process.env, NEAR_RUNTIME_PUBLIC_KEY: intent.oldPublicKey, NEAR_JOURNAL_FILE: intent.oldNearJournal, NEAR_RUNTIME_KEY_FILE: intent.oldRuntimeFile });
  }
  const { uploaderKeyFile: _unused, ...readConfig } = storageConfig(process.env);
  const rotation = new OwnerMemoryRotation(config, binding, new NearRotationReader(new NearRpc(config), config), new IsolatedNearSigner(config), new ZeroGBlobStore(readConfig));
  if (command === "prepare") {
    const resume = required("--resume"); if (resume !== "true" && resume !== "false") throw new MemoryError("INVALID_INPUT", "Choose an explicit resume policy");
    const plan = await rotation.prepare({ operationId: required("--operation-id"), stateDir, memoryStateDir: required("--memory-state-dir"), oldKeyringFile: required("--keyring"),
      bundleFile: required("--bundle"), secretFile: required("--secret-file"), resume: resume === "true", gasAllowance: args.get("--gas-allowance") ?? "1000000000000000000000000" });
    console.log(JSON.stringify({ status: "prepared", operationId: plan.request.operationId, nextEpoch: plan.intent.oldEpoch + 1, nextRuntimePublicKey: plan.request.replacement.publicKey, backupAuthenticationVerified: true, offDeviceBackupVerified: false, walletActionRequired: true }));
  } else if (command === "next") {
    const next = await rotation.next(stateDir);
    const plan = await rotation.load(stateDir);
    console.log(JSON.stringify({ ...next, ...(next.status === "authority-complete" ? { nextRuntime: rotation.nextRuntimeConfig(plan), nextMemoryKeyring: plan.intent.nextKeyringFile, memoryStateDir: resolve(plan.intent.memoryJournal, "..") } : {}) }, null, 2));
    if (next.status === "awaiting-owner-wallet") process.exitCode = 3;
  } else if (command === "verify") console.log(JSON.stringify(await rotation.verify(stateDir), null, 2));
  else { await rotation.abort(stateDir); console.log(JSON.stringify({ status: "aborted-before-owner-request" })); }
}
main().catch((error: unknown) => {
  if (error instanceof MemoryError) { console.error(JSON.stringify({ status: "failed", code: error.code })); process.exitCode = 1; }
  else printFailure(error);
});
