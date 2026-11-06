import { constants, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../../crypto/src/envelope.js";
import { assertBlobRef, isIdentifier, isObject, MemoryError, type MemoryHead } from "../../protocol/src/memory.js";
import { assertBinding, assertBoundBlob, bindingText, type MemoryBinding } from "./binding.js";
import type { MemorySnapshot, RecoveredMemory } from "./service.js";

const APPLICATION_ID = 0x50535241;
export interface RecallMatch extends RecoveredMemory {
  untrusted: true; revisionState: "current" | "superseded"; supersededBy: string[];
  citation: { memoryId: string; sourceKind: string; sourceReference: string; createdAt: string };
  freshness: { ageSeconds: number; futureTimestamp: boolean };
}
export interface RecallResult { asOfVersion: number; keyEpoch: number | null; headFingerprint: string; indexedAt: string; matches: RecallMatch[] }
interface Metadata { head: MemoryHead | null; fingerprint: string; indexedAt: string; recordsDigest: string }

export function headFingerprint(head: MemoryHead | null): string {
  if (head === null) return sha256(Buffer.from("persistara-empty-memory-head:1"));
  if (!Number.isSafeInteger(head.version) || head.version < 1 || !Number.isSafeInteger(head.keyEpoch) || head.keyEpoch < 1) throw new MemoryError("INVALID_MANIFEST", "Invalid memory checkpoint");
  assertBlobRef(head.manifest);
  const r = head.manifest;
  return sha256(Buffer.from(JSON.stringify(["persistara-memory-head", 1, head.version, head.keyEpoch, r.provider, r.network, r.objectId, r.ciphertextSha256, r.byteLength])));
}
function normalize(records: RecoveredMemory[], binding: MemoryBinding): RecoveredMemory[] {
  if (!Array.isArray(records) || records.length > 1000) throw new MemoryError("MEMORY_LIMIT", "Recall snapshot exceeds capacity");
  const ids = new Set<string>(); const operations = new Set<string>();
  const result: RecoveredMemory[] = [];
  let bytes = 0;
  for (const record of records) {
    if (!isObject(record) || record.schemaVersion !== 1 || record.agentId !== binding.agentId || !isIdentifier(record.id) || !isIdentifier(record.operationId) || ids.has(record.id) || operations.has(record.operationId) ||
        typeof record.text !== "string" || !record.text.trim() || Buffer.byteLength(record.text) > 65_536 || !Number.isSafeInteger(record.keyEpoch) || record.keyEpoch < 1 ||
        typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) || !isObject(record.source) || !["owner", "artifact", "tool"].includes(String(record.source.kind)) ||
        typeof record.source.reference !== "string" || !record.source.reference || record.source.reference.length > 4096 ||
        (record.supersedes !== undefined && (!isIdentifier(record.supersedes) || !ids.has(record.supersedes)))) throw new MemoryError("INVALID_MANIFEST", "Invalid recall record or revision lineage");
    bytes += Buffer.byteLength(record.text) + Buffer.byteLength(record.source.reference);
    if (bytes > 16 * 1024 * 1024) throw new MemoryError("MEMORY_LIMIT", "Recall exceeds the 16 MiB release cap");
    const copy: RecoveredMemory = { schemaVersion: 1, id: record.id, agentId: record.agentId, operationId: record.operationId, createdAt: record.createdAt,
      text: record.text, source: { kind: record.source.kind as RecoveredMemory["source"]["kind"], reference: record.source.reference }, keyEpoch: record.keyEpoch };
    if (record.supersedes !== undefined) copy.supersedes = record.supersedes;
    result.push(copy); ids.add(record.id); operations.add(record.operationId);
  }
  return result;
}
function digest(records: RecoveredMemory[]): string { return sha256(Buffer.from(JSON.stringify(records))); }

/** Rebuildable plaintext cache on the trusted owner machine; never upload it. */
export class MemoryRecallIndex {
  readonly #db: DatabaseSync;
  readonly #binding: MemoryBinding;
  constructor(path: string, binding: MemoryBinding) {
    assertBinding(binding); this.#binding = structuredClone(binding);
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(absolute));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new MemoryError("INVALID_INPUT", "Recall directory must be private");
    const fd = openSync(absolute, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const file = lstatSync(absolute);
    if (!file.isFile() || (file.mode & 0o077) !== 0) throw new MemoryError("INVALID_INPUT", "Recall file must be private");
    this.#db = new DatabaseSync(absolute);
    try {
      const app = this.#db.prepare("PRAGMA application_id").get()?.application_id;
      if (file.size > 0 && app !== APPLICATION_ID) throw new MemoryError("INVALID_INPUT", "File is not a Persistara recall cache");
      this.#db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;
        CREATE TABLE IF NOT EXISTS memory_meta (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, head TEXT NOT NULL, fingerprint TEXT NOT NULL, indexed_at TEXT NOT NULL, records_digest TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS memory_records (id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, created_at TEXT NOT NULL, is_current INTEGER NOT NULL CHECK(is_current IN (0,1)), record_json TEXT NOT NULL) STRICT;
        CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(text, content='memory_records', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');`);
      this.metadata();
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { this.#db.close(); }
  assertScope(binding: MemoryBinding): void {
    if (bindingText(binding) !== bindingText(this.#binding)) throw new MemoryError("AUTHENTICATION_FAILED", "Recovery and recall scopes differ");
  }
  assertAgent(agentId: string): void {
    if (agentId !== this.#binding.agentId) throw new MemoryError("AUTHENTICATION_FAILED", "Recall is scoped to another agent");
  }
  private begin(): void {
    try { this.#db.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      if (isObject(error) && (error.errcode === 5 || error.errcode === 6)) throw new MemoryError("INDEX_BUSY", "Recall cache is being used by another operation");
      throw new MemoryError("INTEGRITY_FAILED", "Recall cache transaction could not start");
    }
  }
  private metadata(): Metadata | null {
    const row = this.#db.prepare("SELECT * FROM memory_meta WHERE id=1").get();
    if (!row) return null;
    if (row.binding !== bindingText(this.#binding)) throw new MemoryError("AUTHENTICATION_FAILED", "Recall cache belongs to another agent or network");
    let head: MemoryHead | null;
    try { head = JSON.parse(String(row.head)) as MemoryHead | null; } catch { throw new MemoryError("INTEGRITY_FAILED", "Recall metadata is corrupt"); }
    if (head) assertBoundBlob(this.#binding, head.manifest);
    if (row.fingerprint !== headFingerprint(head) || typeof row.indexed_at !== "string" || !Number.isFinite(Date.parse(row.indexed_at)) || typeof row.records_digest !== "string" || !/^[a-f0-9]{64}$/.test(row.records_digest)) throw new MemoryError("INTEGRITY_FAILED", "Recall checkpoint metadata is corrupt");
    return { head, fingerprint: String(row.fingerprint), indexedAt: row.indexed_at, recordsDigest: row.records_digest };
  }
  replace(snapshot: MemorySnapshot): { version: number; recordCount: number; currentCount: number } {
    const captured = structuredClone(snapshot);
    const fingerprint = headFingerprint(captured.head);
    if (captured.head) assertBoundBlob(this.#binding, captured.head.manifest);
    const records = normalize(captured.records, this.#binding);
    if ((!captured.head && records.length) || records.some((r) => r.keyEpoch > (captured.head?.keyEpoch ?? 0))) throw new MemoryError("INVALID_MANIFEST", "Recall records do not match their checkpoint epoch");
    const superseded = new Set(records.flatMap((r) => r.supersedes ? [r.supersedes] : []));
    this.begin();
    try {
      const previous = this.metadata();
      if (previous && ((previous.head?.version ?? 0) > (captured.head?.version ?? 0) || (previous.head?.keyEpoch ?? 0) > (captured.head?.keyEpoch ?? 0))) throw new MemoryError("INDEX_STALE", "Refusing to replace a newer recall checkpoint");
      if (previous && previous.head?.version === captured.head?.version && previous.fingerprint !== fingerprint) throw new MemoryError("INTEGRITY_FAILED", "Same checkpoint version has conflicting content");
      if (previous && previous.fingerprint === fingerprint && previous.recordsDigest !== digest(records)) throw new MemoryError("INTEGRITY_FAILED", "A fixed checkpoint cannot publish different recall records");
      this.#db.exec("DELETE FROM memory_records");
      const insert = this.#db.prepare("INSERT INTO memory_records(id,text,created_at,is_current,record_json) VALUES(?,?,?,?,?)");
      for (const record of records) insert.run(record.id, record.text, record.createdAt, superseded.has(record.id) ? 0 : 1, JSON.stringify(record));
      this.#db.exec("INSERT INTO recall_fts(recall_fts) VALUES('rebuild')");
      this.#db.exec("INSERT INTO recall_fts(recall_fts,rank) VALUES('integrity-check',1)");
      this.#db.prepare("INSERT OR REPLACE INTO memory_meta VALUES(1,?,?,?,?,?)").run(bindingText(this.#binding), JSON.stringify(captured.head), fingerprint, new Date().toISOString(), digest(records));
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    return { version: captured.head?.version ?? 0, recordCount: records.length, currentCount: records.length - superseded.size };
  }
  private verifyRecords(meta: Metadata): RecoveredMemory[] {
    try {
      if (this.#db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("corrupt database");
      const rows = this.#db.prepare("SELECT * FROM memory_records ORDER BY rowid").all();
      const records = normalize(rows.map((row) => JSON.parse(String(row.record_json)) as RecoveredMemory), this.#binding);
      const superseded = new Set(records.flatMap((r) => r.supersedes ? [r.supersedes] : []));
      if (digest(records) !== meta.recordsDigest || rows.some((row, i) => row.id !== records[i]!.id || row.text !== records[i]!.text || row.created_at !== records[i]!.createdAt || Number(row.is_current) !== (superseded.has(records[i]!.id) ? 0 : 1))) throw new Error("corrupt records");
      this.#db.exec("INSERT INTO recall_fts(recall_fts,rank) VALUES('integrity-check',1)");
      return records;
    } catch { throw new MemoryError("INTEGRITY_FAILED", "Recall cache failed integrity checks; rebuild from committed memory"); }
  }
  search(query: string, expectedHead: MemoryHead | null, options: { limit?: number; includeSuperseded?: boolean; now?: Date } = {}): RecallResult {
    // Integrity checks use FTS5's auxiliary command. Serialize this bounded local
    // read with publication so metadata, rows and postings share one snapshot.
    this.begin();
    try { const result = this.searchSnapshot(query, expectedHead, options); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  private searchSnapshot(query: string, expectedHead: MemoryHead | null, options: { limit?: number; includeSuperseded?: boolean; now?: Date }): RecallResult {
    if (typeof query !== "string" || Buffer.byteLength(query) > 512) throw new MemoryError("INVALID_INPUT", "Recall query exceeds its limit");
    const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    const limit = options.limit ?? 8;
    if (terms.length < 1 || terms.length > 16 || terms.some((t) => Buffer.byteLength(t) > 64) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
        (options.includeSuperseded !== undefined && typeof options.includeSuperseded !== "boolean")) throw new MemoryError("INVALID_INPUT", "Invalid recall query or limits");
    const meta = this.metadata();
    if (!meta || meta.fingerprint !== headFingerprint(expectedHead)) throw new MemoryError("INDEX_STALE", "Recall cache is missing or behind the requested finalized checkpoint");
    const records = this.verifyRecords(meta);
    const byId = new Map(records.map((r) => [r.id, r]));
    const sql = `SELECT r.id FROM recall_fts JOIN memory_records r ON r.rowid=recall_fts.rowid WHERE recall_fts MATCH ? ${options.includeSuperseded ? "" : "AND r.is_current=1"} ORDER BY bm25(recall_fts),r.created_at DESC,r.id LIMIT ?`;
    const rows = this.#db.prepare(sql).all(terms.map((term) => `"${term}"`).join(" AND "), limit);
    const now = options.now?.getTime() ?? Date.now();
    if (!Number.isFinite(now)) throw new MemoryError("INVALID_INPUT", "Invalid recall clock");
    return { asOfVersion: meta.head?.version ?? 0, keyEpoch: meta.head?.keyEpoch ?? null, headFingerprint: meta.fingerprint, indexedAt: meta.indexedAt,
      matches: rows.map((row) => {
        const record = byId.get(String(row.id))!;
        const supersededBy = records.filter((r) => r.supersedes === record.id).map((r) => r.id);
        return { ...structuredClone(record), untrusted: true, revisionState: supersededBy.length ? "superseded" : "current", supersededBy,
          citation: { memoryId: record.id, sourceKind: record.source.kind, sourceReference: record.source.reference, createdAt: record.createdAt },
          freshness: { ageSeconds: Math.max(0, Math.floor((now - Date.parse(record.createdAt)) / 1000)), futureTimestamp: Date.parse(record.createdAt) > now } };
      }) };
  }
}
