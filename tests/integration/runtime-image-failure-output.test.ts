// The image smoke helpers put container output in their errors, and CI keeps
// only the first 16 KiB of a failure message. Finding 976 misread such a cut log
// as a Doctor stall: the wrapper's stderr and the real failure came after the
// cut. These cases drive the helper against a stand-in docker binary.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import test, { type TestContext } from "node:test";
import { setEnvironment } from "../helpers/environment.ts";
import { writeCommand } from "../helpers/fake-commands.ts";
import { fileTemporaryDirectory } from "../helpers/temporary-directory.mjs";

const reporterMessageLimit = 16_384;

const root = fileTemporaryDirectory("oce-runtime-image-failure-output-");
const fakeDocker = await writeCommand(
  root,
  "docker",
  `import(${JSON.stringify(new URL("../fixtures/runtime-image-failure-docker.ts", import.meta.url).href)});`,
  { interpreter: process.execPath },
);

// The helper reads both at import.
process.env.OCC_DOCKER_BIN = fakeDocker;
process.env.OCC_TEST_RUNTIME_IMAGE = "localhost/oce/runtime:failure-output-test";
const {
  containerLogTail,
  failureTail,
  gatewayReadinessReport,
  listGatewayPlugins,
  runDocker,
  runGatewaySmoke,
  waitForDockerLog,
  waitForGatewayReady,
} = await import("../helpers/runtime-image-startup.mjs");
const { followContainer } = await import("../helpers/docker-follow.ts");

async function expectFailure<T>(operation: Promise<T>, message: string): Promise<Error> {
  try {
    await operation;
  } catch (failure) {
    assert.ok(failure instanceof Error);
    return failure;
  }
  assert.fail(message);
}

test("failureTail keeps short output and the end of long output from a line start", () => {
  assert.equal(failureTail("short output", 64), "short output");
  const output = `${"a".repeat(100)}${"b".repeat(20)}`;
  assert.equal(failureTail(output, 20), `[... 100 earlier chars omitted ...]\n${"b".repeat(20)}`);
  // A line cut by the limit is dropped, so a cut value never reaches the message.
  assert.equal(
    failureTail("first line\npartial secret value\nlast line\n", 25),
    "[... 32 earlier chars omitted ...]\nlast line\n",
  );
  // Output exactly at the limit is kept whole.
  assert.equal(failureTail("c".repeat(64), 64), "c".repeat(64));
  // A line start at most 1023 chars into the tail is used; a later one would drop too much.
  const near = `${"p".repeat(1023)}\n${"q".repeat(1024)}`;
  assert.equal(
    failureTail(`${"z".repeat(10)}${near}`, near.length),
    `[... 1034 earlier chars omitted ...]\n${"q".repeat(1024)}`,
  );
  const far = `${"p".repeat(1024)}\n${"q".repeat(1023)}`;
  assert.equal(
    failureTail(`${"z".repeat(10)}${far}`, far.length),
    `[... 10 earlier chars omitted ...]\n${far}`,
  );
});

// Each of these failures would otherwise put about 5 KiB of command output in its message.
function assertKeptTail(message: string, label: string, limit: number) {
  assert.match(message, new RegExp(`${label} final line`));
  assert.doesNotMatch(message, new RegExp(`${label} first line`));
  assert.match(message, /\[\.\.\. \d+ earlier chars omitted \.\.\.\]/);
  assert.ok(message.length < limit, `message is ${message.length} chars`);
}

test("readiness and plugin list failures keep the end of their command output", async (t) => {
  setEnvironment(t, { FAKE_DOCKER_MODE: "running" });
  const readiness = await expectFailure(
    waitForGatewayReady("fake-container", 1),
    "readiness should time out when every probe fails",
  );
  assert.match(readiness.message, /^Gateway readiness timed out\.\n/);
  assertKeptTail(readiness.message, "readiness stderr", 2048 + 128);
  const plugins = await expectFailure(
    listGatewayPlugins("fake-container"),
    "plugin list output that is not JSON should be refused",
  );
  assert.match(plugins.message, /^OpenClaw plugin list output was not valid JSON\.\n/);
  assertKeptTail(plugins.message, "plugin list", 2048 + 128);

  setEnvironment(t, { FAKE_DOCKER_MODE: "malformed-inspect-status" });
  const invalidStatus = await expectFailure(
    waitForGatewayReady("fake-container", 1),
    "readiness should fail when neither the probe nor inspect can establish readiness",
  );
  // A successful Docker command can still fail to establish that the container exited.
  assert.match(
    invalidStatus.message,
    /^Gateway readiness probe failed; docker inspect returned invalid state\.\n/,
  );
  assertKeptTail(invalidStatus.message, "readiness stderr", 2048 + 256);
  assert.ok(invalidStatus.cause instanceof Error);
  assert.match(invalidStatus.cause.message, /^docker exec fake-container .* failed \(exit code 1,/);
});

test("a Gateway smoke failure with over 16 KiB of logs keeps their final lines within the CI cut", async (t) => {
  const error = await expectFailure(
    runGatewaySmoke(t, "openclaw"),
    "the Gateway smoke should fail when the container exits",
  );
  // What the CI reporter keeps of the message.
  const reported = error.message.slice(0, reporterMessageLimit);
  assert.match(reported, /^Gateway container exited before readiness with code 1\.\n/);
  assert.match(reported, /Migrating agent databases\nwrapper failed: final stderr line/);
  assert.match(reported, /doctor check 399: x+\n/);
  assert.match(reported, /\[\.\.\. \d+ earlier chars omitted \.\.\.\]/);
  assert.doesNotMatch(reported, /first doctor line/);
  assert.ok(
    error.message.length < reporterMessageLimit,
    `message is ${error.message.length} chars`,
  );
});

test("a Gateway smoke failure from a docker command keeps the end of its stderr and of the logs", async (t) => {
  setEnvironment(t, { FAKE_DOCKER_MODE: "inspect-fails" });
  const error = await expectFailure(
    runGatewaySmoke(t, "openclaw"),
    "the Gateway smoke should fail when docker inspect fails",
  );
  const reported = error.message.slice(0, reporterMessageLimit);
  // The headline names the command and its exit; its stderr follows, cut to its end, then
  // the logs' end.
  assert.match(
    reported,
    /^docker inspect [^\n]* failed \(exit code 1, signal none, not timed out, ran \d+ ms\)\.\n[\s\S]*inspect stderr final line\n[\s\S]*wrapper failed: final stderr line/,
  );
  assert.doesNotMatch(reported, /inspect stderr first line/);
  assert.ok(
    error.message.length < reporterMessageLimit,
    `message is ${error.message.length} chars`,
  );
});

test("a log wait fails at once when the container stops first, keeping the end of its logs", async () => {
  // The stand-in's `docker logs --follow` prints the logs and exits, as for a stopped container.
  const startedAt = Date.now();
  const error = await expectFailure(
    waitForDockerLog("fake-container", /never logged/),
    "the log wait should fail when the logs end without the pattern",
  );
  assert.ok(Date.now() - startedAt < 10_000, "the wait does not run out its 20 s deadline");
  assert.match(
    error.message,
    /^fake-container stopped before \/never logged\/ appeared in its logs\.\n/,
  );
  assert.match(error.message, /Migrating agent databases\nwrapper failed: final stderr line/);
  assert.doesNotMatch(error.message, /first doctor line/);
  assert.ok(
    error.message.length < reporterMessageLimit,
    `message is ${error.message.length} chars`,
  );
});

test("a follower whose docker wait never returns takes the exit, and its time, from inspect", async (t) => {
  setEnvironment(t, { FAKE_DOCKER_MODE: "wait-hangs" });
  const follower = followContainer(t, "fake-container");
  assert.equal(follower.read().exitedAt, undefined);
  assert.deepEqual(await follower.inspect(), {
    running: false,
    exitCode: 0,
    finishedAt: Date.parse("2026-10-21T08:52:18.75Z"),
  });
  while (follower.read().running) {
    await follower.changes.wait(follower.changes.version, 10_000);
  }
  const state = follower.read();
  assert.equal(state.exitedAt, Date.parse("2026-10-21T08:52:18.75Z"));
  assert.equal(state.exitCode, 0);
  assert.match(state.stderr, /wrapper failed: final stderr line\n$/);
});

test("an inspect without a real exit time counts the exit from when it was seen", async (t) => {
  setEnvironment(t, { FAKE_DOCKER_MODE: "wait-hangs-no-finish" });
  const follower = followContainer(t, "fake-container");
  const before = Date.now();
  const inspection = await follower.inspect();
  assert.ok(inspection);
  assert.equal(inspection.finishedAt, undefined);
  const exitedAt = follower.read().exitedAt;
  assert.ok(exitedAt !== undefined && exitedAt >= before, "not Docker's zero time");
});

test("a failed docker wait asks inspect, and an exit older than the start counts from now", async (t) => {
  setEnvironment(t, { FAKE_DOCKER_MODE: "wait-fails-restarted" });
  const before = Date.now();
  const follower = followContainer(t, "fake-container");
  while (follower.read().exitedAt === undefined) {
    await follower.changes.wait(follower.changes.version, 10_000);
  }
  // No "docker wait ... failed": inspect found the exit.
  const state = follower.read();
  assert.equal(state.exitCode, 0);
  assert.ok(
    state.exitedAt !== undefined && state.exitedAt >= before,
    "not the restarted container's earlier exit",
  );
});

// Finding 2184: a docker run whose output was empty failed with an empty message, so neither
// the exit code nor a timeout could be told from the CI diagnostics.
async function dockerFailure(
  t: TestContext,
  mode: string,
  args: string[],
  options?: Parameters<typeof runDocker>[1],
) {
  setEnvironment(t, { FAKE_DOCKER_MODE: mode });
  return expectFailure(runDocker(args, options ?? {}), `docker ${mode} should fail`);
}

test("a docker failure with no output names its exit code", async (t) => {
  const script = "set -eu\necho multi-line probe";
  const error = await dockerFailure(t, "exit-silent", ["run", "--rm", "probe", "-c", script]);
  assert.equal(
    error.message.replace(/ran \d+ ms/, "ran N ms"),
    "docker run --rm probe -c <29-char argument> failed " +
      "(exit code 3, signal none, not timed out, ran N ms).\n(no stdout or stderr)",
  );
  assert.ok(
    "code" in error &&
      "signal" in error &&
      "timedOut" in error &&
      "stdout" in error &&
      "stderr" in error,
  );
  assert.equal(error.code, 3);
  assert.equal(error.signal, null);
  assert.equal(error.timedOut, false);
  assert.equal(error.stdout, "");
  assert.equal(error.stderr, "");
});

test("a docker command stopped by its timeout says so", async (t) => {
  const error = await dockerFailure(t, "hang", ["wait", "fake-container"], { timeout: 200 });
  assert.match(
    error.message,
    /^docker wait fake-container failed \(no exit code, signal SIGTERM, timed out after 200 ms, ran \d+ ms\)\.\n\(no stdout or stderr\)$/,
  );
  assert.ok("killed" in error && "timedOut" in error && "signal" in error);
  assert.equal(error.killed, true);
  assert.equal(error.timedOut, true);
  assert.equal(error.signal, "SIGTERM");
});

test("a docker failure never shows a planted synthetic key", async (t) => {
  // One key in the sk- shape the CI redaction knows, one plain value the caller names.
  const key = "sk-oce-planted-synthetic-key-2184";
  const plain = "planted-plain-value-2184";
  setEnvironment(t, { FAKE_DOCKER_KEY: key, FAKE_DOCKER_PLAIN: plain });
  const error = await dockerFailure(
    t,
    "leak-key",
    ["run", "-e", `SYNTHETIC_KEY=${key}`, "-e", `PLAIN=${plain}`, "probe"],
    { redact: [plain] },
  );
  assert.equal(error.message.includes(key), false, error.message);
  assert.equal(error.message.includes(plain), false, error.message);
  assert.match(
    error.message,
    /^docker run -e SYNTHETIC_KEY=\[redacted\] -e PLAIN=\[redacted\] probe failed \(exit code 1,/,
  );
  // stderr comes last, so a caller's tail cut keeps it.
  assert.match(
    error.message,
    /\nstdout:\nstdout key \[redacted\]\n\nstderr:\nstderr key \[redacted\]\nplanted \[redacted\]\n$/,
  );
  // Printing the whole error shows the raw output neither.
  assert.equal(inspect(error).includes(plain), false);
  // A value the tail cut splits is still redacted whole, before the cut.
  const long = await dockerFailure(t, "leak-long", ["run", "probe"], { redact: [plain] });
  assert.equal(long.message.includes(plain.slice(-10)), false, long.message.slice(0, 400));
  // Callers that read the output themselves still get it whole.
  assert.ok("stderr" in error && typeof error.stderr === "string");
  assert.match(error.stderr, /planted planted-plain-value-2184/);
});

test("a docker command's stdin reaches it, and an early exit reports the exit, not the pipe", async (t) => {
  setEnvironment(t, { FAKE_DOCKER_MODE: "cat" });
  const { stdout } = await runDocker(["exec", "-i", "fake-container", "cat"], {}, "stdin text\n");
  assert.equal(stdout, "stdin text\n");
  // The stand-in exits 3 without reading 4 MiB of input.
  process.env.FAKE_DOCKER_MODE = "exit-silent";
  const error = await expectFailure(
    runDocker(["exec", "-i", "fake-container", "cat"], {}, "x".repeat(4 << 20)),
    "the command should fail",
  );
  assert.ok("code" in error);
  assert.equal(error.code, 3);
  assert.match(error.message, /^docker exec -i fake-container cat failed \(exit code 3,/);
});

test("a readiness report keeps independent diagnostics when Docker returns malformed JSON output", async (t) => {
  const probe = {
    wrapperReady: { status: 503, ms: 4, body: "not ready" },
    plugin: { status: 200, fields: { phase: "failed", failures: [{ code: "PLUGIN_FAILED" }] } },
    runtime: {
      status: 200,
      fields: { runtimeFailure: { check: "workspace", code: "WORKSPACE_SETUP_FAILED" } },
    },
    nativeStartup: { error: "ECONNREFUSED", ms: 2 },
    nativeReady: { status: 503, ms: 3 },
  };
  const inspectOutput = JSON.stringify([
    {
      State: {
        StartedAt: "2026-10-21T08:51:50.1Z",
        Status: "running",
        ExitCode: 0,
        OOMKilled: false,
      },
    },
  ]);
  const phaseDetail =
    "wrapper phases since start (duration/since start): model-probe:failed AUTHENTICATION_FAILED 5/12 ms";
  setEnvironment(t, {
    FAKE_DOCKER_MODE: "readiness-report",
    FAKE_DOCKER_INSPECT_OUTPUT: inspectOutput,
    FAKE_DOCKER_PROBE_OUTPUT: JSON.stringify(probe),
  });
  const valid = await gatewayReadinessReport("fake-container");
  assert.match(
    valid.headline,
    /^wrapper \/readyz 503; plugin phase failed \(failures PLUGIN_FAILED\); runtime failure workspace\/WORKSPACE_SETUP_FAILED; native \/startupz error ECONNREFUSED, \/readyz 503;/,
  );
  assert.equal(valid.detail, "status probe: " + JSON.stringify(probe) + "\n" + phaseDetail);

  // A failed status probe must leave the restart caller with the container and its phase history.
  const malformedProbe = {
    ...probe,
    plugin: { status: 200, fields: { failures: { code: "PLUGIN_FAILED" } } },
  };
  for (const [output, diagnosis] of [
    [JSON.stringify(malformedProbe), "Gateway status probe output had an unexpected shape."],
    ["{".repeat(5000), "Gateway status probe output was not valid JSON."],
  ]) {
    setEnvironment(t, { FAKE_DOCKER_PROBE_OUTPUT: output });
    const report = await gatewayReadinessReport("fake-container");
    assert.ok(report.headline.startsWith("status probe failed: " + diagnosis));
    assert.match(
      report.headline,
      /last phase model-probe:failed AUTHENTICATION_FAILED 5\/12 ms; container running, started -?\d+ s ago, exit 0, OOMKilled false;/,
    );
    assert.equal(
      report.detail,
      "status probe: " + JSON.stringify({ error: diagnosis }) + "\n" + phaseDetail,
    );
  }

  // Inspect can lose its state while the status probe can still explain why readiness failed.
  setEnvironment(t, {
    FAKE_DOCKER_INSPECT_OUTPUT: "[{}]",
    FAKE_DOCKER_PROBE_OUTPUT: JSON.stringify(probe),
  });
  const report = await gatewayReadinessReport("fake-container");
  assert.match(report.headline, /runtime failure workspace\/WORKSPACE_SETUP_FAILED;/);
  assert.match(report.headline, /container Docker inspect output had an unexpected shape\.;/);
  assert.equal(
    report.detail,
    "status probe: " +
      JSON.stringify(probe) +
      "\nwrapper phases since start (duration/since start): none",
  );
});

test("the newest timestamped container log survives a tail cut across CRLF and LF streams", async (t) => {
  setEnvironment(t, { FAKE_DOCKER_MODE: "mixed-line-endings" });
  const tail = await containerLogTail("fake-container", { limit: 55 });
  assert.match(
    tail,
    /\[\.\.\. \d+ earlier chars omitted \.\.\.\]\n2026-10-21T08:52:18\.75Z stdout: newer wrapper failure$/,
  );
  assert.doesNotMatch(tail, /older wrapper warning/);
});
