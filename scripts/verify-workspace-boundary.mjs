import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

async function sourceFiles(directory) {
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
      return entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name) ? [path] : [];
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
  const applicationManifest = JSON.parse(
    await readFile(join(repositoryRoot, "apps", name, "package.json"), "utf8"),
  );
  assert.equal(
    applicationManifest.name,
    `@openclaw-enterprise/${name}`,
    `The ${name} application must belong to the active enterprise workspace.`,
  );
}

const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
assert.doesNotMatch(
  JSON.stringify(manifest.scripts ?? {}),
  /(?:^|[\s./])legacy\//,
  "Root workspace scripts must never execute archived implementation code.",
);

const tsconfig = JSON.parse(await readFile(join(repositoryRoot, "tsconfig.json"), "utf8"));
assert.ok(
  tsconfig.exclude?.some((path) => path === "legacy" || path.startsWith("legacy/")),
  "The TypeScript solution must explicitly exclude legacy/.",
);

const references = new Set((tsconfig.references ?? []).map(({ path }) => path));
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
  for (const entrypoint of ["index.ts", "server.mjs"]) {
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
    const resolved = specifier.startsWith(".")
      ? relative(repositoryRoot, join(dirname(source), specifier))
      : specifier;
    assert.ok(
      resolved !== "legacy" && !resolved.startsWith("legacy/"),
      `${relative(repositoryRoot, source)} imports archived code through ${specifier}.`,
    );
  }
}

process.stdout.write(
  "Workspace boundary verified: " +
    `${activeApplications.length} application, ${activePackages.length} packages, ` +
    `${activeGoPackages.length} Go packages, ${sources.length} sources, legacy excluded.\n`,
);
