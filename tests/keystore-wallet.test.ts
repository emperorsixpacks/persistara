import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { KeyPair } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { saveKeystoreEntry } from "../packages/owner/src/keystore.js";
import type { OwnerChallenge } from "../packages/owner/src/types.js";
import { KeystoreWallet } from "../packages/terminal/src/keystore-wallet.js";
import type { TerminalWallet } from "../packages/terminal/src/wallet.js";

/** Real signer child process, throwaway generated keys, cheap scrypt. Nothing touches the network. */
const CHEAP = { N: 1 << 14, r: 8, p: 1 }, PASS = "correct horse battery staple";
async function setup(account = "owner.testnet") {
  const dir = await mkdtemp(join(tmpdir(), "persistara-kswallet-")); await chmod(dir, 0o700);
  const pair = KeyPair.fromRandom("ed25519"), pub = pair.getPublicKey().toString();
  await saveKeystoreEntry(account, pair.toString(), PASS, dir, CHEAP);
  const challenge = (over: Partial<OwnerChallenge> = {}): OwnerChallenge => ({ id: "challenge-1", message: "Persistara CLI sign-in. This is not a transaction.", recipient: "persistara-cli:v1:testnet:authority.testnet:owner.testnet:research", nonce: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 60_000, signerId: account, publicKey: pub, network: "testnet", ...over });
  return { dir, pub, secret: pair.toString(), challenge, done: () => rm(dir, { recursive: true, force: true }) };
}
const provider = (account: string, key: string) => ({ viewAccessKey: async () => ({ nonce: 0n, permission: "FullAccess" }), account, key }) as unknown as Parameters<typeof verifyMessage>[0]["provider"];

describe("key store wallet (real signer process)", () => {
  it("signs a login challenge that the project's own NEP-413 verifier accepts, and returns no secret", async () => {
    const t = await setup();
    try {
      const wallet = new KeystoreWallet("owner.testnet", t.dir, () => PASS), challenge = t.challenge(), proof = await wallet.signMessage(challenge);
      assert.deepEqual({ challengeId: proof.challengeId, accountId: proof.accountId, publicKey: proof.publicKey }, { challengeId: "challenge-1", accountId: "owner.testnet", publicKey: t.pub });
      assert.ok(!JSON.stringify(proof).includes(t.secret.slice(8)), "the secret is never returned");
      await verifyMessage({ signerAccountId: "owner.testnet", signerPublicKey: t.pub, signature: Buffer.from(proof.signature, "base64"), payload: { message: challenge.message, recipient: challenge.recipient, nonce: Buffer.from(challenge.nonce, "base64url") }, provider: provider("owner.testnet", t.pub) });
      await assert.rejects(verifyMessage({ signerAccountId: "owner.testnet", signerPublicKey: t.pub, signature: Buffer.from(proof.signature, "base64"), payload: { message: "a different message", recipient: challenge.recipient, nonce: Buffer.from(challenge.nonce, "base64url") }, provider: provider("owner.testnet", t.pub) }), "the signature is bound to the exact message");
    } finally { await t.done(); }
  });
  it("refuses a wrong passphrase, a locked store, another account, a different registered key and a missing entry", async () => {
    const t = await setup();
    try {
      await assert.rejects(new KeystoreWallet("owner.testnet", t.dir, () => "wrong passphrase value").signMessage(t.challenge()), { code: "AUTHORIZATION_FAILED" });
      await assert.rejects(new KeystoreWallet("owner.testnet", t.dir, () => null).signMessage(t.challenge()), /locked/);
      await assert.rejects(new KeystoreWallet("owner.testnet", t.dir, () => PASS).signMessage(t.challenge({ signerId: "someone.testnet" })), { code: "AUTHORIZATION_FAILED" });
      await assert.rejects(new KeystoreWallet("owner.testnet", t.dir, () => PASS).signMessage(t.challenge({ publicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString() })), /different key/);
      await assert.rejects(new KeystoreWallet("nobody.testnet", t.dir, () => PASS).signMessage(t.challenge({ signerId: "nobody.testnet" })), { code: "NOT_CONFIGURED" });
    } finally { await t.done(); }
  });
  it("delegates owner transactions to a fallback wallet, or refuses clearly; it never signs them itself", async () => {
    const t = await setup(); const request = { id: "r" } as never;
    try {
      await assert.rejects(new KeystoreWallet("owner.testnet", t.dir, () => PASS).send(request), { code: "UNSUPPORTED" });
      const fallback: TerminalWallet = { signMessage: async () => assert.fail("not used"), send: async () => "HASH123" };
      assert.equal(await new KeystoreWallet("owner.testnet", t.dir, () => PASS, fallback).send(request), "HASH123");
    } finally { await t.done(); }
  });
});
