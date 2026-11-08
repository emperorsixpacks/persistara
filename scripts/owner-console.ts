import { resolve } from "node:path";
import { createOwnerServer } from "../packages/owner/src/server.js";
import { createLocalWorkspace, workspaceDefaults } from "../packages/operator/src/workspace.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { loadEnvironment, printFailure } from "./common.js";

async function main() {
  loadEnvironment();
  const defaults: Record<string, string> = { "--port": "3377", ...workspaceDefaults };
  const args = process.argv.slice(2), supplied = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!name || !Object.hasOwn(defaults, name) || !value || supplied.has(name)) throw new ProviderError("INVALID_INPUT", "Unknown or duplicate owner console argument");
    supplied.add(name); defaults[name] = value;
  }
  const paths = { ...workspaceDefaults }; for (const key of Object.keys(paths) as (keyof typeof paths)[]) paths[key] = defaults[key]!;
  const workspace = await createLocalWorkspace(paths);
  const { service, missions, commerce } = workspace;
  const { server, origin, drain } = createOwnerServer({ port: Number(defaults["--port"]), staticDirectory: resolve("apps/console/dist"), service, missions, commerce });
  server.on("error", error => { void workspace.close().finally(() => printFailure(error)); });
  server.listen(Number(defaults["--port"]), "127.0.0.1", () => console.log(JSON.stringify({ status: "owner_console_listening", url: origin, network: "near:testnet", owner: workspace.config.signerId, agentId: workspace.config.agentId, ownerKeyLoaded: false, nearAiUsed: false })));
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    const stopped = missions.close();
    server.close(() => { void Promise.allSettled([stopped, drain()]).then(() => workspace.close()).finally(() => process.exit(0)); });
    server.closeIdleConnections();
  };
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
main().catch(printFailure);
