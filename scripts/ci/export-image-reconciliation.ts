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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readState(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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
  const images: { id: string; name: string; status: "planned" | "ready" }[] = [];
  const imageIds = new Set<string>();
  const imageRoles = new Set<string>();
  let tagBase: string | undefined;
  if (state !== undefined) {
    if (
      !isRecord(state) ||
      state.version !== 1 ||
      state.lane !== "images-packaging" ||
      !isRecord(state.ciRun) ||
      state.ciRun.id !== id ||
      state.ciRun.attempt !== attempt ||
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
    const resources: unknown[] = state.resources;
    for (const resource of resources) {
      if (!isRecord(resource)) {
        throw new Error("Image CI resource is invalid.");
      }
      if (typeof resource.kind !== "string" || !cleanupResourceKinds.has(resource.kind)) {
        throw new Error("Image CI resource kind is invalid.");
      }
      if (resource.kind !== "image-tag") {
        continue;
      }
      const name = typeof resource.name === "string" ? resource.name : "";
      const tagParts = name.startsWith(tagPrefix)
        ? /^([a-f0-9]{12})\/(controller|runtime):local$/.exec(name.slice(tagPrefix.length))
        : null;
      // Unique roles also reject duplicate names under this canonical tag grammar.
      if (
        resource.owner !== state.prefix ||
        typeof resource.id !== "string" ||
        !/^image-tag-[a-f0-9]{12}$/.test(resource.id) ||
        (resource.status !== "planned" && resource.status !== "ready") ||
        !tagParts ||
        !tagParts[1] ||
        !tagParts[2] ||
        imageRoles.has(tagParts[2]) ||
        (tagBase !== undefined && tagBase !== tagParts[1]) ||
        imageIds.has(resource.id) ||
        images.length >= 2
      ) {
        throw new Error("Image CI resource identity is invalid.");
      }
      imageIds.add(resource.id);
      imageRoles.add(tagParts[2]);
      tagBase = tagParts[1];
      images.push({ id: resource.id, name, status: resource.status });
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

main().catch((error: unknown) => {
  process.stderr.write(
    `Image reconciliation export failed: ${error instanceof Error ? error.name : undefined}\n`,
  );
  process.exitCode = 1;
});
