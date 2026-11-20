import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  Backend,
  DeploymentRequestMatch,
  ProxyRevisionContext,
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
    spec: { providers: [] as string[], provider_attachment_epoch: "" },
  };
  const state = {
    profile: undefined as Wire | undefined,
    provider: undefined as Provider | undefined,
    creates: [] as Wire[],
    updates: [] as Wire[],
    attaches: [] as Wire[],
    sandboxReads: 0,
    createMode: "normal" as "normal" | "stale-winner",
    attachMode: "normal" as
      | "normal"
      | "cas-race"
      | "provider-race"
      | "receipt-provider-id-mismatch"
      | "incarnation-race"
      | "detach-race",
    detachOnNextSandboxRead: false,
  };
  const methods: Record<string, Handler> = {
    GetSandbox: () => {
      state.sandboxReads++;
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
    GetProviderProfile: () => state.profile && { profile: state.profile },
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
      return {
        sandbox,
        attached: true,
        receipt: {
          receipt_id: randomUUID(),
          mutation_id: mutationId,
          provider,
          workspace: namespace.name,
          kind: "PROVIDER_MUTATION_KIND_ATTACH",
          desired: {
            sandbox_id: sandbox.metadata.id,
            sandbox: sandbox.metadata.name,
            attachment_epoch: mutationId,
            provider_id:
              state.attachMode === "receipt-provider-id-mismatch"
                ? "f1d7e6c5-1b2a-4c3d-8e9f-102938475604"
                : providerId,
            provider_resource_version: providerResourceVersion,
          },
          persisted_time: { seconds: "1790000000", nanos: 123 },
        },
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
  const proxy = new OpenShellCredentialProxyDriver(
    { middlewareName: "credential-proxy", authorityScope: "execution" },
    { id: "proxy", backend, sandbox: selectedSandbox },
  );
  // This is a direct Driver contract test; the published Agent workflow does not admit
  // TokenService credential delivery into a revision yet.
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
      harness: { ...revision.harness, modelProviderId: binding.consumer.providerId },
    },
    signal: t.signal,
  } satisfies Pick<ProxyRevisionContext, "namespace" | "revision" | "signal">;
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
  return {
    proxy,
    context,
    sandbox,
    state,
    suppliedBinding,
    configure,
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

test("staged OpenShell Proxy fails closed after attachment because executable authority is unqualified", async (t) => {
  const f = await fixture(t);
  await f.configure();
  const readsBeforeStatus = f.state.sandboxReads;
  assert.deepEqual(await f.proxy.getDeploymentStatus(f.context, configuration), {
    state: "failed",
    code: "NATIVE_EXECUTABLE_AUTHORITY_UNQUALIFIED",
  });
  assert.equal(f.state.sandboxReads, readsBeforeStatus);
});
