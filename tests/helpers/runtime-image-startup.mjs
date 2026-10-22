// Shared by the runtime image startup smoke tests, which CI runs in three lanes
// (runtime-image-startup.test.mjs, runtime-image-startup-probe.test.mjs,
// runtime-image-startup-termination.test.mjs,
// runtime-image-gateway-peer.test.mjs, runtime-image-native-worker.test.mjs,
// runtime-image-state-migration.test.mjs,
// runtime-image-managed-files.test.mjs,
// runtime-image-native-listener.test.mjs and
// runtime-image-gateway-workspace.test.mjs).
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { imageSmokeTimeoutMultiplier } from "./image-smoke-timeout.mjs";
import { followContainer } from "./docker-follow.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { redactLogLine } from "../../scripts/ci/failure-redaction.mjs";

export const execute = promisify(execFile);
export const docker = process.env.OCC_DOCKER_BIN ?? "docker";
export const image = process.env.OCC_TEST_RUNTIME_IMAGE;
export const runtimeImageModel = defaultAgentModel;
export const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_IMAGE to a locally built OpenClaw runtime image tag.",
      }
    : {};

// `options.redact` lists extra values (synthetic credentials) a failure message must not show.
export async function runDocker(args, options = {}, input) {
  return runDockerCommand(docker, args, options, input);
}

// Runs a docker command. A failure rejects with dockerCommandFailure's error.
export async function runDockerCommand(dockerBin, args, options = {}, input) {
  const { redact = [], ...execOptions } = options;
  const timeout = execOptions.timeout ?? 60_000 * imageSmokeTimeoutMultiplier;
  const startedAt = Date.now();
  const command = execute(dockerBin, args, { maxBuffer: 1_000_000, ...execOptions, timeout });
  // A stdin error (EPIPE when docker exits early) waits for the command, whose failure
  // says more; it is thrown only when the command itself succeeded.
  let inputError;
  const inputComplete =
    input === undefined
      ? undefined
      : new Promise((resolve) => {
          command.child.stdin.once("error", (error) => {
            inputError = error;
            resolve();
          });
          command.child.stdin.end(input, resolve);
        });
  let result;
  try {
    [result] = await Promise.all([command, inputComplete]);
  } catch (error) {
    throw dockerCommandFailure(error, args, {
      timeout,
      elapsedMs: Date.now() - startedAt,
      redact,
    });
  }
  if (inputError !== undefined) {
    throw inputError;
  }
  return result;
}

const dockerArgumentLimit = 120;
const dockerStdoutTailLimit = 4 * 1024;
const dockerStderrTailLimit = 8 * 1024;

// Replaces each value in `redact`. Run on the whole text, before any cut can split a value.
function withoutRedactValues(text, redact) {
  let result = String(text);
  for (const value of redact) {
    if (typeof value === "string" && value.length > 0) {
      result = result.replaceAll(value, "[redacted]");
    }
  }
  return result;
}

// Then redacts like CI's failure report: token shapes such as the sk- keys these tests plant,
// secret assignments, URL passwords.
function redactDockerText(text) {
  return redactLogLine(text, [], Number.POSITIVE_INFINITY);
}

// Node's own error for a failed command names the whole command line (which can carry
// synthetic credentials and multi-line scripts) and keeps no exit code, signal or timeout in
// its message. Finding 2184's failure had empty output, so its message was empty and its
// cause was lost. This error's message names the command (long or multi-line arguments
// elided), the exit code, the signal, whether the timeout stopped it and how long it ran,
// then the redacted ends of stdout and of stderr. stderr comes last so a caller's own tail
// cut keeps it. The error keeps code, signal, killed and timedOut, and the raw stdout and
// stderr (not enumerable, so printing the error shows only the redacted message) for
// callers that check them. Node's error is not kept as the cause: its message is the raw
// command line.
export function dockerCommandFailure(error, args, { timeout, elapsedMs, redact = [] } = {}) {
  const shown = args.map((arg) => {
    const text = String(arg);
    return text.includes("\n") || text.length > dockerArgumentLimit
      ? `<${text.length}-char argument>`
      : text;
  });
  const fullCommand = withoutRedactValues(`docker ${shown.join(" ")}`, redact);
  const command = redactDockerText(
    fullCommand.length > 512 ? `${fullCommand.slice(0, 512)}...` : fullCommand,
  );
  const timedOut =
    error.killed === true &&
    error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
    error.name !== "AbortError" &&
    timeout > 0 &&
    elapsedMs >= timeout;
  const outcome = [
    typeof error.code === "number"
      ? `exit code ${error.code}`
      : `no exit code${typeof error.code === "string" ? ` (${error.code})` : ""}`,
    `signal ${error.signal ?? "none"}`,
    timedOut ? `timed out after ${timeout} ms` : "not timed out",
    `ran ${elapsedMs ?? "?"} ms`,
  ];
  if (error.killed === true && !timedOut) {
    outcome.push("killed");
  }
  const sections = [`${command} failed (${outcome.join(", ")}).`];
  const stdout = withoutRedactValues(error.stdout ?? "", redact);
  const stderr = withoutRedactValues(error.stderr ?? "", redact);
  if (stdout.trim() !== "") {
    sections.push(`stdout:\n${redactDockerText(failureTail(stdout, dockerStdoutTailLimit))}`);
  }
  if (stderr.trim() !== "") {
    sections.push(`stderr:\n${redactDockerText(failureTail(stderr, dockerStderrTailLimit))}`);
  }
  if (stdout.trim() === "" && stderr.trim() === "") {
    sections.push("(no stdout or stderr)");
  }
  const failure = new Error(sections.join("\n"));
  Object.assign(failure, {
    code: error.code,
    signal: error.signal ?? null,
    killed: error.killed === true,
    timedOut,
    elapsedMs,
  });
  for (const [name, value] of [
    ["stdout", error.stdout],
    ["stderr", error.stderr],
  ]) {
    Object.defineProperty(failure, name, { value, enumerable: false, writable: true });
  }
  return failure;
}

export async function waitForDockerLog(containerName, pattern) {
  const deadline = Date.now() + 20_000 * imageSmokeTimeoutMultiplier;
  const logs = followContainer(undefined, containerName, { docker, exit: false });
  let output = "";
  try {
    for (;;) {
      const seen = logs.changes.version;
      let state;
      try {
        state = logs.read();
      } catch (error) {
        throw new Error(
          `Could not follow ${containerName} logs waiting for ${pattern}.
${failureTail(`${error.message}\n${output}`)}`,
          { cause: error },
        );
      }
      output = `${state.stdout}\n${state.stderr}`;
      if (pattern.test(output)) {
        return output;
      }
      if (!state.following) {
        throw new Error(`${containerName} stopped before ${pattern} appeared in its logs.
${failureTail(output)}`);
      }
      if (Date.now() >= deadline) {
        break;
      }
      const checkedAt = Date.now();
      await logs.changes.wait(seen, deadline - checkedAt);
      // At most one check per 100 ms while the container writes.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, checkedAt + 100 - Date.now())),
      );
    }
  } finally {
    await logs.stop();
  }
  throw new Error(`Timed out waiting for ${pattern} in ${containerName} logs.
${failureTail(output)}`);
}

export function commandOutput(error) {
  return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
}

// CI keeps only the first 16 KiB of a failure message (scripts/ci/reporter.mjs),
// so a whole container log in an error loses its end: the wrapper's stderr and
// the actual failure (finding 976 misread a cut log as a Doctor stall). Errors
// carry at most the last `limit` characters of process output instead, from a
// line start when one is near, so the cut does not split a value the reporter
// would redact.
export const failureOutputLimit = 12 * 1024;

export function failureTail(output, limit = failureOutputLimit) {
  if (output.length <= limit) {
    return output;
  }
  let tail = output.slice(-limit);
  const lineEnd = tail.indexOf("\n");
  if (lineEnd !== -1 && lineEnd < 1024) {
    tail = tail.slice(lineEnd + 1);
  }
  return `[... ${output.length - tail.length} earlier chars omitted ...]\n${tail}`;
}

export async function temporaryGatewayConfiguration(t, harnessId) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-image-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const path = join(directory, "openclaw.json");
  await writeFile(path, JSON.stringify(createAdmittedRuntimeImageConfiguration(harnessId)));
  return path;
}

export function createRuntimeImageConfiguration(harnessId, providerModel, options = {}) {
  const configuration = createHarnessConfiguration(harnessId, providerModel);
  if (options.enableSlack !== true) {
    return configuration;
  }

  const plugins = configuration.plugins ?? {};
  const entries = plugins.entries ?? {};
  configuration.plugins = {
    ...plugins,
    allow: [...new Set([...(Array.isArray(plugins.allow) ? plugins.allow : []), "slack"])],
    entries: {
      ...entries,
      slack: {
        ...entries.slack,
        enabled: true,
      },
    },
  };
  configuration.channels = {
    ...configuration.channels,
    slack: {
      ...configuration.channels?.slack,
      enabled: true,
    },
  };

  return configuration;
}

export function createAdmittedRuntimeImageConfiguration(harnessId, options = {}) {
  return admitLoggingConfiguration(
    createRuntimeImageConfiguration(harnessId, runtimeImageModel, options),
    "info",
  );
}

// Polls /readyz inside the container every 250 ms until `process.argv[1]`
// milliseconds pass, then names the last failure. One `docker exec` runs the
// whole wait; it dies with the container if the Gateway exits.
const gatewayReadinessProbe = `(async () => {
  const deadline = Date.now() + Number(process.argv[1]);
  let last = "no attempt";
  for (;;) {
    try {
      const response = await fetch("http://127.0.0.1:8080/readyz", { signal: AbortSignal.timeout(5000) });
      if (response.ok) process.exit(0);
      last = "HTTP " + response.status;
    } catch (error) {
      last = String(error?.cause?.code ?? error?.cause?.message ?? error?.message ?? error);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.error("Last /readyz attempt: " + last);
  process.exit(1);
})();`;

// Each readiness attempt used to be a `docker inspect` and a `docker exec`
// 250 ms apart: about 460 ms on an idle runner, longer under load. 1.5 s per
// attempt keeps at least that time.
const readinessAttemptMs = 1_500;

export async function waitForGatewayReady(containerName, readinessAttempts = 60) {
  const deadline =
    Date.now() + readinessAttempts * readinessAttemptMs * imageSmokeTimeoutMultiplier;
  for (;;) {
    const budgetMs = Math.max(0, deadline - Date.now());
    const ready = await runDocker(
      ["exec", containerName, "node", "-e", gatewayReadinessProbe, String(budgetMs)],
      { timeout: budgetMs + 30_000 * imageSmokeTimeoutMultiplier },
    ).catch((error) => error);
    if (!(ready instanceof Error)) {
      return;
    }
    const inspect = await runDocker([
      "inspect",
      containerName,
      "--format",
      "{{.State.Running}} {{.State.ExitCode}}",
    ]);
    const [running, exitCode] = inspect.stdout.trim().split(/\s+/);
    if (running !== "true") {
      throw new Error(`Gateway container exited before readiness with code ${exitCode}.`);
    }
    // The probe ran out its budget, or its exec failed while the container still
    // ran (a dying PID 1 can end the exec before Docker marks the container
    // stopped): try again until the deadline, as each attempt used to.
    if (Date.now() >= deadline) {
      throw new Error(`Gateway readiness timed out.\n${failureTail(commandOutput(ready), 2048)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function listGatewayPlugins(containerName) {
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

export function jsonLogEntries(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry !== undefined);
}

export async function runGatewaySmoke(t, harnessId, options = {}) {
  const {
    collectPlugins = harnessId === "codex",
    configuration = createAdmittedRuntimeImageConfiguration(harnessId, {
      enableSlack: harnessId === "openclaw",
    }),
    configurationPath,
    entrypoint = DOCKER_GATEWAY_RUNTIME_ENTRYPOINT,
    extraEnvironment = [],
    readinessAttempts,
    tmpfs = ["/home/node:size=1024m,uid=1000,gid=1000,mode=700"],
    volumes = [],
    network = "none",
    waitUntilReady = true,
    withAppServer = true,
  } = options;
  const containerName = `oce-runtime-image-${harnessId}-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));

  const environment = [
    `OPENCLAW_CONFIG_PATH=${configurationPath ?? "/home/node/.openclaw/openclaw.json"}`,
    ...(configurationPath === undefined
      ? [`OPENCLAW_CONFIG_JSON=${JSON.stringify(configuration)}`]
      : []),
    "OPENCLAW_GATEWAY_PORT=8080",
    "OPENCLAW_GATEWAY_PASSWORD=openclaw-runtime-image-smoke-password",
    "OPENCLAW_STATE_DIR=/home/node/.openclaw",
    ...(withAppServer
      ? [
          "APP_SERVER_URL=ws://127.0.0.1:9",
          "APP_SERVER_TOKEN=openclaw-runtime-image-app-server-token",
        ]
      : []),
    "HOME=/home/node",
    ...extraEnvironment,
  ];

  await runDocker(["rm", "-f", containerName]).catch(() => {});
  await runDocker([
    "run",
    "--name",
    containerName,
    "--detach",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...tmpfs.flatMap((value) => ["--tmpfs", value]),
    "--tmpfs",
    "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
    "--network",
    network,
    ...volumes.flatMap((value) => ["--volume", value]),
    ...environment.flatMap((value) => ["-e", value]),
    "--entrypoint",
    "node",
    image,
    "-e",
    ...nodeProgramArguments(entrypoint),
  ]);
  if (!waitUntilReady) {
    return { containerName };
  }

  try {
    await waitForGatewayReady(containerName, readinessAttempts);
    const pluginList = collectPlugins ? await listGatewayPlugins(containerName) : undefined;
    const logs = await runDocker(["logs", containerName]);
    return {
      containerName,
      logs: `${logs.stdout}\n${logs.stderr}`,
      pluginList,
    };
  } catch (error) {
    const logs = await runDocker(["logs", containerName]).catch((logsError) => logsError);
    // A failed docker command's message names the command and its exit on the first
    // line; the ends of its stdout and stderr follow, stderr last.
    const [headline, ...detail] = error.message.split("\n");
    const failure = [
      headline.slice(0, 512),
      ...(detail.length > 0 ? [failureTail(detail.join("\n"), 2560)] : []),
    ];
    throw new Error(`${failure.join("\n")}\n${failureTail(commandOutput(logs))}`, {
      cause: error,
    });
  }
}

const manualReviewedCodexSeccompProfileSha256 =
  "71a2871a066a696a171049a15db3f065122c153cd11ef451cee3341ddbd9697f";
const reviewedCodexSeccompProfileFilePattern = /^codex-0\.163\.0-alpha\.2-([a-f0-9]{64})\.json$/;

async function ciPreparedCodexSeccompProfile(ciStatePath) {
  if (ciStatePath === undefined || ciStatePath.length === 0) {
    return undefined;
  }
  let state;
  try {
    state = JSON.parse(await readFile(ciStatePath, "utf8"));
  } catch (error) {
    throw new Error(
      `OPENCLAW_ENTERPRISE_CI_STATE must name readable CI preparation state for OCC_TEST_CODEX_SECCOMP_PROFILE: ${error.message}`,
      { cause: error },
    );
  }
  const cluster = state.resources?.find(
    (resource) => resource?.kind === "k3d-cluster" && resource.codexDockerSeccompProfile,
  );
  const prepared = cluster?.codexDockerSeccompProfile;
  assert.equal(
    typeof prepared?.path,
    "string",
    "OPENCLAW_ENTERPRISE_CI_STATE must record cluster.codexDockerSeccompProfile.path.",
  );
  assert.match(
    prepared.sha256 ?? "",
    /^[a-f0-9]{64}$/,
    "OPENCLAW_ENTERPRISE_CI_STATE must record cluster.codexDockerSeccompProfile.sha256.",
  );
  return prepared;
}

// Docker security options for a case that runs the stock Codex sandbox. Only
// the CI lanes whose manifest lists OCC_TEST_CODEX_SECCOMP_PROFILE in
// requiredEnv prepare the reviewed profile (prepare.codexSeccomp). In CI, or
// whenever CI preparation state is present, a missing profile is an error: a
// case that calls this from a lane without the profile fails instead of
// running unconfined or skipping. Local runs without CI keep Docker's default
// seccomp profile.
export async function reviewedCodexSeccompSecurityOptions({
  profile = process.env.OCC_TEST_CODEX_SECCOMP_PROFILE,
  ciStatePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE,
  ci = process.env.CI,
} = {}) {
  const securityOptions = ["--security-opt", "no-new-privileges"];
  if (profile === undefined || profile.length === 0) {
    const inCi = ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
    if (inCi || (ciStatePath !== undefined && ciStatePath.length > 0)) {
      throw new Error(
        "OCC_TEST_CODEX_SECCOMP_PROFILE is required in CI: this case runs the Codex sandbox, so its lane must prepare the reviewed profile (prepare.codexSeccomp and requiredEnv in scripts/ci/test-suites).",
      );
    }
    return securityOptions;
  }

  assert.equal(
    profile.toLowerCase().includes("unconfined"),
    false,
    "OCC_TEST_CODEX_SECCOMP_PROFILE must not select an unconfined seccomp profile.",
  );
  const expected = basename(profile).match(reviewedCodexSeccompProfileFilePattern)?.[1];
  assert.ok(
    expected,
    "OCC_TEST_CODEX_SECCOMP_PROFILE must point to codex-0.163.0-alpha.2-<profile-sha256>.json.",
  );

  let contents;
  try {
    contents = await readFile(profile);
  } catch (error) {
    throw new Error(
      `OCC_TEST_CODEX_SECCOMP_PROFILE must name a readable Codex seccomp profile: ${error.message}`,
      { cause: error },
    );
  }

  const actual = createHash("sha256").update(contents).digest("hex");
  assert.equal(
    actual,
    expected,
    `OCC_TEST_CODEX_SECCOMP_PROFILE digest ${actual} did not match the Codex 0.163.0-alpha.2 profile filename digest ${expected}.`,
  );

  const prepared = await ciPreparedCodexSeccompProfile(ciStatePath);
  if (prepared === undefined) {
    assert.equal(
      expected,
      manualReviewedCodexSeccompProfileSha256,
      "OCC_TEST_CODEX_SECCOMP_PROFILE must be prepared by image CI state or use the pinned manual reviewed Codex profile.",
    );
  } else {
    assert.equal(
      profile,
      prepared.path,
      "OCC_TEST_CODEX_SECCOMP_PROFILE must match the CI-prepared Codex seccomp profile path.",
    );
    assert.equal(
      actual,
      prepared.sha256,
      "OCC_TEST_CODEX_SECCOMP_PROFILE must match the CI-prepared Codex seccomp profile digest.",
    );
  }
  return [...securityOptions, "--security-opt", `seccomp=${profile}`];
}

function gatewayLogDiagnostic(entries) {
  return entries
    .filter((entry) => entry.subsystem === "gateway")
    .map(({ level, message }) => `${level}: ${message}`)
    .slice(-8)
    .join("\n");
}

export function assertGatewayLogEntry(entries, predicate, description) {
  assert.ok(
    entries.some(predicate),
    `${description}\nRecent gateway logs:\n${gatewayLogDiagnostic(entries)}`,
  );
}
