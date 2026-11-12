import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { KeyPair } from "near-api-js";
import { walletAdd, walletCheck, walletList, walletRemove, type WalletCommandDeps } from "../packages/operator/src/wallet-commands.js";
import { decryptKeystoreEntry, listKeystore, readKeystoreEntry } from "../packages/owner/src/keystore.js";

/** Fake prompts and chain; throwaway generated keys; cheap scrypt. No network and no real wallet. */
const CHEAP = { N: 1 << 14, r: 8, p: 1 }, PASS = "correct horse battery staple";
async function fixture(over: { secrets?: (string | null)[]; chainKeys?: string[]; agentOwnerKey?: string | null; interactive?: boolean; files?: Record<string, string> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "persistara-walletcmd-")); await chmod(directory, 0o700);
  const pair = KeyPair.fromRandom("ed25519"), secret = pair.toString(), pub = pair.getPublicKey().toString();
  const said: string[] = [], warned: string[] = [], asked: string[] = [], queue = [...(over.secrets ?? [PASS, PASS])];
  const deps: WalletCommandDeps = {
    directory, interactive: over.interactive ?? true, cost: CHEAP, config: { account: "owner.testnet", contract: "authority.testnet", agentId: "research.owner.testnet" },
    say: (t) => { said.push(t); }, warn: (t) => { warned.push(t); }, secret: async (p) => { asked.push(p); return queue.length ? queue.shift()! : null; },
    readKeyFile: async (path) => { const v = (over.files ?? {})[path]; if (v === undefined) throw new Error("no such file"); return v; }, credentialsPath: (a) => `/home/u/.near-credentials/testnet/${a}.json`,
    chain: { fullAccessKeys: async () => over.chainKeys ?? [pub], ownerKeyOf: async () => over.agentOwnerKey === undefined ? pub : over.agentOwnerKey },
    unlockCheck: async (account, passphrase) => (await decryptKeystoreEntry((await readKeystoreEntry(account, directory))!, passphrase)).publicKey,
  };
  return { deps, secret, pub, said, warned, asked, directory, done: () => rm(directory, { recursive: true, force: true }) };
}
const everything = (f: { said: string[]; warned: string[]; asked: string[] }) => [...f.said, ...f.warned, ...f.asked].join("\n");

describe("wallet add / list / remove / check", () => {
  it("imports from a private key file after confirming the key is on the account, and never prints the secret", async () => {
    const f = await fixture(); f.deps.readKeyFile = async () => `${f.secret}\n`;
    try {
      const saved = await walletAdd(f.deps, { keyFile: "/k/owner.key" });
      assert.equal(saved.publicKey, f.pub);
      assert.ok(!everything(f).includes(f.secret.slice(8)) && !everything(f).includes(PASS), "no secret or passphrase in any output or prompt");
      assert.equal((await decryptKeystoreEntry((await readKeystoreEntry("owner.testnet", f.directory))!, PASS)).secret, f.secret);
      assert.deepEqual((await walletList(f.deps)).map((e) => e.account), ["owner.testnet"]);
      assert.equal(await walletCheck({ ...f.deps, interactive: true }, undefined).then(() => "ok", () => "no"), "no", "no passphrase queued, so the check is cancelled");
    } finally { await f.done(); }
  });
  it("uses an existing NEAR CLI credentials file, and refuses one that belongs to another account", async () => {
    const f = await fixture(); const path = "/home/u/.near-credentials/testnet/owner.testnet.json";
    f.deps.readKeyFile = async () => JSON.stringify({ account_id: "owner.testnet", public_key: f.pub, private_key: f.secret });
    try { await walletAdd(f.deps, { fromNearCredentials: true }); assert.ok(f.said.some((s) => s.includes("existing NEAR credentials")) && path.length > 0); }
    finally { await f.done(); }
    const g = await fixture(); g.deps.readKeyFile = async () => JSON.stringify({ account_id: "someone.testnet", public_key: g.pub, private_key: g.secret });
    try { await assert.rejects(walletAdd(g.deps, { fromNearCredentials: true }), /belongs to someone\.testnet/); assert.deepEqual(await listKeystore(g.directory), []); } finally { await g.done(); }
  });
  it("accepts a pasted key through the hidden prompt, and refuses when not interactive", async () => {
    const f = await fixture(); (f.deps as { secret: WalletCommandDeps["secret"] }).secret = (() => { const answers = [f.secret, PASS, PASS]; return async (p: string) => { f.asked.push(p); return answers.shift() ?? null; }; })();
    try { assert.equal((await walletAdd(f.deps, {})).publicKey, f.pub); assert.ok(!everything(f).includes(f.secret.slice(8))); } finally { await f.done(); }
    const g = await fixture({ interactive: false });
    try { await assert.rejects(walletAdd(g.deps, {}), /interactive/); await assert.rejects(walletAdd(g.deps, { keyFile: "/k" }), /no such file|interactive/); } finally { await g.done(); }
  });
  it("stores nothing when the key is not on the account, the passphrase is weak or mismatched, or the prompt is cancelled", async () => {
    const wrong = await fixture({ chainKeys: [KeyPair.fromRandom("ed25519").getPublicKey().toString()] }); wrong.deps.readKeyFile = async () => wrong.secret;
    try { await assert.rejects(walletAdd(wrong.deps, { keyFile: "/k" }), { code: "AUTHORIZATION_FAILED" }); assert.deepEqual(await listKeystore(wrong.directory), []); } finally { await wrong.done(); }
    for (const [secrets, expected] of [[["short", "short"], /at least 12/], [[PASS, "a different passphrase"], /did not match/], [[null], /Cancelled/]] as const) {
      const f = await fixture({ secrets: [...secrets] }); f.deps.readKeyFile = async () => f.secret;
      try { await assert.rejects(walletAdd(f.deps, { keyFile: "/k" }), expected); assert.deepEqual(await listKeystore(f.directory), []); } finally { await f.done(); }
    }
  });
  it("warns when the key is not the agent's registered owner key, and will not replace an existing entry", async () => {
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString(), f = await fixture({ agentOwnerKey: other }); f.deps.readKeyFile = async () => f.secret;
    try {
      await walletAdd(f.deps, { keyFile: "/k" }); assert.ok(f.warned.some((w) => w.includes("different owner key") && w.includes(other)));
      f.deps.secret = async () => PASS; await assert.rejects(walletAdd(f.deps, { keyFile: "/k" }), /already stored/);
    } finally { await f.done(); }
  });
  it("removes a key only after the account name is typed back, and the passphrase check proves unlocking", async () => {
    const f = await fixture(); f.deps.readKeyFile = async () => f.secret;
    try {
      await walletAdd(f.deps, { keyFile: "/k" });
      const asked = ["wrong.testnet"]; const removal = { ...f.deps, secret: async () => asked.shift() ?? null };
      assert.equal(await walletRemove(removal, "owner.testnet"), false); assert.equal((await listKeystore(f.directory)).length, 1);
      const answers = [PASS]; assert.equal(await walletCheck({ ...f.deps, secret: async () => answers.shift() ?? null }, "owner.testnet"), f.pub);
      const confirm = ["owner.testnet"]; assert.equal(await walletRemove({ ...f.deps, secret: async () => confirm.shift() ?? null }, "owner.testnet"), true); assert.deepEqual(await listKeystore(f.directory), []);
      assert.equal(await walletRemove(f.deps, "owner.testnet"), false);
    } finally { await f.done(); }
  });
});
