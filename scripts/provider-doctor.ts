import { Wallet } from "ethers";
import { readPrivateFile } from "../packages/memory/src/files.js";
import { assertRuntime, storageConfig, inferenceConfig } from "../packages/protocol/src/config.js";
import { isObject } from "../packages/protocol/src/memory.js";
import { boundedJson, loadEnvironment, printFailure } from "./common.js";

try {
  loadEnvironment();
  assertRuntime();
  const storage = storageConfig(process.env);
  const storageOnly = process.argv.includes("--storage-only");
  const inference = storageOnly ? undefined : inferenceConfig(process.env);
  const missing: string[] = [];
  let address: string | null = null;
  if (!storage.uploaderKeyFile) missing.push("ZG_UPLOADER_KEY_FILE");
  else {
    try {
      address = new Wallet(Buffer.from(await readPrivateFile(storage.uploaderKeyFile, 128)).toString("utf8").trim()).address;
    } catch { missing.push("uploader key file missing or invalid; run pnpm storage:wallet"); }
  }
  if (!storageOnly && !inference?.apiKey) missing.push("NEARAI_API_KEY");
  if (!storageOnly && !inference?.model) missing.push("NEARAI_MODEL");
  // Import smoke tests are offline; they do not verify attestations or spend funds.
  await import("@0gfoundation/0g-storage-ts-sdk");
  if (!storageOnly) await import("@nearai/inference-sdk/node");
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
    inferenceChecks: storageOnly ? "deferred" : "configuration_and_import_only",
    inferenceModelConfigured: Boolean(inference?.model), credentialsConfigured: Boolean(inference?.apiKey), missing, online }, null, 2));
  if (missing.length) process.exitCode = 2;
} catch (error) { printFailure(error); }
