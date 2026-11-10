import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface OpenclawSource {
  commit: string;
  sourceArchiveSha256: string;
  buildTimestamp: string;
}

const defaultSourcePath = new URL("../../deploy/runtime/openclaw-source.json", import.meta.url);

function isOpenclawSource(source: unknown): source is OpenclawSource {
  return !(
    source === null ||
    Array.isArray(source) ||
    typeof source !== "object" ||
    Object.keys(source).sort().join(",") !== "buildTimestamp,commit,sourceArchiveSha256" ||
    !("commit" in source) ||
    typeof source.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source.commit) ||
    !("sourceArchiveSha256" in source) ||
    typeof source.sourceArchiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.sourceArchiveSha256) ||
    !("buildTimestamp" in source) ||
    typeof source.buildTimestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(source.buildTimestamp) ||
    !Number.isFinite(Date.parse(source.buildTimestamp)) ||
    new Date(source.buildTimestamp).toISOString() !== source.buildTimestamp.replace(/Z$/u, ".000Z")
  );
}

export async function readOpenclawSource(
  path: string | URL = defaultSourcePath,
): Promise<OpenclawSource> {
  const source: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isOpenclawSource(source)) {
    throw new Error(`Invalid OpenClaw source manifest: ${path}`);
  }
  return source;
}

export function openclawBuildValues(source: OpenclawSource) {
  return {
    OPENCLAW_COMMIT: source.commit,
    OPENCLAW_SOURCE_SHA256: source.sourceArchiveSha256,
    OPENCLAW_BUILD_TIMESTAMP: source.buildTimestamp,
  };
}

export function openclawBuildArguments(source: OpenclawSource): string[] {
  return Object.entries(openclawBuildValues(source)).flatMap(([key, value]) => [
    "--build-arg",
    `${key}=${value}`,
  ]);
}

export function verifyOpenclawBuild(source: OpenclawSource, env: NodeJS.ProcessEnv = process.env) {
  for (const [key, value] of Object.entries(openclawBuildValues(source))) {
    if (env[key] !== value) {
      throw new Error(
        `${key} must match deploy/runtime/openclaw-source.json; pass the arguments from node scripts/lib/openclaw-source.mjs build-args`,
      );
    }
  }
}

export async function runOpenclawSourceCli(args: readonly string[] = process.argv.slice(2)) {
  const [command, path, ...extra] = args;
  if ((command !== "build-args" && command !== "verify") || extra.length > 0) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runOpenclawSourceCli();
}
