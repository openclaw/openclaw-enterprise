import assert from "node:assert/strict";
import { ComputeCleanupFailedError } from "../../apps/controller/src/drivers/compute/cleanup-failure.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/credential-proxy/openshell.ts";
import {
  GrpcOpenShellGatewayClient,
  OpenShellAdmissionLimitError,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  Backend,
  DeploymentRequestMatch,
  CredentialDeploymentContext,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { grpc, loader, openShellService, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { bindWireServer } from "./openshell-gateway-wire-fixture.ts";
import { completeSandboxRevision } from "../integration/sandbox-driver-revision-fixture.ts";
import {
  DependencyUnavailableError,
  SandboxGatewayUnauthorizedError,
} from "../../packages/occ/src/errors.ts";

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
    id: "source-1",
    namespaceId: namespace.id,
  },
  bindingRef: "model-credential",
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
    (record(rule).endpoints as Wire[]).some(
      (endpoint) => record(endpoint.credential_binding ?? {}).provider === provider,
    ),
  );
}

async function fixture(t: TestContext) {
  const sandbox = {
    metadata: {
      id: configuration.targetRef.sandboxId as string,
      name: "held-sandbox",
      workspace: namespace.name,
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
    creates: [] as Wire[],
    updates: [] as Wire[],
    attaches: [] as Wire[],
    detaches: [] as Wire[],
    deletes: [] as Wire[],
    profileDeletes: [] as Wire[],
    sandboxReads: 0,
    sandboxPresent: true,
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
  const liveSandbox = (name: string) =>
    sandboxes.find(
      (candidate) =>
        candidate.metadata.name === name && (candidate !== sandbox || state.sandboxPresent),
    );
  const advanceProviderEnvironment = () => {
    const status = state.providerStatus!;
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
            name: namespace.name,
            labels: {
              "app.kubernetes.io/managed-by": "openclaw-enterprise",
              "openclaw.dev/namespace-id": namespace.id,
            },
          },
        },
      };
    },
    GetProvider: () => {
      if (state.attachMode === "detach-race" && state.attaches.length > 0) {
        state.detachOnNextSandboxRead = true;
      }
      return state.provider && { provider: state.provider };
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
      if (
        (target.spec.policy && policyUsesProvider(target.spec.policy, provider)) ||
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
      return {
        detached,
        receipt: {
          receipt_id: randomUUID(),
          mutation_id: mutationId,
          kind: "PROVIDER_MUTATION_KIND_DETACH",
          workspace: namespace.name,
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
        },
      };
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
      assert.equal(state.provider?.metadata.name, name);
      state.provider = undefined;
      return { outcome: "DELETION_OUTCOME_COMPLETED" };
    },
    DeleteProviderProfile: (input) => {
      state.profileDeletes.push(input);
      assert.equal(state.provider, undefined);
      assert.equal(state.profile?.id, input.id);
      state.profile = undefined;
      return { outcome: "DELETION_OUTCOME_COMPLETED" };
    },
    GetProviderProfile: () => state.profile && { profile: state.profile },
    GetSandboxConfig: () => state.config,
    GetSandboxPolicyStatus: () => state.policyStatus,
    GetSandboxProviderStatus: (input) => {
      state.statusReads.push(input);
      if (!state.providerStatus) {
        return undefined;
      }
      if (input.receipt_id !== undefined) {
        if (input.receipt_id !== record(state.providerStatus.receipt).receipt_id) {
          return undefined;
        }
        const status = structuredClone(state.providerStatus);
        if (status.state === "PROVIDER_READINESS_STATE_PENDING") {
          if (state.updateReadiness === "converge") {
            // The Gateway first reports PENDING; the controlled supervisor then installs v2.
            advanceProviderEnvironment();
          } else if (state.updateReadiness === "cancel-pending") {
            setImmediate(() => state.abortOnPending?.());
          }
        }
        return { status };
      }
      // A provider-only query creates a new Gateway-owned OBSERVE receipt.
      const receiptId = randomUUID();
      const receipt = record(state.providerStatus.receipt);
      receipt.receipt_id = receiptId;
      receipt.mutation_id = receiptId;
      receipt.kind = "PROVIDER_MUTATION_KIND_OBSERVE";
      if (state.providerStatus.operation) {
        record(state.providerStatus.operation).operation_id = receiptId;
      }
      return { status: state.providerStatus };
    },
    ImportProviderProfiles: (input) => {
      const profiles = input.profiles as Wire[];
      state.profile = {
        ...record(profiles[0]?.profile),
        resource_version: "1",
      };
      return { imported: true };
    },
    CreateProvider: (input) => {
      const supplied = record(input.provider);
      const metadata = record(supplied.metadata);
      state.creates.push(input);
      state.provider = {
        metadata: {
          ...metadata,
          id: state.creates.length === 1 ? "f1d7e6c5-1b2a-4c3d-8e9f-102938475602" : randomUUID(),
          name: String(metadata.name),
          workspace: namespace.name,
          resource_version: "7",
          labels: metadata.labels as Record<string, string>,
        },
        type: String(supplied.type),
        profile_workspace: String(supplied.profile_workspace),
        config: supplied.config as Record<string, string>,
      };
      if (state.createMode === "stale-winner") {
        state.provider.config = { oce_source_version: "source-v0" };
        throw Object.assign(new Error("already exists"), { code: grpc.status.ALREADY_EXISTS });
      }
      return { provider: state.provider };
    },
    UpdateProvider: (input) => {
      state.updates.push(input);
      const supplied = record(input.provider);
      const metadata = record(supplied.metadata);
      if (
        !state.provider ||
        metadata.name !== state.provider.metadata.name ||
        metadata.resource_version !== state.provider.metadata.resource_version
      ) {
        throw Object.assign(new Error("Provider resource version changed"), {
          code: grpc.status.ABORTED,
        });
      }
      state.provider.config = {
        ...state.provider.config,
        ...(supplied.config as Record<string, string> | undefined),
      };
      state.provider.metadata.resource_version = String(
        BigInt(state.provider.metadata.resource_version) + 1n,
      );
      const mutationId = randomUUID();
      const receipts: Wire[] = [];
      if (sandbox.spec.providers.includes(state.provider.metadata.name)) {
        const prior = state.providerStatus;
        assert.ok(
          prior || sandbox.status.configuration_activated === false,
          "An attached Provider update needs either an idle target or simulated supervisor evidence.",
        );
        const receiptId = randomUUID();
        const time = { seconds: String(Math.floor(Date.now() / 1_000)), nanos: 0 };
        const priorDesired = prior && record(record(prior.receipt).desired);
        const desired = {
          ...(priorDesired ?? {
            sandbox_id: sandbox.metadata.id,
            sandbox: sandbox.metadata.name,
            attachment_epoch: sandbox.spec.provider_attachment_epoch,
            provider_id: state.provider.metadata.id,
          }),
          provider_resource_version: state.provider.metadata.resource_version,
          ...(priorDesired && {
            provider_env_revision: String(BigInt(String(priorDesired.provider_env_revision)) + 1n),
          }),
        };
        const receipt = {
          receipt_id: receiptId,
          mutation_id: mutationId,
          provider: state.provider.metadata.name,
          workspace: namespace.name,
          kind: "PROVIDER_MUTATION_KIND_UPDATE",
          desired,
          persisted_time: time,
        };
        receipts.push(receipt);
        if (prior) {
          const observed = { ...record(prior.observed) };
          // Controlled Gateway admission and supervisor evidence advance only when v2 serves.
          state.providerStatus = {
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
        }
      }
      return { provider: state.provider, mutation_id: mutationId, target_receipts: receipts };
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
      assert.ok(state.provider);
      const providerId = state.provider.metadata.id;
      const providerResourceVersion = state.provider.metadata.resource_version;
      const mutationId = randomUUID();
      target.spec.providers.push(provider);
      target.spec.provider_attachment_epoch = mutationId;
      target.metadata.resource_version = String(BigInt(target.metadata.resource_version) + 1n);
      if (state.attachMode === "provider-race") {
        state.provider.metadata.resource_version = "8";
      }
      const receipt = {
        receipt_id: randomUUID(),
        mutation_id: mutationId,
        provider,
        workspace: namespace.name,
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
      const definition = name === "AttachSandboxProvider" ? independent[name] : production[name];
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
  const selectedSandbox = {
    id: "sandbox",
    implementation: "openshell",
    harnessResource: ({ revision }: { revision: { agentId: string; id: string } }) => ({
      namespaceName: namespace.name,
      resourceName:
        sandboxes.find(
          (candidate) =>
            candidate.metadata.annotations["openclaw.dev/agent-id"] === revision.agentId &&
            candidate.metadata.annotations["openclaw.dev/revision-id"] === revision.id,
        )?.metadata.name ?? sandbox.metadata.name,
      agentId: revision.agentId,
      revisionId: revision.id,
    }),
  } as unknown as SandboxDriver;
  const backend = {
    id: "backend",
    client: new OpenShellGateway({ serviceName: "openshell" }, { gatewayClient: client }),
  } as unknown as Backend<OpenShellGateway>;
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
    return namespace;
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
    namespace,
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
      workspace: namespace.name,
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
        workspace: namespace.name,
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
    client,
    proxy,
    createProxy,
    context,
    sandbox,
    sandboxes,
    state,
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

test("staged OpenShell Proxy rejects an unsupported TokenService before resolving or mutating the Gateway", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.createProxy("openshell/token-service"), {
    message: "Native credential delivery requires the OCC TokenService implementation.",
  });
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
        const providerId = f.state.provider!.metadata.id;
        const failedReceiptId = record(f.state.providerStatus!.receipt).receipt_id;
        f.state.updateReadiness = "converge";

        // Source custody is already at v2. A manual delivery retry reuses the Provider and
        // succeeds only after a new UPDATE receipt confirms that its serving target caught up.
        await f.notify("source-v2");

        assert.equal(f.state.updates.length, 2);
        assert.equal(f.state.creates.length, 1);
        assert.equal(f.state.provider!.metadata.id, providerId);
        assert.equal(f.state.provider!.config.oce_source_version, "source-v2");
        assert.notEqual(record(f.state.providerStatus!.receipt).receipt_id, failedReceiptId);
        assert.equal(record(f.state.providerStatus!.observed).provider_env_revision, "14");
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

test("staged OpenShell Proxy observes the final Gateway configuration and serving Provider", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.observeServing();
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
        bindingRefs: [binding.bindingRef],
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
      bindingRefs: [binding.bindingRef],
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
