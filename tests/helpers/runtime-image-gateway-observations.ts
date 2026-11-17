import { availableParallelism, loadavg } from "node:os";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { cpuScaledImageTimeoutMs, imageSmokeTimeoutMultiplier } from "./image-smoke-timeout.mjs";
import { jsonLines } from "./json-lines.mjs";
import { commandOutput, failureTail, runDocker } from "./runtime-image-docker.ts";

type DockerFailure = Error & { stdout?: string | Buffer; stderr?: string | Buffer };

function dockerFailure(error: unknown): DockerFailure {
  if (!(error instanceof Error)) {
    throw error;
  }
  return error;
}

// A `node -e` program that calls `request` (an async function's source that resolves
// to an HTTP status) every 250 ms until it answers 2xx or `process.argv[1]`
// milliseconds pass, then names the last failure. One `docker exec` runs the whole
// wait, instead of a Node start per attempt, which the lane's other files would
// share CPUs with (finding 2448); it dies with the container if the Gateway exits.
function readinessProbe(request: string) {
  return `(async () => {
  const request = ${request};
  const deadline = Date.now() + Number(process.argv[1]);
  let last = "no attempt";
  for (;;) {
    try {
      const status = await request();
      if (status >= 200 && status < 300) process.exit(0);
      last = "HTTP " + status;
    } catch (error) {
      last = String(error?.cause?.code ?? error?.cause?.message ?? error?.code ?? error?.message ?? error);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.error("Last /readyz attempt: " + last);
  process.exit(1);
})();`;
}

// Each readiness attempt used to be a `docker inspect` and a `docker exec`
// 250 ms apart: about 460 ms on an idle runner, longer under load. 1.5 s per
// attempt keeps at least that time on 8 CPUs; the wait grows on fewer CPUs,
// where the lane's other files start runtimes at the same time (finding 2460).
const readinessAttemptMs = 1_500;

export async function waitForGatewayReady(containerName: string, readinessAttempts = 60) {
  return waitForContainerReady(containerName, {
    label: "Gateway",
    request:
      '() => fetch("http://127.0.0.1:8080/readyz", { signal: AbortSignal.timeout(5000) }).then((response) => response.status)',
    timeoutMs: cpuScaledImageTimeoutMs(readinessAttempts * readinessAttemptMs),
  });
}

// The source of a request (see readinessProbe) that answers 200 while a matching
// OpenClaw process runs in the container, else 503. Launchers start
// `/app/openclaw.mjs gateway`; OpenClaw then retitles itself "openclaw" (which its
// other commands share) and, once its run loop starts, "openclaw-gateway". An
// idle respawn parent keeps the original argv.
function openClawProcessRequest(match: string) {
  return `async () => {
  const fs = require("node:fs");
  const launched = ["/app/openclaw.mjs", "gateway", ""].join(String.fromCharCode(0));
  const match = ${match};
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(pid)) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8");
    } catch {
      continue;
    }
    if (match(cmdline, launched)) return 200;
  }
  return 503;
}`;
}

// 200 once a launcher has spawned the OpenClaw Gateway. Both launchers spawn it
// only after their pre-launch steps (state migration decision, approver and tool
// policy checks), so a case that asserts only those steps can stop there instead
// of paying for the full start: about 21 of a start's 24 CPU-seconds to /readyz
// are OpenClaw's own (4 CPUs, 2026-10-27).
export const openClawGatewaySpawnedRequest = openClawProcessRequest(
  '(cmdline, launched) => cmdline.includes(launched) || cmdline.startsWith("openclaw-gateway")',
);

// 200 while any OpenClaw Gateway process, or an OpenClaw command, still runs.
export const openClawProcessRunningRequest = openClawProcessRequest(
  '(cmdline, launched) => cmdline.includes(launched) || cmdline.startsWith("openclaw")',
);

export async function waitForGatewaySpawn(containerName: string) {
  return waitForContainerReady(containerName, {
    label: "OpenClaw Gateway spawn",
    request: openClawGatewaySpawnedRequest,
    timeoutMs: cpuScaledImageTimeoutMs(60_000),
  });
}

// Waits until `request` (see readinessProbe) answers 2xx inside the running
// container, failing early when the container stops.
export async function waitForContainerReady(
  containerName: string,
  { label, request, timeoutMs }: { label: string; request: string; timeoutMs: number },
) {
  const probe = readinessProbe(request);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const budgetMs = Math.max(0, deadline - Date.now());
    const ready = await runDocker(["exec", containerName, "node", "-e", probe, String(budgetMs)], {
      timeout: budgetMs + 30_000 * imageSmokeTimeoutMultiplier,
    }).catch(dockerFailure);
    if (!(ready instanceof Error)) {
      return;
    }
    const inspect = await runDocker([
      "inspect",
      containerName,
      "--format",
      "{{.State.Running}} {{.State.ExitCode}}",
    ]);
    const status = /^(true|false) (-?\d+)$/.exec(inspect.stdout.trim());
    if (status === null) {
      throw new Error(
        `${label} readiness probe failed; docker inspect returned invalid state.\n${failureTail(ready.message, 2048)}`,
        { cause: ready },
      );
    }
    const [, running, exitCode] = status;
    if (running === "false") {
      throw new Error(`${label} container exited before readiness with code ${exitCode}.`);
    }
    // The probe ran out its budget, or its exec failed while the container still
    // ran (a dying PID 1 can end the exec before Docker marks the container
    // stopped): try again until the deadline, as each attempt used to.
    if (Date.now() >= deadline) {
      throw new Error(`${label} readiness timed out.\n${failureTail(commandOutput(ready), 2048)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// `openclaw plugins list --json` builds its own plugin registry snapshot: about 3 CPU-seconds
// and 2.4-9.1 s beside a just-ready Gateway on 1, 2 or 4 shared CPUs (measured 2026-10). On a
// CI runner busy with four image files it still once passed runDocker's 60 s default, so only
// cases that assert on the list run it (runGatewaySmoke's collectPlugins).
export async function listGatewayPlugins(containerName: string): Promise<unknown> {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "/app/openclaw.mjs",
    "plugins",
    "list",
    "--json",
  ]);

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `OpenClaw plugin list output was not valid JSON.\n${failureTail(stdout, 2048)}`,
      { cause: error },
    );
  }
}

export function jsonLogEntries(output: string): Record<string, unknown>[] {
  return jsonLines(output, { lenient: true });
}

// Merges a container's newest `lines` log lines from both streams in time order, newest last,
// and keeps at most `limit` characters from the end. A whole `docker logs` read in an error
// spends the 600 characters CI shows, and the 16 KiB its diagnostics keep, on the oldest
// lines: across a container restart those are the previous run's (finding 2784).
export async function containerLogTail(
  containerName: string,
  { lines = 200, limit = 8 * 1024 }: { lines?: number; limit?: number } = {},
) {
  const logs = await runDocker([
    "logs",
    "--timestamps",
    "--tail",
    String(lines),
    containerName,
  ]).catch(dockerFailure);
  const merged = (["stdout", "stderr"] as const).flatMap((stream) =>
    String(logs[stream] ?? "")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [, stamp = "", text = line] = /^(\S+) (.*)$/.exec(line) ?? [];
        // RFC 3339 with up to 9 fraction digits: pad them so the strings sort as times.
        const time = stamp.replace(/(?:\.(\d+))?Z$/, (_: string, digits: string = "") => {
          return `.${digits.padEnd(9, "0")}Z`;
        });
        return { time, text: `${stamp} ${stream}: ${text}` };
      }),
  );
  merged.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const text = merged.map((line) => line.text).join("\n");
  if (logs instanceof Error) {
    return `${logs.message.split("\n")[0]}\n${failureTail(text, limit)}`;
  }
  return failureTail(text, limit);
}

// Probed inside the container by gatewayReadinessReport: the wrapper's /readyz (Compute's
// readiness), its plugin and runtime status, and the native OpenClaw /startupz and /readyz
// that the wrapper's readiness also requires. Each answer keeps its status, time and the
// status fields readiness depends on, else the start of its body; a failed request keeps its
// error code.
const gatewayReadinessProbe = `(async () => {
  const limit = 300;
  // The status fields readiness depends on, kept whole when the body is cut.
  const keys = ["phase", "startupId", "successfulPluginIds", "failures", "runtimeFailure", "workspaceNodeFailure"];
  const statusPort = process.env.OPENCLAW_RUNTIME_STATUS_PORT ?? process.env.OPENCLAW_PLUGIN_STATUS_PORT;
  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
  const read = async (port, path) => {
    if (!port) return { error: "no port" };
    const started = Date.now();
    try {
      const response = await fetch("http://127.0.0.1:" + port + path, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      const body = await response.text();
      let fields;
      try {
        const json = JSON.parse(body);
        fields = Object.fromEntries(keys.filter((key) => json?.[key] !== undefined).map((key) => [key, json[key]]));
      } catch {}
      const shown = fields !== undefined && Object.keys(fields).length > 0
        ? { fields }
        : { body: body.length > limit ? body.slice(0, limit) + "..." : body };
      return { status: response.status, ms: Date.now() - started, ...shown };
    } catch (error) {
      return { error: String(error?.cause?.code ?? error?.cause?.message ?? error?.code ?? error?.message ?? error), ms: Date.now() - started };
    }
  };
  const [wrapperReady, plugin, runtime, nativeStartup, nativeReady] = await Promise.all([
    read(statusPort, "/readyz"),
    read(statusPort, "/openclaw/plugin-runtime/status"),
    read(statusPort, "/openclaw/runtime/status"),
    read(gatewayPort, "/startupz"),
    read(gatewayPort, "/readyz"),
  ]);
  console.log(JSON.stringify({ wrapperReady, plugin, runtime, nativeStartup, nativeReady }));
})();`;

const inspectSchema = Type.Tuple([
  Type.Object({
    State: Type.Object({
      StartedAt: Type.String(),
      Status: Type.String(),
      ExitCode: Type.Integer(),
      OOMKilled: Type.Boolean(),
    }),
  }),
]);

// Check the fields used in the headline. Keep the other fields intact in the detailed report.
const probeAnswerSchema = Type.Union([
  Type.Object({
    error: Type.String(),
    status: Type.Optional(Type.Never()),
    fields: Type.Optional(Type.Never()),
  }),
  Type.Object({
    status: Type.Integer(),
    error: Type.Optional(Type.Never()),
    fields: Type.Optional(
      Type.Object({
        phase: Type.Optional(Type.String()),
        failures: Type.Optional(Type.Array(Type.Object({ code: Type.Optional(Type.String()) }))),
        runtimeFailure: Type.Optional(
          Type.Object({ check: Type.Optional(Type.String()), code: Type.Optional(Type.String()) }),
        ),
      }),
    ),
  }),
]);
const readinessProbeSchema = Type.Object({
  wrapperReady: probeAnswerSchema,
  plugin: probeAnswerSchema,
  runtime: probeAnswerSchema,
  nativeStartup: probeAnswerSchema,
  nativeReady: probeAnswerSchema,
});
const startupPhaseSchema = Type.Object({
  event: Type.Literal("runtime.startup_phase"),
  phase: Type.String(),
  outcome: Type.String(),
  code: Type.Optional(Type.String()),
  ms: Type.Number(),
  sinceStartMs: Type.Number(),
});

function parseDiagnosticJson<T extends TSchema>(
  output: string,
  schema: T,
  label: string,
): Static<T> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    // A SyntaxError can quote the malformed output.
    throw new Error(`${label} output was not valid JSON.`);
  }
  if (!Check(schema, value)) {
    throw new Error(`${label} output had an unexpected shape.`);
  }
  return value;
}

function diagnosticError(error: unknown) {
  return { error: (dockerFailure(error).message.split("\n", 1)[0] ?? "").slice(0, 300) };
}

function answerSummary(answer: Static<typeof probeAnswerSchema> | undefined) {
  if (answer === undefined) {
    return "unread";
  }
  return answer.error === undefined ? `${answer.status}` : `error ${answer.error}`;
}

// A bounded account of why a Gateway is not ready, read when a readiness wait times out.
// `headline` fits in the 600 characters of a failure that CI's job log shows; `detail` adds
// each probe's answer, the container state and the wrapper's startup phases since the
// container last started. The test process's load average tells contention from a stall.
export async function gatewayReadinessReport(containerName: string) {
  const inspect = await runDocker(["inspect", containerName])
    .then(({ stdout }) => {
      const [{ State: state }] = parseDiagnosticJson(stdout, inspectSchema, "Docker inspect");
      if (!Number.isFinite(Date.parse(state.StartedAt))) {
        throw new Error("Docker inspect output had an invalid start time.");
      }
      return { state };
    })
    .catch(diagnosticError);
  const probe = await runDocker(["exec", containerName, "node", "-e", gatewayReadinessProbe], {
    timeout: 30_000 * imageSmokeTimeoutMultiplier,
  })
    .then(({ stdout }) => ({
      answers: parseDiagnosticJson(
        stdout.trim().split("\n").at(-1) ?? "",
        readinessProbeSchema,
        "Gateway status probe",
      ),
    }))
    .catch(diagnosticError);
  const state = "state" in inspect ? inspect.state : undefined;
  const answers = "answers" in probe ? probe.answers : undefined;
  const phaseLogs = state
    ? await runDocker(["logs", "--since", state.StartedAt, containerName]).catch(dockerFailure)
    : {};
  const phases = jsonLogEntries(commandOutput(phaseLogs))
    .filter((entry) => Check(startupPhaseSchema, entry))
    .map(
      (entry) =>
        `${entry.phase}:${entry.outcome}${entry.code ? ` ${entry.code}` : ""} ${entry.ms}/${entry.sinceStartMs} ms`,
    );
  const plugin = answers?.plugin.fields;
  const runtime = answers?.runtime.fields;
  const pluginFailures = (plugin?.failures ?? []).map((failure) => failure.code).join(",");
  const runtimeFailure = runtime?.runtimeFailure
    ? `${runtime.runtimeFailure.check}/${runtime.runtimeFailure.code}`
    : "none";
  const container =
    "error" in inspect
      ? inspect.error
      : `${inspect.state.Status}, started ${Math.round((Date.now() - Date.parse(inspect.state.StartedAt)) / 1000)} s ago, exit ${inspect.state.ExitCode}, OOMKilled ${inspect.state.OOMKilled}`;
  const load = loadavg()
    .map((value) => value.toFixed(1))
    .join("/");
  const headline = [
    "error" in probe
      ? `status probe failed: ${probe.error}`
      : `wrapper /readyz ${answerSummary(probe.answers.wrapperReady)}`,
    `plugin phase ${plugin?.phase ?? answerSummary(answers?.plugin)}${pluginFailures ? ` (failures ${pluginFailures})` : ""}`,
    `runtime failure ${answers?.runtime.status === 200 ? runtimeFailure : answerSummary(answers?.runtime)}`,
    `native /startupz ${answerSummary(answers?.nativeStartup)}, /readyz ${answerSummary(answers?.nativeReady)}`,
    `last phase ${phases.at(-1) ?? "none"}`,
    `container ${container}`,
    `test host load ${load} on ${availableParallelism()} CPUs`,
  ].join("; ");
  const detail = [
    `status probe: ${JSON.stringify(answers ?? probe)}`,
    `wrapper phases since start (duration/since start): ${phases.slice(-16).join(", ") || "none"}`,
  ].join("\n");
  return { headline, detail };
}
