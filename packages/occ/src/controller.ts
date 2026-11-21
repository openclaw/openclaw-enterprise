import {
  createControllerComposition,
  type ControllerComposition,
  type ControllerOptions,
  type PENDING_CONNECTION,
  type ReconciliationOperation,
} from "./controller-composition.ts";
import { type NamespaceLifecycleEvidence } from "./namespace-lifecycle.ts";
import { type CreateNamespaceInput } from "./namespace-operations.ts";
import {
  type CreateConnectionTemplateInput,
  type CreateOAuthClientInput,
  type DiscoverMcp,
  type UpdateConnectionTemplateInput,
} from "./connection-administration.ts";
import {
  type CompleteNamespaceConnectionInput,
  type StartNamespaceConnectionInput,
} from "./saved-oauth-connections.ts";
import {
  type CreateIAMAccessBindingInput,
  type CreateIAMRoleInput,
} from "./iam-policy-operations.ts";

import {
  type InstallationRepositoryAdmission,
  type RemoveStandingApprovalInput,
} from "./repository-policy.ts";

import {
  type CreateCredentialSourceInput,
  type RotateCredentialSourceInput,
  type UpdateCredentialSourceInput,
} from "./credential-source-operations.ts";

import { CredentialProxy } from "./credential-proxy.ts";
import type { EgressExchangeOwner } from "@openclaw-enterprise/contracts";
import { runtimeCredentialsInput } from "./agent-runtime-credentials.ts";
import type { InstalledDriver } from "./installed-driver.ts";
import {
  type CreatePresetInput,
  type DefaultPresetRefreshSkip,
  type SkippedDefaultPreset,
  type UpdatePresetInput,
} from "./preset-operations.ts";
import {
  type ConfigurationContext,
  type DriverConfigurationDescriptor,
  type ConfigurationResult,
} from "@openclaw-enterprise/contracts";
import type {
  SandboxPolicy,
  SandboxFacet,
  SandboxNetworkGrant,
  SandboxPolicyRecommendations,
} from "@openclaw-enterprise/contracts";

import type { RemovedAccessBinding } from "./iam-policy-cleanup.ts";
import {
  type RuntimeLogReadAdmission,
  type RuntimeLogReadRequest,
} from "./agent-runtime-observations.ts";
import {
  type ManagedMcpConnection,
  type ManagedMcpToolReader,
  type PluginDiscoveryCredential,
} from "./plugin-discovery.ts";
import { type DeviceAuthorizationAudit } from "./device-authorization-flow.ts";
import type {
  Agent,
  AgentRead,
  AgentRevisionRead,
  AgentDeploymentDiagnostics,
  AgentRuntimeDescription,
  AgentHarnessStatusRead,
  AgentRevision,
  FirstDeploymentReceipt,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  AccessBinding,
  AgentChatCompletionsResolution,
  Configuration,
  SavedConnection,
  OAuthRefreshTokenRegistration,
  OAuthAccountRef,
  OAuthConnectionClient,
  OAuthClient,
  ConnectionTemplate,
  CredentialSourceReference,
  SourceRegistrationInput,
  CredentialSourceMetadata,
  CredentialSourceStatus,
  CredentialWithdrawalStatus,
  AuditEvent,
  Driver,
  DriverCapability,
  Installation,
  InstallationCapabilities,
  InstallationDeploymentInventory,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  OpenClawConfigurationDocument,
  Preset,
  PresetSummary,
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDriver,
  ChannelDirectoryResult,
  RepositoryOptions,
  ResourceRef,
  Role,
  SecretDetail,
  SecretMetadata,
  ServiceAccount,
  ServiceAccountCredential,
  ServicePrincipal,
} from "@openclaw-enterprise/contracts";

import type { ClaimedWork } from "./controller-work.ts";
import { type AgentRevisionListPage, type ActiveAgentRevisionSelection } from "./agent-queries.ts";
import type {
  AuthorizedAgentDeployment,
  DeployAgentInput,
  FirstDeploymentIntent,
} from "./deployment-authorization.ts";
import {
  type AgentConfigurationPreparation,
  type CreateAgentInput,
  type UpdateAgentInput,
  type ValidateAgentCreateInput,
} from "./agent-drafts.ts";
import { type DriverFor } from "./driver-registry.ts";
import { type LookupChannelDirectoryInput } from "./setup-discovery.ts";
import { type AgentCredentialSourceInput } from "./agent-credential-withdrawal.ts";
import { type HarnessResolver } from "./agent-harness-topology.ts";
import type { RuntimeLogPage, RuntimeLogQuery } from "./runtime-logs/index.ts";
import { type UpdateManagedCredentialSourceInput } from "./managed-credential-sources.ts";

import type { AgentAuditSelection } from "./ports/agent-audit.ts";
import {
  type AuthorityFence,
  type AuthorizationSnapshot as DeployAgentAuthorization,
} from "./controller-authority.ts";

import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { DeploymentStatusResult } from "./controller-work.ts";
import { type ProvisionAgentInput, type ProvisionAgentResult } from "./agent-provisioning.ts";

import {
  type AgentProvisioningWorkerOptions,
  type AgentProvisioningWorkerOutcome,
} from "./agent-provisioning-worker.ts";
import { type CreateSecretInput, type UpdateSecretInput } from "./secret-operations.ts";
import {
  type CreateConfigurationInput,
  type UpdateConfigurationInput,
} from "./configuration-operations.ts";
import {
  type CreateServiceAccountInput,
  type ServiceAccountDeletion,
} from "./service-account-operations.ts";

export class OpenClawController {
  /** @internal Bind the Installation's exact owner for fresh revision admission. */
  static forInstallation(
    installation: Installation,
    options: ControllerOptions,
    repositoryAdmission: InstallationRepositoryAdmission | undefined,
  ): OpenClawController {
    const controller = new OpenClawController(installation, options);
    controller.composition.bindInstallationRepository(repositoryAdmission);
    return controller;
  }

  readonly installation: Readonly<Installation>;

  private readonly composition: ControllerComposition;

  constructor(installation: Installation, options: ControllerOptions = {}) {
    this.composition = createControllerComposition(installation, options, this);
    this.installation = this.composition.installation;
  }

  registerDriver<T extends Driver | InstalledDriver>(driver: T): T {
    return this.composition.drivers.registerDriver(driver);
  }

  /** Install one trusted catalog per Harness family. */
  installPluginDrivers(drivers: readonly PluginDriver[]): void {
    this.composition.drivers.installPluginDrivers(drivers);
  }

  /** Register one configured owner, then select its exact capability views. */
  installDriver(owner: InstalledDriver, select: readonly DriverCapability[]): void {
    const views = select.map((key) => owner.require(key));
    this.registerDriver(owner);
    for (const view of views) {
      this.selectDriver(view.capability, view.id);
    }
  }

  selectDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
    driverId: string,
  ): DriverFor<Capability> {
    return this.composition.drivers.selectDriver(selectedCapability, driverId);
  }

  selectedDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
  ): DriverFor<Capability> {
    return this.composition.drivers.selectedDriver(selectedCapability);
  }

  async validateBackendConfiguration(): Promise<void> {
    return this.composition.validateBackendConfiguration();
  }

  async getInstallation(principalId: string): Promise<Readonly<Installation>> {
    return this.composition.installationCapabilityQueries.getInstallation(principalId);
  }

  /**
   * The capabilities Agent creation in a Namespace needs, for a caller who may create Agents
   * there but cannot read the Installation, such as a Default user (RFC-0026).
   */
  async getNamespaceAgentCapabilities(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<Omit<InstallationCapabilities, "agentProvisioning">>> {
    return this.composition.installationCapabilityQueries.getNamespaceAgentCapabilities(
      principalId,
      namespaceId,
    );
  }

  async getInstallationDeploymentInventory(
    principalId: string,
  ): Promise<Readonly<InstallationDeploymentInventory>> {
    return this.composition.getInstallationDeploymentInventory(principalId);
  }

  async listNamespaces(principalId: string): Promise<readonly Readonly<Namespace>[]> {
    return this.composition.namespaces.listNamespaces(principalId);
  }

  async getNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    return this.composition.namespaces.getNamespace(principalId, namespaceId);
  }

  async listIAMRoles(principalId: string, namespaceId: string): Promise<readonly Readonly<Role>[]> {
    return this.composition.iamPolicy.listIAMRoles(principalId, namespaceId);
  }

  async createIAMRole(principalId: string, input: CreateIAMRoleInput): Promise<Readonly<Role>> {
    return this.composition.iamPolicy.createIAMRole(principalId, input);
  }

  async getIAMRole(
    principalId: string,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role>> {
    return this.composition.iamPolicy.getIAMRole(principalId, namespaceId, roleId);
  }

  // Returns the removed Role so the caller can audit what was deleted.
  async deleteIAMRole(
    principalId: string,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role>> {
    return this.composition.iamPolicy.deleteIAMRole(principalId, namespaceId, roleId);
  }

  async listIAMAccessBindings(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<AccessBinding>[]> {
    return this.composition.iamPolicy.listIAMAccessBindings(principalId, namespaceId);
  }

  /**
   * Configured Group IDs that each account created through the API joins: none when the
   * selected IAM Driver does not hold configured policy in this State.
   */
  get defaultUserGroupIds(): readonly string[] {
    return this.composition.iamPolicy.defaultUserGroupIds();
  }

  async createIAMAccessBinding(
    principalId: string,
    input: CreateIAMAccessBindingInput,
  ): Promise<Readonly<AccessBinding>> {
    return this.composition.iamPolicy.createIAMAccessBinding(principalId, input);
  }

  async getIAMAccessBinding(
    principalId: string,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding>> {
    return this.composition.iamPolicy.getIAMAccessBinding(principalId, namespaceId, bindingId);
  }

  // Returns the removed AccessBinding so the caller can audit who lost access.
  async deleteIAMAccessBinding(
    principalId: string,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding>> {
    return this.composition.iamPolicy.deleteIAMAccessBinding(principalId, namespaceId, bindingId);
  }

  async listIAMServicePrincipals(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServicePrincipal>[]> {
    return this.composition.iamPolicy.listIAMServicePrincipals(principalId, namespaceId);
  }

  async getIAMServicePrincipal(
    principalId: string,
    namespaceId: string,
    servicePrincipalId: string,
  ): Promise<Readonly<ServicePrincipal>> {
    return this.composition.iamPolicy.getIAMServicePrincipal(
      principalId,
      namespaceId,
      servicePrincipalId,
    );
  }

  /**
   * Creates a non-Agent ServicePrincipal fixed to one Namespace. It holds no grant until an
   * AccessBinding names it, and its keys are issued through the service-key route.
   */
  async createIAMServicePrincipal(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<ServicePrincipal>> {
    return this.composition.iamPolicy.createIAMServicePrincipal(principalId, namespaceId);
  }

  async listAgents(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<AgentRead>[]> {
    return this.composition.agentQueries.listAgents(principalId, namespaceId);
  }

  async listRepositoryOptions(
    principalId: string,
    namespaceId: string,
    agentId?: string,
  ): Promise<Readonly<RepositoryOptions & { notConfigured?: true }>> {
    return this.composition.repositoryPolicy.listRepositoryOptions(
      principalId,
      namespaceId,
      agentId,
    );
  }

  async getAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    return this.composition.agentQueries.getAuthorizedAgent(
      principalId,
      namespaceId,
      agentId,
      "read",
    );
  }

  /** Resolve an opaque address before the caller authorizes the exact Agent operation. */
  async resolveAgentReference(
    matches: (agent: Pick<Agent, "id" | "namespaceId">) => boolean,
  ): Promise<Pick<Agent, "id" | "namespaceId"> | undefined> {
    return this.composition.agentQueries.resolveAgentReference(matches);
  }

  /** Resolve stored ownership and authorize before consulting the selected Compute Driver. */
  async resolveAgentChat(
    principalId: string,
    agentId: string,
    namespaceScope?: string,
  ): Promise<{
    readonly agent: Readonly<Agent>;
    readonly revision?: Readonly<AgentRevision>;
    readonly endpoint: AgentChatCompletionsResolution;
  }> {
    return this.composition.agentQueries.resolveAgentChat(principalId, agentId, namespaceScope);
  }

  async getAdministerableAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    return this.composition.agentQueries.getAuthorizedAgent(
      principalId,
      namespaceId,
      agentId,
      "administer",
    );
  }

  /** Select the native browser authority for this exact Agent through the selected IAM Driver. */
  async getAgentBrowserAccess(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<{ readonly agent: Readonly<Agent>; readonly mode: "admin" | "chat" }> {
    return this.composition.agentQueries.getAuthorizedAgent(
      principalId,
      namespaceId,
      agentId,
      "browser",
    );
  }

  async getBrowserAccessibleActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection & { readonly mode: "admin" | "chat" }> {
    return this.composition.agentQueries.getAuthorizedActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
      "browser",
    );
  }

  async getAgentForBrowsing(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRead>> {
    return this.composition.agentQueries.getAgentForBrowsing(principalId, namespaceId, agentId);
  }

  async listAgentAuditEvents(
    principalId: string,
    namespaceId: string,
    agentId: string,
    selection: AgentAuditSelection,
    holdSession: AuthorityFence,
    disclosure: (count: number, decision: DeployAgentAuthorization) => AuditEvent,
  ) {
    return this.composition.readAgentAuditEvents(
      principalId,
      namespaceId,
      agentId,
      selection,
      holdSession,
      disclosure,
    );
  }

  async getAgentRuntimeImages(principalId: string, namespaceId: string, agentId: string) {
    return this.composition.runtimeObservations.getAgentRuntimeImages(
      principalId,
      namespaceId,
      agentId,
    );
  }

  async getAgentHarnessStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentHarnessStatusRead>> {
    return this.composition.runtimeObservations.getAgentHarnessStatus(
      principalId,
      namespaceId,
      agentId,
    );
  }

  async getAgentRuntimeCredentialStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
    return this.composition.runtimeCredentials.getAgentRuntimeCredentialStatus(
      principalId,
      namespaceId,
      agentId,
    );
  }

  async provisionAgentRuntimeCredentials(
    principalId: string,
    namespaceId: string,
    agentId: string,
    input: AgentRuntimeCredentialsInput,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
    return this.composition.runtimeCredentials.provisionAgentRuntimeCredentials(
      principalId,
      namespaceId,
      agentId,
      runtimeCredentialsInput(input),
    );
  }

  async provisionAgent(
    principalId: string,
    input: ProvisionAgentInput,
    auditEvent?: (result: Readonly<ProvisionAgentResult>) => AuditEvent,
    configurationPreparation?: {
      readonly key: string;
      readonly prepare: (
        agent: Pick<Agent, "id" | "namespaceId">,
        values: Readonly<OpenClawConfigurationDocument>,
      ) => Readonly<OpenClawConfigurationDocument>;
    },
  ): Promise<Readonly<ProvisionAgentResult>> {
    return this.composition.provisioningRequests.provisionAgent(
      principalId,
      input,
      auditEvent,
      configurationPreparation,
    );
  }

  async getAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    return this.composition.provisioningRequests.getAgentProvisioning(
      principalId,
      namespaceId,
      workId,
    );
  }

  async retryAgentProvisioning(
    principalId: string,
    namespaceId: string,
    workId: string,
  ): Promise<Readonly<ProvisionAgentResult>> {
    return this.composition.provisioningRequests.retryAgentProvisioning(
      principalId,
      namespaceId,
      workId,
    );
  }

  async processAgentProvisioning(
    claim: ClaimedWork,
    resolveHarness: HarnessResolver,
    options: AgentProvisioningWorkerOptions = {},
  ): Promise<Readonly<AgentProvisioningWorkerOutcome>> {
    return this.composition.provisioningWorker.processAgentProvisioning(
      claim,
      resolveHarness,
      options,
    );
  }

  async diagnoseAgentDeployment(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
  ): Promise<Readonly<AgentDeploymentDiagnostics>> {
    return this.composition.runtimeObservations.diagnoseAgentDeployment(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
    );
  }

  async describeAgentRuntime(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
    signal?: AbortSignal,
    admitRead: RuntimeLogReadAdmission = (read) => read(),
  ): Promise<Readonly<AgentRuntimeDescription>> {
    return this.composition.runtimeObservations.describeAgentRuntime(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
      signal,
      admitRead,
    );
  }

  async readAgentRuntimeLogs(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
    query: RuntimeLogQuery,
    requested: RuntimeLogReadRequest,
  ): Promise<Readonly<RuntimeLogPage>> {
    return this.composition.runtimeObservations.readAgentRuntimeLogs(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
      query,
      requested,
    );
  }

  async getServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    return this.composition.serviceAccountOperations.getServiceAccount(
      principalId,
      namespaceId,
      serviceAccountId,
    );
  }

  async listUsableConnectionTemplates(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ConnectionTemplate>[]> {
    return this.composition.credentials.savedConnections.listUsableConnectionTemplates(
      principalId,
      namespaceId,
    );
  }

  async startNamespaceConnection(
    principalId: string,
    input: StartNamespaceConnectionInput,
    audit?: (credentialSourceId: string) => AuditEvent,
  ): Promise<{
    readonly credentialSourceId: string;
    readonly authorizationUrl: string;
    readonly expiresAt: string;
  }> {
    return this.composition.credentials.savedConnections.startNamespaceConnection(
      principalId,
      input,
      audit,
    );
  }

  async expireAuthenticationStates(limit: number): Promise<void> {
    return this.composition.credentials.savedConnections.expireAuthenticationStates(limit);
  }

  async completeNamespaceConnection(
    principalId: string,
    input: CompleteNamespaceConnectionInput,
    audit?: (connection: Readonly<SavedConnection>) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ): Promise<Readonly<SavedConnection>> {
    return this.composition.credentials.savedConnections.completeNamespaceConnection(
      principalId,
      input,
      audit,
      holdSession,
    );
  }

  async listNamespaceConnections(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<SavedConnection>[]> {
    return this.composition.credentials.savedConnections.listNamespaceConnections(
      principalId,
      namespaceId,
    );
  }

  async disconnectNamespaceConnection(
    principalId: string,
    namespaceId: string,
    sourceId: string,
    audit?: AuditEvent,
  ): Promise<void> {
    return this.composition.credentials.savedConnections.disconnectNamespaceConnection(
      principalId,
      namespaceId,
      sourceId,
      audit,
    );
  }

  async finishConnectionRevocation(namespaceId: string, sourceId: string): Promise<void> {
    return this.composition.credentials.savedConnections.finishConnectionRevocation(
      namespaceId,
      sourceId,
    );
  }

  /** Used by the installed Token Service to authenticate the original client on each renewal. */
  async resolveConnectionClient(
    reference: OAuthAccountRef,
    approval?: OAuthRefreshTokenRegistration["approval"],
  ): Promise<OAuthConnectionClient> {
    return this.composition.credentials.savedConnections.resolveConnectionClient(
      reference,
      approval,
    );
  }

  maintainConnectionToken(namespaceId: string, sourceId: string) {
    return this.composition.credentials.savedConnections.maintainConnectionToken(
      namespaceId,
      sourceId,
    );
  }

  async listConnectionTemplates(
    principalId: string,
  ): Promise<readonly Readonly<ConnectionTemplate>[]> {
    return this.composition.credentials.connectionAdministration.listConnectionTemplates(
      principalId,
    );
  }

  async getConnectionTemplate(
    principalId: string,
    templateId: string,
  ): Promise<Readonly<ConnectionTemplate>> {
    return this.composition.credentials.connectionAdministration.getConnectionTemplate(
      principalId,
      templateId,
    );
  }

  async discoverConnectionTemplate(
    principalId: string,
    input: { serverUrl: string; issuer?: string },
    discover: DiscoverMcp,
  ) {
    return this.composition.credentials.connectionAdministration.discoverConnectionTemplate(
      principalId,
      input,
      discover,
    );
  }

  async createConnectionTemplate(
    principalId: string,
    input: CreateConnectionTemplateInput,
    discover: DiscoverMcp,
    audit?: (id: string) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ): Promise<Readonly<ConnectionTemplate>> {
    return this.composition.credentials.connectionAdministration.createConnectionTemplate(
      principalId,
      input,
      discover,
      audit,
      holdSession,
    );
  }

  async updateConnectionTemplate(
    principalId: string,
    id: string,
    input: UpdateConnectionTemplateInput,
    discover: DiscoverMcp,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.composition.credentials.connectionAdministration.updateConnectionTemplate(
      principalId,
      id,
      input,
      discover,
      audit,
      holdSession,
    );
  }

  async deleteConnectionTemplate(
    principalId: string,
    id: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.composition.credentials.connectionAdministration.deleteConnectionTemplate(
      principalId,
      id,
      audit,
      holdSession,
    );
  }

  async listOAuthClients(principalId: string) {
    return this.composition.credentials.connectionAdministration.listOAuthClients(principalId);
  }

  async createOAuthClient(
    principalId: string,
    input: CreateOAuthClientInput,
    audit?: (id: string) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.composition.credentials.connectionAdministration.createOAuthClient(
      principalId,
      input,
      audit,
      holdSession,
    );
  }

  async rotateOAuthClientSecret(
    principalId: string,
    id: string,
    clientSecret: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.composition.credentials.connectionAdministration.rotateOAuthClientSecret(
      principalId,
      id,
      clientSecret,
      audit,
      holdSession,
    );
  }

  async deleteOAuthClient(
    principalId: string,
    id: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    return this.composition.credentials.connectionAdministration.deleteOAuthClient(
      principalId,
      id,
      audit,
      holdSession,
    );
  }

  async cleanupOAuthClients(): Promise<void> {
    return this.composition.credentials.connectionAdministration.cleanupOAuthClients();
  }

  /** Trusted, server-side OAuth operations resolve the current value at each use. */
  async withOAuthClientSecret<T>(
    client: Readonly<OAuthClient>,
    use: (secret: string | undefined) => Promise<T>,
  ): Promise<T> {
    return this.composition.credentials.connectionAdministration.withOAuthClientSecret(client, use);
  }

  async listServiceAccounts(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServiceAccount>[]> {
    return this.composition.serviceAccountOperations.listServiceAccounts(principalId, namespaceId);
  }

  /**
   * One page of the Agent's revisions the principal may read, newest first, as summaries: a
   * list never decodes a saved snapshot (finding 1323). The page holds up to `limit` readable
   * revisions numbered below `before`; unreadable ones are skipped. `nextBefore` names the
   * page's last revision, and only when an older revision was found readable when checked.
   */
  async listRevisions(
    principalId: string,
    namespaceId: string,
    agentId: string,
    page: { readonly before?: number; readonly limit: number } = { limit: 50 },
  ): Promise<Readonly<AgentRevisionListPage>> {
    return this.composition.agentQueries.listRevisions(principalId, namespaceId, agentId, page);
  }

  async getRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision>> {
    return this.composition.agentQueries.getRevision(principalId, namespaceId, agentId, revisionId);
  }

  async getRevisionForBrowsing(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevisionRead>> {
    return this.composition.agentQueries.getRevisionForBrowsing(
      principalId,
      namespaceId,
      agentId,
      revisionId,
    );
  }

  async getDeploymentStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
  ): Promise<DeploymentStatusResult> {
    return this.composition.agentQueries.getDeploymentStatus(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
    );
  }

  async getReadableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.composition.agentQueries.getAuthorizedActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
      "read",
    );
  }

  async getOperableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.composition.agentQueries.getAuthorizedActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
      "operate",
    );
  }

  async getAdministerableActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<ActiveAgentRevisionSelection> {
    return this.composition.agentQueries.getAuthorizedActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
      "administer",
    );
  }

  async createNamespace(
    principalId: string,
    input: CreateNamespaceInput,
  ): Promise<Readonly<Namespace>> {
    return this.composition.namespaces.createNamespace(principalId, input);
  }

  /**
   * Runs `work` with a fence that each transaction writing durable authority applies first: the
   * HTTP layer holds the caller's session through COMMIT, as Namespace policy writes do, so a
   * sign-out or account disable cannot commit in between (#2311).
   */
  withAuthorityFence<T>(fence: AuthorityFence, work: () => Promise<T>): Promise<T> {
    return this.composition.withAuthorityFence(fence, work);
  }

  /** Attach the server-generated HTTP request ID to any work this operation queues. */
  withRequestAuditId<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    return this.composition.withRequestAuditId(requestId, work);
  }

  /**
   * Makes the configured Roles, Groups, and Group bindings in IAM policy match the `iam`
   * configuration. The composition calls it at startup, and Installation bootstrap calls it once
   * the Installation exists. It holds the IAM configuration lock exclusively, so a write of
   * durable authority commits wholly before or after it. Owner bindings, deploy-time grants, and
   * Group memberships stay when the configuration changes.
   */
  async applyIAMConfiguration(): Promise<void> {
    return this.composition.iamPolicy.applyIAMConfiguration();
  }

  /** Apply trusted Installation defaults to ready and provisioning Namespaces. */
  async initializeDefaultPresets(
    principalId: string,
    options: { readonly skipRefusedRefresh?: DefaultPresetRefreshSkip } = {},
  ): Promise<readonly SkippedDefaultPreset[]> {
    return this.composition.presets.initializeDefaultPresets(principalId, options);
  }

  async createPreset(principalId: string, input: CreatePresetInput): Promise<Readonly<Preset>> {
    return this.composition.presets.createPreset(principalId, input);
  }

  async listPresets(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<PresetSummary>[]> {
    return this.composition.presets.listPresets(principalId, namespaceId);
  }

  async getPreset(
    principalId: string,
    namespaceId: string,
    presetId: string,
  ): Promise<Readonly<Preset>> {
    return this.composition.presets.getPreset(principalId, namespaceId, presetId);
  }

  /** Check the write grant before the HTTP layer reads the request body. */
  async authorizePresetWrite(
    principalId: string,
    namespaceId: string,
    presetId?: string,
  ): Promise<void> {
    return this.composition.presets.authorizePresetWrite(principalId, namespaceId, presetId);
  }

  async updatePreset(principalId: string, input: UpdatePresetInput): Promise<Readonly<Preset>> {
    return this.composition.presets.updatePreset(principalId, input);
  }

  /** Returns the AccessBindings removed with the Preset, for its deletion audit. */
  async deletePreset(
    principalId: string,
    namespaceId: string,
    presetId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    return this.composition.presets.deletePreset(principalId, namespaceId, presetId);
  }

  /**
   * The grant check that opens createConfiguration (no configurationId) or
   * updateConfiguration, alone. The HTTP layer runs it before it reads a write's body (up to
   * about 6 MiB), so a caller without the grant is refused without the body being buffered.
   * Both writes repeat it in their transaction, followed by the Secret binding checks.
   */
  async authorizeConfigurationWrite(
    principalId: string,
    namespaceId: string,
    configurationId?: string,
  ): Promise<void> {
    return this.composition.configurationOperations.authorizeConfigurationWrite(
      principalId,
      namespaceId,
      configurationId,
    );
  }

  async createSecret(
    principalId: string,
    input: CreateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    return this.composition.secretOperations.createSecret(principalId, input);
  }

  async readSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretDetail>> {
    return this.composition.secretOperations.readSecret(principalId, namespaceId, secretId);
  }

  async listSecrets(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<SecretMetadata>[]> {
    return this.composition.secretOperations.listSecrets(principalId, namespaceId);
  }

  /**
   * The IDs of the Namespace's Secrets the principal may read but not operate, sorted: an
   * advisory answer for clients that bind Secrets, which needs operate on each (finding 2453).
   * Each decision is the one binding makes. One read unit makes them all, so the selected IAM
   * Driver reads its policy once, not once per Secret; a false decision is an answer, not an
   * audited attempt. The caller checks Namespace read first.
   */
  async listSecretsOperateDenied(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly string[]> {
    return (await this.secretsOperateDenied(principalId, namespaceId, new Set())).readable;
  }

  /**
   * The Namespace's Secrets the principal may read but not operate (`readable`, sorted IDs), and
   * how many of its Secrets in `unreadableAmong` the principal may neither read nor operate
   * (`unreadableCount`): an advisory count for a client that deploys a draft binding them, which
   * needs operate on each (finding D756). The count names none, since the principal may not read
   * them. One read unit and one Secret scan; a false decision is an answer, not an audited
   * attempt. The caller checks Namespace read first.
   */
  async secretsOperateDenied(
    principalId: string,
    namespaceId: string,
    unreadableAmong: ReadonlySet<string>,
  ): Promise<{ readonly readable: readonly string[]; readonly unreadableCount: number }> {
    return this.composition.secretOperations.secretsOperateDenied(
      principalId,
      namespaceId,
      unreadableAmong,
    );
  }

  async updateSecret(
    principalId: string,
    input: UpdateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    return this.composition.secretOperations.updateSecret(principalId, input);
  }

  /** Returns the AccessBindings removed with the Secret, for its deletion audit. */
  async deleteSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    return this.composition.secretOperations.deleteSecret(principalId, namespaceId, secretId);
  }

  /** Trusted composition only: public workloads never supply an identity verifier. */
  createCredentialProxy(exchangeOwner: EgressExchangeOwner): CredentialProxy {
    return new CredentialProxy(
      this.composition.credentials.createProxyAuthority(exchangeOwner),
      this.composition.credentialProxyCapacity,
    );
  }

  /** Bind the configured adapter to the actual durable credential store before use. */
  async activateTokenServiceInstance(driverId: string, storeIdentity: string): Promise<string> {
    return this.composition.credentials.managedCredentialSources.activateTokenServiceInstance(
      driverId,
      storeIdentity,
    );
  }

  currentTokenServiceInstanceId(): string {
    return this.composition.credentials.managedCredentialSources.currentTokenServiceInstanceId();
  }

  async createManagedCredentialSource(
    principalId: string,
    namespaceId: string,
    input: Omit<SourceRegistrationInput, "namespaceId" | "config"> & {
      readonly providerPreset?: string;
    },
    audit: (resource: CredentialSourceReference, phase?: "registration_started") => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata>> {
    return this.composition.credentials.managedCredentialSources.createManagedCredentialSource(
      principalId,
      namespaceId,
      input,
      audit,
    );
  }

  async updateManagedCredentialSource(
    principalId: string,
    ref: { readonly namespaceId: string; readonly credentialSourceId: string },
    input: UpdateManagedCredentialSourceInput,
    audit: (resource: CredentialSourceReference, phase?: "update_started") => AuditEvent,
    failureAudit: (reasonCode: string) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata>> {
    return this.composition.credentials.managedCredentialSources.updateManagedCredentialSource(
      principalId,
      ref,
      input,
      audit,
      failureAudit,
    );
  }

  async createCredentialSource(
    principalId: string,
    input: CreateCredentialSourceInput,
    audit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
    registrationAudit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    return this.composition.credentials.credentialSourceOperations.createCredentialSource(
      principalId,
      input,
      audit,
      registrationAudit,
    );
  }

  async updateCredentialSource(
    principalId: string,
    input: UpdateCredentialSourceInput,
    failureAudit?: (reasonCode: string) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    return this.composition.credentials.credentialSourceOperations.updateCredentialSource(
      principalId,
      input,
      failureAudit,
    );
  }

  async rotateCredentialSource(
    principalId: string,
    input: RotateCredentialSourceInput,
    failureAudit?: (reasonCode: string) => AuditEvent,
    audit?: AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    return this.composition.credentials.credentialSourceOperations.rotateCredentialSource(
      principalId,
      input,
      failureAudit,
      audit,
    );
  }

  async credentialSourceUpdateIdentity(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<{ readonly managed: boolean; readonly type: string }> {
    return this.composition.credentials.credentialSourceOperations.credentialSourceUpdateIdentity(
      principalId,
      namespaceId,
      credentialSourceId,
    );
  }

  async readCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    return this.composition.credentials.credentialSourceOperations.readCredentialSource(
      principalId,
      namespaceId,
      credentialSourceId,
    );
  }

  async listCredentialSources(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<CredentialSourceMetadata>[]> {
    return this.composition.credentials.credentialSourceOperations.listCredentialSources(
      principalId,
      namespaceId,
    );
  }

  async deleteCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit?: (
      removedAccessBindings: readonly RemovedAccessBinding[],
      phase?: "retirement_started",
    ) => AuditEvent,
    connection?: typeof PENDING_CONNECTION,
  ): Promise<void> {
    return this.composition.credentials.managedCredentialSources.deleteCredentialSource(
      principalId,
      namespaceId,
      credentialSourceId,
      audit,
      connection,
    );
  }

  async createConfiguration(
    principalId: string,
    input: CreateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    return this.composition.configurationOperations.createConfiguration(principalId, input);
  }

  async createServiceAccount(
    principalId: string,
    input: CreateServiceAccountInput,
  ): Promise<Readonly<ServiceAccount>> {
    return this.composition.serviceAccountOperations.createServiceAccount(principalId, input);
  }

  async createServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    return this.composition.serviceAccountOperations.createServiceAccountCredential(
      principalId,
      namespaceId,
      serviceAccountId,
    );
  }

  async updateServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount>> {
    return this.composition.serviceAccountOperations.updateServiceAccountCredential(
      principalId,
      namespaceId,
      serviceAccountId,
      credential,
    );
  }

  /**
   * `force` matters only for an account holding an issued access token while this API selects
   * no ServiceAccount Driver (no ChatGPT Backend): instead of refusing, it removes the
   * account-owned token Secret and the account, and reports the token as unrevoked. With a
   * Driver selected, force is ignored and the token is revoked as usual, so a revocation that
   * can run is never skipped. Grants, the account lookup, and reference checks are unchanged.
   */
  async deleteServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<ServiceAccountDeletion> {
    return this.composition.serviceAccountOperations.deleteServiceAccount(
      principalId,
      namespaceId,
      serviceAccountId,
      options,
    );
  }

  async getConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Configuration>> {
    return this.composition.configurationOperations.getConfiguration(
      principalId,
      namespaceId,
      configurationId,
    );
  }

  /**
   * The Secret each binding name of a Configuration binds now, from its record alone. Each save
   * of the Configuration authorizes Secret operate on every Secret it submits, or on every bound
   * Secret when it submits no bindings, so the caller-permissions answer checks these. Requires
   * Configuration read. Unlike getConfiguration it skips the provisioning guard, so it also
   * answers before provisioning has written the Configuration. That is safe: saves are refused
   * while the Agent is provisioning, so the answer enables no save, and the guard's 409 would
   * fail the whole caller-permissions answer.
   */
  async getConfigurationSecretBindingSources(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Record<string, Readonly<ResourceRef>>>> {
    return this.composition.configurationOperations.getConfigurationSecretBindingSources(
      principalId,
      namespaceId,
      configurationId,
    );
  }

  async updateConfiguration(
    principalId: string,
    input: UpdateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    return this.composition.configurationOperations.updateConfiguration(principalId, input);
  }

  async deleteConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    return this.composition.configurationOperations.deleteConfiguration(
      principalId,
      namespaceId,
      configurationId,
    );
  }

  async startAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    harnessId: string,
    agentId?: string,
    audit?: DeviceAuthorizationAudit,
  ) {
    return this.composition.credentials.deviceAuthorization.start(
      principalId,
      namespaceId,
      harnessId,
      agentId,
      audit,
    );
  }

  async pollAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ) {
    return this.composition.credentials.deviceAuthorization.poll(
      principalId,
      namespaceId,
      sessionId,
      agentId,
    );
  }

  async cancelAgentDeviceAuthorization(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ): Promise<void> {
    return this.composition.credentials.deviceAuthorization.cancel(
      principalId,
      namespaceId,
      sessionId,
      agentId,
    );
  }

  async discoverAgentModels(
    principalId: string,
    namespaceId: string,
    input: {
      readonly provider: string;
      readonly authMethod: "api_key" | "codex_pat";
      readonly apiKey: string;
    },
  ) {
    return this.composition.setupDiscovery.discoverAgentModels(principalId, namespaceId, input);
  }

  async discoverAgentPlugins(
    principalId: string,
    namespaceId: string,
    input: PluginDiscoveryCredential & {
      readonly harnessId: string;
      readonly cursor?: string;
      readonly q?: string;
    },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage> {
    return this.composition.pluginDiscovery.discoverAgentPlugins(
      principalId,
      namespaceId,
      input,
      signal,
    );
  }

  async lookupChannelDirectory(
    principalId: string,
    namespaceId: string,
    input: LookupChannelDirectoryInput,
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult> {
    return this.composition.setupDiscovery.lookupChannelDirectory(
      principalId,
      namespaceId,
      input,
      signal,
    );
  }

  async discoverAgentPluginDetails(
    principalId: string,
    namespaceId: string,
    input: PluginDiscoveryCredential & { readonly harnessId: string; readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    return this.composition.pluginDiscovery.discoverAgentPluginDetails(
      principalId,
      namespaceId,
      input,
      signal,
    );
  }

  async getSavedAgentPluginPolicyCapabilities(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ) {
    return this.composition.pluginDiscovery.getSavedAgentPluginPolicyCapabilities(
      principalId,
      namespaceId,
      agentId,
    );
  }

  async discoverSavedAgentPlugins(
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
    return this.composition.pluginDiscovery.discoverSavedAgentPlugins(
      principalId,
      namespaceId,
      agentId,
      input,
      signal,
    );
  }

  async discoverSavedAgentPluginDetails(
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
    return this.composition.pluginDiscovery.discoverSavedAgentPluginDetails(
      principalId,
      namespaceId,
      agentId,
      input,
      signal,
      readMcpTools,
    );
  }

  async discoverConfigurations(
    principalId: string,
    context: ConfigurationContext,
  ): Promise<readonly DriverConfigurationDescriptor[]> {
    return this.composition.setupDiscovery.discoverConfigurations(principalId, context);
  }

  async validateAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    expectedVersion: number,
    additions: unknown,
  ): Promise<ConfigurationResult<{ readonly additions: readonly SandboxNetworkGrant[] }>> {
    return this.composition.sandboxPolicyOperations.validateAgentSandboxPolicy(
      principalId,
      namespaceId,
      agentId,
      facet,
      expectedVersion,
      additions,
    );
  }

  async getAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
  ) {
    return this.composition.sandboxPolicyOperations.getAgentSandboxPolicy(
      principalId,
      namespaceId,
      agentId,
      facet,
    );
  }

  // TODO: Replace this temporary admission switch with the platform Guardrails primitive.
  async TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    enabled: boolean,
  ): Promise<Readonly<Agent>> {
    return this.composition.sandboxPolicyOperations.setAgentSandboxPolicyEditing(
      principalId,
      namespaceId,
      agentId,
      facet,
      enabled,
    );
  }

  async updateAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    expectedVersion: number,
    additions: readonly SandboxNetworkGrant[],
  ): Promise<Readonly<SandboxPolicy>> {
    return this.composition.sandboxPolicyOperations.updateAgentSandboxPolicy(
      principalId,
      namespaceId,
      agentId,
      facet,
      expectedVersion,
      additions,
    );
  }

  async applyAgentSandboxPolicy(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    expectedVersion: number,
    revisionId: string,
    additions?: readonly SandboxNetworkGrant[],
  ): Promise<Readonly<SandboxPolicy>> {
    return this.composition.sandboxPolicyOperations.applyAgentSandboxPolicy(
      principalId,
      namespaceId,
      agentId,
      facet,
      expectedVersion,
      revisionId,
      additions,
    );
  }

  async readAgentSandboxRecommendations(
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
    revisionId: string,
    admitRead: (
      read: () => Promise<SandboxPolicyRecommendations>,
    ) => Promise<SandboxPolicyRecommendations>,
  ): Promise<SandboxPolicyRecommendations> {
    return this.composition.sandboxPolicyOperations.readAgentSandboxRecommendations(
      principalId,
      namespaceId,
      agentId,
      facet,
      revisionId,
      admitRead,
    );
  }

  async createAgent(
    principalId: string,
    input: CreateAgentInput,
    resolveHarness?: HarnessResolver,
    configurationPreparation?: AgentConfigurationPreparation,
  ): Promise<Readonly<Agent>> {
    return this.composition.agentDrafts.createAgent(
      principalId,
      input,
      resolveHarness,
      configurationPreparation,
    );
  }

  /**
   * Create Agent's preflight, for a Configuration the caller has not saved yet: createConfiguration's
   * content and Driver admission, then createAgent's checks of plugin selections and initial workspace files
   * against those values, with their messages, under createAgent's `agent:create` check. A
   * refusal is reported before the caller saves its Secret or Configuration. It writes nothing.
   * With `harnessAuth`, Agent save's Harness authentication check against the Compute Driver runs
   * too, so a refusal that depends only on the Agent's topology (finding 2391) is reported here.
   * With `configuration.secretBindings`, a foreign-Namespace reference or a channel credential
   * reference without a binding is refused as Configuration create would; the bound Secrets
   * are not read.
   * Checks that need saved resources (the bound Secrets, the Harness authentication source and
   * credential sources) or live repository policy stay with those writes.
   * With `name`, a name another Agent in the Namespace has is refused last, with create's 409
   * (finding 2420), so the form saves no Secret or Configuration for it. The check is advisory:
   * the store's unique name still refuses a create that races it.
   * `resolveHarness` as in createAgent.
   */
  async validateAgentCreate(
    principalId: string,
    input: ValidateAgentCreateInput,
    resolveHarness?: HarnessResolver,
  ): Promise<void> {
    return this.composition.agentDrafts.validateAgentCreate(principalId, input, resolveHarness);
  }

  async listAgentStandingApprovals(principalId: string, namespaceId: string, agentId: string) {
    return this.composition.repositoryPolicy.listAgentStandingApprovals(
      principalId,
      namespaceId,
      agentId,
    );
  }

  /** A review projection only: it neither creates nor extends authority. */
  async listAgentStandingApprovalScopes(principalId: string, namespaceId: string, agentId: string) {
    return this.composition.repositoryPolicy.listAgentStandingApprovalScopes(
      principalId,
      namespaceId,
      agentId,
    );
  }

  /** Denial commits independently of configuration, provider availability or runtime cleanup. */
  async removeAgentStandingApproval(
    principalId: string,
    input: RemoveStandingApprovalInput,
  ): Promise<void> {
    return this.composition.repositoryPolicy.removeAgentStandingApproval(principalId, input);
  }

  /**
   * `resolveHarness` (the deploy route's resolver) lets the save refuse a Harness/mode
   * mismatch and the Compute Driver's checks of the Agent against its Configuration, as
   * deployment would. Without it only the Sandbox execution-mode rule runs.
   */
  async updateAgent(
    principalId: string,
    input: UpdateAgentInput,
    resolveHarness?: HarnessResolver,
  ): Promise<Readonly<Agent>> {
    return this.composition.agentDrafts.updateAgent(principalId, input, resolveHarness);
  }

  async recoverAgentFirstDeployment(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
  ): Promise<Readonly<FirstDeploymentReceipt> | null> {
    return this.composition.deploymentRequests.recoverAgentFirstDeployment(
      principalId,
      input,
      intent,
    );
  }

  async deployAgentFirst(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<FirstDeploymentReceipt>> {
    return this.composition.deploymentRequests.deployAgentFirst(
      principalId,
      input,
      intent,
      resolveHarness,
      auditEvent,
    );
  }

  async deployAgent(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
  ): Promise<Readonly<AgentRevision>> {
    return (await this.deployAgentWithAuthorization(principalId, input, resolveHarness)).revision;
  }

  async deployAgentWithAuthorization(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<AuthorizedAgentDeployment>> {
    return this.composition.deploymentRequests.deployAgentWithAuthorization(
      principalId,
      input,
      resolveHarness,
      auditEvent,
    );
  }

  async withdrawAgentCredentialSource(
    principalId: string,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<CredentialWithdrawalStatus>> {
    return this.composition.agentCredentialWithdrawal.withdrawAgentCredentialSource(
      principalId,
      input,
    );
  }

  async readAgentCredentialWithdrawal(
    principalId: string,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<CredentialWithdrawalStatus>> {
    return this.composition.agentCredentialWithdrawal.readAgentCredentialWithdrawal(
      principalId,
      input,
    );
  }

  async stopAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
    expectedActiveRevisionId?: string,
  ): Promise<Readonly<Agent>> {
    return this.composition.agentTermination.stopAgent(
      principalId,
      namespaceId,
      agentId,
      expectedActiveRevisionId,
    );
  }

  /**
   * Begin or retry logical deletion of one exact, authorized, empty Namespace.
   * Driver effects remain deferred to handleNamespaceLifecycle().
   */
  async deleteNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    return this.composition.namespaces.deleteNamespace(principalId, namespaceId);
  }

  async deleteAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    return this.composition.agentTermination.deleteAgent(principalId, namespaceId, agentId);
  }

  /** Observe resources only; the caller owns authorization, claims, and status commits. */
  async observeNamespaceLifecycle(
    namespace: Readonly<Namespace>,
    target: "ready" | "deleted",
    signal: AbortSignal,
    record: (evidence: NamespaceLifecycleEvidence) => void | Promise<void>,
  ): Promise<NamespaceEnsureResult | NamespaceDeleteResult> {
    return this.composition.observeNamespaceLifecycle(namespace, target, signal, record);
  }

  /**
   * Execute one deterministic Namespace lifecycle attempt for a claimed work item.
   * This is a reusable conformance harness, not a polling production worker.
   */
  async handleNamespaceLifecycle(
    actorId: string,
    namespaceId: string,
    target: "ready" | "deleted",
  ): Promise<Readonly<Namespace> | undefined> {
    return this.composition.namespaces.handleNamespaceLifecycle(actorId, namespaceId, target);
  }

  /** Stage resources, reconciliation intents, and audit evidence as one unit. */
  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    return this.composition.transactions.transact(work);
  }

  /** Compensate a Driver side effect if the owning resource transaction fails. */
  registerRollback(rollback: () => Promise<void>): void {
    this.composition.transactions.registerRollback(rollback);
  }

  pendingOperations(): readonly Readonly<ReconciliationOperation>[] {
    return this.composition.pendingOperations();
  }
}
