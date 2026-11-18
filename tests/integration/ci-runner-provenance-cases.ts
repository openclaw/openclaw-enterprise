import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { exercisedLaneStatus } from "../../scripts/ci/full-integration-coverage.ts";
import { readRuntimeProvenance } from "../../scripts/ci/runtime-provenance.ts";
import {
  projectSkipperRunnerReceipt,
  skipperFailureSummary,
} from "../../scripts/ci/skipper-release.ts";
import {
  createRunnerFixture as fixture,
  laneArgs,
  procStat,
  runnerEnv,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { writeRunnerPrepareFixture } from "./ci-runner-manifest-cases.ts";
import {
  firstRunnerRecord,
  parseRunnerRecord,
  runnerRecord,
  runnerRecords,
  runnerText,
} from "./ci-runner-result-records.ts";

type ChildExit = Pick<SpawnSyncReturns<string>, "status" | "signal">;

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function recordedSkipperTestError(summary: Record<string, unknown>) {
  const file = firstRunnerRecord(summary.files, "Skipper file result");
  const tests = runnerRecords(file.tests, "Skipper test results");
  const failed = tests.find(({ status }) => status === "failed");
  return runnerRecord(failed?.error, "Skipper test error");
}

export function registerProvenanceCases() {
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
    const cleanedReceipt = (value: Parameters<typeof projectSkipperRunnerReceipt>[0]) => ({
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
    const malformedTest = malformed.files[0]?.tests[0];
    assert(malformedTest);
    malformedTest.name = canary;
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

  test("checkout build failures retain safe process details through the CI reporter", async (t) => {
    const root = await fixture(t);
    const path = "tests/integration/build-failure.test.mjs";
    const statePath = join(root, "state/build.jsonl");
    const resultsPath = join(root, "results/build.json");
    const provider = pathToFileURL(join(repositoryRoot, "tests/helpers/dev-up-model-provider.ts"));
    // This canary is deliberately not an environment secret. The helper must
    // omit child output before the existing reporter/redaction boundary.
    const privateOutput = "private-checkout-build-output";
    await writeRunnerPrepareFixture(root);
    await writeRunnerManifest(root, {
      lanes: { "build-failure": { files: [{ path }] } },
      groups: {},
    });
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
    const result = runRunnerSync(laneArgs(root, "build-failure", statePath, resultsPath));
    assert.equal(result.status, 1, result.stderr);
    const raw = await readFile(resultsPath, "utf8");
    const details = await readFile(`${statePath}.diagnostics.json`, "utf8");
    const summary = parseRunnerRecord(raw, "checkout failure result");
    assert.equal(runnerRecord(summary.counts, "lane counts").failed, 1);
    const file = firstRunnerRecord(summary.files, "file result");
    const failure = firstRunnerRecord(file.tests, "checkout failure");
    const message = runnerText(
      runnerRecord(failure.error, "test error").message,
      "test error message",
    );
    assert.match(
      message,
      /controller: exit=23 code=unknown signal=unknown killed=false elapsedMs=\d+ budgetMs=600000/,
    );
    assert.match(
      message,
      /runtime: exit=47 code=unknown signal=unknown killed=false elapsedMs=\d+ budgetMs=600000/,
    );
    const diagnostics = parseRunnerRecord(details, "diagnostics");
    const fileDetail = firstRunnerRecord(diagnostics.failures, "diagnostic failure");
    assert.equal(firstRunnerRecord(fileDetail.tests, "diagnostic test").message, message);
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
    ] as const) {
      await t.test(scenario, async (t) => {
        const runnerRoot = join(await fixture(t), "private-source-canary");
        await mkdir(join(runnerRoot, "tests/integration"), { recursive: true });
        // The installed summary uses process.cwd(), which resolves the runner root's symlinks.
        const root = await realpath(runnerRoot);
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
              scenario.startsWith("nested")
                ? 'runSkipperOperation("gateway-exec", child)'
                : "child()"
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
        await writeRunnerManifest(root, {
          lanes: { installed: { files: [{ path, expectedTests: [name] }] } },
          groups: {
            ci: ["installed"],
          },
        });
        const result = runRunnerSync([
          "run",
          "installed",
          "--root",
          runnerRoot,
          "--manifest",
          "manifest.json",
          "--state",
          "state/installed.json",
          "--results",
          "results/installed.json",
        ]);
        assert.equal(result.status, 1);
        const raw = await readFile(join(root, "results/installed.json"), "utf8");
        const summary = parseRunnerRecord(raw, "Skipper result");
        const file = firstRunnerRecord(summary.files, "Skipper file result");
        const tests = runnerRecords(file.tests, "Skipper test results");
        const installed = firstRunnerRecord(tests, "installed journey");
        const installedDiagnostic = () =>
          runnerRecord(installed.error, "installed journey error").diagnostic;
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
          assert.deepEqual(installedDiagnostic(), {
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
          assert.deepEqual(installedDiagnostic(), {
            kind: "skipper-operation",
            operation: "gateway-chat",
            httpStatus: 200,
            gatewayCategory: "response-json",
          });
        } else if (scenario === "unrecognized outcome") {
          assert.equal(
            diagnostic,
            "location unavailable, ERR_TEST_FAILURE, operation=gateway-chat",
          );
          assert.deepEqual(installedDiagnostic(), {
            kind: "skipper-operation",
            operation: "gateway-chat",
          });
        } else {
          assert.ok(diagnostic.endsWith(`, ${category}`));
        }
        if (scenario === "unrecognized operation") {
          assert.equal(installedDiagnostic(), undefined);
          assert.equal(diagnostic, "location unavailable, ERR_TEST_FAILURE");
        }
        if (scenario === "assertion" || scenario === "rejection") {
          assert.match(diagnostic, /^skipper-prepared-git-installed\.test\.mjs:5:\d+, /);
          assert.ok(
            runnerRecords(summary.issues, "Skipper result issues").some(
              (entry) => entry.code === "expected-test-not-passed",
            ),
          );
        } else if (scenario === "file failure") {
          assert.equal(installed.status, "passed");
          assert.ok(file.fileFailure);
        }
        assert.doesNotMatch(
          diagnostic,
          /secretauthvalue|private-source-canary|expected|installed journey/,
        );

        const failed =
          tests.find((entry) => entry.status === "failed") ??
          runnerRecord(file.fileFailure, "Skipper file failure");
        const error = runnerRecord(failed.error, "Skipper failure error");
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
          ] as const) {
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
          const selected = recordedSkipperTestError(malformed);
          delete selected.message;
          delete selected.frame;
          for (const field of ["cause", "location"]) {
            const invalid = structuredClone(malformed);
            recordedSkipperTestError(invalid)[field] = "invalid";
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
        if (file.fileFailure) {
          runnerRecord(file.fileFailure, "Skipper file failure").diagnosticKind =
            "secretauthvalue-category";
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

  test(
    "memory samples identify renamed processes without exposing executable paths or arguments",
    { skip: process.platform !== "linux" && "reads /proc" },
    async (t) => {
      const root = await fixture(t);
      const bin = join(root, "bin");
      const output = join(root, "memory.log");
      await mkdir(bin);
      const stat = procStat(process.pid);
      assert(stat, "Expected the sampler parent in /proc");
      const { pgid } = stat;
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
      let stdout = "";
      let stderr = "";
      let sawFirstSummary = false;
      let stopTimer: NodeJS.Timeout | undefined;
      const stop = () => {
        child.kill("SIGTERM");
        stopTimer = setTimeout(() => {
          child.kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
        }, 5_000);
      };
      // The sampler appends the first sample before printing its summary. Give
      // startup time to finish, then let Bash's trap dispose of the pending sleep.
      const startupTimer = setTimeout(stop, 30_000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stopTimer === undefined && /^memory-sampler .+\n/m.test(stdout)) {
          sawFirstSummary = true;
          clearTimeout(startupTimer);
          stop();
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      let childError: Error | undefined;
      child.on("error", (error) => {
        childError = error;
      });
      // Await pipe closure and the actual exit before fixture cleanup can run.
      const { status, signal } = await new Promise<ChildExit>((resolvePromise) => {
        child.once("close", (status, signal) => resolvePromise({ status, signal }));
      }).finally(() => {
        clearTimeout(startupTimer);
        clearTimeout(stopTimer);
      });
      if (childError) {
        throw childError;
      }
      assert.ok(
        sawFirstSummary,
        `Expected the first memory summary (exit ${status}, signal ${signal})`,
      );
      assert.deepEqual({ status, signal }, { status: 0, signal: null } satisfies ChildExit);
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
}
