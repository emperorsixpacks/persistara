import type { Readable, Writable } from "node:stream";

/**
 * Reads one secret line without echoing it. Backspace edits, Ctrl+C or Ctrl+D (on empty input) cancels and returns null.
 * Works on a real TTY (raw mode) and on a plain stream (tests, pipes). The text never reaches the output stream.
 */
export function readSecret(prompt: string, input: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown } = process.stdin, output: Writable = process.stdout): Promise<string | null> {
  return new Promise((resolve) => {
    let value = ""; let done = false;
    const raw = Boolean(input.isTTY && input.setRawMode);
    output.write(prompt);
    const finish = (result: string | null) => {
      if (done) return; done = true;
      input.removeListener("data", onData); input.removeListener("end", onEnd);
      if (raw) input.setRawMode!(false);
      input.pause(); output.write("\n"); resolve(result);
    };
    const onEnd = () => finish(value.length ? value : null);
    let escape = 0; // 0 none, 1 after ESC, 2 inside a CSI sequence (arrow keys etc.): skipped, never typed into the secret
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (escape === 1) { escape = ch === "[" || ch === "O" ? 2 : 0; continue; }
        if (escape === 2) { if (ch >= "@" && ch <= "~") escape = 0; continue; }
        if (ch === "\u001b") { escape = 1; continue; }
        if (ch === "\r" || ch === "\n") return finish(value);
        if (ch === "\u0003") return finish(null);
        if (ch === "\u0004" && value.length === 0) return finish(null);
        if (ch === "\u007f" || ch === "\b") { value = [...value].slice(0, -1).join(""); continue; }
        if (ch >= " " && ch !== "\u007f") value += ch;
      }
    };
    if (raw) input.setRawMode!(true);
    input.on("data", onData); input.on("end", onEnd); input.resume();
  });
}
