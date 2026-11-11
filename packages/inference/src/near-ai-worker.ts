import { InferenceClient, isVerificationError, isApiError } from "@nearai/inference-sdk/node";
import { isObject } from "../../protocol/src/memory.js";
import { assertRuntime, type InferenceConfig } from "../../protocol/src/config.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { fail, progress, reply } from "../../protocol/src/worker.js";
import { validateInferenceRequest } from "./near-ai.js";
import { accumulateChatStream } from "./stream.js";
import type { InferenceRequest } from "./provider.js";

process.once("message", async (input: unknown) => {
  let client: InferenceClient | undefined;
  let completionPossible = false;
  try {
    assertRuntime();
    if (!isObject(input) || !isObject(input.config) || input.config.baseUrl !== "https://cloud-api.near.ai/v1" ||
        typeof input.config.apiKey !== "string" || !input.config.apiKey || typeof input.config.model !== "string" || !input.config.model || !isObject(input.request) ||
        (input.config.stream !== undefined && typeof input.config.stream !== "boolean")) {
      fail("INVALID_INPUT"); return;
    }
    const config = input.config as unknown as Required<InferenceConfig>;
    const request = input.request as unknown as InferenceRequest;
    validateInferenceRequest(request);
    const strict = { policy: { acceptedTcbStatuses: ["UpToDate" as const] } };
    client = new InferenceClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, e2ee: true, gatewayVerification: strict, modelVerification: strict });
    const preflight = await client.verify(config.model);
    if (preflight.models.length === 0) { fail("UNSUPPORTED"); return; }
    const messages = request.messages.map(message => {
      if (message.role === "tool") return { role: "tool" as const, tool_call_id: message.toolCallId, content: message.content };
      if (message.role === "assistant") return { role: "assistant" as const, content: message.content,
        ...(message.toolCalls ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) };
      return { role: message.role, content: message.content };
    });
    completionPossible = true;
    // Use the SDK fetch boundary directly: one paid POST, no automatic SDK retries.
    const response = await client.fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, messages, stream: config.stream === true, ...(config.stream === true ? { stream_options: { include_usage: true } } : {}), max_tokens: request.maxOutputTokens ?? 1024,
        ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}) }),
    });
    if (!response.ok) { fail("UPSTREAM_ERROR"); return; }
    let completion: unknown;
    if (config.stream === true) {
      // Consume the ENTIRE stream first (the signature covers all of it), then verify. Nothing is displayed or saved before that.
      if (!response.body) { fail("PROTOCOL_ERROR"); return; }
      const streamed = await accumulateChatStream(response.body as unknown as AsyncIterable<Uint8Array>);
      completion = { id: streamed.id, choices: [{ message: { content: streamed.text, ...(streamed.toolCalls.length ? { tool_calls: streamed.toolCalls } : {}) }, finish_reason: streamed.finishReason }], usage: streamed.usage };
    } else {
      const body = await response.text();
      if (Buffer.byteLength(body) > 256_000) { fail("PROTOCOL_ERROR"); return; }
      try { completion = JSON.parse(body); }
      catch { fail("PROTOCOL_ERROR"); return; }
    }
    if (!isObject(completion) || typeof completion.id !== "string") { fail("PROTOCOL_ERROR"); return; }
    progress("completion", completion.id);
    const verified = await client.verifyResponse(completion.id);
    if (verified.id !== completion.id || verified.signatureKind !== "provider_tee") { fail("UNSUPPORTED"); return; }
    if (!Array.isArray(completion.choices) || completion.choices.length !== 1 || !isObject(completion.choices[0]) ||
        !isObject(completion.choices[0].message) || !isObject(completion.usage)) { fail("PROTOCOL_ERROR"); return; }
    const choice = completion.choices[0];
    const message = choice.message as Record<string, unknown>;
    const rawCalls = message.tool_calls ?? [];
    if (!Array.isArray(rawCalls) || rawCalls.length > 16) { fail("PROTOCOL_ERROR"); return; }
    const toolCalls = rawCalls.map((call: unknown) => {
      if (!isObject(call) || call.type !== "function" || !isObject(call.function) || typeof call.function.arguments !== "string" || Buffer.byteLength(call.function.arguments) > 32_768) throw new ProviderError("PROTOCOL_ERROR", "Invalid tool response");
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); }
      catch { throw new ProviderError("PROTOCOL_ERROR", "Invalid tool arguments"); }
      return { id: call.id, name: call.function.name, arguments: args };
    });
    reply({ id: completion.id, text: message.content ?? "", toolCalls, finishReason: choice.finish_reason,
      usage: { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens },
      evidence: { status: "verified", completionId: completion.id, signatureKind: "provider_tee", checks: ["gateway_attestation", "model_attestation", "gateway_tls_binding", "response_signature"], e2ee: true, tcbPolicy: "UpToDate" } });
  } catch (error) {
    if (error instanceof ProviderError) fail(error.code);
    else if (isVerificationError(error)) fail("VERIFICATION_FAILED");
    else if (isApiError(error) && error.failure.code === "api.completion_signature_unavailable") fail("UNSUPPORTED");
    else fail(completionPossible ? "OUTCOME_UNKNOWN" : "UPSTREAM_ERROR");
  } finally { client?.clearResponseCache(); }
});
