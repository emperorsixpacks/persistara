import type { TerminalIO } from "./shell.js";
import { terminalText, type TerminalTone } from "./render.js";
import type { TerminalClient } from "./client.js";

export const commandCatalog = [
  ["connect", "Connect your owner wallet", false], ["missions", "Browse saved missions", false],
  ["new", "Create a research brief", false], ["open", "Inspect a saved mission", true],
  ["run", "Run or resume source collection", false], ["review", "Review the exact local dossier", false],
  ["memory", "Search committed memory", true], ["status", "Inspect authority and readiness", false],
  ["help", "Explore commands and workflows", false], ["activity", "Read the mission journal", false],
  ["commission", "Prepare a specialist request", true], ["quote", "Import a signed quote file", true],
  ["reserve", "Review quote and reserve funds", false], ["delivery", "Verify a delivery file", true],
  ["settle", "Review delivery before payment", false], ["reconcile", "Observe a pending commission", false],
  ["receipt", "Inspect settlement evidence", false], ["memory-recover", "Rebuild committed memory", false],
  ["export-request", "Export a private request file", true], ["export-dossier", "Export a private dossier", true],
  ["cancel", "Cancel local source collection", false], ["pause", "Review an owner pause", false],
  ["resume-agent", "Review an owner resume", false], ["owner-reconcile", "Observe a wallet handoff", true],
  ["owner-cancel", "Cancel before wallet handoff", true], ["disconnect", "End the owner session", false],
  ["sessions", "List saved conversations", false], ["session", "Start or open a conversation", true],
  ["exit", "Close this workspace", false],
] as const;
export type PaletteItem = typeof commandCatalog[number];
export interface SessionEntry { id: number; role: "you" | "result"; text: string; tone?: TerminalTone }
export interface ApplicationState {
  phase: "loading" | "command" | "question" | "working" | "closing";
  prompt: string; draft: string; cursor: number; menuIndex: number; menuHidden: boolean;
  scroll: number; entries: SessionEntry[]; activeCommand: string; startedAt: number;
  status: Awaited<ReturnType<TerminalClient["status"]>> | null; selected: string | null; session: string | null;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (value: string) => [...segmenter.segment(value)].map(s => s.segment);
/** Paste is one bounded piece of input, never a queue of commands/approvals. */
export function inputText(value: string) { return terminalText(value.slice(0, 16_384).replace(/[\r\n\t]/g, " "), 16_384); }
export function suggestions(state: ApplicationState): PaletteItem[] {
  if (state.phase !== "command" || state.menuHidden || !/^\/[a-z-]*$/.test(state.draft)) return [];
  return commandCatalog.filter(([name]) => ("/" + name).startsWith(state.draft));
}

export class ApplicationStore {
  private state: ApplicationState = { phase: "loading", prompt: "", draft: "", cursor: 0, menuIndex: 0, menuHidden: false, scroll: 0, entries: [], activeCommand: "Checking workspace", startedAt: Date.now(), status: null, selected: null, session: null };
  private listeners = new Set<() => void>();
  private pending: { resolve: (value: string | null) => void; kind: "command" | "question" } | null = null;
  private history: string[] = []; private historyIndex = -1; private savedDraft = ""; private sequence = 0;
  readonly io: TerminalIO = { print: (text, tone) => this.print(text, tone), ask: prompt => this.ask(prompt, "question"), busy: label => { if (this.state.phase === "working") this.busy(label); } };
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(value: Partial<ApplicationState>) { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  print(text: string, tone?: TerminalTone) {
    const entry: SessionEntry = { id: ++this.sequence, role: "result", text: terminalText(text, 80_000), ...(tone ? { tone } : {}) };
    this.append(entry);
  }
  private append(entry: SessionEntry) {
    const entries = [...this.state.entries, entry].slice(-120); let size = entries.reduce((sum, item) => sum + item.text.length, 0);
    while (size > 500_000 && entries.length > 1) size -= entries.shift()!.text.length;
    this.update({ entries, scroll: 0 });
  }
  ask(prompt: string, kind: "command" | "question"): Promise<string | null> {
    if (this.state.phase === "closing") return Promise.resolve(null);
    if (this.pending) throw Error("A terminal question is already open");
    this.historyIndex = -1;
    this.update({ phase: kind, prompt: terminalText(prompt), draft: "", cursor: 0, menuIndex: 0, menuHidden: false });
    return new Promise(resolve => { this.pending = { resolve, kind }; });
  }
  setDraft(value: string, cursor = graphemes(value).length) {
    const draft = inputText(value); this.update({ draft, cursor: Math.min(cursor, graphemes(draft).length), menuIndex: 0, menuHidden: false });
  }
  insert(value: string) {
    if (!this.pending) return;
    const input = inputText(value), parts = graphemes(this.state.draft), next = [...parts.slice(0, this.state.cursor), input, ...parts.slice(this.state.cursor)].join("");
    this.setDraft(next, this.state.cursor + graphemes(input).length);
  }
  move(delta: number) { this.update({ cursor: Math.max(0, Math.min(graphemes(this.state.draft).length, this.state.cursor + delta)) }); }
  erase(backwards: boolean) {
    if (!this.pending) return; const parts = graphemes(this.state.draft), at = backwards ? this.state.cursor - 1 : this.state.cursor;
    if (at < 0 || at >= parts.length) return; parts.splice(at, 1); this.setDraft(parts.join(""), backwards ? at : this.state.cursor);
  }
  complete() {
    const items = suggestions(this.state), item = items[this.state.menuIndex % items.length]; if (!item) return;
    this.setDraft("/" + item[0] + (item[2] ? " " : "")); this.update({ menuHidden: true });
  }
  navigate(delta: number) {
    const items = suggestions(this.state);
    if (items.length) { this.update({ menuIndex: (this.state.menuIndex + delta + items.length) % items.length }); return; }
    if (this.state.phase !== "command" || !this.history.length) return;
    if (this.historyIndex === -1) this.savedDraft = this.state.draft;
    this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex - delta));
    this.setDraft(this.historyIndex === -1 ? this.savedDraft : this.history[this.historyIndex]!);
  }
  submit() {
    if (!this.pending) return;
    const item = suggestions(this.state)[this.state.menuIndex];
    if (item) { this.complete(); if (item[2]) return; }
    const pending = this.pending, value = this.state.draft; this.pending = null;
    if (pending.kind === "command" && value.trim()) {
      this.history = [value, ...this.history.filter(v => v !== value)].slice(0, 50);
      this.append({ id: ++this.sequence, role: "you", text: value });
    }
    // Never store form/approval responses as command history or transcript entries.
    this.update({ phase: "working", draft: "", cursor: 0, activeCommand: pending.kind === "command" ? value : this.state.activeCommand, startedAt: Date.now(), menuHidden: true });
    pending.resolve(value);
  }
  escape() {
    if (suggestions(this.state).length) { this.update({ menuHidden: true }); return; }
    if (this.state.phase === "question") { const pending = this.pending; this.pending = null; this.update({ phase: "working", draft: "", cursor: 0 }); pending?.resolve(null); return; }
    if (this.state.phase === "command") this.setDraft("");
  }
  page(delta: number) { this.update({ scroll: Math.max(0, Math.min(100_000, this.state.scroll + delta)) }); }
  close() { const pending = this.pending; this.pending = null; this.update({ phase: "closing", draft: "", cursor: 0 }); pending?.resolve(null); }
  clearView() { if (this.state.phase === "command") this.update({ entries: [], scroll: 0 }); }
  busy(label: string) { this.update({ phase: "working", activeCommand: terminalText(label), startedAt: Date.now() }); }
}
