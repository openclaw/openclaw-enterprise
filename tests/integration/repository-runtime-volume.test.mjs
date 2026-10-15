import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRepositorySessions } from "../fixtures/repository-credentials/projection.mjs";

const deadlineWallMs = Date.now() + 86400000;
const client = {
  gatewayOrigin: "https://credentials.example.test",
  gitRemote: "https://credentials.example.test/example/project.git",
  gitUsername: "gateway-session",
  canonicalApiHost: "github.com",
  apiHost: "credentials.example.test",
  repository: "example/project",
};

async function repositoryProjectionFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "repository-runtime-material-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "projection");
  await mkdir(sourceRoot);
  const { descriptor, deployment } = await projectRepositorySessions(sourceRoot, {
    client,
    deadlineWallMs,
  });
  return { sourceRoot, descriptor, deployment };
}

const runtimeImage = process.env.OCC_TEST_RUNTIME_IMAGE;
test(
  "repository init uses a private subPath of a root-owned fsGroup memory volume",
  {
    skip: runtimeImage ? false : "select OCC_TEST_RUNTIME_IMAGE for real volume mount proof",
    timeout: 60000,
  },
  async (t) => {
    const fixture = await repositoryProjectionFixture(t);
    const docker = (args) =>
      spawnSync(process.env.OCC_DOCKER_BIN ?? "docker", args, {
        encoding: "utf8",
        timeout: 15000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
    const volume = `repository-material-${process.pid}-${Date.now()}`;
    const selected = docker(["image", "inspect", "--format", "{{.Id}}", runtimeImage]);
    assert.equal(selected.status, 0, selected.stderr);
    const image = selected.stdout.trim();
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const created = docker([
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=tmpfs",
      "--opt",
      "device=tmpfs",
      "--opt",
      "o=uid=0,gid=1000,mode=2775,size=4194304",
      volume,
    ]);
    assert.equal(created.status, 0, created.stderr);
    const holder = `${volume}-holder`;
    t.after(() => {
      const stopped = docker(["rm", "--force", holder]);
      const removed = docker(["volume", "rm", volume]);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.equal(removed.status, 0, removed.stderr);
    });
    // Keep this tmpfs mounted across init containers, as the Pod volume is.
    const held = docker([
      "run",
      "--detach",
      "--name",
      holder,
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=volume,src=${volume},dst=/run/oce/repository-output,volume-nocopy`,
      "--entrypoint",
      "node",
      image,
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    assert.equal(held.status, 0, held.stderr);
    // Use the image-installed client bundle for both init stages and the consumer.
    const run = (user, mounts, script, ...args) =>
      docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--workdir",
        "/",
        "--user",
        user,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        ...mounts.flatMap((mount) => ["--mount", mount]),
        "--entrypoint",
        "node",
        image,
        "-e",
        script,
        ...args,
      ]);
    const outputMount = `type=volume,src=${volume},dst=/run/oce/repository-output,volume-nocopy`;
    const privateMount = `type=volume,src=${volume},dst=/run/oce/repository-credentials,volume-subpath=private,volume-nocopy`;
    const descriptor = {
      ...fixture.descriptor,
      sourceRoot: "/run/oce/repository-projection",
      targetRoot: "/run/oce/repository-output/private",
    };
    const material = () =>
      run(
        "1000:1000",
        [outputMount, `type=bind,src=${fixture.sourceRoot},dst=${descriptor.sourceRoot},readonly`],
        fixture.deployment.initContainers[0].args[0],
        JSON.stringify(descriptor),
      );
    const copied = material();
    assert.equal(copied.status, 0, copied.stderr);
    const parent = run(
      "1000:1000",
      [outputMount],
      `const s=require("node:fs").statSync("/run/oce/repository-output"); console.log(s.uid, s.gid, (s.mode & 0o7777).toString(8));`,
    );
    assert.equal(parent.status, 0, parent.stderr);
    assert.equal(parent.stdout.trim(), "0 1000 2775");
    const prepare = (user = "1000:1000") =>
      run(
        user,
        [privateMount],
        fixture.deployment.initContainers[1].args[0],
        fixture.deployment.initContainers[1].args[1],
      );
    // A different UID cannot adopt or delete the first init's private material.
    const otherOwner = prepare("1001:1000");
    assert.equal(otherOwner.status, 1, otherOwner.stderr);
    const partial = run(
      "1000:1000",
      [privateMount],
      `require("node:fs").writeFileSync("/run/oce/repository-credentials/gitconfig", "partial", {mode:0o600});`,
    );
    assert.equal(partial.status, 0, partial.stderr);
    const prepared = prepare();
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(prepare().status, 0);
    const consumer = run(
      "1000:1000",
      [privateMount + ",readonly"],
      `
    const fs = require("node:fs");
    import("/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/manifest.js").then(async ({readRuntimeRepositoryManifest}) => {
      const manifest = await readRuntimeRepositoryManifest();
      require("node:assert/strict").equal(manifest.bindings.length, 1);
      require("node:assert/strict").match(fs.readFileSync("/run/oce/repository-credentials/gitconfig", "utf8"), /git-helper/);
      require("node:assert/strict").throws(() => fs.writeFileSync("/run/oce/repository-credentials/unexpected", "x"), {code:"EROFS"});
    }).catch(() => { process.exitCode = 1; });
  `,
    );
    assert.equal(consumer.status, 0, consumer.stderr);
  },
);
