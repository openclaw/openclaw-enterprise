#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { constants, createZstdCompress } from "node:zlib";

const execute = promisify(execFile);
const docker = process.env.OCC_DOCKER_BIN ?? "docker";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

async function archiveHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function saveRuntimeImage(directory, imageId, sourceSha) {
  assert.match(imageId, imageIdPattern);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  await mkdir(directory, { recursive: true });
  const tar = join(directory, "runtime.tar");
  const archive = `${tar}.zst`;
  // Export by immutable ID, without a shared mutable tag on the consumer.
  await execute(docker, ["save", "--output", tar, imageId]);
  try {
    // Docker loads zstd directly. Storing this in an uncompressed Actions ZIP
    // avoids single-threaded ZIP inflation of the full image at download time.
    await pipeline(
      createReadStream(tar),
      createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 1 } }),
      createWriteStream(archive),
    );
  } finally {
    await rm(tar, { force: true });
  }
  await writeFile(
    join(directory, "metadata.json"),
    JSON.stringify({ sourceSha, imageId, archiveSha256: await archiveHash(archive) }),
  );
}

export async function loadRuntimeImage(directory, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
  assert.equal(metadata.sourceSha, sourceSha, "Runtime image source does not match checkout.");
  assert.match(metadata.imageId ?? "", imageIdPattern);
  assert.match(metadata.archiveSha256 ?? "", /^[a-f0-9]{64}$/);
  const archive = join(directory, "runtime.tar.zst");
  assert.equal(
    await archiveHash(archive),
    metadata.archiveSha256,
    "Runtime archive checksum mismatch.",
  );
  const loaded = await execute(docker, ["load", "--input", archive]);
  assert.equal(
    loaded.stdout.trim(),
    `Loaded image ID: ${metadata.imageId}`,
    "Runtime archive does not contain the recorded image identity.",
  );
  const { stdout } = await execute(docker, [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    metadata.imageId,
  ]);
  assert.equal(stdout.trim(), metadata.imageId, "Imported runtime image identity mismatch.");
  return metadata.imageId;
}

async function waitForArtifact() {
  const name = process.env.OPENCLAW_CI_RUNTIME_ARTIFACT;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  assert.equal(name, "ci-runtime-image");
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(runId ?? "", /^\d+$/);
  assert.ok(process.env.GH_TOKEN, "Artifact discovery requires the workflow token.");
  const endpoint = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  async function read(path) {
    const response = await fetch(`${endpoint}/${path}`, {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    assert.ok(response.ok, `Runtime artifact discovery failed: HTTP ${response.status}.`);
    return response.json();
  }
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const artifacts = await read(`artifacts?name=${name}`);
    if (artifacts.artifacts?.some((artifact) => artifact.name === name && !artifact.expired)) {
      return;
    }
    const jobs = await read("jobs?filter=latest&per_page=100");
    const producer = jobs.jobs?.find((job) => job.name === "Build Shared Runtime Image");
    if (producer?.status === "completed") {
      assert.equal(producer.conclusion, "success", "Shared runtime build did not succeed.");
    }
    await delay(5_000);
  }
  throw new Error("Timed out waiting for the same-run runtime image artifact.");
}

async function main() {
  if (process.argv[2] === "--wait") {
    await waitForArtifact();
    return;
  }
  const [directory, ...extra] = process.argv.slice(2);
  assert.ok(directory && extra.length === 0, "Usage: runtime-image.mjs <artifact-directory>");
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  const sourceSha = stdout.trim();
  assert.equal(sourceSha, process.env.GITHUB_SHA, "Build source must match the workflow commit.");
  await mkdir(directory, { recursive: true });
  const iidfile = join(directory, "image-id");
  const started = Date.now();
  await execute(
    docker,
    [
      "build",
      "--builder",
      "default",
      "--load",
      "--pull=false",
      "--iidfile",
      iidfile,
      "-f",
      "deploy/runtime/Dockerfile",
      ".",
    ],
    { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 },
  );
  process.stderr.write(
    `Runtime build completed in ${Math.round((Date.now() - started) / 1000)}s.\n`,
  );
  await saveRuntimeImage(directory, (await readFile(iidfile, "utf8")).trim(), sourceSha);
  process.stderr.write(
    `Runtime export completed in ${Math.round((Date.now() - started) / 1000)}s total.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
