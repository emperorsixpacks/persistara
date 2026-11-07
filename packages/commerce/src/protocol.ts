import { verifyMessage } from "near-api-js/nep413";
import { accountId, canonical, decimal, hash, publicKey, validateBlob } from "../../near/src/protocol.js";
import { isObject, sameBlob } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { missionId, validateCapture } from "../../runtime/src/journal.js";
import type { MissionArtifact, MissionScope } from "../../runtime/src/types.js";
import { recipientKey } from "./encryption.js";
import type { CommissionBrief, CommissionTask, SpecialistDelivery, SpecialistMessage, SpecialistProfile, SpecialistQuote } from "./types.js";

const denied = () => new ProviderError("VERIFICATION_FAILED", "Specialist message, scope, amount or signature does not match");
function fields(value: Record<string, unknown>, names: string[]) { if (Object.keys(value).sort().join(",") !== [...names].sort().join(",")) throw denied(); }
const HOUR = 3_600_000_000_000n, DAY = 24n * HOUR;
export const commissionId = (v: unknown): v is string => typeof v === "string" && /^commission:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const recipient = (scope: MissionScope) => `persistara-specialist:v1:${scope.chainId}:${scope.contractId}:${scope.agentId}`;
export const commerceNetwork = (scope: MissionScope) => scope.chainId === "testnet" ? "near:testnet" as const : "near:sandbox" as const;
export const message = (kind: SpecialistMessage<unknown>["kind"], payload: unknown) => canonical({ domain: "persistara-specialist", schemaVersion: 1, kind, payload });
export const signedDigest = (signed: SpecialistMessage<unknown>) => hash(canonical(signed));
export const nonce = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, "base64url").length === 32 && Buffer.from(v, "base64url").toString("base64url") === v;
export function validateScope(value: unknown, expected: MissionScope) { if (canonical(value) !== canonical(expected)) throw denied(); }

/** Cryptographic verification against an independently configured/pinned key. Live key permission is checked by the caller. */
export async function verifySigned<T>(input: unknown, kind: SpecialistMessage<T>["kind"], scope: MissionScope, account: string, key: string, expectedNonce?: string): Promise<SpecialistMessage<T>> {
  if (!isObject(input)) throw denied(); fields(input, ["schemaVersion", "kind", "payload", "nonce", "recipient", "proof"]);
  if (input.schemaVersion !== 1 || input.kind !== kind || input.recipient !== recipient(scope) || !nonce(input.nonce) || (expectedNonce !== undefined && input.nonce !== expectedNonce) ||
      !isObject(input.payload) || !isObject(input.proof) || canonical(input.payload).length > 24_000) throw denied();
  fields(input.proof, ["accountId", "publicKey", "signature"]);
  if (input.proof.accountId !== account || input.proof.publicKey !== key || typeof input.proof.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(input.proof.signature)) throw denied();
  const signature = Buffer.from(input.proof.signature, "base64"); if (signature.length !== 64 || signature.toString("base64") !== input.proof.signature) throw denied();
  const provider = { viewAccessKey: async () => ({ nonce: 0, permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
  try { await verifyMessage({ signerAccountId: account, signerPublicKey: key, signature, payload: { message: message(kind, input.payload), nonce: Buffer.from(input.nonce, "base64url"), recipient: input.recipient }, provider }); }
  catch { throw denied(); }
  return structuredClone(input) as unknown as SpecialistMessage<T>;
}
export function validateProfile(p: unknown, scope: MissionScope, nowNs: string): asserts p is SpecialistProfile {
  if (!isObject(p)) throw denied(); fields(p, ["schemaVersion", "scope", "accountId", "signingPublicKey", "encryptionPublicKey", "name", "amountYoctoNear", "expiresAtNs"]);
  if (p.schemaVersion !== 1 || !accountId(p.accountId) || p.accountId === scope.owner || !publicKey(p.signingPublicKey) || !p.signingPublicKey.startsWith("ed25519:") ||
    typeof p.name !== "string" || p.name.length < 1 || p.name.length > 80 || !decimal(p.amountYoctoNear, 128, true) || !decimal(p.expiresAtNs, 64, true) || !decimal(nowNs, 64, true) ||
    BigInt(p.expiresAtNs) <= BigInt(nowNs) || BigInt(p.expiresAtNs) > BigInt(nowNs) + 31n * DAY) throw denied();
  validateScope(p.scope, scope); recipientKey(p.encryptionPublicKey);
}
export function validateTask(t: unknown, scope: MissionScope): asserts t is CommissionTask {
  if (!isObject(t)) throw denied(); fields(t, ["schemaVersion", "id", "missionId", "scope", "worker", "workerSigningKey", "workerEncryptionKey", "ownerRecipientKey", "briefDigest", "criteriaHash", "maximumYoctoNear", "quoteNonce", "deliveryNonce", "createdAtNs", "brief", "encryptedBrief"]);
  if (t.schemaVersion !== 1 || !commissionId(t.id) || !missionId(t.missionId) || t.id !== t.missionId.replace("mission:", "commission:") || !accountId(t.worker) || t.worker === scope.owner ||
    !publicKey(t.workerSigningKey) || !t.workerSigningKey.startsWith("ed25519:") || !nonce(t.quoteNonce) || !nonce(t.deliveryNonce) || t.quoteNonce === t.deliveryNonce ||
    typeof t.briefDigest !== "string" || !/^[a-f0-9]{64}$/.test(t.briefDigest) || typeof t.criteriaHash !== "string" || !/^[a-f0-9]{64}$/.test(t.criteriaHash) ||
    !decimal(t.maximumYoctoNear, 128, true) || !decimal(t.createdAtNs, 64, true) || typeof t.encryptedBrief !== "string" || t.encryptedBrief.length > 32_000) throw denied();
  validateScope(t.scope, scope); recipientKey(t.workerEncryptionKey); recipientKey(t.ownerRecipientKey); validateBlob(t.brief);
  if (t.brief.byteLength !== Buffer.byteLength(t.encryptedBrief) || t.brief.ciphertextSha256 !== hash(t.encryptedBrief)) throw denied();
}
export function validateQuote(q: unknown, task: CommissionTask, nowNs: string, checkExpiry = true): asserts q is SpecialistQuote {
  if (!isObject(q)) throw denied(); fields(q, ["schemaVersion", "commissionId", "missionId", "taskDigest", "scope", "worker", "amountYoctoNear", "asset", "network", "criteriaHash", "brief", "issuedAtNs", "expiresAtNs", "deliveryDeadlineNs", "reviewWindowNs", "sequence"]);
  if (q.schemaVersion !== 1 || q.sequence !== 1 || q.commissionId !== task.id || q.missionId !== task.missionId || q.taskDigest !== hash(canonical(task)) || q.worker !== task.worker ||
    q.asset !== "NEAR" || q.network !== commerceNetwork(task.scope) || q.criteriaHash !== task.criteriaHash || !decimal(q.amountYoctoNear, 128, true) || BigInt(q.amountYoctoNear) > BigInt(task.maximumYoctoNear) ||
    !decimal(q.issuedAtNs, 64, true) || !decimal(q.expiresAtNs, 64, true) || !decimal(q.deliveryDeadlineNs, 64, true) || !decimal(q.reviewWindowNs, 64, true)) throw denied();
  validateScope(q.scope, task.scope); validateBlob(q.brief);
  if (!sameBlob(q.brief, task.brief) || BigInt(q.expiresAtNs) <= BigInt(q.issuedAtNs) || BigInt(q.expiresAtNs) > BigInt(q.issuedAtNs) + HOUR ||
    BigInt(q.deliveryDeadlineNs) < BigInt(q.expiresAtNs) || BigInt(q.deliveryDeadlineNs) > BigInt(q.issuedAtNs) + 7n * DAY || BigInt(q.reviewWindowNs) < HOUR || BigInt(q.reviewWindowNs) > 7n * DAY ||
    (checkExpiry && (BigInt(q.issuedAtNs) > BigInt(nowNs) + 60_000_000_000n || BigInt(q.expiresAtNs) <= BigInt(nowNs)))) throw denied();
}
export function validateDelivery(d: unknown, task: CommissionTask, quote: SpecialistMessage<SpecialistQuote>, nowNs: string): asserts d is SpecialistDelivery {
  if (!isObject(d)) throw denied(); fields(d, ["schemaVersion", "commissionId", "missionId", "taskDigest", "quoteDigest", "scope", "worker", "artifactDigest", "result", "issuedAtNs", "sequence"]);
  if (d.schemaVersion !== 1 || d.sequence !== 2 || d.commissionId !== task.id || d.missionId !== task.missionId || d.taskDigest !== hash(canonical(task)) || d.quoteDigest !== signedDigest(quote) ||
    d.worker !== task.worker || typeof d.artifactDigest !== "string" || !/^[a-f0-9]{64}$/.test(d.artifactDigest) || !decimal(d.issuedAtNs, 64, true) ||
    BigInt(d.issuedAtNs) < BigInt(quote.payload.issuedAtNs) || BigInt(d.issuedAtNs) > BigInt(nowNs) + 60_000_000_000n) throw denied();
  validateScope(d.scope, task.scope); validateBlob(d.result);
}
export function validateDossier(value: unknown, task: CommissionTask, brief: CommissionBrief): asserts value is MissionArtifact {
  if (!isObject(value)) throw denied(); fields(value, ["schemaVersion", "kind", "missionId", "title", "objective", "criteria", "createdAt", "sources", "inference", "storage", "quality"]);
  if (value.schemaVersion !== 1 || value.kind !== "source-dossier" || value.missionId !== task.missionId || value.title !== brief.title || value.objective !== brief.objective || value.criteria !== brief.criteria ||
    value.inference !== "not_used" || value.storage !== "0g_encrypted_delivery" || value.quality !== "owner_review_required" || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 1 ||
    !Array.isArray(value.sources) || value.sources.length !== brief.sources.length) throw denied();
  value.sources.forEach((source, i) => validateCapture(source, brief.sources[i]!));
}
