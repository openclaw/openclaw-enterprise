import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  createRunnerFixture,
  laneArgs,
  runnerArtifactPaths,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";

interface RunnerIssue {
  code: string;
  error?: unknown;
}

interface RunnerSummary {
  issues: RunnerIssue[];
  files: {
    cleanup: { status: string } | null;
    issues: RunnerIssue[];
    nodeExitCode: number | null;
    status: string;
    tests: unknown[];
  }[];
  counts: { passed: number; skipped: number };
}

interface PreparationDiagnostics {
  failures: {
    file: string;
    reason: string;
    error: { name: string; message: string; stack: string };
  }[];
}

test("invalid prepared defaults keep bounded cleanup and its failure without starting a child", async (t) => {
  const root = await createRunnerFixture(t);
  const files = ["clean", "failed-cleanup"].map((name) => `tests/integration/${name}.test.mjs`);
  for (const file of files) {
    await writeFile(join(root, file), 'throw new Error("child must not start");\n');
  }
  await writeRunnerManifest(root, {
    lanes: { "invalid-defaults": { files: files.map((path) => ({ path })) } },
  });
  // Invalid defaults must still leave the runner responsible for both owned paths.
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    `
import { writeFile, rm } from "node:fs/promises";
export async function prepareFile({ file }) {
  const name = file.path.endsWith("failed-cleanup.test.mjs") ? "failed-cleanup" : "clean";
  const owned = new URL("../../" + name, import.meta.url);
  await writeFile(owned, "owned resource");
  return { defaults: { FLAG: 1 }, cleanup: async () => {
    await rm(owned);
    if (name === "failed-cleanup") throw new Error("cleanup failure");
  } };
}
`,
  );
  const result = runRunnerSync(
    laneArgs(root, "invalid-defaults", "state/lane.json", "results/defaults.json"),
  );
  assert.equal(result.status, 1);
  const summary: RunnerSummary = JSON.parse(
    await readFile(join(root, "results/defaults.json"), "utf8"),
  );
  assert.deepEqual(
    summary.files.map((file) => file.cleanup?.status),
    ["passed", "failed"],
  );
  assert.equal(summary.issues.filter(({ code }) => code === "prepare-failed").length, 2);
  assert.equal(summary.issues.filter(({ code }) => code === "cleanup-failed").length, 1);
  assert.ok(summary.files.every((file) => file.nodeExitCode === null && file.tests.length === 0));
  for (const name of ["clean", "failed-cleanup"]) {
    await assert.rejects(readFile(join(root, name)), { code: "ENOENT" });
  }
});

test("run records a preparation failure's redacted message in the diagnostics report", async (t) => {
  const root = await createRunnerFixture(t);
  const { statePath, resultsPath } = runnerArtifactPaths(root, "prepare");
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    [
      'import { writeFile } from "node:fs/promises";',
      "export async function prepareFile({ file, statePath }) {",
      "  if (file.path.endsWith('broken.test.mjs')) {",
      "    // The lane state's env holds prepared values the job env never had.",
      "    await writeFile(statePath, JSON.stringify({ env: { OCC_TEST_STATE_IMAGE: 'stateonlyopaque-image-ref' }, defaults: { OCC_TEST_SELECTED_IMAGE: 'selectedopaque-image-ref' } }));",
      `    const pullUrl = ${JSON.stringify(syntheticCredentialUrl({ username: "user", password: "hunter2pass", host: "registry.example", port: undefined, pathname: "/x" }))};`,
      "    const error = new Error(",
      "      `image import failed for ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL} stateonlyopaque-image-ref selectedopaque-image-ref\\nAuthorization: Bearer abcdefghijklmnop0123\\npull ${pullUrl}`,",
      "    );",
      "    error.stderr = 'child output secretauthvalue-stderr';",
      "    throw error;",
      "  }",
      "  return {};",
      "}",
      "",
    ].join("\n"),
  );
  for (const name of ["broken", "fine"]) {
    await writeFile(
      join(root, `tests/integration/${name}.test.mjs`),
      'import test from "node:test";\ntest("runs", () => {});\n',
    );
  }
  await writeRunnerManifest(root, {
    lanes: {
      prepare: {
        files: [
          { path: "tests/integration/broken.test.mjs" },
          { path: "tests/integration/fine.test.mjs" },
        ],
      },
    },
  });

  const result = runRunnerSync(laneArgs(root, "prepare", statePath, resultsPath));

  assert.equal(result.status, 1);
  const summary: RunnerSummary = JSON.parse(await readFile(resultsPath, "utf8"));
  // Results keep the closed contract.
  const prepareIssue = summary.issues.find((entry) => entry.code === "prepare-failed");
  assert.deepEqual(prepareIssue?.error, { name: "Error" });
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  assert.doesNotMatch(
    text,
    /secretauthvalue|abcdefghijklmnop0123|hunter2pass|stateonlyopaque|selectedopaque/,
  );
  const report: PreparationDiagnostics = JSON.parse(text);
  assert.equal(report.failures.length, 1);
  const [record] = report.failures;
  assert.ok(record);
  assert.equal(record.file, "tests/integration/broken.test.mjs");
  assert.equal(record.reason, "prepare");
  assert.equal(record.error.name, "Error");
  assert.equal(
    record.error.message,
    "image import failed for [env:CI_RUNNER_FIXTURE_CREDENTIAL] [env:OCC_TEST_STATE_IMAGE] [env:OCC_TEST_SELECTED_IMAGE]\n[redacted credential-bearing line]\n[redacted credential-bearing line]",
  );
  assert.match(record.error.stack, /^at prepareFile \(.*scripts\/ci\/prepare\.mjs:7:\d+\)/);
});

interface PreparationCommandDetails {
  stage: "database-create" | "database-schema" | "database-migrate";
  failure: "exit" | "spawn" | "query" | "connect" | "signal" | "timeout";
  exitCode?: number | null;
  signal?: "SIGTERM" | "SIGKILL" | null;
  timedOut?: boolean;
}

const commandFailureCode = "CI_PREPARATION_COMMAND_FAILED";
const acceptedDetails: PreparationCommandDetails[] = [
  { stage: "database-create", failure: "exit", exitCode: 42, signal: null, timedOut: false },
  { stage: "database-schema", failure: "spawn" },
  // The lane's direct database connection has no process exit code or signal.
  { stage: "database-create", failure: "query", timedOut: false },
  { stage: "database-schema", failure: "connect" },
  {
    stage: "database-migrate",
    failure: "signal",
    exitCode: null,
    signal: "SIGTERM",
    timedOut: false,
  },
  {
    stage: "database-migrate",
    failure: "timeout",
    exitCode: null,
    signal: "SIGKILL",
    timedOut: true,
  },
];

for (const scenario of [
  ...acceptedDetails.map((details) => ({
    name: details.failure,
    input: { code: commandFailureCode, ...details },
    expected: { name: "Error", code: commandFailureCode, ...details },
  })),
  {
    name: "unknown error",
    input: {
      code: "secret-canary-code",
      stage: "database-create",
      failure: "exit",
    },
    expected: { name: "Error" },
  },
  {
    name: "unknown stage",
    input: { code: commandFailureCode, stage: "secret-canary-stage", failure: "exit" },
    expected: { name: "Error" },
  },
  {
    name: "unknown failure",
    input: {
      code: commandFailureCode,
      stage: "database-create",
      failure: "secret-canary-failure",
    },
    expected: { name: "Error" },
  },
  {
    name: "invalid details",
    input: {
      code: commandFailureCode,
      stage: "database-schema",
      failure: "exit",
      exitCode: 256,
      signal: "secret-canary-signal",
      timedOut: "secret-canary-timeout",
    },
    expected: {
      name: "Error",
      code: commandFailureCode,
      stage: "database-schema",
      failure: "exit",
    },
  },
]) {
  test(`run retains safe preparation ${scenario.name} diagnostics without starting tests`, async (t) => {
    const root = await createRunnerFixture(t);
    await writeSingleFileRunnerLane(
      root,
      "preparation",
      "tests/integration/unstarted.test.mjs",
      'import { writeFileSync } from "node:fs"; writeFileSync(new URL("../../started", import.meta.url), "started");\n',
    );
    const payload = {
      name: "secret-canary-name",
      message: "secret-canary-message",
      command: "secret-canary-command",
      args: ["secret-canary-argv"],
      url: "https://secret-canary-url.invalid",
      env: { KEY: "secret-canary-env" },
      stdout: "secret-canary-stdout",
      stderr: "secret-canary-stderr",
      stack: "secret-canary-stack",
      ...scenario.input,
    };
    await writeJson(join(root, "scripts/ci/preparation-error.json"), payload);
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      `
import { readFile } from "node:fs/promises";
export async function prepareFile() {
  const payload = JSON.parse(
    await readFile(new URL("./preparation-error.json", import.meta.url), "utf8"),
  );
  throw Object.assign(new Error(), payload);
}
`,
    );
    const result = runRunnerSync(
      laneArgs(root, "preparation", "state/lane.json", "results/preparation.json"),
    );
    assert.equal(result.status, 1, result.stderr);
    const artifact = await readFile(join(root, "results/preparation.json"), "utf8");
    const summary: RunnerSummary = JSON.parse(artifact);
    const [file] = summary.files;
    assert.ok(file);
    assert.deepEqual(
      file.issues.find(({ code }) => code === "prepare-failed")?.error,
      scenario.expected,
    );
    assert.equal(file.status, "failed");
    assert.equal(file.nodeExitCode, null);
    assert.deepEqual(file.tests, []);
    assert.equal(summary.counts.passed, 0);
    assert.equal(summary.counts.skipped, 0);
    assert.equal(file.cleanup, null);
    await assert.rejects(readFile(join(root, "started")), { code: "ENOENT" });
    assert.doesNotMatch(artifact + result.stdout + result.stderr, /secret-canary/);
  });
}
