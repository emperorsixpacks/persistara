import { readPrivateFile, writePrivateFile } from "../../memory/src/files.js";
import { MAX_BACKUP_FILE_BYTES, newBackupSecret, openConversationBackup, sealConversationBackup } from "../../conversation/src/backup.js";
import type { ConversationJournal } from "../../conversation/src/journal.js";

const secretText = async (path: string) => Buffer.from(await readPrivateFile(path, 512)).toString("utf8").trim();

/** Writes a new encrypted bundle and a separate new secret file (never replaces either), then re-opens the pair to prove it decrypts. */
export async function backupConversations(journal: ConversationJournal, bundlePath: string, secretPath: string): Promise<{ sessions: number; bundleBytes: number }> {
  const sessions = journal.exportSessions(), secret = newBackupSecret();
  const bundle = sealConversationBackup(journal.scope, sessions, secret);
  await writePrivateFile(secretPath, Buffer.from(secret));
  await writePrivateFile(bundlePath, bundle);
  const checked = openConversationBackup(await readPrivateFile(bundlePath, MAX_BACKUP_FILE_BYTES), await secretText(secretPath), journal.scope);
  if (checked.length !== sessions.length) throw new Error("Conversation backup verification failed after writing");
  return { sessions: sessions.length, bundleBytes: bundle.byteLength };
}
/** Authenticates the pair against this workspace's scope without changing any state. */
export async function verifyConversationBackup(journal: ConversationJournal, bundlePath: string, secretPath: string): Promise<{ sessions: number }> {
  return { sessions: openConversationBackup(await readPrivateFile(bundlePath, MAX_BACKUP_FILE_BYTES), await secretText(secretPath), journal.scope).length };
}
/** Restores into a journal with no sessions only. Never merges. */
export async function restoreConversations(journal: ConversationJournal, bundlePath: string, secretPath: string): Promise<{ sessions: number }> {
  const snapshots = openConversationBackup(await readPrivateFile(bundlePath, MAX_BACKUP_FILE_BYTES), await secretText(secretPath), journal.scope);
  return { sessions: journal.restoreSessions(snapshots) };
}
