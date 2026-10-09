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
import { appendFile, mkdir, readFile, realpath, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import { createHarnessConfiguration } from "../../tests/helpers/harness-configuration.mjs";
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
const registry = "127.0.0.1:5000";
// Pinned like tests/integration/container-registry-real.test.mjs.
const registryImage =
  "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const nodeBaseImage =
  "docker.io/library/node:24-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0";
// Agent NetworkPolicies allow model egress only to public addresses on TCP/443,
// and OpenClaw refuses provider addresses in private or special-use ranges. The
// stand-in provider therefore uses a globally routable address, reachable only
// on this host's Docker network; nothing outside the runner is contacted.
const modelNetwork = { name: "oce-first-agent-smoke-model", subnet: "11.111.0.0/29" };
const modelAddress = "11.111.0.2";
const nodeModelAddress = "11.111.0.3";
const modelContainer = "oce-first-agent-smoke-model";
const noncePattern = "OCE_SMOKE_[A-Za-z0-9-]+|FIRST_AGENT_[A-Za-z0-9-]+";
const minute = 60_000;
const timings = [];

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

async function waitFor(description, operation, timeout) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (last?.done) {
      return last.value;
    }
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(last?.state ?? null)}`);
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
  // Restore only: main's cache is written by the warm workflow and main pushes.
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
      "oce-first-agent-smoke-registry",
      "--publish",
      `${registry}:5000`,
      registryImage,
    ]),
  );
  const controllerTag = `${registry}/oce-smoke/controller:${revision}`;
  const runtimeTag = `${registry}/oce-smoke/runtime-base:${revision}`;
  const smokeRuntimeTag = `${registry}/oce-smoke/runtime:${revision}`;
  // Both builds read the hosted caches the Images and Packaging lane writes.
  await step("controller and runtime image builds", () =>
    Promise.all([
      run(
        "docker",
        [
          "buildx",
          "build",
          "--load",
          ...cacheArguments("controller"),
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

const clusterName = "occ-dev-first-agent-smoke";
const watchLog = join(workDirectory, "cluster-watch.log");

// `occ dev up` deletes its cluster when a step fails, so record what the
// cluster looked like while it was being installed.
function watchCluster() {
  const kubeconfig = join(workDirectory, "watch-kubeconfig");
  let stopped = false;
  const record = async (label, command, args) => {
    try {
      const { stdout } = await run(command, args, { timeout: minute });
      await appendFile(watchLog, `----- ${new Date().toISOString()} ${label}\n${stdout}\n`);
    } catch (error) {
      await appendFile(watchLog, `----- ${label} unavailable: ${error.message.slice(0, 300)}\n`);
    }
  };
  const loop = (async () => {
    while (!stopped) {
      await delay(30_000);
      try {
        const { stdout } = await run("k3d", ["kubeconfig", "get", clusterName], {
          timeout: minute,
        });
        await writeFile(kubeconfig, stdout, { mode: 0o600 });
      } catch {
        continue;
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
    }
  })();
  return async () => {
    stopped = true;
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
    await stopWatching();
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
async function routeModelProvider(stack, modelDirectory, runtimeImage) {
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
  await run("docker", [
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
    "--entrypoint",
    "node",
    runtimeImage,
    "/fixture/endpoint.mjs",
  ]);
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

async function modelEvents() {
  const { stdout } = await run("docker", ["logs", modelContainer]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

async function assertModelAnswered(nonce, label) {
  const events = await modelEvents();
  const answered = events.filter(({ event, text }) => event === "turn-answered" && text === nonce);
  assert.ok(
    answered.length > 0,
    `${label}: the stand-in provider never answered ${nonce}; the reply did not come from a model turn`,
  );
  return answered[0].transport;
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
  // The active revision clears only after Compute reports shutdown; at that
  // point no Agent workload may still be serving.
  await waitFor(
    `${agent.label} to stop`,
    async () => {
      const current = await stack.api("GET", `/namespaces/${stack.namespaceId}/agents/${agent.id}`);
      assert.equal(current.desiredRuntimeState, "stopped");
      return { done: !current.activeRevisionId, state: current.activeRevisionId };
    },
    5 * minute,
  );
  await waitFor(
    `${agent.label} Pods to terminate after a reported stop`,
    async () => {
      const pods = await agentPods(stack, agent.id, { includeTerminating: true });
      return { done: pods.length === 0, state: pods.map((pod) => pod.metadata.name) };
    },
    2 * minute,
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

async function runFirstAgent(stack) {
  const { stdout } = await run(
    process.execPath,
    [join(root, "scripts/first-agent.mjs"), "smoke-embedded"],
    {
      env: {
        ...process.env,
        OCC_DEVELOPMENT_STATE_DIRECTORY: stack.directory,
        OCC_SERVICE_KEY_FILE: stack.keyPath,
        OCC_URL: stack.origin,
        OPENAI_API_KEY: `sk-oce-smoke-${randomUUID()}`,
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
async function createCodexAgent(stack) {
  const base = `/namespaces/${stack.namespaceId}`;
  const secret = await stack.api("POST", `${base}/secrets`, {
    name: `smoke-codex-${randomUUID()}`,
    value: `sk-oce-smoke-${randomUUID()}`,
  });
  const configuration = await stack.api("POST", `${base}/configurations`, {
    kind: "agent",
    values: createHarnessConfiguration("codex", defaultAgentModel),
  });
  const created = await stack.api("POST", `${base}/agents`, {
    name: "smoke-codex",
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  const role = await stack.api("POST", `${base}/iam/roles`, {
    name: "Smoke Agent Secret operate",
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
  const agent = { label: "codex", id: created.id };
  stack.agents.push(agent);
  const revisionId = await deployAgent(stack, agent);
  return { agent, revisionId };
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
  let stack;
  try {
    stack = await step("Local Setup (occ dev up)", () => startLocalSetup(environment));
    stack.agents = [];
    const namespaces = await stack.api("GET", "/namespaces");
    stack.namespaceId = namespaces.find(({ name }) => name === "default")?.id;
    assert.ok(stack.namespaceId, "Local Setup created no default Namespace");
    await step("route api.openai.com to the stand-in provider", () =>
      routeModelProvider(stack, modelDirectory, process.env.OCC_KUBERNETES_RUNTIME_IMAGE),
    );
    // The two Agents are independent; deploy them together to bound CI time.
    const [embedded, codex] = await Promise.all([
      step("embedded OpenClaw Agent via scripts/first-agent.mjs", () => runFirstAgent(stack)),
      step("dedicated Codex Agent via the API", () => createCodexAgent(stack)),
    ]);
    await step("dedicated Codex chat turn", () => chatTurn(stack, codex.agent, codex.revisionId));
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
    assert.notEqual(codexRevision, codex.revisionId, "start must admit a new revision");
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
