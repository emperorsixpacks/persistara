import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { baseEncode } from "near-api-js";
import { decodePrivateKeyring, restoreOwnerBackup } from "../packages/memory/src/backup.js";
import { readPrivateFile, writePrivateFile } from "../packages/memory/src/files.js";
import { MemoryRecallIndex } from "../packages/memory/src/index.js";
import { rebuildFromOwnerBackup } from "../packages/memory/src/recovery.js";
import { MemoryService } from "../packages/memory/src/service.js";
import { DurableMemoryWriter } from "../packages/memory/src/writer.js";
import { MemoryWriteJournal } from "../packages/memory/src/write-journal.js";
import { canonical, validateCall, type ContractCall } from "../packages/near/src/protocol.js";
import { NearRotationReader } from "../packages/near/src/rotation.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { rotationFixture } from "./fixtures/rotation-support.js";

async function applyNext(f: Awaited<ReturnType<typeof rotationFixture>>, expected: string) {
  const next = await f.rotation().next(f.input.stateDir);
  assert.equal(next.status, "awaiting-owner-wallet");
  if (next.status !== "awaiting-owner-wallet") throw new Error("Fixture expected an unsigned owner request");
  assert.equal(next.stage, expected); f.authority.apply(next.request); f.restart(); return next;
}
async function completeAuthority(f: Awaited<ReturnType<typeof rotationFixture>>) {
  for (const stage of ["begin", "remove-old-key", "install-new-key", "finish"]) await applyNext(f, stage);
  assert.equal((await f.rotation().next(f.input.stateDir)).status, "authority-complete");
}
async function appendNextEpoch(f: Awaited<ReturnType<typeof rotationFixture>>) {
  const plan = await f.rotation().load(f.input.stateDir);
  const keys = decodePrivateKeyring(await readPrivateFile(plan.intent.nextKeyringFile), f.binding);
  const writer = new DurableMemoryWriter(f.binding, keys, f.blobs, f.authority.heads(plan.request.replacement.publicKey), f.memoryJournal);
  return writer.remember({ operationId: "memory:after-rotation", text: "State uncertainty and retain dated primary sources.", source: { kind: "owner", reference: "fixture:post-rotation" } });
}

describe("owner-controlled runtime revocation and memory epoch rotation", () => {
  it("prepares distinct keys/backups, rotates through owner requests, and recovers old and new memory", async () => {
    const f = await rotationFixture(); const priorHead = structuredClone(f.authority.snapshot.head);
    try {
      const plan = await f.rotation().prepare(f.input);
      assert.equal(f.authority.snapshot.keyEpoch, 1); assert.equal(f.authority.snapshot.paused, false);
      assert.equal(f.memoryJournal.controls().heldBy, f.input.operationId);
      assert.notEqual(plan.request.replacement.publicKey, f.config.publicKey); assert.notEqual(plan.request.replacement.publicKey, f.authority.snapshot.ownerKey);
      const prepared = decodePrivateKeyring(await readPrivateFile(plan.intent.nextKeyringFile), f.binding);
      assert.deepEqual(prepared.epochs(), [1, 2]); assert.deepEqual(prepared.key(1), f.keys.key(1));
      await completeAuthority(f);
      assert.equal(f.memoryJournal.controls().minimumEpoch, 2); assert.equal(f.memoryJournal.controls().heldBy, null);
      assert.equal(f.authority.snapshot.keyEpoch, 2); assert.deepEqual(f.authority.snapshot.head, priorHead);
      await assert.rejects(new DurableMemoryWriter(f.binding, f.keys, f.blobs, f.authority.heads(f.config.publicKey), f.memoryJournal).remember({ operationId: "memory:stale", text: "Rejected stale runtime", source: { kind: "owner", reference: "fixture:old" } }), { code: "KEY_EPOCH_MISMATCH" });
      await appendNextEpoch(f);
      assert.deepEqual(await f.rotation().verify(f.input.stateDir), { status: "verified", version: 2, recoveredRecords: 2, historicalRecords: 1, nextEpoch: 2 });
      const bundle = await readPrivateFile(f.input.bundleFile); const secret = Buffer.from(await readPrivateFile(f.input.secretFile)).toString().trim();
      const restored = restoreOwnerBackup(bundle, secret, f.binding); assert.deepEqual(restored.epochs(), [1, 2]);
      const index = new MemoryRecallIndex(join(f.directory, "fresh-cache", "recall.sqlite"), f.binding);
      try {
        const readOnlyBlobs = { get: (ref: Parameters<typeof f.blobs.get>[0]) => f.blobs.get(ref), put: async (): Promise<never> => { throw new Error("Recovery must not upload"); } };
        const result = await rebuildFromOwnerBackup({ binding: f.binding, bundle, recoverySecret: secret, blobs: readOnlyBlobs, heads: { get: async () => f.authority.snapshot.head }, index });
        assert.equal(result.recordCount, 2); assert.equal(index.search("dated primary sources", f.authority.snapshot.head).matches.length, 2);
      } finally { index.close(); }
      await assert.rejects(new MemoryService(f.binding.agentId, f.keys, 1, f.blobs, f.authority.heads(f.config.publicKey), { binding: f.binding }).recover(), { code: "KEY_EPOCH_MISMATCH" });
      const current = await f.rotation().next(f.input.stateDir); assert.equal(current.status, "authority-complete");
      if (current.status === "authority-complete") assert.equal(current.memoryVerificationRequired, false);
    } finally { await f.close(); }
  });
  it("replays identical wallet requests after restart and advances from finalized state when responses were lost", async () => {
    const f = await rotationFixture();
    try {
      await f.rotation().prepare(f.input);
      for (const stage of ["begin", "remove-old-key", "install-new-key", "finish"]) {
        const first = await f.rotation().next(f.input.stateDir); f.restart();
        assert.deepEqual(await f.rotation().next(f.input.stateDir), first);
        assert.equal(first.status, "awaiting-owner-wallet");
        if (first.status !== "awaiting-owner-wallet") throw new Error("Fixture expected owner request");
        assert.equal(first.stage, stage);
        f.authority.apply(first.request); // Deliberately no application acknowledgement or transaction return value.
        f.restart();
      }
      assert.equal((await f.rotation().next(f.input.stateDir)).status, "authority-complete");
      assert.equal(f.authority.snapshot.keyEpoch, 2); assert.equal(f.authority.snapshot.generation, "4");
      for (const stage of ["begin", "remove-old-key", "install-new-key", "finish"]) {
        const receipt = JSON.parse(Buffer.from(await readPrivateFile(join(f.input.stateDir, `observed-${stage}.json`))).toString());
        assert.equal(receipt.status, "finalized-state-observed");
      }
    } finally { await f.close(); }
  });
  it("keeps the old contract grant revoked and the agent paused until account-key cleanup is complete", async () => {
    const f = await rotationFixture();
    try {
      await f.rotation().prepare(f.input); const plan = await f.rotation().load(f.input.stateDir);
      await applyNext(f, "begin");
      assert.equal(f.authority.snapshot.paused, true); assert.equal(f.authority.snapshot.delegates.some((d) => d.publicKey === f.config.publicKey), false);
      await assert.rejects(f.authority.heads(f.config.publicKey).assertWritable(1), { code: "AUTHORIZATION_FAILED" });
      await assert.rejects(f.authority.heads(plan.request.replacement.publicKey).assertWritable(2), { code: "AUTHORIZATION_FAILED" });
      await applyNext(f, "remove-old-key"); await applyNext(f, "install-new-key");
      f.authority.snapshot.accessKeys.find((k) => k.publicKey === plan.request.replacement.publicKey)!.nonce = 123_000_000;
      assert.equal(f.authority.snapshot.paused, true);
      const next = await f.rotation().next(f.input.stateDir); assert.equal(next.status, "awaiting-owner-wallet");
      if (next.status === "awaiting-owner-wallet") assert.equal(next.stage, "finish");
    } finally { await f.close(); }
  });
  it("stops planned rotation on pending memory work and preserves preparation keys across a safe retry", async () => {
    const f = await rotationFixture();
    try {
      f.authority.snapshot.paused = true;
      const writer = new DurableMemoryWriter(f.binding, f.keys, f.blobs, f.authority.heads(f.config.publicKey), f.memoryJournal);
      await assert.rejects(writer.remember({ operationId: "memory:queued", text: "Pending work", source: { kind: "owner", reference: "fixture:pending" } }), { code: "AUTHORIZATION_FAILED" });
      await assert.rejects(f.rotation().prepare(f.input), { code: "WRITE_PENDING" });
      const keyBytes = await readPrivateFile(join(f.input.stateDir, "next-memory.json")); const runtimeBytes = await readPrivateFile(join(f.input.stateDir, "next-runtime.key"));
      const recoverySecret = await readPrivateFile(f.input.secretFile);
      await rm(f.input.bundleFile); // Model interruption between separate secret/bundle file writes before any wallet request exists.
      assert.equal((await writer.cancel("memory:queued")).status, "canceled"); f.authority.snapshot.paused = false;
      await f.rotation().prepare(f.input);
      assert.deepEqual(await readPrivateFile(join(f.input.stateDir, "next-memory.json")), keyBytes); assert.deepEqual(await readPrivateFile(join(f.input.stateDir, "next-runtime.key")), runtimeBytes);
      assert.deepEqual(await readPrivateFile(f.input.secretFile), recoverySecret);
    } finally { await f.close(); }
  });
  it("blocks new memory and signer work while held, and refuses rotation over an unresolved signer operation", async () => {
    const f = await rotationFixture();
    try {
      const call: ContractCall = { method: "checkpoint_memory", args: { agent_id: f.config.agentId, generation: "2", expected_version: "1", next: { version: "2", keyEpoch: "1", manifest: f.authority.snapshot.head!.manifest } } };
      f.signerJournal.allocate("checkpoint:pending", call, "1", baseEncode(Buffer.alloc(32, 4)));
      await assert.rejects(f.rotation().prepare(f.input), { code: "SIGNER_BUSY" });
      assert.equal(f.memoryJournal.controls().heldBy, f.input.operationId);
      await assert.rejects(new DurableMemoryWriter(f.binding, f.keys, f.blobs, f.authority.heads(f.config.publicKey), f.memoryJournal).remember({ operationId: "memory:new", text: "Blocked", source: { kind: "owner", reference: "fixture:barrier" } }), { code: "WRITE_BUSY" });
      await f.rotation().abort(f.input.stateDir);
      assert.equal(f.memoryJournal.controls().heldBy, null); assert.equal(f.signerJournal.get("checkpoint:pending")?.state, "allocated");
    } finally { await f.close(); }
  });
  it("migrates a v1 memory journal without losing encrypted operations and blocks new signer allocation under the barrier", async () => {
    const f = await rotationFixture();
    try {
      const writer = new DurableMemoryWriter(f.binding, f.keys, f.blobs, f.authority.heads(f.config.publicKey), f.memoryJournal);
      const receipt = await writer.remember({ operationId: "memory:migration", text: "Keep journal history", source: { kind: "owner", reference: "fixture:migration" } });
      const path = join(f.input.memoryStateDir, "writes.sqlite");
      const db = new DatabaseSync(path); db.exec("DROP TABLE write_controls; PRAGMA user_version=1"); db.close(); f.restart();
      const migrated = new MemoryWriteJournal(path, f.binding, Date.now, false);
      try { assert.equal(migrated.controls().minimumEpoch, 1); assert.equal(migrated.operation("memory:migration")?.status, "committed"); } finally { migrated.close(); }
      assert.deepEqual(await new DurableMemoryWriter(f.binding, f.keys, f.blobs, f.authority.heads(f.config.publicKey), f.memoryJournal).resume("memory:migration"), receipt);
      await f.rotation().prepare(f.input);
      const call: ContractCall = { method: "checkpoint_memory", args: { agent_id: f.config.agentId, generation: "2", expected_version: "2", next: { version: "3", keyEpoch: "1", manifest: f.authority.snapshot.head!.manifest } } };
      assert.throws(() => f.signerJournal.allocate("checkpoint:blocked", call, "1", baseEncode(Buffer.alloc(32, 4))), { code: "SIGNER_BUSY" });
    } finally { await f.close(); }
  });
  it("allows abort only before an owner request is issued, without discarding new or historical keys", async () => {
    const f = await rotationFixture();
    try {
      const plan = await f.rotation().prepare(f.input);
      await f.rotation().abort(f.input.stateDir); await f.rotation().abort(f.input.stateDir);
      assert.equal(f.memoryJournal.controls().heldBy, null); assert.equal(f.memoryJournal.controls().minimumEpoch, 1);
      assert.equal(f.authority.snapshot.keyEpoch, 1); assert.ok(await readPrivateFile(plan.intent.nextKeyringFile));
      await assert.rejects(f.rotation().prepare(f.input), { code: "OPERATION_CONFLICT" });
    } finally { await f.close(); }
    const issued = await rotationFixture();
    try {
      await issued.rotation().prepare(issued.input); await issued.rotation().next(issued.input.stateDir);
      await assert.rejects(issued.rotation().abort(issued.input.stateDir), { code: "WRITE_PENDING" });
      assert.equal(issued.memoryJournal.controls().heldBy, issued.input.operationId);
    } finally { await issued.close(); }
  });
  it("refuses abort after durable issuance even when the wallet-request file was never retained", async () => {
    const f = await rotationFixture();
    try {
      await f.rotation().prepare(f.input); const request = await f.rotation().next(f.input.stateDir);
      await rm(join(f.input.stateDir, "wallet-begin.json"));
      await assert.rejects(f.rotation().abort(f.input.stateDir), { code: "WRITE_PENDING" });
      assert.equal(f.memoryJournal.controls().heldBy, f.input.operationId);
      assert.deepEqual(await f.rotation().next(f.input.stateDir), request);
    } finally { await f.close(); }
  });
  it("does not export an owner request if abort wins a concurrent preparation/issuance race", async () => {
    const f = await rotationFixture();
    let unblock!: () => void; let reached!: () => void;
    const wait = new Promise<void>((resolve) => { unblock = resolve; }); const ready = new Promise<void>((resolve) => { reached = resolve; });
    try {
      await f.rotation().prepare(f.input);
      const barrier = f.signer.rotationBarrier; let first = true;
      f.signer.rotationBarrier = async (id, identity, release = false) => { if (!release && first) { first = false; reached(); await wait; } await barrier(id, identity, release); };
      const pending = f.rotation().next(f.input.stateDir); const stopped = assert.rejects(pending, { code: "WRITE_BUSY" });
      await ready; await f.rotation().abort(f.input.stateDir); unblock(); await stopped;
      assert.equal((await readdir(f.input.stateDir)).some((name) => name.startsWith("wallet-")), false);
      await f.rotation().abort(f.input.stateDir); // Also clears a late, already-running local signer hold.
      assert.equal(f.memoryJournal.controls().heldBy, null); assert.equal(f.authority.snapshot.keyEpoch, 1);
    } finally { unblock(); await f.close(); }
  });
  it("requires the verified backup pair and prepared runtime/keyring before emitting owner requests", async () => {
    const f = await rotationFixture();
    try {
      const plan = await f.rotation().prepare(f.input);
      const secret = await readPrivateFile(f.input.secretFile);
      await writeFile(f.input.secretFile, "persistara-recovery-v1:" + "A".repeat(43), { mode: 0o600 });
      await assert.rejects(f.rotation().next(f.input.stateDir), { code: "AUTHENTICATION_FAILED" });
      assert.equal((await readdir(f.input.stateDir)).some((name) => name.startsWith("wallet-")), false);
      await writeFile(f.input.secretFile, secret);
      await rm(plan.intent.nextRuntimeFile);
      await assert.rejects(f.rotation().next(f.input.stateDir));
      await assert.rejects(f.rotation().prepare(f.input)); // A completed plan never regenerates a missing key.
    } finally { await f.close(); }
  });
  it("rejects reused/unsafe paths, scope changes, altered plans and replacement owner/full-access keys", async () => {
    const f = await rotationFixture();
    try {
      await assert.rejects(f.rotation().prepare({ ...f.input, bundleFile: f.input.secretFile }), { code: "OPERATION_CONFLICT" });
      const plan = await f.rotation().prepare(f.input);
      await assert.rejects(f.rotation().prepare({ ...f.input, operationId: "rotation:other" }), { code: "OPERATION_CONFLICT" });
      const path = join(f.input.stateDir, "plan.json"); const bytes = await readPrivateFile(path);
      const value = JSON.parse(Buffer.from(bytes).toString()); value.plan.request.replacement.publicKey = f.authority.snapshot.ownerKey;
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(f.rotation().next(f.input.stateDir), { code: "OPERATION_CONFLICT" });
      await writeFile(path, bytes);
      await applyNext(f, "begin"); await applyNext(f, "remove-old-key"); await applyNext(f, "install-new-key");
      f.authority.snapshot.accessKeys.find((k) => k.publicKey === plan.request.replacement.publicKey)!.permission = "FullAccess";
      await assert.rejects(f.rotation().next(f.input.stateDir), { code: "AUTHORIZATION_FAILED" });
      assert.equal(f.authority.snapshot.paused, true);
    } finally { await f.close(); }
  });
  it("rejects changed finality scope, expired grants and intervening owner changes instead of unpausing", async () => {
    const f = await rotationFixture();
    try {
      await f.rotation().prepare(f.input); const before = structuredClone(f.authority.snapshot);
      f.authority.snapshot.agentId = "owner.fixture:other";
      await assert.rejects(f.rotation().next(f.input.stateDir), { code: "AUTHORIZATION_FAILED" });
      f.authority.snapshot.agentId = before.agentId;
      f.authority.snapshot.generation = "3";
      await assert.rejects(f.rotation().next(f.input.stateDir), { code: "OPERATION_CONFLICT" });
      f.authority.snapshot = before; await applyNext(f, "begin");
      f.authority.snapshot.timestampNs = String(BigInt(f.authority.snapshot.timestampNs) + 2n * 86_400_000_000_000n);
      await assert.rejects(f.rotation().next(f.input.stateDir), { code: "AUTHORIZATION_FAILED" });
      assert.equal(f.authority.snapshot.paused, true);
    } finally { await f.close(); }
  });
  it("refuses replaced original journals and does not create a fresh nonce history", async () => {
    const f = await rotationFixture();
    try {
      await f.rotation().prepare(f.input);
      const db = new DatabaseSync(f.config.journalFile); db.exec("UPDATE near_instance SET identity='11111111-1111-4111-8111-111111111111'"); db.close();
      await assert.rejects(f.rotation().next(f.input.stateDir), { code: "INTEGRITY_FAILED" });
      assert.equal(f.authority.snapshot.keyEpoch, 1); assert.equal(f.memoryJournal.controls().heldBy, f.input.operationId);
    } finally { await f.close(); }
  });
  it("retains long historical records and requires a committed new-epoch checkpoint before declaring verification", async () => {
    const f = await rotationFixture("Research ".repeat(6000));
    try {
      await f.rotation().prepare(f.input); await completeAuthority(f);
      await assert.rejects(f.rotation().verify(f.input.stateDir), { code: "WRITE_PENDING" });
      await appendNextEpoch(f);
      assert.equal((await f.rotation().verify(f.input.stateDir)).historicalRecords, 1);
      await writeFile(join(f.input.stateDir, "verified.json"), "{}");
      await assert.rejects(f.rotation().next(f.input.stateDir), { code: "INTEGRITY_FAILED" });
    } finally { await f.close(); }
  });
  it("keeps the checkpoint and backup commitments unchanged when memory advances during final recovery verification", async () => {
    const f = await rotationFixture();
    try {
      const plan = await f.rotation().prepare(f.input); await completeAuthority(f); await appendNextEpoch(f);
      let count = 0;
      f.authority.afterRead = () => { count++; if (count === 1) f.authority.snapshot.head = { ...f.authority.snapshot.head!, version: f.authority.snapshot.head!.version + 1 }; };
      await assert.rejects(f.rotation().verify(f.input.stateDir), { code: "CHECKPOINT_CONFLICT" });
      assert.equal((await readdir(f.input.stateDir)).includes("verified.json"), false);
      assert.equal((await f.rotation().load(f.input.stateDir)).request.recoveryCommitment, plan.request.recoveryCommitment);
    } finally { await f.close(); }
  });
  it("never places memory plaintext, recovery secrets or private keys in plans/wallet requests/observation receipts", async () => {
    const f = await rotationFixture();
    try {
      const plan = await f.rotation().prepare(f.input); await completeAuthority(f);
      const privateStrings = [Buffer.from(await readPrivateFile(f.input.secretFile)).toString(), Buffer.from(await readPrivateFile(plan.intent.nextRuntimeFile)).toString(), Buffer.from(f.keys.key(1)).toString("base64url"), "Research reports must cite dated primary sources.", "fixture:preference"];
      for (const file of (await readdir(f.input.stateDir)).filter((name) => /^(intent|plan|wallet-|observed-)/.test(name))) {
        const text = (await readFile(join(f.input.stateDir, file))).toString();
        for (const forbidden of privateStrings) assert.equal(text.includes(forbidden), false);
      }
      for (const method of ["begin_runtime_rotation", "finish_runtime_rotation"]) assert.throws(() => validateCall({ method: method as ContractCall["method"], args: {} }, f.config), { code: "INVALID_INPUT" });
    } finally { await f.close(); }
  });
});

describe("rotation reads pinned to finalized NEAR state", () => {
  it("pins agent, rotation and key-list queries to one block and rejects cross-block/chain responses", async () => {
    const f = await rotationFixture();
    try {
      let wrongBlock = false; let wrongChain = false; let paginated = false; const pinned: string[] = [];
      const rpc = new NearRpc(f.config, async (method, params) => {
        const p = params as Record<string, unknown>; const s = f.authority.snapshot;
        if (method === "status") return { chain_id: wrongChain ? "wrong-chain" : f.config.chainId, sync_info: { syncing: false } };
        if (method === "block") { assert.equal(p.finality, "final"); return { header: { hash: s.blockHash, timestamp_nanosec: s.timestampNs } }; }
        assert.equal(method, "query"); assert.equal(p.block_id, s.blockHash); assert.equal(p.finality, undefined); pinned.push(String(p.block_id));
        const hash = wrongBlock ? baseEncode(Buffer.alloc(32, 9)) : s.blockHash;
        if (p.request_type === "view_access_key_list") return { block_hash: hash, last_key: paginated ? "nonterminal-page" : null, keys: s.accessKeys.map((k) => ({ public_key: k.publicKey, access_key: { nonce: k.nonce, permission: k.permission } })) };
        const value = p.method_name === "get_runtime_rotation" ? s.rotation : { id: f.config.agentId, owner: s.owner, ownerKey: s.ownerKey, paused: s.paused, generation: s.generation, keyEpoch: String(s.keyEpoch), head: s.head ? { ...s.head, version: String(s.head.version), keyEpoch: String(s.head.keyEpoch) } : null, delegates: s.delegates };
        return { block_hash: hash, result: [...Buffer.from(JSON.stringify(value))] };
      });
      const reader = new NearRotationReader(rpc, f.config);
      assert.equal((await reader.read(f.input.operationId)).keyEpoch, 1); assert.equal(pinned.length, 3);
      wrongBlock = true; await assert.rejects(reader.read(f.input.operationId), { code: "PROTOCOL_ERROR" });
      wrongBlock = false; paginated = true; await assert.rejects(reader.read(f.input.operationId), { code: "PROTOCOL_ERROR" });
      paginated = false; wrongChain = true; await assert.rejects(reader.read(f.input.operationId), { code: "NETWORK_MISMATCH" });
    } finally { await f.close(); }
  });
});
