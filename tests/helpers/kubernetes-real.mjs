import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createInstallationDriverConfiguration } from "./installation-driver-configuration.mjs";
import { kubectlGetJson } from "./kubernetes-api-read.mjs";
import { waitFor as pollFor } from "./wait-for.mjs";
import { followContainerLog } from "./container-log-capture.ts";

const execute = promisify(execFile);

export function kubectlArguments({ kubeconfigPath, kubernetesContext }, args) {
  return ["--kubeconfig", kubeconfigPath, "--context", kubernetesContext, ...args];
}

// The deadline signal of the failure diagnostic running in this async context, if any.
const diagnosticDeadline = new AsyncLocalStorage();

// Whether the failure diagnostic this code runs in has passed its deadline, so it should
// write nothing more.
export function diagnosticDeadlinePassed() {
  return diagnosticDeadline.getStore()?.aborted === true;
}

async function kubectlFor(selection, args, options) {
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

export function isTransientKubectlFailure(error) {
  // A read a diagnostic deadline stopped is not retried, whatever kubectl wrote first.
  if (error?.name === "AbortError") {
    return false;
  }
  // A spawn failure (ENOENT, EACCES) has empty stderr: kubectl never ran.
  const stderr = String(error?.stderr ?? "");
  return !/command terminated with exit code/.test(stderr) && transientKubectlFailure.test(stderr);
}

// Retries a kubectl command that changes nothing in the cluster or in the
// container (a get, or an exec that only reads) when the transport dropped.
// Any other failure, and the last transient one, is thrown unchanged.
export async function retryKubectlRead(
  read,
  {
    attempts = 4,
    firstDelayMs = 500,
    sleep = delay,
    log = (message) => process.stderr.write(`${message}\n`),
  } = {},
) {
  let delayMs = firstDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= attempts || !isTransientKubectlFailure(error)) {
        throw error;
      }
      const reason = String(error.stderr).trim().split("\n").at(-1);
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
export async function withinDiagnosticDeadline(
  diagnostic,
  { timeoutMs = diagnosticDeadlineMs, timedOut = "Diagnostic timed out", sleep = delay } = {},
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
  context,
  selection,
  { namespace, deployment, container, labels },
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
      const read = (resource, extra = []) =>
        withinDiagnosticDeadline(
          async () =>
            JSON.parse(
              await kubectlFor(selection, [
                "get",
                resource,
                ...scope,
                ...extra,
                "-o",
                "json",
                diagnosticRequestTimeout,
              ]),
            ).items,
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
  kubectl,
  namespace,
  // The listing's own bound keeps the delete and the listing within teardownStepLimitMs, so the
  // teardown never abandons the step and loses the listing with it. `sleep` stands in for the
  // deadline's timer (withinDiagnosticDeadline's), so a test can hold it.
  { timeout = "120s", listTimeoutMs = 40_000, sleep } = {},
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
    const read = [];
    const timedOut = Symbol("listing timed out");
    const remains = await withinDiagnosticDeadline(
      () => describeNamespaceRemains(kubectl, namespace, read),
      { timeoutMs: listTimeoutMs, timedOut, sleep },
    ).then(
      (listed) =>
        listed === timedOut ? [...read, "listing what remains timed out"].join("\n  ") : listed,
      (listError) => `listing what remains failed: ${listError?.message ?? listError}`,
    );
    error.message = `${error.message}\nNamespace ${namespace} remains: ${remains}`;
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
async function partialKubectlRead(kubectl, args, lines, what) {
  try {
    return { output: await kubectl(...args), complete: true };
  } catch (error) {
    // A read the deadline stopped is not a failed read: the listing reports its timeout instead,
    // and a line pushed here could race into that report.
    if (error?.name === "AbortError" || diagnosticDeadlinePassed()) {
      throw error;
    }
    const reason = String(error?.stderr || error?.message || error)
      .trim()
      .split("\n")[0]
      .slice(0, 300);
    lines.push(`${what} failed: ${reason}`);
    return { output: String(error?.stdout ?? ""), complete: false };
  }
}

// Pushes each line to `lines` as it is read, so a listing cut short by its deadline keeps them.
async function describeNamespaceRemains(kubectl, namespace, lines) {
  let state;
  try {
    state = JSON.parse(
      await kubectl("get", "namespace", namespace, "-o", "json", diagnosticRequestTimeout),
    );
  } catch (error) {
    if (/\(NotFound\)/.test(String(error?.stderr ?? ""))) {
      return "none (the Namespace is gone)";
    }
    throw error;
  }
  lines.push(
    `phase ${state.status?.phase ?? "unknown"}, finalizers [${(state.spec?.finalizers ?? []).join(", ")}]`,
    ...(state.status?.conditions ?? []).map(
      (condition) =>
        `condition ${condition.type}=${condition.status} ${condition.reason ?? ""}: ${condition.message ?? ""}`,
    ),
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

export {
  abandonedTeardownExitGraceMs,
  boundedTeardown,
  teardownStepLimitMs,
  withBoundedTeardown,
} from "./bounded-teardown.ts";

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
export async function retryKubectlWrite(write, { applied = alreadyCreated, ...options } = {}) {
  let dropped = false;
  return retryKubectlRead(async () => {
    try {
      return await write();
    } catch (error) {
      if (dropped && applied.test(String(error?.stderr ?? ""))) {
        return "";
      }
      dropped ||= isTransientKubectlFailure(error);
      throw error;
    }
  }, options);
}

// tests/fixtures/kubernetes/probe.mjs exits with this code, and prints
// {"denied":true,"code":...} on stdout, only when its connection attempt was
// refused, unreachable, or unanswered. Any other probe failure exits 1.
export const PROBE_DENIED_EXIT_CODE = 42;

// Returns the probe's denial report when kubectl exec ran the probe and the
// probe itself reported a denial, otherwise undefined. A dropped exec stream, a
// missing or crashing probe script, and a DNS or argument error are not denials.
export function probeDenial(error) {
  const stderr = String(error?.stderr ?? "");
  if (
    error?.code !== PROBE_DENIED_EXIT_CODE ||
    !stderr.includes(`command terminated with exit code ${PROBE_DENIED_EXIT_CODE}`)
  ) {
    return undefined;
  }
  try {
    const report = JSON.parse(
      String(error.stdout ?? "")
        .trim()
        .split("\n")
        .at(-1),
    );
    return report?.denied === true && typeof report.code === "string" ? report : undefined;
  } catch {
    return undefined;
  }
}

// Runs a probe exec that is expected to be blocked. Transport drops are
// retried like any read; the check passes only on the probe's own denial.
export async function assertProbeDenied(description, run, options) {
  let stdout;
  try {
    stdout = await retryKubectlRead(run, options);
  } catch (error) {
    const denial = probeDenial(error);
    if (denial !== undefined) {
      return denial;
    }
    const detail = String(error?.stderr ?? "").trim() || error?.message;
    throw new Error(
      `${description}: the probe did not report a denial (exit ${error?.code}): ${detail}`,
      { cause: error },
    );
  }
  assert.fail(`${description} unexpectedly succeeded: ${String(stdout).trim()}`);
}

// The `node` command that runs probe.mjs from its source text, for a container
// that does not mount the fixture (a Gateway container, the DNS fixture Pods).
// "probe.mjs" fills process.argv[1], so the probe still reads its own arguments
// from process.argv.slice(2).
export function inlineProbeCommand(source, ...probeArguments) {
  return ["node", "--input-type=module", "-e", source, "probe.mjs", ...probeArguments.map(String)];
}

export function createKubernetesClient({
  selection,
  kubectl = (...args) => kubectlFor(selection, args),
  waitTimeoutMs = 240_000,
  waitIntervalMs = 750,
}) {
  const kubectlArgumentsForSelection = (args) => kubectlArguments(selection, args);
  const resource = async (kind, name, namespace) => {
    const args = ["get", kind, name, "-o", "json"];
    if (namespace !== undefined) {
      args.push("--namespace", namespace);
    }
    return JSON.parse(await kubectl(...args));
  };
  const resources = async (kind, namespace, ...args) =>
    JSON.parse(await kubectl("get", kind, "--namespace", namespace, ...args, "-o", "json")).items;
  // `operation` may also return false for "not yet".
  const waitFor = (description, operation, timeoutMs = waitTimeoutMs) =>
    pollFor(
      description,
      async () => {
        const result = await operation();
        return result === false ? undefined : result;
      },
      { timeoutMs, intervalMs: waitIntervalMs },
    );

  return {
    kubectlArguments: kubectlArgumentsForSelection,
    kubectl,
    applyManifest: (manifest, options) =>
      applyManifest(kubectlArgumentsForSelection, manifest, options),
    resource,
    resources,
    waitFor,
  };
}

async function applyManifest(kubectlArgumentsForSelection, manifest, { redactions = [] } = {}) {
  const child = spawn("kubectl", kubectlArgumentsForSelection(["apply", "-f", "-"]), {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  // kubectl can reject its arguments before reading the manifest. Its exit status reports why.
  child.stdin.on("error", () => {});
  child.stdin.end(manifest);
  const [status] = await once(child, "close");
  if (status !== 0) {
    throw new Error(`kubectl apply failed (${status}): ${redact(stderr, redactions)}`);
  }
}

function redact(value, redactions) {
  return redactions
    .filter((secret) => typeof secret === "string" && secret.length > 0)
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

export async function validateExplicitK3dLoopbackContext(selection) {
  const { kubeconfigPath, kubernetesContext } = selection;
  assert.ok(
    kubeconfigPath,
    "OCC_TEST_KUBERNETES_KUBECONFIG must explicitly select disposable k3d.",
  );
  assert.match(kubernetesContext ?? "", /^k3d-/, "a dedicated k3d-* context is required");
  // Flattening reads local files, where kubectl's API request timeout does not apply.
  const configuration = JSON.parse(
    await kubectlFor(selection, ["config", "view", "--minify", "--flatten", "-o", "json"], {
      timeout: 30_000,
      killSignal: "SIGKILL",
    }),
  );
  assert.equal(configuration.contexts?.length, 1);
  assert.equal(configuration.contexts[0].name, kubernetesContext);
  assert.equal(configuration.clusters?.length, 1);
  const endpoint = new URL(configuration.clusters[0].cluster.server);
  assert.equal(endpoint.protocol, "https:");
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname),
    "refusing to run destructive integration against a non-loopback Kubernetes API",
  );
  assert.notEqual(endpoint.port, "", "the disposable Kubernetes API requires an explicit port");
  return configuration;
}

export function kubernetesHash(value, length = 12) {
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
}) {
  const configuration = createInstallationDriverConfiguration();
  const compute = configuration.drivers.compute.configuration;
  const workload = {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "2", memory: "1Gi" },
  };
  configuration.occ.cluster = cluster;
  configuration.drivers.configuration.configuration.authentication =
    structuredClone(authentication);
  configuration.drivers.secret.configuration.authentication = structuredClone(authentication);
  compute.authentication = structuredClone(authentication);
  compute.images.gateway = gatewayImage;
  compute.images.agent = codexImage;
  // Disposable fixture clusters may use one node; production node isolation is separate proof.
  compute.runtime.gatewayNodeSelector = JSON.parse(
    process.env.OCC_TEST_KUBERNETES_GATEWAY_NODE_SELECTOR ?? '{"kubernetes.io/os":"linux"}',
  );
  if (codexSeccompProfile !== undefined) {
    compute.runtime.codexSeccompProfile = codexSeccompProfile;
  }
  compute.resources.gateway = structuredClone(workload);
  compute.resources.agent = {
    ...structuredClone(workload),
    limits: { ...workload.limits, memory: "2Gi" },
  };
  compute.resources.namespace.containerDefaults = structuredClone(workload);
  compute.network.gatewayTrustedProxyCidrs = ["127.0.0.1/32"];
  compute.network.gatewayClients = [
    {
      namespace: platformNamespace,
      podLabels: { "app.kubernetes.io/name": "approved-gateway-client" },
    },
  ];
  return configuration;
}

/** Provision only a synthetic fixture credential through the actual owning Secret Driver. */
export async function createKubernetesFixtureHarnessAuth({ authentication, namespaceId }) {
  const { KubernetesSecretDriver } =
    await import("../../apps/controller/src/drivers/secret/kubernetes/index.ts");
  const driver = new KubernetesSecretDriver({ authentication });
  const identity = { id: `sec_${randomUUID()}`, namespaceId, name: "Kubernetes fixture model key" };
  const backendRef = await driver.create(identity, `fixture-only-${randomUUID()}`);
  const snapshot = {
    method: "api_key",
    source: { kind: "secret", namespaceId, id: identity.id },
    secretDriverId: driver.id,
  };
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

export async function assertGatewayModelTurn({ gatewayUrl, gatewayPassword, nonce, secrets = [] }) {
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
  const message = JSON.parse(body).choices?.[0]?.message;
  assert.equal(message?.role, "assistant");
  assert.match(message?.content ?? "", new RegExp(nonce));
}

export function createRealKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  databaseUrl,
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
    return { account, authentication: { mode: "kubeconfig", kubeconfigPath: path, context } };
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
    directory,
    namespace,
    agentId,
    { gatewayPassword, legacyCombined = false } = {},
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
      const namespaceId = owner.metadata.labels["openclaw.dev/namespace"];
      assert.ok(namespaceId, "transport source must belong to the resolved data-plane Namespace");
      const target = namespace;
      const bundles = legacyCombined
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

  async function startPortForward(namespace, serviceName) {
    return startPortForwardTarget(namespace, `service/${serviceName}`, "0:8080");
  }

  async function startPortForwardTarget(namespace, target, port) {
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
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2048);
    });
    const url = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        void rejectAfterCleanup(
          reject,
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
      const finish = (complete, value) => {
        if (!settle()) {
          return;
        }
        complete(value);
      };
      const rejectAfterCleanup = async (reject, error) => {
        if (!settle()) {
          return;
        }
        const cleanupFailures = [];
        if (child.pid !== undefined) {
          await stopPortForward(child, target).catch((cleanupError) => {
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
      const onStdout = (chunk) => {
        const match = chunk.toString().match(/Forwarding from 127\.0\.0\.1:(\d+)/);
        if (match !== null) {
          finish(resolve, `http://127.0.0.1:${match[1]}`);
        }
      };
      const onError = (error) => void rejectAfterCleanup(reject, error);
      const onExit = (code) =>
        finish(reject, new Error(`Production gateway port-forward exited (${code}): ${stderr}`));
      child.stdout.on("data", onStdout);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    /** @type {Promise<void> | undefined} */
    let stopping;
    return {
      url,
      stop: () => {
        stopping ??= stopPortForward(child, target);
        return stopping;
      },
    };
  }

  async function stopPortForward(child, target) {
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

  async function waitForExit(exited, timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
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
