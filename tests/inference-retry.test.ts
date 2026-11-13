import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retryCollateral } from "../packages/inference/src/retry.js";

const collateral = () => Object.assign(new Error("x"), { failure: { code: "quote.collateral_unavailable" } });
describe("retrying the free attestation collateral fetch", () => {
  it("retries only the transient collateral failure, with growing waits, then succeeds", async () => {
    let calls = 0; const waits: number[] = [];
    const value = await retryCollateral(async () => { if (++calls < 3) throw collateral(); return "ok"; }, async (ms) => { waits.push(ms); });
    assert.equal(value, "ok"); assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
  });
  it("gives up after the bounded attempts and rethrows the original error", async () => {
    let calls = 0;
    await assert.rejects(retryCollateral(async () => { calls++; throw collateral(); }, async () => {}), (e: unknown) => (e as { failure: { code: string } }).failure.code === "quote.collateral_unavailable");
    assert.equal(calls, 4);
  });
  it("never retries a real verification failure or any other error", async () => {
    for (const error of [Object.assign(new Error("bad"), { failure: { code: "quote.verification_failed" } }), new Error("boom"), null]) {
      let calls = 0;
      await assert.rejects(retryCollateral(async () => { calls++; throw error; }, async () => {}));
      assert.equal(calls, 1);
    }
  });
});
