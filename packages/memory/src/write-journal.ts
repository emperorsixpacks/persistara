import { randomUUID } from "node:crypto";
import { constants, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../../crypto/src/envelope.js";
import { assertBlobRef, isIdentifier, MemoryError, sameBlob, type BlobRef, type CheckpointAttempt, type MemoryHead } from "../../protocol/src/memory.js";
import { assertBinding, assertBoundBlob, bindingText, type MemoryBinding } from "./binding.js";
import { headFingerprint } from "./index.js";

export interface WriteOperation {
  id: string; digest: string; recordId: string; keyEpoch: number;
  status: "pending" | "committed" | "conflict" | "failed" | "canceled";
  resultRecordId: string | null; resultVersion: number | null;
}
export interface WriteBlob {
  id: string; operationId: string; bytes: Uint8Array; ref: BlobRef | null;
  state: "ready" | "dispatched" | "available"; transactionHash: string | null;
}
export interface WriteAttempt {
  operationId: string; number: number; blobId: string; baseHead: MemoryHead | null;
  plan: CheckpointAttempt | null; state: "building" | "prepared" | "dispatched" | "accepted" | "rejected" | "failed";
}
export interface WriteLease { owner: string; fence: number }
const APP_ID = 0x5053574a;
function corrupt(): never { throw new MemoryError("INTEGRITY_FAILED", "Memory write journal is invalid"); }
function json<T>(value: unknown): T {
  if (typeof value !== "string" || value.length > 32_768) return corrupt();
  try { return JSON.parse(value) as T; } catch { return corrupt(); }
}
export function recordBlobId(id: string): string { return `record:${sha256(Buffer.from(id))}`; }

/** Private encrypted write-ahead data. SQL transactions never span asynchronous work. */
export class MemoryWriteJournal {
  readonly #db: DatabaseSync;
  readonly #binding: MemoryBinding;
  constructor(path: string, binding: MemoryBinding, private readonly now: () => number = Date.now, create = true) {
    assertBinding(binding); this.#binding = structuredClone(binding);
    const absolute = resolve(path);
    if (create) mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(absolute));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new MemoryError("INVALID_INPUT", "Memory journal directory must be private");
    const fd = openSync(absolute, (create ? constants.O_CREAT : 0) | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const info = lstatSync(absolute);
    if (!info.isFile() || (info.mode & 0o077)) throw new MemoryError("INVALID_INPUT", "Memory journal file must be private");
    this.#db = new DatabaseSync(absolute);
    try {
      if (info.size && this.#db.prepare("PRAGMA application_id").get()?.application_id !== APP_ID) throw new MemoryError("INVALID_INPUT", "File is not a memory write journal");
      const version = this.#db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new MemoryError("INVALID_INPUT", "Unsupported memory journal schema");
      this.#db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;
        CREATE TABLE IF NOT EXISTS write_meta (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, owner TEXT, expires INTEGER NOT NULL, fence INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS write_operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, record_id TEXT NOT NULL, key_epoch INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','committed','conflict','failed','canceled')), result_record_id TEXT, result_version INTEGER) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS one_pending_write ON write_operations(status) WHERE status='pending';
        CREATE TABLE IF NOT EXISTS write_blobs (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, bytes BLOB NOT NULL, ref TEXT,
          state TEXT NOT NULL CHECK(state IN ('ready','dispatched','available')), transaction_hash TEXT) STRICT;
        CREATE TABLE IF NOT EXISTS write_attempts (operation_id TEXT NOT NULL, number INTEGER NOT NULL, blob_id TEXT NOT NULL UNIQUE, base_head TEXT NOT NULL, plan TEXT,
          state TEXT NOT NULL CHECK(state IN ('building','prepared','dispatched','accepted','rejected','failed')), PRIMARY KEY(operation_id,number)) STRICT;`);
      this.atomic(() => {
        this.#db.prepare("INSERT OR IGNORE INTO write_meta VALUES(1,?,NULL,0,0)").run(bindingText(this.#binding));
        if (this.#db.prepare("SELECT binding FROM write_meta WHERE id=1").get()?.binding !== bindingText(this.#binding)) throw new MemoryError("AUTHENTICATION_FAILED", "Memory journal belongs to another agent or network");
        this.#db.exec("PRAGMA user_version=1");
      });
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { this.#db.close(); }
  assertScope(binding: MemoryBinding): void {
    if (bindingText(binding) !== bindingText(this.#binding)) throw new MemoryError("AUTHENTICATION_FAILED", "Memory writer and journal scopes differ");
  }
  private atomic<T>(action: () => T): T {
    try { this.#db.exec("BEGIN IMMEDIATE"); }
    catch { throw new MemoryError("WRITE_BUSY", "Memory journal is busy"); }
    try { const result = action(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  private held(lease: WriteLease): void {
    const row = this.#db.prepare("SELECT * FROM write_meta WHERE id=1").get();
    if (!row || row.owner !== lease.owner || row.fence !== lease.fence || Number(row.expires) <= this.now()) throw new MemoryError("LEASE_LOST", "Memory writer lost its lease");
  }
  private mutate<T>(lease: WriteLease, action: () => T): T { return this.atomic(() => { this.held(lease); return action(); }); }
  acquire(ttl: number): WriteLease {
    if (!Number.isSafeInteger(ttl) || ttl < 100 || ttl > 120_000) throw new MemoryError("INVALID_INPUT", "Invalid writer lease duration");
    return this.atomic(() => {
      const row = this.#db.prepare("SELECT * FROM write_meta WHERE id=1").get();
      if (!row || !Number.isSafeInteger(row.fence) || Number(row.fence) < 0 || Number(row.fence) >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(row.expires) || Number(row.expires) < 0 ||
          (row.owner !== null && (typeof row.owner !== "string" || !/^[a-f0-9-]{36}$/.test(row.owner)))) return corrupt();
      if (row.owner !== null && Number(row.expires) > this.now()) throw new MemoryError("WRITE_BUSY", "Another process owns this memory writer");
      const lease = { owner: randomUUID(), fence: Number(row.fence) + 1 };
      this.#db.prepare("UPDATE write_meta SET owner=?,expires=?,fence=? WHERE id=1").run(lease.owner, this.now() + ttl, lease.fence);
      return lease;
    });
  }
  renew(lease: WriteLease, ttl: number): void { this.mutate(lease, () => { this.#db.prepare("UPDATE write_meta SET expires=? WHERE id=1").run(this.now() + ttl); }); }
  release(lease: WriteLease): void {
    this.atomic(() => { this.#db.prepare("UPDATE write_meta SET owner=NULL,expires=0 WHERE id=1 AND owner=? AND fence=?").run(lease.owner, lease.fence); });
  }
  operation(id: string): WriteOperation | null {
    if (!isIdentifier(id)) throw new MemoryError("INVALID_INPUT", "Invalid memory operation ID");
    const row = this.#db.prepare("SELECT * FROM write_operations WHERE id=?").get(id);
    if (!row) return null;
    if (!isIdentifier(row.record_id) || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest) || !Number.isSafeInteger(row.key_epoch) || Number(row.key_epoch) < 1 ||
        !["pending", "committed", "conflict", "failed", "canceled"].includes(String(row.status)) ||
        (row.status === "committed" && (!isIdentifier(row.result_record_id) || !Number.isSafeInteger(row.result_version) || Number(row.result_version) < 1))) return corrupt();
    return { id, digest: row.digest, recordId: row.record_id, keyEpoch: Number(row.key_epoch), status: row.status as WriteOperation["status"], resultRecordId: row.result_record_id as string | null, resultVersion: row.result_version as number | null };
  }
  create(lease: WriteLease, input: { id: string; digest: string; recordId: string; keyEpoch: number; bytes: Uint8Array }): WriteOperation {
    return this.mutate(lease, () => {
      const prior = this.operation(input.id);
      if (prior) {
        if (prior.digest !== input.digest) throw new MemoryError("OPERATION_CONFLICT", "Memory operation ID already binds another payload");
        return prior;
      }
      if (this.#db.prepare("SELECT id FROM write_operations WHERE status='pending'").get()) throw new MemoryError("WRITE_BUSY", "Resolve the pending memory write before creating another");
      if (Number(this.#db.prepare("SELECT count(*) AS n FROM write_operations").get()?.n) >= 1000) throw new MemoryError("MEMORY_LIMIT", "Memory write journal capacity reached");
      this.#db.prepare("INSERT INTO write_operations VALUES(?,?,?,?,'pending',NULL,NULL)").run(input.id, input.digest, input.recordId, input.keyEpoch);
      this.#db.prepare("INSERT INTO write_blobs VALUES(?,?,?,NULL,'ready',NULL)").run(recordBlobId(input.id), input.id, input.bytes);
      return this.operation(input.id)!;
    });
  }
  blob(id: string): WriteBlob {
    const row = this.#db.prepare("SELECT * FROM write_blobs WHERE id=?").get(id);
    if (!row || !isIdentifier(row.operation_id) || !(row.bytes instanceof Uint8Array) || row.bytes.byteLength < 1 || row.bytes.byteLength > 1_500_000 || !["ready", "dispatched", "available"].includes(String(row.state))) return corrupt();
    const ref = row.ref === null ? null : json<BlobRef>(row.ref);
    if (ref) {
      assertBlobRef(ref); assertBoundBlob(this.#binding, ref);
      if (ref.byteLength !== row.bytes.byteLength || ref.ciphertextSha256 !== sha256(row.bytes)) return corrupt();
    } else if (row.state !== "ready") return corrupt();
    if (row.transaction_hash !== null && (typeof row.transaction_hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(row.transaction_hash))) return corrupt();
    return { id, operationId: row.operation_id, bytes: Uint8Array.from(row.bytes), ref, state: row.state as WriteBlob["state"], transactionHash: row.transaction_hash as string | null };
  }
  prepareBlob(lease: WriteLease, id: string, ref: BlobRef): void {
    assertBlobRef(ref); assertBoundBlob(this.#binding, ref);
    const captured: BlobRef = { provider: ref.provider, network: ref.network, objectId: ref.objectId, ciphertextSha256: ref.ciphertextSha256, byteLength: ref.byteLength };
    this.mutate(lease, () => {
      const row = this.blob(id);
      if (captured.byteLength !== row.bytes.byteLength || captured.ciphertextSha256 !== sha256(row.bytes) || (row.ref && !sameBlob(row.ref, captured))) return corrupt();
      if (!row.ref) this.#db.prepare("UPDATE write_blobs SET ref=? WHERE id=? AND state='ready'").run(JSON.stringify(captured), id);
    });
  }
  dispatchBlob(lease: WriteLease, id: string): void {
    this.mutate(lease, () => {
      const row = this.blob(id);
      if (!row.ref || row.state !== "ready") return corrupt();
      this.#db.prepare("UPDATE write_blobs SET state='dispatched' WHERE id=?").run(id);
    });
  }
  available(lease: WriteLease, id: string): void {
    this.mutate(lease, () => { if (this.blob(id).state !== "dispatched") return corrupt(); this.#db.prepare("UPDATE write_blobs SET state='available' WHERE id=?").run(id); });
  }
  submitted(lease: WriteLease, id: string, hash: string): void {
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) return corrupt();
    this.mutate(lease, () => {
      const row = this.blob(id);
      if (row.state !== "dispatched" || (row.transactionHash && row.transactionHash !== hash)) return corrupt();
      this.#db.prepare("UPDATE write_blobs SET transaction_hash=? WHERE id=?").run(hash, id);
    });
  }
  attempt(id: string): WriteAttempt | null {
    const row = this.#db.prepare("SELECT * FROM write_attempts WHERE operation_id=? ORDER BY number DESC LIMIT 1").get(id);
    if (!row) return null;
    if (!Number.isSafeInteger(row.number) || Number(row.number) < 1 || Number(row.number) > 16 || typeof row.blob_id !== "string" || !["building", "prepared", "dispatched", "accepted", "rejected", "failed"].includes(String(row.state))) return corrupt();
    const baseHead = json<MemoryHead | null>(row.base_head); headFingerprint(baseHead);
    if (baseHead) assertBoundBlob(this.#binding, baseHead.manifest);
    const plan = row.plan === null ? null : json<CheckpointAttempt>(row.plan);
    if (plan) {
      if (!isIdentifier(plan.operationId) || !/^[a-f0-9]{64}$/.test(plan.signerBinding) || typeof plan.generation !== "string" || !/^[1-9][0-9]{0,19}$/.test(plan.generation) || plan.expectedVersion !== (baseHead?.version ?? 0) || plan.next.version !== plan.expectedVersion + 1 || plan.next.keyEpoch !== this.operation(id)?.keyEpoch) return corrupt();
      headFingerprint(plan.next); assertBoundBlob(this.#binding, plan.next.manifest);
      const blob = this.blob(row.blob_id);
      if (blob.operationId !== id || !blob.ref || !sameBlob(blob.ref, plan.next.manifest) || blob.state !== "available") return corrupt();
    } else if (!["building", "rejected"].includes(String(row.state))) return corrupt();
    return { operationId: id, number: Number(row.number), blobId: row.blob_id, baseHead, plan, state: row.state as WriteAttempt["state"] };
  }
  createAttempt(lease: WriteLease, id: string, baseHead: MemoryHead | null, bytes: Uint8Array): WriteAttempt {
    return this.mutate(lease, () => {
      if (this.operation(id)?.status !== "pending") return corrupt();
      const prior = this.attempt(id);
      if (prior && prior.state !== "rejected") return corrupt();
      const number = (prior?.number ?? 0) + 1;
      if (number > 16) throw new MemoryError("MEMORY_LIMIT", "Memory checkpoint attempt limit reached");
      const blobId = `manifest:${randomUUID()}`;
      this.#db.prepare("INSERT INTO write_blobs VALUES(?,?,?,NULL,'ready',NULL)").run(blobId, id, bytes);
      this.#db.prepare("INSERT INTO write_attempts VALUES(?,?,?,?,NULL,'building')").run(id, number, blobId, JSON.stringify(baseHead));
      return this.attempt(id)!;
    });
  }
  prepareAttempt(lease: WriteLease, id: string, plan: CheckpointAttempt): void {
    this.mutate(lease, () => {
      const attempt = this.attempt(id);
      if (!attempt || attempt.state !== "building") return corrupt();
      this.#db.prepare("UPDATE write_attempts SET plan=?,state='prepared' WHERE operation_id=? AND number=?").run(JSON.stringify(plan), id, attempt.number);
      this.attempt(id); // Validate the complete durable plan before any dispatch.
    });
  }
  attemptState(lease: WriteLease, id: string, state: "dispatched" | "accepted" | "rejected" | "failed"): void {
    this.mutate(lease, () => {
      const row = this.attempt(id);
      if (!row || (state === "dispatched" ? row.state !== "prepared" : !["building", "prepared", "dispatched"].includes(row.state))) return corrupt();
      if ((state === "accepted" || state === "failed") && row.state !== "dispatched") return corrupt();
      this.#db.prepare("UPDATE write_attempts SET state=? WHERE operation_id=? AND number=?").run(state, id, row.number);
    });
  }
  finish(lease: WriteLease, id: string, status: "committed" | "conflict" | "failed" | "canceled", recordId?: string, version?: number): void {
    this.mutate(lease, () => {
      if (this.operation(id)?.status !== "pending") return corrupt();
      const attempt = this.attempt(id);
      if (attempt?.state === "dispatched") throw new MemoryError("WRITE_PENDING", "Checkpoint outcome must be reconciled first");
      if (status === "committed" && (!isIdentifier(recordId) || !Number.isSafeInteger(version) || Number(version) < 1)) return corrupt();
      this.#db.prepare("UPDATE write_operations SET status=?,result_record_id=?,result_version=? WHERE id=?").run(status, recordId ?? null, version ?? null, id);
    });
  }
}
