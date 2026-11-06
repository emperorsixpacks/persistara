import type { JsonObjectSchema, ToolDefinition } from "../../protocol/src/tools.js";
import type { CallOptions } from "../../protocol/src/providers.js";
import type { VerifiedInferenceEvidence } from "./evidence.js";

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };
export interface InferenceRequest {
  operationId: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
}
export interface InferenceResult {
  id: string;
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length";
  usage: { inputTokens: number; outputTokens: number };
  evidence: VerifiedInferenceEvidence;
}
export interface InferenceProvider { complete(request: InferenceRequest, options?: CallOptions): Promise<InferenceResult> }
export type ToolSchema = JsonObjectSchema;
