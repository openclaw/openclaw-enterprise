import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

test("CLI release builds four installable platform binaries and rejects changed assets", async (t) => {
  const directory = await temporaryDirectory(t, "oce-cli-release-test-");
  // Keep current-directory packaging inside an owned source fixture, never the checkout.
  const source = join(directory, "source");
  await mkdir(source);
  for (const path of ["cmd", "internal", "go.mod", "go.sum", "package.json"]) {
    await cp(path, join(source, path), { recursive: true });
  }
  await mkdir(join(source, "deploy/helm/openclaw-enterprise"), { recursive: true });
  await cp(
    "deploy/helm/openclaw-enterprise/Chart.yaml",
    join(source, "deploy/helm/openclaw-enterprise/Chart.yaml"),
  );
  const output = join(directory, "dist");
  // Builds use the toolchain's normal cache (GOCACHEPROG or the setup-go cache on CI, the user
  // cache locally). A fresh cache recompiled the standard library for four platforms every run.
  const script = resolve("scripts/ci/cli-release.mjs");
  execFileSync(process.execPath, [script, "package", output], { cwd: source });

  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const names = [
    `occ-v${version}-darwin-amd64`,
    `occ-v${version}-darwin-arm64`,
    `occ-v${version}-linux-amd64`,
    `occ-v${version}-linux-arm64`,
  ];
  for (const name of names) {
    const bytes = await readFile(join(output, name));
    assert.deepEqual(
      bytes.subarray(0, 4),
      name.includes("-darwin-")
        ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
        : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      `${name} must be a native executable for its named OS.`,
    );
  }
  const nativeArch = process.arch === "x64" ? "amd64" : process.arch;
  const native = `occ-v${version}-${process.platform}-${nativeArch}`;
  assert.equal(
    execFileSync(join(output, native), ["--version"], { encoding: "utf8" }).trim(),
    `occ v${version}`,
  );
  assert.match(
    execFileSync(join(output, native), ["installation", "--help"], { encoding: "utf8" }),
    /installation/u,
  );
  execFileSync(process.execPath, [script, "verify", output], { cwd: source });

  // Rebuilding the same source after a partial publication must preserve the
  // exact binary bytes so a draft-release retry can compare them safely. Use the
  // current source directory on retry, which must execute the built file rather than search PATH.
  const retry = source;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  execFileSync(process.execPath, [script, "package", "."], { cwd: source });
  assert.deepEqual(
    await readFile(join(output, "SHA256SUMS")),
    await readFile(join(retry, "SHA256SUMS")),
  );

  // A changed executable must be rejected before the publication job uploads it.
  await appendFile(join(output, native), "changed");
  const rejected = spawnSync(process.execPath, [script, "verify", output], {
    encoding: "utf8",
    cwd: source,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /differs from SHA256SUMS/u);
});
