import { KeyPair } from "near-api-js";
import { ProviderError } from "../../protocol/src/providers.js";

const SECRET = /^ed25519:[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const bad = (message: string) => new ProviderError("INVALID_INPUT", message);

/**
 * Reads an owner secret key from either a bare `ed25519:...` line or a NEAR CLI credentials JSON
 * (`{"account_id","public_key","private_key"}`, as written by `near account create-account ... save-to-legacy-keychain`).
 * Checks that the file belongs to the expected account and that its public key matches its secret, so a mixed-up file is
 * caught before anything is signed. Error messages never contain key material.
 */
export function parseOwnerKeyFile(text: string, expectedAccount: string): string {
  const value = text.trim();
  let secret: string;
  if (value.startsWith("{")) {
    let json: unknown;
    try { json = JSON.parse(value); } catch { throw bad("The key file looks like JSON but is not valid JSON"); }
    if (typeof json !== "object" || json === null) throw bad("Unsupported key file");
    const record = json as Record<string, unknown>, candidate = record.private_key ?? record.secret_key;
    if (typeof candidate !== "string" || !SECRET.test(candidate)) throw bad("The key file has no usable ed25519 private_key");
    if (record.account_id !== undefined && record.account_id !== expectedAccount) throw bad(`This key file belongs to ${typeof record.account_id === "string" ? record.account_id.slice(0, 64) : "another account"}, not ${expectedAccount}`);
    secret = candidate;
    if (record.public_key !== undefined && KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]).getPublicKey().toString() !== record.public_key) throw bad("The key file's public key does not match its private key");
  } else {
    if (!SECRET.test(value)) throw bad("The owner key file must contain an ed25519:... secret key or a NEAR credentials JSON file");
    secret = value;
  }
  return secret;
}
