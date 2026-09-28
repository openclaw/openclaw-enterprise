import { readFile, statfs, writeFile } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";

export async function k3dHostMetrics(directory) {
  const disk = await statfs(directory).catch(() => undefined);
  const pressure = await Promise.all(
    ["cpu", "memory", "io"].map(async (resource) => [
      resource,
      await readFile(`/proc/pressure/${resource}`, "utf8").catch(() => "unavailable"),
    ]),
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

// Bootstrap logs can contain K3s join tokens. Never publish credential-bearing
// lines, full object specs, kubeconfigs, or container environments.
function safeText(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value
    .split("\n")
    .map((line) =>
      /token|password|secret|credential|authorization|bearer|private.?key|https?:\/\/[^\s/]+@/i.test(
        line,
      )
        ? "[redacted credential-bearing line]"
        : line,
    )
    .join("\n")
    .slice(-8_000);
}

function conditions(values = []) {
  return values.slice(0, 12).map(({ type, status, reason, message }) => ({
    type,
    status,
    reason,
    message: safeText(message),
  }));
}

export async function captureK3dDiagnostics({ execFile, cluster, lane, statePath }) {
  const kubectl = process.env.OCC_KUBECTL_BIN ?? "kubectl";
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const scope = ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context];
  async function observe(command, args, project) {
    try {
      const output = await execFile(command, args, {
        timeoutMs: 10_000,
        maxOutputChars: 2 * 1024 * 1024,
      });
      return { status: "ok", value: project(output) };
    } catch (error) {
      // A broken diagnostic command must never replace the bootstrap failure.
      return { status: error.timedOut ? "timed-out" : "unavailable" };
    }
  }
  const [host, nodes, pods, events, containers] = await Promise.all([
    k3dHostMetrics(cluster.directory),
    observe(kubectl, [...scope, "get", "nodes", "-o", "json"], ({ stdout }) =>
      JSON.parse(stdout)
        .items.slice(0, 10)
        .map((node) => ({
          name: node.metadata?.name,
          kubernetesVersion: node.status?.nodeInfo?.kubeletVersion,
          conditions: conditions(node.status?.conditions),
          capacity: node.status?.capacity,
          allocatable: node.status?.allocatable,
        })),
    ),
    observe(
      kubectl,
      [...scope, "--namespace", "kube-system", "get", "pods", "-o", "json"],
      ({ stdout }) =>
        JSON.parse(stdout)
          .items.slice(0, 30)
          .map((pod) => ({
            name: pod.metadata?.name,
            node: pod.spec?.nodeName,
            phase: pod.status?.phase,
            conditions: conditions(pod.status?.conditions),
            containers: (pod.status?.containerStatuses ?? []).map((container) => ({
              name: container.name,
              ready: container.ready,
              restarts: container.restartCount,
              waitingReason: container.state?.waiting?.reason,
              waitingMessage: safeText(container.state?.waiting?.message),
              terminatedReason: container.state?.terminated?.reason,
            })),
          })),
    ),
    observe(
      kubectl,
      [...scope, "--namespace", "kube-system", "get", "events", "-o", "json"],
      ({ stdout }) =>
        JSON.parse(stdout)
          .items.slice(-50)
          .map((event) => ({
            kind: event.involvedObject?.kind,
            name: event.involvedObject?.name,
            type: event.type,
            reason: event.reason,
            message: safeText(event.message),
            count: event.count,
            lastTimestamp: event.lastTimestamp,
          })),
    ),
    Promise.all(
      cluster.nodes.map(async (name) => ({
        name,
        state: await observe(
          docker,
          ["inspect", "--format", "{{json .State}}", name],
          ({ stdout }) => {
            const state = JSON.parse(stdout);
            return {
              status: state.Status,
              running: state.Running,
              oomKilled: state.OOMKilled,
              exitCode: state.ExitCode,
              error: safeText(state.Error),
            };
          },
        ),
        logs: await observe(
          docker,
          ["logs", "--tail=100", "--timestamps", name],
          ({ stdout, stderr }) => safeText(`${stdout}\n${stderr}`),
        ),
      })),
    ),
  ]);
  const report = {
    capturedAt: new Date().toISOString(),
    lane,
    cluster: cluster.name,
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
