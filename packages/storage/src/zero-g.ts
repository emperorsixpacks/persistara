import { sha256 } from "../../crypto/src/envelope.js";
import { assertBlobRef, isObject, type BlobRef, type BlobStore } from "../../protocol/src/memory.js";
import type { StorageConfig } from "../../protocol/src/config.js";
import { ProviderError, type CallOptions, type WorkerExecutor } from "../../protocol/src/providers.js";
import { executeWorker } from "../../protocol/src/worker.js";

const MAX_BYTES = 1_500_000;
const ROOT = /^0x[a-fA-F0-9]{64}$/;
export interface UploadEvidence { rootHash: string; txHash: string | null; txSequence: number; finalized: true; proofVerified: true }

export class ZeroGBlobStore implements BlobStore {
  readonly network: string;
  private evidence: UploadEvidence | null = null;

  constructor(private readonly config: StorageConfig, private readonly execute: WorkerExecutor = executeWorker) {
    this.network = `0g:${config.chainId}:${config.mode}`;
  }

  getLastUploadEvidence(): UploadEvidence | null { return structuredClone(this.evidence); }

  async put(bytes: Uint8Array, options: CallOptions = {}): Promise<BlobRef> {
    this.evidence = null;
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) throw new ProviderError("INVALID_INPUT", "Storage payload must contain 1 to 1500000 encrypted bytes");
    if (!this.config.uploaderKeyFile) throw new ProviderError("NOT_CONFIGURED", "Set ZG_UPLOADER_KEY_FILE to a separately funded testnet uploader key file");
    const snapshot = Uint8Array.from(bytes);
    const value = await this.execute(new URL("./zero-g-worker.js", import.meta.url), { operation: "upload", config: this.config, bytes: snapshot }, { ...options, effect: "may-charge", timeoutMs: options.timeoutMs ?? 120_000 });
    if (!isObject(value) || !isObject(value.ref) || !isObject(value.evidence)) throw new ProviderError("PROTOCOL_ERROR", "Storage worker returned an invalid upload result");
    assertBlobRef(value.ref);
    const ref = value.ref;
    const evidence = value.evidence;
    if (ref.provider !== "0g" || ref.network !== this.network || !ROOT.test(ref.objectId) ||
        ref.byteLength !== snapshot.length || ref.ciphertextSha256 !== sha256(snapshot) ||
        evidence.rootHash !== ref.objectId || evidence.finalized !== true || evidence.proofVerified !== true ||
        !Number.isSafeInteger(evidence.txSequence) || Number(evidence.txSequence) < 0 ||
        !(evidence.txHash === null || (typeof evidence.txHash === "string" && ROOT.test(evidence.txHash)))) {
      throw new ProviderError("INTEGRITY_FAILED", "Upload evidence does not match the encrypted payload");
    }
    this.evidence = evidence as unknown as UploadEvidence;
    return structuredClone(ref);
  }

  async get(ref: BlobRef, options: CallOptions = {}): Promise<Uint8Array> {
    assertBlobRef(ref);
    if (ref.provider !== "0g" || ref.network !== this.network || !ROOT.test(ref.objectId) || ref.byteLength > MAX_BYTES) {
      throw new ProviderError("INTEGRITY_FAILED", "Blob reference belongs to another network or is invalid");
    }
    // Read requests never receive the uploader key path.
    const { uploaderKeyFile: _unused, ...readConfig } = this.config;
    const value = await this.execute(new URL("./zero-g-worker.js", import.meta.url), { operation: "download", config: readConfig, ref: structuredClone(ref) }, { ...options, effect: "read" });
    if (!(value instanceof Uint8Array) || value.byteLength !== ref.byteLength || sha256(value) !== ref.ciphertextSha256) {
      throw new ProviderError("INTEGRITY_FAILED", "Downloaded ciphertext does not match the committed reference");
    }
    return Uint8Array.from(value);
  }
}
