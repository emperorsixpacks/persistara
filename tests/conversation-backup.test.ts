import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newBackupSecret, openConversationBackup, sealConversationBackup } from "../packages/conversation/src/backup.js";
import { ConversationJournal } from "../packages/conversation/src/journal.js";
import { ConversationRunner } from "../packages/conversation/src/runner.js";
import { createReadOnlyTools } from "../packages/conversation/src/tools.js";
import { backupConversations, restoreConversations, verifyConversationBackup } from "../packages/operator/src/conversation-backup.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { ScriptedProvider, SYNTHETIC, call, callTools, fakeBackend, journalFixture, say, scope } from "./fixtures/conversation-support.js";

/** All content here is SYNTHETIC: scripted provider replies and fake mission data, never a real model or owner secret. */
const SECRET_TEXT = "private-owner-question-xyz";
async function populated() {
  const f = await journalFixture(), provider = new ScriptedProvider([callTools(call("c1", "mission_list")), say(`${SYNTHETIC}: one mission`), () => { throw new ProviderError("TIMEOUT", "timed out", true); }]);
  const run = (id: string, text: string) => new ConversationRunner({ journal: f.journal(), provider, tools: createReadOnlyTools(fakeBackend().backend), model: "synthetic-model" }).runTurn(id, randomUUID(), text);
  const one = f.journal().createSession(randomUUID(), "First"), two = f.journal().createSession(randomUUID(), "Second");
  await run(one.id, `${SECRET_TEXT} what missions?`);
  const lost = await run(two.id, "this request will be lost");
  assert.equal(lost.state, "unknown");
  f.journal().resolveUnknown(lost.unknownAttempt!, "unverified");
  const dir = await mkdtemp(join(tmpdir(), "persistara-convbackup-")); await chmod(dir, 0o700);
  return { f, one, two, dir, bundle: join(dir, "chat.bundle"), secret: join(dir, "chat.secret"), done: async () => { await f.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function emptyJournal(dir: string, overrideScope = scope) { return new ConversationJournal(join(dir, `restore-${randomUUID()}.sqlite`), overrideScope); }

describe("encrypted conversation backup (offline, synthetic)", () => {
  it("round-trips sessions, tool history and owner resolutions into an empty journal and the restored session stays usable", async () => {
    const t = await populated();
    try {
      const written = await backupConversations(t.f.journal(), t.bundle, t.secret);
      assert.equal(written.sessions, 2);
      const bytes = await readFile(t.bundle), text = bytes.toString("utf8");
      assert.ok(!text.includes(SECRET_TEXT) && !text.includes("one mission") && !text.includes("mission_list"), "no plaintext chat content in the bundle");
      assert.ok(!text.includes((await readFile(t.secret, "utf8")).trim()), "secret is never inside the bundle");
      const target = await emptyJournal(t.dir);
      try {
        assert.deepEqual(await verifyConversationBackup(target, t.bundle, t.secret), { sessions: 2 });
        assert.equal(target.listSessions().length, 0, "verify changes nothing");
        assert.deepEqual(await restoreConversations(target, t.bundle, t.secret), { sessions: 2 });
        for (const id of [t.one.id, t.two.id]) assert.deepEqual(target.get(id), t.f.journal().get(id));
        assert.deepEqual(target.exportSessions(), t.f.journal().exportSessions());
        assert.equal(target.get(t.two.id).attempts[0]!.state, "unknown"); assert.equal(target.get(t.two.id).attempts[0]!.usage, null);
        assert.ok(target.beginTurn(t.one.id, randomUUID(), "continue after restore", randomUUID()).lease);
        assert.ok(target.beginTurn(t.two.id, randomUUID(), "resolved unknown does not fence", randomUUID()).lease);
      } finally { target.close(); }
    } finally { await t.done(); }
  });

  it("never replaces existing backup files and refuses to restore into a journal that already has sessions", async () => {
    const t = await populated();
    try {
      await backupConversations(t.f.journal(), t.bundle, t.secret);
      await assert.rejects(backupConversations(t.f.journal(), t.bundle, t.secret));
      assert.equal((await readFile(t.bundle)).byteLength > 0, true);
      await assert.rejects(restoreConversations(t.f.journal(), t.bundle, t.secret), { code: "OPERATION_CONFLICT" });
      assert.equal(t.f.journal().listSessions().length, 2);
    } finally { await t.done(); }
  });

  it("fails closed for a wrong secret, another agent's scope, tampering, a dropped session or a swapped session", async () => {
    const t = await populated();
    try {
      const snapshots = t.f.journal().exportSessions(), secret = newBackupSecret(), bundle = sealConversationBackup(scope, snapshots, secret);
      assert.equal(openConversationBackup(bundle, secret, scope).length, 2);
      assert.throws(() => openConversationBackup(bundle, newBackupSecret(), scope), { code: "VERIFICATION_FAILED" });
      assert.throws(() => openConversationBackup(bundle, secret, { ...scope, agentId: "owner.testnet:other" }), { code: "VERIFICATION_FAILED" });
      assert.throws(() => openConversationBackup(bundle, secret, { ...scope, codeHash: "different" }), { code: "VERIFICATION_FAILED" });
      const parsed = JSON.parse(Buffer.from(bundle).toString("utf8")) as { sessions: { id: string; wrapped: string }[] };
      const reseal = (value: unknown) => Buffer.from(JSON.stringify(value));
      assert.throws(() => openConversationBackup(reseal({ ...parsed, sessions: parsed.sessions.slice(1) }), secret, scope), { code: "VERIFICATION_FAILED" });
      assert.throws(() => openConversationBackup(reseal({ ...parsed, sessions: [parsed.sessions[1], parsed.sessions[0]] }), secret, scope), { code: "VERIFICATION_FAILED" });
      assert.throws(() => openConversationBackup(reseal({ ...parsed, sessions: [parsed.sessions[0], { ...parsed.sessions[1]!, id: parsed.sessions[0]!.id }] }), secret, scope), { code: "VERIFICATION_FAILED" });
      const flipped = Buffer.from(bundle); const at = flipped.indexOf(Buffer.from(parsed.sessions[0]!.wrapped)) + 40; flipped[at] = flipped[at] === 65 ? 66 : 65;
      assert.throws(() => openConversationBackup(flipped, secret, scope), { code: "VERIFICATION_FAILED" });
      assert.throws(() => openConversationBackup(Buffer.from("{}"), secret, scope), { code: "INVALID_INPUT" });
      assert.throws(() => openConversationBackup(bundle, "persistara-recovery-v1:" + "A".repeat(43), scope), { code: "INVALID_INPUT" }, "a memory recovery secret is not accepted here");
    } finally { await t.done(); }
  });

  it("rolls the whole restore back when a decrypted session fails the journal's integrity checks", async () => {
    const t = await populated();
    try {
      const [first, second] = t.f.journal().exportSessions();
      const forged = structuredClone(second!);
      const assistant = forged.detail.messages.find((entry) => entry.message.role === "user")!; (assistant.message as { content: string }).content = "tampered after digest";
      const target = await emptyJournal(t.dir);
      try {
        assert.throws(() => target.restoreSessions([first!, forged]), { code: "INTEGRITY_FAILED" });
        assert.equal(target.listSessions().length, 0, "nothing from the failed restore remains");
        assert.equal(target.restoreSessions([first!, second!]), 2, "an intact backup still restores afterwards");
      } finally { target.close(); }
    } finally { await t.done(); }
  });

  it("will not export while a turn is running and keeps secrets out of group-readable files", async () => {
    const t = await populated();
    try {
      const busy = t.f.journal().createSession(randomUUID(), "Busy");
      assert.ok(t.f.journal().beginTurn(busy.id, randomUUID(), "in flight", randomUUID()).lease);
      assert.throws(() => t.f.journal().exportSessions(), { code: "OPERATION_CONFLICT" });
      t.f.advance(); // the lease expires with no dispatched request, so the turn ends failed and the export may proceed
      assert.equal(t.f.journal().exportSessions().length, 3);
      await writeFile(join(t.dir, "open.secret"), newBackupSecret(), { mode: 0o644 });
      await assert.rejects(verifyConversationBackup(t.f.journal(), t.bundle, join(t.dir, "open.secret")));
    } finally { await t.done(); }
  });
});
