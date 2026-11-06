import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "../../crypto/src/envelope.js";
import { assertBlobRef, MemoryError, type BlobRef, type BlobStore } from "../../protocol/src/memory.js";

/** Development adapter. It makes no blockchain availability or ownership claim. */
export class LocalBlobStore implements BlobStore {
  private readonly root: string;

  constructor(directory: string) { this.root = resolve(directory); }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = sha256(bytes);
    const ref: BlobRef = { provider: "local", network: "local", objectId: digest, ciphertextSha256: digest, byteLength: bytes.length };
    assertBlobRef(ref);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { await writeFile(resolve(this.root, digest), bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await this.get(ref); // Existing corrupt bytes must never be accepted as a successful write.
    }
    return ref;
  }

  async get(ref: BlobRef): Promise<Uint8Array> {
    assertBlobRef(ref);
    if (ref.provider !== "local" || ref.network !== "local" || !/^[a-f0-9]{64}$/.test(ref.objectId) || ref.objectId !== ref.ciphertextSha256) {
      throw new MemoryError("INTEGRITY_FAILED", "Blob does not belong to this local adapter");
    }
    const bytes = await readFile(resolve(this.root, ref.objectId));
    if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.ciphertextSha256) {
      throw new MemoryError("INTEGRITY_FAILED", "Stored ciphertext does not match its reference");
    }
    return bytes;
  }
}
