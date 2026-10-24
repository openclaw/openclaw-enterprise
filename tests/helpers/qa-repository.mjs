import { GATEWAY_STOP_TIMEOUT_MS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { cleanupRepositoryJourney } from "./repository-remote-cleanup.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { allowsPushRef } from "../../apps/controller/src/drivers/repo/credentials/client-contracts.ts";
import {
  PREPARED_REPOSITORY_DIRECTORY,
  REPOSITORY_CONTROL_SOCKET,
  REPOSITORY_REGISTRY_PATH,
  preparedRepositoryBackend,
  preparedRepositoryInstallation,
} from "../../scripts/lib/prepared-repository-installation.mjs";
import { verifyNativeRepositoryJourney } from "./repository-native-journey.mjs";
import { createGitHubAppRepositoryObserver } from "./github-app-observer.mjs";
import {
  createRepositoryObserver,
  readInstalledCredentialSession,
} from "./repository-credentials-installed.mjs";
import { loadYaml, dumpYaml, waitFor } from "./qa-utils.mjs";
import { protectedText, redactedQaTail, registerQaSecret } from "./qa-secrets.mjs";

/** The one run-owned branch that every repository scenario of a QA run may push. */
export function qaRepositoryBranch(suffix) {
  return `oce-qa-${suffix}`;
}

/**
 * Narrow the selected registry to what prepared native Git can serve. The worker
 * refuses any policy but git-write on exactly one branch with explicit Git
 * transport (PREPARED_REPOSITORY_REQUIRES_ONE_EXPLICIT_REVIEW_REF), and `occ dev up`
 * refuses it before touching the cluster. git-only grants no PR route, so the QA
 * journey pushes and stops there. Only narrowing is allowed: each policy must
 * already grant a write profile, and one that lists push refs must authorize the
 * run-owned branch.
 */
export function grantQaRepositoryBranch(registry, suffix) {
  assert.equal(registry.repositories.length, 1, "select exactly one authorized repository");
  const ref = `refs/heads/${qaRepositoryBranch(suffix)}`;
  for (const policy of registry.repositories[0].namespaces) {
    // Narrow a write grant; never turn a read-only policy into one.
    assert.ok(
      policy.profiles?.some((profile) => profile === "git-write" || profile === "git-full"),
      "selected registry must already grant git-write or git-full",
    );
    if (policy.pushRefAllowlist) {
      assert.ok(
        allowsPushRef(policy.pushRefAllowlist, ref),
        "selected registry must authorize the run-owned branch name",
      );
    }
    policy.profiles = ["git-write"];
    policy.transport = "git-only";
    policy.pushRefAllowlist = [ref];
    delete policy.pullRequestBase;
    delete policy.draftPullLimit;
  }
  return registry;
}

/** The repository service's own configuration: it sends native Git and holds no App key. */
export function qaRepositoryServiceConfig(registry, host) {
  return {
    gateway: {
      listen: "0.0.0.0:8443",
      publicOrigin: `https://${host}`,
      controlSocket: REPOSITORY_CONTROL_SOCKET,
      tlsCertFile: "/etc/openclaw/repository-ca/ca.crt",
      tlsKeyFile: "/etc/openclaw/repository-inputs/tls.key",
    },
    sessionPolicy: {
      maximumDurationSeconds: registry.maximumDurationSeconds,
      defaultProfile: "git-write",
      allowedProfiles: ["git-write"],
    },
    backend: {
      kind: "github-prepared-git-registry",
      backendId: registry.backendId,
      registryFile: REPOSITORY_REGISTRY_PATH,
    },
  };
}

/** Point the Installation at the Compose repository service through the relay. */
export function applyQaRepositoryInstallation(configuration, registry, podLabels) {
  configuration.backend = [preparedRepositoryBackend({ backendId: registry.backendId })];
  delete configuration.drivers.repo;
  configuration.repository = preparedRepositoryInstallation({
    sessionDurationSeconds: registry.maximumDurationSeconds,
  });
  configuration.drivers.compute.configuration.network.repositoryCredentials = {
    namespace: "oce-system",
    podLabels,
    port: 8443,
  };
  return configuration;
}

export async function prepareQaRepository(f) {
  const input = f.repositoryInput;
  assert.ok(input, "OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY is required");
  const registry = JSON.parse(
    await protectedText(join(input, "registry.json"), "repository registry"),
  );
  assert.equal(
    registry.repositories.length,
    1,
    "select exactly one authorized disposable repository",
  );
  const entry = registry.repositories[0];
  // createQaInstallation wrote the registry through grantQaRepositoryBranch.
  assert.deepEqual(entry.namespaces[0].profiles, ["git-write"]);
  assert.deepEqual(entry.namespaces[0].pushRefAllowlist, [
    `refs/heads/${qaRepositoryBranch(f.suffix)}`,
  ]);
  f.repositoryEntry = entry;
  if (f.controlPlane === "kubernetes") {
    return;
  }
  entry.namespaces = [{ ...entry.namespaces[0], namespaceId: f.namespace.id }];
  const directory = join(f.directory, "repository");
  for (const child of ["registry", "inputs", "ca", "control/private", "prepared"]) {
    await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  }
  const write = async (name, value) =>
    writeFile(join(directory, name), typeof value === "string" ? value : JSON.stringify(value), {
      mode: 0o600,
    });
  await write("registry/registry.json", registry);
  // Only the worker holds the App key and the custody key that seals the tokens it prepares.
  await write(
    "prepared/private-key.pem",
    await protectedText(join(input, "private-key.pem"), "repository App key"),
  );
  await writeFile(join(directory, "prepared/custody.key"), randomBytes(32), { mode: 0o600 });
  const host = "git.oce-system.svc.cluster.local";
  await f.run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "inputs/tls.key"),
    "-out",
    join(directory, "ca/ca.crt"),
    "-days",
    "2",
    "-subj",
    `/CN=${host}`,
    "-addext",
    `subjectAltName=DNS:${host}`,
  ]);
  // OpenSSL follows the caller's umask; protected inputs must never be group-writable.
  await Promise.all([
    chmod(join(directory, "ca/ca.crt"), 0o600),
    chmod(join(directory, "inputs/tls.key"), 0o600),
  ]);
  await write("inputs/config.json", qaRepositoryServiceConfig(registry, host));
  const path = join(f.stateDirectory, "compose.yaml");
  const compose = loadYaml(await readFile(path, "utf8"));
  const mount = (source, target, readOnly = true) => ({
    type: "bind",
    source: join(directory, source),
    target,
    read_only: readOnly,
  });
  const image = process.env.OCC_TEST_QA_REPOSITORY_IMAGE ?? `oce-qa-repository:${f.suffix}`;
  if (!process.env.OCC_TEST_QA_REPOSITORY_IMAGE) {
    await f.run(
      "docker",
      [
        "build",
        "-f",
        "deploy/runtime/Dockerfile",
        "--target",
        "repository-credentials-service",
        "-t",
        image,
        ".",
      ],
      { timeout: 1_200_000 },
    );
  }
  compose.services["repository-credentials"] = {
    image,
    entrypoint: ["node", "/app/dist/repository-credentials.js"],
    command: ["--config", "/etc/openclaw/repository-inputs/config.json"],
    networks: { development: {} },
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    volumes: [
      mount("registry", "/etc/openclaw/repository-registry"),
      mount("inputs", "/etc/openclaw/repository-inputs"),
      mount("ca", "/etc/openclaw/repository-ca"),
      mount("control", "/run/openclaw/repository-control", false),
    ],
  };
  for (const name of ["controller", "worker-kubernetes"]) {
    compose.services[name].volumes.push(
      mount("registry", "/etc/openclaw/repository-registry"),
      mount("ca", "/etc/openclaw/repository-ca"),
    );
    if (name === "worker-kubernetes") {
      compose.services[name].volumes.push(
        mount("control", "/run/openclaw/repository-control", false),
        mount("prepared", PREPARED_REPOSITORY_DIRECTORY),
      );
    }
  }
  await writeFile(path, dumpYaml(compose), { mode: 0o600 });
  await f.compose("up", "-d", "--no-deps", "repository-credentials");
  const broker = (await f.compose("ps", "-a", "-q", "repository-credentials")).trim();
  assert.ok(broker, "Compose must create the real repository broker");
  await waitFor("Compose broker control socket ready", async () => {
    const state = JSON.parse(await f.run("docker", ["inspect", broker]))[0].State;
    assert.ok(state.Running, "the real repository broker exited during startup");
    try {
      return (await stat(join(directory, "control/private/control.sock"))).isSocket();
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return false;
    }
  });
  const ip = JSON.parse(await f.run("docker", ["inspect", broker]))[0].NetworkSettings.Networks[
    `${f.cluster}_development`
  ].IPAddress;
  const labels = { "app.kubernetes.io/name": "qa-repository-relay" };
  const compute = f.configuration.drivers.compute.configuration;
  // A TCP relay preserves broker TLS and authentication. It does not implement
  // credentials, Git, or authorization; the shipped broker handles every call.
  await f.apply({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "qa-repository-relay", namespace: "oce-system" },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "relay",
              image: compute.images.agent,
              imagePullPolicy: "Never",
              command: [
                "node",
                "-e",
                `const net=require('net');net.createServer(c=>{const u=net.connect(8443,'${ip}');c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(8443,'0.0.0.0')`,
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              ports: [{ name: "https", containerPort: 8443 }],
              readinessProbe: { tcpSocket: { port: "https" }, periodSeconds: 2 },
            },
          ],
        },
      },
    },
  });
  await f.apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "git", namespace: "oce-system" },
    spec: { selector: labels, ports: [{ name: "https", port: 443, targetPort: 8443 }] },
  });
  await f.apply({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "qa-repository-relay", namespace: "oce-system" },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "openclaw.dev/namespace": f.namespace.id } },
              podSelector: {
                matchExpressions: [
                  {
                    key: "openclaw.dev/workload-role",
                    operator: "In",
                    values: ["agent", "gateway"],
                  },
                ],
              },
            },
          ],
          ports: [{ protocol: "TCP", port: 8443 }],
        },
      ],
      egress: [
        { to: [{ ipBlock: { cidr: `${ip}/32` } }], ports: [{ protocol: "TCP", port: 8443 }] },
      ],
    },
  });
  await f.kubectl(
    "-n",
    "oce-system",
    "rollout",
    "status",
    "deployment/qa-repository-relay",
    "--timeout=120s",
  );
  applyQaRepositoryInstallation(f.configuration, registry, labels);
  await f.saveInstallation(f.configuration);
}

// The serial worker waits for the Gateway's whole active-work drain, bounded by
// GATEWAY_STOP_TIMEOUT_MS plus one Kubernetes request, before it deletes the
// Harness and clears activeRevisionId (finding 1088). Allow that bound plus three
// minutes for the Harness to terminate and the API to observe it, as
// first-agent-smoke does. This is a QA allowance, not a product bound. While
// ordinary stops hold the serial worker, a stop queued behind another Agent's
// full drain (OCC_TEST_QA_CONCURRENCY > 1) can still exceed it; the slow-stop
// evidence below then names the drain.
export const QA_STOP_TIMEOUT_MS = GATEWAY_STOP_TIMEOUT_MS + 10_000 + 3 * 60_000;
// A stop slower than this passes, but leaves evidence. One still running past it
// captures the platform logs once, while the Gateway is still draining: its drain
// lines name the work it waits for (finding 1076).
export const QA_SLOW_STOP_MS = 60_000;

// `now` is the clock for both the slow-stop threshold and the timeout; tests pass a
// fake one with `interval: 0`, so neither bound costs real time.
export async function stopQaAgent(
  f,
  agent,
  { timeout = QA_STOP_TIMEOUT_MS, slowAfter = QA_SLOW_STOP_MS, now = Date.now, interval } = {},
) {
  // Evidence files are created exclusively: a repeated stop of one Agent gets its own names.
  agent.stopCalls = (agent.stopCalls ?? 0) + 1;
  const label = agent.stopCalls === 1 ? agent.id : `${agent.id}-${agent.stopCalls}`;
  const startedAt = now();
  await f.api("POST", `/namespaces/${agent.namespaceId}/agents/${agent.id}/stop`);
  let last;
  let slow;
  try {
    await waitFor(
      "ordinary Agent stop removes every runtime Pod",
      async () => {
        const current = await f.api("GET", `/namespaces/${agent.namespaceId}/agents/${agent.id}`);
        const pods = JSON.parse(
          await f.kubectl(
            "get",
            "pods",
            "-A",
            "-l",
            `openclaw.dev/agent=${agent.id}`,
            "-o",
            "json",
          ),
        ).items;
        last = { current, pods };
        const done =
          current.desiredRuntimeState === "stopped" &&
          !current.activeRevisionId &&
          pods.length === 0;
        if (!done && !slow && now() - startedAt > slowAfter) {
          slow = await captureSlowStop(f, label, last, now() - startedAt, slowAfter);
        }
        return done;
      },
      timeout,
      { describe: () => describeStopObservation(last), interval, now },
    );
  } catch (error) {
    if (last && /^Timed out: /.test(error.message)) {
      try {
        const file = await recordPlatformLogs(f, `${label}-stop-timeout`, last.pods);
        if (file) {
          error.message += `; API and worker logs: ${file}`;
        }
      } catch (logError) {
        error.message += `; API and worker logs unavailable (${logError.message})`;
      }
      if (slow?.platformLogs) {
        error.message += `; drain evidence after ${Math.round(slow.observedAfterMs / 1000)} s: ${slow.platformLogs}`;
      }
    }
    throw error;
  }
  const elapsedMs = now() - startedAt;
  if (slow || elapsedMs > slowAfter) {
    try {
      await f.record(`${label}-slow-stop`, { thresholdMs: slowAfter, ...slow, elapsedMs });
    } catch {
      // Diagnostic only: a stop that completed must not fail on its evidence.
    }
    process.stderr.write(
      `QA slow stop (diagnostic, not a failure): Agent ${agent.id} took ${Math.round(elapsedMs / 1000)} s` +
        `${slow?.platformLogs ? `; drain evidence: ${slow.platformLogs}` : ""}\n`,
    );
  }
  agent.stopped = true;
}

async function captureSlowStop(f, label, observation, elapsedMs, thresholdMs) {
  const slow = {
    thresholdMs,
    observedAfterMs: elapsedMs,
    observation: JSON.parse(describeStopObservation(observation)),
  };
  try {
    slow.platformLogs = await recordPlatformLogs(f, `${label}-slow-stop`, observation.pods);
  } catch (error) {
    slow.platformLogsUnavailable = redactedQaTail(error.message, qaLogEnv(f), {
      lines: 4,
      lineChars: 400,
    });
  }
  return slow;
}

// Only identifiers and lifecycle fields: no specs, environments or Secret data.
export function describeStopObservation(observation) {
  if (!observation) {
    return "none";
  }
  const { current, pods } = observation;
  const remaining = pods.slice(0, 10).map(({ metadata = {}, status = {} }) => ({
    namespace: metadata.namespace,
    name: metadata.name,
    phase: status.phase,
    deletionTimestamp: metadata.deletionTimestamp ?? null,
    finalizers: metadata.finalizers ?? [],
  }));
  return JSON.stringify({
    desiredRuntimeState: current?.desiredRuntimeState,
    activeRevisionId: current?.activeRevisionId ?? null,
    pods: remaining,
    ...(pods.length > remaining.length ? { omittedPods: pods.length - remaining.length } : {}),
  });
}

const platformLogLines = 600;
const platformLogLineChars = 2_000;
// Fixed launcher settings, not secrets: the generated cluster and project name,
// its state directory (under the runner's temp directory), the k3s image the
// workflows pin and the driver names appear on many lines, and replacing them (or
// "kubernetes") would garble the logs. The controller, runtime and repository
// image overrides and anything secret-bearing stay private.
const publicLauncherSettings = new Set([
  "OCC_DEVELOPMENT_COMPOSE_PROJECT",
  "OCC_DEVELOPMENT_COMPUTE_DRIVER",
  "OCC_DEVELOPMENT_CONTAINER_ENGINE",
  "OCC_DEVELOPMENT_CONTROL_PLANE",
  "OCC_DEVELOPMENT_K3S_IMAGE",
  "OCC_DEVELOPMENT_KUBERNETES_CLUSTER",
  "OCC_DEVELOPMENT_SANDBOX_DRIVER",
  "OCC_DEVELOPMENT_STATE_DIRECTORY",
]);

// The Gateway drains in-flight work for up to 315 s on SIGTERM and logs what it
// waits for. Keep only its own drain and shutdown messages.
const gatewayDrainLine =
  /draining active work|active-work drain|all active work drained|shutdown budget|shutdown drain|received SIG(TERM|INT)/i;
const gatewayDrainLines = 40;
// Extra worker reads (rollout Pods, previous containers) keep a shorter tail.
const extraWorkerLogLines = 200;
const platformEvents = 60;

// Lifecycle fields only: which Pods ran, when they started and why they restarted.
function podRestarts({ metadata = {}, status = {} }) {
  return {
    name: metadata.name,
    component: metadata.labels?.["app.kubernetes.io/component"],
    phase: status.phase,
    startTime: status.startTime ?? null,
    deletionTimestamp: metadata.deletionTimestamp ?? null,
    containers: (status.containerStatuses ?? []).map(({ name, restartCount, lastState }) => ({
      name,
      restartCount,
      lastTerminated: lastState?.terminated
        ? {
            reason: lastState.terminated.reason,
            exitCode: lastState.terminated.exitCode,
            finishedAt: lastState.terminated.finishedAt,
          }
        : null,
    })),
  };
}

function qaLogEnv(f) {
  return Object.fromEntries(
    Object.entries(f.env ?? {}).filter(([name]) => !publicLauncherSettings.has(name)),
  );
}

// The QA evidence artifact is uploaded on every run, and only its *.json files;
// keep the API and worker log tails there, redacted, for the kubernetes control
// plane (Compose runs them as containers outside the cluster), plus each worker
// Pod during a rollout, a restarted worker's previous log, platform Pod restarts, recent
// Events in the platform and remaining Agent Namespaces, and the drain lines of each
// remaining Gateway Pod. Returns the file name.
async function recordPlatformLogs(f, label, remainingPods = []) {
  if (f.controlPlane !== "kubernetes") {
    return;
  }
  const env = qaLogEnv(f);
  const tail = (text, lines = platformLogLines, lineChars = platformLogLineChars) =>
    redactedQaTail(text, env, { lines, lineChars });
  const attempt = async (read) => {
    try {
      return await read();
    } catch (error) {
      return { unavailable: tail(error.message, 12, 800) };
    }
  };
  const platformNamespace = f.state.platformNamespace;
  const containerTail = async (target, container, ...options) => {
    const lines = target.startsWith("deployment/") ? platformLogLines : extraWorkerLogLines;
    return tail(
      await f.kubectl(
        "-n",
        platformNamespace,
        "logs",
        target,
        "--container",
        container,
        ...options,
        "--timestamps",
        `--tail=${lines}`,
        "--request-timeout=30s",
      ),
      lines,
    );
  };
  const logs = {};
  logs.api = await attempt(() => containerTail("deployment/openclaw-enterprise-api", "api"));
  logs.worker = await attempt(() =>
    containerTail("deployment/openclaw-enterprise-worker", "worker"),
  );
  const platformPods = await attempt(async () =>
    JSON.parse(
      await f.kubectl(
        "-n",
        platformNamespace,
        "get",
        "pods",
        "-o",
        "json",
        "--request-timeout=30s",
      ),
    ).items.map(podRestarts),
  );
  logs.platformPods = platformPods;
  // `logs deployment/...` reads one Pod and never its previous container: during
  // a rollout read every worker Pod by name, and a restarted one's previous log.
  const workerPods = Array.isArray(platformPods)
    ? platformPods.filter(({ component }) => component === "worker")
    : [];
  for (const pod of workerPods) {
    if (workerPods.length > 1) {
      (logs.workerPods ??= {})[pod.name] = await attempt(() => containerTail(pod.name, "worker"));
    }
    if (pod.containers.find(({ name }) => name === "worker")?.restartCount > 0) {
      (logs.workerPrevious ??= {})[pod.name] = await attempt(() =>
        containerTail(pod.name, "worker", "--previous"),
      );
    }
  }
  const eventNamespaces = [
    platformNamespace,
    ...new Set(
      remainingPods
        .map(({ metadata }) => metadata?.namespace)
        .filter((namespace) => namespace && namespace !== platformNamespace),
    ),
  ];
  logs.events = {};
  for (const namespace of eventNamespaces) {
    logs.events[namespace] = await attempt(async () =>
      JSON.parse(
        await f.kubectl("-n", namespace, "get", "events", "-o", "json", "--request-timeout=30s"),
      )
        .items.map((event) => ({
          time: event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp ?? null,
          type: event.type,
          reason: event.reason,
          object: `${event.involvedObject?.kind}/${event.involvedObject?.name}`,
          count: event.count ?? 1,
          message: tail(event.message ?? "", 1, 400)[0] ?? "",
        }))
        .sort((left, right) => String(left.time ?? "").localeCompare(String(right.time ?? "")))
        .slice(-platformEvents),
    );
  }
  for (const { metadata = {} } of remainingPods) {
    if (metadata.labels?.["openclaw.dev/workload-role"] !== "gateway") {
      continue;
    }
    (logs.gatewayDrain ??= {})[metadata.name] = await attempt(async () => {
      const text = await f.kubectl(
        "-n",
        metadata.namespace,
        "logs",
        metadata.name,
        "--container",
        "gateway",
        "--timestamps",
        `--tail=${platformLogLines * 4}`,
        "--request-timeout=30s",
      );
      const kept = text.split("\n").filter((line) => gatewayDrainLine.test(line));
      return kept.length === 0 ? [] : tail(kept.join("\n"), gatewayDrainLines, 800);
    });
  }
  return f.record(`${label}-platform-logs`, { capturedAt: new Date().toISOString(), logs });
}

// "git-write" pushes one commit to the run's granted branch. "git-push-denied" pushes
// to another branch, which the grant does not cover. Both bind git-write: prepared
// native Git serves no other profile.
export async function verifyQaRepository(f, agent, scenario = "git-write") {
  assert.ok(["git-write", "git-push-denied"].includes(scenario));
  const denied = scenario === "git-push-denied";
  assert.ok(!f.retained, "unresolved repository cleanup prevents opening another session");
  assert.equal(
    process.env.OCC_TEST_QA_REPOSITORY_AUTHORIZED,
    "1",
    "explicit disposable remote-write authorization is required",
  );
  const entry = f.repositoryEntry;
  const repository = entry.repository;
  const observerTokenPath = process.env.OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE;
  const observerAppInput = process.env.OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY;
  const observerBinary = process.env.OCC_TEST_QA_GITHUB_OBSERVER_BINARY;
  if (process.env.QA_REPOSITORY_FIXTURE === "isolated") {
    assert.ok(observerAppInput, "isolated repository fixture requires App-backed observer input");
    assert.ok(
      !observerTokenPath,
      "isolated repository fixture must not use a static observer token",
    );
    assert.ok(!observerBinary, "isolated repository fixture must not use a managed gh wrapper");
  }
  const observerToken = observerTokenPath
    ? await protectedText(observerTokenPath, "independent GitHub observer credential")
    : undefined;
  const selectedObservers = [observerToken, observerAppInput, observerBinary].filter(Boolean);
  assert.equal(
    selectedObservers.length,
    1,
    "select exactly one independent observer credential, App input directory, or managed gh wrapper",
  );
  // A selected managed wrapper may authenticate from its caller's environment.
  // Forward credentials only to the host observer/Git calls, never the launcher
  // environment used for containers, Kubernetes, or model turns.
  const observerEnvironment = observerToken
    ? { GH_TOKEN: observerToken }
    : Object.fromEntries(
        observerAppInput
          ? []
          : ["GH_TOKEN", "GITHUB_TOKEN"]
              .filter((name) => process.env[name])
              .map((name) => [name, process.env[name]]),
      );
  for (const value of Object.values(observerEnvironment)) {
    registerQaSecret(value);
  }
  const runObserverCommand = (cmd, args, options) =>
    f.run(cmd, args, {
      ...options,
      env: { ...f.env, ...options?.env, ...observerEnvironment },
    });
  const observe = observerAppInput
    ? await createGitHubAppRepositoryObserver({
        repository,
        inputDirectory: observerAppInput,
        run: runObserverCommand,
      })
    : createRepositoryObserver({
        repository,
        binary: observerBinary ?? "gh",
        run: runObserverCommand,
      });
  const { data: remote } = await observe("GET");
  assert.equal(String(remote.id), String(entry.repositoryId));
  assert.equal(remote.full_name.toLowerCase(), repository.toLowerCase());
  const base = remote.default_branch;
  const { data: baseline } = await observe("GET", `git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = baseline.object.sha;
  assert.match(baseSha, /^[a-f0-9]{40}$/);
  const suffix = `${f.suffix}-${agent.preset.toLowerCase()}-${scenario}`;
  const branch = denied ? `${qaRepositoryBranch(f.suffix)}-denied` : qaRepositoryBranch(f.suffix);
  const file = `qa-${suffix}.txt`;
  const content = `QA repository proof ${suffix}\n`;
  const marker = `<!-- oce-qa:${suffix} -->`;
  await observe("GET", `git/ref/heads/${branch}`, undefined, 404);
  const path = `/namespaces/${agent.namespaceId}/agents/${agent.id}`;
  const dedicated = agent.preset === "Codex";
  const currentConfiguration = await f.api(
    "GET",
    `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`,
  );
  const values = currentConfiguration.values;
  values.agents.defaults.workspace = dedicated
    ? "/home/node/workspace"
    : "/home/node/.openclaw/workspace";
  values.agents.defaults.sandbox = { mode: "off" };
  if (dedicated) {
    Object.assign(values.plugins.entries.codex.config.appServer, {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      remoteWorkspaceRoot: "/home/node/workspace",
    });
  }
  values.tools = {
    ...values.tools,
    allow: dedicated ? ["*"] : ["exec", "process"],
    ...(dedicated ? { fs: { ...values.tools?.fs, workspaceOnly: true } } : {}),
    exec: {
      ...values.tools?.exec,
      mode: "full",
      ...(dedicated ? {} : { host: "gateway" }),
    },
  };
  await f.api(
    "PATCH",
    `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`,
    { values },
  );
  await f.api("PATCH", path, {
    configurationId: agent.configuration.id,
    repositoryBindings: [{ repositoryRef: entry.repositoryRef, profile: "git-write" }],
  });
  let workFailure;
  let remoteEvidence;
  let attempt;
  let readSession;
  try {
    // Deployment can open provider credentials even if its response is lost.
    // A rejected draft update above creates no session-cleanup obligation.
    f.pendingRepositories.add(agent.id);
    await f.deployAndWait(agent);
    const readOnly = denied;
    const gateway = await f.pod(agent, "gateway");
    const consumer = dedicated ? await f.pod(agent, "agent") : gateway;
    const consumerName = dedicated ? "agent" : "gateway";
    const execIn = (pod, container, script, args = [], input, timeout = 30_000) =>
      f.run(
        "kubectl",
        [
          "--kubeconfig",
          join(f.stateDirectory, "kubeconfig"),
          "--context",
          `k3d-${f.cluster}`,
          "-n",
          pod.metadata.namespace,
          "exec",
          "-i",
          pod.metadata.name,
          "-c",
          container,
          "--",
          "env",
          "-u",
          "OPENAI_API_KEY",
          "node",
          "-e",
          script,
          ...args,
        ],
        { input, timeout },
      );
    const exec = (...args) => execIn(gateway, "gateway", ...args);
    const consumerExec = (...args) => execIn(consumer, consumerName, ...args);
    const material = JSON.parse(
      await consumerExec(
        "const fs=require('fs'),p='/run/oce/repository-credentials/manifest.json',m=JSON.parse(fs.readFileSync(p)),s=fs.statSync(p);console.log(JSON.stringify({uid:s.uid,mode:s.mode&511,bindings:m.bindings.map(b=>({repositoryRef:b.repositoryRef,sessionId:b.sessionId}))}))",
      ),
    );
    assert.equal(material.uid, 1000);
    assert.equal(material.mode, 0o600);
    assert.equal(material.bindings.length, 1);
    assert.equal(material.bindings[0].repositoryRef, entry.repositoryRef);
    attempt = material.bindings[0];
    const workers =
      f.controlPlane === "kubernetes"
        ? JSON.parse(
            await f.kubectl(
              "-n",
              f.state.platformNamespace,
              "get",
              "pods",
              "-l",
              "app.kubernetes.io/component=worker",
              "-o",
              "json",
            ),
          ).items
        : [];
    const workerPod = workers.find(
      (p) =>
        !p.metadata.deletionTimestamp &&
        p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
    );
    const executeWorker = (script, args, timeout) =>
      f.controlPlane === "compose"
        ? f.run(
            "docker",
            [
              "compose",
              "-p",
              f.cluster,
              "-f",
              join(f.stateDirectory, "compose.yaml"),
              "exec",
              "-T",
              "worker-kubernetes",
              "node",
              "-e",
              script,
              ...args,
            ],
            { timeout },
          )
        : f.run(
            "kubectl",
            [
              "--kubeconfig",
              join(f.stateDirectory, "kubeconfig"),
              "--context",
              `k3d-${f.cluster}`,
              "-n",
              f.state.platformNamespace,
              "exec",
              workerPod.metadata.name,
              "-c",
              "worker",
              "--",
              "node",
              "-e",
              script,
              ...args,
            ],
            { timeout },
          );
    readSession = (id) => readInstalledCredentialSession(executeWorker, id);
    assert.equal((await readSession(attempt.sessionId)).state, "OPEN");
    for (const pod of [gateway, consumer]) {
      assert.ok(
        !pod.spec.containers.some((c) =>
          c.env?.some((e) =>
            ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(
              e.name,
            ),
          ),
        ),
        "no alternate provider credential in runtime",
      );
    }
    // Submit through the actual gateway's supported authenticated HTTP endpoint.
    // Execution and Git/gh remain entirely in the native Agent.
    const scenarioFixture = {
      ...f,
      suffix,
      gatewayHostname: undefined,
      record: (name, value) => f.record(`${suffix}-${name}`, value),
    };
    remoteEvidence = await verifyNativeRepositoryJourney({
      f: scenarioFixture,
      dedicated,
      readOnly,
      workspace: dedicated ? "/home/node/workspace" : "/home/node/.openclaw/workspace",
      repository,
      base,
      baseSha,
      branch,
      file,
      content,
      marker,
      commandTool: dedicated ? "bash" : "exec",
      toolNames: dedicated ? ["bash"] : ["exec", "process"],
      gateway,
      consumer,
      agent,
      revision: agent.revision,
      attempt,
      exec,
      submitTask: exec,
      consumerExec,
      observe,
      app: { repositoryId: String(entry.repositoryId) },
      remote,
      readSession,
      submitViaLoopback: true,
      pullRequest: false,
    });
  } catch (error) {
    workFailure = error;
  }
  let cleanupFailure;
  try {
    await stopQaAgent(f, agent);
    if (attempt && readSession) {
      const session = await waitFor("broker session DISPOSED", async () => {
        const value = await readSession(attempt.sessionId);
        return value.state === "DISPOSED" && value;
      });
      assert.equal(session.activeUses, 0);
      for (const counter of ["active", "pending", "uncertain"]) {
        assert.equal(session.cleanup[counter], 0, `session cleanup ${counter}`);
      }
      assert.equal(session.cleanup.auxiliaryPending, false);
      const materials = JSON.parse(
        await f.kubectl(
          "get",
          "secrets",
          "-A",
          "-l",
          `openclaw.dev/agent=${agent.id},openclaw.dev/repository-material=session`,
          "-o",
          "json",
        ),
      ).items;
      assert.equal(materials.length, 0);
      await f.record(`${suffix}-disposal`, session);
      f.pendingRepositories.delete(agent.id);
    }
    // Reconcile unknown task outcomes as well as successful remote writes.
    if (!f.pendingRepositories.has(agent.id)) {
      await cleanupRepositoryJourney({
        observe,
        repository,
        repositoryId: entry.repositoryId,
        branch,
        base,
        baseSha,
        file,
        content,
        marker,
        readOnly: denied,
        commitMessage: `Installed credential proof ${suffix}`,
        expectedSha: remoteEvidence?.commitSha,
      });
    }
  } catch (error) {
    cleanupFailure = error;
    // Every git-write scenario of the run pushes the one granted branch. Keep a later
    // one from tripping over what this one could not clean up.
    if (!denied) {
      f.retained = true;
    }
  }
  if (f.pendingRepositories.has(agent.id)) {
    f.retained = true;
  }
  if (workFailure && cleanupFailure) {
    throw new AggregateError(
      [workFailure, cleanupFailure],
      "repository journey and cleanup failed",
      { cause: workFailure },
    );
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
  if (workFailure) {
    throw workFailure;
  }
}
