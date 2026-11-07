import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isObject } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { printFailure } from "./common.js";

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "persistara-write-crash-drill-"));
  const run = promisify(execFile);
  const fixture = fileURLToPath(new URL("../tests/fixtures/memory-write-process.js", import.meta.url));
  async function phase(name: string, expectedExit = 0): Promise<unknown> {
    try {
      const result = await run(process.execPath, [fixture, name, directory], { env: {}, timeout: 15_000, maxBuffer: 10_000 });
      if (expectedExit) throw new ProviderError("PROTOCOL_ERROR", "Crash drill failed to interrupt the process");
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      if (expectedExit && isObject(error) && error.code === expectedExit) return undefined;
      throw new ProviderError("PROTOCOL_ERROR", "Crash drill did not complete its expected phase");
    }
  }
  try {
    await phase("interrupt-upload", 73);
    await phase("reconcile-upload");
    await phase("interrupt-checkpoint", 74);
    await phase("reconcile-checkpoint");
    console.log(JSON.stringify(await phase("verify"), null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(printFailure);
