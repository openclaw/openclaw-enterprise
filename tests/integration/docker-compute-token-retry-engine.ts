import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { waitForResult } from "../helpers/wait-for.mjs";

const execute = promisify(execFile);
const socketPath = "/var/run/docker.sock";
const maxResponseBytes = 4 * 1024 * 1024;
export const labelNamespace = "org.openclaw.enterprise.namespace-id";
export const labelAgent = "org.openclaw.enterprise.agent-id";
export const labelRevision = "org.openclaw.enterprise.revision-id";
export const labelRole = "org.openclaw.enterprise.role";

type Labels = Readonly<Record<string, string>>;

const nonempty = Type.String({ minLength: 1 });
const containerId = Type.String({ pattern: "^[0-9a-f]{64}$" });
const portBinding = Type.Object({ HostIp: nonempty, HostPort: nonempty });
const containerInspection = Type.Object({
  Id: containerId,
  Name: Type.String({ pattern: "^/[^/]+$" }),
  Config: Type.Object({
    Env: Type.Array(Type.String()),
    Image: nonempty,
    Labels: Type.Record(Type.String(), Type.String()),
  }),
  HostConfig: Type.Object({ NetworkMode: nonempty }),
  NetworkSettings: Type.Object({
    Ports: Type.Union([
      Type.Null(),
      Type.Record(Type.String(), Type.Union([Type.Null(), Type.Array(portBinding)])),
    ]),
  }),
  State: Type.Object({
    Running: Type.Boolean(),
    Health: Type.Optional(Type.Object({ Status: nonempty })),
  }),
});
const containerInspections = Type.Array(containerInspection);
const createdContainer = Type.Object({ Id: containerId });
type Container = Type.Static<typeof containerInspection>;

export async function docker(args: readonly [string, ...string[]], { timeoutMs = 120_000 } = {}) {
  const env = { ...process.env };
  for (const name of [
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]) {
    delete env[name];
  }
  try {
    return await execute("docker", ["--host", `unix://${socketPath}`, ...args], {
      env,
      timeout: timeoutMs,
      maxBuffer: maxResponseBytes,
    });
  } catch {
    // Command output and errors can contain the inspected container's credentials.
    throw new Error(`Docker ${args[0]} failed. Command output withheld.`);
  }
}

function parseDockerJson(text: string, operation: "inspect" | "create"): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Docker fixture ${operation} returned invalid JSON.`);
  }
}

async function dockerLines(args: Parameters<typeof docker>[0]) {
  const { stdout } = await docker(args);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function ownedLabels(namespaceId: string): Labels {
  return {
    "org.openclaw.enterprise.managed": "true",
    "org.openclaw.enterprise.compute-driver": "docker",
    [labelNamespace]: namespaceId,
  };
}

function labelArguments(option: "--label" | "--filter", labels: Labels) {
  return Object.entries(labels).flatMap(([name, value]) => [
    option,
    `${option === "--filter" ? "label=" : ""}${name}=${value}`,
  ]);
}

export function namespaceLabels(namespaceId: string) {
  return labelArguments("--label", ownedLabels(namespaceId));
}

export function containerIds(namespaceId: string, labels: Labels = {}) {
  return dockerLines([
    "ps",
    "-aq",
    "--no-trunc",
    ...labelArguments("--filter", { ...ownedLabels(namespaceId), ...labels }),
  ]);
}

export function networkIds(namespaceId: string) {
  return dockerLines([
    "network",
    "ls",
    "-q",
    "--no-trunc",
    ...labelArguments("--filter", ownedLabels(namespaceId)),
  ]);
}

export function workspaceVolumes(namespaceId: string) {
  return dockerLines([
    "volume",
    "ls",
    "-q",
    ...labelArguments("--filter", { ...ownedLabels(namespaceId), [labelRole]: "workspace" }),
  ]);
}

export async function assertVolumeRemoved(name: string) {
  const volumes = await dockerLines(["volume", "ls", "-q", "--filter", `name=${name}`]);
  assert.ok(!volumes.includes(name), "removed the exact workspace volume");
}

export async function inspectContainer(id: string) {
  const [container] = await inspectContainers([id]);
  assert.ok(container, "expected an inspected fixture container");
  return container;
}

async function inspectContainers(ids: readonly string[]) {
  if (ids.length === 0) {
    return [];
  }
  // A namespace-scoped list can race container removal during startup. The
  // polling caller retries failed reads. Never attach an inspect body to an error.
  const { stdout } = await docker(["inspect", "--type", "container", ...ids]);
  const value = parseDockerJson(stdout, "inspect");
  if (
    !Check(containerInspections, value) ||
    value.length !== ids.length ||
    value.some((container, index) => container.Id !== ids[index])
  ) {
    throw new Error("Docker fixture inspect returned unexpected container data.");
  }
  return value;
}

const readinessWait = { timeoutMs: 120_000, intervalMs: 500, retryErrors: true };

function isHealthy(container: Container) {
  return container.State.Running && container.State.Health?.Status === "healthy";
}

export async function waitForRuntime(namespaceId: string, agentId: string, revisionId: string) {
  function waitForRole(role: "gateway" | "agent", description: string) {
    return waitForResult(
      description,
      async () => {
        const ids = await containerIds(namespaceId, {
          [labelAgent]: agentId,
          [labelRevision]: revisionId,
          [labelRole]: role,
        });
        const running = (await inspectContainers(ids)).filter(isHealthy);
        return running.length === 1 ? running[0] : undefined;
      },
      readinessWait,
    );
  }

  const gateway = await waitForRole("gateway", "dedicated gateway container");
  const agent = await waitForRole("agent", "dedicated app-server container");
  return { agent, gateway };
}

export function containerEnv(container: Container, name: string) {
  const entry = container.Config.Env.find((value) => value.startsWith(`${name}=`));
  return entry?.slice(name.length + 1);
}

export async function assertGatewayCanReachAgent(gateway: Container) {
  const port = containerEnv(gateway, "OPENCLAW_GATEWAY_PORT");
  assert.ok(port, "gateway declares an HTTP port");
  const bindings = gateway.NetworkSettings.Ports?.[`${port}/tcp`];
  assert.ok(bindings?.length === 1, "gateway publishes one HTTP port binding");
  assert.equal(bindings[0]?.HostIp, "127.0.0.1");
  // Probe inside the owned gateway so the test also works when the Docker
  // daemon and test runner have different network namespaces. The fixture
  // endpoint still performs real gateway-to-app-server WebSocket requests.
  await docker([
    "exec",
    gateway.Id,
    "node",
    "-e",
    `fetch("http://127.0.0.1:" + process.env.OPENCLAW_GATEWAY_PORT + "/token-check", {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => process.exit(response.status === 200 ? 0 : 1))
      .catch(() => process.exit(1));`,
  ]);
}

function postDocker(path: string, body?: Record<string, unknown>) {
  return new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method: "POST",
        path,
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
      async (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          const responseChunks: AsyncIterable<unknown, unknown, unknown> = response;
          for await (const chunk of responseChunks) {
            if (!Buffer.isBuffer(chunk)) {
              throw new Error("Invalid Docker response chunk.");
            }
            bytes += chunk.length;
            if (bytes > maxResponseBytes) {
              throw new Error("Docker response exceeds the fixture limit.");
            }
            chunks.push(chunk);
          }
          resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() });
        } catch {
          reject(new Error("Docker fixture API response failed."));
        }
      },
    );
    request.on("error", () => reject(new Error("Docker fixture API request failed.")));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function createContainer(name: string, body: Record<string, unknown>) {
  const { status, text } = await postDocker(
    `/containers/create?name=${encodeURIComponent(name)}`,
    body,
  );
  if (status !== 201) {
    throw new Error(`Docker fixture create returned HTTP ${status}.`);
  }
  const value = parseDockerJson(text, "create");
  if (!Check(createdContainer, value)) {
    throw new Error("Docker fixture create did not return a container ID.");
  }
  return value.Id;
}

async function startContainer(id: string) {
  const { status, text } = await postDocker(`/containers/${id}/start`);
  if (status !== 204 || text !== "") {
    throw new Error(
      `Docker fixture start expected an empty HTTP 204 response (got HTTP ${status}).`,
    );
  }
}

export async function replaceWithForeignOwner(
  container: Container,
  role: "agent" | "gateway",
  foreignOwners: Map<string, string | undefined>,
) {
  const name = container.Name.slice(1);
  const network = container.HostConfig.NetworkMode;
  const foreignOwner = `agt_${randomUUID()}`;
  await docker(["rm", "-f", container.Id]);
  // Track the exact foreign label before creation so cleanup can recover a lost
  // response or a malformed ID without deleting a same-name replacement.
  foreignOwners.set(foreignOwner, undefined);
  const id = await createContainer(name, {
    ...container.Config,
    Labels: { ...container.Config.Labels, [labelAgent]: foreignOwner },
    HostConfig: {
      ...container.HostConfig,
      PortBindings:
        role === "gateway" ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } : {},
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [name] } } },
  });
  foreignOwners.set(foreignOwner, id);
  await startContainer(id);
  await waitForResult(
    "healthy foreign-owned fixture container",
    async () => {
      const observed = await inspectContainer(id);
      return isHealthy(observed) ? observed.Id : undefined;
    },
    readinessWait,
  );
  return id;
}

export async function removeFixtureImage(tag: string) {
  const findTag = () => dockerLines(["image", "ls", "-q", "--filter", `reference=${tag}`]);
  if ((await findTag()).length > 0) {
    await docker(["rmi", tag], { timeoutMs: 60_000 });
  }
  assert.equal((await findTag()).length, 0, "removed the fixture image tag");
}

export async function cleanUp(...steps: readonly (() => Promise<void>)[]) {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Disposable Docker fixture cleanup failed.");
  }
}
