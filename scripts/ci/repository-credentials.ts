import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isRecord } from "./records.ts";

const ghVersion = "2.103.2";
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

type ImageId = `sha256:${string}`;

type RunCommand = (
  command: string,
  args: string[],
  options?: { timeoutMs: number },
) => Promise<unknown>;

export interface RepositoryCredentialsImageJournal {
  imagePrefix: string;
  registerImage: (tag: string) => Promise<(imageId: ImageId) => Promise<void>>;
}

interface ImagePreparation extends RepositoryCredentialsImageJournal {
  repositoryRoot: string;
  execFile: RunCommand;
}

interface ServicePreparation extends ImagePreparation {
  serviceOnly: true;
  receiptPath?: never;
}

interface FullPreparation extends ImagePreparation {
  serviceOnly?: false;
  receiptPath: string;
}

interface QualificationImages {
  REPOSITORY_CREDENTIALS_NODE_IMAGE: ImageId;
  REPOSITORY_CREDENTIALS_TEST_IMAGE: ImageId;
  REPOSITORY_CREDENTIALS_SERVICE_IMAGE: ImageId;
  REPOSITORY_CREDENTIALS_CLIENT_IMAGE: ImageId;
}

function commandStdout(result: unknown, errorMessage: string): string {
  if (!isRecord(result) || typeof result.stdout !== "string") {
    throw new Error(errorMessage);
  }
  return result.stdout;
}

function isImageId(value: unknown): value is ImageId {
  return typeof value === "string" && value.length === 71 && imageIdPattern.test(value);
}

export function prepareRepositoryCredentials(options: ServicePreparation): Promise<string>;
export function prepareRepositoryCredentials(
  options: FullPreparation,
): Promise<QualificationImages>;
export async function prepareRepositoryCredentials(
  options: ServicePreparation | FullPreparation,
): Promise<string | QualificationImages> {
  const { repositoryRoot, imagePrefix, execFile, registerImage } = options;
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  await execFile(docker, ["version", "--format", "{{.Server.Version}}"]);
  await execFile(docker, ["compose", "version"]);
  await execFile("pnpm", ["credentials:build"], {
    timeoutMs: 300_000,
  });

  const artifactRoot = join(repositoryRoot, ".build/repository-credentials");
  const imageDefinitions = join(repositoryRoot, "deploy/runtime/repository-credentials");
  async function buildImage(
    name: "service" | "client" | "qualification",
    dockerfile: string,
    context: string,
    buildArgs: string[] = [],
  ) {
    const tag = `${imagePrefix}/${name}:local`;
    const markImageReady = await registerImage(tag);
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
    const errorMessage = `Invalid ${name} image ID`;
    const id = commandStdout(inspected, errorMessage).trim();
    if (!isImageId(id)) {
      throw new Error(errorMessage);
    }
    await markImageReady(id);
    return { tag, id };
  }

  const service = await buildImage(
    "service",
    join(imageDefinitions, "Dockerfile"),
    join(artifactRoot, "service"),
  );
  if (options.serviceOnly) {
    // k3d imports this run-owned tag, then verifies the immutable reference on each node.
    return service.tag;
  }
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
  const sourceError = "Invalid source commit for repository credential images";
  const sourceCommit = commandStdout(source, sourceError).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit)) {
    throw new Error(sourceError);
  }
  await writeFile(
    options.receiptPath,
    `${JSON.stringify(
      {
        version: 1,
        lane: "repository-credentials-container",
        sourceCommit,
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

export async function prepareRepositoryCredentialsFile({
  clientImage,
  execFile,
}: {
  clientImage: unknown;
  execFile: RunCommand;
}) {
  if (!isImageId(clientImage)) {
    throw new Error("A prepared client image is required");
  }
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Repository credential binary extraction requires a POSIX user and group ID.");
  }
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
          `${uid}:${gid}`,
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
      await execFile(docker, ["rm", "-f", container], { timeoutMs: 30_000 }).catch(
        (error: unknown) => {
          if (!(error instanceof Error) || !/No such container/i.test(error.message)) {
            throw error;
          }
        },
      );
    }
    await chmod(binary, 0o755);
    const version = await execFile(binary, ["--version"], { timeoutMs: 10_000 });
    const errorMessage = `Expected gh ${ghVersion}`;
    const reportedVersion = /^gh version (\S+)/.exec(commandStdout(version, errorMessage))?.[1];
    if (reportedVersion !== ghVersion) {
      throw new Error(errorMessage);
    }
    return { env: { REPOSITORY_CREDENTIALS_GH_BINARY: binary }, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
