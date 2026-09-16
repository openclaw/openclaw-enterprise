import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const rootWorkspacePolicy = await readFile(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
const docsWorkspacePolicy = await readFile(
  join(repoRoot, "scripts/docs-site/pnpm-workspace.yaml"),
  "utf8",
);
const rootPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const packageManager = rootPackage.packageManager;
const docsInstallScript = rootPackage.scripts["docs:install"];
assert.ok(
  docsInstallScript?.startsWith("pnpm "),
  `Unexpected docs:install script: ${docsInstallScript}`,
);
const pnpmVersion = packageManager.match(/^pnpm@(?<version>[^+]+)/)?.groups?.version;
assert.ok(pnpmVersion, `Expected packageManager to pin pnpm, got ${packageManager}`);
for (const policy of [rootWorkspacePolicy, docsWorkspacePolicy]) {
  assert.match(policy, /^minimumReleaseAge: 10080$/m);
  assert.match(policy, /^minimumReleaseAgeStrict: true$/m);
  assert.match(policy, /^minimumReleaseAgeIgnoreMissingTime: false$/m);
}
assert.equal(
  (await execFileAsync("pnpm", ["--version"], { encoding: "utf8" })).stdout.trim(),
  pnpmVersion,
);

const minute = 60 * 1000;
const day = 24 * 60 * minute;

function iso(ms) {
  return new Date(ms).toISOString();
}

async function createRegistry(t, root, definitions) {
  const packages = new Map();
  const tarballs = new Map();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(
      new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1),
    );
    if (packages.has(path)) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(packages.get(path)));
    } else if (tarballs.has(path)) {
      response
        .writeHead(200, { "content-type": "application/octet-stream" })
        .end(tarballs.get(path));
    } else {
      response.writeHead(404).end(`missing fixture ${path}`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}/`;

  for (const definition of definitions) {
    const metadata = {
      name: definition.name,
      "dist-tags": { latest: definition.latest },
      versions: {},
    };
    const times = definition.omitTime ? undefined : {};
    for (const version of definition.versions) {
      const manifest = {
        name: definition.name,
        version: version.version,
        dependencies: version.dependencies ?? {},
      };
      const tarball = await pack(root, manifest);
      const tarballPath = `${definition.name}/-/${definition.name}-${version.version}.tgz`;
      tarballs.set(tarballPath, tarball.bytes);
      metadata.versions[version.version] = {
        ...manifest,
        dist: {
          integrity: tarball.integrity,
          shasum: tarball.shasum,
          tarball: `${registry}${tarballPath}`,
        },
      };
      if (times && version.publishedAt) {
        times[version.version] = version.publishedAt;
      }
    }
    if (times) {
      metadata.time = { created: iso(Date.now() - 90 * day), modified: iso(Date.now()), ...times };
    }
    packages.set(definition.name, metadata);
  }
  return registry;
}

async function pack(root, manifest) {
  const stage = join(root, "pack", manifest.name, manifest.version);
  const archive = join(root, "pack", `${manifest.name}-${manifest.version}.tgz`);
  await mkdir(join(stage, "package"), { recursive: true });
  await writeFile(join(stage, "package/package.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(stage, "package/index.js"), "export default true;\n");
  await execFileAsync("tar", ["-czf", archive, "-C", stage, "package"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const bytes = await readFile(archive);
  return {
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

async function writeProject(root, dependencies, workspacePolicy = rootWorkspacePolicy) {
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "release-age-fixture",
      version: "1.0.0",
      private: true,
      packageManager,
      dependencies,
    })}\n`,
  );
  await writeFile(join(root, "pnpm-workspace.yaml"), workspacePolicy);
}

async function pnpmInstall(root, registry, args) {
  const npmrc = join(root, "fixture.npmrc");
  writeFileSync(npmrc, `registry=${registry}\n`);
  try {
    const result = await execFileAsync("pnpm", ["--registry", registry, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        CI: "1",
        COREPACK_ENABLE_AUTO_PIN: "0",
        NO_COLOR: "1",
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        npm_config_globalconfig: npmrc,
        npm_config_registry: registry,
        npm_config_userconfig: npmrc,
      },
    });
    return { status: 0, output: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    return { status: error.code ?? 1, output: `${error.stdout ?? ""}\n${error.stderr ?? ""}` };
  }
}

function expectPolicyRejection(result, packageName) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, new RegExp(packageName.replaceAll("-", "[- ]?"), "i"));
  assert.match(
    result.output,
    /minimum release age|published|release time|MISSING_TIME|missing.*time|time.*field/i,
  );
}

async function expectLockedVersion(root, packageName, version) {
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  assert.match(lockfile, new RegExp(`${packageName}.*${version.replaceAll(".", "\\.")}`, "s"));
}

async function expectUnlockedVersion(root, packageName, version) {
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  assert.doesNotMatch(
    lockfile,
    new RegExp(`${packageName}.*${version.replaceAll(".", "\\.")}`, "s"),
  );
}

function docsInstallArgsFor(docsRoot) {
  const args = docsInstallScript.split(/\s+/).slice(1);
  const dirIndex = args.indexOf("--dir");
  assert.notEqual(dirIndex, -1, docsInstallScript);
  args[dirIndex + 1] = docsRoot;
  return args;
}

test("workspace policies load for root install and docs:install", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-release-age-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = "workspace-config-release-age";
  const now = Date.now();
  const registry = await createRegistry(t, root, [
    {
      name: pkg,
      latest: "1.0.0",
      versions: [{ version: "1.0.0", publishedAt: iso(now - 7 * day + 15 * minute) }],
    },
  ]);

  await writeProject(root, { [pkg]: "1.0.0" });
  expectPolicyRejection(
    await pnpmInstall(root, registry, [
      "install",
      "--lockfile-only",
      "--ignore-scripts",
      "--store-dir",
      join(root, "store"),
    ]),
    pkg,
  );

  const docs = join(root, "scripts/docs-site");
  await mkdir(docs, { recursive: true });
  // Seed a lockfile that predates the policy, then test the real frozen docs command.
  await writeProject(
    docs,
    { [pkg]: "1.0.0" },
    docsWorkspacePolicy.replace(/^minimumReleaseAge: .+$/m, "minimumReleaseAge: 0"),
  );
  assert.equal(
    (
      await pnpmInstall(root, registry, [
        "--dir",
        docs,
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--store-dir",
        join(root, "docs-store"),
      ])
    ).status,
    0,
  );
  await writeFile(join(docs, "pnpm-workspace.yaml"), docsWorkspacePolicy);
  expectPolicyRejection(
    await pnpmInstall(root, registry, [
      ...docsInstallArgsFor(docs),
      "--store-dir",
      join(root, "docs-store"),
    ]),
    pkg,
  );
});

test("resolution accepts seven-day-old and long-established versions while skipping fresh latest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-release-age-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = "boundary-release-age";
  const old = "established-release-age";
  const now = Date.now();
  const registry = await createRegistry(t, root, [
    {
      name: pkg,
      latest: "1.1.0",
      versions: [
        { version: "1.0.0", publishedAt: iso(now - 7 * day - 15 * minute) },
        { version: "1.1.0", publishedAt: iso(now - 7 * day + 15 * minute) },
      ],
    },
    {
      name: old,
      latest: "1.0.0",
      versions: [{ version: "1.0.0", publishedAt: iso(now - 30 * day) }],
    },
  ]);
  await writeProject(root, { [pkg]: "^1.0.0", [old]: "1.0.0" });

  const result = await pnpmInstall(root, registry, [
    "install",
    "--lockfile-only",
    "--ignore-scripts",
    "--store-dir",
    join(root, "store"),
  ]);
  assert.equal(result.status, 0, result.output);
  await expectLockedVersion(root, pkg, "1.0.0");
  await expectUnlockedVersion(root, pkg, "1.1.0");
  await expectLockedVersion(root, old, "1.0.0");
});

test("resolution rejects direct, transitive, and missing-time violations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-release-age-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [direct, parent, child, missing] = [
    "direct-release-age-fresh",
    "transitive-release-age-parent",
    "transitive-release-age-child",
    "missing-time-release-age",
  ];
  const registry = await createRegistry(t, root, [
    {
      name: direct,
      latest: "1.0.0",
      versions: [{ version: "1.0.0", publishedAt: iso(Date.now() - day) }],
    },
    {
      name: parent,
      latest: "1.0.0",
      versions: [
        {
          version: "1.0.0",
          publishedAt: iso(Date.now() - 30 * day),
          dependencies: { [child]: "1.0.0" },
        },
      ],
    },
    {
      name: child,
      latest: "1.0.0",
      versions: [{ version: "1.0.0", publishedAt: iso(Date.now() - day) }],
    },
    { name: missing, latest: "1.0.0", versions: [{ version: "1.0.0" }], omitTime: true },
  ]);

  for (const [name, dependency, expected] of [
    ["direct", direct, direct],
    ["transitive", parent, child],
    ["missing", missing, missing],
  ]) {
    const cwd = join(root, name);
    await mkdir(cwd);
    await writeProject(cwd, { [dependency]: "1.0.0" });
    expectPolicyRejection(
      await pnpmInstall(cwd, registry, [
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--store-dir",
        join(root, `${name}-store`),
      ]),
      expected,
    );
  }
});

test("frozen lockfile install rejects a locked package that is too new", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-release-age-frozen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = "frozen-release-age-fresh";
  const registry = await createRegistry(t, root, [
    {
      name: pkg,
      latest: "1.0.0",
      versions: [{ version: "1.0.0", publishedAt: iso(Date.now() - day) }],
    },
  ]);
  // Model a lockfile committed before enforcement without relaxing the repository policy.
  await writeProject(
    root,
    { [pkg]: "1.0.0" },
    rootWorkspacePolicy.replace(/^minimumReleaseAge: .+$/m, "minimumReleaseAge: 0"),
  );
  assert.equal(
    (
      await pnpmInstall(root, registry, [
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--store-dir",
        join(root, "store"),
      ])
    ).status,
    0,
  );

  await writeFile(join(root, "pnpm-workspace.yaml"), rootWorkspacePolicy);
  expectPolicyRejection(
    await pnpmInstall(root, registry, [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--store-dir",
      join(root, "store"),
    ]),
    pkg,
  );
});
