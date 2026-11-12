import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { readSecret } from "../packages/terminal/src/secret.js";

function run(keys: string[]) {
  const input = new PassThrough(), output = new PassThrough(); let shown = ""; output.on("data", (d) => { shown += d; });
  const result = readSecret("Passphrase: ", input, output);
  for (const k of keys) input.write(k);
  return result.then((value) => ({ value, shown }));
}
describe("hidden secret prompt", () => {
  it("returns what was typed without ever echoing it, and supports backspace", async () => {
    const { value, shown } = await run(["hun", "ter2", "\u007fX", "\r"]);
    assert.equal(value, "hunterX"); assert.ok(!shown.includes("hunter") && !shown.includes("X")); assert.ok(shown.startsWith("Passphrase: "));
  });
  it("cancels on Ctrl+C, and on Ctrl+D only when empty", async () => {
    assert.equal((await run(["abc", "\u0003"])).value, null);
    assert.equal((await run(["\u0004"])).value, null);
    assert.equal((await run(["ab", "\u0004", "c\n"])).value, "abc", "Ctrl+D inside text is ignored");
  });
  it("ignores other control characters and arrow-key sequences, and accepts a pasted line", async () => {
    assert.equal((await run(["pa\u0007ss", "\u001b[A", "\u001b[1;5C", "word 123\n"])).value, "password 123");
  });
});
