#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
  const archive = join(directory, "runtime.tar");
  // Export by immutable ID, without a shared mutable tag on the consumer.
  await execute(docker, ["save", "--output", archive, imageId]);
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
  const archive = join(directory, "runtime.tar");
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

async function main() {
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
