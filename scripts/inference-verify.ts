import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inferenceConfig } from "../packages/protocol/src/config.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { executeWorker } from "../packages/protocol/src/worker.js";
import { NearAiProvider } from "../packages/inference/src/near-ai.js";
import { loadEnvironment, printFailure, saveReport } from "./common.js";

try {
  loadEnvironment();
  const operationId = randomUUID();
  const config = inferenceConfig(process.env);
  if (!config.apiKey || !config.model) throw new ProviderError("NOT_CONFIGURED", "Configure NEARAI_API_KEY and NEARAI_MODEL before a paid inference spike");
  const directory = resolve(".persistara/spikes", operationId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const intent = { operationId, model: config.model, specimen: "fictional", references: [] as unknown[] };
  const persistIntent = () => writeFileSync(resolve(directory, "intent.json"), `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
  persistIntent();
  const provider = new NearAiProvider(config, (module, request, options) => executeWorker(module, request, {
    ...options, onProgress: event => { intent.references.push(event); persistIntent(); },
  }));
  const start = performance.now();
  const result = await provider.complete({ operationId,
    messages: [{ role: "user", content: "This is fictional test data. Call report_ready with ready=true." }],
    tools: [{ name: "report_ready", description: "Report readiness for the fictional test.", inputSchema: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }],
    maxOutputTokens: 256,
  });
  const toolCallVerified = result.toolCalls.some(call => call.name === "report_ready" && call.arguments.ready === true);
  const report = { status: toolCallVerified ? "verified_inference_and_tool_call" : "verified_inference_tool_not_demonstrated", operationId,
    model: config.model, completionId: result.id, evidence: result.evidence, usage: result.usage, toolCallVerified,
    elapsedMs: Math.round(performance.now() - start), verifiedAt: new Date().toISOString(), sdkVersion: "0.2.1", specimen: "fictional" };
  console.log(JSON.stringify({ ...report, reportPath: saveReport("inference", report) }, null, 2));
  if (!toolCallVerified) process.exitCode = 1;
} catch (error) { printFailure(error); }
