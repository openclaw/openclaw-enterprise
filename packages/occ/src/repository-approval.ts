import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AdmittedRepositoryBinding,
  RepositoryApprovalScope,
  RepositoryCredentialResolution,
  RepositoryPolicyDriver,
  RepositoryRevisionState,
} from "@openclaw-enterprise/contracts";
import { ResourceStateConflictError } from "./errors.ts";
import type { RepositorySessionReadRepository } from "./ports/repository-sessions.ts";

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

export async function repositoryCredentialsWithStandingApproval(
  sessions: Pick<RepositorySessionReadRepository, "findStandingApproval" | "listStandingApprovals">,
  { namespaceId, agentId }: { namespaceId: string; agentId: string },
  credentials: RepositoryRevisionState | undefined,
  resolveBinding: (binding: AdmittedRepositoryBinding) => {
    readonly driver: RepositoryPolicyDriver;
    readonly resolution: RepositoryCredentialResolution;
  },
): Promise<RepositoryRevisionState | undefined> {
  if (credentials?.bindings.length !== 1) {
    const approvals = await sessions.listStandingApprovals(namespaceId, agentId);
    if (approvals.some((approval) => !approval.revokedAt)) {
      throw new ResourceStateConflictError(
        "This Agent has a standing repository approval but not exactly one repository binding. Keep one binding, or remove the approval (this needs Agent administer on the Agent), then deploy again.",
      );
    }
    return credentials;
  }
  const binding = credentials.bindings[0]!;
  const approval = await sessions.findStandingApproval(namespaceId, agentId, binding.repositoryRef);
  if (!approval) {
    return credentials;
  }
  const resolved = resolveBinding(binding);
  const scope = eligibleRepositoryApprovalScope(resolved.driver, { namespaceId, binding });
  if (
    !scope ||
    !isDeepStrictEqual(resolved.resolution.bindings[0], binding) ||
    !isDeepStrictEqual(approval.binding, binding) ||
    !isDeepStrictEqual(approval.scope, scope)
  ) {
    throw new ResourceStateConflictError(
      "This Agent's standing repository approval no longer matches team policy. Remove it (this needs Agent administer on the Agent) and approve the current scope again, or deploy after an Installation administrator restores the policy.",
    );
  }
  return {
    ...credentials,
    standingApprovalId: approval.id,
    standingApprovalGeneration: approval.generation,
    standingApprovalScopeFingerprint: approval.scopeFingerprint,
  };
}
