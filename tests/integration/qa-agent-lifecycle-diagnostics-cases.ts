import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

type AgentFixture = { id: string; namespaceId: string; stopped?: boolean };

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function asString(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function parseJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  return parsed;
}

export function registerQaAgentLifecycleDiagnosticsCases(): void {
  // Finding 2106: six QA cells failed "Timed out: Agent deployment" at 600 s with no status.
  test("a QA Agent deployment timeout names its last status, attempt and Pods", async (t) => {
    const { deployQaAgentAndWait } = await import("../helpers/qa-installation.mjs");
    const { createQaReport } = await import("../helpers/qa-report.mjs");
    const { registerQaSecret } = await import("../helpers/qa-secrets.mjs");
    // An invented 48-character registered value. Runtime text that OCC shortened could keep
    // part of it, which whole-value redaction cannot match.
    const privateValue = "qa-deploy-fixture-private-0123456789abcdefghijkl";
    assert.equal(privateValue.length, 48);
    registerQaSecret(privateValue);
    const base = "/namespaces/namespace-1/agents/agent-1";
    function fixture({
      runtime,
      finalStatus = "running",
    }: { runtime?: Record<string, unknown>; finalStatus?: "running" | "succeeded" } = {}) {
      let clock = 0;
      const calls: string[] = [];
      const records: { name: string; value: unknown }[] = [];
      const lastAttempt = {
        at: "2026-10-19T19:40:00.000Z",
        code: "RUNTIME_NOT_READY",
        message: "The Agent runtime is not ready yet.",
      };
      const f = {
        async api(method: string, path: string) {
          calls.push(`${method} ${path}`);
          if (method === "POST" && path === `${base}/deploy`) {
            return { id: "rev-1" };
          }
          if (path === `${base}/deployments/rev-1`) {
            clock += 100;
            // Queued for the first observations, then running until the wait ends.
            const status = clock <= 200 ? "queued" : finalStatus;
            return {
              status,
              progress: status === "succeeded" ? null : { lastAttempt, nextAttemptAt: null },
              error: null,
              cleanup: null,
              warnings: [],
            };
          }
          if (path === `${base}/deployments/rev-1/runtime`) {
            if (!runtime) {
              throw new Error(`OCC GET ${path}: HTTP 404`);
            }
            return runtime;
          }
          throw new Error(`unexpected ${method} ${path}`);
        },
        async record(name: string, value: unknown) {
          records.push({ name, value });
        },
      };
      const agent = { id: "agent-1", namespaceId: "namespace-1", preset: "Codex" };
      return {
        f,
        agent,
        calls,
        records,
        options: { timeout: 1_000, interval: 0, now: () => clock },
      };
    }

    const runtime = {
      revisionId: "rev-1",
      observedAt: "2026-10-19T19:46:00.000Z",
      sources: [],
      pods: [
        {
          role: "gateway",
          cluster: "control",
          name: "gateway-0",
          uid: "uid-1",
          phase: "Pending",
          ready: false,
          createdAt: "2026-10-19T19:36:10.000Z",
          containers: [
            {
              name: "gateway",
              state: "waiting",
              reason: "ContainerCreating",
              ready: false,
              restartCount: 0,
              startedAt: null,
              lastTermination: null,
            },
            {
              name: "setup",
              state: "terminated",
              // Cut at the API's 128 characters, inside the registered value.
              reason: ("r".repeat(100) + privateValue).slice(0, 128),
              ready: false,
              restartCount: 1,
              startedAt: null,
              lastTermination: null,
            },
          ],
          // Newest first, as the API lists them.
          events: [
            {
              type: "Warning",
              container: null,
              reason: "Unhealthy",
              // Probe output can reach an event message; the value starts at character 176.
              message: "Readiness probe failed: " + "x".repeat(152) + privateValue,
              count: 4,
              lastObservedAt: "2026-10-19T19:45:00Z",
            },
            {
              type: "Normal",
              container: null,
              reason: "Pulled",
              message: "Container image already present",
              count: 1,
              lastObservedAt: "2026-10-19T19:44:00Z",
            },
            {
              type: "Warning",
              container: null,
              // A long reason from a legacy Event producer, cut inside the registered value.
              reason: ("e".repeat(100) + privateValue).slice(0, 128),
              message: "Back-off pulling image",
              count: 2,
              lastObservedAt: "2026-10-19T19:43:00Z",
            },
            {
              type: "Warning",
              container: null,
              reason: "FailedScheduling",
              message: "0/1 nodes are available",
              count: 3,
              lastObservedAt: "2026-10-19T19:38:00Z",
            },
            {
              type: "Warning",
              container: null,
              reason: "FailedCreatePodSandBox",
              message: "Failed to create pod sandbox",
              count: 1,
              lastObservedAt: "2026-10-19T19:37:00Z",
            },
          ],
        },
      ],
    };
    // Through the real report stage, which redacts before it saves the reason.
    const directory = await temporaryDirectory(t, "qa-deploy-timeout-");
    const reportPath = join(directory, "matrix.json");
    const report = createQaReport(reportPath, {});
    const parent = {
      test: async (_name: string, _options: { timeout: number }, run: () => Promise<void>) => run(),
    };
    const timedOut = fixture({ runtime });
    await assert.rejects(
      report.stage(parent, "compose/Codex", "deploy", () =>
        deployQaAgentAndWait(timedOut.f, timedOut.agent, timedOut.options),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // No runtime text that could hold part of a secret reaches the error.
        assert.doesNotMatch(error.message, /qa-deploy-fixture|Readiness probe failed|rrrr|eeee/);
        const [observation, pods] = error.message
          .replace(/^Timed out: Agent deployment; last observation: /, "")
          .split("; runtime: ");
        assert.deepEqual(parseJson(asString(observation)), {
          status: "running",
          // Running since the third observation (clock 300) until the last one (clock 1,000).
          statusForMs: 700,
          lastAttempt: {
            at: "2026-10-19T19:40:00.000Z",
            code: "RUNTIME_NOT_READY",
            message: "The Agent runtime is not ready yet.",
          },
          nextAttemptAt: null,
          error: null,
        });
        assert.deepEqual(parseJson(asString(pods)), {
          pods: [
            {
              role: "gateway",
              phase: "Pending",
              ready: false,
              containers: [
                { name: "gateway", state: "waiting", reason: "ContainerCreating", restartCount: 0 },
                { name: "setup", state: "terminated", reason: "other", restartCount: 1 },
              ],
              // The three newest Warnings, by familiar reason and count only.
              warnings: [
                { reason: "Unhealthy", count: 4 },
                { reason: "other", count: 2 },
                { reason: "FailedScheduling", count: 3 },
              ],
            },
          ],
        });
        return true;
      },
    );
    assert.equal(timedOut.calls.at(-1), `GET ${base}/deployments/rev-1/runtime`);
    assert.deepEqual(timedOut.records, []);
    const saved = await readFile(reportPath, "utf8");
    const [outcomeValue] = asArray(asRecord(parseJson(saved)).outcomes);
    const outcome = asRecord(outcomeValue);
    assert.equal(outcome.outcome, "failed");
    assert.match(asString(outcome.reason), /^Timed out: Agent deployment; last observation: /);
    assert.doesNotMatch(saved, new RegExp(privateValue.slice(0, 8)));

    // Runtime details are best effort: the timeout keeps its status when they are unavailable.
    const noRuntime = fixture();
    await assert.rejects(
      deployQaAgentAndWait(noRuntime.f, noRuntime.agent, noRuntime.options),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith(
          'Timed out: Agent deployment; last observation: {"status":"running","statusForMs":700,',
        ) &&
        error.message.endsWith(
          `; runtime unavailable (OCC GET ${base}/deployments/rev-1/runtime: HTTP 404)`,
        ),
    );

    // A deployment that succeeds is recorded and returned, with no runtime request.
    const succeeded = fixture({ finalStatus: "succeeded" });
    const result = asRecord(
      await deployQaAgentAndWait(succeeded.f, succeeded.agent, succeeded.options),
    );
    assert.equal(asRecord(result.status).status, "succeeded");
    assert.deepEqual(result.revision, { id: "rev-1" });
    assert.deepEqual(
      succeeded.records.map(({ name }) => name),
      ["Codex-agent-1-rev-1-deployment"],
    );
    assert.equal(
      succeeded.calls.some((call) => call.endsWith("/runtime")),
      false,
    );
  });

  test("a QA Agent stop timeout names the remaining Pods and keeps redacted platform logs", async () => {
    const { registerQaSecret } = await import("../helpers/qa-secrets.mjs");
    const { stopQaAgent, describeStopObservation } = await import("../helpers/qa-repository.mjs");
    registerQaSecret("stop-fixture-service-key");
    const agent: AgentFixture = { id: "agent-1", namespaceId: "namespace-1" };
    const pod = {
      metadata: {
        namespace: "oce-agent-1",
        name: "agent-1-gateway-0",
        deletionTimestamp: "2026-10-11T01:37:00Z",
        finalizers: ["openclaw.dev/runtime"],
        labels: { "openclaw.dev/agent": "agent-1", "openclaw.dev/workload-role": "gateway" },
      },
      spec: { containers: [{ env: [{ name: "GATEWAY_PASSWORD", value: "spec-private-value" }] }] },
      status: { phase: "Running" },
    };
    // A remaining Agent Pod whose log is not read, in the platform Namespace for the
    // Events de-duplication.
    const agentPod = {
      metadata: {
        namespace: "oce-system",
        name: "agent-1-runtime-0",
        labels: { "openclaw.dev/agent": "agent-1", "openclaw.dev/workload-role": "agent" },
      },
      status: { phase: "Running" },
    };
    // A rollout: two worker Pods, one restarted, and an API Pod.
    const platformPods = [
      {
        metadata: { name: "worker-a", labels: { "app.kubernetes.io/component": "worker" } },
        spec: { containers: [{ env: [{ name: "DATABASE_URL", value: "spec-private-value" }] }] },
        status: {
          phase: "Running",
          startTime: "2026-10-11T01:30:00Z",
          containerStatuses: [
            {
              name: "worker",
              restartCount: 1,
              lastState: {
                terminated: { reason: "Error", exitCode: 1, finishedAt: "2026-10-11T01:33:00Z" },
              },
            },
          ],
        },
      },
      {
        metadata: { name: "worker-b", labels: { "app.kubernetes.io/component": "worker" } },
        status: { phase: "Running", containerStatuses: [{ name: "worker", restartCount: 0 }] },
      },
      { metadata: { name: "api-a", labels: { "app.kubernetes.io/component": "api" } }, status: {} },
    ];
    const event = (time: string | undefined, name: string, message: string) => ({
      lastTimestamp: time,
      type: "Normal",
      reason: "Killing",
      involvedObject: { kind: "Pod", name },
      message,
    });
    const calls: string[][] = [];
    const records = new Map<string, unknown>();
    // Each GET advances the fake clock past the 10 ms timeout: one read, then the timeout.
    let clock = 0;
    const timing = { timeout: 10, interval: 0, now: () => clock };
    const f = {
      controlPlane: "kubernetes",
      env: {
        PRIVATE_INPUT: "launcher-private-value",
        OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
        OCC_DEVELOPMENT_COMPOSE_PROJECT: "occ-dev-qa-k-ab12cd34",
        OCC_DEVELOPMENT_KUBERNETES_CLUSTER: "occ-dev-qa-k-ab12cd34",
        OCC_DEVELOPMENT_STATE_DIRECTORY: "/runner/tmp/occ-dev-qa-k-ab12cd34-x/state",
        OCC_DEVELOPMENT_K3S_IMAGE: "docker.io/rancher/k3s:v1.35.9-k3s1",
      },
      state: { platformNamespace: "oce-system" },
      async api(method: string, path: string) {
        calls.push(["api", method, path]);
        if (method !== "GET") {
          return undefined;
        }
        clock += 1_000;
        assert.ok(clock < 100_000, "the stop wait follows the fake clock");
        return { desiredRuntimeState: "stopped", activeRevisionId: "revision-1" };
      },
      async kubectl(...args: string[]) {
        calls.push(["kubectl", ...args]);
        if (args[0] === "get") {
          return JSON.stringify({ items: [pod, agentPod] });
        }
        if (args.includes("deployment/openclaw-enterprise-worker")) {
          throw new Error("kubectl failed (exit 1); stderr: launcher-private-value unreachable");
        }
        const [verb, target] = args.slice(2);
        if (verb === "get" && target === "pods") {
          return JSON.stringify({ items: platformPods });
        }
        if (verb === "get" && target === "events") {
          return JSON.stringify({
            items: [
              event(
                "2026-10-11T01:36:30Z",
                "agent-1-gateway-0",
                "Stopping; launcher-private-value",
              ),
              event(undefined, "undated", "no time"),
              event("2026-10-11T01:30:00Z", "worker-a", "Started container worker"),
            ],
          });
        }
        if (args.includes("--previous")) {
          throw new Error("kubectl failed (exit 1); stderr: previous launcher-private-value gone");
        }
        if (target === "worker-a" || target === "worker-b") {
          return `2026-10-11T01:36:00Z ${target} worker.completed\n`;
        }
        if (target === "agent-1-gateway-0") {
          return (
            "2026-10-11T01:32:40Z draining active work before stop with timeout 315000ms: 1 active chat run(s)\n" +
            "2026-10-11T01:32:41Z assistant reply QA_NATIVE_conversation-text: drain the shutdown queue\n"
          );
        }
        return (
          "2026-10-11T01:36:00Z kubernetes compute: stop requested for agent-1\n" +
          "2026-10-11T01:36:01Z authenticated with stop-fixture-service-key\n" +
          "2026-10-11T01:36:02Z Authorization: Bearer abcdefghijklmnop\n" +
          "2026-10-11T01:36:03Z cluster occ-dev-qa-k-ab12cd34 state /runner/tmp/occ-dev-qa-k-ab12cd34-x/state image docker.io/rancher/k3s:v1.35.9-k3s1\n"
        );
      },
      async record(name: string, value: unknown) {
        records.set(name, value);
        return `${this.controlPlane}-${name}.json`;
      },
    };
    await assert.rejects(stopQaAgent(f, agent, timing), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Timed out: ordinary Agent stop removes every runtime Pod; /);
      const observation = parseJson(
        asString(/; last observation: (\{.*\}); API and worker logs: /.exec(error.message)?.[1]),
      );
      assert.deepEqual(observation, {
        desiredRuntimeState: "stopped",
        activeRevisionId: "revision-1",
        pods: [
          {
            namespace: "oce-agent-1",
            name: "agent-1-gateway-0",
            phase: "Running",
            deletionTimestamp: "2026-10-11T01:37:00Z",
            finalizers: ["openclaw.dev/runtime"],
          },
          {
            namespace: "oce-system",
            name: "agent-1-runtime-0",
            phase: "Running",
            deletionTimestamp: null,
            finalizers: [],
          },
        ],
      });
      assert.match(
        error.message,
        /API and worker logs: kubernetes-agent-1-stop-timeout-platform-logs\.json$/,
      );
      assert.doesNotMatch(error.message, /spec-private-value/);
      return true;
    });
    assert.equal(agent.stopped, undefined);
    assert.deepEqual(calls[0], ["api", "POST", "/namespaces/namespace-1/agents/agent-1/stop"]);
    const logCall = calls.find((call) => call.includes("deployment/openclaw-enterprise-api"));
    assert.ok(logCall);
    assert.deepEqual(logCall.slice(1, 7), [
      "-n",
      "oce-system",
      "logs",
      "deployment/openclaw-enterprise-api",
      "--container",
      "api",
    ]);
    assert.ok(
      logCall.some((argument) => /^--tail=\d+$/.test(argument)),
      "the log tail is bounded",
    );
    const logs = asRecord(asRecord(records.get("agent-1-stop-timeout-platform-logs")).logs);
    const apiLogs = asArray(logs.api);
    assert.equal(apiLogs[0], "2026-10-11T01:36:00Z kubernetes compute: stop requested for agent-1");
    assert.doesNotMatch(
      JSON.stringify(logs),
      /stop-fixture-service-key|abcdefghijklmnop|launcher-private-value/,
    );
    assert.equal(apiLogs.length, 4);
    // Fixed launcher settings stay readable.
    assert.equal(
      apiLogs[3],
      "2026-10-11T01:36:03Z cluster occ-dev-qa-k-ab12cd34 state /runner/tmp/occ-dev-qa-k-ab12cd34-x/state image docker.io/rancher/k3s:v1.35.9-k3s1",
    );
    assert.match(asArray(asRecord(logs.worker).unavailable).join("\n"), /unreachable/);
    assert.equal(describeStopObservation(undefined), "none");
    // During a rollout every worker Pod by name; only a restarted one's previous
    // container, whose failed read is kept, redacted.
    assert.deepEqual(logs.workerPods, {
      "worker-a": ["2026-10-11T01:36:00Z worker-a worker.completed"],
      "worker-b": ["2026-10-11T01:36:00Z worker-b worker.completed"],
    });
    assert.deepEqual(
      calls.filter((call) => call.includes("--previous")).map((call) => call.slice(1)),
      [
        [
          "-n",
          "oce-system",
          "logs",
          "worker-a",
          "--container",
          "worker",
          "--previous",
          "--timestamps",
          "--tail=200",
          "--request-timeout=30s",
        ],
      ],
    );
    assert.match(
      asArray(asRecord(asRecord(logs.workerPrevious)["worker-a"]).unavailable).join("\n"),
      /gone/,
    );
    assert.deepEqual(asArray(logs.platformPods)[0], {
      name: "worker-a",
      component: "worker",
      phase: "Running",
      startTime: "2026-10-11T01:30:00Z",
      deletionTimestamp: null,
      containers: [
        {
          name: "worker",
          restartCount: 1,
          lastTerminated: { reason: "Error", exitCode: 1, finishedAt: "2026-10-11T01:33:00Z" },
        },
      ],
    });
    // Events from the platform and each other remaining Namespace, oldest first.
    assert.deepEqual(Object.keys(asRecord(logs.events)), ["oce-system", "oce-agent-1"]);
    assert.equal(calls.filter((call) => call.includes("events")).length, 2);
    assert.deepEqual(
      asArray(asRecord(logs.events)["oce-agent-1"]).map((event) => asRecord(event).object),
      ["Pod/undated", "Pod/worker-a", "Pod/agent-1-gateway-0"],
    );
    // Only a remaining Gateway Pod's own drain messages; the Agent Pod's log is not read.
    assert.deepEqual(logs.gatewayDrain, {
      "agent-1-gateway-0": [
        "2026-10-11T01:32:40Z draining active work before stop with timeout 315000ms: 1 active chat run(s)",
      ],
    });
    assert.ok(!calls.some((call) => call.includes("agent-1-runtime-0")));
    const gatewayLogCall = calls.find((call) => call.includes("agent-1-gateway-0"));
    assert.ok(gatewayLogCall);
    assert.deepEqual(gatewayLogCall.slice(1, 7), [
      "-n",
      "oce-agent-1",
      "logs",
      "agent-1-gateway-0",
      "--container",
      "gateway",
    ]);
    assert.doesNotMatch(
      JSON.stringify(logs),
      /spec-private-value|QA_NATIVE_conversation-text|launcher-private-value/,
    );
    // A single worker Pod is the Deployment read: no per-Pod copies.
    platformPods.splice(0, 1);
    await assert.rejects(stopQaAgent(f, { id: "agent-3", namespaceId: "namespace-1" }, timing), {
      message: /^Timed out: ordinary Agent stop removes every runtime Pod; last observation: /,
    });
    assert.equal(
      asRecord(asRecord(records.get("agent-3-stop-timeout-platform-logs")).logs).workerPods,
      undefined,
    );

    // A Compose control plane keeps the observation but has no in-cluster platform logs.
    records.clear();
    const composeAgent = { id: "agent-2", namespaceId: "namespace-1" };
    await assert.rejects(
      stopQaAgent({ ...f, controlPlane: "compose" }, composeAgent, timing),
      (error: unknown) =>
        error instanceof Error &&
        /; last observation: \{.*"pods":\[\{/.test(error.message) &&
        !/API and worker logs/.test(error.message),
    );
    assert.equal(records.size, 0);
  });

  test("a QA Agent stop waits for the Gateway stop bound and records a slow stop without failing", async (t) => {
    const { GATEWAY_STOP_TIMEOUT_MS } =
      await import("../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts");
    const { stopQaAgent, QA_STOP_TIMEOUT_MS, QA_SLOW_STOP_MS } =
      await import("../helpers/qa-repository.mjs");
    // The worker's own Gateway wait (grace plus one request) fits, with room for the
    // Harness and the API; the old 300 s default did not.
    assert.ok(QA_STOP_TIMEOUT_MS >= GATEWAY_STOP_TIMEOUT_MS + 10_000 + 3 * 60_000);
    assert.ok(QA_STOP_TIMEOUT_MS > 300_000);
    assert.equal(QA_SLOW_STOP_MS, 60_000);

    const gateway = {
      metadata: {
        namespace: "oce-agent-4",
        name: "agent-4-gateway-0",
        deletionTimestamp: "2026-10-11T07:23:42Z",
        labels: { "openclaw.dev/agent": "agent-4", "openclaw.dev/workload-role": "gateway" },
      },
      status: { phase: "Running" },
    };
    // A fake clock for both the slow-stop threshold and the timeout, and no sleep between
    // reads: each GET advances the clock by the next step; the last step's read finds
    // the stop done.
    let clock = 0;
    const now = () => clock;
    const stopTiming = { now, interval: 0 };
    const fixture = (steps: [number, ...number[]], { done = true }: { done?: boolean } = {}) => {
      const records = new Map<string, unknown>();
      let reads = 0;
      const finished = () => done && reads >= steps.length;
      const f = {
        controlPlane: "kubernetes",
        env: { PRIVATE_INPUT: "launcher-private-value" },
        state: { platformNamespace: "oce-system" },
        async api(method: string) {
          if (method !== "GET") {
            return undefined;
          }
          clock += steps[Math.min(reads, steps.length - 1)]!;
          reads += 1;
          assert.ok(reads < 100, "the stop wait follows the fake clock");
          return finished()
            ? { desiredRuntimeState: "stopped", activeRevisionId: null }
            : { desiredRuntimeState: "stopped", activeRevisionId: "revision-4" };
        },
        async kubectl(...args: string[]) {
          if (args[0] === "get") {
            return JSON.stringify({ items: finished() ? [] : [gateway] });
          }
          const [verb, target] = args.slice(2);
          if (verb === "get") {
            return JSON.stringify({ items: [] });
          }
          if (target === "agent-4-gateway-0") {
            return "2026-10-11T07:18:13Z draining active work before stop with timeout 315000ms: 1 active chat run(s)\n";
          }
          return "2026-10-11T07:18:12Z worker.completed\n";
        },
        // Like the QA fixture's record: exclusive creation.
        async record(name: string, value: unknown) {
          if (records.has(name)) {
            throw new Error(`EEXIST: ${name}`);
          }
          records.set(name, value);
          return `${this.controlPlane}-${name}.json`;
        },
      };
      return { f, records };
    };
    const written: string[] = [];
    t.mock.method(process.stderr, "write", (text: unknown) => {
      written.push(String(text));
      return true;
    });
    const drain = [
      "2026-10-11T07:18:13Z draining active work before stop with timeout 315000ms: 1 active chat run(s)",
    ];

    // A fast stop leaves no evidence.
    const fast = fixture([0, 5_000]);
    const fastAgent: AgentFixture = { id: "agent-4", namespaceId: "namespace-1" };
    await stopQaAgent(fast.f, fastAgent, stopTiming);
    assert.equal(fastAgent.stopped, true);
    assert.equal(fast.records.size, 0);
    assert.deepEqual(written, []);

    // Still running past 60 s: the drain lines are captured once, while the Gateway
    // drains, then the completed stop records its total time and passes.
    clock = 0;
    const slow = fixture([61_000, 1_000, 1_000, 200_000]);
    const slowAgent: AgentFixture = { id: "agent-4", namespaceId: "namespace-1" };
    await stopQaAgent(slow.f, slowAgent, stopTiming);
    assert.equal(slowAgent.stopped, true);
    assert.deepEqual([...slow.records.keys()].sort(), [
      "agent-4-slow-stop",
      "agent-4-slow-stop-platform-logs",
    ]);
    assert.deepEqual(
      asRecord(
        asRecord(asRecord(slow.records.get("agent-4-slow-stop-platform-logs")).logs).gatewayDrain,
      )["agent-4-gateway-0"],
      drain,
    );
    assert.deepEqual(slow.records.get("agent-4-slow-stop"), {
      thresholdMs: 60_000,
      observedAfterMs: 61_000,
      observation: {
        desiredRuntimeState: "stopped",
        activeRevisionId: "revision-4",
        pods: [
          {
            namespace: "oce-agent-4",
            name: "agent-4-gateway-0",
            phase: "Running",
            deletionTimestamp: "2026-10-11T07:23:42Z",
            finalizers: [],
          },
        ],
      },
      platformLogs: "kubernetes-agent-4-slow-stop-platform-logs.json",
      elapsedMs: 263_000,
    });
    assert.equal(written.length, 1);
    assert.match(
      asString(written[0]),
      /^QA slow stop \(diagnostic, not a failure\): Agent agent-4 took 263 s; drain evidence: kubernetes-agent-4-slow-stop-platform-logs\.json\n$/,
    );

    // A stop that first finishes after 60 s still records its time, without a capture.
    // Stopping the same Agent again gets its own evidence names.
    clock = 0;
    const late = fixture([61_000]);
    await stopQaAgent(late.f, slowAgent, stopTiming);
    assert.deepEqual(late.records.get("agent-4-2-slow-stop"), {
      thresholdMs: 60_000,
      elapsedMs: 61_000,
    });
    assert.match(asString(written[1]), /took 61 s\n$/);

    // Evidence that cannot be written never fails a completed stop, and its error is redacted.
    clock = 0;
    const unwritable = fixture([61_000, 1_000]);
    const failures: string[] = [];
    unwritable.f.record = async (name) => {
      failures.push(name);
      throw new Error("EEXIST: launcher-private-value exists");
    };
    const unwritableAgent: AgentFixture = { id: "agent-4", namespaceId: "namespace-1" };
    await stopQaAgent(unwritable.f, unwritableAgent, stopTiming);
    assert.equal(unwritableAgent.stopped, true);
    assert.deepEqual(failures, ["agent-4-slow-stop-platform-logs", "agent-4-slow-stop"]);
    assert.match(asString(written[2]), /took 62 s\n$/);

    // A slow stop that then times out names the drain evidence captured while it ran;
    // it records no completed-stop summary.
    const stuck = fixture([1_000], { done: false });
    const stuckAgent: AgentFixture = { id: "agent-5", namespaceId: "namespace-1" };
    await assert.rejects(
      stopQaAgent(stuck.f, stuckAgent, { ...stopTiming, slowAfter: 0, timeout: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /; API and worker logs: kubernetes-agent-5-stop-timeout-platform-logs\.json; drain evidence after \d+ s: kubernetes-agent-5-slow-stop-platform-logs\.json$/,
        );
        return true;
      },
    );
    assert.equal(stuckAgent.stopped, undefined);
    assert.deepEqual([...stuck.records.keys()].sort(), [
      "agent-5-slow-stop-platform-logs",
      "agent-5-stop-timeout-platform-logs",
    ]);
    assert.equal(written.length, 3);

    // The default timeout is that bound on the same clock: a stop that completes once the
    // Gateway wait plus three minutes has passed still passes; one still running at the
    // bound fails.
    const bound = GATEWAY_STOP_TIMEOUT_MS + 10_000 + 3 * 60_000;
    clock = 0;
    const atBoundAgent: AgentFixture = { id: "agent-6", namespaceId: "namespace-1" };
    await stopQaAgent(fixture([bound - 1, 1]).f, atBoundAgent, stopTiming);
    assert.equal(atBoundAgent.stopped, true);
    assert.equal(written.length, 4);
    assert.match(
      asString(written[3]),
      new RegExp(`Agent agent-6 took ${Math.round(bound / 1000)} s`),
    );
    clock = 0;
    const pastBoundAgent: AgentFixture = { id: "agent-7", namespaceId: "namespace-1" };
    await assert.rejects(
      stopQaAgent(fixture([bound], { done: false }).f, pastBoundAgent, stopTiming),
      { message: /^Timed out: ordinary Agent stop removes every runtime Pod; / },
    );
    assert.equal(pastBoundAgent.stopped, undefined);
    // It timed out on its first read, at the bound: the timeout is no longer than the bound.
    assert.equal(clock, bound);
  });
}
