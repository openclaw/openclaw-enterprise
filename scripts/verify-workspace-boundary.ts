import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRepositoryCredentialBoundary } from "./verify-repository-credentials-boundary.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const activeApplications = ["controller"];
const activePackages = ["utils", "contracts", "occ", "iam", "audit"];
const activeGoPackages = ["cmd/occ", "internal/occcli", "internal/occclient", "internal/occdev"];
const activeSourceRoots = [
  ...activeApplications.map((name) => `apps/${name}/src`),
  ...activePackages.map((name) => `packages/${name}/src`),
  "scripts",
  "tests/conformance",
  "tests/integration",
  "tests/docs",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
  assert.ok(isRecord(value), `${path} must contain a JSON object.`);
  return value;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") {
          return [];
        }
        return sourceFiles(path);
      }
      return entry.isFile() && /\.(?:m?ts|mjs)$/.test(entry.name) ? [path] : [];
    }),
  );
  return files.flat();
}

const workspace = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
assert.match(workspace, /^packages:/m, "The root pnpm workspace must declare its packages.");
assert.match(workspace, /["']?!legacy(?:\/\*\*)?["']?/, "legacy/ must be explicitly excluded.");

const goModule = await readFile(join(repositoryRoot, "go.mod"), "utf8");
assert.match(
  goModule,
  /^module github\.com\/openclaw\/openclaw-enterprise$/m,
  "The Go module must use the OpenClaw Enterprise module path.",
);
for (const packagePath of activeGoPackages) {
  const entries = await readdir(join(repositoryRoot, packagePath), { withFileTypes: true });
  assert.ok(
    entries.some((entry) => entry.isFile() && entry.name.endsWith(".go")),
    `The active Go package ${packagePath} must contain Go source.`,
  );
}

for (const name of activePackages) {
  assert.match(
    workspace,
    new RegExp(`(?:^|\\s)packages/${name}(?:\\s|$)`, "m"),
    `The active ${name} package must be explicitly selected.`,
  );
}

for (const name of activeApplications) {
  assert.match(
    workspace,
    new RegExp(`(?:^|\\s)apps/${name}(?:\\s|$)`, "m"),
    `The active ${name} application must be explicitly selected.`,
  );
  const applicationManifest = await readJsonObject(`apps/${name}/package.json`);
  assert.equal(
    applicationManifest.name,
    `@openclaw-enterprise/${name}`,
    `The ${name} application must belong to the active enterprise workspace.`,
  );
}

const manifest = await readJsonObject("package.json");
const scripts = manifest.scripts ?? {};
assert.ok(isRecord(scripts), "Root workspace scripts must be a JSON object.");
for (const [name, command] of Object.entries(scripts)) {
  assert.ok(typeof command === "string", `Root workspace script ${name} must be a string.`);
  assert.doesNotMatch(
    command,
    /(?:^|[\s./])legacy\//,
    "Root workspace scripts must never execute archived implementation code.",
  );
}

const tsconfig = await readJsonObject("tsconfig.json");
assert.ok(
  isArray(tsconfig.exclude) &&
    tsconfig.exclude.some(
      (path) => typeof path === "string" && (path === "legacy" || path.startsWith("legacy/")),
    ),
  "The TypeScript solution must explicitly exclude legacy/.",
);

const projectReferences = tsconfig.references ?? [];
assert.ok(isArray(projectReferences), "TypeScript project references must be a JSON array.");
const references = new Set(
  projectReferences.map((reference) => {
    assert.ok(
      isRecord(reference) && typeof reference.path === "string",
      "Each TypeScript project reference must provide a path.",
    );
    return reference.path;
  }),
);
for (const name of activePackages) {
  assert.ok(references.has(`./packages/${name}`), `Missing ${name} TypeScript project reference.`);
}
for (const name of activeApplications) {
  assert.ok(references.has(`./apps/${name}`), `Missing ${name} TypeScript project reference.`);
}
assert.equal(
  references.size,
  activePackages.length + activeApplications.length,
  "The solution contains an unexpected project.",
);

const sources = (
  await Promise.all(activeSourceRoots.map((path) => sourceFiles(join(repositoryRoot, path))))
).flat();
for (const name of activeApplications) {
  const entrypoints = ["index.ts", "server.mjs"];
  for (const entrypoint of entrypoints) {
    assert.ok(
      sources.includes(join(repositoryRoot, "apps", name, "src", entrypoint)),
      `The ${name} application must provide its ${entrypoint} entrypoint.`,
    );
  }
}
for (const source of sources) {
  const content = await readFile(source, "utf8");
  for (const [, specifier] of content.matchAll(
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
  )) {
    assert.ok(specifier);
    const resolved = specifier.startsWith(".")
      ? relative(repositoryRoot, join(dirname(source), specifier))
      : specifier;
    assert.ok(
      resolved !== "legacy" && !resolved.startsWith("legacy/"),
      `${relative(repositoryRoot, source)} imports archived code through ${specifier}.`,
    );
  }
}

const credentialSources = await verifyRepositoryCredentialBoundary();

process.stdout.write(
  "Workspace boundary verified: " +
    `${activeApplications.length} application, ${activePackages.length} packages, ` +
    `${activeGoPackages.length} Go packages, ${sources.length} sources, legacy excluded; ` +
    `${credentialSources} credential sources checked.\n`,
);
