import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BOOTSTRAP_KEY_FILE,
  DEFAULT_DEVELOPMENT_PROJECT,
  DEFAULT_RUNTIME_IMAGE,
  copyPrivateFile,
  requireNonEmpty,
  runCapture,
  sha256Hex,
  validatePrivateRegularFile,
  waitFor,
} from "./common.mjs";

const BOOTSTRAP_CONTAINER_KEY_PATH = "/var/lib/openclaw/bootstrap/initial-admin-service-key.json";
const COMPOSE_FILE = "compose.yaml";
const INTERNAL_API_PORT = "3000";

export function createDevelopmentBackend({ config, directory, state, save, run, progress }) {
  const runtimeImage = config.runtimeImage ?? DEFAULT_RUNTIME_IMAGE;
  const composeProject =
    process.env.COMPOSE_PROJECT_NAME ??
    state.backend?.identity?.composeProject ??
    DEFAULT_DEVELOPMENT_PROJECT;
  const secrets = [process.env.OPENAI_API_KEY].filter(Boolean);

  return {
    progress,
    async start() {
      const modelKey = requireNonEmpty(process.env.OPENAI_API_KEY, "OPENAI_API_KEY");
      const startupSecrets = [modelKey];
      await validateDevelopmentTools(run);
      await ensureRuntimeImage({ run, image: runtimeImage, progress, secrets: startupSecrets });
      const env = {
        ...process.env,
        COMPOSE_PROJECT_NAME: composeProject,
        OCC_DOCKER_RUNTIME_IMAGE: runtimeImage,
        OCC_DOCKER_GATEWAY_IMAGE: process.env.OCC_DOCKER_GATEWAY_IMAGE || runtimeImage,
        OCC_DOCKER_AGENT_IMAGE: process.env.OCC_DOCKER_AGENT_IMAGE || runtimeImage,
        OPENAI_API_KEY: modelKey,
      };
      progress(`starting Docker Compose project ${composeProject}`);
      await run("docker", composeArgs(composeProject, ["up", "--build", "--detach", "--wait"]), {
        env,
        timeout: 300_000,
        secrets: startupSecrets,
      });
      const bootstrapId = (
        await run("docker", composeArgs(composeProject, ["ps", "--all", "-q", "bootstrap"]), {
          env,
          timeout: 30_000,
          secrets: startupSecrets,
        })
      ).trim();
      if (bootstrapId.length === 0) {
        throw new Error("Docker Compose bootstrap service did not produce a container.");
      }
      const bootstrapState = (
        await run(
          "docker",
          ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", bootstrapId],
          {
            env,
            timeout: 30_000,
            secrets: startupSecrets,
          },
        )
      ).trim();
      if (bootstrapState !== "exited 0") {
        throw new Error(
          `Docker Compose bootstrap service did not exit successfully: ${bootstrapState}`,
        );
      }
      const controllerPort = await resolveControllerPort({
        run,
        composeProject,
        env,
        secrets: startupSecrets,
      });
      const url = `http://127.0.0.1:${controllerPort}`;
      await waitFor("OCC API to accept loopback requests", async () => {
        const response = await fetch(new URL("/api/auth/session", url), {
          signal: AbortSignal.timeout(2_000),
        }).catch(() => undefined);
        return response?.status === 200 ? true : undefined;
      });
      const keyFile = join(directory, BOOTSTRAP_KEY_FILE);
      await copyBootstrapKey({ run, bootstrapId, keyFile, env, secrets: startupSecrets });
      return {
        url,
        keyFile,
        details: {
          composeProject,
          runtimeImage,
          gatewayImage: env.OCC_DOCKER_GATEWAY_IMAGE,
          agentImage: env.OCC_DOCKER_AGENT_IMAGE,
        },
      };
    },
    async prepareNamespace() {},
    async prepareAgent() {},
    async tuiCommand({ namespaceId, agentId, revisionId, session, message }) {
      const gateway = await findGatewayContainer({
        namespaceId,
        agentId,
        revisionId,
        secrets,
      });
      const clientState = `/tmp/occ-tui-client-${sha256Hex(`${namespaceId}:${agentId}:${session}`, 16)}`;
      return {
        command: "docker",
        args: [
          "exec",
          "--interactive",
          "--tty",
          gateway,
          "env",
          "-u",
          "OPENAI_API_KEY",
          `OPENCLAW_STATE_DIR=${clientState}`,
          "node",
          "/app/openclaw.mjs",
          "tui",
          "--session",
          session,
          "--message",
          message,
        ],
      };
    },
  };
}

export function developmentIdentity(config) {
  const runtimeImage = config.runtimeImage ?? DEFAULT_RUNTIME_IMAGE;
  return {
    model: config.model,
    runtimeImage,
    gatewayImage: process.env.OCC_DOCKER_GATEWAY_IMAGE || runtimeImage,
    agentImage: process.env.OCC_DOCKER_AGENT_IMAGE || runtimeImage,
    composeProject: process.env.COMPOSE_PROJECT_NAME ?? DEFAULT_DEVELOPMENT_PROJECT,
    openclawDevPort: process.env.OPENCLAW_DEV_PORT ?? null,
    postgresPort: process.env.OCC_POSTGRES_PORT ?? null,
    trustedBridgeCidr: process.env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR ?? null,
  };
}

export async function validateDevelopmentTools(run) {
  await run("docker", ["version"], { timeout: 30_000 });
  await run("docker", ["compose", "version"], { timeout: 30_000 });
}

async function ensureRuntimeImage({ run, image, progress, secrets }) {
  try {
    await run("docker", ["image", "inspect", image], { timeout: 30_000, secrets });
    return;
  } catch {
    progress(`building missing runtime image ${image}`);
  }
  await run(
    "docker",
    ["build", "-f", "deploy/runtime/Dockerfile", "--tag", image, "deploy/runtime"],
    {
      timeout: 600_000,
      secrets,
    },
  );
}

function composeArgs(project, args) {
  return ["compose", "-f", COMPOSE_FILE, "-p", project, ...args];
}

async function resolveControllerPort({ run, composeProject, env, secrets }) {
  const output = (
    await run("docker", composeArgs(composeProject, ["port", "controller", INTERNAL_API_PORT]), {
      env,
      timeout: 30_000,
      secrets,
    })
  ).trim();
  const match = output.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):(\d+)$/);
  if (match === null) {
    throw new Error(
      `Unable to resolve controller loopback port from Docker Compose output: ${output}`,
    );
  }
  return match[1];
}

async function copyBootstrapKey({ run, bootstrapId, keyFile, env, secrets }) {
  try {
    await stat(keyFile);
    await validatePrivateRegularFile(keyFile, "Bootstrap service-key file");
    JSON.parse(await readFile(keyFile, "utf8"));
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${keyFile}.tmp`;
  await run("docker", ["cp", `${bootstrapId}:${BOOTSTRAP_CONTAINER_KEY_PATH}`, temporary], {
    env,
    timeout: 60_000,
    secrets,
  });
  try {
    await copyPrivateFile(temporary, keyFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function findGatewayContainer({ namespaceId, agentId, revisionId, secrets }) {
  const filters = [
    ["label", "org.openclaw.enterprise.managed=true"],
    ["label", "org.openclaw.enterprise.compute-driver=docker"],
    ["label", "org.openclaw.enterprise.role=gateway"],
    ["label", `org.openclaw.enterprise.namespace-id=${namespaceId}`],
    ["label", `org.openclaw.enterprise.agent-id=${agentId}`],
    ["label", `org.openclaw.enterprise.revision-id=${revisionId}`],
  ];
  const args = [
    "ps",
    "-q",
    ...filters.flatMap(([name, value]) => ["--filter", `${name}=${value}`]),
  ];
  const output = await runCapture("docker", args, { timeout: 30_000, secrets });
  const ids = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(
      `Expected exactly one active gateway container for ${revisionId}; found ${ids.length}.`,
    );
  }
  return ids[0];
}
