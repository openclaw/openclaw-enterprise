import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  readSkipperJourney,
  recordSkipperCheckpoint,
  recordSkipperTestFailure,
} from "../../scripts/ci/skipper-failure-receipt.ts";
import reporter from "../../scripts/ci/reporter.mjs";
import { createSkipperPreparedComputeEvents } from "../fixtures/skipper-prepared-compute-model.mjs";
import { inGateway, sendSkipperChat } from "../helpers/skipper-prepared-compute.mjs";

const lane = "skipper-prepared-git-installed";
const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const counts = { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 };
const selection = {
  sourceSha,
  images: {
    controller: "sha256:" + "1".repeat(64),
    runtime: "sha256:" + "2".repeat(64),
    repository: "sha256:" + "3".repeat(64),
  },
};
function receipt() {
  // Built manifests independently match the control. Imported manifests and config IDs differ.
  const image = (digit: string) => ({
    built: "sha256:" + digit.repeat(64),
    installed: "sha256:" + "4".repeat(64),
    config: "sha256:" + "5".repeat(64),
  });
  return {
    version: 1,
    command: "run",
    lane,
    sourceSha,
    status: "passed",
    exitCode: 0,
    counts,
    imageScope: "checkout-images-with-synthetic-model-trust-layer",
    imageDigests: { controller: image("1"), runtime: image("2"), repository: image("3") },
    files: [
      {
        path: "tests/integration/skipper-prepared-git-installed.test.mjs",
        status: "passed",
        counts,
        cleanup: { status: "passed" },
        tests: [
          {
            name: "same Compute-owned Skipper chats, authors private Git, loses Git during an authenticated fetch, and still chats",
            status: "passed",
            durationMs: 1,
          },
        ],
      },
    ],
    proof: [
      "deployed-revision-gateway-and-harness-ready",
      "chat-before-private-git-verified",
      "prepared-before-native-git",
      "native-commit-confirmed-by-independent-fetch",
      "wrong-repository-hook-refusal-and-broker-denied-mixed-push",
      "native-authenticated-post-after-withdrawal-refused",
      "fresh-authenticated-fetch-after-effective-withdrawal-refused",
      "same-compute-owned-skipper-chat-after-git-withdrawal-verified",
      "same-compute-owned-skipper-chat-git-and-live-withdrawal-observed",
      "owned-agent-retired-cluster-cleanup-still-required",
      "owned-cluster-and-synthetic-model-removed",
    ],
  };
}

test("aggregate qualifies only the independently selected Skipper image set with complete installed proof", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skipper-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const control = join(directory, "release.json");
  const imageEnvironment = {
    OCC_DEVELOPMENT_CONTROLLER_IMAGE: `127.0.0.1:5000/oce-smoke/controller@${selection.images.controller}`,
    OCC_KUBERNETES_RUNTIME_IMAGE: `127.0.0.1:5000/oce-smoke/runtime@${selection.images.runtime}`,
    OCC_DEVELOPMENT_REPOSITORY_IMAGE: `127.0.0.1:5000/oce-smoke/repository@${selection.images.repository}`,
  };
  const summary = join(directory, "summary.md");
  const exported = join(directory, "environment");
  function produce(file: string, overrides: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(
      process.execPath,
      ["scripts/ci/first-agent-smoke.mjs", "release-selection", file],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          GITHUB_SHA: "f".repeat(40), // The producer must use checked-out HEAD.
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_ENV: exported,
          ...imageEnvironment,
          ...overrides,
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.stdout, "");
    return result;
  }
  for (const [name, value] of [
    ["OCC_DEVELOPMENT_CONTROLLER_IMAGE", undefined],
    ["OCC_KUBERNETES_RUNTIME_IMAGE", "127.0.0.1:5000/oce-smoke/runtime@sha256:short"],
    ["OCC_DEVELOPMENT_REPOSITORY_IMAGE", imageEnvironment.OCC_DEVELOPMENT_CONTROLLER_IMAGE],
  ] as const) {
    const invalid = join(directory, "invalid.json");
    const result = produce(invalid, { [name]: value });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${name} must be a SHA-256 image digest reference`));
    assert.ok(!result.stderr.includes("127.0.0.1"));
    await assert.rejects(readFile(invalid), { code: "ENOENT" });
  }
  const produced = produce(control);
  assert.equal(produced.status, 0, produced.stderr);
  assert.equal(produced.stderr, "");
  assert.deepEqual(JSON.parse(await readFile(control, "utf8")), selection);
  await assert.rejects(readFile(summary), { code: "ENOENT" });
  await assert.rejects(readFile(exported), { code: "ENOENT" });
  const args = ["scripts/ci/run-tests.mjs", "aggregate", lane, "--results-dir", directory];
  async function aggregate(evidence: unknown, expected: unknown = selection, mode = "qualify") {
    await writeFile(join(directory, lane + ".json"), JSON.stringify(evidence));
    if (mode !== "produced") {
      await writeFile(control, JSON.stringify(expected));
    }
    const result = spawnSync(
      process.execPath,
      [
        ...args,
        ...(mode === "smoke"
          ? []
          : ["--release-selection", mode === "missing" ? control + ".missing" : control]),
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: process.env.PATH, GITHUB_SHA: sourceSha },
      },
    );
    assert.equal(result.error, undefined);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, output.status === "passed" ? 0 : 1, result.stderr);
    return output;
  }
  const passed = await aggregate(receipt(), selection, "produced");
  assert.equal(passed.status, "passed");
  assert.deepEqual(passed.releaseQualification, {
    ...selection,
    imageScope: "checkout-images-with-synthetic-model-trust-layer",
  });
  const smoke = await aggregate(receipt(), selection, "smoke");
  assert.equal(smoke.status, "passed");
  assert.equal(
    smoke.releaseQualification,
    undefined,
    "ordinary smoke does not qualify a selected release",
  );
  const denied = async (evidence: unknown, expected: unknown = selection, mode = "qualify") => {
    const output = await aggregate(evidence, expected, mode);
    assert.equal(output.status, "failed");
    assert.equal(output.releaseQualification, undefined);
    assert.ok(
      output.issues.some((issue: { code: string }) => issue.code === "skipper-release-mismatch"),
    );
  };
  await denied(receipt(), selection, "missing");
  await denied(receipt(), {});
  await denied(receipt(), { ...selection, sourceSha: "a".repeat(40) });
  // Reject another commit's receipt before attempting release qualification.
  const stale = await aggregate({ ...receipt(), sourceSha: "b".repeat(40) });
  assert.equal(stale.status, "failed");
  assert.equal(stale.releaseQualification, undefined);
  assert.deepEqual(stale.lanes, []);
  assert.deepEqual(
    stale.issues.map((issue: { code: string }) => issue.code),
    ["source-sha-mismatch"],
  );
  await denied({ ...receipt(), imageScope: undefined });
  await denied({ ...receipt(), imageScope: "published-images" });
  for (const role of ["controller", "runtime", "repository"] as const) {
    await denied(receipt(), { ...selection, images: { ...selection.images, [role]: undefined } });
    await denied(receipt(), {
      ...selection,
      images: { ...selection.images, [role]: "sha256:" + "9".repeat(64) },
    });
    await denied({ ...receipt(), imageDigests: { ...receipt().imageDigests, [role]: undefined } });
    for (const field of ["built", "installed", "config"] as const) {
      const missing = receipt();
      Reflect.deleteProperty(missing.imageDigests[role], field);
      await denied(missing);
      const malformed = receipt();
      malformed.imageDigests[role][field] = "latest";
      await denied(malformed);
    }
  }
  for (let index = 0; index < receipt().proof.length; index++) {
    const missing = receipt();
    missing.proof.splice(index, 1);
    await denied(missing);
  }
  const duplicate = receipt();
  duplicate.proof.push(duplicate.proof[0]!);
  await denied(duplicate);
  const failedCleanup = receipt();
  failedCleanup.files[0]!.cleanup.status = "failed";
  await denied(failedCleanup);
  const skipped = receipt();
  skipped.files[0]!.tests[0]!.status = "skipped";
  await denied(skipped);
  const raw = receipt();
  for (const field of ["proof", "imageDigests", "imageScope"]) {
    Reflect.deleteProperty(raw, field);
  }
  await denied(raw);
  // The hosted producer uses the team-review variant of the same complete journey.
  const team = receipt();
  team.proof.splice(
    3,
    1,
    "controlled-draft-and-tested-commit-observed",
    "review-feedback-advanced-same-draft",
    "later-turn-reauthorized-and-advanced-same-draft",
  );
  assert.equal((await aggregate(team)).status, "passed");
});

test("installed Skipper receiver reports failures without exposing response content", async (t) => {
  function shortenGatewayDeadline() {
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => timeout(ms === 170_000 ? 1_000 : ms);
  }
  for (const [scenario, status, category] of [
    ["transport", 0, "transport"],
    ["client-deadline", 0, "client-deadline"],
    ["http-timeout", 504, "timeout"],
    ["body", 200, "response-body"],
    ["json", 200, "response-json"],
    ["http", 403, "permission"],
    ["success", 200, undefined],
  ] as const) {
    await t.test(scenario, async (t) => {
      const canary = "private-response-content";
      // Real sockets exercise fetch rejection, interrupted body reads and JSON parsing.
      let requests = 0;
      const server = createServer((req, res) => {
        requests++;
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/v1/chat/completions");
        assert.equal(req.headers.authorization, "Bearer synthetic-receiver-key");
        req.resume();
        if (scenario === "client-deadline") {
          return; // Leave headers unsent until the client aborts.
        }
        if (scenario === "transport") {
          req.socket.destroy();
        } else if (scenario === "body") {
          res.writeHead(200, { "content-length": 1000 });
          res.write(canary);
          setTimeout(() => res.destroy(), 50);
        } else if (scenario === "json") {
          res.end(canary);
        } else if (scenario === "http-timeout") {
          res.writeHead(504);
          res.end("timed out " + canary);
        } else if (scenario === "http") {
          res.writeHead(403);
          res.end("permission denied " + canary);
        } else {
          res.end(JSON.stringify({ choices: [{ message: { content: "reply" } }] }));
        }
      });
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      // Serialize the same receiver that kubectl executes, without a fake fetch implementation.
      const clock =
        scenario === "client-deadline" ? `(${shortenGatewayDeadline.toString()})();` : "";
      const result = await promisify(execFile)(
        process.execPath,
        ["-e", `${clock}\n(${inGateway.toString()})("prompt", "session")`],
        {
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            OPENCLAW_GATEWAY_PASSWORD: "synthetic-receiver-key",
            OPENCLAW_GATEWAY_PORT: String(address.port),
          },
        },
      );
      assert.equal(requests, 1);
      assert.equal(result.stderr, "");
      assert.deepEqual(
        JSON.parse(result.stdout),
        scenario === "transport"
          ? { status, category, gatewayTransportCause: "socket-closed" }
          : category
            ? { status, category }
            : { status, content: "reply" },
      );
      assert.ok(!result.stdout.includes(canary));
    });
  }
});

test("private Git installer retains its process exit through wrapper cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skipper-install-exit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  const bin = join(checkout, "bin");
  const work = join(directory, "work");
  const model = join(directory, "model");
  const exec = promisify(execFile);

  // Give the owner a clean source identity and an isolated CLI without touching the developer's bin/occ.
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await cp("scripts/ci", join(checkout, "scripts/ci"), { recursive: true });
  for (const path of ["scripts/lib", "apps", "tests", "go.mod", "compose.yaml", "package.json"]) {
    await symlink(resolve(path), join(checkout, path));
  }
  await mkdir(bin);
  await mkdir(work);
  await mkdir(model);
  await exec("go", ["build", "-trimpath", "-o", join(directory, "occ"), "./cmd/occ"]);
  // Child output can resemble a stack frame or describe a healthy sandbox check.
  const locationMarker = "skipper-prepared-git-installed.mjs:7314:8652";
  await writeFile(
    join(bin, "occ"),
    `#!/bin/bash
echo "bwrap check passed"
echo "${locationMarker}" >&2
exec "$TEST_OCC" "$@" 2> >(tee "$TEST_INSTALL_STDERR" >&2)
`,
    { mode: 0o700 },
  );
  // Isolate the owner's Docker inventory and cleanup. Any installer call to Docker fails the oracle.
  const registry = "0".repeat(64);
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh
case "$*" in
  'ps -a --format {{.Names}}'|'network ls --format {{.Name}}'|'rm --force --volumes ${registry}') ;;
  *) echo unexpected >> "$TEST_DOCKER_CALLS"; exit 97 ;;
esac
echo "$1" >> "$TEST_DOCKER_CALLS"
`,
    { mode: 0o700 },
  );
  const git = (...args: string[]) => exec("git", args, { cwd: checkout });
  await git("init", "--quiet");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Install fixture",
  );
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  const stepOutput = join(directory, "step-output");
  const calls = join(directory, "docker-calls");
  const env = {
    PATH: bin + ":" + process.env.PATH,
    GITHUB_ACTIONS: "true",
    GITHUB_SHA: head,
    GITHUB_RUN_ID: "15",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_OUTPUT: stepOutput,
    OCC_FIRST_AGENT_SMOKE_DIRECTORY: work,
    OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY: model,
    OCC_TEST_SKIPPER_PRIVATE_GIT_WITNESS: "unused",
    OCC_DEVELOPMENT_REPOSITORY_IMAGE: "unused",
    OCC_SKIPPER_IMAGE_REGISTRY_CONTAINER: registry,
    TEST_OCC: join(directory, "occ"),
    TEST_INSTALL_STDERR: join(directory, "installer-stderr"),
    TEST_DOCKER_CALLS: calls,
    // CheckDevelopmentProfile rejects this retired selector before dispatch to Kubernetes.
    OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP: "retired",
    DOCKER_HOST: "unix://" + join(directory, "absent.sock"),
  };
  const owner = spawnSync(process.execPath, ["scripts/ci/skipper-prepared-git-installed.mjs"], {
    cwd: checkout,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(owner.error, undefined);
  assert.equal(owner.status, 1);
  assert.ok(
    (await readFile(env.TEST_INSTALL_STDERR, "utf8")).includes(
      "OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP is retired",
    ),
  );
  const diagnostic = owner.stderr + owner.stdout;
  assert.ok(owner.stderr.includes("occ dev up exited 1"));
  assert.ok(!diagnostic.includes(locationMarker));
  assert.ok(!/bwrap|OPENSHELL_HOST_GATEWAY_IP/.test(diagnostic));
  assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["ps", "network", "rm"]);
  await assert.rejects(stat(model), { code: "ENOENT" });
  const clusters = await readdir(work);
  assert.equal(clusters.length, 1);
  const [cluster] = clusters;
  assert.ok(cluster);
  assert.deepEqual(await readdir(join(work, cluster)), []);
  const outputs = Object.fromEntries(
    (await readFile(stepOutput, "utf8"))
      .trim()
      .split("\n")
      .map((row) => row.split("=")),
  );
  const receipt = join(directory, "failure.json");
  await exec(process.execPath, ["scripts/ci/skipper-failure-receipt.ts", receipt], {
    cwd: checkout,
    env: {
      ...env,
      SKIPPER_STAGE: outputs.skipper_stage,
      SKIPPER_INSTALLED_CLEANUP: outputs.skipper_installed_cleanup,
      SKIPPER_PROOF_OUTCOME: "failure",
    },
  });
  assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), {
    version: 1,
    runId: "15",
    attempt: "1",
    sourceSha: head,
    outcome: "failed",
    lastStage: "install",
    installer: { component: "occ-dev-up", exitCode: 1 },
    installedCleanup: "unknown",
  });
});

test("installed Skipper failure retention preserves known checkpoints and withholds unknown data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skipper-failure-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stageOutput = join(directory, "step-output");
  const scope = {
    PATH: process.env.PATH,
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: "42942462012",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: sourceSha,
    GITHUB_OUTPUT: stageOutput,
  };
  const checkpoint = [
    'import { recordSkipperCheckpoint } from "./scripts/ci/skipper-failure-receipt.ts";',
    'await recordSkipperCheckpoint("skipper_stage", "selected-test");',
  ].join("\n");
  const child = (body: string, timeout = 10_000, output = stageOutput) =>
    spawnSync(process.execPath, ["--input-type=module", "--eval", checkpoint + "\n" + body], {
      encoding: "utf8",
      env: { ...scope, GITHUB_OUTPUT: output },
      timeout,
    });
  const outcome = (
    path: string,
    outcome: string,
    lastStage?: string,
    installedCleanup?: string,
    extra: NodeJS.ProcessEnv = {},
  ) =>
    spawnSync(process.execPath, ["scripts/ci/skipper-failure-receipt.ts", path], {
      encoding: "utf8",
      env: {
        ...scope,
        SKIPPER_PROOF_OUTCOME: outcome,
        SKIPPER_STAGE: lastStage,
        SKIPPER_INSTALLED_CLEANUP: installedCleanup,
        ...extra,
      },
    });
  const readOutputs = async () =>
    Object.fromEntries(
      (await readFile(stageOutput, "utf8"))
        .trim()
        .split("\n")
        .map((row) => row.split("=")),
    );

  // The real owner rejects this source before creating its work directory or invoking Docker.
  const ownerWork = join(directory, "owner-work");
  const owner = spawnSync(process.execPath, ["scripts/ci/skipper-prepared-git-installed.mjs"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...scope, GITHUB_SHA: "0".repeat(40), OCC_FIRST_AGENT_SMOKE_DIRECTORY: ownerWork },
  });
  assert.equal(owner.error, undefined);
  assert.equal(owner.status, 1);
  assert.match(owner.stderr, /AssertionError/);
  const ownerOutputs = await readOutputs();
  await assert.rejects(readFile(ownerWork), { code: "ENOENT" });
  const ownerFailure = join(directory, "owner-failure.json");
  assert.equal(
    outcome(
      ownerFailure,
      "failure",
      ownerOutputs.skipper_stage,
      ownerOutputs.skipper_installed_cleanup,
    ).status,
    0,
  );
  assert.deepEqual(ownerOutputs, { skipper_stage: "preflight" });
  const ownerReceipt = JSON.parse(await readFile(ownerFailure, "utf8"));
  assert.equal(ownerReceipt.lastStage, "preflight");
  assert.equal(ownerReceipt.installedCleanup, "unknown");
  await rm(stageOutput);

  const failed = child(
    'await recordSkipperCheckpoint("skipper_installed_cleanup", "failed"); process.exitCode = 37;',
  );
  assert.equal(failed.status, 37);
  const observed = await readOutputs();
  const failure = join(directory, "failed.json");
  assert.equal(
    outcome(failure, "failure", observed.skipper_stage, observed.skipper_installed_cleanup).status,
    0,
  );
  assert.deepEqual(JSON.parse(await readFile(failure, "utf8")), {
    version: 1,
    runId: "42942462012",
    attempt: "1",
    sourceSha,
    outcome: "failed",
    lastStage: "selected-test",
    installedCleanup: "failed",
    testOperation: "unknown",
    lastTestCheckpoint: "unknown",
  });
  assert.equal(outcome(failure, "failure", "install", "passed").status, 1);
  assert.equal(JSON.parse(await readFile(failure, "utf8")).lastStage, "selected-test");

  await rm(stageOutput);
  const interrupted = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      checkpoint + '\nprocess.stdout.write("ready\\n"); setInterval(() => {}, 1_000);',
    ],
    { env: scope },
  );
  try {
    // Interrupt only after the awaited checkpoint, independently of process startup time.
    const [ready] = await once(interrupted.stdout, "data", { signal: AbortSignal.timeout(10_000) });
    assert.equal(ready.toString(), "ready\n");
    const exited = once(interrupted, "exit", { signal: AbortSignal.timeout(10_000) });
    interrupted.kill("SIGTERM");
    assert.deepEqual(await exited, [null, "SIGTERM"]);
  } finally {
    if (interrupted.exitCode === null && interrupted.signalCode === null) {
      const exited = once(interrupted, "exit", { signal: AbortSignal.timeout(10_000) });
      interrupted.kill("SIGKILL");
      await exited;
    }
  }
  const partial = await readOutputs();
  const timed = join(directory, "timeout.json");
  assert.equal(
    outcome(timed, "failure", partial.skipper_stage, partial.skipper_installed_cleanup).status,
    0,
  );
  assert.equal(JSON.parse(await readFile(timed, "utf8")).lastStage, "selected-test");
  assert.equal(JSON.parse(await readFile(timed, "utf8")).installedCleanup, "unknown");

  const missing = child("process.exitCode = 31;", 10_000, join(directory, "absent", "output"));
  assert.equal(missing.status, 31);
  const unknown = join(directory, "unknown.json");
  assert.equal(
    outcome(unknown, "failure", "stage\nsynthetic-canary", "synthetic-canary").status,
    0,
  );
  const published = await readFile(unknown, "utf8");
  assert.doesNotMatch(published, /synthetic-canary/);
  assert.equal(JSON.parse(published).lastStage, "unknown");
  assert.equal(JSON.parse(published).installedCleanup, "unknown");

  // The receipt accepts only genuine status values in the install checkpoint.
  for (const [index, status] of ["SIGTERM", "0", "256", "SIGTERM\nsynthetic-canary"].entries()) {
    const path = join(directory, "installer-" + index + ".json");
    assert.equal(outcome(path, "failure", "install/occ-dev-up/" + status, "failed").status, 0);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(
      saved.installer,
      status === "SIGTERM" ? { component: "occ-dev-up", signal: "SIGTERM" } : undefined,
    );
    assert.equal(saved.installedCleanup, "failed");
    assert.ok(!JSON.stringify(saved).includes("synthetic-canary"));
  }

  const success = child('await recordSkipperCheckpoint("skipper_installed_cleanup", "passed");');
  assert.equal(success.status, 0);
  const withheld = join(directory, "success.json");
  assert.equal(outcome(withheld, "success", "finish-fixture", "passed").status, 0);
  await assert.rejects(readFile(withheld), { code: "ENOENT" });

  type Workflow = {
    jobs: Record<string, { steps: { id?: string; env?: Record<string, string> }[] }>;
  };
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const workflow: Workflow = loadYaml(
    await readFile(".github/workflows/full-integration-execution.yml", "utf8"),
  );
  const bindings = workflow.jobs[lane]?.steps.find(
    (step) => step.id === "installed-skipper-failure",
  )?.env;
  assert.ok(bindings);
  const runner = (
    operation: string,
    gatewayChatPhase?: string,
    error: unknown = {
      message: "private-canary",
      diagnostic: { kind: "skipper-operation", operation, gatewayChatPhase },
    },
  ) =>
    JSON.stringify({
      files: [
        {
          path: "tests/integration/skipper-prepared-git-installed.test.mjs",
          tests: [{ status: "failed", error }],
        },
      ],
    });
  const row = (phase: string, chatPhase?: string) =>
    JSON.stringify({ phase, chatPhase, private: "private-canary" }) + "\n";
  const refused = "gateway-chat-refused";
  const released = "repository-binding-withdrawn-discovery-released";
  const gateway = row(refused);
  const native = row(released);
  const earlierRefusal = row(refused, "before-private-git");
  const team = row("review-feedback-advanced-same-draft");
  const retired = row("owned-agent-retired-cluster-cleanup-still-required");
  const chatCases = (
    [
      ["before-private-git", gateway, refused],
      ["native-git", earlierRefusal + row(refused, "native-git") + native, released],
      ["after-withdrawal", gateway, refused],
    ] as const
  ).map(
    ([phase, ledger, last]) => [phase, ledger, true, last, "gateway-chat", phase, phase] as const,
  );
  const ledgerPath = join(directory, "compute-journey.jsonl");
  const saved = process.env;
  t.after(() => {
    process.env = saved;
  });
  process.env = { ...saved, GITHUB_ACTIONS: "true", GITHUB_OUTPUT: stageOutput };

  const transport = async () => {
    const outputs = await readOutputs();
    const env: NodeJS.ProcessEnv = {};
    for (const [key, binding] of Object.entries(bindings)) {
      const name = binding.match(
        /^\$\{\{\s*steps\.installed-skipper-proof\.outputs\.(\w+)\s*\}\}$/,
      )?.[1];
      if (name && Object.hasOwn(outputs, name)) {
        env[key] = outputs[name];
      }
    }
    return env;
  };

  await t.test(
    "failed chat carries only its own receiver observations through the workflow",
    async (t) => {
      const canary = "private-canary";
      const requestMarker = "skipper-" + canary;
      let marker = requestMarker;
      const prior = "skipper-earlier";
      const commandFile = join(directory, "skipper-command.json");
      const model = createSkipperPreparedComputeEvents(commandFile);
      const events: Record<string, unknown>[] = [];
      const emit = (event: Record<string, unknown>) => events.push(event);
      const answerEvents = () => [];
      let mode = "success";
      let requests = 0;
      // The loopback adapter sends the received user message to the installed
      // synthetic model's command fixture. Its tool call is never executed here.
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        const { messages } = JSON.parse(body);
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/v1/chat/completions");
        requests++;
        if (["success", "observed", "other-request", "terminal"].includes(mode)) {
          const input = mode === "other-request" ? [{ role: "user", content: prior }] : messages;
          assert.ok(
            model({ model: "synthetic", request: JSON.stringify({ input }), emit, answerEvents }),
          );
        }
        if (mode === "terminal") {
          const answer = "SKIPPER_COMPUTE_DONE_" + marker;
          const input = [
            {
              type: "function_call_output",
              call_id: marker,
              output: "Wall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n" + answer,
            },
          ];
          // Supply inert tool output and check the answer the fixture actually selected.
          let selected: string | undefined;
          model({
            model: "synthetic",
            request: JSON.stringify({ input }),
            emit,
            answerEvents: (_model: string, text: string) => {
              selected = text;
              return [];
            },
          });
          assert.equal(selected, answer);
        }
        if (mode === "prewarm-only") {
          emit({ event: "prewarm", transport: "websocket" });
        }
        if (mode === "success") {
          res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
        } else {
          req.socket.destroy(); // The same transport failure occurs in every receiver case.
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      emit({ event: "listening" });
      t.after(() => new Promise<void>((done) => server.close(() => done())));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const exec = promisify(execFile);
      const options = {
        gatewayChatPhase: "native-git",
        sessionKey: "session-" + canary,
        enter: async (_node: string, ...args: string[]) =>
          (
            await exec(process.execPath, args, {
              env: {
                OPENCLAW_GATEWAY_PORT: String(address.port),
                OPENCLAW_GATEWAY_PASSWORD: canary,
              },
            })
          ).stdout,
        modelEvents: async () => {
          if (mode === "missing" || (mode === "missing-end" && completedBeforeFailure < requests)) {
            throw new Error(canary);
          }
          if (mode === "truncated" && completedBeforeFailure < requests) {
            return events.slice(1);
          }
          return events.slice();
        },
        runtimeLogs: async () => ["thread/start " + canary],
        checkpoint: async (phase: string, data: Record<string, unknown>) =>
          appendFile(ledgerPath, JSON.stringify({ phase, ...data }) + "\n"),
      };
      const prepare = (id: string) =>
        writeFile(
          commandFile,
          JSON.stringify({ cmd: "true", id, expiresAt: Date.now() + 170_000 }),
        );
      let completedBeforeFailure = 0;
      await prepare(prior);
      assert.equal(await sendSkipperChat({ ...options, marker: prior }), "ok");
      assert.deepEqual(events.at(-1), { event: "skipper-native-request", id: prior });

      for (const [scenario, expected] of [
        ["none", "none-in-window"],
        ["prewarm-only", "none-in-window"],
        ["other-request", "unavailable"],
        ["missing", "unavailable"],
        ["missing-end", "unavailable"],
        ["truncated", "unavailable"],
        ["observed", "observed"],
        ["stale-marker", "unavailable"],
        ["terminal", "observed"],
      ] as const) {
        await t.test(scenario, async () => {
          mode = scenario;
          marker = scenario === "terminal" ? requestMarker + "-terminal" : requestMarker;
          await prepare(scenario === "other-request" ? prior : marker);
          completedBeforeFailure = requests;
          await writeFile(stageOutput, "");
          // A stale refusal can match the phase, category, and status. Only the
          // selected Error can supply the new fields, even if a later row disagrees.
          const stale = {
            phase: refused,
            httpStatus: 0,
            category: "transport",
            runtimeSignal: "model-transport",
            modelRequestObservation: "observed",
          };
          await writeFile(ledgerPath, JSON.stringify(stale) + "\n");
          let failure: Error | undefined;
          await assert.rejects(sendSkipperChat({ ...options, marker }), (error: Error) => {
            failure = error;
            return error.message === "Gateway chat failed";
          });
          assert.equal(requests, completedBeforeFailure + 1);
          assert.ok(failure);
          const { value } = await reporter([
            {
              type: "test:fail",
              data: {
                name: scenario,
                details: { error: { cause: failure } },
              },
            },
          ]).next();
          assert.equal(typeof value, "string");
          const resultText = runner(
            "gateway-chat",
            undefined,
            JSON.parse(String(value)).data.error,
          );
          assert.doesNotMatch(resultText, /private-canary/);
          await appendFile(ledgerPath, JSON.stringify(stale) + "\n");
          await recordSkipperCheckpoint("skipper_stage", "selected-test");
          await recordSkipperTestFailure(resultText, ledgerPath, false);
          await recordSkipperCheckpoint("skipper_installed_cleanup", "passed");
          const destination = join(directory, scenario + "-receiver.json");
          const writer = outcome(destination, "failure", undefined, undefined, await transport());
          assert.equal(writer.status, 0, writer.stderr);
          const published = await readFile(destination, "utf8");
          assert.deepEqual(JSON.parse(published), {
            version: 1,
            runId: scope.GITHUB_RUN_ID,
            attempt: scope.GITHUB_RUN_ATTEMPT,
            sourceSha,
            outcome: "failed",
            lastStage: "selected-test",
            testOperation: "gateway-chat",
            gatewayChatPhase: "native-git",
            httpStatus: 0,
            gatewayCategory: "transport",
            gatewayTransportCause: "socket-closed",
            runtimeSignal: "thread-start",
            modelRequestObservation: expected,
            ...(scenario === "terminal" ? { modelFixtureSelectedTerminalSuccess: true } : {}),
            lastTestCheckpoint: refused,
            installedCleanup: "passed",
          });
          assert.doesNotMatch(
            published + (await readFile(stageOutput, "utf8")),
            /private-canary|skipper-earlier|thread\/start/,
          );
        });
      }
    },
  );
  // Execute the owner's actual selected-result block, without installing a cluster or simulating cleanup.
  const ownerSource = await readFile("scripts/ci/skipper-prepared-git-installed.mjs", "utf8");
  const selectedBlock = ownerSource.slice(
    ownerSource.indexOf("  const ledgerPath ="),
    ownerSource.indexOf("  const summary = await read(privateResult);"),
  );
  assert.ok(selectedBlock.includes('assert.fail("selected test runner failed")'));
  await t.test("gateway exec diagnostics survive the selected failure receipt", async (t) => {
    const exec = promisify(execFile);
    let requests = 0;
    const gateway = createServer((req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat/completions");
      req.resume();
      requests++;
      res.end(JSON.stringify({ choices: [{ message: { content: "reply" } }] }));
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    t.after(() => new Promise<void>((done) => gateway.close(() => done())));
    const address = gateway.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      OPENCLAW_GATEWAY_PORT: String(address.port),
      OPENCLAW_GATEWAY_PASSWORD: "private-canary",
    };
    const options = {
      gatewayChatPhase: "native-git",
      marker: "private-canary",
      sessionKey: "private-canary",
      modelEvents: async () => [],
      runtimeLogs: async () => [],
      checkpoint: async () => {},
    };
    // Keep the successful call's stderr only to replay it as foreign evidence.
    let priorStderr = "";
    assert.equal(
      await sendSkipperChat({
        ...options,
        enter: async (_node: string, ...args: string[]) => {
          const result = await exec(process.execPath, args, { env, timeout: 10_000 });
          priorStderr = result.stderr;
          assert.deepEqual(JSON.parse(result.stdout), { status: 200, content: "reply" });
          return result.stdout;
        },
      }),
      "reply",
    );
    assert.equal(requests, 1);
    for (const [name, script, expected] of [
      [
        "entered",
        'process.stderr.write("private-canary\\n"); process.exitCode = 1;',
        {
          exitCode: 1,
          helperEntered: true,
        },
      ],
      ["before-entry", "process.exitCode = 1;", { exitCode: 1 }],
      ["foreign-entry", "process.exitCode = 1;", { exitCode: 1 }],
      ["exit", 'process.stderr.write("private-canary"); process.exit(23)', { exitCode: 23 }],
      ["signal", 'process.kill(process.pid, "SIGTERM")', { signal: "SIGTERM" }],
      [
        "code",
        'process.stdout.write("private-canary")',
        { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      ],
    ] as const) {
      await t.test(name, async (t) => {
        if (name === "foreign-entry") {
          assert.match(priorStderr, /^\nskipper-gateway-entry:[\da-f-]{36}\n$/);
        }
        const before = requests;
        let original: unknown;
        let failure: Error | undefined;
        await assert.rejects(
          sendSkipperChat({
            ...options,
            enter: async (_node: string, flag: string, program: string, ...args: string[]) => {
              // The local execFile replaces kubectl. For the positive case the
              // generated receiver still runs, and the child reports exit 1.
              let source = script;
              if (name === "entered") {
                source += "\n" + program;
              }
              if (name === "before-entry") {
                // Echoing the invocation argument cannot supply the helper's frame.
                source += `process.stderr.write(${JSON.stringify("\n" + args.at(-1) + "\n")});`;
              } else if (name === "foreign-entry") {
                source += `process.stderr.write(${JSON.stringify(priorStderr)});`;
              }
              const localArgs = name === "entered" ? [flag, source, ...args] : [flag, source];
              try {
                return (
                  await exec(process.execPath, localArgs, {
                    env,
                    timeout: 10_000,
                    maxBuffer: name === "code" ? 1 : 1024,
                  })
                ).stdout;
              } catch (error) {
                original = error;
                throw error;
              }
            },
          }),
          (error: Error) => {
            failure = error;
            return error === original;
          },
        );
        assert.equal(requests, before + Number(name === "entered"));
        assert.ok(failure);
        if (name === "entered") {
          assert.ok("stdout" in failure && typeof failure.stdout === "string");
          assert.deepEqual(JSON.parse(failure.stdout), { status: 200, content: "reply" });
        }
        const { value } = await reporter([
          { type: "test:fail", data: { name, details: { error: { cause: failure } } } },
        ]).next();
        assert.equal(typeof value, "string");
        const reported = JSON.parse(String(value)).data.error;
        assert.deepEqual(reported.diagnostic, {
          kind: "skipper-operation",
          operation: "gateway-exec",
          ...expected,
        });
        t.diagnostic("Reporter already captured " + JSON.stringify(reported.diagnostic));
        const resultText = runner("gateway-exec", undefined, reported);
        if (name === "exit") {
          // Prove the private runner result has text the public receipt must omit.
          assert.match(resultText, /private-canary/);
        }
        await writeFile(stageOutput, "");
        await writeFile(ledgerPath, native);
        // Run the owner's selected-result block, preserving its primary failure.
        const selected = child(`
          import assert from "node:assert/strict";
          import { join, resolve } from "node:path";
          import { readSkipperJourney, recordSkipperTestFailure } from "./scripts/ci/skipper-failure-receipt.ts";
          const directory = ${JSON.stringify(directory)};
          const env = {};
          const proof = [];
          const progress = () => {};
          const testFailed = true;
          const resultText = ${JSON.stringify(resultText)};
          ${selectedBlock}
        `);
        assert.equal(selected.status, 1);
        assert.match(selected.stderr, /AssertionError.*selected test runner failed/);
        const destination = join(directory, name + "-exec.json");
        const writer = outcome(
          destination,
          "failure",
          "selected-test",
          "passed",
          await transport(),
        );
        assert.equal(writer.status, 0, writer.stderr);
        const published = await readFile(destination, "utf8");
        assert.deepEqual(
          JSON.parse(published).gatewayExec,
          expected,
          "sanitized failure artifact must retain the already-captured exec diagnostic",
        );
        assert.equal(JSON.parse(published).lastTestCheckpoint, released);
        assert.equal(JSON.parse(published).gatewayChatPhase, undefined);
        assert.doesNotMatch(
          published + (await readFile(stageOutput, "utf8")),
          /private-canary|skipper-gateway-entry:|chat\/completions/,
        );
      });
    }

    // Invalid recorder input must emit no exec fields, even on a known foreign operation.
    for (const operation of ["gateway-exec", "gateway-chat", "native-observation"]) {
      await writeFile(stageOutput, "");
      await recordSkipperTestFailure(
        runner(operation, undefined, {
          diagnostic: {
            kind: "skipper-operation",
            operation,
            ...(operation === "gateway-exec"
              ? {
                  exitCode: "23",
                  signal: "SIGTERM\nprivate-canary",
                  code: "private-canary",
                  helperEntered: "true",
                }
              : { exitCode: 23, signal: "SIGTERM", code: "ENOENT", helperEntered: true }),
          },
        }),
        ledgerPath,
        false,
      );
      assert.deepEqual(await readOutputs(), {
        skipper_test_operation: operation,
        skipper_last_test_checkpoint: released,
      });
    }

    // The writer must independently reject noncanonical numbers and foreign attribution.
    const cases = [
      ...[undefined, "", "023", "2.3e1", " 23", "23\n", "-0", "-1", "256", "1.5", "NaN"].map(
        (exitCode) => ({
          exitCode,
          signal: "private-canary",
          code: "private-canary",
          expected: undefined,
        }),
      ),
      { exitCode: "0", signal: undefined, code: undefined, expected: { exitCode: 0 } },
      {
        exitCode: "255",
        signal: "SIGKILL",
        code: "ENOENT",
        expected: { exitCode: 255, signal: "SIGKILL", code: "ENOENT" },
      },
      { exitCode: undefined, signal: undefined, code: "EACCES", expected: { code: "EACCES" } },
    ];
    for (const [index, entry] of cases.entries()) {
      const destination = join(directory, `exec-readback-${index}.json`);
      assert.equal(
        outcome(destination, "failure", "selected-test", "passed", {
          SKIPPER_TEST_OPERATION: "gateway-exec",
          SKIPPER_GATEWAY_EXEC_EXIT_CODE: entry.exitCode,
          SKIPPER_GATEWAY_EXEC_SIGNAL: entry.signal,
          SKIPPER_GATEWAY_EXEC_CODE: entry.code,
          SKIPPER_GATEWAY_EXEC_HELPER_ENTERED: "true\nprivate-canary",
        }).status,
        0,
      );
      const published = await readFile(destination, "utf8");
      assert.deepEqual(JSON.parse(published).gatewayExec, entry.expected);
      assert.doesNotMatch(published, /private-canary/);
    }
    for (const [index, [stage, operation, proofOutcome]] of (
      [
        ["install", "gateway-exec", "failure"],
        ["verify-proof", "gateway-exec", "failure"],
        ["selected-test", "gateway-chat", "failure"],
        ["selected-test", "native-observation", "failure"],
        ["selected-test", "gateway-exec\nprivate-canary", "failure"],
        ["selected-test", "gateway-exec", "success"],
      ] as const
    ).entries()) {
      const destination = join(directory, `exec-foreign-${index}.json`);
      assert.equal(
        outcome(destination, proofOutcome, stage, "passed", {
          SKIPPER_TEST_OPERATION: operation,
          SKIPPER_GATEWAY_EXEC_EXIT_CODE: "23",
          SKIPPER_GATEWAY_EXEC_SIGNAL: "SIGTERM",
          SKIPPER_GATEWAY_EXEC_CODE: "ENOENT",
          SKIPPER_GATEWAY_EXEC_HELPER_ENTERED: "true",
        }).status,
        0,
      );
      if (proofOutcome === "success") {
        await assert.rejects(readFile(destination), { code: "ENOENT" });
      } else {
        assert.equal(JSON.parse(await readFile(destination, "utf8")).gatewayExec, undefined);
      }
    }
  });
  const phaseKey = "SKIPPER_GATEWAY_CHAT_PHASE";
  const diagnosticCases: {
    name: string;
    input: { httpStatus?: unknown; gatewayCategory?: unknown };
    expected: { httpStatus?: number; gatewayCategory?: string };
  }[] = [
    {
      name: "native-git",
      input: { httpStatus: 403, gatewayCategory: "permission" },
      expected: { httpStatus: 403, gatewayCategory: "permission" },
    },
    {
      name: "response-json",
      input: { httpStatus: 200, gatewayCategory: "response-json" },
      expected: { httpStatus: 200, gatewayCategory: "response-json" },
    },
    {
      name: "transport",
      input: { httpStatus: 0, gatewayCategory: "transport" },
      expected: { httpStatus: 0, gatewayCategory: "transport" },
    },
    {
      name: "client-deadline",
      input: { httpStatus: 0, gatewayCategory: "client-deadline" },
      expected: { httpStatus: 0, gatewayCategory: "client-deadline" },
    },
    { name: "status only", input: { httpStatus: 503 }, expected: { httpStatus: 503 } },
    {
      name: "category only",
      input: { gatewayCategory: "timeout" },
      expected: { gatewayCategory: "timeout" },
    },
    {
      name: "invalid status",
      input: { httpStatus: "403", gatewayCategory: "permission" },
      expected: { gatewayCategory: "permission" },
    },
    {
      name: "invalid category",
      input: { httpStatus: 403, gatewayCategory: "private-canary" },
      expected: { httpStatus: 403 },
    },
    {
      name: "invalid diagnostics",
      input: { httpStatus: 99, gatewayCategory: { private: "private-canary" } },
      expected: {},
    },
    {
      name: "phase on another operation",
      input: { httpStatus: 403, gatewayCategory: "permission" },
      expected: {},
    },
  ];
  for (const [
    name,
    ledger,
    teamReview,
    expected,
    operation = "native-observation",
    phase,
    expectedPhase,
  ] of [
    ["gateway", gateway + retired, false, refused, "gateway-chat"],
    ["native", native + retired, false, released],
    ...chatCases,
    ...diagnosticCases
      .filter(({ name }) => name !== "native-git" && name !== "phase on another operation")
      .map(
        ({ name }) =>
          [
            name,
            earlierRefusal + native,
            true,
            released,
            "gateway-chat",
            "native-git",
            "native-git",
          ] as const,
      ),
    ["legacy error after earlier refusal", earlierRefusal + native, true, released, "gateway-chat"],
    ["invalid phase", gateway, true, refused, "gateway-chat", "native-git\nprivate-canary"],
    ["phase on another operation", gateway, true, refused, "gateway-exec", "native-git"],
    ["truncated", gateway + "  \n" + '{"phase":' + "\n" + native, false, "gateway-chat-refused"],
    ["array", gateway + "[]\n" + native, false, "gateway-chat-refused"],
    ["first malformed", "{\n" + gateway, false, "unknown"],
    ["opposite mode", team + row("private-canary") + retired, false, "unknown"],
    [
      "team",
      team + row("native-commit-confirmed-by-independent-fetch") + retired,
      true,
      "review-feedback-advanced-same-draft",
    ],
    ["missing", undefined, false, "unknown"],
    ["unreadable", undefined, false, "unknown"],
  ] as const) {
    await t.test(name, async () => {
      await rm(ledgerPath, { force: true });
      if (ledger !== undefined) {
        await writeFile(ledgerPath, ledger);
      }
      await writeFile(stageOutput, "");
      const path = name === "unreadable" ? directory : ledgerPath;
      let resultText = runner(operation, phase);
      const diagnosticCase = diagnosticCases.find((entry) => entry.name === name);
      const expectedDiagnostic = diagnosticCase?.expected ?? {};
      if (diagnosticCase) {
        // Typed diagnostics traverse the real reporter, workflow bindings, and receipt writer.
        const cause = Object.assign(new Error("private-canary"), {
          openclawCiDiagnostic: {
            kind: "skipper-operation",
            operation,
            gatewayChatPhase: phase,
            ...diagnosticCase.input,
          },
        });
        const events = [{ type: "test:fail", data: { name, details: { error: { cause } } } }];
        const { value } = await reporter(events).next();
        assert.ok(typeof value === "string");
        resultText = runner(operation, undefined, JSON.parse(value).data.error);
      }
      const result = await recordSkipperTestFailure(resultText, path, teamReview);
      assert.equal(result.last, expected);
      if (["truncated", "array", "first malformed"].includes(name)) {
        await assert.rejects(
          readSkipperJourney(path, false),
          name === "array" ? TypeError : SyntaxError,
        );
      }
      const outputs = await readOutputs();
      const expectedOutputs: NodeJS.ProcessEnv = {
        skipper_test_operation: operation,
        skipper_last_test_checkpoint: expected,
        ...(expectedPhase ? { skipper_gateway_chat_phase: expectedPhase } : {}),
        ...(expectedDiagnostic.httpStatus !== undefined
          ? { skipper_http_status: String(expectedDiagnostic.httpStatus) }
          : {}),
        ...(expectedDiagnostic.gatewayCategory !== undefined
          ? { skipper_gateway_category: expectedDiagnostic.gatewayCategory }
          : {}),
      };
      assert.deepEqual(outputs, expectedOutputs);
      if (name === "native" || operation !== "native-observation") {
        const transported = await transport();
        if (phase && !expectedPhase) {
          transported[phaseKey] = phase; // Exercise the receipt writer's independent boundary.
        }
        const destination = join(directory, name + ".json");
        assert.equal(
          outcome(destination, "failure", "selected-test", "passed", transported).status,
          0,
        );
        const published = await readFile(destination, "utf8");
        assert.deepEqual(JSON.parse(published), {
          version: 1,
          runId: scope.GITHUB_RUN_ID,
          attempt: scope.GITHUB_RUN_ATTEMPT,
          sourceSha,
          outcome: "failed",
          lastStage: "selected-test",
          installedCleanup: "passed",
          testOperation: operation,
          lastTestCheckpoint: expected,
          ...(expectedPhase ? { gatewayChatPhase: expectedPhase } : {}),
          ...expectedDiagnostic,
        });
        assert.doesNotMatch(published, /private-canary|synthetic-canary/);
      }
      if (["gateway", "native", "native-git", "client-deadline"].includes(name)) {
        // A truncated ledger must preserve both valid diagnostics and the primary failure.
        const deadline = name === "client-deadline";
        const diagnostic = JSON.stringify({
          ...(deadline
            ? { phase: refused, httpStatus: 0, category: name }
            : { phase: expected, httpStatus: 403, category: "private-canary" }),
          runtimeSignal: "no-known-signal",
          modelTurns: null,
          modelAnswers: null,
          expectedNonceAnswered: null,
          tlsErrors: null,
        });
        const tail = deadline ? native : "";
        await writeFile(ledgerPath, diagnostic + "\n" + tail + "{\n");
        await writeFile(stageOutput, "");
        const failed = child(`
          import assert from "node:assert/strict";
          import { join, resolve } from "node:path";
          import { readSkipperJourney, recordSkipperTestFailure } from "./scripts/ci/skipper-failure-receipt.ts";
          const directory = ${JSON.stringify(directory)};
          const env = {};
          const proof = [];
          const progress = () => {};
          const testFailed = true;
          const resultText = ${JSON.stringify(resultText)};
          ${selectedBlock}
        `);
        assert.equal(failed.status, 1);
        assert.match(failed.stderr, /AssertionError.*selected test runner failed/);
        if (deadline) {
          assert.match(failed.stderr, /Gateway HTTP 0, client-deadline, unknown/);
        }
        assert.doesNotMatch(failed.stderr, /private-canary/);
        assert.deepEqual(await readOutputs(), {
          ...expectedOutputs,
          skipper_stage: "selected-test",
        });
      }
    });
  }
  // Stale valid ledger diagnostics cannot establish attribution for a missing selected result.
  await writeFile(
    ledgerPath,
    row("native-command-started") +
      JSON.stringify({
        phase: refused,
        httpStatus: 403,
        category: "permission",
        label: "synthetic-canary",
      }) +
      "\n",
  );
  for (const [index, resultText] of [
    "",
    "{}",
    "{malformed",
    runner("gateway-chat\nprivate-canary"),
  ].entries()) {
    await writeFile(stageOutput, "");
    await recordSkipperTestFailure(resultText, ledgerPath, false);
    assert.deepEqual(await readOutputs(), {
      skipper_test_operation: "unknown",
      skipper_last_test_checkpoint: "gateway-chat-refused",
    });
    const destination = join(directory, "missing-result-" + index + ".json");
    const outputs = await readOutputs();
    assert.equal(
      outcome(destination, "failure", "selected-test", "passed", {
        SKIPPER_TEST_OPERATION: outputs.skipper_test_operation,
        SKIPPER_LAST_TEST_CHECKPOINT: outputs.skipper_last_test_checkpoint,
      }).status,
      0,
    );
    const published = JSON.parse(await readFile(destination, "utf8"));
    assert.equal(published.testOperation, "unknown");
    assert.equal(published.httpStatus, undefined);
    assert.equal(published.gatewayCategory, undefined);
    assert.equal(published.lastTestCheckpoint, refused);
    assert.doesNotMatch(JSON.stringify(published), /synthetic-canary|label/);
  }
  for (const stage of ["selected-test", "install", "verify-proof"]) {
    const destination = join(directory, stage + "-injected.json");
    assert.equal(
      outcome(destination, "failure", stage, undefined, {
        SKIPPER_TEST_OPERATION:
          stage !== "selected-test" ? "gateway-chat" : "gateway-chat\nprivate-canary",
        SKIPPER_LAST_TEST_CHECKPOINT: "gateway-chat-refused\nprivate-canary",
        SKIPPER_RUNTIME_SIGNAL: "thread-start",
        SKIPPER_MODEL_REQUEST_OBSERVATION: "observed",
        SKIPPER_GATEWAY_CHAT_PHASE: "native-git",
        SKIPPER_HTTP_STATUS: "403",
        SKIPPER_GATEWAY_CATEGORY: "permission",
      }).status,
      0,
    );
    const published = JSON.parse(await readFile(destination, "utf8"));
    assert.equal(published.testOperation, stage === "selected-test" ? "unknown" : undefined);
    assert.equal(published.lastTestCheckpoint, stage === "selected-test" ? "unknown" : undefined);
    assert.equal(published.runtimeSignal, undefined);
    assert.equal(published.modelRequestObservation, undefined);
    assert.equal(published.gatewayChatPhase, undefined);
    assert.equal(published.httpStatus, undefined);
    assert.equal(published.gatewayCategory, undefined);
    assert.doesNotMatch(JSON.stringify(published), /private-canary/);
  }
  const poisoned = join(directory, "invalid-observations.json");
  assert.equal(
    outcome(poisoned, "failure", "selected-test", "failed", {
      SKIPPER_TEST_OPERATION: "gateway-chat",
      SKIPPER_GATEWAY_CHAT_PHASE: "native-git",
      SKIPPER_HTTP_STATUS: "0",
      SKIPPER_GATEWAY_CATEGORY: "transport",
      SKIPPER_RUNTIME_SIGNAL: "thread-start\nprivate-canary",
      SKIPPER_MODEL_REQUEST_OBSERVATION: "32",
      SKIPPER_GATEWAY_TRANSPORT_CAUSE: "unknown-private-canary",
    }).status,
    0,
  );
  const filtered = JSON.parse(await readFile(poisoned, "utf8"));
  assert.equal(filtered.runtimeSignal, undefined);
  assert.equal(filtered.modelRequestObservation, undefined);
  assert.equal(filtered.gatewayCategory, "transport");
  assert.equal(filtered.gatewayTransportCause, undefined);
  assert.equal(filtered.installedCleanup, "failed");

  // Exercise one changed input at a time against an otherwise eligible workflow receipt.
  for (const [key, value] of [
    ["SKIPPER_STAGE", "finish-fixture"],
    ["SKIPPER_TEST_OPERATION", "command-cleanup"],
    ["SKIPPER_GATEWAY_CHAT_PHASE", "before-private-git"],
    ["SKIPPER_GATEWAY_CATEGORY", "client-deadline"],
    ["SKIPPER_HTTP_STATUS", "503"],
    ["SKIPPER_MODEL_REQUEST_OBSERVATION", "unavailable"],
    ["SKIPPER_MODEL_FIXTURE_SELECTED_TERMINAL_SUCCESS", "1"],
  ] as const) {
    const path = join(directory, key + ".json");
    assert.equal(
      outcome(path, "failure", "selected-test", "passed", {
        SKIPPER_TEST_OPERATION: "gateway-chat",
        SKIPPER_GATEWAY_CHAT_PHASE: "native-git",
        SKIPPER_GATEWAY_CATEGORY: "transport",
        SKIPPER_HTTP_STATUS: "0",
        SKIPPER_MODEL_REQUEST_OBSERVATION: "observed",
        SKIPPER_MODEL_FIXTURE_SELECTED_TERMINAL_SUCCESS: "true",
        [key]: value,
      }).status,
      0,
    );
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).modelFixtureSelectedTerminalSuccess,
      undefined,
    );
  }

  // The writer independently validates the values received through the workflow environment.
  const injected = [
    ...[undefined, "", "0200", "2e2", " 200", "200.5", "-0", "99", "600", "200\n"].map(
      (status) => ({
        operation: "gateway-chat",
        status,
        category: "permission",
        expected: { gatewayCategory: "permission" },
      }),
    ),
    ...[undefined, "", "permission\nsynthetic-canary"].map((category) => ({
      operation: "gateway-chat",
      status: "200",
      category,
      expected: { httpStatus: 200 },
    })),
    { operation: "gateway-exec", status: "403", category: "permission", expected: {} },
  ];
  for (const [index, { operation, status, category, expected }] of injected.entries()) {
    const destination = join(directory, "injected-" + index + ".json");
    assert.equal(
      outcome(destination, "failure", "selected-test", "passed", {
        SKIPPER_TEST_OPERATION: operation,
        SKIPPER_HTTP_STATUS: status,
        SKIPPER_GATEWAY_CATEGORY: category,
      }).status,
      0,
    );
    const text = await readFile(destination, "utf8");
    const { testOperation, httpStatus, gatewayCategory } = JSON.parse(text);
    assert.equal(testOperation, operation);
    assert.deepEqual(
      { httpStatus, gatewayCategory },
      {
        httpStatus: undefined,
        gatewayCategory: undefined,
        ...expected,
      },
    );
    assert.doesNotMatch(text, /synthetic-canary/);
  }
});

test("installed Skipper retains only attributed evidence on rejected gateway requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skipper-rejected-request-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "steps");
  const ledger = join(directory, "ledger");
  const original = process.env;
  process.env = { ...original, GITHUB_ACTIONS: "true", GITHUB_OUTPUT: output };
  t.after(() => {
    process.env = original;
  });
  await writeFile(ledger, '{"phase":"native-command-started"}\n');
  const marker = "private-canary";
  const listening = { event: "listening" };
  const matched = { event: "skipper-native-request", id: marker };
  const before = [listening];
  const after = [listening, matched];
  const verify = async (failure: Error, expected: Record<string, unknown>) => {
    const event = await reporter([
      { type: "test:fail", data: { name: "gateway", details: { error: { cause: failure } } } },
    ]).next();
    const error = JSON.parse(String(event.value)).data.error;
    const result = {
      files: [
        {
          path: "tests/integration/skipper-prepared-git-installed.test.mjs",
          tests: [{ status: "failed", error }],
        },
      ],
    };
    await writeFile(output, "");
    await recordSkipperTestFailure(JSON.stringify(result), ledger, true);
    const steps = await readFile(output, "utf8");
    const environment = Object.fromEntries(
      steps
        .trim()
        .split("\n")
        .map((line) => {
          const [key, value] = line.split("=");
          assert.ok(key, "step output must have a key");
          return [key.toUpperCase(), value];
        }),
    );
    const receiptPath = join(directory, "receipt.json");
    await rm(receiptPath, { force: true });
    const writer = spawnSync(
      process.execPath,
      ["scripts/ci/skipper-failure-receipt.ts", receiptPath],
      {
        encoding: "utf8",
        env: {
          ...environment,
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: sourceSha,
          SKIPPER_STAGE: "selected-test",
          SKIPPER_PROOF_OUTCOME: "failure",
          SKIPPER_INSTALLED_CLEANUP: "failed",
        },
      },
    );
    assert.equal(writer.status, 0, writer.stderr);
    const saved = await readFile(receiptPath, "utf8");
    assert.doesNotMatch(steps + saved, /private-canary/);
    assert.deepEqual(JSON.parse(saved), {
      version: 1,
      runId: "1",
      attempt: "1",
      sourceSha,
      outcome: "failed",
      lastStage: "selected-test",
      lastTestCheckpoint: "native-command-started",
      installedCleanup: "failed",
      ...expected,
    });
  };
  const options = {
    marker,
    gatewayChatPhase: "native-git",
    sessionKey: marker,
    checkpoint: async () => {},
    runtimeLogs: async () => [],
  };
  for (const [name, first, second, observed] of [
    ["matched", before, after, true],
    ["stale", after, after, false],
    ["foreign", before, [listening, { ...matched, id: marker + "-other" }], false],
    ["restarted", before, [listening, listening, matched], false],
    ["different prefix", before, [matched], false],
    ["empty window", before, before, false],
    ["malformed", before, [listening, {}, matched], false],
    ["before unavailable", undefined, after, false],
    ["after unavailable", before, undefined, false],
  ] as const) {
    await t.test(name, async () => {
      const snapshots = [first, second];
      const failure = Object.assign(new Error(marker), {
        code: 23,
        signal: "SIGTERM",
        killed: true,
      });
      await assert.rejects(
        sendSkipperChat({
          ...options,
          enter: async () => {
            throw failure;
          },
          modelEvents: async () => {
            const events = snapshots.shift();
            if (!events) {
              throw new Error(marker);
            }
            return events;
          },
        }),
        (error: unknown) => error === failure,
      );
      assert.equal(failure.killed, true);
      await verify(failure, {
        testOperation: "gateway-exec",
        gatewayExec: {
          exitCode: 23,
          signal: "SIGTERM",
          ...(observed ? { modelRequestObservation: "observed" } : {}),
        },
      });
    });
  }
  const result = {
    event: "skipper-native-result",
    id: marker,
    modelFixtureSelectedTerminalSuccess: true,
  };
  for (const [name, first, second, observation] of [
    ["prior result", [listening, result], [listening, result, matched, result], "observed"],
    ["ambiguous request", before, [...after, matched, result], "observed"],
    ["foreign result", before, [...after, { ...result, id: marker + "-other" }], "observed"],
    ["replaced prefix", before, [matched, result], "unavailable"],
    ["restart with result", before, [listening, listening, matched, result], "unavailable"],
    ["result before request", before, [listening, result, matched], "observed"],
    [
      "wrong decision type",
      before,
      [...after, { ...result, modelFixtureSelectedTerminalSuccess: "true" }],
      "observed",
    ],
  ] as const) {
    await t.test(name, async () => {
      const snapshots = [first, second];
      await assert.rejects(
        sendSkipperChat({
          ...options,
          enter: async () => JSON.stringify({ status: 0, category: "transport" }),
          modelEvents: async () => snapshots.shift(),
        }),
        (error: Error & { openclawCiDiagnostic: Record<string, unknown> }) => {
          assert.equal(error.openclawCiDiagnostic.modelRequestObservation, observation);
          assert.equal(error.openclawCiDiagnostic.modelFixtureSelectedTerminalSuccess, undefined);
          return error.message === "Gateway chat failed";
        },
      );
      assert.equal(snapshots.length, 0);
    });
  }
  for (const [name, error, cause] of [
    ["socket", { cause: { code: "UND_ERR_SOCKET" } }, "socket-closed"],
    ["reset", { code: "ECONNRESET" }, "connection-reset"],
    ["headers", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }, "headers-timeout"],
    ["unknown", { code: marker }, "other"],
    ["nested", { cause: { cause: { code: "ECONNRESET" } } }, "other"],
    ["deadline", undefined, undefined],
  ] as const) {
    await t.test(name, async () => {
      const snapshots = [before, after];
      let failure: Error | undefined;
      await assert.rejects(
        sendSkipperChat({
          ...options,
          modelEvents: async () => snapshots.shift(),
          enter: async () => {
            const stub = error ? "throw " + JSON.stringify(error) : "throw options.signal.reason";
            const program = [
              "const controller = new AbortController(); controller.abort();",
              "AbortSignal.timeout = () => controller.signal;",
              "globalThis.fetch = async (_, options) => {" + stub + "};",
              "(" + inGateway.toString() + ')("private-canary", "private-canary");',
            ].join("\n");
            return (
              await promisify(execFile)(process.execPath, ["-e", program], {
                env: { OPENCLAW_GATEWAY_PASSWORD: marker },
              })
            ).stdout;
          },
        }),
        (error: Error) => {
          failure = error;
          return true;
        },
      );
      assert.ok(failure);
      await verify(failure, {
        testOperation: "gateway-chat",
        gatewayChatPhase: "native-git",
        gatewayCategory: cause ? "transport" : "client-deadline",
        httpStatus: 0,
        runtimeSignal: "no-known-signal",
        modelRequestObservation: "observed",
        ...(cause ? { gatewayTransportCause: cause } : {}),
      });
    });
  }
});
