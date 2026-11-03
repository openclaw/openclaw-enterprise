import assert from "node:assert/strict";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { captureChild } from "../helpers/child-processes.mjs";
import { verifyModuleBoundaries } from "../../scripts/verify-module-boundaries.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const checker = join(repositoryRoot, "scripts/verify-module-boundaries.mjs");
const policyPath = join(repositoryRoot, "scripts/module-boundaries/policy.json");
const exceptionsPath = join(repositoryRoot, "scripts/module-boundaries/exceptions.json");

// The real CI check: the CLI over the whole repository with its policy and exceptions.
async function check(root) {
  const { status, signal, stdout, stderr } = await captureChild(
    process.execPath,
    [checker, "--root", root, "--policy", policyPath, "--exceptions", exceptionsPath, "--json"],
    { cwd: repositoryRoot },
  );
  assert.equal(signal, null, stderr);
  assert.equal(stderr, "");
  return { status, report: JSON.parse(stdout) };
}

// A small tree under the repository policy: every package manifest, every source root, and
// placeholder sources at the real paths `sources` names (each must exist in the repository).
// Policy rules match paths and manifests, so probes need no copy of the whole source tree.
async function policyTree(t, policy, sources) {
  const root = await temporaryDirectory(t, "occ-module-policy-");
  await Promise.all([
    ...policy.sourceRoots.map((sourceRoot) => mkdir(join(root, sourceRoot), { recursive: true })),
    ...policy.packages.map(async (packageRoot) => {
      await mkdir(join(root, packageRoot), { recursive: true });
      await cp(
        join(repositoryRoot, packageRoot, "package.json"),
        join(root, packageRoot, "package.json"),
      );
    }),
  ]);
  for (const [source, text] of Object.entries(sources)) {
    await access(join(repositoryRoot, source));
    await writeProbe(root, source, text);
  }
  return root;
}

async function writeProbe(root, source, text) {
  const probe = join(root, source);
  await mkdir(dirname(probe), { recursive: true });
  await writeFile(probe, text);
}

describe("module policy", { concurrency: true }, () => {
  test("repository source obeys its dependency policy with exact current exceptions", async () => {
    const { status, report } = await check(repositoryRoot);
    assert.equal(status, 0, JSON.stringify(report.violations, null, 2));
    assert.deepEqual(report.violations, []);
  });

  test("repository policy allows a public root and rejects a new HTTP Driver import", async (t) => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    const contracts = "packages/contracts/src/index.ts";
    const driver = "apps/controller/src/drivers/compute/docker/index.ts";
    const root = await policyTree(t, policy, {
      [contracts]: "export type Agent = { name: string };\n",
      [driver]: "export const driver = true;\n",
    });
    const allowedSource = "apps/controller/src/routes/policy-probe.ts";
    const rejectedSource = "apps/controller/src/routes/policy-probe-rejected.ts";
    // A public root stays valid even if production consumers choose another supported export.
    const allowedImport = 'import type { Agent } from "@openclaw-enterprise/contracts";\n';
    await writeProbe(root, allowedSource, allowedImport);
    await writeProbe(
      root,
      rejectedSource,
      allowedImport + 'import "../drivers/compute/docker/index.ts";\n',
    );
    const report = await verifyModuleBoundaries({ root, policy });
    for (const source of [allowedSource, rejectedSource]) {
      assert.ok(
        report.edges.some(
          (edge) =>
            edge.from === source &&
            edge.to === contracts &&
            edge.specifier === "@openclaw-enterprise/contracts" &&
            edge.typeOnly,
        ),
        source,
      );
    }
    assert.equal(report.ok, false);
    assert.equal(report.violations.length, 1, JSON.stringify(report.violations));
    const diagnostic = report.violations[0];
    assert.equal(diagnostic.rule, "http-to-provider");
    assert.equal(diagnostic.from, rejectedSource);
    assert.equal(diagnostic.to, driver);
  });
});
