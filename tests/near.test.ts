import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { KeyPair, KeyPairSigner, baseEncode, decodeSignedTransaction } from "near-api-js";
import { NearAuthorityReader, NearMemoryHeadStore, NearTreasuryClient } from "../packages/near/src/client.js";
import { IsolatedNearSigner } from "../packages/near/src/isolated.js";
import { NearJournal } from "../packages/near/src/journal.js";
import { DurableNearSigner } from "../packages/near/src/signer.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { GAS, RUNTIME_METHODS, canonical, decodeHead, type ContractCall, type NearSignerConfig } from "../packages/near/src/protocol.js";
import type { MemoryHead } from "../packages/protocol/src/memory.js";

const ref = { provider: "0g" as const, network: "0g:16602:turbo", objectId: `0x${"a".repeat(64)}`, ciphertextSha256: "b".repeat(64), byteLength: 400 };
const head: MemoryHead = { version: 1, keyEpoch: 1, manifest: ref };
const call = (): ContractCall => ({ method: "checkpoint_memory", args: { agent_id: "owner.testnet:research", generation: "2", expected_version: "0", next: { version: "1", keyEpoch: "1", manifest: structuredClone(ref) } } });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "persistara-near-"));
  const key = KeyPair.fromRandom("ed25519");
  const config: NearSignerConfig = { kind: "testnet", chainId: "testnet", rpcUrl: "https://rpc.testnet.near.org", contractId: "authority.testnet",
    signerId: "owner.testnet", publicKey: key.getPublicKey().toString(), agentId: "owner.testnet:research", journalFile: join(directory, "near.sqlite"), runtimeKeyFile: join(directory, "runtime.key") };
  const mock = {
    chainId: "testnet", permission: { FunctionCall: { receiver_id: config.contractId, method_names: [...RUNTIME_METHODS] as string[], allowance: "5000000000000000000000000" } } as unknown,
    nonce: 40, sends: 0, lostResponse: false, finality: "FINAL", changeHash: false, result: true as unknown,
    status: null as Record<string, unknown> | null, transactions: new Map<string, unknown>(), lastSigned: "", job: null as unknown,
    agent: { id: config.agentId, owner: config.signerId, ownerKey: KeyPair.fromRandom("ed25519").getPublicKey().toString(), paused: false, generation: "2", keyEpoch: "1", policyVersion: "1",
      delegates: [{ publicKey: config.publicKey, expiresAtNs: "8640000000000000", canCheckpoint: true, canSpend: true }],
      head: null as unknown, deposited: "0", available: "0", reserved: "0", pending: "0", paid: "0", withdrawn: "0" },
  };
  const rpc = new NearRpc(config, async (method, params) => {
    const p = params as Record<string, unknown>;
    if (method === "status") return { chain_id: mock.chainId, sync_info: { syncing: false } };
    if (method === "block") return { header: { timestamp_nanosec: "3600000000000" } };
    if (method === "query") {
      assert.equal(p.finality, "final");
      if (p.request_type === "view_access_key") return { nonce: mock.nonce, block_hash: baseEncode(Buffer.alloc(32, 7)), permission: mock.permission };
      return { result: [...Buffer.from(JSON.stringify(p.method_name === "get_agent" ? mock.agent : mock.job))] };
    }
    if (method === "tx") {
      assert.equal(p.wait_until, "FINAL");
      const value = mock.transactions.get(String(p.tx_hash));
      if (!value) throw new Error("not found");
      return value;
    }
    assert.equal(method, "send_tx");
    assert.equal(p.wait_until, "FINAL");
    mock.sends++;
    mock.lastSigned = String(p.signed_tx_base64);
    const signed = decodeSignedTransaction(Buffer.from(mock.lastSigned, "base64"));
    const tx = signed.transaction;
    const digest = createHash("sha256").update(tx.encode()).digest();
    // SDK decoding returns the Borsh enum's plain object, without Signature getters.
    assert.ok(key.verify(digest, Uint8Array.from(signed.signature.ed25519Signature!.data)), "standard SDK transaction signature must verify");
    const action = tx.actions[0]!.functionCall!;
    assert.equal(tx.actions.length, 1);
    assert.equal(action.deposit, 0n);
    assert.equal(action.gas, BigInt(GAS));
    const txHash = baseEncode(digest);
    const value = { final_execution_status: mock.finality, transaction: { hash: mock.changeHash ? baseEncode(Buffer.alloc(32, 8)) : txHash, signer_id: tx.signerId, public_key: tx.publicKey.toString(), receiver_id: tx.receiverId, nonce: Number(tx.nonce),
      actions: [{ FunctionCall: { method_name: action.methodName, gas: Number(action.gas), deposit: "0", args: Buffer.from(action.args).toString("base64") } }] },
      status: mock.status ?? { SuccessValue: Buffer.from(JSON.stringify(mock.result)).toString("base64") } };
    mock.transactions.set(txHash, value);
    if (action.methodName === "checkpoint_memory" && mock.result === true && !mock.status) mock.agent.head = JSON.parse(Buffer.from(action.args).toString()).next;
    if (mock.lostResponse) throw new Error("response lost after inclusion");
    return value;
  });
  let journal = new NearJournal(config.journalFile, config);
  return { config, mock, rpc, key, directory, get journal() { return journal; },
    signer: (onPrepared?: (hash: string) => void) => new DurableNearSigner(config, rpc, journal, new KeyPairSigner(key), onPrepared),
    restart: () => { journal.close(); journal = new NearJournal(config.journalFile, config); },
    close: async () => { journal.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

describe("durable restricted NEAR signer (offline RPC fixtures)", () => {
  it("persists the signed transaction before sending and replays a finalized operation without another broadcast", async () => {
    const f = await fixture();
    try {
      const result = await f.signer((txHash) => { assert.equal(f.journal.get("op:one")?.tx_hash, txHash); assert.equal(f.mock.sends, 0); }).submit("op:one", call());
      assert.equal(result.status, "confirmed");
      assert.equal(f.journal.get("op:one")?.nonce, "41");
      f.restart();
      assert.deepEqual(await f.signer().submit("op:one", call()), result);
      assert.equal(f.mock.sends, 1);
    } finally { await f.close(); }
  });
  it("reconciles a lost response after reopening the journal without resending or needing a private key", async () => {
    const f = await fixture();
    try {
      f.mock.lostResponse = true;
      const result = await f.signer().submit("op:lost", call());
      assert.equal(result.status, "unknown");
      f.restart();
      const readerOnly = new DurableNearSigner(f.config, f.rpc, f.journal);
      assert.equal((await readerOnly.reconcile("op:lost")).status, "confirmed");
      assert.equal(f.mock.sends, 1);
    } finally { await f.close(); }
  });
  it("resumes a crash after preparation using the exact same signed bytes", async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.signer(() => { throw new Error("crash before submission"); }).submit("op:prepared", call()), /crash/);
      const before = f.journal.get("op:prepared")!;
      assert.equal(before.state, "prepared");
      assert.equal(f.mock.sends, 0);
      f.restart();
      assert.equal((await f.signer().reconcile("op:prepared")).status, "unknown");
      assert.equal(f.journal.get("op:prepared")?.state, "prepared");
      assert.equal((await f.signer().submit("op:prepared", call())).status, "confirmed");
      assert.equal(f.mock.lastSigned, before.signed);
    } finally { await f.close(); }
  });
  it("keeps a crash at the submission boundary unknown and fences other operations", async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.signer(() => { throw new Error("crash"); }).submit("op:ambiguous", call()));
      f.journal.submitted("op:ambiguous"); // crash after durable submitted marker, before network call
      f.restart();
      assert.equal((await f.signer().submit("op:ambiguous", call())).status, "unknown");
      await assert.rejects(f.signer().submit("op:new", call()), { code: "SIGNER_BUSY" });
      assert.equal(f.mock.sends, 0);
    } finally { await f.close(); }
  });
  it("rejects same-ID changed payloads, including after a confirmed transaction", async () => {
    const f = await fixture();
    try {
      await f.signer().submit("op:one", call());
      const changed = call(); changed.args.generation = "3";
      await assert.rejects(f.signer().submit("op:one", changed), { code: "OPERATION_CONFLICT" });
      assert.equal(f.mock.sends, 1);
    } finally { await f.close(); }
  });
  it("allows only one broadcast when two callers race for the same operation", async () => {
    const f = await fixture();
    try {
      await Promise.all([f.signer().submit("op:race", call()), f.signer().submit("op:race", call())]);
      assert.equal(f.mock.sends, 1);
      assert.equal((await f.signer().reconcile("op:race")).status, "confirmed");
    } finally { await f.close(); }
  });
  it("rejects wrong networks and full-access, unrestricted, excessive-scope, or wrong-receiver keys before signing", async () => {
    const f = await fixture();
    try {
      f.mock.chainId = "mainnet";
      await assert.rejects(f.signer().submit("op:network", call()), { code: "NETWORK_MISMATCH" });
      f.mock.chainId = "testnet";
      for (const permission of ["FullAccess", { FunctionCall: { receiver_id: f.config.contractId, method_names: [], allowance: "1" } },
        { FunctionCall: { receiver_id: "wrong.testnet", method_names: [...RUNTIME_METHODS], allowance: "1" } },
        { FunctionCall: { receiver_id: f.config.contractId, method_names: [...RUNTIME_METHODS, "fund"], allowance: "1" } },
        { FunctionCall: { receiver_id: f.config.contractId, method_names: [...RUNTIME_METHODS], allowance: null } }]) {
        f.mock.permission = permission;
        await assert.rejects(f.signer().submit("op:key", call()), { code: "AUTHORIZATION_FAILED" });
      }
      assert.equal(f.mock.sends, 0);
      assert.equal(f.journal.get("op:key"), null);
    } finally { await f.close(); }
  });
  it("rejects the owner registration key even if it has been made a function-call key", async () => {
    const f = await fixture();
    try {
      f.mock.agent.ownerKey = f.config.publicKey;
      await assert.rejects(f.signer().submit("op:owner", call()), { code: "AUTHORIZATION_FAILED" });
      assert.equal(f.mock.sends, 0);
    } finally { await f.close(); }
  });
  it("rejects missing, expired, paused and insufficient-permission grants before signing", async () => {
    const f = await fixture();
    try {
      f.mock.agent.delegates[0]!.expiresAtNs = "1";
      await assert.rejects(f.signer().submit("op:expired", call()), { code: "AUTHORIZATION_FAILED" });
      f.mock.agent.delegates[0]!.expiresAtNs = "8640000000000000";
      f.mock.agent.delegates[0]!.canCheckpoint = false;
      await assert.rejects(f.signer().submit("op:permission", call()), { code: "AUTHORIZATION_FAILED" });
      f.mock.agent.delegates[0]!.canCheckpoint = true;
      f.mock.agent.paused = true;
      await assert.rejects(f.signer().submit("op:paused", call()), { code: "AUTHORIZATION_FAILED" });
      f.mock.agent.paused = false;
      f.mock.agent.delegates = [];
      await assert.rejects(f.signer().submit("op:revoked", call()), { code: "AUTHORIZATION_FAILED" });
      assert.equal(f.mock.sends, 0);
    } finally { await f.close(); }
  });
  it("does not confirm optimistic or mismatched transaction responses", async () => {
    for (const mode of ["optimistic", "mismatch"] as const) {
      const f = await fixture();
      try {
        if (mode === "optimistic") f.mock.finality = "EXECUTED_OPTIMISTIC"; else f.mock.changeHash = true;
        assert.equal((await f.signer().submit("op:unfinal", call())).status, "unknown");
        assert.equal((await f.signer().submit("op:unfinal", call())).status, "unknown");
        assert.equal(f.mock.sends, 1);
      } finally { await f.close(); }
    }
  });
  it("records final contract failures and permits a later distinct operation without duplicating the failed one", async () => {
    const f = await fixture();
    try {
      f.mock.status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_AGENT_PAUSED" } } } } };
      const result = await f.signer().submit("op:failed", call());
      assert.deepEqual(result, { status: "failed", transactionHash: result.transactionHash, failureCode: "ERR_AGENT_PAUSED" });
      f.mock.status = null;
      assert.equal((await f.signer().submit("op:next", call())).status, "confirmed");
      assert.equal(f.journal.get("op:next")?.nonce, "42");
      assert.equal((await f.signer().submit("op:failed", call())).status, "failed");
      assert.equal(f.mock.sends, 2);
    } finally { await f.close(); }
  });
  it("binds the journal to its agent, contract, network, account and public key", async () => {
    const f = await fixture();
    try {
      for (const change of [{ agentId: "owner.testnet:other" }, { contractId: "other.testnet" }, { chainId: "other" }, { publicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString() }]) {
        assert.throws(() => new NearJournal(f.config.journalFile, { ...f.config, ...change }), { code: "NETWORK_MISMATCH" });
      }
    } finally { await f.close(); }
  });
  it("reports a post-submission journal failure as unknown and later reconciles the same transaction", async () => {
    const f = await fixture();
    try {
      f.journal.saveOutcome = () => { throw new Error("injected disk failure"); };
      await assert.rejects(f.signer().submit("op:disk", call()), { code: "OUTCOME_UNKNOWN" });
      f.restart();
      assert.equal((await f.signer().reconcile("op:disk")).status, "confirmed");
      assert.equal(f.mock.sends, 1);
    } finally { await f.close(); }
  });
});

describe("finalized NEAR memory and treasury clients", () => {
  it("persists a durable checkpoint identity and reconciles its exact transaction after the head advances", async () => {
    const f = await fixture();
    try {
      const store = new NearMemoryHeadStore(new NearAuthorityReader(f.rpc), f.config, f.signer());
      const plan = (await store.prepare(f.config.agentId, 0, head))!;
      assert.ok(plan); const identity = f.journal.identity();
      f.mock.lostResponse = true;
      await assert.rejects(store.submit(plan), { code: "OUTCOME_UNKNOWN" });
      f.restart(); assert.equal(f.journal.identity(), identity);
      f.mock.agent.paused = true; // Reconciliation cannot depend on new write authorization.
      assert.equal(await new NearMemoryHeadStore(new NearAuthorityReader(f.rpc), f.config, f.signer()).reconcile(plan), "accepted");
      assert.equal(f.mock.sends, 1);
    } finally { await f.close(); }
  });
  it("fences a checkpoint if the signer journal was replaced and permits RPC endpoint failover", async () => {
    const f = await fixture();
    const other = new NearJournal(join(f.directory, "replacement.sqlite"), f.config);
    try {
      const store = new NearMemoryHeadStore(new NearAuthorityReader(f.rpc), f.config, f.signer());
      const plan = (await store.prepare(f.config.agentId, 0, head))!;
      const replaced = new NearMemoryHeadStore(new NearAuthorityReader(f.rpc), f.config, new DurableNearSigner(f.config, f.rpc, other, new KeyPairSigner(f.key)));
      await assert.rejects(replaced.submit(plan), { code: "INTEGRITY_FAILED" });
      await assert.rejects(replaced.reconcile(plan), { code: "INTEGRITY_FAILED" });
      assert.equal(f.mock.sends, 0);
      const rpc = new NearRpc({ ...f.config, rpcUrl: "https://failover.invalid" }, (method, params) => f.rpc.request(method, params));
      const failover = new NearMemoryHeadStore(new NearAuthorityReader(rpc), f.config, f.signer());
      assert.equal(await failover.submit(plan), true); assert.equal(f.mock.sends, 1);
    } finally { other.close(); await f.close(); }
  });
  it("checks active runtime checkpoint permission before preparing a durable effect", async () => {
    const f = await fixture();
    try {
      const store = new NearMemoryHeadStore(new NearAuthorityReader(f.rpc), f.config, f.signer());
      for (const change of [{ canCheckpoint: false }, { expiresAtNs: "1" }]) {
        const previous = { ...f.mock.agent.delegates[0]! };
        Object.assign(f.mock.agent.delegates[0]!, change);
        await assert.rejects(store.assertWritable(1), { code: "AUTHORIZATION_FAILED" });
        Object.assign(f.mock.agent.delegates[0]!, previous);
      }
      f.mock.permission = "FullAccess";
      await assert.rejects(store.assertWritable(1), { code: "AUTHORIZATION_FAILED" });
      assert.equal(f.mock.sends, 0);
    } finally { await f.close(); }
  });
  it("checks the expected journal identity inside the isolated worker and replays terminal outcomes without loading a key", async () => {
    const f = await fixture();
    try {
      const isolated = new IsolatedNearSigner(f.config);
      const identity = await isolated.journalIdentity(false);
      assert.equal(identity, f.journal.identity());
      await assert.rejects(isolated.submit("op:wrong-journal", call(), { journalIdentity: randomUUID() }), { code: "INTEGRITY_FAILED" });
      const result = await f.signer().submit("op:terminal", call());
      // The fixture never created runtime.key. A terminal replay must not load it or contact the public RPC.
      assert.deepEqual(await isolated.submit("op:terminal", call(), { journalIdentity: identity }), result);
      assert.equal(f.mock.sends, 1);
    } finally { await f.close(); }
  });
  it("uses the real memory port with string U64 encoding and a confirmed CAS result", async () => {
    const f = await fixture();
    try {
      const store = new NearMemoryHeadStore(new NearAuthorityReader(f.rpc), f.config, f.signer());
      assert.equal(await store.get(f.config.agentId), null);
      assert.equal(await store.compareAndSwap(f.config.agentId, 0, head), true);
      assert.deepEqual(await store.get(f.config.agentId), head);
      assert.equal(await store.compareAndSwap(f.config.agentId, 0, head), false);
      assert.equal(f.mock.sends, 1);
    } finally { await f.close(); }
  });
  it("propagates unknown outcomes instead of treating them as stale CAS or success", async () => {
    const f = await fixture();
    try {
      f.mock.lostResponse = true;
      const store = new NearMemoryHeadStore(new NearAuthorityReader(f.rpc), f.config, f.signer());
      await assert.rejects(store.compareAndSwap(f.config.agentId, 0, head), { code: "OUTCOME_UNKNOWN" });
      assert.deepEqual(await store.get(f.config.agentId), head);
      assert.equal(f.mock.sends, 1);
    } finally { await f.close(); }
  });
  it("rejects paused agents, cross-agent access, wrong epochs and unsafe integer versions before signing", async () => {
    const f = await fixture();
    try {
      const store = new NearMemoryHeadStore(new NearAuthorityReader(f.rpc), f.config, f.signer());
      await assert.rejects(store.get("owner.testnet:other"), { code: "AUTHORIZATION_FAILED" });
      f.mock.agent.paused = true;
      await assert.rejects(store.compareAndSwap(f.config.agentId, 0, head), { code: "AUTHORIZATION_FAILED" });
      f.mock.agent.paused = false;
      await assert.rejects(store.compareAndSwap(f.config.agentId, 0, { ...head, keyEpoch: 2 }), { code: "AUTHORIZATION_FAILED" });
      assert.throws(() => decodeHead({ version: "9007199254740992", keyEpoch: "1", manifest: ref }));
      assert.equal(f.mock.sends, 0);
    } finally { await f.close(); }
  });
  it("reports payout state from finalized job storage rather than acceptance's success receipt", async () => {
    const f = await fixture();
    try {
      f.mock.result = { status: "payout_pending" };
      f.mock.job = { request: { agentId: f.config.agentId, operationId: "job:one", worker: "worker.testnet", amount: "1000000000000000000000000" }, result: ref, payoutAttempt: "1", status: "payout_failed" };
      const treasury = new NearTreasuryClient(new NearAuthorityReader(f.rpc), f.config, f.signer());
      assert.equal((await treasury.accept("job:one", "2", ref.ciphertextSha256)).status, "payout_failed");
    } finally { await f.close(); }
  });
  it("refuses absent deliveries and artifact mismatches before signing acceptance", async () => {
    const f = await fixture();
    try {
      const treasury = new NearTreasuryClient(new NearAuthorityReader(f.rpc), f.config, f.signer());
      await assert.rejects(treasury.accept("job:one", "2", ref.ciphertextSha256), { code: "AUTHORIZATION_FAILED" });
      f.mock.job = { request: { agentId: f.config.agentId, operationId: "job:one", worker: "worker.testnet", amount: "1" }, result: ref, payoutAttempt: "0", status: "delivered" };
      await assert.rejects(treasury.accept("job:one", "2", "c".repeat(64)), { code: "AUTHORIZATION_FAILED" });
      assert.equal(f.mock.sends, 0);
    } finally { await f.close(); }
  });
  it("permits an explicit idempotent acceptance retry after final failure and decodes newline-prefixed contract errors", async () => {
    const f = await fixture();
    try {
      f.mock.job = { request: { agentId: f.config.agentId, operationId: "job:one", worker: "worker.testnet", amount: "1" }, result: ref, payoutAttempt: "0", status: "delivered" };
      f.mock.status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked at source.rs:20:\nERR_DELIVERY_REQUIRED" } } } } };
      const treasury = new NearTreasuryClient(new NearAuthorityReader(f.rpc), f.config, f.signer());
      await assert.rejects(treasury.accept("job:one", "2", ref.ciphertextSha256), { code: "TRANSACTION_FAILED" });
      const prior = await f.signer().reconcile("accept:job:one");
      assert.equal(prior.status, "failed");
      if (prior.status === "failed") assert.equal(prior.failureCode, "ERR_DELIVERY_REQUIRED");
      f.mock.status = null;
      await treasury.accept("job:one", "2", ref.ciphertextSha256, 1);
      await treasury.accept("job:one", "2", ref.ciphertextSha256, 1);
      assert.equal(f.mock.sends, 2);
      await assert.rejects(treasury.accept("job:one", "2", ref.ciphertextSha256, 2), { code: "OPERATION_CONFLICT" });
      assert.equal(f.mock.sends, 2);
    } finally { await f.close(); }
  });
  it("never replaces unknown or confirmed acceptance outcomes", async () => {
    const f = await fixture();
    try {
      f.mock.job = { request: { agentId: f.config.agentId, operationId: "job:one", worker: "worker.testnet", amount: "1" }, result: ref, payoutAttempt: "0", status: "delivered" };
      const treasury = new NearTreasuryClient(new NearAuthorityReader(f.rpc), f.config, f.signer());
      f.mock.lostResponse = true;
      await assert.rejects(treasury.accept("job:one", "2", ref.ciphertextSha256), { code: "OUTCOME_UNKNOWN" });
      const transactions = new Map(f.mock.transactions); f.mock.transactions.clear();
      await assert.rejects(treasury.accept("job:one", "2", ref.ciphertextSha256, 1), { code: "OUTCOME_UNKNOWN" });
      assert.equal(f.mock.sends, 1);
      for (const [key, value] of transactions) f.mock.transactions.set(key, value);
      await assert.rejects(treasury.accept("job:one", "2", ref.ciphertextSha256, 1), { code: "OPERATION_CONFLICT" });
      assert.equal(f.mock.sends, 1);
    } finally { await f.close(); }
  });
  it("requires a recorded prior failed acceptance and bounds explicit retry attempts", async () => {
    const f = await fixture();
    try {
      f.mock.job = { request: { agentId: f.config.agentId, operationId: "job:one", worker: "worker.testnet", amount: "1" }, result: ref, payoutAttempt: "0", status: "delivered" };
      const treasury = new NearTreasuryClient(new NearAuthorityReader(f.rpc), f.config, f.signer());
      await assert.rejects(treasury.accept("job:one", "2", ref.ciphertextSha256, 1), { code: "INVALID_INPUT" });
      for (const attempt of [-1, 1.5, 9]) await assert.rejects(treasury.accept("job:one", "2", ref.ciphertextSha256, attempt), { code: "INVALID_INPUT" });
      assert.equal(f.mock.sends, 0);
    } finally { await f.close(); }
  });
  it("rejects malformed balances and unsupported blob providers without dispatching", async () => {
    const f = await fixture();
    try {
      f.mock.agent.available = "1";
      await assert.rejects(new NearAuthorityReader(f.rpc).agent(f.config.agentId), { code: "PROTOCOL_ERROR" });
      const invalid = call(); (invalid.args.next as Record<string, unknown>).manifest = { ...ref, provider: "local" };
      await assert.rejects(f.signer().submit("op:local", invalid), { code: "INVALID_INPUT" });
      assert.equal(f.mock.sends, 0);
    } finally { await f.close(); }
  });
  it("keeps the isolated interface narrow and does not pass key bytes to a caller's process", async () => {
    const f = await fixture();
    try {
      const isolated = new IsolatedNearSigner(f.config, async (_module, request, options) => {
        assert.equal(options.effect, "may-charge");
        assert.equal(JSON.stringify(request).includes(f.key.toString()), false);
        return { status: "confirmed", transactionHash: baseEncode(Buffer.alloc(32, 1)), result: true };
      });
      assert.equal((await isolated.submit("op:one", call())).status, "confirmed");
      await assert.rejects(isolated.submit("op:bad", { method: "fund", args: {} } as unknown as ContractCall), { code: "INVALID_INPUT" });
      assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
    } finally { await f.close(); }
  });
});

describe("bounded NEAR JSON-RPC transport", () => {
  it("retries only opted-in temporary reads and never retries a broadcast, bad envelope or exhausted connection", async () => {
    const original = globalThis.fetch;
    try {
      const config = { kind: "testnet" as const, chainId: "testnet" as const, rpcUrl: "https://rpc.testnet.near.org", contractId: "authority.testnet" };
      const rpc = new NearRpc(config, undefined, { readAttempts: 2, timeoutMs: 1000 });
      let calls = 0;
      globalThis.fetch = async (_url, init) => { assert.equal(init?.redirect, "error"); calls++; if (calls === 1) throw new TypeError("secret transport detail"); return Response.json({ jsonrpc: "2.0", id: "persistara", result: { ok: true } }); };
      assert.deepEqual(await rpc.request("status", {}), { ok: true }); assert.equal(calls, 2);
      for (const code of [429, 502, 503, 504]) {
        calls = 0; globalThis.fetch = async () => ++calls === 1 ? new Response(null, { status: code }) : Response.json({ jsonrpc: "2.0", id: "persistara", result: { ok: true } });
        assert.deepEqual(await rpc.request("query", { block_id: "fixed-finalized-block" }), { ok: true }); assert.equal(calls, 2);
      }
      for (const method of ["status", "broadcast_tx_commit", "broadcast_tx_async", "send_tx"]) {
        calls = 0; globalThis.fetch = async () => { calls++; throw new TypeError("secret transport detail"); };
        await assert.rejects(rpc.request(method, {}), error => error instanceof Error && !error.message.includes("secret") && (method === "status" || (error as { retryable?: boolean }).retryable === false));
        assert.equal(calls, method === "status" ? 2 : 1);
      }
      for (const response of [() => new Response("malformed"), () => new Response(null, { status: 401 }), () => Response.json({ jsonrpc: "2.0", id: "wrong", result: {} }), () => Response.json({ jsonrpc: "2.0", id: "persistara", error: { message: "sensitive" } })]) {
        calls = 0; globalThis.fetch = async () => { calls++; return response(); };
        await assert.rejects(rpc.request("status", {})); assert.equal(calls, 1);
      }
      calls = 0; globalThis.fetch = async () => { calls++; throw new TypeError("unavailable"); };
      await assert.rejects(new NearRpc(config).request("status", {})); assert.equal(calls, 1);
      assert.throws(() => new NearRpc(config, undefined, { timeoutMs: 30_001 }));
    } finally { globalThis.fetch = original; }
  });
  it("uses explicit finality and rejects error envelopes, redirects and oversized replies without retrying", async () => {
    const original = globalThis.fetch;
    try {
      const rpc = new NearRpc({ kind: "testnet", chainId: "testnet", rpcUrl: "https://rpc.testnet.near.org", contractId: "authority.testnet" });
      let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls++;
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal);
        const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
        if (body.method === "status") return Response.json({ jsonrpc: "2.0", id: "persistara", result: { chain_id: "testnet", sync_info: { syncing: false } } });
        assert.equal(body.params.finality, "final");
        return Response.json({ jsonrpc: "2.0", id: "persistara", error: { message: "sensitive upstream detail" } });
      };
      await assert.rejects(rpc.view("get_agent", { agent_id: "owner.testnet:research" }), (error: unknown) => error instanceof Error && !error.message.includes("sensitive"));
      assert.equal(calls, 2);
      globalThis.fetch = async () => new Response("x".repeat(1_000_001));
      await assert.rejects(rpc.request("status", {}), { code: "PROTOCOL_ERROR" });
      globalThis.fetch = async () => Response.json({ jsonrpc: "2.0", id: "wrong-id", result: {} });
      await assert.rejects(rpc.request("status", {}), { code: "UPSTREAM_ERROR" });
    } finally { globalThis.fetch = original; }
  });
});
