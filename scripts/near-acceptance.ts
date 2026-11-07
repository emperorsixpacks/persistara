/** Real testnet mechanical acceptance, with fictional artifacts. No inference or owner key input. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readPrivateFile, writePrivateFile } from "../packages/memory/src/files.js";
import { NearAuthorityReader, NearTreasuryClient } from "../packages/near/src/client.js";
import { nearConfig } from "../packages/near/src/config.js";
import { IsolatedNearSigner } from "../packages/near/src/isolated.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { canonical, encodeHead, hash, validateCall } from "../packages/near/src/protocol.js";
import { storageConfig } from "../packages/protocol/src/config.js";
import { isObject, sameBlob } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { StorageAcceptance } from "../packages/storage/src/acceptance.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { loadEnvironment, printFailure } from "./common.js";

async function main() {
  loadEnvironment();
  const [command, directory = ".persistara/acceptance/near", storageDirectory = ".persistara/acceptance/storage", ...extra] = process.argv.slice(2);
  if (!["prepare", "reserve", "accept", "retry-accept", "verify", "reject"].includes(command ?? "") || extra.length) throw new ProviderError("INVALID_INPUT", "Use near:acceptance prepare|reserve|accept|retry-accept|verify|reject [state-directory] [storage-acceptance-directory]");
  const config = nearConfig(process.env);
  const rpc = new NearRpc(config);
  const reader = new NearAuthorityReader(rpc);
  const signer = new IsolatedNearSigner(config);
  const treasury = new NearTreasuryClient(reader, config, signer);
  const path = (name: string) => resolve(directory, name);
  const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const { uploaderKeyFile: _unused, ...readStorage } = storageConfig(process.env);
  const storage = await new StorageAcceptance(resolve(storageDirectory), new ZeroGBlobStore(readStorage)).verify();
  const state = await reader.agent(config.agentId);
  const binding = { network: "near:testnet", contractId: config.contractId, agentId: config.agentId, signerId: config.signerId, publicKey: config.publicKey };
  if (command === "prepare") {
    const raw = await rpc.view("get_agent", { agent_id: config.agentId });
    if (!isObject(raw) || !isObject(raw.policy) || !Array.isArray(raw.policy.approvedWorkers) || raw.policy.approvedWorkers.length !== 1 ||
        raw.policy.maxJobAmount !== "20000000000000000000000" || raw.policy.dailyLimit !== "50000000000000000000000" ||
        !state.head || state.balances.deposited !== "100000000000000000000000" || state.balances.paid !== "0" || state.paused) {
      throw new ProviderError("AUTHORIZATION_FAILED", "Acceptance requires a fresh funded agent with the documented bounded test policy and committed memory");
    }
    const block = await rpc.request("block", { finality: "final" });
    if (!isObject(block) || !isObject(block.header) || typeof block.header.timestamp_nanosec !== "string") throw new ProviderError("PROTOCOL_ERROR", "Missing finalized clock");
    const now = BigInt(block.header.timestamp_nanosec);
    const operationId = `live:${randomUUID()}`;
    const request = { agentId: config.agentId, generation: state.generation, policyVersion: state.policyVersion, operationId,
      worker: raw.policy.approvedWorkers[0], amount: "10000000000000000000000", criteriaHash: hash("Fictional mechanical storage-and-settlement acceptance; no research or AI quality claim"), brief: storage.ref,
      quoteExpiresAtNs: String(now + 3_600_000_000_000n), deliveryDeadlineNs: String(now + 7_200_000_000_000n), reviewWindowNs: "3600000000000" };
    validateCall({ method: "create_job", args: { request } }, config);
    const plan = { schemaVersion: 1, binding, request, initialHead: state.head, initialBalances: state.balances };
    await writePrivateFile(path("plan.json"), json(plan));
    await writePrivateFile(path("delivery-args.json"), json({ agent_id: config.agentId, operation_id: operationId, result: storage.ref }));
    console.log(JSON.stringify({ status: "prepared_not_reserved", operationId, worker: request.worker, amountYoctoNear: request.amount, artifact: storage.ref, ownerSigningRequired: false }, null, 2));
    return;
  }
  const plan: unknown = JSON.parse(Buffer.from(await readPrivateFile(path("plan.json"))).toString("utf8"));
  if (!isObject(plan) || plan.schemaVersion !== 1 || canonical(plan.binding) !== canonical(binding) || !isObject(plan.request) || !isObject(plan.initialHead)) throw new ProviderError("INTEGRITY_FAILED", "Acceptance plan belongs to another deployment");
  const request = plan.request;
  validateCall({ method: "create_job", args: { request } }, config);
  if (request.amount !== "10000000000000000000000" || request.generation !== state.generation || !isObject(request.brief) || !sameBlob(storage.ref, request.brief as unknown as typeof storage.ref)) throw new ProviderError("AUTHORIZATION_FAILED", "Acceptance amount, generation or artifact changed");
  const id = String(request.operationId);
  let result: unknown;
  if (command === "reserve") result = { status: "reservation_observed", job: await treasury.reserve(request), receipt: await signer.reconcile(`reserve:${id}`) };
  else if (command === "accept" || command === "retry-accept") {
    const attempt = command === "retry-accept" ? 1 : 0;
    result = { status: "acceptance_observed", attempt, job: await treasury.accept(id, state.generation, storage.ref.ciphertextSha256, attempt), receipt: await signer.reconcile(`accept:${id}${attempt ? ":retry:1" : ""}`) };
  }
  else if (command === "reject") {
    if (!state.head || state.head.version < 1) throw new ProviderError("NOT_CONFIGURED", "A finalized memory checkpoint is required");
    const stale = await signer.submit(`stale:${id}`, { method: "checkpoint_memory", args: { agent_id: config.agentId, generation: state.generation, expected_version: "0", next: encodeHead({ ...state.head, version: 1 }) } });
    if (stale.status === "unknown") throw new ProviderError("OUTCOME_UNKNOWN", "Reconcile the stale-checkpoint test transaction", false, stale.transactionHash);
    if (stale.status !== "confirmed" || stale.result !== false) throw new ProviderError("INTEGRITY_FAILED", "Stale checkpoint was not rejected");
    const invalid = { ...request, operationId: `${id}:overbudget`, amount: "30000000000000000000000" };
    const budget = await signer.submit(`budget:${id}`, { method: "create_job", args: { request: invalid } });
    if (budget.status === "unknown") throw new ProviderError("OUTCOME_UNKNOWN", "Reconcile the over-budget test transaction", false, budget.transactionHash);
    if (budget.status !== "failed" || budget.failureCode !== "ERR_JOB_LIMIT" || await reader.job(config.agentId, String(invalid.operationId)) !== null) throw new ProviderError("INTEGRITY_FAILED", "Over-budget reservation was not rejected for the expected reason");
    result = { status: "contract_rejections_verified", stale, budget };
  } else {
    const job = await treasury.get(id);
    if (!job || job.status !== "paid" || job.payoutAttempt !== "1" || job.amount !== request.amount || !job.result || !sameBlob(job.result, storage.ref) ||
        state.balances.paid !== request.amount || state.balances.reserved !== "0" || state.balances.pending !== "0" || state.balances.available !== "90000000000000000000000") {
      throw new ProviderError("INTEGRITY_FAILED", "Acceptance has not reached the expected finalized single payout");
    }
    const reservation = await signer.reconcile(`reserve:${id}`);
    let acceptance = await signer.reconcile(`accept:${id}`);
    const priorAcceptance = acceptance.status === "failed" ? acceptance : null;
    if (priorAcceptance) acceptance = await signer.reconcile(`accept:${id}:retry:1`);
    if (reservation.status !== "confirmed" || acceptance.status !== "confirmed") throw new ProviderError("OUTCOME_UNKNOWN", "Acceptance receipts are not both confirmed");
    result = { status: "verified_testnet_commerce", job, balances: state.balances, reservation, acceptance, priorAcceptance };
  }
  const report = { ...binding, command, result, verifiedAt: new Date().toISOString(), specimen: "fictional", nearAiUsed: false, researchQualityVerified: false };
  const reportPath = path(`report-${randomUUID()}.json`);
  await writePrivateFile(reportPath, json(report));
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}
main().catch(printFailure);
