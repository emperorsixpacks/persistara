export type ProviderErrorCode =
  | "NOT_CONFIGURED" | "INVALID_INPUT" | "NETWORK_MISMATCH" | "UPSTREAM_ERROR"
  | "INTEGRITY_FAILED" | "VERIFICATION_FAILED" | "UNSUPPORTED"
  | "TIMEOUT" | "ABORTED" | "OUTCOME_UNKNOWN" | "PROTOCOL_ERROR";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable = false,
    readonly externalReference?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface CallOptions { signal?: AbortSignal; timeoutMs?: number }
export interface WorkerProgress { type: "progress"; stage: "prepared" | "submitted" | "completion"; reference: string }
export interface WorkerOptions extends CallOptions {
  effect: "read" | "may-charge";
  onProgress?: (event: WorkerProgress) => void;
}
export type WorkerExecutor = (module: URL, request: unknown, options: WorkerOptions) => Promise<unknown>;

export function validateDeadline(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ProviderError("INVALID_INPUT", "Provider deadline must be between 1 and 300000 milliseconds");
  }
}
