#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexBwrapProfileArtifact, stableJson } from "./lib/codex-seccomp-profile.ts";

type ValueOption = "baseline" | "codex-version" | "out" | "provenance-out";
type Options = Partial<Record<ValueOption, string>> & { help?: boolean };

function isValueOption(name: string): name is ValueOption {
  return (
    name === "baseline" || name === "codex-version" || name === "out" || name === "provenance-out"
  );
}

function usage() {
  return `Usage: node scripts/generate-codex-seccomp.mjs --baseline <runtime-default.json> --codex-version <version> --out <profile.json> [--provenance-out <metadata.json>]

Generates the reviewed Codex bubblewrap localhost seccomp profile from an operator-captured
RuntimeDefault OCI seccomp baseline. Output files are immutable: existing paths are refused.`;
}

function parseArgs(argv: string[]) {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === undefined || !arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (!isValueOption(name)) {
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

// Captures can be direct profiles or one of the supported OCI inspection envelopes.
function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function seccompFromRuntimeSpec(value: unknown): unknown {
  return property(property(value, "linux"), "seccomp");
}

function extractSeccompProfile(captured: unknown): unknown {
  const profile =
    property(captured, "defaultAction") !== undefined
      ? captured
      : (seccompFromRuntimeSpec(captured) ??
        seccompFromRuntimeSpec(property(captured, "runtimeSpec")) ??
        seccompFromRuntimeSpec(property(property(captured, "info"), "runtimeSpec")) ??
        seccompFromRuntimeSpec(
          property(property(property(captured, "status"), "info"), "runtimeSpec"),
        ));

  assert.ok(
    profile,
    "Captured baseline JSON must be a RuntimeDefault seccomp profile or an OCI runtimeSpec containing linux.seccomp.",
  );
  return profile;
}

async function assertNewFile(path: string, label: string) {
  try {
    await stat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { extractSeccompProfile, main, parseArgs };
