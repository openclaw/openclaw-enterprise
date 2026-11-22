import {
  admitRepositoryNetworkPolicy,
  admitSandboxRepositoryNetworkPolicy,
  RepositoryNetworkPolicyAdmissionError,
  type RepositoryNetworkGrant,
  type RepositoryNetworkPolicyCeiling,
  type SandboxDriver,
  type SandboxPolicySnapshot,
} from "@openclaw-enterprise/contracts";
import { ResourceStateConflictError } from "./errors.ts";
import { RepositoryPolicyDeploymentConflict } from "./repository-network-policy.ts";

export function admitDeploymentRepositoryPolicy(
  sandboxPolicy: SandboxPolicySnapshot | undefined,
  grants: readonly RepositoryNetworkGrant[] | undefined,
  ceiling: RepositoryNetworkPolicyCeiling,
  sandbox: SandboxDriver | undefined,
  requireOwner: (grants: readonly RepositoryNetworkGrant[]) => () => boolean,
) {
  if (grants === undefined) {
    return { sandboxPolicy, ownerUnchanged: undefined };
  }
  try {
    const requested = admitRepositoryNetworkPolicy(grants, ceiling);
    const ownerUnchanged = requested?.grants.length ? requireOwner(requested.grants) : undefined;
    if (sandboxPolicy === undefined) {
      throw new RepositoryNetworkPolicyAdmissionError(
        "UNSUPPORTED_POLICY",
        "/repositoryNetworkPolicy",
        "Select a Sandbox Driver that supports repository network policy.",
      );
    }
    return {
      sandboxPolicy: admitSandboxRepositoryNetworkPolicy(sandboxPolicy, grants, ceiling, sandbox),
      ownerUnchanged,
    };
  } catch (error) {
    if (!(error instanceof RepositoryNetworkPolicyAdmissionError)) {
      throw error;
    }
    throw new ResourceStateConflictError(error.message, [
      {
        path: error.path,
        code: error.code === "UNSUPPORTED_POLICY" ? "INVALID_VALUE" : error.code,
        message: error.message,
      },
    ]);
  }
}
export function unsupportedComputeRepositoryPolicy(): ResourceStateConflictError {
  return new RepositoryPolicyDeploymentConflict("incompatible_compute");
}
