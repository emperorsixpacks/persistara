import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { sha256 } from "../packages/crypto/src/envelope.js";
import type { MemoryBinding } from "../packages/memory/src/binding.js";
import { MemoryKeyring } from "../packages/memory/src/keyring.js";
import { MemoryRecallIndex } from "../packages/memory/src/index.js";
import { MemoryService } from "../packages/memory/src/service.js";
import { MemoryWriteJournal, recordBlobId } from "../packages/memory/src/write-journal.js";
import { DurableMemoryWriter } from "../packages/memory/src/writer.js";
import { MemoryError, type BlobRef, type CheckpointAttempt, type DurableMemoryHeads, type MemoryHead } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { LocalBlobStore } from "../packages/storage/src/local.js";

const binding: MemoryBinding = { agentId: "owner.fixture:research", authorityNetwork: "fixture:local", chainId: "fixture", contractId: "authority.fixture", storageNetwork: "local" };
const fact = (id = "op:one", text = "Research must cite dated primary sources.") => ({ operationId: id, text, source: { kind: "owner" as const, reference: "owner:research-preference" } });
class FixtureHeads implements DurableMemoryHeads {
  value: MemoryHead | null = null;
  epoch = 1; paused = false; submissions = 0; broadcasts = 0; loseResponse = false; fail = false; unseen = false; stopBeforeSubmit = false;
  beforeSubmit: (() => Promise<void>) | undefined;
  transactions = new Map<string, boolean | "failed" | "unknown">();
  async get(): Promise<MemoryHead | null> { return structuredClone(this.value); }
  async assertWritable(epoch: number): Promise<void> { if (this.paused || epoch !== this.epoch) throw new ProviderError("AUTHORIZATION_FAILED", "Fixture authorization rejected"); }
  async compareAndSwap(_id: string, version: number, next: MemoryHead): Promise<boolean> {
    await this.assertWritable(next.keyEpoch);
    if ((this.value?.version ?? 0) !== version) return false;
    this.value = structuredClone(next); return true;
  }
  async prepare(_id: string, expectedVersion: number, next: MemoryHead): Promise<CheckpointAttempt | null> {
    await this.assertWritable(next.keyEpoch);
    if ((this.value?.version ?? 0) !== expectedVersion) return null;
    return { operationId: `checkpoint:${sha256(Buffer.from(JSON.stringify([expectedVersion, next])))}`, signerBinding: "a".repeat(64), generation: "1", expectedVersion, next: structuredClone(next) };
  }
  async submit(plan: CheckpointAttempt): Promise<boolean> {
    this.submissions++;
    if (this.stopBeforeSubmit) { this.stopBeforeSubmit = false; throw new ProviderError("OUTCOME_UNKNOWN", "Fixture interrupted before signer allocation"); }
    const prior = this.transactions.get(plan.operationId);
    if (prior === "failed") throw new ProviderError("TRANSACTION_FAILED", "Fixture terminal transaction failure");
    if (prior === "unknown") throw new ProviderError("OUTCOME_UNKNOWN", "Fixture transaction has not finalized");
    if (typeof prior === "boolean") return prior;
    if (this.beforeSubmit) { const hook = this.beforeSubmit; this.beforeSubmit = undefined; await hook(); }
    this.broadcasts++;
    if (this.fail) { this.transactions.set(plan.operationId, "failed"); throw new ProviderError("TRANSACTION_FAILED", "Fixture terminal transaction failure"); }
    if (this.unseen) { this.transactions.set(plan.operationId, "unknown"); throw new ProviderError("OUTCOME_UNKNOWN", "Fixture unresolved transaction"); }
    const accepted = await this.compareAndSwap(binding.agentId, plan.expectedVersion, plan.next);
    this.transactions.set(plan.operationId, accepted);
    if (this.loseResponse) { this.loseResponse = false; throw new ProviderError("OUTCOME_UNKNOWN", "Fixture response lost after commit"); }
    return accepted;
  }
  async reconcile(plan: CheckpointAttempt): Promise<"accepted" | "rejected" | "failed" | "unknown" | "unsubmitted"> {
    const prior = this.transactions.get(plan.operationId);
    return typeof prior === "boolean" ? prior ? "accepted" : "rejected" : prior ?? "unsubmitted";
  }
}
class FaultBlobs extends LocalBlobStore {
  uploads = { memory: 0, manifest: 0 };
  stop: "memory" | "manifest" | null = null;
  beforeWrite = false;
  async putPrepared(ref: BlobRef, bytes: Uint8Array, submitted: (ref: string) => void): Promise<BlobRef> {
    const purpose = (JSON.parse(Buffer.from(bytes).toString()) as { context: { purpose: "memory" | "manifest" } }).context.purpose;
    this.uploads[purpose]++;
    if (this.stop === purpose && this.beforeWrite) { this.stop = null; throw new Error("Fixture dispatch interrupted before storage observed"); }
    const result = await super.putPrepared(ref, bytes, submitted);
    submitted(`0x${sha256(bytes)}`);
    if (this.stop === purpose) { this.stop = null; throw new Error("Fixture response lost after storage observed"); }
    return result;
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "persistara-write-test-"));
  const path = join(directory, "runtime", "writes.sqlite");
  const blobs = new FaultBlobs(join(directory, "ciphertext"));
  const heads = new FixtureHeads(); const keys = MemoryKeyring.create();
  let journal = new MemoryWriteJournal(path, binding);
  const memory = () => new MemoryService(binding.agentId, keys, keys.activeEpoch, blobs, heads, { binding });
  return { directory, path, blobs, heads, keys, memory,
    get journal() { return journal; }, writer: () => new DurableMemoryWriter(binding, keys, blobs, heads, journal),
    restart: () => { journal.close(); journal = new MemoryWriteJournal(path, binding, Date.now, false); },
    close: async () => { journal.close(); await rm(directory, { recursive: true, force: true }); } };
}

describe("durable encrypted memory writes and interrupted-operation reconciliation", () => {
  it("commits once, replays the same operation after reopening, and never persists plaintext or keys", async () => {
    const f = await fixture();
    try {
      const receipt = await f.writer().remember(fact());
      assert.equal(receipt.status, "committed"); assert.equal(receipt.version, 1);
      f.restart();
      assert.deepEqual(await f.writer().remember(fact()), receipt);
      assert.equal(f.heads.broadcasts, 1); assert.deepEqual(f.blobs.uploads, { memory: 1, manifest: 1 });
      assert.deepEqual((await f.memory().recover())[0]?.source, fact().source);
      const forbidden = [fact().text, fact().source.reference, Buffer.from(f.keys.key(1)).toString("base64url"), Buffer.from(f.keys.key(1)).toString("hex")];
      for (const file of await readdir(join(f.directory, "runtime"))) {
        const bytes = await readFile(join(f.directory, "runtime", file));
        for (const text of forbidden) assert.equal(bytes.includes(Buffer.from(text)), false);
      }
      for (const text of forbidden) assert.equal(JSON.stringify(receipt).includes(text), false);
      await assert.rejects(f.writer().remember(fact("op:one", "Changed payload")), { code: "OPERATION_CONFLICT" });
    } finally { await f.close(); }
  });
  for (const purpose of ["memory", "manifest"] as const) {
    it(`reconciles a lost ${purpose} upload response from its persisted root without re-uploading`, async () => {
      const f = await fixture();
      try {
        f.blobs.stop = purpose;
        await assert.rejects(f.writer().remember(fact()), { code: "OUTCOME_UNKNOWN" });
        assert.equal(f.heads.value, null);
        const record = f.journal.blob(recordBlobId("op:one")); const originalBytes = record.bytes;
        const root = purpose === "memory" ? record.ref : f.journal.blob(f.journal.attempt("op:one")!.blobId).ref;
        assert.ok(root);
        f.restart();
        const readsOnly = await f.writer().reconcile("op:one");
        assert.equal(readsOnly.status, "pending"); assert.equal(f.heads.broadcasts, 0);
        const result = await f.writer().resume("op:one");
        assert.equal(result.status, "committed");
        assert.deepEqual(f.journal.blob(recordBlobId("op:one")).bytes, originalBytes);
        assert.deepEqual(f.blobs.uploads, { memory: 1, manifest: 1 }); assert.equal(f.heads.broadcasts, 1);
        assert.equal((await f.memory().recover()).length, 1);
      } finally { await f.close(); }
    });
  }
  it("keeps an unavailable dispatched root unknown, fences new writes/cancellation, and handles late availability", async () => {
    const f = await fixture();
    try {
      f.blobs.stop = "memory"; f.blobs.beforeWrite = true;
      await assert.rejects(f.writer().remember(fact()), { code: "OUTCOME_UNKNOWN" });
      f.restart();
      assert.equal((await f.writer().reconcile("op:one")).status, "unknown");
      await assert.rejects(f.writer().resume("op:one"), { code: "OUTCOME_UNKNOWN" });
      await assert.rejects(f.writer().remember(fact("op:two")), { code: "WRITE_BUSY" });
      await assert.rejects(f.writer().cancel("op:one"), { code: "WRITE_PENDING" });
      assert.deepEqual(f.blobs.uploads, { memory: 1, manifest: 0 }); assert.equal(f.heads.broadcasts, 0);
      const persisted = f.journal.blob(recordBlobId("op:one"));
      // A late provider completion, not another application dispatch.
      await f.blobs.put(persisted.bytes);
      assert.equal((await f.writer().resume("op:one")).status, "committed");
      assert.deepEqual(f.blobs.uploads, { memory: 1, manifest: 1 });
    } finally { await f.close(); }
  });
  it("reconciles a checkpoint response lost after inclusion before allowing a new memory operation", async () => {
    const f = await fixture();
    try {
      f.heads.loseResponse = true;
      await assert.rejects(f.writer().remember(fact()), { code: "OUTCOME_UNKNOWN" });
      const plan = f.journal.attempt("op:one")!.plan!;
      assert.equal(f.journal.operation("op:one")?.status, "pending"); assert.equal(f.heads.value?.version, 1);
      f.restart();
      const restored = await f.writer().reconcile("op:one");
      assert.equal(restored.status, "committed"); assert.equal(restored.checkpointOperationId, plan.operationId);
      assert.equal(f.heads.submissions, 1); assert.equal(f.heads.broadcasts, 1);
      assert.equal((await f.writer().remember(fact("op:two", "State uncertainty in research reports."))).version, 2);
      assert.equal((await f.memory().recover()).length, 2); assert.equal(f.heads.broadcasts, 2);
    } finally { await f.close(); }
  });
  it("does not infer failure from an absent head or create replacement transactions for an unknown checkpoint", async () => {
    const f = await fixture();
    try {
      f.heads.unseen = true;
      await assert.rejects(f.writer().remember(fact()), { code: "OUTCOME_UNKNOWN" });
      const plan = f.journal.attempt("op:one")!.plan!;
      f.restart();
      assert.equal((await f.writer().reconcile("op:one")).status, "unknown");
      await assert.rejects(f.writer().resume("op:one"), { code: "OUTCOME_UNKNOWN" });
      await assert.rejects(f.writer().cancel("op:one"), { code: "WRITE_PENDING" });
      assert.equal(f.heads.broadcasts, 1); assert.equal(f.heads.value, null);
      assert.deepEqual(f.journal.attempt("op:one")!.plan, plan);
      f.heads.value = structuredClone(plan.next); f.heads.transactions.set(plan.operationId, true);
      assert.equal((await f.writer().reconcile("op:one")).status, "committed");
      assert.equal(f.heads.broadcasts, 1);
    } finally { await f.close(); }
  });
  it("distinguishes read-only reconciliation from explicitly resuming an interrupted signer allocation", async () => {
    const f = await fixture();
    try {
      f.heads.stopBeforeSubmit = true;
      await assert.rejects(f.writer().remember(fact()), { code: "OUTCOME_UNKNOWN" });
      const plan = f.journal.attempt("op:one")!.plan;
      f.restart();
      assert.equal((await f.writer().reconcile("op:one")).status, "unknown");
      assert.equal(f.heads.broadcasts, 0); assert.equal(f.heads.submissions, 1);
      assert.equal((await f.writer().resume("op:one")).status, "committed");
      assert.deepEqual(f.journal.attempt("op:one")!.plan, plan); assert.equal(f.heads.broadcasts, 1);
    } finally { await f.close(); }
  });
  it("recovers a journal write failure after storage completes without repeating the external upload", async () => {
    const f = await fixture();
    try {
      f.journal.available = () => { throw new Error("Injected disk failure after upload"); };
      await assert.rejects(f.writer().remember(fact()), { code: "OUTCOME_UNKNOWN" });
      assert.equal(f.heads.value, null);
      f.restart();
      assert.equal((await f.writer().resume("op:one")).status, "committed");
      assert.deepEqual(f.blobs.uploads, { memory: 1, manifest: 1 });
    } finally { await f.close(); }
  });
  it("merges a CAS loser into the newer committed manifest while reusing its record ciphertext", async () => {
    const f = await fixture();
    try {
      f.heads.beforeSubmit = async () => { await f.memory().remember(fact("op:other", "Count pending research reservations.")); };
      const result = await f.writer().remember(fact());
      assert.equal(result.version, 2); assert.equal(f.heads.broadcasts, 2);
      assert.deepEqual(f.blobs.uploads, { memory: 1, manifest: 2 });
      const records = await f.memory().recover();
      assert.equal(records.length, 2); assert.deepEqual(new Set(records.map((r) => r.operationId)), new Set(["op:one", "op:other"]));
    } finally { await f.close(); }
  });
  it("adopts a matching canonical duplicate without uploading and rejects a conflicting canonical payload", async () => {
    const f = await fixture();
    try {
      const original = await f.memory().remember(fact());
      const duplicate = await f.writer().remember(fact());
      assert.equal(duplicate.status, "committed"); assert.equal(duplicate.recordId, original.recordId);
      assert.deepEqual(f.blobs.uploads, { memory: 0, manifest: 0 });
      await f.memory().remember(fact("op:conflict", "Canonical payload"));
      await assert.rejects(f.writer().remember(fact("op:conflict", "Conflicting payload")), { code: "OPERATION_CONFLICT" });
      assert.equal(f.journal.operation("op:conflict")?.status, "conflict");
      assert.equal((await f.memory().recover()).length, 2);
    } finally { await f.close(); }
  });
  it("records terminal transaction failure without resubmission or claiming a committed memory", async () => {
    const f = await fixture();
    try {
      f.heads.fail = true;
      assert.equal((await f.writer().remember(fact())).status, "failed");
      f.restart();
      assert.equal((await f.writer().resume("op:one")).status, "failed");
      assert.equal(f.heads.broadcasts, 1); assert.equal(f.heads.value, null);
      f.heads.fail = false;
      assert.equal((await f.writer().remember(fact("op:two"))).status, "committed");
    } finally { await f.close(); }
  });
  it("recognizes a matching canonical operation even if this writer's competing checkpoint transaction failed", async () => {
    const f = await fixture();
    try {
      let canonicalId: string | undefined;
      f.heads.beforeSubmit = async () => { canonicalId = (await f.memory().remember(fact())).recordId; };
      f.heads.fail = true;
      const receipt = await f.writer().remember(fact());
      assert.equal(receipt.status, "committed"); assert.equal(receipt.recordId, canonicalId);
      assert.equal((await f.memory().recover()).length, 1); assert.equal(f.heads.broadcasts, 1);
    } finally { await f.close(); }
  });
  it("keeps a preflight configuration failure undispatched and resumes safely after it is fixed", async () => {
    const f = await fixture();
    try {
      f.blobs.assertUploadReady = async () => { throw new ProviderError("NOT_CONFIGURED", "Fixture uploader configuration missing"); };
      await assert.rejects(f.writer().remember(fact()), { code: "NOT_CONFIGURED" });
      const before = f.journal.blob(recordBlobId("op:one"));
      assert.equal(before.state, "ready"); assert.deepEqual(f.blobs.uploads, { memory: 0, manifest: 0 });
      f.blobs.assertUploadReady = async () => {};
      assert.equal((await f.writer().resume("op:one")).status, "committed");
      assert.deepEqual(f.journal.blob(recordBlobId("op:one")).bytes, before.bytes);
      assert.deepEqual(f.blobs.uploads, { memory: 1, manifest: 1 });
    } finally { await f.close(); }
  });
  it("cancels an undispatched write without reusing its operation ID or authorizing another effect", async () => {
    const f = await fixture();
    try {
      f.heads.paused = true;
      await assert.rejects(f.writer().remember(fact()), { code: "AUTHORIZATION_FAILED" });
      assert.deepEqual(f.blobs.uploads, { memory: 0, manifest: 0 });
      assert.equal((await f.writer().cancel("op:one")).status, "canceled");
      f.heads.paused = false;
      assert.equal((await f.writer().remember(fact())).status, "canceled");
      assert.equal((await f.writer().remember(fact("op:two"))).status, "committed");
    } finally { await f.close(); }
  });
  it("rejects invalid revision targets before an upload and preserves the last healthy recall cache", async () => {
    const f = await fixture();
    const index = new MemoryRecallIndex(join(f.directory, "cache", "recall.sqlite"), binding);
    try {
      await f.writer().remember(fact()); const old = await f.memory().recoverSnapshot(); index.replace(old);
      await assert.rejects(f.writer().remember({ ...fact("op:bad"), supersedes: "mem:missing" }), { code: "INVALID_INPUT" });
      assert.deepEqual(f.blobs.uploads, { memory: 1, manifest: 1 });
      assert.equal(index.search("primary sources", old.head).matches.length, 1);
      await f.writer().cancel("op:bad");
      await f.writer().remember(fact("op:two", "New research fact"));
      assert.throws(() => index.search("primary sources", f.heads.value), { code: "INDEX_STALE" });
      index.replace(await f.memory().recoverSnapshot());
      assert.equal(index.search("research", f.heads.value).matches.length, 2);
    } finally { index.close(); await f.close(); }
  });
  it("preserves historical key epochs and revision references during durable appends", async () => {
    const f = await fixture();
    try {
      const original = await f.writer().remember(fact());
      const nextKeys = f.keys.nextEpoch(); f.heads.epoch = 2;
      const writer = new DurableMemoryWriter(binding, nextKeys, f.blobs, f.heads, f.journal);
      await writer.remember({ ...fact("op:revision", "Research must cite primary sources and state uncertainty."), supersedes: original.recordId });
      const records = await new MemoryService(binding.agentId, nextKeys, 2, f.blobs, f.heads, { binding }).recover();
      assert.deepEqual(records.map((r) => r.keyEpoch), [1, 2]); assert.equal(records[1]?.supersedes, records[0]?.id);
    } finally { await f.close(); }
  });
  it("fails closed on wrong keys or corrupted encrypted intents before dispatch", async () => {
    const f = await fixture();
    try {
      f.heads.paused = true;
      await assert.rejects(f.writer().remember(fact()), { code: "AUTHORIZATION_FAILED" });
      f.heads.paused = false;
      await assert.rejects(new DurableMemoryWriter(binding, MemoryKeyring.create(), f.blobs, f.heads, f.journal).resume("op:one"), { code: "AUTHENTICATION_FAILED" });
      const db = new DatabaseSync(f.path);
      try { db.prepare("UPDATE write_operations SET digest=? WHERE id=?").run("f".repeat(64), "op:one"); } finally { db.close(); }
      await assert.rejects(f.writer().resume("op:one"), { code: "INTEGRITY_FAILED" });
      assert.deepEqual(f.blobs.uploads, { memory: 0, manifest: 0 }); assert.equal(f.heads.broadcasts, 0);
    } finally { await f.close(); }
  });
  it("rejects foreign prepared roots before dispatch and never publishes corrupt downloaded bytes", async () => {
    const f = await fixture();
    try {
      const prepare = f.blobs.prepare.bind(f.blobs);
      f.blobs.prepare = async (bytes) => ({ ...await prepare(bytes), network: "foreign" });
      await assert.rejects(f.writer().remember(fact()), { code: "INTEGRITY_FAILED" });
      assert.deepEqual(f.blobs.uploads, { memory: 0, manifest: 0 });
      f.blobs.prepare = prepare;
      f.blobs.get = async () => new Uint8Array([1, 2, 3]);
      await assert.rejects(f.writer().resume("op:one"), { code: "INTEGRITY_FAILED" });
      assert.equal(f.heads.broadcasts, 0);
      await assert.rejects(f.writer().cancel("op:one"), { code: "WRITE_PENDING" });
    } finally { await f.close(); }
  });
});

describe("private memory journal scope and lease fencing", () => {
  it("rejects another agent/network, unsafe files, future schema versions and a missing resumed journal", async () => {
    const f = await fixture();
    try {
      assert.throws(() => new MemoryWriteJournal(f.path, { ...binding, agentId: "owner.fixture:other" }), { code: "AUTHENTICATION_FAILED" });
      assert.throws(() => new DurableMemoryWriter({ ...binding, agentId: "owner.fixture:other" }, f.keys, f.blobs, f.heads, f.journal), { code: "AUTHENTICATION_FAILED" });
      assert.throws(() => new MemoryWriteJournal(join(f.directory, "missing.sqlite"), binding, Date.now, false));
      const link = join(f.directory, "linked.sqlite"); await symlink(f.path, link);
      assert.throws(() => new MemoryWriteJournal(link, binding));
      await chmod(f.path, 0o644); assert.throws(() => new MemoryWriteJournal(f.path, binding), { code: "INVALID_INPUT" }); await chmod(f.path, 0o600);
      const db = new DatabaseSync(f.path); db.exec("PRAGMA user_version=99"); db.close();
      assert.throws(() => new MemoryWriteJournal(f.path, binding), { code: "INVALID_INPUT" });
    } finally { await f.close(); }
  });
  it("allows one process at a time and fences an expired holder after a new process acquires the journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "persistara-lease-test-"));
    let now = 1000;
    const one = new MemoryWriteJournal(join(directory, "journal.sqlite"), binding, () => now);
    const two = new MemoryWriteJournal(join(directory, "journal.sqlite"), binding, () => now, false);
    try {
      const old = one.acquire(100);
      assert.throws(() => two.acquire(100), { code: "WRITE_BUSY" });
      now += 101;
      const current = two.acquire(100);
      assert.ok(current.fence > old.fence);
      assert.throws(() => one.renew(old, 100), { code: "LEASE_LOST" });
      assert.throws(() => one.create(old, { id: "op:stale", digest: "a".repeat(64), recordId: "mem:stale", keyEpoch: 1, bytes: new Uint8Array([1]) }), { code: "LEASE_LOST" });
      one.release(old);
      assert.throws(() => one.acquire(100), { code: "WRITE_BUSY" });
      two.release(current);
      assert.ok(one.acquire(100).fence > current.fence);
    } finally { one.close(); two.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("stops a stale writer returning from preparation before it can dispatch an upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "persistara-stale-writer-"));
    let now = 1000;
    const journal = new MemoryWriteJournal(join(directory, "journal.sqlite"), binding, () => now);
    const heads = new FixtureHeads(); const keys = MemoryKeyring.create(); const blobs = new FaultBlobs(join(directory, "blobs"));
    let unblock!: () => void; let reached!: () => void;
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const prepare = blobs.prepare.bind(blobs);
    let first = true;
    blobs.prepare = async (bytes) => { if (first) { first = false; reached(); await wait; } return prepare(bytes); };
    const stale = new DurableMemoryWriter(binding, keys, blobs, heads, journal, 120).remember(fact());
    // Attach the rejection assertion before releasing the suspended old process.
    const stopped = assert.rejects(stale, { code: "LEASE_LOST" });
    try {
      await ready; now += 121;
      const current = new DurableMemoryWriter(binding, keys, blobs, heads, journal, 120);
      assert.equal((await current.resume("op:one")).status, "committed");
      unblock(); await stopped;
      assert.deepEqual(blobs.uploads, { memory: 1, manifest: 1 }); assert.equal(heads.broadcasts, 1);
    } finally { unblock(); await stopped; journal.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("reconciles a late upload once while fencing the original expired process from publishing its outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "persistara-late-upload-"));
    let now = 1000;
    const journal = new MemoryWriteJournal(join(directory, "journal.sqlite"), binding, () => now);
    const heads = new FixtureHeads(); const keys = MemoryKeyring.create(); const blobs = new FaultBlobs(join(directory, "blobs"));
    let unblock!: () => void; let reached!: () => void;
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const upload = blobs.putPrepared.bind(blobs); let first = true;
    blobs.putPrepared = async (...args) => {
      const result = await upload(...args);
      if (first) { first = false; reached(); await wait; }
      return result;
    };
    const stale = new DurableMemoryWriter(binding, keys, blobs, heads, journal, 120).remember(fact());
    const stopped = assert.rejects(stale, { code: "LEASE_LOST" });
    try {
      await ready; now += 121;
      const current = new DurableMemoryWriter(binding, keys, blobs, heads, journal, 120);
      assert.equal((await current.reconcile("op:one")).status, "pending");
      assert.equal((await current.resume("op:one")).status, "committed");
      unblock(); await stopped;
      assert.deepEqual(blobs.uploads, { memory: 1, manifest: 1 }); assert.equal(heads.broadcasts, 1);
    } finally { unblock(); await stopped; journal.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("stops new dispatches immediately when lease renewal fails", async () => {
    const f = await fixture();
    let unblock!: () => void; let renewed!: () => void; let reached!: () => void;
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    const renewal = new Promise<void>((resolve) => { renewed = resolve; });
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const prepare = f.blobs.prepare.bind(f.blobs);
    f.blobs.prepare = async (bytes) => { reached(); await wait; return prepare(bytes); };
    f.journal.renew = () => { renewed(); throw new Error("Injected SQL renewal failure"); };
    const pending = new DurableMemoryWriter(binding, f.keys, f.blobs, f.heads, f.journal, 120).remember(fact());
    const stopped = assert.rejects(pending, { code: "LEASE_LOST" });
    try {
      await ready; await renewal; unblock(); await stopped;
      assert.deepEqual(f.blobs.uploads, { memory: 0, manifest: 0 }); assert.equal(f.heads.broadcasts, 0);
    } finally { unblock(); await stopped; await f.close(); }
  });
});
