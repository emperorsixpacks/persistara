import { isIdentifier, isObject } from "../../protocol/src/memory.js";
import { assertRuntime, type InferenceConfig } from "../../protocol/src/config.js";
import { ProviderError, type CallOptions, type WorkerExecutor } from "../../protocol/src/providers.js";
import { executeWorker } from "../../protocol/src/worker.js";
import { assertVerifiedEvidence } from "./evidence.js";
import type { InferenceProvider, InferenceRequest, InferenceResult, ToolCall } from "./provider.js";

function validateCalls(value: unknown): asserts value is ToolCall[] {
  if (!Array.isArray(value) || value.length > 16) throw new ProviderError("PROTOCOL_ERROR", "Invalid model tool-call collection");
  const ids = new Set<string>();
  for (const call of value) {
    if (!isObject(call) || !isIdentifier(call.id) || !isIdentifier(call.name) || !isObject(call.arguments) || ids.has(call.id) || Buffer.byteLength(JSON.stringify(call.arguments)) > 32_768) {
      throw new ProviderError("PROTOCOL_ERROR", "Invalid, duplicate, or oversized model tool call");
    }
    ids.add(call.id);
  }
}

export function validateInferenceRequest(request: InferenceRequest): void {
  if (!isIdentifier(request.operationId) || !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 128 ||
      Buffer.byteLength(JSON.stringify(request)) > 256_000 || !Number.isSafeInteger(request.maxOutputTokens ?? 1024) ||
      (request.maxOutputTokens ?? 1024) < 1 || (request.maxOutputTokens ?? 1024) > 4096) throw new ProviderError("INVALID_INPUT", "Invalid or oversized inference request");
  const pending = new Set<string>();
  for (const message of request.messages) {
    if (!isObject(message) || !["system", "user", "assistant", "tool"].includes(String(message.role)) ||
        !(typeof message.content === "string" || (message.role === "assistant" && message.content === null))) throw new ProviderError("INVALID_INPUT", "Invalid chat message");
    if (pending.size && message.role !== "tool") throw new ProviderError("INVALID_INPUT", "Tool results must resolve before another message");
    if (message.role === "assistant" && message.toolCalls) {
      validateCalls(message.toolCalls);
      for (const call of message.toolCalls) pending.add(call.id);
    }
    if (message.role === "tool" && (!isIdentifier(message.toolCallId) || !pending.delete(message.toolCallId))) throw new ProviderError("INVALID_INPUT", "Tool result has no matching call");
  }
  if (pending.size) throw new ProviderError("INVALID_INPUT", "Inference history has unresolved tool calls");
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 16)) throw new ProviderError("INVALID_INPUT", "Too many or malformed tool definitions");
  const names = new Set<string>();
  for (const tool of request.tools ?? []) {
    if (!isIdentifier(tool.name) || names.has(tool.name) || typeof tool.description !== "string" || !isObject(tool.inputSchema) || tool.inputSchema.type !== "object") throw new ProviderError("INVALID_INPUT", "Invalid or duplicate tool definition");
    names.add(tool.name);
  }
}

export class NearAiProvider implements InferenceProvider {
  constructor(private readonly config: InferenceConfig, private readonly execute: WorkerExecutor = executeWorker) {}

  async complete(request: InferenceRequest, options: CallOptions = {}): Promise<InferenceResult> {
    assertRuntime();
    const snapshot = structuredClone(request);
    validateInferenceRequest(snapshot);
    if (!this.config.apiKey || !this.config.model) throw new ProviderError("NOT_CONFIGURED", "Set NEARAI_API_KEY and an available TEE model in NEARAI_MODEL");
    const value = await this.execute(new URL("./near-ai-worker.js", import.meta.url), { config: this.config, request: snapshot }, { ...options, timeoutMs: options.timeoutMs ?? 120_000, effect: "may-charge" });
    if (!isObject(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.id)) throw new ProviderError("PROTOCOL_ERROR", "Inference worker returned no usable completion ID");
    assertVerifiedEvidence(value.evidence, value.id);
    if (typeof value.text !== "string" || Buffer.byteLength(value.text) > 128_000 || !["stop", "tool_calls", "length"].includes(String(value.finishReason)) ||
        !isObject(value.usage) || !Number.isSafeInteger(value.usage.inputTokens) || Number(value.usage.inputTokens) < 0 ||
        !Number.isSafeInteger(value.usage.outputTokens) || Number(value.usage.outputTokens) < 0) throw new ProviderError("PROTOCOL_ERROR", "Malformed inference output or usage");
    validateCalls(value.toolCalls);
    const allowed = new Set((snapshot.tools ?? []).map(tool => tool.name));
    if (value.toolCalls.some(call => !allowed.has(call.name)) || (value.toolCalls.length > 0) !== (value.finishReason === "tool_calls")) throw new ProviderError("PROTOCOL_ERROR", "Model requested an unadvertised tool or invalid finish state");
    return structuredClone(value) as unknown as InferenceResult;
  }
}
