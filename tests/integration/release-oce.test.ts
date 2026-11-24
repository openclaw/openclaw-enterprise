import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { validateProducer, validateQualification } from "../../scripts/ci/release-oce.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { present, record, text } from "./full-integration-json-fixture.ts";
import { readWorkflow, workflowCondition } from "./full-integration-workflow-fixture.ts";

const repo = { full_name: "openclaw/openclaw-enterprise", private: false, default_branch: "main" };
const sha = "a".repeat(40);
const hex = "b".repeat(64);
const producer = {
  id: 123,
  workflow_id: 89,
  path: ".github/workflows/release-oce.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: sha,
  repository: repo,
  head_repository: repo,
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
};
const jobs = [
  "Approve release",
  "Verify approval",
  "Full Integration / Full Integration Aggregate",
  "Record qualified release",
].map((name) => ({ name, head_sha: sha, status: "completed", conclusion: "success" }));
const inputs: NodeJS.ProcessEnv = {
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  SOURCE_SHA: sha,
  CI_RUN_ID: "42",
  CI_ATTEMPT: "2",
  FULL_SUITE: `all:${sha}:123:1`,
  VERSION: "1.2.3",
  IMAGE_VERSION: "1.2.3",
  CLI_VERSION: "v1.2.3",
  CLI_CI_ATTEMPT: "2",
  IMAGE_CONTROLLER: `sha256:${hex}`,
  IMAGE_RUNTIME: `sha256:${"c".repeat(64)}`,
  CHART_SHA256: hex,
  CLI_SHA256SUMS_DIGEST: hex,
  PUBLISH: "true",
  IMAGE_TAG: "candidate",
  GITHUB_ACTOR: "dispatcher",
};

test("release requires successful full coverage for the reviewed SHA, run and first attempt", () => {
  const good = validateQualification(inputs);
  assert.equal(good.alias, "candidate");
  assert.equal(validateQualification({ ...inputs, IMAGE_TAG: "" }).alias, "latest");
  for (const changed of [
    { FULL_SUITE: undefined },
    { FULL_SUITE: `all:${sha}:124:1` },
    { FULL_SUITE: `all:${sha}:123:2` },
    { FULL_SUITE: `docker-model:${sha}:123:1` },
    { SOURCE_SHA: "f".repeat(40) },
    { CLI_CI_ATTEMPT: "1" },
    { IMAGE_CONTROLLER: "" },
    { CHART_SHA256: "" },
    { CLI_SHA256SUMS_DIGEST: "" },
    { CLI_VERSION: "v1.2.2" },
    { IMAGE_TAG: "sha-latest" },
    { IMAGE_TAG: "bootstrap-current" },
    { IMAGE_TAG: "1.2.3" },
  ]) {
    assert.throws(
      () => validateQualification({ ...inputs, ...changed }),
      assert.AssertionError,
      JSON.stringify(changed),
    );
  }
  // A failed release can have a green preparation job even if the actual full
  // aggregate failed or was skipped. Recovery checks the original attempt's jobs.
  const recovery = { ...inputs, RECOVERY_RUN_ID: "123" };
  validateProducer(producer, jobs, recovery);
  for (const changed of [
    { path: ".github/workflows/container-publish.yml" },
    { run_attempt: 2 },
    { head_sha: "f".repeat(40) },
    { status: "in_progress" },
  ]) {
    assert.throws(
      () => validateProducer({ ...producer, ...changed }, jobs, recovery),
      assert.AssertionError,
    );
  }
  for (const name of jobs.map((job) => job.name)) {
    for (const conclusion of ["cancelled", "skipped", "failure", "missing"]) {
      const evidence = jobs.flatMap((job) =>
        job.name !== name ? [job] : conclusion === "missing" ? [] : [{ ...job, conclusion }],
      );
      assert.throws(
        () => validateProducer(producer, evidence, recovery),
        assert.AssertionError,
        `${name} ${conclusion}`,
      );
    }
  }
});

test("recovery consumes the recorded inventory and rejects rehearsal, replaced or expired artifacts", async (t) => {
  const directory = await temporaryDirectory(t, "oce-release-evidence-");
  const fixture = join(directory, "metadata.mjs");
  // Supply only observed read API shapes. The shipped commands write and read
  // the qualification manifest, bind CI and reject changes across dispatches.
  await writeFile(
    fixture,
    `
    globalThis.fetch = async (url, options) => {
      const {origin, pathname} = new URL(url);
      const metadata = JSON.parse(process.env.RELEASE_API);
      if (origin !== "https://api.github.com" || options?.method && options.method !== "GET" || !Object.hasOwn(metadata, pathname)) {
        throw new Error("Unexpected request " + url);
      }
      return Response.json(metadata[pathname]);
    };
  `,
  );
  const api = "/repos/openclaw/openclaw-enterprise/actions";
  const artifactPath = api + "/runs/123/artifacts";
  const artifacts = ["container-controller", "container-runtime", "release-chart", "occ-cli"].map(
    (prefix, index) => ({
      name: prefix + "-123-1",
      id: 1200 + index,
      expired: false,
      digest: `sha256:${hex}`,
    }),
  );
  const ci = {
    ...producer,
    id: 42,
    path: ".github/workflows/ci.yml",
    event: "push",
    workflow_id: 88,
    conclusion: "success",
    run_attempt: 2,
  };
  const metadata = {
    [artifactPath]: { artifacts },
    [api + "/workflows/release-oce.yml"]: { id: 89, path: producer.path, state: "active" },
    [api + "/runs/123"]: producer,
    [api + "/runs/123/attempts/1/jobs"]: { jobs },
    [api + "/workflows/ci.yml"]: { id: 88, path: ci.path, state: "active" },
    [api + "/runs/42"]: ci,
    [api + "/runs/42/attempts/2/jobs"]: {
      jobs: [{ name: "CI Required", status: "completed", conclusion: "success", head_sha: sha }],
    },
  };
  const command = (
    operation: "record" | "verify",
    changed: NodeJS.ProcessEnv = {},
    observed = metadata,
  ) => {
    const result = spawnSync(
      process.execPath,
      ["--import", fixture, "scripts/ci/release-oce.ts", operation, directory],
      {
        env: {
          ...inputs,
          GH_TOKEN: "fixture",
          RELEASE_API: JSON.stringify(observed),
          GITHUB_OUTPUT: join(directory, "output"),
          GITHUB_STEP_SUMMARY: join(directory, "summary"),
          ...changed,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.error, undefined);
    return result;
  };
  const fresh = { GITHUB_RUN_ID: "789", RECOVERY_RUN_ID: "123" };
  const rehearsal = command("record", { PUBLISH: "false" });
  assert.equal(rehearsal.status, 0, rehearsal.stderr);
  assert.match(command("verify", fresh).stderr, /rehearsal/i);
  const qualified = command("record");
  assert.equal(qualified.status, 0, qualified.stderr);
  const resolved = command("verify", fresh);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.match(await readFile(join(directory, "output"), "utf8"), new RegExp(`cli_digest=${hex}`));
  for (const invalid of [{ IMAGE_TAG: "latest" }, { CI_ATTEMPT: "1" }, { VERSION: "1.2.4" }]) {
    assert.notEqual(command("verify", { ...fresh, ...invalid }).status, 0);
  }
  for (const changed of [{ id: 2200 }, { expired: true }, { digest: `sha256:${"d".repeat(64)}` }]) {
    const moved = artifacts.map((item, index) => (index === 0 ? { ...item, ...changed } : item));
    const rejected = command("verify", fresh, {
      ...metadata,
      [artifactPath]: { artifacts: moved },
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /inventory changed|artifact expired/i);
  }
});

test("only approved publish runs can enter the shared lock and move aliases after the CLI", async (t) => {
  const release = await readWorkflow("release-oce");
  const dispatch = record(record(release.on).workflow_dispatch);
  assert.deepEqual(Object.keys(record(release.on)), ["workflow_dispatch"]);
  assert.equal(record(record(dispatch.inputs).publish).default, false);
  const publish = present(release.jobs.publish);
  assert.deepEqual(release.permissions, {});
  assert.deepEqual(publish.concurrency, {
    group: "enterprise-container-publish",
    "cancel-in-progress": false,
  });
  for (const [id, job] of Object.entries(release.jobs)) {
    if (id !== "publish") {
      assert.ok(!Object.values(record(job.permissions ?? {})).includes("write"), id);
    }
  }
  const permitsPublication = (
    publishInput: boolean,
    recovery: string,
    qualified: string,
    approval = "success",
  ) =>
    workflowCondition(publish.if, {
      inputs: { publish: publishInput, recovery_run_id: recovery },
      needs: {
        validate: { result: "success" },
        approval: { result: approval },
        qualify: { result: qualified },
      },
    });
  assert.equal(permitsPublication(false, "", "success"), false);
  assert.equal(permitsPublication(true, "", "success"), true);
  for (const outcome of ["skipped", "failure", "cancelled"]) {
    assert.equal(permitsPublication(true, "", outcome), false);
    assert.equal(permitsPublication(true, "", "success", outcome), false);
  }
  assert.equal(permitsPublication(true, "123", "skipped"), true);
  assert.equal(permitsPublication(true, "123", "skipped", "failure"), false);

  const integration = present(release.jobs.integration);
  assert.equal(integration.uses, "./.github/workflows/full-integration-execution.yml");
  assert.equal(record(integration.with).lane, "all");
  assert.equal(release.jobs.approve?.environment, "integration-main-approval");
  assert.equal(integration.needs, "approval");
  const gate = present(
    release.jobs.qualify?.steps?.find((step) => record(step.env ?? {}).FULL_SUITE !== undefined),
  );
  assert.equal(record(gate.env).FULL_SUITE, "${{ needs.integration.outputs.full_suite }}");
  const directory = await temporaryDirectory(t, "oce-release-job-gate-");
  const success = { INTEGRATION_RESULT: "success", IMAGE_RESULT: "success", CLI_RESULT: "success" };
  for (const key of Object.keys(success)) {
    for (const outcome of ["skipped", "failure", "cancelled"]) {
      // Execute the shipped gate. GitHub supplies the outcome and runs shell
      // steps with errexit. A rejected result must fail before writing evidence.
      const result = spawnSync("bash", ["-ec", text(gate.run)], {
        env: { ...process.env, ...success, [key]: outcome, RUNNER_TEMP: directory },
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
    }
  }
  const wrapper = await readWorkflow("release-oce-publish");
  const stages = Object.entries(wrapper.jobs);
  const [immutableId] = present(
    stages.find(([, job]) => record(job.with ?? {}).phase === "immutable"),
  );
  const [cliId, cli] = present(
    stages.find(([, job]) => job.uses === "./.github/workflows/cli-release-publish.yml"),
  );
  const [, aliases] = present(stages.find(([, job]) => record(job.with ?? {}).phase === "aliases"));
  assert.ok([cli.needs].flat().includes(immutableId));
  assert.ok([aliases.needs].flat().includes(cliId));
  assert.equal(aliases["continue-on-error"], undefined);
  assert.equal(cli["continue-on-error"], undefined);
  // Permission ceilings follow the public destination. The locked wrapper may
  // delegate package writes to the registry and repository writes to release assets.
  assert.equal(record(aliases.permissions).contents, "read");
  assert.equal(record(aliases.permissions).packages, "write");
  assert.equal(record(cli.permissions).contents, "write");
  assert.notEqual(record(cli.permissions).packages, "write");
});
