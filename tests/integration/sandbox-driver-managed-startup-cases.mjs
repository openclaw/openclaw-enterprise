import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openShellWorkspaceName,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { ConfigurationValidationError as SharedConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import {
  admitRevisionHarness,
  gatewayRouting,
  routedRevision,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import {
  dedicatedRevision,
  namespaceContext,
  sandboxRecord,
  harnessService,
  runtimeSandboxFixture,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);

export function registerManagedOpenShellStartupCases() {
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
          revisionOverrides: {
            harness: { id: harnessId, version: "1.0.0", mode: "dedicated" },
          },
        });
        if (harnessId === "openclaw") {
          const native = createHarnessConfiguration("openclaw", "gpt-5");
          fixture.revision.configuration = {
            ...fixture.revision.configuration,
            agents: native.agents,
            models: native.models,
          };
          admitRevisionHarness(fixture.driver, fixture.revision);
        }
        // Exercise real Compute preparation and the managed Sandbox collaborator.
        // Transport fixtures prove the rendered boundary, not live packet delivery.
        const result = await fixture.prepare();
        assert.equal(result.ready, false, "the Gateway must become ready before enrollment");
        const policies = [...fixture.objects.values()].filter(
          ({ kind }) => kind === "NetworkPolicy",
        );
        assert.equal(
          policies.some(({ metadata }) =>
            metadata.name.startsWith("allow-gateway-workspace-node-"),
          ),
          false,
        );
        const ingress = fixture.read(
          "NetworkPolicy",
          "allow-gateway-ingress",
          fixture.gatewayNamespace,
        );
        const routing = fixture.driver.options.gatewayRouting;
        assert.deepEqual(ingress.spec.ingress[0].from, [
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
        const route = fixture.read(
          "HTTPRoute",
          `${fixture.gatewayName}-node`,
          fixture.gatewayNamespace,
        );
        assert.ok(route, "the Agent-specific node route must remain available");
        assert.equal(
          route.spec.rules[0].matches[0].path.value,
          `/namespaces/${fixture.revision.namespaceId}/agents/${fixture.revision.agentId}/node`,
        );
        assert.equal(route.spec.rules[0].backendRefs[0].name, fixture.gatewayName);
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
    assert.equal(composed.installation.drivers.compute.id, "compute-kubernetes");
    assert.equal(composed.computeDriver.id, "compute-kubernetes");
    assert.ok(composed.sandboxDriver instanceof ManagedOpenShellSandbox);
    assert.equal(composed.installation.drivers.compute.implementation, "occ/kubernetes");
    // A second selector must be rejected rather than silently ignored.
    const obsolete = structuredClone(configuration);
    obsolete.drivers.compute.configuration.managedOpenShell = { experimentalSingleWorker: true };
    await assert.rejects(loadInstallationFile(t, obsolete), (error) => {
      assert.ok(error instanceof SharedConfigurationValidationError);
      assert.ok(
        error.error.details.some((detail) => detail.code === "UNKNOWN_FIELD"),
        JSON.stringify(error.error.details),
      );
      return true;
    });
    assert.throws(
      () => composed.computeDriver.validateHarnessAuth({ id: "openclaw", mode: "embedded" }),
      /requires a dedicated Harness/,
    );
    // Managed bootstrap prepares storage inside the Sandbox. Operator-mode
    // preparation requirements must not hide OpenClaw or reject Agent admission.
    for (const userNamespaces of [undefined, true, false]) {
      const settings = structuredClone(configuration);
      if (userNamespaces === undefined) {
        delete settings.drivers.sandbox.configuration.kubernetes.userNamespaces;
      } else {
        settings.drivers.sandbox.configuration.kubernetes.userNamespaces = userNamespaces;
      }
      const { sandboxDriver } = await loadInstallationFile(t, settings);
      assert.deepEqual(sandboxDriver.supportsHarnessExecutionMode.openclaw, {
        embedded: { supported: false },
        dedicated: { supported: true },
      });
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
    delete legacy.drivers.sandbox.configuration.integrationMode;
    const defaultIntegration = await loadInstallationFile(t, legacy);
    assert.equal(defaultIntegration.sandboxDriver instanceof ManagedOpenShellSandbox, false);
    for (const [source, changed] of [
      [original, composed],
      [composed, original],
      [defaultIntegration, composed],
      [composed, defaultIntegration],
    ]) {
      assert.equal(source.computeDriver.id, changed.computeDriver.id);
      assert.equal(source.sandboxDriver.id, changed.sandboxDriver.id);
      const revision = routedRevision(source.computeDriver, {
        sandboxDriverId: source.sandboxDriver.id,
      });
      revision.compute.admission = source.computeDriver.admitRevision(revision);
      // A stored revision must retain its storage owner through serialization and retry.
      const stored = JSON.parse(JSON.stringify(revision));
      let reads = 0;
      changed.computeDriver.apiClients = Promise.resolve({
        core: {
          async listNamespace() {
            reads += 1;
            throw new Error("Storage mismatch reached Kubernetes");
          },
        },
      });
      for (const operation of [
        "stopRevision",
        "retireRevision",
        "prepareRevision",
        "activateRevision",
      ]) {
        await assert.rejects(
          changed.computeDriver[operation](stored),
          /Harness storage mode differs from the Installation/,
        );
      }
      assert.equal(reads, 0);
      // The original Installation can still interpret the revision's launch admission.
      assert.doesNotThrow(() => source.computeDriver.pluginRuntimeSnapshot(stored));
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
    ]) {
      const invalid = structuredClone(configuration);
      invalid.drivers.compute.configuration[field] = value;
      if (field === "executionCluster") {
        invalid.drivers.compute.configuration.gatewayRouting = gatewayRouting;
        delete invalid.drivers.compute.configuration.network.gatewayClients;
      }
      await assert.rejects(loadInstallationFile(t, invalid), (error) => {
        if (field === "runtime") {
          assert.match(error.message, message);
        } else {
          assert.ok(
            error instanceof SharedConfigurationValidationError,
            `${field}: ${error.stack}`,
          );
          assert.ok(
            error.error.details.some(
              (detail) => detail.path === `/${field}` && message.test(detail.message),
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
        const context = namespaceContext();
        context.namespace.name = kubernetesNamespaceName(context.namespace.id);
        const gateway = workspaceGatewayClient();
        const sandbox = new ManagedOpenShellSandbox(sandboxOptions, {
          id: "openshell-sandbox",
          backend: backendFor(gateway),
        });
        const compute = new KubernetesComputeDriver(configuration.drivers.compute.configuration, {
          sandboxDriver: sandbox,
        });
        const revision = dedicatedRevision(sandbox, context, "000000000001");
        const binding = {
          namespace: context.namespace,
          agent: {
            id: revision.agentId,
            namespaceId: context.namespace.id,
            name: "Managed Agent",
            configurationId: "cfg_00000000-0000-4000-8000-000000000001",
            backendId: null,
            executionMode: "dedicated",
            servicePrincipalId: "sp_00000000-0000-4000-8000-000000000001",
            createdAt: context.namespace.createdAt,
          },
        };
        await sandbox.ensureNamespace(context);
        const workspace = openShellWorkspaceName(context.namespace);
        const hash = (length) =>
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
        gateway.providers.set(providerName, {
          name: providerName,
          labels: {
            ...gateway.workspaces.get(workspace).labels,
            "openclaw.dev/agent-id": revision.agentId,
          },
        });
        let sharedReads = 0;
        // Controlled API responses prove Driver ordering, not a live cluster. The
        // Gateway namespace has already disappeared, but OpenShell state still exists.
        compute.apiClients = Promise.resolve({
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

  test("managed Harness rendering submits no PVC and keeps the bootstrap outside persistent state", async (t) => {
    const client = workspaceGatewayClient();
    // Exercise the production client's config validation and protobuf encoding on
    // replacement; the in-memory provider fixture alone accepts empty patch values.
    const grpc = controllerRequire("@grpc/grpc-js");
    const loader = controllerRequire("@grpc/proto-loader");
    const definition = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
      { keepCase: true, longs: String, defaults: false },
    );
    const server = new grpc.Server();
    t.after(() => server.forceShutdown());
    const updateProviderConfig = client.updateProviderConfig.bind(client);
    let configUpdateMode = "apply";
    server.addService(grpc.loadPackageDefinition(definition).openshell.v1.OpenShell.service, {
      async UpdateProvider(call, callback) {
        try {
          const request = call.request.provider;
          if (configUpdateMode === "reject") {
            callback(
              Object.assign(new Error("Provider update rejected"), {
                code: grpc.status.FAILED_PRECONDITION,
              }),
            );
            return;
          }
          const provider =
            configUpdateMode === "ignore"
              ? client.providers.get(request.metadata.name)
              : await updateProviderConfig(
                  call.request.workspace_scope.workspace,
                  request.metadata.name,
                  request.config,
                  request.metadata.resource_version,
                );
          if (configUpdateMode === "lose-response") {
            callback(
              Object.assign(new Error("Provider update response lost"), {
                code: grpc.status.UNAVAILABLE,
              }),
            );
            return;
          }
          callback(null, {
            provider: {
              metadata: {
                name: provider.name,
                labels: provider.labels,
                resource_version: provider.resourceVersion,
              },
              type: provider.type,
              config: provider.config,
            },
          });
        } catch (error) {
          callback(error);
        }
      },
    });
    const port = await new Promise((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
    const wireClient = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    t.after(() => wireClient.close());
    client.updateProviderConfig = wireClient.updateProviderConfig.bind(wireClient);
    const configuration = sandboxInstallation().drivers.sandbox.configuration;
    configuration.integrationMode = "service";
    configuration.gateway = {};
    configuration.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
    const driver = new ManagedOpenShellSandbox(configuration, {
      id: "openshell-sandbox",
      backend: backendFor(client),
    });
    let request;
    let phase = "SANDBOX_PHASE_PROVISIONING";
    client.createSandbox = async (value) => {
      request = value;
      return storedSandbox(value, { phase: "SANDBOX_PHASE_PROVISIONING" });
    };
    client.getSandbox = async () =>
      request === undefined ? undefined : storedSandbox(request, { phase, resourceVersion: "7" });
    client.getService = async () =>
      harnessService(request.name, "", "http://codex.example.test:8080/");
    const { context, revision, requirements } = runtimeSandboxFixture(driver);
    requirements.environment = requirements.environment.filter(
      ({ name }) => name !== "OPENCLAW_NODE_CA_PEM",
    );
    requirements.workspaceMounts = [];
    // Matching a directory path does not make an unrelated variable a storage binding.
    requirements.environment.push({ name: "UNRELATED_PATH", value: "/home/node/.openclaw-node" });
    await driver.ensureNamespace(context);
    await driver.provisionHarness({ ...context, revision, requirements });
    // This is outgoing workload-contract proof, with transport responses supplied
    // by the fixture. Cluster storage and provider lifecycle remain a live proof.
    assert.equal(JSON.stringify(request.spec).includes("persistent_volume_claim"), false);
    assert.equal(JSON.stringify(request.spec).includes("harness-workspace-codex"), false);
    assert.equal(request.spec.environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/oce/workspace");
    assert.equal(
      request.spec.environment.OPENCLAW_NODE_STATE_DIR,
      "/sandbox/oce/workspace-node-codex/state",
    );
    assert.equal(
      request.spec.environment.UNRELATED_PATH,
      "/sandbox/.openclaw-runtime/home/.openclaw-node",
    );
    assert.match(
      request.spec.command[RUNTIME_WRAPPER_COMMAND.length],
      /require\("\/opt\/oce\/runtime\/openshell-bootstrap.cjs"\)\.prepareManaged/,
    );
    const successor = { ...revision, id: "rev_00000000-0000-4000-8000-000000000004" };
    assert.equal(
      driver.harnessResource({ namespace: context.namespace, revision }).resourceName,
      driver.harnessResource({ namespace: context.namespace, revision: successor }).resourceName,
    );
    // A server with the older image-only update contract can acknowledge an update
    // while retaining command/environment/metadata. Readback must prevent StartSandbox.
    phase = "SANDBOX_PHASE_STOPPED";
    const runtimeProvider = [...client.providers.values()].find(
      (provider) => provider.config.oce_revision_id === revision.id,
    );
    // A previous runtime version may have stored fields the successor no longer
    // uses. Both populated and empty obsolete fields must disappear on replacement.
    runtimeProvider.config.obsolete_runtime_setting = "previous-value";
    runtimeProvider.config.obsolete_empty_setting = "";
    let attemptedUpdate;
    client.updateSandbox = async (update) => {
      attemptedUpdate = update;
      return storedSandbox(request, { phase, resourceVersion: "8" });
    };
    client.startSandbox = async () => {
      assert.fail("An incomplete workload update must never start");
    };
    const replace = () =>
      driver.provisionHarness({
        ...context,
        revision: successor,
        requirements: { ...requirements, labels: { "openclaw.dev/revision": successor.id } },
      });
    // A refused patch (for example, profile validation or a version conflict)
    // and an acknowledged but uncommitted patch must both prevent workload update.
    configUpdateMode = "reject";
    await assert.rejects(replace(), { code: grpc.status.FAILED_PRECONDITION });
    configUpdateMode = "ignore";
    await assert.rejects(replace(), /did not store the exact requested runtime Provider config/);
    assert.equal(attemptedUpdate, undefined);
    assert.equal(client.providers.get(runtimeProvider.name).config.oce_revision_id, revision.id);
    assert.equal(
      client.providers.get(runtimeProvider.name).config.obsolete_runtime_setting,
      "previous-value",
    );
    // A committed deletion with a lost response is recovered by reading the
    // stored successor config on retry, without sending another deletion patch.
    configUpdateMode = "lose-response";
    await assert.rejects(replace(), /OpenShell UpdateProvider failed with gRPC status 14/);
    assert.equal(attemptedUpdate, undefined);
    assert.equal(phase, "SANDBOX_PHASE_STOPPED");
    configUpdateMode = "apply";
    await assert.rejects(replace(), /did not store the exact requested workload update/);
    assert.equal(attemptedUpdate.expectedResourceVersion, "7");
    assert.equal(attemptedUpdate.annotations["openclaw.dev/revision-id"], successor.id);
    const configUpdate = client.calls.find(([operation]) => operation === "updateProviderConfig");
    assert.deepEqual(configUpdate[2], {
      oce_revision_id: successor.id,
      obsolete_runtime_setting: "",
      obsolete_empty_setting: "",
    });
    assert.equal(
      Object.hasOwn(client.providers.get(configUpdate[1]).config, "obsolete_runtime_setting"),
      false,
    );
    assert.equal(
      Object.hasOwn(client.providers.get(configUpdate[1]).config, "obsolete_empty_setting"),
      false,
    );
    assert.equal(client.providers.get(configUpdate[1]).config.node_ca_pem, "");
    // Retrying with a server that stores the complete update must finish the
    // replacement, without resending the already committed Provider patch.
    client.updateSandbox = async (value) => {
      request = value;
    };
    client.startSandbox = async () => {
      phase = "SANDBOX_PHASE_READY";
    };
    await driver.provisionHarness({
      ...context,
      revision: successor,
      requirements: { ...requirements, labels: { "openclaw.dev/revision": successor.id } },
    });
    assert.equal(phase, "SANDBOX_PHASE_READY");
    assert.equal(request.annotations["openclaw.dev/revision-id"], successor.id);
    assert.equal(
      client.calls.filter(([operation]) => operation === "updateProviderConfig").length,
      1,
    );
    await t.test(
      "Provider replacement resumes after lost detach and attach responses",
      async () => {
        let version = 8;
        const mutations = [];
        let policy = structuredClone(request.spec.policy);
        const sourceA = requirements.credentialAttachments[0].ref;
        const sourceB = openShellProviderName("source-b");
        client.getSandbox = async () =>
          storedSandbox(request, {
            id: "retained-sandbox-id",
            phase,
            resourceVersion: String(version),
          });
        client.getPolicyStatus = async () => ({ policy: structuredClone(policy) });
        client.updatePolicy = async (value) => {
          assert.equal(phase, "SANDBOX_PHASE_STOPPED");
          assert.equal(value.expectedResourceVersion, String(version));
          policy = structuredClone(value.policy);
          version += 1;
        };
        let loseResponse;
        const mutate = (operation) => async (_workspace, name, provider, _signal, conditional) => {
          assert.equal(name, request.name);
          assert.equal(phase, "SANDBOX_PHASE_STOPPED");
          assert.equal(conditional.expectedResourceVersion, String(version));
          mutations.push([operation, provider]);
          request.spec.providers =
            operation === "detach"
              ? request.spec.providers.filter((value) => value !== provider)
              : [...request.spec.providers, provider];
          version += 1;
          if (loseResponse === operation) {
            loseResponse = undefined;
            throw new Error("lost mutation response");
          }
        };
        client.detachSandboxProvider = mutate("detach");
        client.attachSandboxProvider = mutate("attach");
        // UpdateSandbox cannot reorder or replace Providers. Preserve the gateway's
        // actual attachment list so full-spec readback cannot hide a missed mutation.
        client.updateSandbox = async (value) => {
          assert.equal(value.expectedResourceVersion, String(version));
          request = {
            ...value,
            spec: { ...value.spec, providers: request.spec.providers, policy: request.spec.policy },
          };
          version += 1;
        };
        const provision = (id, source) =>
          driver.provisionHarness({
            ...context,
            revision: { ...revision, id },
            requirements: {
              ...requirements,
              credentialAttachments: [{ sourceId: source, ref: source }],
            },
          });
        phase = "SANDBOX_PHASE_STOPPED";
        await provision("rev_00000000-0000-4000-8000-000000000005", sourceA);
        assert.equal(phase, "SANDBOX_PHASE_READY");
        phase = "SANDBOX_PHASE_STOPPED";
        loseResponse = "detach";
        const next = "rev_00000000-0000-4000-8000-000000000006";
        await assert.rejects(provision(next, sourceB), /lost mutation response/);
        assert.equal(phase, "SANDBOX_PHASE_STOPPED");
        assert.equal(request.spec.providers.includes(sourceA), false);
        loseResponse = "attach";
        await assert.rejects(provision(next, sourceB), /lost mutation response/);
        assert.equal(phase, "SANDBOX_PHASE_STOPPED");
        // A retry with already-correct attachments must still check current policy;
        // membership alone cannot authorize starting the desired workload.
        client.getPolicyStatus = async () => ({ policy: { network_policies: {} } });
        await assert.rejects(
          provision(next, sourceB),
          /static policy or non-Git middleware bindings/,
        );
        assert.equal(phase, "SANDBOX_PHASE_STOPPED");
        client.getPolicyStatus = async () => ({ policy: structuredClone(policy) });
        await provision(next, sourceB);
        assert.equal(phase, "SANDBOX_PHASE_READY");
        assert.deepEqual(mutations, [
          ["detach", sourceA],
          ["attach", sourceB],
        ]);
        assert.equal(request.spec.providers.includes(sourceB), true);
        assert.equal(
          client.calls.some(([operation]) => operation === "deleteProvider"),
          false,
        );

        // A policy changed through the live API is not reflected in spec.policy.
        // Attachment reconciliation must refuse it before removing a credential.
        phase = "SANDBOX_PHASE_STOPPED";
        client.getPolicyStatus = async () => ({ policy: { network_policies: {} } });
        await assert.rejects(
          provision("rev_00000000-0000-4000-8000-000000000007", sourceA),
          /static policy or non-Git middleware bindings/,
        );
        assert.equal(mutations.length, 2);
        client.getPolicyStatus = async () => ({ policy: structuredClone(policy) });
        client.detachSandboxProvider = async () => ({});
        await assert.rejects(
          provision("rev_00000000-0000-4000-8000-000000000007", sourceA),
          /attachment readback differs/,
        );
        assert.equal(phase, "SANDBOX_PHASE_STOPPED");
      },
    );
  });

  test("managed network policy replacement survives lost responses and gates activation", async (t) => {
    const client = workspaceGatewayClient();
    const options = sandboxInstallation().drivers.sandbox.configuration;
    options.integrationMode = "service";
    options.gateway = {};
    options.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
    const makeDriver = (configuration) =>
      new ManagedOpenShellSandbox(configuration, {
        id: "openshell-sandbox",
        backend: backendFor(client),
      });
    const original = makeDriver(options);
    const { context, revision, requirements } = runtimeSandboxFixture(original);
    requirements.workspaceMounts = [];
    let stored;
    let policy;
    let version = 1;
    let policyVersion = 1;
    let activeVersion = 1;
    let policyState = "POLICY_STATUS_LOADED";
    let writes = 0;
    let failure;
    client.createSandbox = async (request) => {
      stored = storedSandbox(structuredClone(request), {
        id: "stable-policy-sandbox",
        resourceVersion: String(version),
        phase: "SANDBOX_PHASE_READY",
      });
      policy = structuredClone(request.spec.policy);
      return stored;
    };
    client.getSandbox = async () => (stored === undefined ? undefined : structuredClone(stored));
    client.getPolicyStatus = async () => ({
      policy: structuredClone(policy),
      version: policyVersion,
      activeVersion,
      state: policyState,
    });
    client.getService = async () =>
      harnessService(stored.name, "", "http://codex.example.test:8080/");
    client.updatePolicy = async (request) => {
      assert.equal(stored.phase, "SANDBOX_PHASE_STOPPED");
      assert.equal(request.expectedResourceVersion, String(version));
      writes += 1;
      if (failure === "ignored") {
        return;
      }
      // OpenShell stores policy history independently of the creation specification.
      policy = structuredClone(request.policy);
      policyVersion += 1;
      policyState = "POLICY_STATUS_PENDING";
      stored.resourceVersion = String(++version);
      if (failure === "lost") {
        throw new Error("lost policy response");
      }
    };
    client.updateSandbox = async (request) => {
      assert.equal(request.expectedResourceVersion, String(version));
      stored = storedSandbox(
        { ...request, spec: { ...request.spec, policy: stored.spec.policy } },
        {
          id: stored.id,
          resourceVersion: String(++version),
          phase: "SANDBOX_PHASE_STOPPED",
        },
      );
    };
    client.startSandbox = async () => {
      stored.phase = "SANDBOX_PHASE_READY";
    };
    const provision = (driver, id, overrides = {}) =>
      driver.provisionHarness({
        ...context,
        revision: { ...revision, id },
        requirements: { ...requirements, ...overrides },
      });
    await original.ensureNamespace(context);
    await provision(original, revision.id);
    const baseline = structuredClone(stored.spec.policy);
    const changed = structuredClone(options);
    changed.policy.networkPolicies.push({
      name: "documentation",
      endpoints: [{ host: "example.org", ports: [443] }],
      binaries: [{ path: "/usr/bin/curl" }],
    });
    const replacement = makeDriver(changed);
    const next = "rev_00000000-0000-4000-8000-000000000008";
    await assert.rejects(provision(replacement, revision.id), /Stop the previous managed workload/);
    stored.phase = "SANDBOX_PHASE_STOPPED";
    // Neither static restrictions nor middleware changes belong to this increment.
    for (const field of ["process", "network_middlewares"]) {
      const saved = structuredClone(policy);
      policy[field] = { changed: true };
      await assert.rejects(
        provision(replacement, next),
        /static policy or non-Git middleware bindings/,
      );
      policy = saved;
    }
    assert.equal(writes, 0);
    failure = "ignored";
    await assert.rejects(provision(replacement, next), /policy readback differs/);
    assert.equal(stored.phase, "SANDBOX_PHASE_STOPPED");
    failure = "lost";
    await assert.rejects(provision(replacement, next), /lost policy response/);
    assert.equal(stored.phase, "SANDBOX_PHASE_STOPPED");
    assert.equal(writes, 2);
    failure = undefined;
    await provision(replacement, next);
    assert.equal(writes, 2, "Retry adopts the stored policy without another write");
    assert.deepEqual(stored.spec.policy, baseline, "Workload updates retain the creation policy");
    assert.ok(policy.network_policies.documentation);
    assert.equal(stored.id, "stable-policy-sandbox");
    await provision(replacement, next);
    assert.equal(writes, 2, "An unchanged retry must not restore the creation policy");
    const observationContext = { ...context, revision: { ...revision, id: next } };
    assert.deepEqual(await replacement.observeHarness(observationContext), { state: "starting" });
    policyState = "POLICY_STATUS_LOADED";
    assert.deepEqual(await replacement.observeHarness(observationContext), { state: "starting" });
    activeVersion = policyVersion;
    assert.deepEqual(await replacement.observeHarness(observationContext), { state: "running" });
    // A subsequent live edit must use the new defaults, not the creation-time rules.
    const snapshot = replacement.admitNetworkPolicy([], 1);
    assert.equal(
      (await replacement.observeNetworkPolicy(observationContext, snapshot)).matches,
      true,
    );
    policyState = "POLICY_STATUS_FAILED";
    await assert.rejects(replacement.observeHarness(observationContext), /did not activate/);
    policyState = "POLICY_STATUS_LOADED";
    stored.phase = "SANDBOX_PHASE_STOPPED";
    await provision(original, "rev_00000000-0000-4000-8000-000000000009");
    assert.equal(
      policy.network_policies.documentation,
      undefined,
      "A later revision removes the rule",
    );
    assert.equal(writes, 3);
    await t.test(
      "combined replacement resumes each committed step without starting early",
      async () => {
        // These controlled RPC responses exercise OCE recovery and ordering. Actual
        // OpenShell policy validation is covered by the real replacement scenario.
        const sourceA = requirements.credentialAttachments[0].ref;
        const sourceB = openShellProviderName("combined-source");
        const target = "rev_00000000-0000-4000-8000-000000000010";
        const mutations = [];
        let interrupt;
        const committed = (step) => {
          mutations.push(step);
          if (interrupt === step) {
            throw new Error(`lost ${step} response`);
          }
        };
        const updatePolicy = client.updatePolicy;
        client.updatePolicy = async (request) => {
          if (interrupt === "reject-final" && request.policy.network_policies.documentation) {
            throw new Error("policy rejected by gateway");
          }
          await updatePolicy(request);
          committed(Object.keys(request.policy.network_policies).length === 0 ? "clear" : "final");
        };
        for (const operation of ["detach", "attach"]) {
          client[operation === "detach" ? "detachSandboxProvider" : "attachSandboxProvider"] =
            async (_workspace, name, provider, _signal, conditional) => {
              assert.equal(name, stored.name);
              assert.equal(stored.phase, "SANDBOX_PHASE_STOPPED");
              assert.equal(conditional.expectedResourceVersion, String(version));
              assert.deepEqual(
                policy.network_policies,
                {},
                "Withdraw rules before changing Providers",
              );
              assert.equal(provider, operation === "detach" ? sourceA : sourceB);
              stored.spec.providers =
                operation === "detach"
                  ? stored.spec.providers.filter((value) => value !== provider)
                  : [...stored.spec.providers, provider];
              stored.resourceVersion = String(++version);
              committed(operation);
            };
        }
        const updateSandbox = client.updateSandbox;
        client.updateSandbox = async (request) => {
          assert.ok(
            policy.network_policies.documentation,
            "Install final rules before the workload",
          );
          assert.ok(stored.spec.providers.includes(sourceB));
          assert.equal(stored.spec.providers.includes(sourceA), false);
          await updateSandbox(request);
          committed("workload");
        };
        const replace = () =>
          provision(replacement, target, {
            credentialAttachments: [{ sourceId: "combined-source", ref: sourceB }],
          });
        stored.phase = "SANDBOX_PHASE_STOPPED";
        // Each response is lost after the gateway commits. The next attempt must
        // adopt that state, even after all attachments or the workload already match.
        for (const step of ["clear", "detach", "attach", "reject-final", "final", "workload"]) {
          interrupt = step;
          await assert.rejects(replace(), /lost .* response|policy rejected by gateway/);
          assert.equal(stored.phase, "SANDBOX_PHASE_STOPPED");
          assert.deepEqual(stored.spec.policy, baseline);
        }
        interrupt = undefined;
        await replace();
        assert.equal(stored.phase, "SANDBOX_PHASE_READY");
        assert.equal(stored.id, "stable-policy-sandbox");
        assert.deepEqual(mutations, ["clear", "detach", "attach", "final", "workload"]);
        await replace();
        assert.equal(mutations.length, 5, "An unchanged retry must not clear the final policy");
      },
    );
  });

  test("managed native replacement restores its startup exposure and withdraws it after enrollment", async (t) => {
    const client = workspaceGatewayClient();
    const configuration = sandboxInstallation().drivers.sandbox.configuration;
    configuration.integrationMode = "service";
    configuration.gateway = {};
    configuration.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
    const driver = new ManagedOpenShellSandbox(configuration, {
      id: "openshell-sandbox",
      backend: backendFor(client),
    });
    const { context, revision, requirements } = runtimeSandboxFixture(driver, {
      harnessId: "openclaw",
    });
    requirements.workspaceMounts = [];
    requirements.environment.push(
      { name: "APP_SERVER_PORT", value: "8080" },
      { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
      { name: "NODE_COMPILE_CACHE", value: "/home/node/.openclaw-node/.cache/node-compile" },
    );
    const root = await mkdtemp(join(tmpdir(), "oce-native-bootstrap-cache-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // Run the rendered bootstrap with Node's real startup cache enabled. Only
    // container paths are relocated; Gateway responses remain fixture transport.
    const bootstrap = fileURLToPath(
      new URL("../../deploy/runtime/openshell-bootstrap.cjs", import.meta.url),
    );
    const launchBootstrap = () => {
      const program = request.spec.command[RUNTIME_WRAPPER_COMMAND.length]
        .split("\n")[0]
        .replaceAll("/opt/oce/runtime/openshell-bootstrap.cjs", bootstrap)
        .replaceAll("/sandbox", root);
      const environment = {
        ...process.env,
        NODE_COMPILE_CACHE: request.spec.environment.NODE_COMPILE_CACHE.replaceAll(
          "/sandbox",
          root,
        ),
      };
      delete environment.NODE_DISABLE_COMPILE_CACHE;
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          program +
            '\nrequire("node:assert/strict").ok(require("node:module").getCompileCacheDir());',
        ],
        {
          encoding: "utf8",
          env: environment,
        },
      );
      assert.equal(result.status, 0, result.stderr);
    };
    let request;
    let phase = "SANDBOX_PHASE_READY";
    let service;
    let exposures = 0;
    let starts = 0;
    let exposureMode = "SERVICE_AUTHORIZATION_MODE_STRIP";
    let loseExposureResponse = false;
    client.createSandbox = async (value) => {
      request = value;
      service = harnessService(value.name, "", "http://native.example.test:8080/");
      return storedSandbox(request, { phase });
    };
    client.getSandbox = async () =>
      request === undefined ? undefined : storedSandbox(request, { phase, resourceVersion: "7" });
    client.getService = async () => service;
    client.deleteService = async () => {
      service = undefined;
    };
    client.stopSandbox = async () => {
      phase = "SANDBOX_PHASE_STOPPED";
    };
    client.updateSandbox = async (value) => {
      request = value;
    };
    client.startSandbox = async () => {
      assert.equal(service?.authorizationMode, "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH");
      starts += 1;
      phase = "SANDBOX_PHASE_READY";
    };
    client.exposeService = async (value) => {
      exposures += 1;
      service = {
        ...harnessService(value.sandbox, value.service, "http://native.example.test:8080/"),
        targetPort: value.targetPort,
        authorizationMode: exposureMode,
      };
      if (loseExposureResponse) {
        throw new Error("Lost exposure acknowledgement");
      }
    };
    await driver.ensureNamespace(context);
    await driver.provisionHarness({
      ...context,
      revision,
      requirements,
      workspaceNodeEnrolled: false,
    });
    launchBootstrap();
    await writeFile(
      join(root, ".openclaw-runtime/home/workspace/USER.md"),
      "retained native workspace",
    );
    // Enrollment removes the first revision's diagnostic route while it runs.
    await driver.withdrawHarnessExposure({ ...context, revision, workspaceNodeEnrolled: true });
    assert.equal(service, undefined);
    await driver.cleanup({ ...context, revision });
    const successor = { ...revision, id: "rev_00000000-0000-4000-8000-000000000004" };
    const next = {
      ...context,
      revision: successor,
      requirements: { ...requirements, labels: { "openclaw.dev/revision": successor.id } },
      workspaceNodeEnrolled: false,
    };
    // An acknowledgement alone is insufficient: refuse a route that strips the
    // bearer token and keep the replacement stopped. Do not overwrite that route.
    await assert.rejects(driver.provisionHarness(next), /no exact authenticated Harness service/);
    await assert.rejects(driver.provisionHarness(next), /no exact authenticated Harness service/);
    assert.equal(starts, 0);
    assert.equal(exposures, 1);
    service = undefined;
    exposureMode = "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH";
    loseExposureResponse = true;
    await assert.rejects(driver.provisionHarness(next), /Lost exposure acknowledgement/);
    assert.equal(starts, 0);
    // The server persisted the route before the response was lost. Adoption must
    // recover without issuing another exposure mutation.
    loseExposureResponse = false;
    await driver.provisionHarness(next);
    assert.equal(starts, 1);
    launchBootstrap();
    assert.equal(
      await readFile(join(root, ".openclaw-runtime/home/workspace/USER.md"), "utf8"),
      "retained native workspace",
    );
    assert.equal(exposures, 2);
    assert.equal(service.targetPort, 8080);
    // Reconciliation must adopt the restored route, then leave it absent once
    // this revision enrolls. Agent code must not inherit an unused inbound route.
    await driver.provisionHarness(next);
    assert.equal(exposures, 2);
    await driver.provisionHarness({ ...next, workspaceNodeEnrolled: true });
    await driver.provisionHarness({ ...next, workspaceNodeEnrolled: true });
    assert.equal(service, undefined);
    assert.equal(exposures, 2);
  });
}
