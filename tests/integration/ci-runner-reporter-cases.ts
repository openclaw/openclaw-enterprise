import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { finiteConversationScenarios } from "../fixtures/ci-runner-finite-conversation.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  createRunnerFixture as fixture,
  laneArgs,
  requireTestResult,
  runnerArtifactPaths,
  runRunnerSync,
  writeRunnerManifest,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";
import { selectPolicyProbeCommand } from "../helpers/openshell-policy-probe.ts";
import {
  firstRunnerRecord,
  parseRunnerRecord,
  runnerArray,
  runnerNamedRows,
  runnerRecord,
  runnerRecords,
  runnerText,
} from "./ci-runner-result-records.ts";

function readReportedTests(text: string) {
  const summary = parseRunnerRecord(text, "lane result");
  const file = firstRunnerRecord(summary.files, "file result");
  return runnerNamedRows(file.tests, "test results");
}

function readDiagnosticFailure(text: string) {
  const report = parseRunnerRecord(text, "diagnostics");
  const file = firstRunnerRecord(report.failures, "diagnostic failure");
  return {
    tests: runnerNamedRows(file.tests, "diagnostic test results"),
    omittedTests: file.omittedTests,
  };
}

export function registerReporterCases() {
  test("failure text is bounded and redacts env values and credential shapes", async () => {
    const { default: reporter } = await import("../../scripts/ci/reporter.ts");
    const { failureSecrets, redactFailure } = await import("../../scripts/ci/failure-redaction.ts");
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
    const render = async (cause: unknown) => {
      let text = "";
      for await (const chunk of reporter([
        { type: "test:fail", data: { name: "case", details: { error: { cause } } } },
      ])) {
        text += chunk;
      }
      const line = text.split("\n")[0];
      assert(line, "Expected a reporter failure event");
      const event = parseRunnerRecord(line, "reporter event");
      const data = runnerRecord(event.data, "reporter event data");
      const raw = runnerRecord(data.error, "reporter failure");
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
    assert.match(
      runnerText(error.message, "redacted message"),
      /^request failed for openclaw at x\.mjs\n/,
    );
    assert.match(
      runnerText(error.message, "redacted message"),
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
      assert.doesNotMatch(runnerText(error.message, "redacted message"), new RegExp(leaked));
    }
    assert.match(runnerText(error.frame, "redacted frame"), /^at /);
    // A stack quoted in the message is not the frame.
    const quoted = await render({
      message: "child failed\n    at quoted (/elsewhere/child.js:1:1)",
      stack:
        "Error: child failed\n    at quoted (/elsewhere/child.js:1:1)\n    at real (helper.mjs:2:3)",
    });
    assert.equal(quoted.frame, "at real (helper.mjs:2:3)");
    // A value split by the cut survives as neither the value nor a prefix of it.
    const long = await render(new Error(`${"x".repeat(16_370)} jobonlyopaque123`));
    const longMessage = runnerText(long.message, "redacted long message");
    assert.ok(longMessage.length < 700);
    assert.match(longMessage, /\.\.\. \[truncated\]$/);
    const straddle = await render(new Error(`${"y ".repeat(296)}key jobonlyopaque123 tail`));
    assert.doesNotMatch(runnerText(straddle.message, "redacted message"), /jobonly/);
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

    const result = runRunnerSync(laneArgs(root, "errors", "state/errors.jsonl", resultsPath));
    assert.equal(result.status, 1);
    const tests = readReportedTests(await readFile(resultsPath, "utf8"));
    // The stack header names the exception, and the frame skips Node's DOMException constructor.
    for (const [name, message, line] of [
      ["timeout", "TimeoutError: The operation was aborted due to timeout", 2],
      ["abort", "AbortError: This operation was aborted", 3],
      ["empty", "Error", 4],
    ] as const) {
      const error = runnerRecord(requireTestResult(tests, name).error, "test error");
      assert.equal(error.message, message);
      assert.match(
        runnerText(error.frame, "error frame"),
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
    const uri = "http://private-fixture.invalid:8083/policy-probe";
    const event = (command: string) => ({
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
      () => {
        selectPolicyProbeCommand([first, correct], { uri, port: 8083 }, () => {
          calls += 1;
          throw new Error("diagnostic write failed");
        });
      },
      { code: "ERR_ASSERTION" },
    );
    assert.equal(calls, 1);
    // Only completed execution records can establish the probe result.
    const selected = selectPolicyProbeCommand(
      [
        { method: "item/started", params: first.params },
        { method: "item/completed", params: { item: null } },
        correct,
      ],
      { uri, port: 8083 },
      () => {
        calls += 1;
      },
    );
    assert.equal(selected, correct.params.item);
    assert.equal(calls, 1, "successful probes emit no failure receipt");

    // A malformed first completion cannot yield policy evidence or select a later candidate.
    const malformed = {
      method: "item/completed",
      params: { item: { ...correct.params.item, exitCode: "0" } },
    };
    assert.throws(
      () => selectPolicyProbeCommand([malformed, correct], { uri, port: 8083 }, () => {}),
      { code: "ERR_ASSERTION", message: "expected a Codex command result" },
    );

    const root = await fixture(t);
    const resultsPath = join(root, "results/policy.json");
    const statePath = join(root, "state/policy.json");
    await writeFile(
      join(root, "tests/integration/policy.test.mjs"),
      [
        'import test from "node:test";',
        `import { selectPolicyProbeCommand } from ${JSON.stringify(new URL("../helpers/openshell-policy-probe.ts", import.meta.url).href)};`,
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
    await writeRunnerManifest(root, {
      lanes: { policy: { files: [{ path: "tests/integration/policy.test.mjs" }] } },
      groups: {
        ci: ["policy"],
      },
    });
    const result = runRunnerSync(laneArgs(root, "policy", statePath, resultsPath));
    assert.equal(result.status, 1);
    const summary = parseRunnerRecord(await readFile(resultsPath, "utf8"), "policy result");
    const file = firstRunnerRecord(summary.files, "policy file result");
    const error = runnerRecord(firstRunnerRecord(file.tests, "policy test").error, "policy error");
    assert.equal(runnerRecord(error.cause, "policy error cause").code, "ERR_ASSERTION");
    const measurements = runnerRecords(file.measurements, "policy measurements");
    const [control, denial, receipt] = measurements;
    assert(control && denial && receipt, "Expected three policy measurements");
    assert.equal(control.check, "second-agent-control-request");
    assert.equal(denial.check, "second-agent-denied-request");
    assert.equal(measurements.length, 3, "invalid or oversized receipts are rejected");
    assert.equal(receipt.commandCount, 19);
    assert.equal(receipt.candidateCount, 10);
    assert.equal(receipt.selectedIndex, 9);
    assert.equal(receipt.laterUriMatches, 1, "a later match beyond the detail cap remains visible");
    const commands = runnerRecords(receipt.commands, "policy commands");
    const [command] = commands;
    assert(command, "Expected the first policy command");
    assert.equal(commands.length, 8);
    assert.equal(
      command.hash,
      createHash("sha256").update(first.params.item.command).digest("hex"),
    );
    assert.equal(command.hasExpectedUri, false);
    assert.equal(command.hasInterpreter, true);
    assert.equal(command.hasUrllib, true);
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
    const original: object = Object.create(null);
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
        const errors: readonly unknown[] = error.errors;
        assert.equal(errors.length, 2);
        assert.equal(errors[0], original);
        assert.equal(errors[1], restoration);
        assert.match(
          runnerText(error.message, "redacted message"),
          /^Exercise: Failure details unavailable$/m,
        );
        assert.match(
          runnerText(error.message, "redacted message"),
          /^Restoration: synthetic restoration failure$/m,
        );
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
        `import { registerQaSecret } from ${JSON.stringify(new URL("../helpers/qa-secrets.ts", import.meta.url).href)};`,
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
    const result = runRunnerSync(laneArgs(root, "restoration", statePath, resultsPath));
    assert.equal(result.status, 1, result.stderr);
    const summaryText = await readFile(resultsPath, "utf8");
    const detailText = await readFile(`${statePath}.diagnostics.json`, "utf8");
    const tests = readReportedTests(summaryText);
    const { tests: details } = readDiagnosticFailure(detailText);
    for (const name of [
      "short nested failures",
      "long nested failures",
      "multiline nested failures",
      "key-tail nested failures",
    ]) {
      const failure = requireTestResult(tests, name);
      const detail = requireTestResult(details, name);
      const error = runnerRecord(failure.error, "test failure");
      for (const value of [error.message, detail.message]) {
        const message = runnerText(value, "retained failure message");
        assert.match(message, /original operation failed/);
        assert.match(message, /enabled restoration failed/);
        assert.match(message, /original policy restoration failed password=\[redacted\]/);
        assert.ok(message.length <= 600);
        if (name === "multiline nested failures") {
          assert.equal(message.match(/Node\.js v/g)?.length, 3);
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
    const fixtureUrl = new URL("../fixtures/ci-runner-finite-conversation.ts", import.meta.url)
      .href;
    // Scripted command responses exercise the real diagnostic producer and Gateway reader.
    await writeSingleFileRunnerLane(
      root,
      "conversation",
      "tests/integration/conversation.test.mjs",
      `import { registerFiniteConversationTests } from ${JSON.stringify(fixtureUrl)};
await registerFiniteConversationTests();
`,
    );
    const result = runRunnerSync(laneArgs(root, "conversation", statePath, resultsPath));
    assert.equal(result.status, 1, result.stderr);
    const summaryText = await readFile(resultsPath, "utf8");
    const detailText = await readFile(`${statePath}.diagnostics.json`, "utf8");
    const tests = readReportedTests(summaryText);
    const { tests: details, omittedTests } = readDiagnosticFailure(detailText);
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
    assert.equal(
      new Set(names).size,
      50,
      "all 50 synthetic conversation case names must be unique",
    );
    assert.deepEqual(
      names,
      finiteConversationScenarios.map(({ name }) => name),
      "synthetic conversation cases must appear in registration order",
    );
    let failures = 0;
    for (const [index, { name, expected }] of finiteConversationScenarios.entries()) {
      const observed = tests[index];
      assert(observed, `Missing result: ${name}`);
      assert.equal(observed.status, expected.status);
      if (expected.status === "passed") {
        continue;
      }
      const message = `Finite Git conversation verification failed (${expected.detail}).`;
      assert.equal(runnerRecord(observed.error, "conversation failure").message, message);
      const retained = details.find((entry) => entry.name === name);
      if (++failures <= 20) {
        assert.equal(retained?.message, message);
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
    const { default: reporter } = await import("../../scripts/ci/reporter.ts");
    const at = (name: string, line: number, nesting = 1) => ({
      name,
      line,
      column: 1,
      nesting,
      file: "/repo/a.mjs",
    });
    const interruptedEvent: {
      type: "test:interrupted";
      data: { file?: string; tests: ReturnType<typeof at>[] };
    } = { type: "test:interrupted", data: { tests: [at("/repo/a.mjs", 1, 0)] } };
    let text = "";
    for await (const chunk of reporter([
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
      interruptedEvent,
      { type: "test:fail", data: { name: "hangs", details: { error: new Error("cancelled") } } },
    ])) {
      text += chunk;
    }
    const sent = text
      .split("\n")
      .filter(Boolean)
      .map((line) => parseRunnerRecord(line, "reporter event"));
    const [interrupted] = sent;
    assert(interrupted?.type === "test:interrupted");
    const interruption = runnerRecord(interrupted.data, "interruption data");
    assert.deepEqual(interruption.running, [
      { name: "/repo/a.mjs", line: 1, nesting: 0 },
      { name: "hangs", line: 5, nesting: 1 },
      { name: "loop", line: 9, nesting: 1 },
    ]);
    const batches = sent
      .filter(({ type }) => type === "test:output")
      .map(({ data }) => {
        const output = runnerRecord(data, "reporter output batch");
        const { omitted } = output;
        assert(typeof omitted === "number", "Expected an omitted line count");
        const lines = runnerArray(output.lines, "output lines").map((line) =>
          runnerText(line, "output line"),
        );
        return { output, lines, omitted };
      });
    // Small batches, newest first, each counting the lines before it; nothing is sent twice.
    assert(batches.length > 1);
    assert(batches.every(({ output }) => JSON.stringify(output).length < 40 * 1024));
    assert.equal(batches[0]?.lines.at(-1), "stderr: last words");
    const omitted = batches.map(({ omitted }) => omitted);
    assert.deepEqual(
      omitted,
      [...omitted].sort((a, b) => b - a),
    );
    assert.equal(batches.at(-1)?.omitted, 52);
    const lines = batches.reverse().flatMap(({ lines }) => lines);
    assert.equal(lines.length, 400);
    assert.match(runnerText(lines[0], "first output line"), /^stdout: bulk 51 "+$/);
    assert.equal(new Set(lines).size, 400);
    assert.equal(sent.at(-1)?.type, "test:fail");
  });
}
