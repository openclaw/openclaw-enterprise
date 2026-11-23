import type { CredentialSourceDrivers } from "./credential-source-drivers.ts";
import { validatePluginCredentialSources } from "./agent-plugin-validation.ts";
import {
  describePluginBindings,
  pluginSourceIds,
  type SelectedPluginBinding,
  type PluginSourceTemplate,
} from "./plugin-credential-bindings.ts";
import { isManagedTokenServiceSource } from "./credential-source-metadata.ts";
import {
  MAX_AGENT_CREDENTIAL_SOURCES,
  isSecretHarnessAuth,
  type AccessBinding,
  type Agent,
  type AgentCredentialSourceBinding,
  type ComputeDriver,
  type StoredCredentialSource,
  type CredentialSourceReference,
  type CredentialSourceSnapshot,
  type HarnessAuthBinding,
  type PluginDriver,
  type RevisionHarnessDescriptor,
  type SandboxDriver,
  type SecretBindings,
  type SecretReference,
} from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { DriverRegistry } from "./driver-registry.ts";
import {
  AgentCredentialSourceBindingError,
  CredentialProxyAdmissionError,
  CredentialSourceTypeNotOfferedError,
  DependencyUnavailableError,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import { iamPolicyOperation, type IAMPolicyOperations } from "./iam-policy-operations.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";

type AgentOperateSource = SecretReference | CredentialSourceReference;

interface AgentCredentialAccessDependencies {
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "authorizeAgentPrincipal" | "authorizationDecision"
  >;
  readonly iamPolicy: Pick<IAMPolicyOperations, "iamPolicyDriver" | "occBindingDriver">;
  readonly drivers: Pick<DriverRegistry, "hasSelection">;
  readonly installationId: string;
  readonly timestamp: () => string;
  readonly sourceDrivers: Pick<
    CredentialSourceDrivers,
    "assertCredentialSourceOwnerSelected" | "credentialSourceOwner" | "credentialSourceType"
  >;
  readonly requireTokenServiceOwner: (instanceId: string) => void;
  readonly offersProtectedType: (type: string) => boolean;
}

export function parseAgentCredentialSources(
  value: unknown,
): readonly AgentCredentialSourceBinding[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  if (!Array.isArray(value) || value.length > MAX_AGENT_CREDENTIAL_SOURCES) {
    throw new ScopeViolationError("The Agent credential sources are invalid.");
  }
  return Object.freeze(
    value.map((entry: unknown) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Object.keys(entry).length !== 1 ||
        !isNonEmptyString((entry as { sourceId?: unknown }).sourceId) ||
        seen.has((entry as { sourceId: string }).sourceId)
      ) {
        throw new ScopeViolationError("The Agent credential sources are invalid.");
      }
      const sourceId = (entry as { sourceId: string }).sourceId;
      seen.add(sourceId);
      return Object.freeze({ sourceId });
    }),
  );
}

/** `credentialSources` lists every source; `harnessAuth` names the one the Harness uses. */
export function assertHarnessSourceListed(
  bindings: readonly AgentCredentialSourceBinding[],
  harnessAuth: HarnessAuthBinding | null | undefined,
): void {
  if (
    harnessAuth?.method === "credential_source" &&
    !bindings.some(({ sourceId }) => sourceId === harnessAuth.sourceId)
  ) {
    throw new AgentCredentialSourceBindingError();
  }
}

function agentOperateSources(
  agent: Readonly<Agent>,
  secretBindings: SecretBindings,
  pluginBindings: readonly SelectedPluginBinding[],
) {
  const referenced = new Map<string, AgentOperateSource>();
  const add = (kind: AgentOperateSource["kind"], id: string): void => {
    referenced.set(`${kind}\u0000${id}`, { kind, namespaceId: agent.namespaceId, id });
  };
  for (const binding of Object.values(secretBindings)) {
    add("secret", binding.source.id);
  }
  if (isSecretHarnessAuth(agent.harnessAuth)) {
    add("secret", agent.harnessAuth.source.id);
  } else if (agent.harnessAuth?.method === "credential_source") {
    add("credential_source", agent.harnessAuth.sourceId);
  }
  for (const { sourceId } of agent.credentialSources ?? []) {
    add("credential_source", sourceId);
  }
  for (const id of pluginSourceIds(pluginBindings)) {
    add("credential_source", id);
  }
  return referenced.values();
}

export function createAgentCredentialAccess({
  authority,
  iamPolicy,
  drivers,
  installationId,
  timestamp,
  sourceDrivers,
  requireTokenServiceOwner,
  offersProtectedType,
}: AgentCredentialAccessDependencies) {
  function authorizeSourceOperate(principalId: string, namespaceId: string, sourceId: string) {
    return authority.authorize(principalId, "operate", {
      kind: "credential_source",
      namespaceId,
      id: sourceId,
    });
  }

  /**
   * `operate` on each source an Agent already binds, so an update cannot swap out or drop a
   * source the caller may not use. It reads no record, so it answers the same whether or not the
   * source still exists, is ready, or belongs to the selected gateway.
   */
  async function authorizeBoundCredentialSources(
    principalId: string,
    namespaceId: string,
    bindings: readonly AgentCredentialSourceBinding[],
  ): Promise<void> {
    for (const { sourceId } of bindings) {
      await authorizeSourceOperate(principalId, namespaceId, sourceId);
    }
  }

  /**
   * Namespace lock serializes binding, source deletion, and admission. The listing rule is
   * checked after every source authorization and lookup, so it never answers before a 403.
   */
  async function authorizeAgentCredentialSources(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: readonly AgentCredentialSourceBinding[],
    harnessAuth: HarnessAuthBinding | null | undefined,
  ): Promise<readonly StoredCredentialSource[]> {
    const sources: StoredCredentialSource[] = [];
    for (const { sourceId } of bindings) {
      await authorizeSourceOperate(principalId, namespaceId, sourceId);
      const source = await state.credentialSources.lockCredentialSource(namespaceId, sourceId);
      if (!isManagedTokenServiceSource(source)) {
        sourceDrivers.assertCredentialSourceOwnerSelected();
      }
      if (source === undefined || source.state !== "ready") {
        throw new ScopeViolationError(
          "The credential source is unavailable in the exact Namespace.",
        );
      }
      if (
        source.ownerCapability === "credential_proxy" &&
        !drivers.hasSelection("credential_proxy")
      ) {
        // The exact-source grant has passed. Report the missing Proxy without naming the source.
        throw new CredentialProxyAdmissionError("sourcesWithoutProxy");
      }
      if (isManagedTokenServiceSource(source)) {
        requireTokenServiceOwner(source.tokenServiceInstanceId);
        if (source.type !== "static" || source.connectionTemplateId !== undefined) {
          throw new ResourceStateConflictError(
            "Template-associated Source admission is not implemented.",
          );
        }
        if (harnessAuth?.method !== "credential_source" || harnessAuth.sourceId !== source.id) {
          throw new ResourceStateConflictError(
            "This TokenService source must authenticate the selected Agent Harness.",
          );
        }
      } else {
        sourceDrivers.credentialSourceOwner(source);
      }
      sources.push(source);
    }
    assertHarnessSourceListed(bindings, harnessAuth);
    return sources;
  }

  /** Authorize each reported Source and resolve the Template version for this admission. */
  async function authorizePluginCredentialSources(
    state: PlatformReadView,
    principalId: string,
    namespaceId: string,
    bindings: readonly SelectedPluginBinding[],
    resolveSource: (sourceId: string) => Promise<Readonly<StoredCredentialSource> | undefined>,
    attached: readonly StoredCredentialSource[] = [],
  ) {
    const sources = new Map(attached.map((source) => [source.id, source]));
    const templates = new Map<string, PluginSourceTemplate>();
    for (const sourceId of pluginSourceIds(bindings)) {
      let source = sources.get(sourceId);
      if (source === undefined) {
        await authorizeSourceOperate(principalId, namespaceId, sourceId);
        source = await resolveSource(sourceId);
      }
      if (!isManagedTokenServiceSource(source) || source.state !== "ready") {
        throw new ResourceStateConflictError(
          "The Plugin connection requires a ready TokenService Source.",
        );
      }
      requireTokenServiceOwner(source.tokenServiceInstanceId);
      if (source.connectionTemplateId === undefined) {
        throw new ResourceStateConflictError(
          "The Plugin Source requires an associated Connection Template.",
        );
      }
      const template = await state.connectionTemplates.findConnectionTemplate(
        source.connectionTemplateId,
      );
      if (
        !template ||
        (template.namespaceId !== undefined && template.namespaceId !== namespaceId)
      ) {
        throw new ResourceStateConflictError(
          "The Plugin Source's Connection Template is unavailable.",
        );
      }
      const current = template.current;
      if (source.type === "static") {
        if (current.mode !== "static_bearer") {
          throw new ResourceStateConflictError(
            "The static Plugin Source requires a static bearer Connection Template.",
          );
        }
        templates.set(sourceId, { current });
      } else {
        if (
          current.mode !== "manual" ||
          source.consent.kind !== "connection_template" ||
          source.consent.revocationRequestedBy !== undefined ||
          source.consent.revokedAt !== undefined
        ) {
          throw new ResourceStateConflictError(
            "The Plugin Source requires active OAuth consent for an HTTP Connection Template.",
          );
        }
        const consent =
          current.version === source.consent.version
            ? current
            : await state.connectionTemplates.findOAuthConnectionTemplateVersion(
                template.id,
                source.consent.version,
              );
        if (consent?.mode !== "manual" || consent.oauthClientId !== source.consent.oauthClientId) {
          throw new ResourceStateConflictError(
            "The Plugin Source's original OAuth consent version is unavailable.",
          );
        }
        templates.set(sourceId, { current, consent });
      }
      sources.set(sourceId, source);
    }
    return { sources: [...sources.values()], templates };
  }

  /** Freeze explicit and Plugin-selected Sources after checking the Agent principal's exact grants. */
  async function admitCredentialSources(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    sandbox: SandboxDriver | undefined,
    driver: PluginDriver | undefined,
    harness: RevisionHarnessDescriptor,
    compute: ComputeDriver,
    selected: readonly SelectedPluginBinding[],
  ) {
    const explicit = agent.credentialSources ?? [];
    const attached =
      explicit.length === 0
        ? []
        : await authorizeAgentCredentialSources(
            state,
            principalId,
            agent.namespaceId,
            explicit,
            agent.harnessAuth,
          );
    const plugin = await authorizePluginCredentialSources(
      state,
      principalId,
      agent.namespaceId,
      selected,
      (sourceId) => state.credentialSources.lockCredentialSource(agent.namespaceId, sourceId),
      attached,
    );
    const { sources } = plugin;
    if (sources.length > MAX_AGENT_CREDENTIAL_SOURCES) {
      throw new ScopeViolationError("The Agent revision has too many credential sources.");
    }
    if (sources.length > 0 && sandbox === undefined) {
      throw new ResourceStateConflictError(
        "Agent credential sources require a selected Sandbox Driver.",
      );
    }
    await validatePluginCredentialSources(driver, agent.plugins, sources, agent.harnessAuth);
    const descriptions = await describePluginBindings(driver, agent.plugins, selected, sources);
    const snapshots: CredentialSourceSnapshot[] = [];
    for (const source of sources) {
      const sourceId = source.id;
      await authority.authorizeAgentPrincipal(principalId, agent, "operate", {
        kind: "credential_source",
        namespaceId: agent.namespaceId,
        id: sourceId,
      });
      compute.validateHarnessCredentialSources?.(harness, [source]);
      if (isManagedTokenServiceSource(source)) {
        const current = plugin.templates.get(sourceId)?.current;
        snapshots.push({
          sourceId,
          tokenServiceInstanceId: source.tokenServiceInstanceId,
          sourceType: source.type,
          ...(current && {
            connectionTemplate: { id: current.templateId, version: current.version },
          }),
        });
      } else {
        const owner = sourceDrivers.credentialSourceOwner(source);
        if (owner.kind === "proxy") {
          if (!offersProtectedType(source.type)) {
            throw new CredentialSourceTypeNotOfferedError("proxy");
          }
          snapshots.push({ sourceId, credentialProxyId: owner.driver.id, sourceType: source.type });
        } else {
          await sourceDrivers.credentialSourceType(owner.driver, source.type);
          snapshots.push({
            sourceId,
            credentialGatewayId: owner.driver.id,
            sourceType: source.type,
          });
        }
      }
    }
    return {
      snapshots: immutableCopy(snapshots),
      descriptions,
      templates: plugin.templates,
    };
  }

  /** Returns the AccessBindings it created; existing exact grants are kept. */
  async function ensureAgentOperateGrants(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agent: Readonly<Agent>,
    sources: readonly AgentOperateSource[],
  ): Promise<readonly Readonly<AccessBinding>[]> {
    const created: Readonly<AccessBinding>[] = [];
    if (sources.length === 0) {
      return created;
    }
    const driver = iamPolicy.iamPolicyDriver("createNamespaceAccessBinding");
    if (driver.namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "The selected IAM Driver does not support provisioning policy transactions.",
      );
    }
    for (const resourceKind of ["secret", "credential_source"] as const) {
      const matching = sources.filter((source) => source.kind === resourceKind);
      if (matching.length === 0) {
        continue;
      }
      const displayName = resourceKind === "secret" ? "Secret" : "credential source";
      const roleId = `role_${namespaceId}_agent_${resourceKind}_operate`;
      const existingRole = await state.iamPolicy.getRole(namespaceId, roleId);
      if (
        existingRole !== undefined &&
        (existingRole.namespaceId !== namespaceId ||
          existingRole.permissions.length !== 1 ||
          existingRole.permissions[0]?.action !== "operate" ||
          existingRole.permissions[0]?.resourceKind !== resourceKind)
      ) {
        throw new ResourceConflictError(
          `The provisioning Role does not have the exact Namespace and ${displayName} permission.`,
        );
      }
      if (existingRole === undefined) {
        await iamPolicyOperation(() =>
          driver.createNamespaceRole!(
            { policy: state.iamPolicy },
            {
              id: roleId,
              namespaceId,
              name: `Agent ${displayName} operate`,
              permissions: [{ action: "operate", resourceKind }],
            },
          ),
        );
      }
      const bindings = await state.iamPolicy.listAccessBindings(namespaceId);
      for (const source of matching) {
        const exists = bindings.some(
          (binding) =>
            binding.subjectKind === "identity" &&
            binding.subjectId === agent.servicePrincipalId &&
            binding.roleId === roleId &&
            binding.resourceKind === resourceKind &&
            binding.resourceId === source.id,
        );
        if (exists) {
          continue;
        }
        created.push(
          await iamPolicyOperation(() =>
            driver.createNamespaceAccessBinding!(
              { policy: state.iamPolicy },
              {
                id: `binding_${agent.id}_${source.id}_operate`,
                namespaceId,
                subjectKind: "identity",
                subjectId: agent.servicePrincipalId,
                roleId,
                resourceKind,
                resourceId: source.id,
              },
            ),
          ),
        );
      }
    }
    return created;
  }

  /** Ensure exact Source-use grants for every submitted Plugin selection. */
  async function grantSelectedPluginSources(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    selected: readonly string[],
  ): Promise<void> {
    const created = await ensureAgentOperateGrants(
      state,
      agent.namespaceId,
      agent,
      selected.map((id) => ({ kind: "credential_source", namespaceId: agent.namespaceId, id })),
    );
    for (const binding of created) {
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId,
        namespaceId: agent.namespaceId,
        occurredAt: timestamp(),
        kind: "mutation",
        actorId: principalId,
        source: "occ",
        action: "openclaw.iam.access_bindings.create",
        resource: {
          kind: "credential_source",
          id: binding.resourceId!,
          namespaceId: agent.namespaceId,
        },
        outcome: "success",
        details: {
          bindingId: binding.id,
          subjectKind: binding.subjectKind,
          subjectId: binding.subjectId,
          roleId: binding.roleId,
          reason: "agent_plugin_selection",
          agentId: agent.id,
        },
      });
    }
  }

  /**
   * A caller allowed to deploy the Agent gives its ServicePrincipal the exact operate grant it
   * lacks on each referenced Secret and credential source that the caller can operate, in the
   * deploy unit (RFC-0026). A source the caller cannot operate gets no grant; the Agent principal
   * checks that follow then refuse the deploy.
   */
  async function grantDeployedAgentSources(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
    secretBindings: SecretBindings,
    pluginBindings: readonly SelectedPluginBinding[] = [],
  ): Promise<void> {
    if (iamPolicy.occBindingDriver("createNamespaceAccessBinding") === undefined) {
      return;
    }
    const missing: AgentOperateSource[] = [];
    for (const source of agentOperateSources(agent, secretBindings, pluginBindings)) {
      const caller = (await authority.authorizationDecision(principalId, "operate", source))
        .decision;
      if (!caller.allowed) {
        continue;
      }
      const current = await authority.authorizationDecision(
        agent.servicePrincipalId,
        "operate",
        source,
      );
      if (!current.decision.allowed) {
        missing.push(source);
      }
    }
    for (const binding of await ensureAgentOperateGrants(
      state,
      agent.namespaceId,
      agent,
      missing,
    )) {
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId,
        namespaceId: agent.namespaceId,
        occurredAt: timestamp(),
        kind: "mutation",
        actorId: principalId,
        source: "occ",
        action: "openclaw.iam.access_bindings.create",
        resource: {
          kind: binding.resourceKind as "secret" | "credential_source",
          id: binding.resourceId as string,
          namespaceId: agent.namespaceId,
        },
        outcome: "success",
        details: {
          bindingId: binding.id,
          subjectKind: binding.subjectKind,
          subjectId: binding.subjectId,
          roleId: binding.roleId,
          reason: "agent_deploy",
          agentId: agent.id,
        },
      });
    }
  }

  return {
    authorizeBoundCredentialSources,
    authorizeAgentCredentialSources,
    authorizePluginCredentialSources,
    admitCredentialSources,
    ensureAgentOperateGrants,
    grantSelectedPluginSources,
    grantDeployedAgentSources,
  };
}

export type AgentCredentialAccess = ReturnType<typeof createAgentCredentialAccess>;
