import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { ConversationRunner, SYSTEM_PROMPT, type RunnerOptions } from "../packages/conversation/src/runner.js";
import { createReadOnlyTools } from "../packages/conversation/src/tools.js";
import { DEFAULT_CAPS } from "../packages/conversation/src/types.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { ScriptedProvider, SYNTHETIC, call, callTools, fakeBackend, journalFixture, say, type Step } from "./fixtures/conversation-support.js";

async function setup(steps: Step[], extra: Partial<RunnerOptions> = {}) {
  const f = await journalFixture(), provider = new ScriptedProvider(steps), fake = fakeBackend();
  const runner = () => new ConversationRunner({ journal: f.journal(), provider, tools: createReadOnlyTools(fake.backend), model: "synthetic-model", ...extra });
  const session = f.journal().createSession(randomUUID());
  return { f, provider, fake, runner, session, turn: (text = "hello", r = runner()) => r.runTurn(session.id, randomUUID(), text) };
}

describe("bounded conversation coordinator (offline; scripted synthetic provider)", () => {
  it("completes a reply-only turn, keeps the system prompt out of stored history and sends exactly one request", async () => {
    const t = await setup([say(`${SYNTHETIC}: hi`)]);
    try {
      const result = await t.turn("hello there");
      assert.equal(result.state, "completed"); assert.equal(result.reply, `${SYNTHETIC}: hi`); assert.equal(result.limited, false);
      assert.equal(t.provider.invocations, 1);
      assert.deepEqual(t.provider.requests[0]!.messages.map((m) => m.role), ["system", "user"]);
      assert.equal(t.provider.requests[0]!.messages[0]!.content, SYSTEM_PROMPT);
      assert.equal(t.provider.requests[0]!.maxOutputTokens, DEFAULT_CAPS.outputTokens);
      assert.deepEqual(t.provider.requests[0]!.tools!.map((x) => x.name), ["mission_list", "mission_detail", "memory_recall"]);
      assert.deepEqual(t.f.journal().get(t.session.id).messages.map((m) => m.message.role), ["user", "assistant"]);
      assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, knownRounds: 1 });
    } finally { await t.f.close(); }
  });

  it("runs a multi-round tool conversation with valid ordering and replays an identical request without a second call", async () => {
    const t = await setup([callTools(call("c1", "mission_list", { limit: 1 })), say("You have one saved mission.")]);
    try {
      const requestId = randomUUID(), runner = t.runner();
      const result = await runner.runTurn(t.session.id, requestId, "what missions do I have?");
      assert.equal(result.reply, "You have one saved mission."); assert.equal(t.provider.invocations, 2); assert.equal(t.fake.counters.list, 1);
      assert.deepEqual(t.provider.requests[1]!.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
      const tool = t.provider.requests[1]!.messages[3]!;
      assert.equal(tool.role === "tool" && tool.toolCallId, "c1");
      assert.equal(result.usage.knownRounds, 2);
      const again = await runner.runTurn(t.session.id, requestId, "what missions do I have?");
      assert.equal(again.replayed, true); assert.equal(again.reply, "You have one saved mission."); assert.equal(t.provider.invocations, 2);
    } finally { await t.f.close(); }
  });

  it("stops at the round cap without executing tools on the last round or making another charged call", async () => {
    const loop = callTools(call("x", "mission_list"));
    const t = await setup([loop, ((): Step => callTools(call("y", "mission_list")))(), callTools(call("z", "mission_list")), callTools(call("w", "mission_list")), say("never")]);
    try {
      const result = await t.turn();
      assert.equal(result.state, "limited"); assert.equal(result.failureCode, "ROUND_LIMIT"); assert.equal(result.limited, true);
      assert.equal(t.provider.invocations, DEFAULT_CAPS.rounds); assert.equal(t.fake.counters.list, DEFAULT_CAPS.rounds - 1);
      const history = t.f.journal().get(t.session.id).messages.map((m) => m.message.role);
      assert.equal(history.filter((r) => r === "tool").length, DEFAULT_CAPS.rounds, "unexecuted final calls are still resolved in history");
    } finally { await t.f.close(); }
  });

  it("rejects an over-cap tool batch before executing any of it", async () => {
    const calls = Array.from({ length: 5 }, (_, i) => call(`c${i}`, "mission_list"));
    const t = await setup([callTools(...calls), say("never")]);
    try {
      const result = await t.turn();
      assert.equal(result.state, "limited"); assert.equal(result.failureCode, "TOOL_BATCH_LIMIT");
      assert.equal(t.fake.counters.list, 0); assert.equal(t.fake.counters.authorize, 0); assert.equal(t.provider.invocations, 1);
    } finally { await t.f.close(); }
  });

  it("treats a verified length finish as partial and never issues a follow-up charged call", async () => {
    const t = await setup([() => ({ text: "partial answ", finishReason: "length" }), say("never")]);
    try {
      const result = await t.turn();
      assert.equal(result.state, "limited"); assert.equal(result.limited, true); assert.equal(result.failureCode, "OUTPUT_LIMIT"); assert.equal(result.reply, "partial answ");
      assert.equal(t.provider.invocations, 1);
    } finally { await t.f.close(); }
  });

  it("refuses unverified evidence: nothing is stored as an answer, nothing is retried and the session is not fenced", async () => {
    const t = await setup([() => ({ text: "forged", evidence: { status: "unverified" } as never }), say("second turn answer")]);
    try {
      const result = await t.turn();
      assert.equal(result.state, "failed"); assert.equal(result.failureCode, "VERIFICATION_FAILED"); assert.equal(result.reply, null);
      assert.equal(t.provider.invocations, 1);
      assert.deepEqual(t.f.journal().get(t.session.id).messages.map((m) => m.message.role), ["user"]);
      const next = await t.turn("try again by my own choice");
      assert.equal(next.state, "completed"); assert.equal(t.provider.invocations, 2);
    } finally { await t.f.close(); }
  });

  it("makes a lost outcome unknown, fences the session across reopen and never resubmits automatically", async () => {
    const t = await setup([() => { throw new ProviderError("TIMEOUT", "Provider timed out", true); }, say("must not run")]);
    try {
      const result = await t.turn();
      assert.equal(result.state, "unknown"); assert.equal(result.failureCode, "OUTCOME_UNKNOWN"); assert.ok(result.unknownAttempt);
      assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, knownRounds: 0 }, "unknown cost is not claimed as zero usage");
      await assert.rejects(t.turn("retry"), /already running/);
      t.f.restart(); t.f.advance();
      await assert.rejects(t.turn("retry after reopen"), /already running/);
      assert.equal(t.provider.invocations, 1);
      assert.equal(t.f.journal().unknownAttempts()[0]!.operationId, result.unknownAttempt);
    } finally { await t.f.close(); }
  });

  it("distinguishes pre-submission failures (safe) from transport failures (unknown)", async () => {
    const t = await setup([() => { throw new ProviderError("NOT_CONFIGURED", "no key"); }, () => { throw new Error("socket closed"); }]);
    try {
      const first = await t.turn(); assert.equal(first.state, "failed"); assert.equal(first.failureCode, "NOT_CONFIGURED"); assert.equal(first.unknownAttempt, null);
      const second = await t.turn("again"); assert.equal(second.state, "unknown");
    } finally { await t.f.close(); }
  });

  it("honors cancellation before dispatch with zero requests and after dispatch as unknown", async () => {
    const early = new AbortController(); early.abort();
    const a = await setup([say("never")], { signal: early.signal });
    try { const result = await a.turn(); assert.equal(result.state, "failed"); assert.equal(result.failureCode, "ABORTED"); assert.equal(a.provider.invocations, 0); } finally { await a.f.close(); }
    const late = new AbortController();
    const b = await setup([(_request, options) => new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new ProviderError("ABORTED", "aborted"))); setTimeout(() => late.abort(), 5); })], { signal: late.signal });
    try { const result = await b.turn(); assert.equal(result.state, "unknown", "cancellation cannot retract a request already accepted"); assert.ok(result.unknownAttempt); } finally { await b.f.close(); }
  });

  it("reports a context limit without dropping history or contacting the provider", async () => {
    const t = await setup([say("first answer"), say("never")], { caps: { ...DEFAULT_CAPS, messages: 3 } });
    try {
      assert.equal((await t.turn("one")).state, "completed");
      const second = await t.turn("two");
      assert.equal(second.state, "context_limit"); assert.equal(second.limited, true); assert.equal(t.provider.invocations, 1);
      assert.equal(t.f.journal().get(t.session.id).messages.length, 3, "nothing was compacted or dropped");
    } finally { await t.f.close(); }
  });

  it("detects lease loss while a request is in flight: unknown, no duplicate invocation, no stored late answer", async () => {
    const t = await setup([]);
    try {
      const provider = new ScriptedProvider([() => { t.f.advance(); return { text: "late answer" }; }, say("must not run")]);
      const runner = new ConversationRunner({ journal: t.f.journal(), provider, tools: createReadOnlyTools(t.fake.backend), model: "synthetic-model" });
      const result = await runner.runTurn(t.session.id, randomUUID(), "slow");
      assert.equal(result.state, "unknown"); assert.equal(provider.invocations, 1);
      assert.deepEqual(t.f.journal().get(t.session.id).messages.map((m) => m.message.role), ["user"]);
    } finally { await t.f.close(); }
  });

  it("reopens a stored conversation in a fresh process with matching IDs, then continues with its history", async () => {
    const t = await setup([callTools(call("c1", "mission_list")), say("Saved work: two missions."), say("Still two.")]);
    try {
      const first = await t.turn("inspect my saved work");
      const before = t.f.journal().get(t.session.id);
      t.f.restart();
      const after = t.f.journal().get(t.session.id);
      assert.deepEqual(after.messages, before.messages); assert.equal(after.turns[0]!.id, first.turnId);
      const second = await t.turn("and now?", t.runner());
      assert.equal(second.reply, "Still two."); assert.equal(t.provider.requests.at(-1)!.messages.length, 6);
    } finally { await t.f.close(); }
  });
});
