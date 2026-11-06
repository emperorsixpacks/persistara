/** Explicit local fixture: disk checkpoints are not a blockchain, and these blobs are not 0G. */
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryService } from "../../packages/memory/src/service.js";
import { MemoryKeyring } from "../../packages/memory/src/keyring.js";
import { createOwnerBackup, encodePrivateKeyring, verifyOwnerBackup } from "../../packages/memory/src/backup.js";
import { readPrivateFile, writePrivateFile } from "../../packages/memory/src/files.js";
import { MemoryRecallIndex } from "../../packages/memory/src/index.js";
import { rebuildFromOwnerBackup, recallCommitted } from "../../packages/memory/src/recovery.js";
import type { MemoryBinding } from "../../packages/memory/src/binding.js";
import { MemoryError, type MemoryHead, type MemoryHeadStore } from "../../packages/protocol/src/memory.js";
import { LocalBlobStore } from "../../packages/storage/src/local.js";

const binding: MemoryBinding = { agentId: "owner.fixture:research", authorityNetwork: "fixture:local", chainId: "fixture", contractId: "authority.fixture", storageNetwork: "local" };
class DiskFixtureHeads implements MemoryHeadStore {
  constructor(private readonly path: string) {}
  async get(): Promise<MemoryHead | null> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as MemoryHead; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
  }
  async compareAndSwap(_id: string, expected: number, next: MemoryHead): Promise<boolean> {
    if (((await this.get())?.version ?? 0) !== expected) return false;
    await writeFile(this.path, JSON.stringify(next), { mode: 0o600 }); return true;
  }
}
async function main(): Promise<void> {
  const [mode, root] = process.argv.slice(2);
  assert.ok(root && (mode === "create" || mode === "recover"));
  const heads = new DiskFixtureHeads(join(root, "fixture-head.json"));
  const blobs = new LocalBlobStore(join(root, "fixture-ciphertext"));
  const bundlePath = join(root, "owner-backup", "memory.bundle");
  const secretPath = join(root, "owner-secret", "recovery.key");
  if (mode === "create") {
    const initial = MemoryKeyring.create();
    const one = new MemoryService(binding.agentId, initial, 1, blobs, heads, { binding });
    const old = await one.remember({ operationId: "op:old", text: "Use broad research sources.", source: { kind: "owner", reference: "fixture:owner-research" } });
    const keys = initial.nextEpoch();
    const backup = createOwnerBackup(binding, keys);
    // Persist and verify the new backup before the fixture activates epoch 2.
    await writePrivateFile(secretPath, Buffer.from(backup.recoverySecret));
    await writePrivateFile(bundlePath, backup.bundle);
    verifyOwnerBackup(await readPrivateFile(bundlePath), Buffer.from(await readPrivateFile(secretPath)).toString(), binding, keys);
    await writePrivateFile(join(root, "original-runtime", "memory-keyring.json"), encodePrivateKeyring(binding, keys));
    const memory = new MemoryService(binding.agentId, keys, 2, blobs, heads, { binding });
    await memory.remember({ operationId: "op:budget", text: "A mission budget must include pending reservations.", source: { kind: "tool", reference: "fixture:contract-policy" } });
    await memory.remember({ operationId: "op:revision", text: "Use dated primary research sources.", source: { kind: "owner", reference: "fixture:owner-research" }, supersedes: old.recordId });
    const index = new MemoryRecallIndex(join(root, "original-runtime", "cache", "recall.sqlite"), binding);
    try { index.replace(await memory.recoverSnapshot()); } finally { index.close(); }
    console.log(JSON.stringify({ evidence: "LOCAL_FIXTURE_ONLY", phase: mode, version: 3, records: 3, keyEpochs: [1, 2] }));
  } else {
    await assert.rejects(stat(join(root, "original-runtime")), { code: "ENOENT" });
    const state = join(root, "recovered-runtime"); await mkdir(state, { mode: 0o700 });
    const index = new MemoryRecallIndex(join(state, "recall.sqlite"), binding);
    try {
      const readOnlyBlobs = { get: (ref: Parameters<LocalBlobStore["get"]>[0]) => blobs.get(ref), put: async (): Promise<never> => { throw new Error("Recovery must not upload"); } };
      const result = await rebuildFromOwnerBackup({ binding, bundle: await readPrivateFile(bundlePath), recoverySecret: Buffer.from(await readPrivateFile(secretPath)).toString(), blobs: readOnlyBlobs, heads, index });
      assert.equal(result.recordCount, 3); assert.equal(result.currentCount, 2); assert.equal(result.version, 3);
      assert.deepEqual(result.recoveredEpochs, [1, 2]);
      const recall = await recallCommitted(index, heads, binding.agentId, "dated primary");
      assert.equal(recall.matches[0]?.source.reference, "fixture:owner-research");
      assert.equal(recall.matches[0]?.operationId, "op:revision");
      assert.equal(recall.matches[0]?.untrusted, true);
      const history = await recallCommitted(index, heads, binding.agentId, "research sources", { includeSuperseded: true });
      assert.equal(history.matches.length, 2);
      assert.equal((await recallCommitted(index, heads, binding.agentId, "budget reservations")).matches.length, 1);
      console.log(JSON.stringify({ evidence: "LOCAL_FIXTURE_ONLY", phase: mode, version: result.version, records: result.recordCount, currentFacts: result.currentCount,
        recoveredEpochs: result.recoveredEpochs, uploaderKeyUsed: false, signingKeyUsed: false, originalStateAvailable: false }));
    } finally { index.close(); }
  }
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "failed", code: error instanceof MemoryError ? error.code : "FIXTURE_ASSERTION_FAILED" })); process.exitCode = 1;
});
