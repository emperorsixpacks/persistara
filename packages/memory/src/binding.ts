import { sha256 } from "../../crypto/src/envelope.js";
import { isIdentifier, isObject, MemoryError, type BlobRef } from "../../protocol/src/memory.js";

export interface MemoryBinding {
  agentId: string;
  authorityNetwork: "near:testnet" | "near:sandbox" | "fixture:local";
  chainId: string;
  contractId: string;
  storageNetwork: "local" | "0g:16602:turbo" | "0g:16602:standard";
}
export function assertBinding(value: unknown): asserts value is MemoryBinding {
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "agentId,authorityNetwork,chainId,contractId,storageNetwork" || !isIdentifier(value.agentId) ||
      !["near:testnet", "near:sandbox", "fixture:local"].includes(String(value.authorityNetwork)) || typeof value.chainId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.chainId) ||
      typeof value.contractId !== "string" || value.contractId.length < 2 || value.contractId.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value.contractId) ||
      !["local", "0g:16602:turbo", "0g:16602:standard"].includes(String(value.storageNetwork)) ||
      (value.authorityNetwork === "near:testnet" && (value.chainId !== "testnet" || value.storageNetwork === "local")) ||
      (value.authorityNetwork === "near:sandbox" && ["mainnet", "testnet"].includes(String(value.chainId))) ||
      (value.authorityNetwork === "fixture:local" && (value.chainId !== "fixture" || value.storageNetwork !== "local"))) {
    throw new MemoryError("INVALID_INPUT", "Invalid memory network/agent binding");
  }
}
export function bindingText(binding: MemoryBinding): string {
  assertBinding(binding);
  return JSON.stringify(["persistara-memory-binding", 1, binding.authorityNetwork, binding.chainId, binding.contractId, binding.agentId, binding.storageNetwork]);
}
export function bindingDigest(binding: MemoryBinding): string { return sha256(Buffer.from(bindingText(binding))); }
export function assertBoundBlob(binding: MemoryBinding, ref: BlobRef): void {
  if (ref.network !== binding.storageNetwork || ref.provider !== (binding.storageNetwork === "local" ? "local" : "0g")) {
    throw new MemoryError("INTEGRITY_FAILED", "Memory reference belongs to another storage network");
  }
}
