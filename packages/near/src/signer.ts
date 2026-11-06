import { KeyPairSigner, PublicKey, actions, baseDecode, baseEncode, createTransaction } from "near-api-js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { NearJournal, type Operation } from "./journal.js";
import { NearRpc } from "./rpc.js";
import { GAS, RUNTIME_METHODS, canonical, decimal, decodeJsonBase64, operationId, validateCall, validateIdentity,
  type ContractCall, type NearOutcome, type NearSignerConfig } from "./protocol.js";

/** Trusted signer process only. No Account.sendTransaction, SDK retries, or full-access keys. */
export class DurableNearSigner {
  private readonly config: NearSignerConfig;
  constructor(config: NearSignerConfig, private readonly rpc: NearRpc, private readonly journal: NearJournal, private readonly key?: KeyPairSigner,
    private readonly onPrepared?: (transactionHash: string) => void) {
    validateIdentity(config);
    if (rpc.config.kind !== config.kind || rpc.config.chainId !== config.chainId || rpc.config.contractId !== config.contractId) throw new ProviderError("NETWORK_MISMATCH", "Signer and RPC bindings differ");
    this.config = structuredClone(config);
  }
  private async access(method: string): Promise<{ nonce: string; blockHash: string }> {
    await this.rpc.assertNetwork();
    if (!this.key || (await this.key.getPublicKey()).toString() !== this.config.publicKey) throw new ProviderError("AUTHORIZATION_FAILED", "Runtime key does not match the configured public key");
    const value = await this.rpc.request("query", { request_type: "view_access_key", finality: "final", account_id: this.config.signerId, public_key: this.config.publicKey });
    if (!isObject(value) || !Number.isSafeInteger(value.nonce) || Number(value.nonce) < 0 || typeof value.block_hash !== "string" || baseDecode(value.block_hash).length !== 32 ||
        !isObject(value.permission) || !isObject(value.permission.FunctionCall)) throw new ProviderError("AUTHORIZATION_FAILED", "A restricted NEAR function-call key is required");
    const permission = value.permission.FunctionCall;
    if (permission.receiver_id !== this.config.contractId || !Array.isArray(permission.method_names) || !permission.method_names.includes(method) ||
        permission.method_names.length === 0 || permission.method_names.some((m: unknown) => !RUNTIME_METHODS.includes(m as typeof RUNTIME_METHODS[number])) ||
        !decimal(permission.allowance, 128, true)) throw new ProviderError("AUTHORIZATION_FAILED", "Runtime access key has excessive scope, no gas allowance, or the wrong receiver");
    const agent = await this.rpc.view("get_agent", { agent_id: this.config.agentId });
    if (!isObject(agent) || agent.id !== this.config.agentId || agent.owner !== this.config.signerId || agent.ownerKey === this.config.publicKey) {
      throw new ProviderError("AUTHORIZATION_FAILED", "Runtime key must be separate from the registered owner key");
    }
    const block = await this.rpc.request("block", { block_id: value.block_hash });
    const delegate = Array.isArray(agent.delegates) ? agent.delegates.find((d: unknown) => isObject(d) && d.publicKey === this.config.publicKey) as unknown : undefined;
    if (!isObject(block) || !isObject(block.header) || !decimal(block.header.timestamp_nanosec) || !isObject(delegate) || !decimal(delegate.expiresAtNs, 64, true) ||
        BigInt(delegate.expiresAtNs) <= BigInt(block.header.timestamp_nanosec) || agent.paused !== false ||
        (method === "checkpoint_memory" ? delegate.canCheckpoint !== true : delegate.canSpend !== true)) {
      throw new ProviderError("AUTHORIZATION_FAILED", "Agent is paused, or its runtime grant is missing, expired, or insufficient");
    }
    return { nonce: String(value.nonce), blockHash: value.block_hash };
  }
  async submit(id: string, call: ContractCall): Promise<NearOutcome> {
    if (!operationId(id)) throw new ProviderError("INVALID_INPUT", "Invalid NEAR operation ID");
    // Capture the exact caller payload before the first asynchronous boundary.
    validateCall(call, this.config);
    const snapshot = JSON.parse(canonical(call)) as ContractCall;
    let row = this.journal.get(id);
    if (row) {
      this.journal.assertPayload(row, snapshot);
      if (row.state !== "allocated" && row.state !== "prepared") return this.reconcile(id);
    }
    const access = await this.access(snapshot.method);
    row ??= this.journal.allocate(id, snapshot, access.nonce, access.blockHash);
    if (row.state === "allocated") {
      const tx = createTransaction(this.config.signerId, PublicKey.fromString(this.config.publicKey), this.config.contractId, BigInt(row.nonce),
        [actions.functionCall(snapshot.method, Buffer.from(canonical(snapshot.args)), BigInt(GAS), 0n)], baseDecode(row.block_hash));
      const signed = await this.key!.signTransaction(tx);
      row = this.journal.prepared(id, Buffer.from(signed.signedTransaction.encode()).toString("base64"), baseEncode(signed.txHash));
    }
    this.onPrepared?.(row.tx_hash!);
    if (!this.journal.submitted(id)) return this.reconcile(id);
    // submitted is durable BEFORE handing bytes to the network. Any interruption is unknown.
    try {
      const response = await this.rpc.request("send_tx", { signed_tx_base64: row.signed, wait_until: "FINAL" });
      return this.journal.saveOutcome(id, this.decodeOutcome(row, response));
    } catch {
      return this.recordUnknown(row);
    }
  }
  async reconcile(id: string): Promise<NearOutcome> {
    const row = this.journal.get(id);
    if (!row) throw new ProviderError("INVALID_INPUT", "NEAR operation is not in the journal");
    if (row.outcome_json && (row.state === "confirmed" || row.state === "failed")) return JSON.parse(row.outcome_json) as NearOutcome;
    if (!row.tx_hash) throw new ProviderError("NOT_CONFIGURED", "Operation was interrupted before signing; submit the identical request to resume");
    if (row.state === "prepared") return { status: "unknown", transactionHash: row.tx_hash };
    try {
      await this.rpc.assertNetwork();
      const value = await this.rpc.request("tx", { tx_hash: row.tx_hash, sender_account_id: this.config.signerId, wait_until: "FINAL" });
      return this.journal.saveOutcome(id, this.decodeOutcome(row, value));
    } catch {
      return this.recordUnknown(row);
    }
  }
  private recordUnknown(row: Operation): NearOutcome {
    try { return this.journal.saveOutcome(row.id, { status: "unknown", transactionHash: row.tx_hash! }); }
    catch { throw new ProviderError("OUTCOME_UNKNOWN", "Transaction may have executed; journal update failed", false, row.tx_hash!); }
  }
  private decodeOutcome(row: Operation, response: unknown): NearOutcome {
    const unknown: NearOutcome = { status: "unknown", transactionHash: row.tx_hash! };
    if (!isObject(response) || response.final_execution_status !== "FINAL" || !isObject(response.transaction) || !isObject(response.status)) return unknown;
    const tx = response.transaction;
    const call = JSON.parse(row.call_json) as ContractCall;
    if (tx.hash !== row.tx_hash || tx.signer_id !== this.config.signerId || tx.public_key !== this.config.publicKey || tx.receiver_id !== this.config.contractId ||
        !Number.isSafeInteger(tx.nonce) || String(tx.nonce) !== row.nonce || !Array.isArray(tx.actions) || tx.actions.length !== 1 ||
        !isObject(tx.actions[0]) || !isObject(tx.actions[0].FunctionCall)) return unknown;
    const action = tx.actions[0].FunctionCall;
    if (action.method_name !== call.method || action.deposit !== "0" || String(action.gas) !== GAS || action.args !== Buffer.from(canonical(call.args)).toString("base64")) return unknown;
    if (Object.hasOwn(response.status, "SuccessValue") && !Object.hasOwn(response.status, "Failure")) {
      return { status: "confirmed", transactionHash: row.tx_hash!, result: decodeJsonBase64(response.status.SuccessValue) };
    }
    if (Object.hasOwn(response.status, "Failure") && !Object.hasOwn(response.status, "SuccessValue")) {
      const message = JSON.stringify(response.status.Failure);
      const code = /\bERR_[A-Z0-9_]{1,80}\b/.exec(message)?.[0] ?? "NEAR_EXECUTION_FAILED";
      return { status: "failed", transactionHash: row.tx_hash!, failureCode: code };
    }
    return unknown;
  }
}
