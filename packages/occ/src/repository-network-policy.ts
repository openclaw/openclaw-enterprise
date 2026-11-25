import { types } from "node:util";
import {
  admitRepositoryNetworkPolicy,
  admitSandboxRepositoryNetworkPolicy,
  assertExecutionAdmission,
  RepositoryNetworkPolicyAdmissionError,
  type RepositoryApiMaximum,
  type AgentRevisionRead,
  type IAMDriver,
  type RepositoryCredentialResolution,
  type RepositoryNetworkGrant,
  type RepositoryNetworkPolicyCeiling,
  type SandboxDriver,
  type SandboxPolicySnapshot,
} from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  RepositoryPolicyDeploymentConflict,
  ResourceStateConflictError,
} from "./errors.ts";

export type RepositoryGrantPolicy = {
  repositoryNetworkPolicyAllows?(input: {
    readonly namespaceId: string;
    readonly grant: RepositoryNetworkGrant;
  }): boolean;
};

export type RepositoryPolicyResolution = RepositoryCredentialResolution & {
  /** The selected credential has restrictions that only the native network policy can enforce. */
  readonly requiresNetworkPolicy?: boolean;
  /** The selected registry permits deployment-scoped Git when the Agent saves an ACL. */
  readonly nativeGit?: "v1";
  /** Eligible native API levels, before the Agent narrows access. */
  readonly repositoryApiMaxima?: readonly RepositoryApiMaximum[];
  /** The network access of these resolved bindings. The Namespace ceiling is independent. */
  readonly selectedRepositoryNetworkGrants?: RepositoryNetworkPolicyCeiling;
};

/** Match an operator ceiling for an editable selection before GitHub verifies its owner. */
export function repositoryNetworkLimitForSelection(
  ceiling: RepositoryNetworkPolicyCeiling,
  repository: string,
  allowShortNameMatch: boolean,
): RepositoryNetworkGrant | undefined {
  const isQualified = repository.includes("/");
  const shortName = repository.slice(repository.indexOf("/") + 1);
  const matching = ceiling.filter(
    ({ repository: limit }) =>
      limit === repository ||
      (allowShortNameMatch &&
        !(isQualified && limit.includes("/")) &&
        limit.slice(limit.indexOf("/") + 1) === shortName),
  );
  const qualified = matching.filter(({ repository: limit }) => limit.includes("/"));
  if (!matching.length || qualified.length > 1) {
    return undefined;
  }
  return {
    repository: qualified[0]?.repository ?? repository,
    access: matching.every(({ access }) => access === "write") ? "write" : "read",
  };
}

type RepositoryGrantMethod = NonNullable<RepositoryGrantPolicy["repositoryNetworkPolicyAllows"]>;

function repositoryGrantMethod(policy: RepositoryGrantPolicy): RepositoryGrantMethod | undefined {
  // Inspect the first definition without invoking an accessor or a Proxy trap.
  for (let owner: object | null = policy; owner; owner = Reflect.getPrototypeOf(owner)) {
    if (types.isProxy(owner)) {
      return undefined;
    }
    const descriptor: TypedPropertyDescriptor<RepositoryGrantMethod> | undefined =
      Object.getOwnPropertyDescriptor(owner, "repositoryNetworkPolicyAllows");
    if (descriptor) {
      if (!Object.hasOwn(descriptor, "value")) {
        return undefined;
      }
      const method = descriptor.value;
      return typeof method === "function" && !types.isProxy(method) ? method : undefined;
    }
  }
  return undefined;
}

type RepositoryGrantAuthority = {
  readonly allows: (grant: RepositoryNetworkGrant) => boolean;
  readonly approvesAll: (grants: readonly RepositoryNetworkGrant[]) => boolean;
  readonly unchanged: () => boolean;
};

function synchronouslyApproved(value: unknown): boolean {
  if (types.isPromise(value)) {
    // Observe a native rejection without invoking the Driver's own then method.
    void Promise.prototype.then.call(value, undefined, () => undefined);
  }
  return value === true;
}

function approves(check: () => unknown): boolean {
  try {
    return synchronouslyApproved(check());
  } catch {
    // Driver refusals can contain private configuration or binding details.
    return false;
  }
}

export function repositoryGrantAuthority(
  namespaceId: string,
  policy: RepositoryGrantPolicy | undefined,
  ownerUnchanged: (() => boolean) | undefined,
): RepositoryGrantAuthority | undefined {
  try {
    if (!policy || !ownerUnchanged?.()) {
      return undefined;
    }
    const allows = repositoryGrantMethod(policy);
    if (!allows) {
      return undefined;
    }
    const approve = (grant: RepositoryNetworkGrant) =>
      synchronouslyApproved(Reflect.apply(allows, policy, [{ namespaceId, grant }]));
    return {
      // Ceiling filtering must distinguish a denial (try read) from a throw (discard all).
      allows: approve,
      approvesAll: (grants) => approves(() => grants.every(approve)),
      unchanged: () => approves(() => ownerUnchanged() && repositoryGrantMethod(policy) === allows),
    };
  } catch {
    return undefined;
  }
}

export function delegatedRepositoryCeiling(
  ceiling: RepositoryNetworkPolicyCeiling,
  owner: RepositoryGrantAuthority | undefined,
): RepositoryNetworkPolicyCeiling {
  if (!owner) {
    return [];
  }
  try {
    const grants = ceiling.flatMap((grant) => {
      if (owner.allows(grant)) {
        return [grant];
      }
      const read = Object.freeze({ repository: grant.repository, access: "read" } as const);
      return grant.access === "write" && owner.allows(read) ? [read] : [];
    });
    return owner.unchanged() ? grants : [];
  } catch {
    // Keep saved grants readable for withdrawal if delegated approvals cannot be checked.
    return [];
  }
}

export function bindRepositoryPolicyAuthorization(current: () => IAMDriver) {
  const driver = current();
  try {
    const authorize = driver.authorize;
    if (typeof authorize === "function") {
      return {
        inputs: [driver, authorize] as const,
        assertCurrent() {
          if (!approves(() => current() === driver && driver.authorize === authorize)) {
            throw new ResourceStateConflictError(
              "The selected authorization Driver changed during repository network policy admission. Reload before editing.",
            );
          }
        },
      };
    }
  } catch {
    // A Driver method getter can contain private diagnostics.
  }
  throw new DependencyUnavailableError(
    "The selected authorization Driver could not verify the operation.",
  );
}

function selectedRepositoryGrantAllows(
  selected: RepositoryPolicyResolution | undefined,
  grant: RepositoryNetworkGrant,
): boolean {
  return (
    (!grant.apiLimits ||
      (selected?.nativeGit === "v1" &&
        selected.repositoryApiMaxima?.some((option) => option.repository === grant.repository) ===
          true)) &&
    selected?.selectedRepositoryNetworkGrants?.some(
      ({ repository, access }) =>
        repository === grant.repository && (access === grant.access || access === "write"),
    ) === true
  );
}

export function assertSelectedRepositoryGrants(
  grants: readonly RepositoryNetworkGrant[] | undefined,
  selected: RepositoryPolicyResolution | undefined,
): void {
  if (grants?.some((grant) => !selectedRepositoryGrantAllows(selected, grant))) {
    throw new ResourceStateConflictError(
      "The saved repository network policy exceeds the Agent's selected Git credential. Review the saved policy and repository bindings before deploying.",
      [{ path: "/repositoryNetworkPolicy", code: "INVALID_VALUE" }],
    );
  }
}

function refuseRepositoryPolicy(error: unknown): never {
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

export function admitDeploymentRepositoryPolicy(
  basePolicy: () => SandboxPolicySnapshot | undefined,
  grants: readonly RepositoryNetworkGrant[] | undefined,
  ceiling: RepositoryNetworkPolicyCeiling,
  sandbox:
    Pick<SandboxDriver, "id" | "implementation" | "admitRepositoryNetworkPolicy"> | undefined,
  authority: () => RepositoryGrantAuthority | undefined,
) {
  if (grants === undefined) {
    return { sandboxPolicy: basePolicy(), ownerUnchanged: undefined };
  }
  try {
    const requested = admitRepositoryNetworkPolicy(grants, ceiling)!.grants;
    const owner = requested.length ? authority() : undefined;
    const approved =
      owner && (() => owner.unchanged() && owner.approvesAll(requested) && owner.unchanged());
    if (requested.length && !approved?.()) {
      throw new ResourceStateConflictError(
        "Cannot verify Namespace repository network grants. Review the Installation repository policy before deploying.",
      );
    }
    const sandboxPolicy = basePolicy();
    if (sandboxPolicy === undefined) {
      throw new RepositoryNetworkPolicyAdmissionError(
        "UNSUPPORTED_POLICY",
        "/repositoryNetworkPolicy",
        "Select a Sandbox Driver that supports repository network policy.",
      );
    }
    return {
      sandboxPolicy: admitSandboxRepositoryNetworkPolicy(sandboxPolicy, grants, ceiling, sandbox),
      ownerUnchanged: approved,
    };
  } catch (error) {
    refuseRepositoryPolicy(error);
  }
}

// Stop cannot fence a delayed unscoped write to shared Agent resources. A
// standalone model revision had no Git authority and uses its own Sandbox.
export function supportsScopedRepositoryHistory(
  history: readonly Readonly<AgentRevisionRead>[],
  allowStandaloneModelHistory = false,
): boolean {
  return history.every((revision, index) => {
    if ("configurationReadError" in revision || revision.revision !== index + 1) {
      return false;
    }
    if (revision.sandboxPolicy?.repositoryNetworkPolicy !== undefined) {
      return true;
    }
    const bindings = revision.credentialDeployment?.bindings;
    const model = bindings?.[0];
    const auth = revision.harnessAuth;
    if (
      !allowStandaloneModelHistory ||
      revision.executionAdmission.mode !== "standalone" ||
      revision.harness.mode !== "dedicated" ||
      !revision.sandboxDriverId ||
      revision.sandboxPolicy?.driverId !== revision.sandboxDriverId ||
      revision.repositoryCredentials !== undefined ||
      bindings?.length !== 1 ||
      model?.consumer.kind !== "model" ||
      auth.method !== "credential_source" ||
      !auth.tokenServiceInstanceId ||
      model.sourceRef.id !== auth.sourceId ||
      revision.credentialSources?.some(({ sourceType }) => sourceType === "github-app-installation")
    ) {
      return false;
    }
    try {
      assertExecutionAdmission(revision);
      return true;
    } catch {
      return false;
    }
  });
}

export function assertScopedRepositoryHistory(
  history: readonly Readonly<AgentRevisionRead>[],
  allowStandaloneModelHistory = false,
): void {
  if (!supportsScopedRepositoryHistory(history, allowStandaloneModelHistory)) {
    throw new RepositoryPolicyDeploymentConflict("unscoped_history");
  }
}
