import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { readPrivateFile, writePrivateFile } from "../../memory/src/files.js";
import { canonical, decimal, hash, validateCall, type ContractCall, type NearOutcome, type NearSigner, type RuntimeIdentity } from "../../near/src/protocol.js";
import type { OwnerView } from "../../owner/src/types.js";
import { isObject, sameBlob, type PreparedBlobStore } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { MissionJournal } from "../../runtime/src/journal.js";
import type { Mission, MissionDetail } from "../../runtime/src/types.js";
import { matchingJob, type CommissionChain } from "./chain.js";
import { decryptCommission, encryptCommission, recipientKeys, validateRecipientKeys, type RecipientKeys } from "./encryption.js";
import { CommissionJournal } from "./journal.js";
import { signedDigest, validateDelivery, validateDossier, validateProfile, validateQuote, validateTask, verifySigned } from "./protocol.js";
import type { CommissionBrief, CommissionRecord, CommissionTask, CommissionView, SpecialistDelivery, SpecialistMessage, SpecialistProfile, SpecialistQuote } from "./types.js";

type Authorize = (view: OwnerView) => void;
export interface CommissionServiceOptions {
  journal: CommissionJournal; missions: MissionJournal; signer: NearSigner; identity: RuntimeIdentity; chain: CommissionChain;
  blobs: PreparedBlobStore; read: () => Promise<OwnerView>; recipientKeyFile: string;
  profile: SpecialistMessage<SpecialistProfile> | null;
}
const unknown = () => new ProviderError("OUTCOME_UNKNOWN", "Reconcile the existing commission effect before any replacement");
const conflict = () => new ProviderError("OPERATION_CONFLICT", "Commission changed or is not ready for this action");
export class CommissionService {
  constructor(readonly options: CommissionServiceOptions) {}
  capabilities() {
    const profile = this.options.profile?.payload;
    return { configured: Boolean(profile), name: profile?.name ?? null, worker: profile?.accountId ?? null, amountYoctoNear: profile?.amountYoctoNear ?? null,
      mode: "signed-file-exchange", inference: false, maximumUploadCostTest0G: "0.01", recipientBackup: "local_only_unverified_off_device" };
  }
  private assertLinked(r: CommissionRecord) {
    if (this.options.missions.linkedCommission(r.missionId)?.id !== r.id) throw new ProviderError("INTEGRITY_FAILED", "Commission is not linked to the immutable mission");
  }
  private owner(view: OwnerView, r?: CommissionRecord, active = false) {
    const scope = this.options.journal.scope;
    if (view.owner !== scope.owner || view.agentId !== scope.agentId || view.contractId !== scope.contractId || view.chainId !== scope.chainId || view.codeHash !== scope.codeHash || !view.ownerKeyFullAccess || (r && view.ownerKey !== r.ownerKey)) throw new ProviderError("AUTHORIZATION_FAILED", "Original commission owner authority changed");
    if (active && (view.paused || view.localRotationHold !== false || !view.runtimeKeys.some((key) => key.publicKey === this.options.identity.publicKey && key.ready && key.methods.includes("create_job") && key.methods.includes("accept_job")))) throw new ProviderError("MISSION_BLOCKED", "Active scoped spending permission and no rotation hold are required");
  }
  private async current(r: CommissionRecord, authorize?: Authorize, active = false) { const view = await this.options.read(); this.owner(view, r, active); authorize?.(view); return view; }
  private async profile(view: OwnerView, signed: SpecialistMessage<SpecialistProfile>, fresh = true) {
    if (fresh) validateProfile(signed.payload, this.options.journal.scope, view.timestampNs);
    const p = signed.payload;
    if (fresh && !view.policy?.approvedWorkers.includes(p.accountId)) throw new ProviderError("AUTHORIZATION_FAILED", "Specialist is outside the finalized worker policy");
    await this.options.chain.workerKey(p, view.blockHash);
    await verifySigned(signed, "profile", this.options.journal.scope, p.accountId, p.signingPublicKey);
  }
  private async keys(create: boolean): Promise<RecipientKeys> {
    try { return await validateRecipientKeys(JSON.parse(Buffer.from(await readPrivateFile(this.options.recipientKeyFile)).toString("utf8"))); }
    catch (error) {
      if (!create || !isObject(error) || error.code !== "ENOENT" || this.options.journal.count() > 0) throw new ProviderError("NOT_CONFIGURED", "Restore the existing private delivery recipient key before continuing");
      const generated = await recipientKeys();
      try { await writePrivateFile(resolve(this.options.recipientKeyFile), Buffer.from(canonical(generated))); return generated; }
      catch (writeError) { if (!isObject(writeError) || writeError.code !== "EEXIST") throw writeError; return this.keys(false); }
    }
  }
  private policy(view: OwnerView, amount: string) {
    if (!decimal(amount, 128, true) || !view.policy || BigInt(amount) > BigInt(view.policy.maxJobAmount) || BigInt(amount) > BigInt(view.policy.dailyLimit) || BigInt(amount) > BigInt(view.balances.available)) throw new ProviderError("MISSION_BLOCKED", "Quote exceeds the current per-job policy or available treasury");
  }
  async create(missionId: string, version: number, maximum: string, view: OwnerView, authorize?: Authorize): Promise<CommissionView> {
    this.owner(view, undefined, true); authorize?.(view);
    if (!this.options.profile) throw new ProviderError("NOT_CONFIGURED", "Configure the curated signed specialist profile first");
    this.policy(view, maximum); await this.profile(view, this.options.profile);
    const mission = this.options.missions.get(missionId).mission;
    const prior = this.options.journal.findMission(missionId);
    if (!prior && (mission.state !== "queued" || mission.version !== version)) throw conflict();
    const brief: CommissionBrief = { schemaVersion: 1, title: mission.brief.title, objective: mission.brief.objective, criteria: mission.brief.criteria, sources: mission.brief.sources };
    const id = missionId.replace("mission:", "commission:");
    let r = prior;
    if (!r) {
      const keys = await this.keys(true), p = this.options.profile.payload;
      const encryptedBrief = await encryptCommission(brief, p.encryptionPublicKey, { scope: this.options.journal.scope, commissionId: id, missionId, purpose: "brief" });
      r = this.options.journal.create({ id, missionId, state: "preparing", version: 1, profile: this.options.profile, brief, maximumYoctoNear: maximum, ownerKey: view.ownerKey,
        preparation: { encryptedBrief, ownerRecipientKey: keys.publicKey, quoteNonce: randomBytes(32).toString("base64url"), deliveryNonce: randomBytes(32).toString("base64url"), createdAtNs: view.timestampNs },
        task: null, quote: null, delivery: null, artifact: null, request: null, signerIdentity: null, reviewedDigest: null, acceptanceCall: null, failureCode: null,
        receipt: { reservationHash: null, acceptanceHash: null, briefUploadHash: null, payoutAttempt: null, reviewDeadlineNs: null, disputeDeadlineNs: null }, events: [{ at: Date.now(), kind: "commission_prepared" }] });
    } else if (r.maximumYoctoNear !== maximum || canonical(r.brief) !== canonical(brief)) throw conflict();
    await this.current(r, authorize, true);
    this.options.missions.linkCommission(missionId, id, version);
    if (!r.task) {
      const prepared = await this.options.blobs.prepare(Buffer.from(r.preparation.encryptedBrief));
      const p = r.profile.payload;
      const task: CommissionTask = { schemaVersion: 1, id, missionId, scope: this.options.journal.scope, worker: p.accountId, workerSigningKey: p.signingPublicKey, workerEncryptionKey: p.encryptionPublicKey,
        ownerRecipientKey: r.preparation.ownerRecipientKey, encryptedBrief: r.preparation.encryptedBrief, briefDigest: hash(canonical(r.brief)), criteriaHash: hash(canonical({ objective: r.brief.objective, criteria: r.brief.criteria, sources: r.brief.sources })), maximumYoctoNear: r.maximumYoctoNear,
        quoteNonce: r.preparation.quoteNonce, deliveryNonce: r.preparation.deliveryNonce, createdAtNs: r.preparation.createdAtNs, brief: prepared };
      validateTask(task, this.options.journal.scope);
      const latest = this.options.journal.get(id);
      if (latest.task && canonical(latest.task) !== canonical(task)) throw conflict();
      if (!latest.task) this.options.journal.update(id, latest.version, (next) => { next.task = task; next.state = "awaiting_quote"; }, "quote_request_ready");
    }
    return this.options.journal.view(id);
  }
  request(id: string): CommissionTask { const r = this.options.journal.get(id); this.assertLinked(r); if (!r.task) throw conflict(); return structuredClone(r.task); }
  async importQuote(id: string, input: unknown, authorize?: Authorize): Promise<CommissionView> {
    const r = this.options.journal.get(id); this.assertLinked(r); if (!r.task || !["awaiting_quote", "quoted"].includes(r.state)) throw conflict();
    const view = await this.current(r, authorize, true); await this.profile(view, r.profile);
    const signed = await verifySigned<SpecialistQuote>(input, "quote", r.task.scope, r.task.worker, r.task.workerSigningKey, r.task.quoteNonce);
    validateQuote(signed.payload, r.task, view.timestampNs); this.policy(view, signed.payload.amountYoctoNear);
    if (r.quote) { if (signedDigest(r.quote) !== signedDigest(signed)) throw conflict(); return this.options.journal.view(id); }
    authorize?.(view);
    this.options.journal.update(id, r.version, (next) => { next.quote = signed; next.state = "quoted"; }, "quote_signature_verified"); return this.options.journal.view(id);
  }
  async reserve(id: string, version: number, quoteDigest: string, authorize?: Authorize): Promise<CommissionView> {
    let r = this.options.journal.get(id); this.assertLinked(r);
    if (!r.task || !r.quote || r.version !== version || signedDigest(r.quote) !== quoteDigest) throw conflict();
    if (!["quoted", "brief_ready"].includes(r.state)) return this.reconcile(id);
    let view = await this.current(r, authorize, true); await this.profile(view, r.profile); validateQuote(r.quote.payload, r.task, view.timestampNs); this.policy(view, r.quote.payload.amountYoctoNear);
    const keys = await this.keys(false); if (canonical(keys.publicKey) !== canonical(r.task.ownerRecipientKey)) throw new ProviderError("INTEGRITY_FAILED", "Delivery recipient key changed");
    if (r.state === "quoted") {
      await this.options.blobs.assertUploadReady(); view = await this.current(r, authorize, true);
      validateQuote(r.quote.payload, r.task, view.timestampNs); this.policy(view, r.quote.payload.amountYoctoNear);
      r = this.options.journal.update(id, r.version, (next) => { next.state = "uploading_brief"; }, "brief_upload_dispatched");
      try {
        const ref = await this.options.blobs.putPrepared(r.task!.brief, Buffer.from(r.task!.encryptedBrief), (tx) => {
          const latest = this.options.journal.get(id);
          if (!/^0x[a-fA-F0-9]{64}$/.test(tx) || (latest.receipt.briefUploadHash && latest.receipt.briefUploadHash !== tx)) throw new ProviderError("INTEGRITY_FAILED", "Upload transaction changed");
          if (!latest.receipt.briefUploadHash) this.options.journal.update(id, latest.version, (next) => { next.receipt.briefUploadHash = tx; });
        });
        if (!sameBlob(ref, r.task!.brief)) throw new ProviderError("INTEGRITY_FAILED", "Uploaded brief root changed");
      } catch { return this.reconcile(id); }
      r = await this.briefReady(id);
    }
    if (r.state !== "brief_ready") return this.options.journal.view(id);
    view = await this.current(r, authorize, true); validateQuote(r.quote!.payload, r.task!, view.timestampNs); this.policy(view, r.quote!.payload.amountYoctoNear);
    const signerIdentity = await this.options.signer.journalIdentity?.(true); if (!signerIdentity) throw new ProviderError("NOT_CONFIGURED", "Canonical identifiable signer journal is required");
    view = await this.current(r, authorize, true); validateQuote(r.quote!.payload, r.task!, view.timestampNs);
    const q = r.quote!.payload;
    const request = { agentId: r.task!.scope.agentId, generation: view.generation, policyVersion: view.policyVersion, operationId: id, worker: q.worker, amount: q.amountYoctoNear, criteriaHash: q.criteriaHash,
      brief: q.brief, quoteExpiresAtNs: q.expiresAtNs, deliveryDeadlineNs: q.deliveryDeadlineNs, reviewWindowNs: q.reviewWindowNs };
    const call: ContractCall = { method: "create_job", args: { request } }; validateCall(call, this.options.identity);
    r = this.options.journal.update(id, r.version, (next) => { next.request = request; next.signerIdentity = signerIdentity; next.state = "reserving"; }, "reservation_dispatched");
    try { await this.options.signer.submit(`reserve:${id}`, call, { journalIdentity: signerIdentity }); } catch { /* Reconcile only: no replacement ID or automatic replay. */ }
    return this.reconcile(id);
  }
  private async briefReady(id: string): Promise<CommissionRecord> {
    let r = this.options.journal.get(id); if (r.state !== "uploading_brief" || !r.task) return r;
    try {
      const bytes = await this.options.blobs.get(r.task.brief);
      if (!Buffer.from(bytes).equals(Buffer.from(r.task.encryptedBrief))) throw new ProviderError("INTEGRITY_FAILED", "Retrieved brief changed");
    } catch (error) { if (error instanceof ProviderError && error.code === "INTEGRITY_FAILED") throw error; return r; }
    r = this.options.journal.get(id);
    return r.state === "uploading_brief" ? this.options.journal.update(id, r.version, (next) => { next.state = "brief_ready"; }, "brief_availability_verified") : r;
  }
  private async signerOutcome(r: CommissionRecord, action: "reserve" | "accept"): Promise<NearOutcome | null> {
    if (!r.signerIdentity) return null;
    const actual = await this.options.signer.journalIdentity?.(false); if (actual !== r.signerIdentity) throw new ProviderError("INTEGRITY_FAILED", "Canonical runtime signer journal changed");
    try { return await this.options.signer.reconcile(`${action}:${r.id}`, { journalIdentity: r.signerIdentity }); }
    catch (error) { if (error instanceof ProviderError && error.code === "INVALID_INPUT") return null; throw error; }
  }
  async reconcile(id: string): Promise<CommissionView> {
    let r = this.options.journal.get(id); this.assertLinked(r);
    if (r.state === "uploading_brief") r = await this.briefReady(id);
    if (!r.request) return this.options.journal.view(id);
    const job = await this.options.chain.job(id);
    if (!job) {
      if (r.state === "reserving") {
        const outcome = await this.signerOutcome(r, "reserve");
        if (outcome?.status === "failed") this.options.journal.update(id, r.version, (next) => { next.state = "failed"; next.failureCode = outcome.failureCode; next.receipt.reservationHash = outcome.transactionHash; }, "reservation_failed");
      }
      return this.options.journal.view(id);
    }
    matchingJob(job, r.request);
    if (r.delivery && (!job.result || !sameBlob(job.result, r.delivery.payload.result))) throw new ProviderError("INTEGRITY_FAILED", "Finalized delivery changed after inspection");
    const action = r.state === "reserving" ? "reserve" : r.acceptanceCall ? "accept" : null;
    let outcome: NearOutcome | null = null;
    let receiptUnavailable = false;
    if (action) { try { outcome = await this.signerOutcome(r, action); } catch { receiptUnavailable = true; } }
    const mapped = ({ funded: "funded", delivered: r.artifact ? "delivery_ready" : "funded", payout_pending: "payout_pending", payout_failed: "payout_failed", paid: "paid", disputed: "disputed", refunded: "refunded" } as const)[job.status];
    const changed = r.state !== mapped || r.receipt.payoutAttempt !== job.payoutAttempt || r.receipt.reviewDeadlineNs !== job.reviewDeadlineNs || r.receipt.disputeDeadlineNs !== job.disputeDeadlineNs || (action && outcome && r.receipt[action === "reserve" ? "reservationHash" : "acceptanceHash"] === null);
    if (changed) r = this.options.journal.update(id, r.version, (next) => {
      next.state = mapped; next.receipt.payoutAttempt = job.payoutAttempt;
      next.receipt.reviewDeadlineNs = job.reviewDeadlineNs; next.receipt.disputeDeadlineNs = job.disputeDeadlineNs;
      if (action && outcome) next.receipt[action === "reserve" ? "reservationHash" : "acceptanceHash"] = outcome.transactionHash;
      next.failureCode = job.status === "paid" ? null : outcome?.status === "failed" ? outcome.failureCode : receiptUnavailable ? "RECEIPT_UNAVAILABLE" : null;
    }, mapped === r.state ? undefined : `job_${mapped}`);
    if (r.state === "paid" && r.artifact && r.reviewedDigest === hash(canonical(r.artifact))) this.options.missions.completeCommission(r.missionId, id, r.artifact);
    return this.options.journal.view(id);
  }
  async importDelivery(id: string, input: unknown, authorize?: Authorize): Promise<CommissionView> {
    let r = this.options.journal.get(id); this.assertLinked(r); if (!r.task || !r.quote || !r.request || ["refunded", "failed", "canceled"].includes(r.state)) throw conflict();
    const view = await this.current(r, authorize); await this.profile(view, r.profile, false);
    const signed = await verifySigned<SpecialistDelivery>(input, "delivery", r.task.scope, r.task.worker, r.task.workerSigningKey, r.task.deliveryNonce);
    validateDelivery(signed.payload, r.task, r.quote, view.timestampNs);
    if (r.delivery) { if (signedDigest(r.delivery) !== signedDigest(signed)) throw conflict(); return this.reconcile(id); }
    const job = await this.options.chain.job(id); if (!job?.result) throw new ProviderError("OUTCOME_UNKNOWN", "Observe the specialist's finalized delivery before importing its receipt");
    matchingJob(job, r.request); if (!sameBlob(job.result, signed.payload.result) || job.status === "funded" || job.status === "refunded") throw new ProviderError("INTEGRITY_FAILED", "Signed and finalized deliveries differ");
    const bytes = await this.options.blobs.get(signed.payload.result);
    const artifact = await decryptCommission(new TextDecoder("utf-8", { fatal: true }).decode(bytes), await this.keys(false), { scope: r.task.scope, commissionId: id, missionId: r.missionId, purpose: "artifact" });
    validateDossier(artifact, r.task, r.brief); if (hash(canonical(artifact)) !== signed.payload.artifactDigest) throw new ProviderError("INTEGRITY_FAILED", "Decrypted artifact fingerprint differs");
    await this.current(r, authorize);
    r = this.options.journal.update(id, r.version, (next) => { next.delivery = signed; next.artifact = artifact; if (next.state === "funded") next.state = "delivery_ready"; }, "delivery_signature_storage_and_content_verified");
    return this.reconcile(id);
  }
  async settle(id: string, version: number, artifactDigest: string, quoteDigest: string, authorize?: Authorize): Promise<CommissionView> {
    let r = this.options.journal.get(id); this.assertLinked(r);
    if (!r.artifact || !r.delivery || !r.quote || !r.task || !r.request || r.version !== version || hash(canonical(r.artifact)) !== artifactDigest || signedDigest(r.quote) !== quoteDigest) throw conflict();
    if (r.reviewedDigest) return this.reconcile(id);
    if (!["delivery_ready", "paid"].includes(r.state)) throw conflict();
    const view = await this.current(r, authorize, r.state !== "paid");
    const job = await this.options.chain.job(id); if (!job?.result || !sameBlob(job.result, r.delivery.payload.result)) throw new ProviderError("INTEGRITY_FAILED", "Current delivery differs from the reviewed artifact"); matchingJob(job, r.request);
    if (!["delivered", "paid"].includes(job.status)) throw conflict();
    const call: NonNullable<CommissionRecord["acceptanceCall"]> = { method: "accept_job", args: { agent_id: r.task.scope.agentId, operation_id: id, generation: view.generation, expected_result_digest: r.delivery.payload.result.ciphertextSha256 } };
    validateCall(call, this.options.identity);
    if (job.status !== "paid" && (!r.signerIdentity || await this.options.signer.journalIdentity?.(false) !== r.signerIdentity)) throw new ProviderError("INTEGRITY_FAILED", "Canonical signer changed before settlement");
    // Bind the exact call and delivery review before invoking the signer.
    authorize?.(view);
    r = this.options.journal.update(id, r.version, (next) => { next.reviewedDigest = artifactDigest; if (job.status !== "paid") { next.state = "settling"; next.acceptanceCall = call; } }, "owner_delivery_review_recorded");
    if (job.status !== "paid") {
      try { await this.options.signer.submit(`accept:${id}`, r.acceptanceCall!, { journalIdentity: r.signerIdentity! }); } catch { /* Only read the existing outcome. */ }
    }
    return this.reconcile(id);
  }
  cancel(id: string, version: number): CommissionView {
    const r = this.options.journal.get(id); this.assertLinked(r);
    if (r.version !== version || !["preparing", "awaiting_quote", "quoted", "brief_ready"].includes(r.state)) throw conflict();
    this.options.journal.update(id, version, (next) => { next.state = "canceled"; }, "commission_canceled_before_reservation"); return this.options.journal.view(id);
  }
  async recoveryRequest(id: string) {
    const r = this.options.journal.get(id); this.assertLinked(r); if (!r.request || !r.delivery) throw conflict();
    const job = await this.options.chain.job(id); if (!job?.result || !sameBlob(job.result, r.delivery.payload.result)) throw conflict(); matchingJob(job, r.request);
    if (job.status === "payout_failed") return { schemaVersion: 1, kind: "EXTERNAL_WALLET_RECOVERY_REQUEST", operationId: `retry-payout:${id}:${BigInt(job.payoutAttempt) + 1n}`, network: r.task!.scope.chainId, signerId: r.task!.worker, signingPublicKey: r.task!.workerSigningKey,
      receiverId: r.task!.scope.contractId, methodName: "retry_payout", args: { agent_id: r.task!.scope.agentId, operation_id: id }, gas: "100000000000000", deposit: "0", previousFailedPayoutAttempt: job.payoutAttempt, automaticBroadcast: false };
    if (job.status === "delivered" && r.acceptanceCall && r.reviewedDigest) {
      const outcome = await this.signerOutcome(r, "accept");
      if (outcome?.status === "failed") return { schemaVersion: 1, kind: "EXTERNAL_WALLET_RECOVERY_REQUEST", operationId: `recover-accept:${id}:${outcome.transactionHash}`, network: r.task!.scope.chainId, signerId: r.task!.scope.owner, signingPublicKey: r.ownerKey,
        receiverId: r.task!.scope.contractId, methodName: "accept_job", args: r.acceptanceCall.args, gas: "100000000000000", deposit: "0", previousFailedTransaction: outcome.transactionHash, automaticBroadcast: false };
    }
    throw new ProviderError("OUTCOME_UNKNOWN", "Only a conclusively failed transfer or acceptance permits an external recovery request");
  }
  project(mission: Mission): Mission {
    const r = this.options.journal.findMission(mission.id); if (!r || this.options.missions.linkedCommission(mission.id)?.id !== r.id) return mission;
    const c = this.options.journal.view(r.id);
    return { ...mission, commission: { id: c.id, missionId: c.missionId, state: c.state, worker: c.worker, name: c.name, amountYoctoNear: c.amountYoctoNear, reviewed: c.reviewed, deliveryVerified: c.deliveryVerified, failureCode: c.failureCode },
      budget: { ...mission.budget, maximum: r.maximumYoctoNear, spent: r.state === "paid" ? c.amountYoctoNear : "0" }, capturedCount: c.artifact?.sources.length ?? mission.capturedCount };
  }
  detail(detail: MissionDetail): MissionDetail {
    const r = this.options.journal.findMission(detail.mission.id);
    return { ...detail, mission: this.project(detail.mission), commission: r && this.options.missions.linkedCommission(detail.mission.id)?.id === r.id ? this.options.journal.view(r.id) : null };
  }
}
