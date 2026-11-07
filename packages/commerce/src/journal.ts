import { constants, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonical, hash } from "../../near/src/protocol.js";
import { ProviderError } from "../../protocol/src/providers.js";
import type { MissionScope } from "../../runtime/src/types.js";
import { commissionId } from "./protocol.js";
import type { CommissionRecord, CommissionView } from "./types.js";

const bad = () => new ProviderError("INTEGRITY_FAILED", "Commission journal identity or immutable content differs");
const core = (r: CommissionRecord) => ({ id: r.id, missionId: r.missionId, profile: r.profile, brief: r.brief, maximumYoctoNear: r.maximumYoctoNear, ownerKey: r.ownerKey, preparation: r.preparation });
const allowed: Record<CommissionRecord["state"], CommissionRecord["state"][]> = {
  preparing: ["awaiting_quote", "canceled"], awaiting_quote: ["quoted", "canceled"], quoted: ["uploading_brief", "canceled"], uploading_brief: ["brief_ready"],
  brief_ready: ["reserving", "canceled"], reserving: ["funded", "failed", "delivery_ready", "paid", "refunded", "disputed", "payout_pending", "payout_failed"],
  funded: ["delivery_ready", "paid", "refunded", "disputed", "payout_pending", "payout_failed"], delivery_ready: ["settling", "paid", "refunded", "disputed", "payout_pending", "payout_failed"],
  settling: ["paid", "payout_pending", "payout_failed", "disputed", "refunded", "delivery_ready"], payout_pending: ["paid", "payout_failed", "disputed", "refunded"],
  payout_failed: ["paid", "payout_pending", "refunded", "disputed"], paid: [], disputed: ["refunded", "paid", "payout_pending", "payout_failed"], refunded: [], failed: [], canceled: [],
};
export class CommissionJournal {
  private readonly db: DatabaseSync;
  constructor(path: string, readonly scope: MissionScope, private readonly now: () => number = Date.now) {
    const directory = dirname(resolve(path)); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory); if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)) throw bad();
    const fd = openSync(resolve(path), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const file = lstatSync(resolve(path)); if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw bad();
    this.db = new DatabaseSync(resolve(path));
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;");
      this.atomic(() => {
        const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
        if (version !== 0 && version !== 1) throw bad();
        if (!version) this.db.exec(`CREATE TABLE commission_binding(id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL) STRICT;
          CREATE TABLE commissions(id TEXT PRIMARY KEY, mission_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, core_digest TEXT NOT NULL) STRICT;
          PRAGMA user_version=1;`);
        this.db.prepare("INSERT OR IGNORE INTO commission_binding VALUES(1,?)").run(canonical(scope));
        if (this.db.prepare("SELECT binding FROM commission_binding WHERE id=1").get()?.binding !== canonical(scope)) throw bad();
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private atomic<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  count() { return Number(this.db.prepare("SELECT count(*) AS n FROM commissions").get()?.n); }
  findMission(id: string): CommissionRecord | null { const row = this.db.prepare("SELECT id FROM commissions WHERE mission_id=?").get(id); return row ? this.get(String(row.id)) : null; }
  get(id: string): CommissionRecord {
    if (!commissionId(id)) throw new ProviderError("INVALID_INPUT", "Invalid commission ID");
    const row = this.db.prepare("SELECT * FROM commissions WHERE id=?").get(id); if (!row) throw new ProviderError("INVALID_INPUT", "Commission is absent from this agent journal");
    try {
      const r = JSON.parse(String(row.body)) as CommissionRecord;
      if (r.id !== id || r.missionId !== row.mission_id || r.id !== r.missionId.replace("mission:", "commission:") || canonical(r.profile.payload.scope) !== canonical(this.scope) ||
        hash(canonical(r)) !== row.digest || hash(canonical(core(r))) !== row.core_digest || !Object.hasOwn(allowed, r.state) || !Number.isSafeInteger(r.version) || r.version < 1 || !Array.isArray(r.events) || r.events.length > 240) throw bad();
      return r;
    } catch { throw bad(); }
  }
  create(record: CommissionRecord): CommissionRecord {
    return this.atomic(() => {
      const existing = this.findMission(record.missionId);
      if (existing) {
        if (canonical({ brief: existing.brief, maximum: existing.maximumYoctoNear, ownerKey: existing.ownerKey }) !== canonical({ brief: record.brief, maximum: record.maximumYoctoNear, ownerKey: record.ownerKey })) throw bad();
        return existing;
      }
      if (this.count() >= 250 || record.state !== "preparing" || record.version !== 1 || canonical(record.profile.payload.scope) !== canonical(this.scope)) throw bad();
      this.db.prepare("INSERT INTO commissions VALUES(?,?,?,?,?)").run(record.id, record.missionId, canonical(record), hash(canonical(record)), hash(canonical(core(record)))); return this.get(record.id);
    });
  }
  update(id: string, expected: number, mutate: (value: CommissionRecord) => void, event?: string): CommissionRecord {
    return this.atomic(() => {
      const before = this.get(id); if (before.version !== expected) throw new ProviderError("OPERATION_CONFLICT", "Commission changed; refresh the existing outcome");
      const next = structuredClone(before); mutate(next);
      if (canonical(core(next)) !== canonical(core(before)) || (next.state !== before.state && !allowed[before.state].includes(next.state)) ||
        ["task", "quote", "delivery", "request", "signerIdentity", "reviewedDigest", "artifact", "acceptanceCall"].some((key) => before[key as keyof CommissionRecord] !== null && canonical(before[key as keyof CommissionRecord]) !== canonical(next[key as keyof CommissionRecord])) ||
        ["reservationHash", "acceptanceHash", "briefUploadHash"].some((key) => before.receipt[key as keyof CommissionRecord["receipt"]] !== null && before.receipt[key as keyof CommissionRecord["receipt"]] !== next.receipt[key as keyof CommissionRecord["receipt"]])) throw bad();
      if (event) { if (next.events.length >= 230) throw new ProviderError("OPERATION_CONFLICT", "Commission event limit reached"); next.events.push({ at: this.now(), kind: event }); }
      next.version = before.version + 1;
      this.db.prepare("UPDATE commissions SET body=?,digest=? WHERE id=?").run(canonical(next), hash(canonical(next)), id); return this.get(id);
    });
  }
  view(id: string): CommissionView {
    const r = this.get(id), task = r.task ? (({ encryptedBrief: _unused, ...publicTask }) => publicTask)(r.task) : null;
    return { id, missionId: r.missionId, state: r.state, version: r.version, worker: r.profile.payload.accountId, name: r.profile.payload.name, amountYoctoNear: r.quote?.payload.amountYoctoNear ?? r.maximumYoctoNear,
      reviewed: r.reviewedDigest !== null, deliveryVerified: r.artifact !== null && r.delivery !== null, failureCode: r.failureCode, task, quote: r.quote?.payload ?? null,
      quoteDigest: r.quote ? hash(canonical(r.quote)) : null, signatureVerified: r.quote !== null, delivery: r.delivery?.payload ?? null, artifact: r.artifact,
      artifactDigest: r.artifact ? hash(canonical(r.artifact)) : null, receipt: r.receipt, events: r.events };
  }
}
