/** Disposable test wallet only. Never imported by application/browser source. */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair, KeyPairSigner, baseEncode } from "near-api-js";
import type { NearSignerConfig } from "../../packages/near/src/protocol.js";
import { OwnerJournal } from "../../packages/owner/src/journal.js";
import { OwnerService } from "../../packages/owner/src/service.js";
import type { OwnerChallenge, OwnerOperation, OwnerView } from "../../packages/owner/src/types.js";

export async function ownerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "persistara-owner-"));
  const owner = KeyPair.fromRandom("ed25519"), runtime = KeyPair.fromRandom("ed25519");
  const config: NearSignerConfig = { kind: "testnet", chainId: "testnet", rpcUrl: "https://rpc.testnet.near.org", contractId: "authority.testnet", agentId: "owner.testnet:research", signerId: "owner.testnet", publicKey: runtime.getPublicKey().toString(), journalFile: join(directory, "runtime.sqlite"), runtimeKeyFile: join(directory, "runtime.key") };
  const codeHash = baseEncode(randomBytes(32));
  const view: OwnerView = { owner: config.signerId, ownerKey: owner.getPublicKey().toString(), ownerNonce: 30, ownerKeyFullAccess: true,
    agentId: config.agentId, contractId: config.contractId, chainId: "testnet", codeHash, blockHash: baseEncode(randomBytes(32)), timestampNs: "1794050000000000000",
    paused: false, generation: "3", keyEpoch: 1, checkpointVersion: 1, balances: { available: "90000000000000000000000", reserved: "0", pending: "0", paid: "10000000000000000000000" }, policy: { maxJobAmount: "20000000000000000000000", dailyLimit: "50000000000000000000000" },
    runtimeKeys: [{ publicKey: config.publicKey, methods: ["checkpoint_memory", "create_job", "accept_job"], allowance: "250000000000000000000000", expiresAtNs: "1794750000000000000", ready: true }], backup: { status: "verified", offDeviceVerified: false }, localRotationHold: false, canResume: true };
  const journalFile = join(directory, "owner.sqlite");
  let journal = new OwnerJournal(journalFile, config, codeHash);
  const transport = { available: true, calls: 0, chainMatches: true, transactions: new Map<string, unknown>() };
  const rpc = {
    assertNetwork: async () => { if (!transport.chainMatches) throw new Error("Fixture network mismatch"); },
    request: async (method: string, params: unknown) => {
      if (method !== "tx") throw new Error("Owner service must never sign/broadcast");
      transport.calls++;
      if (!transport.available) throw new Error("Fixture lost response");
      const value = transport.transactions.get(String((params as { tx_hash: string }).tx_hash));
      if (!value) throw new Error("Fixture transaction unavailable");
      return structuredClone(value);
    },
  };
  const read = async () => structuredClone(view);
  const service = () => new OwnerService(config, journal, read, rpc);
  return { directory, owner, runtime, config, codeHash, view, transport, journalFile, journal: () => journal, service, read,
    restart: () => { journal.close(); journal = new OwnerJournal(journalFile, config, codeHash); },
    close: async () => { journal.close(); await rm(directory, { recursive: true, force: true }); } };
}
export async function signChallenge(owner: ReturnType<typeof KeyPair.fromRandom>, challenge: OwnerChallenge) {
  const signer = KeyPairSigner.fromSecretKey(owner.toString());
  const signed = await signer.signNep413Message(challenge.signerId, { message: challenge.message, recipient: challenge.recipient, nonce: Buffer.from(challenge.nonce, "base64url") });
  return { accountId: signed.accountId, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString("base64"), challengeId: challenge.id };
}
export function ownerReceipt(row: OwnerOperation, txHash = baseEncode(randomBytes(32))) {
  const request = row.request;
  return { final_execution_status: "FINAL", transaction: { hash: txHash, signer_id: request.signerId, public_key: request.ownerPublicKey, receiver_id: request.receiverId, nonce: request.minimumNonce + 1,
    actions: [{ FunctionCall: { method_name: "set_paused", args: Buffer.from(JSON.stringify(request.actions[0].params.args)).toString("base64"), gas: 100_000_000_000_000, deposit: "0" } }] },
    status: { SuccessValue: Buffer.from(JSON.stringify({ id: request.agentId, owner: request.signerId, ownerKey: request.ownerPublicKey, paused: request.paused, generation: String(BigInt(request.expectedGeneration) + 1n) })).toString("base64") } };
}
