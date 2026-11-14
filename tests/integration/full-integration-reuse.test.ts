import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  admitProducer,
  discoverProducer,
  pollMilliseconds,
  selectFreshLanes,
  validateResults,
  waitMilliseconds,
} from "../../scripts/ci/full-integration-reuse.ts";
import { loadTestSuites } from "../../scripts/ci/test-suites.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

import { array, jsonRecord, present, record, text } from "./full-integration-json-fixture.ts";
import { readSuiteLane, reuseFixture } from "./full-integration-reuse-fixture.ts";
import { readWorkflow } from "./full-integration-workflow-fixture.ts";

async function writeReuseMetadataFixture(
  preload: string,
  get: (path: string) => Promise<unknown>,
  routes: string[],
) {
  const responses = Object.fromEntries(
    await Promise.all(routes.map(async (path) => [path, await get(path)] as const)),
  );
  await writeFile(
    preload,
    [
      "const responses = " + JSON.stringify(responses) + ";",
      "const prefix = '/repos/openclaw/openclaw-enterprise';",
      "globalThis.fetch = async (input) => {",
      "  const url = new URL(input);",
      "  const path = url.pathname.slice(prefix.length) + url.search;",
      "  if (url.origin !== 'https://reuse-fixture.invalid' || !url.pathname.startsWith(prefix + '/') || !Object.hasOwn(responses, path)) {",
      "    throw new Error('Unexpected reuse fixture request');",
      "  }",
      "  return Response.json(responses[path]);",
      "};",
    ].join("\n"),
  );
}

function runReuseCommand(
  command: "discover" | "validate",
  {
    preload,
    directory,
    sha,
    event,
  }: { preload: string; directory: string; sha: string; event: string },
) {
  const result = spawnSync(
    process.execPath,
    ["--import", preload, "scripts/ci/full-integration-reuse.ts", command],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: join(directory, "step-output"),
        GITHUB_API_URL: "https://reuse-fixture.invalid",
        GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: event,
        GITHUB_SHA: sha,
        GH_TOKEN: "synthetic",
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

test("scheduled and manual Full Integration discover immutable push CI results through the CLI", async (t) => {
  const { get, sha, artifacts } = await reuseFixture();
  const fixtureRoot = await temporaryDirectory(t, "full-ci-reuse-consumers-");
  const preload = join(fixtureRoot, "fetch-fixture.mjs");
  await writeReuseMetadataFixture(preload, get, [
    "/actions/workflows/ci.yml",
    "/actions/workflows/456/runs?head_sha=" + sha + "&event=push&branch=main&per_page=20",
    "/actions/runs/123/attempts/2/jobs?per_page=100",
    "/actions/runs/123/artifacts?per_page=100",
  ]);
  for (const event of ["schedule", "workflow_dispatch", "push", "pull_request"]) {
    const directory = join(fixtureRoot, event);
    await mkdir(directory);
    const output = join(directory, "step-output");
    runReuseCommand("discover", { preload, directory, sha, event });
    if (event === "pull_request") {
      assert.equal(await readFile(output, "utf8"), "artifact_ids=\n");
      await assert.rejects(readFile(join(directory, "ci-reuse", "producer.json")), {
        code: "ENOENT",
      });
    } else {
      assert.equal(
        await readFile(output, "utf8"),
        "run_id=123\nartifact_ids=" + artifacts.map(({ id }) => id).join(",") + "\n",
        event,
      );
      const producer = jsonRecord(
        await readFile(join(directory, "ci-reuse", "producer.json"), "utf8"),
      );
      assert.deepEqual(
        { runId: producer.runId, attempt: producer.attempt, workflowId: producer.workflowId },
        { runId: 123, attempt: 2, workflowId: 456 },
      );
    }
  }
});

test("same-SHA reuse admits only successful canonical CI jobs and immutable current-attempt artifacts", async () => {
  const fixture = await reuseFixture();
  const { get, run, sha, rows, jobs, artifacts } = fixture;
  assert.ok(await admitProducer(get, run, sha, 456, rows));
  for (const patch of [
    { head_sha: "0".repeat(40) },
    { event: "pull_request" },
    { head_branch: "other" },
    { head_repository: { full_name: "someone/fork" } },
    { workflow_id: 999 },
    { path: ".github/workflows/other.yml" },
    { conclusion: "failure" },
    { run_attempt: 3 },
  ]) {
    assert.equal(await admitProducer(get, { ...run, ...patch }, sha, 456, rows), null);
  }
  for (const job of jobs) {
    job.conclusion = "skipped";
    assert.equal(await admitProducer(get, run, sha, 456, rows), null, job.name);
    job.conclusion = "success";
  }
  for (const patch of [
    { expired: true },
    { name: "ci-results-checks-baseline-1" },
    { workflow_run: { id: 999, head_sha: sha, head_branch: "main" } },
  ]) {
    const original = present(artifacts[0]);
    artifacts[0] = { ...original, ...patch };
    assert.equal(await admitProducer(get, run, sha, 456, rows), null);
    artifacts[0] = original;
  }
});

test("same-SHA reuse waits at most twelve minutes and falls back without delaying credentialed lanes", async () => {
  const { get, run, sha, rows } = await reuseFixture();
  let elapsed = 0;
  const sleeps: number[] = [];
  run.status = "in_progress";
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    elapsed += ms;
  };
  assert.equal(await discoverProducer({ get, sha, rows, now: () => elapsed, sleep }), null);
  assert.equal(elapsed, 720_000);
  assert.equal(waitMilliseconds, 720_000);
  assert.equal(pollMilliseconds, 30_000);
  assert.ok(sleeps.every((ms) => ms === 30_000));
  elapsed = 0;
  const admitted = await discoverProducer({
    get,
    sha,
    rows,
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
      if (elapsed === 60_000) {
        run.status = "completed";
      }
    },
  });
  assert.equal(present(admitted).runId, 123);
  assert.equal(elapsed, 60_000);
  const fallback = await selectFreshLanes(
    rows.map((row) => row.lane),
    "failure",
  );
  assert.equal(fallback.matrix.length, 17);
  assert.deepEqual(fallback.lanes, []);
  const reused = await selectFreshLanes(
    rows.map((row) => row.lane),
    "success",
  );
  assert.deepEqual(
    reused.matrix.map((row) => row.lane),
    ["k3d-observability-demo", "repository-credentials-container"],
  );
  const workflow = await readWorkflow("full-integration-execution");
  // The model job reads the artifact output directly; its producer must be a dependency.
  assert.ok(present(present(workflow.jobs["docker-model"]).needs).includes("runtime-artifact"));
  for (const lane of ["docker-model", "k3d-model", "gateway-routing", "slack", "openshell"]) {
    assert.equal([present(workflow.jobs[lane]).needs].flat().includes("ci-reuse"), false, lane);
  }
});

test("same-SHA reuse runs the existing full-coverage validator and rejects damaged or rerun evidence", async (t) => {
  const { get, run, sha, rows, artifacts } = await reuseFixture();
  const producer = await admitProducer(get, run, sha, 456, rows);
  const runnerTemp = await temporaryDirectory(t, "ci-reuse-");
  const directory = join(runnerTemp, "ci-reuse");
  const preload = join(runnerTemp, "fetch-fixture.mjs");
  const output = join(runnerTemp, "step-output");
  await mkdir(join(directory, "download"), { recursive: true });
  await writeFile(join(directory, "producer.json"), JSON.stringify(producer));
  const validateCommand = async () => {
    await writeReuseMetadataFixture(preload, get, [
      "/actions/runs/123",
      `/actions/runs/123/attempts/${run.run_attempt}/jobs?per_page=100`,
      "/actions/runs/123/artifacts?per_page=100",
    ]);
    await writeFile(output, "");
    runReuseCommand("validate", { preload, directory: runnerTemp, sha, event: "schedule" });
    return readFile(output, "utf8");
  };
  const manifest = loadTestSuites(
    fileURLToPath(new URL("../../scripts/ci/test-suites.json", import.meta.url)),
  );
  for (const lane of ["postgres", "checks-baseline-2"]) {
    const laneFiles = array(readSuiteLane(manifest, lane).files).map((raw) => {
      const file = record(raw);
      const expectedTests =
        file.expectedTests === undefined ? undefined : array(file.expectedTests).map(text);
      return { path: text(file.path), expectedTests };
    });
    const files = laneFiles.map((file) => {
      // Files without named expectations still need an observed case. These
      // receipts exercise validation, not the represented database/runtime.
      const names = file.expectedTests?.length ? file.expectedTests : [file.path];
      return {
        path: file.path,
        status: "passed",
        exercised: true,
        nodeExitCode: 0,
        signal: null,
        issues: [],
        counts: { total: names.length, passed: names.length, failed: 0, skipped: 0, todo: 0 },
        tests: names.map((name) => ({ name, status: "passed" })),
        cleanup: { status: "passed" },
      };
    });
    const total = files.reduce((count, file) => count + file.tests.length, 0);
    const summary = {
      version: 1,
      command: "run",
      sourceSha: sha,
      scope: "full",
      cleanup: { status: "passed" },
      lane,
      status: "passed",
      exitCode: 0,
      issues: [],
      files,
      counts: { total, passed: total, failed: 0, skipped: 0, todo: 0 },
    };
    const path = join(directory, "download", `${lane}.json`);
    const receipt = JSON.stringify(summary);
    const acceptedPath = join(directory, "accepted", `${lane}.json`);
    await writeFile(path, receipt);
    assert.equal(await validateCommand(), `lanes=["${lane}"]\n`);
    assert.equal(await readFile(acceptedPath, "utf8"), receipt);
    await rm(acceptedPath);
    for (const patch of [
      { scope: "focused" },
      { scope: undefined },
      { cleanup: undefined },
      { cleanup: { status: "failed" } },
      { cleanup: { status: "unknown" } },
      { sourceSha: "0".repeat(40) },
      { files: [] },
      { exitCode: 1 },
      { counts: undefined },
      ...["exercised", "nodeExitCode", "signal"].map((key) => ({
        files: summary.files.map((file) => ({ ...file, [key]: undefined })),
      })),
      { files: summary.files.map((file) => ({ ...file, cleanup: { status: "failed" } })) },
      { files: summary.files.map((file) => ({ ...file, tests: [] })) },
      ...laneFiles
        .filter((file) => !file.expectedTests?.length)
        .slice(0, 1)
        .map((unconstrained) => ({
          files: summary.files.map((file) =>
            file.path === unconstrained.path ? { ...file, tests: [] } : file,
          ),
        })),
    ]) {
      await writeFile(path, JSON.stringify({ ...summary, ...patch }));
      const accepted = await validateResults({ directory, producer, sha, get });
      assert.deepEqual(accepted, []);
      assert.ok(
        (await selectFreshLanes(accepted, "success")).matrix.some((row) => row.lane === lane),
      );
    }
    await writeFile(path, JSON.stringify({ ...summary, cleanup: { status: "failed" } }));
    assert.equal(await validateCommand(), "lanes=[]\n");
    await assert.rejects(readFile(acceptedPath), { code: "ENOENT" });
    await writeFile(path, receipt);

    // The new attempt can qualify by itself. It cannot vouch for a receipt
    // downloaded for the earlier producer.
    run.run_attempt = 3;
    for (const artifact of artifacts) {
      artifact.name = artifact.name.replace("attempt-2-", "attempt-3-");
      artifact.id += artifacts.length;
    }
    assert.equal(present(await admitProducer(get, run, sha, 456, rows)).attempt, 3);
    assert.equal(await validateCommand(), "lanes=[]\n");
    await assert.rejects(readFile(acceptedPath), { code: "ENOENT" });
    run.run_attempt = 2;
    for (const artifact of artifacts) {
      artifact.name = artifact.name.replace("attempt-3-", "attempt-2-");
      artifact.id -= artifacts.length;
    }
    await rm(path);
  }
});
