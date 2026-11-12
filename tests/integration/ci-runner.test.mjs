import { loadTestSuites } from "../../scripts/ci/test-suites.mjs";
import { prepareGatewayRouting } from "../../scripts/ci/routing.mjs";
import { readRuntimeProvenance } from "../../scripts/ci/runtime-provenance.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { describe } from "node:test";
import { nativeFirstAgentProofDiagnostic } from "../../scripts/ci/reporter.mjs";
import { exercisedLaneStatus } from "../../scripts/ci/full-integration-coverage.ts";
import {
  projectSkipperRunnerReceipt,
  skipperFailureSummary,
} from "../../scripts/ci/skipper-release.ts";
import {
  aggregateArgs,
  createRunnerFixture as fixture,
  currentSha,
  fixtureGitEnv,
  killRecordedProcessGroupMembers,
  laneArgs,
  lifecycleReady,
  procStat,
  runnerArtifactPaths,
  runnerEnv,
  runRunnerSync,
  spawnLifecycleRunner,
  writeJson,
  writeRunnerManifest,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";
import { finiteConversationScenarios } from "../fixtures/ci-runner-finite-conversation.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  prepareK3dDiagnosticsRun,
  writeK3dChildTest,
  writeK3dKubectl,
} from "../helpers/ci-runner-k3d-fixture.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  collectNativeWorkerFailure,
  nativePlacementReadRetryable,
  nativeWorkerHistoryEvidence,
  nativeWorkerProofProgram,
  nativeWorkerPlacementObservation,
  nativeWorkerTurnObservation,
} from "../helpers/local-first-agent-native.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.mjs");

test("runtime provenance excludes structured image identities and invalid native metadata", async (t) => {
  const root = await temporaryDirectory(t, "ci-provenance-projection-");
  const statePath = join(root, "state.json");
  const imageId = `sha256:${"a".repeat(64)}`;
  const manifestDigest = `sha256:${"b".repeat(64)}`;
  const role = "OCC_TEST_KUBERNETES_AGENT_IMAGE";
  const prefix = "openclaw-ci-test-lane-123456789abc";
  const identity = {
    lane: "test-lane",
    preparationId: createHash("sha256").update(prefix).digest("hex"),
  };
  for (const fields of [
    { imageId: [imageId], manifestDigest },
    { imageId, manifestDigest: [[manifestDigest]] },
  ]) {
    await writeJson(statePath, {
      lane: identity.lane,
      prefix,
      runtimeProvenance: { [role]: { ...fields, status: "unavailable" } },
    });
    assert.equal(await readRuntimeProvenance(statePath, identity), undefined);
  }
  for (const version of ["0.164.0\nprivate-value", "0.164.0-..", "0.164.0-01", "01.164.0"]) {
    await writeJson(statePath, {
      lane: identity.lane,
      prefix,
      runtimeProvenance: {
        [role]: {
          imageId,
          manifestDigest,
          status: "available",
          platform: "linux/amd64",
          openclawCommit: "c".repeat(40),
          codex: { version, binarySha256: "d".repeat(64) },
        },
      },
    });
    assert.deepEqual(await readRuntimeProvenance(statePath, identity), {
      [role]: { imageId, manifestDigest, status: "unavailable" },
    });
  }
  assert.equal(
    await readRuntimeProvenance(statePath, { ...identity, lane: "another-lane" }),
    undefined,
  );
  assert.equal(
    await readRuntimeProvenance(statePath, { ...identity, preparationId: "0".repeat(64) }),
    undefined,
  );
});

test("installed Skipper publishes only verified coverage evidence from the runner", () => {
  const path = "tests/integration/skipper-prepared-git-installed.test.mjs";
  const name =
    "same Compute-owned Skipper chats, authors private Git, loses Git during an authenticated fetch, and still chats";
  const counts = { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 };
  const canary = "raw-diagnostic-must-stay-private";
  const summary = {
    version: 1,
    command: "run",
    sourceSha: "a".repeat(40),
    status: "passed",
    counts,
    exitCode: 0,
    scope: "full",
    issues: [],
    privateDiagnostic: canary,
    files: [
      {
        path,
        status: "passed",
        counts,
        cleanup: { status: "passed" },
        tests: [{ name, status: "passed", durationMs: 1, output: canary }],
        exercised: true,
        signal: null,
        nodeExitCode: 0,
        issues: [],
        privateDiagnostic: canary,
      },
    ],
  };
  const expected = [{ path, expectedTests: [name] }];
  // Owned job cleanup follows projection; supply its positive outcome in this fixture.
  const cleanedReceipt = (value) => ({
    ...projectSkipperRunnerReceipt(value),
    cleanup: { status: "passed" },
  });
  const projected = cleanedReceipt(summary);
  assert.equal(exercisedLaneStatus(projected, expected), "passed");
  assert.ok(!JSON.stringify(projected).includes(canary));

  for (const file of [
    { ...summary.files[0], exercised: undefined },
    { ...summary.files[0], signal: "SIGTERM" },
    { ...summary.files[0], nodeExitCode: undefined },
    { ...summary.files[0], issues: [{ message: canary }] },
    { ...summary.files[0], fileFailure: { message: canary } },
  ]) {
    const incomplete = cleanedReceipt({ ...summary, files: [file] });
    assert.equal(exercisedLaneStatus(incomplete, expected), undefined);
    assert.ok(!JSON.stringify(incomplete).includes(canary));
  }
  assert.equal(
    exercisedLaneStatus(cleanedReceipt({ ...summary, scope: "focused" }), expected),
    undefined,
  );

  const malformed = structuredClone(summary);
  malformed.files[0].tests[0].name = canary;
  const projection = new URL("../../scripts/ci/skipper-release.ts", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { readFileSync } from "node:fs";
import { projectSkipperRunnerReceipt } from ${JSON.stringify(projection.href)};
projectSkipperRunnerReceipt(JSON.parse(readFileSync(0, "utf8")));`,
    ],
    { encoding: "utf8", input: JSON.stringify(malformed) },
  );
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes(canary), "stderr echoed rejected private input");
  assert.match(result.stderr, /Invalid installed Skipper test result/);
});

function writeSingleLaneManifest(root, lane, files, groups) {
  return writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: { [lane]: { files } },
    groups: groups,
  });
}

function run(root, args, env = {}, options = {}) {
  return runRunnerSync(args, env, options);
}

test("checkout build failures retain safe process details through the CI reporter", async (t) => {
  const root = await fixture(t);
  const path = "tests/integration/build-failure.test.mjs";
  const statePath = join(root, "state/build.jsonl");
  const resultsPath = join(root, "results/build.json");
  const provider = pathToFileURL(join(repositoryRoot, "tests/helpers/dev-up-model-provider.mjs"));
  // This canary is deliberately not an environment secret. The helper must
  // omit child output before the existing reporter/redaction boundary.
  const privateOutput = "private-checkout-build-output";
  await writePrepare(root);
  await writeSingleLaneManifest(root, "build-failure", [{ path }], {});
  await writeFile(
    join(root, path),
    `import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createDevUpModelProvider } from ${JSON.stringify(provider.href)};
const execute = promisify(execFile);
test("failed checkout builds", async () => {
  const provider = createDevUpModelProvider({
    directory: ${JSON.stringify(join(root, "provider"))},
    cluster: "unused",
    environment: { OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker", DOCKER_HOST: "unix:///unused.sock" },
    run: async (command, args) => {
      if (command !== "docker") {
        return execute(command, args, { cwd: ${JSON.stringify(repositoryRoot)} });
      }
      // Only registry/image bookkeeping is simulated. Both failures below
      // come from actual child processes; no Docker or cluster is started.
      if (args[1] === "inspect") {
        throw Object.assign(new Error("not found"), {
          stderr: "Error response from daemon: No such " + args[0] + ": " + args[2],
        });
      }
      if (args[0] === "run") {
        return { stdout: "", stderr: "" };
      }
      assert.equal(args[0], "buildx");
      const tag = args[args.indexOf("--tag") + 1];
      const exit = tag.includes("/controller:") ? 23 : 47;
      return execute(process.execPath, ["-e", "console.error(" + JSON.stringify(${JSON.stringify(privateOutput)}) + "); process.exit(" + exit + ")"]).catch((error) => {
        if (exit === 47) {
          // Exercise hostile metadata on a genuine child failure. Neither
          // the accessor nor its private second result belongs in CI output.
          let reads = 0;
          Object.defineProperty(error, "signal", {
            get: () => ++reads === 1 ? "SIGTERM" : ${JSON.stringify(privateOutput)},
          });
        }
        throw error;
      });
    },
  });
  try {
    await provider.prepare();
    assert.fail("builds should fail");
  } catch (error) {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(({ code }) => code), [23, 47]);
    assert.ok(error.errors.every(({ stderr }) => stderr.includes(${JSON.stringify(privateOutput)})));
    throw error;
  }
});
`,
  );
  const result = run(root, laneArgs(root, "build-failure", statePath, resultsPath));
  assert.equal(result.status, 1, result.stderr);
  const raw = await readFile(resultsPath, "utf8");
  const details = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const summary = JSON.parse(raw);
  assert.equal(summary.counts.failed, 1);
  const message = summary.files[0].tests[0].error.message;
  assert.match(
    message,
    /controller: exit=23 code=unknown signal=unknown killed=false elapsedMs=\d+ budgetMs=600000/,
  );
  assert.match(
    message,
    /runtime: exit=47 code=unknown signal=unknown killed=false elapsedMs=\d+ budgetMs=600000/,
  );
  assert.equal(JSON.parse(details).failures[0].tests[0].message, message);
  for (const output of [raw, details, result.stdout, result.stderr]) {
    assert.equal(output.includes(privateOutput), false);
  }
});

test("installed Skipper failure summary reads the actual runner result without exposing errors", async (t) => {
  for (const scenario of [
    "assertion",
    "rejection",
    "file failure",
    "captured subprocess rejection",
    "nested subprocess rejection",
    "nested subprocess signal",
    "receiver failure",
    "unrecognized operation",
    "unrecognized outcome",
  ]) {
    await t.test(scenario, async (t) => {
      const root = join(await fixture(t), "private-source-canary");
      await mkdir(join(root, "tests/integration"), { recursive: true });
      await mkdir(join(root, "tests/helpers"), { recursive: true });
      const path = "tests/integration/skipper-prepared-git-installed.test.mjs";
      const name = "installed journey";
      const lines = [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { fail } from "../helpers/private-helper.mjs";',
        `test("${name}", async () => {`,
      ];
      await writeFile(
        join(root, "tests/helpers/private-helper.mjs"),
        [
          "export async function fail() {",
          "  await Promise.resolve();",
          "  throw new Error(process.env.CI_RUNNER_FIXTURE_CREDENTIAL);",
          "}",
        ].join("\n"),
      );
      if (scenario === "receiver failure") {
        const helper = new URL("../../scripts/ci/skipper-release.ts", import.meta.url).href;
        lines.push(
          `  const { runSkipperOperation, skipperOperationDiagnostic } = await import(${JSON.stringify(helper)});`,
          '  const failure = Object.assign(new Error(process.env.CI_RUNNER_FIXTURE_CREDENTIAL), { openclawCiDiagnostic: skipperOperationDiagnostic({ kind: "skipper-operation", operation: "gateway-chat", httpStatus: 200, gatewayCategory: "response-json" }) });',
          // Losing the optional ledger must not remove the receiver's structured failure.
          '  await runSkipperOperation("gateway-chat", async () => { throw failure; });',
        );
      } else if (scenario === "assertion") {
        lines.push('  assert.equal(process.env.CI_RUNNER_FIXTURE_CREDENTIAL, "expected");');
      } else if (scenario === "rejection") {
        lines.push("  await fail();");
      } else if (
        [
          "captured subprocess rejection",
          "nested subprocess rejection",
          "nested subprocess signal",
          "unrecognized operation",
          "unrecognized outcome",
        ].includes(scenario)
      ) {
        // Match withdrawal's settled promise: a child callback rejects before the test rethrows it.
        // Such an Error has no test-file stack frame; the operation must survive the real reporter.
        const helper = new URL("../../scripts/ci/skipper-release.ts", import.meta.url).href;
        lines.push(
          `  const { runSkipperOperation } = await import(${JSON.stringify(helper)});`,
          '  const { execFile } = await import("node:child_process");',
          '  const { promisify } = await import("node:util");',
          `  const child = () => promisify(execFile)(process.execPath, ["-e", ${JSON.stringify(
            "console.error(process.env.CI_RUNNER_FIXTURE_CREDENTIAL); " +
              (scenario === "nested subprocess signal"
                ? 'process.kill(process.pid, "SIGTERM")'
                : "process.exit(7)"),
          )}]);`,
          `  const outcome = runSkipperOperation("gateway-chat", () => ${
            scenario.startsWith("nested") ? 'runSkipperOperation("gateway-exec", child)' : "child()"
          }).then(() => ({}), (error) => ({ error }));`,
          "  const settled = await outcome;",
          "  await new Promise((resolve) => setImmediate(resolve));",
          "  Object.assign(settled.error.openclawCiDiagnostic, { command: process.env.CI_RUNNER_FIXTURE_CREDENTIAL, stderr: process.env.CI_RUNNER_FIXTURE_CREDENTIAL });",
          ...(scenario === "unrecognized operation"
            ? [
                "  settled.error.openclawCiDiagnostic.operation = process.env.CI_RUNNER_FIXTURE_CREDENTIAL;",
              ]
            : []),
          ...(scenario === "unrecognized outcome"
            ? [
                "  Object.assign(settled.error.openclawCiDiagnostic, { exitCode: process.env.CI_RUNNER_FIXTURE_CREDENTIAL, signal: process.env.CI_RUNNER_FIXTURE_CREDENTIAL, code: process.env.CI_RUNNER_FIXTURE_CREDENTIAL, gatewayCategory: process.env.CI_RUNNER_FIXTURE_CREDENTIAL, httpStatus: process.env.CI_RUNNER_FIXTURE_CREDENTIAL });",
              ]
            : []),
          "  throw settled.error;",
        );
      }
      lines.push("});");
      if (scenario === "file failure") {
        // A failing file after a passing case has no failed test to select.
        lines.push(
          "setImmediate(() => { throw new Error(process.env.CI_RUNNER_FIXTURE_CREDENTIAL); });",
        );
      }
      await writeFile(join(root, path), lines.join("\n"));
      await writeSingleLaneManifest(root, "installed", [{ path, expectedTests: [name] }], {
        ci: ["installed"],
      });
      const result = run(root, [
        "run",
        "installed",
        "--root",
        root,
        "--manifest",
        "manifest.json",
        "--state",
        "state/installed.json",
        "--results",
        "results/installed.json",
      ]);
      assert.equal(result.status, 1);
      const raw = await readFile(join(root, "results/installed.json"), "utf8");
      const summary = JSON.parse(raw);
      const fallback = result.stderr + result.stdout + raw;
      const diagnostic = skipperFailureSummary(raw, root, fallback);
      const category = {
        assertion: "ERR_ASSERTION",
        rejection: "ERR_TEST_FAILURE",
        "file failure": "post-test-async-activity",
        "captured subprocess rejection": "ERR_TEST_FAILURE",
        "nested subprocess rejection": "ERR_TEST_FAILURE",
        "nested subprocess signal": "ERR_TEST_FAILURE",
        "receiver failure": "ERR_TEST_FAILURE",
        "unrecognized operation": "ERR_TEST_FAILURE",
        "unrecognized outcome": "ERR_TEST_FAILURE",
      }[scenario];
      if (scenario === "captured subprocess rejection" || scenario.startsWith("nested")) {
        const operation = scenario.startsWith("nested") ? "gateway-exec" : "gateway-chat";
        const signaled = scenario === "nested subprocess signal";
        assert.equal(
          diagnostic,
          `location unavailable, ERR_TEST_FAILURE, operation=${operation}, ${signaled ? "signal=SIGTERM" : "child-exit=7"}`,
        );
        assert.deepEqual(summary.files[0].tests[0].error.diagnostic, {
          kind: "skipper-operation",
          operation,
          ...(signaled ? { signal: "SIGTERM" } : { exitCode: 7 }),
        });
      } else if (scenario === "receiver failure") {
        assert.ok(
          diagnostic.endsWith(
            "ERR_TEST_FAILURE, operation=gateway-chat, gateway-status=200, gateway-category=response-json",
          ),
        );
        assert.deepEqual(summary.files[0].tests[0].error.diagnostic, {
          kind: "skipper-operation",
          operation: "gateway-chat",
          httpStatus: 200,
          gatewayCategory: "response-json",
        });
      } else if (scenario === "unrecognized outcome") {
        assert.equal(diagnostic, "location unavailable, ERR_TEST_FAILURE, operation=gateway-chat");
        assert.deepEqual(summary.files[0].tests[0].error.diagnostic, {
          kind: "skipper-operation",
          operation: "gateway-chat",
        });
      } else {
        assert.ok(diagnostic.endsWith(`, ${category}`));
      }
      if (scenario === "unrecognized operation") {
        assert.equal(summary.files[0].tests[0].error.diagnostic, undefined);
        assert.equal(diagnostic, "location unavailable, ERR_TEST_FAILURE");
      }
      if (scenario === "assertion" || scenario === "rejection") {
        assert.match(diagnostic, /^skipper-prepared-git-installed\.test\.mjs:5:\d+, /);
        assert.ok(summary.issues.some((entry) => entry.code === "expected-test-not-passed"));
      } else if (scenario === "file failure") {
        assert.equal(summary.files[0].tests[0].status, "passed");
        assert.ok(summary.files[0].fileFailure);
      }
      assert.doesNotMatch(
        diagnostic,
        /secretauthvalue|private-source-canary|expected|installed journey/,
      );

      const error =
        summary.files[0].tests.find((entry) => entry.status === "failed")?.error ??
        summary.files[0].fileFailure.error;
      if (scenario === "captured subprocess rejection") {
        // Mutate the serialized result after the reporter. The public summary must validate
        // its own input even when another producer or a damaged file supplied private fields.
        const prefix = "location unavailable, ERR_TEST_FAILURE";
        const privateValue = "private-diagnostic-must-not-be-published";
        for (const [fields, expected] of [
          [{ operation: privateValue }, prefix],
          [
            { exitCode: privateValue, signal: privateValue, code: privateValue },
            prefix + ", operation=gateway-chat",
          ],
          [
            { exitCode: -1, signal: "SIGTERM", code: "ENOENT" },
            prefix + ", operation=gateway-chat, signal=SIGTERM, code=ENOENT",
          ],
          [{ exitCode: 256 }, prefix + ", operation=gateway-chat"],
          [{ exitCode: 1.5 }, prefix + ", operation=gateway-chat"],
        ]) {
          error.diagnostic = {
            kind: "skipper-operation",
            operation: "gateway-chat",
            exitCode: 7,
            command: privateValue,
            stderr: privateValue,
            ...fields,
          };
          assert.equal(skipperFailureSummary(JSON.stringify(summary), root, "bwrap"), expected);
        }
      }
      // The remaining cases exercise location/category fallback without an operation receipt.
      delete error.diagnostic;
      if (scenario === "rejection") {
        const malformed = structuredClone(summary);
        const selected = malformed.files[0].tests.find((entry) => entry.status === "failed").error;
        delete selected.message;
        delete selected.frame;
        for (const field of ["cause", "location"]) {
          const invalid = structuredClone(malformed);
          invalid.files[0].tests.find((entry) => entry.status === "failed").error[field] =
            "invalid";
          assert.equal(
            skipperFailureSummary(JSON.stringify(invalid), root, "bwrap"),
            "location unavailable, bwrap",
          );
        }
      }
      // Keep specific signals with this error, never from unrelated lane output.
      error.message = "native command failed secretauthvalue";
      assert.match(
        skipperFailureSummary(JSON.stringify(summary), root, "bwrap"),
        /, native command failed$/,
      );
      error.message = "secretauthvalue";
      error.frame = undefined;
      // Missing/invalid coordinates must not leak arbitrary source paths.
      for (const location of [
        undefined,
        { file: join(root, "private-input.mjs"), line: 5, column: 2 },
        { file: join(root, path), line: -1, column: 2 },
        { file: join(root, path), line: 5, column: 1_000_001 },
      ]) {
        error.location = location;
        assert.match(
          skipperFailureSummary(JSON.stringify(summary), root, "bwrap"),
          new RegExp(`^location unavailable, ${category}$`),
        );
      }
      // The text fallback must not undo the structured coordinate boundary.
      for (const coordinates of [
        "0:2",
        "5:0",
        "1000001:2",
        "5:1000001",
        "5:999999999999999999999",
      ]) {
        error.frame = `at skipper-prepared-git-installed.test.mjs:${coordinates}`;
        assert.equal(
          skipperFailureSummary(JSON.stringify(summary), root, "bwrap"),
          `location unavailable, ${category}`,
        );
        assert.equal(
          skipperFailureSummary("not JSON", root, `${error.frame} bwrap`),
          "location unavailable, bwrap",
        );
      }
      error.frame = "at skipper-prepared-git-installed.test.mjs:1000000:1";
      assert.equal(
        skipperFailureSummary(JSON.stringify(summary), root, "bwrap"),
        `skipper-prepared-git-installed.test.mjs:1000000:1, ${category}`,
      );
      error.frame = undefined;
      if (summary.files[0].fileFailure) {
        summary.files[0].fileFailure.diagnosticKind = "secretauthvalue-category";
      }
      error.code = "secretauthvalue-code";
      error.cause = { code: "secretauthvalue-cause" };
      assert.equal(
        skipperFailureSummary(JSON.stringify(summary), root, "bwrap"),
        "location unavailable, unclassified",
      );
    });
  }
  assert.equal(
    skipperFailureSummary("not JSON", "/unused", "bwrap"),
    "location unavailable, bwrap",
  );
});

function mixedPrecisionEventBoundary({ namespace, pod, second, laterCount = 199 }) {
  const event = (uid, reason, timestamp) => ({
    metadata: { namespace, name: `${uid}.event`, uid },
    involvedObject: { kind: "Pod", name: pod, namespace },
    type: "Normal",
    reason,
    message: reason,
    count: 1,
    ...timestamp,
  });
  const older = event("older-whole-second", "OlderWholeSecond", {
    lastTimestamp: `${second}Z`,
  });
  const newer = event("newer-fractional-second", "NewerFractionalSecond", {
    eventTime: `${second}.100000Z`,
  });
  const later = Array.from({ length: laterCount }, (_, index) =>
    event(`later-${index}`, `Later${index}`, {
      eventTime: new Date(Date.parse(`${second}Z`) + (index + 1) * 1_000).toISOString(),
    }),
  );
  return { older, newer, events: [older, newer, ...later] };
}

// run() without blocking this process, for the waiting tests below, which run side by side.
// The result has spawnSync's shape, including its ETIMEDOUT error when `timeout` ends the runner.
function runAsync(root, args, env = {}, { timeout, execArgv = [] } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [...execArgv, runnerPath, ...args], {
      cwd: repositoryRoot,
      env: runnerEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            error ??= Object.assign(new Error(`runner exceeded ${timeout} ms`), {
              code: "ETIMEDOUT",
            });
            child.kill("SIGTERM");
          }, timeout);
    const settle = (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr, error });
    };
    child.on("error", (spawnError) => {
      error ??= spawnError;
      settle(null, null);
    });
    child.on("close", settle);
  });
}

// These tests wait out a real runner timeout, lane deadline or cleanup allowance: seconds
// each, at almost no CPU. Each duration stays as it is, long enough for a loaded host to
// reach the state the test needs before it elapses, or the runner's clock waits for that
// state (heldClock below). Instead they run side by side, after the rest of the file (see
// the describe at its end), so the file waits about as long as the longest of them rather
// than their sum. Each has its own fixture root, state and lock files, and starts the
// runner with runAsync.
const waitingTests = [];

function waitingTest(...args) {
  waitingTests.push(args);
}

// Node arguments that give the runner a clock that stands still at holdAt (Unix epoch
// milliseconds) until every gate path exists (tests/helpers/ci-runner-held-clock.ts). A test
// that needs its fixture in some state before the lane deadline creates a gate there, so a
// busy host delays the deadline instead of reaching it first (finding 2164).
function heldClock(holdAt, gates) {
  const preload = new URL("../helpers/ci-runner-held-clock.ts", import.meta.url);
  preload.searchParams.set("hold", String(holdAt));
  for (const gate of gates) {
    preload.searchParams.append("gate", gate);
  }
  return ["--import", preload.href];
}

// Node arguments that hold the runner just after it lists /proc, the first time it ends its
// descendants, until the `forked` path exists. It creates the `window` path when
// the hold starts (tests/helpers/ci-runner-kill-window.ts, finding 2182).
function killWindow(window, forked) {
  const preload = new URL("../helpers/ci-runner-kill-window.ts", import.meta.url);
  preload.searchParams.set("window", window);
  preload.searchParams.set("forked", forked);
  return ["--import", preload.href];
}

async function writePrepare(root) {
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    [
      'import { appendFile } from "node:fs/promises";',
      "export async function prepareFile({ file, statePath }) {",
      "  if (file.path.endsWith('first.test.mjs')) {",
      "    return {",
      "      env: { CI_RUNNER_SCOPED_VALUE: 'one', OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: 'private.example/controller@sha256:' + 'a'.repeat(64), OCC_TEST_KUBERNETES_RUNTIME_IMAGE: 'private.example/runtime@sha256:' + 'b'.repeat(64), OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: 'private.example/controller@sha256:' + 'd'.repeat(64), OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE: 'private.example/runtime@sha256:' + 'e'.repeat(64), OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE: 'private.example/broker@sha256:' + 'c'.repeat(64), OCC_TEST_PRODUCTION_NODE_IMAGE: 'untrusted-image-value' },",
      "      cleanup: async () => appendFile(statePath, `${file.path}\\n`),",
      "    };",
      "  }",
      "  return { cleanup: async () => appendFile(statePath, `${file.path}\\n`) };",
      "}",
      "",
    ].join("\n"),
  );
}

test(
  "memory samples identify renamed processes without exposing executable paths or arguments",
  { skip: process.platform !== "linux" && "reads /proc" },
  async (t) => {
    const root = await fixture(t);
    const bin = join(root, "bin");
    const output = join(root, "memory.log");
    await mkdir(bin);
    const pgid = procStat(process.pid).pgid;
    // Fix the process inventory, but resolve the real executable through /proc.
    // The second PID represents a process that exited after ps sampled it.
    await writeFile(
      join(bin, "ps"),
      `#!/bin/sh\nprintf '%s\\n' '2048 ${process.pid} ${process.ppid} ${pgid} MainThread' '1024 2147483647 1 1 vanished'\n`,
      { mode: 0o755 },
    );
    await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const child = spawn(
      "bash",
      [join(repositoryRoot, "scripts/ci/memory-sampler.sh"), output, "60"],
      {
        env: { ...runnerEnv(), PATH: `${bin}:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => child.kill("SIGTERM"));
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.includes("memory-sampler")) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (data) => (stderr += data));
    await new Promise((resolvePromise, reject) => {
      child.on("error", reject);
      child.on("close", resolvePromise);
    }).finally(() => clearTimeout(timer));
    const samples = await readFile(output, "utf8");
    const executable = basename(await realpath(process.execPath));
    assert.ok(
      samples.includes(`2048 ${process.pid} ${process.ppid} ${pgid} ${executable} MainThread`),
      samples,
    );
    assert.ok(samples.includes("1024 2147483647 1 1 unknown vanished"), samples);
    assert.ok(stdout.includes(`top=${executable}:2MiB`), stdout);
    assert.doesNotMatch(samples + stdout + stderr, /secretauthvalue|--test|\/proc\/|\/bin\//);
  },
);

test("gateway routing preparation preserves infrastructure env without overriding Slack selection", async (t) => {
  const directory = await temporaryDirectory(t, "openclaw-k8s-routing-selection-");
  const prepared = await prepareGatewayRouting({
    cluster: {
      name: "openclaw-k8s-routing",
      directory,
      kubeconfig: join(directory, "kubeconfig"),
      context: "k3d-openclaw-k8s-routing",
    },
    // Only infrastructure I/O is simulated; the environment comes from the real producer.
    downloadArtifact: async ({ artifact, directory: artifactDirectory }) => {
      const path = join(artifactDirectory, artifact.path);
      await writeFile(path, "apiVersion: v1\nkind: List\nitems: []\n");
      return path;
    },
    execFile: async (command, args) => {
      if (command === "openssl") {
        await writeFile(args[args.indexOf("-out") + 1], "synthetic certificate");
        await writeFile(args[args.indexOf("-keyout") + 1], "synthetic key");
      } else {
        assert.deepEqual(args.slice(0, 4), [
          "--kubeconfig",
          join(directory, "kubeconfig"),
          "--context",
          "k3d-openclaw-k8s-routing",
        ]);
      }
      return { stdout: "", stderr: "" };
    },
  });

  // Shared routing preparation must leave opt-in selection to the runner's lane/file inputs.
  assert.equal(prepared.env.OCC_TEST_SLACK_LIVE, undefined);
  const caDirectory = join(directory, "gateway-routing", "test-ca");
  assert.deepEqual(prepared.env, {
    OCC_TEST_GATEWAY_ROUTING_REAL: "1",
    OCC_TEST_ENVOY_GATEWAY_NAMESPACE: "envoy-gateway-system",
    OCC_TEST_CERT_MANAGER_NAMESPACE: "cert-manager",
    OCC_TEST_GATEWAY_CA_CERT_PATH: join(caDirectory, "cert.pem"),
    OCC_TEST_GATEWAY_CA_KEY_PATH: join(caDirectory, "key.pem"),
    NODE_EXTRA_CA_CERTS: join(caDirectory, "cert.pem"),
  });
});

test("runner applies file environment over real preparation defaults without replacing generated values", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state/lane.json");
  const resultsPath = join(root, "results/file-env.json");
  const first = "tests/integration/first.test.mjs";
  const second = "tests/integration/second.test.mjs";
  const laneName = "checks-baseline-2";
  const lane = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/checks-baseline-2.json"), "utf8"),
  );
  // Use the real no-infrastructure preparer, including its persisted lane state.
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    `import { prepareLane, prepareFile } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/ci/prepare.mjs")).href)};
await prepareLane({ lane: ${JSON.stringify(laneName)}, statePath: ${JSON.stringify(statePath)} });
export { prepareFile };
`,
  );
  await writeFile(
    join(root, first),
    `import assert from "node:assert/strict";
import test from "node:test";
test("opt-in case runs", { skip: process.env.OCC_TEST_SLACK_LIVE !== "1" }, () => {
  assert.equal(process.env.OCC_TEST_NAMESPACE_OPENSHELL_REAL, "1");
  assert.equal(process.env.OCC_TEST_FILE_ONLY, "configured");
  assert.equal(process.env.NODE_OPTIONS, "--max-old-space-size=2048");
  assert.equal(process.env.OPENCLAW_ENTERPRISE_CI_STATE, ${JSON.stringify(statePath)});
});
`,
  );
  await writeFile(
    join(root, second),
    `import assert from "node:assert/strict";
import test from "node:test";
test("sibling keeps lane defaults", () => {
  assert.equal(process.env.OCC_TEST_SLACK_LIVE, undefined);
  assert.equal(process.env.OCC_TEST_NAMESPACE_OPENSHELL_REAL, undefined);
  assert.equal(process.env.OCC_TEST_FILE_ONLY, undefined);
  assert.equal(process.env.NODE_OPTIONS, ${JSON.stringify(lane.env.NODE_OPTIONS)});
  assert.equal(process.env.OPENCLAW_ENTERPRISE_CI_STATE, ${JSON.stringify(statePath)});
});
`,
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    groups: { ci: [laneName] },
    lanes: {
      [laneName]: {
        env: lane.env,
        files: [
          {
            path: first,
            expectedTests: ["opt-in case runs"],
            env: {
              OCC_TEST_SLACK_LIVE: "1",
              OCC_TEST_NAMESPACE_OPENSHELL_REAL: "1",
              OCC_TEST_FILE_ONLY: "configured",
              NODE_OPTIONS: "--max-old-space-size=2048",
              OPENCLAW_ENTERPRISE_CI_STATE: "must-not-replace-prepared-state",
            },
          },
          { path: second, expectedTests: ["sibling keeps lane defaults"] },
        ],
      },
    },
  });

  const result = run(root, laneArgs(root, laneName, statePath, resultsPath));
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.deepEqual(summary.counts, { passed: 2, failed: 0, skipped: 0, todo: 0, total: 2 });
  assert.ok(summary.files.every((file) => file.cleanup.status === "passed"));
  await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
});

// These programs own a small filesystem resource through the real lifecycle hooks.
// The runner under test controls phase isolation, ordering, cancellation and cleanup.
async function lifecycleFixture(
  t,
  { failure = null, hold = false, descendant = false, running = false } = {},
) {
  let paths;
  // Register before the temporary directory's removal, so records remain readable
  // if a failed assertion leaves one of this fixture's processes alive.
  t.after(async () => {
    if (!paths) {
      return;
    }
    for (const path of [paths.ready, paths.child]) {
      const record = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
      if (record && procStat(record.pid)?.pgid === record.pgid) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // The process finished between the ownership check and signal.
        }
      }
    }
  });
  const root = await fixture(t);
  paths = Object.fromEntries(
    [
      "state",
      "results",
      "trace",
      "owned",
      "ready",
      "release",
      "child",
      "cleanupObservation",
      "preparedSecret",
      "cleanupSecret",
      "cleanupCommand",
      "engine",
      "running",
    ].map((name) => [name, join(root, `${name}.json`)]),
  );
  paths.engine = join(root, "engine.mjs");
  paths.attempt = join(root, "attempt");
  paths.state = join(paths.attempt, "state.json");
  paths.results = join(paths.attempt, "result.json");
  const shared = `const paths = ${JSON.stringify(paths)};`;
  await writeFile(
    paths.engine,
    [
      `#!${process.execPath}`,
      'import { readFileSync, writeFileSync } from "node:fs";',
      shared,
      "writeFileSync(paths.cleanupCommand, JSON.stringify(process.argv.slice(2)));",
      'const opaque = readFileSync(paths.cleanupSecret, "utf8");',
      "process.stdout.write(opaque);",
      "process.stderr.write(opaque);",
      "process.exitCode = 7;",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    [
      'import { spawn } from "node:child_process";',
      'import { randomBytes } from "node:crypto";',
      'import { existsSync, readFileSync } from "node:fs";',
      'import { appendFile, writeFile } from "node:fs/promises";',
      shared,
      'const pgid = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
      "export async function prepareLane({ statePath }) {",
      '  await appendFile(paths.trace, "prepare:start\\n");',
      `  const state = { version: 1, repositoryRoot: ${JSON.stringify(await realpath(repositoryRoot))}, lane: "lifecycle", prefix: "openclaw-ci-lifecycle", resources: [], fixture: "owned" };`,
      `  if (${JSON.stringify(failure)} === "cleanup") {`,
      '    const opaque = randomBytes(18).toString("hex");',
      "    await writeFile(paths.cleanupSecret, opaque);",
      '    state.resources.push({ id: "fixture-image", kind: "image-tag", owner: state.prefix, name: `localhost/openclaw-ci-image-${opaque}` });',
      "  }",
      `  if (${JSON.stringify(failure)} === "prepare") {`,
      '    state.env = { CI_RUNNER_PREPARED_SECRET: `prepared-${randomBytes(18).toString("hex")}` };',
      "    await writeFile(paths.preparedSecret, state.env.CI_RUNNER_PREPARED_SECRET);",
      "  }",
      "  await writeFile(statePath, JSON.stringify(state));",
      '  await writeFile(paths.owned, "owned resource");',
      `  if (${descendant}) {`,
      '    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });',
      "    await writeFile(paths.child, JSON.stringify({ pid: child.pid, pgid: pgid(child.pid) }));",
      "    child.unref();",
      "  }",
      "  await writeFile(paths.ready, JSON.stringify({ pid: process.pid, pgid: pgid(process.pid) }));",
      `  while (${hold} && !existsSync(paths.release)) {`,
      "    await new Promise((resolve) => setTimeout(resolve, 20));",
      "  }",
      `  if (${JSON.stringify(failure)} === "prepare") throw Object.assign(new Error([process.env.CI_RUNNER_FIXTURE_CREDENTIAL, state.env.CI_RUNNER_PREPARED_SECRET].join(" ")), { args: ["private-lifecycle-argument"], stdout: "private-lifecycle-stdout", stderr: "private-lifecycle-stderr" });`,
      '  await appendFile(paths.trace, "prepare:end\\n");',
      "  return { env: {} };",
      "}",
      "export async function prepareFile() { return { env: {} }; }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "scripts/ci/cleanup.mjs"),
    [
      'import { appendFile, readFile, rm, writeFile } from "node:fs/promises";',
      shared,
      "export async function cleanupState(statePath) {",
      '  await appendFile(paths.trace, "cleanup\\n");',
      `  if (${descendant}) {`,
      '    const child = JSON.parse(await readFile(paths.child, "utf8"));',
      '    const stat = await readFile(`/proc/${child.pid}/stat`, "utf8").catch((error) => { if (error.code !== "ENOENT") throw error; return null; });',
      '    const live = stat !== null && !["Z", "X"].includes(stat.replace(/^.*\\) /su, "").split(" ")[0]);',
      "    await writeFile(paths.cleanupObservation, JSON.stringify({ live }));",
      "  }",
      `  if (${JSON.stringify(failure)} === "cleanup") {`,
      "    process.env.OCC_DOCKER_BIN = paths.engine;",
      `    const { cleanupState } = await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/ci/cleanup.mjs")).href)});`,
      "    return cleanupState(statePath);",
      "  }",
      "  await rm(paths.owned);",
      "  await rm(statePath);",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/integration/lifecycle.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { appendFile, rename, writeFile } from "node:fs/promises";',
      'import { readFileSync } from "node:fs";',
      'import test from "node:test";',
      shared,
      'test("owned lifecycle resource is usable", async () => {',
      "  // Private lifecycle IPC routing must not reach test subprocesses.",
      "  assert.equal(process.env.OPENCLAW_CI_COMPLETE_PHASE, undefined);",
      '  await appendFile(paths.trace, "run\\n");',
      `  if (${running}) {`,
      "    const processes = [];",
      "    let pid = process.pid;",
      `    while (pid > 1 && pid !== ${process.pid} && processes.length < 16) {`,
      '      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").trim().split(/\\s+/u);',
      "      processes.push({ pid, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] });",
      "      pid = Number(fields[1]);",
      "    }",
      "    await writeFile(`${paths.running}.partial`, JSON.stringify(processes));",
      "    await rename(`${paths.running}.partial`, paths.running);",
      "    await new Promise(() => setInterval(() => {}, 1_000));",
      "  }",
      `  assert.notEqual(${JSON.stringify(failure)}, "run", process.env.CI_RUNNER_FIXTURE_CREDENTIAL);`,
      "});",
      "",
    ].join("\n"),
  );
  await writeRunnerManifest(
    root,
    { lanes: { lifecycle: { files: [{ path: "tests/integration/lifecycle.test.mjs" }] } } },
    "scripts/ci/test-suites.json",
  );
  return {
    root,
    ...paths,
    args: [
      "run",
      "lifecycle",
      "--root",
      root,
      "--lifecycle",
      "complete",
      "--attempt",
      paths.attempt,
    ],
  };
}

function lifecycleProcess(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
      .replace(/^.*\) /su, "")
      .trim()
      .split(/\s+/u);
    return {
      pid,
      state: fields[0],
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      start: fields[19],
    };
  } catch {
    return undefined;
  }
}

function lifecycleProcessLive(record) {
  const current = lifecycleProcess(record.pid);
  return current?.start === record.start && !["Z", "X"].includes(current.state);
}

async function startLifecycleFixture(t, options, env = {}) {
  let runner;
  let processes = [];
  // Reap only observed fixture identities, before temporaryDirectory removes the
  // evidence. Assertions below check termination before this fallback can run.
  t.after(async () => {
    for (const record of processes) {
      if (lifecycleProcessLive(record)) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // The owned process finished after the identity check.
        }
      }
    }
    if (runner && runner.exit() === undefined) {
      runner.child.kill("SIGKILL");
      await waitFor(() => runner.exit() !== undefined, 2_000);
    }
  });
  const fixture = await lifecycleFixture(t, options);
  runner = spawnLifecycleRunner([runnerPath, ...fixture.args], repositoryRoot, runnerEnv(env));
  return {
    ...fixture,
    ...runner,
    remember: (records) => {
      processes = records;
    },
  };
}

test(
  "complete lifecycle preserves phase failures and performs owned cleanup",
  { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
  async (t) => {
    for (const failure of [null, "prepare", "run", "cleanup"]) {
      await t.test(failure === null ? "success" : `${failure} failure`, async (t) => {
        const fixture = await lifecycleFixture(t, { failure, descendant: failure === null });
        const result = await runAsync(fixture.root, fixture.args, {}, { timeout: 30_000 });
        assert.equal(result.error, undefined, result.stderr);
        assert.equal(result.status, failure === null ? 0 : 1, result.stderr);
        const artifact = await readFile(fixture.results, "utf8");
        const summary = JSON.parse(artifact);
        const phases = summary.lifecycle.phases;
        assert.equal(phases.prepare.status, failure === "prepare" ? "failed" : "passed");
        assert.equal(phases.run.status, { prepare: "not-run", run: "failed" }[failure] ?? "passed");
        assert.equal(phases.cleanup.status, failure === "cleanup" ? "failed" : "passed");
        assert.equal(phases.prepare.terminal, true);
        assert.equal(phases.cleanup.terminal, true);
        assert.equal(summary.lifecycle.interrupted, null);
        assert.equal(summary.lifecycle.status, failure === null ? "passed" : "failed");
        assert.doesNotMatch(
          result.stdout + result.stderr + artifact,
          /secretauthvalue|private-lifecycle-(?:argument|stdout|stderr)/,
        );
        if (failure === "prepare") {
          // This value did not exist in the parent environment: redaction must
          // include secrets created by preparation and persisted in state.env.
          const preparedSecret = await readFile(fixture.preparedSecret, "utf8");
          assert.equal(
            (result.stdout + result.stderr + artifact).includes(preparedSecret),
            false,
            "prepared state secret escaped into lifecycle diagnostics",
          );
        }
        const expected =
          failure === "prepare"
            ? ["prepare:start", "cleanup"]
            : ["prepare:start", "prepare:end", "run", "cleanup"];
        assert.deepEqual((await readFile(fixture.trace, "utf8")).trim().split("\n"), expected);
        if (failure === "cleanup") {
          const opaque = await readFile(fixture.cleanupSecret, "utf8");
          assert.equal((result.stdout + result.stderr + artifact).includes(opaque), false);
          assert.deepEqual(JSON.parse(await readFile(fixture.cleanupCommand, "utf8")), [
            "image",
            "rm",
            "-f",
            `localhost/openclaw-ci-image-${opaque}`,
          ]);
          assert.deepEqual(phases.cleanup.error, { code: "phase-failed" });
          assert.equal(await readFile(fixture.owned, "utf8"), "owned resource");
        } else {
          await assert.rejects(readFile(fixture.owned), { code: "ENOENT" });
          await assert.rejects(readFile(fixture.state), { code: "ENOENT" });
        }
        if (failure !== "prepare") {
          assert.equal(summary.files.length, 1);
          assert.equal(summary.counts.failed, failure === "run" ? 1 : 0);
          assert.equal(summary.counts.passed, failure === "run" ? 0 : 1);
        }
        if (failure === null) {
          assert.equal(summary.lifecycle.status, "passed");
          // A child surviving preparation must be dead before cleanup touches its resource.
          assert.deepEqual(JSON.parse(await readFile(fixture.cleanupObservation, "utf8")), {
            live: false,
          });
          const child = JSON.parse(await readFile(fixture.child, "utf8"));
          assert.deepEqual(unkilled([child.pid], child.pgid), []);
        }
      });
    }
    // Focused execution shares the lifecycle, including a receipt when
    // preparation fails before Node can report any selected case.
    for (const failure of [null, "prepare"]) {
      await t.test(
        failure === null ? "focused success" : "focused preparation failure",
        async (t) => {
          const fixture = await lifecycleFixture(t, { failure });
          const path = "tests/integration/lifecycle.test.mjs";
          const name = "owned lifecycle resource is usable";
          await writeFile(
            join(fixture.root, path),
            'test("unselected lifecycle case", () => { throw new Error("unselected case executed"); });\n',
            { flag: "a" },
          );
          await writeRunnerManifest(
            fixture.root,
            {
              lanes: {
                lifecycle: {
                  files: [{ path, expectedTests: [name, "unselected lifecycle case"] }],
                },
              },
              groups: { ci: ["lifecycle"] },
            },
            "scripts/ci/test-suites.json",
          );
          const result = await runAsync(
            fixture.root,
            [...fixture.args, "--file", path, "--test-name", name],
            {},
            { timeout: 30_000 },
          );
          assert.equal(result.error, undefined, result.stderr);
          assert.equal(result.status, failure === null ? 0 : 1, result.stderr);
          const summary = JSON.parse(await readFile(fixture.results, "utf8"));
          assert.equal(summary.scope, "focused");
          assert.equal(summary.testName, name);
          assert.equal(
            summary.lifecycle.phases.prepare.status,
            failure === null ? "passed" : "failed",
          );
          assert.equal(
            summary.lifecycle.phases.run.status,
            failure === null ? "passed" : "not-run",
          );
          assert.equal(summary.lifecycle.phases.cleanup.status, "passed");
          assert.equal(summary.counts.total, failure === null ? 1 : 0);
          if (failure === null) {
            assert.deepEqual(
              summary.files[0].tests.map(({ name }) => name),
              [name],
            );
          }
          assert.deepEqual(
            (await readFile(fixture.trace, "utf8")).trim().split("\n"),
            failure === null
              ? ["prepare:start", "prepare:end", "run", "cleanup"]
              : ["prepare:start", "cleanup"],
          );
          await assert.rejects(readFile(fixture.owned), { code: "ENOENT" });
          await assert.rejects(readFile(fixture.state), { code: "ENOENT" });
        },
      );
    }
  },
);

test(
  "complete lifecycle drains interrupted preparation before cleanup and never starts tests",
  { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
  async (t) => {
    let fixture;
    let runner;
    // Release or stop the owned CLI before the fixture directory is removed.
    t.after(async () => {
      if (!runner || runner.exit() !== undefined) {
        return;
      }
      await writeFile(fixture.release, "release");
      if (!(await waitFor(() => runner.exit() !== undefined, 2_000))) {
        runner.child.kill("SIGKILL");
        await waitFor(() => runner.exit() !== undefined, 2_000);
      }
    });
    fixture = await lifecycleFixture(t, { hold: true });
    runner = spawnLifecycleRunner(
      [runnerPath, ...fixture.args],
      repositoryRoot,
      runnerEnv({ CI_RUNNER_DEADLINE_MS: String(Date.now() + 30_000) }),
    );
    assert.equal(await waitFor(() => lifecycleReady(fixture.ready), 15_000), true, runner.stderr());
    process.kill(runner.child.pid, "SIGTERM");
    // Release only after the real CLI acknowledges the signal; an arbitrary sleep
    // could let preparation finish before the cancellation latch is exercised.
    assert.equal(
      await waitFor(() => runner.stderr().includes("SIGTERM"), 5_000),
      true,
      runner.stderr(),
    );
    assert.equal(await readFile(fixture.trace, "utf8"), "prepare:start\n");
    await assert.rejects(readFile(fixture.results), { code: "ENOENT" });
    await writeFile(fixture.release, "release");
    assert.ok(await waitFor(() => runner.exit() !== undefined, 10_000), runner.stderr());
    assert.deepEqual(runner.exit(), { code: 143, signal: null }, runner.stderr());
    const summary = JSON.parse(await readFile(fixture.results, "utf8"));
    assert.equal(summary.lifecycle.interrupted, "SIGTERM");
    assert.equal(summary.lifecycle.phases.prepare.status, "passed");
    assert.equal(summary.lifecycle.phases.run.status, "not-run");
    assert.equal(summary.lifecycle.phases.cleanup.status, "passed");
    assert.equal(await readFile(fixture.trace, "utf8"), "prepare:start\nprepare:end\ncleanup\n");
    await assert.rejects(readFile(fixture.owned), { code: "ENOENT" });
  },
);

test(
  "complete lifecycle retains owned state when preparation exceeds its deadline",
  { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
  async (t) => {
    const fixture = await lifecycleFixture(t, { hold: true });
    const result = await runAsync(
      fixture.root,
      fixture.args,
      { CI_RUNNER_DEADLINE_MS: String(Date.now() + 5_000) },
      { timeout: 30_000 },
    );
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(fixture.results, "utf8"));
    assert.equal(summary.lifecycle.status, "reconciliation-required");
    assert.equal(summary.lifecycle.phases.prepare.status, "timed-out");
    assert.equal(summary.lifecycle.phases.run.status, "not-run");
    assert.equal(summary.lifecycle.phases.cleanup.status, "not-run");
    assert.equal(await readFile(fixture.trace, "utf8"), "prepare:start\n");
    assert.equal(await readFile(fixture.owned, "utf8"), "owned resource");
    assert.equal(JSON.parse(await readFile(fixture.state, "utf8")).fixture, "owned");
  },
);

test(
  "complete lifecycle refuses invalid attempts and legacy output paths before starting phases",
  { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
  async (t) => {
    for (const scenario of [
      "existing attempt",
      "missing selected file",
      "missing parent",
      "legacy state",
      "legacy results",
      "legacy state/result alias",
      "name without file",
      "missing name value",
      "name followed by option",
      "empty equals name",
      "duplicate separate then equals",
      "duplicate equals then separate",
      "duplicate separate",
      "duplicate equals",
      "duplicate empty then separate",
      "duplicate empty then equals",
      "unregistered name",
      "empty name",
      "overlong name",
      "reserved root name",
      "reserved file name",
      "name on audit",
      "removed pattern option",
      "removed equals pattern option",
    ]) {
      await t.test(scenario, async (t) => {
        const fixture = await lifecycleFixture(t);
        const sentinel = "state belongs to an earlier owner\n";
        let args = fixture.args;
        if (scenario === "existing attempt") {
          await mkdir(fixture.attempt);
          await writeFile(fixture.state, sentinel);
        } else if (scenario === "missing selected file") {
          await rm(join(fixture.root, "tests/integration/lifecycle.test.mjs"));
        } else if (scenario === "missing parent") {
          args = [...args.slice(0, -1), join(fixture.root, "missing", "attempt")];
        } else if (scenario === "legacy state") {
          args = [...args, "--state", fixture.state];
        } else if (scenario === "legacy results") {
          args = [...args, "--results", fixture.results];
        } else if (scenario === "missing name value") {
          args = [...args, "--file", "tests/integration/lifecycle.test.mjs", "--test-name"];
        } else if (scenario === "name followed by option") {
          args = [...args, "--test-name", "--file", "tests/integration/lifecycle.test.mjs"];
        } else if (scenario === "empty equals name") {
          args = [...args, "--file", "tests/integration/lifecycle.test.mjs", "--test-name="];
        } else if (scenario.startsWith("duplicate ")) {
          const name = "owned lifecycle resource is usable";
          await writeRunnerManifest(
            fixture.root,
            {
              lanes: {
                lifecycle: {
                  files: [{ path: "tests/integration/lifecycle.test.mjs", expectedTests: [name] }],
                },
              },
            },
            "scripts/ci/test-suites.json",
          );
          const selectors = {
            "duplicate separate then equals": ["--test-name", name, `--test-name=${name}`],
            "duplicate equals then separate": [`--test-name=${name}`, "--test-name", name],
            "duplicate separate": ["--test-name", name, "--test-name", name],
            "duplicate equals": [`--test-name=${name}`, `--test-name=${name}`],
            "duplicate empty then separate": ["--test-name=", "--test-name", name],
            "duplicate empty then equals": ["--test-name=", `--test-name=${name}`],
          };
          args = [
            ...args,
            "--file",
            "tests/integration/lifecycle.test.mjs",
            ...selectors[scenario],
          ];
        } else if (scenario === "unregistered name") {
          args = [
            ...args,
            "--file",
            "tests/integration/lifecycle.test.mjs",
            "--test-name",
            "unregistered",
          ];
        } else if (scenario === "name without file") {
          args = [...args, "--test-name", "resource"];
        } else if (
          ["empty name", "overlong name", "reserved root name", "reserved file name"].includes(
            scenario,
          )
        ) {
          const names = {
            "empty name": " ",
            "overlong name": "é".repeat(129),
            "reserved root name": "<root>",
            "reserved file name": join(fixture.root, "tests/integration/lifecycle.test.mjs"),
          };
          args = [
            ...args,
            "--file",
            "tests/integration/lifecycle.test.mjs",
            "--test-name",
            names[scenario],
          ];
        } else if (scenario === "name on audit") {
          args = [
            "audit",
            ...args.slice(2),
            "--file",
            "tests/integration/lifecycle.test.mjs",
            "--test-name",
            "resource",
          ];
        } else if (
          scenario === "removed pattern option" ||
          scenario === "removed equals pattern option"
        ) {
          args = [
            ...args,
            "--file",
            "tests/integration/lifecycle.test.mjs",
            ...(scenario === "removed pattern option"
              ? ["--test-name-pattern", "resource"]
              : ["--test-name-pattern=resource"]),
          ];
        } else if (scenario === "legacy state/result alias") {
          // The former result/ownership-marker collision is rejected as a
          // legacy configuration before either pathname can be written.
          args = [
            ...args,
            "--state",
            fixture.state,
            "--results",
            `${fixture.state}.lifecycle-owner`,
          ];
        }
        const result = await runAsync(fixture.root, args, {}, { timeout: 30_000 });
        assert.equal(result.error, undefined, result.stderr);
        assert.equal(result.status, 1, result.stderr);
        if (scenario.startsWith("duplicate ")) {
          // Reject during parsing, before preparation or creation of an owned attempt.
          assert.match(result.stderr, /--test-name may only be specified once/);
        }
        if (scenario === "existing attempt") {
          assert.equal(await readFile(fixture.state, "utf8"), sentinel);
        } else {
          await assert.rejects(stat(fixture.attempt), { code: "ENOENT" });
        }
        if (scenario === "missing parent") {
          await assert.rejects(stat(join(fixture.root, "missing")), { code: "ENOENT" });
        }
        await assert.rejects(readFile(fixture.trace), { code: "ENOENT" });
        await assert.rejects(readFile(fixture.results), { code: "ENOENT" });
        await assert.rejects(readFile(fixture.owned), { code: "ENOENT" });
      });
    }
  },
);

test(
  "complete lifecycle restricts manifest selection before effects",
  { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
  async (t) => {
    for (const scenario of [
      "relative override",
      "absolute override",
      "symlink override",
      "canonical symlink alias",
    ]) {
      await t.test(scenario, async (t) => {
        const fixture = await lifecycleFixture(t);
        const canonical = join(fixture.root, "scripts/ci/test-suites.json");
        const alternate = JSON.parse(await readFile(canonical, "utf8"));
        // Both definitions select the same real file, but supply different inputs.
        // Use normal lane selection (no --file) so an override reaches the run owner.
        alternate.lanes.lifecycle.env = { CI_RUNNER_MANIFEST_SELECTION: "alternate" };
        await writeJson(join(fixture.root, "alternate.json"), alternate);
        await symlink("alternate.json", join(fixture.root, "alternate-link.json"));
        await symlink("scripts/ci/test-suites.json", join(fixture.root, "canonical-link.json"));
        const paths = {
          "relative override": "./scripts/../alternate.json",
          "absolute override": join(fixture.root, "alternate.json"),
          "symlink override": "alternate-link.json",
          "canonical symlink alias": "canonical-link.json",
        };
        const result = await runAsync(
          fixture.root,
          [...fixture.args, "--manifest", paths[scenario]],
          {},
          { timeout: 30_000 },
        );
        assert.equal(result.error, undefined, result.stderr);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(
          result.stderr.trim(),
          "Complete lifecycle requires the canonical scripts/ci/test-suites.json manifest under --root.",
        );
        for (const path of [fixture.attempt, fixture.trace, fixture.owned, fixture.results]) {
          await assert.rejects(stat(path), { code: "ENOENT" });
        }

        if (scenario === "relative override") {
          // Externally managed run still accepts the alternate definition and uses
          // its input, rather than silently substituting the canonical manifest.
          await writeFile(
            join(fixture.root, "tests/integration/lifecycle.test.mjs"),
            [
              'import assert from "node:assert/strict";',
              'import test from "node:test";',
              'test("alternate manifest input", () => assert.equal(process.env.CI_RUNNER_MANIFEST_SELECTION, "alternate"));',
            ].join("\n"),
          );
          const ordinary = run(
            fixture.root,
            laneArgs(
              fixture.root,
              "lifecycle",
              "state/ordinary.json",
              "results/ordinary.json",
              "alternate.json",
            ),
          );
          assert.equal(ordinary.status, 0, ordinary.stderr);
          const summary = JSON.parse(
            await readFile(join(fixture.root, "results/ordinary.json"), "utf8"),
          );
          assert.equal(summary.counts.passed, 1);
        }
      });
    }
    for (const form of ["relative", "absolute"]) {
      await t.test(`explicit canonical ${form} path`, async (t) => {
        const fixture = await lifecycleFixture(t);
        const manifest =
          form === "relative"
            ? "./scripts/ci/../ci/test-suites.json"
            : join(fixture.root, "scripts/ci/test-suites.json");
        const result = await runAsync(
          fixture.root,
          [...fixture.args, "--manifest", manifest],
          {},
          { timeout: 30_000 },
        );
        assert.equal(result.status, 0, result.stderr);
        const summary = JSON.parse(await readFile(fixture.results, "utf8"));
        assert.equal(summary.lifecycle.status, "passed");
        assert.equal(summary.counts.passed, 1);
        await assert.rejects(stat(fixture.state), { code: "ENOENT" });
        await assert.rejects(stat(fixture.owned), { code: "ENOENT" });
      });
    }
  },
);

test(
  "complete lifecycle losing an attempt claim cannot run phases or clean its winner",
  { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
  async (t) => {
    const winner = await startLifecycleFixture(t, { hold: true });
    assert.equal(await waitFor(() => lifecycleReady(winner.ready), 15_000), true, winner.stderr());
    const state = await readFile(winner.state, "utf8");
    assert.equal(JSON.parse(state).version, 1);
    assert.equal((await stat(winner.attempt)).mode & 0o777, 0o700);
    const owned = await readFile(winner.owned, "utf8");
    const sentinelPath = join(winner.attempt, "winner-sentinel");
    await writeFile(sentinelPath, "belongs to the winning attempt");
    // Both invocations use the same real atomic claim. The loser observes valid
    // foreign state but has no authority to invoke its cleanup hook.
    const loser = await runAsync(winner.root, winner.args, {}, { timeout: 10_000 });
    assert.equal(loser.error, undefined, loser.stderr);
    assert.equal(loser.status, 1, loser.stderr);
    assert.equal(await readFile(winner.state, "utf8"), state);
    assert.equal(await readFile(winner.owned, "utf8"), owned);
    assert.equal(await readFile(sentinelPath, "utf8"), "belongs to the winning attempt");
    assert.equal(await readFile(winner.trace, "utf8"), "prepare:start\n");
    await assert.rejects(readFile(winner.results), { code: "ENOENT" });
    await writeFile(winner.release, "release");
    assert.ok(await waitFor(() => winner.exit() !== undefined, 10_000), winner.stderr());
    assert.deepEqual(winner.exit(), { code: 0, signal: null }, winner.stderr());
    assert.equal(
      await readFile(winner.trace, "utf8"),
      "prepare:start\nprepare:end\nrun\ncleanup\n",
    );
    await assert.rejects(readFile(winner.owned), { code: "ENOENT" });
  },
);

test(
  "complete lifecycle owns detached test groups after deadline or coordinator loss",
  { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
  async (t) => {
    for (const cause of ["deadline", "coordinator disconnect"]) {
      await t.test(cause, async (t) => {
        const deadline = Date.now() + (cause === "deadline" ? 10_000 : 30_000);
        const fixture = await startLifecycleFixture(
          t,
          { running: true },
          {
            CI_RUNNER_DEADLINE_MS: String(deadline),
            CI_RUNNER_TEST_TIMEOUT_MS: "60000",
          },
        );
        const records = await waitFor(() => {
          try {
            return JSON.parse(readFileSync(fixture.running, "utf8"));
          } catch {
            return false;
          }
        }, 7_000);
        assert.ok(Array.isArray(records), fixture.stderr());
        fixture.remember(records);
        assert.equal(records.at(-1).pid, fixture.child.pid);
        assert.equal(records.at(-1).ppid, process.pid);
        const body = records[0];
        const anchor = records.find((record) => record.pid === body.pgid);
        assert.ok(anchor, "the detached Node test group has an observed live owner");
        const phase = records.find((record) => record.pid === anchor.ppid);
        assert.ok(phase, "the group owner belongs to the lifecycle run phase");
        assert.equal(phase.ppid, fixture.child.pid);
        assert.notEqual(body.pgid, lifecycleProcess(process.pid).pgid);
        assert.ok(records.every(lifecycleProcessLive), "readiness records live fixture processes");
        if (cause === "deadline") {
          // Stop only the phase, leaving its detached Node group live. Its own
          // timer cannot hide a failure of the outer owner's deadline cleanup.
          process.kill(phase.pid, "SIGSTOP");
          assert.equal(
            await waitFor(() => lifecycleProcess(phase.pid)?.state === "T", 1_000),
            true,
          );
          assert.ok(lifecycleProcessLive(body));
        } else {
          // Killing the real coordinator closes IPC naturally; no synthetic
          // disconnect event or replacement handler supplies the behavior.
          process.kill(fixture.child.pid, "SIGKILL");
        }
        assert.equal(
          await waitFor(() => records.every((record) => !lifecycleProcessLive(record)), 15_000),
          true,
          "owned detached test processes must terminate before fixture teardown",
        );
        assert.ok(await waitFor(() => fixture.exit() !== undefined, 2_000), fixture.stderr());
        assert.equal(await readFile(fixture.trace, "utf8"), "prepare:start\nprepare:end\nrun\n");
        assert.equal(await readFile(fixture.owned, "utf8"), "owned resource");
        assert.equal(JSON.parse(await readFile(fixture.state, "utf8")).version, 1);
        if (cause === "deadline") {
          assert.deepEqual(fixture.exit(), { code: 1, signal: null }, fixture.stderr());
          const summary = JSON.parse(await readFile(fixture.results, "utf8"));
          assert.equal(summary.lifecycle.status, "reconciliation-required");
          assert.equal(summary.lifecycle.phases.run.status, "timed-out");
          assert.equal(summary.lifecycle.phases.cleanup.status, "not-run");
        } else {
          assert.deepEqual(fixture.exit(), { code: null, signal: "SIGKILL" });
          await assert.rejects(readFile(fixture.results), { code: "ENOENT" });
        }
      });
    }
  },
);

test("run resolves lane documents relative to the manifest and preserves ordered case accounting", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state/lane.jsonl");
  const resultsPath = join(root, "results/baseline.json");
  await writePrepare(root);

  await writeFile(
    join(root, "tests/integration/first.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { writeFileSync } from "node:fs";',
      'import test from "node:test";',
      "writeFileSync(process.env.CI_RUNNER_PROCESS_RECORD, String(process.ppid));",
      'test("first file sees scoped env", () => {',
      '  assert.equal(process.env.CI_RUNNER_SCOPED_VALUE, "one");',
      "  assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, undefined);",
      "  assert.equal(process.env.ACTIONS_RESULTS_URL, undefined);",
      "  assert.match(process.env.OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE, /@sha256:d{64}$/);",
      "  assert.match(process.env.OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE, /@sha256:e{64}$/);",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/integration/second.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("second file does not inherit scoped env", () => {',
      "  assert.equal(process.env.CI_RUNNER_SCOPED_VALUE, undefined);",
      "});",
      "",
    ].join("\n"),
  );
  // Lane documents follow the manifest, but test paths still follow --root.
  await mkdir(join(root, "manifests/lanes"), { recursive: true });
  await writeJson(join(root, "manifests/lanes/baseline.json"), {
    requiredEnv: [
      "OCC_PROBE_CONTROLLER_IMAGE",
      "OCC_PROBE_BROKER_IMAGE",
      "OCC_PROBE_OLD_CONTROLLER_IMAGE",
      "OCC_PROBE_OLD_BROKER_IMAGE",
      "OCC_TEST_RELEASED_CONTROLLER_IMAGE",
      "OCC_TEST_CANDIDATE_CONTROLLER_IMAGE",
    ],
    files: [
      {
        path: "tests/integration/first.test.mjs",
        expectedTests: ["first file sees scoped env"],
      },
      {
        path: "tests/integration/second.test.mjs",
        expectedTests: ["second file does not inherit scoped env"],
      },
    ],
  });
  await writeRunnerManifest(
    root,
    { lanes: { baseline: "./lanes/baseline.json" } },
    "manifests/suites.json",
  );

  const result = run(
    root,
    laneArgs(root, "baseline", statePath, resultsPath, "manifests/suites.json"),
    {
      CI_RUNNER_PROCESS_RECORD: join(root, "state/process-group"),
      ACTIONS_RUNTIME_TOKEN: "synthetic-cache-token",
      ACTIONS_RESULTS_URL: "https://cache.example.test/",
      OCC_PROBE_CONTROLLER_IMAGE: `private.example/current-controller@sha256:${"b".repeat(64)}`,
      OCC_PROBE_BROKER_IMAGE: `private.example/current-broker@sha256:${"c".repeat(64)}`,
      OCC_PROBE_OLD_CONTROLLER_IMAGE: `private.example/old-controller@sha256:${"d".repeat(64)}`,
      OCC_PROBE_OLD_BROKER_IMAGE: `private.example/old-broker@sha256:${"e".repeat(64)}`,
      OCC_TEST_RELEASED_CONTROLLER_IMAGE: `private.example/released-controller@sha256:${"f".repeat(64)}`,
      OCC_TEST_CANDIDATE_CONTROLLER_IMAGE: `private.example/candidate-controller@sha256:${"1".repeat(64)}`,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.sourceSha, currentSha());
  assert.equal(summary.status, "passed");
  assert.equal(summary.counts.passed, 2);
  assert.equal(summary.counts.skipped, 0);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ["tests/integration/first.test.mjs", "tests/integration/second.test.mjs"],
  );
  assert.equal(summary.files[0].cleanup.status, "passed");
  // The test child reports its real parent, the detached Node runner's group leader.
  assert.equal(
    summary.files[0].processGroupId,
    Number(await readFile(join(root, "state/process-group"), "utf8")),
  );
  assert.ok(
    summary.files.every(
      (file) => Number.isInteger(file.wallDurationMs) && file.wallDurationMs >= 0,
    ),
  );
  // Evidence must retain immutable identity without exporting private registry names
  // or arbitrary prepared environment values alongside the public CI artifact.
  const pairDigests = {
    pairController: `sha256:${"b".repeat(64)}`,
    pairBroker: `sha256:${"c".repeat(64)}`,
    pairOldController: `sha256:${"d".repeat(64)}`,
    pairOldBroker: `sha256:${"e".repeat(64)}`,
    releasedController: `sha256:${"f".repeat(64)}`,
    candidateController: `sha256:${"1".repeat(64)}`,
  };
  assert.deepEqual(summary.files[0].imageDigests, {
    controller: `sha256:${"a".repeat(64)}`,
    runtime: `sha256:${"b".repeat(64)}`,
    controllerUpgrade: `sha256:${"d".repeat(64)}`,
    runtimeUpgrade: `sha256:${"e".repeat(64)}`,
    repositoryCredentials: `sha256:${"c".repeat(64)}`,
    ...pairDigests,
  });
  assert.deepEqual(summary.files[1].imageDigests, pairDigests);
  assert.doesNotMatch(JSON.stringify(summary), /private\.example|untrusted-image-value/);
  assert.match(await readFile(statePath, "utf8"), /first\.test\.mjs/);
});

test("focused runs retain case enforcement and cleanup but cannot complete a full lane", async (t) => {
  const root = await fixture(t);
  await writePrepare(root);
  const selectedPath = "tests/integration/first.test.mjs";
  const selected = { path: selectedPath, expectedTests: ["required case"] };
  await writeFile(
    join(root, selectedPath),
    'import test from "node:test"; test("required case", () => {});\n',
  );
  await writeFile(
    join(root, "tests/integration/second.test.mjs"),
    'throw new Error("unselected file executed");\n',
  );
  await writeRunnerManifest(root, {
    lanes: {
      baseline: { files: [selected, { path: "tests/integration/second.test.mjs" }] },
      single: { files: [selected] },
    },
    groups: { ci: ["baseline"] },
  });
  const args = (lane, selector = selectedPath) => [
    ...laneArgs(root, lane, `state/${lane}.jsonl`, `results/${lane}.json`),
    "--file",
    selector,
  ];
  for (const lane of ["baseline", "single"]) {
    const result = run(root, args(lane));
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(await readFile(join(root, `results/${lane}.json`), "utf8"));
    assert.equal(summary.scope, "focused");
    assert.deepEqual(
      summary.files.map((file) => file.path),
      [selectedPath],
    );
    assert.equal(summary.files[0].cleanup.status, "passed");
    assert.equal(await readFile(join(root, `state/${lane}.jsonl`), "utf8"), `${selectedPath}\n`);
    // Even a one-file lane cannot turn explicitly focused proof into full qualification.
    const aggregated = run(root, aggregateArgs(root, lane));
    assert.equal(aggregated.status, 1, aggregated.stderr);
    const evidence = JSON.parse(aggregated.stdout);
    assert.ok(evidence.issues.some(({ code }) => code === "focused-lane-evidence"));
    if (lane === "baseline") {
      assert.ok(evidence.issues.some(({ code }) => code === "missing-lane-evidence"));
    }
  }
  // The literal name must reach the actual Node child. The other required
  // case must not execute, but the result remains focused evidence.
  const testName = "required case";
  const filteredArgs = [...args("single"), "--test-name", testName];
  await writeSingleLaneManifest(
    root,
    "single",
    [{ path: selectedPath, expectedTests: [testName, "unselected required case"] }],
    { ci: ["single"] },
  );
  await writeFile(
    join(root, selectedPath),
    [
      'import test from "node:test";',
      'test("required case", () => {});',
      'test("unselected required case", () => { throw new Error("unselected case executed"); });',
    ].join("\n"),
  );
  const filtered = run(root, filteredArgs);
  assert.equal(filtered.status, 0, filtered.stderr);
  const focused = JSON.parse(await readFile(join(root, "results/single.json"), "utf8"));
  assert.equal(focused.scope, "focused");
  assert.equal(focused.testName, testName);
  assert.deepEqual(focused.counts, { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 });
  assert.deepEqual(
    focused.files[0].tests.map(({ name }) => name),
    [testName],
  );
  assert.equal(focused.files[0].cleanup.status, "passed");
  const filteredAggregate = run(root, [
    "aggregate",
    "single",
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--results-dir",
    "results",
  ]);
  assert.equal(filteredAggregate.status, 1, filteredAggregate.stderr);
  assert.ok(
    JSON.parse(filteredAggregate.stdout).issues.some(
      ({ code }) => code === "focused-lane-evidence",
    ),
  );

  // Node can also match trimmed ancestry. Reject every extra or differently
  // named test, and reject suites/subtests even when named as the file wrapper.
  for (const scenario of [
    {
      name: "no match",
      testName: "absent",
      source: 'test("required case", () => {});',
      issue: "invalid-test-selection",
    },
    {
      name: "unregistered existing case",
      testName: "unregistered",
      source: 'test("unregistered", () => {});',
      issue: "invalid-test-selection",
    },
    {
      name: "missing selected expectation",
      source: 'test("different case", () => {});',
      issue: "missing-expected-test",
    },
    {
      name: "trimmed name is not exact",
      source: 'test(" required case ", () => {});',
      issue: "unexpected-test-selection",
    },
    {
      name: "additional trimmed name",
      source: 'test("required case", () => {}); test(" required case ", () => {});',
      issue: "unexpected-test-selection",
    },
    {
      name: "duplicate exact name",
      source: 'test("required case", () => {}); test("required case", () => {});',
      issue: "unexpected-test-selection",
    },
    {
      name: "selected skip",
      source: 'test.skip("required case", () => {});',
      issue: "unexpected-skip",
    },
    { name: "selected todo", source: 'test.todo("required case");', issue: "unexpected-skip" },
    {
      name: "nested case",
      source: 'test("required case", async (t) => { await t.test("descendant", () => {}); });',
      issue: "unsupported-test-selection",
    },
    {
      name: "nested case named as the file wrapper",
      source:
        'test("required case", async (t) => { await t.test(new URL(import.meta.url).pathname, () => {}); });',
      issue: "unsupported-test-selection",
    },
    {
      name: "suite",
      source: 'describe("required case", () => { test("descendant", () => {}); });',
      issue: "unsupported-test-selection",
    },
    {
      name: "nested suite named as the file wrapper",
      source:
        'describe("required case", () => { describe(new URL(import.meta.url).pathname, () => {}); });',
      issue: "unsupported-test-selection",
    },
  ]) {
    await writeSingleLaneManifest(
      root,
      "single",
      [{ path: selectedPath, expectedTests: [testName, "unselected required case"] }],
      { ci: ["single"] },
    );
    await writeFile(
      join(root, selectedPath),
      `import test, { describe } from "node:test";\n${scenario.source}\n`,
    );
    const result = run(root, [...args("single"), "--test-name", scenario.testName ?? testName]);
    assert.equal(result.status, 1, `${scenario.name}: ${result.stderr}`);
    const evidence = JSON.parse(await readFile(join(root, "results/single.json"), "utf8"));
    assert.ok(
      evidence.issues.some(({ code }) => code === scenario.issue),
      JSON.stringify(evidence.issues),
    );
    assert.equal(evidence.scope, "focused");
    assert.equal(evidence.testName, scenario.testName ?? testName);
    if (scenario.issue === "invalid-test-selection") {
      assert.deepEqual(evidence.files, []);
    } else {
      assert.equal(evidence.files[0].cleanup.status, "passed");
    }
  }

  // Regex metacharacters are literal. A 256-byte UTF-8 name is accepted, and
  // the manifest and reported name must both match exactly.
  for (const name of ["--dry-run=preserves state", "literal [case].* /i", "é".repeat(128)]) {
    await writeSingleLaneManifest(
      root,
      "single",
      [{ path: selectedPath, expectedTests: [name, "unselected required case"] }],
      { ci: ["single"] },
    );
    await writeFile(
      join(root, selectedPath),
      `import test from "node:test";
      test(${JSON.stringify(name)}, () => {});
      test("unselected required case", () => { throw new Error("unselected case executed"); });\n`,
    );
    // A leading switch-like name needs the equals form; the throwing sibling
    // proves that exactly the selected literal reaches the child.
    const selector = name.startsWith("--") ? [`--test-name=${name}`] : ["--test-name", name];
    const result = run(root, [...args("single"), ...selector]);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(await readFile(join(root, "results/single.json"), "utf8"));
    assert.equal(evidence.scope, "focused");
    assert.equal(evidence.testName, name);
    assert.deepEqual(evidence.counts, { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 });
    assert.deepEqual(
      evidence.files[0].tests.map(({ name }) => name),
      [name],
    );
    assert.equal(evidence.files[0].cleanup.status, "passed");
  }

  // Restore the file-only lanes for their unchanged missing-case contract.
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    lanes: {
      baseline: { files: [selected, { path: "tests/integration/second.test.mjs" }] },
      single: { files: [selected] },
    },
    groups: { ci: ["baseline"] },
  });
  // A green Node process is insufficient when the selected file omits its required case.
  await writeFile(
    join(root, selectedPath),
    'import test from "node:test"; test("different case", () => {});\n',
  );
  const missing = run(root, args("baseline"));
  assert.equal(missing.status, 1, missing.stderr);
  const summary = JSON.parse(await readFile(join(root, "results/baseline.json"), "utf8"));
  assert.ok(summary.issues.some(({ code }) => code === "missing-expected-test"));
  assert.equal(summary.files[0].cleanup.status, "passed");
  const stateBefore = await readFile(join(root, "state/baseline.jsonl"), "utf8");
  for (const path of [
    "tests/integration/unknown.test.mjs",
    "tests/integration/../integration/first.test.mjs",
  ]) {
    const invalid = run(root, args("baseline", path));
    assert.equal(invalid.status, 1, invalid.stderr);
    const rejected = JSON.parse(await readFile(join(root, "results/baseline.json"), "utf8"));
    assert.deepEqual(rejected.files, []);
    assert.ok(rejected.issues.some(({ code }) => code === "invalid-file-selection"));
    assert.equal(await readFile(join(root, "state/baseline.jsonl"), "utf8"), stateBefore);
  }
});

test("run preserves nonzero child Node exits and rejects zero-case files", async (t) => {
  const root = await fixture(t);
  await writeRunnerManifest(root, {
    lanes: {
      exits: {
        files: [{ path: "tests/integration/exits.test.mjs" }],
      },
      empty: {
        files: [{ path: "tests/integration/empty.test.mjs" }],
      },
    },
  });
  await writeFile(join(root, "tests/integration/exits.test.mjs"), "process.exit(42);\n");
  await writeFile(join(root, "tests/integration/empty.test.mjs"), "process.exit(0);\n");

  const exits = run(root, laneArgs(root, "exits", "state/exits.jsonl", "results/exits.json"));
  assert.notEqual(exits.status, 0);
  const exitSummary = JSON.parse(await readFile(join(root, "results/exits.json"), "utf8"));
  assert.equal(exitSummary.exitCode, exits.status);

  const empty = run(root, laneArgs(root, "empty", "state/empty.jsonl", "results/empty.json"));
  assert.equal(empty.status, 1);
  const emptySummary = JSON.parse(await readFile(join(root, "results/empty.json"), "utf8"));
  assert.deepEqual(
    emptySummary.issues.map((entry) => entry.code),
    ["selected-zero"],
  );
});

test(
  "run annotates the first failed file before the lane finishes",
  { timeout: 30_000 },
  async (t) => {
    const root = await fixture(t);
    const first = "first.test.mjs";
    const second = "second.test.mjs";
    const files = [first, second].map((path) => ({ path }));
    await writePrepare(root);
    await writeSingleLaneManifest(root, "sample", files, {});
    await writeFile(
      join(root, first),
      'import test from "node:test";\ntest("private-case-canary", () => { throw new Error("::warning::private-message-canary"); });\n',
    );
    // Hold another failing file open to distinguish live reporting from a final summary.
    const release = join(root, "release");
    await writeFile(
      join(root, second),
      `import { existsSync } from "node:fs";
     import { setTimeout } from "node:timers/promises";
     import test from "node:test";
     test("second failure", {timeout: 20000}, async () => {
       while (!existsSync(${JSON.stringify(release)})) await setTimeout(50);
       throw new Error("second failure");
     });\n`,
    );
    const args = laneArgs(root, "sample", "state/lane.jsonl", "results/sample.json");
    const child = spawn(process.execPath, [runnerPath, ...args], {
      env: runnerEnv({ GITHUB_ACTIONS: "true" }),
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const closed = new Promise((resolve, reject) =>
      child.once("error", reject).once("close", resolve),
    );
    let code;
    const commands = () => stderr.match(/^::.*$/gm) ?? [];
    try {
      // Match the entire workflow command: no child-controlled text or extra commands.
      assert.ok(await waitFor(() => /^::.*\n/m.test(stderr), 10_000), "live workflow command");
      assert.deepEqual(commands(), [
        "::error title=Test lane failure::A test file reported failed tests and its cleanup passed. Final lane results will follow.",
      ]);
    } finally {
      await writeFile(release, "");
      code = await closed;
    }
    assert.equal(code, 1);
    assert.equal(commands().length, 1);
    assert.equal(await readFile(join(root, "state/lane.jsonl"), "utf8"), `${first}\n${second}\n`);
    const result = JSON.parse(await readFile(join(root, "results/sample.json"), "utf8"));
    assert.equal(result.counts.failed, 2);
  },
);

test(
  "CI streams safe OpenShell failures before cleanup and retains the original error",
  { timeout: 25_000 },
  async (t) => {
    const root = await fixture(t);
    const file = "tests/integration/stage-failure.test.mjs";
    const resultsPath = join(root, "results/failure.json");
    const moduleUrl = pathToFileURL(join(repositoryRoot, "tests/helpers/openshell-stage.mjs")).href;
    const teardownUrl = pathToFileURL(
      join(repositoryRoot, "tests/helpers/bounded-teardown.ts"),
    ).href;
    const progressUrl = pathToFileURL(
      join(repositoryRoot, "scripts/ci/openshell-progress.mjs"),
    ).href;
    const canary = "generated-credential-must-stay-private";
    await writeSingleLaneManifest(root, "failure", [{ path: file }], {});
    await writeFile(
      join(root, file),
      `
import assert from "node:assert/strict";
import { watch, writeFileSync } from "node:fs";
import test from "node:test";
import { runOpenShellStage } from ${JSON.stringify(moduleUrl)};
import { boundedTeardown } from ${JSON.stringify(teardownUrl)};
import { openShellProgressPrefix } from ${JSON.stringify(progressUrl)};
test("original failure", async (t) => {
  const { context } = boundedTeardown(t);
  context.after(() => new Promise((resolve) => {
    const watcher = watch(${JSON.stringify(root)}, (_event, name) => {
      if (name === "release") { watcher.close(); resolve(); }
    });
    writeFileSync(${JSON.stringify(join(root, "cleanup-ready"))}, "ready");
  }));
  const canary = ${JSON.stringify(canary)};
  const record = { kind: "openshell-stage-failure", stage: "installation", category: "Error", code: null,
    location: "tests/helpers/openshell-sandbox-workflows.mjs" };
  for (const change of [{ category: canary }, { code: canary }, { location: canary }, { stage: canary }, { detail: canary }]) {
    process.stdout.write(openShellProgressPrefix + JSON.stringify({ ...record, ...change }) + "\\n");
  }
  assert.equal(await runOpenShellStage(t, "installation", async () => 42, "installation"), 42);
  // A real source path embedded in a message or custom stack is not provenance.
  const spoof = new Error(canary + "\\n    at ${pathToFileURL(join(repositoryRoot, "scripts/ci/reporter.mjs")).href}:999999:123456");
  spoof.stack = spoof.message;
  spoof.code = "ETIMEDOUT";
  let accessed = 0;
  const getter = () => { accessed++; throw new Error(canary); };
  const unreadableName = new Error(canary);
  Object.defineProperties(unreadableName, { name: { get: getter }, stack: { get: getter }, code: { value: "ENOENT" } });
  const unreadableCode = new Error(canary);
  Object.defineProperties(unreadableCode, { name: { value: "RangeError" }, stack: { get: getter }, code: { get: getter } });
  const opaque = new Proxy(new Error(canary), { get: getter, getOwnPropertyDescriptor: getter });
  const opaquePrototype = Object.setPrototypeOf(new Error(canary), new Proxy({}, { get: getter, getPrototypeOf: getter }));
  for (const error of [spoof, unreadableName, unreadableCode, opaque, new TypeError(canary), new RangeError(canary), opaquePrototype]) {
    let caught;
    try { await runOpenShellStage(t, "installation", async () => { throw error; }); }
    catch (actual) { caught = actual; }
    assert.equal(caught, error);
  }
  assert.equal(accessed, 0, "diagnostics must not invoke error accessors or proxy traps");
  let original;
  await assert.rejects(runOpenShellStage(t, "installation", async () => {
    try { assert.fail("original-stage-failure"); }
    catch (error) { original = error; throw error; }
  }, "installation"), (error) => error === original);
  writeFileSync(${JSON.stringify(join(root, "identity-verified"))}, "original-error-identity-verified");
  throw original;
});
`,
    );
    let markReady;
    const ready = new Promise((resolve) => {
      markReady = resolve;
    });
    const watcher = watch(root, (_event, name) => {
      if (name === "cleanup-ready") {
        watcher.close();
        markReady(true);
      }
    });
    t.after(() => watcher.close());
    const child = spawn(
      process.execPath,
      [runnerPath, ...laneArgs(root, "failure", "state/failure.jsonl", resultsPath)],
      {
        cwd: repositoryRoot,
        env: runnerEnv({ CI_RUNNER_TEST_TIMEOUT_MS: "10000" }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const failures = [];
    let markLive;
    const live = new Promise((resolve) => {
      markLive = resolve;
    });
    const lines = createInterface({ input: child.stderr });
    const label = `[run:failure] ${file}: openshell-stage-failure installation `;
    lines.on("line", (line) => {
      if (line.startsWith(label)) {
        failures.push(line.slice(label.length));
        if (failures.length === 8) {
          markLive(true);
        }
      }
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        markReady(false);
        markLive(false);
        resolve({ code, signal });
      });
    });
    t.after(async () => {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await closed;
    });
    // Neither final accounting nor a buffered transcript can release this handshake.
    assert.deepEqual(await Promise.all([ready, live]), [true, true], stderr);
    assert.equal(child.exitCode, null);
    assert.equal(
      await readFile(join(root, "identity-verified"), "utf8"),
      "original-error-identity-verified",
    );
    assert.equal((stdout + stderr).includes(canary), false);
    assert.equal((stdout + stderr).includes("999999:123456"), false);
    const location = " workflow=tests/helpers/openshell-sandbox-workflows.mjs";
    assert.deepEqual(
      failures,
      [
        "Error code=ETIMEDOUT",
        "Error code=ENOENT",
        "RangeError code=unknown",
        "unknown code=unknown",
        "TypeError code=unknown",
        "RangeError code=unknown",
        "unknown code=unknown",
        "AssertionError code=ERR_ASSERTION",
      ].map((value) => value + location),
    );
    await writeFile(join(root, "release"), "release cleanup");
    assert.deepEqual(await closed, { code: 1, signal: null });
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    assert.equal(summary.counts.failed, 1);
    const failure = summary.files[0].tests.find(({ name }) => name === "original failure");
    assert.equal(failure.error.message, "original-stage-failure");
    assert.equal(failure.error.code, "ERR_TEST_FAILURE");
    assert.deepEqual(failure.error.cause, { code: "ERR_ASSERTION", name: "AssertionError" });
    assert.ok(
      summary.files[0].measurements.some(
        ({ kind, outcome }) => kind === "openshell-sandbox-phase" && outcome === "passed",
      ),
    );
    assert.ok(
      summary.files[0].measurements.some(
        ({ kind, outcome }) => kind === "openshell-sandbox-phase" && outcome === "failed",
      ),
    );
  },
);

test(
  "run reports bounded OpenShell progress before the test file finishes",
  { timeout: 30_000 },
  async (t) => {
    const root = await fixture(t);
    const file = "tests/integration/progress.test.mjs";
    const resultsPath = join(root, "results/progress.json");
    await writeSingleLaneManifest(root, "progress", [{ path: file }], {});
    await writeFile(
      join(root, file),
      `import { watch } from "node:fs";
import test from "node:test";
import { emitOpenShellProgress, openShellProgressPrefix } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/ci/openshell-progress.mjs")).href)};
const write = (text) => new Promise((resolve, reject) => process.stdout.write(text, (error) => error ? reject(error) : resolve()));
const record = (value) => openShellProgressPrefix + JSON.stringify(value) + "\\n";
// The legitimate start/pass record also crosses many reporter pipe chunks.
test("live progress " + "x".repeat(1024 * 1024), async (context) => {
  const stage = { kind: "openshell-stage", stage: "installation", outcome: "started" };
  for (const invalid of [
    { ...stage, kind: "private-kind-canary" },
    { ...stage, stage: "private-stage-canary" },
    { ...stage, outcome: "private-outcome-canary" },
    { ...stage, detail: "private-detail-canary" },
    { ...stage, elapsedMs: 1 },
    { ...stage, file: "private-file-canary" },
    null,
    [stage],
  ]) await write(record(invalid));
  // A prefix and invalid payload can span writes; oversized lines must be dropped through newline.
  const split = record({ ...stage, detail: "private-fragment-canary" });
  await write(split.slice(0, 8));
  await write(split.slice(8));
  await write(openShellProgressPrefix + "private-oversized-canary".repeat(50000));
  await write(record(stage));
  await write(openShellProgressPrefix + "private-malformed-canary\\n");
  // Subscribe before the actual producer runs: only live progress releases the test.
  let watcher;
  const released = new Promise((resolve) => {
    watcher = watch(${JSON.stringify(root)}, (_event, name) => {
      if (name === "release") { watcher.close(); resolve(); }
    });
  });
  context.after(() => watcher.close());
  // Fill the tail through its batch boundary, retaining a real blank and an unfinished line.
  await write(Array.from({ length: 798 }, (_, i) => "useful line " + i).join("\\n") + "\\n\\nunfinished ordinary output");
  emitOpenShellProgress("installation", "started");
  await released;
  emitOpenShellProgress("installation", "passed");
  context.diagnostic('openclaw-ci-measurement ' + JSON.stringify({ ...stage, outcome: "passed", elapsedMs: 123 }));
});
test("failed stage", async () => {
  emitOpenShellProgress("initial-model", "started");
  try { throw new Error("expected stage failure"); }
  finally {
    emitOpenShellProgress("initial-model", "failed");
    // An unterminated record is neither live progress nor raw failure output.
    await write(record({ kind: "openshell-stage", stage: "replacement", outcome: "started" }).slice(0, -1));
  }
});
`,
    );
    const child = spawn(
      process.execPath,
      [runnerPath, ...laneArgs(root, "progress", "state/progress.jsonl", resultsPath)],
      {
        cwd: repositoryRoot,
        env: runnerEnv({ CI_RUNNER_TEST_TIMEOUT_MS: "10000" }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const progress = [];
    const label = `[run:progress] ${file}: `;
    const lines = createInterface({ input: child.stderr });
    const closed = new Promise((resolve, reject) =>
      child.once("error", reject).once("close", resolve),
    );
    const live = new Promise((resolve) => {
      lines.on("line", (line) => {
        if (line === `${label}openshell-stage installation started`) {
          resolve(true);
        }
      });
      child.once("close", () => resolve(false));
    });
    t.after(() => {
      lines.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
    });
    lines.on("line", (line) => {
      if (!line.startsWith(label)) {
        return;
      }
      progress.push(line.slice(label.length));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // A final buffered transcript cannot satisfy this handshake.
    assert.ok(await live, "progress must arrive while the child waits for its release file");
    assert.equal(child.exitCode, null);
    await writeFile(join(root, "release"), "");
    const code = await closed;
    assert.equal(code, 1);
    assert.deepEqual(progress, [
      "openshell-stage installation started",
      "openshell-stage installation passed",
      "openshell-stage initial-model started",
      "openshell-stage initial-model failed",
    ]);
    const artifact = await readFile(resultsPath, "utf8");
    const summary = JSON.parse(artifact);
    assert.equal(summary.counts.passed, 1);
    assert.equal(summary.counts.failed, 1);
    assert.deepEqual(summary.files[0].measurements, [
      { kind: "openshell-stage", stage: "installation", outcome: "passed", elapsedMs: 123 },
    ]);
    const diagnostics = await readFile(join(root, "state/progress.jsonl.diagnostics.json"), "utf8");
    const tail = JSON.parse(diagnostics).failures[0].output;
    assert.deepEqual(tail.lines, [
      ...Array.from({ length: 398 }, (_, index) => `stdout: useful line ${index + 400}`),
      "stdout: ",
      "stdout: unfinished ordinary output",
    ]);
    assert.equal(tail.omittedLines, 400);
    for (const output of [stdout, stderr, artifact, diagnostics]) {
      assert.doesNotMatch(output, /private-\w+-canary/);
    }
  },
);

test("run finishes file accounting and cleanup after a reporter pipe read error", async (t) => {
  const root = await fixture(t);
  await writePrepare(root);
  const file = "tests/integration/pipe.test.mjs";
  const state = join(root, "state/pipe.jsonl");
  const resultPath = join(root, "results/pipe.json");
  await writeSingleLaneManifest(root, "pipe", [{ path: file }], {});
  const injected = join(root, "injected");
  // Hold the real child until its reporter pipe closes so the fault precedes completion.
  await writeFile(
    join(root, file),
    `import test from "node:test";
import { watch } from "node:fs";
import { emitOpenShellProgress } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/ci/openshell-progress.mjs")).href)};
test("case", async () => {
  const released = new Promise((resolve) => {
    const watcher = watch(${JSON.stringify(root)}, (_event, name) => {
      if (name === "injected") { watcher.close(); resolve(); }
    });
  });
  emitOpenShellProgress("installation", "started");
  await released;
});
`,
  );
  const preload = join(root, "pipe-error.mjs");
  // Fault the real child pipe; spawning, reporting, result accounting and cleanup stay real.
  await writeFile(
    preload,
    `import cp from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
cp.spawn = (...args) => {
  const child = spawn(...args);
  if (args[1]?.includes("--test-reporter")) {
    child.stdout.once("data", () => {
      child.stdout.once("close", () => writeFileSync(${JSON.stringify(injected)}, "faulted"));
      child.stdout.destroy(Object.assign(new Error("private-pipe-canary"), { code: "EIO" }));
    });
  }
  return child;
};
syncBuiltinESMExports();
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", preload, runnerPath, ...laneArgs(root, "pipe", state, resultPath)],
    {
      cwd: repositoryRoot,
      env: runnerEnv(),
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(await readFile(injected, "utf8"), "faulted");
  const summary = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(summary.files[0].cleanup.status, "passed");
  assert.equal(await readFile(state, "utf8"), `${file}\n`);
  // The runner preserves native child exit codes, including failures other than 1.
  assert.notEqual(result.status, 0);
  assert.equal(result.status, summary.files[0].nodeExitCode);
  assert.equal(result.status, summary.exitCode);
  assert.doesNotMatch(result.stderr, /private-pipe-canary|Unhandled.*error/);
});

test("run records a sanitized file failure after all reported cases pass", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/file-failure.json");
  await writeFile(
    join(root, "tests/integration/file-failure.test.mjs"),
    [
      'import test from "node:test";',
      'test("first pass", () => {});',
      'setImmediate(() => { throw new Error("secretauthvalue-root-failure"); });',
      'test("second pass", () => {});',
      "",
    ].join("\n"),
  );
  await writeSingleLaneManifest(
    root,
    "failure",
    [{ path: "tests/integration/file-failure.test.mjs" }],
    { ci: ["failure"] },
  );

  const result = run(root, laneArgs(root, "failure", "state/file-failure.jsonl", resultsPath));
  const artifact = await readFile(resultsPath, "utf8");
  const summary = JSON.parse(artifact);
  assert.equal(result.status, 1);
  assert.equal(summary.counts.passed, 2);
  assert.equal(summary.counts.failed, 0);
  assert.deepEqual(summary.files[0].fileFailure, {
    error: {
      code: "ERR_TEST_FAILURE",
      name: "Error",
      failureType: "testCodeFailure",
      exitCode: 1,
      message: "test failed",
    },
    diagnosticKind: "post-test-async-activity",
  });
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${artifact}`, /secretauthvalue/);
});

const apiKeyWorkflows = ["upstream", "refresh", "withdrawal", "gateway-tool-policy"];

for (const workflow of apiKeyWorkflows) {
  test(`OpenShell ${workflow} discovery is opt-in and enabled cases require an API key`, () => {
    const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
    const file = join(repositoryRoot, `tests/integration/openshell-${workflow}-real.test.ts`);
    const discovery = spawnSync(process.execPath, ["--test", file], {
      env: baseEnv,
      encoding: "utf8",
    });
    assert.equal(discovery.status, 0, discovery.stdout + discovery.stderr);
    assert.match(discovery.stdout, /skipped 1/u);
    for (const enabled of ["", "1"]) {
      // Partial configuration also imports the real shared parser. It must not
      // echo a malformed private endpoint before prerequisite diagnostics run.
      const result = spawnSync(process.execPath, ["--test", file], {
        encoding: "utf8",
        env: {
          ...baseEnv,
          OCC_TEST_OPENSHELL_K3D_REAL: enabled,
          OCC_TEST_OPENSHELL_MODEL_BASE_URL: "malformed-private-endpoint",
        },
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stdout + result.stderr,
        /The OpenShell model endpoint must be a valid absolute URL/u,
      );
      assert.doesNotMatch(result.stdout + result.stderr, /malformed-private-endpoint/u);
    }
    // A native provider file belongs to the guided installer. Reject it before
    // defaulting a foreign provider's key to the public API endpoint.
    for (const endpoint of ["", "https://custom-model.example.test/v1"]) {
      const result = spawnSync(process.execPath, ["--test", file], {
        encoding: "utf8",
        env: {
          ...baseEnv,
          OCC_TEST_OPENSHELL_K3D_REAL: "1",
          OPENAI_API_KEY: "synthetic-custom-provider-key",
          OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
          OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: "synthetic-provider-file",
        },
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stdout + result.stderr,
        /The API-key workflow does not accept native provider overrides/u,
      );
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-provider-file/u);
    }
    for (const endpoint of ["", "   "]) {
      for (const credential of ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"]) {
        // Real wrapper import stops at existing prerequisites before any Helm,
        // Kubernetes or model operation. A blank override must not select a PAT.
        const result = spawnSync(process.execPath, ["--test", file], {
          encoding: "utf8",
          env: {
            ...baseEnv,
            OCC_TEST_OPENSHELL_K3D_REAL: "1",
            OCC_TEST_OPENSHELL_HARNESS: "codex",
            OCC_TEST_OPENAI_MODEL: "fixture-model",
            OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
            [credential]: "synthetic-model-credential",
          },
        });
        assert.equal(result.status, 1);
        assert.match(
          result.stdout + result.stderr,
          credential === "OPENAI_API_KEY"
            ? /OCC_TEST_OPENSHELL_HELM must point/u
            : /The selected Harness requires OPENAI_API_KEY/u,
        );
      }
    }
  });
}

for (const selection of [
  { name: "declared", error: /must be an immutable image@sha256 reference/u },
  {
    name: "inherited Codex",
    harness: "codex",
    error: /must be an immutable image@sha256 reference/u,
  },
  {
    name: "custom destination",
    endpoint: "https://custom-model.example.test/v1",
    error: /Custom OpenShell model endpoints require a focused gateway workflow file/u,
  },
]) {
  for (const focused of [false, true]) {
    test(`the Namespace runner selects file model inputs before setup (${selection.name}, focused: ${focused})`, async (t) => {
      const root = await fixture(t);
      const suites = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
      const lane = suites.lanes.openshell;
      const file = lane.files.find(({ path }) =>
        path.endsWith("/namespace-driver-openshell-k3d-real.test.ts"),
      );
      const statePath = join(root, "state/namespace.json");
      const resultsPath = join(root, "results/namespace.json");
      await writeRunnerManifest(root, { lanes: { openshell: { ...lane, files: [file] } } });
      await writeFile(
        join(root, "scripts/ci/prepare.mjs"),
        `export { prepareFile } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/ci/prepare.mjs")).href)};`,
      );
      // Preserve real metadata and preparation. Only the unstarted model child is
      // inert; a regression still stops at the immutable-image gate before setup.
      await writeFile(join(root, file.path), 'throw new Error("unexpected-model-child");');
      const env = Object.fromEntries(
        [...lane.requiredEnv, ...file.requiredEnv].map((name) => [name, "synthetic-prerequisite"]),
      );
      const result = run(
        root,
        [
          ...laneArgs(root, "openshell", statePath, resultsPath),
          ...(focused ? ["--file", file.path] : []),
        ],
        {
          ...env,
          OPENAI_API_KEY: "synthetic-custom-provider-key",
          CODEX_ACCESS_TOKEN: "",
          OCC_TEST_OPENSHELL_MODEL_BASE_URL: selection.endpoint ?? "",
          OCC_TEST_OPENSHELL_HARNESS: selection.harness ?? "",
          OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: "",
          OCC_CI_SUITE_VIEW: "default",
        },
      );
      assert.equal(result.status, 1);
      const summary = JSON.parse(await readFile(resultsPath, "utf8"));
      assert.ok(summary.issues.some(({ code }) => code === "prepare-failed"));
      assert.equal(summary.files[0].nodeExitCode, null);
      assert.deepEqual(summary.files[0].tests, []);
      const diagnostics = await readFile(`${statePath}.diagnostics.json`, "utf8");
      assert.match(diagnostics, selection.error);
      assert.doesNotMatch(
        diagnostics + result.stdout + result.stderr,
        /unexpected-model-child|synthetic-custom-provider-key/u,
      );
      await assert.rejects(stat(statePath), { code: "ENOENT" });
    });
  }
}

test("custom native providers require a separate Codex credential before Local Setup", async (t) => {
  const root = await fixture(t);
  const file = join(repositoryRoot, "tests/integration/local-first-agent-openshell-real.test.mjs");
  for (const custom of [false, true]) {
    for (const pat of [false, true]) {
      for (const endpoint of [
        "",
        "https://custom-model.example.test/v1",
        "malformed-private-endpoint",
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            "--test",
            "--test-name-pattern=^a local Kubernetes installer can deploy and reuse an Agent",
            file,
          ],
          {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              OCC_TEST_LOCAL_FIRST_AGENT_REAL: "1",
              OPENAI_API_KEY: "synthetic-model-credential",
              OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
              ...(pat ? { CODEX_ACCESS_TOKEN: "synthetic-codex-credential" } : {}),
              ...(custom
                ? { OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: join(root, "provider.json") }
                : {}),
              // Stop after credential admission, before provisioning a stack.
              OCC_DEVELOPMENT_STATE_DIRECTORY: join(root, "absent-state"),
            },
          },
        );
        assert.equal(result.status, 1);
        let expected =
          /OCC_DEVELOPMENT_STATE_DIRECTORY must select valid Kubernetes Local Setup state/u;
        if (endpoint) {
          expected = /The first-Agent installer requires the public OpenAI endpoint/u;
        } else if (custom && !pat) {
          expected = /CODEX_ACCESS_TOKEN is required for the first invocation/u;
        }
        assert.match(result.stdout + result.stderr, expected);
        assert.doesNotMatch(result.stdout + result.stderr, /malformed-private-endpoint/u);
      }
    }
  }
});

test("the public browser installer rejects custom providers before setup", async (t) => {
  const root = await fixture(t);
  for (const [marker, value] of [
    ["OCC_TEST_OPENSHELL_MODEL_BASE_URL", "https://custom-model.example.test/v1"],
    ["OCC_TEST_OPENSHELL_MODEL_BASE_URL", "malformed-private-endpoint"],
    ["OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE", join(root, "provider.json")],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--test", join(repositoryRoot, "tests/integration/dev-up-openshell-k3d-real.test.mjs")],
      {
        encoding: "utf8",
        env: {
          // Even a regressed check cannot find container tools in this fixture.
          PATH: root,
          HOME: root,
          TMPDIR: root,
          OCC_TEST_DEV_UP_OPENSHELL_REAL: "1",
          OPENAI_API_KEY: "synthetic-custom-provider-key",
          [marker]: value,
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stdout + result.stderr,
      marker.endsWith("BASE_URL")
        ? /The browser Agent requires the public OpenAI endpoint/u
        : /The browser Agent does not accept native provider overrides/u,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /malformed-private-endpoint/u);
  }
});

for (const workflow of apiKeyWorkflows) {
  test(`the ${workflow} runner preserves the selected provider URL with its API key`, async (t) => {
    const root = await fixture(t);
    const suites = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
    const lane = suites.lanes.openshell;
    const file = lane.files.find(({ path }) =>
      path.endsWith(`/openshell-${workflow}-real.test.ts`),
    );
    const resultsPath = join(root, "results/provider.json");
    const endpoint = "https://model-provider.example.test/v1";
    // Keep canonical input metadata; only replace the model test body. The actual
    // runner must deliver the selected endpoint and key together to its child.
    await writeRunnerManifest(root, { lanes: { openshell: lane } });
    await writeFile(
      join(root, file.path),
      `import assert from "node:assert/strict"; import test from "node:test";
    test(${JSON.stringify(file.expectedTests[0])}, () => {
      assert.equal(process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL, ${JSON.stringify(endpoint)});
      assert.equal(process.env.OPENAI_API_KEY, "synthetic-provider-key");
    });`,
    );
    const env = Object.fromEntries(
      [...lane.requiredEnv, ...file.requiredEnv].map((name) => [name, "synthetic-prerequisite"]),
    );
    const result = run(
      root,
      [...laneArgs(root, "openshell", "state/provider.json", resultsPath), "--file", file.path],
      {
        ...env,
        OPENAI_API_KEY: "synthetic-provider-key",
        CODEX_ACCESS_TOKEN: "",
        OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
        OCC_CI_SUITE_VIEW: "default",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(await readFile(resultsPath, "utf8"));
    assert.equal(receipt.files[0].tests[0].status, "passed");
  });
}

for (const view of ["default", "full-integration"]) {
  for (const selection of ["compose prepared", "compose default", "kubernetes"]) {
    test(`the ${view} guided installer runner scopes prepared controller inputs (${selection})`, async (t) => {
      const root = await fixture(t);
      const suites = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"), view);
      const laneName = view === "default" ? "openshell" : "openshell-installers";
      const lane = suites.lanes[laneName];
      const path =
        selection === "kubernetes"
          ? "tests/integration/local-first-agent-openshell-k3d-real.test.mjs"
          : "tests/integration/local-first-agent-openshell-real.test.mjs";
      const file = lane.files.find((entry) => entry.path === path);
      const controller = "registry.example.test/controller@sha256:" + "1".repeat(64);
      const runtime = "registry.example.test/runtime@sha256:" + "2".repeat(64);
      const expectedController = selection === "compose prepared" ? controller : undefined;
      const resultsPath = join(root, "results/prepared-input.json");
      // Preserve canonical lane/file metadata and the real runner. The child
      // only observes its environment, so no image pull or installation occurs.
      await writeRunnerManifest(root, { lanes: { [laneName]: lane } });
      await writeFile(
        join(root, path),
        [
          'import assert from "node:assert/strict"; import test from "node:test";',
          ...file.expectedTests.map(
            (name) => `test(${JSON.stringify(name)}, () => {
          assert.equal(process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROLLER_IMAGE, ${JSON.stringify(expectedController)});
          assert.equal(process.env.OCC_KUBERNETES_RUNTIME_IMAGE, ${JSON.stringify(runtime)});
          assert.equal(process.env.OCC_TEST_UNLISTED_IMAGE, undefined);
        });`,
          ),
        ].join("\n"),
      );
      const env = Object.fromEntries(
        [...lane.requiredEnv, ...(file.requiredEnv ?? [])].map((name) => [
          name,
          "synthetic-prerequisite",
        ]),
      );
      const result = run(
        root,
        [...laneArgs(root, laneName, "state/prepared-input.json", resultsPath), "--file", path],
        {
          ...env,
          OCC_CI_SUITE_VIEW: "default",
          OCC_CI_IMAGE_CACHE: "",
          OCC_TEST_LOCAL_FIRST_AGENT_CONTROLLER_IMAGE:
            selection === "compose default" ? undefined : controller,
          OCC_KUBERNETES_RUNTIME_IMAGE: runtime,
          OCC_TEST_UNLISTED_IMAGE: "unlisted-image-selection",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(await readFile(resultsPath, "utf8"));
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.counts.passed, file.expectedTests.length);
      assert.equal(receipt.counts.failed, 0);
      assert.equal(receipt.counts.skipped, 0);
    });
  }
}

test("run fails missing expected tests, skipped expected tests, skips, todos, and missing required env", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/lane.json");

  await writeFile(
    join(root, "tests/integration/skips.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test, { describe } from "node:test";',
      'test("ordinary pass", () => assert.equal(1, 1));',
      'test("expected but skipped", { skip: "not allowed for expected" }, () => {});',
      'test("unexpected skipped case", { skip: "missing prerequisite" }, () => {});',
      'test("todo case", { todo: "missing prerequisite" }, () => {});',
      // A skipped suite reports no test event for the cases it never registered.
      'describe("skipped suite", { skip: "missing prerequisite" }, () => {',
      '  test("hidden case", () => assert.fail("must not run"));',
      "});",
      "",
    ].join("\n"),
  );
  const file = {
    path: "tests/integration/skips.test.mjs",
    expectedTests: ["ordinary pass", "expected but skipped", "missing named case"],
  };
  await writeRunnerManifest(root, {
    lanes: { lane: { files: [file], requiredEnv: ["CI_RUNNER_REQUIRED_INPUT"] } },
  });

  const args = laneArgs(root, "lane", "state/lane.jsonl", resultsPath);
  const missingEnv = run(root, args);
  assert.equal(missingEnv.status, 1);
  let summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.deepEqual(
    summary.issues.map((entry) => entry.code),
    ["missing-env"],
  );

  await writeRunnerManifest(root, {
    lanes: { lane: { files: [{ ...file, requiredEnv: ["CI_RUNNER_FILE_INPUT"] }] } },
  });
  const missingFileEnv = run(root, args);
  assert.equal(missingFileEnv.status, 1);
  summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.deepEqual(
    summary.issues.map((entry) => [entry.code, entry.env]),
    [["missing-env", "CI_RUNNER_FILE_INPUT"]],
  );
  await writeRunnerManifest(root, { lanes: { lane: { files: [file] } } });
  const selected = run(root, args);
  assert.equal(selected.status, 1);
  summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.deepEqual(summary.issues.map((entry) => entry.code).sort(), [
    "expected-test-not-passed",
    "missing-expected-test",
    "unexpected-skip",
    "unexpected-skip",
    "unexpected-skip",
    "unexpected-skip",
  ]);
  const suiteSkip = summary.issues.find((entry) => entry.name === "skipped suite");
  assert.equal(suiteSkip.file, "tests/integration/skips.test.mjs");
  assert.equal(suiteSkip.source.file, suiteSkip.file);
  assert.ok(Number.isSafeInteger(suiteSkip.source.line) && suiteSkip.source.line > 0);
  assert.ok(Number.isSafeInteger(suiteSkip.source.column) && suiteSkip.source.column > 0);
  assert.equal(suiteSkip.source.nesting, 0);
  // Every issue is named in the job log, which keeps every attempt.
  for (const line of [
    "run-tests: issue missing-expected-test tests/integration/skips.test.mjs: expected test did not run: missing named case",
    "run-tests: issue expected-test-not-passed tests/integration/skips.test.mjs: expected test did not pass: expected but skipped",
    "run-tests: issue unexpected-skip tests/integration/skips.test.mjs: selected test did not run to completion: todo case",
    "run-tests: issue unexpected-skip tests/integration/skips.test.mjs: selected suite did not run its tests: skipped suite",
  ]) {
    assert.ok(selected.stderr.split("\n").includes(line), line);
  }

  // Filesystem traversal follows the symlink before '..'; lexical normalization
  // instead points at the unrelated in-tree helper and must not supply a source.
  const external = await temporaryDirectory(t, "ci-runner-source-");
  await mkdir(join(external, "deep"));
  await symlink(join(external, "deep"), join(root, "link"), "dir");
  await writeFile(join(root, "helper.mjs"), "// Not the source of the skipped suite.\n");
  await writeFile(
    join(external, "helper.mjs"),
    'describe("external skipped suite", { skip: true }, () => {});\n',
  );
  for (const filename of [`${root}/link/../helper.mjs`, "link/../helper.mjs"]) {
    await writeFile(
      join(root, "tests/integration/skips.test.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        'import { describe } from "node:test";',
        'import { runInNewContext } from "node:vm";',
        `const filename = ${JSON.stringify(filename)};`,
        'runInNewContext(readFileSync(filename, "utf8"), { describe }, { filename });',
      ].join("\n"),
    );
    const escaped = run(root, args);
    const escapedSummary = JSON.parse(await readFile(resultsPath, "utf8"));
    const escapedSkip = escapedSummary.issues.find(
      (entry) => entry.name === "external skipped suite",
    );
    assert.equal(escaped.status, 1);
    assert.equal(escapedSkip.code, "unexpected-skip");
    assert.equal(escapedSkip.source, undefined, filename);
  }
});

test("run records failed, skipped, todo, and passed dispositions separately", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/dispositions.json");

  await writeFile(
    join(root, "tests/integration/dispositions.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("passes", () => assert.equal(1, 1));',
      'test("fails", () => assert.equal(1, 2));',
      'test("skips", { skip: "expected" }, () => {});',
      'test("todo case", { todo: "expected" }, () => {});',
      "",
    ].join("\n"),
  );
  await writeSingleLaneManifest(
    root,
    "dispositions",
    [
      {
        path: "tests/integration/dispositions.test.mjs",
      },
    ],
    {
      ci: ["dispositions"],
    },
  );

  const result = run(root, laneArgs(root, "dispositions", "state/dispositions.jsonl", resultsPath));

  assert.notEqual(result.status, 0);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.counts, { passed: 1, failed: 1, skipped: 1, todo: 1, total: 4 });
  assert.deepEqual(
    summary.files[0].tests.map((entry) => [entry.name, entry.status]),
    [
      ["passes", "passed"],
      ["fails", "failed"],
      ["skips", "skipped"],
      ["todo case", "todo"],
    ],
  );
});

test("run clears inherited selectors and keep flags while preserving explicit lane and file inputs", async (t) => {
  const root = await fixture(t);

  await writeFile(
    join(root, "tests/integration/env-isolation.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("child env contains only explicit CI selectors", () => {',
      '  assert.equal(process.env.OCC_TEST_REQUIRED_SELECTOR, "required");',
      '  assert.equal(process.env.OCC_TEST_LANE_SELECTOR, "lane");',
      '  assert.equal(process.env.OCC_TEST_OPTIONAL_SELECTOR, "selected");',
      '  assert.equal(process.env.OCC_TEST_OPTIONAL_EMPTY, "");',
      '  assert.equal(process.env.OCC_TEST_FILE_SELECTOR, "file");',
      "  assert.equal(process.env.OCC_TEST_FILE_ABSENT, undefined);",
      "  assert.equal(process.env.OCC_TEST_OPTIONAL_ABSENT, undefined);",
      "  assert.equal(process.env.OCC_TEST_SLACK_LIVE, undefined);",
      "  assert.equal(process.env.OCC_TEST_LEAKED_SELECTOR, undefined);",
      '  assert.equal(process.env.OCC_PROBE_REQUIRED_SELECTOR, "required");',
      "  assert.equal(process.env.OCC_PROBE_LEAKED_SELECTOR, undefined);",
      "  assert.equal(process.env.KEEP, undefined);",
      "  assert.equal(process.env.OCC_RUNTIME_KEEP, undefined);",
      "});",
      "",
    ].join("\n"),
  );
  await writeRunnerManifest(root, {
    lanes: {
      isolated: {
        env: {
          OCC_TEST_LANE_SELECTOR: "lane",
        },
        requiredEnv: ["OCC_TEST_REQUIRED_SELECTOR", "OCC_PROBE_REQUIRED_SELECTOR"],
        optionalEnv: [
          "OCC_TEST_OPTIONAL_SELECTOR",
          "OCC_TEST_OPTIONAL_EMPTY",
          "OCC_TEST_OPTIONAL_ABSENT",
          "OCC_TEST_LANE_SELECTOR",
        ],
        files: [
          {
            path: "tests/integration/env-isolation.test.mjs",
            optionalEnv: ["OCC_TEST_FILE_SELECTOR", "OCC_TEST_FILE_ABSENT"],
          },
          { path: "tests/integration/env-sibling.test.mjs" },
        ],
      },
    },
  });

  await writeFile(
    join(root, "tests/integration/env-sibling.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("file selectors do not leak into siblings", () => {',
      "  assert.equal(process.env.OCC_TEST_FILE_SELECTOR, undefined);",
      '  assert.equal(process.env.OCC_TEST_OPTIONAL_SELECTOR, "selected");',
      "});",
      "",
    ].join("\n"),
  );

  const result = run(
    root,
    laneArgs(root, "isolated", "state/isolated.jsonl", "results/isolated.json"),
    {
      KEEP: "1",
      OCC_RUNTIME_KEEP: "1",
      OCC_TEST_SLACK_LIVE: "1",
      OCC_TEST_LEAKED_SELECTOR: "1",
      OCC_TEST_REQUIRED_SELECTOR: "required",
      OCC_TEST_OPTIONAL_SELECTOR: "selected",
      OCC_TEST_FILE_SELECTOR: "file",
      OCC_TEST_OPTIONAL_EMPTY: "",
      OCC_TEST_LANE_SELECTOR: "inherited",
      OCC_PROBE_LEAKED_SELECTOR: "1",
      OCC_PROBE_REQUIRED_SELECTOR: "required",
    },
  );

  assert.equal(result.status, 0, result.stderr);
});

test("OpenShell browser runner retains the destination for refusal before Local Setup", async (t) => {
  const lane = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/openshell.json"), "utf8"),
  );
  const file = lane.files.find(
    ({ path }) => path === "tests/integration/dev-up-openshell-k3d-real.test.mjs",
  );
  for (const [name, endpoint] of [
    ["custom", "https://provider.example.invalid/v1"],
    ["public", "https://api.openai.com/v1"],
    ["unset", undefined],
  ]) {
    await t.test(name, async (t) => {
      const root = await fixture(t);
      // Use the real test and its imports. An absent CLI stops accepted selections
      // before setup; no fixture replaces the destination guard or runner filtering.
      await writeFile(join(root, file.path), await readFile(join(repositoryRoot, file.path)));
      for (const path of ["scripts/ci/failure-redaction.mjs", "scripts/ci/agent-sandbox.ts"]) {
        await symlink(join(repositoryRoot, path), join(root, path));
      }
      for (const path of ["apps", "node_modules", "tests/helpers"]) {
        await symlink(join(repositoryRoot, path), join(root, path), "dir");
      }
      await symlink(join(repositoryRoot, "package.json"), join(root, "package.json"));
      await writeRunnerManifest(root, {
        lanes: {
          browser: {
            env: lane.env,
            requiredEnv: lane.requiredEnv,
            optionalEnv: lane.optionalEnv,
            files: [file],
          },
        },
      });
      const result = run(
        root,
        [
          ...laneArgs(root, "browser", "state/browser.jsonl", "results/browser.json"),
          "--file",
          file.path,
          "--test-name",
          file.expectedTests[0],
        ],
        {
          CODEX_ACCESS_TOKEN: "synthetic-browser-pat",
          OPENAI_API_KEY: "synthetic-browser-api-key",
          OCC_TEST_OPENAI_MODEL: "synthetic-browser-model",
          OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
          OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: "",
        },
      );
      assert.notEqual(result.status, 0, "The fixture must stop before cluster setup");
      const summary = JSON.parse(await readFile(join(root, "results/browser.json"), "utf8"));
      const failure = summary.files[0].tests.find(({ status }) => status === "failed");
      assert.ok(failure, JSON.stringify(summary));
      assert.equal(failure.name, file.expectedTests[0]);
      if (name === "custom") {
        assert.match(
          failure.error.message,
          /The browser Agent requires the public OpenAI endpoint/,
        );
        assert.doesNotMatch(failure.error.message, /ENOENT/);
      } else {
        assert.match(failure.error.message, /ENOENT.*bin\/occ/);
        assert.doesNotMatch(failure.error.message, /requires the public OpenAI endpoint/);
      }
    });
  }
});

test("OpenShell Compose rejects an empty prepared selector before Local Setup", async (t) => {
  for (const selected of [true, false]) {
    await t.test(
      selected ? "empty selector" : "absent selector with prepared runtime",
      async (t) => {
        const root = await fixture(t);
        const file = "tests/integration/dev-up-openshell-k3d-real.test.mjs";
        await writeFile(join(root, file), await readFile(join(repositoryRoot, file)));
        await symlink(
          join(repositoryRoot, "scripts/ci/failure-redaction.mjs"),
          join(root, "scripts/ci/failure-redaction.mjs"),
        );
        await symlink(
          join(repositoryRoot, "scripts/ci/agent-sandbox.ts"),
          join(root, "scripts/ci/agent-sandbox.ts"),
        );
        for (const path of ["apps", "node_modules", "tests/helpers"]) {
          await symlink(join(repositoryRoot, path), join(root, path), "dir");
        }
        await symlink(join(repositoryRoot, "package.json"), join(root, "package.json"));
        // Satisfy the test's CLI presence check, but leave the launcher absent.
        // The real input guard must run before startup, without creating a cluster.
        await mkdir(join(root, "bin"));
        await writeFile(join(root, "bin/occ"), "");
        const env = {
          ...process.env,
          OCC_TEST_DEV_UP_OPENSHELL_REAL: "",
          OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL: "1",
          OCC_TEST_DEV_UP_CONTAINER_ENGINE: "docker",
          OCC_KUBERNETES_RUNTIME_IMAGE: `runtime.example.test/image@sha256:${"a".repeat(64)}`,
        };
        delete env.NODE_TEST_CONTEXT;
        delete env.OCC_TEST_DEV_UP_COMPOSE_CONTROLLER_IMAGE;
        if (selected) {
          env.OCC_TEST_DEV_UP_COMPOSE_CONTROLLER_IMAGE = "";
        }
        const result = spawnSync(process.execPath, ["--test", join(root, file)], {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        const output = result.stdout + result.stderr;
        if (selected) {
          assert.match(output, /Prepared Compose controller requires an owned immutable image/);
          assert.doesNotMatch(output, /OpenShell development startup failed/);
        } else {
          assert.match(output, /OpenShell development startup failed/);
          assert.doesNotMatch(output, /requires an owned immutable image/);
        }
      },
    );
  }
});

test("OpenShell selected files retain API-key selection and require the selected credential", async (t) => {
  const root = await fixture(t);
  const lane = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/openshell.json"), "utf8"),
  );
  const scratch = "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts";
  const gatewayPolicy = "tests/integration/openshell-gateway-tool-policy-real.test.ts";
  const sibling = "tests/integration/local-first-agent-openshell-real.test.mjs";
  const inputs = {
    ...Object.fromEntries(
      lane.files
        .find(({ path }) => path === scratch)
        .requiredEnv.map((name) => [name, "fixture-input"]),
    ),
    OPENAI_API_KEY: "synthetic-model-key",
    CODEX_ACCESS_TOKEN: "",
    OCC_TEST_OPENAI_MODEL: "fixture-model",
    OCC_TEST_OPENSHELL_HARNESS: "codex",
    OCC_TEST_OPENSHELL_MODEL_BASE_URL: "https://api.openai.com/v1",
  };
  // Use the shipped manifest and real runner, replacing only the expensive model/cluster
  // test body with an input consumer. This proves transport and admission, not inference.
  await writeFile(
    join(root, scratch),
    `import assert from "node:assert/strict";
import test from "node:test";
test("receives selected model inputs", () => {
  assert.equal(process.env.OCC_TEST_OPENAI_MODEL, "fixture-model");
  assert.equal(process.env.OCC_TEST_OPENSHELL_HARNESS, "codex");
  if (process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL) {
    assert.equal(process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL, "https://api.openai.com/v1");
    assert.equal(process.env.OPENAI_API_KEY, "synthetic-model-key");
  } else {
    assert.equal(process.env.CODEX_ACCESS_TOKEN, "synthetic-model-token");
  }
});
`,
  );
  await writeFile(
    join(root, gatewayPolicy),
    `import assert from "node:assert/strict";
import test from "node:test";
test("receives selected model inputs", () => {
  assert.equal(process.env.OCC_TEST_OPENSHELL_HARNESS, "openclaw");
  assert.equal(process.env.OPENAI_API_KEY, "synthetic-model-key");
});
`,
  );
  await writeFile(join(root, sibling), 'throw new Error("unselected sibling ran");\n');
  for (const [index, value] of [
    { lane: "openshell" },
    { lane: "openshell-policy" },
    {
      file: gatewayPolicy,
      env: { OCC_TEST_OPENSHELL_HARNESS: "openclaw", OCC_TEST_OPENSHELL_MODEL_BASE_URL: "" },
    },
    { env: { OCC_TEST_OPENSHELL_HARNESS: "openclaw" }, unsupportedHarness: true },
    { env: { OCC_TEST_OPENSHELL_MODEL_BASE_URL: "", CODEX_ACCESS_TOKEN: "synthetic-model-token" } },
    { env: { OPENAI_API_KEY: "" }, missing: "OPENAI_API_KEY" },
    { env: { OCC_TEST_OPENSHELL_MODEL_BASE_URL: "" }, missing: "CODEX_ACCESS_TOKEN" },
    { env: { OCC_TEST_OPENAI_MODEL: "" }, missing: "OCC_TEST_OPENAI_MODEL" },
    { env: { OCC_TEST_KUBERNETES_CONTEXT: "" }, missing: "OCC_TEST_KUBERNETES_CONTEXT" },
    { file: sibling, env: { OPENAI_API_KEY: "" }, missing: "OPENAI_API_KEY" },
    { lane: "other", missing: "CODEX_ACCESS_TOKEN" },
  ].entries()) {
    const name = value.lane ?? "openshell";
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: {
        [name]: {
          ...lane,
          files: lane.files
            .filter(({ path }) => [scratch, sibling, gatewayPolicy].includes(path))
            .map((file) => ({
              ...file,
              expectedTests: ["receives selected model inputs"],
            })),
        },
      },
      groups: { ci: [name] },
    });
    const resultsPath = join(root, `results/selection-${index}.json`);
    const result = run(
      root,
      [
        ...laneArgs(root, name, `state/selection-${index}.json`, resultsPath),
        "--file",
        value.file ?? scratch,
      ],
      { ...inputs, ...value.env },
    );
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    if (value.unsupportedHarness) {
      assert.equal(result.status, 1);
      assert.match(summary.issues[0]?.message ?? "", /requires OCC_TEST_OPENSHELL_HARNESS=codex/);
      assert.deepEqual(summary.files, []);
      continue;
    }
    assert.equal(result.status, value.missing ? 1 : 0, result.stderr);
    assert.deepEqual(
      summary.issues.map(({ code, env }) => ({ code, env })),
      value.missing ? [{ code: "missing-env", env: value.missing }] : [],
    );
    assert.equal(summary.counts.passed, value.missing ? 0 : 1);
  }
});

test("full OpenShell lanes ignore inherited focused model selectors and retain explicit harness settings", async (t) => {
  const root = await fixture(t);
  const lane = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/openshell.json"), "utf8"),
  );
  const path = "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs";
  const file = lane.files.find((entry) => entry.path === path);
  const resultsPath = join(root, "results/full.json");
  // These are the same exports left by a focused API-key run. A later full run
  // must retain its PAT policy coverage, even if the manifest contains one file.
  const env = {
    ...Object.fromEntries(
      [...lane.requiredEnv, ...file.requiredEnv].map((name) => [name, "fixture-input"]),
    ),
    OCC_TEST_OPENSHELL_HARNESS: "openclaw",
    OCC_TEST_OPENSHELL_MODEL_BASE_URL: "https://api.openai.com/v1",
  };
  for (const explicit of [false, true]) {
    await writeFile(
      join(root, path),
      `import assert from "node:assert/strict";
import test from "node:test";
test("full lane model inputs", () => {
  assert.equal(process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL, undefined);
  assert.equal(process.env.OCC_TEST_OPENSHELL_HARNESS, ${explicit ? '"codex"' : "undefined"});
  assert.equal(process.env.CODEX_ACCESS_TOKEN, "fixture-input");
});
`,
    );
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: {
        openshell: {
          ...lane,
          env: { ...lane.env, ...(explicit ? { OCC_TEST_OPENSHELL_HARNESS: "codex" } : {}) },
          files: [{ ...file, expectedTests: ["full lane model inputs"] }],
        },
      },
      groups: { ci: ["openshell"] },
    });
    const result = run(root, laneArgs(root, "openshell", "state/full.json", resultsPath), env);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    assert.equal(summary.scope, "full");
    assert.equal(summary.counts.passed, 1);
    assert.deepEqual(summary.issues, []);
  }
});

test("QA lane forwards selected models and observer input and retains outcomes at the requested path", async (t) => {
  const root = await fixture(t);
  const lane = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/qa-matrix.json"), "utf8"),
  );
  const artifacts = join(root, "evidence");
  await mkdir(artifacts);
  const file = "tests/integration/qa-inputs.test.mjs";
  const qaSelectionHelper = pathToFileURL(
    join(repositoryRoot, "tests/helpers/qa-selection.mjs"),
  ).href;
  // Exercise the shipped lane definition with a small child that consumes its
  // inputs. This proves transport and artifact placement, not a live model turn.
  await writeFile(
    join(root, file),
    `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { selectQaMatrix } from ${JSON.stringify(qaSelectionHelper)};
test("QA inputs", async () => {
  assert.equal(process.env.OCC_TEST_QA_OPENAI_MODEL, "selected-openai-model");
  assert.equal(process.env.OCC_TEST_QA_CODEX_MODEL, "selected-codex-model");
  assert.equal(process.env.OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE, undefined);
  assert.equal(process.env.QA_REPOSITORY_FIXTURE, "isolated");
  assert.equal(process.env.OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY, "selected-app-input");
  const selection = selectQaMatrix(process.env);
  assert.ok(selection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY"));
  assert.ok(!selection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE"));
  assert.equal(process.env.OCC_TEST_QA_INSTALLATION, "compose");
  assert.equal(process.env.OCC_TEST_QA_PRESET, "Codex");
  assert.equal(process.env.OCC_TEST_QA_SCENARIOS, "console-secrets,git-write");
  await writeFile(join(process.env.OCC_TEST_QA_ARTIFACTS, "matrix.json"), JSON.stringify({ outcome: "inputs received" }));
});
`,
  );
  await writeRunnerManifest(root, {
    lanes: { "qa-matrix": { ...lane, files: [{ path: file }] } },
    groups: { qa: ["qa-matrix"] },
  });
  const result = run(root, laneArgs(root, "qa-matrix", "state/qa.json", "results/qa.json"), {
    ...Object.fromEntries(lane.requiredEnv.map((name) => [name, "fixture-input"])),
    OCC_TEST_QA_OPENAI_MODEL: "selected-openai-model",
    OCC_TEST_QA_CODEX_MODEL: "selected-codex-model",
    OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY: "selected-app-input",
    QA_REPOSITORY_FIXTURE: "isolated",
    OCC_TEST_QA_ARTIFACTS: artifacts,
    OCC_TEST_QA_INSTALLATION: "compose",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_SCENARIOS: "console-secrets,git-write",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(artifacts, "matrix.json"), "utf8")), {
    outcome: "inputs received",
  });
});

test("run records timeout cancellation without leaking child output", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/timeout.json");

  await writeFile(
    join(root, "tests/integration/timeout.test.mjs"),
    [
      'import test from "node:test";',
      'test("hangs past the lane timeout", async () => {',
      '  console.error("secretauthvalue-timeout");',
      "  await new Promise((resolve) => setTimeout(resolve, 10_000));",
      "});",
      "",
    ].join("\n"),
  );
  await writeSingleLaneManifest(root, "timeout", [{ path: "tests/integration/timeout.test.mjs" }], {
    ci: ["timeout"],
  });

  const result = run(root, laneArgs(root, "timeout", "state/timeout.jsonl", resultsPath), {
    CI_RUNNER_TEST_TIMEOUT_MS: "100",
  });

  assert.equal(result.status, 1);
  const text = await readFile(resultsPath, "utf8");
  assert.doesNotMatch(text, /secretauthvalue/);
  const summary = JSON.parse(text);
  assert.equal(summary.files[0].nodeExitCode, 1);
  assert(summary.issues.some((entry) => entry.code === "test-timeout"));
  // A timeout always leaves a record, even before the test printed anything.
  const report = await readFile(join(root, "state/timeout.jsonl.diagnostics.json"), "utf8");
  assert.doesNotMatch(report, /secretauthvalue/);
  const [record] = JSON.parse(report).failures;
  assert.equal(record.reason, "timeout");
  assert.equal(record.timeoutMs, 100);
});

// The recorded fixture processes still in group `pgid` that nothing has killed. A process
// counts as killed once it is gone, a zombie (Z) or dead and being reaped (X), or SIGKILL
// is pending for its whole thread group. kill(-pgid, "SIGKILL") queues that shared signal
// before it returns and the kernel clears it only when it releases the process, so this
// needs no deadline. Waiting for the processes to disappear did: on a busy host a killed
// multithreaded Node process can take seconds to finish exiting (a zombie leader with
// another thread still running its exit, or a process still being reaped).
function unkilled(pids, pgid) {
  return pids.filter((pid) => {
    const stat = procStat(pid);
    if (stat === undefined || stat.pgid !== pgid || stat.state === "Z" || stat.state === "X") {
      return false;
    }
    let status;
    try {
      status = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      return false;
    }
    // Signal masks are hexadecimal with bit (signal number - 1) set; SIGKILL is 9.
    const sharedPending = /^ShdPnd:\s*([0-9a-f]+)$/mu.exec(status);
    return sharedPending === null || (BigInt(`0x${sharedPending[1]}`) & (1n << 8n)) === 0n;
  });
}

waitingTest(
  "run kills a timed-out file's whole process group after the timeout record",
  { skip: process.platform !== "linux" && "reads /proc" },
  async (t) => {
    const root = await fixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "orphan");
    const recordPath = join(root, "state/orphan-pids.json");
    const waiting = join(root, "state/orphan-waiting");
    // The isolated test-file child ignores SIGTERM and has a child of its own, so the
    // Node test runner's own SIGTERM handling cannot end either of them.
    await writeFile(
      join(root, "tests/integration/orphan.test.mjs"),
      [
        'import { spawn } from "node:child_process";',
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("outlives its runner", async () => {',
        '  process.on("SIGTERM", () => {});',
        '  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });',
        '  const pgid = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
        "  writeFileSync(process.env.CI_RUNNER_ORPHAN_RECORD, JSON.stringify({",
        "    runner: process.ppid, file: process.pid, grandchild: grandchild.pid,",
        "    pgid: pgid(process.pid), grandchildPgid: pgid(grandchild.pid),",
        "  }));",
        '  console.log("waiting with SIGTERM ignored");',
        `  writeFileSync(${JSON.stringify(waiting)}, "");`,
        "  await new Promise((resolve) => setTimeout(resolve, 60_000));",
        "});",
        "",
      ].join("\n"),
    );
    await writeSingleLaneManifest(root, "orphan", [{ path: "tests/integration/orphan.test.mjs" }], {
      ci: ["orphan"],
    });
    let pids;
    // Never leave the fixture's processes behind, whatever the outcome: only the exact
    // pids the fixture recorded, still in the fixture's group, never a group.
    t.after(() => {
      killRecordedProcessGroupMembers(pids?.pgid, [pids?.runner, pids?.file, pids?.grandchild]);
    });

    // The runner's clock stands still from the start until the file has recorded its pids and
    // printed its line, so its timeout comes five seconds after that however long the host takes
    // to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      laneArgs(root, "orphan", statePath, resultsPath),
      { CI_RUNNER_TEST_TIMEOUT_MS: "5000", CI_RUNNER_ORPHAN_RECORD: recordPath },
      { timeout: 60_000, execArgv: heldClock(started, [waiting]) },
    );

    assert.equal(result.error, undefined, `the runner timed the file out: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    pids = JSON.parse(await readFile(recordPath, "utf8"));
    // The timeout record still comes from the runner's reporter before the group dies.
    const [record] = JSON.parse(await readFile(`${statePath}.diagnostics.json`, "utf8")).failures;
    assert.equal(record.reason, "timeout");
    assert.equal(record.timeoutMs, 5000);
    assert.deepEqual(record.interruptedTests, [{ name: "outlives its runner", line: 4 }]);
    assert.deepEqual(record.output.lines, ["stdout: waiting with SIGTERM ignored"]);
    // The runner sent the group SIGKILL before it exited; finishing the exit is the kernel's.
    assert.deepEqual(unkilled([pids.file, pids.grandchild], pids.pgid), []);
    // The Node test runner leads its own process group, apart from this test's.
    assert(Number.isSafeInteger(pids.runner) && pids.runner > 1, String(pids.runner));
    assert.equal(pids.pgid, pids.runner);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    assert.equal(summary.files[0].processGroupId, pids.pgid);
    assert.equal(pids.grandchildPgid, pids.runner);
    assert.notEqual(pids.pgid, procStat(process.pid).pgid);
  },
);

test(
  "run kills what a passing file left in its process group",
  { skip: process.platform !== "linux" && "reads /proc" },
  async (t) => {
    const root = await fixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "leftover");
    const recordPath = join(root, "state/leftover-pids.json");
    // The file passes and exits; its grandchild, unref'd, would run on for a minute.
    await writeFile(
      join(root, "tests/integration/leftover.test.mjs"),
      [
        'import { spawn } from "node:child_process";',
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("passes and leaves a process behind", () => {',
        '  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });',
        "  grandchild.unref();",
        '  const pgid = Number(readFileSync(`/proc/${grandchild.pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
        "  writeFileSync(process.env.CI_RUNNER_ORPHAN_RECORD, JSON.stringify({ runner: process.ppid, grandchild: grandchild.pid, pgid }));",
        "});",
        "",
      ].join("\n"),
    );
    await writeSingleLaneManifest(
      root,
      "leftover",
      [{ path: "tests/integration/leftover.test.mjs" }],
      { ci: ["leftover"] },
    );
    let pids;
    t.after(() => {
      killRecordedProcessGroupMembers(pids?.pgid, [pids?.grandchild]);
    });

    const result = run(root, laneArgs(root, "leftover", statePath, resultsPath), {
      CI_RUNNER_ORPHAN_RECORD: recordPath,
    });

    assert.equal(result.status, 0, result.stderr);
    pids = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(pids.pgid, pids.runner);
    assert.deepEqual(unkilled([pids.grandchild], pids.pgid), []);
  },
);

// Polls until check() is truthy or the deadline passes; returns check()'s last value.
async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = check();
  while (!value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = check();
  }
  return value;
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(
    `run kills every live test group on ${signal} and exits by that signal`,
    { skip: process.platform !== "linux" && "reads /proc" },
    async (t) => {
      const root = await fixture(t);
      const { statePath, resultsPath } = runnerArtifactPaths(root, "hang");
      const recordPath = join(root, "state/hang-pids.json");
      // The isolated test-file child ignores the signal and has a child of its own, so
      // only the forwarded SIGKILL to the Node test runner's group can end them.
      await writeFile(
        join(root, "tests/integration/hang.test.mjs"),
        [
          'import { spawn } from "node:child_process";',
          'import { readFileSync, renameSync, writeFileSync } from "node:fs";',
          'import test from "node:test";',
          'test("hangs with the signal ignored", async () => {',
          `  process.on(${JSON.stringify(signal)}, () => {});`,
          '  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });',
          '  const pgid = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\\) /su, "").split(" ")[2]);',
          "  const record = process.env.CI_RUNNER_ORPHAN_RECORD;",
          "  writeFileSync(`${record}.partial`, JSON.stringify({",
          "    runner: process.ppid, file: process.pid, grandchild: grandchild.pid,",
          "    pgid: pgid(process.pid), grandchildPgid: pgid(grandchild.pid),",
          "  }));",
          "  renameSync(`${record}.partial`, record);",
          "  await new Promise((resolve) => setTimeout(resolve, 30_000));",
          "});",
          "",
        ].join("\n"),
      );
      await writeSingleLaneManifest(root, "hang", [{ path: "tests/integration/hang.test.mjs" }], {
        ci: ["hang"],
      });

      // Detached, so the signal reaches only run-tests.mjs, never this test's group.
      const ciRunner = spawn(
        process.execPath,
        [runnerPath, ...laneArgs(root, "hang", statePath, resultsPath)],
        {
          cwd: repositoryRoot,
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: runnerEnv({
            CI_RUNNER_TEST_TIMEOUT_MS: "30000",
            CI_RUNNER_ORPHAN_RECORD: recordPath,
          }),
        },
      );
      let stderr = "";
      ciRunner.stderr.setEncoding("utf8");
      ciRunner.stderr.on("data", (chunk) => (stderr += chunk));
      let exit;
      const exited = new Promise((resolve) =>
        ciRunner.on("exit", (code, exitSignal) => {
          exit = { code, signal: exitSignal };
          resolve(exit);
        }),
      );
      let pids;
      // Never leave processes behind, whatever the outcome: only the pid this test
      // spawned, and the exact pids the fixture recorded while still in its group.
      t.after(async () => {
        if (exit === undefined) {
          // Let run-tests.mjs end its test groups first: they may not have recorded pids.
          for (const lastResort of ["SIGTERM", "SIGKILL"]) {
            try {
              process.kill(ciRunner.pid, lastResort);
            } catch {
              // Already gone.
            }
            if (await waitFor(() => exit !== undefined, 2_000)) {
              break;
            }
          }
        }
        killRecordedProcessGroupMembers(pids?.pgid, [pids?.runner, pids?.file, pids?.grandchild]);
      });

      const recorded = await waitFor(() => {
        try {
          return JSON.parse(readFileSync(recordPath, "utf8"));
        } catch {
          return exit !== undefined ? "exited" : undefined;
        }
      }, 30_000);
      assert.equal(typeof recorded, "object", `no test file started (${recorded}): ${stderr}`);
      pids = recorded;
      // The Node test runner leads its own group, apart from run-tests.mjs and this test.
      assert(Number.isSafeInteger(pids.runner) && pids.runner > 1, String(pids.runner));
      assert.equal(pids.pgid, pids.runner);
      assert.equal(pids.grandchildPgid, pids.runner);
      assert.notEqual(pids.pgid, ciRunner.pid);
      assert.notEqual(pids.pgid, procStat(process.pid).pgid);

      process.kill(ciRunner.pid, signal);
      let timer;
      const outcome = await Promise.race([
        exited,
        new Promise((resolve) => (timer = setTimeout(resolve, 10_000, "still running"))),
      ]);
      clearTimeout(timer);
      assert.deepEqual(outcome, { code: null, signal }, stderr);
      // The runner sent the group SIGKILL before it exited; finishing the exit is the kernel's.
      assert.deepEqual(unkilled([pids.runner, pids.file, pids.grandchild], pids.pgid), []);
    },
  );
}

test("run redacts arbitrary stdout, stderr, assertion payloads, and stacks from artifacts", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/redacted.json");
  const secret = "secretauthvalue";
  // This marker is deliberately absent from the redactor's environment secrets.
  // The native projector and reporter must remove it themselves.
  const nativePrivate = "private-native-observation-marker";
  const failedProgram = spawnSync(
    process.execPath,
    [
      "-e",
      nativeWorkerProofProgram({
        sessionFile: { path: join(root, nativePrivate) },
        createSessionFile: false,
        toolPrefix: "proof ",
      }),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(failedProgram.status, 1);
  const inconsistentNativeFailures = [
    [0, "read-session-file", "ENOENT"],
    [undefined, "read-session-file", "ENOENT"],
    [1, undefined, "ENOENT"],
    [1, "read-session-file", undefined],
    [1, nativePrivate, "ENOENT"],
    [1, "read-session-file", nativePrivate],
  ];
  const nativeHistory = nativeWorkerHistoryEvidence({
    runId: "selected",
    toolPrefix: "proof ",
    marker: nativePrivate,
    command: nativePrivate,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "exec", arguments: { code: nativePrivate } }],
        __openclaw: { runId: "selected" },
      },
      {
        role: "toolResult",
        toolName: "exec",
        isError: false,
        content: JSON.stringify({
          value: { aggregated: failedProgram.stderr, exitCode: failedProgram.status },
        }),
        __openclaw: { runId: "selected" },
      },
    ],
  }).observation;
  assert.equal(nativeHistory.historyExecCodeStringCount, 1);
  assert.equal(nativeHistory.historyExecCommandStringCount, 0);
  assert.equal(nativeHistory.historyExecNestedExitNonzeroCount, 1);
  assert.equal(nativeHistory.historyExecNestedExitCode, 1);
  assert.equal(nativeHistory.historyExecFailureOperation, "read-session-file");
  assert.equal(nativeHistory.historyExecFailureCode, "ENOENT");
  assert.equal(nativeHistory.historyToolProofPresent, false);
  assert.equal(nativeHistory.historyFinalProofPresent, false);
  const nativeWorker = nativeWorkerPlacementObservation({
    placement: {
      state: "failed",
      recoveryError: `Worker tunnel did not connect within 3 minutes; ${nativePrivate}`,
      terminalReason: { message: nativePrivate },
      remoteWorkspaceDir: nativePrivate,
      session: nativePrivate,
    },
    environment: {
      id: nativePrivate,
      worker: {
        state: "failed",
        tunnelStatus: "stopped",
        error: nativePrivate,
        attachedSessionIds: [nativePrivate],
      },
    },
    nodes: [
      { nodeId: "unrelated-node", connected: true, caps: [nativePrivate] },
      {
        nodeId: nativePrivate,
        connected: false,
        paired: true,
        sessionHost: true,
        caps: ["system", nativePrivate],
        commands: [nativePrivate],
        workerBundle: { status: "installed", version: nativePrivate },
      },
    ],
    expectedNodeId: nativePrivate,
    sessionId: nativePrivate,
    environmentLookup: "found",
    nodeLookup: "found",
    elapsedMs: 180488,
  });
  const wrappedNativeWorker = nativeWorkerPlacementObservation({
    placement: {
      state: "failed",
      recoveryError: `Worker node bootstrap failed: OpenClaw worker deploy artifact is missing; build the running package at ${nativePrivate}`,
      terminalReason: `Worker node bootstrap failed: Device worker bundle installation failed: ${nativePrivate}`,
    },
    environment: {
      worker: {
        error:
          "Worker provider preparation failed: Device worker node is not connected with the installer dialect",
      },
    },
  });
  // A retained session can acquire a new owner during send. Exercise the real
  // collector with public RPC-shaped observations, then retain its result through CI.
  const nativeSession = { key: "agent:main:retained-proof", sessionId: "retained-proof" };
  const lastPlacement = { state: "active", environmentId: "previous-owner" };
  const collectRetained = (refresh) =>
    collectNativeWorkerFailure({
      session: nativeSession,
      lastPlacement,
      elapsedMs: 3000,
      request: async (method, params) => {
        if (method === "node.list") {
          return { nodes: [] };
        }
        if (method === "sessions.describe") {
          if (refresh === "rejected") {
            throw new Error(nativePrivate);
          }
          return {
            session: {
              sessionId: refresh === "mismatched" ? "different-session" : nativeSession.sessionId,
              placement: { state: "failed", environmentId: "replacement-owner" },
            },
          };
        }
        if (method === "environments.status") {
          return params.environmentId === "replacement-owner"
            ? { id: "replacement-owner", worker: { state: "failed", tunnelStatus: "stopped" } }
            : { id: "previous-owner", worker: { state: "attached", tunnelStatus: "connected" } };
        }
        throw new Error("Unexpected diagnostic RPC");
      },
    });
  const freshNativeWorker = await collectRetained("fresh");
  const fallbackNativeWorker = await collectRetained("rejected");
  const mismatchedNativeWorker = await collectRetained("mismatched");
  const diagnosticSignals = new Set();
  const collectedTurn = await collectNativeWorkerFailure({
    session: nativeSession,
    runId: "selected-run",
    outcome: { status: "error", error: `fetch failed: ${nativePrivate}` },
    request: async (method, params, options) => {
      diagnosticSignals.add(options.signal);
      assert.equal(options.timeoutMs, 5000);
      if (method === "node.list") {
        return { nodes: [] };
      }
      if (method === "sessions.describe") {
        return { session: { sessionId: nativeSession.sessionId } };
      }
      assert.equal(method, "chat.history");
      assert.deepEqual(params, { sessionKey: nativeSession.key, limit: 30 });
      return { messages: [] };
    },
  });
  assert.equal(diagnosticSignals.size, 1, "Failure reads must share one deadline");
  // Keep foreign turns and private error suffixes out of the real reporter artifact.
  const turnCases = [
    ["Incorrect API key provided", "model-authentication"],
    ["insufficient_quota", "model-rate-or-quota"],
    ["Worker model is not approved for this session", "model-unavailable"],
    ["exec denied by security policy", "tool-policy"],
    ["EACCES: permission denied", "filesystem-permission"],
    ["Cannot find module", "file-or-command-missing"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls-validation"],
    ["fetch failed", "network-connection"],
    ["Worker turn authority changed while preparing its launch", "worker-authority"],
    ["Worker tunnel does not support worker turns", "worker-transport"],
    ["HTTP 401", "http-unauthorized"],
    ["HTTP 403", "http-forbidden"],
    ["HTTP 429", "http-rate-limit"],
  ];
  const turnDiagnostics = turnCases.map(([message, category]) => ({
    name: `native turn ${category}`,
    diagnostic: {
      kind: "native-first-agent-proof",
      failureStage: "model-outcome",
      worker: nativeWorkerTurnObservation({
        outcome: { status: "error", error: `${message}: ${nativePrivate}`, stopReason: "error" },
        error: new Error(nativePrivate),
        runId: "selected-run",
        historyLookup: "found",
        messages: [
          { role: "assistant", errorMessage: nativePrivate, __openclaw: { runId: "foreign-run" } },
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: `${message}: ${nativePrivate}`,
            __openclaw: { runId: "selected-run" },
          },
          {
            role: "toolResult",
            toolName: "exec",
            isError: true,
            content: [{ type: "text", text: `${message}: ${nativePrivate}` }],
            __openclaw: { runId: "selected-run" },
          },
          {
            role: "toolResult",
            toolName: "exec",
            isError: true,
            content: nativePrivate,
            __openclaw: { runId: "foreign-run" },
          },
        ],
      }),
    },
  }));
  // Installer errors add one more fixed wrapper. Exercise distinct transfer,
  // extraction, storage and prewarm failures without retaining their private details.
  const nativeLeafCases = [
    ["gateway returned 401", "bundle-http-401"],
    ["gateway returned 403", "bundle-http-403"],
    ["gateway returned 404", "bundle-http-404"],
    ["gateway returned 429", "bundle-http-client-error"],
    ["gateway returned 503", "bundle-http-server-error"],
    ["gateway returned 0", "bundle-http-unexpected-status"],
    ["gateway returned an unexpected worker bundle range", "bundle-range-invalid"],
    ["gateway returned an unexpected worker bundle length", "bundle-transfer-length-invalid"],
    [
      "worker bundle download stopped after 3 consecutive no-progress failures",
      "bundle-download-no-progress",
    ],
    ["prepared worker bundle archive has an unexpected length", "bundle-archive-length-invalid"],
    ["worker bundle archive exceeded its byte limit", "bundle-archive-too-large"],
    ["worker bundle transfer response exceeded its byte limit", "bundle-response-too-large"],
    ["worker bundle archive failed integrity validation", "bundle-archive-integrity-failed"],
    ["published worker bundle failed validation", "bundle-published-invalid"],
    ["gateway TLS fingerprint mismatch", "bundle-tls-mismatch"],
    ["Cloudflare Access credentials require HTTPS", "bundle-https-required"],
    ["gateway transfer is unavailable", "bundle-transfer-unavailable"],
    [
      "Worker bundle archive manifest does not match its expected hash",
      "bundle-manifest-hash-mismatch",
    ],
    ["Extracted worker bundle does not match its expected hash", "bundle-extracted-hash-mismatch"],
    ["Invalid worker bundle archive path:", "bundle-entry-invalid"],
    ["Worker bundle archive exceeds its entry limit", "bundle-extraction-limit"],
    ["Worker bundle contains a symbolic link:", "bundle-symlink-refused"],
    ["Worker bundle file changed while hashing:", "bundle-file-changed"],
    ["EACCES: permission denied", "bundle-storage-access-denied"],
    ["EPERM: operation not permitted", "bundle-operation-denied"],
    ["EROFS: read-only file system", "bundle-storage-readonly"],
    ["ENOSPC: no space left on device", "bundle-storage-full"],
    ["ENOENT: no such file or directory", "bundle-file-missing"],
    ["Command failed:", "bundle-prewarm-failed"],
    ["INVALID_REQUEST: invalid node worker bundle install request", "bundle-request-invalid"],
  ];
  const nativeLeafDiagnostics = nativeLeafCases.map(([message, category]) => ({
    name: `native installer ${category}`,
    diagnostic: {
      kind: "native-first-agent-proof",
      failureStage: "required-placement-terminal-failed",
      worker: nativeWorkerPlacementObservation({
        placement: {
          state: "failed",
          recoveryError: `Worker node bootstrap failed: Device worker bundle installation failed: ${category === "bundle-request-invalid" ? "" : "worker-bundle-install-failed: "}${message} ${nativePrivate}`,
        },
      }),
    },
  }));
  // An unknown outer message is not permission to search arbitrary private text for a cause.
  assert.equal(
    nativeWorkerPlacementObservation({
      placement: {
        recoveryError: `${nativePrivate}: Worker node bootstrap failed: OpenClaw worker deploy artifact is missing; build the running package`,
      },
    }).recoveryError,
    "other",
  );
  const relayPodCases = [
    {
      name: "retains closed relay Pod status without payloads",
      relayPod: {
        lookup: "found",
        phase: "Running",
        scheduled: "True",
        ready: "False",
        containerState: "waiting",
        waitingReason: "CrashLoopBackOff",
        terminationReason: "OOMKilled",
        exitCode: 137,
        restartCount: 3,
        nodeAssigned: true,
        imageIdPresent: true,
        containerIdPresent: false,
        message: secret,
        pod: { spec: { containers: [{ env: [{ value: secret }] }] } },
      },
      expected: {
        lookup: "found",
        phase: "Running",
        scheduled: "True",
        ready: "False",
        containerState: "waiting",
        waitingReason: "CrashLoopBackOff",
        terminationReason: "OOMKilled",
        exitCode: 137,
        restartCount: 3,
        nodeAssigned: true,
        imageIdPresent: true,
        containerIdPresent: false,
      },
    },
    {
      name: "retains closed scheduling causes in canonical order",
      relayPod: {
        lookup: "found",
        phase: "Pending",
        scheduled: "False",
        scheduledReason: "Unschedulable",
        schedulingFailures: [
          "insufficient-memory",
          "disk-pressure",
          "disk-pressure",
          secret,
          { message: secret },
        ],
        message: secret,
      },
      expected: {
        lookup: "found",
        phase: "Pending",
        scheduled: "False",
        scheduledReason: "Unschedulable",
        schedulingFailures: ["disk-pressure", "insufficient-memory", "other"],
        ready: "other",
        containerState: "other",
        waitingReason: "other",
        terminationReason: "other",
      },
    },
    {
      name: "replaces unknown relay Pod fields and omits invalid scalars",
      relayPod: {
        lookup: "found",
        phase: secret,
        scheduled: { value: secret },
        scheduledReason: secret,
        schedulingFailures: secret,
        ready: [secret],
        containerState: secret,
        waitingReason: secret,
        terminationReason: { message: secret },
        exitCode: 1.5,
        restartCount: -1,
        nodeAssigned: "true",
        imageIdPresent: 1,
        containerIdPresent: { value: secret },
      },
      expected: {
        lookup: "found",
        phase: "other",
        scheduled: "other",
        scheduledReason: "other",
        schedulingFailures: ["other"],
        ready: "other",
        containerState: "other",
        waitingReason: "other",
        terminationReason: "other",
      },
    },
    {
      name: "rejects out-of-range relay Pod counters",
      relayPod: {
        lookup: "found",
        exitCode: 256,
        restartCount: 2 ** 31,
        scheduledReason: "SchedulingGated",
        schedulingFailures: Array(14).fill("disk-pressure"),
      },
      expected: {
        lookup: "found",
        phase: "other",
        scheduled: "other",
        scheduledReason: "SchedulingGated",
        schedulingFailures: ["other"],
        ready: "other",
        containerState: "other",
        waitingReason: "other",
        terminationReason: "other",
      },
    },
    {
      name: "retains unavailable relay Pod lookup without its error",
      relayPod: { lookup: "unavailable", error: { message: secret }, exitCode: 137 },
      expected: { lookup: "unavailable" },
    },
    {
      name: "replaces unknown relay Pod lookup",
      relayPod: { lookup: secret, phase: secret },
      expected: { lookup: "other" },
    },
    ...[null, "invalid", []].map((relayPod, index) => ({
      name: `rejects malformed relay Pod diagnostic ${index}`,
      relayPod,
      expected: undefined,
    })),
    {
      name: "discards relay Pod status outside relay readiness",
      stage: "controller-startup",
      relayPod: { lookup: "found", phase: "Running", message: secret },
      expected: undefined,
    },
  ];

  const relayNodeCases = [
    {
      name: "retains closed node pressure evidence without node or workload identities",
      relayNode: {
        lookup: "found",
        conditions: {
          ready: "True",
          diskPressure: "True",
          memoryPressure: "False",
          pidPressure: "False",
          networkUnavailable: "Unknown",
          message: secret,
        },
        unschedulable: false,
        taints: [
          { category: "disk-pressure", effect: "NoSchedule", key: secret, value: secret },
          { category: "disk-pressure", effect: "NoSchedule" },
          { category: secret, effect: secret, message: secret },
        ],
        taintCount: 3,
        unrecognizedTaintCount: 1,
        name: secret,
        providerID: secret,
        filesystems: {
          lookup: "found",
          nodeFs: {
            availableBytes: 0,
            capacityBytes: 1024,
            inodesFree: 2,
            inodes: 4096,
            mountpoint: secret,
          },
          imageFs: {
            availableBytes: 512,
            capacityBytes: 2048,
            inodesFree: 0,
            inodes: Number.MAX_SAFE_INTEGER,
          },
          pods: [{ name: secret, containers: [{ logs: secret }] }],
        },
      },
      expected: {
        lookup: "found",
        conditions: {
          ready: "True",
          diskPressure: "True",
          memoryPressure: "False",
          pidPressure: "False",
          networkUnavailable: "Unknown",
        },
        unschedulable: false,
        taints: [
          { category: "disk-pressure", effect: "NoSchedule" },
          { category: "other", effect: "other" },
        ],
        taintCount: 3,
        unrecognizedTaintCount: 1,
        filesystems: {
          lookup: "found",
          nodeFs: { availableBytes: 0, capacityBytes: 1024, inodesFree: 2, inodes: 4096 },
          imageFs: {
            availableBytes: 512,
            capacityBytes: 2048,
            inodesFree: 0,
            inodes: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    },
    {
      name: "rejects malformed node fields and unsafe filesystem counters",
      relayNode: {
        lookup: "found",
        conditions: { ready: secret, diskPressure: [secret] },
        unschedulable: "true",
        taints: Array(65).fill({ category: "disk-pressure", effect: "NoSchedule" }),
        taintCount: -1,
        unrecognizedTaintCount: 2 ** 31,
        filesystems: {
          lookup: "found",
          nodeFs: {
            availableBytes: -1,
            capacityBytes: 1.5,
            inodesFree: "3",
            inodes: Number.MAX_SAFE_INTEGER + 1,
          },
          imageFs: [secret],
          message: secret,
        },
      },
      expected: {
        lookup: "found",
        conditions: {
          ready: "other",
          diskPressure: "other",
          memoryPressure: "other",
          pidPressure: "other",
          networkUnavailable: "other",
        },
        taints: [{ category: "other", effect: "other" }],
        filesystems: { lookup: "found", nodeFs: {} },
      },
    },
    {
      name: "retains node lookup when optional filesystem lookup fails",
      relayNode: {
        lookup: "found",
        conditions: null,
        taints: [],
        taintCount: 0,
        unrecognizedTaintCount: 0,
        filesystems: { lookup: "unavailable", error: secret },
      },
      expected: {
        lookup: "found",
        conditions: {
          ready: "other",
          diskPressure: "other",
          memoryPressure: "other",
          pidPressure: "other",
          networkUnavailable: "other",
        },
        taints: [],
        taintCount: 0,
        unrecognizedTaintCount: 0,
        filesystems: { lookup: "unavailable" },
      },
    },
    {
      name: "replaces unknown node and filesystem categories",
      relayNode: {
        lookup: "found",
        taints: secret,
        filesystems: { lookup: secret, nodeFs: { availableBytes: 3 }, message: secret },
      },
      expected: {
        lookup: "found",
        conditions: {
          ready: "other",
          diskPressure: "other",
          memoryPressure: "other",
          pidPressure: "other",
          networkUnavailable: "other",
        },
        taints: [{ category: "other", effect: "other" }],
        filesystems: { lookup: "other" },
      },
    },
    {
      name: "retains unavailable node lookup without its error",
      relayNode: { lookup: "unavailable", error: secret, name: secret },
      expected: { lookup: "unavailable" },
    },
    {
      name: "replaces unknown node lookup",
      relayNode: { lookup: secret, conditions: secret },
      expected: { lookup: "other" },
    },
    ...[null, secret, []].map((relayNode, index) => ({
      name: `rejects malformed relay node diagnostic ${index}`,
      relayNode,
      expected: undefined,
    })),
    {
      name: "discards node evidence outside relay readiness",
      stage: "controller-startup",
      relayNode: { lookup: "found", name: secret },
      expected: undefined,
    },
  ];

  await writeSingleFileRunnerLane(
    root,
    "redacted",
    "tests/integration/redacted.test.mjs",
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("redacted failure locator", () => {',
      `  console.log("${secret}-stdout");`,
      `  console.error("${secret}-stderr");`,
      `  assert.equal("${secret}-actual", "expected");`,
      "});",
      'test("job env redaction", () => {',
      '  throw new Error("owner openclaw-public-owner strippedjobvalue42");',
      "});",
      'test("redacted custom error", () => {',
      `  console.log("${secret}-custom-stdout");`,
      `  console.error("${secret}-custom-stderr");`,
      `  const error = new Error("${secret}-message");`,
      `  error.name = "${secret}-name";`,
      `  error.code = "${secret}-code";`,
      "  throw error;",
      "});",
      'test("allowlisted controller HTTP diagnostic", () => {',
      "  try {",
      "    assert.equal(503, 201);",
      "  } catch (error) {",
      "    error.openclawCiDiagnostic = {",
      '      kind: "controller-http",',
      "      status: 503,",
      "      expectedStatus: 201,",
      '      occErrorCode: "DEPENDENCY_UNAVAILABLE",',
      "      upstream: {",
      '        kind: "chatgpt-admin-http",',
      '        operation: "create-service-account",',
      "        status: 403,",
      `        body: "${secret}-body",`,
      "      },",
      `      identity: "${secret}-identity",`,
      "    };",
      "    throw error;",
      "  }",
      "});",
      'test("allowlisted observability installation status diagnostic", () => {',
      "  try {",
      "    assert.equal(503, 401);",
      "  } catch (error) {",
      "    error.openclawCiDiagnostic = {",
      '      kind: "observability-installation-status",',
      "      status: 503,",
      `      body: "${secret}-body",`,
      "    };",
      "    throw error;",
      "  }",
      "});",
      'test("rejects unsafe observability installation status diagnostic", () => {',
      '  const error = new Error("Invalid status control");',
      `  error.openclawCiDiagnostic = { kind: "observability-installation-status", status: "${secret}" };`,
      "  throw error;",
      "});",
      'test("allowlisted observability log export diagnostic", () => {',
      `  const error = new Error("${secret}-message");`,
      `  error.openclawCiDiagnostic = { kind: "observability-log-export", api: true, worker: false, records: ["${secret}-record"] };`,
      "  throw error;",
      "});",
      'test("rejects unsafe observability log export diagnostic", () => {',
      `  const error = new Error("${secret}-message");`,
      `  error.openclawCiDiagnostic = { kind: "observability-log-export", api: "${secret}", worker: false };`,
      "  throw error;",
      "});",
      'test("rejects unsafe controller HTTP diagnostic", () => {',
      "  try {",
      "    assert.equal(500, 201);",
      "  } catch (error) {",
      "    error.openclawCiDiagnostic = {",
      '      kind: "controller-http",',
      "      status: 500,",
      "      expectedStatus: 201,",
      `      occErrorCode: "${secret}-code",`,
      "      upstream: {",
      '        kind: "chatgpt-admin-http",',
      `        operation: "${secret}-operation",`,
      "        status: 401,",
      "      },",
      "    };",
      "    throw error;",
      "  }",
      "});",
      'for (const stage of ["ready-status", "warning-status", "initial-rollout", "warning-rollout", "secretauthvalue-stage"]) {',
      '  test(stage === "secretauthvalue-stage" ? "unsafe plugin stage" : stage, () => {',
      '    const error = new Error("secretauthvalue-message");',
      '    error.openclawCiDiagnostic = { kind: "kubernetes-plugin-status", stage, body: "secretauthvalue-body" };',
      '    if (stage === "warning-rollout") error.openclawCiDiagnostic.pods = [',
      '      { phase: "Pending", ready: false, scheduled: true, secret: "secretauthvalue", containers: [',
      '        { name: "gateway", restartCount: 2, exitCode: 1, waitingReason: "CrashLoopBackOff", terminatedReason: "Error", message: "secretauthvalue" },',
      '        { name: "secretauthvalue", restartCount: 3 },',
      '        { name: "gateway", restartCount: 4 }',
      "      ] },",
      '      { phase: "secretauthvalue" },',
      '      { phase: "Running", ready: "secretauthvalue", scheduled: "secretauthvalue", containers: [',
      '        { name: "prepare-private-state", restartCount: -1, exitCode: 256, waitingReason: "secretauthvalue", terminatedReason: "secretauthvalue" }',
      "      ] },",
      '      { phase: "Failed" }',
      "    ];",
      "    throw error;",
      "  });",
      "}",
      `for (const { name, diagnostic } of ${JSON.stringify([
        {
          name: "allowlisted denied traffic diagnostic",
          diagnostic: {
            kind: "network-policy",
            stage: "Agent outbound platform traffic",
            target: secret,
          },
        },
        {
          name: "rejects unsafe denied traffic diagnostic",
          diagnostic: { kind: "network-policy", stage: secret },
        },
        {
          name: "allowlisted runtime stock broker diagnostic",
          diagnostic: {
            kind: "runtime-image-stock-broker",
            stage: "broker-denial",
            command: [secret],
            stderr: `${secret}-stderr`,
          },
        },
        {
          name: "rejects unsafe runtime stock broker stage",
          diagnostic: { kind: "runtime-image-stock-broker", stage: `${secret}-stage` },
        },
        {
          name: "retains native first-Agent proof failure stage",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement",
            output: `${secret}-output`,
          },
        },
        {
          name: "retains a terminal native first-Agent placement stage",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement-terminal-reclaimed",
          },
        },
        {
          name: "retains native worker placement observations through CI",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement-terminal-failed",
            worker: { ...nativeWorker, recoveryErrorDetail: nativePrivate, session: nativePrivate },
            environmentId: nativePrivate,
            workspace: nativePrivate,
          },
        },
        {
          name: "retains value-free native history observations through CI",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "model-history",
            worker: { ...nativeHistory, transcript: nativePrivate },
          },
        },
        ...inconsistentNativeFailures.map(([exitCode, operation, code], index) => ({
          name: `rejects inconsistent native failure ${index}`,
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "model-history",
            worker: {
              historyExecNestedExitCode: exitCode,
              historyExecFailureOperation: operation,
              historyExecFailureCode: code,
            },
          },
        })),
        {
          name: "rejects hostile native worker diagnostic fields",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement",
            worker: {
              placementState: nativePrivate,
              recoveryError: { message: nativePrivate },
              environmentLookup: { value: nativePrivate },
              expectedNodeConnected: nativePrivate,
              expectedNodeMatches: 4097,
              nodeCount: -1,
              elapsedMs: 3_600_001,
              session: nativePrivate,
              turnStatus: nativePrivate,
              turnError: { message: nativePrivate },
              assistantError: nativePrivate,
              execError: nativePrivate,
              execResultCount: 4097,
              ...Object.fromEntries(Object.keys(nativeHistory).map((key) => [key, nativePrivate])),
            },
          },
        },
        {
          name: "retains wrapped native worker bootstrap causes through CI",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "required-placement-terminal-failed",
            worker: wrappedNativeWorker,
          },
        },
        ...[
          ["refreshes retained native placement", freshNativeWorker],
          ["labels fallback after failed native placement refresh", fallbackNativeWorker],
          ["rejects another session during native placement refresh", mismatchedNativeWorker],
        ].map(([name, worker]) => ({
          name,
          diagnostic: { kind: "native-first-agent-proof", failureStage: "model-and-exec", worker },
        })),
        ...nativeLeafDiagnostics,
        ...turnDiagnostics,
        {
          name: "collects native turn failure within the shared read budget",
          diagnostic: {
            kind: "native-first-agent-proof",
            failureStage: "model-history",
            worker: collectedTurn,
          },
        },
        {
          name: "rejects unknown native first-Agent proof stage",
          diagnostic: { kind: "native-first-agent-proof", failureStage: `${secret}-stage` },
        },
        {
          name: "retains safe monitoring readiness evidence",
          diagnostic: {
            kind: "metrics-monitoring",
            stage: "prometheus-up",
            reason: "container-exited",
            container: "agent",
            exitCode: 2,
            lastHttpStatus: 503,
            logs: secret,
          },
        },
        {
          name: "rejects unsafe monitoring stage",
          diagnostic: {
            kind: "metrics-monitoring",
            stage: secret,
            reason: "timeout",
          },
        },
        {
          name: "allowlisted repository platform setup diagnostic",
          diagnostic: {
            kind: "repository-platform-setup",
            stage: "relay-readiness",
            args: [secret],
            configuration: { credential: secret },
          },
        },
        {
          name: "allowlisted credential service startup reason",
          diagnostic: {
            kind: "repository-platform-setup",
            stage: "credential-service-startup",
            credentialService: "gateway-listener",
          },
        },
        {
          name: "rejects unsafe credential service startup reason",
          diagnostic: {
            kind: "repository-platform-setup",
            stage: "credential-service-startup",
            credentialService: `${secret}-reason`,
          },
        },
        {
          name: "rejects unsafe repository platform setup stage",
          diagnostic: { kind: "repository-platform-setup", stage: `${secret}-stage` },
        },
        {
          name: "rejects nonstring repository platform setup stage",
          diagnostic: { kind: "repository-platform-setup", stage: { value: secret } },
        },
        {
          name: "rejects unknown setup diagnostic kind",
          diagnostic: { kind: `${secret}-kind`, stage: "relay-readiness" },
        },
        ...relayPodCases.map(({ name, stage = "relay-readiness", relayPod }) => ({
          name,
          diagnostic: { kind: "repository-platform-setup", stage, relayPod },
        })),
        ...relayNodeCases.map(({ name, stage = "relay-readiness", relayNode }) => ({
          name,
          diagnostic: { kind: "repository-platform-setup", stage, relayNode },
        })),
      ])}) {`,
      "  test(name, () => {",
      `    const cause = new Error("${secret}-source-message");`,
      `    cause.args = ["${secret}-argument"];`,
      `    cause.configuration = { credential: "${secret}-credential" };`,
      `    const error = new Error("${secret}-setup-message", { cause });`,
      "    error.openclawCiDiagnostic = diagnostic;",
      "    throw error;",
      "  });",
      "}",
      "",
    ].join("\n"),
  );

  const result = run(root, laneArgs(root, "redacted", "state/redacted.jsonl", resultsPath), {
    // Public runner metadata stays readable; the runner strips OCC_TEST_* from
    // the test child, so only its own second pass can redact this value.
    GITHUB_REPOSITORY_OWNER: "openclaw-public-owner",
    OCC_TEST_STRIPPED_VALUE: "strippedjobvalue42",
  });

  assert.equal(result.status, 1);
  const details = await readFile(join(root, "state/redacted.jsonl.diagnostics.json"), "utf8");
  const cliAndArtifact = `${result.stdout}\n${result.stderr}\n${await readFile(resultsPath, "utf8")}\n${details}`;
  assert.doesNotMatch(cliAndArtifact, /secretauthvalue|strippedjobvalue42/);
  assert.ok(!cliAndArtifact.includes(nativePrivate));
  assert.ok(JSON.parse(details).failures[0].tests.length > 0);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.files[0].tests[0].name, "redacted failure locator");
  assert.equal(summary.files[0].tests[0].line, 3);
  const failure = summary.files[0].tests[0].error;
  assert.equal(failure.code, "ERR_TEST_FAILURE");
  assert.equal(failure.name, "Error");
  assert.equal(failure.cause.code, "ERR_ASSERTION");
  assert.equal(failure.cause.name, "AssertionError");
  assert.equal(
    failure.location.file,
    await realpath(join(root, "tests/integration/redacted.test.mjs")),
  );
  assert.equal(failure.location.line, 6);
  assert.ok(failure.location.column > 0);
  // The bounded message and top frame name the failure; env values never survive.
  assert.match(failure.message, /'\[env:CI_RUNNER_FIXTURE_CREDENTIAL\]-actual'/);
  assert.match(failure.message, /'expected'/);
  assert.match(failure.frame, /\(tests\/integration\/redacted\.test\.mjs:6:\d+\)$/);
  assert.match(
    result.stderr,
    /run-tests: failed tests\/integration\/redacted\.test\.mjs:6 "redacted failure locator": Expected values/,
  );
  const customFailure = summary.files[0].tests.find(
    (entry) => entry.name === "redacted custom error",
  );
  assert.equal(customFailure.status, "failed");
  assert.equal(customFailure.error.cause, undefined);
  assert.equal(customFailure.error.location.line, 14);
  assert.equal(customFailure.error.message, "[env:CI_RUNNER_FIXTURE_CREDENTIAL]-message");
  assert.equal(
    summary.files[0].tests.find((entry) => entry.name === "job env redaction").error.message,
    "owner openclaw-public-owner [env:OCC_TEST_STRIPPED_VALUE]",
  );
  const httpFailure = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted controller HTTP diagnostic",
  );
  assert.deepEqual(httpFailure.error.diagnostic, {
    kind: "controller-http",
    status: 503,
    expectedStatus: 201,
    occErrorCode: "DEPENDENCY_UNAVAILABLE",
    upstream: { kind: "chatgpt-admin-http", operation: "create-service-account", status: 403 },
  });
  const unsafeFailure = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe controller HTTP diagnostic",
  );
  assert.equal(unsafeFailure.error.diagnostic, undefined);
  const installationStatusFailure = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted observability installation status diagnostic",
  );
  assert.deepEqual(installationStatusFailure.error.diagnostic, {
    kind: "observability-installation-status",
    status: 503,
    expectedStatus: 401,
  });
  const unsafeInstallationStatusFailure = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe observability installation status diagnostic",
  );
  assert.equal(unsafeInstallationStatusFailure.error.diagnostic, undefined);
  const logExportFailure = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted observability log export diagnostic",
  );
  assert.deepEqual(logExportFailure.error.diagnostic, {
    kind: "observability-log-export",
    api: true,
    worker: false,
  });
  const unsafeLogExportFailure = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe observability log export diagnostic",
  );
  assert.equal(unsafeLogExportFailure.error.diagnostic, undefined);
  // Keep the failed wait identifiable without exposing arbitrary runtime output.
  for (const stage of ["ready-status", "warning-status", "initial-rollout"]) {
    const failure = summary.files[0].tests.find((entry) => entry.name === stage);
    assert.deepEqual(failure.error.diagnostic, { kind: "kubernetes-plugin-status", stage });
  }
  const rolloutFailure = summary.files[0].tests.find((entry) => entry.name === "warning-rollout");
  assert.deepEqual(rolloutFailure.error.diagnostic, {
    kind: "kubernetes-plugin-status",
    stage: "warning-rollout",
    pods: [
      {
        phase: "Pending",
        ready: false,
        scheduled: true,
        containers: [
          {
            name: "gateway",
            restartCount: 2,
            exitCode: 1,
            waitingReason: "CrashLoopBackOff",
            terminatedReason: "Error",
          },
        ],
      },
      { phase: "Running", containers: [{ name: "prepare-private-state" }] },
    ],
  });
  const unsafeStage = summary.files[0].tests.find((entry) => entry.name === "unsafe plugin stage");
  assert.equal(unsafeStage.error.diagnostic, undefined);
  const deniedTraffic = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted denied traffic diagnostic",
  );
  assert.deepEqual(deniedTraffic.error.diagnostic, {
    kind: "network-policy",
    stage: "Agent outbound platform traffic",
  });
  const unsafeTraffic = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe denied traffic diagnostic",
  );
  assert.equal(unsafeTraffic.error.diagnostic, undefined);
  const stockBrokerFailure = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted runtime stock broker diagnostic",
  );
  assert.deepEqual(stockBrokerFailure.error.diagnostic, {
    kind: "runtime-image-stock-broker",
    stage: "broker-denial",
  });
  const unsafeStockBroker = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe runtime stock broker stage",
  );
  assert.equal(unsafeStockBroker.error.diagnostic, undefined);
  const nativeProof = summary.files[0].tests.find(
    (entry) => entry.name === "retains native first-Agent proof failure stage",
  );
  assert.equal(nativeProof.status, "failed");
  assert.deepEqual(nativeProof.error.diagnostic, {
    kind: "native-first-agent-proof",
    failureStage: "required-placement",
  });
  const terminalPlacement = summary.files[0].tests.find(
    (entry) => entry.name === "retains a terminal native first-Agent placement stage",
  );
  assert.deepEqual(terminalPlacement.error.diagnostic, {
    kind: "native-first-agent-proof",
    failureStage: "required-placement-terminal-reclaimed",
  });
  const retainedNative = summary.files[0].tests.find(
    (entry) => entry.name === "retains native worker placement observations through CI",
  ).error.diagnostic;
  assert.deepEqual(retainedNative, {
    kind: "native-first-agent-proof",
    failureStage: "required-placement-terminal-failed",
    worker: {
      placementState: "failed",
      recoveryError: "tunnel-timeout",
      terminalReason: "other",
      workspaceReferencePresent: true,
      environmentLookup: "found",
      environmentState: "failed",
      environmentError: "other",
      tunnelStatus: "stopped",
      attachedSessionCount: 1,
      attachedSessionMatches: true,
      nodeLookup: "found",
      nodeCount: 2,
      connectedNodeCount: 1,
      expectedNodeIdPresent: true,
      expectedNodeMatches: 1,
      expectedNodeConnected: false,
      expectedNodePaired: true,
      expectedNodeSessionHost: true,
      expectedNodeCaps: 2,
      expectedNodeCommands: 1,
      expectedNodeWorkerBundle: "installed",
      elapsedMs: 180488,
    },
  });
  assert.deepEqual(
    summary.files[0].tests.find(
      (entry) => entry.name === "retains value-free native history observations through CI",
    ).error.diagnostic.worker,
    nativeHistory,
  );
  for (const [index, [exitCode]] of inconsistentNativeFailures.entries()) {
    assert.deepEqual(
      summary.files[0].tests.find(
        (entry) => entry.name === `rejects inconsistent native failure ${index}`,
      ).error.diagnostic.worker,
      exitCode === undefined ? {} : { historyExecNestedExitCode: exitCode },
    );
  }
  assert.deepEqual(
    summary.files[0].tests.find(
      (entry) => entry.name === "rejects hostile native worker diagnostic fields",
    ).error.diagnostic.worker,
    {
      placementState: "other",
      recoveryError: "other",
      environmentLookup: "other",
      turnStatus: "other",
      turnError: "other",
      assistantError: "other",
      execError: "other",
      historyExecErrorFlag: "other",
    },
  );
  for (const [, category] of turnCases) {
    const turn = summary.files[0].tests.find((entry) => entry.name === `native turn ${category}`)
      .error.diagnostic.worker;
    assert.equal(turn.turnStatus, "error");
    assert.equal(turn.turnError, category);
    assert.equal(turn.assistantError, category);
    assert.equal(turn.execError, category);
    assert.equal(turn.proofError, "other");
    assert.equal(turn.execResultCount, 1);
    assert.equal(turn.execFailureCount, 1);
  }
  const collected = summary.files[0].tests.find(
    (entry) => entry.name === "collects native turn failure within the shared read budget",
  ).error.diagnostic.worker;
  assert.equal(collected.turnError, "network-connection");
  assert.equal(collected.historyLookup, "found");
  const wrapped = summary.files[0].tests.find(
    (entry) => entry.name === "retains wrapped native worker bootstrap causes through CI",
  ).error.diagnostic.worker;
  assert.equal(wrapped.recoveryError, "worker-deploy-artifact-missing");
  assert.equal(wrapped.terminalReason, "bundle-install-failed");
  assert.equal(wrapped.environmentError, "node-installer-disconnected");
  const fresh = summary.files[0].tests.find(
    (entry) => entry.name === "refreshes retained native placement",
  ).error.diagnostic.worker;
  assert.equal(fresh.placementLookup, "fresh");
  assert.equal(fresh.placementState, "failed");
  assert.equal(fresh.environmentState, "failed");
  assert.equal(fresh.tunnelStatus, "stopped");
  for (const name of [
    "labels fallback after failed native placement refresh",
    "rejects another session during native placement refresh",
  ]) {
    const fallback = summary.files[0].tests.find((entry) => entry.name === name).error.diagnostic
      .worker;
    assert.equal(fallback.placementLookup, "fallback");
    assert.equal(fallback.placementState, "active");
    assert.equal(fallback.environmentState, "attached");
  }
  for (const [, category] of nativeLeafCases) {
    const leaf = summary.files[0].tests.find(
      (entry) => entry.name === `native installer ${category}`,
    );
    assert.equal(leaf.error.diagnostic.worker.recoveryError, category);
  }
  const monitoringFailure = summary.files[0].tests.find(
    (entry) => entry.name === "retains safe monitoring readiness evidence",
  );
  assert.deepEqual(monitoringFailure.error.diagnostic, {
    kind: "metrics-monitoring",
    stage: "prometheus-up",
    reason: "container-exited",
    container: "agent",
    exitCode: 2,
    lastHttpStatus: 503,
  });
  const unsafeMonitoring = summary.files[0].tests.find(
    (entry) => entry.name === "rejects unsafe monitoring stage",
  );
  assert.equal(unsafeMonitoring.error.diagnostic, undefined);
  const setupFailure = summary.files[0].tests.find(
    (entry) => entry.name === "allowlisted repository platform setup diagnostic",
  );
  assert.deepEqual(setupFailure.error.diagnostic, {
    kind: "repository-platform-setup",
    stage: "relay-readiness",
  });
  assert.deepEqual(
    summary.files[0].tests.find(
      (entry) => entry.name === "allowlisted credential service startup reason",
    ).error.diagnostic,
    {
      kind: "repository-platform-setup",
      stage: "credential-service-startup",
      credentialService: "gateway-listener",
    },
  );
  assert.deepEqual(
    summary.files[0].tests.find(
      (entry) => entry.name === "rejects unsafe credential service startup reason",
    ).error.diagnostic,
    { kind: "repository-platform-setup", stage: "credential-service-startup" },
  );
  for (const { name, stage = "relay-readiness", expected } of relayPodCases) {
    const relayFailure = summary.files[0].tests.find((entry) => entry.name === name);
    assert.equal(relayFailure.status, "failed");
    assert.equal(relayFailure.error.diagnostic.stage, stage);
    assert.deepEqual(relayFailure.error.diagnostic.relayPod, expected, name);
  }
  for (const { name, stage = "relay-readiness", expected } of relayNodeCases) {
    const nodeFailure = summary.files[0].tests.find((entry) => entry.name === name);
    assert.equal(nodeFailure.status, "failed");
    assert.equal(nodeFailure.error.diagnostic.stage, stage);
    assert.deepEqual(nodeFailure.error.diagnostic.relayNode, expected, name);
  }
  for (const name of [
    "rejects unknown native first-Agent proof stage",
    "rejects unsafe repository platform setup stage",
    "rejects nonstring repository platform setup stage",
    "rejects unknown setup diagnostic kind",
  ]) {
    const rejected = summary.files[0].tests.find((entry) => entry.name === name);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.error.diagnostic, undefined);
  }
});

test("failure text is bounded and redacts env values and credential shapes", async () => {
  const { default: reporter } = await import("../../scripts/ci/reporter.mjs");
  const { failureSecrets, redactFailure } = await import("../../scripts/ci/failure-redaction.mjs");
  const secrets = failureSecrets([
    { GITHUB_REPOSITORY_OWNER: "openclaw", JOB_ONLY_KEY: "jobonlyopaque123" },
    {
      CHILD_URL: syntheticCredentialUrl({
        protocol: "postgres",
        username: "app",
        password: "childpw77",
        host: "db",
        pathname: "/app",
      }),
      JOB_ONLY_KEY: "otheropaque456",
    },
  ]);
  const render = async (cause) => {
    let text = "";
    for await (const chunk of reporter([
      { type: "test:fail", data: { name: "case", details: { error: { cause } } } },
    ])) {
      text += chunk;
    }
    const raw = JSON.parse(text.split("\n")[0]).data.error;
    const error = redactFailure(raw, secrets, "/repo");
    // The whole stack goes only to the diagnostics report's copy.
    assert.equal(error.stack, undefined);
    return error;
  };
  const credentials = [
    "Authorization: Bearer abcdefghijklmnop0123",
    syntheticCredentialUrl({
      protocol: "postgres",
      username: "occ",
      password: "hunter2pass",
      host: "db.internal",
      port: 5432,
      pathname: "/occ",
    }),
    "token=ghp_0123456789abcdefghijABCDEFGHIJ",
    'password: "correct-horse"',
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJl",
    "sk-proj-0123456789abcdef",
    "xoxb-1234-5678-abcdefgh",
    "xapp-1-A0123-4567-abcdef",
    [
      syntheticCredentialUrl({
        protocol: "redis",
        username: "",
        password: "redispw99",
        host: "cache",
        port: 6379,
      }),
      syntheticCredentialUrl({
        username: "tokenvalue123",
        password: "",
        host: "git.example",
      }).replace(":@", "@"),
    ].join(" "),
    '{"privateKey":"pkvalue123"}',
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----",
    "job jobonlyopaque123 child otheropaque456 password childpw77",
  ];
  const error = await render(
    new Error(`request failed for openclaw at /repo/x.mjs\n${credentials.join("\n")}`),
  );
  // Public runner metadata stays readable; the repository path is stripped.
  assert.match(error.message, /^request failed for openclaw at x\.mjs\n/);
  assert.match(
    error.message,
    /job \[env:JOB_ONLY_KEY\] child \[env:JOB_ONLY_KEY\] password \[env:CHILD_URL\]/,
  );
  for (const leaked of [
    "abcdefghijklmnop0123",
    "hunter2pass",
    "ghp_0123",
    "correct-horse",
    "eyJhbGci",
    "sk-proj",
    "xoxb-",
    "MIIEabc",
    "xapp-1",
    "redispw99",
    "tokenvalue123",
    "pkvalue123",
  ]) {
    assert.doesNotMatch(error.message, new RegExp(leaked));
  }
  assert.match(error.frame, /^at /);
  // A stack quoted in the message is not the frame.
  const quoted = await render({
    message: "child failed\n    at quoted (/elsewhere/child.js:1:1)",
    stack:
      "Error: child failed\n    at quoted (/elsewhere/child.js:1:1)\n    at real (helper.mjs:2:3)",
  });
  assert.equal(quoted.frame, "at real (helper.mjs:2:3)");
  // A value split by the cut survives as neither the value nor a prefix of it.
  const long = await render(new Error(`${"x".repeat(16_370)} jobonlyopaque123`));
  assert.ok(long.message.length < 700);
  assert.match(long.message, /\.\.\. \[truncated\]$/);
  const straddle = await render(new Error(`${"y ".repeat(296)}key jobonlyopaque123 tail`));
  assert.doesNotMatch(straddle.message, /jobonly/);
  assert.equal((await render("thrown string")).message, "thrown string");
  assert.equal((await render(undefined)).message, undefined);
  assert.equal((await render(42)).message, "42");
});

// Finding 2785: a DOMException (a fetch timeout or abort) crosses node:test's process
// boundary as a bare stack with an empty message, so its failure had no text at all.
test("run names DOMException and empty-message failures", async (t) => {
  const root = await fixture(t);
  const file = "tests/integration/errors.test.mjs";
  const resultsPath = join(root, "results/errors.json");
  await writeSingleFileRunnerLane(
    root,
    "errors",
    file,
    [
      'import test from "node:test";',
      'test("timeout", () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });',
      'test("abort", () => { const controller = new AbortController(); controller.abort(); throw controller.signal.reason; });',
      'test("empty", () => { throw new Error(""); });',
      "",
    ].join("\n"),
  );

  const result = run(root, laneArgs(root, "errors", "state/errors.jsonl", resultsPath));
  assert.equal(result.status, 1);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  const failure = (name) => summary.files[0].tests.find((entry) => entry.name === name).error;
  // The stack header names the exception, and the frame skips Node's DOMException constructor.
  for (const [name, message, line] of [
    ["timeout", "TimeoutError: The operation was aborted due to timeout", 2],
    ["abort", "AbortError: This operation was aborted", 3],
    ["empty", "Error", 4],
  ]) {
    assert.equal(failure(name).message, message);
    assert.match(
      failure(name).frame,
      new RegExp(`\\(${file.replaceAll(".", "\\.")}:${line}:\\d+\\)$`),
    );
  }
  // The job log names the failure too.
  assert.match(
    result.stderr,
    /run-tests: failed tests\/integration\/errors\.test\.mjs:2 "timeout": TimeoutError: The operation was aborted due to timeout \(at /,
  );
});

test("policy probe diagnostics preserve first-match failure and omit model content", async (t) => {
  const { selectPolicyProbeCommand } = await import("../helpers/openshell-policy-probe.mjs");
  const uri = "http://private-fixture.invalid:8083/policy-probe";
  const event = (command) => ({
    method: "item/completed",
    params: { item: { type: "commandExecution", command } },
  });
  const first = event("/usr/bin/python3.11 -c 'import urllib.request' # private-model-content");
  const correct = event(
    `/usr/bin/python3.11 -c 'import urllib.request; urllib.request.urlopen("${uri}")'`,
  );
  let calls = 0;
  // A later correct command must not turn the first command's failure into success.
  assert.throws(
    () =>
      selectPolicyProbeCommand([first, correct], { uri, port: 8083 }, () => {
        calls += 1;
        throw new Error("diagnostic write failed");
      }),
    { code: "ERR_ASSERTION" },
  );
  assert.equal(calls, 1);
  assert.equal(
    selectPolicyProbeCommand([correct], { uri, port: 8083 }, () => {
      calls += 1;
    }),
    correct.params.item,
  );
  assert.equal(calls, 1, "successful probes emit no failure receipt");

  const root = await fixture(t);
  const resultsPath = join(root, "results/policy.json");
  const statePath = join(root, "state/policy.json");
  await writeFile(
    join(root, "tests/integration/policy.test.mjs"),
    [
      'import test from "node:test";',
      `import { selectPolicyProbeCommand } from ${JSON.stringify(new URL("../helpers/openshell-policy-probe.mjs", import.meta.url).href)};`,
      `const first = ${JSON.stringify(first)};`,
      `const later = ${JSON.stringify(event(first.params.item.command + " # later-command"))};`,
      `const prefix = ${JSON.stringify(event("echo private-model-content"))};`,
      `const correct = ${JSON.stringify(correct)};`,
      'test("retains original guard", (t) => {',
      '  for (const check of ["second-agent-control-request", "second-agent-denied-request"]) t.diagnostic("openclaw-ci-measurement " + JSON.stringify({ kind: "openshell-network-policy-check", check }));',
      `  selectPolicyProbeCommand([...Array(9).fill(prefix), first, ...Array(8).fill(later), correct], { uri: ${JSON.stringify(uri)}, port: 8083 }, (receipt) => {`,
      '    t.diagnostic("openclaw-ci-measurement " + JSON.stringify({ ...receipt, raw: "private-extra-content", commands: receipt.commands.map(c => ({ ...c, raw: "private-extra-content" })) }));',
      '    for (const invalid of [{ ...receipt, candidateCount: -1 }, { ...receipt, commands: Array(9).fill(receipt.commands[0]) }, { ...receipt, port: 80 }, { ...receipt, targetHash: "private-extra-content" }, { ...receipt, commands: receipt.commands.map(c => ({ ...c, hash: "private-extra-content" })) }]) t.diagnostic("openclaw-ci-measurement " + JSON.stringify(invalid));',
      "  });",
      "});",
    ].join("\n"),
  );
  await writeSingleLaneManifest(root, "policy", [{ path: "tests/integration/policy.test.mjs" }], {
    ci: ["policy"],
  });
  const result = run(root, laneArgs(root, "policy", statePath, resultsPath));
  assert.equal(result.status, 1);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.files[0].tests[0].error.cause.code, "ERR_ASSERTION");
  const [control, denial, receipt] = summary.files[0].measurements;
  assert.equal(control.check, "second-agent-control-request");
  assert.equal(denial.check, "second-agent-denied-request");
  assert.equal(
    summary.files[0].measurements.length,
    3,
    "invalid or oversized receipts are rejected",
  );
  assert.equal(receipt.commandCount, 19);
  assert.equal(receipt.candidateCount, 10);
  assert.equal(receipt.selectedIndex, 9);
  assert.equal(receipt.laterUriMatches, 1, "a later match beyond the detail cap remains visible");
  assert.equal(receipt.commands.length, 8);
  assert.equal(
    receipt.commands[0].hash,
    createHash("sha256").update(first.params.item.command).digest("hex"),
  );
  assert.equal(receipt.commands[0].hasExpectedUri, false);
  assert.equal(receipt.commands[0].hasInterpreter, true);
  assert.equal(receipt.commands[0].hasUrllib, true);
  assert.equal(receipt.targetHash, createHash("sha256").update(uri).digest("hex"));
  const retained =
    JSON.stringify(summary) +
    (await readFile(`${statePath}.diagnostics.json`, "utf8")) +
    result.stdout +
    result.stderr;
  assert.doesNotMatch(retained, /private-fixture|private-model-content|private-extra-content/);
});

test("Skill policy restore preserves failures that cannot be formatted", async () => {
  const { withSkillPolicyRestore } = await import("../helpers/skill-policy-restore.mjs");
  const original = Object.create(null);
  const restoration = new Error("synthetic restoration failure");
  let restoreCalls = 0;

  await assert.rejects(
    withSkillPolicyRestore(
      async () => {
        throw original;
      },
      async () => {
        restoreCalls += 1;
        throw restoration;
      },
      "Synthetic exercise and restoration failed.",
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], original);
      assert.equal(error.errors[1], restoration);
      assert.match(error.message, /^Exercise: Failure details unavailable$/m);
      assert.match(error.message, /^Restoration: synthetic restoration failure$/m);
      return true;
    },
  );
  assert.equal(restoreCalls, 1);
});

test("run retains redacted Skill exercise and restoration failures within its message limit", async (t) => {
  const root = await fixture(t);
  const { statePath, resultsPath } = runnerArtifactPaths(root, "restoration");
  await writeSingleFileRunnerLane(
    root,
    "restoration",
    "tests/integration/restoration.test.mjs",
    [
      'import test from "node:test";',
      'import { execFileSync } from "node:child_process";',
      `import { withSkillPolicyRestore } from ${JSON.stringify(new URL("../helpers/skill-policy-restore.mjs", import.meta.url).href)};`,
      `import { registerQaSecret } from ${JSON.stringify(new URL("../helpers/qa-secrets.mjs", import.meta.url).href)};`,
      'registerQaSecret("fixture-private-restore-value");',
      'for (const kind of ["short", "long", "multiline", "key-tail"]) {',
      "  test(`${kind} nested failures`, async () => {",
      '    const tail = kind === "long" ? "x".repeat(20000) + "beyond-limit" : "";',
      "    const fail = async (message) => {",
      '      const key = ["-----BEGIN PRIVATE KEY-----", "synthetic-key-body-must-not-appear", "-----END PRIVATE KEY-----"].join("\\n");',
      '      if (kind === "multiline") {',
      '        execFileSync(process.execPath, ["-e", "throw new Error(process.argv[1])", `${message}\\n${key}`], { stdio: "pipe" });',
      "      }",
      '      throw new Error(kind === "key-tail" ? `${message}\\n${key.split("\\n").slice(0, -1).join("\\n")}` : message);',
      "    };",
      "    await withSkillPolicyRestore(() => withSkillPolicyRestore(",
      "      () => fail(`original operation failed ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL} ${tail}`),",
      "      () => fail(`enabled restoration failed fixture-private-restore-value ${tail}`),",
      '      "Denied node-write test failed and enabled Skill policy restoration failed."),',
      "      () => fail(`original policy restoration failed password=synthetic-restore-value ${tail}`),",
      '      "Skill source lifecycle failed and original Skill policy restoration failed.");',
      "  });",
      "}",
      "",
    ].join("\n"),
  );

  // Run the real helper through Node's serialization, the unchanged reporter, and both outputs.
  const result = run(root, laneArgs(root, "restoration", statePath, resultsPath));
  assert.equal(result.status, 1, result.stderr);
  const summaryText = await readFile(resultsPath, "utf8");
  const detailText = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const summary = JSON.parse(summaryText);
  const details = JSON.parse(detailText).failures[0].tests;
  for (const name of [
    "short nested failures",
    "long nested failures",
    "multiline nested failures",
    "key-tail nested failures",
  ]) {
    const failure = summary.files[0].tests.find((entry) => entry.name === name);
    const detail = details.find((entry) => entry.name === name);
    for (const message of [failure.error.message, detail.message]) {
      assert.match(message, /original operation failed/);
      assert.match(message, /enabled restoration failed/);
      assert.match(message, /original policy restoration failed password=\[redacted\]/);
      assert.ok(message.length <= 600);
      if (name === "multiline nested failures") {
        assert.equal(message.match(/Node\.js v/g).length, 3);
      }
    }
  }
  assert.match(result.stderr, /original operation failed/);
  assert.match(result.stderr, /enabled restoration failed/);
  assert.match(result.stderr, /original policy restoration failed password=\[redacted\]/);
  assert.doesNotMatch(
    `${summaryText}\n${detailText}\n${result.stdout}\n${result.stderr}`,
    /secretauthvalue|fixture-private-restore-value|synthetic-restore-value|synthetic-key-body-must-not-appear|beyond-limit/,
  );
});

test("finite conversation failures retain safe stages through the reporter", async (t) => {
  const root = await fixture(t);
  const { statePath, resultsPath } = runnerArtifactPaths(root, "conversation");
  const fixtureUrl = new URL("../fixtures/ci-runner-finite-conversation.ts", import.meta.url).href;
  // Scripted command responses exercise the real diagnostic producer and Gateway reader.
  await writeSingleFileRunnerLane(
    root,
    "conversation",
    "tests/integration/conversation.test.mjs",
    `import { registerFiniteConversationTests } from ${JSON.stringify(fixtureUrl)};
await registerFiniteConversationTests();
`,
  );
  const result = run(root, laneArgs(root, "conversation", statePath, resultsPath));
  assert.equal(result.status, 1, result.stderr);
  const summaryText = await readFile(resultsPath, "utf8");
  const detailText = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const { tests } = JSON.parse(summaryText).files[0];
  const { tests: details, omittedTests } = JSON.parse(detailText).failures[0];
  assert.equal(details.length, 20);
  // Keep both leading Gateway observations and private readback failures inside the cap.
  for (const name of [
    "empty Gateway logs",
    "unrecognized Gateway failure",
    "read command",
    "read transcript",
  ]) {
    assert.ok(
      details.some((entry) => entry.name === name),
      `Missing retained detail: ${name}`,
    );
  }
  assert.equal(omittedTests, 28);
  assert.equal(tests.length, 50);
  const names = tests.map(({ name }) => name);
  assert.equal(new Set(names).size, 50, "all 50 synthetic conversation case names must be unique");
  assert.deepEqual(
    names,
    finiteConversationScenarios.map(({ name }) => name),
    "synthetic conversation cases must appear in registration order",
  );
  let failures = 0;
  for (const [index, { name, expected }] of finiteConversationScenarios.entries()) {
    const observed = tests[index];
    assert.equal(observed.status, expected.status);
    if (expected.status === "passed") {
      continue;
    }
    const message = `Finite Git conversation verification failed (${expected.detail}).`;
    assert.equal(observed.error.message, message);
    const retained = details.find((entry) => entry.name === name);
    if (++failures <= 20) {
      assert.equal(retained.message, message);
    } else {
      assert.equal(retained, undefined);
    }
  }
  assert.doesNotMatch(
    `${summaryText}\n${detailText}\n${result.stdout}\n${result.stderr}`,
    /private-command-/,
  );
});

test("the reporter sends interrupted tests and the output tail, newest first, on a timeout", async () => {
  const { default: reporter } = await import("../../scripts/ci/reporter.mjs");
  const render = async (events) => {
    let text = "";
    for await (const chunk of reporter(events)) {
      text += chunk;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const at = (name, line, nesting = 1) => ({ name, line, column: 1, nesting, file: "/repo/a.mjs" });
  const sent = await render([
    { type: "test:dequeue", data: at("/repo/a.mjs", 1, 0) },
    { type: "test:dequeue", data: at("done", 2) },
    { type: "test:stdout", data: { file: "a.mjs", message: "early\n" } },
    { type: "test:complete", data: at("done", 2) },
    { type: "test:dequeue", data: at("hangs", 5) },
    // Two runs of a test declared in a loop share a location; one is still running.
    { type: "test:dequeue", data: at("loop", 9) },
    { type: "test:dequeue", data: at("loop", 9) },
    { type: "test:complete", data: at("loop", 9) },
    ...Array.from({ length: 450 }, (_, index) => ({
      type: "test:stdout",
      // Quotes double in JSON; batches are measured as sent.
      data: { file: "a.mjs", message: `bulk ${index} ${'"'.repeat(1_000)}\n` },
    })),
    { type: "test:stderr", data: { file: "a.mjs", message: "last words" } },
    { type: "test:interrupted", data: { tests: [at("/repo/a.mjs", 1, 0)] } },
    { type: "test:fail", data: { name: "hangs", details: { error: new Error("cancelled") } } },
  ]);
  assert.equal(sent[0].type, "test:interrupted");
  assert.deepEqual(sent[0].data.running, [
    { name: "/repo/a.mjs", line: 1, nesting: 0 },
    { name: "hangs", line: 5, nesting: 1 },
    { name: "loop", line: 9, nesting: 1 },
  ]);
  const batches = sent.filter(({ type }) => type === "test:output");
  // Small batches, newest first, each counting the lines before it; nothing is sent twice.
  assert(batches.length > 1);
  assert(batches.every(({ data }) => JSON.stringify(data).length < 40 * 1024));
  assert.equal(batches[0].data.lines.at(-1), "stderr: last words");
  const omitted = batches.map(({ data }) => data.omitted);
  assert.deepEqual(
    omitted,
    [...omitted].sort((a, b) => b - a),
  );
  assert.equal(batches.at(-1).data.omitted, 52);
  const lines = batches.reverse().flatMap(({ data }) => data.lines);
  assert.equal(lines.length, 400);
  assert.match(lines[0], /^stdout: bulk 51 "+$/);
  assert.equal(new Set(lines).size, 400);
  assert.equal(sent.at(-1).type, "test:fail");
});

waitingTest(
  "run records a timed-out file's interrupted test and output tail in the diagnostics report",
  async (t) => {
    const root = await fixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hang");
    // Holds when the file printed its last line.
    const printed = join(root, "state/hang-printed");
    await writeFile(
      join(root, "tests/integration/hang.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("passes first", () => {});',
        'test("hangs", async () => {',
        "  for (let index = 0; index < 500; index += 1) {",
        '    console.log(`bulk ${index} ${"v".repeat(2_000)}`);',
        "  }",
        "  console.log(`credential ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL}`);",
        '  console.log("Authorization: Bearer abcdefghijklmnop0123");',
        '  console.log("waiting for a reply that never comes");',
        `  writeFileSync(${JSON.stringify(printed)}, String(Date.now()));`,
        "  // Ends by itself in case the runner leaves it behind.",
        "  await new Promise((resolve) => setTimeout(resolve, 30_000));",
        "});",
        "",
      ].join("\n"),
    );
    // Node can exit mid-line after the interruption; the test runner process here
    // always does, and the runner must skip that cut line.
    const cutAtExit = join(root, "scripts/ci/cut-at-exit.cjs");
    await writeFile(
      cutAtExit,
      'if (process.execArgv.includes("--test")) process.on("exit", () => process.stdout.write(\'{"type":"test:output","data":{"lines":["cut\'));\n',
    );
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: {
        hang: {
          env: { NODE_OPTIONS: `--require=${cutAtExit}` },
          files: [{ path: "tests/integration/hang.test.mjs" }],
        },
      },
      groups: { ci: ["hang"] },
    });

    // The runner's clock stands still from the start until the file has printed everything, so its
    // timeout comes five seconds after that however long the host takes to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      laneArgs(root, "hang", statePath, resultsPath),
      { CI_RUNNER_TEST_TIMEOUT_MS: "5000" },
      { timeout: 60_000, execArgv: heldClock(started, [printed]) },
    );

    assert.equal(result.error, undefined, `the runner timed the file out: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    assert(summary.issues.some((entry) => entry.code === "test-timeout"));
    const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
    assert.doesNotMatch(text, /secretauthvalue|abcdefghijklmnop0123/);
    const [record] = JSON.parse(text).failures;
    assert.equal(record.file, "tests/integration/hang.test.mjs");
    assert.equal(record.reason, "timeout");
    assert.equal(record.timeoutMs, 5000);
    // The file ran at least its timeout, and the timeout (with its 5 s grace) ended it well before
    // its own 30 s wait did. The held clock stood still until the last line, and the runner
    // records real time, so that bound counts from then.
    const sincePrinted = Number(await readFile(printed, "utf8")) - started;
    assert(
      record.elapsedMs >= 5000 && record.elapsedMs < sincePrinted + 15_000,
      `${record.elapsedMs} ms, last line ${sincePrinted} ms in`,
    );
    assert.deepEqual(record.interruptedTests, [{ name: "hangs", line: 4 }]);
    // Up to the last 400 of 503 lines, newest last, with the usual redaction. Node
    // exits soon after the interruption, so on a slow host only the newest batches
    // arrive; the rest are counted.
    const { lines, omittedLines } = record.output;
    assert(lines.length >= 10 && lines.length <= 400, String(lines.length));
    assert.equal(lines.length + omittedLines, 503);
    assert.deepEqual(lines.slice(-3), [
      "stdout: credential [env:CI_RUNNER_FIXTURE_CREDENTIAL]",
      "[redacted credential-bearing line]",
      "stdout: waiting for a reply that never comes",
    ]);
    const bulk = lines.slice(0, -3);
    assert.deepEqual(
      bulk.map((line) => line.match(/^stdout: bulk (\d+) v+\.\.\. \[truncated\]$/u)?.[1]),
      bulk.map((_, index) => String(500 - bulk.length + index)),
    );
  },
);

test("each job attempt uploads its own diagnostics report", async () => {
  // A passing rerun must not replace a failed attempt's report. This reads the
  // composite action; it is not a GitHub Actions execution.
  const action = await readFile(
    join(repositoryRoot, ".github/actions/run-ci-lane/action.yml"),
    "utf8",
  );
  const upload = action.match(/- name: Upload cluster diagnostics\n[\s\S]*?\n {4}- /u)?.[0] ?? "";
  assert.match(
    upload,
    /\n\s+name: diagnostics-\$\{\{ inputs\.artifact-prefix \}\}-\$\{\{ inputs\.lane \}\}-attempt-\$\{\{ github\.run_attempt \}\}\n/u,
  );
});

const passingLaneFixture = 'import test from "node:test";\ntest("runs", () => {});\n';

async function writeFixtureLane(root, lane, names, source) {
  const files = names.map((name) => ({ path: `tests/integration/${name}.test.mjs` }));
  for (const { path } of files) {
    await writeFile(join(root, path), source);
  }
  await writeSingleLaneManifest(root, lane, files, { ci: [lane] });
}

waitingTest("run records a timeout that came before any test started", async (t) => {
  const root = await fixture(t);
  const { statePath, resultsPath } = runnerArtifactPaths(root, "stuck");
  await writeFixtureLane(
    root,
    "stuck",
    ["stuck"],
    'import test from "node:test";\nawait new Promise((resolve) => setTimeout(resolve, 30_000));\ntest("never registered", () => {});\n',
  );

  const result = await runAsync(root, laneArgs(root, "stuck", statePath, resultsPath), {
    CI_RUNNER_TEST_TIMEOUT_MS: "2000",
  });

  assert.equal(result.status, 1);
  const [record] = JSON.parse(await readFile(`${statePath}.diagnostics.json`, "utf8")).failures;
  assert.deepEqual(
    { ...record, capturedAt: undefined, elapsedMs: undefined },
    {
      file: "tests/integration/stuck.test.mjs",
      capturedAt: undefined,
      reason: "timeout",
      timeoutMs: 2000,
      elapsedMs: undefined,
      tests: [],
      omittedTests: 0,
      output: { lines: [], omittedLines: 0 },
    },
  );
  assert(record.elapsedMs >= 2000, String(record.elapsedMs));
});

// Finding 1209: a file hung in its teardown for 22 minutes, past the job's 25-minute timeout,
// under the 60-minute per-file timeout. GitHub cancelled the job, so the results file was never
// written and nothing named the test. The lane deadline stops the file first and names it.
waitingTest(
  "run stops a hung file at the lane deadline, names its test and starts nothing after it",
  async (t) => {
    const root = await fixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "deadline");
    const marker = join(root, "state/later-started");
    const hung = join(root, "state/teardown-hung");
    await writeFile(
      join(root, "tests/integration/teardown.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("passes first", () => {});',
        'test("hangs in its teardown", async (t) => {',
        "  // Like a worker stop that never returns; the interval keeps the file alive.",
        "  t.after(() => {",
        `    writeFileSync(${JSON.stringify(hung)}, "");`,
        "    return new Promise(() => setInterval(() => {}, 1_000));",
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "tests/integration/later.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import test from "node:test";',
        'test("would start past the deadline", () => writeFileSync(process.env.CI_RUNNER_MARKER, ""));',
        "",
      ].join("\n"),
    );
    await writeSingleLaneManifest(
      root,
      "deadline",
      [
        { path: "tests/integration/teardown.test.mjs" },
        { path: "tests/integration/later.test.mjs" },
      ],
      { ci: ["deadline"] },
    );

    // The runner's clock stops a second in until the file hangs in its teardown, so the deadline
    // comes at least two seconds after that, however long the host takes to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      laneArgs(root, "deadline", statePath, resultsPath),
      // No per-file timeout: the default (60 minutes) is far past the deadline.
      {
        CI_RUNNER_TEST_TIMEOUT_MS: "",
        CI_RUNNER_DEADLINE_MS: String(started + 3_000),
        CI_RUNNER_MARKER: marker,
      },
      // Without the deadline the runner would wait out the 60-minute default.
      { timeout: 60_000, execArgv: heldClock(started + 1_000, [hung]) },
    );

    assert.equal(result.error, undefined, `the deadline stopped the lane: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [teardown, later] = summary.files;
    assert.equal(teardown.status, "failed");
    const timeout = summary.issues.find((entry) => entry.code === "test-timeout");
    assert.equal(timeout.file, "tests/integration/teardown.test.mjs");
    assert.match(timeout.message, /cut to the lane deadline/);
    assert.match(timeout.message, /while running "hangs in its teardown"$/);
    // The job log names it too, not only the diagnostics artifact.
    assert.match(
      result.stderr,
      /run-tests: issue test-timeout tests\/integration\/teardown\.test\.mjs: .* while running "hangs in its teardown"\n/,
    );
    const [record] = JSON.parse(await readFile(`${statePath}.diagnostics.json`, "utf8")).failures;
    assert.equal(record.reason, "timeout");
    assert.equal(record.laneDeadline, true);
    assert(record.timeoutMs >= 2_000 && record.timeoutMs <= 3_000, String(record.timeoutMs));
    assert.deepEqual(record.interruptedTests, [{ name: "hangs in its teardown", line: 4 }]);
    // The serial file behind it never started.
    assert.equal(later.status, "failed");
    assert.equal(later.counts.total, 0);
    assert.deepEqual(
      later.issues.map((entry) => entry.code),
      ["lane-deadline"],
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  },
);

waitingTest("run starts no file with under a second left before the lane deadline", async (t) => {
  // Finding 1215: a file whose turn came within a second of the deadline was started and
  // stopped at once, then reported as selected-zero and a test-timeout naming no test.
  const root = await fixture(t);
  const { statePath, resultsPath } = runnerArtifactPaths(root, "near-deadline");
  const marker = join(root, "state/started");
  // The preparation returns half a second before the deadline.
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    [
      "export async function prepareFile() {",
      "  const left = Number(process.env.CI_RUNNER_DEADLINE_MS) - Date.now();",
      "  await new Promise((resolve) => setTimeout(resolve, left - 500));",
      "  return {};",
      "}",
      "",
    ].join("\n"),
  );
  await writeFixtureLane(
    root,
    "near",
    ["late"],
    [
      'import { writeFileSync } from "node:fs";',
      'import test from "node:test";',
      'writeFileSync(process.env.CI_RUNNER_MARKER, "");',
      'test("starts too late", () => new Promise((resolve) => setTimeout(resolve, 5_000)));',
      "",
    ].join("\n"),
  );

  const result = await runAsync(
    root,
    laneArgs(root, "near", statePath, resultsPath),
    { CI_RUNNER_DEADLINE_MS: String(Date.now() + 5_000), CI_RUNNER_MARKER: marker },
    { timeout: 30_000 },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  const [late] = JSON.parse(await readFile(resultsPath, "utf8")).files;
  // A loaded host can run the preparation into the deadline instead; either way, nothing starts.
  const codes = late.issues.map((entry) => entry.code);
  assert.deepEqual(
    codes,
    codes.includes("prepare-timeout") ? ["prepare-timeout"] : ["lane-deadline"],
  );
  assert.equal(late.nodeExitCode, null);
  assert.equal(late.counts.total, 0);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

waitingTest("a runner timeout while no test was running says so", async (t) => {
  // Finding 1215: a file stopped in a hook or teardown named no test, which read like a
  // reporting gap rather than where it hung.
  const root = await fixture(t);
  const { statePath, resultsPath } = runnerArtifactPaths(root, "hook");
  const inHook = join(root, "state/in-hook");
  await writeFixtureLane(
    root,
    "hook",
    ["hook"],
    [
      'import { writeFileSync } from "node:fs";',
      'import test, { after } from "node:test";',
      'test("passes", () => {});',
      "after(() => {",
      `  writeFileSync(${JSON.stringify(inHook)}, "");`,
      "  // Ends by itself in case the runner leaves it behind.",
      "  return new Promise((resolve) => setTimeout(resolve, 30_000));",
      "});",
      "",
    ].join("\n"),
  );

  // The runner's clock stands still from the start until "passes" is done and the hook has
  // started, so the timeout comes three seconds after that however long the host takes to get
  // there. The hook outlasts it.
  const started = Date.now();
  const result = await runAsync(
    root,
    laneArgs(root, "hook", statePath, resultsPath),
    { CI_RUNNER_TEST_TIMEOUT_MS: "3000" },
    { timeout: 60_000, execArgv: heldClock(started, [inHook]) },
  );

  assert.equal(result.error, undefined, `the runner timed the file out: ${result.stderr}`);
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  const timeout = summary.issues.find((entry) => entry.code === "test-timeout");
  assert.equal(
    timeout.message,
    "selected file exceeded the runner timeout (3000 ms): tests/integration/hook.test.mjs; no test was running (stopped in a hook, teardown or top-level code)",
  );
});

// Finding 1210: the lane deadline stopped only the test process. A preparation or cleanup that
// never returned (it runs in the runner itself) still ran on to the job timeout with no results.
// These fixtures hang forever, and their intervals keep the runner alive unless it gives up.
const hangForever = "new Promise(() => setInterval(() => {}, 1_000))";

const hungAndLaterFiles = ["hung", "later"];

waitingTest(
  "run gives up on a preparation still running at the lane deadline and names it",
  async (t) => {
    const root = await fixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hung-prepare");
    const preparing = join(root, "state/preparing");
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        "export async function prepareFile({ file }) {",
        "  if (file.path.endsWith('hung.test.mjs')) {",
        `    writeFileSync(${JSON.stringify(preparing)}, "");`,
        `    await ${hangForever};`,
        "  }",
        "  return {};",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixtureLane(root, "prepare", hungAndLaterFiles, passingLaneFixture);

    // The runner's clock stands still from the start until the preparation has started, so the
    // deadline comes three seconds after that however long the host takes to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      laneArgs(root, "prepare", statePath, resultsPath),
      { CI_RUNNER_DEADLINE_MS: String(started + 3_000) },
      // Without a limit the preparation would hold the runner forever.
      { timeout: 60_000, execArgv: heldClock(started, [preparing]) },
    );

    assert.equal(
      result.error,
      undefined,
      `the runner gave up on the preparation: ${result.stderr}`,
    );
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [hung, later] = summary.files;
    assert.deepEqual(
      hung.issues.map(({ code, file, step }) => ({ code, file, step })),
      [{ code: "prepare-timeout", file: "tests/integration/hung.test.mjs", step: "prepare" }],
    );
    // Its limit is what was left before the deadline when it started: all of it, as the clock
    // stood still.
    assert.equal(hung.issues[0].timeoutMs, 3_000);
    // Its tests never started. What the preparation made is left to the job's Cleanup lane step.
    assert.equal(hung.nodeExitCode, null);
    assert.equal(hung.counts.total, 0);
    assert.equal(hung.cleanup, null);
    // The file behind it starts nothing past the deadline.
    assert.deepEqual(
      later.issues.map((entry) => entry.code),
      ["lane-deadline"],
    );
    assert.match(
      result.stderr,
      /run-tests: issue prepare-timeout tests\/integration\/hung\.test\.mjs: prepareFile did not finish within \d+ ms, cut to the lane deadline/,
    );
  },
);

waitingTest(
  "run gives up on a hung cleanup after its allowance, ends its commands and starts no later file",
  async (t) => {
    const root = await fixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hung-cleanup");
    const cleaned = join(root, "state/later-cleaned");
    // The hung cleanup waits for a command that started one of its own (as `docker compose`
    // or `pnpm` would). Both record their pids, in one rename.
    const pidsPath = join(root, "state/command-pids");
    // The command starts another child while the runner is ending it: after the runner has listed
    // its processes and before it kills them (killWindow). That child records its pid too.
    const windowPath = join(root, "state/kill-window");
    const latePath = join(root, "state/late-pid");
    const commandPath = join(root, "command.cjs");
    const writeOnce = (path, value) =>
      `writeFileSync(${JSON.stringify(`${path}.partial`)}, ${value}); ` +
      `renameSync(${JSON.stringify(`${path}.partial`)}, ${JSON.stringify(path)});`;
    await writeFile(
      commandPath,
      [
        'const { spawn } = require("node:child_process");',
        'const { existsSync, renameSync, writeFileSync } = require("node:fs");',
        'const forever = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {',
        '  stdio: "ignore",',
        "});",
        "const descendant = forever();",
        writeOnce(pidsPath, 'process.pid + "\\n" + descendant.pid + "\\n"'),
        "const poll = setInterval(() => {",
        `  if (existsSync(${JSON.stringify(windowPath)})) {`,
        "    clearInterval(poll);",
        `    ${writeOnce(latePath, 'forever().pid + "\\n"')}`,
        "  }",
        "}, 10);",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
    );
    const running = (pid) => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      // A zombie (state Z) still answers kill(pid, 0), but it has exited.
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat[stat.lastIndexOf(")") + 2] !== "Z";
      } catch {
        return true;
      }
    };
    const pids = [];
    t.after(() => {
      for (const pid of pids.filter(running)) {
        process.kill(pid, "SIGKILL");
      }
    });
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      [
        'import { spawn } from "node:child_process";',
        'import { readFile, writeFile } from "node:fs/promises";',
        'import { setTimeout as delay } from "node:timers/promises";',
        "export async function prepareFile({ file }) {",
        "  if (file.path.endsWith('hung.test.mjs')) {",
        "    return {",
        "      cleanup: async () => {",
        `        spawn(process.execPath, [${JSON.stringify(commandPath)}], { stdio: "ignore" });`,
        // Hang only once both pids are on record.
        `        while (!(await readFile(${JSON.stringify(pidsPath)}, "utf8").catch(() => ""))) {`,
        "          await delay(20);",
        "        }",
        `        return ${hangForever};`,
        "      },",
        "    };",
        "  }",
        '  return { cleanup: () => writeFile(process.env.CI_RUNNER_CLEANUP_MARKER, "") };',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixtureLane(root, "cleanup", hungAndLaterFiles, passingLaneFixture);

    // The runner's clock stands still from the start until the command and its descendant are on
    // record, so the cleanup's allowance ends two seconds after that however long the host takes
    // to get there.
    const started = Date.now();
    const result = await runAsync(
      root,
      laneArgs(root, "cleanup", statePath, resultsPath),
      { CI_RUNNER_CLEANUP_TIMEOUT_MS: "2000", CI_RUNNER_CLEANUP_MARKER: cleaned },
      {
        timeout: 60_000,
        execArgv: [...heldClock(started, [pidsPath]), ...killWindow(windowPath, latePath)],
      },
    );
    pids.push(...(await readFile(pidsPath, "utf8")).split("\n").filter(Boolean).map(Number));
    const late = Number(await readFile(latePath, "utf8").catch(() => ""));
    if (late > 1) {
      pids.push(late);
    }

    assert.equal(result.error, undefined, `the runner gave up on the cleanup: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    const [hung, later] = summary.files;
    // Its tests passed; only the cleanup failed it.
    assert.equal(hung.counts.passed, 1);
    assert.equal(hung.status, "failed");
    assert.deepEqual(hung.cleanup, { status: "timeout", timeoutMs: 2000 });
    assert.deepEqual(
      hung.issues.map(({ code, step, message }) => ({ code, step, message })),
      [
        {
          code: "cleanup-timeout",
          step: "cleanup",
          message: "cleanup did not finish within 2000 ms: tests/integration/hung.test.mjs",
        },
      ],
    );
    // The abandoned cleanup may still hold the CI state lock, so the next file never starts.
    assert.deepEqual(
      later.issues.map(({ code, file }) => ({ code, file })),
      [{ code: "setup-abandoned", file: "tests/integration/later.test.mjs" }],
    );
    assert.equal(later.counts.total, 0);
    await assert.rejects(readFile(cleaned), { code: "ENOENT" });
    // The runner ended the abandoned cleanup's command and its descendants before it exited, so
    // none is left running as an orphan (finding 1225), not even the one the command started
    // after the runner had listed its processes (finding 2182).
    assert.equal(pids.length, 3, "the command recorded itself and both descendants");
    for (let attempt = 0; pids.some(running) && attempt < 50; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.deepEqual(
      pids.filter(running),
      [],
      "the abandoned cleanup's commands outlived the runner",
    );
  },
);

waitingTest(
  "run ends the cleanups of files the deadline stopped together one allowance past it",
  async (t) => {
    const root = await fixture(t);
    const { statePath, resultsPath } = runnerArtifactPaths(root, "hung-cleanups");
    const files = ["one", "two", "three", "four"].map(
      (name) => `tests/integration/${name}.test.mjs`,
    );
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      `export async function prepareFile() {\n  return { cleanup: () => ${hangForever} };\n}\n`,
    );
    const hung = files.map((file) => join(root, `state/${file.split("/").at(-1)}-hung`));
    for (const [index, file] of files.entries()) {
      await writeFile(
        join(root, file),
        [
          'import { writeFileSync } from "node:fs";',
          'import test from "node:test";',
          'test("hangs", () => {',
          `  writeFileSync(${JSON.stringify(hung[index])}, "");`,
          `  return ${hangForever};`,
          "});",
          "",
        ].join("\n"),
      );
    }
    await writeJson(join(root, "manifest.json"), {
      version: 1,
      lanes: {
        together: {
          fileConcurrency: 4,
          parallelFiles: files,
          files: files.map((path) => ({ path })),
        },
      },
      groups: { ci: ["together"] },
    });

    // The runner's clock stops a second in until all four files hang, so the deadline stops
    // them together however long the host takes to start them.
    const allowanceMs = 5_000;
    const started = Date.now();
    const result = await runAsync(
      root,
      laneArgs(root, "together", statePath, resultsPath),
      {
        CI_RUNNER_DEADLINE_MS: String(started + 3_000),
        CI_RUNNER_CLEANUP_TIMEOUT_MS: String(allowanceMs),
        CI_RUNNER_FILE_CONCURRENCY: "4",
      },
      { timeout: 60_000, execArgv: heldClock(started + 1_000, hung) },
    );

    assert.equal(result.error, undefined, `the runner gave up on the cleanups: ${result.stderr}`);
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(resultsPath, "utf8"));
    assert.deepEqual(
      summary.files.map((file) => [file.path, file.cleanup?.status]),
      files.map((file) => [file, "timeout"]),
    );
    // Cleanups run one at a time. One allowance each would end 20 s past the deadline; the window
    // they share closes one allowance past it. The first to start gets what is left of the window
    // and is still running when it closes, so the queued ones never start. (On a busy host the
    // window can close before the first one starts too.)
    const timeouts = summary.issues.filter((entry) => entry.code === "cleanup-timeout");
    assert.equal(timeouts.length, files.length);
    const ran = timeouts.filter(
      (entry) => !/window after the lane deadline closed/.test(entry.message),
    );
    assert(ran.length <= 1, JSON.stringify(timeouts));
    // It starts after its file stops, past the deadline, so it gets less than a full allowance.
    for (const entry of ran) {
      assert(entry.timeoutMs < allowanceMs, JSON.stringify(entry));
    }
  },
);

test("run keeps bounded Agent namespace activity from passing k3d files, alone and side by side", async (t) => {
  const root = await fixture(t);
  const { clusterDirectory, statePath, resultsPath, args } = await prepareK3dDiagnosticsRun(root, [
    { path: "tests/integration/agent.test.mjs", expectedTests: ["agent file passes"] },
  ]);
  // This kubectl stand-in serves the raw watch streams a live API server would
  // send while the test file creates and deletes its Agent namespace.
  const pod = (ready, type) => ({
    type,
    object: {
      kind: "Pod",
      metadata: {
        namespace: "occ-agent-a",
        name: "harness-0",
        creationTimestamp: "2026-09-29T00:00:00Z",
      },
      spec: {
        nodeName: "server-0",
        containers: [{ name: "harness", env: [{ name: "TOKEN", value: "do-not-publish-env" }] }],
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: ready ? "True" : "False", lastTransitionTime: "t" }],
        containerStatuses: [{ name: "harness", ready, restartCount: 0 }],
      },
    },
  });
  const event = (namespace, uid, reason, message, count = 1) => ({
    type: "ADDED",
    object: {
      metadata: { namespace, name: `${uid}.event`, uid },
      involvedObject: { kind: "Pod", name: "harness-0", namespace },
      type: "Normal",
      reason,
      message,
      count,
      firstTimestamp: "2026-09-29T00:00:01Z",
      lastTimestamp: `2026-09-29T00:10:0${count}Z`,
    },
  });
  const pods = [
    pod(false, "ADDED"),
    pod(false, "MODIFIED"),
    pod(true, "MODIFIED"),
    pod(true, "DELETED"),
  ];
  const boundary = mixedPrecisionEventBoundary({
    namespace: "occ-agent-a",
    pod: "harness-0",
    second: "2026-09-29T00:00:10",
    laterCount: 196,
  });
  const repeatedSeries = {
    metadata: {
      namespace: "occ-agent-a",
      name: "repeated-series.event",
      uid: "repeated-series",
    },
    involvedObject: { kind: "Pod", name: "harness-0", namespace: "occ-agent-a" },
    type: "Warning",
    reason: "RepeatedSeries",
    message: "Repeated event",
    eventTime: "2026-09-29T00:00:01Z",
    series: { count: 7, lastObservedTime: "2026-09-29T00:20:00Z" },
  };
  const events = [
    { type: "ADDED", object: repeatedSeries },
    ...boundary.events.map((object) => ({ type: "ADDED", object })),
    event("occ-agent-a", "e1", "Pulled", "Successfully pulled image"),
    event("occ-agent-a", "e2", "Unhealthy", "Readiness probe failed"),
    event("occ-agent-a", "e2", "Unhealthy", "Readiness probe failed", 3),
    event("occ-agent-a", "e3", "Failed", "bearer do-not-publish-event"),
    event("kube-system", "e4", "Started", "unrelated system event"),
  ];
  const kubectl = await writeK3dKubectl(root, { kind: "watch", pods, events });
  const watchCase = {
    kind: "watch",
    clusterDirectory,
    captureBarrierDirectory: join(root, "state"),
    podRecords: pods.length,
    eventRecords: events.length,
  };
  await writeK3dChildTest(join(root, "tests/integration/agent.test.mjs"), {
    ...watchCase,
    name: "agent file passes",
    id: "agent",
  });

  const result = run(root, args, {
    OCC_KUBECTL_BIN: kubectl,
    CI_RUNNER_TEST_CAPTURE_BARRIER: "single",
    CI_RUNNER_TEST_EXPECTED_CAPTURES: "1",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(resultsPath, "utf8")).status, "passed");
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const report = JSON.parse(text);
  assert.equal(report.lane, "k3d-lane");
  assert.equal(report.agentNamespaces.length, 1);
  const [activity] = report.agentNamespaces;
  assert.equal(activity.file, "tests/integration/agent.test.mjs");
  assert.equal(activity.cluster, "owned-cluster");
  assert.deepEqual(activity.namespaces, ["occ-agent-a"]);
  // Unchanged watch records collapse; readiness and deletion transitions remain.
  assert.deepEqual(
    activity.pods.map(({ watch, containers }) => [watch, containers[0].ready]),
    [
      ["ADDED", false],
      ["MODIFIED", true],
      ["DELETED", true],
    ],
  );
  assert.equal(activity.events.length, 200);
  assert.equal(activity.events[0].reason, boundary.events[2].reason);
  assert.equal(
    activity.events.some(({ reason }) => reason === boundary.older.reason),
    false,
  );
  assert.equal(
    activity.events.some(({ reason }) => reason === boundary.newer.reason),
    false,
  );
  assert.equal(activity.omitted.events, 2);
  assert.deepEqual(
    activity.events.slice(-4).map(({ reason, count }) => [reason, count]),
    [
      ["Pulled", 1],
      ["Failed", 1],
      ["Unhealthy", 3],
      ["RepeatedSeries", 7],
    ],
  );
  assert.equal(activity.events.at(-1).lastTimestamp, repeatedSeries.series.lastObservedTime);
  assert.doesNotMatch(text, /do-not-publish|unrelated system event/);
  // Raw watch streams hold full Pod specs; only the projection survives.
  assert.deepEqual(await readdir(clusterDirectory), []);

  // Two files sharing the runner under fileConcurrency watch the same cluster at once. Each
  // keeps its own watch streams, so neither truncates nor deletes the other's capture.
  await writeK3dChildTest(join(root, "tests/integration/agent-sibling.test.mjs"), {
    ...watchCase,
    name: "sibling file passes",
    id: "sibling",
  });
  const pairFiles = [
    "tests/integration/agent.test.mjs",
    "tests/integration/agent-sibling.test.mjs",
  ];
  await writeJson(join(root, "scripts/ci/pair-suites.json"), {
    version: 1,
    lanes: {
      "k3d-pair": {
        fileConcurrency: 2,
        parallelFiles: pairFiles,
        files: [
          { path: pairFiles[0], expectedTests: ["agent file passes"] },
          { path: pairFiles[1], expectedTests: ["sibling file passes"] },
        ],
      },
    },
    groups: {},
  });
  const pairStatePath = join(root, "state/k3d-pair.json");
  await writeJson(pairStatePath, {
    lane: "k3d-pair",
    prefix: "openclaw-ci-k3d-pair-23456789abcd",
    resources: JSON.parse(await readFile(statePath, "utf8")).resources,
  });
  const pairResultsPath = join(root, "results/k3d-pair.json");
  const pair = run(
    root,
    [
      "run",
      "k3d-pair",
      "--manifest",
      join(root, "scripts/ci/pair-suites.json"),
      "--root",
      root,
      "--state",
      pairStatePath,
      "--results",
      pairResultsPath,
    ],
    {
      OCC_KUBECTL_BIN: kubectl,
      CI_RUNNER_FILE_CONCURRENCY: "2",
      CI_RUNNER_TEST_CAPTURE_BARRIER: "pair",
      CI_RUNNER_TEST_EXPECTED_CAPTURES: "2",
    },
  );
  assert.equal(pair.status, 0, pair.stderr);
  const pairSummary = JSON.parse(await readFile(pairResultsPath, "utf8"));
  assert.deepEqual(
    pairSummary.files.map(({ mode }) => mode),
    ["parallel", "parallel"],
  );
  const pairText = await readFile(`${pairStatePath}.diagnostics.json`, "utf8");
  const pairReport = JSON.parse(pairText);
  const captureFields = ({ cluster, namespaces, pods, events, omitted }) => ({
    cluster,
    namespaces,
    pods: pods.map(({ watch, containers }) => [watch, containers[0].ready]),
    events: events.map(({ reason, count, lastTimestamp }) => [reason, count, lastTimestamp]),
    omittedEvents: omitted.events,
  });
  // Files can finish in either order. Each file must retain its own complete capture.
  const captures = pairReport.agentNamespaces.toSorted(({ file: left }, { file: right }) =>
    left.localeCompare(right),
  );
  assert.deepEqual(
    captures.map(({ file }) => file),
    pairFiles.toSorted((left, right) => left.localeCompare(right)),
  );
  const singleCapture = captureFields(activity);
  for (const capture of captures) {
    assert.deepEqual(
      captureFields(capture),
      singleCapture,
      `parallel capture for ${capture.file} matches the single-file capture`,
    );
  }
  assert.doesNotMatch(pairText, /do-not-publish|unrelated system event/);
  assert.deepEqual(await readdir(clusterDirectory), []);

  // A second cluster whose directory is gone fails the capture after the first cluster's
  // watches started. The file still runs, and those watches are stopped: left running,
  // their child processes would hold the runner until the watch timeout.
  const brokenStatePath = join(root, "state/k3d-broken.json");
  await writeJson(brokenStatePath, {
    lane: "k3d-lane",
    prefix: "openclaw-ci-k3d-lane-3456789abcde",
    resources: [
      ...JSON.parse(await readFile(statePath, "utf8")).resources,
      {
        kind: "k3d-cluster",
        status: "ready",
        name: "removed-cluster",
        directory: join(root, "removed-cluster"),
        kubeconfig: join(root, "removed-cluster/kubeconfig"),
        context: "k3d-removed-cluster",
      },
    ],
  });
  const broken = spawnSync(
    process.execPath,
    [
      runnerPath,
      "run",
      "k3d-lane",
      "--manifest",
      join(root, "scripts/ci/suites.json"),
      "--root",
      root,
      "--state",
      brokenStatePath,
      "--results",
      join(root, "results/k3d-broken.json"),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...fixtureGitEnv,
        GITHUB_SHA: currentSha(),
        OCC_KUBECTL_BIN: kubectl,
      },
      timeout: 30_000,
    },
  );
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(
    broken.stderr,
    /Agent namespace activity unavailable for tests\/integration\/agent\.test\.mjs/,
  );
  assert.deepEqual(await readdir(clusterDirectory), []);
});

test("k3d diagnostics preserve equal-instant event order across precision variants", async () => {
  const { projectContainerLog } = await import("../../scripts/ci/k3d-diagnostics.mjs");
  const { older, newer } = mixedPrecisionEventBoundary({
    namespace: "occ-agent-a",
    pod: "harness-0",
    second: "2026-10-21T00:00:00",
    laterCount: 0,
  });
  const projected = projectContainerLog({
    lines: [],
    snapshots: [
      {
        events: [
          older,
          {
            ...older,
            metadata: { ...older.metadata, uid: "equal-fractional" },
            reason: "EqualFractional",
            eventTime: "2026-10-21T00:00:00.000000Z",
            lastTimestamp: undefined,
          },
          newer,
        ],
      },
      {
        events: [
          {
            metadata: { namespace: "occ-agent-a", uid: "repeated-series" },
            involvedObject: { kind: "Pod", name: "harness-0", namespace: "occ-agent-a" },
            type: "Warning",
            reason: "RepeatedSeries",
            message: "Repeated event",
            eventTime: "2026-10-21T00:00:01Z",
            series: { count: 7, lastObservedTime: "2026-10-21T00:10:00Z" },
          },
          ...Array.from({ length: 200 }, (_, index) => ({
            metadata: { namespace: "occ-agent-a", uid: `intervening-${index}` },
            involvedObject: { kind: "Pod", name: "harness-0", namespace: "occ-agent-a" },
            type: "Normal",
            reason: `Intervening${index}`,
            message: "Intervening event",
            count: 1,
            eventTime: new Date(
              Date.parse("2026-10-21T00:00:01Z") + (index + 1) * 1_000,
            ).toISOString(),
          })),
        ],
      },
    ],
  });
  assert.deepEqual(
    projected.snapshots[0].events.map(({ reason }) => reason),
    [older.reason, "EqualFractional", newer.reason],
  );
  assert.deepEqual(projected.snapshots[1].events.at(-1), {
    namespace: "occ-agent-a",
    kind: "Pod",
    name: "harness-0",
    type: "Warning",
    reason: "RepeatedSeries",
    message: "Repeated event",
    count: 7,
    firstTimestamp: "2026-10-21T00:00:01Z",
    lastTimestamp: "2026-10-21T00:10:00Z",
  });
});

test("first-Agent scenario ownership drains child work before teardown after failure or cancellation", async (t) => {
  for (const mode of ["failure", "cancel"]) {
    const root = await fixture(t);
    const trace = join(root, "trace");
    const file = join(root, "scenario.test.mjs");
    const owner = pathToFileURL(
      join(repositoryRoot, "tests/helpers/local-first-agent-stack.mjs"),
    ).href;
    await writeFile(
      file,
      `
import test from 'node:test';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { ownFirstAgentWork } from ${JSON.stringify(owner)};
const controller = new AbortController();
test('scenario', { signal: controller.signal }, async (t) => {
  const own = ownFirstAgentWork(t);
  t.after(() => appendFileSync(${JSON.stringify(trace)}, 'cleanup|'));
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  t.test('native', { signal: t.signal }, (native) => own(new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50)); console.log('ready'); setTimeout(() => process.exit(0), 300);"], { stdio: ['ignore', 'pipe', 'ignore'] });
    native.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    child.stdout.once('data', ready);
    child.once('error', reject);
    child.once('close', () => { appendFileSync(${JSON.stringify(trace)}, 'settled|'); resolve(); });
  })));
  await started;
  if (${JSON.stringify(mode)} === 'cancel') { controller.abort(); }
  else { throw new Error('scenario-failed'); }
});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const result = spawnSync(process.execPath, ["--test", file], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(await readFile(trace, "utf8"), "settled|cleanup|", mode);
  }
});

test("run records only allowlisted measurements from test diagnostics", async (t) => {
  const root = await fixture(t);
  const resultsPath = join(root, "results/measurements.json");
  const measurement = (value) => `openclaw-ci-measurement ${JSON.stringify(value)}`;
  const openshellPhase = {
    kind: "openshell-sandbox-phase",
    stage: "exposure-auth",
    outcome: "passed",
    elapsedMs: 39_000,
  };
  // These receipts travel through the real reporter and runner into the uploaded
  // result, including after a later failure. Unknown text must never reach a tail.
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const sha256 = "a".repeat(64);
  const opaque = "supplier-instance-123";
  const opaqueHash = createHash("sha256").update(opaque).digest("hex");
  const time = "2026-11-05T12:00:00.123456789Z";
  const retentionKind = "openshell-git-retention";
  const forbidden = "unregistered-retention-private-text";
  const runtimeReceipt = {
    revisionId: opaque,
    sandboxId: opaque,
    sandboxUid: uuid,
    podUid: uuid,
    mainProcessInstanceId: opaque,
    mainProcessStartedAt: time,
    containers: [
      {
        name: opaque,
        id: opaque,
        imageId: `containerd://sha256:${sha256}`,
        startedAt: time,
        restartCount: 0,
        output: forbidden,
      },
    ],
    credential: forbidden,
  };
  const launchReceipt = {
    workspace: opaque,
    sandboxId: opaque,
    requestId: uuid,
    executionSeconds: 120,
    observerMs: 180_000,
  };
  const expiryObservation = {
    event: "worker.openshell-git-expiry",
    workerUid: uuid,
    namespaceMatches: true,
    repository: "match",
    outcome: "pending",
    check: "retained-provider-profiles",
    failure: "gateway_unavailable",
    rawLog: forbidden,
  };
  const expiryDiagnostic = {
    event: "git-expiry-unconfirmed",
    namespaceId: opaque,
    agentId: opaque,
    revisionId: opaque,
    repositoryRef: opaque,
    lastWorkerUid: uuid,
    polls: 4,
    workerReadFailures: 0,
    noReadyWorkerPolls: 1,
    logReads: 3,
    logReadSuccesses: 2,
    logReadFailures: 1,
    linesRead: 2005,
    parsedEvents: 2002,
    parseFailures: 3,
    tailLimitReads: 1,
    workerChanges: 1,
    matchingEventReads: 5,
    rejectedEventReads: 1,
    driverSuccessSeen: true,
    workerAcknowledgementSeen: false,
    observationsTruncated: true,
    observations: [
      expiryObservation,
      {
        ...expiryObservation,
        namespaceMatches: false,
        repository: "mismatch",
        outcome: "retire-runtime",
        failure: "failed",
        grpcStatus: 10,
      },
      {
        ...expiryObservation,
        outcome: "withdrawn",
        check: "record-reduced-generation",
      },
      {
        event: "worker.completed",
        workerUid: uuid,
        namespaceMatches: true,
        repository: "absent",
        outcome: "success",
        code: "REPOSITORY_RUNTIME_RETIREMENT_QUEUED",
        error: forbidden,
      },
      {
        event: "worker.completed",
        workerUid: uuid,
        namespaceMatches: true,
        repository: "absent",
        outcome: "pending",
        code: forbidden,
      },
      {
        event: "worker.repository-cleanup-warning",
        workerUid: uuid,
        namespaceMatches: true,
        repository: "absent",
        code: "REPOSITORY_CLEANUP_STALLED",
        cause: forbidden,
      },
    ],
  };
  // The live observer uses this same projection before retaining or emitting a
  // record. Malicious fields must disappear there, not just in the reporter.
  const { projectOpenShellGitExpiryObservation, projectOpenShellGitMaintenanceCompletion } =
    await import("../../scripts/ci/openshell-git-retention.mjs");
  assert.deepEqual(
    projectOpenShellGitMaintenanceCompletion({
      outcome: forbidden,
      code: forbidden,
      failure: forbidden,
      error: forbidden,
    }),
    { outcome: "unrecognized", code: "unrecognized", failure: "UNRECOGNIZED" },
  );
  const captured = expiryDiagnostic.observations.map(projectOpenShellGitExpiryObservation);
  assert.ok(!JSON.stringify(captured).includes(forbidden));
  assert.equal(captured[1].failure, "failed");
  assert.equal(captured[1].grpcStatus, 10);
  for (const failure of [
    "launch_sandbox_missing",
    "launch_workload_unconfirmed",
    "launch_contract_mismatch",
    "launch_fingerprint_mismatch",
  ]) {
    assert.equal(
      projectOpenShellGitExpiryObservation({
        ...expiryObservation,
        outcome: "retire-runtime",
        check: "original-launch-and-pods",
        failure,
      })?.failure,
      failure,
    );
  }
  for (const grpcStatus of [-1, 0, 17, 1.5, "10", forbidden]) {
    assert.equal(
      projectOpenShellGitExpiryObservation({ ...expiryObservation, grpcStatus }),
      undefined,
    );
  }
  assert.equal(captured[4].code, "unrecognized");
  assert.equal(captured[5].cause, "unrecognized");
  for (const field of [
    "outcome",
    "check",
    "failure",
    "workerUid",
    "namespaceMatches",
    "repository",
  ]) {
    assert.equal(
      projectOpenShellGitExpiryObservation({ ...expiryObservation, [field]: forbidden }),
      undefined,
    );
  }
  const retainedFailures = ["after-expiry", "after-worker-restart"].map((stage, index) => ({
    event: "retained-execution-failed",
    stage,
    connectionsBefore: 2,
    connectionsAfter: 2 + index,
    requestsBefore: 1,
    requestsAfter: 1 + index,
    originUnchanged: index === 0,
  }));
  const withdrawalWitnesses = [
    ["live witness before denial", "accepted", 200],
    ["live witness after denial", "refused", 401],
    ["replacement witness before denial", "refused", 403],
    ["replacement witness after denial", "unconfirmed", null],
  ].map(([stage, outcome, status], index) => ({
    event: "withdrawal-origin-witness",
    stage,
    outcome,
    status,
    targetedRetirementRefusals: index,
  }));
  const withdrawalDecision = {
    event: "withdrawal-decision-unconfirmed",
    mode: "live",
    workerReady: true,
    workerComparison: "unchecked",
    freshRequests: 2,
    logReads: 3,
    logReadSuccesses: 2,
    logReadFailures: 1,
    linesRead: 2004,
    parsedEvents: 2000,
    parseFailures: 4,
    tailLimitReads: 1,
    candidates: 5,
    rejectedCode: 1,
    rejectedReason: 1,
    rejectedOperation: 1,
    rejectedRequestId: 0,
  };
  const withdrawalRetirement = {
    event: "withdrawal-retirement-refused",
    outcome: "passed",
    status: 503,
    targetedRetirementRefusals: 1,
  };
  const policyDenials = ["after-expiry", "after-worker-restart", "after-removal"].map((stage) => ({
    event: "git-policy-denied",
    stage,
    reason: "transparent_tcp_policy_denied",
    policyReason: "endpoint-not-admitted",
    marker: "policy-dns-ineligible",
    host: "github.com",
    port: 443,
    executable: "/usr/lib/git-core/git-remote-http",
    count: 1,
    startedAt: 1_800_000_000_000,
    endedAt: 1_800_000_001_000,
  }));
  const maintenanceDiagnostic = {
    event: "worker-maintenance-unconfirmed",
    reason: "own-budget-exhausted",
    logReads: 3,
    logReadSuccesses: 2,
    logReadFailures: 1,
    linesRead: 2004,
    parsedEvents: 2000,
    parseFailures: 4,
    tailLimitReads: 1,
    completionsTruncated: false,
    completions: [
      { outcome: "pending", code: "REPOSITORY_CLEANUP_PENDING", error: forbidden },
      { outcome: "retry", code: forbidden, failure: forbidden },
      { outcome: "permanent", code: "REPOSITORY_ACCESS_WITHDRAWN" },
      // Ordinary revision readiness must remain distinguishable from Git cleanup.
      { outcome: "pending", code: "REPOSITORY_GIT_ROUTE_PENDING" },
      { outcome: "pending", code: "REPOSITORY_GIT_MATERIAL_PENDING" },
      { outcome: "pending", code: "WORKSPACE_NODE_PENDING" },
      { outcome: "pending", code: "WORKSPACE_NODE_BINDING_PENDING" },
      { outcome: "pending", code: "WORKSPACE_NODE_RECONNECT_PENDING" },
      { outcome: "pending", code: "WORKSPACE_SETUP_RETRYING" },
      // Keep the optional runtime failure separate from the maintenance wait code.
      {
        outcome: "pending",
        code: "REVISION_INCOMPLETE",
        failure: "REPOSITORY_ROUTE_BLOCKED",
      },
      {
        outcome: "pending",
        code: "REVISION_FINALIZATION_INCOMPLETE",
        failure: "MODEL_PROBE_FAILED",
      },
      {
        outcome: "pending",
        code: `REPOSITORY_GIT_ROUTE_PENDING_${forbidden}`,
        failure: { code: "REPOSITORY_ROUTE_BLOCKED", message: forbidden },
      },
    ],
    error: forbidden,
  };
  const maintenanceReasons = [
    "permanent",
    "read-failure",
    "cancelled",
    "own-budget-exhausted",
    "unrecognized",
  ];
  const restartStages = [
    "controller-image",
    "ready-worker",
    "before-worker-image",
    "durable-before",
    "rollout-restart",
    "rollout-ready",
    "replacement-worker",
    "after-worker-image",
    "revision-maintenance",
    "durable-after",
    "durable-retention-assertion",
  ];
  const finiteRemoval = [
    {
      event: "finite-removal-live-denial",
      boundary: "signed-access-withdrawn",
      signer: "exercised",
      requestId: opaque,
      workerUid: uuid,
    },
    {
      event: "finite-removal-live-denial",
      boundary: "supervisor-policy",
      signer: "unexercised",
      requestId: null,
      workerUid: uuid,
    },
    {
      event: "finite-removal-reduced",
      revisionId: opaque,
      workId: opaque,
      workerUid: uuid,
      code: "REPOSITORY_ACCESS_WITHDRAWN",
      sessionId: opaque,
      processInstanceId: opaque,
      networkInstanceId: opaque,
      attachmentEpoch: opaque,
      providerEnvRevision: "3",
      configRevision: "4",
      policyHash: sha256,
    },
    {
      event: "finite-removal-conversation",
      stage: "after-replacement",
      revisionId: opaque,
      sessionId: opaque,
      threadId: opaque,
      userSeq: 10,
      assistantSeq: 11,
    },
    {
      event: "finite-removal-retired",
      revisionId: opaque,
      cause: "required-model-withdrawn",
      deadlineWallMs: 1800000000000,
      observedAt: 1799999999000,
      activeRevisionCleared: true,
      sandboxAbsent: true,
      agentPodsAbsent: true,
    },
  ];
  const workerRestart = {
    event: "worker-restarted",
    beforeUid: "12345678-1234-1234-1234-123456789001",
    afterUid: "12345678-1234-1234-1234-123456789002",
    controllerImageDigest: `sha256:${sha256}`,
    controllerConfigDigest: `sha256:${"b".repeat(64)}`,
    beforeImageDigest: `sha256:${"b".repeat(64)}`,
    afterImageDigest: `sha256:${sha256}`,
    databaseUid: "12345678-1234-1234-1234-123456789003",
    custodyUid: "12345678-1234-1234-1234-123456789004",
    custodyVersion: "234",
  };
  const retentionReceipts = [
    ...finiteRemoval.map((receipt) => ({ ...receipt, credential: forbidden, output: forbidden })),
    ...withdrawalWitnesses.map((receipt) => ({ ...receipt, error: forbidden, token: forbidden })),
    { ...withdrawalRetirement, token: forbidden },
    ...["unchecked", "same", "different"].map((workerComparison) => ({
      ...withdrawalDecision,
      workerComparison,
      requestIds: [forbidden],
      error: forbidden,
    })),
    ...maintenanceReasons.map((reason) => ({ ...maintenanceDiagnostic, reason })),
    ...restartStages.map((stage) => ({
      event: "worker-restart-unconfirmed",
      stage,
      error: forbidden,
    })),
    ...policyDenials.map((receipt) => ({ ...receipt, message: forbidden, credential: forbidden })),
    ...retainedFailures.map((receipt) => ({
      ...receipt,
      credential: forbidden,
      stdout: forbidden,
      stderr: forbidden,
    })),
    expiryDiagnostic,
    {
      event: "supervisor-trust",
      parent: `ghcr.io/example/stock@sha256:${sha256}`,
      reference: `docker.io/library/test@sha256:${sha256}`,
      binaryHash: sha256,
      configDigest: `sha256:${sha256}`,
    },
    { event: "finite-git-grant", revisionId: opaque, deadlineWallMs: 1_800_000_000_000 },
    { event: "initial-runtime", ...runtimeReceipt },
    {
      event: "installed-supervisor",
      sandboxId: opaque,
      workloadPodUid: uuid,
      supervisorPodUid: uuid,
      image: `docker.io/library/test@sha256:${sha256}`,
      imageId: `containerd://sha256:${sha256}`,
      containerId: opaque,
      binaryHash: sha256,
    },
    ...["before-expiry", "after-expiry", "after-worker-restart"].map((stage) => ({
      event: "model-turn-succeeded",
      stage,
      nonce: `FIRST_AGENT_${uuid}`,
    })),
    {
      event: "initial-git-succeeded",
      revisionId: opaque,
      sha: "b".repeat(40),
      connections: 2,
      requests: 1,
    },
    {
      event: "git-expiry-observed",
      deadlineWallMs: 1_800_000_000_000,
      workId: opaque,
      code: "REPOSITORY_ACCESS_WITHDRAWN",
      workerUid: uuid,
      expiry: {
        event: "worker.openshell-git-expiry",
        namespaceId: opaque,
        agentId: opaque,
        revisionId: opaque,
        repositoryRef: opaque,
        outcome: "withdrawn",
        check: "record-reduced-generation",
        output: forbidden,
      },
    },
    workerRestart,
    ...["after-expiry", "after-worker-restart"].map((event) => ({
      event,
      ...runtimeReceipt,
      nonGit: "succeeded",
      freshGit: "transparent-policy-denied",
      connections: 2,
      requests: 1,
    })),
    { event: "managed-workload-exec-dispatch-unknown", ...launchReceipt },
    {
      event: "managed-workload-exec-result",
      ...launchReceipt,
      outcome: "terminal-exit",
      exitCode: 0,
      grpcStatus: 0,
      stdoutBytes: 12,
      stderrBytes: 0,
    },
    {
      event: "managed-workload-exec-unconfirmed",
      ...launchReceipt,
      grpcStatus: "unknown",
      reason: "stream-failure",
    },
    { event: "cleanup", outcome: "passed" },
  ].map((value) => ({ kind: retentionKind, ...value, unexpected: forbidden }));
  const invalidRetention = [
    ...[
      "controllerImageDigest",
      "controllerConfigDigest",
      "beforeImageDigest",
      "afterImageDigest",
    ].flatMap((field) =>
      [forbidden, undefined].map((value) => ({
        ...workerRestart,
        [field]: value,
        unexpected: forbidden,
      })),
    ),
    { ...finiteRemoval[0], signer: "unexercised" },
    { ...finiteRemoval[0], requestId: null },
    { ...finiteRemoval[1], requestId: opaque },
    { ...finiteRemoval[2], code: "REPOSITORY_RUNTIME_RETIREMENT_QUEUED" },
    { ...finiteRemoval[2], policyHash: forbidden },
    { ...finiteRemoval[3], assistantSeq: 10 },
    { ...finiteRemoval[4], observedAt: 1800000000000 },
    { ...finiteRemoval[4], sandboxAbsent: false },
    ...["stage", "outcome", "status", "targetedRetirementRefusals"].map((field) => ({
      ...withdrawalWitnesses[0],
      [field]: forbidden,
    })),
    { ...withdrawalWitnesses[0], targetedRetirementRefusals: -1 },
    ...[
      ["accepted", 401],
      ["accepted", 403],
      ["accepted", null],
      ["refused", 200],
      ["refused", null],
      ["unconfirmed", 200],
      ["unconfirmed", 401],
      ["unconfirmed", 403],
    ].map(([outcome, status]) => ({ ...withdrawalWitnesses[0], outcome, status })),
    { ...withdrawalRetirement, status: 204 },
    { ...withdrawalDecision, mode: forbidden },
    { ...withdrawalDecision, freshRequests: -1 },
    { ...withdrawalDecision, workerComparison: forbidden },
    { ...withdrawalDecision, workerComparison: true },
    ...[0, 2].map((targetedRetirementRefusals) => ({
      ...withdrawalRetirement,
      targetedRetirementRefusals,
    })),
    { ...withdrawalRetirement, outcome: forbidden },
    { ...withdrawalRetirement, targetedRetirementRefusals: forbidden },
    ...[
      ["stage", "before-expiry"],
      ["reason", "transparent_tcp_identity_unavailable"],
      ["policyReason", forbidden],
      ["marker", forbidden],
      ["host", forbidden],
      ["port", 80],
      ["executable", forbidden],
      ["count", 0],
      ["count", 2001],
      ["count", { toString: 0, credential: forbidden }],
      ["startedAt", forbidden],
      ["endedAt", -1],
    ].map(([field, value]) => ({ ...policyDenials[0], [field]: value })),
    ...[
      ["stage", "before-expiry"],
      ["stage", forbidden],
      ["connectionsBefore", forbidden],
      ["connectionsAfter", -1],
      ["requestsBefore", 0.5],
      ["requestsAfter", Number.MAX_SAFE_INTEGER + 1],
      ["originUnchanged", forbidden],
    ].map(([field, value]) => ({ ...retainedFailures[0], [field]: value })),
    { ...expiryDiagnostic, polls: -1 },
    { ...expiryDiagnostic, logReadSuccesses: 0.5 },
    { ...expiryDiagnostic, driverSuccessSeen: forbidden },
    { ...expiryDiagnostic, lastWorkerUid: forbidden },
    { ...expiryDiagnostic, observations: Array(17).fill(expiryObservation) },
    {
      ...expiryDiagnostic,
      observations: [{ ...expiryObservation, check: forbidden }],
    },
    {
      ...expiryDiagnostic,
      observations: [{ ...expiryObservation, failure: forbidden }],
    },
    { event: forbidden },
    { event: "initial-runtime", ...runtimeReceipt, podUid: forbidden },
    {
      event: "initial-runtime",
      ...runtimeReceipt,
      containers: [{ ...runtimeReceipt.containers[0], imageId: forbidden }],
    },
    {
      event: "initial-runtime",
      ...runtimeReceipt,
      containers: Array(17).fill(runtimeReceipt.containers[0]),
    },
    { event: "finite-git-grant", revisionId: opaque, deadlineWallMs: -1 },
    { event: "model-turn-succeeded", stage: "before-expiry", nonce: forbidden },
    { event: "model-turn-succeeded", stage: forbidden, nonce: `FIRST_AGENT_${uuid}` },
    { ...maintenanceDiagnostic, reason: forbidden },
    { ...maintenanceDiagnostic, logReadFailures: -1 },
    { ...maintenanceDiagnostic, logReadSuccesses: forbidden },
    { ...maintenanceDiagnostic, tailLimitReads: 0.5 },
    { ...maintenanceDiagnostic, completionsTruncated: forbidden },
    { ...maintenanceDiagnostic, completions: Array(17).fill({ outcome: "retry", code: "x" }) },
    { ...maintenanceDiagnostic, completions: [forbidden] },
    { event: "worker-restart-unconfirmed", stage: forbidden },
    { event: "worker-restart-unconfirmed" },
    { event: "cleanup", outcome: forbidden },
  ].map((value) => ({ kind: retentionKind, ...value }));
  // Observation metadata can survive unavailable probes; payloads and raw identities cannot.
  const unavailableTurnover = {
    kind: "openshell-initial-turnover",
    request: 1,
    clockOffsetMinMs: -1,
    clockOffsetMaxMs: 1,
    startedAtMs: 1_800_000_000_000,
    finishedAtMs: 1_800_000_010_000,
    requestOutcome: "failed",
    httpStatus: null,
    nonceMatched: false,
    observation: "unavailable",
    qualification: "failed",
    durableCommands: false,
    nodeIdSha256: null,
    connectedBeforeMs: null,
    connectedAfterMs: null,
    providerEnvBeforeSha256: null,
    providerEnvAfterSha256: null,
    configBeforeSha256: null,
    configAfterSha256: null,
    policyBeforeSha256: null,
    policyAfterSha256: null,
    turnoverAtMs: null,
    staleTunnelAtMs: null,
    harness1006LogObserved: false,
    capturedGeneration: null,
    currentGeneration: null,
    configUnchanged: false,
    policyUnchanged: false,
    providerEnvChanged: false,
    settingsConsistent: false,
    stableRuntime: false,
  };
  const unexercisedTurnover = {
    ...unavailableTurnover,
    requestOutcome: "passed",
    httpStatus: 200,
    nonceMatched: true,
    observation: "complete",
    qualification: "unexercised",
    durableCommands: true,
    nodeIdSha256: "a".repeat(64),
    connectedBeforeMs: 1_799_999_999_000,
    connectedAfterMs: 1_799_999_999_000,
    providerEnvBeforeSha256: "b".repeat(64),
    providerEnvAfterSha256: "b".repeat(64),
    configBeforeSha256: "c".repeat(64),
    configAfterSha256: "c".repeat(64),
    policyBeforeSha256: "d".repeat(64),
    policyAfterSha256: "d".repeat(64),
    configUnchanged: true,
    policyUnchanged: true,
    settingsConsistent: true,
    stableRuntime: true,
  };
  const turnContinuity = {
    ...unexercisedTurnover,
    request: 2,
    qualification: "turn-continuity",
    connectedAfterMs: 1_800_000_003_000,
    providerEnvAfterSha256: "e".repeat(64),
    turnoverAtMs: 1_800_000_001_000,
    staleTunnelAtMs: 1_800_000_002_000,
    harness1006LogObserved: true,
    capturedGeneration: 1,
    currentGeneration: 2,
    providerEnvChanged: true,
  };
  const runtimeFailure = {
    kind: "local-first-agent-command",
    phase: "setup",
    stage: "runtime-build",
    count: 4,
    failed: 3,
    elapsedMs: 200,
  };
  // These records exercise the same consistency decision used by the real observer.
  // Contradiction stays incomplete even when each field is well-typed.
  const incompleteTurnover = (base, overrides) => ({
    ...base,
    ...overrides,
    qualification: "incomplete",
  });
  const conflictingSettings = incompleteTurnover(turnContinuity, { settingsConsistent: false });
  const unchangedProvider = incompleteTurnover(turnContinuity, {
    providerEnvAfterSha256: turnContinuity.providerEnvBeforeSha256,
  });
  const missingTurnoverEvent = incompleteTurnover(unexercisedTurnover, {
    providerEnvAfterSha256: "e".repeat(64),
  });
  const changedGateway = incompleteTurnover(turnContinuity, { stableRuntime: false });
  const earlyRelay = incompleteTurnover(turnContinuity, { staleTunnelAtMs: 1_799_999_999_999 });
  const lateTurnover = incompleteTurnover(turnContinuity, { turnoverAtMs: 1_800_000_010_001 });
  await writeSingleFileRunnerLane(
    root,
    "measure",
    "tests/integration/measurements.test.mjs",
    [
      'import test from "node:test";',
      `import { runOpenShellStage } from ${JSON.stringify(new URL("../helpers/openshell-stage.mjs", import.meta.url).href)};`,
      'test("measures", async (t) => {',
      '  await runOpenShellStage(t, "scratch-sibling-isolation", async () => {});',
      '  await runOpenShellStage(t, "scratch-queued-actor-revocation", async () => {});',
      ...[
        measurement({
          kind: "openshell-stage",
          stage: "oauth-refresh",
          outcome: "passed",
          elapsedMs: 123,
          transcript: "secretauthvalue-transcript",
        }),
        measurement({
          kind: "openshell-stage",
          stage: "secretauthvalue-stage",
          outcome: "passed",
          elapsedMs: 123,
        }),
        measurement({
          kind: "local-first-agent-command",
          phase: "setup",
          stage: "runtime-build",
          count: 1,
          failed: 0,
          elapsedMs: 100,
          args: "secretauthvalue-args",
        }),
        measurement({ ...runtimeFailure, nonzeroExitCount: 1, signaledCount: 1 }),
        measurement({ ...runtimeFailure, stage: "openshell-agent-sandbox-image" }),
        measurement({
          ...runtimeFailure,
          elapsedMs: 201,
          signaledCount: "secretauthvalue-outcome",
        }),
        measurement({ ...runtimeFailure, elapsedMs: 202, nonzeroExitCount: 2, signaledCount: 2 }),
        measurement({
          ...runtimeFailure,
          elapsedMs: 203,
          stage: "controller-build",
          signaledCount: 1,
        }),
        measurement({
          kind: "local-first-agent-command",
          phase: "setup",
          stage: "secretauthvalue-stage",
          count: 1,
          failed: 0,
          elapsedMs: 100,
        }),
        measurement({
          kind: "local-first-agent-pod",
          stage: "native-initial",
          role: "harness",
          restarts: 0,
          createdAfterRequestMs: 100,
          scheduledMs: 100,
          initializedMs: 200,
          runningMs: 200,
          readyMs: 300,
          observedMs: 400,
          environment: "secretauthvalue-env",
        }),
        measurement({
          kind: "local-first-agent-pod",
          stage: "native-initial",
          role: "secretauthvalue-role",
          restarts: 0,
        }),

        measurement({
          kind: "local-first-agent",
          stage: "setup",
          outcome: "passed",
          elapsedMs: 1234,
          transcript: "secretauthvalue-transcript",
        }),
        measurement({
          kind: "local-first-agent",
          stage: "secretauthvalue-stage",
          outcome: "passed",
          elapsedMs: 12,
        }),
        measurement({
          kind: "local-first-agent",
          stage: "setup",
          outcome: "secretauthvalue-outcome",
          elapsedMs: 12,
        }),
        measurement({
          kind: "local-first-agent",
          stage: "setup",
          outcome: "passed",
          elapsedMs: "secretauthvalue-time",
        }),

        measurement({
          kind: "kubelet-volume-refresh",
          volume: "secret",
          nudge: "pod-annotation",
          sample: 1,
          seconds: 1.234,
          extra: "secretauthvalue-extra",
        }),
        measurement({
          kind: "kubelet-volume-refresh",
          volume: "secretauthvalue-volume",
          nudge: "none",
          sample: 0,
          seconds: 1,
        }),
        measurement({
          kind: "kubelet-volume-refresh",
          volume: "configmap",
          nudge: "none",
          sample: 0,
          seconds: "secretauthvalue-seconds",
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "gateway-500m-answer",
          code: "READY",
          elapsedMs: 61_234,
          capMs: 110_000,
          cpuWaitMs: 4_321,
          setupMs: 2_345,
          probeDoneMs: 63_456,
          readyMs: null,
          extra: "secretauthvalue-extra",
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "gateway-1cpu-answer",
          code: "secretauthvalue-code",
          elapsedMs: 1,
          capMs: 65_000,
          cpuWaitMs: null,
          setupMs: 1,
          probeDoneMs: 1,
          readyMs: 1,
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "gateway-500m-contended",
          code: null,
          elapsedMs: null,
          capMs: null,
          cpuWaitMs: null,
          setupMs: 1,
          probeDoneMs: null,
          readyMs: null,
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "secretauthvalue-case",
          code: "READY",
          elapsedMs: 1,
          capMs: 1,
          cpuWaitMs: 1,
          setupMs: 1,
          probeDoneMs: 1,
          readyMs: 1,
        }),
        measurement({
          kind: "runtime-model-probe",
          case: "gateway-500m-hang",
          code: "MODEL_PROBE_TIMEOUT",
          elapsedMs: "secretauthvalue-elapsed",
          capMs: 1,
          cpuWaitMs: 1,
          setupMs: 1,
          probeDoneMs: 1,
          readyMs: 1,
        }),
        measurement({
          kind: "runtime-sigterm",
          case: "gateway-model-probe",
          stopped: true,
          elapsedMs: 4_321,
          budgetMs: 15_000,
          extra: "secretauthvalue-extra",
        }),
        measurement({
          kind: "runtime-sigterm",
          case: "secretauthvalue-case",
          stopped: true,
          elapsedMs: 1,
          budgetMs: 15_000,
        }),
        measurement({
          kind: "runtime-sigterm",
          case: "codex-ready",
          stopped: "secretauthvalue-stopped",
          elapsedMs: 1,
          budgetMs: 15_000,
        }),
        measurement({
          kind: "runtime-sigterm",
          case: "codex-ready",
          stopped: false,
          elapsedMs: 1.5,
          budgetMs: 15_000,
        }),
        measurement({ ...openshellPhase, detail: "secretauthvalue-phase-detail" }),
        measurement({ ...openshellPhase, stage: "secretauthvalue-phase-stage" }),
        measurement({ ...openshellPhase, outcome: "secretauthvalue-phase-outcome" }),
        measurement({ ...openshellPhase, elapsedMs: 2_400_001 }),
        measurement({ ...openshellPhase, elapsedMs: 0.5 }),
        ...retentionReceipts.map(measurement),
        ...invalidRetention.map(measurement),
        `openclaw-ci-measurement {"kind":"openshell-git-retention","private":"${forbidden}",`,
        ...[unavailableTurnover, unexercisedTurnover, turnContinuity].map((value) =>
          measurement({
            ...value,
            detail: "secretauthvalue-turnover-detail",
            nodeId: "secretauthvalue-node-id",
            provider: { config: "secretauthvalue-provider-config" },
          }),
        ),
        ...[
          { request: 3 },
          { startedAtMs: -1 },
          { finishedAtMs: Number.MAX_SAFE_INTEGER + 1 },
          { requestOutcome: "secretauthvalue-request-outcome" },
          { httpStatus: 600 },
          { observation: "secretauthvalue-observation" },
          { qualification: "secretauthvalue-qualification" },
          { nodeIdSha256: "secretauthvalue-node-id" },
          { providerEnvAfterSha256: "A".repeat(64) },
          { configBeforeSha256: "a".repeat(63) },
          { policyAfterSha256: undefined },
          { connectedAfterMs: 0.5 },
          { turnoverAtMs: "secretauthvalue-time" },
          { currentGeneration: -1 },
          { nonceMatched: "secretauthvalue-matched" },
          { durableCommands: 1 },
          { stableRuntime: undefined },
          { harness1006LogObserved: "secretauthvalue-close" },
        ].map((invalid) => measurement({ ...turnContinuity, ...invalid })),
        ...[
          conflictingSettings,
          unchangedProvider,
          missingTurnoverEvent,
          changedGateway,
          earlyRelay,
          lateTurnover,
        ].flatMap((value) => [
          measurement(value),
          measurement({ ...value, qualification: "turn-continuity" }),
        ]),
        "openclaw-ci-measurement secretauthvalue-not-json",
        "secretauthvalue-plain-diagnostic",
      ].map((message) => `  t.diagnostic(${JSON.stringify(message)});`),
      "});",
      "",
    ].join("\n"),
  );

  const result = run(root, laneArgs(root, "measure", "state/measurements.jsonl", resultsPath));
  const artifact = await readFile(resultsPath, "utf8");
  const summary = JSON.parse(artifact);
  assert.equal(result.status, 0, result.stderr);
  const [sibling, revocation, ...otherMeasurements] = summary.files[0].measurements;
  for (const [receipt, stage] of [
    [sibling, "scratch-sibling-isolation"],
    [revocation, "scratch-queued-actor-revocation"],
  ]) {
    const { elapsedMs, ...outcome } = receipt;
    assert.deepEqual(outcome, { kind: "openshell-stage", stage, outcome: "passed" });
    assert.ok(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0);
  }
  assert.deepEqual(
    otherMeasurements.filter(({ kind }) => kind !== retentionKind),
    [
      { kind: "openshell-stage", stage: "oauth-refresh", outcome: "passed", elapsedMs: 123 },
      {
        kind: "local-first-agent-command",
        phase: "setup",
        stage: "runtime-build",
        count: 1,
        failed: 0,
        elapsedMs: 100,
      },
      { ...runtimeFailure, nonzeroExitCount: 1, signaledCount: 1 },
      { ...runtimeFailure, stage: "openshell-agent-sandbox-image" },
      { ...runtimeFailure, elapsedMs: 201 },
      { ...runtimeFailure, elapsedMs: 202 },
      { ...runtimeFailure, elapsedMs: 203, stage: "controller-build" },
      {
        kind: "local-first-agent-pod",
        stage: "native-initial",
        role: "harness",
        restarts: 0,
        createdAfterRequestMs: 100,
        scheduledMs: 100,
        initializedMs: 200,
        runningMs: 200,
        readyMs: 300,
        observedMs: 400,
      },

      { kind: "local-first-agent", stage: "setup", outcome: "passed", elapsedMs: 1234 },
      {
        kind: "kubelet-volume-refresh",
        volume: "secret",
        nudge: "pod-annotation",
        sample: 1,
        seconds: 1.2,
      },
      {
        kind: "runtime-model-probe",
        case: "gateway-500m-answer",
        code: "READY",
        elapsedMs: 61_234,
        capMs: 110_000,
        cpuWaitMs: 4_321,
        setupMs: 2_345,
        probeDoneMs: 63_456,
        readyMs: null,
      },
      {
        kind: "runtime-model-probe",
        case: "gateway-1cpu-answer",
        code: "other",
        elapsedMs: 1,
        capMs: 65_000,
        cpuWaitMs: null,
        setupMs: 1,
        probeDoneMs: 1,
        readyMs: 1,
      },
      {
        kind: "runtime-model-probe",
        case: "gateway-500m-contended",
        code: null,
        elapsedMs: null,
        capMs: null,
        cpuWaitMs: null,
        setupMs: 1,
        probeDoneMs: null,
        readyMs: null,
      },
      {
        kind: "runtime-sigterm",
        case: "gateway-model-probe",
        stopped: true,
        elapsedMs: 4_321,
        budgetMs: 15_000,
      },
      openshellPhase,
      unavailableTurnover,
      unexercisedTurnover,
      turnContinuity,
      conflictingSettings,
      unchangedProvider,
      missingTurnoverEvent,
      changedGateway,
      earlyRelay,
      lateTurnover,
    ],
  );
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${artifact}`, /secretauthvalue/);
  const receipts = summary.files[0].measurements.filter(({ kind }) => kind === retentionKind);
  assert.deepEqual(
    receipts.filter(({ event }) => event.startsWith("finite-removal-")),
    [
      {
        kind: retentionKind,
        event: "finite-removal-live-denial",
        boundary: "signed-access-withdrawn",
        signer: "exercised",
        requestIdHash: opaqueHash,
        workerUid: uuid,
      },
      {
        kind: retentionKind,
        event: "finite-removal-live-denial",
        boundary: "supervisor-policy",
        signer: "unexercised",
        requestIdHash: null,
        workerUid: uuid,
      },
      {
        kind: retentionKind,
        event: "finite-removal-reduced",
        revisionIdHash: opaqueHash,
        workIdHash: opaqueHash,
        workerUid: uuid,
        code: "REPOSITORY_ACCESS_WITHDRAWN",
        sessionIdHash: opaqueHash,
        processInstanceIdHash: opaqueHash,
        networkInstanceIdHash: opaqueHash,
        attachmentEpochHash: opaqueHash,
        providerEnvRevision: "3",
        configRevision: "4",
        policyHash: sha256,
      },
      {
        kind: retentionKind,
        event: "finite-removal-conversation",
        stage: "after-replacement",
        revisionIdHash: opaqueHash,
        sessionIdHash: opaqueHash,
        threadIdHash: opaqueHash,
        userSeq: 10,
        assistantSeq: 11,
      },
      {
        kind: retentionKind,
        event: "finite-removal-retired",
        revisionIdHash: opaqueHash,
        cause: "required-model-withdrawn",
        deadlineWallMs: 1800000000000,
        observedAt: 1799999999000,
        activeRevisionCleared: true,
        sandboxAbsent: true,
        agentPodsAbsent: true,
      },
    ],
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === workerRestart.event),
    [{ kind: retentionKind, ...workerRestart }],
    "expected exactly one allowlisted worker restart projection with the original identities",
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "withdrawal-origin-witness"),
    withdrawalWitnesses.map((receipt) => ({ kind: retentionKind, ...receipt })),
  );
  assert.deepEqual(
    receipts.find(({ event }) => event === "withdrawal-retirement-refused"),
    { kind: retentionKind, ...withdrawalRetirement },
  );
  assert.deepEqual(
    receipts.map(({ event }) => event),
    retentionReceipts.map(({ event }) => event),
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "retained-execution-failed"),
    retainedFailures.map((receipt) => ({ kind: retentionKind, ...receipt })),
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "git-policy-denied"),
    policyDenials.map((receipt) => ({ kind: retentionKind, ...receipt })),
  );
  assert.equal(summary.sourceSha, currentSha());
  assert.equal(summary.files[0].path, "tests/integration/measurements.test.mjs");
  assert.deepEqual(
    receipts.find(({ event }) => event === "initial-runtime"),
    {
      kind: retentionKind,
      event: "initial-runtime",
      revisionIdHash: opaqueHash,
      sandboxIdHash: opaqueHash,
      sandboxUid: uuid,
      podUid: uuid,
      mainProcessInstanceIdHash: opaqueHash,
      mainProcessStartedAt: time,
      containers: [
        {
          nameHash: opaqueHash,
          idHash: opaqueHash,
          imageDigest: `sha256:${sha256}`,
          startedAt: time,
          restartCount: 0,
        },
      ],
    },
  );
  assert.deepEqual(
    receipts.find(({ event }) => event === "supervisor-trust"),
    {
      kind: retentionKind,
      event: "supervisor-trust",
      parentDigest: `sha256:${sha256}`,
      imageDigest: `sha256:${sha256}`,
      binaryHash: sha256,
      configDigest: `sha256:${sha256}`,
    },
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "withdrawal-decision-unconfirmed"),
    ["unchecked", "same", "different"].map((workerComparison) => ({
      kind: retentionKind,
      ...withdrawalDecision,
      workerComparison,
    })),
  );
  assert.deepEqual(receipts.find(({ event }) => event === "git-expiry-observed").expiry, {
    event: "worker.openshell-git-expiry",
    namespaceIdHash: opaqueHash,
    agentIdHash: opaqueHash,
    revisionIdHash: opaqueHash,
    repositoryRefHash: opaqueHash,
    outcome: "withdrawn",
    check: "record-reduced-generation",
  });
  assert.deepEqual(
    receipts.filter(({ event }) => event === "worker-restart-unconfirmed"),
    restartStages.map((stage) => ({
      kind: retentionKind,
      event: "worker-restart-unconfirmed",
      stage,
    })),
  );
  assert.deepEqual(
    receipts.filter(({ event }) => event === "worker-maintenance-unconfirmed"),
    maintenanceReasons.map((reason) => ({
      kind: retentionKind,
      event: "worker-maintenance-unconfirmed",
      reason,
      logReads: 3,
      logReadSuccesses: 2,
      logReadFailures: 1,
      linesRead: 2004,
      parsedEvents: 2000,
      parseFailures: 4,
      tailLimitReads: 1,
      completionsTruncated: false,
      completions: [
        { outcome: "pending", code: "REPOSITORY_CLEANUP_PENDING" },
        { outcome: "retry", code: "unrecognized", failure: "UNRECOGNIZED" },
        { outcome: "permanent", code: "REPOSITORY_ACCESS_WITHDRAWN" },
        { outcome: "pending", code: "REPOSITORY_GIT_ROUTE_PENDING" },
        { outcome: "pending", code: "REPOSITORY_GIT_MATERIAL_PENDING" },
        { outcome: "pending", code: "WORKSPACE_NODE_PENDING" },
        { outcome: "pending", code: "WORKSPACE_NODE_BINDING_PENDING" },
        { outcome: "pending", code: "WORKSPACE_NODE_RECONNECT_PENDING" },
        { outcome: "pending", code: "WORKSPACE_SETUP_RETRYING" },
        {
          outcome: "pending",
          code: "REVISION_INCOMPLETE",
          failure: "REPOSITORY_ROUTE_BLOCKED",
        },
        {
          outcome: "pending",
          code: "REVISION_FINALIZATION_INCOMPLETE",
          failure: "MODEL_PROBE_FAILED",
        },
        { outcome: "pending", code: "unrecognized", failure: "UNRECOGNIZED" },
      ],
    })),
  );
  const unconfirmed = receipts.find(({ event }) => event === "git-expiry-unconfirmed");
  assert.deepEqual(unconfirmed.observations, captured);
  assert.equal(unconfirmed.namespaceIdHash, opaqueHash);
  assert.equal(unconfirmed.agentIdHash, opaqueHash);
  assert.equal(unconfirmed.revisionIdHash, opaqueHash);
  assert.equal(unconfirmed.repositoryRefHash, opaqueHash);
  assert.equal(unconfirmed.lastWorkerUid, uuid);
  assert.equal(unconfirmed.tailLimitReads, 1);
  assert.equal(unconfirmed.workerChanges, 1);
  assert.equal(unconfirmed.driverSuccessSeen, true);
  assert.equal(unconfirmed.workerAcknowledgementSeen, false);
  assert.equal(unconfirmed.observationsTruncated, true);
  for (const output of [result.stdout, result.stderr, artifact]) {
    assert.ok(!output.includes(forbidden));
    assert.ok(!output.includes(opaque));
  }

  // A later failure makes the reporter emit its raw output buffer. Invalid
  // receipts and unselected fields must still not fall through into that buffer.
  const fixtureFile = join(root, "tests/integration/measurements.test.mjs");
  await writeFile(
    fixtureFile,
    (await readFile(fixtureFile, "utf8")) +
      '\ntest("fails after receipts", () => { throw new Error("controlled failure"); });\n',
  );
  const failed = run(
    root,
    laneArgs(root, "measure", "state/failed-measurements.json", resultsPath),
  );
  assert.equal(failed.status, 1, failed.stderr);
  const failedArtifact = await readFile(resultsPath, "utf8");
  const diagnostics = await readFile(
    join(root, "state/failed-measurements.json.diagnostics.json"),
    "utf8",
  );
  assert.deepEqual(
    JSON.parse(failedArtifact).files[0].measurements.filter(({ kind }) => kind === retentionKind),
    receipts,
  );
  for (const output of [failed.stdout, failed.stderr, failedArtifact, diagnostics]) {
    assert.ok(!output.includes(forbidden));
    assert.ok(!output.includes(opaque));
  }
});

test("run reports a cleanup that fails once a cancelled job's shell is gone as cancelled", async (t) => {
  const root = await fixture(t);
  const { statePath, resultsPath } = runnerArtifactPaths(root, "cancelled");
  // GitHub cancels a step by signalling and then killing its shell, never this runner, which
  // finishes as an orphan beside the job's own cleanup step. The second file's cleanup kills
  // the runner's parent, as the cancellation kills the shell, and then fails, as the racing
  // cleanup step makes it.
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    `export async function prepareFile({ file }) {
  if (file.path.endsWith('plain.test.mjs')) {
    return { cleanup: async () => { throw new Error('secretauthvalue cleanup'); } };
  }
  return {
    cleanup: async () => {
      const shell = process.ppid;
      process.kill(shell, 'SIGKILL');
      const deadline = Date.now() + 10_000;
      while (process.ppid === shell && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Object.assign(new Error('secretauthvalue cluster already removed'), { code: 'ENOENT' });
    },
  };
}
`,
  );
  await writeFixtureLane(root, "cancel", ["plain", "cancelled"], passingLaneFixture);

  // A parent process stands in for the step's shell: it waits for the runner until the second
  // file's cleanup kills it. No shell parses any of these arguments. The timeout only stops a
  // hang: a loaded host can take over 30 s to run both files, and the shell must die by the
  // cleanup's SIGKILL, not this SIGTERM.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'require("node:child_process").spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" });',
      process.execPath,
      runnerPath,
      ...laneArgs(root, "cancel", statePath, resultsPath),
    ],
    { cwd: repositoryRoot, encoding: "utf8", env: runnerEnv(), timeout: 120_000 },
  );

  assert.equal(result.signal, "SIGKILL", result.stderr);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(summary.status, "failed");
  // A cleanup that fails while the job runs is still a cleanup failure.
  assert.deepEqual(summary.files[0].cleanup, { status: "failed", error: { name: "Error" } });
  // The cancelled record keeps the error's name and code, never its message.
  assert.deepEqual(summary.files[1].cleanup, {
    status: "cancelled",
    error: { name: "Error", code: "ENOENT" },
  });
  assert.deepEqual(
    summary.issues.map(({ code, file }) => [code, file]),
    [
      ["cleanup-failed", "tests/integration/plain.test.mjs"],
      ["cleanup-cancelled", "tests/integration/cancelled.test.mjs"],
    ],
  );
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}\n${await readFile(resultsPath, "utf8")}`,
    /secretauthvalue/,
  );
});

test("run publishes a failed wait's followed container log, redacted, beside Agent activity", async (t) => {
  const root = await fixture(t);
  const pod = {
    metadata: {
      namespace: "occ-agent-a",
      name: "gateway-0",
      uid: "uid-1",
      creationTimestamp: "2026-10-08T07:43:40Z",
      deletionTimestamp: "2026-10-08T07:43:53Z",
      deletionGracePeriodSeconds: 330,
    },
    spec: {
      containers: [{ name: "gateway", env: [{ name: "TOKEN", value: "do-not-publish-env" }] }],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        { name: "gateway", ready: false, restartCount: 0, state: { running: { startedAt: "t" } } },
      ],
    },
  };
  const event = {
    metadata: { namespace: "occ-agent-a", name: "gateway-0.kill", uid: "e1" },
    involvedObject: { kind: "Pod", name: "gateway-0", namespace: "occ-agent-a" },
    type: "Normal",
    reason: "Killing",
    message: "Stopping container gateway",
    count: 1,
    lastTimestamp: "2026-10-08T07:43:53Z",
  };
  const boundary = mixedPrecisionEventBoundary({
    namespace: "occ-agent-a",
    pod: "gateway-0",
    second: "2026-10-08T07:43:52",
    laterCount: 198,
  });
  const events = [...boundary.events, event];
  const logLines = [
    "2026-10-08T07:43:49.1Z [gateway] startup phase: config.auth starting",
    "2026-10-08T07:43:53.2Z [gateway] received SIGTERM; shutting down",
    "2026-10-08T07:43:53.3Z request Authorization: Bearer do-not-publish-header",
    "2026-10-08T07:43:53.4Z provider token=do-not-publish-assignment refreshed",
    "2026-10-08T07:43:53.5Z parent value secretauthvalue-parent seen",
    '2026-10-08T07:43:53.5Z OCSF-JSON {"detail":"private-structured-early","message":"failure"}',
    '2026-10-08T07:43:53.5Z OCSF-JSON {"message":"failure","detail":"private-structured-truncated',
  ];
  // Only the lane gives the child this value; the runner's own env never has it.
  const childSecret = "childonlysecret-1754";
  // One stand-in serves the runner's raw watches (which wait until stopped) and
  // the test helper's log follow and snapshots; the log ends after a slow exit.
  const bin = join(root, "bin");
  await mkdir(bin);
  const kubectl = await writeK3dKubectl(bin, { kind: "stop", pod, events, logLines });
  const kubectlCalls = join(root, "kubectl-calls.jsonl");
  await writeFile(
    kubectl,
    `${await readFile(kubectl, "utf8")}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(kubectlCalls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
  );
  await writeK3dChildTest(join(root, "tests/integration/stop.test.mjs"), { kind: "stop" });
  await writeK3dChildTest(join(root, "tests/integration/pass.test.mjs"), { kind: "passing" });

  const { clusterDirectory, statePath, args } = await prepareK3dDiagnosticsRun(
    root,
    [
      { path: "tests/integration/stop.test.mjs", expectedTests: ["gateway stop is confirmed"] },
      { path: "tests/integration/pass.test.mjs", expectedTests: ["passes"] },
    ],
    { OCC_TEST_CHILD_ONLY: childSecret },
  );
  const provenanceCanary = "private-image-metadata";
  const runtimeProvenance = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: {
      imageId: `sha256:${"a".repeat(64)}`,
      manifestDigest: `sha256:${"b".repeat(64)}`,
      status: "available",
      platform: "linux/amd64",
      openclawCommit: "c".repeat(40),
      codex: { version: "0.164.0", binarySha256: "d".repeat(64) },
    },
    OCC_TEST_KUBERNETES_AGENT_IMAGE: {
      imageId: `sha256:${"e".repeat(64)}`,
      manifestDigest: `sha256:${"f".repeat(64)}`,
      status: "unavailable",
    },
  };
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.prefix = provenanceCanary;
  state.runtimeProvenance = structuredClone(runtimeProvenance);
  state.runtimeProvenance.OCC_TEST_KUBERNETES_GATEWAY_IMAGE.config = provenanceCanary;
  state.runtimeProvenance.OCC_TEST_KUBERNETES_AGENT_IMAGE.error = provenanceCanary;
  await writeJson(statePath, state);
  // The last file removes the private state, as per-file cleanup can. Earlier
  // validated evidence must survive in both the final result and same-run sidecar.
  const passingFile = join(root, "tests/integration/pass.test.mjs");
  await writeFile(
    passingFile,
    `${await readFile(passingFile, "utf8")}\nimport { rm } from "node:fs/promises";\nawait rm(${JSON.stringify(statePath)});\n`,
  );
  await writeJson(`${statePath}.diagnostics.json`, {
    lane: "previous-lane",
    preparationId: "previous-preparation",
    failures: [{ file: "previous-file", private: provenanceCanary }],
    runtimeProvenance,
  });
  const result = run(root, args, {
    OCC_KUBECTL_BIN: kubectl,
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(result.status, 1, result.stderr);
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const summary = JSON.parse(await readFile(join(root, "results/k3d.json"), "utf8"));
  assert.deepEqual(
    summary.files.map(({ path, status, tests }) => ({
      path,
      status,
      tests: tests.map(({ name, status }) => [name, status]),
    })),
    [
      {
        path: "tests/integration/stop.test.mjs",
        status: "failed",
        tests: [["gateway stop is confirmed", "failed"]],
      },
      {
        path: "tests/integration/pass.test.mjs",
        status: "passed",
        tests: [["passes", "passed"]],
      },
    ],
    "the failed wait and the passing control have distinct runner outcomes",
  );
  assert.deepEqual(summary.runtimeProvenance, runtimeProvenance);
  assert.deepEqual(JSON.parse(text).runtimeProvenance, runtimeProvenance);
  assert.equal(
    JSON.parse(text).preparationId,
    createHash("sha256").update(state.prefix).digest("hex"),
  );
  assert.ok(!JSON.stringify(summary).includes(provenanceCanary));
  assert.ok(!text.includes(provenanceCanary));
  const { containerLogs } = JSON.parse(text);
  // Only the failed wait writes a record: not the wait that settled, not the passing file.
  assert.equal(containerLogs.length, 1);
  const [log] = containerLogs;
  assert.equal(log.file, "tests/integration/stop.test.mjs");
  assert.equal(log.test, "gateway stop is confirmed");
  assert.equal(log.reason, "terminal response wait");
  assert.deepEqual(
    [log.namespace, log.pod, log.container],
    ["occ-agent-a", "gateway-0", "gateway"],
  );
  assert.deepEqual(
    log.markers.map(({ label }) => label),
    ["stop requested", "failed: terminal response wait"],
  );
  // The follow ran to the container's exit, unterminated last line included.
  assert.equal(log.stream.ended, true);
  assert.equal(log.stream.exitCode, 0);
  assert.equal(log.stream.error, "follow note\n[redacted credential-bearing line]");
  assert.deepEqual(log.lines, [
    logLines[0],
    logLines[1],
    "[redacted credential-bearing line]",
    "2026-10-08T07:43:53.4Z provider token=[redacted] refreshed",
    "2026-10-08T07:43:53.5Z parent value [env:CI_RUNNER_PARENT_SECRET] seen",
    "2026-10-08T07:43:53.6Z child value [env:OCC_TEST_CHILD_ONLY]",
    "2026-10-08T07:44:22.0Z [gateway] exit 0",
  ]);
  // A failed read is marked, so it cannot pass for a Pod that is already gone.
  assert.deepEqual(
    log.snapshots.map(({ label, unavailable }) => [label, unavailable]),
    [
      ["at-failure", undefined],
      ["after-log", true],
    ],
  );
  const [snapshot] = log.snapshots;
  assert.equal(snapshot.pods[0].deletedAt, "2026-10-08T07:43:53Z");
  assert.equal(snapshot.pods[0].deletionGracePeriodSeconds, 330);
  assert.equal(snapshot.pods[0].containers[0].startedAt, "t");
  assert.equal(snapshot.events.length, 200);
  assert.equal(snapshot.events[0].reason, boundary.newer.reason);
  assert.equal(
    snapshot.events.some(({ reason }) => reason === boundary.older.reason),
    false,
  );
  assert.deepEqual(
    snapshot.events.find(({ reason }) => reason === "Killing"),
    {
      namespace: "occ-agent-a",
      kind: "Pod",
      name: "gateway-0",
      type: "Normal",
      reason: "Killing",
      message: "Stopping container gateway",
      count: 1,
      lastTimestamp: "2026-10-08T07:43:53Z",
    },
  );
  assert.doesNotMatch(text, /do-not-publish|secretauthvalue|childonlysecret/);
  // The record directory lived in the cluster's private directory and is gone.
  assert.deepEqual(
    (await readdir(clusterDirectory)).filter((name) => name.startsWith("container-logs-")),
    [],
  );

  // A different lane must not inherit retained state or the sidecar from this lane.
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
  await writeJson(statePath, state);
  await writeFile(
    join(root, "tests/integration/later.test.mjs"),
    'import test from "node:test"; test("later failure", () => { throw new Error("later"); });\n',
  );
  await writeJson(join(root, "scripts/ci/k3d-lane.json"), {
    files: [{ path: "tests/integration/later.test.mjs", expectedTests: ["later failure"] }],
  });
  await writeJson(join(root, "scripts/ci/suites.json"), {
    version: 1,
    lanes: { "later-lane": "./k3d-lane.json" },
    groups: {},
  });
  const initialCalls = await readFile(kubectlCalls, "utf8");
  assert.notEqual(initialCalls, "", "the original lane reached namespace capture");
  for (const retainedState of [true, false]) {
    if (!retainedState) {
      await rm(statePath, { force: true });
    }
    const later = run(root, [args[0], "later-lane", ...args.slice(2)], {
      OCC_KUBECTL_BIN: kubectl,
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(later.status, 1, later.stderr);
    const laterSummary = JSON.parse(await readFile(join(root, "results/k3d.json"), "utf8"));
    assert.equal(laterSummary.runtimeProvenance, undefined);
    const next = JSON.parse(await readFile(`${statePath}.diagnostics.json`, "utf8"));
    assert.equal(next.lane, "later-lane");
    assert.equal(next.runtimeProvenance, undefined);
    assert.equal(next.agentNamespaces, undefined);
    assert.equal(
      await readFile(kubectlCalls, "utf8"),
      initialCalls,
      "foreign state starts no capture",
    );
    assert.equal(next.containerLogs, undefined);
    assert.deepEqual(
      next.failures.map(({ file }) => file),
      ["tests/integration/later.test.mjs"],
    );
  }
});

for (const earlyLogExit of [false, true]) {
  test(`run retains controller readiness evidence before its fixture namespace is deleted (early log exit: ${earlyLogExit})`, async (t) => {
    const root = await fixture(t);
    const bin = join(root, "bin");
    await mkdir(bin);
    const deleted = join(root, "namespace-deleted");
    const calls = join(root, "kubectl-calls.jsonl");
    const { clusterDirectory, statePath, args } = await prepareK3dDiagnosticsRun(root, [
      { path: "tests/integration/startup.test.mjs", expectedTests: ["controller startup fails"] },
    ]);
    // These are the controller fixture's real labels, without Compute's managed-by label.
    // The Agent watch sees no Pod; only the startup wait's capture can retain this failure.
    const labels = {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": "fixture",
      "app.kubernetes.io/component": "api",
    };
    const namespace = "occ-controller-failed";
    const pod = {
      metadata: { namespace, name: "api-0", uid: "api-uid", labels },
      spec: { containers: [{ name: "api", env: [{ name: "TOKEN", value: "private-env" }] }] },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "api",
            ready: false,
            restartCount: 2,
            state: { waiting: { reason: "CrashLoopBackOff" } },
          },
        ],
      },
    };
    const eventValue = "opaque-long-value-" + "z".repeat(600);
    const event = {
      metadata: { namespace, name: "api-backoff", uid: "event-uid" },
      involvedObject: { kind: "Pod", name: "api-0", namespace },
      type: "Warning",
      reason: "BackOff",
      message: [
        "Back-off restarting failed container api",
        "-----BEGIN " + "PRIVATE KEY-----",
        "synthetic-pem-body-marker",
        "-----END " + "PRIVATE KEY-----",
        eventValue,
      ].join("\n"),
    };
    const kubectl = await writeK3dKubectl(bin, {
      kind: "startup",
      root,
      calls,
      deleted,
      earlyLogExit,
      pod,
      event,
    });
    await writeK3dChildTest(join(root, "tests/integration/startup.test.mjs"), {
      kind: "startup",
      root,
      deleted,
      selection: {
        kubeconfigPath: join(clusterDirectory, "kubeconfig"),
        kubernetesContext: "k3d-owned-cluster",
      },
      target: { namespace, container: "api", labels },
    });
    const result = run(root, args, {
      OCC_KUBECTL_BIN: kubectl,
      PATH: `${bin}:${process.env.PATH}`,
      OCC_TEST_EVENT_VALUE: eventValue,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /timed out waiting for the condition on deployments\/openclaw-enterprise-api/,
    );
    assert.equal(await readFile(deleted, "utf8"), "deleted");
    const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
    const report = JSON.parse(text);
    assert.equal(report.agentNamespaces, undefined);
    assert.ok(
      Array.isArray(report.containerLogs),
      "failed controller startup must retain diagnostics",
    );
    assert.equal(
      report.containerLogs.length,
      1,
      "a successful wait must not publish a failure record",
    );
    const [log] = report.containerLogs;
    assert.equal(log.namespace, namespace);
    assert.equal(log.pod, undefined);
    assert.equal(log.container, "api");
    assert.equal(log.reason, "deployment/openclaw-enterprise-api readiness");
    assert.deepEqual(log.lines, [
      "startup: configured role still has bindings",
      "[redacted credential-bearing line]",
    ]);
    assert.equal(log.snapshots[0].pods[0].uid, "api-uid");
    assert.equal(log.snapshots[0].pods[0].containers[0].waitingReason, "CrashLoopBackOff");
    if (earlyLogExit) {
      assert.equal(log.snapshots[0].unavailable, true);
      assert.deepEqual(log.snapshots[0].events, []);
      assert.match(log.stream.error, /ContainerCreating/);
    } else {
      assert.equal(log.snapshots[0].events[0].reason, "BackOff");
    }
    assert.doesNotMatch(
      text,
      /private-env|private-header|synthetic-pem-body-marker|opaque-long-value-/,
    );
    const commands = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
    for (const args of commands.filter((args) => !args.includes("--raw"))) {
      assert.equal(args[args.indexOf("--namespace") + 1], namespace);
    }
    const recovered = commands.filter(
      (args) => args.includes("logs") && !args.includes("--follow=true"),
    );
    assert.equal(recovered.length, earlyLogExit ? 1 : 0);
    const reads = commands.filter((args) => args.includes("pods"));
    assert.equal(reads.length, 2);
    for (const args of reads) {
      assert.equal(
        args[args.indexOf("-l") + 1],
        Object.entries(labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(","),
      );
    }
    assert.deepEqual(
      (await readdir(clusterDirectory)).filter((name) => name.startsWith("container-logs-")),
      [],
    );
    // A direct local run has no CI record directory. Its diagnostic must be just as
    // redacted, and failed diagnostic reads must not replace the readiness error.
    if (!earlyLogExit) {
      await rm(deleted);
    }
    const directEnv = runnerEnv({
      PATH: `${bin}:${process.env.PATH}`,
      OCC_TEST_EVENT_VALUE: eventValue,
    });
    delete directEnv.NODE_TEST_CONTEXT;
    delete directEnv.OPENCLAW_CI_CONTAINER_LOG_DIR;
    const direct = spawnSync(
      process.execPath,
      ["--test", join(root, "tests/integration/startup.test.mjs")],
      {
        cwd: root,
        env: directEnv,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.equal(direct.status, 1, direct.stderr);
    assert.match(
      direct.stdout,
      /timed out waiting for the condition on deployments\/openclaw-enterprise-api/,
    );
    if (earlyLogExit) {
      assert.match(direct.stdout, /"unavailable":true/);
    } else {
      assert.match(direct.stdout, /Back-off restarting failed container api/);
    }
    assert.match(direct.stdout, /startup: configured role still has bindings/);
    assert.doesNotMatch(
      direct.stdout + direct.stderr,
      /private-env|private-header|synthetic-pem-body-marker|opaque-long-value-/,
    );
  });
}

describe("tests that wait out real runner limits, side by side", { concurrency: true }, () => {
  for (const args of waitingTests) {
    test(...args);
  }
});

test("native proof diagnoses real file failures without disclosing program output", async (t) => {
  const directory = await temporaryDirectory(t, "native-proof-diagnostic-");
  const toolPrefix = "FIRST_AGENT_NATIVE_TOOL ";
  const privateName = "private-native-proof-file";
  const workspaceFile = { path: join(directory, privateName) };
  await writeFile(workspaceFile.path, "private-workspace-content");
  for (const [name, createSessionFile, operation, errorCode] of [
    ["duplicate", true, "write-session-file", "EEXIST"],
    ["missing-session", false, "read-session-file", "ENOENT"],
    ["missing-workspace", true, "read-workspace-file", "ENOENT"],
    ["success", true, undefined, undefined],
    ["reuse", false, undefined, undefined],
  ]) {
    const sessionFile = { path: join(directory, name) };
    if (name === "duplicate") {
      await writeFile(sessionFile.path, "keep-existing-session");
    } else if (name === "reuse") {
      await writeFile(sessionFile.path, "private-session-content");
    }
    // Run the same generated program as the native model prompt against actual
    // files. Only the recorded Code Mode envelope is supplied to the decoder.
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        nativeWorkerProofProgram({
          sessionFile,
          sessionFileContent: "private-session-content",
          toolPrefix,
          createSessionFile,
          workspaceFile:
            name === "missing-workspace" ? { path: workspaceFile.path + "-absent" } : workspaceFile,
        }),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, operation ? 1 : 0, name);
    const evidence = nativeWorkerHistoryEvidence({
      runId: "selected",
      toolPrefix,
      marker: "expected-final",
      messages: [
        {
          role: "toolResult",
          toolName: "exec",
          isError: false,
          content: JSON.stringify({
            value: { aggregated: result.stdout + result.stderr, exitCode: result.status },
          }),
          __openclaw: { runId: "selected" },
        },
      ],
    });
    const diagnostic = nativeFirstAgentProofDiagnostic("model-history", evidence.observation);
    assert.equal(diagnostic.worker.historyExecNestedExitCode, result.status, name);
    assert.equal(diagnostic.worker.historyExecFailureOperation, operation, name);
    assert.equal(diagnostic.worker.historyExecFailureCode, errorCode, name);
    assert.equal(Boolean(evidence.tool), !operation, name);
    assert.equal(Boolean(evidence.final), false, name);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-|keep-existing|Error:|\bat /);
    if (operation) {
      assert.doesNotMatch(result.stdout + result.stderr, /private-|keep-existing|Error:|\bat /);
    } else {
      const proof = JSON.parse(result.stdout.slice(toolPrefix.length));
      assert.equal(
        proof.sessionFileSha256,
        createHash("sha256").update("private-session-content").digest("hex"),
      );
      assert.equal(
        proof.workspaceFileSha256,
        createHash("sha256").update("private-workspace-content").digest("hex"),
      );
    }
  }
  assert.equal(await readFile(join(directory, "duplicate"), "utf8"), "keep-existing-session");
});

test("native history proof keeps exact run, explicit success and marker predicates", () => {
  const prefix = "FIRST_AGENT_NATIVE_TOOL ";
  const marker = "FIRST_AGENT_NATIVE_expected";
  const output = prefix + JSON.stringify({ hostname: "private-host", content: "private-value" });
  const tool = {
    role: "toolResult",
    toolName: "exec",
    isError: false,
    content: output,
    __openclaw: { runId: "selected" },
  };
  const final = {
    role: "assistant",
    stopReason: "stop",
    content: marker,
    __openclaw: { runId: "selected" },
  };
  for (const [name, messages, toolPresent, finalPresent, flag] of [
    ["valid", [tool, final], true, true, "false"],
    [
      "wrapped",
      [{ ...tool, content: JSON.stringify({ value: { aggregated: output } }) }, final],
      true,
      true,
      "false",
    ],
    ["missing flag", [{ ...tool, isError: undefined }, final], false, true, "absent"],
    ["error", [{ ...tool, isError: true }, final], false, true, "true"],
    ["invalid flag", [{ ...tool, isError: 0 }, final], false, true, "other"],
    ["source echo", [{ ...tool, content: "command: " + output }, final], false, true, "false"],
    ["wrong run", [{ ...tool, __openclaw: { runId: "other" } }, final], false, true, "none"],
    ["wrong marker", [tool, { ...final, content: "Done: " + marker }], true, false, "false"],
    ["unsupported content", [{ ...tool, content: { output } }, final], false, true, "false"],
    [
      "unrecognized envelope",
      [{ ...tool, content: JSON.stringify({ output }) }, final],
      false,
      true,
      "false",
    ],
    [
      "tool continuation",
      [tool, { ...final, content: [{ type: "text", text: marker }, { type: "toolCall" }] }],
      true,
      false,
      "false",
    ],
  ]) {
    const evidence = nativeWorkerHistoryEvidence({
      messages,
      runId: "selected",
      toolPrefix: prefix,
      marker,
    });
    assert.equal(Boolean(evidence.tool), toolPresent, name);
    assert.equal(Boolean(evidence.final), finalPresent, name);
    assert.equal(evidence.observation.historyExecErrorFlag, flag, name);
    if (name === "source echo") {
      assert.equal(evidence.observation.historyToolPrefixContainsCount, 1);
      assert.equal(evidence.observation.historyToolPrefixCount, 0);
    }
    if (name === "wrong marker") {
      assert.equal(evidence.observation.historyFinalMarkerContainsCount, 1);
      assert.equal(evidence.observation.historyFinalMarkerCount, 0);
    }
    if (name === "unsupported content") {
      assert.equal(evidence.observation.historyOtherContentCount, 1);
      assert.equal(evidence.observation.historyExecNonemptyTextCount, 0);
    }
    if (name === "unrecognized envelope") {
      assert.equal(evidence.observation.historyExecOtherJsonCount, 1);
      assert.equal(evidence.observation.historyExecAggregatedCount, 0);
    }
    assert.doesNotMatch(
      JSON.stringify(evidence.observation),
      /private-host|private-value|FIRST_AGENT_NATIVE/,
    );
  }
  // Code Mode can succeed without producing the requested shell proof. Source
  // mentions and nested exit codes remain observations, never proof predicates.
  for (const [exitCode, aggregated] of [
    ...[0, 2, undefined, null, "0", 0.5].map((code) => [code, "private-output"]),
    [0, undefined],
    [2, null],
    [0, ""],
  ]) {
    const call = {
      ...final,
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: { code: `console.log(${JSON.stringify(prefix)}); // private-code` },
        },
      ],
    };
    const result = {
      ...tool,
      content: JSON.stringify({ value: { aggregated, exitCode } }),
    };
    const evidence = nativeWorkerHistoryEvidence({
      messages: [
        call,
        result,
        { ...final, content: "Done" },
        { ...call, __openclaw: { runId: "other" } },
        { ...result, __openclaw: { runId: "other" } },
      ],
      runId: "selected",
      toolPrefix: prefix,
      marker,
    });
    assert.equal(evidence.observation.historyExecCodeStringCount, 1);
    assert.equal(evidence.observation.historyExecCodeToolPrefixContainsCount, 1);
    assert.equal(evidence.observation.historyExecCommandStringCount, 0);
    assert.equal(
      evidence.observation.historyExecNestedExitZeroCount,
      exitCode === 0 && typeof aggregated === "string" ? 1 : 0,
    );
    assert.equal(
      evidence.observation.historyExecNestedExitNonzeroCount,
      exitCode === 2 && typeof aggregated === "string" ? 1 : 0,
    );
    assert.equal(evidence.observation.historyToolProofPresent, false);
    assert.equal(evidence.observation.historyFinalProofPresent, false);
    assert.doesNotMatch(JSON.stringify(evidence.observation), /private-|FIRST_AGENT_NATIVE/);
  }
  // Only a single recognized failing result may contribute bounded categories.
  // Unmarked pre-Node failures and hostile/ambiguous markers remain unclassified.
  const failureLine =
    'FIRST_AGENT_NATIVE_FAILURE {"operation":"read-session-file","code":"ENOENT"}';
  for (const [exitCode, aggregated] of [
    [1, "private-shell-error"],
    [1, 'FIRST_AGENT_NATIVE_FAILURE {"operation":"private-path","code":"ENOENT"}'],
    [1, 'FIRST_AGENT_NATIVE_FAILURE {"operation":"read-session-file","code":"private-error"}'],
    [1, "FIRST_AGENT_NATIVE_FAILURE {invalid"],
    [1, "command: " + failureLine],
    [1, failureLine + "\n" + failureLine],
    [1, failureLine + "\nFIRST_AGENT_NATIVE_FAILURE {invalid"],
    [1, failureLine + '\nFIRST_AGENT_NATIVE_FAILURE {"operation":"private-path","code":"ENOENT"}'],
    [1, failureLine + "\nFIRST_AGENT_NATIVE_FAILURE " + "x".repeat(256)],
    [0, failureLine],
    [256, failureLine],
    [-1, failureLine],
  ]) {
    const evidence = nativeWorkerHistoryEvidence({
      messages: [{ ...tool, content: JSON.stringify({ value: { exitCode, aggregated } }) }],
      runId: "selected",
      toolPrefix: prefix,
      marker,
    });
    const diagnostic = nativeFirstAgentProofDiagnostic("model-history", evidence.observation);
    assert.equal(diagnostic.worker.historyExecFailureOperation, undefined);
    assert.equal(diagnostic.worker.historyExecFailureCode, undefined);
    assert.equal(
      diagnostic.worker.historyExecNestedExitCode,
      exitCode >= 0 && exitCode <= 255 ? exitCode : undefined,
    );
    assert.equal(Boolean(evidence.tool), false);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-|FIRST_AGENT_NATIVE/);
  }
  // Peer-supplied part names and command arguments must not become diagnostic values.
  const command = "private-command";
  const observed = nativeWorkerHistoryEvidence({
    runId: "selected",
    toolPrefix: prefix,
    marker,
    command,
    messages: [
      {
        ...final,
        content: [
          { type: "toolCall", name: "exec", arguments: { command } },
          { type: "toolCall", name: "exec", arguments: { command: "other-private-command" } },
          { type: "text", text: "private-text" },
          { type: "private-part-type", value: "private-value" },
        ],
      },
      {
        ...tool,
        content: [{ type: "text", text: JSON.stringify({ value: { aggregated: output } }) }],
      },
      // An unrelated run cannot affect command or shape evidence.
      {
        ...final,
        content: [{ type: "toolCall", name: "exec", arguments: { command } }],
        __openclaw: { runId: "other" },
      },
    ],
  });
  assert.equal(observed.observation.historyArrayContentCount, 2);
  assert.equal(observed.observation.historyTextPartCount, 2);
  assert.equal(observed.observation.historyToolCallPartCount, 2);
  assert.equal(observed.observation.historyOtherPartCount, 1);
  assert.equal(observed.observation.historyExecCallCount, 2);
  assert.equal(observed.observation.historyExecCommandStringCount, 2);
  assert.equal(observed.observation.historyExecExactCommandCount, 1);
  assert.equal(observed.observation.historyExecNonemptyTextCount, 1);
  assert.equal(observed.observation.historyExecAggregatedCount, 1);
  assert.equal(observed.observation.historyAssistantNonemptyTextCount, 1);
  assert.doesNotMatch(JSON.stringify(observed.observation), /private-|FIRST_AGENT_NATIVE/);
});

test("native placement retries only the correlated pinned read-generation signal", async () => {
  const message = "Error: Session changed while preparing its description; retry the request";
  const error = Object.assign(new Error(message), { code: "UNAVAILABLE" });
  assert.equal(nativePlacementReadRetryable(error, true), true);
  assert.equal(
    nativePlacementReadRetryable(error, false),
    false,
    "local/transport errors cannot opt into a retry by text",
  );
  for (const rejected of [
    Object.assign(new Error(message), { code: "FORBIDDEN" }),
    Object.assign(new Error("Session repository binding changed while preparing its description"), {
      code: "UNAVAILABLE",
    }),
    Object.assign(new Error("gateway request timed out"), { code: "UNAVAILABLE" }),
    Object.assign(new Error("private peer text"), { code: "UNAVAILABLE" }),
    Object.assign(new Error(message + "; private suffix"), { code: "UNAVAILABLE" }),
  ]) {
    assert.equal(nativePlacementReadRetryable(rejected, true), false);
  }
  const observed = await collectNativeWorkerFailure({
    error,
    elapsedMs: 1,
    request: async (method) => {
      assert.equal(method, "node.list");
      return { nodes: [] };
    },
  });
  assert.equal(
    observed.proofError,
    "session-read-changed",
    "pre-turn failures must retain safe classification",
  );
  assert.doesNotMatch(JSON.stringify(observed), /Session changed|private peer/);
});
