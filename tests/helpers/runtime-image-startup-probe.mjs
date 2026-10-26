// The startup model probe scenario shared by runtime-image-startup-probe.test.mjs,
// runtime-image-startup-termination.test.mjs and
// runtime-image-gateway-unclean-restart.test.mjs, which CI runs side by side in
// Image Runtime Startup 2: one runtime wrapper started with the container command
// the Compute driver renders, beside a stand-in model provider sidecar.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, freemem, loadavg } from "node:os";
import { join } from "node:path";
import { imageSmokeTimeoutMultiplier } from "./image-smoke-timeout.mjs";
import { changeSignal, followContainer } from "./docker-follow.mjs";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { createModelProbeCertificates } from "./runtime-model-probe-certificates.mjs";
import { modelProbeDiagnostic } from "./runtime-model-probe-observation.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";
import {
  execute,
  image,
  runtimeImageModel,
  docker,
  runDocker,
  waitForDockerLog,
  createAdmittedRuntimeImageConfiguration,
  jsonLogEntries,
  failureTail,
} from "./runtime-image-startup.mjs";

// Startup model probes on Kubernetes. These tests run the real Codex Harness
// and embedded Gateway wrappers, the image's own Codex and OpenClaw probes and
// processes, and the real HTTP readiness endpoints. Only the model provider is
// substituted: a sidecar in the runtime image owns the network namespace,
// answers the Responses API as api.openai.com (mapped to loopback, trusted
// through a private CA), and observes the wrapper from outside.
// The production example lets both roles burst to four cores; these cases run
// tighter, the Codex wrapper at 500m and the embedded Gateway at one core (its
// probe cap counts at most one core); the runtime image model probe tests cover
// the Gateway at 500m.
const startupProbeCpuLimit = "0.5";
const gatewayStartupProbeCpuLimit = "1";
const startupProbeMemoryLimit = "2g";
const startupProbeModel = runtimeImageModel;
export const startupProbeApiKey = "sk-openclaw-runtime-probe-synthetic";

async function createStartupProbeMaterial(t) {
  const directory = await temporaryDirectory(t, "oce-runtime-startup-probe-");
  const file = (name) => join(directory, name);
  // Codex rejects a self-signed end-entity certificate, so sign a leaf.
  await createModelProbeCertificates({
    directory,
    caName: "oce-runtime-startup-probe-ca",
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
  await chmod(directory, 0o755);
  for (const name of ["ca.pem", "cert.pem", "key.pem", "hosts", "resolv.conf", "endpoint.mjs"]) {
    await chmod(file(name), 0o644);
  }
  return directory;
}

// Docker reports RFC 3339; Podman reports "YYYY-MM-DD hh:mm:ss.nnnnnnnnn +0000 UTC".
function containerStartedAt(value) {
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(trimmed);
  assert.ok(match, `unrecognized container start time ${trimmed}`);
  assert.match(trimmed, /Z$|\+0000 UTC$/, "container start time must be UTC");
  return Date.parse(`${match[1]}T${match[2]}.${(match[3] ?? "0").padEnd(3, "0").slice(0, 3)}Z`);
}

// The wrapper environment the Kubernetes driver renders, including the private
// runtime and plugin status ports.
function startupProbeWrapper(kind) {
  const container = kind === "codex" ? "agent" : "gateway";
  const status = [
    "OPENCLAW_PLUGIN_STATUS_PORT=18791",
    `OPENCLAW_PLUGIN_STATUS_CONTAINER=${container}`,
    "OPENCLAW_RUNTIME_STATUS_PORT=18791",
    `OPENCLAW_RUNTIME_STATUS_CONTAINER=${container}`,
    "OPENCLAW_AGENT_REVISION_ID=revision-startup-probe",
    "OPENCLAW_POD_UID=pod-startup-probe",
  ];
  if (kind === "codex") {
    return {
      entrypoint: AGENT_RUNTIME_ENTRYPOINT,
      cpus: startupProbeCpuLimit,
      nativePort: 4500,
      environment: [
        "HOME=/home/node",
        "CODEX_HOME=/home/node/.codex",
        "CODEX_LOGIN_MODE=api_key",
        `OPENAI_API_KEY=${startupProbeApiKey}`,
        `OPENCLAW_HARNESS_MODEL=codex/${startupProbeModel}`,
        "APP_SERVER_TOKEN=openclaw-runtime-probe-app-server-token",
        "APP_SERVER_PORT=4500",
        "SSL_CERT_FILE=/fixture/ca.pem",
        ...status,
      ],
    };
  }
  if (kind === "dedicated-gateway") {
    // A Codex peer with an enabled plugin: the Gateway waits for the Harness's
    // plugin status before it starts OpenClaw. The peer never answers here.
    const configuration = createAdmittedRuntimeImageConfiguration("codex");
    const manifest = {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
        },
      },
    };
    return {
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      cpus: startupProbeCpuLimit,
      nativePort: 8080,
      configuration,
      environment: [
        "HOME=/home/node",
        "OPENCLAW_CONFIG_PATH=/etc/openclaw/openclaw.json",
        "OPENCLAW_GATEWAY_PORT=8080",
        "OPENCLAW_GATEWAY_PASSWORD=openclaw-runtime-probe-password",
        "OPENCLAW_STATE_DIR=/home/node/.openclaw",
        "APP_SERVER_URL=ws://127.0.0.1:4500",
        `OPENCLAW_PLUGIN_RUNTIME_JSON=${JSON.stringify({ manifest })}`,
        ...status,
      ],
    };
  }
  const configuration = createAdmittedRuntimeImageConfiguration("openclaw");
  const model = configuration.agents.defaults.model;
  const provider = model.split("/", 1)[0];
  const providerTransport = configuration.models.providers[provider];
  // The controller's probe configuration: the selected model and its provider
  // transport. Only allowPrivateNetwork is added, because the stand-in
  // provider listens on loopback. The native Gateway's own turns need it too.
  configuration.models.providers[provider] = {
    ...providerTransport,
    request: { ...providerTransport.request, allowPrivateNetwork: true },
  };
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
          ...providerTransport,
          request: { allowPrivateNetwork: true },
        },
      },
    },
  };
  return {
    entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
    cpus: gatewayStartupProbeCpuLimit,
    nativePort: 8080,
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
      `OPENAI_API_KEY=${startupProbeApiKey}`,
      "NODE_EXTRA_CA_CERTS=/fixture/ca.pem",
      ...status,
    ],
  };
}

const probeEvents = new Set(["openclaw.model_probe", "codex.model_probe"]);
const providerEvents = new Set([
  "connection",
  "secure",
  "tls-error",
  "request",
  "prewarm",
  "turn-answered",
  "turn-closed",
]);

// The container's CPU accounting at failure (cgroup v2): usage, throttling and
// pressure show whether the wrapper got the CPU its probe cap assumes.
async function containerCpu(containerName) {
  try {
    // Kernels without pressure accounting have no cpu.pressure; read what exists.
    const { stdout } = await runDocker(
      [
        "exec",
        containerName,
        "sh",
        "-c",
        "cd /sys/fs/cgroup && for f in cpu.max cpu.stat cpu.pressure; do [ -r $f ] && printf '%s: ' $f && cat $f; done; true",
      ],
      { timeout: 10_000 * imageSmokeTimeoutMultiplier },
    );
    const text = stdout.trim();
    return text === ""
      ? "unavailable"
      : text
          .split(/\s*\n\s*/)
          .join("; ")
          .slice(0, 600);
  } catch {
    return "unavailable";
  }
}

// Where an unsettled scenario's time went. It leads the failure message, so the
// job log's first 600 characters name the probe's outcome; the lane's
// diagnostics report keeps the whole message. Wrapper times (probe, stages,
// phases) count from wrapper start; provider times from container start.
async function startupProbeEvidence(scenario, snapshot, loop) {
  const entries = jsonLogEntries(snapshot.output);
  const failures = snapshot.events.filter(
    (event) => event.event === "observe" && event.key === "runtimeFailure",
  );
  return {
    probe: entries
      .filter(({ event }) => probeEvents.has(event))
      .map(
        ({
          event,
          attempt,
          code,
          elapsedMs,
          capMs,
          cpuWaitMs,
          pressureWaitMs,
          throttledWaitMs,
          cause,
        }) => ({
          event,
          attempt,
          code,
          elapsedMs,
          capMs,
          cpuWaitMs,
          pressureWaitMs,
          throttledWaitMs,
          cause,
        }),
      ),
    stages: Object.fromEntries(
      entries
        .filter(({ event }) => event === "openclaw.model_probe_stage")
        .map(({ stage, elapsedMs }) => [stage, elapsedMs]),
    ),
    provider: snapshot.events
      .filter(({ event }) => providerEvents.has(event))
      .map(({ event, ms, turn, transport, path, code }) =>
        [`${event}@${ms}`, turn ? "turn" : undefined, transport, path, code]
          .filter((value) => typeof value === "string")
          .join(" "),
      ),
    runtimeFailure: failures.at(-1) && { value: failures.at(-1).value, ms: failures.at(-1).ms },
    phases: snapshot.phases.map(({ phase, outcome, sinceStartMs }) =>
      [phase, outcome, sinceStartMs].filter((value) => value !== undefined).join(" "),
    ),
    // Checks of the followed output (no docker CLI per check).
    checks: {
      count: loop.polls,
      slowestMs: loop.slowestMs,
      elapsedMs: Date.now() - loop.startedAt,
    },
    host: {
      load: loadavg().map((value) => Math.round(value * 100) / 100),
      cpus: availableParallelism(),
      freeMemMb: Math.round(freemem() / 1_048_576),
    },
    cpu: snapshot.running ? await containerCpu(scenario.containerName) : "exited",
  };
}

// The scenario's failure: evidence first, then the raw wrapper output and
// provider events. The structured diagnostic survives the job log's cut too.
function startupProbeFailure(headline, reason, evidence, snapshot) {
  const error = new assert.AssertionError({
    message:
      `${headline}\nevidence: ${JSON.stringify(evidence)}\n${failureTail(snapshot.output)}\n` +
      JSON.stringify(snapshot.events),
  });
  // Locate the failure at the caller's throw, not inside this helper.
  Error.captureStackTrace(error, startupProbeFailure);
  error.openclawCiDiagnostic = modelProbeDiagnostic(snapshot, undefined, reason);
  return error;
}

// Runs one wrapper start against the stand-in provider. `mode` is the
// provider's behaviour: "answer" after `delayMs`, "reject" with HTTP 401, or
// "hang". `until` returns true once the scenario has what it needs to check;
// `act`, if given, then runs against the live containers. `homeVolume`, if
// given, replaces the wrapper's /home/node tmpfs, as a Gateway's
// PersistentVolume does, so a later scenario can start on the same state.
export async function runStartupProbeScenario(
  t,
  { kind, mode, delayMs = 0, until, act, homeVolume },
) {
  const scenarioStartedAt = Date.now();
  const wrapper = startupProbeWrapper(kind);
  const material = await createStartupProbeMaterial(t);
  if (wrapper.configuration !== undefined) {
    await writeFile(join(material, "openclaw.json"), JSON.stringify(wrapper.configuration));
    await chmod(join(material, "openclaw.json"), 0o644);
  }
  const suffix = randomBytes(6).toString("hex");
  const sidecar = `oce-runtime-probe-endpoint-${suffix}`;
  const containerName = `oce-runtime-probe-${kind}-${suffix}`;
  t.after(async () => {
    await runDocker(["rm", "-f", containerName]).catch(() => {});
    await runDocker(["rm", "-f", sidecar]).catch(() => {});
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
    `PROBE_OBSERVE_NATIVE_PORT=${wrapper.nativePort}`,
    "-e",
    "PROBE_OBSERVE_STATUS_PORT=18791",
    "--entrypoint",
    "node",
    image,
    "/fixture/endpoint.mjs",
  ]);
  await waitForDockerLog(sidecar, /"event":"listening"/);
  // The container command the Compute driver renders, with the wrapper program
  // in the same bounded pieces: PID 1 is whatever that command starts.
  const [command, ...commandArguments] = RUNTIME_WRAPPER_COMMAND;
  await runDocker([
    "run",
    "--name",
    containerName,
    "--detach",
    "--network",
    `container:${sidecar}`,
    "--cpus",
    wrapper.cpus,
    "--memory",
    startupProbeMemoryLimit,
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...(homeVolume === undefined
      ? ["--tmpfs", "/home/node:size=1024m,uid=1000,gid=1000,mode=700"]
      : ["--volume", `${homeVolume}:/home/node`]),
    "--tmpfs",
    "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
    "--volume",
    `${material}:/fixture:ro`,
    "--volume",
    `${join(material, "hosts")}:/etc/hosts:ro`,
    "--volume",
    `${join(material, "resolv.conf")}:/etc/resolv.conf:ro`,
    ...(wrapper.configuration === undefined
      ? []
      : ["--volume", `${join(material, "openclaw.json")}:/etc/openclaw/openclaw.json:ro`]),
    ...wrapper.environment.flatMap((value) => ["-e", value]),
    "--entrypoint",
    command,
    image,
    ...commandArguments,
    ...nodeProgramArguments(wrapper.entrypoint),
  ]);
  const startedAt = containerStartedAt(
    (await runDocker(["inspect", containerName, "--format", "{{.State.StartedAt}}"])).stdout,
  );
  // Both containers' logs and the wrapper's exit stream in; each check reads
  // what arrived, and the loop sleeps until the next write.
  const changes = changeSignal();
  const endpointLogs = followContainer(t, sidecar, { docker, exit: false, changes });
  const wrapperLogs = followContainer(t, containerName, {
    docker,
    changes,
    inspectTimeoutMs: 20_000 * imageSmokeTimeoutMultiplier,
  });
  const collect = async () => {
    const endpoint = endpointLogs.read();
    const native = wrapperLogs.read();
    const events = jsonLogEntries(endpoint.stdout).map((event) => ({
      ...event,
      ms: event.at - startedAt,
    }));
    const output = `${native.stdout}\n${native.stderr}`;
    const entries = jsonLogEntries(output);
    return {
      events,
      output,
      phases: entries.filter(({ event }) => event === "runtime.startup_phase"),
      // Only the embedded Gateway's OpenClaw probe writes these.
      probe: entries.find(({ event }) => event === "openclaw.model_probe"),
      probeStage: entries.filter(({ event }) => event === "openclaw.model_probe_stage").at(-1)
        ?.stage,
      running: native.running,
      exitCode: native.exitCode,
    };
  };
  // Resolves with when the wrapper exited (epoch ms: when `docker wait` returned,
  // or Docker's FinishedAt when an inspect found the exit),
  // once its output is complete, or with undefined at `deadline`. At the
  // deadline Docker is asked once more, so a slow `docker wait` cannot turn an
  // exit into a timeout; that exit counts from Docker's FinishedAt.
  const exited = async (deadline) => {
    let inspected = false;
    for (;;) {
      const seen = changes.version;
      const { exitedAt, running } = wrapperLogs.read();
      if (exitedAt !== undefined && !running) {
        return exitedAt;
      }
      if (exitedAt === undefined && Date.now() >= deadline) {
        if (!inspected) {
          inspected = true;
          await wrapperLogs.inspect();
          continue;
        }
        return undefined;
      }
      // After the exit, the follower ends `running` within 10 s.
      await changes.wait(seen, exitedAt === undefined ? deadline - Date.now() : 1_000);
    }
  };
  const deadline = Date.now() + 300_000 * imageSmokeTimeoutMultiplier;
  const scenario = {
    containerName,
    startedAt,
    setupMs: startedAt - scenarioStartedAt,
    wrapper,
    collect,
    exited,
    first: (events, predicate) => events.find(predicate),
  };
  const loop = { polls: 0, slowestMs: 0, startedAt: Date.now() };
  for (;;) {
    const pollStartedAt = Date.now();
    const seen = changes.version;
    const snapshot = await collect();
    loop.polls += 1;
    loop.slowestMs = Math.max(loop.slowestMs, Date.now() - pollStartedAt);
    if (await until(snapshot, scenario)) {
      if (act !== undefined) {
        await act(scenario, snapshot);
      }
      return { ...scenario, snapshot: await collect() };
    }
    if (!snapshot.running) {
      const evidence = await startupProbeEvidence(scenario, snapshot, loop);
      throw startupProbeFailure(
        `The ${kind} wrapper exited early (${snapshot.exitCode}).`,
        "wrapper-exited",
        evidence,
        snapshot,
      );
    }
    if (Date.now() > deadline) {
      const evidence = await startupProbeEvidence(scenario, snapshot, loop);
      throw startupProbeFailure(
        `The ${kind} startup probe scenario did not settle.`,
        "outer-timeout",
        evidence,
        snapshot,
      );
    }
    // Check again on the next write or exit (at least 5 s apart without one,
    // at most every 250 ms with them).
    await changes.wait(seen, Math.min(5_000, deadline + 1 - Date.now()));
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, pollStartedAt + 250 - Date.now())),
    );
  }
}

export const observedValue = (key, value) => (event) =>
  event.event === "observe" && event.key === key && event.value === value;
export const isModelTurn = (event) => event.event === "request" && event.turn === true;
export const isTurnAnswer = (event) => event.event === "turn-answered";
export const isRuntimeFailure = (event) =>
  event.event === "observe" && event.key === "runtimeFailure" && event.value !== null;
export const heldFailure =
  (code) =>
  ({ events }) =>
    events.some(observedValue("runtimeFailure", code));

export function phaseAt(phases, phase) {
  return phases.find((entry) => entry.phase === phase);
}

// Attach the run's observations and wrapper output to a failed assertion.
export async function withStartupProbeEvidence(run, check) {
  try {
    await check();
  } catch (error) {
    // Keep the original error, and so its location, which is all CI records.
    // Node's assertion message may already hold much of the output; size the
    // tail so the end of the output still lands inside CI's 16 KiB cut.
    const events = `\nendpoint events:\n${run.snapshot.events.map((event) => JSON.stringify(event)).join("\n")}`;
    const evidence = `${events}\nwrapper output:\n${failureTail(
      run.snapshot.output,
      Math.max(2048, 15 * 1024 - error.message.length - events.length),
    )}`;
    error.message += evidence;
    if (typeof error.stack === "string") {
      error.stack += evidence;
    }
    throw error;
  }
}
