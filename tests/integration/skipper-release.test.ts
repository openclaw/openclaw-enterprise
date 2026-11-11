import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  readSkipperJourney,
  recordSkipperTestFailure,
} from "../../scripts/ci/skipper-failure-receipt.ts";
import reporter from "../../scripts/ci/reporter.mjs";
import { inGateway } from "../helpers/skipper-prepared-compute.mjs";

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
  for (const [scenario, status, category] of [
    ["transport", 0, "transport"],
    ["body", 200, "response-body"],
    ["json", 200, "response-json"],
    ["http", 403, "permission"],
    ["success", 200, undefined],
  ] as const) {
    await t.test(scenario, async (t) => {
      const canary = "private-response-content";
      // Real sockets exercise fetch rejection, interrupted body reads and JSON parsing.
      const server = createServer((req, res) => {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/v1/chat/completions");
        assert.equal(req.headers.authorization, "Bearer synthetic-receiver-key");
        req.resume();
        if (scenario === "transport") {
          req.socket.destroy();
        } else if (scenario === "body") {
          res.writeHead(200, { "content-length": 1000 });
          res.write(canary);
          setTimeout(() => res.destroy(), 50);
        } else if (scenario === "json") {
          res.end(canary);
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
      const result = await promisify(execFile)(
        process.execPath,
        ["-e", `(${inGateway.toString()})("prompt", "session")`],
        {
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            OPENCLAW_GATEWAY_PASSWORD: "synthetic-receiver-key",
            OPENCLAW_GATEWAY_PORT: String(address.port),
          },
        },
      );
      assert.equal(result.stderr, "");
      assert.deepEqual(
        JSON.parse(result.stdout),
        category ? { status, category } : { status, content: "reply" },
      );
      assert.ok(!result.stdout.includes(canary));
    });
  }
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

  // Execute the owner's actual selected-result block, without installing a cluster or simulating cleanup.
  const ownerSource = await readFile("scripts/ci/skipper-prepared-git-installed.mjs", "utf8");
  const selectedBlock = ownerSource.slice(
    ownerSource.indexOf("  const ledgerPath ="),
    ownerSource.indexOf("  const summary = await read(privateResult);"),
  );
  assert.ok(selectedBlock.includes('assert.fail("selected test runner failed")'));
  const phaseKey = "SKIPPER_GATEWAY_CHAT_PHASE";
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
      if (name === "native-git") {
        // The native refusal traverses the normal runner serializer before projection.
        const cause = Object.assign(new Error("private-canary"), {
          openclawCiDiagnostic: {
            kind: "skipper-operation",
            operation,
            gatewayChatPhase: phase,
            httpStatus: 403,
            gatewayCategory: "permission",
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
      };
      assert.deepEqual(outputs, expectedOutputs);
      if (name === "native" || operation !== "native-observation") {
        const transported: NodeJS.ProcessEnv = {};
        // Parse only these transport bindings; unrelated env entries and whitespace are immaterial.
        for (const key of ["SKIPPER_TEST_OPERATION", "SKIPPER_LAST_TEST_CHECKPOINT", phaseKey]) {
          const binding: string | undefined = bindings[key];
          if (binding === undefined) {
            continue;
          }
          const outputName: string | undefined = binding.match(
            /^\$\{\{\s*steps\.installed-skipper-proof\.outputs\.(\w+)\s*\}\}$/,
          )?.[1];
          assert.ok(outputName, key);
          transported[key] = outputs[outputName];
        }
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
        });
        assert.doesNotMatch(published, /private-canary|httpStatus|gatewayCategory/);
      }
      if (name === "gateway" || name === "native") {
        // Damaged optional diagnostics and a truncated tail must still reach the original assertion.
        const diagnostic = JSON.stringify({
          phase: expected,
          httpStatus: 403,
          category: "private-canary",
          runtimeSignal: "no-known-signal",
          modelTurns: null,
          modelAnswers: null,
          expectedNonceAnswered: null,
          tlsErrors: null,
        });
        await writeFile(ledgerPath, diagnostic + "\n{\n");
        const failed = child(`
          import assert from "node:assert/strict";
          import { join } from "node:path";
          import { readSkipperJourney, recordSkipperTestFailure } from "./scripts/ci/skipper-failure-receipt.ts";
          const directory = ${JSON.stringify(directory)};
          const env = {};
          const proof = [];
          const progress = () => {};
          const testFailed = true;
          const resultText = ${JSON.stringify(runner(operation))};
          ${selectedBlock}
        `);
        assert.equal(failed.status, 1);
        assert.match(failed.stderr, /AssertionError.*selected test runner failed/);
        assert.doesNotMatch(failed.stderr, /private-canary/);
      }
    });
  }
  await writeFile(ledgerPath, gateway);
  for (const resultText of ["{malformed", runner("gateway-chat\nprivate-canary")]) {
    await writeFile(stageOutput, "");
    await recordSkipperTestFailure(resultText, ledgerPath, false);
    assert.deepEqual(await readOutputs(), {
      skipper_test_operation: "unknown",
      skipper_last_test_checkpoint: "gateway-chat-refused",
    });
  }
  for (const stage of ["selected-test", "install"]) {
    const destination = join(directory, stage + "-injected.json");
    assert.equal(
      outcome(destination, "failure", stage, undefined, {
        SKIPPER_TEST_OPERATION:
          stage === "install" ? "gateway-chat" : "gateway-chat\nprivate-canary",
        SKIPPER_LAST_TEST_CHECKPOINT: "gateway-chat-refused\nprivate-canary",
        SKIPPER_GATEWAY_CHAT_PHASE: "native-git",
      }).status,
      0,
    );
    const published = JSON.parse(await readFile(destination, "utf8"));
    assert.equal(published.testOperation, stage === "selected-test" ? "unknown" : undefined);
    assert.equal(published.lastTestCheckpoint, stage === "selected-test" ? "unknown" : undefined);
    assert.equal(published.gatewayChatPhase, undefined);
    assert.doesNotMatch(JSON.stringify(published), /private-canary/);
  }
});
