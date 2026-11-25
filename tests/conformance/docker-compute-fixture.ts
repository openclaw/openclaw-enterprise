import assert from "node:assert/strict";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import {
  admitLoggingConfiguration,
  type AgentRevision,
  type Namespace,
  type OpenClawConfigurationDocument,
} from "../../packages/contracts/src/index.ts";
import type { EmbeddedContainerInspect } from "../../apps/controller/src/drivers/compute/docker/embedded-gateway-recovery.ts";
import { withEnvironment } from "../helpers/environment.ts";

export const tenant: Namespace = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Docker conformance tenant",
  status: "ready",
  createdAt: "2026-09-01T00:00:00.000Z",
};
export function dockerGatewayRevision(
  driver: DockerComputeDriver,
  configuration: OpenClawConfigurationDocument = {},
): DockerRevision {
  const gateway = configuration.gateway;
  const auth = isRecord(gateway) ? gateway.auth : undefined;
  const mode = isRecord(auth) ? auth.mode : undefined;
  return {
    ...dockerAgentRevision(driver, {
      id: `revision-${mode ?? "default-password"}`,
      agentId: "agent-docker-auth",
      mode: "embedded",
    }),
    configuration: admitLoggingConfiguration(configuration, "info"),
    gatewayManagedMode: true,
  };
}

export function splitEnvironment(entry: string): [string, string] {
  const separator = entry.indexOf("=");
  assert.ok(separator > 0, `Docker Env entry must be NAME=value: ${entry}`);
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}
export const namespaceLabels = {
  "org.openclaw.enterprise.managed": "true",
  "org.openclaw.enterprise.compute-driver": "docker",
  "org.openclaw.enterprise.namespace-id": tenant.id,
};

export function dockerDriver() {
  return new DockerComputeDriver({ images: { gateway: "gateway:local", agent: "agent:local" } });
}

// Direct Docker preparation accepts a revision without a Harness authentication binding.
// OCC's current revision type requires the field, and Docker rejects every binding before setup.
type DockerRevision = Omit<AgentRevision, "harnessAuth"> & { readonly harnessAuth?: never };

export function prepareDockerRevision(
  driver: DockerComputeDriver,
  revision: DockerRevision,
  context?: Pick<
    NonNullable<Parameters<DockerComputeDriver["prepareRevision"]>[1]>,
    "workspaceSetup"
  >,
) {
  return driver.prepareRevision(
    revision as AgentRevision,
    context === undefined
      ? undefined
      : { ...context, harnessAuth: { method: "runtime" }, secretEnvironment: [] },
  );
}

export function stopDockerRevision(driver: DockerComputeDriver, revision: DockerRevision) {
  return driver.stopRevision(revision as AgentRevision);
}

// The emitted Driver declarations erase private members. Spell out the fixture boundary
// here so request handlers accept raw bodies and produce untrusted Engine responses.
export type DockerRequest = (
  method: string,
  path: string,
  body: unknown,
  expected: readonly number[],
  timeoutMs?: number,
) => Promise<unknown>;

type ContainerInspection = EmbeddedContainerInspect & {
  Config?: { Labels?: Record<string, string> };
  State?: { ExitCode?: number; Health?: { Status?: string } };
};

interface DockerFixture {
  request: DockerRequest;
  network: (name: string) => Promise<{ Labels?: Record<string, string> } | undefined>;
  container: (name: string) => Promise<ContainerInspection | undefined>;
  removeContainer: (name: string) => Promise<void>;
  reconcileGateway: (revision: Readonly<AgentRevision>) => Promise<never>;
  initializeWorkspace: () => Promise<boolean>;
}

export function installDockerFixture(
  driver: DockerComputeDriver,
  overrides: Partial<DockerFixture>,
) {
  Object.assign(driver, overrides);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected an object in the Docker fixture");
  return value;
}

export function stringArray(value: unknown): string[] {
  assert.ok(isStringArray(value));
  return value;
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const entries: readonly unknown[] = value;
  return entries.every((entry) => typeof entry === "string");
}

export const parseJson: (text: string) => unknown = JSON.parse;

export interface ContainerCreate extends Record<string, unknown> {
  Labels: Record<string, string>;
  Cmd: string[];
  Env: string[];
}

export function readContainerCreate(value: unknown): ContainerCreate {
  const body = readRecord(value);
  assert.ok(
    isContainerCreate(body),
    "expected Docker container create labels, command and environment",
  );
  return body;
}

function isContainerCreate(body: Record<string, unknown>): body is ContainerCreate {
  return (
    isRecord(body.Labels) &&
    Object.values(body.Labels).every((label) => typeof label === "string") &&
    isStringArray(body.Cmd) &&
    isStringArray(body.Env)
  );
}

export interface CreatedContainer {
  Config: ContainerCreate;
  State: { Running: boolean; ExitCode?: number; Health?: { Status: string } };
}

type EngineContainer = CreatedContainer | ContainerInspection;

/** Reuses Engine observations across fresh Drivers to exercise real reconciliation. */
export function fakeDockerEngine<Inspection extends EngineContainer = CreatedContainer>(
  inspectCreated?: (name: string, created: CreatedContainer) => Inspection,
) {
  const containers = new Map<string, CreatedContainer | Inspection>();
  const request: DockerRequest = async (method, path, body) => {
    const url = new URL(path, "http://docker.invalid");
    if (method === "POST" && url.pathname === "/containers/create") {
      const name = url.searchParams.get("name");
      assert.ok(name);
      const created = {
        Config: readContainerCreate(structuredClone(body)),
        State: { Running: true, Health: { Status: "healthy" } },
      };
      containers.set(name, inspectCreated?.(name, created) ?? created);
      return "";
    }
    const [, name, action] = /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname) ?? [];
    if (method === "POST" && action === "start") {
      return "";
    }
    if (method === "POST" && action === "stop" && name !== undefined) {
      const container = containers.get(name);
      if (container !== undefined) {
        container.State = { Running: false, ExitCode: 0 };
      }
      return "";
    }
    if (method === "DELETE" && name !== undefined) {
      containers.delete(name);
      return "";
    }
    throw new Error(`Unexpected Docker API request ${method} ${path}`);
  };
  const createDriver = () => {
    const driver = dockerDriver();
    installDockerFixture(driver, {
      network: async () => ({ Labels: namespaceLabels }),
      request,
      container: async (name) => containers.get(name),
    });
    return driver;
  };
  return { containers, createDriver, request };
}

export function withModelKey<T>(body: () => T | PromiseLike<T>) {
  return withEnvironment({ OPENAI_API_KEY: "test-openai-api-key" }, body);
}

export function dockerAgentRevision(
  driver: DockerComputeDriver,
  {
    id,
    agentId,
    revision = 1,
    mode,
  }: { id: string; agentId: string; revision?: number; mode: AgentRevision["harness"]["mode"] },
): DockerRevision {
  return {
    id,
    namespaceId: tenant.id,
    agentId,
    revision,
    backendId: null,
    gatewayManagedMode: false,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    executionAdmission: { version: 2, mode: "unprotected" },
    configuration: admitLoggingConfiguration({}, "info"),
    harness: {
      id: mode === "dedicated" ? "codex" : "openclaw",
      version: "1.0.0",
      mode,
      overrides: {},
      configuration: {},
    },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: `service-principal-${agentId}`,
    createdAt: tenant.createdAt,
  };
}
