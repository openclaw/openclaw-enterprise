import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { createOpenShellGitInstallation } from "./openshell-git-installation.mjs";

interface RuntimePod {
  metadata: {
    uid: string;
    namespace: string;
    ownerReferences: { kind: string; name: string; uid: string }[];
  };
  status: {
    conditions: { type: string; status: string }[];
    containerStatuses: {
      name: string;
      containerID: string;
      imageID: string;
      restartCount: number;
      state: { running?: { startedAt: string } };
    }[];
  };
}

export async function observeUntil<T>(
  label: string,
  signal: AbortSignal,
  observe: () => Promise<T | undefined>,
  timeout = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await observe();
    if (result !== undefined) {
      return result;
    }
    await delay(1000, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type GitInstallation = Awaited<ReturnType<typeof createOpenShellGitInstallation>>;

export async function deployFiniteAgent(t: TestContext, fixture: GitInstallation) {
  const {
    request,
    namespace,
    modelSource,
    repositoryRef,
    workspace,
    gatewayClient,
    checkpoint: evidence,
  } = fixture;
  const base = `/namespaces/${namespace.id}`;
  const suffix = randomUUID();
  const model = process.env.OCC_TEST_OPENAI_MODEL;
  assert.ok(model, "Select the real CI model before provisioning the Agent");
  const configuration = await request("POST", `${base}/configurations`, {
    kind: "agent",
    values: createHarnessConfiguration("codex", model),
  });
  const agent = await request("POST", `${base}/agents`, {
    name: `git-retention-${suffix}`,
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: modelSource.id },
    credentialSources: [{ sourceId: modelSource.id }],
    repositoryBindings: [{ repositoryRef, profile: "github-repository" }],
  });
  const path = `${base}/agents/${agent.id}`;
  const role = await request("POST", `${base}/iam/roles`, {
    name: `git-retention-model-${suffix}`,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  await request("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: modelSource.id,
  });
  const transport = await request("POST", `${path}/runtime-credentials`, {});
  assert.equal(transport.transportConfigured, true);

  // The selected-repository profile grants finite access. Use its actual
  // admission deadline; neither the application clock nor queue is patched.
  const admissionStartedAt = Date.now();
  const revision = await request("POST", `${path}/deploy`);
  const admissionReturnedAt = Date.now();
  assert.equal(revision.harness.id, "codex");
  assert.equal(revision.harnessAuth.method, "credential_source");
  assert.equal(revision.harnessAuth.sourceId, modelSource.id);
  const deadlineWallMs = revision.repositoryCredentials?.deadlineWallMs;
  assert.ok(Number.isSafeInteger(deadlineWallMs));
  assert.ok(deadlineWallMs >= admissionStartedAt + 600_000);
  assert.ok(deadlineWallMs <= admissionReturnedAt + 600_000);
  await evidence("finite-git-grant", { revisionId: revision.id, deadlineWallMs });
  await observeUntil(
    "real Agent startup",
    t.signal,
    async () => {
      const [current, deployment] = await Promise.all([
        request("GET", path),
        request("GET", `${path}/deployments/${revision.id}`),
      ]);
      assert.notEqual(deployment.status, "failed", "the original deployment failed");
      return current.activeRevisionId === revision.id && deployment.status === "succeeded"
        ? current
        : undefined;
    },
    10 * 60_000,
  );

  const selector = `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=agent`;
  const readExecution = async () => {
    const current = await request("GET", path);
    assert.equal(current.activeRevisionId, revision.id, "Agent revision changed");
    const pods = JSON.parse(
      await fixture.kube(["get", "pods", "-A", "-l", selector, "-o", "json"]),
    ) as { items: RuntimePod[] };
    assert.equal(pods.items.length, 1, "expected the single original Harness Pod");
    const pod = pods.items[0];
    assert.ok(pod);
    assert.ok(
      pod.status.conditions.some(({ type, status }) => type === "Ready" && status === "True"),
      "the original Harness Pod must remain ready",
    );
    const owner = pod.metadata.ownerReferences.find(({ kind }) => kind === "Sandbox");
    assert.ok(owner?.name && owner.uid, "the stock supplier must own the Harness Pod");
    const resource = JSON.parse(
      await fixture.kube([
        "get",
        "sandboxes.agents.x-k8s.io",
        owner.name,
        "-n",
        pod.metadata.namespace,
        "-o",
        "json",
      ]),
    );
    assert.equal(resource.metadata.uid, owner.uid);
    const sandbox = await gatewayClient.getSandbox({ workspace, name: owner.name }, t.signal);
    assert.ok(sandbox?.id && sandbox.mainProcessInstanceId);
    assert.equal(sandbox.annotations["openclaw.dev/revision-id"], revision.id);
    const containers = pod.status.containerStatuses.map((container) => {
      assert.ok(container.containerID && container.imageID && container.state.running?.startedAt);
      assert.match(container.imageID, /sha256:[a-f0-9]{64}/);
      return {
        name: container.name,
        id: container.containerID,
        imageId: container.imageID,
        startedAt: container.state.running.startedAt,
        restartCount: container.restartCount,
      };
    });
    return {
      sandbox,
      identity: {
        revisionId: current.activeRevisionId,
        sandboxId: sandbox.id,
        sandboxName: sandbox.name,
        sandboxUid: owner.uid,
        podUid: pod.metadata.uid,
        containers,
        mainProcessInstanceId: sandbox.mainProcessInstanceId,
        mainProcessStartedAt: sandbox.mainProcessStartedAt,
      },
    };
  };
  const original = await readExecution();
  await evidence("initial-runtime", original.identity);
  const target = {
    sandboxName: original.sandbox.name,
    sandboxId: original.sandbox.id,
  };
  const supervisor = await fixture.verifySupervisorImage(target);
  assert.equal(supervisor.workloadPodUid, original.identity.podUid);
  assert.equal(supervisor.sandboxId, original.identity.sandboxId);
  await evidence("installed-supervisor", supervisor);
  return {
    agent,
    revision,
    configuration,
    path,
    suffix,
    deadlineWallMs,
    readExecution,
    original,
    target,
    supervisor,
  };
}
