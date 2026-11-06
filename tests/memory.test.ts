import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MemoryService, type RememberInput } from "../packages/memory/src/service.js";
import { LocalBlobStore } from "../packages/storage/src/local.js";
import { sha256 } from "../packages/crypto/src/envelope.js";
import { MemoryError, type BlobRef, type BlobStore, type MemoryHead, type MemoryHeadStore } from "../packages/protocol/src/memory.js";

/** Atomic in-memory registry fixture; intentionally not a NEAR implementation. */
class TestHeads implements MemoryHeadStore {
  readonly values = new Map<string, MemoryHead>();
  async get(agentId: string): Promise<MemoryHead | null> { return structuredClone(this.values.get(agentId) ?? null); }
  async compareAndSwap(agentId: string, expected: number, next: MemoryHead): Promise<boolean> {
    if ((this.values.get(agentId)?.version ?? 0) !== expected) return false;
    assert.equal(next.version, expected + 1);
    this.values.set(agentId, structuredClone(next));
    return true;
  }
}

class TestBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = sha256(bytes);
    this.values.set(digest, Uint8Array.from(bytes));
    return { provider: "local", network: "local", objectId: digest, ciphertextSha256: digest, byteLength: bytes.length };
  }
  async get(ref: BlobRef): Promise<Uint8Array> {
    const bytes = this.values.get(ref.objectId);
    if (!bytes) throw new Error("Test blob missing");
    return Uint8Array.from(bytes);
  }
}

function fact(operationId = "op:one", text = "Use primary sources in research reports."): RememberInput {
  return { operationId, text, source: { kind: "owner", reference: "conversation:one" } };
}

function fixture() {
  const key = randomBytes(32);
  const heads = new TestHeads();
  const blobs = new TestBlobs();
  const memory = new MemoryService("agent:alice", key, 1, blobs, heads);
  return { key, heads, blobs, memory };
}

describe("recoverable encrypted memory", () => {
  it("recovers all committed records into a fresh service without an index or local history", async () => {
    const { key, heads, blobs, memory } = fixture();
    const one = await memory.remember(fact());
    await memory.remember(fact("op:two", "Prefer reports with explicit uncertainty."));
    const fresh = new MemoryService("agent:alice", key, 1, blobs, heads);
    const recovered = await fresh.recover();
    assert.equal(recovered.length, 2);
    assert.equal(recovered[0]?.id, one.recordId);
    assert.equal(recovered[0]?.text, fact().text);
    assert.deepEqual(recovered[0]?.source, fact().source);
    for (const bytes of blobs.values.values()) assert.equal(Buffer.from(bytes).includes(Buffer.from(fact().text)), false);
  });

  it("deduplicates an identical operation and rejects operation ID reuse with another payload", async () => {
    const { memory, heads, blobs } = fixture();
    const first = await memory.remember(fact());
    const count = blobs.values.size;
    const duplicate = await memory.remember(fact());
    assert.equal(duplicate.recordId, first.recordId);
    assert.equal(duplicate.duplicate, true);
    assert.equal(blobs.values.size, count);
    assert.equal((await heads.get("agent:alice"))?.version, 1);
    await assert.rejects(memory.remember(fact("op:one", "A different fact.")), { code: "OPERATION_CONFLICT" });
  });

  it("merges concurrent writes without losing a committed record", async () => {
    const { memory, heads } = fixture();
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => memory.remember(fact(`op:${index}`, `Fact ${index}.`))));
    assert.equal(new Set(results.map((result) => result.recordId)).size, 6);
    assert.equal((await memory.recover()).length, 6);
    assert.equal((await heads.get("agent:alice"))?.version, 6);
  });

  it("deduplicates simultaneous deliveries of the same action", async () => {
    const { memory, heads } = fixture();
    const results = await Promise.all([memory.remember(fact()), memory.remember(fact())]);
    assert.equal(results[0]?.recordId, results[1]?.recordId);
    assert.equal((await memory.recover()).length, 1);
    assert.equal((await heads.get("agent:alice"))?.version, 1);
  });

  it("does not advance the checkpoint when upload or read-after-write fails", async () => {
    for (const failurePoint of ["put", "get"] as const) {
      const heads = new TestHeads();
      const original = new TestBlobs();
      const blobs: BlobStore = {
        put: async (bytes) => {
          if (failurePoint === "put") throw new Error("Upload unavailable");
          return original.put(bytes);
        },
        get: async () => { throw new Error("Read unavailable"); },
      };
      const memory = new MemoryService("agent:alice", randomBytes(32), 1, blobs, heads);
      await assert.rejects(memory.remember(fact()));
      assert.equal(await heads.get("agent:alice"), null);
    }
  });

  it("reconciles a successful checkpoint whose response was lost, without duplicating memory", async () => {
    const { key, heads, blobs } = fixture();
    let loseResponse = true;
    const unreliable: MemoryHeadStore = {
      get: (id) => heads.get(id),
      compareAndSwap: async (id, expected, next) => {
        const committed = await heads.compareAndSwap(id, expected, next);
        if (loseResponse) { loseResponse = false; throw new Error("Connection lost after commit"); }
        return committed;
      },
    };
    const first = new MemoryService("agent:alice", key, 1, blobs, unreliable);
    await assert.rejects(first.remember(fact()), /Connection lost/);
    const recovered = new MemoryService("agent:alice", key, 1, blobs, heads);
    assert.equal((await recovered.remember(fact())).duplicate, true);
    assert.equal((await recovered.recover()).length, 1);
    assert.equal((await heads.get("agent:alice"))?.version, 1);
  });

  it("rejects corruption even when a storage adapter omits its own integrity check", async () => {
    const { memory, heads, blobs } = fixture();
    await memory.remember(fact());
    const head = await heads.get("agent:alice");
    assert.ok(head);
    const bytes = blobs.values.get(head.manifest.objectId)!;
    bytes[0] = bytes[0]! ^ 1;
    await assert.rejects(memory.recover(), { code: "INTEGRITY_FAILED" });
  });

  it("rejects incorrect keys, wrong key epochs, and another agent's checkpoint", async () => {
    const { key, memory, heads, blobs } = fixture();
    await memory.remember(fact());
    await assert.rejects(new MemoryService("agent:alice", randomBytes(32), 1, blobs, heads).recover(), { code: "AUTHENTICATION_FAILED" });
    await assert.rejects(new MemoryService("agent:alice", key, 2, blobs, heads).recover(), { code: "KEY_EPOCH_MISMATCH" });
    heads.values.set("agent:bob", (await heads.get("agent:alice"))!);
    await assert.rejects(new MemoryService("agent:bob", key, 1, blobs, heads).recover(), { code: "AUTHENTICATION_FAILED" });
  });

  it("preserves revision lineage and refuses a nonexistent revision target", async () => {
    const { memory } = fixture();
    const initial = await memory.remember(fact());
    await memory.remember({ ...fact("op:revision", "Use dated primary sources."), supersedes: initial.recordId });
    const records = await memory.recover();
    assert.equal(records[1]?.supersedes, initial.recordId);
    await assert.rejects(memory.remember({ ...fact("op:invalid"), supersedes: "mem:missing" }), { code: "INVALID_INPUT" });
  });

  it("rejects invalid content and ends bounded checkpoint contention", async () => {
    const { key, blobs, memory } = fixture();
    await assert.rejects(memory.remember(fact("../bad")), { code: "INVALID_INPUT" });
    await assert.rejects(memory.remember(fact("op:empty", " ")), { code: "INVALID_INPUT" });
    await assert.rejects(memory.remember(fact("op:big", "x".repeat(65_537))), { code: "INVALID_INPUT" });
    const heads: MemoryHeadStore = { get: async () => null, compareAndSwap: async () => false };
    await assert.rejects(new MemoryService("agent:alice", key, 1, blobs, heads).remember(fact()), { code: "CHECKPOINT_CONFLICT" });
  });

  it("snapshots caller-owned input and key bytes", async () => {
    const { key, memory } = fixture();
    const input = fact();
    const originalText = input.text;
    const pending = memory.remember(input);
    input.text = "changed after request";
    input.source.reference = "changed";
    key.fill(0);
    await pending;
    const records = await memory.recover();
    assert.equal(records[0]?.text, originalText);
    assert.equal(records[0]?.source.reference, "conversation:one");
  });
});

describe("local development blob adapter", () => {
  it("stores ciphertext on disk, survives a fresh adapter, and detects modified files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "persistara-test-"));
    try {
      const key = randomBytes(32);
      const heads = new TestHeads();
      await new MemoryService("agent:alice", key, 1, new LocalBlobStore(directory), heads).remember(fact());
      const head = (await heads.get("agent:alice"))!;
      const fresh = new MemoryService("agent:alice", key, 1, new LocalBlobStore(directory), heads);
      assert.equal((await fresh.recover())[0]?.text, fact().text);
      const manifestPath = join(directory, head.manifest.objectId);
      const stored = await readFile(manifestPath);
      stored[0] = stored[0]! ^ 1;
      await writeFile(manifestPath, stored);
      await assert.rejects(fresh.recover(), { code: "INTEGRITY_FAILED" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects foreign providers and traversal identifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "persistara-test-"));
    try {
      const blobs = new LocalBlobStore(directory);
      const ref = await blobs.put(Buffer.from("ciphertext fixture"));
      await assert.rejects(blobs.get({ ...ref, objectId: "../secret" }), MemoryError);
      await assert.rejects(blobs.get({ ...ref, provider: "0g" }), MemoryError);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
