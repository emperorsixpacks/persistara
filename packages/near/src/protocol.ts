import { createHash } from "node:crypto";
import { isObject, type BlobRef, type MemoryHead } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";

export const RUNTIME_METHODS = ["checkpoint_memory", "create_job", "accept_job"] as const;
export type RuntimeMethod = typeof RUNTIME_METHODS[number];
export interface NearNetwork { kind: "testnet" | "sandbox"; chainId: string; rpcUrl: string; contractId: string }
/**
 * `signerId` is the owner account. The runtime key normally lives on the owner account; when `runtimeAccountId` is set it must be the
 * agent ID itself (the agent's own `name.owner` account), and the runtime key is a restricted function-call key on that account.
 */
export interface RuntimeIdentity { signerId: string; publicKey: string; agentId: string; runtimeAccountId?: string }
/** The account that holds the restricted runtime key and signs runtime transactions. */
export const runtimeAccountOf = (identity: { signerId: string; runtimeAccountId?: string }): string => identity.runtimeAccountId ?? identity.signerId;
export interface NearSignerConfig extends NearNetwork, RuntimeIdentity { journalFile: string; runtimeKeyFile: string }
export interface ContractCall { method: RuntimeMethod; args: Record<string, unknown> }
export type NearOutcome =
  | { status: "confirmed"; transactionHash: string; result: unknown }
  | { status: "failed"; transactionHash: string; failureCode: string }
  | { status: "unknown"; transactionHash: string };
export interface NearSigner {
  submit(operationId: string, call: ContractCall, options?: { journalIdentity?: string }): Promise<NearOutcome>;
  reconcile(operationId: string, options?: { journalIdentity?: string }): Promise<NearOutcome>;
  journalIdentity?(create: boolean): Promise<string>;
}
export const GAS = "100000000000000";
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
export function failInput(): never { throw new ProviderError("INVALID_INPUT", "Invalid NEAR configuration or contract arguments"); }
export function accountId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}
export function decimal(value: unknown, bits: 64 | 128 = 64, positive = false): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,38})$/.test(value) &&
    BigInt(value) <= (bits === 64 ? U64_MAX : U128_MAX) && (!positive || BigInt(value) > 0n);
}
export function operationId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value); }
export function transactionHash(value: unknown): value is string { return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value); }
export function publicKey(value: unknown): value is string { return typeof value === "string" && /^(?:ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}|secp256k1:[1-9A-HJ-NP-Za-km-z]{64,88})$/.test(value); }
export function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

/** Bounded canonical JSON is also the immutable request stored in the journal. */
export function canonical(value: unknown): string {
  function normalize(item: unknown, depth: number): unknown {
    if (depth > 16) failInput();
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map((v) => normalize(v, depth + 1));
    if (isObject(item) && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key], depth + 1)]));
    }
    return failInput();
  }
  const text = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(text) > 32_768) failInput();
  return text;
}
function fields(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) failInput();
}
export function validateNetwork(config: NearNetwork): void {
  if (!accountId(config.contractId) || !["testnet", "sandbox"].includes(config.kind) || typeof config.chainId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(config.chainId)) failInput();
  let url: URL;
  try { url = new URL(config.rpcUrl); } catch { return failInput(); }
  if (url.username || url.password || url.search || url.hash) failInput();
  if (config.kind === "testnet") {
    if (config.chainId !== "testnet" || url.protocol !== "https:") failInput();
  } else if (config.chainId === "mainnet" || config.chainId === "testnet" || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) failInput();
}
/** One lowercase NEAR segment, exactly the contract's rule: 2-32 chars, a-z0-9 with single `-`/`_` between alphanumerics, no dots. */
export const subaccountAgentName = (name: string) => name.length >= 2 && name.length <= 32 && /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(name);
/** Accepts the current `name.owner` agent ID and the legacy `owner:name` ID of the original testnet deployment; exactly one per deployment. */
export function agentIdMatchesSigner(agentId: unknown, signerId: string): boolean {
  if (typeof agentId !== "string") return false;
  if (agentId.startsWith(`${signerId}:`)) return /^[A-Za-z0-9_-]{1,32}$/.test(agentId.slice(signerId.length + 1));
  return agentId.endsWith(`.${signerId}`) && agentId.length <= 64 && subaccountAgentName(agentId.slice(0, agentId.length - signerId.length - 1));
}
export function validateIdentity(identity: RuntimeIdentity): void {
  if (!accountId(identity.signerId) || !publicKey(identity.publicKey) || !identity.publicKey.startsWith("ed25519:") || !agentIdMatchesSigner(identity.agentId, identity.signerId) ||
      (identity.runtimeAccountId !== undefined && (identity.runtimeAccountId !== identity.agentId || !accountId(identity.agentId) || identity.agentId.startsWith(`${identity.signerId}:`)))) failInput();
}
export function runtimePermission(permission: unknown, contractId: string, method: RuntimeMethod): boolean {
  if (!isObject(permission) || !isObject(permission.FunctionCall)) return false;
  const call = permission.FunctionCall;
  return call.receiver_id === contractId && Array.isArray(call.method_names) && call.method_names.length > 0 && call.method_names.includes(method) &&
    call.method_names.every((m: unknown) => RUNTIME_METHODS.includes(m as RuntimeMethod)) && decimal(call.allowance, 128, true);
}
export function validateBlob(value: unknown): asserts value is BlobRef {
  if (!isObject(value)) failInput();
  fields(value, ["provider", "network", "objectId", "ciphertextSha256", "byteLength"]);
  if (value.provider !== "0g" || !["0g:16602:turbo", "0g:16602:standard"].includes(String(value.network)) ||
      typeof value.objectId !== "string" || !/^0x[a-f0-9]{64}$/.test(value.objectId) || typeof value.ciphertextSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.ciphertextSha256) ||
      !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1 || Number(value.byteLength) > 1_500_000) failInput();
}
export function encodeHead(head: MemoryHead): Record<string, unknown> {
  if (!Number.isSafeInteger(head.version) || head.version < 1 || !Number.isSafeInteger(head.keyEpoch) || head.keyEpoch < 1) failInput();
  validateBlob(head.manifest);
  return { version: String(head.version), keyEpoch: String(head.keyEpoch), manifest: structuredClone(head.manifest) };
}
export function decodeHead(value: unknown): MemoryHead | null {
  if (value === null) return null;
  if (!isObject(value) || !decimal(value.version, 64, true) || !decimal(value.keyEpoch, 64, true) || BigInt(value.version) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(value.keyEpoch) > BigInt(Number.MAX_SAFE_INTEGER)) failInput();
  fields(value, ["version", "keyEpoch", "manifest"]);
  validateBlob(value.manifest);
  return { version: Number(value.version), keyEpoch: Number(value.keyEpoch), manifest: structuredClone(value.manifest) };
}
export function validateCall(call: ContractCall, identity: RuntimeIdentity): void {
  if (!isObject(call) || !RUNTIME_METHODS.includes(call.method) || !isObject(call.args)) failInput();
  fields(call as unknown as Record<string, unknown>, ["method", "args"]);
  canonical(call);
  const a = call.args;
  if (call.method === "create_job") {
    fields(a, ["request"]);
    const r = a.request;
    if (!isObject(r)) failInput();
    fields(r, ["agentId", "generation", "policyVersion", "operationId", "worker", "amount", "criteriaHash", "brief", "quoteExpiresAtNs", "deliveryDeadlineNs", "reviewWindowNs"]);
    if (r.agentId !== identity.agentId || !decimal(r.generation, 64, true) || !decimal(r.policyVersion, 64, true) || !operationId(r.operationId) || r.operationId.length > 64 ||
        !accountId(r.worker) || !decimal(r.amount, 128, true) || typeof r.criteriaHash !== "string" || !/^[a-f0-9]{64}$/.test(r.criteriaHash) ||
        !decimal(r.quoteExpiresAtNs, 64, true) || !decimal(r.deliveryDeadlineNs, 64, true) || !decimal(r.reviewWindowNs, 64, true)) failInput();
    validateBlob(r.brief);
  } else {
    if (a.agent_id !== identity.agentId || !decimal(a.generation, 64, true)) failInput();
    if (call.method === "checkpoint_memory") {
      fields(a, ["agent_id", "generation", "expected_version", "next"]);
      if (!decimal(a.expected_version) || !isObject(a.next) || !decimal(a.next.version, 64, true) || BigInt(a.next.version) !== BigInt(a.expected_version) + 1n) failInput();
      decodeHead(a.next);
    } else {
      fields(a, ["agent_id", "operation_id", "generation", "expected_result_digest"]);
      if (!operationId(a.operation_id) || a.operation_id.length > 64 || typeof a.expected_result_digest !== "string" || !/^[a-f0-9]{64}$/.test(a.expected_result_digest)) failInput();
    }
  }
}

export function decodeJsonBase64(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 200_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ProviderError("PROTOCOL_ERROR", "Invalid NEAR return encoding");
  const bytes = Buffer.from(value, "base64");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ProviderError("PROTOCOL_ERROR", "Invalid NEAR JSON return value"); }
}
