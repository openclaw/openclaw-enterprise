import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { rootCertificates } from "node:tls";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  createKubernetesInstallationConfiguration,
  createKubernetesClient,
  createRealKubernetesFixture,
  diagnosticDeadlineMs,
  productionGatewayMemoryLimit,
  withinDiagnosticDeadline,
} from "./kubernetes-real.mjs";

const execute = promisify(execFile);
const sandboxApiResource = "sandboxes.agents.x-k8s.io";
const harnessPort = 18790;
const gatewayPort = 8080;
const transportSecretPrefix = "openclaw-agent-transport";

function safeKubectlFailure(error, signal) {
  // A child-process Error carries raw stdout/stderr. Returning it as a cause
  // would let the test reporter publish model or credential bytes.
  let outcome = "transport";
  if (Number.isInteger(error.code)) {
    outcome = `exit ${error.code}`;
  } else if (signal?.aborted) {
    outcome = "cancelled";
  } else if (error.killed) {
    outcome = "deadline";
  }
  return new Error(`OpenShell fixture kubectl failed (${outcome})`);
}

// The pinned Kubernetes driver, not policy.process, owns workload identity.
// This k3d fixture leaves sandbox_uid/gid and OpenShift namespace ranges unset:
// NVIDIA/OpenShell bdb956f2cd65a635f1294fccf1d138d263bf650f
// crates/openshell-driver-kubernetes/src/config.rs:335,569-602.
export const OPENSHELL_KUBERNETES_WORKLOAD_IDENTITY = Object.freeze({ uid: 10001, gid: 10001 });

// Compute's dedicated Codex Harness categories: the workspace, generated images, and Codex
// thread rollouts. Skills no longer arrive through the workspace PVC.
const requiredWorkspaceMounts = Object.freeze([
  {
    subPath: "codex-sessions",
    mountPath: "/sandbox/.openclaw-runtime/home/.codex/sessions",
    readOnly: false,
  },
  {
    subPath: "generated-images",
    mountPath: "/sandbox/.openclaw-runtime/home/.codex/generated_images",
    readOnly: false,
  },
  { subPath: "workspace", mountPath: "/sandbox/enterprise", readOnly: false },
]);

// The OpenShell proof's installation cleanups, each its own registration on a bounded teardown
// context (finding 1711), so a worker stop that never settles cannot keep the later ones from
// running. Operations are closures, so resources the proof assigns later are read at cleanup
// time. They run last-registered first: the worker stops before what it uses goes away.
export const openShellInstallationCleanupOrder = Object.freeze([
  "workerStop",
  "portForwards",
  "productionApp",
  "observerPool",
  "workloadNamespace",
  "temporaryDirectory",
]);

export function registerOpenShellInstallationCleanups(context, operations) {
  let stopped;
  for (const name of [...openShellInstallationCleanupOrder].reverse()) {
    const operation = operations[name];
    assert.equal(typeof operation, "function", `OpenShell installation cleanup ${name}`);
    // Named for the teardown log: every registration comes from this line. Registered after its
    // test's teardown, each runs at once and throws to stop the setup; register them all first.
    try {
      context.after({ [name]: () => operation() }[name]);
    } catch (error) {
      stopped ??= error;
    }
  }
  if (stopped !== undefined) {
    throw stopped;
  }
}

// One poll of the gateway-outage proof: the revision's work back in `queued` after a pass, then
// the deployment's status. A pass that waited on the gateway (`last_attempt_code`
// SANDBOX_GATEWAY_UNAVAILABLE) gives its attempt back (finding 2040); any other failed pass keeps
// it, so the proof can still see, and then reject, one. A started deployment reads as `running`
// between passes as during one (finding 2456), so the status read ends the wait whatever it says:
// a revision that failed or activated during the outage still fails the proof (finding 1846).
export function outageAttemptRead({ readWork, readStatus }) {
  return async () => {
    const work = await readWork();
    if (
      work?.state !== "queued" ||
      (work.attempt_count < 1 && work.last_attempt_code !== "SANDBOX_GATEWAY_UNAVAILABLE")
    ) {
      return undefined;
    }
    return { work, status: await readStatus() };
  };
}

// Finding 2017: after the gateway outage the held deployment can end failed_permanent with
// RUNTIME_LOGIN_FAILED. The proof reads why near the failure, before its refresh checks take
// minutes and the failed revision's Pods go: `readWorker` gives the worker's events and persisted
// state, and `describe(worker)` the revision's Pods with the Gateway, Harness and OpenShell
// supervisor log tails. Each read stops at the diagnostic deadline, and one that fails or stalls
// only says so: it never replaces the failure it explains. The text is written to stderr, added
// to `failure`'s message when the wait itself failed, and returned for the assertion.
export async function failedRecoveryDiagnostic(
  { readWorker, describe, failure, write = (text) => process.stderr.write(text) },
  { timeoutMs = diagnosticDeadlineMs } = {},
) {
  // A worker read that failed or stalled gives `describe` no worker (an undefined timedOut
  // would fall back to the deadline's default text).
  const read = await withinDiagnosticDeadline(
    () =>
      Promise.resolve()
        .then(readWorker)
        .catch(() => null),
    { timeoutMs, timedOut: null },
  );
  const worker = typeof read === "object" && read !== null ? read : undefined;
  const detail = await withinDiagnosticDeadline(
    () =>
      Promise.resolve()
        .then(() => describe(worker))
        .catch((error) => `\nRecovery diagnostic unavailable: ${error?.name ?? "Error"}`),
    { timeoutMs, timedOut: `\nRecovery diagnostic timed out after ${timeoutMs / 1_000} s` },
  );
  write(`OpenShell integration: gateway outage recovery failed.${detail}\n`);
  if (failure instanceof Error) {
    failure.message = `${failure.message}${detail}`;
  }
  return detail;
}

// The real model's final answer when its provider has no capacity for the selected model; the
// turn script prints it as its error, and kubectl's failure carries it on stderr (finding 1946).
const modelAtCapacity = /^Error: Selected model is at capacity\./m;

// The in-Pod client's positive receipt that a turn is safe to run again: our own turn's final
// error was the at-capacity answer, before the turn began any action. The client exits with
// this status and writes exactly this to stdout only then; stderr stays diagnostic, so nothing
// in it (or a truncated copy of it) can authorize another turn.
const modelAtCapacityExitCode = 75;
const modelAtCapacityReceipt = "occ-codex-turn: retry-safe: model at capacity before any action";

// "retry" with the client's exact receipt; "unsafe" when stderr shows the at-capacity answer
// without it; undefined for any other failure.
export function modelAtCapacityOutcome(error) {
  if (error?.code === modelAtCapacityExitCode && error?.stdout === modelAtCapacityReceipt) {
    return "retry";
  }
  return modelAtCapacity.test(String(error?.stderr ?? "")) ? "unsafe" : undefined;
}

// Runs a real-model Codex turn, and runs it again, a bounded number of times, when the model
// answered only that it is at capacity before the turn began any action: an upstream
// condition, not the product's. A turn that had begun a command keeps its unknown outcome and
// is never run again. Either way an at-capacity failure says so on its first line, since the
// kubectl failure itself starts with the command line; any other failure is thrown at once.
export async function retryModelAtCapacity(
  turn,
  {
    attempts = 3,
    firstDelayMs = 15_000,
    sleep = delay,
    log = (message) => process.stderr.write(`${message}\n`),
  } = {},
) {
  // Keeps kubectl's output and exit code for callers that read them.
  const atCapacity = (line, error) =>
    Object.assign(new Error(`${line}\n${error.message}`, { cause: error }), {
      stdout: error.stdout,
      stderr: error.stderr,
      code: error.code,
    });
  let delayMs = firstDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await turn();
    } catch (error) {
      const outcome = modelAtCapacityOutcome(error);
      if (outcome === undefined) {
        throw error;
      }
      if (outcome === "unsafe") {
        throw atCapacity(
          `The real model was at capacity ("Selected model is at capacity"), but the turn's client gave no receipt that it is safe to run again (it may have begun an action), so it is not run again (attempt ${attempt}/${attempts}).`,
          error,
        );
      }
      if (attempt >= attempts) {
        throw atCapacity(
          `The real model was at capacity on all ${attempts} turn attempts ("Selected model is at capacity").`,
          error,
        );
      }
      log(
        `The real model was at capacity before the turn began any action; retrying the turn in ${delayMs} ms (attempt ${attempt + 1}/${attempts})`,
      );
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}

export function openshellHash(value, length = 12) {
  return sha256Hex(value, length);
}

export function openShellAgentName(agentId) {
  return `agent-${openshellHash(agentId)}`;
}

export function openShellGatewayName(agentId) {
  return `gateway-${openshellHash(agentId)}`;
}

export function openShellRevisionName(revision) {
  return `${openShellAgentName(revision.agentId)}-rev-${openshellHash(revision.id)}`;
}

export function assertOpenShellHarnessBinding(
  namespace,
  revision,
  sandbox,
  pod,
  profile = "perAgent",
) {
  assert.equal(sandbox.metadata.namespace, namespace);
  assert.equal(pod.metadata.namespace, namespace);
  assert.ok(sandbox.metadata.name, "Sandbox must have a stable resource name.");
  assert.ok(["perAgent", "maintainedLauncher"].includes(profile), "unknown identity profile");
  // internal/occdev/openshell.go selects this literal for the maintained launcher.
  // Keep the per-Agent oracle as the default for callers qualifying that contract.
  assert.equal(
    pod.spec.serviceAccountName,
    profile === "maintainedLauncher" ? "openshell-sandbox" : openShellAgentName(revision.agentId),
  );
  assert.equal(pod.metadata.labels?.["openclaw.dev/namespace"], revision.namespaceId);
  assert.equal(pod.metadata.labels?.["openclaw.dev/agent"], revision.agentId);
  assert.equal(pod.metadata.labels?.["openclaw.dev/revision"], revision.id);
  assert.equal(
    pod.metadata.labels?.["app.kubernetes.io/name"],
    openShellRevisionName(revision),
    "the provider-owned Pod must carry Compute's immutable revision selector.",
  );
  assert.ok(sandbox.metadata.uid, "Sandbox must have an immutable UID.");
  assert.equal(
    pod.metadata.ownerReferences?.some(
      (owner) =>
        owner.kind === "Sandbox" &&
        owner.name === sandbox.metadata.name &&
        owner.uid === sandbox.metadata.uid &&
        owner.apiVersion === sandbox.apiVersion &&
        owner.controller === true,
    ),
    true,
    "the Agent Sandbox controller, not Compute, must own the Harness Pod.",
  );
  if (profile === "maintainedLauncher") {
    // The supervisor runs in a separate Pod. The maintained launcher's workload
    // must bootstrap from its Secret without receiving a ServiceAccount token.
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(
      (pod.spec.volumes ?? []).some(({ projected }) =>
        projected?.sources?.some(({ serviceAccountToken }) => serviceAccountToken !== undefined),
      ),
      false,
      "the workload Pod must not project a ServiceAccount token, even for init containers.",
    );
    const sandboxId = sandbox.metadata.labels?.["openshell.ai/sandbox-id"];
    assert.ok(typeof sandboxId === "string" && sandboxId.length > 0);
    assert.equal(pod.metadata.annotations?.["openshell.ai/sandbox-id"], sandboxId);
    assert.equal(pod.metadata.labels?.["openshell.ai/boundary-pair"], sandboxId.toLowerCase());
    assert.equal(pod.metadata.labels?.["openshell.ai/boundary-role"], "workload");
    assert.equal(pod.metadata.labels?.["openclaw.dev/workload-role"], "agent");
    assert.equal(pod.metadata.labels?.["openclaw.dev/network-profile"], "provider-fenced-v1");
  }
}

export function createOpenShellServiceLoopbackLookup(serviceHostname) {
  const expectedHostname = serviceHostname.toLowerCase();

  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== expectedHostname) {
      const error = new Error(`Refusing to resolve unexpected OpenShell hostname ${hostname}.`);
      error.code = "ENOTFOUND";
      callback(error);
      return;
    }

    const address = { address: "127.0.0.1", family: 4 };
    if (typeof options === "object" && options.all === true) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

/** Initialize the actual exposed native process, then perform optional read-only discovery. */
export async function assertExposedCodexInitializes(serviceUrl, appServerToken, reads = []) {
  assert.ok(
    reads.every(({ method }) =>
      ["plugin/list", "plugin/read", "plugin/installed", "config/read"].includes(method),
    ),
  );
  const controllerRequire = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const socketRequire = createRequire(controllerRequire.resolve("@kubernetes/client-node"));
  const WebSocket = socketRequire("ws");
  const url = new URL(serviceUrl);
  const socket = new WebSocket(url, {
    lookup: createOpenShellServiceLoopbackLookup(url.hostname),
    headers: { authorization: `Bearer ${appServerToken}` },
    perMessageDeflate: false,
    closeTimeout: 1_000,
  });
  const requests = [
    {
      method: "initialize",
      params: {
        clientInfo: { name: "openclaw-enterprise-openshell-integration", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    },
    ...reads,
  ];
  let index = 0;
  const results = [];
  try {
    return await new Promise((resolve, reject) => {
      // Peer payloads and close reasons can contain credentials; report only method/status.
      const fail = (detail) =>
        reject(
          new Error(
            `OpenShell exposed Codex ${requests[index]?.method ?? "transport"}: ${detail}.`,
          ),
        );
      const deadline = setTimeout(() => fail("timed out"), reads.length === 0 ? 5_000 : 30_000);
      const send = () => socket.send(JSON.stringify({ id: index + 1, ...requests[index] }));
      socket.once("close", (code) => {
        clearTimeout(deadline);
        fail(`socket closed (code ${code})`);
      });
      socket.once("error", () => {
        clearTimeout(deadline);
        fail("WebSocket error");
      });
      socket.once("unexpected-response", (_request, response) => {
        clearTimeout(deadline);
        fail(`HTTP ${response.statusCode}`);
        response.destroy();
      });
      socket.once("open", send);
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data);
        } catch {
          clearTimeout(deadline);
          fail("invalid JSON");
          return;
        }
        if (message?.id !== index + 1 || "method" in message) {
          return;
        }
        if (message.error !== undefined || message.result == null) {
          clearTimeout(deadline);
          fail("RPC did not succeed");
          return;
        }
        if (index === 0) {
          socket.send(JSON.stringify({ method: "initialized", params: {} }));
        } else {
          results.push(message.result);
        }
        index++;
        if (index === requests.length) {
          clearTimeout(deadline);
          resolve(results);
        } else {
          send();
        }
      });
    });
  } catch (error) {
    socket.terminate();
    throw error;
  } finally {
    socket.close(1000);
  }
}

// Model egress comes only from the credential source's profile, bound to native Codex.
// Match either architecture of the pinned image, independent of the test runner's host.
const openshellCodexBinaries = Object.freeze([
  "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
  "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2-linux-arm64/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/bin/codex",
]);

export function createOpenShellInstallationConfiguration({
  authentication,
  platformNamespace,
  gatewayImage,
  codexImage,
  openShellRuntimeClass = "openshell-sandbox",
  cluster,
}) {
  const configuration = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage,
    codexImage,
    cluster,
  });
  configuration.drivers.configuration.id = "configuration-kubernetes-production";
  configuration.drivers.compute.id = "compute-kubernetes-production";
  // The real Gateway loads its plugins and installs the native worker bundle during the first turn.
  configuration.drivers.compute.configuration.resources.gateway.limits.memory =
    productionGatewayMemoryLimit;
  configuration.drivers.compute.configuration.resources.namespace.quota = {
    pods: "14",
    "requests.cpu": "3",
    "requests.memory": "3Gi",
    "limits.cpu": "16",
    "limits.memory": "8Gi",
  };
  configuration.drivers.compute.configuration.servicePrincipalCredentials =
    process.env.OCC_TEST_OPENSHELL_HARNESS === "openclaw"
      ? {
          mode: "projectedServiceAccountToken",
          audience: "openclaw-enterprise",
          expirationSeconds: 3600,
        }
      : { mode: "disabled" };
  // The integration replaces this placeholder transport with each namespace's port-forward.
  configuration.backend = [
    {
      id: "openshell",
      type: "openshell",
      // The fixture gateway is in-cluster HTTP isolated by the suite's NetworkPolicies.
      configuration: { endpoint: "http://127.0.0.1:1", insecureTransport: "network-policy" },
      drivers: {
        sandbox: "sandbox-openshell-kubernetes",
        credential_gateway: "credential-gateway-openshell-kubernetes",
      },
    },
  ];
  configuration.drivers.credential_gateway = {
    id: "credential-gateway-openshell-kubernetes",
    configuration: { binaries: [...openshellCodexBinaries] },
  };
  configuration.sandboxNetworkPolicyCeiling = [
    {
      id: "python-demo",
      binary: "/usr/bin/python3.11",
      host: "example.org",
      ports: [{ from: 443, to: 443 }],
    },
  ];
  configuration.drivers.sandbox = {
    id: "sandbox-openshell-kubernetes",
    configuration: {
      gateway: {
        workspaceMode: "operator",
        readiness: {
          serviceName: "openshell-gateway",
          podSelector: { "app.kubernetes.io/name": "openshell" },
          timeoutMs: 120_000,
        },
        // Compute owns ordinary Harness DNS; OpenShell's own `openshell-sandbox-supervisors`
        // policy covers supervisor egress, and the installer scopes gateway DNS/API access below.
        networkPolicyResources: [],
      },
      kubernetes: {
        runtimeClassName: openShellRuntimeClass,
        // Match the Compute-owned Harness budget. The cluster's 1 GiB default
        // can OOM-kill a real worker while it installs the Gateway bundle.
        agentResources: structuredClone(
          configuration.drivers.compute.configuration.resources.agent,
        ),
        // TODO(OpenShell per-Sandbox ServiceAccount support): replace the shared gateway setting
        // with Compute's exact Agent ServiceAccount on each Sandbox request.
        serviceAccount: { mode: "gatewayConfigured" },
        // TODO(OpenShell existing-workspace support): remove this fixture-only mount once upstream
        // can reuse approved Enterprise workspace subpaths without requiring a /sandbox alias.
        sandboxDataMount: {
          claimName: "workspace-placeholder",
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
        userNamespaces: false,
      },
      policy: {
        filesystem: {
          includeWorkdir: true,
          readOnly: ["/app"],
          readWrite: ["/sandbox/.openclaw-runtime", "/dev/null"],
        },
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "openclaw",
            endpoints: [{ host: "www.openclaw.org", ports: [443], tls: "skip" }],
            binaries: [{ path: "/usr/bin/curl" }],
          },
        ],
      },
      sandboxNamePrefix: "os",
    },
  };
  configuration.drivers.sandbox.configuration.kubernetes.agentResources.requests[
    "ephemeral-storage"
  ] = "256Mi";
  configuration.drivers.sandbox.configuration.kubernetes.agentResources.limits[
    "ephemeral-storage"
  ] = "1Gi";
  return configuration;
}

export function openShellChartImageValues(prefix, image) {
  assert.ok(image, `${prefix}.repository requires an explicit OpenShell image.`);
  const digest = image.match(/@sha256:[a-f0-9]{64}$/i)?.[0];
  assert.ok(digest, `${prefix}.digest requires an immutable OpenShell image digest.`);
  const withoutDigest = image.slice(0, -digest.length);
  const firstSlash = withoutDigest.indexOf("/");
  assert.ok(firstSlash > 0, `${prefix}.registry requires a qualified OpenShell image.`);
  const registry = withoutDigest.slice(0, firstSlash);
  const repositoryWithTag = withoutDigest.slice(firstSlash + 1);
  const tagSeparator = repositoryWithTag.lastIndexOf(":");
  const repository =
    tagSeparator === -1 ? repositoryWithTag : repositoryWithTag.slice(0, tagSeparator);
  return [
    `--set-string=${prefix}.registry=${registry}`,
    `--set-string=${prefix}.repository=${repository}`,
    `--set-string=${prefix}.digest=${digest.slice(1)}`,
  ];
}

function renderedOpenShellImage(image) {
  const digest = image.match(/@sha256:[a-f0-9]{64}$/i)?.[0];
  assert.ok(digest, "OpenShell image reference must include an immutable digest.");
  const withoutDigest = image.slice(0, -digest.length);
  const lastSlash = withoutDigest.lastIndexOf("/");
  const tagSeparator = withoutDigest.lastIndexOf(":");
  if (tagSeparator > lastSlash) {
    return `${withoutDigest.slice(0, tagSeparator)}${digest}`;
  }
  return `${withoutDigest}${digest}`;
}

function regexpEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertRenderedOpenShellImages({
  gatewayPod,
  statefulSet,
  configMap,
  gatewayImage,
  sandboxImage,
  supervisorImage,
  defaultTag,
}) {
  const expectedGatewayImage = renderedOpenShellImage(gatewayImage);
  const expectedSandboxImage = renderedOpenShellImage(sandboxImage);
  const expectedSupervisorImage = renderedOpenShellImage(supervisorImage);
  assert.equal(
    statefulSet.metadata?.labels?.["app.kubernetes.io/version"],
    defaultTag,
    "OpenShell gateway StatefulSet must retain the pinned chart application version.",
  );
  assert.equal(
    statefulSet.spec?.template?.spec?.containers?.find(({ name }) => name === "openshell-gateway")
      ?.image,
    expectedGatewayImage,
    "OpenShell gateway StatefulSet image must retain the imported immutable digest after Helm rendering.",
  );
  assert.equal(
    gatewayPod.spec?.containers?.find(({ name }) => name === "openshell-gateway")?.image,
    expectedGatewayImage,
    "OpenShell gateway Pod image must retain the imported immutable digest after Helm rendering.",
  );
  assert.match(
    configMap.data?.["gateway.toml"] ?? "",
    new RegExp(
      `sandbox_runtime_image\\s*=\\s*${regexpEscape(JSON.stringify(expectedSandboxImage))}`,
    ),
    "OpenShell sandbox runtime image in gateway.toml must retain the imported immutable digest after Helm rendering.",
  );
  assert.match(
    configMap.data?.["gateway.toml"] ?? "",
    new RegExp(`supervisor_image\\s*=\\s*${regexpEscape(JSON.stringify(expectedSupervisorImage))}`),
    "OpenShell supervisor image in gateway.toml must retain the imported immutable digest after Helm rendering.",
  );
}

function openShellGatewayServiceName(namespace) {
  return `openshell-${openshellHash(namespace, 10)}`;
}

// OpenShell v0.1.5 runs a separate supervisor Pod per Sandbox; it (not the Harness workload) calls
// the gateway back. Mirrors internal/occdev/kubernetes.go and OpenShell sandbox_runtime.rs labels.
export const openShellSupervisorLabels = Object.freeze({
  "openshell.ai/managed-by": "openshell",
  "openshell.ai/boundary-role": "supervisor",
});

export function openShellGatewayNetworkPolicies(namespace, apiPeers) {
  const gatewayLabels = {
    "app.kubernetes.io/name": "openshell",
    "app.kubernetes.io/instance": openShellGatewayServiceName(namespace),
  };
  const supervisorLabels = { ...openShellSupervisorLabels };
  return {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-openshell-gateway-control-plane", namespace },
        spec: {
          podSelector: { matchLabels: gatewayLabels },
          policyTypes: ["Egress"],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                  },
                },
              ],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            { to: apiPeers, ports: [{ protocol: "TCP", port: 443 }] },
            { to: apiPeers, ports: [{ protocol: "TCP", port: 6443 }] },
          ],
        },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-openshell-gateway-callback", namespace },
        spec: {
          podSelector: { matchLabels: gatewayLabels },
          policyTypes: ["Ingress"],
          ingress: [
            {
              from: [{ podSelector: { matchLabels: supervisorLabels } }],
              ports: [
                { protocol: "TCP", port: gatewayPort },
                { protocol: "TCP", port: 8081 },
              ],
            },
          ],
        },
      },
      {
        // A dedicated Agent Gateway reaches its Codex Harness only through the endpoint OpenShell
        // exposes, so it may call this gateway's service port and nothing else here.
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-openshell-gateway-agent-gateways", namespace },
        spec: {
          podSelector: { matchLabels: gatewayLabels },
          policyTypes: ["Ingress"],
          ingress: [
            {
              from: [
                {
                  podSelector: {
                    matchLabels: {
                      "app.kubernetes.io/managed-by": "openclaw-enterprise",
                      "openclaw.dev/workload-role": "gateway",
                    },
                  },
                },
              ],
              ports: [{ protocol: "TCP", port: gatewayPort }],
            },
          ],
        },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-openshell-sandbox-callback", namespace },
        spec: {
          podSelector: { matchLabels: { ...supervisorLabels } },
          policyTypes: ["Egress"],
          egress: [
            {
              to: [{ podSelector: { matchLabels: { ...gatewayLabels } } }],
              ports: [{ protocol: "TCP", port: gatewayPort }],
            },
          ],
        },
      },
    ],
  };
}

export function createOpenShellKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  // How long a Codex turn observes a command still running when the turn completes. A suite
  // whose probe commands bound themselves (curl --max-time) passes that bound plus a margin.
  codexCommandGraceMs = 5_000,
  // Options for retryModelAtCapacity: a test's fake model reply passes a short delay.
  modelAtCapacityRetry = {},
  databaseUrl,
  openShellGatewayImage,
  openShellSandboxImage,
  openShellSupervisorImage,
  openShellRuntimeClass = "openshell-sandbox",
  openShellHelmPath,
  openShellHelmChart,
  openShellWorkspaceHelmChart,
  openShellChartVersion = "0.1.5",
  commandTimeoutMs,
  signal,
}) {
  const selection = { kubeconfigPath, kubernetesContext };
  const original = createRealKubernetesFixture({
    kubeconfigPath,
    kubernetesContext,
    gatewayImage,
    codexImage,
    databaseUrl,
  });
  if (commandTimeoutMs !== undefined) {
    assert.ok(Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs > 0);
  }
  const base = {
    ...original,
    ...(commandTimeoutMs === undefined
      ? {}
      : createKubernetesClient({
          selection,
          async kubectl(...args) {
            try {
              const { stdout } = await execute("kubectl", original.kubectlArguments(args), {
                timeout: commandTimeoutMs,
                killSignal: "SIGKILL",
                signal,
                maxBuffer: 4 * 1024 * 1024,
              });
              return stdout;
            } catch (error) {
              throw safeKubectlFailure(error, signal);
            }
          },
        })),
  };
  assert.ok(
    Number.isSafeInteger(codexCommandGraceMs) &&
      codexCommandGraceMs > 0 &&
      codexCommandGraceMs <= 60_000,
    "codexCommandGraceMs must be a positive number of milliseconds, at most 60 s.",
  );

  async function kubectl(...args) {
    return base.kubectl(...args);
  }

  async function validatePrerequisites() {
    assert.equal(
      process.env.OCC_TEST_OPENSHELL_K3D_REAL,
      "1",
      "OCC_TEST_OPENSHELL_K3D_REAL=1 is required for the real OpenShell integration.",
    );
    assert.ok(
      process.env.OCC_TEST_OPENSHELL_HARNESS === "openclaw" ||
        process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL?.trim()
        ? process.env.OPENAI_API_KEY
        : process.env.CODEX_ACCESS_TOKEN,
      "The selected Harness requires OPENAI_API_KEY (native or custom endpoint) or CODEX_ACCESS_TOKEN (default Codex).",
    );
    assert.ok(
      openShellHelmPath,
      "OCC_TEST_OPENSHELL_HELM must point at the Helm binary used to install the namespace-scoped OpenShell gateway.",
    );
    assert.ok(
      openShellHelmChart,
      "OCC_TEST_OPENSHELL_HELM_CHART must point at the OpenShell Helm chart or chart archive.",
    );
    assert.ok(
      openShellWorkspaceHelmChart,
      "OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART must point at the OpenShell workspace Helm chart or chart archive.",
    );
    for (const [name, image] of [
      ["OCC_TEST_OPENSHELL_GATEWAY_IMAGE", openShellGatewayImage],
      ["OCC_TEST_OPENSHELL_SANDBOX_IMAGE", openShellSandboxImage],
      ["OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE", openShellSupervisorImage],
    ]) {
      assert.match(
        image ?? "",
        /@sha256:[a-f0-9]{64}$/i,
        `${name} must select a real imported OpenShell image by immutable SHA-256 digest.`,
      );
    }
    await execute("openssl", ["version"], { maxBuffer: 1024 * 1024 });
    await execute(openShellHelmPath, ["show", "chart", openShellHelmChart], {
      maxBuffer: 1024 * 1024,
    });
    await execute(openShellHelmPath, ["show", "chart", openShellWorkspaceHelmChart], {
      maxBuffer: 1024 * 1024,
    });
    const kubeconfig = await base.validatePrerequisites();
    await kubectl("get", "runtimeclass", openShellRuntimeClass, "-o", "json");
    const resources = await kubectl("api-resources", "--api-group=agents.x-k8s.io", "-o", "name");
    assert.match(
      resources,
      /(^|\n)sandboxes(?:\.agents\.x-k8s\.io)?(\n|$)/,
      "the Agent Sandbox CRD must expose sandboxes.agents.x-k8s.io.",
    );
    await waitForControllerPod();
    return kubeconfig;
  }

  async function waitForControllerPod() {
    await base.waitFor(
      "the Agent Sandbox controller to be ready",
      async () => {
        const pods = JSON.parse(
          await kubectl("get", "pods", "--all-namespaces", "-o", "json"),
        ).items;
        const ready = pods.filter((pod) => {
          const name = pod.metadata?.name ?? "";
          const labels = Object.values(pod.metadata?.labels ?? {}).join(" ");
          const looksLikeController = /agent.*sandbox.*controller|sandbox.*controller/i.test(
            `${name} ${labels}`,
          );
          return (
            looksLikeController &&
            pod.status?.conditions?.some(
              ({ type, status }) => type === "Ready" && status === "True",
            )
          );
        });
        return ready.length > 0 ? ready : undefined;
      },
      180_000,
    );
  }

  async function customResources(resource, namespace) {
    return JSON.parse(await kubectl("get", resource, "--namespace", namespace, "-o", "json")).items;
  }

  async function maybeResource(kind, name, namespace) {
    // Keep absence distinct from transport errors without retaining raw stderr.
    const raw = await kubectl(
      "get",
      kind,
      name,
      "--namespace",
      namespace,
      "--ignore-not-found",
      "-o",
      "json",
    );
    return raw.trim() === "" ? undefined : JSON.parse(raw);
  }

  function chartImageValues(prefix, image) {
    return openShellChartImageValues(prefix, image);
  }

  async function ensureOpenShellJwtSecret(namespace) {
    const serviceName = openShellGatewayServiceName(namespace);
    const secretName = `${serviceName}-jwt-keys`;
    if ((await maybeResource("secret", secretName, namespace)) !== undefined) {
      return secretName;
    }

    const directory = await mkdtemp(join(tmpdir(), "openshell-jwt-"));
    const signingPath = join(directory, "signing.pem");
    const publicPath = join(directory, "public.pem");
    const kidPath = join(directory, "kid");
    try {
      await execute("openssl", ["genpkey", "-algorithm", "ed25519", "-out", signingPath], {
        maxBuffer: 1024 * 1024,
      });
      await execute("openssl", ["pkey", "-in", signingPath, "-pubout", "-out", publicPath], {
        maxBuffer: 1024 * 1024,
      });
      await writeFile(kidPath, `openshell-${openshellHash(namespace)}\n`, { mode: 0o600 });
      try {
        await kubectl(
          "create",
          "secret",
          "generic",
          secretName,
          "--namespace",
          namespace,
          `--from-file=signing.pem=${signingPath}`,
          `--from-file=public.pem=${publicPath}`,
          `--from-file=kid=${kidPath}`,
        );
      } catch (error) {
        if (!/AlreadyExists|already exists/i.test(error.stderr ?? error.message)) {
          throw error;
        }
      }
      return secretName;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  function apiCidr(address) {
    return address.includes(":") ? `${address}/128` : `${address}/32`;
  }

  async function kubernetesApiPeers() {
    const service = JSON.parse(
      await kubectl("get", "service", "kubernetes", "--namespace", "default", "-o", "json"),
    );
    const endpoints = JSON.parse(
      await kubectl("get", "endpoints", "kubernetes", "--namespace", "default", "-o", "json"),
    );
    const addresses = new Set();
    if (service.spec?.clusterIP && service.spec.clusterIP !== "None") {
      addresses.add(service.spec.clusterIP);
    }
    for (const subset of endpoints.subsets ?? []) {
      for (const address of subset.addresses ?? []) {
        if (typeof address.ip === "string") {
          addresses.add(address.ip);
        }
      }
    }
    assert.ok(
      addresses.size > 0,
      "the OpenShell gateway requires a Kubernetes API NetworkPolicy peer.",
    );
    return [...addresses].map((address) => ({ ipBlock: { cidr: apiCidr(address) } }));
  }

  async function applyOpenShellGatewayNetworkPolicies(namespace) {
    const policies = openShellGatewayNetworkPolicies(namespace, await kubernetesApiPeers());
    const directory = await mkdtemp(join(tmpdir(), "openshell-networkpolicy-"));
    const path = join(directory, "networkpolicies.json");
    try {
      await writeFile(path, JSON.stringify(policies), { mode: 0o600 });
      await kubectl("apply", "--namespace", namespace, "-f", path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Installs the Namespace's gateway. `extraTrustPem` adds a private CA through the chart's
   * extra volume settings. The gateway image sets SSL_CERT_FILE to its CA bundle, so its TLS
   * stack reads only that file: the mount replaces it with the public roots plus the CA, and a
   * gateway-owned refresh can then reach an issuer whose certificate that CA signs.
   */
  async function installOpenShellGateway(
    namespace,
    { sandboxServiceAccountName, extraTrustPem } = {},
  ) {
    await kubectl(
      "label",
      "namespace",
      namespace,
      "openshell.ai/openclaw-workspace=true",
      "--overwrite",
    );
    await applyOpenShellGatewayNetworkPolicies(namespace);
    await ensureOpenShellJwtSecret(namespace);
    const instance = openShellGatewayServiceName(namespace);
    // Workspace preparation uses the chart-owned default account before an Agent's
    // account is selected. Keep that account across later Gateway reconfiguration.
    const workspaceValues = [
      `--set-string=fullnameOverride=${instance}-workspace`,
      "--set=gateway.allowDriverConfig=true",
      `--set-string=gateway.serviceAccount.name=${instance}`,
      `--set-string=gateway.serviceAccount.namespace=${namespace}`,
      `--set-string=gateway.networkPolicy.podSelector.app\\.kubernetes\\.io/instance=${instance}`,
    ];
    await execute(
      openShellHelmPath,
      [
        "upgrade",
        "--install",
        `${instance}-workspace`,
        openShellWorkspaceHelmChart,
        "--namespace",
        namespace,
        "--kubeconfig",
        kubeconfigPath,
        "--kube-context",
        kubernetesContext,
        "--wait",
        "--timeout",
        "240s",
        ...workspaceValues,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const values = [
      `--set-string=fullnameOverride=${instance}`,
      "--set=pkiInitJob.enabled=false",
      "--set=server.disableTls=true",
      "--set=server.auth.allowUnauthenticatedUsers=true",
      "--set=server.drivers.kubernetes.allowDriverConfig=true",
      // The gateway rejects every Sandbox template label it does not allow; Harness
      // Pods carry the OCE selector labels that NetworkPolicies and Services match.
      '--set-json=gatewayConfig.openshell\\.drivers\\.kubernetes.allowed_pod_labels=["openclaw.dev/*","app.kubernetes.io/name","app.kubernetes.io/managed-by"]',
      "--set=server.drivers.kubernetes.resourceAdmission.enabled=false",
      "--set-string=server.drivers.kubernetes.workspaceMode=operator",
      "--set-string=server.drivers.kubernetes.operatorNamespaceLabel=openshell.ai/openclaw-workspace=true",
      "--set=workspaceResources.enabled=false",
      "--set=podSecurityContext.seccompProfile.type=RuntimeDefault",
      `--set-string=server.defaultRuntimeClassName=${openShellRuntimeClass}`,
      ...chartImageValues("gateway.image", openShellGatewayImage),
      ...chartImageValues("sandboxRuntime.image", openShellSandboxImage),
      ...chartImageValues("supervisor.image", openShellSupervisorImage),
    ];
    if (sandboxServiceAccountName !== undefined) {
      values.push("--set=sandboxServiceAccount.create=false");
      values.push(`--set-string=sandboxServiceAccount.name=${sandboxServiceAccountName}`);
    }
    if (extraTrustPem !== undefined) {
      const trust = "oce-gateway-extra-trust";
      const directory = await mkdtemp(join(tmpdir(), "openshell-gateway-trust-"));
      const path = join(directory, "configmap.json");
      try {
        await writeFile(
          path,
          JSON.stringify({
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: { name: trust, namespace },
            data: { "ca.crt": [...rootCertificates, extraTrustPem].join("\n") },
          }),
          { mode: 0o600 },
        );
        // The bundle exceeds what client-side apply can record in its annotation.
        await kubectl("apply", "--server-side", "--namespace", namespace, "-f", path);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      values.push(
        `--set-string=server.extraVolumes[0].name=${trust}`,
        `--set-string=server.extraVolumes[0].configMap.name=${trust}`,
        `--set-string=server.extraVolumeMounts[0].name=${trust}`,
        "--set-string=server.extraVolumeMounts[0].mountPath=/etc/ssl/certs/ca-certificates.crt",
        "--set-string=server.extraVolumeMounts[0].subPath=ca.crt",
        "--set=server.extraVolumeMounts[0].readOnly=true",
      );
    }

    await execute(
      openShellHelmPath,
      [
        "upgrade",
        "--install",
        openShellGatewayServiceName(namespace),
        openShellHelmChart,
        "--namespace",
        namespace,
        "--kubeconfig",
        kubeconfigPath,
        "--kube-context",
        kubernetesContext,
        "--wait",
        "--timeout",
        "240s",
        ...values,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const gateway = await waitForOpenShellGateway(namespace);
    assertRenderedOpenShellImages({
      gatewayPod: gateway,
      statefulSet: await base.resource("statefulset", instance, namespace),
      configMap: await base.resource("configmap", `${instance}-config`, namespace),
      gatewayImage: openShellGatewayImage,
      sandboxImage: openShellSandboxImage,
      supervisorImage: openShellSupervisorImage,
      defaultTag: openShellChartVersion,
    });
    return gateway;
  }

  async function startOpenShellGatewayPortForward(namespace) {
    return await base.startPortForward(namespace, openShellGatewayServiceName(namespace));
  }

  async function readAgentTransportCredentials(namespace, agentId) {
    const suffix = openshellHash(agentId);
    const secret = await base.resource("secret", `${transportSecretPrefix}-${suffix}`, namespace);
    const encodedToken = secret.data?.["app-server-token"];
    assert.equal(typeof encodedToken, "string", "the generated transport token must exist");
    return { appServerToken: Buffer.from(encodedToken, "base64").toString() };
  }

  async function waitForOpenShellGateway(namespace) {
    return await base.waitFor(
      "the namespace-scoped OpenShell gateway",
      async () => {
        const pods = await base.resources("pods", namespace);
        const instance = openShellGatewayServiceName(namespace);
        const ready = pods.filter((pod) => {
          const labels = pod.metadata?.labels ?? {};
          return (
            labels["app.kubernetes.io/name"] === "openshell" &&
            labels["app.kubernetes.io/instance"] === instance &&
            pod.status?.conditions?.some(
              ({ type, status }) => type === "Ready" && status === "True",
            )
          );
        });
        return ready.length === 1 ? ready[0] : undefined;
      },
      240_000,
    );
  }

  async function findSandbox(namespace, revision) {
    const resources = await customResources(sandboxApiResource, namespace);
    const sandboxName = `os-${openshellHash(revision.id, 16)}`;
    return resources.find(
      (sandbox) => sandbox.metadata?.labels?.["openshell.ai/sandbox-name"] === sandboxName,
    );
  }

  async function waitForSandbox(namespace, revision) {
    return await base.waitFor(
      `OpenShell Sandbox for revision ${revision.id}`,
      async () => {
        return (await findSandbox(namespace, revision)) ?? undefined;
      },
      240_000,
    );
  }

  async function waitForProviderHarnessPod(namespace, revision) {
    const pod = await base.waitFor(
      `OpenShell-owned Harness Pod for revision ${revision.id}`,
      async () => {
        const pods = await base.resources("pods", namespace);
        return pods.find(
          (pod) =>
            pod.metadata?.labels?.["openclaw.dev/workload-role"] === "agent" &&
            pod.metadata?.labels?.["openclaw.dev/agent"] === revision.agentId &&
            pod.metadata?.labels?.["openclaw.dev/revision"] === revision.id &&
            pod.status?.conditions?.some(
              ({ type, status }) => type === "Ready" && status === "True",
            ),
        );
      },
      360_000,
    );
    // Compute gives the Sandbox the provider-fenced profile: the Pod keeps Gateway transport
    // ingress but receives none of Compute's DNS, model or auth egress, so OpenShell's own
    // egress fence is not unioned away.
    assert.equal(
      pod.metadata.labels?.["openclaw.dev/network-profile"],
      "provider-fenced-v1",
      "the OpenShell-owned Harness Pod must carry the provider-fenced network profile.",
    );
    return pod;
  }

  async function assertProviderOwnedHarness(
    namespace,
    revision,
    sandbox,
    pod,
    profile = "perAgent",
  ) {
    assertOpenShellHarnessBinding(namespace, revision, sandbox, pod, profile);
    assert.equal(
      await maybeResource("deployment", openShellRevisionName(revision), namespace),
      undefined,
      "OpenShell-selected dedicated revisions must not also create a Compute-owned Harness Deployment.",
    );
  }

  function harnessContainer(pod) {
    const container = pod.spec.containers.find(({ name }) => name === "agent");
    assert.ok(container, "provider-owned Pod must contain the Codex Harness container.");
    const environment = container.env ?? [];
    assert.equal(
      environment.some(({ name }) => name === "APP_SERVER_TOKEN"),
      false,
      "the raw app-server token must stay outside the OpenShell Harness Pod spec.",
    );
    assert.match(
      environment.find(({ name }) => name === "APP_TOKEN_SHA")?.value ?? "",
      /^[a-f0-9]{64}$/,
      "the OpenShell Harness requires only its app-server token verifier.",
    );
    return container;
  }

  function assertWorkspaceMounts(pod) {
    const container = harnessContainer(pod);
    const revisionId = pod.metadata.labels?.["openclaw.dev/revision"];
    assert.equal(typeof revisionId, "string");
    const workspaceVolumes = new Set(
      (pod.spec.volumes ?? [])
        .filter(({ persistentVolumeClaim }) => persistentVolumeClaim?.claimName)
        .map(({ name }) => name),
    );
    const mounts = (container.volumeMounts ?? [])
      .filter(({ name }) => workspaceVolumes.has(name))
      .map(({ mountPath, readOnly = false, subPath }) => ({ mountPath, readOnly, subPath }))
      .sort((left, right) => left.subPath.localeCompare(right.subPath));
    // OpenShell replaces the agent container command with its own supervisor entrypoint, so the
    // bootstrap that links each relocated mount is not visible in the Pod. The caller verifies
    // these links inside the running Sandbox.
    const links = [];
    for (const required of requiredWorkspaceMounts) {
      const observed = mounts.find(({ subPath }) => subPath === required.subPath);
      assert.ok(
        observed,
        `the Harness must preserve workspace subpath ${required.subPath}; observed ${mounts
          .map(({ subPath }) => subPath)
          .join(", ")}.`,
      );
      assert.equal(observed.readOnly, required.readOnly);
      if (required.mountPath === "/sandbox/enterprise") {
        assert.equal(observed.mountPath, required.mountPath);
      } else {
        assert.match(observed.mountPath, /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}$/u);
        links.push({ path: required.mountPath, target: observed.mountPath });
      }
    }
    assert.equal(
      mounts.some(({ subPath, mountPath }) => subPath === "" || mountPath === "/"),
      false,
      "the Harness must never mount the PVC root.",
    );
    assert.equal(
      mounts.some(
        ({ mountPath, readOnly, subPath }) =>
          mountPath === "/sandbox/enterprise" && readOnly === false && subPath === "workspace",
      ),
      true,
      "the integration fixture must add the approved /sandbox descendant alias required by OpenShell.",
    );
    assert.equal(
      mounts.some(
        ({ mountPath, readOnly, subPath }) =>
          mountPath === "/sandbox/.openclaw-runtime" &&
          readOnly === false &&
          subPath === `openshell-runtime-${openshellHash(revisionId, 16)}`,
      ),
      true,
      "the Harness requires a revision-scoped writable runtime root.",
    );
    assert.equal(
      mounts.some(
        ({ mountPath }) =>
          mountPath !== "/sandbox/.openclaw-runtime" &&
          mountPath.startsWith("/sandbox/.openclaw-runtime/"),
      ),
      false,
      "nested PVC mounts must not let kubelet create non-writable runtime-home parents.",
    );
    return links;
  }

  async function assertServicePrincipalTokenProjection(namespace, pod, expected) {
    const container = harnessContainer(pod);
    const volumes = (pod.spec.volumes ?? []).filter(
      ({ name }) => name === "openclaw-service-principal",
    );
    assert.equal(volumes.length, 1, "the Harness requires its own Enterprise token projection.");
    assert.deepEqual(volumes[0].projected?.sources, [
      {
        serviceAccountToken: {
          audience: expected.audience,
          expirationSeconds: expected.expirationSeconds,
          path: "token",
        },
      },
    ]);
    const mounts = (container.volumeMounts ?? []).filter(
      ({ name }) => name === "openclaw-service-principal",
    );
    assert.deepEqual(mounts, [
      {
        name: "openclaw-service-principal",
        mountPath: "/var/run/secrets/openclaw/service-principal",
        readOnly: true,
      },
    ]);

    // Read the kubelet-projected JWT inside the actual provider-owned container without exposing
    // its bearer value; claims prove audience and exact per-Agent Kubernetes ServiceAccount.
    const script = [
      'const token = require("node:fs").readFileSync(process.argv[1], "utf8").trim();',
      'const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());',
      "process.stdout.write(JSON.stringify({ aud: claims.aud, sub: claims.sub }));",
    ].join(" ");
    const claims = JSON.parse(
      await kubectl(
        "exec",
        pod.metadata.name,
        "--namespace",
        namespace,
        "--container",
        container.name,
        "--",
        "node",
        "-e",
        script,
        "/var/run/secrets/openclaw/service-principal/token",
      ),
    );
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    assert.deepEqual(audiences, [expected.audience]);
    assert.equal(claims.sub, `system:serviceaccount:${namespace}:${pod.spec.serviceAccountName}`);
  }

  function assertApprovedOpenShellPrivileges(pod) {
    assert.equal(
      pod.spec.runtimeClassName,
      openShellRuntimeClass,
      "OpenShell Pods must use the trusted RuntimeClass selected for the admission exemption.",
    );
    const initCapabilities = new Set(
      (pod.spec.initContainers ?? []).flatMap(
        (container) => container.securityContext?.capabilities?.add ?? [],
      ),
    );
    assert.deepEqual(
      [...initCapabilities],
      [],
      "OpenShell v0.1.5 must not add capabilities to workload Pod init containers.",
    );
    const networkSidecar = pod.spec.containers.find(({ name }) =>
      ["openshell-network", "openshell-supervisor-network"].includes(name),
    );
    assert.equal(
      networkSidecar,
      undefined,
      "OpenShell v0.1.5 must keep its network supervisor outside the workload Pod.",
    );
    const container = pod.spec.containers.find(({ name }) => name === "agent");
    assert.ok(container, "the provider-owned Pod must contain its Agent container.");
    assert.equal(container.securityContext?.allowPrivilegeEscalation, false);
    assert.deepEqual(container.securityContext?.capabilities?.drop, ["ALL"]);
    assert.notEqual(container.securityContext?.runAsUser, 0);
    assert.equal(
      container.securityContext?.runAsUser ?? pod.spec.securityContext?.runAsUser,
      OPENSHELL_KUBERNETES_WORKLOAD_IDENTITY.uid,
      "OpenShell workload identity must match the fixture's private-storage owner.",
    );
    assert.equal(
      container.securityContext?.runAsGroup ?? pod.spec.securityContext?.runAsGroup,
      OPENSHELL_KUBERNETES_WORKLOAD_IDENTITY.gid,
      "OpenShell workload group must match the fixture's private-storage owner.",
    );
  }

  async function assertGatewayBootstrapPolicies(namespace) {
    const policies = await base.resources("networkpolicies", namespace);
    assert.ok(
      policies.some(({ metadata }) => /openshell/i.test(metadata.name)),
      "SandboxDriver.ensureNamespace must install provider-specific NetworkPolicies.",
    );
  }

  async function assertNoSecretBytes(namespace, secrets) {
    const redacted = secrets.filter(Boolean);
    const [pods, configMaps] = await Promise.all([
      base.resources("pods", namespace),
      base.resources("configmaps", namespace),
    ]);
    const document = JSON.stringify({ pods, configMaps });
    for (const secret of redacted) {
      assert.equal(
        document.includes(secret),
        false,
        "Kubernetes metadata must not expose secrets.",
      );
    }
  }

  async function requestCodexFromPod({
    namespace,
    pod,
    container,
    providerModel,
    prompt,
    appServerUrl,
    appServerTokenPath,
    readThreadId,
    observeFailure = false,
    timeoutMs = 300_000,
  }) {
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000);
    const script = String.raw`
      const appServerUrl = ${JSON.stringify(appServerUrl)} ?? process.env.APP_SERVER_URL;
      const appServerToken = ${
        appServerTokenPath === undefined
          ? "process.env.APP_SERVER_TOKEN"
          : `require("node:fs").readFileSync(${JSON.stringify(appServerTokenPath)}, "utf8")`
      };
      // While a command's terminal is awaited, running out of time leaves its outcome unknown.
      const timeout = setTimeout(() => commandDeadline ? unknownCommandOutcome() : fail(new Error("Codex harness turn timed out")), ${timeoutMs});
      const pending = new Map();
      const items = [];
      const pendingCommands = new Map();
      let threadId, turnId, commandDeadline, turnCompletedAt, turnStatus, turnError;
      // A final error that ended the turn while a command ran: reported once that command's
      // terminal is observed, or with the outcome unknown when the grace expires first.
      let finalError;
      // Start time and output volume of each command, never its output.
      const commandTimes = new Map();
      let nextId = 1;
      let assistant = "";
      let finished = false;
      let failedCommands = 0;
      let approvalRequests = 0;
      // Whether the turn began anything that can act: a command, file change, tool call or
      // approval. Only a turn that failed before any of these is safe to run again.
      let actionSeen = false;
      const sandboxSignals = new Set();

      function rememberFailureSignals(message) {
        if (message.id !== undefined && message.method === "item/commandExecution/requestApproval") {
          approvalRequests += 1;
        }
        const item = message.params?.item;
        if (message.method === "item/completed" && item?.type === "commandExecution" && Number.isSafeInteger(item.exitCode) && item.exitCode !== 0) {
          failedCommands += 1;
        }
        // Retain only fixed labels from command output, never prompts, commands or payloads.
        let output;
        if (item?.type === "commandExecution") {
          output = item.aggregatedOutput;
        } else if (message.method === "item/commandExecution/outputDelta") {
          output = message.params?.delta;
        }
        if (typeof output !== "string") {
          return;
        }
        for (const [pattern, label] of [
          [/bubblewrap|bwrap/i, "bubblewrap"],
          [/user namespace|new namespace|unshare|CLONE_NEWUSER/i, "namespace"],
          [/operation not permitted|permission denied/i, "permission_denied"],
          [/filesystem-restricted execution requires bubblewrap/i, "restricted_requires_bubblewrap"],
        ]) {
          if (pattern.test(output.slice(0, 16384))) {
            sandboxSignals.add(label);
          }
        }
      }

      // Timing of commands still running, so an unknown outcome says how long it waited.
      function pendingCommandTimes() {
        const now = performance.now();
        return [...pendingCommands.keys()].map((id) => {
          const { startedAt, deltas = 0, bytes = 0 } = commandTimes.get(id) ?? {};
          return {
            startedBeforeTurnEndMs: startedAt !== undefined && turnCompletedAt !== undefined
              ? Math.floor(turnCompletedAt - startedAt) : null,
            runningMs: startedAt === undefined ? null : Math.floor(now - startedAt),
            outputDeltas: deltas,
            outputBytes: bytes,
          };
        });
      }

      // Diagnostics only: the caller never decides from stderr whether to run the turn again.
      function writeFailure(error, retrySafe) {
        clearTimeout(timeout);
        process.stderr.write(${observeFailure}
            ? "Codex harness failed before its terminal result"
            : (error?.stack || String(error)));
        process.stderr.write("\nNative execution summary: " + JSON.stringify({
          failedCommands, approvalRequests, sandboxSignals: [...sandboxSignals],
          commandGraceMs: ${codexCommandGraceMs},
          sinceTurnEndMs: turnCompletedAt === undefined ? null : Math.floor(performance.now() - turnCompletedAt),
          retrySafe,
          pendingCommands: pendingCommandTimes(),
        }));
      }

      function fail(error) {
        writeFailure(error, false);
        process.exit(1);
      }

      // The only way the caller may run this turn again: a dedicated exit status and an exact
      // stdout receipt, for our own turn's final at-capacity error before any action.
      function failRetrySafe(error) {
        finished = true;
        writeFailure(error, true);
        process.stdout.write(${JSON.stringify(modelAtCapacityReceipt)}, () => process.exit(${modelAtCapacityExitCode}));
      }

      function unknownCommandOutcome() {
        const unknown = "Codex command outcome is unknown; not sending another turn";
        fail(new Error(finalError === undefined ? unknown : finalError.message + "\n" + unknown));
      }

      function waitForCommandDeadline() {
        // A timer can wake early. Keep the deadline anchored to the end of the turn.
        const remaining = turnCompletedAt + ${codexCommandGraceMs} - performance.now();
        if (remaining <= 0) return unknownCommandOutcome();
        commandDeadline = setTimeout(waitForCommandDeadline, Math.ceil(remaining));
      }

      function finish() {
        clearTimeout(commandDeadline);
        // The turn failed while a command ran; that command's terminal is now observed (and
        // counted in the summary), and the turn still fails.
        if (finalError !== undefined) return fail(finalError);
        finished = true;
        clearTimeout(timeout);
        // Exit once the result is flushed. Through the OpenShell service route the WebSocket
        // close handshake never completes, so waiting for it would hold kubectl exec open.
        process.stdout.write(JSON.stringify({ assistant, items,
          ...(${observeFailure} ? { status: turnStatus, error: turnError } : {})
        }), () => process.exit(0));
      }

      function request(method, params = {}) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { method, resolve, reject });
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      }

      const socket = new WebSocket(appServerUrl, {
        headers: { authorization: "Bearer " + appServerToken },
      });

      socket.addEventListener("open", async () => {
        try {
          await request("initialize", {
            clientInfo: { name: "openclaw-enterprise-openshell-integration", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          });
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
          if (${JSON.stringify(readThreadId)} !== undefined) {
            const result = await request("thread/read", {
              threadId: ${JSON.stringify(readThreadId)}, includeTurns: true,
            });
            finished = true;
            clearTimeout(timeout);
            process.stdout.write(JSON.stringify(result.thread), () => process.exit(0));
            return;
          }
          // A Gateway serving an OpenShell Harness names the Sandbox workspace root; Codex
          // cannot start exec tools in a working directory that does not exist there.
          const workspace = process.env.OPENCLAW_REMOTE_WORKSPACE_ROOT ?? "/home/node/workspace";
          const started = await request("thread/start", {
            cwd: workspace,
            model: ${JSON.stringify(providerModel)},
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            permissions: ":danger-full-access",
            config: { project_doc_max_bytes: 131072 },
          });
          // Fail before inference when account policy refuses the outer-sandbox mode.
          if (started.sandbox?.type !== "dangerFullAccess") {
            throw new Error("OpenShell requires the Codex account to allow :danger-full-access.");
          }
          threadId = started.thread.id;
          await request("turn/start", {
            threadId,
            input: [{ type: "text", text: ${JSON.stringify(prompt)} }],
            permissions: ":danger-full-access",
          });
        } catch (error) {
          fail(error);
        }
      });

      socket.addEventListener("message", ({ data }) => {
        if (finished) return;
        const message = JSON.parse(String(data));
        if (${JSON.stringify(readThreadId)} !== undefined && message.id === undefined) return;
        const { method, params } = message;
        const item = params?.item;
        // Any server request (an approval of any API version) counts as an action too.
        if ((item?.type !== undefined && !["userMessage", "agentMessage", "reasoning"].includes(item.type)) ||
            (message.id !== undefined && method !== undefined) || String(method).endsWith("/outputDelta")) {
          actionSeen = true;
        }
        const decline = message.id !== undefined && (
          method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval"
        );
        const commandEvent = item?.type === "commandExecution" &&
          (method === "item/started" || method === "item/completed");
        const command = commandEvent && threadId && turnId &&
          params.threadId === threadId && params.turnId === turnId;
        // Before the turn ends, an unbound command leaves the probe outcome unknown.
        // Afterward we observe only the commands already outstanding on our turn.
        if (!commandDeadline && commandEvent && !command) return unknownCommandOutcome();
        const starting = method === "item/started" && command;
        const ending = method === "item/completed" && command;
        if (method === "item/commandExecution/outputDelta" && params?.turnId === turnId &&
            commandTimes.has(params.itemId)) {
          const time = commandTimes.get(params.itemId);
          time.deltas += 1;
          time.bytes += typeof params.delta === "string" ? params.delta.length : 0;
        }
        if (commandDeadline) {
          if (starting) return unknownCommandOutcome();
          if (ending) {
            // Only a terminal matching a command outstanding at turn completion can
            // settle it. Never discard a second command and then report only the first.
            if (!pendingCommands.has(item.id) || pendingCommands.get(item.id) !== item.command ||
                !["completed", "failed"].includes(item.status) || !Number.isSafeInteger(item.exitCode)) {
              return unknownCommandOutcome();
            }
          } else if (!decline) return;
        }
        rememberFailureSignals(message);
        items.push(message);
        if (starting) {
          pendingCommands.set(item.id, item.command);
          commandTimes.set(item.id, { startedAt: performance.now(), deltas: 0, bytes: 0 });
        }
        if (ending) {
          pendingCommands.delete(item.id);
          if (commandDeadline && !pendingCommands.size) finish();
          return;
        }
        if (decline) {
          // Boundary probes must observe denials, never grant escalation or wait for a human.
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } }));
          return;
        }
        if (message.id !== undefined && method === undefined) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (entry) {
            if (message.error) return entry.reject(new Error(message.error.message));
            if (entry.method === "turn/start") {
              // Notifications can arrive in this socket read, before an await continuation runs.
              const id = message.result?.turn?.id;
              if (typeof id !== "string" || !id) return fail(new Error("Codex turn/start returned no turn ID"));
              turnId = id;
            }
            entry.resolve(message.result);
          }
        } else if (method === "item/completed") {
          if (item?.type === "agentMessage") assistant = item.text ?? "";
        } else if (message.method === "turn/completed") {
          const status = params?.turn?.status;
          if (params?.threadId !== threadId || params?.turn?.id !== turnId) {
            fail(new Error("Codex completed a different turn"));
            return;
          }
          if (status !== "completed" && !(${observeFailure} && status === "failed")) {
            fail(new Error("Codex harness turn did not complete successfully"));
            return;
          }
          turnStatus = status;
          turnError = params?.turn?.error;
          // A command can outlive its turn: Codex returns a long command to the model, which
          // may reply before it ends. Observe only its original socket until its completion
          // event or the fixture's bound; the overall turn deadline still applies. Never extend
          // either deadline on activity.
          turnCompletedAt = performance.now();
          if (pendingCommands.size) waitForCommandDeadline();
          else finish();
        } else if (message.method === "error" && message.params?.willRetry !== true) {
          // Enforcement tests need the real terminal failed turn, not an exception
          // that could also represent a broken WebSocket or kubectl transport.
          if (${observeFailure}) return;
          // Codex reports retried model reconnects as errors; only a final error ends the turn,
          // and turn/completed still requires a completed status.
          const error = new Error(message.params?.error?.message || "Codex harness turn failed");
          if (pendingCommands.size) {
            // A command already started: observe its original socket for its terminal, within
            // the same bound as after turn/completed, so the failure keeps that evidence.
            finalError = error;
            turnCompletedAt = performance.now();
            waitForCommandDeadline();
            return;
          }
          // Only our own turn's final at-capacity error, before any action, is safe to run again.
          const ours = typeof threadId === "string" && typeof turnId === "string" &&
            params?.threadId === threadId && params?.turnId === turnId && params?.willRetry === false;
          if (ours && !actionSeen && /^Selected model is at capacity\./.test(error.message)) {
            return failRetrySafe(error);
          }
          fail(error);
        }
      });
      socket.addEventListener("error", () => {
        if (finished) return;
        if (commandDeadline) return unknownCommandOutcome();
        fail(new Error("Codex harness connection failed"));
      });
      socket.addEventListener("close", () => {
        if (finished) return;
        if (commandDeadline) return unknownCommandOutcome();
        fail(new Error("Codex harness connection closed before completion"));
      });
    `;
    const containerArguments = container === undefined ? [] : ["--container", container];
    return JSON.parse(
      await retryModelAtCapacity(
        () =>
          kubectl(
            "exec",
            pod,
            "--namespace",
            namespace,
            ...containerArguments,
            "--",
            "node",
            "-e",
            script,
          ),
        modelAtCapacityRetry,
      ),
    );
  }

  async function readCodexThreadFromGatewayPod({ namespace, gatewayPod, threadId }) {
    assert.ok(typeof threadId === "string" && threadId.length > 0);
    return requestCodexFromPod({ namespace, pod: gatewayPod, readThreadId: threadId });
  }

  async function requestCodexTurnFromGatewayPod({
    namespace,
    gatewayPod,
    providerModel,
    prompt,
    observeFailure = false,
    timeoutMs = 300_000,
  }) {
    return requestCodexFromPod({
      namespace,
      pod: gatewayPod,
      providerModel,
      prompt,
      observeFailure,
      timeoutMs,
    });
  }

  async function requestCodexTurnFromOpenShellHarnessPod({
    namespace,
    harnessPod,
    providerModel,
    prompt,
    appServerTokenPath,
  }) {
    return requestCodexFromPod({
      namespace,
      pod: harnessPod,
      container: "agent",
      providerModel,
      prompt,
      appServerUrl: `ws://127.0.0.1:${harnessPort}`,
      appServerTokenPath,
    });
  }

  async function startGatewayPortForward(namespace, serviceName) {
    return await base.startPortForward(namespace, serviceName);
  }

  return {
    ...base,
    validateOpenShellPrerequisites: validatePrerequisites,
    customResources,
    maybeResource,
    readAgentTransportCredentials,
    waitForOpenShellGateway,
    installOpenShellGateway,
    startOpenShellGatewayPortForward,
    waitForSandbox,
    waitForProviderHarnessPod,
    assertProviderOwnedHarness,
    assertWorkspaceMounts,
    assertServicePrincipalTokenProjection,
    assertApprovedOpenShellPrivileges,
    assertGatewayBootstrapPolicies,
    assertNoSecretBytes,
    requestCodexTurnFromGatewayPod,
    readCodexThreadFromGatewayPod,
    requestCodexTurnFromOpenShellHarnessPod,
    startGatewayPortForward,
  };
}
