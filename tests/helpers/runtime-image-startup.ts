import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mts";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  admitLoggingConfiguration,
  type OpenClawConfigurationValue,
} from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { commandOutput, failureTail, runDocker } from "./runtime-image-docker.ts";
import {
  listGatewayPlugins,
  waitForGatewayReady,
  waitForGatewaySpawn,
} from "./runtime-image-gateway-observations.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

export const image = process.env.OCC_TEST_RUNTIME_IMAGE;
export const runtimeImageModel = defaultAgentModel;
export const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_IMAGE to a locally built OpenClaw runtime image tag.",
      }
    : {};

type CleanupScope = { after(cleanup: () => unknown): void };

export async function temporaryGatewayConfiguration(
  t: CleanupScope,
  harnessId: string,
  configuration: OpenClawConfigurationValue = createAdmittedRuntimeImageConfiguration(harnessId),
): Promise<string> {
  const directory = await temporaryDirectory(t, "oce-runtime-image-config-");
  const path = join(directory, "openclaw.json");
  await writeFile(path, JSON.stringify(configuration));
  return path;
}

type RuntimeImageConfigurationOptions = { enableSlack?: boolean };
type HarnessConfiguration = ReturnType<typeof createHarnessConfiguration>;
type SlackOptions = { enabled: boolean };
type SmokeConfiguration = Omit<HarnessConfiguration, "plugins"> & {
  plugins?: {
    allow: string[];
    entries: Partial<NonNullable<HarnessConfiguration["plugins"]>["entries"]> & {
      slack?: SlackOptions;
    };
  };
  channels?: { slack?: SlackOptions };
};

export function createRuntimeImageConfiguration(
  harnessId: string,
  providerModel: string,
  { enableSlack }: RuntimeImageConfigurationOptions = {},
): SmokeConfiguration {
  const configuration: SmokeConfiguration = createHarnessConfiguration(harnessId, providerModel);
  if (enableSlack !== true) {
    return configuration;
  }

  const plugins = configuration.plugins;
  const entries = plugins?.entries;
  configuration.plugins = {
    ...plugins,
    allow: [...new Set([...(plugins?.allow ?? []), "slack"])],
    entries: { ...entries, slack: { ...entries?.slack, enabled: true } },
  };
  configuration.channels = {
    ...configuration.channels,
    slack: { ...configuration.channels?.slack, enabled: true },
  };
  return configuration;
}

export function createAdmittedRuntimeImageConfiguration(
  harnessId: string,
  options: RuntimeImageConfigurationOptions = {},
) {
  return admitLoggingConfiguration(
    createRuntimeImageConfiguration(harnessId, runtimeImageModel, options),
    "info",
  );
}

type GatewaySmokeOptions = {
  collectPlugins?: boolean;
  configuration?: OpenClawConfigurationValue;
  configurationPath?: string;
  entrypoint?: string | undefined;
  extraEnvironment?: readonly string[];
  readinessAttempts?: number | undefined;
  tmpfs?: readonly string[];
  volumes?: readonly string[];
  network?: string;
  until?: "ready" | "spawned";
  waitUntilReady?: boolean;
  withAppServer?: boolean;
};

type GatewaySmokeResult = {
  containerName: string;
  logs?: string;
  pluginList?: unknown;
};

export async function runGatewaySmoke(
  t: CleanupScope,
  harnessId: string,
  options: GatewaySmokeOptions = {},
): Promise<GatewaySmokeResult> {
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
    const logs = await runDocker(["logs", containerName]).catch(commandError);
    // A failed docker command's message names the command and its exit on the first
    // line; the ends of its stdout and stderr follow, stderr last.
    const [headline = "", ...detail] = commandError(error).message.split("\n");
    const failure = [
      headline.slice(0, 512),
      ...(detail.length > 0 ? [failureTail(detail.join("\n"), 2560)] : []),
    ];
    throw new Error(`${failure.join("\n")}\n${failureTail(commandOutput(logs))}`, {
      cause: error,
    });
  }
}

function commandError(error: unknown): Error {
  if (!(error instanceof Error)) {
    throw error;
  }
  return error;
}

const manualReviewedCodexSeccompProfileSha256 =
  "71a2871a066a696a171049a15db3f065122c153cd11ef451cee3341ddbd9697f";
const reviewedCodexSeccompProfileFilePattern =
  /^codex-(0\.164\.0|0\.163\.0-alpha\.2)-([a-f0-9]{64})\.json$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ciPreparedCodexSeccompProfile(ciStatePath: string | undefined) {
  if (ciStatePath === undefined || ciStatePath.length === 0) {
    return undefined;
  }
  let state: unknown;
  try {
    state = JSON.parse(await readFile(ciStatePath, "utf8"));
  } catch (error) {
    throw new Error(
      `OPENCLAW_ENTERPRISE_CI_STATE must name readable CI preparation state for OCC_TEST_CODEX_SECCOMP_PROFILE: ${commandError(error).message}`,
      { cause: error },
    );
  }
  const resources: readonly unknown[] =
    isRecord(state) && Array.isArray(state.resources) ? state.resources : [];
  const cluster = resources.find(
    (resource) =>
      isRecord(resource) && resource.kind === "k3d-cluster" && resource.codexDockerSeccompProfile,
  );
  const prepared = isRecord(cluster) ? cluster.codexDockerSeccompProfile : undefined;
  const path = isRecord(prepared) ? prepared.path : undefined;
  assert.ok(
    typeof path === "string",
    "OPENCLAW_ENTERPRISE_CI_STATE must record cluster.codexDockerSeccompProfile.path.",
  );
  const sha256 = isRecord(prepared) ? prepared.sha256 : undefined;
  assert.ok(
    typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256),
    "OPENCLAW_ENTERPRISE_CI_STATE must record cluster.codexDockerSeccompProfile.sha256.",
  );
  return { path, sha256 };
}

// Docker security options for a case that runs the stock Codex sandbox. Only
// the CI lanes whose manifest lists OCC_TEST_CODEX_SECCOMP_PROFILE in
// requiredEnv prepare the reviewed profile (prepare.codexSeccomp). In CI, or
// whenever CI preparation state is present, a missing profile is an error: a
// case that calls this from a lane without the profile fails instead of
// running unconfined or skipping. Local runs without CI keep Docker's default
// seccomp profile.
type ReviewedCodexSeccompOptions = {
  profile?: string | undefined;
  ciStatePath?: string | undefined;
  ci?: string | undefined;
  codexVersion?: string | undefined;
};

export async function reviewedCodexSeccompSecurityOptions({
  profile = process.env.OCC_TEST_CODEX_SECCOMP_PROFILE,
  ciStatePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE,
  ci = process.env.CI,
  codexVersion = "0.164.0",
}: ReviewedCodexSeccompOptions = {}): Promise<string[]> {
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

  let contents: Buffer;
  try {
    contents = await readFile(profile);
  } catch (error) {
    throw new Error(
      `OCC_TEST_CODEX_SECCOMP_PROFILE must name a readable Codex seccomp profile: ${commandError(error).message}`,
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

export function assertGatewayLogEntry<Entry>(
  entries: readonly Entry[],
  predicate: (entry: Entry, index: number, entries: readonly Entry[]) => boolean,
  description: string,
): void {
  const found = entries.some(predicate);
  const recent = entries
    .filter(
      (entry): entry is Entry & Record<string, unknown> =>
        isRecord(entry) && entry.subsystem === "gateway",
    )
    .map(({ level, message }) => `${level}: ${message}`)
    .slice(-8)
    .join("\n");
  assert.ok(found, `${description}\nRecent gateway logs:\n${recent}`);
}
