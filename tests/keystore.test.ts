import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { KeyPair } from "near-api-js";
import { decryptKeystoreEntry, describeKeystoreEntry, encryptKeystoreEntry, keystorePath, listKeystore, readKeystoreEntry, saveKeystoreEntry } from "../packages/owner/src/keystore.js";

/** Throwaway generated keys and a cheap scrypt cost for speed; production uses the default cost. */
const CHEAP = { N: 1 << 14, r: 8, p: 1 }, PASS = "correct horse battery staple";
const pair = () => { const k = KeyPair.fromRandom("ed25519"); return { secret: k.toString(), pub: k.getPublicKey().toString() }; };
async function dir() { const d = await mkdtemp(join(tmpdir(), "persistara-keystore-")); await chmod(d, 0o700); return d; }

describe("encrypted owner key store", () => {
  it("round-trips, never stores the secret or passphrase in the file, and creates it private and once", async () => {
    const d = await dir(), k = pair();
    try {
      const saved = await saveKeystoreEntry("owner.testnet", k.secret, PASS, d, CHEAP);
      const text = await readFile(saved.path, "utf8");
      assert.ok(!text.includes(k.secret) && !text.includes(k.secret.slice(8)) && !text.includes(PASS), "no plaintext secret or passphrase");
      assert.equal(((await stat(saved.path)).mode & 0o777).toString(8), "600"); assert.equal(saved.publicKey, k.pub);
      const opened = await decryptKeystoreEntry(Buffer.from(text), PASS);
      assert.deepEqual(opened, { account: "owner.testnet", publicKey: k.pub, secret: k.secret });
      await assert.rejects(saveKeystoreEntry("owner.testnet", pair().secret, PASS, d, CHEAP), "an existing entry is never replaced");
      assert.equal((await decryptKeystoreEntry((await readKeystoreEntry("owner.testnet", d))!, PASS)).secret, k.secret, "the original survived");
      assert.deepEqual(await listKeystore(d), [{ account: "owner.testnet", publicKey: k.pub }]); assert.equal(await readKeystoreEntry("nobody.testnet", d), null);
    } finally { await rm(d, { recursive: true, force: true }); }
  });
  it("rejects a wrong passphrase and any edit to the authenticated fields, with one generic error", async () => {
    const k = pair(), good = await encryptKeystoreEntry("owner.testnet", k.secret, PASS, CHEAP), file = JSON.parse(good.toString()) as Record<string, any>;
    const denied = { code: "AUTHORIZATION_FAILED" };
    await assert.rejects(decryptKeystoreEntry(good, "another passphrase here"), denied);
    const edit = (change: (v: Record<string, any>) => void) => { const copy = structuredClone(file); change(copy); return Buffer.from(JSON.stringify(copy)); };
    await assert.rejects(decryptKeystoreEntry(edit((v) => { v.account = "someone.testnet"; }), PASS), denied);
    await assert.rejects(decryptKeystoreEntry(edit((v) => { v.publicKey = pair().pub; }), PASS), denied);
    const flipped = Buffer.from(file.ciphertext, "base64url"); flipped[3] = flipped[3]! ^ 1;
    await assert.rejects(decryptKeystoreEntry(edit((v) => { v.ciphertext = flipped.toString("base64url"); }), PASS), denied);
    await assert.rejects(decryptKeystoreEntry(edit((v) => { v.kdf.salt = Buffer.alloc(16, 1).toString("base64url"); }), PASS), denied);
  });
  it("refuses weak input and unsupported or dangerous file settings", async () => {
    const k = pair();
    await assert.rejects(encryptKeystoreEntry("owner.testnet", k.secret, "short", CHEAP), /at least 12/);
    await assert.rejects(encryptKeystoreEntry("owner.testnet", "not-a-key", PASS, CHEAP), /ed25519/);
    await assert.rejects(encryptKeystoreEntry("../evil", k.secret, PASS, CHEAP), /Invalid account/);
    const file = JSON.parse((await encryptKeystoreEntry("owner.testnet", k.secret, PASS, CHEAP)).toString()) as Record<string, any>;
    const variant = (change: (v: Record<string, any>) => void) => { const c = structuredClone(file); change(c); return Buffer.from(JSON.stringify(c)); };
    for (const [name, mutate] of [["tiny N", (v: any) => { v.kdf.N = 1 << 10; }], ["huge N", (v: any) => { v.kdf.N = 1 << 24; }], ["non power of two", (v: any) => { v.kdf.N = 20000; }], ["bad p", (v: any) => { v.kdf.p = 99; }], ["other cipher", (v: any) => { v.cipher.name = "aes-128-cbc"; }], ["other format", (v: any) => { v.format = "x"; }]] as const)
      assert.throws(() => describeKeystoreEntry(variant(mutate)), { code: "INVALID_INPUT" }, name);
    assert.throws(() => describeKeystoreEntry(Buffer.from("garbage")), { code: "INVALID_INPUT" });
  });
  it("refuses a key file that other users can read", async () => {
    const d = await dir(), k = pair();
    try { const saved = await saveKeystoreEntry("owner.testnet", k.secret, PASS, d, CHEAP); await chmod(saved.path, 0o644); await assert.rejects(readKeystoreEntry("owner.testnet", d)); await writeFile(join(d, "x"), ""); assert.equal(keystorePath("a.testnet", d), join(d, "a.testnet.keystore.json")); }
    finally { await rm(d, { recursive: true, force: true }); }
  });
});
