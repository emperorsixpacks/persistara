import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isIdentifier, isObject, MemoryError } from "../../protocol/src/memory.js";

export interface EnvelopeContext {
  agentId: string;
  recordId: string;
  keyEpoch: number;
  purpose: "memory" | "manifest";
}

const MAX_PLAINTEXT_BYTES = 1_000_000;
const MAX_ENVELOPE_BYTES = 1_500_000;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateContext(ctx: EnvelopeContext): void {
  if (!isIdentifier(ctx.agentId) || !isIdentifier(ctx.recordId) ||
      !Number.isSafeInteger(ctx.keyEpoch) || ctx.keyEpoch < 1 ||
      (ctx.purpose !== "memory" && ctx.purpose !== "manifest")) {
    throw new MemoryError("INVALID_INPUT", "Invalid encryption context");
  }
}

function aad(ctx: EnvelopeContext): Buffer {
  return Buffer.from(JSON.stringify(["persistara-envelope", 1, ctx.agentId, ctx.recordId, ctx.keyEpoch, ctx.purpose]));
}

function checkKey(key: Uint8Array): void {
  if (key.byteLength !== 32) throw new MemoryError("INVALID_INPUT", "Memory keys must contain 32 random bytes");
}

function decode(value: unknown, min: number, max: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new MemoryError("INVALID_ENVELOPE", "Invalid envelope encoding");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < min || bytes.length > max || bytes.toString("base64url") !== value) {
    throw new MemoryError("INVALID_ENVELOPE", "Invalid envelope length or encoding");
  }
  return bytes;
}

export function seal(plaintext: Uint8Array, key: Uint8Array, context: EnvelopeContext): Uint8Array {
  checkKey(key);
  validateContext(context);
  if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new MemoryError("INVALID_INPUT", "Memory payload exceeds permitted size");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(JSON.stringify({
    version: 1,
    algorithm: "AES-256-GCM",
    context: { ...context },
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  }));
}

export function open(encrypted: Uint8Array, key: Uint8Array, expected: EnvelopeContext): Uint8Array {
  checkKey(key);
  validateContext(expected);
  if (encrypted.byteLength < 1 || encrypted.byteLength > MAX_ENVELOPE_BYTES) {
    throw new MemoryError("INVALID_ENVELOPE", "Invalid envelope size");
  }
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encrypted)); }
  catch { throw new MemoryError("INVALID_ENVELOPE", "Envelope is not valid UTF-8 JSON"); }
  if (!isObject(envelope) || envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM" ||
      Object.keys(envelope).sort().join(",") !== "algorithm,ciphertext,context,nonce,tag,version" ||
      !isObject(envelope.context) || Object.keys(envelope.context).sort().join(",") !== "agentId,keyEpoch,purpose,recordId") {
    throw new MemoryError("INVALID_ENVELOPE", "Unsupported or malformed encrypted envelope");
  }
  const ctx = envelope.context;
  if (ctx.agentId !== expected.agentId || ctx.recordId !== expected.recordId ||
      ctx.keyEpoch !== expected.keyEpoch || ctx.purpose !== expected.purpose) {
    throw new MemoryError("AUTHENTICATION_FAILED", "Envelope context does not match the requested record");
  }
  const nonce = decode(envelope.nonce, 12, 12);
  const tag = decode(envelope.tag, 16, 16);
  const ciphertext = decode(envelope.ciphertext, 1, MAX_PLAINTEXT_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(expected));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new MemoryError("AUTHENTICATION_FAILED", "Encrypted record authentication failed");
  }
}
