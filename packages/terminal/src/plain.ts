import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { completeCommand, terminalColor, terminalOutput } from "./render.js";
import type { TerminalIO } from "./shell.js";

/** EOF may arrive during an awaited startup read; drain queued lines without reopening readline. */
export function createPlainTerminal(options: { input?: Readable; output?: Writable; env?: Record<string, string | undefined> } = {}) {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const tty = "isTTY" in input && input.isTTY === true && "isTTY" in output && output.isTTY === true;
  const color = terminalColor(tty, options.env ?? process.env);
  const rl = createInterface({ input, output, terminal: tty, historySize: 0, completer: completeCommand }), lines = rl[Symbol.asyncIterator]();
  let closed = false; rl.once("close", () => { closed = true; });
  const io: TerminalIO = {
    print: (text, tone) => { output.write(terminalOutput(text, tone, color) + "\n"); },
    ask: async prompt => {
      if (!closed) { rl.setPrompt(terminalOutput(prompt, "brand", color)); rl.prompt(); }
      const next = await lines.next(); return next.done ? null : next.value;
    },
  };
  return { io, rl };
}
