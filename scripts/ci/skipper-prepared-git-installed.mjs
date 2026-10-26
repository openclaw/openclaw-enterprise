/**
 * The private Git fixture owns the origin and invokes this once on a fresh hosted runner.
 * Keep raw setup, test, credentials and journey records private. Release the aggregate's
 * result only after the selected test, its evidence, and removal of the owned cluster succeed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { teamReviewProof } from "../../tests/fixtures/skipper-team-review-journey.mjs";
import { imageConfigDigest } from "./image-config-digest.mjs";
import { createInterface } from "node:readline";
import {
  kubectl,
  modelContainer,
  routeModelProvider,
  run,
  startLocalSetup,
  workDirectory,
} from "./first-agent-smoke.mjs";

const env = process.env;
const lane = "skipper-prepared-git-installed";
const minute = 60_000;
const read = async (path) => JSON.parse(await readFile(path));
const output = async (command, args) => (await run(command, args)).stdout.trim();
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
assert.match(registry, /^[a-f0-9]{64}$/);
const cleanup = [() => run("docker", ["rm", "--force", "--volumes", registry])];
const proof = [
  "deployed-revision-gateway-and-harness-ready",
  "chat-before-private-git-verified",
  "prepared-before-native-git",
  ...(env.OCC_TEST_SKIPPER_TEAM_REVIEW === "1"
    ? teamReviewProof
    : ["native-commit-confirmed-by-independent-fetch"]),
  "wrong-repository-hook-refusal-and-broker-denied-mixed-push",
  "native-authenticated-post-after-withdrawal-refused",
  "fresh-authenticated-fetch-after-effective-withdrawal-refused",
  "same-compute-owned-skipper-chat-after-git-withdrawal-verified",
  "same-compute-owned-skipper-chat-git-and-live-withdrawal-observed",
  "owned-agent-retired-cluster-cleanup-still-required",
];
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
  cleanup.push(async () => {
    forward.kill();
    await exited;
  });
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
async function checkImage(stack, selected, built) {
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
  assert.equal(local.Config.Labels["org.opencontainers.image.revision"], sourceCommit);
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

let phase = "fresh cluster preflight";
let failed = false;
let summary;
let imageDigests;
try {
  await noCluster();
  phase = "install checkout images, prepared repository service and fresh application database";
  progress(phase);
  const stack = await startLocalSetup(install, { privateInstall: true });
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
    await run("bin/occ", ["dev", "down"], { env: install, timeout: 12 * minute });
    await noCluster();
    for (const port of [6443, 3000, 8443]) {
      const server = createServer().listen(port, "127.0.0.1");
      await once(server, "listening");
      server.close();
      await once(server, "close");
    }
    progress("owned cluster and network removed; installation ports released");
  });

  phase = "bind installed image identities and model fixture";
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
  imageDigests = {
    controller: await checkImage(
      stack,
      helm.images.controller,
      env.OCC_DEVELOPMENT_CONTROLLER_IMAGE,
    ),
    runtime: await checkImage(stack, images.agent, env.OCC_KUBERNETES_RUNTIME_IMAGE),
    repository: await checkImage(
      stack,
      helm.repositoryCredentials.image,
      env.OCC_DEVELOPMENT_REPOSITORY_IMAGE,
    ),
  };
  progress("installed controller, agent, gateway and repository image identities verified");
  const modelDirectory = env.OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY;
  await routeModelProvider(stack, modelDirectory, env.OCC_KUBERNETES_RUNTIME_IMAGE, {
    journey: "PROBE_SKIPPER_PREPARED_COMPUTE",
    cleanup,
  });

  phase = "bind application database, namespace and owned cluster UID";
  const system = state.platformNamespace;
  const apiOrigin = stack.origin;
  const serviceKey = (await read(stack.keyPath)).data.key;
  const namespaces = await stack.api("GET", "/namespaces");
  const ready = namespaces.filter((n) => n.name === "default" && n.status === "ready");
  assert.equal(ready.length, 1);
  const input = join(directory, "test-input.json");
  await writeFile(
    input,
    JSON.stringify({
      sourceCommit,
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
  progress(phase);
  const runner = await run(
    process.execPath,
    [
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
        OCC_TEST_DATABASE_URL: databaseUrl,
        OCC_TEST_SKIPPER_COMPUTE_SERVICE_KEY: serviceKey,
        OCC_TEST_SKIPPER_COMPUTE_INPUTS: input,
        CI_RUNNER_TEST_TIMEOUT_MS: String(38 * minute),
      },
      timeout: 42 * minute,
    },
  ).then(
    () => ({ status: 0 }),
    (error) => error.result ?? {},
  );
  const ledger = await readFile(join(directory, "compute-journey.jsonl"), "utf8").catch(() => "");
  const entries = ledger
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const records = entries.map((entry) => entry.phase);
  const observed = records.filter((p) => proof.includes(p));
  for (const name of observed) {
    progress(name);
  }
  if (runner.status !== 0) {
    // Report only a known phase, source location, or failure category. Both raw streams
    // and the runner's private diagnostics can contain the synthetic credentials.
    const text =
      String(runner.stderr) +
      String(runner.stdout) +
      (await readFile(privateResult, "utf8").catch(() => "")) +
      (await readFile(join(directory, "runner-state.json.diagnostics.json"), "utf8").catch(
        () => "",
      ));
    const chat = entries.find((e) => e.phase === "gateway-chat-refused");
    if (chat) {
      const { httpStatus, category, modelTurns, modelAnswers, expectedNonceAnswered, tlsErrors } =
        chat;
      assert.ok(
        httpStatus === 0 ||
          (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599),
      );
      assert.match(
        category,
        /^(gateway-credential-unavailable|authentication|permission|workspace|agent-runtime|timeout|unavailable|unclassified)$/,
      );
      assert.ok(
        [modelTurns, modelAnswers, tlsErrors].every((n) => Number.isSafeInteger(n) && n >= 0),
      );
      assert.equal(typeof expectedNonceAnswered, "boolean");
      assert.match(
        chat.runtimeSignal,
        /^(thread-filesystem-sandbox-denied|thread-start|model-transport|no-known-signal|logs-unavailable)$/,
      );
      console.error(
        "Gateway HTTP %d, %s, %s. During this request synthetic model turns=%d, answers=%d, expected nonce answered=%s, TLS errors=%d.",
        httpStatus,
        category,
        chat.runtimeSignal,
        modelTurns,
        modelAnswers,
        expectedNonceAnswered,
        tlsErrors,
      );
    }
    const known = [
      ...proof.slice(0, -1), // Retirement can follow a failure before the required proof.
      "create-synthetic-model-secret",
      "deploy-request-started",
      "observe-installed-agent-readonly-skill-directories",
      "gateway-chat-refused",
      "native-command-started",
      "native-command-and-model-observed",
    ];
    const last = records.filter((p) => known.includes(p)).at(-1) ?? "before first test checkpoint";
    const site = text.match(
      /(?:skipper-prepared-compute|skipper-prepared-git-installed\.test)\.mjs:\d+:\d+/,
    )?.[0];
    const category = text.match(
      /RTM_NEWADDR|bwrap|native command failed|missing-env|test-timeout|expected-test-not-passed|selected-zero|timed out:|ERR_ASSERTION/,
    )?.[0];
    console.error(
      "Installed test failed after %s (%s, %s, exit=%s)",
      last,
      site ?? "location unavailable",
      category ?? "unclassified",
      runner.code ?? "unknown",
    );
    assert.fail("selected test runner failed");
  }
  assert.deepEqual(observed, proof);
  assert.equal(records.at(-1), proof.at(-1));
  summary = await read(privateResult);
  assert.equal(summary.sourceSha, sourceCommit);
  assert.equal(summary.lane, lane);
  assert.equal(summary.status, "passed");
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(summary.counts, { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 });
  assert.deepEqual(summary.issues, []);
} catch (error) {
  failed = true;
  // File and line are useful on a failed guard. Never print values, runner or subprocess output.
  const location = String(error.stack).match(/skipper-prepared-git-installed\.mjs:\d+:\d+/)?.[0];
  // The installer can report a failed stage on either stream. Publish only fixed categories.
  const { stdout = "", stderr = error.message } = error.result ?? {};
  const detail = stdout + "\n" + stderr;
  const category = detail.match(
    /RTM_NEWADDR|bwrap|ImagePullBackOff|ErrImagePull|CrashLoopBackOff|timed out|deadline exceeded|connection refused|permission denied|not ready|BackoffLimitExceeded|pre-install hooks failed|pre-upgrade hooks failed|catalog objects or effective grants differ/i,
  )?.[0];
  console.error(
    "Private Git acceptance failed: %s (%s, %s)",
    phase,
    location ?? "location unavailable",
    category ?? (error.code === "ERR_ASSERTION" ? "assertion failed" : "operation failed"),
  );
} finally {
  for (const release of cleanup.reverse()) {
    try {
      await release();
    } catch {
      failed = true;
      console.error("Private Git acceptance: owned resource cleanup failed");
    }
  }
  await rm(env.OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY, { recursive: true, force: true });
}

if (failed) {
  process.exitCode = 1;
} else {
  // No raw ledger, test output, Git/model traffic, database URLs, kubeconfig or diagnostics.
  // Retain only actual, passing runner evidence accepted by Full Integration's aggregator.
  const results = join(env.RUNNER_TEMP, "results");
  const { version, command, sourceSha, status, counts, exitCode } = summary;
  assert.equal(summary.files.length, 1);
  const [{ path, cleanup: testCleanup, tests }] = summary.files;
  assert.equal(path, `tests/integration/${lane}.test.mjs`);
  assert.deepEqual(testCleanup, { status: "passed" });
  assert.deepEqual(
    tests.map((test) => test.status),
    ["passed"],
  );
  const [{ name, durationMs }] = tests;
  const receipt = {
    version,
    command,
    lane,
    sourceSha,
    status,
    counts,
    exitCode,
    imageDigests,
    files: [{ path, status, counts, cleanup: testCleanup, tests: [{ name, status, durationMs }] }],
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
}
