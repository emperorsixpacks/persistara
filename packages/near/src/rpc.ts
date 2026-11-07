import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { validateNetwork, type NearNetwork } from "./protocol.js";

export type RpcTransport = (method: string, params: unknown) => Promise<unknown>;
export class NearRpc {
  readonly config: NearNetwork;
  constructor(config: NearNetwork, private readonly transport?: RpcTransport) {
    validateNetwork(config);
    this.config = Object.freeze(structuredClone(config));
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.transport) return this.transport(method, structuredClone(params));
    try {
      const response = await fetch(this.config.rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "persistara", method, params }), redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new ProviderError("UPSTREAM_ERROR", "NEAR RPC request failed");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1_000_000) throw new ProviderError("PROTOCOL_ERROR", "NEAR response exceeds the byte limit");
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (!isObject(value) || value.jsonrpc !== "2.0" || value.id !== "persistara" || Object.hasOwn(value, "error") || !Object.hasOwn(value, "result")) {
        throw new ProviderError("UPSTREAM_ERROR", "NEAR RPC returned an error or malformed envelope");
      }
      return value.result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("UPSTREAM_ERROR", "NEAR RPC request did not complete");
    }
  }
  async assertNetwork(): Promise<void> {
    const status = await this.request("status", {});
    if (!isObject(status) || status.chain_id !== this.config.chainId || !isObject(status.sync_info) || status.sync_info.syncing !== false) {
      throw new ProviderError("NETWORK_MISMATCH", "NEAR RPC is on another chain or is still syncing");
    }
  }
  async view(method: "get_agent" | "get_memory_head" | "get_job" | "get_withdrawal" | "get_runtime_rotation", args: Record<string, string>, blockId?: string): Promise<unknown> {
    await this.assertNetwork();
    const value = await this.request("query", { request_type: "call_function", ...(blockId ? { block_id: blockId } : { finality: "final" }), account_id: this.config.contractId,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    if (!isObject(value) || (blockId !== undefined && value.block_hash !== blockId) || !Array.isArray(value.result) || value.result.length > 150_000 || value.result.some((n: unknown) => !Number.isInteger(n) || Number(n) < 0 || Number(n) > 255)) {
      throw new ProviderError("PROTOCOL_ERROR", "Invalid finalized NEAR view");
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value.result as number[]))) as unknown; }
    catch { throw new ProviderError("PROTOCOL_ERROR", "Invalid NEAR view JSON"); }
  }
}
