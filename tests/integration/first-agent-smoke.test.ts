import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { GATEWAY_STOP_TIMEOUT_MS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { run } from "../../scripts/ci/first-agent-smoke/process.ts";
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
  assertAbsent,
  cutCredentials,
  cutOffsets,
  multiLineCredentials,
  registeredCutSecret,
} from "../fixtures/cut-credentials.ts";
import { setEnvironment, withEnvironment } from "../helpers/environment.ts";
import { commandPath, writeCommand } from "../helpers/fake-commands.ts";
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
    await readFile(join(directory, "first-agent-smoke-timing.json"), "utf8"),
  );
  assert.deepEqual(report, {
    version: 1,
    rows: [
      { phase: "admit-reader-control", startMs: 5, endMs: 10, status: "ok" },
      { phase: "admit-embedded", startMs: 0, endMs: 20, status: "ok" },
      { phase: "admit-codex", startMs: 2, endMs: 30, status: "ok" },
      { phase: "initial-admissions", startMs: 0, endMs: 30, status: "ok" },
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
    await readFile(join(directory, "first-agent-smoke-timing.json"), "utf8"),
  );
  assert.deepEqual(report, {
    version: 1,
    rows: [
      { phase: "admit-codex", startMs: 0, endMs: 8, status: "failed" },
      { phase: "initial-admissions", startMs: 0, endMs: 8, status: "failed" },
    ],
  });
  pending.resolve();
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

// Output whose last `limit` characters start `offset` characters into `text`, followed by every
// fixture credential uncut and by plain filler that fills the window.
function cutOutput(text: string, offset: number, limit: number) {
  const whole = cutCredentials.map((credential) => `uncut ${credential.text}`).join("\n");
  const rest = `${text.slice(offset)} end\n${whole}\n`;
  const filler = "filler ".repeat(Math.ceil(limit / 7)).slice(0, limit - rest.length - 1);
  return `earlier line\nfixture prefix ${text.slice(0, offset)}${rest}${filler}\n`;
}

// The First Agent Smoke prints these tails to the public job log. Each must mask a credential
// whole and must not show the piece left where the tail starts inside one.
async function assertTailsRedacted(
  t: TestContext,
  limit: number,
  shown: (output: string) => Promise<string>,
) {
  setEnvironment(t, { OCE_SMOKE_FIXTURE_REGISTERED: registeredCutSecret });
  for (const credential of cutCredentials) {
    for (const offset of cutOffsets(credential.text)) {
      const text = await shown(cutOutput(credential.text, offset, limit));
      const label = `${credential.name} cut ${offset} in`;
      assert.match(text, /filler filler/u, `${label} keeps the rest of the tail`);
      for (const value of cutCredentials) {
        assertAbsent(text, value.secret, `${label}: ${value.name}`);
      }
    }
  }
}

// Calls a smoke module's function in a new Node process, as the CI step does, and returns what
// it wrote to the job log.
async function smokeStdout(module: string, call: string, env: NodeJS.ProcessEnv = process.env) {
  const url = new URL(`../../scripts/ci/first-agent-smoke/${module}`, import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(url)}); await m.${call};`,
    ],
    { env, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

// The error message of a command that writes `output` to stderr and fails.
async function failedRunMessage(output: string) {
  const failure = await run(
    process.execPath,
    ["-e", "process.stderr.write(require('node:fs').readFileSync(0, 'utf8')); process.exit(3)"],
    { input: output },
  ).then(
    () => assert.fail("the command must fail"),
    (error: unknown) => error as Error,
  );
  assert.match(failure.message, /exited 3\n/u);
  return failure.message;
}

test("a failed command's error message redacts its stderr tail from a whole line", async (t) => {
  await assertTailsRedacted(t, 4_000, failedRunMessage);
});

test("a cut stderr tail with no whole line left prints a marker instead", async () => {
  // One line longer than the 4,000-character tail, with and without a final line break. All
  // that is left after the cut is part of that line, which is dropped, so the reader must see
  // why the block is empty. The marker is fixed text: nothing of the output is in it.
  const line = `fixture prefix ${"filler ".repeat(600)}${cutCredentials
    .filter((credential) => !credential.text.includes("\n"))
    .map((credential) => credential.text)
    .join(" ")}`;
  for (const output of [line, `${line}\n`]) {
    const message = await failedRunMessage(output);
    assert.equal(
      message.slice(message.indexOf("exited 3\n") + "exited 3\n".length),
      "[diagnostics: output cut at 4000 characters; first line dropped]",
    );
  }
});

test("a cut stderr tail of only structured supervisor events prints the marker", async () => {
  // Each such line prints empty, so a cut tail of them alone would be a run of blank lines.
  const event = `OCSF-JSON {"n":"${"e".repeat(80)}"}`;
  const events = Array.from({ length: 60 }, (_, index) => `${index} ${event}`);
  const shown = async (output: string) => {
    const message = await failedRunMessage(output);
    return message.slice(message.indexOf("exited 3\n") + "exited 3\n".length);
  };
  assert.equal(
    await shown(events.join("\n")),
    "[diagnostics: output cut at 4000 characters; first line dropped]",
  );
  // An uncut block keeps its blank lines.
  assert.equal(await shown(events.slice(0, 3).join("\n")), "\n\n");
});

test("a cut stderr tail masks a key with no END whose header is whole on the cut line", async () => {
  // The cut falls in the log prefix before the header: only redacting before the cut line is
  // dropped masks the body, since that line holds the header that starts the key.
  const key = multiLineCredentials.find(({ name }) => name === "a private key block with no END")!;
  const line = `2026-11-21T08:00:00Z gateway ${key.text}`;
  for (const offset of [1, line.indexOf("-----BEGIN") - 1]) {
    const after = "after the key\n".repeat(300).slice(0, 4_000 - (line.length - offset) - 1);
    const message = await failedRunMessage(`earlier line\n${line}\n${after}`);
    for (const secret of key.secrets) {
      assertAbsent(message, secret, `cut ${offset} in`);
    }
  }
});

test("diagnostics redact command output in the job log from a whole line", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-smoke-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  // The stand-in provider's `docker logs` is the read diagnostics makes before any cluster exists.
  await writeCommand(
    directory,
    "docker",
    `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(output)}, "utf8"));`,
    { interpreter: process.execPath },
  );
  await assertTailsRedacted(t, 20_000, async (text) => {
    await writeFile(output, text);
    const printed = await smokeStdout("reader.ts", "diagnostics(undefined)", {
      ...process.env,
      PATH: commandPath(directory),
    });
    assert.match(printed, /----- stand-in provider events\n/u);
    return printed;
  });
});

test("the cluster watch log after a failed setup is redacted from a whole line", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-smoke-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "cluster-watch.log");
  await assertTailsRedacted(t, 60_000, async (text) => {
    await writeFile(log, text);
    return smokeStdout("setup.ts", `printWatchLog(${JSON.stringify(log)})`);
  });
});

test("diagnostics redact the logs kept from a stopped gateway", async (t) => {
  setEnvironment(t, { OCE_SMOKE_FIXTURE_REGISTERED: registeredCutSecret });
  const directory = await mkdtemp(join(tmpdir(), "first-agent-smoke-stopped-gateway-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // With no cluster, every other read diagnostics makes fails at once and is reported as
  // unavailable; the kept log is printed from the Agent record the stop filled.
  await writeCommand(directory, "docker", "exit 1");
  await writeCommand(directory, "kubectl", "exit 1");
  const kept = join(directory, "stopped-gateway.log");
  // The log follower keeps whole lines, so each credential starts on its own line.
  await writeFile(
    kept,
    [
      "gateway started",
      ...cutCredentials.map((credential) => `gateway ${credential.text}`),
      "gateway shutdown completed cleanly in 12ms",
    ].join("\n"),
  );
  const stack = `{
    kubeconfig: "missing",
    context: "missing",
    namespaceId: "ns_missing",
    state: { platformNamespace: "missing" },
    api: async () => { throw new Error("no API"); },
    agents: [{
      id: "agent_missing",
      label: "fixture",
      stoppedGatewayLogs: [await (await import("node:fs/promises")).readFile(${JSON.stringify(kept)}, "utf8")],
    }],
  }`;
  const printed = await smokeStdout("reader.ts", `diagnostics(${stack})`, {
    ...process.env,
    PATH: commandPath(directory),
  });
  assert.match(printed, /----- fixture stopped gateway 1 logs\ngateway started\n/u);
  assert.match(printed, /\ngateway shutdown completed cleanly in 12ms\n/u);
  for (const value of cutCredentials) {
    assertAbsent(printed, value.secret, `stopped gateway logs: ${value.name}`);
  }
});

test("a failed diagnostics read prints its error redacted before the 500-character cut", async (t) => {
  setEnvironment(t, { OCE_SMOKE_FIXTURE_REGISTERED: registeredCutSecret });
  const directory = await mkdtemp(join(tmpdir(), "first-agent-smoke-read-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeCommand(directory, "docker", "exit 1");
  await writeCommand(directory, "kubectl", "exit 1");
  // Each fixture credential whole in an error message, with the cut at 500 characters inside it.
  const messages = cutCredentials.flatMap((credential) =>
    cutOffsets(credential.text).map(
      (offset) => `${"filler ".repeat(80).slice(offset - 500)}${credential.text} end`,
    ),
  );
  // Each Agent makes three reads through the CLI; reading the stack's origin throws the next one.
  const stack = `{
    kubeconfig: "missing",
    context: "missing",
    namespaceId: "ns_missing",
    state: { platformNamespace: "missing" },
    api: async () => { throw new Error("no API"); },
    messages: ${JSON.stringify(messages)},
    get origin() { throw new Error(this.messages.shift()); },
    agents: Array.from({ length: ${messages.length / 3} }, (_, i) => ({ id: "agent_" + i, label: "fixture" })),
  }`;
  const printed = await smokeStdout("reader.ts", `diagnostics(${stack})`, {
    ...process.env,
    PATH: commandPath(directory),
  });
  assert.equal(printed.match(/^----- fixture [a-z ]+ unavailable: /gmu)?.length, messages.length);
  for (const value of cutCredentials) {
    assertAbsent(printed, value.secret, `failed read: ${value.name}`);
  }
});

registerImageCases();
registerGitExpiryCase();
