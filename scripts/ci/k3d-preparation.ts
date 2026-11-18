import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord } from "../../packages/utils/src/index.ts";
import { deleteOwnedK3dCluster } from "./cleanup.ts";
import { redactCredentialLine } from "./k3d-node-log.ts";
import {
  ANSI_COLOR,
  captureK3dDiagnostics,
  k3dHostMetrics,
} from "./k3d-preparation-diagnostics.ts";
import { isOpenShellLane } from "./openshell-full-integration.ts";
import { prepareOpenShellClusterBootstrap } from "./openshell.ts";
import { commandAvailable, execFile, type PreparationChild } from "./prepare-command.ts";
import { ownedName } from "./resource-names.ts";

export interface PreparationResource {
  id: string;
  kind: string;
  owner: string;
  status: string;
  createdAt: string;
  readyAt?: string;
}

export interface PreparationState {
  lane: string;
  prefix: string;
  resources: PreparationResource[];
}

export interface PreparationJournal {
  addResource: <Kind extends string, Details extends object>(
    state: PreparationState,
    kind: Kind,
    resource: Details,
  ) => PreparationResource & { kind: Kind } & Details;
  writeState: (path: string, state: PreparationState) => Promise<void>;
  markResourceReady: (
    path: string,
    state: PreparationState,
    resource: PreparationResource,
  ) => Promise<void>;
}

type PreparationOptions = PreparationJournal & {
  progress: (lane: string, message: string) => void;
  fixtureLanes: ReadonlySet<string>;
  lanesWithoutK3sAddons: ReadonlySet<string>;
  defaultK3sImage: string;
};

export type K3dCluster = PreparationResource & {
  kind: "k3d-cluster";
  name: string;
  directory: string;
  kubeconfig: string;
  context: string;
  nodes: string[];
  nodeImage?: string;
  disabledK3sAddons?: readonly string[];
  kubectl?: string;
  kubernetesVersion?: string;
  pluginStatusProxyCidrs?: string;
};

const disabledK3sAddons = Object.freeze(["traefik", "servicelb", "metrics-server"]);

// Never hand out the same probe port twice within this preparation process.
// Docker allocates PostgreSQL's port directly; other callers still use probes.
const reservedLoopbackPorts = new Set<number>();

export async function reserveLoopbackPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
    if (!address || typeof address === "string") {
      throw new Error("Failed to reserve a loopback port.");
    }
    if (!reservedLoopbackPorts.has(address.port)) {
      reservedLoopbackPorts.add(address.port);
      return address.port;
    }
  }
  throw new Error("Failed to reserve an unused loopback port.");
}

export function isPreparationResource(value: unknown): value is PreparationResource {
  const resource = asRecord(value);
  return (
    resource !== undefined &&
    typeof resource.id === "string" &&
    typeof resource.kind === "string" &&
    typeof resource.owner === "string" &&
    typeof resource.status === "string" &&
    typeof resource.createdAt === "string" &&
    (resource.readyAt === undefined || typeof resource.readyAt === "string")
  );
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isK3dCluster(value: unknown): value is K3dCluster {
  if (!isPreparationResource(value)) {
    return false;
  }
  const resource = asRecord(value);
  return (
    resource?.kind === "k3d-cluster" &&
    typeof resource.name === "string" &&
    typeof resource.directory === "string" &&
    typeof resource.kubeconfig === "string" &&
    typeof resource.context === "string" &&
    isStringList(resource.nodes) &&
    [
      resource.nodeImage,
      resource.kubectl,
      resource.kubernetesVersion,
      resource.pluginStatusProxyCidrs,
    ].every((field) => field === undefined || typeof field === "string") &&
    (resource.disabledK3sAddons === undefined || isStringList(resource.disabledK3sAddons))
  );
}

export function findK3dCluster(state: PreparationState): K3dCluster | undefined {
  const resource = state.resources.find(({ kind }) => kind === "k3d-cluster");
  if (resource !== undefined && !isK3dCluster(resource)) {
    throw new Error("Invalid k3d cluster in CI state.");
  }
  return resource;
}

export function createK3dPreparation({
  addResource,
  writeState,
  markResourceReady,
  progress,
  fixtureLanes,
  lanesWithoutK3sAddons,
  defaultK3sImage,
}: PreparationOptions) {
  async function k3dStage<Result>(
    state: Pick<PreparationState, "lane">,
    stage: string,
    run: () => Promise<Result>,
  ) {
    const started = performance.now();
    progress(state.lane, JSON.stringify({ stage, status: "started" }));
    let status = "failed";
    try {
      const result = await run();
      status = "passed";
      return result;
    } finally {
      progress(
        state.lane,
        JSON.stringify({ stage, status, elapsedMs: Math.round(performance.now() - started) }),
      );
    }
  }

  async function logK3dHost(state: PreparationState, directory: string, stage: string) {
    try {
      progress(state.lane, JSON.stringify({ stage, ...(await k3dHostMetrics(directory)) }));
    } catch {
      progress(state.lane, JSON.stringify({ stage, status: "unavailable" }));
    }
  }

  async function ensureK3dCluster(statePath: string, state: PreparationState): Promise<K3dCluster> {
    const existing = findK3dCluster(state);
    if (existing) {
      return existing;
    }
    await commandAvailable(process.env.OPENCLAW_CI_K3D_BIN ?? "k3d", ["version"]);
    const openShell = isOpenShellLane(state.lane);
    const crossNodePluginStatus = fixtureLanes.has(state.lane);
    if (!openShell) {
      await commandAvailable(process.env.OCC_KUBECTL_BIN ?? "kubectl", [
        "version",
        "--client=true",
      ]);
    }
    const cluster = ownedName("openclaw-k8s", state.prefix, { maxLength: 32 });
    const apiPort = await reserveLoopbackPort();
    const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), `${cluster}-`));
    await chmod(directory, 0o700);
    const kubeconfig = join(directory, "kubeconfig");
    const sharedStorage = crossNodePluginStatus ? join(directory, "storage") : undefined;
    if (sharedStorage) {
      await mkdir(sharedStorage, { mode: 0o700 });
    }
    const resource: K3dCluster = addResource(state, "k3d-cluster", {
      name: cluster,
      directory,
      kubeconfig,
      context: `k3d-${cluster}`,
      nodes: [
        `k3d-${cluster}-server-0`,
        ...(crossNodePluginStatus ? [`k3d-${cluster}-agent-0`] : []),
      ],
      // A digest-pinned image bypasses k3d's online release-channel lookup. The
      // running API server must still satisfy the ordinary Kubernetes 1.35 gate.
      ...(!openShell ? { nodeImage: process.env.OPENCLAW_CI_K3S_IMAGE || defaultK3sImage } : {}),
      // Recorded so gateway routing can refuse a cluster created without Traefik.
      ...(lanesWithoutK3sAddons.has(state.lane) ? { disabledK3sAddons } : {}),
    });
    await writeState(statePath, state);
    if (openShell) {
      const bootstrap = await prepareOpenShellClusterBootstrap({
        directory,
        execFile,
      });
      resource.nodeImage = bootstrap.k3sImage;
      resource.kubectl = bootstrap.kubectl;
      await writeState(statePath, state);
    }
    try {
      if (crossNodePluginStatus) {
        await logK3dHost(state, directory, "k3d-host-before");
      }
      await createK3dCluster(statePath, state, resource, [
        "cluster",
        "create",
        cluster,
        ...(resource.nodeImage ? ["--image", resource.nodeImage] : []),
        "--servers",
        "1",
        "--agents",
        crossNodePluginStatus ? "1" : "0",
        ...(sharedStorage ? ["--volume", `${sharedStorage}:/var/lib/rancher/k3s/storage@all`] : []),
        "--api-port",
        `127.0.0.1:${apiPort}`,
        "--kubeconfig-update-default=false",
        "--kubeconfig-switch-context=false",
        // One server needs no load balancer: agents join k3d-<cluster>-server-0
        // directly, so k3d's serverlb (nginx) only proxied the host's API port.
        // Its entrypoint sleeps 6 s before nginx starts, and k3d waited for it on
        // every create. Without it, server-0 publishes the API port itself, and
        // the nginx connection limit behind finding 682 is gone too.
        "--no-lb",
        ...(resource.disabledK3sAddons
          ? ["--k3s-arg", `--disable=${resource.disabledK3sAddons.join(",")}@server:*`]
          : []),
        // Keep failed fixture containers for diagnostics; registered cleanup
        // owns their deletion after collection, including partial creation.
        ...(crossNodePluginStatus || state.lane === "staging-signin" ? ["--no-rollback"] : []),
      ]);
      await k3dStage(state, "k3d-kubeconfig", async () => {
        const kubeconfigData = await execFile(process.env.OPENCLAW_CI_K3D_BIN ?? "k3d", [
          "kubeconfig",
          "get",
          cluster,
        ]);
        await writeFile(kubeconfig, kubeconfigData.stdout, { mode: 0o600 });
        await chmod(kubeconfig, 0o600);
        await validateLoopbackKubeconfig(kubeconfig, resource.context, resource.kubectl);
      });
      await k3dStage(state, "k3d-nodes-ready", async () => {
        const kubectl = resource.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl";
        const kubectlArgs = ["--kubeconfig", kubeconfig, "--context", resource.context];
        // `wait nodes --all` covers only the nodes registered when it starts.
        await waitForK3dNodesRegistered(kubectl, kubectlArgs, resource.nodes);
        await execFile(kubectl, [
          ...kubectlArgs,
          "wait",
          "--for=condition=Ready",
          "nodes",
          "--all",
          "--timeout=120s",
        ]);
      });
      if (!openShell) {
        resource.kubernetesVersion = await k3dStage(state, "k3d-version", async () => {
          const version = await execFile(process.env.OCC_KUBECTL_BIN ?? "kubectl", [
            "--kubeconfig",
            kubeconfig,
            "--context",
            resource.context,
            "version",
            "-o",
            "json",
          ]);
          const parsed: unknown = JSON.parse(version.stdout);
          const gitVersion = asRecord(asRecord(parsed)?.serverVersion)?.gitVersion;
          if (typeof gitVersion !== "string" || !/^v1\.35\./.test(gitVersion)) {
            throw new Error("The ordinary k3d test cluster must resolve to Kubernetes 1.35.x.");
          }
          return gitVersion;
        });
      }
      if (crossNodePluginStatus) {
        resource.pluginStatusProxyCidrs = await k3dStage(state, "k3d-overlay", async () => {
          const podCidr = await waitForK3dNodePodCidr(
            state.lane,
            process.env.OCC_KUBECTL_BIN ?? "kubectl",
            ["--kubeconfig", kubeconfig, "--context", resource.context],
            `k3d-${cluster}-agent-0`,
          );
          const destination = podCidr.split("/")[0];
          if (destination === undefined || !isIPv4(destination)) {
            throw new Error("The plugin status worker must have an IPv4 Pod CIDR.");
          }
          return waitForPluginStatusProxySource(cluster, destination);
        });
        await logK3dHost(state, directory, "k3d-host-after");
      }
    } catch (error) {
      if (crossNodePluginStatus && !asRecord(error)?.k3dDiagnosticsCaptured) {
        await captureK3dDiagnostics({
          execFile,
          cluster: resource,
          lane: state.lane,
          statePath,
        }).catch(() => progress(state.lane, "k3d diagnostics unavailable"));
      }
      throw error;
    }
    // The fixture lanes mark the cluster ready when its storage rollout succeeds.
    if (!crossNodePluginStatus) {
      await markResourceReady(statePath, state, resource);
    }
    return resource;
  }

  const k3dNodeRegistrationTimeoutMs = 120_000;

  // Wait until every node this cluster owns is registered, so the Ready wait
  // cannot pass on the server alone while a worker is still joining. This is
  // hardening: in finding 1006 the worker was registered, and its containerd
  // stopped answering later.
  async function waitForK3dNodesRegistered(
    kubectl: string,
    kubectlArgs: string[],
    nodes: string[],
  ) {
    const deadline = performance.now() + k3dNodeRegistrationTimeoutMs;
    for (;;) {
      let missing = nodes;
      let lastError: unknown;
      try {
        const listed = await execFile(kubectl, [...kubectlArgs, "get", "nodes", "-o", "name"], {
          timeoutMs: 30_000,
        });
        const registered = new Set(listed.stdout.split(/\r?\n/).map((line) => line.trim()));
        missing = nodes.filter((node) => !registered.has(`node/${node}`));
        if (missing.length === 0) {
          return;
        }
      } catch (error) {
        lastError = error;
      }
      if (performance.now() >= deadline) {
        throw new Error(
          lastError
            ? `Unable to list k3d nodes within ${k3dNodeRegistrationTimeoutMs} ms: ${asRecord(lastError)?.message}`
            : `k3d node ${missing.join(", ")} did not register within ${k3dNodeRegistrationTimeoutMs} ms.`,
          { cause: lastError },
        );
      }
      await delay(1_000);
    }
  }

  // A Ready node can still lack its Pod CIDR: the node IPAM controller assigned
  // the worker's about 30 ms after the overlay stage read it (finding 1666).
  // Poll until spec.podCIDR is set; the caller still checks it is IPv4. The node
  // is already registered, so any read error is retried until the deadline.
  const k3dPodCidrWaitMs =
    Number(process.env.OPENCLAW_CI_K3D_POD_CIDR_WAIT_MS) > 0
      ? Number(process.env.OPENCLAW_CI_K3D_POD_CIDR_WAIT_MS)
      : 60_000;

  async function waitForK3dNodePodCidr(
    lane: string,
    kubectl: string,
    kubectlArgs: string[],
    node: string,
  ) {
    const deadline = performance.now() + k3dPodCidrWaitMs;
    for (let attempt = 1; ; attempt += 1) {
      let lastError: unknown;
      try {
        const listed = await execFile(
          kubectl,
          [...kubectlArgs, "get", "node", node, "-o", "json"],
          {
            timeoutMs: Math.max(1_000, Math.min(15_000, deadline - performance.now())),
          },
        );
        const parsed: unknown = JSON.parse(listed.stdout);
        const podCidr = asRecord(asRecord(parsed)?.spec)?.podCIDR;
        if (typeof podCidr === "string" && podCidr !== "") {
          return podCidr;
        }
      } catch (error) {
        lastError = error;
      }
      if (performance.now() >= deadline) {
        throw new Error(
          lastError
            ? `Unable to read k3d node ${node} within ${k3dPodCidrWaitMs} ms: ${asRecord(lastError)?.message}`
            : `k3d node ${node} got no Pod CIDR within ${k3dPodCidrWaitMs} ms.`,
          { cause: lastError },
        );
      }
      if (attempt === 1) {
        progress(lane, `waiting for ${node} to get its Pod CIDR`);
      }
      await delay(250);
    }
  }

  // Hosted CI creates a cluster, node image pull included, in 26-48 s (284 runs,
  // 2026-10-08: p50 27 s, p99 44 s). A create that never returns once held a lane
  // for 44 minutes until the job timeout (finding 840).
  // A hung first attempt once held a lane for its full five minutes before a 12 s
  // retry (finding 1174), so the first attempt gets two minutes, still well over
  // the p99, and the retry keeps five for a slow runner.
  // OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS sets both attempts.
  const k3dCreateTimeoutOverrideMs = Number(process.env.OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS);
  const k3dCreateTimeoutsMs: readonly [number, number] =
    k3dCreateTimeoutOverrideMs > 0
      ? [k3dCreateTimeoutOverrideMs, k3dCreateTimeoutOverrideMs]
      : [2 * 60_000, 5 * 60_000];
  const k3dCreateAttempts = k3dCreateTimeoutsMs.length;

  // Print k3d's own progress lines as they arrive. The job log timestamps each
  // line, so a slow create shows which k3d step it spent its time in.
  function forwardK3dOutput(lane: string, child: PreparationChild) {
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.on("data", (chunk: Buffer) => {
        const lines = (pending + chunk.toString()).split(/\r?\n/);
        pending = lines.pop() ?? "";
        lines.forEach(print);
      });
      stream.on("end", () => print(pending));
    }
    function print(line: string) {
      const text = line.replace(ANSI_COLOR, "").trimEnd();
      if (text.trim()) {
        progress(lane, `k3d: ${redactCredentialLine(text).slice(0, 400)}`);
      }
    }
  }

  // Bound each create. Ordinary lanes discard a timed-out attempt and retry.
  // Staged sign-in has no bound custody yet, so it retains the reservation and
  // requires reconciliation instead of deleting or reusing an uncertain name.
  async function createK3dCluster(
    statePath: string,
    state: PreparationState,
    resource: K3dCluster,
    args: string[],
  ) {
    const k3d = process.env.OPENCLAW_CI_K3D_BIN ?? "k3d";
    const attempts = state.lane === "staging-signin" ? 1 : k3dCreateAttempts;
    for (let attempt = 1; ; attempt += 1) {
      const timeoutMs = attempt === 1 ? k3dCreateTimeoutsMs[0] : k3dCreateTimeoutsMs[1];
      try {
        await k3dStage(state, "k3d-create", () =>
          execFile(k3d, args, {
            timeoutMs,
            processGroup: true,
            onSpawn: (child) => forwardK3dOutput(state.lane, child),
          }),
        );
        return;
      } catch (error) {
        const details = asRecord(error);
        if (details?.timedOut !== true) {
          throw error;
        }
        const summary =
          `k3d cluster create ${resource.name} did not finish within ${timeoutMs} ms ` +
          `(attempt ${attempt} of ${attempts})`;
        progress(state.lane, summary);
        await captureK3dDiagnostics({
          execFile,
          cluster: resource,
          lane: state.lane,
          statePath,
          failure: summary,
          k3dOutput: {
            ...(typeof details.stdout === "string" ? { stdout: details.stdout } : {}),
            ...(typeof details.stderr === "string" ? { stderr: details.stderr } : {}),
          },
        }).catch(() => progress(state.lane, "k3d diagnostics unavailable"));
        if (state.lane === "staging-signin") {
          // The receipt is not bound yet. A stopped local process cannot prove
          // that an accepted daemon operation settled or authorize name deletion.
          const failure = new Error(
            `${summary}; unconfirmed creation requires reconciliation; retained state at ${statePath}.`,
            { cause: error },
          );
          throw Object.assign(failure, { k3dDiagnosticsCaptured: true });
        }
        if (attempt >= k3dCreateAttempts) {
          const failure = new Error(
            `${summary}; giving up. Diagnostics are in ${statePath}.diagnostics.json, and ` +
              "cleanup removes the partial cluster.",
            { cause: error },
          );
          throw Object.assign(failure, { k3dDiagnosticsCaptured: true });
        }
        try {
          await k3dStage(state, "k3d-create-discard", () =>
            deleteOwnedK3dCluster(
              { name: resource.name },
              {
                execFile: (command, commandArgs) =>
                  execFile(command, commandArgs, { timeoutMs: 2 * 60_000 }),
              },
            ),
          );
        } catch (discardError) {
          // Keep the report that names the timeout; cleanup retries the deletion.
          if (!(discardError instanceof Error)) {
            throw discardError;
          }
          discardError.message = `${summary}; deleting the partial cluster failed: ${discardError.message}`;
          throw Object.assign(discardError, { k3dDiagnosticsCaptured: true });
        }
      }
    }
  }

  async function waitForPluginStatusProxySource(cluster: string, destination: string) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const route = await execFile(
        process.env.OCC_DOCKER_BIN ?? "docker",
        ["exec", `k3d-${cluster}-server-0`, "ip", "route", "get", destination],
        { timeoutMs: Math.min(15_000, deadline - Date.now()) },
      );
      // These owned clusters use K3s's default Flannel VXLAN backend. Node Ready
      // can precede its cross-node route; an earlier lookup uses eth0's default
      // route and would permanently admit the wrong source in NetworkPolicies.
      if (!/\bdev\s+flannel\.1(?:\s|$)/.test(route.stdout)) {
        await delay(500);
        continue;
      }
      const sources = [...route.stdout.matchAll(/\bsrc\s+(\S+)/g)].map((match) => match[1]);
      const [source] = sources;
      if (
        sources.length !== 1 ||
        source === undefined ||
        !isIPv4(source) ||
        source === "0.0.0.0" ||
        source.startsWith("127.")
      ) {
        throw new Error(
          "Unable to determine the cross-node plugin status proxy source IPv4 address.",
        );
      }
      return `${source}/32`;
    }
    throw new Error("Timed out waiting for the cross-node plugin status proxy route on flannel.1.");
  }

  async function validateLoopbackKubeconfig(
    kubeconfig: string,
    context: string,
    kubectl = process.env.OCC_KUBECTL_BIN ?? "kubectl",
  ) {
    const result = await execFile(kubectl, [
      "--kubeconfig",
      kubeconfig,
      "--context",
      context,
      "config",
      "view",
      "--minify",
      "--flatten",
      "-o",
      "json",
    ]);
    const configuration: unknown = JSON.parse(result.stdout);
    const clusters = asRecord(configuration)?.clusters;
    const first: unknown = Array.isArray(clusters) ? clusters[0] : undefined;
    const server = asRecord(asRecord(first)?.cluster)?.server;
    if (typeof server !== "string") {
      throw new TypeError("Invalid URL");
    }
    const endpoint = new URL(server);
    if (endpoint.protocol !== "https:") {
      throw new Error("k3d API server must use HTTPS.");
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
      throw new Error(`Refusing non-loopback Kubernetes API server: ${endpoint.hostname}`);
    }
    if (!endpoint.port || Number(endpoint.port) === 0) {
      throw new Error("k3d API server must expose an explicit loopback port.");
    }
  }

  return { ensureK3dCluster, k3dStage };
}
