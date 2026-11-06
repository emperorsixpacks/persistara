/** Local integration fixture ONLY. Synthetic roots and a public fixture memory key are not 0G proofs. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryService } from "../../packages/memory/src/service.js";
import { sha256 } from "../../packages/crypto/src/envelope.js";
import { NearAuthorityReader, NearMemoryHeadStore, NearTreasuryClient } from "../../packages/near/src/client.js";
import { IsolatedNearSigner } from "../../packages/near/src/isolated.js";
import { NearRpc } from "../../packages/near/src/rpc.js";
import type { NearSignerConfig } from "../../packages/near/src/protocol.js";
import { isObject, type BlobRef, type BlobStore } from "../../packages/protocol/src/memory.js";
import { ProviderError } from "../../packages/protocol/src/providers.js";

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
  const status: unknown = await (await fetch(input.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "fixture", method: "status", params: {} }) })).json();
  assert.ok(isObject(status) && isObject(status.result) && typeof status.result.chain_id === "string");
  const config: NearSignerConfig = { kind: "sandbox", chainId: status.result.chain_id, rpcUrl: input.rpcUrl,
    contractId: String(input.contractId), signerId: String(input.signerId), publicKey: String(input.publicKey), agentId: String(input.agentId),
    journalFile: join(input.directory, "journal", "near.sqlite"), runtimeKeyFile: join(input.directory, "runtime.key") };
  const reader = new NearAuthorityReader(new NearRpc(config));
  const signer = new IsolatedNearSigner(config);
  const blobs = new SyntheticFixtureBlobs(join(input.directory, "ciphertext"));
  const inputMemory = { operationId: "memory:fixture", text: "Research reports must cite dated primary sources.", source: { kind: "owner" as const, reference: "sandbox:owner-preference" } };
  if (input.phase === "write") {
    assert.equal(typeof input.runtimeSecretKey, "string");
    await writeFile(config.runtimeKeyFile, String(input.runtimeSecretKey), { flag: "wx", mode: 0o600 });
    let transactionHash: string | undefined;
    let operationId: string | undefined;
    const loseResponse = {
      submit: async (...args: Parameters<IsolatedNearSigner["submit"]>) => {
        operationId = args[0];
        const outcome = await signer.submit(...args);
        assert.equal(outcome.status, "confirmed");
        transactionHash = outcome.transactionHash;
        throw new ProviderError("OUTCOME_UNKNOWN", "Injected lost checkpoint response", false, outcome.transactionHash);
      },
      reconcile: (id: string) => signer.reconcile(id),
    };
    const memory = new MemoryService(config.agentId, Buffer.alloc(32, 42), 1, blobs, new NearMemoryHeadStore(reader, config, loseResponse));
    await assert.rejects(memory.remember(inputMemory), { code: "OUTCOME_UNKNOWN" });
    assert.ok(transactionHash);
    const a = await reader.agent(config.agentId);
    assert.equal(a.head?.version, 1);
    console.log(JSON.stringify({ phase: "write", evidence: "local-sandbox-synthetic-storage", transactionHash, operationId, version: 1 }));
  } else if (input.phase === "reconcile") {
    await assert.rejects(readFile(config.runtimeKeyFile));
    const outcome = await signer.reconcile(String(input.checkpointOperationId));
    assert.equal(outcome.status, "confirmed");
    console.log(JSON.stringify({ phase: "reconcile", status: outcome.status, transactionHash: outcome.transactionHash }));
  } else if (input.phase === "reserve" || input.phase === "accept") {
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
    assert.equal(input.phase, "recover");
    await assert.rejects(readFile(config.runtimeKeyFile));
    await assert.rejects(readFile(config.journalFile));
    const memory = new MemoryService(config.agentId, Buffer.alloc(32, 42), 1, blobs, new NearMemoryHeadStore(reader, config, signer));
    const records = await memory.recover();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.text, inputMemory.text);
    assert.deepEqual(records[0]?.source, inputMemory.source);
    assert.equal((await memory.remember(inputMemory)).duplicate, true);
    assert.equal((await reader.agent(config.agentId)).head?.version, 1);
    console.log(JSON.stringify({ phase: "recover", evidence: "local-sandbox-synthetic-storage", recovered: 1, version: 1 }));
  }
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "failed", code: error instanceof ProviderError ? error.code : "FIXTURE_ASSERTION_FAILED" }));
  process.exitCode = 1;
});
