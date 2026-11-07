import { constants, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonical, decimal, hash, transactionHash, validateIdentity, type NearSignerConfig } from "../../near/src/protocol.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import type { OwnerOperation, OwnerOperationState, PauseRequest } from "./types.js";

const idValid = (id: string) => /^wallet:[a-f0-9-]{36}$/.test(id);
const fail = () => new ProviderError("INTEGRITY_FAILED", "Owner operation journal is invalid or changed");
export function validatePause(request: PauseRequest, config: NearSignerConfig): void {
  if (!isObject(request) || Object.keys(request).sort().join(",") !== "actions,agentId,expectedGeneration,id,kind,minimumNonce,network,ownerPublicKey,paused,receiverId,schemaVersion,signerId" ||
      request.schemaVersion !== 1 || request.kind !== "OWNER_PAUSE_REQUEST" || !idValid(request.id) ||
      canonical(request.network) !== canonical({ kind: config.kind, chainId: config.chainId }) || request.agentId !== config.agentId || request.signerId !== config.signerId || request.receiverId !== config.contractId ||
      typeof request.ownerPublicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(request.ownerPublicKey) || request.ownerPublicKey === config.publicKey ||
      !decimal(request.expectedGeneration, 64, true) || !Number.isSafeInteger(request.minimumNonce) || request.minimumNonce < 0 || typeof request.paused !== "boolean" ||
      canonical(request.actions) !== canonical([{ type: "FunctionCall", params: { methodName: "set_paused", args: { agent_id: config.agentId, paused: request.paused }, gas: "100000000000000", deposit: "0" } }])) throw fail();
}

/** Owner public intents only. A marked wallet handoff is never dispatched again. */
export class OwnerJournal {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly config: NearSignerConfig, codeHash: string) {
    validateIdentity(config);
    const directory = dirname(resolve(path)); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw fail();
    const fd = openSync(resolve(path), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const file = lstatSync(resolve(path));
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw fail();
    this.db = new DatabaseSync(resolve(path));
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS owner_binding (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS owner_operations (id TEXT PRIMARY KEY, request TEXT NOT NULL, digest TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','unknown','confirmed','failed','canceled')), tx_hash TEXT, failure_code TEXT) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS one_owner_pending ON owner_operations((1)) WHERE state IN ('prepared','dispatched','unknown');
        CREATE TABLE IF NOT EXISTS owner_observations (operation_id TEXT NOT NULL, tx_hash TEXT NOT NULL, PRIMARY KEY(operation_id,tx_hash)) STRICT;`);
      const binding = canonical({ kind: config.kind, chainId: config.chainId, contractId: config.contractId, agentId: config.agentId, signerId: config.signerId, codeHash });
      this.db.prepare("INSERT OR IGNORE INTO owner_binding VALUES(1,?)").run(binding);
      if (this.db.prepare("SELECT binding FROM owner_binding WHERE id=1").get()?.binding !== binding) throw fail();
      this.db.exec("UPDATE owner_operations SET state='unknown' WHERE state='dispatched'");
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private atomic<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get(id: string): OwnerOperation {
    if (!idValid(id)) throw new ProviderError("INVALID_INPUT", "Invalid owner operation ID");
    const row = this.db.prepare("SELECT * FROM owner_operations WHERE id=?").get(id);
    if (!row) throw new ProviderError("INVALID_INPUT", "Owner operation is not in this journal");
    let request: PauseRequest;
    try { request = JSON.parse(String(row.request)) as PauseRequest; validatePause(request, this.config); } catch { throw fail(); }
    if (request.id !== id || hash(canonical(request)) !== row.digest || (row.tx_hash !== null && (typeof row.tx_hash !== "string" || !transactionHash(row.tx_hash))) ||
        (row.failure_code !== null && (typeof row.failure_code !== "string" || !/^[A-Z0-9_]{1,100}$/.test(row.failure_code)))) throw fail();
    const candidateHashes = this.db.prepare("SELECT tx_hash FROM owner_observations WHERE operation_id=? ORDER BY rowid LIMIT 32").all(id).map((candidate) => String(candidate.tx_hash));
    if (candidateHashes.some((candidate) => !transactionHash(candidate))) throw fail();
    return { request, digest: String(row.digest), state: String(row.state) as OwnerOperationState, transactionHash: row.tx_hash as string | null, failureCode: row.failure_code as string | null, candidateHashes };
  }
  pending(): OwnerOperation | null {
    const row = this.db.prepare("SELECT id FROM owner_operations WHERE state IN ('prepared','dispatched','unknown') LIMIT 1").get();
    return row ? this.get(String(row.id)) : null;
  }
  recent(): OwnerOperation[] { return this.db.prepare("SELECT id FROM owner_operations ORDER BY rowid DESC LIMIT 20").all().map((row) => this.get(String(row.id))); }
  prepare(request: PauseRequest): OwnerOperation {
    validatePause(request, this.config);
    return this.atomic(() => {
      const prior = this.pending();
      if (prior) {
        if (prior.state === "prepared" && prior.request.paused === request.paused && prior.request.expectedGeneration === request.expectedGeneration && prior.request.minimumNonce === request.minimumNonce && prior.request.ownerPublicKey === request.ownerPublicKey) return prior;
        throw new ProviderError("OPERATION_CONFLICT", "Resolve the existing owner operation before preparing another");
      }
      if (Number(this.db.prepare("SELECT count(*) AS n FROM owner_operations").get()?.n) >= 1000) throw new ProviderError("OPERATION_CONFLICT", "Owner journal capacity reached");
      this.db.prepare("INSERT INTO owner_operations VALUES(?,?,?,'prepared',NULL,NULL)").run(request.id, canonical(request), hash(canonical(request)));
      return this.get(request.id);
    });
  }
  dispatch(id: string): OwnerOperation {
    return this.atomic(() => {
      const row = this.get(id);
      if (row.state !== "prepared") throw new ProviderError("OUTCOME_UNKNOWN", "The owner wallet was already called; reconcile instead of resending", false, row.transactionHash ?? undefined);
      this.db.prepare("UPDATE owner_operations SET state='dispatched' WHERE id=? AND state='prepared'").run(id);
      return this.get(id);
    });
  }
  cancel(id: string): OwnerOperation {
    return this.atomic(() => {
      if (this.get(id).state !== "prepared") throw new ProviderError("OPERATION_CONFLICT", "Only a request never handed to a wallet can be canceled");
      this.db.prepare("UPDATE owner_operations SET state='canceled' WHERE id=?").run(id); return this.get(id);
    });
  }
  observe(id: string, candidate: string): void {
    if (!transactionHash(candidate)) throw new ProviderError("INVALID_INPUT", "Invalid wallet transaction hash");
    this.atomic(() => {
      const row = this.get(id);
      if (!["dispatched", "unknown"].includes(row.state)) throw new ProviderError("OPERATION_CONFLICT", "Operation is not awaiting a wallet outcome");
      if (row.transactionHash && row.transactionHash !== candidate) throw new ProviderError("OPERATION_CONFLICT", "A matching transaction is already bound to this operation");
      if (Number(this.db.prepare("SELECT count(*) AS n FROM owner_observations WHERE operation_id=?").get(id)?.n) >= 32 && !this.db.prepare("SELECT 1 FROM owner_observations WHERE operation_id=? AND tx_hash=?").get(id, candidate)) throw new ProviderError("OPERATION_CONFLICT", "Too many candidate transaction hashes");
      this.db.prepare("INSERT OR IGNORE INTO owner_observations VALUES(?,?)").run(id, candidate);
      this.db.prepare("UPDATE owner_operations SET state='unknown' WHERE id=?").run(id);
    });
  }
  finish(id: string, candidate: string, status: "unknown" | "confirmed" | "failed", failureCode: string | null = null): OwnerOperation {
    return this.atomic(() => {
      const row = this.get(id);
      if (!transactionHash(candidate) || (row.transactionHash && row.transactionHash !== candidate)) throw fail();
      if (["confirmed", "failed"].includes(row.state)) return row;
      if (!["dispatched", "unknown"].includes(row.state)) throw fail();
      this.db.prepare("UPDATE owner_operations SET state=?,tx_hash=?,failure_code=? WHERE id=?").run(status, candidate, failureCode, id);
      return this.get(id);
    });
  }
}
