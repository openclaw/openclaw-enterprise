import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

function npmEnvironment(root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_config_")) delete env[key];
  }
  env.NPM_CONFIG_CACHE = join(root, "npm-cache");
  env.NPM_CONFIG_GLOBALCONFIG = join(root, "global-npmrc");
  env.NPM_CONFIG_USERCONFIG = join(root, "user-npmrc");
  return env;
}

async function readDockerfile(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

function npmInstallLine(contents) {
  const lines = contents.split("\n").filter((line) => line.includes("npm install"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /--before="\$release_age_cutoff"/);
}

function releaseAgeCutoffScript(contents) {
  const match = contents.match(/release_age_cutoff="\$\(node -e '([^']+)'\)"/);
  assert.ok(match, "Dockerfile must compute the release-age cutoff before npm install");
  npmInstallLine(contents);
  return match[1];
}

async function dockerfileCutoffScript() {
  const scripts = await Promise.all(
    ["deploy/runtime/Dockerfile", "tests/fixtures/ssh-compute/host/Dockerfile"].map(
      async (relativePath) => releaseAgeCutoffScript(await readDockerfile(relativePath)),
    ),
  );
  assert.equal(scripts[0], scripts[1], "runtime images must share one release-age policy");
  return scripts[0];
}

async function packPackage(root, name, version, dependencies = {}) {
  const packageDir = join(root, "packages", name);
  const tarballDir = join(root, "tarballs");
  await mkdir(packageDir, { recursive: true });
  await mkdir(tarballDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name, version, dependencies }),
  );
  await writeFile(join(packageDir, "index.js"), "export default true;\n");

  const { stdout } = await execute(
    "npm",
    ["pack", packageDir, "--pack-destination", tarballDir, "--json"],
    {
      timeout: 30_000,
      maxBuffer: 1_000_000,
      env: npmEnvironment(root),
    },
  );
  const [entry] = JSON.parse(stdout);
  const tarball = await readFile(join(tarballDir, entry.filename));
  return {
    name,
    version,
    dependencies,
    filename: entry.filename,
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    shasum: createHash("sha1").update(tarball).digest("hex"),
    tarball,
  };
}

function packument(registry, packed, publishedAt) {
  const version = {
    name: packed.name,
    version: packed.version,
    dependencies: packed.dependencies,
    dist: {
      integrity: packed.integrity,
      shasum: packed.shasum,
      tarball: `${registry}/${packed.name}/-/${packed.filename}`,
    },
  };
  const metadata = {
    name: packed.name,
    "dist-tags": { latest: packed.version },
    versions: { [packed.version]: version },
  };
  if (publishedAt !== undefined) {
    metadata.time = {
      created: publishedAt,
      modified: publishedAt,
      [packed.version]: publishedAt,
    };
  }
  return metadata;
}

async function startRegistry(t, packages) {
  let server;
  const origin = await new Promise((resolve, reject) => {
    server = createServer((request, response) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
      const [name] = pathname.split("/");
      const entry = packages.get(name);
      if (entry === undefined) {
        response.writeHead(404).end("not found");
        return;
      }
      if (pathname.endsWith(".tgz")) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(entry.tarball);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(entry.metadata));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return origin;
}

async function npmInstall(root, registry, cutoff, packageName) {
  const projectDir = await mkdtemp(join(root, `${packageName}-install-`));
  await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "install-proof" }));
  try {
    const result = await execute(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--globalconfig",
        join(root, "global-npmrc"),
        "--userconfig",
        join(root, "user-npmrc"),
        "--cache",
        join(root, "npm-cache"),
        "--registry",
        registry,
        "--before",
        cutoff,
        `${packageName}@1.0.0`,
      ],
      {
        cwd: projectDir,
        timeout: 30_000,
        maxBuffer: 1_000_000,
        env: npmEnvironment(root),
      },
    );
    return { ok: true, projectDir, ...result };
  } catch (error) {
    return {
      ok: false,
      code: error.code,
      projectDir,
      stderr: error.stderr,
      stdout: error.stdout,
    };
  }
}

async function assertInstalledVersion(result, packageName, version, message) {
  assert.equal(result.ok, true, message ?? `${packageName} install must succeed`);
  const packageJson = JSON.parse(
    await readFile(join(result.projectDir, "node_modules", packageName, "package.json"), "utf8"),
  );
  assert.equal(packageJson.version, version);
}

test("runtime image npm installs block packages published after the seven-day cutoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oce-npm-release-age-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "global-npmrc"), "");
  await writeFile(join(root, "user-npmrc"), "");

  const cutoffScript = await dockerfileCutoffScript();
  const beforeCutoff = Date.now();
  const { stdout } = await execute(process.execPath, ["-e", cutoffScript]);
  const afterCutoff = Date.now();
  const cutoff = stdout.trim();
  const cutoffMs = Date.parse(cutoff);
  assert.ok(cutoffMs >= beforeCutoff - sevenDaysMs);
  assert.ok(cutoffMs <= afterCutoff - sevenDaysMs);
  const oldPublishTime = new Date(cutoffMs - 1).toISOString();
  const cutoffPublishTime = new Date(cutoffMs).toISOString();
  const newPublishTime = new Date(cutoffMs + 1).toISOString();

  const packed = await Promise.all([
    packPackage(root, "oce-old-direct", "1.0.0"),
    packPackage(root, "oce-cutoff-direct", "1.0.0"),
    packPackage(root, "oce-new-direct", "1.0.0"),
    packPackage(root, "oce-new-transitive", "1.0.0"),
    packPackage(root, "oce-old-parent", "1.0.0", { "oce-new-transitive": "1.0.0" }),
    packPackage(root, "oce-missing-time", "1.0.0"),
  ]);
  const byName = new Map(packed.map((pkg) => [pkg.name, pkg]));
  const registryPackages = new Map(packed.map((pkg) => [pkg.name, { ...pkg }]));
  const registry = await startRegistry(t, registryPackages);
  const publishTimes = new Map([
    ["oce-old-direct", oldPublishTime],
    ["oce-cutoff-direct", cutoffPublishTime],
    ["oce-new-direct", newPublishTime],
    ["oce-new-transitive", newPublishTime],
    ["oce-old-parent", cutoffPublishTime],
    ["oce-missing-time", undefined],
  ]);
  for (const [name, entry] of registryPackages) {
    entry.metadata = packument(registry, byName.get(name), publishTimes.get(name));
  }

  await assertInstalledVersion(
    await npmInstall(root, registry, cutoff, "oce-old-direct"),
    "oce-old-direct",
    "1.0.0",
  );
  await assertInstalledVersion(
    await npmInstall(root, registry, cutoff, "oce-cutoff-direct"),
    "oce-cutoff-direct",
    "1.0.0",
  );

  const newDirect = await npmInstall(root, registry, cutoff, "oce-new-direct");
  assert.equal(newDirect.ok, false);
  assert.match(
    `${newDirect.stdout}\n${newDirect.stderr}`,
    /No matching version found for oce-new-direct@1\.0\.0/,
  );

  const newTransitive = await npmInstall(root, registry, cutoff, "oce-old-parent");
  assert.equal(newTransitive.ok, false);
  assert.match(
    `${newTransitive.stdout}\n${newTransitive.stderr}`,
    /No matching version found for oce-new-transitive@1\.0\.0/,
  );

  const missingTime = await npmInstall(root, registry, cutoff, "oce-missing-time");
  await assertInstalledVersion(
    missingTime,
    "oce-missing-time",
    "1.0.0",
    "npm accepts registry versions without time metadata under --before; pnpm handles this gap with strict missing-time policy",
  );
});
