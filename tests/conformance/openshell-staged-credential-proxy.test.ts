import assert from "node:assert/strict";
import { ComputeCleanupFailedError } from "../../apps/controller/src/drivers/compute/cleanup-failure.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  OpenShellGateway,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { resolveModelCredentialPreset } from "../../apps/controller/src/composition/model-credential-presets.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/credential-proxy/openshell.ts";
import { OpenShellCredentialDeliveryRefusedError } from "../../apps/controller/src/drivers/credential-proxy/openshell-pushed-provider.ts";
import { openShellRepositoryCredentialRequests } from "../../apps/controller/src/drivers/credential-proxy/openshell-repository-policy.ts";
import { isNativeStagedRepositoryRevision } from "../../packages/contracts/src/credential-deployment.ts";
import { admitRepositoryNetworkPolicy } from "../../packages/contracts/src/repository-network-policy.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { managedMcpInstalls } from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { openShellProjectedCredentialProviderName } from "../../apps/controller/src/drivers/sandbox/openshell-credential-policy.ts";
import {
  GrpcOpenShellGatewayClient,
  OpenShellAdmissionLimitError,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellGatewayFailure } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import type {
  Backend,
  DeploymentRequestMatch,
  CredentialDeploymentContext,
  CredentialSourceReference,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { grpc, loader, openShellService, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { digest, routedOptions } from "../helpers/kubernetes-routed-scenarios.mjs";
import { bindWireServer } from "./openshell-gateway-wire-fixture.ts";
import {
  createDedicatedDeployEnrollmentFixture,
  createDedicatedDeployKubernetesFixture,
} from "./kubernetes-dedicated-deploy-fixture.ts";
import { openShellWorkspaceHarnessConfiguration } from "../integration/sandbox-driver-installation-fixture.ts";
import { completeSandboxRevision } from "../integration/sandbox-driver-revision-fixture.ts";
import {
  ActivationPendingError,
  CredentialWithdrawalRefusedError,
  DependencyUnavailableError,
  SandboxGatewayUnauthorizedError,
} from "../../packages/occ/src/errors.ts";
import { InstalledDriver } from "../../packages/occ/src/installed-driver.ts";

type Wire = Record<string, unknown>;
type Handler = (request: Wire) => Wire | undefined;
type ConfigureInput = Parameters<OpenShellCredentialProxyDriver["configureDeployment"]>[1];
type Metadata = {
  id: string;
  name: string;
  workspace: string;
  resource_version: string;
  labels: Record<string, string>;
  annotations?: Record<string, string>;
};
type Provider = {
  metadata: Metadata;
  type: string;
  profile_workspace: string;
  config: Record<string, string>;
};

const namespace = {
  id: "namespace-1",
  name: "tenant",
  status: "ready",
  createdAt: "2026-11-20T00:00:00Z",
} as const;
const binding = {
  sourceRef: {
    kind: "credential_source",
    id: "cs_model",
    namespaceId: namespace.id,
  },
  bindingRef: "model",
  consumer: { kind: "model", providerId: "openai" },
  projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
} as const;
const request = {
  binary: "/usr/local/bin/codex",
  host: "api.openai.com",
  ports: [{ from: 443, to: 443 }],
  requestPolicy: { type: "http", method: "POST", path: "/v1/responses" },
} satisfies DeploymentRequestMatch;
const injection = {
  bindingRef: binding.bindingRef,
  allowedRequests: [request],
} as const;
const configuration = {
  targetRef: {
    namespaceId: namespace.id,
    agentId: "agent-1",
    revisionId: "revision-1",
    sandboxId: "f1d7e6c5-1b2a-4c3d-8e9f-102938475601",
  },
  configurationId: "configuration-1",
} as const;
const secondConfiguration = {
  targetRef: {
    namespaceId: namespace.id,
    agentId: "agent-2",
    revisionId: "revision-2",
    sandboxId: "f1d7e6c5-1b2a-4c3d-8e9f-102938475620",
  },
  configurationId: "configuration-2",
} as const;
const labels = {
  "app.kubernetes.io/managed-by": "openclaw-enterprise",
  "openclaw.dev/namespace": namespace.id,
  "openclaw.dev/agent": configuration.targetRef.agentId,
  "openclaw.dev/revision": configuration.targetRef.revisionId,
};
const annotations = {
  "openclaw.dev/namespace-id": namespace.id,
  "openclaw.dev/agent-id": configuration.targetRef.agentId,
  "openclaw.dev/revision-id": configuration.targetRef.revisionId,
  "openclaw.dev/configuration-id": configuration.configurationId,
};

function record(value: unknown): Wire {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Wire;
}

function sourcePolicyFrom(effective: Wire): Wire {
  const source = structuredClone(effective);
  for (const rule of Object.values(record(source.network_policies))) {
    for (const endpoint of record(rule).endpoints as Wire[]) {
      // OpenShell stamps this field when it composes the effective policy.
      Reflect.deleteProperty(endpoint, "provider_credentialed");
    }
  }
  return source;
}

function policyUsesProvider(policy: unknown, provider: string): boolean {
  const networks = record(policy).network_policies;
  return Object.values(record(networks)).some((rule) =>
    ((record(rule).endpoints as Wire[] | undefined) ?? []).some(
      (endpoint) => record(endpoint.credential_binding ?? {}).provider === provider,
    ),
  );
}

async function fixture(t: TestContext, workspaceNamespace: string = namespace.name) {
  const placedNamespace = { ...namespace, name: workspaceNamespace };
  const sandbox = {
    metadata: {
      id: configuration.targetRef.sandboxId as string,
      name: "held-sandbox",
      workspace: placedNamespace.name,
      resource_version: "5",
      labels: { ...labels } as Record<string, string>,
      annotations: { ...annotations } as Record<string, string>,
    },
    spec: {
      providers: [] as string[],
      provider_attachment_epoch: "",
      policy: undefined as Wire | undefined,
    },
    status: {} as Wire,
  };
  const sandboxes = [sandbox];
  const state = {
    profile: undefined as Wire | undefined,
    provider: undefined as Provider | undefined,
    additionalProfiles: new Map<string, Wire>(),
    additionalProviders: new Map<string, Provider>(),
    additionalProviderStatuses: new Map<string, Wire>(),
    creates: [] as Wire[],
    updates: [] as Wire[],
    policyUpdates: [] as Wire[],
    policyUpdateReadback: "normal" as "normal" | "widened",
    attaches: [] as Wire[],
    detaches: [] as Wire[],
    detachReceipts: new Map<string, Wire>(),
    routeWithdrawals: [] as { sandboxId: string; bindingRef: string }[],
    deletes: [] as Wire[],
    profileDeletes: [] as Wire[],
    sandboxReads: 0,
    sandboxPresent: true,
    sandboxInventoryMode: "normal" as "normal" | "second-page" | "repeated-token",
    workspaceDenied: false,
    sandboxReadMode: "normal" as "normal" | "unavailable-after-detach",
    detachMode: "normal" as "normal" | "permission-denied",
    deleteMode: "normal" as "normal" | "unavailable" | "other-precondition",
    config: undefined as Wire | undefined,
    policyStatus: undefined as Wire | undefined,
    providerStatus: undefined as Wire | undefined,
    statusReads: [] as Wire[],
    createMode: "normal" as "normal" | "stale-winner",
    updateReadiness: "converge" as "converge" | "cancel-pending" | "stale-ready",
    abortOnPending: undefined as (() => void) | undefined,
    attachMode: "normal" as
      | "normal"
      | "cas-race"
      | "provider-race"
      | "receipt-provider-id-mismatch"
      | "missing-receipt"
      | "invalid-receipt-time"
      | "receipt-epoch-mismatch"
      | "permission-denied"
      | "admission-limit"
      | "incarnation-race"
      | "detach-race",
    detachOnNextSandboxRead: false,
  };
  const providerFor = (name: string) =>
    state.provider?.metadata.name === name ? state.provider : state.additionalProviders.get(name);
  const profileFor = (name: string) =>
    state.profile?.id === name ? state.profile : state.additionalProfiles.get(name);
  const providerStatusFor = (name: string) =>
    state.provider?.metadata.name === name
      ? state.providerStatus
      : state.additionalProviderStatuses.get(name);
  const liveSandbox = (name: string) =>
    sandboxes.find(
      (candidate) =>
        candidate.metadata.name === name && (candidate !== sandbox || state.sandboxPresent),
    );
  const advanceProviderEnvironment = (status: Wire) => {
    const desired = record(record(status.receipt).desired);
    const observed = record(status.observed);
    Object.assign(record(sandbox.status.configuration_admission), {
      provider_env_revision: desired.provider_env_revision,
    });
    Object.assign(state.config!, { provider_env_revision: desired.provider_env_revision });
    Object.assign(observed, {
      provider_env_revision: desired.provider_env_revision,
      sequence: String(BigInt(String(observed.sequence)) + 1n),
    });
    status.state = "PROVIDER_READINESS_STATE_READY";
  };
  const methods: Record<string, Handler> = {
    ListSandboxes: (input) => {
      assert.equal(record(input.workspace_scope).workspace, placedNamespace.name);
      const pageToken = String(input.page_token ?? "");
      if (state.sandboxInventoryMode === "repeated-token") {
        return { sandboxes: [], next_page_token: "again" };
      }
      if (state.sandboxInventoryMode === "second-page" && pageToken === "") {
        return { sandboxes: [], next_page_token: "page-two" };
      }
      if (state.sandboxInventoryMode === "second-page") {
        assert.equal(pageToken, "page-two");
      }
      return {
        sandboxes: sandboxes.filter((candidate) => candidate !== sandbox || state.sandboxPresent),
      };
    },
    GetSandbox: (input) => {
      state.sandboxReads++;
      if (state.sandboxReadMode === "unavailable-after-detach" && state.detaches.length > 0) {
        throw Object.assign(new Error("Gateway unavailable"), { code: grpc.status.UNAVAILABLE });
      }
      const target = liveSandbox(String(input.name));
      if (!target || state.workspaceDenied) {
        return undefined;
      }
      if (state.detachOnNextSandboxRead) {
        target.spec.providers = [];
        target.metadata.resource_version = "7";
        state.detachOnNextSandboxRead = false;
      }
      return { sandbox: target };
    },
    StopSandbox: (input) => {
      assert.equal(record(input.workspace_scope).workspace, placedNamespace.name);
      const target = liveSandbox(String(input.name));
      assert.ok(target);
      // Stock StopSandbox stops execution and keeps Sandbox policy and Provider membership.
      target.status.phase = "SANDBOX_PHASE_STOPPED";
      target.metadata.resource_version = String(BigInt(target.metadata.resource_version) + 1n);
      state.config = undefined;
      if (state.policyStatus) {
        record(state.policyStatus.revision).status = "POLICY_STATUS_PENDING";
        delete state.policyStatus.active_version;
      }
      return { sandbox: target };
    },
    GetWorkspace: () => {
      if (state.workspaceDenied) {
        throw Object.assign(new Error("Workspace role denied"), {
          code: grpc.status.PERMISSION_DENIED,
        });
      }
      return {
        workspace: {
          metadata: {
            id: "workspace-id",
            name: placedNamespace.name,
            labels: {
              "app.kubernetes.io/managed-by": "openclaw-enterprise",
              "openclaw.dev/namespace-id": namespace.id,
            },
          },
        },
      };
    },
    GetProvider: (input) => {
      if (state.attachMode === "detach-race" && state.attaches.length > 0) {
        state.detachOnNextSandboxRead = true;
      }
      const provider = providerFor(String(input.name));
      return provider && { provider };
    },
    ListProviders: (input) => {
      assert.equal(record(input.workspace_scope).workspace, placedNamespace.name);
      return {
        providers: [
          ...(state.provider ? [state.provider] : []),
          ...state.additionalProviders.values(),
        ],
      };
    },
    DetachSandboxProvider: (input) => {
      state.detaches.push(input);
      if (state.detachMode === "permission-denied") {
        throw Object.assign(new Error("upstream-private-detail"), {
          code: grpc.status.PERMISSION_DENIED,
        });
      }
      const target = liveSandbox(String(input.sandbox));
      assert.ok(target);
      const provider = String(input.provider);
      const stoppedPolicy =
        target === sandbox && target.status.phase === "SANDBOX_PHASE_STOPPED"
          ? record(state.policyStatus!.revision).policy
          : undefined;
      if (
        (target.spec.policy && policyUsesProvider(target.spec.policy, provider)) ||
        (stoppedPolicy && policyUsesProvider(stoppedPolicy, provider)) ||
        (target === sandbox &&
          state.config?.policy &&
          policyUsesProvider(state.config.policy, provider))
      ) {
        throw Object.assign(new Error("Provider is still referenced by policy"), {
          code: grpc.status.FAILED_PRECONDITION,
        });
      }
      const detached = target.spec.providers.includes(provider);
      target.spec.providers = target.spec.providers.filter((name) => name !== provider);
      const mutationId = randomUUID();
      if (detached) {
        target.metadata.resource_version = String(BigInt(target.metadata.resource_version) + 1n);
        target.spec.provider_attachment_epoch = mutationId;
      }
      const receipt = {
        receipt_id: randomUUID(),
        mutation_id: mutationId,
        kind: "PROVIDER_MUTATION_KIND_DETACH",
        workspace: placedNamespace.name,
        provider,
        desired: {
          sandbox_id: target.metadata.id,
          sandbox: target.metadata.name,
          attachment_epoch: target.spec.provider_attachment_epoch,
          provider_env_revision: String(state.config?.provider_env_revision ?? "1"),
          config_revision: String(state.config?.config_revision ?? "1"),
          policy_hash: String(state.config?.policy_hash ?? "b".repeat(64)),
        },
        persisted_time: { seconds: String(Math.floor(Date.now() / 1_000)), nanos: 0 },
      };
      state.detachReceipts.set(receipt.receipt_id, receipt);
      return { detached, receipt };
    },
    DeleteProvider: (input) => {
      state.deletes.push(input);
      if (state.deleteMode === "unavailable") {
        throw Object.assign(new Error("Gateway unavailable"), { code: grpc.status.UNAVAILABLE });
      }
      if (state.deleteMode === "other-precondition") {
        throw Object.assign(new Error("Workspace mutation is unavailable"), {
          code: grpc.status.FAILED_PRECONDITION,
        });
      }
      const name = String(input.name);
      const using = sandboxes
        .filter(
          (target) => liveSandbox(target.metadata.name) && target.spec.providers.includes(name),
        )
        .map((target) => target.metadata.name)
        .sort();
      if (using.length) {
        // Stock OpenShell rejects deletion under its Workspace mutation guard while any Sandbox
        // still references the Provider. This controlled transport reproduces that native boundary.
        throw Object.assign(
          new Error(`provider '${name}' is attached to sandbox(es): ${using.join(", ")}`),
          {
            code: grpc.status.FAILED_PRECONDITION,
          },
        );
      }
      assert.ok(providerFor(name));
      if (state.provider?.metadata.name === name) {
        state.provider = undefined;
      } else {
        state.additionalProviders.delete(name);
      }
      return { outcome: "DELETION_OUTCOME_COMPLETED" };
    },
    DeleteProviderProfile: (input) => {
      state.profileDeletes.push(input);
      const id = String(input.id);
      assert.equal(providerFor(id), undefined);
      assert.ok(profileFor(id));
      if (state.profile?.id === id) {
        state.profile = undefined;
      } else {
        state.additionalProfiles.delete(id);
      }
      return { outcome: "DELETION_OUTCOME_COMPLETED" };
    },
    GetProviderProfile: (input) => {
      const profile = profileFor(String(input.id));
      return profile && { profile };
    },
    ListProviderProfiles: (input) => {
      assert.equal(record(input.workspace_scope).workspace, placedNamespace.name);
      return {
        profiles: [...(state.profile ? [state.profile] : []), ...state.additionalProfiles.values()],
      };
    },
    GetSandboxConfig: () => state.config,
    GetSandboxPolicyStatus: () => state.policyStatus,
    UpdateConfig: (input) => {
      state.policyUpdates.push(input);
      const target = liveSandbox(String(input.sandbox));
      assert.ok(target);
      assert.equal(input.expected_resource_version, target.metadata.resource_version);
      const source = structuredClone(record(input.policy));
      const stopped = target.status.phase === "SANDBOX_PHASE_STOPPED";
      if (!stopped) {
        target.spec.policy = source;
      }
      target.metadata.resource_version = String(BigInt(target.metadata.resource_version) + 1n);
      const version = Number(record(state.policyStatus!.revision).version) + 1;
      state.policyStatus = {
        revision: {
          version,
          status: stopped ? "POLICY_STATUS_PENDING" : "POLICY_STATUS_LOADED",
          policy: source,
          policy_hash: "a".repeat(64),
        },
        ...(stopped ? {} : { active_version: version }),
      };
      if (state.config) {
        const effective = structuredClone(source);
        for (const rule of Object.values(record(effective.network_policies))) {
          for (const endpoint of record(rule).endpoints as Wire[]) {
            if (endpoint.credential_binding) {
              endpoint.provider_credentialed = true;
            }
          }
        }
        if (state.policyUpdateReadback === "widened") {
          record(effective.network_policies).unexpected_github = {
            name: "unexpected_github",
            binaries: [{ path: "/usr/bin/curl" }],
            endpoints: [{ host: "github.com", ports: [443] }],
          };
        }
        Object.assign(state.config, { policy: effective, version, configuration_admitted: true });
        if (target.status.configuration_admission) {
          record(target.status.configuration_admission).policy_version = version;
        }
      }
      return { version };
    },
    GetSandboxProviderStatus: (input) => {
      state.statusReads.push(input);
      const detach = state.detachReceipts.get(String(input.receipt_id));
      if (detach) {
        assert.equal(input.sandbox, record(detach.desired).sandbox);
        assert.equal(input.provider, detach.provider);
        assert.equal(record(input.workspace_scope).workspace, detach.workspace);
        return { status: { state: "PROVIDER_READINESS_STATE_REVOKED", receipt: detach } };
      }
      const status = providerStatusFor(String(input.provider));
      if (!status) {
        return undefined;
      }
      if (input.receipt_id !== undefined) {
        if (input.receipt_id !== record(status.receipt).receipt_id) {
          return undefined;
        }
        const received = structuredClone(status);
        if (received.state === "PROVIDER_READINESS_STATE_PENDING") {
          if (state.updateReadiness === "converge") {
            // The Gateway first reports PENDING; the controlled supervisor then installs v2.
            advanceProviderEnvironment(status);
          } else if (state.updateReadiness === "cancel-pending") {
            setImmediate(() => state.abortOnPending?.());
          }
        }
        return { status: received };
      }
      // A provider-only query creates a new Gateway-owned OBSERVE receipt.
      const receiptId = randomUUID();
      const receipt = record(status.receipt);
      receipt.receipt_id = receiptId;
      receipt.mutation_id = receiptId;
      receipt.kind = "PROVIDER_MUTATION_KIND_OBSERVE";
      if (status.operation) {
        record(status.operation).operation_id = receiptId;
      }
      return { status };
    },
    ImportProviderProfiles: (input) => {
      const profiles = input.profiles as Wire[];
      const profile: Wire = {
        ...record(profiles[0]?.profile),
        resource_version: "1",
        scope: "workspace",
      };
      if (!state.profile) {
        state.profile = profile;
      } else {
        state.additionalProfiles.set(String(profile.id), profile);
      }
      return { imported: true };
    },
    CreateProvider: (input) => {
      const supplied = record(input.provider);
      const metadata = record(supplied.metadata);
      state.creates.push(input);
      const provider: Provider = {
        metadata: {
          ...metadata,
          id: state.creates.length === 1 ? "f1d7e6c5-1b2a-4c3d-8e9f-102938475602" : randomUUID(),
          name: String(metadata.name),
          workspace: placedNamespace.name,
          resource_version: "7",
          labels: metadata.labels as Record<string, string>,
        },
        type: String(supplied.type),
        profile_workspace: String(supplied.profile_workspace),
        config: supplied.config as Record<string, string>,
      };
      if (!state.provider) {
        state.provider = provider;
      } else {
        state.additionalProviders.set(provider.metadata.name, provider);
      }
      if (state.createMode === "stale-winner") {
        provider.config = { oce_source_version: "source-v0" };
        throw Object.assign(new Error("already exists"), { code: grpc.status.ALREADY_EXISTS });
      }
      return { provider };
    },
    UpdateProvider: (input) => {
      state.updates.push(input);
      const supplied = record(input.provider);
      const metadata = record(supplied.metadata);
      const name = String(metadata.name);
      const provider = providerFor(name);
      if (!provider || metadata.resource_version !== provider.metadata.resource_version) {
        throw Object.assign(new Error("Provider resource version changed"), {
          code: grpc.status.ABORTED,
        });
      }
      provider.config = {
        ...provider.config,
        ...(supplied.config as Record<string, string> | undefined),
      };
      provider.metadata.resource_version = String(BigInt(provider.metadata.resource_version) + 1n);
      const mutationId = randomUUID();
      const receipts: Wire[] = [];
      if (sandbox.spec.providers.includes(name)) {
        const prior = providerStatusFor(name);
        assert.ok(
          prior || sandbox.status.configuration_activated === false,
          "An attached Provider update needs either an idle target or simulated supervisor evidence.",
        );
        const receiptId = randomUUID();
        const time = { seconds: String(Math.floor(Date.now() / 1_000)), nanos: 0 };
        const priorDesired = prior && record(record(prior.receipt).desired);
        // A persisted update advances the generation even when its supervisor evidence is stale.
        const priorRevision = BigInt(String(priorDesired?.provider_env_revision ?? 0));
        const loadedRevision = BigInt(String(state.config?.provider_env_revision ?? 0));
        const lastRevision = priorRevision > loadedRevision ? priorRevision : loadedRevision;
        const desired = {
          ...(priorDesired ?? {
            sandbox_id: sandbox.metadata.id,
            sandbox: sandbox.metadata.name,
            attachment_epoch: sandbox.spec.provider_attachment_epoch,
            provider_id: provider.metadata.id,
          }),
          provider_resource_version: provider.metadata.resource_version,
          ...(priorDesired && {
            provider_env_revision: String(lastRevision + 1n),
          }),
        };
        const receipt = {
          receipt_id: receiptId,
          mutation_id: mutationId,
          provider: name,
          workspace: placedNamespace.name,
          kind: "PROVIDER_MUTATION_KIND_UPDATE",
          desired,
          persisted_time: time,
        };
        receipts.push(receipt);
        if (prior) {
          const observed = { ...record(prior.observed) };
          // Controlled Gateway admission and supervisor evidence advance only when v2 serves.
          const updated = {
            ...prior,
            state:
              state.updateReadiness === "stale-ready"
                ? "PROVIDER_READINESS_STATE_READY"
                : "PROVIDER_READINESS_STATE_PENDING",
            receipt,
            operation: { operation_id: receiptId, state: 2, outcome: 1, completed_time: time },
            observed,
            observed_time: time,
            evaluated_time: time,
          };
          if (state.provider === provider) {
            state.providerStatus = updated;
          } else {
            state.additionalProviderStatuses.set(name, updated);
          }
        }
      }
      return { provider, mutation_id: mutationId, target_receipts: receipts };
    },
    AttachSandboxProvider: (input) => {
      state.attaches.push(input);
      if (state.attachMode === "permission-denied" || state.attachMode === "admission-limit") {
        throw Object.assign(new Error("upstream-private-detail"), {
          code:
            state.attachMode === "permission-denied"
              ? grpc.status.PERMISSION_DENIED
              : grpc.status.RESOURCE_EXHAUSTED,
          details:
            state.attachMode === "admission-limit"
              ? "caller has reached the durable mutation admission limit; upstream-private-detail"
              : "upstream-private-detail",
        });
      }
      const target = liveSandbox(String(input.sandbox));
      assert.ok(target);
      if (state.attachMode === "cas-race") {
        target.metadata.resource_version = "6";
      }
      if (state.attachMode === "incarnation-race") {
        // Native attach resolves the name again, so a new ID can have the same version.
        target.metadata.id = "f1d7e6c5-1b2a-4c3d-8e9f-102938475603";
      }
      if (input.expected_resource_version !== target.metadata.resource_version) {
        throw Object.assign(new Error("resource version changed"), {
          code: grpc.status.ABORTED,
        });
      }
      const provider = String(input.provider);
      const attachedProvider = providerFor(provider);
      assert.ok(attachedProvider);
      const providerId = attachedProvider.metadata.id;
      const providerResourceVersion = attachedProvider.metadata.resource_version;
      const mutationId = randomUUID();
      target.spec.providers.push(provider);
      target.spec.provider_attachment_epoch = mutationId;
      target.metadata.resource_version = String(BigInt(target.metadata.resource_version) + 1n);
      if (state.attachMode === "provider-race") {
        attachedProvider.metadata.resource_version = "8";
      }
      const receipt = {
        receipt_id: randomUUID(),
        mutation_id: mutationId,
        provider,
        workspace: placedNamespace.name,
        kind: "PROVIDER_MUTATION_KIND_ATTACH",
        desired: {
          sandbox_id: target.metadata.id,
          sandbox: target.metadata.name,
          attachment_epoch:
            state.attachMode === "receipt-epoch-mismatch" ? randomUUID() : mutationId,
          provider_id:
            state.attachMode === "receipt-provider-id-mismatch"
              ? "f1d7e6c5-1b2a-4c3d-8e9f-102938475604"
              : providerId,
          provider_resource_version: providerResourceVersion,
        },
        persisted_time: {
          seconds: "1790000000",
          nanos: state.attachMode === "invalid-receipt-time" ? 1_000_000_000 : 123,
        },
      };
      return {
        sandbox: target,
        attached: true,
        ...(state.attachMode === "missing-receipt" ? {} : { receipt }),
      };
    },
  };
  const options = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  };
  const production = openShellService(
    grpc.loadPackageDefinition(
      loader.loadSync(
        join(
          import.meta.dirname,
          "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
        ),
        options,
      ),
    ),
  );
  const independent = openShellService(
    grpc.loadPackageDefinition(
      loader.loadSync(
        join(import.meta.dirname, "../fixtures/openshell-managed-workspace-wire.proto"),
        options,
      ),
    ),
  );
  const service: Grpc.ServiceDefinition = Object.fromEntries(
    Object.keys(methods).map((name) => {
      const definition =
        name === "AttachSandboxProvider" || name === "StopSandbox"
          ? independent[name]
          : production[name];
      assert.ok(definition);
      return [name, definition];
    }),
  );
  const server = new grpc.Server();
  server.addService(
    service,
    Object.fromEntries(
      Object.entries(methods).map(([name, handler]) => [
        name,
        (call: { request: Wire }, done: Grpc.sendUnaryData<Wire>) => {
          try {
            const reply = handler(call.request);
            done(reply ? null : { code: grpc.status.NOT_FOUND }, reply);
          } catch (error) {
            done(error as Error);
          }
        },
      ]),
    ),
  );
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({
    endpoint: `127.0.0.1:${port}`,
  });
  t.after(() => {
    client.close();
    server.forceShutdown();
  });
  const runtimeProvider = "fixture-runtime-files";
  const selectedSandbox = {
    id: "sandbox",
    implementation: "openshell",
    gitRuntimeProviderName: () => runtimeProvider,
    harnessResource: ({ revision }: { revision: { agentId: string; id: string } }) => ({
      namespaceName: placedNamespace.name,
      resourceName:
        sandboxes.find(
          (candidate) =>
            candidate.metadata.annotations["openclaw.dev/agent-id"] === revision.agentId &&
            candidate.metadata.annotations["openclaw.dev/revision-id"] === revision.id,
        )?.metadata.name ?? sandbox.metadata.name,
      agentId: revision.agentId,
      revisionId: revision.id,
    }),
    async withdrawStagedCredentialRoute(
      _context: CredentialDeploymentContext,
      sandboxId: string,
      bindingRef: string,
    ) {
      // The test supplies policy readback. The Sandbox suite verifies policy reduction itself.
      state.routeWithdrawals.push({ sandboxId, bindingRef });
    },
  } as unknown as SandboxDriver &
    Pick<
      import("../../apps/controller/src/drivers/sandbox/openshell.ts").OpenShellSandboxDriver,
      "gitRuntimeProviderName" | "withdrawStagedCredentialRoute"
    >;
  const backend: Backend<OpenShellGateway> = {
    id: "backend",
    client: new OpenShellGateway({ serviceName: "openshell" }, { gatewayClient: client }),
    drivers: { sandbox: selectedSandbox.id },
  };
  const createProxy = (tokenServiceImplementation: string) =>
    new OpenShellCredentialProxyDriver({
      id: selectedSandbox.id,
      implementation: selectedSandbox.implementation,
      backend,
      sandbox: selectedSandbox,
      tokenServiceImplementation,
    });
  const proxy = createProxy("occ/token-service");
  proxy.bindSourceNamespaceResolver(async (sourceRef) => {
    assert.equal(sourceRef.namespaceId, namespace.id);
    return placedNamespace;
  });
  // Exercise the admitted runtime provider key separately from the catalog ModelProvider ID.
  // This controlled Gateway fixture does not qualify a real Agent or native enforcement.
  const revision = completeSandboxRevision({
    namespaceId: namespace.id,
    agentId: configuration.targetRef.agentId,
    id: configuration.targetRef.revisionId,
    sandboxDriverId: selectedSandbox.id,
    harness: { id: "codex", version: "1", mode: "dedicated" },
  });
  const context = {
    namespace: placedNamespace,
    revision: {
      ...revision,
      configurationId: configuration.configurationId,
      executionAdmission: { version: 8, mode: "standalone" },
      harness: { ...revision.harness, modelProviderId: "mp_catalog" },
      credentialDeployment: {
        driver: {
          id: selectedSandbox.id,
          implementation: "openshell",
          configurationId: "a".repeat(64),
        },
        proxyDriverId: proxy.id,
        networkAccessPolicy: { allowed: [request] },
        bindings: [binding],
        injectionPolicies: [injection],
      },
    },
    signal: t.signal,
  } satisfies CredentialDeploymentContext;
  let resolutions = 0;
  let resolvedCredential = { credential: "synthetic-material", version: "source-v1" };
  const suppliedBinding = {
    binding,
    resolveCredential: async () => {
      resolutions++;
      return resolvedCredential;
    },
  };
  const configure = (overrides: Partial<ConfigureInput> = {}) =>
    proxy.configureDeployment(context, {
      ...configuration,
      bindings: [suppliedBinding],
      injectionPolicies: [injection],
      ...overrides,
    });
  const notify = (version?: string, signal: AbortSignal = t.signal) =>
    proxy.notifyCredentialUpdated(
      { sourceRef: binding.sourceRef, ...(version === undefined ? {} : { version }) },
      suppliedBinding.resolveCredential,
      signal,
    );
  const observeServing = () => {
    assert.ok(state.provider);
    const provider = state.provider;
    const policyVersion = 7;
    const policyHash = "b".repeat(64);
    const configRevision = "11";
    const providerEnvRevision = "12";
    const instanceId = "f1d7e6c5-1b2a-4c3d-8e9f-102938475610";
    const processId = "f1d7e6c5-1b2a-4c3d-8e9f-102938475611";
    const networkId = "f1d7e6c5-1b2a-4c3d-8e9f-102938475613";
    const time = { seconds: String(Math.floor(Date.now() / 1_000)), nanos: 0 };
    const endpoint = {
      host: request.host,
      ports: [443],
      protocol: "rest",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      rules: [{ allow: { method: "POST", path: "/v1/responses" } }],
      credential_binding: { provider: provider.metadata.name },
      provider_credentialed: true,
    };
    // This is controlled Gateway state installed by the Sandbox owner, not a Proxy policy write.
    const rule = { name: "model", binaries: [{ path: request.binary }], endpoints: [endpoint] };
    const policy = { version: 1, network_policies: { model: rule } };
    sandbox.spec.policy = sourcePolicyFrom(policy);
    sandbox.status = {
      configuration_activated: true,
      main_process_instance_id: networkId,
      configuration_admission: {
        instance_id: instanceId,
        state: 2,
        policy_version: policyVersion,
        policy_hash: policyHash,
        config_revision: configRevision,
        provider_env_revision: providerEnvRevision,
      },
    };
    state.config = {
      policy,
      version: policyVersion,
      policy_hash: policyHash,
      config_revision: configRevision,
      provider_env_revision: providerEnvRevision,
      provider_attachment_epoch: sandbox.spec.provider_attachment_epoch,
      configuration_admitted: true,
      configuration_instance_id: instanceId,
      policy_source: 1,
      policy_validation_failure_mode: "fail_closed",
      workspace: placedNamespace.name,
    };
    state.policyStatus = {
      revision: {
        version: policyVersion,
        status: "POLICY_STATUS_LOADED",
        policy_hash: "a".repeat(64),
        policy: sourcePolicyFrom(policy),
      },
      active_version: policyVersion,
    };
    const receiptId = randomUUID();
    const desired = {
      sandbox_id: sandbox.metadata.id,
      sandbox: sandbox.metadata.name,
      attachment_epoch: sandbox.spec.provider_attachment_epoch,
      provider_id: provider.metadata.id,
      provider_resource_version: provider.metadata.resource_version,
      provider_env_revision: providerEnvRevision,
      config_revision: configRevision,
      policy_hash: policyHash,
    };
    // Stock proto3 omits the zero-valued reason from both observation and READY status.
    const observed = {
      session_id: "f1d7e6c5-1b2a-4c3d-8e9f-102938475612",
      sequence: "1",
      attachment_epoch: sandbox.spec.provider_attachment_epoch,
      provider_env_revision: providerEnvRevision,
      config_revision: configRevision,
      policy_hash: policyHash,
      credentials_installed: true,
      policy_active: true,
      launch_environment_installed: true,
      process_instance_id: processId,
    };
    state.providerStatus = {
      state: "PROVIDER_READINESS_STATE_READY",
      receipt: {
        receipt_id: receiptId,
        mutation_id: receiptId,
        kind: "PROVIDER_MUTATION_KIND_OBSERVE",
        workspace: placedNamespace.name,
        provider: provider.metadata.name,
        desired,
        persisted_time: time,
      },
      operation: { operation_id: receiptId, state: 2, outcome: 1, completed_time: time },
      observed,
      network_instance_id: networkId,
      observed_time: time,
      evaluated_time: time,
    };
    return { endpoint, rule, policy, desired, observed };
  };
  const removeCredentialRoute = () => {
    // Simulate the canonical Sandbox owner applying the next source/effective policy revision.
    const revision = record(state.policyStatus!.revision);
    for (const policy of [sandbox.spec.policy, state.config!.policy, revision.policy]) {
      Reflect.deleteProperty(record(record(policy).network_policies), "model");
    }
    const version = Number(state.config!.version) + 1;
    const configRevision = String(BigInt(String(state.config!.config_revision)) + 1n);
    const envRevision = String(BigInt(String(state.config!.provider_env_revision)) + 1n);
    const effectiveHash = "c".repeat(64);
    sandbox.metadata.resource_version = String(BigInt(sandbox.metadata.resource_version) + 1n);
    Object.assign(state.config!, {
      version,
      config_revision: configRevision,
      provider_env_revision: envRevision,
      policy_hash: effectiveHash,
    });
    Object.assign(revision, { version, policy_hash: "d".repeat(64) });
    state.policyStatus!.active_version = version;
    Object.assign(record(sandbox.status.configuration_admission), {
      policy_version: version,
      config_revision: configRevision,
      provider_env_revision: envRevision,
      policy_hash: effectiveHash,
    });
    state.providerStatus = undefined;
  };
  return {
    backend,
    client,
    proxy,
    createProxy,
    context,
    sandbox,
    sandboxes,
    state,
    runtimeProvider,
    suppliedBinding,
    configure,
    notify,
    observeServing,
    removeCredentialRoute,
    setResolvedCredential: (credential: string, version: string) => {
      resolvedCredential = { credential, version };
    },
    resolutions: () => resolutions,
  };
}

function addSecondSandboxTarget(f: Awaited<ReturnType<typeof fixture>>) {
  const target = secondConfiguration;
  const sandbox = structuredClone(f.sandbox);
  Object.assign(sandbox.metadata, {
    id: target.targetRef.sandboxId,
    name: "second-held-sandbox",
    resource_version: "5",
  });
  Object.assign(sandbox.metadata.labels, {
    "openclaw.dev/agent": target.targetRef.agentId,
    "openclaw.dev/revision": target.targetRef.revisionId,
  });
  Object.assign(sandbox.metadata.annotations, {
    "openclaw.dev/agent-id": target.targetRef.agentId,
    "openclaw.dev/revision-id": target.targetRef.revisionId,
    "openclaw.dev/configuration-id": target.configurationId,
  });
  sandbox.spec.providers = [];
  sandbox.spec.provider_attachment_epoch = "";
  f.sandboxes.push(sandbox);
  const context = {
    ...f.context,
    revision: {
      ...f.context.revision,
      agentId: target.targetRef.agentId,
      id: target.targetRef.revisionId,
      configurationId: target.configurationId,
    },
  } satisfies CredentialDeploymentContext;
  return { sandbox, context };
}

test("staged OpenShell Proxy accepts OCC TokenService and reuses its Provider without resolving again", async (t) => {
  const f = await fixture(t);
  const first = await f.configure();
  assert.deepEqual(first, {
    credentialProjections: [
      {
        bindingRef: binding.bindingRef,
        environment: "OPENAI_API_KEY",
        placeholder: { kind: "runtime" },
      },
    ],
  });
  assert.equal(f.resolutions(), 1);
  assert.equal(f.state.creates.length, 1);
  assert.deepEqual(record(f.state.creates[0]?.provider).credentials, {
    OPENAI_API_KEY: "synthetic-material",
  });
  assert.deepEqual(record(f.state.creates[0]?.provider).config, {
    oce_source_version: "source-v1",
  });
  assert.equal(f.state.attaches[0]?.expected_resource_version, "5");
  assert.equal(record(f.state.attaches[0]?.workspace_scope).workspace, namespace.name);
  assert.match(String(f.state.attaches[0]?.request_id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(await f.configure(), first);
  assert.equal(f.resolutions(), 1);
  assert.equal(f.state.creates.length, 1);
  assert.equal(f.state.attaches.length, 1);
  assert.equal(f.state.updates.length, 0);
});

test("native Proxy prepares one Codex account Provider for the three fixed model requests", async (t) => {
  const f = await fixture(t);
  const preset = resolveModelCredentialPreset({
    presetId: "builtin_codex",
    configuration: { agents: { defaults: { model: "codex/model-fixture" } } },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
  });
  assert.ok(preset);
  const executable =
    "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex";
  assert.ok(preset.binaries?.includes(executable));
  assert.deepEqual(
    preset.destinations.map(({ method, host, port, path }) => [method, host, port, path]),
    [
      ["POST", "chatgpt.com", 443, "/backend-api/codex/responses"],
      ["GET", "chatgpt.com", 443, "/backend-api/wham/accounts/check"],
      ["GET", "chatgpt.com", 443, "/backend-api/wham/config/bundle"],
    ],
  );
  const codexBinding = {
    ...binding,
    consumer: { kind: "model" as const, providerId: preset.providerId },
    projection: preset.projection,
  };
  const grant = {
    binary: executable,
    host: "chatgpt.com",
    ports: [{ from: 443, to: 443 }],
  };
  const requests = preset.destinations.map(({ method, path }) => ({
    ...grant,
    requestPolicy: { type: "http" as const, method, path },
  }));
  const policies = [{ bindingRef: "model", allowedRequests: requests }];
  const context: CredentialDeploymentContext = {
    ...f.context,
    revision: {
      ...f.context.revision,
      harnessAuth: {
        method: "credential_source",
        sourceId: binding.sourceRef.id,
        sourceType: "oauth2-refresh-token",
        tokenServiceInstanceId: "tokens",
      },
      credentialDeployment: {
        ...f.context.revision.credentialDeployment!,
        networkAccessPolicy: { allowed: [grant] },
        bindings: [codexBinding],
        injectionPolicies: policies,
      },
    },
  };
  const codexInput = {
    ...configuration,
    injectionPolicies: policies,
    bindings: [{ binding: codexBinding, resolveCredential: f.suppliedBinding.resolveCredential }],
  };
  const result = await f.proxy.configureDeployment(context, codexInput);
  assert.deepEqual(result.credentialProjections, [
    { bindingRef: "model", environment: "CODEX_ACCESS_TOKEN", placeholder: { kind: "runtime" } },
  ]);
  assert.equal(f.state.creates.length, 1);
  assert.deepEqual(record(f.state.creates[0]?.provider).credentials, {
    CODEX_ACCESS_TOKEN: "synthetic-material",
  });

  // Custody can commit while delivery still holds the previous version. A second
  // held Sandbox must wait for delivery before it can attach that Provider.
  const next = addSecondSandboxTarget(f);
  const nextContext = {
    ...context,
    revision: {
      ...context.revision,
      agentId: next.context.revision.agentId,
      id: next.context.revision.id,
      configurationId: next.context.revision.configurationId,
    },
  };
  const nextInput = { ...codexInput, ...secondConfiguration };
  f.setResolvedCredential("synthetic-replacement", "source-v2");
  await assert.rejects(f.proxy.configureDeployment(nextContext, nextInput), {
    name: ActivationPendingError.name,
    code: "CREDENTIAL_ACTIVATION_PENDING",
  });
  assert.deepEqual(next.sandbox.spec.providers, []);
  assert.equal(f.state.updates.length, 0, "preparation must leave renewal delivery to the API");

  f.sandbox.status.configuration_activated = false;
  await f.notify("source-v2");
  assert.deepEqual(await f.proxy.configureDeployment(nextContext, nextInput), result);
  assert.equal(f.state.creates.length, 1);
  assert.equal(f.state.updates.length, 1);
  assert.equal(next.sandbox.spec.providers.length, 1);
});

test("native Proxy delivers a managed Slack MCP binding and rejects broadened policy readback", async (t) => {
  const f = await fixture(t);
  const slack = managedMcpInstalls.find(({ id }) => id === "occ-plugin:slack@1.0.0");
  assert.ok(slack);
  const slot = slack.slotId;
  const sourceRef = { ...binding.sourceRef, id: "cs_slack" };
  const toolName = "slack_search_messages";
  const selection = {
    enabled: true,
    driverPolicy: {
      releaseSha256: slack.releaseSha256,
      credentials: { [slot]: sourceRef.id },
      toolNames: [toolName],
    },
  };
  const description = await new OCCPluginDriver().describeDeployment({
    plugin: { catalog: "driver", pluginId: slack.id },
    selection,
    connections: { [slot]: { default: sourceRef } },
  });
  const account = description.credentials[slot]?.default;
  assert.ok(account);
  const requests = description.networkRequirements
    .filter(({ id }) => account.networkRequirementIds.includes(id))
    .map(({ match }) => match);
  const plugin = {
    bindingRef: JSON.stringify(["plugin", slack.id, slot, "default"]),
    sourceRef: account.sourceRef,
    consumer: {
      kind: "plugin" as const,
      pluginId: slack.id,
      requirement: slot,
      connection: "default",
    },
    projection: account.projection,
  };
  const modelRequest = { ...request, binary: "/usr/local/bin/node" };
  const policies = [
    { ...injection, allowedRequests: [modelRequest] },
    { bindingRef: plugin.bindingRef, allowedRequests: requests },
  ];
  const context: CredentialDeploymentContext = {
    ...f.context,
    revision: {
      ...f.context.revision,
      harness: { ...f.context.revision.harness, id: "openclaw" },
      harnessAuth: {
        method: "credential_source",
        sourceId: binding.sourceRef.id,
        sourceType: "static",
        tokenServiceInstanceId: "tokens",
      },
      credentialSources: [binding.sourceRef, sourceRef].map(({ id }) => ({
        sourceId: id,
        sourceType: "static",
        tokenServiceInstanceId: "tokens",
      })),
      plugins: {
        driver: { id: "openclaw-plugin", implementation: "occ/openclaw-plugin" },
        plugins: { [slack.id]: selection },
      },
      credentialDeployment: {
        ...f.context.revision.credentialDeployment!,
        networkAccessPolicy: { allowed: [modelRequest, ...requests] },
        bindings: [binding, plugin],
        injectionPolicies: policies,
      },
    },
  };
  let pluginResolutions = 0;
  const configured = await f.proxy.configureDeployment(context, {
    ...configuration,
    bindings: [
      f.suppliedBinding,
      {
        binding: plugin,
        resolveCredential: async () => {
          pluginResolutions++;
          return { credential: "synthetic-slack-access-token", version: "slack-v1" };
        },
      },
    ],
    injectionPolicies: policies,
  });
  assert.deepEqual(
    configured.credentialProjections,
    [binding, plugin].map((current) => ({
      bindingRef: current.bindingRef,
      environment: current.projection.environment,
      placeholder: { kind: "runtime" },
    })),
  );
  assert.equal(f.resolutions(), 1);
  assert.equal(pluginResolutions, 1);
  assert.deepEqual(
    f.state.creates.map((creation) => record(creation.provider).credentials),
    [{ OPENAI_API_KEY: "synthetic-material" }, { SLACK_MCP_TOKEN: "synthetic-slack-access-token" }],
  );

  // The controlled Gateway supplies the loaded Sandbox policy and per-Provider serving evidence.
  const evidence = f.observeServing();
  const modelEndpoint = (record(evidence.rule).endpoints as Wire[])[0]!;
  modelEndpoint.path = modelRequest.requestPolicy.path;
  evidence.rule.binaries = [{ path: modelRequest.binary }];
  const pluginName = openShellProjectedCredentialProviderName(sourceRef.id, "SLACK_MCP_TOKEN");
  const pluginProvider = f.state.additionalProviders.get(pluginName);
  assert.ok(pluginProvider);
  assert.deepEqual(f.sandbox.spec.providers, [f.state.provider!.metadata.name, pluginName]);
  const mcpEndpoint = {
    host: "mcp.slack.com",
    path: "/mcp",
    ports: [443],
    protocol: "mcp",
    mcp: { strict_tool_names: true, versions: ["2025-03-26", "2025-06-18", "2025-11-25"] },
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    rules: [
      { allow: { method: "ping" } },
      { allow: { method: "initialize" } },
      { allow: { method: "notifications/initialized" } },
      { allow: { method: "tools/list" } },
      { allow: { method: "tools/call", params: { name: { glob: toolName } } } },
    ],
    credential_binding: { provider: pluginName },
    provider_credentialed: true,
  };
  record(evidence.policy.network_policies).slack = {
    name: "slack",
    binaries: [{ path: "/usr/local/bin/node" }],
    endpoints: [mcpEndpoint],
  };
  const publishPolicy = () => {
    const sourcePolicy = sourcePolicyFrom(evidence.policy);
    f.sandbox.spec.policy = sourcePolicy;
    record(f.state.policyStatus!.revision).policy = sourcePolicy;
  };
  publishPolicy();
  const pluginStatus = structuredClone(f.state.providerStatus!);
  const receipt = record(pluginStatus.receipt);
  receipt.provider = pluginName;
  Object.assign(record(receipt.desired), {
    provider_id: pluginProvider.metadata.id,
    provider_resource_version: pluginProvider.metadata.resource_version,
  });
  f.state.additionalProviderStatuses.set(pluginName, pluginStatus);
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), { state: "ready" });

  // A second tool would exceed the frozen selector even if both Gateway policy views agree.
  mcpEndpoint.rules.push({
    allow: { method: "tools/call", params: { name: { glob: "slack_delete_message" } } },
  });
  publishPolicy();
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });
});

test("native Proxy isolates model and Google Plugin delivery and rotates only the selected Source", async (t) => {
  const f = await fixture(t);
  const google = managedGoogleInstall;
  const slot = Object.keys(google.credentials)[0]!;
  const pluginSourceRef = { ...binding.sourceRef, id: "cs_google" };
  const selection = {
    enabled: true,
    driverPolicy: {
      releaseSha256: google.releaseSha256,
      credentials: { [slot]: pluginSourceRef.id },
    },
  };
  const described = await new OCCPluginDriver().describeDeployment({
    plugin: { catalog: "driver", pluginId: google.id },
    selection,
    connections: { [slot]: { default: pluginSourceRef } },
  });
  const credential = described.credentials[slot]?.default;
  assert.ok(credential);
  // The Proxy receives the exact authorized limit selected from the Plugin's reviewed routes.
  const pluginRequest = described.networkRequirements.find(
    ({ id, match }) =>
      credential.networkRequirementIds.includes(id) &&
      match.host === "www.googleapis.com" &&
      match.requestPolicy?.type === "http" &&
      match.requestPolicy.method === "GET" &&
      match.requestPolicy.path === "/drive/v3/files",
  )?.match;
  const discoveryRequest = described.networkRequirements.find(
    ({ id, match }) =>
      !credential.networkRequirementIds.includes(id) &&
      match.host === "www.googleapis.com" &&
      match.requestPolicy?.type === "http" &&
      match.requestPolicy.method === "GET" &&
      match.requestPolicy.path === "/discovery/v1/apis/drive/v3/rest",
  )?.match;
  assert.ok(pluginRequest && discoveryRequest);
  const plugin = {
    bindingRef: "google-default",
    sourceRef: pluginSourceRef,
    consumer: {
      kind: "plugin" as const,
      pluginId: google.id,
      requirement: slot,
      connection: "default",
    },
    projection: credential.projection,
  };
  const modelRequest = { ...request, binary: "/usr/local/bin/node" };
  const policies = [
    { ...injection, allowedRequests: [modelRequest] },
    { bindingRef: plugin.bindingRef, allowedRequests: [pluginRequest] },
  ];
  const context: CredentialDeploymentContext = {
    ...f.context,
    revision: {
      ...f.context.revision,
      harness: { ...f.context.revision.harness, id: "openclaw" },
      harnessAuth: {
        method: "credential_source",
        sourceId: binding.sourceRef.id,
        sourceType: "static",
        tokenServiceInstanceId: "tokens",
      },
      credentialSources: [
        {
          sourceId: binding.sourceRef.id,
          sourceType: "static",
          tokenServiceInstanceId: "tokens",
        },
        {
          sourceId: pluginSourceRef.id,
          sourceType: "oauth2-refresh-token",
          tokenServiceInstanceId: "tokens",
        },
      ],
      plugins: {
        driver: { id: "openclaw-plugin", implementation: "occ/openclaw-plugin" },
        plugins: { [google.id]: selection },
      },
      credentialDeployment: {
        ...f.context.revision.credentialDeployment!,
        networkAccessPolicy: { allowed: [modelRequest, pluginRequest, discoveryRequest] },
        bindings: [binding, plugin],
        injectionPolicies: policies,
      },
    },
  };
  // Supplying the model twice must not satisfy the two admitted bindings.
  await assert.rejects(
    f.proxy.configureDeployment(context, {
      ...configuration,
      bindings: [f.suppliedBinding, f.suppliedBinding],
      injectionPolicies: policies,
    }),
    DependencyUnavailableError,
  );
  // An idle target cannot configure the optional Plugin alone if the revision requires its model.
  await assert.rejects(
    f.proxy.configureDeployment(context, {
      ...configuration,
      bindings: [{ binding: plugin, resolveCredential: f.suppliedBinding.resolveCredential }],
      injectionPolicies: policies,
    }),
    DependencyUnavailableError,
  );
  assert.equal(f.resolutions(), 0);
  assert.equal(f.state.creates.length, 0);
  let pluginResolutions = 0;
  const configured = await f.proxy.configureDeployment(context, {
    ...configuration,
    bindings: [
      f.suppliedBinding,
      {
        binding: plugin,
        resolveCredential: async () => {
          pluginResolutions++;
          return { credential: "synthetic-google-token", version: "google-v1" };
        },
      },
    ],
    injectionPolicies: policies,
  });
  assert.deepEqual(
    configured.credentialProjections,
    [binding, plugin].map((current) => ({
      bindingRef: current.bindingRef,
      environment: current.projection.environment,
      placeholder: { kind: "runtime" },
    })),
  );
  assert.equal(f.resolutions(), 1);
  assert.equal(pluginResolutions, 1);
  assert.equal(f.state.creates.length, 2);
  assert.equal(f.state.attaches.length, 2);
  const modelName = f.state.provider!.metadata.name;
  const pluginProvider = [...f.state.additionalProviders.values()][0]!;
  const pluginName = pluginProvider.metadata.name;
  assert.notEqual(modelName, pluginName);
  assert.deepEqual(f.sandbox.spec.providers, [modelName, pluginName]);
  // An omitted admitted binding cannot be treated as withdrawn while its Provider remains attached.
  await assert.rejects(
    f.proxy.configureDeployment(context, {
      ...configuration,
      bindings: [f.suppliedBinding],
      injectionPolicies: policies,
    }),
    DependencyUnavailableError,
  );
  assert.deepEqual(
    f.state.creates.map((creation) => record(creation.provider).credentials),
    [
      { OPENAI_API_KEY: "synthetic-material" },
      { [plugin.projection.environment]: "synthetic-google-token" },
    ],
  );

  // The controlled Gateway source/effective policy and supervisor receipts stand in for native readback.
  const evidence = f.observeServing();
  const modelEndpoint = (
    record(record(evidence.policy.network_policies).model).endpoints as Wire[]
  )[0]!;
  modelEndpoint.path = modelRequest.requestPolicy.path;
  evidence.rule.binaries = [{ path: modelRequest.binary }];
  const pluginEndpoint = {
    host: pluginRequest.host,
    path: "/drive/v3/files",
    ports: [443],
    protocol: "rest",
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    rules: [{ allow: { method: "GET", path: "/drive/v3/files" } }],
    credential_binding: { provider: pluginName },
    provider_credentialed: true,
  };
  record(evidence.policy.network_policies).plugin = {
    name: "plugin",
    binaries: [{ path: pluginRequest.binary }],
    endpoints: [pluginEndpoint],
  };
  record(evidence.policy.network_policies).discovery = {
    name: "discovery",
    binaries: [{ path: pluginRequest.binary }],
    endpoints: [
      {
        host: pluginRequest.host,
        path: "/discovery/v1/apis/drive/v3/rest",
        ports: [443],
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        rules: [{ allow: { method: "GET", path: "/discovery/v1/apis/drive/v3/rest" } }],
      },
    ],
  };
  f.sandbox.spec.policy = sourcePolicyFrom(evidence.policy);
  record(f.state.policyStatus!.revision).policy = sourcePolicyFrom(evidence.policy);
  const pluginStatus = structuredClone(f.state.providerStatus!);
  const receipt = record(pluginStatus.receipt);
  receipt.provider = pluginName;
  Object.assign(record(receipt.desired), {
    provider_id: pluginProvider.metadata.id,
    provider_resource_version: pluginProvider.metadata.resource_version,
  });
  f.state.additionalProviderStatuses.set(pluginName, pluginStatus);
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), { state: "ready" });

  // A ready Plugin cannot establish deployment readiness after the required model has detached.
  const networks = record(evidence.policy.network_policies);
  f.sandbox.spec.providers = [pluginName];
  Reflect.deleteProperty(networks, "model");
  f.sandbox.spec.policy = sourcePolicyFrom(evidence.policy);
  record(f.state.policyStatus!.revision).policy = sourcePolicyFrom(evidence.policy);
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), { state: "pending" });
  f.sandbox.spec.providers = [modelName, pluginName];
  networks.model = evidence.rule;
  f.sandbox.spec.policy = sourcePolicyFrom(evidence.policy);
  record(f.state.policyStatus!.revision).policy = sourcePolicyFrom(evidence.policy);

  // The Google Source update leaves the separately authorized model Source untouched.
  await f.proxy.notifyCredentialUpdated(
    { sourceRef: pluginSourceRef, version: "google-v2" },
    async () => ({ credential: "synthetic-google-token-v2", version: "google-v2" }),
    t.signal,
  );
  const [rotation] = f.state.updates;
  assert.ok(rotation);
  assert.equal(f.state.updates.length, 1);
  const updated = record(rotation.provider);
  assert.equal(record(updated.metadata).name, pluginName);
  assert.deepEqual(updated.credentials, {
    [plugin.projection.environment]: "synthetic-google-token-v2",
  });
  assert.deepEqual(updated.config, { oce_source_version: "google-v2" });
  assert.deepEqual(f.state.provider!.config, { oce_source_version: "source-v1" });

  // A loaded route must use the projection for its own Source.
  pluginEndpoint.credential_binding.provider = modelName;
  f.sandbox.spec.policy = sourcePolicyFrom(evidence.policy);
  record(f.state.policyStatus!.revision).policy = sourcePolicyFrom(evidence.policy);
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });
  pluginEndpoint.credential_binding.provider = pluginName;
  const discoveryEndpoint = (
    record(record(evidence.policy.network_policies).discovery).endpoints as Wire[]
  )[0]!;
  discoveryEndpoint.path = "/drive/v3/files";
  f.sandbox.spec.policy = sourcePolicyFrom(evidence.policy);
  record(f.state.policyStatus!.revision).policy = sourcePolicyFrom(evidence.policy);
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });
  discoveryEndpoint.path = "/discovery/v1/apis/drive/v3/rest";
  Reflect.deleteProperty(record(evidence.policy.network_policies), "plugin");
  f.sandbox.spec.policy = sourcePolicyFrom(evidence.policy);
  record(f.state.policyStatus!.revision).policy = sourcePolicyFrom(evidence.policy);
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });

  // The Sandbox has withdrawn the Plugin route. Detaching its copy must leave the model attached.
  await f.proxy.removeDeployment(context, {
    targetRef: configuration.targetRef,
    bindingRefs: [plugin.bindingRef],
  });
  assert.deepEqual(f.state.routeWithdrawals, [
    { sandboxId: configuration.targetRef.sandboxId, bindingRef: plugin.bindingRef },
  ]);
  assert.deepEqual(
    f.state.detaches.map(({ provider }) => provider),
    [pluginName],
  );
  assert.deepEqual(
    f.state.deletes.map(({ name }) => name),
    [pluginName],
  );
  assert.deepEqual(f.sandbox.spec.providers, [modelName]);
  const detachRead = f.state.statusReads.at(-1)!;
  assert.equal(detachRead.provider, pluginName);
  assert.equal(f.state.detachReceipts.get(String(detachRead.receipt_id))?.provider, pluginName);
  assert.ok(f.state.profile);
  assert.equal(f.state.additionalProfiles.size, 0);

  // The Worker can configure exactly the retained authorized binding against the unchanged admission.
  const remaining = await f.proxy.configureDeployment(context, {
    ...configuration,
    bindings: [f.suppliedBinding],
    injectionPolicies: policies,
  });
  assert.deepEqual(remaining.credentialProjections, [configured.credentialProjections[0]]);
  assert.deepEqual(f.sandbox.spec.providers, [modelName]);

  // Controlled source/effective policy and supervisor receipts now represent the reduced deployment.
  const reduced = f.observeServing();
  record(reduced.endpoint).path = modelRequest.requestPolicy.path;
  reduced.rule.binaries = [{ path: modelRequest.binary }];
  record(reduced.policy.network_policies).discovery = structuredClone(
    record(evidence.policy.network_policies).discovery,
  );
  f.sandbox.spec.policy = sourcePolicyFrom(reduced.policy);
  record(f.state.policyStatus!.revision).policy = sourcePolicyFrom(reduced.policy);
  const admission = record(record(f.sandbox.status).configuration_admission);
  const currentProviderEnvironment = String(f.state.config!.provider_env_revision);
  const differentProviderEnvironment = String(BigInt(currentProviderEnvironment) - 1n);
  // The Provider environment is an opaque fingerprint; either numeric direction can be stale.
  admission.provider_env_revision = differentProviderEnvironment;
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), { state: "pending" });
  admission.provider_env_revision = String(BigInt(currentProviderEnvironment) + 1n);
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), { state: "pending" });
  admission.provider_env_revision = "invalid";
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });
  admission.provider_env_revision = currentProviderEnvironment;
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), { state: "ready" });

  // The post-detach effective policy must not reopen the withdrawn path as a public route.
  const staleRule = {
    name: "stale",
    binaries: [{ path: pluginRequest.binary }],
    endpoints: [{ ...discoveryEndpoint, path: pluginEndpoint.path, rules: pluginEndpoint.rules }],
  };
  record(reduced.policy.network_policies).stale = staleRule;
  admission.provider_env_revision = differentProviderEnvironment;
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });
  admission.provider_env_revision = currentProviderEnvironment;

  // A retained credential route for the withdrawn Provider is never accepted as readiness.
  staleRule.endpoints = [pluginEndpoint];
  f.sandbox.spec.policy = sourcePolicyFrom(reduced.policy);
  record(f.state.policyStatus!.revision).policy = sourcePolicyFrom(reduced.policy);
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });
});

test("OpenShell Source retry updates each owned copy in workspace inventory", async (t) => {
  const f = await fixture(t);
  await f.configure();
  const primary = f.state.provider!;
  const environment = "ALTERNATE_API_KEY";
  const name = openShellProjectedCredentialProviderName(binding.sourceRef.id, environment);
  // Represent a retained unattached copy in the Gateway inventory. No Agent admission is
  // implied for this copy, and only the attached Provider receives a serving receipt.
  await f.client.importProviderProfile(
    namespace.name,
    {
      id: name,
      displayName: "OCC credential delivery",
      category: "PROVIDER_PROFILE_CATEGORY_OTHER",
      credentials: [
        {
          name: environment,
          envVars: [environment],
          required: true,
          authStyle: "bearer",
          headerName: "authorization",
          stablePlaceholder: true,
        },
      ],
      endpoints: [],
      binaries: [],
      inferenceCapable: false,
      annotations: primary.metadata.labels,
    },
    t.signal,
  );
  await f.client.createProvider(
    {
      workspace: namespace.name,
      name,
      type: name,
      labels: primary.metadata.labels,
      credentials: { [environment]: "synthetic-material" },
      config: { oce_source_version: "source-v1" },
    },
    t.signal,
  );
  f.observeServing();
  f.setResolvedCredential("synthetic-material-v2", "source-v2");
  await f.notify("source-v2");
  const firstReceipt = f.state.statusReads.find(({ receipt_id }) => receipt_id)?.receipt_id;
  assert.ok(firstReceipt);
  const observedUpdates = f.state.statusReads.length;
  // An Agent's explicit delivery retry does not name a saved version and can repair every copy.
  await f.notify();
  assert.equal(f.resolutions(), 3, "each Source push resolves once regardless of copy count");
  for (const updates of [f.state.updates.slice(0, 2), f.state.updates.slice(2)]) {
    assert.deepEqual(
      updates.map(({ provider: value }) => {
        const provider = record(value);
        return [record(provider.metadata).name, provider.credentials, provider.config];
      }),
      [
        [
          primary.metadata.name,
          { OPENAI_API_KEY: "synthetic-material-v2" },
          { oce_source_version: "source-v2" },
        ],
        [name, { [environment]: "synthetic-material-v2" }, { oce_source_version: "source-v2" }],
      ],
    );
  }
  const retryStatusReads = f.state.statusReads.slice(observedUpdates);
  assert.ok(retryStatusReads.length > 0);
  assert.ok(
    retryStatusReads.every(
      ({ receipt_id, provider }) =>
        receipt_id && receipt_id !== firstReceipt && provider === primary.metadata.name,
    ),
  );
});

test("staged OpenShell Proxy rejects an unsupported TokenService before resolving or mutating the Gateway", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.createProxy("unsupported/token-service"), {
    message: "OpenShell credential delivery requires a supported TokenService implementation.",
  });
});

test("staged OpenShell Proxy attaches and detaches an authoritative Provider without copying it", async (t) => {
  const f = await fixture(t);
  const proxy = f.createProxy("openshell/token-service");
  const name = openShellProviderName(binding.sourceRef.id);
  const id = randomUUID();
  const provider = {
    metadata: {
      name,
      id,
      workspace: namespace.name,
      resource_version: "3",
      labels: {},
    },
    type: name,
    profile_workspace: namespace.name,
    config: {},
  };
  // TokenService verifies custody separately. This case exercises the Proxy against an
  // existing Provider and checks that Proxy cleanup leaves its owner's material in place.
  f.state.provider = provider;
  const purposes: string[] = [];
  proxy.bindNativeSourceResolver(
    async (
      source: CredentialSourceReference,
      _signal: AbortSignal,
      purpose: "delivery" | "withdrawal",
    ) => {
      assert.deepEqual(source, binding.sourceRef);
      purposes.push(purpose);
      return {
        workspace: namespace.name,
        workspaceId: "workspace-id",
        name,
        id,
        resourceVersion: "3",
        profileVersion: "1",
      };
    },
  );
  await proxy.configureDeployment(f.context, {
    ...configuration,
    bindings: [f.suppliedBinding],
    injectionPolicies: [injection],
  });
  assert.deepEqual(f.sandbox.spec.providers, [name]);
  f.observeServing();
  assert.deepEqual(await proxy.getDeploymentStatus(f.context, configuration), { state: "ready" });

  f.removeCredentialRoute();
  assert.ok(purposes.every((purpose) => purpose === "delivery"));
  await proxy.removeDeployment(f.context, { targetRef: configuration.targetRef });
  assert.equal(purposes.at(-1), "withdrawal");
  await proxy.retireSource(namespace, binding.sourceRef, t.signal);
  assert.deepEqual(f.sandbox.spec.providers, []);
  assert.equal(f.state.provider, provider);
  assert.equal(f.resolutions(), 0);
  assert.equal(f.state.creates.length, 0);
  assert.equal(f.state.deletes.length, 0);
});

test("OpenShell custody delivers a Codex PAT from its authoritative Source Provider", async (t) => {
  const f = await fixture(t);
  const proxy = f.createProxy("openshell/token-service");
  const preset = resolveModelCredentialPreset({
    presetId: "codex-pat",
    configuration: { agents: { defaults: { model: "codex/model-fixture" } } },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
  });
  assert.ok(preset?.binaries?.length);
  const binary = preset.binaries[0]!;
  const codex = {
    ...binding,
    consumer: { kind: "model" as const, providerId: preset.providerId },
    projection: preset.projection,
  };
  const grants = [...new Set(preset.destinations.map(({ host }) => host))].map((host) => ({
    binary,
    host,
    ports: [{ from: 443, to: 443 }],
  }));
  const requests = preset.destinations.map(({ host, method, path }) => ({
    binary,
    host,
    ports: [{ from: 443, to: 443 }],
    requestPolicy: { type: "http" as const, method, path },
  }));
  const policies = [{ bindingRef: "model", allowedRequests: requests }];
  const context: CredentialDeploymentContext = {
    ...f.context,
    revision: {
      ...f.context.revision,
      harnessAuth: {
        method: "credential_source",
        sourceId: codex.sourceRef.id,
        sourceType: "static",
        tokenServiceInstanceId: "tokens",
      },
      credentialDeployment: {
        ...f.context.revision.credentialDeployment!,
        networkAccessPolicy: { allowed: grants },
        bindings: [codex],
        injectionPolicies: policies,
      },
    },
  };
  const name = openShellProviderName(codex.sourceRef.id);
  const id = randomUUID();
  f.state.provider = {
    metadata: { name, id, workspace: namespace.name, resource_version: "3", labels: {} },
    type: name,
    profile_workspace: namespace.name,
    config: {},
  };
  proxy.bindNativeSourceResolver(async () => ({
    workspace: namespace.name,
    workspaceId: "workspace-id",
    name,
    id,
    resourceVersion: "3",
    profileVersion: "1",
  }));
  const prepared = await proxy.configureDeployment(context, {
    ...configuration,
    bindings: [{ binding: codex, resolveCredential: f.suppliedBinding.resolveCredential }],
    injectionPolicies: policies,
  });
  assert.deepEqual(prepared.credentialProjections, [
    { bindingRef: "model", environment: "CODEX_ACCESS_TOKEN", placeholder: { kind: "runtime" } },
  ]);
  assert.deepEqual(f.sandbox.spec.providers, [name]);
  assert.equal(f.resolutions(), 0);
  assert.equal(f.state.creates.length, 0);

  // Readiness requires OpenShell's loaded exact-route policy and serving receipt for the Source.
  const evidence = f.observeServing();
  const networks = record(evidence.policy.network_policies);
  Reflect.deleteProperty(networks, "model");
  for (const [
    index,
    {
      host,
      requestPolicy: { method, path },
    },
  ] of requests.entries()) {
    const ruleName = `model_${index}`;
    networks[ruleName] = {
      name: ruleName,
      binaries: [{ path: binary }],
      endpoints: [
        {
          host,
          path,
          ports: [443],
          protocol: "rest",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: [{ allow: { method, path } }],
          credential_binding: { provider: name },
          provider_credentialed: true,
        },
      ],
    };
  }
  f.sandbox.spec.policy = sourcePolicyFrom(evidence.policy);
  record(f.state.policyStatus!.revision).policy = sourcePolicyFrom(evidence.policy);
  assert.deepEqual(await proxy.getDeploymentStatus(context, configuration), { state: "ready" });
  record(f.state.policyStatus!.revision).status = "POLICY_STATUS_PENDING";
  assert.deepEqual(await proxy.getDeploymentStatus(context, configuration), { state: "pending" });
});

test("OpenShell Source notification leaves an absent delivery Provider absent", async (t) => {
  const f = await fixture(t);
  await f.notify("source-v2");
  assert.equal(f.resolutions(), 0);
  assert.equal(f.state.creates.length, 0);
  assert.equal(f.state.updates.length, 0);
});

test("OpenShell Source notification refuses a version that differs from resolved custody", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.setResolvedCredential("synthetic-material-v3", "source-v3");

  await assert.rejects(f.notify("source-v2"), DependencyUnavailableError);
  assert.equal(f.state.updates.length, 0);
  assert.equal(f.state.provider!.config.oce_source_version, "source-v1");
});

test("OpenShell Source notification rejects a mismatched Source Namespace placement", async (t) => {
  const f = await fixture(t);
  const proxy = f.createProxy("occ/token-service");
  proxy.bindSourceNamespaceResolver(async () => ({ ...namespace, id: "other-namespace" }));

  // Placement must resolve the same canonical Namespace as the Source before any custody read
  // or Gateway mutation; the selected Proxy cannot treat another ready Namespace as equivalent.
  await assert.rejects(
    proxy.notifyCredentialUpdated(
      { sourceRef: binding.sourceRef, version: "source-v2" },
      f.suppliedBinding.resolveCredential,
      t.signal,
    ),
    DependencyUnavailableError,
  );
  assert.equal(f.resolutions(), 0);
  assert.equal(f.state.creates.length, 0);
  assert.equal(f.state.updates.length, 0);
  assert.equal(f.state.attaches.length, 0);
  assert.equal(f.state.detaches.length, 0);
});

test("OpenShell Source notification updates an attached Sandbox before its first activation", async (t) => {
  const f = await fixture(t);
  await f.configure();
  // The target has never been activated: Gateway admission is still pending and no supervisor
  // can report READY yet. The idle target still receives its own UPDATE mutation receipt.
  f.sandbox.status = {
    phase: "SANDBOX_PHASE_PROVISIONING",
    configuration_activated: false,
    configuration_admission: { instance_id: randomUUID(), state: 1, policy_version: 1 },
  };
  f.setResolvedCredential("synthetic-material-v2", "source-v2");
  await f.notify("source-v2");

  assert.equal(f.state.updates.length, 1);
  assert.equal(f.state.statusReads.length, 0);
});

test("OpenShell Source notification updates an attached Provider copy and confirms its target receipt", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.observeServing();
  const profile = structuredClone(f.state.profile);
  assert.equal((f.state.profile!.credentials as Wire[])[0]!.stable_placeholder, true);

  // Simulate TokenService's authoritative Source update; this client/server fixture proves the native
  // Proxy's UpdateProvider protocol, not propagation into a live running Harness.
  f.setResolvedCredential("synthetic-material-v2", "source-v2");
  await f.notify("source-v2");

  assert.equal(f.resolutions(), 2);
  assert.equal(f.state.updates.length, 1);
  const update = record(f.state.updates[0]!.provider);
  assert.deepEqual(record(update.metadata), {
    name: f.state.provider!.metadata.name,
    resource_version: "7",
  });
  assert.deepEqual(update.credentials, { OPENAI_API_KEY: "synthetic-material-v2" });
  assert.deepEqual(update.config, { oce_source_version: "source-v2" });
  assert.deepEqual(f.state.profile, profile);
  assert.equal(f.state.creates.length, 1);
  assert.equal(f.state.attaches.length, 1);
  assert.equal(f.state.detaches.length, 0);
  const receiptQueries = f.state.statusReads.map((read) => read.receipt_id);
  assert.ok(receiptQueries.length >= 2);
  assert.equal(new Set(receiptQueries).size, 1);
  assert.equal(typeof receiptQueries[0], "string");
});

test("OpenShell Source notification rejects stale readiness and can retry the persisted version", async (t) => {
  for (const readiness of ["cancel-pending", "stale-ready"] as const) {
    await t.test(readiness, async (t) => {
      const f = await fixture(t);
      await f.configure();
      f.observeServing();
      f.state.updateReadiness = readiness;
      f.setResolvedCredential("synthetic-material-v2", "source-v2");

      // The Gateway has persisted v2, but its supervisor still reports the v1 environment.
      // Cancel from controlled PENDING evidence; a stale READY must also fail closed.
      if (readiness === "cancel-pending") {
        const controller = new AbortController();
        f.state.abortOnPending = () => controller.abort();
        await assert.rejects(
          f.notify("source-v2", controller.signal),
          (error: unknown) => error instanceof Error && controller.signal.aborted,
        );
      } else {
        await assert.rejects(f.notify("source-v2"), DependencyUnavailableError);
      }
      assert.equal(f.state.updates.length, 1);
      assert.equal(f.state.provider!.config.oce_source_version, "source-v2");
      assert.equal(
        record(record(f.state.providerStatus!.receipt).desired).provider_env_revision,
        "13",
      );
      assert.equal(record(f.state.providerStatus!.observed).provider_env_revision, "12");

      if (readiness === "stale-ready") {
        const provider = structuredClone(f.state.provider!);
        const failedReceiptId = record(f.state.providerStatus!.receipt).receipt_id;

        // Matching Source and Provider versions do not prove the current environment is serving.
        await assert.rejects(f.notify("source-v2"), DependencyUnavailableError);
        assert.equal(f.state.updates.length, 1);

        // The supervisor can catch up to the existing generation while the Proxy polls its receipt.
        f.state.providerStatus!.state = "PROVIDER_READINESS_STATE_PENDING";
        f.state.updateReadiness = "converge";
        const statusReadsBeforeRetry = f.state.statusReads.length;
        await f.notify("source-v2");

        assert.equal(f.state.updates.length, 1);
        assert.equal(f.state.creates.length, 1);
        assert.deepEqual(f.state.provider, provider);
        const observation = record(f.state.providerStatus!.receipt);
        assert.equal(observation.kind, "PROVIDER_MUTATION_KIND_OBSERVE");
        assert.notEqual(observation.receipt_id, failedReceiptId);
        assert.equal(record(f.state.providerStatus!.observed).provider_env_revision, "13");
        const [initialRead, ...receiptPolls] = f.state.statusReads.slice(statusReadsBeforeRetry);
        assert.ok(initialRead);
        assert.equal(initialRead.receipt_id, undefined);
        assert.ok(receiptPolls.length > 0);
        assert.deepEqual(
          [...new Set(receiptPolls.map(({ receipt_id }) => receipt_id))],
          [observation.receipt_id],
        );
      }
    });
  }
});

test("OpenShell Source notification updates an unattached Provider after failed cleanup", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.observeServing();

  // A failed native deletion leaves the now-unattached Provider for retry. Source update must
  // still work when OpenShell omits the empty target receipt list.
  f.removeCredentialRoute();
  f.state.deleteMode = "unavailable";
  await assert.rejects(
    f.proxy.removeDeployment(f.context, { targetRef: configuration.targetRef }),
    DependencyUnavailableError,
  );
  f.state.deleteMode = "normal";
  f.setResolvedCredential("synthetic-material-v2", "source-v2");
  await f.notify("source-v2");

  assert.equal(f.resolutions(), 2);
  assert.equal(f.state.updates.length, 1);
  assert.equal(f.state.creates.length, 1);
  assert.equal(f.state.attaches.length, 1);
  assert.deepEqual(f.sandbox.spec.providers, []);
});

test("staged OpenShell Proxy creates a fresh Provider for the next deployment after last detach", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.observeServing();
  assert.deepEqual(await f.proxy.getDeploymentStatus(f.context, configuration), { state: "ready" });
  const originalProvider = structuredClone(f.state.provider!);

  // The Sandbox owner removes the old policy rule before target cleanup clears the last binding.
  f.removeCredentialRoute();
  await f.proxy.removeDeployment(f.context, { targetRef: configuration.targetRef });
  assert.deepEqual(f.sandbox.spec.providers, []);
  assert.equal(f.state.provider, undefined);
  const nextConfiguration = {
    targetRef: {
      ...configuration.targetRef,
      revisionId: "revision-2",
      sandboxId: "f1d7e6c5-1b2a-4c3d-8e9f-102938475620",
    },
    configurationId: "configuration-2",
  };
  const nextContext = {
    ...f.context,
    revision: {
      ...f.context.revision,
      id: nextConfiguration.targetRef.revisionId,
      revision: 2,
      configurationId: nextConfiguration.configurationId,
      configurationGeneration: 2,
      servicePrincipalId: "sp_revision_2",
    },
  } satisfies CredentialDeploymentContext;
  Object.assign(f.sandbox.metadata, {
    id: nextConfiguration.targetRef.sandboxId,
    name: "next-held-sandbox",
    resource_version: "5",
  });
  f.sandbox.metadata.labels["openclaw.dev/revision"] = nextConfiguration.targetRef.revisionId;
  f.sandbox.metadata.annotations["openclaw.dev/revision-id"] =
    nextConfiguration.targetRef.revisionId;
  f.sandbox.metadata.annotations["openclaw.dev/configuration-id"] =
    nextConfiguration.configurationId;
  f.sandbox.spec.provider_attachment_epoch = "";
  f.sandbox.spec.policy = undefined;
  f.sandbox.status = {};
  f.state.config = undefined;
  f.state.policyStatus = undefined;
  f.state.providerStatus = undefined;

  await f.proxy.configureDeployment(nextContext, {
    ...nextConfiguration,
    bindings: [f.suppliedBinding],
    injectionPolicies: [injection],
  });
  assert.equal(f.resolutions(), 2);
  assert.equal(f.state.creates.length, 2);
  assert.equal(f.state.updates.length, 0);
  const recreated = await f.client.getProvider(
    namespace.name,
    originalProvider.metadata.name,
    t.signal,
  );
  assert.ok(recreated);
  assert.notEqual(recreated.id, originalProvider.metadata.id);
  assert.deepEqual(f.sandbox.spec.providers, [originalProvider.metadata.name]);

  // The new target is not ready until its supervisor installs the admitted Provider environment.
  const evidence = f.observeServing();
  f.state.config!.provider_env_revision = "13";
  record(f.sandbox.status.configuration_admission).provider_env_revision = "13";
  evidence.desired.provider_env_revision = "13";
  f.state.providerStatus!.state = "PROVIDER_READINESS_STATE_PENDING";
  f.state.providerStatus!.reason = "PROVIDER_READINESS_REASON_SNAPSHOT_MISMATCH";
  const readyOperation = f.state.providerStatus!.operation;
  Reflect.deleteProperty(f.state.providerStatus!, "operation");
  assert.deepEqual(await f.proxy.getDeploymentStatus(nextContext, nextConfiguration), {
    state: "pending",
  });
  assert.equal(evidence.desired.provider_resource_version, "7");
  evidence.observed.provider_env_revision = "13";
  f.state.providerStatus!.state = "PROVIDER_READINESS_STATE_READY";
  f.state.providerStatus!.operation = readyOperation;
  Reflect.deleteProperty(f.state.providerStatus!, "reason");
  assert.deepEqual(await f.proxy.getDeploymentStatus(nextContext, nextConfiguration), {
    state: "ready",
  });
});

test("staged OpenShell Proxy rejects the wrong target before source resolution", async (t) => {
  const f = await fixture(t);
  const wrong = {
    ...configuration,
    targetRef: { ...configuration.targetRef, sandboxId: "other-sandbox" },
  };
  await assert.rejects(f.configure(wrong), DependencyUnavailableError);
  assert.equal(f.resolutions(), 0);
  assert.equal(f.state.creates.length, 0);
});

test("staged OpenShell Proxy validates direct deployment policy and binding inputs before resolving", async (t) => {
  const f = await fixture(t);
  const deployInput = {
    deployment: {
      namespaceId: namespace.id,
      agentId: configuration.targetRef.agentId,
      revisionId: configuration.targetRef.revisionId,
    },
    networkAccessPolicy: { allowed: [request] },
    injectionPolicies: [injection],
  };
  assert.deepEqual(await f.proxy.deployProxy(f.context, deployInput), {});
  assert.deepEqual(
    await f.proxy.deployProxy(f.context, {
      ...deployInput,
      networkAccessPolicy: {
        allowed: [{ binary: request.binary, host: request.host, ports: request.ports }],
      },
    }),
    {},
  );
  await assert.rejects(
    f.proxy.deployProxy(f.context, { ...deployInput, networkAccessPolicy: { allowed: [] } }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    f.proxy.configureDeployment(
      {
        ...f.context,
        revision: {
          ...f.context.revision,
          harness: { ...f.context.revision.harness, mode: "embedded" },
        },
      },
      { ...configuration, bindings: [f.suppliedBinding], injectionPolicies: [injection] },
    ),
    DependencyUnavailableError,
  );
  await assert.rejects(
    f.configure({
      bindings: [
        {
          ...f.suppliedBinding,
          binding: {
            ...binding,
            sourceRef: { ...binding.sourceRef, namespaceId: "other-namespace" },
          },
        },
      ],
    }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    f.configure({
      bindings: [
        {
          ...f.suppliedBinding,
          binding: {
            ...binding,
            consumer: { ...binding.consumer, providerId: "other-model-provider" },
          },
        },
      ],
    }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    f.configure({ injectionPolicies: [{ ...injection, bindingRef: "other-binding" }] }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    f.configure({
      injectionPolicies: [
        {
          ...injection,
          allowedRequests: [
            {
              ...request,
              requestPolicy: { type: "http", method: "POST", path: "/v1/chat/completions" },
            },
          ],
        },
      ],
    }),
    DependencyUnavailableError,
  );
  assert.equal(f.resolutions(), 0);
  assert.equal(f.state.creates.length, 0);
});

test("staged OpenShell Proxy refuses unusable first-use resolver material before Provider creation", async (t) => {
  for (const scenario of [
    { name: "empty credential", resolved: { credential: "", version: "source-v1" } },
    { name: "missing source version", resolved: { credential: "synthetic-material" } },
  ] as const) {
    await t.test(scenario.name, async (child) => {
      const f = await fixture(child);
      let resolverCalls = 0;
      await assert.rejects(
        f.configure({
          bindings: [
            {
              binding,
              resolveCredential: async () => {
                resolverCalls++;
                return scenario.resolved;
              },
            },
          ],
        }),
        DependencyUnavailableError,
      );
      assert.equal(resolverCalls, 1);
      assert.equal(f.state.provider, undefined);
      assert.equal(f.state.creates.length, 0);
      assert.equal(f.state.attaches.length, 0);
      assert.equal(f.state.updates.length, 0);
    });
  }
});

test("staged OpenShell Proxy refuses attachment and Provider races", async (t) => {
  for (const mode of ["cas-race", "provider-race", "receipt-provider-id-mismatch"] as const) {
    await t.test(mode, async (child) => {
      const f = await fixture(child);
      f.state.attachMode = mode;
      await assert.rejects(f.configure(), DependencyUnavailableError);
      assert.equal(f.state.attaches[0]?.expected_resource_version, "5");
      assert.equal(f.resolutions(), 1);
      if (mode === "cas-race") {
        assert.equal(f.state.provider, undefined);
        assert.equal(f.state.profile, undefined);
      }
      if (mode === "receipt-provider-id-mismatch") {
        assert.equal(f.state.provider?.metadata.id, "f1d7e6c5-1b2a-4c3d-8e9f-102938475602");
        assert.equal(f.state.provider?.metadata.resource_version, "7");
      }
    });
  }
});

test("staged OpenShell Proxy refuses missing or malformed native attachment receipts", async (t) => {
  for (const mode of [
    "missing-receipt",
    "invalid-receipt-time",
    "receipt-epoch-mismatch",
  ] as const) {
    await t.test(mode, async (child) => {
      const f = await fixture(child);
      f.state.attachMode = mode;
      await assert.rejects(f.configure(), DependencyUnavailableError);
      assert.equal(f.state.attaches.length, 1);
    });
  }
});

test("staged OpenShell Proxy preserves typed admission refusals without exposing Gateway details", async (t) => {
  for (const mode of ["permission-denied", "admission-limit"] as const) {
    await t.test(mode, async (child) => {
      const f = await fixture(child);
      f.state.attachMode = mode;
      await assert.rejects(f.configure(), (error: unknown) => {
        assert.ok(error instanceof Error);
        if (mode === "admission-limit") {
          assert.ok(error instanceof OpenShellAdmissionLimitError);
        } else {
          assert.ok(error instanceof DependencyUnavailableError);
        }
        assert.doesNotMatch(String(error), /upstream-private-detail/);
        if (error.cause instanceof Error) {
          assert.doesNotMatch(String(error.cause), /upstream-private-detail/);
        }
        return true;
      });
      assert.equal(f.state.attaches.length, 1);
      if (mode === "permission-denied") {
        // Native receipt handling must not change the original serving Attach error contract.
        await assert.rejects(
          f.client.attachSandboxProvider(
            namespace.name,
            f.sandbox.metadata.name,
            String(f.state.attaches[0]!.provider),
            child.signal,
            {
              expectedResourceVersion: f.sandbox.metadata.resource_version,
              requestId: randomUUID(),
            },
          ),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal((error as Error & { code?: number }).code, grpc.status.PERMISSION_DENIED);
            assert.match(String(error), /upstream-private-detail/);
            return true;
          },
        );
      }
    });
  }
});

test("staged OpenShell Proxy refuses a Provider detached before its final target read", async (t) => {
  const f = await fixture(t);
  f.state.attachMode = "detach-race";
  await assert.rejects(f.configure(), DependencyUnavailableError);
  assert.equal(f.state.attaches.length, 1);
  assert.deepEqual(f.sandbox.spec.providers, []);
});

test("staged OpenShell Proxy refuses the returned wrong ID after an accepted same-name, same-version attachment race", async (t) => {
  const f = await fixture(t);
  f.state.attachMode = "incarnation-race";
  await assert.rejects(f.configure(), DependencyUnavailableError);
  assert.equal(f.state.attaches[0]?.expected_resource_version, "5");
  assert.equal(f.sandbox.metadata.id, "f1d7e6c5-1b2a-4c3d-8e9f-102938475603");
  assert.ok(f.state.provider);
  assert.deepEqual(f.sandbox.spec.providers, [f.state.provider.metadata.name]);
});

test("staged OpenShell Proxy refuses a stale concurrent first-use winner without attaching or repairing", async (t) => {
  const f = await fixture(t);
  f.state.createMode = "stale-winner";
  await assert.rejects(f.configure(), DependencyUnavailableError);
  assert.equal(f.resolutions(), 1);
  assert.equal(f.state.creates.length, 1);
  assert.equal(f.state.provider?.config.oce_source_version, "source-v0");
  assert.equal(f.state.attaches.length, 0);
  assert.equal(f.state.updates.length, 0);
});

test("staged OpenShell Proxy reobserves the canonical serving model policy from main", async (t) => {
  const f = await fixture(t);
  await f.configure();
  const evidence = f.observeServing();
  const endpoint = (record(record(evidence.policy.network_policies).model).endpoints as Wire[])[0]!;
  assert.equal(endpoint.path, undefined, "model path is enforced by the REST rule");
  const status = () => f.proxy.getDeploymentStatus(f.context, configuration);
  assert.deepEqual(await status(), { state: "ready" });
  assert.equal(f.state.statusReads[0]?.sandbox, f.sandbox.metadata.name);
  assert.equal(f.state.statusReads[0]?.provider, f.state.provider!.metadata.name);
  assert.equal(record(f.state.statusReads[0]?.workspace_scope).workspace, namespace.name);
  // Provider-only status asks the Gateway for a current OBSERVE receipt. The Gateway may
  // persist that receipt; this does not claim that the upstream RPC is write-free.
  assert.equal(f.state.statusReads[0]?.receipt_id, undefined);

  f.state.providerStatus!.state = "PROVIDER_READINESS_STATE_PENDING";
  f.state.providerStatus!.reason = "PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR";
  for (const key of [
    "operation",
    "observed",
    "network_instance_id",
    "observed_time",
    "evaluated_time",
  ]) {
    Reflect.deleteProperty(f.state.providerStatus!, key);
  }
  assert.deepEqual(await status(), { state: "pending" });
  f.state.providerStatus!.state = "PROVIDER_READINESS_STATE_FAILED";
  f.state.providerStatus!.reason = "PROVIDER_READINESS_REASON_CREDENTIAL_INSTALL_FAILED";
  assert.equal((await status()).state, "failed");

  // Status may read evidence, but it must not resolve material, repair, or reattach a Provider.
  assert.equal(f.resolutions(), 1);
  assert.equal(f.state.creates.length, 1);
  assert.equal(f.state.attaches.length, 1);
  assert.equal(f.state.updates.length, 0);
});

test("staged OpenShell Proxy refuses a loaded policy outside the admitted request", async (t) => {
  const f = await fixture(t);
  await f.configure();
  type Evidence = ReturnType<typeof f.observeServing>;
  const scenarios: readonly {
    name: string;
    change: (evidence: Evidence) => void;
  }[] = [
    {
      name: "wrong destination",
      change: ({ endpoint }) => {
        endpoint.host = "other.example.test";
      },
    },
    {
      name: "wrong port",
      change: ({ endpoint }) => {
        endpoint.ports = [8443];
      },
    },
    {
      name: "wrong binary",
      change: ({ rule }) => {
        rule.binaries[0]!.path = "/usr/bin/other";
      },
    },
    {
      name: "wrong method",
      change: ({ endpoint }) => {
        endpoint.rules[0]!.allow.method = "GET";
      },
    },
    {
      name: "wrong path",
      change: ({ endpoint }) => {
        endpoint.rules[0]!.allow.path = "/v1/models";
      },
    },
    {
      name: "missing credential binding",
      change: ({ endpoint }) => {
        Reflect.deleteProperty(endpoint, "credential_binding");
        Reflect.deleteProperty(endpoint, "provider_credentialed");
      },
    },
    {
      name: "uninspected route with an unsupported overlapping selector",
      change: ({ policy }) => {
        record(policy.network_policies).overlap = {
          name: "overlap",
          binaries: [{ path: request.binary }],
          endpoints: [{ host: "api.*.com", ports: [443] }],
        };
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const evidence = f.observeServing();
      scenario.change(evidence);
      // The Gateway and supervisor consistently report this different policy as loaded;
      // rejection must come from checking its content against the admitted request.
      const changedHash = "c".repeat(64);
      f.state.config!.policy_hash = changedHash;
      const revision = record(f.state.policyStatus!.revision);
      revision.policy_hash = "d".repeat(64);
      revision.policy = sourcePolicyFrom(evidence.policy);
      f.sandbox.spec.policy = sourcePolicyFrom(evidence.policy);
      record(f.sandbox.status.configuration_admission).policy_hash = changedHash;
      evidence.desired.policy_hash = changedHash;
      evidence.observed.policy_hash = changedHash;
      assert.equal((await f.proxy.getDeploymentStatus(f.context, configuration)).state, "failed");
    });
  }
  await t.test("policy not loaded", async () => {
    f.observeServing();
    record(f.state.policyStatus!.revision).status = "POLICY_STATUS_PENDING";
    assert.deepEqual(await f.proxy.getDeploymentStatus(f.context, configuration), {
      state: "pending",
    });
  });
  await t.test("policy history not found", async () => {
    f.observeServing();
    f.state.policyStatus = undefined;
    assert.deepEqual(await f.proxy.getDeploymentStatus(f.context, configuration), {
      state: "pending",
    });
  });
  await t.test(
    "missing last-delivered Source version still permits exact binding cleanup",
    async () => {
      // The Gateway can serve a Provider without OCC's custom delivery-version marker.
      f.state.provider!.metadata.resource_version = "8";
      f.state.provider!.config = {};
      f.observeServing();
      assert.notEqual((await f.proxy.getDeploymentStatus(f.context, configuration)).state, "ready");
      const provider = structuredClone(f.state.provider);
      f.removeCredentialRoute();
      await f.proxy.removeDeployment(f.context, {
        targetRef: configuration.targetRef,
      });
      assert.equal(f.state.detaches.length, 1);
      assert.equal(f.state.detaches[0]?.provider, provider!.metadata.name);
      assert.deepEqual(f.sandbox.spec.providers, []);
      assert.equal(f.state.provider, undefined);
      assert.equal(f.state.profile, undefined);
    },
  );
  assert.equal(f.resolutions(), 1);
  assert.equal(f.state.updates.length, 0);
});

test("staged OpenShell Proxy removes the last target binding and its delivery copy", async (t) => {
  const f = await fixture(t);
  const unboundDeployment = {
    namespaceId: configuration.targetRef.namespaceId,
    agentId: configuration.targetRef.agentId,
    revisionId: configuration.targetRef.revisionId,
  };
  await f.proxy.removeDeployment(f.context, { unboundDeployment });
  assert.equal(f.resolutions(), 0);
  assert.equal(f.state.sandboxReads, 0);

  await f.configure();
  f.observeServing();
  assert.deepEqual(await f.proxy.getDeploymentStatus(f.context, configuration), { state: "ready" });
  const provider = structuredClone(f.state.provider);
  const remove = () =>
    f.proxy.removeDeployment(f.context, {
      targetRef: configuration.targetRef,
    });

  // Stock Gateway refuses detach while the current policy still binds this Provider.
  await assert.rejects(remove(), DependencyUnavailableError);
  assert.equal(f.state.detaches.length, 1);
  assert.deepEqual(f.sandbox.spec.providers, [provider!.metadata.name]);

  // A different target must be refused before another Workspace/name mutation.
  f.sandbox.metadata.id = "f1d7e6c5-1b2a-4c3d-8e9f-102938475603";
  await assert.rejects(remove(), DependencyUnavailableError);
  assert.equal(f.state.detaches.length, 1);
  f.sandbox.metadata.id = configuration.targetRef.sandboxId;

  f.removeCredentialRoute();
  // A same-name Provider outside this Namespace is not this binding's cleanup target.
  const currentProvider = f.state.provider!;
  currentProvider.metadata.labels["openclaw.dev/namespace-id"] = "namespace-foreign";
  currentProvider.metadata.resource_version = String(
    BigInt(currentProvider.metadata.resource_version) + 1n,
  );
  const detachesBeforeOwnershipRefusal = f.state.detaches.length;
  await assert.rejects(remove(), DependencyUnavailableError);
  assert.equal(f.state.detaches.length, detachesBeforeOwnershipRefusal);
  currentProvider.metadata.labels["openclaw.dev/namespace-id"] = namespace.id;
  currentProvider.metadata.resource_version = String(
    BigInt(currentProvider.metadata.resource_version) + 1n,
  );

  const permanentGatewayRefusal = (error: unknown) => {
    assert.ok(error instanceof SandboxGatewayUnauthorizedError);
    assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
    assert.equal(error.transient, false);
    assert.doesNotMatch(String(error), /upstream-private-detail/);
    return true;
  };
  // Stock Gateway hides an attached Sandbox behind NOT_FOUND after Workspace role loss.
  // GetWorkspace still returns PERMISSION_DENIED, so cleanup cannot report the binding removed.
  const detachesBeforeHiddenRoleLoss = f.state.detaches.length;
  f.state.workspaceDenied = true;
  await assert.rejects(remove(), permanentGatewayRefusal);
  assert.equal(f.state.detaches.length, detachesBeforeHiddenRoleLoss);
  assert.deepEqual(f.sandbox.spec.providers, [provider!.metadata.name]);
  f.state.workspaceDenied = false;

  f.state.detachMode = "permission-denied";
  await assert.rejects(remove(), permanentGatewayRefusal);
  assert.deepEqual(f.sandbox.spec.providers, [provider!.metadata.name]);
  f.state.detachMode = "normal";

  await remove();
  assert.equal(f.state.detaches.length, 3);
  const detached = f.state.detaches[2]!;
  assert.equal(record(detached.workspace_scope).workspace, namespace.name);
  assert.equal(detached.sandbox, f.sandbox.metadata.name);
  assert.equal(detached.provider, provider!.metadata.name);
  assert.equal(detached.expected_resource_version, undefined);
  assert.match(String(detached.request_id), /^[0-9a-f-]{36}$/);
  assert.equal(f.state.statusReads.length, 1);
  assert.deepEqual(f.sandbox.spec.providers, []);

  assert.equal(f.state.provider, undefined);
  assert.equal(f.state.profile, undefined);
  // Repeating cleanup for an absent binding or target does not resolve or recreate the copy.
  await remove();
  f.state.sandboxPresent = false;
  await remove();

  assert.equal(f.resolutions(), 1);
  assert.equal(f.state.detaches.length, 3);
  assert.equal(f.state.deletes.length, 1);
  assert.equal(f.state.profileDeletes.length, 1);
  assert.equal(f.state.updates.length, 0);
});

test("Kubernetes Stop detaches native Git and model Providers from a retained managed Sandbox", async (t) => {
  const kubernetesNamespace = kubernetesNamespaceName(namespace.id);
  const f = await fixture(t, kubernetesNamespace);
  const sandboxOptions = openShellWorkspaceHarnessConfiguration();
  sandboxOptions.integrationMode = "service";
  sandboxOptions.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
  const sandbox = new ManagedOpenShellSandbox(sandboxOptions, {
    id: f.proxy.id,
    implementation: f.proxy.implementation,
    backend: f.backend,
  });
  const proxy = new OpenShellCredentialProxyDriver({
    id: sandbox.id,
    implementation: sandbox.implementation,
    backend: f.backend,
    sandbox,
    tokenServiceImplementation: "occ/token-service",
  });
  const deployment = f.context.revision.credentialDeployment;
  const owner = new InstalledDriver(
    { id: sandbox.id, implementation: sandbox.implementation, configuration: sandboxOptions },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  const compute = new KubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      servicePrincipalCredentials: { mode: "disabled" },
    }),
    { credentialDeliveryRegistration: owner, sandboxDriver: sandbox },
  );
  const grants = [{ repository: "fixture/repository", access: "read" }] as const;
  const gitRequests = openShellRepositoryCredentialRequests(grants);
  const git = {
    bindingRef: "repository",
    sourceRef: { kind: "credential_source", id: "cs_github", namespaceId: namespace.id },
    consumer: { kind: "repository" },
    projection: { environment: "GITHUB_TOKEN", presentation: "github_repository" },
  } as const;
  const baseline = {
    version: 1,
    network_policies: {
      baseline: {
        name: "baseline",
        binaries: [{ path: "/usr/bin/curl" }],
        endpoints: [{ host: "example.com", ports: [443] }],
      },
    },
  };
  const tokenServiceInstanceId = "tokens";
  const revision = {
    ...f.context.revision,
    compute: { id: compute.id, implementation: compute.implementation },
    harness: {
      ...f.context.revision.harness,
      configuration: {
        modelProvider: {
          protocol: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          supportsStandaloneWebSearch: false,
        },
      },
    },
    harnessAuth: {
      method: "credential_source" as const,
      sourceId: binding.sourceRef.id,
      sourceType: "static" as const,
      tokenServiceInstanceId,
    },
    credentialSources: [
      { sourceId: binding.sourceRef.id, sourceType: "static" as const, tokenServiceInstanceId },
      {
        sourceId: git.sourceRef.id,
        sourceType: "github-app-installation" as const,
        tokenServiceInstanceId,
      },
    ],
    repositoryCredentials: {
      authorization: "credential_source" as const,
      driver: { id: "repository", implementation: "github" },
      bindings: [
        {
          repositoryRef: "repository",
          profile: "github-repository",
          backendId: "github-primary",
          grant: { providerInstanceId: "github", repositoryId: "42", grantId: "repository" },
        },
      ],
    },
    sandboxPolicy: {
      driverId: sandbox.id,
      implementation: sandbox.implementation,
      version: 1 as const,
      defaults: baseline.network_policies,
      additions: [],
      repositoryNetworkPolicy: admitRepositoryNetworkPolicy(grants, grants)!,
    },
    credentialDeployment: {
      ...deployment,
      driver: owner.ref,
      networkAccessPolicy: { allowed: [request, ...gitRequests] },
      bindings: [binding, git],
      injectionPolicies: [injection, { bindingRef: git.bindingRef, allowedRequests: gitRequests }],
    },
  };
  assert.ok(isNativeStagedRepositoryRevision(revision));
  Object.assign(revision.compute, { admission: compute.admitRevision(revision) });
  const context = { ...f.context, revision };
  const target = f.sandbox;
  target.metadata.name = sandbox.harnessResource(context).resourceName;
  target.spec.policy = structuredClone(baseline);
  f.state.policyStatus = {
    revision: { version: 1, status: "POLICY_STATUS_LOADED", policy: baseline },
    active_version: 1,
  };
  await proxy.configureDeployment(context, {
    ...configuration,
    bindings: [
      f.suppliedBinding,
      {
        binding: git,
        resolveCredential: async () => ({ credential: "synthetic-git-token", version: "git-v1" }),
      },
    ],
    injectionPolicies: revision.credentialDeployment.injectionPolicies,
  });
  const providers = [...target.spec.providers];
  assert.equal(providers.length, 2);
  assert.ok(providers.every((provider) => policyUsesProvider(target.spec.policy, provider)));
  // OpenShell retains the original creation policy separately from its latest pushed policy.
  target.spec.policy = structuredClone(baseline);
  const runtimeProvider = sandbox.gitRuntimeProviderName(revision);
  target.spec.providers.push(runtimeProvider);
  target.status.phase = "SANDBOX_PHASE_READY";

  const targetNamespace = { name: kubernetesNamespace, plane: "control" } as const;
  const k8s = createDedicatedDeployKubernetesFixture(
    {
      namespace: kubernetesNamespace,
      gatewayName: `gateway-${digest(revision.agentId)}`,
      state: createDedicatedDeployEnrollmentFixture().state,
      revision,
      sandboxDriver: sandbox,
      clock: undefined,
    },
    (save) =>
      save({
        ...compute["gatewayNamespaceManifest"]({ namespaceId: namespace.id }),
        status: { phase: "Active" },
      }),
  );
  // Resume after the Gateway drained. The retained Harness belongs to OpenShell, not a tenant Pod.
  k8s.clients.core.listNamespacedPod = async () => ({ items: [] });
  // Persist the exact target that normal staged preparation retains for Stop retries.
  assert.ok(Reflect.set(compute, "apiClients", Promise.resolve(k8s.clients)));
  await compute["credentialDeploymentTarget"](revision, targetNamespace, target.metadata.id);

  await compute.stopRevision(revision);

  const stopped = await f.client.getSandbox(
    { workspace: kubernetesNamespace, name: target.metadata.name },
    t.signal,
  );
  assert.ok(stopped);
  assert.equal(stopped.id, target.metadata.id);
  assert.equal(stopped.phase, "SANDBOX_PHASE_STOPPED");
  assert.deepEqual(stopped.spec?.providers, [runtimeProvider]);
  const status = await f.client.getPolicyStatus(
    { workspace: kubernetesNamespace, sandbox: target.metadata.name },
    t.signal,
  );
  assert.equal(status.state, "POLICY_STATUS_PENDING");
  assert.equal(status.activeVersion, 0);
  assert.deepEqual(status.policy.network_policies, baseline.network_policies);
  assert.equal(await compute["credentialDeploymentTarget"](revision, targetNamespace), undefined);
});

test("staged OpenShell Proxy retains a shared copy until the last Sandbox unbinds", async (t) => {
  const f = await fixture(t);
  await f.configure();
  const original = structuredClone(f.state.provider!);
  const { sandbox: second, context: secondContext } = addSecondSandboxTarget(f);
  await f.proxy.configureDeployment(secondContext, {
    ...secondConfiguration,
    bindings: [f.suppliedBinding],
    injectionPolicies: [injection],
  });
  assert.equal(f.state.creates.length, 1);
  assert.deepEqual(second.spec.providers, [original.metadata.name]);

  // The native deletion guard preserves the same Provider and the other Sandbox's attachment.
  await f.proxy.removeDeployment(f.context, { targetRef: configuration.targetRef });
  assert.deepEqual(f.sandbox.spec.providers, []);
  assert.deepEqual(second.spec.providers, [original.metadata.name]);
  assert.deepEqual(f.state.provider, original);
  assert.ok(f.state.profile);
  assert.equal(f.state.profileDeletes.length, 0);
  await assert.rejects(f.proxy.retireSource(namespace, binding.sourceRef, t.signal), {
    code: grpc.status.FAILED_PRECONDITION,
    details: `provider '${original.metadata.name}' is attached to sandbox(es): ${second.metadata.name}`,
  });
  assert.deepEqual(second.spec.providers, [original.metadata.name]);

  await f.proxy.removeDeployment(secondContext, { targetRef: secondConfiguration.targetRef });
  assert.deepEqual(second.spec.providers, []);
  assert.equal(f.state.provider, undefined);
  assert.equal(f.state.profile, undefined);
});

test("failed native attachment retains a Provider still used by another Sandbox", async (t) => {
  const f = await fixture(t);
  await f.configure();
  const provider = structuredClone(f.state.provider!);
  const second = addSecondSandboxTarget(f);
  f.state.attachMode = "cas-race";
  await assert.rejects(
    f.proxy.configureDeployment(second.context, {
      ...secondConfiguration,
      bindings: [f.suppliedBinding],
      injectionPolicies: [injection],
    }),
    DependencyUnavailableError,
  );
  assert.equal(f.state.deletes.length, 1);
  assert.deepEqual(f.state.provider, provider);
  assert.deepEqual(f.sandbox.spec.providers, [provider.metadata.name]);
  assert.deepEqual(second.sandbox.spec.providers, []);
  assert.equal(f.state.profileDeletes.length, 0);
});

test("failed native attachment reports unconfirmed cleanup and retains the copy", async (t) => {
  const f = await fixture(t);
  f.state.attachMode = "cas-race";
  f.state.deleteMode = "unavailable";
  await assert.rejects(f.configure(), (error: unknown) => {
    assert.ok(error instanceof ComputeCleanupFailedError);
    assert.ok(error.primary instanceof DependencyUnavailableError);
    assert.equal(error.cleanupFailures.length, 1);
    assert.ok(error.cleanupFailures[0] instanceof Error);
    return true;
  });
  assert.deepEqual(f.sandbox.spec.providers, []);
  assert.ok(f.state.provider);
  assert.ok(f.state.profile);

  assert.equal(f.resolutions(), 1);
});

test("Source retirement refuses a mixed-owned Provider before deleting native resources", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.state.provider!.metadata.labels["openclaw.dev/token-service"] = "native";
  await assert.rejects(
    f.proxy.retireSource(namespace, binding.sourceRef, t.signal),
    DependencyUnavailableError,
  );
  assert.equal(f.state.deletes.length, 0);
  assert.equal(f.state.profileDeletes.length, 0);
  assert.ok(f.state.provider);
});

test("Source retirement finds a projected Profile left before Provider creation", async (t) => {
  const f = await fixture(t);
  const plugin = {
    ...binding,
    bindingRef: "plugin-api",
    consumer: { kind: "plugin" as const, pluginId: "http", requirement: "api", connection: "one" },
    projection: { environment: "PLUGIN_API_KEY", presentation: "bearer" as const },
  };
  const injectionPolicies = [{ ...injection, bindingRef: plugin.bindingRef }];
  // First-use resolution can fail after profile import, leaving a profile without a Provider.
  await assert.rejects(
    f.proxy.configureDeployment(
      {
        ...f.context,
        revision: {
          ...f.context.revision,
          credentialDeployment: {
            ...f.context.revision.credentialDeployment,
            bindings: [plugin],
            injectionPolicies,
          },
        },
      },
      {
        ...configuration,
        bindings: [
          {
            binding: plugin,
            resolveCredential: async () => {
              throw new Error("unavailable");
            },
          },
        ],
        injectionPolicies,
      },
    ),
    DependencyUnavailableError,
  );
  const profileId = f.state.profile?.id;
  assert.equal(typeof profileId, "string");
  assert.equal(f.state.provider, undefined);
  await f.proxy.retireSource(namespace, plugin.sourceRef, t.signal);
  assert.deepEqual(
    f.state.profileDeletes.map(({ id }) => id),
    [profileId],
  );
  assert.equal(f.state.profile, undefined);
});

test("deployment cleanup does not swallow an unrelated native failed precondition", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.state.deleteMode = "other-precondition";
  await assert.rejects(
    f.proxy.removeDeployment(f.context, { targetRef: configuration.targetRef }),
    DependencyUnavailableError,
  );
  assert.deepEqual(f.sandbox.spec.providers, []);
  assert.ok(f.state.provider);
  assert.ok(f.state.profile);
  assert.equal(f.state.profileDeletes.length, 0);
});

test("staged OpenShell Proxy reports failure when target membership cannot be confirmed", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.state.sandboxReadMode = "unavailable-after-detach";
  await assert.rejects(
    f.proxy.removeDeployment(f.context, { targetRef: configuration.targetRef }),
    DependencyUnavailableError,
  );
  assert.equal(f.state.detaches.length, 1);
  assert.deepEqual(f.sandbox.spec.providers, []);
  assert.equal(f.state.provider?.config.oce_source_version, "source-v1");
  assert.deepEqual(f.state.deletes, []);
});

test("canonical OpenShell Proxy preserves exact Repository authority through delivery, refresh, and withdrawal", async (t) => {
  const f = await fixture(t);
  const grants = [
    { repository: "fixture/repository", access: "read" },
    { repository: "fixture/write", access: "write" },
  ] as const;
  const publish: DeploymentRequestMatch = {
    binary: "/usr/local/bin/gh",
    host: "api.github.com",
    ports: [{ from: 443, to: 443 }],
    requestPolicy: { type: "http", method: "POST", path: "/repos/fixture/write/pulls" },
  };
  const requests = [...openShellRepositoryCredentialRequests(grants), publish];
  const repository = {
    bindingRef: "repository",
    sourceRef: { kind: "credential_source", id: "cs_github", namespaceId: namespace.id },
    consumer: { kind: "repository" },
    projection: { environment: "GITHUB_TOKEN", presentation: "github_repository" },
  } as const;
  const repositoryInjection = { bindingRef: repository.bindingRef, allowedRequests: requests };
  const optionalPlugin = {
    bindingRef: "slack-default",
    sourceRef: { kind: "credential_source", id: "cs_slack", namespaceId: namespace.id },
    consumer: { kind: "plugin", pluginId: "slack", requirement: "account", connection: "default" },
    projection: { environment: "SLACK_TOKEN", presentation: "bearer" },
  } as const;
  const pluginRequest: DeploymentRequestMatch = {
    binary: "/usr/local/bin/node",
    host: "slack.com",
    ports: [{ from: 443, to: 443 }],
    requestPolicy: { type: "http", method: "POST", path: "/api/chat.postMessage" },
  };
  const pluginInjection = {
    bindingRef: optionalPlugin.bindingRef,
    allowedRequests: [pluginRequest],
  };
  const baselineRule = {
    name: "baseline",
    binaries: [{ path: "/usr/bin/curl" }],
    endpoints: [{ host: "example.com", ports: [443] }],
  };
  const baseline = { version: 1, network_policies: { baseline: baselineRule } };
  const policy = admitRepositoryNetworkPolicy(grants, grants)!;
  const context: CredentialDeploymentContext = {
    ...f.context,
    revision: {
      ...f.context.revision,
      sandboxPolicy: {
        driverId: "sandbox",
        implementation: "openshell",
        version: 1,
        defaults: { baseline: baselineRule },
        additions: [],
        repositoryNetworkPolicy: policy,
      },
      credentialDeployment: {
        ...f.context.revision.credentialDeployment!,
        networkAccessPolicy: { allowed: [...requests, pluginRequest] },
        bindings: [repository, optionalPlugin],
        injectionPolicies: [repositoryInjection, pluginInjection],
      },
    },
  };
  f.sandbox.spec.policy = structuredClone(baseline);
  f.state.policyStatus = {
    revision: { version: 1, status: "POLICY_STATUS_PENDING", policy: baseline },
    active_version: 0,
  };
  let resolutions = 0;
  const input = {
    ...configuration,
    bindings: [
      {
        binding: repository,
        resolveCredential: async () => {
          resolutions++;
          return { credential: "synthetic-github-token", version: "github-v1" };
        },
      },
    ],
    // The immutable revision retains the optional Plugin binding, but Worker supplies only the
    // effective Repository binding after optional Plugin withdrawal.
    injectionPolicies: [repositoryInjection, pluginInjection],
  };
  // A generic allow at the same GitHub destination would bypass the saved Repo grant.
  const overlapping = {
    ...context,
    revision: {
      ...context.revision,
      sandboxPolicy: {
        ...context.revision.sandboxPolicy!,
        additions: [
          {
            id: "bypass",
            binary: "/usr/bin/git",
            host: "github.com",
            ports: [{ from: 443, to: 443 }],
          },
        ],
      },
    },
  };
  await assert.rejects(f.proxy.configureDeployment(overlapping, input), DependencyUnavailableError);
  // Even a matching network and injection request cannot add publication to a Read repository.
  const readPublish = {
    ...publish,
    requestPolicy: {
      type: "http" as const,
      method: "POST",
      path: "/repos/fixture/repository/pulls",
    },
  };
  const readRequests = [...requests.slice(0, -1), readPublish];
  const readInjections = [
    { ...repositoryInjection, allowedRequests: readRequests },
    pluginInjection,
  ];
  await assert.rejects(
    f.proxy.configureDeployment(
      {
        ...context,
        revision: {
          ...context.revision,
          credentialDeployment: {
            ...context.revision.credentialDeployment!,
            networkAccessPolicy: { allowed: [...readRequests, pluginRequest] },
            injectionPolicies: readInjections,
          },
        },
      },
      { ...input, injectionPolicies: readInjections },
    ),
    DependencyUnavailableError,
  );
  const configure = () => f.proxy.configureDeployment(context, input);
  const pending = { name: ActivationPendingError.name, code: "CREDENTIAL_ACTIVATION_PENDING" };
  const initial = record(f.state.policyStatus.revision);
  // A pending revision must still contain one of the approved policies.
  initial.policy = {
    ...baseline,
    network_policies: {
      ...baseline.network_policies,
      broad: { name: "broad", endpoints: [{ host: "github.com", ports: [443] }] },
    },
  };
  await assert.rejects(configure, OpenShellCredentialDeliveryRefusedError);
  initial.policy = baseline;
  initial.status = "POLICY_STATUS_FAILED";
  await assert.rejects(configure, OpenShellCredentialDeliveryRefusedError);
  // Stock OpenShell reports the initial idle policy before it has an active version.
  initial.status = "POLICY_STATUS_PENDING";
  await assert.rejects(configure, pending);
  assert.equal(resolutions, 0);
  assert.equal(f.state.profile, undefined);
  assert.equal(f.state.creates.length, 0);
  assert.equal(f.state.attaches.length, 0);
  assert.equal(f.state.policyUpdates.length, 0);
  initial.status = "POLICY_STATUS_LOADED";
  f.state.policyStatus.active_version = 1;
  const configured = await configure();
  assert.deepEqual(configured.credentialProjections, [
    { bindingRef: "repository", environment: "GITHUB_TOKEN", placeholder: { kind: "runtime" } },
  ]);
  assert.equal(resolutions, 1);
  assert.equal(f.state.policyUpdates.length, 1);
  // The combined policy now exists at v2 while v1 is still active on the same Sandbox.
  const combined = record(f.state.policyStatus.revision);
  assert.equal(combined.version, 2);
  combined.status = "POLICY_STATUS_PENDING";
  f.state.policyStatus.active_version = 1;
  await assert.rejects(configure, pending);
  combined.status = "POLICY_STATUS_LOADED";
  await assert.rejects(configure, pending);
  f.state.policyStatus.active_version = 2;
  assert.deepEqual(await configure(), configured);
  assert.equal(resolutions, 1);
  assert.equal(f.state.creates.length, 1);
  assert.equal(f.state.attaches.length, 1);
  assert.equal(f.state.updates.length, 0);
  assert.equal(f.state.policyUpdates.length, 1);
  // A resumed preparation must use the reduced effective policy even though the immutable
  // revision still contains the withdrawn Plugin. Recreate a missing Repository Provider.
  f.sandbox.spec.providers = [];
  f.state.provider = undefined;
  f.state.providerStatus = undefined;
  await f.proxy.configureDeployment(context, input);
  assert.equal(resolutions, 2);
  assert.equal(f.state.creates.length, 2);
  assert.ok(record(f.sandbox.spec.policy!.network_policies).baseline);
  const source = structuredClone(f.sandbox.spec.policy!);
  const repoRules = Object.values(record(source.network_policies)).filter(
    (rule) => record(rule).name !== "baseline",
  );
  assert.equal(repoRules.length, 26);
  assert.deepEqual(
    [
      ...new Set(
        repoRules.flatMap((rule) => (record(rule).binaries as Wire[]).map(({ path }) => path)),
      ),
    ].sort(),
    [
      "/usr/bin/git",
      "/usr/lib/git-core/git-remote-http",
      "/usr/lib/git-core/git-remote-https",
      "/usr/libexec/git-core/git-remote-http",
      "/usr/libexec/git-core/git-remote-https",
      "/usr/local/bin/gh",
    ],
  );
  const discovery = repoRules
    .map((rule) => (record(rule).endpoints as Wire[])[0]!)
    .find((endpoint) => endpoint.path === "/fixture/repository.git/info/refs")!;
  assert.deepEqual(record((discovery.rules as Wire[])[0]!).allow, {
    method: "GET",
    path: "/fixture/repository.git/info/refs",
    query: { service: { glob: "git-upload-pack" } },
  });
  assert.match(String(record(discovery.credential_binding).provider), /^oce-cs-/);
  // The publication endpoint uses the same Provider as smart Git and grants one stock gh request.
  assert.deepEqual(
    repoRules.flatMap((rule) =>
      (record(rule).endpoints as Wire[])
        .filter(({ host }) => host === "api.github.com")
        .map((endpoint) => ({ binaries: record(rule).binaries, endpoint })),
    ),
    [
      {
        binaries: [{ path: "/usr/local/bin/gh" }],
        endpoint: {
          host: "api.github.com",
          ports: [443],
          path: "/repos/fixture/write/pulls",
          protocol: "rest",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: [{ allow: { method: "POST", path: "/repos/fixture/write/pulls" } }],
          credential_binding: discovery.credential_binding,
        },
      },
    ],
  );
  assert.equal(
    repoRules.some((rule) =>
      JSON.stringify(rule).includes("/fixture/repository.git/git-receive-pack"),
    ),
    false,
  );
  const writeDiscovery = repoRules
    .map((rule) => (record(rule).endpoints as Wire[])[0]!)
    .find((endpoint) => endpoint.path === "/fixture/write.git/info/refs")!;
  assert.deepEqual(
    (writeDiscovery.rules as Wire[]).map((rule) => record(record(rule.allow).query).service),
    [{ glob: "git-upload-pack" }, { glob: "git-receive-pack" }],
  );
  assert.ok(
    repoRules.some((rule) =>
      (record(rule).endpoints as Wire[]).some(
        (endpoint) => endpoint.path === "/fixture/write.git/git-receive-pack",
      ),
    ),
  );

  // The existing receipt fixture supplies controlled serving evidence; it does not qualify a live Sandbox.
  f.observeServing();
  const effective = structuredClone(source);
  for (const rule of Object.values(record(effective.network_policies))) {
    for (const endpoint of record(rule).endpoints as Wire[]) {
      if (endpoint.credential_binding) {
        endpoint.provider_credentialed = true;
      }
    }
  }
  f.sandbox.spec.policy = source;
  f.state.config!.policy = effective;
  record(f.state.policyStatus!.revision).policy = source;
  // Stock OpenShell adds name-only rules for attached endpointless Providers, including runtime files.
  f.sandbox.spec.providers.push(f.runtimeProvider);
  const effectiveRules = record(effective.network_policies);
  const inertRules = Object.fromEntries(
    f.sandbox.spec.providers.map((provider) => {
      const name = `_provider_${provider.replaceAll("-", "_")}`;
      return [name, { name }];
    }),
  );
  Object.assign(effectiveRules, inertRules);
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), { state: "ready" });
  const foreignName = "_provider_foreign";
  effectiveRules[foreignName] = { name: foreignName };
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });
  Reflect.deleteProperty(effectiveRules, foreignName);
  const runtimeRule = `_provider_${f.runtimeProvider.replaceAll("-", "_")}`;
  effectiveRules[runtimeRule] = {
    ...inertRules[runtimeRule],
    binaries: [{ path: "/usr/bin/curl" }],
  };
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });
  effectiveRules[runtimeRule] = inertRules[runtimeRule];
  const effectiveDiscovery = Object.values(effectiveRules)
    .flatMap((rule) => (record(rule).endpoints as Wire[] | undefined) ?? [])
    .find((endpoint) => endpoint.path === discovery.path)!;
  Reflect.deleteProperty(record(record((effectiveDiscovery.rules as Wire[])[0]!).allow), "query");
  assert.deepEqual(await f.proxy.getDeploymentStatus(context, configuration), {
    state: "failed",
    code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED",
  });
  record((effectiveDiscovery.rules as Wire[])[0]!).allow = structuredClone(
    record((discovery.rules as Wire[])[0]!).allow,
  );

  // OpenShell retains the creation policy in Sandbox.spec after UpdateConfig. Source refresh
  // must acknowledge the combined loaded policy against the trusted admitted revision instead.
  f.sandbox.spec.policy = structuredClone(baseline);
  const resolvedRevisions: string[] = [];
  let denyRecipient = false;
  f.proxy.bindSourceRevisionResolver(async (sourceRef, agentId, revisionId) => {
    assert.deepEqual(sourceRef, repository.sourceRef);
    assert.equal(agentId, context.revision.agentId);
    assert.equal(revisionId, context.revision.id);
    resolvedRevisions.push(revisionId);
    if (denyRecipient) {
      throw new DependencyUnavailableError("The Agent no longer has Source authority.");
    }
    return { revision: context.revision, activeBindingRefs: new Set([repository.bindingRef]) };
  });
  let refreshResolutions = 0;
  const refresh = (version: string) =>
    f.proxy.notifyCredentialUpdated(
      { sourceRef: repository.sourceRef, version },
      async () => {
        refreshResolutions++;
        return { credential: `synthetic-${version}`, version };
      },
      t.signal,
    );
  await refresh("github-v2");
  assert.equal(f.state.provider!.config.oce_source_version, "github-v2");
  const updates = f.state.updates.length;
  denyRecipient = true;
  f.state.sandboxInventoryMode = "second-page";
  await assert.rejects(refresh("github-revoked"), DependencyUnavailableError);
  assert.equal(refreshResolutions, 1, "recipient authorization precedes credential resolution");
  assert.equal(f.state.updates.length, updates, "a denied Agent cannot receive the new token");
  denyRecipient = false;
  f.state.sandboxInventoryMode = "repeated-token";
  await assert.rejects(refresh("github-incomplete"), OpenShellGatewayFailure);
  assert.equal(refreshResolutions, 1);
  assert.equal(f.state.updates.length, updates);
  f.state.sandboxInventoryMode = "normal";
  // Same-version observation still checks the effective endpoint's native injection marker.
  Reflect.deleteProperty(effectiveDiscovery, "provider_credentialed");
  await assert.rejects(refresh("github-v2"), DependencyUnavailableError);
  assert.equal(f.state.updates.length, updates);
  effectiveDiscovery.provider_credentialed = true;
  assert.deepEqual(resolvedRevisions, Array(5).fill(context.revision.id));
  assert.deepEqual(f.sandbox.spec.policy, baseline);

  // A withdrawal retry must not report the optional Plugin revoked while the retained Git
  // policy is loaded but its native credential delivery is no longer ready.
  effectiveDiscovery.provider_credentialed = false;
  await assert.rejects(
    f.proxy.removeDeployment(context, {
      targetRef: configuration.targetRef,
      bindingRefs: [optionalPlugin.bindingRef],
    }),
    {
      code: "CREDENTIAL_WITHDRAWAL_MISCONFIGURED",
      message:
        "The effective reduced policy is unsafe or retained credential delivery is not ready.",
    },
  );
  assert.deepEqual(f.state.detaches, []);
  effectiveDiscovery.provider_credentialed = true;

  // Even mutually consistent Gateway/supervisor readbacks cannot authorize a widened Git
  // discovery rule when the exact admitted revision still requires the service query.
  const discoveryAllow = structuredClone(record((discovery.rules as Wire[])[0]!).allow);
  const loadedDiscovery = Object.values(
    record(record(record(f.state.policyStatus!.revision).policy).network_policies),
  )
    .flatMap((rule) => record(rule).endpoints as Wire[])
    .find((endpoint) => endpoint.path === discovery.path)!;
  for (const endpoint of [loadedDiscovery, effectiveDiscovery]) {
    Reflect.deleteProperty(record(record((endpoint.rules as Wire[])[0]!).allow), "query");
  }
  await assert.rejects(refresh("github-v3"), DependencyUnavailableError);
  for (const endpoint of [loadedDiscovery, effectiveDiscovery]) {
    record((endpoint.rules as Wire[])[0]!).allow = structuredClone(discoveryAllow);
  }

  f.proxy.bindSourceRevisionResolver(async () => ({
    revision: { ...context.revision, id: "other-revision" },
    activeBindingRefs: new Set([repository.bindingRef]),
  }));
  await assert.rejects(refresh("github-v4"), DependencyUnavailableError);

  const { sandbox: peer, context: peerBase } = addSecondSandboxTarget(f);
  const peerGrants = [{ repository: "fixture/write", access: "read" }] as const;
  const peerRequests = openShellRepositoryCredentialRequests(peerGrants);
  const peerInjection = { bindingRef: repository.bindingRef, allowedRequests: peerRequests };
  const peerContext: CredentialDeploymentContext = {
    ...peerBase,
    revision: {
      ...peerBase.revision,
      sandboxPolicy: {
        ...context.revision.sandboxPolicy!,
        repositoryNetworkPolicy: admitRepositoryNetworkPolicy(peerGrants, grants)!,
      },
      credentialDeployment: {
        ...context.revision.credentialDeployment!,
        networkAccessPolicy: { allowed: [...peerRequests, pluginRequest] },
        injectionPolicies: [peerInjection, pluginInjection],
      },
    },
  };
  // This wire fixture has one policy-readback slot. Present the peer's initially loaded
  // baseline while configuring it, then restore the victim's readback before withdrawal.
  const victimStatus = structuredClone(f.state.policyStatus);
  const victimConfig = structuredClone(f.state.config);
  peer.spec.policy = structuredClone(baseline);
  f.state.config = undefined;
  f.state.policyStatus = {
    revision: { version: 1, status: "POLICY_STATUS_LOADED", policy: baseline },
    active_version: 1,
  };
  await f.proxy.configureDeployment(peerContext, {
    ...secondConfiguration,
    bindings: input.bindings,
    injectionPolicies: [peerInjection, pluginInjection],
  });
  const sharedProvider = f.state.provider!.metadata.name;
  assert.equal(resolutions, 2, "a peer must reuse the Source Provider without resolving again");
  assert.equal(f.state.creates.length, 2);
  assert.deepEqual(peer.spec.providers, [sharedProvider]);
  assert.deepEqual(record(f.state.policyStatus.revision).policy, peer.spec.policy);
  const peerPolicy = structuredClone(peer.spec.policy!);
  const peerEndpoints = Object.values(record(peerPolicy.network_policies)).flatMap(
    (rule) => record(rule).endpoints as Wire[],
  );
  assert.equal(
    peerEndpoints.some(({ host }) => host === "api.github.com"),
    false,
  );
  const peerDiscovery = peerEndpoints.find(
    (endpoint) => endpoint.path === "/fixture/write.git/info/refs",
  )!;
  assert.deepEqual(
    (peerDiscovery.rules as Wire[]).map((rule) => record(record(rule.allow).query).service),
    [{ glob: "git-upload-pack" }],
  );
  assert.equal(record(peerDiscovery.credential_binding).provider, sharedProvider);
  const peerUpload = peerEndpoints.find(
    (endpoint) => endpoint.path === "/fixture/write.git/git-upload-pack",
  )!;
  assert.deepEqual(record((peerUpload.rules as Wire[])[0]!).allow, {
    method: "POST",
    path: "/fixture/write.git/git-upload-pack",
  });
  assert.equal(record(peerUpload.credential_binding).provider, sharedProvider);
  assert.equal(
    peerEndpoints.some(
      (endpoint) =>
        String(endpoint.path).includes("/fixture/repository") ||
        String(endpoint.path).endsWith("/git-receive-pack"),
    ),
    false,
  );
  f.state.policyStatus = victimStatus;
  f.state.config = victimConfig;
  // A loaded policy that still permits Git after reduction is a definitive unsafe result.
  // The Worker must receive a withdrawal refusal before any Provider detach is acknowledged.
  f.state.policyUpdateReadback = "widened";
  await assert.rejects(
    f.proxy.removeDeployment(context, {
      targetRef: configuration.targetRef,
      bindingRefs: ["repository"],
    }),
    CredentialWithdrawalRefusedError,
  );
  assert.deepEqual(f.state.detaches, []);
  f.state.policyUpdateReadback = "normal";
  f.state.config!.policy = structuredClone(record(record(f.state.policyStatus!.revision).policy));
  Object.assign(record(record(f.state.config!.policy).network_policies), inertRules);
  await f.proxy.removeDeployment(context, {
    targetRef: configuration.targetRef,
    bindingRefs: ["repository"],
  });
  assert.deepEqual(f.sandbox.spec.providers, [f.runtimeProvider]);
  assert.deepEqual(peer.spec.providers, [sharedProvider]);
  assert.deepEqual(peer.spec.policy, peerPolicy);
  assert.equal(f.state.provider!.metadata.name, sharedProvider);
  assert.deepEqual(Object.keys(record(f.sandbox.spec.policy!.network_policies)), ["baseline"]);
  assert.equal(f.state.profileDeletes.length, 0);
});
