/** Owner-local portable recovery. Restore never reads .env or receives a signing/upload capability. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { baseEncode } from "near-api-js";
import { NearCommissionChain } from "../packages/commerce/src/chain.js";
import { validateRecipientKeys } from "../packages/commerce/src/encryption.js";
import { CommissionJournal } from "../packages/commerce/src/journal.js";
import { decodePrivateKeyring, encodePrivateKeyring, verifyOwnerBackup } from "../packages/memory/src/backup.js";
import { privateDirectory, readPrivateFile, writePrivateFile } from "../packages/memory/src/files.js";
import { MemoryRecallIndex } from "../packages/memory/src/index.js";
import { nearConfig } from "../packages/near/src/config.js";
import { canonical, validateNetwork, type NearNetwork } from "../packages/near/src/protocol.js";
import { storageConfig, type StorageConfig } from "../packages/protocol/src/config.js";
import { isObject, MemoryError } from "../packages/protocol/src/memory.js";
import { createRecoveryKit, MAX_KIT_BYTES, openRecoveryKit, recoverKit, recoveryCommission, type OpenKit } from "../packages/recovery/src/kit.js";
import { RecoveryAuthorityReader } from "../packages/recovery/src/near.js";
import { readRecoveryPublicFile } from "../packages/recovery/src/files.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { loadEnvironment, printFailure } from "./common.js";
import { publicMemoryBinding } from "./memory-config.js";

const invalid = () => new MemoryError("INVALID_INPUT", "Use recovery:kit prepare|verify|recover with the documented file arguments");
const allowed = {
  prepare: ["--out-dir", "--secret-file", "--keyring", "--bundle", "--memory-secret-file", "--commerce-state-dir"],
  verify: ["--kit", "--secret-file", "--expect-sha256"],
  recover: ["--kit", "--secret-file", "--expect-sha256", "--manifest", "--state-dir"],
};
function argsOf(command: keyof typeof allowed, argv: string[]) {
  const result = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key || !value || !allowed[command].includes(key) || result.has(key)) throw invalid(); result.set(key, value);
  }
  return result;
}
const required = (args: Map<string, string>, name: string) => { const value = args.get(name); if (!value) throw invalid(); return value; };
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if (isObject(error) && error.code === "ENOENT") return false; throw error; } }
async function freshDirectory(path: string) {
  const absolute = resolve(path); await privateDirectory(dirname(absolute));
  try { await mkdir(absolute, { mode: 0o700 }); }
  catch (error) { if (isObject(error) && error.code === "EEXIST") throw new MemoryError("INVALID_INPUT", "Choose a fresh recovery directory; existing state is never overwritten"); throw error; }
  return absolute;
}
function summary(kit: OpenKit) { return { kitSha256: kit.digest, kitId: kit.header.id, agentId: kit.header.scope.agentId, activeEpoch: kit.keys.activeEpoch, memoryEpochs: kit.keys.epochs(), deliveryRecipientIncluded: Boolean(kit.recipient), deliveryCount: kit.commissions.length, offDeviceVerified: false }; }
async function loadKit(args: Map<string, string>) {
  return openRecoveryKit(await readRecoveryPublicFile(required(args, "--kit"), MAX_KIT_BYTES), Buffer.from(await readPrivateFile(required(args, "--secret-file"))).toString("utf8").trim(), required(args, "--expect-sha256"));
}
async function prepare(args: Map<string, string>) {
  loadEnvironment();
  const config = nearConfig(process.env), binding = publicMemoryBinding(), { uploaderKeyFile: _unused, ...storage } = storageConfig(process.env);
  const wasm = await readFile("target/near/persistara_authority/persistara_authority.wasm");
  const scope = { owner: config.signerId, agentId: config.agentId, contractId: config.contractId, chainId: config.chainId, codeHash: baseEncode(createHash("sha256").update(wasm).digest()) };
  const near: NearNetwork = { kind: "testnet", chainId: "testnet", rpcUrl: config.rpcUrl, contractId: config.contractId };
  const observation = await new RecoveryAuthorityReader(near, scope).observe();
  const keys = decodePrivateKeyring(await readPrivateFile(args.get("--keyring") ?? ".persistara/keys/memory-keyring.json"), binding);
  verifyOwnerBackup(await readPrivateFile(args.get("--bundle") ?? ".persistara/recovery/research.bundle"), Buffer.from(await readPrivateFile(args.get("--memory-secret-file") ?? ".persistara/keys/research-recovery.secret")).toString("utf8").trim(), binding, keys);
  if (keys.activeEpoch !== observation.keyEpoch) throw new MemoryError("KEY_EPOCH_MISMATCH", "Current memory backup does not cover the finalized active epoch");
  const commerce = resolve(args.get("--commerce-state-dir") ?? ".persistara/commerce/research"), journalFile = resolve(commerce, "commissions.sqlite");
  let records: ReturnType<CommissionJournal["records"]> = [];
  if (await exists(journalFile)) { const journal = new CommissionJournal(journalFile, scope); try { records = journal.records(); } finally { journal.close(); } }
  const recipientFile = resolve(commerce, "keys/recipient.key");
  const recipient = await exists(recipientFile) ? await validateRecipientKeys(JSON.parse(Buffer.from(await readPrivateFile(recipientFile)).toString())) : null;
  if (records.length && !recipient) throw new MemoryError("INVALID_BACKUP", "Restore the existing buyer recipient key before exporting");
  const commissions = records.map(recoveryCommission).filter(value => value !== null);
  const result = await createRecoveryKit({ scope, ownerKey: observation.ownerKey, binding, checkpoint: observation.head, keys, recipient, commissions, now: Number(BigInt(observation.timestampNs) / 1_000_000n) });
  const directory = resolve(required(args, "--out-dir")), secretFile = resolve(required(args, "--secret-file"));
  if (secretFile === directory || secretFile.startsWith(directory + "/") || await exists(secretFile)) throw new MemoryError("INVALID_INPUT", "Keep the new kit secret in a separate, unused file outside the export directory");
  await freshDirectory(directory);
  // Exclusive private files: partial exports remain incomplete and never replace a healthy backup.
  await writePrivateFile(secretFile, Buffer.from(result.secret)); await writePrivateFile(resolve(directory, "owner.kit"), result.bundle);
  const verified = await openRecoveryKit(await readPrivateFile(resolve(directory, "owner.kit"), MAX_KIT_BYTES), Buffer.from(await readPrivateFile(secretFile)).toString(), result.digest);
  const manifest = { schemaVersion: 1, kind: "persistara-recovery-kit-manifest", kitSha256: result.digest, kitId: result.header.id, scope, near, storage,
    checkpointVersion: observation.head?.version ?? 0, deliveryCount: commissions.length, offDeviceVerified: false,
    omitted: ["owner/worker wallet keys", "runtime/uploader keys", "pending-effect journals", "plaintext recall database"] };
  await writePrivateFile(resolve(directory, "manifest.json"), Buffer.from(JSON.stringify(manifest, null, 2)));
  await writePrivateFile(resolve(directory, "TRANSFER.txt"), Buffer.from(`Persistara encrypted owner recovery kit\nSHA-256: ${result.digest}\n\nCopy this directory to your separate recovery device. Keep the kit secret separately.\nOn a trusted checkout of this release: pnpm recovery:kit verify --kit /path/owner.kit --secret-file /separate/path/kit.secret --expect-sha256 ${result.digest}\nThen: pnpm recovery:kit recover --kit /path/owner.kit --secret-file /separate/path/kit.secret --expect-sha256 ${result.digest} --manifest /path/manifest.json --state-dir /private/new/recovery\n\nThese commands never load .env or wallet/runtime/uploader credentials. Recovery performs public reads only.\nCompare the fingerprint through an independent trusted channel. A same-machine test is not physical off-device verification.\nPending operations still require their original journals; this kit cannot authorize replacement effects.\n`));
  console.log(JSON.stringify({ status: "encrypted_recovery_kit_prepared_and_authenticated", ...summary(verified), physicalRecovery: "pending-separate-device", nearAiUsed: false, uploadOrTransactionSubmitted: false }));
}
async function recover(args: Map<string, string>, kit: OpenKit) {
  // No loadEnvironment(): neither original .env nor original keys/journals are consulted.
  const raw: unknown = JSON.parse(Buffer.from(await readRecoveryPublicFile(required(args, "--manifest"), 16_000)).toString());
  if (!isObject(raw) || raw.schemaVersion !== 1 || raw.kind !== "persistara-recovery-kit-manifest" || raw.kitSha256 !== kit.digest || raw.kitId !== kit.header.id || canonical(raw.scope) !== canonical(kit.header.scope) || !isObject(raw.near) || Object.keys(raw.near).sort().join(",") !== "chainId,contractId,kind,rpcUrl" || !isObject(raw.storage) || Object.keys(raw.storage).sort().join(",") !== "chainId,indexerUrl,mode,rpcUrl") throw new MemoryError("INVALID_BACKUP", "Recovery manifest differs from the independently pinned kit");
  const near = raw.near as unknown as NearNetwork; validateNetwork(near);
  if (near.contractId !== kit.header.scope.contractId || near.chainId !== kit.header.scope.chainId || near.kind !== "testnet" || raw.storage.chainId !== 16602) throw invalid();
  const storage: StorageConfig = storageConfig({ ZG_STORAGE_MODE: String(raw.storage.mode), ZG_RPC_URL: String(raw.storage.rpcUrl), ZG_INDEXER_URL: String(raw.storage.indexerUrl) });
  if (`0g:16602:${storage.mode}` !== kit.header.binding.storageNetwork) throw invalid();
  const directory = await freshDirectory(required(args, "--state-dir"));
  await writePrivateFile(resolve(directory, "INCOMPLETE"), Buffer.from("Recovery has not yet authenticated/published its completion receipt.\n"));
  const authority = new RecoveryAuthorityReader(near, kit.header.scope), chain = new NearCommissionChain(authority.rpc, { signerId: kit.header.scope.owner, publicKey: kit.header.ownerKey, agentId: kit.header.scope.agentId });
  const result = await recoverKit(kit, { observe: () => authority.observe(), job: id => chain.job(id), blobs: new ZeroGBlobStore(storage) });
  const index = new MemoryRecallIndex(resolve(directory, "recall.sqlite"), kit.header.binding);
  let indexed;
  try { indexed = index.replace(result.snapshot); } finally { index.close(); }
  await writePrivateFile(resolve(directory, "memory-keyring.json"), encodePrivateKeyring(kit.header.binding, kit.keys));
  if (kit.recipient) await writePrivateFile(resolve(directory, "delivery-recipient.key"), Buffer.from(JSON.stringify(kit.recipient)));
  for (const item of result.deliveries) await writePrivateFile(resolve(directory, "artifacts", `${item.id.slice(11)}.json`), Buffer.from(JSON.stringify({ digest: item.digest, value: item.artifact })));
  const report = { schemaVersion: 1, status: "recovery_kit_live_reads_verified", ...summary(kit), memory: { checkpointVersion: indexed.version, recordCount: indexed.recordCount, currentFacts: indexed.currentCount, head: result.snapshot.head }, deliveries: result.deliveries.map(({ id, digest, status, payoutAttempt }) => ({ id, digest, status, payoutAttempt })), finalizedBlockHash: result.observation.blockHash,
    physicalRecovery: "requires-independent-device-observation", originalEnvironmentLoaded: false, ownerOrWorkerWalletKeyLoaded: false, runtimeOrUploaderKeyLoaded: false, pendingEffectsReplayed: false, nearAiUsed: false, uploadOrTransactionSubmitted: false, verifiedAt: new Date().toISOString() };
  // The completion receipt is the publication marker. An earlier failure leaves only an incomplete directory.
  await writePrivateFile(resolve(directory, "recovery-report.json"), Buffer.from(JSON.stringify(report, null, 2)));
  await unlink(resolve(directory, "INCOMPLETE"));
  console.log(JSON.stringify(report));
}
async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command !== "prepare" && command !== "verify" && command !== "recover") throw invalid();
  const args = argsOf(command, argv);
  if (command === "prepare") return prepare(args);
  const kit = await loadKit(args);
  if (command === "verify") { console.log(JSON.stringify({ status: "recovery_kit_authenticated_offline", ...summary(kit), networkUsed: false, originalEnvironmentLoaded: false })); return; }
  await recover(args, kit);
}
main().catch(error => { if (error instanceof MemoryError) { console.error(JSON.stringify({ status: "failed", code: error.code })); process.exitCode = 1; } else printFailure(error); });
