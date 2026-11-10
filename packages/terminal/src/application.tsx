import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Box, Text as InkText, Spacer, render, useInput, usePaste, useWindowSize, type Key, type TextProps } from "ink";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { ApplicationStore, graphemes, suggestions, type ApplicationState, type SessionEntry } from "./application-state.js";
import { nearAmount, terminalColor, terminalText, type TerminalTone } from "./render.js";
import { errorText, words, type TerminalShell } from "./shell.js";
import type { TerminalClient } from "./client.js";

const copper = "#eca982", muted = "#8c969e", green = "#90bdae";
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const tones: Record<TerminalTone, string> = { brand: copper, muted, success: green, warning: "#e5be7e" };
const safe = (value: string) => terminalText(value, 80_000);
function Text({ color, ...props }: Omit<TextProps, "color"> & { color?: string | undefined }) { return <InkText {...props} {...(color ? { color } : {})} />; }
function clip(text: string, width: number) {
  const result: string[] = [];
  for (const part of graphemes(safe(text))) {
    if (stringWidth(result.join("") + part) > width) { while (result.length && stringWidth(result.join("") + "…") > width) result.pop(); return result.join("") + "…"; }
    result.push(part);
  }
  return result.join("");
}
export function transcriptLines(entries: SessionEntry[], width: number) {
  return entries.flatMap(entry => [
    ...wrapAnsi(entry.text.trim(), Math.max(1, width - 3), { hard: true, trim: false }).split("\n").map((text, i) => ({ text: `${i ? "  " : entry.role === "you" ? "› " : "● "}${text}`, tone: entry.role === "you" ? "brand" as const : entry.tone })),
    { text: "", tone: undefined },
  ]);
}
function editorParts(state: ApplicationState, width: number) {
  const chars = graphemes(state.draft), cursor = Math.min(state.cursor, chars.length);
  let start = cursor, used = 0;
  while (start > 0 && used + stringWidth(chars[start - 1]!) <= width - 2) { used += stringWidth(chars[--start]!); }
  const before = chars.slice(start, cursor).join(""), current = chars[cursor] ?? " ";
  let after = "";
  for (const part of chars.slice(cursor + 1)) { if (stringWidth(before + current + after + part) > width) break; after += part; }
  return { before, current, after };
}
export function applicationKey(store: ApplicationStore, input: string, key: Partial<Key>, interrupt: () => void, pageSize = 10) {
  if (key.eventType === "release") return;
  if (key.ctrl && input === "c") { interrupt(); return; }
  if (key.pageUp) { store.page(pageSize); return; } if (key.pageDown) { store.page(-pageSize); return; }
  const state = store.snapshot();
  if (key.ctrl && input === "d" && state.phase === "command" && !state.draft) { store.close(); return; }
  if (!["command", "question"].includes(state.phase)) return;
  if (key.escape) { store.escape(); return; }
  if (key.tab) { store.complete(); return; }
  if (key.upArrow) { store.navigate(-1); return; } if (key.downArrow) { store.navigate(1); return; }
  if (key.leftArrow) { store.move(-1); return; } if (key.rightArrow) { store.move(1); return; }
  if (key.home || (key.ctrl && input === "a")) { store.move(-state.cursor); return; }
  if (key.end || (key.ctrl && input === "e")) { store.move(graphemes(state.draft).length); return; }
  if (key.backspace) { store.erase(true); return; } if (key.delete) { store.erase(false); return; }
  if (key.ctrl && input === "l") { store.clearView(); return; }
  if (key.ctrl && input === "u") { store.setDraft(graphemes(state.draft).slice(state.cursor).join(""), 0); return; }
  if (key.ctrl && input === "k") { store.setDraft(graphemes(state.draft).slice(0, state.cursor).join("")); return; }
  if (key.ctrl && input === "w") { const parts = graphemes(state.draft), before = parts.slice(0, state.cursor).join("").replace(/\s*\S+\s*$/, ""); store.setDraft(before + parts.slice(state.cursor).join(""), graphemes(before).length); return; }
  // Only an actual Enter key submits. Pasted newlines are handled as input data.
  if (key.return && (input === "" || input === "\n" || input === "\r")) { store.submit(); return; }
  if (!key.ctrl && !key.meta && input) store.insert(input);
}

export interface ApplicationViewProps { store: ApplicationStore; agentId: string; project: string; interrupt: () => void; color?: boolean; dimensions?: { columns: number; rows: number } }
export function TerminalApplicationView({ store, agentId, project, interrupt, color = true, dimensions }: ApplicationViewProps) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot), window = useWindowSize();
  const columns = Math.max(24, dimensions?.columns ?? window.columns ?? 80), rows = Math.max(10, dimensions?.rows ?? window.rows ?? 24);
  const width = Math.max(18, columns - 4), [tick, setTick] = useState(0);
  const working = state.phase === "working" || state.phase === "loading";
  useEffect(() => { if (!working) return; const timer = setInterval(() => setTick(t => t + 1), 100); return () => clearInterval(timer); }, [working]);
  useInput((input, key) => applicationKey(store, input, key, interrupt, Math.max(3, rows - 14)));
  usePaste(text => store.insert(text));
  const palette = suggestions(state), menuRows = Math.min(palette.length, rows < 22 ? 3 : 5), menuStart = Math.max(0, state.menuIndex - menuRows + 1);
  const lines = useMemo(() => transcriptLines(state.entries, width), [state.entries, width]), available = Math.max(1, rows - 12 - (menuRows ? menuRows + 2 : 0));
  const offset = Math.min(state.scroll, Math.max(0, lines.length - available)), end = Math.max(0, lines.length - offset), visible = lines.slice(Math.max(0, end - available), end);
  const c = (value: string) => color ? value : undefined;
  const status = state.status, elapsed = Math.floor((Date.now() - state.startedAt) / 1000), parts = editorParts(state, Math.max(8, width - 6));
  const empty = state.entries.length === 0, roomy = columns >= 90 && rows >= 27;
  const phaseLabel = state.phase === "closing" ? "Closing safely…" : working ? `${frames[tick % frames.length]} ${clip(state.activeCommand || "Working", width - 18)} · ${elapsed}s` : state.phase === "question" ? "Response required · review the output above" : "Ready";
  return <Box flexDirection="column" width={columns} height={rows - 1} paddingX={2}>
    <Box height={2} flexShrink={0} alignItems="center">
      <Text bold color={c(copper)}>▰ PERSISTARA</Text>{columns >= 48 && <Text color={c(muted)}>  v0.1</Text>}<Spacer />
      {columns >= 48 && <Text color={c(muted)}>{columns > 65 ? "Source mode  /  " : ""}NEAR testnet</Text>}
    </Box>
    <Text color={c(muted)}>{"─".repeat(width)}</Text>
    <Box flexDirection="column" height={available} flexShrink={0} overflow="hidden">
      {empty && available < 7 ? <Text color={c(muted)}>Type / to explore commands.</Text> : empty && menuRows ? <Box flexDirection="column" paddingTop={1}><Text bold>Explore your workspace.</Text><Text color={c(muted)}>Choose a command below. Esc returns to your draft.</Text></Box> : empty ? <Box flexDirection="column" paddingTop={rows > 25 ? 2 : 0}>
        <Box borderStyle="round" borderColor={c(copper)} paddingX={roomy ? 3 : 1} paddingY={rows >= 27 ? 1 : 0} flexDirection={roomy ? "row" : "column"} width={Math.min(width, 104)}>
          <Box flexDirection="column" width={roomy ? "57%" : "100%"}>
            <Text bold color={c(copper)}>╭──╮</Text>
            <Text bold color={c(copper)}>│╶─╯  <Text color={undefined}>Welcome back.</Text></Text>
            {rows > 25 && <Text color={c(copper)}>╵</Text>}
            <Text>Make progress. Keep the record.</Text>
            <Text color={c(muted)}>{clip(project, roomy ? 42 : width - 6)}</Text>
            {rows > 25 && <Text color={c(muted)}>{clip(agentId, roomy ? 42 : width - 6)}</Text>}
            {roomy && <Text color={c(muted)}>Source missions · AI not connected</Text>}
          </Box>
          {roomy && <Box flexDirection="column" paddingLeft={3} borderLeft borderTop={false} borderBottom={false} borderRight={false} borderStyle="single" borderColor={c(muted)}>
            <Text color={c(muted)}>START HERE</Text>
            <Text><Text color={c(copper)}>/connect</Text>   Connect owner</Text>
            <Text><Text color={c(copper)}>/missions</Text>  Pick up saved work</Text>
            <Text><Text color={c(copper)}>/new</Text>       Write a brief</Text>
            <Text color={c(muted)}>Type / to explore commands</Text>
          </Box>}
        </Box>
        {rows > 28 && <Text color={c(muted)}>  Your session appears here as you work. Missions stay in your journal.</Text>}
      </Box> : visible.map((line, index) => <Text key={index} color={line.tone ? c(tones[line.tone]) : undefined} wrap="truncate-end">{line.text}</Text>)}
    </Box>
    {menuRows > 0 && <Box flexDirection="column" height={menuRows + 2} flexShrink={0}>
      <Text color={c(muted)}>Commands · ↑↓ navigate · Tab complete · Enter select</Text>
      {palette.slice(menuStart, menuStart + menuRows).map(([name, description], index) => <Box key={name}>
        <Box width={Math.min(24, Math.floor(width / 2))} flexShrink={0}><Text color={c(index + menuStart === state.menuIndex ? copper : muted)} bold={index + menuStart === state.menuIndex}>{index + menuStart === state.menuIndex ? "› " : "  "}{clip("/" + name, Math.min(21, Math.floor(width / 2) - 2))}</Text></Box>
        <Box flexGrow={1} overflow="hidden"><Text color={c(muted)} wrap="truncate-end">{description}</Text></Box>
      </Box>)}
    </Box>}
    <Box height={1} flexShrink={0}><Text color={c(state.phase === "question" ? "#e5be7e" : muted)}>{clip(phaseLabel, width - 2)}</Text><Spacer />{offset > 0 && <Text color={c(copper)}>↑ scrollback</Text>}</Box>
    <Box flexDirection="column" borderStyle="round" borderColor={c(state.phase === "question" ? "#e5be7e" : copper)} paddingX={1} height={4} flexShrink={0}>
      <Text color={c(muted)} wrap="truncate-end">{state.phase === "question" ? clip(state.prompt, width - 6) : [state.session ? `Session ${state.session.slice(-8)}` : "", state.selected ? `Mission ${state.selected.slice(-8)}` : ""].filter(Boolean).concat("Command").join("  /  ")}</Text>
      <Text wrap="truncate-end"><Text color={c(copper)}>{state.phase === "question" ? "? " : "› "}</Text>{parts.before}<Text inverse={state.phase === "command" || state.phase === "question"}>{parts.current}</Text>{parts.after}{!state.draft && state.phase === "command" && <Text color={c(muted)}> Type / for commands</Text>}{working && <Text color={c(muted)}>Working — Ctrl+C stops and exits safely</Text>}</Text>
    </Box>
    <Box height={1} flexShrink={0}><Text color={c(muted)} wrap="truncate-end">{clip(status ? `Last check: ${status.view.paused ? "paused" : "active"} · ${nearAmount(status.view.balances.available)} · Memory ${status.view.checkpointVersion} · Owner ${status.authenticated ? "connected" : "disconnected"}` : "○ NEAR readiness not verified", width)}</Text></Box>
    <Box height={1} flexShrink={0}><Text color={c(muted)} wrap="truncate-end">{clip(rows < 20 ? "Esc cancel · Ctrl+C exit · --plain fallback" : "Enter submit · Esc cancel draft/prompt · PgUp/PgDn scroll · Ctrl+C exit", width)}</Text></Box>
  </Box>;
}

export async function runApplicationSession(store: ApplicationStore, client: TerminalClient, shell: TerminalShell, signal: AbortSignal) {
      store.update({ selected: shell.selected, session: shell.session });
      const refresh = async () => { try { store.update({ status: await client.status() }); } catch (error) { store.update({ status: null }); store.print(errorText(error), "warning"); } };
      await refresh();
      while (!signal.aborted && store.snapshot().phase !== "closing") {
        const line = await store.ask("Command", "command"); if (line === null) break;
        let args: string[] = [];
        try { const route = shell.route(line); if (route.kind === "command") args = route.args; if (route.kind === "command" && !args.length) continue; if (!await shell.handle(line, signal)) break; }
        catch (error) { store.print(errorText(error), "warning"); }
        const status = store.snapshot().status;
        store.update({ selected: shell.selected, session: shell.session, ...(status ? { status: { ...status, authenticated: client.authenticated() } } : {}) });
        if (["connect", "disconnect", "pause", "resume-agent", "status", "memory-recover"].includes((args[0] ?? "").replace(/^\//, "")) && !signal.aborted && store.snapshot().phase !== "closing") { store.busy("Refreshing workspace"); await refresh(); }
      }
}

export function createTerminalApplication(options: { agentId: string; project: string; interrupt: () => void }) {
  const store = new ApplicationStore();
  const instance = render(<TerminalApplicationView store={store} {...options} color={terminalColor(Boolean(process.stdout.isTTY), process.env)} />, { exitOnCtrlC: false, alternateScreen: true, interactive: true, maxFps: 20, incrementalRendering: true });
  let closing = false;
  void instance.waitUntilExit().then(() => { if (!closing) options.interrupt(); }, () => { if (!closing) options.interrupt(); });
  const onEnd = () => options.interrupt(); process.stdin.once("end", onEnd);
  return {
    io: store.io, closeInput: () => store.close(), run: (client: TerminalClient, shell: TerminalShell, signal: AbortSignal) => runApplicationSession(store, client, shell, signal),
    async close() { closing = true; process.stdin.removeListener("end", onEnd); store.close(); instance.unmount(); await instance.waitUntilExit(); },
  };
}
