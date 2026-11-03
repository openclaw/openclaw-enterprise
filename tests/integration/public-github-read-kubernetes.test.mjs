import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { KubernetesPublicGithubReadAuthorizationStore } from "../../apps/controller/src/drivers/compute/kubernetes/public-github-read-authorizations.ts";

const { KubeConfig, CoreV1Api } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");
const selected =
  process.env.OCC_TEST_PUBLIC_GITHUB_READ_KUBERNETES === "1" ||
  process.env.OCC_TEST_KUBERNETES_CONFIGURATION === "1";

test(
  "Kubernetes public-reader authorization survives restart and permanently withdraws only its revision",
  { skip: !selected },
  async (t) => {
    const kube = new KubeConfig();
    kube.loadFromFile(process.env.OCC_TEST_KUBERNETES_KUBECONFIG);
    kube.setCurrentContext(process.env.OCC_TEST_KUBERNETES_CONTEXT);
    assert.match(kube.getCurrentContext(), /^k3d-openclaw-k8s-/);
    const core = kube.makeApiClient(CoreV1Api);
    const namespace = "oce-public-read-" + randomUUID().slice(0, 8);
    await core.createNamespace({
      body: { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } },
    });
    t.after(() => core.deleteNamespace({ name: namespace }));
    const installationId = "installation-test";
    await core.createNamespacedConfigMap({
      namespace,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: "authorizations",
          namespace,
          labels: {
            "openclaw.dev/public-read-installation": createHash("sha256")
              .update(installationId)
              .digest("hex")
              .slice(0, 32),
          },
        },
        data: { "authorizations.json": "{}\n" },
      },
    });
    const options = {
      core,
      namespace,
      configMapName: "authorizations",
      installationId,
      driverId: "compute-test",
    };
    const store = new KubernetesPublicGithubReadAuthorizationStore(options);
    const first = { id: "revision-first", namespaceId: "namespace-first", agentId: "agent-first" };
    const second = {
      id: "revision-second",
      namespaceId: "namespace-second",
      agentId: "agent-second",
    };
    const policy = { mode: "repositories", repositories: ["example/project"] };
    const neverPrepared = {
      id: "revision-never-prepared",
      namespaceId: "namespace-first",
      agentId: "agent-first",
    };
    await store.suspend(neverPrepared);
    const initial = await store.prepare(first, namespace, policy);
    const other = await store.prepare(second, namespace, { mode: "all" });
    assert.notEqual(initial.capability, other.capability);
    const registry = (await core.readNamespacedConfigMap({ namespace, name: "authorizations" }))
      .data["authorizations.json"];
    assert.equal(
      registry.includes(initial.capability),
      false,
      "only the verifier may enter the public registry",
    );
    assert.deepEqual(JSON.parse(registry)[first.id].policy, policy);
    const restarted = new KubernetesPublicGithubReadAuthorizationStore(options);
    assert.equal(
      (await restarted.prepare(first, namespace, policy)).capability,
      initial.capability,
    );
    await assert.rejects(restarted.prepare(first, namespace, { mode: "all" }), /frozen|changed/);
    await restarted.suspend(first);
    const suspended = JSON.parse(
      (await core.readNamespacedConfigMap({ namespace, name: "authorizations" })).data[
        "authorizations.json"
      ],
    );
    assert.equal(Date.parse(suspended[first.id].validUntil), 0);
    assert.equal(
      (await restarted.prepare(first, namespace, policy)).capability,
      initial.capability,
      "a user restart reuses its immutable capability",
    );
    const withdrawalDigest = await restarted.withdraw(first);
    assert.match(withdrawalDigest, /^[a-f0-9]{64}$/);
    assert.equal(await restarted.digest(), withdrawalDigest);
    await assert.rejects(
      new KubernetesPublicGithubReadAuthorizationStore(options).prepare(first, namespace, policy),
      /restored|withdrawn|frozen/,
    );
    assert.equal(
      (await restarted.prepare(second, namespace, { mode: "all" })).capability,
      other.capability,
    );
  },
);
