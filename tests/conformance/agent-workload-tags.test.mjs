import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { WorkloadTagsSandboxDriver } from "../../examples/agent-workload-tags.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OpenShellSandboxAlreadyExistsError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const personalNetwork = [
  {
    name: "approved-egress",
    binaries: [{ path: "/usr/bin/curl" }],
    endpoints: [{ host: "personal.example.test", ports: [443] }],
  },
];
const securityNetwork = [
  {
    name: "approved-egress",
    binaries: [{ path: "/usr/bin/curl" }],
    endpoints: [{ host: "security.example.test", ports: [443] }],
  },
];

async function fixture() {
  const calls = { admission: [], provision: [], cleanup: [], create: [], delete: [] };
  let transportFailure;
  let transportCancellation;
  // This transport captures actual OpenShell requests; policy construction and
  // ownership checks run in the real driver. It does not emulate sandbox execution.
  const gatewayClient = {
    async health() {},
    async createSandbox(request, signal) {
      calls.create.push(structuredClone(request));
      if (transportFailure !== undefined) {
        throw transportFailure;
      }
      transportCancellation?.abort();
      signal.throwIfAborted();
      return {
        name: request.name,
        labels: request.labels,
        serviceUrls: { "": "https://sandbox.example.test" },
      };
    },
    async deleteSandbox(request, signal) {
      signal.throwIfAborted();
      calls.delete.push(structuredClone(request));
    },
    close() {},
  };
  class ObservedSandbox extends WorkloadTagsSandboxDriver {
    configureAgent(configuration, tags) {
      assert.equal(Object.isFrozen(tags), true);
      assert.throws(() => {
        tags.usage = "injected";
      }, TypeError);
      calls.admission.push(tags);
      return super.configureAgent(configuration, tags);
    }
    async provisionHarness(context) {
      assert.equal(Object.isFrozen(context.revision.tags), true);
      assert.throws(() => {
        context.revision.tags.usage = "injected";
      }, TypeError);
      calls.provision.push(context);
      return super.provisionHarness(context);
    }
    async cleanup(context) {
      if (context.revision !== undefined) {
        assert.equal(Object.isFrozen(context.revision.tags), true);
        calls.cleanup.push(context.revision);
      }
      return super.cleanup(context);
    }
  }
  const sandboxOptions = {
    gateway: { endpoint: "http://127.0.0.1:1", workspace: "approved-workspace" },
    kubernetes: {
      runtimeClassName: "openshell-sandbox",
      serviceAccount: { mode: "gatewayConfigured" },
      sandboxDataMount: { subPath: "workspace", mountPath: "/sandbox/enterprise", readOnly: false },
    },
    policy: {
      filesystem: { readOnly: ["/app"], readWrite: ["/home/node/.codex"] },
      process: { runAsUser: "1000", runAsGroup: "1000" },
      networkPolicies: structuredClone(personalNetwork),
    },
  };
  const sandbox = new ObservedSandbox(sandboxOptions, securityNetwork, {
    id: "sandbox-workload-tags",
    gatewayClient,
  });
  sandboxOptions.policy.process.runAsUser = "0";
  sandboxOptions.policy.networkPolicies[0].endpoints[0].host = "unapproved.example.test";
  const configurationDriver = createTestConfigurationDriver();
  const compute = createTestKubernetesComputeDriver();
  const controller = new OpenClawController({
    id: "installation-tags",
    name: "Workload tags",
    createdAt: "2026-09-10T00:00:00.000Z",
  });
  const servicePrincipals = [];
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [
        ...servicePrincipals,
        {
          kind: "principal",
          id: "admin",
          issuer: "https://identity.example.test",
          subject: "admin",
        },
      ],
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [
        ...servicePrincipals.map(({ id, namespaceId }) => ({
          id: `role-${id}`,
          namespaceId,
          permissions: [{ action: "operate", resourceKind: "secret" }],
        })),
        {
          id: "admin-role",
          permissions: [
            ["secret", "create"],
            ["secret", "read"],
            ["secret", "operate"],
            ["namespace", "create"],
            ["namespace", "read"],
            ["configuration", "create"],
            ["configuration", "read"],
            ["agent", "create"],
            ["agent", "read"],
            ["agent", "update"],
            ["agent", "deploy"],
            ["agent_revision", "read"],
          ].map(([resourceKind, action]) => ({ resourceKind, action })),
        },
      ],
      bindings: [
        ...servicePrincipals.map(({ id, namespaceId }) => ({
          id: `binding-${id}`,
          namespaceId,
          subjectKind: "identity",
          subjectId: id,
          roleId: `role-${id}`,
        })),
        { id: "admin-binding", subjectKind: "identity", subjectId: "admin", roleId: "admin-role" },
      ],
    }),
  });
  const secretDriver = createTestSecretDriver();
  for (const driver of [iam, configurationDriver, compute, sandbox, secretDriver]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const namespace = await controller.createNamespace("admin", { name: "Workload tag conformance" });
  // OCC admission requires completed Namespace provisioning. This fixture supplies
  // an existing ready tenant, then exercises the real transaction and Drivers.
  await controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const configuration = await controller.createConfiguration("admin", {
    namespaceId: namespace.id,
    kind: "agent",
    values: createHarnessConfiguration("codex", "test-model"),
  });
  const secret = await controller.createSecret("admin", {
    namespaceId: namespace.id,
    name: "model-key",
    value: "synthetic-model-key",
  });
  const agent = await controller.createAgent("admin", {
    namespaceId: namespace.id,
    name: "Tagged workload",
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: namespace.id, id: secret.id },
    },
    tags: { usage: "personal", "arbitrary.tag/key": "not-an-environment-variable" },
  });
  servicePrincipals.push({
    kind: "service_principal",
    id: agent.servicePrincipalId,
    namespaceId: namespace.id,
  });
  const reference = { namespaceId: namespace.id, agentId: agent.id };
  const deploy = () => controller.deployAgent("admin", reference, resolveApprovedHarness);
  const update = (tags) =>
    controller.updateAgent("admin", { ...reference, configurationId: configuration.id, tags });

  // A separate Sandbox contract fixture, not a representation of a running Codex
  // workload. This credential-free input proves backend policy construction only.
  function sandboxContractContext(revision, signal = new AbortController().signal) {
    return {
      namespace: { ...namespace, status: "ready", name: kubernetesNamespaceName(namespace.id) },
      revision,
      signal,
      requirements: {
        image: "contract-fixture:local",
        command: ["node", "-e", "process.exit(0)"],
        environment: [
          { name: "LOG_FORMAT", value: "json" },
          { name: "APP_SERVER_PORT", value: "8080" },
        ],
        labels: {
          "openclaw.dev/namespace": namespace.id,
          "openclaw.dev/agent": agent.id,
          "openclaw.dev/revision": revision.id,
          "openclaw.dev/workload-role": "agent",
          "openclaw.dev/service-principal": revision.servicePrincipalId,
        },
        serviceAccountName: `agent-${digest(agent.id)}`,
        serviceAccountToken: {
          audience: "openclaw-controller",
          expirationSeconds: 900,
          path: "token",
          mountPath: "/var/run/secrets/openclaw/service-principal",
          readOnly: true,
        },
        workspaceMounts: [
          {
            claimName: `workspace-${digest(agent.id)}`,
            subPath: "workspace",
            mountPath: "/workspace",
            readOnly: false,
          },
          {
            claimName: `workspace-${digest(agent.id)}`,
            subPath: "skills",
            mountPath: "/approved-skills",
            readOnly: true,
          },
        ],
      },
    };
  }
  return {
    controller,
    namespace,
    agent,
    sandbox,
    calls,
    deploy,
    update,
    sandboxContractContext,
    failTransport(error) {
      transportFailure = error;
    },
    cancelTransport(cancellation) {
      transportCancellation = cancellation;
    },
  };
}

test("admitted workload tags select distinct OpenShell policies through Sandbox contract fixtures", async () => {
  const f = await fixture();
  const personal = await f.deploy();
  const changedTags = { usage: "security", "arbitrary.tag/key": "not-an-environment-variable" };
  await f.update(changedTags);
  changedTags.usage = "personal";
  const security = await f.deploy();
  assert.equal(personal.tags.usage, "personal");
  assert.equal(security.tags.usage, "security");
  assert.equal(personal.configurationId, security.configurationId);
  assert.deepEqual(
    f.calls.admission.map((tags) => tags.usage),
    ["personal", "security"],
  );

  for (const revision of [personal, security]) {
    await f.sandbox.provisionHarness(f.sandboxContractContext(revision));
  }
  assert.deepEqual(
    f.calls.provision.map(({ revision }) => revision.tags.usage),
    ["personal", "security"],
  );
  const [personalRequest, securityRequest] = f.calls.create;
  assert.deepEqual(personalRequest.spec.policy.network_policies["approved-egress"].endpoints, [
    { host: "personal.example.test", ports: [443] },
  ]);
  assert.deepEqual(securityRequest.spec.policy.network_policies["approved-egress"].endpoints, [
    { host: "security.example.test", ports: [443] },
  ]);
  assert.notEqual(personalRequest.name, securityRequest.name);
  for (const [index, request] of f.calls.create.entries()) {
    const revision = [personal, security][index];
    assert.equal(request.workspace, "approved-workspace");
    assert.equal(request.labels["openclaw.dev/agent"], f.agent.id);
    assert.equal(request.labels["openclaw.dev/revision"], revision.id);
    assert.equal(request.annotations["openclaw.dev/namespace-id"], f.namespace.id);
    assert.equal(request.spec.template.runtime_class_name, "openshell-sandbox");
    assert.deepEqual(request.spec.policy.process, { run_as_user: "1000", run_as_group: "1000" });
    assert.ok(request.spec.policy.filesystem.read_only.includes("/app"));
    assert.deepEqual(request.spec.template.labels, f.calls.provision[index].requirements.labels);
    for (const tag of Object.keys(revision.tags)) {
      assert.equal(Object.hasOwn(request.labels, tag), false);
      assert.equal(Object.hasOwn(request.spec.environment, tag), false);
    }
    // Exact identity projection and approved PVC mounts are invariant across policies.
    assert.deepEqual(
      request.spec.template.driver_config,
      personalRequest.spec.template.driver_config,
    );
    assert.deepEqual(request.spec.policy.filesystem, personalRequest.spec.policy.filesystem);
  }
  const requirements = f.calls.provision[0].requirements;
  const serializedDriver = JSON.stringify(personalRequest.spec.template.driver_config);
  // The selected gatewayConfigured mode leaves ServiceAccount selection to the gateway.
  // The payload retains the approved token projection and mounts, but does not prove live identity.
  assert.equal(serializedDriver.includes(requirements.serviceAccountName), false);
  assert.ok(serializedDriver.includes(requirements.serviceAccountToken.mountPath));
  for (const mount of requirements.workspaceMounts) {
    assert.ok(serializedDriver.includes(mount.claimName));
  }
  // Cleanup selects the old immutable policy even after the Agent has changed.
  await f.sandbox.cleanup(f.sandboxContractContext(personal));
  assert.deepEqual(
    f.calls.cleanup.map((revision) => [revision.id, revision.tags.usage]),
    [[personal.id, "personal"]],
  );
  assert.deepEqual(f.calls.delete, [
    { name: personalRequest.name, workspace: "approved-workspace" },
  ]);
  const cleanupContext = f.sandboxContractContext(personal);
  await assert.rejects(
    f.sandbox.cleanup({
      ...cleanupContext,
      namespace: { ...cleanupContext.namespace, id: "foreign-namespace" },
    }),
    /outside its selected AgentRevision and Namespace/,
  );
  assert.deepEqual(f.calls.delete, [
    { name: personalRequest.name, workspace: "approved-workspace" },
  ]);
});

test("trusted example rejects unknown usage before admission and defaults missing usage safely", async () => {
  const f = await fixture();
  await f.update({ usage: "unapproved-policy", endpoint: "attacker.example.test" });
  await assert.rejects(f.deploy(), /Unsupported workload usage tag/);
  assert.deepEqual(await f.controller.listRevisions("admin", f.namespace.id, f.agent.id), []);
  assert.deepEqual(f.calls.create, []);
  await f.update({});
  const untagged = await f.deploy();
  assert.deepEqual(untagged.tags, {});
  await f.sandbox.provisionHarness(f.sandboxContractContext(untagged));
  assert.equal(
    f.calls.create[0].spec.policy.network_policies["approved-egress"].endpoints[0].host,
    "personal.example.test",
  );
});

test("OpenShell contract failure, retry and cancellation retain revision policy and exact cleanup", async () => {
  const f = await fixture();
  const revision = await f.deploy();
  f.failTransport(new Error("backend unavailable"));
  await assert.rejects(
    f.sandbox.provisionHarness(f.sandboxContractContext(revision)),
    /backend unavailable/,
  );
  await f.update({ usage: "security" });
  // A duplicate response represents a retry after the original create response was lost.
  f.failTransport(new OpenShellSandboxAlreadyExistsError(f.calls.create[0].name));
  await assert.rejects(
    f.sandbox.provisionHarness(f.sandboxContractContext(revision)),
    /already exists without a replayable create-time service URL/,
  );
  assert.deepEqual(f.calls.create[1], f.calls.create[0]);
  const cancellation = new AbortController();
  f.failTransport(undefined);
  f.cancelTransport(cancellation);
  await assert.rejects(
    f.sandbox.provisionHarness(f.sandboxContractContext(revision, cancellation.signal)),
    { name: "AbortError" },
  );
  assert.equal(f.calls.create.length, 3);
  assert.deepEqual(f.calls.create[2], f.calls.create[0]);
  await f.sandbox.cleanup(f.sandboxContractContext(revision));
  assert.deepEqual(f.calls.delete, [
    { name: f.calls.create[0].name, workspace: "approved-workspace" },
  ]);
  assert.equal(f.calls.cleanup[0].tags.usage, "personal");
});
