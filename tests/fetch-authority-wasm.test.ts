import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = join(process.cwd(), "dist", "scripts", "fetch-authority-wasm.js");
const run = async (args: string[], out: string) => { try { await exec(process.execPath, [script, ...args, "--out", out], { env: { PATH: process.env.PATH ?? "" } }); return { code: 0, text: "" }; } catch (error) { const e = error as { code: number; stderr: string }; return { code: e.code, text: e.stderr }; } };

describe("fetch-authority-wasm input checks (no network is reached)", () => {
  it("refuses to run without an independently supplied expected hash, and rejects non-https RPC and bad arguments, writing nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persistara-wasm-")), out = join(dir, "x.wasm");
    try {
      const noHash = await run(["--contract", "authority.example.testnet"], out); assert.equal(noHash.code, 1); assert.ok(noHash.text.includes("INVALID_INPUT"));
      const badHash = await run(["--expected-hash", "not base58!", "--contract", "authority.example.testnet"], out); assert.ok(badHash.text.includes("INVALID_INPUT"));
      const http = await run(["--expected-hash", "GCPU1ejMZ6CPDLyT4k9GorYuXtAv5sn49jXWVzDMsKYQ", "--contract", "authority.example.testnet", "--rpc", "http://rpc.example.org"], out); assert.ok(http.text.includes("INVALID_INPUT"));
      const unknown = await run(["--expected-hash", "GCPU1ejMZ6CPDLyT4k9GorYuXtAv5sn49jXWVzDMsKYQ", "--nope", "x"], out); assert.ok(unknown.text.includes("INVALID_INPUT"));
      assert.deepEqual(await readdir(dir), [], "no file was written by any refused run");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
