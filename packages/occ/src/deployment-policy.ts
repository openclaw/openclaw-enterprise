import { prepareComputeRevision } from "./deployment-revision.ts";

import {
  freezeAgentRevision,
  type Agent,
  type AgentRevision,
  type Configuration,
  type ComputeDriver,
  type SandboxDriver,
} from "@openclaw-enterprise/contracts";

import {
  RepositoryPolicyDeploymentConflict,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";

export type ConfigurationOwnership = Readonly<
  Pick<Configuration, "id" | "namespaceId" | "kind" | "generation" | "secretBindings" | "createdAt">
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

export function soleHarnessSource(agent: Readonly<Agent>) {
  const auth = agent.harnessAuth;
  return auth?.method === "credential_source" &&
    agent.credentialSources?.length === 1 &&
    agent.credentialSources[0]?.sourceId === auth.sourceId
    ? auth.sourceId
    : undefined;
}

function unsupportedComputeRepositoryPolicy(): ResourceStateConflictError {
  return new RepositoryPolicyDeploymentConflict("incompatible_compute");
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
            await Reflect.apply(validate, sandbox, [revision]);
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
        await Reflect.apply(validate, compute, [protectedRevision ?? freezeAgentRevision(draft)]);
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
      return prepareComputeRevision(compute, draft);
    },
  };
}

function admitProtectedComputeRevision(
  compute: ComputeDriver,
  draft: AgentRevision,
): Readonly<AgentRevision> {
  try {
    return prepareComputeRevision(compute, draft);
  } catch {
    // Driver diagnostics may contain private runtime configuration.
    throw unsupportedComputeRepositoryPolicy();
  }
}
