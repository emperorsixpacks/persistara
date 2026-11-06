import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { seal, open, sha256 } from "../packages/crypto/src/envelope.js";
import { storageConfig } from "../packages/protocol/src/config.js";
import { assertBlobRef, isObject } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { executeWorker } from "../packages/protocol/src/worker.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { loadEnvironment, printFailure, saveReport } from "./common.js";

try {
  loadEnvironment();
  const config = storageConfig(process.env);
  const readIndex = process.argv.indexOf("--read");
  if (readIndex !== -1) {
    const path = process.argv[readIndex + 1];
    if (!path) throw new ProviderError("INVALID_INPUT", "Pass an existing successful storage report after --read");
    const report: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(report) || report.status !== "verified_storage_roundtrip") throw new ProviderError("INVALID_INPUT", "Not a successful storage spike report");
    assertBlobRef(report.ref);
    const bytes = await new ZeroGBlobStore(config).get(report.ref);
    console.log(JSON.stringify({ status: "verified_fresh_process_read", ciphertextSha256: sha256(bytes), byteLength: bytes.length, proofVerified: true }));
  } else {
    if (!config.uploaderKeyFile) throw new ProviderError("NOT_CONFIGURED", "Configure ZG_UPLOADER_KEY_FILE before a paid storage spike");
    const operationId = randomUUID();
    const key = randomBytes(32);
    const context = { agentId: "spike:fictional", recordId: `spike:${operationId}`, keyEpoch: 1, purpose: "memory" as const };
    const plaintext = Buffer.from("Fictional provider test: Persistara prefers dated primary sources.");
    const bytes = seal(plaintext, key, context);
    const directory = resolve(".persistara/spikes", operationId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(directory, "ciphertext.bin"), bytes, { flag: "wx", mode: 0o600 });
    const intent = { operationId, network: `0g:${config.chainId}:${config.mode}`, ciphertextSha256: sha256(bytes), byteLength: bytes.length, references: [] as unknown[] };
    const persistIntent = () => writeFileSync(resolve(directory, "intent.json"), `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
    persistIntent();
    const store = new ZeroGBlobStore(config, (module, request, options) => executeWorker(module, request, {
      ...options, onProgress: (event) => { intent.references.push(event); persistIntent(); },
    }));
    const start = performance.now();
    const ref = await store.put(bytes);
    const recovered = await store.get(ref);
    if (!Buffer.from(open(recovered, key, context)).equals(plaintext)) throw new ProviderError("INTEGRITY_FAILED", "Encrypted roundtrip payload mismatch");
    const report = { status: "verified_storage_roundtrip", operationId, network: ref.network, ref, evidence: store.getLastUploadEvidence(), elapsedMs: Math.round(performance.now() - start), verifiedAt: new Date().toISOString(), sdkVersion: "1.2.13", specimen: "fictional", decryptionKeyPersisted: false };
    const path = saveReport("storage", report);
    console.log(JSON.stringify({ ...report, reportPath: path }, null, 2));
  }
} catch (error) { printFailure(error); }
