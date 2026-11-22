import assert from "node:assert/strict";
import test from "node:test";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellSandboxResponse } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  HarnessWorkloadRequirements,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord, type WorkspaceNodeSetupEnvelope } from "../../packages/utils/src/index.ts";
import {
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import {
  workspaceNodeSetupSecret,
  workspaceNodeSetupSecretData,
} from "./sandbox-driver-workspace-node-setup-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Gateway = ReturnType<typeof workspaceGatewayClient>;
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
  nodeSetup: WorkspaceNodeSetupEnvelope;
};
type Fixtures = {
  openShellDriver: (gatewayClient: Gateway) => OpenShellSandboxDriver;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options?: { harnessId?: string },
  ) => RuntimeFixture;
  callCount: (gatewayClient: Gateway, operation: string) => number;
};

// A gateway that keeps the one Sandbox it creates, so a repeated provision adopts it.
function storingGateway(harnessId: string) {
  let storedSandbox: OpenShellSandboxResponse | undefined;
  let created = 0;
  const gatewayClient: Gateway = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    created += 1;
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
  return {
    gatewayClient,
    sandboxesCreated: () => created,
    enrollmentPolicy: () =>
      asRecord(asRecord(storedSandbox?.spec?.policy)?.network_policies)?.[
        "workspace-node-enrollment"
      ],
  };
}

const encode = (value: string) => Buffer.from(value).toString("base64");
const recordedDevice = encode("recorded-node:1");

export function registerSandboxDriverWorkspaceRenewalCases({
  openShellDriver,
  runtimeSandboxFixture,
  callCount,
}: Fixtures): void {
  for (const harnessId of ["codex", "openclaw"]) {
    test(`OpenShell reconciles renewed ${harnessId} workspace-node setup into its revision provider`, async () => {
      const { gatewayClient } = storingGateway(harnessId);
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
      context.kubernetes.read = async ({ metadata }) =>
        workspaceNodeSetupSecret(
          metadata,
          context.namespace.id,
          revision.agentId,
          workspaceNodeSetupSecretData(desiredSetup),
        );

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

  // Compute keeps the setup in the node Secret after it records the device. Presented
  // again, that spent setup counts as a failed authentication at a starting Gateway.
  test("OpenShell delivers no spent setup to a codex node whose device is recorded", async () => {
    const provisioned = async (extra: Readonly<Record<string, string>>) => {
      const { gatewayClient, enrollmentPolicy } = storingGateway("codex");
      const driver = openShellDriver(gatewayClient);
      const {
        context,
        revision: fixtureRevision,
        requirements,
        nodeSetup,
      } = runtimeSandboxFixture(driver);
      const revision = completeWorkspaceRevision(fixtureRevision, requirements);
      context.kubernetes.read = async ({ metadata }) =>
        workspaceNodeSetupSecret(metadata, context.namespace.id, revision.agentId, {
          ...workspaceNodeSetupSecretData(nodeSetup),
          ...extra,
        });
      await driver.provisionHarness({ ...context, revision, requirements });
      const [provider] = [...gatewayClient.providers.values()];
      assert.ok(provider);
      const setupJson = provider.config.node_setup_json;
      assert.ok(setupJson);
      return { nodeSetup, setup: JSON.parse(setupJson) as unknown, policy: enrollmentPolicy() };
    };

    // First enrollment, and renewal while a setup receipt is pending, deliver the setup.
    const enrolling = await provisioned({});
    assert.deepEqual(enrolling.setup, enrolling.nodeSetup);
    assert.ok(enrolling.policy, "the node's Gateway route is bound to the setup URL");
    const renewing = await provisioned({
      deviceId: recordedDevice,
      setupReceiptDeviceId: recordedDevice,
    });
    assert.deepEqual(renewing.setup, renewing.nodeSetup);

    // A recorded device gets the profile's empty placeholder, so its node starts from
    // its saved identity, and keeps the same route to its Gateway.
    const paired = await provisioned({ deviceId: recordedDevice });
    assert.deepEqual(paired.setup, {});
    assert.deepEqual(paired.policy, enrolling.policy);
  });

  test("OpenShell keeps a codex revision provider created before its device was recorded", async () => {
    const { gatewayClient, sandboxesCreated } = storingGateway("codex");
    const driver = openShellDriver(gatewayClient);
    const {
      context,
      revision: fixtureRevision,
      requirements,
      nodeSetup,
    } = runtimeSandboxFixture(driver);
    const revision = completeWorkspaceRevision(fixtureRevision, requirements);
    const provision = () => driver.provisionHarness({ ...context, revision, requirements });
    await provision();
    const [runtimeProviderName] = [...gatewayClient.providers.keys()];
    assert.ok(runtimeProviderName);
    const delivered = gatewayClient.providers.get(runtimeProviderName);
    assert.ok(delivered);
    assert.deepEqual(JSON.parse(delivered.config.node_setup_json ?? ""), nodeSetup);

    // The node paired with that setup and Compute recorded its device. Each later pass
    // verifies the provider as it stands: no update, no replacement, no new Sandbox.
    context.kubernetes.read = async ({ metadata }) =>
      workspaceNodeSetupSecret(metadata, context.namespace.id, revision.agentId, {
        ...workspaceNodeSetupSecretData(nodeSetup),
        deviceId: recordedDevice,
      });
    for (let pass = 0; pass < 2; pass += 1) {
      await provision();
      assert.deepEqual(gatewayClient.providers.get(runtimeProviderName), delivered);
    }
    assert.equal(callCount(gatewayClient, "createProvider"), 1);
    assert.equal(callCount(gatewayClient, "updateProviderConfig"), 0);
    assert.equal(sandboxesCreated(), 1);

    // Keeping the delivered setup is no authority to keep one for another Gateway.
    gatewayClient.providers.set(runtimeProviderName, {
      ...delivered,
      config: {
        ...delivered.config,
        node_setup_json: JSON.stringify({ ...nodeSetup, url: "wss://other.example.test/node" }),
      },
    });
    await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
    assert.equal(callCount(gatewayClient, "updateProviderConfig"), 0);
  });
}
