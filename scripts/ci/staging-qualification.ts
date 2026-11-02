import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePublicationRun, validateReceipt } from "./container-promote.mjs";
import {
  github,
  githubPages,
  ghcrPackageName,
  repository,
  verifyCi,
  verifyMainSource,
} from "./container-release.mjs";
import { prepareRuntimeImageSmoke } from "./prepare.mjs";

const env = process.env;
const workflow = ".github/workflows/staging-qualification.yml";

async function producer() {
  assert.match(env.STAGING_INSTALLATION ?? "", /^[a-z][a-z0-9-]{0,62}$/);
  assert.equal(
    env.STAGING_INSTALLATION,
    env.CONFIGURED_STAGING_INSTALLATION,
    "Select the configured staging installation.",
  );
  await verifyMainSource(env, workflow);
  const comparison = await github(
    `repos/${repository}/compare/${env.SOURCE_SHA}...${env.GITHUB_WORKFLOW_SHA}`,
  );
  assert.ok(["ahead", "identical"].includes(comparison.status));
  assert.match(env.PUBLICATION_RUN_ID ?? "", /^[1-9][0-9]*$/);
  const run = await github(`repos/${repository}/actions/runs/${env.PUBLICATION_RUN_ID}`);
  const definition = await github(`repos/${repository}/actions/workflows/container-publish.yml`);
  validatePublicationRun(run, definition, env);
  const artifacts = await githubPages(
    `repos/${repository}/actions/runs/${env.PUBLICATION_RUN_ID}/artifacts`,
    "artifacts",
  );
  const matches = artifacts.filter(
    (artifact: { name: string }) =>
      artifact.name ===
      `container-publication-${env.PUBLICATION_RUN_ID}-${env.PUBLICATION_ATTEMPT}`,
  );
  assert.equal(matches.length, 1, "Require the exact publication artifact.");
  const artifact = matches[0];
  assert.equal(artifact.expired, false);
  assert.equal(String(artifact.workflow_run?.id), env.PUBLICATION_RUN_ID);
  assert.equal(artifact.workflow_run?.head_sha, env.SOURCE_SHA);
  assert.match(String(artifact.id), /^[1-9][0-9]*$/);
  return String(artifact.id);
}

async function qualify(path: string) {
  assert.equal(await producer(), env.ARTIFACT_ID, "Publication artifact identity changed.");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  validateReceipt(receipt, env);
  await verifyCi({ ...env, CI_RUN_ID: receipt[0].ciRunId, CI_ATTEMPT: receipt[0].ciAttempt });
  assert.ok(env.RUNNER_TEMP, "RUNNER_TEMP is required.");
  const selected: Record<string, string> = {};
  // Validate both destinations before pulling either. No receipt-selected registry or tag.
  for (const image of receipt) {
    const configured = env[`GHCR_${image.image.toUpperCase()}_IMAGE`];
    ghcrPackageName(configured);
    assert.equal(
      image.destination,
      configured,
      "Publication destination differs from configuration.",
    );
    selected[image.image] = `${configured}@${image.digest}`;
  }
  const ids: Record<string, string> = {};
  for (const [name, reference] of Object.entries(selected)) {
    execFileSync("docker", ["pull", "--platform", "linux/amd64", reference], { stdio: "inherit" });
    const [image] = JSON.parse(
      execFileSync("docker", ["image", "inspect", reference], { encoding: "utf8" }),
    );
    assert.ok(image.RepoDigests.includes(reference), "Pulled image digest differs from selection.");
    assert.equal(image.Os, "linux");
    assert.equal(image.Architecture, "amd64");
    assert.equal(image.Config.Labels["org.opencontainers.image.revision"], env.SOURCE_SHA);
    assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
    ids[name] = image.Id;
  }
  const state = join(env.RUNNER_TEMP, "staging-runtime-state.json");
  const prepared = await prepareRuntimeImageSmoke({ image: ids.runtime, statePath: state });
  try {
    for (const [lane, file] of [
      ["images-packaging", "production-image-startup"],
      ["images-runtime-startup", "runtime-image-startup"],
    ] as const) {
      execFileSync(
        process.execPath,
        [
          "scripts/ci/run-tests.mjs",
          "run",
          lane,
          "--file",
          `tests/integration/${file}.test.mjs`,
          "--state",
          state,
          "--results",
          join(env.RUNNER_TEMP, `staging-${lane}.json`),
        ],
        {
          stdio: "inherit",
          env: {
            ...env,
            ...prepared.env,
            OCC_TEST_PRODUCTION_IMAGE: ids.controller,
            OCC_TEST_RUNTIME_IMAGE: ids.runtime,
            OCC_TEST_CODEX_PROBE_IMAGE: env.NODE_BASE_IMAGE,
            EXPECTED_OCC_REVISION: env.SOURCE_SHA,
          },
        },
      );
    }
  } finally {
    await prepared.cleanup();
  }
  await writeFile(
    join(env.RUNNER_TEMP, "staging-qualification.json"),
    JSON.stringify(
      {
        qualification: "container-startup",
        installation: env.STAGING_INSTALLATION,
        sourceSha: env.SOURCE_SHA,
        workflowSha: env.GITHUB_WORKFLOW_SHA,
        publicationRunId: env.PUBLICATION_RUN_ID,
        publicationAttempt: env.PUBLICATION_ATTEMPT,
        artifactId: env.ARTIFACT_ID,
        selected,
        imageIds: ids,
        liveInstall: false,
      },
      null,
      2,
    ) + "\n",
  );
}

try {
  const [command, path] = process.argv.slice(2);
  if (command === "validate") {
    assert.ok(env.GITHUB_OUTPUT);
    await appendFile(env.GITHUB_OUTPUT, `artifact_id=${await producer()}\n`);
  } else {
    assert.equal(command, "qualify");
    assert.ok(path, "Publication receipt path is required.");
    await qualify(path);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging qualification failed.");
  process.exitCode = 1;
}
