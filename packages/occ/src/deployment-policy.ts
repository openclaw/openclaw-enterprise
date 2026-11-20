import { isDeepStrictEqual } from "node:util";
import {
  assertExecutionAdmission,
  ConfigurationValidationError,
  freezeAgentRevision,
  validateSandboxNetworkGrants,
  type Agent,
  type AgentRevision,
  type OpenClawConfigurationDocument,
  type ComputeDriver,
  type ProxyPlan,
  type SandboxDriver,
  type SandboxNetworkGrant,
  type SandboxPolicy,
  type SandboxPolicySnapshot,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";
import {
  ConfigurationHarnessError,
  ResourceStateConflictError,
  SandboxNetworkPolicyConflictError,
  ScopeViolationError,
} from "./errors.ts";

import type { PlatformReadView } from "./state/platform-state.ts";

export const GATEWAY_MANAGED_MODE_UNSUPPORTED =
  "Agent setting gatewayManagedMode is not supported by the selected Compute Driver.";

export function deploymentExecution(
  egressPlan: ProxyPlan | undefined,
): Pick<AgentRevision, "executionAdmission" | "egressPlan"> {
  const execution: Pick<AgentRevision, "executionAdmission" | "egressPlan"> =
    egressPlan === undefined
      ? { executionAdmission: { version: 2, mode: "unprotected" } }
      : {
          executionAdmission: { version: protectedExecutionVersion(egressPlan), mode: "protected" },
          egressPlan,
        };
  assertExecutionAdmission(execution);
  return execution;
}

function protectedExecutionVersion(plan: ProxyPlan): 3 | 4 | 5 | 6 | 7 {
  if (plan.repositoryGit && plan.policyReductionVersion === 2) {
    return 7;
  }
  if (plan.repositoryGitAuthorization === "request-hook-observed") {
    return 6;
  }
  if (plan.repositoryGitAuthorization === "online-request") {
    return 5;
  }
  return plan.repositoryGit ? 4 : 3;
}

// Only a validated, unprotected revision can accept a live policy application.
export function unprotectedPolicyRevision(revision: Readonly<AgentRevision> | undefined): boolean {
  if (revision?.executionAdmission?.mode !== "unprotected") {
    return false;
  }
  try {
    assertExecutionAdmission(revision);
    return true;
  } catch {
    return false;
  }
}

// Whether the Configuration selects a model for the default or any roster entry.
export function selectsModel(values: Readonly<OpenClawConfigurationDocument>): boolean {
  const agents = asRecord(values.agents);
  return [asRecord(agents?.defaults), ...Object.values(asRecord(agents?.entries) ?? {})].some(
    (entry) => asRecord(entry)?.model !== undefined,
  );
}

export type ConfigurationOwnership = NonNullable<
  Awaited<ReturnType<PlatformReadView["configurations"]["findConfiguration"]>>
>;

export function assertAgentConfiguration(
  metadata: ConfigurationOwnership | undefined,
  namespaceId: string,
  id: string,
): asserts metadata is ConfigurationOwnership {
  if (metadata?.kind !== "agent" || metadata.namespaceId !== namespaceId || metadata.id !== id) {
    throw new ScopeViolationError(
      "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
    );
  }
}

export function activePolicyRevision(
  revisions: PlatformReadView["revisions"],
  agent: Readonly<Agent>,
) {
  return agent.activeRevisionId === undefined
    ? undefined
    : revisions.findRevision(agent.namespaceId, agent.id, agent.activeRevisionId);
}

export function editableSandboxPolicy(
  agent: Readonly<Agent> | undefined,
  previous: Readonly<SandboxPolicy> | undefined,
  expectedVersion: number,
) {
  if (agent?.status !== "active" || agent.sandboxPolicyEditing !== true) {
    throw new ResourceStateConflictError("Policy editing is disabled for this Agent.");
  }
  if (
    previous === undefined ||
    previous.version !== expectedVersion ||
    previous.application?.state === "pending"
  ) {
    throw new ResourceStateConflictError(
      "The policy changed or an application is still pending. Reload before editing.",
    );
  }
  return { agent, previous };
}

export function soleHarnessSource(agent: Readonly<Agent>) {
  const auth = agent.harnessAuth;
  return auth?.method === "credential_source" &&
    agent.credentialSources?.length === 1 &&
    agent.credentialSources[0]?.sourceId === auth.sourceId
    ? auth.sourceId
    : undefined;
}

type SandboxPolicyAdmissionDriver = Pick<
  SandboxDriver,
  "id" | "implementation" | "admitNetworkPolicy" | "admitProtectedCodexArtifactPolicy"
>;

export function defaultDeploymentSandboxPolicy(
  sandbox: SandboxPolicyAdmissionDriver | undefined,
  version: number,
  protectedExecution: boolean,
  harness: Pick<AgentRevision["harness"], "id" | "mode">,
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

function unsupportedComputeRepositoryPolicy(): ResourceStateConflictError {
  return new ResourceStateConflictError(
    "The selected Compute Driver cannot enforce this Agent's repository network policy with the selected Sandbox Driver and Harness.",
    [{ path: "/repositoryNetworkPolicy", code: "INVALID_VALUE" }],
  );
}

function unsupportedProtectedRepositoryPolicy(): ResourceStateConflictError {
  return new ResourceStateConflictError(
    "Protected execution cannot enforce the saved repository network policy. Review the policy and execution mode before deploying.",
  );
}

export function bindProtectedRepositoryPolicySandbox(
  compute: ComputeDriver,
  sandbox: SandboxDriver | undefined,
) {
  try {
    const admit = sandbox?.admitRepositoryNetworkPolicy;
    const validate = sandbox?.validateProtectedRepositoryNetworkPolicy;
    if (
      sandbox !== undefined &&
      typeof compute.validateProtectedRepositoryNetworkPolicy === "function" &&
      typeof admit === "function" &&
      typeof validate === "function"
    ) {
      return {
        driver: {
          id: sandbox.id,
          implementation: sandbox.implementation,
          admitRepositoryNetworkPolicy: admit.bind(sandbox),
        },
        unchanged() {
          try {
            return (
              sandbox.admitRepositoryNetworkPolicy === admit &&
              sandbox.validateProtectedRepositoryNetworkPolicy === validate
            );
          } catch {
            return false;
          }
        },
        async validate(revision: Readonly<AgentRevision>) {
          try {
            await validate.call(sandbox, revision);
          } catch {
            throw new ResourceStateConflictError(
              "The selected Sandbox Driver cannot enforce the saved repository network policy on this revision.",
              [{ path: "/repositoryNetworkPolicy", code: "INVALID_VALUE" }],
            );
          }
        },
      };
    }
  } catch {
    // Driver diagnostics may contain private runtime configuration.
  }
  throw unsupportedProtectedRepositoryPolicy();
}

export function computeRepositoryPolicyAdmission(
  compute: ComputeDriver,
  protectedSandbox?: ReturnType<typeof bindProtectedRepositoryPolicySandbox>,
) {
  const validate = compute.validateProtectedRepositoryNetworkPolicy;
  if (typeof validate !== "function") {
    throw unsupportedComputeRepositoryPolicy();
  }
  const unchanged = () => {
    try {
      return (
        compute.validateProtectedRepositoryNetworkPolicy === validate &&
        protectedSandbox?.unchanged() !== false
      );
    } catch {
      return false;
    }
  };
  return {
    unchanged,
    async admit(
      draft: AgentRevision,
      assertDriversCurrent: () => void,
    ): Promise<Readonly<AgentRevision>> {
      // Protected topology admission includes the captured immutable runtime inputs.
      const protectedRevision =
        draft.executionAdmission.mode === "protected"
          ? admitProtectedComputeRevision(compute, draft)
          : undefined;
      assertDriversCurrent();
      try {
        await validate.call(compute, protectedRevision ?? freezeAgentRevision(draft));
      } catch {
        throw unsupportedComputeRepositoryPolicy();
      }
      assertDriversCurrent();
      if (protectedRevision !== undefined) {
        if (protectedSandbox === undefined) {
          throw unsupportedProtectedRepositoryPolicy();
        }
        await protectedSandbox.validate(protectedRevision);
        assertDriversCurrent();
        return protectedRevision;
      }
      return admitComputeRevision(compute, draft);
    },
  };
}

function admitProtectedComputeRevision(
  compute: ComputeDriver,
  draft: AgentRevision,
): Readonly<AgentRevision> {
  try {
    return admitComputeRevision(compute, draft);
  } catch {
    // Driver diagnostics may contain private runtime configuration.
    throw unsupportedComputeRepositoryPolicy();
  }
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

export function sandboxPolicyRefused(): ResourceStateConflictError {
  return new ResourceStateConflictError(
    "The Sandbox Driver cannot enforce the complete requested policy.",
    [
      {
        path: "",
        code: "INVALID_VALUE",
        message: "The selected Driver could not validate the configuration.",
      },
    ],
  );
}

function produceSandboxPolicy(produce: () => SandboxPolicySnapshot): SandboxPolicySnapshot {
  try {
    return produce();
  } catch (error) {
    // Preserve structured producer diagnostics; unknown exceptions (including null)
    // fail immediately, without retrying or inspecting their contents.
    throw error instanceof ConfigurationValidationError ||
      error instanceof SandboxNetworkPolicyConflictError
      ? error
      : sandboxPolicyRefused();
  }
}

export function checkedSandboxPolicySnapshot(
  driver: SandboxPolicyAdmissionDriver,
  additions: readonly SandboxNetworkGrant[],
  version: number,
  defaults?: SandboxPolicySnapshot["defaults"],
  scope?: { readonly repositoryCredentials: boolean },
  produce = () => driver.admitNetworkPolicy!(immutableCopy(additions), version, defaults, scope),
): SandboxPolicySnapshot {
  const returned = produceSandboxPolicy(produce);
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
      throw sandboxPolicyRefused();
    }
    return snapshot;
  } catch {
    // Never include unknown Driver-returned values or exceptions in diagnostics.
    throw sandboxPolicyRefused();
  }
}

function checkedProtectedCodexArtifactPolicy(
  driver: SandboxPolicyAdmissionDriver | undefined,
  version: number,
): SandboxPolicySnapshot {
  const admit = (() => {
    try {
      return driver?.admitProtectedCodexArtifactPolicy;
    } catch {
      throw sandboxPolicyRefused();
    }
  })();
  if (driver === undefined || typeof admit !== "function") {
    throw new ResourceStateConflictError(
      "Deploy requires a Sandbox Driver that supports protected Codex artifact admission. Ask your Installation administrator to check drivers.sandbox and the selected Driver version.",
    );
  }
  return checkedSandboxPolicySnapshot(driver, [], version, undefined, undefined, () => {
    const result = (() => {
      try {
        return immutableCopy(Reflect.apply(admit, driver, [version]));
      } catch {
        // Protected admission never publishes Driver diagnostics, even for typed errors.
        throw sandboxPolicyRefused();
      }
    })();
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
