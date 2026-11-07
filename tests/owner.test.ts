import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, it } from "node:test";
import { KeyPair, baseEncode } from "near-api-js";
import { OwnerAuth } from "../packages/owner/src/auth.js";
import { OwnerJournal, validatePause } from "../packages/owner/src/journal.js";
import { OwnerService } from "../packages/owner/src/service.js";
import { ownerFixture, ownerReceipt, signChallenge } from "./fixtures/owner-support.js";

describe("owner-wallet authentication with the standard SDK NEP-413 verifier", () => {
  it("accepts the registered external owner proof and rejects replay and expired sessions", async () => {
    const f = await ownerFixture(); let now = 1000;
    try {
      const auth = new OwnerAuth("http://127.0.0.1:3377", f.read, () => now);
      const challenge = await auth.challenge(); const proof = await signChallenge(f.owner, challenge);
      const result = await auth.login(challenge.id, proof);
      assert.equal(auth.require(result.token, result.session.csrf).owner, f.config.signerId);
      assert.equal(challenge.recipient, "http://127.0.0.1:3377");
      assert.ok(challenge.message.includes(f.config.contractId)); assert.ok(challenge.message.includes(f.config.agentId));
      await assert.rejects(auth.login(challenge.id, proof), { code: "AUTHORIZATION_FAILED" });
      now += 600_001; assert.throws(() => auth.require(result.token), { code: "AUTHORIZATION_FAILED" });
    } finally { await f.close(); }
  });
  it("rejects a runtime key and another full-access owner-account key", async () => {
    const f = await ownerFixture();
    try {
      for (const wrong of [f.runtime, KeyPair.fromRandom("ed25519")]) {
        const auth = new OwnerAuth("http://127.0.0.1:3377", f.read);
        const challenge = await auth.challenge();
        await assert.rejects(auth.login(challenge.id, await signChallenge(wrong, challenge)), { code: "AUTHORIZATION_FAILED" });
      }
    } finally { await f.close(); }
  });
  it("binds the signature to origin, message, account, nonce and the challenge cookie", async () => {
    const f = await ownerFixture();
    try {
      for (const mutate of [
        (c: Awaited<ReturnType<OwnerAuth["challenge"]>>) => { c.recipient = "https://attacker.invalid"; },
        (c: Awaited<ReturnType<OwnerAuth["challenge"]>>) => { c.message += " changed"; },
        (c: Awaited<ReturnType<OwnerAuth["challenge"]>>) => { c.nonce = randomBytes(32).toString("base64url"); },
      ]) {
        const auth = new OwnerAuth("http://127.0.0.1:3377", f.read); const c = await auth.challenge(); const modified = structuredClone(c); mutate(modified);
        await assert.rejects(auth.login(c.id, await signChallenge(f.owner, modified)), { code: "AUTHORIZATION_FAILED" });
      }
      const auth = new OwnerAuth("http://127.0.0.1:3377", f.read); const c = await auth.challenge(); const proof = await signChallenge(f.owner, c);
      await assert.rejects(auth.login(undefined, proof), { code: "AUTHORIZATION_FAILED" });
      await assert.rejects(auth.login(c.id, { ...proof, accountId: "other.testnet" }), { code: "AUTHORIZATION_FAILED" });
    } finally { await f.close(); }
  });
  it("consumes a challenge atomically before concurrent verification", async () => {
    const f = await ownerFixture();
    try {
      const auth = new OwnerAuth("http://127.0.0.1:3377", f.read); const c = await auth.challenge(); const proof = await signChallenge(f.owner, c);
      const result = await Promise.allSettled([auth.login(c.id, proof), auth.login(c.id, proof)]);
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    } finally { await f.close(); }
  });
  it("rejects revoked ownership, malformed signatures, extra fields and expired challenges", async () => {
    const f = await ownerFixture(); let now = 1000;
    try {
      const auth = new OwnerAuth("http://127.0.0.1:3377", f.read, () => now);
      let c = await auth.challenge(); let proof = await signChallenge(f.owner, c);
      f.view.ownerKeyFullAccess = false;
      await assert.rejects(auth.login(c.id, proof), { code: "AUTHORIZATION_FAILED" });
      f.view.ownerKeyFullAccess = true;
      c = await auth.challenge(); proof = await signChallenge(f.owner, c);
      await assert.rejects(auth.login(c.id, { ...proof, signature: "not-base64" }), { code: "AUTHORIZATION_FAILED" });
      c = await auth.challenge(); proof = await signChallenge(f.owner, c);
      await assert.rejects(auth.login(c.id, { ...proof, secret: "unexpected" }), { code: "AUTHORIZATION_FAILED" });
      c = await auth.challenge(); proof = await signChallenge(f.owner, c); now += 300_001;
      await assert.rejects(auth.login(c.id, proof), { code: "AUTHORIZATION_FAILED" });
    } finally { await f.close(); }
  });
  it("rejects missing/wrong/Unicode CSRF values and invalidates logout", async () => {
    const f = await ownerFixture();
    try {
      const auth = new OwnerAuth("http://127.0.0.1:3377", f.read); const c = await auth.challenge();
      const result = await auth.login(c.id, await signChallenge(f.owner, c));
      for (const invalid of ["", "x".repeat(43), "é".repeat(43)]) assert.throws(() => auth.require(result.token, invalid), { code: "AUTHORIZATION_FAILED" });
      auth.logout(result.token); assert.throws(() => auth.require(result.token), { code: "AUTHORIZATION_FAILED" });
    } finally { await f.close(); }
  });
  it("bounds outstanding challenges and releases expired capacity", async () => {
    const f = await ownerFixture(); let now = 1000;
    try {
      const auth = new OwnerAuth("http://127.0.0.1:3377", f.read, () => now);
      for (let i = 0; i < 32; i++) await auth.challenge();
      await assert.rejects(auth.challenge(), { code: "OPERATION_CONFLICT" }); now += 300_001;
      await auth.challenge();
    } finally { await f.close(); }
  });
});

describe("durable owner-wallet intents and public transaction reconciliation", () => {
  it("prepares zero-deposit review once and allows only one wallet handoff", async () => {
    const f = await ownerFixture();
    try {
      const prepared = await f.service().prepare(true); const row = prepared.operation!;
      assert.deepEqual((await f.service().prepare(true)).operation, row);
      assert.equal(row.request.actions[0].params.deposit, "0"); assert.equal(f.transport.calls, 0);
      const result = await Promise.allSettled([f.service().dispatch(row.request.id, row.digest), f.service().dispatch(row.request.id, row.digest)]);
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
      await assert.rejects(f.service().prepare(false), { code: "OUTCOME_UNKNOWN" });
      assert.throws(() => f.journal().cancel(row.request.id), { code: "OPERATION_CONFLICT" });
    } finally { await f.close(); }
  });
  it("allows cancellation only before wallet handoff and observes an existing target without a transaction", async () => {
    const f = await ownerFixture();
    try {
      assert.equal((await f.service().prepare(false)).operation, null);
      const row = (await f.service().prepare(true)).operation!;
      assert.equal(f.journal().cancel(row.request.id).state, "canceled");
      assert.notEqual((await f.service().prepare(true)).operation!.request.id, row.request.id);
      assert.equal(f.transport.calls, 0);
    } finally { await f.close(); }
  });
  it("fences changed authority, nonce, reviewed digest and backup/rotation readiness before handoff", async () => {
    const f = await ownerFixture();
    try {
      const row = (await f.service().prepare(true)).operation!;
      await assert.rejects(f.service().dispatch(row.request.id, "0".repeat(64)), { code: "INTEGRITY_FAILED" });
      f.view.generation = "4"; await assert.rejects(f.service().dispatch(row.request.id, row.digest), { code: "OPERATION_CONFLICT" });
      f.view.generation = "3"; f.view.ownerNonce++; await assert.rejects(f.service().dispatch(row.request.id, row.digest), { code: "OPERATION_CONFLICT" });
      f.view.ownerNonce--; f.view.ownerKeyFullAccess = false; await assert.rejects(f.service().dispatch(row.request.id, row.digest), { code: "AUTHORIZATION_FAILED" });
      f.view.ownerKeyFullAccess = true; f.journal().cancel(row.request.id); f.view.paused = true; f.view.canResume = false;
      await assert.rejects(f.service().prepare(false), { code: "AUTHORIZATION_FAILED" });
      assert.equal(f.transport.calls, 0);
    } finally { await f.close(); }
  });
  it("rechecks session authorization after the asynchronous state read", async () => {
    const f = await ownerFixture();
    try {
      const row = (await f.service().prepare(true)).operation!;
      await assert.rejects(f.service().dispatch(row.request.id, row.digest, () => { throw Object.assign(new Error("expired"), { code: "AUTHORIZATION_FAILED" }); }), { code: "AUTHORIZATION_FAILED" });
      assert.equal(f.journal().get(row.request.id).state, "prepared");
    } finally { await f.close(); }
  });
  it("retains unknown handoffs across restart and resolves a lost response without another dispatch", async () => {
    const f = await ownerFixture();
    try {
      const row = (await f.service().prepare(true)).operation!; await f.service().dispatch(row.request.id, row.digest);
      f.restart(); assert.equal(f.journal().get(row.request.id).state, "unknown");
      await assert.rejects(f.service().dispatch(row.request.id, row.digest), { code: "OUTCOME_UNKNOWN" });
      const receipt = ownerReceipt(row), txHash = receipt.transaction.hash;
      f.transport.available = false;
      assert.equal((await f.service().reconcile(row.request.id, txHash)).state, "unknown");
      assert.equal(f.journal().get(row.request.id).transactionHash, null);
      f.transport.available = true; f.transport.transactions.set(txHash, receipt);
      const confirmed = await f.service().reconcile(row.request.id, txHash);
      assert.equal(confirmed.state, "confirmed"); assert.equal(confirmed.transactionHash, txHash);
      const calls = f.transport.calls; await f.service().reconcile(row.request.id); assert.equal(f.transport.calls, calls);
    } finally { await f.close(); }
  });
  it("never signs again when a wallet cancellation or missing hash cannot prove no broadcast", async () => {
    const f = await ownerFixture();
    try {
      const row = (await f.service().prepare(true)).operation!; await f.service().dispatch(row.request.id, row.digest);
      assert.equal((await f.service().reconcile(row.request.id)).state, "dispatched");
      await assert.rejects(f.service().prepare(true), { code: "OUTCOME_UNKNOWN" });
      assert.equal(f.transport.calls, 0);
    } finally { await f.close(); }
  });
  it("requires finality and prevents replacing a bound matching transaction", async () => {
    const f = await ownerFixture();
    try {
      const row = (await f.service().prepare(true)).operation!; await f.service().dispatch(row.request.id, row.digest);
      const receipt = ownerReceipt(row); receipt.final_execution_status = "EXECUTED_OPTIMISTIC";
      f.transport.transactions.set(receipt.transaction.hash, receipt);
      const result = await f.service().reconcile(row.request.id, receipt.transaction.hash);
      assert.equal(result.state, "unknown"); assert.equal(result.transactionHash, receipt.transaction.hash);
      await assert.rejects(f.service().reconcile(row.request.id, baseEncode(randomBytes(32))), { code: "OPERATION_CONFLICT" });
      receipt.final_execution_status = "FINAL"; f.transport.transactions.set(receipt.transaction.hash, receipt);
      assert.equal((await f.service().reconcile(row.request.id)).state, "confirmed");
    } finally { await f.close(); }
  });
  it("rejects substituted account/key/receiver/action/arguments/gas/deposit/nonce without binding its hash", async () => {
    const mutations = [
      (r: ReturnType<typeof ownerReceipt>) => { r.transaction.signer_id = "other.testnet"; },
      (r: ReturnType<typeof ownerReceipt>) => { r.transaction.public_key = KeyPair.fromRandom("ed25519").getPublicKey().toString(); },
      (r: ReturnType<typeof ownerReceipt>) => { r.transaction.receiver_id = "other.testnet"; },
      (r: ReturnType<typeof ownerReceipt>) => { r.transaction.actions[0]!.FunctionCall.method_name = "fund"; },
      (r: ReturnType<typeof ownerReceipt>) => { r.transaction.actions[0]!.FunctionCall.deposit = "1"; },
      (r: ReturnType<typeof ownerReceipt>) => { r.transaction.actions[0]!.FunctionCall.gas = 1; },
      (r: ReturnType<typeof ownerReceipt>) => { r.transaction.actions[0]!.FunctionCall.args = Buffer.from("{}").toString("base64"); },
      (r: ReturnType<typeof ownerReceipt>) => { r.transaction.nonce--; },
    ];
    for (const mutate of mutations) {
      const f = await ownerFixture();
      try {
        const row = (await f.service().prepare(true)).operation!; await f.service().dispatch(row.request.id, row.digest);
        const receipt = ownerReceipt(row); mutate(receipt); f.transport.transactions.set(receipt.transaction.hash, receipt);
        await assert.rejects(f.service().reconcile(row.request.id, receipt.transaction.hash), { code: "INTEGRITY_FAILED" });
        assert.equal(f.journal().get(row.request.id).transactionHash, null);
      } finally { await f.close(); }
    }
  });
  it("does not mark success from a changed return value and retains conclusively failed receipts", async () => {
    const f = await ownerFixture();
    try {
      const row = (await f.service().prepare(true)).operation!; await f.service().dispatch(row.request.id, row.digest);
      const receipt = ownerReceipt(row); receipt.status.SuccessValue = Buffer.from("{}").toString("base64"); f.transport.transactions.set(receipt.transaction.hash, receipt);
      await assert.rejects(f.service().reconcile(row.request.id, receipt.transaction.hash), { code: "INTEGRITY_FAILED" });
      f.transport.transactions.set(receipt.transaction.hash, { ...receipt, status: { Failure: { ExecutionError: "fixture" } } });
      assert.equal((await f.service().reconcile(row.request.id)).state, "failed");
      assert.ok((await f.service().prepare(true)).operation);
    } finally { await f.close(); }
  });
  it("refuses journal scope changes, unsafe action schemas and corrupted request digests", async () => {
    const f = await ownerFixture();
    try {
      const row = (await f.service().prepare(true)).operation!;
      const invalid = structuredClone(row.request); (invalid.actions[0].params as { deposit: string }).deposit = "1";
      assert.throws(() => validatePause(invalid, f.config), { code: "INTEGRITY_FAILED" });
      assert.throws(() => new OwnerJournal(f.journalFile, { ...f.config, contractId: "different.testnet" }, f.codeHash), { code: "INTEGRITY_FAILED" });
      const db = new DatabaseSync(f.journalFile); db.prepare("UPDATE owner_operations SET digest=? WHERE id=?").run("0".repeat(64), row.request.id); db.close();
      assert.throws(() => f.journal().get(row.request.id), { code: "INTEGRITY_FAILED" });
    } finally { await f.close(); }
  });
  it("keeps the owner service interface read-only toward the RPC", async () => {
    const f = await ownerFixture();
    try {
      const row = (await f.service().prepare(true)).operation!;
      const service = new OwnerService(f.config, f.journal(), f.read, { assertNetwork: async () => {}, request: async (method) => { assert.equal(method, "tx"); throw new Error("fixture unavailable"); } });
      await service.dispatch(row.request.id, row.digest); await service.reconcile(row.request.id, baseEncode(randomBytes(32)));
      assert.equal(f.journal().get(row.request.id).state, "unknown");
    } finally { await f.close(); }
  });
});
