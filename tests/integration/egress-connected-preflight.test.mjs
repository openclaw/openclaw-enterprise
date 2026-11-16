import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import {
  activateRepositoryAgent,
  admitRepositoryAgent,
} from "../helpers/egress-custody-installed-agent.mjs";
import {
  rememberCustodyContext,
  safeConnectedFailure,
} from "../helpers/egress-connected-failure.ts";
import { createCustodyTransitions } from "../helpers/egress-supplier-custody-transitions.mjs";
import { createRunEvidence } from "../helpers/egress-installed-stack.mjs";
import { createKubernetesClient } from "../helpers/kubernetes-real.ts";
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

// Scripted log replies exercise the real observer and terminal projection, not
// supplier emission or delivery. A final read failure must retain prior evidence.
test("custody failures retain bounded last observations without supplier payloads", async (t) => {
  const marker = "PRIVATE-CUSTODY-DIAGNOSTIC-SENTINEL";
  const sandboxId = "10000000-0000-4000-8000-000000000001";
  const supervisor = {
    metadata: {
      uid: "20000000-0000-4000-8000-000000000001",
      namespace: "workspace",
      labels: {
        "openshell.ai/sandbox-id": sandboxId,
        "openshell.ai/boundary-role": "supervisor",
      },
    },
    status: {
      containerStatuses: [{ containerID: `containerd://${"a".repeat(64)}`, restartCount: 0 }],
    },
  };
  const line = {
    sandboxId,
    time: null,
    source: "sandbox",
    level: "INFO",
    target: "openshell_supervisor_network::l7::rest::credentials",
    message: "Protected response custody transition",
    fields: {
      request_id: "aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
      response_custody_event: "resolve_accepted",
      private: marker,
    },
  };
  await t.test(
    "missing resolution preserves private correlation without accepting the refusal",
    async (t) => {
      const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
      t.after(() => rm(evidence.directory, { recursive: true, force: true }));
      let lines = [];
      const custody = createCustodyTransitions({
        workspace: "workspace",
        sandbox: "sandbox",
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
        gatewayClient: { getSandboxLogs: async () => ({ lines, bufferTotal: lines.length }) },
      });
      const before = await custody.snapshot();
      lines = ["no_permit", "response_blocked"].map((event) => ({
        ...line,
        fields: { ...line.fields, response_custody_event: event },
      }));
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(before, ["resolve_refused", "no_permit", "response_blocked"]);
          } catch (error) {
            rememberCustodyContext(error, "fresh-iam-revoked", {
              outcome: "observed",
              since: "2026-01-01T00:00:00.000Z",
              raw: marker,
              gateways: [
                {
                  podUid: supervisor.metadata.uid,
                  containerId: supervisor.status.containerStatuses[0].containerID,
                  outcome: "observed",
                  total: 2,
                  events: [
                    {
                      sessionId: sandboxId,
                      at: "2026-01-01T00:00:01.000Z",
                      event: "inbound_eof",
                      raw: marker,
                    },
                    { sessionId: marker, at: "2026-01-01T00:00:01.000Z", event: "inbound_eof" },
                  ],
                },
              ],
            });
            const safe = await safeConnectedFailure(error, "turn-result", evidence.recordFailure);
            assert.equal(safe.message.includes(line.fields.request_id), false);
            assert.equal(safe.message.includes(sandboxId), false);
            assert.equal(safe.message.includes(marker), false);
            throw safe;
          }
        },
        { message: /Connected egress assertion failed.*after-custody-observation/ },
      );
      const { failure } = JSON.parse(
        await readFile(evidence.directory + "/observations.json", "utf8"),
      );
      assert.deepEqual(
        failure.custodyEvidence.events,
        ["no_permit", "response_blocked"].map((event) => ({
          requestId: line.fields.request_id,
          event,
        })),
      );
      assert.deepEqual(failure.custodyEvidence.expected, [
        "resolve_refused",
        "no_permit",
        "response_blocked",
      ]);
      assert.equal(failure.custodyEvidence.identityCheck, "matched");
      assert.equal(failure.custodyEvidence.uniqueRequest, true);
      assert.equal(failure.custodyEvidence.singleRequest, true);
      assert.equal(failure.custodyEvidence.ordered, false);
      assert.equal(failure.custodyContext.turnPhase, "fresh-iam-revoked");
      assert.equal(failure.custodyContext.sessions.requestSessionCorrelation, "unavailable");
      assert.equal(failure.custodyContext.sessions.gateways[0].events.length, 1);
      assert.equal(JSON.stringify(failure).includes(marker), false);
      // A new baseline must not reuse the prior turn's private evidence.
      const next = await custody.snapshot();
      lines = [...lines, ...Array(12).fill(line)];
      let second;
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(next, ["resolve_accepted"]);
          } catch (error) {
            throw await safeConnectedFailure(error, "next-turn", async (value) => {
              second = value;
            });
          }
        },
        { message: /Connected egress assertion failed.*after-custody-observation/ },
      );
      assert.equal(second.custodyEvidence.events.length, 9);
      assert.equal(second.custodyEvidence.truncated, true);
      assert.equal(second.custody.freshCount, 12);
      assert.equal(second.custodyEvidence.uniqueRequest, false);
      assert.equal(second.custodyContext, undefined);
    },
  );
  await t.test("multiline failure messages cannot choose the reported source frame", async () => {
    const spoofed = "egress-supplier-custody-transitions.mjs:12345:1234";
    for (const kind of ["operation", "assertion"]) {
      const custody = createCustodyTransitions({
        workspace: "workspace",
        sandbox: "sandbox",
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
        gatewayClient: {
          async getSandboxLogs() {
            const message = marker + "\n    at /untrusted/" + spoofed;
            if (kind === "assertion") {
              assert.fail(message);
            }
            throw new Error(message);
          },
        },
      });
      let failure;
      try {
        await custody.snapshot();
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      const safe = await safeConnectedFailure(failure, "turn-result");
      assert.match(safe.message, /egress-supplier-custody-transitions\.mjs:\d+:\d+/);
      assert.equal(safe.message.includes(spoofed), false);
      assert.equal(safe.message.includes(marker), false);
    }
    // A stack with no usable frame keeps the fixed fallback.
    assert.match(
      (await safeConnectedFailure(new Error(marker), "turn-result")).message,
      /\(external-operation\)/,
    );
  });

  await t.test("non-Error rejection stays unchanged", async () => {
    const custody = createCustodyTransitions({
      workspace: "workspace",
      sandbox: "sandbox",
      sandboxId,
      supervisor,
      readSupervisor: async () => {
        throw marker;
      },
      gatewayClient: {
        getSandboxLogs: async () => {
          throw new Error("unexpected log read");
        },
      },
    });
    await assert.rejects(custody.snapshot(), (error) => error === marker);
  });
  await t.test("diagnostic write failure does not prevent cleanup recording", async () => {
    const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
    t.after(() => rm(evidence.directory, { recursive: true, force: true }));
    // A failed atomic write must not replace the observer's original failure;
    // the next cleanup checkpoint still persists that failure from memory.
    await mkdir(evidence.directory + "/observations.pending.json");
    const custody = createCustodyTransitions({
      workspace: "workspace",
      sandbox: "sandbox",
      sandboxId,
      supervisor,
      readSupervisor: async () => {
        throw new Error(marker);
      },
      gatewayClient: {
        getSandboxLogs: async () => {
          throw new Error("unexpected log read");
        },
      },
    });
    await assert.rejects(
      async () => {
        try {
          await custody.snapshot();
        } catch (error) {
          const safe = await safeConnectedFailure(error, "turn-result", evidence.recordFailure);
          assert.equal(safe.message.includes(marker), false);
          assert.equal(safe.cause, undefined);
          throw safe;
        }
      },
      {
        message:
          /Connected egress operation failed at turn-result \/ before-custody-supervisor-get/,
      },
    );
    await rm(evidence.directory + "/observations.pending.json", { recursive: true });
    await evidence.checkpoint("cleanup");
    const { failure } = JSON.parse(
      await readFile(evidence.directory + "/observations.json", "utf8"),
    );
    assert.equal(failure.operation, "before-custody-supervisor-get");
    assert.equal(failure.custody.readAttempts, 0);
    assert.equal(failure.custody.lastRead, "unobserved");
  });
  await t.test(
    "continuation retains the acknowledged prefix when its first read fails",
    async () => {
      let reads = 0;
      const custody = createCustodyTransitions({
        workspace: "workspace",
        sandbox: "sandbox",
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
        gatewayClient: {
          async getSandboxLogs() {
            reads++;
            if (reads === 1) {
              return { lines: [], bufferTotal: 0 };
            }
            if (reads === 2) {
              return {
                lines: [
                  line,
                  {
                    ...line,
                    fields: { ...line.fields, response_custody_event: "permit_accepted" },
                  },
                ],
                bufferTotal: 2,
              };
            }
            throw new Error(marker);
          },
        },
      });
      const before = await custody.snapshot();
      await custody.expectAfter(before, ["resolve_accepted", "permit_accepted"]);
      let recorded;
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(before, [
              "resolve_accepted",
              "permit_accepted",
              "response_released",
            ]);
          } catch (error) {
            throw await safeConnectedFailure(error, "turn-result", async (value) => {
              recorded = value;
            });
          }
        },
        { message: /Connected egress operation failed at turn-result \/ after-custody-log-read/ },
      );
      assert.equal(recorded.custody.lastRead, "error");
      assert.equal(recorded.custody.ring, "valid");
      assert.equal(recorded.custody.freshCount, 2);
      assert.deepEqual(recorded.custody.labels, ["resolve_accepted", "permit_accepted"]);
      assert.equal(recorded.custody.sequence, "partial");
      assert.equal(JSON.stringify(recorded).includes(marker), false);
    },
  );
  for (const kind of ["empty", "partial", "ring", "malformed"]) {
    await t.test(kind, async () => {
      let reads = 0;
      const custody = createCustodyTransitions(
        {
          workspace: "workspace",
          sandbox: "sandbox",
          sandboxId,
          supervisor,
          readSupervisor: async () => supervisor,
          gatewayClient: {
            async getSandboxLogs(_request, signal) {
              reads++;
              if (reads === 1) {
                return { lines: [], bufferTotal: 0 };
              }
              if (reads === 2) {
                if (kind === "ring") {
                  return { lines: [line], bufferTotal: 2001 };
                }
                if (kind === "malformed") {
                  return {
                    lines: [
                      { ...line, fields: { ...line.fields, response_custody_event: marker } },
                    ],
                    bufferTotal: 1,
                  };
                }
                return {
                  lines: kind === "partial" ? [line] : [],
                  bufferTotal: kind === "partial" ? 1 : 0,
                };
              }
              try {
                await delay(10000, undefined, { signal });
              } catch {
                throw signal.reason;
              }
              throw new Error("deadline did not abort the scripted read");
            },
          },
        },
        { deliveryTimeoutMs: 1000, pollIntervalMs: 1 },
      );
      const before = await custody.snapshot();
      const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
      t.after(() => rm(evidence.directory, { recursive: true, force: true }));
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(before, [
              "resolve_accepted",
              "permit_accepted",
              "response_released",
            ]);
          } catch (error) {
            const safe = await safeConnectedFailure(error, "turn-result", evidence.recordFailure);
            assert.equal(safe.message.includes(line.fields.request_id), false);
            assert.equal(safe.message.includes(marker), false);
            assert.equal(safe.cause, undefined);
            throw safe;
          }
        },
        {
          message:
            /Connected egress (?:assertion|operation) failed at turn-result \/ after-custody-log-read/,
        },
      );
      const { failure: recorded } = JSON.parse(
        await readFile(evidence.directory + "/observations.json", "utf8"),
      );
      await evidence.checkpoint("cleanup");
      assert.deepEqual(
        JSON.parse(await readFile(evidence.directory + "/observations.json", "utf8")).failure,
        recorded,
      );
      assert.equal(recorded.custody.successfulReads, 2);
      assert.equal(recorded.custody.readAttempts, kind === "empty" || kind === "partial" ? 3 : 2);
      assert.equal(JSON.stringify(recorded).includes(marker), false);
      // Validated correlation belongs only to the private evidence, never the
      // terminal error or the counter-only custody summary.
      assert.equal(JSON.stringify(recorded.custody).includes(line.fields.request_id), false);
      assert.equal(
        JSON.stringify(recorded.custodyEvidence ?? {}).includes(line.fields.request_id),
        kind === "partial",
      );
      if (kind === "empty" || kind === "partial") {
        assert.equal(recorded.custody.lastRead, "deadline");
        assert.equal(recorded.custody.ring, "valid");
        assert.equal(recorded.custody.lineCount, kind === "partial" ? 1 : 0);
        assert.equal(recorded.custody.sequence, kind === "partial" ? "partial" : "none");
        assert.deepEqual(recorded.custody.labels, kind === "partial" ? ["resolve_accepted"] : []);
      } else {
        assert.equal(recorded.custody.lastRead, "returned");
        assert.equal(recorded.custody.ring, kind === "ring" ? "incomplete" : "invalid-transition");
        assert.equal(recorded.custody.sequence, "unobserved");
        assert.equal(recorded.custody.bufferTotal, kind === "ring" ? null : 1);
      }
    });
  }
});
