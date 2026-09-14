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
  WorkClaimLostError,
  type ClaimedWork,
  type PlatformUnitOfWork,
  type PostgresPool,
  type PostgresQueryClient,
  type PostgresWorkQueueOptions,
} from "@openclaw-enterprise/occ";
import {
  providerDefinitionMap,
  validateProviderDefinitions,
  validateServiceAccountProviderBinding,
} from "@openclaw-enterprise/occ";
import type { InstallationRuntimeDrivers } from "./composition/installation-config.ts";
import { resolveApprovedHarness } from "./composition/production-harness.ts";
import { withComputeAbortSignal } from "./drivers/compute/operation-context.ts";

export interface ControllerWorkerOptions {
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
  readonly revision?: Readonly<AgentRevision>;
  readonly previous?: Readonly<AgentRevision>;
  readonly supersededBy?: Readonly<AgentRevision>;
  readonly expectedActiveRevisionId?: string;
  readonly context?: ComputeRevisionContext;
}

function positiveInteger(value: number, name: string): number {
  if (!isPositiveSafeInteger(value)) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function workOperation(claim: ClaimedWork): string {
  if (claim.revisionId !== undefined) return "agent_revision.reconcile";
  if (claim.namespaceTarget === "deleted") return "namespace.delete";
  if (claim.namespaceTarget === "ready") return "namespace.ensure";
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
    typeof driver.retireRevision === "function"
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
  if (hooks === undefined) return true;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return false;
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
  if (typeof value !== "object" || value === null || Object.hasOwn(value, "installationId"))
    return false;
  const observation = value as Partial<NamespaceEnsureResult & NamespaceDeleteResult>;
  if (
    observation.namespaceId !== namespaceId ||
    (observation.failure !== undefined &&
      observation.failure !== "retryable" &&
      observation.failure !== "permanent")
  )
    return false;
  return target === "ready"
    ? typeof observation.namespaceReady === "boolean"
    : typeof observation.namespaceDeleted === "boolean";
}

function validRevisionObservation(value: unknown, revision: Readonly<AgentRevision>): boolean {
  if (typeof value !== "object" || value === null || Object.hasOwn(value, "installationId"))
    return false;
  const observation = value as Record<string, unknown>;
  return (
    observation.namespaceId === revision.namespaceId &&
    observation.agentId === revision.agentId &&
    observation.revisionId === revision.id &&
    typeof observation.ready === "boolean"
  );
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

function uniqueSecretRefs(bindings: SecretBindings): readonly SecretReference[] {
  const refs = new Map<string, SecretReference>();
  for (const { source } of Object.values(bindings)) {
    refs.set(`${source.namespaceId}\u0000${source.id}`, source);
  }
  return [...refs.values()];
}

export class ControllerWorker {
  private readonly state: PostgresPlatformState;
  private readonly queue: PostgresWorkQueue;
  private readonly compute: ComputeDriver;
  private readonly configuration: ConfigurationDriver | undefined;
  private readonly queueOptions: PostgresWorkQueueOptions;
  private readonly iamDriverId: string;
  private readonly iam: IAMDriver;
  private readonly secretDriverId: string | undefined;
  private readonly sandbox: SandboxDriver | undefined;
  private readonly providers: readonly ProviderDefinition[];
  private readonly providerMap: ReadonlyMap<string, ProviderDefinition>;
  private readonly requireComputePreflight: boolean;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly convergenceTimeoutMs: number;
  private readonly maintenanceIntervalMs: number | undefined;
  private readonly mode: "development" | "production";
  private readonly emit: (event: Readonly<Record<string, unknown>>) => void;
  private readonly onHealthy: (() => Promise<void>) | undefined;
  private readonly abort = new AbortController();
  private installation: Readonly<Installation> | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private lastHealthAt = 0;

  constructor(options: ControllerWorkerOptions) {
    this.mode = options.mode ?? "development";
    if (this.mode !== "development" && this.mode !== "production")
      throw new Error("The controller worker mode must be development or production.");
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 250, "Worker poll interval");
    this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? 5_000, "Worker claim lease");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 5, "Maximum worker attempts");
    this.convergenceTimeoutMs = positiveInteger(
      options.convergenceTimeoutMs ?? 900_000,
      "Worker convergence timeout",
    );
    const drivers = options.drivers;
    if (this.mode === "production" && drivers === undefined) {
      throw new Error("Production controller workers require Installation startup configuration.");
    }
    this.queueOptions = {
      leaseDurationMs: this.leaseDurationMs,
      maxAttempts: this.maxAttempts,
    };
    this.state = new PostgresPlatformState(options.pool);
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
    if (computeDriver === undefined)
      throw new Error("The selected Compute Driver must be explicitly provided.");
    if (drivers === undefined && !validDriver(computeDriver))
      throw new Error("The selected Compute Driver is unavailable.");
    if (
      computeDriver.activationOrder === "beforeCommit" &&
      typeof computeDriver.activateRevision !== "function"
    ) {
      throw new Error("A before-commit Compute Driver must implement activateRevision.");
    }
    this.compute = computeDriver;
    const selectedSecretDriver = drivers?.secretDriver;
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
  }

  async start(): Promise<void> {
    if (this.loop !== undefined) throw new Error("The controller worker is already running.");
    const installation = await this.state.loadInstallation();
    if (installation === undefined)
      throw new Error("The platform Installation must be bootstrapped before starting the worker.");
    this.installation = installation;
    validatePersistedNativeIAMState(await this.loadIAMState());
    this.attachLifecycleDrivers(this.iam);
    if (this.mode === "production") {
      const compute = this.compute as ComputeDriver & { preflight?: () => Promise<void> };
      if (typeof compute.preflight === "function") await compute.preflight();
      else if (this.requireComputePreflight)
        throw new Error("The selected bundled production Compute Driver requires preflight.");
    }
    this.emit({
      event: "worker.started",
      computeDriverId: this.compute.id,
      ...(this.sandbox === undefined ? {} : { sandboxDriverId: this.sandbox.id }),
    });
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
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
          await this.process(claim);
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
        if (!this.stopping) throw error;
      }
    }
  }

  private async health(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastHealthAt < Math.max(1_000, this.pollIntervalMs * 20)) return;
    const pending = await this.queue.pending();
    await this.onHealthy?.();
    this.lastHealthAt = now;
    this.emit({ event: "worker.health", status: "ready", pending });
  }

  private async loadIAMState(): Promise<NativeIAMState> {
    if (this.installation === undefined) throw new Error("The worker Installation is unavailable.");
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
    if (this.sandbox?.computeLifecycleHooks !== undefined) lifecycleDrivers.push(this.sandbox);
    if (iam.computeLifecycleHooks !== undefined) lifecycleDrivers.push(iam);
    if (lifecycleDrivers.length === 0) return;
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
    if (installation === undefined) throw new Error("The worker Installation is unavailable.");
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
    if (!decision.allowed)
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        decision,
        authorization: request,
      };
    if (claim.namespaceTarget === "ready") {
      if (namespace.existingNamespace !== undefined) {
        const adminRequest: AuthorizationRequest = {
          principalId: claim.actorId,
          action: "administer",
          resource: { kind: "installation", id: installation.id },
        };
        const adminDecision = await this.iamDecision(driver, adminRequest);
        if (!adminDecision.allowed)
          return {
            outcome: "permanent",
            code: "AUTHORIZATION_DENIED",
            decision: adminDecision,
            authorization: adminRequest,
          };
      }
      const exactDecision = await this.iamDecision(driver, exact);
      if (exactDecision.evidence.restrictionIds.length > 0)
        return {
          outcome: "permanent",
          code: "AUTHORIZATION_DENIED",
          decision: exactDecision,
          authorization: exact,
        };
    }
    return undefined;
  }

  private async process(claim: ClaimedWork): Promise<void> {
    if (claim.revisionId !== undefined) {
      await this.processRevision(claim);
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
      if ((await this.queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
      result = await this.observe(claim, namespace);
    } catch (error) {
      if (error instanceof WorkClaimLostError) throw error;
      result = { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.finalize(claim, namespace, result);
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
      if (this.compute.bindAgent !== undefined) {
        await this.withClaimHeartbeat(claim, async () => {
          await this.compute.bindAgent!({ namespace, agent });
        });
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
      if (agent.activeRevisionId === revision.id) {
        try {
          const compute = this.compute;
          if (this.maintenanceIntervalMs !== undefined) {
            const observation = await this.withClaimHeartbeat(claim, () =>
              compute.prepareRevision(revision, secretContext.context),
            );
            if (!validRevisionObservation(observation, revision)) {
              await this.finalizeRevision(claim, {
                outcome: "permanent",
                code: "INVALID_DRIVER_OBSERVATION",
              });
              return;
            }
            if (!observation.ready) {
              await this.finalizeActiveRevision(claim, revision, "REVISION_INCOMPLETE");
              return;
            }
          }
          if (this.shouldActivatePublishedRevision(compute)) {
            await this.withClaimHeartbeat(claim, () =>
              this.stagedRevision("activateRevision", revision, secretContext.context),
            );
          }
          const earlier = await this.state.read(async (view) =>
            (await view.revisions.listRevisions(revision.namespaceId, revision.agentId)).filter(
              (candidate) => candidate.revision < revision.revision,
            ),
          );
          for (const previous of earlier) {
            await this.withClaimHeartbeat(claim, () => compute.retireRevision(previous));
          }
        } catch (error) {
          if (error instanceof WorkClaimLostError) throw error;
          await this.finalizeActiveRevision(claim, revision, "REVISION_FINALIZATION_INCOMPLETE");
          return;
        }
        await this.completeActivatedRevision(claim, {
          outcome: "success",
          code: "REVISION_ALREADY_ACTIVE",
          revision,
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
      if ((await this.queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
      result = await this.observeRevision(
        claim,
        revision,
        previous,
        agent.activeRevisionId,
        secretContext.context,
      );
    } catch (error) {
      if (error instanceof WorkClaimLostError) throw error;
      result = { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
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
    if (identity === undefined) return { outcome: "permanent", code: "INVALID_AGENT_PRINCIPAL" };
    const decision = await this.iamDecision(driver, authorization);
    if (!decision.allowed)
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        authorization,
        decision,
      };

    const secretBindings = revisionSecretBindings(revision);
    if ("result" in secretBindings) return secretBindings.result;
    for (const ref of uniqueSecretRefs(secretBindings.bindings)) {
      for (const principalId of [claim.actorId, revision.servicePrincipalId]) {
        const secretAuthorization: AuthorizationRequest = {
          principalId,
          action: "operate",
          resource: ref,
        };
        const secretDecision = await this.iamDecision(driver, secretAuthorization);
        if (!secretDecision.allowed)
          return {
            outcome: "permanent",
            code: "AUTHORIZATION_DENIED",
            authorization: secretAuthorization,
            decision: secretDecision,
          };
      }
    }

    if (revision.serviceAccount !== undefined) {
      const accountAuthorization: AuthorizationRequest = {
        principalId: claim.actorId,
        action: "read",
        resource: {
          kind: "service_account",
          id: revision.serviceAccount.id,
          namespaceId: revision.namespaceId,
        },
      };
      const accountDecision = await this.iamDecision(driver, accountAuthorization);
      if (!accountDecision.allowed)
        return {
          outcome: "permanent",
          code: "AUTHORIZATION_DENIED",
          authorization: accountAuthorization,
          decision: accountDecision,
        };
    }
    return undefined;
  }

  private async resolveRevisionProvider(
    revision: Readonly<AgentRevision>,
  ): Promise<RevisionDispatchResult | undefined> {
    if (revision.providerId !== null && !this.providerMap.has(revision.providerId)) {
      return { outcome: "permanent", code: "PROVIDER_UNAVAILABLE" };
    }
    if (revision.serviceAccount?.credential.kind !== "access_token") return undefined;
    const binding = await this.state.read((view) =>
      view.serviceAccounts.findServiceAccountProviderBinding(
        revision.namespaceId,
        revision.serviceAccount!.id,
      ),
    );
    try {
      validateServiceAccountProviderBinding(this.providerMap, revision.providerId, binding);
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
      const observation = await this.compute.prepareRevision(revision, context);
      if (!validRevisionObservation(observation, revision))
        return { outcome: "permanent", code: "INVALID_DRIVER_OBSERVATION" };
      if (!observation.ready) return { outcome: "pending", code: "REVISION_INCOMPLETE" };
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
    if ("result" in bindings) return { result: bindings.result };
    if (Object.keys(bindings.bindings).length === 0) return { context: { secretEnvironment: [] } };
    const secretDriverId = this.secretDriverId;
    if (typeof secretDriverId !== "string" || revision.secretDriverId !== secretDriverId) {
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

    return resolved === undefined
      ? { result: { outcome: "permanent", code: "SECRET_BINDING_UNAVAILABLE" } }
      : { context: { secretEnvironment: Object.freeze(resolved) } };
  }

  private async withClaimHeartbeat<T>(claim: ClaimedWork, effect: () => Promise<T>): Promise<T> {
    // Consecutive short effects can each finish before their timer fires while
    // the whole sequence outlives the lease. Renew before every external effect.
    if ((await this.queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
    let lost = false;
    let pending = Promise.resolve();
    const operation = new AbortController();
    const abandon = () => {
      lost = true;
      operation.abort(new WorkClaimLostError());
    };
    this.abort.signal.addEventListener("abort", abandon, { once: true });
    const heartbeat = setInterval(
      () => {
        pending = pending.then(async () => {
          if ((await this.queue.heartbeat(claim)) === undefined) abandon();
        });
        pending.catch(() => {
          abandon();
        });
      },
      Math.max(1, Math.floor(this.leaseDurationMs / 3)),
    );
    heartbeat.unref();
    try {
      return await withComputeAbortSignal(operation.signal, effect);
    } finally {
      clearInterval(heartbeat);
      this.abort.signal.removeEventListener("abort", abandon);
      await pending.catch(() => {});
      if (lost) throw new WorkClaimLostError();
    }
  }

  private async observe(
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
  ): Promise<DispatchResult> {
    return this.withClaimHeartbeat(claim, async () => {
      const observation =
        claim.namespaceTarget === "ready"
          ? await this.compute.ensureNamespace(namespace)
          : await this.compute.deleteNamespace(namespace);
      if (!validObservation(observation, namespace.id, claim.namespaceTarget ?? "ready"))
        return { outcome: "permanent", code: "INVALID_DRIVER_OBSERVATION" };
      const complete =
        "namespaceReady" in observation ? observation.namespaceReady : observation.namespaceDeleted;
      let outcome: Outcome;
      if (observation.failure === "permanent") outcome = "permanent";
      else if (complete && observation.failure === undefined) outcome = "success";
      else if (observation.failure === "retryable") outcome = "retry";
      else outcome = "pending";
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
    const resolved: RevisionDispatchResult = expired
      ? { ...result, outcome: "permanent", code: "CONVERGENCE_DEADLINE_EXCEEDED" }
      : result;
    let activated: Readonly<AgentRevision> | undefined;
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
      if (resolved.supersededBy !== undefined && resolved.outcome === "success") {
        await this.appendRevisionSuperseded(unit, claim, resolved.supersededBy);
      } else if (resolved.revision !== undefined && resolved.outcome === "success") {
        const current = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
        if (
          current === undefined ||
          current.servicePrincipalId !== resolved.revision.servicePrincipalId ||
          current.activeRevisionId !== resolved.expectedActiveRevisionId
        ) {
          await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
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
          return;
        }
        activated = resolved.revision;
        return;
      } else if (resolved.decision !== undefined) {
        await this.appendRevisionDenial(unit, claim, resolved);
      }

      if (resolved.outcome === "success") await queue.complete(claim);
      else if (resolved.outcome === "pending") await queue.defer(claim, { code: resolved.code });
      else if (resolved.outcome === "permanent" || claim.attemptCount >= this.maxAttempts)
        await queue.fail(claim, { code: resolved.code });
      else await queue.retry(claim, { code: resolved.code });
    }, this.queueOptions);
    const compute = this.compute;
    if (activated !== undefined) {
      try {
        if (this.shouldActivateAfterCommit(compute)) {
          await this.withClaimHeartbeat(claim, () =>
            this.stagedRevision("activateRevision", activated!, resolved.context),
          );
        }
        if (resolved.previous !== undefined) {
          await this.withClaimHeartbeat(claim, () => compute.retireRevision(resolved.previous!));
        }
      } catch (error) {
        if (error instanceof WorkClaimLostError) throw error;
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

  private async completeActivatedRevision(
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const revision = result.revision;
    if (revision === undefined) throw new Error("The activated Agent revision is unavailable.");
    let completed = false;
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
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
      await this.appendRevisionObservation(unit, claim, result);
      await queue.complete(claim);
      if (this.maintenanceIntervalMs !== undefined)
        await this.enqueueMaintenance(queue, claim, revision);
      completed = true;
    }, this.queueOptions);
    if (!completed) return;
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
  ): Promise<void> {
    if (
      this.maintenanceIntervalMs === undefined ||
      !claim.idempotencyKey.startsWith(`agent_revision:${revision.id}:maintenance:`)
    ) {
      await this.finalizeRevision(claim, { outcome: "pending", code });
      return;
    }
    await this.state.transactWithQueue(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
      const agent = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
      if (
        agent === undefined ||
        agent.servicePrincipalId !== revision.servicePrincipalId ||
        agent.activeRevisionId !== revision.id
      ) {
        await queue.complete(claim);
        return;
      }
      // Keep each failed observation bounded without permanently abandoning
      // an authorized active runtime after one prolonged provider outage.
      await queue.fail(claim, { code });
      await this.enqueueMaintenance(queue, claim, revision);
    }, this.queueOptions);
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
    const interval = this.maintenanceIntervalMs!;
    const availableAt = new Date(Date.now() + interval);
    const maintenanceBucket = Math.floor(availableAt.getTime() / interval);
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
    if (installation === undefined || revision === undefined)
      throw new Error("The worker revision activation is unavailable.");
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
    if (installation === undefined || claim.revisionId === undefined)
      throw new Error("The worker superseded revision is unavailable.");
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
    if (installation === undefined || claim.agentId === undefined)
      throw new Error("The worker revision authorization is unavailable.");
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
      if ((await queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
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
        if (claim.namespaceTarget === "ready" && resolved.outcome === "success")
          await unit.namespaces.transitionNamespaceStatus(current.id, "provisioning", "ready");
        else if (
          claim.namespaceTarget === "ready" &&
          (resolved.outcome === "permanent" || exhausted)
        )
          await unit.namespaces.transitionNamespaceStatus(current.id, "provisioning", "failed");
        else if (claim.namespaceTarget === "deleted" && resolved.outcome === "success")
          await unit.namespaces.markNamespaceDeleted(current.id, new Date().toISOString());

        if (resolved.decision !== undefined)
          await this.appendDenial(unit, claim, current, resolved);
        else if (resolved.observation !== undefined)
          await this.appendObservation(unit, claim, current, resolved);
      }

      if (resolved.outcome === "success") await queue.complete(claim);
      else if (resolved.outcome === "pending") await queue.defer(claim, { code: resolved.code });
      else if (resolved.outcome === "permanent" || claim.attemptCount >= this.maxAttempts)
        await queue.fail(claim, { code: resolved.code });
      else await queue.retry(claim, { code: resolved.code });
    }, this.queueOptions);
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
    if (installation === undefined) throw new Error("The worker Installation is unavailable.");
    const observation = result.observation;
    if (observation === undefined) return;
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
    if (installation === undefined) throw new Error("The worker Installation is unavailable.");
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
