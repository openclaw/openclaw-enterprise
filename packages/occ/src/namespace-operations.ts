import {
  isName,
  type ComputeDriver,
  type Namespace,
  type NamespaceDeleteResult,
  type NamespaceEnsureResult,
  type Preset,
  type ResourceKind,
  type ResourceRef,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  DeletionRetryOwnedError,
  DependencyUnavailableError,
  NamespaceNotEmptyError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import { removeNamespacePolicy, removedPolicyDetails } from "./iam-policy-cleanup.ts";
import type { IAMPolicyOperations } from "./iam-policy-operations.ts";
import type { NamespaceLifecycleEvidence } from "./namespace-lifecycle.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { createPresetOperations } from "./preset-operations.ts";
import { exactNamespace, namespaceIdentity } from "./resource-scope.ts";

export const BOOTSTRAP_DEFAULT_NAMESPACE_NAME = "default";

export interface CreateNamespaceInput {
  readonly name: string;
  readonly existingNamespace?: string;
}

/**
 * The IDs of one kind that a NAMESPACE_NOT_EMPTY conflict examines and may name. Each costs
 * one read decision while deletion holds the Namespace lock, so the bound limits that work.
 */
const NAMESPACE_NOT_EMPTY_ID_LIMIT = 20;

type NamespaceOperation = Extract<
  Parameters<PlatformUnitOfWork["operations"]["append"]>[0],
  { readonly kind: "namespace" }
>;

interface NamespaceDependencies {
  readonly installationId: string;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "authorizationAuthority" | "authorizationDecision" | "canRead" | "holdAuthority"
  >;
  readonly iamPolicy: Pick<
    IAMPolicyOperations,
    "bindCreator" | "applyConfiguredPolicy" | "lockNamespaceForPolicyDelete"
  >;
  readonly presets: Pick<
    ReturnType<typeof createPresetOperations>,
    "ensureNamespaceDefaultPresets" | "deletePresetInState" | "isUnmodifiedDefaultPreset"
  >;
  readonly record: (state: PlatformUnitOfWork, operation: NamespaceOperation) => Promise<void>;
  readonly observeLifecycle: (
    namespace: Readonly<Namespace>,
    target: "ready" | "deleted",
    signal: AbortSignal,
    record: (evidence: NamespaceLifecycleEvidence) => void | Promise<void>,
  ) => Promise<NamespaceEnsureResult | NamespaceDeleteResult>;
  readonly selectedCompute: () => ComputeDriver;
  readonly selectedIAMId: () => string;
  readonly allocateNamespaceId: () => string;
  readonly requireAdoptionSupport: () => void;
  readonly timestamp: () => string;
  readonly requestAuditId: () => string | undefined;
}

function validateLifecycleScope(result: unknown, namespace: Readonly<Namespace>): void {
  const candidate = result as {
    readonly namespaceId?: unknown;
  };
  if (!candidate || candidate.namespaceId !== namespace.id) {
    throw new DependencyUnavailableError(
      "The compute Driver returned lifecycle evidence for another Namespace.",
    );
  }
}

function validateEnsureResult(
  result: unknown,
  namespace: Readonly<Namespace>,
): asserts result is NamespaceEnsureResult {
  validateLifecycleScope(result, namespace);
  const candidate = result as Partial<NamespaceEnsureResult>;
  if (
    typeof candidate.namespaceReady !== "boolean" ||
    (candidate.failure !== undefined &&
      candidate.failure !== "retryable" &&
      candidate.failure !== "permanent")
  ) {
    throw new DependencyUnavailableError(
      "The compute Driver returned invalid Namespace readiness evidence.",
    );
  }
}

function validateDeleteResult(
  result: unknown,
  namespace: Readonly<Namespace>,
): asserts result is NamespaceDeleteResult {
  validateLifecycleScope(result, namespace);
  const candidate = result as Partial<NamespaceDeleteResult>;
  if (
    typeof candidate.namespaceDeleted !== "boolean" ||
    (candidate.failure !== undefined &&
      candidate.failure !== "retryable" &&
      candidate.failure !== "permanent")
  ) {
    throw new DependencyUnavailableError(
      "The compute Driver returned invalid Namespace deletion evidence.",
    );
  }
}

export function createNamespaceOperations({
  installationId,
  transactions,
  authority,
  iamPolicy,
  presets,
  record,
  observeLifecycle,
  selectedCompute,
  selectedIAMId,
  allocateNamespaceId,
  requireAdoptionSupport,
  timestamp,
  requestAuditId,
}: NamespaceDependencies) {
  async function listNamespaces(principalId: string): Promise<readonly Readonly<Namespace>[]> {
    authority.authorizationAuthority(principalId);
    return transactions.read(async (state) => {
      const readable: Readonly<Namespace>[] = [];
      for (const namespace of await state.namespaces.listNamespaces()) {
        if (
          await authority.canRead(principalId, {
            kind: "namespace",
            id: namespace.id,
            namespaceId: namespace.id,
          })
        ) {
          readable.push(namespace);
        }
      }
      return Object.freeze(readable);
    });
  }

  async function getNamespace(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    namespaceIdentity(namespaceId);
    await authority.authorize(principalId, "read", {
      kind: "namespace",
      id: namespaceId,
      namespaceId,
    });
    return transactions.read(async (state) => exactNamespace(state, namespaceId));
  }

  async function createNamespace(
    principalId: string,
    input: CreateNamespaceInput,
  ): Promise<Readonly<Namespace>> {
    if (!isName(input.name)) {
      throw new ScopeViolationError("The Namespace name is invalid.");
    }
    return transactions.transact(async (state) => {
      await authority.holdAuthority(state);
      const target: ResourceRef = {
        kind: "namespace",
        id: installationId,
      };
      await authority.authorize(principalId, "create", target);
      if (input.existingNamespace !== undefined) {
        await authority.authorize(principalId, "administer", {
          kind: "installation",
          id: installationId,
        });
        requireAdoptionSupport();
      }
      const namespace = await state.namespaces.createNamespace({
        id: allocateNamespaceId(),
        name: input.name,
        ...(input.existingNamespace === undefined
          ? {}
          : { existingNamespace: input.existingNamespace }),
        status: "provisioning",
        createdAt: timestamp(),
      });
      // The creator's Namespace-wide Owner grant lets the same unit create the default Presets.
      await iamPolicy.bindCreator(state, principalId, {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      // Configured Group bindings that name this Namespace, such as Agent creation in default.
      await iamPolicy.applyConfiguredPolicy(state, principalId, namespace);
      await presets.ensureNamespaceDefaultPresets(state, principalId, namespace);
      await record(state, {
        kind: "namespace",
        action: "reconcile",
        target: "ready",
        namespaceId: namespace.id,
        resourceId: namespace.id,
        actorId: principalId,
      });
      return namespace;
    });
  }

  async function retryNamespaceDeletion(
    state: PlatformUnitOfWork,
    principalId: string,
    namespace: Readonly<Namespace>,
  ): Promise<void> {
    const workId = `namespace:${namespace.id}:reconcile:deleted`;
    const work = await state.operations.findWork(workId);
    if (work?.state !== "failed_permanent") {
      return;
    }
    const takeover = work.actorId !== principalId;
    if (
      takeover &&
      (
        await authority.authorizationDecision(work.actorId, "delete", {
          kind: "namespace",
          id: namespace.id,
          namespaceId: namespace.id,
        })
      ).decision.allowed
    ) {
      throw new DeletionRetryOwnedError(work.actorId, {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      });
    }
    if (
      !(await state.operations.retryFailedNamespaceDeletion(
        namespace.id,
        work.actorId,
        principalId,
      ))
    ) {
      throw new ResourceStateConflictError("The Namespace deletion work changed during retry.");
    }
    const requestId = requestAuditId();
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: installationId,
      namespaceId: namespace.id,
      occurredAt: timestamp(),
      kind: "mutation",
      actorId: principalId,
      source: "occ",
      action: "openclaw.namespaces.delete.retry",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      outcome: "success",
      ...(requestId === undefined ? {} : { requestId }),
      details: {
        workId,
        previousAttemptCount: work.attemptCount,
        previousReasonCode: work.reasonCode,
        ...(takeover ? { takeover: true, previousActorId: work.actorId } : {}),
      },
    });
  }

  async function checkNamespaceDeletion(
    state: PlatformUnitOfWork,
    principalId: string,
    namespace: Readonly<Namespace>,
  ): Promise<readonly Readonly<Preset>[]> {
    // The 409 names remaining resources' IDs: Configurations have no list view, so the
    // error is the only place an operator can find what to delete. Namespace delete does
    // not grant child reads, so of the first IDs of each kind (as many as the response
    // carries) it names only those the caller may read, and counts the rest (finding 2724).
    const contents: string[] = [];
    const ids: Record<string, readonly string[]> = {};
    const counts: Record<string, number> = {};
    const addBlockingResources = async (
      kind: string,
      resourceKind: ResourceKind,
      resources: readonly { readonly id: string }[],
    ) => {
      contents.push(kind);
      counts[kind] = resources.length;
      const readable: string[] = [];
      for (const { id } of resources.slice(0, NAMESPACE_NOT_EMPTY_ID_LIMIT)) {
        // An authorization outage hides the ID rather than the conflict.
        const resource = { kind: resourceKind, id, namespaceId: namespace.id };
        if (await authority.canRead(principalId, resource).catch(() => false)) {
          readable.push(id);
        }
      }
      ids[kind] = readable;
    };
    if (await state.namespaces.hasAgents(namespace.id)) {
      await addBlockingResources("Agents", "agent", await state.agents.listAgents(namespace.id));
    }
    const configurationIds = await state.namespaces.listConfigurationIds(namespace.id);
    if (configurationIds.length > 0) {
      await addBlockingResources(
        "Configurations",
        "configuration",
        configurationIds.map((id) => ({ id })),
      );
    }
    const storedPresets = await state.presets.listPresets(namespace.id);
    const blockingPresets = storedPresets.filter(
      (preset) => !presets.isUnmodifiedDefaultPreset(preset),
    );
    if (blockingPresets.length > 0) {
      await addBlockingResources("Presets", "preset", blockingPresets);
    }
    if (await state.namespaces.hasSecrets(namespace.id)) {
      await addBlockingResources(
        "Secrets",
        "secret",
        await state.secrets.listSecrets(namespace.id),
      );
    }
    if (await state.namespaces.hasCredentialSources(namespace.id)) {
      await addBlockingResources(
        "credential sources",
        "credential_source",
        await state.credentialSources.listCredentialSources(namespace.id),
      );
    }
    if (await state.namespaces.hasServiceAccounts(namespace.id)) {
      await addBlockingResources(
        "service accounts",
        "service_account",
        await state.serviceAccounts.listServiceAccounts(namespace.id),
      );
    }
    const templates = await state.connectionTemplates.countNamespaceConnectionTemplates(
      namespace.id,
    );
    const clients = await state.connectionTemplates.countNamespaceOAuthClients(namespace.id);
    if (clients > 0) {
      contents.push("OAuth clients");
      counts["OAuth clients"] = clients;
    }
    if (templates > 0) {
      contents.push("connection templates");
      counts["connection templates"] = templates;
    }
    if (await state.provisioning.hasPendingNamespaceProvisioning(namespace.id)) {
      contents.push("pending Agent provisioning");
    }
    if (contents.length > 0) {
      throw new NamespaceNotEmptyError(contents, ids, counts);
    }
    return storedPresets;
  }

  async function deleteNamespace(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    namespaceIdentity(namespaceId);
    return transactions.transact(async (state) => {
      const namespace = await iamPolicy.lockNamespaceForPolicyDelete(state, principalId, {
        kind: "namespace",
        id: namespaceId,
        namespaceId,
      });
      // Keep in-flight teardown idempotent. The original caller can explicitly
      // retry terminal work after repairing the dependency or permission failure.
      // Another authorized caller can take over only once the initiating actor
      // no longer holds delete permission on this Namespace (for example, it
      // was offboarded), so terminal teardown is never stranded.
      if (namespace.status === "deleting") {
        await retryNamespaceDeletion(state, principalId, namespace);
        return namespace;
      }
      const defaultPresets = await checkNamespaceDeletion(state, principalId, namespace);
      // Installation defaults were seeded by Namespace creation, so deletion removes
      // them only while they still match the defaults; edited copies block above.
      for (const preset of defaultPresets) {
        const removed = await presets.deletePresetInState(
          state,
          principalId,
          namespace.id,
          preset.id,
        );
        await state.audit.append({
          id: `aud_${crypto.randomUUID()}`,
          installationId: installationId,
          namespaceId: namespace.id,
          occurredAt: timestamp(),
          kind: "mutation",
          actorId: principalId,
          source: "occ",
          action: "openclaw.presets.delete",
          resource: { kind: "preset", id: preset.id, namespaceId: namespace.id },
          outcome: "success",
          // Like a direct Preset delete, name the AccessBindings removed with it.
          details: {
            source: "namespace-deletion",
            ...(removed.length === 0 ? {} : { removedAccessBindings: removed }),
          },
        });
      }
      const deleting = await state.namespaces.transitionNamespaceStatus(
        namespace.id,
        ["provisioning", "ready", "failed"],
        "deleting",
      );
      if (!deleting) {
        throw new ResourceStateConflictError("The Namespace lifecycle changed during deletion.");
      }
      await record(state, {
        kind: "namespace",
        action: "reconcile",
        target: "deleted",
        namespaceId: deleting.id,
        resourceId: deleting.id,
        actorId: principalId,
      });
      return deleting;
    });
  }

  function observeAndValidateLifecycle(
    actorId: string,
    namespace: Readonly<Namespace>,
    compute: ComputeDriver,
    target: "ready",
  ): Promise<NamespaceEnsureResult>;
  function observeAndValidateLifecycle(
    actorId: string,
    namespace: Readonly<Namespace>,
    compute: ComputeDriver,
    target: "deleted",
  ): Promise<NamespaceDeleteResult>;
  async function observeAndValidateLifecycle(
    actorId: string,
    namespace: Readonly<Namespace>,
    compute: ComputeDriver,
    target: "ready" | "deleted",
  ): Promise<NamespaceEnsureResult | NamespaceDeleteResult> {
    let result: NamespaceEnsureResult | NamespaceDeleteResult;
    try {
      result = await observeLifecycle(namespace, target, new AbortController().signal, (evidence) =>
        recordLifecycleResult(
          actorId,
          namespace,
          compute,
          evidence.outcome === "complete" ? "success" : "failure",
          { ...evidence },
        ),
      );
    } catch {
      await recordLifecycleResult(actorId, namespace, compute, "failure", {
        failure: "unavailable",
      });
      const operation = target === "deleted" ? "delete" : "ensure";
      throw new DependencyUnavailableError(
        `The compute Driver could not ${operation} the Namespace.`,
      );
    }
    try {
      if (target === "deleted") {
        validateDeleteResult(result, namespace);
      } else {
        validateEnsureResult(result, namespace);
      }
      return result;
    } catch (error) {
      await recordLifecycleResult(actorId, namespace, compute, "failure", {
        failure: "invalid_driver_result",
      });
      throw error;
    }
  }

  async function handleNamespaceLifecycle(
    actorId: string,
    namespaceId: string,
    target: "ready" | "deleted",
  ): Promise<Readonly<Namespace> | undefined> {
    if (!isNonEmptyString(actorId)) {
      throw new ScopeViolationError("The lifecycle actor is missing.");
    }
    namespaceIdentity(namespaceId);
    if (target !== "ready" && target !== "deleted") {
      throw new ScopeViolationError("The Namespace lifecycle target is invalid.");
    }
    const namespace = await transactions.transact((state) =>
      state.namespaces.lockNamespace(namespaceId, {
        includeDeleted: true,
      }),
    );
    if (!namespace || namespace.deletedAt !== undefined) {
      return undefined;
    }
    if (target === "ready" && namespace.status !== "provisioning") {
      return namespace;
    }
    if (target === "deleted" && namespace.status !== "deleting") {
      return namespace;
    }

    let compute: ComputeDriver;
    try {
      compute = selectedCompute();
    } catch {
      await recordLifecycleResult(actorId, namespace, undefined, "failure", {
        failure: "compute_driver_unavailable",
      });
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }

    if (target === "deleted") {
      const result = await observeAndValidateLifecycle(actorId, namespace, compute, "deleted");
      const deleted = result.namespaceDeleted && result.failure === undefined;
      return transactions.transact(async (state) => {
        const current = await state.namespaces.lockNamespace(namespace.id, {
          includeDeleted: true,
        });
        if (!current || current.deletedAt !== undefined) {
          return undefined;
        }
        if (current.status !== "deleting") {
          return current;
        }
        if (deleted) {
          await state.pluginReleases.purgeNamespace(current.id);
        }
        const updated = deleted
          ? await state.namespaces.markNamespaceDeleted(current.id, timestamp())
          : current;
        const removedPolicy = deleted ? await removeNamespacePolicy(state, current.id) : undefined;
        await appendLifecycleAudit(
          state,
          actorId,
          current,
          compute,
          deleted ? "success" : "failure",
          {
            namespaceDeleted: result.namespaceDeleted,
            ...(result.failure === undefined ? {} : { failure: result.failure }),
            ...removedPolicyDetails(removedPolicy),
          },
        );
        return updated;
      });
    }

    const result = await observeAndValidateLifecycle(actorId, namespace, compute, "ready");
    const ready = result.namespaceReady && result.failure === undefined;
    return transactions.transact(async (state) => {
      const current = await state.namespaces.lockNamespace(namespace.id);
      if (!current) {
        return undefined;
      }
      if (current.status !== "provisioning") {
        return current;
      }
      let next: Namespace["status"] = current.status;
      if (ready) {
        next = "ready";
      } else if (result.failure === "permanent") {
        next = "failed";
      }
      const updated =
        next === current.status
          ? current
          : await state.namespaces.transitionNamespaceStatus(current.id, current.status, next);
      await appendLifecycleAudit(state, actorId, current, compute, ready ? "success" : "failure", {
        namespaceReady: result.namespaceReady,
        ...(result.failure === undefined ? {} : { failure: result.failure }),
      });
      return updated ?? current;
    });
  }

  async function recordLifecycleResult(
    actorId: string,
    namespace: Readonly<Namespace>,
    compute: ComputeDriver | undefined,
    outcome: "success" | "failure",
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await transactions.transact((state) =>
      appendLifecycleAudit(state, actorId, namespace, compute, outcome, details),
    );
  }

  async function appendLifecycleAudit(
    state: PlatformUnitOfWork,
    actorId: string,
    namespace: Readonly<Namespace>,
    compute: ComputeDriver | undefined,
    outcome: "success" | "failure",
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    let iamDriverId: string | undefined;
    try {
      iamDriverId = selectedIAMId();
    } catch {
      iamDriverId = undefined;
    }
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: installationId,
      namespaceId: namespace.id,
      occurredAt: timestamp(),
      kind: "mutation",
      actorId,
      source: "occ",
      action:
        namespace.status === "deleting"
          ? "openclaw.namespaces.lifecycle.delete"
          : "openclaw.namespaces.lifecycle.ensure",
      resource: {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      },
      ...(iamDriverId === undefined ? {} : { iamDriverId }),
      outcome,
      details: Object.freeze({
        ...(compute === undefined ? {} : { computeDriverId: compute.id }),
        ...details,
      }),
    });
  }

  return {
    listNamespaces,
    getNamespace,
    createNamespace,
    deleteNamespace,
    handleNamespaceLifecycle,
  };
}

export type NamespaceOperations = ReturnType<typeof createNamespaceOperations>;
