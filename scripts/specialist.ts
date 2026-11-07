/** Self-operated specialist. Wallet signing stays in the external official NEAR CLI keychain. */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { baseDecode, baseEncode } from "near-api-js";
import { NearCommissionChain } from "../packages/commerce/src/chain.js";
import { recipientKeys, validateRecipientKeys } from "../packages/commerce/src/encryption.js";
import { message, recipient, validateProfile, verifySigned } from "../packages/commerce/src/protocol.js";
import { SpecialistExecutor, type SpecialistSign } from "../packages/commerce/src/specialist.js";
import type { CommissionTask, SpecialistMessage, SpecialistProfile } from "../packages/commerce/src/types.js";
import { privateDirectory, readPrivateFile, writePrivateFile } from "../packages/memory/src/files.js";
import { NearAuthorityReader } from "../packages/near/src/client.js";
import { nearConfig } from "../packages/near/src/config.js";
import { accountId, canonical, decimal, publicKey, transactionHash } from "../packages/near/src/protocol.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { storageConfig } from "../packages/protocol/src/config.js";
import { isObject } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { PublicSourceReader, sourceOrigins } from "../packages/runtime/src/sources.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { loadEnvironment, printFailure } from "./common.js";

async function main() {
  loadEnvironment();
  const [command, first, second, ...extra] = process.argv.slice(2);
  if (!["init", "quote", "fulfill", "deliver", "reconcile", "retry-payout"].includes(command ?? "") || extra.length || (command !== "quote" && second)) throw new ProviderError("INVALID_INPUT", "Use specialist init | quote <request-file> <job-directory> | fulfill|deliver|reconcile|retry-payout <job-directory>");
  const config = nearConfig(process.env), rpc = new NearRpc(config), agentReader = new NearAuthorityReader(rpc);
  const actor = process.env.PERSISTARA_SPECIALIST_ACCOUNT, signingKey = process.env.PERSISTARA_SPECIALIST_SIGNING_KEY;
  if (!accountId(actor) || !publicKey(signingKey) || !signingKey.startsWith("ed25519:") || actor === config.signerId) throw new ProviderError("NOT_CONFIGURED", "Configure a separate specialist account and its pinned public signing key");
  const wasm = await readFile("target/near/persistara_authority/persistara_authority.wasm");
  const scope = { owner: config.signerId, agentId: config.agentId, contractId: config.contractId, chainId: config.chainId, codeHash: baseEncode(createHash("sha256").update(wasm).digest()) };
  const chain = new NearCommissionChain(rpc, config);
  const clock = async () => {
    await rpc.assertNetwork(); const block = await rpc.request("block", { finality: "final" });
    if (!isObject(block) || !isObject(block.header) || !transactionHash(block.header.hash) || !decimal(block.header.timestamp_nanosec, 64, true)) throw new ProviderError("PROTOCOL_ERROR", "Missing finalized specialist clock");
    const account = await rpc.request("query", { request_type: "view_account", block_id: block.header.hash, account_id: scope.contractId });
    if (!isObject(account) || account.block_hash !== block.header.hash || account.code_hash !== scope.codeHash) throw new ProviderError("INTEGRITY_FAILED", "Specialist contract code changed");
    const agent = await agentReader.agent(scope.agentId);
    if (agent.owner !== scope.owner) throw new ProviderError("AUTHORIZATION_FAILED", "Specialist agent owner changed");
    return { timestampNs: block.header.timestamp_nanosec, blockHash: block.header.hash, ownerKey: agent.ownerKey, generation: agent.generation };
  };
  const controller = new AbortController(); process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  const binary = process.env.NEAR_CLI_BIN || "near";
  const sign: SpecialistSign = async (kind, payload, nonce) => {
    let output: { stdout: string; stderr: string };
    try {
      output = await promisify(execFile)(binary, ["message", "sign-nep413", "base64", Buffer.from(message(kind, payload)).toString("base64"), "nonce", Buffer.from(nonce, "base64url").toString("base64"), "recipient", recipient(scope), "sign-as", actor, "sign-with-keychain", "network-config", "testnet"], { timeout: 90_000, maxBuffer: 100_000, signal: controller.signal });
    } catch { throw new ProviderError("UPSTREAM_ERROR", "External specialist wallet did not return a message signature"); }
    const raw = `${output.stdout}\n${output.stderr}`.replace(/\u001b\[[0-9;]*m/g, ""); let signed: Record<string, unknown> | null = null;
    for (let start = raw.indexOf("{"); start !== -1 && !signed; start = raw.indexOf("{", start + 1)) for (let end = raw.indexOf("}", start); end !== -1; end = raw.indexOf("}", end + 1)) {
      try { const value: unknown = JSON.parse(raw.slice(start, end + 1)); if (isObject(value) && (value.accountId ?? value.account_id) === actor && typeof value.signature === "string") { signed = value; break; } } catch {}
    }
    if (!signed || (signed.publicKey ?? signed.public_key) !== signingKey || typeof signed.signature !== "string") throw new ProviderError("VERIFICATION_FAILED", "External specialist wallet signed with another key or unsupported format");
    const signature = signed.signature.startsWith("ed25519:") ? Buffer.from(baseDecode(signed.signature.slice(8))).toString("base64") : signed.signature;
    const result = { schemaVersion: 1 as const, kind, payload, nonce, recipient: recipient(scope), proof: { accountId: actor, publicKey: signingKey, signature } };
    return verifySigned(result, kind, scope, actor, signingKey, nonce);
  };
  const state = resolve(process.env.PERSISTARA_SPECIALIST_STATE_DIR || ".persistara/specialist"), keyFile = resolve(state, "keys/recipient.key"), profileFile = resolve(state, "profile.json");
  await privateDirectory(state);
  if (command === "init") {
    let existing = false;
    try { await readPrivateFile(profileFile); existing = true; } catch (error) { if (!isObject(error) || error.code !== "ENOENT") throw error; }
    if (existing) { console.log(JSON.stringify({ status: "specialist_profile_exists", profileFile, privateKeyPrinted: false })); return; }
    let keys;
    try { keys = await validateRecipientKeys(JSON.parse(Buffer.from(await readPrivateFile(keyFile)).toString())); }
    catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") throw error;
      await writePrivateFile(resolve(state, "initializing.json"), Buffer.from(canonical({ accountId: actor, signingPublicKey: signingKey })));
      keys = await recipientKeys(); await writePrivateFile(keyFile, Buffer.from(canonical(keys)));
    }
    const current = await clock(), amount = process.env.PERSISTARA_SPECIALIST_PRICE_YOCTO || "10000000000000000000000";
    if (!decimal(amount, 128, true)) throw new ProviderError("INVALID_INPUT", "Specialist price must be positive integer yoctoNEAR");
    const profile: SpecialistProfile = { schemaVersion: 1, scope, accountId: actor, signingPublicKey: signingKey, encryptionPublicKey: keys.publicKey, name: "Persistara Source Desk", amountYoctoNear: amount, expiresAtNs: String(BigInt(current.timestampNs) + 30n * 86_400_000_000_000n) };
    await chain.workerKey(profile, current.blockHash);
    const signed = await sign("profile", profile, randomBytes(32).toString("base64url")); await writePrivateFile(profileFile, Buffer.from(canonical(signed)));
    console.log(JSON.stringify({ status: "specialist_profile_created", accountId: actor, profileFile, nearAiUsed: false, publicTransactionSubmitted: false })); return;
  }
  const profile = JSON.parse(Buffer.from(await readPrivateFile(profileFile)).toString()) as SpecialistMessage<SpecialistProfile>;
  if (profile.payload.accountId !== actor || profile.payload.signingPublicKey !== signingKey) throw new ProviderError("INTEGRITY_FAILED", "Specialist identity differs from its private state");
  await verifySigned(profile, "profile", scope, actor, signingKey);
  const current = await clock(); await chain.workerKey(profile.payload, current.blockHash);
  const keys = await validateRecipientKeys(JSON.parse(Buffer.from(await readPrivateFile(keyFile)).toString()));
  const origins = sourceOrigins(process.env.PERSISTARA_SOURCE_ORIGINS);
  const specialist = new SpecialistExecutor({ profile, keys, scope, blobs: new ZeroGBlobStore(storageConfig(process.env)), chain, sources: new PublicSourceReader(origins), sourceOrigins: origins, clock, sign });
  if (command === "quote") {
    if (!first || !second) throw new ProviderError("INVALID_INPUT", "Provide request file and private job directory");
    const bytes = await readFile(resolve(first)); if (bytes.length > 64_000) throw new ProviderError("INVALID_INPUT", "Specialist request exceeds its bound");
    const task = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as CommissionTask;
    const quote = await specialist.quote(task, resolve(second)); console.log(JSON.stringify({ status: "quote_signed", commissionId: task.id, amountYoctoNear: quote.payload.amountYoctoNear, quoteFile: resolve(second, "quote.json"), nearAiUsed: false })); return;
  }
  if (!first) throw new ProviderError("INVALID_INPUT", "Provide the canonical private specialist job directory");
  const directory = resolve(first);
  if (command === "fulfill") {
    const ref = await specialist.fulfill(directory, controller.signal); console.log(JSON.stringify({ status: "encrypted_result_available_not_delivered", result: ref, nearAiUsed: false, nearTransactionSubmitted: false, storageUploadMayHaveBeenSubmitted: true })); return;
  }
  if (command === "reconcile") { console.log(JSON.stringify({ status: "specialist_delivery_observed", ...await specialist.observeDelivery(directory), nearAiUsed: false, publicTransactionSubmitted: false })); return; }
  const send = async (request: { worker: string; contractId: string; method: "deliver" | "retry_payout"; args: unknown }) => {
    try {
      await promisify(execFile)(binary, ["contract", "call-function", "as-transaction", request.contractId, request.method, "json-args", JSON.stringify(request.args), "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR", "sign-as", request.worker, "network-config", "testnet", "sign-with-keychain", "--signer-public-key", signingKey, "send"], { timeout: 120_000, maxBuffer: 200_000, signal: controller.signal });
    } catch { throw new ProviderError("OUTCOME_UNKNOWN", "Specialist wallet outcome is unknown; observe the fixed job before any further action"); }
  };
  if (command === "retry-payout") { console.log(JSON.stringify({ status: "existing_payout_retry_observed", result: await specialist.retryPayout(directory, send), nearAiUsed: false })); return; }
  const receipt = await specialist.dispatchDelivery(directory, send);
  console.log(JSON.stringify({ status: "specialist_delivery_verified", commissionId: receipt.payload.commissionId, deliveryFile: resolve(directory, "delivery.json"), artifactDigest: receipt.payload.artifactDigest, nearAiUsed: false }));
}
main().catch(printFailure);
