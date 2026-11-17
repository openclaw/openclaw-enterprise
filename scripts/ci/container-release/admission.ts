import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { loadTestSuites } from "../test-suites.ts";
import { integerPattern, shaPattern, field, match } from "./metadata.ts";

export const repository = "openclaw/openclaw-enterprise";
export const publishWorkflow = ".github/workflows/container-publish.yml";
const releaseVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export function isReleaseVersion(version: string) {
  return releaseVersionPattern.test(version);
}
export function validateContext(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  repo: unknown,
  workflow = publishWorkflow,
) {
  assert.equal(env.GITHUB_REPOSITORY, repository, "Only the Enterprise repository may publish.");
  assert.equal(field(repo, "full_name"), repository);
  assert.equal(typeof field(repo, "private"), "boolean", "Repository privacy must be a boolean.");
  if (workflow !== publishWorkflow || env.PUBLISH !== "false") {
    assert.equal(
      field(repo, "private"),
      false,
      "Publication requires the public Enterprise repository.",
    );
  }
  assert.equal(field(repo, "default_branch"), "main");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Only manual dispatch is supported.");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Select the trusted main workflow.");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${workflow}@refs/heads/main`);
  match(env.GITHUB_WORKFLOW_SHA ?? "", shaPattern);
  assert.equal(env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA);
  match(env.SOURCE_SHA ?? "", shaPattern, "A full immutable source SHA is required.");
}

export function validateCi(
  run: unknown,
  workflow: unknown,
  jobs: readonly unknown[],
  sourceSha: string | undefined,
  runId: string | number | undefined,
  attempt?: string | number,
) {
  assert.match(String(runId), integerPattern);
  assert.equal(String(field(run, "id")), String(runId));
  assert.equal(field(workflow, "path"), ".github/workflows/ci.yml");
  assert.equal(field(workflow, "state"), "active");
  assert.equal(
    field(run, "workflow_id"),
    field(workflow, "id"),
    "CI workflow identity must match, not just its name.",
  );
  assert.equal(field(run, "path"), field(workflow, "path"));
  assert.equal(field(field(run, "repository"), "full_name"), repository);
  assert.equal(field(field(run, "head_repository"), "full_name"), repository);
  assert.equal(field(run, "head_sha"), sourceSha, "CI must have tested this exact source.");
  assert.equal(field(run, "head_branch"), "main");
  assert.equal(
    field(run, "event"),
    "push",
    "PR and arbitrary dispatch checks are not release evidence.",
  );
  assert.equal(field(run, "status"), "completed");
  assert.equal(field(run, "conclusion"), "success", "The entire CI run must succeed.");
  assert.match(String(field(run, "run_attempt")), integerPattern);
  if (attempt !== undefined) {
    assert.equal(String(field(run, "run_attempt")), String(attempt));
  }
  const required = jobs.filter((job) => {
    assert.ok(job != null);
    return field(job, "name") === "CI Required";
  });
  assert.equal(required.length, 1, "Exactly one CI Required aggregate job is required.");
  assert.equal(field(required[0], "conclusion"), "success");
  assert.equal(field(required[0], "status"), "completed");
  assert.equal(field(required[0], "head_sha"), sourceSha);
}

export function validateEnvironment(environment: unknown, policies: readonly unknown[]) {
  assert.equal(field(environment, "name"), "container-publish");
  assert.equal(
    field(environment, "can_admins_bypass"),
    false,
    "Disable administrator environment bypass.",
  );
  assert.equal(
    field(field(environment, "deployment_branch_policy"), "custom_branch_policies"),
    true,
  );
  assert.equal(field(field(environment, "deployment_branch_policy"), "protected_branches"), false);
  assert.deepEqual(
    policies.map((policy) => {
      assert.ok(policy != null);
      return { name: field(policy, "name"), type: field(policy, "type") };
    }),
    [{ name: "main", type: "branch" }],
    "The publishing environment must allow only the main branch, not tags.",
  );
}

export function ghcrPackageName(image: unknown) {
  const reference = image ?? "";
  match(
    reference,
    /^ghcr\.io\/openclaw\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/,
    "Set an explicit GHCR image in the openclaw organization, without a tag or digest.",
  );
  return reference.slice("ghcr.io/openclaw/".length);
}

export function validatePackage(
  pkg: unknown,
  image: unknown,
  { allowMissingRepository = false, allowPrivateBootstrap = false } = {},
) {
  assert.equal(field(pkg, "name"), ghcrPackageName(image));
  assert.equal(field(pkg, "package_type"), "container");
  // GHCR creates marker packages privately; only bootstrap may accept that state.
  const visibility = field(pkg, "visibility");
  assert.ok(
    visibility === "public" || (allowPrivateBootstrap && visibility === "private"),
    "GHCR package must already exist and be public.",
  );
  // GitHub's package schema makes repository nullable and optional. Absence
  // cannot establish linkage; callers may accept the setup-time package grant.
  // Explicit conflicting metadata always fails.
  const linkedRepository = field(pkg, "repository");
  if (linkedRepository == null && allowMissingRepository) {
    return false;
  }
  assert.equal(
    field(linkedRepository, "full_name"),
    repository,
    "Link the package to Enterprise first.",
  );
  assert.equal(field(linkedRepository, "private"), false);
  return true;
}

export async function github(
  path: string,
  { allowNotFound = false, retryNotFound = false } = {},
): Promise<unknown> {
  assert.ok(process.env.GH_TOKEN, "A GitHub workflow token is required.");
  const attempts = retryNotFound ? 6 : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    let body: string | undefined;
    try {
      response = await fetch(`https://api.github.com/${path}`, {
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      // Reading the body can fail after headers arrive. Retry only this GET's
      // transport, never HTTP authorization errors or invalid JSON metadata.
      if (response.status === 200) {
        body = await response.text();
      }
    } catch {
      if (attempt === attempts) {
        throw new Error(`GitHub GET ${path} transport failed after ${attempts} attempts.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    if (response.status === 404 && retryNotFound && attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    if (allowNotFound && response.status === 404) {
      return null;
    }
    assert.equal(
      response.status,
      200,
      `GitHub GET ${path} metadata preflight failed (${response.status}).`,
    );
    assert.ok(body !== undefined);
    const data: unknown = JSON.parse(body);
    return data;
  }
}

export async function githubPages(path: string, key?: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const data = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const entries = key ? field(data, key) : data;
    assert.ok(Array.isArray(entries), "Invalid GitHub pagination response.");
    result.push(...entries);
    if (entries.length < 100) {
      return result;
    }
  }
  throw new Error("GitHub metadata exceeded the bounded pagination limit.");
}

export async function verifyMainSource(env: NodeJS.ProcessEnv, workflow = publishWorkflow) {
  validateContext(env, await github(`repos/${repository}`), workflow);
  const comparison = await github(`repos/${repository}/compare/${env.SOURCE_SHA}...main`);
  const status = field(comparison, "status");
  assert.ok(status === "ahead" || status === "identical", "Source must remain in main history.");
}

export async function verifyCi(env: NodeJS.ProcessEnv) {
  assert.match(env.CI_RUN_ID ?? "", integerPattern);
  const workflow = await github(`repos/${repository}/actions/workflows/ci.yml`);
  const run = await github(`repos/${repository}/actions/runs/${env.CI_RUN_ID}`);
  const jobs = await githubPages(
    `repos/${repository}/actions/runs/${env.CI_RUN_ID}/attempts/${field(run, "run_attempt")}/jobs`,
    "jobs",
  );
  validateCi(run, workflow, jobs, env.SOURCE_SHA, env.CI_RUN_ID, env.CI_ATTEMPT);
  return String(field(run, "run_attempt"));
}

export async function verifyEnvironment() {
  const path = `repos/${repository}/environments/container-publish`;
  validateEnvironment(
    await github(path),
    await githubPages(`${path}/deployment-branch-policies`, "branch_policies"),
  );
}

export function publicationAlias(value: string | undefined) {
  const tag = value || "latest";
  assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, "Invalid image tag.");
  assert.ok(!/^(?:sha|bootstrap)-/i.test(tag), "Source and bootstrap tags are reserved.");
  assert.ok(!isReleaseVersion(tag), "Release version tags are reserved.");
  return tag;
}

export async function validate(env: NodeJS.ProcessEnv) {
  publicationAlias(env.IMAGE_TAG);
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
  const suites = loadTestSuites("scripts/ci/test-suites.json");
  const packaging = field(field(suites, "lanes"), "images-packaging");
  const testedBase = field(field(field(packaging, "prepare"), "defaultEnv"), "NODE_BASE_IMAGE");
  assert.match(
    env.NODE_BASE_IMAGE ?? "",
    /^docker\.io\/library\/node:24[.-][a-z0-9.-]+@sha256:[a-f0-9]{64}$/,
  );
  assert.equal(env.NODE_BASE_IMAGE, testedBase, "Approve the same Node 24 digest used by CI.");
  const runtimeRecipe = await readFile("deploy/runtime/Dockerfile", "utf8");
  assert.equal(runtimeRecipe.match(/^ARG NODE_BASE_IMAGE=(.+)$/m)?.[1], testedBase);
  const attempt = await verifyCi(env);
  if (env.PUBLISH === "true") {
    await verifyEnvironment();
  }
  return attempt;
}

export async function verifyGhcr(image: unknown, digest: string, tag: string) {
  const packagePath = `orgs/openclaw/packages/container/${encodeURIComponent(ghcrPackageName(image))}`;
  // The manual dispatch authorizes publication. GHCR may omit repository
  // metadata; explicit conflicting linkage still fails package validation.
  validatePackage(await github(packagePath), image, { allowMissingRepository: true });
  const versions = await githubPages(`${packagePath}/versions`);
  const existing = versions.filter((version) => {
    assert.ok(version != null);
    const tags = field(field(field(version, "metadata"), "container"), "tags");
    if (tags == null) {
      return false;
    }
    assert.ok(Array.isArray(tags), "Invalid GHCR version tags.");
    return tags.includes(tag);
  });
  assert.ok(
    existing.every((version) => field(version, "name") === digest),
    "Refusing to overwrite an existing source tag with different image bytes.",
  );
  return existing.length > 0;
}
