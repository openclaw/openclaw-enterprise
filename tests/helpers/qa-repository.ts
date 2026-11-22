import { GATEWAY_STOP_TIMEOUT_MS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { cleanupRepositoryJourney } from "./repository-remote-cleanup.ts";
import { captureChild } from "./child-processes.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PREPARED_REPOSITORY_DIRECTORY,
  REPOSITORY_CONTROL_SOCKET,
} from "../../scripts/lib/prepared-repository-installation.ts";
import { verifyNativeRepositoryJourney } from "./repository-native-journey.mjs";
import type { deployQaAgentAndWait } from "./qa-installation.mjs";
import { createGitHubAppRepositoryObserver } from "./github-app-observer.ts";
import {
  createRepositoryObserver,
  readInstalledCredentialSession,
} from "./repository-credentials-installed.mjs";
import {
  applyQaRepositoryInstallation,
  qaRepositoryBranch,
  qaRepositoryServiceConfig,
  readQaRepositoryRegistry,
  readQaRepositoryUpstreamPolicy,
  selectPreparedQaRepository,
} from "./qa-repository-preparation.ts";
import { dumpYaml, loadYaml, yamlMapping } from "./kubernetes-yaml.ts";
import { waitFor } from "./qa-wait.ts";
import { protectedText, redactedQaTail, registerQaSecret } from "./qa-secrets.ts";

type QaRepositoryEntry = ReturnType<typeof selectPreparedQaRepository>;
type QaInstallationConfiguration = Parameters<typeof applyQaRepositoryInstallation>[0] & {
  drivers: { compute: { configuration: { images: { agent: string } } } };
};
type QaCommandOptions = {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  input?: string | undefined;
  privateFailureOutput?: boolean;
  allowExitCodes?: number[];
};
type QaRecorder = (name: string, value: unknown) => Promise<string>;
type QaApi = (method: string, path: string, body?: object) => Promise<unknown>;
type QaPod = {
  metadata?: {
    namespace?: string;
    name?: string;
    deletionTimestamp?: string | null;
    finalizers?: string[];
    labels?: Record<string, string>;
  };
  status?: {
    phase?: string;
    startTime?: string;
    conditions?: { type: string; status: string }[];
    containerStatuses?: {
      name: string;
      restartCount: number;
      lastState?: {
        terminated?: { reason?: string; exitCode?: number; finishedAt?: string | null };
      };
    }[];
  };
  spec?: { containers: { env?: { name: string }[] }[] };
};
type QaRuntimePod = QaPod & {
  metadata: { namespace: string; name: string; uid: string };
  spec: { containers: { env?: { name: string }[] }[] };
};
type QaStopAgent = { id: string; namespaceId: string; stopCalls?: number; stopped?: boolean };
type QaAgent = QaStopAgent & {
  preset: string;
  configuration: { id: string };
  revision: { id: string };
};
type QaStopFixture = {
  controlPlane: string;
  env?: NodeJS.ProcessEnv;
  state: { platformNamespace: string };
  api: QaApi;
  kubectl: (...args: string[]) => Promise<string>;
  record: QaRecorder;
};
type QaInputFixture = {
  repositoryInput?: string;
  suffix: string;
  repositoryEntry?: QaRepositoryEntry;
};
type QaPrepareFixture = QaInputFixture &
  QaStopFixture & {
    directory: string;
    stateDirectory: string;
    cluster: string;
    namespace: { id: string };
    controllerDockerImage: string;
    configuration: QaInstallationConfiguration;
    cleanupRepositoryInputs?: () => Promise<void>;
    run: (command: string, args: string[], options?: QaCommandOptions) => Promise<string>;
    compose: (...args: string[]) => Promise<string>;
    apply: (object: object) => Promise<void>;
    saveInstallation: (configuration: QaInstallationConfiguration) => Promise<void>;
  };
type QaVerifyFixture = QaPrepareFixture & {
  repositoryEntry: QaRepositoryEntry;
  retained: boolean;
  pendingRepositories: Set<string>;
  deployAndWait: (agent: QaAgent) => ReturnType<typeof deployQaAgentAndWait>;
  get: (kind: "pod", name: string, namespace: string) => Promise<{ metadata: { uid: string } }>;
  pod: (agent: QaAgent, role: string) => Promise<QaRuntimePod>;
};
type QaStopCurrent = { desiredRuntimeState?: string; activeRevisionId?: string | null };
type StopObservation = { current: QaStopCurrent; pods: QaPod[] };
type StopSummary = {
  desiredRuntimeState?: string;
  activeRevisionId: string | null;
  pods: {
    namespace?: string;
    name?: string;
    phase?: string;
    deletionTimestamp: string | null;
    finalizers: string[];
  }[];
  omittedPods?: number;
};
type StopTiming = { timeout?: number; slowAfter?: number; now?: () => number; interval?: number };
type SlowStop = {
  thresholdMs: number;
  observedAfterMs: number;
  observation: StopSummary;
  platformLogs?: string;
  platformLogsUnavailable?: string[];
};
type ProbeEvidence = {
  hostname: string;
  addresses: string[];
  address?: string;
  tlsVerified?: boolean;
  httpStatus?: number;
  error?: string;
};
type LogFailure = { unavailable: string[] };
type LogTail = string[] | LogFailure;
type PlatformPod = ReturnType<typeof podRestarts>;
type PlatformEvent = {
  time: string | null;
  type?: string;
  reason?: string;
  object: string;
  count: number;
  message: string;
};
type PlatformLogs = {
  api: LogTail;
  worker: LogTail;
  platformPods: PlatformPod[] | LogFailure;
  workerPods?: Record<string, LogTail>;
  workerPrevious?: Record<string, LogTail>;
  events: Record<string, PlatformEvent[] | LogFailure>;
  gatewayDrain?: Record<string, LogTail>;
};
type CredentialSession = {
  state: string;
  activeUses: number;
  cleanup: { active: number; pending: number; uncertain: number; auxiliaryPending: boolean };
};
type CredentialAttempt = { repositoryRef: string; sessionId: string };
type RepositoryRemote = { id: string | number; full_name: string; default_branch: string };
type ConfigurationValues = {
  agents: { defaults: { workspace?: string; sandbox?: { mode: string } } };
  plugins?: Record<string, unknown>;
  tools?: { allow?: string[]; fs?: Record<string, unknown>; exec?: Record<string, unknown> };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `invalid ${label}`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `invalid ${label}`);
  return value;
}

function text(value: unknown, label: string): string {
  assert.ok(typeof value === "string", `invalid ${label}`);
  return value;
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function captureQaChild(
  program: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv | undefined; timeout: number },
): ReturnType<typeof captureChild> {
  const captureOptions = { encoding: "utf8", ...options };
  return captureChild(program, args, captureOptions);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isQaPod(value: unknown): value is QaPod {
  if (!isRecord(value)) {
    return false;
  }
  const { metadata, status, spec } = value;
  if (
    metadata !== undefined &&
    (!isRecord(metadata) ||
      [metadata.namespace, metadata.name, metadata.deletionTimestamp].some(
        (v) => v != null && typeof v !== "string",
      ) ||
      (metadata.finalizers !== undefined &&
        (!Array.isArray(metadata.finalizers) ||
          !metadata.finalizers.every((v) => typeof v === "string"))) ||
      (metadata.labels !== undefined &&
        (!isRecord(metadata.labels) ||
          !Object.values(metadata.labels).every((v) => typeof v === "string"))))
  ) {
    return false;
  }
  if (
    status !== undefined &&
    (!isRecord(status) ||
      [status.phase, status.startTime].some((v) => v !== undefined && typeof v !== "string") ||
      (status.conditions !== undefined &&
        (!Array.isArray(status.conditions) ||
          !status.conditions.every(
            (v) => isRecord(v) && typeof v.type === "string" && typeof v.status === "string",
          ))) ||
      (status.containerStatuses !== undefined &&
        (!Array.isArray(status.containerStatuses) ||
          !status.containerStatuses.every((v) => {
            if (!isRecord(v) || typeof v.name !== "string" || typeof v.restartCount !== "number") {
              return false;
            }
            if (v.lastState === undefined) {
              return true;
            }
            if (!isRecord(v.lastState)) {
              return false;
            }
            const terminated = v.lastState.terminated;
            return (
              terminated === undefined ||
              (isRecord(terminated) &&
                (terminated.reason === undefined || typeof terminated.reason === "string") &&
                (terminated.exitCode === undefined || typeof terminated.exitCode === "number") &&
                (terminated.finishedAt == null || typeof terminated.finishedAt === "string"))
            );
          }))))
  ) {
    return false;
  }
  if (
    spec !== undefined &&
    (!isRecord(spec) ||
      !Array.isArray(spec.containers) ||
      !spec.containers.every(
        (v) =>
          isRecord(v) &&
          (v.env === undefined ||
            (Array.isArray(v.env) &&
              v.env.every((e) => isRecord(e) && typeof e.name === "string"))),
      ))
  ) {
    return false;
  }
  return true;
}

function podsFromJson(value: string): QaPod[] {
  const items = array(record(parseJson(value), "Pod list").items, "Pod list items");
  assert.ok(items.every(isQaPod), "invalid Pod list item");
  return items;
}

function stopCurrent(value: unknown): QaStopCurrent {
  const current = record(value, "Agent stop response");
  assert.ok(
    current.desiredRuntimeState === undefined || typeof current.desiredRuntimeState === "string",
  );
  assert.ok(current.activeRevisionId == null || typeof current.activeRevisionId === "string");
  return current as QaStopCurrent;
}

function probeEvidence(value: unknown): ProbeEvidence {
  const evidence = record(value, "worker probe evidence");
  assert.equal(evidence.hostname, "api.github.com");
  assert.ok(
    Array.isArray(evidence.addresses) && evidence.addresses.every((v) => typeof v === "string"),
  );
  assert.ok(evidence.address === undefined || typeof evidence.address === "string");
  assert.ok(evidence.tlsVerified === undefined || typeof evidence.tlsVerified === "boolean");
  assert.ok(evidence.httpStatus === undefined || typeof evidence.httpStatus === "number");
  assert.ok(evidence.error === undefined || typeof evidence.error === "string");
  return {
    hostname: "api.github.com",
    addresses: evidence.addresses,
    ...(typeof evidence.address === "string" ? { address: evidence.address } : {}),
    ...(typeof evidence.tlsVerified === "boolean" ? { tlsVerified: evidence.tlsVerified } : {}),
    ...(typeof evidence.httpStatus === "number" ? { httpStatus: evidence.httpStatus } : {}),
    ...(typeof evidence.error === "string" ? { error: evidence.error } : {}),
  };
}

function repositoryRemote(value: unknown): RepositoryRemote {
  const remote = record(value, "GitHub repository");
  assert.ok(typeof remote.id === "string" || typeof remote.id === "number");
  return {
    id: remote.id,
    full_name: text(remote.full_name, "repository full name"),
    default_branch: text(remote.default_branch, "repository default branch"),
  };
}

function configurationValues(value: unknown): ConfigurationValues {
  const values = record(value, "configuration values");
  const agents = record(values.agents, "configuration agents");
  record(agents.defaults, "configuration defaults");
  if (values.plugins !== undefined) {
    record(values.plugins, "configuration plugins");
  }
  if (values.tools !== undefined) {
    const tools = record(values.tools, "configuration tools");
    if (tools.fs !== undefined) {
      record(tools.fs, "configuration filesystem tools");
    }
    if (tools.exec !== undefined) {
      record(tools.exec, "configuration execution tools");
    }
  }
  return values as ConfigurationValues;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function codexAppServer(values: ConfigurationValues): Record<string, unknown> {
  const plugins = record(values.plugins, "configuration plugins");
  const entries = record(plugins.entries, "configuration plugin entries");
  const codex = record(entries.codex, "configuration Codex plugin");
  const config = record(codex.config, "configuration Codex config");
  return record(config.appServer, "configuration app server");
}

// Run where prepared GitHub issuance runs, before any QA Agent binds this repository.
// Node HTTPS keeps production's DNS selection, agent:false and verified TLS. This
// public request proves transport only: even a 403 does not prove App credentials.
async function probeQaRepositoryWorker(
  f: QaPrepareFixture,
  { cidrs, approved }: Awaited<ReturnType<typeof readQaRepositoryUpstreamPolicy>>,
): Promise<void> {
  const script = String.raw`
    const { lookup } = await import("node:dns/promises");
    const { request } = await import("node:https");
    const { BlockList, isIP } = await import("node:net");
    const approved = new BlockList();
    for (const cidr of ${JSON.stringify(cidrs)}) {
      const [address, prefix] = cidr.split("/");
      approved.addSubnet(address, Number(prefix), "ipv4");
    }
    const evidence = { hostname: "api.github.com", addresses: [] };
    const codes = ["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "ENDPOINT_NOT_APPROVED"];
    const finish = (error) => {
      if (error) {
        evidence.error = error.code === "ABORT_ERR" ? "ETIMEDOUT"
          : codes.includes(error.code) ? error.code : "unavailable";
      }
      process.stdout.write(JSON.stringify(evidence), () => process.exit(error ? 1 : 0));
    };
    const deadline = setTimeout(() => finish({ code: "ETIMEDOUT" }), 8000);
    try {
      let dnsDeadline;
      try {
        evidence.addresses = (await Promise.race([
          lookup(evidence.hostname, { all: true }),
          new Promise((_, reject) => { dnsDeadline = setTimeout(() => reject({ code: "ETIMEDOUT" }), 3000); }),
        ])).map(({ address }) => address);
      } finally { clearTimeout(dnsDeadline); }
      await new Promise((resolve, reject) => {
        const req = request({
          protocol: "https:", hostname: evidence.hostname, port: 443,
          method: "GET", path: "/", agent: false, rejectUnauthorized: true,
          maxHeaderSize: 32768, signal: AbortSignal.timeout(5000),
          headers: { accept: "application/vnd.github+json", "user-agent": "openclaw-enterprise-repository-credentials", "x-github-api-version": "2026-03-10", "accept-encoding": "identity", connection: "close" },
        });
        req.once("error", reject);
        req.once("socket", (socket) => socket.once("secureConnect", () => {
          evidence.address = socket.remoteAddress;
          evidence.tlsVerified = socket.authorized === true;
          // Check the selected address without replacing production DNS selection.
          // No HTTP request is sent outside the approved ranges.
          if (isIP(evidence.address) !== 4 || !approved.check(evidence.address, "ipv4")) {
            req.destroy(Object.assign(new Error("unapproved endpoint"), { code: "ENDPOINT_NOT_APPROVED" }));
            return;
          }
          req.end();
        }));
        req.once("response", (response) => {
          evidence.httpStatus = response.statusCode;
          // Never consume or record provider headers or response contents.
          response.destroy();
          resolve();
        });
      });
      clearTimeout(deadline);
      finish();
    } catch (error) { clearTimeout(deadline); finish(error); }
  `;
  const kubernetes = f.controlPlane === "kubernetes";
  const args = kubernetes
    ? [
        "--kubeconfig",
        join(f.stateDirectory, "kubeconfig"),
        "--context",
        `k3d-${f.cluster}`,
        "--namespace",
        f.state.platformNamespace,
        "--request-timeout=10s",
        "exec",
        "deployment/openclaw-enterprise-worker",
        "--container",
        "worker",
        "--",
        "node",
        "--input-type=module",
        "-e",
        script,
      ]
    : [
        "compose",
        "-p",
        f.cluster,
        "-f",
        join(f.stateDirectory, "compose.yaml"),
        "exec",
        "-T",
        "worker-kubernetes",
        "node",
        "--input-type=module",
        "-e",
        script,
      ];
  let evidence: ProbeEvidence;
  let status: number | null | undefined;
  try {
    const output = await captureQaChild(kubernetes ? "kubectl" : "docker", args, {
      env: f.env,
      timeout: 15_000,
    });
    const captured = record(output, "worker probe output");
    assert.ok(captured.status === null || typeof captured.status === "number");
    status = captured.status;
    evidence = probeEvidence(parseJson(text(captured.stdout, "worker probe stdout")));
  } catch {
    // Never copy exec stderr or an unstructured process failure into the artifact.
    evidence = { hostname: "api.github.com", addresses: [], error: "worker-probe-unavailable" };
  }
  const contains = (address: string | undefined) =>
    address !== undefined && isIP(address) === 4 && approved.check(address, "ipv4");
  await f.record("repository-provider-worker-preflight", {
    scope: "worker",
    controlPlane: f.controlPlane,
    approvedEndpoints: cidrs.length,
    ...evidence,
    addresses: evidence.addresses.map((address) => ({ address, approved: contains(address) })),
    connectedAddressApproved: contains(evidence.address),
  });
  assert.ok(
    status === 0 &&
      evidence.tlsVerified === true &&
      contains(evidence.address) &&
      typeof evidence.httpStatus === "number" &&
      Number.isInteger(evidence.httpStatus) &&
      evidence.httpStatus >= 100 &&
      evidence.httpStatus <= 599,
    "repository worker GitHub API transport preflight failed; see repository-provider-worker-preflight (not a credential check)",
  );
}

export async function prepareQaRepository(f: QaInputFixture | QaPrepareFixture): Promise<void> {
  const input = f.repositoryInput;
  assert.ok(input, "OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY is required");
  const registry = await readQaRepositoryRegistry(input);
  const entry = selectPreparedQaRepository(registry, f.suffix);
  f.repositoryEntry = entry;
  const upstreamPolicy = await readQaRepositoryUpstreamPolicy(input);
  assert.ok("controlPlane" in f, "valid repository inputs require a prepared QA Installation");
  // Record the runner's DNS view, not cluster reachability. Only these two fixed
  // provider hostnames are queried; this does not change the approved egress policy.
  try {
    const { cidrs, approved } = upstreamPolicy;
    const hosts = await Promise.all(
      ["api.github.com", "github.com"].map(async (hostname) => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const addresses = await Promise.race([
            lookup(hostname, { family: 4, all: true }),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(
                () =>
                  reject(
                    Object.assign(new Error("DNS diagnostic timed out"), { code: "ETIMEOUT" }),
                  ),
                3000,
              );
            }),
          ]);
          return {
            hostname,
            addresses: addresses.map(({ address }) => ({
              address,
              approved: approved.check(address, "ipv4"),
            })),
          };
        } catch (error) {
          const errorCode = isRecord(error) ? error.code : undefined;
          const code =
            typeof errorCode === "string" &&
            ["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ETIMEOUT"].includes(errorCode)
              ? errorCode
              : "unavailable";
          return { hostname, error: code };
        } finally {
          clearTimeout(deadline);
        }
      }),
    );
    await f.record("repository-provider-dns", {
      scope: "runner",
      approvedEndpoints: cidrs.length,
      hosts,
    });
  } catch {
    // Optional diagnostics cannot prevent repository setup or replace its failure.
  }
  if (f.controlPlane === "kubernetes") {
    await probeQaRepositoryWorker(f, upstreamPolicy);
    return;
  }
  entry.namespaces = [{ ...entry.namespaces[0], namespaceId: f.namespace.id }];
  const directory = join(f.directory, "repository");
  for (const child of ["registry", "inputs", "ca", "control/private", "prepared"]) {
    await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  }
  const write = async (name: string, value: object | string) =>
    writeFile(join(directory, name), typeof value === "string" ? value : JSON.stringify(value), {
      mode: 0o600,
    });
  await write("registry/registry.json", registry);
  // Only the worker holds the App key and the custody key that seals the tokens it prepares.
  await write(
    "prepared/private-key.pem",
    await protectedText(join(input, "private-key.pem"), "repository App key"),
  );
  await writeFile(join(directory, "prepared/custody.key"), randomBytes(32), { mode: 0o600 });
  const host = "git.oce-system.svc.cluster.local";
  await f.run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "inputs/tls.key"),
    "-out",
    join(directory, "ca/ca.crt"),
    "-days",
    "2",
    "-subj",
    `/CN=${host}`,
    "-addext",
    `subjectAltName=DNS:${host}`,
  ]);
  // OpenSSL follows the caller's umask; protected inputs must never be group-writable.
  await Promise.all([
    chmod(join(directory, "ca/ca.crt"), 0o600),
    chmod(join(directory, "inputs/tls.key"), 0o600),
  ]);
  await write("inputs/config.json", qaRepositoryServiceConfig(registry, host));
  const path = join(f.stateDirectory, "compose.yaml");
  const compose = yamlMapping(loadYaml(await readFile(path, "utf8")));
  const services = yamlMapping(compose, "services");
  const mount = (source: string, target: string, readOnly = true) => ({
    type: "volume",
    source: `qa-repository-${source}`,
    target,
    read_only: readOnly,
    volume: { nocopy: true },
  });
  const image = process.env.OCC_TEST_QA_REPOSITORY_IMAGE ?? `oce-qa-repository:${f.suffix}`;
  if (!process.env.OCC_TEST_QA_REPOSITORY_IMAGE) {
    await f.run(
      "docker",
      [
        "build",
        "-f",
        "deploy/runtime/Dockerfile",
        "--target",
        "repository-credentials-service",
        "-t",
        image,
        ".",
      ],
      { timeout: 1_200_000 },
    );
  }
  // New named volumes keep private inputs owned by the actual non-root readers.
  // The trusted control-plane image initializes them without host bind mounts.
  let reader: number[] | undefined;
  for (const readerImage of new Set([image, f.controllerDockerImage])) {
    const identity = array(
      parseJson(
        await f.run("docker", [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--entrypoint",
          "node",
          readerImage,
          "-p",
          "JSON.stringify([process.getuid(),process.getgid()])",
        ]),
      ),
      "repository reader identity",
    );
    assert.equal(identity.length, 2);
    assert.ok(
      identity.every(
        (id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0,
      ),
    );
    if (reader) {
      assert.deepEqual(
        identity,
        reader,
        "repository broker and control-plane readers must share an owner",
      );
    }
    reader = identity;
  }
  const volumeFiles = {
    registry: ["registry.json"],
    inputs: ["config.json", "tls.key"],
    ca: ["ca.crt"],
    control: [],
    prepared: ["private-key.pem", "custody.key"],
  };
  const volumes = Object.fromEntries(
    Object.keys(volumeFiles).map((name) => [name, `${f.cluster}-repository-${name}`]),
  );
  const created: string[] = [];
  // Called only after a confirmed successful dev-down. A retained Installation
  // keeps its private volumes for the existing credential recovery obligations.
  f.cleanupRepositoryInputs = async () => {
    for (const name of created) {
      const [rawVolume] = array(
        parseJson(await f.run("docker", ["volume", "inspect", name])),
        "Docker volume inspection",
      );
      const volume = record(rawVolume, "Docker volume");
      const labels =
        volume.Labels == null ? undefined : record(volume.Labels, "Docker volume labels");
      assert.equal(labels?.["openclaw.dev/qa-repository"], f.suffix);
      await f.run("docker", ["volume", "rm", name]);
    }
  };
  const composeVolumes = yamlMapping((compose.volumes ??= {}));
  for (const [name, volume] of Object.entries(volumes)) {
    assert.equal(
      (
        await f.run("docker", [
          "volume",
          "ls",
          "--filter",
          `name=^${volume}$`,
          "--format",
          "{{.Name}}",
        ])
      ).trim(),
      "",
      "repository input volume must be new",
    );
    await f.run("docker", [
      "volume",
      "create",
      "--label",
      `openclaw.dev/qa-repository=${f.suffix}`,
      volume,
    ]);
    const [rawResult] = array(
      parseJson(await f.run("docker", ["volume", "inspect", volume])),
      "Docker volume inspection",
    );
    const result = record(rawResult, "Docker volume");
    const resultLabels =
      result.Labels == null ? undefined : record(result.Labels, "Docker volume labels");
    assert.equal(resultLabels?.["openclaw.dev/qa-repository"], f.suffix);
    created.push(volume);
    composeVolumes[`qa-repository-${name}`] = { external: true, name: volume };
  }
  const files: Record<string, Record<string, string>> = {};
  for (const [name, names] of Object.entries(volumeFiles)) {
    files[name] = Object.fromEntries(
      await Promise.all(
        names.map(async (file) => [
          file,
          (await readFile(join(directory, name, file))).toString("base64"),
        ]),
      ),
    );
  }
  await f.run(
    "docker",
    [
      "run",
      "--rm",
      "--interactive",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--security-opt",
      "no-new-privileges:true",
      ...Object.entries(volumes).flatMap(([name, volume]) => [
        "--mount",
        `type=volume,source=${volume},target=/owned/${name},volume-nocopy`,
      ]),
      "--entrypoint",
      "node",
      f.controllerDockerImage,
      "-e",
      `const fs = require("node:fs");
       const [uid, gid] = process.argv.slice(1).map(Number);
       const inputs = JSON.parse(fs.readFileSync(0, "utf8"));
       for (const [kind, files] of Object.entries(inputs)) {
         const root = "/owned/" + kind;
         fs.chmodSync(root, 0o700);
         for (const [name, body] of Object.entries(files)) {
           const path = root + "/" + name;
           fs.writeFileSync(path, Buffer.from(body, "base64"), { mode: 0o600, flag: "wx" });
           fs.chownSync(path, uid, gid);
         }
         if (kind === "control") {
           fs.mkdirSync(root + "/private", { mode: 0o700 });
           fs.chownSync(root + "/private", uid, gid);
         }
         fs.chownSync(root, uid, gid);
       }`,
      ...reader!.map(String),
    ],
    { input: JSON.stringify(files), privateFailureOutput: true, timeout: 30_000 },
  );
  const inputOwnership = parseJson(
    await f.run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        reader!.join(":"),
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        ...Object.entries(volumes).flatMap(([name, volume]) => [
          "--mount",
          `type=volume,source=${volume},target=/owned/${name},readonly,volume-nocopy`,
        ]),
        "--entrypoint",
        "node",
        f.controllerDockerImage,
        "-e",
        `const fs = require("node:fs");
         const assert = require("node:assert/strict");
         const inputs = JSON.parse(process.argv[1]);
         const modes = {};
         for (const [kind, files] of Object.entries(inputs)) {
           const root = "/owned/" + kind;
           const entries = [["", 0o700], ...files.map(name => [name, 0o600])];
           if (kind === "control") {
             entries.push(["private", 0o700]);
           }
           for (const [name, mode] of entries) {
             const relative = name ? "/" + name : "";
             const path = root + relative;
             const stat = fs.lstatSync(path);
             assert.equal(stat.uid, process.getuid());
             assert.equal(stat.gid, process.getgid());
             assert.equal(stat.mode & 0o777, mode);
             if (mode === 0o600) {
               assert.ok(stat.isFile());
               assert.ok(fs.readFileSync(path).length > 0);
             } else {
               assert.ok(stat.isDirectory());
             }
             modes[kind + relative] = { uid: stat.uid, gid: stat.gid, mode };
           }
         }
         process.stdout.write(JSON.stringify(modes));`,
        JSON.stringify(volumeFiles),
      ],
      { timeout: 30_000, privateFailureOutput: true },
    ),
  );
  await f.record("repository-file-ownership", {
    storage: "run-owned Docker volumes",
    paths: inputOwnership,
  });
  services["repository-credentials"] = {
    image,
    entrypoint: ["node", "/app/dist/repository-credentials.js"],
    command: ["--config", "/etc/openclaw/repository-inputs/config.json"],
    networks: { development: {} },
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    volumes: [
      mount("registry", "/etc/openclaw/repository-registry"),
      mount("inputs", "/etc/openclaw/repository-inputs"),
      mount("ca", "/etc/openclaw/repository-ca"),
      mount("control", "/run/openclaw/repository-control", false),
    ],
  };
  for (const name of ["controller", "worker-kubernetes"]) {
    const serviceVolumes = yamlMapping(services, name).volumes;
    assert.ok(Array.isArray(serviceVolumes), `expected volumes for ${name}`);
    serviceVolumes.push(
      mount("registry", "/etc/openclaw/repository-registry"),
      mount("ca", "/etc/openclaw/repository-ca"),
    );
    if (name === "worker-kubernetes") {
      serviceVolumes.push(
        mount("control", "/run/openclaw/repository-control", false),
        mount("prepared", PREPARED_REPOSITORY_DIRECTORY),
      );
    }
  }
  await writeFile(path, dumpYaml(compose), { mode: 0o600 });
  await f.compose("up", "-d", "--no-deps", "repository-credentials");
  const broker = (await f.compose("ps", "-a", "-q", "repository-credentials")).trim();
  assert.ok(broker, "Compose must create the real repository broker");
  await waitFor("Compose broker control socket ready", async () => {
    const [rawContainer] = array(
      parseJson(await f.run("docker", ["inspect", broker])),
      "Docker container inspection",
    );
    const container = record(rawContainer, "Docker container");
    const state = record(container.State, "Docker container state");
    if (!state.Running) {
      try {
        let logs: string | string[] = "unavailable";
        try {
          const output = await captureQaChild("docker", ["logs", "--tail", "80", broker], {
            env: f.env,
            timeout: 15_000,
          });
          const captured = record(output, "broker log output");
          logs = redactedQaTail(
            `${text(captured.stdout, "broker stdout")}\n${text(captured.stderr, "broker stderr")}`,
            qaLogEnv(f),
            {
              lines: 40,
              lineChars: 512,
            },
          );
        } catch {
          // Preserve the startup failure when Docker cannot return its logs.
        }
        await f.record("repository-broker-startup-failure", {
          imageUser: record(container.Config, "Docker container config").User,
          runnerUid: process.getuid?.(),
          exitCode: state.ExitCode,
          storage: "run-owned Docker volumes",
          initialOwnership: inputOwnership,
          logs,
        });
      } catch {
        // Preserve the original startup failure if evidence cannot be recorded.
      }
    }
    assert.ok(state.Running, "the real repository broker exited during startup");
    // The broker owns this private directory; check readiness as that reader,
    // rather than granting the host access through its 0700 parent.
    return (
      (
        await f.run("docker", [
          "exec",
          broker,
          "node",
          "-e",
          "const fs=require('fs');try{console.log(fs.statSync(process.argv[1]).isSocket())}catch(error){if(error.code!=='ENOENT')throw error;console.log(false)}",
          REPOSITORY_CONTROL_SOCKET,
        ])
      ).trim() === "true"
    );
  });
  const [rawBroker] = array(
    parseJson(await f.run("docker", ["inspect", broker])),
    "Docker broker inspection",
  );
  const brokerInfo = record(rawBroker, "Docker broker");
  const networks = record(
    record(brokerInfo.NetworkSettings, "Docker network settings").Networks,
    "Docker networks",
  );
  const ip = text(
    record(networks[`${f.cluster}_development`], "Docker development network").IPAddress,
    "Docker broker IP",
  );
  const labels = {
    "app.kubernetes.io/name": "qa-repository-relay",
    "app.kubernetes.io/component": "worker",
    "openclaw.dev/qa-repository": f.suffix,
  };
  const compute = f.configuration.drivers.compute.configuration;
  // A TCP relay preserves broker TLS and authentication. It does not implement
  // credentials, Git, or authorization; the shipped broker handles every call.
  await f.apply({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "qa-repository-relay", namespace: "oce-system" },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "relay",
              image: compute.images.agent,
              imagePullPolicy: "Never",
              command: [
                "node",
                "-e",
                `const net=require('net');net.createServer(c=>{const u=net.connect(8443,'${ip}');c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(8443,'0.0.0.0')`,
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              ports: [{ name: "https", containerPort: 8443 }],
              readinessProbe: { tcpSocket: { port: "https" }, periodSeconds: 2 },
            },
          ],
        },
      },
    },
  });
  await f.apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: "git",
      namespace: "oce-system",
      annotations: { "openclaw.dev/repository-credentials-hostname": host },
    },
    spec: {
      type: "ClusterIP",
      selector: labels,
      ports: [{ name: "https", port: 443, targetPort: 8443, protocol: "TCP" }],
    },
  });
  await f.apply({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "openclaw-enterprise-prepared-repository-ingress", namespace: "oce-system" },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress"],
      // Match the shipped prepared-repository-ingress manifest: only Compute
      // admits and later removes the exact dedicated Harness peers.
      ingress: [],
    },
  });
  await f.apply({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "qa-repository-relay-egress", namespace: "oce-system" },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Egress"],
      egress: [
        { to: [{ ipBlock: { cidr: `${ip}/32` } }], ports: [{ protocol: "TCP", port: 8443 }] },
      ],
    },
  });
  await f.kubectl(
    "-n",
    "oce-system",
    "rollout",
    "status",
    "deployment/qa-repository-relay",
    "--timeout=120s",
  );
  applyQaRepositoryInstallation(f.configuration, registry, labels);
  await f.saveInstallation(f.configuration);
  await probeQaRepositoryWorker(f, upstreamPolicy);
}

// The serial worker waits for the Gateway's whole active-work drain, bounded by
// GATEWAY_STOP_TIMEOUT_MS plus one Kubernetes request, before it deletes the
// Harness and clears activeRevisionId (finding 1088). Allow that bound plus three
// minutes for the Harness to terminate and the API to observe it, as
// first-agent-smoke does. This is a QA allowance, not a product bound. While
// ordinary stops hold the serial worker, a stop queued behind another Agent's
// full drain (OCC_TEST_QA_CONCURRENCY > 1) can still exceed it; the slow-stop
// evidence below then names the drain.
export const QA_STOP_TIMEOUT_MS = GATEWAY_STOP_TIMEOUT_MS + 10_000 + 3 * 60_000;
// A stop slower than this passes, but leaves evidence. One still running past it
// captures the platform logs once, while the Gateway is still draining: its drain
// lines name the work it waits for (finding 1076).
export const QA_SLOW_STOP_MS = 60_000;

// `now` is the clock for both the slow-stop threshold and the timeout; tests pass a
// fake one with `interval: 0`, so neither bound costs real time.
export async function stopQaAgent(
  f: QaStopFixture,
  agent: QaStopAgent,
  {
    timeout = QA_STOP_TIMEOUT_MS,
    slowAfter = QA_SLOW_STOP_MS,
    now = Date.now,
    interval,
  }: StopTiming = {},
): Promise<void> {
  // Evidence files are created exclusively: a repeated stop of one Agent gets its own names.
  agent.stopCalls = (agent.stopCalls ?? 0) + 1;
  const label = agent.stopCalls === 1 ? agent.id : `${agent.id}-${agent.stopCalls}`;
  const startedAt = now();
  await f.api("POST", `/namespaces/${agent.namespaceId}/agents/${agent.id}/stop`);
  let last: StopObservation | undefined;
  let slow: SlowStop | undefined;
  try {
    await waitFor(
      "ordinary Agent stop removes every runtime Pod",
      async () => {
        const current = stopCurrent(
          await f.api("GET", `/namespaces/${agent.namespaceId}/agents/${agent.id}`),
        );
        const pods = podsFromJson(
          await f.kubectl(
            "get",
            "pods",
            "-A",
            "-l",
            `openclaw.dev/agent=${agent.id}`,
            "-o",
            "json",
          ),
        );
        last = { current, pods };
        const done =
          current.desiredRuntimeState === "stopped" &&
          !current.activeRevisionId &&
          pods.length === 0;
        if (!done && !slow && now() - startedAt > slowAfter) {
          slow = await captureSlowStop(f, label, last, now() - startedAt, slowAfter);
        }
        return done;
      },
      timeout,
      {
        describe: () => describeStopObservation(last),
        ...(interval === undefined ? {} : { interval }),
        now,
      },
    );
  } catch (error) {
    if (last && error instanceof Error && /^Timed out: /.test(error.message)) {
      try {
        const file = await recordPlatformLogs(f, `${label}-stop-timeout`, last.pods);
        if (file) {
          error.message += `; API and worker logs: ${file}`;
        }
      } catch (logError) {
        error.message += `; API and worker logs unavailable (${errorMessage(logError)})`;
      }
      if (slow?.platformLogs) {
        error.message += `; drain evidence after ${Math.round(slow.observedAfterMs / 1000)} s: ${slow.platformLogs}`;
      }
    }
    throw error;
  }
  const elapsedMs = now() - startedAt;
  if (slow || elapsedMs > slowAfter) {
    try {
      await f.record(`${label}-slow-stop`, { thresholdMs: slowAfter, ...slow, elapsedMs });
    } catch {
      // Diagnostic only: a stop that completed must not fail on its evidence.
    }
    process.stderr.write(
      `QA slow stop (diagnostic, not a failure): Agent ${agent.id} took ${Math.round(elapsedMs / 1000)} s` +
        `${slow?.platformLogs ? `; drain evidence: ${slow.platformLogs}` : ""}\n`,
    );
  }
  agent.stopped = true;
}

async function captureSlowStop(
  f: QaStopFixture,
  label: string,
  observation: StopObservation,
  elapsedMs: number,
  thresholdMs: number,
): Promise<SlowStop> {
  const slow: SlowStop = {
    thresholdMs,
    observedAfterMs: elapsedMs,
    observation: stopSummary(observation),
  };
  try {
    const file = await recordPlatformLogs(f, `${label}-slow-stop`, observation.pods);
    if (file !== undefined) {
      slow.platformLogs = file;
    }
  } catch (error) {
    slow.platformLogsUnavailable = redactedQaTail(errorMessage(error), qaLogEnv(f), {
      lines: 4,
      lineChars: 400,
    });
  }
  return slow;
}

// Only identifiers and lifecycle fields: no specs, environments or Secret data.
function stopSummary({ current, pods }: StopObservation): StopSummary {
  const remaining = pods.slice(0, 10).map(({ metadata = {}, status = {} }) => ({
    ...(metadata.namespace === undefined ? {} : { namespace: metadata.namespace }),
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(status.phase === undefined ? {} : { phase: status.phase }),
    deletionTimestamp: metadata.deletionTimestamp ?? null,
    finalizers: metadata.finalizers ?? [],
  }));
  return {
    ...(current.desiredRuntimeState === undefined
      ? {}
      : { desiredRuntimeState: current.desiredRuntimeState }),
    activeRevisionId: current.activeRevisionId ?? null,
    pods: remaining,
    ...(pods.length > remaining.length ? { omittedPods: pods.length - remaining.length } : {}),
  };
}

export function describeStopObservation(observation: StopObservation | undefined): string {
  return observation ? JSON.stringify(stopSummary(observation)) : "none";
}

const platformLogLines = 600;
const platformLogLineChars = 2_000;
// Fixed launcher settings, not secrets: the generated cluster and project name,
// its state directory (under the runner's temp directory), the k3s image the
// workflows pin and the driver names appear on many lines, and replacing them (or
// "kubernetes") would garble the logs. The controller, runtime and repository
// image overrides and anything secret-bearing stay private.
const publicLauncherSettings = new Set([
  "OCC_DEVELOPMENT_COMPOSE_PROJECT",
  "OCC_DEVELOPMENT_COMPUTE_DRIVER",
  "OCC_DEVELOPMENT_CONTAINER_ENGINE",
  "OCC_DEVELOPMENT_CONTROL_PLANE",
  "OCC_DEVELOPMENT_K3S_IMAGE",
  "OCC_DEVELOPMENT_KUBERNETES_CLUSTER",
  "OCC_DEVELOPMENT_SANDBOX_DRIVER",
  "OCC_DEVELOPMENT_STATE_DIRECTORY",
]);

// The Gateway drains in-flight work for up to 315 s on SIGTERM and logs what it
// waits for. Keep only its own drain and shutdown messages.
const gatewayDrainLine =
  /draining active work|active-work drain|all active work drained|shutdown budget|shutdown drain|received SIG(TERM|INT)/i;
const gatewayDrainLines = 40;
// Extra worker reads (rollout Pods, previous containers) keep a shorter tail.
const extraWorkerLogLines = 200;
const platformEvents = 60;

// Lifecycle fields only: which Pods ran, when they started and why they restarted.
function podRestarts({ metadata = {}, status = {} }: QaPod) {
  return {
    name: metadata.name,
    component: metadata.labels?.["app.kubernetes.io/component"],
    phase: status.phase,
    startTime: status.startTime ?? null,
    deletionTimestamp: metadata.deletionTimestamp ?? null,
    containers: (status.containerStatuses ?? []).map(({ name, restartCount, lastState }) => ({
      name,
      restartCount,
      lastTerminated: lastState?.terminated
        ? {
            reason: lastState.terminated.reason,
            exitCode: lastState.terminated.exitCode,
            finishedAt: lastState.terminated.finishedAt,
          }
        : null,
    })),
  };
}

function qaLogEnv(f: Pick<QaStopFixture, "env">): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(f.env ?? {}).filter(([name]) => !publicLauncherSettings.has(name)),
  );
}

// The QA evidence artifact is uploaded on every run, and only its *.json files;
// keep the API and worker log tails there, redacted, for the kubernetes control
// plane (Compose runs them as containers outside the cluster), plus each worker
// Pod during a rollout, a restarted worker's previous log, platform Pod restarts, recent
// Events in the platform and remaining Agent Namespaces, and the drain lines of each
// remaining Gateway Pod. Returns the file name.
async function recordPlatformLogs(
  f: QaStopFixture,
  label: string,
  remainingPods: QaPod[] = [],
): Promise<string | undefined> {
  if (f.controlPlane !== "kubernetes") {
    return;
  }
  const env = qaLogEnv(f);
  const tail = (text: string, lines = platformLogLines, lineChars = platformLogLineChars) =>
    redactedQaTail(text, env, { lines, lineChars });
  const attempt = async <T>(read: () => Promise<T>): Promise<T | LogFailure> => {
    try {
      return await read();
    } catch (error) {
      return { unavailable: tail(errorMessage(error), 12, 800) };
    }
  };
  const platformNamespace = f.state.platformNamespace;
  const containerTail = async (target: string, container: string, ...options: string[]) => {
    const lines = target.startsWith("deployment/") ? platformLogLines : extraWorkerLogLines;
    return tail(
      await f.kubectl(
        "-n",
        platformNamespace,
        "logs",
        target,
        "--container",
        container,
        ...options,
        "--timestamps",
        `--tail=${lines}`,
        "--request-timeout=30s",
      ),
      lines,
    );
  };
  const api = await attempt(() => containerTail("deployment/openclaw-enterprise-api", "api"));
  const worker = await attempt(() =>
    containerTail("deployment/openclaw-enterprise-worker", "worker"),
  );
  const platformPods = await attempt(async () =>
    podsFromJson(
      await f.kubectl(
        "-n",
        platformNamespace,
        "get",
        "pods",
        "-o",
        "json",
        "--request-timeout=30s",
      ),
    ).map(podRestarts),
  );
  const logs: PlatformLogs = { api, worker, platformPods, events: {} };
  // `logs deployment/...` reads one Pod and never its previous container: during
  // a rollout read every worker Pod by name, and a restarted one's previous log.
  const workerPods = Array.isArray(platformPods)
    ? platformPods.filter(({ component }) => component === "worker")
    : [];
  for (const pod of workerPods) {
    const { name } = pod;
    if (!name) {
      continue;
    }
    if (workerPods.length > 1) {
      (logs.workerPods ??= {})[name] = await attempt(() => containerTail(name, "worker"));
    }
    if ((pod.containers.find(({ name }) => name === "worker")?.restartCount ?? 0) > 0) {
      (logs.workerPrevious ??= {})[name] = await attempt(() =>
        containerTail(name, "worker", "--previous"),
      );
    }
  }
  const eventNamespaces = [
    platformNamespace,
    ...new Set(
      remainingPods
        .map(({ metadata }) => metadata?.namespace)
        .filter((namespace): namespace is string => !!namespace && namespace !== platformNamespace),
    ),
  ];
  for (const namespace of eventNamespaces) {
    logs.events[namespace] = await attempt(async () =>
      array(
        record(
          parseJson(
            await f.kubectl(
              "-n",
              namespace,
              "get",
              "events",
              "-o",
              "json",
              "--request-timeout=30s",
            ),
          ),
          "Kubernetes event list",
        ).items,
        "Kubernetes events",
      )
        .map((rawEvent): PlatformEvent => {
          const event = record(rawEvent, "Kubernetes event");
          const metadata =
            event.metadata == null ? undefined : record(event.metadata, "event metadata");
          const involved =
            event.involvedObject == null
              ? undefined
              : record(event.involvedObject, "event involved object");
          const time =
            event.lastTimestamp ?? event.eventTime ?? metadata?.creationTimestamp ?? null;
          assert.ok(time === null || typeof time === "string");
          assert.ok(event.type === undefined || typeof event.type === "string");
          assert.ok(event.reason === undefined || typeof event.reason === "string");
          assert.ok(event.count == null || typeof event.count === "number");
          return {
            time,
            ...(typeof event.type === "string" ? { type: event.type } : {}),
            ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
            object: `${involved?.kind}/${involved?.name}`,
            count: typeof event.count === "number" ? event.count : 1,
            message:
              tail(event.message == null ? "" : text(event.message, "event message"), 1, 400)[0] ??
              "",
          };
        })
        .sort((left, right) => String(left.time ?? "").localeCompare(String(right.time ?? "")))
        .slice(-platformEvents),
    );
  }
  for (const { metadata = {} } of remainingPods) {
    if (
      metadata.labels?.["openclaw.dev/workload-role"] !== "gateway" ||
      !metadata.name ||
      !metadata.namespace
    ) {
      continue;
    }
    const { name, namespace } = metadata;
    (logs.gatewayDrain ??= {})[name] = await attempt(async () => {
      const text = await f.kubectl(
        "-n",
        namespace,
        "logs",
        name,
        "--container",
        "gateway",
        "--timestamps",
        `--tail=${platformLogLines * 4}`,
        "--request-timeout=30s",
      );
      const kept = text.split("\n").filter((line) => gatewayDrainLine.test(line));
      return kept.length === 0 ? [] : tail(kept.join("\n"), gatewayDrainLines, 800);
    });
  }
  return f.record(`${label}-platform-logs`, { capturedAt: new Date().toISOString(), logs });
}

// "git-write" pushes one commit to the run's granted branch. "git-push-denied" pushes
// to another branch, which the grant does not cover. Both bind git-write: prepared
// native Git serves no other profile.
export async function verifyQaRepository(
  f: QaVerifyFixture,
  agent: QaAgent,
  scenario = "git-write",
): Promise<void> {
  assert.ok(["git-write", "git-push-denied"].includes(scenario));
  assert.equal(typeof f.get, "function", "repository verification requires Pod lookup");
  const denied = scenario === "git-push-denied";
  assert.ok(!f.retained, "unresolved repository cleanup prevents opening another session");
  assert.equal(
    process.env.OCC_TEST_QA_REPOSITORY_AUTHORIZED,
    "1",
    "explicit disposable remote-write authorization is required",
  );
  const entry = f.repositoryEntry;
  const repository = entry.repository;
  const repositoryId = record(entry, "repository registration").repositoryId;
  assert.ok(
    typeof repositoryId === "string" || typeof repositoryId === "number",
    "invalid repository ID",
  );
  const observerTokenPath = process.env.OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE;
  const observerAppInput = process.env.OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY;
  const observerBinary = process.env.OCC_TEST_QA_GITHUB_OBSERVER_BINARY;
  if (process.env.QA_REPOSITORY_FIXTURE === "isolated") {
    assert.ok(observerAppInput, "isolated repository fixture requires App-backed observer input");
    assert.ok(
      !observerTokenPath,
      "isolated repository fixture must not use a static observer token",
    );
    assert.ok(!observerBinary, "isolated repository fixture must not use a managed gh wrapper");
  }
  const observerToken = observerTokenPath
    ? await protectedText(observerTokenPath, "independent GitHub observer credential")
    : undefined;
  const selectedObservers = [observerToken, observerAppInput, observerBinary].filter(Boolean);
  assert.equal(
    selectedObservers.length,
    1,
    "select exactly one independent observer credential, App input directory, or managed gh wrapper",
  );
  // A selected managed wrapper may authenticate from its caller's environment.
  // Forward credentials only to the host observer/Git calls, never the launcher
  // environment used for containers, Kubernetes, or model turns.
  const observerEnvironment = observerToken
    ? { GH_TOKEN: observerToken }
    : Object.fromEntries(
        observerAppInput
          ? []
          : ["GH_TOKEN", "GITHUB_TOKEN"]
              .filter((name) => process.env[name])
              .map((name) => [name, process.env[name]]),
      );
  for (const value of Object.values(observerEnvironment)) {
    if (value !== undefined) {
      registerQaSecret(value);
    }
  }
  const runObserverCommand = (cmd: string, args: string[], options?: QaCommandOptions) =>
    f.run(cmd, args, {
      ...options,
      env: { ...f.env, ...options?.env, ...observerEnvironment },
    });
  const observe = observerAppInput
    ? await createGitHubAppRepositoryObserver({
        repository,
        inputDirectory: observerAppInput,
        run: runObserverCommand,
      })
    : createRepositoryObserver({
        repository,
        binary: observerBinary ?? "gh",
        run: runObserverCommand,
      });
  const { data: rawRemote } = await observe("GET");
  const remote = repositoryRemote(rawRemote);
  assert.equal(String(remote.id), String(repositoryId));
  assert.equal(remote.full_name.toLowerCase(), repository.toLowerCase());
  const base = remote.default_branch;
  const { data: baseline } = await observe("GET", `git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = text(
    record(record(baseline, "GitHub baseline ref").object, "GitHub ref object").sha,
    "GitHub base SHA",
  );
  assert.match(baseSha, /^[a-f0-9]{40}$/);
  const suffix = `${f.suffix}-${agent.preset.toLowerCase()}-${scenario}`;
  const branch = denied ? `${qaRepositoryBranch(f.suffix)}-denied` : qaRepositoryBranch(f.suffix);
  const file = `qa-${suffix}.txt`;
  const content = `QA repository proof ${suffix}\n`;
  const marker = `<!-- oce-qa:${suffix} -->`;
  await observe("GET", `git/ref/heads/${branch}`, undefined, 404);
  const path = `/namespaces/${agent.namespaceId}/agents/${agent.id}`;
  const dedicated = agent.preset === "Codex";
  const currentConfiguration = await f.api(
    "GET",
    `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`,
  );
  const values = configurationValues(record(currentConfiguration, "configuration response").values);
  values.agents.defaults.workspace = dedicated
    ? "/home/node/workspace"
    : "/home/node/.openclaw/workspace";
  values.agents.defaults.sandbox = { mode: "off" };
  if (dedicated) {
    Object.assign(codexAppServer(values), {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      remoteWorkspaceRoot: "/home/node/workspace",
    });
  }
  values.tools = {
    ...values.tools,
    allow: dedicated ? ["*"] : ["exec", "process"],
    ...(dedicated ? { fs: { ...values.tools?.fs, workspaceOnly: true } } : {}),
    exec: {
      ...values.tools?.exec,
      mode: "full",
      ...(dedicated ? {} : { host: "gateway" }),
    },
  };
  const savedConfiguration = await f.api(
    "PATCH",
    `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`,
    { values },
  );
  if (dedicated) {
    const saved = optionalRecord(optionalRecord(savedConfiguration)?.values);
    const defaults = optionalRecord(optionalRecord(saved?.agents)?.defaults);
    const appServer = optionalRecord(
      optionalRecord(
        optionalRecord(optionalRecord(optionalRecord(saved?.plugins)?.entries)?.codex)?.config,
      )?.appServer,
    );
    const savedTools = optionalRecord(saved?.tools);
    try {
      await f.record(`${suffix}-saved-native-policy`, {
        evidenceKind: "diagnostic-only",
        source: "saved-configuration-response-not-effective-turn",
        configurationResponseKnown: saved !== undefined,
        savedOpenClawSandboxOff: saved
          ? optionalRecord(defaults?.sandbox)?.mode === "off"
          : "unknown",
        savedAppServerWorkspaceWrite: saved ? appServer?.sandbox === "workspace-write" : "unknown",
        savedApprovalNever: saved ? appServer?.approvalPolicy === "never" : "unknown",
        savedWorkspaceMatchesExpected: saved
          ? appServer?.remoteWorkspaceRoot === "/home/node/workspace"
          : "unknown",
        savedExecFull: saved ? optionalRecord(savedTools?.exec)?.mode === "full" : "unknown",
        savedFsWorkspaceOnly: saved
          ? optionalRecord(savedTools?.fs)?.workspaceOnly === true
          : "unknown",
      });
    } catch {
      // Optional saved-policy evidence cannot replace the actual repository failure.
    }
  }
  await f.api("PATCH", path, {
    configurationId: agent.configuration.id,
    repositoryBindings: [{ repositoryRef: entry.repositoryRef, profile: "git-write" }],
  });
  let workFailure: unknown;
  let remoteEvidence: { commitSha?: string } | undefined;
  let attempt: CredentialAttempt | undefined;
  let readSession: ((id: string) => Promise<CredentialSession>) | undefined;
  try {
    // Deployment can open provider credentials even if its response is lost.
    // A rejected draft update above creates no session-cleanup obligation.
    f.pendingRepositories.add(agent.id);
    await f.deployAndWait(agent);
    const revision = record(agent.revision, "deployed Agent revision");
    assert.ok(typeof revision.id === "string" && revision.id.length > 0, "invalid revision ID");
    const readOnly = denied;
    const gateway = await f.pod(agent, "gateway");
    const consumer = dedicated ? await f.pod(agent, "agent") : gateway;
    for (const [role, pod] of [
      ["gateway", gateway],
      ["consumer", consumer],
    ] as const) {
      const metadata = record(pod.metadata, `${role} Pod metadata`);
      for (const field of ["namespace", "name", "uid"] as const) {
        assert.ok(
          typeof metadata[field] === "string" && metadata[field].length > 0,
          `invalid ${role} Pod ${field}`,
        );
      }
    }
    const consumerName = dedicated ? "agent" : "gateway";
    const execIn = (
      pod: QaRuntimePod,
      container: string,
      script: string,
      args: string[] = [],
      input?: string,
      timeout = 30_000,
    ) =>
      f.run(
        "kubectl",
        [
          "--kubeconfig",
          join(f.stateDirectory, "kubeconfig"),
          "--context",
          `k3d-${f.cluster}`,
          "-n",
          pod.metadata.namespace,
          "exec",
          "-i",
          pod.metadata.name,
          "-c",
          container,
          "--",
          "env",
          "-u",
          "OPENAI_API_KEY",
          "node",
          "-e",
          // The shared loader consumes its pieces; restore the caller's argv
          // inside the program and leave stdin available for the original input.
          ...nodeProgramArguments(`process.argv.push(...${JSON.stringify(args)});\n${script}`),
        ],
        { input, timeout },
      );
    type ExecArguments = [script: string, args?: string[], input?: string, timeout?: number];
    const exec = (...args: ExecArguments) => execIn(gateway, "gateway", ...args);
    const consumerExec = (...args: ExecArguments) => execIn(consumer, consumerName, ...args);
    const material = record(
      parseJson(
        await consumerExec(
          "const fs=require('fs'),p='/run/oce/repository-credentials/manifest.json',m=JSON.parse(fs.readFileSync(p)),s=fs.statSync(p);console.log(JSON.stringify({uid:s.uid,mode:s.mode&511,bindings:m.bindings.map(b=>({repositoryRef:b.repositoryRef,sessionId:b.sessionId}))}))",
        ),
      ),
      "repository material",
    );
    assert.equal(material.uid, 1000);
    assert.equal(material.mode, 0o600);
    const bindings = array(material.bindings, "repository material bindings");
    assert.equal(bindings.length, 1);
    const binding = record(bindings[0], "repository binding");
    assert.equal(binding.repositoryRef, entry.repositoryRef);
    attempt = {
      repositoryRef: text(binding.repositoryRef, "repository reference"),
      sessionId: text(binding.sessionId, "repository session ID"),
    };
    const workers =
      f.controlPlane === "kubernetes"
        ? podsFromJson(
            await f.kubectl(
              "-n",
              f.state.platformNamespace,
              "get",
              "pods",
              "-l",
              "app.kubernetes.io/component=worker",
              "-o",
              "json",
            ),
          )
        : [];
    const workerPod = workers.find(
      (p) =>
        !p.metadata?.deletionTimestamp &&
        p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
    );
    const executeWorker = (script: string, args: string[], timeout: number) =>
      f.controlPlane === "compose"
        ? f.run(
            "docker",
            [
              "compose",
              "-p",
              f.cluster,
              "-f",
              join(f.stateDirectory, "compose.yaml"),
              "exec",
              "-T",
              "worker-kubernetes",
              "node",
              "-e",
              script,
              ...args,
            ],
            { timeout },
          )
        : f.run(
            "kubectl",
            [
              "--kubeconfig",
              join(f.stateDirectory, "kubeconfig"),
              "--context",
              `k3d-${f.cluster}`,
              "-n",
              f.state.platformNamespace,
              "exec",
              text(workerPod?.metadata?.name, "ready worker Pod name"),
              "-c",
              "worker",
              "--",
              "node",
              "-e",
              script,
              ...args,
            ],
            { timeout },
          );
    readSession = async (id) => {
      const value: unknown = await readInstalledCredentialSession(executeWorker, id);
      const session = record(value, "credential session");
      const cleanup = record(session.cleanup, "credential session cleanup");
      assert.ok(typeof session.state === "string" && typeof session.activeUses === "number");
      assert.ok(
        typeof cleanup.active === "number" &&
          typeof cleanup.pending === "number" &&
          typeof cleanup.uncertain === "number" &&
          typeof cleanup.auxiliaryPending === "boolean",
      );
      return session as CredentialSession;
    };
    assert.equal((await readSession(attempt.sessionId)).state, "OPEN");
    for (const pod of [gateway, consumer]) {
      assert.ok(
        !pod.spec.containers.some((c) =>
          c.env?.some((e) =>
            ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(
              e.name,
            ),
          ),
        ),
        "no alternate provider credential in runtime",
      );
    }
    // Submit through the actual gateway's supported authenticated HTTP endpoint.
    // Execution and Git/gh remain entirely in the native Agent.
    const scenarioFixture = {
      ...f,
      suffix,
      gatewayHostname: undefined,
      record: (name: string, value: unknown) => f.record(`${suffix}-${name}`, value),
    };
    const evidence: unknown = await verifyNativeRepositoryJourney({
      f: scenarioFixture,
      dedicated,
      readOnly,
      workspace: dedicated ? "/home/node/workspace" : "/home/node/.openclaw/workspace",
      repository,
      base,
      baseSha,
      branch,
      file,
      content,
      marker,
      commandTool: dedicated ? "bash" : "exec",
      toolNames: dedicated ? ["bash"] : ["exec", "process"],
      gateway,
      consumer,
      agent,
      revision: agent.revision,
      attempt,
      exec,
      submitTask: exec,
      consumerExec,
      observe,
      app: { repositoryId: String(repositoryId) },
      remote,
      readSession,
      submitViaLoopback: true,
      pullRequest: false,
    });
    if (evidence !== undefined) {
      const result = record(evidence, "repository journey evidence");
      assert.ok(result.commitSha === undefined || typeof result.commitSha === "string");
      remoteEvidence = result.commitSha === undefined ? {} : { commitSha: result.commitSha };
    }
  } catch (error) {
    workFailure = error;
  }
  let cleanupFailure: unknown;
  try {
    await stopQaAgent(f, agent);
    if (attempt && readSession) {
      const session = await waitFor("broker session DISPOSED", async () => {
        const value = await readSession!(attempt!.sessionId);
        return value.state === "DISPOSED" && value;
      });
      assert.equal(session.activeUses, 0);
      for (const counter of ["active", "pending", "uncertain"] as const) {
        assert.equal(session.cleanup[counter], 0, `session cleanup ${counter}`);
      }
      assert.equal(session.cleanup.auxiliaryPending, false);
      const materials = array(
        record(
          parseJson(
            await f.kubectl(
              "get",
              "secrets",
              "-A",
              "-l",
              `openclaw.dev/agent=${agent.id},openclaw.dev/repository-material=session`,
              "-o",
              "json",
            ),
          ),
          "repository Secret list",
        ).items,
        "repository Secrets",
      );
      assert.equal(materials.length, 0);
      await f.record(`${suffix}-disposal`, session);
      f.pendingRepositories.delete(agent.id);
    }
    // Reconcile unknown task outcomes as well as successful remote writes.
    if (!f.pendingRepositories.has(agent.id)) {
      await cleanupRepositoryJourney({
        observe,
        repository,
        repositoryId,
        branch,
        base,
        baseSha,
        file,
        content,
        marker,
        readOnly: denied,
        commitMessage: `Installed credential proof ${suffix}`,
        expectedSha: remoteEvidence?.commitSha,
      });
    }
  } catch (error) {
    cleanupFailure = error;
    // Every git-write scenario of the run pushes the one granted branch. Keep a later
    // one from tripping over what this one could not clean up.
    if (!denied) {
      f.retained = true;
    }
  }
  if (f.pendingRepositories.has(agent.id)) {
    f.retained = true;
  }
  // Attempt Agent/session and remote branch cleanup first. One worker log read
  // then retains provider-stage evidence without delaying those obligations.
  if (workFailure) {
    try {
      const kubernetes = f.controlPlane === "kubernetes";
      const args = kubernetes
        ? [
            "--kubeconfig",
            join(f.stateDirectory, "kubeconfig"),
            "--context",
            `k3d-${f.cluster}`,
            "--namespace",
            f.state.platformNamespace,
            "--request-timeout=10s",
            "logs",
            "deployment/openclaw-enterprise-worker",
            "--container",
            "worker",
            "--tail=100",
          ]
        : [
            "compose",
            "-p",
            f.cluster,
            "-f",
            join(f.stateDirectory, "compose.yaml"),
            "logs",
            "--no-color",
            "--tail",
            "100",
            "worker-kubernetes",
          ];
      const output = await captureQaChild(kubernetes ? "kubectl" : "docker", args, {
        env: f.env,
        timeout: 15_000,
      });
      const captured = record(output, "repository failure log output");
      await f.record(`${agent.id}-repository-failure`, {
        logs: redactedQaTail(
          `${text(captured.stdout, "worker stdout")}\n${text(captured.stderr, "worker stderr")}`,
          qaLogEnv(f),
          {
            lines: 60,
            lineChars: 1200,
          },
        ),
      });
    } catch {
      // Diagnostics must not replace the repository failure or its cleanup obligations.
    }
  }
  if (workFailure && cleanupFailure) {
    throw new AggregateError(
      [workFailure, cleanupFailure],
      "repository journey and cleanup failed",
      { cause: workFailure },
    );
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
  if (workFailure) {
    throw workFailure;
  }
}
