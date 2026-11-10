import assert from "node:assert/strict";
import { execFile } from "node:child_process";

import { kubectlGetJson } from "./kubernetes-api-read.mjs";
import { kubectlArguments } from "./kubernetes-real.mjs";
import type { RunWindow } from "./public-egress-deadline.ts";

type Selection = { kubeconfigPath: string; kubernetesContext: string };
type Owner = { apiVersion: string; kind: string; name: string; uid: string; controller?: boolean };
type Metadata = {
  name: string;
  namespace: string;
  uid: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  ownerReferences?: Owner[];
  deletionTimestamp?: string;
};
type Container = {
  name: string;
  image: string;
  ports?: { protocol: string; containerPort: number }[];
};
type ContainerStatus = {
  name: string;
  ready: boolean;
  containerID?: string;
  imageID: string;
  state?: {
    running?: { startedAt: string };
    terminated?: { exitCode: number };
    waiting?: { reason?: string };
  };
};

export type PublicEgressPod = {
  metadata: Metadata;
  spec: { containers: Container[]; initContainers?: Container[] };
  status?: {
    conditions?: { type: string; status: string }[];
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
};

type Sandbox = { apiVersion: string; metadata: Metadata };
type StatefulSet = Sandbox & { spec: { template: { spec: { containers: Container[] } } } };

function readyPod(pod: PublicEgressPod) {
  return (
    !pod.metadata.deletionTimestamp &&
    pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True")
  );
}

export function onlyReadyPod(pods: PublicEgressPod[], label: string) {
  const ready = pods.filter(readyPod);
  assert.equal(ready.length, 1, `one ready ${label} Pod is required`);
  return ready[0]!;
}

// Keep the requested digest and the actual CRI identity separate. CRI may
// report the selected image's platform manifest or config, rather than its index.
export function runningContainer(pod: PublicEgressPod, name: string, expectedImage: string) {
  assert.ok(readyPod(pod), `the ${name} Pod must be ready and nonterminating`);
  const container = pod.spec.containers.find((entry) => entry.name === name);
  const status = pod.status?.containerStatuses?.find((entry) => entry.name === name);
  assert.equal(container?.image, expectedImage);
  assert.ok(
    status?.ready && status.state?.running && status.containerID && status.imageID,
    `the ${name} container must be running with a CRI identity`,
  );
  assert.ok(pod.metadata.uid);
  assert.ok(Number.isFinite(Date.parse(status.state.running.startedAt)));
  return {
    namespace: pod.metadata.namespace,
    pod: pod.metadata.name,
    uid: pod.metadata.uid,
    image: container.image,
    imageID: status.imageID,
    containerID: status.containerID,
    startedAt: status.state.running.startedAt,
  };
}

export function assertSupervisorRuntimeIdentity(
  supervisor: Pick<ReturnType<typeof runningContainer>, "namespace" | "uid">,
  sandboxUid: string,
  reportedIdentity: string | undefined,
): asserts reportedIdentity is string {
  // OpenShell's Kubernetes Driver records the paired dedicated supervisor Pod UID
  // in the Gateway's compute runtime identity for this Sandbox generation.
  assert.equal(
    reportedIdentity,
    `kubernetes://${supervisor.namespace}/${sandboxUid}/${supervisor.uid}`,
    "the Gateway must identify the current Sandbox and supervisor Pod UID",
  );
}

export function publicEgressKubernetes(selection: Selection, window: RunWindow) {
  async function execute(args: string[], signal: AbortSignal, stdin?: string) {
    signal.throwIfAborted();
    const result = Promise.withResolvers<string>();
    const child = execFile(
      "kubectl",
      kubectlArguments(selection, args),
      { encoding: "utf8", signal, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // Command output and arguments can include sensitive workload data.
          result.reject(signal.reason ?? new Error(`Public egress kubectl ${args[0]} failed`));
        } else {
          result.resolve(stdout);
        }
      },
    );
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
    try {
      return await result.promise;
    } finally {
      await closed;
    }
  }

  async function read<T>(args: string[], phase = window.signal): Promise<T> {
    const signal = AbortSignal.any([phase, window.limit(20_000)]);
    const output = await kubectlGetJson(selection, args, { signal, timeoutMs: 20_000 });
    return JSON.parse(output ?? (await execute(args, signal)));
  }

  return {
    async namespaces(...args: string[]) {
      return (await read<{ items: Sandbox[] }>(["get", "namespaces", ...args, "-o", "json"])).items;
    },
    namespace: (name: string, signal?: AbortSignal) =>
      read<Sandbox>(["get", "namespace", name, "-o", "json"], signal),
    async pods(namespace: string, selector: string, signal?: AbortSignal) {
      return (
        await read<{ items: PublicEgressPod[] }>(
          ["get", "pods", "-n", namespace, "-l", selector, "-o", "json"],
          signal,
        )
      ).items;
    },
    statefulSet: (namespace: string, name: string) =>
      read<StatefulSet>(["get", "statefulset", name, "-n", namespace, "-o", "json"]),
    async sandboxes(namespace: string) {
      return (
        await read<{ items: Sandbox[] }>([
          "get",
          "sandboxes.agents.x-k8s.io",
          "-n",
          namespace,
          "-o",
          "json",
        ])
      ).items;
    },
    exec: (pod: PublicEgressPod, container: string, args: string[], stdin?: string) =>
      execute(
        [
          "exec",
          "-i",
          "-n",
          pod.metadata.namespace,
          pod.metadata.name,
          "-c",
          container,
          "--",
          ...args,
        ],
        window.limit(510_000),
        stdin,
      ),
  };
}
