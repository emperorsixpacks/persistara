import { calculateJwkThumbprint, compactDecrypt, CompactEncrypt, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { canonical, hash } from "../../near/src/protocol.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import type { MissionScope } from "../../runtime/src/types.js";
import type { RecipientPublicKey } from "./types.js";

export interface RecipientKeys { schemaVersion: 1; publicKey: RecipientPublicKey; privateKey: JWK }
export interface EncryptionContext { scope: MissionScope; commissionId: string; missionId: string; purpose: "brief" | "artifact" }
const bad = () => new ProviderError("INTEGRITY_FAILED", "Recipient key or encrypted commission envelope is invalid");
export function recipientKey(value: unknown): asserts value is RecipientPublicKey {
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "e,kty,n" || value.kty !== "RSA" || value.e !== "AQAB" || typeof value.n !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.n) || Buffer.from(value.n, "base64url").length !== 384 || Buffer.from(value.n, "base64url").toString("base64url") !== value.n) throw bad();
}
export async function recipientKeys(): Promise<RecipientKeys> {
  const pair = await generateKeyPair("RSA-OAEP-256", { modulusLength: 3072, extractable: true });
  const publicKey = await exportJWK(pair.publicKey) as RecipientPublicKey; recipientKey(publicKey);
  return { schemaVersion: 1, publicKey, privateKey: await exportJWK(pair.privateKey) };
}
export async function validateRecipientKeys(value: unknown): Promise<RecipientKeys> {
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "privateKey,publicKey,schemaVersion" || value.schemaVersion !== 1 || !isObject(value.privateKey)) throw bad();
  recipientKey(value.publicKey);
  const privateKey = value.privateKey as JWK;
  if (Object.keys(privateKey).sort().join(",") !== "d,dp,dq,e,kty,n,p,q,qi" || privateKey.n !== value.publicKey.n || privateKey.e !== value.publicKey.e || privateKey.kty !== "RSA") throw bad();
  await importJWK(privateKey, "RSA-OAEP-256");
  return value as unknown as RecipientKeys;
}
export async function encryptCommission(value: unknown, key: RecipientPublicKey, context: EncryptionContext): Promise<string> {
  recipientKey(key);
  const bytes = Buffer.from(canonical({ context, value }));
  if (bytes.length > 1_000_000) throw new ProviderError("INVALID_INPUT", "Commission payload exceeds its bound");
  return new CompactEncrypt(bytes).setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM", typ: "persistara-commission+jwe", kid: await calculateJwkThumbprint(key), contextDigest: hash(canonical(context)) }).encrypt(await importJWK(key, "RSA-OAEP-256"));
}
export async function decryptCommission(encrypted: string, keys: RecipientKeys, expected: EncryptionContext): Promise<unknown> {
  try {
    if (typeof encrypted !== "string" || encrypted.length < 100 || encrypted.length > 1_500_000 || !/^[A-Za-z0-9_.-]+$/.test(encrypted)) throw bad();
    const result = await compactDecrypt(encrypted, await importJWK(keys.privateKey, "RSA-OAEP-256"), { keyManagementAlgorithms: ["RSA-OAEP-256"], contentEncryptionAlgorithms: ["A256GCM"] });
    const header = result.protectedHeader;
    if (Object.keys(header).sort().join(",") !== "alg,contextDigest,enc,kid,typ" || header.typ !== "persistara-commission+jwe" || header.kid !== await calculateJwkThumbprint(keys.publicKey) || header.contextDigest !== hash(canonical(expected))) throw bad();
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.plaintext));
    if (!isObject(payload) || Object.keys(payload).sort().join(",") !== "context,value" || canonical(payload.context) !== canonical(expected)) throw bad();
    return payload.value;
  } catch { throw new ProviderError("VERIFICATION_FAILED", "Encrypted commission content could not be authenticated"); }
}
