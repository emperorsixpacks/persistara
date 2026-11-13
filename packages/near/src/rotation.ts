import { isObject, type MemoryHead } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { accountId, canonical, decimal, decodeHead, publicKey, validateIdentity, type NearNetwork, type RuntimeIdentity } from "./protocol.js";
import { NearRpc } from "./rpc.js";

export interface RotationDelegate { publicKey: string; expiresAtNs: string; canCheckpoint: boolean; canSpend: boolean }
export interface RotationRequest {
  agentId: string; operationId: string; expectedGeneration: string; expectedEpoch: string; expectedVersion: string;
  oldPublicKey: string; replacement: RotationDelegate; recoveryCommitment: string; resume: boolean;
}
export interface RotationRecord { request: RotationRequest; nextEpoch: string; beginGeneration: string; completed: boolean }
export interface AccountAccessKey { publicKey: string; nonce: number; permission: unknown }
export interface RotationSnapshot {
  agentId: string; chainId: string; contractId: string; blockHash: string; timestampNs: string; owner: string; ownerKey: string; paused: boolean; generation: string; keyEpoch: number;
  head: MemoryHead | null; delegates: RotationDelegate[]; accessKeys: AccountAccessKey[]; rotation: RotationRecord | null;
}
export interface OwnerWalletRequest {
  schemaVersion: 1; id: string; kind: "OWNER_WALLET_REQUEST"; network: { kind: NearNetwork["kind"]; chainId: string };
  signerId: string; ownerPublicKey: string; receiverId: string;
  actions: ({ type: "FunctionCall"; params: { methodName: "begin_runtime_rotation" | "finish_runtime_rotation"; args: Record<string, unknown>; gas: string; deposit: "0" } } |
    { type: "DeleteKey"; params: { publicKey: string } } |
    { type: "AddKey"; params: { publicKey: string; accessKey: { nonce: 0; permission: { receiverId: string; methodNames: string[]; allowance: string } } } })[];
}
function invalid(): never { throw new ProviderError("PROTOCOL_ERROR", "Invalid finalized rotation state"); }
export function delegate(value: unknown): RotationDelegate {
  if (!isObject(value) || !publicKey(value.publicKey) || !decimal(value.expiresAtNs, 64, true) || typeof value.canCheckpoint !== "boolean" || typeof value.canSpend !== "boolean") return invalid();
  return { publicKey: value.publicKey, expiresAtNs: value.expiresAtNs, canCheckpoint: value.canCheckpoint, canSpend: value.canSpend };
}
export function rotationRecord(value: unknown): RotationRecord | null {
  if (value === null) return null;
  if (!isObject(value) || !isObject(value.request) || !decimal(value.nextEpoch, 64, true) || !decimal(value.beginGeneration, 64, true) || typeof value.completed !== "boolean") return invalid();
  const r = value.request;
  if (typeof r.agentId !== "string" || typeof r.operationId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(r.operationId) || !decimal(r.expectedGeneration, 64, true) ||
      !decimal(r.expectedEpoch, 64, true) || !decimal(r.expectedVersion) || !publicKey(r.oldPublicKey) || typeof r.recoveryCommitment !== "string" || !/^[a-f0-9]{64}$/.test(r.recoveryCommitment) || typeof r.resume !== "boolean") return invalid();
  return { request: { agentId: r.agentId, operationId: r.operationId, expectedGeneration: r.expectedGeneration, expectedEpoch: r.expectedEpoch, expectedVersion: r.expectedVersion,
    oldPublicKey: r.oldPublicKey, replacement: delegate(r.replacement), recoveryCommitment: r.recoveryCommitment, resume: r.resume }, nextEpoch: value.nextEpoch, beginGeneration: value.beginGeneration, completed: value.completed };
}

/** All authority and access-key observations are pinned to the same finalized block. No signing capability. */
export class NearRotationReader {
  readonly identity: RuntimeIdentity;
  constructor(readonly rpc: NearRpc, identity: RuntimeIdentity) { validateIdentity(identity); if (identity.runtimeAccountId) throw new ProviderError("NOT_CONFIGURED", "Runtime key rotation is not supported when the runtime key lives on the agent account yet; the owner can still pause the agent or revoke the delegate"); this.identity = structuredClone(identity); }
  async read(operationId: string): Promise<RotationSnapshot> {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(operationId)) throw new ProviderError("INVALID_INPUT", "Invalid rotation ID");
    await this.rpc.assertNetwork();
    const block = await this.rpc.request("block", { finality: "final" });
    if (!isObject(block) || !isObject(block.header) || typeof block.header.hash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(block.header.hash) || !decimal(block.header.timestamp_nanosec)) return invalid();
    const blockHash = block.header.hash;
    const [agent, rotation, keys] = await Promise.all([
      this.rpc.view("get_agent", { agent_id: this.identity.agentId }, blockHash),
      this.rpc.view("get_runtime_rotation", { agent_id: this.identity.agentId, operation_id: operationId }, blockHash),
      this.rpc.request("query", { request_type: "view_access_key_list", block_id: blockHash, account_id: this.identity.signerId, limit: 129 }),
    ]);
    if (!isObject(agent) || agent.id !== this.identity.agentId || agent.owner !== this.identity.signerId || !accountId(agent.owner) || !publicKey(agent.ownerKey) || typeof agent.paused !== "boolean" || !decimal(agent.generation, 64, true) ||
        !decimal(agent.keyEpoch, 64, true) || BigInt(agent.keyEpoch) > BigInt(Number.MAX_SAFE_INTEGER) || !Array.isArray(agent.delegates) || agent.delegates.length > 8 ||
        !isObject(keys) || keys.block_hash !== blockHash || (keys.last_key !== undefined && keys.last_key !== null) || !Array.isArray(keys.keys) || keys.keys.length > 128) return invalid();
    const accessKeys = keys.keys.map((entry: unknown) => {
      if (!isObject(entry) || !publicKey(entry.public_key) || !isObject(entry.access_key) || !Number.isSafeInteger(entry.access_key.nonce) || Number(entry.access_key.nonce) < 0 ||
          !(entry.access_key.permission === "FullAccess" || (isObject(entry.access_key.permission) && isObject(entry.access_key.permission.FunctionCall)))) return invalid();
      return { publicKey: entry.public_key, nonce: Number(entry.access_key.nonce), permission: structuredClone(entry.access_key.permission) };
    });
    const delegates = agent.delegates.map(delegate);
    if (new Set(accessKeys.map((k) => k.publicKey)).size !== accessKeys.length || new Set(delegates.map((d) => d.publicKey)).size !== delegates.length) return invalid();
    const record = rotationRecord(rotation);
    if (record && (record.request.agentId !== this.identity.agentId || record.request.operationId !== operationId)) return invalid();
    return { agentId: this.identity.agentId, chainId: this.rpc.config.chainId, contractId: this.rpc.config.contractId, blockHash, timestampNs: block.header.timestamp_nanosec, owner: agent.owner, ownerKey: agent.ownerKey, paused: agent.paused, generation: agent.generation, keyEpoch: Number(agent.keyEpoch),
      head: decodeHead(agent.head), delegates, accessKeys, rotation: record };
  }
}

export function replacementMethods(replacement: RotationDelegate): string[] { return ["checkpoint_memory", ...(replacement.canSpend ? ["create_job", "accept_job"] : [])]; }
export function replacementAccess(key: AccountAccessKey, network: NearNetwork, replacement: RotationDelegate, maximum: string, requireFullAllowance: boolean): void {
  if (key.publicKey !== replacement.publicKey || !isObject(key.permission) || !isObject(key.permission.FunctionCall)) throw new ProviderError("AUTHORIZATION_FAILED", "Replacement access key is not the expected restricted key");
  const p = key.permission.FunctionCall;
  if (p.receiver_id !== network.contractId || !Array.isArray(p.method_names) || canonical([...p.method_names].sort()) !== canonical(replacementMethods(replacement).sort()) ||
      !decimal(p.allowance, 128, true) || BigInt(p.allowance) > BigInt(maximum) || (requireFullAllowance && p.allowance !== maximum)) throw new ProviderError("AUTHORIZATION_FAILED", "Replacement key scope or gas allowance differs from the owner plan");
}
