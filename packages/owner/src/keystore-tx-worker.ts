import { JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions, baseDecode, baseEncode, createTransaction } from "near-api-js";
import { assertRuntime } from "../../protocol/src/config.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { fail, reply } from "../../protocol/src/worker.js";
import { decryptKeystoreEntry, readKeystoreEntry } from "./keystore.js";

const GAS = 100_000_000_000_000n;
/**
 * Short-lived signer process for ONE owner transaction: `set_paused` on the authority contract, 0 NEAR attached, fixed gas. It
 * starts with an empty environment and no stdio, receives the passphrase over IPC, signs, broadcasts once and exits. The secret
 * never leaves it. Failures before signing are definite (nothing was sent). After the transaction hash exists the worker always
 * returns it, even if the broadcast reply is lost, so the caller records a dispatched request and reconciles by hash instead of
 * ever sending a second transaction.
 */
process.once("message", async (input: unknown) => {
  try {
    assertRuntime();
    const tx = isObject(input) ? input.tx : null;
    if (!isObject(input) || typeof input.account !== "string" || typeof input.directory !== "string" || typeof input.passphrase !== "string" || typeof input.rpcUrl !== "string" ||
        typeof input.ownerPublicKey !== "string" || !isObject(tx) || typeof tx.receiverId !== "string" || tx.methodName !== "set_paused" || tx.gas !== GAS.toString() || tx.deposit !== "0" ||
        !isObject(tx.args) || Object.keys(tx.args).sort().join(",") !== "agent_id,paused" || typeof tx.args.agent_id !== "string" || typeof tx.args.paused !== "boolean") { fail("INVALID_INPUT"); return; }
    const url = new URL(input.rpcUrl);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) || url.username || url.password) { fail("INVALID_INPUT"); return; }
    const bytes = await readKeystoreEntry(input.account, input.directory);
    if (!bytes) { fail("NOT_CONFIGURED"); return; }
    const opened = await decryptKeystoreEntry(bytes, input.passphrase);
    const key = KeyPair.fromString(opened.secret as Parameters<typeof KeyPair.fromString>[0]);
    if (opened.account !== input.account || key.getPublicKey().toString() !== input.ownerPublicKey) { fail("AUTHORIZATION_FAILED"); return; }
    const provider = new JsonRpcProvider({ url: url.toString() });
    // Anything that throws from here until the hash exists is a definite "nothing was sent" failure.
    const access = await provider.query({ request_type: "view_access_key", finality: "final", account_id: opened.account, public_key: input.ownerPublicKey }) as unknown as { nonce: number | string; block_hash: string; permission: unknown };
    if (access.permission !== "FullAccess") { fail("AUTHORIZATION_FAILED"); return; }
    const built = createTransaction(opened.account, PublicKey.fromString(input.ownerPublicKey), tx.receiverId, BigInt(access.nonce) + 1n,
      [actions.functionCall("set_paused", Buffer.from(JSON.stringify(tx.args)), GAS, 0n)], baseDecode(access.block_hash));
    const signed = await new KeyPairSigner(key).signTransaction(built);
    const hash = baseEncode(signed.txHash);
    let broadcast: "sent" | "unknown" = "sent";
    // One bounded attempt of the same signed bytes, without the SDK's long backoff: a lost reply must still return the hash.
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: "persistara-owner", method: "send_tx", params: { signed_tx_base64: Buffer.from(signed.signedTransaction.encode()).toString("base64"), wait_until: "NONE" } }) });
      const body = await response.json() as { error?: unknown };
      if (!response.ok || body.error) broadcast = "unknown";
    } catch { broadcast = "unknown"; }
    reply({ transactionHash: hash, broadcast });
  } catch (error) { fail(error instanceof ProviderError ? error.code : "UPSTREAM_ERROR"); }
});
