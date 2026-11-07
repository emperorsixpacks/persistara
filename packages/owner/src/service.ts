import { randomUUID } from "node:crypto";
import { canonical, decimal, decodeJsonBase64, type NearSignerConfig } from "../../near/src/protocol.js";
import type { NearRpc } from "../../near/src/rpc.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { OwnerJournal } from "./journal.js";
import type { OwnerOperation, OwnerView, PauseRequest } from "./types.js";

export class OwnerService {
  constructor(readonly config: NearSignerConfig, readonly journal: OwnerJournal, readonly read: () => Promise<OwnerView>, private readonly rpc: Pick<NearRpc, "request" | "assertNetwork">) {}
  private owner(view: OwnerView) {
    if (view.owner !== this.config.signerId || view.agentId !== this.config.agentId || !view.ownerKeyFullAccess || view.ownerKey === this.config.publicKey) throw new ProviderError("AUTHORIZATION_FAILED", "Registered owner key is not available with full access");
  }
  async prepare(paused: boolean, authorize?: (view: OwnerView) => void): Promise<{ operation: OwnerOperation | null; view: OwnerView }> {
    if (typeof paused !== "boolean") throw new ProviderError("INVALID_INPUT", "Choose an explicit pause state");
    const view = await this.read(); this.owner(view); authorize?.(view);
    const pending = this.journal.pending();
    if (pending && pending.state !== "prepared") throw new ProviderError("OUTCOME_UNKNOWN", "Reconcile the existing wallet handoff before another owner action");
    if (view.paused === paused && !pending) return { operation: null, view };
    if (!paused && !view.canResume) throw new ProviderError("AUTHORIZATION_FAILED", "Resume requires a verified current backup, ready restricted runtime and no local rotation hold");
    const request: PauseRequest = { schemaVersion: 1, id: `wallet:${randomUUID()}`, kind: "OWNER_PAUSE_REQUEST", network: { kind: this.config.kind, chainId: this.config.chainId },
      signerId: view.owner, ownerPublicKey: view.ownerKey, agentId: view.agentId, receiverId: view.contractId, expectedGeneration: view.generation, minimumNonce: view.ownerNonce, paused,
      actions: [{ type: "FunctionCall", params: { methodName: "set_paused", args: { agent_id: view.agentId, paused }, gas: "100000000000000", deposit: "0" } }] };
    return { operation: this.journal.prepare(request), view };
  }
  async dispatch(id: string, digest: string, authorize?: (view: OwnerView) => void): Promise<OwnerOperation> {
    const row = this.journal.get(id);
    if (row.digest !== digest) throw new ProviderError("INTEGRITY_FAILED", "Reviewed request digest differs");
    const view = await this.read(); this.owner(view); authorize?.(view);
    if (view.ownerKey !== row.request.ownerPublicKey || view.generation !== row.request.expectedGeneration || view.ownerNonce !== row.request.minimumNonce || view.paused === row.request.paused || (!row.request.paused && !view.canResume)) {
      throw new ProviderError("OPERATION_CONFLICT", "Owner state changed since review; cancel the unsubmitted request and review again");
    }
    return this.journal.dispatch(id);
  }
  async reconcile(id: string, candidate?: string): Promise<OwnerOperation> {
    let row = this.journal.get(id);
    if (["prepared", "canceled", "confirmed", "failed"].includes(row.state)) return row;
    const txHash = candidate ?? row.transactionHash ?? row.candidateHashes.at(-1);
    if (!txHash) return row;
    this.journal.observe(id, txHash);
    let response: unknown;
    try { await this.rpc.assertNetwork(); response = await this.rpc.request("tx", { tx_hash: txHash, sender_account_id: row.request.signerId, wait_until: "FINAL" }); }
    catch { return this.journal.get(id); }
    if (!isObject(response) || !isObject(response.transaction)) return this.journal.get(id);
    const tx = response.transaction;
    const request = row.request;
    if (tx.hash !== txHash || tx.signer_id !== request.signerId || tx.public_key !== request.ownerPublicKey || tx.receiver_id !== request.receiverId ||
        !Number.isSafeInteger(tx.nonce) || Number(tx.nonce) <= request.minimumNonce || !Array.isArray(tx.actions) || tx.actions.length !== 1 || !isObject(tx.actions[0]) || !isObject(tx.actions[0].FunctionCall)) throw new ProviderError("INTEGRITY_FAILED", "Wallet transaction differs from the reviewed owner request");
    const action = tx.actions[0].FunctionCall;
    const expected = request.actions[0].params;
    if (action.method_name !== expected.methodName || String(action.gas) !== expected.gas || action.deposit !== "0" || canonical(decodeJsonBase64(action.args)) !== canonical(expected.args)) throw new ProviderError("INTEGRITY_FAILED", "Wallet transaction changed its action, arguments, gas or deposit");
    // Only a matching public transaction can bind the canonical hash; a typo cannot replace it.
    row = this.journal.finish(id, txHash, "unknown");
    if (response.final_execution_status !== "FINAL" || !isObject(response.status)) return row;
    if (Object.hasOwn(response.status, "SuccessValue") && !Object.hasOwn(response.status, "Failure")) {
      const result = decodeJsonBase64(response.status.SuccessValue);
      if (!isObject(result) || result.id !== request.agentId || result.owner !== request.signerId || result.ownerKey !== request.ownerPublicKey || result.paused !== request.paused || !decimal(result.generation, 64, true) || BigInt(result.generation) <= BigInt(request.expectedGeneration)) throw new ProviderError("INTEGRITY_FAILED", "Finalized owner result does not match the requested state");
      return this.journal.finish(id, txHash, "confirmed");
    }
    if (Object.hasOwn(response.status, "Failure") && !Object.hasOwn(response.status, "SuccessValue")) return this.journal.finish(id, txHash, "failed", "NEAR_EXECUTION_FAILED");
    return row;
  }
}
