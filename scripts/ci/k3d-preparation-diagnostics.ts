import { readFile, statfs, writeFile } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { asRecord } from "../../packages/utils/src/index.ts";
import { nodeLogExcerpt, redactCredentialLine } from "./k3d-node-log.ts";
import { preparationIdentity, readRuntimeProvenance } from "./runtime-provenance.ts";

export interface K3dDiagnosticCluster {
  name: string;
  owner: string;
  directory: string;
  kubeconfig: string;
  context: string;
  nodes: readonly string[];
  nodeImage?: string;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
}

type DiagnosticCommand = (
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputChars: number },
) => Promise<CommandOutput>;

type Observation<Value> =
  | { status: "ok"; value: Value }
  | { status: "timed-out"; value?: Value }
  | { status: "unavailable" };

interface DiagnosticOptions {
  execFile: DiagnosticCommand;
  cluster: K3dDiagnosticCluster;
  lane: string;
  statePath: string;
  failure?: string | undefined;
  k3dOutput?: Partial<CommandOutput>;
}

export async function k3dHostMetrics(directory: string) {
  const disk = await statfs(directory).catch(() => undefined);
  const pressure = await Promise.all(
    ["cpu", "memory", "io"].map(
      async (resource) =>
        [
          resource,
          await readFile(`/proc/pressure/${resource}`, "utf8").catch(() => "unavailable"),
        ] as const,
    ),
  );
  return {
    cpus: cpus().length,
    loadAverage: loadavg(),
    memoryBytes: { total: totalmem(), free: freemem() },
    runnerTempDisk: disk && {
      availableBytes: disk.bavail * disk.bsize,
      capacityBytes: disk.blocks * disk.bsize,
      freeInodes: disk.ffree,
    },
    pressure: Object.fromEntries(pressure),
  };
}

function safeText(value: string): string;
function safeText(value: unknown): string | undefined;
function safeText(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.split("\n").map(redactCredentialLine).join("\n").slice(-8_000)
    : undefined;
}

// Each diagnostic command is bounded; a hung one must not replace the failure.
const configuredTimeoutMs = Number(process.env.OPENCLAW_CI_K3D_DIAGNOSTICS_TIMEOUT_MS);
const diagnosticCommandTimeoutMs = configuredTimeoutMs > 0 ? configuredTimeoutMs : 10_000;

// k3d colors its log even into a pipe.
// eslint-disable-next-line no-control-regex
export const ANSI_COLOR = /\u001b\[[0-9;]*m/gu;

// k3d progress lines name the step where creation stopped.
function k3dOutputExcerpt({ stdout = "", stderr = "" }: Partial<CommandOutput> = {}) {
  const text = [stderr, stdout].join("\n").replace(ANSI_COLOR, "").trim();
  return text === "" ? undefined : safeText(text);
}

function record(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  if (result === undefined) {
    throw new TypeError("Expected a diagnostic object");
  }
  return result;
}

function entries(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected a diagnostic array");
  }
  return value;
}

function items(stdout: string): readonly unknown[] {
  const result: unknown = JSON.parse(stdout);
  return entries(record(result).items);
}

function conditions(value: unknown = []) {
  return entries(value)
    .slice(0, 12)
    .map((entry) => {
      const { type, status, reason, message } = record(entry);
      return { type, status, reason, message: safeText(message) };
    });
}

function nodeSnapshot(value: unknown) {
  const node = record(value);
  const status = asRecord(node.status);
  return {
    name: asRecord(node.metadata)?.name,
    kubernetesVersion: asRecord(status?.nodeInfo)?.kubeletVersion,
    conditions: conditions(status?.conditions),
    capacity: status?.capacity,
    allocatable: status?.allocatable,
  };
}

function podSnapshot(value: unknown) {
  const pod = record(value);
  const status = asRecord(pod.status);
  return {
    name: asRecord(pod.metadata)?.name,
    node: asRecord(pod.spec)?.nodeName,
    phase: status?.phase,
    conditions: conditions(status?.conditions),
    containers: entries(status?.containerStatuses ?? []).map((entry) => {
      const container = record(entry);
      const state = asRecord(container.state);
      const waiting = asRecord(state?.waiting);
      return {
        name: container.name,
        ready: container.ready,
        restarts: container.restartCount,
        waitingReason: waiting?.reason,
        waitingMessage: safeText(waiting?.message),
        terminatedReason: asRecord(state?.terminated)?.reason,
      };
    }),
  };
}

function eventSnapshot(value: unknown) {
  const event = record(value);
  const involvedObject = asRecord(event.involvedObject);
  return {
    kind: involvedObject?.kind,
    name: involvedObject?.name,
    type: event.type,
    reason: event.reason,
    message: safeText(event.message),
    count: event.count,
    lastTimestamp: event.lastTimestamp,
  };
}

export async function captureK3dDiagnostics({
  execFile,
  cluster,
  lane,
  statePath,
  failure,
  k3dOutput,
}: DiagnosticOptions): Promise<void> {
  const kubectl = process.env.OCC_KUBECTL_BIN ?? "kubectl";
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const scope = ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context];
  async function observe<Value>(
    command: string,
    args: string[],
    project: (output: CommandOutput) => Value,
    {
      maxOutputChars = 2 * 1024 * 1024,
      partial,
    }: { maxOutputChars?: number; partial?: (output: CommandOutput) => Value } = {},
  ): Promise<Observation<Value>> {
    try {
      const output = await execFile(command, args, {
        timeoutMs: diagnosticCommandTimeoutMs,
        maxOutputChars,
      });
      return { status: "ok", value: project(output) };
    } catch (error) {
      // A broken command or response must never replace the bootstrap failure.
      const result = asRecord(error);
      if (result?.timedOut !== true) {
        return { status: "unavailable" };
      }
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      if (partial && (stdout || stderr)) {
        try {
          return { status: "timed-out", value: partial({ stdout, stderr }) };
        } catch {
          // Keep the timeout status when partial output cannot be projected.
        }
      }
      return { status: "timed-out" };
    }
  }

  const containerState = (name: string) =>
    observe(docker, ["inspect", "--format", "{{json .State}}", name], ({ stdout }) => {
      const value: unknown = JSON.parse(stdout);
      const state = record(value);
      return {
        status: state.Status,
        running: state.Running,
        oomKilled: state.OOMKilled,
        exitCode: state.ExitCode,
        error: safeText(state.Error),
      };
    });
  const [host, nodes, pods, events, containers] = await Promise.all([
    k3dHostMetrics(cluster.directory),
    observe(kubectl, [...scope, "get", "nodes", "-o", "json"], ({ stdout }) =>
      items(stdout).slice(0, 10).map(nodeSnapshot),
    ),
    observe(
      kubectl,
      [...scope, "--namespace", "kube-system", "get", "pods", "-o", "json"],
      ({ stdout }) => items(stdout).slice(0, 30).map(podSnapshot),
    ),
    observe(
      kubectl,
      [...scope, "--namespace", "kube-system", "get", "events", "-o", "json"],
      ({ stdout }) => items(stdout).slice(-50).map(eventSnapshot),
    ),
    Promise.all(
      cluster.nodes.map(async (name) => ({
        name,
        state: await containerState(name),
        // A running node whose K3s has exited can still list the entrypoint's
        // kubectl retry loop here (finding 1174).
        processes: await observe(docker, ["top", name], ({ stdout }) => safeText(stdout)),
        logs: await observe(
          docker,
          ["logs", "--tail=20000", "--timestamps", name],
          ({ stdout, stderr }) => nodeLogExcerpt(stdout, stderr),
          {
            maxOutputChars: 8 * 1024 * 1024,
            // A slow read on a struggling host still keeps what it got.
            partial: ({ stdout, stderr }) =>
              nodeLogExcerpt(stdout, stderr, "docker logs timed out; partial output"),
          },
        ),
      })),
    ),
  ]);
  const k3dCreateOutput = k3dOutputExcerpt(k3dOutput);
  const preparationId = preparationIdentity(cluster.owner);
  const report = {
    capturedAt: new Date().toISOString(),
    preparationId,
    runtimeProvenance: await readRuntimeProvenance(statePath, { lane, preparationId }),
    lane,
    cluster: cluster.name,
    ...(failure ? { failure } : {}),
    ...(k3dCreateOutput ? { k3dCreateOutput } : {}),
    nodeImage: cluster.nodeImage,
    host,
    nodes,
    pods,
    events,
    containers,
  };
  // The report lives beside cleanup state, outside the cluster directory that
  // cleanup removes. The workflow uploads only this projected report.
  await writeFile(`${statePath}.diagnostics.json`, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.error(`[prepare:${lane}] k3d diagnostics saved to ${statePath}.diagnostics.json`);
}
