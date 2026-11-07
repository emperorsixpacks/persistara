import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, it } from "node:test";
import { decryptCommission, encryptCommission, recipientKeys, validateRecipientKeys } from "../packages/commerce/src/encryption.js";
import { signedDigest, validateQuote, verifySigned } from "../packages/commerce/src/protocol.js";
import { CommissionJournal } from "../packages/commerce/src/journal.js";
import { canonical, hash } from "../packages/near/src/protocol.js";
import { commerceFixture, signSpecialist } from "./fixtures/commerce-support.js";
import type { SpecialistQuote } from "../packages/commerce/src/types.js";

async function reserve(f: Awaited<ReturnType<typeof commerceFixture>>) {
  const created = await f.create(), task = f.service().request(created.id), signed = await f.quote(task);
  const quoted = await f.service().importQuote(created.id, signed);
  const funded = await f.service().reserve(created.id, quoted.version, quoted.quoteDigest!);
  assert.equal(funded.state, "funded"); return funded;
}
describe("signed specialist commissioning and exact settlement", () => {
  it("encrypts the immutable brief, verifies quote and delivery, and settles one reviewed artifact", async () => {
    const f = await commerceFixture();
    try {
      const funded = await reserve(f), id = funded.id;
      const task = f.service().request(id);
      const decrypted = await decryptCommission(task.encryptedBrief, f.encryption, { scope: f.scope, commissionId: id, missionId: task.missionId, purpose: "brief" });
      assert.equal(hash(canonical(decrypted)), task.briefDigest); assert.equal(f.data.submissions, 1);
      const signed = await f.delivery(id), delivered = await f.service().importDelivery(id, signed);
      assert.equal(delivered.state, "delivery_ready"); assert.equal(delivered.deliveryVerified, true); assert.equal(f.data.submissions, 1);
      assert.ok(delivered.artifact?.sources[0]?.excerpt.includes("untrusted data"));
      const paid = await f.service().settle(id, delivered.version, delivered.artifactDigest!, delivered.quoteDigest!);
      assert.equal(paid.state, "paid"); assert.equal(paid.reviewed, true); assert.equal(paid.receipt.payoutAttempt, "1"); assert.equal(f.data.submissions, 2);
      assert.equal(f.missions().get(task.missionId).mission.state, "completed");
      assert.equal(f.service().project(f.missions().get(task.missionId).mission).budget.spent, funded.amountYoctoNear);
      await f.service().reconcile(id); assert.equal(f.data.submissions, 2);
      const publicView = JSON.stringify(paid); assert.equal(publicView.includes(f.owner.toString()), false); assert.equal(publicView.includes(f.worker.toString()), false); assert.equal(publicView.includes(f.directory), false);
      assert.equal(publicView.includes('"privateKey"'), false); assert.equal(publicView.includes('"encryptedBrief"'), false);
    } finally { await f.close(); }
  });
  it("recovers lost upload/reservation/acceptance responses across journal restarts without a replacement effect", async () => {
    const f = await commerceFixture();
    try {
      const created = await f.create(), signed = await f.quote(f.service().request(created.id));
      let quoted = await f.service().importQuote(created.id, signed);
      f.data.loseUpload = true; let observed = await f.service().reserve(created.id, quoted.version, quoted.quoteDigest!);
      assert.equal(observed.state, "brief_ready"); assert.equal(f.data.uploads, 1); assert.equal(f.data.submissions, 0);
      f.restart(); f.data.loseReservation = true;
      observed = await f.service().reserve(created.id, observed.version, observed.quoteDigest!); assert.equal(observed.state, "funded");
      assert.equal(f.data.uploads, 1); assert.equal(f.data.submissions, 1);
      f.restart(); f.data.loseUpload = false; const delivery = await f.delivery(created.id); observed = await f.service().importDelivery(created.id, delivery);
      f.data.loseAcceptance = true; observed = await f.service().settle(created.id, observed.version, observed.artifactDigest!, observed.quoteDigest!);
      assert.equal(observed.state, "paid"); f.restart(); await f.service().reconcile(created.id); assert.equal(f.data.submissions, 2);
    } finally { await f.close(); }
  });
  it("keeps a dispatched unavailable upload unknown and never uploads a replacement", async () => {
    const f = await commerceFixture();
    try {
      const created = await f.create(), quoted = await f.service().importQuote(created.id, await f.quote(f.service().request(created.id)));
      f.data.loseUpload = true; f.data.unavailable = true;
      let result = await f.service().reserve(created.id, quoted.version, quoted.quoteDigest!);
      assert.equal(result.state, "uploading_brief"); f.restart(); result = await f.service().reconcile(created.id);
      assert.equal(result.state, "uploading_brief"); assert.equal(f.data.uploads, 1); assert.equal(f.data.submissions, 0);
      await assert.rejects(f.service().reserve(created.id, quoted.version, quoted.quoteDigest!));
      f.data.unavailable = false; result = await f.service().reconcile(created.id); assert.equal(result.state, "brief_ready"); assert.equal(f.data.uploads, 1);
    } finally { await f.close(); }
  });
  it("fences a crash after the reservation marker even if no signer operation can be observed", async () => {
    const f = await commerceFixture();
    try {
      const created = await f.create(), quoted = await f.service().importQuote(created.id, await f.quote(f.service().request(created.id)));
      f.data.noSubmit = true; const observed = await f.service().reserve(created.id, quoted.version, quoted.quoteDigest!); assert.equal(observed.state, "reserving");
      f.restart(); f.data.noSubmit = false; await f.service().reconcile(created.id); assert.equal(f.data.submissions, 1); assert.equal(f.data.job, null);
      await assert.rejects(f.service().reserve(created.id, quoted.version, quoted.quoteDigest!)); assert.equal(f.data.submissions, 1);
    } finally { await f.close(); }
  });
  it("distinguishes confirmed acceptance from a finalized payout and refuses a second acceptance", async () => {
    const f = await commerceFixture();
    try {
      const funded = await reserve(f), delivered = await f.service().importDelivery(funded.id, await f.delivery(funded.id)); f.data.autoPay = false;
      const pending = await f.service().settle(funded.id, delivered.version, delivered.artifactDigest!, delivered.quoteDigest!);
      assert.equal(pending.state, "payout_pending"); assert.equal(f.missions().get(pending.missionId).mission.state, "queued");
      await f.service().settle(funded.id, pending.version, pending.artifactDigest!, pending.quoteDigest!); assert.equal(f.data.submissions, 2);
      f.data.job!.status = "paid"; const paid = await f.service().reconcile(funded.id); assert.equal(paid.state, "paid"); assert.equal(f.missions().get(paid.missionId).mission.state, "completed");
    } finally { await f.close(); }
  });
  it("requires exact price/artifact review and blocks local mission approval or execution as a payment bypass", async () => {
    const f = await commerceFixture();
    try {
      const created = await f.create(), m = f.missions().get(created.missionId).mission;
      assert.throws(() => f.missions().claim(m.id, m.version, m.authority, "00000000-0000-4000-8000-000000000000"));
      assert.throws(() => f.missions().approve(m.id, m.version, "0".repeat(64)));
      const quoted = await f.service().importQuote(created.id, await f.quote(f.service().request(created.id)));
      await assert.rejects(f.service().reserve(created.id, quoted.version, "0".repeat(64))); assert.equal(f.data.uploads, 0);
      const funded = await f.service().reserve(created.id, quoted.version, quoted.quoteDigest!), delivery = await f.service().importDelivery(created.id, await f.delivery(created.id));
      await assert.rejects(f.service().settle(created.id, delivery.version, "0".repeat(64), delivery.quoteDigest!)); assert.equal(f.data.submissions, 1);
    } finally { await f.close(); }
  });
  it("rejects wrong key, nonce, recipient, sequence, scope, amount and altered source/result bindings", async () => {
    const f = await commerceFixture();
    try {
      const created = await f.create(), task = f.service().request(created.id), original = await f.quote(task);
      for (const change of [
        { ...original, nonce: randomBytes(32).toString("base64url") }, { ...original, recipient: "another-app" },
        { ...original, proof: { ...original.proof, publicKey: f.runtime.getPublicKey().toString() } },
      ]) await assert.rejects(f.service().importQuote(created.id, change));
      for (const patch of [{ amountYoctoNear: "30000000000000000000000" }, { asset: "ETH" }, { network: "near:mainnet" }, { sequence: 2 }, { missionId: "mission:00000000-0000-4000-8000-000000000000" }, { taskDigest: "0".repeat(64) }, { scope: { ...task.scope, contractId: "other.testnet" } }]) {
        const forged = await signSpecialist(f.worker, f.workerAccount, "quote", { ...original.payload, ...patch } as SpecialistQuote, f.scope, task.quoteNonce);
        await assert.rejects(f.service().importQuote(created.id, forged));
      }
      const expired = { ...original.payload, expiresAtNs: original.payload.issuedAtNs }; assert.throws(() => validateQuote(expired, task, f.view.timestampNs));
      assert.equal(f.data.submissions, 0); assert.equal(f.data.uploads, 0);
    } finally { await f.close(); }
  });
  it("fails closed on revoked worker, changed policy/owner/runtime authority and expired owner session before effects", async () => {
    const f = await commerceFixture();
    try {
      const created = await f.create(), signed = await f.quote(f.service().request(created.id));
      f.data.workerKeyValid = false; await assert.rejects(f.service().importQuote(created.id, signed)); f.data.workerKeyValid = true;
      const quoted = await f.service().importQuote(created.id, signed);
      f.view.paused = true; await assert.rejects(f.service().reserve(created.id, quoted.version, quoted.quoteDigest!)); f.view.paused = false;
      const workers = f.view.policy!.approvedWorkers; f.view.policy!.approvedWorkers = []; await assert.rejects(f.service().reserve(created.id, quoted.version, quoted.quoteDigest!)); f.view.policy!.approvedWorkers = workers;
      await assert.rejects(f.service().reserve(created.id, quoted.version, quoted.quoteDigest!, () => { throw Error("Fixture expired session"); }));
      assert.equal(f.data.uploads, 0); assert.equal(f.data.submissions, 0);
    } finally { await f.close(); }
  });
  it("refuses decryption/digest/source substitution and never authorizes settlement of invalid content", async () => {
    const f = await commerceFixture();
    try {
      const funded = await reserve(f), malformed = await f.delivery(funded.id, (a) => { a.sources[0]!.url = "https://evil.invalid/"; });
      await assert.rejects(f.service().importDelivery(funded.id, malformed)); assert.equal(f.journal().get(funded.id).artifact, null); assert.equal(f.data.submissions, 1);
      const good = await f.delivery(funded.id), altered = structuredClone(good); altered.payload.result.ciphertextSha256 = "0".repeat(64);
      await assert.rejects(f.service().importDelivery(funded.id, altered));
    } finally { await f.close(); }
  });
  it("refuses missing/replaced recipient and signer journals, unsafe permissions, scope rebinding and changed immutable requests", async () => {
    const f = await commerceFixture();
    try {
      const funded = await reserve(f), recipient = await readFile(f.keyFile); await rm(f.keyFile);
      const delivery = await f.delivery(funded.id); await assert.rejects(f.service().importDelivery(funded.id, delivery));
      await writeFile(f.keyFile, recipient, { mode: 0o600 }); const ready = await f.service().importDelivery(funded.id, delivery);
      f.data.signerIdentity = "00000000-0000-4000-8000-000000000000"; await assert.rejects(f.service().settle(funded.id, ready.version, ready.artifactDigest!, ready.quoteDigest!)); assert.equal(f.data.submissions, 1);
      assert.throws(() => new CommissionJournal(join(f.directory, "commissions.sqlite"), { ...f.scope, agentId: "owner.testnet:other" }));
      const r = f.journal().get(funded.id); assert.throws(() => f.journal().update(r.id, r.version, n => { n.request!.amount = "1"; }));
      await chmod(join(f.directory, "commissions.sqlite"), 0o644); assert.throws(() => new CommissionJournal(join(f.directory, "commissions.sqlite"), f.scope)); await chmod(join(f.directory, "commissions.sqlite"), 0o600);
    } finally { await f.close(); }
  });
  it("retains externally disputed/refunded and failed-payout states without triggering a replacement transfer", async () => {
    const f = await commerceFixture();
    try {
      const funded = await reserve(f); f.data.job!.status = "disputed"; assert.equal((await f.service().reconcile(funded.id)).state, "disputed");
      f.data.job!.status = "refunded"; assert.equal((await f.service().reconcile(funded.id)).state, "refunded"); assert.equal(f.data.submissions, 1);
      assert.throws(() => f.service().cancel(funded.id, f.journal().get(funded.id).version));
    } finally { await f.close(); }
  });
  it("honors an existing funded obligation after the worker is removed from new-job policy", async () => {
    const f = await commerceFixture();
    try {
      const funded = await reserve(f); f.view.policy!.approvedWorkers = []; f.view.generation = "4";
      const delivered = await f.service().importDelivery(funded.id, await f.delivery(funded.id));
      const paid = await f.service().settle(funded.id, delivered.version, delivered.artifactDigest!, delivered.quoteDigest!);
      assert.equal(paid.state, "paid"); assert.equal(f.data.submissions, 2);
    } finally { await f.close(); }
  });
});
describe("standard JWE recipient encryption", () => {
  it("authenticates network/contract/mission/purpose, wrong recipients, ciphertext and algorithm headers without plaintext fallback", async () => {
    const f = await commerceFixture();
    try {
      const keys = await recipientKeys(), other = await recipientKeys();
      const context = { scope: f.scope, commissionId: "commission:00000000-0000-4000-8000-000000000000", missionId: "mission:00000000-0000-4000-8000-000000000000", purpose: "brief" as const };
      const encrypted = await encryptCommission({ private: "source brief" }, keys.publicKey, context);
      assert.deepEqual(await decryptCommission(encrypted, keys, context), { private: "source brief" });
      await assert.rejects(decryptCommission(encrypted, other, context)); await assert.rejects(decryptCommission(encrypted, keys, { ...context, purpose: "artifact" }));
      await assert.rejects(decryptCommission(encrypted, keys, { ...context, scope: { ...f.scope, chainId: "other" } }));
      const parts = encrypted.split("."); parts[3] = (parts[3]!.startsWith("A") ? "B" : "A") + parts[3]!.slice(1); await assert.rejects(decryptCommission(parts.join("."), keys, context));
      await assert.rejects(decryptCommission('{"plaintext":"fallback"}', keys, context));
      assert.equal((await validateRecipientKeys(keys)).publicKey.n, keys.publicKey.n);
    } finally { await f.close(); }
  });
});
