import type { SessionDetail, SessionSummary } from "../../conversation/src/types.js";
import type { TurnResult } from "../../conversation/src/runner.js";

/**
 * What the terminal needs from a conversation backend. The shell never imports the model SDK or constructs a provider;
 * production wiring lives in packages/operator/src/conversation.ts and tests inject clearly labeled synthetic ports.
 */
export interface TerminalConversation {
  /** Pure, offline. When disabled no provider call, journal write or network request may happen. */
  readiness(): { enabled: boolean; message: string };
  list(): Promise<SessionSummary[]>;
  create(): Promise<SessionSummary>;
  open(id: string): Promise<SessionDetail>;
  send(sessionId: string, text: string, hooks: { signal?: AbortSignal; onPhase?: (phase: "model" | "tool", detail?: string) => void }): Promise<TurnResult>;
  close(): void;
}

export const AI_DISABLED_MESSAGE = [
  "AI chat is not enabled in this workspace, so no model request was made and nothing was saved.",
  "Slash commands still work: /help lists them, /missions browses saved work and /memory searches committed memory.",
  "Live AI needs deliberate operator setup and a separate acceptance check; an API key alone does not turn it on.",
].join("\n");

const short = (id: string) => id.slice(-8);
export function sessionListText(rows: SessionSummary[], selected: string | null) {
  if (!rows.length) return "No saved conversations yet. Type a message to start one, or /session new.";
  return ["#  Session   Turns  Title", ...rows.map((row, index) => `${String(index + 1).padEnd(2)} ${row.id === selected ? "›" : " "}${short(row.id)}  ${String(row.turnCount).padEnd(5)}  ${row.title}`), "", "Open one with /session open <number or full ID>."].join("\n");
}
const clipText = (value: string, max: number) => value.length > max ? value.slice(0, max) + "… (shortened)" : value;
/** Saved history as inert text: roles are labels, content is untrusted and escaped by the caller. */
export function transcriptText(detail: SessionDetail, maximumMessages = 24) {
  const names = new Map(detail.toolActions.map((action) => [action.callId + action.turnId, action.name]));
  const shown = detail.messages.slice(-maximumMessages), skipped = detail.messages.length - shown.length;
  const lines = [`Session ${short(detail.session.id)} · ${detail.session.title} · ${detail.turns.length} turn${detail.turns.length === 1 ? "" : "s"}`];
  if (skipped > 0) lines.push(`(${skipped} earlier message${skipped === 1 ? "" : "s"} not shown; they remain saved)`);
  for (const { message, turnId } of shown) {
    if (message.role === "user") lines.push(`You: ${clipText(message.content, 2000)}`);
    else if (message.role === "assistant") lines.push(message.toolCalls?.length ? `Assistant looked up: ${message.toolCalls.map((call) => call.name).join(", ")}` : `Assistant: ${clipText(message.content ?? "", 4000)}`);
    else if (message.role === "tool") lines.push(`  tool result (${names.get(message.toolCallId + turnId) ?? "tool"}) saved`);
  }
  const unknown = detail.attempts.filter((attempt) => attempt.state === "unknown");
  if (unknown.length) lines.push(`Paused: a model request may have been accepted without a recorded result (${unknown.map((attempt) => attempt.operationId).join(", ")}). It was not retried and may have been billed. Start /session new to continue.`);
  return lines.join("\n");
}
export function turnText(result: TurnResult): { text: string; tone?: "success" | "warning" | "muted" } [] {
  const out: { text: string; tone?: "success" | "warning" | "muted" }[] = [];
  const notes: Record<string, string> = {
    OUTPUT_LIMIT: "Reply stopped at the output limit; it is partial, not a finished answer. Nothing was requested again automatically.",
    ROUND_LIMIT: "Stopped at the per-message lookup limit. Nothing was requested again automatically.",
    TOOL_BATCH_LIMIT: "The model asked for more lookups than allowed in one step, so none were run.",
    CONTEXT_LIMIT: "This session is too long to send safely. Nothing was dropped or sent. Use /session new to continue.",
  };
  if (result.reply) out.push({ text: result.reply });
  if (result.state === "unknown") out.push({ text: `A model request may have been accepted, but its outcome was lost (attempt ${result.unknownAttempt}). It was not retried and may have been billed. This session is paused; use /session new to continue.`, tone: "warning" });
  else if (result.state === "failed") out.push({ text: `No answer was saved (${result.failureCode ?? "FAILED"}). ${result.failureCode === "ABORTED" ? "Canceled before sending." : "Nothing was retried automatically; send the message again if you want another request."}`, tone: "warning" });
  else if (result.failureCode && notes[result.failureCode]) out.push({ text: notes[result.failureCode]!, tone: "warning" });
  if (result.replayed) out.push({ text: "This message was already handled; showing the saved result.", tone: "muted" });
  else if (result.usage.knownRounds) out.push({ text: `Known usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens over ${result.usage.knownRounds} request${result.usage.knownRounds === 1 ? "" : "s"}. Not a billing statement.`, tone: "muted" });
  return out;
}
