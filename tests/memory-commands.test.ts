import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { KeyPair } from "near-api-js";
import { encodePrivateKeyring } from "../packages/memory/src/backup.js";
import { writePrivateFile } from "../packages/memory/src/files.js";
import { MemoryKeyring } from "../packages/memory/src/keyring.js";
import { isObject } from "../packages/protocol/src/memory.js";

const run = promisify(execFile);
describe("owner memory write commands and real process-exit drills", () => {
  it("fails without public configuration or with invalid private input, without falling back or logging content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "persistara-write-cli-"));
    const script = fileURLToPath(new URL("../scripts/memory-write.js", import.meta.url));
    try {
      await assert.rejects(run(process.execPath, [script, "reconcile"], { cwd: directory, env: {}, timeout: 10_000 }), (error: unknown) =>
        isObject(error) && error.code === 2 && String(error.stderr).includes("NOT_CONFIGURED"));
      const rotation = fileURLToPath(new URL("../scripts/owner-rotation.js", import.meta.url));
      await assert.rejects(run(process.execPath, [rotation, "next", "--state-dir", join(directory, "rotation")], { cwd: directory, env: {}, timeout: 10_000 }), (error: unknown) =>
        isObject(error) && error.code === 2 && String(error.stderr).includes("NOT_CONFIGURED"));
      await assert.rejects(run(process.execPath, [rotation, "prepare", "--owner-key", "/never-read-owner-key"], { cwd: directory, env: {}, timeout: 10_000 }), (error: unknown) =>
        isObject(error) && error.code === 1 && String(error.stderr).includes("INVALID_INPUT"));
      const binding = { agentId: "owner.testnet:research", authorityNetwork: "near:testnet" as const, chainId: "testnet", contractId: "authority.testnet", storageNetwork: "0g:16602:turbo" as const };
      const keys = MemoryKeyring.create(); const keyFile = join(directory, "keys", "memory.json"); const inputFile = join(directory, "input", "fact.json");
      await writePrivateFile(keyFile, encodePrivateKeyring(binding, keys));
      const text = "Private fixture text must never enter an error log";
      await writePrivateFile(inputFile, Buffer.from(JSON.stringify({ operationId: "op:one", text, source: { kind: "owner", reference: "fixture:source" }, arbitraryField: "rejected" })));
      const args = [script, "write", "--keyring", keyFile, "--state-dir", join(directory, "runtime"), "--input-file", inputFile];
      const env = { NEAR_AGENT_ID: binding.agentId, NEAR_AUTHORITY_CONTRACT: binding.contractId, NEAR_OWNER_ACCOUNT: "owner.testnet", NEAR_RUNTIME_PUBLIC_KEY: KeyPair.fromRandom("ed25519").getPublicKey().toString(), NEAR_RPC_URL: "https://never-contact.invalid" };
      await assert.rejects(run(process.execPath, args, { cwd: directory, env, timeout: 10_000 }), (error: unknown) =>
        isObject(error) && error.code === 1 && String(error.stderr).includes("INVALID_INPUT") && !String(error.stderr).includes(text) && !String(error.stdout).includes(text));
      await assert.rejects(stat(join(directory, "runtime", "writes.sqlite")), { code: "ENOENT" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("restarts after abrupt upload/checkpoint exits with exactly one observed effect at each fixture boundary", async () => {
    const script = fileURLToPath(new URL("../scripts/memory-write-fixture.js", import.meta.url));
    const result = await run(process.execPath, [script], { env: {}, timeout: 20_000, maxBuffer: 10_000 });
    const report: unknown = JSON.parse(result.stdout);
    assert.deepEqual(report, { evidence: "LOCAL_FIXTURE_ONLY", phase: "verify", status: "committed", version: 1, recordUploads: 1, manifestUploads: 1, checkpointBroadcasts: 1, originalProcessResumed: false });
  });
});
