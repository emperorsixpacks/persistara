import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

describe("pnpm conversation:demo (synthetic) keeps showing the documented behavior", () => {
  it("prints the labeled synthetic walkthrough with the expected safety outcomes", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [join(process.cwd(), "dist", "scripts", "conversation-demo.js")], { env: { PATH: process.env.PATH ?? "" }, timeout: 60_000 });
    const result = JSON.parse(stdout) as Record<string, Record<string, unknown>> & { fixture: boolean };
    assert.equal(result.fixture, true);
    assert.deepEqual(result.step1_lookup, { state: "completed", reply: "SYNTHETIC-FIXTURE-NOT-A-MODEL-REPLY: you have one saved mission.", modelRequests: 2, readOnlyToolsCalled: ["mission_list"], toolResultWasMarkedUntrusted: true });
    assert.deepEqual(result.step2_lostOutcome, { state: "unknown", unknownAttempt: true, costRecordedAsZero: false });
    assert.deepEqual(result.step3_sessionFencedAndNotResent, { newMessageRefused: true, modelRequestsSoFar: 3 });
    assert.deepEqual(result.step4_ownerResolvedThenContinues, { state: "completed", attemptStillUnknownInJournal: true, modelRequests: 4 });
    assert.deepEqual(result.step5_encryptedBackupRoundTrip, { sessions: 1, bundleContainsPlaintext: false, identicalAfterRestore: true });
  });
});
