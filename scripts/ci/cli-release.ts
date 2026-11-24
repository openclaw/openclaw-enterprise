import assert from "node:assert/strict";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  github,
  githubPages,
  repository,
  verifyCi,
  verifyEnvironment,
} from "./container-release.ts";

const cliWorkflow = `${repository}/.github/workflows/cli-release.yml@refs/heads/main`;
const releaseWorkflow = `${repository}/.github/workflows/release-oce.yml@refs/heads/main`;
const platforms = [
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["linux", "amd64"],
  ["linux", "arm64"],
] as const;
const sourcePattern = /^[a-f0-9]{40}$/u;
const nativeArch = process.arch === "x64" ? "amd64" : process.arch;

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
}

function assertRelease(value: unknown): asserts value is Record<string, unknown> & {
  id: number;
  assets: { id: number; name: string; state: string }[];
} {
  assertRecord(value);
  assert.equal(typeof value.id, "number");
  assert.ok(Array.isArray(value.assets));
  const assets: unknown[] = value.assets;
  for (const asset of assets) {
    assertRecord(asset);
    assert.equal(typeof asset.name, "string");
    assert.equal(typeof asset.state, "string");
    assert.ok(typeof asset.id === "number" && Number.isSafeInteger(asset.id) && asset.id > 0);
  }
}

async function releaseVersion(sha?: string) {
  // A recovery can use newer trusted main tooling to publish the original commit.
  const sourceFile = (path: string) =>
    sha ? command("git", ["show", `${sha}:${path}`]) : readFile(path, "utf8");
  const manifest: unknown = JSON.parse(await sourceFile("package.json"));
  assertRecord(manifest);
  const version = manifest.version;
  assert.ok(typeof version === "string");
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  const chart = await sourceFile("deploy/helm/openclaw-enterprise/Chart.yaml");
  assert.match(chart, new RegExp(`^version: ${version.replaceAll(".", "\\.")}$`, "mu"));
  assert.match(chart, new RegExp(`^appVersion: "${version.replaceAll(".", "\\.")}"$`, "mu"));
  return `v${version}`;
}

function assetName(version: string, os: string, arch: string) {
  return `occ-${version}-${os}-${arch}`;
}

function command(
  program: string,
  args: string[],
  options: Omit<ExecFileSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  return execFileSync(program, args, { encoding: "utf8", ...options });
}

async function validate(env: NodeJS.ProcessEnv, publishing = false) {
  assert.match(env.SOURCE_SHA ?? "", sourcePattern);
  const repo: unknown = await github(`repos/${repository}`);
  assertRecord(repo);
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(repo.full_name, repository);
  assert.equal(repo.default_branch, "main");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.ok(
    env.GITHUB_WORKFLOW_REF === cliWorkflow || env.GITHUB_WORKFLOW_REF === releaseWorkflow,
    "Only the CLI and OCE release workflows on main can prepare or publish the CLI.",
  );
  assert.equal(env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA);
  const comparison: unknown = await github(`repos/${repository}/compare/${env.SOURCE_SHA}...main`);
  assertRecord(comparison);
  assert.ok(comparison.status === "ahead" || comparison.status === "identical");
  let recovery = false;
  if (env.GITHUB_WORKFLOW_REF === releaseWorkflow) {
    const event: unknown = JSON.parse(await readFile(env.GITHUB_EVENT_PATH!, "utf8"));
    assertRecord(event);
    assertRecord(event.inputs);
    assert.equal(event.inputs.source_sha, env.SOURCE_SHA);
    if (publishing) {
      assert.equal(event.inputs.publish, "true", "Release OCE must explicitly select publication.");
      assert.equal(repo.private, false, "Release OCE requires public CLI downloads.");
    }
    recovery =
      typeof event.inputs.recovery_run_id === "string" &&
      /^[1-9][0-9]*$/u.test(event.inputs.recovery_run_id);
    assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  }
  if (!recovery) {
    assert.equal(env.SOURCE_SHA, env.GITHUB_WORKFLOW_SHA);
  }
  const head = command("git", ["rev-parse", "HEAD"]).trim();
  assert.ok(head === env.GITHUB_WORKFLOW_SHA || head === env.SOURCE_SHA, "Unexpected checkout.");

  const ciAttempt = await verifyCi(env);
  if (publishing) {
    await verifyEnvironment();
  }
  return { version: await releaseVersion(env.SOURCE_SHA), ciAttempt };
}

async function packageCli(directory: string) {
  directory = resolve(directory);
  const version = await releaseVersion();
  if (process.env.SOURCE_SHA) {
    assert.match(process.env.SOURCE_SHA, sourcePattern);
    assert.equal(command("go", ["env", "GOVERSION"]).trim(), "go1.27.3");
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

async function verifyAssets(directory: string, version: string, checksumDigest?: string) {
  const names = platforms.map(([os, arch]) => assetName(version, os, arch));
  const sums = await readFile(join(directory, "SHA256SUMS"));
  if (checksumDigest !== undefined) {
    assert.match(checksumDigest, /^[0-9a-f]{64}$/u);
    assert.equal(
      createHash("sha256").update(sums).digest("hex"),
      checksumDigest,
      "SHA256SUMS differs from the prepared artifact.",
    );
  }
  const expected = sums.toString("utf8").trimEnd().split("\n");
  assert.equal(expected.length, names.length, "Release checksums must cover four binaries.");
  for (const [index, name] of names.entries()) {
    const bytes = await readFile(join(directory, name));
    assert.ok(bytes.length > 0, `${name} is empty.`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(expected[index], `${digest}  ${name}`, `${name} differs from SHA256SUMS.`);
  }
  return [...names, "SHA256SUMS"];
}

async function findRelease(version: string, retryMissing = false) {
  const attempts = retryMissing ? 6 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // The tag lookup excludes drafts. The authenticated release list includes
    // them, so it also finds a partial publication on a later run.
    const releases: unknown[] = await githubPages(`repos/${repository}/releases`, undefined);
    const matches = releases.filter((release) => {
      assertRecord(release);
      return release.tag_name === version;
    });
    assert.ok(matches.length <= 1, `Multiple releases use ${version}.`);
    if (matches.length === 1) {
      const match = matches[0];
      assertRecord(match);
      assert.equal(typeof match.id, "number");
      const release: unknown = await github(`repos/${repository}/releases/${match.id}`);
      assertRelease(release);
      return release;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return null;
}

function verifyTag(tag: unknown, sha: string | undefined) {
  assertRecord(tag);
  assertRecord(tag.object);
  assert.equal(tag.object.type, "commit", "Release tag must be a lightweight commit tag.");
  assert.equal(tag.object.sha, sha, "Release tag points to another source.");
}

export function missingReleaseAssets(
  release: { assets: { name: string }[] },
  names: string[],
  complete: boolean,
) {
  const actual = release.assets.map((asset) => asset.name).sort();
  assert.equal(new Set(actual).size, actual.length, "Duplicate release asset names.");
  for (const name of actual) {
    assert.ok(names.includes(name), `Unexpected release asset ${name}.`);
  }
  const missing = names.filter((name) => !actual.includes(name));
  if (complete) {
    assert.deepEqual(missing, [], "Release is missing CLI assets.");
  }
  return missing;
}

export async function verifyDownload(
  url: string,
  file: string,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, `Release asset download failed for ${url}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.equals(await readFile(file)), `Download differs from prepared bytes: ${url}`);
}

async function verifyRemoteBytes(
  version: string,
  assets: { id: number; name: string }[],
  directory: string,
  draft: boolean,
) {
  for (const { id, name } of assets) {
    if (draft) {
      // Drafts have no public download URL. Request the asset by its GitHub ID.
      assert.ok(process.env.GH_TOKEN);
      await verifyDownload(
        `https://api.github.com/repos/${repository}/releases/assets/${id}`,
        join(directory, name),
        { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/octet-stream" },
      );
    } else {
      await verifyDownload(
        `https://github.com/${repository}/releases/download/${version}/${name}`,
        join(directory, name),
      );
    }
  }
}

async function inspectDestination(env: NodeJS.ProcessEnv, version: string, directory?: string) {
  const tagPath = `repos/${repository}/git/ref/tags/${version}`;
  const tag = await github(tagPath, { allowNotFound: true });
  if (tag) {
    verifyTag(tag, env.SOURCE_SHA);
  }
  const names = directory
    ? await verifyAssets(directory, version, env.CLI_SHA256SUMS_DIGEST)
    : [...platforms.map(([os, arch]) => assetName(version, os, arch)), "SHA256SUMS"];
  const release = await findRelease(version);
  if (release) {
    assert.ok(tag, "Existing release has no matching Git tag.");
    assert.equal(release.tag_name, version);
    assert.equal(typeof release.draft, "boolean");
    missingReleaseAssets(release, names, !release.draft);
    if (!release.draft) {
      assert.equal(
        env.GITHUB_WORKFLOW_REF,
        releaseWorkflow,
        "Published standalone releases cannot be replaced.",
      );
    }
    if (directory) {
      await verifyRemoteBytes(version, release.assets, directory, release.draft === true);
    }
  }
  return { tagPath, tag, release, names };
}

async function reportInterruptedPublication(env: NodeJS.ProcessEnv) {
  assert.match(env.SOURCE_SHA ?? "", sourcePattern);
  assert.ok(env.GITHUB_STEP_SUMMARY);
  const version = await releaseVersion(env.SOURCE_SHA);
  const lines = [
    `### OCC CLI publication interrupted for ${version}`,
    "",
    `Source commit: ${env.SOURCE_SHA}.`,
    "",
  ];
  const [tag, release] = await Promise.allSettled([
    github(`repos/${repository}/git/ref/tags/${version}`, { allowNotFound: true }),
    findRelease(version),
  ]);
  if (tag.status === "rejected") {
    lines.push("Git tag lookup failed.");
  } else if (!tag.value) {
    lines.push("Git tag is missing.");
  } else {
    assertRecord(tag.value);
    assertRecord(tag.value.object);
    const target = tag.value.object.sha;
    assert.ok(typeof target === "string" && sourcePattern.test(target));
    lines.push(`Git tag points to ${target}.`);
  }
  if (release.status === "rejected") {
    lines.push("Release lookup failed. Asset state is unknown.");
  } else if (!release.value) {
    lines.push("GitHub has no release for this tag.");
  } else {
    const observed = release.value;
    assert.equal(typeof observed.draft, "boolean");
    lines.push(observed.draft ? "GitHub has a draft release." : "GitHub has a published release.");
    lines.push("", "| Expected asset | GitHub state |", "| --- | --- |");
    const names = [...platforms.map(([os, arch]) => assetName(version, os, arch)), "SHA256SUMS"];
    for (const name of names) {
      const asset = observed.assets.find((item) => item.name === name);
      let state = "Missing";
      if (asset?.state === "uploaded") {
        state = observed.draft
          ? "Uploaded to draft"
          : `[Published](https://github.com/${repository}/releases/download/${version}/${name})`;
      } else if (asset) {
        state = "Incomplete upload";
      }
      lines.push(`| ${name} | ${state} |`);
    }
    const unexpected = observed.assets.filter((asset) => !names.includes(asset.name));
    if (unexpected.length > 0) {
      lines.push("", `GitHub also lists ${unexpected.length} unexpected assets.`);
    }
  }
  lines.push(
    "",
    "Recovery compares remote bytes with the original prepared artifacts before it resumes publication.",
    "",
  );
  await writeFile(env.GITHUB_STEP_SUMMARY, lines.join("\n"), { flag: "a" });
}

async function publish(directory: string, env: NodeJS.ProcessEnv) {
  const { version } = await validate(env, true);
  assert.ok(env.CLI_SHA256SUMS_DIGEST, "Missing digest from CLI preparation.");
  const destination = await inspectDestination(env, version, directory);
  const { tagPath, names } = destination;
  let release = destination.release;
  if (!destination.tag) {
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
    verifyTag(await github(tagPath, { retryNotFound: true }), env.SOURCE_SHA);
  }
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
    assert.ok(release, `Draft release ${version} was not found after creation.`);
    assert.equal(release.draft, true, "A different publication created the release.");
  }

  const releasePath = `repos/${repository}/releases/${release.id}`;
  // Recovery after release publication validates every public byte before alias movement.
  if (release.draft) {
    for (const name of missingReleaseAssets(release, names, false)) {
      command("gh", ["release", "upload", version, join(directory, name), "--repo", repository]);
    }
    const draft = await github(releasePath);
    assertRelease(draft);
    assert.equal(draft.tag_name, version);
    assert.equal(draft.draft, true);
    missingReleaseAssets(draft, names, true);
    await verifyRemoteBytes(version, draft.assets, directory, true);
    verifyTag(await github(tagPath), env.SOURCE_SHA);
    await validate(env, true);
    command("gh", ["release", "edit", version, "--repo", repository, "--draft=false"]);
    const published = await github(releasePath);
    assertRelease(published);
    assert.equal(published.tag_name, version);
    assert.equal(published.draft, false, "CLI release remains a draft.");
    missingReleaseAssets(published, names, true);
    if (env.GITHUB_WORKFLOW_REF === releaseWorkflow) {
      await verifyRemoteBytes(version, published.assets, directory, false);
    }
  }
  verifyTag(await github(tagPath), env.SOURCE_SHA);
  if (env.GITHUB_STEP_SUMMARY) {
    const links = names.map(
      (name) =>
        `- [${name}](https://github.com/${repository}/releases/download/${version}/${name})`,
    );
    await writeFile(
      env.GITHUB_STEP_SUMMARY,
      `Verified release assets for ${env.SOURCE_SHA}.\n\n${links.join("\n")}\n`,
      { flag: "a" },
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    switch (process.argv[2]) {
      case "validate": {
        const { version, ciAttempt } = await validate(process.env);
        await writeFile(
          process.env.GITHUB_OUTPUT!,
          `version=${version}\nci_attempt=${ciAttempt}\n`,
          { flag: "a" },
        );
        break;
      }
      case "preflight": {
        const { version } = await validate(process.env);
        await inspectDestination(process.env, version, process.argv[3]);
        if (process.env.GITHUB_OUTPUT) {
          await writeFile(process.env.GITHUB_OUTPUT, `version=${version.slice(1)}\n`, {
            flag: "a",
          });
        }
        break;
      }
      case "package":
        assert.ok(process.argv[3], "Package output directory is required.");
        await packageCli(process.argv[3]);
        await verifyAssets(
          process.argv[3],
          await releaseVersion(),
          process.env.CLI_SHA256SUMS_DIGEST,
        );
        break;
      case "verify":
        assert.ok(process.argv[3], "Package directory is required.");
        await verifyAssets(
          process.argv[3],
          await releaseVersion(),
          process.env.CLI_SHA256SUMS_DIGEST,
        );
        break;
      case "report":
        await reportInterruptedPublication(process.env);
        break;
      case "publish":
        assert.ok(process.argv[3], "Package directory is required.");
        await publish(process.argv[3], process.env);
        break;
      default:
        throw new Error("Expected validate, preflight, package, verify, publish, or report.");
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
