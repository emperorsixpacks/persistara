import { createRequire } from "node:module";
import { Indexer, MemData, StorageNode } from "@0gfoundation/0g-storage-ts-sdk";
import type { JsonRpcProvider as RpcProvider, TransactionRequest, TransactionResponse } from "ethers" with { "resolution-mode": "require" };
import { sha256 } from "../../crypto/src/envelope.js";
import { readPrivateFile } from "../../memory/src/files.js";
import { assertBlobRef, isObject, sameBlob, type BlobRef } from "../../protocol/src/memory.js";
import { storageConfig, type StorageConfig } from "../../protocol/src/config.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { fail, progress, reply } from "../../protocol/src/worker.js";
import { assertUploadTransaction, TURBO_FLOW } from "./upload-policy.js";

const ROOT = /^0x[a-fA-F0-9]{64}$/;
// 0G publishes CJS-resolved ethers declarations. Use that same ethers entry point.
const { JsonRpcProvider, Wallet } = createRequire(import.meta.url)("ethers") as typeof import("ethers", { with: { "resolution-mode": "require" } });

async function download(config: StorageConfig, ref: BlobRef): Promise<{ bytes: Uint8Array; txSequence: number }> {
  const indexer = new Indexer(config.indexerUrl);
  const locations = await indexer.getFileLocations(ref.objectId);
  let txSequence: number | undefined;
  for (const location of locations.slice(0, 8)) {
    const node = new StorageNode(location.url);
    const status = await node.getStatus();
    if (status.networkIdentity.chainId !== config.chainId) throw new ProviderError("NETWORK_MISMATCH", "Storage node is on another network");
    const info = await node.getFileInfo(ref.objectId, true);
    if (!info) continue;
    if (!info.finalized || info.tx.size !== ref.byteLength || info.tx.dataMerkleRoot.toLowerCase() !== ref.objectId.toLowerCase() ||
        !Number.isSafeInteger(info.tx.seq) || info.tx.seq < 0) {
      throw new ProviderError("INTEGRITY_FAILED", "Storage metadata does not match the expected finalized object");
    }
    txSequence = info.tx.seq;
    break;
  }
  if (txSequence === undefined) throw new ProviderError("UPSTREAM_ERROR", "Finalized storage object is unavailable");
  const [blob, error] = await indexer.downloadToBlob(ref.objectId, { proof: true });
  if (error || blob.size !== ref.byteLength) throw new ProviderError("INTEGRITY_FAILED", "Proof-enabled storage retrieval failed");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (sha256(bytes) !== ref.ciphertextSha256) throw new ProviderError("INTEGRITY_FAILED", "Storage returned different ciphertext");
  return { bytes, txSequence };
}

process.once("message", async (request: unknown) => {
  let submissionPossible = false;
  let provider: RpcProvider | undefined;
  try {
    if (!isObject(request) || !isObject(request.config)) throw new ProviderError("INVALID_INPUT", "Invalid storage worker request");
    const raw = request.config;
    if (raw.chainId !== 16602 || (raw.mode !== "turbo" && raw.mode !== "standard") || typeof raw.rpcUrl !== "string" || typeof raw.indexerUrl !== "string") {
      throw new ProviderError("INVALID_INPUT", "Only configured Galileo testnet storage is enabled");
    }
    const config = storageConfig({ ZG_RPC_URL: raw.rpcUrl, ZG_INDEXER_URL: raw.indexerUrl, ZG_STORAGE_MODE: raw.mode,
      ...(typeof raw.uploaderKeyFile === "string" ? { ZG_UPLOADER_KEY_FILE: raw.uploaderKeyFile } : {}) });
    let preparedFile: MemData | undefined;
    let preparedRef: BlobRef | undefined;
    if (request.operation === "prepare" || request.operation === "upload") {
      if (!(request.bytes instanceof Uint8Array) || request.bytes.length < 1 || request.bytes.length > 1_500_000) throw new ProviderError("INVALID_INPUT", "Invalid encrypted upload");
      preparedFile = new MemData(request.bytes);
      const [tree, error] = await preparedFile.merkleTree();
      const rootHash = tree?.rootHash();
      if (error || !rootHash || !ROOT.test(rootHash)) throw new ProviderError("INVALID_INPUT", "Could not prepare storage Merkle root");
      preparedRef = { provider: "0g", network: `0g:${config.chainId}:${config.mode}`, objectId: rootHash, ciphertextSha256: sha256(request.bytes), byteLength: request.bytes.length };
      if (request.operation === "prepare") { reply(preparedRef); return; }
      if (request.expected !== undefined) {
        assertBlobRef(request.expected);
        if (!sameBlob(request.expected, preparedRef)) throw new ProviderError("INTEGRITY_FAILED", "Upload root differs from its prepared reference");
      }
    }
    provider = new JsonRpcProvider(config.rpcUrl);
    if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) throw new ProviderError("NETWORK_MISMATCH", "RPC is not Galileo testnet");
    if (request.operation === "download") {
      assertBlobRef(request.ref);
      if (request.ref.provider !== "0g" || request.ref.network !== `0g:${config.chainId}:${config.mode}` || !ROOT.test(request.ref.objectId) || request.ref.byteLength > 1_500_000) {
        throw new ProviderError("INVALID_INPUT", "Invalid 0G download reference");
      }
      reply((await download(config, request.ref)).bytes);
      return;
    }
    if (!["upload", "check-upload"].includes(String(request.operation)) || !config.uploaderKeyFile ||
        (request.operation === "upload" && (!(request.bytes instanceof Uint8Array) || request.bytes.length < 1 || request.bytes.length > 1_500_000))) {
      throw new ProviderError("INVALID_INPUT", "Invalid encrypted upload or missing uploader key file");
    }
    const privateKey = Buffer.from(await readPrivateFile(config.uploaderKeyFile, 128)).toString("utf8").trim();
    if (!ROOT.test(privateKey)) throw new ProviderError("NOT_CONFIGURED", "Uploader key file must contain one EVM private key");
    let expectedFlow = "";
    let attempted = false;
    class BoundedUploader extends Wallet {
      override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
        const populated = await this.populateTransaction(tx);
        assertUploadTransaction(populated, expectedFlow);
        if (attempted) throw new ProviderError("AUTHORIZATION_FAILED", "Only one submission attempt is authorized per upload");
        attempted = true;
        return super.sendTransaction(populated);
      }
    }
    const signer = new BoundedUploader(privateKey, provider);
    if ((await provider.getBalance(signer.address)) === 0n) throw new ProviderError("NOT_CONFIGURED", "Uploader wallet needs testnet funds");
    const indexer = new Indexer(config.indexerUrl);
    const [uploader, selectionError] = await indexer.newUploaderFromIndexerNodes(config.rpcUrl, signer, 1);
    if (selectionError || !uploader || !uploader.nodes.length) throw new ProviderError("UPSTREAM_ERROR", "No eligible storage nodes");
    expectedFlow = (await uploader.flow.getAddress()).toLowerCase();
    for (const node of uploader.nodes) {
      const status = await node.getStatus();
      if (status.networkIdentity.chainId !== config.chainId || status.networkIdentity.flowAddress.toLowerCase() !== expectedFlow ||
          (config.mode === "turbo" && expectedFlow !== TURBO_FLOW)) {
        throw new ProviderError("NETWORK_MISMATCH", "Selected storage node or flow is on another network");
      }
    }
    if (request.operation === "check-upload") { uploader.provider.destroy(); reply({ ready: true }); return; }
    const file = preparedFile!;
    const rootHash = preparedRef!.objectId;
    progress("prepared", rootHash);
    submissionPossible = true;
    const [result, uploadError] = await uploader.uploadFile(file, {
      finalityRequired: true, expectedReplica: 1, skipIfFinalized: true, skipTx: true,
      onProgress: (message) => {
        const hash = /^Transaction submitted: (0x[a-fA-F0-9]{64})$/.exec(message)?.[1];
        if (hash) progress("submitted", hash);
      },
    }, { Retries: 1, Interval: 1_000, MaxGasPrice: 0, TooManyDataRetries: 1 });
    uploader.provider.destroy();
    if (uploadError || !("rootHash" in result) || result.rootHash !== rootHash) throw new ProviderError("OUTCOME_UNKNOWN", "Upload needs root/transaction reconciliation");
    if (result.txHash) {
      const receipt = await provider.getTransactionReceipt(result.txHash);
      if (!receipt || receipt.status !== 1) throw new ProviderError("OUTCOME_UNKNOWN", "Upload transaction has not been confirmed successful");
    }
    const ref = preparedRef!;
    const recovered = await download(config, ref);
    reply({ ref, evidence: { rootHash, txHash: result.txHash || null, txSequence: recovered.txSequence, finalized: true, proofVerified: true } });
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : submissionPossible ? "OUTCOME_UNKNOWN" : "UPSTREAM_ERROR";
    fail(code);
  } finally { provider?.destroy(); }
});
