import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { KubernetesComputeDriverOptions } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { KubernetesAuthentication } from "../../apps/controller/src/drivers/kubernetes/authentication.ts";
import type { HarnessAuthSnapshot } from "../../packages/contracts/src/index.ts";
import { asRecord, sha256Hex } from "../../packages/utils/src/index.ts";
import { followContainerLog } from "./container-log-capture.ts";
import { createInstallationDriverConfiguration } from "./installation-driver-configuration.mjs";
import { kubectlGetJson } from "./kubernetes-api-read.ts";
import { waitForResult } from "./wait-for.mjs";

const execute = promisify(execFile);

type Selection = Parameters<typeof kubectlGetJson>[0];
type Kubectl = (...args: string[]) => Promise<string>;
type KubectlArguments = (args: readonly string[]) => string[];
type DeadlineSleep = (
  ms: number,
  value: undefined,
  options: { signal: AbortSignal },
) => Promise<unknown>;

type RetryOptions = {
  attempts?: number;
  firstDelayMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  log?: (message: string) => void;
};

type DiagnosticOptions = {
  timeoutMs?: number;
  sleep?: DeadlineSleep | undefined;
};

type ManifestOptions = { redactions?: readonly (string | undefined | null)[] };

export function kubectlArguments(
  { kubeconfigPath, kubernetesContext }: Selection,
  args: readonly string[],
) {
  // Selection is optional while wiring the fixture. Commands use the selected kubeconfig and context.
  return ["--kubeconfig", kubeconfigPath!, "--context", kubernetesContext!, ...args];
}

function commandError(error: unknown): {
  name?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  message?: unknown;
  code?: unknown;
} {
  return (typeof error === "object" && error !== null) || typeof error === "function" ? error : {};
}

// The deadline signal of the failure diagnostic running in this async context, if any.
const diagnosticDeadline = new AsyncLocalStorage<AbortSignal>();

// Whether the failure diagnostic this code runs in has passed its deadline, so it should
// write nothing more.
export function diagnosticDeadlinePassed() {
  return diagnosticDeadline.getStore()?.aborted === true;
}

async function kubectlFor(
  selection: Selection,
  args: readonly string[],
  options?: ExecFileOptions,
) {
  // Inside a failure diagnostic, kubectl stops at its deadline (finding 1557).
  const signal = diagnosticDeadline.getStore();
  signal?.throwIfAborted();
  const answered = await kubectlGetJson(selection, args, { signal });
  if (answered !== undefined) {
    return answered;
  }
  const { stdout } = await execute("kubectl", kubectlArguments(selection, args), {
    maxBuffer: 4 * 1024 * 1024,
    ...options,
    encoding: "utf8",
    signal,
  });
  return stdout;
}

// kubectl reports a dropped API server or kubelet stream on stderr: an exec
// WebSocket that closed mid-stream ("error: EOF"), an API request whose
// connection closed before the reply ('Post "https://...": EOF'), a reset or
// refused connection, or a kubelet tunnel that could not be dialed. A remote
// command that ran and failed ends with "command terminated with exit code N";
// that is the command's own result and is never retried.
const transientKubectlFailure =
  /^error: EOF$|"https?:\/\/[^"\s]+": EOF$|Unable to connect to the server|error dialing backend|websocket: close|unexpected EOF|connection reset by peer|connection refused|http2: client connection lost|TLS handshake timeout|i\/o timeout|the server is currently unable to handle the request|etcdserver: request timed out/m;

export function isTransientKubectlFailure(error: unknown) {
  const { name, stderr = "" } = commandError(error);
  // A read a diagnostic deadline stopped is not retried, whatever kubectl wrote first.
  if (name === "AbortError") {
    return false;
  }
  // A spawn failure (ENOENT, EACCES) has empty stderr: kubectl never ran.
  const output = String(stderr ?? "");
  return !/command terminated with exit code/.test(output) && transientKubectlFailure.test(output);
}

// Retries a kubectl command that changes nothing in the cluster or in the
// container (a get, or an exec that only reads) when the transport dropped.
// Any other failure, and the last transient one, is thrown unchanged.
export async function retryKubectlRead<Result>(
  read: () => Result | PromiseLike<Result>,
  {
    attempts = 4,
    firstDelayMs = 500,
    sleep = delay,
    log = (message) => process.stderr.write(`${message}\n`),
  }: RetryOptions = {},
): Promise<Result> {
  let delayMs = firstDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= attempts || !isTransientKubectlFailure(error)) {
        throw error;
      }
      const reason = String(commandError(error).stderr).trim().split("\n").at(-1);
      log(
        `Transient kubectl failure (${reason}); retrying in ${delayMs} ms (attempt ${attempt + 1}/${attempts})`,
      );
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}

// A failure diagnostic must not hide the failure it explains (finding 1550): a stalled API
// server or log stream would hold it until the test's own timeout. Its kubectl reads pass
// diagnosticRequestTimeout, and the whole diagnostic races diagnosticDeadlineMs; past the
// deadline the caller gets `timedOut` in place of the diagnostic and reports its failure.
export const diagnosticRequestTimeout = "--request-timeout=20s";
export const diagnosticDeadlineMs = 60_000;

// Runs `diagnostic(signal)` within the deadline. At the deadline the signal aborts: a kubectl
// read it started is killed and a later one refused, so no read outlives the deadline or keeps
// the test process alive, and the diagnostic checks diagnosticDeadlinePassed() before it
// writes (finding 1557). A diagnostic nested in another one also stops at the outer deadline.
export function withinDiagnosticDeadline<Result, Timeout>(
  diagnostic: (signal: AbortSignal) => Result | PromiseLike<Result>,
  options: DiagnosticOptions & { timedOut: Timeout },
): Promise<Awaited<Result> | Awaited<Timeout>>;
export function withinDiagnosticDeadline<Result>(
  diagnostic: (signal: AbortSignal) => Result | PromiseLike<Result>,
  options?: DiagnosticOptions,
): Promise<Awaited<Result> | string>;
export async function withinDiagnosticDeadline<Result, Timeout>(
  diagnostic: (signal: AbortSignal) => Result | PromiseLike<Result>,
  {
    timeoutMs = diagnosticDeadlineMs,
    timedOut = "Diagnostic timed out",
    sleep = delay,
  }: DiagnosticOptions & { timedOut?: Timeout | string } = {},
) {
  const deadline = new AbortController();
  const outer = diagnosticDeadline.getStore();
  const signal = outer === undefined ? deadline.signal : AbortSignal.any([outer, deadline.signal]);
  const timer = new AbortController();
  try {
    return await Promise.race([
      diagnosticDeadline.run(signal, () => diagnostic(signal)),
      sleep(timeoutMs, undefined, { signal: timer.signal }).then(() => {
        deadline.abort();
        return timedOut;
      }),
    ]);
  } finally {
    // Stops the timer once the diagnostic settles, so it does not hold the event loop.
    timer.abort();
  }
}

// Controller startup can fail before any Compute-managed Agent Pod exists. Capture
// that exact fixture namespace before teardown; the Agent watch cannot observe it.
export async function waitForDeploymentAvailable(
  context: TestContext,
  selection: Selection,
  {
    namespace,
    deployment,
    container,
    labels,
  }: {
    namespace: string;
    deployment: string;
    container: string;
    labels: Readonly<Record<string, string>>;
  },
) {
  const scope = ["--namespace", namespace];
  const log = followContainerLog({
    args: kubectlArguments(selection, [
      "logs",
      ...scope,
      `deployment/${deployment}`,
      "--container",
      container,
      "--follow=true",
      "--timestamps=true",
      "--tail=1500",
      "--pod-running-timeout=180s",
    ]),
    env: process.env,
    target: { namespace, container },
    recoverLogs: () =>
      withinDiagnosticDeadline(
        () =>
          kubectlFor(selection, [
            "logs",
            ...scope,
            `deployment/${deployment}`,
            "--container",
            container,
            "--timestamps=true",
            "--tail=1500",
            "--pod-running-timeout=5s",
            diagnosticRequestTimeout,
          ]),
        { timeoutMs: 20_000, timedOut: "" },
      ),
    snapshot: async () => {
      const read = (resource: string, extra: readonly string[] = []) =>
        withinDiagnosticDeadline(
          async () => {
            const value: unknown = JSON.parse(
              await kubectlFor(selection, [
                "get",
                resource,
                ...scope,
                ...extra,
                "-o",
                "json",
                diagnosticRequestTimeout,
              ]),
            );
            return resourceItems(value);
          },
          { timeoutMs: 20_000, timedOut: null },
        ).catch(() => null);
      const [pods, events] = await Promise.all([
        read("pods", [
          "-l",
          Object.entries(labels)
            .map(([key, value]) => `${key}=${value}`)
            .join(","),
        ]),
        read("events"),
      ]);
      return {
        pods: pods ?? [],
        events: events ?? [],
        unavailable: pods === null || events === null,
      };
    },
  });
  try {
    return await log.attachOnFailure(
      context,
      `deployment/${deployment} readiness`,
      () =>
        kubectlFor(selection, [
          "wait",
          ...scope,
          "--for=condition=Available",
          `deployment/${deployment}`,
          "--timeout=180s",
        ]),
      { waitForExitMs: 0 },
    );
  } finally {
    await log.stop();
  }
}

// Deletes a Namespace and waits for it. A delete that fails (a finalizer holding the Namespace
// past the timeout, say) says before it fails what holds it (finding 2018): the Namespace's
// phase, finalizers and status conditions, and every object still in it with its finalizers and
// deletion time. The listing runs within the diagnostic deadline and only adds to the delete's
// own error; past the deadline it keeps what it read (finding 2028).
export async function deleteNamespaceExplained(
  kubectl: Kubectl,
  namespace: string,
  // The listing's own bound keeps the delete and the listing within teardownStepLimitMs, so the
  // teardown never abandons the step and loses the listing with it. `sleep` stands in for the
  // deadline's timer (withinDiagnosticDeadline's), so a test can hold it.
  {
    timeout = "120s",
    listTimeoutMs = 40_000,
    sleep,
  }: {
    timeout?: string;
    listTimeoutMs?: number;
    sleep?: DeadlineSleep;
  } = {},
) {
  try {
    return await kubectl(
      "delete",
      "namespace",
      namespace,
      "--ignore-not-found=true",
      "--wait=true",
      `--timeout=${timeout}`,
    );
  } catch (error) {
    const read: string[] = [];
    const timedOut = Symbol("listing timed out");
    const remains = await withinDiagnosticDeadline<string, typeof timedOut>(
      () => describeNamespaceRemains(kubectl, namespace, read),
      { timeoutMs: listTimeoutMs, timedOut, sleep },
    ).then(
      (listed) =>
        listed === timedOut ? [...read, "listing what remains timed out"].join("\n  ") : listed,
      (listError: unknown) =>
        `listing what remains failed: ${String(commandError(listError).message ?? listError)}`,
    );
    const failure = commandError(error);
    if (failure === error) {
      failure.message = `${String(failure.message)}\nNamespace ${namespace} remains: ${remains}`;
    }
    throw error;
  }
}

// Objects a failed Namespace delete lists, at most; the rest are counted.
const namespaceRemainsLimit = 40;
// Only object metadata is printed, never a Secret's or ConfigMap's data.
const namespaceRemainsTemplate =
  '{range .items[*]}{.kind}/{.metadata.name} finalizers={.metadata.finalizers} deleting={.metadata.deletionTimestamp}{"\\n"}{end}';

// A kubectl read that printed what it could before failing (one unavailable aggregated API fails
// discovery and a multi-kind get, but kubectl still prints the rest): its stdout, and its error's
// first stderr line in `lines`.
async function partialKubectlRead(
  kubectl: Kubectl,
  args: readonly string[],
  lines: string[],
  what: string,
) {
  try {
    return { output: await kubectl(...args), complete: true };
  } catch (error) {
    // A read the deadline stopped is not a failed read: the listing reports its timeout instead,
    // and a line pushed here could race into that report.
    const { name, stderr, message, stdout } = commandError(error);
    if (name === "AbortError" || diagnosticDeadlinePassed()) {
      throw error;
    }
    const reason = String(stderr || message || error)
      .trim()
      .split("\n", 1)[0]
      ?.slice(0, 300);
    lines.push(`${what} failed: ${reason}`);
    return { output: String(stdout ?? ""), complete: false };
  }
}

// Pushes each line to `lines` as it is read, so a listing cut short by its deadline keeps them.
async function describeNamespaceRemains(kubectl: Kubectl, namespace: string, lines: string[]) {
  let state: unknown;
  try {
    state = JSON.parse(
      await kubectl("get", "namespace", namespace, "-o", "json", diagnosticRequestTimeout),
    );
  } catch (error) {
    if (/\(NotFound\)/.test(String(commandError(error).stderr ?? ""))) {
      return "none (the Namespace is gone)";
    }
    throw error;
  }
  const namespaceState = asRecord(state);
  const status = asRecord(namespaceState?.status);
  const finalizers = asRecord(namespaceState?.spec)?.finalizers;
  const conditions: unknown[] = Array.isArray(status?.conditions) ? status.conditions : [];
  lines.push(
    `phase ${status?.phase ?? "unknown"}, finalizers [${Array.isArray(finalizers) ? finalizers.join(", ") : ""}]`,
    ...conditions.map((value) => {
      const condition = asRecord(value);
      return `condition ${condition?.type}=${condition?.status} ${condition?.reason ?? ""}: ${condition?.message ?? ""}`;
    }),
  );
  const discovery = await partialKubectlRead(
    kubectl,
    ["api-resources", "--namespaced=true", "--verbs=list", "-o", "name", diagnosticRequestTimeout],
    lines,
    "listing kinds",
  );
  const kinds = discovery.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // Events describe the delete, they don't hold it.
    .filter((kind) => !/^events(\.events\.k8s\.io)?$/.test(kind));
  if (kinds.length === 0) {
    return lines.join("\n  ");
  }
  const listed = await partialKubectlRead(
    kubectl,
    [
      "get",
      kinds.join(","),
      "--namespace",
      namespace,
      "--ignore-not-found=true",
      "-o",
      `jsonpath=${namespaceRemainsTemplate}`,
      diagnosticRequestTimeout,
    ],
    lines,
    "listing objects",
  );
  const objects = listed.output
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/ finalizers=(?= |$)/, "")
        .replace(/ deleting=$/, ""),
    )
    .filter(Boolean);
  lines.push(...objects.slice(0, namespaceRemainsLimit));
  if (objects.length > namespaceRemainsLimit) {
    lines.push(`and ${objects.length - namespaceRemainsLimit} more objects`);
  }
  if (objects.length === 0 && discovery.complete && listed.complete) {
    lines.push("no objects left in it");
  }
  return lines.join("\n  ");
}

const alreadyCreated = /^Error from server \(AlreadyExists\): /m;

// A second delete of a Namespace that the dropped attempt already started removing.
export const namespaceAlreadyTerminating =
  /^Error from server \(Conflict\): .*The system is ensuring all content is removed from this namespace/m;

// Retries a kubectl write whose transport dropped. The dropped attempt may or
// may not have been applied, so only writes that converge when repeated belong
// here: label and annotate with --overwrite, apply, delete with
// --ignore-not-found, and create. After a dropped attempt, an error matching
// `applied` (by default AlreadyExists, for a create) means that attempt was
// applied; before one it is thrown. That assumes nobody else writes the same
// object, so use it only for names the test owns.
export async function retryKubectlWrite<Result>(
  write: () => Result | PromiseLike<Result>,
  { applied = alreadyCreated, ...options }: RetryOptions & { applied?: RegExp } = {},
): Promise<Result | ""> {
  let dropped = false;
  return retryKubectlRead(async () => {
    try {
      return await write();
    } catch (error) {
      if (dropped && applied.test(String(commandError(error).stderr ?? ""))) {
        return "";
      }
      dropped ||= isTransientKubectlFailure(error);
      throw error;
    }
  }, options);
}

// tests/fixtures/kubernetes/probe.mts exits with this code, and prints
// {"denied":true,"code":...} on stdout, only when its connection attempt was
// refused, unreachable, or unanswered. Any other probe failure exits 1.
export const PROBE_DENIED_EXIT_CODE = 42;

// Returns the probe's denial report when kubectl exec ran the probe and the
// probe itself reported a denial, otherwise undefined. A dropped exec stream, a
// missing or crashing probe script, and a DNS or argument error are not denials.
function isProbeDenial(
  report: Record<string, unknown> | undefined,
): report is Record<string, unknown> & { denied: true; code: string } {
  return report?.denied === true && typeof report.code === "string";
}

export function probeDenial(error: unknown) {
  const { code, stderr, stdout } = commandError(error);
  if (
    code !== PROBE_DENIED_EXIT_CODE ||
    !String(stderr ?? "").includes(`command terminated with exit code ${PROBE_DENIED_EXIT_CODE}`)
  ) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(
      String(stdout ?? "")
        .trim()
        .split("\n")
        .at(-1) ?? "",
    );
    const report = asRecord(value);
    return isProbeDenial(report) ? report : undefined;
  } catch {
    return undefined;
  }
}

// Runs a probe exec that is expected to be blocked. Transport drops are
// retried like any read; the check passes only on the probe's own denial.
export async function assertProbeDenied(
  description: string,
  run: () => Promise<string>,
  options?: RetryOptions,
) {
  let stdout: string;
  try {
    stdout = await retryKubectlRead(run, options);
  } catch (error) {
    const denial = probeDenial(error);
    if (denial !== undefined) {
      return denial;
    }
    const { code, stderr, message } = commandError(error);
    const detail = String(stderr ?? "").trim() || message;
    throw new Error(`${description}: the probe did not report a denial (exit ${code}): ${detail}`, {
      cause: error,
    });
  }
  assert.fail(`${description} unexpectedly succeeded: ${String(stdout).trim()}`);
}

// Strip the authored probe for containers that do not mount the fixture
// (a Gateway container, the DNS fixture Pods).
// "probe.mjs" fills process.argv[1], so the probe still reads its own arguments
// from process.argv.slice(2).
export function inlineProbeCommand(source: string, ...probeArguments: unknown[]) {
  return [
    "node",
    "--input-type=module",
    "-e",
    stripTypeScriptTypes(source),
    "probe.mjs",
    ...probeArguments.map(String),
  ];
}

function resourceItems(value: unknown): unknown[] | undefined {
  const items = asRecord(value)?.items;
  if (items === undefined) {
    return undefined;
  }
  assert.ok(Array.isArray(items), "Kubernetes list items must be an array");
  return items;
}

export function createKubernetesClient({
  selection,
  kubectl = (...args) => kubectlFor(selection, args),
  waitTimeoutMs = 240_000,
  waitIntervalMs = 750,
}: {
  selection: Selection;
  kubectl?: Kubectl;
  waitTimeoutMs?: number;
  waitIntervalMs?: number;
}) {
  const kubectlArgumentsForSelection: KubectlArguments = (args) =>
    kubectlArguments(selection, args);
  const resource = async (kind: string, name: string, namespace?: string): Promise<unknown> => {
    const args = ["get", kind, name, "-o", "json"];
    if (namespace !== undefined) {
      args.push("--namespace", namespace);
    }
    return JSON.parse(await kubectl(...args));
  };
  const resources = async (kind: string, namespace: string, ...args: string[]) => {
    const value: unknown = JSON.parse(
      await kubectl("get", kind, "--namespace", namespace, ...args, "-o", "json"),
    );
    return resourceItems(value);
  };
  // `operation` may also return false for "not yet".
  const waitFor = <Result>(
    description: string | (() => string),
    operation: () => Result | false | undefined | PromiseLike<Result | false | undefined>,
    timeoutMs = waitTimeoutMs,
  ): Promise<Result> =>
    waitForResult(description, operation, { timeoutMs, intervalMs: waitIntervalMs });

  return {
    kubectlArguments: kubectlArgumentsForSelection,
    kubectl,
    applyManifest: (manifest: string | Uint8Array, options?: ManifestOptions) =>
      applyManifest(kubectlArgumentsForSelection, manifest, options),
    resource,
    resources,
    waitFor,
  };
}

async function applyManifest(
  kubectlArgumentsForSelection: KubectlArguments,
  manifest: string | Uint8Array,
  { redactions = [] }: ManifestOptions = {},
) {
  const child = spawn("kubectl", kubectlArgumentsForSelection(["apply", "-f", "-"]), {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  // kubectl can reject its arguments before reading the manifest. Its exit status reports why.
  child.stdin.on("error", () => {});
  child.stdin.end(manifest);
  const [status]: unknown[] = await once(child, "close");
  if (status !== 0) {
    throw new Error(`kubectl apply failed (${status}): ${redact(stderr, redactions)}`);
  }
}

function redact(value: string, redactions: NonNullable<ManifestOptions["redactions"]>) {
  return redactions
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .reduce((current, secret) => current.split(secret).join("<redacted>"), value);
}

// The disposable k3d cluster that OCC_TEST_KUBERNETES_KUBECONFIG and OCC_TEST_KUBERNETES_CONTEXT
// select, read at the call. Check it with validateExplicitK3dLoopbackContext before use.
export function explicitK3dSelection() {
  return {
    kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
  };
}

type KubeconfigCluster = { server: string } & Record<string, unknown>;
type SelectedKubeconfig = { clusters: [{ name: string; cluster: KubeconfigCluster }] };

export async function validateExplicitK3dLoopbackContext(selection: Selection) {
  const { kubeconfigPath, kubernetesContext } = selection;
  assert.ok(
    kubeconfigPath,
    "OCC_TEST_KUBERNETES_KUBECONFIG must explicitly select disposable k3d.",
  );
  assert.match(kubernetesContext ?? "", /^k3d-/, "a dedicated k3d-* context is required");
  // Flattening reads local files, where kubectl's API request timeout does not apply.
  const configuration: unknown = JSON.parse(
    await kubectlFor(selection, ["config", "view", "--minify", "--flatten", "-o", "json"], {
      timeout: 30_000,
      killSignal: "SIGKILL",
    }),
  );
  assertSelectedKubeconfig(configuration, kubernetesContext);
  const endpoint = new URL(configuration.clusters[0].cluster.server);
  assert.equal(endpoint.protocol, "https:");
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname),
    "refusing to run destructive integration against a non-loopback Kubernetes API",
  );
  assert.notEqual(endpoint.port, "", "the disposable Kubernetes API requires an explicit port");
  return configuration;
}

function assertSelectedKubeconfig(
  value: unknown,
  context: string | undefined,
): asserts value is SelectedKubeconfig {
  const configuration = asRecord(value);
  const contexts: unknown[] | undefined = Array.isArray(configuration?.contexts)
    ? configuration.contexts
    : undefined;
  assert.equal(contexts?.length, 1);
  assert.equal(asRecord(contexts?.[0])?.name, context);
  const clusters: unknown[] | undefined = Array.isArray(configuration?.clusters)
    ? configuration.clusters
    : undefined;
  assert.equal(clusters?.length, 1);
  const selected = asRecord(clusters?.[0]);
  assert.equal(typeof selected?.name, "string");
  assert.equal(typeof asRecord(selected?.cluster)?.server, "string");
}

export function kubernetesHash(value: string, length = 12) {
  return sha256Hex(value, length);
}

// The production Gateway memory limit (deploy/examples/production/installation.yaml,
// docs/guides/deploy/installation-profiles.md). Fixtures that run a real Gateway
// turn set it, so they hold the Gateway to what production allows: OpenClaw
// starts most of its worker threads on the first turn (finding 2700).
export const productionGatewayMemoryLimitGi = 4;
export const productionGatewayMemoryLimit = `${productionGatewayMemoryLimitGi}Gi`;

export function createKubernetesInstallationConfiguration({
  authentication,
  platformNamespace,
  gatewayImage,
  codexImage,
  cluster,
  codexSeccompProfile,
}: {
  authentication: KubernetesAuthentication;
  platformNamespace: string;
  gatewayImage: string | undefined;
  codexImage: string | undefined;
  cluster: string;
  codexSeccompProfile?: string | undefined;
}) {
  const configuration = createInstallationDriverConfiguration();
  const compute = configuration.drivers.compute.configuration;
  const workload = {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "2", memory: "1Gi" },
  };
  const gatewayNodeSelector: unknown = JSON.parse(
    process.env.OCC_TEST_KUBERNETES_GATEWAY_NODE_SELECTOR ?? '{"kubernetes.io/os":"linux"}',
  );
  // Keep the selected node labels available to the Driver's own configuration validation.
  return {
    ...configuration,
    occ: { ...configuration.occ, cluster },
    drivers: {
      ...configuration.drivers,
      configuration: {
        ...configuration.drivers.configuration,
        configuration: { authentication: structuredClone(authentication) },
      },
      compute: {
        ...configuration.drivers.compute,
        configuration: {
          ...compute,
          authentication: structuredClone(authentication),
          images: { ...compute.images, gateway: gatewayImage, agent: codexImage },
          resources: {
            ...compute.resources,
            gateway: structuredClone(workload),
            agent: { ...structuredClone(workload), limits: { ...workload.limits, memory: "2Gi" } },
            namespace: {
              ...compute.resources.namespace,
              containerDefaults: structuredClone(workload),
            },
          } satisfies KubernetesComputeDriverOptions["resources"],
          network: {
            ...compute.network,
            gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
            gatewayClients: [
              {
                namespace: platformNamespace,
                podLabels: { "app.kubernetes.io/name": "approved-gateway-client" },
              },
            ],
          } satisfies KubernetesComputeDriverOptions["network"],
          runtime: {
            ...compute.runtime,
            gatewayNodeSelector,
            ...(codexSeccompProfile === undefined ? {} : { codexSeccompProfile }),
          },
        },
      },
      secret: {
        ...configuration.drivers.secret,
        configuration: { authentication: structuredClone(authentication) },
      },
    },
  };
}

/** Provision only a synthetic fixture credential through the actual owning Secret Driver. */
export async function createKubernetesFixtureHarnessAuth({
  authentication,
  namespaceId,
}: {
  authentication: KubernetesAuthentication;
  namespaceId: string;
}) {
  const { KubernetesSecretDriver } =
    await import("../../apps/controller/src/drivers/secret/kubernetes/index.ts");
  const driver = new KubernetesSecretDriver({ authentication });
  const identity = { id: `sec_${randomUUID()}`, namespaceId, name: "Kubernetes fixture model key" };
  const backendRef = await driver.create(identity, `fixture-only-${randomUUID()}`);
  const snapshot = {
    method: "api_key",
    source: { kind: "secret", namespaceId, id: identity.id },
    secretDriverId: driver.id,
  } satisfies HarnessAuthSnapshot;
  return {
    snapshot,
    context: {
      secretEnvironment: [],
      harnessAuth: {
        ...snapshot,
        backendRef: await driver.resolve({
          ...identity,
          driverId: driver.id,
          createdAt: new Date().toISOString(),
          backendRef,
        }),
      },
    },
  };
}

export async function assertGatewayModelTurn({
  gatewayUrl,
  gatewayPassword,
  nonce,
  secrets = [],
}: {
  gatewayUrl: string;
  gatewayPassword: string | undefined;
  nonce: string;
  secrets?: readonly (string | undefined)[];
}) {
  assert.ok(gatewayPassword, "Kubernetes model probes require the loopback gateway password.");
  const endpoint = `${gatewayUrl}/v1/chat/completions`;
  const denied = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "openclaw/default", messages: [] }),
  });
  assert.ok([401, 403].includes(denied.status), "the real gateway must reject unauthenticated use");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayPassword}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: false,
      messages: [
        { role: "user", content: `Reply with exactly this nonce and no other text: ${nonce}` },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  for (const secret of [gatewayPassword, ...secrets]) {
    if (secret) {
      assert.equal(
        body.includes(secret),
        false,
        "the gateway response must not expose credentials",
      );
    }
  }
  assert.equal(response.status, 200, `real provider-backed model turn failed: ${body}`);
  const completion: unknown = JSON.parse(body);
  const choices = asRecord(completion)?.choices;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = asRecord(asRecord(first)?.message);
  assert.equal(message?.role, "assistant");
  const content = message?.content ?? "";
  assert.ok(typeof content === "string", "the assistant must return text");
  assert.match(content, new RegExp(nonce));
}

export function createRealKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  databaseUrl,
}: Selection & {
  gatewayImage?: string | undefined;
  codexImage?: string | undefined;
  databaseUrl?: string | undefined;
}) {
  const selection = { kubeconfigPath, kubernetesContext };
  const kubernetes = createKubernetesClient({ selection });
  const { kubectl } = kubernetes;

  async function createControllerIdentity({
    directory,
    platformNamespace,
    kubeconfig,
    account,
    clusterRole,
    clusterRoleBinding,
    context,
  }: {
    directory: string;
    platformNamespace: string;
    kubeconfig: SelectedKubeconfig;
    account: string;
    clusterRole: string;
    clusterRoleBinding: string;
    context: string;
  }) {
    await kubectl("create", "serviceaccount", account, "--namespace", platformNamespace);
    await kubectl(
      "create",
      "clusterrolebinding",
      clusterRoleBinding,
      `--clusterrole=${clusterRole}`,
      `--serviceaccount=${platformNamespace}:${account}`,
    );
    const token = (
      await kubectl("create", "token", account, "--namespace", platformNamespace)
    ).trim();
    const path = join(directory, `${context}-kubeconfig.json`);
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "local", cluster: kubeconfig.clusters[0].cluster }],
        users: [{ name: account, user: { token } }],
        contexts: [{ name: context, context: { cluster: "local", user: account } }],
        "current-context": context,
      }),
      { mode: 0o600 },
    );
    const authentication = {
      mode: "kubeconfig",
      kubeconfigPath: path,
      context,
    } satisfies KubernetesAuthentication;
    return { account, authentication };
  }

  async function validatePrerequisites() {
    const configuration = await validateExplicitK3dLoopbackContext(selection);
    for (const [name, image] of [
      ["OCC_TEST_KUBERNETES_GATEWAY_IMAGE", gatewayImage],
      ["OCC_TEST_KUBERNETES_AGENT_IMAGE", codexImage],
    ]) {
      assert.match(
        image ?? "",
        /@sha256:[a-f0-9]{64}$/i,
        `${name} must select a real imported image by immutable SHA-256 digest.`,
      );
    }
    assert.ok(
      databaseUrl,
      "OCC_TEST_DATABASE_URL must select a dedicated openclaw_k8s_* database.",
    );
    const database = new URL(databaseUrl);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname),
      "the disposable integration database must use loopback",
    );
    assert.match(
      database.pathname,
      /^\/openclaw_k8s_[a-z0-9_]+$/,
      "refusing to modify a database not explicitly dedicated to Kubernetes integration",
    );

    return configuration;
  }

  async function provisionAgentTransportSecret(
    directory: string,
    namespace: string,
    agentId: string,
    {
      gatewayPassword,
      legacyCombined = false,
    }: {
      gatewayPassword?: string | undefined;
      legacyCombined?: boolean;
    } = {},
  ) {
    const suffix = kubernetesHash(agentId);
    const tokenDirectory = join(directory, `tokens-${suffix}`);
    const transportToken = randomBytes(32).toString("hex");
    const selectedGatewayPassword = gatewayPassword ?? randomBytes(32).toString("base64url");
    await mkdir(tokenDirectory, { mode: 0o700 });
    try {
      await Promise.all([
        writeFile(join(tokenDirectory, "app-server-token"), transportToken, { mode: 0o600 }),
        writeFile(join(tokenDirectory, "gateway-password"), selectedGatewayPassword, {
          mode: 0o600,
        }),
      ]);
      const owner = await kubernetes.resource("namespace", namespace);
      const metadata = asRecord(asRecord(owner)?.metadata);
      const namespaceId = asRecord(metadata?.labels)?.["openclaw.dev/namespace"];
      assert.ok(
        typeof namespaceId === "string" && namespaceId,
        "transport source must belong to the resolved data-plane Namespace",
      );
      const target = namespace;
      const bundles: [string, string[]][] = legacyCombined
        ? [[`openclaw-agent-transport-${suffix}`, ["app-server-token", "gateway-password"]]]
        : [
            [`openclaw-agent-transport-${suffix}`, ["app-server-token"]],
            [`gateway-password-${suffix}`, ["gateway-password"]],
          ];
      for (const [name, keys] of bundles) {
        await kubectl(
          "create",
          "secret",
          "generic",
          name,
          "--namespace",
          target,
          ...keys.map((key) => `--from-file=${key}=${join(tokenDirectory, key)}`),
        );
        await kubectl(
          "label",
          "secret",
          name,
          "--namespace",
          target,
          "app.kubernetes.io/managed-by=openclaw-enterprise",
          `openclaw.dev/namespace=${namespaceId}`,
          `openclaw.dev/agent=${agentId}`,
        );
        await kubectl(
          "annotate",
          "secret",
          name,
          "--namespace",
          target,
          `openclaw.dev/namespace-id=${namespaceId}`,
          `openclaw.dev/agent-id=${agentId}`,
        );
      }
    } finally {
      await rm(tokenDirectory, { recursive: true, force: true });
    }
    return selectedGatewayPassword;
  }

  async function startPortForward(namespace: string, serviceName: string) {
    return startPortForwardTarget(namespace, `service/${serviceName}`, "0:8080");
  }

  async function startPortForwardTarget(namespace: string, target: string, port: string) {
    const child = spawn(
      "kubectl",
      kubernetes.kubectlArguments([
        "port-forward",
        "--namespace",
        namespace,
        "--address",
        "127.0.0.1",
        target,
        port,
      ]),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2048);
    });
    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        void rejectAfterCleanup(
          new Error(`The production gateway port-forward did not become ready: ${stderr}`),
        );
      }, 30_000);
      timer.unref();
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onStdout);
        child.off("error", onError);
        child.off("exit", onExit);
        return true;
      };
      const rejectAfterCleanup = async (error: Error) => {
        if (!settle()) {
          return;
        }
        const cleanupFailures: unknown[] = [];
        if (child.pid !== undefined) {
          await stopPortForward(child, target).catch((cleanupError: unknown) => {
            cleanupFailures.push(cleanupError);
          });
        }
        if (cleanupFailures.length > 0) {
          reject(
            new AggregateError(
              [error, ...cleanupFailures],
              `Production gateway port-forward startup failed and cleanup reported ${cleanupFailures.length} failure(s).`,
            ),
          );
          return;
        }
        reject(error);
      };
      const onStdout = (chunk: Buffer) => {
        const match = chunk.toString().match(/Forwarding from 127\.0\.0\.1:(\d+)/);
        if (match !== null && settle()) {
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      };
      const onError = (error: Error) => void rejectAfterCleanup(error);
      const onExit = (code: number | null) => {
        if (settle()) {
          reject(new Error(`Production gateway port-forward exited (${code}): ${stderr}`));
        }
      };
      child.stdout.on("data", onStdout);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    let stopping: Promise<void> | undefined;
    return {
      url,
      stop: () => {
        stopping ??= stopPortForward(child, target);
        return stopping;
      },
    };
  }

  async function stopPortForward(child: ChildProcess, target: string) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    if (await waitForExit(exited, 2_000)) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGKILL");
    if (await waitForExit(exited, 2_000)) {
      return;
    }
    throw new Error(`Timed out stopping Kubernetes port-forward for ${target}.`);
  }

  async function waitForExit(exited: Promise<unknown>, timeoutMs: number) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kubectlArguments: kubernetes.kubectlArguments,
    kubectl,
    applyManifest: kubernetes.applyManifest,
    resource: kubernetes.resource,
    resources: kubernetes.resources,
    createControllerIdentity,
    waitFor: kubernetes.waitFor,
    validatePrerequisites,
    provisionAgentTransportSecret,
    startPortForward,
    startPortForwardTarget,
  };
}
