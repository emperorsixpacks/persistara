import { randomBytes, randomUUID } from "node:crypto";
import { open, seal, sha256 } from "../../crypto/src/envelope.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { isObject } from "../../protocol/src/memory.js";
import { digest, stable } from "./journal.js";
import type { ConversationScope, SessionSnapshot } from "./types.js";

/**
 * Encrypted owner backup of chat sessions. It uses its own random secret (never a memory key, NEAR key or API key) and the
 * existing AES-256-GCM envelope. Each session is its own envelope bound to this agent, scope and backup, and a manifest
 * envelope pins the exact session list so a missing, swapped or replayed session is detected. Chat content is private owner
 * data; the bundle holds it only encrypted, and the secret must be stored separately from the bundle.
 */
const SECRET_PREFIX = "persistara-conversation-v1:";
export const MAX_BACKUP_FILE_BYTES = 32_000_000;
const FORMAT = "persistara-conversation-backup";
const bad = (message: string) => new ProviderError("INVALID_INPUT", message);
const rejected = () => new ProviderError("VERIFICATION_FAILED", "Conversation backup failed authentication or belongs to another agent, contract or network");

export function newBackupSecret(): string { return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`; }
function secretKey(secret: string): Uint8Array {
  if (!secret.startsWith(SECRET_PREFIX)) throw bad("Unsupported conversation backup secret");
  const text = secret.slice(SECRET_PREFIX.length), bytes = Buffer.from(text, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== text) throw bad("Unsupported conversation backup secret");
  return bytes;
}
const context = (scope: ConversationScope, backupId: string, item: string) =>
  ({ agentId: scope.agentId, recordId: `conversation:${backupId}:${item}:${digest(scope).slice(0, 32)}`, keyEpoch: 1, purpose: "recovery" as const });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (value: unknown) => { if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw bad("Malformed conversation backup"); return Buffer.from(value, "base64url"); };

export function sealConversationBackup(scope: ConversationScope, sessions: readonly SessionSnapshot[], secret: string): Uint8Array {
  const key = secretKey(secret), backupId = randomUUID();
  const items = sessions.map((snapshot) => {
    const plaintext = Buffer.from(stable(snapshot));
    if (plaintext.byteLength > 900_000) throw bad(`Session ${snapshot.detail.session.id} is too large for one encrypted backup envelope (limit about 900 KB)`);
    const wrapped = seal(plaintext, key, context(scope, backupId, snapshot.detail.session.id));
    return { id: snapshot.detail.session.id, sha256: sha256(wrapped), wrapped: b64(wrapped) };
  });
  const manifest = seal(Buffer.from(stable({ backupId, sessions: items.map((item) => ({ id: item.id, sha256: item.sha256 })) })), key, context(scope, backupId, "manifest"));
  const bundle = Buffer.from(JSON.stringify({ schemaVersion: 1, format: FORMAT, scope, backupId, manifest: b64(manifest), sessions: items.map((item) => ({ id: item.id, wrapped: item.wrapped })) }));
  if (bundle.byteLength > MAX_BACKUP_FILE_BYTES) throw bad("Conversation backup exceeds its size limit");
  return bundle;
}

/** Authenticates the bundle against the expected scope and returns the decrypted sessions. Fails closed; never falls back to plaintext. */
export function openConversationBackup(bundle: Uint8Array, secret: string, expected: ConversationScope): SessionSnapshot[] {
  const key = secretKey(secret);
  if (bundle.byteLength < 2 || bundle.byteLength > MAX_BACKUP_FILE_BYTES) throw bad("Conversation backup has an invalid size");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bundle)); } catch { throw bad("Conversation backup is malformed"); }
  if (!isObject(value) || value.schemaVersion !== 1 || value.format !== FORMAT || typeof value.backupId !== "string" || !Array.isArray(value.sessions) || Object.keys(value).sort().join(",") !== "backupId,format,manifest,schemaVersion,scope,sessions") throw bad("Unsupported conversation backup");
  if (stable(value.scope) !== stable(expected)) throw rejected();
  const backupId = value.backupId;
  let manifest: { backupId?: unknown; sessions?: unknown };
  try { manifest = JSON.parse(Buffer.from(open(unb64(value.manifest), key, context(expected, backupId, "manifest"))).toString("utf8")) as typeof manifest; } catch { throw rejected(); }
  if (manifest.backupId !== backupId || !Array.isArray(manifest.sessions) || manifest.sessions.length !== value.sessions.length) throw rejected();
  return value.sessions.map((entry: unknown, index) => {
    const pinned = manifest.sessions as { id?: unknown; sha256?: unknown }[];
    if (!isObject(entry) || typeof entry.id !== "string" || entry.id !== pinned[index]?.id) throw rejected();
    const wrapped = unb64(entry.wrapped);
    if (sha256(wrapped) !== pinned[index]?.sha256) throw rejected();
    let snapshot: SessionSnapshot;
    try { snapshot = JSON.parse(Buffer.from(open(wrapped, key, context(expected, backupId, entry.id))).toString("utf8")) as SessionSnapshot; } catch { throw rejected(); }
    if (snapshot.detail?.session?.id !== entry.id) throw rejected();
    return snapshot;
  });
}
