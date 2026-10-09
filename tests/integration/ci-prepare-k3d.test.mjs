import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { nodeLogExcerpt } from "../../scripts/ci/k3d-diagnostics.mjs";
import { defaultK3sImage } from "../../scripts/ci/prepare.mjs";
import {
  assertStderrMatch,
  digest,
  fixtureImageCommands,
  fixturePreparationMetrics,
  immutableImage,
  nodeBaseImage,
} from "../helpers/ci-prepare-fixture.mjs";

test("fixture preparation rejects an unknown proxy source before publishing its environment", async (t) => {
  const commands = await fixtureImageCommands(t, "missing-proxy-source");
  const result = commands.prepare();
  assert.equal(result.status, 1);
  assertStderrMatch(result.stderr, /Unable to determine the cross-node plugin status proxy source/);
  const state = JSON.parse(await readFile(commands.statePath, "utf8"));
  assert.equal(state.env, undefined);
  await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
  // Failed preparation retains ownership so cleanup can remove the partial cluster.
  const cleanup = commands.cleanup();
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
});

for (const { scenario, stage, error } of [
  {
    scenario: "nodes-unready",
    stage: "k3d-nodes-ready",
    error: /synthetic node readiness timeout$/,
  },
  {
    scenario: "nodes-unready-diagnostics-failed",
    stage: "k3d-nodes-ready",
    error: /synthetic node readiness timeout$/,
  },
  {
    scenario: "cluster-create-failed",
    stage: "k3d-create",
    error: /synthetic cluster creation failure$/,
  },
]) {
  test(`fixture preparation preserves bootstrap failure with bounded diagnostics: ${scenario}`, async (t) => {
    const commands = await fixtureImageCommands(t, scenario);
    const result = commands.prepare();
    assert.equal(result.error, undefined, "diagnostics must finish within the CLI watchdog");
    assert.equal(result.status, 1);
    assert.match(result.stderr.trim().split("\n").at(-1), error);

    const failedTiming = fixturePreparationMetrics(result.stderr).find(
      (metric) => metric.stage === stage && metric.status === "failed",
    );
    assert.ok(failedTiming, "the bootstrap failure must retain its measured stage");
    assert.ok(Number.isFinite(failedTiming.elapsedMs) && failedTiming.elapsedMs >= 0);

    const artifactPath = `${commands.statePath}.diagnostics.json`;
    const artifactText = await readFile(artifactPath, "utf8");
    const evidence = JSON.parse(artifactText);
    assert.equal(evidence.lane, "k3d-fixture-configuration");
    assert.equal(evidence.nodeImage, defaultK3sImage);
    if (scenario === "cluster-create-failed") {
      // Container diagnostics remain available before a kubeconfig can be written.
      for (const field of ["nodes", "pods", "events"]) {
        assert.equal(evidence[field].status, "unavailable");
      }
    } else {
      assert.equal(evidence.nodes.status, "ok");
      assert.match(JSON.stringify(evidence.nodes.value), /KubeletNotReady/);
    }
    assert.equal(evidence.containers.length, 2);
    for (const container of evidence.containers) {
      assert.equal(container.state.status, "ok");
      assert.equal(container.logs.status, "ok");
      assert.match(
        container.logs.value,
        /network plugin is not ready\n.*Error updating node status/s,
      );
      assert.doesNotMatch(container.logs.value, /localhost:8080 was refused/);
      assert.match(container.logs.value, /omitted 150 kubectl retry lines against localhost:8080/);
    }
    assert.doesNotMatch(artifactText, /do-not-publish/);
    assert.doesNotMatch(result.stderr, /do-not-publish/);
    if (scenario === "nodes-unready-diagnostics-failed") {
      assert.equal(evidence.pods.status, "unavailable");
      assert.equal(evidence.events.status, "timed-out");
    } else if (scenario === "nodes-unready") {
      assert.equal(evidence.pods.status, "ok");
      assert.match(JSON.stringify(evidence.pods.value), /Unschedulable/);
      assert.equal(evidence.events.status, "ok");
      assert.match(JSON.stringify(evidence.events.value), /FailedScheduling/);
    }

    // Failure must retain owned cleanup state without admitting workload execution.
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));
    const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
    assert.equal(evidence.cluster, cluster.name);
    assert.equal(cluster.status, "planned");
    assert.equal(state.env, undefined);
    await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
    const cleanup = commands.cleanup();
    assert.equal(cleanup.status, 0, cleanup.stderr);
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
    await assert.rejects(() => stat(cluster.directory), { code: "ENOENT" });
    assert.equal(await readFile(artifactPath, "utf8"), artifactText);
  });
}

// Linux reports an exited but unreaped process as a zombie; it holds nothing.
function processRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

async function hungK3dProcesses(commands) {
  const text = await readFile(join(dirname(commands.statePath), "hung-pids"), "utf8");
  return text.trim().split("\n").map(Number);
}

test("k3d preparation times out a hung cluster create, discards it and retries once", async (t) => {
  const commands = await fixtureImageCommands(t, "cluster-create-hangs-once", undefined, {
    OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "5000",
  });
  const result = commands.prepare();
  assert.equal(result.error, undefined, "a hung create must not reach the CLI watchdog");
  assert.equal(result.status, 0, result.stderr);
  assertStderrMatch(
    result.stderr,
    /k3d cluster create openclaw-k8s-\S+ did not finish within 5000 ms \(attempt 1 of 2\)/,
  );
  const stages = fixturePreparationMetrics(result.stderr)
    .filter(({ stage, status }) => stage.startsWith("k3d-create") && status !== "started")
    .map(({ stage, status }) => `${stage}:${status}`);
  assert.deepEqual(stages, ["k3d-create:failed", "k3d-create-discard:passed", "k3d-create:passed"]);
  for (const pid of await hungK3dProcesses(commands)) {
    assert.equal(processRunning(pid), false, `hung k3d process ${pid} must not survive`);
  }

  // The retry reuses the owned name, deleting the first attempt before creating again.
  const k3d = (await commands.commands())
    .filter(({ command, args }) => command === "k3d" && args[0] === "cluster")
    .map(({ args }) => args.slice(0, 2).join(" "));
  const firstCreate = k3d.indexOf("cluster create");
  const secondCreate = k3d.indexOf("cluster create", firstCreate + 1);
  assert.ok(secondCreate > firstCreate);
  assert.ok(k3d.slice(firstCreate, secondCreate).includes("cluster delete"));
  const evidence = JSON.parse(await readFile(`${commands.statePath}.diagnostics.json`, "utf8"));
  assert.match(evidence.failure, /\(attempt 1 of 2\)$/);

  const state = JSON.parse(await readFile(commands.statePath, "utf8"));
  const clusters = state.resources.filter(({ kind }) => kind === "k3d-cluster");
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].status, "ready");
  const cleanup = commands.cleanup();
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
});

test("k3d preparation stops waiting for create output held outside its process group", async (t) => {
  const commands = await fixtureImageCommands(t, "cluster-create-hangs-escaped", undefined, {
    OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "4000",
  });
  const escapedPids = join(dirname(commands.statePath), "escaped-pids");
  t.after(async () => {
    const text = await readFile(escapedPids, "utf8").catch(() => "");
    for (const pid of text.split("\n").map(Number)) {
      if (!Number.isInteger(pid) || pid <= 0) {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  const result = commands.prepare();
  assert.equal(result.error, undefined, "held output must not reach the CLI watchdog");
  assert.equal(result.status, 0, result.stderr);
  const timings = fixturePreparationMetrics(result.stderr).filter(
    ({ stage, status }) => stage.startsWith("k3d-create") && status !== "started",
  );
  assert.deepEqual(
    timings.map(({ stage, status }) => `${stage}:${status}`),
    ["k3d-create:failed", "k3d-create-discard:passed", "k3d-create:passed"],
  );
  // SIGTERM is ignored: SIGKILL follows after 5 s, and the held pipes are
  // abandoned 5 s later.
  assert.ok(timings[0].elapsedMs >= 13_500, `first attempt ended after ${timings[0].elapsedMs} ms`);
  for (const pid of await hungK3dProcesses(commands)) {
    assert.equal(processRunning(pid), false, `hung k3d process ${pid} must not survive`);
  }
  const cleanup = commands.cleanup();
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("k3d preparation fails clearly when every cluster create attempt hangs", async (t) => {
  const commands = await fixtureImageCommands(t, "cluster-create-hangs", undefined, {
    OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "3000",
  });
  const result = commands.prepare();
  assert.equal(result.error, undefined, "a hung create must not reach the CLI watchdog");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr.trim().split("\n").at(-1),
    /^k3d cluster create openclaw-k8s-\S+ did not finish within 3000 ms \(attempt 2 of 2\); giving up\./,
  );
  for (const pid of await hungK3dProcesses(commands)) {
    assert.equal(processRunning(pid), false, `hung k3d process ${pid} must not survive`);
  }
  const creates = (await commands.commands()).filter(
    ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "create",
  );
  assert.equal(creates.length, 2);
  const evidence = JSON.parse(await readFile(`${commands.statePath}.diagnostics.json`, "utf8"));
  assert.match(evidence.failure, /\(attempt 2 of 2\)$/);
  assert.equal(evidence.containers.length, 2);

  // The partial cluster stays registered for cleanup; nothing is published.
  const state = JSON.parse(await readFile(commands.statePath, "utf8"));
  const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
  assert.equal(cluster.status, "planned");
  assert.equal(state.env, undefined);
  await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
  const cleanup = commands.cleanup();
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
  await assert.rejects(() => stat(cluster.directory), { code: "ENOENT" });
});

test("k3d node log excerpts stay bounded and keep the start, later errors and the end", () => {
  const at = (second) => new Date(Date.UTC(2026, 8, 23, 0, 0, second)).toISOString();
  const info = (second) =>
    `${at(second)} I0923 kubelet.go:1] "fixture progress ${second}" ${"x".repeat(200)}`;
  const stdout = [
    // An output cap can start a stream mid-line, past the keyword of a credential.
    "=do-not-publish-cut-credential more",
    `${at(0)} level=info msg="Starting k3s agent fixture"`,
    ...Array.from({ length: 4_000 }, (_, second) => info(second + 1)),
    `${at(4_001)} level=info msg="fixture end of log"`,
  ].join("\n");
  const stderr = [
    `${at(2_000)} E0923 kubelet_node_status.go:1] "Error updating node status" err="fixture lease"`,
    `${at(2_001)} level=error msg="fixture join token=do-not-publish-node-token"`,
    // The credential keyword sits past the 1000-character line cut.
    `${at(2_001)} level=warning msg="do-not-publish-long-line ${"y".repeat(1_100)} password=hidden"`,
    ...Array.from(
      { length: 500 },
      (_, index) => `${at(2_002 + index)} The connection to the server localhost:8080 was refused`,
    ),
  ].join("\n");
  const excerpt = nodeLogExcerpt(stdout, stderr);
  assert.ok(excerpt.length < 42_000, `excerpt has ${excerpt.length} characters`);
  assert.match(excerpt, /^\[diagnostics dropped 1 unstamped line fragments\]\n/);
  assert.match(excerpt, /\n\[diagnostics omitted 500 kubectl retry lines against localhost:8080/);
  assert.match(excerpt, /Starting k3s agent fixture/);
  assert.match(excerpt, /Error updating node status/);
  assert.match(excerpt, /\[redacted credential-bearing line\]/);
  assert.match(excerpt, /fixture end of log"$/);
  assert.match(excerpt, /\[diagnostics omitted \d+ lines; 3 of 3 error and warning lines/);
  assert.doesNotMatch(excerpt, /do-not-publish|localhost:8080 was refused/);
});

for (const scenario of ["storage-unready", "storage-after-image-unready"]) {
  test(`fixture preparation reports unavailable storage without publishing workload inputs: ${scenario}`, async (t) => {
    const commands = await fixtureImageCommands(t, scenario);
    const result = commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(result.stderr, /CI fixture storage controller is not ready/);
    assertStderrMatch(result.stderr, /CrashLoopBackOff/);
    assertStderrMatch(result.stderr, /fixture configuration rejected/);
    assertStderrMatch(result.stderr, /Unschedulable/);
    assertStderrMatch(result.stderr, /KubeletHasDiskPressure/);
    assert.doesNotMatch(result.stderr, /do-not-publish-pod-spec/);
    await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));
    assert.equal(state.env, undefined);
    const cleanup = commands.cleanup();
    assert.equal(cleanup.status, 0, cleanup.stderr);
  });
}

test("k3d preparation reuses only matching local immutable images and verifies fresh pulls", async (t) => {
  for (const scenario of [
    "local-digest",
    "image-absent",
    "podman-image-absent",
    "image-absent-late-stderr",
    "local-mismatch",
    "pull-mismatch",
    "inspect-failed",
  ]) {
    const commands = await fixtureImageCommands(t, scenario, "k3d-model", {
      NODE_BASE_IMAGE: nodeBaseImage,
      // Supply the controller artifact so this case isolates image import, not its build.
      OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
      OPENAI_API_KEY: "test-only-key",
      OCC_TEST_OPENAI_MODEL: "test-model",
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
      OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
      // Stop at the next independent preparation boundary after image import.
      OCC_TEST_KUBERNETES_CODEX_VERSION: "0.153.0",
    });
    const result = commands.prepare();
    assert.equal(result.status, 1);
    const calls = await commands.commands();
    const pulls = calls.filter(
      ({ command, args }) => ["docker", "podman"].includes(command) && args[0] === "pull",
    );
    assert.equal(
      pulls.length,
      ["local-digest", "inspect-failed"].includes(scenario) ? 0 : 1,
      scenario,
    );
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));
    const imported = state.resources.filter(({ kind }) => kind === "k3d-image");
    if (scenario === "pull-mismatch") {
      assertStderrMatch(result.stderr, /pull did not materialize the requested registry digest/);
      assert.equal(imported.length, 0);
    } else if (scenario === "inspect-failed") {
      assertStderrMatch(result.stderr, /Cannot connect to the Docker daemon/);
      assert.equal(imported.length, 0);
    } else {
      assertStderrMatch(result.stderr, /limited to reviewed Codex versions/);
      assert.equal(imported.length, 1);
      assert.equal(imported[0].status, "ready");
      assert.equal(imported[0].sourceImage, immutableImage);
      assert.equal(imported[0].hostImageId, `sha256:${"b".repeat(64)}`);
    }
    const cleanup = commands.cleanup();
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.ok(
      !(await commands.commands()).some(
        ({ args }) => args[0] === "image" && args[1] === "rm" && args.includes(immutableImage),
      ),
      "cleanup must preserve the caller's immutable source image",
    );
  }
});

test("k3d preparation times out a hung host image command and never pulls for it", async (t) => {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const imported = String.raw`localhost/\S+`;
  for (const [scenario, shown] of [
    ["hung-host-digests", escape(`image inspect --format {{json .RepoDigests}} ${immutableImage}`)],
    ["hung-host-id", escape(`image inspect --format {{.Id}} ${immutableImage}`)],
    ["hung-host-tag", `${escape(`tag ${immutableImage} `)}${imported}`],
    [
      "hung-host-platform",
      `${escape("image inspect --format {{.Os}}/{{.Architecture}} ")}${imported}`,
    ],
  ]) {
    const commands = await fixtureImageCommands(t, scenario, "k3d-model", {
      NODE_BASE_IMAGE: nodeBaseImage,
      OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
      OPENAI_API_KEY: "test-only-key",
      OCC_TEST_OPENAI_MODEL: "test-model",
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
      OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
      OCC_TEST_KUBERNETES_CODEX_VERSION: "0.153.0",
      OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
    });
    const result = commands.prepare();
    assert.equal(result.status, 1, scenario);
    assertStderrMatch(
      result.stderr,
      new RegExp(String.raw`The container engine did not answer within 3000 ms \(${shown}\)\.`),
      scenario,
    );
    // A timeout is not an absent image: nothing pulls, and nothing reaches the cluster.
    const calls = await commands.commands();
    assert.equal(
      calls.filter(
        ({ command, args }) => ["docker", "podman"].includes(command) && args[0] === "pull",
      ).length,
      0,
      scenario,
    );
    assert.equal(
      calls.some(({ args }) => args[0] === "exec" && args[1] === "-i"),
      false,
      scenario,
    );
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));
    assert.equal(
      state.resources.some(({ kind, status }) => kind === "k3d-image" && status === "ready"),
      false,
      scenario,
    );
    const cleanup = commands.cleanup();
    assert.equal(cleanup.status, 0, cleanup.stderr);
  }
});

test("fixture preparation times out a hung inspect of its own fixture image", async (t) => {
  const commands = await fixtureImageCommands(t, "hung-host-owned", undefined, {
    OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
  });
  const result = commands.prepare();
  assert.equal(result.status, 1);
  assertStderrMatch(
    result.stderr,
    /The container engine did not answer within 3000 ms \(image inspect localhost\/\S+\/fixture:local\)\./,
  );
  const cleanup = commands.cleanup();
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("ordinary k3d preparation forwards an immutable K3s override and retains the server version gate", async (t) => {
  const image = `registry.example/k3s:v1.35.8-k3s1@sha256:${digest}`;
  for (const scenario of ["success", "wrong-server-version"]) {
    const commands = await fixtureImageCommands(t, scenario, "k3d-fixture-configuration", {
      OPENCLAW_CI_K3S_IMAGE: image,
    });
    const result = commands.prepare();
    assert.equal(result.status, scenario === "success" ? 0 : 1, result.stderr);
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));
    const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
    assert.equal(cluster.nodeImage, image);
    if (scenario === "success") {
      assert.equal(cluster.kubernetesVersion, "v1.35.8+k3s1");
    } else {
      assertStderrMatch(result.stderr, /must resolve to Kubernetes 1\.35\.x/);
      // The fixture build overlaps cluster creation; nothing reaches the cluster.
      assert.equal(
        (await commands.commands()).some(({ args }) => args[0] === "exec" && args[1] === "-i"),
        false,
      );
      assert.equal(
        state.resources.some(({ kind }) => kind === "k3d-image"),
        false,
      );
      assert.equal(state.env, undefined);
    }
    const cleanup = commands.cleanup();
    assert.equal(cleanup.status, 0, cleanup.stderr);
  }
});
