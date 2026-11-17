// External Sandbox conformance kit (RFC-0040), AC-7, static half: core and its tests name no
// Sandbox provider. A provider's adapter lives in its own package (today the example under
// deploy/examples/) with its own tests; the kit's dynamic half is the rest of this kit plus the
// existing OpenShell suites.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Core: product code, the chart, the runtime image, reference and flow docs, and core tests.
const CORE = [
  "apps/controller/src",
  "packages",
  "deploy/helm",
  "deploy/runtime",
  "docs/reference",
  "docs/flows",
  "tests/conformance",
  "tests/integration",
  "tests/helpers",
  "tests/fixtures",
];
// Known external Sandbox providers, assembled so this file does not name them itself.
const PROVIDERS = [["Str", "ands"].join("")];
const PROVIDER_NAME = new RegExp(
  PROVIDERS.flatMap((name) => [
    name,
    `${name.toLowerCase()}[-_]`,
    `${name.toLowerCase()}(?=Box|Agents)`,
  ]).join("|") + "|\\bbox[-_]?owner",
  "i",
);
// The example package's own tests are not core. They follow the package's name prefix.
const providerTest = (path: string) =>
  PROVIDERS.some((name) =>
    /^tests\/(?:conformance|integration|helpers)\//.test(path)
      ? path
          .split("/")
          .at(-1)!
          .toLowerCase()
          .startsWith(name.toLowerCase() + "-")
      : false,
  );
const TEXT = /\.(?:[cm]?[jt]s|json|ya?ml|tpl|md|patch|txt)$|Dockerfile$/;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name === "dist" ? [] : files(path);
      }
      return entry.isFile() && TEXT.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

test("core and its tests name no external Sandbox provider", async () => {
  const self = relative(root, fileURLToPath(import.meta.url));
  const offenders: string[] = [];
  for (const path of (await Promise.all(CORE.map(files))).flat()) {
    if (path === self || providerTest(path)) continue;
    const lines = (await readFile(join(root, path), "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      // Ordinary English ("unstrands", "strands it") is not a provider name.
      if (PROVIDER_NAME.test(line.replace(/\b(?:un)?strands\s+(?:it|an|the|a)\b/gi, ""))) {
        offenders.push(`${path}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
