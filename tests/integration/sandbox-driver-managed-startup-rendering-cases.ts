import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellGatewayClient,
  type OpenShellSandboxCreateRequest,
  type OpenShellProviderResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { HarnessWorkloadRequirements } from "../../packages/contracts/src/index.ts";
import { grpc, loader, openShellService, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { harnessService, runtimeSandboxFixture } from "./sandbox-driver-startup-orchestration.ts";
import { completeWorkspaceRevision } from "./sandbox-driver-revision-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export type ManagedSandboxPhase =
  "SANDBOX_PHASE_PROVISIONING" | "SANDBOX_PHASE_STOPPED" | "SANDBOX_PHASE_READY";
export type ManagedPolicy = Record<string, unknown> & { network_policies: Record<string, unknown> };
export type ManagedWorkloadSpec = Record<string, unknown> & {
  command: string[];
  template: Record<string, unknown>;
  environment: Record<string, string>;
  providers: string[];
  policy: ManagedPolicy;
};
export type ManagedSandboxRequest = OpenShellSandboxCreateRequest & { spec: ManagedWorkloadSpec };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertManagedPolicy(value: unknown): asserts value is ManagedPolicy {
  assert.ok(isRecord(value) && isRecord(value.network_policies));
}

/** Validate the workload emitted at the real Sandbox Gateway request boundary. */
export function assertManagedSandboxRequest(
  request: OpenShellSandboxCreateRequest,
): asserts request is ManagedSandboxRequest {
  const { command, template, environment, providers, policy } = request.spec;
  assert.ok(isRecord(template));
  assert.ok(Array.isArray(command) && command.every((part: unknown) => typeof part === "string"));
  assert.ok(
    isRecord(environment) && Object.values(environment).every((value) => typeof value === "string"),
  );
  assert.ok(
    Array.isArray(providers) &&
      providers.every((provider: unknown) => typeof provider === "string"),
  );
  assertManagedPolicy(policy);
}

type UpdateProviderRequest = {
  workspace_scope: { workspace: string };
  provider: {
    metadata: { name: string; resource_version: string };
    config: Record<string, string>;
  };
};
type UpdateProviderResponse = {
  provider: {
    metadata: { name: string; labels: Readonly<Record<string, string>>; resource_version: string };
    type: string;
    config: Readonly<Record<string, string>>;
  };
};
type ProviderMutation = "detach" | "attach";

export function registerManagedStartupRenderingCases(): void {
  test("managed Harness rendering submits no PVC and keeps the bootstrap outside persistent state", async (t) => {
    const client = workspaceGatewayClient();
    const providerByName = (name: string): OpenShellProviderResponse => {
      const provider = client.providers.get(name);
      assert.ok(provider, `Provider ${name} must exist`);
      return provider;
    };
    // Exercise the production client's config validation and protobuf encoding on
    // replacement; the in-memory provider fixture alone accepts empty patch values.
    const definition = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
      { keepCase: true, longs: String, defaults: false },
    );
    const server = new grpc.Server();
    t.after(() => server.forceShutdown());
    const updateProviderConfig = client.updateProviderConfig.bind(client);
    let configUpdateMode: "apply" | "reject" | "ignore" | "lose-response" = "apply";
    server.addService(openShellService(grpc.loadPackageDefinition(definition)), {
      async UpdateProvider(
        call: Grpc.ServerUnaryCall<UpdateProviderRequest, UpdateProviderResponse>,
        callback: Grpc.sendUnaryData<UpdateProviderResponse>,
      ) {
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
                  new AbortController().signal,
                );
          assert.ok(provider);
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
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
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
    const base = sandboxInstallation().drivers.sandbox.configuration;
    const configuration = {
      ...base,
      kubernetes: {
        ...base.kubernetes,
        agentResources: {
          requests: { cpu: "1", memory: "1Gi" },
          limits: { cpu: "2", memory: "2Gi" },
        },
      },
    };
    configuration.integrationMode = "service";
    configuration.gateway = {};
    configuration.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
    const driver = new ManagedOpenShellSandbox(configuration, {
      id: "openshell-sandbox",
      backend: backendFor(client),
    });
    let request: ManagedSandboxRequest | undefined;
    const currentRequest = (): ManagedSandboxRequest => {
      assert.ok(request, "The Gateway must have received a Sandbox workload");
      return request;
    };
    let phase: ManagedSandboxPhase = "SANDBOX_PHASE_PROVISIONING";
    client.createSandbox = async (value) => {
      assertManagedSandboxRequest(value);
      request = value;
      return storedSandbox(value, { phase: "SANDBOX_PHASE_PROVISIONING" });
    };
    const structDefinition = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
      { oneofs: true },
    );
    const struct = structDefinition["google.protobuf.Struct"];
    assert.ok(struct && "serialize" in struct && "deserialize" in struct);
    const { serialize, deserialize } = struct;
    assert.ok(typeof serialize === "function" && typeof deserialize === "function");
    client.getSandbox = async () => {
      if (request === undefined) {
        return undefined;
      }
      const result = storedSandbox(structuredClone(request), { phase, resourceVersion: "7" });
      const template = result.spec.template;
      assert.ok(isRecord(template));
      if (template.resources !== undefined) {
        assert.ok(isRecord(template.resources));
        template.resources = deserialize(serialize(template.resources));
      }
      return result;
    };
    client.getService = async () =>
      harnessService(currentRequest().name, "", "http://codex.example.test:8080/");
    const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(driver);
    const readSandbox = () =>
      client.getSandbox(
        { workspace: currentRequest().workspace, name: currentRequest().name },
        context.signal,
      );
    const revision = completeWorkspaceRevision(fixtureRevision, requirements);
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
    const template = currentRequest().spec.template;
    assert.equal(template.driver_config, undefined);
    // Keep independent quantity expectations at the outgoing request boundary.
    assert.deepEqual(template.resources, {
      fields: {
        requests: {
          structValue: {
            fields: {
              cpu: { stringValue: "1" },
              memory: { stringValue: "1Gi" },
              "ephemeral-storage": { stringValue: "256Mi" },
            },
          },
        },
        limits: {
          structValue: {
            fields: {
              cpu: { stringValue: "2" },
              memory: { stringValue: "2Gi" },
              "ephemeral-storage": { stringValue: "1Gi" },
            },
          },
        },
      },
    });
    assert.equal(JSON.stringify(currentRequest().spec).includes("persistent_volume_claim"), false);
    assert.equal(JSON.stringify(currentRequest().spec).includes("harness-workspace-codex"), false);
    assert.equal(
      currentRequest().spec.environment.OPENCLAW_WORKSPACE_DIR,
      "/sandbox/oce/workspace",
    );
    assert.equal(
      currentRequest().spec.environment.OPENCLAW_NODE_STATE_DIR,
      "/sandbox/oce/workspace-node-codex/state",
    );
    assert.equal(
      currentRequest().spec.environment.UNRELATED_PATH,
      "/opt/oce/managed/private/home/.openclaw-node",
    );
    const bootstrapCommand = currentRequest().spec.command[RUNTIME_WRAPPER_COMMAND.length];
    assert.ok(bootstrapCommand);
    assert.match(
      bootstrapCommand,
      /require\("\/opt\/oce\/runtime\/openshell-bootstrap.cjs"\)\.prepareManaged/,
    );
    const successor = { ...revision, id: "rev_00000000-0000-4000-8000-000000000004" };
    assert.equal(
      driver.harnessResource({ namespace: context.namespace, revision }).resourceName,
      driver.harnessResource({ namespace: context.namespace, revision: successor }).resourceName,
    );
    // Sizing is immutable even while stopped. Missing or changed readback must
    // refuse replacement before update or start can run.
    phase = "SANDBOX_PHASE_STOPPED";
    client.updateSandbox = client.startSandbox = async () => assert.fail("Sizing changed");
    for (const resources of [undefined, { fields: {} }]) {
      const getSandbox = client.getSandbox;
      client.getSandbox = async (selector, signal) => {
        const result = await getSandbox(selector, signal);
        assert.ok(result);
        const template = result.spec?.template;
        assert.ok(isRecord(template));
        template.resources = resources;
        return result;
      };
      await assert.rejects(
        driver.provisionHarness({ ...context, revision, requirements }),
        /cannot change resources/,
      );
      client.getSandbox = getSandbox;
    }
    // A predecessor created before template sizing retains its caller config.
    // Neither resuming it nor deploying a successor can convert its storage in place.
    const originalTemplate = currentRequest().spec.template;
    const { resources: previousSizing, ...previousTemplate } = originalTemplate;
    const config = { resources: { structValue: previousSizing } };
    const agentConfig = { agent: { structValue: { fields: config } } };
    const containers = { containers: { structValue: { fields: agentConfig } } };
    currentRequest().spec.template = {
      ...previousTemplate,
      driver_config: { fields: { kubernetes: { structValue: { fields: containers } } } },
    };
    for (const target of [revision, successor]) {
      await assert.rejects(
        driver.provisionHarness({ ...context, revision: target, requirements }),
        {
          code: "SANDBOX_RECREATION_REQUIRED",
        },
      );
    }
    currentRequest().spec.template = originalTemplate;
    const resized = structuredClone(configuration);
    resized.kubernetes.agentResources.requests.cpu = "1500m";
    const resizedDriver = new ManagedOpenShellSandbox(resized, {
      id: "openshell-sandbox",
      backend: backendFor(client),
    });
    await assert.rejects(
      resizedDriver.provisionHarness({ ...context, revision, requirements }),
      /cannot change resources/,
    );

    // A server with the older image-only update contract can acknowledge an update
    // while retaining command/environment/metadata. Readback must prevent StartSandbox.
    phase = "SANDBOX_PHASE_STOPPED";
    const runtimeProvider = [...client.providers.values()].find(
      (provider) => provider.config.oce_revision_id === revision.id,
    );
    // A previous runtime version may have stored fields the successor no longer
    // uses. Both populated and empty obsolete fields must disappear on replacement.
    assert.ok(runtimeProvider);
    client.providers.set(runtimeProvider.name, {
      ...runtimeProvider,
      config: {
        ...runtimeProvider.config,
        obsolete_runtime_setting: "previous-value",
        obsolete_empty_setting: "",
      },
    });
    let attemptedUpdate:
      (OpenShellSandboxCreateRequest & { readonly expectedResourceVersion: string }) | undefined;
    client.updateSandbox = async (update) => {
      attemptedUpdate = update;
      return storedSandbox(currentRequest(), { phase, resourceVersion: "8" });
    };
    client.startSandbox = async () => {
      assert.fail("An incomplete workload update must never start");
    };
    const replace = () =>
      driver.provisionHarness({
        ...context,
        revision: successor,
        requirements: {
          ...requirements,
          labels: { ...requirements.labels, "openclaw.dev/revision": successor.id },
        },
      });
    // A refused patch (for example, profile validation or a version conflict)
    // and an acknowledged but uncommitted patch must both prevent workload update.
    configUpdateMode = "reject";
    await assert.rejects(replace(), { code: grpc.status.FAILED_PRECONDITION });
    configUpdateMode = "ignore";
    await assert.rejects(replace(), /without exact AgentRevision ownership and content/);
    assert.equal(attemptedUpdate, undefined);
    assert.equal(providerByName(runtimeProvider.name).config.oce_revision_id, revision.id);
    assert.equal(
      providerByName(runtimeProvider.name).config.obsolete_runtime_setting,
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
    const currentUpdate = (): OpenShellSandboxCreateRequest & {
      readonly expectedResourceVersion: string;
    } => {
      assert.ok(attemptedUpdate);
      return attemptedUpdate;
    };
    assert.equal(currentUpdate().expectedResourceVersion, "7");
    assert.equal(currentUpdate().annotations["openclaw.dev/revision-id"], successor.id);
    const configUpdate = client.calls.find((call) => call[0] === "updateProviderConfig");
    assert.ok(configUpdate && configUpdate[0] === "updateProviderConfig");
    assert.deepEqual(configUpdate[2], {
      oce_revision_id: successor.id,
      obsolete_runtime_setting: "",
      obsolete_empty_setting: "",
    });
    assert.equal(
      Object.hasOwn(providerByName(configUpdate[1]).config, "obsolete_runtime_setting"),
      false,
    );
    assert.equal(
      Object.hasOwn(providerByName(configUpdate[1]).config, "obsolete_empty_setting"),
      false,
    );
    assert.equal(providerByName(configUpdate[1]).config.node_ca_pem, "");
    // Storing the successor metadata is insufficient if sizing disappears on
    // readback. The stopped workload must not reach StartSandbox.
    const beforeUpdate = structuredClone(currentRequest());
    for (const resources of [undefined, { fields: {} }]) {
      client.updateSandbox = async (value) => {
        assertManagedSandboxRequest(value);
        request = structuredClone(value);
        request.spec.template.resources = resources;
        return storedSandbox(request, { phase, resourceVersion: "8" });
      };
      await assert.rejects(replace(), /did not store the exact requested workload update/);
      assert.equal(phase, "SANDBOX_PHASE_STOPPED");
      request = structuredClone(beforeUpdate);
    }
    // Retrying with a server that stores the complete update must finish the
    // replacement, without resending the already committed Provider patch.
    client.updateSandbox = async (value) => {
      assertManagedSandboxRequest(value);
      request = value;
      return storedSandbox(value, { phase });
    };
    client.startSandbox = async () => {
      phase = "SANDBOX_PHASE_READY";
      return storedSandbox(currentRequest(), { phase });
    };
    await replace();
    assert.equal(phase, "SANDBOX_PHASE_READY");
    assert.equal((await readSandbox())?.labels["openclaw.dev/revision"], successor.id);
    assert.equal(currentRequest().annotations["openclaw.dev/revision-id"], successor.id);
    assert.equal(
      client.calls.filter(([operation]) => operation === "updateProviderConfig").length,
      1,
    );
    await t.test(
      "Provider replacement resumes after lost detach and attach responses",
      async () => {
        let version = 8;
        const mutations: [ProviderMutation, string][] = [];
        let policy = structuredClone(currentRequest().spec.policy);
        const attachment = requirements.credentialAttachments[0];
        assert.ok(attachment);
        const sourceA = attachment.ref;
        const sourceB = openShellProviderName("source-b");
        client.getSandbox = async () =>
          storedSandbox(currentRequest(), {
            id: "retained-sandbox-id",
            phase,
            resourceVersion: String(version),
          });
        const policyStatus = (value: Readonly<Record<string, unknown>>) => ({
          policy: value,
          version: 1,
          activeVersion: 1,
          state: "POLICY_STATUS_LOADED",
        });
        client.getPolicyStatus = async () => policyStatus(structuredClone(policy));
        client.updatePolicy = async (value) => {
          assert.equal(phase, "SANDBOX_PHASE_STOPPED");
          assert.equal(value.expectedResourceVersion, String(version));
          assertManagedPolicy(value.policy);
          policy = structuredClone(value.policy);
          version += 1;
        };
        let loseResponse: ProviderMutation | undefined;
        const mutate = async (
          operation: ProviderMutation,
          ...[_workspace, name, provider, _signal, conditional]: Parameters<
            OpenShellGatewayClient["attachSandboxProvider"]
          >
        ): Promise<void> => {
          assert.equal(name, currentRequest().name);
          assert.equal(phase, "SANDBOX_PHASE_STOPPED");
          assert.equal(conditional.expectedResourceVersion, String(version));
          mutations.push([operation, provider]);
          currentRequest().spec.providers =
            operation === "detach"
              ? currentRequest().spec.providers.filter((value) => value !== provider)
              : [...currentRequest().spec.providers, provider];
          version += 1;
          if (loseResponse === operation) {
            loseResponse = undefined;
            throw new Error("lost mutation response");
          }
        };
        client.detachSandboxProvider = async (workspace, name, provider, signal, conditional) => {
          assert.ok(conditional);
          await mutate("detach", workspace, name, provider, signal, conditional);
          return {};
        };
        client.attachSandboxProvider = async (...args) => mutate("attach", ...args);
        // UpdateSandbox cannot reorder or replace Providers. Preserve the gateway's
        // actual attachment list so full-spec readback cannot hide a missed mutation.
        client.updateSandbox = async (value) => {
          assert.equal(value.expectedResourceVersion, String(version));
          assertManagedSandboxRequest(value);
          request = {
            ...value,
            spec: {
              ...value.spec,
              providers: currentRequest().spec.providers,
              policy: currentRequest().spec.policy,
            },
          };
          version += 1;
          return storedSandbox(currentRequest(), { phase, resourceVersion: String(version) });
        };
        const nextAttachment = { sourceId: "source-b", ref: sourceB };
        const provision = (
          id: string,
          credentialAttachment: HarnessWorkloadRequirements["credentialAttachments"][number],
        ) => {
          const effectiveRequirements = {
            ...requirements,
            labels: { ...requirements.labels, "openclaw.dev/revision": id },
            credentialAttachments: [credentialAttachment],
          };
          return driver.provisionHarness({
            ...context,
            revision: { ...completeWorkspaceRevision(fixtureRevision, effectiveRequirements), id },
            requirements: effectiveRequirements,
          });
        };
        phase = "SANDBOX_PHASE_STOPPED";
        const prior = "rev_00000000-0000-4000-8000-000000000005";
        await provision(prior, attachment);
        assert.equal(phase, "SANDBOX_PHASE_READY");
        assert.equal((await readSandbox())?.labels["openclaw.dev/revision"], prior);
        phase = "SANDBOX_PHASE_STOPPED";
        loseResponse = "detach";
        const next = "rev_00000000-0000-4000-8000-000000000006";
        await assert.rejects(provision(next, nextAttachment), /lost mutation response/);
        assert.equal(phase, "SANDBOX_PHASE_STOPPED");
        assert.equal(currentRequest().spec.providers.includes(sourceA), false);
        loseResponse = "attach";
        await assert.rejects(provision(next, nextAttachment), /lost mutation response/);
        assert.equal(phase, "SANDBOX_PHASE_STOPPED");
        // A retry with already-correct attachments must still check current policy;
        // membership alone cannot authorize starting the desired workload.
        client.getPolicyStatus = async () => policyStatus({ network_policies: {} });
        await assert.rejects(
          provision(next, nextAttachment),
          /static policy or non-Git middleware bindings/,
        );
        assert.equal(phase, "SANDBOX_PHASE_STOPPED");
        client.getPolicyStatus = async () => policyStatus(structuredClone(policy));
        await provision(next, nextAttachment);
        assert.equal(phase, "SANDBOX_PHASE_READY");
        assert.equal((await readSandbox())?.labels["openclaw.dev/revision"], next);
        assert.deepEqual(mutations, [
          ["detach", sourceA],
          ["attach", sourceB],
        ]);
        assert.equal(currentRequest().spec.providers.includes(sourceB), true);
        assert.equal(
          client.calls.some(([operation]) => operation === "deleteProvider"),
          false,
        );

        // A policy changed through the live API is not reflected in spec.policy.
        // Attachment reconciliation must refuse it before removing a credential.
        phase = "SANDBOX_PHASE_STOPPED";
        client.getPolicyStatus = async () => policyStatus({ network_policies: {} });
        await assert.rejects(
          provision("rev_00000000-0000-4000-8000-000000000007", attachment),
          /static policy or non-Git middleware bindings/,
        );
        assert.equal(mutations.length, 2);
        client.getPolicyStatus = async () => policyStatus(structuredClone(policy));
        client.detachSandboxProvider = async () => ({});
        await assert.rejects(
          provision("rev_00000000-0000-4000-8000-000000000007", attachment),
          /attachment readback differs/,
        );
        assert.equal(phase, "SANDBOX_PHASE_STOPPED");
      },
    );
  });
}
