import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout } from "node:timers/promises";
import type {
  AgentManagementApply,
  HarnessAuthBinding,
  OpenClawConfigurationDocument,
  SecretBindings,
} from "@openclaw-enterprise/contracts";
import { ClusterResources, type Resource } from "./cluster.ts";
import { EnterpriseClient } from "./enterprise-client.ts";

const FINALIZER = "enterprise.openclaw.ai/management";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A required resource object is unavailable.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("A required resource reference is unavailable.");
  }
  return value;
}

interface Management {
  readonly management: {
    sourceId: string;
    principalId: string;
    version: number;
    suspended: boolean;
    released: boolean;
    requestedRevisionId?: string;
  } | null;
  readonly adoption: {
    configurationId: string;
    configurationGeneration: number;
    activeRevisionId?: string;
    fingerprint: string;
  };
}

interface Tenant {
  readonly api: EnterpriseClient;
  readonly namespaceId: string;
  readonly connection: Resource;
}

export class ReconcilePending extends Error {
  readonly reason: string;
  readonly values: Record<string, unknown>;
  constructor(reason: string, message: string, values: Record<string, unknown> = {}) {
    super(message);
    this.reason = reason;
    this.values = values;
    this.name = "ReconcilePending";
  }
}

export class AgentReconciler {
  private readonly cluster: ClusterResources;
  private readonly sourceClusterId: string;
  private readonly namespaceUid: string;
  private readonly signal: AbortSignal | undefined;
  constructor(
    cluster: ClusterResources,
    sourceClusterId: string,
    namespaceUid: string,
    signal?: AbortSignal,
  ) {
    this.cluster = cluster;
    this.sourceClusterId = sourceClusterId;
    this.namespaceUid = namespaceUid;
    this.signal = signal;
  }

  private source(resource: Resource): string {
    return createHash("sha256")
      .update(`${this.sourceClusterId}/${this.namespaceUid}/${resource.metadata.uid}`)
      .digest("hex");
  }

  private async connect(connection: Resource): Promise<EnterpriseClient> {
    const spec = connection.spec;
    const service = record(spec.serviceKeyRef);
    const key = await this.cluster.secret(text(service.name), text(service.key));
    const caRef = spec.caSecretKeyRef === undefined ? undefined : record(spec.caSecretKeyRef);
    const ca =
      caRef === undefined
        ? undefined
        : await this.cluster.secret(text(caRef.name), text(caRef.key));
    const api = new EnterpriseClient(
      text(spec.endpoint),
      key,
      ca,
      this.signal,
      spec.address === undefined ? undefined : text(spec.address),
    );
    const scope = record(spec.namespaceScope);
    const first = Array.isArray(scope.existingIds) ? scope.existingIds[0] : undefined;
    if (typeof first !== "string") {
      // TODO RFC-0037: Namespace creation requires a separately scoped bootstrap connection.
      throw new ReconcilePending(
        "NamespaceScopeRequired",
        "This alpha connection requires an approved existing Namespace.",
      );
    }
    const identity = await api.call<{ installationId: string; namespaceId: string }>(
      "GET",
      `/namespaces/${encodeURIComponent(first)}/identity`,
    );
    if (identity.installationId !== spec.installationId || identity.namespaceId !== first) {
      throw new ReconcilePending(
        "InstallationMismatch",
        "Connection reached a different Installation.",
      );
    }
    return api;
  }

  private async tenant(resource: Resource): Promise<Tenant> {
    const namespace =
      resource.kind === "OCENamespace"
        ? resource
        : await this.cluster.get("OCENamespace", text(resource.spec.namespaceRef));
    const connection = await this.cluster.get("OCEConnection", text(namespace.spec.connectionRef));
    const api = await this.connect(connection);
    if (namespace.spec.existingId === undefined) {
      // TODO RFC-0037: add durable Namespace creation ownership before allowing create effects.
      throw new ReconcilePending(
        "NamespaceCreationUnavailable",
        "Namespace creation receipts are not implemented; reference a provisioned Namespace.",
      );
    }
    const namespaceId = text(namespace.spec.existingId);
    const scope = record(connection.spec.namespaceScope);
    if (!Array.isArray(scope.existingIds) || !scope.existingIds.includes(namespaceId)) {
      throw new ReconcilePending(
        "NamespaceNotApproved",
        "Connection does not approve the selected Namespace.",
      );
    }
    const live = await api.call<{ status: string }>(
      "GET",
      `/namespaces/${encodeURIComponent(namespaceId)}`,
    );
    if (live.status !== "ready") {
      throw new ReconcilePending(
        "NamespaceNotReady",
        "The selected Enterprise Namespace is not ready.",
      );
    }
    return { api, namespaceId, connection };
  }

  private async connection(resource: Resource): Promise<Record<string, unknown>> {
    await this.connect(resource);
    return {};
  }

  private async namespace(resource: Resource): Promise<Record<string, unknown>> {
    const tenant = await this.tenant(resource);
    return { namespaceId: tenant.namespaceId };
  }

  private async secret(resource: Resource): Promise<Record<string, unknown>> {
    const { api, namespaceId } = await this.tenant(resource);
    if (resource.spec.existingId === undefined) {
      // TODO RFC-0037: import/rotation needs durable Secret Driver receipts, not name-based recovery.
      throw new ReconcilePending(
        "SecretImportUnavailable",
        "Secret import receipts are not implemented; reference an existing Enterprise Secret.",
      );
    }
    const secretId = text(resource.spec.existingId);
    await api.call(
      "GET",
      `/namespaces/${encodeURIComponent(namespaceId)}/secrets/${encodeURIComponent(secretId)}`,
    );
    return { namespaceId, secretId };
  }

  private async bindings(
    resource: Resource,
    namespaceId: string,
  ): Promise<{ bindings: SecretBindings; dependencies: string[] }> {
    const configuration = record(resource.spec.configuration);
    const requested =
      configuration.secretBindings === undefined ? {} : record(configuration.secretBindings);
    const bindings: Record<string, SecretBindings[string]> = {};
    const dependencies: string[] = [];
    for (const [name, raw] of Object.entries(requested)) {
      const binding = record(raw);
      const secret = await this.cluster.get("OCESecret", text(binding.secretRef));
      if (
        secret.spec.namespaceRef !== resource.spec.namespaceRef ||
        secret.spec.existingId === undefined
      ) {
        throw new ReconcilePending(
          "SecretNotReady",
          "A referenced Secret does not resolve in this Namespace.",
        );
      }
      const secretId = text(secret.spec.existingId);
      const tenant = await this.tenant(secret);
      if (tenant.namespaceId !== namespaceId) {
        throw new ReconcilePending(
          "SecretNamespaceMismatch",
          "A Secret reference cannot cross Enterprise Namespaces.",
        );
      }
      await tenant.api.call(
        "GET",
        `/namespaces/${encodeURIComponent(namespaceId)}/secrets/${encodeURIComponent(secretId)}`,
      );
      bindings[name] = {
        source: { kind: "secret", namespaceId, id: secretId },
        delivery: { type: "env" },
      };
      dependencies.push(`${secret.metadata.uid}/${secret.metadata.generation}/${secretId}`);
    }
    return { bindings, dependencies: dependencies.sort() };
  }

  private async agent(resource: Resource): Promise<Record<string, unknown>> {
    const { api, namespaceId } = await this.tenant(resource);
    if (resource.spec.adopt === undefined) {
      // TODO RFC-0037: recover first-time provisioning by external source before creating new Agents.
      throw new ReconcilePending(
        "AgentCreationUnavailable",
        "First-time provisioning receipts are not implemented; use explicit reviewed adoption.",
      );
    }
    const adopt = record(resource.spec.adopt);
    const agentId = text(adopt.agentId);
    const path = `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(agentId)}`;
    const original = await api.call<{ executionMode: string }>("GET", path);
    if (original.executionMode !== resource.spec.executionMode) {
      throw new ReconcilePending(
        "ExecutionModeMismatch",
        "Adoption cannot change the Agent execution mode.",
      );
    }
    const sourceId = this.source(resource);
    let ownership = await api.call<Management>("GET", `${path}/management`);
    if (ownership.management === null || ownership.management.released) {
      ownership = await api.call<Management>("PUT", `${path}/management`, {
        sourceId,
        expectedConfigurationId: text(adopt.configurationId),
        expectedConfigurationGeneration: adopt.configurationGeneration,
        ...(adopt.activeRevisionId === undefined
          ? {}
          : { expectedActiveRevisionId: text(adopt.activeRevisionId) }),
        expectedFingerprint: text(adopt.fingerprint),
        expectedManagementVersion: adopt.managementVersion,
      });
    }
    const owner = ownership.management;
    if (owner === null || owner.released || owner.sourceId !== sourceId) {
      throw new ReconcilePending("OwnershipConflict", "The Agent has a different external owner.");
    }
    if (owner.suspended) {
      throw new ReconcilePending(
        "ManagementSuspended",
        "An administrator stopped the Agent. Release and explicitly review ownership before resuming.",
      );
    }
    const { bindings, dependencies } = await this.bindings(resource, namespaceId);
    const harnessAuth = record(resource.spec.harnessAuth);
    let modelAuthentication: HarnessAuthBinding;
    if (harnessAuth.method === "credential_source") {
      modelAuthentication = { method: "credential_source", sourceId: text(harnessAuth.sourceId) };
    } else {
      const modelSecret = await this.cluster.get("OCESecret", text(harnessAuth.secretRef));
      if (
        modelSecret.spec.namespaceRef !== resource.spec.namespaceRef ||
        modelSecret.spec.existingId === undefined ||
        (harnessAuth.method !== "api_key" && harnessAuth.method !== "codex_pat")
      ) {
        throw new ReconcilePending(
          "HarnessBindingUnavailable",
          "The Harness credential does not resolve in the selected Namespace.",
        );
      }
      const secretId = text(modelSecret.spec.existingId);
      await api.call(
        "GET",
        `/namespaces/${encodeURIComponent(namespaceId)}/secrets/${encodeURIComponent(secretId)}`,
      );
      const source = { kind: "secret" as const, namespaceId, id: secretId };
      modelAuthentication =
        harnessAuth.method === "api_key"
          ? { method: "api_key", source }
          : { method: "codex_pat", source };
      dependencies.push(
        `${modelSecret.metadata.uid}/${modelSecret.metadata.generation}/${secretId}`,
      );
      dependencies.sort();
    }
    const requestKey = createHash("sha256")
      .update(
        JSON.stringify({
          generation: resource.metadata.generation,
          dependencies,
          retryNonce: resource.spec.retryNonce ?? null,
        }),
      )
      .digest("hex");
    const input: AgentManagementApply & { nativeAdmin: boolean } = {
      sourceId,
      sourceGeneration: resource.metadata.generation,
      expectedVersion: owner.version,
      requestKey,
      desiredRuntimeState: resource.spec.desiredState === "stopped" ? "stopped" : "running",
      configuration: {
        values: record(record(resource.spec.configuration).values) as OpenClawConfigurationDocument,
        secretBindings: bindings,
      },
      harnessAuth: modelAuthentication,
      nativeAdmin: resource.spec.nativeAdmin === true,
      ...(typeof resource.spec.retryNonce === "string" && resource.spec.retryNonce.length > 0
        ? { retryNonce: resource.spec.retryNonce }
        : {}),
    };
    ownership = await api.call<Management>("POST", `${path}/management/apply`, input);
    const live = await api.call<{ activeRevisionId?: string; desiredRuntimeState: string }>(
      "GET",
      path,
    );
    const result = {
      namespaceId,
      agentId,
      configurationId: ownership.adoption.configurationId,
      managementVersion: ownership.management!.version,
      activeRevisionId: live.activeRevisionId,
      requestedRevisionId: ownership.management?.requestedRevisionId,
    };
    if (input.desiredRuntimeState === "stopped" && live.desiredRuntimeState === "stopped") {
      if (live.activeRevisionId !== undefined) {
        throw new ReconcilePending(
          "Stopping",
          "Enterprise has not completed the Agent stop.",
          result,
        );
      }
      // A candidate can have Pods before it becomes active. Inspect the Agent's
      // admitted versions too; observing only an old active pointer can miss it.
      const revisions = await api.call<{ id: string }[]>("GET", `${path}/revisions`);
      for (const revision of revisions) {
        // Runtime reads share a two-per-second bucket for this principal/Agent.
        // Pace long histories so retries can finish instead of restarting at a 429.
        await setTimeout(600, undefined, { signal: this.signal });
        const runtime = await api.call<{ revisionId: string; observedAt: string; pods: unknown[] }>(
          "GET",
          `${path}/deployments/${encodeURIComponent(revision.id)}/runtime`,
        );
        const age = Date.now() - Date.parse(runtime.observedAt);
        if (
          runtime.revisionId !== revision.id ||
          !Number.isFinite(age) ||
          age < -30_000 ||
          age > 90_000 ||
          !Array.isArray(runtime.pods) ||
          runtime.pods.length !== 0
        ) {
          throw new ReconcilePending(
            "Stopping",
            "The Agent is stopping; runtime cleanup is not complete.",
            result,
          );
        }
      }
      return result;
    }
    const requestedRevisionId = ownership.management?.requestedRevisionId;
    if (requestedRevisionId === undefined) {
      throw new ReconcilePending(
        "DeploymentPending",
        "The Agent has no requested revision yet.",
        result,
      );
    }
    const deployment = await api.call<{ status: string }>(
      "GET",
      `${path}/deployments/${encodeURIComponent(requestedRevisionId)}`,
    );
    if (deployment.status === "failed") {
      throw new ReconcilePending(
        "DeploymentFailed",
        "Enterprise recorded a deployment failure; change desired state or explicitly request a retry.",
        result,
      );
    }
    if (deployment.status !== "succeeded" || live.activeRevisionId !== requestedRevisionId) {
      throw new ReconcilePending(
        "DeploymentPending",
        "Enterprise has not recorded deployment completion.",
        result,
      );
    }
    // Deployment completion and current runtime observation are separate facts.
    const runtime = await api.call<{
      revisionId: string;
      observedAt: string;
      pods: { role: string; ready: boolean; phase: string }[];
    }>("GET", `${path}/deployments/${encodeURIComponent(live.activeRevisionId)}/runtime`);
    const age = Date.now() - Date.parse(runtime.observedAt);
    if (
      runtime.revisionId !== live.activeRevisionId ||
      !Number.isFinite(age) ||
      age < -30_000 ||
      age > 90_000 ||
      !Array.isArray(runtime.pods) ||
      !runtime.pods.some((pod) => pod.role === "gateway") ||
      !runtime.pods.some((pod) => pod.role === "agent") ||
      runtime.pods.some((pod) => !pod.ready || pod.phase !== "Running")
    ) {
      throw new ReconcilePending(
        "RuntimeUnknown",
        "The current runtime observation is unavailable.",
        result,
      );
    }
    const diagnostics = await api.call<{
      revisionId: string;
      observedAt: string;
      checks: { component: string; check: string; state: string }[];
    }>("POST", `${path}/deployments/${encodeURIComponent(live.activeRevisionId)}/diagnostics`);
    const diagnosticAge = Date.now() - Date.parse(diagnostics.observedAt);
    const gatewayChecks = ["configuration", "authentication", "connectivity"];
    if (
      diagnostics.revisionId !== live.activeRevisionId ||
      !Number.isFinite(diagnosticAge) ||
      diagnosticAge < -30_000 ||
      diagnosticAge > 90_000 ||
      !Array.isArray(diagnostics.checks) ||
      diagnostics.checks.some((check) => check.state === "failed") ||
      gatewayChecks.some(
        (name) =>
          !diagnostics.checks.some(
            (check) =>
              check.component === "gateway" && check.check === name && check.state === "succeeded",
          ),
      )
    ) {
      throw new ReconcilePending(
        "RuntimeDiagnosticsPending",
        "The current Gateway configuration, authentication and connectivity checks have not succeeded.",
        result,
      );
    }
    return result;
  }

  private async finalize(resource: Resource): Promise<void> {
    if (resource.kind !== "OCEAgent") {
      const references: Resource[] = [];
      if (resource.kind === "OCEConnection") {
        references.push(
          ...(await this.cluster.list("OCENamespace")).items.filter(
            (item) => item.spec.connectionRef === resource.metadata.name,
          ),
        );
      }
      if (resource.kind === "OCENamespace") {
        for (const kind of ["OCEAgent", "OCESecret"] as const) {
          references.push(
            ...(await this.cluster.list(kind)).items.filter(
              (item) => item.spec.namespaceRef === resource.metadata.name,
            ),
          );
        }
      }
      if (resource.kind === "OCESecret") {
        references.push(
          ...(await this.cluster.list("OCEAgent")).items.filter(
            (item) =>
              record(item.spec.harnessAuth).secretRef === resource.metadata.name ||
              Object.values(record(record(item.spec.configuration).secretBindings ?? {})).some(
                (binding) => record(binding).secretRef === resource.metadata.name,
              ),
          ),
        );
      }
      if (references.length > 0) {
        throw new ReconcilePending(
          "ResourceInUse",
          "Dependent custom resources must finish finalization first.",
        );
      }
      // Only externally referenced resources are supported by this alpha controller.
      await this.cluster.finalizers(
        resource,
        (resource.metadata.finalizers ?? []).filter((value) => value !== FINALIZER),
      );
      return;
    }
    const adopt = record(resource.spec.adopt);
    const { api, namespaceId } = await this.tenant(resource);
    const agentId = text(adopt.agentId);
    const path = `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(agentId)}`;
    const ownership = await api.call<Management>("GET", `${path}/management`);
    if (ownership.management !== null && !ownership.management.released) {
      if (ownership.management.sourceId !== this.source(resource)) {
        throw new ReconcilePending(
          "OwnershipConflict",
          "Deletion cannot release another owner's Agent.",
        );
      }
      if (resource.spec.deletionPolicy === "Delete") {
        // TODO RFC-0037: observe asynchronous Agent and owned Configuration cleanup before finalizing Delete.
        throw new ReconcilePending(
          "DeletionUnavailable",
          "Delete cleanup is not qualified; retain the finalizer until it is implemented.",
        );
      }
      await api.call("DELETE", `${path}/management`, {
        sourceId: this.source(resource),
        expectedVersion: ownership.management.version,
      });
    }
    await this.cluster.finalizers(
      resource,
      (resource.metadata.finalizers ?? []).filter((value) => value !== FINALIZER),
    );
  }

  async reconcile(resource: Resource): Promise<void> {
    if (resource.metadata.deletionTimestamp !== undefined) {
      if (resource.metadata.finalizers?.includes(FINALIZER)) {
        await this.finalize(resource);
      }
      return;
    }
    if (!resource.metadata.finalizers?.includes(FINALIZER)) {
      await this.cluster.finalizers(resource, [...(resource.metadata.finalizers ?? []), FINALIZER]);
      return;
    }
    const handlers = {
      OCEConnection: () => this.connection(resource),
      OCENamespace: () => this.namespace(resource),
      OCESecret: () => this.secret(resource),
      OCEAgent: () => this.agent(resource),
    };
    const result = await handlers[resource.kind]();
    await this.report(
      resource,
      result,
      "True",
      "Reconciled",
      "The declared resource converged through Enterprise.",
    );
  }

  async report(
    resource: Resource,
    values: Record<string, unknown>,
    ready: "True" | "False" | "Unknown",
    reason: string,
    message: string,
  ): Promise<void> {
    const previous = Array.isArray(resource.status?.conditions)
      ? resource.status.conditions.map(record).find((condition) => condition.type === "Ready")
      : undefined;
    const condition = {
      type: "Ready",
      status: ready,
      reason,
      message,
      observedGeneration: resource.metadata.generation,
      lastTransitionTime:
        previous?.status === ready && previous.reason === reason
          ? previous.lastTransitionTime
          : new Date().toISOString(),
    };
    const state = {
      ...resource.status,
      ...values,
      observedGeneration: resource.metadata.generation,
      lastObservedTime: new Date().toISOString(),
      conditions: [condition],
    };
    if (isDeepStrictEqual(state, resource.status)) {
      return;
    }
    await this.cluster.status(resource, state);
  }
}
