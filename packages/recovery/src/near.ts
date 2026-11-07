import { decimal, decodeHead, publicKey, transactionHash, validateNetwork, type NearNetwork } from "../../near/src/protocol.js";
import { NearRpc } from "../../near/src/rpc.js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import type { MissionScope } from "../../runtime/src/types.js";
import type { RecoveryObservation } from "./kit.js";

/** One finalized block pins contract code, registration owner and memory head. No key or signer input. */
export class RecoveryAuthorityReader {
  readonly rpc: NearRpc;
  constructor(network: NearNetwork, private readonly scope: MissionScope, rpc?: NearRpc) {
    validateNetwork(network);
    if (network.chainId !== scope.chainId || network.contractId !== scope.contractId) throw new ProviderError("INTEGRITY_FAILED", "Recovery reader belongs to another chain or authority");
    this.rpc = rpc ?? new NearRpc(network);
  }
  async observe(): Promise<RecoveryObservation> {
    const rpc = this.rpc; await rpc.assertNetwork();
    const block = await rpc.request("block", { finality: "final" });
    if (!isObject(block) || !isObject(block.header) || !transactionHash(block.header.hash) || !decimal(block.header.timestamp_nanosec, 64, true)) throw new ProviderError("PROTOCOL_ERROR", "Missing finalized recovery block");
    const blockHash = block.header.hash;
    const [account, agent] = await Promise.all([
      rpc.request("query", { request_type: "view_account", block_id: blockHash, account_id: this.scope.contractId }),
      rpc.view("get_agent", { agent_id: this.scope.agentId }, blockHash),
    ]);
    if (!isObject(account) || account.block_hash !== blockHash || account.code_hash !== this.scope.codeHash || !isObject(agent) || agent.id !== this.scope.agentId || agent.owner !== this.scope.owner || !publicKey(agent.ownerKey) || !decimal(agent.keyEpoch, 64, true) || BigInt(agent.keyEpoch) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProviderError("INTEGRITY_FAILED", "Finalized recovery authority/code changed");
    return { scope: structuredClone(this.scope), ownerKey: agent.ownerKey, head: decodeHead(agent.head), keyEpoch: Number(agent.keyEpoch), blockHash, timestampNs: block.header.timestamp_nanosec };
  }
}
