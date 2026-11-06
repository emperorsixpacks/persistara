/** Adapted from Sofer packages/core/src/brain/types.ts; see NOTICE and provenance. */
export interface JsonObjectSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
}

/** Baseline declaration retained for selective migration; not a privileged runtime API. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}

export type ToolOutcome =
  | { status: "succeeded"; operationId: string; data: unknown }
  | { status: "failed"; operationId: string; code: string; retryable: boolean }
  | { status: "pending"; operationId: string; externalReference: string };
