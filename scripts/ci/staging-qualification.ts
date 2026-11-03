import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePublicationRun, validateReceipt } from "./container-promote.mjs";
import {
  github,
  githubPages,
  ghcrPackageName,
  repository,
  verifyCi,
  verifyMainSource,
} from "./container-release.mjs";
import { loadTestSuites } from "./test-suites.mjs";

const env = process.env;
const workflow = ".github/workflows/staging-qualification.yml";
const startupFiles = [
  ["images-packaging", "tests/integration/production-image-startup.test.mjs"],
  ["images-runtime-startup", "tests/integration/runtime-image-startup.test.mjs"],
] as const;

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

async function releaseSource() {
  assert.ok(env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE is required.");
  const root = await realpath(join(env.GITHUB_WORKSPACE, "release-source"));
  const [top, head] = execFileSync("git", ["rev-parse", "--show-toplevel", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  assert.equal(top, root, "The release source needs its own checkout.");
  assert.equal(head, env.SOURCE_SHA, "Release checkout differs from the verified source.");
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }),
    "",
    "Release checkout has tracked changes.",
  );
  return root;
}

async function releaseNodeBase(root: string) {
  try {
    // The credentialed step reads release inputs as data. Release scripts run in later steps.
    const prepare = await readFile(join(root, "scripts/ci/prepare.mjs"), "utf8");
    assert.match(prepare, /^export async function prepareRuntimeImageSmoke\(/m);
    await access(join(root, "scripts/ci/setup-tools.sh"));
    await access(join(root, "scripts/ci/cleanup.mjs"));
    for (const [lane, file] of startupFiles) {
      await access(join(root, file));
      execFileSync(process.execPath, [
        "scripts/ci/run-tests.mjs",
        "check-selection",
        lane,
        "--file",
        file,
        "--root",
        root,
      ]);
    }
    const suites = loadTestSuites(join(root, "scripts/ci/test-suites.json"));
    const nodeBase = suites.lanes["images-packaging"].prepare.defaultEnv.NODE_BASE_IMAGE;
    const recipe = await readFile(join(root, "deploy/runtime/Dockerfile"), "utf8");
    assert.ok(typeof nodeBase === "string");
    assert.equal(recipe.match(/^ARG NODE_BASE_IMAGE=(.+)$/m)?.[1], nodeBase);
    return nodeBase;
  } catch (error) {
    throw new Error(`Release ${env.SOURCE_SHA} does not support this startup verifier.`, {
      cause: error,
    });
  }
}

async function pull(path: string, directory: string) {
  assert.equal(await producer(), env.ARTIFACT_ID, "Publication artifact identity changed.");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  validateReceipt(receipt, { ...env, NODE_BASE_IMAGE: receipt?.[0]?.nodeBaseImage });
  await verifyCi({ ...env, CI_RUN_ID: receipt[0].ciRunId, CI_ATTEMPT: receipt[0].ciAttempt });
  const actor = env.GITHUB_ACTOR;
  const token = env.GH_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  assert.ok(actor, "GITHUB_ACTOR is required for GHCR package read access.");
  assert.ok(token, "GH_TOKEN is required for GHCR package read access.");
  const nodeBaseImage = await releaseNodeBase(await releaseSource());
  assert.equal(
    receipt[0].nodeBaseImage,
    nodeBaseImage,
    "Publication Node base differs from the release source.",
  );
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
  const dockerConfig = await mkdtemp(join(directory, "staging-docker-"));
  try {
    await writeFile(
      join(dockerConfig, "config.json"),
      JSON.stringify({
        auths: { "ghcr.io": { auth: Buffer.from(`${actor}:${token}`).toString("base64") } },
      }),
      { mode: 0o600 },
    );
    for (const reference of Object.values(selected)) {
      try {
        execFileSync(
          "docker",
          [
            "--config",
            dockerConfig,
            "--host=unix:///var/run/docker.sock",
            "pull",
            "--platform",
            "linux/amd64",
            reference,
          ],
          { stdio: "ignore" },
        );
      } catch {
        throw new Error(
          `Unable to pull ${reference}. Check GHCR package read access and image availability.`,
        );
      }
    }
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
  const ids: Record<string, string> = {};
  for (const [name, reference] of Object.entries(selected)) {
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
  await writeFile(
    join(directory, "staging-pulled-images.json"),
    JSON.stringify({
      qualification: "container-startup",
      installation: env.STAGING_INSTALLATION,
      sourceSha: env.SOURCE_SHA,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
      publicationRunId: env.PUBLICATION_RUN_ID,
      publicationAttempt: env.PUBLICATION_ATTEMPT,
      artifactId: env.ARTIFACT_ID,
      nodeBaseImage,
      selected,
      imageIds: ids,
      liveInstall: false,
    }),
    { flag: "wx", mode: 0o600 },
  );
}

async function smoke(directory: string) {
  assert.ok(!env.GH_TOKEN && !env.GITHUB_TOKEN, "Startup must run without the GitHub token.");
  const proof = JSON.parse(await readFile(join(directory, "staging-pulled-images.json"), "utf8"));
  assert.equal(proof.sourceSha, env.SOURCE_SHA);
  assert.equal(proof.workflowSha, env.GITHUB_WORKFLOW_SHA);
  const root = await releaseSource();
  const state = join(directory, "staging-runtime-state.json");
  const { prepareRuntimeImageSmoke } = await import(
    pathToFileURL(join(root, "scripts/ci/prepare.mjs")).href
  );
  const prepared = await prepareRuntimeImageSmoke({
    image: proof.imageIds.runtime,
    statePath: state,
  });
  try {
    for (const [lane, file] of startupFiles) {
      execFileSync(
        process.execPath,
        [
          "scripts/ci/run-tests.mjs",
          "run",
          lane,
          "--file",
          file,
          "--root",
          root,
          "--state",
          state,
          "--results",
          join(directory, `staging-${lane}.json`),
        ],
        {
          stdio: "inherit",
          env: {
            ...env,
            ...prepared.env,
            // The CI runner binds test evidence to the checkout it executes.
            GITHUB_SHA: proof.sourceSha,
            NODE_BASE_IMAGE: proof.nodeBaseImage,
            OCC_TEST_PRODUCTION_IMAGE: proof.imageIds.controller,
            OCC_TEST_RUNTIME_IMAGE: proof.imageIds.runtime,
            OCC_TEST_CODEX_PROBE_IMAGE: proof.nodeBaseImage,
            EXPECTED_OCC_REVISION: proof.sourceSha,
          },
        },
      );
    }
  } finally {
    await prepared.cleanup();
  }
  await writeFile(
    join(directory, "staging-qualification.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
}

try {
  const [command, path] = process.argv.slice(2);
  if (command === "validate") {
    assert.ok(env.GITHUB_OUTPUT);
    await appendFile(
      env.GITHUB_OUTPUT,
      `artifact_id=${await producer()}\nsource_sha=${env.SOURCE_SHA}\n`,
    );
  } else {
    assert.ok(env.RUNNER_TEMP, "RUNNER_TEMP is required.");
    if (command === "pull") {
      assert.ok(path, "Publication receipt path is required.");
      await pull(path, env.RUNNER_TEMP);
    } else {
      assert.equal(command, "smoke");
      await smoke(env.RUNNER_TEMP);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging qualification failed.");
  process.exitCode = 1;
}
