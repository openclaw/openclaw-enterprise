import { AsyncLocalStorage } from "node:async_hooks";

import {
  isName,
  isSecretHarnessAuth,
  validPluginDriverIdentity,
  type Agent,
  type AgentRevision,
  type AgentNetworkProxy,
  type BackendRef,
  type ComputeDriver,
  type Configuration,
  type ConfigurationDriver,
  type CredentialSourceReference,
  type HarnessAuthBinding,
  type Namespace,
  type PluginApprovers,
  type PluginDesiredSelection,
  type RepositoryBindingRequest,
  type SecretBindings,
  type SecretReference,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import type { AgentCredentialAccess } from "./agent-credential-access.ts";
import type { HarnessResolver } from "./agent-harness-topology.ts";
import { normalizeAgentPluginApprovers, normalizeAgentPlugins } from "./agent-plugin-validation.ts";
import {
  runtimeCredentialOperation,
  runtimeCredentialStatus,
  type AgentRuntimeCredentials,
} from "./agent-runtime-credentials.ts";
import type { ConfigurationOperations } from "./configuration-operations.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  controllerWorkDeploymentStatus,
  deploymentErrorForWork,
} from "./deployment-work-status.ts";
import { driverOperation } from "./driver-operation.ts";
import type { IAMPolicyOperations } from "./iam-policy-operations.ts";
import { normalizedRepositoryAccess } from "./repository-credential-validation.ts";
import type { createRepositoryPolicyOperations } from "./repository-policy.ts";
import { lockNamespace } from "./resource-scope.ts";
import type { createProvisioningRequests } from "./agent-provisioning-requests.ts";
import {
  normalizeProvisioningWorkspace,
  PROVISIONING_DEPLOYMENT_PENDING,
  parseProvisioningPlan,
} from "./agent-provisioning.ts";
import type { ClaimedWork } from "./controller-work.ts";
import {
  AGENT_NAME_CONFLICT,
  AgentDeletingError,
  AuditAppendUnavailableError,
  AuthorizationDeniedError,
  ComputeGatewaySettingError,
  ComputeProvisioningRefusedError,
  ComputeRepositoryCredentialsUnsupportedError,
  ConfigurationHarnessError,
  CredentialProxyAdmissionError,
  CredentialProxyRepositoryOnlyError,
  CredentialSourceUnprotectedError,
  DependencyUnavailableError,
  ModelProviderSettingError,
  NamespaceNotReadyError,
  NativeWorkerSupportError,
  PluginPolicyValidationError,
  RepositoryBindingSelectionError,
  RepositoryDriverNotConfiguredError,
  ResourceConflictError,
  ResourceStateConflictError,
  SavedRepositorySelectionError,
  ScopeViolationError,
  SecretDriverOwnershipError,
  ServiceAccountBackendBindingError,
  ServiceAccountDriverNotConfiguredError,
  WorkClaimLostError,
  PostgresCommitOutcomeUnknownError,
} from "./errors.ts";
import type {
  AgentProvisioningCheckpoint,
  AgentProvisioningRecord,
  ProvisioningEffectReceipt,
  ProvisioningEffectTarget,
} from "./ports/agent-provisioning.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import {
  provisioningEffectReceipt as readProvisioningEffectReceipt,
  provisioningPendingEffect,
  settleProvisioningEffect as buildProvisioningEffectSettlement,
  unrecordedProvisioningConfiguration as readUnrecordedProvisioningConfiguration,
  withUnrecordedProvisioningConfiguration,
  withoutUnrecordedProvisioningConfiguration,
} from "./provisioning-effects.ts";

export type AgentProvisioningWorkerOutcome =
  | { readonly outcome: "succeeded"; readonly revisionId: string }
  | {
      /** `pending` waits out a settle window without spending an attempt. */
      readonly outcome: "retry" | "permanent" | "pending";
      readonly code: string;
      /** A Compute refusal's reason for the operator log; status keeps the fixed text. */
      readonly reason?: string;
      /**
       * For the operator log: a Configuration the refused job wrote but never recorded, which
       * its Driver could not delete. Nothing references it any more.
       */
      readonly orphanedConfigurationId?: string;
    };

export interface AgentProvisioningWorkerOptions {
  readonly runEffect?: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}

/**
 * How long after a provisioning Configuration create was recorded an absent Configuration may
 * still be a late create in flight (finding 911). The Kubernetes Driver gives up on a write after
 * 10 s, and the API server ends a request it accepted within its request timeout (60 s by
 * default), so a create that has not appeared 90 s after the effect began (database clock) is
 * sent again. A late original then meets an existing ConfigMap and fails AlreadyExists.
 */
const PROVISIONING_CONFIGURATION_SETTLE_MS = 90_000;

/**
 * A pending provisioning Configuration create is not visible yet but may still be in flight, so
 * the attempt defers for the rest of the settle window instead of spending a retry (finding 911).
 */
class ProvisioningConfigurationSettlingError extends DependencyUnavailableError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("The pending Configuration provisioning effect outcome is unknown.");
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The provisioning status message for a worker failure. Only the shared duplicate-name,
 * Compute refusal, Secret Driver ownership, missing ChatGPT Backend, repository and Credential
 * Proxy texts and the
 * plugin-policy, native-support and Configuration Harness refusals pass through; other error
 * messages stay internal. Those refusals name only Installation configuration, the work's own
 * plugin selection and settings in its own Configuration, and HTTP returns them verbatim. The
 * status contract caps `error.message` at 256 characters.
 */
function provisioningFailureMessage(code: string, error: unknown): string {
  if (code === "PROVISIONING_REJECTED") {
    if (
      (error instanceof ResourceStateConflictError && error.message === AGENT_NAME_CONFLICT) ||
      // Fixed, id-free text naming the Credential Proxy refusal (finding 2360).
      error instanceof CredentialProxyRepositoryOnlyError ||
      error instanceof CredentialSourceUnprotectedError ||
      error instanceof ComputeGatewaySettingError ||
      error instanceof ComputeProvisioningRefusedError ||
      // Fixed, id-free text that names the fix (save replacement Secrets, submit a new request).
      error instanceof SecretDriverOwnershipError ||
      // Fixed, id-free texts naming the missing or mismatched ChatGPT Backend.
      error instanceof ServiceAccountDriverNotConfiguredError ||
      error instanceof ServiceAccountBackendBindingError ||
      // Fixed, id-free text naming the missing repository settings (finding 2362).
      error instanceof RepositoryDriverNotConfiguredError ||
      // Fixed, id-free repository and protected admission texts (finding 2536): a Compute
      // Driver without repository credentials, selections the request or the queued work holds
      // that are not (or no longer) approved, and a Credential Proxy that cannot start the Agent.
      error instanceof ComputeRepositoryCredentialsUnsupportedError ||
      error instanceof RepositoryBindingSelectionError ||
      error instanceof SavedRepositorySelectionError ||
      error instanceof CredentialProxyAdmissionError
    ) {
      return error.message;
    }
    if (
      error instanceof PluginPolicyValidationError ||
      error instanceof NativeWorkerSupportError ||
      error instanceof ConfigurationHarnessError ||
      error instanceof ModelProviderSettingError
    ) {
      // A Configuration refusal can name a submitted key; status stores the message as is.
      const characters = Array.from(error.message.replace(/[\p{Cc}\p{Cf}]|\p{Cs}/gu, "?"));
      return characters.length <= 256
        ? characters.join("")
        : `${characters.slice(0, 255).join("")}…`;
    }
  }
  return "Agent provisioning could not complete.";
}

type RunEffect = NonNullable<AgentProvisioningWorkerOptions["runEffect"]>;

interface ProvisioningWorkerDependencies {
  readonly installationId: () => string;
  readonly now: () => Date;
  readonly timestamp: () => string;
  readonly nextId: (kind: "configuration" | "agent") => string;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authorizeRecord: ReturnType<
    typeof createProvisioningRequests
  >["authorizeProvisioningRecord"];
  readonly bindCreator: IAMPolicyOperations["bindCreator"];
  readonly ensureAgentOperateGrants: AgentCredentialAccess["ensureAgentOperateGrants"];
  readonly backendId: (ref: BackendRef | undefined) => string | null;
  readonly repository: Pick<
    ReturnType<typeof createRepositoryPolicyOperations>,
    "repositoryBindingSelections"
  >;
  readonly hasConfigurationDriver: () => boolean;
  readonly configuration: Pick<ConfigurationOperations, "selectedDriver">;
  readonly runtimeCredentials: Pick<
    AgentRuntimeCredentials,
    "admitAgentRuntimeCredentialProvisioning" | "runtimeCredentialComputeDriver"
  >;
  readonly deploy: (
    principalId: string,
    input: { namespaceId: string; agentId: string },
    resolveHarness: HarnessResolver,
  ) => Promise<Readonly<AgentRevision>>;
}

function provisioningBefore(
  record: Pick<AgentProvisioningRecord, "completedPhase">,
  phase: AgentProvisioningRecord["completedPhase"],
): boolean {
  const order = ["admitted", "configuration", "transport", "handoff"];
  return order.indexOf(record.completedPhase) < order.indexOf(phase);
}

export function createProvisioningWorker(dependencies: ProvisioningWorkerDependencies) {
  const { transactions, configuration: configurations, runtimeCredentials } = dependencies;
  const handoffClaim = new AsyncLocalStorage<ClaimedWork>();

  async function processAgentProvisioning(
    claim: ClaimedWork,
    resolveHarness: HarnessResolver,
    options: AgentProvisioningWorkerOptions = {},
  ): Promise<Readonly<AgentProvisioningWorkerOutcome>> {
    if (!isNonEmptyString(claim.idempotencyKey) || !isNonEmptyString(claim.claimToken)) {
      throw new ScopeViolationError("Agent provisioning requires an exact claimed work item.");
    }
    if (typeof resolveHarness !== "function") {
      throw new DependencyUnavailableError("The selected Harness descriptor is unavailable.");
    }
    const runEffect =
      options.runEffect ??
      (<T>(operation: (signal: AbortSignal) => Promise<T>) =>
        operation(new AbortController().signal));
    let record = await transactions.read((state) =>
      state.provisioning.findByWorkId(claim.idempotencyKey),
    );
    if (record === undefined) {
      return Object.freeze({ outcome: "permanent" as const, code: "PROVISIONING_WORK_NOT_FOUND" });
    }
    if (record.status === "succeeded" && record.revisionId !== undefined) {
      return Object.freeze({ outcome: "succeeded" as const, revisionId: record.revisionId });
    }
    if (record.status === "cancelled") {
      return Object.freeze({ outcome: "permanent" as const, code: "PROVISIONING_CANCELLED" });
    }
    if (record.status === "failed") {
      return Object.freeze({ outcome: "permanent" as const, code: "PROVISIONING_FAILED" });
    }
    try {
      if (record.revisionId !== undefined) {
        return await observeProvisioningDeployment(claim, record);
      }
      // Inspect an external write that an earlier attempt left unsettled before this attempt's
      // first fence, so a permanent refusal fails the work instead of retrying it as an unknown
      // outcome (finding 815). reconcileProvisioningEffect says why that order is safe.
      record = await reconcileProvisioningEffect(record, runEffect);
      record = await checkpointAgentProvisioning(claim, {
        completedPhase: record.completedPhase,
        status: "running",
      });
      if (await deleteMarkedProvisioningConfiguration(record, runEffect)) {
        record = await checkpointAgentProvisioning(claim, {
          completedPhase: record.completedPhase,
          status: "running",
          progress: withoutUnrecordedProvisioningConfiguration(record.progress),
        });
      }
      if (provisioningBefore(record, "configuration")) {
        record = await processAgentProvisioningConfiguration(claim, record, runEffect);
      }
      if (provisioningBefore(record, "transport")) {
        if (record.agentId === undefined) {
          throw new ScopeViolationError("The Agent provisioning record has no Agent.");
        }
        const effect = { kind: "transport" as const, targetId: record.agentId };
        if (provisioningEffectReceipt(record, effect) === undefined) {
          const { namespace, agent, driver } =
            await runtimeCredentials.admitAgentRuntimeCredentialProvisioning(
              record.actorId,
              record.namespaceId,
              record.agentId,
            );
          if (provisioningPendingEffectMatches(record, effect)) {
            await inspectProvisioningTransportEffect(
              claim.idempotencyKey,
              record,
              effect,
              namespace,
              agent,
              driver,
              runEffect,
            );
          } else {
            const pendingTransport = await beginProvisioningEffect(claim, effect);
            await runEffect(async () => {
              const transportResult = await runtimeCredentialOperation(() =>
                driver.provisionAgentRuntimeCredentials!({ namespace, agent }, {}),
              );
              await settleProvisioningEffect(claim.idempotencyKey, pendingTransport, effect);
              return transportResult;
            });
          }
        }
        record = await checkpointAgentProvisioning(claim, {
          completedPhase: "transport",
          status: "running",
          progress: {},
        });
      }
      const revision = await transactions.transact(async (state) => {
        const current = await state.provisioning.findByWorkId(claim.idempotencyKey);
        if (
          current === undefined ||
          current.status === "cancelled" ||
          current.status === "failed" ||
          current.agentId === undefined
        ) {
          throw new ResourceStateConflictError(
            "The Agent provisioning lifecycle changed before handoff.",
          );
        }
        await fenceAgentProvisioning(state, claim);
        const revision = await handoffClaim.run(claim, () =>
          dependencies.deploy(
            current.actorId,
            { namespaceId: current.namespaceId, agentId: current.agentId! },
            resolveHarness,
          ),
        );
        await commitProvisioningCheckpoint(state, claim, {
          completedPhase: "handoff",
          status: "running",
          revisionId: revision.id,
        });
        return revision;
      });
      return await observeProvisioningDeployment(claim, {
        ...record,
        completedPhase: "handoff",
        revisionId: revision.id,
      });
    } catch (error) {
      return recordProvisioningFailure(claim, error);
    }
  }

  async function recordProvisioningFailure(
    claim: ClaimedWork,
    error: unknown,
  ): Promise<Readonly<AgentProvisioningWorkerOutcome>> {
    if (
      error instanceof WorkClaimLostError ||
      error instanceof AuditAppendUnavailableError ||
      error instanceof PostgresCommitOutcomeUnknownError
    ) {
      throw error;
    }
    const observed = await transactions.read((state) =>
      state.provisioning.findByWorkId(claim.idempotencyKey),
    );
    if (observed?.status === "succeeded" && observed.revisionId !== undefined) {
      return Object.freeze({ outcome: "succeeded" as const, revisionId: observed.revisionId });
    }
    if (observed?.status === "cancelled") {
      return Object.freeze({ outcome: "permanent" as const, code: "PROVISIONING_CANCELLED" });
    }
    let code = "PROVISIONING_DEPENDENCY_UNAVAILABLE";
    if (
      observed?.progress.pendingEffect !== undefined &&
      readProvisioningEffectReceipt(observed) === undefined
    ) {
      code = "PROVISIONING_OUTCOME_UNKNOWN";
    } else if (
      // A Secret stored through a Secret Driver the Installation no longer selects is
      // refused the same way on every attempt, as request, status and retry answer it
      // with a fixed 503. A missing or unusable driver stays a retryable outage.
      error instanceof SecretDriverOwnershipError ||
      (!(error instanceof DependencyUnavailableError) &&
        (error instanceof ScopeViolationError ||
          error instanceof ResourceConflictError ||
          error instanceof AuthorizationDeniedError ||
          error instanceof AgentDeletingError ||
          error instanceof NamespaceNotReadyError ||
          // An Installation change (Plugin Driver, runtime image) refuses the stored plan
          // the same way on every attempt, as HTTP retry does with a 400. A Compute plan
          // refusal arrives as a ResourceConflictError (409) and is rejected the same way.
          error instanceof PluginPolicyValidationError ||
          error instanceof NativeWorkerSupportError ||
          // Deployment refuses a model provider setting a rule tightened after the request
          // was queued; every attempt would (finding 1549).
          error instanceof ModelProviderSettingError))
    ) {
      code = "PROVISIONING_REJECTED";
    }
    const deferMs =
      error instanceof ProvisioningConfigurationSettlingError ? error.retryAfterMs : undefined;
    const disposition =
      deferMs !== undefined && code === "PROVISIONING_OUTCOME_UNKNOWN"
        ? "defer"
        : code === "PROVISIONING_DEPENDENCY_UNAVAILABLE" || code === "PROVISIONING_OUTCOME_UNKNOWN"
          ? "retry"
          : "permanent";
    const authorizationDenied =
      error instanceof AuthorizationDeniedError && !(error instanceof DependencyUnavailableError);
    const message = provisioningFailureMessage(code, error);
    // A refusal deletes the Configuration it wrote but never recorded. The job first forgets
    // the write and marks it for deletion, under its claim, so neither a retry nor a crash can
    // trust a receipt for a deleted document; the refusal then drops the mark only once the
    // delete has succeeded. A delete that fails, or never runs, leaves the mark: the next
    // attempt deletes it before writing another, and a refusal deletes it too (finding 1399).
    const unrecorded =
      disposition === "permanent"
        ? await transactions.transact(async (state) => {
            const current = await state.provisioning.findByWorkId(claim.idempotencyKey);
            if (current === undefined) {
              throw new WorkClaimLostError();
            }
            const written = await unrecordedProvisioningConfiguration(state, current);
            if (written === undefined) {
              return markedProvisioningConfiguration(state, current);
            }
            await commitProvisioningCheckpoint(state, claim, {
              completedPhase: current.completedPhase,
              status: "running",
              progress: withUnrecordedProvisioningConfiguration(current.progress, written.id),
            });
            return provisioningConfiguration(current, written.id);
          })
        : undefined;
    const orphanedConfigurationId =
      unrecorded === undefined
        ? undefined
        : await deleteUnrecordedProvisioningConfiguration(unrecorded);
    await transactions.transact(async (state) => {
      const current = await state.provisioning.findByWorkId(claim.idempotencyKey);
      if (current === undefined) {
        throw new WorkClaimLostError();
      }
      await state.provisioning.recordFailure(
        claim,
        {
          completedPhase: current.completedPhase,
          progress: {
            ...(unrecorded !== undefined && orphanedConfigurationId === undefined
              ? withoutUnrecordedProvisioningConfiguration(current.progress)
              : current.progress),
            error: { code, message },
          },
        },
        disposition === "defer"
          ? { disposition, code, message, delayMs: deferMs! }
          : { disposition, code, message },
      );
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId: dependencies.installationId(),
        namespaceId: current.namespaceId,
        occurredAt: dependencies.timestamp(),
        kind: authorizationDenied ? "authorization_denial" : "mutation",
        actorId: current.actorId,
        source: "occ",
        action: "openclaw.agents.provision.failure",
        resource: {
          kind: "agent",
          namespaceId: current.namespaceId,
          id: current.agentId ?? current.workId,
        },
        outcome: authorizationDenied ? "denied" : "failure",
        ...(authorizationDenied
          ? {
              reasonCode: "AUTHORIZATION_DENIED",
              ...(error.authorization === undefined
                ? {}
                : { authorization: { principalId: current.actorId, ...error.authorization } }),
            }
          : {}),
        details: { workId: current.workId, phase: current.completedPhase, code },
      });
    });
    return Object.freeze({
      outcome: disposition === "defer" ? ("pending" as const) : disposition,
      code,
      ...(error instanceof ComputeProvisioningRefusedError ? { reason: error.reason } : {}),
      ...(orphanedConfigurationId === undefined ? {} : { orphanedConfigurationId }),
    });
  }

  async function observeProvisioningDeployment(
    claim: ClaimedWork,
    record: Readonly<AgentProvisioningRecord>,
  ): Promise<Readonly<AgentProvisioningWorkerOutcome>> {
    const revisionId = record.revisionId;
    if (revisionId === undefined) {
      throw new ScopeViolationError("The initial deployment revision is unavailable.");
    }
    return transactions.transact(async (state) => {
      const work = await state.operations.findWork(`agent_revision:${revisionId}:reconcile`);
      if (
        work === undefined ||
        work.namespaceId !== record.namespaceId ||
        work.agentId !== record.agentId ||
        work.revisionId !== revisionId
      ) {
        throw new DependencyUnavailableError("The initial deployment work is unavailable.");
      }
      const status = controllerWorkDeploymentStatus(work, dependencies.now());
      if (status === "succeeded") {
        await commitProvisioningCheckpoint(state, claim, {
          completedPhase: "handoff",
          status: "succeeded",
          revisionId,
          progress: {},
        });
        return Object.freeze({ outcome: "succeeded" as const, revisionId });
      }
      const deploymentError = deploymentErrorForWork(work);
      // Stopping the first rollout is the owner's choice, not a fault to correct.
      const error =
        deploymentError?.code === "REVISION_STOPPED"
          ? Object.freeze({
              code: "REVISION_STOPPED",
              message: "The Agent was stopped before its first deployment finished.",
            })
          : deploymentError;
      const pending = status !== "failed";
      const code = pending
        ? PROVISIONING_DEPLOYMENT_PENDING
        : (error?.code ?? "PROVISIONING_DEPLOYMENT_FAILED");
      const message = pending
        ? "Waiting for the initial deployment to complete."
        : (error?.message ?? "The initial deployment failed.");
      await state.provisioning.recordFailure(
        claim,
        {
          completedPhase: "handoff",
          revisionId,
          progress: { ...record.progress, ...(error === null ? {} : { error }) },
        },
        pending
          ? { disposition: "defer", code, message, delayMs: 1000 }
          : { disposition: "permanent", code, message },
      );
      if (!pending) {
        await state.audit.append({
          id: `aud_${crypto.randomUUID()}`,
          installationId: dependencies.installationId(),
          namespaceId: record.namespaceId,
          occurredAt: dependencies.timestamp(),
          kind: "mutation",
          actorId: record.actorId,
          source: "occ",
          action: "openclaw.agents.provision.failure",
          resource: { kind: "agent", namespaceId: record.namespaceId, id: record.agentId! },
          outcome: "failure",
          details: { workId: record.workId, phase: "handoff", revisionId, code },
        });
      }
      return Object.freeze({
        outcome: pending ? ("pending" as const) : ("permanent" as const),
        code,
      });
    });
  }

  async function checkpointAgentProvisioning(
    claim: ClaimedWork,
    checkpoint: AgentProvisioningCheckpoint,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    return transactions.transact(async (state) => {
      await fenceAgentProvisioning(state, claim);
      return commitProvisioningCheckpoint(state, claim, checkpoint);
    });
  }

  async function commitProvisioningCheckpoint(
    state: PlatformUnitOfWork,
    claim: ClaimedWork,
    checkpoint: AgentProvisioningCheckpoint,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const record = await state.provisioning.checkpoint(claim, checkpoint);
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: dependencies.installationId(),
      namespaceId: record.namespaceId,
      occurredAt: dependencies.timestamp(),
      kind: "mutation",
      actorId: record.actorId,
      source: "occ",
      action: "openclaw.agents.provision.checkpoint",
      resource: {
        kind: "agent",
        namespaceId: record.namespaceId,
        id: record.agentId ?? record.namespaceId,
      },
      outcome: "success",
      details: {
        workId: record.workId,
        phase: record.completedPhase,
        ...(record.revisionId === undefined ? {} : { revisionId: record.revisionId }),
      },
    });
    return record;
  }

  async function fenceAgentProvisioning(
    state: PlatformUnitOfWork,
    claim: ClaimedWork,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const record = await state.provisioning.findByWorkId(claim.idempotencyKey);
    if (record === undefined) {
      throw new WorkClaimLostError();
    }
    // Hold the IAM configuration lock so a configuration change that revokes the requester's
    // Group binding commits before this check or after the Owner bindings provisioning writes.
    // Take it before the Namespace lock: applying the configuration holds it exclusively and
    // then locks each Namespace it writes a configured binding into.
    await state.installations.holdIAMConfiguration("shared");
    const namespace = await lockNamespace(state, record.namespaceId);
    if (namespace.status !== "ready") {
      throw new NamespaceNotReadyError();
    }
    if (record.agentId !== undefined) {
      const agent = await state.agents.lockAgent(namespace.id, record.agentId);
      if (
        agent === undefined ||
        agent.status !== "active" ||
        agent.desiredRuntimeState !== "stopped"
      ) {
        throw new ResourceStateConflictError("The Agent lifecycle changed during provisioning.");
      }
    }
    await dependencies.authorizeRecord(state, record.actorId, record);
    return state.provisioning.checkpoint(claim, {
      completedPhase: record.completedPhase,
      status: "running",
    });
  }

  async function beginProvisioningEffect(
    claim: ClaimedWork,
    effect: ProvisioningEffectTarget,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    return transactions.transact(async (state) => {
      await fenceAgentProvisioning(state, claim);
      return state.provisioning.beginEffect(claim, effect);
    });
  }

  async function settleProvisioningEffect(
    workId: string,
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const pending = provisioningPendingEffect(record);
    if (pending?.owner === undefined) {
      throw new ResourceConflictError("The Agent provisioning effect owner is unavailable.");
    }
    const progress = buildProvisioningEffectSettlement(record, {
      ...effect,
      owner: pending.owner,
    });
    const receipt = progress.effectReceipt;
    if (
      receipt === undefined ||
      receipt === null ||
      typeof receipt !== "object" ||
      Array.isArray(receipt)
    ) {
      throw new ResourceConflictError("The Agent provisioning effect receipt is invalid.");
    }
    return transactions.transact((state) =>
      state.provisioning.settleEffect(workId, receipt as ProvisioningEffectReceipt),
    );
  }

  function provisioningEffectReceipt(
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget,
  ): ProvisioningEffectReceipt | undefined {
    const receipt = readProvisioningEffectReceipt(record);
    if (receipt === undefined || receipt.kind !== effect.kind) {
      return undefined;
    }
    if (effect.targetId !== undefined && receipt.targetId !== effect.targetId) {
      return undefined;
    }
    return receipt;
  }

  function provisioningPendingEffectMatches(
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget,
  ): boolean {
    const pending = provisioningPendingEffect(record);
    if (
      pending === undefined ||
      !pending.targetMatches ||
      !pending.ownerPresent ||
      pending.kind !== effect.kind
    ) {
      return false;
    }
    return effect.targetId === undefined || pending.targetId === effect.targetId;
  }

  /** Settles the pending Configuration create once observed; undefined while it is absent. */
  async function inspectProvisioningConfigurationEffect(
    workId: string,
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget & { readonly kind: "configuration" },
    configuration: Configuration,
    driver: ConfigurationDriver,
    runEffect: RunEffect,
  ): Promise<Readonly<AgentProvisioningRecord> | undefined> {
    if (!provisioningPendingEffectMatches(record, effect)) {
      throw new DependencyUnavailableError(
        "The pending Configuration provisioning effect outcome is unknown.",
      );
    }
    if (driver.inspectExact === undefined) {
      throw new DependencyUnavailableError(
        "The Configuration Driver does not support exact provisioning recovery.",
      );
    }
    return runEffect(async () => {
      const recovered = await driverOperation(() => driver.inspectExact!(configuration));
      return recovered === undefined ? undefined : settleProvisioningEffect(workId, record, effect);
    });
  }

  /**
   * Sends a pending Configuration create again when it is still absent after its settle window
   * (finding 911): a create that never reached the API server is otherwise never resent, and the
   * work retries as an unknown outcome until attempts run out. Inside the window the attempt
   * defers without spending a retry. The resend keeps the pending effect, its owner and target,
   * so the Namespace still waits for it; it follows a fresh fence, as the first send did, and
   * writes the same deterministic Configuration with create-if-absent semantics. If it fails
   * (AlreadyExists, or a lost response), an earlier send may have landed after all: the exact
   * inspection, which checks identity, generation, creation time and values, decides whether
   * the effect settles, and a conflict it reports replaces the create's error. The window is
   * measured from the first send only (the pending effect cannot be replaced), so a later
   * attempt resends at once and relies on create-if-absent and that inspection alone. An effect
   * recorded before its start was stamped keeps waiting.
   */
  async function resendProvisioningConfigurationEffect(
    claim: ClaimedWork,
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget & { readonly kind: "configuration" },
    configuration: Configuration,
    driver: ConfigurationDriver,
    runEffect: RunEffect,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const startedAt = provisioningPendingEffect(record)?.startedAt;
    if (startedAt === undefined) {
      throw new DependencyUnavailableError(
        "The pending Configuration provisioning effect outcome is unknown.",
      );
    }
    // The fence stamps updated_at on the database clock, the clock that stamped startedAt.
    const fenced = await transactions.transact((state) => fenceAgentProvisioning(state, claim));
    if (!provisioningPendingEffectMatches(fenced, effect)) {
      throw new DependencyUnavailableError(
        "The pending Configuration provisioning effect outcome is unknown.",
      );
    }
    const remainingMs =
      startedAt.getTime() + PROVISIONING_CONFIGURATION_SETTLE_MS - fenced.updatedAt.getTime();
    if (remainingMs > 0) {
      throw new ProvisioningConfigurationSettlingError(
        Math.min(Math.ceil(remainingMs), PROVISIONING_CONFIGURATION_SETTLE_MS),
      );
    }
    return runEffect(async () => {
      try {
        await driverOperation(() => driver.createExact!(configuration));
      } catch (error) {
        const landed = await driverOperation(() => driver.inspectExact!(configuration));
        if (landed === undefined) {
          throw error;
        }
      }
      return settleProvisioningEffect(claim.idempotencyKey, fenced, effect);
    });
  }

  async function inspectProvisioningTransportEffect(
    workId: string,
    record: Readonly<AgentProvisioningRecord>,
    effect: ProvisioningEffectTarget & { readonly kind: "transport" },
    namespace: Readonly<Namespace>,
    agent: Readonly<Agent>,
    driver: ComputeDriver,
    runEffect: RunEffect,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    if (!provisioningPendingEffectMatches(record, effect)) {
      throw new DependencyUnavailableError(
        "The pending transport provisioning effect outcome is unknown.",
      );
    }
    if (driver.getAgentRuntimeCredentialStatus === undefined) {
      throw new DependencyUnavailableError(
        "The Compute Driver does not support exact provisioning recovery.",
      );
    }
    return runEffect(async () => {
      const status = await runtimeCredentialOperation(() =>
        driver.getAgentRuntimeCredentialStatus!({ namespace, agent }),
      );
      if (!runtimeCredentialStatus(status).transportConfigured) {
        throw new DependencyUnavailableError(
          "The pending transport provisioning effect outcome is unknown.",
        );
      }
      return settleProvisioningEffect(workId, record, effect);
    });
  }

  /**
   * The Configuration a failing job wrote through its Driver but never recorded (finding 1395).
   * The write settled, then the Configuration step's transaction refused (a duplicate Agent name,
   * for example) and rolled back the record, or a later fence refused the job before that step
   * ran again. Nothing else deletes that document. A write that has not settled, a job past its
   * Configuration step, a Configuration record with the ID, or a write made through a Driver the
   * Installation no longer selects leaves it alone.
   */
  async function unrecordedProvisioningConfiguration(
    state: PlatformUnitOfWork,
    record: Readonly<AgentProvisioningRecord>,
  ): Promise<Readonly<{ id: string; namespaceId: string }> | undefined> {
    if (!provisioningBefore(record, "configuration") || record.configurationId !== undefined) {
      return undefined;
    }
    const receipt = readProvisioningEffectReceipt(record);
    const pending = provisioningPendingEffect(record);
    if (
      receipt?.kind !== "configuration" ||
      pending?.kind !== "configuration" ||
      pending.owner !== receipt.owner ||
      pending.targetId !== receipt.targetId ||
      !provisioningConfigurationDriverSelected(record)
    ) {
      return undefined;
    }
    if (
      (await state.configurations.findConfiguration(record.namespaceId, receipt.targetId)) !==
      undefined
    ) {
      return undefined;
    }
    return Object.freeze({ id: receipt.targetId, namespaceId: record.namespaceId });
  }

  /** Whether the accepted plan names the Configuration Driver the Installation selects. */
  function provisioningConfigurationDriverSelected(
    record: Readonly<AgentProvisioningRecord>,
  ): boolean {
    return (
      dependencies.hasConfigurationDriver() &&
      asRecord(record.plan.drivers)?.configuration === configurations.selectedDriver().id
    );
  }

  /**
   * The Configuration an earlier refusal of this job marked for deletion but did not finish
   * deleting: its delete failed, or the worker lost its claim first (finding 1399). A
   * Configuration record with the ID, or a Driver the accepted plan no longer names, leaves it
   * alone.
   */
  async function markedProvisioningConfiguration(
    state: PlatformReadView,
    record: Readonly<AgentProvisioningRecord>,
  ): Promise<Configuration | undefined> {
    const configurationId = readUnrecordedProvisioningConfiguration(record.progress);
    if (
      configurationId === undefined ||
      !provisioningConfigurationDriverSelected(record) ||
      (await state.configurations.findConfiguration(record.namespaceId, configurationId)) !==
        undefined
    ) {
      return undefined;
    }
    return provisioningConfiguration(record, configurationId);
  }

  /**
   * Deletes a Configuration the job wrote but never recorded, through the Driver call
   * Configuration deletion uses. Nothing references it: the job forgot it when it marked it, and
   * its ID is unique to the job. It is inspected first, so a document already gone (an applied
   * delete whose response was lost) is not an error.
   */
  async function removeUnrecordedProvisioningConfiguration(
    configuration: Configuration,
  ): Promise<void> {
    const driver = configurations.selectedDriver();
    if (driver.inspectExact === undefined) {
      throw new DependencyUnavailableError(
        "The Configuration Driver does not support exact provisioning recovery.",
      );
    }
    if ((await driverOperation(() => driver.inspectExact!(configuration))) !== undefined) {
      await driverOperation(() =>
        driver.delete({ id: configuration.id, namespaceId: configuration.namespaceId }),
      );
    }
  }

  /**
   * A refusal's delete of its unrecorded or marked Configuration, once the mark has committed.
   * A failed delete keeps the refusal as it is, leaves the mark, and returns the ID for the
   * operator log.
   */
  async function deleteUnrecordedProvisioningConfiguration(
    configuration: Configuration,
  ): Promise<string | undefined> {
    try {
      await removeUnrecordedProvisioningConfiguration(configuration);
      return undefined;
    } catch {
      return configuration.id;
    }
  }

  /**
   * Deletes the marked Configuration after this attempt's first fence and before it writes
   * another, so the mark is never dropped with the document still stored. A failed delete fails
   * the attempt and keeps the mark. Returns whether the job had a mark to drop.
   */
  async function deleteMarkedProvisioningConfiguration(
    record: Readonly<AgentProvisioningRecord>,
    runEffect: RunEffect,
  ): Promise<boolean> {
    if (readUnrecordedProvisioningConfiguration(record.progress) === undefined) {
      return false;
    }
    if (!provisioningConfigurationDriverSelected(record)) {
      // The fence refuses this first; never let a new write replace the mark.
      throw new DependencyUnavailableError("The selected Configuration Driver is unavailable.");
    }
    const marked = await transactions.read((state) =>
      markedProvisioningConfiguration(state, record),
    );
    if (marked !== undefined) {
      await runEffect(() => removeUnrecordedProvisioningConfiguration(marked));
    }
    return true;
  }

  /** The Configuration that provisioning writes through the Configuration Driver. */
  function provisioningConfiguration(
    record: Readonly<AgentProvisioningRecord>,
    configurationId: string,
  ): Configuration {
    const plan = parseProvisioningPlan(record);
    return {
      id: configurationId,
      namespaceId: record.namespaceId,
      kind: "agent",
      generation: 1,
      values: plan.configuration.values,
      ...(plan.configuration.secretBindings === undefined
        ? {}
        : { secretBindings: plan.configuration.secretBindings }),
      createdAt: record.createdAt.toISOString(),
    };
  }

  /**
   * Settles the external write that an earlier attempt dispatched but did not record, by
   * inspecting its exact target, before this attempt's first fence. A fence that then refuses
   * the work for good (plugin policy, native worker support, Secret Driver ownership, a
   * lifecycle or authority change) fails it as rejected with its own message, instead of
   * retrying it as PROVISIONING_OUTCOME_UNKNOWN until attempts run out. A settled effect also
   * stops holding the Namespace, which waits for unsettled ones before it can be deleted.
   *
   * Inspecting before the fence is safe: the earlier attempt dispatched the write only after its
   * own fence passed; this reads only the target it recorded, through the Driver the accepted
   * plan names (another selected Driver is left to the fence, which then retries the work); and
   * settling records what it observed for that exact pending kind, owner and target (a pending
   * effect replaced meanwhile settles nothing), as Agent deletion does for cancelled work.
   * Nothing is written outside OCC before the fence. A write it cannot observe stays pending for
   * the fenced step: a transport write retries, and a Configuration create may be resent after
   * its settle window. Other work, and work whose effect is already settled, is unchanged.
   */
  async function reconcileProvisioningEffect(
    record: Readonly<AgentProvisioningRecord>,
    runEffect: RunEffect,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const pending = provisioningPendingEffect(record);
    if (
      pending === undefined ||
      !provisioningPendingEffectMatches(record, pending) ||
      provisioningEffectReceipt(record, pending) !== undefined
    ) {
      return record;
    }
    const drivers = asRecord(record.plan.drivers);
    if (pending.kind === "configuration") {
      const driver = configurations.selectedDriver();
      if (drivers?.configuration !== driver.id) {
        return record;
      }
      // An absent write is left to the fenced Configuration step, which may resend it.
      return (
        (await inspectProvisioningConfigurationEffect(
          record.workId,
          record,
          { kind: "configuration", targetId: pending.targetId },
          provisioningConfiguration(record, pending.targetId),
          driver,
          runEffect,
        )) ?? record
      );
    }
    const driver = runtimeCredentials.runtimeCredentialComputeDriver("provision");
    if (drivers?.compute !== driver.id) {
      return record;
    }
    const { namespace, agent } = await transactions.read(async (state) => {
      const namespace = await state.namespaces.findNamespace(record.namespaceId);
      return {
        namespace,
        agent:
          namespace === undefined
            ? undefined
            : await state.agents.findAgent(namespace.id, pending.targetId),
      };
    });
    if (namespace === undefined || agent === undefined) {
      return record;
    }
    return inspectProvisioningTransportEffect(
      record.workId,
      record,
      { kind: "transport", targetId: pending.targetId },
      namespace,
      agent,
      driver,
      runEffect,
    );
  }

  function savedAgentOptions(
    namespaceId: string,
    plan: Readonly<Record<string, unknown>>,
  ): Pick<Agent, "plugins" | "pluginApprovers" | "repositoryBindings" | "repositoryAccess"> {
    const plugins = normalizeAgentPlugins(
      plan.plugins as Readonly<Record<string, PluginDesiredSelection>> | undefined,
    );
    const pluginApprovers = normalizeAgentPluginApprovers(
      plan.pluginApprovers as PluginApprovers | undefined,
    );
    const repositoryBindings = dependencies.repository.repositoryBindingSelections(
      namespaceId,
      plan.repositoryBindings as readonly RepositoryBindingRequest[] | undefined,
      "saved",
    );
    const repositoryAccess = normalizedRepositoryAccess(plan.repositoryAccess, repositoryBindings);
    return {
      ...(plugins === undefined ? {} : { plugins }),
      ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
      ...(repositoryBindings === undefined ? {} : { repositoryBindings }),
      ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
    };
  }

  async function processAgentProvisioningConfiguration(
    claim: ClaimedWork,
    record: Readonly<AgentProvisioningRecord>,
    runEffect: RunEffect,
  ): Promise<Readonly<AgentProvisioningRecord>> {
    const plan = parseProvisioningPlan(record);
    const pending = provisioningPendingEffect(record);
    const receipt = readProvisioningEffectReceipt(record);
    const configurationId =
      record.configurationId ??
      (receipt?.kind === "configuration" ? receipt.targetId : undefined) ??
      (pending?.kind === "configuration" ? pending.targetId : undefined) ??
      dependencies.nextId("configuration");
    const configuration = provisioningConfiguration(record, configurationId);
    const driver = configurations.selectedDriver();
    if (driver.createExact === undefined || driver.inspectExact === undefined) {
      throw new DependencyUnavailableError(
        "The Configuration Driver does not support exact provisioning recovery.",
      );
    }
    const effect = { kind: "configuration" as const, targetId: configurationId };
    if (provisioningEffectReceipt(record, effect) === undefined) {
      const metadata = await transactions.read((state) =>
        state.configurations.findConfiguration(record.namespaceId, configurationId),
      );
      if (metadata === undefined) {
        if (provisioningPendingEffectMatches(record, effect)) {
          const inspected = await inspectProvisioningConfigurationEffect(
            claim.idempotencyKey,
            record,
            effect,
            configuration,
            driver,
            runEffect,
          );
          if (inspected === undefined) {
            await resendProvisioningConfigurationEffect(
              claim,
              record,
              effect,
              configuration,
              driver,
              runEffect,
            );
          }
        } else {
          const started = await beginProvisioningEffect(claim, effect);
          await runEffect(async () => {
            const created = await driverOperation(() => driver.createExact!(configuration));
            await settleProvisioningEffect(claim.idempotencyKey, started, effect);
            return created;
          });
        }
      }
    }

    return transactions.transact(async (state) => {
      const current = await fenceAgentProvisioning(state, claim);
      if (!provisioningBefore(current, "configuration")) {
        return current;
      }
      const namespace = await lockNamespace(state, current.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const planRecord = asRecord(current.plan);
      if (planRecord === undefined) {
        throw new ScopeViolationError("The provisioning plan is invalid.");
      }
      const name = planRecord?.name;
      if (!isName(name)) {
        throw new ScopeViolationError("The provisioning Agent name is invalid.");
      }
      if (plan.harnessAuth === null || plan.harnessAuth.method === "runtime") {
        throw new ScopeViolationError(
          "Agent provisioning requires dedicated Harness authentication.",
        );
      }
      const backendId = dependencies.backendId(planRecord.backendId as BackendRef | undefined);
      const options = savedAgentOptions(namespace.id, planRecord);
      const workspace = normalizeProvisioningWorkspace(
        planRecord.initialWorkspaceFiles,
        planRecord.workspaceDefaultsId,
      );
      const existingMetadata = await state.configurations.lockConfiguration(
        namespace.id,
        configurationId,
      );
      let metadata = existingMetadata;
      if (metadata === undefined) {
        metadata = await state.configurations.createConfiguration({
          id: configurationId,
          namespaceId: namespace.id,
          kind: "agent",
          generation: configuration.generation,
          ...(plan.configuration.secretBindings === undefined
            ? {}
            : { secretBindings: plan.configuration.secretBindings }),
          createdAt: configuration.createdAt,
        });
        // The person who requested provisioning creates its resources and owns them.
        await dependencies.bindCreator(state, record.actorId, {
          kind: "configuration",
          id: metadata.id,
          namespaceId: namespace.id,
        });
      }
      const agentId =
        current.agentId ??
        (isNonEmptyString(planRecord.reservedAgentId)
          ? planRecord.reservedAgentId
          : dependencies.nextId("agent"));
      let agent = await state.agents.lockAgent(namespace.id, agentId);
      const createdAgent = agent === undefined;
      if (agent === undefined) {
        agent = await state.agents.createAgent({
          id: agentId,
          namespaceId: namespace.id,
          name,
          configurationId: metadata.id,
          backendId,
          harnessAuth: plan.harnessAuth,
          // Guided provisioning has one model source; store it in the canonical
          // list so the same binding and withdrawal invariants govern deployment.
          ...(plan.harnessAuth.method === "credential_source"
            ? { credentialSources: [{ sourceId: plan.harnessAuth.sourceId }] }
            : {}),
          executionMode: plan.executionMode,
          gatewayManagedMode: plan.gatewayManagedMode,
          ...(plan.networkProxy === undefined ? {} : { networkProxy: plan.networkProxy }),
          ...options,
          ...(validPluginDriverIdentity(planRecord.pluginDriver)
            ? { pluginDriver: planRecord.pluginDriver }
            : {}),
          servicePrincipalId: `service-agent-${agentId}`,
          desiredRuntimeState: "stopped",
          status: "active",
          createdAt: dependencies.timestamp(),
        });
        await dependencies.bindCreator(state, record.actorId, {
          kind: "agent",
          id: agent.id,
          namespaceId: namespace.id,
        });
      }
      if (createdAgent && workspace.initialWorkspaceFiles !== undefined) {
        await state.workspaceSetups.create({
          id: crypto.randomUUID(),
          namespaceId: namespace.id,
          agentId,
          ...(workspace.workspaceDefaultsId === undefined
            ? {}
            : { defaultsId: workspace.workspaceDefaultsId }),
          files: workspace.initialWorkspaceFiles,
          completed: false,
        });
      }
      const grantSources = await provisioningGrantSources(state, namespace.id, {
        ...(plan.configuration.secretBindings === undefined
          ? {}
          : { secretBindings: plan.configuration.secretBindings }),
        harnessAuth: plan.harnessAuth,
        ...(plan.networkProxy === undefined ? {} : { networkProxy: plan.networkProxy }),
      });
      await dependencies.ensureAgentOperateGrants(state, namespace.id, agent, grantSources);
      return commitProvisioningCheckpoint(state, claim, {
        completedPhase: "configuration",
        status: "running",
        agentId,
        configurationId: metadata.id,
        progress: {},
      });
    });
  }

  /** Callers hold the Namespace lock. */
  async function guardAgentProvisioning(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agentId: string,
    allowHandoff = false,
  ): Promise<void> {
    const record = await state.provisioning.findByAgent(namespaceId, agentId);
    if (record === undefined || record.revisionId !== undefined) {
      return;
    }
    if (
      allowHandoff &&
      handoffClaim.getStore()?.idempotencyKey === record.workId &&
      record.status === "running"
    ) {
      return;
    }
    if (
      record.status === "queued" ||
      record.status === "running" ||
      provisioningBefore(record, "configuration") ||
      (record.status === "failed" && record.revisionId === undefined)
    ) {
      throw new ResourceStateConflictError(
        "The Agent is reserved for provisioning. Stop or delete it, or retry its failed provisioning request.",
      );
    }
    if (record.status === "cancelled" && provisioningHasUnresolvedEffect(record)) {
      await settleAbandonedProvisioningEffect(state, namespaceId, agentId);
    }
  }

  /**
   * A cancelled job never runs again, so nothing else settles the runtime-credential write it
   * left pending, and without this its stopped Agent could only be deleted (finding 1384). Once
   * the claim that began the write has lapsed (at once if no worker held it when Stop cancelled
   * the job), its worker has stopped issuing requests, so this settles it under the Namespace and
   * Agent locks, as Agent deletion does. A request already sent may still land; that is safe
   * because the write creates only absent Secrets, and deploy admission checks the runtime
   * credentials and creates missing ones. Inside the lease the Agent stays reserved; with
   * conflicting or malformed evidence it can only be deleted.
   */
  async function settleAbandonedProvisioningEffect(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agentId: string,
  ): Promise<void> {
    const agent = await state.agents.lockAgent(namespaceId, agentId);
    if (agent?.status !== "active") {
      throw new AgentDeletingError();
    }
    const current =
      (await state.provisioning.settleAbandonedEffect(namespaceId, agentId)) ??
      (await state.provisioning.findByAgent(namespaceId, agentId));
    if (
      current === undefined ||
      current.revisionId !== undefined ||
      !provisioningHasUnresolvedEffect(current)
    ) {
      return;
    }
    const pending = provisioningPendingEffect(current);
    // Only a well-formed write still inside its cancelled claim's lease settles by waiting.
    if (
      pending?.kind === "transport" &&
      pending.ownerPresent &&
      current.progress.effectReceipt === undefined &&
      current.progress.cancelledClaimExpiresAt !== undefined
    ) {
      throw new ResourceStateConflictError(
        "The Agent's cancelled provisioning may still be writing its runtime credentials. Try again in a few seconds, or delete the Agent.",
      );
    }
    throw new ResourceStateConflictError(
      "The Agent's cancelled provisioning left a runtime-credential write that cannot be settled. Delete the Agent.",
    );
  }

  async function guardProvisioningConfiguration(
    state: PlatformReadView,
    namespaceId: string,
    configurationId: string,
    readOnly = false,
  ): Promise<void> {
    const record = await state.provisioning.findByConfiguration(namespaceId, configurationId);
    if (
      record !== undefined &&
      record.revisionId === undefined &&
      (readOnly
        ? provisioningBefore(record, "configuration")
        : provisioningBefore(record, "configuration") ||
          record.status === "queued" ||
          record.status === "running" ||
          (record.status === "failed" && record.revisionId === undefined) ||
          (record.status === "cancelled" && provisioningHasUnresolvedEffect(record)))
    ) {
      throw new ResourceStateConflictError(
        "The Configuration is reserved for provisioning and is not available for this operation.",
      );
    }
  }

  function provisioningHasUnresolvedEffect(record: Readonly<AgentProvisioningRecord>): boolean {
    const hasRawPending = record.progress.pendingEffect !== undefined;
    const hasRawReceipt = record.progress.effectReceipt !== undefined;
    if (!hasRawPending && !hasRawReceipt) {
      return false;
    }
    const pending = provisioningPendingEffect(record);
    const receipt = readProvisioningEffectReceipt(record);
    // Malformed effect evidence stays fail-closed because the worker cannot prove
    // whether an external write completed.
    if ((hasRawPending && pending === undefined) || (hasRawReceipt && receipt === undefined)) {
      return true;
    }
    if (pending === undefined) {
      return false;
    }
    if (!pending.ownerPresent || receipt === undefined) {
      return true;
    }
    return (
      receipt.kind !== pending.kind ||
      receipt.owner !== pending.owner ||
      receipt.targetId !== pending.targetId
    );
  }

  async function provisioningGrantSources(
    state: PlatformUnitOfWork,
    namespaceId: string,
    input: {
      readonly secretBindings?: SecretBindings;
      readonly harnessAuth: HarnessAuthBinding | null;
      readonly networkProxy?: AgentNetworkProxy;
    },
  ): Promise<readonly (SecretReference | CredentialSourceReference)[]> {
    const ids = new Set<string>();
    for (const binding of Object.values(input.secretBindings ?? {})) {
      ids.add(binding.source.id);
    }
    if (isSecretHarnessAuth(input.harnessAuth)) {
      ids.add(input.harnessAuth.source.id);
    }
    if (input.networkProxy?.credentialSecretId !== undefined) {
      ids.add(input.networkProxy.credentialSecretId);
    }
    const sources: (SecretReference | CredentialSourceReference)[] = [];
    for (const id of ids) {
      const secret = await state.secrets.lockSecret(namespaceId, id);
      if (secret === undefined) {
        throw new ScopeViolationError("Agent provisioning Secret grant source is unavailable.");
      }
      sources.push({ kind: "secret", namespaceId, id: secret.id });
    }
    if (input.harnessAuth?.method === "credential_source") {
      const source = await state.credentialSources.lockCredentialSource(
        namespaceId,
        input.harnessAuth.sourceId,
      );
      if (source === undefined || source.state !== "ready") {
        throw new ScopeViolationError("Agent provisioning credential source is unavailable.");
      }
      sources.push({ kind: "credential_source", namespaceId, id: source.id });
    }
    return Object.freeze(sources);
  }

  return { processAgentProvisioning, guardAgentProvisioning, guardProvisioningConfiguration };
}
