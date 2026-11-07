import { randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { privateDirectory, readPrivateFile, writePrivateFile } from "../../memory/src/files.js";
import { canonical, hash, validateBlob } from "../../near/src/protocol.js";
import { isObject, sameBlob, type BlobRef, type PreparedBlobStore } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { MissionJournal, validateBrief } from "../../runtime/src/journal.js";
import type { SourceReader } from "../../runtime/src/sources.js";
import type { MissionArtifact, MissionAuthority, MissionScope } from "../../runtime/src/types.js";
import type { CommissionChain, CommissionJob } from "./chain.js";
import { decryptCommission, encryptCommission, type RecipientKeys } from "./encryption.js";
import { commerceNetwork, signedDigest, validateDelivery, validateDossier, validateProfile, validateQuote, validateTask, verifySigned } from "./protocol.js";
import type { CommissionBrief, CommissionTask, SpecialistDelivery, SpecialistMessage, SpecialistProfile, SpecialistQuote } from "./types.js";

export type SpecialistSign = <T>(kind: SpecialistMessage<T>["kind"], payload: T, nonce: string) => Promise<SpecialistMessage<T>>;
export interface SpecialistOptions {
  profile: SpecialistMessage<SpecialistProfile>; keys: RecipientKeys; scope: MissionScope; blobs: PreparedBlobStore; chain: CommissionChain;
  sources: SourceReader; sourceOrigins: readonly string[]; clock: () => Promise<{ timestampNs: string; ownerKey: string; generation: string; blockHash: string }>;
  sign: SpecialistSign;
}
interface ResultIntent { schemaVersion: 1; taskDigest: string; quoteDigest: string; artifact: MissionArtifact; ciphertext: string; ref: BlobRef; digest: string }
const intentDigest = (intent: Omit<ResultIntent, "digest"> | ResultIntent) => { const { schemaVersion, taskDigest, quoteDigest, artifact, ciphertext, ref } = intent; return hash(canonical({ schemaVersion, taskDigest, quoteDigest, artifact, ciphertext, ref })); };
const json = (value: unknown) => Buffer.from(canonical(value));
async function optional(path: string): Promise<Uint8Array | null> {
  try { return await readPrivateFile(path, 240_000); } catch (e) { if (isObject(e) && e.code === "ENOENT") return null; throw e; }
}
async function save(path: string, value: unknown) {
  try { await writePrivateFile(path, json(value)); }
  catch (e) { if (!isObject(e) || e.code !== "EEXIST") throw e; if (Buffer.from(await readPrivateFile(path, 240_000)).toString() !== canonical(value)) throw new ProviderError("OPERATION_CONFLICT", "Specialist request differs from durable state"); }
}
function uploadObservation(directory: string, ref: BlobRef, txHash: string) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new ProviderError("INTEGRITY_FAILED", "Invalid specialist upload transaction");
  const path = resolve(directory, "upload-submission.json"), value = canonical({ ref, txHash });
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (!isObject(error) || error.code !== "EEXIST") throw error;
    const existing = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (readFileSync(existing, "utf8") !== value) throw new ProviderError("INTEGRITY_FAILED", "Specialist upload transaction changed"); } finally { closeSync(existing); }
    return;
  }
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(resolve(directory), constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export class SpecialistExecutor {
  constructor(private readonly options: SpecialistOptions) {}
  private async brief(task: CommissionTask): Promise<CommissionBrief> {
    const p = this.options.profile.payload;
    validateTask(task, this.options.scope);
    if (task.worker !== p.accountId || task.workerSigningKey !== p.signingPublicKey || canonical(task.workerEncryptionKey) !== canonical(this.options.keys.publicKey) || canonical(p.encryptionPublicKey) !== canonical(this.options.keys.publicKey)) throw new ProviderError("AUTHORIZATION_FAILED", "Task belongs to another specialist or recipient key");
    const value = await decryptCommission(task.encryptedBrief, this.options.keys, { scope: task.scope, commissionId: task.id, missionId: task.missionId, purpose: "brief" });
    if (!isObject(value) || Object.keys(value).sort().join(",") !== "criteria,objective,schemaVersion,sources,title" || value.schemaVersion !== 1 || hash(canonical(value)) !== task.briefDigest) throw new ProviderError("INTEGRITY_FAILED", "Encrypted brief differs from the requested task");
    validateBrief({ requestId: task.missionId.slice(8), title: value.title, objective: value.objective, criteria: value.criteria, sources: value.sources }, this.options.sourceOrigins);
    if (task.criteriaHash !== hash(canonical({ objective: value.objective, criteria: value.criteria, sources: value.sources }))) throw new ProviderError("INTEGRITY_FAILED", "Review criteria differ from the task");
    return value as unknown as CommissionBrief;
  }
  async quote(task: CommissionTask, directory: string): Promise<SpecialistMessage<SpecialistQuote>> {
    await privateDirectory(directory); await this.brief(task);
    const clock = await this.options.clock(), p = this.options.profile.payload;
    validateProfile(p, task.scope, clock.timestampNs);
    await this.options.chain.workerKey(p, clock.blockHash);
    if (BigInt(p.amountYoctoNear) > BigInt(task.maximumYoctoNear)) throw new ProviderError("MISSION_BLOCKED", "Specialist price exceeds the requested maximum");
    await save(resolve(directory, "task.json"), task);
    const existing = await optional(resolve(directory, "quote.json"));
    if (existing) {
      const signed = await verifySigned<SpecialistQuote>(JSON.parse(Buffer.from(existing).toString()), "quote", task.scope, p.accountId, p.signingPublicKey, task.quoteNonce);
      validateQuote(signed.payload, task, clock.timestampNs, false); return signed;
    }
    const payloadFile = resolve(directory, "quote-payload.json");
    let payload: SpecialistQuote;
    const saved = await optional(payloadFile);
    if (saved) payload = JSON.parse(Buffer.from(saved).toString()) as SpecialistQuote;
    else {
      const now = BigInt(clock.timestampNs);
      payload = { schemaVersion: 1, commissionId: task.id, missionId: task.missionId, taskDigest: hash(canonical(task)), scope: task.scope, worker: task.worker,
        amountYoctoNear: p.amountYoctoNear, asset: "NEAR", network: commerceNetwork(task.scope), criteriaHash: task.criteriaHash, brief: task.brief, issuedAtNs: clock.timestampNs,
        expiresAtNs: String(now + 1800_000_000_000n), deliveryDeadlineNs: String(now + 86_400_000_000_000n), reviewWindowNs: "3600000000000", sequence: 1 };
      await save(payloadFile, payload);
    }
    validateQuote(payload, task, clock.timestampNs);
    const signed = await this.options.sign("quote", payload, task.quoteNonce);
    await verifySigned(signed, "quote", task.scope, task.worker, task.workerSigningKey, task.quoteNonce);
    await save(resolve(directory, "quote.json"), signed); return signed;
  }
  private async load(directory: string) {
    const task = JSON.parse(Buffer.from(await readPrivateFile(resolve(directory, "task.json"), 64_000)).toString()) as CommissionTask;
    const brief = await this.brief(task);
    const signed = await verifySigned<SpecialistQuote>(JSON.parse(Buffer.from(await readPrivateFile(resolve(directory, "quote.json"))).toString()), "quote", task.scope, task.worker, task.workerSigningKey, task.quoteNonce);
    validateQuote(signed.payload, task, (await this.options.clock()).timestampNs, false);
    return { task, brief, quote: signed };
  }
  private async job(task: CommissionTask, quote: SpecialistQuote, funded = false): Promise<CommissionJob> {
    const job = await this.options.chain.job(task.id);
    if (!job || job.request.agentId !== task.scope.agentId || job.request.operationId !== task.id || job.request.worker !== task.worker || job.request.amount !== quote.amountYoctoNear ||
      job.request.criteriaHash !== quote.criteriaHash || !sameBlob(job.request.brief, task.brief) || job.request.quoteExpiresAtNs !== quote.expiresAtNs || job.request.deliveryDeadlineNs !== quote.deliveryDeadlineNs || job.request.reviewWindowNs !== quote.reviewWindowNs) throw new ProviderError("INTEGRITY_FAILED", "Funded job differs from the signed quote");
    if (funded && (job.status !== "funded" || job.result !== null || BigInt((await this.options.clock()).timestampNs) >= BigInt(quote.deliveryDeadlineNs))) throw new ProviderError("MISSION_BLOCKED", "Job is not funded and within its delivery window");
    return job;
  }
  async fulfill(directory: string, signal: AbortSignal): Promise<BlobRef> {
    const { task, brief, quote } = await this.load(directory);
    const existing = await optional(resolve(directory, "result-intent.json"));
    let intent: ResultIntent;
    if (existing) intent = JSON.parse(Buffer.from(existing).toString()) as ResultIntent;
    else {
      await this.job(task, quote.payload, true);
      const bytes = await this.options.blobs.get(task.brief);
      if (Buffer.from(bytes).toString() !== task.encryptedBrief) throw new ProviderError("INTEGRITY_FAILED", "Published brief differs from the signed quote");
      const clock = await this.options.clock(), auth: MissionAuthority = { ...task.scope, publicKey: clock.ownerKey, generation: clock.generation, blockHash: clock.blockHash, keyEpoch: 1 };
      const journal = new MissionJournal(resolve(directory, "sources/missions.sqlite"), task.scope, this.options.sourceOrigins);
      try {
        let detail = journal.create({ requestId: task.missionId.slice(8), title: brief.title, objective: brief.objective, criteria: brief.criteria, sources: brief.sources }, auth);
        if (detail.mission.state !== "awaiting_review") {
          const lease = journal.claim(detail.mission.id, detail.mission.version, auth, randomUUID());
          const heartbeat = setInterval(() => { try { journal.heartbeat(lease); } catch { /* Next fenced commit fails closed. */ } }, 10_000); heartbeat.unref();
          try {
            for (const source of detail.sources) {
              if (source.state === "captured") continue;
              signal.throwIfAborted(); await this.job(task, quote.payload, true); journal.heartbeat(lease);
              journal.beginSource(lease, source.operationId); const capture = await this.options.sources.read(source.url, signal); signal.throwIfAborted(); journal.capture(lease, source.operationId, capture);
            }
            journal.assemble(lease);
          } catch (error) { try { journal.stop(lease, signal.aborted ? "interrupted" : "blocked", signal.aborted ? "WORKER_STOPPED" : "UPSTREAM_ERROR"); } catch {} throw error; }
          finally { clearInterval(heartbeat); }
          detail = journal.get(detail.mission.id);
        }
        if (!detail.artifact) throw new ProviderError("OUTCOME_UNKNOWN", "Source dossier is not complete");
        const artifact: MissionArtifact = { ...detail.artifact.value, missionId: task.missionId, storage: "0g_encrypted_delivery" };
        const ciphertext = await encryptCommission(artifact, task.ownerRecipientKey, { scope: task.scope, commissionId: task.id, missionId: task.missionId, purpose: "artifact" });
        const ref = await this.options.blobs.prepare(Buffer.from(ciphertext));
        const value = { schemaVersion: 1 as const, taskDigest: hash(canonical(task)), quoteDigest: signedDigest(quote), artifact, ciphertext, ref };
        intent = { ...value, digest: intentDigest(value) };
        await save(resolve(directory, "result-intent.json"), intent);
      } finally { journal.close(); }
    }
    validateBlob(intent.ref);
    if (intent.digest !== intentDigest(intent) || intent.schemaVersion !== 1 || intent.taskDigest !== hash(canonical(task)) || intent.quoteDigest !== signedDigest(quote) || intent.ref.ciphertextSha256 !== hash(intent.ciphertext) || intent.ref.byteLength !== Buffer.byteLength(intent.ciphertext)) throw new ProviderError("INTEGRITY_FAILED", "Specialist result intent changed");
    validateDossier(intent.artifact, task, brief);
    const marker = resolve(directory, "upload-dispatched.json");
    if (!await optional(marker)) {
      await this.job(task, quote.payload, true); await this.options.blobs.assertUploadReady(); signal.throwIfAborted();
      try { await writePrivateFile(marker, json({ taskDigest: intent.taskDigest, result: intent.ref })); }
      catch (error) { if (!isObject(error) || error.code !== "EEXIST") throw error; return this.verifyResult(intent); }
      try { await this.options.blobs.putPrepared(intent.ref, Buffer.from(intent.ciphertext), tx => uploadObservation(directory, intent.ref, tx)); }
      catch { return this.verifyResult(intent); }
    } else {
      const markerValue = JSON.parse(Buffer.from((await optional(marker))!).toString());
      if (canonical(markerValue) !== canonical({ taskDigest: intent.taskDigest, result: intent.ref })) throw new ProviderError("INTEGRITY_FAILED", "Specialist upload marker differs");
    }
    return this.verifyResult(intent);
  }
  private async verifyResult(intent: ResultIntent): Promise<BlobRef> {
    try { const bytes = await this.options.blobs.get(intent.ref); if (!Buffer.from(bytes).equals(Buffer.from(intent.ciphertext))) throw new ProviderError("INTEGRITY_FAILED", "Specialist ciphertext differs"); }
    catch (error) { if (error instanceof ProviderError && error.code === "INTEGRITY_FAILED") throw error; throw new ProviderError("OUTCOME_UNKNOWN", "Reconcile the existing result root; do not upload a replacement"); }
    return intent.ref;
  }
  async dispatchDelivery(directory: string, send: (request: { worker: string; contractId: string; method: "deliver"; args: { agent_id: string; operation_id: string; result: BlobRef } }) => Promise<void>): Promise<SpecialistMessage<SpecialistDelivery>> {
    const { task, quote } = await this.load(directory), intent = JSON.parse(Buffer.from(await readPrivateFile(resolve(directory, "result-intent.json"), 240_000)).toString()) as ResultIntent;
    if (intent.digest !== intentDigest(intent) || intent.taskDigest !== hash(canonical(task)) || intent.quoteDigest !== signedDigest(quote)) throw new ProviderError("INTEGRITY_FAILED", "Delivery intent differs from the quote");
    await this.verifyResult(intent);
    let job = await this.job(task, quote.payload);
    const request = { worker: task.worker, contractId: task.scope.contractId, method: "deliver" as const, args: { agent_id: task.scope.agentId, operation_id: task.id, result: intent.ref } };
    const marker = resolve(directory, "delivery-dispatched.json");
    if (!job.result && !await optional(marker)) {
      await this.job(task, quote.payload, true);
      try { await writePrivateFile(marker, json(request)); }
      catch (error) { if (!isObject(error) || error.code !== "EEXIST") throw error; throw new ProviderError("OUTCOME_UNKNOWN", "Delivery handoff already exists; observe its finalized outcome"); }
      try { await send(request); } catch { /* A wallet/CLI failure never authorizes a replacement transaction. */ }
    }
    if (await optional(marker)) { const marked = JSON.parse(Buffer.from((await optional(marker))!).toString()); if (canonical(marked) !== canonical(request)) throw new ProviderError("INTEGRITY_FAILED", "Delivery wallet request changed"); }
    job = await this.job(task, quote.payload);
    if (!job.result) throw new ProviderError("OUTCOME_UNKNOWN", "Observe the existing specialist delivery; no replacement wallet send is allowed");
    if (!sameBlob(job.result, intent.ref)) throw new ProviderError("INTEGRITY_FAILED", "Finalized specialist delivery has another result");
    const receiptPath = resolve(directory, "delivery.json"), previous = await optional(receiptPath);
    if (previous) {
      const signed = await verifySigned<SpecialistDelivery>(JSON.parse(Buffer.from(previous).toString()), "delivery", task.scope, task.worker, task.workerSigningKey, task.deliveryNonce);
      validateDelivery(signed.payload, task, quote, (await this.options.clock()).timestampNs);
      if (!sameBlob(signed.payload.result, intent.ref) || signed.payload.artifactDigest !== hash(canonical(intent.artifact))) throw new ProviderError("INTEGRITY_FAILED", "Saved delivery receipt changed");
      return signed;
    }
    let payload: SpecialistDelivery;
    const savedPayload = await optional(resolve(directory, "delivery-payload.json"));
    if (savedPayload) payload = JSON.parse(Buffer.from(savedPayload).toString()) as SpecialistDelivery;
    else {
      payload = { schemaVersion: 1, commissionId: task.id, missionId: task.missionId, taskDigest: hash(canonical(task)), quoteDigest: signedDigest(quote), scope: task.scope, worker: task.worker,
        artifactDigest: hash(canonical(intent.artifact)), result: intent.ref, issuedAtNs: (await this.options.clock()).timestampNs, sequence: 2 };
      await save(resolve(directory, "delivery-payload.json"), payload);
    }
    const signed = await this.options.sign("delivery", payload, task.deliveryNonce);
    await verifySigned(signed, "delivery", task.scope, task.worker, task.workerSigningKey, task.deliveryNonce);
    await save(receiptPath, signed); return signed;
  }
  async observeDelivery(directory: string): Promise<{ commissionId: string; result: BlobRef; delivered: boolean; receiptAvailable: boolean }> {
    const { task, quote } = await this.load(directory), intent = JSON.parse(Buffer.from(await readPrivateFile(resolve(directory, "result-intent.json"), 240_000)).toString()) as ResultIntent;
    if (intent.digest !== intentDigest(intent) || intent.taskDigest !== hash(canonical(task)) || intent.quoteDigest !== signedDigest(quote)) throw new ProviderError("INTEGRITY_FAILED", "Delivery intent changed");
    await this.verifyResult(intent); const job = await this.job(task, quote.payload);
    if (job.result && !sameBlob(job.result, intent.ref)) throw new ProviderError("INTEGRITY_FAILED", "Observed result differs from the prepared delivery");
    return { commissionId: task.id, result: intent.ref, delivered: job.result !== null, receiptAvailable: Boolean(await optional(resolve(directory, "delivery.json"))) };
  }
  async retryPayout(directory: string, send: (request: { worker: string; contractId: string; method: "retry_payout"; args: { agent_id: string; operation_id: string } }) => Promise<void>): Promise<{ status: CommissionJob["status"]; payoutAttempt: string }> {
    const { task, quote } = await this.load(directory);
    const job = await this.job(task, quote.payload);
    if (["paid", "payout_pending"].includes(job.status)) return { status: job.status, payoutAttempt: job.payoutAttempt };
    if (job.status !== "payout_failed" || !job.result || BigInt(job.payoutAttempt) >= 8n) throw new ProviderError("OPERATION_CONFLICT", "Only a conclusively failed payout permits a bounded explicit retry");
    const intent = JSON.parse(Buffer.from(await readPrivateFile(resolve(directory, "result-intent.json"), 240_000)).toString()) as ResultIntent;
    if (intent.digest !== intentDigest(intent) || !sameBlob(job.result, intent.ref)) throw new ProviderError("INTEGRITY_FAILED", "Failed payout belongs to another delivery");
    const nextAttempt = String(BigInt(job.payoutAttempt) + 1n), marker = resolve(directory, `payout-retry-${nextAttempt}.json`);
    const request = { worker: task.worker, contractId: task.scope.contractId, method: "retry_payout" as const, args: { agent_id: task.scope.agentId, operation_id: task.id } };
    const bound = { taskDigest: hash(canonical(task)), previousFailedAttempt: job.payoutAttempt, nextAttempt, request };
    if (await optional(marker)) {
      if (canonical(JSON.parse(Buffer.from((await optional(marker))!).toString())) !== canonical(bound)) throw new ProviderError("INTEGRITY_FAILED", "Payout retry marker changed");
      throw new ProviderError("OUTCOME_UNKNOWN", "The prior retry handoff is unresolved; do not send a replacement");
    }
    try { await writePrivateFile(marker, json(bound)); } catch (error) { if (isObject(error) && error.code === "EEXIST") throw new ProviderError("OUTCOME_UNKNOWN", "Another payout retry handoff already exists"); throw error; }
    try { await send(request); } catch { /* Observe only, including a lost wallet response. */ }
    const observed = await this.job(task, quote.payload);
    if (BigInt(observed.payoutAttempt) < BigInt(nextAttempt)) throw new ProviderError("OUTCOME_UNKNOWN", "Wait for the existing payout retry to finalize");
    return { status: observed.status, payoutAttempt: observed.payoutAttempt };
  }
}
