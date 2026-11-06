import { IsolatedNearSigner } from "../packages/near/src/isolated.js";
import { nearConfig } from "../packages/near/src/config.js";
import { loadEnvironment, printFailure } from "./common.js";

async function main(): Promise<void> {
  loadEnvironment();
  const id = process.argv[2] ?? "";
  const outcome = await new IsolatedNearSigner(nearConfig(process.env)).reconcile(id);
  // Contract return payloads can contain metadata. The diagnostic prints status and identity only.
  console.log(JSON.stringify({ operationId: id, status: outcome.status, transactionHash: outcome.transactionHash,
    ...(outcome.status === "failed" ? { failureCode: outcome.failureCode } : {}) }, null, 2));
  if (outcome.status !== "confirmed") process.exitCode = outcome.status === "unknown" ? 3 : 1;
}
main().catch(printFailure);
