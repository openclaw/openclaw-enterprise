/**
 * The private Git fixture owns the origin and invokes this once on a fresh hosted runner.
 * Keep raw setup, test, credentials and journey records private. Release the aggregate's
 * result only after the selected test, its evidence, and removal of the owned cluster succeed.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  projectSkipperRunnerReceipt,
  skipperFailureSummary,
  skipperInstalledProof,
  skipperImageScope,
} from "./skipper-release.ts";
import { upgradeNeedsRecovery } from "../../tests/helpers/skipper-installed-upgrade.ts";
import { imageConfigDigest } from "./image-config-digest.ts";
import {
  readSkipperJourney,
  recordSkipperCheckpoint,
  recordSkipperInstallerExit,
  recordSkipperTestFailure,
} from "./skipper-failure-receipt.ts";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import {
  createApi,
  kubectl,
  modelContainer,
  routeModelProvider,
  run,
  startLocalSetup,
  workDirectory,
} from "./first-agent-smoke.mjs";

const env = process.env;
const upgrade = process.argv[2] === "--upgrade";
assert.ok(process.argv.length === (upgrade ? 3 : 2));
const execute = promisify(execFile);
const previousRevision = "54bfa7fc1b99e362450beb5f9211e164991fa7b4";
const upgradeTest =
  "installed upgrade retains the Agent conversation, workspace and standing private Git approval";
const lane = "skipper-prepared-git-installed";
const minute = 60_000;
const read = async (path) => JSON.parse(await readFile(path));
const output = async (command, args) => (await run(command, args)).stdout.trim();
await recordSkipperCheckpoint("skipper_stage", "preflight");
const sourceCommit = await output("git", ["rev-parse", "HEAD"]);
assert.equal(sourceCommit, env.GITHUB_SHA);
assert.equal(await output("git", ["status", "--porcelain"]), "");
const attempt = env.GITHUB_RUN_ID + "-" + env.GITHUB_RUN_ATTEMPT;
assert.match(attempt, /^\d+-\d+$/);
const id = createHash("sha256")
  .update(sourceCommit + ":" + attempt)
  .digest("hex")
  .slice(0, 12);
const cluster = "occ-dev-skipper-" + id;
if (upgrade) {
  await mkdir(workDirectory, { recursive: true, mode: 0o700 });
}
const directory = join(workDirectory, cluster);
await mkdir(directory, { mode: 0o700 }); // Refuse a second use of this attempt.
const database = "openclaw_k8s_skipper_" + id;
const install = {
  ...env,
  OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
  OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
  OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
  OCC_DEVELOPMENT_PROTECTED_EGRESS: "0",
  OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
  // This is a dedicated hosted runner. Select the three dev-up ports explicitly so the
  // kubeconfig check and post-cleanup probe use exactly the ports the launcher received.
  OCC_DEVELOPMENT_KUBERNETES_API_PORT: "6443",
  OPENCLAW_DEV_PORT: "3000",
  OCC_DEVELOPMENT_BROWSER_PORT: "8443",
  OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
  OCC_DEVELOPMENT_STATE_DIRECTORY: join(directory, "local-setup"),
  OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "1200",
  OCC_DEVELOPMENT_DATABASE_NAME: database,
};
assert.ok(install.OCC_TEST_SKIPPER_PRIVATE_GIT_WITNESS && install.OCC_DEVELOPMENT_REPOSITORY_IMAGE);
delete install.OPENAI_API_KEY;
const privateResult = join(directory, "selected-test-result.json");
const registry = env.OCC_SKIPPER_IMAGE_REGISTRY_CONTAINER;
if (!upgrade) {
  assert.match(registry, /^[a-f0-9]{64}$/);
}
// The upgrade caller owns its staged image registry and trust material across both releases.
const cleanup = upgrade ? [] : [() => run("docker", ["rm", "--force", "--volumes", registry])];
const proof = skipperInstalledProof(env.OCC_TEST_SKIPPER_TEAM_REVIEW === "1");
const progress = (name) => console.log("Private Git acceptance: " + name);
const noCluster = async () => {
  const names = await output("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  assert.ok(!names.split("\n").some((name) => name.startsWith("k3d-" + cluster + "-")));
  const nets = await output("docker", ["network", "ls", "--format", "{{.Name}}"]);
  assert.ok(!nets.split("\n").includes("k3d-" + cluster));
};

// kubectl allocates and reports the local port. Keep that exact process until the test finishes.
async function applicationDatabase(stack, system) {
  const key = await kubectl(stack, [
    "-n",
    system,
    "get",
    "secret",
    "occ-database",
    "-o",
    "jsonpath={.data.application-url}",
  ]);
  const url = new URL(Buffer.from(key.stdout, "base64").toString("utf8"));
  assert.equal(url.username, "occ_app");
  assert.equal(url.hostname, "postgres." + system + ".svc.cluster.local");
  assert.equal(url.pathname, "/" + database);
  assert.equal(url.search, "");
  const forward = spawn(
    "kubectl",
    [
      "--kubeconfig",
      stack.kubeconfig,
      "--context",
      stack.context,
      "-n",
      system,
      "port-forward",
      "--address=127.0.0.1",
      "svc/postgres",
      ":5432",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = once(forward, "exit");
  const close = async () => {
    forward.kill();
    await exited;
  };
  cleanup.push(close);
  closeDatabase = close;
  const lines = createInterface({ input: forward.stdout });
  const line = await Promise.race([
    once(lines, "line", { signal: AbortSignal.timeout(30_000) }).then(([value]) => value),
    exited.then(() => {
      throw new Error("database forward exited");
    }),
  ]);
  const [, port] = /^Forwarding from 127\.0\.0\.1:(\d+) -> 5432$/.exec(line);
  url.hostname = "127.0.0.1";
  url.port = port;
  return url.href;
}

// occ dev up imports a platform image under a new local digest. Bind its actual CRI
// config ID to the built image, rather than assuming registry and imported manifest IDs match.
async function checkImage(stack, selected, built, revision = sourceCommit) {
  assert.match(built, /@sha256:[a-f0-9]{64}$/);
  const name = "import-" + createHash("sha256").update(built).digest("hex").slice(0, 12);
  assert.match(selected, /@sha256:[a-f0-9]{64}$/);
  assert.ok(selected.includes("/" + name + "@"));
  const node = stack.context + "-server-0";
  const image = JSON.parse(await output("docker", ["exec", node, "crictl", "inspecti", selected]));
  // A classic Docker image store reports the config in Id. With the newer containerd
  // store Id can be an index; inspect its linux/amd64 descriptor for the config digest.
  const inspect = async (...flags) =>
    JSON.parse(await output("docker", ["image", "inspect", ...flags, built]))[0];
  let local = await inspect();
  if (local.Id !== image.status.id) {
    local = await inspect("--platform", "linux/amd64");
  }
  assert.equal(local.Config.Labels["org.opencontainers.image.revision"], revision);
  // The import copied the local platform manifest blob into the node, where it is
  // readable without host privileges; imageConfigDigest checks it against its digest.
  const config = await imageConfigDigest(
    local,
    async (digest) =>
      (await run("docker", ["exec", node, "ctr", "-n", "k8s.io", "content", "get", digest])).stdout,
  );
  assert.match(config, /^sha256:[a-f0-9]{64}$/);
  assert.equal(image.status.id, config);
  return { built: built.split("@")[1], installed: selected.split("@")[1], config };
}

// Only a separate, clean checkout of the supported previous release may launch the baseline.
async function previousInstallation() {
  assert.equal(env.OCC_TEST_SKIPPER_TEAM_REVIEW, "0");
  assert.match(
    install.OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY ?? "",
    /^\/tmp\/oce-skipper-[a-zA-Z0-9]+$/,
  );
  assert.equal(
    install.OCC_TEST_SKIPPER_PRIVATE_GIT_WITNESS,
    join(install.OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY, "witness.sock"),
  );
  assert.equal(
    install.OCC_DEVELOPMENT_CONTROLLER_IMAGE,
    "ghcr.io/openclaw/openclaw-enterprise-controller@sha256:968ef69a70c0f2ac927e0e7515ba8c07c9887e7b23211351f58bbf706662ffed",
  );
  const checkout = resolve(env.OCC_SKIPPER_PREVIOUS_CHECKOUT);
  assert.equal(
    (await execute("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(),
    previousRevision,
  );
  assert.equal(
    (await execute("git", ["status", "--porcelain"], { cwd: checkout })).stdout.trim(),
    "",
  );
  const candidateImages = {};
  for (const [role, setting] of Object.entries({
    controller: "OCC_DEVELOPMENT_CONTROLLER_IMAGE",
    repository: "OCC_DEVELOPMENT_REPOSITORY_IMAGE",
  })) {
    const image = env["OCC_SKIPPER_CANDIDATE_" + role.toUpperCase() + "_IMAGE"];
    assert.match(image ?? "", /^[a-z0-9][a-z0-9.:/_-]*@sha256:[a-f0-9]{64}$/);
    assert.match(install[setting] ?? "", /^[a-z0-9][a-z0-9.:/_-]*@sha256:[a-f0-9]{64}$/);
    assert.notEqual(image.split("@")[1], install[setting].split("@")[1]);
    const label = await output("docker", [
      "image",
      "inspect",
      "--format",
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      image,
    ]);
    assert.equal(label, sourceCommit);
    candidateImages[role] = image;
  }
  assert.match(
    install.OCC_KUBERNETES_RUNTIME_IMAGE ?? "",
    /^[a-z0-9][a-z0-9.:/_-]*@sha256:[a-f0-9]{64}$/,
  );
  const previousCli = join(directory, "previous-occ");
  await execute("go", ["build", "-trimpath", "-o", previousCli, "./cmd/occ"], { cwd: checkout });
  const candidateCli = join(directory, "candidate-occ");
  await run("go", ["build", "-trimpath", "-o", candidateCli, "./cmd/occ"]);
  const registryFile = join(install.OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY, "registry.json");
  const registry = await read(registryFile);
  assert.equal(registry.backendId, "skipper-fixture");
  assert.equal(registry.repositories.length, 1);
  assert.equal(registry.repositories[0].namespaces.length, 1);
  // Make standing sessions renew on a real clock during the test.
  registry.maximumDurationSeconds = 600;
  registry.allowStandingApprovals = true;
  registry.repositories[0].namespaces[0].allowStandingApproval = true;
  await writeFile(registryFile, JSON.stringify(registry), { mode: 0o600 });
  const dev = (action) =>
    execute(previousCli, ["dev", action], {
      env: install,
      cwd: checkout,
      timeout: 30 * minute,
      maxBuffer: 16 * 1024 * 1024,
    });
  await dev("up").catch(async (error) => {
    await writeFile(
      join(directory, "previous-installer.log"),
      String(error.stdout ?? "") + String(error.stderr ?? ""),
      { mode: 0o600, flag: "wx" },
    );
    throw new Error("previous installer failed; see private previous-installer.log");
  });
  const local = install.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const state = await read(join(local, "state.json"));
  assert.equal(state.repository, checkout);
  assert.equal(state.keyOwned, true);
  assert.equal(state.keyPath, join(local, "initial-admin-service-key.json"));
  const origin = "http://127.0.0.1:" + state.apiPort;
  return {
    directory: local,
    state,
    origin,
    keyPath: state.keyPath,
    kubeconfig: join(local, "kubeconfig"),
    context: "k3d-" + state.cluster,
    api: createApi(origin, (await read(state.keyPath)).data.key),
    down: () => dev("down"),
    upgrade: { previousRevision, candidateImages, candidateCli },
  };
}

let closeDatabase;
let phase = "fresh cluster preflight";
let failed = false;
let runnerReceipt;
let imageDigests;
let clusterCleanupVerified = false;
let cleanupFailed = false;
let installerFailure;
try {
  await noCluster();
  phase = "install checkout images, prepared repository service and fresh application database";
  await recordSkipperCheckpoint("skipper_stage", "install");
  progress(phase);
  const stack = await (
    upgrade ? previousInstallation() : startLocalSetup(install, { privateInstall: true })
  ).catch(async (error) => {
    if (!upgrade) {
      installerFailure = await recordSkipperInstallerExit(error.result);
    }
    throw error;
  });
  const { state, context, kubeconfig } = stack;
  assert.equal(state.cluster, cluster);
  assert.equal(state.databaseName, database);
  assert.equal(state.sandboxDriver, "none");
  assert.ok(!state.protectedEgress);
  const uid = async () =>
    (await kubectl(stack, ["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"]))
      .stdout;
  const clusterUID = await uid();
  assert.match(clusterUID, /^[a-f0-9-]{36}$/);
  cleanup.push(async () => {
    assert.equal(await uid(), clusterUID);
    if (upgrade) {
      await stack.down();
    } else {
      await run("bin/occ", ["dev", "down"], { env: install, timeout: 12 * minute });
    }
    await noCluster();
    for (const port of [6443, 3000, 8443]) {
      const server = createServer().listen(port, "127.0.0.1");
      await once(server, "listening");
      server.close();
      await once(server, "close");
    }
    clusterCleanupVerified = true;
    progress("owned cluster and network removed; installation ports released");
  });

  phase = "bind installed image identities and model fixture";
  await recordSkipperCheckpoint("skipper_stage", "bind-images");
  const helm = await read(join(stack.directory, "helm-values.json"));
  const config = JSON.parse(
    await output("yq", ["-o=json", ".", join(stack.directory, "installation.yaml")]),
  );
  const images = config.drivers.compute.configuration.images;
  const { codexSeccompProfile = null } = config.drivers.compute.configuration.runtime;
  if (codexSeccompProfile !== null) {
    assert.match(codexSeccompProfile, /^openclaw\/codex-[\w.-]+-[0-9a-f]{64}\.json$/);
  }
  assert.ok(
    config.repository?.preparedGitHub &&
      !config.drivers.repo &&
      config.repository.nativeSender &&
      !config.drivers.sandbox,
  );
  assert.equal(helm.repositoryCredentials.authority, "prepared-git");
  assert.equal(images.gateway, images.agent);
  const revision = upgrade ? previousRevision : sourceCommit;
  imageDigests = {
    controller: await checkImage(
      stack,
      helm.images.controller,
      env.OCC_DEVELOPMENT_CONTROLLER_IMAGE,
      revision,
    ),
    runtime: await checkImage(stack, images.agent, env.OCC_KUBERNETES_RUNTIME_IMAGE, revision),
    repository: await checkImage(
      stack,
      helm.repositoryCredentials.image,
      env.OCC_DEVELOPMENT_REPOSITORY_IMAGE,
      revision,
    ),
  };
  progress("installed controller, agent, gateway and repository image identities verified");
  const modelDirectory = env.OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY;
  await routeModelProvider(stack, modelDirectory, env.OCC_KUBERNETES_RUNTIME_IMAGE, {
    journey: "PROBE_SKIPPER_PREPARED_COMPUTE",
    cleanup,
  });

  phase = "bind application database, namespace and owned cluster UID";
  await recordSkipperCheckpoint("skipper_stage", "bind-database");
  const system = state.platformNamespace;
  const apiOrigin = stack.origin;
  const serviceKey = (await read(stack.keyPath)).data.key;
  const namespaces = await stack.api("GET", "/namespaces");
  const ready = namespaces.filter((n) => n.name === "default" && n.status === "ready");
  assert.equal(ready.length, 1);
  if (upgrade) {
    const bootstrap = await read(stack.keyPath);
    const installation = await stack.api("GET", "/installation");
    assert.equal(bootstrap.meta.installationId, installation.id);
    assert.match(installation.id, /^ins_[0-9a-f-]{36}$/);
    // The documented bootstrap binding refuses an existing, different Installation.
    await kubectl(stack, [
      "-n",
      system,
      "annotate",
      "secret",
      helm.installation?.secretName ?? "occ-installation-startup",
      "openclaw.dev/installation-id=" + installation.id,
    ]);
  }
  const input = join(directory, "test-input.json");
  await writeFile(
    input,
    JSON.stringify({
      sourceCommit,
      ...(upgrade ? { upgrade: stack.upgrade } : {}),
      topology: "compute-owned-prepared-private-git",
      clusterUID,
      kubeconfig,
      context,
      system,
      apiOrigin,
      namespaceId: ready[0].id,
      modelDirectory,
      modelContainer,
      directory,
      runtimeImage: images.agent,
      codexSeccompProfile,
      kubernetesServer: "https://127.0.0.1:6443",
    }),
    { flag: "wx", mode: 0o600 },
  );
  const databaseUrl = await applicationDatabase(stack, system);

  // The test gets 30 minutes, its runner 38, then the owner checks retirement and cleanup.
  // Its raw result and runner diagnostics stay in the private directory. Publish only a pass
  // with the exact selected case, all required journey stages and allowlisted runner fields.
  phase = "run selected installed native Git test";
  await recordSkipperCheckpoint("skipper_stage", "selected-test");
  progress(phase);
  const runner = await run(
    process.execPath,
    upgrade
      ? [
          "--test",
          "--test-name-pattern",
          "^" + upgradeTest + "$",
          "tests/integration/skipper-prepared-git-installed.test.mjs",
        ]
      : [
          "scripts/ci/run-tests.mjs",
          "run",
          lane,
          "--state",
          join(directory, "runner-state.json"),
          "--results",
          privateResult,
        ],
    {
      env: {
        ...env,
        ...(upgrade ? { OCC_TEST_SKIPPER_UPGRADE: "1" } : {}),
        OCC_TEST_DATABASE_URL: databaseUrl,
        OCC_TEST_SKIPPER_COMPUTE_SERVICE_KEY: serviceKey,
        OCC_TEST_SKIPPER_COMPUTE_INPUTS: input,
        CI_RUNNER_TEST_TIMEOUT_MS: String(38 * minute),
      },
      timeout: (upgrade ? 100 : 42) * minute,
    },
  ).then(
    () => ({ status: 0 }),
    (error) => error.result ?? {},
  );
  if (upgrade) {
    const entries = await readSkipperJourney(join(directory, "compute-journey.jsonl"), false);
    const stages = entries.map((e) => e.phase);
    if (runner.status !== 0) {
      await writeFile(
        join(directory, "upgrade-test.log"),
        String(runner.stdout ?? "") + String(runner.stderr ?? ""),
        { mode: 0o600, flag: "wx" },
      );
      const last = stages.filter((s) => s.startsWith("upgrade-")).at(-1);
      console.error(
        "Installed upgrade failed at %s; inspect private evidence in %s",
        last ?? "baseline",
        directory,
      );
    }
    assert.equal(runner.status, 0);
    assert.ok(stages.includes("upgrade-continuity-verified"));
    assert.equal(stages.at(-1), "owned-agent-retired-cluster-cleanup-still-required");
    runnerReceipt = { upgrade: true };
  } else {
    runnerReceipt = await withdrawalReceipt(runner);
  }
} catch (error) {
  failed = true;
  if (upgrade) {
    await writeFile(join(directory, "upgrade-owner.log"), String(error.stack ?? error), {
      mode: 0o600,
      flag: "wx",
    });
    console.error("Private installed upgrade evidence: %s", directory);
  }
  // The error stack can include private subprocess stderr in its message.
  console.error(
    "Private Git acceptance failed: %s (%s)",
    phase,
    installerFailure ?? (error.code === "ERR_ASSERTION" ? "assertion failed" : "operation failed"),
  );
} finally {
  const hold = upgrade && (await upgradeNeedsRecovery(directory));
  if (hold) {
    failed = true;
    await closeDatabase?.();
    console.error(
      "Apply has no completion marker. Reconcile this installation and private evidence before cleanup: %s",
      directory,
    );
  }
  for (const release of hold ? [] : cleanup.reverse()) {
    try {
      await release();
    } catch {
      failed = true;
      cleanupFailed = true;
      console.error("Private Git acceptance: owned resource cleanup failed");
    }
  }
  if (!upgrade) {
    await rm(env.OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY, { recursive: true, force: true }).catch(
      async (error) => {
        await recordSkipperCheckpoint("skipper_installed_cleanup", "failed");
        throw error;
      },
    );
  }
  await recordSkipperCheckpoint(
    "skipper_installed_cleanup",
    cleanupFailed ? "failed" : clusterCleanupVerified ? "passed" : "unknown",
  );
}

if (failed || !runnerReceipt) {
  process.exitCode = 1;
} else if (upgrade) {
  assert.equal(clusterCleanupVerified, true);
  progress("installed upgrade passed; private evidence retained in " + directory);
} else {
  // No raw ledger, test output, Git/model traffic, database URLs, kubeconfig or diagnostics.
  // Retain only actual, passing runner evidence accepted by Full Integration's aggregator.
  await recordSkipperCheckpoint("skipper_stage", "write-success-receipt");
  const results = join(env.RUNNER_TEMP, "results");
  const receipt = {
    ...runnerReceipt,
    cleanup: { status: "passed" },
    lane,
    imageDigests,
    imageScope: skipperImageScope,
    proof: [...proof, "owned-cluster-and-synthetic-model-removed"],
  };
  await mkdir(results, { recursive: true });
  await writeFile(join(results, lane + ".json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    [
      "### Installed private Git acceptance",
      "",
      "Source: " + sourceCommit,
      "\nSelected test: 1 passed, 0 failed, 0 skipped.",
      ...proof.map((p) => "- " + p),
      "- Synthetic model removed and owned cluster deletion verified.",
      "",
    ].join("\n"),
  );
  await rm(directory, { recursive: true });
  progress("selected test 1 passed, 0 failed, 0 skipped; owned resources retired");
  await recordSkipperCheckpoint("skipper_stage", "finish-fixture");
}

async function withdrawalReceipt(runner) {
  const testFailed = runner.status !== 0;
  const resultText = testFailed ? await readFile(privateResult, "utf8").catch(() => "") : "";
  if (testFailed) {
    // Report only a known phase, source location, or failure category. Both raw streams
    // and the runner's private diagnostics can contain the synthetic credentials.
    const text =
      String(runner.stderr) +
      String(runner.stdout) +
      resultText +
      (await readFile(join(directory, "runner-state.json.diagnostics.json"), "utf8").catch(
        () => "",
      ));
    // Optional journey records may be incomplete when the test fails.
    console.error(
      "Installed test failed (%s, runner-exit=%s)",
      skipperFailureSummary(resultText, process.cwd(), text),
      runner.code ?? "unknown",
    );
  }
  const ledgerPath = join(directory, "compute-journey.jsonl");
  const failure = testFailed
    ? await recordSkipperTestFailure(
        resultText,
        ledgerPath,
        env.OCC_TEST_SKIPPER_TEAM_REVIEW === "1",
      )
    : undefined;
  const entries = failure?.entries ?? (await readSkipperJourney(ledgerPath, false));
  const records = entries.map((entry) => entry.phase);
  const observed = records.filter((p) => proof.includes(p));
  for (const name of observed) {
    progress(name);
  }
  if (failure) {
    if (failure.gatewayChat) {
      const { httpStatus, gatewayCategory, runtimeSignal, modelRequestObservation } =
        failure.gatewayChat;
      console.error(
        "Gateway HTTP %s, %s, %s. Synthetic model request: %s.",
        httpStatus ?? "unknown",
        gatewayCategory ?? "unknown",
        runtimeSignal ?? "unknown",
        modelRequestObservation ?? "unknown",
      );
    }
    if (records.includes("repository-binding-withdrawn-discovery-released")) {
      console.error("Repository binding withdrawn and held discovery released.");
    }
    const completion = entries.find((e) => e.phase === "native-command-completion-mismatch");
    if (completion) {
      console.error("Native command chat completion did not match the expected marker.");
      const { modelDiagnosticsAvailable, modelRequests, modelResults, markerSeen } = completion;
      if (
        modelDiagnosticsAvailable === true &&
        [modelRequests, modelResults].every((n) => Number.isSafeInteger(n) && n >= 0) &&
        typeof markerSeen === "boolean"
      ) {
        console.error(
          "Synthetic model requests=%d, results=%d, completion marker seen in native result=%s.",
          modelRequests,
          modelResults,
          markerSeen,
        );
      } else {
        console.error("Synthetic model completion diagnostics unavailable.");
      }
      const { nativePolls, nativeStatus, nativeExitCode, nativeSessionPresent } = completion;
      if (
        Number.isSafeInteger(nativePolls) &&
        nativePolls >= 0 &&
        ["running", "completed", "deadline", "unrecognized"].includes(nativeStatus) &&
        (nativeExitCode === null || Number.isInteger(nativeExitCode)) &&
        typeof nativeSessionPresent === "boolean"
      ) {
        console.error(
          "Native command status=%s, exit=%s, session present=%s, polls=%d.",
          nativeStatus,
          nativeExitCode,
          nativeSessionPresent,
          nativePolls,
        );
      }
    }
    const last = failure.last === "unknown" ? "before first test checkpoint" : failure.last;
    console.error("Last observed installed test checkpoint: %s", last);
    assert.fail("selected test runner failed");
  }
  await recordSkipperCheckpoint("skipper_stage", "verify-proof");
  assert.deepEqual(observed, proof);
  assert.equal(records.at(-1), proof.at(-1));
  const summary = await read(privateResult);
  assert.equal(summary.sourceSha, sourceCommit);
  assert.equal(summary.lane, lane);
  assert.equal(summary.status, "passed");
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(summary.counts, { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 });
  assert.deepEqual(summary.issues, []);
  return projectSkipperRunnerReceipt(summary);
}
