import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configureModelProviderDNS } from "../../../tests/helpers/runtime-model-provider.mjs";
import {
  minute,
  modelAddress,
  modelContainer,
  modelNetwork,
  nodeModelAddress,
  noncePattern,
  occ,
  run,
  slotNames,
  waitFor,
  workDirectory,
  type RunOptions,
} from "./process.ts";

type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

export function createApi(origin: string, key: string): Api {
  return async (method, path, body) => {
    const url = new URL(path, origin);
    assert.equal(
      url.origin,
      origin,
      "refusing to send the smoke key outside the controller origin",
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "x-api-key": key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const failure = error as Error & { cause?: NodeJS.ErrnoException };
      const cause = failure.cause ? `: ${failure.cause.code ?? ""} ${failure.cause.message}` : "";
      throw new Error(`${method} ${path}: ${failure.message}${cause}`, { cause: error });
    }
    const text = await response.text();
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path}: HTTP ${response.status} without JSON`);
    }
    if (!response.ok) {
      throw new Error(
        `${method} ${path}: HTTP ${response.status} ${JSON.stringify(wireField(envelope, "error"))}`,
      );
    }
    return wireField(envelope, "data");
  };
}

// Use JavaScript property access at the wire boundary. Missing fields stay
// undefined, null field values stay null, and invalid receivers fail where read.
export function wireField(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

export const clusterName = slotNames.cluster;
const watchLog = join(workDirectory, "cluster-watch.log");

// `occ dev up` deletes its cluster when a step fails, so record what the
// cluster looked like while it was being installed. On success, stop and reap
// any optional capture. On failure, preserve its output and take a final snapshot.
export function watchCluster({ directory = workDirectory, intervalMs = 30_000 } = {}) {
  const kubeconfig = join(directory, "watch-kubeconfig");
  const captureLog = join(directory, "cluster-watch.log");
  const wake = new AbortController();
  const stopCapture = new AbortController();
  let finalCapture = false;
  const capture = async (signal?: AbortSignal) => {
    const runCapture = (command: string, args: string[], options?: RunOptions) =>
      run(command, args, { ...options, signal });
    const record = async (label: string, command: string, args: string[]) => {
      try {
        const { stdout } = await runCapture(command, args, { timeout: minute });
        await appendFile(captureLog, `----- ${new Date().toISOString()} ${label}\n${stdout}\n`);
      } catch (error) {
        if (!signal?.aborted) {
          await appendFile(
            captureLog,
            `----- ${label} unavailable: ${(error as Error).message.slice(0, 300)}\n`,
          );
        }
      }
    };
    try {
      const { stdout } = await runCapture("k3d", ["kubeconfig", "get", clusterName], {
        timeout: minute,
      });
      await writeFile(kubeconfig, stdout, { mode: 0o600 });
    } catch {
      return;
    }
    const k = ["--kubeconfig", kubeconfig];
    await record("pods", "kubectl", [...k, "get", "pods", "-A", "-o", "wide"]);
    await record("warning events", "kubectl", [
      ...k,
      "get",
      "events",
      "-A",
      "--field-selector",
      "type!=Normal",
    ]);
    await record("node conditions", "kubectl", [
      ...k,
      "get",
      "nodes",
      "-o",
      'jsonpath={range .items[*].status.conditions[*]}{.type}={.status} {.message}{"\\n"}{end}{.items[*].spec.taints}',
    ]);
    try {
      const { stdout } = await runCapture("kubectl", [...k, "get", "pods", "-A", "-o", "json"]);
      for (const pod of podList(stdout)) {
        const ready = pod.status?.conditions?.some(
          ({ type, status }) => type === "Ready" && status === "True",
        );
        const age = Date.now() - Date.parse(pod.metadata.creationTimestamp);
        if (!ready && pod.status?.phase !== "Succeeded" && age > 90_000) {
          await record(`describe ${pod.metadata.namespace}/${pod.metadata.name}`, "kubectl", [
            ...k,
            "-n",
            pod.metadata.namespace,
            "describe",
            "pod",
            pod.metadata.name,
          ]);
          await record(`logs ${pod.metadata.namespace}/${pod.metadata.name}`, "kubectl", [
            ...k,
            "-n",
            pod.metadata.namespace,
            "logs",
            pod.metadata.name,
            "--all-containers",
            "--tail",
            "40",
          ]);
        }
      }
    } catch {
      // The cluster may be going away.
    }
  };
  const loop = (async () => {
    while (!wake.signal.aborted) {
      try {
        await delay(intervalMs, undefined, { signal: wake.signal });
      } catch {
        break;
      }
      await capture(stopCapture.signal);
    }
    if (finalCapture) {
      await capture();
    }
  })();
  return async ({ finalCapture: final = false } = {}) => {
    finalCapture = final;
    wake.abort();
    if (!final) {
      stopCapture.abort();
    }
    await loop;
  };
}

async function printWatchLog() {
  try {
    const text = await readFile(watchLog, "utf8");
    process.stdout.write(`----- cluster watch (last 60000 bytes)\n${text.slice(-60_000)}\n`);
  } catch {
    process.stdout.write("----- cluster watch: nothing recorded\n");
  }
}

// Fields read from Kubernetes core/v1 Pod JSON. The same listing feeds the
// setup watcher and Agent workload checks.
export interface Pod {
  metadata: {
    namespace: string;
    name: string;
    creationTimestamp: string;
    deletionTimestamp?: string | null;
    labels?: Record<string, string>;
  };
  spec?: {
    volumes?: { configMap?: { name?: string } }[];
  };
  status?: {
    phase?: string;
    conditions?: { type: string; status: string }[];
  };
}

export function podList(stdout: string): Pod[] {
  const list: unknown = JSON.parse(stdout);
  // kubectl serializes the core/v1 PodList. Retain the original item objects
  // and let each observation consume its own fields.
  return wireField(list, "items") as Pod[];
}

// Projection of the state emitted by occ dev up for its Kubernetes preset.
interface LocalSetupState {
  keyPath: string;
  cluster: string;
  apiPort: number;
  platformNamespace: string;
}

export interface LocalSetup {
  directory: string;
  state: LocalSetupState;
  keyPath: string;
  kubeconfig: string;
  context: string;
  origin: string;
  api: Api;
}

export interface SmokeAgent {
  label: string;
  id: string;
  stoppedGatewayLogs?: string[];
}

export interface SmokeStack extends LocalSetup {
  agents: SmokeAgent[];
  namespaceId: string;
}

export async function startLocalSetup(
  environment: NodeJS.ProcessEnv & { OCC_DEVELOPMENT_STATE_DIRECTORY: string },
  { privateInstall = false } = {},
): Promise<LocalSetup> {
  if (privateInstall) {
    // Private acceptance retains only named stages, never installation or cluster logs.
    await run(occ, ["dev", "up"], { env: environment, timeout: 30 * minute });
  } else {
    const stopWatching = watchCluster();
    try {
      await run(occ, ["dev", "up"], { env: environment, timeout: 25 * minute, label: "dev-up" });
    } catch (error) {
      try {
        await stopWatching({ finalCapture: true });
      } catch {
        // Watcher diagnostics are supplemental to the installation failure.
      }
      await printWatchLog();
      throw error;
    }
    await stopWatching();
  }
  const directory = environment.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const storedState: unknown = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  const state = storedState as LocalSetupState;
  const key: unknown = JSON.parse(await readFile(state.keyPath, "utf8"));
  return {
    directory,
    state,
    keyPath: state.keyPath,
    kubeconfig: join(directory, "kubeconfig"),
    context: `k3d-${state.cluster}`,
    origin: `http://127.0.0.1:${state.apiPort}`,
    api: createApi(
      `http://127.0.0.1:${state.apiPort}`,
      wireField(wireField(key, "data"), "key") as string,
    ),
  };
}

export function kubectl(
  stack: Pick<LocalSetup, "kubeconfig" | "context">,
  args: readonly string[],
  options: RunOptions = {},
) {
  return run("kubectl", ["--kubeconfig", stack.kubeconfig, "--context", stack.context, ...args], {
    timeout: 2 * minute,
    ...options,
  });
}

// Answer api.openai.com inside the cluster with the stand-in provider. Agent
// Pods reach it through their ordinary model egress NetworkPolicy and verify
// its certificate against the CA added to the runtime image. `providerImage`
// runs it: the runtime image, or the smoke's provider image (Node and `ws`).
export async function routeModelProvider(
  stack: LocalSetup,
  modelDirectory: string | undefined,
  providerImage: string | undefined,
  {
    journey = "PROBE_PUBLIC_READ_JOURNEY",
    cleanup = [],
    credentialDigests,
  }: {
    journey?: string;
    cleanup?: (() => Promise<unknown>)[];
    credentialDigests?: Record<string, string>;
  } = {},
) {
  await run("docker", ["network", "create", "--subnet", modelNetwork.subnet, modelNetwork.name]);
  cleanup.push(() => run("docker", ["network", "rm", modelNetwork.name]));
  // Fixed addresses: Docker would otherwise give the node the provider's address.
  await run("docker", [
    "network",
    "connect",
    "--ip",
    nodeModelAddress,
    modelNetwork.name,
    `k3d-${stack.state.cluster}-server-0`,
  ]);
  cleanup.push(() =>
    run("docker", [
      "network",
      "disconnect",
      modelNetwork.name,
      `k3d-${stack.state.cluster}-server-0`,
    ]),
  );
  const providerArgs = [
    "run",
    "--detach",
    "--name",
    modelContainer,
    "--network",
    modelNetwork.name,
    "--ip",
    modelAddress,
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
    "--volume",
    `${modelDirectory}:/fixture:ro`,
    "--env",
    "PROBE_ENDPOINT_MODE=answer",
    "--env",
    "PROBE_ENDPOINT_HOST=0.0.0.0",
    "--env",
    `PROBE_ENDPOINT_ECHO_PATTERN=${noncePattern}`,
    "--env",
    `${journey}=1`,
    // With digests, the stand-in answers only these credentials and names each caller.
    ...(credentialDigests === undefined ? [] : ["--env", "PROBE_ENDPOINT_CREDENTIAL_DIGESTS"]),
    "--entrypoint",
    "node",
    providerImage as string,
    "/fixture/endpoint.mjs",
  ];
  const { stdout: containerId } = await run("docker", providerArgs, {
    env: {
      ...process.env,
      ...(credentialDigests === undefined
        ? {}
        : { PROBE_ENDPOINT_CREDENTIAL_DIGESTS: JSON.stringify(credentialDigests) }),
    },
  });
  cleanup.push(() => run("docker", ["rm", "--force", containerId.trim()]));
  await waitFor(
    "the stand-in provider to listen",
    async () => ({ done: (await modelEvents()).some(({ event }) => event === "listening") }),
    minute,
  );
  await configureModelProviderDNS({
    kubectl: (args: string[], options?: RunOptions) => kubectl(stack, args, options),
    waitFor,
    modelAddress,
    platformNamespace: stack.state.platformNamespace,
    serverFile: "oce-first-agent-smoke.server",
  });
}

interface ModelEvent {
  event?: string;
  status?: number;
  text?: string;
  caller?: string;
  transport?: string;
}

export async function modelEvents(): Promise<ModelEvent[]> {
  const { stdout } = await run("docker", ["logs", modelContainer]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      const event: unknown = JSON.parse(line);
      return event as ModelEvent;
    });
}
