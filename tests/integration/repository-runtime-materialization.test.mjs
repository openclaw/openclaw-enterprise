import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import { REPOSITORY_MATERIAL_INIT_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/repository-material-init.ts";

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
  const nativeClient = pathToFileURL(
    join(artifact, "dist/drivers/repo/github/credentials/client/native-git.js"),
  ).href;
  // Relocate only the installed module lookup. The initializer and emitted
  // preparer execute unchanged, with their real detached dependency closure.
  // This does not prove the runtime image installs the bundle at /opt/oce.
  nativeClientImport = `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        return nextResolve(
          specifier === "/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/native-git.js"
            ? ${JSON.stringify(nativeClient)} : specifier,
          context,
        );
      },
    });
  `)}`;
});

async function projectionFixture(t, { count = 1 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "repository-runtime-material-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "projection");
  const targetRoot = join(root, "output", "private");
  await mkdir(sourceRoot);
  await mkdir(dirname(targetRoot), { mode: 0o700 });
  const bindings = Array.from({ length: count }, (_, index) => {
    const sessionId = `session_material_${index}`;
    return {
      kind: "new",
      repositoryRef: `repository-${index}`,
      sessionId,
      deadlineWallMs,
      files: encodeRepositoryCredentialSessionFiles({
        session: { sessionId, deadlineWallMs },
        bearer: `controlled_gateway_bearer_${index}_0000000000000000000000`,
        client,
      }),
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
        providerId: "github",
        grant: { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" },
      })),
    },
  };
  const deployment = repositoryMaterialDeployment(
    repositoryMaterialSpec(revision, bindings),
    "runtime-fixture:local",
  );
  const argument = [
    ...(deployment.initContainer.command ?? []),
    ...(deployment.initContainer.args ?? []),
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
        REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
        JSON.stringify(descriptor),
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { PATH: process.env.PATH },
      },
    );
  return { root, sourceRoot, targetRoot, generation, descriptor, bindings, run };
}

test("the actual repository init process turns projected Secrets into private runtime files", async (t) => {
  const fixture = await projectionFixture(t, { count: 2 });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const retry = fixture.run();
  assert.equal(retry.status, 0, retry.stderr);
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

test("repository init does not publish sessions when native Git configuration cannot be prepared", async (t) => {
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
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Repository credential material initialization failed.\n");
  await assert.rejects(lstat(fixture.targetRoot), { code: "ENOENT" });
  assert.deepEqual(await readdir(dirname(fixture.targetRoot)), []);
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
