import { randomUUID } from "node:crypto";
import { open, seal, sha256 } from "../../crypto/src/envelope.js";
import {
  assertBlobRef, isIdentifier, isObject, MemoryError,
  type BlobRef, type BlobStore, type MemoryHead, type MemoryHeadStore, type MemoryRecord, type MemorySource,
} from "../../protocol/src/memory.js";
import { MemoryKeyring } from "./keyring.js";
import { assertBinding, assertBoundBlob, type MemoryBinding } from "./binding.js";

const MAX_ENTRIES = 1_000;
const MAX_COMMIT_ATTEMPTS = 16;
const MAX_RECOVERED_BYTES = 16 * 1024 * 1024;
export interface Entry { id: string; operationId: string; payloadDigest: string; keyEpoch: number; blob: BlobRef }
export interface Manifest { schemaVersion: 2; agentId: string; keyEpoch: number; version: number; entries: Entry[] }
export interface RememberInput { operationId: string; text: string; source: MemorySource; supersedes?: string }
export interface RememberResult { recordId: string; version: number; duplicate: boolean }
export interface RecoveredMemory extends MemoryRecord { keyEpoch: number }
export interface MemorySnapshot { head: MemoryHead | null; records: RecoveredMemory[] }

function encode(value: unknown): Uint8Array { return Buffer.from(JSON.stringify(value)); }
function parse(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new MemoryError("INVALID_MANIFEST", "Decrypted memory data is malformed"); }
}
function validSource(source: unknown): source is MemorySource {
  return isObject(source) && Object.keys(source).sort().join(",") === "kind,reference" && typeof source.kind === "string" && ["owner", "artifact", "tool"].includes(source.kind) &&
    typeof source.reference === "string" && source.reference.trim().length > 0 && source.reference.length <= 4096;
}
export function payloadDigest(input: Pick<RememberInput, "text" | "source" | "supersedes">): string {
  return sha256(encode([input.text, input.source.kind, input.source.reference, input.supersedes ?? null]));
}
export function validateInput(input: RememberInput): void {
  if (!isIdentifier(input.operationId) || typeof input.text !== "string" || !input.text.trim() ||
      Buffer.byteLength(input.text) > 65_536 || !validSource(input.source) ||
      (input.supersedes !== undefined && !isIdentifier(input.supersedes))) {
    throw new MemoryError("INVALID_INPUT", "Invalid memory input");
  }
}

/** Protocol foundation. Live authority, key custody, and indexing are separate adapters. */
export class MemoryService {
  private readonly keys: MemoryKeyring;
  private readonly binding: MemoryBinding | undefined;

  constructor(
    private readonly agentId: string,
    key: Uint8Array | MemoryKeyring,
    private readonly keyEpoch: number,
    private readonly blobs: BlobStore,
    private readonly heads: MemoryHeadStore,
    options: { binding?: MemoryBinding } = {},
  ) {
    if (!isIdentifier(agentId) || !Number.isSafeInteger(keyEpoch) || keyEpoch < 1) {
      throw new MemoryError("INVALID_INPUT", "Invalid memory service configuration");
    }
    this.keys = key instanceof MemoryKeyring ? new MemoryKeyring(key.activeEpoch, key.epochs().map((epoch) => ({ epoch, key: key.key(epoch) }))) : new MemoryKeyring(keyEpoch, [{ epoch: keyEpoch, key }]);
    if (this.keys.activeEpoch !== keyEpoch) throw new MemoryError("KEY_EPOCH_MISMATCH", "Writer epoch does not match its keyring");
    if (options.binding) {
      assertBinding(options.binding);
      if (options.binding.agentId !== agentId) throw new MemoryError("INVALID_INPUT", "Memory binding belongs to another agent");
      this.binding = structuredClone(options.binding);
    }
  }

  private context(recordId: string, purpose: "memory" | "manifest", keyEpoch = this.keyEpoch) {
    return { agentId: this.agentId, recordId, purpose, keyEpoch };
  }

  private async read(ref: BlobRef): Promise<Uint8Array> {
    assertBlobRef(ref);
    if (this.binding) assertBoundBlob(this.binding, ref);
    const bytes = await this.blobs.get(ref);
    if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.ciphertextSha256) {
      throw new MemoryError("INTEGRITY_FAILED", "Storage returned bytes that do not match the committed reference");
    }
    return bytes;
  }

  private async write(bytes: Uint8Array): Promise<BlobRef> {
    const ref = await this.blobs.put(bytes);
    assertBlobRef(ref);
    if (ref.byteLength !== bytes.byteLength || ref.ciphertextSha256 !== sha256(bytes)) {
      throw new MemoryError("INTEGRITY_FAILED", "Storage returned an incorrect upload reference");
    }
    await this.read(ref); // A checkpoint must not get ahead of retrievable data.
    return ref;
  }

  private async load(head: MemoryHead | null): Promise<Manifest> {
    if (head === null) return { schemaVersion: 2, agentId: this.agentId, keyEpoch: this.keyEpoch, version: 0, entries: [] };
    if (!Number.isSafeInteger(head.version) || head.version < 1 || !Number.isSafeInteger(head.keyEpoch) || head.keyEpoch < 1) {
      throw new MemoryError("INVALID_MANIFEST", "Invalid checkpoint version");
    }
    if (head.keyEpoch > this.keyEpoch) throw new MemoryError("KEY_EPOCH_MISMATCH", "Checkpoint requires a newer memory key epoch");
    const value = parse(open(await this.read(head.manifest), this.keys.key(head.keyEpoch), this.context(`manifest:${head.version}`, "manifest", head.keyEpoch)));
    if (!isObject(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || value.agentId !== this.agentId ||
        value.keyEpoch !== head.keyEpoch || value.version !== head.version || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
      throw new MemoryError("INVALID_MANIFEST", "Manifest does not match its committed checkpoint");
    }
    const ids = new Set<string>();
    const operations = new Set<string>();
    const entries: Entry[] = [];
    for (const entry of value.entries) {
      if (!isObject(entry) || !isIdentifier(entry.id) || !isIdentifier(entry.operationId) ||
          typeof entry.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(entry.payloadDigest) ||
          ids.has(entry.id) || operations.has(entry.operationId)) {
        throw new MemoryError("INVALID_MANIFEST", "Manifest contains an invalid or duplicate entry");
      }
      assertBlobRef(entry.blob);
      if (this.binding) assertBoundBlob(this.binding, entry.blob);
      const epoch = value.schemaVersion === 1 ? head.keyEpoch : entry.keyEpoch;
      if (!Number.isSafeInteger(epoch) || Number(epoch) < 1 || Number(epoch) > head.keyEpoch) throw new MemoryError("INVALID_MANIFEST", "Invalid record key epoch");
      this.keys.key(Number(epoch)); // Verify coverage before recovering or appending anything.
      entries.push({ id: entry.id, operationId: entry.operationId, payloadDigest: entry.payloadDigest, blob: structuredClone(entry.blob), keyEpoch: Number(epoch) });
      ids.add(entry.id);
      operations.add(entry.operationId);
    }
    return { schemaVersion: 2, agentId: this.agentId, keyEpoch: head.keyEpoch, version: head.version, entries };
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    validateInput(input);
    // Snapshot inputs before awaiting: callers cannot change the committed payload mid-flight.
    const payload: RememberInput = { operationId: input.operationId, text: input.text, source: { ...input.source } };
    if (input.supersedes !== undefined) payload.supersedes = input.supersedes;
    const digest = payloadDigest(payload);
    let entry: Entry | undefined;
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      const current = await this.load(structuredClone(await this.heads.get(this.agentId)));
      const prior = current.entries.find((item) => item.operationId === payload.operationId);
      if (prior) {
        if (prior.payloadDigest !== digest) throw new MemoryError("OPERATION_CONFLICT", "Operation ID was already used for another payload");
        return { recordId: prior.id, version: current.version, duplicate: true };
      }
      if (current.entries.length >= MAX_ENTRIES) throw new MemoryError("MEMORY_LIMIT", "Memory manifest is at its configured capacity");
      if (payload.supersedes && !current.entries.some((item) => item.id === payload.supersedes)) {
        throw new MemoryError("INVALID_INPUT", "Superseded memory is not in this agent's manifest");
      }
      if (!entry) {
        const id = `mem:${randomUUID()}`;
        const record: MemoryRecord = { schemaVersion: 1, id, agentId: this.agentId, operationId: payload.operationId, createdAt: new Date().toISOString(), text: payload.text, source: payload.source };
        if (payload.supersedes) record.supersedes = payload.supersedes;
        const blob = await this.write(seal(encode(record), this.keys.key(this.keyEpoch), this.context(id, "memory")));
        entry = { id, operationId: payload.operationId, payloadDigest: digest, blob, keyEpoch: this.keyEpoch };
      }
      if (current.version >= Number.MAX_SAFE_INTEGER) throw new MemoryError("MEMORY_LIMIT", "Checkpoint version limit reached");
      const next: Manifest = { ...current, schemaVersion: 2, keyEpoch: this.keyEpoch, version: current.version + 1, entries: [...current.entries, entry] };
      const manifest = await this.write(seal(encode(next), this.keys.key(this.keyEpoch), this.context(`manifest:${next.version}`, "manifest")));
      const head: MemoryHead = { version: next.version, keyEpoch: this.keyEpoch, manifest };
      if (await this.heads.compareAndSwap(this.agentId, current.version, head)) {
        return { recordId: entry.id, version: next.version, duplicate: false };
      }
    }
    throw new MemoryError("CHECKPOINT_CONFLICT", "Concurrent checkpoint writes exceeded the retry limit");
  }

  async recover(): Promise<RecoveredMemory[]> { return (await this.recoverSnapshot()).records; }

  async recoverSnapshot(): Promise<MemorySnapshot> {
    const { head, records } = await this.readCommitted();
    return { head, records };
  }

  /** Fully authenticated committed records plus the manifest needed for a durable append. */
  async readCommitted(): Promise<MemorySnapshot & { manifest: Manifest }> {
    const head = structuredClone(await this.heads.get(this.agentId));
    const manifest = await this.load(head);
    const records: RecoveredMemory[] = [];
    const earlier = new Set<string>();
    let total = 0;
    for (const entry of manifest.entries) {
      const plaintext = open(await this.read(entry.blob), this.keys.key(entry.keyEpoch), this.context(entry.id, "memory", entry.keyEpoch));
      total += plaintext.byteLength;
      if (total > MAX_RECOVERED_BYTES) throw new MemoryError("MEMORY_LIMIT", "Recovered memory exceeds the 16 MiB release cap");
      const value = parse(plaintext);
      if (!isObject(value) || value.schemaVersion !== 1 || value.id !== entry.id || value.agentId !== this.agentId ||
          value.operationId !== entry.operationId || typeof value.text !== "string" || !value.text.trim() || Buffer.byteLength(value.text) > 65_536 ||
          !validSource(value.source) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
          (value.supersedes !== undefined && (!isIdentifier(value.supersedes) || !earlier.has(value.supersedes)))) {
        throw new MemoryError("INVALID_MANIFEST", "Recovered record does not match its manifest");
      }
      const record = value as unknown as MemoryRecord;
      if (payloadDigest(record) !== entry.payloadDigest) throw new MemoryError("INTEGRITY_FAILED", "Recovered payload does not match its committed digest");
      const recovered: RecoveredMemory = { schemaVersion: 1, id: record.id, agentId: record.agentId, operationId: record.operationId, createdAt: record.createdAt,
        text: record.text, source: { kind: record.source.kind, reference: record.source.reference }, keyEpoch: entry.keyEpoch };
      if (record.supersedes !== undefined) recovered.supersedes = record.supersedes;
      records.push(recovered);
      earlier.add(record.id);
    }
    return { head, records, manifest };
  }
}
