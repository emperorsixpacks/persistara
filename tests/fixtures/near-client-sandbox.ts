/** Local integration fixture ONLY. Random owner backups and real sandbox checkpoints use synthetic blob roots, not 0G proofs. */
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
import { sha256 } from "../../packages/crypto/src/envelope.js";
import { NearAuthorityReader, NearMemoryHeadStore, NearTreasuryClient } from "../../packages/near/src/client.js";
import { IsolatedNearSigner } from "../../packages/near/src/isolated.js";
import { NearRpc } from "../../packages/near/src/rpc.js";
import type { NearSignerConfig } from "../../packages/near/src/protocol.js";
import { isObject, MemoryError, type BlobRef, type BlobStore } from "../../packages/protocol/src/memory.js";
import { ProviderError } from "../../packages/protocol/src/providers.js";

let fixtureStage = "bootstrap";
let observedStatus: string | undefined;

class SyntheticFixtureBlobs implements BlobStore {
  constructor(private readonly directory: string) {}
  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = sha256(bytes);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, digest), bytes, { mode: 0o600 });
    return { provider: "0g", network: "0g:16602:turbo", objectId: `0x${digest}`, ciphertextSha256: digest, byteLength: bytes.length };
  }
  async get(ref: BlobRef): Promise<Uint8Array> {
    assert.match(ref.ciphertextSha256, /^[a-f0-9]{64}$/);
    return readFile(join(this.directory, ref.ciphertextSha256));
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(isObject(input) && typeof input.directory === "string" && typeof input.rpcUrl === "string" && typeof input.phase === "string");
  const url = new URL(input.rpcUrl);
  assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
  // This bootstrap discovers the disposable sandbox's random chain ID only.
  // Public deployment config must set chainId=testnet explicitly.
  const status: unknown = await (await fetch(input.rpcUrl, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "fixture", method: "status", params: {} }) })).json();
  assert.ok(isObject(status) && isObject(status.result) && typeof status.result.chain_id === "string");
  const config: NearSignerConfig = { kind: "sandbox", chainId: status.result.chain_id, rpcUrl: input.rpcUrl,
    contractId: String(input.contractId), signerId: String(input.signerId), publicKey: String(input.publicKey), agentId: String(input.agentId),
    journalFile: join(input.directory, "journal", "near.sqlite"), runtimeKeyFile: join(input.directory, "runtime.key") };
  const reader = new NearAuthorityReader(new NearRpc(config));
  const signer = new IsolatedNearSigner(config);
  const blobs = new SyntheticFixtureBlobs(join(input.directory, "ciphertext"));
  const binding: MemoryBinding = { agentId: config.agentId, authorityNetwork: "near:sandbox", chainId: config.chainId, contractId: config.contractId, storageNetwork: "0g:16602:turbo" };
  const bundlePath = join(input.directory, "owner-backup", "memory.bundle");
  const secretPath = join(input.directory, "owner-secret", "recovery.key");
  const inputMemory = { operationId: "memory:fixture", text: "Research reports must cite dated primary sources.", source: { kind: "owner" as const, reference: "sandbox:owner-preference" } };
  if (input.phase === "write") {
    fixtureStage = "write-checkpoint";
    assert.equal(typeof input.runtimeSecretKey, "string");
    await writeFile(config.runtimeKeyFile, String(input.runtimeSecretKey), { flag: "wx", mode: 0o600 });
    const keys = MemoryKeyring.create();
    const backup = createOwnerBackup(binding, keys);
    await writePrivateFile(secretPath, Buffer.from(backup.recoverySecret));
    await writePrivateFile(bundlePath, backup.bundle);
    verifyOwnerBackup(await readPrivateFile(bundlePath), Buffer.from(await readPrivateFile(secretPath)).toString(), binding, keys);
    await writePrivateFile(join(input.directory, "original-runtime", "memory-keyring.json"), encodePrivateKeyring(binding, keys));
    let transactionHash: string | undefined;
    let operationId: string | undefined;
    const loseResponse = {
      submit: async (...args: Parameters<IsolatedNearSigner["submit"]>) => {
        operationId = args[0];
        const outcome = await signer.submit(...args);
        observedStatus = outcome.status;
        assert.equal(outcome.status, "confirmed");
        transactionHash = outcome.transactionHash;
        throw new ProviderError("OUTCOME_UNKNOWN", "Injected lost checkpoint response", false, outcome.transactionHash);
      },
      reconcile: (id: string) => signer.reconcile(id),
    };
    const memory = new MemoryService(config.agentId, keys, 1, blobs, new NearMemoryHeadStore(reader, config, loseResponse), { binding });
    await assert.rejects(memory.remember(inputMemory), { code: "OUTCOME_UNKNOWN" });
    assert.ok(transactionHash);
    const normal = new MemoryService(config.agentId, keys, 1, blobs, new NearMemoryHeadStore(reader, config, signer), { binding });
    const original = (await normal.recover())[0]!;
    await normal.remember({ operationId: "memory:budget", text: "Research missions must count pending reservations in their budget.", source: { kind: "owner", reference: "sandbox:owner-budget" } });
    await normal.remember({ operationId: "memory:revision", text: "Research reports must cite dated primary sources and state uncertainty.", source: inputMemory.source, supersedes: original.id });
    const index = new MemoryRecallIndex(join(input.directory, "original-runtime", "cache", "recall.sqlite"), binding);
    try { index.replace(await normal.recoverSnapshot()); } finally { index.close(); }
    fixtureStage = "read-written-checkpoint";
    const a = await reader.agent(config.agentId);
    assert.equal(a.head?.version, 3);
    console.log(JSON.stringify({ phase: "write", evidence: "local-sandbox-synthetic-storage", transactionHash, operationId, version: 3 }));
  } else if (input.phase === "reconcile") {
    fixtureStage = "reconcile-without-key";
    await assert.rejects(readFile(config.runtimeKeyFile));
    const outcome = await signer.reconcile(String(input.checkpointOperationId));
    assert.equal(outcome.status, "confirmed");
    console.log(JSON.stringify({ phase: "reconcile", status: outcome.status, transactionHash: outcome.transactionHash }));
  } else if (input.phase === "reserve" || input.phase === "accept") {
    fixtureStage = input.phase;
    const treasury = new NearTreasuryClient(reader, config, signer);
    const state = await reader.agent(config.agentId);
    let job;
    if (input.phase === "reserve") {
      const now = BigInt(String(input.nowNs));
      job = await treasury.reserve({ agentId: config.agentId, generation: state.generation, policyVersion: state.policyVersion,
        operationId: "job:client", worker: String(input.workerId), amount: "1000000000000000000000000", criteriaHash: "f".repeat(64),
        brief: { provider: "0g", network: "0g:16602:turbo", objectId: `0x${"a".repeat(64)}`, ciphertextSha256: "b".repeat(64), byteLength: 100 },
        quoteExpiresAtNs: String(now + 3_600_000_000_000n), deliveryDeadlineNs: String(now + 7_200_000_000_000n), reviewWindowNs: "3600000000000" });
      assert.equal(job.status, "funded");
    } else {
      const current = await treasury.get("job:client");
      assert.ok(current?.result);
      job = await treasury.accept("job:client", state.generation, current.result.ciphertextSha256);
      assert.equal(job.status, "paid");
    }
    console.log(JSON.stringify({ phase: input.phase, evidence: "local-sandbox-synthetic-storage", status: job.status, amount: job.amount }));
  } else {
    fixtureStage = "recover-without-key-or-journal";
    assert.equal(input.phase, "recover");
    await assert.rejects(readFile(config.runtimeKeyFile));
    await assert.rejects(readFile(config.journalFile));
    await assert.rejects(stat(join(input.directory, "original-runtime")), { code: "ENOENT" });
    const index = new MemoryRecallIndex(join(input.directory, "recovered-runtime", "recall.sqlite"), binding);
    try {
      const readOnlyBlobs = { get: (ref: BlobRef) => blobs.get(ref), put: async (): Promise<never> => { throw new Error("Recovery must not upload"); } };
      const heads = { get: async (id: string) => (await reader.agent(id)).head };
      const result = await rebuildFromOwnerBackup({ binding, bundle: await readPrivateFile(bundlePath), recoverySecret: Buffer.from(await readPrivateFile(secretPath)).toString(), blobs: readOnlyBlobs, heads, index });
      assert.equal(result.recordCount, 3); assert.equal(result.currentCount, 2);
      const recalled = await recallCommitted(index, heads, config.agentId, "dated primary sources");
      assert.equal(recalled.matches.length, 1); assert.equal(recalled.matches[0]?.operationId, "memory:revision");
      assert.deepEqual(recalled.matches[0]?.source, inputMemory.source); assert.equal(recalled.matches[0]?.untrusted, true);
      const history = await recallCommitted(index, heads, config.agentId, "dated primary sources", { includeSuperseded: true });
      assert.equal(history.matches.length, 2);
      assert.equal(result.version, 3);
      console.log(JSON.stringify({ phase: "recover", evidence: "local-sandbox-synthetic-storage", recovered: 3, currentFacts: 2, version: 3 }));
    } finally { index.close(); }
  }
}
main().catch((error: unknown) => {
  // Test diagnostics keep source locations/statuses, never assertions' actual
  // payloads, input, SDK exception messages, keys, or decrypted content.
  const locations = error instanceof Error ? error.stack?.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 4) : [];
  console.error(JSON.stringify({ status: "failed", code: error instanceof ProviderError || error instanceof MemoryError ? error.code : "FIXTURE_ASSERTION_FAILED", stage: fixtureStage, observedStatus, locations }));
  process.exitCode = 1;
});
