import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ghcrPackageName, isReleaseVersion } from "./container-release/admission.ts";
import {
  digestPattern,
  field,
  fileDigest,
  images,
  integerPattern,
  match,
  shaPattern,
} from "./container-release/metadata.ts";
import type { Image } from "./container-release/metadata.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

type PreparedChartImage = { image: Image; destination: string; digest: string };

export async function readChartVersion() {
  const pkg: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = field(pkg, "version");
  assert.ok(
    typeof version === "string" && isReleaseVersion(version),
    "Expected an OCE release version.",
  );
  const chart = await readFile(join(root, "deploy/helm/openclaw-enterprise/Chart.yaml"), "utf8");
  assert.equal(
    chart.match(/^version: (.+)$/mu)?.[1],
    version,
    "Chart version must match root package.json.",
  );
  assert.equal(
    chart.match(/^appVersion: "(.+)"$/mu)?.[1],
    version,
    "Chart appVersion must match root package.json.",
  );
  return version;
}

export async function stageReleaseChart(
  directory: string,
  {
    sourceSha,
    version,
    images,
  }: { sourceSha: string; version: string; images: PreparedChartImage[] },
) {
  assert.match(sourceSha, shaPattern);
  assert.ok(isReleaseVersion(version), "Expected an OCE release version.");
  assert.equal(await readChartVersion(), version);
  const destination = join(directory, "chart");
  await cp(join(root, "deploy/helm/openclaw-enterprise"), destination, { recursive: true });
  const metadataPath = join(destination, "Chart.yaml");
  const metadata = await readFile(metadataPath, "utf8");
  assert.ok(!/^annotations:/mu.test(metadata), "Release annotations must be staged once.");
  const controller = images.find(({ image }) => image === "controller");
  const runtime = images.find(({ image }) => image === "runtime");
  assert.ok(controller && runtime, "Both verified images are required.");
  for (const selected of [controller, runtime]) {
    assert.match(selected.digest, digestPattern);
    ghcrPackageName(selected.destination);
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

function chartPreparationReceipt(
  env: NodeJS.ProcessEnv,
  producer: { runId: string | undefined; attempt: string | undefined },
  version: string,
  chartSha256: string,
  controller: string,
  runtime: string,
) {
  assert.match(env.SOURCE_SHA ?? "", shaPattern);
  for (const value of [producer.runId, producer.attempt, env.CI_RUN_ID, env.CI_ATTEMPT]) {
    assert.match(value ?? "", integerPattern);
  }
  assert.match(chartSha256, /^[a-f0-9]{64}$/u);
  return {
    sourceSha: env.SOURCE_SHA,
    workflowSha: env.SOURCE_SHA,
    runId: producer.runId,
    attempt: producer.attempt,
    ciRunId: env.CI_RUN_ID,
    ciAttempt: env.CI_ATTEMPT,
    nodeBaseImage: env.NODE_BASE_IMAGE,
    version,
    chartSha256,
    controller,
    runtime,
  };
}

export async function verifyPreparedReleaseChart(
  archive: string,
  env: NodeJS.ProcessEnv,
  producer: { runId: string | undefined; attempt: string | undefined },
  controller: string,
  runtime: string,
) {
  const version = await readChartVersion();
  const chartSha256 = await fileDigest(archive);
  const expected = chartPreparationReceipt(
    env,
    producer,
    version,
    chartSha256,
    controller,
    runtime,
  );
  const receipt: unknown = JSON.parse(
    await readFile(join(dirname(archive), "chart-preparation.json"), "utf8"),
  );
  assert.deepEqual(
    receipt,
    expected,
    "Chart preparation receipt must match the archive and both verified images.",
  );
  return expected;
}

function verifyPackagedMetadata(
  archive: string,
  env: NodeJS.ProcessEnv,
  receipt: ReturnType<typeof chartPreparationReceipt>,
) {
  const metadata = execFileSync(env.OCC_HELM_BIN ?? "helm", ["show", "chart", archive], {
    encoding: "utf8",
  }).split("\n");
  for (const [key, value] of [
    ["version", receipt.version],
    ["appVersion", receipt.version],
    ["  openclaw.dev/source-revision", receipt.sourceSha],
    ["  openclaw.dev/controller-image", receipt.controller],
    ["  openclaw.dev/runtime-image", receipt.runtime],
  ] as const) {
    // Helm quotes strings that YAML could otherwise interpret as numbers.
    assert.ok(
      metadata.includes(`${key}: ${value}`) || metadata.includes(`${key}: "${value}"`),
      `Packaged chart must contain the prepared ${key.trim()}.`,
    );
  }
}

export async function prepareReleaseChart(directory: string, env: NodeJS.ProcessEnv) {
  const sourceSha = env.SOURCE_SHA;
  match(sourceSha, shaPattern);
  assert.equal(sourceSha, env.GITHUB_WORKFLOW_SHA);
  const version = await readChartVersion();
  const pinnedImages = images.map((image) => {
    const destination = env[`GHCR_${image.toUpperCase()}_IMAGE`];
    assert.ok(destination);
    ghcrPackageName(destination);
    const digest = env[`${image.toUpperCase()}_DIGEST`];
    match(digest, digestPattern);
    return { image, destination, digest };
  });
  const [controller, runtime] = pinnedImages;
  assert.ok(
    controller && runtime && controller.destination !== runtime.destination,
    "Set distinct controller and runtime repositories.",
  );
  await mkdir(directory);
  const temporary = await mkdtemp(join(tmpdir(), "oce-chart-preparation-"));
  try {
    const staged = await stageReleaseChart(temporary, { sourceSha, version, images: pinnedImages });
    execFileSync(env.OCC_HELM_BIN ?? "helm", ["package", staged, "--destination", directory], {
      stdio: "inherit",
    });
    const archive = join(directory, `openclaw-enterprise-${version}.tgz`);
    const receipt = chartPreparationReceipt(
      env,
      { runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
      version,
      await fileDigest(archive),
      `${controller.destination}@${controller.digest}`,
      `${runtime.destination}@${runtime.digest}`,
    );
    verifyPackagedMetadata(archive, env, receipt);
    await writeFile(
      join(directory, "chart-preparation.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  assert.ok(directory && process.env.GITHUB_OUTPUT);
  const receipt = await prepareReleaseChart(directory, process.env);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `chart_sha256=${receipt.chartSha256}\nversion=${receipt.version}\n`,
  );
}
