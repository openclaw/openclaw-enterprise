import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTestSuites } from "./test-suites.mjs";
import { prepareRuntimeImageSmoke } from "./prepare.mjs";

export const repository = "openclaw/openclaw-enterprise";
export const publishWorkflow = ".github/workflows/container-publish.yml";
const images = ["controller", "runtime"];
const platforms = ["linux/amd64", "linux/arm64"];
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const integerPattern = /^[1-9][0-9]*$/;

export function validateContext(env, repo, workflow = publishWorkflow) {
  assert.equal(env.GITHUB_REPOSITORY, repository, "Only the Enterprise repository may publish.");
  assert.equal(repo.full_name, repository);
  assert.equal(typeof repo.private, "boolean", "Repository privacy must be a boolean.");
  if (workflow !== publishWorkflow || env.PUBLISH !== "false") {
    assert.equal(repo.private, false, "Publication requires the public Enterprise repository.");
  }
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
  if (attempt !== undefined) {
    assert.equal(String(run.run_attempt), String(attempt));
  }
  const required = jobs.filter((job) => job.name === "CI Required");
  assert.equal(required.length, 1, "Exactly one CI Required aggregate job is required.");
  assert.equal(required[0].conclusion, "success");
  assert.equal(required[0].status, "completed");
  assert.equal(required[0].head_sha, sourceSha);
}

export function validateEnvironment(environment, policies) {
  assert.equal(environment.name, "container-publish");
  assert.equal(environment.can_admins_bypass, false, "Disable administrator environment bypass.");
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

export function validatePackage(
  pkg,
  image,
  { allowMissingRepository = false, allowPrivateBootstrap = false } = {},
) {
  assert.equal(pkg.name, ghcrPackageName(image));
  assert.equal(pkg.package_type, "container");
  // GHCR creates marker packages privately; only bootstrap may accept that state.
  const visibility = allowPrivateBootstrap ? ["public", "private"] : ["public"];
  assert.ok(visibility.includes(pkg.visibility), "GHCR package must already exist and be public.");
  // GitHub's package schema makes repository nullable and optional. Absence
  // cannot establish linkage; callers may accept the setup-time package grant.
  // Explicit conflicting metadata always fails.
  if (pkg.repository == null && allowMissingRepository) {
    return false;
  }
  assert.equal(pkg.repository?.full_name, repository, "Link the package to Enterprise first.");
  assert.equal(pkg.repository?.private, false);
  return true;
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
  assert.deepEqual(metadata.platforms, platforms);
  assert.match(metadata.digest ?? "", digestPattern);
  assert.match(metadata.archiveSha256 ?? "", /^[a-f0-9]{64}$/);
}

export async function github(path, { allowNotFound = false, retryNotFound = false } = {}) {
  assert.ok(process.env.GH_TOKEN, "A GitHub workflow token is required.");
  const attempts = retryNotFound ? 6 : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    let body;
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
    return JSON.parse(body);
  }
}

export async function githubPages(path, field) {
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const data = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const entries = field ? data[field] : data;
    assert.ok(Array.isArray(entries), "Invalid GitHub pagination response.");
    result.push(...entries);
    if (entries.length < 100) {
      return result;
    }
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

function publicationAlias(value) {
  const tag = value || "latest";
  assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, "Invalid image tag.");
  assert.ok(!/^(?:sha|bootstrap)-/i.test(tag), "Source and bootstrap tags are reserved.");
  return tag;
}

async function validate(env) {
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
  const testedBase = suites.lanes["images-packaging"].prepare.defaultEnv.NODE_BASE_IMAGE;
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
    platforms,
  };
}

export async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
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

export function remoteTagDigest(image, tag, authfile, listed) {
  try {
    return inspectDigest(`docker://${image}:${tag}`, authfile);
  } catch (error) {
    // Skopeo 1.13.3 reports the registry's MANIFEST_UNKNOWN as this terminal
    // diagnostic. Auth, transport, name and ambiguous failures must not copy.
    const missing = `reading manifest ${tag} in ${image}: manifest unknown`;
    const diagnostic = error.stderr?.toString().trim().replace(/"$/, "");
    if (
      listed ||
      error.status !== 1 ||
      (diagnostic !== missing &&
        !diagnostic?.endsWith(`: ${missing}`) &&
        !diagnostic?.endsWith(`${missing}: manifest unknown`))
    ) {
      throw error;
    }
    return null;
  }
}

// Read the exact blobs named by the OCI index, never an extracted checkout path.
// Hash verification binds platform/config claims to the index's immutable digest.
export function readArchivePlatforms(archive, indexDigest) {
  function blob(digest) {
    assert.match(digest ?? "", digestPattern);
    const bytes = execFileSync("tar", ["-xOf", archive, `blobs/sha256/${digest.slice(7)}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, digest);
    return JSON.parse(bytes);
  }
  const index = blob(indexDigest);
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.mediaType, "application/vnd.oci.image.index.v1+json");
  assert.ok(Array.isArray(index.manifests));
  const selected = index.manifests
    .map((descriptor) => {
      assert.equal(descriptor.mediaType, "application/vnd.oci.image.manifest.v1+json");
      const platform = `${descriptor.platform?.os}/${descriptor.platform?.architecture}`;
      assert.ok(platforms.includes(platform), `Unexpected image platform: ${platform}`);
      assert.ok(
        descriptor.platform.variant === undefined ||
          (platform === "linux/arm64" && descriptor.platform.variant === "v8"),
        "Unsupported platform variant.",
      );
      const manifest = blob(descriptor.digest);
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.mediaType, descriptor.mediaType);
      const config = blob(manifest.config?.digest);
      assert.equal(`${config.os}/${config.architecture}`, platform, "Config platform mismatch.");
      return { platform, digest: descriptor.digest, configDigest: manifest.config.digest };
    })
    .sort((left, right) => left.platform.localeCompare(right.platform));
  assert.deepEqual(
    selected.map((image) => image.platform),
    platforms,
  );
  return selected;
}

// Assemble the exact exports that passed startup tests on their native runners.
// Hard links let assembly share those bytes until the final archive is written.
async function assemble(directory, env) {
  const combined = join(directory, "combined");
  await mkdir(combined);
  await mkdir(join(combined, "blobs/sha256"), { recursive: true });
  const retained = new Set();
  const manifests = [];
  for (const arch of ["amd64", "arm64"]) {
    const layout = join(directory, arch);
    const receipt = JSON.parse(await readFile(join(layout, "platform.json"), "utf8"));
    for (const [key, value] of Object.entries(identity(env, env.IMAGE))) {
      assert.deepEqual(receipt[key], value, `Platform receipt ${key} mismatch.`);
    }
    assert.equal(receipt.platform, `linux/${arch}`, "Platform receipt architecture mismatch.");
    assert.equal(receipt.native, true, "Platform must pass smoke on its native runner.");
    async function retain(descriptor) {
      assert.match(descriptor.digest ?? "", digestPattern);
      const path = join(layout, "blobs/sha256", descriptor.digest.slice(7));
      const info = await lstat(path);
      assert.ok(info.isFile(), "OCI blob must be a regular file.");
      assert.equal(info.size, descriptor.size, "OCI blob size mismatch.");
      assert.equal(
        `sha256:${await fileDigest(path)}`,
        descriptor.digest,
        "OCI blob digest mismatch.",
      );
      if (!retained.has(descriptor.digest)) {
        await link(path, join(combined, "blobs/sha256", descriptor.digest.slice(7)));
        retained.add(descriptor.digest);
      }
      return path;
    }
    const root = JSON.parse(await readFile(join(layout, "index.json"), "utf8"));
    assert.equal(root.schemaVersion, 2);
    assert.equal(root.manifests.length, 1, "Expected exactly one exported platform.");
    let descriptor = root.manifests[0];
    assert.equal(descriptor.digest, receipt.digest, "Build output digest mismatch.");
    if (descriptor.mediaType === "application/vnd.oci.image.index.v1+json") {
      const index = JSON.parse(await readFile(await retain(descriptor), "utf8"));
      assert.equal(index.schemaVersion, 2);
      assert.equal(index.manifests.length, 1, "Expected exactly one platform manifest.");
      descriptor = index.manifests[0];
    }
    assert.equal(descriptor.mediaType, "application/vnd.oci.image.manifest.v1+json");
    const manifest = JSON.parse(await readFile(await retain(descriptor), "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.mediaType, descriptor.mediaType);
    const config = JSON.parse(await readFile(await retain(manifest.config), "utf8"));
    assert.equal(config.os, "linux");
    assert.equal(config.architecture, arch, "Exported platform configuration mismatch.");
    if (descriptor.platform) {
      assert.equal(descriptor.platform.os, config.os);
      assert.equal(descriptor.platform.architecture, config.architecture);
      assert.ok(
        descriptor.platform.variant === undefined ||
          (arch === "arm64" && descriptor.platform.variant === "v8"),
      );
    }
    for (const layer of manifest.layers) {
      await retain(layer);
    }
    // BuildKit's one-platform index may add exporter annotations such as the
    // current build time. They do not describe the tested manifest bytes and
    // must not make the assembled image identity depend on the workflow run.
    manifests.push({
      mediaType: descriptor.mediaType,
      digest: descriptor.digest,
      size: descriptor.size,
      platform: { os: "linux", architecture: arch },
    });
  }
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests,
  };
  const bytes = JSON.stringify(index);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await writeFile(join(combined, "blobs/sha256", digest.slice(7)), bytes);
  await writeFile(
    join(combined, "index.json"),
    JSON.stringify({
      ...index,
      manifests: [{ mediaType: index.mediaType, digest, size: Buffer.byteLength(bytes) }],
    }),
  );
  await writeFile(join(combined, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  const archive = join(directory, "image.tar");
  execFileSync("tar", ["-cf", archive, "-C", combined, "blobs", "index.json", "oci-layout"]);
  readArchivePlatforms(archive, digest);
  for (const path of ["amd64", "arm64", "combined"]) {
    await rm(join(directory, path), { recursive: true });
  }
  await appendFile(env.GITHUB_OUTPUT, `digest=${digest}\n`);
}

async function smoke(directory, env) {
  assert.ok(images.includes(env.IMAGE));
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  assert.ok(["amd64", "arm64"].includes(arch));
  assert.equal(env.PLATFORM, `linux/${arch}`, "Smoke requires the target's native runner.");
  assert.equal(inspectDigest(`oci:${directory}`), env.IMAGE_DIGEST);
  const root = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
  assert.equal(root.manifests.length, 1);
  let descriptor = root.manifests[0];
  async function blob(entry) {
    assert.match(entry.digest ?? "", digestPattern);
    const bytes = await readFile(join(directory, "blobs/sha256", entry.digest.slice(7)));
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.digest);
    return JSON.parse(bytes);
  }
  assert.equal(descriptor.digest, env.IMAGE_DIGEST);
  let manifest = await blob(descriptor);
  if (descriptor.mediaType === "application/vnd.oci.image.index.v1+json") {
    assert.equal(manifest.manifests.length, 1);
    descriptor = manifest.manifests[0];
    manifest = await blob(descriptor);
  }
  assert.equal(manifest.mediaType, "application/vnd.oci.image.manifest.v1+json");
  const tag = `localhost/enterprise-${env.IMAGE}:prepared-${arch}`;
  skopeo(["copy", `oci:${directory}`, `docker-daemon:${tag}`], { stdio: "inherit" });
  let prepared;
  try {
    const [loaded] = JSON.parse(execFileSync("docker", ["image", "inspect", tag]));
    assert.equal(loaded.Id, manifest.config.digest);
    assert.equal(loaded.Os, "linux");
    assert.equal(loaded.Architecture, arch);
    if (env.IMAGE === "runtime") {
      prepared = await prepareRuntimeImageSmoke({
        image: loaded.Id,
        statePath: join(env.RUNNER_TEMP ?? tmpdir(), `runtime-smoke-${arch}.json`),
      });
    }
    console.log(`Smoke ${env.IMAGE} ${env.PLATFORM} @ ${descriptor.digest}`);
    // CI runs the runtime startup tests in two lanes; the release smoke runs
    // both files, one at a time as in CI, since some cases measure timing.
    execFileSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        ...(env.IMAGE === "controller"
          ? ["tests/integration/production-image-startup.test.mjs"]
          : [
              "tests/integration/runtime-image-startup.test.mjs",
              "tests/integration/runtime-image-startup-probe.test.mjs",
            ]),
      ],
      {
        env: {
          ...env,
          ...prepared?.env,
          OCC_TEST_IMAGE_TIMEOUT_MULTIPLIER: "1",
          [env.IMAGE === "controller" ? "OCC_TEST_PRODUCTION_IMAGE" : "OCC_TEST_RUNTIME_IMAGE"]:
            loaded.Id,
        },
        stdio: "inherit",
      },
    );
    assert.equal(inspectDigest(`oci:${directory}`), env.IMAGE_DIGEST);
    await writeFile(
      join(directory, "platform.json"),
      `${JSON.stringify(
        {
          ...identity(env, env.IMAGE),
          platform: env.PLATFORM,
          digest: env.IMAGE_DIGEST,
          native: true,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    try {
      await prepared?.cleanup();
    } finally {
      execFileSync("docker", ["image", "rm", tag], { stdio: "inherit" });
    }
  }
}

async function seal(directory, env) {
  assert.match(env.IMAGE_DIGEST ?? "", digestPattern);
  readArchivePlatforms(join(directory, "image.tar"), env.IMAGE_DIGEST);
  const metadata = {
    ...identity(env, env.IMAGE),
    digest: env.IMAGE_DIGEST,
    archiveSha256: await fileDigest(join(directory, "image.tar")),
  };
  await writeFile(join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function verifyGhcr(image, digest, tag) {
  const packagePath = `orgs/openclaw/packages/container/${encodeURIComponent(ghcrPackageName(image))}`;
  // The manual dispatch authorizes publication. GHCR may omit repository
  // metadata; explicit conflicting linkage still fails package validation.
  validatePackage(await github(packagePath), image, { allowMissingRepository: true });
  const versions = await githubPages(`${packagePath}/versions`);
  const existing = versions.filter((version) => version.metadata?.container?.tags?.includes(tag));
  assert.ok(
    existing.every((version) => version.name === digest),
    "Refusing to overwrite an existing source tag with different image bytes.",
  );
  return existing.length > 0;
}

export async function publishPrepared(directory, env, producer, verify, aliasTag) {
  await verify();
  const tag = `sha-${env.SOURCE_SHA}`;
  const prepared = [];
  for (const image of images) {
    const dir = join(directory, `container-${image}-${producer.runId}-${producer.attempt}`);
    const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8"));
    validatePreparedImage(metadata, { ...producer, image });
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
      // Source, CI and visibility may change while large images are being copied.
      await verify();
      const listed = await verifyGhcr(image.destination, image.digest, tag);
      const remoteDigest = remoteTagDigest(image.destination, tag, authfile, listed);
      if (remoteDigest !== null) {
        assert.equal(remoteDigest, image.digest, "Remote source tag has different image bytes.");
      } else {
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
      }
      assert.equal(inspectDigest(`docker://${image.destination}:${tag}`, authfile), image.digest);
      console.log(
        `Verified ${image.destination}:${tag} @ ${image.digest}${remoteDigest ? " (already published)" : ""}`,
      );
    }
    if (aliasTag !== undefined) {
      // Both immutable tags must be verified before either mutable alias moves.
      for (const image of prepared) {
        await verify();
        await verifyGhcr(image.destination, image.digest, tag);
        assert.equal(inspectDigest(`docker://${image.destination}:${tag}`, authfile), image.digest);
        skopeo(
          [
            "copy",
            "--all",
            "--preserve-digests",
            "--authfile",
            authfile,
            `oci-archive:${image.archive}`,
            `docker://${image.destination}:${aliasTag}`,
          ],
          { stdio: "inherit" },
        );
        assert.equal(
          inspectDigest(`docker://${image.destination}:${aliasTag}`, authfile),
          image.digest,
        );
      }
      // A second check catches drift while the other package was being copied.
      for (const image of prepared) {
        assert.equal(inspectDigest(`docker://${image.destination}:${tag}`, authfile), image.digest);
        assert.equal(
          inspectDigest(`docker://${image.destination}:${aliasTag}`, authfile),
          image.digest,
        );
        console.log(`Verified ${image.destination}:${aliasTag} @ ${image.digest}`);
      }
    }
  } finally {
    await rm(authDirectory, { recursive: true, force: true });
  }
  const receipt = prepared.map(({ archive, ...image }) => ({
    ...image,
    tag,
    ...(aliasTag === undefined ? {} : { aliasTag }),
  }));
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    receipt
      .map(
        (image) =>
          `- ${image.image}: \`${image.destination}@${image.digest}\`${aliasTag ? ` (tag: \`${aliasTag}\`)` : ""}\n`,
      )
      .join(""),
  );
  return receipt;
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  if (command === "validate") {
    const attempt = await validate(process.env);
    await appendFile(process.env.GITHUB_OUTPUT, `ci_attempt=${attempt}\n`);
  } else if (command === "assemble") {
    await assemble(directory, process.env);
  } else if (command === "smoke") {
    await smoke(directory, process.env);
  } else if (command === "seal") {
    await seal(directory, process.env);
  } else if (command === "publish") {
    assert.equal(process.env.PUBLISH, "true");
    const receipt = await publishPrepared(
      directory,
      process.env,
      identity(process.env, "controller"),
      () => validate(process.env),
      publicationAlias(process.env.IMAGE_TAG),
    );
    await writeFile(join(directory, "publication.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    throw new Error("Expected validate, assemble, smoke, seal, or publish.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
