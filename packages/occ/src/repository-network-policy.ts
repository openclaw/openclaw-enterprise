import { selectsModel } from "./agent-harness-topology.ts";
import { defaultDeploymentSandboxPolicy } from "./sandbox-policy-admission.ts";
import { types } from "node:util";
import {
  admitRepositoryNetworkPolicy,
  admitSandboxRepositoryNetworkPolicy,
  RepositoryNetworkPolicyAdmissionError,
  type Agent,
  type AgentRevision,
  type AgentRevisionRead,
  type Configuration,
  type StoredCredentialSource,
  type ComputeDriver,
  type HarnessDescriptor,
  type IAMDriver,
  type ProtectedRepositoryNetworkPolicySaveContext,
  type RepositoryCredentialResolution,
  type RepositoryNetworkGrant,
  type RepositoryNetworkPolicy,
  type RepositoryNetworkPolicyCeiling,
  type ResourceRef,
  type SandboxDriver,
  type SandboxPolicySnapshot,
} from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import { refuseStoredConfigurationSettings } from "./configuration-settings.ts";
import { resolveConfiguredHarnessId } from "./configured-harness.ts";
import {
  assertAgentConfiguration,
  soleHarnessSource,
  type ConfigurationOwnership,
} from "./deployment-policy.ts";
import type { InstalledDriver } from "./installed-driver.ts";
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
  /** The selected registry permits deployment-scoped Git when the Agent saves an ACL. */
  readonly nativeGit?: "v1";
  /** The network access of these resolved bindings. The Namespace ceiling is independent. */
  readonly selectedRepositoryNetworkGrants?: RepositoryNetworkPolicyCeiling;
};

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

export async function readRepositoryEditTopology(
  agent: Readonly<Agent>,
  resolveHarness: (id: string, mode: "dedicated") => HarnessDescriptor | undefined,
  canRead: (target: ResourceRef) => Promise<boolean>,
  read: {
    configurationOwnership(id: string): Promise<ConfigurationOwnership | undefined>;
    configuration(metadata: ConfigurationOwnership): Promise<Readonly<Configuration>>;
    credentialSource(id: string): Promise<Readonly<StoredCredentialSource> | undefined>;
  },
) {
  const { namespaceId, configurationId } = agent;
  const sourceId = soleHarnessSource(agent);
  if (sourceId === undefined || agent.executionMode !== "dedicated") {
    return undefined;
  }
  const configRef = { kind: "configuration", id: configurationId, namespaceId } as const;
  const sourceRef = { kind: "credential_source", id: sourceId, namespaceId } as const;
  // Eligibility would reveal both resources. Authorize both before reading either.
  if (!(await canRead(configRef)) || !(await canRead(sourceRef))) {
    return undefined;
  }
  // Save readers lock Configuration before the credential source, as at deploy.
  const metadata = await read.configurationOwnership(configurationId);
  assertAgentConfiguration(metadata, namespaceId, configurationId);
  const { values } = await read.configuration(metadata);
  refuseStoredConfigurationSettings(values);
  if (!selectsModel(values)) {
    return undefined;
  }
  const harnessId = resolveConfiguredHarnessId(values);
  const harness = resolveHarness(harnessId, agent.executionMode);
  if (harness?.id !== harnessId || !isNonEmptyString(harness.version)) {
    return undefined;
  }
  const source = await read.credentialSource(sourceId);
  if (
    source?.state !== "ready" ||
    source.namespaceId !== namespaceId ||
    source.id !== sourceId ||
    source.ownerCapability === "token_service"
  ) {
    return undefined;
  }
  return {
    harness,
    source,
    placement: {
      namespaceId,
      agentId: agent.id,
      gatewayManagedMode: agent.gatewayManagedMode,
      configuration: values,
    },
  };
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

export function repositoryPolicySaveValidator(compute: ComputeDriver, owner: InstalledDriver) {
  const admit = compute.admitsProtectedRepositoryNetworkPolicySave;
  const supportsPlacement = compute.supportsProtectedRepositoryNetworkPolicyPlacement;
  const validateFrozen = compute.validateProtectedRepositoryNetworkPolicy;
  if (typeof admit !== "function" || typeof validateFrozen !== "function") {
    return undefined;
  }
  const sandbox = owner.require("sandbox");
  const admitArtifacts = sandbox.admitProtectedCodexArtifactPolicy;
  const admitRepository = sandbox.admitRepositoryNetworkPolicy;
  const validateSandbox = sandbox.validateProtectedRepositoryNetworkPolicy;
  if (
    typeof admitArtifacts !== "function" ||
    typeof admitRepository !== "function" ||
    typeof validateSandbox !== "function"
  ) {
    return undefined;
  }
  owner.requireRepositoryGitTransport();
  const boundSandbox = {
    id: sandbox.id,
    implementation: sandbox.implementation,
    admitProtectedCodexArtifactPolicy: (version: number) =>
      Reflect.apply(admitArtifacts, sandbox, [version]),
    admitRepositoryNetworkPolicy: (
      policy: RepositoryNetworkPolicy,
      network: SandboxPolicySnapshot,
    ) => Reflect.apply(admitRepository, sandbox, [policy, network]),
  };
  return (
    placement: NonNullable<ProtectedRepositoryNetworkPolicySaveContext["placement"]>,
    harness: HarnessDescriptor,
    source: ProtectedRepositoryNetworkPolicySaveContext["harnessCredentialSource"],
    resolution: RepositoryPolicyResolution,
    ceiling: RepositoryNetworkPolicyCeiling,
    authority: RepositoryGrantAuthority | undefined,
    version: number,
    ownersCurrent: () => boolean,
  ) => {
    // Row locks do not freeze process-local selections or their admission methods.
    const assertCurrent = (stillApproved?: () => boolean) => {
      if (
        !approves(
          () =>
            ownersCurrent() &&
            authority?.unchanged() === true &&
            stillApproved?.() !== false &&
            compute.admitsProtectedRepositoryNetworkPolicySave === admit &&
            compute.supportsProtectedRepositoryNetworkPolicyPlacement === supportsPlacement &&
            compute.validateProtectedRepositoryNetworkPolicy === validateFrozen &&
            sandbox.admitProtectedCodexArtifactPolicy === admitArtifacts &&
            sandbox.admitRepositoryNetworkPolicy === admitRepository &&
            sandbox.validateProtectedRepositoryNetworkPolicy === validateSandbox,
        )
      ) {
        throw new ResourceStateConflictError(
          "The selected Drivers changed during repository network policy admission. Reload before editing.",
        );
      }
    };
    const fitsSelected = (grant: RepositoryNetworkGrant) =>
      selectedRepositoryGrantAllows(resolution.selectedRepositoryNetworkGrants, grant);
    const dedicated = { id: harness.id, version: harness.version, mode: "dedicated" } as const;
    const { type, ownerCapability, driverId } = source;
    const topology: ProtectedRepositoryNetworkPolicySaveContext = immutableCopy({
      placement,
      ...(resolution.nativeGit && { nativeGit: resolution.nativeGit }),
      harness: dedicated,
      sandboxDriverId: boundSandbox.id,
      protectedDriver: owner.ref,
      repositoryBindings: resolution.bindings,
      harnessCredentialSource: { type, ownerCapability, driverId },
    });
    const basePolicy = () =>
      defaultDeploymentSandboxPolicy(boundSandbox, version, true, dedicated, {
        repositoryCredentials: true,
      });
    const admitEdit = (grants: readonly RepositoryNetworkGrant[]) => {
      if (authority === undefined) {
        return undefined;
      }
      assertCurrent();
      const { sandboxPolicy, ownerUnchanged } = admitDeploymentRepositoryPolicy(
        basePolicy,
        grants,
        ceiling,
        boundSandbox,
        () => authority,
        "save",
      );
      const policy = sandboxPolicy?.repositoryNetworkPolicy;
      if (!policy?.grants.every(fitsSelected)) {
        return undefined;
      }
      const assertApproved = () => assertCurrent(ownerUnchanged);
      assertApproved();
      const context = immutableCopy({ ...topology, repositoryNetworkPolicy: policy });
      if (!approves(() => Reflect.apply(admit, compute, [context]))) {
        return undefined;
      }
      assertApproved();
      return { grants: policy.grants, assertCurrent: assertApproved };
    };

    return {
      supports(delegatedCeiling: RepositoryNetworkPolicyCeiling) {
        // Admission can depend on a combination of grants. Let the editor
        // submit the complete list when the selected and delegated scopes overlap.
        if (!delegatedCeiling.some((grant) => fitsSelected({ ...grant, access: "read" }))) {
          return approves(() => admitEdit([]) !== undefined);
        }
        return approves(() => {
          assertCurrent();
          const ready =
            basePolicy() !== undefined &&
            (supportsPlacement === undefined ||
              approves(() => supportsPlacement.call(compute, topology)));
          assertCurrent();
          return ready;
        });
      },
      admit: admitEdit,
    };
  };
}

function selectedRepositoryGrantAllows(
  selected: RepositoryNetworkPolicyCeiling | undefined,
  grant: RepositoryNetworkGrant,
): boolean {
  return (
    selected?.some(
      ({ repository, access }) =>
        repository === grant.repository && (access === grant.access || access === "write"),
    ) === true
  );
}

export function assertSelectedRepositoryGrants(
  grants: readonly RepositoryNetworkGrant[] | undefined,
  selected: RepositoryNetworkPolicyCeiling | undefined,
): void {
  if (grants?.some((grant) => !selectedRepositoryGrantAllows(selected, grant))) {
    throw new ResourceStateConflictError(
      "The saved repository network policy exceeds the Agent's selected Git credential. Review the saved policy and repository bindings before deploying.",
      [{ path: "/repositoryNetworkPolicy", code: "INVALID_VALUE" }],
    );
  }
}

function refuseRepositoryPolicy(error: unknown, operation: "save" | "deploy"): never {
  if (!(error instanceof RepositoryNetworkPolicyAdmissionError)) {
    throw error;
  }
  throw new ResourceStateConflictError(error.message, [
    {
      path: error.path,
      code: error.code === "UNSUPPORTED_POLICY" ? "INVALID_VALUE" : error.code,
      ...(operation === "deploy" ? { message: error.message } : {}),
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
  operation: "save" | "deploy" = "deploy",
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
        operation === "deploy"
          ? "Cannot verify Namespace repository network grants. Review the Installation repository policy before deploying."
          : "Cannot verify Namespace repository network grants. Review the Installation repository policy before saving.",
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
    refuseRepositoryPolicy(error, operation);
  }
}

// Stop retires the active pointer. A provider can still complete an earlier
// unscoped write after its Worker loses the claim. Retained revisions identify
// every deployment that could have targeted this Agent's shared resources.
export function hasOnlyScopedRepositoryRevisions(
  history: readonly Readonly<AgentRevisionRead>[],
): boolean {
  return history.every(
    (revision, index) =>
      !("configurationReadError" in revision) &&
      revision.revision === index + 1 &&
      revision.sandboxPolicy?.repositoryNetworkPolicy !== undefined,
  );
}

export function assertScopedRepositoryHistory(history: readonly Readonly<AgentRevision>[]): void {
  if (!hasOnlyScopedRepositoryRevisions(history)) {
    throw new RepositoryPolicyDeploymentConflict("unscoped_history");
  }
}
