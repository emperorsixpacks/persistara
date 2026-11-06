/** Provider-native roots and ciphertext digests are intentionally distinct. */
export interface BlobRef {
  provider: "local" | "0g";
  network: string;
  objectId: string;
  ciphertextSha256: string;
  byteLength: number;
}

export interface BlobStore {
  put(bytes: Uint8Array): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Uint8Array>;
}

export interface MemoryHead {
  version: number;
  keyEpoch: number;
  manifest: BlobRef;
}

/** A live implementation must enforce authority, CAS, and chain finality. */
export interface MemoryHeadStore {
  get(agentId: string): Promise<MemoryHead | null>;
  compareAndSwap(agentId: string, expectedVersion: number, next: MemoryHead): Promise<boolean>;
}

export interface MemorySource {
  kind: "owner" | "artifact" | "tool";
  reference: string;
}

export interface MemoryRecord {
  schemaVersion: 1;
  id: string;
  agentId: string;
  operationId: string;
  createdAt: string;
  text: string;
  source: MemorySource;
  supersedes?: string;
}

export type FailureCode =
  | "INVALID_INPUT"
  | "INVALID_ENVELOPE"
  | "AUTHENTICATION_FAILED"
  | "INTEGRITY_FAILED"
  | "INVALID_MANIFEST"
  | "OPERATION_CONFLICT"
  | "CHECKPOINT_CONFLICT"
  | "KEY_EPOCH_MISMATCH"
  | "MEMORY_LIMIT"
  | "INDEX_STALE"
  | "INDEX_BUSY"
  | "INVALID_BACKUP";

export class MemoryError extends Error {
  constructor(readonly code: FailureCode, message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

export function assertBlobRef(value: unknown): asserts value is BlobRef {
  if (!isObject(value) || (value.provider !== "local" && value.provider !== "0g") ||
      typeof value.network !== "string" || value.network.length < 1 || value.network.length > 128 ||
      typeof value.objectId !== "string" || value.objectId.length < 1 || value.objectId.length > 512 ||
      typeof value.ciphertextSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.ciphertextSha256) ||
      !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1 || Number(value.byteLength) > 2_000_000) {
    throw new MemoryError("INTEGRITY_FAILED", "Invalid blob reference");
  }
}
