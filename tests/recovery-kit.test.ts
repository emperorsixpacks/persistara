import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { baseEncode } from "near-api-js";
import { validateRecipientKeys } from "../packages/commerce/src/encryption.js";
import { MemoryKeyring } from "../packages/memory/src/keyring.js";
import { MemoryRecallIndex } from "../packages/memory/src/index.js";
import { MemoryService } from "../packages/memory/src/service.js";
import { writePrivateFile } from "../packages/memory/src/files.js";
import { canonical, encodeHead, hash } from "../packages/near/src/protocol.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import type { MemoryBinding } from "../packages/memory/src/binding.js";
import type { MemoryHead, MemoryHeadStore } from "../packages/protocol/src/memory.js";
import { createRecoveryKit, openRecoveryKit, recoverKit, recoveryCommission, type RecoveryObservation, type RecoveryReads } from "../packages/recovery/src/kit.js";
import { RecoveryAuthorityReader } from "../packages/recovery/src/near.js";
import { readRecoveryPublicFile } from "../packages/recovery/src/files.js";
import { commerceFixture } from "./fixtures/commerce-support.js";

const script = resolve("dist/scripts/recovery-kit.js");
async function fixture() {
  const f = await commerceFixture();
  try {
    const created = await f.create(), task = f.service().request(created.id), quoted = await f.service().importQuote(created.id, await f.quote(task));
    await f.service().reserve(created.id, quoted.version, quoted.quoteDigest!);
    const delivery = await f.service().importDelivery(created.id, await f.delivery(created.id));
    await f.service().settle(created.id, delivery.version, delivery.artifactDigest!, delivery.quoteDigest!);
    const binding: MemoryBinding = { agentId: f.scope.agentId, authorityNetwork: "near:testnet", chainId: "testnet", contractId: f.scope.contractId, storageNetwork: "0g:16602:turbo" };
    let head: MemoryHead | null = null;
    const heads: MemoryHeadStore = { get: async () => structuredClone(head), compareAndSwap: async (_id, expected, next) => { if ((head?.version ?? 0) !== expected) return false; head = structuredClone(next); return true; } };
    const firstKeys = MemoryKeyring.create(), firstMemory = new MemoryService(f.scope.agentId, firstKeys, 1, f.store, heads, { binding });
    const first = await firstMemory.remember({ operationId: "kit:fact-one", text: "Prefer broad sources.", source: { kind: "owner", reference: "fixture:preference" } });
    const keys = firstKeys.nextEpoch(), memory = new MemoryService(f.scope.agentId, keys, 2, f.store, heads, { binding });
    await memory.remember({ operationId: "kit:fact-revision", text: "Prefer dated primary sources.", supersedes: first.recordId, source: { kind: "owner", reference: "fixture:revision" } });
    await memory.remember({ operationId: "kit:fact-two", text: "Use encrypted recoverable artifacts.", source: { kind: "artifact", reference: "fixture:artifact" } });
    const recipient = await validateRecipientKeys(JSON.parse(await readFile(f.keyFile, "utf8"))), commission = recoveryCommission(f.journal().get(created.id))!;
    const input = { scope: f.scope, ownerKey: f.view.ownerKey, binding, checkpoint: head, keys, recipient, commissions: [commission] };
    const prepared = await createRecoveryKit(input), opened = await openRecoveryKit(prepared.bundle, prepared.secret, prepared.digest);
    const observation: RecoveryObservation = { scope: f.scope, ownerKey: f.view.ownerKey, head, keyEpoch: 2, timestampNs: String(BigInt(Date.now()) * 1_000_000n), blockHash: f.view.blockHash };
    const reads: RecoveryReads = { observe: async () => structuredClone(observation), job: async () => structuredClone(f.data.job), blobs: { get: ref => f.store.get(ref) } };
    return { ...f, input, prepared, opened, observation, reads, commission };
  } catch (error) { await f.close(); throw error; }
}
describe("portable encrypted owner recovery kits", () => {
  it("reads bounded ciphertext from public-permission media while rejecting symlinks, pipes and oversized exports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "persistara-kit-media-"));
    try {
      const file = join(directory, "encrypted.kit"), link = join(directory, "linked.kit"), pipe = join(directory, "pipe.kit");
      await writeFile(file, "encrypted fixture", { mode: 0o644 });
      assert.equal(text(await readRecoveryPublicFile(file, 100)), "encrypted fixture");
      await assert.rejects(readRecoveryPublicFile(file, 4), { code: "INVALID_BACKUP" });
      await symlink(file, link); await assert.rejects(readRecoveryPublicFile(link, 100));
      await promisify(execFile)("mkfifo", [pipe]); await assert.rejects(readRecoveryPublicFile(pipe, 100), { code: "INVALID_BACKUP" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("authenticates historical memory keys and separate delivery keys, then recovers sourced revisions and paid artifacts through reads only", async () => {
    const f = await fixture();
    try {
      const uploads = f.data.uploads, submissions = f.data.submissions;
      assert.deepEqual(f.opened.keys.epochs(), [1, 2]); assert.deepEqual(f.opened.keys.key(1), f.input.keys.key(1));
      assert.equal(f.opened.recipient!.privateKey.d, f.input.recipient.privateKey.d);
      const text = Buffer.from(f.prepared.bundle).toString();
      for (const secret of [f.prepared.secret, f.input.recipient.privateKey.d!, Buffer.from(f.input.keys.key(1)).toString("base64url"), "Prefer dated primary sources.", f.commission.brief.objective]) assert.equal(text.includes(secret), false);
      const result = await recoverKit(f.opened, f.reads);
      assert.equal(result.snapshot.records.length, 3); assert.equal(result.deliveries.length, 1); assert.equal(result.deliveries[0]!.status, "paid"); assert.equal(result.deliveries[0]!.payoutAttempt, "1");
      assert.equal(result.deliveries[0]!.digest, f.commission.delivery.payload.artifactDigest);
      const index = new MemoryRecallIndex(join(f.directory, "recovered/recall.sqlite"), f.input.binding);
      try {
        index.replace(result.snapshot);
        const recalled = [...index.search("sources", result.snapshot.head).matches, ...index.search("artifacts", result.snapshot.head).matches];
        assert.equal(recalled.length, 2); assert.ok(recalled.every(m => m.untrusted && m.citation.sourceReference.startsWith("fixture:")));
        assert.equal(recalled.some(m => m.text === "Prefer broad sources."), false);
      }
      finally { index.close(); }
      assert.equal(f.data.uploads, uploads); assert.equal(f.data.submissions, submissions);
    } finally { await f.close(); }
  });
  it("rejects wrong independent fingerprints, secrets, tampered ciphertext and substituted authenticated headers", async () => {
    const f = await fixture();
    try {
      await assert.rejects(openRecoveryKit(f.prepared.bundle, f.prepared.secret, "0".repeat(64)), { code: "INTEGRITY_FAILED" });
      await assert.rejects(openRecoveryKit(f.prepared.bundle, "persistara-kit-v1:" + randomBytes(32).toString("base64url"), f.prepared.digest), { code: "AUTHENTICATION_FAILED" });
      for (const mutate of [
        (v: Record<string, any>) => { v.header.scope.contractId = "other.testnet"; v.header.binding.contractId = "other.testnet"; },
        (v: Record<string, any>) => { v.header.createdAt += 1; },
        (v: Record<string, any>) => { const e = JSON.parse(Buffer.from(v.wrapped, "base64url").toString()); e.ciphertext = e.ciphertext.slice(0, -1) + (e.ciphertext.endsWith("A") ? "B" : "A"); v.wrapped = Buffer.from(JSON.stringify(e)).toString("base64url"); },
      ]) { const value = JSON.parse(text(f.prepared.bundle)); mutate(value); const bytes = Buffer.from(JSON.stringify(value)); await assert.rejects(openRecoveryKit(bytes, f.prepared.secret, hash(bytes))); }
      const unknown = Buffer.from(JSON.stringify({ ...JSON.parse(text(f.prepared.bundle)), injected: true }));
      await assert.rejects(openRecoveryKit(unknown, f.prepared.secret, hash(unknown)), { code: "INVALID_BACKUP" });
    } finally { await f.close(); }
  });
  it("refuses missing or mismatched recipient keys, altered immutable quotes/requests, duplicate jobs and oversized exports", async () => {
    const f = await fixture();
    try {
      await assert.rejects(createRecoveryKit({ ...f.input, recipient: null }));
      await assert.rejects(createRecoveryKit({ ...f.input, recipient: f.encryption }));
      const altered = structuredClone(f.commission); altered.request.amount = "1";
      await assert.rejects(createRecoveryKit({ ...f.input, commissions: [altered] }));
      await assert.rejects(createRecoveryKit({ ...f.input, commissions: [f.commission, f.commission] }));
      await assert.rejects(createRecoveryKit({ ...f.input, commissions: Array.from({ length: 250 }, () => f.commission) }));
      const changed = structuredClone(f.input.recipient); changed.privateKey = { ...f.encryption.privateKey, n: changed.publicKey.n };
      await assert.rejects(createRecoveryKit({ ...f.input, recipient: changed }));
    } finally { await f.close(); }
  });
  it("fails before publishing when any blob or full job binding differs or the head changes during recovery", async () => {
    const f = await fixture();
    try {
      const uploads = f.data.uploads, submissions = f.data.submissions;
      const changedJob = structuredClone(f.data.job!); changedJob.request.amount = "1";
      await assert.rejects(recoverKit(f.opened, { ...f.reads, job: async () => changedJob }));
      await assert.rejects(recoverKit(f.opened, { ...f.reads, blobs: { get: async () => { throw Error("Fixture unavailable ciphertext"); } } }));
      await assert.rejects(recoverKit(f.opened, { ...f.reads, blobs: { get: async ref => { const b = Uint8Array.from(await f.store.get(ref)); b[0] = b[0]! ^ 1; return b; } } }));
      let observations = 0;
      await assert.rejects(recoverKit(f.opened, { ...f.reads, observe: async () => { const o = structuredClone(f.observation); if (observations++) o.head = { ...o.head!, version: o.head!.version + 1 }; return o; } }), { code: "CHECKPOINT_CONFLICT" });
      await assert.rejects(recoverKit(f.opened, { ...f.reads, observe: async () => ({ ...f.observation, head: null }) }), { code: "INTEGRITY_FAILED" });
      await assert.rejects(recoverKit(f.opened, { ...f.reads, observe: async () => ({ ...f.observation, ownerKey: f.worker.getPublicKey().toString() }) }), { code: "INTEGRITY_FAILED" });
      assert.equal(f.data.uploads, uploads); assert.equal(f.data.submissions, submissions);
    } finally { await f.close(); }
  });
  it("keeps offline CLI verification independent of .env, public networks, original keys and journals", async () => {
    const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "persistara-kit-cli-"));
    try {
      const kitFile = join(directory, "owner.kit"), secretFile = join(directory, "kit.secret");
      await writePrivateFile(kitFile, f.prepared.bundle); await writePrivateFile(secretFile, Buffer.from(f.prepared.secret));
      await chmod(kitFile, 0o644); // Encrypted material can be read back from non-POSIX external media.
      await writeFile(join(directory, ".env"), "NEAR_RUNTIME_KEY_FILE=/must-not-open\nZG_UPLOADER_KEY_FILE=/must-not-open\n");
      const args = [script, "verify", "--kit", kitFile, "--secret-file", secretFile, "--expect-sha256", f.prepared.digest];
      const output = await promisify(execFile)(process.execPath, args, { cwd: directory, env: {}, timeout: 10_000 });
      const report = JSON.parse(output.stdout); assert.equal(report.status, "recovery_kit_authenticated_offline"); assert.equal(report.networkUsed, false); assert.equal(report.originalEnvironmentLoaded, false); assert.equal(report.offDeviceVerified, false);
      assert.equal(output.stdout.includes(f.prepared.secret), false); assert.equal(output.stdout.includes(f.input.recipient.privateKey.d!), false);
      await chmod(secretFile, 0o644); await assert.rejects(promisify(execFile)(process.execPath, args, { cwd: directory, env: {} }), (error: unknown) => { assert.equal(JSON.parse((error as { stderr: string }).stderr).code, "INVALID_INPUT"); return true; });
    } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("rejects secret-bearing provider manifests and refuses to overwrite an existing recovery directory", async () => {
    const f = await fixture();
    try {
      const directory = join(f.directory, "kit-input"), kitFile = join(directory, "owner.kit"), secretFile = join(directory, "kit.secret"), manifestFile = join(directory, "manifest.json");
      await writePrivateFile(kitFile, f.prepared.bundle); await writePrivateFile(secretFile, Buffer.from(f.prepared.secret));
      const manifest = { schemaVersion: 1, kind: "persistara-recovery-kit-manifest", kitSha256: f.prepared.digest, kitId: f.prepared.header.id, scope: f.scope, near: { kind: "testnet", chainId: "testnet", rpcUrl: "https://rpc.testnet.near.org", contractId: f.scope.contractId }, storage: { chainId: 16602, mode: "turbo", rpcUrl: "https://evmrpc-testnet.0g.ai", indexerUrl: "https://indexer-storage-testnet-turbo.0g.ai", uploaderKeyFile: "/must-not-open" } };
      await writePrivateFile(manifestFile, Buffer.from(JSON.stringify(manifest)));
      const args = [script, "recover", "--kit", kitFile, "--secret-file", secretFile, "--expect-sha256", f.prepared.digest, "--manifest", manifestFile, "--state-dir", f.directory];
      const rejected = (code: string) => (error: unknown) => { assert.equal(JSON.parse((error as { stderr: string }).stderr).code, code); return true; };
      await assert.rejects(promisify(execFile)(process.execPath, args, { cwd: tmpdir(), env: {} }), rejected("INVALID_BACKUP"));
      const { uploaderKeyFile: _unused, ...storage } = manifest.storage;
      await writeFile(manifestFile, JSON.stringify({ ...manifest, storage }), { mode: 0o600 });
      await assert.rejects(promisify(execFile)(process.execPath, args, { cwd: tmpdir(), env: {} }), rejected("INVALID_INPUT"));
      assert.ok((await readFile(secretFile)).equals(Buffer.from(f.prepared.secret)));
    } finally { await f.close(); }
  });
  it("pins recovery code, owner and head to one finalized block and rejects substituted or malformed observations", async () => {
    const f = await fixture();
    try {
      const network = { kind: "testnet" as const, chainId: "testnet", rpcUrl: "https://rpc.testnet.near.org", contractId: f.scope.contractId };
      let code = f.codeHash, owner = f.scope.owner, returnedBlock = f.view.blockHash;
      const requestedBlocks: string[] = [];
      const rpc = new NearRpc(network, async (method, params) => {
        if (method === "status") return { chain_id: "testnet", sync_info: { syncing: false } };
        if (method === "block") return { header: { hash: f.view.blockHash, timestamp_nanosec: f.observation.timestampNs } };
        assert.equal(method, "query"); const p = params as { block_id: string; request_type: string }; requestedBlocks.push(p.block_id);
        if (p.request_type === "view_account") return { block_hash: returnedBlock, code_hash: code };
        return { block_hash: returnedBlock, result: [...Buffer.from(JSON.stringify({ id: f.scope.agentId, owner, ownerKey: f.view.ownerKey, keyEpoch: "2", head: encodeHead(f.observation.head!) }))] };
      });
      const reader = new RecoveryAuthorityReader(network, f.scope, rpc);
      assert.equal((await reader.observe()).head!.version, 3); assert.ok(requestedBlocks.every(b => b === f.view.blockHash));
      code = baseEncode(randomBytes(32)); await assert.rejects(reader.observe()); code = f.codeHash;
      owner = "other.testnet"; await assert.rejects(reader.observe()); owner = f.scope.owner;
      returnedBlock = baseEncode(randomBytes(32)); await assert.rejects(reader.observe());
    } finally { await f.close(); }
  });
});
function text(bytes: Uint8Array) { return Buffer.from(bytes).toString(); }
