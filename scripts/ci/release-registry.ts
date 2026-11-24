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
  releaseWorkflow,
  publicationAlias,
  validatePackage,
  verifyCi,
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
} from "./container-release/metadata.ts";
import { readChartVersion, verifyPreparedReleaseChart } from "./prepare-release-chart.ts";
import { publishPrepared } from "./container-release/publication.ts";
import {
  inspectDigest,
  remoteTagDigest,
  skopeo,
  skopeoLogin,
} from "./container-release/registry.ts";

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

async function registry(phase: string, directory: string, env: NodeJS.ProcessEnv) {
  assert.ok(["preflight", "immutable", "aliases"].includes(phase), "Invalid registry phase.");
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
  for (const key of ["PRODUCER_RUN_ID", "CI_RUN_ID", "CI_ATTEMPT"]) {
    match(env[key], integerPattern);
  }
  assert.equal(env.PRODUCER_ATTEMPT, "1");
  assert.ok(env.GITHUB_EVENT_PATH);
  const inputs = field(await json(env.GITHUB_EVENT_PATH), "inputs");
  assert.equal(field(inputs, "source_sha"), sourceSha);
  assert.equal(field(inputs, "ci_run_id"), env.CI_RUN_ID);
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
  if (!recovery) {
    assert.equal(sourceSha, env.GITHUB_WORKFLOW_SHA);
  }
  const verify = async () => {
    await verifyMainSource(env, releaseWorkflow);
    await verifyCi(env);
    if (phase !== "preflight") {
      await verifyEnvironment();
    }
  };
  await verify();
  const producer = {
    sourceSha,
    workflowSha: sourceSha,
    runId: env.PRODUCER_RUN_ID,
    attempt: env.PRODUCER_ATTEMPT,
    ciRunId: env.CI_RUN_ID,
    ciAttempt: env.CI_ATTEMPT,
    nodeBaseImage: env.NODE_BASE_IMAGE,
  };
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
    env,
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
      await publishChart(directory, env, {
        archive,
        runId: producer.runId,
        attempt: producer.attempt,
        releaseVersion: version,
        verify,
      });
      return;
    }
    const receipt = validateImageReceipt(await json(receiptPath), {
      sourceSha,
      runId: producer.runId,
      attempt: producer.attempt,
      ciRunId: producer.ciRunId,
      ciAttempt: producer.ciAttempt,
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
