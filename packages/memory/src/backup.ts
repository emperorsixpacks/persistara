import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { open, seal } from "../../crypto/src/envelope.js";
import { isObject, MemoryError } from "../../protocol/src/memory.js";
import { assertBinding, bindingDigest, bindingText, type MemoryBinding } from "./binding.js";
import { MAX_KEY_EPOCHS, MemoryKeyring } from "./keyring.js";

const SECRET_PREFIX = "persistara-recovery-v1:";
const MAX_BACKUP_BYTES = 32_768;
interface PrivateKeyring { schemaVersion: 1; binding: MemoryBinding; activeEpoch: number; keys: { epoch: number; key: string }[] }

function parse(bytes: Uint8Array): unknown {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_BACKUP_BYTES) throw new MemoryError("INVALID_BACKUP", "Recovery material exceeds its size limit");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new MemoryError("INVALID_BACKUP", "Recovery material is malformed"); }
}
function decodeKey(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new MemoryError("INVALID_BACKUP", "Invalid recovery key encoding");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) throw new MemoryError("INVALID_BACKUP", "Invalid recovery key encoding");
  return bytes;
}
function requireBinding(value: unknown, expected: MemoryBinding): void {
  assertBinding(value);
  if (bindingText(value) !== bindingText(expected)) throw new MemoryError("AUTHENTICATION_FAILED", "Recovery material belongs to another agent, contract or network");
}
/** Plaintext private export: only for a private owner/runtime key file or inside the encrypted bundle. */
export function encodePrivateKeyring(binding: MemoryBinding, keys: MemoryKeyring): Uint8Array {
  assertBinding(binding);
  const value: PrivateKeyring = { schemaVersion: 1, binding: structuredClone(binding), activeEpoch: keys.activeEpoch,
    keys: keys.epochs().map((epoch) => ({ epoch, key: Buffer.from(keys.key(epoch)).toString("base64url") })) };
  return Buffer.from(JSON.stringify(value));
}
export function decodePrivateKeyring(bytes: Uint8Array, expected: MemoryBinding): MemoryKeyring {
  assertBinding(expected);
  const value = parse(bytes);
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "activeEpoch,binding,keys,schemaVersion" || value.schemaVersion !== 1 || !Number.isSafeInteger(value.activeEpoch) ||
      !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > MAX_KEY_EPOCHS) throw new MemoryError("INVALID_BACKUP", "Unsupported private keyring");
  requireBinding(value.binding, expected);
  const entries = value.keys.map((item: unknown) => {
    if (!isObject(item) || Object.keys(item).sort().join(",") !== "epoch,key" || !Number.isSafeInteger(item.epoch)) throw new MemoryError("INVALID_BACKUP", "Malformed key epoch");
    return { epoch: Number(item.epoch), key: decodeKey(item.key) };
  });
  return new MemoryKeyring(Number(value.activeEpoch), entries);
}
function context(binding: MemoryBinding, backupId: string, epoch: number) {
  return { agentId: binding.agentId, recordId: `backup:${backupId}:${bindingDigest(binding)}`, keyEpoch: epoch, purpose: "recovery" as const };
}
export function createOwnerBackup(binding: MemoryBinding, keys: MemoryKeyring): { bundle: Uint8Array; recoverySecret: string } {
  assertBinding(binding);
  const secret = randomBytes(32);
  const backupId = randomUUID();
  const wrapped = seal(encodePrivateKeyring(binding, keys), secret, context(binding, backupId, keys.activeEpoch));
  const bundle = Buffer.from(JSON.stringify({ schemaVersion: 1, format: "persistara-owner-backup", binding: structuredClone(binding), backupId,
    activeEpoch: keys.activeEpoch, wrapped: Buffer.from(wrapped).toString("base64url") }));
  return { bundle, recoverySecret: `${SECRET_PREFIX}${secret.toString("base64url")}` };
}
export function restoreOwnerBackup(bundle: Uint8Array, recoverySecret: string, expected: MemoryBinding): MemoryKeyring {
  assertBinding(expected);
  if (typeof recoverySecret !== "string" || !recoverySecret.startsWith(SECRET_PREFIX)) throw new MemoryError("INVALID_BACKUP", "Unsupported recovery secret");
  const secret = decodeKey(recoverySecret.slice(SECRET_PREFIX.length));
  const value = parse(bundle);
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "activeEpoch,backupId,binding,format,schemaVersion,wrapped" || value.schemaVersion !== 1 || value.format !== "persistara-owner-backup" ||
      typeof value.backupId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.backupId) ||
      !Number.isSafeInteger(value.activeEpoch) || Number(value.activeEpoch) < 1 || typeof value.wrapped !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.wrapped)) {
    throw new MemoryError("INVALID_BACKUP", "Unsupported owner backup");
  }
  requireBinding(value.binding, expected);
  const wrapped = Buffer.from(value.wrapped, "base64url");
  if (wrapped.toString("base64url") !== value.wrapped) throw new MemoryError("INVALID_BACKUP", "Noncanonical backup encoding");
  const keyring = decodePrivateKeyring(open(wrapped, secret, context(expected, value.backupId, Number(value.activeEpoch))), expected);
  if (keyring.activeEpoch !== value.activeEpoch) throw new MemoryError("INVALID_BACKUP", "Backup epoch does not match its authenticated payload");
  return keyring;
}
export function verifyOwnerBackup(bundle: Uint8Array, secret: string, binding: MemoryBinding, original?: MemoryKeyring): { activeEpoch: number; epochs: number[] } {
  const restored = restoreOwnerBackup(bundle, secret, binding);
  if (original && (original.activeEpoch !== restored.activeEpoch || original.epochs().join() !== restored.epochs().join() ||
      original.epochs().some((epoch) => !timingSafeEqual(original.key(epoch), restored.key(epoch))))) throw new MemoryError("AUTHENTICATION_FAILED", "Backup does not reproduce the original keyring");
  return { activeEpoch: restored.activeEpoch, epochs: restored.epochs() };
}
