import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTestSuites } from "../../scripts/ci/test-suites.mjs";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = "scripts/ci/test-suites.json";
const installerFile = "tests/integration/local-first-agent-openshell-real.test.mjs";
const testedSha = "1".repeat(40);

type FileEntry = { path: string; expectedTests: string[] };
type Lane = { files: FileEntry[] };
type Suite = { lanes: Record<string, Lane>; groups: Record<string, string[]> };
type Result = {
  version: number;
  command: string;
  lane: string;
  scope: string;
  sourceSha: string;
  status: string;
  exitCode: number;
  files: {
    path: string;
    status: string;
    counts: { total: number };
    tests: { name: string; status: string }[];
    cleanup: { status: string };
  }[];
};

function command(script: string, args: string[], view = "default") {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env.PATH, GITHUB_SHA: testedSha, OCC_CI_SUITE_VIEW: view },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

const runner = "scripts/ci/run-tests.mjs";
const fullView = "full-integration";

function assertIssue(result: ReturnType<typeof command>, code: string) {
  assert.equal(result.status, 1, result.stderr);
  const summary: { issues: { code: string }[] } = JSON.parse(result.stdout);
  assert.ok(
    summary.issues.some((issue) => issue.code === code),
    JSON.stringify(summary.issues),
  );
}

function present<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data));
}

test("Full Integration partitions OpenShell without changing the default focused caller", (t) => {
  const legacy: Suite = loadTestSuites(join(root, manifest));
  const selected: Suite = loadTestSuites(join(root, manifest), fullView);
  const canonical = present(legacy.lanes.openshell);
  const shards = present(selected.groups.openshell);
  assert.deepEqual(shards, ["openshell-policy", "openshell-installers"]);
  assert.equal(selected.lanes.openshell, undefined);
  const allFiles = shards.flatMap((name) => present(selected.lanes[name]).files);
  assert.equal(allFiles.length, canonical.files.length);
  assert.deepEqual(
    [...allFiles].sort((a, b) => a.path.localeCompare(b.path)),
    [...canonical.files].sort((a, b) => a.path.localeCompare(b.path)),
  );
  for (const name of shards) {
    const lane = present(selected.lanes[name]);
    const paths = new Set(lane.files.map(({ path }) => path));
    assert.deepEqual(lane, {
      ...canonical,
      files: canonical.files.filter(({ path }) => paths.has(path)),
    });
  }

  const select = (lane: string, view?: string) =>
    command(runner, ["check-selection", lane, "--file", installerFile], view);
  assert.equal(select("openshell").status, 0);
  assert.equal(select("openshell-installers").status, 1);
  assert.equal(select("openshell-installers", fullView).status, 0);
  assert.equal(select("openshell-policy", fullView).status, 1);

  const state = join(temporaryDirectorySync(t, "openshell-view-state-"), "policy.json");
  const refused = command(
    "scripts/ci/prepare.mjs",
    ["--lane", "openshell-policy", "--selected-file", installerFile, "--state", state],
    fullView,
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Selected file must belong to the lane manifest/);
});

test("the full view refuses canonical overlap and the audit detects omitted files", (t) => {
  const directory = temporaryDirectorySync(t, "openshell-view-audit-");
  const source: Suite = loadTestSuites(join(root, manifest));
  const original = present(source.lanes.openshell);
  for (const { path } of original.files) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  const firstFile = original.files[0];
  assert.ok(firstFile);
  const path = join(directory, "suite.json");
  const audit = (files: FileEntry[]) => {
    writeJson(path, {
      version: 1,
      lanes: { openshell: { ...original, files } },
      groups: { full: ["openshell"] },
    });
    return command(runner, ["audit", "--root", directory, "--manifest", path], fullView);
  };
  assert.equal(audit(original.files).status, 0);
  const overlap = audit([...original.files, firstFile]);
  assert.equal(overlap.status, 1);
  assert.match(overlap.stderr, /two disjoint, nonempty OpenShell lanes/);
  assertIssue(audit(original.files.slice(1)), "unmapped-file");
});

test("both complete OpenShell receipts are required by targeted and full aggregation", (t) => {
  const directory = temporaryDirectorySync(t, "openshell-view-aggregate-");
  const suite: Suite = loadTestSuites(join(root, manifest), fullView);
  const lanes = present(suite.groups.openshell);
  const makeReceipt = (lane: string): Result => ({
    version: 1,
    command: "run",
    lane,
    scope: "full",
    sourceSha: testedSha,
    status: "passed",
    exitCode: 0,
    files: present(suite.lanes[lane]).files.map(({ path, expectedTests }) => ({
      path,
      status: "passed",
      counts: { total: expectedTests.length },
      tests: expectedTests.map((name) => ({ name, status: "passed" })),
      cleanup: { status: "passed" },
    })),
  });
  const [policy, installers] = lanes;
  assert.ok(policy && installers);
  const needs = join(directory, "needs.json");
  writeJson(needs, Object.fromEntries(lanes.map((lane) => [lane, { result: "success" }])));
  writeJson(join(directory, `${policy}.json`), makeReceipt(policy));
  const receiptPath = join(directory, `${installers}.json`);
  const aggregate = (group: string) =>
    command(
      runner,
      [
        "aggregate",
        group,
        "--root",
        directory,
        "--manifest",
        join(root, manifest),
        "--results-dir",
        directory,
        "--needs",
        needs,
        ...(group === "full" ? ["--lanes", JSON.stringify(lanes)] : []),
      ],
      fullView,
    );
  assertIssue(aggregate("openshell"), "missing-lane-output");
  for (const group of ["openshell", "full"]) {
    writeJson(receiptPath, makeReceipt(installers));
    const pass = aggregate(group);
    assert.equal(pass.status, 0, pass.stdout || pass.stderr);
    const reject = (receipt: Result, code: string) => {
      writeJson(receiptPath, receipt);
      assertIssue(aggregate(group), code);
    };
    reject({ ...makeReceipt(installers), sourceSha: "2".repeat(40) }, "source-sha-mismatch");
    reject({ ...makeReceipt(installers), scope: "focused" }, "focused-lane-evidence");
    const receipt = makeReceipt(installers);
    present(receipt.files[0]).tests.shift();
    reject(receipt, "missing-expected-test");
    reject({ ...makeReceipt(installers), status: "failed", exitCode: 1 }, "lane-failed");
    const cleanup = makeReceipt(installers);
    present(cleanup.files[0]).cleanup.status = "failed";
    reject(cleanup, "cleanup-failed");
  }
});
