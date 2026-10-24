import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  github,
  githubPages,
  repository,
  verifyCi,
  verifyEnvironment,
} from "./container-release.mjs";

const workflow = ".github/workflows/cli-release.yml";
const platforms = [
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["linux", "amd64"],
  ["linux", "arm64"],
];
const sourcePattern = /^[a-f0-9]{40}$/u;
const nativeArch = process.arch === "x64" ? "amd64" : process.arch;

async function releaseVersion() {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  const chart = await readFile("deploy/helm/openclaw-enterprise/Chart.yaml", "utf8");
  assert.match(chart, new RegExp(`^version: ${version.replaceAll(".", "\\.")}$`, "mu"));
  assert.match(chart, new RegExp(`^appVersion: "${version.replaceAll(".", "\\.")}"$`, "mu"));
  return `v${version}`;
}

function assetName(version, os, arch) {
  return `occ-${version}-${os}-${arch}`;
}

function command(program, args, options = {}) {
  return execFileSync(program, args, { encoding: "utf8", ...options });
}

async function validate(env, publishing = false) {
  assert.match(env.SOURCE_SHA ?? "", sourcePattern);
  const repo = await github(`repos/${repository}`);
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(repo.full_name, repository);
  assert.equal(repo.default_branch, "main");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${workflow}@refs/heads/main`);
  assert.equal(env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA);
  const comparison = await github(`repos/${repository}/compare/${env.SOURCE_SHA}...main`);
  assert.ok(comparison.status === "ahead" || comparison.status === "identical");
  assert.equal(env.SOURCE_SHA, env.GITHUB_WORKFLOW_SHA);
  assert.equal(command("git", ["rev-parse", "HEAD"]).trim(), env.SOURCE_SHA);
  const ciAttempt = await verifyCi(env);
  if (publishing) {
    await verifyEnvironment();
  }
  return { version: await releaseVersion(), ciAttempt };
}

async function packageCli(directory) {
  directory = resolve(directory);
  const version = await releaseVersion();
  if (process.env.SOURCE_SHA) {
    assert.match(process.env.SOURCE_SHA, sourcePattern);
    assert.equal(command("go", ["env", "GOVERSION"]).trim(), "go1.27.1");
  }
  await mkdir(directory, { recursive: true });
  const checksums = [];
  for (const [os, arch] of platforms) {
    const name = assetName(version, os, arch);
    const path = join(directory, name);
    command(
      "go",
      [
        "build",
        "-trimpath",
        "-ldflags",
        `-s -w -X github.com/openclaw/openclaw-enterprise/internal/occcli.Version=${version}`,
        "-o",
        path,
        "./cmd/occ",
      ],
      {
        env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch, GOTOOLCHAIN: "local" },
        stdio: "pipe",
      },
    );
    await chmod(path, 0o755);
    const buildInfo = command("go", ["version", "-m", path]);
    assert.match(buildInfo, new RegExp(`\tGOOS=${os}(?:\n|$)`, "u"));
    assert.match(buildInfo, new RegExp(`\tGOARCH=${arch}(?:\n|$)`, "u"));
    if (process.env.SOURCE_SHA) {
      assert.match(buildInfo, new RegExp(`\tvcs.revision=${process.env.SOURCE_SHA}(?:\n|$)`, "u"));
      assert.match(buildInfo, /\tvcs.modified=false(?:\n|$)/u);
    }
    if (process.platform === os && nativeArch === arch) {
      assert.equal(command(path, ["--version"]).trim(), `occ ${version}`);
      assert.match(command(path, ["--help"]), /Manage OpenClaw Control Plane resources/u);
    }
    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    checksums.push(`${digest}  ${name}`);
  }
  await writeFile(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  return version;
}

async function verifyAssets(directory) {
  const version = await releaseVersion();
  const names = platforms.map(([os, arch]) => assetName(version, os, arch));
  const expected = (await readFile(join(directory, "SHA256SUMS"), "utf8")).trimEnd().split("\n");
  assert.equal(expected.length, names.length, "Release checksums must cover four binaries.");
  for (const [index, name] of names.entries()) {
    const bytes = await readFile(join(directory, name));
    assert.ok(bytes.length > 0, `${name} is empty.`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(expected[index], `${digest}  ${name}`, `${name} differs from SHA256SUMS.`);
  }
  return { version, names };
}

async function findRelease(version, retryMissing = false) {
  const attempts = retryMissing ? 6 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // The tag lookup excludes drafts. The authenticated release list includes
    // them, so it also finds a partial publication on a later run.
    const matches = (await githubPages(`repos/${repository}/releases`)).filter(
      (release) => release.tag_name === version,
    );
    assert.ok(matches.length <= 1, `Multiple releases use ${version}.`);
    if (matches.length === 1) {
      return github(`repos/${repository}/releases/${matches[0].id}`);
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return null;
}

async function publish(directory, env) {
  const { version } = await validate(env, true);
  const assets = await verifyAssets(directory);
  assert.equal(assets.version, version);
  const tagPath = `repos/${repository}/git/ref/tags/${version}`;
  let tag = await github(tagPath, { allowNotFound: true });
  if (!tag) {
    command("gh", [
      "api",
      "-X",
      "POST",
      `repos/${repository}/git/refs`,
      "-f",
      `ref=refs/tags/${version}`,
      "-f",
      `sha=${env.SOURCE_SHA}`,
    ]);
    tag = await github(tagPath, { retryNotFound: true });
  }
  assert.equal(tag.object?.type, "commit", "Release tag must be a lightweight commit tag.");
  assert.equal(tag.object?.sha, env.SOURCE_SHA, "Release tag points to another source.");

  let release = await findRelease(version);
  if (!release) {
    command("gh", [
      "release",
      "create",
      version,
      "--repo",
      repository,
      "--verify-tag",
      "--draft",
      "--title",
      `OCC CLI ${version}`,
      "--notes",
      `OCC CLI binaries for OCE ${version}, built from ${env.SOURCE_SHA}. These manage an existing OCC installation; local development commands still require a source checkout.`,
    ]);
    release = await findRelease(version, true);
  }
  assert.ok(release, `Draft release ${version} was not found after creation.`);
  const releasePath = `repos/${repository}/releases/${release.id}`;
  assert.equal(release.tag_name, version);
  assert.equal(release.draft, true, "Published releases cannot be replaced by a retry.");
  const expectedNames = new Set([...assets.names, "SHA256SUMS"]);
  for (const asset of release.assets) {
    assert.ok(expectedNames.has(asset.name), `Draft release has unexpected asset ${asset.name}.`);
  }
  const temporary = await mkdtemp(join(tmpdir(), "oce-cli-release-"));
  try {
    for (const name of [...assets.names, "SHA256SUMS"]) {
      const existing = release.assets.find((asset) => asset.name === name);
      if (!existing) {
        command("gh", ["release", "upload", version, join(directory, name), "--repo", repository]);
      }
      command("gh", [
        "release",
        "download",
        version,
        "--repo",
        repository,
        "--pattern",
        name,
        "--dir",
        temporary,
      ]);
      assert.deepEqual(
        await readFile(join(temporary, name)),
        await readFile(join(directory, name)),
        `Existing release asset ${name} differs from the verified build.`,
      );
    }
    release = await github(releasePath, { retryNotFound: true });
    assert.deepEqual(
      release.assets.map((asset) => asset.name).sort(),
      [...assets.names, "SHA256SUMS"].sort(),
      "Draft release has unexpected assets.",
    );
    assert.equal((await github(tagPath)).object?.sha, env.SOURCE_SHA);
    await validate(env, true);
    command("gh", ["release", "edit", version, "--repo", repository, "--draft=false"]);
    const published = await github(releasePath);
    assert.equal(published.draft, false, "CLI release remains a draft.");
    assert.deepEqual(
      published.assets.map((asset) => asset.name).sort(),
      [...assets.names, "SHA256SUMS"].sort(),
      "Published release asset inventory changed.",
    );
    assert.equal((await github(tagPath)).object?.sha, env.SOURCE_SHA);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    switch (process.argv[2]) {
      case "validate": {
        const { version, ciAttempt } = await validate(process.env);
        await writeFile(
          process.env.GITHUB_OUTPUT,
          `version=${version}\nci_attempt=${ciAttempt}\n`,
          { flag: "a" },
        );
        break;
      }
      case "package":
        assert.ok(process.argv[3], "Package output directory is required.");
        await packageCli(process.argv[3]);
        await verifyAssets(process.argv[3]);
        break;
      case "verify":
        assert.ok(process.argv[3], "Package directory is required.");
        await verifyAssets(process.argv[3]);
        break;
      case "publish":
        assert.ok(process.argv[3], "Package directory is required.");
        await publish(process.argv[3], process.env);
        break;
      default:
        throw new Error("Expected validate, package, verify, or publish.");
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
