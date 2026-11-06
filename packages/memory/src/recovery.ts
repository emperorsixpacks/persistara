import { MemoryError, type BlobStore, type MemoryHead, type MemoryHeadStore } from "../../protocol/src/memory.js";
import { restoreOwnerBackup } from "./backup.js";
import { assertBinding, type MemoryBinding } from "./binding.js";
import { headFingerprint, MemoryRecallIndex, type RecallResult } from "./index.js";
import { MemoryService } from "./service.js";

export interface MemoryHeadReader { get(agentId: string): Promise<MemoryHead | null> }
export function readOnlyHeads(reader: MemoryHeadReader): MemoryHeadStore {
  return { get: (id) => reader.get(id), compareAndSwap: async () => { throw new MemoryError("INVALID_INPUT", "Recovery has no checkpoint signing capability"); } };
}

/** Authenticate all data before touching the published index. No uploader or signer capability is needed. */
export async function rebuildFromOwnerBackup(input: { binding: MemoryBinding; bundle: Uint8Array; recoverySecret: string; blobs: BlobStore; heads: MemoryHeadReader; index: MemoryRecallIndex }) {
  assertBinding(input.binding);
  const { blobs, heads, index } = input;
  index.assertScope(input.binding);
  const binding = structuredClone(input.binding);
  const keys = restoreOwnerBackup(Uint8Array.from(input.bundle), input.recoverySecret, binding);
  const memory = new MemoryService(binding.agentId, keys, keys.activeEpoch, blobs, readOnlyHeads(heads), { binding });
  const snapshot = await memory.recoverSnapshot();
  const current = await heads.get(binding.agentId);
  if (headFingerprint(current) !== headFingerprint(snapshot.head)) throw new MemoryError("CHECKPOINT_CONFLICT", "Committed memory advanced during recovery; previous recall cache is preserved");
  return { ...index.replace(snapshot), head: snapshot.head, recoveredEpochs: keys.epochs(), evidence: "authenticated-memory-and-local-index" as const };
}

export async function recallCommitted(index: MemoryRecallIndex, heads: MemoryHeadReader, agentId: string, query: string, options: { limit?: number; includeSuperseded?: boolean } = {}): Promise<RecallResult> {
  index.assertAgent(agentId);
  const capturedOptions = { ...options };
  return index.search(query, await heads.get(agentId), capturedOptions);
}
