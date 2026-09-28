import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const registryImage =
  "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test(
  "publication updates aliases using real Skopeo and a multi-platform registry",
  { skip: process.env.OCC_TEST_CONTAINER_REGISTRY !== "1" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-registry-test-"));
    const name = `oce-registry-test-${randomUUID()}`;
    let container;
    t.after(async () => {
      if (container) {
        execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      }
      await rm(directory, { recursive: true, force: true });
    });
    const policy = join(directory, "policy.json");
    await writeFile(
      policy,
      JSON.stringify({
        default: [{ type: "reject" }],
        transports: { "oci-archive": { "": [{ type: "insecureAcceptAnything" }] } },
      }),
    );
    const skopeo = execFileSync("which", ["skopeo"], { encoding: "utf8" }).trim();
    assert.match(
      execFileSync(skopeo, ["--version"], { encoding: "utf8" }),
      /^skopeo version 1\.13\.3/,
    );
    container = execFileSync(
      "docker",
      ["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5000", registryImage],
      { encoding: "utf8" },
    ).trim();
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
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // Scratch OCI archives contain real, distinct amd64 and arm64 manifests.
    async function archive(image, revision) {
      const root = join(directory, `${image}-${revision}`);
      await mkdir(join(root, "blobs/sha256"), { recursive: true });
      async function blob(value, mediaType) {
        const bytes = Buffer.from(JSON.stringify(value));
        const digest = sha256(bytes);
        await writeFile(join(root, "blobs/sha256", digest.slice(7)), bytes);
        return { mediaType, digest, size: bytes.length };
      }
      const manifests = [];
      for (const architecture of ["amd64", "arm64"]) {
        const config = await blob(
          {
            architecture,
            os: "linux",
            config: { Labels: { image, revision } },
            rootfs: { type: "layers", diff_ids: [] },
          },
          "application/vnd.oci.image.config.v1+json",
        );
        const manifest = await blob(
          {
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            config,
            layers: [],
          },
          "application/vnd.oci.image.manifest.v1+json",
        );
        manifests.push({ ...manifest, platform: { os: "linux", architecture } });
      }
      const index = await blob(
        { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests },
        "application/vnd.oci.image.index.v1+json",
      );
      await writeFile(
        join(root, "index.json"),
        JSON.stringify({ schemaVersion: 2, mediaType: index.mediaType, manifests: [index] }),
      );
      await writeFile(join(root, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
      const path = join(root, "image.tar");
      execFileSync("tar", ["-cf", path, "-C", root, "blobs", "index.json", "oci-layout"]);
      return { path, digest: index.digest };
    }

    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const nodeBaseImage = JSON.parse(
      await readFile("scripts/ci/test-suites/images-packaging.json", "utf8"),
    ).prepare.defaultEnv.NODE_BASE_IMAGE;
    const records = [];
    for (const image of ["controller", "runtime"]) {
      const old = await archive(image, "old");
      const current = await archive(image, "current");
      const repo = `openclaw/enterprise-${image}`;
      const sourceTag = `sha-${sourceSha}`;
      const prepared = join(directory, `container-${image}-123-1`);
      await mkdir(prepared);
      await writeFile(join(prepared, "image.tar"), await readFile(current.path));
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
          platforms: ["linux/amd64", "linux/arm64"],
          digest: current.digest,
          archiveSha256: sha256(await readFile(current.path)).slice(7),
        }),
      );
      // Seed actual registry tags so publishing must replace an existing alias.
      for (const [entry, tag] of [
        [old, "latest"],
        [old, "candidate"],
        [current, sourceTag],
      ]) {
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
      records.push({ image, repo, sourceTag, old, current });
    }

    // The adapter changes only the registry address and local HTTP transport.
    // Actual Skopeo performs login, index transfers and remote inspection.
    const wrapperDir = join(directory, "bin");
    await mkdir(wrapperDir);
    await writeFile(
      join(wrapperDir, "skopeo"),
      `#!${process.execPath}\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2).map((arg) => arg.replaceAll("ghcr.io/openclaw/", ${JSON.stringify(`${address}/openclaw/`)}).replace(/^ghcr\\.io$/, ${JSON.stringify(address)}));\nif (args[0] === "copy") args.splice(1, 0, "--dest-tls-verify=false");\nif (args[0] === "inspect" || args[0] === "login") args.splice(1, 0, "--tls-verify=false");\nconst result = spawnSync(${JSON.stringify(skopeo)}, ["--policy", ${JSON.stringify(policy)}, ...args], { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
      { mode: 0o755 },
    );
    const preload = join(directory, "github-fixture.mjs");
    await writeFile(
      preload,
      `
const repo = { full_name: "openclaw/openclaw-enterprise", private: true, default_branch: "main" };
const sha = ${JSON.stringify(sourceSha)};
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path === "/repos/openclaw/openclaw-enterprise") return Response.json(repo);
  if (path.includes("/compare/")) return Response.json({ status: "identical" });
  if (path.endsWith("/workflows/ci.yml")) return Response.json({ id: 1, path: ".github/workflows/ci.yml", state: "active" });
  if (path.endsWith("/runs/456")) return Response.json({ id: 456, workflow_id: 1, path: ".github/workflows/ci.yml", repository: repo, head_repository: repo, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", run_attempt: 1 });
  if (path.endsWith("/runs/456/attempts/1/jobs")) return Response.json({ jobs: [{ name: "CI Required", head_sha: sha, conclusion: "success", status: "completed" }] });
  if (path.endsWith("/environments/container-publish")) return Response.json({ name: "container-publish", can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } });
  if (path.endsWith("/deployment-branch-policies")) return Response.json({ branch_policies: [{ name: "main", type: "branch" }] });
  if (path.endsWith("/versions")) return Response.json([]);
  if (path.includes("/packages/container/")) return Response.json({ name: path.split("/").at(-1), package_type: "container", visibility: "private" });
  throw new Error("Unexpected metadata request " + path);
};\n`,
    );
    const env = {
      ...process.env,
      PATH: `${wrapperDir}:${process.env.PATH}`,
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

    async function inspect(record, tag, expected) {
      const response = await fetch(`${registry}/v2/${record.repo}/manifests/${tag}`, {
        headers: { Accept: "application/vnd.oci.image.index.v1+json" },
      });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(bytes), expected);
      const index = JSON.parse(bytes);
      assert.deepEqual(
        index.manifests.map(({ platform }) => `${platform.os}/${platform.architecture}`).sort(),
        ["linux/amd64", "linux/arm64"],
      );
      for (const manifest of index.manifests) {
        const child = await fetch(`${registry}/v2/${record.repo}/manifests/${manifest.digest}`, {
          headers: { Accept: manifest.mediaType },
        });
        assert.equal(child.status, 200);
        const childBytes = Buffer.from(await child.arrayBuffer());
        assert.equal(sha256(childBytes), manifest.digest);
        const config = JSON.parse(childBytes).config;
        const blob = await fetch(`${registry}/v2/${record.repo}/blobs/${config.digest}`);
        assert.equal(blob.status, 200);
        const configBytes = Buffer.from(await blob.arrayBuffer());
        assert.equal(sha256(configBytes), config.digest);
        assert.equal(JSON.parse(configBytes).architecture, manifest.platform.architecture);
      }
    }
    function publish(tag) {
      execFileSync(
        process.execPath,
        ["--import", preload, "scripts/ci/container-release.mjs", "publish", directory],
        { env: { ...env, IMAGE_TAG: tag }, stdio: "pipe" },
      );
    }
    publish("");
    for (const record of records) {
      await inspect(record, "latest", record.current.digest);
      await inspect(record, record.sourceTag, record.current.digest);
      await inspect(record, "candidate", record.old.digest);
    }
    publish("candidate");
    for (const record of records) {
      await inspect(record, "candidate", record.current.digest);
      await inspect(record, "latest", record.current.digest);
      await inspect(record, record.sourceTag, record.current.digest);
    }
  },
);
