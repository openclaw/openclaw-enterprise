import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const repository = "openclaw/openclaw-enterprise";
export const publishWorkflow = ".github/workflows/container-publish.yml";
const images = ["controller", "runtime"];
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const integerPattern = /^[1-9][0-9]*$/;

export function validateContext(env, repo, workflow = publishWorkflow) {
  assert.equal(env.GITHUB_REPOSITORY, repository, "Only the Enterprise repository may publish.");
  assert.equal(repo.full_name, repository);
  assert.equal(repo.private, true, "Publication requires the private Enterprise repository.");
  assert.equal(repo.default_branch, "main");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Only manual dispatch is supported.");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Select the trusted main workflow.");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${workflow}@refs/heads/main`);
  assert.match(env.GITHUB_WORKFLOW_SHA ?? "", shaPattern);
  assert.equal(env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA);
  assert.match(env.SOURCE_SHA ?? "", shaPattern, "A full immutable source SHA is required.");
}

export function validateCi(run, workflow, jobs, sourceSha, runId, attempt) {
  assert.match(String(runId), integerPattern);
  assert.equal(String(run.id), String(runId));
  assert.equal(workflow.path, ".github/workflows/ci.yml");
  assert.equal(workflow.state, "active");
  assert.equal(run.workflow_id, workflow.id, "CI workflow identity must match, not just its name.");
  assert.equal(run.path, workflow.path);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_sha, sourceSha, "CI must have tested this exact source.");
  assert.equal(run.head_branch, "main");
  assert.equal(run.event, "push", "PR and arbitrary dispatch checks are not release evidence.");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success", "The entire CI run must succeed.");
  assert.match(String(run.run_attempt), integerPattern);
  if (attempt !== undefined) assert.equal(String(run.run_attempt), String(attempt));
  const required = jobs.filter((job) => job.name === "CI Required");
  assert.equal(required.length, 1, "Exactly one CI Required aggregate job is required.");
  assert.equal(required[0].conclusion, "success");
  assert.equal(required[0].status, "completed");
  assert.equal(required[0].head_sha, sourceSha);
}

export function validateEnvironment(environment, policies) {
  assert.equal(environment.name, "container-publish");
  assert.equal(environment.can_admins_bypass, false, "Disable administrator approval bypass.");
  const reviewers = environment.protection_rules?.find(
    (rule) => rule.type === "required_reviewers",
  );
  assert.ok(reviewers?.reviewers?.length > 0, "Configure required environment reviewers.");
  assert.equal(reviewers.prevent_self_review, true, "Disable self-approval for publication.");
  assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true);
  assert.equal(environment.deployment_branch_policy?.protected_branches, false);
  assert.deepEqual(
    policies.map(({ name, type }) => ({ name, type })),
    [{ name: "main", type: "branch" }],
    "The publishing environment must allow only the main branch, not tags.",
  );
}

export function ghcrPackageName(image) {
  assert.match(
    image ?? "",
    /^ghcr\.io\/openclaw\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/,
    "Set an explicit GHCR image in the openclaw organization, without a tag or digest.",
  );
  return image.slice("ghcr.io/openclaw/".length);
}

export function validatePackage(pkg, image) {
  assert.equal(pkg.name, ghcrPackageName(image));
  assert.equal(pkg.package_type, "container");
  assert.equal(pkg.visibility, "private", "GHCR package must already exist and be private.");
  assert.equal(pkg.repository?.full_name, repository, "Link the package to Enterprise first.");
  assert.equal(pkg.repository?.private, true);
}

export function validatePreparedImage(metadata, expected) {
  for (const key of [
    "sourceSha",
    "workflowSha",
    "runId",
    "attempt",
    "ciRunId",
    "ciAttempt",
    "nodeBaseImage",
    "image",
  ]) {
    assert.equal(metadata[key], expected[key], `Prepared image ${key} does not match this run.`);
  }
  assert.equal(metadata.platform, "linux/amd64");
  assert.match(metadata.digest ?? "", digestPattern);
  assert.match(metadata.archiveSha256 ?? "", /^[a-f0-9]{64}$/);
}

export async function github(path) {
  assert.ok(process.env.GH_TOKEN, "A GitHub workflow token is required.");
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `GitHub metadata preflight failed (${response.status}).`);
  return response.json();
}

export async function githubPages(path, field) {
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const data = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const entries = field ? data[field] : data;
    assert.ok(Array.isArray(entries), "Invalid GitHub pagination response.");
    result.push(...entries);
    if (entries.length < 100) return result;
  }
  throw new Error("GitHub metadata exceeded the bounded pagination limit.");
}

export async function verifyMainSource(env, workflow = publishWorkflow) {
  validateContext(env, await github(`repos/${repository}`), workflow);
  const comparison = await github(`repos/${repository}/compare/${env.SOURCE_SHA}...main`);
  assert.ok(
    comparison.status === "ahead" || comparison.status === "identical",
    "Source must remain in main history.",
  );
}

export async function verifyCi(env) {
  assert.match(env.CI_RUN_ID ?? "", integerPattern);
  const workflow = await github(`repos/${repository}/actions/workflows/ci.yml`);
  const run = await github(`repos/${repository}/actions/runs/${env.CI_RUN_ID}`);
  const jobs = await githubPages(
    `repos/${repository}/actions/runs/${env.CI_RUN_ID}/attempts/${run.run_attempt}/jobs`,
    "jobs",
  );
  validateCi(run, workflow, jobs, env.SOURCE_SHA, env.CI_RUN_ID, env.CI_ATTEMPT);
  return String(run.run_attempt);
}

export async function verifyEnvironment() {
  const path = `repos/${repository}/environments/container-publish`;
  validateEnvironment(
    await github(path),
    await githubPages(`${path}/deployment-branch-policies`, "branch_policies"),
  );
}

async function validate(env) {
  await verifyMainSource(env);
  assert.equal(
    env.SOURCE_SHA,
    env.GITHUB_WORKFLOW_SHA,
    "Source must equal this trusted main revision.",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    env.SOURCE_SHA,
  );
  const suites = JSON.parse(await readFile("scripts/ci/test-suites.json", "utf8"));
  const testedBase = suites.lanes["images-packaging"].prepare.defaultEnv.NODE_BASE_IMAGE;
  assert.match(env.NODE_BASE_IMAGE ?? "", /^node:24[.-][a-z0-9.-]+@sha256:[a-f0-9]{64}$/);
  assert.equal(env.NODE_BASE_IMAGE, testedBase, "Approve the same Node 24 digest used by CI.");
  const runtimeRecipe = await readFile("deploy/runtime/Dockerfile", "utf8");
  assert.equal(runtimeRecipe.match(/^ARG NODE_BASE_IMAGE=(.+)$/m)?.[1], testedBase);
  const attempt = await verifyCi(env);
  if (env.PUBLISH === "true") await verifyEnvironment();
  return attempt;
}

function identity(env, image) {
  assert.ok(images.includes(image));
  return {
    sourceSha: env.SOURCE_SHA,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    ciRunId: env.CI_RUN_ID,
    ciAttempt: env.CI_ATTEMPT,
    nodeBaseImage: env.NODE_BASE_IMAGE,
    image,
    platform: "linux/amd64",
  };
}

export async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function skopeo(args, options = {}) {
  return execFileSync("skopeo", args, { maxBuffer: 16 * 1024 * 1024, ...options });
}

export function inspectDigest(reference, authfile) {
  const bytes = skopeo([
    "inspect",
    ...(authfile ? ["--authfile", authfile] : []),
    "--raw",
    reference,
  ]);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function smoke(directory, env) {
  assert.ok(images.includes(env.IMAGE));
  const archive = join(directory, "image.tar");
  const archiveSha256 = await fileDigest(archive);
  assert.equal(inspectDigest(`oci-archive:${archive}`), env.IMAGE_DIGEST);
  const manifest = JSON.parse(skopeo(["inspect", "--raw", `oci-archive:${archive}`]));
  assert.match(manifest.config?.digest ?? "", digestPattern);
  const tag = `localhost/enterprise-${env.IMAGE}:prepared`;
  skopeo(["copy", `oci-archive:${archive}`, `docker-daemon:${tag}`], { stdio: "inherit" });
  const [loaded] = JSON.parse(execFileSync("docker", ["image", "inspect", tag]));
  // Docker may translate the manifest media type; the immutable config ID binds
  // the loaded image to the prepared config and its ordered filesystem diff IDs.
  assert.equal(loaded.Id, manifest.config.digest);
  assert.equal(loaded.Os, "linux");
  assert.equal(loaded.Architecture, "amd64");
  const controller = env.IMAGE === "controller";
  execFileSync(
    process.execPath,
    ["--test", `tests/integration/${controller ? "production" : "runtime"}-image-startup.test.mjs`],
    {
      env: {
        ...env,
        [controller ? "OCC_TEST_PRODUCTION_IMAGE" : "OCC_TEST_RUNTIME_IMAGE"]: loaded.Id,
      },
      stdio: "inherit",
    },
  );
  assert.equal(await fileDigest(archive), archiveSha256, "OCI archive changed during smoke.");
}

async function seal(directory, env) {
  assert.match(env.IMAGE_DIGEST ?? "", digestPattern);
  const metadata = {
    ...identity(env, env.IMAGE),
    digest: env.IMAGE_DIGEST,
    archiveSha256: await fileDigest(join(directory, "image.tar")),
  };
  await writeFile(join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function verifyGhcr(image, digest, tag) {
  const packagePath = `orgs/openclaw/packages/container/${encodeURIComponent(ghcrPackageName(image))}`;
  validatePackage(await github(packagePath), image);
  const versions = await githubPages(`${packagePath}/versions`);
  const existing = versions.filter((version) => version.metadata?.container?.tags?.includes(tag));
  assert.ok(
    existing.every((version) => version.name === digest),
    "Refusing to overwrite an existing source tag with different image bytes.",
  );
}

async function publish(directory, env) {
  await validate(env);
  const tag = `sha-${env.SOURCE_SHA}`;
  const prepared = [];
  for (const image of images) {
    const dir = join(
      directory,
      `container-${image}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    );
    const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8"));
    validatePreparedImage(metadata, identity(env, image));
    const archive = join(dir, "image.tar");
    assert.equal(await fileDigest(archive), metadata.archiveSha256, "OCI archive bytes changed.");
    assert.equal(inspectDigest(`oci-archive:${archive}`), metadata.digest, "OCI digest changed.");
    const destination = env[`GHCR_${image.toUpperCase()}_IMAGE`];
    await verifyGhcr(destination, metadata.digest, tag);
    prepared.push({ ...metadata, destination, archive });
  }
  assert.notEqual(
    prepared[0].destination,
    prepared[1].destination,
    "Images need separate packages.",
  );
  const authDirectory = await mkdtemp(join(tmpdir(), "enterprise-registry-"));
  const authfile = join(authDirectory, "auth.json");
  try {
    skopeo(
      [
        "login",
        "--authfile",
        authfile,
        "--username",
        env.GITHUB_ACTOR,
        "--password-stdin",
        "ghcr.io",
      ],
      { input: env.GH_TOKEN, stdio: ["pipe", "ignore", "pipe"] },
    );
    for (const image of prepared) {
      // Approval and visibility may change while large images are being copied.
      await validate(env);
      await verifyGhcr(image.destination, image.digest, tag);
      skopeo(
        [
          "copy",
          "--all",
          "--preserve-digests",
          "--authfile",
          authfile,
          `oci-archive:${image.archive}`,
          `docker://${image.destination}:${tag}`,
        ],
        { stdio: "inherit" },
      );
      assert.equal(inspectDigest(`docker://${image.destination}:${tag}`, authfile), image.digest);
    }
  } finally {
    await rm(authDirectory, { recursive: true, force: true });
  }
  const receipt = prepared.map(({ archive, ...image }) => ({ ...image, tag }));
  await writeFile(join(directory, "publication.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    receipt.map((image) => `- ${image.image}: \`${image.destination}@${image.digest}\`\n`).join(""),
  );
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  if (command === "validate") {
    const attempt = await validate(process.env);
    await appendFile(process.env.GITHUB_OUTPUT, `ci_attempt=${attempt}\n`);
  } else if (command === "smoke") {
    await smoke(directory, process.env);
  } else if (command === "seal") {
    await seal(directory, process.env);
  } else if (command === "publish") {
    assert.equal(process.env.PUBLISH, "true");
    await publish(directory, process.env);
  } else {
    throw new Error("Expected validate, smoke, seal, or publish.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
