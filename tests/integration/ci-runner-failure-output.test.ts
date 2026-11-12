import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  failureSecrets,
  redactFailureDetail,
  redactOutputLine,
} from "../../scripts/ci/failure-redaction.mjs";
import reporter from "../../scripts/ci/reporter.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  createRunnerFixture,
  laneArgs,
  runnerArtifactPaths,
  runRunnerSync,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line: unknown) => typeof line === "string");
}

type ReporterEvent =
  | { type: "test:pass" | "test:start" | "test:progress" }
  | { type: "test:fail"; stack: string | undefined }
  | { type: "test:output"; data: { lines: string[]; omitted: number } };

function reporterEvent(value: unknown): ReporterEvent {
  assert(isRecord(value) && isRecord(value.data), "reporter event must carry data");
  const { type, data } = value;
  switch (type) {
    case "test:pass":
    case "test:start":
    case "test:progress":
      return { type };
    case "test:fail": {
      const stack = isRecord(data.error) ? data.error.stack : undefined;
      assert(stack === undefined || typeof stack === "string", "invalid reporter failure stack");
      return { type, stack };
    }
    case "test:output": {
      const { lines, omitted } = data;
      assert(isStringArray(lines) && typeof omitted === "number", "invalid reporter output tail");
      assert(
        Object.keys(value).length === 2 && Object.keys(data).length === 2,
        "unexpected output fields",
      );
      return { type, data: { lines, omitted } };
    }
    default:
      assert.fail("unexpected reporter event");
  }
}

function outputTail(events: ReporterEvent[]) {
  const tail = events.at(-1);
  assert(tail?.type === "test:output", "the output tail must be the final event");
  return tail.data;
}

function compactFileResult(value: unknown) {
  assert(isRecord(value) && Array.isArray(value.files), "missing result files");
  const [file]: unknown[] = value.files;
  assert(
    isRecord(file) && typeof file.status === "string" && Array.isArray(file.tests),
    "invalid file result",
  );
  const tests = file.tests.map((entry: unknown) => {
    assert(
      isRecord(entry) && typeof entry.name === "string" && typeof entry.status === "string",
      "invalid compact test result",
    );
    const { name, status, error } = entry;
    if (name === "long failure") {
      assert(
        isRecord(error) && typeof error.message === "string",
        "missing compact failure message",
      );
      assert(error.stack === undefined, "the compact failure must omit its stack");
      return { name, status, message: error.message };
    }
    return { name, status };
  });
  return { status: file.status, measurements: file.measurements, tests };
}

function failureDiagnostics(value: unknown) {
  assert(
    isRecord(value) && typeof value.lane === "string" && Array.isArray(value.failures),
    "invalid diagnostics report",
  );
  assert.equal(value.failures.length, 1);
  const [record]: unknown[] = value.failures;
  assert(
    isRecord(record) && Array.isArray(record.tests) && isRecord(record.output),
    "invalid file diagnostics",
  );
  const tests: unknown[] = record.tests;
  const detail = tests.find((entry) => isRecord(entry) && entry.name === "long failure");
  assert(
    isRecord(detail) && typeof detail.message === "string" && typeof detail.stack === "string",
    "missing full failure details",
  );
  const { lines, omittedLines } = record.output;
  assert(isStringArray(lines), "missing diagnostic output lines");
  return {
    lane: value.lane,
    file: record.file,
    omittedTests: record.omittedTests,
    detail: { line: detail.line, message: detail.message, stack: detail.stack },
    output: { lines, omittedLines },
  };
}

test("the reporter forwards a failed file's output tail and whole stack only", async () => {
  const render = async (events: Iterable<{ type: string; data: object }>) => {
    const lines: ReporterEvent[] = [];
    let text = "";
    for await (const chunk of reporter(events)) {
      text += chunk;
    }
    for (const line of text.split("\n").filter(Boolean)) {
      const value: unknown = JSON.parse(line);
      lines.push(reporterEvent(value));
    }
    return lines;
  };
  const chatter = [
    { type: "test:stdout", data: { file: "a.mjs", message: "first line\nsplit " } },
    { type: "test:stderr", data: { file: "a.mjs", message: "err\n" } },
    { type: "test:stdout", data: { file: "a.mjs", message: "line\n" } },
    { type: "test:diagnostic", data: { file: "/repo/a.mjs", message: "phase timings" } },
    { type: "test:diagnostic", data: { message: "tests 1" } },
    ...Array.from({ length: 1_000 }, (_, index) => ({
      type: "test:stdout",
      data: { file: "a.mjs", message: `bulk ${index}\n` },
    })),
    { type: "test:stdout", data: { file: "a.mjs", message: "no newline" } },
  ];
  // A passing file sends only its case events.
  const passing = await render([...chatter, { type: "test:pass", data: { name: "case" } }]);
  assert.deepEqual(
    passing.map(({ type }) => type),
    ["test:pass"],
  );
  const failing = await render([
    { type: "test:stdout", data: { file: "a.mjs", message: "first line\nsplit " } },
    { type: "test:stderr", data: { file: "a.mjs", message: "err\n" } },
    { type: "test:stdout", data: { file: "a.mjs", message: "line\n" } },
    { type: "test:diagnostic", data: { file: "/repo/a.mjs", message: "phase timings" } },
    { type: "test:diagnostic", data: { message: "tests 1" } },
    { type: "test:fail", data: { name: "case", details: { error: new Error("boom") } } },
    { type: "test:stdout", data: { file: "a.mjs", message: "no newline" } },
  ]);
  assert.deepEqual(failing.at(-1), {
    type: "test:output",
    data: {
      lines: [
        "stdout: first line",
        "stderr: err",
        "stdout: split line",
        "diagnostic: phase timings",
        "stdout: no newline",
      ],
      omitted: 0,
    },
  });
  const failure = failing.at(0);
  assert(
    failure?.type === "test:fail" &&
      typeof failure.stack === "string" &&
      /^at /.test(failure.stack),
    "the first event must carry the failure stack",
  );
  // The tail keeps the last 400 lines and counts the rest.
  const chatty = await render([...chatter, { type: "test:fail", data: { name: "case" } }]);
  const tail = outputTail(chatty);
  assert.equal(tail.lines.length, 400);
  assert.equal(tail.lines.at(-1), "stdout: no newline");
  assert.equal(tail.lines.at(0), "stdout: bulk 601");
  assert.equal(tail.omitted, 605);

  // A split marker can arrive after stderr has already pushed its separator out
  // of the tail. Only an ordinary blank contributes to the omitted-line count.
  for (const marker of [true, false]) {
    const events = [
      { type: "test:stdout", data: { message: marker ? "\nopenclaw-ci-" : "\n" } },
      {
        type: "test:stderr",
        data: { message: Array.from({ length: 801 }, (_, i) => `err ${i}\n`).join("") },
      },
      {
        type: "test:stdout",
        data: {
          message: marker
            ? 'progress {"kind":"openshell-stage","stage":"installation","outcome":"started"}\n'
            : "resumed\n",
        },
      },
      { type: "test:fail", data: { name: "case" } },
    ];
    const result = outputTail(await render(events));
    assert.deepEqual(result.lines, [
      ...Array.from(
        { length: marker ? 400 : 399 },
        (_, i) => `stderr: err ${i + (marker ? 401 : 402)}`,
      ),
      ...(marker ? [] : ["stdout: resumed"]),
    ]);
    assert.equal(result.omitted, marker ? 401 : 403);
  }

  const secrets = failureSecrets([{ JOB_ONLY_KEY: "jobonlyopaque123" }]);
  const decisive = `${"x".repeat(700)}\nAuthorization: Basic c2hvcnQ=\nprobe code MODEL_PROBE_CPU_STARVED key jobonlyopaque123`;
  const detail = redactFailureDetail(
    { message: decisive, stack: "at helper (/repo/tests/a.mjs:2:3)\nat next (/repo/b.mjs:4:5)" },
    secrets,
    "/repo",
  );
  assert(typeof detail?.message === "string", "missing redacted failure message");
  // The whole message survives where the job log keeps 600 characters.
  assert(
    /probe code MODEL_PROBE_CPU_STARVED key \[env:JOB_ONLY_KEY\]$/.test(detail.message),
    "whole message must retain the redacted probe result",
  );
  assert(
    /\n\[redacted credential-bearing line\]\n/.test(detail.message),
    "authorization line must be redacted",
  );
  assert.equal(detail.stack, "at helper (tests/a.mjs:2:3)\nat next (b.mjs:4:5)");
  assert.equal(redactFailureDetail(undefined, secrets, "/repo"), undefined);
  assert(
    redactOutputLine(
      `stdout: proxy ${syntheticCredentialUrl({ username: "user", password: "pw", host: "example.test", port: undefined })}`,
      secrets,
      "/repo",
      1_000,
    ) === "[redacted credential-bearing line]",
    "unexpected redaction result",
  );
  assert.equal(
    redactOutputLine(`stdout: ${"y".repeat(2_000)}`, secrets, "/repo", 1_000),
    `stdout: ${"y".repeat(992)}... [truncated]`,
  );
  // A token the shape cannot match whole still drops its line.
  assert(
    redactOutputLine("stdout: Bearer abcdefghij%rest-of-the-value", secrets, "/repo", 1_000) ===
      "[redacted credential-bearing line]",
    "unexpected redaction result",
  );
  assert(
    redactFailureDetail({ message: "header Token abcdefgh%ijklmnop" }, secrets, "/repo")
      ?.message === "[redacted credential-bearing line]",
    "unexpected redaction result",
  );
  assert.equal(
    redactFailureDetail({ message: "SyntaxError: Unexpected token '}'" }, secrets, "/repo")
      ?.message,
    "SyntaxError: Unexpected token '}'",
  );
  // A message the reporter cut at 16 KiB still loses its possibly split tail after
  // the raw pass has shortened it.
  const cutMessage = `Bearer abcdefgh leak-value\n${"x".repeat(16_384 - 27 - 11)}jobonlyopaq`;
  assert.equal(cutMessage.length, 16_384);
  const cutDetail = redactFailureDetail({ message: cutMessage }, secrets, "/repo")?.message;
  assert(typeof cutDetail === "string", "missing redacted clipped message");
  assert(
    /^\[redacted credential-bearing line\]\nx+$/.test(cutDetail),
    "clipped message must retain its safe prefix",
  );
  assert(!/jobonly|leak-value/.test(cutDetail), "clipped message must omit secret fragments");
  // A control character inside a private key header cannot keep its body.
  const keyDetail = redactFailureDetail(
    {
      message: "-----BEGIN RSA PRIV\u0000ATE KEY-----\nMIIEbodyline\n-----END RSA PRIVATE KEY-----",
    },
    secrets,
    "/repo",
  )?.message;
  assert(
    typeof keyDetail === "string" && !/MIIEbodyline/.test(keyDetail),
    "redacted detail must omit the private key body",
  );
  // A credential marker drops its whole line, though the token shape consumes the marker.
  const sameLine = redactFailureDetail(
    {
      message: "before\nBearer abcdefgh unrelated-runtime-value-12345\nafter",
      stack: "at test (Bearer abcdefgh unrelated-runtime-value-12345)\nat next (b.mjs:1:1)",
    },
    secrets,
    "/repo",
  );
  assert(
    sameLine?.message === "before\n[redacted credential-bearing line]\nafter",
    "message must redact the full credential line",
  );
  assert(
    sameLine?.stack === "[redacted credential-bearing line]\nat next (b.mjs:1:1)",
    "stack must redact the full credential frame",
  );
  assert(
    redactFailureDetail({ message: "Bear\u001b[0mer abcdefgh other-value-9" }, secrets, "/repo")
      ?.message === "[redacted credential-bearing line]",
    "message must redact the credential line with control characters",
  );
  assert(
    redactOutputLine("stdout: Bear\u001b[0mer abcdefgh other-value-9", secrets, "/repo", 1_000) ===
      "[redacted credential-bearing line]",
    "unexpected redaction result",
  );
  // A private key is replaced whole, its body lines included.
  assert(
    redactFailureDetail(
      {
        message:
          "key\n-----BEGIN RSA PRIVATE KEY-----\nMIIEbody\n-----END RSA PRIVATE KEY-----\nend",
      },
      secrets,
      "/repo",
    )?.message === "key\n[redacted]\nend",
    "unexpected redaction result",
  );
  // Each line of a multi-line env value (a PEM body) is redacted on its own.
  const pem = failureSecrets([{ TLS_KEY: "line one opaque value\nline two opaque value\n" }]);
  assert(
    redactOutputLine("stdout: line two opaque value", pem, "/repo", 1_000) ===
      "stdout: [env:TLS_KEY]",
    "unexpected redaction result",
  );
  // The rest of a line cut at the input limit is dropped, not started as a new line.
  const cut = await render([
    { type: "test:stdout", data: { file: "a.mjs", message: "z".repeat(16_400) } },
    { type: "test:stdout", data: { file: "a.mjs", message: "1234567890 tail\nnext line\n" } },
    { type: "test:fail", data: { name: "case" } },
  ]);
  const cutLines = outputTail(cut).lines;
  assert.equal(cutLines.length, 2);
  const [clippedLine, nextLine] = cutLines;
  assert.equal(clippedLine?.length, 16_384);
  assert.equal(nextLine, "stdout: next line");
});

test("run keeps a failed file's whole messages, stacks and output in the diagnostics report", async (t) => {
  const root = await createRunnerFixture(t);
  const { statePath, resultsPath } = runnerArtifactPaths(root, "details");
  const failedPhase = {
    kind: "openshell-sandbox-phase",
    stage: "network-policy",
    outcome: "failed",
    elapsedMs: 1_234,
  };
  const failedStage = { ...failedPhase, kind: "openshell-stage" };
  const failedCheck = {
    kind: "openshell-network-policy-check",
    check: "provider-denial-observed",
  };
  const teardown = { kind: "openshell-fixture-teardown", outcome: "failed" };
  const nativeBodyCheck = {
    kind: "openshell-native-policy-check",
    stage: "native-policy-scopes",
    primaryCheck: "read.unauthenticated-code-16",
    cleanupCheck: null,
  };
  const nativeCleanupCheck = {
    ...nativeBodyCheck,
    primaryCheck: null,
    cleanupCheck: "cleanup.restore-auth.helm-upgrade",
  };
  const nativeBothChecks = { ...nativeBodyCheck, cleanupCheck: nativeCleanupCheck.cleanupCheck };
  const gatewayStatus = {
    kind: "openshell-gateway-turn-failure",
    checkpoint: "http-status",
    turn: 1,
    status: 503,
  };
  const gatewayRequest = { ...gatewayStatus, checkpoint: "turn-request", turn: 2, status: null };
  const gatewayNative = { ...gatewayStatus, checkpoint: "native-evidence", turn: 0, status: null };
  const gatewayUnknownStatus = { ...gatewayStatus, status: null };
  const phaseDiagnostics = [
    failedPhase,
    failedStage,
    failedCheck,
    { ...failedCheck, check: "fixture-opaque-phase-detail\nunknown check" },
    { ...teardown, outcome: "fixture-opaque-phase-detail" },
    nativeBodyCheck,
    nativeCleanupCheck,
    nativeBothChecks,
    { ...nativeBodyCheck, primaryCheck: "fixture-opaque-phase-detail" },
    { ...nativeBodyCheck, cleanupCheck: "fixture-opaque-phase-detail" },
    { ...nativeBodyCheck, stage: "fixture-opaque-phase-detail" },
    { ...nativeBodyCheck, primaryCheck: null },
    gatewayStatus,
    gatewayRequest,
    gatewayNative,
    gatewayUnknownStatus,
    { ...gatewayStatus, checkpoint: "fixture-opaque-phase-detail" },
    { ...gatewayStatus, turn: 3 },
    { ...gatewayStatus, turn: "1" },
    { ...gatewayStatus, status: 999 },
    { ...gatewayRequest, status: 200 },
    { ...gatewayNative, turn: 1 },
  ].map(
    (measurement) =>
      `openclaw-ci-measurement ${JSON.stringify({ ...measurement, detail: "fixture-opaque-phase-detail" })}`,
  );
  await writeFile(
    join(root, "tests/integration/details.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("passes", () => {});',
      'import { writeFileSync } from "node:fs";',
      "import { boundedTeardown } from " +
        JSON.stringify(new URL("../helpers/kubernetes-real.mjs", import.meta.url).href) +
        ";",
      'test("long failure", (t) => {',
      "  const { context } = boundedTeardown(t, {",
      "    log() {},",
      '    onOutcome(outcome) { t.diagnostic("openclaw-ci-measurement " + JSON.stringify({ kind: "openshell-fixture-teardown", outcome })); },',
      "  });",
      '  context.after(() => writeFileSync("teardown-completed", "yes"));',
      '  context.after(() => { throw new Error("fixture cleanup failed"); });',
      '  console.log("progress before the failure");',
      "  console.error(`credential ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL}`);",
      '  console.log("Authorization: Bearer abcdefghijklmnop0123");',
      '  t.diagnostic("phase timings 1234 ms");',
      `  for (const message of ${JSON.stringify(phaseDiagnostics)}) t.diagnostic(message);`,
      '  assert.fail(`password="fixture,\\nprivate-tail" phase=after\\nOCSF-JSON {"payload":"structured-private-early"}\\n${"stage line\\n".repeat(80)}OCSF-JSON {"payload":"structured-private-late"\\ndecisive line ${process.env.CI_RUNNER_FIXTURE_CREDENTIAL}`);',
      "});",
      'test("clipped failure", () => {',
      '  const clipped = (prefix, tail) => prefix.padEnd(16_384 - 9, "x") + "\\n" + tail;',
      '  const error = new Error(clipped("OCSF-JSON ", process.env.CI_RUNNER_FIXTURE_CREDENTIAL));',
      '  error.stack = "Error: clipped\\n    " + clipped("at OCSF-JSON ", "at " + process.env.CI_RUNNER_FIXTURE_CREDENTIAL).replace("\\n", "\\n    ");',
      "  throw error;",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/integration/quiet.test.mjs"),
    'import test from "node:test";\ntest("quiet", () => { console.log("passing output"); });\n',
  );
  await writeRunnerManifest(root, {
    lanes: {
      details: {
        files: [
          { path: "tests/integration/details.test.mjs" },
          { path: "tests/integration/quiet.test.mjs" },
        ],
      },
    },
  });

  const result = runRunnerSync(laneArgs(root, "details", statePath, resultsPath));

  assert.equal(result.status, 1);
  const summary: unknown = JSON.parse(await readFile(resultsPath, "utf8"));
  const compact = compactFileResult(summary);
  assert.equal(compact.status, "failed");
  const measurements = [
    failedPhase,
    failedStage,
    failedCheck,
    nativeBodyCheck,
    nativeCleanupCheck,
    nativeBothChecks,
    gatewayStatus,
    gatewayRequest,
    gatewayNative,
    gatewayUnknownStatus,
    teardown,
  ];
  assert(isDeepStrictEqual(compact.measurements, measurements), "unexpected accepted measurements");
  assert.equal(await readFile(join(root, "teardown-completed"), "utf8"), "yes");
  const failed = compact.tests.find(({ name }) => name === "long failure");
  // Results and the job log keep the short message only.
  assert(typeof failed?.message === "string", "missing long failure in compact results");
  assert(/\.\.\. \[truncated\]$/.test(failed.message), "compact message must be truncated");
  assert(
    /password="\[redacted\]" phase=after/.test(failed.message),
    "compact message must redact the password",
  );
  assert(
    !/private-tail|decisive line/.test(failed.message),
    "compact message must omit private and full detail",
  );
  assert(
    /run-tests: whole failure messages, stacks and output tails are in .*state\/details\.json\.diagnostics\.json \(artifact diagnostics-<prefix>-details-attempt-(?:\d+|<N>)\)/.test(
      result.stderr,
    ),
    "job log must point to the diagnostics artifact",
  );
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  assert(
    !/secretauthvalue|abcdefghijklmnop0123|private-tail|passing output/.test(text),
    "diagnostics must omit secrets and passing output",
  );
  assert(
    !/fixture-opaque-phase-detail/.test(`${result.stdout}\n${result.stderr}\n${text}`),
    "job output and diagnostics must omit private measurement fields",
  );
  const surfaces = `${JSON.stringify(summary)}\n${result.stdout}\n${result.stderr}\n${text}`;
  assert(
    !/structured-private|OCSF-JSON/.test(surfaces),
    "structured private lines must be omitted",
  );
  // Removing a structured line must not hide the reporter's cut through a secret.
  assert.equal(compact.tests.find(({ name }) => name === "clipped failure")?.status, "failed");
  assert(!/secretau|at secre/.test(surfaces), "clipped secret fragments must be omitted");
  const report: unknown = JSON.parse(text);
  const record = failureDiagnostics(report);
  assert.equal(record.lane, "details");
  assert.equal(record.file, "tests/integration/details.test.mjs");
  assert.equal(record.omittedTests, 0);
  const { detail } = record;
  assert.equal(detail.line, 18);
  assert(
    /decisive line \[env:CI_RUNNER_FIXTURE_CREDENTIAL\]$/.test(detail.message),
    "diagnostics must retain the redacted decisive line",
  );
  assert(
    /tests\/integration\/details\.test\.mjs:18:\d+/.test(detail.stack),
    "diagnostics must retain the original failure frame",
  );
  // stdout and stderr arrive on separate pipes, so only the set of lines is fixed.
  assert(
    isDeepStrictEqual([...record.output.lines].sort(), [
      "[redacted credential-bearing line]",
      "diagnostic: phase timings 1234 ms",
      "stderr: credential [env:CI_RUNNER_FIXTURE_CREDENTIAL]",
      "stdout: progress before the failure",
    ]),
    "unexpected diagnostic output lines",
  );
  assert.equal(record.output.omittedLines, 0);
});
