// Runtime image startup smoke tests split from runtime-image-startup.test.mjs so
// CI can run the files in parallel lanes: startup model probes, SIGTERM during
// startup, and ephemeral native worker reconnect from an expired replayed setup
// code. Workspace node enrollment and the inactive Slack approver startup check
// are in runtime-image-native-worker.test.mjs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { createModelProbeCertificates } from "../helpers/runtime-model-probe-certificates.mjs";
import {
  modelProbeDiagnostic,
  recordModelProbeMeasurement,
} from "../helpers/runtime-model-probe-observation.mjs";
import {
  execute,
  image,
  runtimeImageModel,
  imageTestOptions,
  runDocker,
  waitForDockerLog,
  createAdmittedRuntimeImageConfiguration,
  jsonLogEntries,
  failureTail,
  runGatewaySmoke,
  temporaryGatewayConfiguration,
} from "../helpers/runtime-image-startup.mjs";

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
const startupProbeApiKey = "sk-openclaw-runtime-probe-synthetic";

async function createStartupProbeMaterial(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-startup-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
  // The controller's probe configuration: the selected model and its provider
  // transport. Only allowPrivateNetwork is added, because the stand-in
  // provider listens on loopback.
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
      .map(({ event, attempt, code, elapsedMs, capMs, cpuWaitMs, cause }) => ({
        event,
        attempt,
        code,
        elapsedMs,
        capMs,
        cpuWaitMs,
        cause,
      })),
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
    poll: {
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
// `act`, if given, then runs against the live containers.
async function runStartupProbeScenario(t, { kind, mode, delayMs = 0, until, act }) {
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
  const collect = async () => {
    const [endpoint, native, state] = await Promise.all([
      runDocker(["logs", sidecar]),
      runDocker(["logs", containerName]),
      runDocker([
        "inspect",
        containerName,
        "--format",
        "{{.State.Running}} {{.State.ExitCode}} {{.State.FinishedAt}}",
      ]),
    ]);
    const [running, exitCode, ...finished] = state.stdout.trim().split(/\s+/);
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
      running: running === "true",
      exitCode: Number(exitCode),
      finishedAt: running === "true" ? undefined : containerStartedAt(finished.join(" ")),
    };
  };
  const deadline = Date.now() + 300_000 * imageSmokeTimeoutMultiplier;
  const scenario = {
    containerName,
    startedAt,
    setupMs: startedAt - scenarioStartedAt,
    wrapper,
    collect,
    first: (events, predicate) => events.find(predicate),
  };
  const loop = { polls: 0, slowestMs: 0, startedAt: Date.now() };
  for (;;) {
    const pollStartedAt = Date.now();
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const observedValue = (key, value) => (event) =>
  event.event === "observe" && event.key === key && event.value === value;
const isModelTurn = (event) => event.event === "request" && event.turn === true;
const isTurnAnswer = (event) => event.event === "turn-answered";
const isRuntimeFailure = (event) =>
  event.event === "observe" && event.key === "runtimeFailure" && event.value !== null;
// The endpoint reads status and runs readiness in parallel, so readiness can
// pass before the same poll's status read shows it: wait until both have.
const readyOrFailed = ({ events }) =>
  events.some(isRuntimeFailure) ||
  (events.some(observedValue("ready", true)) && events.some(observedValue("plugin", "ready")));
const heldFailure =
  (code) =>
  ({ events }) =>
    events.some(observedValue("runtimeFailure", code));

// CI keeps only a failed assertion's location, so each startup failure the
// stand-in provider should not cause fails on its own line.
function assertStartupReady(run) {
  const failure = run.snapshot.events.find(isRuntimeFailure)?.value;
  const detail = `${failureTail(run.snapshot.output)}\n${JSON.stringify(run.snapshot.events)}`;
  if (failure === "MODEL_PROBE_TIMEOUT") {
    assert.fail(`the model probe timed out\n${detail}`);
  }
  if (failure === "MODEL_PROBE_FAILED") {
    assert.fail(`the model probe failed\n${detail}`);
  }
  if (failure !== undefined) {
    assert.fail(`startup failed with ${failure}\n${detail}`);
  }
}

function phaseAt(phases, phase) {
  return phases.find((entry) => entry.phase === phase);
}

// Every observation of `key` made before `at` (epoch milliseconds).
function observationsBefore(events, key, at) {
  return events.filter((event) => event.event === "observe" && event.key === key && event.at < at);
}

function describeStartupProbeRun(label, run) {
  const { events, phases } = run.snapshot;
  const at = (predicate) => run.first(events, predicate)?.ms;
  return (
    `${label}: ` +
    JSON.stringify({
      modelProbeMs: phaseAt(phases, "model-probe")?.sinceStartMs,
      nativeSpawnMs: phaseAt(phases, "native-spawn")?.sinceStartMs,
      modelTurnMs: at(isModelTurn),
      turnAnsweredMs: at(isTurnAnswer),
      nativeListeningMs: at(observedValue("native", true)),
      runtimeFailureMs: at(isRuntimeFailure),
      readyMs: at(observedValue("ready", true)),
    })
  );
}

// Attach the run's observations and wrapper output to a failed assertion.
async function withStartupProbeEvidence(run, check) {
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

// The probe gates native startup: the provider answered the model turn before
// the native process listened or the HTTP readiness endpoint passed.
async function assertProbeGatesStartup(t, kind, delayMs) {
  const run = await runStartupProbeScenario(t, {
    kind,
    mode: "answer",
    delayMs,
    until: readyOrFailed,
  });
  if (kind === "gateway") {
    // The case name assumes gatewayStartupProbeCpuLimit stays at one core.
    recordModelProbeMeasurement(t, "gateway-1cpu-answer", run);
  }
  assertStartupReady(run);
  await withStartupProbeEvidence(run, async () => {
    const { events, phases } = run.snapshot;
    const answered = run.first(events, isTurnAnswer);
    assert.ok(answered, "the stand-in provider answered the probe");
    assert.equal(phaseAt(phases, "model-probe")?.outcome, "ok");
    assert.ok(
      phaseAt(phases, "model-probe").sinceStartMs <= phaseAt(phases, "native-spawn").sinceStartMs,
    );
    // Phase times count from wrapper start, endpoint times from container
    // start; compare each only within its own clock.
    assert.equal(
      observationsBefore(events, "native", answered.at).some(({ value }) => value === true),
      false,
      "the native process listened before the probe passed",
    );
    assert.equal(
      observationsBefore(events, "ready", answered.at).some(({ value }) => value === true),
      false,
      "readiness passed before the probe passed",
    );
    assert.equal(
      observationsBefore(events, "plugin", answered.at).some(({ value }) => value === "ready"),
      false,
      "plugin status was ready before the probe passed",
    );
    assert.ok(run.first(events, observedValue("ready", true)).at >= answered.at);
    assert.equal(events.some(isRuntimeFailure), false);
    t.diagnostic(
      describeStartupProbeRun(`${kind}, ${delayMs} ms model turn, --cpus ${run.wrapper.cpus}`, run),
    );
  });
}

// A rejected credential reports AUTHENTICATION_FAILED for #583's prompt
// deployment failure, starts no native process, the wrapper holds that
// evidence until it is terminated, and HTTP readiness stays unavailable.
async function assertRejectedCredentialFailsFast(t, kind) {
  const run = await runStartupProbeScenario(t, {
    kind,
    mode: "reject",
    until: heldFailure("AUTHENTICATION_FAILED"),
  });
  await withStartupProbeEvidence(run, async () => {
    const { events, phases, output } = run.snapshot;
    assert.equal(events.some(observedValue("ready", true)), false);
    assert.equal(events.some(observedValue("plugin", "ready")), false);
    assert.equal(events.some(observedValue("native", true)), false);
    assert.equal(phaseAt(phases, "model-probe")?.outcome, "failed");
    assert.equal(phaseAt(phases, "native-spawn"), undefined, "a failed probe starts nothing");
    assert.match(output, /Harness model authentication probe failed\./);
    assert.doesNotMatch(output, new RegExp(startupProbeApiKey));
    const failure = run.first(events, observedValue("runtimeFailure", "AUTHENTICATION_FAILED"));
    // Far inside the 900-second convergence deadline #583 cuts short.
    assert.ok(failure.ms < 120_000 * imageSmokeTimeoutMultiplier, `failure after ${failure.ms} ms`);
    assert.equal((await run.collect()).running, true, "the wrapper holds the failure evidence");
    t.diagnostic(describeStartupProbeRun(`${kind} rejected credential`, run));
  });
}

test(
  "runtime image Codex Harness stays unready until its model probe passes",
  { ...imageTestOptions, timeout: 600_000 },
  async (t) => {
    // A model turn slower than app-server startup, but far inside the probe's
    // 30-second attempt cap, so it does not retry.
    await assertProbeGatesStartup(t, "codex", 8_000);
  },
);

test(
  "runtime image Codex Harness fails fast when the provider rejects its credential",
  { ...imageTestOptions, timeout: 600_000 },
  async (t) => {
    await assertRejectedCredentialFailsFast(t, "codex");
  },
);

test(
  "runtime image embedded Gateway probes its model before it starts OpenClaw",
  { ...imageTestOptions, timeout: 600_000 },
  async (t) => {
    // A short turn keeps the probe well inside its attempt cap.
    await assertProbeGatesStartup(t, "gateway", 2_000);
  },
);

test(
  "runtime image embedded Gateway fails fast when the provider rejects its credential",
  { ...imageTestOptions, timeout: 600_000 },
  async (t) => {
    await assertRejectedCredentialFailsFast(t, "gateway");
  },
);

// Runtime wrapper termination. A Pod stop sends SIGTERM to the container's
// PID 1, waits terminationGracePeriodSeconds (the Gateway's is 330 seconds),
// then sends SIGKILL; an embedded Gateway redeploy uses Recreate, so the new
// Pod waits for the old one. These tests send SIGTERM to the real wrappers,
// started with the container command the Compute driver renders, in each
// startup phase.
// Well below the 30-second default grace a Harness Pod gets, and far below the
// Gateway's 330 seconds: a wrapper that ignores SIGTERM never meets it.
const promptTerminationMs = 15_000;

// Sends SIGTERM as the kubelet does and measures how long the container takes
// to stop. Container exit ends its PID namespace, so no child outlives it.
async function assertPromptTermination(t, { containerName, collect }, description) {
  const signalledAt = Date.now();
  await runDocker(["kill", "--signal", "TERM", containerName]);
  const deadline = signalledAt + promptTerminationMs * imageSmokeTimeoutMultiplier;
  let state = await collect();
  while (state.running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = await collect();
  }
  const elapsedMs = Date.now() - signalledAt;
  t.diagnostic(
    `${description}: ${state.running ? "still running" : `exit ${state.exitCode}`} ` +
      `${elapsedMs} ms after SIGTERM`,
  );
  if (state.running) {
    assert.fail(
      `${description}: SIGTERM did not stop the wrapper in ${elapsedMs} ms.\n${failureTail(state.output)}`,
    );
  }
  // A terminated wrapper exits cleanly in every phase, as it does once running.
  assert.equal(state.exitCode, 0, `${description}: exit code`);
}

// Starts one wrapper, waits for `until`, then sends SIGTERM.
async function runTerminationScenario(t, { kind, mode, until, description }) {
  return runStartupProbeScenario(t, {
    kind,
    mode,
    until,
    act: (scenario) => assertPromptTermination(t, scenario, description),
  });
}

async function assertWrapperTermination(t, kind) {
  const label = kind === "codex" ? "Codex Harness" : "embedded Gateway";

  // SIGTERM while the provider holds the probe's model turn: the wrapper is
  // blocked in its synchronous probe child.
  const probing = await runTerminationScenario(t, {
    kind,
    mode: "hang",
    until: ({ events }) => events.some(isModelTurn),
    description: `${label} during its model probe`,
  });
  await withStartupProbeEvidence(probing, async () => {
    const { events, phases } = probing.snapshot;
    assert.equal(phaseAt(phases, "model-probe"), undefined, "a terminated probe has no outcome");
    assert.equal(events.filter(isModelTurn).length, 1, "termination starts no further attempt");
    assert.equal(events.some(observedValue("ready", true)), false);
  });

  // SIGTERM while the wrapper holds a rejected credential for the controller.
  const holding = await runTerminationScenario(t, {
    kind,
    mode: "reject",
    until: heldFailure("AUTHENTICATION_FAILED"),
    description: `${label} holding AUTHENTICATION_FAILED`,
  });
  await withStartupProbeEvidence(holding, async () => {
    assert.equal(holding.snapshot.events.some(observedValue("ready", true)), false);
  });

  // SIGTERM once the native process serves: the wrapper forwards it and exits
  // with the native process.
  await runTerminationScenario(t, {
    kind,
    mode: "answer",
    until: ({ events }) => events.some(observedValue("ready", true)),
    description: `${label} while ready`,
  });
}

test(
  "runtime image Codex Harness exits promptly on SIGTERM in every startup phase",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    await assertWrapperTermination(t, "codex");
  },
);

test(
  "runtime image embedded Gateway exits promptly on SIGTERM in every startup phase",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    await assertWrapperTermination(t, "gateway");
  },
);

test(
  "runtime image dedicated Gateway exits promptly on SIGTERM while it waits for its Harness",
  { ...imageTestOptions, timeout: 600_000 },
  async (t) => {
    const waiting = await runTerminationScenario(t, {
      kind: "dedicated-gateway",
      mode: "answer",
      until: ({ output }) => /Waiting for Harness plugin runtime status/.test(output),
      description: "dedicated Gateway waiting for its Harness",
    });
    await withStartupProbeEvidence(waiting, async () => {
      assert.equal(waiting.snapshot.events.some(observedValue("native", true)), false);
    });
  },
);

test(
  "runtime image reconnects an ephemeral native worker from an expired replayed setup code",
  imageTestOptions,
  async (t) => {
    // Pod restarts replay the enrollment Secret's setup code after its expiry.
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });
    const source = await readFile(
      new URL("../fixtures/runtime-native-worker-restart.mjs", import.meta.url),
      "utf8",
    );
    const { stdout } = await runDocker(
      ["exec", containerName, "node", "--input-type=module", "-e", source],
      { timeout: 300_000 * imageSmokeTimeoutMultiplier },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.sameIdentityAfterExpiredReplay, true);
    assert.equal(result.singleBootstrapCompletion, true);
    assert.equal(result.unpairedExpiredRejected, true);
  },
);
