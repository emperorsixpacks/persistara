/** Public, key-free mission projections shared with the console. */
export type MissionState = "queued" | "running" | "interrupted" | "blocked" | "awaiting_review" | "completed" | "canceled";
export interface MissionBrief { requestId: string; title: string; objective: string; criteria: string; sources: string[] }
export interface MissionScope { owner: string; agentId: string; contractId: string; chainId: string; codeHash: string }
export interface MissionAuthority extends MissionScope { publicKey: string; generation: string; keyEpoch: number; blockHash: string }
export interface Mission {
  id: string; brief: MissionBrief; state: MissionState; version: number; createdAt: number; updatedAt: number;
  authority: MissionAuthority; budget: { network: "near:testnet"; asset: "NEAR"; maximum: "0"; spent: "0" };
  sourceCount: number; capturedCount: number; failureCode: string | null;
}
export interface SourceCapture {
  url: string; title: string; excerpt: string; contentSha256: string; byteLength: number; capturedAt: number;
  contentType: "text/html" | "text/plain"; truncated: boolean; untrusted: true;
}
export interface MissionSource {
  operationId: string; requestDigest: string; ordinal: number; url: string;
  state: "queued" | "fetching" | "captured" | "failed" | "interrupted" | "canceled";
  attempts: number; capture: SourceCapture | null; failureCode: string | null;
}
export interface MissionEvent { cursor: number; missionId: string; at: number; kind: string; operationId: string | null }
export interface MissionArtifact {
  schemaVersion: 1; kind: "source-dossier"; missionId: string; title: string; objective: string; criteria: string;
  createdAt: number; sources: SourceCapture[]; inference: "not_used"; storage: "local_private_journal"; quality: "owner_review_required";
}
export interface MissionDetail { mission: Mission; sources: MissionSource[]; events: MissionEvent[]; artifact: { digest: string; value: MissionArtifact } | null }
export interface MissionCapabilities { mode: "source-dossier"; inference: false; maximumSources: 6; allowedOrigins: string[]; spendingEnabled: false }
export interface MissionLease { missionId: string; holder: string; fence: number }
