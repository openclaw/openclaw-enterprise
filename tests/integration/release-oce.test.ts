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
const dispatchSha = "c".repeat(40);
const recoverySha = "d".repeat(40);
const hex = "b".repeat(64);
const producer = {
  id: 123,
  workflow_id: 89,
  path: ".github/workflows/release-oce.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: dispatchSha,
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
].map((name) => ({ name, head_sha: dispatchSha, status: "completed", conclusion: "success" }));
const inputs: NodeJS.ProcessEnv = {
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  SOURCE_SHA: sha,
  GITHUB_WORKFLOW_SHA: dispatchSha,
  GITHUB_SHA: dispatchSha,
  GITHUB_REPOSITORY: repo.full_name,
  GITHUB_WORKFLOW_REF: repo.full_name + "/.github/workflows/release-oce.yml@refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
  FULL_SUITE: `all:${sha}:123:1`,
  VERSION: "1.2.3",
  IMAGE_VERSION: "1.2.3",
  CLI_VERSION: "v1.2.3",
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
  assert.equal(good.source, sha);
  assert.equal(good.workflowSha, dispatchSha);
  assert.equal(validateQualification({ ...inputs, IMAGE_TAG: "" }).alias, "latest");
  for (const changed of [
    { FULL_SUITE: undefined },
    { FULL_SUITE: `all:${sha}:124:1` },
    { FULL_SUITE: `all:${sha}:123:2` },
    { FULL_SUITE: `docker-model:${sha}:123:1` },
    { SOURCE_SHA: "f".repeat(40) },
    { FULL_SUITE: `all:${dispatchSha}:123:1` },
    { IMAGE_CONTROLLER: "" },
    { CHART_SHA256: "" },
    { CLI_SHA256SUMS_DIGEST: "" },
    { CLI_VERSION: "v1.2.2" },
    { IMAGES_ONLY: "true" },
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
  const recovery = {
    ...inputs,
    GITHUB_WORKFLOW_SHA: recoverySha,
    GITHUB_SHA: recoverySha,
    RECOVERY_RUN_ID: "123",
  };
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
  // the qualification manifest. Any lookup of a push CI run or workflow fails.
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
  const repositoryPath = "/repos/" + repo.full_name;
  const compare = (head: string) => `${repositoryPath}/compare/${sha}...${head}`;
  const metadata: Record<string, unknown> = {
    [repositoryPath]: repo,
    [repositoryPath + "/environments/container-publish"]: {
      name: "container-publish",
      can_admins_bypass: false,
      deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    },
    [repositoryPath + "/environments/container-publish/deployment-branch-policies"]: {
      branch_policies: [{ name: "main", type: "branch" }],
    },
    [compare("main")]: { status: "ahead" },
    [compare(dispatchSha)]: { status: "ahead" },
    [compare(recoverySha)]: { status: "ahead" },
    [artifactPath]: { artifacts },
    [api + "/workflows/release-oce.yml"]: { id: 89, path: producer.path, state: "active" },
    [api + "/runs/123"]: producer,
    [api + "/runs/123/attempts/1/jobs"]: { jobs },
  };
  const command = (
    operation: "admit" | "record" | "verify",
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
  const fresh = {
    GITHUB_RUN_ID: "789",
    GITHUB_WORKFLOW_SHA: recoverySha,
    GITHUB_SHA: recoverySha,
    RECOVERY_RUN_ID: "123",
  };
  // The reviewed commit is already behind protected main at the initial
  // dispatch. Neither the original proof nor its recovery has a push CI run.
  for (const context of [{ GITHUB_WORKFLOW_SHA: dispatchSha }, fresh]) {
    const admitted = command("admit", context);
    assert.equal(admitted.status, 0, admitted.stderr);
    const head = context.GITHUB_WORKFLOW_SHA;
    const unrelated = command("admit", context, {
      ...metadata,
      [compare(head)]: { status: "diverged" },
    });
    assert.notEqual(unrelated.status, 0, unrelated.stdout);
  }
  assert.notEqual(command("admit", { GITHUB_REF_PROTECTED: "false" }).status, 0);
  assert.equal(command("admit", { IMAGES_ONLY: "true" }).status, 0);
  assert.match(
    command("admit", { IMAGES_ONLY: "true", PUBLISH: "false" }).stderr,
    /requires publish/,
  );
  assert.match(command("admit", { ...fresh, IMAGES_ONLY: "true" }).stderr, /cannot recover/);
  const rehearsal = command("record", { PUBLISH: "false" });
  assert.equal(rehearsal.status, 0, rehearsal.stderr);
  assert.match(command("verify", fresh).stderr, /rehearsal/i);
  const qualified = command("record");
  assert.equal(qualified.status, 0, qualified.stderr);
  const manifest = record(JSON.parse(await readFile(join(directory, "release.json"), "utf8")));
  assert.equal(manifest.source, sha);
  assert.equal(manifest.workflowSha, dispatchSha);
  assert.equal(manifest.suite, `all:${sha}:123:1`);
  assert.equal(Object.hasOwn(manifest, "ci"), false);
  assert.equal(Object.hasOwn(manifest, "ciAttempt"), false);
  const current = command("verify");
  assert.equal(current.status, 0, current.stderr);
  const resolved = command("verify", fresh);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.match(await readFile(join(directory, "output"), "utf8"), new RegExp(`cli_digest=${hex}`));
  for (const invalid of [{ IMAGE_TAG: "latest" }, { VERSION: "1.2.4" }]) {
    assert.notEqual(command("verify", { ...fresh, ...invalid }).status, 0);
  }
  await writeFile(
    join(directory, "release.json"),
    JSON.stringify({ ...manifest, workflowSha: recoverySha }),
  );
  assert.notEqual(
    command("verify", fresh).status,
    0,
    "Recovery must bind the original workflow commit.",
  );
  await writeFile(join(directory, "release.json"), JSON.stringify(manifest));
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
  assert.equal(Object.hasOwn(record(dispatch.inputs), "ci_run_id"), false);
  const publish = present(release.jobs.publish);
  assert.deepEqual(release.permissions, {});
  assert.deepEqual(publish.concurrency, {
    group: "enterprise-container-publish",
    "cancel-in-progress": false,
  });
  for (const [id, job] of Object.entries(release.jobs)) {
    if (id !== "publish" && id !== "publish-images") {
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

  const imagesOnly = present(release.jobs["publish-images"]);
  const override = { inputs: { publish: true, recovery_run_id: "", images_only: true } };
  assert.equal(record(record(dispatch.inputs).images_only).default, false);
  assert.deepEqual(imagesOnly.concurrency, publish.concurrency);
  assert.deepEqual(imagesOnly.needs, ["approval", "prepare"]);
  assert.deepEqual(imagesOnly.permissions, {
    contents: "read",
    actions: "read",
    packages: "write",
  });
  assert.equal(imagesOnly.environment, "container-publish");
  assert.equal(workflowCondition(imagesOnly.if, override), true);
  for (const changed of [{ publish: false }, { recovery_run_id: "123" }, { images_only: false }]) {
    assert.equal(
      workflowCondition(imagesOnly.if, { inputs: { ...override.inputs, ...changed } }),
      false,
    );
  }
  for (const id of ["qualify", "integration", "cli", "publish"]) {
    assert.equal(workflowCondition(present(release.jobs[id]).if, override), false);
  }
  const preparation = record(present(release.jobs.prepare).with);
  assert.equal(preparation.assemble_images, true);
  assert.equal(workflowCondition(preparation.prepare_chart, override), false);
  assert.equal(
    workflowCondition(preparation.prepare_chart, { inputs: { images_only: false } }),
    true,
  );

  const integration = present(release.jobs.integration);
  assert.equal(integration.uses, "./.github/workflows/full-integration-execution.yml");
  assert.equal(record(integration.with).lane, "all");
  assert.equal(record(integration.with).source_sha, "${{ inputs.source_sha }}");
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
      const result = spawnSync("bash", ["--noprofile", "--norc", "-ec", text(gate.run)], {
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
