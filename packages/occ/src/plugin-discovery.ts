import { pluginOwner } from "./agent-plugin-validation.ts";
import type { AgentCredentialAccess } from "./agent-credential-access.ts";
import { credentialGatewayOperation } from "./credential-source-drivers.ts";
import { driverOperation } from "./driver-operation.ts";
import { isDeepStrictEqual } from "node:util";
import {
  isSecretHarnessAuth,
  pathCovered,
  type Agent,
  type AgentPluginCredentialSlot,
  type Configuration,
  type ConnectionTemplateVersion,
  type CredentialGatewayDriver,
  type StoredCredentialSource,
  type CredentialSourceContext,
  type CredentialSourceReference,
  type HarnessExecutionMode,
  type Namespace,
  type PluginCatalogEntry,
  type PluginCatalogPage,
  type PluginDesiredState,
  type PluginDiscoveryAuthentication,
  type PluginDriver,
  type RevisionHarnessDescriptor,
  type SecretDriver,
  type SecretReference,
  type SavedAgentPluginCredentialSlot,
  type TokenServiceDriver,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { resolveConfiguredHarnessId, type ModelPolicyAgent } from "./configured-harness.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  AgentDeletingError,
  ConfigurationHarnessError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  NotImplementedError,
  PluginDiscoveryError,
  PluginPolicyValidationError,
  ResourceStateConflictError,
  ScopeViolationError,
  SecretBindingValidationError,
} from "./errors.ts";
import { harnessAuthBinding } from "./harness-auth.ts";
import type { ConfigurationOwnership } from "./ports/configurations.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import { exactAgent, exactNamespace } from "./resource-scope.ts";
import { secretOperation } from "./secret-operations.ts";

export type PluginDiscoveryCredential = {
  readonly accessToken?: string;
  readonly secretRef?: SecretReference;
  readonly credentialSource?: CredentialSourceReference;
};

type PluginDiscoveryOutcome<T> =
  { value: T } | { error: PluginDiscoveryError } | { validationError: unknown };

export type ManagedMcpConnection = { readonly slot: string; readonly sourceId: string };

export type ManagedMcpToolReader = (
  endpoint: string,
  accessToken: string,
  signal?: AbortSignal,
  options?: {
    readonly allowedMethods: readonly ("POST" | "GET" | "DELETE")[];
    readonly beforeRequest: () => Promise<void>;
  },
) => Promise<ReadonlySet<string>>;

type PluginHarness = Pick<RevisionHarnessDescriptor, "id" | "mode">;

interface PluginDiscoveryDependencies {
  readonly transactions: Pick<ControllerTransactions, "read">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "authorizationDecision" | "canRead">;
  readonly authorizedCredentialSource: (
    principalId: string,
    namespaceId: string,
    sourceId: string,
  ) => Promise<{
    gateway: CredentialGatewayDriver;
    context: CredentialSourceContext & { signal: AbortSignal };
  }>;
  readonly sourceReader:
    | {
        readonly gateway: CredentialGatewayDriver;
        readonly withSourceToken: NonNullable<CredentialGatewayDriver["withSourceToken"]>;
      }
    | undefined;
  readonly ownedTokenServiceDriver: (instanceId: string) => TokenServiceDriver;
  readonly authorizePluginCredentialSources: AgentCredentialAccess["authorizePluginCredentialSources"];
  readonly qualifyPluginCredentialSource: AgentCredentialAccess["qualifyPluginCredentialSource"];
  readonly secretDriver: (driverId: string) => SecretDriver;
  readonly readConfiguration: (
    metadata: ConfigurationOwnership,
  ) => Promise<Readonly<Configuration>>;
  readonly modelPolicyAgent: (executionMode: HarnessExecutionMode) => ModelPolicyAgent;
  readonly pluginDriver: (harnessId: string) => PluginDriver;
  readonly validatePluginPlacement: (
    driver: PluginDriver,
    plugins: PluginDesiredState,
    harness: Readonly<PluginHarness>,
    stagedPluginIds?: ReadonlySet<string>,
  ) => void;
}

const PLUGIN_ID_SHAPE = /^[A-Za-z0-9._~:@-]{1,253}$/u;

/**
 * Discovery's refusal for a plugin ID the selected Driver does not offer. It names the IDs only
 * in the selection-key shape, and the offered ID only as the versioned form of the rejected one.
 * The request body has no `/plugins` member, so the refusal has no request path.
 */
function undiscoveredPlugin(
  driverId: string,
  error: PluginPolicyValidationError,
): PluginPolicyValidationError {
  const pluginId =
    error.pluginId !== undefined && PLUGIN_ID_SHAPE.test(error.pluginId)
      ? error.pluginId
      : undefined;
  const offeredId =
    pluginId !== undefined &&
    error.offeredId !== undefined &&
    PLUGIN_ID_SHAPE.test(error.offeredId) &&
    error.offeredId.startsWith(`${pluginId}@`)
      ? error.offeredId
      : undefined;
  return new PluginPolicyValidationError(
    "unknownPlugin",
    driverId,
    pluginId,
    offeredId,
  ).withoutRequestPath();
}

async function invokePluginDiscovery<T>(
  driver: PluginDriver,
  discover: (authentication: PluginDiscoveryAuthentication) => Promise<T>,
  withCredential: (
    invoke: (authentication: PluginDiscoveryAuthentication) => Promise<PluginDiscoveryOutcome<T>>,
  ) => Promise<PluginDiscoveryOutcome<T>>,
  validateCurrent: () => Promise<void>,
  signal?: AbortSignal,
): Promise<T> {
  const invoke = async (
    authentication: PluginDiscoveryAuthentication,
  ): Promise<PluginDiscoveryOutcome<T>> => {
    try {
      await validateCurrent();
    } catch (error) {
      // Preserve exact authorization/binding errors across the Driver's sanitized callback.
      return { validationError: error };
    }
    try {
      signal?.throwIfAborted();
      const value = await discover(authentication);
      const serialized = JSON.stringify(value);
      const encodedToken =
        authentication.accessToken === undefined
          ? undefined
          : JSON.stringify(authentication.accessToken).slice(1, -1);
      if (
        serialized === undefined ||
        (encodedToken !== undefined &&
          (encodedToken.length === 0 || serialized.includes(encodedToken)))
      ) {
        throw new PluginDiscoveryError("invalid_response");
      }
      return { value };
    } catch (error) {
      // Rebuild the unknown Plugin refusal to omit Driver-authored text.
      if (error instanceof PluginPolicyValidationError && error.pluginId !== undefined) {
        return { validationError: undiscoveredPlugin(driver.id, error) };
      }
      return {
        error: new PluginDiscoveryError(
          error instanceof PluginDiscoveryError ? error.reason : "unavailable",
        ),
      };
    }
  };
  const outcome = await withCredential(invoke);
  if ("error" in outcome) {
    throw outcome.error;
  }
  if ("validationError" in outcome) {
    throw outcome.validationError;
  }
  return outcome.value;
}

export function createPluginDiscovery(dependencies: PluginDiscoveryDependencies) {
  const { read } = dependencies.transactions;
  const { authorize, authorizationDecision, canRead } = dependencies.authority;

  async function discoverAgentPlugins(
    principalId: string,
    namespaceId: string,
    input: PluginDiscoveryCredential & {
      readonly harnessId: string;
      readonly cursor?: string;
      readonly q?: string;
    },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    const page = await withNamespacePluginCredential(
      principalId,
      namespaceId,
      input,
      signal,
      (driver) => {
        if (!driver.discoverCatalog) {
          throw new NotImplementedError(
            "agent_plugins.discovery",
            "Plugin discovery is unavailable.",
          );
        }
        return (authentication) => {
          if (authentication.accessToken === undefined && driver.discoveryCredential !== "none") {
            throw new PluginDiscoveryError("credentials_rejected");
          }
          return driver.discoverCatalog!(
            {
              ...authentication,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.q === undefined ? {} : { q: input.q }),
            },
            signal,
          );
        };
      },
    );
    const driver = dependencies.pluginDriver(input.harnessId);
    if (!driver.credentials) {
      return page;
    }
    const credentialSlots = await read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      return readableCredentialSlots(state, principalId, namespaceId, driver);
    });
    return { ...page, credentialSlots };
  }

  async function discoverAgentPluginDetails(
    principalId: string,
    namespaceId: string,
    input: PluginDiscoveryCredential & {
      readonly harnessId: string;
      readonly pluginId: string;
      readonly managedConnection?: ManagedMcpConnection;
    },
    signal?: AbortSignal,
    readMcpTools?: ManagedMcpToolReader,
  ): Promise<PluginCatalogEntry> {
    if (input.managedConnection) {
      if (!readMcpTools || input.credentialSource || input.accessToken || input.secretRef) {
        throw new NotImplementedError(
          "agent_plugins.discovery",
          "Managed MCP discovery is unavailable.",
        );
      }
      return discoverManagedMcpTools(
        principalId,
        namespaceId,
        { harnessId: input.harnessId },
        input.pluginId,
        input.managedConnection,
        readMcpTools,
        signal,
      );
    }
    return withNamespacePluginCredential(principalId, namespaceId, input, signal, (driver) => {
      if (!driver.getCatalogPlugin) {
        throw new NotImplementedError(
          "agent_plugins.discovery",
          "Plugin tool discovery is unavailable.",
        );
      }
      return (authentication) => {
        if (authentication.accessToken === undefined && driver.discoveryCredential !== "none") {
          throw new PluginDiscoveryError("credentials_rejected");
        }
        return driver.getCatalogPlugin!({ ...authentication, pluginId: input.pluginId }, signal);
      };
    });
  }

  async function withNamespacePluginCredential<T>(
    principalId: string,
    namespaceId: string,
    input: PluginDiscoveryCredential & { readonly harnessId: string },
    signal: AbortSignal | undefined,
    prepareDiscovery: (
      driver: PluginDriver,
    ) => (authentication: PluginDiscoveryAuthentication) => Promise<T>,
  ): Promise<T> {
    const agentScope = { kind: "agent" as const, id: namespaceId, namespaceId };
    await authorize(principalId, "create", agentScope);
    await read((state) => exactNamespace(state, namespaceId));
    const getDriver = () => dependencies.pluginDriver(input.harnessId);
    return withPluginDiscoveryCredential(
      principalId,
      namespaceId,
      input,
      getDriver,
      prepareDiscovery,
      async (driver, source) => {
        // A stored credential's backend read can outlive its grants or the selected catalog.
        await authorize(principalId, "create", agentScope);
        if (source) {
          await authorize(principalId, "operate", source);
        }
        await read((state) => exactNamespace(state, namespaceId));
        if (getDriver() !== driver) {
          throw new ResourceStateConflictError("The plugin catalog changed. Refresh and retry.");
        }
      },
      signal,
    );
  }

  async function withPluginDiscoveryCredential<T>(
    principalId: string,
    namespaceId: string,
    credential: PluginDiscoveryCredential,
    getDriver: () => PluginDriver,
    prepareDiscovery: (
      driver: PluginDriver,
    ) => (authentication: PluginDiscoveryAuthentication) => Promise<T>,
    validateCurrent: (
      driver: PluginDriver,
      source: SecretReference | CredentialSourceReference | undefined,
    ) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<T> {
    const { credentialSource, accessToken, secretRef } = credential;
    const source = secretRef ?? credentialSource;
    if (source !== undefined) {
      if (
        source.namespaceId !== namespaceId ||
        (secretRef !== undefined && source.kind !== "secret") ||
        (credentialSource !== undefined && source.kind !== "credential_source")
      ) {
        throw new SecretBindingValidationError(
          source.kind === "secret"
            ? "Secret references cannot cross Namespaces."
            : "Credential-source references must identify the exact Namespace.",
        );
      }
      await authorize(principalId, "operate", source);
    }
    const driver = getDriver();
    if (
      driver.discoveryCredential === "none" &&
      (source !== undefined || credential.accessToken !== undefined)
    ) {
      throw new ConfigurationHarnessError(
        "The selected catalog does not accept discovery credentials. Remove the credential and try again.",
      );
    }
    const discover = prepareDiscovery(driver);
    const recheck = () => validateCurrent(driver, source);
    if (credentialSource !== undefined) {
      const selected = await read(async (state) => {
        const namespace = await exactNamespace(state, namespaceId);
        const found = await state.credentialSources.findCredentialSource(
          namespaceId,
          credentialSource.id,
        );
        if (namespace.status !== "ready" || found?.state !== "ready") {
          throw new ResourceStateConflictError(
            "The credential source is unavailable. Connect again.",
          );
        }
        return found;
      });
      if (selected.ownerCapability === "token_service") {
        if (selected.type !== "oauth2-refresh-token" || selected.consent.kind !== "builtin_codex") {
          throw new ResourceStateConflictError(
            "Choose a signed-in account Source for this catalog.",
          );
        }
        const owner = dependencies.ownedTokenServiceDriver(selected.tokenServiceInstanceId);
        const account = selected.consent.account;
        const deadline = AbortSignal.timeout(30_000);
        const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        return invokePluginDiscovery(
          driver,
          discover,
          async (invoke) => {
            const resolved = await driverOperation(
              () =>
                owner.resolveCredential(
                  {
                    sourceRef: credentialSource,
                    tokenServiceInstanceId: selected.tokenServiceInstanceId,
                  },
                  requestSignal,
                ),
              "TokenService",
            );
            return invoke({
              accessToken: resolved.credential,
              accountId: account.accountId,
              isFedramp: account.isFedramp,
            });
          },
          async () => {
            await recheck();
            const current = await read((state) =>
              state.credentialSources.findCredentialSource(namespaceId, credentialSource.id),
            );
            if (
              current?.state !== "ready" ||
              current.ownerCapability !== "token_service" ||
              current.type !== "oauth2-refresh-token" ||
              current.consent.kind !== "builtin_codex" ||
              current.tokenServiceInstanceId !== selected.tokenServiceInstanceId ||
              !isDeepStrictEqual(current.consent.account, account) ||
              dependencies.ownedTokenServiceDriver(current.tokenServiceInstanceId) !== owner
            ) {
              throw new ResourceStateConflictError(
                "The account Source changed. Refresh and retry.",
              );
            }
          },
          signal,
        );
      }
      const { gateway, context } = await dependencies.authorizedCredentialSource(
        principalId,
        namespaceId,
        credentialSource.id,
      );
      const reader = dependencies.sourceReader;
      const selectedReader = reader?.gateway === gateway ? reader.withSourceToken : undefined;
      if (!selectedReader && !gateway.withSourceToken) {
        throw new NotImplementedError(
          "agent_plugins.discovery",
          "The Credential Gateway does not support plugin discovery.",
        );
      }
      if (signal !== undefined) {
        context.signal = AbortSignal.any([context.signal, signal]);
      }
      return invokePluginDiscovery(
        driver,
        discover,
        (invoke) =>
          credentialGatewayOperation(() => {
            context.signal.throwIfAborted();
            if (selectedReader) {
              return selectedReader(context, invoke);
            }
            // Preserve external callback invocation and its late/disconnect controls.
            return gateway.withSourceToken!(context, invoke);
          }),
        async () => {
          await recheck();
          await dependencies.authorizedCredentialSource(
            principalId,
            namespaceId,
            credentialSource.id,
          );
        },
        signal,
      );
    }
    return invokePluginDiscovery(
      driver,
      discover,
      (invoke) => {
        if (accessToken !== undefined) {
          return invoke({ accessToken });
        }
        return secretRef === undefined
          ? invoke({})
          : withPluginDiscoverySecret(namespaceId, secretRef, invoke);
      },
      recheck,
      signal,
    );
  }

  async function withPluginDiscoverySecret<T>(
    namespaceId: string,
    reference: SecretReference,
    use: (authentication: PluginDiscoveryAuthentication) => Promise<T>,
  ): Promise<T> {
    if (reference.namespaceId !== namespaceId) {
      throw new SecretBindingValidationError("Secret references cannot cross Namespaces.");
    }
    const secret = await read(async (state) => {
      const found = await state.secrets.findSecret(namespaceId, reference.id);
      if (!found) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      return found;
    });
    const driver = dependencies.secretDriver(secret.driverId);
    if (!driver.withValue) {
      throw new DependencyUnavailableError(
        "The selected Secret Driver cannot use credentials for discovery.",
      );
    }
    return secretOperation(() => driver.withValue!(secret, (accessToken) => use({ accessToken })));
  }

  async function readableCredentialSlots(
    state: PlatformReadView,
    principalId: string,
    namespaceId: string,
    driver: PluginDriver,
    agent?: Readonly<Agent>,
  ): Promise<readonly AgentPluginCredentialSlot[]> {
    if (!driver.credentials) {
      return [];
    }
    const sources: StoredCredentialSource[] = [];
    const templates = new Map<string, ConnectionTemplateVersion>();
    for (const source of await state.credentialSources.listCredentialSources(namespaceId)) {
      const ref = { kind: "credential_source" as const, namespaceId, id: source.id };
      if (source.state !== "ready" || !(await canRead(principalId, ref))) {
        continue;
      }
      if (source.ownerCapability !== "token_service") {
        if (
          agent?.credentialSources?.some(({ sourceId }) => sourceId === source.id) &&
          (await authorizationDecision(agent.servicePrincipalId, "operate", ref)).decision.allowed
        ) {
          sources.push(source);
        }
        continue;
      }
      if (!source.connectionTemplateId) {
        continue;
      }
      try {
        const template = await dependencies.qualifyPluginCredentialSource(
          state,
          namespaceId,
          source,
        );
        sources.push(source);
        templates.set(source.id, template);
      } catch (error) {
        if (!(
          error instanceof ResourceStateConflictError || error instanceof DependencyUnavailableError
        )) {
          throw error;
        }
      }
    }
    return driver.credentials.choices(sources, templates);
  }

  async function savedCredentialSlots(
    state: PlatformReadView,
    principalId: string,
    namespaceId: string,
    driver: PluginDriver,
    agent: Readonly<Agent>,
  ): Promise<readonly SavedAgentPluginCredentialSlot[]> {
    const slots = await readableCredentialSlots(state, principalId, namespaceId, driver, agent);
    if (!driver.credentials) {
      return slots;
    }
    const bound = new Map<string, Readonly<Record<string, Readonly<Record<string, string>>>>>();
    for (const [pluginId, selection] of Object.entries(agent.plugins ?? {})) {
      if (!selection.enabled || !slots.some((slot) => slot.pluginId === pluginId)) {
        continue;
      }
      try {
        const selected = await verifiedSavedPluginBindings(
          state,
          namespaceId,
          driver,
          agent,
          pluginId,
        );
        if (selected) {
          bound.set(pluginId, selected);
        }
      } catch (error) {
        if (!(error instanceof DependencyUnavailableError)) {
          throw error;
        }
      }
    }
    return slots.map((slot) => {
      const sourceId = bound.get(slot.pluginId)?.[slot.id]?.default;
      return sourceId === undefined ? slot : { ...slot, boundSourceId: sourceId };
    });
  }

  async function verifiedSavedPluginBindings(
    state: PlatformReadView,
    namespaceId: string,
    driver: PluginDriver,
    agent: Readonly<Agent>,
    pluginId: string,
  ): Promise<Readonly<Record<string, Readonly<Record<string, string>>>> | undefined> {
    const credentials = driver.credentials;
    const selection = agent.plugins?.[pluginId];
    if (!credentials || !selection?.enabled) {
      return undefined;
    }
    try {
      const selected = credentials.selectedBindings({ pluginId, selection });
      const sources = new Map<string, StoredCredentialSource>();
      const templates = new Map<string, ConnectionTemplateVersion>();
      for (const accounts of Object.values(selected)) {
        for (const sourceId of Object.values(accounts)) {
          if (sources.has(sourceId)) {
            continue;
          }
          const ref = { kind: "credential_source" as const, namespaceId, id: sourceId };
          if (
            !(await authorizationDecision(agent.servicePrincipalId, "operate", ref)).decision
              .allowed
          ) {
            return undefined;
          }
          const source = await state.credentialSources.findCredentialSource(namespaceId, sourceId);
          if (source?.ownerCapability !== "token_service" || source.state !== "ready") {
            return undefined;
          }
          templates.set(
            sourceId,
            await dependencies.qualifyPluginCredentialSource(state, namespaceId, source),
          );
          sources.set(sourceId, source);
        }
      }
      const modelBinding = harnessAuthBinding(agent.harnessAuth);
      await credentials.validate(
        { [pluginId]: selection },
        [...sources.values()],
        modelBinding?.method === "credential_source" ? modelBinding.sourceId : undefined,
        templates,
      );
      return selected;
    } catch (error) {
      if (
        error instanceof ConfigurationHarnessError ||
        error instanceof ResourceStateConflictError ||
        error instanceof PluginPolicyValidationError
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async function getSavedAgentPluginPolicyCapabilities(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ) {
    return withSavedPluginTarget(
      principalId,
      namespaceId,
      agentId,
      async ({ state, agent, driver }) => {
        return immutableCopy({
          driver: { id: driver.id, implementation: driver.implementation },
          ...driver.policyCapabilities,
          ...(driver.credentials && agent.executionMode === "dedicated"
            ? {
                credentialSlots: await savedCredentialSlots(
                  state,
                  principalId,
                  namespaceId,
                  driver,
                  agent,
                ),
              }
            : {}),
          discoveryCredential: driver.discoveryCredential ?? "required",
        });
      },
    );
  }

  async function discoverSavedAgentPlugins(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: {
      readonly cursor?: string;
      readonly q?: string;
      readonly credentialSource?: CredentialSourceReference;
    },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    const {
      value: page,
      driver,
      harness,
    } = await withSavedAgentPluginCredential(
      principalId,
      namespaceId,
      agentId,
      (driver) => {
        if (!driver.discoverCatalog) {
          throw new NotImplementedError(
            "agent_plugins.discovery",
            "Plugin discovery is unavailable.",
          );
        }
        return (authentication) =>
          driver.discoverCatalog!(
            {
              ...authentication,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.q === undefined ? {} : { q: input.q }),
            },
            signal,
          );
      },
      input.credentialSource,
      signal,
    );
    if (page.plugins.length === 0) {
      return page;
    }
    return {
      ...page,
      plugins: page.plugins.filter((entry) => {
        try {
          dependencies.validatePluginPlacement(driver, { [entry.id]: { enabled: true } }, harness);
          return true;
        } catch (error) {
          if (error instanceof ConfigurationHarnessError) {
            return false;
          }
          throw error;
        }
      }),
    };
  }

  async function discoverSavedAgentPluginDetails(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: {
      readonly pluginId: string;
      readonly credentialSource?: CredentialSourceReference;
      readonly managedConnection?: ManagedMcpConnection;
    },
    signal?: AbortSignal,
    readMcpTools?: ManagedMcpToolReader,
  ): Promise<PluginCatalogEntry> {
    if (input.managedConnection) {
      if (!readMcpTools || input.credentialSource) {
        throw new NotImplementedError(
          "agent_plugins.discovery",
          "Managed MCP discovery is unavailable.",
        );
      }
      return discoverManagedMcpTools(
        principalId,
        namespaceId,
        { agentId },
        input.pluginId,
        input.managedConnection,
        readMcpTools,
        signal,
      );
    }
    const {
      value: entry,
      driver,
      harness,
    } = await withSavedAgentPluginCredential(
      principalId,
      namespaceId,
      agentId,
      (driver) => {
        if (!driver.getCatalogPlugin) {
          throw new NotImplementedError(
            "agent_plugins.discovery",
            "Plugin tool discovery is unavailable.",
          );
        }
        return (authentication) =>
          driver.getCatalogPlugin!({ ...authentication, pluginId: input.pluginId }, signal);
      },
      input.credentialSource,
      signal,
    );
    dependencies.validatePluginPlacement(driver, { [entry.id]: { enabled: true } }, harness);
    return entry;
  }

  async function withSavedPluginTarget<T>(
    principalId: string,
    namespaceId: string,
    agentId: string,
    use: (target: {
      state: PlatformReadView;
      namespace: Readonly<Namespace>;
      agent: Readonly<Agent>;
      driver: PluginDriver;
      harness: PluginHarness;
    }) => Promise<T>,
  ): Promise<T> {
    const resource = { kind: "agent" as const, id: agentId, namespaceId };
    const authorizeAgent = async () => {
      await authorize(principalId, "read", resource);
      await authorize(principalId, "update", resource);
    };
    const readMetadata = async (state: PlatformReadView) => {
      const { namespace, agent } = await exactAgent(state, namespaceId, agentId);
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      const metadata = await state.configurations.findConfiguration(
        namespace.id,
        agent.configurationId,
      );
      if (!metadata) {
        throw new ScopeViolationError("The Agent Configuration is unavailable in its Namespace.");
      }
      return { namespace, agent, metadata };
    };
    await authorizeAgent();
    const { metadata } = await read(readMetadata);
    // A Configuration Driver may read Kubernetes. Release the database connection first.
    const configuration = await dependencies.readConfiguration(metadata);
    await authorizeAgent();
    return read(async (state) => {
      const current = await readMetadata(state);
      if (
        current.metadata.id !== metadata.id ||
        current.metadata.generation !== metadata.generation
      ) {
        throw new ResourceStateConflictError("The Agent Configuration changed. Refresh and retry.");
      }
      const { agent, namespace } = current;
      const harness = {
        id: resolveConfiguredHarnessId(
          configuration.values,
          dependencies.modelPolicyAgent(agent.executionMode),
        ),
        mode: agent.executionMode,
      };
      const driver = dependencies.pluginDriver(harness.id);
      pluginOwner(driver, agent);
      return use({ state, namespace, agent, driver, harness });
    });
  }

  async function discoverManagedMcpTools(
    principalId: string,
    namespaceId: string,
    context: { readonly agentId: string } | { readonly harnessId: string },
    pluginId: string,
    connection: ManagedMcpConnection,
    readTools: ManagedMcpToolReader,
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    const sourceRef = { kind: "credential_source" as const, id: connection.sourceId, namespaceId };
    const currentTarget = async () => {
      const inspect = async ({
        state,
        namespace,
        agent,
        driver,
        harness,
      }: {
        state: PlatformReadView;
        namespace: Readonly<Namespace>;
        agent?: Readonly<Agent>;
        driver: PluginDriver;
        harness: PluginHarness;
      }) => {
        const callerAllowed = (await authorizationDecision(principalId, "operate", sourceRef))
          .decision.allowed;
        let credentialPrincipal = principalId;
        if (!callerAllowed) {
          const saved =
            agent &&
            (await verifiedSavedPluginBindings(state, namespaceId, driver, agent, pluginId))?.[
              connection.slot
            ]?.default === sourceRef.id;
          if (!agent || !saved) {
            await authorize(principalId, "operate", sourceRef);
          } else {
            await authorize(agent.servicePrincipalId, "operate", sourceRef);
            credentialPrincipal = agent.servicePrincipalId;
          }
        }
        const source = await state.credentialSources.findCredentialSource(
          namespace.id,
          sourceRef.id,
        );
        if (namespace.status !== "ready" || source?.state !== "ready") {
          throw new ResourceStateConflictError(
            "Choose a ready, compatible credential source for this Plugin slot.",
          );
        }
        let template: ConnectionTemplateVersion | undefined;
        let secretRef: SecretReference | undefined;
        if (source.ownerCapability === "token_service") {
          const qualified = await dependencies.authorizePluginCredentialSources(
            state,
            credentialPrincipal,
            namespaceId,
            [
              {
                pluginId,
                requirement: connection.slot,
                connection: "default",
                sourceId: source.id,
              },
            ],
            async () => source,
          );
          template = qualified.templates.get(source.id);
          if (!template) {
            throw new ResourceStateConflictError(
              "The Plugin Source has no approved Connection Template.",
            );
          }
        } else {
          if (
            !callerAllowed ||
            !agent ||
            !agent.credentialSources?.some(({ sourceId }) => sourceId === source.id)
          ) {
            throw new ResourceStateConflictError(
              "Choose a ready, compatible credential source from this Agent's saved credentials.",
            );
          }
          await authorize(agent.servicePrincipalId, "operate", sourceRef);
          secretRef = source.secrets.token;
        }
        const target = driver.credentials?.mcpToolDiscovery?.(
          pluginId,
          connection.slot,
          source,
          template,
        );
        if (!target || (source.ownerCapability !== "token_service" && !secretRef)) {
          throw new ResourceStateConflictError(
            "Choose a ready, compatible credential source for this Plugin slot.",
          );
        }
        const endpoint = new URL(target.endpoint);
        const methods =
          template?.mode === "static_bearer"
            ? (["POST", "GET", "DELETE"] as const).filter((method) =>
                template.destinations.some(
                  (destination) =>
                    destination.method === method &&
                    destination.host === endpoint.hostname &&
                    destination.port === Number(endpoint.port || 443) &&
                    pathCovered(endpoint.pathname, destination.path),
                ),
              )
            : (["POST", "GET", "DELETE"] as const);
        return {
          driver,
          harness,
          source,
          secretRef,
          ...(agent && { servicePrincipalId: agent.servicePrincipalId }),
          ...target,
          methods,
        };
      };
      if ("agentId" in context) {
        return withSavedPluginTarget(principalId, namespaceId, context.agentId, inspect);
      }
      const scope = { kind: "agent" as const, id: namespaceId, namespaceId };
      await authorize(principalId, "create", scope);
      return read(async (state) => {
        const namespace = await exactNamespace(state, namespaceId);
        return inspect({
          state,
          namespace,
          driver: dependencies.pluginDriver(context.harnessId),
          harness: { id: context.harnessId, mode: "dedicated" },
        });
      });
    };

    const target = await currentTarget();
    const entry = await target.driver.getCatalogPlugin?.({ pluginId }, signal);
    if (!entry || entry.id !== pluginId) {
      throw new PluginDiscoveryError("invalid_response");
    }
    const selection = { [entry.id]: { enabled: true } };
    const staged =
      target.source.ownerCapability === "token_service" ? new Set([pluginId]) : undefined;
    dependencies.validatePluginPlacement(target.driver, selection, target.harness, staged);
    const validateCurrent = async () => {
      const current = await currentTarget();
      if (current.driver !== target.driver || !isDeepStrictEqual(current, target)) {
        throw new ResourceStateConflictError(
          "The Agent's plugin credential or catalog changed. Refresh and retry.",
        );
      }
      dependencies.validatePluginPlacement(current.driver, selection, current.harness, staged);
    };
    let result: PluginCatalogEntry;
    try {
      result = await invokePluginDiscovery(
        target.driver,
        async ({ accessToken }) => {
          if (!accessToken) {
            throw new PluginDiscoveryError("credentials_rejected");
          }
          const names = await readTools(target.endpoint, accessToken, signal, {
            allowedMethods: target.methods,
            beforeRequest: validateCurrent,
          });
          return {
            ...entry,
            tools: [...names].map((name) => ({
              id: name,
              name,
              ownerId: entry.id,
            })),
          };
        },
        async (invoke) => {
          if (target.source.ownerCapability !== "token_service") {
            return withPluginDiscoverySecret(namespaceId, target.secretRef!, invoke);
          }
          const source = target.source;
          const owner = dependencies.ownedTokenServiceDriver(source.tokenServiceInstanceId);
          const deadline = AbortSignal.timeout(30_000);
          const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
          const resolved = await driverOperation(
            () =>
              owner.resolveCredential(
                { sourceRef, tokenServiceInstanceId: source.tokenServiceInstanceId },
                operation,
              ),
            "TokenService",
          );
          operation.throwIfAborted();
          await validateCurrent();
          return invoke({ accessToken: resolved.credential });
        },
        validateCurrent,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      await validateCurrent();
      throw error;
    }
    await validateCurrent();
    return result;
  }

  async function withSavedAgentPluginCredential<T>(
    principalId: string,
    namespaceId: string,
    agentId: string,
    prepareDiscovery: (
      driver: PluginDriver,
    ) => (authentication: PluginDiscoveryAuthentication) => Promise<T>,
    credentialSource?: CredentialSourceReference,
    signal?: AbortSignal,
  ) {
    const readTarget = () =>
      savedDiscoveryTarget(principalId, namespaceId, agentId, credentialSource);
    const { driver, harness, source, credential } = await readTarget();
    const validateCurrent = async () => {
      const current = await readTarget();
      if (
        current.driver !== driver ||
        !isDeepStrictEqual(current.harness, harness) ||
        !isDeepStrictEqual(current.source, source)
      ) {
        throw new ResourceStateConflictError(
          "The Agent's plugin credential or catalog changed. Refresh and retry.",
        );
      }
    };
    const value = await withPluginDiscoveryCredential(
      principalId,
      namespaceId,
      credential,
      () => driver,
      prepareDiscovery,
      validateCurrent,
      signal,
    );
    // A hosted read can outlive the Agent's selection, even after a valid credential handoff.
    await validateCurrent();
    return { value, driver, harness };
  }

  async function savedDiscoveryTarget(
    principalId: string,
    namespaceId: string,
    agentId: string,
    credentialSource?: CredentialSourceReference,
  ) {
    return withSavedPluginTarget(
      principalId,
      namespaceId,
      agentId,
      async ({ state, namespace, agent, driver, harness }) => {
        if (credentialSource !== undefined && namespace.status !== "ready") {
          throw new NamespaceNotReadyError();
        }
        const target = { driver, harness };
        if (agent.executionMode !== "dedicated") {
          throw new NotImplementedError(
            "agent_plugins.saved_discovery",
            "Saved plugin discovery requires a dedicated Agent.",
          );
        }
        if (credentialSource === undefined && target.driver.discoveryCredential === "none") {
          return {
            ...target,
            source: undefined,
            credential: {},
          };
        }
        const binding = harnessAuthBinding(agent.harnessAuth);
        if (
          credentialSource !== undefined &&
          target.driver.discoveryCredential !== "none" &&
          (binding?.method !== "credential_source" ||
            binding.sourceId !== credentialSource.id ||
            credentialSource.namespaceId !== namespaceId)
        ) {
          throw new ResourceStateConflictError(
            "The selected credential source is not bound to this Agent's Harness.",
          );
        }
        const reference =
          credentialSource ??
          (binding?.method === "credential_source"
            ? { kind: "credential_source" as const, namespaceId, id: binding.sourceId }
            : undefined);
        if (reference !== undefined) {
          if (reference.namespaceId !== namespaceId) {
            throw new SecretBindingValidationError(
              "Credential-source references must identify the exact Namespace.",
            );
          }
          await authorize(principalId, "operate", reference);
          if (
            credentialSource !== undefined &&
            !(binding?.method === "credential_source" && binding.sourceId === reference.id) &&
            !agent.credentialSources?.some(({ sourceId }) => sourceId === reference.id)
          ) {
            throw new ResourceStateConflictError("Choose a credential source bound to this Agent.");
          }
          await authorize(agent.servicePrincipalId, "operate", reference);
          const source = await state.credentialSources.findCredentialSource(
            namespaceId,
            reference.id,
          );
          if (source?.state !== "ready") {
            throw new ScopeViolationError("The Agent's plugin credential source is unavailable.");
          }
          return { ...target, source, credential: { credentialSource: reference } };
        }
        if (binding?.method !== "codex_pat" || !isSecretHarnessAuth(binding)) {
          throw new NotImplementedError(
            "agent_plugins.saved_discovery",
            "Stored plugin discovery requires a dedicated Agent with a Service Accounts Secret.",
          );
        }
        if (binding.source.namespaceId !== namespace.id) {
          throw new ScopeViolationError("The Agent's plugin credential crosses Namespaces.");
        }
        await authorize(principalId, "operate", binding.source);
        await authorize(agent.servicePrincipalId, "operate", binding.source);
        const secret = await state.secrets.findSecret(namespace.id, binding.source.id);
        if (secret === undefined) {
          throw new ScopeViolationError("The Agent's plugin credential is unavailable.");
        }
        return { ...target, source: secret, credential: { secretRef: binding.source } };
      },
    );
  }

  return {
    discoverAgentPlugins,
    discoverAgentPluginDetails,
    getSavedAgentPluginPolicyCapabilities,
    discoverSavedAgentPlugins,
    discoverSavedAgentPluginDetails,
  };
}
