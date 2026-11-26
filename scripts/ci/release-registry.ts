import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { chartPackage } from "./chart-package.ts";
import { publishChart, validateImageReceipt } from "./chart-release.ts";
import {
  ghcrPackageName,
  github,
  readReleaseNodeBase,
  releaseWorkflow,
  publicationAlias,
  validatePackage,
  verifyEnvironment,
  verifyGhcr,
  verifyMainSource,
} from "./container-release/admission.ts";
import {
  digestPattern,
  field,
  images,
  integerPattern,
  match,
  validatePreparedImage,
} from "./container-release/metadata.ts";
import type { Producer } from "./container-release/metadata.ts";
import { readChartVersion, verifyPreparedReleaseChart } from "./prepare-release-chart.ts";
import { publishPrepared } from "./container-release/publication.ts";
import {
  inspectDigest,
  remoteTagDigest,
  skopeo,
  skopeoLogin,
} from "./container-release/registry.ts";

import { verifyProducer } from "./release-oce.ts";

type Target = { image: string; destination: string; digest: string };

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function save(path: string, data: unknown) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

function aliasDigest(
  image: Target,
  alias: string,
  baseline: Record<string, unknown>,
  authfile: string,
) {
  const previous = baseline[image.image];
  const current = remoteTagDigest(image.destination, alias, authfile);
  assert.ok(
    current === previous || current === image.digest,
    `Refusing to move ${image.destination}:${alias}. Expected original ${previous} or released ${image.digest}, found ${current}.`,
  );
  return current;
}

export async function advanceReleaseAliases(
  targets: Target[],
  alias: string,
  baseline: Record<string, unknown>,
  authfile: string,
  verify: () => Promise<void>,
) {
  publicationAlias(alias);
  // Check both destinations before changing either, including after a partial move.
  for (const image of targets) {
    aliasDigest(image, alias, baseline, authfile);
  }
  for (const image of targets) {
    await verify();
    if (aliasDigest(image, alias, baseline, authfile) !== image.digest) {
      skopeo(
        [
          "copy",
          "--all",
          "--preserve-digests",
          "--authfile",
          authfile,
          `docker://${image.destination}@${image.digest}`,
          `docker://${image.destination}:${alias}`,
        ],
        { stdio: "inherit" },
      );
    }
    assert.equal(inspectDigest(`docker://${image.destination}:${alias}`, authfile), image.digest);
    console.log(`Verified ${image.destination}:${alias} @ ${image.digest}`);
  }
  for (const image of targets) {
    assert.equal(inspectDigest(`docker://${image.destination}:${alias}`, authfile), image.digest);
  }
}

// Read the destinations again even when a copy fails after the registry accepted
// it. A lost response cannot establish which tags became public.
async function reportRegistryState(
  env: NodeJS.ProcessEnv,
  targets: Target[],
  sourceSha: string,
  version: string,
  alias: string,
  authfile: string,
) {
  const tags = [
    ...targets.flatMap(({ destination }) =>
      [`sha-${sourceSha}`, version, alias].map((tag) => ({ destination, tag })),
    ),
    { destination: chartPackage, tag: version },
  ];
  const lines = ["", "### Observed registry tags", "", "| Tag | Remote digest |", "| --- | --- |"];
  for (const { destination, tag } of tags) {
    let outcome;
    try {
      outcome = remoteTagDigest(destination, tag, authfile) ?? "absent";
    } catch {
      outcome = "unverified (registry inspection failed)";
    }
    lines.push(`| \`${destination}:${tag}\` | \`${outcome}\` |`);
  }
  assert.ok(env.GITHUB_STEP_SUMMARY);
  await appendFile(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

// Helm stores the exact .tgz as an OCI layer. Check that layer before any image
// upload, including a retry where the chart exists but the receipt upload failed.
async function verifyChartTag(version: string, sha256: string, authfile: string) {
  const path = `orgs/openclaw/packages/container/${encodeURIComponent(ghcrPackageName(chartPackage))}`;
  validatePackage(await github(path), chartPackage, { allowMissingRepository: true });
  const digest = remoteTagDigest(chartPackage, version, authfile);
  if (digest) {
    const manifest: unknown = JSON.parse(
      skopeo(["inspect", "--authfile", authfile, "--raw", `docker://${chartPackage}@${digest}`], {
        encoding: "utf8",
      }),
    );
    const layers = field(manifest, "layers");
    assert.ok(
      Array.isArray(layers) && layers.length === 1,
      "Expected one Helm chart content layer.",
    );
    assert.equal(
      field(layers[0], "mediaType"),
      "application/vnd.cncf.helm.chart.content.v1.tar+gzip",
    );
    assert.equal(
      field(layers[0], "digest"),
      `sha256:${sha256}`,
      "Existing chart version has different archive bytes.",
    );
  }
  return digest;
}

async function imagePublication(
  phase: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  producer: Producer,
  verify: () => Promise<void>,
) {
  const alias = publicationAlias(env.IMAGE_TAG);
  const targets = await Promise.all(
    images.map(async (image) => {
      const destination = env[`GHCR_${image.toUpperCase()}_IMAGE`];
      ghcrPackageName(destination);
      assert.ok(destination);
      const artifact = `container-${image}-${producer.runId}-${producer.attempt}`;
      const metadata = await json(join(directory, artifact, "metadata.json"));
      validatePreparedImage(metadata, { ...producer, image });
      if (phase === "image-baseline") {
        assert.equal(
          metadata.digest,
          env[`IMAGE_${image.toUpperCase()}`],
          "Unexpected assembly digest.",
        );
      }
      return { image, destination, digest: metadata.digest };
    }),
  );
  assert.notEqual(targets[0]?.destination, targets[1]?.destination);
  const expected = { ...producer, alias, targets };
  const path = join(directory, "image-baseline.json");
  const temporary = await mkdtemp(join(tmpdir(), "oce-image-publication-"));
  const authfile = join(temporary, "auth.json");
  try {
    skopeoLogin("ghcr.io", authfile, env.GITHUB_ACTOR, env.GH_TOKEN);
    if (phase === "image-baseline") {
      assert.equal(
        producer.runId,
        env.GITHUB_RUN_ID,
        "Only the original run may record the baseline.",
      );
      const previous: Record<string, string | null> = {};
      for (const target of targets) {
        await verifyGhcr(target.destination, target.digest, `sha-${producer.sourceSha}`);
        previous[target.image] = remoteTagDigest(target.destination, alias, authfile);
      }
      await save(path, { ...expected, previous });
      return;
    }
    const original = await json(path);
    const previous: Record<string, unknown> = {};
    for (const target of targets) {
      const digest = field(field(original, "previous"), target.image);
      if (digest !== null) {
        match(digest, digestPattern);
      }
      previous[target.image] = digest;
    }
    assert.deepEqual(
      original,
      { ...expected, previous },
      "Inputs or archives differ from the original publication.",
    );
    for (const target of targets) {
      aliasDigest(target, alias, previous, authfile);
    }
    const digests = new Map(targets.map((target) => [target.image, target.digest]));
    const receipt = await publishPrepared(directory, env, producer, verify, undefined, digests);
    await advanceReleaseAliases(targets, alias, previous, authfile, verify);
    await save(
      join(directory, "publication.json"),
      receipt.map((image) => ({ ...image, aliasTag: alias })),
    );
    assert.ok(env.GITHUB_STEP_SUMMARY);
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `Verified both \`${alias}\` aliases from run ${producer.runId}, attempt 1. Full Integration was skipped.\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function registry(phase: string, directory: string, env: NodeJS.ProcessEnv) {
  const imagesOnly = phase === "image-baseline" || phase === "publish-images";
  assert.ok(
    imagesOnly || ["preflight", "immutable", "aliases"].includes(phase),
    "Invalid registry phase.",
  );
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1", "Start a fresh release or recovery dispatch.");
  const sourceSha = env.SOURCE_SHA;
  match(sourceSha, /^[a-f0-9]{40}$/);
  const workflowSha = env.GITHUB_WORKFLOW_SHA;
  match(workflowSha, /^[a-f0-9]{40}$/);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workflowSha,
  );
  execFileSync("git", ["merge-base", "--is-ancestor", sourceSha, workflowSha]);
  match(env.PRODUCER_RUN_ID, integerPattern);
  assert.equal(env.PRODUCER_ATTEMPT, "1");
  assert.ok(env.GITHUB_EVENT_PATH);
  const inputs = field(await json(env.GITHUB_EVENT_PATH), "inputs");
  assert.equal(field(inputs, "images_only") === "true", imagesOnly, "Unexpected release mode.");
  assert.equal(field(inputs, "source_sha"), sourceSha);
  assert.equal(field(inputs, "image_tag") ?? "", env.IMAGE_TAG ?? "");
  assert.equal(field(inputs, "recovery_run_id") || env.GITHUB_RUN_ID, env.PRODUCER_RUN_ID);
  if (phase !== "preflight") {
    assert.equal(
      field(inputs, "publish"),
      "true",
      "Release OCE must explicitly select publication.",
    );
  }
  const recovery = env.PRODUCER_RUN_ID !== env.GITHUB_RUN_ID;
  const producerWorkflowSha = recovery
    ? await verifyProducer({
        ...env,
        IMAGES_ONLY: String(imagesOnly),
        RECOVERY_RUN_ID: env.PRODUCER_RUN_ID,
      })
    : workflowSha;
  const verify = async () => {
    await verifyMainSource(env, releaseWorkflow);
    if (phase !== "preflight") {
      await verifyEnvironment();
    }
  };
  await verify();
  const producer = {
    sourceSha,
    workflowSha: producerWorkflowSha,
    runId: env.PRODUCER_RUN_ID,
    attempt: env.PRODUCER_ATTEMPT,
    nodeBaseImage: readReleaseNodeBase(sourceSha),
  };
  if (imagesOnly) {
    await imagePublication(phase, directory, env, producer, verify);
    return;
  }
  const chartEnv = { ...env, NODE_BASE_IMAGE: producer.nodeBaseImage };
  const prepared = await json(join(directory, "chart/chart-preparation.json"));
  const version = await readChartVersion(sourceSha);
  const archive = join(directory, "chart", `openclaw-enterprise-${version}.tgz`);
  const targets = images.map((image) => {
    const destination = env[`GHCR_${image.toUpperCase()}_IMAGE`];
    ghcrPackageName(destination);
    assert.ok(destination);
    const reference = field(prepared, image);
    assert.ok(typeof reference === "string");
    const digest = reference.split("@")[1];
    match(digest, digestPattern);
    assert.equal(reference, `${destination}@${digest}`, "Prepared chart uses a different image.");
    return { image, destination, digest };
  });
  assert.notEqual(targets[0]?.destination, targets[1]?.destination);
  const [controller, runtime] = targets;
  assert.ok(controller && runtime);
  const { chartSha256 } = await verifyPreparedReleaseChart(
    archive,
    chartEnv,
    producer,
    `${controller.destination}@${controller.digest}`,
    `${runtime.destination}@${runtime.digest}`,
    version,
  );
  const alias = publicationAlias(env.IMAGE_TAG);
  const temporary = await mkdtemp(join(tmpdir(), "oce-release-registry-"));
  const authfile = join(temporary, "auth.json");
  try {
    skopeoLogin("ghcr.io", authfile, env.GITHUB_ACTOR, env.GH_TOKEN);
    const chartDigest = await verifyChartTag(version, chartSha256, authfile);
    const previous: Record<string, unknown> = {};
    for (const image of targets) {
      for (const tag of [`sha-${sourceSha}`, version]) {
        const listed = await verifyGhcr(image.destination, image.digest, tag);
        const actual = remoteTagDigest(image.destination, tag, authfile, listed);
        if (actual !== null || phase === "aliases") {
          assert.equal(actual, image.digest, `Conflicting or missing ${image.destination}:${tag}.`);
        }
        console.log(`${image.destination}:${tag}: ${actual ?? "pending"}`);
      }
      previous[image.image] = remoteTagDigest(image.destination, alias, authfile);
    }
    const identity = { ...producer, version, alias, targets, chartSha256 };
    const path = join(directory, "baseline.json");
    if (phase === "preflight" && !recovery) {
      await save(path, { ...identity, previous });
    }
    const saved = await json(path);
    const baseline = field(saved, "previous");
    assert.ok(baseline && typeof baseline === "object" && !Array.isArray(baseline));
    const prior: Record<string, unknown> = Object.fromEntries(Object.entries(baseline));
    assert.deepEqual(
      saved,
      { ...identity, previous: prior },
      "The original publication baseline does not match this release.",
    );
    for (const image of targets) {
      if (prior[image.image] !== null) {
        match(prior[image.image], digestPattern, "Missing original alias digest.");
      }
      aliasDigest(image, alias, prior, authfile);
    }
    const summary = env.GITHUB_STEP_SUMMARY;
    assert.ok(summary);
    await appendFile(
      summary,
      `\nOCE ${version}, commit \`${sourceSha}\`, alias \`${alias}\`. Original run ${producer.runId}, attempt ${producer.attempt}. Chart archive SHA-256 \`${chartSha256}\`.\n` +
        targets
          .map(
            (image) =>
              `- ${image.image}: \`${image.destination}@${image.digest}\`. Previous alias: \`${prior[image.image] ?? "absent"}\`.\n`,
          )
          .join(""),
    );
    if (phase === "preflight") {
      return;
    }
    const receiptPath = join(directory, "publication.json");
    if (phase === "immutable") {
      const digests = new Map(targets.map((target) => [target.image, target.digest]));
      const receipt = await publishPrepared(directory, env, producer, verify, undefined, digests);
      await save(receiptPath, receipt);
      await publishChart(directory, chartEnv, {
        archive,
        runId: producer.runId,
        attempt: producer.attempt,
        workflowSha: producer.workflowSha,
        releaseVersion: version,
        verify,
      });
      return;
    }
    const receipt = validateImageReceipt(await json(receiptPath), {
      sourceSha,
      runId: producer.runId,
      attempt: producer.attempt,
      workflowSha: producer.workflowSha,
      controllerImage: env.GHCR_CONTROLLER_IMAGE,
      runtimeImage: env.GHCR_RUNTIME_IMAGE,
    });
    for (const target of targets) {
      assert.equal(receipt.find((image) => image.image === target.image)?.digest, target.digest);
    }
    const chart = await json(join(directory, "chart-publication.json"));
    assert.ok(chartDigest);
    assert.equal(
      field(field(chart, "chart"), "digest"),
      chartDigest,
      "Published chart digest changed.",
    );
    await advanceReleaseAliases(targets, alias, prior, authfile, verify);
    await save(
      receiptPath,
      receipt.map((image) => ({ ...image, aliasTag: alias })),
    );
    await appendFile(
      summary,
      `Verified both \`${alias}\` aliases after immutable chart \`${chartPackage}@${chartDigest}\` and CLI publication.\n`,
    );
  } finally {
    try {
      await reportRegistryState(env, targets, sourceSha, version, alias, authfile);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [phase, directory] = process.argv.slice(2);
  assert.ok(phase && directory);
  await registry(phase, directory, process.env);
}
