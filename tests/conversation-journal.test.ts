import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { ConversationJournal, LEASE_MS, digest } from "../packages/conversation/src/journal.js";
import { DEFAULT_CAPS, type CompletedAttempt, type ConversationScope } from "../packages/conversation/src/types.js";

const scope: ConversationScope = { owner: "owner.testnet", agentId: "owner.testnet:research", contractId: "authority.owner.testnet", chainId: "testnet", codeHash: "synthetic-code-hash" };
const evidenceDigest = "e".repeat(64);
const reply = (text: string, extra: Partial<CompletedAttempt> = {}): CompletedAttempt => ({ id: `completion-${randomUUID()}`, text, toolCalls: [], finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 }, evidenceDigest, ...extra });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "persistara-conversation-")); await chmod(directory, 0o700);
  const path = join(directory, "conversations.sqlite"); let now = 1_700_000_000_000;
  let journal = new ConversationJournal(path, scope, () => now);
  return { directory, path, journal: () => journal, advance: (ms = LEASE_MS + 1) => { now += ms; },
    restart: () => { journal.close(); journal = new ConversationJournal(path, scope, () => now); },
    close: async () => { journal.close(); await rm(directory, { recursive: true, force: true }); } };
}
const start = (f: Awaited<ReturnType<typeof fixture>>, text = "hello") => {
  const session = f.journal().createSession(randomUUID());
  const holder = randomUUID(), turn = f.journal().beginTurn(session.id, randomUUID(), text, holder);
  return { session, holder, turn, lease: turn.lease! };
};
const attempt = (f: Awaited<ReturnType<typeof fixture>>, lease: ReturnType<typeof start>["lease"], round = 1) => {
  const queued = f.journal().queueAttempt(lease, { round, requestDigest: digest({ round }), model: "synthetic-model", maxOutputTokens: 256 });
  f.journal().dispatchAttempt(lease, queued.operationId); return queued;
};

describe("durable conversation journal (offline, synthetic scope)", () => {
  it("reopens private sessions with stable IDs, ordered messages and persisted per-turn caps", async () => {
    const f = await fixture();
    try {
      const { session, lease, turn } = start(f, "  line one\r\nline two  ");
      const a = attempt(f, lease);
      f.journal().completeAttempt(lease, a.operationId, reply("answer"));
      f.journal().finishTurn(lease, "completed");
      f.restart();
      const detail = f.journal().get(session.id);
      assert.equal(detail.session.id, session.id);
      assert.deepEqual(detail.messages.map((m) => [m.ordinal, m.message.role]), [[0, "user"], [1, "assistant"]]);
      assert.equal((detail.messages[0]!.message as { content: string }).content, "line one\nline two");
      assert.equal(detail.turns[0]!.id, turn.turn.id);
      assert.equal(detail.turns[0]!.state, "completed");
      assert.deepEqual(detail.turns[0]!.caps, DEFAULT_CAPS);
      assert.deepEqual(detail.attempts[0]!.usage, { inputTokens: 3, outputTokens: 2 });
      assert.equal(f.journal().listSessions().length, 1);
    } finally { await f.close(); }
  });

  it("is idempotent for identical requests and refuses changed content, titles and cross-session reuse", async () => {
    const f = await fixture();
    try {
      const requestId = randomUUID(), session = f.journal().createSession(requestId, "Plan");
      assert.equal(f.journal().createSession(requestId, "Plan").id, session.id);
      assert.throws(() => f.journal().createSession(requestId, "Other"), /changed/);
      const turnRequest = randomUUID(), holder = randomUUID();
      const first = f.journal().beginTurn(session.id, turnRequest, "question", holder);
      assert.throws(() => f.journal().beginTurn(session.id, turnRequest, "question", randomUUID()), /already running/);
      f.journal().finishTurn(first.lease!, "completed");
      const replay = f.journal().beginTurn(session.id, turnRequest, "question", randomUUID());
      assert.equal(replay.lease, null); assert.equal(replay.turn.id, first.turn.id);
      assert.throws(() => f.journal().beginTurn(session.id, turnRequest, "different", randomUUID()), /changed/);
      const other = f.journal().createSession(randomUUID());
      assert.throws(() => f.journal().beginTurn(other.id, turnRequest, "question", randomUUID()), /changed/);
      assert.equal(f.journal().get(session.id).messages.length, 1);
    } finally { await f.close(); }
  });

  it("rejects stale holders and fences, expired leases and a second concurrent process", async () => {
    const f = await fixture();
    try {
      const { session, lease } = start(f);
      const second = new ConversationJournal(f.path, scope, () => 1_700_000_000_000);
      try {
        assert.throws(() => second.beginTurn(session.id, randomUUID(), "again", randomUUID()), /already running/);
        assert.throws(() => second.heartbeat({ ...lease, holder: randomUUID() }), /already running/);
        assert.throws(() => f.journal().heartbeat({ ...lease, fence: lease.fence + 1 }), /already running/);
      } finally { second.close(); }
      f.advance();
      assert.throws(() => f.journal().queueAttempt(lease, { round: 1, requestDigest: digest("x"), model: "m", maxOutputTokens: 8 }), /already running/);
      const detail = f.journal().get(session.id);
      assert.equal(detail.turns[0]!.state, "failed"); assert.equal(detail.turns[0]!.failureCode, "LEASE_EXPIRED");
      assert.ok(f.journal().beginTurn(session.id, randomUUID(), "recovered", randomUUID()).lease);
    } finally { await f.close(); }
  });

  it("turns a dispatched attempt into a fenced outcome-unknown on reopen and never permits a replacement", async () => {
    const f = await fixture();
    try {
      const { session, lease } = start(f);
      const a = attempt(f, lease);
      f.restart(); f.advance();
      const detail = f.journal().get(session.id);
      assert.equal(detail.attempts[0]!.state, "unknown"); assert.equal(detail.turns[0]!.state, "unknown");
      assert.deepEqual(f.journal().unknownAttempts().map((x) => x.operationId), [a.operationId]);
      assert.equal(f.journal().unknownAttempts()[0]!.usage, null, "unknown cost is never recorded as zero");
      assert.throws(() => f.journal().beginTurn(session.id, randomUUID(), "retry", randomUUID()), /already running/);
      assert.throws(() => f.journal().completeAttempt(lease, a.operationId, reply("late")), /already running/);
      const other = start(f, "another session is unaffected");
      assert.ok(other.lease);
    } finally { await f.close(); }
  });

  it("lets the owner acknowledge an unknown attempt without inventing cost, resending or rewriting history", async () => {
    const f = await fixture();
    try {
      const { session, lease } = start(f);
      const a = attempt(f, lease);
      f.restart(); f.advance();
      assert.throws(() => f.journal().resolveUnknown(a.operationId, "free" as never), /Resolution must be/);
      assert.throws(() => f.journal().resolveUnknown(`attempt:${randomUUID()}`, "billed"), /not in this agent/);
      const done = f.journal().resolveUnknown(a.operationId, "unverified");
      assert.equal(done.state, "unknown"); assert.equal(done.usage, null); assert.equal(done.resolution, "unverified");
      assert.equal(f.journal().resolveUnknown(a.operationId, "unverified").resolution, "unverified", "idempotent");
      assert.throws(() => f.journal().resolveUnknown(a.operationId, "not_billed"), /already running/, "a recorded answer is never silently changed");
      assert.deepEqual(f.journal().unknownAttempts(), []);
      f.restart();
      const next = f.journal().beginTurn(session.id, randomUUID(), "after acknowledgement", randomUUID());
      assert.ok(next.lease, "session accepts a new message");
      const detail = f.journal().get(session.id);
      assert.equal(detail.turns[0]!.state, "unknown"); assert.equal(detail.attempts[0]!.state, "unknown"); assert.equal(detail.attempts[0]!.usage, null);
      assert.throws(() => f.journal().resolveUnknown(next.lease!.turnId as never, "billed"), /Invalid attempt/);
    } finally { await f.close(); }
  });

  it("refuses to resolve an attempt that is not outcome-unknown", async () => {
    const f = await fixture();
    try {
      const { lease } = start(f);
      const a = attempt(f, lease);
      assert.throws(() => f.journal().resolveUnknown(a.operationId, "billed"), /already running/);
      f.journal().completeAttempt(lease, a.operationId, reply("ok"));
      assert.throws(() => f.journal().resolveUnknown(a.operationId, "billed"), /already running/);
    } finally { await f.close(); }
  });

  it("keeps a never-dispatched attempt retryable only because nothing was submitted", async () => {
    const f = await fixture();
    try {
      const { session, lease } = start(f);
      const queued = f.journal().queueAttempt(lease, { round: 1, requestDigest: digest("r"), model: "m", maxOutputTokens: 8 });
      f.advance();
      const detail = f.journal().get(session.id);
      assert.equal(detail.attempts[0]!.state, "failed"); assert.equal(detail.turns[0]!.state, "failed");
      assert.equal(queued.state, "queued");
      assert.ok(f.journal().beginTurn(session.id, randomUUID(), "next", randomUUID()).lease);
    } finally { await f.close(); }
  });

  it("classifies failures: positive non-submission fails, anything else after dispatch is unknown", async () => {
    const f = await fixture();
    try {
      const a = start(f), x = attempt(f, a.lease);
      assert.equal(f.journal().failAttempt(a.lease, x.operationId, "TIMEOUT", "unknown"), "unknown");
      const b = start(f), y = attempt(f, b.lease);
      assert.equal(f.journal().failAttempt(b.lease, y.operationId, "INVALID_INPUT", "not_submitted"), "failed");
      assert.equal(f.journal().get(b.session.id).turns[0]!.state, "failed");
      assert.equal(f.journal().get(a.session.id).turns[0]!.state, "unknown");
    } finally { await f.close(); }
  });

  it("stores tool calls with ordered, resolved history and reuses a recorded outcome only for identical arguments", async () => {
    const g = await fixture();
    try {
      const { session, lease } = start(g);
      const a = attempt(g, lease);
      const calls = [{ id: "call-1", name: "mission_list", arguments: { limit: 2.5 } }];
      const { actions } = g.journal().completeAttempt(lease, a.operationId, reply("", { toolCalls: calls, finishReason: "tool_calls" }));
      const action = actions[0]!, args = g.journal().toolArguments(lease, action);
      assert.deepEqual(args, { limit: 2.5 }); assert.equal(digest(args), action.argumentsDigest);
      const done = g.journal().recordToolResult(lease, action.operationId, action.argumentsDigest, "completed", { missions: [] });
      assert.equal(done.state, "completed");
      assert.equal(g.journal().recordToolResult(lease, action.operationId, action.argumentsDigest, "completed", { missions: [] }).outcomeDigest, done.outcomeDigest);
      assert.throws(() => g.journal().recordToolResult(lease, action.operationId, action.argumentsDigest, "completed", { missions: ["changed"] }), /already running/);
      assert.throws(() => g.journal().recordToolResult(lease, action.operationId, digest({ limit: 3 }), "completed", { missions: [] }), /already running/);
      g.journal().queueAttempt(lease, { round: 2, requestDigest: digest("2"), model: "m", maxOutputTokens: 8 });
      const roles = g.journal().get(session.id).messages.map((m) => m.message.role);
      assert.deepEqual(roles, ["user", "assistant", "tool"]);
    } finally { await g.close(); }
  });

  it("rejects an over-cap tool batch before any tool can run and settles history validly", async () => {
    const f = await fixture();
    try {
      const { session, lease } = start(f);
      const a = attempt(f, lease);
      const calls = Array.from({ length: 5 }, (_, i) => ({ id: `call-${i}`, name: "mission_list", arguments: {} }));
      const { batchRejected, actions } = f.journal().completeAttempt(lease, a.operationId, reply("", { toolCalls: calls, finishReason: "tool_calls" }));
      assert.equal(batchRejected, true); assert.ok(actions.every((x) => x.state === "failed"));
      const detail = f.journal().get(session.id);
      assert.equal(detail.turns[0]!.state, "limited"); assert.equal(detail.turns[0]!.failureCode, "TOOL_BATCH_LIMIT");
      assert.equal(detail.messages.filter((m) => m.message.role === "tool").length, 5);
    } finally { await f.close(); }
  });

  it("enforces round and token caps and refuses duplicate provider tool-call IDs", async () => {
    const f = await fixture();
    try {
      const { lease } = start(f);
      const a = attempt(f, lease);
      assert.throws(() => f.journal().queueAttempt(lease, { round: 1, requestDigest: digest("d"), model: "m", maxOutputTokens: 8 }), /already running/);
      f.journal().completeAttempt(lease, a.operationId, reply("", { toolCalls: [{ id: "dup", name: "t", arguments: {} }], finishReason: "tool_calls" }));
      const [pending] = f.journal().pendingTools(lease);
      f.journal().recordToolResult(lease, pending!.operationId, pending!.argumentsDigest, "completed", {});
      assert.throws(() => f.journal().queueAttempt(lease, { round: 2, requestDigest: digest("d"), model: "m", maxOutputTokens: DEFAULT_CAPS.outputTokens + 1 }), /already running/);
      const b = f.journal().queueAttempt(lease, { round: 2, requestDigest: digest("d"), model: "m", maxOutputTokens: 8 });
      f.journal().dispatchAttempt(lease, b.operationId);
      assert.throws(() => f.journal().completeAttempt(lease, b.operationId, reply("", { toolCalls: [{ id: "dup", name: "t", arguments: {} }], finishReason: "tool_calls" })), /already running/);
      assert.throws(() => f.journal().completeAttempt(lease, b.operationId, reply("x", { finishReason: "tool_calls" })), /Invalid completed/);
    } finally { await f.close(); }
  });

  it("rejects the wrong scope, an unsupported schema version and bad inputs", async () => {
    const f = await fixture();
    try {
      f.journal().createSession(randomUUID());
      f.journal().close();
      assert.throws(() => new ConversationJournal(f.path, { ...scope, owner: "someone.else.testnet" }), /integrity/);
      assert.throws(() => new ConversationJournal(f.path, { ...scope, extra: "x" } as unknown as ConversationScope), /Invalid conversation scope/);
      const raw = new DatabaseSync(f.path); raw.exec("PRAGMA user_version=9"); raw.close();
      assert.throws(() => new ConversationJournal(f.path, scope), /integrity/);
      const reset = new DatabaseSync(f.path); reset.exec("DROP TABLE attempt_resolutions; PRAGMA user_version=1"); reset.close();
      f.restart();
      assert.throws(() => f.journal().createSession("not-a-uuid"), /UUID/);
      assert.throws(() => f.journal().beginTurn("session:nope", randomUUID(), "x", randomUUID()), /Invalid session/);
      const session = f.journal().createSession(randomUUID());
      assert.throws(() => f.journal().beginTurn(session.id, randomUUID(), "bad\u0007text", randomUUID()), /control/);
      assert.throws(() => f.journal().beginTurn(session.id, randomUUID(), "   ", randomUUID()), /Message/);
      assert.throws(() => f.journal().beginTurn(session.id, randomUUID(), "x".repeat(8001), randomUUID()), /Message/);
      assert.throws(() => f.journal().beginTurn(session.id, randomUUID(), "x", randomUUID(), { ...DEFAULT_CAPS, rounds: 99 }), /caps/);
    } finally { await f.close(); }
  });

  it("detects tampered, reordered and orphaned records instead of repairing them", async () => {
    const f = await fixture();
    try {
      const { session, lease } = start(f), a = attempt(f, lease);
      f.journal().completeAttempt(lease, a.operationId, reply("answer"));
      f.journal().finishTurn(lease, "completed");
      f.journal().close();
      const raw = new DatabaseSync(f.path);
      raw.prepare("UPDATE messages SET body=? WHERE ordinal=1").run('{"content":"forged","role":"assistant"}');
      raw.close();
      f.restart();
      assert.throws(() => f.journal().get(session.id), /integrity/);
      f.journal().close();
      const fix = new DatabaseSync(f.path);
      fix.prepare("UPDATE messages SET body='{\"content\":\"answer\",\"role\":\"assistant\"}' WHERE ordinal=1").run();
      fix.prepare("UPDATE turns SET request_digest=?").run("0".repeat(64));
      fix.close();
      f.restart();
      assert.throws(() => f.journal().get(session.id), /integrity/);
    } finally { await f.close(); }
  });

  it("refuses insecure directories, insecure files and symlinked database paths, and touches only its own file", async () => {
    const base = await mkdtemp(join(tmpdir(), "persistara-conversation-paths-"));
    try {
      await chmod(base, 0o700);
      const open = await mkdtemp(join(base, "open-")); await chmod(open, 0o755);
      assert.throws(() => new ConversationJournal(join(open, "c.sqlite"), scope), /integrity/);
      const loose = await mkdtemp(join(base, "loose-")); await chmod(loose, 0o700);
      await writeFile(join(loose, "c.sqlite"), "", { mode: 0o644 }); await chmod(join(loose, "c.sqlite"), 0o644);
      assert.throws(() => new ConversationJournal(join(loose, "c.sqlite"), scope), /integrity/);
      const linked = await mkdtemp(join(base, "link-")); await chmod(linked, 0o700);
      await writeFile(join(linked, "real.sqlite"), "", { mode: 0o600 }); await symlink(join(linked, "real.sqlite"), join(linked, "c.sqlite"));
      assert.throws(() => new ConversationJournal(join(linked, "c.sqlite"), scope));
      const clean = await mkdtemp(join(base, "clean-")); await chmod(clean, 0o700);
      await writeFile(join(clean, "missions.sqlite"), "unrelated mission bytes", { mode: 0o600 });
      new ConversationJournal(join(clean, "c.sqlite"), scope).close();
      assert.ok((await readdir(clean)).includes("missions.sqlite"));
      assert.equal(await readFile(join(clean, "missions.sqlite"), "utf8"), "unrelated mission bytes");
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
