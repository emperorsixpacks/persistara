import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferenceConfig } from "../packages/protocol/src/config.js";
import { accumulateChatStream } from "../packages/inference/src/stream.js";

/** SYNTHETIC SSE bytes only: no network, no provider, no verification. These test parsing, not NEAR AI's real stream format. */
const sse = (...events: unknown[]) => events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
const chunk = (id: string, delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) => ({ id, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const usage = (id: string) => ({ id, choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } });
async function* pieces(text: string, size: number): AsyncIterable<Uint8Array> { const bytes = Buffer.from(text); for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); }
const run = (text: string, size = 7) => accumulateChatStream(pieces(text, size));
const protocol = { code: "PROTOCOL_ERROR" };

describe("chat stream accumulation (synthetic bytes; unverified transport parsing)", () => {
  it("assembles text regardless of how the bytes are split, including inside multi-byte characters", async () => {
    const body = sse(chunk("c1", { role: "assistant", content: "Héllo " }), chunk("c1", { content: "wörld 🌍" }), chunk("c1", {}, "stop"), usage("c1"), "[DONE]");
    for (const size of [1, 2, 3, 7, 64, 100_000]) {
      const result = await run(body, size);
      assert.deepEqual(result, { id: "c1", text: "Héllo wörld 🌍", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 12, completion_tokens: 7 } }, `size ${size}`);
    }
  });

  it("reassembles tool-call fragments by index and keeps arguments as text for the caller's JSON parse", async () => {
    const body = sse(
      chunk("c2", { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "mission_list", arguments: "" } }] }),
      chunk("c2", { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "memory_recall", arguments: "{\"query\":" } }] }),
      chunk("c2", { tool_calls: [{ index: 0, function: { arguments: "{\"limit\":2}" } }, { index: 1, function: { arguments: "\"fees\"}" } }] }),
      chunk("c2", {}, "tool_calls"), usage("c2"), "[DONE]");
    const result = await run(body, 5);
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.toolCalls.map((call) => [call.id, call.function.name, call.function.arguments]), [["call_a", "mission_list", "{\"limit\":2}"], ["call_b", "memory_recall", "{\"query\":\"fees\"}"]]);
  });

  it("accepts keep-alive comments, CRLF framing and usage carried on the final choice chunk", async () => {
    const body = ": keep-alive\r\n\r\n" + `data: ${JSON.stringify(chunk("c3", { content: "ok" }))}\r\n\r\n` + `data: ${JSON.stringify(chunk("c3", {}, "length", { usage: { prompt_tokens: 3, completion_tokens: 1 } }))}\r\n\r\n` + "data: [DONE]\r\n\r\n";
    assert.deepEqual(await run(body, 3), { id: "c3", text: "ok", toolCalls: [], finishReason: "length", usage: { prompt_tokens: 3, completion_tokens: 1 } });
  });

  it("refuses to guess: missing usage, missing terminator, missing finish and truncation are all errors", async () => {
    await assert.rejects(run(sse(chunk("c", { content: "x" }), chunk("c", {}, "stop"), "[DONE]")), protocol, "no usage");
    await assert.rejects(run(sse(chunk("c", { content: "x" }), chunk("c", {}, "stop"), usage("c"))), protocol, "no [DONE]");
    await assert.rejects(run(sse(chunk("c", { content: "x" }), usage("c"), "[DONE]")), protocol, "no finish reason");
    await assert.rejects(run(sse(chunk("c", { content: "partial" })) + "data: {\"id\":\"c\",\"choi"), protocol, "cut inside an event");
    await assert.rejects(run(""), protocol, "empty");
  });

  it("rejects inconsistent, hostile or over-limit streams", async () => {
    const ok = (extra: unknown[]) => sse(chunk("c", { content: "x" }), ...extra, chunk("c", {}, "stop"), usage("c"), "[DONE]");
    await assert.rejects(run(sse(chunk("a", { content: "x" }), chunk("b", {}, "stop"), usage("a"), "[DONE]")), protocol, "mixed IDs");
    await assert.rejects(run(sse({ id: "c", choices: [{ index: 1, delta: { content: "x" } }] })), protocol, "second choice");
    await assert.rejects(run(sse({ id: "c", error: { message: "boom" } })), protocol, "error event");
    await assert.rejects(run("data: not json\n\n"), protocol, "bad json");
    await assert.rejects(run("evil: field\n\n"), protocol, "unknown field");
    await assert.rejects(run(sse(chunk("c", { content: "x" }), chunk("c", {}, "stop"), chunk("c", { content: "late" }))), protocol, "content after finish");
    await assert.rejects(run(sse(chunk("c", {}, "stop"), usage("c"), "[DONE]", chunk("c", { content: "after" }))), protocol, "event after terminator");
    await assert.rejects(run(ok([usage("c"), usage("c")])), protocol, "usage twice");
    await assert.rejects(run(sse(chunk("c", { content: "x" }), chunk("c", {}, "stop"), { id: "c", choices: [], usage: { prompt_tokens: -1, completion_tokens: 1 } }, "[DONE]")), protocol, "negative usage");
    await assert.rejects(run(sse(chunk("c", { tool_calls: [{ index: 0, id: "t", function: { name: "a", arguments: "{}" } }] }), chunk("c", { tool_calls: [{ index: 0, id: "other", function: { arguments: "" } }] }), chunk("c", {}, "tool_calls"), usage("c"), "[DONE]")), protocol, "changed call id");
    await assert.rejects(run(sse(chunk("c", { tool_calls: [{ index: 1, id: "t", function: { name: "a", arguments: "{}" } }] }), chunk("c", {}, "tool_calls"), usage("c"), "[DONE]")), protocol, "gap in call indexes");
    await assert.rejects(run(sse(chunk("c", { tool_calls: [{ index: 0, id: "t", function: { arguments: "{}" } }] }), chunk("c", {}, "tool_calls"), usage("c"), "[DONE]")), protocol, "call without a name");
    await assert.rejects(run(sse(chunk("c", { content: "x".repeat(128_001) }))), protocol, "text over the limit");
    await assert.rejects(run(sse(chunk("c", { tool_calls: [{ index: 0, id: "t", function: { name: "a", arguments: "x".repeat(32_769) } }] }))), protocol, "arguments over the limit");
    await assert.rejects(run(sse(chunk("c", { content: "x" })) + " ".repeat(300_000)), protocol, "stream over the byte limit");
    await assert.rejects(accumulateChatStream((async function* () { yield Buffer.from([0xff, 0xfe, 0x0a, 0x0a]); })()), protocol, "invalid UTF-8");
  });

  it("is off unless explicitly enabled, and the key alone never turns it on", () => {
    assert.equal(inferenceConfig({ NEARAI_API_KEY: "k", NEARAI_MODEL: "m" }).stream, undefined);
    assert.equal(inferenceConfig({ NEARAI_API_KEY: "k", NEARAI_MODEL: "m", NEARAI_STREAM: "true" }).stream, undefined);
    assert.equal(inferenceConfig({ NEARAI_API_KEY: "k", NEARAI_MODEL: "m", NEARAI_STREAM: "enabled" }).stream, true);
  });
});

describe("provider failure diagnostics are codes only", () => {
  it("passes lowercase dotted SDK codes and drops anything that could carry message text, URLs or secrets", async () => {
    const { diagnosticCode } = await import("../packages/protocol/src/worker.js");
    for (const ok of ["api.http_status", "verification.tls_binding_mismatch", "api.completion_signature_unavailable"]) assert.equal(diagnosticCode(ok), ok);
    for (const bad of ["HTTP 401 for https://x", "Bearer abc", "api key sk-123", "UPPER.case", "a".repeat(70), "with space", "api.", ".api", "", undefined, 5, { code: "api.x" }]) assert.equal(diagnosticCode(bad), undefined, String(bad));
  });
});
