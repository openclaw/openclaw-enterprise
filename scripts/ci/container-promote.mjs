import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  github,
  githubPages,
  inspectDigest,
  publishWorkflow,
  repository,
  skopeo,
  validatePreparedImage,
  verifyCi,
  verifyEnvironment,
  verifyGhcr,
  verifyMainSource,
} from "./container-release.mjs";

const promoteWorkflow = ".github/workflows/container-promote.yml";

export function validatePublicationRun(run, workflow, env) {
  assert.match(env.PUBLICATION_RUN_ID ?? "", /^[1-9][0-9]*$/);
  assert.match(env.PUBLICATION_ATTEMPT ?? "", /^[1-9][0-9]*$/);
  assert.equal(String(run.id), env.PUBLICATION_RUN_ID);
  assert.equal(String(run.run_attempt), env.PUBLICATION_ATTEMPT);
  assert.equal(workflow.path, publishWorkflow);
  assert.equal(workflow.state, "active");
  assert.equal(run.workflow_id, workflow.id);
  assert.equal(run.path, publishWorkflow);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_branch, "main");
  assert.equal(run.head_sha, env.SOURCE_SHA);
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
}

export function validateReceipt(receipt, env) {
  assert.ok(Array.isArray(receipt));
  assert.deepEqual(
    receipt.map((image) => image.image),
    ["controller", "runtime"],
  );
  assert.match(receipt[0].ciRunId ?? "", /^[1-9][0-9]*$/);
  assert.match(receipt[0].ciAttempt ?? "", /^[1-9][0-9]*$/);
  assert.match(
    env.NODE_BASE_IMAGE ?? "",
    /^docker\.io\/library\/node:24[.-][a-z0-9.-]+@sha256:[a-f0-9]{64}$/,
  );
  for (const image of receipt) {
    validatePreparedImage(image, {
      sourceSha: env.SOURCE_SHA,
      workflowSha: env.SOURCE_SHA,
      runId: env.PUBLICATION_RUN_ID,
      attempt: env.PUBLICATION_ATTEMPT,
      ciRunId: receipt[0].ciRunId,
      ciAttempt: receipt[0].ciAttempt,
      nodeBaseImage: env.NODE_BASE_IMAGE,
      image: image.image,
    });
    assert.equal(image.tag, `sha-${env.SOURCE_SHA}`);
  }
  assert.notEqual(receipt[0].destination, receipt[1].destination);
}

export function hubRepositoryPath(image) {
  assert.match(
    image ?? "",
    /^docker\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    "Set an explicit Docker Hub namespace/repository without a tag or digest.",
  );
  const [, namespace, name] = image.split("/");
  return `/v2/namespaces/${namespace}/repositories/${name}`;
}

export function validateHubRepository(repo, image) {
  hubRepositoryPath(image);
  const [, namespace, name] = image.split("/");
  assert.equal(repo.namespace, namespace);
  assert.equal(repo.name, name);
  assert.equal(repo.is_private, true, "Docker Hub repository must already exist and be private.");
}

async function verifyProducer(env) {
  await verifyMainSource(env, promoteWorkflow);
  const comparison = await github(
    `repos/${repository}/compare/${env.SOURCE_SHA}...${env.GITHUB_WORKFLOW_SHA}`,
  );
  assert.ok(comparison.status === "ahead" || comparison.status === "identical");
  await verifyEnvironment();
  assert.match(env.PUBLICATION_RUN_ID ?? "", /^[1-9][0-9]*$/);
  const run = await github(`repos/${repository}/actions/runs/${env.PUBLICATION_RUN_ID}`);
  const workflow = await github(`repos/${repository}/actions/workflows/container-publish.yml`);
  validatePublicationRun(run, workflow, env);
  const artifacts = await githubPages(
    `repos/${repository}/actions/runs/${env.PUBLICATION_RUN_ID}/artifacts`,
    "artifacts",
  );
  const matches = artifacts.filter(
    (artifact) =>
      artifact.name ===
      `container-publication-${env.PUBLICATION_RUN_ID}-${env.PUBLICATION_ATTEMPT}`,
  );
  assert.equal(matches.length, 1, "The exact successful publication receipt is required.");
  const artifact = matches[0];
  assert.equal(artifact.expired, false);
  assert.equal(String(artifact.workflow_run?.id), env.PUBLICATION_RUN_ID);
  assert.equal(artifact.workflow_run?.head_sha, env.SOURCE_SHA);
  return String(artifact.id);
}

async function hub(path, token, options = {}, allowMissing = false) {
  const response = await fetch(`https://hub.docker.com${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (allowMissing && response.status === 404) {
    return undefined;
  }
  assert.equal(response.status, 200, `Docker Hub preflight failed (${response.status}).`);
  return response.json();
}

async function verifyHub(image, digest, tag, env) {
  const path = hubRepositoryPath(image);
  assert.ok(env.DOCKERHUB_USERNAME && env.DOCKERHUB_TOKEN, "Docker Hub credentials are required.");
  const auth = await hub("/v2/auth/token", undefined, {
    method: "POST",
    body: JSON.stringify({ identifier: env.DOCKERHUB_USERNAME, secret: env.DOCKERHUB_TOKEN }),
  });
  assert.ok(auth.access_token, "Docker Hub did not issue an access token.");
  validateHubRepository(await hub(path, auth.access_token), image);
  const existing = await hub(`${path}/tags/${tag}`, auth.access_token, {}, true);
  if (existing) {
    assert.equal(existing.digest, digest, "Refusing to overwrite a different digest.");
  }
  return existing !== undefined;
}

async function promote(path, env) {
  assert.equal(
    await verifyProducer(env),
    env.ARTIFACT_ID,
    "Publication artifact identity changed.",
  );
  const receipt = JSON.parse(await readFile(path, "utf8"));
  validateReceipt(receipt, env);
  const ci = { ...env, CI_RUN_ID: receipt[0].ciRunId, CI_ATTEMPT: receipt[0].ciAttempt };
  await verifyCi(ci);
  const targets = receipt.map((image) => ({
    ...image,
    hubImage: env[`DOCKERHUB_${image.image.toUpperCase()}_IMAGE`],
  }));
  assert.notEqual(
    targets[0].hubImage,
    targets[1].hubImage,
    "Use separate Docker Hub repositories.",
  );
  // Check both private destinations before transmitting either image.
  for (const image of targets) {
    await verifyGhcr(image.destination, image.digest, image.tag, env);
    await verifyHub(image.hubImage, image.digest, image.tag, env);
  }
  const authDirectory = await mkdtemp(join(tmpdir(), "enterprise-promotion-"));
  const authfile = join(authDirectory, "auth.json");
  try {
    for (const [registry, username, token] of [
      ["ghcr.io", env.GITHUB_ACTOR, env.GH_TOKEN],
      ["docker.io", env.DOCKERHUB_USERNAME, env.DOCKERHUB_TOKEN],
    ]) {
      skopeo(
        ["login", "--authfile", authfile, "--username", username, "--password-stdin", registry],
        {
          input: token,
          stdio: ["pipe", "ignore", "pipe"],
        },
      );
    }
    for (const image of targets) {
      assert.equal(await verifyProducer(env), env.ARTIFACT_ID);
      await verifyCi(ci);
      await verifyGhcr(image.destination, image.digest, image.tag, env);
      assert.equal(
        inspectDigest(`docker://${image.destination}:${image.tag}`, authfile),
        image.digest,
      );
      const exists = await verifyHub(image.hubImage, image.digest, image.tag, env);
      if (!exists) {
        skopeo(
          [
            "copy",
            "--all",
            "--preserve-digests",
            "--authfile",
            authfile,
            `docker://${image.destination}@${image.digest}`,
            `docker://${image.hubImage}:${image.tag}`,
          ],
          { stdio: "inherit" },
        );
      }
      assert.equal(
        inspectDigest(`docker://${image.hubImage}:${image.tag}`, authfile),
        image.digest,
      );
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `- ${image.image}: \`${image.hubImage}@${image.digest}\`\n`,
      );
    }
  } finally {
    await rm(authDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const [command, path] = process.argv.slice(2);
  if (command === "validate") {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `artifact_id=${await verifyProducer(process.env)}\n`,
    );
  } else if (command === "promote") {
    await promote(path, process.env);
  } else {
    throw new Error("Expected validate or promote.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
