import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, ToolCall } from "../../inference/src/provider.js";
import { isIdentifier, isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { DEFAULT_CAPS, type Attempt, type CompletedAttempt, type ConversationCaps, type ConversationScope, type SessionDetail, type SessionSummary, type StoredMessage, type ToolAction, type Turn, type TurnLease, type TurnState } from "./types.js";

export const LEASE_MS = 60_000;
export const MAX_SESSIONS = 250;
export const MAX_TURNS = 200;
export const MAX_MESSAGES = 512;
export const MAX_USER_CHARS = 8_000;
export const MAX_ASSISTANT_BYTES = 128_000;
export const MAX_TOOL_RESULT_BYTES = 16_384;

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const prefixed = (prefix: string) => (id: unknown): id is string => typeof id === "string" && new RegExp(`^${prefix}:${UUID}$`).test(id);
export const sessionId = prefixed("session");
export const turnId = prefixed("turn");
export const attemptId = prefixed("attempt");
export const toolActionId = prefixed("tool");
const uuid = (id: unknown): id is string => typeof id === "string" && new RegExp(`^${UUID}$`).test(id);
const fail = () => new ProviderError("INTEGRITY_FAILED", "Conversation journal integrity check failed");
const conflict = () => new ProviderError("OPERATION_CONFLICT", "Conversation changed, is already running or cannot accept this action");
const invalid = (message: string) => new ProviderError("INVALID_INPUT", message);

/** Deterministic JSON for digests. Unlike mission canonical JSON it accepts finite model-supplied numbers. */
export function stable(value: unknown, depth = 0): string {
  if (depth > 16) throw invalid("Value is nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw invalid("Numbers must be finite"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map((item) => stable(item, depth + 1)).join(",")}]`;
  if (isObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key], depth + 1)}`).join(",")}}`;
  }
  throw invalid("Unsupported value type");
}
export const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function normalizeUserText(text: unknown): string {
  if (typeof text !== "string") throw invalid("Message must be text");
  const value = text.replace(/\r\n?/g, "\n").trim();
  if (!value || value.length > MAX_USER_CHARS || CONTROL.test(value)) throw invalid(`Message must be 1-${MAX_USER_CHARS} characters without control characters`);
  return value;
}
function validateCaps(caps: ConversationCaps): ConversationCaps {
  const ok = isObject(caps) && Object.keys(caps).sort().join(",") === "messages,outputTokens,requestBytes,rounds,toolsPerRound" &&
    Number.isSafeInteger(caps.rounds) && caps.rounds >= 1 && caps.rounds <= 8 && Number.isSafeInteger(caps.toolsPerRound) && caps.toolsPerRound >= 0 && caps.toolsPerRound <= 8 &&
    Number.isSafeInteger(caps.outputTokens) && caps.outputTokens >= 1 && caps.outputTokens <= 4096 && Number.isSafeInteger(caps.messages) && caps.messages >= 1 && caps.messages <= 128 &&
    Number.isSafeInteger(caps.requestBytes) && caps.requestBytes >= 1 && caps.requestBytes <= 256_000;
  if (!ok) throw invalid("Invalid conversation caps");
  return { rounds: caps.rounds, toolsPerRound: caps.toolsPerRound, outputTokens: caps.outputTokens, messages: caps.messages, requestBytes: caps.requestBytes };
}

/** Provider-valid ordering: tool results immediately follow their assistant call and none may remain unresolved at a turn boundary. */
export function assertHistoryOrder(messages: readonly ChatMessage[], allowPendingTail = false): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (pending.size && message.role !== "tool") throw fail();
    if (message.role === "assistant" && message.toolCalls?.length) for (const call of message.toolCalls) { if (pending.has(call.id)) throw fail(); pending.add(call.id); }
    if (message.role === "tool" && !pending.delete(message.toolCallId)) throw fail();
  }
  if (pending.size && !allowPendingTail) throw fail();
}

function validateMessage(message: ChatMessage): ChatMessage {
  if (!isObject(message)) throw fail();
  if (message.role === "user") { if (typeof message.content !== "string" || message.content.length > MAX_USER_CHARS) throw fail(); return { role: "user", content: message.content }; }
  if (message.role === "assistant") {
    if (!(typeof message.content === "string" || message.content === null) || (message.content !== null && Buffer.byteLength(message.content) > MAX_ASSISTANT_BYTES)) throw fail();
    const calls = message.toolCalls;
    if (calls === undefined) return { role: "assistant", content: message.content };
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > 16 || calls.some((call) => !isObject(call) || !isIdentifier(call.id) || !isIdentifier(call.name) || !isObject(call.arguments))) throw fail();
    return { role: "assistant", content: message.content, toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: structuredClone(call.arguments) })) };
  }
  if (message.role === "tool") { if (!isIdentifier(message.toolCallId) || typeof message.content !== "string" || Buffer.byteLength(message.content) > MAX_TOOL_RESULT_BYTES) throw fail(); return { role: "tool", toolCallId: message.toolCallId, content: message.content }; }
  throw fail();
}

/** Private owner-runtime chat state. Not a memory checkpoint and not part of any current backup kit. Network work never runs inside a DB transaction. */
export class ConversationJournal {
  private readonly db: DatabaseSync;
  readonly scope: ConversationScope;
  constructor(path: string, scope: ConversationScope, private readonly now: () => number = Date.now) {
    this.scope = Object.freeze(structuredClone(scope));
    if (!isObject(scope) || Object.keys(scope).sort().join(",") !== "agentId,chainId,codeHash,contractId,owner" || Object.values(scope).some((value) => typeof value !== "string" || !value || value.length > 256)) throw invalid("Invalid conversation scope");
    const absolute = resolve(path), directory = dirname(absolute); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory); if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)) throw fail();
    closeSync(openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600));
    const file = lstatSync(absolute); if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw fail();
    this.db = new DatabaseSync(absolute);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
      this.atomic(() => {
        const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
        if (![0, 1].includes(version)) throw fail();
        if (version === 0) this.db.exec(`
          CREATE TABLE conversation_scope (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL) STRICT;
          CREATE TABLE sessions (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            version INTEGER NOT NULL, holder TEXT, fence INTEGER NOT NULL DEFAULT 0, lease_until INTEGER) STRICT;
          CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), ordinal INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('active','completed','limited','context_limit','failed','unknown')), version INTEGER NOT NULL, caps TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, failure_code TEXT, UNIQUE(session_id,ordinal)) STRICT;
          CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id), ordinal INTEGER NOT NULL, turn_id TEXT NOT NULL REFERENCES turns(id), body TEXT NOT NULL, body_digest TEXT NOT NULL,
            PRIMARY KEY(session_id,ordinal)) STRICT;
          CREATE TABLE attempts (operation_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id), round INTEGER NOT NULL, request_digest TEXT NOT NULL, model TEXT NOT NULL,
            max_output_tokens INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','dispatched','completed','failed','unknown')), completion_id TEXT, finish_reason TEXT,
            usage TEXT, evidence_digest TEXT, failure_code TEXT, UNIQUE(turn_id,round)) STRICT;
          CREATE TABLE tool_actions (operation_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id), attempt_id TEXT NOT NULL REFERENCES attempts(operation_id), call_id TEXT NOT NULL,
            name TEXT NOT NULL, arguments_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','completed','failed')), outcome TEXT, outcome_digest TEXT, UNIQUE(turn_id,call_id)) STRICT;
          PRAGMA user_version=1;
        `);
        const binding = stable(scope);
        this.db.prepare("INSERT OR IGNORE INTO conversation_scope VALUES(1,?)").run(binding);
        if (this.db.prepare("SELECT binding FROM conversation_scope WHERE id=1").get()?.binding !== binding) throw fail();
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { if (this.db.isOpen) this.db.close(); }
  private atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  // ---- sessions ----
  private sessionRow(id: string) {
    if (!sessionId(id)) throw invalid("Invalid session ID");
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
    if (!row) throw invalid("Session is not in this agent's journal");
    return row;
  }
  private summary(id: string): SessionSummary {
    const row = this.sessionRow(id);
    if (typeof row.title !== "string" || row.title.length < 1 || row.title.length > 120 || !Number.isSafeInteger(row.version) || Number(row.version) < 1) throw fail();
    return { id, title: row.title, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), version: Number(row.version), turnCount: Number(this.db.prepare("SELECT count(*) AS n FROM turns WHERE session_id=?").get(id)?.n) };
  }
  createSession(requestId: string, title = "New session"): SessionSummary {
    if (!uuid(requestId)) throw invalid("Session request ID must be a UUID v4");
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 120 || CONTROL.test(clean)) throw invalid("Session title must be 1-120 plain characters");
    return this.atomic(() => {
      const prior = this.db.prepare("SELECT id,title FROM sessions WHERE request_id=?").get(requestId);
      if (prior) { if (prior.title !== clean) throw conflict(); return this.summary(String(prior.id)); }
      if (Number(this.db.prepare("SELECT count(*) AS n FROM sessions").get()?.n) >= MAX_SESSIONS) throw conflict();
      const id = `session:${randomUUID()}`, at = this.now();
      this.db.prepare("INSERT INTO sessions(id,request_id,title,created_at,updated_at,version) VALUES(?,?,?,?,?,1)").run(id, requestId, clean, at, at);
      return this.summary(id);
    });
  }
  listSessions(): SessionSummary[] {
    return this.atomic(() => { this.expireAll(); return this.db.prepare("SELECT id FROM sessions ORDER BY updated_at DESC,rowid DESC LIMIT 250").all().map((row) => this.summary(String(row.id))); });
  }
  get(id: string): SessionDetail { return this.atomic(() => { this.expireAll(); return this.detail(id); }); }

  // ---- expiry: positive evidence only; a dispatched attempt becomes outcome-unknown, never a retry ----
  private expireAll() {
    const expired = this.db.prepare("SELECT id FROM sessions WHERE holder IS NOT NULL AND lease_until<=?").all(this.now());
    for (const row of expired) {
      const turn = this.db.prepare("SELECT id FROM turns WHERE session_id=? AND state='active'").get(String(row.id));
      if (!turn) throw fail();
      const dispatched = Number(this.db.prepare("SELECT count(*) AS n FROM attempts WHERE turn_id=? AND state='dispatched'").get(String(turn.id))?.n) > 0;
      this.closeTurn(String(row.id), String(turn.id), dispatched ? "unknown" : "failed", dispatched ? "OUTCOME_UNKNOWN" : "LEASE_EXPIRED");
    }
  }
  private closeTurn(session: string, turn: string, state: Exclude<TurnState, "active">, code: string | null) {
    this.db.prepare("UPDATE attempts SET state='unknown',failure_code='OUTCOME_UNKNOWN' WHERE turn_id=? AND state='dispatched'").run(turn);
    this.db.prepare("UPDATE attempts SET state='failed',failure_code=? WHERE turn_id=? AND state='queued'").run(code ?? "TURN_ENDED", turn);
    for (const action of this.db.prepare("SELECT operation_id,call_id FROM tool_actions WHERE turn_id=? AND state='queued' ORDER BY rowid").all(turn)) {
      this.settleTool(session, turn, String(action.operation_id), String(action.call_id), "failed", { error: "TURN_INTERRUPTED" });
    }
    this.db.prepare("UPDATE turns SET state=?,failure_code=?,version=version+1,updated_at=? WHERE id=?").run(state, code, this.now(), turn);
    this.db.prepare("UPDATE sessions SET holder=NULL,lease_until=NULL,fence=fence+1,version=version+1,updated_at=? WHERE id=?").run(this.now(), session);
  }

  // ---- reading with integrity checks ----
  private caps(raw: unknown): ConversationCaps {
    try { return validateCaps(JSON.parse(String(raw)) as ConversationCaps); } catch { throw fail(); }
  }
  private turns(id: string): Turn[] {
    return this.db.prepare("SELECT * FROM turns WHERE session_id=? ORDER BY ordinal").all(id).map((row, index) => {
      if (row.ordinal !== index || !turnId(row.id) || !uuid(row.request_id) || !sha(row.request_digest) || !Number.isSafeInteger(row.version) || Number(row.version) < 1) throw fail();
      return { id: String(row.id), sessionId: id, ordinal: index, requestId: String(row.request_id), state: row.state as TurnState, version: Number(row.version), caps: this.caps(row.caps),
        createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), failureCode: row.failure_code as string | null };
    });
  }
  private messages(id: string): StoredMessage[] {
    return this.db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY ordinal").all(id).map((row, index) => {
      let message: ChatMessage;
      try { message = validateMessage(JSON.parse(String(row.body)) as ChatMessage); } catch { throw fail(); }
      if (row.ordinal !== index || digest(message) !== row.body_digest || stable(message) !== row.body) throw fail();
      return { ordinal: index, turnId: String(row.turn_id), message };
    });
  }
  private attempts(id: string): Attempt[] {
    return this.db.prepare("SELECT a.* FROM attempts a JOIN turns t ON t.id=a.turn_id WHERE t.session_id=? ORDER BY t.ordinal,a.round").all(id).map((row) => {
      let usage: Attempt["usage"] = null;
      if (row.usage !== null) { try { usage = JSON.parse(String(row.usage)) as Attempt["usage"]; } catch { throw fail(); } }
      const terminal = row.state === "completed";
      if (!attemptId(row.operation_id) || !sha(row.request_digest) || !Number.isSafeInteger(row.round) || Number(row.round) < 1 || typeof row.model !== "string" || !row.model ||
        (terminal && (typeof row.completion_id !== "string" || !sha(row.evidence_digest) || !usage || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || !["stop", "tool_calls", "length"].includes(String(row.finish_reason)))) ||
        (!terminal && row.completion_id !== null)) throw fail();
      return { operationId: String(row.operation_id), turnId: String(row.turn_id), round: Number(row.round), requestDigest: String(row.request_digest), model: String(row.model),
        maxOutputTokens: Number(row.max_output_tokens), state: row.state as Attempt["state"], completionId: row.completion_id as string | null, finishReason: row.finish_reason as Attempt["finishReason"],
        usage, evidenceDigest: row.evidence_digest as string | null, failureCode: row.failure_code as string | null };
    });
  }
  private tools(id: string): ToolAction[] {
    return this.db.prepare("SELECT x.* FROM tool_actions x JOIN turns t ON t.id=x.turn_id WHERE t.session_id=? ORDER BY t.ordinal,x.rowid").all(id).map((row) => {
      let outcome: unknown = null;
      if (row.outcome !== null) { try { outcome = JSON.parse(String(row.outcome)); } catch { throw fail(); } }
      if (!toolActionId(row.operation_id) || !sha(row.arguments_digest) || (row.state === "queued") !== (row.outcome === null) || (row.outcome !== null && (digest(outcome) !== row.outcome_digest || stable(outcome) !== row.outcome))) throw fail();
      return { operationId: String(row.operation_id), turnId: String(row.turn_id), attemptId: String(row.attempt_id), callId: String(row.call_id), name: String(row.name),
        argumentsDigest: String(row.arguments_digest), state: row.state as ToolAction["state"], outcome, outcomeDigest: row.outcome_digest as string | null };
    });
  }
  private detail(id: string): SessionDetail {
    const session = this.summary(id), turns = this.turns(id), messages = this.messages(id), attempts = this.attempts(id), toolActions = this.tools(id);
    const active = turns.filter((turn) => turn.state === "active");
    const row = this.sessionRow(id);
    if (active.length > 1 || (row.holder !== null) !== (active.length === 1) || turns.slice(0, -1).some((turn) => turn.state === "active")) throw fail();
    assertHistoryOrder(messages.map((entry) => entry.message), active.length === 1);
    // Every turn begins with exactly one user message; assistant tool calls are matched by recorded actions.
    for (const turn of turns) {
      const own = messages.filter((entry) => entry.turnId === turn.id);
      if (own[0]?.message.role !== "user" || own.slice(1).some((entry) => entry.message.role === "user" || entry.message.role === "system")) throw fail();
      if (turn.state !== "active") assertHistoryOrder(own.map((entry) => entry.message));
      if (digest({ sessionId: id, text: (own[0]!.message as { content: string }).content }) !== this.db.prepare("SELECT request_digest FROM turns WHERE id=?").get(turn.id)?.request_digest) throw fail();
    }
    for (const action of toolActions) {
      const assistant = messages.find((entry) => entry.turnId === action.turnId && entry.message.role === "assistant" && entry.message.toolCalls?.some((call) => call.id === action.callId));
      const call = assistant && assistant.message.role === "assistant" ? assistant.message.toolCalls?.find((item) => item.id === action.callId) : undefined;
      if (!call || call.name !== action.name || digest(call.arguments) !== action.argumentsDigest) throw fail();
      const result = messages.find((entry) => entry.message.role === "tool" && entry.turnId === action.turnId && entry.message.toolCallId === action.callId);
      if ((action.state !== "queued") !== Boolean(result)) throw fail();
    }
    return { session, turns, messages, attempts, toolActions };
  }

  // ---- turns ----
  private append(session: string, turn: string, message: ChatMessage) {
    const checked = validateMessage(message);
    const count = Number(this.db.prepare("SELECT count(*) AS n FROM messages WHERE session_id=?").get(session)?.n);
    if (count >= MAX_MESSAGES) throw conflict();
    this.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(session, count, turn, stable(checked), digest(checked));
  }
  /**
   * Starts one turn: stores the immutable user message and takes the session's fenced lease.
   * A prior unknown paid attempt fences the session; it is never resubmitted automatically.
   */
  beginTurn(session: string, requestId: string, text: string, holder: string, caps: ConversationCaps = DEFAULT_CAPS): { turn: Turn; lease: TurnLease | null } {
    if (!uuid(requestId) || !uuid(holder)) throw invalid("Turn request and holder IDs must be UUID v4 values");
    const content = normalizeUserText(text), checked = validateCaps(caps), requestDigest = digest({ sessionId: session, text: content });
    return this.atomic(() => {
      this.expireAll(); this.sessionRow(session);
      const prior = this.db.prepare("SELECT id,request_digest,session_id,state FROM turns WHERE request_id=?").get(requestId);
      if (prior) {
        if (prior.request_digest !== requestDigest || prior.session_id !== session || prior.state === "active") throw conflict();
        return { turn: this.turns(session).find((turn) => turn.id === prior.id)!, lease: null };
      }
      const row = this.sessionRow(session);
      if (row.holder !== null || Number(this.db.prepare("SELECT count(*) AS n FROM turns WHERE session_id=? AND state='unknown'").get(session)?.n) > 0) throw conflict();
      const ordinal = Number(this.db.prepare("SELECT count(*) AS n FROM turns WHERE session_id=?").get(session)?.n);
      if (ordinal >= MAX_TURNS) throw conflict();
      const id = `turn:${randomUUID()}`, at = this.now(), fence = Number(row.fence) + 1;
      this.db.prepare("INSERT INTO turns(id,session_id,ordinal,request_id,request_digest,state,version,caps,created_at,updated_at) VALUES(?,?,?,?,?,'active',1,?,?,?)").run(id, session, ordinal, requestId, requestDigest, stable(checked), at, at);
      this.append(session, id, { role: "user", content });
      this.db.prepare("UPDATE sessions SET holder=?,fence=?,lease_until=?,version=version+1,updated_at=? WHERE id=?").run(holder, fence, at + LEASE_MS, at, session);
      return { turn: this.turns(session)[ordinal]!, lease: { sessionId: session, turnId: id, holder, fence } };
    });
  }
  private guard(lease: TurnLease) {
    const row = this.sessionRow(lease.sessionId);
    const turn = this.db.prepare("SELECT state FROM turns WHERE id=? AND session_id=?").get(lease.turnId, lease.sessionId);
    if (row.holder !== lease.holder || row.fence !== lease.fence || Number(row.lease_until) <= this.now() || turn?.state !== "active") throw conflict();
    return this.caps(this.db.prepare("SELECT caps FROM turns WHERE id=?").get(lease.turnId)?.caps);
  }
  heartbeat(lease: TurnLease) {
    this.atomic(() => { this.guard(lease); this.db.prepare("UPDATE sessions SET lease_until=? WHERE id=?").run(this.now() + LEASE_MS, lease.sessionId); });
  }
  /** Validated history for the next provider request; never drops messages. */
  history(lease: TurnLease): ChatMessage[] {
    return this.atomic(() => { this.guard(lease); return this.messages(lease.sessionId).map((entry) => entry.message); });
  }

  // ---- inference attempts ----
  /** Persists intent (digest, model, caps) before dispatch. */
  queueAttempt(lease: TurnLease, input: { round: number; requestDigest: string; model: string; maxOutputTokens: number }): Attempt {
    if (!sha(input.requestDigest) || typeof input.model !== "string" || !input.model || input.model.length > 128 || CONTROL.test(input.model) || !Number.isSafeInteger(input.round) || !Number.isSafeInteger(input.maxOutputTokens)) throw invalid("Invalid inference attempt");
    return this.atomic(() => {
      const caps = this.guard(lease);
      const previous = this.db.prepare("SELECT round,state,operation_id FROM attempts WHERE turn_id=? ORDER BY round DESC LIMIT 1").get(lease.turnId);
      const expected = previous ? Number(previous.round) + 1 : 1;
      if (input.round !== expected || input.round > caps.rounds || input.maxOutputTokens < 1 || input.maxOutputTokens > caps.outputTokens) throw conflict();
      if (previous && (previous.state !== "completed" || Number(this.db.prepare("SELECT count(*) AS n FROM tool_actions WHERE attempt_id=? AND state='queued'").get(String(previous.operation_id))?.n) > 0)) throw conflict();
      const id = `attempt:${randomUUID()}`;
      this.db.prepare("INSERT INTO attempts(operation_id,turn_id,round,request_digest,model,max_output_tokens,state) VALUES(?,?,?,?,?,?,'queued')").run(id, lease.turnId, input.round, input.requestDigest, input.model, input.maxOutputTokens);
      return this.attempts(lease.sessionId).find((attempt) => attempt.operationId === id)!;
    });
  }
  /** After this commits a provider may have been reached; a crash from here on is outcome-unknown. */
  dispatchAttempt(lease: TurnLease, operationId: string) {
    this.atomic(() => {
      this.guard(lease);
      const result = this.db.prepare("UPDATE attempts SET state='dispatched' WHERE operation_id=? AND turn_id=? AND state='queued'").run(operationId, lease.turnId);
      if (result.changes !== 1) throw conflict();
    });
  }
  /**
   * Records the verified result and the assistant message together. Tool calls become queued actions;
   * an over-cap batch is recorded but every call is rejected unexecuted and the turn ends limited.
   */
  completeAttempt(lease: TurnLease, operationId: string, result: CompletedAttempt): { actions: ToolAction[]; batchRejected: boolean } {
    if (!isObject(result) || typeof result.id !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(result.id) || typeof result.text !== "string" || !sha(result.evidenceDigest) || !["stop", "tool_calls", "length"].includes(result.finishReason) ||
      !isObject(result.usage) || !Number.isSafeInteger(result.usage.inputTokens) || result.usage.inputTokens < 0 || !Number.isSafeInteger(result.usage.outputTokens) || result.usage.outputTokens < 0 ||
      !Array.isArray(result.toolCalls) || (result.toolCalls.length > 0) !== (result.finishReason === "tool_calls")) throw invalid("Invalid completed inference result");
    const assistant = validateMessage({ role: "assistant", content: result.text === "" && result.toolCalls.length ? null : result.text, ...(result.toolCalls.length ? { toolCalls: result.toolCalls as ToolCall[] } : {}) });
    return this.atomic(() => {
      const caps = this.guard(lease);
      const attempt = this.db.prepare("SELECT state FROM attempts WHERE operation_id=? AND turn_id=?").get(operationId, lease.turnId);
      if (attempt?.state !== "dispatched") throw conflict();
      const known = new Set(this.db.prepare("SELECT call_id FROM tool_actions WHERE turn_id=?").all(lease.turnId).map((row) => String(row.call_id)));
      if (result.toolCalls.some((call) => known.has(call.id))) throw conflict();
      this.db.prepare("UPDATE attempts SET state='completed',completion_id=?,finish_reason=?,usage=?,evidence_digest=?,failure_code=NULL WHERE operation_id=?")
        .run(result.id, result.finishReason, stable(result.usage), result.evidenceDigest, operationId);
      this.append(lease.sessionId, lease.turnId, assistant);
      const ids: string[] = [];
      for (const call of result.toolCalls) {
        const id = `tool:${randomUUID()}`; ids.push(id);
        this.db.prepare("INSERT INTO tool_actions(operation_id,turn_id,attempt_id,call_id,name,arguments_digest,state) VALUES(?,?,?,?,?,?,'queued')").run(id, lease.turnId, operationId, call.id, call.name, digest(call.arguments));
      }
      const batchRejected = result.toolCalls.length > caps.toolsPerRound;
      if (batchRejected) {
        result.toolCalls.forEach((call, index) => this.settleTool(lease.sessionId, lease.turnId, ids[index]!, call.id, "failed", { error: "TOOL_BATCH_LIMIT" }));
        this.closeTurn(lease.sessionId, lease.turnId, "limited", "TOOL_BATCH_LIMIT");
      }
      return { actions: this.tools(lease.sessionId).filter((action) => ids.includes(action.operationId)), batchRejected };
    });
  }
  /**
   * `not_submitted` is only for positive evidence that the provider never received the request; `rejected_reply` means a
   * reply arrived and was refused locally (the request was submitted, so it is never retried). Anything else after dispatch is
   * `unknown`: it fences the session and its cost is never recorded as zero.
   */
  failAttempt(lease: TurnLease, operationId: string, code: string, disposition: "not_submitted" | "rejected_reply" | "unknown"): "failed" | "unknown" {
    if (!/^[A-Z0-9_]{1,64}$/.test(code)) throw invalid("Invalid failure code");
    return this.atomic(() => {
      this.guard(lease);
      const attempt = this.db.prepare("SELECT state FROM attempts WHERE operation_id=? AND turn_id=?").get(operationId, lease.turnId);
      if (attempt?.state !== "queued" && attempt?.state !== "dispatched") throw conflict();
      const unknown = attempt.state === "dispatched" && disposition === "unknown";
      this.db.prepare("UPDATE attempts SET state=?,failure_code=? WHERE operation_id=?").run(unknown ? "unknown" : "failed", unknown ? "OUTCOME_UNKNOWN" : code, operationId);
      this.closeTurn(lease.sessionId, lease.turnId, unknown ? "unknown" : "failed", unknown ? "OUTCOME_UNKNOWN" : code);
      return unknown ? "unknown" : "failed";
    });
  }

  // ---- tools ----
  private settleTool(session: string, turn: string, operationId: string, callId: string, state: "completed" | "failed", outcome: unknown) {
    const serialized = stable(outcome);
    if (Buffer.byteLength(serialized) > MAX_TOOL_RESULT_BYTES) throw invalid("Tool result exceeds its limit");
    this.db.prepare("UPDATE tool_actions SET state=?,outcome=?,outcome_digest=? WHERE operation_id=? AND state='queued'").run(state, serialized, digest(outcome), operationId);
    this.append(session, turn, { role: "tool", toolCallId: callId, content: serialized });
  }
  /** Idempotent: re-observing a settled action returns its recorded outcome; a different outcome or arguments conflict. */
  recordToolResult(lease: TurnLease, operationId: string, argumentsDigest: string, state: "completed" | "failed", outcome: unknown): ToolAction {
    if (!toolActionId(operationId) || !sha(argumentsDigest)) throw invalid("Invalid tool action");
    return this.atomic(() => {
      this.guard(lease);
      const row = this.db.prepare("SELECT * FROM tool_actions WHERE operation_id=? AND turn_id=?").get(operationId, lease.turnId);
      if (!row || row.arguments_digest !== argumentsDigest) throw conflict();
      if (row.state === "queued") this.settleTool(lease.sessionId, lease.turnId, operationId, String(row.call_id), state, outcome);
      else if (row.state !== state || row.outcome_digest !== digest(outcome)) throw conflict();
      return this.tools(lease.sessionId).find((action) => action.operationId === operationId)!;
    });
  }
  pendingTools(lease: TurnLease): ToolAction[] {
    return this.atomic(() => { this.guard(lease); return this.tools(lease.sessionId).filter((action) => action.turnId === lease.turnId && action.state === "queued"); });
  }
  /** Tool-call arguments exactly as recorded in the stored assistant message (never re-derived from provider objects). */
  toolArguments(lease: TurnLease, action: ToolAction): Record<string, unknown> {
    return this.atomic(() => {
      this.guard(lease);
      for (const entry of this.messages(lease.sessionId)) if (entry.turnId === action.turnId && entry.message.role === "assistant") {
        const call = entry.message.toolCalls?.find((item) => item.id === action.callId);
        if (call) return structuredClone(call.arguments);
      }
      throw fail();
    });
  }

  finishTurn(lease: TurnLease, state: "completed" | "limited" | "context_limit" | "failed", code: string | null = null) {
    if (code !== null && !/^[A-Z0-9_]{1,64}$/.test(code)) throw invalid("Invalid failure code");
    this.atomic(() => {
      this.guard(lease);
      if (Number(this.db.prepare("SELECT count(*) AS n FROM attempts WHERE turn_id=? AND state IN ('queued','dispatched')").get(lease.turnId)?.n) > 0) throw conflict();
      this.closeTurn(lease.sessionId, lease.turnId, state, code);
    });
  }
  /** Inspectable fenced attempts. Their provider-side cost is unknown, never zero. */
  unknownAttempts(): Attempt[] {
    return this.atomic(() => {
      this.expireAll();
      return this.db.prepare("SELECT id FROM sessions").all().flatMap((row) => this.attempts(String(row.id))).filter((attempt) => attempt.state === "unknown");
    });
  }
}
