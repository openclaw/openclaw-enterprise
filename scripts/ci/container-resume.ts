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

function property<K extends PropertyKey>(value: unknown, key: K): unknown {
  return (value as Record<K, unknown>)[key];
}

function optionalProperty<K extends PropertyKey>(value: unknown, key: K): unknown {
  return value == null ? undefined : property(value, key);
}

const resumeWorkflow = ".github/workflows/container-resume.yml";
const images = ["controller", "runtime"];

// The consumer runs reviewed current code. The producer's identity and sealed
// archives remain bound to the original source, run and attempt.
async function verifyPreparation(env: NodeJS.ProcessEnv) {
  await verifyMainSource(env, resumeWorkflow);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    env.GITHUB_WORKFLOW_SHA,
  );
  const comparisonResponse: unknown = await github(
    `repos/${repository}/compare/${env.SOURCE_SHA}...${env.GITHUB_WORKFLOW_SHA}`,
  );
  const comparison = { status: property(comparisonResponse, "status") };
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
  const runResponse: unknown = await github(runPath);
  const workflow: unknown = await github(
    `repos/${repository}/actions/workflows/container-publish.yml`,
  );
  assert.equal(property(workflow, "path"), publishWorkflow);
  assert.equal(property(workflow, "state"), "active");
  assert.equal(property(runResponse, "workflow_id"), property(workflow, "id"));
  assert.equal(property(runResponse, "path"), publishWorkflow);
  assert.equal(String(property(runResponse, "id")), env.PREPARATION_RUN_ID);
  assert.equal(
    String(property(runResponse, "run_attempt")),
    env.PREPARATION_ATTEMPT,
    "Select the unchanged producer attempt.",
  );
  assert.equal(optionalProperty(property(runResponse, "repository"), "full_name"), repository);
  assert.equal(optionalProperty(property(runResponse, "head_repository"), "full_name"), repository);
  assert.equal(property(runResponse, "head_sha"), env.SOURCE_SHA);
  assert.equal(property(runResponse, "head_branch"), "main");
  assert.equal(property(runResponse, "event"), "workflow_dispatch");
  assert.equal(property(runResponse, "status"), "completed");
  const run = { conclusion: property(runResponse, "conclusion") as string };
  assert.ok(["failure", "cancelled", "success"].includes(run.conclusion));
  const jobs: unknown[] = await githubPages(
    `${runPath}/attempts/${env.PREPARATION_ATTEMPT}/jobs`,
    "jobs",
  );
  const legacyJobs: unknown[] = images.map((image) => `Prepare ${image} OCI image`);
  const nativeJobs: unknown[] = images.flatMap((image) => [
    `prepare / Prepare ${image} (amd64)`,
    `prepare / Prepare ${image} (arm64)`,
    `Assemble ${image} OCI image`,
  ]);
  nativeJobs.push("prepare / Smoke runtime (amd64)", "prepare / Smoke runtime (arm64)");
  const hasLegacyJobs = jobs.some((job) => legacyJobs.includes(property(job, "name")));
  if (hasLegacyJobs) {
    assert.ok(
      !jobs.some((job) => nativeJobs.includes(property(job, "name"))),
      "Preparation attempt mixes legacy and native jobs.",
    );
  }
  for (const name of ["validate", ...(hasLegacyJobs ? legacyJobs : nativeJobs)]) {
    const selected = jobs.filter((job) => property(job, "name") === name);
    assert.equal(selected.length, 1, `Exactly one successful ${name} job is required.`);
    assert.equal(property(selected[0], "head_sha"), env.SOURCE_SHA);
    assert.equal(property(selected[0], "status"), "completed");
    assert.equal(
      property(selected[0], "conclusion"),
      "success",
      `${name} job must have succeeded.`,
    );
  }
  const artifacts: unknown[] = await githubPages(`${runPath}/artifacts`, "artifacts");
  const selected = images.map((image) => {
    const name = `container-${image}-${env.PREPARATION_RUN_ID}-${env.PREPARATION_ATTEMPT}`;
    const matches = artifacts.filter((artifact) => property(artifact, "name") === name);
    assert.equal(matches.length, 1, `One retained artifact named ${name} is required.`);
    const artifactResponse = matches[0];
    assert.equal(property(artifactResponse, "expired"), false);
    assert.equal(
      String(optionalProperty(property(artifactResponse, "workflow_run"), "id")),
      env.PREPARATION_RUN_ID,
    );
    assert.equal(
      optionalProperty(property(artifactResponse, "workflow_run"), "head_sha"),
      env.SOURCE_SHA,
    );
    const artifact = { id: property(artifactResponse, "id") as number };
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
    const digest = (property(artifactResponse, "digest") ?? "") as string;
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    return { image, id: String(artifact.id), name, digest };
  });
  return { artifacts: selected, workflowCiAttempt };
}

async function resume(directory: string | undefined, env: NodeJS.ProcessEnv) {
  const preparation = await verifyPreparation(env);
  assert.equal(
    preparation.artifacts.map((artifact) => artifact.id).join(","),
    env.PREPARATION_ARTIFACT_IDS,
    "Downloaded artifacts must match the validated producer.",
  );
  const controller: unknown = JSON.parse(
    await readFile(
      join(
        directory as string,
        property(preparation.artifacts[0], "name") as string,
        "metadata.json",
      ),
      "utf8",
    ),
  );
  const ciRunId = (property(controller, "ciRunId") ?? "") as string;
  assert.match(ciRunId, /^[1-9][0-9]*$/);
  const ciAttempt = (property(controller, "ciAttempt") ?? "") as string;
  assert.match(ciAttempt, /^[1-9][0-9]*$/);
  assert.match(
    env.NODE_BASE_IMAGE ?? "",
    /^docker\.io\/library\/node:24[.-][a-z0-9.-]+@sha256:[a-f0-9]{64}$/,
  );
  const producer = {
    sourceSha: env.SOURCE_SHA,
    workflowSha: env.SOURCE_SHA,
    runId: env.PREPARATION_RUN_ID,
    attempt: env.PREPARATION_ATTEMPT,
    ciRunId,
    ciAttempt,
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
  const published: unknown[] = await publishPrepared(directory, env, producer, verify);
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
  await writeFile(
    join(directory as string, "publication.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  if (command === "validate") {
    const result = await verifyPreparation(process.env);
    await appendFile(
      process.env.GITHUB_OUTPUT as string,
      `artifact_ids=${result.artifacts.map((artifact) => artifact.id).join(",")}\nworkflow_ci_attempt=${result.workflowCiAttempt}\n`,
    );
  } else if (command === "publish") {
    await resume(directory, process.env);
  } else {
    throw new Error("Expected validate or publish.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error((error as { message: unknown }).message);
    process.exitCode = 1;
  });
}
