import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { reservePort } from "../helpers/available-port.ts";
import { pidGone, recordingChild, startSupervisor } from "./workspace-node-supervisor-fixture.ts";

// Native setup that prints the value of the JavaScript expression `stdout` and exits
// with `status`.
function setupStub(stdout: string, status: number) {
  return [`process.stdout.write(${stdout}); process.exitCode = ${status};`];
}

export async function acceptsLargeSetupOutput(t: TestContext) {
  // A buffered pipe (spawnSync's 1 MiB default) killed a setup whose result outgrew
  // it, which failed a setup that succeeded (review-3817).
  const directory = await mkdtemp(join(tmpdir(), "oce-node-supervisor-baseline-"));
  const { waitFor } = await startSupervisor(t, directory, {
    child: recordingChild,
    setup: setupStub('JSON.stringify({ ok: true, padding: "x".repeat(3 * 1024 * 1024) })', 0),
    env: { OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup" },
  });
  await waitFor(
    "children started",
    (rows) => rows.some(({ kind }) => kind === "node") && rows.some(({ kind }) => kind === "codex"),
  );
}

export async function servesHeldStatus(t: TestContext) {
  // Codex owns this container's status port, and it never starts on an uninitialized
  // workspace: the supervisor serves the hold there itself, so Compute fails the
  // revision with the check instead of waiting for its deadline (finding 2686).
  const directory = await mkdtemp(join(tmpdir(), "oce-node-supervisor-held-"));
  // The supervisor binds its status port on every interface; hold it there.
  const statusReservation = await reservePort({ host: "0.0.0.0" });
  t.after(() => statusReservation.release());
  const { port } = statusReservation;
  const result = {
    ok: false,
    error: { type: "cli_error", message: `bad\n\u001b]0;title\u0007${"y".repeat(600)}` },
    issues: [{ path: "agents.defaults.skipBootstrap", message: "sk-fixture-value" }],
  };
  const { supervisor, events, waitForValue, output } = await startSupervisor(t, directory, {
    child: recordingChild,
    statusReservation,
    setup: setupStub(JSON.stringify(JSON.stringify(result, null, 2)), 1),
    env: {
      OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup",
      OPENCLAW_RUNTIME_STATUS_PORT: String(port),
      OPENCLAW_AGENT_REVISION_ID: "rev_fixture",
      OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent",
      OPENCLAW_POD_UID: "pod-fixture",
    },
  });
  const read = async (path: string) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: response.status, body: await response.text() };
    } catch {
      return undefined;
    }
  };
  // A connection that reaches the reservation is reset, which read() reports as no answer.
  const answer = await waitForValue(
    "held status served",
    (served) => served?.status === 200,
    () => read("/openclaw/runtime/status"),
  );
  await statusReservation.release();
  assert.ok(answer, "supervisor returned the held status");
  const body: unknown = JSON.parse(answer.body);
  const status = asRecord(body);
  const runtimeFailure = asRecord(status?.runtimeFailure);
  assert.ok(status && runtimeFailure, "held status contains a runtime failure");
  const { checkedAt, ...failure } = runtimeFailure;
  assert.ok(typeof checkedAt === "string" && Number.isFinite(Date.parse(checkedAt)));
  assert.deepEqual(
    { ...status, runtimeFailure: failure },
    {
      revisionId: "rev_fixture",
      container: "agent",
      podUid: "pod-fixture",
      runtimeFailure: { component: "agent", check: "workspace-baseline", code: "UNAVAILABLE" },
    },
  );
  assert.equal((await read("/readyz"))?.status, 503);
  // One bounded line names the setup's message and setting path, never its values.
  const lines = output()
    .split("\n")
    .filter((line) => line.includes("Workspace initialization"));
  assert.equal(lines.length, 1, output());
  const [line] = lines;
  assert.ok(line);
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/u);
  assert.equal(output().includes("sk-fixture-value"), false);
  // The message is cut at 400 characters after control characters collapse.
  assert.ok(
    line.includes(
      `reported: bad ]0;title ${"y".repeat(387)} (invalid settings: agents.defaults.skipBootstrap).`,
    ),
    line,
  );
  // Held: alive, and neither child started.
  assert.equal(supervisor.exitCode, null);
  assert.deepEqual(await events(), []);
}

export async function waitsForSetupBeforeStopping(t: TestContext) {
  // Native setup holds the node state's lock on the Agent's workspace claim. If the
  // supervisor exited on SIGTERM first, the container would end and the kernel would
  // kill setup while it holds the lock, which no later Pod can then take (finding
  // 3104). OpenClaw's launcher kills the CLI about 2 s after a forwarded stop, so the
  // supervisor keeps the stop to itself and waits for setup to end on its own.
  const directory = await mkdtemp(join(tmpdir(), "oce-node-supervisor-setup-stop-"));
  const release = join(directory, "release-setup");
  // A failed assertion must also let the fixture release its lock before teardown waits for exit.
  t.after(() => writeFile(release, ""));
  const { supervisor, exited, events, waitFor, output } = await startSupervisor(t, directory, {
    child: recordingChild,
    setup: [
      'const { appendFileSync, existsSync } = require("node:fs");',
      "const [events] = process.argv.slice(2);",
      "const row = (kind) => appendFileSync(events, JSON.stringify({ kind, pid: process.pid }) + '\\n');",
      'process.on("SIGTERM", () => row("setup-signal"));',
      'row("setup");',
      // Setup holds its lock until the test lets it finish; releasing takes a moment.
      "const timer = setInterval(() => {",
      `  if (!existsSync(${JSON.stringify(release)})) return;`,
      "  clearInterval(timer);",
      '  setTimeout(() => row("setup-done"), 100);',
      "}, 10);",
    ],
    env: { OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup" },
  });
  const setup = (
    await waitFor("native setup started", (rows) => rows.some(({ kind }) => kind === "setup"))
  ).find((row) => row.kind === "setup");
  assert.ok(setup, "native setup recorded its start");
  supervisor.kill("SIGTERM");
  // While setup holds its lock, the stopped supervisor must not exit. The real
  // supervisor cannot exit before setup does, so this wait cannot fail it; one
  // that exits on the stop does so well within the wait.
  const early = await Promise.race([exited, delay(500).then(() => "running")]);
  assert.equal(early, "running", output());
  await writeFile(release, "");
  assert.deepEqual(await exited, [0, null], output());
  // The supervisor exited after setup ended: setup was gone when it exited.
  assert.ok(pidGone(setup.pid), "native setup outlived the supervisor");
  // Setup finished undisturbed, and the stopped Harness started neither child.
  assert.deepEqual(
    (await events()).map(({ kind }) => kind),
    ["setup", "setup-done"],
  );
}
