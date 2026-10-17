import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { captureChild, settled } from "../helpers/child-processes.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const checker = join(repositoryRoot, "scripts/verify-module-boundaries.mjs");
const policyPath = join(repositoryRoot, "scripts/module-boundaries/policy.json");
const exceptionsPath = join(repositoryRoot, "scripts/module-boundaries/exceptions.json");

// Each check builds a type-checked program over the whole source tree (seconds of CPU), so
// independent checks run concurrently.
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

// A copy of the real source and manifests, so the existing baseline remains applicable.
async function sourceCopy(t, policy) {
  const root = await mkdtemp(join(tmpdir(), "occ-module-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
    // One copy per probe, so the allowed and rejected checks run at once.
    const [allowedRoot, rejectedRoot] = await settled([
      sourceCopy(t, policy),
      sourceCopy(t, policy),
    ]);
    const source = "apps/controller/src/routes/policy-probe.ts";
    // A public root stays valid even if production consumers choose another supported export.
    const allowedImport = 'import type { Agent } from "@openclaw-enterprise/contracts";\n';
    await writeProbe(allowedRoot, source, allowedImport);
    await writeProbe(
      rejectedRoot,
      source,
      allowedImport + 'import "../drivers/compute/docker/index.ts";\n',
    );
    const [allowed, rejected] = await settled([check(allowedRoot), check(rejectedRoot)]);
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
    assert.equal(rejected.status, 1);
    assert.equal(rejected.report.violations.length, 1, JSON.stringify(rejected.report.violations));
    const diagnostic = rejected.report.violations[0];
    assert.equal(diagnostic.rule, "http-to-provider");
    assert.equal(diagnostic.from, source);
    assert.equal(diagnostic.to, "apps/controller/src/drivers/compute/docker/index.ts");
  });
});
