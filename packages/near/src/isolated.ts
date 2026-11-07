import { isObject } from "../../protocol/src/memory.js";
import { executeWorker } from "../../protocol/src/worker.js";
import { ProviderError, type CallOptions, type WorkerExecutor } from "../../protocol/src/providers.js";
import { operationId, transactionHash, validateCall, validateIdentity, validateNetwork, type ContractCall, type NearOutcome, type NearSigner, type NearSignerConfig } from "./protocol.js";

export class IsolatedNearSigner implements NearSigner {
  private readonly config: NearSignerConfig;
  constructor(config: NearSignerConfig, private readonly execute: WorkerExecutor = executeWorker) {
    validateNetwork(config); validateIdentity(config);
    if (!config.journalFile || !config.runtimeKeyFile) throw new ProviderError("NOT_CONFIGURED", "Configure separate NEAR runtime key and journal files");
    this.config = structuredClone(config);
  }
  async submit(id: string, call: ContractCall, options: CallOptions & { journalIdentity?: string } = {}): Promise<NearOutcome> {
    if (!operationId(id)) throw new ProviderError("INVALID_INPUT", "Invalid NEAR operation ID");
    validateCall(call, this.config);
    return this.run({ operation: "submit", id, call: structuredClone(call), ...(options.journalIdentity ? { expectedJournalIdentity: options.journalIdentity } : {}) }, options, "may-charge");
  }
  async journalIdentity(create: boolean): Promise<string> {
    const value = await this.execute(new URL("./signer-worker.js", import.meta.url), { operation: "identify", id: "journal:identity", config: this.config, create }, { effect: "read" });
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new ProviderError("PROTOCOL_ERROR", "Invalid signer journal identity");
    return value;
  }
  async reconcile(id: string, options: CallOptions & { journalIdentity?: string } = {}): Promise<NearOutcome> {
    if (!operationId(id)) throw new ProviderError("INVALID_INPUT", "Invalid NEAR operation ID");
    return this.run({ operation: "reconcile", id, ...(options.journalIdentity ? { expectedJournalIdentity: options.journalIdentity } : {}) }, options, "read");
  }
  private async run(request: Record<string, unknown>, options: CallOptions, effect: "read" | "may-charge"): Promise<NearOutcome> {
    const value = await this.execute(new URL("./signer-worker.js", import.meta.url), { ...request, config: this.config }, { ...options, effect, timeoutMs: options.timeoutMs ?? 90_000 });
    if (!isObject(value) || !transactionHash(value.transactionHash) || !["confirmed", "failed", "unknown"].includes(String(value.status)) ||
        (value.status === "confirmed" && !Object.hasOwn(value, "result")) || (value.status === "failed" && (typeof value.failureCode !== "string" || !/^[A-Z0-9_]{1,100}$/.test(value.failureCode)))) {
      throw new ProviderError("PROTOCOL_ERROR", "Invalid isolated signer outcome");
    }
    return value as unknown as NearOutcome;
  }
}
