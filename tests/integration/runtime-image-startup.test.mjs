import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  GATEWAY_STOP_TIMEOUT_MS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
  REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/repository-material-init.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import { codexOpenClawConfiguration } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";

const execute = promisify(execFile);
const docker = process.env.OCC_DOCKER_BIN ?? "docker";
const image = process.env.OCC_TEST_RUNTIME_IMAGE;
const runtimeImageModel = defaultAgentModel;
const syntheticCodexApiKey = "sk-openclaw-runtime-image-smoke-synthetic";
const manualReviewedCodexSeccompProfileSha256 =
  "71a2871a066a696a171049a15db3f065122c153cd11ef451cee3341ddbd9697f";
const reviewedCodexSeccompProfileFilePattern = /^codex-0\.156\.0-([a-f0-9]{64})\.json$/;
const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_IMAGE to a locally built OpenClaw runtime image tag.",
      }
    : {};

test("runtime image seccomp option requires the CI-prepared profile record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-seccomp-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = Buffer.from(`${JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO" })}\n`);
  const digest = createHash("sha256").update(contents).digest("hex");
  const profile = join(directory, `codex-0.156.0-${digest}.json`);
  const statePath = join(directory, "state.json");
  await writeFile(profile, contents);
  await writeFile(
    statePath,
    JSON.stringify({
      resources: [
        {
          kind: "k3d-cluster",
          codexDockerSeccompProfile: { path: profile, sha256: digest },
        },
      ],
    }),
  );

  assert.deepEqual(await reviewedCodexSeccompSecurityOptions({ profile, ciStatePath: statePath }), [
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${profile}`,
  ]);

  await assert.rejects(
    reviewedCodexSeccompSecurityOptions({ profile, ciStatePath: "" }),
    /must be prepared by images-packaging CI state/,
  );

  await writeFile(
    statePath,
    JSON.stringify({
      resources: [
        {
          kind: "k3d-cluster",
          codexDockerSeccompProfile: { path: join(directory, "other.json"), sha256: digest },
        },
      ],
    }),
  );
  await assert.rejects(
    reviewedCodexSeccompSecurityOptions({ profile, ciStatePath: statePath }),
    /must match the CI-prepared Codex seccomp profile path/,
  );

  await writeFile(
    statePath,
    JSON.stringify({
      resources: [
        {
          kind: "k3d-cluster",
          codexDockerSeccompProfile: { path: profile, sha256: "0".repeat(64) },
        },
      ],
    }),
  );
  await assert.rejects(
    reviewedCodexSeccompSecurityOptions({ profile, ciStatePath: statePath }),
    /must match the CI-prepared Codex seccomp profile digest/,
  );
});

test(
  "runtime image reaps descendants during workspace node and Codex restarts",
  imageTestOptions,
  async (t) => {
    const containerName = `oce-runtime-image-supervisor-${randomBytes(6).toString("hex")}`;
    t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
    // Run the same process proof inside the image, using the production init
    // command. Copy source over argv so this also works with a remote Docker engine.
    const paths = [
      "tests/conformance/workspace-node-supervisor.test.mjs",
      "apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
      "apps/controller/src/drivers/plugin/runtime-translator.ts",
    ];
    const files = await Promise.all(
      paths.map(async (path) => [
        path,
        await readFile(new URL(`../../${path}`, import.meta.url), "utf8"),
      ]),
    );
    const launch = String.raw`
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
for (const [relative, content] of JSON.parse(readFileSync(0, "utf8"))) {
  const target = join("/tmp/proof", relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const child = spawnSync(process.execPath, ["--test", "/tmp/proof/tests/conformance/workspace-node-supervisor.test.mjs"], { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`;
    const { stdout } = await runDocker(
      [
        "run",
        "-i",
        "--rm",
        "--name",
        containerName,
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--network",
        "none",
        "--tmpfs",
        "/tmp:size=64m,mode=1777",
        "--entrypoint",
        "/usr/bin/tini",
        image,
        "-s",
        "--",
        "node",
        "-e",
        launch,
      ],
      {},
      JSON.stringify(files),
    );
    assert.match(stdout, /pass 1/);
    assert.match(stdout, /skipped 0/);
  },
);

test(
  "runtime image initializes the Harness workspace without replacing owner edits",
  imageTestOptions,
  async () => {
    // Run the real Harness entrypoint and native setup. Replace only the long-lived
    // node/Codex bodies: this proves initialization order, not pairing or a model turn.
    const launch = String.raw`
const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const entrypoint = process.argv[1];
const sentinel = "Owner edit that must survive a Harness restart.\n";
for (let attempt = 0; attempt < 4; attempt++) {
  const bootstrap = attempt === 0 ? { skipBootstrap: true } : attempt === 3 ? { skipBootstrap: "invalid" } : {};
  const substitute = [
    'const cp = require("node:child_process");',
    'cp.spawn = () => {',
    'if (!JSON.parse(process.env.OPENCLAW_WORKSPACE_BOOTSTRAP).skipBootstrap) require("node:assert/strict").ok(require("node:fs").readFileSync("/home/node/workspace/AGENTS.md", "utf8").length > 0);',
    'console.log("WORKSPACE_CHILD_STARTED");',
    'return new (require("node:events").EventEmitter)();',
    '};',
    entrypoint,
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", substitute], {
    env: { PATH: process.env.PATH, HOME: "/home/node", OPENCLAW_NODE_STATE_DIR: "/tmp/node-state", OPENCLAW_NODE_SETUP_CODE: "synthetic-setup", OPENCLAW_WORKSPACE_BOOTSTRAP: JSON.stringify(bootstrap) },
    encoding: "utf8",
  });
  if (attempt === 3) {
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /WORKSPACE_CHILD_STARTED/);
    assert.match(result.stderr, /Workspace initialization failed/);
    continue;
  }
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(require("node:fs").readdirSync("/home/node/openclaw-runtime-assets/bundled-skills").length > 0);
  assert.ok(require("node:fs").statSync("/home/node/openclaw-runtime-assets/plugin-skills").isDirectory());
  assert.ok(require("node:fs").lstatSync("/home/node/.openclaw/plugin-skills").isSymbolicLink());
  assert.equal(
    require("node:fs").realpathSync("/home/node/.openclaw/plugin-skills"),
    require("node:fs").realpathSync("/home/node/openclaw-runtime-assets/plugin-skills"),
  );
  assert.match(
    require("node:fs").readFileSync("/home/node/.openclaw/plugin-skills/slack/SKILL.md", "utf8"),
    /name:\s*slack/,
  );
  assert.match(
    require("node:fs").readFileSync(
      "/home/node/.openclaw/plugin-skills/block-kit/references/official-block-kit.md",
      "utf8",
    ),
    /# Block Kit/,
  );
  assert.equal(result.stdout.split("WORKSPACE_CHILD_STARTED").length - 1, 2);
  if (attempt === 0) {
    assert.equal(existsSync("/home/node/workspace/AGENTS.md"), false);
    continue;
  }
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md"]) {
    assert.ok(readFileSync("/home/node/workspace/" + name, "utf8").length > 0);
  }
  if (attempt === 2) assert.equal(readFileSync("/home/node/workspace/AGENTS.md", "utf8"), sentinel);
  writeFileSync("/home/node/workspace/AGENTS.md", sentinel);
}
console.log("WORKSPACE_INITIALIZATION_PASSED");
`;
    const { stdout } = await runDocker(
      [
        "run",
        "--rm",
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--network",
        "none",
        "--tmpfs",
        "/tmp:size=64m,mode=1777",
        "--tmpfs",
        "/home/node:size=64m,uid=1000,gid=1000",
        "--tmpfs",
        "/home/node/workspace:size=16m,uid=1000,gid=1000",
        "--entrypoint",
        "/usr/bin/tini",
        image,
        "-s",
        "--",
        "node",
        "-e",
        launch,
        AGENT_WITH_NODE_ENTRYPOINT,
      ],
      { timeout: 120_000 * imageSmokeTimeoutMultiplier },
    );
    assert.match(stdout, /WORKSPACE_INITIALIZATION_PASSED/);
  },
);

async function runDocker(args, options = {}, input) {
  const command = execute(docker, args, {
    timeout: 60_000 * imageSmokeTimeoutMultiplier,
    maxBuffer: 1_000_000,
    ...options,
  });
  if (input === undefined) {
    return command;
  }
  const inputComplete = new Promise((resolve, reject) => {
    command.child.stdin.once("error", reject);
    command.child.stdin.end(input, resolve);
  });
  const [result] = await Promise.all([command, inputComplete]);
  return result;
}

const runtimeImageStockBrokerDiagnosticStages = new Set([
  "material-init",
  "native-git-init",
  "config-patch",
  "fixture-reachability",
  "initialize",
  "proxy-env",
  "broker-denial",
  "outside-home-read",
  "outside-home-shadow-write",
  "outside-home-read-after-shadow-write",
  "git-proof",
  "explicit-deny",
  "unrelated-private-host",
  "direct-private-host",
]);

function annotateRuntimeImageStockBrokerFailure(error) {
  const output = [error?.stderr, error?.stdout, error?.message]
    .filter((item) => typeof item === "string")
    .join("\n");
  const matches = [...output.matchAll(/^openclaw-ci-stock-broker-stage=([a-z-]+)$/gm)];
  const stage = matches.at(-1)?.[1];
  if (runtimeImageStockBrokerDiagnosticStages.has(stage)) {
    error.openclawCiDiagnostic = { kind: "runtime-image-stock-broker", stage };
  }
  return error;
}

async function removeDockerVolumes(volumeNames) {
  const removals = await Promise.allSettled(
    volumeNames.map((volumeName) => runDocker(["volume", "rm", "-f", volumeName])),
  );
  const failures = removals
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "failed to remove runtime image repository material volumes",
    );
  }
}

async function removeDockerContainer(containerName, priorFailure) {
  try {
    await runDocker(["rm", "-f", containerName]);
  } catch (cleanupError) {
    if (priorFailure !== undefined) {
      priorFailure.cleanupError = cleanupError;
      return;
    }
    throw cleanupError;
  }
}

async function populateRepositoryProjectionVolume(sourceRoot, volumeName, ownership) {
  const helperName = `${volumeName}-populate`;
  const script = [
    "set -eu",
    `find /projection -type d -exec chmod ${ownership.directoryMode} {} +`,
    `find /projection -type f -exec chmod ${ownership.fileMode} {} +`,
    `chown -R ${ownership.uid}:${ownership.gid} /projection`,
  ].join("\n");
  let failure;
  try {
    await runDocker([
      "create",
      "--name",
      helperName,
      "--user",
      "0:0",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${volumeName}:/projection`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      script,
    ]);
    await runDocker(["cp", `${sourceRoot}/.`, `${helperName}:/projection/`]);
    await runDocker(["start", "-a", helperName]);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await removeDockerContainer(helperName, failure);
  }
}

async function runRepositoryMaterialInitProbe(volumeName, descriptor) {
  const probe = `
const cp = require("node:child_process");
const material = cp.spawnSync(process.execPath, ["-e", ${JSON.stringify(REPOSITORY_MATERIAL_INIT_ENTRYPOINT)}, ${JSON.stringify(JSON.stringify(descriptor))}], {
  stdio: "inherit",
});
process.exit(material.status ?? 1);
`;
  await runDocker([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/run/oce:size=16m,uid=1000,gid=1000,mode=700",
    "-v",
    `${volumeName}:/source-repository-credentials:ro`,
    "--entrypoint",
    "node",
    image,
    "-e",
    probe,
  ]);
}

async function reserveTcpPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function createRuntimeBrokerTlsMaterial(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-broker-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=git.oce.svc",
    "-addext",
    "subjectAltName=DNS:git.oce.svc,DNS:unrelated.oce.svc,DNS:localhost,IP:127.0.0.1",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
  ]);
  await chmod(directory, 0o755);
  await chmod(join(directory, "key.pem"), 0o600);
  await chmod(join(directory, "cert.pem"), 0o644);
  const cert = await readFile(join(directory, "cert.pem"));
  return {
    key: await readFile(join(directory, "key.pem")),
    cert,
    ca: cert,
    keyFile: join(directory, "key.pem"),
    certFile: join(directory, "cert.pem"),
  };
}

function runtimeRepositorySessionDirectory(repositoryRef, sessionId) {
  return `/run/oce/repository-credentials/sessions/${createHash("sha256")
    .update(JSON.stringify([repositoryRef, sessionId]))
    .digest("hex")}`;
}

async function createRuntimeRepositoryMaterial(t, fixture) {
  const material = await createNativeClientMaterial(
    t,
    fixture.repositories
      .filter((entry) => entry.opened)
      .map((entry) => ({
        opened: entry.opened,
        repositoryRef: entry.repositoryRef,
        publicCa: fixture.tls.ca,
      })),
  );
  const manifestPath = join(material.root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.bindings = manifest.bindings.map((binding) => ({
    ...binding,
    directory: runtimeRepositorySessionDirectory(binding.repositoryRef, binding.sessionId),
  }));
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  return material.root;
}

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

async function reviewedCodexSeccompSecurityOptions({
  profile = process.env.OCC_TEST_CODEX_SECCOMP_PROFILE,
  ciStatePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE,
} = {}) {
  const securityOptions = ["--security-opt", "no-new-privileges"];
  if (profile === undefined || profile.length === 0) {
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
    "OCC_TEST_CODEX_SECCOMP_PROFILE must point to codex-0.156.0-<profile-sha256>.json.",
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
    `OCC_TEST_CODEX_SECCOMP_PROFILE digest ${actual} did not match the Codex 0.156.0 profile filename digest ${expected}.`,
  );

  const prepared = await ciPreparedCodexSeccompProfile(ciStatePath);
  if (prepared === undefined) {
    assert.equal(
      expected,
      manualReviewedCodexSeccompProfileSha256,
      "OCC_TEST_CODEX_SECCOMP_PROFILE must be prepared by images-packaging CI state or use the pinned manual reviewed Codex profile.",
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

async function waitForDockerLog(containerName, pattern) {
  const deadline = Date.now() + 20_000 * imageSmokeTimeoutMultiplier;
  let output = "";
  while (Date.now() < deadline) {
    const logs = await runDocker(["logs", containerName]).catch((error) => error);
    output = commandOutput(logs);
    if (pattern.test(output)) {
      return output;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${containerName} logs.
${output}`);
}

function commandOutput(error) {
  return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
}

function sanitizeSyntheticCredential(output) {
  return output.replaceAll(syntheticCodexApiKey, "[REDACTED_SYNTHETIC_KEY]");
}

function assertNoPackagingFailure(output) {
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/);
  assert.doesNotMatch(output, /ENOENT: no such file or directory/);
  assert.doesNotMatch(output, /TypeScript .* is not supported in strip-only mode/);
}

async function temporaryGatewayConfiguration(t, harnessId) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-image-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const path = join(directory, "openclaw.json");
  await writeFile(path, JSON.stringify(createAdmittedRuntimeImageConfiguration(harnessId)));
  return path;
}

function createRuntimeImageConfiguration(harnessId, providerModel, options = {}) {
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

function createAdmittedRuntimeImageConfiguration(harnessId, options = {}) {
  return admitLoggingConfiguration(
    createRuntimeImageConfiguration(harnessId, runtimeImageModel, options),
    "info",
  );
}

async function waitForGatewayReady(containerName) {
  let lastReadinessOutput = "";
  for (let attempt = 0; attempt < 60 * imageSmokeTimeoutMultiplier; attempt += 1) {
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

    const ready = await runDocker([
      "exec",
      containerName,
      "node",
      "-e",
      'fetch("http://127.0.0.1:8080/readyz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));',
    ]).catch((error) => {
      lastReadinessOutput = commandOutput(error);
      return undefined;
    });
    if (ready !== undefined) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway readiness timed out.${lastReadinessOutput}`);
}

async function listGatewayPlugins(containerName) {
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
    throw new Error(`OpenClaw plugin list output was not valid JSON.\n${stdout}`, {
      cause: error,
    });
  }
}

function jsonLogEntries(output) {
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

function gatewayLogDiagnostic(entries) {
  return entries
    .filter((entry) => entry.subsystem === "gateway")
    .map(({ level, message }) => `${level}: ${message}`)
    .slice(-8)
    .join("\n");
}

function assertGatewayLogEntry(entries, predicate, description) {
  assert.ok(
    entries.some(predicate),
    `${description}\nRecent gateway logs:\n${gatewayLogDiagnostic(entries)}`,
  );
}

function assertGatewayReadyLog(entries) {
  assertGatewayLogEntry(
    entries,
    (entry) =>
      entry.subsystem === "gateway" && entry.level === "info" && entry.message === "gateway ready",
    "runtime image must emit gateway ready at native info level",
  );
}

function assertGatewayModelLog(entries, modelReference) {
  assertGatewayLogEntry(
    entries,
    (entry) =>
      entry.subsystem === "gateway" &&
      entry.level === "info" &&
      entry.message.includes(`agent model: ${modelReference}`),
    `runtime image must emit ${modelReference} at native info level`,
  );
}

function assertBundledCodexPluginLoaded(pluginList) {
  const codexPlugin = assertBundledPluginLoaded(pluginList, "codex");
  assert.match(
    codexPlugin.source,
    /\/app\/node_modules\/openclaw\/dist\/extensions\/codex\/index\.js$/,
  );
  assert.equal(codexPlugin.dependencyStatus?.requiredInstalled, true);
  assert.deepEqual(codexPlugin.dependencyStatus?.missing, []);
}

function assertBundledSlackPluginLoaded(pluginList) {
  const slackPlugin = assertBundledPluginLoaded(pluginList, "slack");
  assert.match(
    slackPlugin.source,
    /\/app\/node_modules\/openclaw\/dist\/extensions\/slack\/index\.js$/,
  );
  assert.equal(slackPlugin.dependencyStatus?.requiredInstalled, true);
  assert.deepEqual(slackPlugin.dependencyStatus?.missing, []);
}

function assertBundledPluginLoaded(pluginList, pluginId) {
  const plugin = pluginList.plugins?.find((entry) => entry.id === pluginId);

  assert.ok(plugin, `${pluginId} plugin must be present in OpenClaw plugin discovery output`);
  assert.equal(plugin.origin, "bundled");
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.status, "loaded");
  return plugin;
}

async function assertCodexAppServerHandshake(containerName) {
  const { stdout } = await runDocker(
    [
      "exec",
      containerName,
      "node",
      "--input-type=module",
      "-e",
      `
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pluginDist = "/app/node_modules/openclaw/dist";
const sharedClientChunk = readdirSync(pluginDist).find((name) =>
  /^shared-client-.*\\.mjs$/.test(name)
);
if (sharedClientChunk === undefined) {
  throw new Error("Bundled Codex shared-client chunk was not found under " + pluginDist);
}

const sharedClientExports = await import(pathToFileURL(join(pluginDist, sharedClientChunk)));
const createIsolatedCodexAppServerClient = Object.values(sharedClientExports).find(
  (value) => typeof value === "function" && value.name === "createIsolatedCodexAppServerClient"
);
if (createIsolatedCodexAppServerClient === undefined) {
  throw new Error("Bundled Codex shared-client export did not expose createIsolatedCodexAppServerClient.");
}
const configChunk = readdirSync(pluginDist).find((name) => /^config-options-.*\\.mjs$/.test(name));
if (configChunk === undefined) {
  throw new Error("Bundled Codex config chunk was not found under " + pluginDist);
}
const configExports = await import(pathToFileURL(join(pluginDist, configChunk)));
const createCodexAppServerConfig = Object.values(configExports).find(
  (value) => typeof value === "function" && value.name === "createCodexAppServerConfig"
);
if (createCodexAppServerConfig === undefined) {
  throw new Error("Bundled Codex config export did not expose createCodexAppServerConfig.");
}
const { resolveProviderIdForAuth } = await import("openclaw/plugin-sdk/provider-auth-aliases");
const { resolveCodexAppServerRuntimeOptions } = createCodexAppServerConfig({ resolveProviderIdForAuth });
const versionOutput = execFileSync("codex", ["--version"], { encoding: "utf8" });
const installedVersion = versionOutput.match(/\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
if (installedVersion === undefined) {
  throw new Error("Unable to parse installed Codex version from: " + versionOutput);
}

const agentDir = mkdtempSync(join(tmpdir(), "openclaw-codex-agent-"));
const codexHome = join(agentDir, "codex-home");
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
const runtime = resolveCodexAppServerRuntimeOptions({
  env: {
    OPENCLAW_CODEX_APP_SERVER_BIN: "codex",
    OPENCLAW_CODEX_APP_SERVER_ARGS: "app-server --listen stdio://",
  },
});
const client = await createIsolatedCodexAppServerClient({
  agentDir,
  authProfileId: null,
  timeoutMs: ${10_000 * imageSmokeTimeoutMultiplier},
  startOptions: {
    ...runtime.start,
    env: {
      CODEX_HOME: codexHome,
      HOME: "/home/node",
    },
    clearEnv: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
  },
});

try {
  const serverVersion = client.getServerVersion();
  if (serverVersion !== installedVersion) {
    throw new Error(
      \`Codex app-server initialized as \${serverVersion}, but codex --version reported \${installedVersion}.\`
    );
  }
  process.stdout.write(JSON.stringify({ installedVersion, serverVersion }));
} finally {
  client.close();
}
`,
    ],
    { timeout: 20_000 * imageSmokeTimeoutMultiplier },
  );

  const result = JSON.parse(stdout);
  assert.equal(result.serverVersion, result.installedVersion);
}

async function runGatewaySmoke(t, harnessId, options = {}) {
  const {
    collectPlugins = harnessId === "codex",
    configuration = createAdmittedRuntimeImageConfiguration(harnessId, {
      enableSlack: harnessId === "openclaw",
    }),
    configurationPath,
    entrypoint = DOCKER_GATEWAY_RUNTIME_ENTRYPOINT,
    extraEnvironment = [],
    tmpfs = ["/home/node:size=1024m,uid=1000,gid=1000,mode=700"],
    volumes = [],
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
    "APP_SERVER_URL=ws://127.0.0.1:9",
    "APP_SERVER_TOKEN=openclaw-runtime-image-app-server-token",
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
    "none",
    ...volumes.flatMap((value) => ["--volume", value]),
    ...environment.flatMap((value) => ["-e", value]),
    "--entrypoint",
    "node",
    image,
    "-e",
    entrypoint,
  ]);

  try {
    await waitForGatewayReady(containerName);
    const pluginList = collectPlugins ? await listGatewayPlugins(containerName) : undefined;
    const logs = await runDocker(["logs", containerName]);
    return {
      containerName,
      logs: `${logs.stdout}\n${logs.stderr}`,
      pluginList,
    };
  } catch (error) {
    const logs = await runDocker(["logs", containerName]).catch((logsError) => logsError);
    throw new Error(`${error.message}\n${commandOutput(logs)}`, { cause: error });
  }
}

async function assertGatewayRuntimeAssets(containerName) {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "-e",
    `
const { lstatSync, readFileSync, readdirSync } = require("node:fs");
const appSkills = lstatSync("/app/skills");
if (!appSkills.isDirectory() || appSkills.isSymbolicLink()) {
  throw new Error("/app/skills must be a real directory in the runtime image.");
}
const bundled = readdirSync("/home/node/openclaw-runtime-assets/bundled-skills");
if (bundled.length === 0) {
  throw new Error("Kubernetes gateway entrypoint did not publish bundled skills.");
}
const plugin = lstatSync("/home/node/openclaw-runtime-assets/plugin-skills");
if (!plugin.isDirectory()) {
  throw new Error("Kubernetes gateway entrypoint did not publish plugin skills directory.");
}
const slack = lstatSync("/home/node/openclaw-runtime-assets/plugin-skills/slack/SKILL.md");
if (!slack.isFile()) {
  throw new Error("Kubernetes gateway entrypoint did not publish Slack plugin skills.");
}
if (!/name:\\s*slack/.test(readFileSync("/home/node/openclaw-runtime-assets/plugin-skills/slack/SKILL.md", "utf8"))) {
  throw new Error("Kubernetes gateway entrypoint cannot read Slack Skill.md from runtime assets.");
}
if (!/# Block Kit/.test(readFileSync("/home/node/openclaw-runtime-assets/plugin-skills/block-kit/references/official-block-kit.md", "utf8"))) {
  throw new Error("Kubernetes gateway entrypoint cannot read packaged relative plugin skill files.");
}
process.stdout.write(JSON.stringify({ bundledCount: bundled.length, slackSkill: true }));
`,
  ]);

  assert.ok(JSON.parse(stdout).bundledCount > 0);
}

test(
  "runtime image applies Dedicated repository policy to native Codex command execution",
  imageTestOptions,
  async () => {
    // Substitute only authentication results and the app-server transport. The emitted
    // startup computes native settings; the image's actual Codex executes the shell.
    // Docker supplies isolation; this offline check proves no model turn or provider access.
    const probe = `
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const vm = require("node:vm");
const fs = require("node:fs");
const { createInterface } = require("node:readline");
const environment = {
  PATH: "/opt/oce/repository-credentials/bin:" + process.env.PATH,
  HOME: "/home/node", CODEX_HOME: "/home/node/.codex",
  CODEX_LOGIN_MODE: "api_key", OPENAI_API_KEY: "synthetic-offline-key",
  OPENCLAW_HARNESS_MODEL: "codex/gpt-5",
  APP_SERVER_TOKEN: "synthetic-transport-token", APP_SERVER_PORT: "4500",
};
let native;
vm.runInNewContext(${JSON.stringify(AGENT_RUNTIME_ENTRYPOINT)}, {
  URL, console, setTimeout, setInterval,
  process: { env: environment, on() {}, exit() {} },
  require(name) {
    if (name !== "node:child_process") return require(name);
    return {
      spawnSync(_command, args) {
        return args.includes("login") ? { status: 0 } : {
          status: 0,
          stdout: [
            { type: "turn.started" },
            { type: "item.completed", item: { type: "agent_message", text: "READY" } },
            { type: "turn.completed" },
          ].map(JSON.stringify).join("\\n"),
        };
      },
      spawn(command, args, options) {
        const appServer = args.indexOf("app-server");
        assert.ok(appServer > 0);
        native = cp.spawn(command, [...args.slice(0, appServer + 1), "--listen", "stdio://"], {
          ...options, env: environment, stdio: ["pipe", "pipe", "pipe"],
        });
        return native;
      },
    };
  },
});
assert.ok(native);
const pending = new Map();
let nextId = 1;
const lines = createInterface({ input: native.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  }
});
native.stderr.resume();
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  native.stdin.write(JSON.stringify({ id, method, params }) + "\\n");
});
const timeout = setTimeout(() => { native.kill("SIGKILL"); process.exitCode = 1; }, 20000);
(async () => {
  try {
    await rpc("initialize", { clientInfo: { name: "repository-runtime-smoke", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    native.stdin.write(JSON.stringify({ method: "initialized" }) + "\\n");
    const { config } = await rpc("config/read", {});
    assert.equal(config.allow_login_shell, false);
    assert.equal(config.shell_environment_policy.set.PATH, environment.PATH);
    const result = await rpc("command/exec", {
      command: ["/bin/bash", "-c", "command -v gh; command -v git; git config --system --get-all include.path"],
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout.trim().split("\\n"), [
      "/opt/oce/repository-credentials/bin/gh", "/usr/bin/git", "/run/oce/repository-credentials/gitconfig",
    ]);
    fs.accessSync("/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/router.js");
    process.stdout.write("native-repository-shell-ready\\n");
  } finally {
    clearTimeout(timeout);
    lines.close();
    native.kill("SIGTERM");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
    const { stdout } = await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/home/node:size=128m,uid=1000,gid=1000,mode=700",
      "--tmpfs",
      "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
      "--entrypoint",
      "node",
      image,
      "-e",
      probe,
    ]);
    assert.match(stdout, /native-repository-shell-ready/);
  },
);

test(
  "runtime image gateway ignores inherited OPENCLAW_LOG_LEVEL in favor of native configuration",
  imageTestOptions,
  async (t) => {
    const configuration = createAdmittedRuntimeImageConfiguration("openclaw", {
      enableSlack: true,
    });

    const { logs } = await runGatewaySmoke(t, "openclaw", {
      collectPlugins: false,
      configuration,
      extraEnvironment: ["OPENCLAW_LOG_LEVEL=error"],
    });

    const entries = jsonLogEntries(logs);
    assertGatewayReadyLog(entries);
    assertGatewayModelLog(entries, `openai/${runtimeImageModel}`);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image starts an embedded OpenClaw gateway with the Docker driver entrypoint",
  imageTestOptions,
  async (t) => {
    const { logs, pluginList } = await runGatewaySmoke(t, "openclaw", {
      collectPlugins: true,
      configuration: createAdmittedRuntimeImageConfiguration("openclaw", {
        enableSlack: true,
      }),
    });

    const entries = jsonLogEntries(logs);
    assertGatewayReadyLog(entries);
    assertGatewayModelLog(entries, `openai/${runtimeImageModel}`);
    assertBundledSlackPluginLoaded(pluginList);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image discovers the bundled Codex plugin from a fresh gateway home",
  imageTestOptions,
  async (t) => {
    const { logs, containerName, pluginList } = await runGatewaySmoke(t, "codex");

    const entries = jsonLogEntries(logs);
    assertGatewayReadyLog(entries);
    assertGatewayModelLog(entries, `codex/${runtimeImageModel}`);
    assertBundledCodexPluginLoaded(pluginList);
    await assertCodexAppServerHandshake(containerName);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image keeps Codex auth writable with a nested generated images mount",
  imageTestOptions,
  async (t) => {
    const containerName = `oce-runtime-image-codex-auth-${randomBytes(6).toString("hex")}`;
    t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));

    const probe = String.raw`
set -eu
printf "%s\n" "$SYNTHETIC_CODEX_API_KEY" | timeout ${20 * imageSmokeTimeoutMultiplier}s codex login --with-api-key >/tmp/codex-login.stdout 2>/tmp/codex-login.stderr || {
  sed -E "s/sk-[A-Za-z0-9_-]+/[REDACTED_SYNTHETIC_KEY]/g" /tmp/codex-login.stderr >&2
  exit 1
}
node - <<'NODE'
const { accessSync, constants, statSync } = require("node:fs");
function entry(path) {
  const stat = statSync(path);
  return {
    uid: stat.uid,
    gid: stat.gid,
    mode: (stat.mode & 0o777).toString(8),
    directory: stat.isDirectory(),
    file: stat.isFile(),
  };
}
accessSync("/home/node/.codex", constants.W_OK);
accessSync("/home/node/.codex/generated_images", constants.W_OK);
process.stdout.write(JSON.stringify({
  uid: process.getuid(),
  gid: process.getgid(),
  codexHome: entry("/home/node/.codex"),
  generatedImages: entry("/home/node/.codex/generated_images"),
  authJson: entry("/home/node/.codex/auth.json"),
}));
NODE
`;

    const { stdout } = await runDocker(
      [
        "run",
        "--rm",
        "--name",
        containerName,
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/home/node/.codex/generated_images:size=64m,uid=1000,gid=1000,mode=700",
        "--tmpfs",
        "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
        "--network",
        "none",
        "-e",
        "HOME=/home/node",
        "-e",
        "CODEX_HOME=/home/node/.codex",
        "-e",
        `SYNTHETIC_CODEX_API_KEY=${syntheticCodexApiKey}`,
        "--entrypoint",
        "sh",
        image,
        "-c",
        probe,
      ],
      { timeout: 30_000 * imageSmokeTimeoutMultiplier },
    ).catch((error) => {
      throw new Error(sanitizeSyntheticCredential(commandOutput(error)));
    });

    const result = JSON.parse(stdout);
    assert.equal(result.uid, 1000);
    assert.equal(result.gid, 1000);
    assert.deepEqual(result.codexHome, {
      uid: 1000,
      gid: 1000,
      mode: "700",
      directory: true,
      file: false,
    });
    assert.deepEqual(result.generatedImages, {
      uid: 1000,
      gid: 1000,
      mode: "700",
      directory: true,
      file: false,
    });
    assert.deepEqual(result.authJson, {
      uid: 1000,
      gid: 1000,
      mode: "600",
      directory: false,
      file: true,
    });
  },
);

test(
  "runtime image publishes dedicated assets with the Kubernetes gateway entrypoint",
  imageTestOptions,
  async (t) => {
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { logs, containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      extraEnvironment: ["OPENCLAW_WORKSPACE_DIR=/home/node/workspace", "OPENCLAW_LOG_LEVEL=error"],
      tmpfs: [
        "/home/node:size=1024m,uid=1000,gid=1000,mode=700",
        "/home/node/workspace:size=1024m,uid=1000,gid=1000,mode=700",
      ],
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });

    const entries = jsonLogEntries(logs);
    assertGatewayReadyLog(entries);
    assertGatewayModelLog(entries, `codex/${runtimeImageModel}`);
    await assertGatewayRuntimeAssets(containerName);
    const { stdout } = await runDocker([
      "exec",
      containerName,
      "node",
      "--input-type=module",
      "-e",
      'import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "/app/node_modules/openclaw/gateway-shutdown-budget.mjs"; console.log(GATEWAY_SERVICE_STOP_TIMEOUT_MS);',
    ]);
    const runtimeStopTimeoutMs = Number(stdout.trim());
    assert.ok(runtimeStopTimeoutMs > 0 && runtimeStopTimeoutMs <= GATEWAY_STOP_TIMEOUT_MS);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image enrolls the restricted workspace node and reconnects with saved credentials",
  imageTestOptions,
  async (t) => {
    // The Kubernetes entrypoint admits the workspace command grant before pairing.
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });
    const source = await readFile(
      new URL("../fixtures/runtime-workspace-node.mjs", import.meta.url),
      "utf8",
    );
    const { stdout } = await runDocker(
      ["exec", containerName, "node", "--input-type=module", "-e", source],
      { timeout: 240_000 * imageSmokeTimeoutMultiplier },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.sameIdentityAfterRestart, true);
    assert.equal(result.singleBootstrapCompletion, true);
    assert.equal(result.commands.length, 7);
  },
);

test(
  "runtime image routes sandboxed Git through stock Codex and the repository broker",
  imageTestOptions,
  async (t) => {
    const suffix = randomBytes(6).toString("hex");
    const networkName = `oce-runtime-broker-${suffix}`;
    const proxyName = `oce-runtime-broker-proxy-${suffix}`;
    const materialVolumeName = `oce-runtime-broker-material-${suffix}`;
    const deniedMaterialVolumeName = `oce-runtime-broker-material-denied-${suffix}`;
    const workspaceBranch = "native-feature";
    const tls = await createRuntimeBrokerTlsMaterial(t);
    const listenPort = await reserveTcpPort();
    const fixture = await startRegistryCredentialServiceFixture(t, {
      tls,
      autoOpen: false,
      gateway: { publicOrigin: "https://git.oce.svc", listen: `0.0.0.0:${listenPort}` },
      repositories: [
        {
          repositoryRef: "guarded",
          repositoryId: "73",
          repository: "fixture/repository",
          pushRefAllowlist: [`refs/heads/${workspaceBranch}`],
        },
        {
          repositoryRef: "read-only",
          repositoryId: "74",
          repository: "fixture/read-only",
          profile: "git-read",
        },
        {
          repositoryRef: "unadmitted",
          repositoryId: "75",
          repository: "fixture/unadmitted",
        },
      ],
    });
    await fixture.open("guarded");
    await fixture.open("read-only");
    const unadmitted = fixture.byRef.get("unadmitted");
    // The fixture counts attempts before authorization, including rejected
    // provider tokens; confirm the target is reachable before asserting none.
    const reachability = await execute("curl", [
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--cacert",
      tls.certFile,
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      `${unadmitted.git.origin}/fixture/unadmitted.git/info/refs?service=git-upload-pack`,
    ]);
    assert.equal(reachability.stdout, "401");
    const unadmittedAttempts = unadmitted.github.authenticationAttempts.filter(
      ({ boundary }) => boundary === "git",
    ).length;
    assert.equal(unadmittedAttempts, 1);
    const materialRoot = await createRuntimeRepositoryMaterial(t, fixture);
    t.after(async () => {
      await runDocker(["rm", "-f", proxyName]).catch(() => {});
      await runDocker(["network", "rm", networkName]).catch(() => {});
      await removeDockerVolumes([materialVolumeName, deniedMaterialVolumeName]);
    });

    const descriptor = {
      sourceRoot: "/source-repository-credentials/sessions",
      targetRoot: "/run/oce/repository-credentials",
      manifest: JSON.parse(await readFile(join(materialRoot, "manifest.json"), "utf8")),
    };
    await runDocker(["volume", "create", materialVolumeName]);
    await runDocker(["volume", "create", deniedMaterialVolumeName]);
    await populateRepositoryProjectionVolume(materialRoot, deniedMaterialVolumeName, {
      uid: 1001,
      gid: 1001,
      directoryMode: "700",
      fileMode: "600",
    });
    await populateRepositoryProjectionVolume(materialRoot, materialVolumeName, {
      uid: 0,
      gid: 1000,
      directoryMode: "550",
      fileMode: "440",
    });
    const deniedReadProbe = String.raw`
const fs = require("node:fs");
try {
  fs.readdirSync("/source-repository-credentials/sessions");
  process.exit(42);
} catch (error) {
  if (error.code !== "EACCES") throw error;
}
`;
    await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${deniedMaterialVolumeName}:/source-repository-credentials:ro`,
      "--entrypoint",
      "node",
      image,
      "-e",
      deniedReadProbe,
    ]);
    await assert.rejects(runRepositoryMaterialInitProbe(deniedMaterialVolumeName, descriptor));
    await runRepositoryMaterialInitProbe(materialVolumeName, descriptor);

    await runDocker(["network", "create", "--driver", "bridge", networkName]);
    const forwarder = String.raw`
const net = require("node:net");
const targetHost = process.argv[1];
const targetPort = Number(process.argv[2]);
const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, targetHost);
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream).pipe(client);
});
server.listen(443, "0.0.0.0", () => console.log("broker-forwarder-ready"));
`;
    await runDocker([
      "run",
      "-d",
      "--name",
      proxyName,
      "--network",
      networkName,
      "--network-alias",
      "git.oce.svc",
      "--network-alias",
      "unrelated.oce.svc",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--user",
      "0:0",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_BIND_SERVICE",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:size=32m,mode=1777",
      "--entrypoint",
      "node",
      image,
      "-e",
      forwarder,
      "host.docker.internal",
      String(listenPort),
    ]);
    await waitForDockerLog(proxyName, /broker-forwarder-ready/);

    const brokerCodexConfiguration = codexOpenClawConfiguration({}, [], {
      host: "git.oce.svc",
      domains: {},
    }).plugins.entries.codex.config;
    const pluginRuntime = {
      manifest: { kind: "codex", selections: {} },
      brokerCodexConfiguration,
    };
    const proxyEnvironmentProbe = [
      "node <<'NODE'",
      'const assert = require("node:assert/strict");',
      "const env = process.env;",
      'assert.equal(env.CODEX_NETWORK_PROXY_ACTIVE, "1");',
      'assert.equal(env.CODEX_NETWORK_ALLOW_LOCAL_BINDING, "1");',
      "assert.ok(env.HTTP_PROXY || env.HTTPS_PROXY || env.ALL_PROXY || env.http_proxy || env.https_proxy || env.all_proxy);",
      'const noProxy = [env.NO_PROXY, env.no_proxy].filter(Boolean).join(",");',
      'assert.equal(noProxy.split(",").map((item) => item.trim()).includes("git.oce.svc"), false);',
      'console.log("proxy-env-ok");',
      "NODE",
    ].join("\n");
    const gitProofScript = [
      "mkdir -p /home/node/workspace",
      "cd /home/node/workspace",
      "git clone https://github.com/fixture/repository.git guarded",
      "git -C guarded fetch origin refs/heads/existing-branch:refs/remotes/origin/fetched-fixture",
      "git -C guarded rev-parse --verify refs/remotes/origin/fetched-fixture",
      `git -C guarded switch -c ${workspaceBranch}`,
      "printf 'stock runtime broker proof\n' > guarded/stock-proof.txt",
      "git -C guarded add stock-proof.txt",
      "git -C guarded -c user.name='Runtime Fixture' -c user.email='fixture@example.test' commit -m 'Stock runtime broker proof'",
      "commit=$(git -C guarded rev-parse HEAD)",
      `git -C guarded push origin HEAD:refs/heads/${workspaceBranch}`,
      // A push outside the admitted ref must be rejected by the installed hook.
      "set +e",
      "disallowed_output=$(git -C guarded push origin HEAD:refs/heads/disallowed 2>&1)",
      "disallowed_status=$?",
      "set -e",
      'test "$disallowed_status" -ne 0',
      "printf '%s\\n' \"$disallowed_output\" | grep -Fq 'repository-push-ref-not-allowed'",
      "git clone https://github.com/fixture/read-only.git read-only",
      "git -C read-only switch -c denied",
      "printf 'denied proof\n' > read-only/denied-proof.txt",
      "git -C read-only add denied-proof.txt",
      "git -C read-only -c user.name='Runtime Fixture' -c user.email='fixture@example.test' commit -m 'Denied runtime broker proof'",
      "set +e",
      "readonly_output=$(git -C read-only push origin HEAD:refs/heads/denied 2>&1)",
      "readonly_status=$?",
      "set -e",
      "printf '%s\\n' \"$readonly_output\"",
      'test "$readonly_status" -ne 0',
      "printf '%s\\n' \"$readonly_output\" | grep -Fq 'requested URL returned error: 400'",
      "set +e",
      "unadmitted_output=$(git ls-remote https://github.com/fixture/unadmitted.git HEAD 2>&1)",
      "unadmitted_status=$?",
      "set -e",
      "printf '%s\\n' \"$unadmitted_output\"",
      'test "$unadmitted_status" -ne 0',
      "printf '%s\\n' \"$unadmitted_output\" | grep -Fq 'credential-helper-failed'",
      "printf 'commit=%s\\n' \"$commit\"",
    ].join("\n");
    // Ask the real broker for its service-owned denial codes without printing
    // the session credential returned by the installed Git helper.
    const brokerDenialProbe = String.raw`node <<'NODE'
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const credentials = cp.spawnSync("git", ["credential", "fill"], {
  input: "protocol=https\nhost=git.oce.svc\npath=fixture/read-only.git\n\n",
  encoding: "utf8",
});
assert.equal(credentials.status, 0, "native credential helper failed");
const username = credentials.stdout.match(/^username=([^\n]+)$/m)?.[1];
const password = credentials.stdout.match(/^password=([^\n]+)$/m)?.[1];
assert.equal(/^[A-Za-z0-9_-]+$/.test(username ?? ""), true, "invalid fixture username");
assert.equal(/^[A-Za-z0-9_-]+$/.test(password ?? ""), true, "invalid fixture credential");
function request(path, auth) {
  const config = auth ? 'user = "' + username + ':' + password + '"\n' : "";
  const result = cp.spawnSync("curl", ["--silent", "--show-error", "--config", "-", "--write-out", "\n%{http_code}", "https://git.oce.svc/" + path], { input: config, encoding: "utf8" });
  assert.equal(result.status, 0, "broker request failed");
  return result.stdout;
}
const allowed = request("fixture/read-only.git/info/refs?service=git-upload-pack", true);
assert.equal(allowed.endsWith("\n200") && allowed.includes("# service=git-upload-pack"), true, "admitted discovery did not succeed");
assert.equal(request("fixture/read-only.git/info/refs?service=git-receive-pack", true) === '{"error":{"code":"unsupported-request"}}\n400', true, "read-only broker denial did not match");
assert.equal(request("fixture/unadmitted.git/info/refs?service=git-upload-pack", true) === '{"error":{"code":"unsupported-request"}}\n400', true, "unadmitted broker denial did not match");
console.log("broker-denial-codes-confirmed");
NODE`;
    const probeSecurityOptions = await reviewedCodexSeccompSecurityOptions();
    const probe = `
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const vm = require("node:vm");
const { createInterface } = require("node:readline");
function markStockBrokerStage(stage) {
  console.error("openclaw-ci-stock-broker-stage=" + stage);
}
markStockBrokerStage("material-init");
const material = cp.spawnSync(process.execPath, ["-e", ${JSON.stringify(REPOSITORY_MATERIAL_INIT_ENTRYPOINT)}, ${JSON.stringify(JSON.stringify(descriptor))}], {
  stdio: "inherit",
});
assert.equal(material.status, 0, "repository material initialization failed");
markStockBrokerStage("native-git-init");
const preparation = cp.spawnSync(process.execPath, ["-e", ${JSON.stringify(REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT)}, "/run/oce/repository-credentials"], {
  stdio: "inherit",
});
assert.equal(preparation.status, 0, "repository native Git initialization failed");
assert.ok(fs.readFileSync("/run/oce/repository-credentials/gitconfig", "utf8").includes("/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/git-helper.js"));
const brokerCaBundle = fs.readdirSync("/run/oce/repository-credentials/sessions")
  .map((name) => "/run/oce/repository-credentials/sessions/" + name + "/ca-bundle.pem")
  .find((filename) => fs.existsSync(filename));
assert.ok(brokerCaBundle, "repository material initialization must project a broker CA bundle");
assert.ok(fs.readFileSync(brokerCaBundle, "utf8").includes("BEGIN CERTIFICATE"));
const environment = {
  PATH: "/opt/oce/repository-credentials/bin:" + process.env.PATH,
  HOME: "/home/node", CODEX_HOME: "/home/node/.codex",
  CODEX_LOGIN_MODE: "api_key", OPENAI_API_KEY: "synthetic-offline-key",
  OPENCLAW_HARNESS_MODEL: "codex/gpt-5",
  APP_SERVER_TOKEN: "synthetic-transport-token", APP_SERVER_PORT: "4500",
  SSL_CERT_FILE: brokerCaBundle,
  GIT_SSL_CAINFO: brokerCaBundle,
  REQUESTS_CA_BUNDLE: brokerCaBundle,
  CURL_CA_BUNDLE: brokerCaBundle,
  NODE_EXTRA_CA_CERTS: brokerCaBundle,
};
const configPatchProbe = [
  'import { readFileSync, readdirSync } from "node:fs";',
  'import { join } from "node:path";',
  'import { pathToFileURL } from "node:url";',
  'const runtime = JSON.parse(readFileSync(0, "utf8"));',
  'const pluginDist = "/app/node_modules/openclaw/dist";',
  'const configChunk = readdirSync(pluginDist).find((name) => /^config-options-.*\\.mjs$/.test(name));',
  'if (configChunk === undefined) throw new Error("Bundled Codex config chunk was not found under " + pluginDist);',
  'const configExports = await import(pathToFileURL(join(pluginDist, configChunk)));',
  'const createCodexAppServerConfig = Object.values(configExports).find((value) => typeof value === "function" && value.name === "createCodexAppServerConfig");',
  'if (createCodexAppServerConfig === undefined) throw new Error("Bundled Codex config export did not expose createCodexAppServerConfig.");',
  'const { resolveProviderIdForAuth } = await import("openclaw/plugin-sdk/provider-auth-aliases");',
  'const { resolveCodexAppServerRuntimeOptions } = createCodexAppServerConfig({ resolveProviderIdForAuth });',
  'const allowPatch = resolveCodexAppServerRuntimeOptions({ pluginConfig: runtime.brokerCodexConfiguration }).networkProxy?.configPatch;',
  'if (allowPatch === undefined) throw new Error("Codex network proxy config patch was not generated.");',
  'process.stdout.write(JSON.stringify({ allowPatch }));',
].join("\\n");
const runtimeForConfig = ${JSON.stringify(pluginRuntime)};
markStockBrokerStage("config-patch");
const configPatchResult = cp.spawnSync(process.execPath, ["--input-type=module", "-e", configPatchProbe], {
  input: JSON.stringify(runtimeForConfig),
  encoding: "utf8",
});
assert.equal(configPatchResult.status, 0, configPatchResult.stderr);
const { allowPatch } = JSON.parse(configPatchResult.stdout);
const brokerPermissionProfile = allowPatch.default_permissions;
const deniedPermissionProfile = brokerPermissionProfile + "-denied";
const configPatch = JSON.parse(JSON.stringify(allowPatch));
configPatch.permissions[deniedPermissionProfile] = JSON.parse(JSON.stringify(configPatch.permissions[brokerPermissionProfile]));
configPatch.permissions[deniedPermissionProfile].network.domains = { "git.oce.svc": "deny" };
function tomlValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(tomlValue).join(", ") + "]";
  return JSON.stringify(value);
}
function isTomlTable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function tomlPathKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}
function tomlAssignmentKey(key, topLevel) {
  return topLevel && /^[A-Za-z0-9_.-]+$/.test(key) ? key : tomlPathKey(key);
}
function renderTomlTable(path, value) {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const scalarEntries = entries.filter(([, item]) => !isTomlTable(item));
  const tableEntries = entries.filter(([, item]) => isTomlTable(item));
  const lines = [];
  if (path.length > 0 && scalarEntries.length > 0) lines.push("[" + path.map(tomlPathKey).join(".") + "]");
  for (const [key, item] of scalarEntries) {
    lines.push(tomlAssignmentKey(key, path.length === 0) + " = " + tomlValue(item));
  }
  for (const [key, item] of tableEntries) {
    if (lines.length > 0) lines.push("");
    lines.push(renderTomlTable([...path, key], item));
  }
  return lines.join("\\n");
}
function codexConfigPatchToml(patch) {
  return renderTomlTable([], patch) + "\\n";
}
environment.OPENCLAW_PLUGIN_RUNTIME_JSON = JSON.stringify({
  manifest: runtimeForConfig.manifest,
  codexConfigurationToml: codexConfigPatchToml(configPatch),
});
const homeControlSentinelPath = "/home/node/openclaw-stock-codex-control-sentinel.txt";
const homeControlSentinel = "synthetic-openclaw-control-sentinel\\n";
fs.writeFileSync(homeControlSentinelPath, homeControlSentinel, { mode: 0o600 });
assert.equal(fs.readFileSync(homeControlSentinelPath, "utf8"), homeControlSentinel);
let native;
vm.runInNewContext(${JSON.stringify(AGENT_RUNTIME_ENTRYPOINT)}, {
  URL, console, setTimeout, setInterval,
  process: { env: environment, on() {}, exit() {} },
  require(name) {
    if (name !== "node:child_process") return require(name);
    return {
      spawnSync(_command, args) {
        return args.includes("login") ? { status: 0 } : {
          status: 0,
          stdout: [
            { type: "turn.started" },
            { type: "item.completed", item: { type: "agent_message", text: "READY" } },
            { type: "turn.completed" },
          ].map(JSON.stringify).join("\\n"),
        };
      },
      spawn(command, args, options) {
        const appServer = args.indexOf("app-server");
        assert.ok(appServer > 0);
        native = cp.spawn(command, [...args.slice(0, appServer + 1), "--listen", "stdio://"], {
          ...options, env: environment, stdio: ["pipe", "pipe", "pipe"],
        });
        return native;
      },
    };
  },
});
assert.ok(native);
const pending = new Map();
let nextId = 1;
const lines = createInterface({ input: native.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  }
});
let stderr = "";
native.stderr.on("data", (chunk) => { stderr += chunk; });
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  native.stdin.write(JSON.stringify({ id, method, params }) + "\\n");
});
async function execShell(script, permissionProfile = brokerPermissionProfile, timeoutMs = 30000) {
  try {
    return await rpc("command/exec", {
      command: ["/bin/bash", "-euo", "pipefail", "-c", script],
      permissionProfile,
      timeoutMs,
    });
  } catch (error) {
    throw new Error("subprobe " + permissionProfile + " failed for script: " + script.slice(0, 240) + "\\n" + error.message + "\\napp-server stderr:\\n" + stderr.slice(-4000), { cause: error });
  }
}
async function expectFailure(name, script, pattern, permissionProfile = brokerPermissionProfile) {
  const failureProbe = [
    "set +e",
    "output=$({",
    script,
    "} 2>&1)",
    "status=$?",
    "set -e",
    ${JSON.stringify("printf '%s\n' \"$output\"")},
    ${JSON.stringify('if [ "$status" -eq 0 ]; then exit 42; fi')},
    ${JSON.stringify("printf '%s\n' \"$output\" | grep -Eiq ")} + JSON.stringify(pattern),
  ].join("\\n");
  const denied = await execShell(failureProbe, permissionProfile);
  assert.equal(denied.exitCode, 0, name + " did not fail for the expected reason: " + denied.stdout + denied.stderr);
}
const timeout = setTimeout(() => {
  console.error(stderr);
  native.kill("SIGKILL");
  process.exitCode = 1;
}, 90000);
(async () => {
  try {
    // Resolve and reach the fixture outside Codex first, so the direct-bypass
    // assertion cannot pass merely because sandboxed DNS is unavailable.
    markStockBrokerStage("fixture-reachability");
    const unrelatedAddress = (await require("node:dns/promises").lookup("unrelated.oce.svc", { family: 4 })).address;
    assert.equal(require("node:net").isIP(unrelatedAddress), 4);
    const directRoute = cp.spawnSync("curl", ["--noproxy", "*", "-ksS", "--connect-timeout", "5", "--max-time", "10", "--resolve", "unrelated.oce.svc:443:" + unrelatedAddress, "https://unrelated.oce.svc/"], { encoding: "utf8" });
    assert.equal(directRoute.status, 0, "fixture must be reachable outside the sandbox: " + directRoute.stderr);
    markStockBrokerStage("initialize");
    await rpc("initialize", { clientInfo: { name: "repository-broker-stock-codex-smoke", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    native.stdin.write(JSON.stringify({ method: "initialized" }) + "\\n");

    markStockBrokerStage("proxy-env");
    const proxyState = await execShell(${JSON.stringify(proxyEnvironmentProbe)});
    assert.equal(proxyState.exitCode, 0, "proxy-env subprobe failed: " + proxyState.stderr + proxyState.stdout);
    assert.match(proxyState.stdout, /proxy-env-ok/);

    markStockBrokerStage("broker-denial");
    const brokerDenials = await execShell(${JSON.stringify(brokerDenialProbe)});
    assert.equal(brokerDenials.exitCode, 0, "broker denial code probe failed: " + brokerDenials.stderr);
    assert.match(brokerDenials.stdout, /broker-denial-codes-confirmed/);

    markStockBrokerStage("outside-home-read");
    await expectFailure("outside-workspace-home-read-denied", "cat " + homeControlSentinelPath, "No such file|Permission denied|Operation not permitted|EACCES|ENOENT");
    const sentinelBeforeSandboxWrite = fs.readFileSync(homeControlSentinelPath, "utf8");
    markStockBrokerStage("outside-home-shadow-write");
    const shadowWrite = await execShell("printf shadowed > " + homeControlSentinelPath + " && printf sandbox-write-exit0", brokerPermissionProfile);
    assert.equal(shadowWrite.exitCode, 0, shadowWrite.stderr + shadowWrite.stdout);
    assert.match(shadowWrite.stdout, /sandbox-write-exit0/);
    assert.equal(fs.readFileSync(homeControlSentinelPath, "utf8"), sentinelBeforeSandboxWrite, "sandbox writes must not modify the parent home sentinel");
    markStockBrokerStage("outside-home-read-after-shadow-write");
    await expectFailure("outside-workspace-home-read-still-denied-after-shadow-write", "cat " + homeControlSentinelPath, "No such file|Permission denied|Operation not permitted|EACCES|ENOENT");

    markStockBrokerStage("git-proof");
    const gitProof = await execShell(${JSON.stringify(gitProofScript)}, brokerPermissionProfile, 60000);
    assert.equal(gitProof.exitCode, 0, gitProof.stderr + "\\n" + gitProof.stdout);
    const commit = gitProof.stdout.match(/commit=([a-f0-9]{40})/)?.[1];
    assert.ok(commit, gitProof.stdout);

    markStockBrokerStage("explicit-deny");
    await expectFailure("explicit-deny-broker", "git ls-remote https://github.com/fixture/repository.git HEAD", "CONNECT tunnel failed, response 403|Received HTTP code 403 from proxy after CONNECT", deniedPermissionProfile);
    markStockBrokerStage("unrelated-private-host");
    await expectFailure("proxy-unrelated-private-host", "curl -ksS --connect-timeout 5 --max-time 10 https://unrelated.oce.svc/", "CONNECT tunnel failed, response 403|Received HTTP code 403 from proxy after CONNECT");
    const directProbe = "node -e " + JSON.stringify('const socket = require("node:net").connect(443, process.argv[1]); socket.on("connect", () => { console.error("UNEXPECTED_CONNECTION"); process.exit(42); }); socket.on("error", (error) => { console.error(error.code); process.exit(1); }); setTimeout(() => { console.error("TIMEOUT"); process.exit(43); }, 5000);') + " " + unrelatedAddress;
    markStockBrokerStage("direct-private-host");
    await expectFailure("direct-unrelated-private-host", directProbe, "EPERM|EACCES|ENETUNREACH|EHOSTUNREACH");
    process.stdout.write("stock-codex-repository-broker-ready " + JSON.stringify({ commit }) + "\\n");
  } finally {
    clearTimeout(timeout);
    lines.close();
    native.kill("SIGTERM");
  }
})().catch((error) => { console.error(error); console.error(stderr); process.exitCode = 1; });
`;
    let stdout;
    try {
      ({ stdout } = await runDocker(
        [
          "run",
          "-i",
          "--rm",
          "--network",
          networkName,
          "--read-only",
          "--user",
          "1000:1000",
          "--cap-drop",
          "ALL",
          ...probeSecurityOptions,
          "--tmpfs",
          "/home/node:size=192m,uid=1000,gid=1000,mode=700",
          "--tmpfs",
          "/tmp:size=128m,uid=1000,gid=1000,mode=1777",
          "--tmpfs",
          "/run/oce:size=16m,uid=1000,gid=1000,mode=700",
          "-v",
          `${materialVolumeName}:/source-repository-credentials:ro`,
          "-v",
          `${tls.certFile}:/certs/broker-ca.pem:ro`,
          "--entrypoint",
          "node",
          image,
          "-",
        ],
        { timeout: 150_000 * imageSmokeTimeoutMultiplier, maxBuffer: 2_000_000 },
        probe,
      ));
    } catch (error) {
      throw annotateRuntimeImageStockBrokerFailure(error);
    }
    const match = stdout.match(/stock-codex-repository-broker-ready (\{[^\n]+\})/);
    assert.ok(match, stdout);
    const proof = JSON.parse(match[1]);

    const guarded = fixture.byRef.get("guarded");
    const readOnly = fixture.byRef.get("read-only");
    assert.equal(
      unadmitted.github.authenticationAttempts.filter(({ boundary }) => boundary === "git").length,
      unadmittedAttempts,
      "unadmitted requests must not reach the upstream even with a rejected provider token",
    );
    assert.equal(unadmitted.git.trace.length, 0, "unadmitted requests must not reach the upstream");
    assert.equal(await guarded.git.ref(`refs/heads/${workspaceBranch}`), proof.commit);
    await assert.rejects(guarded.git.ref("refs/heads/disallowed"));
    await assert.rejects(readOnly.git.ref("refs/heads/denied"));
    assert.equal(
      readOnly.git.trace.some(({ path }) => path.endsWith("/git-receive-pack")),
      false,
      "read-only broker denial must happen before the upstream receive-pack route",
    );
    assert.ok(
      guarded.git.trace.some(({ path }) => path.endsWith("/git-upload-pack")),
      "authorized Git fetch must reach the real upstream through the broker",
    );
    assert.ok(
      guarded.git.trace.some(({ path }) => path.endsWith("/git-receive-pack")),
      "authorized Git push must reach the real upstream through the broker",
    );
  },
);

test(
  "runtime image shares Codex 0.156.0 between the plugin and Dedicated command",
  imageTestOptions,
  async () => {
    const script = String.raw`
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { dirname, relative, resolve } = require("node:path");
const { realpathSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const plugin = createRequire("/app/dist/extensions/codex/package.json");
const installed = plugin.resolve("@openai/codex/package.json");
assert.equal(JSON.parse(readFileSync(installed, "utf8")).version, "0.156.0");
const bundledCommand = plugin.resolve("@openai/codex/bin/codex.js");
assert.equal(realpathSync("/app/node_modules/.bin/codex"), realpathSync(bundledCommand));
assert.equal(execFileSync("codex", ["--version"], {encoding: "utf8"}).trim(), "codex-cli 0.156.0");
assert.equal(execFileSync(process.execPath, [bundledCommand, "--version"], {encoding: "utf8"}).trim(), "codex-cli 0.156.0");
const provenance = JSON.parse(readFileSync("/opt/oce/runtime/provenance.json", "utf8"));
assert.equal(provenance.source, "https://github.com/openclaw/openclaw");
assert.equal(provenance.commit, "000d03942c8703a4c18615ab8d1a5f18c85b5674");
assert.equal(provenance.sourceArchiveSha256, "7fddb3787c64b8d0dc22595abc19e23862903b0349714e61dbac18240b2b5ced");
assert.equal(provenance.openclawBridgePatchSha256, "62328f7cc72ada024a97a5a7bf89e988db3f91b64b4c6d7fa6809c218fc8b72e");
assert.equal(provenance.codex.version, "0.156.0");
assert.equal(Object.hasOwn(provenance, "codexPatchSha256"), false);
assert.equal(Object.hasOwn(provenance, "codexVersion"), false);
const contents = readFileSync("/opt/oce/runtime/contents.json");
const inventory = JSON.parse(contents);
assert.equal(createHash("sha256").update(contents).digest("hex"), provenance.runtimeContentsSha256);
function readPnpmIntegrity(lockfile, packageName, version) {
  const key = "  '" + packageName + "@" + version + "':";
  const start = lockfile.indexOf(key);
  assert.notEqual(start, -1, "missing lockfile entry for " + packageName + "@" + version);
  const rest = lockfile.slice(start + key.length);
  const nextPackage = rest.search(/\n {2}'[^']+@[^']+':/);
  const block = nextPackage === -1 ? rest : rest.slice(0, nextPackage);
  const match = block.match(/\n\s+resolution: \{integrity: ([^}]+)\}/);
  assert.ok(match, "missing lockfile integrity for " + packageName + "@" + version);
  return match[1];
}
const platformByArchitecture = {
  x64: {
    packageName: "@openai/codex-linux-x64",
    packageDirectory: "codex-linux-x64",
    binaryPath: "vendor/x86_64-unknown-linux-musl/bin/codex",
    targetArch: "amd64",
  },
  arm64: {
    packageName: "@openai/codex-linux-arm64",
    packageDirectory: "codex-linux-arm64",
    binaryPath: "vendor/aarch64-unknown-linux-musl/bin/codex",
    targetArch: "arm64",
  },
};
const platform = platformByArchitecture[process.arch];
assert.ok(platform, "Unsupported runtime test architecture: " + process.arch);
assert.equal(Object.hasOwn(provenance, "codexBrokerPolicy"), false, "stock runtime must not carry patched Codex provenance");
const codexPackageRoot = dirname(plugin.resolve("@openai/codex/package.json"));
const codexPackage = JSON.parse(readFileSync(resolve(codexPackageRoot, "package.json"), "utf8"));
const platformPackageRoot = resolve(codexPackageRoot, "..", platform.packageDirectory);
const platformPackage = JSON.parse(readFileSync(resolve(platformPackageRoot, "package.json"), "utf8"));
const platformBinary = resolve(platformPackageRoot, platform.binaryPath);
const platformBinarySha256 = createHash("sha256").update(readFileSync(platformBinary)).digest("hex");
const platformInventoryPath = relative("/app/node_modules/openclaw", realpathSync(platformBinary));
assert.ok(!platformInventoryPath.startsWith(".."), "Codex platform binary must live under the inventoried OpenClaw package root.");
const lockfile = readFileSync("/app/node_modules/openclaw/pnpm-lock.yaml", "utf8");
assert.deepEqual(provenance.codex, {
  source: "npm:@openai/codex",
  version: codexPackage.version,
  packageIntegrity: readPnpmIntegrity(lockfile, "@openai/codex", codexPackage.version),
  package: platform.packageName,
  packageVersion: platformPackage.version,
  platformPackageIntegrity: readPnpmIntegrity(lockfile, "@openai/codex", platformPackage.version),
  architecture: platform.targetArch,
  installedBinary: relative("/app/node_modules/openclaw", platformBinary),
  resolvedBinary: platformInventoryPath,
  binarySha256: platformBinarySha256,
});
const platformInventoryEntry = inventory.find((entry) => entry.path === platformInventoryPath);
assert.ok(platformInventoryEntry, "The final runtime inventory must include the stock Codex platform binary.");
assert.equal((platformInventoryEntry.mode & 0o111) !== 0, true, "Codex platform binary must stay executable.");
assert.equal(platformInventoryEntry.sha256, platformBinarySha256);
process.stdout.write("shared-codex-0.156.0-ready\n");
`;
    const { stdout } = await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      image,
      "-e",
      script,
    ]);
    assert.match(stdout, /shared-codex-0.156.0-ready/);
  },
);
