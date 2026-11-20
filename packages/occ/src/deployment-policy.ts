import { isDeepStrictEqual } from "node:util";
import {
  admitRepositoryNetworkPolicy,
  admitSandboxRepositoryNetworkPolicy,
  ConfigurationValidationError,
  freezeAgentRevision,
  RepositoryNetworkPolicyAdmissionError,
  validateSandboxNetworkGrants,
  type AgentRevision,
  type ComputeDriver,
  type RepositoryNetworkGrant,
  type RepositoryNetworkPolicyCeiling,
  type SandboxDriver,
  type SandboxNetworkGrant,
  type SandboxPolicySnapshot,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  ConfigurationHarnessError,
  ResourceStateConflictError,
  SandboxNetworkPolicyConflictError,
} from "./errors.ts";

export const GATEWAY_MANAGED_MODE_UNSUPPORTED =
  "Agent setting gatewayManagedMode is not supported by the selected Compute Driver.";

type RepositoryPolicyOwner = {
  readonly admission?:
    | {
        readonly policy: {
          repositoryNetworkPolicyAllows?(input: {
            readonly namespaceId: string;
            readonly grant: RepositoryNetworkGrant;
          }): boolean;
        };
      }
    | undefined;
  unchanged(): boolean;
};

interface RepositoryPolicyAdmission {
  readonly sandboxPolicy: SandboxPolicySnapshot | undefined;
  readonly repositoryOwner: RepositoryPolicyOwner | undefined;
}

export function admitDeploymentRepositoryPolicy(
  sandboxPolicy: SandboxPolicySnapshot | undefined,
  grants: readonly RepositoryNetworkGrant[] | undefined,
  context: {
    readonly ceiling: RepositoryNetworkPolicyCeiling;
    readonly sandbox: SandboxDriver | undefined;
    readonly namespaceId: string;
    readonly repositoryOwner: () => RepositoryPolicyOwner | undefined;
  },
): RepositoryPolicyAdmission {
  if (grants === undefined) {
    return { sandboxPolicy, repositoryOwner: undefined };
  }
  const { ceiling, sandbox, namespaceId } = context;
  try {
    const requested = admitRepositoryNetworkPolicy(grants, ceiling);
    const requiresOwner = requested !== undefined && requested.grants.length > 0;
    const repositoryOwner = requiresOwner ? context.repositoryOwner() : undefined;
    const namespacePolicy = repositoryOwner?.admission?.policy;
    if (
      requiresOwner &&
      (!requested.grants.every(
        (grant) =>
          namespacePolicy?.repositoryNetworkPolicyAllows?.({ namespaceId, grant }) === true,
      ) ||
        !repositoryOwner?.unchanged())
    ) {
      throw new ResourceStateConflictError(
        "Cannot verify Namespace repository network grants. Review the Installation repository policy before deploying.",
      );
    }
    if (sandboxPolicy === undefined) {
      throw new RepositoryNetworkPolicyAdmissionError(
        "UNSUPPORTED_POLICY",
        "/repositoryNetworkPolicy",
        "Select a Sandbox Driver that supports repository network policy.",
      );
    }
    return {
      sandboxPolicy: admitSandboxRepositoryNetworkPolicy(sandboxPolicy, grants, ceiling, sandbox),
      repositoryOwner,
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

export function defaultDeploymentSandboxPolicy(
  sandbox: SandboxDriver | undefined,
  version: number,
  protectedExecution: boolean,
  harness: AgentRevision["harness"],
  scope: { readonly repositoryCredentials: boolean },
): SandboxPolicySnapshot | undefined {
  if (protectedExecution) {
    return harness.id === "codex" && harness.mode === "dedicated" && scope.repositoryCredentials
      ? checkedProtectedCodexArtifactPolicy(sandbox, version)
      : undefined;
  }
  if (sandbox?.admitNetworkPolicy === undefined) {
    return undefined;
  }
  return checkedSandboxPolicySnapshot(sandbox, [], version, undefined, scope);
}

export function unsupportedComputeRepositoryPolicy(): ResourceStateConflictError {
  return new ResourceStateConflictError(
    "The selected Compute Driver cannot enforce this Agent's repository network policy with the selected Sandbox Driver and Harness.",
    [{ path: "/repositoryNetworkPolicy", code: "INVALID_VALUE" }],
  );
}

export function admitComputeRevision(
  compute: ComputeDriver,
  revisionDraft: AgentRevision,
): Readonly<AgentRevision> {
  if (revisionDraft.gatewayManagedMode === true && compute.supportsGatewayManagedMode !== true) {
    throw new ConfigurationHarnessError(GATEWAY_MANAGED_MODE_UNSUPPORTED);
  }
  const draft = freezeAgentRevision(revisionDraft);
  const computeAdmission = compute.admitRevision?.(draft);
  const admittedDraft = freezeAgentRevision({
    ...draft,
    compute: {
      ...draft.compute,
      ...(computeAdmission === undefined ? {} : { admission: computeAdmission }),
    },
  });
  const runtimeInputs = compute.snapshotRuntimeInputs?.(admittedDraft);
  return freezeAgentRevision({
    ...admittedDraft,
    compute: {
      ...admittedDraft.compute,
      ...(runtimeInputs === undefined ? {} : { runtimeInputs }),
    },
  });
}

export function checkedSandboxPolicySnapshot(
  driver: SandboxDriver,
  additions: readonly SandboxNetworkGrant[],
  version: number,
  defaults?: SandboxPolicySnapshot["defaults"],
  scope?: { readonly repositoryCredentials: boolean },
  producer?: () => SandboxPolicySnapshot,
): SandboxPolicySnapshot {
  const refused = () =>
    new ResourceStateConflictError(
      "The Sandbox Driver cannot enforce the complete requested policy.",
      [
        {
          path: "",
          code: "INVALID_VALUE",
          message: "The selected Driver could not validate the configuration.",
        },
      ],
    );
  let returned: SandboxPolicySnapshot;
  try {
    returned =
      producer === undefined
        ? driver.admitNetworkPolicy!(immutableCopy(additions), version, defaults, scope)
        : producer();
  } catch (error) {
    // Preserve structured producer diagnostics; unknown exceptions (including null)
    // fail immediately, without retrying or inspecting their contents.
    throw error instanceof ConfigurationValidationError ||
      error instanceof SandboxNetworkPolicyConflictError
      ? error
      : refused();
  }
  try {
    // Detach once before inspecting: a Driver may return mutable data or accessors.
    // OCC owns the exact ordered grants; the Driver still owns opaque defaults.
    // Repository ACLs require separate admission against the Installation ceiling.
    const snapshot = immutableCopy(returned);
    validateSandboxNetworkGrants(snapshot?.additions);
    if (
      snapshot.driverId !== driver.id ||
      snapshot.implementation !== driver.implementation ||
      snapshot.version !== version ||
      snapshot.defaults === null ||
      typeof snapshot.defaults !== "object" ||
      Array.isArray(snapshot.defaults) ||
      !isDeepStrictEqual(snapshot.additions, additions) ||
      Object.hasOwn(snapshot, "repositoryNetworkPolicy")
    ) {
      throw refused();
    }
    return snapshot;
  } catch {
    // Never include unknown Driver-returned values or exceptions in diagnostics.
    throw refused();
  }
}

function checkedProtectedCodexArtifactPolicy(
  driver: SandboxDriver | undefined,
  version: number,
): SandboxPolicySnapshot {
  if (driver?.admitProtectedCodexArtifactPolicy === undefined) {
    throw new ResourceStateConflictError(
      "Deploy requires a Sandbox Driver that supports protected Codex artifact admission. Ask your Installation administrator to check drivers.sandbox and the selected Driver version.",
    );
  }
  return checkedSandboxPolicySnapshot(driver, [], version, undefined, undefined, () => {
    const result = immutableCopy(driver.admitProtectedCodexArtifactPolicy!(version));
    const names = result?.declaredRuleNames;
    if (
      result?.purpose !== "protected-codex-artifacts" ||
      !isDeepStrictEqual(Object.keys(result).sort(), [
        "declaredRuleNames",
        "purpose",
        "snapshot",
      ]) ||
      !Array.isArray(names) ||
      names.some((name) => typeof name !== "string" || name.length === 0) ||
      new Set(names).size !== names.length ||
      !isDeepStrictEqual(Object.keys(result.snapshot).sort(), [
        "additions",
        "defaults",
        "driverId",
        "implementation",
        "version",
      ]) ||
      !isDeepStrictEqual([...names].sort(), Object.keys(result.snapshot.defaults).sort())
    ) {
      throw new ResourceStateConflictError(
        "The Sandbox Driver did not acknowledge the exact artifact declaration.",
      );
    }
    return result.snapshot;
  });
}
