import { isPositiveSafeInteger } from "@openclaw-enterprise/utils";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isSandboxFacet, normalizeSecretBindings } from "@openclaw-enterprise/contracts";
import type {
  Agent,
  AgentRevision,
  AuditEvent,
  AuthorizationDecision,
  AuthorizationRequest,
  ComputeDriver,
  PluginDeploymentWarning,
  PluginDriver,
  ComputeReadiness,
  RepoDriver,
  RepositoryCredentialMaterialRef,
  ComputeRevisionContext,
  ConfigurationDriver,
  Driver,
  IAMDriver,
  Installation,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  ProviderDefinition,
  SandboxDriver,
  SecretBindings,
  SecretDriver,
  ResolvedHarnessAuth,
  RuntimeFailureEvidence,
  SecretEnvironmentProjection,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import {
  NativeIAMDriver,
  validatePersistedNativeIAMState,
  type NativeIAMState,
} from "@openclaw-enterprise/iam";
import {
  PostgresPlatformState,
  PostgresWorkQueue,
  OpenClawController,
  WorkClaimLostError,
  isRepositoryCleanupWork,
  isRepositoryRuntimeRetirementWork,
  provisioningEffectReceipt as provisioningEffectReceiptForRecord,
  provisioningPendingEffect,
  type ClaimedWork,
  type PlatformUnitOfWork,
  type PostgresPool,
  type PostgresQueryClient,
  type PostgresWorkQueueOptions,
  validateRuntimeFailureEvidence,
} from "@openclaw-enterprise/occ";
import {
  providerDefinitionMap,
  validateProviderDefinitions,
  validateServiceAccountProviderBinding,
} from "@openclaw-enterprise/occ";
import type { InstallationRuntimeDrivers } from "./composition/installation-config.ts";
import { resolveApprovedHarness } from "./composition/production-harness.ts";
import { withComputeAbortSignal } from "./drivers/compute/operation-context.ts";
import type { OccMetrics, WorkKind, WorkOutcome } from "./metrics/index.ts";
import {
  RepositoryCredentialAuthorityError,
  RepositoryCredentialLifecycle,
} from "./worker/repository-credentials.ts";

export interface ControllerWorkerOptions {
  readonly metrics?: OccMetrics;
  readonly pool: PostgresPool & PostgresQueryClient;
  readonly mode?: "development" | "production";
  readonly drivers?: InstallationRuntimeDrivers;
  readonly computeDriver?: ComputeDriver;
  readonly sandboxDriver?: SandboxDriver;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
  readonly convergenceTimeoutMs?: number;
  readonly emit?: (event: Readonly<Record<string, unknown>>) => void;
  readonly onHealthy?: () => Promise<void>;
}

type Observation = NamespaceEnsureResult | NamespaceDeleteResult;
type Outcome = "success" | "pending" | "retry" | "permanent";

interface DispatchResult {
  readonly outcome: Outcome;
  readonly code: string;
  readonly observation?: Observation;
  readonly decision?: AuthorizationDecision;
  readonly authorization?: AuthorizationRequest;
}

interface RevisionDispatchResult extends DispatchResult {
  readonly data?: Readonly<Record<string, unknown>>;
  readonly resultData?: Readonly<Record<string, unknown>>;
  readonly revision?: Readonly<AgentRevision>;
  readonly previous?: Readonly<AgentRevision>;
  readonly supersededBy?: Readonly<AgentRevision>;
  readonly expectedActiveRevisionId?: string;
  readonly context?: ComputeRevisionContext;
}

interface AgentStopDispatchResult extends DispatchResult {
  readonly agent?: Readonly<Agent>;
  readonly revision?: Readonly<AgentRevision>;
}

interface AgentDeletionDispatchResult extends DispatchResult {
  readonly namespace?: Readonly<Namespace>;
  readonly agent?: Readonly<Agent>;
  readonly revisions?: readonly Readonly<AgentRevision>[];
}

function positiveInteger(value: number, name: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function workOperation(claim: ClaimedWork): string {
  if (claim.revisionId !== undefined) {
    return "agent_revision.reconcile";
  }
  if (claim.agentTarget === "stopped") {
    return "agent.stop";
  }
  if (claim.agentTarget === "deleted") {
    return "agent.delete";
  }
  if (claim.namespaceTarget === "deleted") {
    return "namespace.delete";
  }
  if (claim.namespaceTarget === "ready") {
    return "namespace.ensure";
  }
  return "work.reconcile";
}

function workLogFields(claim: ClaimedWork): {
  readonly workId: string;
  readonly attempt: number;
  readonly operation: string;
} {
  return {
    workId: claim.idempotencyKey,
    attempt: claim.attemptCount,
    operation: workOperation(claim),
  };
}

function validDriver(driver: ComputeDriver): boolean {
  return (
    typeof driver.id === "string" &&
    driver.id.trim().length > 0 &&
    driver.capability === "compute" &&
    typeof driver.implementation === "string" &&
    driver.implementation.trim().length > 0 &&
    typeof driver.ensureNamespace === "function" &&
    typeof driver.deleteNamespace === "function" &&
    typeof driver.prepareRevision === "function" &&
    typeof driver.stopRevision === "function" &&
    typeof driver.retireRevision === "function" &&
    (driver.deleteAgentRuntimeCredentials === undefined ||
      typeof driver.deleteAgentRuntimeCredentials === "function")
  );
}

function validSandboxDriver(driver: SandboxDriver): boolean {
  return (
    typeof driver.id === "string" &&
    driver.id.trim().length > 0 &&
    driver.capability === "sandbox" &&
    typeof driver.implementation === "string" &&
    driver.implementation.trim().length > 0 &&
    Array.isArray(driver.facets) &&
    driver.facets.length > 0 &&
    driver.facets.every(isSandboxFacet) &&
    (driver.ensureNamespace === undefined || typeof driver.ensureNamespace === "function") &&
    (driver.provisionHarness === undefined || typeof driver.provisionHarness === "function") &&
    typeof driver.cleanup === "function"
  );
}

function validSecretDriver(driver: SecretDriver): boolean {
  return (
    typeof driver.id === "string" &&
    driver.id.trim().length > 0 &&
    driver.capability === "secret" &&
    typeof driver.implementation === "string" &&
    driver.implementation.trim().length > 0 &&
    typeof driver.create === "function" &&
    typeof driver.update === "function" &&
    typeof driver.delete === "function" &&
    typeof driver.resolve === "function"
  );
}

function validLifecycleHooks(driver: Driver): boolean {
  const hooks = driver.computeLifecycleHooks;
  if (hooks === undefined) {
    return true;
  }
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return false;
  }
  const phases = new Set([
    "afterNamespacePrepared",
    "beforeWorkloadStart",
    "beforeWorkloadStop",
    "beforeNamespaceDelete",
  ]);
  const candidate = hooks as unknown as Record<string, unknown>;
  return (
    Object.keys(candidate).length > 0 &&
    Object.entries(candidate).every(
      ([phase, callback]) => phases.has(phase) && typeof callback === "function",
    )
  );
}

function validObservation(value: unknown, namespaceId: string, target: "ready" | "deleted") {
  if (typeof value !== "object" || value === null || Object.hasOwn(value, "installationId")) {
    return false;
  }
  const observation = value as Partial<NamespaceEnsureResult & NamespaceDeleteResult>;
  if (
    observation.namespaceId !== namespaceId ||
    (observation.failure !== undefined &&
      observation.failure !== "retryable" &&
      observation.failure !== "permanent")
  ) {
    return false;
  }
  return target === "ready"
    ? typeof observation.namespaceReady === "boolean"
    : typeof observation.namespaceDeleted === "boolean";
}

function validRevisionObservation(value: unknown, revision: Readonly<AgentRevision>): boolean {
  if (typeof value !== "object" || value === null || Object.hasOwn(value, "installationId")) {
    return false;
  }
  const observation = value as Record<string, unknown>;
  if (
    observation.warnings !== undefined &&
    computePluginWarnings(observation.warnings, revision) === undefined
  ) {
    return false;
  }
  return (
    observation.namespaceId === revision.namespaceId &&
    observation.agentId === revision.agentId &&
    observation.revisionId === revision.id &&
    typeof observation.ready === "boolean"
  );
}

function computePluginWarnings(
  warnings: unknown,
  revision: Readonly<AgentRevision>,
): readonly PluginDeploymentWarning[] | undefined {
  if (warnings === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(warnings)) {
    return undefined;
  }
  const admitted = revision.plugins?.plugins;
  if (admitted === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const normalized: PluginDeploymentWarning[] = [];
  for (const warning of warnings) {
    if (typeof warning !== "object" || warning === null || Array.isArray(warning)) {
      return undefined;
    }
    const candidate = warning as Record<string, unknown>;
    const code = candidate.code;
    const pluginId = candidate.pluginId;
    if (
      Object.keys(candidate).length !== 2 ||
      (code !== "PLUGIN_INSTALL_FAILED" && code !== "PLUGIN_AUTH_REQUIRED") ||
      typeof pluginId !== "string" ||
      !Object.hasOwn(admitted, pluginId)
    ) {
      return undefined;
    }
    if (seen.has(pluginId)) {
      return undefined;
    }
    seen.add(pluginId);
    normalized.push({ code, pluginId });
  }
  return Object.freeze(normalized);
}

function pluginWarningsResultData(
  warnings: readonly PluginDeploymentWarning[],
): Readonly<Record<string, unknown>> | undefined {
  if (warnings.length === 0) {
    return undefined;
  }
  return Object.freeze({ warnings });
}

function safeRuntimeFailureEvidence(value: unknown): RuntimeFailureEvidence | undefined {
  try {
    return validateRuntimeFailureEvidence(value);
  } catch {
    return undefined;
  }
}

function runtimeFailureFromObservation(observation: unknown): RuntimeFailureEvidence | undefined {
  if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
    return undefined;
  }
  return safeRuntimeFailureEvidence(
    (observation as { readonly runtimeFailure?: unknown }).runtimeFailure,
  );
}

function convergenceDeadlineResultData(
  timeoutMs: number,
  runtimeFailure: RuntimeFailureEvidence | undefined,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    timeoutMs,
    ...(runtimeFailure === undefined ? {} : { runtimeFailure }),
  });
}

function revisionSecretBindings(
  revision: Readonly<AgentRevision>,
): { readonly bindings: SecretBindings } | { readonly result: RevisionDispatchResult } {
  try {
    return { bindings: normalizeSecretBindings(revision.secretBindings) };
  } catch {
    return { result: { outcome: "permanent", code: "INVALID_SECRET_BINDINGS" } };
  }
}

function uniqueSecretRefs(bindings: SecretBindings): SecretReference[] {
  const refs = new Map<string, SecretReference>();
  for (const { source } of Object.values(bindings)) {
    refs.set(`${source.namespaceId}\u0000${source.id}`, source);
  }
  return [...refs.values()];
}

export class ControllerWorker {
  private readonly metrics: OccMetrics | undefined;
  private passOutcome: WorkOutcome = "error";
  private readonly state: PostgresPlatformState;
  private readonly queue: PostgresWorkQueue;
  private readonly compute: ComputeDriver;
  private readonly configuration: ConfigurationDriver | undefined;
  private readonly queueOptions: PostgresWorkQueueOptions;
  private readonly iamDriverId: string;
  private readonly iam: IAMDriver;
  private readonly secretDriverId: string | undefined;
  private readonly configuredServiceAccountDriverId: string | undefined;
  private readonly secretDriver: SecretDriver | undefined;
  private provisioningController: OpenClawController | undefined;
  private readonly sandbox: SandboxDriver | undefined;
  private readonly providers: readonly ProviderDefinition[];
  private readonly providerMap: ReadonlyMap<string, ProviderDefinition>;
  private readonly requireComputePreflight: boolean;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly convergenceTimeoutMs: number;
  private readonly maintenanceIntervalMs: number | undefined;
  private readonly repoDriver: RepoDriver | undefined;
  private readonly pluginDriver: PluginDriver | undefined;
  private readonly repositoryCredentials: RepositoryCredentialLifecycle;
  private readonly mode: "development" | "production";
  private readonly emit: (event: Readonly<Record<string, unknown>>) => void;
  private readonly onHealthy: (() => Promise<void>) | undefined;
  private readonly abort = new AbortController();
  private installation: Readonly<Installation> | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private lastHealthAt = 0;
  private pendingHealth: Promise<void> | undefined;

  constructor(options: ControllerWorkerOptions) {
    this.metrics = options.metrics;
    this.mode = options.mode ?? "development";
    if (this.mode !== "development" && this.mode !== "production") {
      throw new Error("The controller worker mode must be development or production.");
    }
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 250, "Worker poll interval");
    this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? 5_000, "Worker claim lease");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 5, "Maximum worker attempts");
    this.convergenceTimeoutMs = positiveInteger(
      options.convergenceTimeoutMs ?? 900_000,
      "Worker convergence timeout",
    );
    const drivers = options.drivers;
    this.configuredServiceAccountDriverId = drivers?.installation.drivers.service_account?.id;
    if (this.mode === "production" && drivers === undefined) {
      throw new Error("Production controller workers require Installation startup configuration.");
    }
    this.queueOptions = {
      leaseDurationMs: this.leaseDurationMs,
      maxAttempts: this.maxAttempts,
    };
    this.state = new PostgresPlatformState(options.pool, { workQueue: this.queueOptions });
    this.queue = new PostgresWorkQueue(options.pool, this.queueOptions);
    this.providers = validateProviderDefinitions(drivers?.installation.provider ?? []);
    this.providerMap = providerDefinitionMap(this.providers);
    this.iamDriverId = drivers?.installation.drivers.iam.id ?? "native-iam";
    this.iam =
      drivers === undefined
        ? new NativeIAMDriver(this.state, { id: "native-iam", implementation: "native" })
        : drivers.createIAMDriver(this.state);
    if (this.iam.capability !== "iam" || this.iam.id !== this.iamDriverId) {
      throw new Error("The selected IAM Driver is unavailable.");
    }
    const computeDriver = drivers === undefined ? options.computeDriver : drivers.computeDriver;
    if (computeDriver === undefined) {
      throw new Error("The selected Compute Driver must be explicitly provided.");
    }
    if (drivers === undefined && !validDriver(computeDriver)) {
      throw new Error("The selected Compute Driver is unavailable.");
    }
    if (
      computeDriver.activationOrder === "beforeCommit" &&
      typeof computeDriver.activateRevision !== "function"
    ) {
      throw new Error("A before-commit Compute Driver must implement activateRevision.");
    }
    this.compute = computeDriver;
    const selectedSecretDriver = drivers?.secretDriver;
    this.secretDriver = selectedSecretDriver;
    const selectedSecretConfiguration = drivers?.installation.drivers.secret;
    this.secretDriverId = selectedSecretDriver?.id ?? selectedSecretConfiguration?.id;
    if (selectedSecretConfiguration !== undefined) {
      if (selectedSecretDriver === undefined || !validSecretDriver(selectedSecretDriver)) {
        throw new Error("The selected Secret Driver is unavailable.");
      }
      if (selectedSecretDriver.id !== selectedSecretConfiguration.id) {
        throw new Error("The selected Secret Driver does not match Installation configuration.");
      }
    }
    this.maintenanceIntervalMs =
      computeDriver.maintenanceIntervalMs === undefined
        ? undefined
        : positiveInteger(computeDriver.maintenanceIntervalMs, "Compute maintenance interval");
    this.configuration = drivers?.configurationDriver;
    if (this.configuration !== undefined && !validLifecycleHooks(this.configuration)) {
      throw new Error("The selected Configuration Driver exposes invalid lifecycle hooks.");
    }
    this.sandbox = drivers?.sandboxDriver ?? options.sandboxDriver;
    if (
      (drivers?.installation.drivers.sandbox === undefined) !==
      (drivers?.sandboxDriver === undefined)
    ) {
      throw new Error("The selected Sandbox Driver requires shared startup configuration.");
    }
    if (this.sandbox !== undefined) {
      if (!validSandboxDriver(this.sandbox)) {
        throw new Error("The selected Sandbox Driver is unavailable.");
      }
      if (!validLifecycleHooks(this.sandbox)) {
        throw new Error("The selected Sandbox Driver exposes invalid lifecycle hooks.");
      }
    }
    this.requireComputePreflight =
      this.mode === "production" && drivers?.installation.drivers.compute.package === undefined;
    this.emit =
      options.emit ??
      ((event) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      });
    this.onHealthy = options.onHealthy;
    this.repoDriver = drivers?.repoDriver;
    this.pluginDriver = drivers?.pluginDriver;
    if (this.repoDriver !== undefined) {
      const driver = this.repoDriver;
      if (
        driver.capability !== "repo" ||
        typeof driver.resolve !== "function" ||
        typeof driver.open !== "function" ||
        typeof driver.status !== "function" ||
        typeof driver.close !== "function"
      ) {
        throw new Error("The selected repository credential Driver is unavailable.");
      }
      positiveInteger(driver.maintenanceIntervalMs, "Repository credential maintenance interval");
    }
    this.repositoryCredentials = new RepositoryCredentialLifecycle({
      state: this.state,
      queueOptions: this.queueOptions,
      driver: this.repoDriver,
      authorize: (claim, revision) => this.assertRepositoryAuthority(claim, revision),
      effect: (claim, operation) => this.withClaimHeartbeat(claim, operation),
    });
  }

  async start(): Promise<void> {
    if (this.loop !== undefined) {
      throw new Error("The controller worker is already running.");
    }
    const installation = await this.state.loadInstallation();
    if (installation === undefined) {
      throw new Error("The platform Installation must be bootstrapped before starting the worker.");
    }
    this.installation = installation;
    validatePersistedNativeIAMState(await this.loadIAMState());
    this.attachLifecycleDrivers(this.iam);
    const provisioning = new OpenClawController(installation, {
      state: this.state,
      providers: this.providers,
      recordOperations: true,
      ...(this.configuredServiceAccountDriverId === undefined
        ? {}
        : { configuredServiceAccountDriverId: this.configuredServiceAccountDriverId }),
    });
    for (const driver of [
      this.configuration,
      this.sandbox,
      this.iam,
      this.secretDriver,
      this.repoDriver,
      this.pluginDriver,
      this.compute,
    ] as const) {
      if (driver !== undefined) {
        provisioning.registerDriver(driver);
        provisioning.selectDriver(driver.capability, driver.id);
      }
    }
    this.provisioningController = provisioning;
    if (this.mode === "production") {
      const compute = this.compute;
      if (typeof compute.preflight === "function") {
        const result = await compute.preflight();
        if (result !== undefined) {
          for (const warning of result.warnings) {
            this.emit({
              event: "compute.preflight-warning",
              computeDriverId: compute.id,
              ...warning,
            });
          }
        }
      } else if (this.requireComputePreflight) {
        throw new Error("The selected bundled production Compute Driver requires preflight.");
      }
    }
    this.emit({
      event: "worker.started",
      computeDriverId: this.compute.id,
      ...(this.sandbox === undefined ? {} : { sandboxDriverId: this.sandbox.id }),
    });
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.abort.abort();
    await this.loop;
    await this.state.close();
    this.emit({ event: "worker.stopped" });
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.queue.recoverStale();
        const claim = await this.queue.claim();
        if (claim !== undefined) {
          const started = process.hrtime.bigint();
          this.passOutcome = "error";
          try {
            await this.process(claim);
          } catch (error) {
            this.passOutcome = error instanceof WorkClaimLostError ? "claim_lost" : "error";
            throw error;
          } finally {
            let kind: WorkKind = "namespace_ensure";
            if (claim.kind === "provisioning") {
              kind = "agent_provisioning";
            } else if (claim.agentTarget === "deleted") {
              kind = "agent_delete";
            } else if (claim.agentTarget === "stopped") {
              kind = "agent_stop";
            } else if (claim.revisionId !== undefined) {
              kind = "agent_revision";
            } else if (claim.namespaceTarget === "deleted") {
              kind = "namespace_delete";
            }
            this.metrics?.observeWork(
              kind,
              this.passOutcome,
              Number(process.hrtime.bigint() - started) / 1e9,
            );
          }
          await this.health(true);
          continue;
        }
        await this.health(false);
      } catch (error) {
        this.emit({
          event: "worker.error",
          code: error instanceof WorkClaimLostError ? "CLAIM_LOST" : "WORKER_UNAVAILABLE",
        });
      }
      try {
        await delay(this.pollIntervalMs, undefined, { signal: this.abort.signal });
      } catch (error) {
        if (!this.stopping) {
          throw error;
        }
      }
    }
  }

  private async health(force: boolean): Promise<void> {
    if (this.pendingHealth !== undefined) {
      return this.pendingHealth;
    }
    const now = Date.now();
    if (!force && now - this.lastHealthAt < Math.max(1_000, this.pollIntervalMs * 20)) {
      return;
    }
    this.lastHealthAt = now;
    this.pendingHealth = (async () => {
      const pending = await this.queue.pending();
      await this.onHealthy?.();
      this.emit({ event: "worker.health", status: "ready", pending });
    })()
      .catch(() => {
        this.emit({ event: "worker.error", code: "HEALTH_UNAVAILABLE" });
      })
      .finally(() => {
        this.pendingHealth = undefined;
      });
    return this.pendingHealth;
  }

  private async loadIAMState(): Promise<NativeIAMState> {
    if (this.installation === undefined) {
      throw new Error("The worker Installation is unavailable.");
    }
    return this.state.loadNativeIAMState();
  }

  private attachLifecycleDrivers(iam: IAMDriver): void {
    if (!validLifecycleHooks(iam)) {
      throw new Error("The selected IAM Driver exposes invalid lifecycle hooks.");
    }
    const lifecycleDrivers: Driver[] = [];
    if (this.configuration?.computeLifecycleHooks !== undefined) {
      lifecycleDrivers.push(this.configuration);
    }
    if (this.sandbox?.computeLifecycleHooks !== undefined) {
      lifecycleDrivers.push(this.sandbox);
    }
    if (iam.computeLifecycleHooks !== undefined) {
      lifecycleDrivers.push(iam);
    }
    if (lifecycleDrivers.length === 0) {
      return;
    }
    if (typeof this.compute.setLifecycleDrivers !== "function") {
      throw new Error("The selected Compute Driver cannot accept selected lifecycle Drivers.");
    }
    this.compute.setLifecycleDrivers(Object.freeze(lifecycleDrivers));
  }

  private async iamDecision(
    driver: IAMDriver,
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    const decision = await driver.authorize(request);
    const evidence = decision?.evidence;
    if (
      decision === null ||
      typeof decision !== "object" ||
      typeof decision.allowed !== "boolean" ||
      typeof decision.reason !== "string" ||
      decision.driverId !== driver.id ||
      evidence === null ||
      typeof evidence !== "object" ||
      (evidence.identityId !== undefined &&
        (typeof evidence.identityId !== "string" || evidence.identityId.trim().length === 0)) ||
      ![evidence.groupIds, evidence.bindingIds, evidence.roleIds, evidence.restrictionIds].every(
        (values) =>
          Array.isArray(values) &&
          values.every((value) => typeof value === "string" && value.trim().length > 0),
      )
    ) {
      throw new Error("The selected IAM Driver returned an invalid authorization decision.");
    }
    return decision;
  }

  private async stagedRevision(
    operation: "activateRevision" | "deactivateRevision",
    revision: Readonly<AgentRevision>,
    context?: ComputeRevisionContext,
  ): Promise<void> {
    const stage = this.compute[operation];
    if (typeof stage !== "function") {
      throw new Error(`The selected production Compute Driver requires ${operation}.`);
    }
    await stage.call(this.compute, revision, context);
  }

  private shouldActivateAfterCommit(compute: ComputeDriver): boolean {
    return (
      compute.activationOrder !== "beforeCommit" &&
      (this.mode === "production" || typeof compute.activateRevision === "function")
    );
  }

  private shouldActivatePublishedRevision(compute: ComputeDriver): boolean {
    return this.mode === "production" || typeof compute.activateRevision === "function";
  }

  private async authorize(
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
  ): Promise<DispatchResult | undefined> {
    const installation = this.installation;
    if (installation === undefined) {
      throw new Error("The worker Installation is unavailable.");
    }
    const state = await this.loadIAMState();
    const driver = this.iam;
    const exact: AuthorizationRequest = {
      principalId: claim.actorId,
      action: claim.namespaceTarget === "ready" ? "create" : "delete",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
    };
    const request: AuthorizationRequest =
      claim.namespaceTarget === "ready"
        ? {
            principalId: claim.actorId,
            action: "create",
            resource: { kind: "namespace", id: installation.id },
          }
        : exact;
    if (!state.identities.some((identity) => identity.id === claim.actorId)) {
      const decision = await this.iamDecision(driver, request);
      return { outcome: "permanent", code: "ACTOR_REVOKED", decision, authorization: request };
    }
    const decision = await this.iamDecision(driver, request);
    if (!decision.allowed) {
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        decision,
        authorization: request,
      };
    }
    if (claim.namespaceTarget === "ready") {
      if (namespace.existingNamespace !== undefined) {
        const adminRequest: AuthorizationRequest = {
          principalId: claim.actorId,
          action: "administer",
          resource: { kind: "installation", id: installation.id },
        };
        const adminDecision = await this.iamDecision(driver, adminRequest);
        if (!adminDecision.allowed) {
          return {
            outcome: "permanent",
            code: "AUTHORIZATION_DENIED",
            decision: adminDecision,
            authorization: adminRequest,
          };
        }
      }
      const exactDecision = await this.iamDecision(driver, exact);
      if (exactDecision.evidence.restrictionIds.length > 0) {
        return {
          outcome: "permanent",
          code: "AUTHORIZATION_DENIED",
          decision: exactDecision,
          authorization: exact,
        };
      }
    }
    return undefined;
  }

  private revisionMaintenanceInterval(revision: Readonly<AgentRevision>): number | undefined {
    const repositoryInterval =
      revision.repositoryCredentials === undefined
        ? undefined
        : this.repoDriver?.maintenanceIntervalMs;
    const intervals = [this.maintenanceIntervalMs, repositoryInterval].filter(
      (interval): interval is number => interval !== undefined,
    );
    return intervals.length === 0 ? undefined : Math.min(...intervals);
  }

  private async assertRepositoryAuthority(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    if (this.stopping || this.abort.signal.aborted) {
      throw new WorkClaimLostError();
    }
    const { namespace, agent, active } = await this.state.read(async (view) => {
      const namespace = await view.namespaces.findNamespace(revision.namespaceId);
      const agent = await view.agents.findAgent(revision.namespaceId, revision.agentId);
      const active =
        agent?.activeRevisionId === undefined
          ? undefined
          : await view.revisions.findRevision(
              revision.namespaceId,
              revision.agentId,
              agent.activeRevisionId,
            );
      return { namespace, agent, active };
    });
    if (
      namespace?.status !== "ready" ||
      agent?.desiredRuntimeState !== "running" ||
      agent.servicePrincipalId !== revision.servicePrincipalId
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_REVISION_STOPPED");
    }
    if (
      agent.activeRevisionId !== undefined &&
      agent.activeRevisionId !== revision.id &&
      (active === undefined || active.revision >= revision.revision)
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_REVISION_SUPERSEDED");
    }
    const denied = await this.authorizeRevision(claim, agent, revision);
    if (denied !== undefined) {
      throw new RepositoryCredentialAuthorityError(denied.code);
    }
    const provider = await this.resolveRevisionProvider(revision);
    if (provider !== undefined) {
      throw new RepositoryCredentialAuthorityError(provider.code);
    }
    if (typeof this.compute.validateRepositoryCredentials !== "function") {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_RUNTIME_UNSUPPORTED");
    }
    try {
      this.compute.validateRepositoryCredentials(revision.harness, revision.sandboxDriverId);
    } catch {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_RUNTIME_UNSUPPORTED");
    }
  }

  private async prepareRevision(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    context: ComputeRevisionContext,
  ): Promise<{ readonly observation: ComputeReadiness; readonly context: ComputeRevisionContext }> {
    let prepared = context;
    if (revision.repositoryCredentials !== undefined) {
      const repositoryCredentials = await this.repositoryCredentials.prepare(claim, revision);
      prepared = { ...context, repositoryCredentials };
      await this.assertRepositoryAuthority(claim, revision);
      this.repositoryCredentials.validate(revision);
    }
    let observation = await this.withClaimHeartbeat(claim, () =>
      this.compute.prepareRevision(revision, prepared),
    );
    if (!validRevisionObservation(observation, revision)) {
      throw new RepositoryCredentialAuthorityError("INVALID_DRIVER_OBSERVATION");
    }
    const missing = observation.repositoryCredentialMaterialMissing;
    if (missing !== undefined) {
      if (
        observation.ready ||
        !Array.isArray(missing) ||
        missing.length === 0 ||
        prepared.repositoryCredentials === undefined ||
        missing.some(
          (entry: RepositoryCredentialMaterialRef) =>
            entry === null ||
            typeof entry !== "object" ||
            typeof entry.repositoryRef !== "string" ||
            typeof entry.sessionId !== "string" ||
            Object.keys(entry).some((key) => key !== "repositoryRef" && key !== "sessionId"),
        )
      ) {
        throw new RepositoryCredentialAuthorityError("INVALID_DRIVER_OBSERVATION");
      }
      const repositoryCredentials = await this.repositoryCredentials.repair(
        claim,
        revision,
        prepared.repositoryCredentials,
        missing,
      );
      prepared = { ...context, repositoryCredentials };
      await this.assertRepositoryAuthority(claim, revision);
      this.repositoryCredentials.validate(revision);
      observation = await this.withClaimHeartbeat(claim, () =>
        this.compute.prepareRevision(revision, prepared),
      );
      if (
        !validRevisionObservation(observation, revision) ||
        observation.repositoryCredentialMaterialMissing !== undefined
      ) {
        throw new RepositoryCredentialAuthorityError("INVALID_DRIVER_OBSERVATION");
      }
    }
    return { observation, context: prepared };
  }

  private async processRepositoryCleanup(claim: ClaimedWork): Promise<void> {
    let complete = false;
    try {
      const revision = await this.state.read((view) =>
        view.revisions.findRevision(claim.namespaceId, claim.agentId!, claim.revisionId!),
      );
      if (revision !== undefined) {
        const retireRuntime = isRepositoryRuntimeRetirementWork(claim);
        complete = await this.repositoryCredentials.cleanup(claim, revision, { retireRuntime });
        if (retireRuntime) {
          if (
            revision.compute.id !== this.compute.id ||
            revision.compute.implementation !== this.compute.implementation
          ) {
            throw new Error("COMPUTE_DRIVER_MISMATCH");
          }
          const resources = await this.state.read(async (view) => ({
            namespace: await view.namespaces.findNamespace(revision.namespaceId),
            agent: await view.agents.findAgent(revision.namespaceId, revision.agentId),
          }));
          if (
            resources.namespace !== undefined &&
            resources.agent !== undefined &&
            this.compute.bindAgent !== undefined
          ) {
            await this.withClaimHeartbeat(claim, async () => {
              await this.compute.bindAgent!({
                namespace: resources.namespace!,
                agent: resources.agent!,
              });
            });
          }
          // Session service outages cannot delay exact workload/material retirement.
          await this.withClaimHeartbeat(claim, () => this.compute.stopRevision(revision));
        }
      }
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      complete = false;
    }
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      if (complete) {
        const attempts = await unit.repositorySessions.listRevisionAttempts({
          namespaceId: claim.namespaceId,
          agentId: claim.agentId!,
          revisionId: claim.revisionId!,
        });
        complete = !attempts.some(
          (attempt) => attempt.phase === "closing" || attempt.phase === "invalidated",
        );
      }
      if (complete) {
        await queue.complete(claim);
      } else {
        await queue.defer(claim, { code: "REPOSITORY_CLEANUP_PENDING" });
      }
    }, this.queueOptions);
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      outcome: complete ? "success" : "pending",
      code: complete ? "REPOSITORY_CLEANUP_COMPLETE" : "REPOSITORY_CLEANUP_PENDING",
    });
  }

  private async closeRevisionCredentials(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    if (revision.repositoryCredentials !== undefined) {
      // An unavailable service leaves durable cleanup work; workload shutdown continues.
      await this.repositoryCredentials.closeRevision(claim, revision);
    }
  }

  private async process(claim: ClaimedWork): Promise<void> {
    if (claim.kind === "provisioning") {
      await this.processAgentProvisioning(claim);
      return;
    }
    if (isRepositoryCleanupWork(claim)) {
      await this.processRepositoryCleanup(claim);
      return;
    }
    if (claim.revisionId !== undefined) {
      await this.processRevision(claim);
      return;
    }
    if (claim.agentTarget !== undefined) {
      if (claim.agentTarget === "deleted") {
        await this.processAgentDeletion(claim);
      } else {
        await this.processAgentStop(claim);
      }
      return;
    }
    if (claim.agentId !== undefined || claim.namespaceTarget === undefined) {
      await this.finalize(claim, undefined, { outcome: "permanent", code: "INVALID_TARGET" });
      return;
    }
    let namespace: Readonly<Namespace> | undefined;
    let result: DispatchResult;
    try {
      namespace = await this.state.read((view) => view.namespaces.findNamespace(claim.namespaceId));
      const expected = claim.namespaceTarget === "ready" ? "provisioning" : "deleting";
      if (namespace === undefined || namespace.status !== expected) {
        await this.finalize(claim, namespace, { outcome: "success", code: "SUPERSEDED_TARGET" });
        return;
      }
      const denied = await this.authorize(claim, namespace);
      if (denied !== undefined) {
        await this.finalize(claim, namespace, denied);
        return;
      }
      if ((await this.queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      result = await this.observe(claim, namespace);
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      result = { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.finalize(claim, namespace, result);
  }

  private async processAgentProvisioning(claim: ClaimedWork): Promise<void> {
    const controller = this.provisioningController;
    if (controller === undefined) {
      throw new Error("The provisioning controller is unavailable.");
    }
    const result = await controller.processAgentProvisioning(claim, resolveApprovedHarness, {
      runEffect: (operation) => this.withClaimHeartbeat(claim, operation),
    });
    this.passOutcome = result.outcome === "succeeded" ? "success" : result.outcome;
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      outcome: this.passOutcome,
      code: result.outcome === "succeeded" ? "PROVISIONING_HANDED_OFF" : result.code,
      ...(result.outcome === "succeeded" ? { revisionId: result.revisionId } : {}),
    });
  }

  private async processAgentStop(claim: ClaimedWork): Promise<void> {
    let result: AgentStopDispatchResult;
    try {
      if (
        claim.agentId === undefined ||
        claim.agentTarget !== "stopped" ||
        claim.namespaceTarget !== undefined
      ) {
        await this.finalizeAgentStop(claim, { outcome: "permanent", code: "INVALID_TARGET" });
        return;
      }
      const authorizedAgent = await this.state.read((view) =>
        view.agents.findAgent(claim.namespaceId, claim.agentId!),
      );
      if (authorizedAgent === undefined) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "INVALID_AGENT_OWNER",
        });
        return;
      }
      const denied = await this.authorizeAgentStop(claim, authorizedAgent);
      if (denied !== undefined) {
        await this.finalizeAgentStop(claim, { ...denied, agent: authorizedAgent });
        return;
      }
      // Admission may change desired state while IAM is consulted. Reload the exact
      // Agent immediately before any provider effect so a later deployment wins.
      const resources = await this.state.read(async (view) => {
        const agent = await view.agents.findAgent(claim.namespaceId, claim.agentId!);
        const namespace = await view.namespaces.findNamespace(claim.namespaceId);
        const revisions = await view.revisions.listRevisions(claim.namespaceId, claim.agentId!);
        return { namespace, agent, revisions };
      });
      const { namespace, agent, revisions } = resources;
      if (
        namespace === undefined ||
        agent === undefined ||
        agent.servicePrincipalId !== authorizedAgent.servicePrincipalId
      ) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "INVALID_AGENT_OWNER",
        });
        return;
      }
      if (agent.desiredRuntimeState !== "stopped") {
        await this.finalizeAgentStop(claim, {
          outcome: "success",
          code: "STOP_SUPERSEDED",
          agent,
        });
        return;
      }
      const active = revisions.find((revision) => revision.id === agent.activeRevisionId);
      if (agent.activeRevisionId !== undefined && active === undefined) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "INVALID_ACTIVE_REVISION",
          agent,
        });
        return;
      }
      if (active !== undefined && Date.parse(active.createdAt) > claim.createdAt.getTime()) {
        await this.finalizeAgentStop(claim, { outcome: "success", code: "STOP_SUPERSEDED", agent });
        return;
      }
      const ownedByCompute = (revision: Readonly<AgentRevision>) =>
        revision.compute.id === this.compute.id &&
        revision.compute.implementation === this.compute.implementation;
      if (active !== undefined && !ownedByCompute(active)) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "COMPUTE_DRIVER_MISMATCH",
          agent,
          revision: active,
        });
        return;
      }
      // A terminal candidate or a predecessor with failed retirement can still
      // own resources. Capture this Driver's history once; never include a later
      // admission, and stop the serving revision before any candidate cleanup.
      const cleanup = [
        ...(active === undefined ? [] : [active]),
        ...revisions.filter(
          (revision) =>
            revision.id !== active?.id &&
            ownedByCompute(revision) &&
            Date.parse(revision.createdAt) <= claim.createdAt.getTime(),
        ),
      ];
      if (
        cleanup.some(
          (revision) =>
            revision.agentId !== agent.id ||
            revision.namespaceId !== agent.namespaceId ||
            revision.servicePrincipalId !== agent.servicePrincipalId,
        )
      ) {
        await this.finalizeAgentStop(claim, {
          outcome: "permanent",
          code: "INVALID_REVISION_OWNER",
          agent,
        });
        return;
      }
      if (cleanup.length > 0 && this.compute.bindAgent !== undefined) {
        await this.withClaimHeartbeat(claim, async () => {
          await this.compute.bindAgent!({ namespace, agent });
        });
      }
      for (const revision of cleanup) {
        const current = await this.state.read((view) =>
          view.agents.findAgent(claim.namespaceId, claim.agentId!),
        );
        if (current === undefined || current.servicePrincipalId !== agent.servicePrincipalId) {
          await this.finalizeAgentStop(claim, {
            outcome: "permanent",
            code: "INVALID_AGENT_OWNER",
          });
          return;
        }
        if (current.desiredRuntimeState !== "stopped") {
          await this.finalizeAgentStop(claim, {
            outcome: "success",
            code: "STOP_SUPERSEDED",
            agent: current,
          });
          return;
        }
        await this.closeRevisionCredentials(claim, revision);
        const afterClose = await this.state.read((view) =>
          view.agents.findAgent(claim.namespaceId, claim.agentId!),
        );
        if (afterClose?.desiredRuntimeState !== "stopped") {
          await this.finalizeAgentStop(claim, {
            outcome: "success",
            code: "STOP_SUPERSEDED",
            ...(afterClose === undefined ? {} : { agent: afterClose }),
          });
          return;
        }
        await this.withClaimHeartbeat(claim, () => this.compute.stopRevision(revision));
      }
      result = {
        outcome: "success",
        code: active === undefined ? "AGENT_ALREADY_STOPPED" : "AGENT_STOPPED",
        agent,
        ...(active === undefined ? {} : { revision: active }),
      };
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      result = { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.finalizeAgentStop(claim, result);
  }

  private async processAgentDeletion(claim: ClaimedWork): Promise<void> {
    let result: AgentDeletionDispatchResult;
    try {
      if (
        claim.agentId === undefined ||
        claim.agentTarget !== "deleted" ||
        claim.namespaceTarget !== undefined
      ) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "INVALID_TARGET",
        });
        return;
      }
      const resources = await this.state.read(async (view) => {
        const namespace = await view.namespaces.findNamespace(claim.namespaceId);
        const agent = await view.agents.findAgent(claim.namespaceId, claim.agentId!);
        const revisions =
          agent === undefined
            ? []
            : await view.revisions.listRevisions(claim.namespaceId, claim.agentId!);
        const provisioning =
          agent === undefined
            ? undefined
            : await view.provisioning.findByAgent(claim.namespaceId, claim.agentId!);
        return { namespace, agent, revisions, provisioning };
      });
      const { namespace, agent, revisions, provisioning } = resources;
      if (namespace === undefined || agent === undefined) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "INVALID_AGENT_OWNER",
        });
        return;
      }
      if (agent.status !== "deleting" || agent.desiredRuntimeState !== "stopped") {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "INVALID_AGENT_STATE",
          namespace,
          agent,
          revisions,
        });
        return;
      }
      const denied = await this.authorizeAgentDeletion(claim, agent);
      if (denied !== undefined) {
        await this.finalizeAgentDeletion(claim, { ...denied, namespace, agent, revisions });
        return;
      }
      if (
        revisions.some(
          (revision) =>
            revision.namespaceId !== namespace.id ||
            revision.agentId !== agent.id ||
            revision.servicePrincipalId !== agent.servicePrincipalId,
        )
      ) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "INVALID_REVISION_OWNER",
          namespace,
          agent,
          revisions,
        });
        return;
      }
      if (
        revisions.some(
          (revision) =>
            revision.compute.id !== this.compute.id ||
            revision.compute.implementation !== this.compute.implementation,
        )
      ) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "COMPUTE_DRIVER_MISMATCH",
          namespace,
          agent,
          revisions,
        });
        return;
      }
      if (
        this.compute.provisionAgentRuntimeCredentials !== undefined &&
        this.compute.deleteAgentRuntimeCredentials === undefined
      ) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "permanent",
          code: "CREDENTIAL_DELETION_UNSUPPORTED",
          namespace,
          agent,
          revisions,
        });
        return;
      }
      const pendingProvisioningEffect =
        provisioning === undefined ? undefined : provisioningPendingEffect(provisioning);
      const settledProvisioningEffect =
        pendingProvisioningEffect === undefined
          ? undefined
          : provisioningEffectReceiptForRecord(provisioning!);
      if (
        provisioning?.progress.pendingEffect !== undefined &&
        (pendingProvisioningEffect === undefined ||
          !pendingProvisioningEffect.ownerPresent ||
          settledProvisioningEffect === undefined ||
          settledProvisioningEffect.kind !== pendingProvisioningEffect.kind ||
          settledProvisioningEffect.owner !== pendingProvisioningEffect.owner ||
          settledProvisioningEffect.targetId !== pendingProvisioningEffect.targetId)
      ) {
        await this.finalizeAgentDeletion(claim, {
          outcome: "pending",
          code: "PROVISIONING_EFFECT_PENDING",
          namespace,
          agent,
          revisions,
        });
        return;
      }
      if (revisions.length > 0 && this.compute.bindAgent !== undefined) {
        await this.withClaimHeartbeat(claim, async () => {
          await this.compute.bindAgent!({ namespace, agent });
        });
      }
      for (const revision of revisions) {
        await this.closeRevisionCredentials(claim, revision);
        await this.withClaimHeartbeat(claim, () => this.compute.retireRevision(revision));
      }
      if (this.compute.deleteAgentRuntimeCredentials !== undefined) {
        await this.withClaimHeartbeat(claim, () =>
          this.compute.deleteAgentRuntimeCredentials!({ namespace, agent }),
        );
      }
      result = {
        outcome: "success",
        code: "AGENT_DELETED",
        namespace,
        agent,
        revisions,
      };
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      result = { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.finalizeAgentDeletion(claim, result);
  }

  private async authorizeAgentDeletion(
    claim: ClaimedWork,
    agent: Readonly<Agent>,
  ): Promise<AgentDeletionDispatchResult | undefined> {
    const authorization: AuthorizationRequest = {
      principalId: claim.actorId,
      action: "delete",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    const state = await this.loadIAMState();
    const decision = await this.iamDecision(this.iam, authorization);
    if (!state.identities.some((identity) => identity.id === claim.actorId)) {
      return { outcome: "permanent", code: "ACTOR_REVOKED", authorization, decision };
    }
    if (!decision.allowed) {
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        authorization,
        decision,
      };
    }
    return undefined;
  }

  private async finalizeAgentDeletion(
    claim: ClaimedWork,
    result: AgentDeletionDispatchResult,
  ): Promise<void> {
    if (result.outcome === "success") {
      if (claim.agentId === undefined) {
        throw new Error("The worker Agent deletion context is unavailable.");
      }
      const completed = await this.state.transactWithQueue(async (_unit, queue) => {
        const completed = await queue.completeAgentDeletion(
          claim,
          claim.namespaceId,
          claim.agentId!,
        );
        if (completed === "cleanup-pending") {
          await queue.defer(claim, { code: "REPOSITORY_CLEANUP_PENDING" });
        }
        return completed;
      }, this.queueOptions);
      if (completed === "cleanup-pending") {
        this.passOutcome = "pending";
        this.emit({
          event: "worker.completed",
          ...workLogFields(claim),
          namespaceId: claim.namespaceId,
          agentId: claim.agentId,
          outcome: "pending",
          code: "REPOSITORY_CLEANUP_PENDING",
        });
        return;
      }
    } else {
      await this.state.transactWithQueue(async (unit, queue) => {
        if ((await queue.heartbeat(claim)) === undefined) {
          throw new WorkClaimLostError();
        }
        const terminalFailure =
          result.outcome === "permanent" ||
          (result.outcome === "retry" && claim.attemptCount >= this.maxAttempts);
        if (result.decision !== undefined) {
          await this.appendAgentDeletionDenial(unit, claim, result);
        } else if (terminalFailure) {
          await this.appendAgentDeletionOutcome(unit, claim, result);
        }
        if (terminalFailure) {
          await queue.fail(claim, { code: result.code });
        } else {
          await queue.retry(claim, { code: result.code });
        }
      }, this.queueOptions);
    }
    this.passOutcome =
      result.outcome === "retry" && claim.attemptCount >= this.maxAttempts
        ? "permanent"
        : result.outcome;
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      result: result.outcome,
      outcome: result.outcome,
      code: result.code,
    });
  }

  private async appendAgentDeletionOutcome(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: AgentDeletionDispatchResult,
  ): Promise<void> {
    if (this.installation === undefined || claim.agentId === undefined) {
      throw new Error("The worker Agent deletion audit context is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.delete",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      outcome: "failure",
      details: {
        computeDriverId: this.compute.id,
        reasonCode: result.code,
      },
    });
  }

  private async appendAgentDeletionDenial(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: AgentDeletionDispatchResult,
  ): Promise<void> {
    if (this.installation === undefined || claim.agentId === undefined) {
      throw new Error("The worker Agent deletion authorization context is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.delete",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      ...(result.decision === undefined ? {} : { decisionReason: result.decision.reason }),
      reasonCode: result.code,
      outcome: "denied",
    });
  }

  private async authorizeAgentStop(
    claim: ClaimedWork,
    agent: Readonly<Agent>,
  ): Promise<AgentStopDispatchResult | undefined> {
    const authorization: AuthorizationRequest = {
      principalId: claim.actorId,
      action: "operate",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    const state = await this.loadIAMState();
    const decision = await this.iamDecision(this.iam, authorization);
    if (!state.identities.some((identity) => identity.id === claim.actorId)) {
      return { outcome: "permanent", code: "ACTOR_REVOKED", authorization, decision };
    }
    if (!decision.allowed) {
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        authorization,
        decision,
      };
    }
    return undefined;
  }

  private async finalizeAgentStop(
    claim: ClaimedWork,
    result: AgentStopDispatchResult,
  ): Promise<void> {
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      if (result.outcome === "success" && result.agent !== undefined) {
        const agent = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
        if (agent === undefined || agent.servicePrincipalId !== result.agent.servicePrincipalId) {
          result = { outcome: "permanent", code: "INVALID_AGENT_OWNER" };
        } else if (agent.desiredRuntimeState !== "stopped") {
          // A later deployment may retain the old active pointer while preparing.
          // Never clear it merely because the final exact stop call completed.
          result = { ...result, code: "STOP_SUPERSEDED" };
        } else if (result.revision !== undefined && agent.activeRevisionId === result.revision.id) {
          await unit.agents.compareAndClearActiveRevision(
            claim.namespaceId,
            agent.id,
            result.revision.id,
          );
        }
      }
      const terminalFailure =
        result.outcome === "permanent" ||
        (result.outcome === "retry" && claim.attemptCount >= this.maxAttempts);
      if (result.decision !== undefined) {
        await this.appendAgentStopDenial(unit, claim, result);
      } else if (result.outcome === "success" || terminalFailure) {
        await this.appendAgentStopOutcome(unit, claim, result);
      }

      if (result.outcome === "success") {
        await queue.complete(claim);
      } else if (terminalFailure) {
        await queue.fail(claim, { code: result.code });
      } else {
        await queue.retry(claim, { code: result.code });
      }
    }, this.queueOptions);
    this.passOutcome =
      result.outcome === "retry" && claim.attemptCount >= this.maxAttempts
        ? "permanent"
        : result.outcome;
    if (result.outcome === "success" && result.code !== "STOP_SUPERSEDED") {
      this.metrics?.observeAgentOperation(
        "stop",
        Math.max(0, Date.now() - claim.createdAt.getTime()) / 1000,
      );
    }
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: result.revision?.id,
      result: result.outcome,
      outcome: result.outcome,
      code: result.code,
    });
  }

  private async appendAgentStopOutcome(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: AgentStopDispatchResult,
  ): Promise<void> {
    if (this.installation === undefined || claim.agentId === undefined) {
      throw new Error("The worker Agent stop audit context is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.stop",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      outcome: result.outcome === "success" ? "success" : "failure",
      details: {
        computeDriverId: this.compute.id,
        reasonCode: result.code,
        ...(result.revision === undefined ? {} : { revisionId: result.revision.id }),
      },
    });
  }

  private async appendAgentStopDenial(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: AgentStopDispatchResult,
  ): Promise<void> {
    if (this.installation === undefined || claim.agentId === undefined) {
      throw new Error("The worker Agent stop authorization context is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.stop",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      ...(result.decision === undefined ? {} : { decisionReason: result.decision.reason }),
      reasonCode: result.code,
      outcome: "denied",
    });
  }

  private async processRevision(claim: ClaimedWork): Promise<void> {
    let result: RevisionDispatchResult;
    try {
      if (
        claim.agentId === undefined ||
        claim.revisionId === undefined ||
        claim.namespaceTarget !== undefined
      ) {
        await this.finalizeRevision(claim, { outcome: "permanent", code: "INVALID_TARGET" });
        return;
      }
      const resources = await this.state.read(async (view) => {
        const namespace = await view.namespaces.findNamespace(claim.namespaceId);
        const agent = await view.agents.findAgent(claim.namespaceId, claim.agentId!);
        const revision = await view.revisions.findRevision(
          claim.namespaceId,
          claim.agentId!,
          claim.revisionId!,
        );
        const previous =
          agent?.activeRevisionId === undefined
            ? undefined
            : await view.revisions.findRevision(
                claim.namespaceId,
                claim.agentId!,
                agent.activeRevisionId,
              );
        return { namespace, agent, revision, previous };
      });
      const { namespace, agent, revision, previous } = resources;
      if (namespace === undefined || agent === undefined || revision === undefined) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "INVALID_REVISION_OWNER",
        });
        return;
      }
      if (namespace.status !== "ready") {
        await this.finalizeRevision(claim, { outcome: "permanent", code: "NAMESPACE_NOT_READY" });
        return;
      }
      if (
        revision.namespaceId !== namespace.id ||
        revision.agentId !== agent.id ||
        revision.servicePrincipalId !== agent.servicePrincipalId
      ) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "INVALID_ADMITTED_REVISION",
        });
        return;
      }
      const approvedHarness = resolveApprovedHarness(revision.harness.id, revision.harness.mode);
      if (approvedHarness === undefined || revision.harness.version !== approvedHarness.version) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "HARNESS_DESCRIPTOR_MISMATCH",
        });
        return;
      }
      if (
        revision.compute.id !== this.compute.id ||
        revision.compute.implementation !== this.compute.implementation
      ) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "COMPUTE_DRIVER_MISMATCH",
        });
        return;
      }
      if (claim.idempotencyKey.startsWith(`agent_revision:${revision.id}:maintenance:`)) {
        const original = await this.queue.findWork(`agent_revision:${revision.id}:reconcile`);
        if (original === undefined) {
          await this.finalizeRevision(claim, { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" });
          return;
        }
        if (
          original.state === "failed_permanent" ||
          original.reasonCode === "REVISION_SUPERSEDED"
        ) {
          // Maintenance must never prepare or reactivate a terminally failed deployment.
          await this.finalizeRevision(claim, { outcome: "permanent", code: "REVISION_SUPERSEDED" });
          return;
        }
      }
      if (agent.activeRevisionId !== undefined && previous === undefined) {
        await this.finalizeRevision(claim, {
          outcome: "permanent",
          code: "INVALID_ACTIVE_REVISION",
        });
        return;
      }
      const denied = await this.authorizeRevision(claim, agent, revision);
      if (denied !== undefined) {
        await this.finalizeRevision(claim, denied);
        return;
      }
      const provider = await this.resolveRevisionProvider(revision);
      if (provider !== undefined) {
        await this.finalizeRevision(claim, provider);
        return;
      }
      if (agent.desiredRuntimeState === "stopped") {
        if (claim.idempotencyKey.startsWith(`agent_revision:${revision.id}:maintenance:`)) {
          if (revision.repositoryCredentials !== undefined) {
            await this.closeRevisionCredentials(claim, revision);
            if (this.compute.bindAgent !== undefined) {
              await this.withClaimHeartbeat(claim, async () => {
                await this.compute.bindAgent!({ namespace, agent });
              });
            }
            await this.withClaimHeartbeat(claim, () => this.compute.stopRevision(revision));
          }
          await this.completeStoppedRevisionWork(
            claim,
            revision,
            "REVISION_MAINTENANCE_SUPERSEDED",
          );
          return;
        }
        if (this.compute.bindAgent !== undefined) {
          await this.withClaimHeartbeat(claim, async () => {
            await this.compute.bindAgent!({ namespace, agent });
          });
        }
        await this.closeRevisionCredentials(claim, revision);
        await this.withClaimHeartbeat(claim, () => this.compute.stopRevision(revision));
        // Once this reconciliation has published its candidate, it owns retiring
        // every predecessor even if stop admission clears the active pointer before
        // a recovery attempt. A different active revision means this candidate was
        // never published, so its authorized stop work remains solely responsible.
        if (agent.activeRevisionId === revision.id || agent.activeRevisionId === undefined) {
          await this.retireEarlierRevisions(claim, revision);
        }
        await this.completeStoppedRevisionWork(claim, revision, "REVISION_STOPPED");
        return;
      }
      if (revision.repositoryCredentials !== undefined) {
        await this.assertRepositoryAuthority(claim, revision);
        this.repositoryCredentials.validate(revision);
      }
      const secretContext = await this.resolveRevisionSecretContext(revision);
      if ("result" in secretContext) {
        if (agent.activeRevisionId === revision.id) {
          await this.finalizeActiveRevision(claim, revision, secretContext.result.code);
        } else {
          await this.finalizeRevision(claim, secretContext.result);
        }
        return;
      }
      if (this.compute.bindAgent !== undefined) {
        try {
          await this.withClaimHeartbeat(claim, async () => {
            await this.compute.bindAgent!({ namespace, agent });
          });
        } catch (error) {
          if (error instanceof WorkClaimLostError || agent.activeRevisionId !== revision.id) {
            throw error;
          }
          await this.finalizeActiveRevision(claim, revision, "COMPUTE_BINDING_INCOMPLETE");
          return;
        }
      }
      if (agent.activeRevisionId === revision.id) {
        let resultData: Readonly<Record<string, unknown>> | undefined;
        try {
          const compute = this.compute;
          // Publishing the active pointer precedes activation. Reobserve even when
          // periodic maintenance is disabled so recovery verifies current readiness.
          const prepared = await this.prepareRevision(claim, revision, secretContext.context);
          const observation = prepared.observation;
          const context = prepared.context;
          if (!validRevisionObservation(observation, revision)) {
            await this.finalizeRevision(claim, {
              outcome: "permanent",
              code: "INVALID_DRIVER_OBSERVATION",
            });
            return;
          }
          resultData = pluginWarningsResultData(
            computePluginWarnings(observation.warnings, revision) ?? Object.freeze([]),
          );
          if (!observation.ready) {
            await this.finalizeActiveRevision(
              claim,
              revision,
              "REVISION_INCOMPLETE",
              runtimeFailureFromObservation(observation),
            );
            return;
          }
          if (this.shouldActivatePublishedRevision(compute)) {
            if (revision.repositoryCredentials !== undefined) {
              await this.assertRepositoryAuthority(claim, revision);
              this.repositoryCredentials.validate(revision);
            }
            await this.withClaimHeartbeat(claim, () =>
              this.stagedRevision("activateRevision", revision, context),
            );
          }
          await this.retireEarlierRevisions(claim, revision);
        } catch (error) {
          if (
            error instanceof WorkClaimLostError ||
            error instanceof RepositoryCredentialAuthorityError
          ) {
            throw error;
          }
          await this.finalizeActiveRevision(claim, revision, "REVISION_FINALIZATION_INCOMPLETE");
          return;
        }
        await this.completeActivatedRevision(claim, {
          outcome: "success",
          code: "REVISION_ALREADY_ACTIVE",
          revision,
          ...(resultData === undefined ? {} : { resultData }),
        });
        return;
      }
      if (previous !== undefined && previous.revision >= revision.revision) {
        await this.finalizeRevision(claim, {
          outcome: "success",
          code: "REVISION_SUPERSEDED",
          supersededBy: previous,
        });
        return;
      }
      if ((await this.queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      result = await this.observeRevision(
        claim,
        revision,
        previous,
        agent.activeRevisionId,
        secretContext.context,
      );
    } catch (error) {
      if (error instanceof WorkClaimLostError) {
        throw error;
      }
      result =
        error instanceof RepositoryCredentialAuthorityError
          ? { outcome: "permanent", code: error.code }
          : { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.finalizeRevision(claim, result);
  }

  private async authorizeRevision(
    claim: ClaimedWork,
    agent: Readonly<Agent>,
    revision: Readonly<AgentRevision>,
  ): Promise<RevisionDispatchResult | undefined> {
    const state = await this.loadIAMState();
    const driver = this.iam;
    const authorization: AuthorizationRequest = {
      principalId: claim.actorId,
      action: "deploy",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    const actor = state.identities.find((identity) => identity.id === claim.actorId);
    if (actor === undefined) {
      const decision = await this.iamDecision(driver, authorization);
      return { outcome: "permanent", code: "ACTOR_REVOKED", authorization, decision };
    }
    const identity = state.identities.find(
      (candidate) =>
        candidate.kind === "service_principal" &&
        candidate.id === revision.servicePrincipalId &&
        candidate.namespaceId === agent.namespaceId &&
        candidate.agentId === agent.id,
    );
    if (identity === undefined) {
      return { outcome: "permanent", code: "INVALID_AGENT_PRINCIPAL" };
    }
    const decision = await this.iamDecision(driver, authorization);
    if (!decision.allowed) {
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        authorization,
        decision,
      };
    }

    const configurationAuthorization: AuthorizationRequest = {
      principalId: claim.actorId,
      action: "read",
      resource: {
        kind: "configuration",
        id: revision.configurationId,
        namespaceId: revision.namespaceId,
      },
    };
    const configurationDecision = await this.iamDecision(driver, configurationAuthorization);
    if (!configurationDecision.allowed) {
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        authorization: configurationAuthorization,
        decision: configurationDecision,
      };
    }

    if (revision.harnessAuth === undefined || revision.harnessAuth === null) {
      return { outcome: "permanent", code: "HARNESS_AUTH_REQUIRED" };
    }
    const secretBindings = revisionSecretBindings(revision);
    if ("result" in secretBindings) {
      return secretBindings.result;
    }
    const refs = uniqueSecretRefs(secretBindings.bindings);
    const auth = revision.harnessAuth;
    if (auth.method === "api_key" || auth.method === "codex_pat") {
      if (auth.source?.kind !== "secret" || auth.source.namespaceId !== revision.namespaceId) {
        return { outcome: "permanent", code: "INVALID_HARNESS_AUTH" };
      }
      if (
        !refs.some(
          (ref) => ref.id === auth.source.id && ref.namespaceId === auth.source.namespaceId,
        )
      ) {
        refs.push(auth.source);
      }
    } else if (auth.method !== "chatgpt_service_account" && auth.method !== "runtime") {
      return { outcome: "permanent", code: "INVALID_HARNESS_AUTH" };
    }
    for (const ref of refs) {
      for (const principalId of [claim.actorId, revision.servicePrincipalId]) {
        const secretAuthorization: AuthorizationRequest = {
          principalId,
          action: "operate",
          resource: ref,
        };
        const secretDecision = await this.iamDecision(driver, secretAuthorization);
        if (!secretDecision.allowed) {
          return {
            outcome: "permanent",
            code: "AUTHORIZATION_DENIED",
            authorization: secretAuthorization,
            decision: secretDecision,
          };
        }
      }
    }

    if (auth.method === "chatgpt_service_account") {
      const accountAuthorization: AuthorizationRequest = {
        principalId: claim.actorId,
        action: "read",
        resource: {
          kind: "service_account",
          id: auth.serviceAccountId,
          namespaceId: revision.namespaceId,
        },
      };
      const accountDecision = await this.iamDecision(driver, accountAuthorization);
      if (!accountDecision.allowed) {
        return {
          outcome: "permanent",
          code: "AUTHORIZATION_DENIED",
          authorization: accountAuthorization,
          decision: accountDecision,
        };
      }
    }
    return undefined;
  }

  private async resolveRevisionProvider(
    revision: Readonly<AgentRevision>,
  ): Promise<RevisionDispatchResult | undefined> {
    if (
      revision.providerId !== null &&
      this.providerMap.get(revision.providerId)?.type !== "chatgpt"
    ) {
      return { outcome: "permanent", code: "PROVIDER_UNAVAILABLE" };
    }
    const auth = revision.harnessAuth;
    if (auth.method !== "chatgpt_service_account") {
      return undefined;
    }
    const { account, binding } = await this.state.read(async (view) => ({
      account: await view.serviceAccounts.findServiceAccount(
        revision.namespaceId,
        auth.serviceAccountId,
      ),
      binding: await view.serviceAccounts.findServiceAccountProviderBinding(
        revision.namespaceId,
        auth.serviceAccountId,
      ),
    }));
    if (
      account === undefined ||
      account.namespaceId !== revision.namespaceId ||
      account.credential?.kind !== "access_token" ||
      auth.credential?.kind !== "access_token" ||
      account.credential.secretRef.name !== auth.credential.secretRef.name ||
      account.credential.secretRef.key !== auth.credential.secretRef.key
    ) {
      return { outcome: "permanent", code: "HARNESS_AUTH_SOURCE_CHANGED" };
    }
    try {
      validateServiceAccountProviderBinding(this.providerMap, revision.providerId, binding);
      const admitted = auth.providerBinding;
      if (
        admitted === undefined ||
        binding === undefined ||
        binding.providerId !== admitted.providerId ||
        binding.driverId !== admitted.driverId ||
        binding.workspaceId !== admitted.workspaceId ||
        binding.credentialIssued !== admitted.credentialIssued
      ) {
        return { outcome: "permanent", code: "SERVICE_ACCOUNT_PROVIDER_MISMATCH" };
      }
      return undefined;
    } catch {
      return { outcome: "permanent", code: "SERVICE_ACCOUNT_PROVIDER_MISMATCH" };
    }
  }

  private async observeRevision(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    previous: Readonly<AgentRevision> | undefined,
    expectedActiveRevisionId: string | undefined,
    context: ComputeRevisionContext,
  ): Promise<RevisionDispatchResult> {
    return this.withClaimHeartbeat(claim, async () => {
      const prepared = await this.prepareRevision(claim, revision, context);
      const observation = prepared.observation;
      context = prepared.context;
      if (!validRevisionObservation(observation, revision)) {
        return { outcome: "permanent", code: "INVALID_DRIVER_OBSERVATION" };
      }
      const resultData = pluginWarningsResultData(
        computePluginWarnings(observation.warnings, revision) ?? Object.freeze([]),
      );
      if (!observation.ready) {
        const runtimeFailure = runtimeFailureFromObservation(observation);
        return {
          outcome: "pending",
          code: "REVISION_INCOMPLETE",
          ...(runtimeFailure === undefined ? {} : { data: { runtimeFailure } }),
        };
      }
      if (revision.repositoryCredentials !== undefined) {
        await this.assertRepositoryAuthority(claim, revision);
        this.repositoryCredentials.validate(revision);
      }
      const agent = await this.state.read((view) =>
        view.agents.findAgent(revision.namespaceId, revision.agentId),
      );
      if (agent?.desiredRuntimeState !== "running") {
        await this.closeRevisionCredentials(claim, revision);
        await this.compute.stopRevision(revision);
        return { outcome: "success", code: "REVISION_STOPPED" };
      }
      if (this.compute.activationOrder === "beforeCommit") {
        await this.stagedRevision("activateRevision", revision, context);
      } else if (
        this.mode === "production" &&
        revision.harness.mode === "dedicated" &&
        expectedActiveRevisionId === undefined
      ) {
        await this.stagedRevision("deactivateRevision", revision);
      }
      return {
        outcome: "success",
        code: "REVISION_ACTIVATED",
        revision,
        ...(resultData === undefined ? {} : { resultData }),
        context,
        ...(previous === undefined ? {} : { previous }),
        ...(expectedActiveRevisionId === undefined ? {} : { expectedActiveRevisionId }),
      };
    });
  }

  private async resolveRevisionSecretContext(
    revision: Readonly<AgentRevision>,
  ): Promise<
    { readonly context: ComputeRevisionContext } | { readonly result: RevisionDispatchResult }
  > {
    const bindings = revisionSecretBindings(revision);
    if ("result" in bindings) {
      return { result: bindings.result };
    }
    const secretDriverId = this.secretDriverId;
    if (
      Object.keys(bindings.bindings).length > 0 &&
      (typeof secretDriverId !== "string" || revision.secretDriverId !== secretDriverId)
    ) {
      return { result: { outcome: "permanent", code: "SECRET_DRIVER_MISMATCH" } };
    }

    const resolved = await this.state.read(async (view) => {
      const projections: SecretEnvironmentProjection[] = [];
      for (const [name, binding] of Object.entries(bindings.bindings)) {
        const secret = await view.secrets.findSecret(binding.source.namespaceId, binding.source.id);
        if (
          secret === undefined ||
          secret.namespaceId !== revision.namespaceId ||
          secret.driverId !== secretDriverId ||
          secret.backendRef.namespaceName.trim().length === 0 ||
          secret.backendRef.name.trim().length === 0 ||
          secret.backendRef.key.trim().length === 0 ||
          secret.backendRef.uid.trim().length === 0
        ) {
          return undefined;
        }
        projections.push({
          name,
          secretId: secret.id,
          namespaceId: secret.namespaceId,
          agentId: revision.agentId,
          backendRef: secret.backendRef,
        });
      }
      return projections;
    });

    if (resolved === undefined) {
      return { result: { outcome: "permanent", code: "SECRET_BINDING_UNAVAILABLE" } };
    }

    let harnessAuth: ResolvedHarnessAuth;
    if (revision.harnessAuth.method === "api_key" || revision.harnessAuth.method === "codex_pat") {
      const auth = revision.harnessAuth;
      if (typeof secretDriverId !== "string" || auth.secretDriverId !== secretDriverId) {
        return { result: { outcome: "permanent", code: "SECRET_DRIVER_MISMATCH" } };
      }
      const secret = await this.state.read((view) =>
        view.secrets.findSecret(auth.source.namespaceId, auth.source.id),
      );
      if (
        secret === undefined ||
        secret.namespaceId !== revision.namespaceId ||
        secret.namespaceId !== auth.source.namespaceId ||
        secret.id !== auth.source.id ||
        secret.driverId !== secretDriverId ||
        secret.backendRef.namespaceName.trim().length === 0 ||
        secret.backendRef.name.trim().length === 0 ||
        secret.backendRef.key.trim().length === 0 ||
        secret.backendRef.uid.trim().length === 0
      ) {
        return { result: { outcome: "permanent", code: "HARNESS_AUTH_SOURCE_UNAVAILABLE" } };
      }
      // Admission verifies the physical source. Workers project authoritative
      // OCC metadata without requiring permission to read backend Secret values.
      harnessAuth = { ...auth, backendRef: secret.backendRef };
    } else {
      harnessAuth = revision.harnessAuth;
    }
    const workspaceSetup = await this.state.read((view) =>
      view.workspaceSetups.find(revision.namespaceId, revision.agentId),
    );
    if (workspaceSetup !== undefined && this.compute.supportsWorkspaceSetup !== true) {
      return { result: { outcome: "permanent", code: "WORKSPACE_SETUP_UNSUPPORTED" } };
    }
    return {
      context: {
        secretEnvironment: Object.freeze(resolved),
        harnessAuth,
        ...(workspaceSetup === undefined ? {} : { workspaceSetup }),
      },
    };
  }

  private async withClaimHeartbeat<T>(
    claim: ClaimedWork,
    effect: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.stopping || this.abort.signal.aborted) {
      throw new WorkClaimLostError();
    }
    // Consecutive short effects can each finish before their timer fires while
    // the whole sequence outlives the lease. Renew before every external effect.
    if ((await this.queue.heartbeat(claim)) === undefined) {
      throw new WorkClaimLostError();
    }
    let lost = false;
    let pending = Promise.resolve();
    const operation = new AbortController();
    const abandon = () => {
      lost = true;
      operation.abort(new WorkClaimLostError());
    };
    this.abort.signal.addEventListener("abort", abandon, { once: true });
    if (this.abort.signal.aborted) {
      abandon();
    }
    const heartbeat = setInterval(
      () => {
        pending = pending.then(async () => {
          if ((await this.queue.heartbeat(claim)) === undefined) {
            abandon();
          } else if (!lost) {
            void this.health(false);
          }
        });
        pending.catch(() => {
          abandon();
        });
      },
      Math.max(1, Math.floor(this.leaseDurationMs / 3)),
    );
    heartbeat.unref();
    // Readiness callbacks must not delay Compute or the next claim renewal.
    // health() serializes its own updates and reports failures separately.
    void this.health(false);
    try {
      return await withComputeAbortSignal(operation.signal, () => effect(operation.signal));
    } finally {
      clearInterval(heartbeat);
      this.abort.signal.removeEventListener("abort", abandon);
      await pending.catch(() => {});
      if (lost) {
        throw new WorkClaimLostError();
      }
    }
  }

  private async observe(
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
  ): Promise<DispatchResult> {
    return this.withClaimHeartbeat(claim, async () => {
      if (claim.namespaceTarget === "deleted") {
        const attempts = await this.state.read((view) =>
          view.repositorySessions.listNamespaceAttempts(namespace.id),
        );
        const owners = new Map(attempts.map((attempt) => [attempt.revisionId, attempt]));
        for (const attempt of owners.values()) {
          const revision = await this.state.read((view) =>
            view.revisions.findRevision(attempt.namespaceId, attempt.agentId, attempt.revisionId),
          );
          if (
            revision !== undefined &&
            Date.parse(revision.createdAt) <= claim.createdAt.getTime()
          ) {
            await this.closeRevisionCredentials(claim, revision);
          }
        }
      }
      const observation =
        claim.namespaceTarget === "ready"
          ? await this.compute.ensureNamespace(namespace)
          : await this.compute.deleteNamespace(namespace);
      if (!validObservation(observation, namespace.id, claim.namespaceTarget ?? "ready")) {
        return { outcome: "permanent", code: "INVALID_DRIVER_OBSERVATION" };
      }
      const complete =
        "namespaceReady" in observation ? observation.namespaceReady : observation.namespaceDeleted;
      let outcome: Outcome;
      if (observation.failure === "permanent") {
        outcome = "permanent";
      } else if (complete && observation.failure === undefined) {
        outcome = "success";
      } else if (observation.failure === "retryable") {
        outcome = "retry";
      } else {
        outcome = "pending";
      }
      return {
        outcome,
        code: complete ? "NAMESPACE_RECONCILED" : "NAMESPACE_INCOMPLETE",
        observation,
      };
    });
  }

  private async finalizeRevision(
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const expired =
      result.outcome === "pending" &&
      Date.now() - claim.createdAt.getTime() >= this.convergenceTimeoutMs;
    let resolved: RevisionDispatchResult = expired
      ? {
          ...result,
          outcome: "permanent",
          code: "CONVERGENCE_DEADLINE_EXCEEDED",
          data: convergenceDeadlineResultData(
            this.convergenceTimeoutMs,
            safeRuntimeFailureEvidence(result.data?.runtimeFailure),
          ),
        }
      : result;
    if (resolved.outcome === "success" && resolved.revision?.repositoryCredentials !== undefined) {
      try {
        await this.assertRepositoryAuthority(claim, resolved.revision);
        this.repositoryCredentials.validate(resolved.revision);
      } catch (error) {
        if (error instanceof WorkClaimLostError) {
          throw error;
        }
        resolved =
          error instanceof RepositoryCredentialAuthorityError
            ? { outcome: "permanent", code: error.code }
            : { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
      }
    }
    let activated: Readonly<AgentRevision> | undefined;
    let stoppedCandidate: Readonly<AgentRevision> | undefined;
    let committedOutcome: WorkOutcome =
      resolved.outcome === "retry" && claim.attemptCount >= this.maxAttempts
        ? "permanent"
        : resolved.outcome;
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      if (resolved.supersededBy !== undefined && resolved.outcome === "success") {
        const revision = await unit.revisions.findRevision(
          claim.namespaceId,
          claim.agentId!,
          claim.revisionId!,
        );
        if (revision?.repositoryCredentials !== undefined) {
          await queue.enqueueRepositoryCleanup(
            claim,
            {
              namespaceId: revision.namespaceId,
              agentId: revision.agentId,
              revisionId: revision.id,
            },
            "terminal-runtime",
          );
        }
        await this.appendRevisionSuperseded(unit, claim, resolved.supersededBy);
      } else if (resolved.revision !== undefined && resolved.outcome === "success") {
        const current = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
        if (
          current === undefined ||
          current.servicePrincipalId !== resolved.revision.servicePrincipalId ||
          current.activeRevisionId !== resolved.expectedActiveRevisionId
        ) {
          await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
          committedOutcome = claim.attemptCount >= this.maxAttempts ? "permanent" : "retry";
          return;
        }
        if (current.desiredRuntimeState !== "running") {
          stoppedCandidate = resolved.revision;
          return;
        }
        const activeAgent = await unit.agents.compareAndSetActiveRevision(
          claim.namespaceId,
          current.id,
          resolved.expectedActiveRevisionId,
          resolved.revision.id,
        );
        if (activeAgent === undefined) {
          await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
          committedOutcome = claim.attemptCount >= this.maxAttempts ? "permanent" : "retry";
          return;
        }
        activated = resolved.revision;
        return;
      } else if (resolved.decision !== undefined) {
        await this.appendRevisionDenial(unit, claim, resolved);
      }

      if (resolved.outcome === "success") {
        await queue.complete(claim, {
          code: resolved.code,
          ...(resolved.resultData === undefined ? {} : { resultData: resolved.resultData }),
        });
      } else if (resolved.outcome === "pending") {
        await queue.defer(claim, { code: resolved.code });
      } else if (resolved.outcome === "permanent" || claim.attemptCount >= this.maxAttempts) {
        await queue.fail(claim, {
          code: resolved.code,
          ...(resolved.data === undefined ? {} : { data: resolved.data }),
        });
      } else {
        await queue.retry(claim, {
          code: resolved.code,
        });
      }
    }, this.queueOptions);
    if (stoppedCandidate !== undefined) {
      await this.closeRevisionCredentials(claim, stoppedCandidate);
      await this.withClaimHeartbeat(claim, () => this.compute.stopRevision(stoppedCandidate!));
      await this.completeStoppedRevisionWork(claim, stoppedCandidate, "REVISION_STOPPED");
      return;
    }
    const compute = this.compute;
    this.passOutcome = committedOutcome;
    if (activated !== undefined) {
      try {
        const current = await this.state.read((view) =>
          view.agents.findAgent(claim.namespaceId, claim.agentId!),
        );
        if (current?.desiredRuntimeState !== "running") {
          await this.closeRevisionCredentials(claim, activated);
          await this.withClaimHeartbeat(claim, () => compute.stopRevision(activated!));
          await this.retireEarlierRevisions(claim, activated);
          await this.completeStoppedRevisionWork(claim, activated, "REVISION_STOPPED");
          return;
        }
        if (this.shouldActivateAfterCommit(compute)) {
          if (activated.repositoryCredentials !== undefined) {
            await this.assertRepositoryAuthority(claim, activated);
            this.repositoryCredentials.validate(activated);
          }
          await this.withClaimHeartbeat(claim, () =>
            this.stagedRevision("activateRevision", activated!, resolved.context),
          );
        }
        await this.retireEarlierRevisions(claim, activated);
      } catch (error) {
        if (error instanceof WorkClaimLostError) {
          throw error;
        }
        if (error instanceof RepositoryCredentialAuthorityError) {
          await this.finalizeRevision(claim, { outcome: "permanent", code: error.code });
          return;
        }
        await this.finalizeRevision(claim, {
          outcome: "pending",
          code: "REVISION_FINALIZATION_INCOMPLETE",
        });
        return;
      }
      await this.completeActivatedRevision(claim, resolved);
      return;
    }
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: resolved.outcome,
      outcome: resolved.outcome,
      code: resolved.code,
    });
  }

  private async completeStoppedRevisionWork(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    code: string,
  ): Promise<void> {
    await this.closeRevisionCredentials(claim, revision);
    await this.state.transactWithQueue(async (_unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      await queue.complete(claim, { code });
    }, this.queueOptions);
    this.passOutcome = "success";
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: revision.id,
      result: "success",
      outcome: "success",
      code,
    });
  }

  private async retireEarlierRevisions(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    const earlier = await this.state.read(async (view) =>
      (await view.revisions.listRevisions(revision.namespaceId, revision.agentId)).filter(
        (candidate) => candidate.revision < revision.revision,
      ),
    );
    for (const previous of earlier) {
      await this.closeRevisionCredentials(claim, previous);
      await this.withClaimHeartbeat(claim, () => this.compute.retireRevision(previous));
    }
  }

  private async completeActivatedRevision(
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const revision = result.revision;
    if (revision === undefined) {
      throw new Error("The activated Agent revision is unavailable.");
    }
    let completed = false;
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      const agent = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
      if (
        agent === undefined ||
        agent.id !== revision.agentId ||
        agent.servicePrincipalId !== revision.servicePrincipalId ||
        agent.activeRevisionId !== revision.id
      ) {
        await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
        return;
      }
      const setup = await unit.workspaceSetups.find(revision.namespaceId, revision.agentId);
      if (setup !== undefined && !setup.completed) {
        await unit.workspaceSetups.complete(revision.namespaceId, revision.agentId, setup.id);
      }
      await this.appendRevisionObservation(unit, claim, result);
      await queue.complete(claim, {
        code: result.code,
        ...(result.resultData === undefined ? {} : { resultData: result.resultData }),
      });
      if (this.revisionMaintenanceInterval(revision) !== undefined) {
        await this.enqueueMaintenance(queue, claim, revision);
      }
      completed = true;
    }, this.queueOptions);
    this.passOutcome = result.outcome;
    if (!completed) {
      this.passOutcome = claim.attemptCount >= this.maxAttempts ? "permanent" : "retry";
      return;
    }
    // Original admission time survives queue waits and retries. Maintenance and
    // superseded work must not count as additional successful deployments.
    if (claim.idempotencyKey === `agent_revision:${revision.id}:reconcile`) {
      this.metrics?.observeAgentOperation(
        "deploy",
        Math.max(0, Date.now() - claim.createdAt.getTime()) / 1000,
      );
    }
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: result.outcome,
      outcome: result.outcome,
      code: result.code,
    });
  }

  private async finalizeActiveRevision(
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
    code: string,
    runtimeFailure?: RuntimeFailureEvidence,
  ): Promise<void> {
    if (
      this.revisionMaintenanceInterval(revision) === undefined ||
      !new RegExp(`^agent_revision:${revision.id}:maintenance:(0|[1-9][0-9]*)$`).test(
        claim.idempotencyKey,
      )
    ) {
      await this.finalizeRevision(claim, {
        outcome: "pending",
        code,
        ...(runtimeFailure === undefined ? {} : { data: { runtimeFailure } }),
      });
      return;
    }
    let superseded = false;
    if (revision.repositoryCredentials !== undefined) {
      try {
        await this.assertRepositoryAuthority(claim, revision);
        this.repositoryCredentials.validate(revision);
      } catch (error) {
        if (error instanceof WorkClaimLostError) {
          throw error;
        }
        if (error instanceof RepositoryCredentialAuthorityError) {
          await this.finalizeRevision(claim, { outcome: "permanent", code: error.code });
          return;
        }
        throw error;
      }
    }
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      const agent = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
      if (
        agent === undefined ||
        agent.servicePrincipalId !== revision.servicePrincipalId ||
        agent.activeRevisionId !== revision.id ||
        agent.desiredRuntimeState !== "running"
      ) {
        await queue.complete(claim);
        superseded = true;
        return;
      }
      if (revision.repositoryCredentials !== undefined) {
        this.repositoryCredentials.validate(revision);
      }
      // Keep each failed observation bounded without permanently abandoning
      // an authorized active runtime after one prolonged provider outage.
      await queue.fail(claim, { code }, { continuingRevision: true });
      await this.enqueueMaintenance(queue, claim, revision);
    }, this.queueOptions);
    this.passOutcome = superseded ? "success" : "permanent";
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: "pending",
      outcome: "pending",
      code,
    });
  }

  private async enqueueMaintenance(
    queue: Pick<PostgresWorkQueue, keyof PostgresWorkQueue>,
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    const interval = this.revisionMaintenanceInterval(revision)!;
    const candidateAvailableAt = new Date(Date.now() + interval);
    let maintenanceBucket = Math.floor(candidateAvailableAt.getTime() / interval);
    const maintenancePrefix = `agent_revision:${revision.id}:maintenance:`;
    const currentBucket = claim.idempotencyKey.startsWith(maintenancePrefix)
      ? Number(claim.idempotencyKey.slice(maintenancePrefix.length))
      : undefined;
    // Clock skew must not deduplicate the successor against its completed claim.
    const availableAt =
      currentBucket !== undefined &&
      Number.isSafeInteger(currentBucket) &&
      currentBucket >= 0 &&
      maintenanceBucket <= currentBucket
        ? new Date((currentBucket + 1) * interval)
        : candidateAvailableAt;
    maintenanceBucket = Math.floor(availableAt.getTime() / interval);
    await queue.enqueue({
      idempotencyKey: `agent_revision:${revision.id}:maintenance:${maintenanceBucket}`,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      actorId: claim.actorId,
      availableAt,
    });
  }

  private async appendRevisionObservation(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const installation = this.installation;
    const revision = result.revision;
    if (installation === undefined || revision === undefined) {
      throw new Error("The worker revision activation is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: revision.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.activate",
      resource: { kind: "agent_revision", id: revision.id, namespaceId: revision.namespaceId },
      iamDriverId: this.iamDriverId,
      outcome: "success",
      details: {
        computeDriverId: this.compute.id,
        ...(result.previous === undefined ? {} : { previousRevisionId: result.previous.id }),
      },
    });
  }

  private async appendRevisionSuperseded(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    active: Readonly<AgentRevision>,
  ): Promise<void> {
    const installation = this.installation;
    if (installation === undefined || claim.revisionId === undefined) {
      throw new Error("The worker superseded revision is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.supersede",
      resource: {
        kind: "agent_revision",
        id: claim.revisionId,
        namespaceId: claim.namespaceId,
      },
      iamDriverId: this.iamDriverId,
      outcome: "success",
      details: {
        activeRevisionId: active.id,
        reasonCode: "REVISION_SUPERSEDED",
      },
    });
  }

  private async appendRevisionDenial(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const installation = this.installation;
    if (installation === undefined || claim.agentId === undefined) {
      throw new Error("The worker revision authorization is unavailable.");
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.deploy",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.iamDriverId,
      ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      ...(result.decision === undefined ? {} : { decisionReason: result.decision.reason }),
      reasonCode: result.code,
      outcome: "denied",
    });
  }

  private async finalize(
    claim: ClaimedWork,
    namespace: Readonly<Namespace> | undefined,
    result: DispatchResult,
  ): Promise<void> {
    const expired =
      result.outcome === "pending" &&
      Date.now() - claim.createdAt.getTime() >= this.convergenceTimeoutMs;
    const resolved: DispatchResult = expired
      ? { ...result, outcome: "permanent", code: "CONVERGENCE_DEADLINE_EXCEEDED" }
      : result;
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) {
        throw new WorkClaimLostError();
      }
      const current =
        namespace === undefined
          ? undefined
          : await unit.namespaces.lockNamespace(namespace.id, { includeDeleted: true });
      if (
        current !== undefined &&
        current.deletedAt === undefined &&
        ((claim.namespaceTarget === "ready" && current.status === "provisioning") ||
          (claim.namespaceTarget === "deleted" && current.status === "deleting"))
      ) {
        const exhausted = resolved.outcome === "retry" && claim.attemptCount >= this.maxAttempts;
        if (claim.namespaceTarget === "ready" && resolved.outcome === "success") {
          await unit.namespaces.transitionNamespaceStatus(current.id, "provisioning", "ready");
        } else if (
          claim.namespaceTarget === "ready" &&
          (resolved.outcome === "permanent" || exhausted)
        ) {
          await unit.namespaces.transitionNamespaceStatus(current.id, "provisioning", "failed");
        } else if (claim.namespaceTarget === "deleted" && resolved.outcome === "success") {
          await unit.namespaces.markNamespaceDeleted(current.id, new Date().toISOString());
        }

        if (resolved.decision !== undefined) {
          await this.appendDenial(unit, claim, current, resolved);
        } else if (resolved.observation !== undefined) {
          await this.appendObservation(unit, claim, current, resolved);
        }
      }

      if (resolved.outcome === "success") {
        await queue.complete(claim);
      } else if (resolved.outcome === "pending") {
        await queue.defer(claim, { code: resolved.code });
      } else if (resolved.outcome === "permanent" || claim.attemptCount >= this.maxAttempts) {
        await queue.fail(claim, { code: resolved.code });
      } else {
        await queue.retry(claim, { code: resolved.code });
      }
    }, this.queueOptions);
    this.passOutcome =
      resolved.outcome === "retry" && claim.attemptCount >= this.maxAttempts
        ? "permanent"
        : resolved.outcome;
    this.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      result: resolved.outcome,
      outcome: resolved.outcome,
      code: resolved.code,
    });
  }

  private async appendObservation(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
    result: DispatchResult,
  ): Promise<void> {
    const installation = this.installation;
    if (installation === undefined) {
      throw new Error("The worker Installation is unavailable.");
    }
    const observation = result.observation;
    if (observation === undefined) {
      return;
    }
    const details = {
      computeDriverId: this.compute.id,
      ...("namespaceReady" in observation
        ? { namespaceReady: observation.namespaceReady }
        : { namespaceDeleted: observation.namespaceDeleted }),
      ...(observation.failure === undefined ? {} : { failure: observation.failure }),
      ...(result.outcome === "pending" ? { convergencePending: true } : {}),
    };
    const event: AuditEvent = {
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: namespace.id,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action:
        claim.namespaceTarget === "deleted"
          ? "openclaw.namespaces.lifecycle.delete"
          : "openclaw.namespaces.lifecycle.ensure",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      iamDriverId: this.iamDriverId,
      outcome: result.outcome === "success" || result.outcome === "pending" ? "success" : "failure",
      details,
    };
    await unit.audit.append(event);
  }

  private async appendDenial(
    unit: PlatformUnitOfWork,
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
    result: DispatchResult,
  ): Promise<void> {
    const installation = this.installation;
    if (installation === undefined) {
      throw new Error("The worker Installation is unavailable.");
    }
    const event: AuditEvent = {
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: namespace.id,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      actorId: claim.actorId,
      source: "occ",
      action:
        claim.namespaceTarget === "deleted"
          ? "openclaw.namespaces.delete"
          : "openclaw.namespaces.create",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      iamDriverId: this.iamDriverId,
      ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      ...(result.decision === undefined ? {} : { decisionReason: result.decision.reason }),
      reasonCode: result.code,
      outcome: "denied",
    };
    await unit.audit.append(event);
  }
}

export function createControllerWorker(options: ControllerWorkerOptions): ControllerWorker {
  return new ControllerWorker(options);
}
