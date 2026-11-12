#!/usr/bin/env node
/**
 * SYNTHETIC DEMO. No model, key, network, wallet or funds are used: a scripted fake provider plays the model and a fake
 * backend plays saved missions, through the real conversation journal, runner, read-only tools and encrypted backup.
 * It shows the safety behavior, not a real model's answers. Live acceptance of one real request is in docs/evidence/.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationJournal } from "../packages/conversation/src/journal.js";
import { ConversationRunner } from "../packages/conversation/src/runner.js";
import { createReadOnlyTools } from "../packages/conversation/src/tools.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { backupConversations, restoreConversations } from "../packages/operator/src/conversation-backup.js";
import { ScriptedProvider, SYNTHETIC, call, callTools, fakeBackend, say, scope } from "../tests/fixtures/conversation-support.js";

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "persistara-demo-")); await chmod(dir, 0o700);
  const journal = new ConversationJournal(join(dir, "a.sqlite"), scope);
  const provider = new ScriptedProvider([
    callTools(call("c1", "mission_list")), say(`${SYNTHETIC}: you have one saved mission.`),
    () => { throw new ProviderError("TIMEOUT", "synthetic timeout after the request was sent", true); }, say(`${SYNTHETIC}: back again after the owner checked.`),
  ]);
  const run = (sessionId: string, text: string) => new ConversationRunner({ journal, provider, tools: createReadOnlyTools(fakeBackend().backend), model: "SYNTHETIC-MODEL" }).runTurn(sessionId, randomUUID(), text);
  const out: Record<string, unknown> = { fixture: true, note: "Synthetic provider and data; not a real model." };
  try {
    const session = journal.createSession(randomUUID(), "Demo");
    const first = await run(session.id, "what saved missions do I have?");
    const detail = journal.get(session.id);
    out.step1_lookup = { state: first.state, reply: first.reply, modelRequests: provider.invocations, readOnlyToolsCalled: detail.toolActions.map((a) => a.name), toolResultWasMarkedUntrusted: JSON.stringify(detail.messages.at(-2)).includes("untrusted") };
    const lost = await run(session.id, "this request's outcome will be lost");
    out.step2_lostOutcome = { state: lost.state, unknownAttempt: lost.unknownAttempt !== null, costRecordedAsZero: journal.unknownAttempts()[0]?.usage === null ? false : true };
    let blocked = false; try { journal.beginTurn(session.id, randomUUID(), "retry", randomUUID()); } catch { blocked = true; }
    out.step3_sessionFencedAndNotResent = { newMessageRefused: blocked, modelRequestsSoFar: provider.invocations };
    journal.resolveUnknown(lost.unknownAttempt!, "unverified");
    const after = await run(session.id, "continue");
    out.step4_ownerResolvedThenContinues = { state: after.state, attemptStillUnknownInJournal: journal.get(session.id).attempts.some((a) => a.state === "unknown"), modelRequests: provider.invocations };
    const bundle = join(dir, "chat.bundle"), secret = join(dir, "chat.secret");
    const written = await backupConversations(journal, bundle, secret);
    const restored = new ConversationJournal(join(dir, "b.sqlite"), scope);
    try {
      await restoreConversations(restored, bundle, secret);
      out.step5_encryptedBackupRoundTrip = { sessions: written.sessions, bundleContainsPlaintext: (await readFile(bundle, "utf8")).includes("saved missions"), identicalAfterRestore: JSON.stringify(restored.get(session.id)) === JSON.stringify(journal.get(session.id)) };
    } finally { restored.close(); }
  } finally { journal.close(); await rm(dir, { recursive: true, force: true }); }
  console.log(JSON.stringify(out, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "failed"); process.exitCode = 1; });
