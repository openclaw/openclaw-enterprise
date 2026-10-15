import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { chartPackage, chartPushParent, pushChart } from "./chart-package.mjs";
import {
  ghcrPackageName,
  github,
  githubPages,
  inspectDigest,
  remoteTagDigest,
  skopeo,
  validatePackage,
  verifyGhcr,
  verifyCi,
  verifyEnvironment,
  verifyMainSource,
} from "./container-release.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const integerPattern = /^[1-9][0-9]*$/;
const helm = process.env.OCC_HELM_BIN ?? "helm";

export function validateImageReceipt(receipt, expected) {
  assert.ok(Array.isArray(receipt) && receipt.length === 2, "Expected two published images.");
  const sorted = [...receipt].sort((left, right) => left.image.localeCompare(right.image));
  assert.deepEqual(
    sorted.map(({ image }) => image),
    ["controller", "runtime"],
    "Expected controller and runtime images once each.",
  );
  assert.match(expected.sourceSha, shaPattern);
  for (const image of sorted) {
    assert.equal(image.sourceSha, expected.sourceSha);
    assert.equal(image.workflowSha, expected.sourceSha);
    assert.equal(String(image.runId), expected.runId);
    assert.equal(String(image.attempt), expected.attempt);
    assert.equal(String(image.ciRunId), expected.ciRunId);
    assert.equal(String(image.ciAttempt), expected.ciAttempt);
    assert.equal(image.destination, expected[`${image.image}Image`]);
    assert.equal(image.tag, `sha-${expected.sourceSha}`);
    assert.match(image.digest, digestPattern);
  }
  assert.notEqual(sorted[0].destination, sorted[1].destination);
  return sorted;
}

export async function stageReleaseChart(directory, { sourceSha, version, images }) {
  assert.match(sourceSha, shaPattern);
  assert.match(version, versionPattern);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.version, version, "OCE release version must match root package.json.");
  const destination = join(directory, "chart");
  await cp(join(root, "deploy/helm/openclaw-enterprise"), destination, { recursive: true });
  const metadataPath = join(destination, "Chart.yaml");
  const metadata = await readFile(metadataPath, "utf8");
  assert.equal(metadata.match(/^version: (.+)$/mu)?.[1], version);
  assert.equal(metadata.match(/^appVersion: "(.+)"$/mu)?.[1], version);
  assert.ok(!/^annotations:/mu.test(metadata), "Release annotations must be staged once.");
  const controller = images.find(({ image }) => image === "controller");
  const runtime = images.find(({ image }) => image === "runtime");
  assert.ok(controller && runtime, "Both verified images are required.");
  for (const selected of [controller, runtime]) {
    assert.match(selected.digest, digestPattern);
    assert.match(selected.destination, /^ghcr\.io\/openclaw\/[a-z0-9/_-]+$/u);
  }
  const controllerReference = `${controller.destination}@${controller.digest}`;
  const runtimeReference = `${runtime.destination}@${runtime.digest}`;
  await writeFile(
    metadataPath,
    `${metadata.trimEnd()}\nannotations:\n  openclaw.dev/source-revision: "${sourceSha}"\n  openclaw.dev/controller-image: "${controllerReference}"\n  openclaw.dev/runtime-image: "${runtimeReference}"\n`,
  );
  const valuesPath = join(destination, "values.yaml");
  const values = await readFile(valuesPath, "utf8");
  assert.match(
    values,
    /^[ ]{2}controller: ""$/mu,
    "Expected the source controller image placeholder.",
  );
  await writeFile(
    valuesPath,
    values.replace(/^[ ]{2}controller: ""$/mu, `  controller: "${controllerReference}"`),
  );
  return destination;
}

// Helm 3 stamps tar headers when it packages a chart, so retries must compare
// every packaged file rather than the compressed archive's incidental bytes.
export async function chartArchiveContent(archive) {
  const compressed = await readFile(archive);
  assert.ok(compressed.length <= 16 * 1024 * 1024, "Chart archive is too large.");
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  function field(bytes) {
    const end = bytes.indexOf(0);
    return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
  }
  function octal(bytes) {
    const value = field(bytes).trim();
    assert.match(value, /^[0-7]+$/u, "Invalid chart tar field.");
    return Number.parseInt(value, 8);
  }
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      terminated = true;
      assert.ok(
        tar.subarray(offset).every((byte) => byte === 0),
        "Invalid chart tar trailer.",
      );
      break;
    }
    const checksum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    assert.equal(octal(header.subarray(148, 156)), checksum, "Invalid chart tar checksum.");
    const name = field(header.subarray(0, 100));
    const prefix = field(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    assert.match(
      path,
      /^openclaw-enterprise\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u,
      "Unexpected chart archive path.",
    );
    assert.ok(
      path.split("/").every((part) => part !== "." && part !== ".."),
      "Chart archive path must stay inside its chart directory.",
    );
    assert.ok(!files.has(path), "Duplicate chart archive path.");
    assert.ok(header[156] === 0 || header[156] === 48, "Chart archive contains a non-file entry.");
    const size = octal(header.subarray(124, 136));
    assert.ok(size <= 16 * 1024 * 1024, "Chart file is too large.");
    const start = offset + 512;
    assert.ok(start + size <= tar.length, "Truncated chart archive file.");
    files.set(
      path,
      createHash("sha256")
        .update(tar.subarray(start, start + size))
        .digest("hex"),
    );
    offset = start + Math.ceil(size / 512) * 512;
  }
  assert.ok(terminated, "Chart archive lacks a tar trailer.");
  assert.ok(files.has("openclaw-enterprise/Chart.yaml"), "Chart metadata is missing.");
  assert.ok(files.has("openclaw-enterprise/values.yaml"), "Chart defaults are missing.");
  assert.ok(
    [...files.keys()].some((path) => path.startsWith("openclaw-enterprise/templates/")),
    "Chart templates are missing.",
  );
  return [...files].sort(([left], [right]) => left.localeCompare(right));
}

async function verifyReleaseContext(env, packagePath) {
  assert.equal(env.PUBLISH, "true");
  assert.equal(env.SOURCE_SHA, env.GITHUB_WORKFLOW_SHA);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    env.SOURCE_SHA,
  );
  await verifyMainSource(env);
  await verifyCi(env);
  await verifyEnvironment();
  validatePackage(await github(packagePath), chartPackage, { allowMissingRepository: true });
}

function helmCommand(args, options = {}) {
  return execFileSync(helm, args, { encoding: "utf8", ...options });
}

async function publish(directory, env) {
  const packagePath = `orgs/openclaw/packages/container/${encodeURIComponent(ghcrPackageName(chartPackage))}`;
  await verifyReleaseContext(env, packagePath);
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "CI_RUN_ID", "CI_ATTEMPT"]) {
    assert.match(env[key] ?? "", integerPattern);
  }
  const images = validateImageReceipt(
    JSON.parse(await readFile(join(directory, "publication.json"), "utf8")),
    {
      sourceSha: env.SOURCE_SHA,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      ciRunId: env.CI_RUN_ID,
      ciAttempt: env.CI_ATTEMPT,
      controllerImage: env.GHCR_CONTROLLER_IMAGE,
      runtimeImage: env.GHCR_RUNTIME_IMAGE,
    },
  );
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = packageJson.version;
  assert.match(version, versionPattern);
  const temporary = await mkdtemp(join(tmpdir(), "enterprise-chart-release-"));
  const authfile = join(temporary, "auth.json");
  try {
    const staged = await stageReleaseChart(temporary, {
      sourceSha: env.SOURCE_SHA,
      version,
      images,
    });
    helmCommand(["package", staged, "--destination", temporary]);
    const archive = join(temporary, `openclaw-enterprise-${version}.tgz`);
    const expectedBytes = await readFile(archive);
    const expectedContent = await chartArchiveContent(archive);
    const metadata = helmCommand(["show", "chart", archive]);
    assert.match(metadata, new RegExp(`^version: ${version.replaceAll(".", "\\.")}$`, "mu"));
    assert.match(metadata, new RegExp(`^appVersion: ${version.replaceAll(".", "\\.")}$`, "mu"));
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
    helmCommand(
      ["registry", "login", "ghcr.io", "--username", env.GITHUB_ACTOR, "--password-stdin"],
      {
        input: env.GH_TOKEN,
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    const chartVersions = await githubPages(`${packagePath}/versions`);
    const existingCharts = chartVersions.filter((entry) =>
      entry.metadata?.container?.tags?.includes(version),
    );
    assert.ok(existingCharts.length <= 1, "Chart version must resolve to one package version.");
    const existingChartDigest = remoteTagDigest(
      chartPackage,
      version,
      authfile,
      existingCharts.length > 0,
    );
    const imageTags = [];
    for (const image of images) {
      const listed = await verifyGhcr(image.destination, image.digest, version);
      const actual = remoteTagDigest(image.destination, version, authfile, listed);
      if (actual) {
        assert.equal(actual, image.digest, "Existing image release tag has different bytes.");
      }
      assert.equal(
        inspectDigest(`docker://${image.destination}:sha-${env.SOURCE_SHA}`, authfile),
        image.digest,
        "Source image tag does not match the publication receipt.",
      );
      imageTags.push({ ...image, exists: Boolean(actual) });
    }
    if (existingChartDigest) {
      const pulled = join(temporary, "existing");
      await mkdir(pulled);
      helmCommand(["pull", `oci://${chartPackage}`, "--version", version, "--destination", pulled]);
      assert.deepEqual(
        await chartArchiveContent(join(pulled, `openclaw-enterprise-${version}.tgz`)),
        expectedContent,
        "Existing chart version has different packaged content.",
      );
    }
    for (const image of imageTags) {
      if (image.exists) {
        continue;
      }
      await verifyReleaseContext(env, packagePath);
      const listed = await verifyGhcr(image.destination, image.digest, version);
      assert.equal(
        remoteTagDigest(image.destination, version, authfile, listed),
        null,
        "Image release tag appeared before publication.",
      );
      skopeo(
        [
          "copy",
          "--all",
          "--preserve-digests",
          "--authfile",
          authfile,
          `docker://${image.destination}@${image.digest}`,
          `docker://${image.destination}:${version}`,
        ],
        { stdio: "inherit" },
      );
      assert.equal(
        inspectDigest(`docker://${image.destination}:${version}`, authfile),
        image.digest,
      );
    }
    for (const image of images) {
      assert.equal(
        inspectDigest(`docker://${image.destination}:${version}`, authfile),
        image.digest,
      );
    }
    let pushedChartDigest;
    if (!existingChartDigest) {
      await verifyReleaseContext(env, packagePath);
      const refreshed = await githubPages(`${packagePath}/versions`);
      assert.ok(
        refreshed.every((entry) => !entry.metadata?.container?.tags?.includes(version)),
        "Chart version appeared before publication.",
      );
      assert.equal(
        remoteTagDigest(chartPackage, version, authfile, false),
        null,
        "Chart version appeared before publication.",
      );
      pushedChartDigest = pushChart(archive, chartPushParent);
    }
    const pulled = join(temporary, "verified");
    await mkdir(pulled);
    helmCommand(["pull", `oci://${chartPackage}`, "--version", version, "--destination", pulled]);
    const pulledArchive = join(pulled, `openclaw-enterprise-${version}.tgz`);
    assert.deepEqual(
      await chartArchiveContent(pulledArchive),
      expectedContent,
      "Published chart content differs from the staged archive.",
    );
    if (!existingChartDigest) {
      assert.deepEqual(
        await readFile(pulledArchive),
        expectedBytes,
        "Newly published chart bytes differ from the staged archive.",
      );
    }
    await verifyReleaseContext(env, packagePath);
    const chartDigest = inspectDigest(`docker://${chartPackage}:${version}`, authfile);
    assert.match(chartDigest, digestPattern);
    if (pushedChartDigest) {
      assert.equal(
        chartDigest,
        pushedChartDigest,
        "Published chart digest differs from Helm push.",
      );
    }
    if (existingChartDigest) {
      assert.equal(chartDigest, existingChartDigest, "Chart version changed during the retry.");
    }
    const receipt = {
      version,
      sourceSha: env.SOURCE_SHA,
      chart: { reference: `${chartPackage}@${chartDigest}`, version, digest: chartDigest },
      controller: `${images[0].destination}@${images[0].digest}`,
      runtime: `${images[1].destination}@${images[1].digest}`,
    };
    await writeFile(
      join(directory, "chart-publication.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `\n- OCE ${version} chart: \`${receipt.chart.reference}\`\n- Controller: \`${receipt.controller}\`\n- Runtime: \`${receipt.runtime}\`\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, directory] = process.argv.slice(2);
  if (command !== "publish" || !directory) {
    throw new Error("Expected publish <prepared-directory>.");
  }
  publish(directory, process.env).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
