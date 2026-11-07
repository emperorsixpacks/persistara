import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writePrivateFile } from "../packages/memory/src/files.js";
import { storageConfig } from "../packages/protocol/src/config.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { StorageAcceptance } from "../packages/storage/src/acceptance.js";
import { ZeroGBlobStore } from "../packages/storage/src/zero-g.js";
import { loadEnvironment, printFailure } from "./common.js";

try {
  loadEnvironment();
  const [command, directory = ".persistara/acceptance/storage", ...extra] = process.argv.slice(2);
  if (!["prepare", "upload", "verify"].includes(command ?? "") || extra.length) throw new ProviderError("INVALID_INPUT", "Use storage:acceptance prepare|upload|verify [private-state-directory]");
  const config = storageConfig(process.env);
  const { uploaderKeyFile: _unused, ...readConfig } = config;
  const acceptance = new StorageAcceptance(resolve(directory), new ZeroGBlobStore(command === "upload" ? config : readConfig));
  const result = command === "prepare" ? { status: "prepared_not_uploaded", ...await acceptance.prepare() }
    : command === "upload" ? await acceptance.upload() : await acceptance.verify();
  if (result.status === "prepared_not_uploaded") console.log(JSON.stringify(result, null, 2));
  else {
    const reportPath = resolve(directory, `report-${randomUUID()}.json`);
    await writePrivateFile(reportPath, Buffer.from(`${JSON.stringify(result, null, 2)}\n`));
    console.log(JSON.stringify({ ...result, reportPath }, null, 2));
  }
} catch (error) { printFailure(error); }
