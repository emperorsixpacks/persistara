/** Real sandbox RPC/WASM; owner keys remain only in the external Rust wallet harness. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { baseEncode } from "near-api-js";
import { NearRpc } from "../../packages/near/src/rpc.js";
import type { NearSignerConfig } from "../../packages/near/src/protocol.js";
import { OwnerJournal } from "../../packages/owner/src/journal.js";
import { OwnerReader } from "../../packages/owner/src/reader.js";
import { OwnerService } from "../../packages/owner/src/service.js";
import { isObject } from "../../packages/protocol/src/memory.js";
import { ProviderError } from "../../packages/protocol/src/providers.js";

try {
  const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(isObject(input) && typeof input.rpcUrl === "string" && typeof input.directory === "string");
  const status = await (await fetch(input.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: {} }), signal: AbortSignal.timeout(10_000) })).json() as { result: { chain_id: string } };
  const config: NearSignerConfig = { kind: "sandbox", chainId: status.result.chain_id, rpcUrl: input.rpcUrl, contractId: String(input.contractId), signerId: String(input.signerId), agentId: String(input.agentId), publicKey: String(input.runtimePublicKey), runtimeKeyFile: resolve(input.directory, "never-supplied-runtime.key"), journalFile: resolve(input.directory, "never-supplied-runtime.sqlite") };
  await assert.rejects(stat(config.runtimeKeyFile), { code: "ENOENT" });
  const rpc = new NearRpc(config);
  const hash = baseEncode(createHash("sha256").update(await readFile("target/near/persistara_authority/persistara_authority.wasm")).digest());
  // This fixture isolates owner controls. It does not claim a real memory-backup verification.
  const reader = new OwnerReader(rpc, config, hash, async () => ({ backup: { status: "verified", offDeviceVerified: false }, localRotationHold: false }));
  const journal = new OwnerJournal(resolve(input.directory, "wallet.sqlite"), config, hash);
  try {
    const service = new OwnerService(config, journal, () => reader.read(), rpc);
    if (input.phase === "prepare") {
      assert.equal(typeof input.paused, "boolean");
      const prepared = await service.prepare(input.paused as boolean); assert.ok(prepared.operation);
      const dispatched = await service.dispatch(prepared.operation.request.id, prepared.operation.digest);
      console.log(JSON.stringify({ evidence: "sandbox-owner-control-only", operation: dispatched, ownerPrivateKeySupplied: false, runtimePrivateKeySupplied: false }));
    } else if (input.phase === "repeat") {
      const row = journal.get(String(input.operationId));
      await assert.rejects(service.dispatch(row.request.id, row.digest), { code: "OUTCOME_UNKNOWN" });
      console.log(JSON.stringify({ repeatedHandoffBlocked: true }));
    } else {
      assert.equal(input.phase, "reconcile");
      const operation = await service.reconcile(String(input.operationId), String(input.transactionHash));
      assert.equal(operation.state, "confirmed"); assert.equal((await reader.read()).paused, operation.request.paused);
      console.log(JSON.stringify({ status: operation.state, transactionHash: operation.transactionHash, paused: operation.request.paused, ownerPrivateKeySupplied: false }));
    }
  } finally { journal.close(); }
} catch (error) { console.error(JSON.stringify({ status: "failed", code: error instanceof ProviderError ? error.code : "OWNER_SANDBOX_ASSERTION_FAILED" })); process.exitCode = 1; }
