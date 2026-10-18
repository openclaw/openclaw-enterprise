import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  k3sImage,
  kubectlVersion,
  prepareOpenShell,
  prepareOpenShellClusterBootstrap,
  selectKubectlAsset,
} from "../../scripts/ci/openshell.mjs";
import { observeSandboxProbe } from "../helpers/k3d-failure-diagnostics.mjs";
import {
  createOpenShellInstallationConfiguration,
  createOpenShellKubernetesFixture,
  createOpenShellServiceLoopbackLookup,
  openShellChartImageValues,
  openShellGatewayNetworkPolicies,
  outageAttemptRead,
} from "../helpers/openshell-kubernetes-real.mjs";

async function fixture(t, prefix = "ci-openshell-test") {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function ownedCluster(root, name = "openclaw-k8s-openshell-test") {
  return {
    name,
    directory: root,
    kubeconfig: join(root, "kubeconfig"),
    context: `k3d-${name}`,
  };
}

test("kubectl asset selection supports the pinned OpenShell CI host platforms", () => {
  assert.equal(selectKubectlAsset("darwin", "arm64").name, "kubectl-darwin-arm64");
  assert.throws(() => selectKubectlAsset("darwin", "x64"), /no pinned kubectl/);
});

test("OpenShell Helm chart image values use the v0.1.4 registry and digest contract", () => {
  const digest = "@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  assert.deepEqual(
    openShellChartImageValues("gateway.image", `localhost/example/gateway:local${digest}`),
    [
      "--set-string=gateway.image.registry=localhost",
      "--set-string=gateway.image.repository=example/gateway",
      `--set-string=gateway.image.digest=${digest.slice(1)}`,
    ],
  );
  assert.deepEqual(
    openShellChartImageValues("supervisor.image", `localhost/example/supervisor${digest}`),
    [
      "--set-string=supervisor.image.registry=localhost",
      "--set-string=supervisor.image.repository=example/supervisor",
      `--set-string=supervisor.image.digest=${digest.slice(1)}`,
    ],
  );
  assert.deepEqual(
    openShellChartImageValues("sandboxRuntime.image", `localhost:5000/example/sandbox${digest}`),
    [
      "--set-string=sandboxRuntime.image.registry=localhost:5000",
      "--set-string=sandboxRuntime.image.repository=example/sandbox",
      `--set-string=sandboxRuntime.image.digest=${digest.slice(1)}`,
    ],
  );
  assert.throws(
    () => openShellChartImageValues("gateway.image", "localhost/example/gateway:local"),
    /immutable OpenShell image digest/,
  );
});

// Finding 1846: the worker claimed the work again between the queued read and the deployment read,
// so the proof saw `running` while nothing had activated. Each poll replays one interleaving.
test("OpenShell outage proof rereads a deployment the worker claimed again between reads", async () => {
  const queued = (attempt) => ({ state: "queued", reason_code: null, attempt_count: attempt });
  const claimed = (attempt) => ({ state: "claimed", reason_code: null, attempt_count: attempt });
  const polls = [
    [queued(0), undefined],
    [queued(3), "running"],
    [claimed(4), undefined],
    [queued(4), "queued"],
  ];
  let reads = 0;
  const poll = outageAttemptRead({
    readWork: async () => polls[reads][0],
    readStatus: async () => {
      assert.notEqual(
        polls[reads][1],
        undefined,
        "status is read only once the work is queued after an attempt",
      );
      return polls[reads][1];
    },
  });
  const results = [];
  for (; reads < polls.length; reads += 1) {
    results.push(await poll());
  }
  assert.deepEqual(results, [
    undefined,
    undefined,
    undefined,
    { work: queued(4), status: "queued" },
  ]);
  // A revision that failed or activated during the outage ends the wait, so the proof fails on it.
  for (const status of ["failed", "succeeded", null]) {
    const ended = await outageAttemptRead({
      readWork: async () => queued(1),
      readStatus: async () => status,
    })();
    assert.deepEqual(ended, { work: queued(1), status });
  }
});

test("OpenShell host probes retain the exposed hostname while connecting to loopback", async (t) => {
  const serviceHostname = "default--sb-review.openshell.localhost";
  let observedHost;
  // The real integration forwards the OpenShell gateway only to loopback, while routing still
  // depends on the hostname returned by CreateSandbox.
  const server = createServer((incoming, response) => {
    observedHost = incoming.headers.host;
    response.end("routed");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://${serviceHostname}:${address.port}/health`;
  const response = await new Promise((resolve, reject) => {
    const probe = request(serviceUrl, {
      lookup: createOpenShellServiceLoopbackLookup(serviceHostname),
    });
    probe.on("response", resolve);
    probe.on("error", reject);
    probe.end();
  });
  const body = [];
  for await (const chunk of response) {
    body.push(chunk);
  }

  assert.equal(response.statusCode, 200);
  assert.equal(Buffer.concat(body).toString("utf8"), "routed");
  assert.equal(observedHost, `${serviceHostname}:${address.port}`);
});

test("OpenShell probe observes its command after the turn ends, or preserves the unknown outcome", async (t) => {
  // Run the actual in-Pod client and probe decision. Only kubectl transport and the
  // app-server peer are fixtures. WebSocket message order, not a sleep, creates the boundary.
  const controller = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const { WebSocketServer } = createRequire(controller.resolve("@kubernetes/client-node"))("ws");
  const server = createServer();
  const peer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, stream, head) => {
    peer.handleUpgrade(request, stream, head, (socket) => peer.emit("connection", socket, stream));
  });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");

  const directory = await fixture(t);
  await writeFile(
    join(directory, "kubectl"),
    [
      "#!/bin/sh",
      'while [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done',
      "shift",
      `export APP_SERVER_URL=ws://127.0.0.1:${server.address().port}`,
      'exec "$@"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = directory + delimiter + path;
  t.after(() => {
    process.env.PATH = path;
  });
  const { requestCodexTurnFromGatewayPod } = createOpenShellKubernetesFixture({});

  for (const event of [
    "late result",
    "foreign completion before turn ends",
    "completion without turn ID",
    "start without thread ID",
    "another start",
    "untracked completion",
    "duplicate start",
    "duplicate completion",
    "conflicting command",
    "incomplete result",
    "expiry",
    "close",
  ]) {
    const threadId = "probe-thread";
    const turnId = "probe-turn";
    const nonce = "probe-command";
    const unexpected = event !== "late result" && event !== "expiry" && event !== "close";
    peer.once("connection", (socket, stream) => {
      socket.on("message", (data) => {
        const { method, id } = JSON.parse(data);
        const send = (message) => socket.send(JSON.stringify(message));
        // The approval response is checked below.
        if (method === undefined || method === "initialized") {
          return;
        }
        if (method === "initialize") {
          return send({ id, result: {} });
        }
        if (method === "thread/start") {
          return send({
            id,
            result: { thread: { id: threadId }, sandbox: { type: "dangerFullAccess" } },
          });
        }
        assert.equal(method, "turn/start");
        const turn = { id: turnId, status: "inProgress" };
        // Deliver the response and notifications in one write. The client can receive
        // them in one socket read, before its turn/start await continuation runs.
        stream.cork();
        send({ id, result: { turn } });
        const item = {
          id: "original",
          type: "commandExecution",
          command: unexpected ? "setup" : nonce,
          status: "inProgress",
        };
        send({ method: "item/started", params: { threadId, turnId, item } });
        const extra = { ...item, id: "extra" };
        const unbound = {
          "foreign completion before turn ends": { turnId: "other-turn" },
          "completion without turn ID": { turnId: undefined },
          "start without thread ID": { threadId: undefined },
        }[event];
        if (unbound) {
          // Even with the probe nonce, this event cannot establish what our command did.
          const started = event === "start without thread ID";
          const status = started ? {} : { status: "failed", exitCode: 77 };
          send({
            method: started ? "item/started" : "item/completed",
            params: {
              threadId,
              turnId,
              ...unbound,
              item: { ...extra, ...status, command: nonce },
            },
          });
        }
        if (event === "duplicate completion") {
          send({ method: "item/started", params: { threadId, turnId, item: extra } });
        }
        send({
          method: "turn/completed",
          params: { threadId, turn: { ...turn, status: "completed" } },
        });
        stream.uncork();
        const setupSucceeded = unexpected && !unbound;
        const terminal = {
          ...item,
          status: setupSucceeded ? "completed" : "failed",
          exitCode: setupSucceeded ? 0 : 23,
        };
        const params = { threadId, turnId, item: terminal };
        const completed = (params) => send({ method: "item/completed", params });
        if (event === "late result") {
          // Neither an unrelated completion nor output from the command is its terminal.
          completed({ ...params, turnId: "other-turn" });
          completed({ ...params, threadId: "other-thread" });
          send({
            method: "item/commandExecution/outputDelta",
            params: { threadId, turnId, itemId: item.id, delta: "output" },
          });
          send({ id: "approval", method: "item/commandExecution/requestApproval", params });
          socket.once("message", (data) => {
            const { id, result } = JSON.parse(data);
            assert.equal(id, "approval");
            assert.deepEqual(result, { decision: "decline" });
            completed(params);
          });
        } else if (event === "close") {
          socket.close();
        } else if (unbound) {
          completed(params);
        } else if (unexpected) {
          // If the client loses evidence of the probe, the later successful setup
          // completion would make observeSandboxProbe eligible to request turn two.
          const other = { ...terminal, command: nonce, id: "second" };
          if (event === "another start" || event === "duplicate start") {
            const started =
              event === "duplicate start" ? item : { ...item, command: nonce, id: other.id };
            send({ method: "item/started", params: { ...params, item: started } });
          } else {
            const changed = {
              "conflicting command": { command: nonce },
              "incomplete result": { exitCode: null },
              "untracked completion": other,
              "duplicate completion": { id: extra.id },
            }[event];
            if (event === "duplicate completion") {
              completed({ ...params, item: { ...terminal, id: extra.id } });
            }
            completed({ ...params, item: { ...terminal, ...changed } });
          }
          completed(params);
        }
        // In the expiry case no more messages arrive; the client owns the deadline.
      });
    });

    const attempts = [];
    const probe = observeSandboxProbe({
      nonce,
      traceSecrets: [],
      requestTurn(attempt) {
        attempts.push(attempt);
        assert.equal(attempt, 1, event);
        return requestCodexTurnFromGatewayPod({ namespace: "fixture", gatewayPod: "fixture" });
      },
    });
    if (event === "late result") {
      assert.equal((await probe).run.exitCode, 23, "retain the command's actual nonzero result");
    } else {
      await assert.rejects(probe, /Codex command outcome is unknown/, event);
    }
    assert.deepEqual(attempts, [1], event);
  }
});

test("OpenShell probe waits for a command that outlives its turn up to the fixture's bound", async (t) => {
  // Finding 1630: Codex hands a long command back to the model, which can reply and end the
  // turn while the command still runs. The in-Pod client waits for that command's completion
  // event up to the fixture's bound, and reports the command's timing when the bound expires.
  const controller = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const { WebSocketServer } = createRequire(controller.resolve("@kubernetes/client-node"))("ws");
  const server = createServer();
  const peer = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const directory = await fixture(t);
  // Finding 1665: wakes the client's first command-deadline timer after 1 ms instead of its
  // delay, as an early libuv wake would, and records that it did.
  const earlyWake = join(directory, "early-wake.mjs");
  const earlyWakeMarker = join(directory, "early-wake");
  await writeFile(
    earlyWake,
    [
      'import { writeFileSync } from "node:fs";',
      "const grace = Number(process.env.EARLY_WAKE_GRACE_MS);",
      "const setTimeoutOriginal = globalThis.setTimeout;",
      "let woken = false;",
      "globalThis.setTimeout = (callback, delay, ...rest) => {",
      "  if (!woken && delay > grace - 50 && delay <= grace) {",
      "    woken = true;",
      `    writeFileSync(${JSON.stringify(earlyWakeMarker)}, String(delay));`,
      "    delay = 1;",
      "  }",
      "  return setTimeoutOriginal(callback, delay, ...rest);",
      "};",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "kubectl"),
    [
      "#!/bin/sh",
      'while [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done',
      "shift",
      `export APP_SERVER_URL=ws://127.0.0.1:${server.address().port}`,
      `if [ -n "$EARLY_WAKE_GRACE_MS" ]; then export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--import=${pathToFileURL(earlyWake)}"; fi`,
      'exec "$@"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = directory + delimiter + path;
  t.after(() => {
    process.env.PATH = path;
  });
  const threadId = "probe-thread";
  const turnId = "probe-turn";
  const nonce = "probe-command";
  // The command completes this long after the turn: past the former fixed 5 s wait would make
  // the test slow, so the bounds below scale it down. The client sees only message order and time.
  const lateMs = 800;
  let turnCompletedAt;
  peer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const { method, id } = JSON.parse(data);
      const send = (message) => socket.send(JSON.stringify(message));
      if (method === undefined || method === "initialized") {
        return;
      }
      if (method === "initialize") {
        return send({ id, result: {} });
      }
      if (method === "thread/start") {
        return send({
          id,
          result: { thread: { id: threadId }, sandbox: { type: "dangerFullAccess" } },
        });
      }
      const turn = { id: turnId, status: "inProgress" };
      send({ id, result: { turn } });
      const item = { id: "probe", type: "commandExecution", command: nonce, status: "inProgress" };
      send({ method: "item/started", params: { threadId, turnId, item } });
      send({
        method: "item/commandExecution/outputDelta",
        params: { threadId, turnId, itemId: item.id, delta: "TOOL_EXIT=" },
      });
      turnCompletedAt = performance.now();
      send({
        method: "turn/completed",
        params: { threadId, turn: { ...turn, status: "completed" } },
      });
      setTimeout(() => {
        const terminal = {
          ...item,
          status: "failed",
          exitCode: 28,
          aggregatedOutput: "TOOL_EXIT=28",
        };
        if (socket.readyState === socket.OPEN) {
          send({ method: "item/completed", params: { threadId, turnId, item: terminal } });
        }
      }, lateMs);
    });
  });
  const probe = (codexCommandGraceMs) => {
    const { requestCodexTurnFromGatewayPod } = createOpenShellKubernetesFixture({
      codexCommandGraceMs,
    });
    return observeSandboxProbe({
      nonce,
      traceSecrets: [],
      requestTurn: () =>
        requestCodexTurnFromGatewayPod({ namespace: "fixture", gatewayPod: "fixture" }),
    });
  };

  // Within the bound, the late completion settles the probe with the command's own result.
  const { run } = await probe(lateMs * 4);
  assert.equal(run.exitCode, 28, "keep the late command's actual result");
  // The grace starts when the turn ends; launching the client isn't part of that wait.
  assert.ok(performance.now() - turnCompletedAt < lateMs * 4, "settle on the completion event");

  // Past the bound, the outcome stays unknown and the failure says how long the command ran.
  const error = await probe(lateMs / 4).then(
    () => assert.fail("a command that outlives the bound must leave the outcome unknown"),
    (failure) => failure,
  );
  assert.match(error.message, /Codex command outcome is unknown/);
  // pendingCommands is the summary's last field, so the object ends at the first "]}".
  const summary = JSON.parse(/Native execution summary: (\{.*?\]\})/s.exec(error.message)[1]);
  assert.equal(summary.commandGraceMs, lateMs / 4);
  assert.ok(summary.sinceTurnEndMs >= lateMs / 4);
  assert.equal(summary.pendingCommands.length, 1);
  assert.equal(summary.pendingCommands[0].outputDeltas, 1);
  assert.equal(summary.pendingCommands[0].outputBytes, "TOOL_EXIT=".length);
  assert.ok(summary.pendingCommands[0].startedBeforeTurnEndMs >= 0);
  assert.ok(summary.pendingCommands[0].runningMs >= lateMs / 4);

  // An early timer wake must not end the grace before turn completion plus the bound: the
  // client re-arms for the remainder. A one-shot timer would report an unknown outcome here.
  const probeWithEarlyWake = async (codexCommandGraceMs) => {
    await rm(earlyWakeMarker, { force: true });
    process.env.EARLY_WAKE_GRACE_MS = String(codexCommandGraceMs);
    const outcome = await probe(codexCommandGraceMs).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    delete process.env.EARLY_WAKE_GRACE_MS;
    // The deadline was armed for the grace less the moment since the turn ended.
    const woke = Number(await readFile(earlyWakeMarker, "utf8").catch(() => NaN));
    assert.ok(
      woke > codexCommandGraceMs - 50 && woke <= codexCommandGraceMs,
      "the command-deadline timer must wake early",
    );
    if (outcome.error) {
      throw outcome.error;
    }
    return outcome.result;
  };
  const early = await probeWithEarlyWake(lateMs * 4);
  assert.equal(early.run.exitCode, 28, "an early wake keeps waiting for the late command");
  const expired = await probeWithEarlyWake(lateMs / 4).then(
    () => assert.fail("a command that outlives the bound must leave the outcome unknown"),
    (failure) => failure,
  );
  assert.match(expired.message, /Codex command outcome is unknown/);
  const expiredSummary = JSON.parse(
    /Native execution summary: (\{.*?\]\})/s.exec(expired.message)[1],
  );
  assert.ok(expiredSummary.sinceTurnEndMs >= lateMs / 4, "never end the grace before its bound");

  for (const codexCommandGraceMs of [0, 1.5, 60_001, "5000"]) {
    assert.throws(
      () => createOpenShellKubernetesFixture({ codexCommandGraceMs }),
      /codexCommandGraceMs must be a positive number/,
    );
  }
});

test("OpenShell fixture networking admits the supervisor callback without granting tenant Pods", () => {
  const configuration = createOpenShellInstallationConfiguration({
    authentication: {},
    platformNamespace: "openclaw-system",
    gatewayImage: "gateway-fixture",
    codexImage: "codex-fixture",
    cluster: { name: "fixture" },
  });
  const networkPolicyResources =
    configuration.drivers.sandbox.configuration.gateway.networkPolicyResources;
  // Compute owns Harness DNS; the supervisor's egress comes from OpenShell's own policy.
  assert.deepEqual(networkPolicyResources, []);
  const apiPeers = [{ ipBlock: { cidr: "192.0.2.10/32" } }];
  const policies = [
    ...openShellGatewayNetworkPolicies("tenant-fixture", apiPeers).items,
    ...networkPolicyResources,
  ];
  for (const policy of policies) {
    assert.notDeepEqual(policy.spec.podSelector, {}, `${policy.metadata.name} selects every Pod`);
  }
  const matches = (selector, labels) =>
    selector.matchLabels !== undefined &&
    Object.entries(selector.matchLabels).every(([key, value]) => labels[key] === value);
  // OpenShell v0.1.4 supervisor Pod labels (sandbox_runtime.rs; internal/occdev/kubernetes.go).
  const supervisor = {
    "openshell.ai/managed-by": "openshell",
    "openshell.ai/boundary-role": "supervisor",
  };
  const callbacks = policies.filter((policy) => matches(policy.spec.podSelector, supervisor));
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].metadata.name, "allow-openshell-sandbox-callback");
  assert.deepEqual(callbacks[0].spec.policyTypes, ["Egress"]);
  assert.deepEqual(callbacks[0].spec.egress[0].ports, [{ protocol: "TCP", port: 8080 }]);
  const gatewayLabels = callbacks[0].spec.egress[0].to[0].podSelector.matchLabels;
  const gatewayPolicies = policies.filter((policy) =>
    matches(policy.spec.podSelector, gatewayLabels),
  );
  assert.equal(gatewayPolicies.length, 3);
  const controlPlane = gatewayPolicies.find((policy) => policy.spec.egress !== undefined);
  assert.deepEqual(
    controlPlane.spec.egress.map((rule) => rule.ports),
    [
      [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
      [{ protocol: "TCP", port: 443 }],
      [{ protocol: "TCP", port: 6443 }],
    ],
  );
  assert.deepEqual(controlPlane.spec.egress[1].to, apiPeers);
  assert.deepEqual(controlPlane.spec.egress[2].to, apiPeers);
  const callbackIngress = gatewayPolicies.find(
    (policy) => policy.metadata.name === "allow-openshell-gateway-callback",
  );
  assert.equal(callbackIngress.metadata.name, "allow-openshell-gateway-callback");
  assert.deepEqual(callbackIngress.spec.ingress[0].ports, [
    { protocol: "TCP", port: 8080 },
    { protocol: "TCP", port: 8081 },
  ]);
  const callers = callbackIngress.spec.ingress[0].from;
  assert.equal(callers.length, 1);
  assert.equal(callers[0].namespaceSelector, undefined);
  assert.equal(matches(callers[0].podSelector, supervisor), true);
  // Dedicated Agent Gateways reach the OpenShell-exposed Codex endpoint on the service port only.
  const agentGatewayIngress = gatewayPolicies.find(
    (policy) => policy.metadata.name === "allow-openshell-gateway-agent-gateways",
  );
  assert.deepEqual(agentGatewayIngress.spec.ingress[0].ports, [{ protocol: "TCP", port: 8080 }]);
  const agentGatewayCallers = agentGatewayIngress.spec.ingress[0].from;
  assert.equal(agentGatewayCallers.length, 1);
  assert.equal(agentGatewayCallers[0].namespaceSelector, undefined);
  const agentGateway = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/workload-role": "gateway",
  };
  assert.equal(matches(agentGatewayCallers[0].podSelector, agentGateway), true);

  // The Harness workload (any profile) is not the gateway caller, and no additive fixture policy
  // may select an openclaw Pod, classified or not.
  for (const profile of [
    undefined,
    "",
    "unknown-profile",
    "broad-egress-v1",
    "provider-fenced-v1",
  ]) {
    const agent = {
      "openclaw.dev/workload-role": "agent",
      ...(profile === undefined ? {} : { "openclaw.dev/network-profile": profile }),
    };
    assert.equal(matches(callers[0].podSelector, agent), false);
    assert.equal(
      matches(agentGatewayCallers[0].podSelector, {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        ...agent,
      }),
      false,
    );
    assert.equal(
      policies.some((policy) => matches(policy.spec.podSelector, agent)),
      false,
    );
  }
});

test("prepareOpenShellClusterBootstrap selects pinned K3s and kubectl with runc", async (t) => {
  const root = await fixture(t, "openshell-cluster-bootstrap-test");
  const calls = [];

  async function execFile(command, args) {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  }

  const result = await prepareOpenShellClusterBootstrap({
    directory: root,
    execFile,
    hostPlatform: "darwin",
    hostArch: "arm64",
    downloadArtifact: async (url, destination, sha256) => {
      assert.match(url, /kubectl$/);
      assert.equal(sha256.length, 64);
      await writeFile(destination, "fake kubectl", { mode: 0o700 });
    },
  });

  assert.deepEqual(result, {
    k3sImage,
    runtimeClass: "openshell-sandbox",
    runtimeHandler: "runc",
    kubectl: join(root, "bin", `kubectl-darwin-arm64-${kubectlVersion}`),
    kubectlVersion,
  });
  assert.deepEqual(
    calls.map(([command]) =>
      command.endsWith("kubectl-darwin-arm64-v1.36.4") ? "kubectl" : command,
    ),
    ["kubectl"],
  );
  assert.deepEqual(calls[0][1], ["version", "--client=true"]);
});

test("prepareOpenShell rejects foreign clusters before kubectl, Docker, or image registration", async (t) => {
  const root = await fixture(t, "foreign-openshell-test");
  const calls = [];
  let registerCalls = 0;

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster: {
          name: "foreign",
          directory: root,
          kubeconfig: join(root, "kubeconfig"),
          context: "foreign",
        },
        execFile: async (command, args) => {
          calls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {},
      }),
    /unowned cluster|cluster\.name must be a Kubernetes DNS label/,
  );

  assert.deepEqual(calls, []);
  assert.equal(registerCalls, 0);
});

test("prepareOpenShell rejects mutable OpenShell image overrides before kubectl or Docker", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await fixture(t, clusterName);
  const calls = [];
  let registerCalls = 0;

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster: ownedCluster(root, clusterName),
        execFile: async (command, args) => {
          calls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {
          OCC_TEST_OPENSHELL_GATEWAY_IMAGE: "ghcr.io/nvidia/openshell/gateway:latest",
        },
      }),
    /OCC_TEST_OPENSHELL_GATEWAY_IMAGE must be an immutable image@sha256 reference/,
  );

  assert.deepEqual(calls, []);
  assert.equal(registerCalls, 0);
});

test("prepareOpenShell fails before downloads when the RuntimeClass smoke Pod fails", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await fixture(t, clusterName);
  const calls = [];
  let registerCalls = 0;
  const cluster = ownedCluster(root, clusterName);
  const agentImage =
    "localhost/openclaw-k8s-openshell-test/agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  async function execFile(command, args) {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "exec") {
      return {
        stdout: "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runc']\n",
        stderr: "",
      };
    }
    if (
      command === "kubectl" &&
      args.includes("--dry-run=server") &&
      args.some((arg) => arg.endsWith("openshell-psa-restricted-rejection.yaml"))
    ) {
      throw new Error(
        'Error from server (Forbidden): pods "openshell-psa-violation" is forbidden: violates PodSecurity "restricted:latest": privileged',
      );
    }
    if (command === "kubectl" && args.includes("--for=jsonpath={.status.phase}=Succeeded")) {
      throw new Error("pod reached Failed phase");
    }
    if (command === "kubectl" && args.includes("describe")) {
      return { stdout: "FailedCreatePodSandBox runc unavailable", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster,
        execFile,
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {
          OCC_KUBECTL_BIN: "kubectl",
          OCC_HELM_BIN: "helm",
          OCC_DOCKER_BIN: "docker",
          OCC_TEST_KUBERNETES_AGENT_IMAGE: agentImage,
        },
      }),
    /FailedCreatePodSandBox runc unavailable/,
  );

  assert.equal(registerCalls, 0);
  assert.equal(
    calls.some(([command]) => command === "tar"),
    false,
  );
  assert.equal(
    calls.some(([command, args]) => command === "helm" && args[0] === "pull"),
    false,
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "kubectl" &&
        args.includes("delete") &&
        args.includes("openshell-runtimeclass-smoke"),
    ),
  );

  const manifest = await readFile(
    join(root, "openshell", "openshell-runtimeclass-smoke.yaml"),
    "utf8",
  );
  assert.match(manifest, /runtimeClassName: openshell-sandbox/);
  assert.match(manifest, new RegExp(`image: "${agentImage}"`));
  assert.match(manifest, /imagePullPolicy: Never/);
});

test("prepareOpenShell fails before downloads when the k3d node lacks the selected handler", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await fixture(t, clusterName);
  const calls = [];
  let registerCalls = 0;
  const cluster = ownedCluster(root, clusterName);

  async function execFile(command, args) {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "exec") {
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster,
        execFile,
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {
          OCC_KUBECTL_BIN: "kubectl",
          OCC_HELM_BIN: "helm",
          OCC_DOCKER_BIN: "docker",
        },
      }),
    /does not advertise that handler/,
  );

  assert.equal(registerCalls, 0);
  assert.equal(
    calls.some(([command]) => command === "tar"),
    false,
  );
  assert.equal(
    calls.some(([command, args]) => command === "helm" && args[0] === "pull"),
    false,
  );
  assert.equal(
    calls.some(([command, args]) => command === "docker" && args[0] !== "exec"),
    false,
  );
  assert.deepEqual(
    calls.filter(([command]) => command === "docker").map(([, args]) => args[1]),
    [`k3d-${cluster.name}-server-0`],
  );
  for (const [, args] of calls.filter(([command]) => command === "kubectl")) {
    assert.deepEqual(args.slice(0, 4), [
      "--kubeconfig",
      cluster.kubeconfig,
      "--context",
      cluster.context,
    ]);
  }
});
