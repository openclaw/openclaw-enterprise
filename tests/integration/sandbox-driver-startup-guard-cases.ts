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
  invalidValue: (path: string, message: string) => RefusalDetail[];
  kubernetesObjectClient: typeof import("./sandbox-driver-startup-orchestration.ts").kubernetesObjectClient;
  namespaceContext: () => NamespaceContext;
  openShellDriver: (client: GatewayClient) => OpenShellSandboxDriver;
  ownedWorkspace: (
    name: string,
    namespaceId: string,
  ) => NonNullable<Awaited<ReturnType<GatewayClient["getWorkspace"]>>>;
  rejectsAtStartup: (
    context: TestContext,
    change: ConfigurationMutation,
    expected: readonly RefusalDetail[],
  ) => Promise<void>;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options?: RuntimeOptions,
  ) => RuntimeFixture;
  sandboxOf: (configuration: SandboxInstallation) => SandboxInput;
  sandboxRecord: (
    name: string,
    workspace: string,
  ) => NonNullable<Awaited<ReturnType<GatewayClient["getSandbox"]>>>;
};

export function createSandboxStartupGuardChecks({
  conformanceKubernetesOptions,
  controllerRequire,
  invalidValue,
  kubernetesObjectClient,
  namespaceContext,
  openShellDriver,
  ownedWorkspace,
  rejectsAtStartup,
  runtimeSandboxFixture,
  sandboxOf,
  sandboxRecord,
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
  };
}
