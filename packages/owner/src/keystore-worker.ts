import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { signMessage } from "near-api-js/nep413";
import { assertRuntime } from "../../protocol/src/config.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { fail, reply } from "../../protocol/src/worker.js";
import { decryptKeystoreEntry, readKeystoreEntry } from "./keystore.js";

/**
 * Short-lived signer process: the ONLY place the owner key is decrypted for terminal sign-in. It starts with an empty
 * environment and no stdio, receives the passphrase over IPC (never argv or env), signs one NEP-413 message and exits. The
 * secret never leaves this process: only the account, public key and signature are returned.
 */
process.once("message", async (input: unknown) => {
  try {
    assertRuntime();
    if (!isObject(input) || typeof input.account !== "string" || typeof input.directory !== "string" || typeof input.passphrase !== "string" || !isObject(input.payload) ||
        typeof input.payload.message !== "string" || typeof input.payload.recipient !== "string" || typeof input.payload.nonce !== "string") { fail("INVALID_INPUT"); return; }
    const nonce = Buffer.from(input.payload.nonce, "base64url");
    if (nonce.length !== 32 || input.payload.message.length > 4096 || input.payload.recipient.length > 256) { fail("INVALID_INPUT"); return; }
    const bytes = await readKeystoreEntry(input.account, input.directory);
    if (!bytes) { fail("NOT_CONFIGURED"); return; }
    const opened = await decryptKeystoreEntry(bytes, input.passphrase);
    if (opened.account !== input.account) { fail("AUTHORIZATION_FAILED"); return; }
    const account = new Account(opened.account, undefined as unknown as ConstructorParameters<typeof Account>[1], new KeyPairSigner(KeyPair.fromString(opened.secret as Parameters<typeof KeyPair.fromString>[0])));
    const signed = await signMessage({ signerAccount: account, payload: { message: input.payload.message, recipient: input.payload.recipient, nonce } });
    reply({ accountId: signed.accountId, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString("base64") });
  } catch (error) { fail(error instanceof ProviderError ? error.code : "UPSTREAM_ERROR"); }
});
