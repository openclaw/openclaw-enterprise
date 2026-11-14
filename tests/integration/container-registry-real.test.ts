import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import Type from "typebox";
import { Check } from "typebox/value";
import { registryImage } from "../../scripts/ci/fixture-support-images.mjs";
import { commandPath, writeCommand } from "../helpers/fake-commands.ts";

const indexMediaType = "application/vnd.oci.image.index.v1+json";
const manifestMediaType = "application/vnd.oci.image.manifest.v1+json";
const configMediaType = "application/vnd.oci.image.config.v1+json";
const architectures = ["amd64", "arm64"] as const;
const platforms = ["linux/amd64", "linux/arm64"];
const digestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const indexSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  mediaType: Type.Literal(indexMediaType),
  manifests: Type.Array(
    Type.Object({
      mediaType: Type.Literal(manifestMediaType),
      digest: digestSchema,
      platform: Type.Object({ os: Type.String(), architecture: Type.String() }),
    }),
  ),
});
const manifestSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  mediaType: Type.Literal(manifestMediaType),
  config: Type.Object({ mediaType: Type.Literal(configMediaType), digest: digestSchema }),
});
const configSchema = Type.Object({ os: Type.String(), architecture: Type.String() });
const packagingSuiteSchema = Type.Object({
  prepare: Type.Object({
    defaultEnv: Type.Object({
      NODE_BASE_IMAGE: Type.String({ pattern: "^[^\\s]+@sha256:[a-f0-9]{64}$" }),
    }),
  }),
});

type Image = "controller" | "runtime";
type Archive = { path: string; digest: string };
type Publication = { repo: string; sourceTag: string; oldDigest: string; currentDigest: string };
type Scratch = { directory: string; registryLabel?: string };

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function cleanupScratch(t: TestContext, { directory, registryLabel }: Scratch) {
  const failures: unknown[] = [];
  if (registryLabel !== undefined) {
    try {
      // Docker may have started the registry even if its client lost the response.
      const dockerOptions = { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" } as const;
      const id = execFileSync(
        "docker",
        ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${registryLabel}`],
        dockerOptions,
      ).trim();
      if (id) {
        assert.match(id, /^[a-f0-9]{64}$/);
        execFileSync("docker", ["rm", "-f", id], { ...dockerOptions, stdio: "pipe" });
      }
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  // Node preserves the test body's error if an after hook also throws.
  for (const error of failures) {
    t.diagnostic(`Registry cleanup failed: ${String(error)}`);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Registry container and scratch cleanup failed", {
      cause: failures[0],
    });
  }
}

// Scratch OCI archives contain real, distinct amd64 and arm64 manifests.
async function buildArchive(
  directory: string,
  image: Image,
  revision: "old" | "current",
): Promise<Archive> {
  const root = join(directory, `${image}-${revision}`);
  const blobs = join(root, "blobs", "sha256");
  await mkdir(blobs, { recursive: true });

  async function blob(value: object, mediaType: string) {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = sha256(bytes);
    await writeFile(join(blobs, digest.slice(7)), bytes);
    return { mediaType, digest, size: bytes.length };
  }

  const manifests = [];
  for (const architecture of architectures) {
    const config = await blob(
      {
        architecture,
        os: "linux",
        config: { Labels: { image, revision } },
        rootfs: { type: "layers", diff_ids: [] },
      },
      configMediaType,
    );
    const manifest = await blob(
      { schemaVersion: 2, mediaType: manifestMediaType, config, layers: [] },
      manifestMediaType,
    );
    manifests.push({ ...manifest, platform: { os: "linux", architecture } });
  }
  const index = await blob(
    { schemaVersion: 2, mediaType: indexMediaType, manifests },
    indexMediaType,
  );
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({ schemaVersion: 2, mediaType: indexMediaType, manifests: [index] }),
  );
  await writeFile(join(root, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  const path = join(root, "image.tar");
  execFileSync("tar", ["-cf", path, "-C", root, "blobs", "index.json", "oci-layout"]);
  return { path, digest: index.digest };
}

async function inspectTag(registry: string, repo: string, tag: string, expected: string) {
  const url = `${registry}/v2/${repo}`;
  async function readBlob(path: string, digest: string, mediaType: string): Promise<unknown> {
    const response = await fetch(`${url}/${path}`, { headers: { Accept: mediaType } });
    assert.equal(response.status, 200, `Registry GET ${repo}/${path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(bytes), digest, `Registry digest for ${repo}/${path}`);
    return JSON.parse(bytes.toString("utf8"));
  }

  // Read and hash the registry's bytes independently of the publication command's checks.
  const index = await readBlob(`manifests/${tag}`, expected, indexMediaType);
  assert.ok(Check(indexSchema, index), `Invalid OCI index for ${repo}:${tag}`);
  assert.deepEqual(
    index.manifests.map(({ platform }) => `${platform.os}/${platform.architecture}`).sort(),
    platforms,
  );
  for (const descriptor of index.manifests) {
    const manifest = await readBlob(
      `manifests/${descriptor.digest}`,
      descriptor.digest,
      descriptor.mediaType,
    );
    assert.ok(Check(manifestSchema, manifest), `Invalid OCI manifest ${descriptor.digest}`);
    const config = await readBlob(
      `blobs/${manifest.config.digest}`,
      manifest.config.digest,
      manifest.config.mediaType,
    );
    assert.ok(Check(configSchema, config), `Invalid OCI config ${manifest.config.digest}`);
    assert.equal(config.os, descriptor.platform.os);
    assert.equal(config.architecture, descriptor.platform.architecture);
  }
}

test(
  "publication updates aliases using real Skopeo and a multi-platform registry",
  { skip: process.env.OCC_TEST_CONTAINER_REGISTRY !== "1" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-registry-test-"));
    const name = `oce-registry-test-${randomUUID()}`;
    const scratch: Scratch = { directory };
    t.after(() => cleanupScratch(t, scratch));
    const policy = join(directory, "policy.json");
    await writeFile(
      policy,
      JSON.stringify({
        default: [{ type: "reject" }],
        transports: { "oci-archive": { "": [{ type: "insecureAcceptAnything" }] } },
      }),
    );
    const skopeo = execFileSync("which", ["skopeo"], { encoding: "utf8" }).trim();
    assert.ok(isAbsolute(skopeo), "Expected an absolute Skopeo executable path");
    assert.match(
      execFileSync(skopeo, ["--version"], { encoding: "utf8" }),
      /^skopeo version 1\.13\.3/,
    );
    scratch.registryLabel = `oce.registry-test=${name}`;
    const container = execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
        "--label",
        scratch.registryLabel,
        "--publish",
        "127.0.0.1::5000",
        registryImage,
      ],
      { encoding: "utf8" },
    ).trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    const address = execFileSync("docker", ["port", container, "5000/tcp"], {
      encoding: "utf8",
    }).trim();
    assert.match(address, /^127\.0\.0\.1:[0-9]+$/);
    const registry = `http://${address}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(`${registry}/v2/`);
        assert.equal(response.status, 200);
        break;
      } catch (error) {
        if (attempt === 39) {
          throw error;
        }
        await setTimeout(250);
      }
    }

    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.match(sourceSha, /^[a-f0-9]{40}$/);
    const suite: unknown = JSON.parse(
      await readFile("scripts/ci/test-suites/images-packaging.json", "utf8"),
    );
    assert.ok(
      Check(packagingSuiteSchema, suite),
      "Expected a pinned Images and Packaging Node base",
    );
    const nodeBaseImage = suite.prepare.defaultEnv.NODE_BASE_IMAGE;
    const records: Publication[] = [];
    for (const image of ["controller", "runtime"] as const) {
      const old = await buildArchive(directory, image, "old");
      const current = await buildArchive(directory, image, "current");
      const repo = `openclaw/enterprise-${image}`;
      const sourceTag = `sha-${sourceSha}`;
      const prepared = join(directory, `container-${image}-123-1`);
      await mkdir(prepared);
      const archiveBytes = await readFile(current.path);
      await writeFile(join(prepared, "image.tar"), archiveBytes);
      await writeFile(
        join(prepared, "metadata.json"),
        JSON.stringify({
          sourceSha,
          workflowSha: sourceSha,
          runId: "123",
          attempt: "1",
          ciRunId: "456",
          ciAttempt: "1",
          nodeBaseImage,
          image,
          platforms,
          digest: current.digest,
          archiveSha256: sha256(archiveBytes).slice(7),
        }),
      );
      // Seed actual registry tags so publishing must replace an existing alias.
      for (const [entry, tag] of [
        [old, "latest"],
        [old, "candidate"],
        [current, sourceTag],
      ] as const) {
        execFileSync(
          skopeo,
          [
            "--policy",
            policy,
            "copy",
            "--all",
            "--preserve-digests",
            "--dest-tls-verify=false",
            `oci-archive:${entry.path}`,
            `docker://${address}/${repo}:${tag}`,
          ],
          { stdio: "pipe" },
        );
      }
      records.push({ repo, sourceTag, oldDigest: old.digest, currentDigest: current.digest });
    }

    // The adapter changes only the registry address and local HTTP transport.
    // Actual Skopeo performs login, index transfers and remote inspection.
    const wrapperDir = join(directory, "bin");
    await mkdir(wrapperDir);
    await writeCommand(
      wrapperDir,
      "skopeo",
      `import { spawnSync } from "node:child_process";
const address = ${JSON.stringify(address)};
const args = process.argv.slice(2).map((arg) =>
  arg.replaceAll("ghcr.io/openclaw/", address + "/openclaw/").replace(/^ghcr\\.io$/, address),
);
if (args[0] === "copy") {
  args.splice(1, 0, "--dest-tls-verify=false");
}
if (args[0] === "inspect" || args[0] === "login") {
  args.splice(1, 0, "--tls-verify=false");
}
const result = spawnSync(${JSON.stringify(skopeo)}, [
  "--policy", ${JSON.stringify(policy)}, ...args,
], { stdio: "inherit" });
if (result.error) {
  throw result.error;
}
if (result.status === null) {
  throw new Error("Skopeo terminated by " + result.signal);
}
process.exit(result.status);
`,
      { interpreter: process.execPath },
    );
    const preload = join(directory, "github-fixture.mjs");
    await writeFile(
      preload,
      `
const repo = { full_name: "openclaw/openclaw-enterprise", private: false, default_branch: "main" };
const sha = ${JSON.stringify(sourceSha)};
globalThis.fetch = async (url) => {
  const { origin, pathname: path } = new URL(url);
  if (origin !== "https://api.github.com") {
    throw new Error("Unexpected metadata origin " + origin);
  }
  if (path === "/repos/openclaw/openclaw-enterprise") return Response.json(repo);
  if (path.includes("/compare/")) return Response.json({ status: "identical" });
  if (path.endsWith("/workflows/ci.yml")) return Response.json({ id: 1, path: ".github/workflows/ci.yml", state: "active" });
  if (path.endsWith("/runs/456")) return Response.json({ id: 456, workflow_id: 1, path: ".github/workflows/ci.yml", repository: repo, head_repository: repo, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", run_attempt: 1 });
  if (path.endsWith("/runs/456/attempts/1/jobs")) return Response.json({ jobs: [{ name: "CI Required", head_sha: sha, conclusion: "success", status: "completed" }] });
  if (path.endsWith("/environments/container-publish")) return Response.json({ name: "container-publish", can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } });
  if (path.endsWith("/deployment-branch-policies")) return Response.json({ branch_policies: [{ name: "main", type: "branch" }] });
  if (path.endsWith("/versions")) return Response.json([]);
  if (path.includes("/packages/container/")) return Response.json({ name: path.split("/").at(-1), package_type: "container", visibility: "public" });
  throw new Error("Unexpected metadata request " + path);
};\n`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: commandPath(wrapperDir),
      GH_TOKEN: "test-token",
      GITHUB_ACTOR: "test",
      GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF:
        "openclaw/openclaw-enterprise/.github/workflows/container-publish.yml@refs/heads/main",
      GITHUB_WORKFLOW_SHA: sourceSha,
      GITHUB_SHA: sourceSha,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_STEP_SUMMARY: join(directory, "summary"),
      SOURCE_SHA: sourceSha,
      CI_RUN_ID: "456",
      CI_ATTEMPT: "1",
      NODE_BASE_IMAGE: nodeBaseImage,
      GHCR_CONTROLLER_IMAGE: "ghcr.io/openclaw/enterprise-controller",
      GHCR_RUNTIME_IMAGE: "ghcr.io/openclaw/enterprise-runtime",
      PUBLISH: "true",
    };

    // Use the real registry name so Skopeo's unmodified diagnostic reaches the classifier.
    const record = records[0];
    assert.ok(record, "Expected a seeded controller repository");
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import assert from "node:assert/strict";
import { remoteTagDigest } from "./scripts/ci/container-release.mjs";
const image = ${JSON.stringify(`${address}/${record.repo}`)};
assert.equal(remoteTagDigest(image, "absent", undefined, false), null);
assert.throws(() => remoteTagDigest(image, "absent", undefined, true), { status: 1 });
assert.equal(remoteTagDigest(image, ${JSON.stringify(record.sourceTag)}, undefined, false), ${JSON.stringify(record.currentDigest)});
`,
      ],
      { env, stdio: "pipe" },
    );

    function publish(tag: string) {
      execFileSync(
        process.execPath,
        ["--import", preload, "scripts/ci/container-release.mjs", "publish", directory],
        { env: { ...env, IMAGE_TAG: tag }, stdio: "pipe" },
      );
    }
    publish("");
    for (const record of records) {
      await inspectTag(registry, record.repo, "latest", record.currentDigest);
      await inspectTag(registry, record.repo, record.sourceTag, record.currentDigest);
      await inspectTag(registry, record.repo, "candidate", record.oldDigest);
    }
    publish("candidate");
    for (const record of records) {
      await inspectTag(registry, record.repo, "candidate", record.currentDigest);
      await inspectTag(registry, record.repo, "latest", record.currentDigest);
      await inspectTag(registry, record.repo, record.sourceTag, record.currentDigest);
    }
  },
);
