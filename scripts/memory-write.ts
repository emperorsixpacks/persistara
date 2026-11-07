import { resolve } from "node:path";
import { decodePrivateKeyring } from "../packages/memory/src/backup.js";
import { readPrivateFile } from "../packages/memory/src/files.js";
import { validateInput, type RememberInput } from "../packages/memory/src/service.js";
import { MemoryWriteJournal } from "../packages/memory/src/write-journal.js";
import { DurableMemoryWriter } from "../packages/memory/src/writer.js";
import { NearAuthorityReader, NearMemoryHeadStore } from "../packages/near/src/client.js";
import { nearConfig } from "../packages/near/src/config.js";
import { IsolatedNearSigner } from "../packages/near/src/isolated.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { storageConfig } from "../packages/protocol/src/config.js";
import { isObject, MemoryError } from "../packages/protocol/src/memory.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { loadEnvironment, printFailure } from "./common.js";
import { publicMemoryBinding } from "./memory-config.js";

async function main(): Promise<void> {
  loadEnvironment();
  const [command, ...argv] = process.argv.slice(2);
  if (!command || !["write", "resume", "reconcile", "cancel"].includes(command)) throw new MemoryError("INVALID_INPUT", "Unknown memory write command");
  const args = new Map<string, string>();
  const allowed = ["--keyring", "--state-dir", command === "write" ? "--input-file" : "--operation-id"];
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]; const value = argv[i + 1];
    if (!name || !allowed.includes(name) || !value || args.has(name)) throw new MemoryError("INVALID_INPUT", "Invalid memory write argument");
    args.set(name, value);
  }
  const required = (name: string): string => { const value = args.get(name); if (!value) throw new MemoryError("INVALID_INPUT", "Missing memory write argument"); return value; };
  const binding = publicMemoryBinding(); const config = nearConfig(process.env);
  const keys = decodePrivateKeyring(await readPrivateFile(required("--keyring")), binding);
  const state = resolve(required("--state-dir"));
  let input: RememberInput | undefined;
  if (command === "write") {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateFile(required("--input-file"), 100_000))) as unknown; }
    catch (error) { if (error instanceof MemoryError) throw error; throw new MemoryError("INVALID_INPUT", "Memory input file is invalid"); }
    if (!isObject(value) || Object.keys(value).some((key) => !["operationId", "text", "source", "supersedes"].includes(key))) throw new MemoryError("INVALID_INPUT", "Invalid memory input fields");
    input = value as unknown as RememberInput; validateInput(input);
  }
  const { uploaderKeyFile: _unused, ...readConfig } = storageConfig(process.env);
  const blobs = new ZeroGBlobStore(command === "write" || command === "resume" ? storageConfig(process.env) : readConfig);
  const heads = new NearMemoryHeadStore(new NearAuthorityReader(new NearRpc(config)), config, new IsolatedNearSigner(config));
  const journal = new MemoryWriteJournal(resolve(state, "writes.sqlite"), binding, Date.now, command === "write");
  try {
    const writer = new DurableMemoryWriter(binding, keys, blobs, heads, journal);
    const receipt = command === "write" ? await writer.remember(input!) : command === "resume" ? await writer.resume(required("--operation-id")) :
      command === "cancel" ? await writer.cancel(required("--operation-id")) : await writer.reconcile(required("--operation-id"));
    console.log(JSON.stringify({ ...receipt, recallRefreshRequired: receipt.status === "committed" }, null, 2));
    process.exitCode = receipt.status === "unknown" || receipt.status === "pending" ? 3 : receipt.status === "committed" || receipt.status === "canceled" ? 0 : 1;
  } finally { journal.close(); }
}
main().catch((error: unknown) => {
  if (error instanceof MemoryError) { console.error(JSON.stringify({ status: "failed", code: error.code })); process.exitCode = 1; }
  else printFailure(error);
});
