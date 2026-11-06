import { NearAuthorityReader, NearMemoryHeadStore, NearTreasuryClient } from "./client.js";
import { IsolatedNearSigner } from "./isolated.js";
import { NearRpc } from "./rpc.js";
import type { NearSignerConfig } from "./protocol.js";

/** Configure this in the trusted host. Model tools receive bounded capabilities, not this config. */
export function createNearClients(config: NearSignerConfig) {
  const reader = new NearAuthorityReader(new NearRpc(config));
  const signer = new IsolatedNearSigner(config);
  return { reader, signer, heads: new NearMemoryHeadStore(reader, config, signer), treasury: new NearTreasuryClient(reader, config, signer) };
}
