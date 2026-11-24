import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  github,
  githubPages,
  publicationAlias,
  releaseWorkflow,
  repository,
  validate,
  verifyCi,
  verifyMainSource,
} from "./container-release/admission.ts";
import {
  digestPattern,
  field,
  integerPattern,
  match,
  shaPattern,
} from "./container-release/metadata.ts";

const api = `repos/${repository}/actions/runs`;
const hexDigest = /^[a-f0-9]{64}$/u;

export function validateProducer(run: unknown, jobs: unknown[], env: NodeJS.ProcessEnv) {
  match(env.RECOVERY_RUN_ID, integerPattern);
  assert.equal(String(field(run, "id")), env.RECOVERY_RUN_ID);
  assert.equal(field(run, "path"), releaseWorkflow);
  assert.equal(field(run, "event"), "workflow_dispatch");
  assert.equal(field(run, "head_branch"), "main");
  assert.equal(field(run, "head_sha"), env.SOURCE_SHA);
  for (const key of ["repository", "head_repository"]) {
    assert.equal(field(field(run, key), "full_name"), repository);
  }
  assert.equal(field(run, "run_attempt"), 1, "The original attempt must still be attempt 1.");
  assert.equal(field(run, "status"), "completed");
  assert.ok(
    ["failure", "cancelled"].includes(String(field(run, "conclusion"))),
    "Recovery requires a failed or cancelled original publish run.",
  );
  for (const name of [
    "Approve release",
    "Verify approval",
    "Full Integration / Full Integration Aggregate",
    "Record qualified release",
  ]) {
    const matches = jobs.filter((job) => field(job, "name") === name);
    assert.equal(matches.length, 1, `Missing or ambiguous original job: ${name}.`);
    assert.equal(field(matches[0], "head_sha"), env.SOURCE_SHA);
    assert.equal(field(matches[0], "status"), "completed");
    assert.equal(field(matches[0], "conclusion"), "success", `Original job did not pass: ${name}.`);
  }
}

export async function verifyProducer(env: NodeJS.ProcessEnv) {
  match(env.RECOVERY_RUN_ID, integerPattern);
  const path = `${api}/${env.RECOVERY_RUN_ID}`;
  const [run, jobs, definition] = await Promise.all([
    github(path),
    githubPages(`${path}/attempts/1/jobs`, "jobs"),
    github(`repos/${repository}/actions/workflows/release-oce.yml`),
  ]);
  assert.equal(field(definition, "path"), releaseWorkflow);
  assert.equal(field(definition, "state"), "active");
  assert.equal(field(run, "workflow_id"), field(definition, "id"));
  validateProducer(run, jobs, env);
}

async function admit(env: NodeJS.ProcessEnv) {
  assert.equal(env.GITHUB_REF_PROTECTED, "true", "Select protected main.");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1", "Start a new dispatch for approval.");
  publicationAlias(env.IMAGE_TAG);
  let attempt: string;
  if (env.RECOVERY_RUN_ID) {
    assert.equal(env.PUBLISH, "true", "Recovery requires explicit publication.");
    await verifyMainSource(env, releaseWorkflow);
    await verifyProducer(env);
    attempt = await verifyCi(env);
  } else {
    assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${releaseWorkflow}@refs/heads/main`);
    attempt = await validate(env);
  }
  await appendFile(env.GITHUB_OUTPUT!, `ci_attempt=${attempt}\n`);
}

export function validateQualification(env: NodeJS.ProcessEnv) {
  match(env.SOURCE_SHA, shaPattern);
  match(env.GITHUB_RUN_ID, integerPattern);
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  match(env.CI_RUN_ID, integerPattern);
  match(env.CI_ATTEMPT, integerPattern);
  assert.equal(
    env.FULL_SUITE,
    `all:${env.SOURCE_SHA}:${env.GITHUB_RUN_ID}:1`,
    "Missing successful Full Integration lane all for this release.",
  );
  match(env.VERSION, /^\d+\.\d+\.\d+$/u);
  assert.equal(env.IMAGE_VERSION, env.VERSION);
  assert.equal(env.CLI_VERSION, `v${env.VERSION}`);
  assert.equal(env.CLI_CI_ATTEMPT, env.CI_ATTEMPT);
  match(env.IMAGE_CONTROLLER, digestPattern);
  match(env.IMAGE_RUNTIME, digestPattern);
  match(env.CHART_SHA256, hexDigest);
  match(env.CLI_SHA256SUMS_DIGEST, hexDigest);
  assert.ok(env.PUBLISH === "true" || env.PUBLISH === "false");
  return {
    source: env.SOURCE_SHA,
    version: env.VERSION,
    producer: env.GITHUB_RUN_ID,
    attempt: "1",
    ci: env.CI_RUN_ID,
    ciAttempt: env.CI_ATTEMPT,
    alias: publicationAlias(env.IMAGE_TAG),
    publish: env.PUBLISH === "true",
    suite: env.FULL_SUITE,
    approver: env.GITHUB_ACTOR,
    controller: env.IMAGE_CONTROLLER,
    runtime: env.IMAGE_RUNTIME,
    chart: env.CHART_SHA256,
    cli: env.CLI_SHA256SUMS_DIGEST,
  };
}

async function inventory(producer: string) {
  const artifacts = await githubPages(`${api}/${producer}/artifacts`, "artifacts");
  return ["container-controller", "container-runtime", "release-chart", "occ-cli"].map((prefix) => {
    const name = `${prefix}-${producer}-1`;
    const matches = artifacts.filter((artifact) => field(artifact, "name") === name);
    assert.equal(matches.length, 1, `Expected one original artifact named ${name}.`);
    const artifact = matches[0];
    assert.equal(field(artifact, "expired"), false, `Original artifact expired: ${name}.`);
    const digest = field(artifact, "digest");
    match(digest, digestPattern);
    const id = field(artifact, "id");
    match(String(id), integerPattern);
    return { name, id, digest };
  });
}

async function record(directory: string, env: NodeJS.ProcessEnv) {
  const evidence = validateQualification(env);
  const artifacts = await inventory(evidence.producer);
  await writeFile(
    join(directory, "release.json"),
    JSON.stringify({ ...evidence, artifacts }, null, 2),
  );
  await appendFile(
    env.GITHUB_STEP_SUMMARY!,
    `Qualified ${evidence.version} from \`${evidence.source}\` in run ${evidence.producer}, attempt 1. CI ${evidence.ci}, attempt ${evidence.ciAttempt}.\n\n| Output | Digest |\n| --- | --- |\n| Controller | \`${evidence.controller}\` |\n| Runtime | \`${evidence.runtime}\` |\n| Helm archive | \`${evidence.chart}\` |\n| CLI SHA256SUMS | \`${evidence.cli}\` |\n\nSelected image alias: \`${evidence.alias}\`.\n`,
  );
}

async function verifyManifest(directory: string, env: NodeJS.ProcessEnv) {
  const producer = env.RECOVERY_RUN_ID || env.GITHUB_RUN_ID;
  match(producer, integerPattern);
  if (env.RECOVERY_RUN_ID) {
    await verifyProducer(env);
  }
  await verifyCi(env);
  const receipt: unknown = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
  assert.equal(field(receipt, "producer"), producer);
  assert.equal(field(receipt, "attempt"), "1");
  assert.equal(field(receipt, "publish"), true, "A rehearsal cannot authorize recovery.");
  assert.equal(field(receipt, "source"), env.SOURCE_SHA);
  assert.equal(field(receipt, "suite"), `all:${env.SOURCE_SHA}:${producer}:1`);
  assert.equal(field(receipt, "ci"), env.CI_RUN_ID);
  assert.equal(field(receipt, "ciAttempt"), env.CI_ATTEMPT);
  assert.equal(field(receipt, "version"), env.VERSION);
  assert.equal(field(receipt, "alias"), publicationAlias(env.IMAGE_TAG));
  assert.deepEqual(
    field(receipt, "artifacts"),
    await inventory(producer),
    "Original artifact inventory changed.",
  );
  const checksum = field(receipt, "cli");
  match(checksum, hexDigest);
  await appendFile(env.GITHUB_OUTPUT!, `cli_digest=${checksum}\n`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , operation, directory] = process.argv;
  switch (operation) {
    case "admit":
      await admit(process.env);
      break;
    case "record":
      await record(directory!, process.env);
      break;
    case "verify":
      await verifyManifest(directory!, process.env);
      break;
    default:
      throw new Error("Expected admit, record or verify.");
  }
}
