import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const script = join(process.cwd(), "dist", "scripts", "wallet.js");
async function run(args: string[], dir: string, env: Record<string, string> = {}) {
  try { const r = await promisify(execFile)(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", PERSISTARA_SIGNER_DIR: dir, ...env }, cwd: tmpdir(), timeout: 30_000 }); return { code: 0, out: r.stdout, err: r.stderr }; }
  catch (error) { const e = error as { code: number; stdout: string; stderr: string }; return { code: e.code, out: e.stdout, err: e.stderr }; }
}
describe("persistara wallet command (real script, no network, no key)", () => {
  it("shows usage, lists an empty store and refuses unsafe use with readable messages, creating nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persistara-walletscript-")); await chmod(dir, 0o700); const signer = join(dir, "signer");
    try {
      const help = await run([], signer); assert.equal(help.code, 0); assert.ok(help.out.includes("add [--account") && help.out.includes("PERSISTARA_SIGNER_DIR"));
      const empty = await run(["list"], signer); assert.equal(empty.code, 0); assert.ok(empty.out.includes("No keys stored"));
      const noTty = await run(["add"], signer, { NEAR_OWNER_ACCOUNT: "owner.testnet" }); assert.equal(noTty.code, 1); assert.ok(noTty.err.includes("INVALID_INPUT: Run this in an interactive terminal"));
      const noAccount = await run(["add", "--key-file", join(dir, "k")], signer); assert.ok(noAccount.err.includes("Say which account"));
      const bad = await run(["add", "--bogus"], signer); assert.ok(bad.err.includes("Unknown option"));
      const missing = await run(["remove", "nobody.testnet"], signer); assert.ok(missing.out.includes("No stored key"));
      assert.deepEqual(await readdir(dir), [], "the signer directory was never even created");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
