import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSecureContext } from "node:tls";
import type { AgentAuditPage } from "../../../packages/contracts/src/index.ts";
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

export function createApi(origin: string, key: string) {
  return async (
    method: string,
    path: string,
    body?: unknown,
    options?: { response: "chat"; signal: AbortSignal; expectedStatus?: number },
  ) => {
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
        signal: options?.signal ?? AbortSignal.timeout(30_000),
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
    // The chat route returns native Chat Completions JSON. Keep its body out of failure logs.
    if (options?.response === "chat") {
      assert.equal(
        response.status,
        options.expectedStatus ?? 200,
        `${method} ${path}: chat failed`,
      );
      return envelope;
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
    uid: string;
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
    containerStatuses?: { name: string; containerID?: string; restartCount: number }[];
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
  browserOrigin?: string;
  platformNamespace: string;
}

export interface LocalSetup {
  directory: string;
  state: LocalSetupState;
  keyPath: string;
  kubeconfig: string;
  context: string;
  origin: string;
  api: ReturnType<typeof createApi>;
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

function localApiOrigin(port: number): string {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "Invalid Local Setup API port");
  const url = new URL("http://127.0.0.1");
  url.port = String(port);
  return url.origin;
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
  const origin = localApiOrigin(state.apiPort);
  const key: unknown = JSON.parse(await readFile(state.keyPath, "utf8"));
  return {
    directory,
    state,
    keyPath: state.keyPath,
    kubeconfig: join(directory, "kubeconfig"),
    context: `k3d-${state.cluster}`,
    origin,
    api: createApi(origin, wireField(wireField(key, "data"), "key") as string),
  };
}

export type KubernetesAccess = Pick<LocalSetup, "kubeconfig" | "context"> & {
  commandOptions?: Pick<RunOptions, "env" | "signal">;
};

export function kubectl(
  stack: KubernetesAccess,
  args: readonly string[],
  options: RunOptions = {},
) {
  return run("kubectl", ["--kubeconfig", stack.kubeconfig, "--context", stack.context, ...args], {
    timeout: 2 * minute,
    ...stack.commandOptions,
    ...options,
  });
}

export async function signInConsole(
  stack: Pick<LocalSetup, "directory" | "state">,
  credentials: { email: string; password: string },
): Promise<Api> {
  const { cookieHeaderFromSetCookie } = await import("../../../packages/utils/src/index.ts");
  assert.ok(stack.state.browserOrigin, "Local Setup did not record the Console origin");
  const origin = new URL(stack.state.browserOrigin);
  assert.equal(origin.protocol, "https:");
  assert.equal(origin.hostname, `console.${stack.state.cluster}.oce.localhost`);
  const agent = new HttpsAgent({
    secureContext: createSecureContext({
      ca: await readFile(join(stack.directory, "browser-ca.crt")),
    }),
  });
  const signIn = "/api/auth/sign-in/email";
  let cookie = "";
  const api: Api = (method, path, body) => {
    const url = new URL(path, origin);
    assert.equal(url.origin, origin.origin, "refusing to send credentials outside the Console");
    const content = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolveResponse, reject) => {
      // Use the real Console ingress and verify its hostname against the Local Setup CA.
      const request = httpsRequest(
        {
          hostname: "127.0.0.1",
          servername: origin.hostname,
          port: origin.port || 443,
          path: url.pathname + url.search,
          agent,
          rejectUnauthorized: true,
          method,
          headers: {
            host: origin.host,
            origin: origin.origin,
            ...(cookie === "" ? {} : { cookie }),
            ...(content === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(content),
                }),
          },
          signal: AbortSignal.timeout(30_000),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () => {
            const status = response.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              reject(new Error(`${method} ${url.pathname}: HTTP ${status}`));
              return;
            }
            if (path === signIn) {
              cookie = cookieHeaderFromSetCookie(response.headers["set-cookie"]);
              resolveResponse(undefined);
              return;
            }
            try {
              const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              resolveResponse(wireField(envelope, "data"));
            } catch {
              reject(new Error(`${method} ${url.pathname}: invalid JSON response`));
            }
          });
        },
      );
      request.once("error", reject);
      request.end(content);
    });
  };
  await api("POST", signIn, credentials);
  assert.ok(cookie.length > 0, "Console sign-in returned no session cookie");
  return api;
}

export async function setLocalSetupAudit(
  stack: Pick<LocalSetup, "directory" | "context" | "kubeconfig" | "state">,
  enabled: boolean,
  options?: RunOptions,
) {
  await run(
    "helm",
    [
      "upgrade",
      "openclaw-enterprise",
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      stack.state.platformNamespace,
      "--kubeconfig",
      stack.kubeconfig,
      "--kube-context",
      stack.context,
      "-f",
      join(stack.directory, "helm-values.json"),
      "--set",
      `controlPlaneAudit.enabled=${enabled}`,
      "--wait",
      "--timeout",
      "5m",
    ],
    { timeout: 6 * minute, ...options },
  );

  // Helm checks the Pod directly. Wait for the local proxy to reach the
  // replacement API through its Service before sending the next request.
  const ready = new URL("/readyz", localApiOrigin(stack.state.apiPort));
  await waitFor(
    "the local API after the audit setting changes",
    async () => {
      const timeout = AbortSignal.timeout(3000);
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const response = await fetch(ready, { redirect: "error", signal });
        await response.body?.cancel();
        return { done: response.status === 200, state: response.status };
      } catch {
        options?.signal?.throwIfAborted();
        return { done: false, state: "unreachable" };
      }
    },
    minute,
  );
}

type InstalledAuditStack = Pick<LocalSetup, "kubeconfig" | "context" | "state">;

async function queryAudit(
  stack: InstalledAuditStack,
  parameters: Record<string, string>,
  query: string,
  options?: RunOptions,
) {
  const { stdout } = await kubectl(
    stack,
    [
      "-n",
      stack.state.platformNamespace,
      "exec",
      "-i",
      "statefulset/postgres",
      "-c",
      "postgres",
      "--",
      "psql",
      "-X",
      "-q",
      "-t",
      "-A",
      "--set",
      "ON_ERROR_STOP=1",
      ...Object.entries(parameters).flatMap(([name, value]) => ["--set", `${name}=${value}`]),
      "--username",
      "postgres",
      "--dbname",
      "openclaw_enterprise",
    ],
    { ...options, input: query },
  );
  return stdout.trim();
}

function queryRevision(
  stack: InstalledAuditStack,
  revisionId: string,
  query: string,
  options?: RunOptions,
) {
  return queryAudit(stack, { revision_id: revisionId }, query, options);
}

export async function checkMessageDisclosure(
  stack: InstalledAuditStack,
  eventId: string,
  text: string,
  readMessage: (id: string) => Promise<unknown>,
) {
  const query = (sql: string) => queryAudit(stack, { event_id: eventId }, sql);
  const match = `action = 'openclaw.audit.agent.message.read' AND details->>'auditEventId' = :'event_id'`;
  // The receipt names the linked event. Neither its details nor its metadata may copy the text.
  const receipt = await query(`SELECT details FROM occ.audit_events WHERE ${match};`);
  assert.ok(!receipt.includes(text), "the disclosure receipt contains the chat message");
  const details = JSON.parse(receipt) as Record<string, unknown>;
  delete details.__occAuditMetadata;
  assert.deepEqual(details, { auditEventId: eventId });
  // Refuse only this message's next receipt. Fail closed despite valid grants and history.
  const constraint = `smoke_disclosure_${randomUUID().replaceAll("-", "")}`;
  await query(
    `ALTER TABLE occ.audit_events ADD CONSTRAINT ${constraint} CHECK (NOT (${match})) NOT VALID;`,
  );
  try {
    await assert.rejects(readMessage(eventId), /HTTP 503$/);
  } finally {
    await query(`ALTER TABLE occ.audit_events DROP CONSTRAINT ${constraint};`);
  }
}

const runtimeRows = `FROM occ.audit_events
  WHERE kind = 'runtime_activity' AND details->>'agentRevisionId' = :'revision_id'`;

export async function withRefusedTurnWrite<T>(
  stack: InstalledAuditStack & KubernetesAccess,
  revisionId: string,
  phase: "started" | "admitted",
  send: () => Promise<T>,
  restart?: () => Promise<void>,
) {
  const marker = `smoke_audit_${randomUUID().replaceAll("-", "")}`;
  const action = `openclaw.runtime.turn.${phase}`;
  const query = (sql: string, options?: RunOptions) =>
    queryAudit(stack, { revision_id: revisionId, action }, sql, options);
  // PostgreSQL logs the event ID even when the transaction fails. The restart
  // test uses it to identify a second delivery of the same event.
  const pattern = new RegExp(`${marker} (aud_[a-f0-9-]{36})`);
  try {
    await query(`
      BEGIN;
      CREATE FUNCTION occ.${marker}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION '% %', TG_NAME, NEW.id; END;
      $$;
      CREATE TRIGGER ${marker} BEFORE INSERT ON occ.audit_events FOR EACH ROW
        WHEN (NEW.kind = 'runtime_activity'
          AND NEW.details->>'agentRevisionId' = :'revision_id'
          AND NEW.action = :'action')
        EXECUTE FUNCTION occ.${marker}();
      COMMIT;
    `);
    const turn = await send();
    const refusedId = await waitFor(
      `PostgreSQL to refuse ${action} on ${revisionId}`,
      async () => {
        const { stdout } = await kubectl(stack, [
          "logs",
          "-n",
          stack.state.platformNamespace,
          "statefulset/postgres",
          "-c",
          "postgres",
          "--since=2m",
        ]);
        const id = pattern.exec(stdout)?.[1];
        return { done: id !== undefined, value: id };
      },
      minute,
    );
    assert.ok(refusedId);
    await restart?.();
    return { turn, refusedId };
  } finally {
    // Remove the trigger even if the test canceled the request.
    await query(
      `
      BEGIN;
      DROP TRIGGER IF EXISTS ${marker} ON occ.audit_events;
      DROP FUNCTION IF EXISTS occ.${marker}();
      COMMIT;
    `,
      { signal: undefined },
    );
  }
}

export async function expectPersistedRuntimeAudit(
  stack: InstalledAuditStack,
  revisionId: string,
  page: AgentAuditPage,
  options?: RunOptions,
) {
  const events = page.events.filter(
    (event) => event.event === "runtime_activity" && event.details.agentRevisionId === revisionId,
  );
  assert.ok(events.length > 0, `The audit API returned no runtime events for ${revisionId}.`);
  // Read from the installed database after the API read. Later arrivals can add rows.
  const rows = await queryRevision(stack, revisionId, `SELECT id ${runtimeRows};`, options);
  const persisted = new Set(rows.split("\n"));
  for (const { id } of events) {
    assert.ok(persisted.has(id), `PostgreSQL has no runtime event ${id} for ${revisionId}.`);
  }
}

export async function expectNoRuntimeAuditGrant(stack: InstalledAuditStack, revisionId: string) {
  const count = await queryRevision(
    stack,
    revisionId,
    "SELECT count(*) FROM occ.gateway_runtime_audit_grants WHERE revision_id = :'revision_id';",
  );
  assert.equal(count, "0", `The stopped revision ${revisionId} still has an audit credential.`);
}

export async function expectNoRuntimeAuditRows(stack: LocalSetup, revisionId: string) {
  const count = await queryRevision(stack, revisionId, `SELECT count(*) ${runtimeRows};`);
  assert.equal(count, "0", "the disabled audit switch allowed a runtime write");
}

export async function apiProcess(
  stack: Pick<LocalSetup, "kubeconfig" | "context" | "state">,
  options?: RunOptions,
) {
  const { stdout } = await kubectl(
    stack,
    [
      "-n",
      stack.state.platformNamespace,
      "get",
      "pods",
      "-l",
      "app.kubernetes.io/instance=openclaw-enterprise,app.kubernetes.io/component=api",
      "-o",
      "json",
    ],
    options,
  );
  const ready = podList(stdout).filter(
    (pod) =>
      !pod.metadata.deletionTimestamp &&
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
  );
  assert.equal(ready.length, 1, "the chart must have one ready API Pod");
  const api = ready[0]!;
  const container = api.status?.containerStatuses?.find(({ name }) => name === "api");
  assert.ok(api.metadata.uid && container?.containerID, "the API Pod must identify its process");
  return {
    podUid: api.metadata.uid,
    containerId: container.containerID,
    restartCount: container.restartCount,
  };
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
    auditFailures = false,
  }: {
    journey?: string;
    cleanup?: (() => Promise<unknown>)[];
    credentialDigests?: Record<string, string>;
    auditFailures?: boolean;
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
    ...(auditFailures ? ["--env", "PROBE_CODEX_AUDIT_FAILURES=1"] : []),
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
