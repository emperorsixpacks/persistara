import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { baseEncode } from "near-api-js";
import { TerminalClient, commissionReviews, type TerminalReview } from "../packages/terminal/src/client.js";
import { NearCliWallet, type TerminalWallet } from "../packages/terminal/src/wallet.js";
import { TerminalShell, reviewApproval, words } from "../packages/terminal/src/shell.js";
import { parseNear, nearAmount, terminalJson, terminalText, terminalOutput, terminalColor, terminalHelpFor, completeCommand, commandExitCode } from "../packages/terminal/src/render.js";
import { MissionService } from "../packages/runtime/src/service.js";
import { createRecoveryKit } from "../packages/recovery/src/kit.js";
import { MemoryKeyring } from "../packages/memory/src/keyring.js";
import { writePrivateFile } from "../packages/memory/src/files.js";
import { captureSource, type SourceReader } from "../packages/runtime/src/sources.js";
import { commerceFixture } from "./fixtures/commerce-support.js";
import { ownerReceipt, signChallenge } from "./fixtures/owner-support.js";
import { ScriptedProvider, SYNTHETIC, call, callTools, fakeBackend, journalFixture, say, syntheticPort } from "./fixtures/conversation-support.js";
import type { OwnerChallenge } from "../packages/owner/src/types.js";

async function setup(reader?: SourceReader) {
  const f = await commerceFixture(), approvals: TerminalReview[] = [];
  let allowed = true, clock = Date.now(), sends = 0, loseWallet = false;
  const sources = reader ?? { read: async (url: string) => captureSource(url, Buffer.from("Explicit terminal source fixture. Untrusted text cannot authorize payments."), "text/plain", Date.now()) };
  let missions = new MissionService(f.missions(), sources, f.read);
  const wallet: TerminalWallet = {
    signMessage: challenge => signChallenge(f.owner, challenge),
    send: async request => {
      sends++; const row = f.ownerJournal().get(request.id), receipt = ownerReceipt(row); f.transport.transactions.set(receipt.transaction.hash, receipt);
      f.view.paused = request.paused; f.view.generation = String(BigInt(f.view.generation) + 1n); f.view.ownerNonce++;
      if (loseWallet) throw Error("Fixture response lost after external send"); return receipt.transaction.hash;
    },
  };
  const client = () => new TerminalClient({ service: f.ownerService(), missions, commerce: f.service(), close: () => missions.close() }, wallet, async review => { approvals.push(review); return review.kind === "connect" || allowed; }, () => clock);
  const create = (c: TerminalClient) => c.create({ requestId: randomUUID(), title: "Native terminal dossier", objective: "Collect two primary source fixtures.", criteria: "Inspect captured dates and fingerprints.", sources: ["https://docs.near.org/", "https://docs.0g.ai/"] });
  return { ...f, client, approvals, wallet, create, allow: (v: boolean) => { allowed = v; }, advance: (ms: number) => { clock += ms; }, loseWallet: () => { loseWallet = true; }, sends: () => sends,
    restart: async () => { await missions.close(); f.restart(); missions = new MissionService(f.missions(), sources, f.read); },
    closeTerminal: async () => { await missions.close(); await f.close(); } };
}
describe("native owner terminal workflow", () => {
  it("requires a distinct original-owner login and fails closed on wrong keys, expiry and changed authority", async () => {
    const f = await setup();
    try {
      const c = f.client(); assert.equal((await c.status()).authenticated, false); await assert.rejects(c.list()); assert.equal(f.data.submissions, 0);
      const wrong = new TerminalClient(c.services, { ...f.wallet, signMessage: challenge => signChallenge(f.runtime, challenge) }, async () => true);
      await assert.rejects(wrong.connect());
      await c.connect(); assert.equal((await c.status()).authenticated, true);
      assert.ok(f.approvals[0]!.details.recipient!.startsWith("persistara-cli:v1:testnet:"));
      f.advance(601_000); await assert.rejects(c.create({})); assert.equal(c.authenticated(), false);
      await c.connect(); f.view.ownerKey = f.worker.getPublicKey().toString(); assert.equal((await c.status()).authenticated, false); await assert.rejects(c.list());
      f.view.ownerKey = f.owner.getPublicKey().toString(); f.view.contractId = "other.testnet"; await assert.rejects(c.connect());
      assert.equal(f.data.uploads, 0); assert.equal(f.sends(), 0);
    } finally { await f.closeTerminal(); }
  });
  it("creates, runs, inspects and reviews the same durable mission after a fresh terminal connection", async () => {
    const f = await setup();
    try {
      let c = f.client(); await c.connect(); const created = await f.create(c), id = created.mission.id;
      const run = await c.run(id); assert.equal(run.mission.state, "awaiting_review"); assert.equal(run.artifact!.value.sources.length, 2);
      f.allow(false); await assert.rejects(c.review(id)); assert.equal((await c.detail(id)).mission.state, "awaiting_review");
      f.allow(true); const reviewed = await c.review(id); assert.equal(reviewed.mission.state, "completed");
      assert.equal(f.approvals.at(-1)!.digest, run.artifact!.digest); assert.equal(f.data.uploads, 0); assert.equal(f.data.submissions, 0);
      await c.close(); await f.restart(); c = f.client(); await c.connect(); const reopened = await c.detail(id);
      assert.equal(reopened.artifact!.digest, run.artifact!.digest); assert.equal(reopened.mission.state, "completed"); assert.equal((await c.list()).length, 1);
    } finally { await f.closeTerminal(); }
  });
  it("stops an interrupted source worker and resumes only the uncommitted source with the same mission", async () => {
    const calls: string[] = []; let secondStarted!: () => void, delay = true;
    const started = new Promise<void>(resolve => { secondStarted = resolve; });
    const f = await setup({ read: async (url, signal) => {
      calls.push(url);
      if (url.includes("0g.ai") && delay) { secondStarted(); await new Promise<void>((_r, reject) => signal.addEventListener("abort", () => reject(Error("Fixture worker stopped")), { once: true })); }
      return captureSource(url, Buffer.from("Retained terminal source fixture."), "text/plain", Date.now());
    } });
    try {
      let c = f.client(); await c.connect(); const m = await f.create(c); await c.run(m.mission.id, false); await started; await c.close();
      assert.equal(f.missions().get(m.mission.id).mission.state, "interrupted"); assert.equal(f.missions().get(m.mission.id).mission.capturedCount, 1);
      delay = false; await f.restart(); c = f.client(); await c.connect(); const result = await c.run(m.mission.id);
      assert.equal(result.mission.state, "awaiting_review"); assert.equal(calls.filter(u => u.includes("near.org")).length, 1); assert.equal(calls.filter(u => u.includes("0g.ai")).length, 2);
    } finally { await f.closeTerminal(); }
  });
  it("binds separate exact-cost/delivery reviews, preserves unknown effects and observes one finalized payout", async () => {
    const f = await setup();
    try {
      const c = f.client(); await c.connect(); const m = await f.create(c), created = await c.commission(m.mission.id, "10000000000000000000000");
      await c.importQuote(created.id, await f.quote(await c.request(created.id)));
      f.allow(false); await assert.rejects(c.reserve(created.id)); assert.equal(f.data.uploads, 0); assert.equal(f.data.submissions, 0);
      const quoted = await c.commissionView(created.id); assert.equal(f.approvals.at(-1)!.digest, commissionReviews(quoted).reservation);
      f.allow(true); f.data.loseUpload = true; let value = await c.reserve(created.id); assert.equal(value.state, "brief_ready"); assert.equal(f.data.submissions, 0);
      value = await c.reserve(created.id); assert.equal(value.state, "funded"); assert.equal(f.data.uploads, 1); assert.equal(f.data.submissions, 1);
      f.data.loseUpload = false;
      await c.importDelivery(created.id, await f.delivery(created.id));
      f.allow(false); await assert.rejects(c.settle(created.id)); assert.equal(f.data.submissions, 1);
      f.allow(true); f.data.autoPay = false; value = await c.settle(created.id); assert.equal(value.state, "payout_pending"); assert.equal(f.data.submissions, 2);
      await c.settle(created.id); assert.equal(f.data.submissions, 2);
      f.data.job!.status = "paid"; value = await c.reconcile(created.id); assert.equal(value.state, "paid"); assert.equal(value.receipt.payoutAttempt, "1"); assert.equal((await c.detail(m.mission.id)).mission.state, "completed");
    } finally { await f.closeTerminal(); }
  });
  it("keeps a lost external owner-wallet response fenced across terminal restart and reconciles its fixed receipt", async () => {
    const f = await setup();
    try {
      let c = f.client(); await c.connect(); f.loseWallet(); const pending = await c.ownerChange(true);
      assert.ok("state" in pending); assert.equal(pending.state, "dispatched"); assert.equal(f.sends(), 1);
      await c.close(); await f.restart(); c = f.client(); await c.connect(); await assert.rejects(c.ownerChange(true)); assert.equal(f.sends(), 1);
      const hash = [...f.transport.transactions.keys()][0]!; const row = await c.reconcileOwner(pending.request.id, hash); assert.equal(row.state, "confirmed"); assert.equal(f.sends(), 1);
    } finally { await f.closeTerminal(); }
  });
  it("rechecks authority/session after review before dispatching a new financial effect", async () => {
    const f = await setup();
    try {
      const base = f.client(), c = new TerminalClient(base.services, f.wallet, async review => { if (review.kind === "reserve") f.view.paused = true; return true; });
      await c.connect(); const m = await f.create(c), created = await c.commission(m.mission.id, "10000000000000000000000"); await c.importQuote(created.id, await f.quote(await c.request(created.id)));
      await assert.rejects(c.reserve(created.id)); assert.equal(f.data.uploads, 0); assert.equal(f.data.submissions, 0);
    } finally { await f.closeTerminal(); }
  });
});
describe("terminal presentation and external signing boundary", () => {
  it("keeps pending and failed economic outcomes distinct from successful command completion", () => {
    assert.equal(commandExitCode(["owner", "pause"], { state: "dispatched" }), 3);
    assert.equal(commandExitCode(["commission", "settle"], { state: "payout_pending" }), 3);
    assert.equal(commandExitCode(["commission", "settle"], { state: "delivery_ready", reviewed: true, failureCode: null }), 3);
    assert.equal(commandExitCode(["commission", "settle"], { state: "payout_failed" }), 1);
    assert.equal(commandExitCode(["commission", "settle"], { state: "paid" }), 0);
    assert.equal(commandExitCode(["commission", "show"], { state: "payout_pending" }), 0);
    assert.equal(commandExitCode(["mission", "run"], { mission: { state: "blocked" } }), 1);
  });
  it("without AI enablement, ordinary text makes zero model calls, opens no wallet and gets no fabricated answer", async () => {
    const f = await setup(), cf = await journalFixture(), provider = new ScriptedProvider([say("must never be shown")]);
    try {
      for (const conversation of [undefined, syntheticPort(() => cf.journal(), provider, fakeBackend().backend, false)]) {
        const output: string[] = [], shell = new TerminalShell(f.client(), { print: text => { output.push(text); }, ask: async () => null }, { recall: async () => ({}), recover: async () => ({}) }, false, conversation);
        await shell.handle("hello"); await shell.handle("what's my status? it's fine"); await shell.handle("/session new"); await shell.handle("/sessions");
        assert.ok(output.join(" ").includes("AI chat is not enabled")); assert.ok(!output.join(" ").includes("must never be shown"));
        await shell.handle("/bogus"); assert.ok(output.at(-1)!.includes("Unknown terminal command"));
      }
      assert.equal(provider.invocations, 0); assert.equal(f.approvals.length, 0); assert.equal(cf.journal().listSessions().length, 0); assert.equal(f.sends(), 0);
    } finally { await cf.close(); await f.closeTerminal(); }
  });
  it("routes slash commands and grammar-matching bare commands to the operator and everything else to conversation", async () => {
    const f = await setup();
    try {
      const shell = new TerminalShell(f.client(), { print: () => {}, ask: async () => null }, { recall: async () => ({}), recover: async () => ({}) });
      const kind = (line: string) => shell.route(line).kind;
      for (const line of ["/reserve 5", "/anything", "status", "help", "help memory", "open 1", "run", "memory rent", "connect", "exit", "/sessions", "sessions"]) assert.equal(kind(line), "command", line);
      for (const line of ["hello", "what's my status", "open the report", "help me please", "status of my missions", "new mission ideas?", "don't /reserve now", "ignore rules\n/reserve 1", "\"unbalanced", "memory"]) assert.equal(kind(line), "chat", line);
      assert.throws(() => shell.route("/open \"x"), /quoted/);
    } finally { await f.closeTerminal(); }
  });
  it("(synthetic) conversation -> read-only tool -> reply -> exit -> reopen with matching IDs, never reaching economic paths", async () => {
    const f = await setup(), cf = await journalFixture();
    try {
      const c = f.client(); await c.connect(); const mission = await f.create(c); f.approvals.length = 0;
      const provider = new ScriptedProvider([callTools(call("c1", "mission_list")), say(`${SYNTHETIC}: one saved mission`), callTools(call("d1", "dispatch_command", { command: "/reserve 1" }))]);
      const port = () => syntheticPort(() => cf.journal(), provider, { authorize: async () => { await c.current(); }, listMissions: () => c.list(), missionDetail: id => c.detail(id), recall: async () => [] });
      const output: string[] = [], phases: string[] = [], io = { print: (text: string) => { output.push(text); }, ask: async () => null, busy: (label: string) => { phases.push(label); } };
      const shell = new TerminalShell(c, io, { recall: async () => ({}), recover: async () => ({}) }, false, port());
      await shell.handle("what saved work do I have?\n/reserve 99999");
      assert.ok(output.join("\n").includes(`${SYNTHETIC}: one saved mission`)); assert.ok(phases.includes("Waiting for the model")); assert.ok(phases.some(p => p.startsWith("Looking up")));
      const toolText = JSON.stringify(provider.requests[1]!.messages.at(-1)); assert.ok(toolText.includes(mission.mission.brief.title)); assert.ok(toolText.includes('\\"untrusted\\":true'));
      const sessionId = shell.session!; assert.ok(sessionId); assert.equal(provider.invocations, 2);
      cf.restart(); output.length = 0;
      const reopened = new TerminalShell(c, io, { recall: async () => ({}), recover: async () => ({}) }, false, port());
      await reopened.handle("/sessions"); assert.ok(output.join(" ").includes(sessionId.slice(-8)));
      await reopened.handle("/session open 1"); assert.equal(reopened.session, sessionId);
      assert.ok(output.join("\n").includes("You: what saved work do I have?")); assert.ok(output.join("\n").includes(`${SYNTHETIC}: one saved mission`));
      output.length = 0; await reopened.handle("please reserve funds");
      assert.ok(output.join(" ").includes("No answer was saved")); // synthetic model asked for an unadvertised tool; provider-side validation refused it
      assert.equal(f.approvals.length, 0); assert.equal(f.sends(), 0); assert.equal(f.data.uploads, 0);
    } finally { await cf.close(); await f.closeTerminal(); }
  });
  it("rechecks the original owner before conversation work and makes no model call when authority changed", async () => {
    const f = await setup(), cf = await journalFixture(), provider = new ScriptedProvider([say("never")]);
    try {
      const c = f.client(); await c.connect();
      const shell = new TerminalShell(c, { print: () => {}, ask: async () => null }, { recall: async () => ({}), recover: async () => ({}) }, false, syntheticPort(() => cf.journal(), provider, fakeBackend().backend));
      f.view.ownerKey = f.worker.getPublicKey().toString();
      await assert.rejects(shell.handle("hello"), /AUTHORIZATION_FAILED|original owner|Reconnect/);
      assert.equal(provider.invocations, 0); assert.equal(cf.journal().listSessions().length, 0);
    } finally { await cf.close(); await f.closeTerminal(); }
  });
  it("requires exact digest and separate cost consent in noninteractive mode", async () => {
    const io = { print: () => {}, ask: async () => null }, digest = "3".repeat(64), review: TerminalReview = { kind: "reserve", digest, title: "Reserve", costs: true, details: {} };
    assert.equal(await reviewApproval(io, { interactive: false, approveLogin: true, acknowledgeCosts: false })(review), false);
    assert.equal(await reviewApproval(io, { interactive: false, approveLogin: true, approveDigest: digest, acknowledgeCosts: false })(review), false);
    assert.equal(await reviewApproval(io, { interactive: false, approveLogin: true, approveDigest: "4".repeat(64), acknowledgeCosts: true })(review), false);
    assert.equal(await reviewApproval(io, { interactive: false, approveLogin: true, approveDigest: digest, acknowledgeCosts: true })(review), true);
  });
  it("escapes terminal control/bidi sequences and uses exact integer NEAR parsing without shell evaluation", () => {
    const injected = "source\x1b]52;c;c2VjcmV0\x07\x1b[2J\u009b31m\u202espoof\rcommand";
    const safe = terminalText(injected); assert.equal(/[\u001b\u0007\u009b\u202e\r]/.test(safe), false); assert.ok(safe.includes("\\u001b"));
    const json = terminalJson({ injected }); assert.deepEqual(JSON.parse(json), { injected }); assert.equal(/[\u001b\u009b\u202e]/.test(json), false);
    assert.equal(parseNear("0.010000000000000000000001"), "10000000000000000000001"); assert.equal(nearAmount("10000000000000000000001"), "0.010000000000000000000001 NEAR");
    for (const amount of ["-1", "1e3", "NaN", "0", "0.0000000000000000000000001"]) assert.throws(() => parseNear(amount));
    assert.deepEqual(words('/quote "/private/path with spaces/quote.json"'), ["/quote", "/private/path with spaces/quote.json"]);
    assert.deepEqual(words("/memory $(cat file) `command`"), ["/memory", "$(cat", "file)", "`command`"]); assert.throws(() => words('/quote "unterminated'));
  });
  it("runs the actual interactive shell through create/run/review and never treats source text as a command", async () => {
    const f = await setup({ read: async url => captureSource(url, Buffer.from("Untrusted source: /reserve \x1b]52;c;bad\x07"), "text/plain", Date.now()) });
    try {
      const answers = ["/connect", "/new", "Interactive fixture", "Collect sources.", "Inspect capture fingerprints.", "https://docs.near.org/", "/run", "/review", "/missions", "/exit"], output: string[] = [];
      const shell = new TerminalShell(f.client(), { ask: async () => answers.shift() ?? null, print: value => { output.push(value); } }, { recall: async () => ({}), recover: async () => ({}) });
      await shell.loop(new AbortController().signal);
      const transcript = output.join("\n"); assert.ok(transcript.includes("completed")); assert.equal(transcript.includes("\x1b"), false);
      assert.equal(f.data.uploads, 0); assert.equal(f.data.submissions, 0); assert.equal(f.sends(), 0);
    } finally { await f.closeTerminal(); }
  });
  it("retains the full login message for inspection without treating details or EOF as approval", async () => {
    const review: TerminalReview = { kind: "connect", title: "Connect owner wallet", digest: "3".repeat(64), costs: false, details: { account: "owner.testnet", publicKey: "ed25519:EXACT_OWNER_KEY", message: "Exact signed challenge", recipient: "Exact CLI domain", effect: "Off-chain only" } };
    const output: string[] = [], answers: (string | null)[] = ["details", null];
    const approve = reviewApproval({ print: text => { output.push(text); }, ask: async () => answers.shift() ?? null }, { interactive: true, approveLogin: false, acknowledgeCosts: false });
    assert.equal(await approve(review), false);
    assert.ok(output[0]!.includes(review.details.publicKey!)); assert.ok(!output[0]!.includes(review.details.message!));
    assert.ok(output[1]!.includes(review.details.message!)); assert.ok(output[1]!.includes(review.details.recipient!)); assert.ok(output[1]!.includes(review.digest));
    const approveTyped = reviewApproval({ print: () => {}, ask: async () => "connect" }, { interactive: true, approveLogin: false, acknowledgeCosts: false });
    assert.equal(await approveTyped(review), true);
    const amounts: string[] = [];
    await reviewApproval({ print: text => { amounts.push(text); }, ask: async () => null }, { interactive: true, approveLogin: false, acknowledgeCosts: false })({ kind: "reserve", title: "Reserve", digest: review.digest, costs: true, details: { amountYoctoNear: "10000000000000000000000", quoteDigest: "4".repeat(64) } });
    assert.ok(amounts[0]!.includes("10000000000000000000000")); assert.ok(amounts[0]!.includes("4".repeat(64))); assert.ok(amounts[0]!.includes(review.digest));
  });
  it("keeps numbered mission selection bound to the displayed saved ID, even after another mission is created", async () => {
    const f = await setup();
    try {
      const c = f.client(); await c.connect(); const first = await f.create(c), output: string[] = [];
      const shell = new TerminalShell(c, { print: text => { output.push(text); }, ask: async () => null }, { recall: async () => ({}), recover: async () => ({}) });
      await shell.dispatch(["missions"]); await f.create(c); await shell.dispatch(["open", "1"]);
      assert.equal(shell.selected, first.mission.id); assert.ok(output[0]!.includes(first.mission.brief.title));
      await assert.rejects(shell.dispatch(["open", "0"])); await assert.rejects(shell.dispatch(["open", "999999999999999999999999"]));
      assert.equal(f.data.submissions, 0); assert.equal(f.data.uploads, 0); assert.equal(f.sends(), 0);
    } finally { await f.closeTerminal(); }
  });
  it("escapes untrusted content before optional styling and keeps default help short without completing paths or source prose", () => {
    const injected = "\x1b]52;c;bad\x07\u202eunsafe";
    const plain = terminalOutput(injected, "brand", false), colored = terminalOutput(injected, "brand", true);
    assert.equal(plain.includes("\x1b"), false); assert.equal(colored.includes("\x1b]"), false); assert.equal(colored.includes("\u202e"), false);
    assert.equal(colored.replace(/\x1b\[[\d;]*m/g, ""), plain);
    assert.equal(terminalColor(true, { NO_COLOR: "" }), false); assert.equal(terminalColor(false, {}), false); assert.equal(terminalColor(true, { TERM: "dumb" }), false); assert.equal(terminalColor(true, {}), true);
    assert.ok(terminalHelpFor().split("\n").length <= 18); assert.ok(terminalHelpFor().split("\n").every(line => line.length < 80));
    assert.ok(terminalHelpFor("missions").includes("/run")); assert.ok(terminalHelpFor("all").includes("--acknowledge-costs"));
    assert.deepEqual(completeCommand("/con"), [["/connect"], "/con"]); assert.deepEqual(completeCommand("/quote /private/"), [[], "/quote /private/"]);
  });
  it("uses only the external keychain message command, verifies the returned identity and parses a bounded transaction receipt", async () => {
    const f = await setup();
    try {
      const challenge: OwnerChallenge = { id: randomBytes(32).toString("base64url"), message: "Native owner login", recipient: "persistara-cli:v1:testnet:authority.testnet:owner.testnet:research", nonce: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000, signerId: f.view.owner, publicKey: f.view.ownerKey, network: "testnet" };
      const proof = await signChallenge(f.owner, challenge), commands: string[][] = [], hash = baseEncode(randomBytes(32));
      const wallet = new NearCliWallet("official-near", async (_binary, args) => { commands.push(args); return args[0] === "message" ? { stdout: JSON.stringify({ ...proof, signature: "ed25519:" + baseEncode(Buffer.from(proof.signature, "base64")) }), stderr: "" } : { stdout: "", stderr: `Transaction ID: ${hash}\nhttps://testnet.nearblocks.io/txns/${hash}` }; });
      assert.deepEqual(await wallet.signMessage(challenge), proof); assert.equal(commands[0]!.includes("sign-with-keychain"), true); assert.equal(commands[0]!.join(" ").includes(f.owner.toString()), false);
      const request = (await f.ownerService().prepare(true)).operation!.request; assert.equal(await wallet.send(request), hash);
      assert.ok(commands[1]!.includes("--signer-public-key")); assert.ok(commands[1]!.includes("0 NEAR"));
      const wrong = new NearCliWallet("official-near", async () => ({ stdout: JSON.stringify({ ...proof, publicKey: f.runtime.getPublicKey().toString() }), stderr: "" })); await assert.rejects(wrong.signMessage(challenge));
      const unknown = new NearCliWallet("official-near", async () => ({ stdout: "No final receipt", stderr: "" })); await assert.rejects(unknown.send(request), { code: "OUTCOME_UNKNOWN" });
      await assert.rejects(wallet.send({ ...request, network: { kind: "testnet", chainId: "mainnet" } }));
    } finally { await f.closeTerminal(); }
  });
  it("provides offline help and forwards kit verification without loading the original environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "persistara-cli-offline-"));
    try {
      await writeFile(join(directory, ".env"), "NEAR_RUNTIME_KEY_FILE=/must-not-open\nZG_UPLOADER_KEY_FILE=/must-not-open\n");
      const cli = resolve("dist/scripts/cli.js"), help = await promisify(execFile)(process.execPath, [cli, "--project", directory, "--help"], { env: {} });
      assert.ok(help.stdout.includes("/new")); assert.ok(help.stdout.includes("No AI chat"));
      const f = await setup();
      try {
        const kit = await createRecoveryKit({ scope: f.scope, ownerKey: f.view.ownerKey, binding: { agentId: f.scope.agentId, authorityNetwork: "near:testnet", chainId: "testnet", contractId: f.scope.contractId, storageNetwork: "0g:16602:turbo" }, keys: MemoryKeyring.create(), recipient: null, commissions: [], checkpoint: null });
        await writePrivateFile(join(directory, "owner.kit"), kit.bundle); await writePrivateFile(join(directory, "kit.secret"), Buffer.from(kit.secret));
        const verified = await promisify(execFile)(process.execPath, [cli, "--project", directory, "recovery", "verify", "--kit", join(directory, "owner.kit"), "--secret-file", join(directory, "kit.secret"), "--expect-sha256", kit.digest], { env: {} });
        assert.equal(JSON.parse(verified.stdout).originalEnvironmentLoaded, false); assert.equal(verified.stdout.includes(kit.secret), false);
        await writeFile(join(directory, ".env"), `NEAR_OWNER_ACCOUNT=${f.config.signerId}\nNEAR_AUTHORITY_CONTRACT=${f.config.contractId}\nNEAR_AGENT_ID=${f.config.agentId}\nNEAR_RUNTIME_PUBLIC_KEY=${f.config.publicKey}\n`);
        await assert.rejects(promisify(execFile)(process.execPath, [cli, "--project", directory, "init"], { env: {} }), (e: unknown) => { assert.equal((e as { code: number }).code, 2); assert.ok((e as { stderr: string }).stderr.includes("contract:build")); return true; });
      } finally { await f.closeTerminal(); }
      await assert.rejects(promisify(execFile)(process.execPath, [cli, "--project", directory, "specialist", "fulfill", "job"], { env: {} }), (e: unknown) => { assert.ok((e as { stderr: string }).stderr.includes("--acknowledge-costs")); return true; });
      await assert.rejects(promisify(execFile)(process.execPath, [cli, "--project", directory, "chat"], { env: {} }), (e: unknown) => { assert.ok((e as { stderr: string }).stderr.includes("AI conversation is not enabled")); return true; });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
