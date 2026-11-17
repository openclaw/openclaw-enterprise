import assert from "node:assert/strict";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  imageBuildFailureOutput,
  recordImageBuildFailure,
  runQaCommand,
  type ImageBuildEvidence,
  type QaCommandFixture,
  type QaCommandOptions,
} from "../helpers/qa-command.ts";
import { registerQaSecret } from "../helpers/qa-secrets.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

async function readPrivateLog(path: string): Promise<string> {
  const log = await open(path, "r");
  try {
    assert.equal((await log.stat()).mode & 0o777, 0o600);
    return await log.readFile("utf8");
  } finally {
    await log.close();
  }
}

function evidenceRecorder(artifacts: string): NonNullable<QaCommandFixture["record"]> {
  return async (name, value) => {
    const file = `kubernetes-${name}.json`;
    await writeFile(join(artifacts, file), JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    return file;
  };
}

async function commandEvidenceFixture(t: TestContext, prefix: string, privateInput: string) {
  const directory = await temporaryDirectory(t, prefix);
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);
  const f = {
    directory,
    stateDirectory: join(directory, "state"),
    // The subprocess receives the installation environment and can print its private value.
    env: { PATH: process.env.PATH, OCC_TEST_PRIVATE_INPUT: privateInput },
    record: evidenceRecorder(artifacts),
  } satisfies QaCommandFixture;
  return { f, artifacts };
}

function requiredImageBuildOutput(stderr: string, options?: { lines?: number }): string[] {
  const output = imageBuildFailureOutput(stderr, options);
  assert.ok(output);
  return output;
}

export function registerQaImageBuildEvidenceCases(): void {
  test("a failed image build keeps its failed step's output as redacted QA evidence", async () => {
    registerQaSecret("build-private-value");
    // In BuildKit plain progress, steps interleave and each line is prefixed by
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
    const step = requiredImageBuildOutput(stderr);
    assert.equal(step.length, 5);
    assert.ok(step.every((line) => line.startsWith("#41 ")));
    assert.match(step.at(-2) ?? "", /AssertionError/);
    assert.equal(requiredImageBuildOutput(stderr, { lines: 2 }).length, 2);

    const records: ImageBuildEvidence[] = [];
    const record = async (name: string, value: ImageBuildEvidence) => {
      records.push(value);
      return `kubernetes-${name}.json`;
    };
    const file = await recordImageBuildFailure(record, stderr, { PRIVATE_INPUT: "unused" });
    assert.match(file ?? "", /^kubernetes-image-build-failure-\d+\.json$/);
    assert.equal(records.length, 1);
    const [recorded] = records;
    assert.ok(recorded);
    assert.match(recorded.lines.join("\n"), /FAIL {2}src\/gateway\/server\.required-placement/);
    assert.doesNotMatch(JSON.stringify(recorded), /build-private-value/);

    // A podman build has no BuildKit steps: its last lines are kept.
    const podman = [
      "STEP 14/18: RUN node test.mjs",
      ...Array.from({ length: 300 }, (_, i) => `line ${i}`),
    ];
    podman.push(
      'Error: building at STEP "RUN node test.mjs": while running runtime: exit status 1',
    );
    const podmanOutput = requiredImageBuildOutput(podman.join("\n"));
    assert.equal(podmanOutput.length, 200);
    assert.match(podmanOutput.at(-1) ?? "", /^Error: building at STEP/);

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
    assert.equal(
      await recordImageBuildFailure(record, "dev-up: startup timed out\n", {}),
      undefined,
    );
    assert.equal(records.length, 1);
  });

  // A failing subprocess supplies the same stderr the installation runner sees during a build.
  // Compare the uploaded evidence with the private log and check protected output separately.
  test("the QA command runner records a failed image build step as redacted evidence", async (t) => {
    const { f, artifacts } = await commandEvidenceFixture(
      t,
      "qa-run-evidence-",
      "env-private-value-2025",
    );
    registerQaSecret("registered-private-2025");
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

    await assert.rejects(runQaCommand(f, process.execPath, ["-e", script]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /; failed image build step output: kubernetes-image-build-failure-\d+\.json(?:;|$)/,
      );
      return true;
    });
    const files = await readdir(artifacts);
    assert.equal(files.length, 1);
    const [file] = files;
    assert.ok(file);
    const evidence = await readFile(join(artifacts, file), "utf8");
    const parsed: unknown = JSON.parse(evidence);
    assert.ok(parsed !== null && typeof parsed === "object" && "lines" in parsed);
    assert.ok(Array.isArray(parsed.lines));
    const lines: readonly unknown[] = parsed.lines;
    assert.ok(lines.every((line) => typeof line === "string"));
    assert.ok(lines.some((line) => line.includes("FAIL  src/gateway/placement.test.ts")));
    assert.doesNotMatch(
      evidence,
      /registered-private-2025|env-private-value-2025|fake-bearer-token-2025|fakePemBodyLine2025/,
    );
    // Each line is cut to 800 characters.
    assert.ok(lines.includes(`#41 45.19 ${longLine}`.slice(0, 800) + "... [truncated]"));

    // The unredacted child output belongs only in the installation's private directory.
    const privateFiles = (await readdir(f.directory)).filter((file) => file.endsWith(".log"));
    assert.equal(privateFiles.length, 1);
    const [privateFile] = privateFiles;
    assert.ok(privateFile);
    const privatePath = join(f.directory, privateFile);
    assert.match(await readPrivateLog(privatePath), /env-private-value-2025/);

    // A protected command withholds raw output even from the installation's private log.
    await assert.rejects(
      runQaCommand(f, process.execPath, ["-e", script], { privateFailureOutput: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /failed image build step output/);
        return true;
      },
    );
    assert.deepEqual(await readdir(artifacts), files);
    const protectedLogs = (await readdir(f.directory)).filter(
      (file) => file.endsWith(".log") && file !== privateFile,
    );
    assert.equal(protectedLogs.length, 1);
    const [protectedFile] = protectedLogs;
    assert.ok(protectedFile);
    const protectedPath = join(f.directory, protectedFile);
    assert.equal(await readPrivateLog(protectedPath), "protected subprocess output withheld\n");
  });
}

export function registerQaCommandFailureCases(): void {
  // Real children distinguish an elapsed command deadline from an ordinary signal exit.
  // Neither private output nor argv may escape through the added timing diagnostics.
  test("QA command failures distinguish deadlines from signal exits without disclosing output", async (t) => {
    const directory = await temporaryDirectory(t, "qa-command-timeout-");
    const f = {
      directory,
      stateDirectory: join(directory, "state"),
      env: { PATH: process.env.PATH },
    };
    for (const scenario of [
      {
        name: "deadline",
        command: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM', () => process.exit(0)); console.error('private-timeout-canary'); setInterval(() => {}, 1000)",
        ],
        timeout: 1000,
        timedOut: true,
        // A graceful zero exit (or signal before the handler starts) cannot hide a timeout.
        allowExitCodes: [0, null],
      },
      {
        name: "signal",
        command: "/bin/sh",
        args: ["-c", "echo private-timeout-canary >&2; kill -PIPE $$"],
        timeout: 5000,
        timedOut: false,
        signal: "SIGPIPE",
      },
    ]) {
      await t.test(scenario.name, async () => {
        await assert.rejects(
          runQaCommand(f, scenario.command, scenario.args, {
            timeout: scenario.timeout,
            allowExitCodes: scenario.allowExitCodes,
            privateFailureOutput: true,
          }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok("timedOut" in error && "elapsedMs" in error && "timeoutMs" in error);
            assert.equal(error.timedOut, scenario.timedOut);
            assert.equal(error.timeoutMs, scenario.timeout);
            assert.ok(
              typeof error.elapsedMs === "number" &&
                Number.isInteger(error.elapsedMs) &&
                error.elapsedMs >= 0,
            );
            assert.ok(
              error.message.includes(`after ${error.elapsedMs} ms (limit ${scenario.timeout} ms)`),
            );
            if (scenario.timedOut) {
              assert.ok(error.elapsedMs >= scenario.timeout);
              assert.match(error.message, /timed out/);
            } else {
              assert.ok("signal" in error);
              assert.equal(error.signal, scenario.signal);
              assert.doesNotMatch(error.message, /timed out/);
            }
            assert.doesNotMatch(
              JSON.stringify(error),
              /private-timeout-canary|process\.on|kill -PIPE/,
            );
            assert.doesNotMatch(error.message, /private-timeout-canary|process\.on|kill -PIPE/);
            assert.ok(!Object.hasOwn(error, "stdout"));
            assert.ok(!Object.hasOwn(error, "stderr"));
            assert.ok(!Object.hasOwn(error, "cmd"));
            return true;
          },
        );
      });
    }
    // Explicitly allowed ordinary exits still succeed; timeout classification must not
    // turn a supported nonzero exit into a failure when no deadline fired.
    assert.equal(
      await runQaCommand(
        f,
        process.execPath,
        ["-e", "process.stdout.write('allowed'); process.exit(7)"],
        {
          timeout: 5000,
          allowExitCodes: [7],
        },
      ),
      "allowed",
    );
  });

  test("failed QA startup retains only bounded timing records and respects output protection", async (t) => {
    const { f, artifacts } = await commandEvidenceFixture(
      t,
      "qa-startup-timings-",
      "private-startup-canary",
    );
    // Only exact records from the CLI's timing protocol may cross into uploaded evidence.
    // Unknown stages, extra fields, malformed numbers and ordinary output stay private.
    const lines = [
      ...Array.from(
        { length: 65 },
        (_, i) => `[occ-dev-timing] stage=runtime-build elapsed_ms=${i} failed=false`,
      ),
      "[occ-dev-timing] stage=private-startup-canary elapsed_ms=1 failed=false",
      "[occ-dev-timing] stage=runtime-build elapsed_ms=1 failed=false token=private-startup-canary",
      "[occ-dev-timing] stage=runtime-build elapsed_ms=-1 failed=false",
      "[occ-dev-timing] stage=runtime-build elapsed_ms=1.5 failed=false",
      "[occ-dev-timing] stage=runtime-build elapsed_ms=9007199254740992 failed=false",
      "[occ-dev-timing] stage=runtime-build elapsed_ms=1 failed=unknown",
      "prefix [occ-dev-timing] stage=runtime-build elapsed_ms=1 failed=false",
      "[occ-dev-timing] stage=kubernetes-readiness elapsed_ms=80 failed=true",
    ];
    const write = `process.stdout.write(process.env.OCC_TEST_PRIVATE_INPUT + '\\n' + ${JSON.stringify(lines.join("\n") + "\n")});`;
    const run = (end: string, options: QaCommandOptions = {}, installation: QaCommandFixture = f) =>
      runQaCommand(installation, process.execPath, ["-e", write + end], options);

    // A real child emits timing records, then reaches the command deadline. The evidence
    // must survive timeout teardown even when the child handles SIGTERM with exit zero.
    await assert.rejects(
      run("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)", {
        timeout: 1000,
        captureStartupTimings: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("timedOut" in error);
        assert.equal(error.timedOut, true);
        assert.match(error.message, /startup timings: kubernetes-startup-timings-\d+\.json/);
        assert.doesNotMatch(error.message, /private-startup-canary|process\.stdout/);
        assert.ok(!Object.hasOwn(error, "stdout"));
        return true;
      },
    );
    const files = await readdir(artifacts);
    assert.equal(files.length, 1);
    const [file] = files;
    assert.ok(file);
    const evidence = await readFile(join(artifacts, file), "utf8");
    const parsed: unknown = JSON.parse(evidence);
    assert.deepEqual(parsed, {
      omittedRecords: 2,
      records: [
        ...Array.from({ length: 63 }, (_, index) => ({
          stage: "runtime-build",
          elapsedMs: index + 2,
          failed: false,
        })),
        { stage: "kubernetes-readiness", elapsedMs: 80, failed: true },
      ],
    });
    assert.ok(Buffer.byteLength(evidence) < 6_000);
    assert.doesNotMatch(
      evidence,
      /private-startup-canary|process\.stdout|token=|prefix|9007199254740992/,
    );

    // Neither a protected command, an ordinary command, nor an allowed exit writes evidence.
    for (const options of [{ captureStartupTimings: true, privateFailureOutput: true }, {}]) {
      await assert.rejects(run("process.exit(7)", options), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("code" in error);
        assert.equal(error.code, 7);
        assert.doesNotMatch(error.message, /startup timings|private-startup-canary/);
        return true;
      });
    }
    await run("process.exit(7)", { captureStartupTimings: true, allowExitCodes: [7] });
    assert.deepEqual(await readdir(artifacts), files);

    // Evidence is best effort: a storage failure cannot replace the original command failure
    // or disclose a storage error's potentially private details.
    await assert.rejects(
      run(
        "process.exit(7)",
        { captureStartupTimings: true },
        {
          ...f,
          record: evidenceRecorder(join(f.directory, "private-startup-canary")),
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("code" in error);
        assert.equal(error.code, 7);
        assert.match(error.message, /startup timings: unavailable/);
        assert.doesNotMatch(error.message, /private-startup-canary/);
        return true;
      },
    );
    assert.deepEqual(await readdir(artifacts), files);
  });

  // The retained window starts below the key's BEGIN line. With no END line, the whole
  // window must be masked.
  test("an image build step's unterminated private key is masked past the evidence window", async () => {
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
    const records: ImageBuildEvidence[] = [];
    await recordImageBuildFailure(
      async (name, value) => {
        records.push(value);
        return `kubernetes-${name}.json`;
      },
      stderr,
      {},
    );
    assert.equal(records.length, 1);
    const [recorded] = records;
    assert.ok(recorded);
    assert.equal(recorded.lines.length, 200);
    assert.doesNotMatch(JSON.stringify(recorded), /fakeKeyBody/);
  });
}
