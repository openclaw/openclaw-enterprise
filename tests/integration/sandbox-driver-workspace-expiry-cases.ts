import assert from "node:assert/strict";
import test from "node:test";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
  OpenShellServiceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  HarnessWorkloadRequirements,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import type { WorkspaceNodeSetupEnvelope } from "../../packages/utils/src/index.ts";
import {
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { registerSandboxDriverWorkspaceExpiryRefusalCases } from "./sandbox-driver-workspace-expiry-refusal-cases.ts";
import {
  workspaceNodeSetupSecretData,
  overrideWorkspaceSetupSecretRead,
  type KubernetesReader,
} from "./sandbox-driver-workspace-node-setup-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Gateway = ReturnType<typeof workspaceGatewayClient>;
type RuntimeFixture = {
  context: SandboxNamespaceContext & {
    kubernetes: KubernetesReader;
  };
  revision: SandboxFixtureRevision;
  requirements: HarnessWorkloadRequirements;
  nodeSetup: WorkspaceNodeSetupEnvelope;
};
export type Fixtures = {
  openShellDriver: (gateway: Gateway) => OpenShellSandboxDriver;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options?: { harnessId?: string },
  ) => RuntimeFixture;
  storedSandbox: (
    request: OpenShellSandboxCreateRequest,
    fields?: Partial<OpenShellSandboxResponse>,
  ) => OpenShellSandboxResponse;
  harnessService: (
    sandbox: string,
    name: string,
    url: string,
  ) => OpenShellServiceResponse | undefined;
  callCount: (gateway: Gateway, operation: string) => number;
};
export function registerSandboxDriverWorkspaceExpiryCases({
  openShellDriver,
  runtimeSandboxFixture,
  storedSandbox,
  harnessService,
  callCount,
}: Fixtures): void {
  for (const harnessId of ["codex", "openclaw"]) {
    test(`OpenShell preserves expired ${harnessId} setup for a recorded workspace node`, async () => {
      const gatewayClient: Gateway = workspaceGatewayClient();
      let sandboxName: string | undefined;
      const serviceUrl = "http://codex.example.test:8080/";
      gatewayClient.createSandbox = async (request) => {
        sandboxName = request.name;
        const sandbox = storedSandbox(request, {
          serviceUrls: harnessId === "codex" ? { "": serviceUrl } : {},
        });
        gatewayClient.sandboxes.set(request.name, sandbox);
        return sandbox;
      };
      gatewayClient.getService = async () => {
        assert.ok(sandboxName);
        return harnessService(sandboxName, "", serviceUrl);
      };
      const driver = openShellDriver(gatewayClient);
      const {
        context,
        revision: fixtureRevision,
        requirements,
        nodeSetup,
      } = runtimeSandboxFixture(driver, {
        harnessId,
      });
      const revision = completeWorkspaceRevision(fixtureRevision, requirements);
      const expiredSetup = { ...nodeSetup, expiresAtMs: Date.now() - 1 };
      overrideWorkspaceSetupSecretRead(context.kubernetes, {
        ...workspaceNodeSetupSecretData(expiredSetup),
        deviceId: Buffer.from("recorded-node:1").toString("base64"),
      });

      // A replacement Harness must receive the retained envelope so native can
      // verify its saved identity and device token. This is provider planning,
      // not proof that the native runtime accepts those credentials.
      const provision = () => driver.provisionHarness({ ...context, revision, requirements });
      await provision();
      const [provider] = [...gatewayClient.providers.values()];
      assert.ok(provider);
      const setupJson = provider.config.node_setup_json;
      assert.ok(typeof setupJson === "string");
      const parsedSetup: unknown = JSON.parse(setupJson);
      assert.deepEqual(parsedSetup, expiredSetup);
      assert.equal(callCount(gatewayClient, "createProvider"), 1);

      // Reconciliation of that exact expired envelope must not rotate a provider
      // or rewrite its setup merely because the original bootstrap has expired.
      await provision();
      assert.equal(callCount(gatewayClient, "createProvider"), 1);
      assert.equal(callCount(gatewayClient, "updateProviderConfig"), 0);
      assert.equal(callCount(gatewayClient, "updateProviderCredentials"), 0);
    });
  }

  registerSandboxDriverWorkspaceExpiryRefusalCases({ openShellDriver, runtimeSandboxFixture });
}
