import { fork, type Serializable } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isObject } from "./memory.js";
import { ProviderError, validateDeadline, type ProviderErrorCode, type WorkerExecutor } from "./providers.js";

const knownCodes = new Set<ProviderErrorCode>(["NOT_CONFIGURED", "INVALID_INPUT", "NETWORK_MISMATCH", "UPSTREAM_ERROR", "INTEGRITY_FAILED", "VERIFICATION_FAILED", "UNSUPPORTED", "OUTCOME_UNKNOWN", "PROTOCOL_ERROR"]);

function wireSize(value: unknown): number {
  let bytes = 0;
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) { bytes += item.byteLength; return { binaryBytes: item.byteLength }; }
    return item;
  });
  return bytes + Buffer.byteLength(json ?? "");
}

/** SDKs cannot outlive a timed-out call. Child stdout/stderr and environment are not forwarded. */
export const executeWorker: WorkerExecutor = async (module, request, options) => {
  const timeoutMs = options.timeoutMs ?? 60_000;
  validateDeadline(timeoutMs);
  if (options.signal?.aborted) throw new ProviderError("ABORTED", "Provider call was canceled before dispatch");
  if (wireSize(request) > 2_500_000) throw new ProviderError("INVALID_INPUT", "Provider request is too large");
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(module), [], {
      execPath: process.execPath,
      execArgv: ["--max-old-space-size=128"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      env: {},
    });
    let done = false;
    let dispatched = false;
    let externalReference: string | undefined;
    const finish = (error?: ProviderError, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      if (error) reject(error); else resolve(value);
    };
    const interrupted = (reason: "TIMEOUT" | "ABORTED" | "UPSTREAM_ERROR") => {
      const unknown = dispatched && options.effect === "may-charge";
      finish(new ProviderError(
        unknown ? "OUTCOME_UNKNOWN" : reason,
        unknown ? "Provider outcome is unknown; reconcile the recorded reference before retrying" : "Provider call did not complete",
        !unknown && reason !== "ABORTED",
        externalReference,
      ));
    };
    const abort = () => interrupted("ABORTED");
    const timer = setTimeout(() => interrupted("TIMEOUT"), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    child.on("message", (message: unknown) => {
      if (!isObject(message)) { finish(new ProviderError("PROTOCOL_ERROR", "Invalid provider worker response")); return; }
      if (message.type === "progress") {
        if (!["prepared", "submitted", "completion"].includes(String(message.stage)) ||
            typeof message.reference !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(message.reference)) {
          finish(new ProviderError("PROTOCOL_ERROR", "Invalid provider progress reference")); return;
        }
        externalReference = message.reference;
        try {
          options.onProgress?.({ type: "progress", stage: message.stage as "prepared" | "submitted" | "completion", reference: message.reference });
        } catch { interrupted("UPSTREAM_ERROR"); }
        return;
      }
      if (message.type !== "result" || typeof message.ok !== "boolean") {
        finish(new ProviderError("PROTOCOL_ERROR", "Invalid provider result envelope")); return;
      }
      if (message.ok) {
        if (wireSize(message.value) > 2_500_000) {
          finish(new ProviderError("PROTOCOL_ERROR", "Provider response exceeds its size limit")); return;
        }
        finish(undefined, message.value);
      } else {
        const code = knownCodes.has(message.code as ProviderErrorCode) ? message.code as ProviderErrorCode : "UPSTREAM_ERROR";
        finish(new ProviderError(code, `Provider operation failed (${code})`, code === "UPSTREAM_ERROR" && options.effect === "read", externalReference));
      }
    });
    child.on("error", () => interrupted("UPSTREAM_ERROR"));
    child.on("exit", () => { if (!done) interrupted("UPSTREAM_ERROR"); });
    // Once handed to the process, a crash may conceal a charge even before progress arrives.
    dispatched = true;
    child.send(request as Serializable, (error) => { if (error) interrupted("UPSTREAM_ERROR"); });
  });
};

/** Child boundary deliberately emits no SDK exception messages, prompts, or credentials. */
export function reply(value: unknown): void {
  process.send?.({ type: "result", ok: true, value }, undefined, undefined, () => process.exit(0));
}
export function fail(code: ProviderErrorCode): void {
  process.send?.({ type: "result", ok: false, code }, undefined, undefined, () => process.exit(1));
}
export function progress(stage: "prepared" | "submitted" | "completion", reference: string): void {
  process.send?.({ type: "progress", stage, reference });
}
