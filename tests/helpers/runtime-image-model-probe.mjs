// Shared by the runtime image model probe tests, which CI runs in two lanes:
// the CPU contention case (Image Model Probes) and the other outcomes (Image
// Runtime Startup 2). File names are left out so CI Impact can still select a
// test-only change to either file by its lane.
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { imageSmokeTimeoutMultiplier } from "./image-smoke-timeout.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { createModelProbeCertificates } from "./runtime-model-probe-certificates.mjs";
import { modelProbeDiagnostic } from "./runtime-model-probe-observation.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

// The embedded Gateway's startup model probe on the real runtime image, under
// the production example's Gateway memory limit and a 500m CPU limit, an eighth
// of the example's four cores (deploy/examples/production/installation.yaml),
// which operators may still choose. Only the model provider is
// substituted: a sidecar in the runtime image owns the network namespace,
// answers the Responses API as api.openai.com (mapped to loopback, trusted
// through a private CA), and observes the wrapper from outside. Like the
// kubelet, the sidecar also polls the real HTTP readiness endpoint.

export const execute = promisify(execFile);
export const docker = process.env.OCC_DOCKER_BIN ?? "docker";
export const image = process.env.OCC_TEST_RUNTIME_IMAGE;
export const imageTestOptions =
  image === undefined
    ? { skip: "Set OCC_TEST_RUNTIME_IMAGE to a locally built OpenClaw runtime image tag." }
    : {};

export const constrainedGatewayCpuLimit = "0.5";
export const productionGatewayMemoryLimit = "2g";
export const probeApiKey = "sk-openclaw-runtime-probe-synthetic";

export async function runDocker(args, options = {}) {
  return execute(docker, args, {
    timeout: 60_000 * imageSmokeTimeoutMultiplier,
    maxBuffer: 4_000_000,
    ...options,
  });
}

export function jsonLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry !== null && typeof entry === "object");
}

async function waitForLog(containerName, pattern) {
  const deadline = Date.now() + 20_000 * imageSmokeTimeoutMultiplier;
  while (Date.now() < deadline) {
    const { stdout } = await runDocker(["logs", containerName]);
    if (pattern.test(stdout)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${containerName} logs.`);
}

async function createProbeMaterial(t, configuration) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-model-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = (name) => join(directory, name);
  // Sign a leaf with a private CA, as a provider certificate would be.
  await createModelProbeCertificates({
    directory,
    caName: "oce-runtime-model-probe-ca",
    run: execute,
  });
  await rm(file("ca-key.pem"));
  // Only the provider host resolves, to the sidecar; every other name fails at once.
  await writeFile(file("hosts"), "127.0.0.1 localhost\n127.0.0.1 api.openai.com\n");
  await writeFile(file("resolv.conf"), "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n");
  await writeFile(
    file("endpoint.mjs"),
    await readFile(new URL("../fixtures/runtime-model-probe-endpoint.mjs", import.meta.url)),
  );
  await writeFile(file("openclaw.json"), JSON.stringify(configuration));
  await chmod(directory, 0o755);
  for (const name of [
    "ca.pem",
    "cert.pem",
    "key.pem",
    "hosts",
    "resolv.conf",
    "endpoint.mjs",
    "openclaw.json",
  ]) {
    await chmod(file(name), 0o644);
  }
  return directory;
}

// The embedded Gateway environment the Kubernetes Compute Driver renders for an
// OpenClaw Harness, with the controller's probe configuration: the selected
// model and its provider transport. Only allowPrivateNetwork is added, because
// the stand-in provider listens on loopback.
function embeddedGateway() {
  const configuration = admitLoggingConfiguration(
    createHarnessConfiguration("openclaw", defaultAgentModel),
    "info",
  );
  const model = configuration.agents.defaults.model;
  const provider = model.split("/", 1)[0];
  const probeConfiguration = {
    agents: {
      defaults: {
        model,
        models: {
          [model]: {
            ...configuration.agents.defaults.models?.[model],
            agentRuntime: { id: "openclaw" },
          },
        },
      },
    },
    models: {
      providers: {
        [provider]: {
          ...configuration.models.providers[provider],
          request: { allowPrivateNetwork: true },
        },
      },
    },
  };
  return {
    configuration,
    environment: [
      "HOME=/home/node",
      "OPENCLAW_CONFIG_PATH=/etc/openclaw/openclaw.json",
      "OPENCLAW_GATEWAY_PORT=8080",
      "OPENCLAW_GATEWAY_PASSWORD=openclaw-runtime-probe-password",
      "OPENCLAW_STATE_DIR=/home/node/.openclaw",
      `OPENCLAW_HARNESS_MODEL=${model}`,
      `OPENCLAW_HARNESS_PROVIDER=${provider}`,
      "OPENCLAW_HARNESS_CREDENTIAL_ENV=OPENAI_API_KEY",
      `OPENCLAW_HARNESS_PROBE_CONFIG=${JSON.stringify(probeConfiguration)}`,
      `OPENAI_API_KEY=${probeApiKey}`,
      "NODE_EXTRA_CA_CERTS=/fixture/ca.pem",
      "OPENCLAW_PLUGIN_STATUS_PORT=18791",
      "OPENCLAW_PLUGIN_STATUS_CONTAINER=gateway",
      "OPENCLAW_RUNTIME_STATUS_PORT=18791",
      "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
      "OPENCLAW_AGENT_REVISION_ID=revision-model-probe",
      "OPENCLAW_POD_UID=pod-model-probe",
    ],
  };
}

// Docker reports RFC 3339; Podman reports "YYYY-MM-DD hh:mm:ss.nnnnnnnnn +0000 UTC".
function containerTime(value) {
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(trimmed);
  assert.ok(match, `unrecognized container time ${trimmed}`);
  assert.match(trimmed, /Z$|\+0000 UTC$/, "container time must be UTC");
  return Date.parse(`${match[1]}T${match[2]}.${(match[3] ?? "0").padEnd(3, "0").slice(0, 3)}Z`);
}

// Starts one embedded Gateway against the stand-in provider. `mode` is the
// provider's behaviour: "answer" after `delayMs`, "reject" with HTTP 401, or
// "hang". Resolves once `until` accepts an observation snapshot.
export async function runEmbeddedGatewayProbe(
  t,
  { mode, delayMs = 0, cpus, memory, until, limitMs, stress, afterStop },
) {
  const scenarioStartedAt = Date.now();
  const gateway = embeddedGateway();
  const material = await createProbeMaterial(t, gateway.configuration);
  const suffix = randomBytes(6).toString("hex");
  const sidecar = `oce-runtime-model-probe-endpoint-${suffix}`;
  const containerName = `oce-runtime-model-probe-gateway-${suffix}`;
  t.after(async () => {
    await runDocker(["rm", "-f", containerName]).catch(() => {});
    await runDocker(["rm", "-f", sidecar]).catch(() => {});
    await afterStop?.();
  });
  await runDocker([
    "run",
    "--name",
    sidecar,
    "--detach",
    "--network",
    "none",
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
    "--volume",
    `${material}:/fixture:ro`,
    "-e",
    `PROBE_ENDPOINT_MODE=${mode}`,
    "-e",
    `PROBE_ENDPOINT_DELAY_MS=${delayMs}`,
    "-e",
    "PROBE_OBSERVE_NATIVE_PORT=8080",
    "-e",
    "PROBE_OBSERVE_STATUS_PORT=18791",
    "--entrypoint",
    "node",
    image,
    "/fixture/endpoint.mjs",
  ]);
  await waitForLog(sidecar, /"event":"listening"/);
  // The Gateway container of an embedded Pod: the driver's /home/node (1 GiB)
  // and /tmp (64 MiB) volumes, a read-only root, and the production limits.
  await runDocker([
    "run",
    "--name",
    containerName,
    "--detach",
    "--network",
    `container:${sidecar}`,
    "--cpus",
    cpus,
    "--memory",
    memory,
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/home/node:size=1024m,uid=1000,gid=1000,mode=700",
    "--tmpfs",
    "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
    "--volume",
    `${material}:/fixture:ro`,
    "--volume",
    `${join(material, "hosts")}:/etc/hosts:ro`,
    "--volume",
    `${join(material, "resolv.conf")}:/etc/resolv.conf:ro`,
    "--volume",
    `${join(material, "openclaw.json")}:/etc/openclaw/openclaw.json:ro`,
    ...gateway.environment.flatMap((value) => ["-e", value]),
    "--entrypoint",
    "node",
    image,
    "-e",
    // As the driver renders it: compressed pieces below the exec argument limit.
    ...nodeProgramArguments(GATEWAY_RUNTIME_ENTRYPOINT),
  ]);
  const startedAt = containerTime(
    (await runDocker(["inspect", containerName, "--format", "{{.State.StartedAt}}"])).stdout,
  );
  const collect = async () => {
    const [endpoint, wrapper, state] = await Promise.all([
      runDocker(["logs", sidecar]),
      runDocker(["logs", containerName]),
      runDocker(["inspect", containerName, "--format", "{{.State.Running}} {{.State.ExitCode}}"]),
    ]);
    const [running, exitCode] = state.stdout.trim().split(/\s+/);
    const output = `${wrapper.stdout}\n${wrapper.stderr}`;
    return {
      events: jsonLines(endpoint.stdout).map((event) => ({ ...event, ms: event.at - startedAt })),
      output,
      phases: jsonLines(output).filter(({ event }) => event === "runtime.startup_phase"),
      probe: jsonLines(output).find(({ event }) => event === "openclaw.model_probe"),
      probeStage: jsonLines(output)
        .filter(({ event }) => event === "openclaw.model_probe_stage")
        .at(-1)?.stage,
      running: running === "true",
      exitCode: Number(exitCode),
    };
  };
  const deadline = Date.now() + limitMs * imageSmokeTimeoutMultiplier;
  for (;;) {
    const snapshot = await collect();
    if (until(snapshot, containerName)) {
      return { containerName, snapshot, setupMs: startedAt - scenarioStartedAt };
    }
    if (!snapshot.running) {
      const error = new assert.AssertionError({
        message: "The Gateway wrapper exited before settlement.",
      });
      error.openclawCiDiagnostic = modelProbeDiagnostic(snapshot, stress, "wrapper-exited");
      throw error;
    }
    if (Date.now() > deadline) {
      const error = new assert.AssertionError({
        message: "The embedded Gateway exceeded its settlement guard.",
      });
      error.openclawCiDiagnostic = modelProbeDiagnostic(snapshot, stress, "outer-timeout");
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export const observed = (key, value) => (event) =>
  event.event === "observe" && event.key === key && event.value === value;
export const runtimeFailure = (events) =>
  events.find(
    (event) => event.event === "observe" && event.key === "runtimeFailure" && event.value !== null,
  )?.value;
export const phaseAt = (phases, phase) => phases.find((entry) => entry.phase === phase);
