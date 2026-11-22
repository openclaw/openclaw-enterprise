import type { RepositoryNetworkGrant } from "@openclaw-enterprise/contracts";
import { bindRepositoryPolicyAuthorization } from "./repository-network-policy.ts";
import { isDeepStrictEqual } from "node:util";
import {
  assertExecutionAdmission,
  ConfigurationValidationError,
  networkGrantAdmissionDetails,
  requireConfiguration,
  validateSandboxNetworkGrants,
  type Agent,
  type AgentRevision,
  type ComputeDriver,
  type ConfigurationResult,
  type DriverConfigurationDescriptor,
  type ErrorDetail,
  type ExecutionAdmission,
  type RevisionHarnessDescriptor,
  type ResourceRef,
  type SandboxDriver,
  type SandboxFacet,
  type SandboxNetworkGrant,
  type RepositoryNetworkPolicyCeiling,
  type SandboxPolicy,
  type SandboxPolicyRecommendations,
  type SandboxPolicySnapshot,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { DriverConfigurationRegistry } from "./configuration-registry.ts";
import type { createCredentialEgressAdmission } from "./credential-egress-admission.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  DependencyUnavailableError,
  ProtectedExecutionNetworkPolicyError,
  ResourceStateConflictError,
  SandboxNetworkPolicyConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { exactNamespace, lockNamespace } from "./resource-scope.ts";

interface SandboxPolicyDependencies {
  readonly repositoryCeiling: (namespaceId: string) => RepositoryNetworkPolicyCeiling;
  readonly installationId: string;
  readonly ceiling: readonly SandboxNetworkGrant[];
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "authorizationDecision" | "holdAuthority" | "authorizationAuthority"
  >;
  readonly egressAdmission: Pick<
    ReturnType<typeof createCredentialEgressAdmission>,
    "ordinaryModelBinding"
  >;
  readonly hasCredentialProxy: () => boolean;
  readonly allowsOrdinaryCredentialGateway: () => boolean;
  readonly record: (
    state: PlatformUnitOfWork,
    operation: Parameters<PlatformUnitOfWork["operations"]["append"]>[0],
  ) => Promise<void>;
  readonly resolveConfiguration: DriverConfigurationRegistry["resolve"];
  readonly hasSandboxSelection: () => boolean;
  readonly selectSandbox: () => SandboxDriver;
  readonly selectedCompute: () => ComputeDriver;
  readonly timestamp: () => string;
}

const NO_SANDBOX_DRIVER_NETWORK_POLICY =
  "This Installation selects no Sandbox Driver, so Agents run without a Sandbox: there are no policy denials, suggestions or Agent network rules.";
const SANDBOX_DRIVER_WITHOUT_NETWORK_POLICY =
  "The selected Sandbox Driver does not support per-Agent network policy.";

function requireNetworkPolicyFacet(facet: SandboxFacet): void {
  if (facet !== "networking") {
    throw new ResourceStateConflictError(
      `Agent policy editing is unsupported for the ${facet} facet.`,
    );
  }
}

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

function checkedSandboxPolicySnapshot(
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
    const snapshot = immutableCopy(returned);
    validateSandboxNetworkGrants(snapshot?.additions);
    if (
      snapshot.driverId !== driver.id ||
      snapshot.implementation !== driver.implementation ||
      snapshot.version !== version ||
      snapshot.defaults === null ||
      typeof snapshot.defaults !== "object" ||
      Array.isArray(snapshot.defaults) ||
      !isDeepStrictEqual(snapshot.additions, additions)
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

function policyResource(namespaceId: string, agentId: string): ResourceRef {
  return { kind: "sandbox_policy", id: `sbp_${agentId.slice(4)}`, namespaceId };
}

export function createSandboxPolicyOperations(dependencies: SandboxPolicyDependencies) {
  const { read, transact } = dependencies.transactions;
  const { authorize, authorizationDecision, authorizationAuthority, holdAuthority } =
    dependencies.authority;

  function sandboxDriver(): SandboxDriver | undefined {
    if (!dependencies.hasSandboxSelection()) {
      return undefined;
    }
    try {
      return dependencies.selectSandbox();
    } catch {
      throw new DependencyUnavailableError("The selected Sandbox Driver is unavailable.");
    }
  }

  async function protectedExecutionApplies(
    state: PlatformReadView,
    agent: Readonly<Agent>,
    activeRevision: Readonly<AgentRevision> | undefined,
  ): Promise<boolean> {
    if (activeRevision !== undefined && !unprotectedPolicyRevision(activeRevision)) {
      return true;
    }
    if (!dependencies.hasCredentialProxy()) {
      return false;
    }
    if (
      !dependencies.allowsOrdinaryCredentialGateway() ||
      (agent.repositoryBindings?.length ?? 0) > 0
    ) {
      return true;
    }
    return !(await dependencies.egressAdmission.ordinaryModelBinding(state, agent));
  }

  async function authorizePolicyEdit(principalId: string, namespaceId: string, agentId: string) {
    await authorize(principalId, "manage_policy", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    const resource = policyResource(namespaceId, agentId);
    await authorize(principalId, "update", resource);
    return resource;
  }

  async function authorizePolicyRead(principalId: string, namespaceId: string, agentId: string) {
    await authorize(principalId, "read", { kind: "agent", id: agentId, namespaceId });
    await authorize(principalId, "read", policyResource(namespaceId, agentId));
  }

  function networkPolicyUnavailable(): string | undefined {
    const driver = sandboxDriver();
    if (driver === undefined) {
      return NO_SANDBOX_DRIVER_NETWORK_POLICY;
    }
    return driver.networkPolicy === undefined || driver.admitNetworkPolicy === undefined
      ? SANDBOX_DRIVER_WITHOUT_NETWORK_POLICY
      : undefined;
  }

  function requireNetworkPolicyAvailable(): void {
    const unavailable = networkPolicyUnavailable();
    if (unavailable !== undefined) {
      throw new ResourceStateConflictError(unavailable);
    }
  }

  async function policyConfigurationDescriptor(
    principalId: string,
    agent: Readonly<Agent>,
    policy: Readonly<SandboxPolicy>,
    revision: Readonly<AgentRevision> | undefined,
    facet: SandboxFacet,
  ): Promise<DriverConfigurationDescriptor | undefined> {
    const driver = sandboxDriver();
    if (driver?.networkPolicy === undefined) {
      return undefined;
    }
    const entry = dependencies.resolveConfiguration(
      "sandbox",
      driver.id,
      "agent",
      "sandbox-network-policy",
    );
    const resource = { kind: "agent" as const, id: agent.id, namespaceId: agent.namespaceId };
    const manage = await authorizationDecision(principalId, "manage_policy", resource);
    const update = await authorizationDecision(principalId, "update", {
      kind: "sandbox_policy",
      id: policy.id,
      namespaceId: agent.namespaceId,
    });
    const editable =
      agent.status === "active" &&
      agent.sandboxPolicyEditing === true &&
      policy.application?.state !== "pending";
    const canSave = editable && manage.decision.allowed && update.decision.allowed;
    const canApply =
      canSave &&
      driver.networkPolicy.live &&
      policy.repositoryNetworkPolicy === undefined &&
      revision?.sandboxPolicy?.repositoryNetworkPolicy === undefined &&
      agent.desiredRuntimeState === "running" &&
      unprotectedPolicyRevision(revision) &&
      revision?.sandboxPolicy !== undefined &&
      revision.sandboxDriverId === driver.id;
    const href = `/namespaces/${encodeURIComponent(agent.namespaceId)}/agents/${encodeURIComponent(agent.id)}/sandbox-policy/${facet}`;
    return {
      capability: entry.capability,
      driverId: entry.driverId,
      implementation: entry.implementation,
      scope: entry.contribution.scope,
      key: entry.contribution.key,
      configurationSchema: entry.contribution.configurationSchema,
      binding: entry.binding,
      actions: {
        read: { method: "GET", href, available: true },
        validate: { method: "POST", href: `${href}/validate`, available: canSave },
        save: { method: "PUT", href, available: canSave },
        apply: { method: "POST", href: `${href}/apply`, available: canApply },
      },
    };
  }

  async function validateAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    expectedVersion: number,
    additions: unknown,
  ): Promise<ConfigurationResult<{ readonly additions: readonly SandboxNetworkGrant[] }>> {
    requireNetworkPolicyFacet(facet);
    await authorizePolicyEdit(principalId, namespaceId, agentId);
    requireNetworkPolicyAvailable();
    return read(async (state) => {
      await exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespaceId, agentId);
      const previous = await state.sandboxPolicies.find(namespaceId, agentId);
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
      try {
        const snapshot = admitAgentNetworkPolicy(additions, expectedVersion + 1, undefined, {
          repositoryCredentials: (agent.repositoryBindings?.length ?? 0) > 0,
        });
        if (snapshot.additions.length > 0) {
          const active =
            agent.activeRevisionId === undefined
              ? undefined
              : await state.revisions.findRevision(namespaceId, agentId, agent.activeRevisionId);
          if (await protectedExecutionApplies(state, agent, active)) {
            throw new ProtectedExecutionNetworkPolicyError("save");
          }
        }
        return { success: true, data: { additions: snapshot.additions } };
      } catch (error) {
        if (error instanceof ResourceStateConflictError && error.details?.length) {
          return {
            success: false,
            error: {
              details: error.details as [ErrorDetail, ...ErrorDetail[]],
            },
          };
        }
        throw error;
      }
    });
  }

  const unreadableRevisionReason =
    "This controller cannot read the active revision. Use a compatible controller and Worker to inspect or stop it. You can still clear saved grants.";

  async function activePolicyRevision(
    state: PlatformReadView,
    agent: Readonly<Agent>,
    hasRepositoryPolicy: boolean,
  ) {
    const { namespaceId, id, activeRevisionId } = agent;
    if (activeRevisionId === undefined) {
      return undefined;
    }
    if (!hasRepositoryPolicy) {
      return state.revisions.findRevision(namespaceId, id, activeRevisionId);
    }
    // An older controller can still show and withdraw saved grants when it cannot
    // decode the active revision. Never infer deployed settings from that payload.
    const revision = await state.revisions.findRevisionForBrowsing(
      namespaceId,
      id,
      activeRevisionId,
    );
    return revision && "configurationReadError" in revision ? null : revision;
  }

  async function getAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
  ) {
    requireNetworkPolicyFacet(facet);
    await authorizePolicyRead(principalId, namespaceId, agentId);
    return read(async (state) => {
      await exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespaceId, agentId);
      const policy = await state.sandboxPolicies.find(namespaceId, agentId);
      if (agent === undefined || policy === undefined) {
        throw new ScopeViolationError("The Agent policy is unavailable in this Namespace.");
      }
      const revision = await activePolicyRevision(
        state,
        agent,
        policy.repositoryNetworkPolicy !== undefined,
      );
      const driver = sandboxDriver();
      const unavailableReason =
        revision === null ? unreadableRevisionReason : networkPolicyUnavailable();
      const defaults =
        revision === null
          ? null
          : (revision?.sandboxPolicy?.defaults ??
            driver?.admitNetworkPolicy?.([], policy.version).defaults ??
            null);
      return {
        policy,
        configuration: await policyConfigurationDescriptor(
          principalId,
          agent,
          policy,
          revision ?? undefined,
          facet,
        ),
        editingEnabled: agent.sandboxPolicyEditing === true,
        protectedExecution:
          revision === null ? null : await protectedExecutionApplies(state, agent, revision),
        capability: revision === null ? null : (driver?.networkPolicy ?? null),
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        ceiling: dependencies.ceiling,
        repositoryNetworkPolicyCeiling: dependencies.repositoryCeiling(namespaceId),
        repositoryNetworkPolicySaveSupported:
          state.sandboxPolicies.supportsRepositoryNetworkPolicy === true &&
          policy.repositoryNetworkPolicy !== undefined,
        defaults,
        // A fresh deploy carries the saved version into its Sandbox; no application is
        // requested for it (D773).
        ...(revision?.sandboxPolicy === undefined
          ? {}
          : {
              defaultsRevisionId: revision.id,
              deployedPolicyVersion: revision.sandboxPolicy.version,
            }),
      };
    });
  }

  // TODO: Replace this temporary admission switch with the platform Guardrails primitive.
  async function setAgentSandboxPolicyEditing(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    enabled: boolean,
  ): Promise<Readonly<Agent>> {
    requireNetworkPolicyFacet(facet);
    await authorize(principalId, "administer", {
      kind: "installation",
      id: dependencies.installationId,
    });
    await authorize(principalId, "administer", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return transact(async (state) => {
      await lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespaceId, agentId);
      if (agent === undefined || agent.status !== "active") {
        throw new ResourceStateConflictError("The Agent is unavailable for policy configuration.");
      }
      // Require Driver support when enabling edits. Turning them off stays available.
      const unavailable = networkPolicyUnavailable();
      if (enabled && unavailable !== undefined) {
        // Only an authorized policy reader can distinguish withdrawal from an unavailable edit.
        await authorize(principalId, "read", policyResource(namespaceId, agentId));
        if (
          state.sandboxPolicies.supportsRepositoryNetworkPolicy !== true ||
          (await state.sandboxPolicies.find(namespaceId, agentId))?.repositoryNetworkPolicy ===
            undefined
        ) {
          throw new ResourceStateConflictError(unavailable);
        }
      }
      const updated = await state.agents.setSandboxPolicyEditing(namespaceId, agentId, enabled);
      if (updated === undefined) {
        throw new ResourceStateConflictError("The Agent changed.");
      }
      return updated;
    });
  }

  function admitAgentNetworkPolicy(
    input: unknown,
    version: number,
    defaults?: SandboxPolicySnapshot["defaults"],
    scope?: { readonly repositoryCredentials: boolean },
  ): SandboxPolicySnapshot {
    const driver = sandboxDriver();
    if (driver?.networkPolicy === undefined || driver.admitNetworkPolicy === undefined) {
      throw new ResourceStateConflictError(
        networkPolicyUnavailable() ?? SANDBOX_DRIVER_WITHOUT_NETWORK_POLICY,
      );
    }
    const { contribution } = dependencies.resolveConfiguration(
      "sandbox",
      driver.id,
      "agent",
      "sandbox-network-policy",
    );
    let admissionMessage = "The Sandbox Driver refused the requested policy.";
    try {
      // OCC owns the grant shape it stores and checks against the ceiling. A Driver's
      // contribution can only narrow it, so the shared rules always run first.
      validateSandboxNetworkGrants(input);
      const additions = immutableCopy(input);
      requireConfiguration(contribution, { additions });
      const details = networkGrantAdmissionDetails(
        additions,
        dependencies.ceiling,
        driver.networkPolicy,
        "/additions",
      );
      if (details.length > 0) {
        admissionMessage = details.some((detail) => detail.code === "OUTSIDE_CEILING")
          ? "The requested network policy exceeds the Installation delegation ceiling."
          : "The selected Sandbox Driver does not support the requested wildcard or port range.";
        throw new ConfigurationValidationError(details as [ErrorDetail, ...ErrorDetail[]]);
      }
      return checkedSandboxPolicySnapshot(driver, additions, version, defaults, scope);
    } catch (error) {
      if (error instanceof SandboxNetworkPolicyConflictError) {
        throw error;
      }
      if (error instanceof ConfigurationValidationError) {
        throw new ResourceStateConflictError(admissionMessage, error.error.details);
      }
      throw new ResourceStateConflictError(
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
  }

  // The Driver checks whether saved grants overlap its repository route. Read authority
  // must precede a refusal that names a saved grant.
  async function refuseRepositoryNetworkOverlap(
    principalId: string,
    policy: Readonly<SandboxPolicy> | undefined,
  ): Promise<void> {
    if (policy === undefined || policy.additions.length === 0) {
      return;
    }
    await authorize(principalId, "read", {
      kind: "sandbox_policy",
      id: policy.id,
      namespaceId: policy.namespaceId,
    });
    const driver = sandboxDriver();
    if (!driver?.admitNetworkPolicy) {
      return;
    }
    try {
      driver.admitNetworkPolicy(policy.additions, policy.version, undefined, {
        repositoryCredentials: true,
      });
    } catch (error) {
      if (error instanceof SandboxNetworkPolicyConflictError) {
        throw error;
      }
    }
  }

  async function updateAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    expectedVersion: number,
    additions: readonly SandboxNetworkGrant[],
    repositoryNetworkPolicy?: readonly RepositoryNetworkGrant[],
  ): Promise<Readonly<SandboxPolicy>> {
    requireNetworkPolicyFacet(facet);
    const target = { kind: "agent", id: agentId, namespaceId } as const;
    const sandboxPolicy = policyResource(namespaceId, agentId);
    const explicitList = repositoryNetworkPolicy !== undefined;
    return transact(async (state) => {
      if (explicitList) {
        await holdAuthority(state);
      }
      const authority = explicitList
        ? bindRepositoryPolicyAuthorization(() => authorizationAuthority(principalId))
        : undefined;
      const [iam, decide] = authority?.inputs ?? [];
      const authorizeEdit = async () => {
        await authorize(principalId, "manage_policy", target, iam, decide);
        await authorize(principalId, "update", sandboxPolicy, iam, decide);
      };
      await authorizeEdit();
      if (explicitList && state.sandboxPolicies.supportsRepositoryNetworkPolicy !== true) {
        throw new ResourceStateConflictError(
          "Saving a repository network policy requires an Installation version that supports storing Agent repository grants.",
          [{ path: "/repositoryNetworkPolicy", code: "INVALID_VALUE" }],
        );
      }
      // Withdrawing all desired grants needs no Driver. Keep the capability refusal
      // before the editing and version checks for ordinary network policy updates.
      const clearsRepository =
        Array.isArray(repositoryNetworkPolicy) && repositoryNetworkPolicy.length === 0;
      const clearsAll = clearsRepository && Array.isArray(additions) && additions.length === 0;
      if (!clearsAll) {
        requireNetworkPolicyAvailable();
      }
      await lockNamespace(state, namespaceId);
      if (explicitList) {
        await authorizeEdit();
      }
      const agent = await state.agents.lockAgent(namespaceId, agentId);
      const previous = await state.sandboxPolicies.find(namespaceId, agentId);
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
      if (clearsRepository) {
        await authorize(principalId, "read", sandboxPolicy, iam, decide);
      }
      const withdrawal = clearsRepository && previous.repositoryNetworkPolicy !== undefined;
      if (additions.length > 0 || (repositoryNetworkPolicy !== undefined && !withdrawal)) {
        const active = await activePolicyRevision(
          state,
          agent,
          previous.repositoryNetworkPolicy !== undefined,
        );
        if (active === null) {
          throw new ResourceStateConflictError(unreadableRevisionReason);
        }
        if (await protectedExecutionApplies(state, agent, active)) {
          throw new ProtectedExecutionNetworkPolicyError(
            repositoryNetworkPolicy === undefined ? "save" : "saveRepository",
          );
        }
      }
      if (repositoryNetworkPolicy !== undefined && !withdrawal) {
        throw new ResourceStateConflictError(
          "This Installation cannot deploy a repository network policy. Only an existing list can be cleared.",
        );
      }
      const repositoryGrants = withdrawal ? [] : previous.repositoryNetworkPolicy;
      const admittedAdditions = clearsAll
        ? []
        : admitAgentNetworkPolicy(additions, expectedVersion + 1, undefined, {
            repositoryCredentials: (agent.repositoryBindings?.length ?? 0) > 0,
          }).additions;
      authority?.assertCurrent();
      const updated = await state.sandboxPolicies.save(
        {
          id: previous.id,
          namespaceId,
          agentId,
          version: expectedVersion + 1,
          additions: admittedAdditions,
          ...(repositoryGrants === undefined ? {} : { repositoryNetworkPolicy: repositoryGrants }),
          ...(previous.applied === undefined ? {} : { applied: previous.applied }),
        },
        expectedVersion,
      );
      if (updated === undefined) {
        throw new ResourceStateConflictError("The policy changed.");
      }
      return updated;
    });
  }

  async function applyAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    expectedVersion: number,
    revisionId: string,
    additions?: readonly SandboxNetworkGrant[],
  ): Promise<Readonly<SandboxPolicy>> {
    requireNetworkPolicyFacet(facet);
    const sandboxPolicy = await authorizePolicyEdit(principalId, namespaceId, agentId);
    // Apply can return the saved policy or name an addition in an admission error.
    // Require SandboxPolicy read even for an empty policy.
    await authorize(principalId, "read", sandboxPolicy);
    requireNetworkPolicyAvailable();
    return transact(async (state) => {
      const namespace = await lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespaceId, agentId);
      const policy = await state.sandboxPolicies.find(namespaceId, agentId);
      if (
        namespace.status !== "ready" ||
        agent?.status !== "active" ||
        agent.sandboxPolicyEditing !== true ||
        agent.desiredRuntimeState !== "running" ||
        agent.activeRevisionId !== revisionId ||
        policy?.version !== expectedVersion
      ) {
        throw new ResourceStateConflictError(
          "The Agent, revision, editing setting, or policy changed. Reload before applying.",
        );
      }
      if (policy.application?.state === "pending") {
        throw new ResourceStateConflictError("A policy application is already pending.");
      }
      if (policy.repositoryNetworkPolicy !== undefined) {
        throw new ResourceStateConflictError(
          "Live application cannot enforce repository grants. Use a controller and Worker that support the active revision to stop the Agent and confirm its workload has stopped. Applying the saved policy requires a deployment that can enforce it.",
        );
      }
      const driver = sandboxDriver();
      const revision = await state.revisions.findRevision(namespaceId, agentId, revisionId);
      if (revision?.sandboxPolicy?.repositoryNetworkPolicy !== undefined) {
        throw new ResourceStateConflictError(
          "The active revision has a repository network policy that is missing from the saved policy. Use a controller and Worker that support the active revision to stop the Agent and confirm its workload has stopped.",
        );
      }
      // Qualified artifact snapshots do not make protected revisions eligible for live apply.
      if (revision?.executionAdmission?.mode === "protected") {
        throw new ProtectedExecutionNetworkPolicyError("apply");
      }
      if (
        driver === undefined ||
        !unprotectedPolicyRevision(revision) ||
        revision?.sandboxPolicy === undefined ||
        revision.sandboxDriverId !== driver.id ||
        driver.networkPolicy?.live !== true ||
        driver.applyNetworkPolicy === undefined ||
        driver.observeNetworkPolicy === undefined
      ) {
        throw new ResourceStateConflictError(
          "Live policy application is unavailable for this revision. Deploy explicitly to apply the saved policy.",
        );
      }
      const desired =
        additions === undefined
          ? policy
          : await updateAgentSandboxPolicy(
              principalId,
              namespaceId,
              agentId,
              facet,
              expectedVersion,
              additions,
            );
      const snapshot = admitAgentNetworkPolicy(
        desired.additions,
        desired.version,
        revision.sandboxPolicy.defaults,
        { repositoryCredentials: revision.repositoryCredentials !== undefined },
      );
      const id = crypto.randomUUID();
      const updated = await state.sandboxPolicies.save(
        {
          ...desired,
          application: {
            id,
            revisionId,
            policyVersion: desired.version,
            snapshot,
            state: "pending",
            requestedBy: principalId,
            requestedAt: dependencies.timestamp(),
          },
        },
        desired.version,
      );
      if (updated === undefined) {
        throw new ResourceStateConflictError("The policy changed.");
      }
      await dependencies.record(state, {
        kind: "agent",
        action: "reconcile",
        target: "sandbox_policy",
        namespaceId,
        resourceId: agentId,
        actorId: principalId,
        operationId: id,
      });
      return updated;
    });
  }

  async function readAgentSandboxRecommendations(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    revisionId: string,
    admitRead: (
      read: () => Promise<SandboxPolicyRecommendations>,
    ) => Promise<SandboxPolicyRecommendations>,
  ): Promise<SandboxPolicyRecommendations> {
    requireNetworkPolicyFacet(facet);
    await authorizePolicyRead(principalId, namespaceId, agentId);
    const binding = await read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      const revision = await state.revisions.findRevision(namespaceId, agentId, revisionId);
      if (revision === undefined) {
        throw new ScopeViolationError("The revision is outside this Agent.");
      }
      return { namespace, revision };
    });
    const driver = sandboxDriver();
    if (binding.revision.sandboxDriverId === undefined) {
      throw new ResourceStateConflictError(
        "This version runs without a Sandbox, so it records no network denials to recommend policy from. Policy recommendations need an Agent deployed with a Sandbox Driver such as OpenShell.",
      );
    }
    if (driver?.id !== binding.revision.sandboxDriverId) {
      throw new ResourceStateConflictError(
        "This version runs on a Sandbox Driver that this Installation no longer selects, so its recommendations cannot be read. Deploy a new version to read them.",
      );
    }
    if (driver.readPolicyRecommendations === undefined) {
      throw new ResourceStateConflictError(
        "The selected Sandbox Driver does not offer policy recommendations, so no version can have them.",
      );
    }
    const readRecommendations = driver.readPolicyRecommendations.bind(driver);
    return admitRead(async () => {
      let result: SandboxPolicyRecommendations;
      try {
        const compute = dependencies.selectedCompute();
        if (
          compute.id !== binding.revision.compute.id ||
          compute.implementation !== binding.revision.compute.implementation ||
          compute.resolveSandboxNamespace === undefined
        ) {
          throw new Error("Revision placement is unavailable.");
        }
        const namespace = await compute.resolveSandboxNamespace(binding.namespace);
        result = await readRecommendations(
          { namespace, revision: binding.revision, signal: AbortSignal.timeout(15_000) },
          32,
        );
      } catch {
        throw new DependencyUnavailableError("Sandbox policy recommendations are unavailable.");
      }
      // Reconstruct the public projection: provider fields and full candidate policies never escape.
      if (
        result === null ||
        typeof result !== "object" ||
        !Array.isArray(result.recommendations) ||
        result.recommendations.length > 32 ||
        typeof result.truncated !== "boolean"
      ) {
        throw new DependencyUnavailableError("Invalid Sandbox recommendation response.");
      }
      const recommendations = result.recommendations.map((entry) => {
        try {
          validateSandboxNetworkGrants([entry?.grant]);
        } catch {
          throw new DependencyUnavailableError("Invalid Sandbox recommendation.");
        }
        if (
          !/^[a-zA-Z0-9-]{1,128}$/.test(entry.id) ||
          !["pending", "approved", "rejected"].includes(entry.status) ||
          (entry.observations !== undefined &&
            (!Number.isSafeInteger(entry.observations) || entry.observations < 0))
        ) {
          throw new DependencyUnavailableError("Invalid Sandbox recommendation.");
        }
        return {
          id: entry.id,
          status: entry.status,
          grant: {
            id: entry.grant.id,
            binary: entry.grant.binary,
            host: entry.grant.host,
            ports: entry.grant.ports.map(({ from, to }: { from: number; to: number }) => ({
              from,
              to,
            })),
          },
          ...(entry.observations === undefined ? {} : { observations: entry.observations }),
        };
      });
      if (
        result.providerVersion !== undefined &&
        (typeof result.providerVersion !== "string" ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(result.providerVersion))
      ) {
        throw new DependencyUnavailableError("Invalid Sandbox recommendation version.");
      }
      return immutableCopy({
        recommendations,
        truncated: result.truncated,
        ...(result.providerVersion === undefined
          ? {}
          : { providerVersion: result.providerVersion }),
      });
    });
  }

  async function admitDeploymentSnapshot(
    policy: Readonly<SandboxPolicy> | undefined,
    principalId: string,
    agent: Pick<Agent, "id" | "namespaceId">,
    revisionHarness: Pick<RevisionHarnessDescriptor, "id" | "mode">,
    sandbox: SandboxDriver | undefined,
    executionAdmission: ExecutionAdmission,
    repositoryCredentials: boolean,
    policyAlreadyAuthorized = false,
  ): Promise<SandboxPolicySnapshot | undefined> {
    const policyScope = { repositoryCredentials };
    // Finding 2053: protected execution refuses Agent additions, never drops them. Only an
    // explicitly acknowledged artifact snapshot can accompany dedicated Codex repository
    // execution. The caller learns of saved additions only with SandboxPolicy read access.
    // Finding 2151: every refusal below that names saved additions (protected execution, the
    // ceiling, the Driver) comes after SandboxPolicy read, so a deployer without it learns nothing.
    const protectedExecution = executionAdmission.mode === "protected";
    if (policy !== undefined && policy.additions.length > 0) {
      if (!policyAlreadyAuthorized) {
        await dependencies.authority.authorize(principalId, "read", {
          kind: "sandbox_policy",
          id: policy.id,
          namespaceId: agent.namespaceId,
        });
      }
      if (protectedExecution) {
        throw new ProtectedExecutionNetworkPolicyError("deploy");
      }
    }
    let sandboxPolicy: SandboxPolicySnapshot | undefined;
    if (protectedExecution) {
      if (
        revisionHarness.id === "codex" &&
        revisionHarness.mode === "dedicated" &&
        repositoryCredentials
      ) {
        sandboxPolicy = checkedProtectedCodexArtifactPolicy(sandbox, policy?.version ?? 1);
      }
    } else if ((policy?.additions.length ?? 0) > 0) {
      sandboxPolicy = admitAgentNetworkPolicy(
        policy!.additions,
        policy!.version,
        undefined,
        policyScope,
      );
    } else if (sandbox?.admitNetworkPolicy !== undefined) {
      sandboxPolicy = checkedSandboxPolicySnapshot(
        sandbox,
        [],
        policy?.version ?? 1,
        undefined,
        policyScope,
      );
    }
    if ((policy?.additions.length ?? 0) > 0 && sandboxPolicy === undefined) {
      throw new ResourceStateConflictError(
        "The selected Sandbox Driver cannot enforce this Agent's network policy.",
      );
    }
    return sandboxPolicy;
  }

  return {
    sandboxDriver,
    validateAgentSandboxPolicy,
    getAgentSandboxPolicy,
    setAgentSandboxPolicyEditing,
    updateAgentSandboxPolicy,
    applyAgentSandboxPolicy,
    readAgentSandboxRecommendations,
    refuseRepositoryNetworkOverlap,
    admitDeploymentSnapshot,
  };
}

export async function deploymentSandboxPolicy(
  state: Pick<PlatformReadView, "sandboxPolicies">,
  authority: Pick<ControllerAuthority, "authorize">,
  principalId: string,
  namespaceId: string,
  agentId: string,
): Promise<Readonly<SandboxPolicy> | undefined> {
  const policy = await state.sandboxPolicies.find(namespaceId, agentId);
  if (policy?.repositoryNetworkPolicy !== undefined) {
    await authority.authorize(principalId, "read", {
      kind: "sandbox_policy",
      id: policy.id,
      namespaceId,
    });
    throw new ResourceStateConflictError(
      "This Installation cannot enforce the saved repository network policy. Deploy with an Installation that supports it.",
    );
  }
  return policy;
}
