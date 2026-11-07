import { NearRpc } from "../../near/src/rpc.js";
import { JOB_STATUSES, type JobState } from "../../near/src/client.js";
import { canonical, decimal, validateBlob, validateCall, type RuntimeIdentity } from "../../near/src/protocol.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import type { JobRequest, SpecialistProfile } from "./types.js";

export interface CommissionJob { request: JobRequest; status: JobState["status"]; result: JobState["result"]; payoutAttempt: string; reviewDeadlineNs: string; disputeDeadlineNs: string }
export interface CommissionChain {
  workerKey(profile: SpecialistProfile, blockHash: string): Promise<void>;
  job(operationId: string): Promise<CommissionJob | null>;
}
export class NearCommissionChain implements CommissionChain {
  constructor(private readonly rpc: NearRpc, private readonly identity: RuntimeIdentity) {}
  async workerKey(profile: SpecialistProfile, blockHash: string) {
    const value = await this.rpc.request("query", { request_type: "view_access_key", block_id: blockHash, account_id: profile.accountId, public_key: profile.signingPublicKey });
    if (!isObject(value) || value.block_hash !== blockHash || value.permission !== "FullAccess") throw new ProviderError("AUTHORIZATION_FAILED", "Pinned specialist key is not a finalized full-access account key");
  }
  async job(operationId: string): Promise<CommissionJob | null> {
    const value = await this.rpc.view("get_job", { agent_id: this.identity.agentId, operation_id: operationId });
    if (value === null) return null;
    if (!isObject(value) || !isObject(value.request) || !JOB_STATUSES.includes(value.status as JobState["status"]) || !decimal(value.payoutAttempt) || !decimal(value.reviewDeadlineNs) || !decimal(value.disputeDeadlineNs)) throw new ProviderError("PROTOCOL_ERROR", "Invalid finalized specialist job");
    validateCall({ method: "create_job", args: { request: value.request } }, this.identity);
    if (value.request.operationId !== operationId || value.request.agentId !== this.identity.agentId) throw new ProviderError("INTEGRITY_FAILED", "Job belongs to another commission");
    if (value.result !== null) validateBlob(value.result);
    return { request: value.request as unknown as JobRequest, status: value.status as JobState["status"], result: value.result as JobState["result"], payoutAttempt: value.payoutAttempt,
      reviewDeadlineNs: value.reviewDeadlineNs, disputeDeadlineNs: value.disputeDeadlineNs };
  }
}
export function matchingJob(job: CommissionJob, request: JobRequest) {
  if (canonical(job.request) !== canonical(request)) throw new ProviderError("INTEGRITY_FAILED", "Finalized job changed worker, price, criteria, brief or authorization");
}
