// External Sandbox conformance kit (RFC-0040), AC-2, Compute side: an installed, provider-free
// Sandbox's endpoint owner becomes exactly one canonical external-workspace binding mounted
// read-only in its dedicated Gateway, and anything but an ordinary dedicated Codex revision with
// a pinned generation is refused before any write. The Gateway side (missing, duplicated or
// different generation header closes the connection before any native frame; a changed binding
// file is refused) runs in the runtime image build: deploy/runtime/openclaw-codex-external-workspace.patch.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createExternalDriver,
  loadDriverPackage,
} from "../../apps/controller/src/composition/driver-packages.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { installedDriverPackage } from "../helpers/protected-driver-package.ts";
import {
  digest,
  routedOptions,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

const BINDING_DIRECTORY = "/etc/openclaw-external-workspace";

test("an external Sandbox's endpoint owner is one canonical read-only Gateway binding", async (t) => {
  const provider = await harnessTlsFixture(t);
  const packageName = "@kit/external-sandbox-driver";
  const { directory } = await installedDriverPackage(t, packageName, "external-sandbox-driver", [
    "index",
  ]);
  const loaded = await loadDriverPackage({ package: packageName }, "sandbox", directory, false);
  assert.ok(loaded);
  const fixtureConfiguration = {
    endpoint: "wss://harness.example.test:8443/",
    caBundle: provider.caBundle,
    workspaceRoot: "/srv/external-workspace",
    generationSha256: "b".repeat(64),
  };
  const sandbox = createExternalDriver(
    loaded.module,
    {
      id: "external-sandbox",
      implementation: loaded.implementation,
      configuration: fixtureConfiguration,
      definition: loaded.module,
    },
    "sandbox",
  );
  const endpoint = await sandbox.harnessEndpoint();

  const configured = routedOptions({
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
  });
  configured.network.providerHarness = {
    namespace: "provider",
    podLabels: { app: "provider" },
    address: "10.43.0.50",
    port: 8443,
  };
  const compute = new KubernetesComputeDriver(configured);
  const revision = routedRevision(compute);
  const target = { name: kubernetesNamespaceName(tenant.id), plane: "control" };
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const configuration = compute.gatewayConfiguration(revision, "node", target);
  const writes = [];
  compute.apiClients = Promise.resolve({
    core: {
      async readNamespacedConfigMap() {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      },
      async patchNamespacedConfigMap({ body }) {
        writes.push(body);
      },
    },
  });

  await compute.reconcileHarnessTrust(revision, endpoint, target);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].immutable, true);
  assert.equal(
    writes[0].data["binding.json"],
    JSON.stringify({
      format: "external-workspace-v1",
      url: fixtureConfiguration.endpoint,
      workspaceRoot: fixtureConfiguration.workspaceRoot,
      generationSha256: fixtureConfiguration.generationSha256,
    }),
  );
  assert.equal(writes[0].data["ca.pem"], provider.caBundle);

  const pod = compute.deployment(
    `gateway-${digest(revision.agentId)}`,
    ownership,
    target,
    configured.images.gateway,
    "gateway-account",
    "gateway",
    {},
    "info",
    configuration,
    false,
    undefined,
    undefined,
    [],
    [],
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    endpoint,
  ).spec.template.spec;
  const gateway = pod.containers[0];
  assert.deepEqual(
    gateway.volumeMounts.filter(({ mountPath }) => mountPath.startsWith(`${BINDING_DIRECTORY}/`)),
    ["binding.json", "ca.pem"].map((name) => ({
      name: "harness-trust",
      mountPath: `${BINDING_DIRECTORY}/${name}`,
      subPath: name,
      readOnly: true,
    })),
  );
  assert.ok(
    gateway.env.some(
      ({ name, value }) =>
        name === "OPENCLAW_REMOTE_WORKSPACE_ROOT" && value === fixtureConfiguration.workspaceRoot,
    ),
  );

  // Refused before any write: an unpinned or malformed generation, a non-normalized root, a
  // Sandbox-selected native permission profile, and any revision that is not ordinary.
  for (const [name, candidate, refusedRevision] of [
    ["missing TLS trust", { ...endpoint, tls: undefined }, revision],
    ["malformed generation", { ...endpoint, externalWorkspaceOwner: { generationSha256: "B" } }],
    ["extra owner field", { ...endpoint, externalWorkspaceOwner: { ...endpoint.externalWorkspaceOwner, x: 1 } }],
    ["non-normalized root", { ...endpoint, workspaceRoot: "/srv/./external-workspace" }],
    ["native permission profile", { ...endpoint, codexPermissionProfile: ":danger-full-access" }],
    ["egress plan", endpoint, { ...revision, egressPlan: {} }],
    ["embedded Harness", endpoint, { ...revision, harness: { ...revision.harness, mode: "embedded" } }],
  ]) {
    const before = writes.length;
    await assert.rejects(
      compute.reconcileHarnessTrust(refusedRevision ?? revision, candidate, target),
      /requires an ordinary dedicated Codex revision/,
      name,
    );
    assert.equal(writes.length, before, name);
  }
});
