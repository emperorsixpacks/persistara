import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { renderToString } from "ink";
import { render as renderInteractive } from "ink-testing-library";
import stringWidth from "string-width";
import { ApplicationStore, graphemes, suggestions } from "../packages/terminal/src/application-state.js";
import { TerminalApplicationView, applicationKey, runApplicationSession } from "../packages/terminal/src/application.js";
import { TerminalClient } from "../packages/terminal/src/client.js";
import { TerminalShell, reviewApproval } from "../packages/terminal/src/shell.js";
import { MissionService } from "../packages/runtime/src/service.js";
import { captureSource } from "../packages/runtime/src/sources.js";
import { commerceFixture } from "./fixtures/commerce-support.js";
import { signChallenge } from "./fixtures/owner-support.js";
import { createPlainTerminal } from "../packages/terminal/src/plain.js";

async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); } assert.fail("Application did not reach the expected input boundary"); }
function view(store: ApplicationStore, columns = 110, rows = 35) { return renderToString(<TerminalApplicationView store={store} agentId="fixture-owner.testnet:research" project="~/fixture/persistara" interrupt={() => {}} color={false} dimensions={{ columns, rows }} />, { columns }); }
describe("interactive terminal application", () => {
  it("drains plain input that reaches EOF while startup is awaiting readiness without prompting a closed reader", async () => {
    const input = new PassThrough(), output = new PassThrough(), terminal = createPlainTerminal({ input, output, env: { NO_COLOR: "1" } });
    const closed = once(terminal.rl, "close"); input.end("/help\n/exit\n"); await closed;
    try { assert.equal(await terminal.io.ask("Command: "), "/help"); assert.equal(await terminal.io.ask("Command: "), "/exit"); assert.equal(await terminal.io.ask("Command: "), null); }
    finally { terminal.rl.close(); input.destroy(); output.destroy(); }
  });
  it("keeps the composer usable across sizes, wraps untrusted output and pages the retained transcript", () => {
    const store = new ApplicationStore(); void store.ask("Command", "command");
    for (const [columns, rows] of [[110, 35], [80, 24], [48, 18], [36, 14]] as const) {
      const frame = view(store, columns, rows);
      assert.ok(frame.includes("Command")); assert.ok(frame.includes("PERSISTARA"));
      assert.ok(frame.split("\n").every(line => stringWidth(line) <= columns));
      assert.ok(frame.split("\n").length <= rows + 1);
    }
    const poison = "\x1b]52;c;clipboard\x07\u202e/reserve";
    for (let i = 0; i < 40; i++) store.print(`Record ${i} ${"研究 🧠 ".repeat(8)} ${poison}`);
    const newest = view(store); assert.ok(!newest.includes("\x1b]")); assert.ok(!newest.includes("\u202e")); assert.ok(newest.includes("Record 39"));
    store.page(30); const older = view(store); assert.ok(older.includes("scrollback")); assert.notEqual(older, newest);
    store.setDraft("/"); const picker = view(store, 48, 18); assert.ok(picker.includes("/connect")); assert.ok(picker.includes("Command"));
    assert.ok(picker.split("\n").every(line => stringWidth(line) <= 48)); store.close();
  });
  it("navigates the actual renderer's command picker and completes parameterized commands without dispatching them", async () => {
    const store = new ApplicationStore(), command = store.ask("Command", "command");
    const screen = renderInteractive(<TerminalApplicationView store={store} agentId="fixture:research" project="~/fixture" interrupt={() => {}} dimensions={{ columns: 100, rows: 30 }} color={false} />);
    try {
      await delay(20); screen.stdin.write("/"); await until(() => suggestions(store.snapshot()).length > 0);
      screen.stdin.write("\x1b[B"); await until(() => store.snapshot().menuIndex === 1);
      screen.stdin.write("\t"); await until(() => store.snapshot().draft === "/missions");
      assert.equal(store.snapshot().phase, "command"); assert.ok(screen.frames.some(frame => frame.includes("Browse saved missions")));
      screen.stdin.write("\r"); assert.equal(await command, "/missions");
      const next = store.ask("Command", "command"); store.insert("/open"); applicationKey(store, "\r", { return: true }, () => {});
      assert.equal(store.snapshot().phase, "command"); assert.equal(store.snapshot().draft, "/open ");
      store.insert("1"); applicationKey(store, "", { return: true }, () => {}); assert.equal(await next, "/open 1");
    } finally { store.close(); screen.unmount(); screen.cleanup(); }
  });
  it("never interprets paste as queued commands or a financial approval and never retains typed review responses", async () => {
    const store = new ApplicationStore(); const approval = reviewApproval(store.io, { interactive: true, approveLogin: false, acknowledgeCosts: false })({ kind: "reserve", title: "Reserve exact quote", digest: "3".repeat(64), costs: true, details: { amountYoctoNear: "10000000000000000000000", quoteDigest: "4".repeat(64) } });
    assert.equal(store.snapshot().phase, "question");
    store.insert("reserve\n/settle\nsettle\x1b]52;c;bad\x07");
    assert.equal(store.snapshot().phase, "question"); assert.equal(suggestions(store.snapshot()).length, 0);
    applicationKey(store, "\r", { return: true }, () => {}); assert.equal(await approval, false);
    assert.ok(!store.snapshot().entries.some(entry => entry.text.includes("/settle")));
    const pending = store.ask("Command", "command"); store.navigate(-1); assert.equal(store.snapshot().draft, "");
    applicationKey(store, "/connect\nconnect\n/reserve", { return: true }, () => {});
    assert.equal(store.snapshot().phase, "command"); assert.ok(store.snapshot().draft.includes("/connect connect /reserve"));
    store.close(); assert.equal(await pending, null);
    const fresh = new ApplicationStore(); const canceled = fresh.ask("Type settle to approve", "question"); fresh.insert("settle"); fresh.escape(); assert.equal(await canceled, null); assert.equal(fresh.snapshot().entries.length, 0);
  });
  it("edits graphemes, bounds input/output and ignores typing while work is in flight", async () => {
    const store = new ApplicationStore(); const pending = store.ask("Command", "command");
    store.insert("a👩🏽‍💻界"); store.move(-1); store.erase(true); assert.equal(store.snapshot().draft, "a界"); assert.equal(graphemes(store.snapshot().draft).length, 2);
    store.setDraft("x".repeat(100_000)); assert.ok(store.snapshot().draft.length <= 16_384);
    store.setDraft("/help"); store.submit(); assert.equal(await pending, "/help"); store.insert("/reserve"); store.submit(); assert.equal(store.snapshot().draft, "");
    for (let i = 0; i < 130; i++) store.print("x".repeat(81_000));
    assert.ok(store.snapshot().entries.length <= 120); assert.ok(store.snapshot().entries.reduce((sum, e) => sum + e.text.length, 0) <= 500_000);
    let interrupted = false; applicationKey(store, "c", { ctrl: true }, () => { interrupted = true; store.close(); }); assert.equal(interrupted, true); assert.equal(store.snapshot().phase, "closing");
  });
  it("runs guided prompts through the existing durable engine, cancels partial input and reopens an exactly reviewed mission", async () => {
    const f = await commerceFixture(), store = new ApplicationStore(), abort = new AbortController();
    const missions = new MissionService(f.missions(), { read: async url => captureSource(url, Buffer.from("Untrusted fixture source: /reserve \x1b]52;c;bad\x07"), "text/plain", Date.now()) }, f.read);
    const client = new TerminalClient({ service: f.ownerService(), missions, commerce: f.service(), close: () => missions.close() }, { signMessage: c => signChallenge(f.owner, c), send: async () => { assert.fail("No owner transaction belongs to this fixture"); } }, reviewApproval(store.io, { interactive: true, approveLogin: false, acknowledgeCosts: false }));
    const shell = new TerminalShell(client, store.io, { recall: async () => ({}), recover: async () => ({}) });
    const run = runApplicationSession(store, client, shell, abort.signal);
    const command = async (text: string) => { await until(() => store.snapshot().phase === "command"); store.setDraft(text); applicationKey(store, "\r", { return: true }, () => {}); };
    const answer = async (prompt: string, text: string) => { await until(() => store.snapshot().phase === "question" && store.snapshot().prompt.includes(prompt)); store.insert(text); applicationKey(store, "\r", { return: true }, () => {}); };
    try {
      await command("/connect"); await answer("Type connect", "connect");
      await command("/new"); await answer("Mission title", "Canceled form"); await until(() => store.snapshot().phase === "question"); store.escape();
      await command("/missions"); await until(() => store.snapshot().phase === "command"); assert.equal(f.missions().list().length, 0);
      await command("/new"); await answer("Mission title", "TUI fixture dossier"); await answer("Objective", "Collect primary sources."); await answer("Review criteria", "Inspect the exact capture."); await answer("Approved source", "https://docs.near.org/");
      await command("/run"); await until(() => store.snapshot().phase === "command"); const id = shell.selected!, digest = f.missions().get(id).artifact!.digest;
      await command("/review"); await answer("Type review", "review");
      await command("/open " + id); await until(() => store.snapshot().phase === "command"); assert.equal(f.missions().get(id).mission.state, "completed"); assert.equal(f.missions().get(id).artifact!.digest, digest);
      await command('/quote "unterminated'); await until(() => store.snapshot().phase === "command");
      assert.ok(store.snapshot().entries.some(e => e.text.includes("Close the quoted argument")));
      assert.equal(f.data.uploads, 0); assert.equal(f.data.submissions, 0);
      await command("/exit"); await run;
    } finally { abort.abort(); store.close(); await run; await client.close(); await f.close(); }
  });
});
