import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { missingReleaseAssets, verifyDownload } from "../../scripts/ci/cli-release.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

type ReleasePlatform = {
  os: "darwin" | "linux";
  arch: "amd64" | "arm64";
};

const releasePlatforms: readonly ReleasePlatform[] = [
  { os: "darwin", arch: "amd64" },
  { os: "darwin", arch: "arm64" },
  { os: "linux", arch: "amd64" },
  { os: "linux", arch: "arm64" },
];
const executableHeaders: Record<ReleasePlatform["os"], readonly number[]> = {
  darwin: [0xcf, 0xfa, 0xed, 0xfe],
  linux: [0x7f, 0x45, 0x4c, 0x46],
};

async function stageSourceFixture(directory: string): Promise<string> {
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
  return source;
}

async function assertPlatformArtifacts(output: string, version: string): Promise<void> {
  for (const { os, arch } of releasePlatforms) {
    const name = `occ-v${version}-${os}-${arch}`;
    const bytes = await readFile(join(output, name));
    assert.deepEqual(
      bytes.subarray(0, 4),
      Buffer.from(executableHeaders[os]),
      `${name} must be a native executable for its named OS.`,
    );
  }
}

test("CLI release builds four installable platform binaries and rejects changed assets", async (t) => {
  const directory = await temporaryDirectory(t, "oce-cli-release-test-");
  // Keep current-directory packaging inside an owned source fixture, never the checkout.
  const source = await stageSourceFixture(directory);
  const output = join(directory, "dist");
  // Builds use the toolchain's normal cache (GOCACHEPROG or the setup-go cache on CI, the user
  // cache locally). A fresh cache recompiled the standard library for four platforms every run.
  const script = resolve("scripts/ci/cli-release.ts");
  execFileSync(process.execPath, [script, "package", output], { cwd: source });

  const manifest: unknown = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(manifest !== null && typeof manifest === "object" && "version" in manifest);
  const version = manifest.version;
  assert.ok(typeof version === "string");
  await assertPlatformArtifacts(output, version);
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

  // Every partial draft resumes at its missing assets. A public release must already
  // contain all five. Compare real binary downloads with the approved build on disk.
  const names = [
    ...releasePlatforms.map(({ os, arch }) => `occ-v${version}-${os}-${arch}`),
    "SHA256SUMS",
  ];
  for (let count = 0; count <= names.length; count++) {
    const partial = { assets: names.slice(0, count).map((name) => ({ name })) };
    assert.deepEqual(missingReleaseAssets(partial, names, false), names.slice(count));
    if (count < names.length) {
      assert.throws(() => missingReleaseAssets(partial, names, true), /missing CLI assets/u);
    }
  }
  assert.throws(
    () => missingReleaseAssets({ assets: [{ name: "other" }] }, names, false),
    /Unexpected release asset/u,
  );
  const binary = await readFile(join(output, native));
  const server = createServer((req, res) => {
    // A public verification must succeed without an authenticated request.
    if (req.headers.authorization || req.url !== "/binary") {
      res.writeHead(403).end();
      return;
    }
    res.end(binary);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/binary`;
    await verifyDownload(url, join(output, native));
    await assert.rejects(
      verifyDownload(url, join(output, "SHA256SUMS")),
      /differs from prepared bytes/u,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }

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

  // A replacement bundle can carry internally consistent checksums. Recovery
  // must still reject it against the digest retained by the original prepare job.
  const checksumFile = join(output, "SHA256SUMS");
  const original = await readFile(checksumFile, "utf8");
  const checksum = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const updated = checksum(await readFile(join(output, native)));
  await writeFile(
    checksumFile,
    original.replace(`${checksum(binary)}  ${native}`, `${updated}  ${native}`),
  );
  const substituted = spawnSync(process.execPath, [script, "verify", output], {
    encoding: "utf8",
    cwd: source,
    env: { ...process.env, CLI_SHA256SUMS_DIGEST: checksum(original) },
  });
  assert.notEqual(substituted.status, 0);
  assert.match(substituted.stderr, /SHA256SUMS differs from the prepared artifact/u);
});
