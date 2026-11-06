import { ProviderError } from "./providers.js";

export interface StorageConfig {
  chainId: 16602;
  mode: "turbo" | "standard";
  rpcUrl: string;
  indexerUrl: string;
  uploaderKeyFile?: string;
}
export interface InferenceConfig {
  baseUrl: "https://cloud-api.near.ai/v1";
  apiKey?: string;
  model?: string;
}

function secureUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ProviderError("INVALID_INPUT", "Provider endpoint is not a valid URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ProviderError("INVALID_INPUT", "Provider endpoints require HTTPS without credentials, query, or fragment");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function storageConfig(env: Record<string, string | undefined>): StorageConfig {
  const mode = env.ZG_STORAGE_MODE || "turbo";
  if (mode !== "turbo" && mode !== "standard") throw new ProviderError("INVALID_INPUT", "ZG_STORAGE_MODE must be turbo or standard");
  if (mode === "standard" && !env.ZG_INDEXER_URL) throw new ProviderError("NOT_CONFIGURED", "Set the documented Standard indexer explicitly in ZG_INDEXER_URL");
  const config: StorageConfig = {
    chainId: 16602,
    mode,
    rpcUrl: secureUrl(env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai"),
    indexerUrl: secureUrl(env.ZG_INDEXER_URL || "https://indexer-storage-testnet-turbo.0g.ai"),
  };
  if (env.ZG_UPLOADER_KEY_FILE) config.uploaderKeyFile = env.ZG_UPLOADER_KEY_FILE;
  return config;
}

export function inferenceConfig(env: Record<string, string | undefined>): InferenceConfig {
  const config: InferenceConfig = { baseUrl: "https://cloud-api.near.ai/v1" };
  if (env.NEARAI_API_KEY?.trim()) config.apiKey = env.NEARAI_API_KEY.trim();
  if (env.NEARAI_MODEL?.trim()) config.model = env.NEARAI_MODEL.trim();
  return config;
}

export function assertRuntime(version = process.versions.node): void {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (major < 24 || (major === 24 && (minor < 22 || (minor === 22 && patch < 1)))) {
    throw new ProviderError("NOT_CONFIGURED", "Use pnpm scripts to run the pinned Node >=24.22.1 runtime");
  }
}
