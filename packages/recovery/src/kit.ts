import { randomBytes, randomUUID } from "node:crypto";
import { decryptCommission, encryptCommission, validateRecipientKeys, type RecipientKeys } from "../../commerce/src/encryption.js";
import { matchingJob, type CommissionJob } from "../../commerce/src/chain.js";
import { validateDelivery, validateDossier, validateQuote, validateTask, verifySigned } from "../../commerce/src/protocol.js";
import type { CommissionBrief, CommissionRecord, CommissionTask, JobRequest, SpecialistDelivery, SpecialistMessage, SpecialistQuote } from "../../commerce/src/types.js";
import { open, seal, sha256 } from "../../crypto/src/envelope.js";
import { decodePrivateKeyring, encodePrivateKeyring } from "../../memory/src/backup.js";
import { assertBinding, type MemoryBinding } from "../../memory/src/binding.js";
import { headFingerprint } from "../../memory/src/index.js";
import type { MemoryKeyring } from "../../memory/src/keyring.js";
import { MemoryService, type MemorySnapshot } from "../../memory/src/service.js";
import { readOnlyHeads } from "../../memory/src/recovery.js";
import { accountId, canonical, decimal, encodeHead, hash, publicKey, transactionHash, validateCall, validateIdentity } from "../../near/src/protocol.js";
import { isObject, MemoryError, sameBlob, type BlobStore, type MemoryHead } from "../../protocol/src/memory.js";
import { validateBrief } from "../../runtime/src/journal.js";
import type { MissionArtifact, MissionScope } from "../../runtime/src/types.js";

export const MAX_KIT_BYTES = 1_000_000;
const MAX_PAYLOAD_BYTES = 450_000, PREFIX = "persistara-kit-v1:";
const invalid = () => new MemoryError("INVALID_BACKUP", "Recovery kit is malformed, oversized or incomplete");
const integrity = () => new MemoryError("INTEGRITY_FAILED", "Recovery kit or public authority differs from its independently pinned identity");
export interface KitCommission { task: CommissionTask; brief: CommissionBrief; quote: SpecialistMessage<SpecialistQuote>; delivery: SpecialistMessage<SpecialistDelivery>; request: JobRequest }
export interface KitHeader {
  schemaVersion: 1; format: "persistara-owner-recovery-kit"; id: string; scope: MissionScope; ownerKey: string;
  binding: MemoryBinding; checkpoint: MemoryHead | null; createdAt: number; activeEpoch: number;
}
interface Payload { schemaVersion: 1; memoryKeyring: string; recipient: RecipientKeys | null; commissions: KitCommission[] }
export interface OpenKit { header: KitHeader; keys: MemoryKeyring; recipient: RecipientKeys | null; commissions: KitCommission[]; digest: string }
export interface RecoveryObservation { scope: MissionScope; ownerKey: string; head: MemoryHead | null; keyEpoch: number; timestampNs: string; blockHash: string }
export interface RecoveryReads { observe(): Promise<RecoveryObservation>; job(id: string): Promise<CommissionJob | null>; blobs: Pick<BlobStore, "get"> }

function exact(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).sort().join(",") !== names.sort().join(",")) throw invalid();
}
function decode(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximum * 4 / 3)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.length || bytes.length > maximum || bytes.toString("base64url") !== value) throw invalid(); return bytes;
}
function secretKey(secret: string): Uint8Array {
  if (typeof secret !== "string" || !secret.startsWith(PREFIX)) throw invalid();
  const bytes = decode(secret.slice(PREFIX.length), 32); if (bytes.length !== 32) throw invalid(); return bytes;
}
function parse(bytes: Uint8Array, maximum: number): unknown {
  if (!bytes.length || bytes.length > maximum) throw invalid();
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
}
function validateHeader(input: unknown): asserts input is KitHeader {
  exact(input, ["schemaVersion", "format", "id", "scope", "ownerKey", "binding", "checkpoint", "createdAt", "activeEpoch"]);
  if (input.schemaVersion !== 1 || input.format !== "persistara-owner-recovery-kit" || typeof input.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.id) ||
    !Number.isSafeInteger(input.createdAt) || Number(input.createdAt) < 1 || !Number.isSafeInteger(input.activeEpoch) || Number(input.activeEpoch) < 1 || !publicKey(input.ownerKey) || !input.ownerKey.startsWith("ed25519:")) throw invalid();
  exact(input.scope, ["owner", "agentId", "contractId", "chainId", "codeHash"]); assertBinding(input.binding);
  const s = input.scope;
  if (!accountId(s.owner) || !transactionHash(s.codeHash) || s.agentId !== input.binding.agentId || s.contractId !== input.binding.contractId || s.chainId !== input.binding.chainId || input.binding.authorityNetwork === "fixture:local") throw invalid();
  validateIdentity({ signerId: s.owner, publicKey: input.ownerKey, agentId: s.agentId } as Parameters<typeof validateIdentity>[0]);
  if (input.checkpoint !== null) {
    exact(input.checkpoint, ["version", "keyEpoch", "manifest"]); encodeHead(input.checkpoint as unknown as MemoryHead);
    if ((input.checkpoint.manifest as MemoryHead["manifest"]).network !== input.binding.storageNetwork || Number(input.checkpoint.keyEpoch) > Number(input.activeEpoch)) throw invalid();
  }
}
function context(header: KitHeader) { return { agentId: header.scope.agentId, recordId: `kit:${header.id}:${hash(canonical(header))}`, keyEpoch: header.activeEpoch, purpose: "recovery" as const }; }
async function validateCommission(input: unknown, header: KitHeader, keys: RecipientKeys | null): Promise<KitCommission> {
  exact(input, ["task", "brief", "quote", "delivery", "request"]);
  validateTask(input.task, header.scope);
  const task = input.task;
  exact(input.brief, ["schemaVersion", "title", "objective", "criteria", "sources"]);
  if (input.brief.schemaVersion !== 1 || !Array.isArray(input.brief.sources) || !keys || canonical(task.ownerRecipientKey) !== canonical(keys.publicKey) || hash(canonical(input.brief)) !== task.briefDigest) throw invalid();
  const brief = input.brief as unknown as CommissionBrief;
  validateBrief({ requestId: task.missionId.slice(8), title: brief.title, objective: brief.objective, criteria: brief.criteria, sources: brief.sources }, brief.sources.map(url => new URL(url).origin));
  if (task.criteriaHash !== hash(canonical({ objective: brief.objective, criteria: brief.criteria, sources: brief.sources }))) throw invalid();
  const quote = await verifySigned<SpecialistQuote>(input.quote, "quote", header.scope, task.worker, task.workerSigningKey, task.quoteNonce);
  validateQuote(quote.payload, task, String(BigInt(header.createdAt) * 1_000_000n), false);
  const delivery = await verifySigned<SpecialistDelivery>(input.delivery, "delivery", header.scope, task.worker, task.workerSigningKey, task.deliveryNonce);
  validateDelivery(delivery.payload, task, quote, String(BigInt(header.createdAt) * 1_000_000n));
  validateCall({ method: "create_job", args: { request: input.request } }, { signerId: header.scope.owner, publicKey: header.ownerKey, agentId: header.scope.agentId });
  const request = input.request as unknown as JobRequest, q = quote.payload;
  if (request.operationId !== task.id || request.worker !== task.worker || request.amount !== q.amountYoctoNear || request.criteriaHash !== task.criteriaHash || !sameBlob(request.brief, task.brief) || request.quoteExpiresAtNs !== q.expiresAtNs || request.deliveryDeadlineNs !== q.deliveryDeadlineNs || request.reviewWindowNs !== q.reviewWindowNs) throw invalid();
  return { task, brief, quote, delivery, request };
}
async function validatePayload(input: unknown, header: KitHeader): Promise<Omit<OpenKit, "header" | "digest">> {
  exact(input, ["schemaVersion", "memoryKeyring", "recipient", "commissions"]);
  if (input.schemaVersion !== 1 || !Array.isArray(input.commissions) || input.commissions.length > 250) throw invalid();
  const keys = decodePrivateKeyring(decode(input.memoryKeyring, 32_768), header.binding);
  if (keys.activeEpoch !== header.activeEpoch) throw invalid();
  const recipient = input.recipient === null ? null : await validateRecipientKeys(input.recipient);
  if (recipient) {
    const ctx = { scope: header.scope, commissionId: `commission:${header.id}`, missionId: `mission:${header.id}`, purpose: "artifact" as const }, probe = { challenge: randomBytes(32).toString("base64url") };
    const opened = await decryptCommission(await encryptCommission(probe, recipient.publicKey, ctx), recipient, ctx);
    if (canonical(opened) !== canonical(probe)) throw invalid();
  }
  const commissions: KitCommission[] = [], ids = new Set<string>();
  for (const inputCommission of input.commissions) {
    const c = await validateCommission(inputCommission, header, recipient);
    if (ids.has(c.task.id)) throw invalid(); ids.add(c.task.id); commissions.push(c);
  }
  return { keys, recipient, commissions };
}
export function recoveryCommission(record: CommissionRecord): KitCommission | null {
  if (!record.delivery && !record.artifact) return null;
  if (!record.task || !record.quote || !record.delivery || !record.request || !record.artifact || hash(canonical(record.artifact)) !== record.delivery.payload.artifactDigest) throw invalid();
  return structuredClone({ task: record.task, brief: record.brief, quote: record.quote, delivery: record.delivery, request: record.request });
}
export async function createRecoveryKit(input: { scope: MissionScope; ownerKey: string; binding: MemoryBinding; checkpoint: MemoryHead | null; keys: MemoryKeyring; recipient: RecipientKeys | null; commissions: KitCommission[]; now?: number }) {
  const header: KitHeader = { schemaVersion: 1, format: "persistara-owner-recovery-kit", id: randomUUID(), scope: structuredClone(input.scope), ownerKey: input.ownerKey, binding: structuredClone(input.binding), checkpoint: structuredClone(input.checkpoint), createdAt: input.now ?? Date.now(), activeEpoch: input.keys.activeEpoch };
  validateHeader(header);
  const payload: Payload = { schemaVersion: 1, memoryKeyring: Buffer.from(encodePrivateKeyring(input.binding, input.keys)).toString("base64url"), recipient: input.recipient, commissions: input.commissions };
  const plain = Buffer.from(JSON.stringify(payload)); if (plain.length > MAX_PAYLOAD_BYTES) throw invalid();
  await validatePayload(payload, header);
  const secret = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  const bundle = Buffer.from(JSON.stringify({ header, wrapped: Buffer.from(seal(plain, secretKey(secret), context(header))).toString("base64url") }));
  if (bundle.length > MAX_KIT_BYTES) throw invalid();
  const digest = sha256(bundle);
  return { bundle, secret, digest, header };
}
export async function openRecoveryKit(bundle: Uint8Array, secret: string, expectedDigest: string): Promise<OpenKit> {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || sha256(bundle) !== expectedDigest) throw integrity();
  const value = parse(bundle, MAX_KIT_BYTES); exact(value, ["header", "wrapped"]); validateHeader(value.header);
  const plain = open(decode(value.wrapped, 750_000), secretKey(secret), context(value.header));
  const payload = await validatePayload(parse(plain, MAX_PAYLOAD_BYTES), value.header);
  return { header: value.header, digest: expectedDigest, ...payload };
}
function authorized(kit: OpenKit, observation: RecoveryObservation) {
  if (canonical(observation.scope) !== canonical(kit.header.scope) || observation.ownerKey !== kit.header.ownerKey || !transactionHash(observation.blockHash) || !decimal(observation.timestampNs, 64, true) || !Number.isSafeInteger(observation.keyEpoch) || observation.keyEpoch < kit.header.activeEpoch) throw integrity();
  const captured = kit.header.checkpoint, current = observation.head;
  if (captured && (!current || current.version < captured.version || (current.version === captured.version && headFingerprint(current) !== headFingerprint(captured)))) throw integrity();
}
/** Read-only recovery: authenticate every record/delivery before publishing any replacement state. */
export async function recoverKit(kit: OpenKit, reads: RecoveryReads): Promise<{ snapshot: MemorySnapshot; deliveries: { id: string; digest: string; artifact: MissionArtifact; status: CommissionJob["status"]; payoutAttempt: string }[]; observation: RecoveryObservation }> {
  const initial = await reads.observe(); authorized(kit, initial);
  const blobs: BlobStore = { get: ref => reads.blobs.get(ref), put: async () => { throw new MemoryError("INVALID_INPUT", "Kit recovery cannot upload"); } };
  const heads = readOnlyHeads({ get: async id => { if (id !== kit.header.scope.agentId) throw integrity(); return initial.head; } });
  const memory = new MemoryService(kit.header.scope.agentId, kit.keys, kit.keys.activeEpoch, blobs, heads, { binding: kit.header.binding });
  const snapshot = await memory.recoverSnapshot();
  const deliveries = [];
  for (const c of kit.commissions) {
    const job = await reads.job(c.task.id); if (!job?.result || !sameBlob(job.result, c.delivery.payload.result) || job.status === "funded") throw integrity(); matchingJob(job, c.request);
    const bytes = await reads.blobs.get(job.result);
    if (bytes.length !== job.result.byteLength || sha256(bytes) !== job.result.ciphertextSha256 || !kit.recipient) throw integrity();
    const artifact = await decryptCommission(new TextDecoder("utf-8", { fatal: true }).decode(bytes), kit.recipient, { scope: kit.header.scope, commissionId: c.task.id, missionId: c.task.missionId, purpose: "artifact" });
    validateDossier(artifact, c.task, c.brief);
    const digest = hash(canonical(artifact)); if (digest !== c.delivery.payload.artifactDigest) throw integrity();
    deliveries.push({ id: c.task.id, digest, artifact, status: job.status, payoutAttempt: job.payoutAttempt });
  }
  const final = await reads.observe(); authorized(kit, final);
  if (headFingerprint(final.head) !== headFingerprint(initial.head)) throw new MemoryError("CHECKPOINT_CONFLICT", "Memory head advanced during kit recovery");
  return { snapshot, deliveries, observation: final };
}
