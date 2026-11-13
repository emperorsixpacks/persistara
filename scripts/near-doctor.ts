import { isObject } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { NearAuthorityReader } from "../packages/near/src/client.js";
import { nearConfig } from "../packages/near/src/config.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { decimal, RUNTIME_METHODS, runtimeAccountOf } from "../packages/near/src/protocol.js";
import { loadEnvironment, printFailure } from "./common.js";

async function main(): Promise<void> {
  loadEnvironment();
  const config = nearConfig(process.env);
  const rpc = new NearRpc(config);
  const reader = new NearAuthorityReader(rpc);
  const agent = await reader.agent(config.agentId);
  const key = await rpc.request("query", { request_type: "view_access_key", finality: "final", account_id: runtimeAccountOf(config), public_key: config.publicKey });
  if (agent.owner !== config.signerId || agent.ownerKey === config.publicKey || !isObject(key) || !isObject(key.permission) || !isObject(key.permission.FunctionCall)) {
    throw new ProviderError("AUTHORIZATION_FAILED", "Expected a distinct runtime function-call key for this owner");
  }
  const permission = key.permission.FunctionCall;
  if (permission.receiver_id !== config.contractId || !Array.isArray(permission.method_names) || permission.method_names.length === 0 ||
      permission.method_names.some((method: unknown) => !RUNTIME_METHODS.includes(method as typeof RUNTIME_METHODS[number])) || !decimal(permission.allowance, 128, true)) {
    throw new ProviderError("AUTHORIZATION_FAILED", "Runtime access key has the wrong receiver, excessive methods or no bounded gas allowance");
  }
  const raw = await rpc.view("get_agent", { agent_id: config.agentId });
  const grant = isObject(raw) && Array.isArray(raw.delegates) ? raw.delegates.find((d: unknown) => isObject(d) && d.publicKey === config.publicKey) as unknown : undefined;
  if (!isObject(grant) || !decimal(grant.expiresAtNs, 64, true)) throw new ProviderError("AUTHORIZATION_FAILED", "Runtime key has no recorded agent grant");
  console.log(JSON.stringify({ status: "ready-for-review", network: "near:testnet", contractId: config.contractId, agentId: config.agentId,
    generation: agent.generation, keyEpoch: agent.keyEpoch, checkpointVersion: agent.head?.version ?? 0, paused: agent.paused,
    methods: permission.method_names, delegateExpiresAtNs: grant.expiresAtNs, balances: agent.balances,
    evidence: "read-only-finalized-state; no transaction submitted" }, null, 2));
}
main().catch(printFailure);
