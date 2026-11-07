import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writePrivateFile } from "../packages/memory/src/files.js";

const directory = await mkdtemp(join(tmpdir(), "persistara-mission-drill-"));
try {
  await writePrivateFile(join(directory, "fixture.json"), Buffer.from(JSON.stringify({ now: Date.now(), requestId: randomUUID() })));
  for (const phase of ["crash", "resume", "verify"]) {
    const result = spawnSync(process.execPath, [resolve("dist/tests/fixtures/mission-recovery.js"), phase, directory], { encoding: "utf8", timeout: 30_000, maxBuffer: 32_768 });
    if (result.status !== (phase === "crash" ? 73 : 0)) throw Error(`Mission fixture ${phase} failed: ${result.stderr}`);
    if (phase === "verify") process.stdout.write(result.stdout);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
