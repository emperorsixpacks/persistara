import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { readPrivateFile, writePrivateFile } from "../../memory/src/files.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";

/**
 * Encrypted owner-key store, like `solana-keygen` or `stellar keys`: one small JSON file per account in a separate private
 * directory (default ~/.persistara-signer, override with PERSISTARA_SIGNER_DIR). The secret is encrypted with AES-256-GCM
 * under a key derived from the user's passphrase with scrypt; the account and public key are authenticated as associated data,
 * so swapping or editing a file fails. Files are created once (never overwritten), mode 0600 in a 0700 directory. Decrypting
 * happens only inside a short-lived signer process (keystore-worker); callers here get plaintext only when they ask for it.
 * A forgotten passphrase cannot be recovered: keep your own backup of the key.
 */
export const KEYSTORE_FORMAT = "persistara-owner-keystore";
export const MIN_PASSPHRASE_CHARS = 12;
const SECRET = /^ed25519:[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const ACCOUNT = /^[a-z0-9._-]{2,64}$/;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (value: unknown, length?: number) => { if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw bad("Malformed key store file"); const bytes = Buffer.from(value, "base64url"); if (length !== undefined && bytes.length !== length) throw bad("Malformed key store file"); return bytes; };
const bad = (message: string) => new ProviderError("INVALID_INPUT", message);
const denied = () => new ProviderError("AUTHORIZATION_FAILED", "Wrong passphrase, or the key store file was changed");

export const keystoreDirectory = (env: Record<string, string | undefined> = process.env) => env.PERSISTARA_SIGNER_DIR || join(homedir(), ".persistara-signer");
export const keystorePath = (account: string, directory = keystoreDirectory()) => { if (!ACCOUNT.test(account)) throw bad("Invalid account name"); return join(directory, `${account}.keystore.json`); };
const aad = (account: string, publicKey: string) => Buffer.from(JSON.stringify([KEYSTORE_FORMAT, 1, account, publicKey]));
const derive = (passphrase: string, salt: Buffer, N: number, r: number, p: number) => new Promise<Buffer>((resolve, reject) => scrypt(passphrase.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 512 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));

export interface KeystoreEntry { account: string; publicKey: string }
export interface KdfCost { N: number; r: number; p: number }
export const DEFAULT_COST: KdfCost = { N: 1 << 17, r: 8, p: 1 };

export function checkPassphrase(passphrase: string) {
  if (passphrase.length < MIN_PASSPHRASE_CHARS) throw bad(`Use a passphrase of at least ${MIN_PASSPHRASE_CHARS} characters`);
}
/** Returns the file bytes. `cost` is exposed so tests can use a cheap setting; real use takes the default. */
export async function encryptKeystoreEntry(account: string, secret: string, passphrase: string, cost: KdfCost = DEFAULT_COST): Promise<Buffer> {
  if (!ACCOUNT.test(account)) throw bad("Invalid account name");
  if (!SECRET.test(secret)) throw bad("The key must be an ed25519:... secret key");
  checkPassphrase(passphrase);
  const publicKey = KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]).getPublicKey().toString();
  const salt = randomBytes(16), nonce = randomBytes(12), key = await derive(passphrase, salt, cost.N, cost.r, cost.p);
  const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad(account, publicKey));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return Buffer.from(JSON.stringify({ schemaVersion: 1, format: KEYSTORE_FORMAT, account, publicKey, network: "testnet", kdf: { name: "scrypt", ...cost, salt: b64(salt) }, cipher: { name: "aes-256-gcm", nonce: b64(nonce) }, ciphertext: b64(ciphertext) }, null, 2) + "\n");
}
function parse(bytes: Uint8Array) {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw bad("The key store file is not valid JSON"); }
  if (!isObject(value) || value.schemaVersion !== 1 || value.format !== KEYSTORE_FORMAT || typeof value.account !== "string" || !ACCOUNT.test(value.account) || typeof value.publicKey !== "string" || !isObject(value.kdf) || !isObject(value.cipher)) throw bad("Unsupported key store file");
  const { N, r, p } = value.kdf;
  if (value.kdf.name !== "scrypt" || !Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || Number(N) < 1 << 14 || Number(N) > 1 << 20 || (Number(N) & (Number(N) - 1)) !== 0 || Number(r) < 1 || Number(r) > 16 || Number(p) < 1 || Number(p) > 4) throw bad("Unsupported key derivation settings");
  if (value.cipher.name !== "aes-256-gcm") throw bad("Unsupported cipher");
  return { account: value.account, publicKey: value.publicKey, cost: { N: Number(N), r: Number(r), p: Number(p) }, salt: unb64(value.kdf.salt, 16), nonce: unb64(value.cipher.nonce, 12), ciphertext: unb64(value.ciphertext) };
}
export function describeKeystoreEntry(bytes: Uint8Array): KeystoreEntry { const { account, publicKey } = parse(bytes); return { account, publicKey }; }
/** Decrypts. Only the signer worker (or a one-shot owner tool) should call this. */
export async function decryptKeystoreEntry(bytes: Uint8Array, passphrase: string): Promise<{ account: string; publicKey: string; secret: string }> {
  const entry = parse(bytes);
  if (entry.ciphertext.length < 17) throw bad("Malformed key store file");
  const key = await derive(passphrase, entry.salt, entry.cost.N, entry.cost.r, entry.cost.p);
  const decipher = createDecipheriv("aes-256-gcm", key, entry.nonce); decipher.setAAD(aad(entry.account, entry.publicKey));
  decipher.setAuthTag(entry.ciphertext.subarray(entry.ciphertext.length - 16));
  let secret: string;
  try { secret = Buffer.concat([decipher.update(entry.ciphertext.subarray(0, entry.ciphertext.length - 16)), decipher.final()]).toString("utf8"); } catch { throw denied(); }
  if (!SECRET.test(secret)) throw denied();
  const derived = KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]).getPublicKey().toString();
  if (Buffer.byteLength(derived) !== Buffer.byteLength(entry.publicKey) || !timingSafeEqual(Buffer.from(derived), Buffer.from(entry.publicKey))) throw denied();
  return { account: entry.account, publicKey: entry.publicKey, secret };
}
export async function saveKeystoreEntry(account: string, secret: string, passphrase: string, directory = keystoreDirectory(), cost: KdfCost = DEFAULT_COST) {
  const bytes = await encryptKeystoreEntry(account, secret, passphrase, cost), path = keystorePath(account, directory);
  await writePrivateFile(path, bytes); // exclusive create: an existing entry is never replaced
  return { path, ...describeKeystoreEntry(bytes) };
}
export async function readKeystoreEntry(account: string, directory = keystoreDirectory()): Promise<Buffer | null> {
  try { return Buffer.from(await readPrivateFile(keystorePath(account, directory), 8192)); } catch (error) { if (isObject(error) && error.code === "ENOENT") return null; throw error; }
}
export async function listKeystore(directory = keystoreDirectory()): Promise<KeystoreEntry[]> {
  let names: string[]; try { names = await readdir(directory); } catch (error) { if (isObject(error) && error.code === "ENOENT") return []; throw error; }
  const entries: KeystoreEntry[] = [];
  for (const name of names.filter((n) => n.endsWith(".keystore.json")).sort()) { const bytes = await readKeystoreEntry(name.slice(0, -".keystore.json".length), directory); if (bytes) entries.push(describeKeystoreEntry(bytes)); }
  return entries;
}
