import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  deadlineWallMs,
  runtimeBinding,
  workloadPod,
  fixture,
  present,
  malformedBindings,
} from "./repository-runtime-material-fixture.ts";

test("Dedicated credential refresh preserves its enrolled workspace node", async () => {
  let setups = 0;
  const f = await fixture("dedicated", {
    async createSetup() {
      setups++;
      return {
        setupId: "workspace-setup",
        setupCode: "workspace-code",
        expiresAtMs: deadlineWallMs,
      };
    },
    async observeSetup() {
      return { deviceId: "workspace-node", connected: true, delivery: "confirmed" };
    },
    async isConnected() {
      return true;
    },
  });
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  // Gateway readiness permits enrollment. The setup reaches the running Harness
  // through its volume without replacing it, and this fixture pairs at once.
  assert.equal((await f.driver.prepareRevision(f.revision, f.context([original]))).ready, true);
  // Without a status proxy the controller cannot read the Gateway's ack, so
  // activation binds the recorded node ID into the Gateway's pod spec and waits.
  await assert.rejects(
    f.driver.activateRevision(f.revision, f.context([original])),
    /gateway is not ready/,
  );
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const before = structuredClone(f.requireConsumer());
  const nodeSecret = [...f.objects.values()].find(
    (secret) => secret.kind === "Secret" && secret.data?.deviceId,
  );
  assert.ok(nodeSecret);
  const nodeMount = before.spec.template.spec.containers[0].volumeMounts.find(
    (mount) => mount.subPath === nodeSecret.metadata.name,
  );
  assert.ok(nodeMount, "the enrolled identity lives in the revision's private state directory");
  const originalGeneration =
    before.metadata.annotations["openclaw.dev/repository-material-generation"];
  const gateway = structuredClone(
    present(f.deployments().find((deployment) => deployment !== f.consumer())),
  );
  const replacement = runtimeBinding("session_workspace_refresh");
  await assert.rejects(
    f.driver.activateRevision(f.revision, f.context([replacement])),
    /not ready/,
  );
  const refreshed = f.requireConsumer();
  const container = refreshed.spec.template.spec.containers[0];
  assert.notEqual(
    refreshed.metadata.annotations["openclaw.dev/repository-material-generation"],
    originalGeneration,
  );
  assert.deepEqual(container.command, before.spec.template.spec.containers[0].command);
  assert.deepEqual(container.args, before.spec.template.spec.containers[0].args);
  assert.deepEqual(
    container.volumeMounts.find((mount) => mount.subPath === nodeSecret.metadata.name),
    nodeMount,
  );
  assert.equal(
    container.env.some(({ name }) => name === "OPENCLAW_NODE_SETUP_CODE"),
    false,
    "the setup code never enters the Harness environment",
  );
  assert.deepEqual(
    refreshed.spec.template.spec.volumes.find(({ name }) => name === "openclaw-node-setup"),
    before.spec.template.spec.volumes.find(({ name }) => name === "openclaw-node-setup"),
  );
  assert.equal(nodeSecret.data?.setupCode, undefined, "readiness removed the paired setup code");
  assert.deepEqual(
    f.objects.get(`Secret:${nodeSecret.metadata.namespace}:${nodeSecret.metadata.name}`),
    nodeSecret,
  );
  assert.deepEqual(
    f.objects.get(`Deployment:${gateway.metadata.namespace}:${gateway.metadata.name}`),
    gateway,
    "an unready credential replacement must not change the serving Gateway",
  );
  assert.equal(setups, 1, "credential rotation must reuse the enrolled node");
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([replacement]));
  assert.equal(setups, 1);
  assert.deepEqual(
    f.objects.get(`Secret:${nodeSecret.metadata.namespace}:${nodeSecret.metadata.name}`),
    nodeSecret,
  );
  assert.equal(f.secrets().filter((secret) => secret.immutable).length, 1);
});

test("Kubernetes keeps original admission correlation out of runtime resources", async () => {
  const f = await fixture("dedicated");
  const admissionId = "1720000000000-12345678-1234-4234-8234-123456789abc";
  const binding = { ...runtimeBinding(), admissionId };
  // The Worker may carry its original attempt identity internally; it is not
  // a credential and must not be exposed in the Agent's material resources.
  await f.driver.prepareRevision(f.revision, f.context([binding]));
  assert.equal(JSON.stringify([...f.objects.values()]).includes(admissionId), false);
  await f.driver.prepareRevision(
    f.revision,
    f.context([
      {
        kind: "retained",
        repositoryRef: binding.repositoryRef,
        sessionId: binding.sessionId,
        deadlineWallMs: binding.deadlineWallMs,
        admissionId,
      },
    ]),
  );
  assert.equal(f.secrets().length, 1);

  for (const invalid of ["", "bad\ncorrelation", "x".repeat(129), null]) {
    const other = await fixture("dedicated");
    await assert.rejects(
      other.driver.prepareRevision(
        other.revision,
        other.context(malformedBindings([{ ...binding, admissionId: invalid }])),
      ),
      { message: "Repository credential material is invalid." },
    );
    assert.deepEqual(other.apiCalls, []);
  }
});

for (const mode of ["embedded", "dedicated"] as const) {
  test(`Repository material is rechecked after plugin status (${mode})`, async () => {
    const f = await fixture(
      mode,
      mode === "embedded"
        ? undefined
        : {
            async createSetup() {
              return {
                setupId: "plugin-setup",
                setupCode: "plugin-code",
                expiresAtMs: deadlineWallMs,
              };
            },
            async observeSetup() {
              return { deviceId: "plugin-node", connected: true, delivery: "confirmed" };
            },
            async isConnected() {
              return true;
            },
          },
    );
    const pluginId = mode === "embedded" ? "openclaw-plugin:example" : "codex-plugin:example";
    const driverId = mode === "embedded" ? "openclaw-plugin" : "codex-plugin";
    f.revision.plugins = {
      driver: { id: driverId, implementation: `occ/${driverId}` },
      plugins: { [pluginId]: { enabled: true, toolDefaults: { approval: "provider_default" } } },
    };
    let loseMaterialReadiness = false;
    let statusObserved = false;
    f.clients.core.connectGetNamespacedPodProxyWithPath = async ({ name }) => {
      const podName = present(name.split(":")[0]);
      const role = podName.startsWith("gateway-") ? "gateway" : "agent";
      if (loseMaterialReadiness && role === "gateway") {
        statusObserved = true;
        // A status response can arrive after the credential consumer loses readiness.
        // Keep its identity stable so status readback alone cannot detect the change.
        f.setPods(
          f
            .deployments()
            .map((deployment) =>
              workloadPod(
                deployment,
                f.namespace,
                `${deployment.metadata.name}-ready`,
                deployment !== f.consumer(),
              ),
            ),
        );
      }
      return {
        revisionId: f.revision.id,
        container: role,
        podUid: `${podName}-uid`,
        startupId: `${role}-startup`,
        phase: "ready",
        successfulPluginIds: [pluginId],
        failures: [],
      };
    };
    const prepare = () => f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
    // Observe each startup generation, including the Gateway's enrolled-node binding.
    for (let generation = 0; generation < 6; generation++) {
      await prepare();
      f.markReady();
    }
    assert.equal((await prepare()).ready, true);
    loseMaterialReadiness = true;
    assert.equal((await prepare()).ready, false);
    assert.equal(statusObserved, true);
  });
}

test("Embedded successor is not ready when material expires during policy reconciliation", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const f = await fixture("embedded");
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));

  const successor = { ...f.revision, id: "revision-successor", revision: 2 };
  const replacement = runtimeBinding("session_successor");
  const patchPolicy = f.clients.networking.patchNamespacedNetworkPolicy;
  let policyObserved = false;
  f.clients.networking.patchNamespacedNetworkPolicy = async (...args) => {
    const result = await patchPolicy(...args);
    policyObserved = true;
    clock = deadlineWallMs;
    return result;
  };
  const result = await f.driver.prepareRevision(successor, f.context([replacement]));
  assert.equal(policyObserved, true);
  assert.equal(result.ready, false);
});

test("Dedicated successor material is rechecked after workspace-node status", async () => {
  let loseMaterialReadiness = false;
  let statusObserved = false;
  const f = await fixture("dedicated", {
    async createSetup() {
      throw new Error("The material fixture already has an enrolled node.");
    },
    async observeSetup() {
      assert.fail("The enrolled node must not start a new setup observation");
    },
    async isConnected() {
      if (loseMaterialReadiness) {
        statusObserved = true;
        f.setPods(
          f.deployments().map((deployment) => {
            const labels = deployment.spec.template.metadata.labels;
            const successorConsumer =
              labels["openclaw.dev/workload-role"] === "agent" &&
              labels["openclaw.dev/revision"] === present(successor).id;
            return workloadPod(
              deployment,
              f.namespace,
              `${deployment.metadata.name}-ready`,
              !successorConsumer,
            );
          }),
        );
      }
      return true;
    },
  });
  f.enroll(f.revision);
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const successor: AgentRevision = { ...f.revision, id: "revision-successor", revision: 2 };
  f.enroll(successor);
  const replacement = runtimeBinding("session_successor");
  const prepare = () => f.driver.prepareRevision(present(successor), f.context([replacement]));
  await prepare();
  f.markReady();
  assert.equal((await prepare()).ready, true);
  const gateway = f
    .deployments()
    .find(
      (deployment) =>
        deployment.spec.template.metadata.labels["openclaw.dev/workload-role"] === "gateway",
    );
  assert.ok(gateway);
  assert.equal(gateway.spec.template.metadata.labels["openclaw.dev/revision"], f.revision.id);
  loseMaterialReadiness = true;
  assert.equal((await prepare()).ready, false);
  assert.equal(statusObserved, true);
  loseMaterialReadiness = false;
  f.markReady();
  assert.equal((await prepare()).ready, true);
});

test("Dedicated successor is not ready when material expires during workspace-node status", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  let expireOnStatus = false;
  let statusObserved = false;
  const f = await fixture("dedicated", {
    async createSetup() {
      throw new Error("The material fixture already has an enrolled node.");
    },
    async observeSetup() {
      assert.fail("The enrolled node must not start a new setup observation");
    },
    async isConnected() {
      if (expireOnStatus) {
        statusObserved = true;
        clock = deadlineWallMs;
      }
      return true;
    },
  });
  f.enroll(f.revision);
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));

  const successor = { ...f.revision, id: "revision-successor", revision: 2 };
  f.enroll(successor);
  const replacement = runtimeBinding("session_successor");
  const prepare = () => f.driver.prepareRevision(present(successor), f.context([replacement]));
  await prepare();
  f.markReady();
  assert.equal((await prepare()).ready, true);
  expireOnStatus = true;
  assert.equal((await prepare()).ready, false);
  assert.equal(statusObserved, true);
});

test("Dedicated activation refuses material that expires during workspace-node status", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  let expireOnStatus = false;
  let statusObserved = false;
  const f = await fixture("dedicated", {
    async createSetup() {
      throw new Error("The material fixture already has an enrolled node.");
    },
    async observeSetup() {
      assert.fail("The enrolled node must not start a new setup observation");
    },
    async isConnected() {
      if (expireOnStatus) {
        statusObserved = true;
        clock = deadlineWallMs;
      }
      return true;
    },
  });
  f.enroll(f.revision);
  const binding = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([binding]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([binding]));
  f.markReady();

  expireOnStatus = true;
  await assert.rejects(f.driver.activateRevision(f.revision, f.context([binding])), {
    message: "The exact repository credential runtime generation is not ready.",
  });
  assert.equal(statusObserved, true);
});

test("Dedicated retained-material loss reports only the missing session and accepts worker replacement", async () => {
  const f = await fixture("dedicated");
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const secret = present(f.secrets()[0]);
  f.objects.delete(`Secret:${secret.metadata.namespace}:${secret.metadata.name}`);
  const { files: _files, ...reference } = original;
  const retained = { ...reference, kind: "retained" } as const;
  const lost = await f.driver.prepareRevision(f.revision, f.context([retained]));
  assert.equal(lost.ready, false);
  assert.deepEqual(lost.repositoryCredentialMaterialMissing, [
    { repositoryRef: original.repositoryRef, sessionId: original.sessionId },
  ]);
  await assert.rejects(
    f.driver.activateRevision(f.revision, f.context([retained])),
    /material is unavailable/,
  );
  assert.equal(f.secrets().length, 0, "Compute must not recreate retained custody");
  // The worker owns disposal and issuance; Compute receives the replacement as new material.
  const replacement = runtimeBinding("session_worker_repaired");
  assert.equal((await f.driver.prepareRevision(f.revision, f.context([replacement]))).ready, false);
  f.markReady();
  assert.equal((await f.driver.prepareRevision(f.revision, f.context([replacement]))).ready, true);
  await f.driver.activateRevision(f.revision, f.context([replacement]));
  assert.equal(f.secrets().length, 1);
});

test("Dedicated material readiness ignores another revision, gateway role and terminating Pods", async (t) => {
  for (const mismatch of ["revision", "role", "terminating"]) {
    await t.test(mismatch, async () => {
      const f = await fixture("dedicated");
      const binding = runtimeBinding();
      await f.driver.prepareRevision(f.revision, f.context([binding]));
      f.markReady();
      const pod = workloadPod(f.requireConsumer(), f.namespace, "non-current-ready");
      if (mismatch === "revision") {
        pod.metadata.labels["openclaw.dev/revision"] = "another-revision";
      }
      if (mismatch === "role") {
        pod.metadata.labels["openclaw.dev/workload-role"] = "gateway";
      }
      if (mismatch === "terminating") {
        pod.metadata.deletionTimestamp = "2026-09-22T00:00:00.000Z";
      }
      f.setPods([pod]);
      assert.equal((await f.driver.prepareRevision(f.revision, f.context([binding]))).ready, false);
      await assert.rejects(
        f.driver.activateRevision(f.revision, f.context([binding])),
        /not ready/,
      );
    });
  }
});

test("Dedicated rotation retains material referenced by an owned template before its Pod exists", async () => {
  const f = await fixture("dedicated");
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const retainedTemplate = structuredClone(f.requireConsumer());
  retainedTemplate.metadata.name += "-retiring";
  f.save(retainedTemplate);
  const replacement = runtimeBinding("session_template_replacement");
  await f.driver.prepareRevision(f.revision, f.context([replacement]));
  f.markReady();
  f.setPods([workloadPod(f.requireConsumer(), f.namespace, "current-material")]);
  await f.driver.prepareRevision(f.revision, f.context([replacement]));
  assert.equal(
    f.secrets().length,
    2,
    "absence of an old Pod does not release its template's material",
  );
  f.objects.delete(
    `Deployment:${retainedTemplate.metadata.namespace}:${retainedTemplate.metadata.name}`,
  );
  await f.driver.prepareRevision(f.revision, f.context([replacement]));
  assert.equal(f.secrets().length, 1);
});

test("Dedicated retirement preserves the successor gateway, Agent and repository material", async () => {
  const f = await fixture("dedicated");
  const original = runtimeBinding();
  await f.driver.prepareRevision(f.revision, f.context([original]));
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([original]));
  const oldSecret = present(f.secrets()[0]).metadata.name;
  const successor = { ...f.revision, id: "revision-successor", revision: 2 };
  f.enroll(successor);
  const replacement = runtimeBinding("session_successor");
  await f.driver.prepareRevision(successor, f.context([replacement]));
  f.markReady();
  assert.equal((await f.driver.prepareRevision(successor, f.context([replacement]))).ready, true);
  await assert.rejects(
    f.driver.activateRevision(successor, f.context([replacement])),
    /gateway is not ready/,
  );
  f.markReady();
  await f.driver.activateRevision(successor, f.context([replacement]));
  // Kubernetes completes old Pod deletion while the current consumers remain running.
  f.observePods(() =>
    f.setPods(
      f
        .deployments()
        .filter(
          (deployment) =>
            deployment.spec.template.metadata.labels["openclaw.dev/revision"] ===
            present(successor).id,
        )
        .map((deployment) =>
          workloadPod(deployment, f.namespace, `${deployment.metadata.name}-current`),
        ),
    ),
  );
  await f.driver.retireRevision(f.revision);
  assert.equal(f.secrets().length, 1);
  assert.notEqual(present(f.secrets()[0]).metadata.name, oldSecret);
  assert.equal(f.deployments().length, 2);
  assert.ok(
    f
      .deployments()
      .every(
        (deployment) =>
          deployment.spec.template.metadata.labels["openclaw.dev/revision"] ===
          present(successor).id,
      ),
  );
  await f.driver.activateRevision(successor, f.context([replacement]));
});
