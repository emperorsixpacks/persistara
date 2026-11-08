import { resolve } from "node:path";
import { NearAuthorityReader } from "../../near/src/client.js";
import { MemoryRecallIndex } from "../../memory/src/index.js";
import { readPrivateFile } from "../../memory/src/files.js";
import { rebuildFromOwnerBackup, recallCommitted } from "../../memory/src/recovery.js";
import { ZeroGBlobStore } from "../../storage/src/zero-g.js";
import { storageConfig } from "../../protocol/src/config.js";
import type { LocalWorkspace } from "./workspace.js";

export function terminalMemory(workspace: LocalWorkspace) {
  const { binding, paths } = workspace, reader = new NearAuthorityReader(workspace.rpc);
  const heads = { get: async (id: string) => (await reader.agent(id)).head };
  const index = () => new MemoryRecallIndex(resolve(paths["--memory-state-dir"], "recall.sqlite"), binding);
  return {
    async recall(query: string) { const cache = index(); try { return await recallCommitted(cache, heads, binding.agentId, query); } finally { cache.close(); } },
    async recover() {
      const cache = index(), { uploaderKeyFile: _unused, ...storage } = storageConfig(process.env), adapter = new ZeroGBlobStore(storage);
      try {
        const result = await rebuildFromOwnerBackup({ binding, heads, index: cache, bundle: await readPrivateFile(paths["--bundle"]), recoverySecret: Buffer.from(await readPrivateFile(paths["--secret-file"])).toString().trim(), blobs: { get: ref => adapter.get(ref), put: async () => { throw Error("Read-only recovery"); } } });
        return { status: "committed_memory_cache_rebuilt", checkpointVersion: result.version, recordCount: result.recordCount, currentFacts: result.currentCount, recoveredEpochs: result.recoveredEpochs, uploadOrTransactionSubmitted: false };
      } finally { cache.close(); }
    },
  };
}
