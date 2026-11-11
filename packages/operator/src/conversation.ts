import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConversationJournal } from "../../conversation/src/journal.js";
import { ConversationRunner } from "../../conversation/src/runner.js";
import { createReadOnlyTools } from "../../conversation/src/tools.js";
import { NearAiProvider } from "../../inference/src/near-ai.js";
import type { InferenceProvider } from "../../inference/src/provider.js";
import { inferenceConfig } from "../../protocol/src/config.js";
import type { TerminalClient } from "../../terminal/src/client.js";
import { AI_DISABLED_MESSAGE, type TerminalConversation } from "../../terminal/src/conversation.js";
import type { TerminalMemory } from "../../terminal/src/shell.js";
import type { LocalWorkspace } from "./workspace.js";

/** Chat sessions live in their own private journal; they never reuse mission, memory, commission, signer or owner state. */
export const conversationStateDir = ".persistara/conversations/research";

export interface ConversationDeps {
  /** Tests inject a clearly labeled synthetic provider. Production never constructs one. */
  provider?: InferenceProvider; model?: string;
  env?: Record<string, string | undefined>; stateDir?: string; now?: () => number;
}

/**
 * Live inference is off unless the operator sets PERSISTARA_AI_CHAT=enabled AND configures NEARAI_API_KEY and NEARAI_MODEL.
 * A key alone never enables spending. Live acceptance (attestation/E2EE/tool support, cost limits) has not been performed.
 */
export function conversationReadiness(deps: ConversationDeps = {}): { enabled: boolean; message: string; provider?: InferenceProvider; model?: string } {
  if (deps.provider) return { enabled: true, message: "", provider: deps.provider, model: deps.model ?? "injected" };
  const env = deps.env ?? process.env;
  if (env.PERSISTARA_AI_CHAT !== "enabled") return { enabled: false, message: AI_DISABLED_MESSAGE };
  const config = inferenceConfig(env);
  if (!config.apiKey || !config.model) return { enabled: false, message: "AI chat opt-in is set, but NEARAI_API_KEY and a verified TEE model in NEARAI_MODEL are not both configured. No model request was made and nothing was saved. Configure them through protected local files; never paste a key into chat." };
  return { enabled: true, message: "", provider: new NearAiProvider(config), model: config.model };
}

export function terminalConversation(workspace: LocalWorkspace, client: TerminalClient, memory: TerminalMemory, deps: ConversationDeps = {}): TerminalConversation {
  const ready = conversationReadiness(deps);
  let journal: ConversationJournal | null = null;
  const open = () => journal ??= new ConversationJournal(resolve(deps.stateDir ?? conversationStateDir, "conversations.sqlite"), workspace.missions.journal.scope, deps.now);
  return {
    readiness: () => ({ enabled: ready.enabled, message: ready.message }),
    async list() { return open().listSessions(); },
    async create() { return open().createSession(randomUUID()); },
    async open(id) { return open().get(id); },
    async resolve(operationId, resolution) { open().resolveUnknown(operationId, resolution); },
    async send(sessionId, text, hooks) {
      if (!ready.enabled || !ready.provider || !ready.model) throw new Error("AI chat is not enabled");
      const tools = createReadOnlyTools({
        authorize: async () => { await client.current(); },
        listMissions: () => client.list(), missionDetail: (id) => client.detail(id), recall: (query) => memory.recall(query),
      });
      const runner = new ConversationRunner({ journal: open(), provider: ready.provider, tools, model: ready.model, ...(hooks.signal ? { signal: hooks.signal } : {}), ...(hooks.onPhase ? { onPhase: hooks.onPhase } : {}) });
      return runner.runTurn(sessionId, randomUUID(), text);
    },
    close() { journal?.close(); journal = null; },
  };
}
