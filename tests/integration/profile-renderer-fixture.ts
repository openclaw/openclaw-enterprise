import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RenderRefusal,
  renderInstallationProfile,
} from "../../scripts/render-installation-profile.ts";
import { syntheticCredentialUrl as credentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { helmTemplate as templateChart } from "../helpers/production-chart.mjs";
import { fileTemporaryDirectory } from "../helpers/temporary-directory.ts";

export const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";

function helmSkipReason(): false | string {
  try {
    execFileSync(helm, ["version", "--short"], { cwd: repository, stdio: "ignore" });
    return false;
  } catch {
    return "Install Helm, or set OCC_HELM_BIN, to verify rendered profile values.";
  }
}

export const helmSkip = helmSkipReason();

type DataRecord = Record<string, unknown>;

function isRecord(value: unknown): value is DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectAt(value: unknown, ...path: string[]): DataRecord {
  const object = propertyAt(value, ...path);
  assert.ok(isRecord(object), `expected an object at ${path.join(".") || "the document root"}`);
  return object;
}

// An intermediate mapping must exist. The leaf can be absent when the caller
// is checking that the renderer omitted a field.
export function propertyAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    assert.ok(isRecord(current), `expected a mapping containing ${key} in ${path.join(".")}`);
    current = current[key];
  }
  return current;
}

export function textAt(value: unknown, ...path: string[]): string {
  const text = propertyAt(value, ...path);
  assert.ok(typeof text === "string", `expected text at ${path.join(".")}`);
  return text;
}

export function arrayAt(value: unknown, ...path: string[]): unknown[] {
  const entries = propertyAt(value, ...path);
  assert.ok(Array.isArray(entries), `expected a list at ${path.join(".")}`);
  return entries;
}

type YamlLoader = (source: string) => unknown;

function isYamlLoader(value: unknown): value is YamlLoader {
  return typeof value === "function";
}

const kubernetesModule: unknown = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");
const yamlLoader = propertyAt(kubernetesModule, "loadYaml");
assert.ok(isYamlLoader(yamlLoader));
export const loadYaml = yamlLoader;

export function computeConfiguration(installation: string): DataRecord {
  return objectAt(loadYaml(installation), "drivers", "compute", "configuration");
}

interface CredentialUrlOptions {
  protocol?: string;
  username: string;
  password: string;
  host: string;
  port?: number;
  pathname?: string;
  search?: string;
}

export function syntheticCredentialUrl(options: CredentialUrlOptions): string {
  return credentialUrl({ ...options, port: options.port });
}

export const helmTemplate: (
  output: { directory: string },
  extraValueFiles?: string[],
  releaseName?: string,
  extraArgs?: string[],
) => string = templateChart;

export function readJson(text: string): unknown {
  return JSON.parse(text);
}

type RendererSummary = Awaited<ReturnType<typeof renderInstallationProfile>>;

function stringList(report: DataRecord, key: string): string[] {
  const list: unknown[] = arrayAt(report, key);
  assert.ok(
    list.every((item): item is string => typeof item === "string"),
    `expected strings in ${key}`,
  );
  return list;
}

export function readPreflight(directory: string) {
  const report = objectAt(readJson(readFileSync(join(directory, "preflight.json"), "utf8")));
  return {
    ok: report.ok,
    profile: report.profile,
    outputs: report.outputs,
    errors: stringList(report, "errors"),
    warnings: stringList(report, "warnings"),
    prerequisites: stringList(report, "prerequisites"),
  };
}

function readRenderedFiles<Summary>(directory: string, summary: Summary) {
  return {
    directory,
    summary,
    values: readFileSync(join(directory, "values.yaml"), "utf8"),
    installation: readFileSync(join(directory, "installation.yaml"), "utf8"),
    preflight: readPreflight(directory),
  };
}

interface ProfileFailure {
  directory: string;
  output: string;
}

const profileFailures = new WeakMap<Error, ProfileFailure>();

function failRender(error: Error, directory: string, output: string): never {
  profileFailures.set(error, { directory, output });
  throw error;
}

export function profileFailure(error: Error): ProfileFailure {
  const failure = profileFailures.get(error);
  assert.ok(failure, "expected a renderer refusal");
  return failure;
}

export function processOutput(error: Error): string {
  const details = objectAt(error);
  return `${details.stdout ?? ""}${details.stderr ?? ""}`;
}

// Runs the renderer CLI as its own process. Cases about argv, the exit status,
// stdout, a copied checkout or process-wide DNS settings use this entry point.
export function renderCli(
  profile: string,
  input: unknown,
  directory = fileTemporaryDirectory(`oce-profile-${profile}-`),
  root = repository,
  dnsServer?: string,
) {
  const inputPath = join(directory, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const dnsPreload = join(directory, "dns-preload.mjs");
  if (dnsServer !== undefined) {
    writeFileSync(
      dnsPreload,
      `import dns from "node:dns/promises"; dns.setServers([${JSON.stringify(dnsServer)}]);\n`,
    );
  }
  let summary: string;
  try {
    summary = execFileSync(
      process.execPath,
      [
        ...(dnsServer === undefined ? [] : ["--import", dnsPreload]),
        "scripts/render-installation-profile.ts",
        "--profile",
        profile,
        "--input",
        inputPath,
        "--out-dir",
        directory,
      ],
      { cwd: root, encoding: "utf8" },
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    failRender(error, directory, processOutput(error));
  }
  return readRenderedFiles(directory, objectAt(readJson(summary)));
}

// Uses the same renderer as the CLI. A diagnostic refusal carries the preflight
// summary the CLI would print to stdout. Unexpected exceptions propagate.
export async function render(
  profile: string,
  input: unknown,
  directory = fileTemporaryDirectory(`oce-profile-${profile}-`),
) {
  const inputPath = join(directory, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  let summary: RendererSummary;
  try {
    summary = await renderInstallationProfile({ profile, input: inputPath, outDir: directory });
  } catch (error) {
    if (!(error instanceof RenderRefusal)) {
      throw error;
    }
    failRender(error, directory, `render-installation-profile: ${error.message}\n`);
  }
  if (!summary.ok) {
    const output = `${JSON.stringify(summary, null, 2)}\n`;
    failRender(new Error(`profile renderer refused the input\n${output}`), directory, output);
  }
  return readRenderedFiles(directory, summary);
}

export async function renderError(callback: () => unknown): Promise<Error> {
  try {
    await callback();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return error;
  }
  assert.fail("expected the profile renderer to reject the input");
}

export async function assertPreflightFailure(
  profile: string,
  input: unknown,
  expected: RegExp,
  absent?: RegExp,
) {
  const { output, directory } = profileFailure(await renderError(() => render(profile, input)));
  assert.match(output, expected);
  if (absent) {
    assert.doesNotMatch(output, absent);
  }
  assert.equal(existsSync(join(directory, "preflight.json")), true);
  assert.equal(existsSync(join(directory, "values.yaml")), false);
  assert.equal(existsSync(join(directory, "installation.yaml")), false);
  const preflight = readPreflight(directory);
  assert.equal(preflight.ok, false);
  assert.match(preflight.errors.join("\n"), expected);
  if (absent) {
    assert.doesNotMatch(preflight.errors.join("\n"), absent);
  }
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export type FieldRefusal = [field: string, values: readonly unknown[], message: string | RegExp];

// Sets a dotted field on a fresh input copy for each refusal, preserving raw
// values so the renderer decides which types and spellings to accept.
export async function assertFieldRefusals(
  profile: string,
  input: DataRecord,
  field: string,
  values: readonly unknown[],
  message: string | RegExp,
) {
  const expected =
    typeof message === "string" ? new RegExp(escapeRegExp(`${field} ${message}`)) : message;
  const keys = field.split(".");
  const key = keys.pop();
  assert.ok(key);
  for (const value of values) {
    const changed = structuredClone(input);
    let parent = changed;
    for (const segment of keys) {
      parent = objectAt((parent[segment] ??= {}));
    }
    parent[key] = value;
    try {
      await assertPreflightFailure(profile, changed, expected);
    } catch (error) {
      // The reporter prints error.stack, captured with the old message, so prefix both.
      if (error instanceof Error) {
        const label = `${profile} ${field} = ${JSON.stringify(value)}: `;
        error.message = `${label}${error.message}`;
        error.stack = `${label}${error.stack}`;
      }
      throw error;
    }
  }
}
