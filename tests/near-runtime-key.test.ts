import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { KeyPair } from "near-api-js";

const script = join(process.cwd(), "dist", "scripts", "near-runtime-key.js");
const run = (file: string) => promisify(execFile)(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", NEAR_RUNTIME_KEY_FILE: file }, cwd: tmpdir() });

describe("near:runtime-key", () => {
  it("creates a private runtime key file once, prints only the public key and never replaces or leaks the secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persistara-rtkey-")); await chmod(dir, 0o700);
    try {
      const file = join(dir, "rt.key");
      const first = await run(file), a = JSON.parse(first.stdout) as { status: string; publicKey: string };
      const secret = (await readFile(file, "utf8")).trim();
      assert.equal(a.status, "created"); assert.equal(((await stat(file)).mode & 0o777).toString(8), "600");
      assert.equal(KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]).getPublicKey().toString(), a.publicKey);
      assert.ok(!first.stdout.includes(secret) && !first.stderr.includes(secret), "the secret is never printed");
      const second = await run(file), b = JSON.parse(second.stdout) as { status: string; publicKey: string };
      assert.equal(b.status, "already-exists-unchanged"); assert.equal(b.publicKey, a.publicKey); assert.equal((await readFile(file, "utf8")).trim(), secret);
      const bad = join(dir, "bad.key"); await writeFile(bad, "not a key\n", { mode: 0o600 });
      await assert.rejects(run(bad), (e: { stderr: string }) => e.stderr.includes("INVALID_INPUT")); assert.equal(await readFile(bad, "utf8"), "not a key\n");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
