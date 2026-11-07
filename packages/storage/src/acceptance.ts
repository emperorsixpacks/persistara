import { randomBytes, randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { open, seal, sha256 } from "../../crypto/src/envelope.js";
import { privateDirectory, readPrivateFile, writePrivateFile } from "../../memory/src/files.js";
import { assertBlobRef, isObject, sameBlob, type BlobRef, type PreparedBlobStore } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";

const SPECIMEN = Buffer.from("Fictional provider test: Persistara prefers dated primary sources.");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const context = (operationId: string) => ({ agentId: "acceptance:fictional", recordId: operationId, keyEpoch: 1, purpose: "memory" as const });
interface Intent { schemaVersion: 1; operationId: string; ref: BlobRef; ciphertext: string }
function exists(error: unknown): boolean { return isObject(error) && error.code === "EEXIST"; }
async function optional(path: string): Promise<Uint8Array | null> {
  try { return await readPrivateFile(path, 32_768); }
  catch (error) { if (isObject(error) && error.code === "ENOENT") return null; throw error; }
}

/** A single durable fictional upload. Existing dispatched operations can only be read/reconciled. */
export class StorageAcceptance {
  constructor(readonly directory: string, private readonly store: PreparedBlobStore & { network: string }) {}
  private path(name: string): string { return resolve(this.directory, name); }

  async prepare(): Promise<{ operationId: string; ref: BlobRef }> {
    await privateDirectory(this.directory);
    if (await optional(this.path("intent.json"))) {
      const { operationId, ref } = await this.load();
      return { operationId, ref };
    }
    // A partial initializer is intentionally not taken over: no external effect is possible yet.
    const operationId = randomUUID();
    await writePrivateFile(this.path("initializing.json"), json({ operationId }));
    const key = randomBytes(32);
    await writePrivateFile(this.path("recovery.key"), key);
    const ciphertext = seal(SPECIMEN, key, context(operationId));
    const ref = await this.store.prepare(ciphertext);
    this.assertRef(ref, ciphertext);
    const intent: Intent = { schemaVersion: 1, operationId, ref, ciphertext: Buffer.from(ciphertext).toString("base64url") };
    await writePrivateFile(this.path("intent.json"), json(intent));
    return { operationId, ref };
  }

  private assertRef(ref: BlobRef, bytes: Uint8Array): void {
    assertBlobRef(ref);
    if (ref.provider !== "0g" || !/^0g:16602:(turbo|standard)$/.test(this.store.network) || ref.network !== this.store.network ||
        !HASH.test(ref.objectId) || ref.byteLength !== bytes.length || ref.ciphertextSha256 !== sha256(bytes)) {
      throw new ProviderError("INTEGRITY_FAILED", "Acceptance root, bytes or network differs from the prepared intent");
    }
  }

  private async load(): Promise<Intent> {
    await privateDirectory(this.directory);
    const value: unknown = JSON.parse(Buffer.from(await readPrivateFile(this.path("intent.json"))).toString("utf8"));
    if (!isObject(value) || value.schemaVersion !== 1 || typeof value.operationId !== "string" || !UUID.test(value.operationId) ||
        typeof value.ciphertext !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.ciphertext) ||
        Object.keys(value).sort().join(",") !== "ciphertext,operationId,ref,schemaVersion") {
      throw new ProviderError("INTEGRITY_FAILED", "Invalid acceptance intent");
    }
    assertBlobRef(value.ref);
    const bytes = Buffer.from(value.ciphertext, "base64url");
    if (bytes.toString("base64url") !== value.ciphertext) throw new ProviderError("INTEGRITY_FAILED", "Noncanonical acceptance ciphertext");
    this.assertRef(value.ref, bytes);
    // A missing or wrong recovery key must fail before a new dispatch.
    const key = await readPrivateFile(this.path("recovery.key"), 32);
    if (!Buffer.from(open(bytes, key, context(value.operationId))).equals(SPECIMEN)) throw new ProviderError("INTEGRITY_FAILED", "Unexpected acceptance specimen");
    return value as unknown as Intent;
  }

  private async dispatched(intent: Intent): Promise<boolean> {
    const bytes = await optional(this.path("dispatched.json"));
    if (!bytes) return false;
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!isObject(value) || value.operationId !== intent.operationId || value.intentSha256 !== sha256(json(intent))) {
      throw new ProviderError("INTEGRITY_FAILED", "Dispatch marker differs from the acceptance intent");
    }
    return true;
  }

  async upload(): Promise<Awaited<ReturnType<StorageAcceptance["verify"]>>> {
    const intent = await this.load();
    if (await this.dispatched(intent)) return this.reconcile();
    await this.store.assertUploadReady();
    try {
      // Exclusive and fsynced BEFORE calling the SDK. A crash here fences resubmission too.
      await writePrivateFile(this.path("dispatched.json"), json({ operationId: intent.operationId, intentSha256: sha256(json(intent)), dispatchedAt: new Date().toISOString() }));
    } catch (error) { if (exists(error)) return this.reconcile(); throw error; }
    try {
      const ref = await this.store.putPrepared(intent.ref, Buffer.from(intent.ciphertext, "base64url"), (txHash) => {
        if (!HASH.test(txHash)) throw new ProviderError("INTEGRITY_FAILED", "Invalid submitted transaction hash");
        // Worker progress callbacks are synchronous; persist the observation before returning.
        const file = openSync(this.path("submitted.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(file, json({ operationId: intent.operationId, txHash })); fsyncSync(file); }
        finally { closeSync(file); }
        const directory = openSync(resolve(this.directory), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      });
      if (!sameBlob(ref, intent.ref)) throw new ProviderError("INTEGRITY_FAILED", "Upload returned another root");
    } catch {
      throw new ProviderError("OUTCOME_UNKNOWN", "Reconcile the fixed storage root; never dispatch a replacement", false, intent.ref.objectId);
    }
    return this.reconcile();
  }

  private async reconcile(): Promise<Awaited<ReturnType<StorageAcceptance["verify"]>>> {
    try { return await this.verify(); }
    catch (error) {
      if (error instanceof ProviderError && error.code === "INTEGRITY_FAILED") throw error;
      const intent = await this.load();
      throw new ProviderError("OUTCOME_UNKNOWN", "Prepared storage root is not yet verified; no replacement is authorized", false, intent.ref.objectId);
    }
  }

  /** Fresh proof-enabled read and authenticated decryption; uploader key is never needed. */
  async verify() {
    const intent = await this.load();
    const dispatchRecorded = await this.dispatched(intent);
    const start = performance.now();
    const bytes = await this.store.get(intent.ref);
    this.assertRef(intent.ref, bytes);
    const key = await readPrivateFile(this.path("recovery.key"), 32);
    if (!Buffer.from(open(bytes, key, context(intent.operationId))).equals(SPECIMEN)) throw new ProviderError("INTEGRITY_FAILED", "Recovered specimen differs");
    const submittedBytes = await optional(this.path("submitted.json"));
    let txHash: string | null = null;
    if (submittedBytes) {
      const submitted: unknown = JSON.parse(Buffer.from(submittedBytes).toString("utf8"));
      if (!isObject(submitted) || submitted.operationId !== intent.operationId || typeof submitted.txHash !== "string" || !HASH.test(submitted.txHash)) {
        throw new ProviderError("INTEGRITY_FAILED", "Invalid transaction observation");
      }
      txHash = submitted.txHash;
    }
    return { status: "verified_storage_acceptance" as const, operationId: intent.operationId, ref: intent.ref, txHash,
      dispatchRecorded, checks: ["finalized_storage_metadata", "merkle_proof", "ciphertext_digest_and_length", "authenticated_decryption"],
      verifiedAt: new Date().toISOString(), retrievalAndDecryptionMs: Math.round(performance.now() - start),
      sdkVersion: "1.2.13", specimen: "fictional", nearCheckpointVerified: false, nearAiUsed: false };
  }
}
