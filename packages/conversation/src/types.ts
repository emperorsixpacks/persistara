import type { ChatMessage, ToolCall } from "../../inference/src/provider.js";

/** Same binding as missions: a session belongs to exactly one owner/agent/contract/code-hash scope. */
export interface ConversationScope { owner: string; agentId: string; contractId: string; chainId: string; codeHash: string }

export interface ConversationCaps { rounds: number; toolsPerRound: number; outputTokens: number; messages: number; requestBytes: number }
/** Milestone defaults; persisted per turn so later changes never reinterpret old turns. */
export const DEFAULT_CAPS: Readonly<ConversationCaps> = Object.freeze({ rounds: 4, toolsPerRound: 4, outputTokens: 1024, messages: 128, requestBytes: 256_000 });

export type TurnState = "active" | "completed" | "limited" | "context_limit" | "failed" | "unknown";
export type AttemptState = "queued" | "dispatched" | "completed" | "failed" | "unknown";
export type ToolActionState = "queued" | "completed" | "failed";

export interface SessionSummary { id: string; title: string; createdAt: number; updatedAt: number; version: number; turnCount: number }
export interface StoredMessage { ordinal: number; turnId: string; message: ChatMessage }
export interface Turn {
  id: string; sessionId: string; ordinal: number; requestId: string; state: TurnState; version: number; caps: ConversationCaps;
  createdAt: number; updatedAt: number; failureCode: string | null;
}
export interface Attempt {
  operationId: string; turnId: string; round: number; requestDigest: string; model: string; maxOutputTokens: number; state: AttemptState;
  completionId: string | null; finishReason: "stop" | "tool_calls" | "length" | null; usage: { inputTokens: number; outputTokens: number } | null;
  evidenceDigest: string | null; failureCode: string | null;
  /** Owner acknowledgement of an unknown outcome. It never supplies usage or cost. */
  resolution: "billed" | "not_billed" | "unverified" | null;
}
export interface ToolAction {
  operationId: string; turnId: string; attemptId: string; callId: string; name: string; argumentsDigest: string;
  state: ToolActionState; outcome: unknown; outcomeDigest: string | null;
}
export interface SessionDetail { session: SessionSummary; turns: Turn[]; messages: StoredMessage[]; attempts: Attempt[]; toolActions: ToolAction[] }
export interface TurnLease { sessionId: string; turnId: string; holder: string; fence: number }
export interface CompletedAttempt {
  id: string; text: string; toolCalls: ToolCall[]; finishReason: "stop" | "tool_calls" | "length";
  usage: { inputTokens: number; outputTokens: number }; evidenceDigest: string;
}

/** Portable, integrity-checked copy of one settled session. Contains private chat content: it must only ever be stored encrypted. */
export interface SessionSnapshot {
  requestId: string; detail: SessionDetail;
  /** Digests as stored by the exporting journal; restore must reproduce them from the content, so edits made after export are caught. */
  messageDigests: string[]; turnDigests: string[];
  resolutions: { operationId: string; resolution: "billed" | "not_billed" | "unverified"; resolvedAt: number }[];
}
