import assert from "node:assert/strict";
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
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";

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
      labels,
      annotations,
    },
    spec: {
      providers: [] as string[],
      provider_attachment_epoch: "",
      policy: undefined as Wire | undefined,
    },
    status: {} as Wire,
  };
  const state = {
    profile: undefined as Wire | undefined,
    provider: undefined as Provider | undefined,
    creates: [] as Wire[],
    updates: [] as Wire[],
    attaches: [] as Wire[],
    detaches: [] as Wire[],
    sandboxReads: 0,
    sandboxPresent: true,
    sandboxReadMode: "normal" as "normal" | "unavailable-after-detach",
    detachMode: "normal" as "normal" | "permission-denied",
    forbiddenMutations: [] as string[],
    config: undefined as Wire | undefined,
    policyStatus: undefined as Wire | undefined,
    providerStatus: undefined as Wire | undefined,
    statusReads: [] as Wire[],
    createMode: "normal" as "normal" | "stale-winner",
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
  const methods: Record<string, Handler> = {
    GetSandbox: () => {
      state.sandboxReads++;
      if (state.sandboxReadMode === "unavailable-after-detach" && state.detaches.length > 0) {
        throw Object.assign(new Error("Gateway unavailable"), { code: grpc.status.UNAVAILABLE });
      }
      if (!state.sandboxPresent) {
        return undefined;
      }
      if (state.detachOnNextSandboxRead) {
        sandbox.spec.providers = [];
        sandbox.metadata.resource_version = "7";
        state.detachOnNextSandboxRead = false;
      }
      return { sandbox };
    },
    GetWorkspace: () => ({
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
    }),
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
      const provider = String(input.provider);
      if (
        (sandbox.spec.policy && policyUsesProvider(sandbox.spec.policy, provider)) ||
        (state.config?.policy && policyUsesProvider(state.config.policy, provider))
      ) {
        throw Object.assign(new Error("Provider is still referenced by policy"), {
          code: grpc.status.FAILED_PRECONDITION,
        });
      }
      const detached = sandbox.spec.providers.includes(provider);
      sandbox.spec.providers = sandbox.spec.providers.filter((name) => name !== provider);
      const mutationId = randomUUID();
      if (detached) {
        sandbox.metadata.resource_version = String(BigInt(sandbox.metadata.resource_version) + 1n);
        sandbox.spec.provider_attachment_epoch = mutationId;
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
            sandbox_id: sandbox.metadata.id,
            sandbox: sandbox.metadata.name,
            attachment_epoch: sandbox.spec.provider_attachment_epoch,
            provider_env_revision: String(state.config?.provider_env_revision ?? "1"),
            config_revision: String(state.config?.config_revision ?? "1"),
            policy_hash: String(state.config?.policy_hash ?? "b".repeat(64)),
          },
          persisted_time: { seconds: String(Math.floor(Date.now() / 1_000)), nanos: 0 },
        },
      };
    },
    DeleteProvider: () => {
      state.forbiddenMutations.push("DeleteProvider");
      assert.fail("target cleanup must not delete a shared Provider");
    },
    GetProviderProfile: () => state.profile && { profile: state.profile },
    GetSandboxConfig: () => state.config,
    GetSandboxPolicyStatus: () => state.policyStatus,
    GetSandboxProviderStatus: (input) => {
      state.statusReads.push(input);
      if (!state.providerStatus) {
        return undefined;
      }
      // A provider-only query creates a new Gateway-owned OBSERVE receipt.
      const receiptId = randomUUID();
      const receipt = record(state.providerStatus.receipt);
      receipt.receipt_id = receiptId;
      receipt.mutation_id = receiptId;
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
          id: "f1d7e6c5-1b2a-4c3d-8e9f-102938475602",
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
      return state.provider && { provider: state.provider };
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
      if (state.attachMode === "cas-race") {
        sandbox.metadata.resource_version = "6";
      }
      if (state.attachMode === "incarnation-race") {
        // Native attach resolves the name again, so a new ID can have the same version.
        sandbox.metadata.id = "f1d7e6c5-1b2a-4c3d-8e9f-102938475603";
      }
      if (input.expected_resource_version !== sandbox.metadata.resource_version) {
        throw Object.assign(new Error("resource version changed"), {
          code: grpc.status.ABORTED,
        });
      }
      const provider = String(input.provider);
      assert.ok(state.provider);
      const providerId = state.provider.metadata.id;
      const providerResourceVersion = state.provider.metadata.resource_version;
      const mutationId = randomUUID();
      sandbox.spec.providers.push(provider);
      sandbox.spec.provider_attachment_epoch = mutationId;
      sandbox.metadata.resource_version = "6";
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
          sandbox_id: sandbox.metadata.id,
          sandbox: sandbox.metadata.name,
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
        sandbox,
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
    harnessResource: () => ({
      namespaceName: namespace.name,
      resourceName: sandbox.metadata.name,
      agentId: configuration.targetRef.agentId,
      revisionId: configuration.targetRef.revisionId,
    }),
  } as unknown as SandboxDriver;
  const backend = {
    id: "backend",
    client: new OpenShellGateway({ serviceName: "openshell" }, { gatewayClient: client }),
  } as unknown as Backend<OpenShellGateway>;
  const proxy = new OpenShellCredentialProxyDriver({
    id: selectedSandbox.id,
    implementation: selectedSandbox.implementation,
    backend,
    sandbox: selectedSandbox,
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
  const suppliedBinding = {
    binding,
    resolveCredential: async () => {
      resolutions++;
      return { credential: "synthetic-material", version: "source-v1" };
    },
  };
  const configure = (overrides: Partial<ConfigureInput> = {}) =>
    proxy.configureDeployment(context, {
      ...configuration,
      bindings: [suppliedBinding],
      injectionPolicies: [injection],
      ...overrides,
    });
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
      reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
    };
    state.providerStatus = {
      state: "PROVIDER_READINESS_STATE_READY",
      reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
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
    context,
    sandbox,
    state,
    suppliedBinding,
    configure,
    observeServing,
    removeCredentialRoute,
    resolutions: () => resolutions,
  };
}

test("staged OpenShell Proxy transfers once, attaches with CAS, and reuses without resolving", async (t) => {
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
            f.state.provider!.metadata.name,
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
      assert.notEqual((await f.proxy.getDeploymentStatus(f.context, configuration)).state, "ready");
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
      assert.deepEqual(f.state.provider, provider);
      assert.deepEqual(f.state.forbiddenMutations, []);
    },
  );
  assert.equal(f.resolutions(), 1);
  assert.equal(f.state.updates.length, 0);
});

test("staged OpenShell Proxy detaches a target binding without deleting its shared Provider", async (t) => {
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
  const restoredProvider = structuredClone(currentProvider);

  f.state.detachMode = "permission-denied";
  await assert.rejects(remove(), (error: unknown) => {
    assert.ok(error instanceof DependencyUnavailableError);
    assert.doesNotMatch(String(error), /upstream-private-detail/);
    return true;
  });
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

  // Repeating cleanup for an absent binding or target must not mutate the shared Source copy.
  await remove();
  assert.deepEqual(f.state.provider, restoredProvider);
  f.state.sandboxPresent = false;
  await remove();

  assert.equal(f.resolutions(), 1);
  assert.equal(f.state.detaches.length, 3);
  assert.deepEqual(f.state.forbiddenMutations, []);
  assert.equal(f.state.updates.length, 0);
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
  assert.deepEqual(f.state.forbiddenMutations, []);
});
