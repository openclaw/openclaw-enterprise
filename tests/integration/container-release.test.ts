import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ghcrPackageName,
  github,
  readArchivePlatforms,
  repository,
  publishWorkflow,
  runtimeImageSmokeTests,
  validateCi,
  validateContext,
  validateEnvironment,
  validatePackage,
  validatePreparedImage,
  verifyGhcr,
} from "../../scripts/ci/container-release.mjs";
import { pushChart, writeBootstrapChart } from "../../scripts/ci/chart-package.ts";
import { loadTestSuites } from "../../scripts/ci/test-suites.mjs";
import {
  chartArchiveContent,
  stageReleaseChart,
  validateImageReceipt,
} from "../../scripts/ci/chart-release.ts";
import { setEnvironment } from "../helpers/environment.ts";
import { writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

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
} satisfies NodeJS.ProcessEnv;
const repo = { full_name: repository, private: false, default_branch: "main" };
// Package rejections shared by the GHCR verification and package validation tests.
const publicOnly = { message: /^GHCR package must already exist and be public\./ };
const linkFirst = { message: /^Link the package to Enterprise first\./ };

type Rejection = {
  message?: RegExp;
  operator?: string;
  actual?: unknown;
  expected?: unknown;
};

function releaseImage<Image extends "controller" | "runtime">(image: Image) {
  return {
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
  };
}

const controllerReceipt = releaseImage("controller");
const runtimeReceipt = releaseImage("runtime");
const releaseImages = [controllerReceipt, runtimeReceipt];

// Chart receipts and Helm packaging
test("chart release binds one exact image publication to the OCE version", () => {
  const expected = {
    sourceSha,
    runId: "123",
    attempt: "1",
    ciRunId: "456",
    ciAttempt: "1",
    controllerImage: controllerReceipt.destination,
    runtimeImage: runtimeReceipt.destination,
  };
  assert.deepEqual(
    validateImageReceipt(releaseImages, expected).map(({ image }) => image),
    ["controller", "runtime"],
  );
  // Each rejection names the guard that must refuse it, so removing any one guard fails.
  const runtime = (patch: Partial<typeof runtimeReceipt>) => [
    controllerReceipt,
    { ...runtimeReceipt, ...patch },
  ];
  for (const [changed, guard] of [
    [[controllerReceipt], { message: /^Expected two published images\./ }],
    [
      [controllerReceipt, controllerReceipt],
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
  ] satisfies [typeof releaseImages, Rejection][]) {
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
  const directory = await temporaryDirectory(t, "oce-release-chart-");
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
  const directory = await temporaryDirectory(t, "oce-chart-retry-");
  const staged = await stageReleaseChart(directory, {
    sourceSha,
    version: "0.1.0",
    images: releaseImages,
  });
  const first = join(directory, "first");
  const second = join(directory, "second");
  const changed = join(directory, "changed");
  await Promise.all([mkdir(first), mkdir(second), mkdir(changed)]);
  execFileSync(helm, ["package", staged, "--destination", first]);
  // Helm 3.19 stamps each tar entry with the time it writes it, rounded to the nearest second
  // (Go's archive/tar). Every first entry rounds to at most the second nearest to now, so
  // packaging again once now is past the next half second gives every entry a later timestamp,
  // without waiting a fixed 2 s.
  const laterSecond = (Math.round(Date.now() / 1_000) + 0.5) * 1_000 + 50;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, laterSecond - Date.now())));
  execFileSync(helm, ["package", staged, "--destination", second]);
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
  const directory = await temporaryDirectory(t, "oce-chart-bootstrap-");
  await writeBootstrapChart(directory, "0.0.0-bootstrap.123.1");
  execFileSync(helm, ["package", directory, "--destination", directory]);
  const archive = join(directory, "openclaw-enterprise-0.0.0-bootstrap.123.1.tgz");
  const metadata = execFileSync(helm, ["show", "chart", archive], { encoding: "utf8" });
  assert.match(metadata, /^name: openclaw-enterprise$/m);
  assert.match(metadata, /^version: 0\.0\.0-bootstrap\.123\.1$/m);
  assert.throws(
    () => execFileSync(helm, ["template", "oce", archive], { stdio: "pipe" }),
    (error: unknown) =>
      error instanceof Error &&
      "stderr" in error &&
      Buffer.isBuffer(error.stderr) &&
      error.stderr.toString().includes("This bootstrap marker is not a deployable"),
  );
});

test("chart push accepts a digest on stderr only after a successful exit", async (t) => {
  const directory = await temporaryDirectory(t, "oce-chart-push-stream-");
  const helm = join(directory, "helm");
  setEnvironment(t, { OCC_HELM_BIN: helm });
  const reported = `sha256:${"f".repeat(64)}`;
  // Helm writes the successful push digest to stderr, so stdout-only parsing fails.
  await writeCommand(directory, "helm", `printf 'Digest: ${reported}\\n' >&2\n`);
  assert.equal(pushChart("chart.tgz", "oci://registry.invalid/charts"), reported);
  await writeCommand(directory, "helm", `printf 'Digest: ${reported}\\n' >&2\nexit 1\n`);
  assert.throws(() => pushChart("chart.tgz", "oci://registry.invalid/charts"), {
    actual: 1,
    expected: 0,
  });
  await writeCommand(directory, "helm", `printf 'Digest: ${reported}\\n'\n`);
  assert.throws(() => pushChart("chart.tgz", "oci://registry.invalid/charts"), {
    message: /^Helm did not report the chart digest on stderr\./,
  });
});

// Release trust and GitHub metadata
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
    ] satisfies [Partial<typeof env>, Rejection][]) {
      assert.throws(() => validateContext({ ...context.env, ...patch }, context.repo), guard);
    }
    for (const [patch, actual, expected] of [
      [{ full_name: "other/enterprise" }, "other/enterprise", repository],
      [{ default_branch: "other" }, "other", "main"],
    ] satisfies [Partial<typeof repo>, string, string][]) {
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
  setEnvironment(t, { GH_TOKEN: "test-token" });
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
  setEnvironment(t, { GH_TOKEN: "test-token" });
  // Accelerate only the backoff; the real client still interprets API responses.
  t.mock.method(globalThis, "setTimeout", (resolve: () => void) => queueMicrotask(resolve));
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

type PackageMetadata = {
  name: string;
  package_type: string;
  visibility: string | undefined;
  repository?: Partial<typeof repo> | null | undefined;
};

test("GHCR publication accepts omitted repository metadata without approval and rejects unsafe packages", async (t) => {
  setEnvironment(t, { GH_TOKEN: "test-token" });
  const image = "ghcr.io/openclaw/openclaw-enterprise-controller";
  // GHCR can omit repository even for connected packages. The real validator
  // must accept that response without consulting deployment review history.
  let pkg: PackageMetadata = {
    name: "openclaw-enterprise-controller",
    package_type: "container",
    visibility: "public",
  };
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
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
  ] satisfies [Partial<PackageMetadata>, Rejection][]) {
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
  const required = {
    name: "CI Required",
    head_sha: sourceSha,
    conclusion: "success",
    status: "completed",
  };
  const jobs = [required];
  type RunPatch = Omit<Partial<typeof run>, "repository" | "head_repository"> & {
    repository?: Pick<typeof repo, "full_name">;
    head_repository?: Pick<typeof repo, "full_name">;
  };
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
  ] satisfies [RunPatch, Rejection][]) {
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
    () =>
      validateCi({ ...run, run_attempt: "latest" }, workflow, jobs, sourceSha, "456", undefined),
    {
      operator: "match",
      actual: "latest",
    },
  );
  for (const [patch, actual, expected] of [
    [{ path: ".github/workflows/other.yml" }, ".github/workflows/other.yml", workflow.path],
    [{ state: "disabled_manually" }, "disabled_manually", "active"],
  ] satisfies [Partial<typeof workflow>, string, string][]) {
    assert.throws(() => validateCi(run, { ...workflow, ...patch }, jobs, sourceSha, "456", "2"), {
      actual,
      expected,
    });
  }
  const oneRequired = { message: /^Exactly one CI Required aggregate job is required\./ };
  for (const [invalidJobs, guard] of [
    [[], oneRequired],
    [[...jobs, ...jobs], oneRequired],
    [[{ ...required, conclusion: "skipped" }], { actual: "skipped", expected: "success" }],
    [[{ ...required, status: "in_progress" }], { actual: "in_progress", expected: "completed" }],
    [[{ ...required, head_sha: "b".repeat(40) }], { actual: "b".repeat(40), expected: sourceSha }],
  ] satisfies [typeof jobs, Rejection][]) {
    assert.throws(() => validateCi(run, workflow, invalidJobs, sourceSha, "456", "2"), guard);
  }
});

test("container publication requires main-only environments and public matching packages", () => {
  const environment: {
    name: string;
    can_admins_bypass: boolean | undefined;
    protection_rules: unknown[];
    deployment_branch_policy: { custom_branch_policies: boolean; protected_branches: boolean };
  } = {
    name: "container-publish",
    can_admins_bypass: false,
    protection_rules: [],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  };
  const policies = [{ name: "main", type: "branch" }];
  validateEnvironment(environment, policies);
  const branchPolicy = (patch: Partial<typeof environment.deployment_branch_policy>) => ({
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
  ] satisfies [typeof environment, Rejection][]) {
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
  ] satisfies [Partial<PackageMetadata>, Rejection][]) {
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
  ] satisfies [Partial<PackageMetadata>, Rejection][]) {
    assert.throws(
      () =>
        validatePackage({ ...pkg, visibility: "private", ...patch }, image, {
          allowPrivateBootstrap: true,
        }),
      guard,
    );
  }
});

// OCI provenance, transport, and startup coverage
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

type BlobIdentity = { digest: string; size: number };
type PlatformDescriptor = BlobIdentity & {
  mediaType: string;
  platform: { os: string; architecture: string; variant?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

async function writeOciBlob(layout: string, value: object): Promise<BlobIdentity> {
  const bytes = Buffer.from(JSON.stringify(value));
  const hash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(layout, "blobs/sha256", hash), bytes);
  return { digest: `sha256:${hash}`, size: bytes.length };
}

test("OCI archive validation binds both platforms to their real manifest and config blobs", async (t) => {
  const directory = await temporaryDirectory(t, "enterprise-oci-platforms-");
  await mkdir(join(directory, "blobs/sha256"), { recursive: true });
  const blob = (value: object) => writeOciBlob(directory, value);
  // These are actual OCI scratch-image configs/manifests in a tar archive.
  // No replacement tar, Docker, or registry implementation decides the outcome.
  async function writePlatform(architecture: Architecture) {
    const config = await blob({
      architecture,
      os: "linux",
      config: {},
      rootfs: { type: "layers", diff_ids: [] },
    });
    const manifest = await blob({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
      layers: [],
    });
    const descriptor: PlatformDescriptor = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      ...manifest,
      platform: { os: "linux", architecture },
    };
    return { descriptor, configDigest: config.digest };
  }
  const amd64 = await writePlatform("amd64");
  const arm64 = await writePlatform("arm64");
  const manifests = [amd64.descriptor, arm64.descriptor];
  async function archive(
    entries: PlatformDescriptor[],
  ): Promise<[path: string, indexDigest: string]> {
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
    [amd64, arm64].map(({ descriptor, configDigest }) => ({
      platform: `linux/${descriptor.platform.architecture}`,
      digest: descriptor.digest,
      configDigest,
    })),
  );
  const both = ["linux/amd64", "linux/arm64"];
  const withArm64 = (patch: Partial<PlatformDescriptor>) => [
    amd64.descriptor,
    { ...arm64.descriptor, ...patch },
  ];
  for (const [invalid, guard] of [
    [[amd64.descriptor], { actual: ["linux/amd64"], expected: both }],
    [[arm64.descriptor], { actual: ["linux/arm64"], expected: both }],
    [
      [amd64.descriptor, amd64.descriptor],
      { actual: ["linux/amd64", "linux/amd64"], expected: both },
    ],
    [
      withArm64({ platform: { os: "linux", architecture: "s390x" } }),
      { message: /^Unexpected image platform: linux\/s390x/ },
    ],
    // The descriptor claims amd64 for the arm64 manifest; its config blob decides.
    [
      withArm64({ platform: { os: "linux", architecture: "amd64" } }),
      { message: /^Config platform mismatch\./ },
    ],
    [
      withArm64({ platform: { os: "linux", architecture: "arm64", variant: "v9" } }),
      { message: /^Unsupported platform variant\./ },
    ],
    [
      withArm64({ mediaType: "application/vnd.docker.distribution.manifest.v2+json" }),
      { actual: "application/vnd.docker.distribution.manifest.v2+json" },
    ],
    [withArm64({ digest: "sha256:arm64" }), { operator: "match", actual: "sha256:arm64" }],
  ] satisfies [PlatformDescriptor[], Rejection][]) {
    const input = await archive(invalid);
    assert.throws(() => readArchivePlatforms(...input), guard);
  }
  // Replacing an architecture's blob without updating its digest must fail, even when the
  // replacement is a valid config for the same platform.
  const replacement = JSON.stringify({ architecture: "arm64", os: "linux", replaced: true });
  await writeFile(join(directory, "blobs/sha256", arm64.configDigest.slice(7)), replacement);
  const corrupt = await archive(manifests);
  assert.throws(() => readArchivePlatforms(...corrupt), {
    actual: `sha256:${createHash("sha256").update(replacement).digest("hex")}`,
    expected: arm64.configDigest,
  });
});

test("metadata GET transport retries are bounded, diagnostic and do not retry denials", async (t) => {
  setEnvironment(t, { GH_TOKEN: "test-token" });
  t.mock.method(globalThis, "setTimeout", (resolve: () => void) => queueMicrotask(resolve));
  const path = "orgs/openclaw/packages/container/example";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError("fetch failed with a secret diagnostic");
    }
    if (calls === 2) {
      // Headers arrived, but consuming the response body must retry the GET.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("body interrupted"));
          },
        }),
      );
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
  await assert.rejects(github(path), {
    message: `GitHub GET ${path} transport failed after 3 attempts.`,
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

const architectures = ["amd64", "arm64"] as const;
type Architecture = (typeof architectures)[number];
const exportFaults = [
  "platform",
  "output-digest",
  "layer",
  "layer-size",
  "source",
  "attempt",
  "image",
  "emulated",
] as const;
type ExportFault = (typeof exportFaults)[number];

test("native platform exports verify offline and assemble into a digest-bound archive", async (t) => {
  const directory = await temporaryDirectory(t, "container-platform-assembly-");
  async function prepare(name: string, fault?: ExportFault, created = "2026-09-25T07:23:02Z") {
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
      NODE_BASE_IMAGE: `docker.io/library/node:24@sha256:${"c".repeat(64)}`,
    } satisfies NodeJS.ProcessEnv;
    async function writePlatform(arch: Architecture) {
      const layout = join(output, arch);
      await mkdir(join(layout, "blobs/sha256"), { recursive: true });
      await writeFile(join(layout, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
      const blob = async (value: object, mediaType: string) => ({
        ...(await writeOciBlob(layout, value)),
        mediaType,
      });
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
          nodeBaseImage: `docker.io/library/node:24@sha256:${"c".repeat(64)}`,
          image: fault === "image" ? "controller" : "runtime",
          platforms: ["linux/amd64", "linux/arm64"],
          platform: `linux/${arch}`,
          native: fault === "emulated" ? undefined : true,
          digest: fault === "output-digest" ? `sha256:${"a".repeat(64)}` : descriptor.digest,
        }),
      );
      if ((fault === "layer" || fault === "layer-size") && arch === "arm64") {
        await writeFile(
          join(layout, "blobs/sha256", layer.digest.slice(7)),
          fault === "layer-size" ? "short" : Buffer.alloc(layer.size),
        );
      }
      return {
        rootDigest: descriptor.digest,
        expected: {
          platform: `linux/${arch}`,
          digest: manifest.digest,
          configDigest: config.digest,
        },
      };
    }
    const platforms = { amd64: await writePlatform("amd64"), arm64: await writePlatform("arm64") };
    return { output, env, platforms };
  }
  function assemble(input: Awaited<ReturnType<typeof prepare>>) {
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
  // Build handoff retains bytes and provenance but cannot qualify an image before native smoke.
  const untested = await prepare("untested");
  function buildCommand(
    command: "record-build" | "verify-build",
    arch: Architecture,
    overrides: NodeJS.ProcessEnv = {},
  ) {
    return execFileSync(
      process.execPath,
      ["scripts/ci/container-release.mjs", command, join(untested.output, arch)],
      {
        env: {
          ...untested.env,
          PLATFORM: `linux/${arch}`,
          IMAGE_DIGEST:
            command === "record-build" ? untested.platforms[arch].rootDigest : undefined,
          ...overrides,
        },
        encoding: "utf8",
        stdio: "pipe",
      },
    );
  }
  for (const arch of architectures) {
    await unlink(join(untested.output, arch, "platform.json"));
    buildCommand("record-build", arch);
    const buildPath = join(untested.output, arch, "build.json");
    const originalBuild = await readFile(buildPath, "utf8");
    const build = record(JSON.parse(originalBuild));
    assert.equal(build.native, false);
    buildCommand("verify-build", arch);
    await assert.rejects(readFile(join(untested.output, arch, "platform.json")), {
      code: "ENOENT",
    });
    for (const overrides of [
      { SOURCE_SHA: "d".repeat(40) },
      { GITHUB_WORKFLOW_SHA: "e".repeat(40) },
      { GITHUB_RUN_ID: "124" },
      { GITHUB_RUN_ATTEMPT: "2" },
      { CI_RUN_ID: "457" },
      { CI_ATTEMPT: "2" },
      { NODE_BASE_IMAGE: `node@sha256:${"d".repeat(64)}` },
      { PLATFORM: arch === "amd64" ? "linux/arm64" : "linux/amd64" },
    ]) {
      assert.throws(() => buildCommand("verify-build", arch, overrides), /mismatch/);
    }
    await writeFile(buildPath, JSON.stringify({ ...build, native: true }));
    assert.throws(() => buildCommand("verify-build", arch), /Untested builds/);
    await writeFile(buildPath, originalBuild);
    const rootPath = join(
      untested.output,
      arch,
      "blobs/sha256",
      untested.platforms[arch].rootDigest.slice(7),
    );
    const originalRoot = await readFile(rootPath);
    await writeFile(rootPath, Buffer.alloc(originalRoot.length));
    assert.throws(() => buildCommand("verify-build", arch), /blob digest mismatch/);
    await writeFile(rootPath, originalRoot);
    await writeFile(join(untested.output, arch, "platform.json"), "{}");
    assert.throws(() => buildCommand("verify-build", arch), /must not contain platform.json/);
    await unlink(join(untested.output, arch, "platform.json"));
  }
  assert.throws(() => assemble(untested), /platform.json/);
  const valid = await prepare("valid");
  function verify(arch: Architecture, overrides: NodeJS.ProcessEnv = {}): unknown {
    const { expected, rootDigest } = valid.platforms[arch];
    return JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/ci/container-release.mjs", "verify-platform", join(valid.output, arch)],
        {
          env: {
            ...valid.env,
            PLATFORM: expected.platform,
            IMAGE_DIGEST: rootDigest,
            ...overrides,
          },
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    );
  }
  const snapshot = () => execFileSync("tar", ["-cf", "-", "-C", valid.output, "amd64", "arm64"]);
  execFileSync("chmod", ["-R", "a-w", valid.output]);
  try {
    const before = snapshot();
    for (const arch of architectures) {
      const {
        expected: { platform, digest, configDigest },
        rootDigest,
      } = valid.platforms[arch];
      assert.deepEqual(verify(arch), {
        platform,
        rootDigest,
        manifestDigest: digest,
        configDigest,
      });
    }
    for (const overrides of [
      { GITHUB_RUN_ID: "124" },
      { GITHUB_RUN_ATTEMPT: "2" },
      { SOURCE_SHA: "d".repeat(40) },
      { GITHUB_WORKFLOW_SHA: "e".repeat(40) },
      { IMAGE: "controller" },
      { PLATFORM: "linux/arm64" },
      { IMAGE_DIGEST: valid.platforms.arm64.rootDigest },
    ]) {
      assert.throws(() => verify("amd64", overrides), /mismatch/);
    }
    assert.throws(() => verify("amd64", { PLATFORM: "linux/s390x" }), /Expected linux/);
    assert.throws(() => verify("amd64", { IMAGE_DIGEST: undefined }), /native build output digest/);
    assert.deepEqual(snapshot(), before);
  } finally {
    execFileSync("chmod", ["-R", "u+w", valid.output]);
  }
  const manual = { CI_RUN_ID: "", CI_ATTEMPT: "" };
  const receiptPath = join(valid.output, "amd64/platform.json");
  const original = await readFile(receiptPath, "utf8");
  const receipt = record(JSON.parse(original));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, ciRunId: "", ciAttempt: "" }));
  verify("amd64", manual);
  assert.throws(() => verify("amd64", { ...manual, CI_ATTEMPT: "1" }), /Expected a CI run ID/);
  await writeFile(
    receiptPath,
    JSON.stringify({ ...receipt, ciRunId: undefined, ciAttempt: undefined }),
  );
  assert.throws(() => verify("amd64", manual), /receipt ciRunId mismatch/);
  assert.throws(
    () => verify("amd64", { CI_RUN_ID: undefined, CI_ATTEMPT: undefined }),
    /Expected a CI run ID/,
  );
  await writeFile(receiptPath, original);
  for (const entry of ["oci-layout", "blobs/sha256"]) {
    const path = join(valid.output, "amd64", entry);
    const outside = join(valid.output, "outside");
    await rename(path, outside);
    await symlink(outside, path);
    assert.throws(() => verify("amd64"), /Expected (a regular OCI file|an OCI layout directory)/);
    await unlink(path);
    await rename(outside, path);
  }
  assemble(valid);
  const digest = (await readFile(valid.env.GITHUB_OUTPUT, "utf8")).trim().slice("digest=".length);
  execFileSync(process.execPath, ["scripts/ci/container-release.mjs", "seal", valid.output], {
    env: { ...valid.env, IMAGE_DIGEST: digest },
  });
  const sealed = record(JSON.parse(await readFile(join(valid.output, "metadata.json"), "utf8")));
  assert.deepEqual(
    sealed.platformDigests,
    architectures.map((arch) => valid.platforms[arch].expected),
  );
  assert.equal(sealed.digest, digest);
  const index = record(
    JSON.parse(
      execFileSync(
        "tar",
        ["-xOf", join(valid.output, "image.tar"), `blobs/sha256/${digest.slice(7)}`],
        { encoding: "utf8" },
      ),
    ),
  );
  assert.ok(Array.isArray(index.manifests));
  assert.deepEqual(
    index.manifests.map((descriptor: unknown) => Object.keys(record(descriptor))),
    [
      ["mediaType", "digest", "size", "platform"],
      ["mediaType", "digest", "size", "platform"],
    ],
  );
  const repeated = await prepare("repeated", undefined, "2026-09-25T07:39:43Z");
  assemble(repeated);
  const repeatedDigest = (await readFile(repeated.env.GITHUB_OUTPUT, "utf8"))
    .trim()
    .slice("digest=".length);
  assert.equal(repeatedDigest, digest);
  for (const path of ["amd64", "arm64", "combined"]) {
    await assert.rejects(readFile(join(valid.output, path, "index.json")), { code: "ENOENT" });
  }
  for (const fault of exportFaults) {
    const invalid = await prepare(fault, fault);
    assert.throws(() => assemble(invalid), /mismatch|native runner/);
    await assert.rejects(readFile(invalid.env.GITHUB_OUTPUT), { code: "ENOENT" });
  }
});

test("the runtime release smoke runs every Image Runtime Startup file", () => {
  const manifest = record(
    loadTestSuites(fileURLToPath(new URL("../../scripts/ci/test-suites.json", import.meta.url))),
  );
  const lanes = Object.entries(record(manifest.lanes)).map(([name, lane]) => {
    const { files } = record(lane);
    assert.ok(Array.isArray(files), `Expected files in ${name}.`);
    const paths = files.map((file: unknown) => {
      const { path } = record(file);
      assert.ok(typeof path === "string", `Expected a file path in ${name}.`);
      return path;
    });
    return { name, paths };
  });
  // Find runtime image files by path in every lane, so a file under a lane with any name
  // cannot drop out of the smoke silently.
  const runtimeImageFiles = [
    ...new Set(
      lanes.flatMap(({ paths }) =>
        paths.filter((path) => path.startsWith("tests/integration/runtime-image-")),
      ),
    ),
  ];
  // Runtime image files the release smoke does not run, why, and the lane that holds them
  // (null: any lane).
  const notInSmoke = {
    // Drives the image helpers against a stand-in docker binary; it needs no image.
    "tests/integration/runtime-image-failure-output.test.ts": null,
    // Model probe files: the release smoke has never run them. The contention case runs
    // in Image Runtime Startup 3 and the outcomes in Image Runtime Startup 2.
    "tests/integration/runtime-image-model-probe.test.ts": "images-runtime-startup-3",
    "tests/integration/runtime-image-model-probe-outcomes.test.ts": "images-runtime-startup-2",
  };
  for (const [path, lane] of Object.entries(notInSmoke)) {
    const holders = lanes.filter(({ paths }) => paths.includes(path)).map(({ name }) => name);
    assert.ok(
      lane === null ? holders.length > 0 : holders.includes(lane),
      `${path} is no longer in ${lane ?? "a lane"}; review whether the release smoke should run it.`,
    );
  }
  // Keep the non-prefixed inventory independent so simultaneous omission from
  // the production smoke list and the startup lanes still fails.
  const nonPrefixedSmokeFiles = [
    "tests/helpers/workspace-gateway-relay-container.test.ts",
    "tests/integration/codex-plugin-stdio-real.test.ts",
    // Its OpenShell initializer case executes the pinned native workspace initializer.
    "tests/integration/sandbox-driver-startup.test.ts",
    "tests/integration/sandbox-driver-workspace-admission.test.ts",
    "tests/integration/sandbox-driver-startup-validation.test.ts",
    "tests/integration/sandbox-driver-installation-configuration.test.ts",
    "tests/integration/sandbox-driver-ipv6-endpoints.test.ts",
    "tests/integration/sandbox-driver-codex-app-server.test.ts",
    "tests/integration/workspace-files-native.test.ts",
  ];
  assert.deepEqual(
    [...runtimeImageSmokeTests].sort(),
    [
      ...runtimeImageFiles.filter((path) => !Object.hasOwn(notInSmoke, path)),
      ...nonPrefixedSmokeFiles,
    ].sort(),
    "Keep the release smoke list equal to the runtime image files; drop a notInSmoke entry once the smoke runs it.",
  );

  // Second check, by lane name: every Image Runtime Startup part, and every file in them.
  const startupLanes = lanes.filter(({ name }) => /^images-runtime-startup(?:-\d+)?$/.test(name));
  assert.deepEqual(startupLanes.map(({ name }) => name).sort(), [
    "images-runtime-startup",
    "images-runtime-startup-2",
    "images-runtime-startup-3",
  ]);
  const laneFiles = startupLanes.flatMap(({ paths }) => paths);
  assert.deepEqual(
    [...runtimeImageSmokeTests].sort(),
    laneFiles.filter((path) => !Object.hasOwn(notInSmoke, path)).sort(),
    "Keep the release smoke list equal to the Image Runtime Startup lane files.",
  );
});

test("native smoke rejects a transported image with another configuration before startup", async (t) => {
  const directory = await temporaryDirectory(t, "oce-smoke-config-");
  const binary = join(directory, "bin");
  const blobs = join(directory, "blobs/sha256");
  await mkdir(binary);
  await mkdir(blobs, { recursive: true });
  const blob = (value: object) => writeOciBlob(directory, value);
  const architecture = process.arch === "x64" ? "amd64" : process.arch;
  const config = {
    architecture,
    os: "linux",
    config: {},
    rootfs: { type: "layers", diff_ids: [] },
  };
  const original = await blob(config);
  const replacement = await blob({ ...config, config: { Cmd: ["unexpected"] } });
  const manifest = (selected: BlobIdentity) => ({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...selected },
    layers: [],
  });
  const sealed = await blob(manifest(original));
  const transported = await blob(manifest(replacement));
  const descriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    ...transported,
  };
  await writeFile(join(directory, "index.json"), JSON.stringify({ manifests: [sealed] }));
  await writeFile(
    join(directory, "inspect.json"),
    JSON.stringify([
      { Id: transported.digest, Descriptor: descriptor, Os: "linux", Architecture: architecture },
    ]),
  );
  execFileSync("tar", ["-cf", join(directory, "export.tar"), "-C", directory, "blobs"]);
  // Command stand-ins supply a real hash-addressed OCI metadata archive. The
  // supported smoke command and Python verifier must reject its substituted
  // config; this checks identity admission, not a Docker load or runtime.
  await writeCommand(
    binary,
    "skopeo",
    `
case "$1" in
  inspect) cat "$SMOKE_FIXTURE/blobs/sha256/${sealed.digest.slice(7)}" ;;
  copy) ;;
  *) exit 91 ;;
esac`,
  );
  await writeCommand(
    binary,
    "docker",
    `
case "$2" in
  inspect) cat "$SMOKE_FIXTURE/inspect.json" ;;
  save) cat "$SMOKE_FIXTURE/export.tar" ;;
  rm) ;;
  *) exit 92 ;;
esac`,
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/ci/container-release.mjs", "smoke", directory],
    {
      env: {
        ...process.env,
        PATH: `${binary}:${process.env.PATH}`,
        SMOKE_FIXTURE: directory,
        IMAGE: "controller",
        PLATFORM: `linux/${architecture}`,
        IMAGE_DIGEST: sealed.digest,
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Loaded image configuration differs from the sealed OCI export/);
  assert.equal(result.stdout.includes("Smoke controller"), false);
});
