import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { KeyPair, SignedTransaction, baseEncode, encodeTransaction } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { ProviderError } from "../packages/protocol/src/providers.js";
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
function pauseRequest(ownerKey: string) {
  return { schemaVersion: 1, id: "wallet:00000000-0000-4000-8000-000000000000", kind: "OWNER_PAUSE_REQUEST", network: { kind: "testnet", chainId: "testnet" }, agentId: "research.owner.testnet", signerId: "owner.testnet", ownerPublicKey: ownerKey,
    receiverId: "authority.testnet", expectedGeneration: "1", minimumNonce: 0, paused: true,
    actions: [{ type: "FunctionCall", params: { methodName: "set_paused", args: { agent_id: "research.owner.testnet", paused: true }, gas: "100000000000000", deposit: "0" } }] } as unknown as Parameters<KeystoreWallet["send"]>[0];
}
/** A local JSON-RPC stand-in: serves the owner's full-access key at nonce 40 and records every broadcast. */
async function fakeRpc(ownerKey: string) {
  const broadcasts: string[] = []; const state = { failBroadcast: false };
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const call = JSON.parse(body) as { id: unknown; method: string; params: unknown };
      const ok = (result: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result })); };
      if (call.method === "query") return ok({ nonce: 40, block_hash: baseEncode(randomBytes(32)), block_height: 1, permission: "FullAccess", public_key: ownerKey });
      if (call.method === "send_tx") { broadcasts.push((call.params as { signed_tx_base64: string }).signed_tx_base64); if (state.failBroadcast) { res.statusCode = 500; res.end("{}"); return; } return ok("hash"); }
      res.statusCode = 400; res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, broadcasts, set failBroadcast(v: boolean) { state.failBroadcast = v; }, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
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
  it("without an RPC URL or a passphrase it delegates owner transactions to a fallback wallet, or refuses clearly", async () => {
    const t = await setup(); const request = { id: "r" } as never;
    try {
      await assert.rejects(new KeystoreWallet("owner.testnet", t.dir, () => PASS).send(request), { code: "AUTHORIZATION_FAILED" });
      const fallback: TerminalWallet = { signMessage: async () => assert.fail("not used"), send: async () => "HASH123" };
      assert.equal(await new KeystoreWallet("owner.testnet", t.dir, () => PASS, fallback).send(request), "HASH123");
      assert.equal(await new KeystoreWallet("owner.testnet", t.dir, () => null, fallback, undefined, "http://127.0.0.1:1").send(request), "HASH123");
    } finally { await t.done(); }
  });
  it("signs and broadcasts the owner pause transaction in the signer process: exact action, owner key, one broadcast, hash returned", async () => {
    const t = await setup(); const rpc = await fakeRpc(t.pub);
    try {
      const request = pauseRequest(t.pub);
      const hash = await new KeystoreWallet("owner.testnet", t.dir, () => PASS, null, undefined, rpc.url).send(request);
      assert.equal(rpc.broadcasts.length, 1, "exactly one broadcast");
      const decoded = SignedTransaction.decode(Buffer.from(rpc.broadcasts[0]!, "base64"));
      assert.equal(decoded.transaction.signerId, "owner.testnet"); assert.equal(decoded.transaction.receiverId, "authority.testnet");
      assert.equal(decoded.transaction.publicKey.toString(), t.pub); assert.equal(decoded.transaction.nonce, 41n);
      const call = decoded.transaction.actions[0]!.functionCall!;
      assert.equal(call.methodName, "set_paused"); assert.equal(call.deposit, 0n); assert.equal(call.gas, 100_000_000_000_000n);
      assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), { agent_id: "research.owner.testnet", paused: true });
      assert.equal(hash, baseEncode(createHash("sha256").update(encodeTransaction(decoded.transaction)).digest()));
    } finally { await rpc.close(); await t.done(); }
  });
  it("pins the contract and agent to the workspace, treats worker-reported failures as definite and only silence as unknown", async () => {
    const t = await setup(); const rpc = await fakeRpc(t.pub);
    try {
      const scoped = new KeystoreWallet("owner.testnet", t.dir, () => PASS, null, undefined, rpc.url, { contractId: "authority.testnet", agentId: "research.owner.testnet" });
      await assert.rejects(new KeystoreWallet("owner.testnet", t.dir, () => PASS, null, undefined, rpc.url, { contractId: "other-authority.testnet", agentId: "research.owner.testnet" }).send(pauseRequest(t.pub)), { code: "INVALID_INPUT" });
      await assert.rejects(new KeystoreWallet("owner.testnet", t.dir, () => PASS, null, undefined, rpc.url, { contractId: "authority.testnet", agentId: "other.owner.testnet" }).send(pauseRequest(t.pub)), { code: "INVALID_INPUT" });
      const tampered = pauseRequest(t.pub); (tampered.actions[0] as { params: { args: { agent_id: string } } }).params.args.agent_id = "victim.owner.testnet";
      await assert.rejects(scoped.send(tampered), { code: "INVALID_INPUT" });
      assert.equal(rpc.broadcasts.length, 0);
      assert.match(await scoped.send(pauseRequest(t.pub)), /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
      const failing = (code: string) => new KeystoreWallet("owner.testnet", t.dir, () => PASS, null, async () => { throw new ProviderError(code as never, "x"); }, rpc.url);
      await assert.rejects(failing("UPSTREAM_ERROR").send(pauseRequest(t.pub)), { code: "UPSTREAM_ERROR" });
      for (const code of ["OUTCOME_UNKNOWN", "TIMEOUT", "ABORTED"]) await assert.rejects(failing(code).send(pauseRequest(t.pub)), { code: "OUTCOME_UNKNOWN" });
    } finally { await rpc.close(); await t.done(); }
  });
  it("refuses before signing anything when the request, key or passphrase is wrong, and reports a lost broadcast reply as a hash to reconcile", async () => {
    const t = await setup(); const rpc = await fakeRpc(t.pub);
    try {
      const wallet = (pass = PASS, account = "owner.testnet") => new KeystoreWallet(account, t.dir, () => pass, null, undefined, rpc.url);
      await assert.rejects(wallet().send({ ...pauseRequest(t.pub), actions: [{ type: "FunctionCall", params: { methodName: "withdraw_funds", args: {}, gas: "100000000000000", deposit: "0" } }] } as never), { code: "INVALID_INPUT" });
      await assert.rejects(wallet().send({ ...pauseRequest(t.pub), signerId: "other.testnet" }), { code: "INVALID_INPUT" });
      await assert.rejects(wallet().send({ ...pauseRequest(KeyPair.fromRandom("ed25519").getPublicKey().toString()) }), { code: "AUTHORIZATION_FAILED" });
      await assert.rejects(wallet("wrong passphrase value").send(pauseRequest(t.pub)), { code: "AUTHORIZATION_FAILED" });
      assert.equal(rpc.broadcasts.length, 0, "nothing was broadcast by any refusal");
      rpc.failBroadcast = true; // the reply is lost but the transaction hash is already known
      assert.match(await wallet().send(pauseRequest(t.pub)), /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
      assert.equal(rpc.broadcasts.length, 1, "one bounded attempt, never a second transaction");
    } finally { await rpc.close(); await t.done(); }
  });
});
