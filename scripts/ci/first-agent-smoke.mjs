#!/usr/bin/env node
// Per-merge smoke of a real local installation, needing no secrets.
//
//   node scripts/ci/first-agent-smoke.mjs images   build the checkout's images
//   node scripts/ci/first-agent-smoke.mjs run      install, deploy, chat, stop, start
//
// `images` builds the controller and runtime images from this checkout (reading
// the hosted image caches when available), adds a private test CA to the
// runtime image's trust store, and pushes both to a loopback registry so Local
// Setup can select them by digest. `run` starts the Kubernetes-only Local Setup
// with those images, answers api.openai.com from a stand-in Responses provider,
// runs scripts/first-agent.mjs for an embedded OpenClaw Agent, deploys one
// dedicated Codex Agent through the API, reads both Agents' logs through
// `occ agent logs`, stops and starts each once, and checks that every reported
// status matches the cluster and a real model turn.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { GATEWAY_STOP_TIMEOUT_MS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { PUBLIC_GITHUB_READ_SKILL } from "../../apps/controller/src/drivers/repo/github/public-read/codex.ts";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import { createHarnessConfiguration } from "../../tests/helpers/harness-configuration.mjs";
import { installPublicGithubReadFixture } from "../../tests/helpers/public-github-read-k3d.mjs";
import {
  configureModelProviderDNS,
  createModelProviderFiles,
  writeModelProviderTrust,
} from "../../tests/helpers/runtime-model-provider.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const occ = join(root, "bin", "occ");
const workDirectory = resolve(
  process.env.OCC_FIRST_AGENT_SMOKE_DIRECTORY ??
    join(process.env.RUNNER_TEMP ?? "/tmp", "first-agent-smoke"),
);
// OCC_FIRST_AGENT_SMOKE_SLOT (0-31, default 0) picks this run's host-wide names,
// port and subnet, so concurrent smokes on one Docker host do not collide.
// Unset, empty and 0 keep the names CI uses.
export function smokeSlotNames(value) {
  value ||= "0";
  if (!/^(?:0|[1-9][0-9]?)$/.test(value) || Number(value) > 31) {
    throw new Error(
      `OCC_FIRST_AGENT_SMOKE_SLOT must be an integer from 0 to 31, got ${JSON.stringify(value)}`,
    );
  }
  const slot = Number(value);
  if (slot === 0) {
    return {
      cluster: "occ-dev-first-agent-smoke",
      registryContainer: "oce-first-agent-smoke-registry",
      registry: "127.0.0.1:5000",
      model: "oce-first-agent-smoke-model",
      subnet: "11.111.0.0/29",
      modelAddress: "11.111.0.2",
      nodeModelAddress: "11.111.0.3",
    };
  }
  const base = 8 * slot;
  return {
    cluster: `occ-dev-smoke-s${slot}`,
    registryContainer: `oce-smoke-s${slot}-registry`,
    registry: `127.0.0.1:${15000 + slot}`,
    model: `oce-smoke-s${slot}-model`,
    subnet: `11.111.0.${base}/29`,
    modelAddress: `11.111.0.${base + 2}`,
    nodeModelAddress: `11.111.0.${base + 3}`,
  };
}
const slotNames = smokeSlotNames(process.env.OCC_FIRST_AGENT_SMOKE_SLOT);
const registry = slotNames.registry;
// Pinned like tests/integration/container-registry-real.test.mjs.
const registryImage =
  "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const nodeBaseImage =
  "docker.io/library/node:24-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0";
// Agent NetworkPolicies allow model egress only to public addresses on TCP/443,
// and OpenClaw refuses provider addresses in private or special-use ranges. The
// stand-in provider therefore uses a globally routable address, reachable only
// on this host's Docker network; nothing outside the runner is contacted.
const modelNetwork = { name: slotNames.model, subnet: slotNames.subnet };
const modelAddress = slotNames.modelAddress;
const nodeModelAddress = slotNames.nodeModelAddress;
const modelContainer = slotNames.model;
const noncePattern = "OCE_SMOKE_[A-Za-z0-9-]+|FIRST_AGENT_[A-Za-z0-9-]+";
const minute = 60_000;
// Both stop requests share one serial worker. Per Agent, allow the selected
// gateway grace, two minutes for a dedicated workload to terminate and one
// minute for API observation/finalization. This is a finite smoke allowance,
// not a change to runtime grace, worker retries or the 40-minute CI job bound.
export const STOP_PHASE_TIMEOUT_MS = 2 * (GATEWAY_STOP_TIMEOUT_MS + 3 * minute);
const timings = [];
const proofResults = [];

function log(message) {
  process.stdout.write(`[first-agent-smoke] ${message}\n`);
}

function run(command, args, { env = process.env, input, timeout = 5 * minute, label } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const stream = (target, chunks) => (chunk) => {
      chunks.push(chunk);
      if (label) {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim()) {
            target.write(`[${label}] ${line}\n`);
          }
        }
      }
    };
    child.stdout.on("data", stream(process.stdout, stdout));
    child.stderr.on("data", stream(process.stderr, stderr));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolveRun(result);
        return;
      }
      const error = new Error(
        `${command} ${args.slice(0, 3).join(" ")} exited ${code ?? signal}\n${result.stderr.slice(-4000)}`,
      );
      error.result = result;
      reject(error);
    });
  });
}

async function step(name, operation) {
  const started = Date.now();
  log(`${name}: started`);
  try {
    const result = await operation();
    const seconds = Math.round((Date.now() - started) / 1000);
    timings.push([name, seconds, "ok"]);
    log(`${name}: ok (${seconds}s)`);
    return result;
  } catch (error) {
    timings.push([name, Math.round((Date.now() - started) / 1000), "failed"]);
    log(`${name}: FAILED`);
    throw error;
  }
}

function validTimeout(timeout) {
  assert.ok(
    Number.isSafeInteger(timeout) && timeout > 0,
    "Timeout must be a positive finite integer.",
  );
}

export async function waitFor(
  description,
  operation,
  timeout,
  { now = Date.now, sleep = delay } = {},
) {
  validTimeout(timeout);
  const deadline = now() + timeout;
  let last;
  while (now() < deadline) {
    last = await operation();
    if (now() > deadline) {
      break;
    }
    if (last?.done) {
      return last.value;
    }
    const remaining = deadline - now();
    if (remaining > 0) {
      await sleep(Math.min(2_000, remaining));
    }
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(last?.state ?? null)}`);
}

function agentStopState(agent) {
  const revision = agent?.activeRevisionId;
  return {
    desiredRuntimeState: ["running", "stopped"].includes(agent?.desiredRuntimeState)
      ? agent.desiredRuntimeState
      : "unknown",
    activeRevisionId:
      revision == null
        ? null
        : typeof revision === "string" &&
            /^rev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(revision)
          ? revision
          : "invalid",
    status: ["active", "deleting"].includes(agent?.status) ? agent.status : "unknown",
  };
}

export async function agentStopDiagnostic(readAgent) {
  try {
    return { phase: "agent-state", ...agentStopState(await readAgent()) };
  } catch {
    // A failed diagnostic read must not replace the smoke's original failure.
    return { phase: "agent-state", unavailable: true };
  }
}

export async function observeAgentStop(
  label,
  readAgent,
  readPods,
  { timeout = STOP_PHASE_TIMEOUT_MS, now = Date.now, sleep = delay } = {},
) {
  validTimeout(timeout);
  const started = now();
  const deadline = started + timeout;
  const clock = { now, sleep };
  await waitFor(
    `${label} to stop`,
    async () => {
      const current = await readAgent();
      assert.ok(
        current.desiredRuntimeState === "stopped",
        `${label}: desired state changed while stopping`,
      );
      return {
        done: !current.activeRevisionId,
        state: { phase: "active-revision", elapsedMs: now() - started, ...agentStopState(current) },
      };
    },
    timeout,
    clock,
  );
  const remaining = deadline - now();
  assert.ok(remaining > 0, `${label}: stop observation deadline expired before Pods were checked`);
  await waitFor(
    `${label} Pods to terminate after a reported stop`,
    async () => {
      const pods = await readPods();
      return {
        done: pods.length === 0,
        state: { phase: "pods", elapsedMs: now() - started, remainingPods: pods.length },
      };
    },
    Math.min(2 * minute, remaining),
    clock,
  );
}

// `run` reads the selections from its environment (GitHub Actions) or from the
// work directory (local runs).
async function exportEnvironment(values) {
  await writeFile(join(workDirectory, "images.json"), `${JSON.stringify(values)}\n`);
  if (process.env.GITHUB_ENV) {
    await appendFile(
      process.env.GITHUB_ENV,
      Object.entries(values)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
  }
}

// ---------------------------------------------------------------------------
// images

function cacheArguments(role) {
  // Restore only: main's cache is written by the warm workflow alone.
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    !process.env.ACTIONS_RUNTIME_TOKEN ||
    !process.env.ACTIONS_RESULTS_URL
  ) {
    return [];
  }
  const scope = `oce-ci-${role}-${process.platform}-${process.arch}-v1`;
  return ["--cache-from", `type=gha,version=2,scope=${scope},timeout=60s`];
}

// The image lanes and the warm job build with a fixed SOURCE_DATE_EPOCH, and
// BuildKit stamps the directories WORKDIR creates with it. Without the same
// value no step after an image's first WORKDIR matched their cache, so every
// smoke run reinstalled both images' packages (finding 1273). It sets only
// timestamps (image config, history, WORKDIR); the smoke reads none of them.
// RUN steps do not see it: an `ARG SOURCE_DATE_EPOCH` would change their keys.
const cacheBuildArguments = ["--build-arg", "SOURCE_DATE_EPOCH=0"];

async function pushedDigest(tag) {
  await run("docker", ["push", tag], { timeout: 10 * minute });
  const { stdout } = await run("docker", [
    "image",
    "inspect",
    "--format",
    "{{json .RepoDigests}}",
    tag,
  ]);
  const repository = tag.slice(0, tag.lastIndexOf(":"));
  const reference = JSON.parse(stdout).find((digest) => digest.startsWith(`${repository}@`));
  assert.match(reference ?? "", /@sha256:[a-f0-9]{64}$/, `no registry digest for ${tag}`);
  return reference;
}

async function buildImages() {
  const revision = (await run("git", ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  assert.match(revision, /^[a-f0-9]{40}$/);
  await mkdir(workDirectory, { recursive: true });
  const modelDirectory = join(workDirectory, "model");
  await step("model certificates", () =>
    createModelProviderFiles({
      directory: modelDirectory,
      caName: "oce-first-agent-smoke-ca",
      run,
    }),
  );
  await step("loopback registry", () =>
    run("docker", [
      "run",
      "--detach",
      "--name",
      slotNames.registryContainer,
      "--publish",
      `${registry}:5000`,
      registryImage,
    ]),
  );
  const controllerTag = `${registry}/oce-smoke/controller:${revision}`;
  const runtimeTag = `${registry}/oce-smoke/runtime-base:${revision}`;
  const smokeRuntimeTag = `${registry}/oce-smoke/runtime:${revision}`;
  // Both builds read the hosted caches main's warm job (ci-image-cache.yml) writes.
  await step("controller and runtime image builds", () =>
    Promise.all([
      run(
        "docker",
        [
          "buildx",
          "build",
          "--load",
          ...cacheArguments("controller"),
          ...cacheBuildArguments,
          "--pull=false",
          "--target",
          "runtime",
          "--build-arg",
          `NODE_BASE_IMAGE=${nodeBaseImage}`,
          "--label",
          `org.opencontainers.image.revision=${revision}`,
          "--tag",
          controllerTag,
          ".",
        ],
        { timeout: 40 * minute, label: "controller-build" },
      ),
      run(
        "docker",
        [
          "buildx",
          "build",
          "--load",
          ...cacheArguments("runtime"),
          ...cacheBuildArguments,
          "--pull=false",
          "--file",
          "deploy/runtime/Dockerfile",
          "--build-arg",
          `OCC_BUILD_REVISION=${revision}`,
          "--tag",
          runtimeTag,
          ".",
        ],
        { timeout: 40 * minute, label: "runtime-build" },
      ),
    ]),
  );
  // The only difference from the checkout's runtime image: the stand-in
  // provider's private CA in the system store (Codex) and for Node (OpenClaw).
  // Labels, user, entrypoint and every other layer are inherited unchanged.
  const context = join(workDirectory, "runtime-trust");
  await writeModelProviderTrust({ context, caPath: join(modelDirectory, "ca.pem") });
  await step("runtime trust layer", () =>
    run("docker", [
      "buildx",
      "build",
      "--builder",
      "default",
      "--load",
      "--build-arg",
      `RUNTIME_IMAGE=${runtimeTag}`,
      "--tag",
      smokeRuntimeTag,
      context,
    ]),
  );
  const [controller, runtime] = await step("registry digests", () =>
    Promise.all([pushedDigest(controllerTag), pushedDigest(smokeRuntimeTag)]),
  );
  await exportEnvironment({
    OCC_DEVELOPMENT_CONTROLLER_IMAGE: controller,
    OCC_KUBERNETES_RUNTIME_IMAGE: runtime,
    OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY: modelDirectory,
  });
  log(`controller ${controller}`);
  log(`runtime ${runtime}`);
}

// ---------------------------------------------------------------------------
// run

function createApi(origin, key) {
  return async (method, path, body) => {
    let response;
    try {
      response = await fetch(new URL(path, origin), {
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
      const cause = error.cause ? `: ${error.cause.code ?? ""} ${error.cause.message}` : "";
      throw new Error(`${method} ${path}: ${error.message}${cause}`, { cause: error });
    }
    const text = await response.text();
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path}: HTTP ${response.status} without JSON`);
    }
    if (!response.ok) {
      throw new Error(
        `${method} ${path}: HTTP ${response.status} ${JSON.stringify(envelope.error)}`,
      );
    }
    return envelope.data;
  };
}

const clusterName = slotNames.cluster;
const watchLog = join(workDirectory, "cluster-watch.log");

// `occ dev up` deletes its cluster when a step fails, so record what the
// cluster looked like while it was being installed. The returned stop function
// wakes an idle wait without another capture; one already running finishes.
// `finalCapture` takes one last snapshot, for a failed setup.
export function watchCluster() {
  const kubeconfig = join(workDirectory, "watch-kubeconfig");
  const wake = new AbortController();
  let finalCapture = false;
  const record = async (label, command, args) => {
    try {
      const { stdout } = await run(command, args, { timeout: minute });
      await appendFile(watchLog, `----- ${new Date().toISOString()} ${label}\n${stdout}\n`);
    } catch (error) {
      await appendFile(watchLog, `----- ${label} unavailable: ${error.message.slice(0, 300)}\n`);
    }
  };
  const capture = async () => {
    try {
      const { stdout } = await run("k3d", ["kubeconfig", "get", clusterName], {
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
      const { stdout } = await run("kubectl", [...k, "get", "pods", "-A", "-o", "json"]);
      for (const pod of JSON.parse(stdout).items) {
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
        await delay(30_000, undefined, { signal: wake.signal });
      } catch {
        break;
      }
      await capture();
    }
    if (finalCapture) {
      await capture();
    }
  })();
  return async ({ finalCapture: final = false } = {}) => {
    finalCapture = final;
    wake.abort();
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

async function startLocalSetup(environment) {
  const stopWatching = watchCluster();
  try {
    await run(occ, ["dev", "up"], { env: environment, timeout: 25 * minute, label: "dev-up" });
  } catch (error) {
    await stopWatching({ finalCapture: true });
    await printWatchLog();
    throw error;
  }
  await stopWatching();
  const directory = environment.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  const key = JSON.parse(await readFile(state.keyPath, "utf8"));
  return {
    directory,
    state,
    keyPath: state.keyPath,
    kubeconfig: join(directory, "kubeconfig"),
    context: `k3d-${state.cluster}`,
    origin: `http://127.0.0.1:${state.apiPort}`,
    api: createApi(`http://127.0.0.1:${state.apiPort}`, key.data.key),
  };
}

function kubectl(stack, args, options = {}) {
  return run("kubectl", ["--kubeconfig", stack.kubeconfig, "--context", stack.context, ...args], {
    timeout: 2 * minute,
    ...options,
  });
}

// Answer api.openai.com inside the cluster with the stand-in provider. Agent
// Pods reach it through their ordinary model egress NetworkPolicy and verify
// its certificate against the CA added to the runtime image.
async function routeModelProvider(stack, modelDirectory, runtimeImage, credentialDigests) {
  await run("docker", ["network", "create", "--subnet", modelNetwork.subnet, modelNetwork.name]);
  // Fixed addresses: Docker would otherwise give the node the provider's address.
  await run("docker", [
    "network",
    "connect",
    "--ip",
    nodeModelAddress,
    modelNetwork.name,
    `k3d-${stack.state.cluster}-server-0`,
  ]);
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
    "PROBE_ENDPOINT_CREDENTIAL_DIGESTS",
    "--env",
    "PROBE_PUBLIC_READ_JOURNEY=1",
    "--entrypoint",
    "node",
    runtimeImage,
    "/fixture/endpoint.mjs",
  ];
  await run("docker", providerArgs, {
    env: { ...process.env, PROBE_ENDPOINT_CREDENTIAL_DIGESTS: JSON.stringify(credentialDigests) },
  });
  await waitFor(
    "the stand-in provider to listen",
    async () => ({ done: (await modelEvents()).some(({ event }) => event === "listening") }),
    minute,
  );
  await configureModelProviderDNS({
    kubectl: (args, options) => kubectl(stack, args, options),
    waitFor,
    modelAddress,
    platformNamespace: stack.state.platformNamespace,
    serverFile: "oce-first-agent-smoke.server",
  });
}

// Local Setup installs the controller first. Use its generated Installation and
// chart values to add the reserved reader peer before admitting a revision.
async function enablePublicReader(stack) {
  const valuesPath = join(stack.directory, "helm-values.json");
  const values = JSON.parse(await readFile(valuesPath, "utf8"));
  const reader = await installPublicGithubReadFixture({
    namespace: stack.state.platformNamespace,
    controllerImage: values.images.controller,
    kubectl: async (...args) => (await kubectl(stack, args)).stdout,
    applyManifest: (input) => kubectl(stack, ["apply", "-f", "-"], { input }),
    waitFor: (description, operation, timeout) =>
      waitFor(description, async () => ({ done: await operation() }), timeout),
    observeRequests: true,
  });
  const installationPath = join(stack.directory, "installation.yaml");
  const installation = JSON.parse((await run("yq", ["-o=json", ".", installationPath])).stdout);
  installation.drivers.compute.configuration.network.publicGithubRead = reader.peer;
  const installationData = JSON.stringify(installation);
  await writeFile(installationPath, installationData);
  const patchPath = join(stack.directory, `installation-patch-${randomUUID()}.json`);
  try {
    await writeFile(
      patchPath,
      JSON.stringify({ stringData: { "installation.yaml": installationData } }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await kubectl(stack, [
      "-n",
      stack.state.platformNamespace,
      "patch",
      "secret",
      "occ-installation-startup",
      "--type=merge",
      `--patch-file=${patchPath}`,
    ]);
  } finally {
    await rm(patchPath, { force: true });
  }
  values.controlPlane = {
    ...values.controlPlane,
    installationChecksum: createHash("sha256").update(installationData).digest("hex"),
  };
  await writeFile(valuesPath, JSON.stringify(values));
  await run("helm", [
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
    valuesPath,
    "--wait",
    "--timeout",
    "5m",
  ]);
  return reader;
}

async function modelEvents() {
  const { stdout } = await run("docker", ["logs", modelContainer]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

async function assertModelAnswered(nonce, label) {
  const events = await modelEvents();
  const answered = events.find(
    ({ event, status, text, caller }) =>
      event === "turn-answered" && status === 200 && text === nonce && caller === label,
  );
  assert.ok(
    answered,
    `${label}: the stand-in provider never answered ${nonce} with this Agent's credential`,
  );
  return answered.transport;
}

function cli(stack, args, options = {}) {
  return run(occ, args, {
    env: {
      ...process.env,
      OCC_URL: stack.origin,
      OCC_SERVICE_KEY_FILE: stack.keyPath,
      OCC_NAMESPACE: stack.namespaceId,
    },
    timeout: 2 * minute,
    ...options,
  });
}

async function cliJson(stack, args) {
  return JSON.parse((await cli(stack, [...args, "-o", "json"])).stdout);
}

// A deployment must settle at succeeded with its revision active; a failed
// status fails the smoke at once. Serving is proven separately by a model turn.
async function waitForDeployment(stack, agentId, revisionId, label) {
  const base = `/namespaces/${stack.namespaceId}/agents/${agentId}`;
  await waitFor(
    `${label} revision ${revisionId}`,
    async () => {
      const [deployment, agent] = await Promise.all([
        stack.api("GET", `${base}/deployments/${revisionId}`),
        stack.api("GET", base),
      ]);
      if (deployment.status === "failed") {
        throw new Error(`${label}: deployment failed ${JSON.stringify(deployment.error)}`);
      }
      return {
        done: deployment.status === "succeeded" && agent.activeRevisionId === revisionId,
        state: { deployment: deployment.status, active: agent.activeRevisionId },
      };
    },
    10 * minute,
  );
}

// Pending or Running Agent Pods. A terminating Pod (deletionTimestamp set)
// can still be running during graceful shutdown, so it counts unless the
// caller asks for live Pods only (gateway selection).
async function agentPods(stack, agentId, { includeTerminating = false } = {}) {
  const { stdout } = await kubectl(stack, [
    "get",
    "pods",
    "--all-namespaces",
    "-l",
    `openclaw.dev/agent=${agentId}`,
    "-o",
    "json",
  ]);
  // Completed setup Pods are history, not workloads.
  return JSON.parse(stdout).items.filter(
    (pod) =>
      (includeTerminating || !pod.metadata.deletionTimestamp) &&
      ["Pending", "Running"].includes(pod.status?.phase),
  );
}

function idHash(id) {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

async function readyGateway(stack, agentId, revisionId) {
  const pods = await agentPods(stack, agentId);
  // Same revision match as scripts/first-agent-model.mjs: the gateway Pod
  // mounts its revision's configuration ConfigMap.
  const configMap = `gateway-${idHash(agentId)}-rev-${idHash(revisionId)}`;
  const gateways = pods.filter(
    (pod) =>
      pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
      pod.spec?.volumes?.some((volume) => volume.configMap?.name === configMap) &&
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
  );
  assert.equal(
    gateways.length,
    1,
    `expected one Ready gateway Pod for ${revisionId}, found ${gateways.length} of ${pods.length} Agent Pods`,
  );
  return { namespace: gateways[0].metadata.namespace, pod: gateways[0].metadata.name };
}

// Runs inside the gateway container: one authenticated OpenAI-compatible chat
// turn through the Agent's own gateway, as a client of the Agent would send it.
async function gatewayTurn({ prompt }) {
  const port = process.env.OPENCLAW_GATEWAY_PORT ?? "8080";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_PASSWORD}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(170_000),
    });
    const text = await response.text();
    let content;
    try {
      content = JSON.parse(text).choices?.[0]?.message?.content;
    } catch {
      content = undefined;
    }
    process.stdout.write(
      JSON.stringify({
        status: response.status,
        content: typeof content === "string" ? content : undefined,
        body: response.status === 200 ? undefined : text.slice(0, 2_000),
      }),
    );
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }));
  }
}

async function chatTurn(stack, agent, revisionId) {
  const { namespace, pod } = await readyGateway(stack, agent.id, revisionId);
  const nonce = `OCE_SMOKE_${randomUUID()}`;
  const prompt = `Reply with exactly this nonce and no other text: ${nonce}`;
  const script = `await (${gatewayTurn.toString()})(${JSON.stringify({ prompt })});`;
  const { stdout } = await kubectl(
    stack,
    ["exec", "-i", "-n", namespace, pod, "-c", "gateway", "--", "node", "--input-type=module", "-"],
    { input: script, timeout: 4 * minute },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.status, 200, `${agent.label}: chat turn failed ${JSON.stringify(result)}`);
  assert.ok(
    result.content?.includes(nonce),
    `${agent.label}: reply did not carry the nonce ${JSON.stringify(result)}`,
  );
  const transport = await assertModelAnswered(nonce, agent.label);
  log(`${agent.label}: chat turn on ${revisionId} answered over ${transport}`);
}

async function readLogs(stack, agent, source) {
  const { stdout } = await cli(stack, [
    "agent",
    "logs",
    agent.id,
    "--source",
    source,
    "--tail",
    "200",
  ]);
  assert.ok(
    stdout.trim().length > 0,
    `${agent.label}: occ agent logs --source ${source} was empty`,
  );
  log(
    `${agent.label}: occ agent logs --source ${source} returned ${stdout.split("\n").length} lines`,
  );
}

async function stopAgent(stack, agent) {
  const stopped = await cliJson(stack, ["agent", "stop", agent.id]);
  assert.equal(stopped.desiredRuntimeState, "stopped", `${agent.label}: stop not accepted`);
  // The active revision clears only after Compute reports shutdown; still
  // verify that no Agent workload remains after the controller reports it.
  await observeAgentStop(
    agent.label,
    () => stack.api("GET", `/namespaces/${stack.namespaceId}/agents/${agent.id}`),
    () => agentPods(stack, agent.id, { includeTerminating: true }),
  );
}

async function deployAgent(stack, agent) {
  const revision = await cliJson(stack, ["agent", "deploy", agent.id]);
  assert.match(revision.id ?? "", /^rev_/, `${agent.label}: deploy returned no revision`);
  await waitForDeployment(stack, agent.id, revision.id, agent.label);
  const current = await stack.api("GET", `/namespaces/${stack.namespaceId}/agents/${agent.id}`);
  assert.equal(current.desiredRuntimeState, "running", `${agent.label}: not running after deploy`);
  return revision.id;
}

async function runFirstAgent(stack, modelCredential) {
  const { stdout } = await run(
    process.execPath,
    [join(root, "scripts/first-agent.mjs"), "smoke-embedded"],
    {
      env: {
        ...process.env,
        OCC_DEVELOPMENT_STATE_DIRECTORY: stack.directory,
        OCC_SERVICE_KEY_FILE: stack.keyPath,
        OCC_URL: stack.origin,
        OPENAI_API_KEY: modelCredential,
      },
      timeout: 15 * minute,
      label: "first-agent",
    },
  );
  const field = (name) => new RegExp(`^${name}: (\\S+)$`, "m").exec(stdout)?.[1];
  const agent = { label: "embedded", id: field("Agent ID") };
  const revisionId = field("Revision");
  const nonce = field("Model response verified");
  assert.match(agent.id ?? "", /^agt_/, "first-agent printed no Agent ID");
  stack.agents.push(agent);
  assert.match(nonce ?? "", /^FIRST_AGENT_/, "first-agent printed no verified nonce");
  // first-agent waited for this exact revision; recheck it independently.
  await waitForDeployment(stack, agent.id, revisionId, agent.label);
  const transport = await assertModelAnswered(nonce, agent.label);
  log(`embedded: first-agent model check answered over ${transport}`);
  return { agent, revisionId };
}

// The dedicated Codex Agent follows the console's API path: a Namespace Secret
// for the model key, an exact operate grant for the Agent's service principal,
// transport credentials, then deployment.
async function createCodexAgent(stack, reader, label, modelCredential) {
  const base = `/namespaces/${stack.namespaceId}`;
  const secret = await stack.api("POST", `${base}/secrets`, {
    name: `smoke-codex-${randomUUID()}`,
    value: modelCredential,
  });
  const values = createHarnessConfiguration("codex", defaultAgentModel);
  if (reader) {
    values.plugins.entries.codex.config.appServer.networkProxy = {
      enabled: true,
      mode: "limited",
      allowLocalBinding: false,
      domains: { [reader.peer.address]: "allow" },
    };
  }
  const configuration = await stack.api("POST", `${base}/configurations`, {
    kind: "agent",
    values,
  });
  const created = await stack.api("POST", `${base}/agents`, {
    name: `smoke-${label}`,
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  const role = await stack.api("POST", `${base}/iam/roles`, {
    name: `Smoke ${label} Secret operate`,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  await stack.api("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: created.servicePrincipalId,
    roleId: role.id,
    resourceKind: "secret",
    resourceId: secret.id,
  });
  const credentials = await stack.api("GET", `${base}/agents/${created.id}/runtime-credentials`);
  if (!credentials.transportConfigured) {
    await stack.api("POST", `${base}/agents/${created.id}/runtime-credentials`, {});
  }
  const agent = { label, id: created.id };
  stack.agents.push(agent);
  const revisionId = await deployAgent(stack, agent);
  return { agent, revisionId, configurationId: configuration.id, values };
}

async function readerEvents(stack) {
  const { stdout } = await kubectl(stack, [
    "-n",
    stack.state.platformNamespace,
    "logs",
    "deployment/openclaw-enterprise-public-github-read",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

async function gatewaySkillStatus(stack, gateway) {
  const { stdout } = await kubectl(
    stack,
    [
      "exec",
      "-n",
      gateway.namespace,
      gateway.pod,
      "-c",
      "gateway",
      "--",
      "node",
      "/app/openclaw.mjs",
      "gateway",
      "call",
      "skills.status",
      "--params",
      JSON.stringify({ agentId: "main" }),
      "--json",
      "--timeout",
      "180000",
    ],
    { timeout: 4 * minute },
  );
  return JSON.parse(stdout);
}

// Inspect the persisted admission, or invoke the exact Compute withdrawal boundary.
// An Installation change alone does not schedule this observation.
async function observeReaderPeer(stack, selected, action) {
  const input = {
    namespaceId: stack.namespaceId,
    agentId: selected.agent.id,
    revisionId: selected.revisionId,
  };
  const script = `
import assert from "node:assert/strict";
import { createPostgresPool, PostgresPlatformState } from "/app/packages/occ/src/index.ts";
import { loadStartupConfigurationSnapshot, loadInstallationConfiguration } from "/app/apps/controller/src/composition/installation-config.ts";
const input = ${JSON.stringify(input)};
const pool = await createPostgresPool(process.env.OCC_DATABASE_URL);
try {
  const state = new PostgresPlatformState(pool);
  const revision = await state.read((view) => view.revisions.findRevision(input.namespaceId, input.agentId, input.revisionId));
  assert.ok(revision, "admitted revision is unavailable");
  const startup = await loadStartupConfigurationSnapshot({ mode: "production" });
  const selected = await loadInstallationConfiguration({ mode: "production", startupConfiguration: startup });
  assert.ok(revision.compute.admission && selected.computeDriver.admitRevision(revision) === revision.compute.admission, "revision did not select the installed reader");
  if (${JSON.stringify(action)} === "withdraw") {
    const configuration = structuredClone(startup.configuration);
    delete configuration.drivers.compute.configuration.network.publicGithubRead;
    const withdrawn = await loadInstallationConfiguration({ mode: "production", startupConfiguration: { ...startup, configuration } });
    await assert.rejects(withdrawn.computeDriver.prepareRevision(revision), (error) => {
      assert.equal(error.message, "Public GitHub reader peer was withdrawn; deploy a new AgentRevision.");
      assert.equal(withdrawn.computeDriver.describePrepareRevisionFailure(error).code, "KUBERNETES_CONFIGURATION_INVALID");
      return true;
    });
  }
  console.log("reader-peer-observed");
} finally { await pool.end(); }
`;
  const admission = await kubectl(
    stack,
    [
      "exec",
      "-i",
      "-n",
      stack.state.platformNamespace,
      "deployment/openclaw-enterprise-worker",
      "-c",
      "worker",
      "--",
      "node",
      "--input-type=module",
      "-",
    ],
    { input: script, timeout: 4 * minute },
  );
  assert.match(admission.stdout, /reader-peer-observed/);
}

async function assertSelectedReaderProjection(stack, selected, gateway) {
  await observeReaderPeer(stack, selected, "inspect");
  log("public reader admission: confirmed");
  const harness = await revisionHarness(stack, selected.agent, selected.revisionId);
  const skillPath = "/home/node/.openclaw/skills/public-github-read/SKILL.md";
  const policy = `allow-public-github-read-${idHash(selected.agent.id)}-rev-${idHash(selected.revisionId)}`;
  const granted = await kubectl(stack, [
    "-n",
    harness.metadata.namespace,
    "get",
    "networkpolicy",
    policy,
    "-o",
    "name",
  ]);
  assert.ok(granted.stdout.trim(), "selected revision has no reader policy");
  log("public reader policy: present");
  for (const [namespace, pod, container] of [
    [gateway.namespace, gateway.pod, "gateway"],
    [harness.metadata.namespace, harness.metadata.name, "agent"],
  ]) {
    const observed = JSON.parse(
      (await kubectl(stack, ["-n", namespace, "get", "pod", pod, "-o", "json"])).stdout,
    );
    const mounts =
      observed.spec.containers.find(({ name }) => name === container)?.volumeMounts ?? [];
    const mount = mounts.find(({ mountPath }) => mountPath === skillPath);
    assert.ok(
      mount?.readOnly && mount.subPath === PUBLIC_GITHUB_READ_SKILL,
      `${container} skill mount missing`,
    );
    await kubectl(stack, [
      "exec",
      "-n",
      namespace,
      pod,
      "-c",
      container,
      "--",
      "test",
      "-r",
      skillPath,
    ]);
    log(`public reader ${container} mount: present`);
  }
}

async function publicReadTurn(stack, selected, reader) {
  const gateway = await readyGateway(stack, selected.agent.id, selected.revisionId);
  await assertSelectedReaderProjection(stack, selected, gateway);
  const status = await gatewaySkillStatus(stack, gateway);
  assert.ok(
    status.skills.some(({ name }) => name === "public-github-read"),
    "managed skill was not discovered",
  );
  log("public reader Gateway discovery: confirmed");
  const { namespace, pod } = gateway;
  const prompt =
    "OCE_PUBLIC_READ_JOURNEY: Use the managed public GitHub read skill to obtain pull request 27 in example/public-project and return its title.";
  const script = `await (${gatewayTurn.toString()})(${JSON.stringify({ prompt })});`;
  const { stdout } = await kubectl(
    stack,
    ["exec", "-i", "-n", namespace, pod, "-c", "gateway", "--", "node", "--input-type=module", "-"],
    { input: script, timeout: 4 * minute },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.status, 200, "public read model turn failed");
  assert.ok(
    result.content?.includes(reader.marker),
    "model did not return the provider-only title",
  );
  const events = await readerEvents(stack);
  for (const event of ["reader", "provider"]) {
    assert.ok(
      events.some((item) => item.event === event && item.path.endsWith("/27")),
      `${event} did not receive selected read`,
    );
  }
}

async function revisionHarness(stack, agent, revisionId) {
  const pods = (await agentPods(stack, agent.id)).filter(
    (pod) =>
      pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent" &&
      pod.metadata.labels?.["openclaw.dev/revision"] === revisionId &&
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
  );
  assert.equal(pods.length, 1, `expected one ready Harness for ${agent.label}`);
  return pods[0];
}

// Keep one Agent-to-reader socket busy, avoiding the reader's idle timeout.
// A second selected Agent performs the same requests throughout the interval.
function holdReaderSocket(stack, pod, address, number) {
  const script = `const http = require('node:http');
const agent = new http.Agent({keepAlive:true, maxSockets:1});
let busy = false;
function read() {
  if (busy) return;
  busy = true;
  const req = http.get({host:${JSON.stringify(address)}, port:8080, path:'/repos/example/public-project/pulls/${number}', agent}, res => {
    res.resume(); res.on('end', () => { if (res.statusCode !== 200) process.exit(2); busy = false; console.log('ok'); });
  });
  req.on('error', () => process.exit(3));
  req.setTimeout(3000, () => req.destroy());
}
read(); const interval = setInterval(read, 1000);
process.stdin.on('data', () => { clearInterval(interval); agent.destroy(); process.exit(0); });`;
  const child = spawn(
    "kubectl",
    [
      "--kubeconfig",
      stack.kubeconfig,
      "--context",
      stack.context,
      "exec",
      "-i",
      "-n",
      pod.metadata.namespace,
      pod.metadata.name,
      "-c",
      "agent",
      "--",
      "node",
      "-e",
      script,
    ],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let closed = false;
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.resume();
  const done = new Promise((resolveDone, reject) => {
    child.once("error", reject);
    child.once("close", () => {
      closed = true;
      resolveDone();
    });
  });
  return { child, done, count: () => (output.match(/^ok$/gm) ?? []).length, closed: () => closed };
}

// One line per proveRetirement sub-wait, so a slow retirement step names its slow wait
// (61fba7ca2 spent 357 s of that step in silence). Logged on failure too.
async function retirementWait(name, operation) {
  const started = Date.now();
  let outcome = "FAILED";
  try {
    const result = await operation();
    outcome = "ok";
    return result;
  } finally {
    log(
      `reader retirement: ${name} ${outcome} at ${new Date().toISOString()} after ${Date.now() - started} ms`,
    );
  }
}

async function proveRetirement(stack, selected, control, reader) {
  const old = await revisionHarness(stack, selected.agent, selected.revisionId);
  const live = await revisionHarness(stack, control.agent, control.revisionId);
  const held = holdReaderSocket(stack, old, reader.peer.address, 28);
  const stillSelected = holdReaderSocket(stack, live, reader.peer.address, 30);
  try {
    await retirementWait("held sockets", () =>
      waitFor(
        "both selected Harness sockets",
        async () => ({
          done: held.count() >= 2 && stillSelected.count() >= 2,
          state: { held: held.count(), control: stillSelected.count() },
        }),
        minute,
      ),
    );
    const before = await readerEvents(stack);
    const oldRequests = before.filter(
      (event) => event.event === "reader" && event.path.endsWith("/28"),
    );
    const oldConnection = oldRequests.at(-1)?.connection;
    assert.ok(oldConnection, "selected Harness did not use a reader socket");
    assert.ok(
      !before.some((event) => event.event === "closed" && event.connection === oldConnection),
      "selected socket was not held before retirement",
    );
    const controlRequests = before.filter(
      (event) => event.event === "reader" && event.path.endsWith("/30"),
    );
    const controlConnection = controlRequests.at(-1)?.connection;
    assert.ok(controlConnection, "selected control did not use a reader socket");
    assert.notEqual(oldConnection, controlConnection, "held and control sockets must be distinct");
    assert.ok(
      oldRequests.filter((event) => event.connection === oldConnection).length >= 2,
      "selected Harness did not complete two requests on the held socket",
    );
    assert.ok(
      controlRequests.filter((event) => event.connection === controlConnection).length >= 2,
      "control Harness did not complete two requests on its held socket",
    );
    await retirementWait("observeReaderPeer withdraw", () =>
      observeReaderPeer(stack, selected, "withdraw"),
    );
    const deployment = `agent-${idHash(selected.agent.id)}-rev-${idHash(selected.revisionId)}`;
    const { stdout: oldDeployment } = await kubectl(stack, [
      "-n",
      old.metadata.namespace,
      "get",
      "deployment",
      deployment,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    assert.equal(oldDeployment.trim(), "", "withdrawn revision still has a Deployment");
    await retirementWait("old Harness Pod termination", () =>
      waitFor(
        "old Harness Pod to terminate",
        async () => {
          const { stdout } = await kubectl(stack, [
            "-n",
            old.metadata.namespace,
            "get",
            "pods",
            "-l",
            `openclaw.dev/agent=${selected.agent.id},openclaw.dev/revision=${selected.revisionId},openclaw.dev/workload-role=agent`,
            "-o",
            "json",
          ]);
          return { done: JSON.parse(stdout).items.length === 0 };
        },
        2 * minute,
      ),
    );
    const policy = `allow-public-github-read-${idHash(selected.agent.id)}-rev-${idHash(selected.revisionId)}`;
    const { stdout: oldPolicy } = await kubectl(stack, [
      "-n",
      old.metadata.namespace,
      "get",
      "networkpolicy",
      policy,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    assert.equal(oldPolicy.trim(), "", "retired revision still has a reader policy");
    // Capture effects immediately at the absent Deployment, Pod, and policy barrier.
    const barrier = await readerEvents(stack);
    const count = (events, event, number) =>
      events.filter((item) => item.event === event && item.path.endsWith(`/${number}`)).length;
    const oldReaderAtBarrier = count(barrier, "reader", 28);
    const oldProviderAtBarrier = count(barrier, "provider", 28);
    const controlReaderAtBarrier = count(barrier, "reader", 30);
    const controlProviderAtBarrier = count(barrier, "provider", 30);
    await retirementWait("retired sockets closed", () =>
      waitFor(
        "retired Harness process and sockets to close",
        async () => {
          const events = await readerEvents(stack);
          const connections = new Set(
            events
              .filter((event) => event.event === "reader" && event.path.endsWith("/28"))
              .map((event) => event.connection),
          );
          const closed = new Set(
            events.filter((event) => event.event === "closed").map((event) => event.connection),
          );
          return {
            done:
              held.closed() &&
              connections.size > 0 &&
              [...connections].every((connection) => closed.has(connection)),
          };
        },
        minute,
      ),
    );
    assert.ok(!stillSelected.closed(), "selected control stopped during withdrawal");
    const unselected = structuredClone(selected.values);
    unselected.plugins.entries.codex.config.appServer.networkProxy.domains = {};
    await stack.api(
      "PATCH",
      `/namespaces/${stack.namespaceId}/configurations/${selected.configurationId}`,
      { values: unselected },
    );
    const successor = await retirementWait("successor deploy", () =>
      deployAgent(stack, selected.agent),
    );
    const current = await revisionHarness(stack, selected.agent, successor);
    const successorPolicy = `allow-public-github-read-${idHash(selected.agent.id)}-rev-${idHash(successor)}`;
    const { stdout: currentPolicy } = await kubectl(stack, [
      "-n",
      current.metadata.namespace,
      "get",
      "networkpolicy",
      successorPolicy,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    assert.equal(currentPolicy.trim(), "", "unselected successor acquired a reader policy");
    await kubectl(stack, [
      "exec",
      "-n",
      current.metadata.namespace,
      current.metadata.name,
      "-c",
      "agent",
      "--",
      "sh",
      "-c",
      "test ! -e /home/node/.openclaw/skills/public-github-read/SKILL.md",
    ]);
    const successorGateway = await readyGateway(stack, selected.agent.id, successor);
    await kubectl(stack, [
      "exec",
      "-n",
      successorGateway.namespace,
      successorGateway.pod,
      "-c",
      "gateway",
      "--",
      "sh",
      "-c",
      "test ! -e /home/node/.openclaw/skills/public-github-read/SKILL.md",
    ]);
    const successorStatus = await gatewaySkillStatus(stack, successorGateway);
    assert.ok(
      !successorStatus.skills.some(({ name }) => name === "public-github-read"),
      "unselected successor discovered the reader skill",
    );
    log("unselected Gateway and Harness skill: absent");
    const negative = `const http = require('node:http');
const req = http.get({host:${JSON.stringify(reader.peer.address)}, port:8080, path:'/repos/example/public-project/pulls/29'}, res => {res.resume(); process.exit(1)});
const timer = setTimeout(() => req.destroy(new Error('probe-deadline')), 5000);
req.on('error', error => { clearTimeout(timer); process.exit(error.message === 'probe-deadline' || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code) ? 0 : 2); });`;
    const controlBeforeNegative = stillSelected.count();
    await kubectl(
      stack,
      [
        "exec",
        "-n",
        current.metadata.namespace,
        current.metadata.name,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        negative,
      ],
      { timeout: 15_000 },
    );
    await retirementWait("selected control after unselected probe", () =>
      waitFor(
        "selected control after unselected probe",
        async () => {
          const events = await readerEvents(stack);
          return {
            done:
              stillSelected.count() > controlBeforeNegative &&
              count(events, "reader", 30) > controlReaderAtBarrier &&
              count(events, "provider", 30) > controlProviderAtBarrier,
          };
        },
        minute,
      ),
    );
    const after = await readerEvents(stack);
    assert.equal(
      after.filter(
        (event) => ["reader", "provider"].includes(event.event) && event.path.endsWith("/29"),
      ).length,
      0,
      "unselected request reached reader or provider",
    );
    assert.equal(
      count(after, "reader", 28),
      oldReaderAtBarrier,
      "retired Harness sent a later read",
    );
    assert.equal(
      count(after, "provider", 28),
      oldProviderAtBarrier,
      "retired Harness caused a later provider request",
    );
    const proof =
      `revision=${selected.revisionId} environment=local-setup-k3d skips=0 ` +
      "selected=ok peer-withdrawal=confirmed held-socket=closed old-deployment-pod-policy=gone retired-reader-delta=0 retired-provider-delta=0 unselected-reader=0 unselected-provider=0 selected-control=ok controlled-model-provider";
    proofResults.push(proof);
    log(`public reader: ${proof}`);
    return successor;
  } finally {
    const cleanup = setTimeout(() => {
      held.child.kill("SIGKILL");
      stillSelected.child.kill("SIGKILL");
    }, 5_000);
    try {
      held.child.stdin.end("stop");
      stillSelected.child.stdin.end("stop");
      await Promise.all([held.done, stillSelected.done]);
    } finally {
      clearTimeout(cleanup);
    }
  }
}

async function diagnostics(stack) {
  log("collecting diagnostics");
  const attempt = async (label, operation) => {
    try {
      const result = await operation();
      process.stdout.write(`----- ${label}\n${result.stdout.slice(-20_000)}\n`);
    } catch (error) {
      process.stdout.write(`----- ${label} unavailable: ${error.message.slice(0, 500)}\n`);
    }
  };
  await attempt("stand-in provider events", () =>
    run("docker", ["logs", "--tail", "200", modelContainer]),
  );
  if (!stack) {
    return;
  }
  await attempt("pods", () => kubectl(stack, ["get", "pods", "-A", "-o", "wide"]));
  await attempt("events", () =>
    kubectl(stack, ["get", "events", "-A", "--sort-by=.lastTimestamp"]),
  );
  for (const agent of stack.agents ?? []) {
    const stopState = await agentStopDiagnostic(() =>
      stack.api("GET", `/namespaces/${stack.namespaceId}/agents/${agent.id}`),
    );
    process.stdout.write(`----- ${agent.label} Agent stop state\n${JSON.stringify(stopState)}\n`);
    await attempt(`${agent.label} deployment status`, () =>
      cli(stack, ["agent", "deployment-status", agent.id, "-o", "json"]),
    );
    for (const source of ["gateway", "agent"]) {
      await attempt(`${agent.label} ${source} logs`, () =>
        cli(stack, ["agent", "logs", agent.id, "--source", source, "--tail", "300"]),
      );
    }
  }
  try {
    const { stdout } = await kubectl(stack, [
      "-n",
      stack.state.platformNamespace,
      "get",
      "pods",
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);
    for (const pod of stdout.split(/\s+/).filter(Boolean)) {
      await attempt(`platform Pod ${pod} logs`, () =>
        kubectl(stack, [
          "-n",
          stack.state.platformNamespace,
          "logs",
          pod,
          "--all-containers",
          "--tail",
          "200",
        ]),
      );
    }
  } catch (error) {
    process.stdout.write(`----- platform Pods unavailable: ${error.message.slice(0, 500)}\n`);
  }
}

async function smoke() {
  if (!process.env.OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY) {
    try {
      Object.assign(
        process.env,
        JSON.parse(await readFile(join(workDirectory, "images.json"), "utf8")),
      );
    } catch {
      throw new Error("Run `node scripts/ci/first-agent-smoke.mjs images` first.");
    }
  }
  const modelDirectory = process.env.OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY;
  const environment = {
    ...process.env,
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
    OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
    OCC_DEVELOPMENT_STATE_DIRECTORY: join(await realpath(workDirectory), "local-setup"),
    OCC_DEVELOPMENT_KUBERNETES_CLUSTER: clusterName,
    OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "900",
  };
  delete environment.OPENAI_API_KEY;
  const modelCredentials = Object.fromEntries(
    ["embedded", "codex", "reader-control"].map((label) => [label, `sk-oce-smoke-${randomUUID()}`]),
  );
  const credentialDigests = Object.fromEntries(
    Object.entries(modelCredentials).map(([label, value]) => [
      label,
      createHash("sha256").update(value).digest("hex"),
    ]),
  );
  let stack;
  try {
    stack = await step("Local Setup (occ dev up)", () => startLocalSetup(environment));
    stack.agents = [];
    const namespaces = await stack.api("GET", "/namespaces");
    stack.namespaceId = namespaces.find(({ name }) => name === "default")?.id;
    assert.ok(stack.namespaceId, "Local Setup created no default Namespace");
    const reader = await step("install public reader and select its peer", () =>
      enablePublicReader(stack),
    );
    await step("route api.openai.com to the stand-in provider", () =>
      routeModelProvider(
        stack,
        modelDirectory,
        process.env.OCC_KUBERNETES_RUNTIME_IMAGE,
        credentialDigests,
      ),
    );
    // The two Agents are independent; deploy them together to bound CI time.
    const [embedded, codex, control] = await Promise.all([
      step("embedded OpenClaw Agent via scripts/first-agent.mjs", () =>
        runFirstAgent(stack, modelCredentials.embedded),
      ),
      step("dedicated Codex Agent via the API", () =>
        createCodexAgent(stack, reader, "codex", modelCredentials.codex),
      ),
      step("selected reader control via the API", () =>
        createCodexAgent(stack, reader, "reader-control", modelCredentials["reader-control"]),
      ),
    ]);
    await step("dedicated Codex chat turn", () => chatTurn(stack, codex.agent, codex.revisionId));
    await step("selected Agent managed-skill public read", () =>
      publicReadTurn(stack, codex, reader),
    );
    const retiredRevision = await step("reader retirement and unselected successor", () =>
      proveRetirement(stack, codex, control, reader),
    );
    await step("occ agent logs", async () => {
      await readLogs(stack, embedded.agent, "gateway");
      await readLogs(stack, codex.agent, "gateway");
      await readLogs(stack, codex.agent, "agent");
    });
    await step("stop both Agents", () =>
      Promise.all([stopAgent(stack, embedded.agent), stopAgent(stack, codex.agent)]),
    );
    const [embeddedRevision, codexRevision] = await step("start both Agents", () =>
      Promise.all([deployAgent(stack, embedded.agent), deployAgent(stack, codex.agent)]),
    );
    assert.notEqual(embeddedRevision, embedded.revisionId, "start must admit a new revision");
    assert.notEqual(codexRevision, retiredRevision, "start must admit a new revision");
    await step("chat turns after start", () =>
      Promise.all([
        chatTurn(stack, embedded.agent, embeddedRevision),
        chatTurn(stack, codex.agent, codexRevision),
      ]),
    );
  } catch (error) {
    await diagnostics(stack);
    throw error;
  }
}

async function summarize() {
  const lines = ["| Step | Seconds | Result |", "| --- | ---: | --- |"];
  for (const [name, seconds, status] of timings) {
    lines.push(`| ${name} | ${seconds} | ${status} |`);
  }
  for (const proof of proofResults) {
    lines.push("", `Public reader: ${proof}`);
  }
  try {
    const disk = await statfs("/");
    lines.push("", `Free disk: ${Math.round((disk.bavail * disk.bsize) / 1024 ** 3)} GiB`);
  } catch {
    // Informational only.
  }
  log(`\n${lines.join("\n")}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### First Agent smoke\n\n${lines.join("\n")}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === "images") {
      await buildImages();
    } else if (command === "run") {
      await smoke();
    } else {
      throw new Error("Usage: node scripts/ci/first-agent-smoke.mjs images|run");
    }
  } catch (error) {
    process.stderr.write(`first-agent-smoke: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  } finally {
    await summarize();
  }
}
