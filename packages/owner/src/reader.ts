import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { accountId, decimal, decodeHead, transactionHash, validateIdentity, publicKey, type RuntimeIdentity } from "../../near/src/protocol.js";
import { delegate, replacementMethods } from "../../near/src/rotation.js";
import { NearRpc } from "../../near/src/rpc.js";
import type { OwnerView } from "./types.js";

export interface LocalReadiness { backup: OwnerView["backup"]; localRotationHold: boolean | null }
export class OwnerReader {
  constructor(private readonly rpc: NearRpc, private readonly identity: RuntimeIdentity, private readonly expectedCodeHash: string,
    private readonly local: (epoch: number) => Promise<LocalReadiness>, private readonly deadlineMs = 20_000) { validateIdentity(identity); }
  async read(): Promise<OwnerView> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.observe(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderError("UPSTREAM_ERROR", "Finalized owner readiness exceeded its deadline")), this.deadlineMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async observe(): Promise<OwnerView> {
    const rpc = this.rpc;
    await rpc.assertNetwork();
    const block = await rpc.request("block", { finality: "final" });
    if (!isObject(block) || !isObject(block.header) || !transactionHash(block.header.hash) || !decimal(block.header.timestamp_nanosec)) throw new ProviderError("PROTOCOL_ERROR", "Invalid finalized owner block");
    const blockHash = block.header.hash;
    // One network check and three parallel queries at the same block; no duplicate views.
    const [call, account, keys] = await Promise.all([
      rpc.request("query", { request_type: "call_function", block_id: blockHash, account_id: rpc.config.contractId, method_name: "get_agent", args_base64: Buffer.from(JSON.stringify({ agent_id: this.identity.agentId })).toString("base64") }),
      rpc.request("query", { request_type: "view_account", block_id: blockHash, account_id: rpc.config.contractId }),
      rpc.request("query", { request_type: "view_access_key_list", block_id: blockHash, account_id: this.identity.signerId, limit: 129 }),
    ]);
    if (!isObject(call) || call.block_hash !== blockHash || !Array.isArray(call.result) || call.result.length > 150_000 || call.result.some((b: unknown) => !Number.isInteger(b) || Number(b) < 0 || Number(b) > 255) ||
        !isObject(account) || account.block_hash !== blockHash || account.code_hash !== this.expectedCodeHash || !isObject(keys) || keys.block_hash !== blockHash ||
        (keys.last_key !== undefined && keys.last_key !== null) || !Array.isArray(keys.keys) || keys.keys.length > 128) throw new ProviderError("INTEGRITY_FAILED", "Authority code, complete keys or finalized state differs from the expected deployment");
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(call.result as number[]))); }
    catch { throw new ProviderError("PROTOCOL_ERROR", "Invalid owner authority JSON"); }
    if (!isObject(raw) || raw.id !== this.identity.agentId || raw.owner !== this.identity.signerId || !publicKey(raw.ownerKey) || typeof raw.paused !== "boolean" ||
        !decimal(raw.generation, 64, true) || !decimal(raw.keyEpoch, 64, true) || BigInt(raw.keyEpoch) > BigInt(Number.MAX_SAFE_INTEGER) || !Array.isArray(raw.delegates) || raw.delegates.length > 8) throw new ProviderError("PROTOCOL_ERROR", "Invalid owner authority state");
    const accessKeys = keys.keys.map((entry: unknown) => {
      if (!isObject(entry) || !publicKey(entry.public_key) || !isObject(entry.access_key) || !Number.isSafeInteger(entry.access_key.nonce) || Number(entry.access_key.nonce) < 0 ||
          !(entry.access_key.permission === "FullAccess" || (isObject(entry.access_key.permission) && isObject(entry.access_key.permission.FunctionCall)))) throw new ProviderError("PROTOCOL_ERROR", "Invalid owner account access key");
      return { publicKey: entry.public_key, nonce: Number(entry.access_key.nonce), permission: entry.access_key.permission };
    });
    const delegates = raw.delegates.map(delegate);
    if (new Set(accessKeys.map((key) => key.publicKey)).size !== accessKeys.length || new Set(delegates.map((grant) => grant.publicKey)).size !== delegates.length) throw new ProviderError("PROTOCOL_ERROR", "Duplicate owner keys or delegates");
    const snapshot = { owner: raw.owner as string, ownerKey: raw.ownerKey, paused: raw.paused, generation: raw.generation, keyEpoch: Number(raw.keyEpoch), head: decodeHead(raw.head), accessKeys, delegates,
      agentId: this.identity.agentId, contractId: rpc.config.contractId, chainId: rpc.config.chainId, blockHash, timestampNs: block.header.timestamp_nanosec };
    const balanceNames = ["deposited", "available", "reserved", "pending", "paid", "withdrawn"];
    if (balanceNames.some((key) => !decimal(raw[key], 128)) || BigInt(String(raw.deposited)) !== ["available", "reserved", "pending", "paid", "withdrawn"].reduce((sum, key) => sum + BigInt(String(raw[key])), 0n)) throw new ProviderError("INTEGRITY_FAILED", "Treasury balances do not conserve funds");
    const owner = snapshot.accessKeys.find((key) => key.publicKey === snapshot.ownerKey);
    const runtimeKeys = snapshot.delegates.map((grant) => {
      const key = snapshot.accessKeys.find((entry) => entry.publicKey === grant.publicKey);
      const p = isObject(key?.permission) && isObject(key.permission.FunctionCall) ? key.permission.FunctionCall : null;
      const methods = p && Array.isArray(p.method_names) && p.method_names.every((m: unknown) => typeof m === "string") ? p.method_names as string[] : [];
      const allowance = p && decimal(p.allowance, 128, true) ? p.allowance : null;
      const ready = p?.receiver_id === snapshot.contractId && Boolean(allowance) && BigInt(allowance ?? "0") <= 1_000_000_000_000_000_000_000_000n &&
        JSON.stringify([...methods].sort()) === JSON.stringify(replacementMethods(grant).sort()) && grant.canCheckpoint && BigInt(grant.expiresAtNs) > BigInt(snapshot.timestampNs);
      return { publicKey: grant.publicKey, methods, allowance, expiresAtNs: grant.expiresAtNs, ready };
    });
    let policy: OwnerView["policy"] = null;
    if (raw.policy !== null) {
      if (!isObject(raw.policy) || !decimal(raw.policy.maxJobAmount, 128, true) || !decimal(raw.policy.dailyLimit, 128, true) || !Array.isArray(raw.policy.approvedWorkers) || raw.policy.approvedWorkers.length < 1 || raw.policy.approvedWorkers.length > 16 || !raw.policy.approvedWorkers.every(accountId) || new Set(raw.policy.approvedWorkers).size !== raw.policy.approvedWorkers.length) throw new ProviderError("PROTOCOL_ERROR", "Invalid treasury policy");
      policy = { maxJobAmount: raw.policy.maxJobAmount, dailyLimit: raw.policy.dailyLimit, approvedWorkers: raw.policy.approvedWorkers };
    }
    const local = await this.local(snapshot.keyEpoch);
    return { owner: snapshot.owner, ownerKey: snapshot.ownerKey, ownerNonce: owner?.nonce ?? 0, ownerKeyFullAccess: owner?.permission === "FullAccess",
      agentId: snapshot.agentId, contractId: snapshot.contractId, chainId: snapshot.chainId, blockHash: snapshot.blockHash, timestampNs: snapshot.timestampNs, codeHash: this.expectedCodeHash,
      paused: snapshot.paused, generation: snapshot.generation, policyVersion: decimal(raw.policyVersion) ? raw.policyVersion : (() => { throw new ProviderError("PROTOCOL_ERROR", "Invalid policy version"); })(), keyEpoch: snapshot.keyEpoch, checkpointVersion: snapshot.head?.version ?? 0,
      balances: { available: String(raw.available), reserved: String(raw.reserved), pending: String(raw.pending), paid: String(raw.paid) }, policy, runtimeKeys,
      ...local, canResume: local.backup.status === "verified" && local.localRotationHold === false && runtimeKeys.some((key) => key.ready) };
  }
}
