import { timingSafeEqual } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { KeyPair } from "near-api-js";
import { sha256 } from "../../crypto/src/envelope.js";
import { canonical, decimal, runtimePermission, validateIdentity, validateNetwork, type NearSignerConfig } from "../../near/src/protocol.js";
import { replacementAccess, replacementMethods, rotationRecord, type OwnerWalletRequest, type RotationRequest, type RotationSnapshot } from "../../near/src/rotation.js";
import { isObject, MemoryError, type BlobStore, type MemoryHead } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { createOwnerBackup, decodePrivateKeyring, encodePrivateKeyring, verifyOwnerBackup, wrapOwnerBackup } from "./backup.js";
import { assertBinding, assertBoundBlob, bindingText, type MemoryBinding } from "./binding.js";
import { privateDirectory, readPrivateFile, writePrivateFile } from "./files.js";
import { headFingerprint } from "./index.js";
import { MemoryKeyring } from "./keyring.js";
import { readOnlyHeads } from "./recovery.js";
import { MemoryService } from "./service.js";
import { MemoryWriteJournal } from "./write-journal.js";

export interface RotationReader { read(id: string): Promise<RotationSnapshot> }
export interface RotationSignerControl {
  journalIdentity(create: boolean): Promise<string>;
  rotationBarrier(id: string, identity: string, release?: boolean): Promise<void>;
}
export interface RotationPrepareInput {
  operationId: string; stateDir: string; memoryStateDir: string; oldKeyringFile: string; bundleFile: string; secretFile: string;
  resume: boolean; gasAllowance: string;
}
interface RotationIntent {
  schemaVersion: 1; binding: MemoryBinding; operationId: string; ownerKey: string; generation: string; oldEpoch: number; oldEpochs: number[];
  oldKeyringDigest: string; memoryJournalIdentity: string; signerJournalIdentity: string; signerId: string; oldPublicKey: string;
  expiresAtNs: string; canSpend: boolean; resume: boolean; gasAllowance: string;
  stateDir: string; memoryJournal: string; oldNearJournal: string; oldRuntimeFile: string; oldKeyringFile: string; nextKeyringFile: string; nextRuntimeFile: string; nextNearJournal: string; bundleFile: string; secretFile: string;
}
export interface RotationPlan { schemaVersion: 1; intent: RotationIntent; request: RotationRequest; baselineHead: MemoryHead | null; nextKeyringDigest: string }
export type RotationNext = { status: "awaiting-owner-wallet"; stage: "begin" | "remove-old-key" | "install-new-key" | "finish"; request: OwnerWalletRequest } |
  { status: "authority-complete" | "aborted"; nextEpoch: number; nextRuntimePublicKey: string; memoryVerificationRequired: boolean };

function conflict(message = "Rotation state differs from the owner plan"): never { throw new ProviderError("OPERATION_CONFLICT", message); }
function missing(error: unknown): boolean { return isObject(error) && error.code === "ENOENT"; }
async function optional(path: string): Promise<Uint8Array | null> { try { return await readPrivateFile(path); } catch (error) { if (missing(error)) return null; throw error; } }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
async function ensured(path: string, bytes: () => Uint8Array): Promise<Uint8Array> {
  const prior = await optional(path); if (prior) return prior;
  try { await writePrivateFile(path, bytes()); } catch (error) { if (!(isObject(error) && error.code === "EEXIST")) throw error; }
  return readPrivateFile(path);
}
async function saveImmutable(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(canonical(value));
  const actual = await ensured(path, () => bytes);
  if (!timingSafeEqual(Buffer.from(sha256(actual)), Buffer.from(sha256(bytes)))) conflict("Existing owner preparation file has different contents");
}
function parse(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new MemoryError("INTEGRITY_FAILED", "Owner rotation file is malformed"); }
}
function runtimeKey(bytes: Uint8Array): ReturnType<typeof KeyPair.fromString> {
  const text = Buffer.from(bytes).toString("utf8").trim();
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(text)) throw new MemoryError("INVALID_INPUT", "Prepared runtime key is invalid");
  try { return KeyPair.fromString(text as Parameters<typeof KeyPair.fromString>[0]); } catch { throw new MemoryError("INVALID_INPUT", "Prepared runtime key is invalid"); }
}

/** Owner-local coordinator. Has no owner-key loader, wallet transport, upload or transaction submission method. */
export class OwnerMemoryRotation {
  private readonly config: NearSignerConfig;
  private readonly binding: MemoryBinding;
  constructor(config: NearSignerConfig, binding: MemoryBinding, private readonly reader: RotationReader, private readonly signer: RotationSignerControl, private readonly blobs: BlobStore) {
    validateIdentity(config); validateNetwork(config); assertBinding(binding);
    if (binding.agentId !== config.agentId || binding.contractId !== config.contractId || binding.chainId !== config.chainId || binding.authorityNetwork !== `near:${config.kind}`) throw new ProviderError("NETWORK_MISMATCH", "Owner rotation network scopes differ");
    this.config = structuredClone(config); this.binding = structuredClone(binding);
  }
  private memoryJournal(intent: RotationIntent): MemoryWriteJournal {
    const journal = new MemoryWriteJournal(intent.memoryJournal, this.binding, Date.now, false);
    if (journal.controls().identity !== intent.memoryJournalIdentity) { journal.close(); throw new MemoryError("INTEGRITY_FAILED", "Original memory journal was replaced"); }
    return journal;
  }
  private barrier(intent: RotationIntent, release = false, activate = false): void {
    const journal = this.memoryJournal(intent);
    try {
      const control = journal.controls();
      if (release && !activate && control.heldBy === null) return;
      if (release && control.heldBy === null && control.lastRotation === intent.operationId && (!activate || control.minimumEpoch === intent.oldEpoch + 1)) return;
      const lease = journal.acquire(30_000);
      try { if (release) journal.releaseRotation(lease, intent.operationId, activate ? intent.oldEpoch + 1 : undefined); else journal.holdForRotation(lease, intent.operationId); }
      finally { journal.release(lease); }
    } finally { journal.close(); }
  }
  private owner(snapshot: RotationSnapshot, intent?: RotationIntent): void {
    if (snapshot.agentId !== this.config.agentId || snapshot.chainId !== this.config.chainId || snapshot.contractId !== this.config.contractId || snapshot.owner !== this.config.signerId || (intent && snapshot.ownerKey !== intent.ownerKey) || !snapshot.accessKeys.some((k) => k.publicKey === snapshot.ownerKey && k.permission === "FullAccess")) throw new ProviderError("AUTHORIZATION_FAILED", "The registered owner and network must match the rotation scope");
    if (snapshot.head) assertBoundBlob(this.binding, snapshot.head.manifest);
  }
  private initial(snapshot: RotationSnapshot): void {
    this.owner(snapshot);
    const old = snapshot.delegates[0];
    if (snapshot.rotation || snapshot.delegates.length !== 1 || !old || old.publicKey !== this.config.publicKey || !old.canCheckpoint || snapshot.ownerKey === this.config.publicKey) conflict("Planned rotation requires one dedicated checkpoint runtime and a fresh operation ID");
    const key = snapshot.accessKeys.find((k) => k.publicKey === this.config.publicKey);
    if (!key || !runtimePermission(key.permission, this.config.contractId, "checkpoint_memory")) throw new ProviderError("AUTHORIZATION_FAILED", "Original runtime access key is absent or unrestricted");
  }
  private service(keys: MemoryKeyring, head: MemoryHead | null): MemoryService {
    return new MemoryService(this.binding.agentId, keys, keys.activeEpoch, this.blobs, readOnlyHeads({ get: async () => structuredClone(head) }), { binding: this.binding });
  }
  async prepare(input: RotationPrepareInput): Promise<RotationPlan> {
    const captured = structuredClone(input);
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(captured.operationId) || typeof captured.resume !== "boolean" || !decimal(captured.gasAllowance, 128, true) || BigInt(captured.gasAllowance) > 5_000_000_000_000_000_000_000_000n) throw new MemoryError("INVALID_INPUT", "Invalid owner rotation preparation");
    const directory = resolve(captured.stateDir); await privateDirectory(directory);
    if (await exists(resolve(directory, "aborted.json"))) conflict("This owner rotation was aborted; use a fresh operation ID and directory");
    const completed = await optional(resolve(directory, "plan.json"));
    if (completed) {
      const plan = await this.load(directory);
      if (plan.intent.operationId !== captured.operationId || plan.intent.resume !== captured.resume || plan.intent.gasAllowance !== captured.gasAllowance || plan.intent.oldKeyringFile !== resolve(captured.oldKeyringFile) || plan.intent.memoryJournal !== resolve(captured.memoryStateDir, "writes.sqlite") || plan.intent.bundleFile !== resolve(captured.bundleFile) || plan.intent.secretFile !== resolve(captured.secretFile)) conflict();
      await this.materials(plan); return plan;
    }
    const oldBytes = await readPrivateFile(captured.oldKeyringFile);
    const oldKeys = decodePrivateKeyring(oldBytes, this.binding);
    const snapshot = await this.reader.read(captured.operationId); this.initial(snapshot);
    if (snapshot.keyEpoch !== oldKeys.activeEpoch || oldKeys.activeEpoch >= Number.MAX_SAFE_INTEGER) throw new MemoryError("KEY_EPOCH_MISMATCH", "Original memory keyring does not match the authority epoch");
    const journalPath = resolve(captured.memoryStateDir, "writes.sqlite");
    const journal = new MemoryWriteJournal(journalPath, this.binding, Date.now, false);
    let memoryIdentity: string; try { memoryIdentity = journal.controls().identity; } finally { journal.close(); }
    const priorIntent = await optional(resolve(directory, "intent.json"));
    const intent: RotationIntent = priorIntent ? this.intent(parse(priorIntent), directory) : {
      schemaVersion: 1, binding: structuredClone(this.binding), operationId: captured.operationId, ownerKey: snapshot.ownerKey, generation: snapshot.generation, oldEpoch: snapshot.keyEpoch, oldEpochs: oldKeys.epochs(),
      oldKeyringDigest: sha256(oldBytes), memoryJournalIdentity: memoryIdentity, signerJournalIdentity: await this.signer.journalIdentity(false), signerId: this.config.signerId, oldPublicKey: this.config.publicKey,
      expiresAtNs: String(BigInt(snapshot.timestampNs) + 86_400_000_000_000n), canSpend: snapshot.delegates[0]!.canSpend && (() => {
        const permission = snapshot.accessKeys.find((k) => k.publicKey === this.config.publicKey)!.permission as { FunctionCall: { method_names: string[] } };
        return ["create_job", "accept_job"].every((method) => permission.FunctionCall.method_names.includes(method));
      })(), resume: captured.resume, gasAllowance: captured.gasAllowance,
      stateDir: directory, memoryJournal: journalPath, oldNearJournal: resolve(this.config.journalFile), oldRuntimeFile: resolve(this.config.runtimeKeyFile), oldKeyringFile: resolve(captured.oldKeyringFile), nextKeyringFile: resolve(directory, "next-memory.json"), nextRuntimeFile: resolve(directory, "next-runtime.key"), nextNearJournal: resolve(directory, "next-near", "authority.sqlite"), bundleFile: resolve(captured.bundleFile), secretFile: resolve(captured.secretFile),
    };
    if (intent.operationId !== captured.operationId || intent.oldKeyringDigest !== sha256(oldBytes) || intent.memoryJournalIdentity !== memoryIdentity || intent.memoryJournal !== journalPath || intent.oldKeyringFile !== resolve(captured.oldKeyringFile) || intent.bundleFile !== resolve(captured.bundleFile) || intent.secretFile !== resolve(captured.secretFile) || intent.resume !== captured.resume || intent.gasAllowance !== captured.gasAllowance) conflict();
    this.intent(intent, directory);
    await saveImmutable(resolve(directory, "intent.json"), intent);
    const nextRuntime = runtimeKey(await ensured(intent.nextRuntimeFile, () => Buffer.from(KeyPair.fromRandom("ed25519").toString())));
    const newPublicKey = nextRuntime.getPublicKey().toString();
    if (newPublicKey === intent.ownerKey || newPublicKey === intent.oldPublicKey || snapshot.accessKeys.some((k) => k.publicKey === newPublicKey)) conflict("Replacement runtime key must be new and distinct");
    const nextKeys = decodePrivateKeyring(await ensured(intent.nextKeyringFile, () => encodePrivateKeyring(this.binding, oldKeys.nextEpoch())), this.binding);
    if (nextKeys.activeEpoch !== intent.oldEpoch + 1 || canonical(nextKeys.epochs()) !== canonical([...oldKeys.epochs(), nextKeys.activeEpoch]) || oldKeys.epochs().some((e) => !timingSafeEqual(oldKeys.key(e), nextKeys.key(e)))) throw new MemoryError("KEY_EPOCH_MISMATCH", "Prepared keyring does not preserve every historical key");
    const secret = Buffer.from(await ensured(intent.secretFile, () => Buffer.from(createOwnerBackup(this.binding, nextKeys).recoverySecret))).toString().trim();
    const bundle = await ensured(intent.bundleFile, () => wrapOwnerBackup(this.binding, nextKeys, secret));
    verifyOwnerBackup(bundle, secret, this.binding, nextKeys);
    this.barrier(intent);
    if (await this.signer.journalIdentity(false) !== intent.signerJournalIdentity) throw new MemoryError("INTEGRITY_FAILED", "Original signer journal was replaced");
    await this.signer.rotationBarrier(intent.operationId, intent.signerJournalIdentity);
    const pinned = await this.reader.read(intent.operationId); this.owner(pinned, intent);
    if (pinned.rotation || pinned.generation !== intent.generation || pinned.keyEpoch !== intent.oldEpoch || pinned.delegates.length !== 1 || pinned.delegates[0]?.publicKey !== intent.oldPublicKey || BigInt(intent.expiresAtNs) <= BigInt(pinned.timestampNs)) conflict();
    await this.service(nextKeys, pinned.head).recoverSnapshot();
    const plan: RotationPlan = { schemaVersion: 1, intent, request: { agentId: this.binding.agentId, operationId: intent.operationId, expectedGeneration: intent.generation, expectedEpoch: String(intent.oldEpoch), expectedVersion: String(pinned.head?.version ?? 0),
      oldPublicKey: intent.oldPublicKey, replacement: { publicKey: newPublicKey, expiresAtNs: intent.expiresAtNs, canCheckpoint: true, canSpend: intent.canSpend }, recoveryCommitment: sha256(bundle), resume: intent.resume }, baselineHead: pinned.head, nextKeyringDigest: sha256(encodePrivateKeyring(this.binding, nextKeys)) };
    await saveImmutable(resolve(directory, "plan.json"), { plan, digest: sha256(Buffer.from(canonical(plan))) });
    return plan;
  }
  private intent(value: unknown, directory: string): RotationIntent {
    if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.binding) || bindingText(value.binding as unknown as MemoryBinding) !== bindingText(this.binding) || value.stateDir !== directory ||
        typeof value.operationId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value.operationId) || value.signerId !== this.config.signerId || value.oldPublicKey !== this.config.publicKey || !Number.isSafeInteger(value.oldEpoch) || Number(value.oldEpoch) < 1 ||
        !Array.isArray(value.oldEpochs) || value.oldEpochs.length < 1 || value.oldEpochs.length > 63 || value.oldEpochs.some((e) => !Number.isSafeInteger(e) || Number(e) < 1 || Number(e) > Number(value.oldEpoch)) || new Set(value.oldEpochs).size !== value.oldEpochs.length ||
        !decimal(value.generation, 64, true) || !decimal(value.expiresAtNs, 64, true) || typeof value.resume !== "boolean" || typeof value.canSpend !== "boolean" || !decimal(value.gasAllowance, 128, true) || BigInt(value.gasAllowance) > 5_000_000_000_000_000_000_000_000n) conflict();
    for (const key of ["oldKeyringDigest", "memoryJournalIdentity", "signerJournalIdentity", "ownerKey"]) if (typeof value[key] !== "string") conflict();
    if (!/^[a-f0-9]{64}$/.test(String(value.oldKeyringDigest)) || !/^[a-f0-9-]{36}$/.test(String(value.memoryJournalIdentity)) || !/^[a-f0-9-]{36}$/.test(String(value.signerJournalIdentity))) conflict();
    const paths = ["stateDir", "memoryJournal", "oldNearJournal", "oldRuntimeFile", "oldKeyringFile", "nextKeyringFile", "nextRuntimeFile", "nextNearJournal", "bundleFile", "secretFile"];
    for (const name of paths) if (typeof value[name] !== "string" || String(value[name]).length > 1024 || resolve(String(value[name])) !== value[name] || String(value[name]).includes("\0")) conflict();
    if (value.oldNearJournal !== resolve(this.config.journalFile) || value.oldRuntimeFile !== resolve(this.config.runtimeKeyFile) || value.nextKeyringFile !== resolve(directory, "next-memory.json") || value.nextRuntimeFile !== resolve(directory, "next-runtime.key") || value.nextNearJournal !== resolve(directory, "next-near", "authority.sqlite") ||
        new Set(paths.map((p) => value[p])).size !== paths.length || dirname(String(value.bundleFile)) === dirname(String(value.secretFile))) conflict("Rotation paths must be distinct, with separate bundle and secret directories");
    return value as unknown as RotationIntent;
  }
  async load(directory: string): Promise<RotationPlan> {
    const absolute = resolve(directory);
    const value = parse(await readPrivateFile(resolve(absolute, "plan.json")));
    if (!isObject(value) || !isObject(value.plan) || value.plan.schemaVersion !== 1 || typeof value.digest !== "string" || value.digest !== sha256(Buffer.from(canonical(value.plan)))) conflict("Owner rotation plan checksum failed");
    const intent = this.intent(value.plan.intent, absolute);
    const plan = value.plan as unknown as RotationPlan;
    const record = rotationRecord({ request: plan.request, nextEpoch: String(intent.oldEpoch + 1), beginGeneration: String(BigInt(intent.generation) + 1n), completed: false });
    if (!record || record.request.agentId !== this.binding.agentId || record.request.operationId !== intent.operationId || record.request.oldPublicKey !== intent.oldPublicKey || record.request.expectedGeneration !== intent.generation || record.request.expectedEpoch !== String(intent.oldEpoch) ||
        record.request.expectedVersion !== String(plan.baselineHead?.version ?? 0) || record.request.replacement.publicKey === intent.ownerKey || record.request.replacement.publicKey === intent.oldPublicKey || !record.request.replacement.publicKey.startsWith("ed25519:") ||
        canonical(record.request.replacement) !== canonical({ publicKey: record.request.replacement.publicKey, expiresAtNs: intent.expiresAtNs, canCheckpoint: true, canSpend: intent.canSpend }) || record.request.resume !== intent.resume || typeof plan.nextKeyringDigest !== "string" || !/^[a-f0-9]{64}$/.test(plan.nextKeyringDigest)) conflict();
    headFingerprint(plan.baselineHead); if (plan.baselineHead) assertBoundBlob(this.binding, plan.baselineHead.manifest);
    return plan;
  }
  private async materials(plan: RotationPlan): Promise<MemoryKeyring> {
    const i = plan.intent;
    const keys = decodePrivateKeyring(await readPrivateFile(i.nextKeyringFile), this.binding);
    if (sha256(encodePrivateKeyring(this.binding, keys)) !== plan.nextKeyringDigest || keys.activeEpoch !== i.oldEpoch + 1 || canonical(keys.epochs()) !== canonical([...i.oldEpochs, keys.activeEpoch]) || runtimeKey(await readPrivateFile(i.nextRuntimeFile, 200)).getPublicKey().toString() !== plan.request.replacement.publicKey) throw new MemoryError("INTEGRITY_FAILED", "Prepared key material differs from the owner plan");
    const bundle = await readPrivateFile(i.bundleFile);
    if (sha256(bundle) !== plan.request.recoveryCommitment) throw new MemoryError("INTEGRITY_FAILED", "Verified owner backup was replaced");
    verifyOwnerBackup(bundle, Buffer.from(await readPrivateFile(i.secretFile)).toString().trim(), this.binding, keys);
    return keys;
  }
  private state(plan: RotationPlan, snapshot: RotationSnapshot): void {
    this.owner(snapshot, plan.intent);
    if (!snapshot.rotation || canonical(snapshot.rotation.request) !== canonical(plan.request) || snapshot.rotation.nextEpoch !== String(plan.intent.oldEpoch + 1) || snapshot.rotation.beginGeneration !== String(BigInt(plan.intent.generation) + 1n) || snapshot.keyEpoch !== plan.intent.oldEpoch + 1 ||
        snapshot.delegates.length !== 1 || canonical(snapshot.delegates[0]) !== canonical(plan.request.replacement) || snapshot.generation !== String(BigInt(plan.intent.generation) + (snapshot.rotation.completed ? 2n : 1n)) ||
        snapshot.paused !== (snapshot.rotation.completed ? !plan.request.resume : true)) conflict();
    if (!snapshot.rotation.completed && headFingerprint(snapshot.head) !== headFingerprint(plan.baselineHead)) conflict("Memory advanced while the planned rotation should be paused");
  }
  private async barriers(plan: RotationPlan, allowActivated: boolean): Promise<void> {
    const i = plan.intent; const journal = this.memoryJournal(i);
    try {
      const control = journal.controls();
      if (control.heldBy !== i.operationId && !(allowActivated && control.heldBy === null && control.lastRotation === i.operationId && control.minimumEpoch === i.oldEpoch + 1)) throw new MemoryError("INTEGRITY_FAILED", "Original memory rotation barrier is missing");
    } finally { journal.close(); }
    if (await this.signer.journalIdentity(false) !== i.signerJournalIdentity) throw new MemoryError("INTEGRITY_FAILED", "Original signer journal was replaced");
    await this.signer.rotationBarrier(i.operationId, i.signerJournalIdentity);
  }
  private async hasVerification(plan: RotationPlan): Promise<boolean> {
    const bytes = await optional(resolve(plan.intent.stateDir, "verified.json")); if (!bytes) return false;
    const value = parse(bytes);
    if (!isObject(value) || value.status !== "verified" || value.operationId !== plan.intent.operationId || value.nextEpoch !== plan.intent.oldEpoch + 1 || !Number.isSafeInteger(value.version) || Number(value.version) <= (plan.baselineHead?.version ?? 0) || typeof value.checkpoint !== "string" || !/^[a-f0-9]{64}$/.test(value.checkpoint) || !Number.isSafeInteger(value.recoveredRecords) || !Number.isSafeInteger(value.historicalRecords)) throw new MemoryError("INTEGRITY_FAILED", "Rotation verification receipt is invalid");
    return true;
  }
  private async observed(plan: RotationPlan, stage: "begin" | "remove-old-key" | "install-new-key" | "finish", snapshot: RotationSnapshot): Promise<void> {
    const path = resolve(plan.intent.stateDir, `observed-${stage}.json`);
    const requestDigest = sha256(Buffer.from(canonical(this.wallet(plan, stage))));
    const previous = await optional(path);
    if (previous) {
      const value = parse(previous);
      if (!isObject(value) || value.operationId !== plan.intent.operationId || value.stage !== stage || value.requestDigest !== requestDigest || value.status !== "finalized-state-observed" || typeof value.blockHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.blockHash)) throw new MemoryError("INTEGRITY_FAILED", "Rotation observation receipt is invalid");
      return;
    }
    await saveImmutable(path, { operationId: plan.intent.operationId, stage, requestDigest, status: "finalized-state-observed", blockHash: snapshot.blockHash, generation: snapshot.generation, keyEpoch: snapshot.keyEpoch });
  }
  private wallet(plan: RotationPlan, stage: "begin" | "remove-old-key" | "install-new-key" | "finish"): OwnerWalletRequest {
    const i = plan.intent;
    const base = { schemaVersion: 1 as const, id: `${i.operationId}:${stage}`, kind: "OWNER_WALLET_REQUEST" as const, network: { kind: this.config.kind, chainId: this.config.chainId }, signerId: this.config.signerId, ownerPublicKey: i.ownerKey };
    if (stage === "remove-old-key") return { ...base, receiverId: this.config.signerId, actions: [{ type: "DeleteKey", params: { publicKey: i.oldPublicKey } }] };
    if (stage === "install-new-key") return { ...base, receiverId: this.config.signerId, actions: [{ type: "AddKey", params: { publicKey: plan.request.replacement.publicKey, accessKey: { nonce: 0, permission: { receiverId: this.config.contractId, methodNames: replacementMethods(plan.request.replacement), allowance: i.gasAllowance } } } }] };
    return { ...base, receiverId: this.config.contractId, actions: [{ type: "FunctionCall", params: { methodName: stage === "begin" ? "begin_runtime_rotation" : "finish_runtime_rotation", args: stage === "begin" ? { request: structuredClone(plan.request) } : { agent_id: this.binding.agentId, operation_id: i.operationId }, gas: "100000000000000", deposit: "0" } }] };
  }
  async next(directory: string): Promise<RotationNext> {
    const plan = await this.load(directory); const i = plan.intent;
    if (await exists(resolve(i.stateDir, "aborted.json"))) { await this.abort(directory); return { status: "aborted", nextEpoch: i.oldEpoch + 1, nextRuntimePublicKey: plan.request.replacement.publicKey, memoryVerificationRequired: false }; }
    await this.materials(plan);
    const snapshot = await this.reader.read(i.operationId); this.owner(snapshot, i);
    let stage: "begin" | "remove-old-key" | "install-new-key" | "finish";
    if (!snapshot.rotation) {
      if (snapshot.keyEpoch !== i.oldEpoch || snapshot.generation !== i.generation || headFingerprint(snapshot.head) !== headFingerprint(plan.baselineHead) || snapshot.delegates.length !== 1 || snapshot.delegates[0]?.publicKey !== i.oldPublicKey || snapshot.accessKeys.some((k) => k.publicKey === plan.request.replacement.publicKey) || BigInt(i.expiresAtNs) <= BigInt(snapshot.timestampNs)) conflict();
      this.barrier(i); await this.barriers(plan, false); stage = "begin";
    } else {
      this.state(plan, snapshot);
      await this.barriers(plan, snapshot.rotation.completed);
      await this.observed(plan, "begin", snapshot);
      const old = snapshot.accessKeys.find((k) => k.publicKey === i.oldPublicKey);
      const replacement = snapshot.accessKeys.find((k) => k.publicKey === plan.request.replacement.publicKey);
      if (snapshot.rotation.completed) {
        if (old || !replacement) conflict("Account key cleanup is incomplete");
        replacementAccess(replacement, this.config, plan.request.replacement, i.gasAllowance, false);
        await this.observed(plan, "remove-old-key", snapshot); await this.observed(plan, "install-new-key", snapshot); await this.observed(plan, "finish", snapshot);
        this.barrier(i, true, true);
        return { status: "authority-complete", nextEpoch: i.oldEpoch + 1, nextRuntimePublicKey: plan.request.replacement.publicKey, memoryVerificationRequired: !await this.hasVerification(plan) };
      }
      if (BigInt(i.expiresAtNs) <= BigInt(snapshot.timestampNs)) throw new ProviderError("AUTHORIZATION_FAILED", "Replacement grant expired; rotation remains paused for owner review");
      if (old) stage = "remove-old-key";
      else {
        await this.observed(plan, "remove-old-key", snapshot);
        if (!replacement) stage = "install-new-key";
        else { replacementAccess(replacement, this.config, plan.request.replacement, i.gasAllowance, true); await this.observed(plan, "install-new-key", snapshot); stage = "finish"; }
      }
    }
    const request = this.wallet(plan, stage);
    const journal = this.memoryJournal(i); const lease = journal.acquire(30_000);
    try { journal.issueRotationRequest(lease, i.operationId, stage, sha256(Buffer.from(canonical(request)))); }
    finally { journal.release(lease); journal.close(); }
    await saveImmutable(resolve(i.stateDir, `wallet-${stage}.json`), request); // Durable before the owner can sign it.
    return { status: "awaiting-owner-wallet", stage, request };
  }
  async abort(directory: string): Promise<void> {
    const absolute = resolve(directory); const intent = this.intent(parse(await readPrivateFile(resolve(absolute, "intent.json"))), absolute);
    for (const stage of ["begin", "remove-old-key", "install-new-key", "finish"]) if (await exists(resolve(absolute, `wallet-${stage}.json`))) throw new MemoryError("WRITE_PENDING", "An owner request was issued; reconcile it rather than aborting");
    const snapshot = await this.reader.read(intent.operationId); this.owner(snapshot, intent);
    if (snapshot.rotation || snapshot.keyEpoch !== intent.oldEpoch || snapshot.generation !== intent.generation) conflict();
    const journal = this.memoryJournal(intent); const lease = journal.acquire(30_000);
    try { journal.abortRotation(lease, intent.operationId); } // Atomic with issuance, before any asynchronous cleanup/export.
    finally { journal.release(lease); journal.close(); }
    await saveImmutable(resolve(absolute, "aborted.json"), { operationId: intent.operationId, status: "aborted-before-owner-request" });
    await this.signer.rotationBarrier(intent.operationId, intent.signerJournalIdentity, true);
  }
  async verify(directory: string): Promise<{ status: "verified"; version: number; recoveredRecords: number; historicalRecords: number; nextEpoch: number }> {
    const plan = await this.load(directory); const i = plan.intent;
    if (await exists(resolve(i.stateDir, "aborted.json"))) conflict();
    const keys = await this.materials(plan);
    await this.barriers(plan, true);
    const before = await this.reader.read(i.operationId); this.state(plan, before);
    if (!before.rotation?.completed || !before.head || before.head.keyEpoch !== i.oldEpoch + 1 || before.head.version <= (plan.baselineHead?.version ?? 0) || before.accessKeys.some((k) => k.publicKey === i.oldPublicKey)) throw new MemoryError("WRITE_PENDING", "A new-epoch committed checkpoint and account key cleanup are required before verification");
    const replacement = before.accessKeys.find((k) => k.publicKey === plan.request.replacement.publicKey);
    if (!replacement) conflict(); replacementAccess(replacement, this.config, plan.request.replacement, i.gasAllowance, false);
    const [baseline, current] = await Promise.all([this.service(keys, plan.baselineHead).recoverSnapshot(), this.service(keys, before.head).recoverSnapshot()]);
    const byId = new Map(current.records.map((r) => [r.id, r]));
    for (const record of baseline.records) if (sha256(Buffer.from(JSON.stringify(byId.get(record.id) ?? null))) !== sha256(Buffer.from(JSON.stringify(record)))) throw new MemoryError("INTEGRITY_FAILED", "Rotation did not preserve historical memory records");
    const after = await this.reader.read(i.operationId); this.state(plan, after);
    if (headFingerprint(after.head) !== headFingerprint(before.head)) throw new MemoryError("CHECKPOINT_CONFLICT", "Memory advanced during rotation verification");
    const result = { status: "verified" as const, version: before.head.version, recoveredRecords: current.records.length, historicalRecords: baseline.records.length, nextEpoch: i.oldEpoch + 1 };
    // A bounded receipt stores only public checkpoint evidence and counts.
    const receipt = { ...result, operationId: i.operationId, checkpoint: headFingerprint(before.head) };
    if (!await this.hasVerification(plan)) await saveImmutable(resolve(i.stateDir, "verified.json"), receipt);
    this.barrier(i, true, true);
    return result;
  }
  nextRuntimeConfig(plan: RotationPlan): NearSignerConfig {
    return { ...this.config, publicKey: plan.request.replacement.publicKey, runtimeKeyFile: plan.intent.nextRuntimeFile, journalFile: plan.intent.nextNearJournal };
  }
}
