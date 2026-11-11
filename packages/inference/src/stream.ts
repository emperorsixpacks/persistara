import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";

/**
 * Accumulates an OpenAI-compatible chat-completion stream (server-sent events) into the same shape a non-streaming completion
 * has. Nothing here is trusted yet: the caller must verify the completion's signature over the COMPLETE stream before using any
 * of it, and must never display or store partial text from a stream that fails verification. Every malformed, truncated,
 * oversized or inconsistent stream is a PROTOCOL_ERROR; this module never guesses missing fields (no usage means no result).
 */
export const MAX_STREAM_BYTES = 256_000;
const MAX_TEXT_BYTES = 128_000, MAX_ARGUMENT_BYTES = 32_768, MAX_CALLS = 16;

export interface StreamedCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface StreamedCompletion {
  id: string; text: string; toolCalls: StreamedCall[]; finishReason: string; usage: { prompt_tokens: number; completion_tokens: number };
}
const bad = (message: string) => new ProviderError("PROTOCOL_ERROR", message);

export async function accumulateChatStream(body: AsyncIterable<Uint8Array>): Promise<StreamedCompletion> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", total = 0, done = false, id: string | undefined, text = "", finish: string | undefined, usage: StreamedCompletion["usage"] | undefined, textBytes = 0;
  const calls = new Map<number, { id?: string; name?: string; arguments: string }>();

  const handle = (data: string) => {
    if (data === "[DONE]") { done = true; return; }
    if (done) throw bad("Stream continued after its terminator");
    let chunk: unknown;
    try { chunk = JSON.parse(data); } catch { throw bad("Malformed stream event"); }
    if (!isObject(chunk) || "error" in chunk || typeof chunk.id !== "string" || !chunk.id) throw bad("Unusable stream event");
    if (id === undefined) id = chunk.id; else if (id !== chunk.id) throw bad("Stream mixed completion IDs");
    if (chunk.usage !== undefined && chunk.usage !== null) {
      const u = chunk.usage;
      if (!isObject(u) || !Number.isSafeInteger(u.prompt_tokens) || !Number.isSafeInteger(u.completion_tokens) || Number(u.prompt_tokens) < 0 || Number(u.completion_tokens) < 0) throw bad("Malformed stream usage");
      if (usage) throw bad("Stream reported usage twice");
      usage = { prompt_tokens: Number(u.prompt_tokens), completion_tokens: Number(u.completion_tokens) };
    }
    if (!Array.isArray(chunk.choices)) throw bad("Stream event has no choices");
    if (chunk.choices.length === 0) return; // usage-only chunk
    if (chunk.choices.length !== 1 || !isObject(chunk.choices[0]) || chunk.choices[0].index !== undefined && chunk.choices[0].index !== 0) throw bad("Stream used more than one choice");
    const choice = chunk.choices[0];
    if (finish !== undefined) throw bad("Stream continued after its finish reason");
    const delta = choice.delta;
    if (delta !== undefined && delta !== null) {
      if (!isObject(delta)) throw bad("Malformed stream delta");
      if (typeof delta.content === "string") { textBytes += Buffer.byteLength(delta.content); if (textBytes > MAX_TEXT_BYTES) throw bad("Streamed text exceeds its limit"); text += delta.content; }
      else if (delta.content !== undefined && delta.content !== null) throw bad("Malformed streamed text");
      if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
        if (!Array.isArray(delta.tool_calls)) throw bad("Malformed streamed tool calls");
        for (const part of delta.tool_calls) {
          if (!isObject(part) || !Number.isSafeInteger(part.index) || Number(part.index) < 0 || Number(part.index) >= MAX_CALLS) throw bad("Malformed streamed tool call");
          const current = calls.get(Number(part.index)) ?? { arguments: "" };
          if (part.id !== undefined) { if (typeof part.id !== "string" || (current.id !== undefined && current.id !== part.id)) throw bad("Inconsistent streamed tool-call ID"); current.id = part.id; }
          if (part.type !== undefined && part.type !== "function") throw bad("Unsupported streamed tool type");
          if (part.function !== undefined) {
            if (!isObject(part.function)) throw bad("Malformed streamed tool function");
            if (part.function.name !== undefined) { if (typeof part.function.name !== "string" || (current.name !== undefined && current.name !== part.function.name)) throw bad("Inconsistent streamed tool name"); current.name = part.function.name; }
            if (part.function.arguments !== undefined) { if (typeof part.function.arguments !== "string") throw bad("Malformed streamed tool arguments"); current.arguments += part.function.arguments; if (Buffer.byteLength(current.arguments) > MAX_ARGUMENT_BYTES) throw bad("Streamed tool arguments exceed their limit"); }
          }
          calls.set(Number(part.index), current);
        }
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (typeof choice.finish_reason !== "string") throw bad("Malformed finish reason"); finish = choice.finish_reason; }
  };

  const drain = (final: boolean) => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      const data: string[] = [];
      for (const line of event.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue; // blank/comment keep-alive
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (!/^(event|id|retry):/.test(line)) throw bad("Unexpected stream field");
      }
      if (data.length) handle(data.join("\n"));
    }
    if (final && buffer.trim()) throw bad("Stream ended inside an event");
  };

  for await (const part of body) {
    total += part.byteLength;
    if (total > MAX_STREAM_BYTES) throw bad("Stream exceeds its size limit");
    try { buffer += decoder.decode(part, { stream: true }); } catch { throw bad("Stream is not valid UTF-8"); }
    drain(false);
  }
  try { buffer += decoder.decode(); } catch { throw bad("Stream is not valid UTF-8"); }
  drain(true);

  if (!done) throw bad("Stream ended before its terminator");
  if (id === undefined || finish === undefined) throw bad("Stream ended without a completion or finish reason");
  if (!usage) throw bad("Stream carried no usage; refusing to guess it");
  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
  if (ordered.some(([index], position) => index !== position)) throw bad("Streamed tool calls have gaps");
  const toolCalls = ordered.map(([, call]) => {
    if (!call.id || !call.name) throw bad("Streamed tool call is incomplete");
    return { id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } };
  });
  return { id, text, toolCalls, finishReason: finish, usage };
}
