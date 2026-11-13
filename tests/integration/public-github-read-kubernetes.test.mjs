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

function revision(id, namespaceId, agentId, ordinal) {
  return {
    id,
    namespaceId,
    agentId,
    revision: ordinal,
    compute: { id: "compute-test", implementation: "kubernetes-local" },
    harness: { id: "codex", mode: "dedicated", version: "1.0.0" },
    plugins: { driver: { id: "plugin-codex", implementation: "occ/codex-plugin" }, plugins: {} },
  };
}

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
    const first = revision("revision-first", "namespace-first", "agent-first", 1);
    const second = revision("revision-second", "namespace-second", "agent-second", 1);
    const policy = { mode: "repositories", repositories: ["example/project"] };
    const neverPrepared = revision("revision-never-prepared", "namespace-first", "agent-first", 3);
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
    const compacted = JSON.parse(
      (await core.readNamespacedConfigMap({ namespace, name: "authorizations" })).data[
        "authorizations.json"
      ],
    );
    assert.equal(compacted[first.id], undefined, "retired grants leave the reader projection");
    await restarted.retireCapability(first, namespace);
    await assert.rejects(
      new KubernetesPublicGithubReadAuthorizationStore(options).prepare(first, namespace, policy),
      /restored|withdrawn|frozen/,
    );
    assert.equal(
      (await restarted.prepare(second, namespace, { mode: "all" })).capability,
      other.capability,
    );
    const successor = revision("revision-successor", "namespace-first", "agent-first", 2);
    const next = await restarted.prepare(successor, namespace, policy);
    assert.notEqual(next.capability, initial.capability);
    const cold = new KubernetesPublicGithubReadAuthorizationStore(options);
    assert.equal((await cold.prepare(successor, namespace, policy)).capability, next.capability);
    await assert.rejects(
      cold.prepare(first, namespace, policy),
      /restored|withdrawn|frozen|retired/,
    );
  },
);
