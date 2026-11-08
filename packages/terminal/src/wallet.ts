import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { baseDecode } from "near-api-js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import type { OwnerChallenge, PauseRequest } from "../../owner/src/types.js";
import { transactionHash } from "../../near/src/protocol.js";

export interface OwnerProof { challengeId: string; accountId: string; publicKey: string; signature: string }
export interface TerminalWallet { signMessage(challenge: OwnerChallenge): Promise<OwnerProof>; send(request: PauseRequest): Promise<string> }
export type WalletRunner = (binary: string, args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
const runner: WalletRunner = (binary, args, signal) => promisify(execFile)(binary, args, { timeout: 120_000, maxBuffer: 200_000, ...(signal ? { signal } : {}) });
function clean(output: { stdout: string; stderr: string }) { return `${output.stdout}\n${output.stderr}`.replace(/\u001b\[[0-9;]*m/g, ""); }
function jsonObjects(raw: string) {
  const values: Record<string, unknown>[] = []; let attempts = 0;
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) for (let end = raw.indexOf("}", start); end !== -1; end = raw.indexOf("}", end + 1)) {
    if (++attempts > 4096 || values.length >= 64) return values;
    try { const value: unknown = JSON.parse(raw.slice(start, end + 1)); if (isObject(value)) { values.push(value); break; } } catch {}
  }
  return values;
}
/** External official CLI keychain only. No wallet private-key file or arbitrary method input. */
export class NearCliWallet implements TerminalWallet {
  constructor(private readonly binary = "near", private readonly execute: WalletRunner = runner, private readonly signal?: AbortSignal) {}
  async signMessage(challenge: OwnerChallenge): Promise<OwnerProof> {
    let output;
    try { output = await this.execute(this.binary, ["message", "sign-nep413", "base64", Buffer.from(challenge.message).toString("base64"), "nonce", Buffer.from(challenge.nonce, "base64url").toString("base64"), "recipient", challenge.recipient, "sign-as", challenge.signerId, "sign-with-keychain", "network-config", "testnet"], this.signal); }
    catch { throw new ProviderError("AUTHORIZATION_FAILED", "The external NEAR CLI did not return an owner message signature"); }
    const signed = jsonObjects(clean(output)).find(v => (v.accountId ?? v.account_id) === challenge.signerId && typeof v.signature === "string");
    if (!signed || (signed.publicKey ?? signed.public_key) !== challenge.publicKey || typeof signed.signature !== "string") throw new ProviderError("AUTHORIZATION_FAILED", "The external wallet signed with another key or unsupported format");
    let signature: string;
    try { signature = signed.signature.startsWith("ed25519:") ? Buffer.from(baseDecode(signed.signature.slice(8))).toString("base64") : signed.signature; }
    catch { throw new ProviderError("AUTHORIZATION_FAILED", "The external wallet signature is malformed"); }
    return { challengeId: challenge.id, accountId: challenge.signerId, publicKey: challenge.publicKey, signature };
  }
  async send(request: PauseRequest): Promise<string> {
    if (request.network.kind !== "testnet" || request.network.chainId !== "testnet" || request.actions.length !== 1 || request.actions[0].params.methodName !== "set_paused" || request.actions[0].params.deposit !== "0" || request.actions[0].params.gas !== "100000000000000") throw new ProviderError("INVALID_INPUT", "Unsupported terminal owner-wallet request");
    let output;
    try { output = await this.execute(this.binary, ["contract", "call-function", "as-transaction", request.receiverId, "set_paused", "json-args", JSON.stringify(request.actions[0].params.args), "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR", "sign-as", request.signerId, "network-config", "testnet", "sign-with-keychain", "--signer-public-key", request.ownerPublicKey, "send"], this.signal); }
    catch { throw new ProviderError("OUTCOME_UNKNOWN", "The wallet outcome is unknown; reconcile the existing owner request without resending"); }
    const raw = clean(output), candidates = new Set<string>();
    for (const value of jsonObjects(raw)) if (isObject(value.transaction) && transactionHash(value.transaction.hash)) candidates.add(value.transaction.hash);
    for (const match of raw.matchAll(/(?:Transaction\s+(?:ID|Id|id|hash):\s*|testnet\.nearblocks\.io\/txns\/)([1-9A-HJ-NP-Za-km-z]{32,44})\b/g)) candidates.add(match[1]!);
    if (candidates.size !== 1) throw new ProviderError("OUTCOME_UNKNOWN", "No unambiguous transaction hash was returned; reconcile from external wallet activity");
    return [...candidates][0]!;
  }
}
