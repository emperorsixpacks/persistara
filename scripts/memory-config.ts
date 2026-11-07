import { assertBinding, type MemoryBinding } from "../packages/memory/src/binding.js";
import { storageConfig } from "../packages/protocol/src/config.js";
import { ProviderError } from "../packages/protocol/src/providers.js";

export function publicMemoryBinding(): MemoryBinding {
  if (!process.env.NEAR_AGENT_ID || !process.env.NEAR_AUTHORITY_CONTRACT) throw new ProviderError("NOT_CONFIGURED", "Configure the public NEAR agent and authority contract first");
  const storage = storageConfig(process.env);
  const binding: MemoryBinding = { agentId: process.env.NEAR_AGENT_ID, authorityNetwork: "near:testnet", chainId: "testnet", contractId: process.env.NEAR_AUTHORITY_CONTRACT,
    storageNetwork: `0g:16602:${storage.mode}` };
  assertBinding(binding); return binding;
}
