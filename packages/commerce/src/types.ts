import type { BlobRef } from "../../protocol/src/memory.js";
import type { MissionArtifact, MissionScope } from "../../runtime/src/types.js";

export interface RecipientPublicKey { kty: "RSA"; n: string; e: "AQAB" }
export interface SpecialistProfile {
  schemaVersion: 1; scope: MissionScope; accountId: string; signingPublicKey: string; encryptionPublicKey: RecipientPublicKey;
  name: string; amountYoctoNear: string; expiresAtNs: string;
}
export interface SpecialistMessage<T> {
  schemaVersion: 1; kind: "profile" | "quote" | "delivery"; payload: T; nonce: string; recipient: string;
  proof: { accountId: string; publicKey: string; signature: string };
}
export interface CommissionTask {
  schemaVersion: 1; id: string; missionId: string; scope: MissionScope; worker: string; workerSigningKey: string;
  workerEncryptionKey: RecipientPublicKey; ownerRecipientKey: RecipientPublicKey; briefDigest: string; criteriaHash: string;
  maximumYoctoNear: string; quoteNonce: string; deliveryNonce: string; createdAtNs: string;
  brief: BlobRef; encryptedBrief: string;
}
export interface CommissionBrief { schemaVersion: 1; title: string; objective: string; criteria: string; sources: string[] }
export interface SpecialistQuote {
  schemaVersion: 1; commissionId: string; missionId: string; taskDigest: string; scope: MissionScope; worker: string;
  amountYoctoNear: string; asset: "NEAR"; network: "near:testnet" | "near:sandbox"; criteriaHash: string; brief: BlobRef;
  issuedAtNs: string; expiresAtNs: string; deliveryDeadlineNs: string; reviewWindowNs: string; sequence: 1;
}
export interface SpecialistDelivery {
  schemaVersion: 1; commissionId: string; missionId: string; taskDigest: string; quoteDigest: string; scope: MissionScope; worker: string;
  artifactDigest: string; result: BlobRef; issuedAtNs: string; sequence: 2;
}
export interface JobRequest {
  agentId: string; generation: string; policyVersion: string; operationId: string; worker: string; amount: string;
  criteriaHash: string; brief: BlobRef; quoteExpiresAtNs: string; deliveryDeadlineNs: string; reviewWindowNs: string;
}
export type CommissionState = "preparing" | "awaiting_quote" | "quoted" | "uploading_brief" | "brief_ready" | "reserving" | "funded" | "delivery_ready" | "settling" | "payout_pending" | "payout_failed" | "paid" | "disputed" | "refunded" | "failed" | "canceled";
export interface CommissionSummary {
  id: string; missionId: string; state: CommissionState; worker: string; name: string; amountYoctoNear: string;
  reviewed: boolean; deliveryVerified: boolean; failureCode: string | null;
}
export interface CommissionView extends CommissionSummary {
  version: number; task: Omit<CommissionTask, "encryptedBrief"> | null; quote: SpecialistQuote | null; quoteDigest: string | null;
  signatureVerified: boolean; delivery: SpecialistDelivery | null; artifact: MissionArtifact | null; artifactDigest: string | null;
  receipt: { reservationHash: string | null; acceptanceHash: string | null; briefUploadHash: string | null; payoutAttempt: string | null; reviewDeadlineNs: string | null; disputeDeadlineNs: string | null };
  events: { at: number; kind: string }[];
}
export interface CommissionRecord {
  id: string; missionId: string; state: CommissionState; version: number; profile: SpecialistMessage<SpecialistProfile>; brief: CommissionBrief;
  maximumYoctoNear: string; ownerKey: string; task: CommissionTask | null; quote: SpecialistMessage<SpecialistQuote> | null;
  preparation: { encryptedBrief: string; ownerRecipientKey: RecipientPublicKey; quoteNonce: string; deliveryNonce: string; createdAtNs: string };
  delivery: SpecialistMessage<SpecialistDelivery> | null; artifact: MissionArtifact | null; request: JobRequest | null;
  signerIdentity: string | null; reviewedDigest: string | null; failureCode: string | null;
  acceptanceCall: { method: "accept_job"; args: Record<string, unknown> } | null;
  receipt: CommissionView["receipt"]; events: CommissionView["events"];
}
