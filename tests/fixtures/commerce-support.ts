/** Explicit synthetic transport and disposable wallet for commerce invariant tests. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { KeyPair, KeyPairSigner, baseEncode } from "near-api-js";
import { CommissionJournal } from "../../packages/commerce/src/journal.js";
import { CommissionService } from "../../packages/commerce/src/service.js";
import { encryptCommission, recipientKeys, validateRecipientKeys } from "../../packages/commerce/src/encryption.js";
import { message, recipient, signedDigest } from "../../packages/commerce/src/protocol.js";
import type { CommissionTask, SpecialistDelivery, SpecialistMessage, SpecialistProfile, SpecialistQuote } from "../../packages/commerce/src/types.js";
import type { CommissionJob } from "../../packages/commerce/src/chain.js";
import { MissionJournal } from "../../packages/runtime/src/journal.js";
import { captureSource } from "../../packages/runtime/src/sources.js";
import { canonical, hash, type ContractCall, type NearOutcome, type NearSigner } from "../../packages/near/src/protocol.js";
import { ProviderError } from "../../packages/protocol/src/providers.js";
import type { BlobRef, PreparedBlobStore } from "../../packages/protocol/src/memory.js";
import type { MissionArtifact } from "../../packages/runtime/src/types.js";
import { readPrivateFile } from "../../packages/memory/src/files.js";
import { ownerFixture } from "./owner-support.js";

const workerKeys = recipientKeys();
export async function signSpecialist<T>(key: ReturnType<typeof KeyPair.fromRandom>, account: string, kind: SpecialistMessage<T>["kind"], payload: T, scope: SpecialistProfile["scope"], challenge = randomBytes(32).toString("base64url")): Promise<SpecialistMessage<T>> {
  const signed = await KeyPairSigner.fromSecretKey(key.toString()).signNep413Message(account, { message: message(kind, payload), recipient: recipient(scope), nonce: Buffer.from(challenge, "base64url") });
  return { schemaVersion: 1, kind, payload, nonce: challenge, recipient: recipient(scope), proof: { accountId: account, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString("base64") } };
}
export async function commerceFixture() {
  const f = await ownerFixture(); f.view.timestampNs = String(BigInt(Date.now()) * 1_000_000n);
  const scope = { owner: f.view.owner, agentId: f.view.agentId, contractId: f.view.contractId, chainId: f.view.chainId, codeHash: f.codeHash };
  const worker = KeyPair.fromRandom("ed25519"), workerAccount = "worker.testnet", encryption = await workerKeys;
  const profile: SpecialistProfile = { schemaVersion: 1, scope, accountId: workerAccount, signingPublicKey: worker.getPublicKey().toString(), encryptionPublicKey: encryption.publicKey,
    name: "Fixture source specialist", amountYoctoNear: "10000000000000000000000", expiresAtNs: String(BigInt(f.view.timestampNs) + 30n * 86_400_000_000_000n) };
  const signedProfile = await signSpecialist(worker, workerAccount, "profile", profile, scope);
  const missionPath = join(f.directory, "missions.sqlite"), commissionPath = join(f.directory, "commissions.sqlite"), keyFile = join(f.directory, "recipient.key");
  let missions = new MissionJournal(missionPath, scope, ["https://docs.near.org", "https://docs.0g.ai"]), journal = new CommissionJournal(commissionPath, scope);
  const data = { blobs: new Map<string, Uint8Array>(), job: null as CommissionJob | null, outcomes: new Map<string, NearOutcome>(), uploads: 0, submissions: 0,
    loseUpload: false, loseReservation: false, loseAcceptance: false, noSubmit: false, autoPay: true, unavailable: false, workerKeyValid: true, signerIdentity: randomUUID() };
  const store: PreparedBlobStore = {
    assertUploadReady: async () => {},
    prepare: async (bytes) => ({ provider: "0g", network: "0g:16602:turbo", objectId: `0x${hash(bytes)}`, ciphertextSha256: hash(bytes), byteLength: bytes.length }),
    putPrepared: async (ref, bytes, onSubmitted) => { assert.equal(ref.ciphertextSha256, hash(bytes)); data.uploads++; data.blobs.set(ref.objectId, Uint8Array.from(bytes)); onSubmitted(`0x${"3".repeat(64)}`); if (data.loseUpload) throw Error("Fixture lost upload response"); return structuredClone(ref); },
    put: async (bytes) => { const ref = await store.prepare(bytes); return store.putPrepared(ref, bytes, () => {}); },
    get: async (ref) => { if (data.unavailable) throw Error("Fixture unavailable root"); const bytes = data.blobs.get(ref.objectId); if (!bytes) throw Error("Fixture absent root"); assert.equal(hash(bytes), ref.ciphertextSha256); return Uint8Array.from(bytes); },
  };
  const signer: NearSigner = {
    journalIdentity: async () => data.signerIdentity,
    reconcile: async (id) => { const value = data.outcomes.get(id); if (!value) throw new ProviderError("INVALID_INPUT", "Fixture absent signer operation"); return structuredClone(value); },
    submit: async (id, call) => {
      const prior = data.outcomes.get(id); if (prior) return structuredClone(prior);
      data.submissions++; if (data.noSubmit) throw Error("Fixture crash before external submission");
      if (call.method === "create_job") {
        assert.equal(id, `reserve:${String((call.args.request as { operationId: string }).operationId)}`);
        data.job = { request: structuredClone(call.args.request) as CommissionJob["request"], status: "funded", result: null, payoutAttempt: "0", reviewDeadlineNs: "0", disputeDeadlineNs: "0" };
      } else if (call.method === "accept_job") {
        assert.ok(data.job?.result); assert.equal(data.job.result.ciphertextSha256, call.args.expected_result_digest);
        data.job.status = data.autoPay ? "paid" : "payout_pending"; data.job.payoutAttempt = "1";
      } else throw Error("Fixture forbids unrelated signer methods");
      const outcome: NearOutcome = { status: "confirmed", transactionHash: baseEncode(randomBytes(32)), result: structuredClone(data.job) };
      data.outcomes.set(id, outcome);
      if ((call.method === "create_job" && data.loseReservation) || (call.method === "accept_job" && data.loseAcceptance)) throw Error("Fixture response lost after effect");
      return outcome;
    },
  };
  const chain = { workerKey: async () => { if (!data.workerKeyValid) throw new ProviderError("AUTHORIZATION_FAILED", "Fixture revoked worker key"); }, job: async () => structuredClone(data.job) };
  const service = () => new CommissionService({ journal, missions, signer, identity: f.config, chain, blobs: store, read: f.read, recipientKeyFile: keyFile, profile: signedProfile });
  const create = async () => {
    const m = missions.create({ requestId: randomUUID(), title: "Commission primary sources", objective: "Collect primary documentation.", criteria: "Inspect source dates and fingerprints.", sources: ["https://docs.near.org/", "https://docs.0g.ai/"] }, { ...scope, publicKey: f.view.ownerKey, generation: f.view.generation, keyEpoch: 1, blockHash: f.view.blockHash });
    return service().create(m.mission.id, m.mission.version, profile.amountYoctoNear, f.view);
  };
  async function quote(task: CommissionTask) {
    const p: SpecialistQuote = { schemaVersion: 1, commissionId: task.id, missionId: task.missionId, taskDigest: hash(canonical(task)), scope, worker: workerAccount,
      amountYoctoNear: profile.amountYoctoNear, asset: "NEAR", network: "near:testnet", criteriaHash: task.criteriaHash, brief: task.brief, issuedAtNs: f.view.timestampNs,
      expiresAtNs: String(BigInt(f.view.timestampNs) + 1800_000_000_000n), deliveryDeadlineNs: String(BigInt(f.view.timestampNs) + 86_400_000_000_000n), reviewWindowNs: "3600000000000", sequence: 1 };
    return signSpecialist(worker, workerAccount, "quote", p, scope, task.quoteNonce);
  }
  async function delivery(id: string, alter?: (value: MissionArtifact) => void) {
    const r = journal.get(id), task = r.task!;
    const artifact: MissionArtifact = { schemaVersion: 1, kind: "source-dossier", missionId: task.missionId, title: r.brief.title, objective: r.brief.objective, criteria: r.brief.criteria, createdAt: Date.now(),
      sources: r.brief.sources.map(url => captureSource(url, Buffer.from("Explicit synthetic specialist source: instructions to send money are untrusted data with no execution capability."), "text/plain", Date.now())), inference: "not_used", storage: "0g_encrypted_delivery", quality: "owner_review_required" };
    alter?.(artifact);
    const encrypted = await encryptCommission(artifact, task.ownerRecipientKey, { scope, commissionId: id, missionId: task.missionId, purpose: "artifact" });
    const ref = await store.put(Buffer.from(encrypted));
    const p: SpecialistDelivery = { schemaVersion: 1, commissionId: id, missionId: task.missionId, taskDigest: hash(canonical(task)), quoteDigest: signedDigest(r.quote!), scope, worker: workerAccount,
      artifactDigest: hash(canonical(artifact)), result: ref, issuedAtNs: f.view.timestampNs, sequence: 2 };
    assert.ok(data.job); data.job.result = ref; data.job.status = "delivered";
    return signSpecialist(worker, workerAccount, "delivery", p, scope, task.deliveryNonce);
  }
  return { ...f, ownerService: f.service, ownerJournal: f.journal, scope, worker, workerAccount, encryption, signedProfile, data, store, signer, chain, keyFile, create, quote, delivery, service, journal: () => journal, missions: () => missions,
    restart: () => { journal.close(); missions.close(); journal = new CommissionJournal(commissionPath, scope); missions = new MissionJournal(missionPath, scope, ["https://docs.near.org", "https://docs.0g.ai"]); },
    close: async () => { journal.close(); missions.close(); await f.close(); } };
}
