import { assertBinding, type MemoryBinding } from "./binding.js";
import { storageConfig } from "../../protocol/src/config.js";
import { ProviderError } from "../../protocol/src/providers.js";

export function memoryBindingConfig(env: Record<string, string | undefined>): MemoryBinding {
  if (!env.NEAR_AGENT_ID || !env.NEAR_AUTHORITY_CONTRACT) throw new ProviderError("NOT_CONFIGURED", "Configure the public NEAR agent and authority contract first");
  const storage = storageConfig(env);
  const binding: MemoryBinding = { agentId: env.NEAR_AGENT_ID, authorityNetwork: "near:testnet", chainId: "testnet", contractId: env.NEAR_AUTHORITY_CONTRACT, storageNetwork: `0g:16602:${storage.mode}` };
  assertBinding(binding); return binding;
}
