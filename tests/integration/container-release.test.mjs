import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ghcrPackageName,
  github,
  readArchivePlatforms,
  repository,
  publishWorkflow,
  validateCi,
  validateContext,
  validateEnvironment,
  validatePackage,
  validatePreparedImage,
  verifyGhcr,
} from "../../scripts/ci/container-release.mjs";
import { pushChart, writeBootstrapChart } from "../../scripts/ci/chart-package.mjs";
import {
  chartArchiveContent,
  stageReleaseChart,
  validateImageReceipt,
} from "../../scripts/ci/chart-release.mjs";

const sourceSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: `${repository}/${publishWorkflow}@refs/heads/main`,
  GITHUB_WORKFLOW_SHA: sourceSha,
  GITHUB_SHA: sourceSha,
  SOURCE_SHA: sourceSha,
};
const repo = { full_name: repository, private: false, default_branch: "main" };
// Package rejections shared by the GHCR verification and package validation tests.
const publicOnly = { message: /^GHCR package must already exist and be public\./ };
const linkFirst = { message: /^Link the package to Enterprise first\./ };

const releaseImages = ["controller", "runtime"].map((image) => ({
  image,
  sourceSha,
  workflowSha: sourceSha,
  runId: "123",
  attempt: "1",
  ciRunId: "456",
  ciAttempt: "1",
  digest: `sha256:${(image === "controller" ? "c" : "d").repeat(64)}`,
  destination: `ghcr.io/openclaw/openclaw-enterprise-${image}`,
  tag: `sha-${sourceSha}`,
}));

test("chart release binds one exact image publication to the OCE version", () => {
  const expected = {
    sourceSha,
    runId: "123",
    attempt: "1",
    ciRunId: "456",
    ciAttempt: "1",
    controllerImage: releaseImages[0].destination,
    runtimeImage: releaseImages[1].destination,
  };
  assert.deepEqual(
    validateImageReceipt(releaseImages, expected).map(({ image }) => image),
    ["controller", "runtime"],
  );
  // Each rejection names the guard that must refuse it, so removing any one guard fails.
  const runtime = (patch) => [releaseImages[0], { ...releaseImages[1], ...patch }];
  for (const [changed, guard] of [
    [[releaseImages[0]], { message: /^Expected two published images\./ }],
    [
      [releaseImages[0], releaseImages[0]],
      { message: /^Expected controller and runtime images once each\./ },
    ],
    [runtime({ sourceSha: "b".repeat(40) }), { actual: "b".repeat(40), expected: sourceSha }],
    [runtime({ workflowSha: "b".repeat(40) }), { actual: "b".repeat(40), expected: sourceSha }],
    [runtime({ runId: "999" }), { actual: "999", expected: "123" }],
    [runtime({ attempt: "2" }), { actual: "2", expected: "1" }],
    [runtime({ ciRunId: "789" }), { actual: "789", expected: "456" }],
    [runtime({ ciAttempt: "2" }), { actual: "2", expected: "1" }],
    [runtime({ destination: "ghcr.io/openclaw/other" }), { actual: "ghcr.io/openclaw/other" }],
    [runtime({ tag: "latest" }), { actual: "latest", expected: `sha-${sourceSha}` }],
    [runtime({ digest: "latest" }), { operator: "match", actual: "latest" }],
  ]) {
    assert.throws(() => validateImageReceipt(changed, expected), guard);
  }
  assert.throws(() => validateImageReceipt(releaseImages, { ...expected, sourceSha: "main" }), {
    operator: "match",
    actual: "main",
  });
  const shared = { ...expected, runtimeImage: expected.controllerImage };
  assert.throws(
    () => validateImageReceipt(runtime({ destination: expected.controllerImage }), shared),
    { operator: "notStrictEqual" },
  );
});

test("staged release chart records both verified digests and defaults to the controller digest", async (t) => {
  const helm = process.env.OCC_HELM_BIN ?? "helm";
  try {
    execFileSync(helm, ["version", "--short"], { stdio: "ignore" });
  } catch {
    t.skip("Helm is required for the staged chart proof.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "oce-release-chart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const staged = await stageReleaseChart(directory, {
    sourceSha,
    version: "0.1.0",
    images: releaseImages,
  });
  execFileSync(helm, ["package", staged, "--destination", directory]);
  const archive = join(directory, "openclaw-enterprise-0.1.0.tgz");
  const metadata = execFileSync(helm, ["show", "chart", archive], { encoding: "utf8" });
  assert.match(
    metadata,
    /openclaw\.dev\/controller-image: ghcr\.io\/openclaw\/openclaw-enterprise-controller@sha256:c{64}/,
  );
  assert.match(
    metadata,
    /openclaw\.dev\/runtime-image: ghcr\.io\/openclaw\/openclaw-enterprise-runtime@sha256:d{64}/,
  );
  assert.match(metadata, /openclaw\.dev\/source-revision: a{40}/);
  const example = await readFile("deploy/examples/production/values.yaml", "utf8");
  const values = join(directory, "values.yaml");
  await writeFile(values, example.replace(/^images:\n[ ]{2}controller: .+\n/mu, ""));
  const rendered = execFileSync(helm, ["template", "oce", archive, "--values", values], {
    encoding: "utf8",
  });
  assert.match(rendered, /ghcr\.io\/openclaw\/openclaw-enterprise-controller@sha256:c{64}/);
});

test("a chart retry accepts matching files across Helm package timestamps and rejects changed templates", async (t) => {
  const helm = process.env.OCC_HELM_BIN ?? "helm";
  let helmVersion;
  try {
    helmVersion = execFileSync(helm, ["version", "--short"], { encoding: "utf8" });
  } catch {
    t.skip("Helm is required for the chart retry proof.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "oce-chart-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const staged = await stageReleaseChart(directory, {
    sourceSha,
    version: "0.1.0",
    images: releaseImages,
  });
  const first = join(directory, "first");
  const second = join(directory, "second");
  const changed = join(directory, "changed");
  await Promise.all([mkdir(first), mkdir(second), mkdir(changed)]);
  for (const destination of [first, second]) {
    execFileSync(helm, ["package", staged, "--destination", destination]);
    if (destination === first) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  const archiveName = "openclaw-enterprise-0.1.0.tgz";
  const firstArchive = join(first, archiveName);
  const secondArchive = join(second, archiveName);
  if (helmVersion.startsWith("v3.19.2")) {
    assert.notDeepEqual(await readFile(firstArchive), await readFile(secondArchive));
  }
  assert.deepEqual(
    await chartArchiveContent(firstArchive),
    await chartArchiveContent(secondArchive),
  );
  const template = join(staged, "templates/service.yaml");
  await writeFile(template, `${await readFile(template, "utf8")}\n# changed chart content\n`);
  execFileSync(helm, ["package", staged, "--destination", changed]);
  assert.notDeepEqual(
    await chartArchiveContent(firstArchive),
    await chartArchiveContent(join(changed, archiveName)),
  );
});

test("chart bootstrap package is valid OCI chart content but cannot be installed", async (t) => {
  const helm = process.env.OCC_HELM_BIN ?? "helm";
  try {
    execFileSync(helm, ["version", "--short"], { stdio: "ignore" });
  } catch {
    t.skip("Helm is required for the chart bootstrap package proof.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "oce-chart-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeBootstrapChart(directory, "0.0.0-bootstrap.123.1");
  execFileSync(helm, ["package", directory, "--destination", directory]);
  const archive = join(directory, "openclaw-enterprise-0.0.0-bootstrap.123.1.tgz");
  const metadata = execFileSync(helm, ["show", "chart", archive], { encoding: "utf8" });
  assert.match(metadata, /^name: openclaw-enterprise$/m);
  assert.match(metadata, /^version: 0\.0\.0-bootstrap\.123\.1$/m);
  assert.throws(
    () => execFileSync(helm, ["template", "oce", archive], { stdio: "pipe" }),
    (error) => error.stderr?.toString().includes("This bootstrap marker is not a deployable"),
  );
});

test("chart push accepts a digest on stderr only after a successful exit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-chart-push-stream-"));
  const helm = join(directory, "helm");
  const previous = process.env.OCC_HELM_BIN;
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.OCC_HELM_BIN;
    } else {
      process.env.OCC_HELM_BIN = previous;
    }
    await rm(directory, { recursive: true, force: true });
  });
  process.env.OCC_HELM_BIN = helm;
  const reported = `sha256:${"f".repeat(64)}`;
  // Helm writes the successful push digest to stderr, so stdout-only parsing fails.
  await writeFile(helm, `#!/bin/sh\nprintf 'Digest: ${reported}\\n' >&2\n`);
  await chmod(helm, 0o700);
  assert.equal(pushChart("chart.tgz", "oci://registry.invalid/charts"), reported);
  await writeFile(helm, `#!/bin/sh\nprintf 'Digest: ${reported}\\n' >&2\nexit 1\n`);
  assert.throws(() => pushChart("chart.tgz", "oci://registry.invalid/charts"), {
    actual: 1,
    expected: 0,
  });
  await writeFile(helm, `#!/bin/sh\nprintf 'Digest: ${reported}\\n'\n`);
  assert.throws(() => pushChart("chart.tgz", "oci://registry.invalid/charts"), {
    message: /^Helm did not report the chart digest on stderr\./,
  });
});

test("container release requires manual execution of the trusted main workflow", () => {
  for (const context of [
    { env, repo },
    { env: { ...env, PUBLISH: "false" }, repo: { ...repo, private: true } },
  ]) {
    validateContext(context.env, context.repo);
    const contributor = `${repository}/${publishWorkflow}@refs/heads/contributor`;
    for (const [patch, guard] of [
      [{ GITHUB_EVENT_NAME: "pull_request" }, { message: /^Only manual dispatch is supported\./ }],
      [{ GITHUB_REF: "refs/tags/main" }, { message: /^Select the trusted main workflow\./ }],
      [{ GITHUB_WORKFLOW_REF: contributor }, { actual: contributor }],
      [{ GITHUB_WORKFLOW_SHA: "main" }, { operator: "match", actual: "main" }],
      [{ GITHUB_SHA: "b".repeat(40) }, { actual: "b".repeat(40), expected: sourceSha }],
      [{ SOURCE_SHA: "main" }, { message: /^A full immutable source SHA is required\./ }],
      [
        { GITHUB_REPOSITORY: "other/enterprise" },
        { message: /^Only the Enterprise repository may publish\./ },
      ],
    ]) {
      assert.throws(() => validateContext({ ...context.env, ...patch }, context.repo), guard);
    }
    for (const [patch, actual, expected] of [
      [{ full_name: "other/enterprise" }, "other/enterprise", repository],
      [{ default_branch: "other" }, "other", "main"],
    ]) {
      assert.throws(() => validateContext(context.env, { ...context.repo, ...patch }), {
        actual,
        expected,
      });
    }
  }
});

test("private-source container preparation requires the exact false string", () => {
  validateContext({ ...env, PUBLISH: "false" }, { ...repo, private: true });
  validateContext({ ...env, PUBLISH: "false" }, repo);
  for (const PUBLISH of ["true", undefined, "", "FALSE", "0", false]) {
    validateContext({ ...env, PUBLISH }, repo);
    assert.throws(
      () => validateContext({ ...env, PUBLISH }, { ...repo, private: true }),
      /Publication requires the public Enterprise repository/,
    );
  }
});

for (const workflow of [
  ".github/workflows/container-promote.yml",
  ".github/workflows/container-bootstrap.yml",
  ".github/workflows/container-resume.yml",
]) {
  test(`${workflow} requires public source and workflow identity even with PUBLISH false`, () => {
    const promotion = {
      ...env,
      GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main`,
    };
    for (const PUBLISH of [undefined, "true", "false"]) {
      validateContext({ ...promotion, PUBLISH }, repo, workflow);
      assert.throws(
        () => validateContext({ ...promotion, PUBLISH }, { ...repo, private: true }, workflow),
        /Publication requires the public Enterprise repository/,
      );
    }
    assert.throws(() => validateContext({ ...env, PUBLISH: "false" }, repo, workflow), {
      actual: env.GITHUB_WORKFLOW_REF,
      expected: `${repository}/${workflow}@refs/heads/main`,
    });
  });
}

test("only explicit bootstrap lookups tolerate missing package metadata", async (t) => {
  // The external API supplies status codes; the real client must distinguish
  // absence from authorization failures before harmless bootstrap is permitted.
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-token";
  t.after(() => {
    if (token === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = token;
    }
  });
  for (const status of [401, 403, 404, 429, 500]) {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status }));
    await assert.rejects(
      github("orgs/openclaw/packages/container/example"),
      new RegExp(`\\(${status}\\)`),
    );
    const lookup = github("orgs/openclaw/packages/container/example", { allowNotFound: true });
    if (status === 404) {
      assert.equal(await lookup, null);
    } else {
      await assert.rejects(lookup, new RegExp(`\\(${status}\\)`));
    }
    t.mock.restoreAll();
  }
  const pkg = { name: "example", visibility: "public" };
  t.mock.method(globalThis, "fetch", async () => Response.json(pkg));
  assert.deepEqual(
    await github("orgs/openclaw/packages/container/example", { allowNotFound: true }),
    pkg,
  );
});

test("container context rejects malformed repository privacy in preparation and publication", () => {
  for (const privateValue of [undefined, null, "false", "true", 0, 1, {}, []]) {
    for (const PUBLISH of ["false", "true", undefined]) {
      assert.throws(
        () => validateContext({ ...env, PUBLISH }, { ...repo, private: privateValue }),
        {
          message: /^Repository privacy must be a boolean\./,
        },
      );
    }
  }
});

test("post-marker metadata retries only 404 and remains bounded", async (t) => {
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-token";
  t.after(() => {
    if (token === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = token;
    }
  });
  // Accelerate only the backoff; the real client still interprets API responses.
  t.mock.method(globalThis, "setTimeout", (resolve) => queueMicrotask(resolve));
  const pkg = { name: "example", package_type: "container", visibility: "public" };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1 ? new Response(null, { status: 404 }) : Response.json(pkg),
  );
  assert.deepEqual(
    await github("orgs/openclaw/packages/container/example", { retryNotFound: true }),
    pkg,
  );
  assert.equal(calls, 2);
  for (const status of [401, 403, 404, 429, 500]) {
    calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new Response(null, { status });
    });
    await assert.rejects(
      github("orgs/openclaw/packages/container/example", { retryNotFound: true }),
      new RegExp(`\\(${status}\\)`),
    );
    assert.equal(calls, status === 404 ? 6 : 1);
  }
});

test("GHCR publication accepts omitted repository metadata without approval and rejects unsafe packages", async (t) => {
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-token";
  t.after(() => {
    if (token === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = token;
    }
  });
  const image = "ghcr.io/openclaw/openclaw-enterprise-controller";
  // GHCR can omit repository even for connected packages. The real validator
  // must accept that response without consulting deployment review history.
  let pkg = {
    name: "openclaw-enterprise-controller",
    package_type: "container",
    visibility: "public",
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/versions")) {
      return Response.json([]);
    }
    if (path.endsWith("/packages/container/openclaw-enterprise-controller")) {
      return Response.json(pkg);
    }
    throw new Error(`Unexpected metadata request: ${path}`);
  });
  await verifyGhcr(image, digest, `sha-${sourceSha}`);
  pkg.repository = null;
  await verifyGhcr(image, digest, `sha-${sourceSha}`);
  for (const [patch, guard] of [
    [{ visibility: "private" }, publicOnly],
    [{ visibility: undefined }, publicOnly],
    [{ name: "other" }, { actual: "other", expected: "openclaw-enterprise-controller" }],
    [{ repository: { ...repo, full_name: "openclaw/other" } }, linkFirst],
    [{ repository: { ...repo, private: true } }, { actual: true, expected: false }],
    [{ repository: {} }, linkFirst],
  ]) {
    const original = pkg;
    pkg = { ...pkg, ...patch };
    await assert.rejects(verifyGhcr(image, digest, `sha-${sourceSha}`), guard);
    pkg = original;
  }
  // Explicit correct repository metadata remains valid.
  pkg.repository = repo;
  await verifyGhcr(image, digest, `sha-${sourceSha}`);
});

test("container release requires exact successful CI identity and its aggregate job", () => {
  // Shapes follow the Actions workflow, workflow-run, and attempt-jobs REST responses.
  const workflow = { id: 123, path: ".github/workflows/ci.yml", state: "active" };
  const run = {
    id: 456,
    workflow_id: 123,
    path: workflow.path,
    repository: repo,
    head_repository: repo,
    head_sha: sourceSha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
  };
  const jobs = [
    { name: "CI Required", head_sha: sourceSha, conclusion: "success", status: "completed" },
  ];
  validateCi(run, workflow, jobs, sourceSha, "456", "2");
  const pushOnly = { message: /^PR and arbitrary dispatch checks are not release evidence\./ };
  const other = { full_name: "other/enterprise" };
  for (const [patch, guard] of [
    [{ id: 999 }, { actual: "999", expected: "456" }],
    [{ workflow_id: 999 }, { message: /^CI workflow identity must match, not just its name\./ }],
    [{ path: ".github/workflows/other.yml" }, { actual: ".github/workflows/other.yml" }],
    [{ repository: other }, { actual: other.full_name, expected: repository }],
    [{ head_repository: other }, { actual: other.full_name, expected: repository }],
    [{ head_sha: "b".repeat(40) }, { message: /^CI must have tested this exact source\./ }],
    [{ head_branch: "feature" }, { actual: "feature", expected: "main" }],
    [{ event: "pull_request" }, pushOnly],
    [{ event: "workflow_dispatch" }, pushOnly],
    [{ status: "in_progress" }, { actual: "in_progress", expected: "completed" }],
    [{ conclusion: "failure" }, { message: /^The entire CI run must succeed\./ }],
    [{ run_attempt: 3 }, { actual: "3", expected: "2" }],
  ]) {
    assert.throws(
      () => validateCi({ ...run, ...patch }, workflow, jobs, sourceSha, "456", "2"),
      guard,
    );
  }
  assert.throws(() => validateCi(run, workflow, jobs, sourceSha, "latest", "2"), {
    operator: "match",
    actual: "latest",
  });
  assert.throws(
    () => validateCi({ ...run, run_attempt: "latest" }, workflow, jobs, sourceSha, "456"),
    {
      operator: "match",
      actual: "latest",
    },
  );
  for (const [patch, actual, expected] of [
    [{ path: ".github/workflows/other.yml" }, ".github/workflows/other.yml", workflow.path],
    [{ state: "disabled_manually" }, "disabled_manually", "active"],
  ]) {
    assert.throws(() => validateCi(run, { ...workflow, ...patch }, jobs, sourceSha, "456", "2"), {
      actual,
      expected,
    });
  }
  const oneRequired = { message: /^Exactly one CI Required aggregate job is required\./ };
  for (const [invalidJobs, guard] of [
    [[], oneRequired],
    [[...jobs, ...jobs], oneRequired],
    [[{ ...jobs[0], conclusion: "skipped" }], { actual: "skipped", expected: "success" }],
    [[{ ...jobs[0], status: "in_progress" }], { actual: "in_progress", expected: "completed" }],
    [[{ ...jobs[0], head_sha: "b".repeat(40) }], { actual: "b".repeat(40), expected: sourceSha }],
  ]) {
    assert.throws(() => validateCi(run, workflow, invalidJobs, sourceSha, "456", "2"), guard);
  }
});

test("container publication requires main-only environments and public matching packages", () => {
  const environment = {
    name: "container-publish",
    can_admins_bypass: false,
    protection_rules: [],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  };
  const policies = [{ name: "main", type: "branch" }];
  validateEnvironment(environment, policies);
  const branchPolicy = (patch) => ({
    ...environment,
    deployment_branch_policy: { ...environment.deployment_branch_policy, ...patch },
  });
  const noBypass = { message: /^Disable administrator environment bypass\./ };
  for (const [changed, guard] of [
    [
      { ...environment, name: "other" },
      { actual: "other", expected: "container-publish" },
    ],
    [{ ...environment, can_admins_bypass: true }, noBypass],
    [{ ...environment, can_admins_bypass: undefined }, noBypass],
    [branchPolicy({ custom_branch_policies: false }), { actual: false, expected: true }],
    [branchPolicy({ protected_branches: true }), { actual: true, expected: false }],
  ]) {
    assert.throws(() => validateEnvironment(changed, policies), guard);
  }
  for (const changed of [[{ name: "*", type: "branch" }], [{ name: "main", type: "tag" }]]) {
    assert.throws(() => validateEnvironment(environment, changed), {
      message: /^The publishing environment must allow only the main branch, not tags\./,
    });
  }
  const image = "ghcr.io/openclaw/openclaw-enterprise/controller";
  const pkg = {
    name: "openclaw-enterprise/controller",
    package_type: "container",
    visibility: "public",
    repository: repo,
  };
  validatePackage(pkg, image);
  // Missing linkage is allowed explicitly; reported conflicting linkage still fails.
  for (const repository of [undefined, null]) {
    const unreported = { ...pkg, repository };
    assert.throws(() => validatePackage(unreported, image), linkFirst);
    assert.equal(validatePackage(unreported, image, { allowMissingRepository: true }), false);
    assert.throws(
      () =>
        validatePackage({ ...unreported, visibility: "private" }, image, {
          allowMissingRepository: true,
        }),
      publicOnly,
    );
  }
  for (const [patch, guard] of [
    [{ visibility: "private" }, publicOnly],
    [{ repository: { ...repo, private: true } }, { actual: true, expected: false }],
    [{ repository: { full_name: "openclaw/openclaw" } }, linkFirst],
    [{ name: "other" }, { actual: "other", expected: "openclaw-enterprise/controller" }],
    [{ package_type: "npm" }, { actual: "npm", expected: "container" }],
  ]) {
    assert.throws(() => validatePackage({ ...pkg, ...patch }, image), guard);
  }
  for (const destination of [
    "",
    "ghcr.io/other/controller",
    `${image}:latest`,
    `${image}@${digest}`,
    "docker.io/openclaw/controller",
  ]) {
    assert.throws(() => ghcrPackageName(destination), {
      message:
        /^Set an explicit GHCR image in the openclaw organization, without a tag or digest\./,
    });
  }
});

test("private packages are accepted only for explicit marker bootstrap", () => {
  const image = "ghcr.io/openclaw/openclaw-enterprise-controller";
  const pkg = {
    name: "openclaw-enterprise-controller",
    package_type: "container",
    repository: repo,
  };
  for (const visibility of ["public", "private"]) {
    validatePackage({ ...pkg, visibility }, image, { allowPrivateBootstrap: true });
  }
  assert.throws(() => validatePackage({ ...pkg, visibility: "private" }, image), publicOnly);
  for (const [patch, guard] of [
    [{ visibility: "internal" }, publicOnly],
    [{ visibility: undefined }, publicOnly],
    [{ repository: { ...repo, private: true } }, { actual: true, expected: false }],
    [{ repository: { ...repo, full_name: "other/repository" } }, linkFirst],
    [{ name: "other" }, { actual: "other", expected: "openclaw-enterprise-controller" }],
  ]) {
    assert.throws(
      () =>
        validatePackage({ ...pkg, visibility: "private", ...patch }, image, {
          allowPrivateBootstrap: true,
        }),
      guard,
    );
  }
});

test("prepared OCI metadata cannot cross source, image, attempt, CI or base-image boundaries", () => {
  const expected = {
    sourceSha,
    workflowSha: sourceSha,
    runId: "123",
    attempt: "2",
    ciRunId: "456",
    ciAttempt: "1",
    nodeBaseImage: `docker.io/library/node:24-bookworm@${digest}`,
    image: "controller",
  };
  const metadata = {
    ...expected,
    platforms: ["linux/amd64", "linux/arm64"],
    digest,
    archiveSha256: "c".repeat(64),
  };
  validatePreparedImage(metadata, expected);
  for (const key of Object.keys(expected)) {
    assert.throws(() => validatePreparedImage({ ...metadata, [key]: "different" }, expected), {
      message: new RegExp(`^Prepared image ${key} does not match this run\\.`),
    });
  }
  for (const platforms of [["linux/amd64"], ["linux/arm64"], ["linux/amd64", "linux/amd64"]]) {
    assert.throws(() => validatePreparedImage({ ...metadata, platforms }, expected), {
      actual: platforms,
      expected: metadata.platforms,
    });
  }
  for (const field of ["digest", "archiveSha256"]) {
    assert.throws(() => validatePreparedImage({ ...metadata, [field]: "latest" }, expected), {
      operator: "match",
      actual: "latest",
    });
  }
});

test("OCI archive validation binds both platforms to their real manifest and config blobs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "enterprise-oci-platforms-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "blobs/sha256"), { recursive: true });
  async function blob(value) {
    const bytes = JSON.stringify(value);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, "blobs/sha256", hash), bytes);
    return { digest: `sha256:${hash}`, size: Buffer.byteLength(bytes) };
  }
  const manifests = [];
  const configs = [];
  // These are actual OCI scratch-image configs/manifests in a tar archive.
  // No replacement tar, Docker, or registry implementation decides the outcome.
  for (const architecture of ["amd64", "arm64"]) {
    const config = await blob({
      architecture,
      os: "linux",
      config: {},
      rootfs: { type: "layers", diff_ids: [] },
    });
    configs.push(config);
    const manifest = await blob({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
      layers: [],
    });
    manifests.push({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      ...manifest,
      platform: { os: "linux", architecture },
    });
  }
  async function archive(entries) {
    const index = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: entries,
    };
    const descriptor = await blob(index);
    await writeFile(
      join(directory, "index.json"),
      JSON.stringify({
        ...index,
        manifests: [{ mediaType: index.mediaType, ...descriptor }],
      }),
    );
    await writeFile(join(directory, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
    const path = join(directory, "image.tar");
    execFileSync("tar", ["-cf", path, "-C", directory, "blobs", "index.json", "oci-layout"]);
    return [path, descriptor.digest];
  }
  assert.deepEqual(
    readArchivePlatforms(...(await archive([...manifests].reverse()))),
    manifests.map((manifest, index) => ({
      platform: `linux/${manifest.platform.architecture}`,
      digest: manifest.digest,
      configDigest: configs[index].digest,
    })),
  );
  const both = ["linux/amd64", "linux/arm64"];
  const arm64 = (patch) => [manifests[0], { ...manifests[1], ...patch }];
  for (const [invalid, guard] of [
    [[manifests[0]], { actual: ["linux/amd64"], expected: both }],
    [[manifests[1]], { actual: ["linux/arm64"], expected: both }],
    [[manifests[0], manifests[0]], { actual: ["linux/amd64", "linux/amd64"], expected: both }],
    [
      arm64({ platform: { os: "linux", architecture: "s390x" } }),
      { message: /^Unexpected image platform: linux\/s390x/ },
    ],
    // The descriptor claims amd64 for the arm64 manifest; its config blob decides.
    [
      arm64({ platform: { os: "linux", architecture: "amd64" } }),
      { message: /^Config platform mismatch\./ },
    ],
    [
      arm64({ platform: { os: "linux", architecture: "arm64", variant: "v9" } }),
      { message: /^Unsupported platform variant\./ },
    ],
    [
      arm64({ mediaType: "application/vnd.docker.distribution.manifest.v2+json" }),
      { actual: "application/vnd.docker.distribution.manifest.v2+json" },
    ],
    [arm64({ digest: "sha256:arm64" }), { operator: "match", actual: "sha256:arm64" }],
  ]) {
    const input = await archive(invalid);
    assert.throws(() => readArchivePlatforms(...input), guard);
  }
  // Replacing an architecture's blob without updating its digest must fail, even when the
  // replacement is a valid config for the same platform.
  const replacement = JSON.stringify({ architecture: "arm64", os: "linux", replaced: true });
  await writeFile(join(directory, "blobs/sha256", configs[1].digest.slice(7)), replacement);
  const corrupt = await archive(manifests);
  assert.throws(() => readArchivePlatforms(...corrupt), {
    actual: `sha256:${createHash("sha256").update(replacement).digest("hex")}`,
    expected: configs[1].digest,
  });
});

test("metadata GET transport retries are bounded, diagnostic and do not retry denials", async (t) => {
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-token";
  t.after(() => {
    if (token === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = token;
    }
  });
  t.mock.method(globalThis, "setTimeout", (resolve) => queueMicrotask(resolve));
  const path = "orgs/openclaw/packages/container/example";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError("fetch failed with a secret diagnostic");
    }
    if (calls === 2) {
      return {
        status: 200,
        text: async () => {
          throw new Error("body interrupted");
        },
      };
    }
    return Response.json({ visibility: "public" });
  });
  assert.deepEqual(await github(path), { visibility: "public" });
  assert.equal(calls, 3);
  calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    throw new TypeError("fetch failed with a secret diagnostic");
  });
  await assert.rejects(github(path), (error) => {
    assert.equal(error.message, `GitHub GET ${path} transport failed after 3 attempts.`);
    return true;
  });
  assert.equal(calls, 3);
  for (const status of [401, 403, 404, 429, 500]) {
    calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new Response(null, { status });
    });
    await assert.rejects(github(path), new RegExp(`\\(${status}\\)`));
    assert.equal(calls, 1);
  }
});

test("separate platform exports assemble into a digest-bound archive and reject corrupt inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "container-platform-assembly-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function prepare(name, fault, created = "2026-09-25T07:23:02Z") {
    const output = join(directory, name);
    const env = {
      ...process.env,
      GITHUB_OUTPUT: join(output, "outputs"),
      IMAGE: "runtime",
      SOURCE_SHA: sourceSha,
      GITHUB_WORKFLOW_SHA: sourceSha,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      CI_RUN_ID: "456",
      CI_ATTEMPT: "1",
      NODE_BASE_IMAGE: "pinned-node",
    };
    const expected = [];
    for (const arch of ["amd64", "arm64"]) {
      const layout = join(output, arch);
      await mkdir(join(layout, "blobs/sha256"), { recursive: true });
      async function blob(value, mediaType) {
        const bytes = Buffer.from(JSON.stringify(value));
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        await writeFile(join(layout, "blobs/sha256", digest.slice(7)), bytes);
        return { digest, size: bytes.length, mediaType };
      }
      const config = await blob(
        { os: "linux", architecture: fault === "platform" ? "amd64" : arch },
        "application/vnd.oci.image.config.v1+json",
      );
      const layer = await blob(
        { content: "retained layer bytes" },
        "application/vnd.oci.image.layer.v1.tar",
      );
      const manifest = await blob(
        {
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          config,
          layers: [layer],
        },
        "application/vnd.oci.image.manifest.v1+json",
      );
      expected.push({
        platform: `linux/${arch}`,
        digest: manifest.digest,
        configDigest: config.digest,
      });
      // BuildKit may export a manifest directly or wrap it in a one-platform index.
      const platformDescriptor = {
        ...manifest,
        annotations: {
          "org.opencontainers.image.created": created,
          "org.opencontainers.image.ref.name": "latest",
        },
      };
      const descriptor =
        arch === "amd64"
          ? platformDescriptor
          : await blob(
              {
                schemaVersion: 2,
                mediaType: "application/vnd.oci.image.index.v1+json",
                manifests: [platformDescriptor],
              },
              "application/vnd.oci.image.index.v1+json",
            );
      await writeFile(
        join(layout, "index.json"),
        JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }),
      );
      await writeFile(
        join(layout, "platform.json"),
        JSON.stringify({
          sourceSha: fault === "source" ? "b".repeat(40) : sourceSha,
          workflowSha: sourceSha,
          runId: "123",
          attempt: fault === "attempt" ? "2" : "1",
          ciRunId: "456",
          ciAttempt: "1",
          nodeBaseImage: "pinned-node",
          image: fault === "image" ? "controller" : "runtime",
          platforms: ["linux/amd64", "linux/arm64"],
          platform: `linux/${arch}`,
          native: fault !== "emulated",
          digest: fault === "output-digest" ? `sha256:${"a".repeat(64)}` : descriptor.digest,
        }),
      );
      if (fault === "layer" && arch === "arm64") {
        await writeFile(
          join(layout, "blobs/sha256", layer.digest.slice(7)),
          "corrupted layer bytes",
        );
      }
    }
    return { output, env, expected };
  }
  function run(input) {
    return execFileSync(
      process.execPath,
      ["scripts/ci/container-release.mjs", "assemble", input.output],
      {
        env: input.env,
        encoding: "utf8",
        stdio: "pipe",
      },
    );
  }
  const valid = await prepare("valid");
  run(valid);
  const digest = (await readFile(valid.env.GITHUB_OUTPUT, "utf8")).trim().slice("digest=".length);
  assert.deepEqual(readArchivePlatforms(join(valid.output, "image.tar"), digest), valid.expected);
  const index = JSON.parse(
    execFileSync("tar", [
      "-xOf",
      join(valid.output, "image.tar"),
      `blobs/sha256/${digest.slice(7)}`,
    ]),
  );
  assert.deepEqual(
    index.manifests.map((descriptor) => Object.keys(descriptor)),
    [
      ["mediaType", "digest", "size", "platform"],
      ["mediaType", "digest", "size", "platform"],
    ],
  );
  const repeated = await prepare("repeated", undefined, "2026-09-25T07:39:43Z");
  run(repeated);
  const repeatedDigest = (await readFile(repeated.env.GITHUB_OUTPUT, "utf8"))
    .trim()
    .slice("digest=".length);
  assert.equal(repeatedDigest, digest);
  for (const path of ["amd64", "arm64", "combined"]) {
    await assert.rejects(readFile(join(valid.output, path, "index.json")), { code: "ENOENT" });
  }
  for (const fault of [
    "platform",
    "output-digest",
    "layer",
    "source",
    "attempt",
    "image",
    "emulated",
  ]) {
    const invalid = await prepare(fault, fault);
    assert.throws(() => run(invalid), /mismatch|native runner/);
    await assert.rejects(readFile(invalid.env.GITHUB_OUTPUT), { code: "ENOENT" });
  }
});
