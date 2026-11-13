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
  skopeoLogin,
  validatePreparedImage,
  verifyCi,
  verifyEnvironment,
  verifyGhcr,
  verifyMainSource,
} from "./container-release.mjs";

const promoteWorkflow = ".github/workflows/container-promote.yml";

type ReceiptImage = {
  image: string;
  ciRunId: string;
  ciAttempt: string;
  destination: unknown;
  platformDigests?: unknown;
  digest: string;
  tag: string;
};

function property<K extends PropertyKey>(value: unknown, key: K): unknown {
  return (value as { [P in K]: unknown })[key];
}

function optionalProperty<K extends PropertyKey>(value: unknown, key: K): unknown {
  return (value as { [P in K]: unknown } | null | undefined)?.[key];
}

export function validatePublicationRun(run: unknown, workflow: unknown, env: NodeJS.ProcessEnv) {
  assert.match(env.PUBLICATION_RUN_ID ?? "", /^[1-9][0-9]*$/);
  assert.match(env.PUBLICATION_ATTEMPT ?? "", /^[1-9][0-9]*$/);
  assert.equal(String(property(run, "id")), env.PUBLICATION_RUN_ID);
  assert.equal(String(property(run, "run_attempt")), env.PUBLICATION_ATTEMPT);
  assert.equal(property(workflow, "path"), publishWorkflow);
  assert.equal(property(workflow, "state"), "active");
  assert.equal(property(run, "workflow_id"), property(workflow, "id"));
  assert.equal(property(run, "path"), publishWorkflow);
  assert.equal(optionalProperty(property(run, "repository"), "full_name"), repository);
  assert.equal(optionalProperty(property(run, "head_repository"), "full_name"), repository);
  assert.equal(property(run, "head_branch"), "main");
  assert.equal(property(run, "head_sha"), env.SOURCE_SHA);
  assert.equal(property(run, "event"), "workflow_dispatch");
  assert.equal(property(run, "status"), "completed");
  assert.equal(property(run, "conclusion"), "success");
}

export function validateReceipt(
  receipt: unknown,
  env: NodeJS.ProcessEnv,
): asserts receipt is [ReceiptImage, ReceiptImage] {
  assert.ok(Array.isArray(receipt));
  const images: unknown[] = receipt;
  assert.deepEqual(
    images.map((image) => property(image, "image")),
    ["controller", "runtime"],
  );
  assert.match((property(images[0], "ciRunId") ?? "") as string, /^[1-9][0-9]*$/);
  assert.match((property(images[0], "ciAttempt") ?? "") as string, /^[1-9][0-9]*$/);
  assert.match(
    env.NODE_BASE_IMAGE ?? "",
    /^docker\.io\/library\/node:24[.-][a-z0-9.-]+@sha256:[a-f0-9]{64}$/,
  );
  for (const image of images) {
    validatePreparedImage(image, {
      sourceSha: env.SOURCE_SHA,
      workflowSha: env.SOURCE_SHA,
      runId: env.PUBLICATION_RUN_ID,
      attempt: env.PUBLICATION_ATTEMPT,
      ciRunId: property(images[0], "ciRunId"),
      ciAttempt: property(images[0], "ciAttempt"),
      nodeBaseImage: env.NODE_BASE_IMAGE,
      image: property(image, "image"),
    });
    assert.equal(property(image, "tag"), `sha-${env.SOURCE_SHA}`);
  }
  assert.notEqual(property(images[0], "destination"), property(images[1], "destination"));
}

export function hubRepositoryPath(image: string | undefined) {
  assert.match(
    image ?? "",
    /^docker\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    "Set an explicit Docker Hub namespace/repository without a tag or digest.",
  );
  const [, namespace, name] = (image as string).split("/");
  return `/v2/namespaces/${namespace}/repositories/${name}`;
}

export function validateHubRepository(repo: unknown, image: string | undefined) {
  hubRepositoryPath(image);
  const [, namespace, name] = (image as string).split("/");
  assert.equal(property(repo, "namespace"), namespace);
  assert.equal(property(repo, "name"), name);
  assert.equal(
    property(repo, "is_private"),
    true,
    "Docker Hub repository must already exist and be private.",
  );
}

async function verifyProducer(env: NodeJS.ProcessEnv) {
  await verifyMainSource(env, promoteWorkflow);
  const comparison: unknown = await github(
    `repos/${repository}/compare/${env.SOURCE_SHA}...${env.GITHUB_WORKFLOW_SHA}`,
  );
  assert.ok(
    property(comparison, "status") === "ahead" || property(comparison, "status") === "identical",
  );
  await verifyEnvironment();
  assert.match(env.PUBLICATION_RUN_ID ?? "", /^[1-9][0-9]*$/);
  const run: unknown = await github(`repos/${repository}/actions/runs/${env.PUBLICATION_RUN_ID}`);
  const workflow: unknown = await github(
    `repos/${repository}/actions/workflows/container-publish.yml`,
  );
  validatePublicationRun(run, workflow, env);
  const artifacts: unknown[] = await githubPages(
    `repos/${repository}/actions/runs/${env.PUBLICATION_RUN_ID}/artifacts`,
    "artifacts",
  );
  const matches = artifacts.filter(
    (artifact) =>
      property(artifact, "name") ===
      `container-publication-${env.PUBLICATION_RUN_ID}-${env.PUBLICATION_ATTEMPT}`,
  );
  assert.equal(matches.length, 1, "The exact successful publication receipt is required.");
  const artifact = matches[0];
  assert.equal(property(artifact, "expired"), false);
  assert.equal(
    String(optionalProperty(property(artifact, "workflow_run"), "id")),
    env.PUBLICATION_RUN_ID,
  );
  assert.equal(optionalProperty(property(artifact, "workflow_run"), "head_sha"), env.SOURCE_SHA);
  return String(property(artifact, "id"));
}

async function hub(
  path: string,
  token: unknown,
  options: RequestInit = {},
  allowMissing = false,
): Promise<unknown> {
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
  const body: Promise<unknown> = response.json();
  return body;
}

async function verifyHub(
  image: string | undefined,
  digest: string,
  tag: string,
  env: NodeJS.ProcessEnv,
) {
  const path = hubRepositoryPath(image);
  assert.ok(env.DOCKERHUB_USERNAME && env.DOCKERHUB_TOKEN, "Docker Hub credentials are required.");
  const auth = await hub("/v2/auth/token", undefined, {
    method: "POST",
    body: JSON.stringify({ identifier: env.DOCKERHUB_USERNAME, secret: env.DOCKERHUB_TOKEN }),
  });
  assert.ok(property(auth, "access_token"), "Docker Hub did not issue an access token.");
  validateHubRepository(await hub(path, property(auth, "access_token")), image);
  const existing = await hub(`${path}/tags/${tag}`, property(auth, "access_token"), {}, true);
  if (existing) {
    assert.equal(property(existing, "digest"), digest, "Refusing to overwrite a different digest.");
  }
  return existing !== undefined;
}

async function promote(path: string | undefined, env: NodeJS.ProcessEnv) {
  assert.equal(
    await verifyProducer(env),
    env.ARTIFACT_ID,
    "Publication artifact identity changed.",
  );
  const receipt: unknown = JSON.parse(await readFile(path as string, "utf8"));
  validateReceipt(receipt, env);
  const ci = { ...env, CI_RUN_ID: receipt[0].ciRunId, CI_ATTEMPT: receipt[0].ciAttempt };
  await verifyCi(ci);
  const targets = receipt.map((image) => ({
    ...image,
    hubImage: env[`DOCKERHUB_${image.image.toUpperCase()}_IMAGE`],
  }));
  assert.notEqual(
    property(targets[0], "hubImage"),
    property(targets[1], "hubImage"),
    "Use separate Docker Hub repositories.",
  );
  // Check both private destinations before transmitting either image.
  for (const image of targets) {
    await verifyGhcr(image.destination, image.digest, image.tag);
    await verifyHub(image.hubImage, image.digest, image.tag, env);
  }
  const authDirectory = await mkdtemp(join(tmpdir(), "enterprise-promotion-"));
  const authfile = join(authDirectory, "auth.json");
  try {
    skopeoLogin("ghcr.io", authfile, env.GITHUB_ACTOR, env.GH_TOKEN);
    skopeoLogin("docker.io", authfile, env.DOCKERHUB_USERNAME, env.DOCKERHUB_TOKEN);
    for (const image of targets) {
      assert.equal(await verifyProducer(env), env.ARTIFACT_ID);
      await verifyCi(ci);
      await verifyGhcr(image.destination, image.digest, image.tag);
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
        env.GITHUB_STEP_SUMMARY as string,
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
      process.env.GITHUB_OUTPUT as string,
      `artifact_id=${await verifyProducer(process.env)}\n`,
    );
  } else if (command === "promote") {
    await promote(path, process.env);
  } else {
    throw new Error("Expected validate or promote.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error((error as { message: unknown }).message);
    process.exitCode = 1;
  });
}
