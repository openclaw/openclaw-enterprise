import type { createCredentialSourceDrivers } from "./credential-source-drivers.ts";
import {
  type ConfigurationDriver,
  type ResourceRef,
  type RepositoryNetworkPolicyCeiling,
  isInstallationRepositoryProfile,
  type Agent,
  type AdmittedRepositoryBinding,
  type BackendDefinition,
  type ComputeDriver,
  type CredentialProxyDriver,
  type DeploymentRequestMatch,
  type GitHubAppInstallationCredentialSource,
  type RepositoryAccess,
  type RepositoryBindingRequest,
  type RepositoryBindingSelection,
  type RepositoryCredentialResolution,
  type RepositoryOption,
  type RepositoryOptions,
  type RepositoryNetworkGrant,
  type RepositoryPolicyDriver,
  type RepositoryRevisionState,
  type RevisionHarnessDescriptor,
  type SandboxDriver,
  type SandboxNetworkGrant,
  codexProxiesRepositoryBroker,
  codexRepositoryBrokerNetworkProxy,
  type OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import type { InstalledDriver } from "./installed-driver.ts";
import {
  type HarnessResolver,
  selectsModel,
  validateRepositoryTopology,
} from "./agent-harness-topology.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import { exactConfiguration } from "./configuration-operations.ts";
import { driverOperation } from "./driver-operation.ts";
import {
  readRepositoryEditTopology,
  repositoryPolicySaveValidator,
  type RepositoryPolicyResolution,
  delegatedRepositoryCeiling,
  repositoryGrantAuthority,
  type RepositoryGrantPolicy,
  admitDeploymentRepositoryPolicy,
  assertSelectedRepositoryGrants,
} from "./repository-network-policy.ts";
import { isDeepStrictEqual } from "node:util";
import {
  asRecord,
  hasControlCharacter,
  immutableCopy,
  isNonEmptyString,
} from "@openclaw-enterprise/utils";
import {
  normalizedRepositoryAccess,
  validAdmittedRepositoryBindings,
  validRepositoryAccess,
  validRepositoryRevisionState,
} from "./repository-credential-validation.ts";
import {
  DependencyUnavailableError,
  DriverSelectionError,
  RepositoryBindingSelectionError,
  RepositoryDriverNotConfiguredError,
  RepositoryOptionsUnavailableError,
  ResourceStateConflictError,
  SandboxRepositoryRecipientUnverifiedError,
  SavedRepositorySelectionError,
  ScopeViolationError,
  ConfigurationHarnessError,
} from "./errors.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import { unchangedDriver, type DriverRegistry, type RegisteredDriver } from "./driver-registry.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { exactNamespace, namespaceIdentity } from "./resource-scope.ts";
import { assertAgentConfiguration } from "./deployment-policy.ts";
import { refuseStoredConfigurationSettings } from "./configuration-settings.ts";
import { resolveConfiguredHarnessId } from "./configured-harness.ts";
import { isManagedTokenServiceSource } from "./credential-source-metadata.ts";
import { checkedSandboxPolicySnapshot } from "./sandbox-policy-admission.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import {
  eligibleRepositoryApprovalScope,
  repositoryApprovalFingerprint,
  STANDING_APPROVAL_REFUSALS,
} from "./repository-approval.ts";

interface SelectedRepositoryPolicyOwner {
  readonly driver: RepositoryPolicyDriver;
  readonly admission: InstallationRepositoryAdmission | undefined;
  readonly unchanged: () => boolean;
}

export type SupportsStagedRepositoryRecipient = (input: {
  readonly compute: ComputeDriver;
  readonly sandbox: SandboxDriver;
  readonly proxy: CredentialProxyDriver;
  readonly harness: RevisionHarnessDescriptor;
}) => boolean;

interface RepositoryPolicyDependencies {
  readonly installationId: string;
  readonly configurationDriver: () => ConfigurationDriver;
  readonly credentialSourceOwner: ReturnType<
    typeof createCredentialSourceDrivers
  >["credentialSourceOwner"];
  readonly selectedProxyOwner: () => InstalledDriver;
  readonly selectedCredentialDeliveryOwner: () => InstalledDriver;
  readonly supportsStagedRepositoryRecipient: SupportsStagedRepositoryRecipient | undefined;
  readonly ownedTokenServiceDriver: (instanceId: string) => unknown;
  readonly repositoryCredentialAdmission:
    | ((input: {
        readonly namespaceId: string;
        readonly source: Readonly<GitHubAppInstallationCredentialSource>;
        readonly bindings: readonly AdmittedRepositoryBinding[];
        readonly grants: readonly RepositoryNetworkGrant[];
      }) => readonly DeploymentRequestMatch[] | undefined)
    | undefined;
  readonly repositoryNetworkPolicyCeiling: RepositoryNetworkPolicyCeiling;
  readonly drivers: Pick<DriverRegistry, "hasSelection" | "selection">;
  readonly selectedRepository: () => RepositoryPolicyDriver;
  readonly selectedCompute: () => ComputeDriver;
  readonly backends: ReadonlyMap<string, BackendDefinition>;
  readonly sandboxDriver: () => SandboxDriver | undefined;
  readonly authority: Pick<ControllerAuthority, "authorize" | "authorizationDecision" | "canRead">;
  readonly holdNamespacePolicyActor: (
    state: PlatformUnitOfWork,
    principalId: string,
  ) => Promise<void>;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly getUpdatableAgent: (
    principalId: string,
    namespaceId: string,
    agentId: string,
  ) => Promise<Readonly<Agent>>;
  readonly timestamp: () => string;
  readonly requestAuditId: () => string | undefined;
}

export type InstallationRepositoryAdmission = Readonly<{
  policyMode?: "built-in";
  policy: RepositoryPolicyDriver &
    RepositoryGrantPolicy & {
      listCatalog(input: { readonly namespaceId: string }): Promise<RepositoryOptions>;
      resolveBindings(input: {
        readonly namespaceId: string;
        readonly bindings: readonly RepositoryBindingRequest[];
      }): RepositoryCredentialResolution;
    };
  backendId: string;
}>;

export interface RemoveStandingApprovalInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly approvalId: string;
  readonly expectedGeneration: number;
  readonly repositoryRef?: string;
}

export type RepositoryStandingApprovalChange = {
  readonly repositoryRef: string;
  readonly approvalId: string;
} & (
  | {
      readonly approved: true;
      readonly duration: "until-removed";
      readonly expectedScopeFingerprint: string;
    }
  | { readonly approved: false; readonly expectedGeneration: number }
);

function validRepositorySelector(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validRepositoryOption(value: unknown): value is RepositoryOption {
  const option = asRecord(value);
  const displayName = option?.displayName;
  const allowedProfiles = option?.allowedProfiles;
  return (
    validRepositorySelector(option?.repositoryRef) &&
    isNonEmptyString(displayName) &&
    displayName.length <= 200 &&
    !hasControlCharacter(displayName) &&
    (option?.description === undefined ||
      (isNonEmptyString(option.description) &&
        Array.from(option.description).length <= 512 &&
        !hasControlCharacter(option.description))) &&
    Array.isArray(allowedProfiles) &&
    allowedProfiles.length >= 1 &&
    allowedProfiles.length <= 16 &&
    new Set(allowedProfiles).size === allowedProfiles.length &&
    allowedProfiles.every(validRepositorySelector)
  );
}

function includesBinding(
  candidates: readonly RepositoryBindingSelection[] | undefined,
  expected: RepositoryBindingSelection,
): boolean {
  return (
    candidates?.some(
      (binding) =>
        binding.repositoryRef === expected.repositoryRef && binding.profile === expected.profile,
    ) === true
  );
}

// An Agent with repository bindings reaches the repository credential broker through the
// Codex network proxy in its Harness. Compute preparation refused a proxy setting that blocks
// the broker only after a dedicated deployment stopped the running revision; Agent save,
// provisioning and deployment refuse it first, with the rule preparation applies (finding
// 2350). Preparation alone knows the broker host, from the prepared material, so it still
// refuses a deny of that host. A Sandbox with its own repository path receives the material
// from the worker instead and gets no broker policy.
export function validateRepositoryBrokerNetworkProxy(
  harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
  configuration: Readonly<OpenClawConfigurationDocument>,
  sandbox: SandboxDriver | undefined,
): void {
  if (sandbox?.repositoryAccess !== undefined || !codexProxiesRepositoryBroker(harness)) {
    return;
  }
  const proxy = codexRepositoryBrokerNetworkProxy(configuration);
  if ("refusal" in proxy) {
    throw new ConfigurationHarnessError(proxy.refusal);
  }
}

export function createRepositoryPolicyOperations(dependencies: RepositoryPolicyDependencies) {
  let installationRepositoryAdmission: InstallationRepositoryAdmission | undefined;
  let builtInRepositoryIdentity: RegisteredDriver | undefined;

  function bindInstallation(
    repositoryAdmission: InstallationRepositoryAdmission | undefined,
    backends: readonly BackendDefinition[],
  ): void {
    if (
      repositoryAdmission === undefined &&
      backends.some((backend) => "repo" in backend.drivers)
    ) {
      throw new DriverSelectionError(
        "The Installation requires an explicit repository admission owner.",
      );
    }
    if (repositoryAdmission !== undefined) {
      const backend = dependencies.backends.get(repositoryAdmission.backendId);
      if (backend?.type !== "github" || backend.drivers.repo !== repositoryAdmission.policy.id) {
        throw new DriverSelectionError("Repository admission must bind its exact owning Backend.");
      }
      if (
        repositoryAdmission.policyMode !== undefined &&
        repositoryAdmission.policyMode !== "built-in"
      ) {
        throw new DriverSelectionError("The repository policy mode is invalid.");
      }
      if (repositoryAdmission.policyMode === "built-in") {
        const policy = repositoryAdmission.policy;
        const identity: RegisteredDriver = Object.freeze({
          driver: policy,
          id: policy.id,
          capability: policy.capability,
          implementation: policy.implementation,
        });
        if (
          identity.capability !== "repo" ||
          !isNonEmptyString(identity.implementation) ||
          !unchangedDriver(identity)
        ) {
          throw new DriverSelectionError("The bound repository policy is unavailable.");
        }
        builtInRepositoryIdentity = identity;
      }
      installationRepositoryAdmission = Object.freeze({ ...repositoryAdmission });
    }
  }

  function hasBuiltInRepositoryPolicy(): boolean {
    return installationRepositoryAdmission?.policyMode === "built-in";
  }

  function builtInBackendDriver(): RepositoryPolicyDriver | undefined {
    if (installationRepositoryAdmission?.policyMode !== "built-in") {
      return undefined;
    }
    const owner = repositoryPermissionOwner(installationRepositoryAdmission);
    if (owner === undefined) {
      throw new DriverSelectionError("The bound repository policy is unavailable.");
    }
    return owner.driver;
  }

  function repositoryPermissionOwner(
    admission: InstallationRepositoryAdmission | undefined,
  ): SelectedRepositoryPolicyOwner | undefined {
    if (admission?.policyMode === "built-in") {
      const identity = builtInRepositoryIdentity;
      if (
        identity === undefined ||
        identity.driver !== admission.policy ||
        !unchangedDriver(identity)
      ) {
        return undefined;
      }
      return {
        driver: admission.policy,
        admission,
        unchanged: () => unchangedDriver(identity),
      };
    }
    let driver: RepositoryPolicyDriver;
    try {
      driver = dependencies.selectedRepository();
    } catch {
      return undefined;
    }
    if (admission !== undefined && admission.policy !== driver) {
      throw new DependencyUnavailableError("The bound repository admission owner is not selected.");
    }
    return {
      driver,
      admission,
      unchanged: () => {
        const selected = dependencies.drivers.selection("repo");
        return selected?.driver === driver && unchangedDriver(selected);
      },
    };
  }

  function selectedStandingRepositoryAdmission(): InstallationRepositoryAdmission | undefined {
    const admission = installationRepositoryAdmission;
    return admission?.policyMode === "built-in" ||
      admission?.policy === dependencies.drivers.selection("repo")?.driver
      ? admission
      : undefined;
  }

  function repositoryConfigured(): boolean {
    return hasBuiltInRepositoryPolicy() || dependencies.drivers.hasSelection("repo");
  }

  async function listRepositoryOptions(
    principalId: string,
    namespaceId: string,
    agentId?: string,
  ): Promise<Readonly<RepositoryOptions & { notConfigured?: true }>> {
    namespaceIdentity(namespaceId);
    if (agentId !== undefined) {
      const agent = await dependencies.getUpdatableAgent(principalId, namespaceId, agentId);
      if (agent.status !== "active") {
        throw new ResourceStateConflictError("The Agent does not accept repository changes.");
      }
    } else {
      await dependencies.authority.authorize(principalId, "create", {
        kind: "agent",
        id: namespaceId,
        namespaceId,
      });
    }
    const namespace = await dependencies.transactions.read((state) =>
      exactNamespace(state, namespaceId),
    );
    // Checked after authorization: the conflict names the Namespace state.
    if (namespace.status !== "provisioning" && namespace.status !== "ready") {
      throw new ResourceStateConflictError("The Namespace does not accept new Agents.");
    }
    // No repository settings is a fixed Installation state, not an outage: answer no options
    // and say why, as Agent save names it (finding 2387).
    if (!repositoryConfigured()) {
      return Object.freeze({ options: Object.freeze([]), notConfigured: true });
    }
    let compute: ComputeDriver;
    try {
      compute = dependencies.selectedCompute();
    } catch {
      throw new RepositoryOptionsUnavailableError(
        "The selected Compute Driver cannot support repository options.",
      );
    }
    if (compute.validateRepositoryCredentialSupport === undefined) {
      throw new RepositoryOptionsUnavailableError(
        "The selected Compute Driver cannot support repository options.",
      );
    }
    const sandboxDriverId = dependencies.sandboxDriver()?.id;
    try {
      compute.validateRepositoryCredentialSupport(sandboxDriverId);
    } catch (error) {
      throw new RepositoryOptionsUnavailableError(
        error instanceof SandboxRepositoryRecipientUnverifiedError
          ? error.message
          : "The selected Compute Driver cannot support repository options with this composition.",
      );
    }
    const owner = repositoryPermissionOwner(installationRepositoryAdmission);
    if (owner === undefined) {
      throw new RepositoryOptionsUnavailableError(
        "The selected repository credential Driver is unavailable.",
      );
    }
    const { driver, admission } = owner;
    let result: RepositoryOptions;
    try {
      const input = { namespaceId: namespace.id };
      result = await (admission === undefined
        ? driver.listOptions(input)
        : admission.policy.listCatalog(input));
    } catch {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver could not list repository options.",
      );
    }
    if (
      !result ||
      !Array.isArray(result.options) ||
      result.options.length > 1001 ||
      !result.options.every(validRepositoryOption) ||
      new Set(result.options.map((option) => option.repositoryRef)).size !==
        result.options.length ||
      !owner.unchanged()
    ) {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver returned invalid repository options.",
      );
    }
    // The create picker has no Agent yet. Only an administrator with Namespace-wide
    // read access to Agents and their policies may see delegated policy limits here.
    const { authority } = dependencies;
    const showLimits =
      agentId === undefined &&
      admission !== undefined &&
      result.options.some((option) => "githubRepository" in option) &&
      (
        await authority.authorizationDecision(principalId, "administer", {
          kind: "installation",
          id: dependencies.installationId,
        })
      ).decision.allowed &&
      (await authority.canRead(principalId, { kind: "agent", namespaceId, id: namespaceId })) &&
      (await authority.canRead(principalId, {
        kind: "sandbox_policy",
        namespaceId,
        id: namespaceId,
      }));
    const limits = new Map(
      (showLimits ? namespaceRepositoryNetworkPolicyCeiling(namespaceId) : []).map(
        (grant) => [grant.repository, grant] as const,
      ),
    );
    if (!owner.unchanged()) {
      throw new DependencyUnavailableError("The repository policy changed while listing options.");
    }
    return immutableCopy({
      options: result.options.map(
        ({ repositoryRef, displayName, allowedProfiles, description, ...provider }) => {
          // Never accept a provider-supplied limit or infer identity from display names.
          const githubAccess =
            "githubRepository" in provider &&
            typeof provider.githubRepository === "string" &&
            allowedProfiles.includes("github-repository")
              ? limits.get(provider.githubRepository)
              : undefined;
          return {
            repositoryRef,
            displayName,
            allowedProfiles,
            ...(description === undefined ? {} : { description }),
            ...(githubAccess === undefined ? {} : { githubAccess }),
          };
        },
      ),
    });
  }

  async function listAgentStandingApprovals(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ) {
    await dependencies.authority.authorize(principalId, "administer", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return dependencies.transactions.read(async (state) => {
      await exactNamespace(state, namespaceId);
      if (!(await state.agents.findAgent(namespaceId, agentId))) {
        throw new ScopeViolationError("Agent does not belong to the exact Namespace.");
      }
      return (await state.repositorySessions.listStandingApprovals(namespaceId, agentId)).map(
        (approval) => ({
          id: approval.id,
          repositoryRef: approval.binding.repositoryRef,
          profile: approval.binding.profile,
          generation: approval.generation,
          scopeFingerprint: approval.scopeFingerprint,
          approvedBy: approval.approvedBy,
          createdAt: approval.createdAt,
          ...(approval.revokedAt ? { revokedAt: approval.revokedAt } : {}),
          status: approval.revokedAt ? ("removed" as const) : ("active" as const),
        }),
      );
    });
  }

  async function listAgentStandingApprovalScopes(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ) {
    await dependencies.authority.authorize(principalId, "administer", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return dependencies.transactions.read(async (state) => {
      const agent = await state.agents.findAgent(namespaceId, agentId);
      if (!agent) {
        throw new ScopeViolationError("Agent does not belong to the exact Namespace.");
      }
      // TODO: support multiple independently approved bindings when session admission supports them.
      // Without a repository Driver nothing can be approved (finding 2362).
      if (agent.repositoryBindings?.length !== 1 || !repositoryConfigured()) {
        return [];
      }
      const resolved = resolveRepositoryBindings(
        namespaceId,
        agent.repositoryBindings,
        "saved",
        selectedStandingRepositoryAdmission(),
      );
      if (resolved === undefined) {
        return [];
      }
      return resolved.resolution.bindings.flatMap((binding) => {
        const scope = eligibleRepositoryApprovalScope(resolved.driver, { namespaceId, binding });
        return scope
          ? [
              {
                repositoryRef: binding.repositoryRef,
                binding,
                scope,
                scopeFingerprint: repositoryApprovalFingerprint({
                  namespaceId,
                  agentId,
                  binding,
                  scope,
                }),
              },
            ]
          : [];
      });
    });
  }

  async function removeAgentStandingApproval(
    principalId: string,
    input: RemoveStandingApprovalInput,
  ): Promise<void> {
    await dependencies.authority.authorize(principalId, "administer", {
      kind: "agent",
      id: input.agentId,
      namespaceId: input.namespaceId,
    });
    await dependencies.transactions.transact(async (state) => {
      await state.namespaces.lockNamespace(input.namespaceId, { includeDeleted: true });
      const agent = await state.agents.lockAgent(input.namespaceId, input.agentId);
      if (!agent) {
        throw new ScopeViolationError("Agent does not belong to the exact Namespace.");
      }
      await holdStandingApprovalAuthority(state, principalId, agent);
      await removeLockedStandingApproval(state, input);
    });
  }

  function repositorySettings(
    namespaceId: string,
    input: {
      readonly repositoryBindings?: readonly RepositoryBindingRequest[];
      readonly repositoryAccess?: RepositoryAccess;
    },
  ): {
    repositoryBindings: readonly RepositoryBindingSelection[] | undefined;
    repositoryAccess?: RepositoryAccess;
  } {
    const resolve = (bindings: readonly RepositoryBindingRequest[] | undefined) =>
      repositoryBindingSelections(namespaceId, bindings, "request");
    if (input.repositoryAccess === undefined) {
      return {
        repositoryBindings: resolve(input.repositoryBindings),
      };
    }
    if (input.repositoryBindings !== undefined || !validRepositoryAccess(input.repositoryAccess)) {
      throw new RepositoryBindingSelectionError(RepositoryBindingSelectionError.accessOrBindings);
    }
    const requested = input.repositoryAccess.repositories.map((entry) => ({
      repositoryRef: entry.repositoryRef,
      profile: entry.profile ?? input.repositoryAccess!.defaultProfile,
    }));
    const repositoryBindings = resolve(requested);
    return {
      repositoryBindings,
      repositoryAccess: normalizedRepositoryAccess(input.repositoryAccess, repositoryBindings)!,
    };
  }

  // A provider refusal for a submitted binding is a request error. The same
  // refusal for a saved binding describes a stored-state conflict.
  function resolveRepositoryBindings(
    namespaceId: string,
    bindings: readonly RepositoryBindingRequest[] | undefined,
    origin: "request" | "saved",
    admission?: InstallationRepositoryAdmission,
  ):
    | {
        readonly driver: RepositoryPolicyDriver;
        readonly resolution: RepositoryPolicyResolution;
        readonly unchanged: () => boolean;
      }
    | undefined {
    if (bindings === undefined) {
      return undefined;
    }
    if (!Array.isArray(bindings)) {
      throw new ScopeViolationError(
        "Repository bindings must be an array of repository selections.",
      );
    }
    if (bindings.length === 0) {
      return undefined;
    }
    if (!repositoryConfigured()) {
      throw new RepositoryDriverNotConfiguredError();
    }
    const owner = repositoryPermissionOwner(admission);
    if (owner === undefined) {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver is unavailable.",
      );
    }
    const { driver } = owner;
    let resolution: RepositoryCredentialResolution;
    try {
      const input = immutableCopy({ namespaceId, bindings });
      resolution =
        admission === undefined ? driver.resolve(input) : admission.policy.resolveBindings(input);
    } catch {
      // Every caller holds the Agent's or Namespace's grant, and the fixed text names no
      // repository or Driver reason, so it is a request or saved-state error, not a scope miss.
      throw origin === "request"
        ? new RepositoryBindingSelectionError(RepositoryBindingSelectionError.notApproved)
        : new SavedRepositorySelectionError();
    }
    if (
      !resolution ||
      !validAdmittedRepositoryBindings(resolution.bindings) ||
      !Number.isSafeInteger(resolution.sessionDurationSeconds) ||
      resolution.sessionDurationSeconds <= 0 ||
      !owner.unchanged()
    ) {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver returned an invalid resolution.",
      );
    }
    const requested = new Map(
      bindings.map((binding) => [binding?.repositoryRef, binding?.profile]),
    );
    if (
      requested.size !== bindings.length ||
      resolution.bindings.length !== bindings.length ||
      resolution.bindings.some((binding) => {
        const backend = dependencies.backends.get(binding.backendId);
        return (
          !requested.has(binding.repositoryRef) ||
          ((requested.get(binding.repositoryRef) !== undefined ||
            isInstallationRepositoryProfile(binding.profile)) &&
            requested.get(binding.repositoryRef) !== binding.profile) ||
          (admission !== undefined && binding.backendId !== admission.backendId) ||
          backend === undefined ||
          !("repo" in backend.drivers) ||
          backend.drivers.repo !== driver.id
        );
      })
    ) {
      throw new DependencyUnavailableError(
        "The repository credential resolution does not match the selected authority.",
      );
    }
    // Agent save and deploy admission both resolve here, so they refuse the same selections.
    if (
      resolution.bindings.length !== 1 &&
      resolution.bindings.some((binding) => isInstallationRepositoryProfile(binding.profile))
    ) {
      throw new RepositoryBindingSelectionError();
    }
    return { driver, resolution: immutableCopy(resolution), unchanged: owner.unchanged };
  }

  function repositoryBindingSelections(
    namespaceId: string,
    bindings: readonly RepositoryBindingRequest[] | undefined,
    origin: "request" | "saved",
  ): readonly RepositoryBindingSelection[] | undefined {
    const resolved = resolveRepositoryBindings(
      namespaceId,
      bindings,
      origin,
      installationRepositoryAdmission,
    );
    if (resolved === undefined || bindings === undefined) {
      return undefined;
    }
    const selections = new Map(
      resolved.resolution.bindings.map(({ repositoryRef, profile }) => [
        repositoryRef,
        { repositoryRef, profile },
      ]),
    );
    return immutableCopy(bindings.map(({ repositoryRef }) => selections.get(repositoryRef)!));
  }

  function supportsStagedRecipient(compute: ComputeDriver, harness: RevisionHarnessDescriptor) {
    try {
      const sandbox = dependencies.sandboxDriver();
      const owner = dependencies.selectedCredentialDeliveryOwner();
      const proxy = owner.require("credential_proxy_delivery");
      return (
        sandbox !== undefined &&
        owner.require("sandbox") === sandbox &&
        dependencies.repositoryCredentialAdmission !== undefined &&
        dependencies.supportsStagedRepositoryRecipient?.({ compute, sandbox, proxy, harness }) ===
          true
      );
    } catch {
      return false;
    }
  }

  function admitRepositoryCredentials(
    agent: Readonly<Agent>,
    compute: ComputeDriver,
    harness: RevisionHarnessDescriptor,
    sandboxDriverId: string | undefined,
    admittedAtWallMs: number,
    staged?: {
      readonly source: Readonly<GitHubAppInstallationCredentialSource>;
      readonly grants: readonly RepositoryNetworkGrant[];
    },
  ) {
    const resolved = resolveRepositoryBindings(
      agent.namespaceId,
      agent.repositoryBindings,
      "saved",
      installationRepositoryAdmission,
    );
    if (resolved === undefined) {
      return undefined;
    }
    let requests: readonly DeploymentRequestMatch[] | undefined;
    if (staged) {
      if (
        staged.source.namespaceId !== agent.namespaceId ||
        staged.source.state !== "ready" ||
        sandboxDriverId !== dependencies.sandboxDriver()?.id ||
        !supportsStagedRecipient(compute, harness) ||
        resolved.resolution.nativeGit !== "v1"
      ) {
        throw new ResourceStateConflictError("The staged repository recipient is unavailable.");
      }
      assertSelectedRepositoryGrants(staged.grants, resolved.resolution);
      requests = dependencies.repositoryCredentialAdmission?.({
        namespaceId: agent.namespaceId,
        source: staged.source,
        bindings: resolved.resolution.bindings,
        grants: staged.grants,
      });
      if (!requests?.length || !resolved.unchanged()) {
        throw new ResourceStateConflictError(
          "The staged repository Source and saved grants cannot be admitted.",
        );
      }
    } else {
      validateRepositoryTopology(compute, harness, sandboxDriverId);
    }
    const snapshot: RepositoryRevisionState = {
      driver: { id: resolved.driver.id, implementation: resolved.driver.implementation },
      deadlineWallMs: admittedAtWallMs + resolved.resolution.sessionDurationSeconds * 1000,
      bindings: resolved.resolution.bindings,
    };
    if (!validRepositoryRevisionState(snapshot)) {
      throw new DependencyUnavailableError(
        "The selected repository credential Driver returned an invalid admission snapshot.",
      );
    }
    return {
      credentials: immutableCopy(snapshot),
      resolution: resolved.resolution,
      nativeGit: resolved.resolution.nativeGit,
      requiresNetworkPolicy: resolved.resolution.requiresNetworkPolicy,
      requests,
    };
  }

  // Recheck administer after the Namespace and Agent row locks.
  async function holdStandingApprovalAuthority(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Pick<Agent, "id" | "namespaceId">,
  ): Promise<void> {
    await dependencies.holdNamespacePolicyActor(state, principalId);
    await dependencies.authority.authorize(principalId, "administer", {
      kind: "agent",
      id: agent.id,
      namespaceId: agent.namespaceId,
    });
  }

  async function removeLockedStandingApproval(
    state: PlatformUnitOfWork,
    input: RemoveStandingApprovalInput,
  ): Promise<void> {
    const approval = (
      await state.repositorySessions.listStandingApprovals(input.namespaceId, input.agentId)
    ).find((a) => a.id === input.approvalId);
    if (
      !approval ||
      (input.repositoryRef !== undefined && approval.binding.repositoryRef !== input.repositoryRef)
    ) {
      throw new ScopeViolationError(
        "Standing approval does not belong to the exact Agent and binding.",
      );
    }
    if (approval.revokedAt && approval.generation === input.expectedGeneration + 1) {
      return;
    }
    if (approval.revokedAt || approval.generation !== input.expectedGeneration) {
      throw new ResourceStateConflictError("Standing approval changed.");
    }
    await state.repositorySessions.revokeStanding(approval, dependencies.timestamp());
  }

  async function reconcileAgentBindings(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    updated: Readonly<Agent>,
    bindingsChanged: boolean,
    requested: RepositoryStandingApprovalChange | undefined,
  ): Promise<void> {
    // Stop intent can be superseded before the active runtime is retired.
    // Removing a finite grant must remain irreversible throughout that interval.
    if (bindingsChanged && agent.activeRevisionId) {
      const revision = await state.revisions.findRevision(
        agent.namespaceId,
        agent.id,
        agent.activeRevisionId,
      );
      const admitted = revision?.repositoryCredentials;
      if (
        revision &&
        admitted &&
        !admitted.standingApprovalId &&
        admitted.bindings.some(
          (member) =>
            includesBinding(agent.repositoryBindings, member) &&
            !includesBinding(updated.repositoryBindings, member),
        )
      ) {
        await state.repositorySessions.withdrawFinite(
          { namespaceId: agent.namespaceId, agentId: agent.id, revisionId: revision.id },
          dependencies.timestamp(),
          dependencies.requestAuditId(),
        );
      }
    }
    const activeApprovals = (
      await state.repositorySessions.listStandingApprovals(agent.namespaceId, agent.id)
    ).filter((a) => !a.revokedAt);
    if (
      activeApprovals.length > 0 &&
      (updated.repositoryBindings?.length !== 1 ||
        activeApprovals.some((a) => !includesBinding(updated.repositoryBindings, a.binding)))
    ) {
      // The caller holds update on the Agent. Like SecretReferencedError, the text says what
      // blocks without naming it: no approval ID, which only Agent administer reads.
      throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.bindingLocked);
    }
    if (requested !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requested.approvalId)) {
        throw new ScopeViolationError("Invalid standing approval identity.");
      }
      await holdStandingApprovalAuthority(state, principalId, agent);
      if (requested.approved) {
        // TODO: admit independent sessions before enabling approval for multiple bindings.
        if (updated.repositoryBindings?.length !== 1) {
          throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.oneBinding);
        }
        const selected = updated.repositoryBindings?.find(
          (b) => b.repositoryRef === requested.repositoryRef,
        );
        // The request's own selections resolved above, so only saved ones can fail here.
        const resolved =
          selected &&
          resolveRepositoryBindings(
            agent.namespaceId,
            [selected],
            "saved",
            selectedStandingRepositoryAdmission(),
          );
        const binding = resolved?.resolution.bindings[0];
        const scope =
          binding &&
          eligibleRepositoryApprovalScope(resolved!.driver, {
            namespaceId: agent.namespaceId,
            binding,
          });
        if (requested.duration !== "until-removed" || !binding || !scope) {
          throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.notPermitted);
        }
        const scopeFingerprint = repositoryApprovalFingerprint({
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          binding,
          scope,
        });
        if (requested.expectedScopeFingerprint !== scopeFingerprint) {
          throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.scopeChanged);
        }
        await state.repositorySessions.approveStanding({
          id: requested.approvalId,
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          binding,
          scope,
          scopeFingerprint,
          approvedBy: principalId,
          createdAt: dependencies.timestamp(),
        });
      } else {
        await removeLockedStandingApproval(state, {
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          approvalId: requested.approvalId,
          expectedGeneration: requested.expectedGeneration,
          repositoryRef: requested.repositoryRef,
        });
      }
    }
  }

  async function applyRepositoryStandingApproval(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agentId: string,
    credentials: RepositoryRevisionState | undefined,
  ): Promise<RepositoryRevisionState | undefined> {
    if (credentials?.bindings.length !== 1) {
      const approvals = await state.repositorySessions.listStandingApprovals(namespaceId, agentId);
      if (approvals.some((approval) => !approval.revokedAt)) {
        throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.deployOneBinding);
      }
      return credentials;
    }

    const binding = credentials.bindings[0]!;
    const approval = await state.repositorySessions.findStandingApproval(
      namespaceId,
      agentId,
      binding.repositoryRef,
    );
    if (!approval) {
      return credentials;
    }
    const resolved = resolveRepositoryBindings(
      namespaceId,
      [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
      "saved",
      installationRepositoryAdmission,
    )!;
    const scope = eligibleRepositoryApprovalScope(resolved.driver, { namespaceId, binding });
    if (
      !scope ||
      !isDeepStrictEqual(resolved.resolution.bindings[0], binding) ||
      !isDeepStrictEqual(approval.binding, binding) ||
      !isDeepStrictEqual(approval.scope, scope)
    ) {
      throw new ResourceStateConflictError(STANDING_APPROVAL_REFUSALS.policyChanged);
    }
    return {
      ...credentials,
      standingApprovalId: approval.id,
      standingApprovalGeneration: approval.generation,
      standingApprovalScopeFingerprint: approval.scopeFingerprint,
    };
  }

  function namespaceRepositoryNetworkPolicyCeiling(
    namespaceId: string,
  ): RepositoryNetworkPolicyCeiling {
    const ceiling = dependencies.repositoryNetworkPolicyCeiling;
    if (ceiling.length === 0) {
      return [];
    }
    try {
      const admission = selectedStandingRepositoryAdmission();
      const owner = admission && repositoryPermissionOwner(admission);
      return delegatedRepositoryCeiling(
        ceiling,
        repositoryGrantAuthority(namespaceId, admission?.policy, owner?.unchanged),
      );
    } catch {
      // Owner lookup can fail before projection. Keep saved grants readable for withdrawal.
      return [];
    }
  }

  function readGrantAuthority(namespaceId: string, admission = installationRepositoryAdmission) {
    try {
      const owner = admission && repositoryPermissionOwner(admission);
      return repositoryGrantAuthority(namespaceId, owner?.admission?.policy, owner?.unchanged);
    } catch {
      return undefined;
    }
  }

  async function qualifyStagedRepositoryEdit(
    state: PlatformReadView | PlatformUnitOfWork,
    agent: Readonly<Agent>,
    version: number,
    canRead: (target: ResourceRef) => Promise<boolean>,
    canOperate: ((target: ResourceRef) => Promise<boolean>) | undefined,
    resolveHarness: HarnessResolver,
    additions: readonly SandboxNetworkGrant[],
    admission: InstallationRepositoryAdmission,
  ): Promise<
    ReturnType<NonNullable<ReturnType<typeof repositoryPolicySaveValidator>>> | undefined
  > {
    const auth = agent.harnessAuth;
    const sources = agent.credentialSources;
    const approve = dependencies.repositoryCredentialAdmission;
    if (
      agent.executionMode !== "dedicated" ||
      auth?.method !== "credential_source" ||
      !sources ||
      sources.length < 2 ||
      new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length ||
      sources.filter(({ sourceId }) => sourceId === auth.sourceId).length !== 1 ||
      !canOperate ||
      !approve
    ) {
      return undefined;
    }
    const { namespaceId } = agent;
    const configurationRef = {
      kind: "configuration",
      id: agent.configurationId,
      namespaceId,
    } as const;
    if (!(await canRead(configurationRef))) {
      return undefined;
    }
    for (const { sourceId } of sources) {
      const ref = { kind: "credential_source", id: sourceId, namespaceId } as const;
      if (!(await canRead(ref)) || !(await canOperate(ref))) {
        return undefined;
      }
    }
    const configuration = dependencies.configurationDriver();
    const metadata =
      "audit" in state
        ? await state.configurations.lockConfiguration(namespaceId, agent.configurationId)
        : await state.configurations.findConfiguration(namespaceId, agent.configurationId);
    assertAgentConfiguration(metadata, namespaceId, agent.configurationId);
    const { values } = exactConfiguration(
      await driverOperation(() => configuration.read({ id: metadata.id, namespaceId })),
      metadata,
    );
    refuseStoredConfigurationSettings(values);
    const harnessId = resolveConfiguredHarnessId(values);
    const descriptor = resolveHarness(harnessId, "dedicated");
    if (
      !selectsModel(values) ||
      descriptor?.id !== harnessId ||
      !isNonEmptyString(descriptor.version)
    ) {
      return undefined;
    }
    const harness = { ...descriptor, mode: "dedicated" as const };
    const readSource = (id: string) =>
      "audit" in state
        ? state.credentialSources.lockCredentialSource(namespaceId, id)
        : state.credentialSources.findCredentialSource(namespaceId, id);
    const selected = await Promise.all(sources.map(({ sourceId }) => readSource(sourceId)));
    const model = selected.find((source) => source?.id === auth.sourceId);
    const repositories = selected.filter(
      (source) => isManagedTokenServiceSource(source) && source.type === "github-app-installation",
    );
    const source = repositories[0];
    if (
      !isManagedTokenServiceSource(model) ||
      model.type === "github-app-installation" ||
      model.state !== "ready" ||
      model.namespaceId !== namespaceId ||
      repositories.length !== 1 ||
      !isManagedTokenServiceSource(source) ||
      source.type !== "github-app-installation" ||
      source.state !== "ready" ||
      source.namespaceId !== namespaceId ||
      source.tokenServiceInstanceId !== model.tokenServiceInstanceId
    ) {
      return undefined;
    }
    const tokenOwner = dependencies.ownedTokenServiceDriver(source.tokenServiceInstanceId);
    if (dependencies.ownedTokenServiceDriver(model.tokenServiceInstanceId) !== tokenOwner) {
      return undefined;
    }
    const compute = dependencies.selectedCompute();
    if (!supportsStagedRecipient(compute, harness)) {
      return undefined;
    }
    const owner = dependencies.selectedCredentialDeliveryOwner();
    const sandbox = dependencies.sandboxDriver();
    if (!sandbox || owner.require("sandbox") !== sandbox || !sandbox.admitNetworkPolicy) {
      return undefined;
    }
    const admitNetwork = sandbox.admitNetworkPolicy;
    const authority = readGrantAuthority(namespaceId, admission);
    const resolve = () =>
      resolveRepositoryBindings(namespaceId, agent.repositoryBindings, "saved", admission);
    const repository = resolve();
    if (!authority || !repository || repository.resolution.nativeGit !== "v1") {
      return undefined;
    }
    const current = (approved?: () => boolean) => {
      if (
        !repository.unchanged() ||
        !isDeepStrictEqual(resolve()?.resolution, repository.resolution) ||
        !authority.unchanged() ||
        approved?.() === false ||
        dependencies.repositoryCredentialAdmission !== approve ||
        dependencies.configurationDriver() !== configuration ||
        dependencies.selectedCompute() !== compute ||
        dependencies.selectedCredentialDeliveryOwner() !== owner ||
        dependencies.sandboxDriver() !== sandbox ||
        sandbox.admitNetworkPolicy !== admitNetwork ||
        dependencies.ownedTokenServiceDriver(source.tokenServiceInstanceId) !== tokenOwner
      ) {
        throw new ResourceStateConflictError(
          "The selected Drivers changed during repository network policy admission. Reload before editing.",
        );
      }
    };
    const admit = (grants: readonly RepositoryNetworkGrant[]) => {
      current();
      const { sandboxPolicy, ownerUnchanged } = admitDeploymentRepositoryPolicy(
        () =>
          checkedSandboxPolicySnapshot(sandbox, additions, version, undefined, undefined, () =>
            Reflect.apply(admitNetwork, sandbox, [additions, version]),
          ),
        grants,
        dependencies.repositoryNetworkPolicyCeiling,
        sandbox,
        () => authority,
        "save",
      );
      const policy = sandboxPolicy?.repositoryNetworkPolicy;
      if (!policy) {
        return undefined;
      }
      assertSelectedRepositoryGrants(policy.grants, repository.resolution);
      if (
        policy.grants.length > 0 &&
        !approve({
          namespaceId,
          source,
          bindings: repository.resolution.bindings,
          grants: policy.grants,
        })?.length
      ) {
        return undefined;
      }
      const assertCurrent = () => current(ownerUnchanged);
      assertCurrent();
      return { grants: policy.grants, assertCurrent };
    };
    return {
      supports(ceiling) {
        return ceiling.some((grant) => {
          try {
            return admit([{ ...grant, access: "read" }]) !== undefined;
          } catch {
            return false;
          }
        });
      },
      apiMaxima: () => undefined,
      admit,
    };
  }

  async function qualifyRepositoryEdit(
    state: PlatformReadView | PlatformUnitOfWork,
    agent: Readonly<Agent>,
    version: number,
    canRead: (target: ResourceRef) => Promise<boolean>,
    resolveHarness: HarnessResolver | undefined,
    additions: readonly SandboxNetworkGrant[] = [],
    canOperate?: (target: ResourceRef) => Promise<boolean>,
  ) {
    const { namespaceId, repositoryBindings: bindings } = agent;
    const admission = installationRepositoryAdmission;
    if (!admission || !resolveHarness || !bindings?.length) {
      return undefined;
    }
    try {
      const staged = await qualifyStagedRepositoryEdit(
        state,
        agent,
        version,
        canRead,
        canOperate,
        resolveHarness,
        additions,
        admission,
      );
      if (staged) {
        return staged;
      }
      if (additions.length > 0) {
        return undefined;
      }
      const compute = dependencies.selectedCompute();
      const owner = dependencies.selectedProxyOwner();
      const validate = repositoryPolicySaveValidator(compute, owner);
      if (!validate) {
        return undefined;
      }
      const authority = readGrantAuthority(namespaceId, admission);
      if (authority === undefined) {
        return undefined;
      }
      const configuration = dependencies.configurationDriver();
      const { resolveBindings } = admission.policy;
      const topology = await readRepositoryEditTopology(agent, resolveHarness, canRead, {
        configurationOwnership: (id) =>
          "audit" in state
            ? state.configurations.lockConfiguration(namespaceId, id)
            : state.configurations.findConfiguration(namespaceId, id),
        configuration: async (metadata) =>
          exactConfiguration(
            await driverOperation(() =>
              configuration.read({ id: metadata.id, namespaceId: metadata.namespaceId }),
            ),
            metadata,
          ),
        credentialSource: (id) =>
          "audit" in state
            ? state.credentialSources.lockCredentialSource(namespaceId, id)
            : state.credentialSources.findCredentialSource(namespaceId, id),
      });
      if (!topology) {
        return undefined;
      }
      const { harness, source } = topology;
      const sourceDriver = dependencies.credentialSourceOwner(source).driver;
      const resolve = () => resolveRepositoryBindings(namespaceId, bindings, "saved", admission);
      const repository = resolve();
      if (!repository) {
        return undefined;
      }
      const ownerSelected = () =>
        repository.unchanged() && admission.policy.resolveBindings === resolveBindings;
      const ownersCurrent = () =>
        ownerSelected() &&
        isDeepStrictEqual(resolve()?.resolution, repository.resolution) &&
        ownerSelected() &&
        dependencies.selectedCompute() === compute &&
        dependencies.selectedProxyOwner() === owner &&
        dependencies.configurationDriver() === configuration &&
        dependencies.credentialSourceOwner(source).driver === sourceDriver;
      return validate(
        topology.placement,
        harness,
        source,
        repository.resolution,
        dependencies.repositoryNetworkPolicyCeiling,
        authority,
        version,
        ownersCurrent,
      );
    } catch {
      // Driver refusals can contain protected configuration and binding details.
      return undefined;
    }
  }

  return {
    namespaceRepositoryNetworkPolicyCeiling,
    qualifyRepositoryEdit,
    repositoryNetworkPolicyCeiling: dependencies.repositoryNetworkPolicyCeiling,
    repositoryGrantAuthority: readGrantAuthority,
    bindInstallation,
    hasBuiltInRepositoryPolicy,
    builtInBackendDriver,
    listRepositoryOptions,
    listAgentStandingApprovals,
    listAgentStandingApprovalScopes,
    removeAgentStandingApproval,
    repositorySettings,
    repositoryBindingSelections,
    admitRepositoryCredentials,
    reconcileAgentBindings,
    applyRepositoryStandingApproval,
  };
}
