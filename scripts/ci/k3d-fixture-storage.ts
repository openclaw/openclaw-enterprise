import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { K3dCommand, PreparationTiming } from "./k3d-node-images.ts";
import { ownedName } from "./resource-names.ts";

interface FixtureState {
  lane: string;
  prefix: string;
}

interface FixtureResource {
  id: string;
}

interface FixtureCluster extends FixtureResource {
  directory: string;
  kubeconfig: string;
  context: string;
  kubernetesVersion?: string;
}

interface FixtureImage {
  image: string;
  resourceId: string;
}

interface FixtureDependencies {
  execFile: K3dCommand;
  progress: (lane: string, message: string) => void;
  k3dStage: <Result>(
    state: FixtureState,
    stage: string,
    operation: () => Promise<Result>,
  ) => Promise<Result>;
  timedPreparation: PreparationTiming;
  captureK3dDiagnostics: (options: {
    execFile: K3dCommand;
    cluster: FixtureCluster;
    lane: string;
    statePath: string;
    failure: string | undefined;
  }) => Promise<unknown>;
  fixtureDockerContext: string;
  imageCommandTimeoutMs: number;
  imageBuildBudgetMs: () => number | undefined;
  imageBuildTestReserveMs: number;
  addResource: (
    state: FixtureState,
    kind: "image-tag",
    resource: { name: string; owner: string },
  ) => FixtureResource;
  writeState: (statePath: string, state: FixtureState) => Promise<void>;
  markResourceReady: (
    statePath: string,
    state: FixtureState,
    resource: FixtureResource,
  ) => Promise<void>;
  registerImageInK3d: (
    statePath: string,
    state: FixtureState,
    cluster: FixtureCluster,
    image: string,
    envName: string,
  ) => Promise<{ reference: string }>;
}

interface KubernetesCondition {
  type: string;
  status?: string;
  reason?: string;
  message?: string;
}

interface StoragePod {
  metadata?: { name?: string };
  spec?: { nodeName?: string; nodeSelector?: Record<string, string> };
  status?: {
    phase?: string;
    conditions?: KubernetesCondition[];
    containerStatuses?: {
      name: string;
      image: string;
      ready: boolean;
      restartCount: number;
      state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string } };
    }[];
  };
}

interface StorageNode {
  metadata?: { name?: string };
  spec?: { unschedulable?: boolean; taints?: unknown[] };
  status?: { conditions?: KubernetesCondition[] };
}

interface FixtureBuildError extends NodeJS.ErrnoException {
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

// Retain only the fixed fixture Dockerfile's numbered operations and states.
// Build arguments, container output and error details can contain credentials.
function fixtureBuildProgress(error: FixtureBuildError) {
  const steps = new Map<string, { label: string; state?: string }>();
  for (const output of [error.stdout, error.stderr]) {
    if (typeof output !== "string") {
      continue;
    }
    const start = Math.max(0, output.length - 32_768);
    const lines = output.slice(start).split("\n");
    if (start > 0 && output[start - 1] !== "\n") {
      lines.shift();
    }
    for (const [index, rawLine] of lines.entries()) {
      const line =
        index < lines.length - 1 && rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (/\p{Cc}/u.test(line)) {
        continue;
      }
      const operation = /^#([0-9]{1,4}) \[([0-9]{1,4}\/[0-9]{1,4})\] (FROM|RUN|COPY)(?: |$)/.exec(
        line,
      );
      if (operation) {
        const [, id, position, verb] = operation;
        if (id !== undefined) {
          steps.set(id, { label: `#${id} [${position}] ${verb}` });
        }
      } else {
        const [, id, state] =
          /^#([0-9]{1,4}) (DONE|CACHED|ERROR)(?:$|:| [0-9]+(?:\.[0-9]+)?s$)/.exec(line) ?? [];
        const step = id === undefined ? undefined : steps.get(id);
        if (step && state !== undefined) {
          step.state = state;
        }
      }
      if (steps.size > 8) {
        const oldest = steps.keys().next();
        if (!oldest.done) {
          steps.delete(oldest.value);
        }
      }
    }
  }
  return (
    [...steps.values()]
      .map(({ label, state }) => (state ? `${label} ${state}` : label))
      .join("; ") || "no numbered Dockerfile steps captured"
  );
}

export function createK3dFixtureStorage({
  execFile,
  progress,
  k3dStage,
  timedPreparation,
  captureK3dDiagnostics,
  fixtureDockerContext,
  imageCommandTimeoutMs,
  imageBuildBudgetMs,
  imageBuildTestReserveMs,
  addResource,
  writeState,
  markResourceReady,
  registerImageInK3d,
}: FixtureDependencies) {
  async function verifyFixtureStorage(cluster: FixtureCluster, timeoutSeconds = 120) {
    const kubectl = process.env.OCC_KUBECTL_BIN ?? "kubectl";
    const scope = [
      "--kubeconfig",
      cluster.kubeconfig,
      "--context",
      cluster.context,
      "--namespace",
      "kube-system",
    ];
    try {
      await execFile(
        kubectl,
        [
          ...scope,
          "rollout",
          "status",
          "deployment/local-path-provisioner",
          `--timeout=${timeoutSeconds}s`,
        ],
        { timeoutMs: (timeoutSeconds + 10) * 1_000 },
      );
    } catch {
      // This fixture lane has no provider credentials. Limit diagnostics to its
      // storage controller; never serialize arbitrary Pod specs or tenant logs.
      const readLogs = (previous: boolean) =>
        execFile(
          kubectl,
          [
            ...scope,
            "logs",
            "deployment/local-path-provisioner",
            "--tail=30",
            ...(previous ? ["--previous"] : []),
          ],
          { timeoutMs: 10_000 },
        );
      const [podObservation, currentLogs, previousLogs, nodeObservation] = await Promise.allSettled(
        [
          execFile(
            kubectl,
            [...scope, "get", "pods", "--selector=app=local-path-provisioner", "-o", "json"],
            { timeoutMs: 10_000 },
          ),
          readLogs(false),
          readLogs(true),
          execFile(kubectl, [...scope.slice(0, 4), "get", "nodes", "-o", "json"], {
            timeoutMs: 10_000,
          }),
        ],
      );
      let pods: unknown[] = [];
      if (podObservation.status === "fulfilled") {
        try {
          const { items } = JSON.parse(podObservation.value.stdout) as { items?: StoragePod[] };
          pods = (items ?? []).map((pod) => ({
            name: pod.metadata?.name,
            node: pod.spec?.nodeName,
            nodeSelector: pod.spec?.nodeSelector,
            phase: pod.status?.phase,
            conditions: (pod.status?.conditions ?? []).map(({ type, status, reason, message }) => ({
              type,
              status,
              reason,
              message,
            })),
            containers: (pod.status?.containerStatuses ?? []).map((container) => ({
              name: container.name,
              image: container.image,
              ready: container.ready,
              restarts: container.restartCount,
              waiting: container.state?.waiting,
              terminated: container.state?.terminated?.reason,
            })),
          }));
        } catch {
          // Preserve the storage failure even when Kubernetes diagnostics are incomplete.
        }
      }
      let nodes: unknown[] = [];
      if (nodeObservation.status === "fulfilled") {
        try {
          const { items } = JSON.parse(nodeObservation.value.stdout) as { items?: StorageNode[] };
          nodes = (items ?? []).map((node) => ({
            name: node.metadata?.name,
            unschedulable: node.spec?.unschedulable,
            taints: node.spec?.taints,
            conditions: (node.status?.conditions ?? [])
              .filter(({ type }) =>
                ["Ready", "DiskPressure", "MemoryPressure", "PIDPressure"].includes(type),
              )
              .map(({ type, status, reason, message }) => ({ type, status, reason, message })),
          }));
        } catch {
          // Do not replace the storage failure with a diagnostic parsing failure.
        }
      }
      const logs = [currentLogs, previousLogs].map((result) =>
        result.status === "fulfilled" ? result.value.stdout.slice(-4_000) : "unavailable",
      );
      throw new Error(
        `CI fixture storage controller is not ready: ${JSON.stringify({ kubernetesVersion: cluster.kubernetesVersion, pods, nodes, logs })}`,
      );
    }
  }

  // The fixture build needs no cluster, so lanes can overlap it with k3d creation.
  async function buildFixtureImage(statePath: string, state: FixtureState) {
    const run = (stage: string, args: string[], limitMs: number) =>
      k3dStage(state, stage, async () => {
        if (!Number.isFinite(limitMs) || limitMs <= 0 || limitMs > 2_147_483_647) {
          throw new Error(
            `Fixture image preparation ${stage} requires a valid finite command timeout.`,
          );
        }
        const budgetMs = imageBuildBudgetMs();
        if (budgetMs !== undefined && budgetMs < 1_000) {
          throw new Error(
            `Fixture image preparation ${stage} was not started: the lane keeps ` +
              `${imageBuildTestReserveMs} ms before its deadline for remaining preparation and tests.`,
          );
        }
        const timeoutMs = Math.min(limitMs, budgetMs ?? limitMs);
        try {
          return await execFile(process.env.OCC_DOCKER_BIN ?? "docker", args, {
            timeoutMs,
            processGroup: process.platform !== "win32",
          });
        } catch (error) {
          const buildError = error as FixtureBuildError;
          if (stage === "fixture-image-build") {
            try {
              progress(
                state.lane,
                `Fixture image build steps (captured tail): ${fixtureBuildProgress(buildError)}`,
              );
            } catch {
              // Diagnostics must preserve the original build failure.
            }
          }
          if (buildError.timedOut) {
            throw new Error(`Fixture image preparation ${stage} timed out after ${timeoutMs} ms.`, {
              cause: error,
            });
          }
          if (buildError.code === "ENOENT") {
            throw new Error(
              `Missing required command on PATH: ${process.env.OCC_DOCKER_BIN ?? "docker"}`,
              { cause: error },
            );
          }
          throw error;
        }
      });
    await run(
      "fixture-engine-version",
      ["version", "--format", "{{.Server.Version}}"],
      imageCommandTimeoutMs,
    );
    const image = `localhost/${ownedName("openclaw-ci-image", state.prefix, { maxLength: 48 })}/fixture:local`;
    const resource = addResource(state, "image-tag", { name: image, owner: state.prefix });
    await writeState(statePath, state);
    // Allow slow fixture builds while keeping a finite cap outside hosted lanes.
    await run(
      "fixture-image-build",
      ["build", "--pull=false", "-t", image, fixtureDockerContext],
      30 * 60_000,
    );
    await markResourceReady(statePath, state, resource);
    return { image, resourceId: resource.id };
  }

  async function importFixtureImage(
    statePath: string,
    state: FixtureState,
    cluster: FixtureCluster,
    built: FixtureImage,
  ) {
    const registered = await registerImageInK3d(
      statePath,
      state,
      cluster,
      built.image,
      "OCC_TEST_KUBERNETES_IMAGE",
    );
    return { image: registered.reference, resourceId: built.resourceId };
  }

  // The fixture import needs the ready nodes, not the storage provisioner. Settle
  // both before the lane pins the image, restarts storage, or hands off to cleanup.
  async function prepareFixtureStorageAndImage(
    statePath: string,
    state: FixtureState,
    cluster: FixtureCluster,
    built: FixtureImage,
  ) {
    const { lane } = state;
    const [storage, fixture] = await Promise.allSettled([
      k3dStage(state, "k3d-storage", () => verifyFixtureStorage(cluster)).then(() =>
        markResourceReady(statePath, state, cluster),
      ),
      timedPreparation(lane, "fixture-image-import", () =>
        importFixtureImage(statePath, state, cluster, built),
      ),
    ]);
    if (storage.status === "rejected" || fixture.status === "rejected") {
      // Record a bounded phase notice when the image failure has no transport summary.
      const failure =
        fixture.status === "rejected"
          ? ((fixture.reason as { k3dImageImportFailure?: string } | null | undefined)
              ?.k3dImageImportFailure ??
            "Fixture image preparation failed during fixture-image-import.")
          : undefined;
      await captureK3dDiagnostics({ execFile, cluster, lane, statePath, failure }).catch(() =>
        progress(lane, "k3d diagnostics unavailable"),
      );
      if (storage.status === "rejected") {
        throw storage.reason;
      }
      if (fixture.status === "rejected") {
        throw fixture.reason;
      }
    }
    return fixture.value;
  }

  async function pinFixtureImageInK3d(cluster: FixtureCluster, image: string) {
    const name = "openclaw-ci-fixture-image-pin";
    const manifestPath = join(cluster.directory, `${name}.json`);
    const manifest = {
      apiVersion: "apps/v1",
      kind: "DaemonSet",
      metadata: { name, namespace: "kube-system" },
      spec: {
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            automountServiceAccountToken: false,
            nodeSelector: { "kubernetes.io/os": "linux" },
            tolerations: [{ operator: "Exists" }],
            containers: [
              {
                name: "pin",
                image,
                imagePullPolicy: "Never",
                command: ["node", "-e", "setInterval(() => {}, 2147483647)"],
                resources: {
                  requests: { cpu: "1m", memory: "8Mi" },
                  limits: { cpu: "25m", memory: "128Mi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                  readOnlyRootFilesystem: true,
                  runAsNonRoot: true,
                  runAsUser: 1000,
                  seccompProfile: { type: "RuntimeDefault" },
                },
              },
            ],
          },
        },
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await execFile(process.env.OCC_KUBECTL_BIN ?? "kubectl", [
      "--kubeconfig",
      cluster.kubeconfig,
      "--context",
      cluster.context,
      "--namespace",
      "kube-system",
      "apply",
      "-f",
      manifestPath,
    ]);
    await execFile(
      process.env.OCC_KUBECTL_BIN ?? "kubectl",
      [
        "--kubeconfig",
        cluster.kubeconfig,
        "--context",
        cluster.context,
        "--namespace",
        "kube-system",
        "rollout",
        "status",
        `daemonset/${name}`,
        "--timeout=120s",
      ],
      { timeoutMs: 130_000 },
    );
  }

  return {
    verifyFixtureStorage,
    buildFixtureImage,
    importFixtureImage,
    prepareFixtureStorageAndImage,
    pinFixtureImageInK3d,
  };
}
