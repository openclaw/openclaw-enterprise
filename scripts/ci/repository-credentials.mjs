import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ghVersion = "2.100.0";
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

export async function prepareRepositoryCredentials({
  repositoryRoot,
  imagePrefix,
  receiptPath,
  execFile,
  registerImage,
  markImageReady,
}) {
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  await execFile(docker, ["version", "--format", "{{.Server.Version}}"]);
  await execFile(docker, ["compose", "version"]);
  await execFile("pnpm", ["credentials:build"], {
    timeoutMs: 300_000,
  });

  const artifactRoot = join(repositoryRoot, ".build/repository-credentials");
  const imageDefinitions = join(repositoryRoot, "deploy/runtime/repository-credentials");
  async function buildImage(name, dockerfile, context, buildArgs = []) {
    const tag = `${imagePrefix}/${name}:local`;
    const resource = await registerImage(tag);
    // All three builds use the engine's local store so the qualification build
    // resolves its two delivered inputs without a registry publication.
    await execFile(
      docker,
      [
        "build",
        "--builder",
        "default",
        "--load",
        "--pull=false",
        "-f",
        dockerfile,
        "-t",
        tag,
        ...buildArgs,
        context,
      ],
      { timeoutMs: 900_000 },
    );
    const inspected = await execFile(docker, ["image", "inspect", "--format", "{{.Id}}", tag]);
    const id = inspected.stdout.trim();
    assert.match(id, imageIdPattern, `Invalid ${name} image ID`);
    await markImageReady(resource, id);
    return { tag, id };
  }

  const service = await buildImage(
    "service",
    join(imageDefinitions, "Dockerfile"),
    join(artifactRoot, "service"),
  );
  const client = await buildImage(
    "client",
    join(imageDefinitions, "Dockerfile.client"),
    join(artifactRoot, "client"),
  );
  const qualification = await buildImage(
    "qualification",
    join(repositoryRoot, "tests/fixtures/repository-credentials/Dockerfile.qualification"),
    repositoryRoot,
    ["--build-arg", `SERVICE_IMAGE=${service.tag}`, "--build-arg", `CLIENT_IMAGE=${client.tag}`],
  );
  const source = await execFile("git", ["rev-parse", "HEAD"]);
  const sourceTree = await execFile("git", ["rev-parse", "HEAD^{tree}"]);
  await writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        version: 1,
        lane: "repository-credentials-container",
        sourceCommit: source.stdout.trim(),
        sourceTree: sourceTree.stdout.trim(),
        ghVersion,
        images: { service, client, qualification },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return {
    // The test composition runs as root for its isolated port-443 listener;
    // the delivered service and client retain their unprivileged image users.
    REPOSITORY_CREDENTIALS_NODE_IMAGE: qualification.id,
    REPOSITORY_CREDENTIALS_TEST_IMAGE: qualification.id,
    REPOSITORY_CREDENTIALS_SERVICE_IMAGE: service.id,
    REPOSITORY_CREDENTIALS_CLIENT_IMAGE: client.id,
  };
}

export async function prepareRepositoryCredentialsFile({ clientImage, execFile }) {
  assert.match(clientImage ?? "", imageIdPattern, "A prepared client image is required");
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "openclaw-ci-gh-"));
  const binary = join(directory, "gh");
  const container = `openclaw-ci-gh-${randomUUID()}`;
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    // Extract the checksum-verified delivered binary. Do not trust the runner's
    // gh installation or expose its home directory to the extraction container.
    try {
      await execFile(
        docker,
        [
          "run",
          "--rm",
          "--name",
          container,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          `${process.getuid()}:${process.getgid()}`,
          "--mount",
          `type=bind,src=${directory},dst=/output`,
          "--entrypoint",
          "node",
          clientImage,
          "-e",
          'require("node:fs").copyFileSync("/usr/local/bin/gh", "/output/gh")',
        ],
        { timeoutMs: 60_000 },
      );
    } finally {
      await execFile(docker, ["rm", "-f", container], { timeoutMs: 30_000 }).catch((error) => {
        if (!/No such container/i.test(error.message)) {
          throw error;
        }
      });
    }
    await chmod(binary, 0o755);
    const version = await execFile(binary, ["--version"], { timeoutMs: 10_000 });
    assert.match(version.stdout, /^gh version 2\.100\.0\b/, `Expected gh ${ghVersion}`);
    return { env: { REPOSITORY_CREDENTIALS_GH_BINARY: binary }, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
