import { randomUUID } from "node:crypto";
import { open, seal, sha256 } from "../../crypto/src/envelope.js";
import { isIdentifier, isObject, MemoryError, sameBlob, type DurableMemoryHeads, type MemoryRecord, type PreparedBlobStore } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { assertBinding, assertBoundBlob, type MemoryBinding } from "./binding.js";
import { headFingerprint } from "./index.js";
import { MemoryKeyring } from "./keyring.js";
import { MemoryService, payloadDigest, validateInput, type Manifest, type RememberInput } from "./service.js";
import { MemoryWriteJournal, recordBlobId, type WriteAttempt, type WriteLease, type WriteOperation } from "./write-journal.js";

export interface WriteReceipt {
  operationId: string; status: "pending" | "unknown" | "committed" | "conflict" | "failed" | "canceled";
  phase: "record" | "manifest" | "checkpoint" | "finalized";
  recordId: string; version: number | null;
  checkpointOperationId: string | null;
}

/** One agent journal; ciphertext and exact effect identities survive process loss. No plaintext receipts. */
export class DurableMemoryWriter {
  readonly #binding: MemoryBinding;
  readonly #keys: MemoryKeyring;
  readonly #memory: MemoryService;
  constructor(binding: MemoryBinding, keys: MemoryKeyring, private readonly blobs: PreparedBlobStore,
    private readonly heads: DurableMemoryHeads, private readonly journal: MemoryWriteJournal, private readonly leaseMs = 30_000) {
    assertBinding(binding); journal.assertScope(binding);
    this.#binding = structuredClone(binding);
    this.#keys = new MemoryKeyring(keys.activeEpoch, keys.epochs().map((epoch) => ({ epoch, key: keys.key(epoch) })));
    this.#memory = new MemoryService(binding.agentId, this.#keys, keys.activeEpoch, blobs, heads, { binding });
  }
  private context(id: string, epoch: number, purpose: "memory" | "manifest") { return { agentId: this.#binding.agentId, recordId: id, keyEpoch: epoch, purpose }; }
  private async leased<T>(action: (lease: WriteLease) => Promise<T>): Promise<T> {
    const lease = this.journal.acquire(this.leaseMs);
    let lost = false;
    const timer = setInterval(() => {
      try { this.journal.renew(lease, this.leaseMs); }
      catch { lost = true; lease.fence = -1; } // Fail closed locally even if a transient SQL failure prevented renewal.
    }, Math.floor(this.leaseMs / 3));
    timer.unref();
    try {
      const result = await action(lease);
      if (lost) throw new MemoryError("LEASE_LOST", "Memory writer lease renewal failed");
      return result;
    } finally { clearInterval(timer); this.journal.release(lease); }
  }
  async remember(input: RememberInput): Promise<WriteReceipt> {
    validateInput(input);
    const captured = structuredClone(input);
    const digest = payloadDigest(captured);
    return this.leased(async (lease) => {
      let operation = this.journal.operation(captured.operationId);
      if (operation && operation.digest !== digest) throw new MemoryError("OPERATION_CONFLICT", "Memory operation ID already binds another payload");
      if (!operation) {
        const record: MemoryRecord = { schemaVersion: 1, id: `mem:${randomUUID()}`, agentId: this.#binding.agentId, operationId: captured.operationId,
          createdAt: new Date().toISOString(), text: captured.text, source: captured.source };
        if (captured.supersedes !== undefined) record.supersedes = captured.supersedes;
        const bytes = seal(Buffer.from(JSON.stringify(record)), this.#keys.key(this.#keys.activeEpoch), this.context(record.id, this.#keys.activeEpoch, "memory"));
        operation = this.journal.create(lease, { id: captured.operationId, digest, recordId: record.id, keyEpoch: this.#keys.activeEpoch, bytes });
      }
      return this.drive(lease, operation.id, true);
    });
  }
  async resume(operationId: string): Promise<WriteReceipt> { return this.leased((lease) => this.drive(lease, operationId, true)); }
  /** Reads provider/chain state only; never uploads, prepares a new checkpoint, signs or broadcasts. */
  async reconcile(operationId: string): Promise<WriteReceipt> { return this.leased((lease) => this.drive(lease, operationId, false)); }
  async cancel(operationId: string): Promise<WriteReceipt> {
    return this.leased(async (lease) => {
      const op = this.operation(operationId); this.intent(op);
      if (op.status !== "pending") return this.receipt(operationId);
      const attempt = this.journal.attempt(operationId);
      const ids = [recordBlobId(operationId), ...(attempt ? [attempt.blobId] : [])];
      if (attempt?.state === "dispatched" || attempt?.state === "accepted" || ids.some((id) => this.journal.blob(id).state === "dispatched")) throw new MemoryError("WRITE_PENDING", "Resolve dispatched effects before cancellation");
      this.journal.finish(lease, operationId, "canceled"); return this.receipt(operationId);
    });
  }
  private operation(id: string): WriteOperation {
    const operation = this.journal.operation(id);
    if (!operation) throw new MemoryError("INVALID_INPUT", "Memory operation is not in this journal");
    return operation;
  }
  private intent(operation: WriteOperation): MemoryRecord {
    const bytes = this.journal.blob(recordBlobId(operation.id)).bytes;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(open(bytes, this.#keys.key(operation.keyEpoch), this.context(operation.recordId, operation.keyEpoch, "memory")))) as unknown; }
    catch (error) { if (error instanceof MemoryError) throw error; throw new MemoryError("INTEGRITY_FAILED", "Encrypted memory intent is malformed"); }
    if (!isObject(value) || value.schemaVersion !== 1 || value.id !== operation.recordId || value.agentId !== this.#binding.agentId || value.operationId !== operation.id ||
        typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new MemoryError("INTEGRITY_FAILED", "Memory intent belongs to another operation");
    validateInput(value as unknown as RememberInput);
    if (payloadDigest(value as unknown as RememberInput) !== operation.digest) throw new MemoryError("INTEGRITY_FAILED", "Memory intent does not match its payload digest");
    return value as unknown as MemoryRecord;
  }
  private receipt(id: string): WriteReceipt {
    const op = this.operation(id); const attempt = this.journal.attempt(id);
    const record = this.journal.blob(recordBlobId(id));
    const manifest = attempt ? this.journal.blob(attempt.blobId) : null;
    const unknown = record.state === "dispatched" || manifest?.state === "dispatched" || attempt?.state === "dispatched";
    return { operationId: id, status: op.status === "pending" && unknown ? "unknown" : op.status,
      phase: op.status === "committed" ? "finalized" : attempt?.plan ? "checkpoint" : attempt ? "manifest" : "record",
      recordId: op.resultRecordId ?? op.recordId, version: op.resultVersion, checkpointOperationId: attempt?.plan?.operationId ?? null };
  }
  private async readBlob(id: string): Promise<void> {
    const blob = this.journal.blob(id);
    if (!blob.ref) throw new MemoryError("INTEGRITY_FAILED", "Dispatched upload has no prepared reference");
    let bytes: Uint8Array;
    try { bytes = await this.blobs.get(structuredClone(blob.ref)); }
    catch (error) {
      if (error instanceof MemoryError && ["INTEGRITY_FAILED", "AUTHENTICATION_FAILED"].includes(error.code)) throw error;
      if (error instanceof ProviderError && ["INTEGRITY_FAILED", "NETWORK_MISMATCH", "INVALID_INPUT"].includes(error.code)) throw error;
      throw new ProviderError("OUTCOME_UNKNOWN", "Prepared storage object is not proven available; no upload retry is authorized", false, blob.ref.objectId);
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== blob.ref.byteLength || sha256(bytes) !== blob.ref.ciphertextSha256) throw new MemoryError("INTEGRITY_FAILED", "Storage returned different ciphertext");
  }
  private async ensureBlob(lease: WriteLease, id: string, allowEffects: boolean): Promise<boolean> {
    let blob = this.journal.blob(id);
    if (blob.state === "available") { await this.readBlob(id); return true; }
    if (blob.state === "dispatched") {
      try { await this.readBlob(id); }
      catch (error) { if (!allowEffects && error instanceof ProviderError && error.code === "OUTCOME_UNKNOWN") return false; throw error; }
      this.journal.available(lease, id); return true;
    }
    if (!allowEffects) return false;
    const operation = this.operation(blob.operationId);
    await this.heads.assertWritable(operation.keyEpoch);
    await this.blobs.assertUploadReady();
    if (!blob.ref) {
      const ref = await this.blobs.prepare(Uint8Array.from(blob.bytes));
      this.journal.prepareBlob(lease, id, ref);
      blob = this.journal.blob(id);
    }
    this.journal.dispatchBlob(lease, id); // Persisted BEFORE a provider can receive bytes.
    try {
      const result = await this.blobs.putPrepared(structuredClone(blob.ref!), Uint8Array.from(blob.bytes), (hash) => this.journal.submitted(lease, id, hash));
      if (!sameBlob(result, blob.ref!)) throw new MemoryError("INTEGRITY_FAILED", "Upload result differs from its prepared root");
      await this.readBlob(id);
      this.journal.available(lease, id);
      return true;
    } catch (error) {
      if (error instanceof MemoryError && ["LEASE_LOST", "INTEGRITY_FAILED"].includes(error.code)) throw error;
      throw new ProviderError("OUTCOME_UNKNOWN", "Upload was dispatched; reconcile its fixed root before continuing", false, blob.ref!.objectId);
    }
  }
  private async settle(lease: WriteLease, id: string, attempt: WriteAttempt, allowEffects: boolean): Promise<boolean> {
    if (attempt.state !== "dispatched") return true;
    let outcome: "accepted" | "rejected" | "failed" | "unknown" | "unsubmitted";
    if (allowEffects) {
      try { outcome = await this.heads.submit(structuredClone(attempt.plan!)) ? "accepted" : "rejected"; }
      catch (error) {
        if (!(error instanceof ProviderError) || error.code !== "TRANSACTION_FAILED") throw error;
        outcome = "failed";
      }
    } else outcome = await this.heads.reconcile(structuredClone(attempt.plan!));
    if (outcome === "unknown" || outcome === "unsubmitted") return false;
    this.journal.attemptState(lease, id, outcome);
    return true;
  }
  private verifyManifest(operation: WriteOperation, attempt: WriteAttempt): void {
    const blob = this.journal.blob(attempt.blobId);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(open(blob.bytes, this.#keys.key(operation.keyEpoch), this.context(`manifest:${(attempt.baseHead?.version ?? 0) + 1}`, operation.keyEpoch, "manifest")))) as unknown; }
    catch (error) { if (error instanceof MemoryError) throw error; throw new MemoryError("INTEGRITY_FAILED", "Pending manifest is malformed"); }
    const recordRef = this.journal.blob(recordBlobId(operation.id)).ref;
    if (!isObject(value) || value.schemaVersion !== 2 || value.agentId !== this.#binding.agentId || value.keyEpoch !== operation.keyEpoch || value.version !== (attempt.baseHead?.version ?? 0) + 1 || !Array.isArray(value.entries)) throw new MemoryError("INTEGRITY_FAILED", "Pending manifest does not match this write");
    const entries = value.entries.filter((entry: unknown) => isObject(entry) && entry.operationId === operation.id);
    const entry = entries[0];
    if (entries.length !== 1 || !isObject(entry) || entry.id !== operation.recordId || entry.payloadDigest !== operation.digest || entry.keyEpoch !== operation.keyEpoch || !recordRef || !isObject(entry.blob) || !sameBlob(entry.blob as unknown as typeof recordRef, recordRef)) throw new MemoryError("INTEGRITY_FAILED", "Pending manifest does not reference the encrypted intent");
  }
  private async drive(lease: WriteLease, id: string, allowEffects: boolean): Promise<WriteReceipt> {
    const initial = this.operation(id);
    const intent = this.intent(initial);
    if (initial.status !== "pending") return this.receipt(id);
    for (let iteration = 0; iteration < 18; iteration++) {
      let attempt = this.journal.attempt(id);
      if (attempt && !await this.settle(lease, id, attempt, allowEffects)) return this.receipt(id);
      if (this.operation(id).status !== "pending") return this.receipt(id);
      // Resolve dispatched effects before considering a canonical duplicate or a new attempt.
      for (const blobId of [recordBlobId(id), ...(attempt ? [attempt.blobId] : [])]) {
        if (this.journal.blob(blobId).state === "dispatched" && !await this.ensureBlob(lease, blobId, allowEffects)) return this.receipt(id);
      }
      const current = await this.#memory.readCommitted();
      const prior = current.records.find((r) => r.operationId === id);
      if (prior) {
        if (payloadDigest(prior) !== initial.digest) { this.journal.finish(lease, id, "conflict"); throw new MemoryError("OPERATION_CONFLICT", "Committed operation ID binds another payload"); }
        this.journal.finish(lease, id, "committed", prior.id, current.head!.version);
        return this.receipt(id);
      }
      attempt = this.journal.attempt(id);
      if (attempt?.state === "failed") { this.journal.finish(lease, id, "failed"); return this.receipt(id); }
      if (attempt?.state === "accepted") throw new MemoryError("INTEGRITY_FAILED", "Accepted checkpoint is absent from finalized memory");
      if (!allowEffects) return this.receipt(id);
      if (current.manifest.entries.length >= 1000 || (current.head?.version ?? 0) >= Number.MAX_SAFE_INTEGER) throw new MemoryError("MEMORY_LIMIT", "Memory checkpoint capacity reached");
      if (intent.supersedes && !current.records.some((r) => r.id === intent.supersedes)) throw new MemoryError("INVALID_INPUT", "Superseded memory is not committed for this agent");
      if (!await this.ensureBlob(lease, recordBlobId(id), true)) return this.receipt(id);
      if (!attempt || attempt.state === "rejected") {
        const recordBlob = this.journal.blob(recordBlobId(id));
        const next: Manifest = { schemaVersion: 2, agentId: this.#binding.agentId, keyEpoch: initial.keyEpoch, version: current.manifest.version + 1,
          entries: [...current.manifest.entries, { id: initial.recordId, operationId: id, payloadDigest: initial.digest, keyEpoch: initial.keyEpoch, blob: recordBlob.ref! }] };
        const bytes = seal(Buffer.from(JSON.stringify(next)), this.#keys.key(initial.keyEpoch), this.context(`manifest:${next.version}`, initial.keyEpoch, "manifest"));
        attempt = this.journal.createAttempt(lease, id, current.head, bytes);
      }
      this.verifyManifest(initial, attempt);
      if (!await this.ensureBlob(lease, attempt.blobId, true)) return this.receipt(id);
      const manifest = this.journal.blob(attempt.blobId).ref!;
      assertBoundBlob(this.#binding, manifest);
      const next = { version: (attempt.baseHead?.version ?? 0) + 1, keyEpoch: initial.keyEpoch, manifest };
      // Verify the entire proposed snapshot before any authority transaction can publish it.
      const candidate = new MemoryService(this.#binding.agentId, this.#keys, this.#keys.activeEpoch, this.blobs,
        { get: async () => structuredClone(next), compareAndSwap: async () => { throw new MemoryError("INVALID_INPUT", "Candidate validation is read-only"); } }, { binding: this.#binding });
      await candidate.recoverSnapshot();
      if (attempt.state === "building") {
        if (headFingerprint(await this.heads.get(this.#binding.agentId)) !== headFingerprint(attempt.baseHead)) { this.journal.attemptState(lease, id, "rejected"); continue; }
        const plan = await this.heads.prepare(this.#binding.agentId, next.version - 1, structuredClone(next));
        if (!plan) { this.journal.attemptState(lease, id, "rejected"); continue; }
        this.journal.prepareAttempt(lease, id, plan);
      }
      this.journal.attemptState(lease, id, "dispatched"); // Exact signer identity/request is durable first.
      await this.settle(lease, id, this.journal.attempt(id)!, true);
    }
    throw new MemoryError("CHECKPOINT_CONFLICT", "Memory checkpoint retries exceeded the bounded limit");
  }
}
