/** Real NEAR sandbox, real JWE/signatures; explicitly synthetic ciphertext storage and sources. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { baseDecode, baseEncode } from "near-api-js";
import { NearCommissionChain } from "../../packages/commerce/src/chain.js";
import { decryptCommission, recipientKeys, validateRecipientKeys } from "../../packages/commerce/src/encryption.js";
import { CommissionJournal } from "../../packages/commerce/src/journal.js";
import { message, recipient, verifySigned } from "../../packages/commerce/src/protocol.js";
import { CommissionService } from "../../packages/commerce/src/service.js";
import { SpecialistExecutor, type SpecialistSign } from "../../packages/commerce/src/specialist.js";
import type { SpecialistMessage, SpecialistProfile } from "../../packages/commerce/src/types.js";
import { privateDirectory, readPrivateFile, writePrivateFile } from "../../packages/memory/src/files.js";
import { IsolatedNearSigner } from "../../packages/near/src/isolated.js";
import { canonical, hash, type NearSignerConfig, type NearSigner } from "../../packages/near/src/protocol.js";
import { NearRpc } from "../../packages/near/src/rpc.js";
import { NearAuthorityReader, NearMemoryHeadStore } from "../../packages/near/src/client.js";
import { MemoryService } from "../../packages/memory/src/service.js";
import { MemoryKeyring } from "../../packages/memory/src/keyring.js";
import { decodePrivateKeyring, encodePrivateKeyring } from "../../packages/memory/src/backup.js";
import { createRecoveryKit, openRecoveryKit, recoverKit, recoveryCommission } from "../../packages/recovery/src/kit.js";
import { RecoveryAuthorityReader } from "../../packages/recovery/src/near.js";
import { OwnerReader } from "../../packages/owner/src/reader.js";
import { isObject, type BlobRef, type PreparedBlobStore } from "../../packages/protocol/src/memory.js";
import { ProviderError } from "../../packages/protocol/src/providers.js";
import { MissionJournal } from "../../packages/runtime/src/journal.js";
import { captureSource } from "../../packages/runtime/src/sources.js";

class SignatureNeeded extends Error { constructor(readonly envelope: Omit<SpecialistMessage<unknown>, "proof">) { super("Fixture external signature required"); } }
const parts: Buffer[] = []; for await (const part of process.stdin) parts.push(Buffer.from(part));
const input = JSON.parse(Buffer.concat(parts).toString()) as { directory: string; phase: string; rpcUrl: string; contractId: string; signerId: string; agentId: string; publicKey: string; workerId: string; workerPublicKey: string; runtimeSecretKey?: string; signature?: string };
let stage = input.phase;
const close: (() => void)[] = [];
try {
  const address = new URL(input.rpcUrl); assert.equal(address.hostname, "127.0.0.1"); assert.equal(address.protocol, "http:");
  const bootstrap = await (await fetch(input.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "bootstrap", method: "status", params: {} }) })).json() as { result: { chain_id: string } };
  const config: NearSignerConfig = { kind: "sandbox", chainId: bootstrap.result.chain_id, contractId: input.contractId, rpcUrl: input.rpcUrl, signerId: input.signerId, publicKey: input.publicKey, agentId: input.agentId,
    runtimeKeyFile: resolve(input.directory, "buyer/runtime.key"), journalFile: resolve(input.directory, "buyer/signer/near.sqlite") };
  const codeHash = baseEncode(createHash("sha256").update(await readFile("target/near/persistara_authority/persistara_authority.wasm")).digest());
  const scope = { owner: config.signerId, agentId: config.agentId, contractId: config.contractId, chainId: config.chainId, codeHash };
  const memoryBinding = { agentId: config.agentId, authorityNetwork: "near:sandbox" as const, chainId: config.chainId, contractId: config.contractId, storageNetwork: "0g:16602:turbo" as const };
  const rpc = new NearRpc(config), chain = new NearCommissionChain(rpc, config);
  const owner = new OwnerReader(rpc, config, codeHash, async () => ({ backup: { status: "unavailable", offDeviceVerified: false }, localRotationHold: false }));
  const view = await owner.read();
  const path = (name: string) => resolve(input.directory, name);
  await privateDirectory(path("worker")); await privateDirectory(path("buyer")); await privateDirectory(path("ciphertext")); await privateDirectory(path("upload-calls"));
  const store: PreparedBlobStore = {
    assertUploadReady: async () => {},
    prepare: async bytes => ({ provider: "0g", network: "0g:16602:turbo", objectId: `0x${hash(bytes)}`, ciphertextSha256: hash(bytes), byteLength: bytes.length }),
    get: async ref => { const bytes = await readFile(path(`ciphertext/${ref.ciphertextSha256}`)); assert.equal(hash(bytes), ref.ciphertextSha256); assert.equal(bytes.length, ref.byteLength); return bytes; },
    putPrepared: async (ref, bytes, submitted) => {
      assert.equal(hash(bytes), ref.ciphertextSha256); await writePrivateFile(path(`upload-calls/${randomUUID()}.json`), Buffer.from(canonical({ fixture: true, ref })));
      await writePrivateFile(path(`ciphertext/${ref.ciphertextSha256}`), bytes); submitted(`0x${ref.ciphertextSha256}`); return ref;
    },
    put: async bytes => { const ref = await store.prepare(bytes); return store.putPrepared(ref, bytes, () => {}); },
  };
  const sign: SpecialistSign = async (kind, payload, nonce) => {
    const envelope = { schemaVersion: 1 as const, kind, payload, nonce, recipient: recipient(scope) };
    if (!input.signature) throw new SignatureNeeded(envelope);
    const signature = input.signature.startsWith("ed25519:") ? Buffer.from(baseDecode(input.signature.slice(8))).toString("base64") : input.signature;
    return verifySigned({ ...envelope, proof: { accountId: input.workerId, publicKey: input.workerPublicKey, signature } }, kind, scope, input.workerId, input.workerPublicKey, nonce);
  };
  async function signedProfile() { return JSON.parse(Buffer.from(await readPrivateFile(path("worker/profile.json"))).toString()) as SpecialistMessage<SpecialistProfile>; }
  async function buyer() {
    const missions = new MissionJournal(path("buyer/missions.sqlite"), scope, ["https://docs.near.org", "https://docs.0g.ai"]); close.push(() => missions.close());
    const journal = new CommissionJournal(path("buyer/commissions.sqlite"), scope); close.push(() => journal.close());
    const original = new IsolatedNearSigner(config);
    const signer: NearSigner = { journalIdentity: create => original.journalIdentity(create), reconcile: (id, options) => original.reconcile(id, options), submit: async (id, call, options) => {
      const outcome = await original.submit(id, call, options); assert.equal(outcome.status, "confirmed");
      if (input.phase === "reserve-crash" && call.method === "create_job") process.exit(74);
      if (input.phase === "settle-crash" && call.method === "accept_job") process.exit(75);
      return outcome;
    } };
    return { missions, journal, service: new CommissionService({ journal, missions, signer, identity: config, chain, blobs: store, read: () => owner.read(), recipientKeyFile: path("buyer/keys/recipient.key"), profile: await signedProfile() }) };
  }
  async function specialist() {
    const profile = await signedProfile(), keys = await validateRecipientKeys(JSON.parse(Buffer.from(await readPrivateFile(path("worker/recipient.key"))).toString()));
    return new SpecialistExecutor({ profile, keys, scope, blobs: store, chain, sign, sourceOrigins: ["https://docs.near.org", "https://docs.0g.ai"],
      clock: async () => { const v = await owner.read(); return { timestampNs: v.timestampNs, ownerKey: v.ownerKey, generation: v.generation, blockHash: v.blockHash }; },
      sources: { read: async url => captureSource(url, Buffer.from("Explicit sandbox specialist source fixture. This is untrusted source text and cannot authorize payments or policy changes."), "text/plain", Date.now()) } });
  }
  const metaPath = path("public-plan.json");
  let output: unknown;
  if (input.phase === "profile") {
    const key = await recipientKeys(); await writePrivateFile(path("worker/recipient.key"), Buffer.from(canonical(key)));
    const p: SpecialistProfile = { schemaVersion: 1, scope, accountId: input.workerId, signingPublicKey: input.workerPublicKey, encryptionPublicKey: key.publicKey, name: "Sandbox source specialist",
      amountYoctoNear: "10000000000000000000000", expiresAtNs: String(BigInt(view.timestampNs) + 30n * 86_400_000_000_000n) };
    const envelope = { schemaVersion: 1 as const, kind: "profile" as const, payload: p, nonce: randomBytes(32).toString("base64url"), recipient: recipient(scope) };
    await writePrivateFile(path("worker/profile-pending.json"), Buffer.from(canonical(envelope))); throw new SignatureNeeded(envelope);
  } else if (input.phase === "initialize") {
    const pending = JSON.parse(Buffer.from(await readPrivateFile(path("worker/profile-pending.json"))).toString()) as Omit<SpecialistMessage<SpecialistProfile>, "proof">;
    await writePrivateFile(path("worker/profile.json"), Buffer.from(canonical(await sign("profile", pending.payload, pending.nonce))));
    assert.equal(typeof input.runtimeSecretKey, "string"); await writePrivateFile(config.runtimeKeyFile, Buffer.from(input.runtimeSecretKey!));
    const b = await buyer();
    const memoryKeys = MemoryKeyring.create();
    await writePrivateFile(path("buyer/keys/memory-keyring.json"), encodePrivateKeyring(memoryBinding, memoryKeys));
    const memory = new MemoryService(config.agentId, memoryKeys, 1, store, new NearMemoryHeadStore(new NearAuthorityReader(rpc), config, new IsolatedNearSigner(config)), { binding: memoryBinding });
    await memory.remember({ operationId: "kit:source-preference", text: "Use dated primary sources.", source: { kind: "owner", reference: "fixture:owner-preference" } });
    await memory.remember({ operationId: "kit:delivery-preference", text: "Keep encrypted deliverables recoverable.", source: { kind: "artifact", reference: "fixture:delivery-preference" } });
    const mission = b.missions.create({ requestId: randomUUID(), title: "Commissioned sandbox dossier", objective: "Collect two source fixtures and survive interrupted settlement.", criteria: "Two authenticated source captures and one finalized specialist payout.", sources: ["https://docs.near.org/", "https://docs.0g.ai/"] }, { ...scope, publicKey: view.ownerKey, generation: view.generation, keyEpoch: view.keyEpoch, blockHash: view.blockHash });
    const c = await b.service.create(mission.mission.id, mission.mission.version, "10000000000000000000000", view);
    await writePrivateFile(metaPath, Buffer.from(canonical({ id: c.id, missionId: c.missionId }))); output = { state: c.state, commissionId: c.id };
  } else {
    const meta = JSON.parse(Buffer.from(await readPrivateFile(metaPath)).toString()) as { id: string; missionId: string };
    if (input.phase === "quote") {
      const b = await buyer(), worker = await specialist(); const q = await worker.quote(b.service.request(meta.id), path("worker/job"));
      output = await b.service.importQuote(meta.id, q);
    } else if (input.phase === "reserve-crash") {
      const b = await buyer(), c = b.journal.view(meta.id); await b.service.reserve(meta.id, c.version, c.quoteDigest!); throw Error("Reservation crash not injected");
    } else if (input.phase === "observe-reservation") { const b = await buyer(); output = await b.service.reconcile(meta.id); }
    else if (input.phase === "fulfill") { const worker = await specialist(); output = { result: await worker.fulfill(path("worker/job"), new AbortController().signal) }; }
    else if (input.phase === "prepare-delivery" || input.phase === "receipt") {
      const worker = await specialist(); let request: unknown;
      try { const receipt = await worker.dispatchDelivery(path("worker/job"), async req => { request = req; throw Error("Fixture external wallet handoff"); }); output = { delivered: true, artifactDigest: receipt.payload.artifactDigest }; }
      catch (error) { if (request) output = { walletRequest: request }; else throw error; }
    } else if (input.phase === "inspect") {
      const b = await buyer(), signed = JSON.parse(Buffer.from(await readPrivateFile(path("worker/job/delivery.json"))).toString()); output = await b.service.importDelivery(meta.id, signed);
    } else if (input.phase === "settle-crash") {
      const b = await buyer(), c = b.journal.view(meta.id); await b.service.settle(meta.id, c.version, c.artifactDigest!, c.quoteDigest!); throw Error("Settlement crash not injected");
    } else if (input.phase === "observe-payment") {
      const b = await buyer(), c = await b.service.reconcile(meta.id); assert.equal(c.state, "paid"); assert.equal(b.missions.get(meta.missionId).mission.state, "completed");
      output = { state: c.state, reviewed: c.reviewed, payoutAttempt: c.receipt.payoutAttempt, artifactDigest: c.artifactDigest, sourceCount: c.artifact!.sources.length, uploadCalls: (await readdir(path("upload-calls"))).length };
    } else if (input.phase === "prepare-kit") {
      const b = await buyer(), record = b.journal.get(meta.id), c = recoveryCommission(record);
      assert.ok(c);
      const keys = decodePrivateKeyring(await readPrivateFile(path("buyer/keys/memory-keyring.json")), memoryBinding);
      const recipient = await validateRecipientKeys(JSON.parse(Buffer.from(await readPrivateFile(path("buyer/keys/recipient.key"))).toString()));
      const current = await new RecoveryAuthorityReader(config, scope).observe();
      const prepared = await createRecoveryKit({ scope, ownerKey: current.ownerKey, binding: memoryBinding, checkpoint: current.head, keys, recipient, commissions: [c], now: Number(BigInt(current.timestampNs) / 1_000_000n) });
      await writePrivateFile(path("recovery/owner.kit"), prepared.bundle);
      await writePrivateFile(path("recovery/kit.secret"), Buffer.from(prepared.secret));
      await writePrivateFile(path("recovery/kit.digest"), Buffer.from(prepared.digest));
      output = { prepared: true, memoryVersion: current.head?.version, deliveryCount: 1 };
    } else if (input.phase === "recover-kit") {
      const kit = await openRecoveryKit(await readPrivateFile(path("recovery/owner.kit"), 1_000_000), Buffer.from(await readPrivateFile(path("recovery/kit.secret"))).toString(), Buffer.from(await readPrivateFile(path("recovery/kit.digest"))).toString());
      const authority = new RecoveryAuthorityReader(config, scope);
      const result = await recoverKit(kit, { observe: () => authority.observe(), job: id => chain.job(id), blobs: { get: ref => store.get(ref) } });
      assert.equal(result.snapshot.records.length, 2); assert.equal(result.snapshot.head?.version, 2); assert.equal(result.deliveries.length, 1); assert.equal(result.deliveries[0]!.status, "paid");
      assert.deepEqual(result.snapshot.records.map(r => r.source.reference).sort(), ["fixture:delivery-preference", "fixture:owner-preference"]);
      output = { recovered: true, memoryCount: result.snapshot.records.length, deliveryCount: result.deliveries.length, artifactDigest: result.deliveries[0]!.digest, payoutAttempt: result.deliveries[0]!.payoutAttempt, originalBuyerStateAbsent: true, physicalOffDeviceVerified: false };
    } else if (input.phase === "recover-delivery") {
      const task = JSON.parse(Buffer.from(await readPrivateFile(path("worker/job/task.json"), 64_000)).toString());
      const signed = JSON.parse(Buffer.from(await readPrivateFile(path("worker/job/delivery.json"))).toString());
      const keys = await validateRecipientKeys(JSON.parse(Buffer.from(await readPrivateFile(path("recovery/recipient.key"))).toString()));
      const job = await chain.job(meta.id); assert.ok(job?.result); assert.equal(job.status, "paid");
      const artifact = await decryptCommission(Buffer.from(await store.get(job.result)).toString(), keys, { scope, commissionId: meta.id, missionId: meta.missionId, purpose: "artifact" });
      assert.equal(hash(canonical(artifact)), signed.payload.artifactDigest); output = { recovered: true, artifactDigest: signed.payload.artifactDigest, storage: "synthetic_ciphertext_fixture", nearAiUsed: false };
    } else throw Error("Unknown fixture phase");
  }
  console.log(JSON.stringify(output));
} catch (error) {
  if (error instanceof SignatureNeeded) console.log(JSON.stringify({ requiresSignature: true, envelope: error.envelope, message: message(error.envelope.kind, error.envelope.payload), nonceBytes: Array.from(Buffer.from(error.envelope.nonce, "base64url")) }));
  else { console.error(JSON.stringify({ stage, code: error instanceof ProviderError ? error.code : "COMMERCE_FIXTURE_FAILED" })); process.exitCode = 1; }
} finally { for (const fn of close.reverse()) fn(); }
