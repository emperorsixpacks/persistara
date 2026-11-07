/** OFFLINE FIXTURE ONLY. Synthetic 0G-shaped roots and in-memory authority are not chain/storage proof evidence. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair, baseEncode } from "near-api-js";
import { sha256 } from "../../packages/crypto/src/envelope.js";
import { encodePrivateKeyring } from "../../packages/memory/src/backup.js";
import type { MemoryBinding } from "../../packages/memory/src/binding.js";
import { writePrivateFile } from "../../packages/memory/src/files.js";
import { MemoryKeyring } from "../../packages/memory/src/keyring.js";
import { OwnerMemoryRotation, type RotationPrepareInput } from "../../packages/memory/src/rotation.js";
import { MemoryService } from "../../packages/memory/src/service.js";
import { MemoryWriteJournal } from "../../packages/memory/src/write-journal.js";
import { NearJournal } from "../../packages/near/src/journal.js";
import { canonical, type NearSignerConfig } from "../../packages/near/src/protocol.js";
import { replacementMethods, type OwnerWalletRequest, type RotationRequest, type RotationSnapshot } from "../../packages/near/src/rotation.js";
import { MemoryError, sameBlob, type BlobRef, type CheckpointAttempt, type DurableMemoryHeads, type MemoryHead, type PreparedBlobStore } from "../../packages/protocol/src/memory.js";
import { ProviderError } from "../../packages/protocol/src/providers.js";
import { LocalBlobStore } from "../../packages/storage/src/local.js";

export class SyntheticRotationBlobs implements PreparedBlobStore {
  private readonly local: LocalBlobStore;
  uploads = 0;
  constructor(directory: string) { this.local = new LocalBlobStore(directory); }
  async assertUploadReady(): Promise<void> { /* Explicit fixture: no uploader credentials or fees. */ }
  async prepare(bytes: Uint8Array): Promise<BlobRef> {
    const digest = sha256(bytes); return { provider: "0g", network: "0g:16602:turbo", objectId: `0x${digest}`, ciphertextSha256: digest, byteLength: bytes.length };
  }
  async put(bytes: Uint8Array): Promise<BlobRef> { this.uploads++; await this.local.put(bytes); return this.prepare(bytes); }
  async putPrepared(ref: BlobRef, bytes: Uint8Array, _submitted: (hash: string) => void): Promise<BlobRef> { assert.ok(sameBlob(ref, await this.prepare(bytes))); return this.put(bytes); }
  async get(ref: BlobRef): Promise<Uint8Array> {
    if (ref.provider !== "0g" || ref.network !== "0g:16602:turbo" || ref.objectId !== `0x${ref.ciphertextSha256}`) throw new MemoryError("INTEGRITY_FAILED", "Invalid synthetic fixture reference");
    return this.local.get({ ...ref, provider: "local", network: "local", objectId: ref.ciphertextSha256 });
  }
}
export class FixtureRotationAuthority {
  snapshot: RotationSnapshot;
  reads = 0;
  afterRead: (() => void) | undefined;
  private readonly outcomes = new Map<string, boolean>();
  constructor(readonly config: NearSignerConfig, ownerKey: string) {
    const allowance = "5000000000000000000000000";
    this.snapshot = { agentId: config.agentId, chainId: config.chainId, contractId: config.contractId, blockHash: baseEncode(Buffer.alloc(32, 7)), timestampNs: "1700000000000000000", owner: config.signerId, ownerKey, paused: false, generation: "2", keyEpoch: 1, head: null,
      delegates: [{ publicKey: config.publicKey, expiresAtNs: "1700086400000000000", canCheckpoint: true, canSpend: true }],
      accessKeys: [{ publicKey: ownerKey, nonce: 4, permission: "FullAccess" }, { publicKey: config.publicKey, nonce: 0, permission: { FunctionCall: { receiver_id: config.contractId, method_names: ["checkpoint_memory", "create_job", "accept_job"], allowance } } }], rotation: null };
  }
  async read(id: string): Promise<RotationSnapshot> {
    this.reads++;
    const copy = structuredClone(this.snapshot);
    if (copy.rotation?.request.operationId !== id) copy.rotation = null;
    this.afterRead?.(); return copy;
  }
  heads(publicKey: string): DurableMemoryHeads {
    const authority = this;
    async function authorized(epoch: number): Promise<void> {
      if (authority.snapshot.paused || authority.snapshot.keyEpoch !== epoch || !authority.snapshot.accessKeys.some((k) => k.publicKey === publicKey) || !authority.snapshot.delegates.some((d) => d.publicKey === publicKey && d.canCheckpoint && BigInt(d.expiresAtNs) > BigInt(authority.snapshot.timestampNs))) throw new ProviderError("AUTHORIZATION_FAILED", "Offline fixture rejected stale runtime");
    }
    return {
      get: async () => structuredClone(authority.snapshot.head), assertWritable: authorized,
      compareAndSwap: async (_agent, version, next) => {
        await authorized(next.keyEpoch); if ((authority.snapshot.head?.version ?? 0) !== version) return false;
        authority.snapshot.head = structuredClone(next); return true;
      },
      prepare: async (_agent, expectedVersion, next) => {
        await authorized(next.keyEpoch); if ((authority.snapshot.head?.version ?? 0) !== expectedVersion) return null;
        return { operationId: `checkpoint:${sha256(Buffer.from(canonical([publicKey, expectedVersion, next])))}`, signerBinding: sha256(Buffer.from(publicKey)), generation: authority.snapshot.generation, expectedVersion, next: structuredClone(next) };
      },
      submit: async (plan: CheckpointAttempt) => {
        const prior = authority.outcomes.get(plan.operationId); if (prior !== undefined) return prior;
        await authorized(plan.next.keyEpoch); if (plan.generation !== authority.snapshot.generation) throw new ProviderError("TRANSACTION_FAILED", "Offline fixture rejected old generation");
        const result = (authority.snapshot.head?.version ?? 0) === plan.expectedVersion;
        if (result) authority.snapshot.head = structuredClone(plan.next);
        authority.outcomes.set(plan.operationId, result);
        authority.snapshot.accessKeys.find((k) => k.publicKey === publicKey)!.nonce++;
        return result;
      },
      reconcile: async (plan) => { const result = authority.outcomes.get(plan.operationId); return result === undefined ? "unsubmitted" : result ? "accepted" : "rejected"; },
    };
  }
  apply(request: OwnerWalletRequest): void {
    assert.equal(request.signerId, this.config.signerId); assert.equal(request.ownerPublicKey, this.snapshot.ownerKey);
    const action = request.actions[0]!; assert.equal(request.actions.length, 1);
    if (action.type === "FunctionCall") {
      assert.equal(request.receiverId, this.config.contractId);
      if (action.params.methodName === "begin_runtime_rotation") {
        const r = action.params.args.request as unknown as RotationRequest;
        if (this.snapshot.rotation?.request.operationId === r.operationId) { assert.equal(canonical(this.snapshot.rotation.request), canonical(r)); return; }
        assert.equal(r.expectedGeneration, this.snapshot.generation); assert.equal(Number(r.expectedEpoch), this.snapshot.keyEpoch);
        assert.equal(Number(r.expectedVersion), this.snapshot.head?.version ?? 0);
        this.snapshot.generation = String(BigInt(this.snapshot.generation) + 1n); this.snapshot.keyEpoch++; this.snapshot.paused = true;
        this.snapshot.delegates = [structuredClone(r.replacement)];
        this.snapshot.rotation = { request: structuredClone(r), nextEpoch: String(this.snapshot.keyEpoch), beginGeneration: this.snapshot.generation, completed: false };
      } else {
        const record = this.snapshot.rotation!; if (record.completed) return;
        assert.equal(this.snapshot.generation, record.beginGeneration); assert.equal(this.snapshot.paused, true);
        record.completed = true; this.snapshot.generation = String(BigInt(this.snapshot.generation) + 1n); this.snapshot.paused = !record.request.resume;
      }
    } else if (action.type === "DeleteKey") {
      assert.equal(request.receiverId, this.config.signerId); assert.notEqual(action.params.publicKey, this.snapshot.ownerKey);
      this.snapshot.accessKeys = this.snapshot.accessKeys.filter((k) => k.publicKey !== action.params.publicKey);
    } else {
      assert.equal(request.receiverId, this.config.signerId); assert.ok(!this.snapshot.accessKeys.some((k) => k.publicKey === action.params.publicKey));
      const permission = action.params.accessKey.permission;
      this.snapshot.accessKeys.push({ publicKey: action.params.publicKey, nonce: 0, permission: { FunctionCall: { receiver_id: permission.receiverId, method_names: [...permission.methodNames], allowance: permission.allowance } } });
      assert.deepEqual([...permission.methodNames].sort(), replacementMethods(this.snapshot.rotation!.request.replacement).sort());
    }
  }
}
export async function rotationFixture(text = "Research reports must cite dated primary sources.") {
  const directory = await mkdtemp(join(tmpdir(), "persistara-rotation-test-"));
  const oldRuntime = KeyPair.fromRandom("ed25519"); const owner = KeyPair.fromRandom("ed25519");
  const config: NearSignerConfig = { kind: "sandbox", chainId: "rotation-fixture", rpcUrl: "http://127.0.0.1:3030", contractId: "authority.fixture", signerId: "owner.fixture", agentId: "owner.fixture:research", publicKey: oldRuntime.getPublicKey().toString(), journalFile: join(directory, "old-near", "near.sqlite"), runtimeKeyFile: join(directory, "old-runtime", "runtime.key") };
  const binding: MemoryBinding = { agentId: config.agentId, authorityNetwork: "near:sandbox", chainId: config.chainId, contractId: config.contractId, storageNetwork: "0g:16602:turbo" };
  const keys = MemoryKeyring.create(); const oldKeyringFile = join(directory, "old-runtime", "memory.json");
  await writePrivateFile(oldKeyringFile, encodePrivateKeyring(binding, keys)); await writePrivateFile(config.runtimeKeyFile, Buffer.from(oldRuntime.toString()));
  const memoryStateDir = join(directory, "memory-state"); let memoryJournal = new MemoryWriteJournal(join(memoryStateDir, "writes.sqlite"), binding);
  let signerJournal = new NearJournal(config.journalFile, config);
  const signer = {
    journalIdentity: async () => signerJournal.identity(),
    rotationBarrier: async (id: string, identity: string, release = false) => { if (identity !== signerJournal.identity()) throw new ProviderError("INTEGRITY_FAILED", "Fixture signer journal was replaced"); if (release) signerJournal.releaseRotation(id); else signerJournal.holdForRotation(id); },
  };
  const authority = new FixtureRotationAuthority(config, owner.getPublicKey().toString()); const blobs = new SyntheticRotationBlobs(join(directory, "ciphertext"));
  const memory = new MemoryService(config.agentId, keys, 1, blobs, authority.heads(config.publicKey), { binding });
  await memory.remember({ operationId: "memory:before-rotation", text, source: { kind: "owner", reference: "fixture:preference" } });
  const input: RotationPrepareInput = { operationId: "rotation:fixture", stateDir: join(directory, "owner-rotation"), memoryStateDir, oldKeyringFile, bundleFile: join(directory, "owner-backup", "epoch2.bundle"), secretFile: join(directory, "owner-secret", "epoch2.key"), resume: true, gasAllowance: "1000000000000000000000000" };
  return { directory, config, binding, keys, authority, blobs, input, memory, signer,
    get memoryJournal() { return memoryJournal; }, get signerJournal() { return signerJournal; },
    rotation: () => new OwnerMemoryRotation(config, binding, authority, signer, blobs),
    restart: () => { memoryJournal.close(); signerJournal.close(); memoryJournal = new MemoryWriteJournal(join(memoryStateDir, "writes.sqlite"), binding, Date.now, false); signerJournal = new NearJournal(config.journalFile, config, false); },
    close: async () => { memoryJournal.close(); signerJournal.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
