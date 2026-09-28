#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexBwrapProfileArtifact, stableJson } from "./lib/codex-seccomp-profile.mjs";

const knownOptions = new Set(["baseline", "codex-version", "out", "provenance-out"]);

function usage() {
  return `Usage: node scripts/generate-codex-seccomp.mjs --baseline <runtime-default.json> --codex-version <version> --out <profile.json> [--provenance-out <metadata.json>]

Generates the reviewed Codex bubblewrap localhost seccomp profile from an operator-captured
RuntimeDefault OCI seccomp baseline. Output files are immutable: existing paths are refused.`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (!knownOptions.has(name)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (Object.hasOwn(options, name)) {
      throw new Error(`Duplicate option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

function extractSeccompProfile(captured) {
  const profile =
    captured?.defaultAction !== undefined
      ? captured
      : (captured?.linux?.seccomp ??
        captured?.runtimeSpec?.linux?.seccomp ??
        captured?.info?.runtimeSpec?.linux?.seccomp ??
        captured?.status?.info?.runtimeSpec?.linux?.seccomp);

  assert.ok(
    profile,
    "Captured baseline JSON must be a RuntimeDefault seccomp profile or an OCI runtimeSpec containing linux.seccomp.",
  );
  return profile;
}

async function assertNewFile(path, label) {
  try {
    await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const baselinePath = options.baseline;
  const codexVersion = options["codex-version"];
  const outputPath = options.out;
  assert.ok(baselinePath, "--baseline is required.");
  assert.ok(codexVersion, "--codex-version is required.");
  assert.ok(outputPath, "--out is required.");

  const profilePath = resolve(outputPath);
  const provenancePath = resolve(options["provenance-out"] ?? `${outputPath}.provenance.json`);
  assert.notEqual(
    profilePath,
    provenancePath,
    "--out and --provenance-out must be different paths.",
  );

  const baseline = extractSeccompProfile(JSON.parse(await readFile(resolve(baselinePath), "utf8")));
  const artifact = buildCodexBwrapProfileArtifact({ baseline, codexVersion });

  await assertNewFile(profilePath, "Codex seccomp profile output");
  await assertNewFile(provenancePath, "Codex seccomp provenance output");
  await writeFile(profilePath, artifact.profileJson, { flag: "wx", mode: 0o644 });
  await chmod(profilePath, 0o644);
  await writeFile(provenancePath, stableJson(artifact.provenance), { flag: "wx", mode: 0o644 });
  await chmod(provenancePath, 0o644);

  process.stdout.write(
    stableJson({
      profilePath,
      provenancePath,
      profileSha256: artifact.provenance.profileSha256,
      runtimeDefaultSha256: artifact.provenance.runtimeDefaultSha256,
      codexVersion: artifact.provenance.codexVersion,
      architectures: artifact.provenance.architectures,
      addedRules: artifact.provenance.addedRules,
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { extractSeccompProfile, main, parseArgs };
