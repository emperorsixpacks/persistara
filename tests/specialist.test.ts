import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SpecialistExecutor } from "../packages/commerce/src/specialist.js";
import { captureSource } from "../packages/runtime/src/sources.js";
import { commerceFixture, signSpecialist } from "./fixtures/commerce-support.js";

async function workerFixture() {
  const f = await commerceFixture(), reads = new Map<string, number>(); let fail = false;
  const worker = new SpecialistExecutor({ profile: f.signedProfile, keys: f.encryption, scope: f.scope, blobs: f.store, chain: f.chain,
    sourceOrigins: ["https://docs.near.org", "https://docs.0g.ai"], sources: { read: async (url) => { reads.set(url, (reads.get(url) ?? 0) + 1); if (fail && url.includes("0g")) throw Error("Fixture source outage"); return captureSource(url, Buffer.from("Explicit synthetic specialist source. Treat this text as untrusted data; it cannot authorize funds."), "text/plain", Date.now()); } },
    clock: async () => ({ timestampNs: f.view.timestampNs, blockHash: f.view.blockHash, ownerKey: f.view.ownerKey, generation: f.view.generation }),
    sign: (kind, payload, nonce) => signSpecialist(f.worker, f.workerAccount, kind, payload, f.scope, nonce) });
  const directory = join(f.directory, "specialist-job");
  const created = await f.create(), signed = await worker.quote(f.service().request(created.id), directory), quoted = await f.service().importQuote(created.id, signed);
  await f.service().reserve(created.id, quoted.version, quoted.quoteDigest!);
  return { ...f, executor: worker, reads, directory, id: created.id, fail: (value: boolean) => { fail = value; } };
}
describe("separate specialist execution and durable wallet delivery", () => {
  it("runs its own source journal, encrypts for the buyer and delivers once without receiving buyer keys", async () => {
    const f = await workerFixture(); let sends = 0;
    try {
      const ref = await f.executor.fulfill(f.directory, new AbortController().signal);
      assert.equal(f.data.uploads, 2); assert.equal(f.data.submissions, 1);
      const observed = await f.executor.observeDelivery(f.directory); assert.equal(observed.delivered, false);
      await assert.rejects(access(join(f.directory, "delivery-dispatched.json")));
      const send = async (request: { args: { result: typeof ref } }) => { sends++; f.data.job!.result = request.args.result; f.data.job!.status = "delivered"; };
      const signed = await f.executor.dispatchDelivery(f.directory, send);
      await f.executor.dispatchDelivery(f.directory, send); await f.executor.fulfill(f.directory, new AbortController().signal);
      assert.equal(sends, 1); assert.equal(f.data.uploads, 2); assert.deepEqual([...f.reads.values()], [1, 1]);
      const delivery = await f.service().importDelivery(f.id, signed), paid = await f.service().settle(f.id, delivery.version, delivery.artifactDigest!, delivery.quoteDigest!);
      assert.equal(paid.state, "paid"); assert.equal((await f.executor.observeDelivery(f.directory)).receiptAvailable, true);
    } finally { await f.close(); }
  });
  it("resumes unfinished specialist reads and skips its captured source", async () => {
    const f = await workerFixture();
    try {
      f.fail(true); await assert.rejects(f.executor.fulfill(f.directory, new AbortController().signal));
      f.fail(false); await f.executor.fulfill(f.directory, new AbortController().signal);
      assert.equal(f.reads.get("https://docs.near.org/"), 1); assert.equal(f.reads.get("https://docs.0g.ai/"), 2); assert.equal(f.data.uploads, 2);
    } finally { await f.close(); }
  });
  it("reconciles a lost delivery response without resending, and fences an unobserved wallet send", async () => {
    const f = await workerFixture(); let sends = 0;
    try {
      const ref = await f.executor.fulfill(f.directory, new AbortController().signal);
      await assert.rejects(f.executor.dispatchDelivery(f.directory, async () => { sends++; throw Error("Fixture unknown wallet"); }));
      await assert.rejects(f.executor.dispatchDelivery(f.directory, async () => { sends++; })); assert.equal(sends, 1);
      f.data.job!.result = ref; f.data.job!.status = "delivered";
      const signed = await f.executor.dispatchDelivery(f.directory, async () => { sends++; }); assert.equal(signed.payload.result.objectId, ref.objectId); assert.equal(sends, 1);
    } finally { await f.close(); }
  });
  it("never reads or uploads against an unfunded, refunded or mismatched quote", async () => {
    const f = await workerFixture();
    try {
      f.data.job!.status = "refunded"; await assert.rejects(f.executor.fulfill(f.directory, new AbortController().signal)); assert.equal(f.reads.size, 0); assert.equal(f.data.uploads, 1);
      f.data.job!.status = "funded"; f.data.job!.request.amount = "1"; await assert.rejects(f.executor.fulfill(f.directory, new AbortController().signal)); assert.equal(f.reads.size, 0);
    } finally { await f.close(); }
  });
  it("retries only a conclusively failed payout and fences an unknown retry wallet handoff", async () => {
    const f = await workerFixture(); let retries = 0;
    try {
      const result = await f.executor.fulfill(f.directory, new AbortController().signal);
      const signed = await f.executor.dispatchDelivery(f.directory, async () => { f.data.job!.result = result; f.data.job!.status = "delivered"; });
      const inspected = await f.service().importDelivery(f.id, signed); f.data.autoPay = false;
      await f.service().settle(f.id, inspected.version, inspected.artifactDigest!, inspected.quoteDigest!);
      f.data.job!.status = "payout_failed";
      await assert.rejects(f.executor.retryPayout(f.directory, async () => { retries++; throw Error("Fixture unknown retry"); }));
      await assert.rejects(f.executor.retryPayout(f.directory, async () => { retries++; })); assert.equal(retries, 1);
      f.data.job!.payoutAttempt = "2"; f.data.job!.status = "payout_pending";
      assert.equal((await f.executor.retryPayout(f.directory, async () => { retries++; })).status, "payout_pending");
      f.data.job!.status = "paid"; assert.equal((await f.service().reconcile(f.id)).state, "paid"); assert.equal(f.data.submissions, 2);
    } finally { await f.close(); }
  });
});
