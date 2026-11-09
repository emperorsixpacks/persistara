import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { baseEncode } from "near-api-js";
import { decodePrivateKeyring, verifyOwnerBackup } from "../../memory/src/backup.js";
import { readPrivateFile } from "../../memory/src/files.js";
import { MemoryWriteJournal } from "../../memory/src/write-journal.js";
import { nearConfig } from "../../near/src/config.js";
import { NearRpc } from "../../near/src/rpc.js";
import { OwnerJournal } from "../../owner/src/journal.js";
import { OwnerReader } from "../../owner/src/reader.js";
import { OwnerService } from "../../owner/src/service.js";
import { MissionJournal } from "../../runtime/src/journal.js";
import { MissionService } from "../../runtime/src/service.js";
import { PublicSourceReader, sourceOrigins } from "../../runtime/src/sources.js";
import { memoryBindingConfig } from "../../memory/src/config.js";
import { CommissionJournal } from "../../commerce/src/journal.js";
import { CommissionService } from "../../commerce/src/service.js";
import { NearCommissionChain } from "../../commerce/src/chain.js";
import { IsolatedNearSigner } from "../../near/src/isolated.js";
import { ZeroGBlobStore } from "../../storage/src/zero-g.js";
import { storageConfig } from "../../protocol/src/config.js";
import type { SpecialistMessage, SpecialistProfile } from "../../commerce/src/types.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";

export const workspaceDefaults = { "--commerce-state-dir": ".persistara/commerce/research", "--mission-state-dir": ".persistara/missions/research", "--memory-state-dir": ".persistara/runtime/research", "--state-dir": ".persistara/owner-console", "--keyring": ".persistara/keys/memory-keyring.json", "--bundle": ".persistara/recovery/research.bundle", "--secret-file": ".persistara/keys/research-recovery.secret" };
export type WorkspacePaths = typeof workspaceDefaults;
/** Shared owner-local engine for the terminal and console. Owner wallet keys never enter this context. */
export async function createLocalWorkspace(paths: WorkspacePaths = workspaceDefaults) {
  const config = nearConfig(process.env), binding = memoryBindingConfig(process.env), rpc = new NearRpc(config, undefined, { readAttempts: 2, timeoutMs: 8_000 });
  let wasm: Uint8Array;
  try { wasm = await readFile("target/near/persistara_authority/persistara_authority.wasm"); }
  catch (error) { if (isObject(error) && error.code === "ENOENT") throw new ProviderError("NOT_CONFIGURED", "Build the pinned local authority artifact with pnpm contract:build before opening this workspace"); throw error; }
  const codeHash = baseEncode(createHash("sha256").update(wasm).digest());
  const reader = new OwnerReader(rpc, config, codeHash, async (epoch) => {
    let status: "verified" | "epoch_mismatch" | "unavailable" = "unavailable";
    try {
      const keys = decodePrivateKeyring(await readPrivateFile(paths["--keyring"]!), binding);
      verifyOwnerBackup(await readPrivateFile(paths["--bundle"]!), Buffer.from(await readPrivateFile(paths["--secret-file"]!)).toString("utf8").trim(), binding, keys);
      status = keys.activeEpoch === epoch ? "verified" : "epoch_mismatch";
    } catch { /* Backup readiness fails closed without exposing paths or material. */ }
    let localRotationHold: boolean | null = null;
    try {
      const memory = new MemoryWriteJournal(resolve(paths["--memory-state-dir"]!, "writes.sqlite"), binding, Date.now, false);
      try { localRotationHold = memory.controls().heldBy !== null || memory.controls().minimumEpoch > epoch; }
      finally { memory.close(); }
    } catch { /* Missing canonical journal cannot authorize resume. */ }
    return { backup: { status, offDeviceVerified: false as const }, localRotationHold };
  });
  const journal = new OwnerJournal(resolve(paths["--state-dir"]!, "wallet.sqlite"), config, codeHash);
  const service = new OwnerService(config, journal, () => reader.read(), rpc);
  const origins = sourceOrigins(process.env.PERSISTARA_SOURCE_ORIGINS);
  const missionJournal = new MissionJournal(resolve(paths["--mission-state-dir"]!, "missions.sqlite"), { owner: config.signerId, agentId: config.agentId, contractId: config.contractId, chainId: config.chainId, codeHash }, origins);
  const missions = new MissionService(missionJournal, new PublicSourceReader(origins), () => reader.read());
  const commerceJournal = new CommissionJournal(resolve(paths["--commerce-state-dir"]!, "commissions.sqlite"), missionJournal.scope);
  let profile: SpecialistMessage<SpecialistProfile> | null = null;
  if (process.env.PERSISTARA_SPECIALIST_PROFILE) profile = JSON.parse(Buffer.from(await readPrivateFile(process.env.PERSISTARA_SPECIALIST_PROFILE)).toString("utf8")) as SpecialistMessage<SpecialistProfile>;
  const commerce = new CommissionService({ journal: commerceJournal, missions: missionJournal, signer: new IsolatedNearSigner(config), identity: config, chain: new NearCommissionChain(rpc, config), blobs: new ZeroGBlobStore(storageConfig(process.env)),
    read: () => reader.read(), recipientKeyFile: resolve(paths["--commerce-state-dir"]!, "keys/recipient.key"), profile });
  let closing: Promise<void> | null = null;
  const close = () => closing ??= missions.close().finally(() => { commerceJournal.close(); missionJournal.close(); journal.close(); });
  return { config, binding, rpc, codeHash, paths, service, missions, commerce, close };
}
export type LocalWorkspace = Awaited<ReturnType<typeof createLocalWorkspace>>;
