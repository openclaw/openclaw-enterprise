import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { protectedText } from "../helpers/qa-secrets.mjs";

test("QA Agent reads the selected Preset in its Namespace", async (t) => {
  const { createQaAgent } = await import("../helpers/qa-installation.mjs");
  function fixture(namespaceId, presetNamespaceId = namespaceId) {
    const calls = [];
    const stopped = new Error("stop after Preset lookup");
    return {
      calls,
      stopped,
      installation: {
        retained: false,
        defaultNamespace: { id: "ns-default" },
        namespace: { id: namespaceId },
        presets: [{ id: "pre-codex", namespaceId: presetNamespaceId, name: "Standard Codex" }],
        async api(method, path) {
          calls.push({ method, path });
          throw stopped;
        },
      },
    };
  }

  for (const namespaceId of ["ns-default", "ns-compose"]) {
    await t.test(`fetches the selected Preset in ${namespaceId}`, async () => {
      const { calls, stopped, installation } = fixture(namespaceId);
      // Stop after the lookup, before credential reads or Agent creation.
      await assert.rejects(createQaAgent(installation, "Codex"), (error) => error === stopped);
      assert.deepEqual(calls, [
        { method: "GET", path: `/namespaces/${namespaceId}/presets/pre-codex` },
      ]);
    });
  }

  await t.test("refuses a Preset summary from another Namespace", async () => {
    const { calls, installation } = fixture("ns-compose", "ns-other");
    await assert.rejects(
      createQaAgent(installation, "Codex"),
      /Preset must belong to the QA Namespace/,
    );
    assert.deepEqual(calls, []);
  });

  await t.test("reports a missing Standard Preset before making a request", async () => {
    const { calls, installation } = fixture("ns-compose");
    installation.presets = [];
    await assert.rejects(
      createQaAgent(installation, "Codex"),
      /Standard Codex Preset must be available/,
    );
    assert.deepEqual(calls, []);
  });
});

test("QA credentials require a private regular file and reject symlink substitution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qa-credential-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credential = join(directory, "credential");
  await writeFile(credential, " test-only-credential\n", { mode: 0o600 });
  assert.equal(await protectedText(credential, "test credential"), "test-only-credential");

  // A path replaced with a symlink must not redirect the credential read,
  // even when its target would pass the regular-file and permission checks.
  const link = join(directory, "substituted");
  await symlink(credential, link);
  await assert.rejects(protectedText(link, "test credential"), { code: "ELOOP" });
  await assert.rejects(protectedText(directory, "test credential"), /private regular file/);
  await chmod(credential, 0o644);
  await assert.rejects(protectedText(credential, "test credential"), /private regular file/);
  await chmod(credential, 0o600);
  await writeFile(credential, " \n");
  await assert.rejects(protectedText(credential, "test credential"), /must not be empty/);
});

test(
  "parallel QA stages publish complete outcomes, failures and timings",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "qa-report-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, "matrix.json");
    const reportModule = new URL("../helpers/qa-report.mjs", import.meta.url).href;
    const secretsModule = new URL("../helpers/qa-secrets.mjs", import.meta.url).href;
    // Exercise the real reporter under node:test, including failed subtests.
    // A shared writeFile without a serialized snapshot can lose concurrent rows
    // or leave a trailing fragment of the previous JSON document.
    const source = `
    import test from 'node:test';
    import { createQaReport } from ${JSON.stringify(reportModule)};
    import { registerQaSecret } from ${JSON.stringify(secretsModule)};
    // Real runs register fixture secrets, so redaction always has work to do.
    registerQaSecret('synthetic-stage-secret-value');
    const report = createQaReport(${JSON.stringify(output)}, { scope: 'full', concurrency: 4 });
    test('parallel report', { concurrency: 4 }, async (t) => {
      await Promise.all(Array.from({length: 20}, (_, i) =>
        report.stage(t, 'compose/Codex', 'stage-' + i, async () => {
          if (i === 2) throw new Error('blocked by unavailable test prerequisite');
          if (i === 7) throw new Error('expected assertion failure');
          // A DOMException's message is getter-only; redaction must keep it.
          if (i === 11) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
          if (i === 13) throw undefined;
        }, 'scenario-' + i)
      ));
      await report.save();
    });
  `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
    let diagnostic = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        diagnostic += chunk;
      });
    }
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 1, diagnostic);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.scope, "full");
    assert.equal(report.concurrency, 4);
    assert.equal(report.outcomes.length, 20);
    assert.equal(new Set(report.outcomes.map((row) => row.scenario)).size, 20);
    for (let i = 0; i < 20; i += 1) {
      const row = report.outcomes.find((value) => value.stage === `stage-${i}`);
      assert.equal(row.cell, "compose/Codex");
      assert.equal(row.scenario, `scenario-${i}`);
      let expectedOutcome = "passed";
      if (i === 2) {
        expectedOutcome = "blocked";
      } else if (i === 7 || i === 11 || i === 13) {
        expectedOutcome = "failed";
      }
      assert.equal(row.outcome, expectedOutcome);
      assert.ok(Number.isFinite(Date.parse(row.startedAt)));
      assert.ok(Number.isInteger(row.durationMs) && row.durationMs >= 0);
    }
    assert.match(report.outcomes.find((row) => row.stage === "stage-2").reason, /blocked by/);
    assert.match(
      report.outcomes.find((row) => row.stage === "stage-7").reason,
      /expected assertion/,
    );
    assert.equal(
      report.outcomes.find((row) => row.stage === "stage-11").reason,
      "The operation was aborted due to timeout",
    );
    assert.equal(report.outcomes.find((row) => row.stage === "stage-13").reason, "undefined");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["matrix.json"]);
  },
);

test("QA selection keeps prerequisite credentials and reports omitted coverage", async () => {
  const { selectQaMatrix, validateQaInputs } = await import("../helpers/qa-selection.mjs");
  const selected = selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "model-ui,calendar" });
  assert.equal(selected.scope, "partial:selected");
  assert.deepEqual(
    selected.cells.map(({ cell, scenarios }) => ({ cell, scenarios })),
    [
      { cell: "compose/OpenClaw", scenarios: ["model-ui"] },
      { cell: "compose/Codex", scenarios: ["model-ui", "calendar"] },
      { cell: "kubernetes/OpenClaw", scenarios: ["model-ui"] },
      { cell: "kubernetes/Codex", scenarios: ["model-ui", "calendar"] },
    ],
  );
  assert.deepEqual(selected.cells[1].unselected, [
    "console-secrets",
    "git-full",
    "git-read",
    "slack",
  ]);
  assert.deepEqual(selected.cells[0].notApplicable, ["calendar", "git-read", "slack"]);
  assert.throws(() => validateQaInputs(selected, {}), /OPENAI_KEY_FILE is required/);
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "model-ui,typo" }),
    /invalid QA scenario/,
  );
  assert.throws(() => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "" }), /invalid QA scenario/);
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "calendar", OCC_TEST_QA_PRESET: "OpenClaw" }),
    /not applicable/,
  );
  const calendar = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "calendar",
    OCC_TEST_QA_INSTALLATION: "compose",
  });
  assert.ok(!calendar.requiredEnv.includes("OCC_TEST_QA_OPENAI_KEY_FILE"));
  assert.deepEqual(calendar.cells[0].scenarios, []);
  const openclaw = selectQaMatrix({ OCC_TEST_QA_PRESET: "OpenClaw" });
  assert.deepEqual(openclaw.cells[0].scenarios, ["model-ui", "console-secrets", "git-full"]);
  assert.ok(!openclaw.requiredEnv.some((name) => /CODEX|SLACK|CALENDAR/.test(name)));
  const secrets = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "console-secrets",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_INSTALLATION: "compose",
  });
  assert.equal(secrets.browser, true);
  assert.deepEqual(secrets.requiredEnv, ["OCC_TEST_QA_CODEX_TOKEN_FILE"]);
  const sandbox = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "sandbox-policy",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_INSTALLATION: "kubernetes",
  });
  assert.equal(sandbox.sandboxPolicy, true);
  assert.deepEqual(sandbox.requiredEnv, [
    "OCC_TEST_QA_CODEX_TOKEN_FILE",
    "OCC_TEST_QA_SANDBOX_ENV",
  ]);
  assert.ok(
    sandbox.cells.every((cell) => cell.scenarios.length === 0),
    "OpenShell uses its prepared enforcement lane, not Sandbox-free installations",
  );
  const full = selectQaMatrix({});
  assert.equal(full.scope, "full");
  assert.ok(full.repository);
  const isolated = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "git-full",
    QA_REPOSITORY_FIXTURE: "isolated",
    OCC_TEST_QA_GITHUB_OBSERVER_BINARY: "gh",
    OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE: "/private/token",
  });
  assert.ok(isolated.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY"));
  assert.ok(!isolated.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_BINARY"));
  assert.ok(!isolated.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE"));
  assert.throws(
    () =>
      validateQaInputs(isolated, {
        OCC_TEST_QA_OPENAI_KEY_FILE: "/private/openai",
        OCC_TEST_QA_CODEX_TOKEN_FILE: "/private/codex",
        OCC_TEST_QA_REPOSITORY_AUTHORIZED: "1",
        OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY: "/private/repository",
      }),
    /GITHUB_OBSERVER_APP_INPUT_DIRECTORY is required/,
  );
  assert.throws(
    () =>
      validateQaInputs(full, Object.fromEntries(full.requiredEnv.map((name) => [name, "fixture"]))),
    /explicit authorization/,
  );
});

test("hosted QA materializes only selected credentials and rejects missing selected inputs", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const script = new URL("../../scripts/ci/qa-matrix-credentials.mjs", import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), "qa-hosted-inputs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const githubEnv = join(directory, "github-env");
  const result = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
    env: {
      RUNNER_TEMP: directory,
      GITHUB_ENV: githubEnv,
      OCC_TEST_QA_SCENARIOS: "model-ui,calendar",
      OPENAI_API_KEY: "synthetic-model-key",
      CODEX_ACCESS_TOKEN: "synthetic-codex-token",
      OCC_TEST_CODEX_CALENDAR_TOOL_NAME: "test.calendar.read",
      OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT: "email",
      // Even if a caller supplies unrelated credentials, do not write them.
      SLACK_APP_TOKEN: "unselected-secret",
      REPOSITORY_APP_KEY: "unselected-secret",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
  const privateDirectory = join(directory, "qa-matrix-credentials");
  assert.deepEqual((await readdir(privateDirectory)).sort(), ["codex", "openai"]);
  assert.equal(
    await protectedText(join(privateDirectory, "codex"), "Codex credential"),
    "synthetic-codex-token",
  );
  const exported = await readFile(githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_CODEX_TOKEN_FILE=/);
  assert.doesNotMatch(
    exported,
    /synthetic-|unselected-secret|SLACK|REPOSITORY_(?:APP|OBSERVER|REGISTRY)/,
  );
  assert.doesNotMatch(exported, /QA_REPOSITORY_FIXTURE/);
  await rm(privateDirectory, { recursive: true });
  await rm(githubEnv);
  const missing = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
    env: {
      RUNNER_TEMP: directory,
      GITHUB_ENV: githubEnv,
      OCC_TEST_QA_SCENARIOS: "calendar",
      CODEX_ACCESS_TOKEN: "synthetic-codex-token",
      OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT: "email",
    },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CALENDAR_TOOL_NAME is required/);
  await assert.rejects(readFile(githubEnv), { code: "ENOENT" });
});

test("QA command diagnostics retain the error while hiding generated and environment secrets", async () => {
  const { qaCommandFailureDetail, registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  registerQaSecret("generated-private-value");
  const output = qaCommandFailureDetail(
    "earlier detail\n".repeat(12) +
      "Docker service could not start: generated-private-value and process-private-value\nAuthorization: Bearer example-private-value\n",
    { PRIVATE_INPUT: "process-private-value" },
  );
  assert.match(output, /Docker service could not start/);
  assert.ok(output.split("\n").length <= 8);
  assert.doesNotMatch(
    output,
    /generated-private-value|process-private-value|example-private-value/,
  );
});

test("a failed image build keeps its failed step's output as redacted QA evidence", async () => {
  const { imageBuildFailureOutput, recordImageBuildFailure } =
    await import("../helpers/qa-installation.mjs");
  const { registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  registerQaSecret("build-private-value");
  // BuildKit's plain progress (finding 2020's shape): steps interleave, each line prefixed by
  // its step; the failed step's output is gone from the final summary's last lines.
  const stderr = [
    // An earlier build in the same dev-up that succeeded: its step numbers repeat.
    '#0 building with "default" instance using docker driver',
    "#1 [internal] load build definition from Dockerfile",
    "#41 [controller 9/9] RUN node build.mjs",
    "#41 DONE 4.0s",
    '#0 building with "default" instance using docker driver',
    "#1 [internal] load build definition from Dockerfile",
    "#40 [openclaw-build 13/18] COPY --from=openclaw-source /source/ ./",
    "#41 [openclaw-build 14/18] RUN --network=none OPENCLAW_VITEST_MAX_WORKERS=1 node scripts/test-projects.mts src/gateway/server.required-placement-scopes.test.ts",
    "#40 DONE 2.1s",
    "#42 [controller 3/5] RUN pnpm install",
    "#41 3.210  RUN  v3.2.4 /source",
    "#41 45.12  FAIL  src/gateway/server.required-placement-scopes.test.ts > revokes placement",
    "#41 45.13 AssertionError: expected 'build-private-value' to be undefined",
    "#42 12.00 Done in 11.9s",
    '#41 ERROR: process "/bin/sh -c OPENCLAW_VITEST_MAX_WORKERS=1 node scripts/test-projects.mts" did not complete successfully: exit code: 1',
    "#42 CANCELED",
    "------",
    " > [openclaw-build 14/18] RUN --network=none ...:",
    "------",
    "Dockerfile:180",
    "--------------------",
    " 180 | >>> RUN --network=none OPENCLAW_VITEST_MAX_WORKERS=1 pnpm_config_verify_deps_before_run=false \\",
    "--------------------",
    'ERROR: failed to solve: process "/bin/sh -c OPENCLAW_VITEST_MAX_WORKERS=1" did not complete successfully: exit code: 1',
    "Error: docker failed: exit status 1",
    "",
  ].join("\n");
  const step = imageBuildFailureOutput(stderr);
  assert.equal(step.length, 5);
  assert.ok(step.every((line) => line.startsWith("#41 ")));
  assert.match(step.at(-2), /AssertionError/);
  assert.equal(imageBuildFailureOutput(stderr, { lines: 2 }).length, 2);

  const records = [];
  const record = async (name, value) => {
    records.push({ name, value });
    return `kubernetes-${name}.json`;
  };
  const file = await recordImageBuildFailure(record, stderr, { PRIVATE_INPUT: "unused" });
  assert.match(file, /^kubernetes-image-build-failure-\d+\.json$/);
  assert.equal(records.length, 1);
  assert.match(
    records[0].value.lines.join("\n"),
    /FAIL {2}src\/gateway\/server\.required-placement/,
  );
  assert.doesNotMatch(JSON.stringify(records[0].value), /build-private-value/);

  // A podman build has no BuildKit steps: its last lines are kept.
  const podman = [
    "STEP 14/18: RUN node test.mjs",
    ...Array.from({ length: 300 }, (_, i) => `line ${i}`),
  ];
  podman.push('Error: building at STEP "RUN node test.mjs": while running runtime: exit status 1');
  assert.equal(imageBuildFailureOutput(podman.join("\n")).length, 200);
  assert.match(imageBuildFailureOutput(podman.join("\n")).at(-1), /^Error: building at STEP/);

  // Newer buildx words the summary "failed to build: failed to solve".
  assert.deepEqual(
    imageBuildFailureOutput(
      stderr.replace("ERROR: failed to solve: ", "ERROR: failed to build: failed to solve: "),
    ),
    step,
  );

  // Any other command failure records nothing.
  assert.equal(
    imageBuildFailureOutput('Error from server (NotFound): pods "x" not found\n'),
    undefined,
  );
  assert.equal(await recordImageBuildFailure(record, "dev-up: startup timed out\n", {}), undefined);
  assert.equal(records.length, 1);
});

// Finding 2025: the QA installation's command runner is what records a failed image build's step
// as uploaded evidence, so it is run here with a real failing subprocess and no cluster. The
// evidence file must exist and carry the failed step with every secret the subprocess printed
// masked; a protected command records nothing.
test("the QA command runner records a failed image build step as redacted evidence", async (t) => {
  const { runQaCommand } = await import("../helpers/qa-installation.mjs");
  const { registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  const directory = await mkdtemp(join(tmpdir(), "qa-run-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = await mkdtemp(join(directory, "artifacts-"));
  registerQaSecret("registered-private-2025");
  const f = {
    directory,
    stateDirectory: join(directory, "state"),
    // The subprocess sees the installation's environment, so it can print its private value.
    env: { PATH: process.env.PATH, OCC_TEST_PRIVATE_INPUT: "env-private-value-2025" },
    // The installation's own record: a confined JSON file in the uploaded artifacts directory.
    async record(name, value) {
      const file = `kubernetes-${name}.json`;
      await writeFile(join(artifacts, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
      return file;
    },
  };
  const longLine = "x".repeat(1_000);
  const stderr = [
    '#0 building with "default" instance using docker driver',
    "#1 [internal] load build definition from Dockerfile",
    "#41 [openclaw-build 14/18] RUN node scripts/test-projects.mts",
    "#41 45.12  FAIL  src/gateway/placement.test.ts > keeps its token",
    "#41 45.13 AssertionError: expected 'registered-private-2025' to be undefined",
    "#41 45.14 env ${OCC_TEST_PRIVATE_INPUT}",
    "#41 45.15 Authorization: Bearer fake-bearer-token-2025",
    "#41 45.16 -----BEGIN PRIVATE KEY-----",
    "#41 45.17 fakePemBodyLine2025AAAAAAAAAAAAAAAAAAAA",
    "#41 45.18 -----END PRIVATE KEY-----",
    `#41 45.19 ${longLine}`,
    '#41 ERROR: process "/bin/sh -c node scripts/test-projects.mts" did not complete successfully: exit code: 1',
    'ERROR: failed to solve: process "/bin/sh -c node scripts/test-projects.mts" did not complete successfully: exit code: 1',
  ].join("\n");
  const script = `process.stderr.write(${JSON.stringify(stderr)}.replace("\${OCC_TEST_PRIVATE_INPUT}", process.env.OCC_TEST_PRIVATE_INPUT) + "\\n"); process.exit(1);`;

  await assert.rejects(runQaCommand(f, process.execPath, ["-e", script]), (error) => {
    assert.match(
      error.message,
      /; failed image build step output: kubernetes-image-build-failure-\d+\.json(?:;|$)/,
    );
    return true;
  });
  const files = (await readdir(artifacts)).filter((file) => file.includes("image-build-failure"));
  assert.equal(files.length, 1);
  const evidence = await readFile(join(artifacts, files[0]), "utf8");
  const { lines } = JSON.parse(evidence);
  assert.ok(lines.some((line) => line.includes("FAIL  src/gateway/placement.test.ts")));
  assert.doesNotMatch(
    evidence,
    /registered-private-2025|env-private-value-2025|fake-bearer-token-2025|fakePemBodyLine2025/,
  );
  // Each line is cut to 800 characters.
  assert.ok(lines.includes(`#41 45.19 ${longLine}`.slice(0, 800) + "... [truncated]"));

  // A command whose output is protected records no evidence, even from a failed image build.
  await assert.rejects(
    runQaCommand(f, process.execPath, ["-e", script], { privateFailureOutput: true }),
    (error) => {
      assert.doesNotMatch(error.message, /failed image build step output/);
      return true;
    },
  );
  assert.deepEqual(
    (await readdir(artifacts)).filter((file) => file.includes("image-build-failure")),
    files,
  );
});

// Finding 2026: a key whose BEGIN line falls before the failed step's last 200 lines, with no END
// line, must lose every body line, not only the lines the tail still shows its BEGIN for.
test("an image build step's unterminated private key is masked past the evidence window", async () => {
  const { recordImageBuildFailure } = await import("../helpers/qa-installation.mjs");
  const body = Array.from(
    { length: 250 },
    (_, index) =>
      `#41 ${index}.0 fakeKeyBody${String(index).padStart(3, "0")}QUJDREVGR0hJSktMTU5PUFFSU1RVVldY`,
  );
  const stderr = [
    "#41 [runtime 4/9] RUN cat /run/secrets/key",
    "#41 0.1 -----BEGIN RSA PRIVATE KEY-----",
    ...body,
    '#41 ERROR: process "/bin/sh -c cat /run/secrets/key" did not complete successfully: exit code: 1',
    'ERROR: failed to solve: process "/bin/sh -c cat /run/secrets/key" did not complete successfully: exit code: 1',
  ].join("\n");
  const records = [];
  await recordImageBuildFailure(
    async (name, value) => {
      records.push(value);
      return `kubernetes-${name}.json`;
    },
    stderr,
    {},
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].lines.length, 200);
  assert.doesNotMatch(JSON.stringify(records[0]), /fakeKeyBody/);
});

test("QA waits report the last observation when they time out", async () => {
  const { waitFor } = await import("../helpers/qa-utils.mjs");
  let observations = 0;
  let last;
  // A fake clock that each observation advances by 100 ms: two observations, no real wait.
  let clock = 0;
  await assert.rejects(
    waitFor(
      "fake condition",
      async () => {
        observations += 1;
        assert.ok(observations < 100, "the wait follows the fake clock");
        clock += 100;
        last = { observation: observations, pods: ["runtime-0"] };
        return false;
      },
      200,
      { describe: () => JSON.stringify(last), interval: 0, now: () => clock },
    ),
    (error) => {
      assert.equal(
        error.message,
        `Timed out: fake condition; last observation: {"observation":${observations},"pods":["runtime-0"]}`,
      );
      return true;
    },
  );
  assert.ok(observations >= 2, "the wait observed more than once");
  // Without `describe` the message is unchanged; a failing `describe` keeps the timeout.
  await assert.rejects(
    waitFor("plain condition", async () => false, 10, { interval: 5 }),
    (error) => error.message === "Timed out: plain condition",
  );
  await assert.rejects(
    waitFor("broken describe", async () => false, 10, {
      interval: 5,
      describe: () => {
        throw new Error("no state");
      },
    }),
    (error) =>
      error.message === "Timed out: broken describe; last observation unavailable (no state)",
  );
  assert.equal(
    await waitFor("ready", async () => "value", 10, { describe: () => "unused" }),
    "value",
  );
});

// Finding 2106: six QA cells failed "Timed out: Agent deployment" at 600 s with no status.
test("a QA Agent deployment timeout names its last status, attempt and Pods", async (t) => {
  const { deployQaAgentAndWait } = await import("../helpers/qa-installation.mjs");
  const { createQaReport } = await import("../helpers/qa-report.mjs");
  const { registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  // An invented 48-character registered value. Runtime text that OCC shortened could keep
  // part of it, which whole-value redaction cannot match.
  const privateValue = "qa-deploy-fixture-private-0123456789abcdefghijkl";
  assert.equal(privateValue.length, 48);
  registerQaSecret(privateValue);
  const base = "/namespaces/namespace-1/agents/agent-1";
  function fixture({ runtime, finalStatus = "running" } = {}) {
    let clock = 0;
    const calls = [];
    const records = [];
    const lastAttempt = {
      at: "2026-10-19T19:40:00.000Z",
      code: "RUNTIME_NOT_READY",
      message: "The Agent runtime is not ready yet.",
    };
    const f = {
      async api(method, path) {
        calls.push(`${method} ${path}`);
        if (method === "POST" && path === `${base}/deploy`) {
          return { id: "rev-1" };
        }
        if (path === `${base}/deployments/rev-1`) {
          clock += 100;
          // Queued for the first observations, then running until the wait ends.
          const status = clock <= 200 ? "queued" : finalStatus;
          return {
            status,
            progress: status === "succeeded" ? null : { lastAttempt, nextAttemptAt: null },
            error: null,
            cleanup: null,
            warnings: [],
          };
        }
        if (path === `${base}/deployments/rev-1/runtime`) {
          if (!runtime) {
            throw new Error(`OCC GET ${path}: HTTP 404`);
          }
          return runtime;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
      async record(name, value) {
        records.push({ name, value });
      },
    };
    const agent = { id: "agent-1", namespaceId: "namespace-1", preset: "Codex" };
    return { f, agent, calls, records, options: { timeout: 1_000, interval: 0, now: () => clock } };
  }

  const runtime = {
    revisionId: "rev-1",
    observedAt: "2026-10-19T19:46:00.000Z",
    sources: [],
    pods: [
      {
        role: "gateway",
        cluster: "control",
        name: "gateway-0",
        uid: "uid-1",
        phase: "Pending",
        ready: false,
        createdAt: "2026-10-19T19:36:10.000Z",
        containers: [
          {
            name: "gateway",
            state: "waiting",
            reason: "ContainerCreating",
            ready: false,
            restartCount: 0,
            startedAt: null,
            lastTermination: null,
          },
          {
            name: "setup",
            state: "terminated",
            // Cut at the API's 128 characters, inside the registered value.
            reason: ("r".repeat(100) + privateValue).slice(0, 128),
            ready: false,
            restartCount: 1,
            startedAt: null,
            lastTermination: null,
          },
        ],
        // Newest first, as the API lists them.
        events: [
          {
            type: "Warning",
            container: null,
            reason: "Unhealthy",
            // Probe output can reach an event message; the value starts at character 176.
            message: "Readiness probe failed: " + "x".repeat(152) + privateValue,
            count: 4,
            lastObservedAt: "2026-10-19T19:45:00Z",
          },
          {
            type: "Normal",
            container: null,
            reason: "Pulled",
            message: "Container image already present",
            count: 1,
            lastObservedAt: "2026-10-19T19:44:00Z",
          },
          {
            type: "Warning",
            container: null,
            // A long reason from a legacy Event producer, cut inside the registered value.
            reason: ("e".repeat(100) + privateValue).slice(0, 128),
            message: "Back-off pulling image",
            count: 2,
            lastObservedAt: "2026-10-19T19:43:00Z",
          },
          {
            type: "Warning",
            container: null,
            reason: "FailedScheduling",
            message: "0/1 nodes are available",
            count: 3,
            lastObservedAt: "2026-10-19T19:38:00Z",
          },
          {
            type: "Warning",
            container: null,
            reason: "FailedCreatePodSandBox",
            message: "Failed to create pod sandbox",
            count: 1,
            lastObservedAt: "2026-10-19T19:37:00Z",
          },
        ],
      },
    ],
  };
  // Through the real report stage, which redacts before it saves the reason.
  const directory = await mkdtemp(join(tmpdir(), "qa-deploy-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "matrix.json");
  const report = createQaReport(reportPath, {});
  const parent = { test: async (_name, _options, run) => run() };
  const timedOut = fixture({ runtime });
  await assert.rejects(
    report.stage(parent, "compose/Codex", "deploy", () =>
      deployQaAgentAndWait(timedOut.f, timedOut.agent, timedOut.options),
    ),
    (error) => {
      // No runtime text that could hold part of a secret reaches the error.
      assert.doesNotMatch(error.message, /qa-deploy-fixture|Readiness probe failed|rrrr|eeee/);
      const [observation, pods] = error.message
        .replace(/^Timed out: Agent deployment; last observation: /, "")
        .split("; runtime: ");
      assert.deepEqual(JSON.parse(observation), {
        status: "running",
        // Running since the third observation (clock 300) until the last one (clock 1,000).
        statusForMs: 700,
        lastAttempt: {
          at: "2026-10-19T19:40:00.000Z",
          code: "RUNTIME_NOT_READY",
          message: "The Agent runtime is not ready yet.",
        },
        nextAttemptAt: null,
        error: null,
      });
      assert.deepEqual(JSON.parse(pods), {
        pods: [
          {
            role: "gateway",
            phase: "Pending",
            ready: false,
            containers: [
              { name: "gateway", state: "waiting", reason: "ContainerCreating", restartCount: 0 },
              { name: "setup", state: "terminated", reason: "other", restartCount: 1 },
            ],
            // The three newest Warnings, by familiar reason and count only.
            warnings: [
              { reason: "Unhealthy", count: 4 },
              { reason: "other", count: 2 },
              { reason: "FailedScheduling", count: 3 },
            ],
          },
        ],
      });
      return true;
    },
  );
  assert.equal(timedOut.calls.at(-1), `GET ${base}/deployments/rev-1/runtime`);
  assert.deepEqual(timedOut.records, []);
  const saved = await readFile(reportPath, "utf8");
  const [outcome] = JSON.parse(saved).outcomes;
  assert.equal(outcome.outcome, "failed");
  assert.match(outcome.reason, /^Timed out: Agent deployment; last observation: /);
  assert.doesNotMatch(saved, new RegExp(privateValue.slice(0, 8)));

  // Runtime details are best effort: the timeout keeps its status when they are unavailable.
  const noRuntime = fixture();
  await assert.rejects(
    deployQaAgentAndWait(noRuntime.f, noRuntime.agent, noRuntime.options),
    (error) =>
      error.message.startsWith(
        'Timed out: Agent deployment; last observation: {"status":"running","statusForMs":700,',
      ) &&
      error.message.endsWith(
        `; runtime unavailable (OCC GET ${base}/deployments/rev-1/runtime: HTTP 404)`,
      ),
  );

  // A deployment that succeeds is recorded and returned, with no runtime request.
  const succeeded = fixture({ finalStatus: "succeeded" });
  const result = await deployQaAgentAndWait(succeeded.f, succeeded.agent, succeeded.options);
  assert.equal(result.status.status, "succeeded");
  assert.deepEqual(result.revision, { id: "rev-1" });
  assert.deepEqual(
    succeeded.records.map(({ name }) => name),
    ["Codex-agent-1-rev-1-deployment"],
  );
  assert.equal(
    succeeded.calls.some((call) => call.endsWith("/runtime")),
    false,
  );
});

test("a QA Agent stop timeout names the remaining Pods and keeps redacted platform logs", async () => {
  const { registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  const { stopQaAgent, describeStopObservation } = await import("../helpers/qa-repository.mjs");
  registerQaSecret("stop-fixture-service-key");
  const agent = { id: "agent-1", namespaceId: "namespace-1" };
  const pod = {
    metadata: {
      namespace: "oce-agent-1",
      name: "agent-1-gateway-0",
      deletionTimestamp: "2026-10-11T01:37:00Z",
      finalizers: ["openclaw.dev/runtime"],
      labels: { "openclaw.dev/agent": "agent-1", "openclaw.dev/workload-role": "gateway" },
    },
    spec: { containers: [{ env: [{ name: "GATEWAY_PASSWORD", value: "spec-private-value" }] }] },
    status: { phase: "Running" },
  };
  // A remaining Agent Pod whose log is not read, in the platform Namespace for the
  // Events de-duplication.
  const agentPod = {
    metadata: {
      namespace: "oce-system",
      name: "agent-1-runtime-0",
      labels: { "openclaw.dev/agent": "agent-1", "openclaw.dev/workload-role": "agent" },
    },
    status: { phase: "Running" },
  };
  // A rollout: two worker Pods, one restarted, and an API Pod.
  const platformPods = [
    {
      metadata: { name: "worker-a", labels: { "app.kubernetes.io/component": "worker" } },
      spec: { containers: [{ env: [{ name: "DATABASE_URL", value: "spec-private-value" }] }] },
      status: {
        phase: "Running",
        startTime: "2026-10-11T01:30:00Z",
        containerStatuses: [
          {
            name: "worker",
            restartCount: 1,
            lastState: {
              terminated: { reason: "Error", exitCode: 1, finishedAt: "2026-10-11T01:33:00Z" },
            },
          },
        ],
      },
    },
    {
      metadata: { name: "worker-b", labels: { "app.kubernetes.io/component": "worker" } },
      status: { phase: "Running", containerStatuses: [{ name: "worker", restartCount: 0 }] },
    },
    { metadata: { name: "api-a", labels: { "app.kubernetes.io/component": "api" } }, status: {} },
  ];
  const event = (time, name, message) => ({
    lastTimestamp: time,
    type: "Normal",
    reason: "Killing",
    involvedObject: { kind: "Pod", name },
    message,
  });
  const calls = [];
  const records = new Map();
  // Each GET advances the fake clock past the 10 ms timeout: one read, then the timeout.
  let clock = 0;
  const timing = { timeout: 10, interval: 0, now: () => clock };
  const f = {
    controlPlane: "kubernetes",
    env: {
      PRIVATE_INPUT: "launcher-private-value",
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_COMPOSE_PROJECT: "occ-dev-qa-k-ab12cd34",
      OCC_DEVELOPMENT_KUBERNETES_CLUSTER: "occ-dev-qa-k-ab12cd34",
      OCC_DEVELOPMENT_STATE_DIRECTORY: "/runner/tmp/occ-dev-qa-k-ab12cd34-x/state",
      OCC_DEVELOPMENT_K3S_IMAGE: "docker.io/rancher/k3s:v1.35.9-k3s1",
    },
    state: { platformNamespace: "oce-system" },
    async api(method, path) {
      calls.push(["api", method, path]);
      if (method !== "GET") {
        return undefined;
      }
      clock += 1_000;
      assert.ok(clock < 100_000, "the stop wait follows the fake clock");
      return { desiredRuntimeState: "stopped", activeRevisionId: "revision-1" };
    },
    async kubectl(...args) {
      calls.push(["kubectl", ...args]);
      if (args[0] === "get") {
        return JSON.stringify({ items: [pod, agentPod] });
      }
      if (args.includes("deployment/openclaw-enterprise-worker")) {
        throw new Error("kubectl failed (exit 1); stderr: launcher-private-value unreachable");
      }
      const [verb, target] = args.slice(2);
      if (verb === "get" && target === "pods") {
        return JSON.stringify({ items: platformPods });
      }
      if (verb === "get" && target === "events") {
        return JSON.stringify({
          items: [
            event("2026-10-11T01:36:30Z", "agent-1-gateway-0", "Stopping; launcher-private-value"),
            event(undefined, "undated", "no time"),
            event("2026-10-11T01:30:00Z", "worker-a", "Started container worker"),
          ],
        });
      }
      if (args.includes("--previous")) {
        throw new Error("kubectl failed (exit 1); stderr: previous launcher-private-value gone");
      }
      if (target === "worker-a" || target === "worker-b") {
        return `2026-10-11T01:36:00Z ${target} worker.completed\n`;
      }
      if (target === "agent-1-gateway-0") {
        return (
          "2026-10-11T01:32:40Z draining active work before stop with timeout 315000ms: 1 active chat run(s)\n" +
          "2026-10-11T01:32:41Z assistant reply QA_NATIVE_conversation-text: drain the shutdown queue\n"
        );
      }
      return (
        "2026-10-11T01:36:00Z kubernetes compute: stop requested for agent-1\n" +
        "2026-10-11T01:36:01Z authenticated with stop-fixture-service-key\n" +
        "2026-10-11T01:36:02Z Authorization: Bearer abcdefghijklmnop\n" +
        "2026-10-11T01:36:03Z cluster occ-dev-qa-k-ab12cd34 state /runner/tmp/occ-dev-qa-k-ab12cd34-x/state image docker.io/rancher/k3s:v1.35.9-k3s1\n"
      );
    },
    async record(name, value) {
      records.set(name, value);
      return `${this.controlPlane}-${name}.json`;
    },
  };
  await assert.rejects(stopQaAgent(f, agent, timing), (error) => {
    assert.match(error.message, /^Timed out: ordinary Agent stop removes every runtime Pod; /);
    const observation = JSON.parse(
      /; last observation: (\{.*\}); API and worker logs: /.exec(error.message)[1],
    );
    assert.deepEqual(observation, {
      desiredRuntimeState: "stopped",
      activeRevisionId: "revision-1",
      pods: [
        {
          namespace: "oce-agent-1",
          name: "agent-1-gateway-0",
          phase: "Running",
          deletionTimestamp: "2026-10-11T01:37:00Z",
          finalizers: ["openclaw.dev/runtime"],
        },
        {
          namespace: "oce-system",
          name: "agent-1-runtime-0",
          phase: "Running",
          deletionTimestamp: null,
          finalizers: [],
        },
      ],
    });
    assert.match(
      error.message,
      /API and worker logs: kubernetes-agent-1-stop-timeout-platform-logs\.json$/,
    );
    assert.doesNotMatch(error.message, /spec-private-value/);
    return true;
  });
  assert.equal(agent.stopped, undefined);
  assert.deepEqual(calls[0], ["api", "POST", "/namespaces/namespace-1/agents/agent-1/stop"]);
  const logCall = calls.find((call) => call.includes("deployment/openclaw-enterprise-api"));
  assert.deepEqual(logCall.slice(1, 7), [
    "-n",
    "oce-system",
    "logs",
    "deployment/openclaw-enterprise-api",
    "--container",
    "api",
  ]);
  assert.ok(
    logCall.some((argument) => /^--tail=\d+$/.test(argument)),
    "the log tail is bounded",
  );
  const { logs } = records.get("agent-1-stop-timeout-platform-logs");
  assert.equal(logs.api[0], "2026-10-11T01:36:00Z kubernetes compute: stop requested for agent-1");
  assert.doesNotMatch(
    JSON.stringify(logs),
    /stop-fixture-service-key|abcdefghijklmnop|launcher-private-value/,
  );
  assert.equal(logs.api.length, 4);
  // Fixed launcher settings stay readable.
  assert.equal(
    logs.api[3],
    "2026-10-11T01:36:03Z cluster occ-dev-qa-k-ab12cd34 state /runner/tmp/occ-dev-qa-k-ab12cd34-x/state image docker.io/rancher/k3s:v1.35.9-k3s1",
  );
  assert.match(logs.worker.unavailable.join("\n"), /unreachable/);
  assert.equal(describeStopObservation(undefined), "none");
  // During a rollout every worker Pod by name; only a restarted one's previous
  // container, whose failed read is kept, redacted.
  assert.deepEqual(logs.workerPods, {
    "worker-a": ["2026-10-11T01:36:00Z worker-a worker.completed"],
    "worker-b": ["2026-10-11T01:36:00Z worker-b worker.completed"],
  });
  assert.deepEqual(
    calls.filter((call) => call.includes("--previous")).map((call) => call.slice(1)),
    [
      [
        "-n",
        "oce-system",
        "logs",
        "worker-a",
        "--container",
        "worker",
        "--previous",
        "--timestamps",
        "--tail=200",
        "--request-timeout=30s",
      ],
    ],
  );
  assert.match(logs.workerPrevious["worker-a"].unavailable.join("\n"), /gone/);
  assert.deepEqual(logs.platformPods[0], {
    name: "worker-a",
    component: "worker",
    phase: "Running",
    startTime: "2026-10-11T01:30:00Z",
    deletionTimestamp: null,
    containers: [
      {
        name: "worker",
        restartCount: 1,
        lastTerminated: { reason: "Error", exitCode: 1, finishedAt: "2026-10-11T01:33:00Z" },
      },
    ],
  });
  // Events from the platform and each other remaining Namespace, oldest first.
  assert.deepEqual(Object.keys(logs.events), ["oce-system", "oce-agent-1"]);
  assert.equal(calls.filter((call) => call.includes("events")).length, 2);
  assert.deepEqual(
    logs.events["oce-agent-1"].map(({ object }) => object),
    ["Pod/undated", "Pod/worker-a", "Pod/agent-1-gateway-0"],
  );
  // Only a remaining Gateway Pod's own drain messages; the Agent Pod's log is not read.
  assert.deepEqual(logs.gatewayDrain, {
    "agent-1-gateway-0": [
      "2026-10-11T01:32:40Z draining active work before stop with timeout 315000ms: 1 active chat run(s)",
    ],
  });
  assert.ok(!calls.some((call) => call.includes("agent-1-runtime-0")));
  assert.deepEqual(calls.find((call) => call.includes("agent-1-gateway-0")).slice(1, 7), [
    "-n",
    "oce-agent-1",
    "logs",
    "agent-1-gateway-0",
    "--container",
    "gateway",
  ]);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /spec-private-value|QA_NATIVE_conversation-text|launcher-private-value/,
  );
  // A single worker Pod is the Deployment read: no per-Pod copies.
  platformPods.splice(0, 1);
  await assert.rejects(stopQaAgent(f, { id: "agent-3", namespaceId: "namespace-1" }, timing), {
    message: /^Timed out: ordinary Agent stop removes every runtime Pod; last observation: /,
  });
  assert.equal(records.get("agent-3-stop-timeout-platform-logs").logs.workerPods, undefined);

  // A Compose control plane keeps the observation but has no in-cluster platform logs.
  records.clear();
  const composeAgent = { id: "agent-2", namespaceId: "namespace-1" };
  await assert.rejects(
    stopQaAgent({ ...f, controlPlane: "compose" }, composeAgent, timing),
    (error) =>
      /; last observation: \{.*"pods":\[\{/.test(error.message) &&
      !/API and worker logs/.test(error.message),
  );
  assert.equal(records.size, 0);
});

test("a QA Agent stop waits for the Gateway stop bound and records a slow stop without failing", async (t) => {
  const { GATEWAY_STOP_TIMEOUT_MS } =
    await import("../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts");
  const { stopQaAgent, QA_STOP_TIMEOUT_MS, QA_SLOW_STOP_MS } =
    await import("../helpers/qa-repository.mjs");
  // The worker's own Gateway wait (grace plus one request) fits, with room for the
  // Harness and the API; the old 300 s default did not.
  assert.ok(QA_STOP_TIMEOUT_MS >= GATEWAY_STOP_TIMEOUT_MS + 10_000 + 3 * 60_000);
  assert.ok(QA_STOP_TIMEOUT_MS > 300_000);
  assert.equal(QA_SLOW_STOP_MS, 60_000);

  const gateway = {
    metadata: {
      namespace: "oce-agent-4",
      name: "agent-4-gateway-0",
      deletionTimestamp: "2026-10-11T07:23:42Z",
      labels: { "openclaw.dev/agent": "agent-4", "openclaw.dev/workload-role": "gateway" },
    },
    status: { phase: "Running" },
  };
  // A fake clock for both the slow-stop threshold and the timeout, and no sleep between
  // reads: each GET advances the clock by the next step; the last step's read finds
  // the stop done.
  let clock = 0;
  const now = () => clock;
  const fixture = (steps, { done = true } = {}) => {
    const records = new Map();
    let reads = 0;
    const finished = () => done && reads >= steps.length;
    const f = {
      controlPlane: "kubernetes",
      env: { PRIVATE_INPUT: "launcher-private-value" },
      state: { platformNamespace: "oce-system" },
      async api(method) {
        if (method !== "GET") {
          return undefined;
        }
        clock += steps[Math.min(reads, steps.length - 1)];
        reads += 1;
        assert.ok(reads < 100, "the stop wait follows the fake clock");
        return finished()
          ? { desiredRuntimeState: "stopped", activeRevisionId: null }
          : { desiredRuntimeState: "stopped", activeRevisionId: "revision-4" };
      },
      async kubectl(...args) {
        if (args[0] === "get") {
          return JSON.stringify({ items: finished() ? [] : [gateway] });
        }
        const [verb, target] = args.slice(2);
        if (verb === "get") {
          return JSON.stringify({ items: [] });
        }
        if (target === "agent-4-gateway-0") {
          return "2026-10-11T07:18:13Z draining active work before stop with timeout 315000ms: 1 active chat run(s)\n";
        }
        return "2026-10-11T07:18:12Z worker.completed\n";
      },
      // Like the QA fixture's record: exclusive creation.
      async record(name, value) {
        if (records.has(name)) {
          throw new Error(`EEXIST: ${name}`);
        }
        records.set(name, value);
        return `${this.controlPlane}-${name}.json`;
      },
    };
    return { f, records };
  };
  const written = [];
  t.mock.method(process.stderr, "write", (text) => {
    written.push(String(text));
    return true;
  });
  const drain = [
    "2026-10-11T07:18:13Z draining active work before stop with timeout 315000ms: 1 active chat run(s)",
  ];

  // A fast stop leaves no evidence.
  const fast = fixture([0, 5_000]);
  const fastAgent = { id: "agent-4", namespaceId: "namespace-1" };
  await stopQaAgent(fast.f, fastAgent, { now, interval: 0 });
  assert.equal(fastAgent.stopped, true);
  assert.equal(fast.records.size, 0);
  assert.deepEqual(written, []);

  // Still running past 60 s: the drain lines are captured once, while the Gateway
  // drains, then the completed stop records its total time and passes.
  clock = 0;
  const slow = fixture([61_000, 1_000, 1_000, 200_000]);
  const slowAgent = { id: "agent-4", namespaceId: "namespace-1" };
  await stopQaAgent(slow.f, slowAgent, { now, interval: 0 });
  assert.equal(slowAgent.stopped, true);
  assert.deepEqual([...slow.records.keys()].sort(), [
    "agent-4-slow-stop",
    "agent-4-slow-stop-platform-logs",
  ]);
  assert.deepEqual(
    slow.records.get("agent-4-slow-stop-platform-logs").logs.gatewayDrain["agent-4-gateway-0"],
    drain,
  );
  assert.deepEqual(slow.records.get("agent-4-slow-stop"), {
    thresholdMs: 60_000,
    observedAfterMs: 61_000,
    observation: {
      desiredRuntimeState: "stopped",
      activeRevisionId: "revision-4",
      pods: [
        {
          namespace: "oce-agent-4",
          name: "agent-4-gateway-0",
          phase: "Running",
          deletionTimestamp: "2026-10-11T07:23:42Z",
          finalizers: [],
        },
      ],
    },
    platformLogs: "kubernetes-agent-4-slow-stop-platform-logs.json",
    elapsedMs: 263_000,
  });
  assert.equal(written.length, 1);
  assert.match(
    written[0],
    /^QA slow stop \(diagnostic, not a failure\): Agent agent-4 took 263 s; drain evidence: kubernetes-agent-4-slow-stop-platform-logs\.json\n$/,
  );

  // A stop that first finishes after 60 s still records its time, without a capture.
  // Stopping the same Agent again gets its own evidence names.
  clock = 0;
  const late = fixture([61_000]);
  await stopQaAgent(late.f, slowAgent, { now, interval: 0 });
  assert.deepEqual(late.records.get("agent-4-2-slow-stop"), {
    thresholdMs: 60_000,
    elapsedMs: 61_000,
  });
  assert.match(written[1], /took 61 s\n$/);

  // Evidence that cannot be written never fails a completed stop, and its error is redacted.
  clock = 0;
  const unwritable = fixture([61_000, 1_000]);
  const failures = [];
  unwritable.f.record = async (name) => {
    failures.push(name);
    throw new Error("EEXIST: launcher-private-value exists");
  };
  const unwritableAgent = { id: "agent-4", namespaceId: "namespace-1" };
  await stopQaAgent(unwritable.f, unwritableAgent, { now, interval: 0 });
  assert.equal(unwritableAgent.stopped, true);
  assert.deepEqual(failures, ["agent-4-slow-stop-platform-logs", "agent-4-slow-stop"]);
  assert.match(written[2], /took 62 s\n$/);

  // A slow stop that then times out names the drain evidence captured while it ran;
  // it records no completed-stop summary.
  const stuck = fixture([1_000], { done: false });
  const stuckAgent = { id: "agent-5", namespaceId: "namespace-1" };
  await assert.rejects(
    stopQaAgent(stuck.f, stuckAgent, { slowAfter: 0, timeout: 10, now, interval: 0 }),
    (error) => {
      assert.match(
        error.message,
        /; API and worker logs: kubernetes-agent-5-stop-timeout-platform-logs\.json; drain evidence after \d+ s: kubernetes-agent-5-slow-stop-platform-logs\.json$/,
      );
      return true;
    },
  );
  assert.equal(stuckAgent.stopped, undefined);
  assert.deepEqual([...stuck.records.keys()].sort(), [
    "agent-5-slow-stop-platform-logs",
    "agent-5-stop-timeout-platform-logs",
  ]);
  assert.equal(written.length, 3);

  // The default timeout is that bound on the same clock: a stop that completes once the
  // Gateway wait plus three minutes has passed still passes; one still running at the
  // bound fails.
  const bound = GATEWAY_STOP_TIMEOUT_MS + 10_000 + 3 * 60_000;
  clock = 0;
  const atBoundAgent = { id: "agent-6", namespaceId: "namespace-1" };
  await stopQaAgent(fixture([bound - 1, 1]).f, atBoundAgent, { now, interval: 0 });
  assert.equal(atBoundAgent.stopped, true);
  assert.equal(written.length, 4);
  assert.match(written[3], new RegExp(`Agent agent-6 took ${Math.round(bound / 1000)} s`));
  clock = 0;
  const pastBoundAgent = { id: "agent-7", namespaceId: "namespace-1" };
  await assert.rejects(
    stopQaAgent(fixture([bound], { done: false }).f, pastBoundAgent, {
      now,
      interval: 0,
    }),
    { message: /^Timed out: ordinary Agent stop removes every runtime Pod; / },
  );
  assert.equal(pastBoundAgent.stopped, undefined);
  // It timed out on its first read, at the bound: the timeout is no longer than the bound.
  assert.equal(clock, bound);
});

test("QA log redaction hides each line of a registered multi-line secret", async () => {
  const { redactedQaTail, registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  const body = ["MIIEfixtureLineOneAAAAAAAA", "fixtureLineTwoBBBBBBBBBBBB"];
  registerQaSecret(
    ["-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----"].join("\n"),
  );
  const lines = redactedQaTail(
    `reading key\n${body[0]}\n${body[1]}\ndone\n`,
    {},
    {
      lines: 10,
      lineChars: 200,
    },
  );
  assert.deepEqual(lines[0], "reading key");
  assert.equal(lines.at(-1), "done");
  assert.doesNotMatch(lines.join("\n"), /fixtureLine/);
});

test("QA log redaction hides JSON-escaped, base64 and percent-encoded copies of a registered secret", async () => {
  const { redactQaError, redactedQaTail, registerQaSecret } =
    await import("../helpers/qa-secrets.mjs");
  // Synthetic, with every character an encoding changes.
  const value = 'synthetic"qa\\value/<&>+= 2026';
  registerQaSecret(value);
  const json = JSON.stringify(value).slice(1, -1);
  const encoded = [
    json,
    // Go's encoding/json (kube API errors) also escapes <, > and &.
    json.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026"),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
    encodeURIComponent(value),
  ];
  assert.equal(new Set([value, ...encoded]).size, 6);
  const text = [
    `plain ${value}`,
    JSON.stringify({ level: 30, msg: `loaded ${value}` }),
    `go ${encoded[1]}`,
    `secret data ${encoded[2]}`,
    `url-safe ${encoded[3]}`,
    `query ?v=${encoded[4]}`,
  ].join("\n");
  const lines = redactedQaTail(text, {}, { lines: 10, lineChars: 400 });
  assert.equal(lines.length, 6);
  for (const variant of [value, ...encoded]) {
    assert.ok(!lines.join("\n").includes(variant), `variant survived: ${lines.join("\n")}`);
  }
  assert.ok(
    lines.every((line) => line.includes("[env:qa-secret]")),
    lines.join("\n"),
  );
  const error = redactQaError(new Error(`failed: ${encoded[2]}`));
  assert.equal(error.message, "failed: [REDACTED]");
});

test("QA error redaction keeps errors whose message cannot be written", async () => {
  const { inspect } = await import("node:util");
  const { redactQaError, registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  const value = "synthetic-qa-error-secret-2026";
  registerQaSecret(value);

  // An ordinary error is redacted in place, message and stack.
  const ordinary = new Error(`request failed: ${value}`);
  assert.equal(redactQaError(ordinary), ordinary);
  assert.equal(ordinary.message, "request failed: [REDACTED]");
  assert.ok(!ordinary.stack.includes(value), ordinary.stack);
  assert.match(ordinary.stack, /request failed: \[REDACTED\]/);

  // AbortSignal.timeout's error: nothing to redact, so it is returned untouched.
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(redactQaError(timeout), timeout);
  assert.equal(timeout.message, "The operation was aborted due to timeout");

  // A DOMException carrying a secret: its message is getter-only, so a plain
  // Error replaces it, with the name, code and redacted stack, and without the
  // original as `cause` (inspecting that would print the secret).
  const dom = new DOMException(`timed out reading ${value}`, "TimeoutError");
  const replaced = redactQaError(dom);
  assert.notEqual(replaced, dom);
  assert.ok(replaced instanceof Error);
  assert.equal(replaced.message, "timed out reading [REDACTED]");
  assert.equal(replaced.name, "TimeoutError");
  assert.equal(replaced.code, dom.code);
  assert.equal(replaced.cause, undefined);
  assert.match(replaced.stack, /^TimeoutError: timed out reading \[REDACTED\]/);
  assert.ok(!inspect(replaced).includes(value), inspect(replaced));

  // A frozen error cannot be updated either.
  const frozen = Object.freeze(Object.assign(new Error(`denied ${value}`), { code: "EACCES" }));
  const unfrozen = redactQaError(frozen);
  assert.notEqual(unfrozen, frozen);
  assert.equal(unfrozen.message, "denied [REDACTED]");
  assert.equal(unfrozen.name, "Error");
  assert.equal(unfrozen.code, "EACCES");
  assert.match(unfrozen.stack, /^Error: denied \[REDACTED\]\n/);
  assert.ok(!inspect(unfrozen).includes(value), inspect(unfrozen));

  // A thrown string is redacted; other non-objects pass through.
  assert.equal(redactQaError(`token ${value}`), "token [REDACTED]");
  assert.equal(redactQaError(undefined), undefined);
});

test("QA error redaction covers causes, AggregateError errors and command output", async () => {
  const { execFile } = await import("node:child_process");
  const { inspect, promisify } = await import("node:util");
  const { qaSecretVariants, redactQaError, registerQaSecret } =
    await import("../helpers/qa-secrets.mjs");
  const value = "synthetic-qa-nested-secret-2026";
  registerQaSecret(value);
  // Everything node:test prints, getters included, at any depth.
  const printed = (error) => inspect(error, { depth: Infinity, getters: true });
  const assertClean = (error) => {
    const text = printed(error);
    for (const variant of [...qaSecretVariants(value), inspectedBytes(value)]) {
      assert.ok(!text.includes(variant), `variant survived: ${text}`);
    }
  };
  // A real execFile failure: the secret is in argv (cmd), stdout and stderr.
  const failingCommand = (encoding) =>
    promisify(execFile)(
      process.execPath,
      [
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]); process.exit(3)",
        value,
      ],
      { encoding },
    ).then(
      () => assert.fail("the command must fail"),
      (error) => error,
    );

  for (const encoding of ["utf8", "buffer"]) {
    const error = await failingCommand(encoding);
    assert.equal(Buffer.isBuffer(error.stdout), encoding === "buffer");
    assert.ok(printed(error).includes(value), "fixture must carry the secret");
    assert.equal(redactQaError(error), error);
    assert.equal(Buffer.isBuffer(error.stdout), encoding === "buffer");
    assert.equal(Buffer.isBuffer(error.stderr), encoding === "buffer");
    assert.equal(String(error.stdout), "[REDACTED]");
    assert.equal(String(error.stderr), "[REDACTED]");
    assert.match(error.cmd, / \[REDACTED\]$/);
    assert.equal(error.code, 3);
    assertClean(error);
  }

  // A cause chain, a string cause and an AggregateError's errors, with a
  // Buffer stderr two levels down.
  const chained = new Error("outer", {
    cause: new AggregateError(
      [
        new Error("first", { cause: new Error(`inner ${value}`) }),
        Object.assign(new Error("second"), { stderr: Buffer.from(`denied ${value}\n`) }),
        new Error("third", { cause: `token ${value}` }),
      ],
      `aggregate ${value}`,
    ),
  });
  assert.equal(redactQaError(chained), chained);
  assert.equal(chained.cause.message, "aggregate [REDACTED]");
  assert.equal(chained.cause.errors[0].cause.message, "inner [REDACTED]");
  assert.equal(String(chained.cause.errors[1].stderr), "denied [REDACTED]\n");
  assert.equal(chained.cause.errors[2].cause, "token [REDACTED]");
  assertClean(chained);

  // A cause that points back at its own error is cut, not followed forever.
  const cyclic = new Error(`cyclic ${value}`);
  cyclic.cause = cyclic;
  assert.equal(redactQaError(cyclic), cyclic);
  assert.equal(cyclic.cause, "[Circular]");
  assertClean(cyclic);

  // A two-error cycle whose top error is frozen: the replacement's cause must
  // not lead back to the unredacted original.
  const top = new Error(`top ${value}`);
  const middle = new Error(`middle ${value}`, { cause: top });
  top.cause = middle;
  Object.freeze(top);
  const replaced = redactQaError(top);
  assert.notEqual(replaced, top);
  assert.equal(replaced.message, "top [REDACTED]");
  assert.equal(replaced.cause, middle);
  assert.equal(middle.message, "middle [REDACTED]");
  assert.equal(middle.cause, "[Circular]");
  assertClean(replaced);

  // A frozen cause is replaced inside a writable parent.
  const frozenCause = Object.freeze(Object.assign(new Error(`frozen ${value}`), { code: "E1" }));
  const parent = new Error("parent", { cause: frozenCause });
  assert.equal(redactQaError(parent), parent);
  assert.notEqual(parent.cause, frozenCause);
  assert.equal(parent.cause.message, "frozen [REDACTED]");
  assert.equal(parent.cause.code, "E1");
  assertClean(parent);

  // A getter-only field (node:test prints getters) forces a replacement that
  // keeps the other fields, redacted.
  const getter = Object.assign(new Error(`getter ${value}`), {
    code: "EGETTER",
    stderr: `stderr ${value}`,
    request: { headers: { authorization: value } },
  });
  Object.defineProperty(getter, "stdout", { enumerable: true, get: () => `stdout ${value}` });
  const fromGetter = redactQaError(getter);
  assert.notEqual(fromGetter, getter);
  assert.equal(fromGetter.message, "getter [REDACTED]");
  assert.equal(fromGetter.stdout, "stdout [REDACTED]");
  assert.equal(fromGetter.stderr, "stderr [REDACTED]");
  assert.equal(fromGetter.code, "EGETTER");
  assert.deepEqual(fromGetter.request, { headers: { authorization: "[REDACTED]" } });
  assertClean(fromGetter);

  // Object-valued fields: a parsed response body, a Map, a Set, a class
  // instance, a symbol key, a self-containing array. Binary bytes around a
  // secret in a Buffer survive. Objects the error only refers to are copied,
  // never written: an assertion's `actual` may be a fixture still in use.
  class Detail {
    constructor() {
      this.raw = Buffer.from(value);
    }
  }
  const shared = { token: value };
  const symbol = Symbol("detail");
  const loop = [`loop ${value}`];
  loop.push(loop);
  const objects = Object.assign(new Error("objects"), {
    response: { status: 403, body: { message: `denied ${value}` } },
    headers: new Map([["authorization", value]]),
    raw: new Map([["body", Buffer.from(value)]]),
    seen: new Set([`set ${value}`]),
    detail: new Detail(),
    actual: shared,
    url: new URL(`https://registry.example.test/v2/?token=${value}`),
    requestHeaders: new Headers({ authorization: `Bearer ${value}` }),
    labels: Object.assign(new Map([["team", "qa"]]), { extra: `extra ${value}` }),
    loop,
    [symbol]: `symbol ${value}`,
    stdout: Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(value), Buffer.from([0xfe])]),
  });
  assert.equal(redactQaError(objects), objects);
  assert.equal(objects.response.body.message, "denied [REDACTED]");
  assert.equal(objects.response.status, 403);
  assert.equal(objects.headers.get("authorization"), "[REDACTED]");
  assert.equal(String(objects.raw.get("body")), "[REDACTED]");
  assert.deepEqual([...objects.seen], ["set [REDACTED]"]);
  assert.equal(String(objects.detail.raw), "[REDACTED]");
  assert.equal(objects.actual.token, "[REDACTED]");
  assert.equal(shared.token, value);
  assert.match(objects.url, /token=\[REDACTED\]/);
  assert.match(objects.requestHeaders, /Bearer \[REDACTED\]/);
  assert.match(objects.labels, /extra \[REDACTED\]/);
  assert.equal(objects.loop[0], "loop [REDACTED]");
  assert.equal(objects.loop[1], "[Circular]");
  assert.equal(objects[symbol], "symbol [REDACTED]");
  assert.deepEqual(
    objects.stdout,
    Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("[REDACTED]"), Buffer.from([0xfe])]),
  );
  assertClean(objects);

  // A frozen error reached again through another field of its cause.
  const frozenTop = new Error(`frozen top ${value}`);
  const holder = Object.assign(new Error("holder"), { original: frozenTop });
  frozenTop.cause = holder;
  Object.freeze(frozenTop);
  const replacedTop = redactQaError(frozenTop);
  assert.notEqual(replacedTop, frozenTop);
  assert.equal(replacedTop.cause, holder);
  assert.equal(holder.original, "[Circular]");
  assertClean(replacedTop);

  // A setter that throws makes the field unwritable, not redaction itself fail.
  const throwing = new Error(`setter ${value}`);
  Object.defineProperty(throwing, "detail", {
    enumerable: true,
    get: () => `detail ${value}`,
    set: () => {
      throw new Error("read-only");
    },
  });
  const fromThrowing = redactQaError(throwing);
  assert.notEqual(fromThrowing, throwing);
  assert.equal(fromThrowing.detail, "detail [REDACTED]");
  assertClean(fromThrowing);

  // A proxy whose traps throw falls back to a bare error with the message.
  const hostile = new Proxy(new Error(`proxy ${value}`), {
    ownKeys() {
      throw new Error("no keys");
    },
  });
  const fromHostile = redactQaError(hostile);
  assert.equal(fromHostile.message, "proxy [REDACTED]");
  assertClean(fromHostile);

  // A value first reached at the depth bound (its fields cut there) is walked
  // again when it is reached higher up, so the cut copy is not reused.
  const reused = { body: { token: value } };
  let chain = Object.assign(new Error("bottom"), { ref: reused });
  for (let i = 0; i < 6; i += 1) {
    chain = new Error(`link ${i}`, { cause: chain });
  }
  const reusedTop = Object.assign(new Error("reused", { cause: chain }), { ref: reused });
  assert.equal(redactQaError(reusedTop), reusedTop);
  assert.deepEqual(reusedTop.ref, { body: { token: "[REDACTED]" } });
  assert.equal(reused.body.token, value);
  assertClean(reusedTop);

  // A multi-line secret (a PEM key) behind hidden state is matched whole.
  const pem = [
    "-----BEGIN SYNTHETIC QA KEY-----",
    "c3ludGhldGljLXFhLWtleS1saW5lLW9uZS0yMDI2LWFhYWFhYWFhYWFhYWFhYWFh",
    "c3ludGhldGljLXFhLWtleS1saW5lLXR3by0yMDI2LWJiYmJiYmJiYmJiYmJiYmJi",
    "-----END SYNTHETIC QA KEY-----",
  ].join("\n");
  registerQaSecret(pem);
  const pending = Object.assign(new Error("pending"), { key: Promise.resolve(pem) });
  assert.equal(redactQaError(pending), pending);
  assert.ok(!printed(pending).includes("c3ludGhldGljLXFhLWtleS1saW5l"), printed(pending));

  // A multi-line JSON key file: inspect escapes its quotes unlike JSON does.
  const keyFile = JSON.stringify(
    { type: "service_account", private_key: "synthetic-qa-key-file-body-2026\u0001" },
    null,
    2,
  );
  registerQaSecret(keyFile);
  const keyed = Object.assign(new Error("keyed"), { file: Promise.resolve(keyFile) });
  assert.equal(redactQaError(keyed), keyed);
  assert.ok(!printed(keyed).includes("synthetic-qa-key-file-body"), printed(keyed));

  // An error without a secret is left as it is, cycle included.
  const clean = new Error("clean");
  clean.cause = clean;
  Object.freeze(clean);
  assert.equal(redactQaError(clean), clean);
  assert.equal(clean.cause, clean);
  const unprintable = Object.assign(new Error("unprintable"), {
    handle: { [inspect.custom]: () => assert.fail("not printable") },
  });
  Object.setPrototypeOf(unprintable.handle, class Handle {}.prototype);
  assert.equal(redactQaError(unprintable), unprintable);

  // A cause chain deeper than the bound is cut rather than left unredacted.
  let deep = new Error(`deepest ${value}`);
  for (let i = 0; i < 20; i += 1) {
    deep = Object.freeze(new Error(`level ${i}`, { cause: deep }));
  }
  deep = new Error(`top ${value}`, { cause: deep });
  const shallow = redactQaError(deep);
  assert.ok(printed(shallow).includes("[Truncated]"), printed(shallow));
  assertClean(shallow);
});

test(
  "node:test failure output carries no QA secret from nested error fields",
  { timeout: 60_000 },
  async (t) => {
    const { qaSecretVariants } = await import("../helpers/qa-secrets.mjs");
    const value = "synthetic-qa-reporter-secret-2026";
    const directory = await mkdtemp(join(tmpdir(), "qa-reporter-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const secretsModule = new URL("../helpers/qa-secrets.mjs", import.meta.url).href;
    const file = join(directory, "redacted.test.mjs");
    await writeFile(
      file,
      `
    import { execFile } from 'node:child_process';
    import test from 'node:test';
    import { promisify } from 'node:util';
    import { redactQaError, registerQaSecret } from ${JSON.stringify(secretsModule)};
    const value = ${JSON.stringify(value)};
    registerQaSecret(value);
    test('command failure', async () => {
      const error = await promisify(execFile)(process.execPath, [
        '-e', 'process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]); process.exit(3)', value,
      ], { encoding: 'buffer' }).catch((thrown) => thrown);
      error.cause = new AggregateError([new Error('nested ' + value)], 'aggregate', { cause: 'string ' + value });
      error.headers = new Map([['authorization', Buffer.from(value)]]);
      Object.defineProperty(error, 'detail', { enumerable: true, get: () => 'getter ' + value });
      throw redactQaError(error);
    });
  `,
    );
    // NODE_TEST_CONTEXT would make the child report to this runner instead of printing.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", file], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 1, output);
    // The failure printed the redacted fields, and no form of the secret.
    assert.match(output, /cmd: '.* \[REDACTED\]'/, output);
    assert.match(output, /detail: 'getter \[REDACTED\]'/, output);
    assert.match(output, /stdout: <Buffer 5b 52 45 44 41 43 54 45 44 5d>/, output);
    for (const variant of [...qaSecretVariants(value), inspectedBytes(value)]) {
      assert.ok(!output.includes(variant), `variant survived: ${output}`);
    }
  },
);

// How util.inspect prints the start of a Buffer holding `value`: hex bytes.
function inspectedBytes(value) {
  return [...Buffer.from(value).subarray(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

test("QA log tails drop the body of an unregistered key that starts above the tail", async () => {
  const { redactedQaTail } = await import("../helpers/qa-secrets.mjs");
  const lines = redactedQaTail(
    [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEsyntheticAAAA",
      "syntheticBodyLineTwoBBBBBBBBBBBB",
      "-----END OPENSSH PRIVATE KEY-----",
      "after",
    ].join("\n"),
    {},
    { lines: 3, lineChars: 200 },
  );
  assert.deepEqual(lines, [
    "[redacted credential-bearing line]",
    "[redacted credential-bearing line]",
    "after",
  ]);
});

test("failed native Gateway turns capture private bounded logs for the original revision", async (t) => {
  const { createNativePluginAssertions } = await import("../helpers/plugin-driver-real.mjs");
  for (const mode of ["capture", "read-unavailable", "write-unavailable", "success"]) {
    await t.test(mode, async () => {
      const credential = `private-runtime-fixture-${randomUUID()}`;
      const password = `private-gateway-fixture-${randomUUID()}`;
      const target = {
        namespaceId: "ns_log_fixture",
        agentId: "agt_log_fixture",
        revisionId: "rev_original",
      };
      const agent = {
        namespaceId: target.namespaceId,
        id: target.agentId,
        revision: { id: target.revisionId },
      };
      const reads = [];
      const records = [];
      let closed = false;
      // A real HTTP error crosses normalGatewayTurn. The log reader substitutes only
      // the external OCC response; this proves harness privacy, not a live model turn.
      const server = createServer((request, response) => {
        assert.equal(request.url, "/v1/chat/completions");
        // Simulate the fixture advancing after request admission: diagnostics stay pinned.
        agent.revision = { id: "rev_replaced" };
        response.writeHead(mode === "success" ? 200 : 500, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            mode === "success"
              ? { choices: [{ message: { content: "expected reply" } }] }
              : { error: { message: "internal error" } },
          ),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const fixture = createNativePluginAssertions({
        gatewayUrl: async () => ({
          url: `http://127.0.0.1:${server.address().port}`,
          gatewayPassword: password,
          close: async () => {
            closed = true;
          },
        }),
        execGateway: async () => ({
          label: "fixture",
          stdout: JSON.stringify({ chatCompletionsEnabled: true }),
        }),
        readRuntimeLogs: async (identity) => {
          reads.push(identity);
          if (mode === "read-unavailable" && identity.source === "agent") {
            throw new Error(credential);
          }
          return {
            records: [
              ...Array.from({ length: 120 }, () => ({
                type: "line",
                level: "info",
                message: "startup",
              })),
              {
                type: "line",
                level: "error",
                message: `native review failed ${password} ${credential} ${Buffer.from(credential).toString("base64")}`,
              },
              {
                type: "withheld",
                reason: "unrecognised_structured",
                count: 1,
                message: credential,
                fields: { raw: credential },
              },
            ],
          };
        },
        recordRuntimeLogs: async (record) => {
          if (mode === "write-unavailable") {
            throw new Error(credential);
          }
          records.push(record);
        },
      });
      try {
        const run = () =>
          fixture.normalGatewayTurn({
            agent,
            prompt: "fixture prompt",
            expectedPatterns: ["expected reply"],
            secrets: [credential],
          });
        if (mode === "success") {
          assert.equal(await run(), "expected reply");
          assert.deepEqual(reads, []);
          assert.deepEqual(records, []);
        } else {
          await assert.rejects(run, (error) => {
            assert.equal(error.name, "AssertionError");
            assert.equal(
              error.actual,
              500,
              "log collection failure must not replace the Gateway failure",
            );
            assert.equal(error.message.includes(credential), false);
            return true;
          });
          assert.deepEqual(
            reads,
            ["gateway", "agent"].map((source) => ({ ...target, source })),
          );
          if (mode === "write-unavailable") {
            assert.deepEqual(records, []);
          } else {
            assert.equal(records.length, 1);
            const { sources, ...identity } = records[0];
            assert.deepEqual(identity, target);
            const text = JSON.stringify(records);
            for (const secret of [
              credential,
              password,
              Buffer.from(credential).toString("base64"),
            ]) {
              assert.equal(
                text.includes(secret),
                false,
                "public artifacts must omit raw and encoded credentials",
              );
            }
            assert.match(text, /native review failed/);
            assert.match(text, /unrecognised_structured/);
            assert.equal(
              text.includes('"raw"'),
              false,
              "withheld API fields must not be resurrected",
            );
            assert.ok(
              sources.every((source) => source.unavailable === true || source.lines.length <= 80),
            );
            assert.ok(text.length < 150_000);
            if (mode === "read-unavailable") {
              assert.deepEqual(sources[1], { source: "agent", unavailable: true });
            }
          }
        }
        assert.equal(closed, true, "diagnostics must run before normal gateway cleanup completes");
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});

// The shapes the pinned Codex reviewer records on a tool result (finding 1980): a
// judgement carries risk and authorization; a failed-closed review carries neither.
const judgedDeny = {
  id: "review-judged",
  status: "denied",
  riskLevel: "high",
  userAuthorization: "low",
  rationale: "The read targets a calendar the user did not mention.",
};
const failedClosed = {
  id: "review-failed",
  status: "denied",
  rationale:
    "Automatic approval review failed: guardian review completed without an assessment payload",
};
const timedOut = {
  id: "review-timeout",
  status: "timed_out",
  rationale: "Automatic approval review timed out while evaluating the requested approval.",
};

test("approval review evidence tells a reviewer error from a deny judgement", async () => {
  const { approvalReviewKind, automaticReviewerErrored, describeApprovalReviews } =
    await import("../helpers/plugin-driver-real.mjs");
  assert.equal(approvalReviewKind(judgedDeny), "judged-deny");
  assert.equal(approvalReviewKind(failedClosed), "reviewer-error");
  assert.equal(approvalReviewKind(timedOut), "reviewer-error");
  assert.equal(approvalReviewKind({ id: "a", status: "approved", riskLevel: "low" }), "approved");
  assert.equal(approvalReviewKind({ id: "c", status: "aborted" }), "aborted");
  // Without the reviewer's own failure text, or with a judgement's risk level, a denial
  // stays a judgement or unclassified: a rationale alone cannot claim a reviewer error.
  assert.equal(approvalReviewKind({ id: "d", status: "denied" }), "denied-unclassified");
  assert.equal(
    approvalReviewKind({ ...failedClosed, riskLevel: "high" }),
    "judged-deny",
    "a judged rationale that quotes the failure text is still a judgement",
  );
  assert.equal(
    approvalReviewKind({ ...failedClosed, userAuthorization: "unknown" }),
    "judged-deny",
  );
  // A changed authorization may be the policy's own change, not reviewer trouble.
  const staleAuthorization = {
    id: "review-stale",
    status: "denied",
    rationale:
      "Automatic approval review failed: authorization changed before approval could be applied",
  };
  assert.equal(approvalReviewKind(staleAuthorization), "stale-authorization");

  const failedResult = (reviews) => [
    { toolCallId: "call-1", isError: true, approvalReviews: reviews },
  ];
  assert.equal(automaticReviewerErrored(failedResult([failedClosed])), true);
  assert.equal(automaticReviewerErrored(failedResult([timedOut])), true);
  assert.equal(automaticReviewerErrored(failedResult([judgedDeny])), false);
  assert.equal(automaticReviewerErrored(failedResult([failedClosed, judgedDeny])), false);
  assert.equal(automaticReviewerErrored(failedResult([{ id: "d", status: "denied" }])), false);
  assert.equal(automaticReviewerErrored(failedResult([])), false, "no review, no reviewer error");
  assert.equal(automaticReviewerErrored([]), false, "no call, no reviewer error");
  assert.equal(automaticReviewerErrored(failedResult([staleAuthorization])), false);
  assert.equal(
    automaticReviewerErrored([
      ...failedResult([failedClosed]),
      { toolCallId: "call-2", isError: true, approvalReviews: [] },
    ]),
    false,
    "every failed call needs its own reviewer error",
  );
  assert.equal(
    automaticReviewerErrored([
      { toolCallId: "call-1", isError: false, approvalReviews: [failedClosed] },
    ]),
    false,
    "a call that did not fail was not blocked by its reviewer",
  );

  assert.equal(
    describeApprovalReviews(failedResult([judgedDeny])),
    "judged-deny (risk: high, authorization: low): The read targets a calendar the user did not mention.",
  );
  assert.equal(
    describeApprovalReviews(failedResult([failedClosed])),
    `reviewer-error: ${failedClosed.rationale}`,
  );
  assert.equal(describeApprovalReviews(failedResult([])), "no approval review recorded");
  assert.equal(
    describeApprovalReviews(
      failedResult([
        { ...failedClosed, rationale: `${failedClosed.rationale}\n  caused by: eof\n` },
      ]),
    ),
    `reviewer-error: ${failedClosed.rationale} caused by: eof`,
    "a multi-line rationale stays on the failure's first line",
  );
});

function calendarEvidence(reviews) {
  return {
    exists: true,
    sessionId: "session-1",
    userMarkerSeen: true,
    assistantMarkerSeen: true,
    assistantError: false,
    calls: [{ seq: 5, id: "call-1", name: "calendar_read", mirrorIdentity: "t:tool:call-1:call" }],
    results: [
      {
        seq: 8,
        toolCallId: "call-1",
        toolName: "calendar_read",
        isError: true,
        deniedByUser: false,
        matchesResult: false,
        mirrorIdentity: "t:tool:call-1:result",
        approvalReviews: reviews,
      },
    ],
    codexTurns: [],
    diagnostics: {},
  };
}

test("a failed reviewed read names the review outcome before the evidence", async () => {
  const { createNativePluginAssertions } = await import("../helpers/plugin-driver-real.mjs");
  for (const [reviews, errored, reason] of [
    [[failedClosed], true, `reviewer-error: ${failedClosed.rationale}`],
    [[judgedDeny], false, "judged-deny (risk: high, authorization: low)"],
  ]) {
    const fixture = createNativePluginAssertions({
      gatewayUrl: async () => assert.fail("no Gateway turn"),
      proofMode: "codex",
      execGateway: async () => ({
        label: "fixture",
        stdout: JSON.stringify(calendarEvidence(reviews)),
      }),
    });
    await assert.rejects(
      fixture.assertSessionToolCallEvidence(
        {},
        {
          sessionKey: "agent:main:fixture",
          turnMarker: "M",
          toolName: "calendar_read",
          resultPattern: "x",
        },
      ),
      (error) => {
        assert.equal(error.name, "AssertionError");
        assert.equal(error.automaticReviewerErrored, errored);
        assert.ok(error.approvalReviewSummary.startsWith(reason), error.approvalReviewSummary);
        const [head] = error.message.split(": {");
        assert.ok(head.includes(`(approval reviews: ${reason}`), head);
        assert.match(error.message, /"approvalReviews":\[\{"id":"review-/);
        return true;
      },
    );
  }
});

test("an automatically reviewed Calendar read runs again once, only after a reviewer error", async (t) => {
  const { automaticallyReviewedRead } = await import("../helpers/calendar-review.mjs");
  const reviewerError = Object.assign(
    new assert.AssertionError({ message: "reviewer errored: {}" }),
    {
      automaticReviewerErrored: true,
      approvalReviewSummary: "reviewer-error: Automatic approval review failed: eof",
    },
  );
  const judged = Object.assign(new assert.AssertionError({ message: "judged deny: {}" }), {
    automaticReviewerErrored: false,
  });
  const success = { approvedReviewIds: ["review-ok"] };
  function fixture(outcomes) {
    const turns = [];
    const checks = [];
    return {
      turns,
      checks,
      async normalGatewayTurn(turn) {
        turns.push(turn);
      },
      async assertSessionToolCallEvidence(agent, options) {
        checks.push(options);
        const outcome = outcomes.shift();
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    };
  }
  const read = (f, logs) =>
    automaticallyReviewedRead(f, {
      agent: { id: "agt" },
      gatewayPassword: "pw",
      sessionKey: "agent:main:codex-calendar-automatic-fixture",
      prompt: "read",
      toolName: "calendar_read",
      resultPattern: "x",
      secrets: [],
      log: (line) => logs.push(line),
    });

  await t.test("first read passes: one turn", async () => {
    const f = fixture([success]);
    const logs = [];
    assert.equal(await read(f, logs), success);
    assert.equal(f.turns.length, 1);
    assert.deepEqual(logs, []);
    assert.equal(f.checks[0].requireAutomaticReview, true);
  });
  await t.test("reviewer error, then pass: a second turn in the same session", async () => {
    const f = fixture([reviewerError, success]);
    const logs = [];
    assert.equal(await read(f, logs), success);
    assert.equal(f.turns.length, 2);
    assert.equal(new Set(f.turns.map((turn) => turn.sessionKey)).size, 1);
    assert.notEqual(
      f.checks[0].turnMarker,
      f.checks[1].turnMarker,
      "each turn needs a fresh marker",
    );
    assert.ok(f.checks.every((check) => check.requireAutomaticReview === true));
    assert.equal(logs.length, 1);
    assert.match(
      logs[0],
      /automatic reviewer errored .* running the read once more: reviewer-error: Automatic approval review failed: eof$/,
    );
  });
  await t.test("deny judgement: fails without another turn", async () => {
    const f = fixture([judged, success]);
    await assert.rejects(read(f, []), (error) => error === judged);
    assert.equal(f.turns.length, 1);
  });
  await t.test("reviewer error twice: the second failure stands", async () => {
    const second = Object.assign(new assert.AssertionError({ message: "again: {}" }), {
      automaticReviewerErrored: true,
    });
    const f = fixture([reviewerError, second, success]);
    await assert.rejects(read(f, []), (error) => error === second);
    assert.equal(f.turns.length, 2);
  });
  await t.test("other failures: no retry", async () => {
    const other = new Error("transcript missing");
    const f = fixture([other, success]);
    await assert.rejects(read(f, []), (error) => error === other);
    assert.equal(f.turns.length, 1);
  });
});
