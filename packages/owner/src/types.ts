/** Public console messages only. Never add key material, bearer tokens or filesystem paths here. */
export interface OwnerView {
  owner: string; ownerKey: string; ownerNonce: number; ownerKeyFullAccess: boolean;
  agentId: string; contractId: string; chainId: string; codeHash: string; blockHash: string; timestampNs: string;
  paused: boolean; generation: string; keyEpoch: number; checkpointVersion: number;
  balances: { available: string; reserved: string; pending: string; paid: string };
  policy: { maxJobAmount: string; dailyLimit: string } | null;
  runtimeKeys: { publicKey: string; methods: string[]; allowance: string | null; expiresAtNs: string; ready: boolean }[];
  backup: { status: "verified" | "unavailable" | "epoch_mismatch"; offDeviceVerified: false };
  localRotationHold: boolean | null; canResume: boolean;
}
export interface PauseRequest {
  schemaVersion: 1; id: string; kind: "OWNER_PAUSE_REQUEST"; network: { kind: "testnet" | "sandbox"; chainId: string };
  signerId: string; ownerPublicKey: string; agentId: string; receiverId: string;
  expectedGeneration: string; minimumNonce: number; paused: boolean;
  actions: [{ type: "FunctionCall"; params: { methodName: "set_paused"; args: { agent_id: string; paused: boolean }; gas: "100000000000000"; deposit: "0" } }];
}
export type OwnerOperationState = "prepared" | "dispatched" | "unknown" | "confirmed" | "failed" | "canceled";
export interface OwnerOperation {
  request: PauseRequest; digest: string; state: OwnerOperationState; transactionHash: string | null; failureCode: string | null; candidateHashes: string[];
}
export interface OwnerChallenge {
  id: string; message: string; recipient: string; nonce: string; expiresAt: number;
  signerId: string; publicKey: string; network: "testnet";
}
