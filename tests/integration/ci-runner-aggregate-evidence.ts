import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
  aggregateArgs,
  createRunnerFixture,
  currentSha,
  laneArgs,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";

interface AggregateReceipt {
  status: string;
  issues: { code: string; need?: string }[];
  lanes: { lane: string; status: string }[];
}

interface CaseEvidence {
  name: string;
  status: string;
}

interface FileEvidence {
  path: string;
  status: string;
  cleanup: { status: string };
  tests: CaseEvidence[];
}

interface LaneReceipt {
  scope: string;
  files: FileEvidence[];
}

interface AggregateEvidence {
  args: readonly string[];
  resultPath: string;
  receipt: LaneReceipt;
  file: string;
  name: string;
  fileEvidence: FileEvidence;
  required: CaseEvidence;
  optional: CaseEvidence;
}

export function readAggregateReceipt(
  result: ReturnType<typeof runRunnerSync>,
  exitCode: 0 | 1,
  diagnostic = result.stderr,
): AggregateReceipt {
  assert.equal(result.status, exitCode, diagnostic);
  const receipt = JSON.parse(result.stdout) as AggregateReceipt;
  assert.equal(receipt.status, exitCode === 0 ? "passed" : "failed");
  return receipt;
}

async function aggregateFiles(context: AggregateEvidence, files: readonly unknown[]) {
  // Each tamper starts from the authentic receipt, independent of prior cases.
  await writeJson(context.resultPath, { ...context.receipt, files });
  return runRunnerSync(context.args);
}

export async function checkAggregateEvidence(t: TestContext): Promise<void> {
  const root = await createRunnerFixture(t);
  const sha = currentSha();
  const file = "tests/integration/model.test.mjs";
  const name = "real model case";
  await writeRunnerManifest(root, {
    lanes: { "docker-model": { files: [{ path: file, expectedTests: [name] }] } },
    groups: { runtime: ["docker-model"] },
  });
  await writeJson(join(root, "results/docker-model.json"), {
    version: 1,
    command: "run",
    sourceSha: sha,
    lane: "docker-model",
    status: "passed",
    exitCode: 0,
    files: [],
  });

  const args = aggregateArgs(root, "docker-model");
  const tampered = runRunnerSync(args);
  assert.deepEqual(
    readAggregateReceipt(tampered, 1).issues.map((entry) => entry.code),
    ["missing-lane-evidence"],
  );

  // Produce full evidence with a required case and an optional nested case.
  await writeFile(
    join(root, file),
    [
      'import test from "node:test";',
      'await test("real model case", async (t) => {',
      '  await t.test("optional nested case", () => {});',
      "});",
      "",
    ].join("\n"),
  );
  const produced = runRunnerSync(
    laneArgs(root, "docker-model", "state/docker-model.json", "results/docker-model.json"),
  );
  assert.equal(produced.status, 0, produced.stderr);

  const passed = runRunnerSync(args);
  const summary = readAggregateReceipt(passed, 0);
  assert.deepEqual(
    summary.lanes.map((entry) => entry.lane),
    ["docker-model"],
  );

  const resultPath = join(root, "results/docker-model.json");
  const evidence = JSON.parse(await readFile(resultPath, "utf8")) as LaneReceipt;
  assert.equal(evidence.scope, "full");
  const fileEvidence = evidence.files[0];
  assert.ok(fileEvidence);
  const required = fileEvidence.tests.find((testCase) => testCase.name === name);
  const optional = fileEvidence.tests.find((testCase) => testCase.name === "optional nested case");
  assert.ok(required);
  assert.ok(optional);
  assert.equal(required.status, "passed");
  assert.equal(optional.status, "passed");
  const context: AggregateEvidence = {
    args,
    resultPath,
    receipt: evidence,
    file,
    name,
    fileEvidence,
    required,
    optional,
  };
  await registerDuplicateFileEvidenceCases(t, context);
  await registerRequiredCaseEvidenceCases(t, context);
}

async function registerDuplicateFileEvidenceCases(
  t: TestContext,
  context: AggregateEvidence,
): Promise<void> {
  const { file, fileEvidence } = context;
  const failedFileEvidence = {
    ...fileEvidence,
    status: "failed",
    cleanup: { status: "failed" },
  };
  const duplicateFileIssue = {
    code: "duplicate-lane-file",
    message: `lane docker-model has duplicate file evidence for ${file}`,
    lane: "docker-model",
    file,
  };
  const failedFileIssues = [
    {
      code: "lane-file-failed",
      message: "lane docker-model file did not pass",
      lane: "docker-model",
      file,
      status: "failed",
    },
    {
      code: "cleanup-failed",
      message: "lane docker-model file cleanup did not pass",
      lane: "docker-model",
      file,
    },
  ];
  for (const [label, files, issues] of [
    ["duplicate file fails then passes", [failedFileEvidence, fileEvidence], failedFileIssues],
    ["duplicate file passes then fails", [fileEvidence, failedFileEvidence], failedFileIssues],
    ["duplicate file passes both times", [fileEvidence, fileEvidence], []],
  ] as const) {
    await t.test(label, async () => {
      const result = await aggregateFiles(context, files);
      const aggregate = readAggregateReceipt(result, 1, result.stdout || result.stderr);
      assert.deepEqual(aggregate.issues, [duplicateFileIssue, ...issues]);
    });
  }

  await t.test("duplicate unregistered file evidence does not expose its path", async () => {
    const unregisteredPath = "tests/integration/untrusted-receipt-path-canary.test.mjs";
    const unregisteredFile = { ...fileEvidence, path: unregisteredPath };
    const result = await aggregateFiles(context, [
      fileEvidence,
      unregisteredFile,
      unregisteredFile,
    ]);
    const aggregate = readAggregateReceipt(result, 1);
    assert.ok(
      !result.stdout.includes(unregisteredPath) && !result.stderr.includes(unregisteredPath),
      "aggregate printed an unregistered receipt path",
    );
    assert.deepEqual(aggregate.issues, [
      {
        code: "duplicate-lane-file",
        message: "lane docker-model has duplicate file evidence for an unregistered file",
        lane: "docker-model",
      },
    ]);
  });
}

async function registerRequiredCaseEvidenceCases(
  t: TestContext,
  context: AggregateEvidence,
): Promise<void> {
  const { file, name, fileEvidence, required, optional } = context;
  const skipped = { ...required, status: "skipped" };
  const unpassed = (status: string) => ({
    code: "expected-test-not-passed",
    message: `expected test did not pass: ${name}`,
    file,
    name,
    status,
  });
  const marker = "untrusted-case-status-marker";
  const invalidStatuses = [
    ["string", marker],
    ["object", { text: marker }],
    ["array", [marker]],
  ];

  // Keep the passing rollups and vary the individual case evidence.
  for (const [label, cases, issues] of [
    ["required skip", [skipped], [unpassed("skipped")]],
    ["skip before duplicate pass", [skipped, required], [unpassed("skipped")]],
    ["pass before duplicate skip", [required, skipped], [unpassed("skipped")]],
    ["both duplicates pass", [required, required], []],
    ["missing status before duplicate pass", [{ name }, required], [unpassed("invalid")]],
    ...invalidStatuses.map(
      ([type, status]) =>
        [`invalid ${type} status`, [{ ...required, status }], [unpassed("invalid")]] as const,
    ),
    [
      "null row in valid JSON",
      [required, null],
      [
        {
          code: "invalid-test-evidence",
          message: "test evidence contains an invalid case entry",
          file,
        },
      ],
    ],
  ] as const) {
    await t.test(label, async () => {
      const result = await aggregateFiles(context, [
        { ...fileEvidence, tests: [optional, ...cases] },
      ]);
      assert.ok(
        !result.stdout.includes(marker) && !result.stderr.includes(marker),
        "aggregate printed untrusted case status",
      );
      const aggregate = readAggregateReceipt(result, issues.length === 0 ? 0 : 1, result.stdout);
      assert.deepEqual(aggregate.issues, issues);
    });
  }
}
