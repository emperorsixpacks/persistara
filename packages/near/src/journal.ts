import { constants, closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ProviderError } from "../../protocol/src/providers.js";
import { canonical, decimal, hash, operationId, type ContractCall, type NearOutcome, type NearSignerConfig } from "./protocol.js";

export interface Operation {
  id: string; digest: string; call_json: string; nonce: string; block_hash: string;
  state: "allocated" | "prepared" | "submitted" | "unknown" | "confirmed" | "failed";
  signed: string | null; tx_hash: string | null; outcome_json: string | null;
}

/** One journal per agent/runtime key. Transactions contain no asynchronous work. */
export class NearJournal {
  private readonly db: DatabaseSync;
  constructor(path: string, config: NearSignerConfig, create = true) {
    const absolute = resolve(path);
    if (create) mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const directory = statSync(dirname(absolute));
    if ((directory.mode & 0o077) !== 0) throw new ProviderError("NOT_CONFIGURED", "NEAR journal directory must be private");
    const fd = openSync(absolute, (create ? constants.O_CREAT : 0) | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    if ((statSync(absolute).mode & 0o077) !== 0) throw new ProviderError("NOT_CONFIGURED", "NEAR journal file must be private");
    this.db = new DatabaseSync(absolute);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;");
      this.db.exec(`CREATE TABLE IF NOT EXISTS near_binding (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS near_instance (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS near_controls (id INTEGER PRIMARY KEY CHECK(id=1), held_by TEXT) STRICT;
        CREATE TABLE IF NOT EXISTS near_operations (
          id TEXT PRIMARY KEY, digest TEXT NOT NULL, call_json TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, block_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('allocated','prepared','submitted','unknown','confirmed','failed')),
          signed TEXT, tx_hash TEXT, outcome_json TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS near_nonce_order ON near_operations(length(nonce), nonce);`);
      const binding = canonical({ schemaVersion: 1, kind: config.kind, chainId: config.chainId, contractId: config.contractId,
        signerId: config.signerId, publicKey: config.publicKey, agentId: config.agentId, ...(config.runtimeAccountId ? { runtimeAccountId: config.runtimeAccountId } : {}) });
      this.atomic(() => {
        this.db.prepare("INSERT OR IGNORE INTO near_instance VALUES(1,?)").run(randomUUID());
        this.db.exec("INSERT OR IGNORE INTO near_controls VALUES(1,NULL)");
        this.db.prepare("INSERT OR IGNORE INTO near_binding VALUES (1, ?)").run(binding);
        if (this.db.prepare("SELECT binding FROM near_binding WHERE id=1").get()?.binding !== binding) {
          throw new ProviderError("NETWORK_MISMATCH", "Journal belongs to another chain, contract, agent or key");
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  identity(): string {
    const value = this.db.prepare("SELECT identity FROM near_instance WHERE id=1").get()?.identity;
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new ProviderError("INTEGRITY_FAILED", "Signer journal identity is invalid");
    return value;
  }
  holdForRotation(id: string): void {
    if (!operationId(id) || id.length > 64) throw new ProviderError("INVALID_INPUT", "Invalid rotation ID");
    this.atomic(() => {
      const held = this.db.prepare("SELECT held_by FROM near_controls WHERE id=1").get()?.held_by;
      if (held !== null && held !== id) throw new ProviderError("SIGNER_BUSY", "Signer is held by another owner operation");
      if (this.db.prepare("SELECT id FROM near_operations WHERE state NOT IN ('confirmed','failed') LIMIT 1").get()) throw new ProviderError("SIGNER_BUSY", "Reconcile unfinished signer operations before planned rotation");
      this.db.prepare("UPDATE near_controls SET held_by=? WHERE id=1").run(id);
    });
  }
  releaseRotation(id: string): void {
    this.atomic(() => {
      const row = this.db.prepare("SELECT held_by FROM near_controls WHERE id=1").get();
      if (!row || (row.held_by !== id && row.held_by !== null)) throw new ProviderError("SIGNER_BUSY", "Rotation does not own this signer barrier");
      this.db.exec("UPDATE near_controls SET held_by=NULL WHERE id=1");
    });
  }
  private atomic<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get(id: string): Operation | null {
    if (!operationId(id)) throw new ProviderError("INVALID_INPUT", "Invalid NEAR operation ID");
    const row = this.db.prepare("SELECT * FROM near_operations WHERE id=?").get(id);
    return row ? row as unknown as Operation : null;
  }
  assertPayload(row: Operation, call: ContractCall): void {
    if (row.digest !== hash(canonical(call)) || row.call_json !== canonical(call)) {
      throw new ProviderError("OPERATION_CONFLICT", "NEAR operation ID already binds another request");
    }
  }
  allocate(id: string, call: ContractCall, chainNonce: string, blockHash: string): Operation {
    if (!operationId(id) || !decimal(chainNonce)) throw new ProviderError("INVALID_INPUT", "Invalid nonce or operation ID");
    return this.atomic(() => {
      const prior = this.get(id);
      if (prior) { this.assertPayload(prior, call); return prior; }
      if (this.db.prepare("SELECT held_by FROM near_controls WHERE id=1").get()?.held_by !== null) throw new ProviderError("SIGNER_BUSY", "Signer is held for owner rotation");
      if (this.db.prepare("SELECT id FROM near_operations WHERE state NOT IN ('confirmed','failed') LIMIT 1").get()) {
        throw new ProviderError("SIGNER_BUSY", "Reconcile the existing transaction before signing another operation");
      }
      let maximum = BigInt(chainNonce);
      for (const row of this.db.prepare("SELECT nonce FROM near_operations ORDER BY length(nonce) DESC, nonce DESC LIMIT 1").all()) {
        if (typeof row.nonce !== "string" || !decimal(row.nonce)) throw new ProviderError("INTEGRITY_FAILED", "Journal nonce is invalid");
        if (BigInt(row.nonce) > maximum) maximum = BigInt(row.nonce);
      }
      const nonce = String(maximum + 1n);
      if (!decimal(nonce) || BigInt(nonce) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProviderError("INVALID_INPUT", "NEAR nonce exceeds exact JSON integer capacity");
      const json = canonical(call);
      this.db.prepare("INSERT INTO near_operations(id,digest,call_json,nonce,block_hash,state) VALUES(?,?,?,?,?,'allocated')").run(id, hash(json), json, nonce, blockHash);
      return this.get(id)!;
    });
  }
  prepared(id: string, signed: string, transactionHash: string): Operation {
    return this.atomic(() => {
      this.db.prepare("UPDATE near_operations SET signed=?,tx_hash=?,state='prepared' WHERE id=? AND state='allocated'").run(signed, transactionHash, id);
      const row = this.get(id)!;
      if (row.signed !== signed || row.tx_hash !== transactionHash) throw new ProviderError("INTEGRITY_FAILED", "Signed transaction conflicts with the journal");
      return row;
    });
  }
  submitted(id: string): boolean {
    return this.db.prepare("UPDATE near_operations SET state='submitted' WHERE id=? AND state='prepared'").run(id).changes === 1;
  }
  saveOutcome(id: string, outcome: NearOutcome): NearOutcome {
    return this.atomic(() => {
      const row = this.get(id)!;
      if (row.tx_hash !== outcome.transactionHash) throw new ProviderError("INTEGRITY_FAILED", "Outcome belongs to another transaction");
      if (row.state === "confirmed" || row.state === "failed") return JSON.parse(row.outcome_json!) as NearOutcome;
      this.db.prepare("UPDATE near_operations SET state=?,outcome_json=? WHERE id=?").run(outcome.status, canonical(outcome), id);
      return outcome;
    });
  }
}
