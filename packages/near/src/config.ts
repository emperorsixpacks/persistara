import { resolve } from "node:path";
import { ProviderError } from "../../protocol/src/providers.js";
import { hash, validateIdentity, validateNetwork, type NearSignerConfig } from "./protocol.js";

export function nearConfig(env: Record<string, string | undefined>): NearSignerConfig {
  if (!env.NEAR_AUTHORITY_CONTRACT || !env.NEAR_OWNER_ACCOUNT || !env.NEAR_RUNTIME_PUBLIC_KEY || !env.NEAR_AGENT_ID) {
    throw new ProviderError("NOT_CONFIGURED", "Configure the NEAR authority, owner account, runtime public key and agent ID");
  }
  // A key gets one default journal even if someone accidentally configures a
  // different agent/contract; the journal's binding then rejects that reuse.
  const scope = hash(`testnet:${env.NEAR_OWNER_ACCOUNT}:${env.NEAR_RUNTIME_PUBLIC_KEY}`).slice(0, 24);
  const config: NearSignerConfig = { kind: "testnet", chainId: "testnet", rpcUrl: env.NEAR_RPC_URL || "https://rpc.testnet.near.org",
    contractId: env.NEAR_AUTHORITY_CONTRACT, signerId: env.NEAR_OWNER_ACCOUNT, publicKey: env.NEAR_RUNTIME_PUBLIC_KEY, agentId: env.NEAR_AGENT_ID,
    journalFile: resolve(env.NEAR_JOURNAL_FILE || `.persistara/near/${scope}/authority.sqlite`), runtimeKeyFile: resolve(env.NEAR_RUNTIME_KEY_FILE || ".persistara/keys/near-runtime.key") };
  validateNetwork(config); validateIdentity(config);
  return config;
}
