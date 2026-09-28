import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const checker = join(repositoryRoot, "scripts/verify-module-boundaries.mjs");
const policyPath = join(repositoryRoot, "scripts/module-boundaries/policy.json");
const exceptionsPath = join(repositoryRoot, "scripts/module-boundaries/exceptions.json");

function check(root) {
  const result = spawnSync(
    process.execPath,
    [checker, "--root", root, "--policy", policyPath, "--exceptions", exceptionsPath, "--json"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, "");
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test("repository source obeys its dependency policy with exact current exceptions", () => {
  const { status, report } = check(repositoryRoot);
  assert.equal(status, 0, JSON.stringify(report.violations, null, 2));
  assert.deepEqual(report.violations, []);
});

test("repository policy allows a public root and rejects a new HTTP Driver import", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-module-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  // Use the real source and manifests so the existing baseline remains applicable.
  for (const sourceRoot of policy.sourceRoots) {
    await cp(join(repositoryRoot, sourceRoot), join(root, sourceRoot), {
      recursive: true,
    });
  }
  for (const packageRoot of policy.packages) {
    await cp(
      join(repositoryRoot, packageRoot, "package.json"),
      join(root, packageRoot, "package.json"),
    );
  }
  const source = "apps/controller/src/routes/policy-probe.ts";
  const probe = join(root, source);
  await mkdir(dirname(probe), { recursive: true });
  // A public root stays valid even if production consumers choose another supported export.
  const allowedImport = 'import type { Agent } from "@openclaw-enterprise/contracts";\n';
  await writeFile(probe, allowedImport);
  const allowed = check(root);
  assert.equal(allowed.status, 0, JSON.stringify(allowed.report.violations));
  assert.ok(
    allowed.report.edges.some(
      (edge) =>
        edge.from === source &&
        edge.to === "packages/contracts/src/index.ts" &&
        edge.specifier === "@openclaw-enterprise/contracts" &&
        edge.typeOnly,
    ),
  );
  await writeFile(probe, allowedImport + 'import "../drivers/compute/docker/index.ts";\n');
  const rejected = check(root);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.report.violations.length, 1, JSON.stringify(rejected.report.violations));
  const diagnostic = rejected.report.violations[0];
  assert.equal(diagnostic.rule, "http-to-provider");
  assert.equal(diagnostic.from, source);
  assert.equal(diagnostic.to, "apps/controller/src/drivers/compute/docker/index.ts");
});
