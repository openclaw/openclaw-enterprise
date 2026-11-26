import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as drainTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { GATEWAY_STOP_TIMEOUT_MS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  STOP_PHASE_TIMEOUT_MS,
  agentStopDiagnostic,
  assertChatReply,
  clusterEventLines,
  createApi,
  createStepRecorder,
  observeAgentStop,
  smokeSlotNames,
  stoppedGatewaySummary,
  waitFor,
  watchCluster,
} from "../../scripts/ci/first-agent-smoke.ts";
import {
  channelProxyDeploymentStep,
  waitForChannelProxyReadiness,
} from "../../scripts/ci/first-agent-smoke/process.ts";
import { withEnvironment } from "../helpers/environment.ts";
import { commandPath } from "../helpers/fake-commands.ts";
import { listen } from "../helpers/listen.ts";
import {
  registerGitExpiryCase,
  registerInstalledGitTransportCase,
} from "./first-agent-smoke-git-cases.ts";
import { registerImageCases } from "./first-agent-smoke-image-cases.ts";

const revision = "rev_00000000-0000-4000-8000-000000000001";
const chatNonce = "OCE_SMOKE_00000000-0000-4000-8000-000000000001";
const validChatReply = { status: 200, role: "assistant", content: chatNonce };

test("smoke timing records overlapping admissions on one elapsed timeline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 1000;
  const recorder = createStepRecorder(() => clock);
  const embedded = Promise.withResolvers();
  const codex = Promise.withResolvers();
  const control = Promise.withResolvers();
  const started: string[] = [];
  const admission = recorder.initialAdmissions({
    embedded: () => {
      started.push("embedded");
      clock += 2;
      return embedded.promise;
    },
    codex: () => {
      started.push("codex");
      clock += 3;
      return codex.promise;
    },
    control: () => {
      started.push("control");
      return control.promise;
    },
  });
  assert.deepEqual(started, ["embedded", "codex", "control"]);

  clock = 1010;
  control.resolve("control");
  await Promise.resolve();
  clock = 1020;
  embedded.resolve("embedded");
  await Promise.resolve();
  clock = 1030;
  codex.resolve("codex");
  assert.deepEqual(await admission, ["embedded", "codex", "control"]);

  await recorder.writeTimingReport(directory);
  const report: unknown = JSON.parse(
    await readFile(join(directory, "first-agent-smoke-timing-v2.json"), "utf8"),
  );
  assert.deepEqual(report, {
    version: 2,
    rows: [
      {
        phase: "admit-reader-control",
        parent: "initial-admissions",
        startMs: 5,
        endMs: 10,
        status: "ok",
      },
      {
        phase: "admit-embedded",
        parent: "initial-admissions",
        startMs: 0,
        endMs: 20,
        status: "ok",
      },
      { phase: "admit-codex", parent: "initial-admissions", startMs: 2, endMs: 30, status: "ok" },
      { phase: "initial-admissions", parent: null, startMs: 0, endMs: 30, status: "ok" },
    ],
  });
});

test("smoke timing retains failure and omits pending branches and free-form data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 20;
  const recorder = createStepRecorder(() => clock);
  const pending = Promise.withResolvers<void>();
  const failed = Promise.withResolvers();
  const error = new Error("unpublished diagnostic sentinel");
  await recorder.step("free-form timing sentinel", () => "operation result sentinel");
  const admission = recorder.initialAdmissions({
    embedded: () => pending.promise,
    codex: () => failed.promise,
    control: () => pending.promise,
  });
  clock = 28;
  failed.reject(error);
  await assert.rejects(admission, (rejection) => rejection === error);

  await recorder.writeTimingReport(directory);
  const report: unknown = JSON.parse(
    await readFile(join(directory, "first-agent-smoke-timing-v2.json"), "utf8"),
  );
  assert.deepEqual(report, {
    version: 2,
    rows: [
      {
        phase: "admit-codex",
        parent: "initial-admissions",
        startMs: 0,
        endMs: 8,
        status: "failed",
      },
      { phase: "initial-admissions", parent: null, startMs: 0, endMs: 8, status: "failed" },
    ],
  });
  pending.resolve();
});

test("smoke timing records overlapping proxy readiness on one elapsed timeline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "first-agent-smoke-timing-v2.json");
  let clock = 1000;
  const { smokeStep, writeTimingReport } = createStepRecorder(() => clock);
  const envoyReady = Promise.withResolvers<void>();
  const hostReady = Promise.withResolvers<void>();
  const hostStarted = Promise.withResolvers<void>();

  const proxy = smokeStep("controlled-channel-proxy", async () => {
    clock += 3;
    await smokeStep("channel-proxy-helm-wait", () => {
      clock += 2;
    });
    const envoyTrust = smokeStep("channel-proxy-envoy-trust-rollout", () => envoyReady.promise);
    const apiReady = async () => {
      await smokeStep("channel-proxy-api-rollout", () => {
        clock += 4;
      });
      await smokeStep("channel-proxy-host-route-readiness", () => {
        hostStarted.resolve();
        return hostReady.promise;
      });
    };
    await waitForChannelProxyReadiness(envoyTrust, apiReady());
    clock += 8;
    return "proxy proof result";
  });
  await hostStarted.promise;
  clock += 6;
  hostReady.resolve();
  await drainTurn();
  const completed = [
    { phase: "channel-proxy-helm-wait", startMs: 3, endMs: 5 },
    { phase: "channel-proxy-api-rollout", startMs: 5, endMs: 9 },
    { phase: "channel-proxy-host-route-readiness", startMs: 9, endMs: 15 },
  ].map((row) => ({ ...row, parent: "controlled-channel-proxy", status: "ok" }));
  await writeTimingReport(directory);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 2, rows: completed });

  clock += 37;
  envoyReady.resolve();
  assert.equal(await proxy, "proxy proof result");
  await writeTimingReport(directory);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    version: 2,
    rows: [
      ...completed,
      {
        phase: "channel-proxy-envoy-trust-rollout",
        parent: "controlled-channel-proxy",
        startMs: 5,
        endMs: 52,
        status: "ok",
      },
      { phase: "controlled-channel-proxy", parent: null, startMs: 0, endMs: 60, status: "ok" },
    ],
  });
});

test("channel proxy readiness waits for both branches before handoff or failure", async () => {
  const envoyError = new Error("Envoy trust rollout failed");
  const apiError = new Error("API readiness failed");
  const cases: { first: "envoy" | "api"; envoyFailure?: Error; apiFailure?: Error }[] = [
    { first: "envoy" },
    { first: "api" },
    { first: "envoy", envoyFailure: envoyError },
    { first: "api", apiFailure: apiError },
    { first: "api", apiFailure: apiError, envoyFailure: envoyError },
  ];
  for (const { first, envoyFailure, apiFailure } of cases) {
    const envoy = Promise.withResolvers<void>();
    const api = Promise.withResolvers<void>();
    const completeEnvoy = () => (envoyFailure ? envoy.reject(envoyFailure) : envoy.resolve());
    const completeApi = () => (apiFailure ? api.reject(apiFailure) : api.resolve());
    const handoff = Symbol("readiness handoff");
    let outcome: unknown;
    const done = waitForChannelProxyReadiness(envoy.promise, api.promise).then(
      () => {
        outcome = handoff;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    const [completeFirst, completeSecond] =
      first === "envoy" ? [completeEnvoy, completeApi] : [completeApi, completeEnvoy];
    completeFirst();
    await drainTurn();
    assert.equal(outcome, undefined, `${first} settled while its sibling was pending`);
    completeSecond();
    await done;
    assert.equal(outcome, envoyFailure ?? apiFailure ?? handoff);
  }
});

test("smoke timing isolates channel proxy deployments from subsequent checks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 1000;
  const { smokeStep, writeTimingReport } = createStepRecorder(() => clock);
  const peer = Promise.withResolvers<string>();
  const parent = "controlled-channel-proxy";
  const proxy = smokeStep(parent, async () => {
    clock += 3;
    const revisions = await smokeStep("channel-proxy-initial-deploy", () =>
      Promise.all([Promise.resolve("revision-a"), peer.promise]),
    );
    assert.deepEqual(revisions, ["revision-a", "revision-b"]);
    // Advance time between waits to model follow-up checks owned by the parent.
    clock += 5;
    await smokeStep("channel-proxy-move-deploy", () => {
      clock += 11;
    });
    clock += 7;
    await smokeStep("channel-proxy-clear-deploy", () => {
      clock += 13;
    });
    clock += 3;
    await smokeStep("channel-proxy-tls-control-deploy", () => {
      clock += 17;
    });
    clock += 2;
  });
  // Only the slower peer holds the initial deployment open during this delay.
  clock += 47;
  peer.resolve("revision-b");
  await proxy;
  await writeTimingReport(directory);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "first-agent-smoke-timing-v2.json"), "utf8")),
    {
      version: 2,
      rows: [
        {
          phase: "channel-proxy-initial-deploy",
          parent,
          startMs: 3,
          endMs: 50,
          status: "ok",
        },
        {
          phase: "channel-proxy-move-deploy",
          parent,
          startMs: 55,
          endMs: 66,
          status: "ok",
        },
        {
          phase: "channel-proxy-clear-deploy",
          parent,
          startMs: 73,
          endMs: 86,
          status: "ok",
        },
        {
          phase: "channel-proxy-tls-control-deploy",
          parent,
          startMs: 89,
          endMs: 106,
          status: "ok",
        },
        { phase: parent, parent: null, startMs: 0, endMs: 108, status: "ok" },
      ],
    },
  );
});

test("initial deployment timing distinguishes concurrent callers and omits a pending peer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 1000;
  const { smokeStep, writeTimingReport } = createStepRecorder(() => clock);
  const measureA = channelProxyDeploymentStep({
    smokeStep,
    context: "channel-proxy-initial-deploy-a",
  });
  const measureB = channelProxyDeploymentStep({
    smokeStep,
    context: "channel-proxy-initial-deploy-b",
  });
  const failingSubmit = Promise.withResolvers<never>();
  const peerWait = Promise.withResolvers<void>();
  const failure = new Error("private deployment diagnostic");
  const parent = "channel-proxy-initial-deploy";
  let peer: Promise<void> | undefined;
  const deployment = smokeStep(parent, () =>
    Promise.all([
      measureA("submit", () => failingSubmit.promise),
      measureB("submit", () => Promise.resolve("private peer revision")).then(() => {
        peer = measureB("wait", () => peerWait.promise);
        return peer;
      }),
    ]),
  );
  try {
    // Let B enter its wait before A's rejection closes the parent timing row.
    clock += 7;
    await drainTurn();
    assert.ok(peer);
    clock += 12;
    failingSubmit.reject(failure);
    await assert.rejects(deployment, (rejection) => rejection === failure);
    await writeTimingReport(directory);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "first-agent-smoke-timing-v2.json"), "utf8")),
      {
        version: 2,
        rows: [
          { phase: `${parent}-b-submit`, parent, endMs: 7, status: "ok" },
          { phase: `${parent}-a-submit`, parent, endMs: 19, status: "failed" },
          { phase: parent, parent: "controlled-channel-proxy", endMs: 19, status: "failed" },
        ].map((row) => ({ ...row, startMs: 0 })),
      },
    );
  } finally {
    failingSubmit.reject(failure);
    peerWait.resolve();
    await deployment.catch(() => {});
    await peer;
  }
});

test("smoke timing preserves a rejected proxy wait and omits unreached waits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [phase, nextPhase] of [
    ["channel-proxy-helm-wait", "channel-proxy-envoy-trust-rollout"],
    ["channel-proxy-move-deploy", "channel-proxy-clear-deploy"],
  ] as const) {
    let clock = 200;
    const { smokeStep, writeTimingReport } = createStepRecorder(() => clock);
    const error = new Error("unpublished proxy wait failure");
    const proxy = smokeStep("controlled-channel-proxy", async () => {
      await smokeStep(phase, async () => {
        clock += 12;
        throw error;
      });
      await smokeStep(nextPhase, () => assert.fail("a subsequent wait ran"));
    });
    await assert.rejects(proxy, (rejection) => rejection === error);
    await writeTimingReport(directory);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "first-agent-smoke-timing-v2.json"), "utf8")),
      {
        version: 2,
        rows: [
          { phase, parent: "controlled-channel-proxy", startMs: 0, endMs: 12, status: "failed" },
          {
            phase: "controlled-channel-proxy",
            parent: null,
            startMs: 0,
            endMs: 12,
            status: "failed",
          },
        ],
      },
    );
  }
});

test("the Actions smoke command reports no retirement waits when image setup is missing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-retirement-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../../scripts/ci/first-agent-smoke.ts", import.meta.url));
  const output = join(directory, "output");
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_TEMP: directory,
    OCC_FIRST_AGENT_SMOKE_DIRECTORY: directory,
  };
  // The empty work directory fails before retirement. An unwritable Actions output
  // must preserve the original diagnostic and exit code as well as the v2 timing report.
  for (const sink of [output, directory]) {
    await rm(join(directory, "first-agent-smoke-timing-v2.json"), { force: true });
    const command = spawnSync(process.execPath, [script, "run"], {
      encoding: "utf8",
      env: { ...env, GITHUB_OUTPUT: sink },
      timeout: 10_000,
    });
    assert.ifError(command.error);
    assert.equal(command.status, 1);
    assert.match(command.stderr, /first-agent-smoke: Error: Run .* images.* first/);
    assert.doesNotMatch(
      command.stderr + command.stdout,
      /::notice title=First Agent Smoke retirement wait::/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "first-agent-smoke-timing-v2.json"), "utf8")),
      { version: 2, rows: [] },
    );
  }
  assert.equal(
    await readFile(output, "utf8"),
    'retirement-notices={"status":"unreached","completed":0,"rows":[]}\n',
  );
});

test("chat proof accepts the deterministic assistant answer", () => {
  for (const content of [chatNonce, ` \t${chatNonce}\r\n`]) {
    assertChatReply({ ...validChatReply, content }, chatNonce, "embedded");
  }
});

test("chat proof rejects a prompt echo, missing role, and other non-assistant replies", () => {
  const prompt = `Reply with exactly this nonce and no other text: ${chatNonce}`;
  for (const role of ["user", undefined, "tool"]) {
    assert.throws(
      () => assertChatReply({ ...validChatReply, role }, chatNonce, "embedded"),
      /reply was not an assistant message/,
    );
  }
  for (const content of [prompt, `Answer: ${chatNonce}`, `${chatNonce} extra`]) {
    assert.throws(
      () => assertChatReply({ ...validChatReply, content }, chatNonce, "embedded"),
      /assistant reply did not equal the nonce/,
    );
  }
});

test("chat proof still requires HTTP success and the current nonce as text", () => {
  assert.throws(() => assertChatReply({ ...validChatReply, status: 503 }, chatNonce, "embedded"), {
    actual: 503,
    expected: 200,
  });
  assert.throws(() => assertChatReply({}, chatNonce, "embedded"), /before an HTTP response/);
  assert.throws(
    () => assertChatReply({ status: 200, invalidResponse: true }, chatNonce, "embedded"),
    /unreadable response/,
  );
  for (const content of ["OCE_SMOKE_previous", undefined, [chatNonce]]) {
    assert.throws(
      () => assertChatReply({ ...validChatReply, content }, chatNonce, "embedded"),
      /assistant reply did not equal the nonce/,
    );
  }
});

test("smoke API sends its key only to the selected controller origin", async (t) => {
  const requests: Array<[string | undefined, string | string[] | undefined]> = [];
  const port = await listen(
    t,
    createServer((request, response) => {
      requests.push([request.url, request.headers["x-api-key"]]);
      response.end('{"data":"ok"}');
    }),
  );
  const host = "127.0.0.1:" + port;
  const key = "synthetic-smoke-key";
  assert.equal(await createApi("http://" + host, key)("GET", "/namespaces"), "ok");
  const other = createApi("http://127.0.0.1:1", key);
  await assert.rejects(other("GET", "//" + host + "/unexpected"), /outside the controller origin/);
  assert.deepEqual(requests, [["/namespaces", key]]);
});

test("smoke API refuses a redirect instead of resending its key", async (t) => {
  const requests: Array<[string | undefined, string | string[] | undefined]> = [];
  const serve = async (handler: RequestListener) =>
    "http://127.0.0.1:" + (await listen(t, createServer(handler)));
  const elsewhere = await serve((request, response) => {
    requests.push([request.url, request.headers["x-api-key"]]);
    response.end('{"data":"ok"}');
  });
  const controller = await serve((request, response) => {
    response.writeHead(307, { location: elsewhere + "/collected" }).end();
  });
  await assert.rejects(
    createApi(controller, "synthetic-smoke-key")("GET", "/namespaces"),
    /^Error: GET \/namespaces: fetch failed: .*unexpected redirect$/,
  );
  assert.deepEqual(requests, []);
});

registerInstalledGitTransportCase();

function virtualClock() {
  let elapsed = 0;
  function sleep<T = void>(ms?: number, value?: T): Promise<T>;
  async function sleep(ms = 0, value?: unknown): Promise<unknown> {
    elapsed += ms;
    return value;
  }
  return {
    now: () => elapsed,
    sleep,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

function stoppedAt(clock: Pick<ReturnType<typeof virtualClock>, "now">, time: number) {
  return async () => ({
    desiredRuntimeState: "stopped",
    activeRevisionId: clock.now() < time ? revision : undefined,
    status: "active",
  });
}

test("stop observation accepts a fast shutdown and checks Pods afterward", async () => {
  const clock = virtualClock();
  let podReads = 0;
  await observeAgentStop(
    "embedded",
    stoppedAt(clock, 20_000),
    async () => {
      podReads += 1;
      return [];
    },
    clock,
  );
  assert.equal(clock.now(), 20_000);
  assert.equal(podReads, 1);
});

test("default stop observation covers the selected gateway grace", async () => {
  const clock = virtualClock();
  await observeAgentStop(
    "embedded",
    stoppedAt(clock, GATEWAY_STOP_TIMEOUT_MS - 15_000),
    async () => [],
    clock,
  );
  assert.ok(clock.now() > 300_000);
  assert.ok(clock.now() < GATEWAY_STOP_TIMEOUT_MS);
});

test("the second stop can wait behind the serial worker's first gateway drain", async () => {
  const clock = virtualClock();
  const activeClears = 2 * (GATEWAY_STOP_TIMEOUT_MS - 15_000);
  let observedPods = false;
  await observeAgentStop(
    "codex",
    stoppedAt(clock, activeClears),
    async () => {
      observedPods = true;
      return clock.now() < activeClears + 8_000 ? [{}] : [];
    },
    clock,
  );
  assert.equal(clock.now(), activeClears + 8_000);
  assert.ok(observedPods);
  assert.ok(clock.now() < STOP_PHASE_TIMEOUT_MS);
});

test("an explicit shorter deadline is authoritative and does not start a later Pod read", async () => {
  const clock = virtualClock();
  let podReads = 0;
  await assert.rejects(
    observeAgentStop(
      "embedded",
      stoppedAt(clock, 1_500),
      async () => {
        podReads += 1;
        return [];
      },
      { ...clock, timeout: 1_000 },
    ),
    /Timed out waiting for embedded to stop/,
  );
  assert.equal(clock.now(), 1_000);
  assert.equal(podReads, 0);
});

test("permanent nonconvergence retains the active-pointer assertion and bounded state", async () => {
  const clock = virtualClock();
  await assert.rejects(
    observeAgentStop("embedded", stoppedAt(clock, Infinity), async () => [], clock),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /active-revision/);
      assert.match(error.message, /elapsedMs/);
      assert.ok(error.message.includes(revision));
      return true;
    },
  );
  assert.equal(clock.now(), STOP_PHASE_TIMEOUT_MS);
});

test("a desired-state reversal fails without accepting an empty active pointer", async () => {
  const clock = virtualClock();
  let podReads = 0;
  await assert.rejects(
    observeAgentStop(
      "embedded",
      async () => ({ desiredRuntimeState: "running" }),
      async () => {
        podReads += 1;
        return [];
      },
      clock,
    ),
    /desired state changed while stopping/,
  );
  assert.equal(podReads, 0);
});

test("an empty active pointer does not accept remaining Pods", async () => {
  const clock = virtualClock();
  await assert.rejects(
    observeAgentStop("embedded", stoppedAt(clock, 0), async () => [{}], {
      ...clock,
      timeout: 5_000,
    }),
    /"phase":"pods".*"remainingPods":1/,
  );
  assert.equal(clock.now(), 5_000);
});

test("both observation stages share the explicit deadline", async () => {
  const clock = virtualClock();
  await assert.rejects(
    observeAgentStop(
      "embedded",
      stoppedAt(clock, 8_000),
      async () => (clock.now() < 12_000 ? [{}] : []),
      { ...clock, timeout: 10_000 },
    ),
    /Pods to terminate/,
  );
  assert.equal(clock.now(), 10_000);
});

test("invalid bounds fail before any observation", async () => {
  for (const timeout of [0, -1, Infinity, NaN, 1.5, null]) {
    let reads = 0;
    // Pass invalid values unchanged across the untyped smoke-script boundary.
    const observation: unknown = Reflect.apply(observeAgentStop, undefined, [
      "embedded",
      async () => {
        reads += 1;
      },
      async () => [],
      { timeout },
    ]);
    assert.ok(observation instanceof Promise);
    await assert.rejects(observation, /positive finite integer/);
    await assert.rejects(
      waitFor(
        "invalid",
        async () => {
          reads += 1;
        },
        timeout,
      ),
      /positive finite integer/,
    );
    assert.equal(reads, 0);
  }
});

test("an observation that returns after its explicit deadline cannot report success", async () => {
  const clock = virtualClock();
  await assert.rejects(
    waitFor(
      "late",
      async () => {
        clock.advance(1_001);
        return { done: true };
      },
      1_000,
      clock,
    ),
    /Timed out waiting for late/,
  );
});

test("failed diagnostic reads return a fixed marker without exposing or throwing the error", async () => {
  const state = await agentStopDiagnostic(async () => {
    throw new Error("synthetic-private-value");
  });
  assert.deepEqual(state, { phase: "agent-state", unavailable: true });
  assert.ok(!JSON.stringify(state).includes("synthetic-private-value"));
});

test("diagnostics project only fixed lifecycle fields", async () => {
  assert.deepEqual(
    await agentStopDiagnostic(async () => ({
      desiredRuntimeState: "stopped",
      activeRevisionId: revision,
      status: "active",
      unrelated: "synthetic-private-value",
    })),
    {
      phase: "agent-state",
      desiredRuntimeState: "stopped",
      activeRevisionId: revision,
      status: "active",
    },
  );
  const invalid = await agentStopDiagnostic(async () => ({
    desiredRuntimeState: "synthetic-private-value",
    activeRevisionId: "synthetic-private-value",
    status: "synthetic-private-value",
  }));
  assert.deepEqual(invalid, {
    phase: "agent-state",
    desiredRuntimeState: "unknown",
    activeRevisionId: "invalid",
    status: "unknown",
  });
});

test("a stopped gateway summary names its shutdown outcome and every clean-close receipt", () => {
  // Raw container lines, as kubectl logs returns them.
  const line = (subsystem: string, message: string) =>
    JSON.stringify({ level: "info", subsystem, message });
  assert.equal(
    stoppedGatewaySummary(
      [
        line("gateway", "received SIGTERM; shutting down"),
        line("state/agent-db", "agent database clean-close receipt: active-leases"),
        line("state/agent-db", "agent database clean-close receipt: written"),
        line("gateway/shutdown", "shutdown completed cleanly in 513ms"),
      ].join("\n"),
    ),
    "shutdown completed cleanly; clean-close receipts: active-leases, written",
  );
  assert.equal(
    stoppedGatewaySummary(
      [
        line("plugins", "Local model service shutdown failed: synthetic"),
        line("gateway/shutdown", "shutdown completed in 900ms with warnings: memory-managers"),
      ].join("\n"),
    ),
    "shutdown completed with warnings; clean-close receipts: none",
  );
  assert.equal(
    stoppedGatewaySummary(line("gateway/shutdown", "shutdown failed in 12ms: plugin-registry")),
    "shutdown failed; clean-close receipts: none",
  );
  // Finding 2198's shape: the Gateway stopped, but no receipt was logged.
  assert.equal(
    stoppedGatewaySummary(line("gateway", "received SIGTERM; shutting down")),
    "shutdown not logged; clean-close receipts: none",
  );
});

// Run the real watcher with real timers and no cluster. A `k3d` stand-in on PATH
// records each lookup and fails, as it does once `occ dev up` deletes its cluster.
async function withRecordedK3d(operation: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-smoke-k3d-"));
  const calls = join(directory, "calls");
  await writeFile(join(directory, "k3d"), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 1\n`, {
    mode: 0o755,
  });
  try {
    const started = Date.now();
    await withEnvironment({ PATH: commandPath(directory) }, operation);
    return {
      seconds: (Date.now() - started) / 1000,
      calls: await readFile(calls, "utf8").catch(() => ""),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a successful setup stops an idle watcher at once without another capture", async () => {
  const { seconds, calls } = await withRecordedK3d(() => watchCluster()());
  // The watcher idles for 30 seconds between captures; stopping must not wait for one.
  assert.ok(seconds < 5, `stop took ${seconds}s`);
  assert.equal(calls, "");
});

test("a failed setup stops the watcher at once with one final capture", async () => {
  const { seconds, calls } = await withRecordedK3d(() => watchCluster()({ finalCapture: true }));
  // The final snapshot keeps diagnostics for the failure without the idle wait.
  assert.ok(seconds < 5, `stop took ${seconds}s`);
  const { cluster } = smokeSlotNames(process.env.OCC_FIRST_AGENT_SMOKE_SLOT);
  assert.equal(calls, `kubeconfig get ${cluster}\n`);
});

test("a successful setup stops and reaps an in-flight watcher command", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-smoke-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ready = join(directory, "capture-started");
  const completed = join(directory, "capture-completed");
  await writeFile(join(directory, "k3d"), "#!/bin/sh\nprintf 'fixture kubeconfig\\n'\n", {
    mode: 0o755,
  });
  await writeFile(
    join(directory, "kubectl"),
    "#!" +
      process.execPath +
      "\n" +
      'const fs = require("node:fs");\n' +
      'if (process.argv.includes("wide")) {\n' +
      "  fs.writeFileSync(" +
      JSON.stringify(ready + ".tmp") +
      ", String(process.pid));\n" +
      "  fs.renameSync(" +
      JSON.stringify(ready + ".tmp") +
      ", " +
      JSON.stringify(ready) +
      ");\n" +
      "  setTimeout(() => fs.writeFileSync(" +
      JSON.stringify(completed) +
      ', "done"), 3000);\n' +
      "}\n",
    { mode: 0o755 },
  );
  await withEnvironment({ PATH: commandPath(directory) }, async () => {
    const stop = watchCluster({ directory, intervalMs: 1 });
    try {
      let pid: number | undefined;
      const deadline = Date.now() + 5_000;
      while (pid === undefined && Date.now() < deadline) {
        try {
          pid = Number(await readFile(ready, "utf8"));
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.ok(
        pid !== undefined && Number.isSafeInteger(pid) && pid > 0,
        "capture command started",
      );
      await stop();
      await assert.rejects(readFile(completed), { code: "ENOENT" });
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      await stop();
    }
  });
});

test("smoke slots keep CI's names at slot 0 and give other slots distinct host resources", () => {
  const ci = {
    cluster: "occ-dev-first-agent-smoke",
    registryContainer: "oce-first-agent-smoke-registry",
    registry: "127.0.0.1:5000",
    model: "oce-first-agent-smoke-model",
    subnet: "11.111.0.0/29",
    modelAddress: "11.111.0.2",
    nodeModelAddress: "11.111.0.3",
  };
  for (const unset of [undefined, "", "0"]) {
    assert.deepEqual(smokeSlotNames(unset), ci);
  }
  assert.deepEqual(smokeSlotNames("2"), {
    cluster: "occ-dev-smoke-s2",
    registryContainer: "oce-smoke-s2-registry",
    registry: "127.0.0.1:15002",
    model: "oce-smoke-s2-model",
    subnet: "11.111.0.16/29",
    modelAddress: "11.111.0.18",
    nodeModelAddress: "11.111.0.19",
  });
  assert.equal(smokeSlotNames("31").subnet, "11.111.0.248/29");
  const slots = Array.from({ length: 32 }, (_, slot) => smokeSlotNames(String(slot)));
  for (const field of Object.keys(ci) as Array<keyof typeof ci>) {
    assert.equal(new Set(slots.map((names) => names[field])).size, 32, field);
  }
});

test("a malformed or out-of-range smoke slot fails with the setting's name", () => {
  for (const value of ["-1", "32", "100", "01", "1.5", " 1", "1 ", "0x1", "one"]) {
    assert.throws(
      () => smokeSlotNames(value),
      /^Error: OCC_FIRST_AGENT_SMOKE_SLOT must be an integer from 0 to 31, got /,
      value,
    );
  }
});

test("cluster events print oldest to newest by observed instant, whatever field carries it", () => {
  const event = (
    name: string,
    times: {
      eventTime?: string;
      firstTimestamp?: string;
      lastTimestamp?: string;
      series?: { lastObservedTime: string; count: number };
    },
    count?: number,
  ) => ({
    metadata: { namespace: "occ-agent", name: `${name}.1` },
    involvedObject: { kind: "Pod", name: "harness-0" },
    type: "Normal",
    reason: name,
    message: `${name} message`,
    ...(count && { count }),
    ...times,
  });
  const second = "2026-10-23T00:00:10";
  const lines = clusterEventLines({
    items: [
      // eventTime-only writers have no lastTimestamp; --sort-by=.lastTimestamp printed them first.
      event("Newest", { eventTime: "2026-10-23T00:00:12.000001Z" }),
      event("SeriesLatest", {
        eventTime: "2026-10-23T00:00:01.000000Z",
        series: { lastObservedTime: "2026-10-23T00:00:11.500000Z", count: 4 },
      }),
      // Text order puts "10.100000Z" before "10Z"; the whole-second event is the older one.
      event("FractionalSameSecond", { eventTime: `${second}.100000Z` }),
      event(
        "WholeSecond",
        { firstTimestamp: "2026-10-23T00:00:00Z", lastTimestamp: `${second}Z` },
        3,
      ),
      event("Undated", {}),
    ],
  }).split("\n");
  assert.deepEqual(lines, [
    "unknown-time occ-agent Normal Undated Pod/harness-0: Undated message",
    `${second}Z occ-agent Normal WholeSecond Pod/harness-0 x3: WholeSecond message`,
    `${second}.100000Z occ-agent Normal FractionalSameSecond Pod/harness-0: FractionalSameSecond message`,
    "2026-10-23T00:00:11.500000Z occ-agent Normal SeriesLatest Pod/harness-0 x4: SeriesLatest message",
    "2026-10-23T00:00:12.000001Z occ-agent Normal Newest Pod/harness-0: Newest message",
  ]);
});

registerImageCases();
registerGitExpiryCase();
