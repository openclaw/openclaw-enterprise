import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultSourcePath = new URL("../../deploy/runtime/openclaw-source.json", import.meta.url);

export async function readOpenclawSource(path = defaultSourcePath) {
  const source = JSON.parse(await readFile(path, "utf8"));
  if (
    source === null ||
    Array.isArray(source) ||
    typeof source !== "object" ||
    Object.keys(source).sort().join(",") !== "buildTimestamp,commit,sourceArchiveSha256" ||
    typeof source.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source.commit) ||
    typeof source.sourceArchiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.sourceArchiveSha256) ||
    typeof source.buildTimestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(source.buildTimestamp) ||
    !Number.isFinite(Date.parse(source.buildTimestamp)) ||
    new Date(source.buildTimestamp).toISOString() !== source.buildTimestamp.replace(/Z$/u, ".000Z")
  ) {
    throw new Error(`Invalid OpenClaw source manifest: ${path}`);
  }
  return source;
}

export function openclawBuildValues(source) {
  return {
    OPENCLAW_COMMIT: source.commit,
    OPENCLAW_SOURCE_SHA256: source.sourceArchiveSha256,
    OPENCLAW_BUILD_TIMESTAMP: source.buildTimestamp,
  };
}

export function openclawBuildArguments(source) {
  return Object.entries(openclawBuildValues(source)).flatMap(([key, value]) => [
    "--build-arg",
    `${key}=${value}`,
  ]);
}

export function verifyOpenclawBuild(source, env = process.env) {
  for (const [key, value] of Object.entries(openclawBuildValues(source))) {
    if (env[key] !== value) {
      throw new Error(
        `${key} must match deploy/runtime/openclaw-source.json; pass the arguments from node scripts/lib/openclaw-source.mjs build-args`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, path, ...extra] = process.argv.slice(2);
  if (!["build-args", "verify"].includes(command) || extra.length > 0) {
    throw new Error("Usage: node scripts/lib/openclaw-source.mjs <build-args|verify> [manifest]");
  }
  const source = await readOpenclawSource(path);
  if (command === "verify") {
    verifyOpenclawBuild(source);
  } else {
    for (const [key, value] of Object.entries(openclawBuildValues(source))) {
      console.log(`${key}=${value}`);
    }
  }
}
