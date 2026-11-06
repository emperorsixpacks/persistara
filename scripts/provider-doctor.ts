import { readFile, stat } from "node:fs/promises";
import { Wallet } from "ethers";
import { assertRuntime, storageConfig, inferenceConfig } from "../packages/protocol/src/config.js";
import { isObject } from "../packages/protocol/src/memory.js";
import { boundedJson, loadEnvironment, printFailure } from "./common.js";

try {
  loadEnvironment();
  assertRuntime();
  const storage = storageConfig(process.env);
  const inference = inferenceConfig(process.env);
  const missing: string[] = [];
  let address: string | null = null;
  if (!storage.uploaderKeyFile) missing.push("ZG_UPLOADER_KEY_FILE");
  else {
    try {
      const info = await stat(storage.uploaderKeyFile);
      if (!info.isFile() || (info.mode & 0o077) !== 0) missing.push("uploader key file must be a restricted regular file (chmod 600)");
      else address = new Wallet((await readFile(storage.uploaderKeyFile, "utf8")).trim()).address;
    } catch { missing.push("uploader key file missing or invalid; run pnpm storage:wallet"); }
  }
  if (!inference.apiKey) missing.push("NEARAI_API_KEY");
  if (!inference.model) missing.push("NEARAI_MODEL");
  // Import smoke tests are offline; they do not verify attestations or spend funds.
  await import("@0gfoundation/0g-storage-ts-sdk");
  await import("@nearai/inference-sdk/node");
  const online: Record<string, unknown> = {};
  if (process.argv.includes("--online")) {
    const chain = await boundedJson(storage.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    online.storageRpcMatches = isObject(chain) && chain.result === "0x40da";
    if (online.storageRpcMatches !== true) missing.push("ZG_RPC_URL must report Galileo chain ID 16602");
    if (address) {
      const balance = await boundedJson(storage.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: [address, "latest"] }) });
      online.uploaderFunded = isObject(balance) && typeof balance.result === "string" && /^0x[0-9a-f]+$/i.test(balance.result) && BigInt(balance.result) > 0n;
      if (online.uploaderFunded !== true) missing.push("fund the dedicated uploader from the Galileo faucet");
    }
  }
  console.log(JSON.stringify({ status: missing.length ? "not_ready" : "configured_not_verified", runtime: process.version,
    sdkImports: "passed", network: `0g:${storage.chainId}:${storage.mode}`, uploaderAddress: address,
    inferenceModelConfigured: Boolean(inference.model), credentialsConfigured: Boolean(inference.apiKey), missing, online }, null, 2));
  if (missing.length) process.exitCode = 2;
} catch (error) { printFailure(error); }
