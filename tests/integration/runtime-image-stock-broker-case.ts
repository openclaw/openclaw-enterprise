import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
  REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/repository-material-init.ts";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.ts";
import { startCredentialServiceFixture } from "../fixtures/repository-credentials/service-fixture.ts";
import { run as runFixtureCommand } from "../fixtures/repository-credentials/process.ts";
import { execute, runDocker, waitForDockerLog } from "../helpers/runtime-image-docker.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.ts";
import { relaySockets } from "../helpers/socket-relay.ts";
import { probeStockBroker } from "../fixtures/runtime-image-startup/stock-broker.ts";
import { probeBrokerConfig } from "../fixtures/runtime-image-startup/broker-config.ts";
import { bundledExport, loadCodexConfig } from "../fixtures/runtime-image-startup/bundled-codex.ts";
import {
  codexRpc,
  commandResult,
  list,
  parseJson,
  record,
  text,
} from "../fixtures/runtime-image-startup/wire.ts";
import {
  brokerCodexConfiguration,
  renderProbe,
  type SeccompOptions,
} from "./runtime-image-startup-support.ts";

const runtimeImageStockBrokerDiagnosticStages = new Set([
  "material-init",
  "native-git-init",
  "config-patch",
  "fixture-reachability",
  "initialize",
  "bundled-system-skill",
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

function annotateRuntimeImageStockBrokerFailure(error: unknown) {
  if (!(error instanceof Error)) {
    return error;
  }
  const output = [
    "stderr" in error ? error.stderr : undefined,
    "stdout" in error ? error.stdout : undefined,
    error.message,
  ]
    .filter((item) => typeof item === "string")
    .join("\n");
  const matches = [...output.matchAll(/^openclaw-ci-stock-broker-stage=([a-z-]+)$/gm)];
  const stage = matches.at(-1)?.[1];
  if (stage !== undefined && runtimeImageStockBrokerDiagnosticStages.has(stage)) {
    Object.assign(error, { openclawCiDiagnostic: { kind: "runtime-image-stock-broker", stage } });
  }
  return error;
}

async function removeDockerVolumes(volumeNames: string[]) {
  const removals = await Promise.allSettled(
    volumeNames.map((volumeName) => runDocker(["volume", "rm", "-f", volumeName])),
  );
  const failures = removals.flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "failed to remove runtime image repository material volumes",
    );
  }
}

async function removeDockerContainer(containerName: string, priorFailure: unknown) {
  try {
    await runDocker(["rm", "-f", containerName]);
  } catch (cleanupError) {
    if (priorFailure instanceof Error) {
      Object.assign(priorFailure, { cleanupError });
      return;
    }
    throw cleanupError;
  }
}

async function populateRepositoryProjectionVolume(
  image: string,
  sourceRoot: string,
  volumeName: string,
  ownership: { uid: number; gid: number; directoryMode: string; fileMode: string },
) {
  const helperName = `${volumeName}-populate`;
  const script = [
    "set -eu",
    `find /projection -type d -exec chmod ${ownership.directoryMode} {} +`,
    `find /projection -type f -exec chmod ${ownership.fileMode} {} +`,
    `chown -R ${ownership.uid}:${ownership.gid} /projection`,
  ].join("\n");
  let failure: unknown;
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

async function runRepositoryMaterialInitProbe(
  image: string,
  volumeName: string,
  descriptor: RepositoryMaterialDescriptor,
) {
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

async function createRuntimeBrokerTlsMaterial(t: TestContext) {
  const directory = await temporaryDirectory(t, "oce-runtime-broker-tls-");
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

function runtimeRepositorySessionDirectory(repositoryRef: string, sessionId: string) {
  return `/run/oce/repository-credentials/sessions/${createHash("sha256")
    .update(JSON.stringify([repositoryRef, sessionId]))
    .digest("hex")}`;
}

async function createRuntimeRepositoryMaterial(t: TestContext, clientDirectory: string) {
  const material = await createNativeClientMaterial(t, [
    { clientDirectory, repositoryRef: "guarded" },
  ]);
  const manifest = {
    ...material.manifest,
    bindings: material.manifest.bindings.map((binding) => ({
      ...binding,
      directory: runtimeRepositorySessionDirectory(binding.repositoryRef, binding.sessionId),
    })),
  };
  await writeFile(join(material.root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { root: material.root, manifest };
}

type RepositoryMaterialDescriptor = {
  sourceRoot: string;
  targetRoot: string;
  manifest: Awaited<ReturnType<typeof createRuntimeRepositoryMaterial>>["manifest"];
};

export async function verifyStockBroker(
  t: TestContext,
  image: string,
  seccompOptions: SeccompOptions,
) {
  const suffix = randomBytes(6).toString("hex");
  const networkName = `oce-runtime-broker-${suffix}`;
  const proxyName = `oce-runtime-broker-proxy-${suffix}`;
  const materialVolumeName = `oce-runtime-broker-material-${suffix}`;
  const deniedMaterialVolumeName = `oce-runtime-broker-material-denied-${suffix}`;
  const workspaceBranch = "native-feature";
  const tls = await createRuntimeBrokerTlsMaterial(t);
  const fixtureValue: unknown = await startCredentialServiceFixture(t, {
    tls,
    gateway: { publicOrigin: "https://git.oce.svc", listen: "0.0.0.0:0" },
    limits: { gitResponseBytes: 4096, gitFetchResponseBytes: 200000 },
    configuration: { allowGraphql: false, pushRefAllowlist: [`refs/heads/${workspaceBranch}`] },
  });
  const fixture = record(fixtureValue);
  const git = record(fixture.git);
  const bare = text(git.bare);
  const listenPort = record(record(fixture.listeners).address).port;
  assert.ok(typeof listenPort === "number");
  const seed = join(await temporaryDirectory(t, "runtime-git-seed-"), "seed");
  await runFixtureCommand("git", ["clone", bare, seed]);
  await runFixtureCommand("git", ["config", "user.name", "Fixture"], { cwd: seed });
  await runFixtureCommand("git", ["config", "user.email", "fixture@example.test"], { cwd: seed });
  await writeFile(join(seed, "data.bin"), randomBytes(128 * 1024));
  await runFixtureCommand("git", ["add", "data.bin"], { cwd: seed });
  await runFixtureCommand("git", ["commit", "-m", "Add fixture data"], { cwd: seed });
  await runFixtureCommand("git", ["push", "origin", "HEAD:main"], { cwd: seed });
  const { root: materialRoot, manifest } = await createRuntimeRepositoryMaterial(
    t,
    text(fixture.clientDirectory),
  );
  t.after(async () => {
    await runDocker(["rm", "-f", proxyName]).catch(() => {});
    await runDocker(["network", "rm", networkName]).catch(() => {});
    await removeDockerVolumes([materialVolumeName, deniedMaterialVolumeName]);
  });

  const descriptor: RepositoryMaterialDescriptor = {
    sourceRoot: "/source-repository-credentials/sessions",
    targetRoot: "/run/oce/repository-credentials",
    manifest,
  };
  await runDocker(["volume", "create", materialVolumeName]);
  await runDocker(["volume", "create", deniedMaterialVolumeName]);
  await populateRepositoryProjectionVolume(image, materialRoot, deniedMaterialVolumeName, {
    uid: 1001,
    gid: 1001,
    directoryMode: "700",
    fileMode: "600",
  });
  await populateRepositoryProjectionVolume(image, materialRoot, materialVolumeName, {
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
  // The init runs, cannot read a source owned by another uid, and exits 1 with its one
  // redacted failure; Docker's own failures exit 125. The command line embeds the same
  // text, so match the child's stderr rather than the error message.
  await assert.rejects(
    runRepositoryMaterialInitProbe(image, deniedMaterialVolumeName, descriptor),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === 1 &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      /^Repository credential material initialization failed\.$/m.test(error.stderr),
  );
  await runRepositoryMaterialInitProbe(image, materialVolumeName, descriptor);

  await runDocker(["network", "create", "--driver", "bridge", networkName]);
  // The container runs the shared relay's own source, so a clean single-use upstream close
  // still delivers bytes queued for the slower sandbox proxy (finding 2186).
  const forwarder = String.raw`
const net = require("node:net");
const targetHost = process.argv[1];
const targetPort = Number(process.argv[2]);
${relaySockets}
const server = net.createServer((client) => {
  relaySockets(client, net.connect(targetPort, targetHost));
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
    "test $(wc -c < guarded/data.bin) -eq 131072",
    "git -C guarded fsck --full",
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
    // Match in the shell, not with `printf | grep -q`: under pipefail, grep -q
    // exits at the first match and printf's next line write can fail with EPIPE.
    "[[ $disallowed_output == *'repository-push-ref-not-allowed'* ]]",
    "set +e",
    "unadmitted_output=$(git ls-remote https://github.com/fixture/unadmitted.git HEAD 2>&1)",
    "unadmitted_status=$?",
    "set -e",
    "printf '%s\\n' \"$unadmitted_output\"",
    'test "$unadmitted_status" -ne 0',
    "[[ $unadmitted_output == *'credential-helper-failed'* ]]",
    "printf 'commit=%s\\n' \"$commit\"",
  ].join("\n");
  // Ask the real broker for its service-owned denial codes without printing
  // the session credential returned by the installed Git helper.
  const brokerDenialProbe = String.raw`node <<'NODE'
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const credentials = cp.spawnSync("git", ["credential", "fill"], {
  input: "protocol=https\nhost=git.oce.svc\npath=fixture/repository.git\n\n",
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
const allowed = request("fixture/repository.git/info/refs?service=git-upload-pack", true);
assert.equal(allowed.endsWith("\n200") && allowed.includes("# service=git-upload-pack"), true, "admitted discovery did not succeed");
// This single-repository sender rejects Git Basic authentication for an unconfigured
// repository before route planning. Compare as a boolean to keep the response out of failures.
assert.equal(request("fixture/unadmitted.git/info/refs?service=git-upload-pack", true) === '{"error":{"code":"invalid-credential"}}\n401', true, "unadmitted repository must return 401 invalid-credential");
console.log("broker-denial-codes-confirmed");
NODE`;

  const probeSecurityOptions = await seccompOptions();
  const configPatchProbe = renderProbe(
    probeBrokerConfig,
    [bundledExport, loadCodexConfig, parseJson, record],
    "module",
  );
  const probe = renderProbe(probeStockBroker, [
    {
      descriptor,
      entrypoint: AGENT_RUNTIME_ENTRYPOINT,
      materialInit: REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
      nativeGitInit: REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT,
      pluginRuntime: {
        manifest: { kind: "codex", selections: {} },
        brokerCodexConfiguration: brokerCodexConfiguration({ host: "git.oce.svc", domains: {} }),
      },
      configPatchProbe,
      proxyEnvironmentProbe,
      brokerDenialProbe,
      gitProofScript,
    },
    codexRpc,
    commandResult,
    list,
    parseJson,
    record,
    text,
  ]);
  let stdout: string;
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
  const commit = text(record(parseJson(text(match[1]))).commit);
  assert.match(commit, /^[a-f0-9]{40}$/);

  const readBareRef = async (name: string) =>
    (await runFixtureCommand("git", ["rev-parse", name], { cwd: bare })).stdout.trim();
  assert.equal(await readBareRef(`refs/heads/${workspaceBranch}`), commit);
  await assert.rejects(readBareRef("refs/heads/disallowed"), /command failed \(exit 128\)/);
  assert.equal(list(record(fixture.github).issuesOfTokens).length, 0);
  const tracePaths = list(git.trace).map((item) => text(record(item).path));
  assert.ok(
    tracePaths.some((path) => path.endsWith("/git-upload-pack")),
    "authorized Git fetch must reach the real upstream through the broker",
  );
  assert.ok(
    tracePaths.some((path) => path.endsWith("/git-receive-pack")),
    "authorized Git push must reach the real upstream through the broker",
  );
}
