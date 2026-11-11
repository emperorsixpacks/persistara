import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProviderError } from "../packages/protocol/src/providers.js";

export function loadEnvironment(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}
export function saveReport(name: string, report: unknown): string {
  const directory = resolve(".persistara/evidence");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${name}-${new Date().toISOString().replaceAll(":", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return path;
}
export function printFailure(error: unknown): void {
  const report = error instanceof ProviderError
    ? { status: "failed", code: error.code, retryable: error.retryable, externalReference: error.externalReference ?? null, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }
    : { status: "failed", code: "UNEXPECTED_ERROR", retryable: false };
  console.error(JSON.stringify(report));
  process.exitCode = error instanceof ProviderError && error.code === "NOT_CONFIGURED" ? 2 : 1;
}

export async function boundedJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) throw new ProviderError("UPSTREAM_ERROR", "Read-only provider request failed", true);
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("PROTOCOL_ERROR", "Provider response has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1_000_000) throw new ProviderError("PROTOCOL_ERROR", "Provider metadata exceeds the size limit");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel(); }
}
