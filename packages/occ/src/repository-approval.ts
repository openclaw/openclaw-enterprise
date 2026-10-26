import { createHash } from "node:crypto";
import type {
  AdmittedRepositoryBinding,
  RepositoryApprovalScope,
} from "@openclaw-enterprise/contracts";

// Sort object keys recursively; arrays retain their provider-defined semantics.
// Reject non-JSON values rather than silently omitting security-relevant fields.
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError("Sparse approval scope arrays are invalid.");
      }
    }
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Standing approval scope must contain only canonical JSON values.");
}
export function repositoryApprovalFingerprint(input: {
  namespaceId: string;
  agentId: string;
  binding: AdmittedRepositoryBinding;
  scope: RepositoryApprovalScope;
}): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}
