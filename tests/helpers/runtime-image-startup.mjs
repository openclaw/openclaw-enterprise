// Shared by the runtime image startup smoke tests, which CI runs in three lanes
// (runtime-image-startup.test.mjs, runtime-image-startup-probe.test.mjs,
// runtime-image-startup-termination.test.ts,
// runtime-image-gateway-unclean-restart.test.ts,
// runtime-image-gateway-retained-state.test.ts,
// runtime-image-gateway-peer.test.ts, runtime-image-native-worker.test.mjs,
// runtime-image-state-migration.test.mjs,
// runtime-image-managed-files.test.ts,
// runtime-image-native-listener.test.mjs and
// runtime-image-gateway-workspace.test.ts).
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mts";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { productionGatewayMemoryLimitGi } from "./kubernetes-real.mjs";
import { commandOutput, failureTail, runDocker } from "./runtime-image-docker.ts";
import {
  listGatewayPlugins,
  waitForGatewayReady,
  waitForGatewaySpawn,
} from "./runtime-image-gateway-observations.ts";

export {
  commandOutput,
  docker,
  execute,
  failureTail,
  runDocker,
  runDockerCommand,
  waitForDockerLog,
} from "./runtime-image-docker.ts";
export {
  containerLogTail,
  gatewayReadinessReport,
  jsonLogEntries,
  listGatewayPlugins,
  openClawGatewaySpawnedRequest,
  openClawProcessRunningRequest,
  waitForContainerReady,
  waitForGatewayReady,
  waitForGatewaySpawn,
} from "./runtime-image-gateway-observations.ts";

export const image = process.env.OCC_TEST_RUNTIME_IMAGE;
export const runtimeImageModel = defaultAgentModel;
// The production Gateway memory limit (productionGatewayMemoryLimitGi), with
// swap capped at the same value. Docker's `--memory` alone allows as much again
// in swap, so a Gateway that outgrew its limit passed on CI runners, which swap,
// and was OOM-killed on a host without swap, as on a typical Kubernetes node
// (finding 2700).
const gatewayMemoryLimitBytes = productionGatewayMemoryLimitGi * 1024 ** 3;
export const gatewayMemoryArguments = [
  "--memory",
  String(gatewayMemoryLimitBytes),
  "--memory-swap",
  String(gatewayMemoryLimitBytes),
];
// The most an embedded Gateway's cgroup may have held (memory.peak) through its
// first chat turn: the limit above less about 20% headroom. At the OpenClaw pin
// of #2982 the stand-in provider's first turn peaked at 2.53 to 2.78 GiB
// (finding 2700). A failure means the Gateway grew toward its production limit:
// re-measure the first turn and update the documented Gateway sizing (the
// production example, the profile renderer, installation-profiles.md and this
// limit) before raising the budget.
export const gatewayFirstTurnMemoryBudgetBytes = Math.round(3.2 * 1024 ** 3);

const gibibytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

// Reads a running Gateway container's cgroup v2 memory.peak (Linux 5.19 and
// later): the most the container held since it started, including the page
// cache and tmpfs it is charged for. Returns `{ unavailable }` with the reason
// when the host cannot report it.
export async function gatewayMemoryPeak(containerName) {
  let stdout;
  try {
    ({ stdout } = await runDocker([
      "exec",
      containerName,
      "cat",
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/memory.peak",
    ]));
  } catch (error) {
    return {
      unavailable: `the container's cgroup v2 memory.max and memory.peak are unreadable: ${error.message.slice(0, 300)}`,
    };
  }
  const [max, peak] = stdout.trim().split("\n");
  // In the host's cgroup namespace /sys/fs/cgroup is another cgroup; only the
  // container's own cgroup carries the limit this file sets.
  if (Number(max) !== gatewayMemoryLimitBytes) {
    return {
      unavailable: `/sys/fs/cgroup is not the Gateway container's cgroup: memory.max is ${max}, not ${gatewayMemoryLimitBytes}`,
    };
  }
  return { peakBytes: Number(peak) };
}

// Checks a peak from gatewayMemoryPeak against the first-turn budget in its own
// subtest, which reports a host without memory.peak as skipped, not passed.
export async function assertGatewayFirstTurnMemory(t, measurement) {
  await t.test("the Gateway's first turn stays within its memory budget", (subtest) => {
    if (measurement.unavailable !== undefined) {
      subtest.skip(
        `memory.peak is unavailable, so the budget is unchecked: ${measurement.unavailable}`,
      );
      return;
    }
    const { peakBytes } = measurement;
    assert.ok(
      peakBytes <= gatewayFirstTurnMemoryBudgetBytes,
      `the Gateway's memory.peak through its first turn is ${gibibytes(peakBytes)}, above its ` +
        `${gibibytes(gatewayFirstTurnMemoryBudgetBytes)} budget under a ${gibibytes(gatewayMemoryLimitBytes)} limit. ` +
        "If the OpenClaw pin moved, re-measure the first turn without swap (finding 2700) and update the " +
        "documented Gateway sizing (deploy/examples/production/installation.yaml, " +
        "scripts/render-installation-profile.mjs, docs/guides/deploy/installation-profiles.md) and this " +
        "test's limit before raising gatewayFirstTurnMemoryBudgetBytes.",
    );
    subtest.diagnostic(`Gateway memory.peak through the first turn: ${gibibytes(peakBytes)}`);
  });
}
export const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_IMAGE to a locally built OpenClaw runtime image tag.",
      }
    : {};

export async function temporaryGatewayConfiguration(
  t,
  harnessId,
  configuration = createAdmittedRuntimeImageConfiguration(harnessId),
) {
  const directory = await temporaryDirectory(t, "oce-runtime-image-config-");

  const path = join(directory, "openclaw.json");
  await writeFile(path, JSON.stringify(configuration));
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

// A new volume owned by the Gateway user, for mounting at `mountPath` (the
// Gateway home or its ~/.openclaw) as its PersistentVolume is. `seed`, a shell
// command run first as root with `seedVolumes` also mounted, can fill it.
export async function gatewayStateVolume(t, mountPath, { seed, seedVolumes = [] } = {}) {
  const volume = `oce-runtime-image-state-${randomBytes(6).toString("hex")}`;
  await runDocker(["volume", "create", volume]);
  // node:test runs `after` hooks in registration order, so this one runs before
  // the hooks that remove the containers started on the volume later, and Docker
  // refuses to remove a volume in use. Remove those containers first.
  t.after(async () => {
    const users = await runDocker(["ps", "-aq", "--filter", `volume=${volume}`]).catch(
      () => undefined,
    );
    const ids = users?.stdout.split(/\s+/).filter(Boolean) ?? [];
    if (ids.length > 0) {
      await runDocker(["rm", "-f", ...ids]).catch(() => {});
    }
    await runDocker(["volume", "rm", "-f", volume]).catch(() => {});
  });
  // As root, like the Docker Driver's workspace setup: a new volume mounted
  // below the image's home can be root-owned.
  await runDocker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--network",
    "none",
    "--volume",
    `${volume}:${mountPath}`,
    ...seedVolumes.flatMap((value) => ["--volume", value]),
    "--entrypoint",
    "sh",
    image,
    "-c",
    `${seed === undefined ? "" : `${seed} && `}chown -R 1000:1000 ${mountPath}`,
  ]);
  return volume;
}

export async function runGatewaySmoke(t, harnessId, options = {}) {
  const {
    collectPlugins = false,
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
    // "ready" waits for /readyz; "spawned" only until OpenClaw starts (waitForGatewaySpawn).
    until = "ready",
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
    if (until === "spawned") {
      await waitForGatewaySpawn(containerName);
    } else {
      await waitForGatewayReady(containerName, readinessAttempts);
    }
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
const reviewedCodexSeccompProfileFilePattern =
  /^codex-(0\.164\.0|0\.163\.0-alpha\.2)-([a-f0-9]{64})\.json$/;

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
  codexVersion = "0.164.0",
} = {}) {
  const securityOptions = ["--security-opt", "no-new-privileges"];
  if (profile === undefined || profile.length === 0) {
    const inCi = ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
    if (
      inCi ||
      codexVersion !== "0.164.0" ||
      (ciStatePath !== undefined && ciStatePath.length > 0)
    ) {
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
  const match = basename(profile).match(reviewedCodexSeccompProfileFilePattern);
  assert.ok(
    match?.[1] === codexVersion,
    `OCC_TEST_CODEX_SECCOMP_PROFILE must point to codex-${codexVersion}-<profile-sha256>.json.`,
  );
  const expected = match[2];

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
    `OCC_TEST_CODEX_SECCOMP_PROFILE digest ${actual} did not match the Codex ${codexVersion} profile filename digest ${expected}.`,
  );

  const prepared = await ciPreparedCodexSeccompProfile(ciStatePath);
  if (prepared === undefined) {
    assert.equal(
      codexVersion,
      "0.164.0",
      "A historical Codex seccomp profile must be prepared by image CI state.",
    );
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
