import { spawn } from "node:child_process";

/**
 * Copies text to the user's clipboard. Two independent routes, and it never claims more than it knows:
 *  - a system tool (wl-copy, xclip, xsel, pbcopy, clip) whose exit status confirms the copy; and
 *  - OSC 52, which asks the terminal to set the clipboard (also works over SSH) but gives no confirmation.
 * Over SSH a system tool would fill the remote machine's clipboard, so only OSC 52 is used there.
 */
export interface CopyOutcome { copied: boolean; confirmed: boolean; message: string }
export interface CopyDeps {
  run?: (command: string, args: string[], input: string) => Promise<boolean>;
  write?: (data: string) => void;
  env?: Record<string, string | undefined>; platform?: NodeJS.Platform; isTTY?: boolean;
}
const OSC52_LIMIT = 74_000;
const SYSTEM_LIMIT = 4_000_000;

export function clipboardTools(platform: NodeJS.Platform, env: Record<string, string | undefined>): [string, string[]][] {
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "win32") return [["clip", []]];
  const tools: [string, string[]][] = [];
  if (env.WAYLAND_DISPLAY) tools.push(["wl-copy", []]);
  tools.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
  if (!env.WAYLAND_DISPLAY) tools.push(["wl-copy", []]);
  tools.push(["clip.exe", []]); // WSL
  return tools;
}
export function osc52(text: string, env: Record<string, string | undefined>): string {
  const sequence = `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
  return env.TMUX ? `\u001bPtmux;${sequence.replace(/\u001b/g, "\u001b\u001b")}\u001b\\` : sequence;
}
const spawnRun = (command: string, args: string[], input: string) => new Promise<boolean>((resolve) => {
  let settled = false; const done = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
  const timer = setTimeout(() => { child.kill(); done(false); }, 2_000);
  const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
  child.on("error", () => done(false)); child.on("close", (code) => done(code === 0));
  child.stdin.on("error", () => done(false)); child.stdin.end(input);
});

export async function copyText(text: string, deps: CopyDeps = {}): Promise<CopyOutcome> {
  const env = deps.env ?? process.env, platform = deps.platform ?? process.platform, run = deps.run ?? spawnRun;
  const write = deps.write ?? ((data: string) => { process.stdout.write(data); }), isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  if (!text.trim()) return { copied: false, confirmed: false, message: "Nothing to copy yet." };
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  if (!remote && Buffer.byteLength(text) <= SYSTEM_LIMIT) {
    for (const [command, args] of clipboardTools(platform, env)) {
      if (await run(command, args, text)) return { copied: true, confirmed: true, message: `Copied ${text.length} characters to the clipboard (${command}).` };
    }
  }
  if (isTTY && Buffer.byteLength(text) <= OSC52_LIMIT) {
    write(osc52(text, env));
    return { copied: true, confirmed: false, message: `Sent ${text.length} characters to your terminal's clipboard (OSC 52). Terminals cannot confirm this, and some block it; if pasting gives nothing, install wl-clipboard or xclip (Linux), or select the text with your terminal.` };
  }
  return { copied: false, confirmed: false, message: Buffer.byteLength(text) > OSC52_LIMIT && !remote ? "No clipboard tool was found (install wl-clipboard or xclip), and the text is too large for the terminal's clipboard channel. Select it with your terminal instead." : "Could not reach a clipboard. Select the text with your terminal instead." };
}
