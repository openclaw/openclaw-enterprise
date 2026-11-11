import assert from "node:assert/strict";
import test from "node:test";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxResponse,
  OpenShellServiceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  HarnessWorkloadRequirements,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Gateway = Omit<
  ReturnType<typeof workspaceGatewayClient>,
  "createSandbox" | "getSandbox" | "getService"
> &
  Pick<OpenShellGatewayClient, "createSandbox" | "getSandbox"> & {
    getService: () => Promise<
      Pick<OpenShellServiceResponse, "targetPort" | "authorizationMode" | "url"> | undefined
    >;
  };
type RuntimeFixture = {
  context: SandboxNamespaceContext & {
    kubernetes: {
      read: (request: {
        metadata: { name: string; namespace?: string };
        [key: string]: unknown;
      }) => Promise<unknown>;
    };
  };
  revision: SandboxFixtureRevision;
  requirements: HarnessWorkloadRequirements;
};
type Fixtures = {
  openShellDriver: (gatewayClient: Gateway) => OpenShellSandboxDriver;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options?: { harnessId?: string },
  ) => RuntimeFixture;
  callCount: (gatewayClient: Gateway, operation: string) => number;
};

export function registerSandboxDriverWorkspaceRenewalCases({
  openShellDriver,
  runtimeSandboxFixture,
  callCount,
}: Fixtures): void {
  for (const harnessId of ["codex", "openclaw"]) {
    test(`OpenShell reconciles renewed ${harnessId} workspace-node setup into its revision provider`, async () => {
      let storedSandbox: OpenShellSandboxResponse | undefined;
      const gatewayClient: Gateway = workspaceGatewayClient();
      gatewayClient.createSandbox = async (request) => {
        storedSandbox = {
          name: request.name,
          workspace: request.workspace,
          labels: structuredClone(request.labels),
          annotations: structuredClone(request.annotations),
          spec: structuredClone(request.spec),
          serviceUrls: {},
        };
        return {
          ...storedSandbox,
          serviceUrls: harnessId === "codex" ? { "": "http://codex.example.test:8080/" } : {},
        };
      };
      gatewayClient.getSandbox = async () => storedSandbox;
      gatewayClient.getService = async () => {
        assert.ok(storedSandbox);
        return {
          sandbox: storedSandbox.name,
          name: "",
          targetPort: 8080,
          authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
          advertisedUrl: "http://codex.example.test:8080/",
          url: "http://codex.example.test:8080/",
        };
      };
      const driver = openShellDriver(gatewayClient);
      const {
        context,
        revision: fixtureRevision,
        requirements,
      } = runtimeSandboxFixture(driver, { harnessId });
      const revision = completeWorkspaceRevision(fixtureRevision, requirements);
      const provision = () => driver.provisionHarness({ ...context, revision, requirements });

      await provision();
      const [runtimeProviderName] = [...gatewayClient.providers.keys()];
      assert.ok(runtimeProviderName);
      const initialProvider = gatewayClient.providers.get(runtimeProviderName);
      assert.ok(initialProvider, "the Harness must receive a revision-owned enrollment provider");
      const setupJson = initialProvider.config.node_setup_json;
      assert.ok(setupJson);
      const initialSetup = asRecord(JSON.parse(setupJson));
      assert.ok(initialSetup);
      gatewayClient.providers.set(runtimeProviderName, {
        ...initialProvider,
        config: {
          ...initialProvider.config,
          node_setup_json: JSON.stringify({ ...initialSetup, expiresAtMs: Date.now() - 1 }),
        },
      });
      const renewedSetup = {
        ...initialSetup,
        bootstrapToken: "renewed-node-setup",
        expiresAtMs: Date.now() + 600_000,
        tlsFingerprint: `  SHA256:${Array(32).fill("AB").join(":")}  `,
      };
      let desiredSetup: Omit<typeof renewedSetup, "tlsFingerprint"> & {
        tlsFingerprint: string | undefined;
      } = renewedSetup;
      context.kubernetes.read = async ({ metadata }) => {
        const renewedCode = Buffer.from(JSON.stringify(desiredSetup)).toString("base64url");
        return {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            ...metadata,
            labels: {
              "openclaw.dev/namespace": context.namespace.id,
              "openclaw.dev/agent": revision.agentId,
            },
          },
          data: { setupCode: Buffer.from(renewedCode).toString("base64") },
        };
      };

      // Changing or removing the trust anchor is not renewal authority, even for
      // an expired setup. JSON serialization omits the undefined fingerprint.
      for (const tlsFingerprint of ["cd".repeat(32), undefined]) {
        desiredSetup = { ...renewedSetup, tlsFingerprint };
        await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
        assert.equal(callCount(gatewayClient, "updateProviderConfig"), 0);
      }
      desiredSetup = renewedSetup;

      // A retry must update the revision-owned provider rather than strand the
      // revision after Compute replaces its expired setup Secret. Prefix, case,
      // and colon formatting do not change the SHA-256 trust anchor.
      await provision();
      const updates = gatewayClient.calls.filter(
        ([operation]) => operation === "updateProviderConfig",
      );
      assert.deepEqual(updates, [
        [
          "updateProviderConfig",
          runtimeProviderName,
          { node_setup_json: JSON.stringify(renewedSetup) },
          "1",
        ],
      ]);
      assert.equal(
        gatewayClient.providers.get(runtimeProviderName)?.config.node_setup_json,
        JSON.stringify(renewedSetup),
      );
      assert.equal(
        gatewayClient.calls.filter(([operation]) => operation === "createProvider").length,
        1,
      );

      // Renewal authority covers only the setup envelope. It must not repair or
      // conceal drift in the revision's immutable runtime files.
      const renewedProvider = gatewayClient.providers.get(runtimeProviderName);
      assert.ok(renewedProvider);
      gatewayClient.providers.set(runtimeProviderName, {
        ...renewedProvider,
        config: { ...renewedProvider.config, node_ca_pem: "foreign-ca" },
      });
      await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
      assert.equal(
        gatewayClient.calls.filter(([operation]) => operation === "updateProviderConfig").length,
        1,
      );
    });
  }
}
