import { isObject, type CheckpointAttempt, type DurableMemoryHeads, type MemoryHead } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { NearRpc } from "./rpc.js";
import { accountId, canonical, decimal, decodeHead, encodeHead, failInput, hash, operationId, publicKey, runtimePermission, validateBlob, validateCall, validateIdentity,
  runtimeAccountOf, type ContractCall, type NearOutcome, type NearSigner, type RuntimeIdentity } from "./protocol.js";

export interface AgentState {
  id: string; owner: string; ownerKey: string; paused: boolean; generation: string; keyEpoch: string; policyVersion: string;
  head: MemoryHead | null;
  balances: { deposited: string; available: string; reserved: string; pending: string; paid: string; withdrawn: string };
}
export const JOB_STATUSES = ["funded", "delivered", "disputed", "payout_pending", "payout_failed", "paid", "refunded"] as const;
export interface JobState {
  operationId: string; status: typeof JOB_STATUSES[number]; worker: string; amount: string;
  result: MemoryHead["manifest"] | null; payoutAttempt: string;
}

export class NearAuthorityReader {
  constructor(readonly rpc: NearRpc) {}
  async agent(agentId: string): Promise<AgentState> {
    if (typeof agentId !== "string" || agentId.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(agentId)) failInput();
    const a = await this.rpc.view("get_agent", { agent_id: agentId });
    if (!isObject(a) || a.id !== agentId || !accountId(a.owner) || !publicKey(a.ownerKey) || typeof a.paused !== "boolean" ||
        !decimal(a.generation, 64, true) || !decimal(a.keyEpoch, 64, true) || !decimal(a.policyVersion)) {
      throw new ProviderError("PROTOCOL_ERROR", "Agent is absent or its finalized state is invalid");
    }
    const balances = { deposited: a.deposited, available: a.available, reserved: a.reserved, pending: a.pending, paid: a.paid, withdrawn: a.withdrawn };
    if (Object.values(balances).some((value) => !decimal(value, 128)) ||
        BigInt(String(balances.deposited)) !== [balances.available, balances.reserved, balances.pending, balances.paid, balances.withdrawn].reduce<bigint>((n, value) => n + BigInt(String(value)), 0n)) {
      throw new ProviderError("PROTOCOL_ERROR", "Finalized NEAR treasury accounting does not conserve funds");
    }
    return { id: agentId, owner: a.owner, ownerKey: a.ownerKey, paused: a.paused, generation: a.generation, keyEpoch: a.keyEpoch, policyVersion: a.policyVersion,
      head: decodeHead(a.head), balances: balances as AgentState["balances"] };
  }
  async job(agentId: string, id: string): Promise<JobState | null> {
    if (!operationId(id) || id.length > 64 || agentId.length > 128) failInput();
    const value = await this.rpc.view("get_job", { agent_id: agentId, operation_id: id });
    if (value === null) return null;
    if (!isObject(value) || !isObject(value.request) || value.request.agentId !== agentId || value.request.operationId !== id ||
        !accountId(value.request.worker) || !decimal(value.request.amount, 128, true) || !JOB_STATUSES.includes(value.status as JobState["status"]) || !decimal(value.payoutAttempt)) {
      throw new ProviderError("PROTOCOL_ERROR", "Finalized job does not match the requested operation");
    }
    if (value.result !== null) validateBlob(value.result);
    return { operationId: id, status: value.status as JobState["status"], worker: value.request.worker, amount: value.request.amount,
      result: value.result as JobState["result"], payoutAttempt: value.payoutAttempt };
  }
}

export function confirmedResult(outcome: NearOutcome): unknown {
  if (outcome.status === "unknown") throw new ProviderError("OUTCOME_UNKNOWN", "Reconcile the existing NEAR transaction before retrying", false, outcome.transactionHash);
  if (outcome.status === "failed") throw new ProviderError("TRANSACTION_FAILED", `NEAR execution failed (${outcome.failureCode})`, false, outcome.transactionHash);
  return outcome.result;
}

/** Reads need no signing key. Writes use the configured key's durable, isolated signer. */
export class NearMemoryHeadStore implements DurableMemoryHeads {
  private readonly identity: RuntimeIdentity;
  constructor(private readonly reader: NearAuthorityReader, identity: RuntimeIdentity, private readonly signer: NearSigner) {
    validateIdentity(identity);
    this.identity = structuredClone(identity);
  }
  async get(agentId: string): Promise<MemoryHead | null> {
    this.assertAgent(agentId);
    return (await this.reader.agent(agentId)).head;
  }
  async compareAndSwap(agentId: string, expectedVersion: number, next: MemoryHead): Promise<boolean> {
    this.assertAgent(agentId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || next.version !== expectedVersion + 1) failInput();
    const encoded = encodeHead(next);
    const keyEpoch = next.keyEpoch;
    const state = await this.reader.agent(agentId);
    if ((state.head?.version ?? 0) !== expectedVersion) return false;
    if (state.paused || state.owner !== this.identity.signerId || BigInt(state.keyEpoch) !== BigInt(keyEpoch)) {
      throw new ProviderError("AUTHORIZATION_FAILED", "Agent is paused, belongs to another owner, or requires another memory key epoch");
    }
    const call: ContractCall = { method: "checkpoint_memory", args: { agent_id: agentId, generation: state.generation, expected_version: String(expectedVersion), next: encoded } };
    const outcome = await this.signer.submit(`checkpoint:${hash(canonical(call))}`, call);
    const result = confirmedResult(outcome);
    if (typeof result !== "boolean") throw new ProviderError("PROTOCOL_ERROR", "Checkpoint transaction did not return a CAS result");
    return result;
  }

  private async writable(keyEpoch: number): Promise<AgentState> {
    const state = await this.reader.agent(this.identity.agentId);
    if (state.paused || state.owner !== this.identity.signerId || state.ownerKey === this.identity.publicKey || BigInt(state.keyEpoch) !== BigInt(keyEpoch)) {
      throw new ProviderError("AUTHORIZATION_FAILED", "Runtime cannot write this memory epoch");
    }
    const raw = await this.reader.rpc.view("get_agent", { agent_id: this.identity.agentId });
    const block = await this.reader.rpc.request("block", { finality: "final" });
    const access = await this.reader.rpc.request("query", { request_type: "view_access_key", finality: "final", account_id: runtimeAccountOf(this.identity), public_key: this.identity.publicKey });
    const grant = isObject(raw) && Array.isArray(raw.delegates) ? raw.delegates.find((d: unknown) => isObject(d) && d.publicKey === this.identity.publicKey) : undefined;
    if (!isObject(access) || !runtimePermission(access.permission, this.reader.rpc.config.contractId, "checkpoint_memory") ||
        !isObject(raw) || raw.generation !== state.generation || raw.paused !== false || !isObject(grant) || grant.canCheckpoint !== true || !decimal(grant.expiresAtNs, 64, true) ||
        !isObject(block) || !isObject(block.header) || !decimal(block.header.timestamp_nanosec) || BigInt(grant.expiresAtNs) <= BigInt(block.header.timestamp_nanosec)) {
      throw new ProviderError("AUTHORIZATION_FAILED", "Runtime checkpoint grant is absent, changed or expired");
    }
    return state;
  }
  async assertWritable(keyEpoch: number): Promise<void> { await this.writable(keyEpoch); }
  private async signerBinding(create: boolean): Promise<{ digest: string; journalIdentity: string }> {
    if (!this.signer.journalIdentity) throw new ProviderError("NOT_CONFIGURED", "Durable memory requires an identifiable signer journal");
    const journalIdentity = await this.signer.journalIdentity(create);
    const { kind, chainId, contractId } = this.reader.rpc.config;
    return { journalIdentity, digest: hash(canonical({ kind, chainId, contractId, signerId: this.identity.signerId, ...(this.identity.runtimeAccountId ? { runtimeAccountId: this.identity.runtimeAccountId } : {}),
      publicKey: this.identity.publicKey, agentId: this.identity.agentId, journalIdentity })) };
  }
  private checkpointCall(attempt: CheckpointAttempt): ContractCall {
    if (!Number.isSafeInteger(attempt.expectedVersion) || attempt.expectedVersion < 0 || attempt.next.version !== attempt.expectedVersion + 1 || !decimal(attempt.generation, 64, true)) failInput();
    const call: ContractCall = { method: "checkpoint_memory", args: { agent_id: this.identity.agentId, generation: attempt.generation, expected_version: String(attempt.expectedVersion), next: encodeHead(attempt.next) } };
    if (attempt.operationId !== `checkpoint:${hash(canonical(call))}`) failInput();
    validateCall(call, this.identity); return call;
  }
  async prepare(agentId: string, expectedVersion: number, next: MemoryHead): Promise<CheckpointAttempt | null> {
    this.assertAgent(agentId);
    const captured = structuredClone(next);
    const state = await this.writable(captured.keyEpoch);
    if ((state.head?.version ?? 0) !== expectedVersion) return null;
    const call: ContractCall = { method: "checkpoint_memory", args: { agent_id: agentId, generation: state.generation, expected_version: String(expectedVersion), next: encodeHead(captured) } };
    const attempt = { operationId: `checkpoint:${hash(canonical(call))}`, signerBinding: (await this.signerBinding(true)).digest, generation: state.generation, expectedVersion, next: captured };
    this.checkpointCall(attempt); return attempt;
  }
  async submit(attempt: CheckpointAttempt): Promise<boolean> {
    const captured = structuredClone(attempt); const call = this.checkpointCall(captured);
    const binding = await this.signerBinding(false);
    if (binding.digest !== captured.signerBinding) throw new ProviderError("INTEGRITY_FAILED", "Checkpoint belongs to another signer journal");
    const result = confirmedResult(await this.signer.submit(captured.operationId, call, { journalIdentity: binding.journalIdentity }));
    if (typeof result !== "boolean") throw new ProviderError("PROTOCOL_ERROR", "Checkpoint did not return a CAS result");
    return result;
  }
  async reconcile(attempt: CheckpointAttempt): Promise<"accepted" | "rejected" | "unknown" | "unsubmitted" | "failed"> {
    const captured = structuredClone(attempt); this.checkpointCall(captured);
    const binding = await this.signerBinding(false);
    if (binding.digest !== captured.signerBinding) throw new ProviderError("INTEGRITY_FAILED", "Checkpoint belongs to another signer journal");
    try {
      const outcome = await this.signer.reconcile(captured.operationId, { journalIdentity: binding.journalIdentity });
      if (outcome.status === "unknown" || outcome.status === "failed") return outcome.status;
      if (typeof outcome.result !== "boolean") throw new ProviderError("PROTOCOL_ERROR", "Checkpoint did not return a CAS result");
      return outcome.result ? "accepted" : "rejected";
    } catch (error) {
      if (error instanceof ProviderError && error.code === "INVALID_INPUT") return "unsubmitted";
      throw error;
    }
  }
  private assertAgent(agentId: string): void { if (agentId !== this.identity.agentId) throw new ProviderError("AUTHORIZATION_FAILED", "Memory signer is scoped to one agent"); }
}

/** No attached-deposit funding or owner administration is exposed through this client. */
export class NearTreasuryClient {
  private readonly identity: RuntimeIdentity;
  constructor(private readonly reader: NearAuthorityReader, identity: RuntimeIdentity, private readonly signer: NearSigner) {
    validateIdentity(identity);
    this.identity = structuredClone(identity);
  }
  async reserve(request: Record<string, unknown>): Promise<JobState> {
    const call: ContractCall = { method: "create_job", args: { request: structuredClone(request) } };
    validateCall(call, this.identity);
    const id = String(request.operationId);
    confirmedResult(await this.signer.submit(`reserve:${id}`, call));
    const job = await this.reader.job(this.identity.agentId, id);
    if (!job) throw new ProviderError("PROTOCOL_ERROR", "Confirmed reservation is absent from finalized state");
    return job;
  }
  async accept(jobId: string, generation: string, resultDigest: string, retryAttempt = 0): Promise<JobState> {
    const call: ContractCall = { method: "accept_job", args: { agent_id: this.identity.agentId, operation_id: jobId, generation, expected_result_digest: resultDigest } };
    validateCall(call, this.identity);
    if (!Number.isSafeInteger(retryAttempt) || retryAttempt < 0 || retryAttempt > 8) failInput();
    const current = await this.reader.job(this.identity.agentId, jobId);
    if (!current?.result || current.result.ciphertextSha256 !== resultDigest || !["delivered", "payout_pending", "payout_failed", "paid"].includes(current.status)) {
      throw new ProviderError("AUTHORIZATION_FAILED", "Acceptance requires the finalized delivered artifact with its expected digest");
    }
    const id = (attempt: number) => `accept:${jobId}${attempt ? `:retry:${attempt}` : ""}`;
    // Explicit opt-in only after the immediately preceding transaction is conclusively failed.
    // Unknown/confirmed transactions never authorize a replacement, including failed payouts.
    if (retryAttempt) {
      const previous = await this.signer.reconcile(id(retryAttempt - 1));
      if (previous.status === "unknown") throw new ProviderError("OUTCOME_UNKNOWN", "Reconcile the prior acceptance before choosing another attempt", false, previous.transactionHash);
      if (previous.status !== "failed") throw new ProviderError("OPERATION_CONFLICT", "Prior acceptance succeeded; observe its payout rather than submitting another attempt");
    }
    confirmedResult(await this.signer.submit(id(retryAttempt), call));
    const job = await this.reader.job(this.identity.agentId, jobId);
    if (!job) throw new ProviderError("PROTOCOL_ERROR", "Accepted job is absent from finalized state");
    // A confirmed acceptance is not a paid job; only the finalized view reports settlement.
    return job;
  }
  async get(jobId: string): Promise<JobState | null> { return this.reader.job(this.identity.agentId, jobId); }
}
