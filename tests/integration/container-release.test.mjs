import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const repo = { full_name: repository, private: true, default_branch: "main" };

test("container release requires manual execution of the trusted main workflow", () => {
  for (const context of [
    { env, repo },
    { env: { ...env, PUBLISH: "false" }, repo: { ...repo, private: false } },
  ]) {
    validateContext(context.env, context.repo);
    for (const patch of [
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REF: "refs/tags/main" },
      { GITHUB_WORKFLOW_REF: `${repository}/${publishWorkflow}@refs/heads/contributor` },
      { GITHUB_WORKFLOW_SHA: "main" },
      { GITHUB_SHA: "b".repeat(40) },
      { SOURCE_SHA: "main" },
      { GITHUB_REPOSITORY: "other/enterprise" },
    ]) {
      assert.throws(() => validateContext({ ...context.env, ...patch }, context.repo));
    }
    for (const patch of [{ full_name: "other/enterprise" }, { default_branch: "other" }]) {
      assert.throws(() => validateContext(context.env, { ...context.repo, ...patch }));
    }
  }
});

test("public container preparation requires the exact false string", () => {
  validateContext({ ...env, PUBLISH: "false" }, { ...repo, private: false });
  validateContext({ ...env, PUBLISH: "false" }, repo);
  for (const PUBLISH of ["true", undefined, "", "FALSE", "0", false]) {
    validateContext({ ...env, PUBLISH }, repo);
    assert.throws(
      () => validateContext({ ...env, PUBLISH }, { ...repo, private: false }),
      /Publication requires the private Enterprise repository/,
    );
  }
});

for (const workflow of [
  ".github/workflows/container-promote.yml",
  ".github/workflows/container-bootstrap.yml",
]) {
  test(`${workflow} retains private source and workflow identity even with PUBLISH false`, () => {
    const promotion = {
      ...env,
      GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main`,
    };
    for (const PUBLISH of [undefined, "true", "false"]) {
      validateContext({ ...promotion, PUBLISH }, repo, workflow);
      assert.throws(
        () => validateContext({ ...promotion, PUBLISH }, { ...repo, private: false }, workflow),
        /Publication requires the private Enterprise repository/,
      );
    }
    assert.throws(() => validateContext({ ...env, PUBLISH: "false" }, repo, workflow));
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
  const pkg = { name: "example", visibility: "private" };
  t.mock.method(globalThis, "fetch", async () => Response.json(pkg));
  assert.deepEqual(
    await github("orgs/openclaw/packages/container/example", { allowNotFound: true }),
    pkg,
  );
});

test("container context rejects malformed repository privacy in preparation and publication", () => {
  for (const privateValue of [undefined, null, "false", "true", 0, 1, {}, []]) {
    for (const PUBLISH of ["false", "true", undefined]) {
      assert.throws(() => validateContext({ ...env, PUBLISH }, { ...repo, private: privateValue }));
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
  const pkg = { name: "example", package_type: "container", visibility: "private" };
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
    visibility: "private",
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
  for (const patch of [
    { visibility: "public" },
    { visibility: undefined },
    { name: "other" },
    { repository: { ...repo, full_name: "openclaw/other" } },
    { repository: { ...repo, private: false } },
    { repository: {} },
  ]) {
    const original = pkg;
    pkg = { ...pkg, ...patch };
    await assert.rejects(verifyGhcr(image, digest, `sha-${sourceSha}`));
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
  for (const patch of [
    { workflow_id: 999 },
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { run_attempt: 3 },
    { head_repository: { full_name: "other/enterprise" } },
  ]) {
    assert.throws(() => validateCi({ ...run, ...patch }, workflow, jobs, sourceSha, "456", "2"));
  }
  for (const invalidJobs of [[], [...jobs, ...jobs], [{ ...jobs[0], conclusion: "skipped" }]]) {
    assert.throws(() => validateCi(run, workflow, invalidJobs, sourceSha, "456", "2"));
  }
});

test("container publication requires main-only environments and private matching packages", () => {
  const environment = {
    name: "container-publish",
    can_admins_bypass: false,
    protection_rules: [],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  };
  const policies = [{ name: "main", type: "branch" }];
  validateEnvironment(environment, policies);
  assert.throws(() => validateEnvironment({ ...environment, can_admins_bypass: true }, policies));
  assert.throws(() =>
    validateEnvironment({ ...environment, can_admins_bypass: undefined }, policies),
  );
  assert.throws(() => validateEnvironment(environment, [{ name: "*", type: "branch" }]));
  assert.throws(() => validateEnvironment(environment, [{ name: "main", type: "tag" }]));
  const image = "ghcr.io/openclaw/openclaw-enterprise/controller";
  const pkg = {
    name: "openclaw-enterprise/controller",
    package_type: "container",
    visibility: "private",
    repository: repo,
  };
  validatePackage(pkg, image);
  // Missing linkage is allowed explicitly; reported conflicting linkage still fails.
  for (const repository of [undefined, null]) {
    const unreported = { ...pkg, repository };
    assert.throws(() => validatePackage(unreported, image));
    assert.equal(validatePackage(unreported, image, { allowMissingRepository: true }), false);
    assert.throws(() =>
      validatePackage({ ...unreported, visibility: "public" }, image, {
        allowMissingRepository: true,
      }),
    );
  }
  assert.throws(() => validatePackage({ ...pkg, visibility: "public" }, image));
  assert.throws(() => validatePackage({ ...pkg, repository: { ...repo, private: false } }, image));
  assert.throws(() =>
    validatePackage({ ...pkg, repository: { full_name: "openclaw/openclaw" } }, image),
  );
  assert.throws(() => validatePackage({ ...pkg, name: "other" }, image));
  for (const destination of [
    "",
    "ghcr.io/other/controller",
    `${image}:latest`,
    `${image}@${digest}`,
    "docker.io/openclaw/controller",
  ]) {
    assert.throws(() => ghcrPackageName(destination));
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
    assert.throws(() => validatePreparedImage({ ...metadata, [key]: "different" }, expected));
  }
  assert.throws(() => validatePreparedImage({ ...metadata, digest: "latest" }, expected));
  assert.throws(() => validatePreparedImage({ ...metadata, platforms: ["linux/amd64"] }, expected));
  assert.throws(() => validatePreparedImage({ ...metadata, platforms: ["linux/arm64"] }, expected));
  assert.throws(() =>
    validatePreparedImage({ ...metadata, platforms: ["linux/amd64", "linux/amd64"] }, expected),
  );
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
  for (const invalid of [
    [manifests[0]],
    [manifests[1]],
    [manifests[0], manifests[0]],
    [manifests[0], { ...manifests[1], platform: { os: "linux", architecture: "s390x" } }],
    [manifests[0], { ...manifests[1], platform: { os: "linux", architecture: "amd64" } }],
    [
      manifests[0],
      { ...manifests[1], platform: { os: "linux", architecture: "arm64", variant: "v9" } },
    ],
  ]) {
    const input = await archive(invalid);
    assert.throws(() => readArchivePlatforms(...input));
  }
  // Replacing an architecture's blob without updating its digest must fail.
  await writeFile(join(directory, "blobs/sha256", configs[1].digest.slice(7)), "{}");
  const corrupt = await archive(manifests);
  assert.throws(() => readArchivePlatforms(...corrupt));
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
    return Response.json({ visibility: "private" });
  });
  assert.deepEqual(await github(path), { visibility: "private" });
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
