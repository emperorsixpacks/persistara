import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemData } from "@0gfoundation/0g-storage-ts-sdk";
import { sha256 } from "../packages/crypto/src/envelope.js";
import { assertRuntime, inferenceConfig, storageConfig } from "../packages/protocol/src/config.js";
import { ProviderError, type WorkerExecutor } from "../packages/protocol/src/providers.js";
import { executeWorker } from "../packages/protocol/src/worker.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { NearAiProvider } from "../packages/inference/src/near-ai.js";
import type { InferenceRequest } from "../packages/inference/src/provider.js";
import type { BlobRef } from "../packages/protocol/src/memory.js";

const rootHash = `0x${"a".repeat(64)}`;
const txHash = `0x${"b".repeat(64)}`;
const config = storageConfig({ ZG_UPLOADER_KEY_FILE: "/fixture/key" });
const bytes = Buffer.from("encrypted ciphertext fixture");
function ref(): BlobRef { return { provider: "0g", network: "0g:16602:turbo", objectId: rootHash, ciphertextSha256: sha256(bytes), byteLength: bytes.length }; }
function uploadResult() { return { ref: ref(), evidence: { rootHash, txHash, txSequence: 10, finalized: true, proofVerified: true } }; }

describe("0G adapter contracts (offline transport fixtures)", () => {
  it("preserves provider-native roots separately from ciphertext digests", async () => {
    const executor: WorkerExecutor = async (_module, request) => {
      const value = request as { operation: string; bytes?: Uint8Array; config: { uploaderKeyFile?: string } };
      if (value.operation === "upload") { assert.deepEqual(value.bytes, Uint8Array.from(bytes)); return uploadResult(); }
      assert.equal(value.config.uploaderKeyFile, undefined);
      return Uint8Array.from(bytes);
    };
    const store = new ZeroGBlobStore(config, executor);
    const stored = await store.put(bytes);
    assert.equal(stored.objectId, rootHash);
    assert.notEqual(stored.objectId, stored.ciphertextSha256);
    assert.deepEqual(await store.get(stored), Uint8Array.from(bytes));
    assert.equal(store.getLastUploadEvidence()?.txHash, txHash);
  });

  it("rejects wrong roots, digest, length, proof, and incomplete finality", async () => {
    const mutations = [
      (value: ReturnType<typeof uploadResult>) => { value.ref.objectId = "not-a-root"; },
      (value: ReturnType<typeof uploadResult>) => { value.ref.ciphertextSha256 = "c".repeat(64); },
      (value: ReturnType<typeof uploadResult>) => { value.ref.byteLength++; },
      (value: ReturnType<typeof uploadResult>) => { value.evidence.finalized = false; },
      (value: ReturnType<typeof uploadResult>) => { value.evidence.proofVerified = false; },
    ];
    for (const mutate of mutations) {
      const result = uploadResult(); mutate(result);
      await assert.rejects(new ZeroGBlobStore(config, async () => result).put(bytes), { code: "INTEGRITY_FAILED" });
    }
  });

  it("rejects corrupt downloads and foreign networks before issuing a read", async () => {
    let calls = 0;
    const store = new ZeroGBlobStore(config, async () => { calls++; return new Uint8Array(bytes.length); });
    await assert.rejects(store.get({ ...ref(), network: "0g:other:turbo" }), { code: "INTEGRITY_FAILED" });
    assert.equal(calls, 0);
    await assert.rejects(store.get(ref()), { code: "INTEGRITY_FAILED" });
    assert.equal(calls, 1);
  });

  it("never retries an unknown paid upload and clears evidence before another attempt", async () => {
    let calls = 0;
    const store = new ZeroGBlobStore(config, async () => {
      if (++calls === 1) return uploadResult();
      throw new ProviderError("OUTCOME_UNKNOWN", "Reconcile first", false, txHash);
    });
    await store.put(bytes);
    await assert.rejects(store.put(bytes), { code: "OUTCOME_UNKNOWN", retryable: false, externalReference: txHash });
    assert.equal(calls, 2);
    assert.equal(store.getLastUploadEvidence(), null);
  });

  it("requires explicit uploader configuration and bounds upload sizes", async () => {
    const store = new ZeroGBlobStore(storageConfig({}), async () => { throw new Error("Should not dispatch"); });
    await assert.rejects(store.put(bytes), { code: "NOT_CONFIGURED" });
    await assert.rejects(store.put(new Uint8Array(1_500_001)), { code: "INVALID_INPUT" });
  });

  it("uses the installed 0G SDK to compute a real Merkle root without network calls", async () => {
    const [tree, error] = await new MemData(bytes).merkleTree();
    assert.equal(error, null);
    assert.match(tree?.rootHash() ?? "", /^0x[a-f0-9]{64}$/);
  });
});

const inference = inferenceConfig({ NEARAI_API_KEY: "fixture-only-not-a-real-key", NEARAI_MODEL: "fixture/tee-model" });
function request(): InferenceRequest { return { operationId: "op:one", messages: [{ role: "user", content: "Fictional test" }] }; }
function completion() {
  return { id: "completion:fixture", text: "Ready", toolCalls: [] as unknown[], finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 },
    evidence: { status: "verified", completionId: "completion:fixture", signatureKind: "provider_tee", checks: ["gateway_attestation", "model_attestation", "gateway_tls_binding", "response_signature"], e2ee: true, tcbPolicy: "UpToDate" } };
}

describe("strict inference adapter contracts (offline transport fixtures)", () => {
  it("accepts only complete, completion-bound model evidence", async () => {
    const result = await new NearAiProvider(inference, async () => completion()).complete(request());
    assert.equal(result.evidence.status, "verified");
    assert.equal(result.usage.inputTokens, 10);
  });

  it("rejects absent, failed, unsupported, gateway-only, or mismatched evidence", async () => {
    for (const status of ["unverified", "failed", "unsupported"]) {
      const result = completion(); result.evidence.status = status;
      await assert.rejects(new NearAiProvider(inference, async () => result).complete(request()), { code: "VERIFICATION_FAILED" });
    }
    for (const mutate of [
      (value: ReturnType<typeof completion>) => { value.evidence.signatureKind = "gateway"; },
      (value: ReturnType<typeof completion>) => { value.evidence.completionId = "other:completion"; },
      (value: ReturnType<typeof completion>) => { value.evidence.e2ee = false; },
      (value: ReturnType<typeof completion>) => { value.evidence.checks.pop(); },
    ]) {
      const result = completion(); mutate(result);
      await assert.rejects(new NearAiProvider(inference, async () => result).complete(request()), { code: "VERIFICATION_FAILED" });
    }
  });

  it("does not release output when SDK signature verification fails or retry paid calls", async () => {
    let calls = 0;
    const provider = new NearAiProvider(inference, async () => { calls++; throw new ProviderError("VERIFICATION_FAILED", "Rejected signature"); });
    await assert.rejects(provider.complete(request()), { code: "VERIFICATION_FAILED" });
    assert.equal(calls, 1);
  });

  it("rejects malformed, duplicate and unadvertised tool calls", async () => {
    const variants = [
      [{ id: "call:one", name: "spend_money", arguments: {} }],
      [{ id: "call:one", name: "report_ready", arguments: "not an object" }],
      [{ id: "call:one", name: "report_ready", arguments: {} }, { id: "call:one", name: "report_ready", arguments: {} }],
    ];
    for (const calls of variants) {
      const result = completion(); result.toolCalls = calls; result.finishReason = "tool_calls";
      await assert.rejects(new NearAiProvider(inference, async () => result).complete(request()), { code: "PROTOCOL_ERROR" });
    }
  });

  it("validates tool-result history and token bounds before dispatch", async () => {
    const provider = new NearAiProvider(inference, async () => { throw new Error("Should not dispatch"); });
    await assert.rejects(provider.complete({ ...request(), messages: [{ role: "tool", toolCallId: "missing", content: "bad" }] }), { code: "INVALID_INPUT" });
    await assert.rejects(provider.complete({ ...request(), maxOutputTokens: 4097 }), { code: "INVALID_INPUT" });
    await assert.rejects(provider.complete({ ...request(), messages: [{ role: "assistant", content: null, toolCalls: [{ id: "call:one", name: "report_ready", arguments: {} }] }] }), { code: "INVALID_INPUT" });
    await assert.rejects(new NearAiProvider(inferenceConfig({})).complete(request()), { code: "NOT_CONFIGURED" });
  });
});

describe("isolated provider worker lifecycle", () => {
  const fixture = new URL("./fixtures/provider-worker.js", import.meta.url);
  it("roundtrips binary bytes through IPC and does not inherit host secrets", async () => {
    assert.deepEqual(await executeWorker(fixture, { action: "success" }, { effect: "read", timeoutMs: 2_000 }), new Uint8Array([1, 2, 3]));
    process.env.PERSISTARA_TEST_SECRET = "fictional-fixture-value";
    try { assert.deepEqual(await executeWorker(fixture, { action: "environment" }, { effect: "read", timeoutMs: 2_000 }), { inheritedSecret: false }); }
    finally { delete process.env.PERSISTARA_TEST_SECRET; }
  });
  it("does not dispatch an already canceled request", async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(executeWorker(fixture, { action: "success" }, { effect: "may-charge", signal: controller.signal }), { code: "ABORTED", retryable: false });
  });
  it("marks interrupted paid calls unknown and retains the observed reference", async () => {
    const controller = new AbortController();
    await assert.rejects(executeWorker(fixture, { action: "hang" }, {
      effect: "may-charge", signal: controller.signal, timeoutMs: 2_000,
      onProgress: () => controller.abort(),
    }), { code: "OUTCOME_UNKNOWN", retryable: false, externalReference: rootHash });
  });
  it("terminates read deadlines and unexpected paid-worker exits without retrying", async () => {
    await assert.rejects(executeWorker(fixture, { action: "hang" }, { effect: "read", timeoutMs: 300 }), { code: "TIMEOUT", retryable: true });
    await assert.rejects(executeWorker(fixture, { action: "crash" }, { effect: "may-charge", timeoutMs: 2_000 }), { code: "OUTCOME_UNKNOWN", retryable: false });
    await assert.rejects(executeWorker(fixture, { action: "bad" }, { effect: "read", timeoutMs: 2_000 }), { code: "PROTOCOL_ERROR" });
  });
  it("terminates the worker if recording a paid-call reference fails", async () => {
    await assert.rejects(executeWorker(fixture, { action: "hang" }, {
      effect: "may-charge", timeoutMs: 2_000,
      onProgress: () => { throw new Error("Fixture journal unavailable"); },
    }), { code: "OUTCOME_UNKNOWN", retryable: false });
  });
});

describe("provider configuration", () => {
  it("accepts the pinned runtime and rejects an incompatible verifier runtime", () => {
    assert.doesNotThrow(() => assertRuntime("24.22.2"));
    assert.throws(() => assertRuntime("22.22.2"), { code: "NOT_CONFIGURED" });
    assert.throws(() => assertRuntime("24.22.0"), { code: "NOT_CONFIGURED" });
  });
  it("rejects credential-bearing endpoints and undefined storage modes", () => {
    assert.throws(() => storageConfig({ ZG_RPC_URL: "https://user:password@example.com" }), { code: "INVALID_INPUT" });
    assert.throws(() => storageConfig({ ZG_STORAGE_MODE: "guess" }), { code: "INVALID_INPUT" });
    assert.throws(() => storageConfig({ ZG_INDEXER_URL: "http://localhost:9999" }), { code: "INVALID_INPUT" });
  });
});
