import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonical } from "../../near/src/protocol.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { sourceUrl } from "./sources.js";
import type { Mission, MissionArtifact, MissionAuthority, MissionBrief, MissionDetail, MissionEvent, MissionLease, MissionScope, MissionSource, MissionState, SourceCapture } from "./types.js";

export const LEASE_MS = 60_000;
export const missionId = (id: unknown): id is string => typeof id === "string" && /^mission:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const uuid = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const fail = () => new ProviderError("INTEGRITY_FAILED", "Mission journal integrity check failed");
const conflict = () => new ProviderError("OPERATION_CONFLICT", "Mission changed, is already running or cannot accept this action");
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
export function validateBrief(input: unknown, origins: readonly string[]): MissionBrief {
  if (!isObject(input) || Object.keys(input).sort().join(",") !== "criteria,objective,requestId,sources,title" || !uuid(input.requestId) ||
    !bounded(input.title, 120) || !bounded(input.objective, 2000) || !bounded(input.criteria, 2000) || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 6) {
    throw new ProviderError("INVALID_INPUT", "Supply a title, objective, review criteria and one to six allowed source URLs");
  }
  const sources = input.sources.map((url) => sourceUrl(url, origins));
  if (new Set(sources).size !== sources.length) throw new ProviderError("INVALID_INPUT", "Source URLs must be unique");
  return { requestId: input.requestId, title: input.title, objective: input.objective, criteria: input.criteria, sources };
}
function authority(value: unknown, scope: MissionScope): asserts value is MissionAuthority {
  if (!isObject(value) || canonical(Object.fromEntries(Object.keys(scope).map((key) => [key, value[key]]))) !== canonical(scope) ||
    typeof value.publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.publicKey) || typeof value.generation !== "string" || !/^[1-9]\d{0,19}$/.test(value.generation) ||
    !Number.isSafeInteger(value.keyEpoch) || Number(value.keyEpoch) < 1 || typeof value.blockHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.blockHash)) throw fail();
}
function validateCapture(value: unknown, url: string): asserts value is SourceCapture {
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "byteLength,capturedAt,contentSha256,contentType,excerpt,title,truncated,untrusted,url" ||
    value.url !== url || !bounded(value.title, 240) || !bounded(value.excerpt, 6000) || typeof value.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.contentSha256) ||
    !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1 || Number(value.byteLength) > 1_000_000 || !Number.isSafeInteger(value.capturedAt) || Number(value.capturedAt) < 1 ||
    !["text/html", "text/plain"].includes(String(value.contentType)) || typeof value.truncated !== "boolean" || value.untrusted !== true) throw fail();
}

/** Private, single-operator SQLite state. Network work never runs inside a DB transaction. */
export class MissionJournal {
  private readonly db: DatabaseSync;
  readonly scope: MissionScope;
  readonly origins: readonly string[];
  constructor(path: string, scope: MissionScope, origins: readonly string[], private readonly now: () => number = Date.now) {
    this.scope = Object.freeze(structuredClone(scope)); this.origins = Object.freeze([...origins]);
    const directory = dirname(resolve(path)); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory); if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)) throw fail();
    const fd = openSync(resolve(path), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const file = lstatSync(resolve(path)); if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw fail();
    this.db = new DatabaseSync(resolve(path));
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
      this.atomic(() => {
        const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
        if (version !== 0 && version !== 1) throw fail();
        if (version === 0) this.db.exec(`
          CREATE TABLE mission_scope (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL) STRICT;
          CREATE TABLE missions (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, brief TEXT NOT NULL, digest TEXT NOT NULL,
            authority TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','interrupted','blocked','awaiting_review','completed','canceled')),
            version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, failure_code TEXT,
            holder TEXT, fence INTEGER NOT NULL DEFAULT 0, lease_until INTEGER) STRICT;
          CREATE TABLE mission_sources (operation_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), ordinal INTEGER NOT NULL,
            url TEXT NOT NULL, request_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','fetching','captured','failed','interrupted','canceled')),
            attempts INTEGER NOT NULL DEFAULT 0, capture TEXT, capture_digest TEXT, failure_code TEXT, UNIQUE(mission_id,ordinal)) STRICT;
          CREATE TABLE mission_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES missions(id), at INTEGER NOT NULL, kind TEXT NOT NULL, operation_id TEXT) STRICT;
          CREATE INDEX events_by_mission ON mission_events(mission_id,cursor);
          CREATE TABLE mission_artifacts (mission_id TEXT PRIMARY KEY REFERENCES missions(id), value TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
          PRAGMA user_version=1;
        `);
        const binding = canonical(scope);
        this.db.prepare("INSERT OR IGNORE INTO mission_scope VALUES(1,?)").run(binding);
        if (this.db.prepare("SELECT binding FROM mission_scope WHERE id=1").get()?.binding !== binding) throw fail();
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private event(id: string, kind: string, operation: string | null = null) {
    if (Number(this.db.prepare("SELECT count(*) AS n FROM mission_events WHERE mission_id=?").get(id)?.n) >= 250) throw conflict();
    this.db.prepare("INSERT INTO mission_events(mission_id,at,kind,operation_id) VALUES(?,?,?,?)").run(id, this.now(), kind, operation);
  }
  private row(id: string) {
    if (!missionId(id)) throw new ProviderError("INVALID_INPUT", "Invalid mission ID");
    const row = this.db.prepare("SELECT * FROM missions WHERE id=?").get(id);
    if (!row) throw new ProviderError("INVALID_INPUT", "Mission is not in this agent's journal");
    return row;
  }
  private readMission(id: string): Mission {
    const row = this.row(id);
    let brief: MissionBrief, auth: MissionAuthority;
    try {
      // Existing records remain readable if the operator later narrows the allowlist.
      const parsed = JSON.parse(String(row.brief)) as MissionBrief;
      brief = validateBrief(parsed, parsed.sources.map((url) => new URL(url).origin));
      auth = JSON.parse(String(row.authority)) as MissionAuthority; authority(auth, this.scope);
      if (digest(brief) !== row.digest || brief.requestId !== row.request_id || !Number.isSafeInteger(row.version) || Number(row.version) < 1) throw fail();
    } catch { throw fail(); }
    const counts = this.db.prepare("SELECT count(*) AS total, sum(state='captured') AS captured FROM mission_sources WHERE mission_id=?").get(id)!;
    if (Number(counts.total) !== brief.sources.length) throw fail();
    return { id, brief, authority: auth, state: row.state as MissionState, version: Number(row.version), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), failureCode: row.failure_code as string | null,
      budget: { network: "near:testnet", asset: "NEAR", maximum: "0", spent: "0" }, sourceCount: Number(counts.total), capturedCount: Number(counts.captured) };
  }
  private readSources(mission: Mission): MissionSource[] {
    return this.db.prepare("SELECT * FROM mission_sources WHERE mission_id=? ORDER BY ordinal").all(mission.id).map((row, index) => {
      let capture: SourceCapture | null = null;
      if (row.capture !== null) { try { capture = JSON.parse(String(row.capture)) as SourceCapture; validateCapture(capture, String(row.url)); } catch { throw fail(); } }
      if (row.ordinal !== index || row.url !== mission.brief.sources[index] || row.operation_id !== `${mission.id}:source:${index}` || row.request_digest !== digest({ kind: "HTTPS_GET", url: row.url }) ||
        (capture && digest(capture) !== row.capture_digest) || (row.state === "captured") !== Boolean(capture) || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 0 || Number(row.attempts) > 3) throw fail();
      return { operationId: String(row.operation_id), requestDigest: String(row.request_digest), ordinal: index, url: String(row.url), state: row.state as MissionSource["state"],
        attempts: Number(row.attempts), capture, failureCode: row.failure_code as string | null };
    });
  }
  private expire(id: string) {
    const row = this.row(id);
    if (row.state === "running" && Number(row.lease_until) <= this.now()) {
      this.db.prepare("UPDATE missions SET state='interrupted',version=version+1,updated_at=?,failure_code='LEASE_EXPIRED',holder=NULL,lease_until=NULL,fence=fence+1 WHERE id=?").run(this.now(), id);
      this.db.prepare("UPDATE mission_sources SET state='interrupted',failure_code='LEASE_EXPIRED' WHERE mission_id=? AND state='fetching'").run(id);
      this.event(id, "worker_interrupted");
    }
  }
  get(id: string): MissionDetail {
    return this.atomic(() => { this.expire(id); return this.detail(id); });
  }
  private detail(id: string): MissionDetail {
    const mission = this.readMission(id), sources = this.readSources(mission);
    const row = this.db.prepare("SELECT * FROM mission_artifacts WHERE mission_id=?").get(id);
    let artifact: MissionDetail["artifact"] = null;
    if (row) {
      try {
        const value = JSON.parse(String(row.value)) as MissionArtifact;
        if (digest(value) !== row.digest || value.missionId !== id || value.title !== mission.brief.title || value.objective !== mission.brief.objective || value.criteria !== mission.brief.criteria ||
          value.kind !== "source-dossier" || value.schemaVersion !== 1 || value.inference !== "not_used" || value.storage !== "local_private_journal" || value.quality !== "owner_review_required" ||
          canonical(value.sources) !== canonical(sources.map((source) => source.capture)) || sources.some((s) => s.state !== "captured")) throw fail();
        artifact = { digest: String(row.digest), value };
      } catch { throw fail(); }
    }
    if (["awaiting_review", "completed"].includes(mission.state) !== Boolean(artifact)) throw fail();
    return { mission, sources, events: this.events(id, 0), artifact };
  }
  events(id: string, after: number): MissionEvent[] {
    this.row(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new ProviderError("INVALID_INPUT", "Invalid mission event cursor");
    return this.db.prepare("SELECT * FROM mission_events WHERE mission_id=? AND cursor>? ORDER BY cursor LIMIT 250").all(id, after).map((r) => ({ cursor: Number(r.cursor), missionId: id, at: Number(r.at), kind: String(r.kind), operationId: r.operation_id as string | null }));
  }
  activity(): MissionEvent[] {
    return this.db.prepare("SELECT * FROM mission_events ORDER BY cursor DESC LIMIT 100").all().map((r) => ({ cursor: Number(r.cursor), missionId: String(r.mission_id), at: Number(r.at), kind: String(r.kind), operationId: r.operation_id as string | null }));
  }
  list(): Mission[] {
    return this.atomic(() => this.db.prepare("SELECT id FROM missions ORDER BY created_at DESC,rowid DESC LIMIT 250").all().map((row) => { const id = String(row.id); this.expire(id); return this.readMission(id); }));
  }
  create(input: unknown, auth: MissionAuthority): MissionDetail {
    const brief = validateBrief(input, this.origins); authority(auth, this.scope);
    return this.atomic(() => {
      const prior = this.db.prepare("SELECT id,digest FROM missions WHERE request_id=?").get(brief.requestId);
      if (prior) { if (prior.digest !== digest(brief)) throw conflict(); return this.detail(String(prior.id)); }
      if (Number(this.db.prepare("SELECT count(*) AS n FROM missions").get()?.n) >= 250) throw conflict();
      const id = `mission:${randomUUID()}`, at = this.now();
      this.db.prepare("INSERT INTO missions(id,request_id,brief,digest,authority,state,version,created_at,updated_at) VALUES(?,?,?,?,?,'queued',1,?,?)").run(id, brief.requestId, canonical(brief), digest(brief), canonical(auth), at, at);
      brief.sources.forEach((url, ordinal) => this.db.prepare("INSERT INTO mission_sources(operation_id,mission_id,ordinal,url,request_digest,state) VALUES(?,?,?,?,?,'queued')").run(`${id}:source:${ordinal}`, id, ordinal, url, digest({ kind: "HTTPS_GET", url })));
      this.event(id, "mission_created"); return this.detail(id);
    });
  }
  claim(id: string, version: number, auth: MissionAuthority, holder: string): MissionLease {
    authority(auth, this.scope);
    if (!uuid(holder)) throw fail();
    return this.atomic(() => {
      this.expire(id); const mission = this.readMission(id);
      if (mission.version !== version || !["queued", "interrupted", "blocked"].includes(mission.state) || this.readSources(mission).some((s) => s.state !== "captured" && s.attempts >= 3)) throw conflict();
      if (Number(this.db.prepare("SELECT count(*) AS n FROM mission_events WHERE mission_id=?").get(id)?.n) >= 200) throw conflict();
      for (const url of mission.brief.sources) sourceUrl(url, this.origins);
      this.db.prepare("UPDATE missions SET state='running',version=version+1,updated_at=?,authority=?,holder=?,fence=fence+1,lease_until=?,failure_code=NULL WHERE id=?").run(this.now(), canonical(auth), holder, this.now() + LEASE_MS, id);
      this.event(id, mission.state === "queued" ? "worker_started" : "worker_resumed");
      return { missionId: id, holder, fence: Number(this.row(id).fence) };
    });
  }
  private guard(lease: MissionLease) {
    const row = this.row(lease.missionId);
    if (row.state !== "running" || row.holder !== lease.holder || row.fence !== lease.fence || Number(row.lease_until) <= this.now()) throw conflict();
  }
  heartbeat(lease: MissionLease) {
    this.atomic(() => { this.guard(lease); this.db.prepare("UPDATE missions SET lease_until=? WHERE id=?").run(this.now() + LEASE_MS, lease.missionId); });
  }
  beginSource(lease: MissionLease, operationId: string): MissionSource {
    return this.atomic(() => {
      this.guard(lease);
      const source = this.readSources(this.readMission(lease.missionId)).find((s) => s.operationId === operationId);
      if (!source || !["queued", "failed", "interrupted"].includes(source.state) || source.attempts >= 3) throw conflict();
      this.db.prepare("UPDATE mission_sources SET state='fetching',attempts=attempts+1,failure_code=NULL WHERE operation_id=?").run(operationId);
      this.event(lease.missionId, "source_fetch_started", operationId);
      return this.readSources(this.readMission(lease.missionId)).find((s) => s.operationId === operationId)!;
    });
  }
  capture(lease: MissionLease, operationId: string, result: SourceCapture) {
    this.atomic(() => {
      this.guard(lease);
      const source = this.readSources(this.readMission(lease.missionId)).find((s) => s.operationId === operationId);
      if (!source || source.state !== "fetching") throw conflict(); validateCapture(result, source.url);
      this.db.prepare("UPDATE mission_sources SET state='captured',capture=?,capture_digest=?,failure_code=NULL WHERE operation_id=?").run(canonical(result), digest(result), operationId);
      this.db.prepare("UPDATE missions SET version=version+1,updated_at=? WHERE id=?").run(this.now(), lease.missionId);
      this.event(lease.missionId, "source_captured", operationId);
    });
  }
  stop(lease: MissionLease, state: "blocked" | "interrupted", code: string) {
    if (!/^[A-Z0-9_]{1,64}$/.test(code)) throw fail();
    this.atomic(() => {
      this.guard(lease);
      this.db.prepare("UPDATE mission_sources SET state=?,failure_code=? WHERE mission_id=? AND state='fetching'").run(state === "blocked" ? "failed" : "interrupted", code, lease.missionId);
      this.db.prepare("UPDATE missions SET state=?,failure_code=?,version=version+1,updated_at=?,holder=NULL,lease_until=NULL,fence=fence+1 WHERE id=?").run(state, code, this.now(), lease.missionId);
      this.event(lease.missionId, state === "blocked" ? "worker_blocked" : "worker_interrupted");
    });
  }
  assemble(lease: MissionLease) {
    this.atomic(() => {
      this.guard(lease); const mission = this.readMission(lease.missionId), sources = this.readSources(mission);
      if (sources.some((s) => !s.capture || s.state !== "captured")) throw conflict();
      const value: MissionArtifact = { schemaVersion: 1, kind: "source-dossier", missionId: mission.id, title: mission.brief.title, objective: mission.brief.objective, criteria: mission.brief.criteria,
        createdAt: this.now(), sources: sources.map((s) => s.capture!), inference: "not_used", storage: "local_private_journal", quality: "owner_review_required" };
      this.db.prepare("INSERT INTO mission_artifacts VALUES(?,?,?)").run(mission.id, canonical(value), digest(value));
      this.db.prepare("UPDATE missions SET state='awaiting_review',version=version+1,updated_at=?,holder=NULL,lease_until=NULL,fence=fence+1 WHERE id=?").run(this.now(), mission.id);
      this.event(mission.id, "artifact_ready");
    });
  }
  cancel(id: string, version: number): MissionDetail {
    return this.atomic(() => {
      this.expire(id); const mission = this.readMission(id);
      if (mission.state === "canceled" && mission.version === version + 1) return this.detail(id);
      if (version !== mission.version || ["completed", "canceled", "awaiting_review"].includes(mission.state)) throw conflict();
      this.db.prepare("UPDATE missions SET state='canceled',version=version+1,updated_at=?,holder=NULL,lease_until=NULL,fence=fence+1 WHERE id=?").run(this.now(), id);
      this.db.prepare("UPDATE mission_sources SET state='canceled' WHERE mission_id=? AND state!='captured'").run(id);
      this.event(id, "mission_canceled"); return this.detail(id);
    });
  }
  approve(id: string, version: number, artifactDigest: string): MissionDetail {
    return this.atomic(() => {
      const detail = this.detail(id);
      if (detail.mission.state === "completed" && detail.mission.version === version + 1 && detail.artifact?.digest === artifactDigest) return detail;
      if (detail.mission.version !== version || detail.mission.state !== "awaiting_review" || detail.artifact?.digest !== artifactDigest) throw conflict();
      this.db.prepare("UPDATE missions SET state='completed',version=version+1,updated_at=? WHERE id=?").run(this.now(), id);
      this.event(id, "owner_approved"); return this.detail(id);
    });
  }
}
