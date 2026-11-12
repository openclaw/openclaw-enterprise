import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  createRunnerFixture,
  laneArgs,
  runnerEnv,
  runRunnerSync,
  writeFirstAgentCliFixture,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";

async function startupFixture(t: TestContext) {
  const root = await createRunnerFixture(t);
  await mkdir(join(root, "tests/fixtures"));
  await copyFile(
    new URL("../fixtures/ci-runner-first-agent-startup-child.ts", import.meta.url),
    join(root, "tests/fixtures/ci-runner-first-agent-startup-child.ts"),
  );
  return root;
}

function receiptRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function receiptArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function readMeasurements(artifact: string) {
  const file = receiptRecord(receiptArray(receiptRecord(JSON.parse(artifact)).files)[0]);
  return receiptArray(file.measurements).map(receiptRecord);
}

function readStartupFailureMessage(diagnostics: unknown) {
  const failure = receiptRecord(receiptArray(receiptRecord(diagnostics).failures)[0]);
  const startup = receiptArray(failure.tests)
    .map(receiptRecord)
    .find(({ name }) => name === "startup");
  assert.ok(typeof startup?.message === "string");
  return startup.message;
}

test("first-Agent command timing pairs runtime and manifest outcomes before CI projection", async (t) => {
  const root = await startupFixture(t);
  const resultsPath = join(root, "results/runtime-outcomes.json");
  const runtime = "[occ-dev-timing] stage=runtime-build elapsed_ms=11 failed=true";
  const outcome = "[occ-dev-outcome] stage=runtime-build outcome=";
  const manifest = "openshell-agent-sandbox-manifest";
  const manifestTiming = `[occ-dev-timing] stage=${manifest} elapsed_ms=13 failed=true`;
  const manifestOutcome = `[occ-dev-outcome] stage=${manifest} outcome=`;
  const reasons = [
    "selected-input",
    "http-status",
    "transport",
    "deadline",
    "canceled",
    "integrity",
    "local-io",
  ];
  const lines = [
    runtime,
    outcome + "nonzero-exit",
    outcome + "nonzero-exit",
    runtime,
    outcome + "signaled",
    runtime,
    outcome + "signaled token=private-outcome-canary",
    runtime,
    outcome + "private-outcome-canary",
    runtime,
    "unrelated child output",
    outcome + "signaled",
    // Legacy timing still counts this row, but its elapsed value is not canonical.
    "[occ-dev-timing] stage=runtime-build elapsed_ms=00011 failed=true",
    outcome + "signaled",
    "[occ-dev-timing] stage=runtime-build elapsed_ms=3 failed=false",
    outcome + "signaled",
    "[occ-dev-timing] stage=controller-build elapsed_ms=5 failed=true",
    outcome + "signaled",
    "[occ-dev-timing] stage=openshell-workspace-render elapsed_ms=7 failed=true",
    "[occ-dev-timing] stage=private-outcome-canary elapsed_ms=9 failed=true",
    ...reasons.flatMap((reason) => [manifestTiming, manifestOutcome + reason]),
    manifestOutcome + "deadline",
    manifestTiming,
    manifestOutcome + "private-outcome-canary",
    `[occ-dev-timing] stage=${manifest} elapsed_ms=3 failed=false`,
    manifestOutcome + "deadline",
    "[occ-dev-startup] primary_stage=routing cleanup_failed=true parent_context_done=false routing_operation=manifest-download routing_controller=cert-manager",
  ];
  await writeFirstAgentCliFixture(
    root,
    [
      'if (process.argv[3] === "up") {',
      "  process.stdout.write(" + JSON.stringify(lines.join("\n") + "\n") + ");",
      "  process.exitCode = 23;",
      "}",
      "",
    ].join("\n"),
  );
  await writeSingleFileRunnerLane(
    root,
    "measure",
    "tests/integration/runtime-outcomes.test.mjs",
    `import assert from "node:assert/strict";
import test from "node:test";
import { configureFirstAgentStartup, loadFirstAgentStack } from "../fixtures/ci-runner-first-agent-startup-child.ts";
const { localFirstAgentStack } = await loadFirstAgentStack();
test("a failed local setup reports only paired outcomes", async (t) => {
  configureFirstAgentStartup();
  await assert.rejects(localFirstAgentStack(t), /Start Local Setup exited with status 23/);
  const legacy = { kind: "local-first-agent-startup-failure", primaryStage: "routing", cleanupFailed: true, parentContextDone: false };
  // Old CLI receipts remain valid; projection strips unrelated fields and rejects
  // invalid detail values instead of retaining arbitrary command output.
  t.diagnostic('openclaw-ci-measurement ' + JSON.stringify(legacy));
  t.diagnostic('openclaw-ci-measurement ' + JSON.stringify({ ...legacy, routingOperation: "controller-rollout", routingController: "envoy-gateway", error: "private-outcome-canary" }));
  t.diagnostic('openclaw-ci-measurement ' + JSON.stringify({ ...legacy, routingOperation: "node-pod-cidr" }));
  for (const fields of [
    { primaryStage: "private-outcome-canary" },
    { routingOperation: "private-outcome-canary" },
    { routingOperation: null },
    { routingController: "private-outcome-canary" },
    { routingController: null },
    { routingController: "cert-manager" },
    { routingOperation: "node-pod-cidr", routingController: "cert-manager" },
    { routingOperation: "node-pod-cidr", routingController: "envoy-gateway" },
    { primaryStage: "rollback", routingOperation: "manifest-apply" },
    { primaryStage: "rollback", routingController: "cert-manager" },
  ]) {
    t.diagnostic('openclaw-ci-measurement ' + JSON.stringify({ ...legacy, ...fields }));
  }
  t.diagnostic('openclaw-ci-measurement {"kind":"local-first-agent-startup-failure","private-outcome-canary":');
  t.diagnostic('openclaw-ci-measurement private-outcome-canary');
  t.diagnostic("ordinary setup diagnostic survives");
  throw new Error("setup failed");
});
`,
  );
  const result = runRunnerSync(
    laneArgs(root, "measure", "state/runtime-outcomes.jsonl", resultsPath),
  );
  assert.equal(result.status, 1, result.stderr);
  const artifact = await readFile(resultsPath, "utf8");
  const measurements = readMeasurements(artifact);
  assert.deepEqual(
    measurements.filter(({ kind }) => kind === "local-first-agent-command"),
    [
      {
        kind: "local-first-agent-command",
        phase: "setup",
        stage: "runtime-build",
        count: 7,
        failed: 6,
        elapsedMs: 69,
        nonzeroExitCount: 1,
        signaledCount: 1,
      },
      {
        kind: "local-first-agent-command",
        phase: "setup",
        stage: "controller-build",
        count: 1,
        failed: 1,
        elapsedMs: 5,
      },
      {
        kind: "local-first-agent-command",
        phase: "setup",
        stage: "openshell-workspace-render",
        count: 1,
        failed: 1,
        elapsedMs: 7,
      },
      {
        kind: "local-first-agent-command",
        phase: "setup",
        stage: manifest,
        count: reasons.length + 2,
        failed: reasons.length + 1,
        elapsedMs: 13 * (reasons.length + 1) + 3,
      },
    ],
  );
  assert.deepEqual(
    measurements.filter(({ kind }) => kind === "local-first-agent-manifest-failure"),
    reasons.map((reason) => ({ kind: "local-first-agent-manifest-failure", reason })),
  );
  const expectedRoutingFailure = {
    kind: "local-first-agent-startup-failure",
    primaryStage: "routing",
    cleanupFailed: true,
    parentContextDone: false,
  };
  assert.deepEqual(
    measurements.filter(({ kind }) => kind === "local-first-agent-startup-failure"),
    [
      {
        ...expectedRoutingFailure,
        routingOperation: "manifest-download",
        routingController: "cert-manager",
      },
      expectedRoutingFailure,
      {
        ...expectedRoutingFailure,
        routingOperation: "controller-rollout",
        routingController: "envoy-gateway",
      },
      {
        ...expectedRoutingFailure,
        routingOperation: "node-pod-cidr",
      },
    ],
  );
  const diagnostics = await readFile(
    join(root, "state/runtime-outcomes.jsonl.diagnostics.json"),
    "utf8",
  );
  assert.match(diagnostics, /setup failed/);
  for (const text of [artifact, diagnostics]) {
    assert.doesNotMatch(text, /private-outcome-canary|invented-fixture-input/);
  }
  assert.match(diagnostics, /ordinary setup diagnostic survives/);
});

test("first-Agent startup preserves bounded redacted stderr and the original failure", async (t) => {
  const actionable =
    "failed to create network: Pool overlaps with other one on this address space\n";
  const sensitive =
    "environment value: invented-fixture-input\n" +
    "AUTHORIZATION: Bearer private-header-value\n" +
    "password: {\n  value: 'private-nested-value'\n}\n" +
    "-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----\n";
  const cases = [
    ["short", actionable + "unterminated actionable detail\n" + sensitive],
    ["large", actionable + "x".repeat(40_000) + "private-cut-tail"],
    ["success", actionable + sensitive],
    ["object", actionable + 'authorization: {\n  value: "opaque-object-canary"\n}\n'],
    ["yaml", actionable + "password: |\n  opaque-block-canary\n"],
    [
      "display boundary",
      actionable.padEnd(1_950, "x") + '\nauthorization: {\n value: "opaque-object-canary"\n}\n',
    ],
    [
      "capture boundary",
      actionable.padEnd(16_340, "x") + '\nauthorization: {\n value: "opaque-object-canary"\n}\n',
    ],
    ["unicode", actionable.padEnd(1_999, "x") + "😀" + "tail"],
    // An early sanitizer change can hide a later useful build error. The suffix
    // must stay private because it may instead be an orphaned multiline secret.
    ["early path", "__FIXTURE_ROOT__/compose.yaml warning\n" + actionable],
    ["early ansi", "\u001b[33mBuild progress\u001b[0m\n" + actionable],
    ["early secret", sensitive + actionable + "x".repeat(20_000) + "private-cut-tail"],
    ["empty", ""],
    ["clipped setup point", actionable],
    ["last setup point", actionable],
  ] as const;
  for (const [scenario, stderr] of cases) {
    await t.test(scenario, async (t) => {
      const root = await startupFixture(t);
      const resultsPath = join(root, "results/startup-stderr.json");
      const cleanupPath = join(root, "cleanup.txt");
      await writeFirstAgentCliFixture(
        root,
        `
import { writeSync, writeFileSync } from "node:fs";
if (process.argv[3] === "down") writeFileSync(new URL("../cleanup.txt", import.meta.url), "done");
if (process.argv[3] === "up") {
  process.stdout.write("stdout-must-stay-private\\n");
  process.stdout.write("Starting the Compose database, migration, and bootstrap services...\\n");
  if (${JSON.stringify(scenario)} === "clipped setup point") {
    // A delayed newline leaves a clipped suffix that resembles a setup message.
    writeSync(1, "x".repeat(8192) + "Preparing pinned OpenShell development assets".padEnd(4096, "x"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeSync(1, "\\n");
  }
  if (${JSON.stringify(scenario)} === "last setup point") {
    // Repeated points still update the error even when their measurement was emitted before.
    writeSync(1, "Preparing pinned OpenShell development assets\\n");
    writeSync(1, "Starting the Compose controller and Kubernetes worker\\n");
    writeSync(1, "Preparing pinned OpenShell development assets\\n");
  }
  const stderr = ${JSON.stringify(stderr)}.replaceAll("__FIXTURE_ROOT__", process.cwd());
  // Independent writes may be coalesced by the pipe; both must be consumed.
  writeSync(2, stderr.slice(0, 90));
  writeSync(2, stderr.slice(90));
  process.exitCode = ${scenario === "success" ? 0 : 23};
}
`,
      );
      await writeSingleFileRunnerLane(
        root,
        "measure",
        "tests/integration/startup-stderr.test.mjs",
        `
import { writeFileSync } from "node:fs";
import test from "node:test";
import { configureFirstAgentStartup, loadFirstAgentStack } from "../fixtures/ci-runner-first-agent-startup-child.ts";
const { localFirstAgentStack } = await loadFirstAgentStack();
test("startup", async (t) => {
  configureFirstAgentStartup();
  try {
    await localFirstAgentStack(t);
  } catch (error) {
    // Observe the actual helper rejection before any reporter can redact it.
    writeFileSync(new URL("../../helper-error.json", import.meta.url), JSON.stringify(error.message));
    throw error;
  }
});
`,
      );
      if (scenario === "success") {
        // TAP keeps passing-test chatter, unlike the canonical runner's summary.
        const directEnv: NodeJS.ProcessEnv = runnerEnv();
        delete directEnv.NODE_TEST_CONTEXT;
        delete directEnv.NODE_TEST_WORKER_ID;
        const direct = spawnSync(
          process.execPath,
          [
            "--test",
            "--test-reporter=tap",
            join(root, "tests/integration/startup-stderr.test.mjs"),
          ],
          { encoding: "utf8", env: directEnv },
        );
        assert.equal(direct.status, 0, direct.stderr);
        assert.match(direct.stdout, /^ok \d+ - startup$/m);
        assert.doesNotMatch(
          direct.stdout + direct.stderr,
          /Pool overlaps|private|invented-fixture-input/,
        );
        // Require each runner to write its own cleanup marker.
        assert.equal(await readFile(cleanupPath, "utf8"), "done");
        await unlink(cleanupPath);
      }
      const result = runRunnerSync(
        laneArgs(root, "measure", "state/startup-stderr.jsonl", resultsPath),
      );
      assert.equal(result.status, scenario === "success" ? 0 : 1, result.stderr);
      assert.equal(await readFile(cleanupPath, "utf8"), "done");
      const privateValues =
        /stdout-must-stay-private|private-header-value|invented-fixture-input|private-nested-value|private-key-body|private-cut-tail|opaque-object-canary|opaque-block-canary/;
      const artifact = await readFile(resultsPath, "utf8");
      assert.doesNotMatch(result.stdout + result.stderr + artifact, privateValues);
      const setupStages = readMeasurements(artifact)
        .filter(({ kind }) => kind === "local-first-agent-setup-point")
        .map(({ stage }) => stage);
      assert.deepEqual(
        setupStages,
        scenario === "last setup point"
          ? ["database-start", "openshell-assets-start", "controller-start"]
          : ["database-start"],
      );
      if (scenario === "success") {
        return;
      }
      const diagnostics: unknown = JSON.parse(
        await readFile(join(root, "state/startup-stderr.jsonl.diagnostics.json"), "utf8"),
      );
      assert.doesNotMatch(JSON.stringify(diagnostics), privateValues);
      const message = readStartupFailureMessage(diagnostics);
      const helperMessage: unknown = JSON.parse(
        await readFile(join(root, "helper-error.json"), "utf8"),
      );
      assert.ok(typeof helperMessage === "string");
      for (const text of [message, helperMessage]) {
        assert.match(text, /Start Local Setup exited with status 23/);
        assert.match(
          text,
          scenario === "last setup point"
            ? /last setup point: openshell-assets-start/
            : /last setup point: database-start/,
        );
        if (scenario.startsWith("early ")) {
          assert.doesNotMatch(text, /Pool overlaps|Build progress|compose\.yaml/);
          assert.match(text, /Startup stderr: withheld at a redaction boundary/);
        } else if (scenario === "empty") {
          assert.match(text, /Startup stderr: no output captured/);
        } else {
          assert.match(text, /Pool overlaps with other one on this address space/);
        }
        assert.doesNotMatch(text, privateValues);
        assert.ok(text.isWellFormed(), "diagnostic cutoff must preserve Unicode characters");
        assert.ok(text.length < 2_500, "the individual error must be bounded");
        if (
          ["short", "object", "yaml", "display boundary", "capture boundary"].includes(scenario)
        ) {
          assert.match(text, /remaining stderr withheld at a redaction boundary/);
        }
        if (["large", "capture boundary", "unicode", "early secret"].includes(scenario)) {
          assert.match(text, /stderr truncated/);
        }
      }
      if (scenario === "short") {
        assert.match(helperMessage, /unterminated actionable detail/);
      }
    });
  }
});

test("startup observations require one terminal record from a failed dev-up", async (t) => {
  const root = await startupFixture(t);
  const legacyRecord =
    "[occ-dev-startup] primary_stage=routing cleanup_failed=true parent_context_done=false\n";
  const record =
    legacyRecord.trimEnd() +
    " routing_operation=controller-rollout routing_controller=envoy-gateway\n";
  await writeFirstAgentCliFixture(
    root,
    `const record = ${JSON.stringify(record)};
const legacyRecord = ${JSON.stringify(legacyRecord)};
const scenario = process.env.OCC_FIXTURE_STARTUP_CASE;
if (process.argv[3] === "down") {
  process.stdout.write(record);
  process.exit(1);
}
if (scenario === "legacy") process.stdout.write(legacyRecord);
else if (scenario === "controller-import") process.stdout.write(legacyRecord.replace("primary_stage=routing", "primary_stage=controller-image-import"));
else if (scenario === "operation-only") process.stdout.write(legacyRecord.trimEnd() + " routing_operation=node-pod-cidr\\n");
else if (scenario === "invalid-operation") process.stdout.write(record.replace("controller-rollout", "private-outcome-canary"));
else if (scenario === "invalid-controller") process.stdout.write(record.replace("envoy-gateway", "private-outcome-canary"));
else if (scenario === "controller-only") process.stdout.write(record.replace(" routing_operation=controller-rollout", ""));
else if (scenario === "node-cidr-controller") process.stdout.write(record.replace("controller-rollout", "node-pod-cidr"));
else if (scenario === "nonrouting") process.stdout.write(record.replace("primary_stage=routing", "primary_stage=rollback"));
else if (scenario === "stderr") process.stderr.write(record);
else if (scenario === "duplicate") process.stdout.write(record + record);
else if (scenario === "malformed") process.stdout.write(record + "[occ-dev-startup] invalid\\n");
else if (scenario === "early") process.stdout.write(record + "later operation\\n");
else if (scenario === "truncated") process.stdout.write("[occ-dev-startup\\n" + record);
else if (scenario === "incomplete") process.stdout.write(record.trimEnd());
else if (scenario === "overflow") process.stdout.write("x".repeat(4097) + "\\n" + record);
else process.stdout.write(record);
if (scenario === "signal") process.kill(process.pid, "SIGTERM");
else process.exitCode = scenario === "success" ? 0 : 23;
`,
  );
  // Real subprocesses exercise both the streaming runner and execFile's error
  // envelope, used by the installed refusal caller. No cluster is started.
  await writeSingleFileRunnerLane(
    root,
    "intake",
    "tests/integration/startup-intake.test.mjs",
    `
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { configureFirstAgentStartup, loadFirstAgentStack } from "../fixtures/ci-runner-first-agent-startup-child.ts";
const { localFirstAgentStack, startupFailureObservation } = await loadFirstAgentStack();
test("reject ambiguous or non-failure startup records", async (t) => {
  configureFirstAgentStartup();
  for (const scenario of ["invalid-operation", "invalid-controller", "controller-only", "node-cidr-controller", "nonrouting", "stderr", "duplicate", "malformed", "early", "truncated", "incomplete", "overflow", "signal", "success"]) {
    process.env.OCC_FIXTURE_STARTUP_CASE = scenario;
    if (scenario === "success") await localFirstAgentStack(t);
    else await assert.rejects(localFirstAgentStack(t), /Start Local Setup/);
  }
  for (const [scenario, details] of [
    ["valid", { routingOperation: "controller-rollout", routingController: "envoy-gateway" }],
    ["operation-only", { routingOperation: "node-pod-cidr" }],
    ["legacy", {}],
    ["controller-import", { primaryStage: "controller-image-import" }],
    // Check intake directly so reporter rejection cannot hide an invalid pair.
    ["node-cidr-controller", null],
  ]) {
    process.env.OCC_FIXTURE_STARTUP_CASE = scenario;
    await assert.rejects(promisify(execFile)(${JSON.stringify(join(root, "bin/occ"))}, ["dev", "up"]), (error) => {
      const observation = startupFailureObservation();
      // Deliberately split the genuine stdout across every boundary.
      for (const character of error.stdout) observation.write(character);
      assert.deepEqual(observation.finish(error.code, error.signal, error.killed), details === null ? undefined : {
        kind: "local-first-agent-startup-failure", primaryStage: "routing", cleanupFailed: true, parentContextDone: false,
        ...details,
      });
      // Cancellation takes precedence even when a complete valid line was buffered.
      assert.equal(observation.finish(error.code, error.signal, true), undefined);
      return true;
    });
  }
  // The startup stage must survive its Kubernetes streaming caller and CI projection.
  process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "kubernetes";
  process.env.OCC_FIXTURE_STARTUP_CASE = "controller-import";
  await assert.rejects(localFirstAgentStack(t), /Start Local Setup exited with status 23/);
});
`,
  );
  const results = join(root, "results/intake.json");
  const result = runRunnerSync(laneArgs(root, "intake", "state/intake.jsonl", results));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const measurements = readMeasurements(await readFile(results, "utf8"));
  assert.deepEqual(
    measurements.filter(({ kind }) => kind === "local-first-agent-startup-failure"),
    [
      {
        kind: "local-first-agent-startup-failure",
        primaryStage: "controller-image-import",
        cleanupFailed: true,
        parentContextDone: false,
      },
    ],
  );
});
