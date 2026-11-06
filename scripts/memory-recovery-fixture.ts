import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { printFailure } from "./common.js";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "persistara-recovery-drill-"));
  const run = promisify(execFile);
  const fixture = fileURLToPath(new URL("../tests/fixtures/memory-recovery-process.js", import.meta.url));
  try {
    await run(process.execPath, [fixture, "create", root], { env: {}, timeout: 30_000, maxBuffer: 10_000 });
    await rm(join(root, "original-runtime"), { recursive: true });
    const restored = await run(process.execPath, [fixture, "recover", root], { env: {}, timeout: 30_000, maxBuffer: 10_000 });
    const report: unknown = JSON.parse(restored.stdout);
    console.log(JSON.stringify(report, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(printFailure);
