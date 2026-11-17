import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import {
  activateRepositoryAgent,
  admitRepositoryAgent,
} from "../helpers/egress-custody-installed-agent.mjs";
import { createRunEvidence } from "../helpers/egress-installed-stack.mjs";
import { createKubernetesClient } from "../helpers/kubernetes-real.ts";
import { verifyCustodyFailures } from "./egress-connected-custody-observation-cases.ts";
import { registerConnectedEgressGatewayPreflightCases } from "./egress-connected-gateway-preflight-cases.ts";
import { registerConnectedEgressInputPreflightCases } from "./egress-connected-input-preflight-cases.ts";

registerConnectedEgressInputPreflightCases();

function custodyControllerPods() {
  const image = "controller@sha256:" + "a".repeat(64);
  const namespace = "owned-controller";
  const pod = (component, name = component) => ({
    metadata: {
      uid: name + "-uid",
      name,
      namespace,
      labels: { "app.kubernetes.io/component": component },
    },
    spec: { containers: [{ name: component, image }] },
    status: { conditions: [{ type: "Ready", status: "True" }] },
  });
  return {
    pod,
    input: {
      controllerNamespace: namespace,
      controllerSelector: "owned=yes",
      images: { controller: image },
    },
  };
}

test("repository admission inspects the current API and worker after an authority restart", async () => {
  const { pod, input } = custodyControllerPods();
  const namespace = input.controllerNamespace;
  const worker = pod("worker");
  const stack = { controllerPods: [pod("api", "api-retired"), worker] };
  const api = pod("api", "api-replacement");
  let items = [api, worker];
  const inspected = [];
  const provider = { businessOrigin: "https://issuer.example.test" };
  const kubectl = (operation, ...args) => {
    if (operation === "get") {
      assert.deepEqual(args, [
        "pods",
        "--namespace",
        namespace,
        "--selector",
        "owned=yes",
        "-o",
        "json",
      ]);
      return JSON.stringify({ items });
    }
    const [flag, ns, name] = args;
    assert.deepEqual([operation, flag, ns], ["exec", "-n", namespace]);
    assert.ok(
      items.some(({ metadata }) => metadata.name === name),
      name + " NotFound",
    );
    inspected.push(name);
    return provider.businessOrigin;
  };
  // Stop at the first mutation. A stale snapshot, or a partial inspection, cannot pass this boundary.
  const stop = new Error("reached enrollment");
  const create = (kind) => {
    assert.equal(kind, "configurations");
    assert.deepEqual(inspected.splice(0), ["api-replacement", "worker"]);
    throw stop;
  };
  const admit = () =>
    admitRepositoryAgent(
      { input, f: { kubectl }, controller: {} },
      stack,
      {},
      { provider, create },
    );
  await assert.rejects(admit, (error) => error === stop);

  items = [api];
  await assert.rejects(admit, /worker Pod/);
  items = [api, worker];
  worker.metadata.deletionTimestamp = "2026-10-15T00:00:00Z";
  await assert.rejects(admit, /terminating/);
  delete worker.metadata.deletionTimestamp;
  worker.spec.containers[0].image = "wrong-controller";
  await assert.rejects(admit, /candidate controller image/);
  assert.deepEqual(inspected, []);
});

test("failed custody deployment preserves worker event order across a reused attempt budget", async (t) => {
  const { pod, input } = custodyControllerPods();
  const worker = pod("worker");
  const container = {
    name: "worker",
    containerID: "containerd://fixture",
    restartCount: 0,
    state: { running: {} },
  };
  worker.status.containerStatuses = [container];
  const items = [pod("api"), worker];
  const [namespaceId, agentId, id] = ["ns_fixture", "agent_fixture", "rev_fixture"];
  const revision = { namespaceId, agentId, id };
  const work = {
    namespaceId,
    agentId,
    revisionId: id,
    attempt: 5,
    operation: "agent_revision.reconcile",
    workId: "agent_revision:" + id + ":reconcile",
  };
  const sentinel = "PRIVATE-DIAGNOSTIC-" + randomUUID();
  const lines = [];
  const destination = { write: (line) => lines.push(line) };
  const emit = createWorkerLogEmitter(
    createOccLogger({ component: "occ-worker", level: "info", destination }),
  );
  // Pending convergence does not spend an attempt. Pass 6 has no preparation record.
  const step = "gateway_deployment";
  const errorClass = "KubernetesApiError";
  const status = 503;
  emit({
    ...work,
    event: "worker.compute-prepare-failed",
    step,
    errorClass,
    status,
    message: sentinel,
  });
  const completions = [
    {
      outcome: "pending",
      code: "KUBERNETES_API_UNAVAILABLE",
      cause: "unavailable",
      deployPasses: 5,
    },
    {
      outcome: "retry",
      code: "DEPENDENCY_UNAVAILABLE",
      cause: "DependencyUnavailableError",
      deployPasses: 6,
    },
  ];
  for (const completion of completions) {
    emit({ ...work, event: "worker.completed", result: completion.outcome, ...completion });
  }
  const log = lines.join("");
  assert.ok(log.includes(sentinel), "private sentinel must actually reach the collector");

  // Use the actual installed response decoder, deploy failure, private ledger and public diagnostic.
  const diagnostics = [];
  const test = { signal: t.signal, diagnostic: (line) => diagnostics.push(line) };
  const controller = { namespaceId, apiOrigin: "http://fixture.invalid" };
  const evidence = await createRunEvidence(test, { input, controller }, {});
  t.after(() => rm(evidence.directory, { recursive: true, force: true }));
  const calls = [];
  t.mock.method(globalThis, "fetch", (url, { method }) => {
    calls.push(method + " " + url.pathname);
    const deploy = method === "POST";
    const data = deploy ? revision : { status: "failed" };
    return Response.json({ data, meta: { requestId: "fixture" } }, { status: deploy ? 202 : 200 });
  });
  const stack = {
    namespace: { id: namespaceId },
    controllerPods: structuredClone(items),
    get pool() {
      throw new Error("reporting an already failed deployment must never access the database");
    },
  };
  const admitted = { agent: { id: agentId }, route: "/agents/" + agentId };
  for (const variant of ["observed", "wrong revision", "read failed", "worker restarted"]) {
    const kubectl = t.mock.fn(async (op) => {
      if (op === "get") {
        return JSON.stringify({ items });
      }
      if (variant === "read failed") {
        throw Error(sentinel);
      }
      if (variant === "worker restarted") {
        container.restartCount++;
      }
      const wrong = log.replaceAll(id, "other-revision");
      return variant === "wrong revision" ? wrong : wrong + log;
    });
    const f = createKubernetesClient({ selection: {}, kubectl });
    await assert.rejects(
      activateRepositoryAgent({ input, f }, stack, evidence, {}, admitted),
      /protected deployment failed; no runtime acceptance/,
    );
    const suffix = admitted.route;
    assert.deepEqual(calls.splice(0), [
      "POST " + suffix + "/deploy",
      "GET " + suffix + "/deployments/" + id,
    ]);
    const ledger = await readFile(evidence.directory + "/observations.json", "utf8");
    const [returned, failure] = JSON.parse(ledger).phases.slice(-2);
    assert.equal(returned.revisionId, id, "record the 202 revision before waiting");
    assert.equal(failure.phase, "failed-deployment-observation");
    assert.ok(!ledger.includes(sentinel) && !diagnostics.join().includes(sentinel));
    assert.ok(!diagnostics.join().includes(id), "returned revision is private");
    if (variant !== "observed") {
      assert.equal(failure.workerEvents, "unavailable", variant);
      continue;
    }
    assert.deepEqual(
      kubectl.mock.calls.map((c) => c.arguments[0]),
      ["get", "logs", "get"],
    );
    const budgetAttempt = 5;
    assert.deepEqual(failure.workerEvents, [
      { event: "preparation", budgetAttempt, step, errorClass, status, cause: "other" },
      ...completions.map((fields) => ({ event: "completion", budgetAttempt, ...fields })),
    ]);
    assert.ok(
      diagnostics.at(-1).includes(JSON.stringify(failure.workerEvents)),
      "public safe projection",
    );
  }
});

registerConnectedEgressGatewayPreflightCases();

test(
  "custody failures retain bounded last observations without supplier payloads",
  verifyCustodyFailures,
);
