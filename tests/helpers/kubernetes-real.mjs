import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createInstallationDriverConfiguration } from "./installation-driver-configuration.mjs";

const execute = promisify(execFile);

export function kubectlArguments({ kubeconfigPath, kubernetesContext }, args) {
  return ["--kubeconfig", kubeconfigPath, "--context", kubernetesContext, ...args];
}

async function kubectlFor(selection, ...args) {
  const { stdout } = await execute("kubectl", kubectlArguments(selection, args), {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

// kubectl reports a dropped API server or kubelet stream on stderr: an exec
// WebSocket that closed mid-stream ("error: EOF"), a reset or refused
// connection, or a kubelet tunnel that could not be dialed. A remote command
// that ran and failed ends with "command terminated with exit code N"; that is
// the command's own result and is never retried.
const transientKubectlFailure =
  /^error: EOF$|Unable to connect to the server|error dialing backend|websocket: close|unexpected EOF|connection reset by peer|connection refused|http2: client connection lost|TLS handshake timeout|i\/o timeout|the server is currently unable to handle the request|etcdserver: request timed out/m;

export function isTransientKubectlFailure(error) {
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
  kubectl = (...args) => kubectlFor(selection, ...args),
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
  const waitFor = async (description, operation, timeoutMs = waitTimeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await operation();
      if (result !== undefined && result !== false) {
        return result;
      }
      await delay(waitIntervalMs);
    }
    assert.fail(`Timed out waiting for ${description}.`);
  };

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
  await new Promise((resolve, reject) => {
    const child = spawn("kubectl", kubectlArgumentsForSelection(["apply", "-f", "-"]), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4096);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`kubectl apply failed (${code}): ${redact(stderr, redactions)}`));
      }
    });
    child.stdin.once("error", reject);
    child.stdin.end(manifest);
  });
}

function redact(value, redactions) {
  return redactions
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .reduce((current, secret) => current.split(secret).join("<redacted>"), value);
}

export async function validateExplicitK3dLoopbackContext(selection) {
  const { kubeconfigPath, kubernetesContext } = selection;
  assert.ok(
    kubeconfigPath,
    "OCC_TEST_KUBERNETES_KUBECONFIG must explicitly select disposable k3d.",
  );
  assert.match(kubernetesContext ?? "", /^k3d-/, "a dedicated k3d-* context is required");
  const configuration = JSON.parse(
    await kubectlFor(selection, "config", "view", "--minify", "--flatten", "-o", "json"),
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
  assert.match(JSON.parse(body).choices?.[0]?.message?.content ?? "", new RegExp(nonce));
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
