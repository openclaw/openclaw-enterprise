import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  ConfigurationValidationError,
  HarnessWorkloadRequirements,
} from "../../packages/contracts/src/index.ts";
import { SandboxGatewayUnauthorizedError } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { openShellWorkspaceChartResources } from "../fixtures/openshell-workspace-chart.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import type { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import {
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type GatewayClient = ReturnType<typeof workspaceGatewayClient>;
type NamespaceContext = Parameters<OpenShellSandboxDriver["ensureNamespace"]>[0];
type SandboxInstallation = ReturnType<typeof buildSandboxInstallation>;
type SandboxInput = SandboxInstallation["drivers"]["sandbox"]["configuration"];
type RefusalDetail = ConfigurationValidationError["error"]["details"][number];
type ConfigurationMutation = (configuration: SandboxInstallation) => void;
type RuntimeOptions = { codexConfig?: string; runtimeManifest?: string };
type RuntimeFixture = {
  context: NamespaceContext;
  revision: SandboxFixtureRevision;
  requirements: Omit<HarnessWorkloadRequirements, "files"> & {
    files: HarnessWorkloadRequirements["files"];
  };
};
type ProviderScenario = {
  name: string;
  mutate?: (fixture: RuntimeFixture) => void;
  fixture?: RuntimeOptions;
  foreignProvider?: boolean;
  expected: RegExp;
};
type GatewayStep =
  "health" | "createWorkspace" | "deleteWorkspace" | "deleteSandbox" | "listProviders";
const grpcStatusNames = [
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "FAILED_PRECONDITION",
  "RESOURCE_EXHAUSTED",
  "NOT_FOUND",
] as const;
type GrpcStatusName = (typeof grpcStatusNames)[number];
type GrpcModule = { status: Record<GrpcStatusName, number>; Metadata: new () => object };
function isGrpcModule(value: unknown): value is GrpcModule {
  const module = asRecord(value);
  const status = asRecord(module?.status);
  return (
    typeof module?.Metadata === "function" &&
    status !== undefined &&
    grpcStatusNames.every((name) => typeof status[name] === "number")
  );
}

type Fixtures = {
  conformanceKubernetesOptions: (options: {
    gatewayTrustedProxyCidrs: string[];
  }) => ConstructorParameters<typeof KubernetesComputeDriver>[0];
  controllerRequire: (id: "@grpc/grpc-js") => unknown;
  endpointOf: (
    configuration: SandboxInstallation,
  ) => SandboxInput["policy"]["networkPolicies"][number]["endpoints"][number];
  invalidValue: (path: string, message: string) => RefusalDetail[];
  kubernetesObjectClient: (
    events: Array<["kubernetes", "patch" | "delete", string, string, string]>,
  ) => {
    patch: (resource: object) => Promise<object>;
    delete: (resource: object) => Promise<void>;
  };
  namespaceContext: () => NamespaceContext;
  openShellDriver: (client: GatewayClient) => OpenShellSandboxDriver;
  ownedWorkspace: (
    name: string,
    namespaceId: string,
  ) => NonNullable<Awaited<ReturnType<GatewayClient["getWorkspace"]>>>;
  policiesOf: (configuration: SandboxInstallation) => SandboxInput["policy"]["networkPolicies"];
  readinessWait: { serviceName: string; podSelector: Record<string, string> };
  rejectsAtStartup: (
    context: TestContext,
    change: ConfigurationMutation,
    expected: readonly RefusalDetail[],
  ) => Promise<void>;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options?: RuntimeOptions,
  ) => RuntimeFixture;
  sandboxInstallation: () => SandboxInstallation;
  sandboxOf: (configuration: SandboxInstallation) => SandboxInput;
  sandboxRecord: (
    name: string,
    workspace: string,
  ) => NonNullable<Awaited<ReturnType<GatewayClient["getSandbox"]>>>;
  structuralRefusal: (
    path: string,
    keyword: string,
    code?: RefusalDetail["code"],
  ) => RefusalDetail[];
};

export function createSandboxStartupGuardChecks({
  conformanceKubernetesOptions,
  controllerRequire,
  endpointOf,
  invalidValue,
  kubernetesObjectClient,
  namespaceContext,
  openShellDriver,
  ownedWorkspace,
  policiesOf,
  readinessWait,
  rejectsAtStartup,
  runtimeSandboxFixture,
  sandboxInstallation,
  sandboxOf,
  sandboxRecord,
  structuralRefusal,
}: Fixtures) {
  return {
    async rejectsUnsupportedOrForeignRuntimeProviders(t: TestContext) {
      const scenarios: ProviderScenario[] = [
        {
          name: "missing managed file",
          mutate({ requirements }) {
            requirements.files = requirements.files.slice(0, 1);
          },
          expected: /requires its exact bounded plugin-runtime files/,
        },
        {
          name: "oversized managed file",
          fixture: { codexConfig: "x".repeat(65_537) },
          expected: /requires its exact bounded plugin-runtime files/,
        },
        {
          name: "non-Codex manifest",
          fixture: {
            runtimeManifest: JSON.stringify({
              kind: "openclaw",
              selections: {},
            }),
          },
          expected: /requires a Codex plugin-runtime manifest/,
        },
        {
          name: "foreign provider collision",
          foreignProvider: true,
          expected: /without exact AgentRevision ownership and content/,
        },
      ];

      for (const scenario of scenarios) {
        await t.test(scenario.name, async () => {
          let sandboxCreates = 0;
          const gatewayClient = workspaceGatewayClient();
          gatewayClient.createSandbox = async () => {
            sandboxCreates++;
            throw new Error("an invalid runtime provider must not reach Sandbox creation");
          };
          if (scenario.foreignProvider) {
            gatewayClient.createProvider = async (request) => ({
              name: request.name,
              type: request.type,
              labels: { ...request.labels, "openclaw.dev/agent-id": "agt_foreign" },
              config: structuredClone(request.config ?? {}),
              resourceVersion: "1",
            });
          }
          const driver = openShellDriver(gatewayClient);
          const fixture = runtimeSandboxFixture(driver, scenario.fixture);
          scenario.mutate?.(fixture);

          await assert.rejects(
            driver.provisionHarness({
              ...fixture.context,
              revision: completeWorkspaceRevision(fixture.revision, fixture.requirements),
              requirements: fixture.requirements,
            }),
            (error) => {
              assert.match(String(error), scenario.expected);
              return true;
            },
          );
          assert.equal(sandboxCreates, 0);
        });
      }
    },
    async refusesControllerIdentity() {
      const grpc = controllerRequire("@grpc/grpc-js");
      assert.ok(isGrpcModule(grpc));
      // The grpc-js error shape unary() rejects with for these codes.
      const grpcError = (name: GrpcStatusName, details: string) =>
        Object.assign(new Error(`${grpc.status[name]} ${name}: ${details}`), {
          code: grpc.status[name],
          details,
          metadata: new grpc.Metadata(),
        });
      // A gateway whose `step` throws `error`, over an owned Workspace for `namespace` if given.
      const failing = (
        step: GatewayStep,
        error: Error,
        namespace?: NamespaceContext["namespace"],
      ) => {
        const seed = namespace === undefined ? [] : [ownedWorkspace(namespace.name, namespace.id)];
        const gatewayClient = workspaceGatewayClient(seed);
        gatewayClient[step] = async () => {
          throw error;
        };
        return gatewayClient;
      };
      const refusal = (name: GrpcStatusName) =>
        `OpenShell refused the controller gateway identity with gRPC ${name}.`;
      const keeps = (error: Error, message?: string) => (thrown: unknown) => {
        assert.equal(thrown, error, message ?? "the original error must be retained");
        return true;
      };

      for (const [step, name] of [
        ["health", "UNAUTHENTICATED"],
        ["createWorkspace", "PERMISSION_DENIED"],
      ] as const) {
        const raw = grpcError(name, "refused");
        await assert.rejects(
          openShellDriver(failing(step, raw)).ensureNamespace(namespaceContext()),
          {
            name: "SandboxNamespaceRefusedError",
            message: refusal(name),
            cause: raw,
          },
        );
      }
      {
        const context = namespaceContext();
        const denied = grpcError("PERMISSION_DENIED", "workspace:delete");
        await assert.rejects(
          openShellDriver(failing("deleteWorkspace", denied, context.namespace)).cleanup(context),
          { name: "SandboxNamespaceRefusedError", message: refusal("PERMISSION_DENIED") },
        );
      }
      // Revision cleanup is not a Namespace step: a refusal there fails closed with the revision
      // code SANDBOX_GATEWAY_UNAUTHORIZED (finding 1676), and a non-identity error keeps its class.
      {
        const raw = grpcError("PERMISSION_DENIED", "sandbox:delete");
        const gatewayClient = failing("deleteSandbox", raw);
        gatewayClient.getSandbox = async (request) =>
          sandboxRecord(request.name, request.workspace);
        const driver = openShellDriver(gatewayClient);
        const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(driver);
        const revision = completeWorkspaceRevision(fixtureRevision, requirements);
        await assert.rejects(driver.cleanup({ ...context, revision }), (error) => {
          assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
          assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
          assert.equal(error.cause, raw);
          return true;
        });
        const busy = grpcError("RESOURCE_EXHAUSTED", "rate limit");
        gatewayClient.deleteSandbox = async () => {
          throw busy;
        };
        await assert.rejects(driver.cleanup({ ...context, revision }), keeps(busy));
      }
      // Other passed-through codes keep their error: FAILED_PRECONDITION names a Workspace state and
      // RESOURCE_EXHAUSTED a rate limit or busy admission workers, neither of them the identity.
      for (const name of ["FAILED_PRECONDITION", "RESOURCE_EXHAUSTED"] as const) {
        const passedThrough = grpcError(name, "not an identity refusal");
        const gatewayClient = failing("createWorkspace", passedThrough);
        await assert.rejects(
          openShellDriver(gatewayClient).ensureNamespace(namespaceContext()),
          keeps(passedThrough, name),
        );
      }
      // A Workspace removed between Namespace cleanup's read and its provider listing answers
      // NOT_FOUND. Cleanup keeps that error: it names a missing Workspace, not the identity.
      {
        const context = namespaceContext();
        const missing = grpcError("NOT_FOUND", "workspace not found");
        const gatewayClient = failing("listProviders", missing, context.namespace);
        await assert.rejects(openShellDriver(gatewayClient).cleanup(context), keeps(missing));
      }

      // Contract classification only: Kubernetes I/O is stubbed. Real provider setup is covered
      // by the separate Namespace bootstrap integration, not by these refusal responses.
      const { sandboxNamespaceLifecycleBinding } =
        await import("../../apps/controller/src/composition/namespace-lifecycle.ts");
      const { reconcileNamespaceLifecycle } =
        await import("../../packages/occ/src/namespace-lifecycle.ts");
      const tenant = namespaceContext().namespace;
      const placement = { name: tenant.name, plane: "execution" };
      const compute = (gatewayClient: GatewayClient) => {
        const sandbox = openShellDriver(gatewayClient);
        const driver = new KubernetesComputeDriver(
          conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["10.42.0.0/16"] }),
          { sandboxDriver: sandbox },
        );
        const observed = {
          metadata: { name: tenant.name, uid: "namespace-uid", labels: {}, annotations: {} },
          status: { phase: "Active" },
        };
        Object.assign(driver, {
          apiClients: Promise.resolve({ objects: kubernetesObjectClient([]) }),
          resolveNamespace: async () => ({ name: placement, external: false }),
          reconcile: async () => {},
          getNamespace: async () => structuredClone(observed),
          verifyNamespaceOwnership: () => {},
          prepareNamespaceInfrastructure: async () => {},
          ensureGatewayNamespace: async () => true,
        });
        const binding = sandboxNamespaceLifecycleBinding(driver, sandbox);
        return { driver, participants: [{ id: sandbox.id, hooks: binding.hooks }] };
      };
      // A refused identity fails at once. A refusal Compute cannot classify stays retryable, with a
      // fixed reason and no "HTTP status 9" or "HTTP status 8": a rate limit clears by itself.
      for (const [name, failure, reason] of [
        ["PERMISSION_DENIED", "permanent", refusal("PERMISSION_DENIED")],
        ["UNAUTHENTICATED", "permanent", refusal("UNAUTHENTICATED")],
        ["FAILED_PRECONDITION", "retryable", "Namespace preparation failed."],
        ["RESOURCE_EXHAUSTED", "retryable", "Namespace preparation failed."],
      ] as const) {
        const gatewayClient = failing("createWorkspace", grpcError(name, "workspace:create"));
        const selected = compute(gatewayClient);
        assert.deepEqual(
          await reconcileNamespaceLifecycle(
            selected.driver,
            selected.participants,
            tenant,
            "ready",
            new AbortController().signal,
            () => {},
          ),
          {
            namespaceId: tenant.id,
            namespaceReady: false,
            failure,
            reason,
          },
        );
      }
      // Namespace deletion fails at once too, and keeps the Kubernetes namespace.
      const expired = grpcError("UNAUTHENTICATED", "token expired");
      const deleting = compute(failing("deleteWorkspace", expired, tenant));
      Object.assign(deleting.driver, {
        deleteGatewayNamespace: async () => assert.fail("cleanup must fail first"),
      });
      assert.deepEqual(
        await reconcileNamespaceLifecycle(
          deleting.driver,
          deleting.participants,
          { ...tenant, status: "deleting" },
          "deleted",
          new AbortController().signal,
          () => {},
        ),
        {
          namespaceId: tenant.id,
          namespaceDeleted: false,
          failure: "permanent",
        },
      );
    },
    async refusesUnknownSettingsAndInvalidResources(t: TestContext) {
      for (const [change, path] of [
        [(c) => Object.assign(sandboxOf(c).kubernetes, { userNamespace: false }), "/kubernetes"],
        [
          (c) => Object.assign(sandboxOf(c).kubernetes.serviceAccount, { name: "sandbox" }),
          "/kubernetes/serviceAccount",
        ],
        [
          (c) => Object.assign(sandboxOf(c).kubernetes.sandboxDataMount, { readonly: true }),
          "/kubernetes/sandboxDataMount",
        ],
        [
          (c) => Object.assign(sandboxOf(c).kubernetes, { agentResources: { request: {} } }),
          "/kubernetes/agentResources",
        ],
        [
          (c) => Object.assign(sandboxOf(c).policy, { filesytem: { readWrite: ["/data"] } }),
          "/policy",
        ],
        [
          (c) => Object.assign(sandboxOf(c).policy.process, { runAsUserName: "sandbox" }),
          "/policy/process",
        ],
        [
          (c) =>
            Object.assign(sandboxOf(c).gateway, {
              readiness: { ...readinessWait, timeoutMs: 1, pollInterval: 5 },
            }),
          "/gateway/readiness",
        ],
      ] satisfies [ConfigurationMutation, string][]) {
        await rejectsAtStartup(
          t,
          change,
          structuralRefusal(path, "additionalProperties", "UNKNOWN_FIELD"),
        );
      }
      const quantity =
        "Each value must be a quoted, non-negative Kubernetes quantity, such as 500m or 1Gi.";
      for (const agentResources of [
        { requests: { cpu: "one" } },
        { limits: { memory: 5 } },
        // Quantities are strings: without the type check 512 would parse as a quantity (5 does not).
        { requests: { memory: 512 } },
        { limits: { cpu: "1", "example.com/gpu": "1 Gi" } },
        { requests: { cpu: "-500m" } },
      ]) {
        const [section] = Object.keys(agentResources);
        await rejectsAtStartup(
          t,
          (c) => Object.assign(sandboxOf(c).kubernetes, { agentResources }),
          invalidValue(`/kubernetes/agentResources/${section}`, quantity),
        );
      }
      await rejectsAtStartup(
        t,
        (c) =>
          Object.assign(sandboxOf(c).kubernetes, {
            agentResources: {
              requests: { cpu: "1500m", memory: "1Gi" },
              limits: { cpu: "1", memory: "2Gi" },
            },
          }),
        [
          {
            path: "/kubernetes/agentResources/requests",
            code: "INVALID_RANGE",
            message: "The cpu request (1500m) cannot exceed its limit (1).",
          },
        ],
      );
      // Every resource is compared, not only the first.
      await rejectsAtStartup(
        t,
        (c) =>
          Object.assign(sandboxOf(c).kubernetes, {
            agentResources: {
              requests: { cpu: "1", memory: "3Gi" },
              limits: { cpu: "1", memory: "2Gi" },
            },
          }),
        [
          {
            path: "/kubernetes/agentResources/requests",
            code: "INVALID_RANGE",
            message: "The memory request (3Gi) cannot exceed its limit (2Gi).",
          },
        ],
      );
      // An invalid limit is reported once, without also comparing the request against it.
      await rejectsAtStartup(
        t,
        (c) =>
          Object.assign(sandboxOf(c).kubernetes, {
            agentResources: {
              requests: { cpu: "1" },
              limits: { cpu: "-1" },
            },
          }),
        invalidValue("/kubernetes/agentResources/limits", quantity),
      );
      // Control: every known key, and quantities in each spelling the API server accepts, load.
      const accepted = sandboxInstallation();
      Object.assign(sandboxOf(accepted).kubernetes, {
        // Zero is a valid quantity, and a request needs no limit.
        agentResources: {
          requests: {
            cpu: "500m",
            memory: "1Gi",
            "example.com/gpu": "1",
            "ephemeral-storage": "0",
          },
          limits: { cpu: "0.5", memory: "4e9", "example.com/gpu": "1" },
        },
      });
      Object.assign(sandboxOf(accepted).kubernetes.sandboxDataMount, { claimName: "workspace" });
      Object.assign(sandboxOf(accepted).gateway, {
        readiness: { ...readinessWait, timeoutMs: 1, pollIntervalMs: 5 },
      });
      await loadInstallationFile(t, accepted);
    },
    async refusesInvalidAgentResourceOverrides(t: TestContext) {
      const override = {
        namespaceId: "ns_00000000-0000-4000-8000-000000000001",
        agentId: "agt_00000000-0000-4000-8000-000000000003",
        requests: { cpu: "88" },
        limits: { cpu: "90" },
      };
      const path = "/kubernetes/agentResourceOverrides";
      for (const [field, value] of [
        ["namespaceId", `${override.namespaceId} `],
        ["agentId", "agent-display-name"],
      ] as const) {
        await t.test(`refuses a malformed ${field}`, async (scopeTest) => {
          await rejectsAtStartup(
            scopeTest,
            (c) => {
              Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [
                { ...override, [field]: value },
              ]);
            },
            structuralRefusal(`${path}/0/${field}`, "pattern", "INVALID_FORMAT"),
          );
        });
      }
      await rejectsAtStartup(
        t,
        (c) => {
          Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [override, override]);
        },
        invalidValue(`${path}/1`, "An Agent can have only one resource override."),
      );
      await rejectsAtStartup(
        t,
        (c) => {
          Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [
            { ...override, requests: { cpu: "-1" } },
          ]);
        },
        invalidValue(
          `${path}/0/requests`,
          "Each value must be a quoted, non-negative Kubernetes quantity, such as 500m or 1Gi.",
        ),
      );
      await rejectsAtStartup(
        t,
        (c) => {
          const kubernetes = sandboxOf(c).kubernetes;
          Object.assign(kubernetes, {
            agentResources: { requests: { cpu: "1" }, limits: { cpu: "4" } },
          });
          Reflect.set(kubernetes, "agentResourceOverrides", [{ ...override, limits: {} }]);
        },
        [
          {
            path: `${path}/0/requests`,
            code: "INVALID_RANGE",
            message: "The cpu request (88) cannot exceed its limit (4).",
          },
        ],
      );
      await rejectsAtStartup(
        t,
        (c) => {
          Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [
            { ...override, limits: { "ephemeral-storage": "2Gi" } },
          ]);
        },
        structuralRefusal(`${path}/0/limits`, "additionalProperties", "UNKNOWN_FIELD"),
      );
      await rejectsAtStartup(
        t,
        (c) => {
          Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [
            { ...override, runtimeClassName: "bad/Name" },
          ]);
        },
        invalidValue(`${path}/0/runtimeClassName`, "Use a Kubernetes RuntimeClass resource name."),
      );
    },
    async refusesUnsupportedEndpointProtocols(t: TestContext) {
      const unknown =
        "Use tcp, rest, websocket, graphql or sql, or omit protocol; OpenShell needs rules for json-rpc and mcp, which this setting cannot express.";
      const tcpExtras =
        "Protocol tcp takes neither an access preset nor enforcement; remove them, or use an L7 protocol.";
      for (const [endpoint, message] of [
        [{ protocol: "http" }, unknown],
        [{ protocol: "json-rpc" }, unknown],
        [{ protocol: "mcp", access: "full" }, unknown],
        [
          { protocol: "rest" },
          "Protocol rest needs an access preset (read_only, read_write or full).",
        ],
        [
          { protocol: "WebSocket" },
          "Protocol websocket needs an access preset (read_only, read_write or full).",
        ],
        [{ protocol: "tcp", access: "full" }, tcpExtras],
        [{ protocol: "TCP", enforcement: "audit" }, tcpExtras],
        [
          { protocol: "sql", access: "read_only", enforcement: "enforce" },
          "Protocol sql supports enforcement audit only, since OpenShell cannot fully parse SQL.",
        ],
      ] as const) {
        await rejectsAtStartup(
          t,
          (c) => Object.assign(endpointOf(c), endpoint),
          invalidValue("/policy/networkPolicies/0/endpoints/0/protocol", message),
        );
      }
      // Every policy and endpoint is checked, and each detail names its own indexes.
      await rejectsAtStartup(
        t,
        (c) => {
          const firstPolicy = policiesOf(c)[0];
          assert.ok(firstPolicy);
          firstPolicy.endpoints.push(
            Object.assign({ host: "tools.example.test", ports: [443] }, { protocol: "http" }),
          );
          policiesOf(c).push({
            name: "database",
            endpoints: [
              Object.assign({ host: "db.example.test", ports: [5432] }, { protocol: "rest" }),
            ],
            binaries: [{ path: "/app/bin/model-client" }],
          });
        },
        [
          ...invalidValue("/policy/networkPolicies/0/endpoints/1/protocol", unknown),
          ...invalidValue(
            "/policy/networkPolicies/1/endpoints/0/protocol",
            "Protocol rest needs an access preset (read_only, read_write or full).",
          ),
        ],
      );
      // Control: the protocols the Gateway accepts without rules.
      for (const endpoint of [
        { protocol: "tcp" },
        { protocol: "TCP" },
        { protocol: "" },
        { protocol: "rest", access: "read_only" },
        { protocol: "sql", access: "full" },
        { protocol: "SQL", access: "full", enforcement: "audit" },
        { protocol: "graphql", access: "read_write", enforcement: "enforce" },
      ]) {
        const configuration = sandboxInstallation();
        Object.assign(endpointOf(configuration), endpoint);
        const loaded = await loadInstallationFile(t, configuration);
        // Some Gateway checks compare lowercase names, so the policy carries the protocol lowercase.
        const driver = loaded?.sandboxDriver;
        assert.ok(driver instanceof OpenShellSandboxDriver);
        const policy = asRecord(driver.admitNetworkPolicy([], 1).defaults["model-egress"]);
        assert.ok(policy);
        const endpoints = policy.endpoints;
        assert.ok(Array.isArray(endpoints));
        const sent = asRecord(endpoints[0]);
        assert.equal(sent?.protocol, endpoint.protocol.toLowerCase());
      }
    },
    async refusesSchemaOpenSettings(t: TestContext) {
      const refused = invalidValue("", "Configuration violates the Driver's constraints.");
      const dataMount = (c: SandboxInstallation) => sandboxOf(c).kubernetes.sandboxDataMount;
      for (const change of [
        (c) => Reflect.deleteProperty(sandboxOf(c).gateway, "workspaceMode"),
        // labels() refuses an empty map before the explicit empty check does.
        (c) => Object.assign(sandboxOf(c).gateway, { operatorNamespaceLabels: {} }),
        (c) =>
          Object.assign(sandboxOf(c).gateway, {
            operatorWorkspaceResources: [
              { apiVersion: "v2", kind: "ServiceAccount", metadata: { name: "sandbox" } },
            ],
          }),
        (c) =>
          Object.assign(sandboxOf(c).gateway, {
            readiness: { ...readinessWait, serviceName: "", timeoutMs: 1 },
          }),
        (c) => (dataMount(c).subPath = "."),
        (c) => (dataMount(c).mountPath = "/data"),
        (c) => Reflect.deleteProperty(dataMount(c), "readOnly"),
        // Sandbox names need 17 characters after the prefix (a dash and a 16-character hash),
        // and OpenShell allows 19.
        (c) => Object.assign(sandboxOf(c), { sandboxNamePrefix: "abc" }),
      ] satisfies ConfigurationMutation[]) {
        await rejectsAtStartup(t, change, refused);
      }
      // Control: the same fields load with accepted values.
      const accepted = sandboxInstallation();
      Object.assign(sandboxOf(accepted).gateway, {
        operatorNamespaceLabels: { team: "agents" },
        operatorWorkspaceResources: [
          { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "sandbox" } },
        ],
        readiness: { ...readinessWait, timeoutMs: 1 },
      });
      Object.assign(dataMount(accepted), {
        subPath: "a/b",
        mountPath: "/sandbox/data",
        readOnly: true,
      });
      Object.assign(sandboxOf(accepted), { sandboxNamePrefix: "ab" });
      await loadInstallationFile(t, accepted);
    },
    async refusesNonObjectNetworkPolicyIngress(t: TestContext) {
      for (const list of ["operatorWorkspaceResources", "networkPolicyResources"]) {
        for (const rule of [null, "allow"]) {
          await rejectsAtStartup(
            t,
            (c) =>
              Object.assign(sandboxOf(c).gateway, {
                [list]: [
                  {
                    apiVersion: "networking.k8s.io/v1",
                    kind: "NetworkPolicy",
                    metadata: { name: "sandbox-ingress" },
                    spec: { podSelector: {}, ingress: [rule] },
                  },
                ],
              }),
            // Both lists are write-only, so the detail names the list, not the item.
            invalidValue(`/gateway/${list}`, "Write each NetworkPolicy ingress rule as an object."),
          );
        }
      }
    },
    async refusesUnsentKubernetesFields(t: TestContext) {
      const policy = (spec: object) => ({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "provider-policy" },
        spec,
      });
      const [ssh, account, role, binding] = openShellWorkspaceChartResources();
      assert.ok(ssh && account && role && binding);
      const renamed = (
        resource: object,
        path: (string | number)[],
        from: string,
        to: string,
      ): object => {
        const copy = structuredClone(resource);
        const parent = path.reduce<unknown>((value, key) => {
          assert.ok(typeof value === "object" && value !== null);
          const child: unknown = Reflect.get(value, key);
          return child;
        }, copy);
        const record = asRecord(parent);
        assert.ok(record);
        assert.ok(Object.hasOwn(record, from));
        record[to] = record[from];
        delete record[from];
        return copy;
      };
      const unsent = (field: string) =>
        `The Kubernetes client does not send item 1 field ${field} as written. Use the Kubernetes field name and type.`;
      const cases: ["networkPolicyResources" | "operatorWorkspaceResources", object, string[]][] = [
        [
          "networkPolicyResources",
          policy({
            podSelector: {},
            ingress: [{ from: [{ podSelector: { matchLabel: { app: "worker" } } }] }],
          }),
          [unsent("/spec/ingress/0/from/0/podSelector/matchLabel")],
        ],
        [
          // The model names LimitRange `default` `_default`, so the wire field is dropped.
          "networkPolicyResources",
          {
            apiVersion: "v1",
            kind: "LimitRange",
            metadata: { name: "limits" },
            spec: {
              limits: [{ type: "Container", default: { cpu: "1" }, defaultRequests: { cpu: "1" } }],
            },
          },
          [unsent("/spec/limits/0/default"), unsent("/spec/limits/0/defaultRequests")],
        ],
        [
          // A custom resource passes through except its metadata, which the client still models.
          "networkPolicyResources",
          {
            apiVersion: "crd.antrea.io/v1beta1",
            kind: "NetworkPolicy",
            metadata: { name: "provider-crd", label: { app: "worker" } },
            spec: {},
          },
          [unsent("/metadata/label")],
        ],
        [
          // A list written as a string is sent split into characters.
          "networkPolicyResources",
          policy({ podSelector: {}, ingress: [{ ports: "2222" }] }),
          [unsent("/spec/ingress/0/ports")],
        ],
        [
          "networkPolicyResources",
          policy({ podSelector: {}, ingress: { from: [] } }),
          ["The Kubernetes client cannot serialize item 1. Use the Kubernetes field types."],
        ],
        [
          "operatorWorkspaceResources",
          renamed(ssh, ["spec", "podSelector"], "matchLabels", "matchLabel"),
          [unsent("/spec/podSelector/matchLabel")],
        ],
        [
          "operatorWorkspaceResources",
          { ...account, automountServiceAccountTokens: false },
          [unsent("/automountServiceAccountTokens")],
        ],
        [
          "operatorWorkspaceResources",
          renamed(role, ["rules", 0], "verbs", "verb"),
          [unsent("/rules/0/verb")],
        ],
        [
          "operatorWorkspaceResources",
          renamed(binding, [], "subjects", "subject"),
          [unsent("/subject")],
        ],
      ];
      for (const [list, resource, messages] of cases) {
        await rejectsAtStartup(
          t,
          (c) =>
            Object.assign(sandboxOf(c).gateway, {
              [list]: [
                { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "first" } },
                resource,
              ],
            }),
          // Both lists are write-only, so the detail names the list and the message the field.
          messages.map((message) => ({ path: `/gateway/${list}`, code: "INVALID_VALUE", message })),
        );
      }
    },
  };
}
