import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePublicationRun, validateReceipt } from "./container-promote.mjs";
import {
  github,
  githubPages,
  ghcrPackageName,
  repository,
  validateCi,
  validateContext,
} from "./container-release.mjs";
import { loadTestSuites } from "./test-suites.mjs";

const env = process.env;
// Staging communicates through receipt files, never Actions command files.
delete env.GITHUB_OUTPUT;
const workflow = ".github/workflows/staging-qualification.yml";
const startupFiles = [
  ["images-packaging", "tests/integration/production-image-startup.test.mjs"],
  ["images-runtime-startup", "tests/integration/runtime-image-startup.test.mjs"],
] as const;

function decimal(value: unknown): string {
  assert.ok(typeof value === "string" && /^[1-9][0-9]*$/.test(value));
  const id = Number(value);
  assert.ok(Number.isSafeInteger(id), "Require a positive safe decimal ID.");
  const canonical = id.toString(10);
  assert.equal(canonical, value, "Require a canonical decimal ID.");
  return canonical;
}

function subprocessEnv() {
  const clean = { ...env };
  delete clean.GH_TOKEN;
  delete clean.GITHUB_TOKEN;
  delete clean.GITHUB_OUTPUT;
  return clean;
}

function git(
  root: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return execFileSync("git", args, {
    cwd: root,
    env: { ...subprocessEnv(), ...options.env },
    input: options.input,
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    timeout: 30_000,
  });
}

function requireMainCommit(root: string, sha: string) {
  const objectType = () =>
    git(root, ["cat-file", "--batch-check=%(objecttype)"], {
      input: `${sha}\n`,
      env: { GIT_NO_LAZY_FETCH: "1" },
    }).trim();
  let type = objectType();
  if (type === `${sha} missing`) {
    // Main may advance after checkout. Fetch its observed commit and ancestry
    // without moving a ref or bringing in trees or blobs.
    const officialOrigin = `https://github.com/${repository}.git`;
    assert.equal(
      git(root, ["ls-remote", "--get-url", officialOrigin]).trim(),
      officialOrigin,
      "Git must use the official repository URL.",
    );
    git(
      root,
      [
        // Set both for this command so Git does not persist a promisor remote.
        "-c",
        `remote.${officialOrigin}.promisor=true`,
        "-c",
        `remote.${officialOrigin}.partialclonefilter=tree:0`,
        "-c",
        "credential.helper=",
        "-c",
        "http.extraHeader=",
        "-c",
        "http.followRedirects=false",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--refmap=",
        "--filter=tree:0",
        officialOrigin,
        sha,
      ],
      { env: { GIT_TERMINAL_PROMPT: "0" } },
    );
    type = objectType();
  }
  assert.equal(type, "commit", "The observed main SHA must identify a commit.");
}

async function trustedSource() {
  assert.match(env.SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.SOURCE_SHA?.length, 40);
  assert.match(env.GITHUB_WORKFLOW_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_WORKFLOW_SHA?.length, 40);
  assert.ok(env.GITHUB_WORKSPACE);
  const root = await realpath(env.GITHUB_WORKSPACE);
  assert.equal(await realpath(process.cwd()), root);
  assert.equal(git(root, ["rev-parse", "--show-toplevel"]).trim(), root);
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), env.GITHUB_WORKFLOW_SHA);
  assert.equal(
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
    "",
    "Trusted checkout has tracked changes.",
  );
  git(root, ["merge-base", "--is-ancestor", env.GITHUB_WORKFLOW_SHA!, "refs/remotes/origin/main"]);
  git(root, ["merge-base", "--is-ancestor", env.SOURCE_SHA!, env.GITHUB_WORKFLOW_SHA!]);
  return root;
}

async function releaseProfile(root: string) {
  // Historical objects are data only. Never check out or import release code.
  const entry = git(root, ["ls-tree", env.SOURCE_SHA!, "--", "deploy/runtime/Dockerfile"]);
  const match = /^100644 blob ([a-f0-9]{40})\tdeploy\/runtime\/Dockerfile\n$/.exec(entry);
  const blob = match?.[1];
  assert.ok(blob && match?.[0] === entry, "Require one ordinary runtime Dockerfile blob.");
  assert.equal(git(root, ["cat-file", "-t", blob]), "blob\n");
  const size = Number(decimal(git(root, ["cat-file", "-s", blob]).trim()));
  assert.ok(size <= 64 * 1024, "Runtime recipe exceeds 64 KiB.");
  const recipe = git(root, ["cat-file", "blob", blob]);
  assert.equal(Buffer.byteLength(recipe), size);
  const field = (name: string) => {
    const values = [...recipe.matchAll(new RegExp(`^(?:ARG|ENV) ${name}=(.*)$`, "gm"))];
    const value = values[0]?.[1];
    assert.ok(values.length === 1 && value, `Require one literal ${name}.`);
    return value;
  };
  const nodeBaseImage = field("NODE_BASE_IMAGE");
  const codexVersion = field("OPENAI_CODEX_VERSION");
  assert.match(nodeBaseImage, /^docker\.io\/library\/node:24[.-][a-z0-9.-]+@sha256:[a-f0-9]{64}$/);
  const hash = createHash("sha256").update(recipe).digest("hex");
  if (codexVersion === "0.163.0-alpha.2") {
    assert.equal(env.SOURCE_SHA, "54bfa7fc1b99e362450beb5f9211e164991fa7b4");
    assert.equal(hash, "12d579bc223c90d7b3392651b986ed0ac33b5f7e1954bc2344a38190a2f9a8b5");
  } else {
    assert.equal(codexVersion, "0.164.0", "Unsupported release profile; refuse before pull.");
    assert.equal(
      recipe,
      await readFile(join(root, "deploy/runtime/Dockerfile"), "utf8"),
      "Unreviewed historical runtime recipe.",
    );
  }
  const suites = loadTestSuites(join(root, "scripts/ci/test-suites.json"));
  assert.equal(nodeBaseImage, suites.lanes["images-packaging"].prepare.defaultEnv.NODE_BASE_IMAGE);
  return { nodeBaseImage, codexVersion };
}

async function producer() {
  decimal(env.PUBLICATION_RUN_ID);
  decimal(env.PUBLICATION_ATTEMPT);
  const root = await trustedSource();
  assert.match(env.STAGING_INSTALLATION ?? "", /^[a-z][a-z0-9-]{0,62}$/);
  assert.equal(
    env.STAGING_INSTALLATION,
    env.CONFIGURED_STAGING_INSTALLATION,
    "Select the configured staging installation.",
  );
  validateContext(env, await github(`repos/${repository}`), workflow);
  const main = await github(`repos/${repository}/branches/main`);
  assert.equal(main.name, "main");
  assert.equal(main.protected, true, "Main must be protected.");
  assert.match(main.commit?.sha ?? "", /^[a-f0-9]{40}$/);
  assert.equal(main.commit.sha.length, 40);
  requireMainCommit(root, main.commit.sha);
  git(root, ["merge-base", "--is-ancestor", env.GITHUB_WORKFLOW_SHA!, main.commit.sha]);
  const profile = await releaseProfile(root);
  const run = await github(`repos/${repository}/actions/runs/${env.PUBLICATION_RUN_ID}`);
  const definition = await github(`repos/${repository}/actions/workflows/container-publish.yml`);
  validatePublicationRun(run, definition, env);
  const jobs = await githubPages(
    `repos/${repository}/actions/runs/${env.PUBLICATION_RUN_ID}/attempts/${env.PUBLICATION_ATTEMPT}/jobs`,
    "jobs",
  );
  const publish = jobs.filter(
    (job: { name: string }) => job.name === "Publish exact OCI digests to public GHCR",
  );
  assert.equal(publish.length, 1, "Require the exact image publication job.");
  assert.equal(publish[0].head_sha, env.SOURCE_SHA);
  assert.equal(publish[0].status, "completed");
  assert.equal(publish[0].conclusion, "success", "The image publication job must succeed.");
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
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0, "Require a numeric artifact ID.");
  const artifactId = Number(artifact.id).toString(10);
  assert.match(artifact.digest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 1024 * 1024,
    "Publication archive exceeds 1 MiB.",
  );
  return {
    artifact: { digest: artifact.digest, size_in_bytes: artifact.size_in_bytes },
    artifactId,
    profile,
  };
}

async function publicationReceipt(
  directory: string,
  artifact: { digest: string; size_in_bytes: number },
) {
  assert.ok((await lstat(directory)).isDirectory());
  const entries = await readdir(directory);
  const [name] = entries;
  assert.ok(entries.length === 1 && name, "Require exactly one publication archive.");
  assert.match(name, /^[a-zA-Z0-9._-]{1,128}$/, "Require a plain publication archive name.");
  const path = join(directory, name);
  const stat = await lstat(path);
  assert.ok(stat.isFile(), "Publication archive must be a regular file.");
  assert.equal(stat.size, artifact.size_in_bytes);
  assert.equal(
    `sha256:${createHash("sha256")
      .update(await readFile(path))
      .digest("hex")}`,
    artifact.digest,
    "Publication archive digest mismatch.",
  );
  const options = {
    env: subprocessEnv(),
    encoding: "utf8" as const,
    maxBuffer: 64 * 1024,
    timeout: 10_000,
  };
  assert.equal(
    execFileSync("unzip", ["-Z1", path], options),
    "publication.json\n",
    "Publication archive must contain only publication.json.",
  );
  return JSON.parse(execFileSync("unzip", ["-p", path, "publication.json"], options));
}

async function receiptCi({ ciRunId, ciAttempt }: { ciRunId: string; ciAttempt: string }) {
  // The receipt can match service identities, but cannot select an API path.
  const runs = await githubPages(
    `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&head_sha=${env.SOURCE_SHA}`,
    "workflow_runs",
  );
  const matches = runs.filter(
    (run: { id: number; run_attempt: number }) =>
      String(run.id) === ciRunId && String(run.run_attempt) === ciAttempt,
  );
  assert.equal(matches.length, 1, "Receipt CI identity is not bound to a service run.");
  const candidate = matches[0];
  const id = decimal(String(candidate.id));
  const attempt = decimal(String(candidate.run_attempt));
  const definition = await github(`repos/${repository}/actions/workflows/ci.yml`);
  assert.equal(candidate.repository?.full_name, repository);
  assert.equal(candidate.head_repository?.full_name, repository);
  assert.equal(candidate.head_branch, "main");
  assert.equal(candidate.head_sha, env.SOURCE_SHA);
  assert.equal(candidate.event, "push");
  assert.equal(candidate.status, "completed");
  assert.equal(candidate.conclusion, "success");
  assert.equal(candidate.workflow_id, definition.id);
  assert.equal(candidate.path, ".github/workflows/ci.yml");
  const run = await github(`repos/${repository}/actions/runs/${id}`);
  const jobs = await githubPages(
    `repos/${repository}/actions/runs/${id}/attempts/${attempt}/jobs`,
    "jobs",
  );
  validateCi(run, definition, jobs, env.SOURCE_SHA, id, attempt);
}

async function pull(path: string, directory: string) {
  const { artifact, artifactId, profile } = await producer();
  const receipt = await publicationReceipt(path, artifact);
  validateReceipt(receipt, { ...env, NODE_BASE_IMAGE: profile.nodeBaseImage });
  await receiptCi(receipt[0]);
  const actor = env.GITHUB_ACTOR;
  const token = env.GH_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  assert.ok(actor, "GITHUB_ACTOR is required for GHCR package read access.");
  assert.ok(token, "GH_TOKEN is required for GHCR package read access.");
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
      artifactId,
      ...profile,
      selected,
      imageIds: ids,
      liveInstall: false,
    }),
    { flag: "wx", mode: 0o600 },
  );
}

async function smoke(directory: string) {
  assert.ok(!env.GH_TOKEN && !env.GITHUB_TOKEN, "Startup must run without the GitHub token.");
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const proof = JSON.parse(await readFile(join(directory, "staging-pulled-images.json"), "utf8"));
  assert.equal(proof.sourceSha, env.SOURCE_SHA);
  assert.equal(proof.workflowSha, env.GITHUB_WORKFLOW_SHA);
  const root = await trustedSource();
  const profile = await releaseProfile(root);
  assert.equal(proof.codexVersion, profile.codexVersion);
  assert.equal(proof.nodeBaseImage, profile.nodeBaseImage);
  for (const id of Object.values(proof.imageIds)) {
    assert.match(String(id), /^sha256:[a-f0-9]{64}$/);
    const [image] = JSON.parse(
      execFileSync("docker", ["image", "inspect", String(id)], {
        encoding: "utf8",
        env: subprocessEnv(),
      }),
    );
    assert.equal(image.Id, id);
    assert.equal(image.Config.Labels["org.opencontainers.image.revision"], env.SOURCE_SHA);
  }
  const state = join(directory, "staging-runtime-state.json");
  const { prepareRuntimeImageSmoke } = await import(
    pathToFileURL(join(root, "scripts/ci/prepare.mjs")).href
  );
  const prepared = await prepareRuntimeImageSmoke({
    image: proof.imageIds.runtime,
    statePath: state,
    codexVersion: profile.codexVersion,
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
          cwd: root,
          stdio: "inherit",
          env: {
            ...env,
            ...prepared.env,
            // The CI runner binds test evidence to the checkout it executes.
            GITHUB_SHA: env.GITHUB_WORKFLOW_SHA,
            OCC_TEST_STAGING_CODEX_VERSION: profile.codexVersion,
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
    await producer();
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
