/** Explicit synthetic transport. Used only by the multi-process crash drill. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MissionJournal } from "../../packages/runtime/src/journal.js";
import { MissionService } from "../../packages/runtime/src/service.js";
import { captureSource } from "../../packages/runtime/src/sources.js";
import { writePrivateFile } from "../../packages/memory/src/files.js";
import type { OwnerView } from "../../packages/owner/src/types.js";
import type { MissionAuthority } from "../../packages/runtime/src/types.js";

const [phase, directory] = process.argv.slice(2);
if (!directory || !["crash", "resume", "verify"].includes(phase ?? "")) throw Error("Explicit fixture phase required");
const plan = JSON.parse(await readFile(join(directory, "fixture.json"), "utf8")) as { now: number; requestId: string };
const auth: MissionAuthority = { owner: "fixture.testnet", agentId: "fixture.testnet:research", contractId: "authority.fixture.testnet", chainId: "testnet", codeHash: "11111111111111111111111111111111",
  publicKey: "ed25519:11111111111111111111111111111111", generation: "1", keyEpoch: 1, blockHash: "11111111111111111111111111111111" };
const { publicKey: _publicKey, generation: _generation, keyEpoch: _keyEpoch, blockHash: _blockHash, ...scope } = auth;
const journal = new MissionJournal(join(directory, "missions.sqlite"), scope, ["https://docs.near.org", "https://docs.0g.ai"], () => phase === "crash" ? plan.now : plan.now + 60_001);
const view = { ...scope, ownerKey: auth.publicKey, ownerKeyFullAccess: true, paused: false, localRotationHold: false, generation: auth.generation, keyEpoch: auth.keyEpoch, blockHash: auth.blockHash } as OwnerView;
const service = new MissionService(journal, { read: async (url) => {
  const index = url.includes("0g") ? 1 : 0;
  // Exclusive durable marker fails if a completed source is fetched again in a later process.
  await writePrivateFile(join(directory, `read-${index}.json`), Buffer.from(JSON.stringify({ fixture: true, ordinal: index, url })));
  return captureSource(url, Buffer.from("Explicit local source fixture. No live network, inference, upload or payment. The public GET capture is journaled before the injected crash."), "text/plain", plan.now);
} }, async () => view, () => { if (phase === "crash") process.exit(73); });
try {
  if (phase === "crash") {
    const created = service.create({ requestId: plan.requestId, title: "Interrupted research", objective: "Prove durable source capture survives process loss.", criteria: "Two source captures, no repeated completed read, one artifact and owner review.", sources: ["https://docs.near.org/", "https://docs.0g.ai/"] }, view);
    service.start(created.mission.id, created.mission.version, view); await service.wait(created.mission.id); throw Error("Fixture crash was not injected");
  }
  const mission = journal.list()[0]!;
  if (phase === "resume") {
    assert.equal(mission.state, "interrupted"); assert.equal(mission.capturedCount, 1);
    const before = journal.get(mission.id); service.start(mission.id, mission.version, view); await service.wait(mission.id);
    const ready = journal.get(mission.id); assert.equal(ready.mission.state, "awaiting_review"); assert.equal(ready.sources[0]!.attempts, 1); assert.equal(ready.sources[1]!.attempts, 1);
    assert.equal(ready.sources[0]!.operationId, before.sources[0]!.operationId);
    service.approve(mission.id, ready.mission.version, ready.artifact!.digest);
  } else {
    const detail = journal.get(mission.id); assert.equal(detail.mission.state, "completed"); assert.equal(detail.sources.length, 2);
    assert.equal(detail.events.filter((event) => event.kind === "artifact_ready").length, 1); assert.equal(detail.events.filter((event) => event.kind === "owner_approved").length, 1);
    console.log(JSON.stringify({ fixture: true, workflow: "source-dossier", abruptCrashRecovered: true, capturedSources: 2, completedReadsRepeated: 0, artifacts: 1, ownerReviews: 1, nearAiUsed: false, publicTransactions: 0 }));
  }
} finally { await service.close(); journal.close(); }
