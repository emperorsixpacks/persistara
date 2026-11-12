import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipboardTools, copyText, osc52 } from "../packages/terminal/src/clipboard.js";

/** Pure tests with injected runners: nothing here touches the real clipboard or terminal. */
const base = { platform: "linux" as NodeJS.Platform, env: {}, isTTY: true };

describe("clipboard copy", () => {
  it("uses the first system tool that confirms success and does not also write a terminal sequence", async () => {
    const calls: string[] = [], written: string[] = [];
    const outcome = await copyText("hello 研究", { ...base, run: async (command) => { calls.push(command); return command === "xsel"; }, write: (data) => { written.push(data); } });
    assert.deepEqual(calls, ["xclip", "xsel"]);
    assert.deepEqual(outcome, { copied: true, confirmed: true, message: "Copied 8 characters to the clipboard (xsel)." });
    assert.deepEqual(written, []);
  });
  it("prefers wl-copy on Wayland and the right native tool per platform", () => {
    assert.equal(clipboardTools("linux", { WAYLAND_DISPLAY: "wayland-0" })[0]![0], "wl-copy");
    assert.equal(clipboardTools("linux", {})[0]![0], "xclip");
    assert.deepEqual(clipboardTools("darwin", {}), [["pbcopy", []]]);
    assert.deepEqual(clipboardTools("win32", {}), [["clip", []]]);
  });
  it("falls back to OSC 52 and says plainly that it cannot confirm it", async () => {
    const written: string[] = [];
    const outcome = await copyText("abc", { ...base, run: async () => false, write: (data) => { written.push(data); } });
    assert.equal(outcome.copied, true); assert.equal(outcome.confirmed, false); assert.ok(outcome.message.includes("cannot confirm") || outcome.message.includes("Terminals cannot confirm"));
    assert.equal(written.length, 1); assert.equal(written[0], `\u001b]52;c;${Buffer.from("abc").toString("base64")}\u0007`);
  });
  it("over SSH only the terminal channel is used, because a system tool would fill the remote clipboard", async () => {
    let ran = 0; const written: string[] = [];
    const outcome = await copyText("remote text", { ...base, env: { SSH_CONNECTION: "1 2 3 4" }, run: async () => { ran++; return true; }, write: (data) => { written.push(data); } });
    assert.equal(ran, 0); assert.equal(written.length, 1); assert.equal(outcome.confirmed, false);
  });
  it("wraps OSC 52 for tmux passthrough", () => {
    const wrapped = osc52("x", { TMUX: "/tmp/tmux" });
    assert.ok(wrapped.startsWith("\u001bPtmux;\u001b\u001b]52;c;") && wrapped.endsWith("\u0007\u001b\\"));
  });
  it("copies nothing for empty text, and reports failure instead of success when no route works", async () => {
    assert.equal((await copyText("  \n", { ...base, run: async () => true })).copied, false);
    const none = await copyText("abc", { ...base, isTTY: false, run: async () => false, write: () => assert.fail("no terminal to write to") });
    assert.equal(none.copied, false); assert.ok(none.message.length > 20);
    const huge = await copyText("x".repeat(80_000), { ...base, run: async () => false, write: () => assert.fail("too large for OSC 52") });
    assert.equal(huge.copied, false); assert.ok(huge.message.includes("too large"));
  });
});
