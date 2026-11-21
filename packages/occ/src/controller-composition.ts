import { createAgentAutomations } from "./agent-automations.ts";
import {
  reconcileNamespaceLifecycle,
  type NamespaceLifecycleBinding,
  type NamespaceLifecycleEvidence,
} from "./namespace-lifecycle.ts";
import { createNamespaceOperations, type NamespaceOperations } from "./namespace-operations.ts";
import { createConnectionAdministration } from "./connection-administration.ts";
import {
  CONNECTION_OPERATION_TIMEOUT_MS,
  createSavedConnections,
} from "./saved-oauth-connections.ts";
import { NativeIAMDriver } from "@openclaw-enterprise/iam";
import {
  createIAMPolicyOperations,
  iamPolicyOperation,
  type IAMPolicyOperations,
  type InstallationIAMConfiguration,
} from "./iam-policy-operations.ts";
import {
  createRepositoryPolicyOperations,
  type InstallationRepositoryAdmission,
  validateRepositoryBrokerNetworkProxy,
} from "./repository-policy.ts";
import { EgressSendReceipts } from "./egress-send-receipts.ts";
import { createEgressAuthority } from "./credential-egress-authority.ts";
import {
  credentialSourceMetadata,
  isManagedTokenServiceSource,
} from "./credential-source-metadata.ts";
import {
  createCredentialSourceOperations,
  type CredentialSourceOperations,
} from "./credential-source-operations.ts";
import {
  CREDENTIAL_GATEWAY_TIMEOUT_MS,
  createCredentialSourceDrivers,
  credentialGatewayOperation,
} from "./credential-source-drivers.ts";
import { createCredentialEgressAdmission } from "./credential-egress-admission.ts";
import type { TokenService, EgressRef } from "@openclaw-enterprise/contracts";
import {
  resolveCredentialProxyCapacity,
  type CredentialProxyCapacity,
} from "./credential-proxy.ts";
import type { EgressExchangeOwner } from "@openclaw-enterprise/contracts";
import { AgentRuntimeCredentials } from "./agent-runtime-credentials.ts";
import { createPresetOperations, type BundledPresetVersion } from "./preset-operations.ts";
import {
  DriverConfigurationRegistry,
  type DriverConfigurationRegistration,
} from "./configuration-registry.ts";
import type { SandboxNetworkGrant } from "@openclaw-enterprise/contracts";
import { validateSandboxNetworkGrants } from "@openclaw-enterprise/contracts";
import { createSandboxPolicyOperations } from "./sandbox-policy.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAgentAuditReader } from "./agent-audit-reader.ts";
import {
  createControllerWorkRecorder,
  type ControllerWorkRecorder,
} from "./controller-work-recorder.ts";
import {
  createControllerResourceValues,
  type ControllerResourceValues,
} from "./controller-resource-values.ts";
import { AgentRuntimeObservations } from "./agent-runtime-observations.ts";
import { createPluginDiscovery } from "./plugin-discovery.ts";
import { deviceAuthorizationCipher } from "./device-authorization.ts";
import { createDeviceAuthorizationFlow } from "./device-authorization-flow.ts";
import type {
  Agent,
  AgentRevision,
  ComputeDriver,
  ConfigurationValidationOptions,
  CredentialGatewayDriver,
  Installation,
  InstallationDeploymentInventory,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  LoggingLevel,
  OpenClawConfigurationDocument,
  PresetDraftDefinition,
  BackendDefinition,
  RevisionHarnessDescriptor,
  ResourceKind,
  SandboxDriver,
  SecretBindings,
} from "@openclaw-enterprise/contracts";
import { isName, NAME_RULE, normalizeLoggingLevel } from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import { createAgentQueries, type ActiveAgentRevisionSelection } from "./agent-queries.ts";
import { createDeploymentChannelChecks } from "./deployment-channels.ts";
import { createAgentDeploymentOperations } from "./agent-deployment-requests.ts";
import type { DeployAgentInput } from "./deployment-authorization.ts";
import { createAgentDraftOperations } from "./agent-drafts.ts";
import {
  createAgentPluginValidation,
  normalizeAgentPluginApprovers,
  pluginOwner,
  validatePluginCredentialSources,
} from "./agent-plugin-validation.ts";
import { DriverRegistry } from "./driver-registry.ts";
import { driverOperation } from "./driver-operation.ts";
import { readDeploymentInventory } from "./deployment-inventory.ts";
import { SetupDiscovery } from "./setup-discovery.ts";
import { createInstallationCapabilityQueries } from "./installation-capabilities.ts";
import {
  DependencyUnavailableError,
  ConfigurationHarnessError,
  configurationSettingMessage,
  NotImplementedError,
  ResourceStateConflictError,
  ScopeViolationError,
  PostgresCommitOutcomeUnknownError,
} from "./errors.ts";
import { createAgentCredentialWithdrawal } from "./agent-credential-withdrawal.ts";
import { createAgentTermination } from "./agent-termination.ts";
import { enabledChannelEntries, requireChannelSecretBindings } from "./channel-secret-bindings.ts";
import {
  admitsOpenClawExecutionMode,
  agentRuntimeConfiguration,
  createModelPolicyAgent,
  createSavedAgentTopologyValidator,
  type HarnessResolver,
} from "./agent-harness-topology.ts";
import { createHarnessAuthOperations } from "./harness-auth.ts";
import {
  nativeWorkerSupportSource,
  type NativeWorkerSupport,
  type NativeWorkerSupportSource,
} from "./native-worker-support.ts";
import {
  backendDefinitionMap,
  resolveAgentBackendId,
  validateBackendDefinitions,
  validateSelectedBackendDrivers,
} from "./backends.ts";
import {
  createManagedCredentialSources,
  type ManagedCredentialSources,
} from "./managed-credential-sources.ts";
import type { AgentAuditState } from "./ports/agent-audit.ts";
import {
  createControllerAuthority,
  type ControllerAuthority,
  type ControllerAuthorizationOverride,
} from "./controller-authority.ts";
import {
  createControllerTransactions,
  type ControllerTransactions,
} from "./controller-transactions.ts";
import {
  createAgentCredentialAccess,
  type AgentCredentialAccess,
} from "./agent-credential-access.ts";
import { exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";
import { InMemoryPlatformState } from "./state/platform-state.ts";
import type { PlatformOperation } from "./ports/platform-operations.ts";
import type { PlatformStateStore } from "./ports/platform-state-store.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { createProvisioningRequests } from "./agent-provisioning-requests.ts";
import { createProvisioningWorker } from "./agent-provisioning-worker.ts";
import { createSecretOperations, sameSecretBackend, secretOperation } from "./secret-operations.ts";
import {
  createConfigurationOperations,
  rejectCrossNamespaceSecretSources,
  storedSecretBindings,
} from "./configuration-operations.ts";
import { createServiceAccountOperations } from "./service-account-operations.ts";

export interface ControllerOptions {
  /** Key material for sealed authentication-state payloads (device-login challenge and handle). */
  readonly authenticationStateEncryptionSecret?: string;
  readonly namespaceLifecycleBindings?: readonly NamespaceLifecycleBinding[] | undefined;
  /** Code-only composition binding for the bundled retained-source plugin reader. */
  readonly pluginSourceReader?: {
    readonly gateway: CredentialGatewayDriver;
    readonly withSourceToken: NonNullable<CredentialGatewayDriver["withSourceToken"]>;
  };
  readonly preparedTokens?: TokenService | undefined;
  readonly driverConfigurations?: readonly DriverConfigurationRegistration[];
  readonly sandboxNetworkPolicyCeiling?: readonly SandboxNetworkGrant[];
  /** Installation configuration `iam`; `applyIAMConfiguration` writes it to IAM policy. */
  readonly iamConfiguration?: InstallationIAMConfiguration;
  readonly authorize?: ControllerAuthorizationOverride;
  readonly now?: () => Date;
  readonly createId?: (kind: ResourceKind) => string;
  readonly state?: PlatformStateStore;
  readonly agentAuditState?: AgentAuditState<PlatformUnitOfWork>;
  readonly recordOperations?: boolean;
  readonly backends?: readonly BackendDefinition[];
  readonly defaultPresets?: readonly PresetDraftDefinition[];
  /**
   * Every shipped version of the bundled default Presets, current and superseded, loaded
   * whether or not `presets.includeDefaults` seeds them. Startup refreshes Namespace copies
   * still equal to a superseded version, and Namespace deletion treats any of them as
   * unmodified release content.
   */
  readonly bundledPresetVersions?: readonly BundledPresetVersion[];
  /**
   * Installation startup `presets.includeDefaults`. Only then are `defaultPresets` the bundled
   * defaults whose superseded copies startup refreshes; a `presets.files` entry never is, even
   * one that repeats a bundled file. Default: false.
   */
  readonly refreshBundledDefaultPresets?: boolean;
  readonly loggingLevel?: LoggingLevel;
  readonly configuredServiceAccountDriverId?: string;
  /** Installation startup `runtime.nativeWorkerSupport`; never set from the API. */
  readonly nativeWorkerSupport?: NativeWorkerSupport;
  /** Installation startup `drivers.credential_proxy.requestCapacity`; defaults when absent. */
  readonly credentialProxyCapacity?: CredentialProxyCapacity;
}
export type ReconciliationOperation = PlatformOperation;
// The bundled Kubernetes Compute Driver's implementations: the Installation default and the
// Driver's own default.
const BUNDLED_KUBERNETES_COMPUTE: ReadonlySet<string> = new Set([
  "occ/kubernetes",
  "kubernetes-local",
]);
/** Only a claimed server-side consent attempt may operate on its still-pending source. */
const PENDING_CONNECTION: unique symbol = Symbol("pending-connection");
export type { PENDING_CONNECTION };
/** Public methods that workflows call after the controller has been constructed. */
interface ControllerDispatch
  extends
    Pick<DriverRegistry, "selectedDriver">,
    Pick<ControllerTransactions, "transact" | "registerRollback">,
    Pick<NamespaceOperations, "getNamespace">,
    Pick<ReturnType<typeof createAgentQueries>, "getRevision">,
    Pick<ReturnType<typeof createSandboxPolicyOperations>, "getAgentSandboxPolicy">,
    Pick<
      ReturnType<typeof createSavedConnections>,
      "finishConnectionRevocation" | "maintainConnectionToken"
    >,
    Pick<ReturnType<typeof createConnectionAdministration>, "withOAuthClientSecret">,
    Pick<CredentialSourceOperations, "createCredentialSource">,
    Pick<ManagedCredentialSources<typeof PENDING_CONNECTION>, "deleteCredentialSource">,
    Pick<ReturnType<typeof createConfigurationOperations>, "updateConfiguration"> {
  getAgent(principalId: string, namespaceId: string, agentId: string): Promise<Readonly<Agent>>;
  getReadableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection>;
  deployAgent(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
  ): Promise<Readonly<AgentRevision>>;
  observeNamespaceLifecycle(
    namespace: Readonly<Namespace>,
    target: "ready" | "deleted",
    signal: AbortSignal,
    record: (evidence: NamespaceLifecycleEvidence) => void | Promise<void>,
  ): Promise<NamespaceEnsureResult | NamespaceDeleteResult>;
}
function validatedInstallation(installation: Installation): Readonly<Installation> {
  if (!isNonEmptyString(installation.id)) {
    throw new ScopeViolationError("The controller requires one valid server-owned Installation.");
  }
  if (!isName(installation.name)) {
    throw new ScopeViolationError(
      `The stored Installation name breaks the Name rule: ${NAME_RULE}.`,
    );
  }
  if (
    !isNonEmptyString(installation.createdAt) ||
    Number.isNaN(Date.parse(installation.createdAt))
  ) {
    throw new ScopeViolationError("The server-owned Installation has an invalid creation time.");
  }
  return Object.freeze({
    id: installation.id,
    name: installation.name,
    createdAt: installation.createdAt,
  });
}

function createPreparedTokenAccess(preparedTokens: TokenService | undefined) {
  function tokenService(): TokenService {
    if (!preparedTokens) {
      throw new DependencyUnavailableError("The Token Service is unavailable.");
    }
    return preparedTokens;
  }
  function preparedIssuer(provider: EgressRef) {
    const lifecycle = preparedTokens?.issuer(provider);
    if (!lifecycle) {
      throw new DependencyUnavailableError(
        "The admitted prepared credential issuer is not configured.",
      );
    }
    return lifecycle;
  }
  function connectionTokenIssuer() {
    const issuer = preparedTokens?.issuer("oauth_refresh_token");
    if (!issuer) {
      throw new NotImplementedError(
        "connection_templates",
        "This Installation has no Token Service for browser connections.",
      );
    }
    return issuer;
  }

  return { tokenService, preparedIssuer, connectionTokenIssuer };
}

function createComputeConfigurationPolicy(
  drivers: Pick<DriverRegistry, "selection">,
  selectCompute: () => ComputeDriver,
) {
  function requireNamespaceAdoptionSupport(): void {
    let compute: ComputeDriver;
    try {
      compute = selectCompute();
    } catch {
      throw new ResourceStateConflictError(
        "Existing namespace adoption requires the bundled Kubernetes Compute Driver.",
      );
    }
    if (!BUNDLED_KUBERNETES_COMPUTE.has(compute.implementation)) {
      throw new ResourceStateConflictError(
        "Existing namespace adoption requires the bundled Kubernetes Compute Driver.",
      );
    }
  }

  // On the bundled Kubernetes Compute, which delivers channel credentials only from bindings, the
  // channel credential rule its deployment admission applies (finding 2319).
  function requireBundledChannelBindings(
    values: OpenClawConfigurationDocument,
    secretBindings: SecretBindings,
  ): void {
    if (bundledKubernetesCompute()) {
      requireChannelSecretBindings(
        values,
        enabledChannelEntries(values),
        (name) => Object.hasOwn(secretBindings, name),
        (setting, requirement) =>
          new ConfigurationHarnessError(configurationSettingMessage(setting, requirement)),
      );
    }
  }

  // The bundled Kubernetes Compute Driver: OCC applies its documented facts that no Driver member
  // carries (existing namespace adoption, channel credentials delivered only from bindings).
  function bundledKubernetesCompute(): boolean {
    const implementation = drivers.selection("compute")?.driver.implementation;
    return implementation !== undefined && BUNDLED_KUBERNETES_COMPUTE.has(implementation);
  }

  // Configuration content every topology of the selected Compute Driver refuses is refused
  // where it is written (Configuration create and update, provisioning, Preset defaults), with
  // the Driver's ConfigurationHarnessError naming the setting. A stored Configuration that
  // predates a rule still reads; deployment refuses it with the same message.
  function validateComputeConfiguration(
    values: Readonly<OpenClawConfigurationDocument>,
    options?: ConfigurationValidationOptions,
  ): void {
    const compute = drivers.selection("compute")?.driver as ComputeDriver | undefined;
    compute?.validateConfiguration?.(values, options);
  }

  return {
    requireNamespaceAdoptionSupport,
    requireBundledChannelBindings,
    validateComputeConfiguration,
  };
}

export type ControllerComposition = ReturnType<typeof createControllerComposition>;
function initializeInstallationDrivers(
  installation: Installation,
  options: Pick<
    ControllerOptions,
    "namespaceLifecycleBindings" | "sandboxNetworkPolicyCeiling" | "driverConfigurations"
  >,
  hasBuiltInRepositoryPolicy: () => boolean,
) {
  const configurations = new DriverConfigurationRegistry();
  const drivers = new DriverRegistry({
    configurations,
    namespaceLifecycleBindings: options.namespaceLifecycleBindings ?? [],
    hasBuiltInRepositoryPolicy,
  });
  const admittedInstallation = validatedInstallation(installation);
  validateSandboxNetworkGrants(
    options.sandboxNetworkPolicyCeiling ?? [],
    "/sandboxNetworkPolicyCeiling",
  );
  const sandboxNetworkPolicyCeiling = immutableCopy(options.sandboxNetworkPolicyCeiling ?? []);
  for (const registration of options.driverConfigurations ?? []) {
    configurations.register(registration);
  }
  return {
    installation: admittedInstallation,
    configurations,
    drivers,
    sandboxNetworkPolicyCeiling,
  };
}

function createStateAndAuthority(
  installation: Readonly<Installation>,
  options: Pick<ControllerOptions, "now" | "createId" | "state" | "iamConfiguration">,
  authorization: ControllerOptions["authorize"],
  publicController: Pick<ControllerDispatch, "selectedDriver">,
) {
  const now = options.now ?? (() => new Date());
  const createId = options.createId;
  const resourceValues: ControllerResourceValues = createControllerResourceValues(
    () => Reflect.apply(now, publicController, []),
    createId ? (kind) => Reflect.apply(createId, publicController, [kind]) : undefined,
  );
  const platformState: PlatformStateStore = options.state ?? new InMemoryPlatformState();
  const transactions: ControllerTransactions = createControllerTransactions({
    platformState,
    installation,
  });
  const selectedIAM = () => publicController.selectedDriver("iam");
  const authority: ControllerAuthority = createControllerAuthority({
    selectedIAM,
    authorizeOverride: authorization
      ? (request) => Reflect.apply(authorization, publicController, [request])
      : undefined,
  });
  const iamPolicy: IAMPolicyOperations = createIAMPolicyOperations({
    installationId: installation.id,
    configuration: options.iamConfiguration,
    authority,
    transactions,
    selectedIAM,
    hasAuthorizationOverride: authorization !== undefined,
    ownsPolicy: (driver) =>
      !(driver instanceof NativeIAMDriver) ||
      NativeIAMDriver.usesStateForAuthorization(driver, driver.authorize, platformState),
    timestamp: resourceValues.timestamp,
  });
  return { platformState, transactions, authority, iamPolicy, resourceValues };
}

function createAgentTeardownOperations(
  installationId: string,
  transactions: Pick<ControllerTransactions, "read" | "transact">,
  authority: Pick<ControllerAuthority, "authorize" | "authorizationDecision" | "holdAuthority">,
  resourceValues: Pick<ControllerResourceValues, "now" | "timestamp">,
  audit: {
    readonly record: ControllerWorkRecorder["record"];
    readonly requestAuditId: () => string | undefined;
  },
) {
  const agentCredentialWithdrawal = createAgentCredentialWithdrawal({
    namespaceIdentity,
    now: resourceValues.now,
    timestamp: resourceValues.timestamp,
    record: audit.record,
    transactions,
    authority,
    lockNamespace,
    exactNamespace,
  });
  const agentTermination = createAgentTermination({
    installationId: () => installationId,
    requestAuditId: audit.requestAuditId,
    timestamp: resourceValues.timestamp,
    record: audit.record,
    transactions,
    authority,
    lockNamespace,
    now: resourceValues.now,
  });

  return { agentCredentialWithdrawal, agentTermination };
}

function createCredentialServices({
  installationId,
  stateAndAuthority: { platformState, transactions, authority, iamPolicy, resourceValues },
  secretDriver,
  drivers,
  publicController,
  preparedTokens,
  deviceCipher,
  canUseNativeAuthorization,
}: {
  installationId: string;
  stateAndAuthority: ReturnType<typeof createStateAndAuthority>;
  secretDriver: ReturnType<typeof createSecretOperations>["secretDriver"];
  drivers: Pick<DriverRegistry, "hasSelection" | "selectedProxyOwner" | "selection">;
  publicController: Pick<
    ControllerDispatch,
    | "selectedDriver"
    | "getNamespace"
    | "transact"
    | "createCredentialSource"
    | "deleteCredentialSource"
    | "withOAuthClientSecret"
    | "maintainConnectionToken"
    | "finishConnectionRevocation"
  >;
  preparedTokens: TokenService | undefined;
  deviceCipher: ReturnType<typeof deviceAuthorizationCipher> | undefined;
  canUseNativeAuthorization: boolean;
}) {
  const nextSourceId = () => resourceValues.nextIdentifier("credential_source");
  const { tokenService, preparedIssuer, connectionTokenIssuer } =
    createPreparedTokenAccess(preparedTokens);
  const credentialSourceDrivers = createCredentialSourceDrivers({
    selectedDriver: (capability) => publicController.selectedDriver(capability),
    hasSelection: (capability) => drivers.hasSelection(capability),
    selectedProxyOwner: () => drivers.selectedProxyOwner(),
  });
  const egressAdmission = createCredentialEgressAdmission({
    installationId: () => installationId,
    authorize: authority.authorize,
    hasProxy: () => drivers.hasSelection("credential_proxy"),
    proxyDriver: () => publicController.selectedDriver("credential_proxy"),
    proxyRegistrationOwner: () => drivers.selection("credential_proxy")?.owner,
    selectedProxyOwner: () => drivers.selectedProxyOwner(),
    hasGateway: () => drivers.hasSelection("credential_gateway"),
    sourceDrivers: credentialSourceDrivers,
    secretDriver,
    issuer: (ref) => preparedTokens?.issuer(ref),
  });
  const credentialSourceOperations: CredentialSourceOperations = createCredentialSourceOperations({
    transactions,
    authority,
    sourceDrivers: credentialSourceDrivers,
    egressAdmission,
    hasProxy: () => drivers.hasSelection("credential_proxy"),
    assertCredentialSourceOwnerSelected:
      credentialSourceDrivers.assertCredentialSourceOwnerSelected,
    secretDriver,
    secretOperation,
    getNamespace: (principalId, namespaceId) =>
      publicController.getNamespace(principalId, namespaceId),
    bindCreator: iamPolicy.bindCreator,
    nextSourceId,
    timestamp: resourceValues.timestamp,
    tokenService,
    preparedIssuer,
    readConnectionStatus: (namespaceId, sourceId) =>
      connectionTokenIssuer().status(
        { kind: "oauth_refresh_token", namespaceId, sourceId },
        AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
      ),
    maintainConnectionToken: (namespaceId, sourceId) =>
      publicController.maintainConnectionToken(namespaceId, sourceId),
  });
  const deviceAuthorization = createDeviceAuthorizationFlow({
    installationId,
    cipher: deviceCipher,
    gatewayTimeoutMs: CREDENTIAL_GATEWAY_TIMEOUT_MS,
    nextSessionId: () => resourceValues.nextIdentifier("secret"),
    timestamp: resourceValues.timestamp,
    transactions,
    authority,
    hasDriver: (capability) => drivers.hasSelection(capability),
    credentialGatewayDriver: credentialSourceDrivers.credentialGatewayDriver,
    credentialRefreshDriver: credentialSourceDrivers.credentialRefreshDriver,
    credentialGatewayOperation,
    credentialSourceContext: credentialSourceOperations.credentialSourceContext,
    authorizedCredentialSource: credentialSourceOperations.authorizedCredentialSource,
    createSource: (principalId, input, audit, registrationAudit) =>
      publicController.createCredentialSource(principalId, input, audit, registrationAudit),
    credentialSourceMetadata,
  });
  const managedCredentialSources: ManagedCredentialSources<typeof PENDING_CONNECTION> =
    createManagedCredentialSources(
      {
        transactions,
        authority,
        sourceDrivers: credentialSourceDrivers,
        assertCredentialSourceOwnerSelected:
          credentialSourceDrivers.assertCredentialSourceOwnerSelected,
        bindCreator: iamPolicy.bindCreator,
        lockNamespaceForPolicyDelete: iamPolicy.lockNamespaceForPolicyDelete,
        selectedTokenServiceDriver: () => publicController.selectedDriver("token_service"),
        clock: resourceValues.now,
        timestamp: resourceValues.timestamp,
        nextSourceId,
        tokenServiceTimeoutMs: CONNECTION_OPERATION_TIMEOUT_MS,
        driverOperation: (operation) => driverOperation(operation, "TokenService"),
        isCommitOutcomeUnknown: (error) => error instanceof PostgresCommitOutcomeUnknownError,
        connectionTokenIssuer,
        preparedIssuer,
      },
      PENDING_CONNECTION,
    );
  const agentCredentialAccess: AgentCredentialAccess = createAgentCredentialAccess({
    authority,
    iamPolicy,
    drivers,
    installationId,
    timestamp: resourceValues.timestamp,
    isManagedTokenServiceSource,
    assertCredentialSourceOwnerSelected:
      credentialSourceDrivers.assertCredentialSourceOwnerSelected,
    requireTokenServiceOwner: (instanceId) => {
      managedCredentialSources.ownedTokenServiceDriver(instanceId);
    },
    credentialSourceOwner: credentialSourceDrivers.credentialSourceOwner,
    offersProtectedType: (type) =>
      egressAdmission.protectedSourceTypes().some((offer) => offer.type.type === type),
    credentialSourceType: credentialSourceDrivers.credentialSourceType,
    validatePluginCredentialSources,
  });
  const connectionAdministration = createConnectionAdministration({
    installationId,
    transactions,
    authority,
    secretDriver,
    now: resourceValues.now,
    timestamp: resourceValues.timestamp,
  });
  const savedConnections = createSavedConnections({
    read: transactions.read,
    transact: transactions.transact,
    authorize: authority.authorize,
    canRead: authority.canRead,
    holdAuthority: authority.holdAuthority,
    iamPolicyDriver: (method) => iamPolicy.iamPolicyDriver(method),
    iamPolicyOperation,
    connectionTokenIssuer,
    tokenService,
    secretDriver,
    withOAuthClientSecret: (client, use) => publicController.withOAuthClientSecret(client, use),
    retireCredentialSourceMaterial: (namespace, source) =>
      managedCredentialSources.retireCredentialSourceMaterial(namespace, source, undefined),
    discardPendingConnection: (principalId, namespaceId, sourceId) =>
      publicController.deleteCredentialSource(
        principalId,
        namespaceId,
        sourceId,
        undefined,
        PENDING_CONNECTION,
      ),
    finishConnectionRevocation: (namespaceId, sourceId) =>
      publicController.finishConnectionRevocation(namespaceId, sourceId),
    nextIdentifier: resourceValues.nextIdentifier,
    timestamp: resourceValues.timestamp,
  });
  function createProxyAuthority(exchangeOwner: EgressExchangeOwner) {
    return createEgressAuthority(exchangeOwner, {
      installationId,
      clock: resourceValues.now,
      timestamp: resourceValues.timestamp,
      inTransaction: transactions.hasContext,
      readSnapshot: (work) => platformState.read(work),
      transact: (work) => publicController.transact(work),
      lockNamespace,
      proxyDriver: () => publicController.selectedDriver("credential_proxy"),
      selectedProxyOwner: () => drivers.selectedProxyOwner(),
      secretDriver,
      computeDriver: () => publicController.selectedDriver("compute"),
      credentialPlacement: credentialSourceDrivers.credentialPlacement,
      credentialNamespace: credentialSourceDrivers.credentialNamespace,
      credentialGatewayOperation,
      authorizationAuthority: (principalId) => authority.authorizationAuthority(principalId),
      authorizationDecision: (principalId, resource, selectedIAM, authorize) =>
        authority.authorizationDecision(principalId, "operate", resource, selectedIAM, authorize),
      authorizeUse: (principalId, resource) =>
        authority.authorize(principalId, "operate", resource),
      usesNativeAuthorization: (selectedIAM, authorize) =>
        canUseNativeAuthorization &&
        NativeIAMDriver.usesStateForAuthorization(selectedIAM, authorize, platformState),
      currentCredentialSourceOwner: credentialSourceDrivers.currentCredentialSourceOwner,
      preparedTokens,
      resolvePrepared: (key, options) =>
        tokenService().resolve({ kind: preparedIssuer(key.provider).tokenKind, key }, options),
      receipts: new EgressSendReceipts(platformState),
    });
  }

  return {
    agentCredentialAccess,
    connectionAdministration,
    createProxyAuthority,
    credentialSourceDrivers,
    credentialSourceOperations,
    deviceAuthorization,
    egressAdmission,
    managedCredentialSources,
    savedConnections,
  };
}

export function createControllerComposition(
  installation: Installation,
  options: ControllerOptions,
  publicController: ControllerDispatch,
) {
  const requestAuditId = new AsyncLocalStorage<string>();
  const currentRequestAuditId = () => requestAuditId.getStore();
  const selectedCompute = () => publicController.selectedDriver("compute");
  const getNamespace = (principalId: string, namespaceId: string) =>
    publicController.getNamespace(principalId, namespaceId);

  const {
    installation: admittedInstallation,
    configurations,
    drivers,
    sandboxNetworkPolicyCeiling,
  } = initializeInstallationDrivers(installation, options, () =>
    repositoryPolicy.hasBuiltInRepositoryPolicy(),
  );
  const {
    requireNamespaceAdoptionSupport,
    requireBundledChannelBindings,
    validateComputeConfiguration,
  } = createComputeConfigurationPolicy(drivers, selectedCompute);

  const authorization: ControllerOptions["authorize"] | undefined = options.authorize;
  const preparedTokens: TokenService | undefined = options.preparedTokens;
  const pluginSourceReader = options.pluginSourceReader;
  const stateAndAuthority = createStateAndAuthority(
    admittedInstallation,
    options,
    authorization,
    publicController,
  );
  const { platformState, transactions, authority, iamPolicy, resourceValues } = stateAndAuthority;
  const secretOperations = createSecretOperations(admittedInstallation.id, {
    transactions,
    authority,
    bindCreator: iamPolicy.bindCreator,
    getNamespace,
    lockNamespaceForPolicyDelete: iamPolicy.lockNamespaceForPolicyDelete,
    selectDriver: () => publicController.selectedDriver("secret"),
    nextIdentifier: resourceValues.nextIdentifier,
    timestamp: resourceValues.timestamp,
    registerRollback: (compensate) => publicController.registerRollback(compensate),
  });
  const configurationOperations = createConfigurationOperations({
    transactions,
    authority,
    registerRollback: (compensate) => publicController.registerRollback(compensate),
    lockNamespaceForPolicyDelete: iamPolicy.lockNamespaceForPolicyDelete,
    guardProvisioningConfiguration: (state, namespaceId, id, readOnly) =>
      provisioningWorker.guardProvisioningConfiguration(state, namespaceId, id, readOnly),
    selectDriver: () => publicController.selectedDriver("configuration"),
    validateComputeConfiguration,
    requireBundledChannelBindings,
    ownedSecretDriver: secretOperations.ownedSecretDriver,
    bindCreator: iamPolicy.bindCreator,
    nextIdentifier: resourceValues.nextIdentifier,
    timestamp: resourceValues.timestamp,
  });
  const deviceCipher = options.authenticationStateEncryptionSecret
    ? deviceAuthorizationCipher(options.authenticationStateEncryptionSecret)
    : undefined;
  const credentials = createCredentialServices({
    installationId: admittedInstallation.id,
    stateAndAuthority,
    secretDriver: secretOperations.secretDriver,
    drivers,
    publicController,
    preparedTokens,
    deviceCipher,
    canUseNativeAuthorization: !authorization,
  });
  const {
    agentCredentialAccess,
    credentialSourceDrivers,
    credentialSourceOperations,
    egressAdmission,
    managedCredentialSources,
  } = credentials;
  const readAgentAuditEvents = createAgentAuditReader({
    installationId: admittedInstallation.id,
    platformState,
    auditState: options.agentAuditState,
    authority,
    hasAuthorizationOverride: authorization !== undefined,
  });
  const workRecorder: ControllerWorkRecorder = createControllerWorkRecorder(
    requestAuditId,
    options.recordOperations ?? true,
  );
  const { agentCredentialWithdrawal, agentTermination } = createAgentTeardownOperations(
    admittedInstallation.id,
    transactions,
    authority,
    resourceValues,
    { record: workRecorder.record, requestAuditId: currentRequestAuditId },
  );
  const sandboxPolicyOperations = createSandboxPolicyOperations({
    installationId: admittedInstallation.id,
    ceiling: sandboxNetworkPolicyCeiling,
    authority,
    transactions,
    egressAdmission,
    hasCredentialProxy: () => drivers.hasSelection("credential_proxy"),
    allowsOrdinaryCredentialGateway: () =>
      drivers.selectedProxyOwner().allowsOrdinaryCredentialGateway(),
    record: workRecorder.record,
    resolveConfiguration: (capability, driverId, scope, key) =>
      configurations.resolve(capability, driverId, scope, key),
    hasSandboxSelection: () => drivers.hasSelection("sandbox"),
    selectSandbox: () => publicController.selectedDriver("sandbox"),
    selectedCompute,
    timestamp: resourceValues.timestamp,
  });
  const agentAutomations = createAgentAutomations({
    transactions,
    authority,
    timestamp: resourceValues.timestamp,
  });
  const agentQueries = createAgentQueries({
    transactions,
    authority,
    getNamespace,
    selectCompute: selectedCompute,
    clock: resourceValues.now,
  });
  const backends: readonly BackendDefinition[] = validateBackendDefinitions(options.backends ?? []);
  const presets = createPresetOperations(options, {
    installationId: admittedInstallation.id,
    transactions,
    authority,
    bindCreator: iamPolicy.bindCreator,
    getNamespace,
    nextPresetId: () => resourceValues.nextIdentifier("preset"),
    timestamp: resourceValues.timestamp,
    configurationDriver: configurationOperations.selectedDriver,
    validateConfigurationContent: configurationOperations.validateConfigurationContent,
    validateAgentBackend: (backendId) => resolveAgentBackendId(backendMap, backendId),
    drivers,
    normalizeAgentPluginApprovers,
  });
  const namespaces: NamespaceOperations = createNamespaceOperations({
    installationId: admittedInstallation.id,
    transactions,
    authority,
    iamPolicy,
    presets,
    record: workRecorder.record,
    observeLifecycle: (namespace, target, signal, record) =>
      publicController.observeNamespaceLifecycle(namespace, target, signal, record),
    selectedCompute,
    selectedIAMId: () => publicController.selectedDriver("iam").id,
    allocateNamespaceId: () => resourceValues.nextIdentifier("namespace"),
    requireAdoptionSupport: requireNamespaceAdoptionSupport,
    timestamp: resourceValues.timestamp,
    requestAuditId: currentRequestAuditId,
  });
  const loggingLevel: LoggingLevel = normalizeLoggingLevel(options.loggingLevel);
  if (options.nativeWorkerSupport !== undefined && options.nativeWorkerSupport !== "custom-image") {
    throw new ScopeViolationError("The native worker support declaration is invalid.");
  }
  const nativeWorkers: NativeWorkerSupportSource | undefined = nativeWorkerSupportSource(
    options.nativeWorkerSupport,
  );
  const modelPolicyAgent = createModelPolicyAgent(
    sandboxPolicyOperations.sandboxDriver,
    nativeWorkers,
  );
  const capacity = resolveCredentialProxyCapacity(
    { ...options.credentialProxyCapacity },
    "Credential Proxy capacity",
  );
  if (capacity.faults) {
    throw new RangeError(capacity.faults.map((fault) => fault.message).join(" "));
  }
  const credentialProxyCapacity: CredentialProxyCapacity = capacity.capacity;
  const backendMap: ReadonlyMap<string, BackendDefinition> = backendDefinitionMap(backends);
  const repositoryPolicy = createRepositoryPolicyOperations({
    drivers,
    selectedRepository: () => publicController.selectedDriver("repo"),
    selectedCompute,
    backends: backendMap,
    sandboxDriver: sandboxPolicyOperations.sandboxDriver,
    authority,
    holdNamespacePolicyActor: (state, principalId) =>
      iamPolicy.holdNamespacePolicyActor(state, principalId),
    transactions,
    getUpdatableAgent: (principalId, namespaceId, agentId) =>
      agentQueries.getAuthorizedAgent(principalId, namespaceId, agentId, "update"),
    timestamp: resourceValues.timestamp,
    requestAuditId: currentRequestAuditId,
  });
  const agentPlugins = createAgentPluginValidation({
    pluginDriver: (harnessId, forConfiguration) =>
      drivers.pluginDriver(harnessId, forConfiguration),
    computeImplementation: () => selectedCompute().implementation,
    sandboxImplementation: () => drivers.selection("sandbox")?.implementation,
    credentialGatewayImplementation: () => drivers.selection("credential_gateway")?.implementation,
  });
  const pluginDiscovery = createPluginDiscovery({
    transactions,
    authority,
    authorizedCredentialSource: credentialSourceOperations.authorizedCredentialSource,
    credentialGatewayOperation,
    sourceReader: pluginSourceReader,
    secretDriver: secretOperations.secretDriver,
    readConfiguration: (metadata) => configurationOperations.savedConfigurationReader(metadata)(),
    modelPolicyAgent,
    pluginDriver: (harnessId) => drivers.pluginDriver(harnessId),
    assertPluginOwner: pluginOwner,
    validatePluginPlacement: (driver, plugins, harness) =>
      agentPlugins.validatePluginPlacement(driver, plugins, harness),
  });
  const validateSavedAgentTopology = createSavedAgentTopologyValidator({
    sandboxDriver: sandboxPolicyOperations.sandboxDriver,
    selectedCompute: () => drivers.selection("compute")?.driver as ComputeDriver | undefined,
    validatePluginPlacement: (driver, plugins, harness) =>
      agentPlugins.validatePluginPlacement(driver, plugins, harness),
    validateRepositoryBrokerNetworkProxy,
    loggingLevel,
  });
  if (
    options.configuredServiceAccountDriverId !== undefined &&
    !isNonEmptyString(options.configuredServiceAccountDriverId)
  ) {
    throw new ScopeViolationError("The configured ServiceAccount Driver ID is invalid.");
  }
  const configuredServiceAccountDriverId = options.configuredServiceAccountDriverId;
  const installationCapabilityQueries = createInstallationCapabilityQueries({
    installation: admittedInstallation,
    nativeWorkers,
    authority,
    transactions,
    sandboxDriver: sandboxPolicyOperations.sandboxDriver,
    admitOpenClawExecutionMode: admitsOpenClawExecutionMode,
    readGatewaySourceTypes: () =>
      drivers.hasSelection("credential_gateway")
        ? credentialGatewayOperation(() =>
            credentialSourceDrivers.credentialGatewayDriver().listSourceTypes({
              signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
            }),
          )
        : undefined,
    protectedSourceTypes: () => egressAdmission.protectedSourceTypes().map(({ type }) => type),
    allowsGatewaySourceType: (type) =>
      egressAdmission.ordinaryCredentialGatewayAllowed(type) ||
      egressAdmission.staticSourceTypeAvailable(type),
    enabledPluginDrivers: () => drivers.enabledPluginDrivers(),
  });
  const runtimeObservations: AgentRuntimeObservations = new AgentRuntimeObservations({
    getAgent: (principalId, namespaceId, agentId) =>
      publicController.getAgent(principalId, namespaceId, agentId),
    getRevision: (principalId, namespaceId, agentId, deploymentId) =>
      publicController.getRevision(principalId, namespaceId, agentId, deploymentId),
    getReadableActiveAgentRevision: (principalId, namespaceId, agentId) =>
      publicController.getReadableActiveAgentRevision(principalId, namespaceId, agentId),
    transactions,
    authority,
    selectCompute: selectedCompute,
    selectSandbox: () => publicController.selectedDriver("sandbox"),
    hasSandbox: () => drivers.hasSelection("sandbox"),
    clock: resourceValues.now,
  });
  const setupDiscovery: SetupDiscovery = new SetupDiscovery({
    installationId: admittedInstallation.id,
    transactions,
    authority,
    configurations,
    drivers,
    getAgentSandboxPolicy: (principalId, namespaceId, agentId, facet) =>
      publicController.getAgentSandboxPolicy(principalId, namespaceId, agentId, facet),
    selectCompute: selectedCompute,
    selectChannel: () => publicController.selectedDriver("channel"),
    secretDriver: secretOperations.secretDriver,
  });
  const runtimeCredentials: AgentRuntimeCredentials = new AgentRuntimeCredentials({
    transactions,
    authority,
    guardAgentProvisioning: (state, namespaceId, agentId) =>
      provisioningWorker.guardAgentProvisioning(state, namespaceId, agentId),
    selectCompute: selectedCompute,
  });
  const serviceAccountOperations = createServiceAccountOperations({
    transactions,
    authority,
    bindCreator: iamPolicy.bindCreator,
    getNamespace,
    lockNamespaceForPolicyDelete: iamPolicy.lockNamespaceForPolicyDelete,
    hasSelection: () => drivers.hasSelection("service_account"),
    selectDriver: () => publicController.selectedDriver("service_account"),
    computeDriver: selectedCompute,
    configuredDriverId: configuredServiceAccountDriverId,
    nextIdentifier: resourceValues.nextIdentifier,
  });
  const harnessAuthOperations = createHarnessAuthOperations({
    authority,
    authorizeBoundCredentialSources: (principalId, namespaceId, sources) =>
      agentCredentialAccess.authorizeBoundCredentialSources(principalId, namespaceId, sources),
    backends: backendMap,
    secrets: secretOperations,
    isManagedTokenServiceSource,
    hasCredentialGateway: () => drivers.hasSelection("credential_gateway"),
    assertCredentialGatewaySelected: credentialSourceDrivers.assertCredentialGatewaySelected,
    ownedTokenServiceDriver: (id) => managedCredentialSources.ownedTokenServiceDriver(id),
    ownedCredentialGatewayDriver: (source) =>
      credentialSourceDrivers.ownedCredentialGatewayDriver(source),
    credentialGatewayDriver: (id) => credentialSourceDrivers.credentialGatewayDriver(id),
    credentialSourceType: (driver, type) =>
      credentialSourceDrivers.credentialSourceType(driver, type),
    serviceAccounts: serviceAccountOperations,
    sandboxDriver: sandboxPolicyOperations.sandboxDriver,
    agentRuntimeConfiguration: (values, harness, compute, sandbox) =>
      renderAgentRuntimeConfiguration(values, harness, compute, sandbox),
  });
  const agentDrafts = createAgentDraftOperations({
    authority,
    transactions,
    harnessAuth: harnessAuthOperations,
    repositoryPolicy,
    validateSavedAgentTopology,
    validateAgentPlugins: agentPlugins.validateAgentPlugins,
    guardAgentProvisioning: (state, namespaceId, agentId) =>
      provisioningWorker.guardAgentProvisioning(state, namespaceId, agentId),
    guardProvisioningConfiguration: (state, namespaceId, id) =>
      provisioningWorker.guardProvisioningConfiguration(state, namespaceId, id),
    backendId: (value, preserve) => resolveAgentBackendId(backendMap, value, preserve),
    credentialAccess: agentCredentialAccess,
    isManagedTokenServiceSource,
    bindings: storedSecretBindings,
    authorizeBindings: configurationOperations.authorizeBindings,
    rejectCrossNamespaceSecretSources,
    configurationDriver: configurationOperations.selectedDriver,
    validateConfigurationContent: (values, bindings) =>
      configurationOperations.validateConfigurationContent(values, undefined, bindings),
    savedConfigurationReader: configurationOperations.savedConfigurationReader,
    updatePreparedConfiguration: (actorId, input) =>
      publicController.updateConfiguration(actorId, input),
    installationId: admittedInstallation.id,
    selectedCompute: () => drivers.selection("compute")?.driver as ComputeDriver | undefined,
    refuseRepositoryNetworkOverlap: (actorId, policy) =>
      sandboxPolicyOperations.refuseRepositoryNetworkOverlap(actorId, policy),
    bindCreator: iamPolicy.bindCreator,
    nextAgentId: () => resourceValues.nextIdentifier("agent"),
    timestamp: resourceValues.timestamp,
  });
  const deploymentChannels = createDeploymentChannelChecks({
    transactions,
    authority,
    drivers,
    selectedChannel: () => publicController.selectedDriver("channel"),
    configurationDriver: configurationOperations.selectedDriver,
    driverOperation,
    requireBundledChannelBindings,
    ownedSecretDriver: secretOperations.ownedSecretDriver,
    sameSecretBackend,
  });
  const provisioningRequests = createProvisioningRequests({
    installationId: () => admittedInstallation.id,
    resourceValues,
    requestAuditId: currentRequestAuditId,
    backendId: (value) => resolveAgentBackendId(backendMap, value),
    transactions,
    authority,
    runtimeCredentials,
    settings: configurationOperations,
    sandboxPolicy: sandboxPolicyOperations,
    secrets: secretOperations,
    selectedIAM: () => publicController.selectedDriver("iam"),
    channels: deploymentChannels,
    modelPolicyAgent,
    harness: harnessAuthOperations,
    plugins: agentPlugins,
    repository: repositoryPolicy,
    nativeWorkers,
  });
  const provisioningWorker = createProvisioningWorker({
    installationId: () => admittedInstallation.id,
    now: resourceValues.now,
    timestamp: resourceValues.timestamp,
    nextId: resourceValues.nextIdentifier,
    transactions,
    authorizeRecord: provisioningRequests.authorizeProvisioningRecord,
    bindCreator: iamPolicy.bindCreator,
    ensureAgentOperateGrants: agentCredentialAccess.ensureAgentOperateGrants,
    backendId: (ref) => resolveAgentBackendId(backendMap, ref),
    repository: repositoryPolicy,
    hasConfigurationDriver: () => drivers.hasSelection("configuration"),
    configuration: configurationOperations,
    runtimeCredentials,
    deploy: (principalId, input, resolveHarness) =>
      publicController.deployAgent(principalId, input, resolveHarness),
  });
  const deploymentRequests = createAgentDeploymentOperations(admittedInstallation.id, {
    transactions,
    authority,
    channels: deploymentChannels,
    harnessAuth: harnessAuthOperations,
    repositoryPolicy,
    sandboxPolicy: sandboxPolicyOperations,
    plugins: agentPlugins,
    enabledPluginDrivers: () => drivers.enabledPluginDrivers(),
    pluginDriver: (harnessId, forConfiguration) =>
      drivers.pluginDriver(harnessId, forConfiguration),
    selectedCompute,
    sandboxDriver: sandboxPolicyOperations.sandboxDriver,
    nativeWorkers,
    loggingLevel,
    provisioningWorker,
    backendId: (requested) => resolveAgentBackendId(backendMap, requested),
    configurationDriver: configurationOperations.selectedDriver,
    configuration: configurationOperations,
    driverOperation,
    modelPolicyAgent,
    credentialAccess: agentCredentialAccess,
    secretDriver: secretOperations.secretDriver,
    validateComputeConfiguration,
    validateRepositoryBrokerNetworkProxy,
    timestamp: resourceValues.timestamp,
    nextIdentifier: resourceValues.nextIdentifier,
    egress: egressAdmission,
    selectedProxyOwner: () => drivers.selectedProxyOwner(),
    workRecorder,
  });
  function validateBackendConfiguration(): void {
    const selected = drivers.backendDrivers();
    const builtInRepository = repositoryPolicy.builtInBackendDriver();
    if (builtInRepository !== undefined) {
      selected.repo = builtInRepository;
    }
    validateSelectedBackendDrivers(
      backends,
      selected,
      drivers.hasSelection("credential_proxy") ? drivers.selectedProxyOwner() : undefined,
    );
  }
  function getInstallationDeploymentInventory(
    principalId: string,
  ): Promise<Readonly<InstallationDeploymentInventory>> {
    return readDeploymentInventory(
      {
        installationId: admittedInstallation.id,
        authorize: authority.authorize,
        read: transactions.read,
        driverSelection: (capability) => drivers.selection(capability),
        selectCompute: selectedCompute,
      },
      principalId,
    );
  }
  function observeNamespaceLifecycle(
    namespace: Readonly<Namespace>,
    target: "ready" | "deleted",
    signal: AbortSignal,
    record: (evidence: NamespaceLifecycleEvidence) => void | Promise<void>,
  ): Promise<NamespaceEnsureResult | NamespaceDeleteResult> {
    const { compute, participants } = drivers.namespaceLifecycle(selectedCompute);
    return reconcileNamespaceLifecycle(compute, participants, namespace, target, signal, record);
  }
  function pendingOperations(): readonly Readonly<ReconciliationOperation>[] {
    if (platformState instanceof InMemoryPlatformState) {
      return platformState.pendingOperations();
    }
    return Object.freeze([]);
  }
  function renderAgentRuntimeConfiguration(
    values: Readonly<OpenClawConfigurationDocument>,
    harness: RevisionHarnessDescriptor,
    compute: ComputeDriver,
    sandbox: SandboxDriver | undefined,
  ): OpenClawConfigurationDocument {
    return agentRuntimeConfiguration(values, harness, compute, sandbox, loggingLevel);
  }
  function bindInstallationRepository(
    repositoryAdmission: InstallationRepositoryAdmission | undefined,
  ): void {
    repositoryPolicy.bindInstallation(repositoryAdmission, backends);
  }
  return {
    installation: admittedInstallation,
    agentCredentialWithdrawal,
    agentDrafts,
    agentAutomations,
    agentQueries,
    agentTermination,
    bindInstallationRepository,
    configurationOperations,
    credentialProxyCapacity,
    credentials,
    deploymentRequests,
    drivers,
    getInstallationDeploymentInventory,
    iamPolicy,
    installationCapabilityQueries,
    namespaces,
    observeNamespaceLifecycle,
    pendingOperations,
    pluginDiscovery,
    presets,
    provisioningRequests,
    provisioningWorker,
    readAgentAuditEvents,
    repositoryPolicy,
    runtimeCredentials,
    runtimeObservations,
    sandboxPolicyOperations,
    secretOperations,
    serviceAccountOperations,
    setupDiscovery,
    transactions,
    validateBackendConfiguration,
    withAuthorityFence: authority.withAuthorityFence,
    withRequestAuditId: workRecorder.withRequestAuditId,
  };
}
