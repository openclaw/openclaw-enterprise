import { loadTestSuites } from "../../scripts/ci/test-suites.mjs";
import { prepareGatewayRouting } from "../../scripts/ci/routing.mjs";
import { readRuntimeProvenance } from "../../scripts/ci/runtime-provenance.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { describe } from "node:test";
import { exercisedLaneStatus } from "../../scripts/ci/full-integration-coverage.ts";
import {
  projectSkipperRunnerReceipt,
  skipperFailureSummary,
} from "../../scripts/ci/skipper-release.ts";
import {
  createRunnerFixture as fixture,
  currentSha,
  heldClock,
  killRecordedProcessGroupMembers,
  laneArgs,
  procStat,
  requireTestResult,
  runnerArtifactPaths,
  runnerEnv,
  runRunnerAsync,
  runRunnerSync,
  unkilled,
  waitFor,
  writeJson,
  writeRunnerLaneFiles,
  writeRunnerManifest,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";
import { finiteConversationScenarios } from "../fixtures/ci-runner-finite-conversation.ts";
import {
  assertRepositorySetupDiagnostics,
  repositorySetupDiagnosticCases,
} from "../fixtures/ci-runner-repository-setup-diagnostics.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { registerCompleteLifecycleCases } from "./ci-runner-complete-lifecycle-cases.ts";
import {
  checkBoundedAgentNamespaceActivity,
  checkControllerReadinessEvidence,
  checkFailedWaitContainerLog,
  checkMixedPrecisionEventOrder,
} from "./ci-runner-k3d-diagnostics-cases.ts";
import { checkAllowlistedMeasurements } from "./ci-runner-measurements-case.ts";
import { registerNativeWorkerProofCases } from "./ci-runner-native-worker-proof-cases.ts";
import {
  collectNativeWorkerFailure,
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

// These tests wait out a real runner timeout, lane deadline or cleanup allowance: seconds
// each, at almost no CPU. Each duration stays as it is, long enough for a loaded host to
// reach the state the test needs before it elapses, or the runner's clock waits for that
// state (see heldClock). Instead they run side by side, after the rest of the file (see
// the describe at its end), so the file waits about as long as the longest of them rather
// than their sum. Each has its own fixture root, state and lock files, and starts the
// runner with runRunnerAsync.
const waitingTests = [];

function waitingTest(...args) {
  waitingTests.push(args);
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

registerCompleteLifecycleCases();

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
    const result = await runRunnerAsync(
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
  const repositorySetupCases = repositorySetupDiagnosticCases(secret);

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
        ...repositorySetupCases.map(({ name, diagnostic }) => ({ name, diagnostic })),
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
  const tests = summary.files[0].tests;
  assert.equal(tests[0].name, "redacted failure locator");
  assert.equal(tests[0].line, 3);
  const failure = tests[0].error;
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
  const customFailure = requireTestResult(tests, "redacted custom error");
  assert.equal(customFailure.status, "failed");
  assert.equal(customFailure.error.cause, undefined);
  assert.equal(customFailure.error.location.line, 14);
  assert.equal(customFailure.error.message, "[env:CI_RUNNER_FIXTURE_CREDENTIAL]-message");
  assert.equal(
    requireTestResult(tests, "job env redaction").error.message,
    "owner openclaw-public-owner [env:OCC_TEST_STRIPPED_VALUE]",
  );
  const httpFailure = requireTestResult(tests, "allowlisted controller HTTP diagnostic");
  assert.deepEqual(httpFailure.error.diagnostic, {
    kind: "controller-http",
    status: 503,
    expectedStatus: 201,
    occErrorCode: "DEPENDENCY_UNAVAILABLE",
    upstream: { kind: "chatgpt-admin-http", operation: "create-service-account", status: 403 },
  });
  const unsafeFailure = requireTestResult(tests, "rejects unsafe controller HTTP diagnostic");
  assert.equal(unsafeFailure.error.diagnostic, undefined);
  const installationStatusFailure = requireTestResult(
    tests,
    "allowlisted observability installation status diagnostic",
  );
  assert.deepEqual(installationStatusFailure.error.diagnostic, {
    kind: "observability-installation-status",
    status: 503,
    expectedStatus: 401,
  });
  const unsafeInstallationStatusFailure = requireTestResult(
    tests,
    "rejects unsafe observability installation status diagnostic",
  );
  assert.equal(unsafeInstallationStatusFailure.error.diagnostic, undefined);
  const logExportFailure = requireTestResult(
    tests,
    "allowlisted observability log export diagnostic",
  );
  assert.deepEqual(logExportFailure.error.diagnostic, {
    kind: "observability-log-export",
    api: true,
    worker: false,
  });
  const unsafeLogExportFailure = requireTestResult(
    tests,
    "rejects unsafe observability log export diagnostic",
  );
  assert.equal(unsafeLogExportFailure.error.diagnostic, undefined);
  // Keep the failed wait identifiable without exposing arbitrary runtime output.
  for (const stage of ["ready-status", "warning-status", "initial-rollout"]) {
    const failure = requireTestResult(tests, stage);
    assert.deepEqual(failure.error.diagnostic, { kind: "kubernetes-plugin-status", stage });
  }
  const rolloutFailure = requireTestResult(tests, "warning-rollout");
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
  const unsafeStage = requireTestResult(tests, "unsafe plugin stage");
  assert.equal(unsafeStage.error.diagnostic, undefined);
  const deniedTraffic = requireTestResult(tests, "allowlisted denied traffic diagnostic");
  assert.deepEqual(deniedTraffic.error.diagnostic, {
    kind: "network-policy",
    stage: "Agent outbound platform traffic",
  });
  const unsafeTraffic = requireTestResult(tests, "rejects unsafe denied traffic diagnostic");
  assert.equal(unsafeTraffic.error.diagnostic, undefined);
  const stockBrokerFailure = requireTestResult(
    tests,
    "allowlisted runtime stock broker diagnostic",
  );
  assert.deepEqual(stockBrokerFailure.error.diagnostic, {
    kind: "runtime-image-stock-broker",
    stage: "broker-denial",
  });
  const unsafeStockBroker = requireTestResult(tests, "rejects unsafe runtime stock broker stage");
  assert.equal(unsafeStockBroker.error.diagnostic, undefined);
  const nativeProof = requireTestResult(tests, "retains native first-Agent proof failure stage");
  assert.equal(nativeProof.status, "failed");
  assert.deepEqual(nativeProof.error.diagnostic, {
    kind: "native-first-agent-proof",
    failureStage: "required-placement",
  });
  const terminalPlacement = requireTestResult(
    tests,
    "retains a terminal native first-Agent placement stage",
  );
  assert.deepEqual(terminalPlacement.error.diagnostic, {
    kind: "native-first-agent-proof",
    failureStage: "required-placement-terminal-reclaimed",
  });
  const retainedNative = requireTestResult(
    tests,
    "retains native worker placement observations through CI",
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
    requireTestResult(tests, "retains value-free native history observations through CI").error
      .diagnostic.worker,
    nativeHistory,
  );
  for (const [index, [exitCode]] of inconsistentNativeFailures.entries()) {
    assert.deepEqual(
      requireTestResult(tests, `rejects inconsistent native failure ${index}`).error.diagnostic
        .worker,
      exitCode === undefined ? {} : { historyExecNestedExitCode: exitCode },
    );
  }
  assert.deepEqual(
    requireTestResult(tests, "rejects hostile native worker diagnostic fields").error.diagnostic
      .worker,
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
    const turn = requireTestResult(tests, `native turn ${category}`).error.diagnostic.worker;
    assert.equal(turn.turnStatus, "error");
    assert.equal(turn.turnError, category);
    assert.equal(turn.assistantError, category);
    assert.equal(turn.execError, category);
    assert.equal(turn.proofError, "other");
    assert.equal(turn.execResultCount, 1);
    assert.equal(turn.execFailureCount, 1);
  }
  const collected = requireTestResult(
    tests,
    "collects native turn failure within the shared read budget",
  ).error.diagnostic.worker;
  assert.equal(collected.turnError, "network-connection");
  assert.equal(collected.historyLookup, "found");
  const wrapped = requireTestResult(
    tests,
    "retains wrapped native worker bootstrap causes through CI",
  ).error.diagnostic.worker;
  assert.equal(wrapped.recoveryError, "worker-deploy-artifact-missing");
  assert.equal(wrapped.terminalReason, "bundle-install-failed");
  assert.equal(wrapped.environmentError, "node-installer-disconnected");
  const fresh = requireTestResult(tests, "refreshes retained native placement").error.diagnostic
    .worker;
  assert.equal(fresh.placementLookup, "fresh");
  assert.equal(fresh.placementState, "failed");
  assert.equal(fresh.environmentState, "failed");
  assert.equal(fresh.tunnelStatus, "stopped");
  for (const name of [
    "labels fallback after failed native placement refresh",
    "rejects another session during native placement refresh",
  ]) {
    const fallback = requireTestResult(tests, name).error.diagnostic.worker;
    assert.equal(fallback.placementLookup, "fallback");
    assert.equal(fallback.placementState, "active");
    assert.equal(fallback.environmentState, "attached");
  }
  for (const [, category] of nativeLeafCases) {
    const leaf = requireTestResult(tests, `native installer ${category}`);
    assert.equal(leaf.error.diagnostic.worker.recoveryError, category);
  }
  const monitoringFailure = requireTestResult(tests, "retains safe monitoring readiness evidence");
  assert.deepEqual(monitoringFailure.error.diagnostic, {
    kind: "metrics-monitoring",
    stage: "prometheus-up",
    reason: "container-exited",
    container: "agent",
    exitCode: 2,
    lastHttpStatus: 503,
  });
  const unsafeMonitoring = requireTestResult(tests, "rejects unsafe monitoring stage");
  assert.equal(unsafeMonitoring.error.diagnostic, undefined);
  assertRepositorySetupDiagnostics(summary, repositorySetupCases);

  const unsafeNativeProof = requireTestResult(
    tests,
    "rejects unknown native first-Agent proof stage",
  );
  assert.equal(unsafeNativeProof.status, "failed");
  assert.equal(unsafeNativeProof.error.diagnostic, undefined);
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
  // The stack header names the exception, and the frame skips Node's DOMException constructor.
  for (const [name, message, line] of [
    ["timeout", "TimeoutError: The operation was aborted due to timeout", 2],
    ["abort", "AbortError: This operation was aborted", 3],
    ["empty", "Error", 4],
  ]) {
    const { error } = requireTestResult(summary.files[0].tests, name);
    assert.equal(error.message, message);
    assert.match(error.frame, new RegExp(`\\(${file.replaceAll(".", "\\.")}:${line}:\\d+\\)$`));
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
    const failure = requireTestResult(summary.files[0].tests, name);
    const detail = requireTestResult(details, name);
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
    const result = await runRunnerAsync(
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

test(
  "run keeps bounded Agent namespace activity from passing k3d files, alone and side by side",
  checkBoundedAgentNamespaceActivity,
);

test(
  "k3d diagnostics preserve equal-instant event order across precision variants",
  checkMixedPrecisionEventOrder,
);

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

test(
  "run records only allowlisted measurements from test diagnostics",
  checkAllowlistedMeasurements,
);

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
  await writeRunnerLaneFiles(
    root,
    "cancel",
    ["plain", "cancelled"],
    'import test from "node:test";\ntest("runs", () => {});\n',
  );

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

test(
  "run publishes a failed wait's followed container log, redacted, beside Agent activity",
  checkFailedWaitContainerLog,
);

for (const earlyLogExit of [false, true]) {
  test(`run retains controller readiness evidence before its fixture namespace is deleted (early log exit: ${earlyLogExit})`, (t) =>
    checkControllerReadinessEvidence(t, earlyLogExit));
}

describe("tests that wait out real runner limits, side by side", { concurrency: true }, () => {
  for (const args of waitingTests) {
    test(...args);
  }
});

registerNativeWorkerProofCases();
