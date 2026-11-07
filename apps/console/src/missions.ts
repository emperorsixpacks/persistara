import type { Mission, MissionCapabilities, MissionDetail, MissionEvent, MissionSource, MissionState } from "../../../packages/runtime/src/types.js";
import { icons } from "./shell.js";
import { CommissionUI, commissionLabels, near, type CommissionCapabilities } from "./commissions.js";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const date = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const labels: Record<MissionState, string> = { queued: "Ready to run", running: "Collecting sources", interrupted: "Interrupted", blocked: "Needs attention", awaiting_review: "Ready for review", completed: "Reviewed", canceled: "Canceled" };
const events: Record<string, string> = { mission_created: "Brief saved", worker_started: "Source collection started", worker_resumed: "Execution resumed", source_fetch_started: "Source retrieval started", source_captured: "Source captured", worker_interrupted: "Worker interrupted", worker_blocked: "Execution needs attention", artifact_ready: "Dossier ready for review", owner_approved: "Owner marked dossier reviewed", mission_canceled: "Mission canceled", specialist_commission_created: "Specialist request created", specialist_settled: "Specialist delivery reviewed and paid" };
const chip = (state: MissionState, c?: Mission["commission"]) => `<span class="pill state-${c?.state ?? state}">${c ? c.state === "paid" && c.reviewed ? "Settled & reviewed" : commissionLabels[c.state] : labels[state]}</span>`;
const needsReview = (m: Mission) => m.commission ? m.commission.deliveryVerified && !m.commission.reviewed : m.state === "awaiting_review";
const inProgress = (m: Mission) => m.commission ? !["paid", "refunded", "canceled", "failed"].includes(m.commission.state) : ["queued", "running", "interrupted", "blocked"].includes(m.state);
interface DeskOptions {
  api: <T>(path: string, body?: unknown) => Promise<T>;
  work: (action: () => Promise<void>) => Promise<void>;
  authenticated: () => boolean;
  notice: (message: string, failure?: boolean) => void;
}

export class MissionDesk {
  private missions: Mission[] = [];
  private capabilities: MissionCapabilities | null = null;
  private commissioning: CommissionCapabilities = { configured: false };
  private readonly commerce: CommissionUI;
  private detail: MissionDetail | null = null;
  private selected = "";
  private filter = "all";
  private pending = false;
  private polling = false;
  private routeVersion = 0;
  private requestId = crypto.randomUUID();
  private readonly compose = el<HTMLDialogElement>("mission-compose");
  private readonly approval = el<HTMLDialogElement>("mission-approval");
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: DeskOptions) {
    this.commerce = new CommissionUI({ api: options.api, perform: fn => this.perform(fn), refresh: async () => { await this.refreshDetail(); await this.refreshList(); }, notice: options.notice });
    const open = () => { el("compose-error").textContent = options.authenticated() ? "" : "Connect your owner wallet using the button in the top bar before creating a mission."; this.sync(); this.compose.showModal(); };
    el("new-mission").onclick = open; el("empty-new-mission").onclick = open;
    el("close-compose").onclick = () => this.compose.close();
    for (const dialog of [this.compose, this.approval]) dialog.addEventListener("cancel", (event) => { if (this.pending) event.preventDefault(); });
    el("mission-form").onsubmit = (event) => { event.preventDefault(); void this.perform(async () => {
      el("compose-error").textContent = "";
      try {
        const created = await options.api<MissionDetail>("missions", { requestId: this.requestId, title: el<HTMLInputElement>("mission-title").value.trim(), objective: el<HTMLTextAreaElement>("mission-objective").value.trim(),
          criteria: el<HTMLTextAreaElement>("mission-criteria").value.trim(), sources: el<HTMLTextAreaElement>("mission-urls").value.split("\n").map((url) => url.trim()).filter(Boolean) });
        this.requestId = crypto.randomUUID(); (el("mission-form") as HTMLFormElement).reset(); this.compose.close();
        this.detail = created; this.go(created.mission.id); await this.refreshList(); options.notice("Mission saved. Review your brief, then start source collection.");
      } catch (error) { el("compose-error").textContent = error instanceof Error ? error.message : "Mission could not be saved. Retry with the same brief."; throw error; }
    }); };
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) button.onclick = () => {
      this.filter = button.dataset.filter!;
      for (const item of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) { item.classList.toggle("active", item === button); item.setAttribute("aria-pressed", String(item === button)); }
      this.renderList();
    };
    el<HTMLInputElement>("mission-search").oninput = () => this.renderList();
    el("activity-refresh").onclick = () => void this.perform(() => this.renderActivity());
    el<HTMLInputElement>("artifact-ack").onchange = () => this.sync();
    el("close-approval").onclick = () => this.approval.close();
    el("approve-artifact").onclick = () => void this.perform(async () => {
      const detail = this.detail;
      if (!detail?.artifact || !el<HTMLInputElement>("artifact-ack").checked) return;
      this.detail = await options.api<MissionDetail>(`missions/${detail.mission.id}/approve`, { version: detail.mission.version, artifactDigest: detail.artifact.digest });
      this.approval.close(); this.renderDetail(); await this.refreshList(); options.notice("Review recorded for this exact dossier. No transaction or payment was made.");
    });
    const menu = el<HTMLButtonElement>("menu");
    const closeMenu = () => { document.body.classList.remove("menu-open"); menu.setAttribute("aria-expanded", "false"); el("main").inert = false; document.querySelector<HTMLElement>(".top-actions")!.inert = false; };
    menu.onclick = () => {
      const opened = document.body.classList.toggle("menu-open"); menu.setAttribute("aria-expanded", String(opened)); el("main").inert = opened; document.querySelector<HTMLElement>(".top-actions")!.inert = opened;
      if (opened) document.querySelector<HTMLAnchorElement>(".nav-link.active")?.focus();
    };
    document.addEventListener("keydown", (event) => {
      if (!document.body.classList.contains("menu-open")) return;
      if (event.key === "Escape") { closeMenu(); menu.focus(); }
      if (event.key === "Tab") {
        const items: HTMLElement[] = [menu, ...[...document.querySelectorAll<HTMLAnchorElement>("#sidebar a")].filter((link) => link.getClientRects().length > 0)];
        const current = items.indexOf(document.activeElement as HTMLElement);
        event.preventDefault(); items[(current + (event.shiftKey ? -1 : 1) + items.length) % items.length]!.focus();
      }
    });
    window.matchMedia("(min-width: 721px)").addEventListener("change", () => closeMenu());
    for (const link of document.querySelectorAll<HTMLAnchorElement>("#sidebar a")) link.addEventListener("click", () => { closeMenu(); el("main").focus(); });
    window.addEventListener("hashchange", () => this.route()); this.route();
    this.timer = setInterval(() => {
      if (!this.polling && !this.pending && !document.hidden && options.authenticated() && this.selected && (this.detail?.mission.state === "running" || Boolean(this.detail?.commission && ["uploading_brief", "reserving", "settling", "payout_pending"].includes(this.detail.commission.state)))) {
        this.polling = true;
        void (async () => { if (this.detail?.commission) await options.api(`commissions/${this.detail.commission.id}/reconcile`, {}); await this.refreshDetail(); })().catch(() => options.notice("Mission status could not be refreshed. Reconnect or refresh before another action.", true)).finally(() => { this.polling = false; });
      }
    }, 3000);
    window.addEventListener("pagehide", () => clearInterval(this.timer), { once: true });
  }
  private async perform(action: () => Promise<void>) {
    if (this.pending) return;
    this.pending = true; this.sync();
    try { await this.options.work(action); } finally { this.pending = false; this.sync(); }
  }
  private sync() {
    const disabled = this.pending || !this.options.authenticated();
    el<HTMLButtonElement>("create-mission").disabled = disabled;
    el<HTMLButtonElement>("approve-artifact").disabled = disabled || !el<HTMLInputElement>("artifact-ack").checked;
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mission-action]")) button.disabled = disabled;
    el<HTMLButtonElement>("close-compose").disabled = this.pending;
    el<HTMLButtonElement>("close-approval").disabled = this.pending;
  }
  private go(id: string) { location.hash = `mission/${id}`; }
  private route() {
    this.routeVersion++;
    const hash = location.hash.slice(1), detail = /^mission\/(mission:[a-f0-9-]{36})$/.exec(hash);
    const page = detail ? "detail" : ["missions", "activity", "controls", "evidence"].includes(hash) ? hash : "missions";
    this.selected = detail?.[1] ?? "";
    for (const section of document.querySelectorAll<HTMLElement>("main > .page")) section.hidden = section.id !== `page-${page}`;
    for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-page]")) {
      const active = link.dataset.page === (page === "detail" ? "missions" : page); link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    el("page-crumb").textContent = ({ detail: "Mission", missions: "Missions", activity: "Activity", controls: "Agent controls", evidence: "Evidence" })[page]!;
    document.title = `Persistara · ${el("page-crumb").textContent}`;
    if (page === "detail") {
      el("mission-detail").innerHTML = '<div class="panel"><p class="muted">Loading the saved mission…</p></div>';
      if (this.options.authenticated()) { this.renderDetail(); void this.refreshDetail().catch(() => this.options.notice("The saved mission could not be loaded. Reconnect or refresh and try again.", true)); }
      else el("mission-detail").innerHTML = '<div class="panel"><h2>Owner connection required.</h2><p class="muted">Connect your owner wallet to open this mission.</p></div>';
    }
    if (page === "activity" && this.options.authenticated()) void this.renderActivity().catch(() => this.options.notice("Mission activity could not be loaded. Reconnect and refresh.", true));
  }
  async connected() {
    this.sync(); await this.refreshList();
    if (this.selected) await this.refreshDetail();
    if (location.hash === "#activity") await this.renderActivity();
  }
  disconnected() {
    this.missions = []; this.capabilities = null; this.detail = null; this.commerce.close(); this.commissioning = { configured: false }; this.approval.close(); this.renderList(); this.sync();
    el("mission-detail").innerHTML = '<div class="panel"><h2>Owner connection required.</h2><p class="muted">Connect your owner wallet to open this mission.</p></div>';
    el("activity-list").innerHTML = '<p class="muted">Connect your owner wallet to view mission activity.</p>';
  }
  private async refreshList() {
    if (!this.options.authenticated()) return;
    const result = await this.options.api<{ missions: Mission[]; capabilities: MissionCapabilities; commissioning?: CommissionCapabilities }>("missions");
    if (!this.options.authenticated()) return;
    this.missions = result.missions; this.capabilities = result.capabilities; this.commissioning = result.commissioning ?? { configured: false };
    el("allowed-origins").textContent = `Approved origins: ${result.capabilities.allowedOrigins.join(", ")}. URLs must have no query, fragment, credentials or custom port.`;
    this.renderList();
  }
  private renderList() {
    const all = this.missions;
    el("mission-count").textContent = String(all.length); el("stat-total").textContent = String(all.length);
    el("stat-running").textContent = String(all.filter(inProgress).length); el("stat-review").textContent = String(all.filter(needsReview).length);
    el("mission-spend-total").textContent = near(String(all.reduce((sum, m) => sum + BigInt(m.budget.spent), 0n)));
    const search = el<HTMLInputElement>("mission-search").value.trim().toLowerCase();
    const filtered = all.filter((m) => (this.filter === "all" || (this.filter === "progress" && inProgress(m)) || (this.filter === "review" && needsReview(m)) || (this.filter === "completed" && m.state === "completed")) && `${m.brief.title} ${m.brief.objective}`.toLowerCase().includes(search));
    const featured = filtered.find(needsReview)?.id;
    el("mission-grid").innerHTML = filtered.map((m) => `<article class="mission-card ${m.id === featured ? "featured" : ""}"><div class="card-top">${chip(m.state, m.commission)}<span class="card-number">${m.id.slice(-6).toUpperCase()}</span></div><h2><a href="#mission/${m.id}">${escape(m.brief.title)}</a></h2><p>${escape(m.brief.objective)}</p><div class="card-progress" aria-label="${m.capturedCount} of ${m.sourceCount} sources captured">${m.brief.sources.map((_, i) => `<i class="${i < m.capturedCount ? "done" : ""}"></i>`).join("")}</div><div class="card-bottom"><span>${m.capturedCount}/${m.sourceCount} sources</span><span>${date(m.updatedAt)} ↗</span></div></article>`).join("");
    el("mission-empty").hidden = filtered.length > 0;
    el("mission-empty-copy").innerHTML = all.length ? "No missions match these filters.<br>Try another search or start a new brief." : this.options.authenticated() ? "Start with a question and a few primary sources.<br>Save the brief. Run when you’re ready." : "Connect your owner wallet to start a mission.<br>Your work belongs to your workspace.";
  }
  private async refreshDetail() {
    const selected = this.selected, route = this.routeVersion;
    if (!selected || !this.options.authenticated()) return;
    const detail = await this.options.api<MissionDetail>(`missions/${selected}`);
    if (!this.options.authenticated() || route !== this.routeVersion || selected !== this.selected) return;
    const changed = !this.detail || this.detail.mission.id !== detail.mission.id || JSON.stringify(this.detail) !== JSON.stringify(detail);
    this.detail = detail; if (changed || !el("mission-detail").querySelector(".detail-layout")) this.renderDetail();
    const index = this.missions.findIndex((m) => m.id === selected); if (index >= 0) this.missions[index] = detail.mission;
    this.renderList();
  }
  private source(source: MissionSource) {
    const capture = source.capture;
    return `<details class="source-card" ${capture ? "" : "open"}><summary><span class="source-index">${String(source.ordinal + 1).padStart(2, "0")}</span><span class="source-name">${escape(capture?.title ?? new URL(source.url).hostname)}<small>${escape(source.url)}</small></span><span class="pill">${source.state === "captured" ? "Captured" : source.state === "fetching" ? "Retrieving" : source.state === "failed" ? "Unavailable" : source.state === "interrupted" ? "Interrupted" : source.state === "canceled" ? "Canceled" : "Queued"}</span></summary>${capture ? `<p class="source-excerpt">${escape(capture.excerpt)}</p><div class="source-meta"><a href="${escape(source.url)}" target="_blank" rel="noreferrer noopener">Original source ↗</a><span>Captured ${date(capture.capturedAt)}${capture.truncated ? " · excerpt limited to 6,000 characters" : ""}</span></div><p class="source-sha">CONTENT SHA-256 / ${capture.contentSha256}</p>` : `<p class="tiny">${source.failureCode ? `Retrieval stopped (${escape(source.failureCode)}). Resume explicitly when the source is available.` : "The worker will capture this source when the mission runs."}</p>`}</details>`;
  }
  private renderDetail() {
    const detail = this.detail; if (!detail || detail.mission.id !== this.selected) return;
    const m = detail.mission;
    const artifact = detail.artifact ?? (detail.commission?.artifact && detail.commission.artifactDigest ? { digest: detail.commission.artifactDigest, value: detail.commission.artifact } : null);
    const sources: MissionSource[] = detail.commission?.artifact ? detail.sources.map((source, index) => ({ ...source, state: "captured", capture: detail.commission!.artifact!.sources[index]! })) : detail.sources;
    const canRun = !detail.commission && ["queued", "blocked", "interrupted"].includes(m.state) && detail.sources.every((s) => s.state === "captured" || s.attempts < 3);
    const canCancel = !detail.commission && ["queued", "running", "blocked", "interrupted"].includes(m.state);
    const interrupted = ["blocked", "interrupted"].includes(m.state);
    el("mission-detail").innerHTML = `<a class="back-link" href="#missions">← All missions</a><header class="page-heading detail-heading"><div><p class="eyebrow">MISSION / ${m.id.slice(-8).toUpperCase()} ${chip(m.state, m.commission)}</p><h1>${escape(m.brief.title)}</h1><p>${escape(m.brief.objective)}</p></div></header>${this.commerce.render(detail, this.commissioning)}<div class="detail-layout"><div><section class="panel"><div class="panel-heading"><div><p class="eyebrow">THE DELIVERABLE</p><h2>${artifact ? "Your source dossier." : "One source at a time."}</h2></div>${artifact ? '<button id="download-dossier" class="quiet">Download JSON ↗</button>' : ""}</div><div class="dossier-boundary"><span>Source collection</span><span>No inference used</span><span>${detail.commission ? "Encrypted 0G delivery" : "Local artifact"}</span></div>${interrupted ? `<div class="detail-notice">Execution ${m.state === "interrupted" ? "was interrupted" : "needs attention"}${m.failureCode ? ` (${escape(m.failureCode)})` : ""}. Captured sources are saved. ${canRun ? "Resume to continue the remaining public reads with the same operation IDs." : "The bounded retry limit was reached. Review the sources and create a new brief if needed."}</div>` : ""}${sources.map((s) => this.source(s)).join("")}</section><section class="panel"><p class="eyebrow">YOUR REVIEW CRITERIA</p><p class="criteria">${escape(m.brief.criteria)}</p><p class="footnote">Captured material is untrusted source content. Collection and your review do not establish research correctness.</p></section>${artifact ? `<section class="panel"><p class="eyebrow">ARTIFACT FINGERPRINT</p><p class="mono">${artifact.digest}</p><p class="tiny">${detail.commission ? "This dossier was decrypted from the signed specialist’s 0G result. Its fixed NEAR job and payment status are shown in the commission panel." : "This dossier is stored in your private local mission journal. It has not been uploaded to 0G or checkpointed to NEAR."}</p></section>` : ""}</div><aside class="detail-side"><section class="panel"><p class="eyebrow">EXECUTION</p><h2>${m.state === "completed" ? "Review recorded." : m.state === "awaiting_review" ? "Ready for your review." : m.state === "running" ? "Work is in progress." : "Pick up from here."}</h2><p class="muted">${m.capturedCount} of ${m.sourceCount} sources captured</p><div class="metrics"><div><span>Maximum spend</span><strong>${near(m.budget.maximum)}</strong></div><div><span>Inference</span><strong>Not used</strong></div></div><div class="button-row">${canRun ? `<button id="mission-run" data-mission-action class="primary">${m.state === "queued" ? "Run mission" : "Resume mission"} ${icons.arrow}</button>` : ""}${!detail.commission && m.state === "awaiting_review" ? '<button id="review-dossier" data-mission-action class="primary">Review dossier ↗</button>' : ""}${canCancel ? '<button id="mission-cancel" data-mission-action class="quiet">Cancel mission</button>' : ""}<button id="detail-refresh" class="secondary">Refresh status ↻</button></div><p class="tiny">${m.state === "running" ? "Safe to reload. The local worker continues while this host is running." : "A restart retains the brief, captured sources and event history."}</p></section><section class="panel"><p class="eyebrow">MISSION TIMELINE</p><ol class="timeline">${detail.events.slice(-12).reverse().map((event) => `<li>${escape(events[event.kind] ?? "Execution event")}<time datetime="${new Date(event.at).toISOString()}">${date(event.at)}</time></li>`).join("")}</ol></section></aside></div>`;
    this.commerce.bind(this.commissioning);
    el("detail-refresh").onclick = () => void this.perform(() => this.refreshDetail());
    const run = document.getElementById("mission-run"); if (run) run.onclick = () => void this.perform(async () => {
      this.detail = await this.options.api<MissionDetail>(`missions/${m.id}/run`, { version: m.version }); this.renderDetail(); await this.refreshList(); this.options.notice("Execution started. Captured sources and progress are saved in the local journal.");
    });
    const cancel = document.getElementById("mission-cancel"); if (cancel) cancel.onclick = () => void this.perform(async () => {
      this.detail = await this.options.api<MissionDetail>(`missions/${m.id}/cancel`, { version: m.version }); this.renderDetail(); await this.refreshList(); this.options.notice("Mission canceled. Captured material and execution history are retained.");
    });
    const review = document.getElementById("review-dossier"); if (review) review.onclick = () => {
      el("artifact-review-digest").textContent = detail.artifact!.digest; el<HTMLInputElement>("artifact-ack").checked = false; this.sync(); this.approval.showModal();
    };
    const download = document.getElementById("download-dossier"); if (download) download.onclick = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `persistara-${m.id.slice(-8)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    this.sync();
  }
  private async renderActivity() {
    const result = await this.options.api<{ events: MissionEvent[] }>("missions/activity");
    if (!this.options.authenticated()) return;
    const titles = new Map(this.missions.map((m) => [m.id, m.brief.title]));
    el("activity-list").innerHTML = result.events.length ? result.events.map((event) => `<div class="activity-row"><span class="event-dot"></span><div><p>${escape(events[event.kind] ?? "Execution event")}</p><a href="#mission/${event.missionId}">${escape(titles.get(event.missionId) ?? "Open mission")} ↗</a></div><time datetime="${new Date(event.at).toISOString()}">${date(event.at)}</time></div>`).join("") : '<p class="muted">No mission events yet. Your first saved brief starts the record.</p>';
  }
}
