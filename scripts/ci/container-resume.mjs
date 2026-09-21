import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  github,
  githubPages,
  publishPrepared,
  publishWorkflow,
  repository,
  verifyCi,
  verifyEnvironment,
  verifyMainSource,
} from "./container-release.mjs";

const resumeWorkflow = ".github/workflows/container-resume.yml";
const images = ["controller", "runtime"];

// The consumer runs reviewed current code. The producer's identity and sealed
// archives remain bound to the original source, run and attempt.
async function verifyPreparation(env) {
  await verifyMainSource(env, resumeWorkflow);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    env.GITHUB_WORKFLOW_SHA,
  );
  const comparison = await github(
    `repos/${repository}/compare/${env.SOURCE_SHA}...${env.GITHUB_WORKFLOW_SHA}`,
  );
  assert.ok(comparison.status === "ahead" || comparison.status === "identical");
  await verifyEnvironment();
  const workflowCiAttempt = await verifyCi({
    ...env,
    SOURCE_SHA: env.GITHUB_WORKFLOW_SHA,
    CI_RUN_ID: env.WORKFLOW_CI_RUN_ID,
    CI_ATTEMPT: env.WORKFLOW_CI_ATTEMPT,
  });
  assert.match(env.PREPARATION_RUN_ID ?? "", /^[1-9][0-9]*$/);
  assert.match(env.PREPARATION_ATTEMPT ?? "", /^[1-9][0-9]*$/);
  const runPath = `repos/${repository}/actions/runs/${env.PREPARATION_RUN_ID}`;
  const run = await github(runPath);
  const workflow = await github(`repos/${repository}/actions/workflows/container-publish.yml`);
  assert.equal(workflow.path, publishWorkflow);
  assert.equal(workflow.state, "active");
  assert.equal(run.workflow_id, workflow.id);
  assert.equal(run.path, publishWorkflow);
  assert.equal(String(run.id), env.PREPARATION_RUN_ID);
  assert.equal(
    String(run.run_attempt),
    env.PREPARATION_ATTEMPT,
    "Select the unchanged producer attempt.",
  );
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_sha, env.SOURCE_SHA);
  assert.equal(run.head_branch, "main");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.status, "completed");
  assert.ok(["failure", "cancelled", "success"].includes(run.conclusion));
  const jobs = await githubPages(`${runPath}/attempts/${env.PREPARATION_ATTEMPT}/jobs`, "jobs");
  for (const name of ["validate", ...images.map((image) => `Prepare ${image} OCI image`)]) {
    const selected = jobs.filter((job) => job.name === name);
    assert.equal(selected.length, 1, `Exactly one successful ${name} job is required.`);
    assert.equal(selected[0].head_sha, env.SOURCE_SHA);
    assert.equal(selected[0].status, "completed");
    assert.equal(
      selected[0].conclusion,
      "success",
      "Both original smoke jobs must have succeeded.",
    );
  }
  const artifacts = await githubPages(`${runPath}/artifacts`, "artifacts");
  const selected = images.map((image) => {
    const name = `container-${image}-${env.PREPARATION_RUN_ID}-${env.PREPARATION_ATTEMPT}`;
    const matches = artifacts.filter((artifact) => artifact.name === name);
    assert.equal(matches.length, 1, `One retained artifact named ${name} is required.`);
    const artifact = matches[0];
    assert.equal(artifact.expired, false);
    assert.equal(String(artifact.workflow_run?.id), env.PREPARATION_RUN_ID);
    assert.equal(artifact.workflow_run?.head_sha, env.SOURCE_SHA);
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
    assert.match(artifact.digest ?? "", /^sha256:[a-f0-9]{64}$/);
    return { image, id: String(artifact.id), name, digest: artifact.digest };
  });
  return { artifacts: selected, workflowCiAttempt };
}

async function resume(directory, env) {
  const preparation = await verifyPreparation(env);
  assert.equal(
    preparation.artifacts.map((artifact) => artifact.id).join(","),
    env.PREPARATION_ARTIFACT_IDS,
    "Downloaded artifacts must match the validated producer.",
  );
  const controller = JSON.parse(
    await readFile(join(directory, preparation.artifacts[0].name, "metadata.json"), "utf8"),
  );
  assert.match(controller.ciRunId ?? "", /^[1-9][0-9]*$/);
  assert.match(controller.ciAttempt ?? "", /^[1-9][0-9]*$/);
  assert.match(
    env.NODE_BASE_IMAGE ?? "",
    /^docker\.io\/library\/node:24[.-][a-z0-9.-]+@sha256:[a-f0-9]{64}$/,
  );
  const producer = {
    sourceSha: env.SOURCE_SHA,
    workflowSha: env.SOURCE_SHA,
    runId: env.PREPARATION_RUN_ID,
    attempt: env.PREPARATION_ATTEMPT,
    ciRunId: controller.ciRunId,
    ciAttempt: controller.ciAttempt,
    nodeBaseImage: env.NODE_BASE_IMAGE,
  };
  const verify = async () => {
    assert.deepEqual(
      await verifyPreparation(env),
      preparation,
      "Preparation evidence changed during recovery.",
    );
    await verifyCi({ ...env, CI_RUN_ID: producer.ciRunId, CI_ATTEMPT: producer.ciAttempt });
  };
  const published = await publishPrepared(directory, env, producer, verify);
  const receipt = {
    schemaVersion: 1,
    preparation,
    publication: {
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
      ciRunId: env.WORKFLOW_CI_RUN_ID,
      ciAttempt: preparation.workflowCiAttempt,
    },
    images: published,
  };
  await writeFile(join(directory, "publication.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  if (command === "validate") {
    const result = await verifyPreparation(process.env);
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `artifact_ids=${result.artifacts.map((artifact) => artifact.id).join(",")}\nworkflow_ci_attempt=${result.workflowCiAttempt}\n`,
    );
  } else if (command === "publish") {
    await resume(directory, process.env);
  } else {
    throw new Error("Expected validate or publish.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
