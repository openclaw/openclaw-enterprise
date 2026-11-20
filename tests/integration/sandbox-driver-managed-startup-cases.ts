import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openShellWorkspaceName } from "../../apps/controller/src/backends/openshell.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import {
  ConfigurationValidationError as SharedConfigurationValidationError,
  type AgentRevision,
  type ComputeAgentBinding,
} from "../../packages/contracts/src/index.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import {
  admitRevisionHarness,
  gatewayRouting,
  routedRevision,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import {
  dedicatedRevision,
  namespaceContext,
  runtimeSandboxFixture,
  sandboxRecord,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";
import { registerManagedStartupRenderingCases } from "./sandbox-driver-managed-startup-rendering-cases.ts";
import { registerManagedStartupNetworkReplacementCases } from "./sandbox-driver-managed-startup-network-replacement-cases.ts";
import { registerManagedStartupNativeReplacementCases } from "./sandbox-driver-managed-startup-native-replacement-cases.ts";

type NamedKubernetesObject = { kind: string; metadata: { name: string } };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  assert.ok(isObjectRecord(value));
  return value;
}

function firstItem(value: unknown): unknown {
  assert.ok(Array.isArray(value) && value.length > 0);
  const first: unknown = value[0];
  return first;
}

function namedKubernetesObject(value: unknown): NamedKubernetesObject {
  const object = objectRecord(value);
  const metadata = objectRecord(object.metadata);
  assert.ok(typeof object.kind === "string");
  assert.ok(typeof metadata.name === "string");
  return { kind: object.kind, metadata: { name: metadata.name } };
}

function networkPolicySources(value: unknown): unknown {
  const spec = objectRecord(objectRecord(value).spec);
  return objectRecord(firstItem(spec.ingress)).from;
}

function nodeRouteTarget(value: unknown): { path: string; backend: string } {
  const spec = objectRecord(objectRecord(value).spec);
  const rule = objectRecord(firstItem(spec.rules));
  const path = objectRecord(objectRecord(firstItem(rule.matches)).path).value;
  const backend = objectRecord(firstItem(rule.backendRefs)).name;
  assert.ok(typeof path === "string");
  assert.ok(typeof backend === "string");
  return { path, backend };
}

function assertSerializedRevision(
  value: unknown,
  expected: AgentRevision,
): asserts value is AgentRevision {
  assert.deepEqual(value, expected, "Serialization must retain the admitted revision");
}

export function registerManagedOpenShellStartupCases(): void {
  test("managed preparation admits workspace nodes through Envoy without Sandbox network peers", async (t) => {
    for (const harnessId of ["codex", "openclaw"]) {
      await t.test(harnessId, async () => {
        const configuration = sandboxInstallation().drivers.sandbox.configuration;
        configuration.integrationMode = "service";
        configuration.gateway = {};
        configuration.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
        const client = workspaceGatewayClient();
        const sandbox = new ManagedOpenShellSandbox(configuration, {
          id: "openshell-sandbox",
          backend: backendFor(client),
        });
        const fixture = providerEndpointFixture({
          sandboxDriver: sandbox,
          servicePrincipalCredentials: { mode: "disabled" },
          revisionOverrides:
            harnessId === "openclaw"
              ? {
                  harness: {
                    id: "openclaw",
                    version: "1.0.0",
                    mode: "dedicated",
                    overrides: {},
                    configuration: {},
                  },
                }
              : {},
        });
        if (harnessId === "openclaw") {
          const native = createHarnessConfiguration("openclaw", "gpt-5");
          Object.assign(fixture.revision, {
            configuration: {
              ...fixture.revision.configuration,
              agents: native.agents,
              models: native.models,
            },
          });
          admitRevisionHarness(fixture.driver, fixture.revision);
        }
        // Exercise real Compute preparation and the managed Sandbox collaborator.
        // Transport fixtures prove the rendered boundary, not live packet delivery.
        const result = await fixture.prepare();
        assert.equal(result.ready, false, "the Gateway must become ready before enrollment");
        const objects: Iterable<unknown> = fixture.objects.values();
        const policies = [...objects]
          .map(namedKubernetesObject)
          .filter(({ kind }) => kind === "NetworkPolicy");
        assert.equal(
          policies.some(({ metadata }) =>
            metadata.name.startsWith("allow-gateway-workspace-node-"),
          ),
          false,
        );
        const ingress: unknown = fixture.read(
          "NetworkPolicy",
          "allow-gateway-ingress",
          fixture.gatewayNamespace,
        );
        const routing = gatewayRouting;
        assert.deepEqual(networkPolicySources(ingress), [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": routing.envoyNamespace },
            },
            podSelector: {
              matchLabels: {
                "gateway.envoyproxy.io/owning-gateway-namespace": routing.gatewayNamespace,
                "gateway.envoyproxy.io/owning-gateway-name": routing.gatewayName,
              },
            },
          },
        ]);
        const route: unknown = fixture.read(
          "HTTPRoute",
          `${fixture.gatewayName}-node`,
          fixture.gatewayNamespace,
        );
        assert.ok(route, "the Agent-specific node route must remain available");
        const target = nodeRouteTarget(route);
        assert.equal(
          target.path,
          `/namespaces/${fixture.revision.namespaceId}/agents/${fixture.revision.agentId}/node`,
        );
        assert.equal(target.backend, fixture.gatewayName);
      });
    }
  });

  test("startup selects managed OpenShell through integrationMode alone and preserves storage ownership", async (t) => {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.integrationMode = "service";
    configuration.drivers.sandbox.configuration.gateway = {};
    configuration.drivers.sandbox.configuration.kubernetes.sandboxDataMount.mountPath =
      "/sandbox/oce/workspace";
    const composed = await loadInstallationFile(t, configuration);
    assert.ok(composed && composed.computeDriver instanceof KubernetesComputeDriver);
    assert.equal(composed.installation.drivers.compute.id, "compute-kubernetes");
    assert.equal(composed.computeDriver.id, "compute-kubernetes");
    assert.ok(composed.sandboxDriver instanceof ManagedOpenShellSandbox);
    assert.equal(composed.installation.drivers.compute.implementation, "occ/kubernetes");
    // A second selector must be rejected rather than silently ignored.
    const obsolete = structuredClone(configuration);
    Object.assign(obsolete.drivers.compute.configuration, {
      managedOpenShell: { experimentalSingleWorker: true },
    });
    await assert.rejects(loadInstallationFile(t, obsolete), (error) => {
      assert.ok(error instanceof SharedConfigurationValidationError);
      assert.ok(
        error.error.details.some((detail) => detail.code === "UNKNOWN_FIELD"),
        JSON.stringify(error.error.details),
      );
      return true;
    });
    const computeDriver = composed.computeDriver;
    assert.throws(
      () =>
        computeDriver.validateHarnessAuth(
          { id: "openclaw", version: "1.0.0", mode: "embedded" },
          { method: "runtime" },
          {},
        ),
      /requires a dedicated Harness/,
    );
    // Managed bootstrap prepares storage inside the Sandbox. Operator-mode
    // preparation requirements must not hide OpenClaw or reject Agent admission.
    for (const userNamespaces of [undefined, true, false]) {
      const settings = structuredClone(configuration);
      if (userNamespaces === undefined) {
        Reflect.deleteProperty(settings.drivers.sandbox.configuration.kubernetes, "userNamespaces");
      } else {
        settings.drivers.sandbox.configuration.kubernetes.userNamespaces = userNamespaces;
      }
      const loaded = await loadInstallationFile(t, settings);
      assert.ok(loaded?.sandboxDriver);
      const { sandboxDriver } = loaded;
      assert.deepEqual(sandboxDriver.supportsHarnessExecutionMode.openclaw, {
        embedded: { supported: false },
        dedicated: { supported: true },
      });
      assert.ok(sandboxDriver.configureAgent);
      assert.ok(
        sandboxDriver.configureAgent(
          { agents: { defaults: { model: "openai/gpt-5" } } },
          { id: "openclaw", version: "1.0.0", mode: "dedicated" },
        ),
      );
    }
    // Restart with the same Driver IDs but a different storage owner. Admission and
    // lifecycle checks are real; Kubernetes must not be contacted on either mismatch.
    const legacy = structuredClone(configuration);
    legacy.drivers.sandbox.configuration.integrationMode = "legacy";
    const original = await loadInstallationFile(t, legacy);
    assert.ok(
      original &&
        original.computeDriver instanceof KubernetesComputeDriver &&
        original.sandboxDriver,
    );
    Reflect.deleteProperty(legacy.drivers.sandbox.configuration, "integrationMode");
    const defaultIntegration = await loadInstallationFile(t, legacy);
    assert.ok(
      defaultIntegration &&
        defaultIntegration.computeDriver instanceof KubernetesComputeDriver &&
        defaultIntegration.sandboxDriver,
    );
    assert.equal(defaultIntegration.sandboxDriver instanceof ManagedOpenShellSandbox, false);
    for (const [source, changed] of [
      [original, composed],
      [composed, original],
      [defaultIntegration, composed],
      [composed, defaultIntegration],
    ] satisfies [typeof original, typeof composed][]) {
      assert.ok(
        source.computeDriver instanceof KubernetesComputeDriver &&
          changed.computeDriver instanceof KubernetesComputeDriver,
      );
      assert.ok(source.sandboxDriver && changed.sandboxDriver);
      assert.equal(source.computeDriver.id, changed.computeDriver.id);
      assert.equal(source.sandboxDriver.id, changed.sandboxDriver.id);
      const revision = routedRevision(source.computeDriver, {
        sandboxDriverId: source.sandboxDriver.id,
      });
      const admission = source.computeDriver.admitRevision(revision);
      assert.ok(admission, "Compute must record the storage owner in its admission");
      const { runtimeInputs, ...compute } = revision.compute;
      const admitted: AgentRevision = {
        ...revision,
        compute: {
          ...compute,
          ...(runtimeInputs === undefined ? {} : { runtimeInputs }),
          admission,
        },
      };
      // A stored revision must retain its storage owner through serialization and retry.
      const stored: unknown = JSON.parse(JSON.stringify(admitted));
      assertSerializedRevision(stored, admitted);
      let reads = 0;
      Object.assign(changed.computeDriver, {
        apiClients: Promise.resolve({
          core: {
            async listNamespace() {
              reads += 1;
              throw new Error("Storage mismatch reached Kubernetes");
            },
          },
        }),
      });
      for (const operation of [
        "stopRevision",
        "retireRevision",
        "prepareRevision",
        "activateRevision",
      ] satisfies ("stopRevision" | "retireRevision" | "prepareRevision" | "activateRevision")[]) {
        await assert.rejects(
          changed.computeDriver[operation](stored),
          /Harness storage mode differs from the Installation/,
        );
      }
      assert.equal(reads, 0);
      // The original Installation can still interpret the revision's launch admission.
      const computeDriver = source.computeDriver;
      assert.doesNotThrow(() => computeDriver["pluginRuntimeSnapshot"](stored));
    }
    // These Compute restrictions depend on the actual Sandbox collaborator, not
    // an independent flag that could be omitted to bypass them.
    for (const [field, value, message] of [
      ["runtime", undefined, /explicitly configured Codex runtime/],
      [
        "executionCluster",
        {
          authentication: {
            mode: "kubeconfig",
            kubeconfigPath: "/fixture/execution",
            context: "execution",
          },
          harnessRouting: { ...gatewayRouting, hostname: "harness.example.test" },
          network: {
            dns: configuration.drivers.compute.configuration.network.dns,
            harnessEndpointCidrs: ["192.0.2.2/32"],
            gatewayEndpointCidrs: ["192.0.2.1/32"],
            pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
          },
        },
        /one Gateway cluster/,
      ],
      [
        "servicePrincipalCredentials",
        {
          mode: "projectedServiceAccountToken",
          audience: "openclaw-controller",
          expirationSeconds: 900,
        },
        /disabled ServicePrincipal projection/,
      ],
    ] satisfies [
      "runtime" | "executionCluster" | "servicePrincipalCredentials",
      unknown,
      RegExp,
    ][]) {
      const invalid = structuredClone(configuration);
      Object.assign(invalid.drivers.compute.configuration, { [field]: value });
      if (field === "executionCluster") {
        Object.assign(invalid.drivers.compute.configuration, { gatewayRouting });
        Reflect.deleteProperty(invalid.drivers.compute.configuration.network, "gatewayClients");
      }
      await assert.rejects(loadInstallationFile(t, invalid), (error) => {
        if (field === "runtime") {
          assert.ok(error instanceof Error);
          assert.match(error.message, message);
        } else {
          assert.ok(
            error instanceof SharedConfigurationValidationError,
            `${field}: ${String(error)}`,
          );
          assert.ok(
            error.error.details.some(
              (detail) => detail.path === `/${field}` && message.test(detail.message ?? ""),
            ),
            JSON.stringify(error.error.details),
          );
        }
        return true;
      });
    }
  });

  test("Kubernetes final Agent cleanup deletes managed Sandbox state before shared resources and refuses foreign ownership", async (t) => {
    for (const foreign of [false, true]) {
      await t.test(foreign ? "foreign Sandbox" : "owned Sandbox and retry", async () => {
        const configuration = sandboxInstallation();
        const sandboxOptions = configuration.drivers.sandbox.configuration;
        sandboxOptions.integrationMode = "service";
        sandboxOptions.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
        const initialContext = namespaceContext();
        const context = {
          ...initialContext,
          namespace: {
            ...initialContext.namespace,
            name: kubernetesNamespaceName(initialContext.namespace.id),
          },
        };
        const gateway = workspaceGatewayClient();
        const sandbox = new ManagedOpenShellSandbox(sandboxOptions, {
          id: "openshell-sandbox",
          backend: backendFor(gateway),
        });
        const compute = new KubernetesComputeDriver(
          {
            ...configuration.drivers.compute.configuration,
            servicePrincipalCredentials: { mode: "disabled" },
          },
          {
            sandboxDriver: sandbox,
          },
        );
        const revision = dedicatedRevision(sandbox, context, "000000000001");
        const binding: ComputeAgentBinding = {
          namespace: context.namespace,
          agent: {
            id: revision.agentId,
            namespaceId: context.namespace.id,
            name: "Managed Agent",
            desiredRuntimeState: "stopped",
            status: "deleting",
            harnessAuth: null,
            gatewayManagedMode: false,
            configurationId: "cfg_00000000-0000-4000-8000-000000000001",
            backendId: null,
            executionMode: "dedicated",
            servicePrincipalId: "sp_00000000-0000-4000-8000-000000000001",
            createdAt: context.namespace.createdAt,
          },
        };
        await sandbox.ensureNamespace(context);
        const workspace = openShellWorkspaceName(context.namespace);
        const hash = (length: number) =>
          createHash("sha256").update(revision.agentId).digest("hex").slice(0, length);
        const sandboxName = `oc-${hash(16)}`;
        const providerName = `oce-runtime-${hash(24)}`;
        gateway.sandboxes.set(sandboxName, {
          ...sandboxRecord(sandboxName, workspace),
          annotations: {
            "openclaw.dev/namespace-id": context.namespace.id,
            "openclaw.dev/agent-id": foreign ? "agt_other" : revision.agentId,
          },
          phase: "SANDBOX_PHASE_STOPPED",
          spec: { providers: [providerName] },
        });
        const ownedWorkspace = gateway.workspaces.get(workspace);
        assert.ok(ownedWorkspace);
        const { runtimeManifest, codexConfig, nodeSetup } = runtimeSandboxFixture(sandbox);
        // Seed the profile and configuration managed Codex provisioning stores.
        gateway.providers.set(providerName, {
          name: providerName,
          type: "oce-codex-runtime",
          config: {
            runtime_json: runtimeManifest,
            config_toml: codexConfig,
            node_setup_json: JSON.stringify(nodeSetup),
            node_ca_pem: "",
            oce_revision_id: revision.id,
          },
          resourceVersion: "1",
          labels: {
            ...ownedWorkspace.labels,
            "openclaw.dev/agent-id": revision.agentId,
          },
        });
        let sharedReads = 0;
        // Controlled API responses prove Driver ordering, not a live cluster. The
        // Gateway namespace has already disappeared, but OpenShell state still exists.
        Object.assign(compute, {
          apiClients: Promise.resolve({
            core: {
              async listNamespace() {
                return { items: [] };
              },
              async readNamespace() {
                sharedReads += 1;
                assert.equal(gateway.sandboxes.size, 0);
                assert.equal(gateway.providers.size, 0);
                throw Object.assign(new Error("Not found"), { statusCode: 404 });
              },
            },
          }),
        });
        if (foreign) {
          await assert.rejects(
            compute.deleteAgentRuntimeCredentials(binding),
            /exact Agent ownership/,
          );
          assert.equal(sharedReads, 0);
          assert.equal(gateway.sandboxes.size, 1);
          assert.equal(gateway.providers.size, 1);
        } else {
          await compute.deleteAgentRuntimeCredentials(binding);
          await compute.deleteAgentRuntimeCredentials(binding);
          assert.ok(sharedReads > 0);
          assert.equal(gateway.sandboxes.size, 0);
          assert.equal(gateway.providers.size, 0);
          assert.equal(
            gateway.workspaces.size,
            1,
            "Agent deletion retains its Namespace Workspace",
          );
        }
      });
    }
  });

  registerManagedStartupRenderingCases();
  registerManagedStartupNetworkReplacementCases();
  registerManagedStartupNativeReplacementCases();
}
