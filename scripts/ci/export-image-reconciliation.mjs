#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const cleanupResourceKinds = new Set([
  "ci-otel-backend",
  "postgres-database",
  "compose-postgres",
  "k3d-image",
  "k3d-cluster",
  "image-tag",
]);

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function main() {
  const [stateArgument, outputArgument] = process.argv.slice(2);
  const id = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (
    !stateArgument ||
    !outputArgument ||
    !/^[1-9][0-9]*$/.test(id ?? "") ||
    !/^[1-9][0-9]*$/.test(attempt ?? "")
  ) {
    throw new Error("Expected a state path, output directory, and valid CI run and attempt.");
  }
  const state = await readState(resolve(stateArgument));
  const images = [];
  const imageIds = new Set();
  const imageNames = new Set();
  const imageRoles = new Set();
  let tagBase;
  if (state !== undefined) {
    if (
      state === null ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      state.version !== 1 ||
      state.lane !== "images-packaging" ||
      state.ciRun?.id !== id ||
      state.ciRun?.attempt !== attempt ||
      !Array.isArray(state.resources) ||
      typeof state.prefix !== "string" ||
      !/^openclaw-ci-[a-z0-9-]+$/.test(state.prefix) ||
      state.prefix.length > 48
    ) {
      throw new Error("Image CI state does not match the current run and attempt.");
    }
    const label = createHash("sha256")
      .update(JSON.stringify([id, attempt, state.prefix]))
      .digest("hex")
      .slice(0, 17);
    const tagPrefix = `localhost/openclaw-ci-image-${label}-`;
    for (const resource of state.resources) {
      if (resource === null || typeof resource !== "object" || Array.isArray(resource)) {
        throw new Error("Image CI resource is invalid.");
      }
      if (typeof resource.kind !== "string" || !cleanupResourceKinds.has(resource.kind)) {
        throw new Error("Image CI resource kind is invalid.");
      }
      if (resource.kind !== "image-tag") {
        continue;
      }
      const tagParts =
        typeof resource.name === "string" && resource.name.startsWith(tagPrefix)
          ? /^([a-f0-9]{12})\/(controller|runtime):local$/.exec(
              resource.name.slice(tagPrefix.length),
            )
          : null;
      if (
        resource.owner !== state.prefix ||
        typeof resource.id !== "string" ||
        !/^image-tag-[a-f0-9]{12}$/.test(resource.id) ||
        !["planned", "ready"].includes(resource.status) ||
        !tagParts ||
        imageRoles.has(tagParts[2]) ||
        (tagBase !== undefined && tagBase !== tagParts[1]) ||
        imageIds.has(resource.id) ||
        imageNames.has(resource.name) ||
        images.length >= 2
      ) {
        throw new Error("Image CI resource identity is invalid.");
      }
      imageIds.add(resource.id);
      imageNames.add(resource.name);
      imageRoles.add(tagParts[2]);
      tagBase = tagParts[1];
      images.push({ id: resource.id, name: resource.name, status: resource.status });
    }
  }
  const output = resolve(outputArgument);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(
    join(output, `images-${id}-${attempt}.json`),
    `${JSON.stringify({ version: 1, run: { id, attempt }, state: state === undefined ? "unavailable" : "present", images }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

main().catch((error) => {
  process.stderr.write(`Image reconciliation export failed: ${error.name}\n`);
  process.exitCode = 1;
});
