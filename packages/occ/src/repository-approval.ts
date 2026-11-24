import { createHash } from "node:crypto";
import type {
  AdmittedRepositoryBinding,
  RepositoryApprovalScope,
  RepositoryPolicyDriver,
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

/** A scope describes authority only when the current policy explicitly permits it. */
export function eligibleRepositoryApprovalScope(
  driver: RepositoryPolicyDriver,
  input: { namespaceId: string; binding: AdmittedRepositoryBinding },
): RepositoryApprovalScope | undefined {
  if (driver.allowsStandingApproval?.(input) !== true) {
    return undefined;
  }
  return driver.standingApprovalScope?.(input);
}

/**
 * Standing repository approval refusals. Agent update and deploy raise them after
 * the caller's grant on the Agent; approving needs Agent administer. None names an approval ID
 * or a repository, so a caller without Agent administer learns only that an approval blocks.
 */
export const STANDING_APPROVAL_REFUSALS = Object.freeze({
  bindingLocked:
    "A standing repository approval holds this Agent's repository binding, so the binding cannot change. Remove the approval first (this needs Agent administer on the Agent), then save again.",
  oneBinding:
    "A standing repository approval needs exactly one repository binding on the Agent. Keep one binding, then approve again.",
  notPermitted:
    "Team policy does not permit this standing approval: it must last until removed and name one of the Agent's repository bindings that the Installation allows standing approval for. Ask an Installation administrator to allow it.",
  scopeChanged:
    "The standing approval scope changed since you reviewed it. Read the current scope from repository-approval-scopes, review it, then approve again with its scopeFingerprint as expectedScopeFingerprint.",
  deployOneBinding:
    "This Agent has a standing repository approval but not exactly one repository binding. Keep one binding, or remove the approval (this needs Agent administer on the Agent), then deploy again.",
  policyChanged:
    "This Agent's standing repository approval no longer matches team policy. Remove it (this needs Agent administer on the Agent) and approve the current scope again, or deploy after an Installation administrator restores the policy.",
});
