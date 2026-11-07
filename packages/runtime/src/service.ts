import { randomUUID } from "node:crypto";
import type { OwnerView } from "../../owner/src/types.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { MissionJournal } from "./journal.js";
import type { SourceReader } from "./sources.js";
import type { MissionAuthority, MissionCapabilities, MissionDetail, MissionLease } from "./types.js";

/** Capability-limited worker: one public text reader, one journal, one key-free authority reader. */
export class MissionService {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closed = false;
  constructor(readonly journal: MissionJournal, private readonly reader: SourceReader, private readonly readAuthority: () => Promise<OwnerView>,
    private readonly afterCapture?: (detail: MissionDetail) => void) {}
  capabilities(): MissionCapabilities { return { mode: "source-dossier", inference: false, spendingEnabled: false, maximumSources: 6, allowedOrigins: [...this.journal.origins] }; }
  private authority(view: OwnerView): MissionAuthority {
    const scope = this.journal.scope;
    if (view.owner !== scope.owner || view.agentId !== scope.agentId || view.contractId !== scope.contractId || view.chainId !== scope.chainId || view.codeHash !== scope.codeHash ||
      !view.ownerKeyFullAccess) throw new ProviderError("AUTHORIZATION_FAILED", "Registered owner authority is required");
    if (view.paused || view.localRotationHold !== false) throw new ProviderError("MISSION_BLOCKED", "Activate the agent and clear its local rotation hold before mission execution");
    return { ...scope, publicKey: view.ownerKey, generation: view.generation, keyEpoch: view.keyEpoch, blockHash: view.blockHash };
  }
  create(input: unknown, view: OwnerView) {
    if (this.closed) throw new ProviderError("OPERATION_CONFLICT", "Mission worker is shutting down");
    return this.journal.create(input, this.authority(view));
  }
  start(id: string, version: number, view: OwnerView): MissionDetail {
    if (this.closed || this.active.has(id)) throw new ProviderError("OPERATION_CONFLICT", "Mission worker is already running or shutting down");
    const auth = this.authority(view), detail = this.journal.get(id);
    if (auth.publicKey !== detail.mission.authority.publicKey) throw new ProviderError("AUTHORIZATION_FAILED", "Mission owner key changed");
    const lease = this.journal.claim(id, version, auth, randomUUID()), controller = new AbortController();
    // Defer execution until the durable claim and active-worker entry both exist.
    const done = Promise.resolve().then(() => this.execute(lease, controller)).finally(() => this.active.delete(id));
    this.active.set(id, { controller, done });
    return this.journal.get(id);
  }
  private async authorized(lease: MissionLease, signal: AbortSignal) {
    signal.throwIfAborted();
    const fresh = this.authority(await this.readAuthority()); signal.throwIfAborted();
    const expected = this.journal.get(lease.missionId).mission.authority;
    if (fresh.publicKey !== expected.publicKey || fresh.generation !== expected.generation || fresh.keyEpoch !== expected.keyEpoch) throw new ProviderError("AUTHORIZATION_FAILED", "Authority changed during mission execution");
    this.journal.heartbeat(lease);
  }
  private async execute(lease: MissionLease, controller: AbortController) {
    const heartbeat = setInterval(() => {
      try { this.journal.heartbeat(lease); } catch { controller.abort(); }
    }, 10_000);
    heartbeat.unref();
    try {
      const sources = this.journal.get(lease.missionId).sources;
      for (const source of sources) {
        if (source.state === "captured") continue;
        await this.authorized(lease, controller.signal);
        this.journal.beginSource(lease, source.operationId);
        const captured = await this.reader.read(source.url, controller.signal);
        controller.signal.throwIfAborted();
        this.journal.capture(lease, source.operationId, captured);
        this.afterCapture?.(this.journal.get(lease.missionId));
      }
      await this.authorized(lease, controller.signal);
      this.journal.assemble(lease);
    } catch (error) {
      const code = controller.signal.aborted ? "WORKER_STOPPED" : error instanceof ProviderError ? error.code : "UPSTREAM_ERROR";
      try { this.journal.stop(lease, controller.signal.aborted ? "interrupted" : "blocked", code); }
      catch { /* Cancellation or expired/replaced lease already fenced this worker. */ }
    } finally { clearInterval(heartbeat); }
  }
  cancel(id: string, version: number) {
    const result = this.journal.cancel(id, version);
    this.active.get(id)?.controller.abort(); return result;
  }
  approve(id: string, version: number, digest: string) { return this.journal.approve(id, version, digest); }
  async wait(id: string) { await this.active.get(id)?.done; }
  async close() {
    this.closed = true;
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.active.values()].map((task) => task.done));
  }
}
