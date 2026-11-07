/** LOCAL FIXTURE ONLY: disk ciphertext and a SQLite authority emulator, with deliberate process exits. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../../packages/crypto/src/envelope.js";
import { decodePrivateKeyring, encodePrivateKeyring } from "../../packages/memory/src/backup.js";
import type { MemoryBinding } from "../../packages/memory/src/binding.js";
import { readPrivateFile, writePrivateFile } from "../../packages/memory/src/files.js";
import { MemoryRecallIndex } from "../../packages/memory/src/index.js";
import { MemoryKeyring } from "../../packages/memory/src/keyring.js";
import { MemoryService } from "../../packages/memory/src/service.js";
import { MemoryWriteJournal } from "../../packages/memory/src/write-journal.js";
import { DurableMemoryWriter } from "../../packages/memory/src/writer.js";
import { MemoryError, type BlobRef, type CheckpointAttempt, type DurableMemoryHeads, type MemoryHead } from "../../packages/protocol/src/memory.js";
import { LocalBlobStore } from "../../packages/storage/src/local.js";

const binding: MemoryBinding = { agentId: "owner.fixture:research", authorityNetwork: "fixture:local", chainId: "fixture", contractId: "authority.fixture", storageNetwork: "local" };
const input = { operationId: "memory:crash-drill", text: "Research reports must cite dated primary sources.", source: { kind: "owner" as const, reference: "fixture:owner-preference" } };
class DiskAuthority implements DurableMemoryHeads {
  constructor(readonly db: DatabaseSync, private readonly interrupt: boolean) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, result INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (kind TEXT PRIMARY KEY, count INTEGER NOT NULL);`);
  }
  async get(): Promise<MemoryHead | null> { return JSON.parse(String(this.db.prepare("SELECT value FROM head WHERE id=1").get()?.value ?? "null")) as MemoryHead | null; }
  async assertWritable(epoch: number): Promise<void> { assert.equal(epoch, 1); }
  async compareAndSwap(_id: string, version: number, next: MemoryHead): Promise<boolean> {
    if (((await this.get())?.version ?? 0) !== version) return false;
    this.db.prepare("INSERT OR REPLACE INTO head VALUES(1,?)").run(JSON.stringify(next)); return true;
  }
  async prepare(_id: string, expectedVersion: number, next: MemoryHead): Promise<CheckpointAttempt | null> {
    if (((await this.get())?.version ?? 0) !== expectedVersion) return null;
    return { operationId: `checkpoint:${sha256(Buffer.from(JSON.stringify([expectedVersion, next])))}`, signerBinding: "a".repeat(64), generation: "1", expectedVersion, next: structuredClone(next) };
  }
  async submit(plan: CheckpointAttempt): Promise<boolean> {
    const prior = this.db.prepare("SELECT result FROM transactions WHERE id=?").get(plan.operationId);
    if (prior) return prior.result === 1;
    this.db.exec("BEGIN IMMEDIATE");
    let result: boolean;
    try {
      const value = JSON.parse(String(this.db.prepare("SELECT value FROM head WHERE id=1").get()?.value ?? "null")) as MemoryHead | null;
      result = (value?.version ?? 0) === plan.expectedVersion;
      if (result) this.db.prepare("INSERT OR REPLACE INTO head VALUES(1,?)").run(JSON.stringify(plan.next));
      this.db.prepare("INSERT INTO transactions VALUES(?,?)").run(plan.operationId, result ? 1 : 0);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (this.interrupt) process.exit(74); // Simulate runtime loss after authority commits, before any local outcome.
    return result;
  }
  async reconcile(plan: CheckpointAttempt): Promise<"accepted" | "rejected" | "unsubmitted"> {
    const prior = this.db.prepare("SELECT result FROM transactions WHERE id=?").get(plan.operationId);
    return prior ? prior.result === 1 ? "accepted" : "rejected" : "unsubmitted";
  }
  countUpload(kind: string): void { this.db.prepare("INSERT INTO uploads VALUES(?,1) ON CONFLICT(kind) DO UPDATE SET count=count+1").run(kind); }
  counts(): { recordUploads: number; manifestUploads: number; checkpointBroadcasts: number } {
    return { recordUploads: Number(this.db.prepare("SELECT count FROM uploads WHERE kind='memory'").get()?.count ?? 0),
      manifestUploads: Number(this.db.prepare("SELECT count FROM uploads WHERE kind='manifest'").get()?.count ?? 0),
      checkpointBroadcasts: Number(this.db.prepare("SELECT count(*) AS n FROM transactions").get()?.n ?? 0) };
  }
}
class DiskBlobs extends LocalBlobStore {
  constructor(directory: string, private readonly authority: DiskAuthority, private readonly interrupt: boolean) { super(directory); }
  async putPrepared(ref: BlobRef, bytes: Uint8Array, submitted: (hash: string) => void): Promise<BlobRef> {
    const purpose = (JSON.parse(Buffer.from(bytes).toString()) as { context: { purpose: string } }).context.purpose;
    this.authority.countUpload(purpose);
    const result = await super.putPrepared(ref, bytes, submitted);
    if (this.interrupt && purpose === "memory") process.exit(73); // Storage completed; the journal still says dispatched.
    return result;
  }
}
async function waitForCrashLease<T>(action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    try { return await action(); }
    catch (error) {
      if (!(error instanceof MemoryError) || error.code !== "WRITE_BUSY" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
}
async function main(): Promise<void> {
  const [phase, directory] = process.argv.slice(2);
  assert.ok(directory && phase && ["interrupt-upload", "reconcile-upload", "interrupt-checkpoint", "reconcile-checkpoint", "verify"].includes(phase));
  await mkdir(join(directory, "provider-fixture"), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "provider-fixture", "authority.sqlite"));
  const authority = new DiskAuthority(db, phase === "interrupt-checkpoint");
  const blobs = new DiskBlobs(join(directory, "provider-fixture", "ciphertext"), authority, phase === "interrupt-upload");
  const keyFile = join(directory, "runtime", "memory-keyring.json");
  const keys = phase === "interrupt-upload" ? MemoryKeyring.create() : decodePrivateKeyring(await readPrivateFile(keyFile), binding);
  if (phase === "interrupt-upload") await writePrivateFile(keyFile, encodePrivateKeyring(binding, keys));
  const journal = new MemoryWriteJournal(join(directory, "runtime", "writes.sqlite"), binding, Date.now, phase === "interrupt-upload");
  try {
    // Short fixture-only lease makes an actual dead-process takeover bounded. Production defaults to 30 seconds.
    const writer = new DurableMemoryWriter(binding, keys, blobs, authority, journal, 1000);
    const receipt = await waitForCrashLease(() => phase === "interrupt-upload" || phase === "verify" ? writer.remember(input) :
      phase === "interrupt-checkpoint" ? writer.resume(input.operationId) : writer.reconcile(input.operationId));
    const counts = authority.counts();
    if (phase === "reconcile-upload") { assert.equal(receipt.status, "pending"); assert.deepEqual(counts, { recordUploads: 1, manifestUploads: 0, checkpointBroadcasts: 0 }); }
    else {
      assert.equal(receipt.status, "committed"); assert.equal(receipt.version, 1);
      assert.deepEqual(counts, { recordUploads: 1, manifestUploads: 1, checkpointBroadcasts: 1 });
      const memory = new MemoryService(binding.agentId, keys, 1, blobs, authority, { binding });
      const snapshot = await memory.recoverSnapshot(); assert.equal(snapshot.records.length, 1); assert.deepEqual(snapshot.records[0]?.source, input.source);
      const index = new MemoryRecallIndex(join(directory, "rebuilt-cache", "recall.sqlite"), binding);
      try { index.replace(snapshot); assert.equal(index.search("dated primary sources", snapshot.head).matches[0]?.untrusted, true); } finally { index.close(); }
    }
    console.log(JSON.stringify({ evidence: "LOCAL_FIXTURE_ONLY", phase, status: receipt.status, version: receipt.version, ...counts, originalProcessResumed: false }));
  } finally { journal.close(); db.close(); }
}
main().catch((error: unknown) => { console.error(JSON.stringify({ status: "failed", code: error instanceof MemoryError ? error.code : "FIXTURE_FAILED" })); process.exitCode = 1; });
