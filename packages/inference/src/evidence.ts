import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";

export type EvidenceStatus = "verified" | "unverified" | "failed" | "unsupported";
export interface VerifiedInferenceEvidence {
  status: "verified";
  completionId: string;
  signatureKind: "provider_tee";
  checks: readonly ["gateway_attestation", "model_attestation", "gateway_tls_binding", "response_signature"];
  e2ee: true;
  tcbPolicy: "UpToDate";
}

/** Accept only the narrow evidence contract produced by the SDK verification worker. */
export function assertVerifiedEvidence(value: unknown, completionId: string): asserts value is VerifiedInferenceEvidence {
  if (!isObject(value) || value.status !== "verified" || value.completionId !== completionId ||
      value.signatureKind !== "provider_tee" || value.e2ee !== true || value.tcbPolicy !== "UpToDate" ||
      !Array.isArray(value.checks) || value.checks.join(",") !== "gateway_attestation,model_attestation,gateway_tls_binding,response_signature") {
    throw new ProviderError("VERIFICATION_FAILED", "Required model-bound inference evidence is absent or invalid");
  }
}
