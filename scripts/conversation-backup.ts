#!/usr/bin/env node
import { resolve } from "node:path";
import { ConversationJournal } from "../packages/conversation/src/journal.js";
import { conversationStateDir } from "../packages/operator/src/conversation.js";
import { backupConversations, restoreConversations, verifyConversationBackup } from "../packages/operator/src/conversation-backup.js";
import { createLocalWorkspace } from "../packages/operator/src/workspace.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { assertRuntime } from "../packages/protocol/src/config.js";
import { loadEnvironment, printFailure } from "./common.js";

function args(argv: string[]) {
  const result = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!name || !["--bundle", "--secret-file", "--project"].includes(name) || !value || value.startsWith("--") || result.has(name)) throw new ProviderError("INVALID_INPUT", "Invalid or duplicate conversation backup argument");
    result.set(name, value);
  }
  return result;
}
async function main() {
  assertRuntime();
  const [command, ...rest] = process.argv.slice(2), options = args(rest);
  if (!["backup", "verify", "restore"].includes(command ?? "")) throw new ProviderError("INVALID_INPUT", "Use: conversation-backup backup|verify|restore --bundle <file> --secret-file <file> [--project <dir>]");
  const bundle = options.get("--bundle"), secret = options.get("--secret-file");
  if (!bundle || !secret || resolve(bundle) === resolve(secret)) throw new ProviderError("INVALID_INPUT", "Provide separate --bundle and --secret-file paths");
  process.chdir(options.get("--project") ?? process.cwd()); loadEnvironment();
  const workspace = await createLocalWorkspace();
  const journal = new ConversationJournal(resolve(conversationStateDir, "conversations.sqlite"), workspace.missions.journal.scope);
  try {
    if (command === "backup") console.log(JSON.stringify({ status: "conversation-backup-written-and-reopened", ...(await backupConversations(journal, bundle, secret)), note: "Store the bundle and the secret in separate protected locations. This is not a memory or NEAR key backup." }));
    else if (command === "verify") console.log(JSON.stringify({ status: "conversation-backup-authenticated", ...(await verifyConversationBackup(journal, bundle, secret)) }));
    else console.log(JSON.stringify({ status: "conversations-restored", ...(await restoreConversations(journal, bundle, secret)) }));
  } finally { journal.close(); }
}
main().catch((error) => { printFailure(error); process.exitCode = 1; });
