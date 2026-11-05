import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";
import { attachDevUpStartupDisposition } from "../helpers/dev-up-startup-disposition.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const execute = promisify(execFile);
const kind = "openshell-startup-process";
const runner = fileURLToPath(new URL("../../scripts/ci/run-tests.mjs", import.meta.url));

test("OpenShell startup diagnostics distinguish child process failures", async (t) => {
  const root = await temporaryDirectory(t, "openshell-startup-process-");
  const options = { maxBuffer: 1024, timeout: 5_000 };
  const nodeArgs = (code: string) => ["--input-type=module-typescript", "-e", code];
  const cases = [
    {
      command: process.execPath,
      args: nodeArgs("process.exit(23)"),
      diagnostic: { kind, outcome: "exit", exitCode: 23 },
    },
    {
      command: join(root, "missing-executable"),
      args: [],
      diagnostic: { kind, outcome: "launch-error", code: "ENOENT" },
    },
    {
      command: process.execPath,
      args: nodeArgs('process.kill(process.pid, "SIGTERM")'),
      diagnostic: { kind, outcome: "signal", signal: "SIGTERM" },
    },
    {
      command: process.execPath,
      args: nodeArgs('process.stdout.write("x".repeat(4096))'),
      diagnostic: { kind, outcome: "output-limit" },
    },
  ];
  for (const { command, args, diagnostic } of cases) {
    await assert.rejects(execute(command, args, options), (childError: unknown) => {
      const failure = new Error("OpenShell development startup failed:\nfixture output");
      const before = inspect(failure);
      attachDevUpStartupDisposition(failure, childError);
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(failure, "openclawCiDiagnostic")?.value,
        diagnostic,
      );
      assert.equal(failure.cause, undefined);
      assert.equal(inspect(failure), before);
      return true;
    });
  }

  // Overflow wins even if termination information is present on the same error.
  const overflow = new Error("bounded output exceeded");
  attachDevUpStartupDisposition(
    overflow,
    Object.assign(new Error(), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal: "SIGTERM" }),
  );
  assert.deepEqual(Object.getOwnPropertyDescriptor(overflow, "openclawCiDiagnostic")?.value, {
    kind,
    outcome: "output-limit",
  });

  const success = await execute(
    process.execPath,
    nodeArgs('process.stdout.write("ready")'),
    options,
  );
  assert.deepEqual(success, { stdout: "ready", stderr: "" });
  for (const value of [
    success,
    { code: 23 },
    ...[0, -1, 1.5, 256, Infinity, NaN].map((code) => Object.assign(new Error(), { code })),
    Object.assign(new Error(), { code: "ENOENT", syscall: "read" }),
    Object.assign(new Error(), { code: null, signal: "not-a-signal" }),
  ]) {
    const failure = new Error("unclassified");
    attachDevUpStartupDisposition(failure, value);
    assert.equal(Object.hasOwn(failure, "openclawCiDiagnostic"), false);
  }
});

test("CI results retain only closed OpenShell startup diagnostics", async (t) => {
  const root = await temporaryDirectory(t, "openshell-startup-ci-");
  const file = "tests/integration/diagnostic-fixture.test.ts";
  const manifest = join(root, "manifest.json");
  const results = join(root, "results.json");
  const valid = [
    { kind, outcome: "exit", exitCode: 23 },
    { kind, outcome: "launch-error", code: "ENOENT" },
    { kind, outcome: "signal", signal: "SIGTERM" },
    { kind, outcome: "output-limit" },
  ];
  const malformed = [
    { kind, outcome: "exit", exitCode: 0 },
    { kind, outcome: "exit", exitCode: "23" },
    { kind, outcome: "signal", signal: "not-a-signal" },
    { kind, outcome: "launch-error", code: "UNKNOWN" },
    { kind, outcome: "output-limit", detail: "unexpected field" },
    { kind, outcome: "exit", exitCode: 23, signal: "SIGTERM" },
  ];
  const diagnostics = [...valid, ...malformed];
  const names = diagnostics.map((_, index) => `fixture failure ${index}`);
  await mkdir(join(root, "tests/integration"), { recursive: true });
  // Use the actual Node test process, reporter and collector with an isolated lane.
  await writeFile(
    join(root, file),
    `import test from "node:test";
    for (const [name, diagnostic] of ${JSON.stringify(names.map((name, i) => [name, diagnostics[i]]))}) {
      test(name, () => {
        const failure = new Error("fixture startup failure");
        Object.defineProperty(failure, "openclawCiDiagnostic", { value: diagnostic });
        throw failure;
      });
    }`,
  );
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      groups: {},
      lanes: { fixture: { files: [{ path: file, expectedTests: names }] } },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "run",
      "fixture",
      "--root",
      root,
      "--manifest",
      manifest,
      "--state",
      join(root, "state.json"),
      "--results",
      results,
    ],
    { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH } },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stderr);
  const report: unknown = JSON.parse(await readFile(results, "utf8"));
  assert(report && typeof report === "object" && "files" in report && Array.isArray(report.files));
  const [reportedFile]: unknown[] = report.files;
  assert(reportedFile && typeof reportedFile === "object" && "tests" in reportedFile);
  assert("nodeExitCode" in reportedFile && reportedFile.nodeExitCode === 1);
  assert(Array.isArray(reportedFile.tests));
  const observed = reportedFile.tests.map((entry: unknown) => {
    assert(entry && typeof entry === "object" && "name" in entry && "error" in entry);
    assert(entry.error && typeof entry.error === "object" && "message" in entry.error);
    assert.equal(entry.error.message, "fixture startup failure");
    return [entry.name, "diagnostic" in entry.error ? entry.error.diagnostic : undefined];
  });
  assert.deepEqual(
    observed,
    names.map((name, i) => [name, valid[i]]),
  );
});
