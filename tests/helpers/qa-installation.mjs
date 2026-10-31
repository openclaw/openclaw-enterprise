import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeAdminTarget } from "../../apps/controller/src/gateway/native-admin.ts";
import { renderPresetTemplate } from "../../packages/contracts/src/index.ts";
import { availablePort } from "./available-port.mjs";
import { createNativePluginAssertions } from "./plugin-driver-real.mjs";
import { prepareHybridInstallation } from "./qa-hybrid.mjs";
import { grantQaRepositoryBranch } from "./qa-repository.mjs";
import { loadYaml, dumpYaml, waitFor } from "./qa-utils.mjs";
import {
  protectedText,
  protectedModelApiKey,
  registerQaSecret,
  grantQaSecret,
  qaCommandFailureDetail,
  redactedQaTail,
} from "./qa-secrets.mjs";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { maskPrivateKeyLines } from "../../scripts/ci/failure-redaction.mjs";

function execute(command, args, options) {
  const { input, allowExitCodes = [0], ...rest } = options;
  return new Promise((accept, reject) => {
    const child = execFile(command, args, rest, (error, stdout, stderr) => {
      if (error && !allowExitCodes.includes(error.code)) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        accept({ stdout, stderr });
      }
    });
    child.stdin.end(input);
  });
}
const repository = resolve(import.meta.dirname, "../..");
export function launcherEnvironment() {
  // Runtime credentials are delivered later through the Secret API. Never pass
  // the matrix's model, sender, or GitHub observer credentials to the launcher.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:OCC_|OPENAI_|CODEX_|SLACK_|GH_|GITHUB_TOKEN|OPENCLAW_DEV_)/.test(name),
    ),
  );
  for (const name of [
    "OCC_DEVELOPMENT_K3S_IMAGE",
    "OCC_DEVELOPMENT_K3D_DNS_RESOLVER",
    "OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT",
    "NODE_BASE_IMAGE",
  ]) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }
  return env;
}

// The output of the image build step that failed, from a docker (BuildKit) or podman build's
// stderr, at most `lines` lines; undefined when stderr shows no failed image build. A failed
// build's own error keeps only its last lines, which name the step but not why it failed (an
// upstream test run inside the runtime image build, finding 2020). BuildKit prefixes every line
// of a step's output with "#<step> " and interleaves steps, so the failed step is the one whose
// "#<step> ERROR:" line comes last; without one (podman), the last lines of stderr. One dev-up can
// run several builds, each numbering its steps from #0, so only the last build is read: a build
// stops dev-up at its first failure.
export function imageBuildFailureOutput(stderr, { lines = 200 } = {}) {
  const text = String(stderr ?? "").trimEnd();
  // Newer buildx says "ERROR: failed to build: failed to solve: ...".
  if (!/^ERROR: (?:failed to build: )?failed to solve: |^Error: building at STEP /m.test(text)) {
    return undefined;
  }
  const all = text.split("\n");
  const first = Math.max(
    0,
    all.findLastIndex((line) =>
      /^#0 building with |^#1 \[internal\] load build definition/.test(line),
    ),
  );
  const build = all.slice(first);
  // Private keys are masked over all of stderr before the step and its last lines are cut out: a
  // key whose BEGIN line falls outside the cut would otherwise keep its body (finding 2026). As in
  // redactedQaTail, an unterminated BEGIN ... PRIVATE KEY line anywhere earlier masks everything
  // after it, the failed step included: the safe direction, so the evidence is then all markers.
  const masked = maskPrivateKeyLines(all).slice(first);
  const step = build.findLast((line) => /^#\d+ ERROR: /.test(line))?.match(/^#\d+ /)[0];
  return (step ? masked.filter((_, index) => build[index].startsWith(step)) : masked).slice(-lines);
}

// Records a failed image build step's output, redacted like any QA command output, as a QA
// evidence file (the cell uploads its *.json evidence; the private state directory is not
// uploaded). Returns the file's name, or undefined when stderr shows no failed image build.
export async function recordImageBuildFailure(record, stderr, env) {
  const output = imageBuildFailureOutput(stderr);
  if (output === undefined) {
    return undefined;
  }
  return record(`image-build-failure-${Date.now()}`, {
    lines: redactedQaTail(output.join("\n"), env, { lines: output.length, lineChars: 800 }),
  });
}

// Runs one command of a QA installation `f` (its env, private directories, and evidence
// `record`). A failure writes the command's output to the private directory and throws with
// only redacted stderr; a failed image build's step output becomes redacted QA evidence.
export async function runQaCommand(f, command, args, options = {}) {
  const { privateFailureOutput = false, ...executeOptions } = options;
  try {
    const result = await execute(command, args, {
      cwd: repository,
      env: f.env,
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
      ...executeOptions,
    });
    return result.stdout;
  } catch (error) {
    await writeFile(
      join(f.directory, `command-failure-${Date.now()}.log`),
      privateFailureOutput
        ? "protected subprocess output withheld\n"
        : `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
      { mode: 0o600 },
    );
    if (f.credentials?.password) {
      registerQaSecret(f.credentials.password);
    }
    const detail = privateFailureOutput
      ? ""
      : qaCommandFailureDetail(error.stderr, executeOptions.env ?? f.env);
    const buildOutput = privateFailureOutput
      ? undefined
      : await recordImageBuildFailure(f.record, error.stderr, executeOptions.env ?? f.env).catch(
          (recordError) => `not recorded (${recordError?.message ?? recordError})`,
        );
    // execFile errors embed argv and output, potentially containing tokens.
    // Keep arguments/stdout private; include only redacted stderr for diagnosis.
    error.message = `${command.split("/").at(-1)} failed (exit ${error.code ?? "unknown"}, signal ${error.signal ?? "none"}); private state: ${f.stateDirectory}${buildOutput ? `; failed image build step output: ${buildOutput}` : ""}${detail ? `; stderr: ${detail}` : ""}`;
    delete error.cmd;
    delete error.stdout;
    delete error.stderr;
    delete error.stack;
    throw error;
  }
}

// Deploys a QA Agent's current configuration and waits for the deployment to succeed.
export async function deployQaAgentAndWait(
  f,
  agent,
  { timeout = 600_000, interval = 1000, now = () => Date.now() } = {},
) {
  const base = `/namespaces/${agent.namespaceId}/agents/${agent.id}`;
  agent.stopped = false;
  agent.revision = await f.api("POST", base + "/deploy");
  // A timeout names the deployment's last status and attempt, and how long it had that status
  // (finding 2106: six cells timed out at 600 s with no status).
  let last;
  let statusSince = now();
  const observeStatus = (value) => {
    if (value?.status !== last?.status) {
      statusSince = now();
    }
    last = value;
  };
  const status = await waitFor(
    "Agent deployment",
    async () => {
      const value = await f.api("GET", base + `/deployments/${agent.revision.id}`);
      observeStatus(value);
      if (value.error?.code === "RUNTIME_AUTHENTICATION_FAILED" && agent.preset === "OpenClaw") {
        // A failed deployment holds its Pod for diagnosis. Check delivery and
        // provider rejection there without exporting the Pod's credential.
        try {
          const data = JSON.parse(
            await f.kubectl(
              "get",
              "pods",
              "-A",
              "-l",
              `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${agent.revision.id},openclaw.dev/workload-role=gateway`,
              "-o",
              "json",
            ),
          );
          const pods = data.items.filter((pod) => !pod.metadata.deletionTimestamp);
          assert.equal(pods.length, 1);
          const [pod] = pods;
          const expected = createHash("sha256")
            .update(
              await protectedText(process.env.OCC_TEST_QA_OPENAI_KEY_FILE, "model credential"),
            )
            .digest("hex");
          const script = `
            const crypto = require('node:crypto');
            const key = process.env[process.env.OPENCLAW_HARNESS_CREDENTIAL_ENV] ?? '';
            const matchesInput = crypto.createHash('sha256').update(key).digest('hex') === process.argv[1];
            const allowed = new Set(['invalid_api_key', 'insufficient_quota', 'model_not_found', 'unsupported_country_region_territory', 'account_deactivated', 'permission_denied', 'missing_required_parameter', 'invalid_organization', 'project_not_found']);
            fetch('https://api.openai.com/v1/responses', {
              method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
              body: '{}', signal: AbortSignal.timeout(15000),
            }).then(async (response) => {
              const body = await response.json().catch(() => ({}));
              const code = body.error?.code;
              console.log(JSON.stringify({ credentialPresent: key.length > 0, matchesInput, httpStatus: response.status, code: allowed.has(code) ? code : 'other' }));
            }, () => console.log(JSON.stringify({ credentialPresent: key.length > 0, matchesInput, networkFailure: true })));
          `;
          const diagnostic = JSON.parse(
            await f.kubectl(
              "-n",
              pod.metadata.namespace,
              "exec",
              pod.metadata.name,
              "-c",
              "gateway",
              "--",
              "node",
              "-e",
              script,
              expected,
            ),
          );
          await f.record(`${agent.id}-${agent.revision.id}-authentication`, diagnostic);
        } catch {
          await f.record(`${agent.id}-${agent.revision.id}-authentication`, {
            unavailable: true,
          });
        }
      }
      // A failed startup model check names the provider's HTTP status and known
      // error code in its sanitized probe log record; CI shows them with the error.
      let probe = "";
      const component = value.error?.data?.runtimeFailure?.component;
      if (value.error?.code === "RUNTIME_MODEL_PROBE_FAILED" && component) {
        try {
          const logs = await f.api(
            "GET",
            base +
              `/deployments/${agent.revision.id}/runtime/logs?source=${component}&minLevel=error`,
          );
          const record = logs.records.findLast(({ message }) => message?.endsWith(".model_probe"));
          probe = record ? ` probe log: ${JSON.stringify(record.fields ?? {})}` : "";
        } catch {
          probe = " probe log: unavailable";
        }
      }
      assert.ok(
        !["failed", "cancelled"].includes(value.status),
        `Agent deployment ${value.status}: ${JSON.stringify(value.error)}${probe}`,
      );
      return value.status === "succeeded" && value;
    },
    timeout,
    {
      describe: () => describeDeploymentObservation(last, now() - statusSince),
      interval,
      now,
    },
  ).catch(async (error) => {
    // The deployment's Pods, when it has any, show whether it waited on scheduling, an image
    // or a container that does not start.
    if (/^Timed out: /.test(error.message)) {
      try {
        const runtime = await f.api("GET", base + `/deployments/${agent.revision.id}/runtime`);
        error.message += `; runtime: ${describeDeploymentRuntime(runtime)}`;
      } catch (runtimeError) {
        error.message += `; runtime unavailable (${runtimeError?.message ?? runtimeError})`;
      }
    }
    throw error;
  });
  await f.record(`${agent.preset}-${agent.id}-${agent.revision.id}-deployment`, {
    agentId: agent.id,
    revisionId: agent.revision.id,
    status,
  });
  return { revision: agent.revision, status };
}

// The last deployment observation, without native text: the API returns allowlisted codes and
// messages only.
export function describeDeploymentObservation(value, statusForMs) {
  if (!value) {
    return "none";
  }
  return JSON.stringify({
    status: value.status,
    statusForMs,
    lastAttempt: value.progress?.lastAttempt ?? null,
    nextAttemptAt: value.progress?.nextAttemptAt ?? null,
    error: value.error?.code ?? null,
  });
}

// Runtime text reaches the API as Kubernetes sent it, and OCC may shorten it there. QA
// redaction replaces whole registered values, so a shortened string could keep part of one.
// The timeout therefore names only familiar Kubernetes words and says "other" for the rest;
// event messages are left out.
const familiarPodPhases = new Set(["Pending", "Running", "Succeeded", "Failed", "Unknown"]);
const familiarContainerReasons = new Set([
  "ContainerCreating",
  "PodInitializing",
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "ErrImageNeverPull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "PreStartHookError",
  "PostStartHookError",
  "StartError",
  "ContainerCannotRun",
  "ContainerStatusUnknown",
  "Completed",
  "Error",
  "OOMKilled",
  "DeadlineExceeded",
]);
const familiarEventReasons = new Set([
  "FailedScheduling",
  "FailedMount",
  "FailedAttachVolume",
  "FailedCreatePodSandBox",
  "FailedKillPod",
  "FailedPreStopHook",
  "FailedPostStartHook",
  "FailedSync",
  "FailedCreate",
  "Failed",
  "BackOff",
  "Unhealthy",
  "ProbeWarning",
  "InspectFailed",
  "ErrImageNeverPull",
  "NetworkNotReady",
  "Evicted",
  "NodeNotReady",
  "OutOfmemory",
  "OutOfcpu",
]);

function familiar(words, value) {
  return value === null || value === undefined || words.has(value) ? value : "other";
}

export function describeDeploymentRuntime(runtime) {
  const pods = (runtime?.pods ?? []).slice(0, 4).map((pod) => ({
    role: pod.role,
    phase: familiar(familiarPodPhases, pod.phase),
    ready: pod.ready,
    containers: (pod.containers ?? []).map(({ name, state, reason, restartCount }) => ({
      name,
      state,
      reason: familiar(familiarContainerReasons, reason),
      restartCount,
    })),
    // The API lists events newest first.
    warnings: (pod.events ?? [])
      .filter(({ type }) => type === "Warning")
      .slice(0, 3)
      .map(({ reason, count }) => ({ reason: familiar(familiarEventReasons, reason), count })),
  }));
  return JSON.stringify({
    pods,
    ...(runtime?.harness ? { harness: runtime.harness } : {}),
  });
}

export async function createQaInstallation(
  context,
  controlPlane,
  artifacts,
  { repositoryInputs = true, sandboxDriver = "none", sandboxNetworkPolicyFile = undefined } = {},
) {
  assert.ok(["compose", "kubernetes"].includes(controlPlane));
  assert.ok(["none", "openshell"].includes(sandboxDriver));
  const suffix = randomUUID().slice(0, 8);
  const cluster = `occ-dev-qa-${controlPlane === "compose" ? "c" : "k"}-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), `${cluster}-`));
  const stateDirectory = join(directory, "state");
  const ports = new Set();
  while (ports.size < 4) {
    ports.add(await availablePort());
  }
  const [apiPort, kubePort, browserPort, postgresPort] = [...ports];
  const env = {
    ...launcherEnvironment(),
    OPENCLAW_DEV_PORT: String(apiPort),
    OCC_POSTGRES_PORT: String(postgresPort),
    OCC_DEVELOPMENT_BROWSER_PORT: String(browserPort),
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    OCC_DEVELOPMENT_CONTROL_PLANE: controlPlane,
    OCC_DEVELOPMENT_SANDBOX_DRIVER: sandboxDriver,
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
    OCC_DEVELOPMENT_COMPOSE_PROJECT: cluster,
    OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
    OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
    OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubePort),
    OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "900",
  };
  for (const [key, input] of [
    ["OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_TEST_QA_CONTROLLER_IMAGE"],
    ["OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_TEST_QA_RUNTIME_IMAGE"],
    ["OCC_DEVELOPMENT_REPOSITORY_IMAGE", "OCC_TEST_QA_REPOSITORY_IMAGE"],
  ]) {
    if (process.env[input]) {
      env[key] = process.env[input];
    }
  }
  let repositoryInput;
  const sourceInput = repositoryInputs
    ? process.env.OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY
    : undefined;
  if (sourceInput) {
    repositoryInput = join(directory, "repository-input");
    await mkdir(repositoryInput, { mode: 0o700 });
    const registry = JSON.parse(
      await protectedText(join(sourceInput, "registry.json"), "repository registry"),
    );
    grantQaRepositoryBranch(registry, suffix);
    await writeFile(join(repositoryInput, "registry.json"), JSON.stringify(registry), {
      mode: 0o600,
    });
    for (const name of ["private-key.pem", "upstream-cidrs.json"]) {
      await copyFile(join(sourceInput, name), join(repositoryInput, name));
      await chmod(join(repositoryInput, name), 0o600);
    }
    if (controlPlane === "kubernetes") {
      env.OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY = repositoryInput;
    }
  }
  const f = {
    controlPlane,
    directory,
    stateDirectory,
    repositoryInput,
    suffix,
    cluster,
    env,
    apiPort,
    browserPort,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    agents: [],
    forwards: [],
    retained: false,
    pendingRepositories: new Set(),
    resources: createResourceScope({ cleanupTimeoutMs: 600_000 }),
    async record(name, value) {
      // API results are evidence only: a fixed JSON suffix, a confined basename,
      // and exclusive creation prevent replacing files or following symlinks.
      const file = `${controlPlane}-${name.replaceAll(/[^a-zA-Z0-9-]/g, "-")}.json`;
      await writeFile(join(artifacts, file), JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      return file;
    },
    async run(command, args, options = {}) {
      return runQaCommand(f, command, args, options);
    },
    async write(name, value) {
      const path = join(directory, name);
      await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), {
        mode: 0o600,
      });
      return path;
    },
    async kubectl(...args) {
      return f.run("kubectl", [
        "--kubeconfig",
        join(stateDirectory, "kubeconfig"),
        "--context",
        `k3d-${cluster}`,
        ...args,
      ]);
    },
    async get(kind, name, namespace) {
      return f.resource(kind, name, namespace);
    },
    waitFor,
    async resource(kind, name, namespace) {
      return JSON.parse(
        await f.kubectl(...(namespace ? ["-n", namespace] : []), "get", kind, name, "-o", "json"),
      );
    },
    async apply(object) {
      const path = await f.write(`apply-${randomUUID()}.json`, object);
      await f.kubectl("apply", "-f", path);
    },
    async api(method, path, body) {
      const response = await fetch(f.apiUrl + path, {
        method,
        headers: {
          "x-api-key": f.serviceKey,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      assert.ok(response.ok, `OCC ${method} ${path}: HTTP ${response.status}`);
      const text = await response.text();
      return text ? JSON.parse(text).data : undefined;
    },
    async compose(...args) {
      return f.run("docker", [
        "compose",
        "-p",
        cluster,
        "-f",
        join(stateDirectory, "compose.yaml"),
        ...(f.consoleThemeComposeFile === undefined ? [] : ["-f", f.consoleThemeComposeFile]),
        ...args,
      ]);
    },
    async saveInstallation(configuration) {
      await writeFile(join(stateDirectory, "installation.yaml"), dumpYaml(configuration), {
        mode: 0o600,
      });
      f.configuration = configuration;
      if (controlPlane === "compose") {
        await f.compose(
          "up",
          "-d",
          "--no-deps",
          "--force-recreate",
          "controller",
          "worker-kubernetes",
        );
      } else {
        await f.apply({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: "occ-installation-startup", namespace: f.state.platformNamespace },
          stringData: { "installation.yaml": dumpYaml(configuration) },
        });
        for (const name of ["openclaw-enterprise-api", "openclaw-enterprise-worker"]) {
          await f.kubectl(
            "-n",
            f.state.platformNamespace,
            "rollout",
            "restart",
            `deployment/${name}`,
          );
          await f.kubectl(
            "-n",
            f.state.platformNamespace,
            "rollout",
            "status",
            `deployment/${name}`,
            "--timeout=300s",
          );
        }
      }
      await waitFor("OCC after configuration", async () => {
        try {
          return await f.api("GET", "/installation");
        } catch {
          return undefined;
        }
      });
    },
    async pods(agent, role) {
      const data = JSON.parse(
        await f.kubectl(
          "get",
          "pods",
          "-A",
          "-l",
          `openclaw.dev/agent=${agent.id},openclaw.dev/workload-role=${role}`,
          "-o",
          "json",
        ),
      );
      return data.items.filter(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          pod.metadata.labels["openclaw.dev/revision"] === agent.revision.id &&
          pod.status.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      );
    },
    async pod(agent, role) {
      const pods = await f.pods(agent, role);
      assert.equal(pods.length, 1, `one Ready ${role} Pod must belong to the exact Agent revision`);
      return pods[0];
    },
    async execRole(agent, role, args) {
      const pod = await f.pod(agent, role);
      return {
        stdout: await f.kubectl(
          "-n",
          pod.metadata.namespace,
          "exec",
          pod.metadata.name,
          "-c",
          role,
          "--",
          ...args,
        ),
        label: pod.metadata.uid,
      };
    },
    async gatewayUrl(agent) {
      const pod = await f.pod(agent, "gateway");
      const port = await availablePort();
      const child = spawn(
        "kubectl",
        [
          "--kubeconfig",
          join(stateDirectory, "kubeconfig"),
          "--context",
          `k3d-${cluster}`,
          "-n",
          pod.metadata.namespace,
          "port-forward",
          "--address",
          "127.0.0.1",
          `pod/${pod.metadata.name}`,
          `${port}:http`,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      f.forwards.push(child);
      await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("gateway forward timed out")), 30_000);
        child.once("error", reject);
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("gateway forward exited"));
        });
        child.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("Forwarding from")) {
            clearTimeout(timer);
            accept();
          }
        });
      });
      const secretName = pod.spec.containers
        .find((c) => c.name === "gateway")
        .env.find((item) => item.name === "OPENCLAW_GATEWAY_PASSWORD").valueFrom.secretKeyRef;
      const secret = await f.resource("secret", secretName.name, pod.metadata.namespace);
      const gatewayPassword = Buffer.from(secret.data[secretName.key], "base64").toString();
      registerQaSecret(gatewayPassword);
      return {
        url: `http://127.0.0.1:${port}`,
        gatewayPassword,
        pod,
        close: async () => {
          child.kill("SIGTERM");
        },
      };
    },
    async deployAndWait(agent) {
      return deployQaAgentAndWait(f, agent);
    },
    async selectPlugin(agentId, policy) {
      const agent = f.agents.find((value) => value.id === agentId);
      const { pluginId, ...selection } = policy;
      const current = await f.api("GET", `/namespaces/${agent.namespaceId}/agents/${agentId}`);
      const updated = await f.api("PATCH", `/namespaces/${agent.namespaceId}/agents/${agentId}`, {
        configurationId: current.configurationId,
        plugins: { ...current.plugins, [pluginId]: selection },
      });
      return updated.plugins[pluginId];
    },
    async updatePluginPolicy(agentId, pluginId, changes) {
      return f.selectPlugin(agentId, { pluginId, enabled: true, ...changes });
    },
  };
  // One resource scope attempts every cleanup, even when the installation
  // must be retained. Later-acquired browsers, trust entries, and relays close first.
  context.after(() => f.resources.close());
  f.resources.after(async () => {
    for (const child of f.forwards) {
      child.kill("SIGTERM");
    }
    for (const agent of f.agents) {
      if (agent.stopped) {
        continue;
      }
      try {
        await f.api("POST", `/namespaces/${agent.namespaceId}/agents/${agent.id}/stop`);
        await waitFor(
          "Agent stop",
          async () =>
            !(await f.api("GET", `/namespaces/${agent.namespaceId}/agents/${agent.id}`))
              .activeRevisionId,
        );
      } catch {
        f.retained = true;
      }
    }
    // Every in-flight repository Agent owns a cleanup obligation. One successful
    // worker must never clear another worker's uncertain session.
    if (f.retained || f.pendingRepositories.size > 0) {
      throw new Error(
        `QA cleanup requires recovery; retained owned installation at ${stateDirectory}`,
      );
    }
    try {
      await stat(join(stateDirectory, "state.json"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    await f.run(join(repository, "scripts/dev-down"), [], { timeout: 300_000 });
  });
  await f.record("ownership", {
    cluster,
    stateDirectory,
    controlPlane,
    base: process.env.OCC_TEST_QA_SOURCE_SHA ?? "working-tree",
  });
  if (controlPlane === "compose") {
    const ids = (await f.run("docker", ["network", "ls", "-q"]))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const networks = ids.length
      ? JSON.parse(await f.run("docker", ["network", "inspect", ...ids]))
      : [];
    const occupied = networks
      .flatMap((network) => network.IPAM?.Config ?? [])
      .map((config) => config.Subnet)
      .filter((cidr) => cidr?.includes("."));
    const range = (cidr) => {
      const [address, bits] = cidr.split("/");
      const number = address.split(".").reduce((value, octet) => (value << 8n) + BigInt(octet), 0n);
      const size = 1n << (32n - BigInt(bits));
      return [(number / size) * size, (number / size) * size + size - 1n];
    };
    const free = (cidr) => {
      const [start, end] = range(cidr);
      return occupied.every((value) => {
        const [a, b] = range(value);
        return end < a || start > b;
      });
    };
    let subnet;
    for (let second = 20; second <= 31 && !subnet; second += 1) {
      for (let third = 1; third < 255 && !subnet; third += 1) {
        const candidate = `172.${second}.${third}.0/24`;
        if (free(candidate)) {
          subnet = candidate;
        }
      }
    }
    assert.ok(subnet, "no unused private Compose subnet available");
    env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR = subnet;
    await f.record("compose-network", { subnet });
  }
  const started = await f.run(
    join(repository, "scripts/dev-up"),
    sandboxNetworkPolicyFile ? ["--sandbox-network-policy-file", sandboxNetworkPolicyFile] : [],
    { timeout: 1_100_000 },
  );
  assert.match(
    started,
    controlPlane === "compose" ? /Control plane: Compose/ : /Deployment: Kubernetes only/,
  );
  f.state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
  assert.equal(f.state.cluster, cluster);
  assert.equal(f.state.sandboxDriver, sandboxDriver);
  f.serviceKey = JSON.parse(
    await protectedText(join(stateDirectory, "initial-admin-service-key.json"), "bootstrap key"),
  ).data.key;
  registerQaSecret(f.serviceKey);
  f.installation = await f.api("GET", "/installation");
  f.defaultNamespace = await waitFor("default Namespace ready after shipped startup", async () => {
    const namespace = (await f.api("GET", "/namespaces")).find((ns) => ns.name === "default");
    return namespace?.status === "ready" && namespace;
  });
  f.presets = await f.api("GET", `/namespaces/${f.defaultNamespace.id}/presets`);
  if (sandboxDriver === "none") {
    assert.deepEqual(f.presets.map((p) => p.name).sort(), [
      "Standard Codex",
      "Standard OpenClaw",
      "default-codex",
    ]);
  }
  f.configuration = loadYaml(await readFile(join(stateDirectory, "installation.yaml"), "utf8"));
  f.namespace = f.defaultNamespace;
  if (controlPlane === "compose") {
    await prepareHybridInstallation(f);
  } else {
    f.consoleUrl = `https://console.${cluster}.oce.localhost:${browserPort}`;
    f.browserCA = join(stateDirectory, "browser-ca.crt");
    f.credentials = {
      email: "admin@development.openclaw.invalid",
      password: await protectedText(
        join(stateDirectory, "initial-admin-password"),
        "bootstrap password",
      ),
    };
  }
  registerQaSecret(f.credentials.password);
  await f.record("startup", {
    installationId: f.installation.id,
    defaultNamespaceId: f.defaultNamespace.id,
    namespaceId: f.namespace.id,
    presets: f.presets.map(({ id, name }) => ({ id, name })),
    sandboxDriver,
  });
  return f;
}

export async function prepareQaConsoleTheme(f) {
  const themeDirectory = join(f.directory, "console-theme");
  await mkdir(themeDirectory);
  for (const name of ["theme.json", "logo.png"]) {
    await copyFile(
      join(repository, "deploy/examples/console-theme", name),
      join(themeDirectory, name),
    );
  }
  if (f.controlPlane === "compose") {
    f.consoleThemeComposeFile = await f.write("console-theme.compose.json", {
      services: {
        controller: {
          environment: { OCC_CONSOLE_THEME_DIR: "/etc/openclaw/console-theme" },
          volumes: [
            {
              type: "bind",
              source: themeDirectory,
              target: "/etc/openclaw/console-theme",
              read_only: true,
            },
          ],
        },
      },
    });
    await f.compose("up", "-d", "--no-deps", "--force-recreate", "controller");
  } else {
    const namespace = f.state.platformNamespace;
    await f.apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "qa-console-theme", namespace },
      data: { "theme.json": await readFile(join(themeDirectory, "theme.json"), "utf8") },
      binaryData: {
        "logo.png": (await readFile(join(themeDirectory, "logo.png"))).toString("base64"),
      },
    });
    await f.run("helm", [
      "upgrade",
      "openclaw-enterprise",
      join(repository, "deploy/helm/openclaw-enterprise"),
      "--kubeconfig",
      join(f.stateDirectory, "kubeconfig"),
      "--kube-context",
      `k3d-${f.cluster}`,
      "--namespace",
      namespace,
      "--reuse-values",
      "--set",
      "api.consoleTheme.configMapName=qa-console-theme",
      "--set-string",
      "api.consoleTheme.checksum=qa-first",
    ]);
    await f.kubectl(
      "-n",
      namespace,
      "rollout",
      "status",
      "deployment/openclaw-enterprise-api",
      "--timeout=300s",
    );
  }
  await waitFor("mounted console theme after API restart", async () => {
    try {
      const response = await fetch(f.apiUrl + "/console/login");
      return response.ok && (await response.text()).includes("<title>Example Agents</title>");
    } catch {
      return false;
    }
  });
}

export async function prepareQaPreset(f, presetName) {
  assert.ok(
    !f.retained && f.pendingRepositories.size === 0,
    "blocked by unresolved repository cleanup",
  );
  const codex = presetName === "Codex";
  const desiredPlugin = codex ? "codex-plugin" : "occ-plugin";
  // The launcher's Gateway resources match the production example, whose memory
  // limit covers the full native repository workload; only the plugin varies.
  if (f.configuration.drivers.plugin?.id !== desiredPlugin) {
    assert.ok(
      f.agents.every((agent) => agent.stopped),
      "stop the prior Agent before changing the installation runtime configuration",
    );
    f.configuration.drivers.plugin = {
      id: desiredPlugin,
      configuration: codex ? { catalogSource: "openai-curated" } : {},
    };
    await f.saveInstallation(f.configuration);
  }
}

export async function createQaAgent(
  f,
  presetName,
  browserOrigin,
  nameSuffix = "",
  { apiKeyAuth = false } = {},
) {
  assert.ok(!f.retained, "unresolved repository cleanup prevents new Agent work");
  // The Preset list returns summaries; the exact Preset carries the template.
  const selected = f.presets.find((value) => value.name === `Standard ${presetName}`);
  assert.ok(selected, `Standard ${presetName} Preset must be available`);
  assert.equal(selected.namespaceId, f.namespace.id, "Preset must belong to the QA Namespace");
  const preset = await f.api("GET", `/namespaces/${selected.namespaceId}/presets/${selected.id}`);
  const codex = presetName === "Codex";
  const codexAccountLogin = codex && !apiKeyAuth;
  const credential = apiKeyAuth
    ? await protectedModelApiKey()
    : await protectedText(
        process.env[
          codexAccountLogin ? "OCC_TEST_QA_CODEX_TOKEN_FILE" : "OCC_TEST_QA_OPENAI_KEY_FILE"
        ],
        "model credential",
      );
  const model =
    process.env[codex ? "OCC_TEST_QA_CODEX_MODEL" : "OCC_TEST_QA_OPENAI_MODEL"] || "gpt-6-luna";
  const rendered = renderPresetTemplate(preset.template, {
    name: `qa-${f.suffix}-${presetName}${nameSuffix}`,
    model,
    modelSecret: "provided-through-secret-api",
  });
  const values = rendered.configuration.values;
  assert.equal(
    f.configuration.drivers.plugin?.id,
    codex ? "codex-plugin" : "occ-plugin",
    "prepare the preset before starting parallel Agent scenarios",
  );
  values.gateway.http = { endpoints: { chatCompletions: { enabled: true } } };
  values.gateway.controlUi = {
    ...values.gateway.controlUi,
    ...(browserOrigin ? { allowedOrigins: [browserOrigin] } : {}),
  };
  values.agents.defaults.skipBootstrap = true;
  const configuration = await f.api("POST", `/namespaces/${f.namespace.id}/configurations`, {
    ...rendered.configuration,
    kind: "agent",
  });
  const secret = await f.api("POST", `/namespaces/${f.namespace.id}/secrets`, {
    name: `${rendered.agent.name}-model`,
    value: credential,
  });
  const auth = {
    method: codexAccountLogin ? "codex_pat" : "api_key",
    source: { kind: "secret", namespaceId: f.namespace.id, id: secret.id },
  };
  const agent = await f.api("POST", `/namespaces/${f.namespace.id}/agents`, {
    ...rendered.agent,
    configurationId: configuration.id,
    harnessAuth: auth,
  });
  agent.preset = presetName;
  agent.qaScenario = nameSuffix;
  agent.configuration = configuration;
  agent.harnessAuth = auth;
  f.agents.push(agent);
  if (f.controlPlane === "kubernetes") {
    const target = nativeAdminTarget({
      publicOrigin: f.consoleUrl,
      installationId: f.installation.id,
      agent,
      domain: `agents.${f.cluster}.oce.localhost`,
    });
    values.gateway.controlUi = {
      ...values.gateway.controlUi,
      enabled: true,
      allowedOrigins: [target.origin],
    };
    // Apply the supported native-admin opt-in from the deployment guide. The
    // compute Driver's runtime defaults do not change the admitted revision.
    values.gateway.auth = {
      ...values.gateway.auth,
      mode: "trusted-proxy",
      identityScopes: { "occ-workspace-files": ["operator.admin"] },
      trustedProxy: {
        ...values.gateway.auth.trustedProxy,
        userHeader: "x-occ-identity",
        allowUsers: ["occ-workspace-files"],
        deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
      },
    };
    await f.api("PATCH", `/namespaces/${f.namespace.id}/configurations/${configuration.id}`, {
      values,
    });
  }
  await grantQaSecret(f, agent, secret.id, `${agent.name}-model`);
  await f.api("POST", `/namespaces/${f.namespace.id}/agents/${agent.id}/runtime-credentials`, {});
  await f.deployAndWait(agent);
  agent.native = createNativePluginAssertions({
    gatewayUrl: (a) => f.gatewayUrl(a),
    execGateway: (a, args) => f.execRole(a, "gateway", args),
    execCodex: (a, args) => f.execRole(a, "agent", args),
    waitFor,
    proofMode: codex ? "codex" : "openclaw",
    readRuntimeLogs: ({ namespaceId, agentId, revisionId, source }) =>
      f.api(
        "GET",
        `/namespaces/${namespaceId}/agents/${agentId}/deployments/${revisionId}/runtime/logs?source=${source}&tailLines=100`,
      ),
    recordRuntimeLogs: (record) =>
      f.record(`${record.agentId}-${record.revisionId}-turn-failure-logs-${randomUUID()}`, record),
  });
  return agent;
}

export { repository };
