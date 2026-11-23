import { pluginOwner } from "./agent-plugin-validation.ts";
import { credentialSourceRef, isManagedTokenServiceSource } from "./credential-source-metadata.ts";
import { credentialGatewayOperation } from "./credential-source-drivers.ts";
import { isDeepStrictEqual } from "node:util";
import {
  isSecretHarnessAuth,
  type Agent,
  type Configuration,
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
) => Promise<ReadonlySet<string>>;

type PluginHarness = Pick<RevisionHarnessDescriptor, "id" | "mode">;

interface PluginDiscoveryDependencies {
  readonly transactions: Pick<ControllerTransactions, "read">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "canRead">;
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
  const { authorize, canRead } = dependencies.authority;

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
    return withNamespacePluginCredential(principalId, namespaceId, input, signal, (driver) => {
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
    });
  }

  async function discoverAgentPluginDetails(
    principalId: string,
    namespaceId: string,
    input: PluginDiscoveryCredential & { readonly harnessId: string; readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
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
        const sources: StoredCredentialSource[] = [];
        if (driver.credentials && agent.executionMode === "dedicated") {
          for (const source of await state.credentialSources.listCredentialSources(namespaceId)) {
            if (
              isManagedTokenServiceSource(source) &&
              source.state === "ready" &&
              (await canRead(principalId, credentialSourceRef(source)))
            ) {
              sources.push(source);
            }
          }
        }
        return immutableCopy({
          driver: { id: driver.id, implementation: driver.implementation },
          ...driver.policyCapabilities,
          ...(driver.credentials && agent.executionMode === "dedicated"
            ? { credentialSlots: driver.credentials.choices(sources) }
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
        agentId,
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
    agentId: string,
    pluginId: string,
    connection: ManagedMcpConnection,
    readTools: ManagedMcpToolReader,
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    const sourceRef = { kind: "credential_source" as const, id: connection.sourceId, namespaceId };
    const currentTarget = async () => {
      await authorize(principalId, "operate", sourceRef);
      const target = await withSavedPluginTarget(
        principalId,
        namespaceId,
        agentId,
        async ({ state, namespace, agent, driver, harness }) => {
          const source = await state.credentialSources.findCredentialSource(
            namespace.id,
            sourceRef.id,
          );
          const target =
            namespace.status === "ready" &&
            source?.state === "ready" &&
            agent.credentialSources?.some(({ sourceId }) => sourceId === sourceRef.id)
              ? driver.credentials?.mcpToolDiscovery?.(pluginId, connection.slot, source)
              : undefined;
          const secretRef =
            source?.ownerCapability === "token_service" ? undefined : source?.secrets.token;
          if (!target || !secretRef) {
            throw new ResourceStateConflictError(
              "Choose a ready, compatible credential source from this Agent's saved credentials.",
            );
          }
          return {
            driver,
            harness,
            source,
            secretRef,
            servicePrincipalId: agent.servicePrincipalId,
            ...target,
          };
        },
      );
      await authorize(principalId, "operate", sourceRef);
      await authorize(target.servicePrincipalId, "operate", sourceRef);
      return target;
    };

    const target = await currentTarget();
    const entry = await target.driver.getCatalogPlugin?.({ pluginId }, signal);
    if (!entry || entry.id !== pluginId) {
      throw new PluginDiscoveryError("invalid_response");
    }
    const selection = { [entry.id]: { enabled: true } };
    dependencies.validatePluginPlacement(target.driver, selection, target.harness);
    await authorize(principalId, "operate", sourceRef);
    const validateCurrent = async () => {
      const current = await currentTarget();
      if (current.driver !== target.driver || !isDeepStrictEqual(current, target)) {
        throw new ResourceStateConflictError(
          "The Agent's plugin credential or catalog changed. Refresh and retry.",
        );
      }
      dependencies.validatePluginPlacement(current.driver, selection, current.harness);
    };
    const result = await invokePluginDiscovery(
      target.driver,
      async ({ accessToken }) => {
        if (!accessToken) {
          throw new PluginDiscoveryError("credentials_rejected");
        }
        const names = await readTools(target.endpoint, accessToken, signal);
        return {
          ...entry,
          tools: [...names].map((name) => ({
            id: name,
            name,
            ownerId: entry.id,
          })),
        };
      },
      // TODO(#4450): Acquire a usable managed MCP bearer through the Token Service once
      // it supports these sources (#3811), and cover refresh of expired access tokens.
      // Preserve the authorization recheck below; this direct Secret read requires a
      // token that is already usable.
      (invoke) => withPluginDiscoverySecret(namespaceId, target.secretRef, invoke),
      validateCurrent,
      signal,
    );
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
        if (credentialSource !== undefined || target.driver.discoveryCredential === "none") {
          return {
            ...target,
            source: undefined,
            credential: credentialSource ? { credentialSource } : {},
          };
        }
        const binding = harnessAuthBinding(agent.harnessAuth);
        if (binding?.method === "credential_source") {
          const reference = {
            kind: "credential_source" as const,
            namespaceId,
            id: binding.sourceId,
          };
          await authorize(principalId, "operate", reference);
          await authorize(agent.servicePrincipalId, "operate", reference);
          const source = await state.credentialSources.findCredentialSource(
            namespaceId,
            binding.sourceId,
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
