import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256 } from "../packages/crypto/src/envelope.js";
import { writePrivateFile } from "../packages/memory/src/files.js";
import type { BlobRef, PreparedBlobStore } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { StorageAcceptance } from "../packages/storage/src/acceptance.js";
import { assertUploadTransaction, MAX_UPLOAD_COST_WEI, TURBO_FLOW } from "../packages/storage/src/upload-policy.js";

class FixtureStorage implements PreparedBlobStore {
  network = "0g:16602:turbo";
  uploads = 0;
  reads = 0;
  ready = true;
  loseResponse = false;
  loseBeforeEffect = false;
  corrupt = false;
  objects = new Map<string, Uint8Array>();
  async assertUploadReady() { if (!this.ready) throw new ProviderError("NOT_CONFIGURED", "Fixture preflight"); }
  async prepare(bytes: Uint8Array): Promise<BlobRef> {
    return { provider: "0g", network: this.network, objectId: `0x${sha256(bytes)}`, ciphertextSha256: sha256(bytes), byteLength: bytes.length };
  }
  async put(bytes: Uint8Array) { return this.putPrepared(await this.prepare(bytes), bytes, () => {}); }
  async putPrepared(ref: BlobRef, bytes: Uint8Array, onSubmitted: (hash: string) => void) {
    this.uploads++;
    assert.equal(sha256(bytes), ref.ciphertextSha256);
    if (this.loseBeforeEffect) throw new ProviderError("OUTCOME_UNKNOWN", "Fixture interruption");
    this.objects.set(ref.objectId, Uint8Array.from(bytes));
    onSubmitted(`0x${"b".repeat(64)}`);
    if (this.loseResponse) throw new ProviderError("OUTCOME_UNKNOWN", "Fixture lost response");
    return ref;
  }
  async get(ref: BlobRef) {
    this.reads++;
    const bytes = this.objects.get(ref.objectId);
    if (!bytes) throw new ProviderError("UPSTREAM_ERROR", "Fixture unavailable");
    return this.corrupt ? new Uint8Array(bytes.length) : bytes;
  }
}
async function fixture(run: (directory: string, store: FixtureStorage, acceptance: StorageAcceptance) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "persistara-storage-acceptance-"));
  const store = new FixtureStorage();
  try { await run(directory, store, new StorageAcceptance(directory, store)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe("durable real-storage acceptance harness (offline transport fixtures)", () => {
  it("persists a stable encrypted intent and separate key, then verifies in another instance without resubmission", async () => fixture(async (directory, store, acceptance) => {
    const prepared = await acceptance.prepare();
    assert.deepEqual(await acceptance.prepare(), prepared);
    assert.equal(store.uploads, 0);
    const result = await acceptance.upload();
    assert.equal(result.status, "verified_storage_acceptance");
    assert.equal(result.nearCheckpointVerified, false);
    assert.equal(result.txHash, `0x${"b".repeat(64)}`);
    assert.equal(JSON.stringify(result).includes("dated primary sources"), false);
    assert.equal(JSON.stringify(result).includes((await readFile(join(directory, "recovery.key"))).toString("base64url")), false);
    const restarted = new StorageAcceptance(directory, store);
    assert.equal((await restarted.verify()).operationId, result.operationId);
    await restarted.upload();
    assert.equal(store.uploads, 1);
  }));
  it("reconciles a lost upload response at the original root without another effect", async () => fixture(async (directory, store, acceptance) => {
    const prepared = await acceptance.prepare(); store.loseResponse = true;
    await assert.rejects(acceptance.upload(), { code: "OUTCOME_UNKNOWN", externalReference: prepared.ref.objectId });
    const result = await new StorageAcceptance(directory, store).upload();
    assert.equal(result.ref.objectId, prepared.ref.objectId);
    assert.equal(store.uploads, 1);
  }));
  it("leaves an unavailable dispatched root unknown forever rather than authorizing a replacement", async () => fixture(async (directory, store, acceptance) => {
    await acceptance.prepare(); store.loseBeforeEffect = true;
    await assert.rejects(acceptance.upload(), { code: "OUTCOME_UNKNOWN" });
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(new StorageAcceptance(directory, store).upload(), { code: "OUTCOME_UNKNOWN" });
    assert.equal(store.uploads, 1);
  }));
  it("does not mark dispatch when read-only readiness fails", async () => fixture(async (directory, store, acceptance) => {
    await acceptance.prepare(); store.ready = false;
    await assert.rejects(acceptance.upload(), { code: "NOT_CONFIGURED" });
    await assert.rejects(readFile(join(directory, "dispatched.json")), { code: "ENOENT" });
    store.ready = true; await acceptance.upload(); assert.equal(store.uploads, 1);
  }));
  it("allows only one concurrent process to dispatch", async () => fixture(async (directory, store, acceptance) => {
    await acceptance.prepare();
    const results = await Promise.allSettled([acceptance.upload(), new StorageAcceptance(directory, store).upload()]);
    assert.equal(results.some((r) => r.status === "fulfilled"), true);
    assert.equal(store.uploads, 1);
    await acceptance.verify();
  }));
  it("fences a crash between recording dispatch and invoking the SDK", async () => fixture(async (directory, store, acceptance) => {
    const intent = await acceptance.prepare();
    await writePrivateFile(join(directory, "dispatched.json"), Buffer.from(JSON.stringify({ operationId: intent.operationId, intentSha256: sha256(await readFile(join(directory, "intent.json"))) })));
    await assert.rejects(acceptance.upload(), { code: "OUTCOME_UNKNOWN" });
    assert.equal(store.uploads, 0);
  }));
  it("rejects wrong keys, modified ciphertext and foreign networks before dispatch", async () => fixture(async (directory, store, acceptance) => {
    await acceptance.prepare();
    const key = await readFile(join(directory, "recovery.key"));
    await writeFile(join(directory, "recovery.key"), Buffer.alloc(32));
    await assert.rejects(acceptance.upload(), { code: "AUTHENTICATION_FAILED" });
    await writeFile(join(directory, "recovery.key"), key);
    store.network = "0g:16602:standard";
    await assert.rejects(acceptance.upload(), { code: "INTEGRITY_FAILED" });
    store.network = "0g:16602:turbo";
    const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8"));
    intent.ciphertext = Buffer.from("tampered").toString("base64url");
    await writeFile(join(directory, "intent.json"), JSON.stringify(intent));
    await assert.rejects(acceptance.upload(), { code: "INTEGRITY_FAILED" });
    assert.equal(store.uploads, 0);
  }));
  it("rejects corrupted retrieval and dispatch markers without repeating the upload", async () => fixture(async (directory, store, acceptance) => {
    await acceptance.prepare(); await acceptance.upload(); store.corrupt = true;
    await assert.rejects(acceptance.verify(), { code: "INTEGRITY_FAILED" });
    await writeFile(join(directory, "dispatched.json"), JSON.stringify({ operationId: "other" }));
    await assert.rejects(acceptance.upload(), { code: "INTEGRITY_FAILED" });
    assert.equal(store.uploads, 1);
  }));
  it("does not overwrite partial initialization or replace lost recovery material", async () => fixture(async (directory, store, acceptance) => {
    await writePrivateFile(join(directory, "initializing.json"), Buffer.from("{}"));
    await assert.rejects(acceptance.prepare(), { code: "EEXIST" });
    assert.equal(store.uploads, 0);
  }));
  it("retains a dispatched root if saving its submitted hash fails", async () => fixture(async (directory, store, acceptance) => {
    await acceptance.prepare();
    await writePrivateFile(join(directory, "submitted.json"), Buffer.from("{}"));
    await assert.rejects(acceptance.upload(), { code: "OUTCOME_UNKNOWN" });
    await assert.rejects(acceptance.upload(), { code: "INTEGRITY_FAILED" });
    assert.equal(store.uploads, 1);
  }));
});

describe("0G upload transaction ceiling", () => {
  const tx = { to: TURBO_FLOW, chainId: 16602n, value: 1n, gasLimit: 100_000n, gasPrice: 1_000_000_000n };
  it("permits bounded Galileo transactions and the inclusive ceiling", () => {
    assert.doesNotThrow(() => assertUploadTransaction(tx, TURBO_FLOW));
    assert.doesNotThrow(() => assertUploadTransaction({ ...tx, value: MAX_UPLOAD_COST_WEI - tx.gasLimit * tx.gasPrice }, TURBO_FLOW));
  });
  it("rejects foreign destinations/networks, unpriced gas, negative values and excess worst-case cost", () => {
    for (const invalid of [
      { ...tx, to: `0x${"a".repeat(40)}` }, { ...tx, chainId: 1n }, { ...tx, gasLimit: undefined },
      { ...tx, value: -1n }, { ...tx, gasPrice: 0n }, { ...tx, value: MAX_UPLOAD_COST_WEI },
      { ...tx, maxFeePerGas: MAX_UPLOAD_COST_WEI },
    ]) assert.throws(() => assertUploadTransaction(invalid, TURBO_FLOW), { code: "AUTHORIZATION_FAILED" });
  });
});
