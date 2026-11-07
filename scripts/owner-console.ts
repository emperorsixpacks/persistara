import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { baseEncode } from "near-api-js";
import { decodePrivateKeyring, verifyOwnerBackup } from "../packages/memory/src/backup.js";
import { readPrivateFile } from "../packages/memory/src/files.js";
import { MemoryWriteJournal } from "../packages/memory/src/write-journal.js";
import { nearConfig } from "../packages/near/src/config.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { OwnerJournal } from "../packages/owner/src/journal.js";
import { OwnerReader } from "../packages/owner/src/reader.js";
import { OwnerService } from "../packages/owner/src/service.js";
import { createOwnerServer } from "../packages/owner/src/server.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { MissionJournal } from "../packages/runtime/src/journal.js";
import { MissionService } from "../packages/runtime/src/service.js";
import { PublicSourceReader, sourceOrigins } from "../packages/runtime/src/sources.js";
import { loadEnvironment, printFailure } from "./common.js";
import { publicMemoryBinding } from "./memory-config.js";
import { CommissionJournal } from "../packages/commerce/src/journal.js";
import { CommissionService } from "../packages/commerce/src/service.js";
import { NearCommissionChain } from "../packages/commerce/src/chain.js";
import { IsolatedNearSigner } from "../packages/near/src/isolated.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { storageConfig } from "../packages/protocol/src/config.js";
import type { SpecialistMessage, SpecialistProfile } from "../packages/commerce/src/types.js";

async function main() {
  loadEnvironment();
  const defaults: Record<string, string> = { "--port": "3377", "--commerce-state-dir": ".persistara/commerce/research", "--mission-state-dir": ".persistara/missions/research", "--memory-state-dir": ".persistara/runtime/research", "--state-dir": ".persistara/owner-console", "--keyring": ".persistara/keys/memory-keyring.json", "--bundle": ".persistara/recovery/research.bundle", "--secret-file": ".persistara/keys/research-recovery.secret" };
  const args = process.argv.slice(2); const supplied = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!name || !Object.hasOwn(defaults, name) || !value || supplied.has(name)) throw new ProviderError("INVALID_INPUT", "Unknown or duplicate owner console argument");
    supplied.add(name); defaults[name] = value;
  }
  const port = Number(defaults["--port"]);
  const config = nearConfig(process.env), binding = publicMemoryBinding(), rpc = new NearRpc(config);
  const wasm = await readFile("target/near/persistara_authority/persistara_authority.wasm");
  const codeHash = baseEncode(createHash("sha256").update(wasm).digest());
  const reader = new OwnerReader(rpc, config, codeHash, async (epoch) => {
    let status: "verified" | "epoch_mismatch" | "unavailable" = "unavailable";
    try {
      const keys = decodePrivateKeyring(await readPrivateFile(defaults["--keyring"]!), binding);
      verifyOwnerBackup(await readPrivateFile(defaults["--bundle"]!), Buffer.from(await readPrivateFile(defaults["--secret-file"]!)).toString("utf8").trim(), binding, keys);
      status = keys.activeEpoch === epoch ? "verified" : "epoch_mismatch";
    } catch { /* Backup readiness fails closed without exposing paths or material. */ }
    let localRotationHold: boolean | null = null;
    try {
      const memory = new MemoryWriteJournal(resolve(defaults["--memory-state-dir"]!, "writes.sqlite"), binding, Date.now, false);
      try { localRotationHold = memory.controls().heldBy !== null || memory.controls().minimumEpoch > epoch; }
      finally { memory.close(); }
    } catch { /* Missing canonical journal cannot authorize resume. */ }
    return { backup: { status, offDeviceVerified: false as const }, localRotationHold };
  });
  const journal = new OwnerJournal(resolve(defaults["--state-dir"]!, "wallet.sqlite"), config, codeHash);
  const service = new OwnerService(config, journal, () => reader.read(), rpc);
  const origins = sourceOrigins(process.env.PERSISTARA_SOURCE_ORIGINS);
  const missionJournal = new MissionJournal(resolve(defaults["--mission-state-dir"]!, "missions.sqlite"), { owner: config.signerId, agentId: config.agentId, contractId: config.contractId, chainId: config.chainId, codeHash }, origins);
  const missions = new MissionService(missionJournal, new PublicSourceReader(origins), () => reader.read());
  const commerceJournal = new CommissionJournal(resolve(defaults["--commerce-state-dir"]!, "commissions.sqlite"), missionJournal.scope);
  let profile: SpecialistMessage<SpecialistProfile> | null = null;
  if (process.env.PERSISTARA_SPECIALIST_PROFILE) profile = JSON.parse(Buffer.from(await readPrivateFile(process.env.PERSISTARA_SPECIALIST_PROFILE)).toString("utf8")) as SpecialistMessage<SpecialistProfile>;
  const commerce = new CommissionService({ journal: commerceJournal, missions: missionJournal, signer: new IsolatedNearSigner(config), identity: config, chain: new NearCommissionChain(rpc, config), blobs: new ZeroGBlobStore(storageConfig(process.env)),
    read: () => reader.read(), recipientKeyFile: resolve(defaults["--commerce-state-dir"]!, "keys/recipient.key"), profile });
  const { server, origin, drain } = createOwnerServer({ port, staticDirectory: resolve("apps/console/dist"), service, missions, commerce });
  server.on("error", (error) => { void missions.close().finally(() => { commerceJournal.close(); missionJournal.close(); journal.close(); printFailure(error); }); });
  server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ status: "owner_console_listening", url: origin, network: "near:testnet", owner: config.signerId, agentId: config.agentId, ownerKeyLoaded: false, nearAiUsed: false })));
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    const stopped = missions.close();
    server.close(() => { void Promise.allSettled([stopped, drain()]).finally(() => { commerceJournal.close(); missionJournal.close(); journal.close(); process.exit(0); }); });
    server.closeIdleConnections();
  };
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
main().catch(printFailure);
