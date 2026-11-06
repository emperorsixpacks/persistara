import { inferenceConfig } from "../packages/protocol/src/config.js";
import { isObject } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { boundedJson, loadEnvironment, printFailure } from "./common.js";

try {
  loadEnvironment();
  const config = inferenceConfig(process.env);
  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const catalog = await boundedJson(`${config.baseUrl}/models`, { headers });
  if (!isObject(catalog) || !Array.isArray(catalog.data)) throw new ProviderError("PROTOCOL_ERROR", "Invalid model catalog");
  const models = catalog.data.flatMap((entry: unknown) => isObject(entry) && typeof entry.id === "string" ? [entry.id] : []);
  console.log(JSON.stringify({ status: "catalog_only", models, note: "A catalog entry is not evidence of TEE support. The strict inference spike must verify model evidence and a model response signature." }, null, 2));
} catch (error) { printFailure(error); }
