import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { KeyPairSigner, type KeyPairString } from "near-api-js";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { fail, progress, reply } from "../../protocol/src/worker.js";
import { NearJournal } from "./journal.js";
import { DurableNearSigner } from "./signer.js";
import { NearRpc } from "./rpc.js";
import { validateIdentity, validateNetwork, type ContractCall, type NearSignerConfig } from "./protocol.js";

async function loadRuntimeKey(path: string): Promise<KeyPairSigner> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 200 || (info.mode & 0o077) !== 0) throw new ProviderError("NOT_CONFIGURED", "Runtime key file must be private and bounded");
    const text = (await file.readFile("utf8")).trim();
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(text)) throw new ProviderError("NOT_CONFIGURED", "Runtime key file is invalid");
    return KeyPairSigner.fromSecretKey(text as KeyPairString);
  } finally { await file.close(); }
}

process.once("message", async (request: unknown) => {
  let journal: NearJournal | undefined;
  try {
    if (!isObject(request) || !isObject(request.config) || typeof request.id !== "string" || !["submit", "reconcile", "identify", "rotation-hold", "rotation-release"].includes(String(request.operation))) throw new ProviderError("INVALID_INPUT", "Invalid signer worker command");
    const config = request.config as unknown as NearSignerConfig;
    validateNetwork(config); validateIdentity(config);
    if (typeof config.journalFile !== "string" || typeof config.runtimeKeyFile !== "string") throw new ProviderError("NOT_CONFIGURED", "Missing signer paths");
    journal = new NearJournal(config.journalFile, config, (request.operation === "submit" && request.expectedJournalIdentity === undefined) || (request.operation === "identify" && request.create === true));
    if (request.operation === "identify") { const identity = journal.identity(); journal.close(); journal = undefined; reply(identity); return; }
    if (request.expectedJournalIdentity !== undefined && request.expectedJournalIdentity !== journal.identity()) throw new ProviderError("INTEGRITY_FAILED", "Signer journal was replaced; submission is fenced");
    if (request.operation === "rotation-hold" || request.operation === "rotation-release") {
      if (typeof request.expectedJournalIdentity !== "string") throw new ProviderError("INVALID_INPUT", "A signer identity is required for rotation barriers");
      if (request.operation === "rotation-hold") journal.holdForRotation(request.id); else journal.releaseRotation(request.id);
      const identity = journal.identity(); journal.close(); journal = undefined; reply(identity); return;
    }
    const rpc = new NearRpc(config);
    const existing = journal.get(request.id);
    const needsKey = request.operation === "submit" && (!existing || existing.state === "allocated" || existing.state === "prepared");
    const key = needsKey ? await loadRuntimeKey(config.runtimeKeyFile) : undefined;
    const signer = new DurableNearSigner(config, rpc, journal, key, (reference) => progress("prepared", reference));
    const result = request.operation === "submit" ? await signer.submit(request.id, request.call as ContractCall) : await signer.reconcile(request.id);
    progress("completion", result.transactionHash);
    journal.close(); journal = undefined;
    reply(result);
  } catch (error) {
    journal?.close();
    fail(error instanceof ProviderError ? error.code : "UPSTREAM_ERROR");
  }
});
