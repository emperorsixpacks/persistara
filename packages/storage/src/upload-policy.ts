import { ProviderError } from "../../protocol/src/providers.js";

/** Hard per-transaction ceiling, including maximum gas, for the Galileo-only adapter. */
export const MAX_UPLOAD_COST_WEI = 10_000_000_000_000_000n; // 0.01 testnet 0G
export const TURBO_FLOW = "0x22e03a6a89b950f1c82ec5e74f8eca321a105296";

export function assertUploadTransaction(tx: {
  to?: unknown; chainId?: unknown; value?: unknown; gasLimit?: unknown; gasPrice?: unknown;
  maxFeePerGas?: unknown;
}, expectedFlow: string): void {
  const { chainId, value, gasLimit } = tx;
  const gasPrice = tx.maxFeePerGas ?? tx.gasPrice;
  if (typeof tx.to !== "string" || tx.to.toLowerCase() !== expectedFlow.toLowerCase() || chainId !== 16602n ||
      typeof value !== "bigint" || value < 0n || typeof gasLimit !== "bigint" || gasLimit <= 0n ||
      typeof gasPrice !== "bigint" || gasPrice <= 0n || value + gasLimit * gasPrice > MAX_UPLOAD_COST_WEI) {
    throw new ProviderError("AUTHORIZATION_FAILED", "Upload transaction exceeds its testnet destination/network/cost policy");
  }
}
