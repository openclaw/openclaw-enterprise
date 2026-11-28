import assert from "node:assert/strict";
import test from "node:test";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellSandboxResponse } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import type {
  HarnessWorkloadRequirements,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord, type WorkspaceNodeSetupEnvelope } from "../../packages/utils/src/index.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import {
  assertManagedSandboxRequest,
  type ManagedSandboxPhase,
  type ManagedSandboxRequest,
} from "./sandbox-driver-managed-startup-rendering-cases.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
import {
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { harnessService } from "./sandbox-driver-startup-orchestration.ts";
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

    // The keep rule compares the Gateway URL and TLS pin only: another bootstrap token is
    // kept, another Gateway or TLS pin is refused.
    const holding = (setup: object) =>
      gatewayClient.providers.set(runtimeProviderName, {
        ...delivered,
        config: { ...delivered.config, node_setup_json: JSON.stringify(setup) },
      });
    holding({ ...nodeSetup, bootstrapToken: "another-node-setup" });
    await provision();
    for (const foreign of [
      { url: "wss://other.example.test/node" },
      { tlsFingerprint: "cd".repeat(32) },
    ]) {
      holding({ ...nodeSetup, ...foreign });
      await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
    }
    assert.equal(callCount(gatewayClient, "updateProviderConfig"), 0);

    // A kept setup that has since expired stays as it is: no update.
    const expired = { ...nodeSetup, expiresAtMs: Date.now() - 1 };
    context.kubernetes.read = async ({ metadata }) =>
      workspaceNodeSetupSecret(metadata, context.namespace.id, revision.agentId, {
        ...workspaceNodeSetupSecretData(expired),
        deviceId: recordedDevice,
      });
    holding(expired);
    await provision();
    assert.equal(
      gatewayClient.providers.get(runtimeProviderName)?.config.node_setup_json,
      JSON.stringify(expired),
    );
    assert.equal(callCount(gatewayClient, "updateProviderConfig"), 0);
    assert.equal(sandboxesCreated(), 1);
  });

  // A provider created after the device was recorded holds the empty placeholder. When
  // Compute mints a setup again (the node Secret was deleted), the next pass of the same
  // revision delivers it, as it renews an expired setup.
  test("OpenShell gives a codex revision provider holding no setup a newly minted setup", async () => {
    const { gatewayClient } = storingGateway("codex");
    const driver = openShellDriver(gatewayClient);
    const {
      context,
      revision: fixtureRevision,
      requirements,
      nodeSetup,
    } = runtimeSandboxFixture(driver);
    const revision = completeWorkspaceRevision(fixtureRevision, requirements);
    const provision = () => driver.provisionHarness({ ...context, revision, requirements });
    let secretData: Readonly<Record<string, string>> = {
      ...workspaceNodeSetupSecretData(nodeSetup),
      deviceId: recordedDevice,
    };
    context.kubernetes.read = async ({ metadata }) =>
      workspaceNodeSetupSecret(metadata, context.namespace.id, revision.agentId, secretData);
    await provision();
    const [runtimeProviderName] = [...gatewayClient.providers.keys()];
    assert.ok(runtimeProviderName);
    assert.equal(gatewayClient.providers.get(runtimeProviderName)?.config.node_setup_json, "{}");

    const minted = { ...nodeSetup, bootstrapToken: "minted-node-setup" };
    secretData = workspaceNodeSetupSecretData(minted);
    await provision();
    assert.deepEqual(
      gatewayClient.calls.filter(([operation]) => operation === "updateProviderConfig"),
      [
        [
          "updateProviderConfig",
          runtimeProviderName,
          { node_setup_json: JSON.stringify(minted) },
          "1",
        ],
      ],
    );
    assert.equal(
      gatewayClient.providers.get(runtimeProviderName)?.config.node_setup_json,
      JSON.stringify(minted),
    );
  });

  // The managed per-Agent provider follows the same rules across revisions.
  test("managed OpenShell keeps, replaces and renews a codex provider around its recorded device", async () => {
    const client = workspaceGatewayClient();
    const configuration = sandboxInstallation().drivers.sandbox.configuration;
    configuration.integrationMode = "service";
    configuration.gateway = {};
    configuration.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
    const driver = new ManagedOpenShellSandbox(configuration, {
      id: "openshell-sandbox",
      backend: backendFor(client),
    });
    const fixture = runtimeSandboxFixture(driver);
    const { context, nodeSetup } = fixture;
    const revision = completeWorkspaceRevision(fixture.revision, fixture.requirements);
    const requirements = { ...fixture.requirements, workspaceMounts: [] };
    let request: ManagedSandboxRequest | undefined;
    let phase: ManagedSandboxPhase = "SANDBOX_PHASE_READY";
    const current = (): ManagedSandboxRequest => {
      assert.ok(request, "The Gateway must have received a Sandbox workload");
      return request;
    };
    client.createSandbox = async (value) => {
      assertManagedSandboxRequest(value);
      request = value;
      return storedSandbox(value, { phase });
    };
    client.getSandbox = async () =>
      request === undefined ? undefined : storedSandbox(request, { phase, resourceVersion: "7" });
    client.getService = async () =>
      harnessService(current().name, "", "http://codex.example.test:8080/");
    client.stopSandbox = async () => {
      phase = "SANDBOX_PHASE_STOPPED";
      return storedSandbox(current(), { phase });
    };
    client.updateSandbox = async (value) => {
      assertManagedSandboxRequest(value);
      request = value;
      return storedSandbox(value, { phase });
    };
    client.startSandbox = async () => {
      phase = "SANDBOX_PHASE_READY";
      return storedSandbox(current(), { phase });
    };
    let secretData: Readonly<Record<string, string>> = workspaceNodeSetupSecretData(nodeSetup);
    context.kubernetes.read = async ({ metadata }) =>
      workspaceNodeSetupSecret(metadata, context.namespace.id, revision.agentId, secretData);
    const provider = () => {
      const [only, ...others] = [...client.providers.values()];
      assert.ok(only);
      assert.equal(others.length, 0);
      return only;
    };
    const updates = () => callCount(client, "updateProviderConfig");

    await driver.ensureNamespace(context);
    await driver.provisionHarness({ ...context, revision, requirements });
    const delivered = provider();
    assert.deepEqual(JSON.parse(delivered.config.node_setup_json ?? ""), nodeSetup);

    // Once the device is recorded, the same revision's provider is kept as it stands.
    secretData = { ...workspaceNodeSetupSecretData(nodeSetup), deviceId: recordedDevice };
    await driver.provisionHarness({ ...context, revision, requirements });
    assert.deepEqual(provider(), delivered);
    assert.equal(updates(), 0);

    // A new revision replaces the provider's config with the empty placeholder.
    await driver.cleanup({ ...context, revision });
    const successor = { ...revision, id: "rev_00000000-0000-4000-8000-000000000004" };
    const next = {
      ...context,
      revision: successor,
      requirements: {
        ...requirements,
        labels: { ...requirements.labels, "openclaw.dev/revision": successor.id },
      },
    };
    await driver.provisionHarness(next);
    assert.equal(provider().config.oce_revision_id, successor.id);
    assert.equal(provider().config.node_setup_json, "{}");
    const replaced = updates();

    // Compute mints a setup again (the node Secret was deleted): the next pass delivers it.
    const minted = { ...nodeSetup, bootstrapToken: "minted-node-setup" };
    secretData = workspaceNodeSetupSecretData(minted);
    await driver.provisionHarness(next);
    assert.equal(provider().config.node_setup_json, JSON.stringify(minted));
    assert.equal(updates(), replaced + 1);
  });
}
