import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { baseEncode } from "near-api-js";
import { decodePrivateKeyring, verifyOwnerBackup } from "../packages/memory/src/backup.js";
import { readPrivateFile } from "../packages/memory/src/files.js";
import { MemoryWriteJournal } from "../packages/memory/src/write-journal.js";
import { nearConfig } from "../packages/near/src/config.js";
import { NearRpc } from "../packages/near/src/rpc.js";
import { OwnerJournal } from "../packages/owner/src/journal.js";
import { OwnerReader } from "../packages/owner/src/reader.js";
import { OwnerService } from "../packages/owner/src/service.js";
import { createOwnerServer } from "../packages/owner/src/server.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { loadEnvironment, printFailure } from "./common.js";
import { publicMemoryBinding } from "./memory-config.js";

async function main() {
  loadEnvironment();
  const defaults: Record<string, string> = { "--port": "3377", "--memory-state-dir": ".persistara/runtime/research", "--state-dir": ".persistara/owner-console", "--keyring": ".persistara/keys/memory-keyring.json", "--bundle": ".persistara/recovery/research.bundle", "--secret-file": ".persistara/keys/research-recovery.secret" };
  const args = process.argv.slice(2); const supplied = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!name || !Object.hasOwn(defaults, name) || !value || supplied.has(name)) throw new ProviderError("INVALID_INPUT", "Unknown or duplicate owner console argument");
    supplied.add(name); defaults[name] = value;
  }
  const port = Number(defaults["--port"]);
  const config = nearConfig(process.env), binding = publicMemoryBinding(), rpc = new NearRpc(config);
  const wasm = await readFile("target/near/persistara_authority/persistara_authority.wasm");
  const codeHash = baseEncode(createHash("sha256").update(wasm).digest());
  const reader = new OwnerReader(rpc, config, codeHash, async (epoch) => {
    let status: "verified" | "epoch_mismatch" | "unavailable" = "unavailable";
    try {
      const keys = decodePrivateKeyring(await readPrivateFile(defaults["--keyring"]!), binding);
      verifyOwnerBackup(await readPrivateFile(defaults["--bundle"]!), Buffer.from(await readPrivateFile(defaults["--secret-file"]!)).toString("utf8").trim(), binding, keys);
      status = keys.activeEpoch === epoch ? "verified" : "epoch_mismatch";
    } catch { /* Backup readiness fails closed without exposing paths or material. */ }
    let localRotationHold: boolean | null = null;
    try {
      const memory = new MemoryWriteJournal(resolve(defaults["--memory-state-dir"]!, "writes.sqlite"), binding, Date.now, false);
      try { localRotationHold = memory.controls().heldBy !== null || memory.controls().minimumEpoch > epoch; }
      finally { memory.close(); }
    } catch { /* Missing canonical journal cannot authorize resume. */ }
    return { backup: { status, offDeviceVerified: false as const }, localRotationHold };
  });
  const journal = new OwnerJournal(resolve(defaults["--state-dir"]!, "wallet.sqlite"), config, codeHash);
  const service = new OwnerService(config, journal, () => reader.read(), rpc);
  const { server, origin } = createOwnerServer({ port, staticDirectory: resolve("apps/console/dist"), service });
  server.on("error", (error) => { journal.close(); printFailure(error); });
  server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ status: "owner_console_listening", url: origin, network: "near:testnet", owner: config.signerId, agentId: config.agentId, ownerKeyLoaded: false, nearAiUsed: false })));
  const close = () => { server.close(() => { journal.close(); process.exit(0); }); server.closeIdleConnections(); };
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
main().catch(printFailure);
