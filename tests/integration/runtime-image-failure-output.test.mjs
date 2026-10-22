// The image smoke helpers put container output in their errors, and CI keeps
// only the first 16 KiB of a failure message. Finding 976 misread such a cut log
// as a Doctor stall: the wrapper's stderr and the real failure came after the
// cut. These cases drive the helper against a stand-in docker binary.
import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { fileTemporaryDirectory } from "../helpers/temporary-directory.mjs";

const reporterMessageLimit = 16_384;

const root = fileTemporaryDirectory("oce-runtime-image-failure-output-");
const fakeDocker = join(root, "docker");
await writeFile(
  fakeDocker,
  `#!${process.execPath}
const [command, , program, entry] = process.argv.slice(2);
const mode = process.env.FAKE_DOCKER_MODE ?? "exited";
// Long multi-line output whose first and last lines name where it came from.
const long = (label) => {
  let text = \`\${label} first line\\n\`;
  for (let index = 0; index < 100; index += 1) {
    text += \`\${label} line \${index}: \${"y".repeat(40)}\\n\`;
  }
  return \`\${text}\${label} final line\\n\`;
};
if (mode === "exit-silent") {
  process.exit(3);
} else if (mode === "leak-long") {
  // One long line, so the stderr tail starts inside the planted value.
  process.stderr.write(\`\${"z".repeat(9000)}\${process.env.FAKE_DOCKER_PLAIN}\${"w".repeat(8180)}\\n\`);
  process.exit(1);
} else if (mode === "cat") {
  process.stdin.pipe(process.stdout);
} else if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (mode === "leak-key") {
  process.stdout.write(\`stdout key \${process.env.FAKE_DOCKER_KEY}\n\`);
  process.stderr.write(\`stderr key \${process.env.FAKE_DOCKER_KEY}\nplanted \${process.env.FAKE_DOCKER_PLAIN}\n\`);
  process.exit(1);
} else if (command === "inspect" && mode === "inspect-fails") {
  process.stderr.write(long("inspect stderr"));
  process.exit(1);
} else if (command === "inspect" && mode.startsWith("wait-")) {
  // Running, exit code, StartedAt and FinishedAt, as the follower's --format asks.
  const finishedAt = {
    "wait-hangs": "2026-10-21T08:52:18.75Z",
    "wait-hangs-no-finish": "0001-01-01T00:00:00Z",
    // A restarted container's last exit is older than its current start.
    "wait-fails-restarted": "2026-10-21T08:51:40Z",
  }[mode];
  process.stdout.write(\`false|0|2026-10-21T08:51:50.1Z|\${finishedAt}\\n\`);
} else if (command === "wait" && mode === "wait-fails-restarted") {
  process.stderr.write("Error response from daemon: context deadline exceeded\\n");
  process.exit(1);
} else if (command === "inspect") {
  process.stdout.write(mode === "exited" ? "false 1\\n" : "true 0\\n");
} else if (command === "wait" && mode.startsWith("wait-hangs")) {
  setInterval(() => {}, 1_000);
} else if (command === "exec" && entry === "/app/openclaw.mjs") {
  process.stdout.write(long("plugin list"));
} else if (command === "exec" && program === "node") {
  process.stderr.write(long("readiness stderr"));
  process.exit(1);
} else if (command === "logs") {
  process.stdout.write("first doctor line\\n");
  for (let index = 0; index < 400; index += 1) {
    process.stdout.write(\`doctor check \${index}: \${"x".repeat(60)}\\n\`);
  }
  process.stderr.write("Migrating agent databases\\nwrapper failed: final stderr line\\n");
} else if (command === "run") {
  process.stdout.write("fake-container-id\\n");
}
`,
);
await chmod(fakeDocker, 0o700);

// The helper reads both at import.
process.env.OCC_DOCKER_BIN = fakeDocker;
process.env.OCC_TEST_RUNTIME_IMAGE = "localhost/oce/runtime:failure-output-test";
const {
  failureTail,
  listGatewayPlugins,
  runDocker,
  runGatewaySmoke,
  waitForDockerLog,
  waitForGatewayReady,
} = await import("../helpers/runtime-image-startup.mjs");
const { followContainer } = await import("../helpers/docker-follow.mjs");

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
function assertKeptTail(message, label, limit) {
  assert.match(message, new RegExp(`${label} final line`));
  assert.doesNotMatch(message, new RegExp(`${label} first line`));
  assert.match(message, /\[\.\.\. \d+ earlier chars omitted \.\.\.\]/);
  assert.ok(message.length < limit, `message is ${message.length} chars`);
}

test("readiness and plugin list failures keep the end of their command output", async (t) => {
  process.env.FAKE_DOCKER_MODE = "running";
  t.after(() => delete process.env.FAKE_DOCKER_MODE);
  const readiness = await waitForGatewayReady("fake-container", 1).then(
    () => assert.fail("readiness should time out when every probe fails"),
    (failure) => failure,
  );
  assert.match(readiness.message, /^Gateway readiness timed out\.\n/);
  assertKeptTail(readiness.message, "readiness stderr", 2048 + 128);
  const plugins = await listGatewayPlugins("fake-container").then(
    () => assert.fail("plugin list output that is not JSON should be refused"),
    (failure) => failure,
  );
  assert.match(plugins.message, /^OpenClaw plugin list output was not valid JSON\.\n/);
  assertKeptTail(plugins.message, "plugin list", 2048 + 128);
});

test("a Gateway smoke failure with over 16 KiB of logs keeps their final lines within the CI cut", async (t) => {
  const error = await runGatewaySmoke(t, "openclaw").then(
    () => assert.fail("the Gateway smoke should fail when the container exits"),
    (failure) => failure,
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
  process.env.FAKE_DOCKER_MODE = "inspect-fails";
  t.after(() => delete process.env.FAKE_DOCKER_MODE);
  const error = await runGatewaySmoke(t, "openclaw").then(
    () => assert.fail("the Gateway smoke should fail when docker inspect fails"),
    (failure) => failure,
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
  const error = await waitForDockerLog("fake-container", /never logged/).then(
    () => assert.fail("the log wait should fail when the logs end without the pattern"),
    (failure) => failure,
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
  process.env.FAKE_DOCKER_MODE = "wait-hangs";
  t.after(() => delete process.env.FAKE_DOCKER_MODE);
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
  process.env.FAKE_DOCKER_MODE = "wait-hangs-no-finish";
  t.after(() => delete process.env.FAKE_DOCKER_MODE);
  const follower = followContainer(t, "fake-container");
  const before = Date.now();
  assert.equal((await follower.inspect()).finishedAt, undefined);
  assert.ok(follower.read().exitedAt >= before, "not Docker's zero time");
});

test("a failed docker wait asks inspect, and an exit older than the start counts from now", async (t) => {
  process.env.FAKE_DOCKER_MODE = "wait-fails-restarted";
  t.after(() => delete process.env.FAKE_DOCKER_MODE);
  const before = Date.now();
  const follower = followContainer(t, "fake-container");
  while (follower.read().exitedAt === undefined) {
    await follower.changes.wait(follower.changes.version, 10_000);
  }
  // No "docker wait ... failed": inspect found the exit.
  const state = follower.read();
  assert.equal(state.exitCode, 0);
  assert.ok(state.exitedAt >= before, "not the restarted container's earlier exit");
});

// Finding 2184: a docker run whose output was empty failed with an empty message, so neither
// the exit code nor a timeout could be told from the CI diagnostics.
async function dockerFailure(t, mode, args, options) {
  process.env.FAKE_DOCKER_MODE = mode;
  t.after(() => delete process.env.FAKE_DOCKER_MODE);
  return runDocker(args, options).then(
    () => assert.fail(`docker ${mode} should fail`),
    (failure) => failure,
  );
}

test("a docker failure with no output names its exit code", async (t) => {
  const script = "set -eu\necho multi-line probe";
  const error = await dockerFailure(t, "exit-silent", ["run", "--rm", "probe", "-c", script]);
  assert.equal(
    error.message.replace(/ran \d+ ms/, "ran N ms"),
    "docker run --rm probe -c <29-char argument> failed " +
      "(exit code 3, signal none, not timed out, ran N ms).\n(no stdout or stderr)",
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
  assert.equal(error.killed, true);
  assert.equal(error.timedOut, true);
  assert.equal(error.signal, "SIGTERM");
});

test("a docker failure never shows a planted synthetic key", async (t) => {
  // One key in the sk- shape the CI redaction knows, one plain value the caller names.
  const key = "sk-oce-planted-synthetic-key-2184";
  const plain = "planted-plain-value-2184";
  process.env.FAKE_DOCKER_KEY = key;
  process.env.FAKE_DOCKER_PLAIN = plain;
  t.after(() => {
    delete process.env.FAKE_DOCKER_KEY;
    delete process.env.FAKE_DOCKER_PLAIN;
  });
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
  assert.match(error.stderr, /planted planted-plain-value-2184/);
});

test("a docker command's stdin reaches it, and an early exit reports the exit, not the pipe", async (t) => {
  t.after(() => delete process.env.FAKE_DOCKER_MODE);
  process.env.FAKE_DOCKER_MODE = "cat";
  const { stdout } = await runDocker(["exec", "-i", "fake-container", "cat"], {}, "stdin text\n");
  assert.equal(stdout, "stdin text\n");
  // The stand-in exits 3 without reading 4 MiB of input.
  process.env.FAKE_DOCKER_MODE = "exit-silent";
  const error = await runDocker(
    ["exec", "-i", "fake-container", "cat"],
    {},
    "x".repeat(4 << 20),
  ).then(
    () => assert.fail("the command should fail"),
    (failure) => failure,
  );
  assert.equal(error.code, 3);
  assert.match(error.message, /^docker exec -i fake-container cat failed \(exit code 3,/);
});
