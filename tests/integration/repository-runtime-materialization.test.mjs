import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";
import {
  repositoryMaterialDeployment,
  repositoryMaterialSpec,
} from "../../apps/controller/src/drivers/compute/kubernetes/repository-material.ts";

const deadlineWallMs = Date.now() + 86400000;
const client = {
  gatewayOrigin: "https://credentials.example.test",
  gitRemote: "https://credentials.example.test/example/project.git",
  gitUsername: "gateway-session",
  canonicalApiHost: "github.com",
  apiHost: "credentials.example.test",
  repository: "example/project",
  pushRefAllowlist: ["refs/heads/agent/*"],
};

let nativeClientImport;

before(async (t) => {
  const root = await mkdtemp(join(tmpdir(), "repository-material-client-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const build = join(root, "build");
  await mkdir(join(build, "scripts"), { recursive: true });
  await mkdir(join(build, "apps/controller/dist"), { recursive: true });
  await cp(
    join(repository, "scripts/build-repository-credentials.mjs"),
    join(build, "scripts/build-repository-credentials.mjs"),
  );
  // Like the detached-package suite, use the real artifact builder and this
  // checkout's TypeScript output. A workspace build is a prerequisite.
  await cp(join(repository, "apps/controller/dist"), join(build, "apps/controller/dist"), {
    recursive: true,
  });
  await cp(
    join(repository, "deploy/runtime/repository-credentials"),
    join(build, "deploy/runtime/repository-credentials"),
    { recursive: true },
  );
  await symlink(join(repository, "node_modules"), join(build, "node_modules"));
  const result = spawnSync(
    process.execPath,
    [join(build, "scripts/build-repository-credentials.mjs")],
    {
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const artifact = join(root, "client");
  await cp(join(build, ".build/repository-credentials/client"), artifact, { recursive: true });
  await rm(build, { recursive: true, force: true });
  const nativeClient = pathToFileURL(artifact + "/").href;
  // Relocate only the installed module lookup. The initializer and emitted
  // preparer execute unchanged, with their real detached dependency closure.
  // This does not prove the runtime image installs the bundle at /opt/oce.
  nativeClientImport = `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        return nextResolve(
          specifier.startsWith("/opt/oce/repository-credentials/")
            ? ${JSON.stringify(nativeClient)} + specifier.slice("/opt/oce/repository-credentials/".length) : specifier,
          context,
        );
      },
    });
  `)}`;
});

async function projectionFixture(t, { count = 1, publicCa } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "repository-runtime-material-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "projection");
  const targetRoot = join(root, "output", "private");
  await mkdir(sourceRoot);
  // Kubernetes fsGroup makes the emptyDir root group-writable and setgid.
  await mkdir(dirname(targetRoot));
  await chmod(dirname(targetRoot), 0o2775);
  const bindings = Array.from({ length: count }, (_, index) => {
    const sessionId = `session_material_${index}`;
    return {
      kind: "new",
      repositoryRef: `repository-${index}`,
      sessionId,
      deadlineWallMs,
      files: encodeRepositoryCredentialSessionFiles(
        {
          session: { sessionId, deadlineWallMs },
          bearer: `controlled_gateway_bearer_${index}_0000000000000000000000`,
          client,
        },
        publicCa,
      ),
    };
  });
  const revision = {
    id: "revision-material",
    namespaceId: "namespace-material",
    agentId: "agent-material",
    repositoryCredentials: {
      driver: { id: "repository-credentials", implementation: "repository-credentials" },
      deadlineWallMs,
      bindings: bindings.map(({ repositoryRef }) => ({
        repositoryRef,
        profile: "read",
        backendId: "github",
        grant: { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" },
      })),
    },
  };
  const deployment = repositoryMaterialDeployment(
    repositoryMaterialSpec(revision, bindings),
    "runtime-fixture:local",
  );
  const argument = [
    ...(deployment.initContainers[0].command ?? []),
    ...(deployment.initContainers[0].args ?? []),
  ].find((value) => value.startsWith('{"sourceRoot"'));
  assert.ok(argument, "the production init container must carry its material descriptor");
  const descriptor = { ...JSON.parse(argument), sourceRoot, targetRoot };

  // Kubernetes publishes a generation directory through ..data and symlinks each
  // top-level projected directory. Exercise those real symlinks, not flat files.
  const generation = join(sourceRoot, "..2026_projection");
  await mkdir(generation);
  await symlink(basename(generation), join(sourceRoot, "..data"));
  for (const [index, binding] of descriptor.manifest.bindings.entries()) {
    const directory = basename(binding.directory);
    await mkdir(join(generation, directory, "gh"), { recursive: true });
    for (const [name, content] of Object.entries(bindings[index].files)) {
      await writeFile(join(generation, directory, name), content, { mode: 0o444 });
    }
    await symlink(`..data/${directory}`, join(sourceRoot, directory));
  }
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        nativeClientImport,
        "-e",
        deployment.initContainers[0].args[0],
        JSON.stringify(descriptor),
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { PATH: process.env.PATH },
      },
    );
  const runNativeAt = (directory) =>
    spawnSync(
      process.execPath,
      ["--import", nativeClientImport, "-e", deployment.initContainers[1].args[0], directory],
      { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH } },
    );
  const runNative = async () => {
    // Relocation models the second init's subPath view, not a live volume mount.
    // repository-runtime-volume.test.mjs exercises the actual container mounts.
    const mounted = join(root, "private-mount");
    await rename(targetRoot, mounted);
    try {
      return runNativeAt(mounted);
    } finally {
      await rename(mounted, targetRoot);
    }
  };
  return {
    root,
    sourceRoot,
    targetRoot,
    generation,
    descriptor,
    bindings,
    deployment,
    run,
    runNative,
    runNativeAt,
  };
}

test("the actual repository init process turns projected Secrets into private runtime files", async (t) => {
  const fixture = await projectionFixture(t, { count: 2 });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const native = await fixture.runNative();
  assert.equal(native.status, 0, native.stderr);
  const retry = fixture.run();
  assert.equal(retry.status, 0, retry.stderr);
  const nativeRetry = await fixture.runNative();
  assert.equal(nativeRetry.status, 0, nativeRetry.stderr);
  assert.equal((await lstat(fixture.targetRoot)).mode & 0o777, 0o700);
  const gitconfig = join(fixture.targetRoot, "gitconfig");
  assert.equal((await lstat(gitconfig)).mode & 0o777, 0o600);
  const setting = (name) => {
    const result = spawnSync(
      "git",
      ["--no-replace-objects", "config", "--file", gitconfig, "--get-all", name],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { PATH: process.env.PATH },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(setting(`url.${client.gatewayOrigin}/.insteadOf`), "https://github.com/\n");
  assert.equal(setting(`credential.${client.gatewayOrigin}.useHttpPath`), "true\n");
  assert.equal(setting(`http.${client.gatewayOrigin}.sslVerify`), "true\n");
  assert.equal(setting(`http.${client.gatewayOrigin}.followRedirects`), "false\n");
  assert.equal(
    setting(`credential.${client.gatewayOrigin}.helper`),
    `\n!'/usr/local/bin/node' '/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/git-helper.js' manifest '/run/oce/repository-credentials' '${fixture.descriptor.manifest.generation}'\n`,
  );
  const nativeConfig = await readFile(gitconfig, "utf8");
  assert.equal(
    setting("core.hooksPath").trim(),
    "/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/hooks",
  );
  assert.equal(setting("oce.repository.manifestRoot").trim(), "/run/oce/repository-credentials");
  for (const [index, binding] of fixture.descriptor.manifest.bindings.entries()) {
    const directory = join(fixture.targetRoot, "sessions", basename(binding.directory));
    for (const name of ["", "gh"]) {
      const metadata = await lstat(join(directory, name));
      assert.equal(metadata.isDirectory(), true);
      assert.equal(metadata.mode & 0o777, 0o700);
    }
    for (const [name, content] of Object.entries(fixture.bindings[index].files)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.mode & 0o777, 0o600);
      assert.equal(await readFile(path, "utf8"), content);
      assert.equal(result.stderr.includes(fixture.bindings[index].files.bearer), false);
    }
    assert.equal(nativeConfig.includes(fixture.bindings[index].files.bearer), false);
  }
});

test("the actual repository init process combines broker CA with system roots", async (t) => {
  const publicCa = Buffer.from(
    "-----BEGIN CERTIFICATE-----\nfixture-broker-ca\n-----END CERTIFICATE-----\n",
  );
  const fixture = await projectionFixture(t, { publicCa });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const directory = basename(fixture.descriptor.manifest.bindings[0].directory);
  const ca = await readFile(join(fixture.targetRoot, "sessions", directory, "ca.pem"));
  const bundle = await readFile(join(fixture.targetRoot, "sessions", directory, "ca-bundle.pem"));
  assert.equal(ca.toString("utf8"), publicCa.toString("utf8"));
  assert.ok(
    bundle.includes(ca),
    "the Agent-wide CA file must include the broker CA for repository traffic",
  );
  assert.ok(
    bundle.length > ca.length,
    "the Agent-wide CA file must retain system roots instead of replacing them with broker trust",
  );
});

test("the second repository init fails when native Git configuration cannot be prepared", async (t) => {
  const fixture = await projectionFixture(t, { count: 2 });
  const binding = fixture.descriptor.manifest.bindings[1];
  // Both sessions remain individually valid, but one canonical host cannot be
  // routed to two gateways. The real native preparer must reject the generation.
  binding.client = {
    ...client,
    gatewayOrigin: "https://other-credentials.example.test",
    gitRemote: "https://other-credentials.example.test/example/project.git",
    apiHost: "other-credentials.example.test",
  };
  const files = encodeRepositoryCredentialSessionFiles({
    session: { sessionId: binding.sessionId, deadlineWallMs: binding.deadlineWallMs },
    bearer: fixture.bindings[1].files.bearer,
    client: binding.client,
  });
  const directory = join(fixture.generation, basename(binding.directory));
  for (const [name, content] of Object.entries(files)) {
    await rm(join(directory, name));
    await writeFile(join(directory, name), content, { mode: 0o444 });
  }
  const material = fixture.run();
  assert.equal(material.status, 0, material.stderr);
  const result = await fixture.runNative();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Repository native Git configuration initialization failed.\n");
  await assert.rejects(lstat(join(fixture.targetRoot, "gitconfig")), { code: "ENOENT" });
});

test("repository init validates the complete projection before publishing any session", async (t) => {
  const fixture = await projectionFixture(t, { count: 2 });
  const second = basename(fixture.descriptor.manifest.bindings[1].directory);
  await rm(join(fixture.generation, second, "bearer"));
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  for (const binding of fixture.bindings) {
    assert.equal(result.stderr.includes(binding.files.bearer), false);
  }
  await assert.rejects(lstat(join(fixture.targetRoot, "sessions")), { code: "ENOENT" });
});

test("repository init refuses a projected file outside its Secret generation", async (t) => {
  const fixture = await projectionFixture(t);
  const directory = basename(fixture.descriptor.manifest.bindings[0].directory);
  const outside = join(fixture.root, "outside-bearer");
  await writeFile(outside, fixture.bindings[0].files.bearer);
  const projected = join(fixture.generation, directory, "bearer");
  await rm(projected);
  await symlink(outside, projected);
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(fixture.bindings[0].files.bearer), false);
  await assert.rejects(lstat(join(fixture.targetRoot, "sessions")), { code: "ENOENT" });
});

test("repository init refuses session identity drift in the projected client document", async (t) => {
  const fixture = await projectionFixture(t);
  const directory = basename(fixture.descriptor.manifest.bindings[0].directory);
  const document = JSON.parse(fixture.bindings[0].files["client.json"]);
  document.sessionId = "another-session";
  await rm(join(fixture.generation, directory, "client.json"));
  await writeFile(join(fixture.generation, directory, "client.json"), JSON.stringify(document));
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(fixture.bindings[0].files.bearer), false);
});

test("repository init refuses drift in the selected push-ref policy", async (t) => {
  const fixture = await projectionFixture(t);
  const binding = fixture.descriptor.manifest.bindings[0];
  binding.client = { ...binding.client, pushRefAllowlist: ["refs/heads/main"] };
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "Repository credential material initialization failed.\n");
  await assert.rejects(lstat(fixture.targetRoot), { code: "ENOENT" });
});

for (const [name, corrupt] of [
  [
    "malformed UTF-8",
    async (directory) => {
      await rm(join(directory, "bearer"));
      await writeFile(join(directory, "bearer"), Buffer.from([0xc3, 0x28]));
    },
  ],
  ["an undeclared file", (directory) => writeFile(join(directory, "extra.json"), "{}")],
]) {
  test(`repository init refuses ${name} in the projected session`, async (t) => {
    const fixture = await projectionFixture(t);
    const directory = basename(fixture.descriptor.manifest.bindings[0].directory);
    await corrupt(join(fixture.generation, directory));
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(fixture.bindings[0].files.bearer), false);
    await assert.rejects(lstat(join(fixture.targetRoot, "sessions")), { code: "ENOENT" });
  });
}

test("repository init never follows an existing output symlink", async (t) => {
  const fixture = await projectionFixture(t);
  const outside = join(fixture.root, "unrelated");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve");
  await symlink(outside, fixture.targetRoot);
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(await readdir(outside), ["sentinel"]);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve");
});

test("native preparation retries partial output and retains directory custody checks", async (t) => {
  const fixture = await projectionFixture(t);
  await chmod(dirname(fixture.targetRoot), 0o770);
  assert.equal(fixture.run().status, 0);
  // Even a valid private child cannot make a writable ancestor safe for clients.
  assert.equal(fixture.runNativeAt(fixture.targetRoot).status, 1);
  const config = join(fixture.targetRoot, "gitconfig");
  await writeFile(config, "partial output", { mode: 0o600 });
  const prepared = await fixture.runNative();
  assert.equal(prepared.status, 0, prepared.stderr);
  const expected = await readFile(config, "utf8");
  assert.match(expected, /git-helper\.js/);
  assert.equal((await fixture.runNative()).status, 0);
  assert.equal(await readFile(config, "utf8"), expected);

  await chmod(config, 0o640);
  assert.equal((await fixture.runNative()).status, 1);
  assert.equal(await readFile(config, "utf8"), expected);
  await rm(config);
  const manifest = join(fixture.targetRoot, "manifest.json");
  const original = await readFile(manifest, "utf8");
  await symlink(manifest, config);
  assert.equal((await fixture.runNative()).status, 1);
  assert.equal((await lstat(config)).isSymbolicLink(), true);
  assert.equal(await readFile(manifest, "utf8"), original);
});

test("native preparation refuses altered private client material", async (t) => {
  const fixture = await projectionFixture(t);
  assert.equal(fixture.run().status, 0);
  const directory = join(
    fixture.targetRoot,
    "sessions",
    basename(fixture.descriptor.manifest.bindings[0].directory),
  );
  await chmod(join(directory, "client.json"), 0o640);
  assert.equal((await fixture.runNative()).status, 1);
  await assert.rejects(lstat(join(fixture.targetRoot, "gitconfig")), { code: "ENOENT" });
});
