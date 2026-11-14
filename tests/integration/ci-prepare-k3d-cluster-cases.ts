import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import { defaultK3sImage } from "../../scripts/ci/prepare.mjs";
import { prepareGatewayRouting } from "../../scripts/ci/routing.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  assertStderrMatch,
  digest,
  fixtureImageCommands,
  fixturePreparationMetrics,
  writeFixtureCommand,
} from "../helpers/ci-prepare-fixture.ts";
import { eachSettled } from "../helpers/child-processes.mjs";
import { bashString, startCommandServer } from "../helpers/fixture-command-server.ts";
import { waitFor, waitUntil, within } from "../helpers/wait-for.mjs";
import { interceptFixtureDocker, type ImageCommands } from "./ci-prepare-k3d-docker-fixture.ts";

// Linux reports an exited but unreaped process as a zombie; it holds nothing.
function processRunning(pid: number) {
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

async function hungK3dProcesses(commands: ImageCommands) {
  const text = await readFile(join(dirname(commands.statePath), "hung-pids"), "utf8");
  return processIds(text.trim().split("\n").map(Number));
}

function processIds(value: unknown): number[] {
  assert.ok(Array.isArray(value), "expected a PID list");
  return value.map((pid: unknown) => {
    assert.ok(
      typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0,
      "expected a positive PID",
    );
    return pid;
  });
}

function diagnosticsReport(text: string) {
  const report = asRecord(JSON.parse(text));
  assert.ok(report, "expected a k3d diagnostics report");
  return report;
}

async function readDiagnostics(commands: ImageCommands) {
  return diagnosticsReport(await readFile(`${commands.statePath}.diagnostics.json`, "utf8"));
}

export function registerFixtureBuildDeadlineCases() {
  // Only external commands are substituted: the preparation CLI owns child deadlines,
  // cleanup inventory, and publication. These cases do not exercise Docker or Kubernetes.
  const fixtureImageStages = ["fixture-engine-version", "fixture-image-build"];
  for (const stage of fixtureImageStages) {
    test(`fixture preparation bounds ${stage} before publishing test inputs`, async (t) => {
      const version = stage === "fixture-engine-version";
      const buildBudgetMs = 8_000;
      const reserveMs = 2_000;
      const lane = "k3d-fixture-network";
      const commands = await fixtureImageCommands(t, "success", lane, {
        OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: version ? "3000" : "30000",
        OPENCLAW_CI_COMMAND_KILL_GRACE_MS: version ? "3000" : "100",
        OPENCLAW_CI_IMAGE_BUILD_TEST_RESERVE_MS: String(reserveMs),
        // Invalid deadlines still need a finite engine-probe limit.
        ...(version ? { CI_RUNNER_DEADLINE_MS: "invalid" } : {}),
      });
      const pidFile = join(dirname(commands.statePath), "fixture-command-pids");
      const privateUrl = syntheticCredentialUrl({
        username: "fixture-user",
        password: "fixture-password",
        host: "example.test",
        port: undefined,
      });
      // Only Docker's step identity is public; command arguments and arbitrary
      // container output can contain credentials and terminal control sequences.
      const buildTail = `#9 [9/9] RUN partial line\n#1 [1/4] FROM ${privateUrl}\r\n#1 DONE 0.1s\r\n#2 [2/4] RUN fetch ${privateUrl}\n#2 0.1 progress\r#2 DONE\n#2 0.1 private build output\n#3 [3/4] COPY \u001b[31mprivate terminal text\n`;
      // Clipping lands inside the first line, immediately before a valid-looking
      // step prefix. Neither that fragment nor the control-bearing step is evidence.
      const buildOutput = `prefix${buildTail}${"x".repeat(32_768 - buildTail.length)}`;

      await interceptFixtureDocker(t, commands, (args) => {
        const selected = version
          ? args.join(" ") === "version --format {{.Server.Version}}"
          : args[0] === "build" && args.at(-1)?.endsWith("/tests/fixtures/kubernetes");
        if (selected) {
          // PostgreSQL shares the version probe. Its unmodified caller finishes
          // normally; no arrival-order assumption selects the fixture's child.
          const original = join(dirname(commands.statePath), "bin", "docker.mjs.original");
          if (version) {
            // Allow command-server startup on busy runners without booting another
            // Node process just to record the probe. The real CLI still kills the
            // fixture probe before this delay ends; PostgreSQL completes normally.
            return (
              `printf '%s\\n' "$$" >> ${bashString(pidFile)}; ` +
              `printf '%s\\n' 'private build output' >&2; ` +
              `"$__sleep" 6; exec ${bashString(original)} ${args.map(bashString).join(" ")}`
            );
          }
          const program = `
            const { appendFileSync } = require("node:fs");
            const { spawn, spawnSync } = require("node:child_process");
            appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
            process.stderr.write("private build output\\n");
            process.stderr.write(${JSON.stringify(buildOutput)});
            const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`
              require("node:fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
              process.on("SIGTERM", () => {});
              setTimeout(() => {}, 30_000);
            `)}], { stdio: "ignore" });
            setTimeout(() => {
              descendant.kill("SIGKILL");
              process.exit(spawnSync(${JSON.stringify(original)}, ${JSON.stringify(args)}, { stdio: "inherit" }).status);
            }, 10000);
          `;
          return `exec ${bashString(process.execPath)} -e ${bashString(program)}`;
        }
        if (
          !version &&
          args.slice(0, 3).join(" ") === "image rm -f" &&
          args[3]?.endsWith("/fixture:local")
        ) {
          // A timed-out build need not have created its planned local image.
          return "exit 0";
        }
        return undefined;
      });
      // Start the build budget at CLI launch, after synthetic shim setup.
      const result = version
        ? await commands.prepare()
        : await commands.prepare([], {
            env: { CI_RUNNER_DEADLINE_MS: String(Date.now() + buildBudgetMs) },
          });
      assert.equal(
        result.error,
        undefined,
        "the outer test watchdog must not enforce the deadline",
      );
      assert.equal(result.status, 1, "fixture preparation must fail");
      const pidText = await readFile(pidFile, "utf8").catch((error: unknown) => {
        if (version || asRecord(error)?.code !== "ENOENT") {
          throw error;
        }
        const lines = result.stderr.split("\n");
        const refused = fixtureImageStages.find((candidate) =>
          lines.includes(
            `Fixture image preparation ${candidate} was not started: the lane keeps ` +
              `${reserveMs} ms before its deadline for remaining preparation and tests.`,
          ),
        );
        if (refused) {
          assert.fail(`missing build PID witness: ${refused} refused the remaining lane budget`);
        }
        let metrics;
        try {
          metrics = fixturePreparationMetrics(result.stderr, lane);
        } catch {
          assert.fail("missing build PID witness: invalid CI preparation metric");
        }
        const failedAttempt = metrics
          .reverse()
          .find(
            (metric) =>
              metric.status === "failed" &&
              (fixtureImageStages.includes(metric.stage) || metric.stage === "k3d-create"),
          );
        assert.fail(
          failedAttempt
            ? `missing build PID witness: ${failedAttempt.stage} reported a failed attempt`
            : "missing build PID witness: prepare stage unknown",
        );
      });
      const pids = processIds(pidText.trim().split("\n").map(Number));
      t.after(() => {
        for (const pid of pids) {
          if (processRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      });
      assert.equal(pids.length, 2);
      // The build child has redirected pipes and ignores TERM. Its leader exits
      // first, so only a preserved group escalation can stop it before cleanup.
      for (const pid of pids) {
        assert.equal(processRunning(pid), false, `fixture command process ${pid} must stop`);
      }
      const timeout = result.stderr.match(
        new RegExp(`Fixture image preparation ${stage} timed out after ([0-9]+) ms`),
      );
      assert.ok(timeout, "expected fixture command timeout");
      if (!version) {
        const timeoutMs = Number(timeout[1]);
        assert.ok(
          timeoutMs > 0 && timeoutMs <= buildBudgetMs - reserveMs,
          "reported build timeout must leave the reserve for remaining preparation and tests",
        );
      }
      const metrics = fixturePreparationMetrics(result.stderr, lane);
      assert.ok(
        metrics.some((metric) => metric.stage === stage && metric.status === "started"),
        "expected fixture command start",
      );
      const failed = metrics.find((metric) => metric.stage === stage && metric.status === "failed");
      assert.ok(failed, "expected fixture command failure");
      if (version) {
        const { elapsedMs } = failed;
        assert.ok(elapsedMs !== undefined, "the failed probe must report its elapsed time");
        // A prompt child exit releases its supervisor; do not wait on a stale
        // group number until the three-second escalation grace expires.
        // Two seconds of scheduling margin still excludes deadline + full grace.
        assert.ok(elapsedMs < 5000, `prompt timeout settlement took ${elapsedMs} ms`);
      }
      if (!version) {
        assert.ok(
          /Fixture image build steps \(captured tail\): #1 \[1\/4\] FROM DONE; #2 \[2\/4\] RUN$/m.test(
            result.stderr,
          ),
          "expected sanitized build steps",
        );
      }
      assert.ok(!result.stderr.includes(privateUrl));
      assert.ok(
        !/fixture-password|private terminal text/.test(result.stderr),
        "build progress must omit private text",
      );
      assert.ok(!result.stderr.includes("\u001b"));
      assert.ok(
        !result.stderr.includes("private build output"),
        "build progress must omit raw output",
      );
      const state = await commands.readState();
      const image = state.resources.find(({ kind }) => kind === "image-tag");
      if (version) {
        assert.equal(image, undefined);
      } else {
        assert.ok(image, "expected the planned fixture image");
        assert.equal(image.status, "planned");
      }
      assert.equal(state.env, undefined);
      assert.ok(!state.resources.some(({ kind }) => kind === "k3d-image"));
      await assert.rejects(stat(commands.githubEnv), { code: "ENOENT" });
      await commands.cleanupSuccessfully();
      await assert.rejects(stat(commands.statePath), { code: "ENOENT" });
    });
  }

  test(
    "fixture preparation cancellation stops SIGINT-ignoring build descendants",
    {
      skip: process.platform === "win32" && "POSIX process-group cancellation",
    },
    async (t) => {
      const cancellation: {
        cli?: ChildProcess;
        preparation?: ReturnType<ImageCommands["prepare"]>;
        pidFile?: string;
      } = {};
      // Register before fixture cleanup so even the broken supervisor's leaked
      // processes are stopped while their ownership record is still available.
      t.after(async () => {
        const { cli, pidFile, preparation } = cancellation;
        const pids = pidFile
          ? processIds(JSON.parse(await readFile(pidFile, "utf8").catch(() => "[]")))
          : [];
        for (const pid of pids) {
          if (processRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
        if (cli?.exitCode === null && cli.signalCode === null) {
          cli.kill("SIGKILL");
        }
        if (preparation) {
          await within(preparation, "cancelled preparation teardown", 5000);
        }
        await waitUntil(
          "cancelled test processes to stop",
          () => pids.every((pid) => !processRunning(pid)),
          1000,
        );
      });
      const commands = await fixtureImageCommands(t, "success", "k3d-fixture-network");
      const pidFile = join(dirname(commands.statePath), "cancelled-build-pids");
      cancellation.pidFile = pidFile;
      // Cancellation can arrive after the real helper registers the cluster but
      // before the external create is accepted. Hold that boundary deterministically.
      let createStarted = false;
      const k3d = join(dirname(commands.statePath), "bin", "k3d.mjs");
      const originalK3d = `${k3d}.original`;
      await rename(k3d, originalK3d);
      const clusterServer = await startCommandServer({
        forwardedEnv: [],
        handle: ({ args, io }) => {
          if (args[0] === "cluster" && args[1] === "create") {
            createStarted = true;
            io.exitAfter(124, 60000);
          } else {
            io.script(`exec ${bashString(originalK3d)} ${args.map(bashString).join(" ")}`);
          }
        },
      });
      t.after(() => clusterServer.close());
      await writeFixtureCommand(k3d, "k3d", clusterServer);
      await interceptFixtureDocker(t, commands, (args) => {
        if (args[0] === "build" && args.at(-1)?.endsWith("/tests/fixtures/kubernetes")) {
          const descendant = `
          process.on("SIGINT", () => {});
          const fs = require("node:fs");
          fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, JSON.stringify([process.ppid, process.pid]));
          fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
          setTimeout(() => {}, 60000);
        `;
          const program = `
          require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" });
        `;
          return `exec ${bashString(process.execPath)} -e ${bashString(program)}`;
        }
        if (args.slice(0, 3).join(" ") === "image rm -f" && args[3]?.endsWith("/fixture:local")) {
          return "exit 0";
        }
        return undefined;
      });
      const preparation = commands.prepare([], {
        onSpawn: (child) => {
          cancellation.cli = child;
        },
      });
      cancellation.preparation = preparation;
      const pids = await waitFor(
        "cluster create and build descendant signal handler",
        async () => {
          if (!createStarted) {
            return undefined;
          }
          const text = await readFile(pidFile, "utf8").catch(() => undefined);
          return text === undefined ? undefined : processIds(JSON.parse(text));
        },
        30000,
      );
      assert.equal(pids.length, 2);
      assert.ok(pids.every(processRunning));
      assert.ok(cancellation.cli, "expected the preparation CLI child");
      cancellation.cli.kill("SIGINT");
      const result = await within(preparation, "SIGINT preparation cancellation", 5000);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, "SIGINT");
      // The public cancellation, not fixture cleanup or self-expiry, must stop
      // even a descendant that ignores INT and retains the command's pipes.
      await waitUntil(
        "cancelled build processes to stop",
        () => pids.every((pid) => !processRunning(pid)),
        1000,
      );
      const state = await commands.readState();
      assert.equal(state.env, undefined);
      assert.equal(state.resources.find(({ kind }) => kind === "image-tag")?.status, "planned");
      assert.equal(state.resources.find(({ kind }) => kind === "k3d-cluster")?.status, "planned");
      assert.ok(
        !(await commands.commands()).some(
          ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "create",
        ),
      );
      await assert.rejects(stat(commands.githubEnv), { code: "ENOENT" });
      await commands.cleanupSuccessfully();
    },
  );

  test("fixture preparation refuses an exhausted image budget before probing Docker", async (t) => {
    const commands = await fixtureImageCommands(t, "success", "k3d-fixture-network", {
      CI_RUNNER_DEADLINE_MS: String(Date.now()),
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1, result.stderr);
    assertStderrMatch(
      result.stderr,
      /Fixture image preparation fixture-engine-version was not started: the lane keeps 180000 ms/,
    );
    assert.doesNotMatch(result.stderr + result.stdout, /did not finish building|20 min|cache miss/);
    const state = await commands.readState();
    assert.ok(!state.resources.some(({ kind }) => kind === "image-tag"));
    assert.equal(state.env, undefined);
    // The only version probe belongs to concurrent PostgreSQL preparation.
    assert.equal(
      (await commands.commands()).filter(
        ({ command, args }) => command === "docker" && args[0] === "version",
      ).length,
      1,
    );
    await commands.cleanupSuccessfully();
  });

  for (const timeout of ["Infinity", "2147483648"]) {
    test(`fixture preparation rejects unsupported command timeout ${timeout}`, async (t) => {
      const commands = await fixtureImageCommands(t, "success", "k3d-fixture-network", {
        OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: timeout,
        CI_RUNNER_DEADLINE_MS: "invalid",
      });
      const result = await commands.prepare();
      assert.equal(result.status, 1, result.stderr);
      assertStderrMatch(
        result.stderr,
        /fixture-engine-version requires a valid finite command timeout/,
      );
      const state = await commands.readState();
      assert.ok(!state.resources.some(({ kind }) => kind === "image-tag"));
      assert.equal(state.env, undefined);
      // Concurrent PostgreSQL still owns its existing version probe.
      assert.equal(
        (await commands.commands()).filter(
          ({ command, args }) => command === "docker" && args[0] === "version",
        ).length,
        1,
      );
      await commands.cleanupSuccessfully();
    });
  }
}

export function registerClusterBootstrapCases() {
  test("fixture preparation rejects an unknown proxy source before publishing its environment", async (t) => {
    const commands = await fixtureImageCommands(t, "missing-proxy-source");
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /Unable to determine the cross-node plugin status proxy source/,
    );
    const state = await commands.readState();
    assert.equal(state.env, undefined);
    await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
    // Failed preparation retains ownership so cleanup can remove the partial cluster.
    await commands.cleanupSuccessfully();
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
  });

  test("fixture preparation retries a failed worker Pod CIDR read and waits for assignment", async (t) => {
    const commands = await fixtureImageCommands(t, "late-pod-cidr");
    const result = await commands.prepare();
    assert.equal(result.status, 0, result.stderr);
    const calls = await commands.commands();
    const reads = calls.filter(
      ({ command, args }) =>
        command === "kubectl" &&
        args.slice(4, 6).join(" ") === "get node" &&
        args[6]?.endsWith("-agent-0") &&
        args.slice(7).join(" ") === "-o json",
    );
    // A refused read, a Ready node without a Pod CIDR, then the assigned CIDR.
    assert.equal(reads.length, 3);
    for (let index = 1; index < reads.length; index += 1) {
      const current = reads[index]?.at;
      const previous = reads[index - 1]?.at;
      assert.ok(current !== undefined && previous !== undefined, "expected timed Pod CIDR reads");
      const gap = current - previous;
      assert.ok(gap >= 245, `read ${index + 1} started ${gap} ms after the one before it`);
    }
    assertStderrMatch(result.stderr, /waiting for k3d-\S+-agent-0 to get its Pod CIDR/);
    // The wait is announced once, not on every read.
    assert.equal(result.stderr.match(/to get its Pod CIDR/g)?.length, 1);
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation names the worker that never gets a Pod CIDR", async (t) => {
    const commands = await fixtureImageCommands(t, "no-pod-cidr", undefined, {
      OPENCLAW_CI_K3D_POD_CIDR_WAIT_MS: "1000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(result.stderr, /k3d node k3d-\S+-agent-0 got no Pod CIDR within 1000 ms\./);
    const state = await commands.readState();
    assert.equal(state.env, undefined);
    await commands.cleanupSuccessfully();
  });

  // The deadline error names the last read's outcome: a refused read followed by reads that
  // answer without a Pod CIDR reports the missing CIDR, not the earlier refusal (finding 1699).
  // The wait only has to outlast one refused read (it fails only if that fake kubectl read takes
  // 2 s or more), so no read count or pacing is asserted.
  test("fixture preparation reports the last Pod CIDR read, not an earlier refusal", async (t) => {
    const commands = await fixtureImageCommands(t, "refused-then-no-pod-cidr", undefined, {
      OPENCLAW_CI_K3D_POD_CIDR_WAIT_MS: "2000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(result.stderr, /k3d node k3d-\S+-agent-0 got no Pod CIDR within 2000 ms\./);
    assert.doesNotMatch(result.stderr, /synthetic node read refusal/);
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation bounds a hung Pod CIDR read and reports its failure", async (t) => {
    // A wait shorter than the one-second read floor makes the first hung read decisive.
    const commands = await fixtureImageCommands(t, "hung-pod-cidr-read", undefined, {
      OPENCLAW_CI_K3D_POD_CIDR_WAIT_MS: "100",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /Unable to read k3d node k3d-\S+-agent-0 within 100 ms: .*timed out after 1000ms/,
    );
    const state = await commands.readState();
    assert.equal(state.env, undefined);
    await commands.cleanupSuccessfully();
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
      // The hung events read waits out the diagnostic command timeout (5 s here; 10 s by default).
      const commands = await fixtureImageCommands(
        t,
        scenario,
        undefined,
        scenario === "nodes-unready-diagnostics-failed"
          ? { OPENCLAW_CI_K3D_DIAGNOSTICS_TIMEOUT_MS: "5000" }
          : {},
      );
      const result = await commands.prepare();
      assert.equal(result.error, undefined, "diagnostics must finish within the CLI watchdog");
      assert.equal(result.status, 1);
      const finalLine = result.stderr.trim().split("\n").at(-1);
      assert.ok(finalLine, "expected a preparation failure");
      assert.match(finalLine, error);

      const failedTiming = fixturePreparationMetrics(result.stderr).find(
        (metric) => metric.stage === stage && metric.status === "failed",
      );
      assert.ok(failedTiming, "the bootstrap failure must retain its measured stage");
      const { elapsedMs } = failedTiming;
      assert.ok(elapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs >= 0);

      const artifactPath = `${commands.statePath}.diagnostics.json`;
      const artifactText = await readFile(artifactPath, "utf8");
      const evidence = diagnosticsReport(artifactText);
      assert.equal(evidence.lane, "k3d-fixture-configuration");
      assert.equal(evidence.nodeImage, defaultK3sImage);
      if (scenario === "cluster-create-failed") {
        // Container diagnostics remain available before a kubeconfig can be written.
        for (const field of ["nodes", "pods", "events"]) {
          assert.equal(asRecord(evidence[field])?.status, "unavailable");
        }
      } else {
        const nodes = asRecord(evidence.nodes);
        assert.ok(nodes, "expected node diagnostics");
        assert.equal(nodes.status, "ok");
        assert.match(JSON.stringify(nodes.value), /KubeletNotReady/);
      }
      const { containers } = evidence;
      assert.ok(Array.isArray(containers), "expected container diagnostics");
      assert.equal(containers.length, 2);
      for (const entry of containers) {
        const container = asRecord(entry);
        const logs = asRecord(container?.logs);
        assert.equal(asRecord(container?.state)?.status, "ok");
        assert.equal(logs?.status, "ok");
        assert.ok(typeof logs?.value === "string", "expected the node log excerpt");
        assert.match(logs.value, /network plugin is not ready\n.*Error updating node status/s);
        assert.doesNotMatch(logs.value, /localhost:8080 was refused/);
        assert.match(logs.value, /omitted 150 kubectl retry lines against localhost:8080/);
      }
      assert.doesNotMatch(artifactText, /do-not-publish/);
      assert.doesNotMatch(result.stderr, /do-not-publish/);
      const pods = asRecord(evidence.pods);
      const events = asRecord(evidence.events);
      if (scenario === "nodes-unready-diagnostics-failed") {
        assert.equal(pods?.status, "unavailable");
        assert.equal(events?.status, "timed-out");
      } else if (scenario === "nodes-unready") {
        assert.ok(pods && events, "expected Pod and event diagnostics");
        assert.equal(pods.status, "ok");
        assert.match(JSON.stringify(pods.value), /Unschedulable/);
        assert.equal(events.status, "ok");
        assert.match(JSON.stringify(events.value), /FailedScheduling/);
      }

      // Failure must retain owned cleanup state without admitting workload execution.
      const state = await commands.readState();
      const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
      assert.ok(cluster, "expected the k3d cluster cleanup receipt");
      assert.equal(evidence.cluster, cluster.name);
      assert.equal(cluster.status, "planned");
      assert.equal(state.env, undefined);
      await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
      await commands.cleanupSuccessfully();
      await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
      const directory = cluster.directory;
      assert.ok(directory, "expected the owned cluster directory");
      await assert.rejects(() => stat(directory), { code: "ENOENT" });
      assert.equal(await readFile(artifactPath, "utf8"), artifactText);
    });
  }
}

export function registerClusterCreateCases() {
  test("staged sign-in preparation retains unacknowledged creation without rollback or retry", async (t) => {
    // Exercise the real staging producer and an actual timed-out child. The
    // command server models external k3d/Docker responses, not live resources.
    const commands = await fixtureImageCommands(t, "cluster-create-hangs-once", "staging-signin", {
      OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "3000",
    });
    const result = await commands.prepareStagingSignin();
    assert.equal(result.error, undefined, "the producer must settle before the test watchdog");
    assert.equal(result.status, 1, "an unacknowledged creation cannot be retried as successful");
    assertStderrMatch(result.stderr, /unconfirmed creation.*reconciliation/u);
    const calls = await commands.commands();
    const creates = calls.filter(
      ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "create",
    );
    assert.equal(creates.length, 1);
    assert.ok(
      creates[0]?.args.includes("--no-rollback"),
      "k3d itself must preserve unacknowledged resources",
    );
    assert.ok(
      !calls.some(
        ({ command, args }) =>
          (command === "k3d" && args[0] === "cluster" && args[1] === "delete") ||
          (command === "docker" && args.includes("rm")),
      ),
      "no deletion authority exists before a receipt",
    );
    const state = await commands.readState();
    const clusters = state.resources.filter(({ kind }) => kind === "k3d-cluster");
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]?.status, "planned");
    for (const pid of await hungK3dProcesses(commands)) {
      assert.equal(processRunning(pid), false, `local child ${pid} must have settled`);
    }
    // The fixture directory is removed by its own hook; no modeled resource
    // deletion is invoked and this test does not establish daemon settlement.
  });

  test("k3d preparation times out a hung cluster create, discards it and retries once", async (t) => {
    const commands = await fixtureImageCommands(t, "cluster-create-hangs-once", undefined, {
      OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "5000",
    });
    const result = await commands.prepare();
    assert.equal(result.error, undefined, "a hung create must not reach the CLI watchdog");
    assert.equal(result.status, 0, result.stderr);
    assertStderrMatch(
      result.stderr,
      /k3d cluster create openclaw-k8s-\S+ did not finish within 5000 ms \(attempt 1 of 2\)/,
    );
    const stages = fixturePreparationMetrics(result.stderr)
      .filter(({ stage, status }) => stage.startsWith("k3d-create") && status !== "started")
      .map(({ stage, status }) => `${stage}:${status}`);
    assert.deepEqual(stages, [
      "k3d-create:failed",
      "k3d-create-discard:passed",
      "k3d-create:passed",
    ]);
    // k3d's own progress reaches the job log as it happens, without colour codes.
    assertStderrMatch(
      result.stderr,
      /^\[prepare:\S+\] k3d: INFO\[0002\] Starting node 'k3d-openclaw-k8s-\S+-server-0'$/m,
    );
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
    const evidence = await readDiagnostics(commands);
    assert.ok(typeof evidence.failure === "string", "expected the recorded create failure");
    assert.match(evidence.failure, /\(attempt 1 of 2\)$/);
    const output = evidence.k3dCreateOutput;
    assert.ok(typeof output === "string", "expected captured k3d create output");
    // The step k3d stopped in, and a server that runs only k3d's retry loop.
    assert.match(output, /^INFO\[0002\] Starting node 'k3d-openclaw-k8s-\S+-server-0'$/);
    const { containers } = evidence;
    assert.ok(Array.isArray(containers), "expected container diagnostics");
    const processes = asRecord(asRecord(containers[0])?.processes)?.value;
    assert.ok(typeof processes === "string", "expected a captured process list");
    assert.match(processes, /kubectl uncordon/);

    const state = await commands.readState();
    const clusters = state.resources.filter(({ kind }) => kind === "k3d-cluster");
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]?.status, "ready");
    await commands.cleanupSuccessfully();
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
  });

  test("k3d preparation stops waiting for create output held outside its process group", async (t) => {
    const commands = await fixtureImageCommands(t, "cluster-create-hangs-escaped", undefined, {
      OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "4000",
      OPENCLAW_CI_COMMAND_KILL_GRACE_MS: "1000",
    });
    // Read before the fixture's own after hook removes the directory: hooks run in order.
    const escapedPids = join(dirname(commands.statePath), "escaped-pids");
    let escaped = "";
    t.after(() => {
      for (const pid of escaped.split("\n").map(Number)) {
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
    const result = await commands.prepare();
    escaped = await readFile(escapedPids, "utf8").catch(() => "");
    assert.equal(result.error, undefined, "held output must not reach the CLI watchdog");
    assert.equal(result.status, 0, result.stderr);
    const timings = fixturePreparationMetrics(result.stderr).filter(
      ({ stage, status }) => stage.startsWith("k3d-create") && status !== "started",
    );
    assert.deepEqual(
      timings.map(({ stage, status }) => `${stage}:${status}`),
      ["k3d-create:failed", "k3d-create-discard:passed", "k3d-create:passed"],
    );
    // SIGTERM is ignored: SIGKILL follows after the 1 s grace. Killing the
    // supervisor closes its output even while an escaped child holds its input.
    const elapsedMs = timings[0]?.elapsedMs;
    assert.ok(
      elapsedMs !== undefined && elapsedMs >= 5_000,
      `first attempt ended after ${elapsedMs} ms`,
    );
    for (const pid of await hungK3dProcesses(commands)) {
      assert.equal(processRunning(pid), false, `hung k3d process ${pid} must not survive`);
    }
    await commands.cleanupSuccessfully();
  });

  test("k3d preparation fails clearly when every cluster create attempt hangs", async (t) => {
    const commands = await fixtureImageCommands(t, "cluster-create-hangs", undefined, {
      OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS: "3000",
    });
    const result = await commands.prepare();
    assert.equal(result.error, undefined, "a hung create must not reach the CLI watchdog");
    assert.equal(result.status, 1);
    const finalLine = result.stderr.trim().split("\n").at(-1);
    assert.ok(finalLine, "expected a preparation failure");
    assert.match(
      finalLine,
      /^k3d cluster create openclaw-k8s-\S+ did not finish within 3000 ms \(attempt 2 of 2\); giving up\./,
    );
    for (const pid of await hungK3dProcesses(commands)) {
      assert.equal(processRunning(pid), false, `hung k3d process ${pid} must not survive`);
    }
    const creates = (await commands.commands()).filter(
      ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "create",
    );
    assert.equal(creates.length, 2);
    const evidence = await readDiagnostics(commands);
    assert.ok(typeof evidence.failure === "string", "expected the recorded create failure");
    assert.match(evidence.failure, /\(attempt 2 of 2\)$/);
    assert.ok(Array.isArray(evidence.containers), "expected container diagnostics");
    assert.equal(evidence.containers.length, 2);

    // The partial cluster stays registered for cleanup; nothing is published.
    const state = await commands.readState();
    const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
    assert.ok(cluster, "expected the k3d cluster cleanup receipt");
    assert.equal(cluster.status, "planned");
    assert.equal(state.env, undefined);
    await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
    await commands.cleanupSuccessfully();
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
    const directory = cluster.directory;
    assert.ok(directory, "expected the owned cluster directory");
    await assert.rejects(() => stat(directory), { code: "ENOENT" });
  });
}

export function registerFixtureStorageCases() {
  for (const scenario of ["storage-unready", "storage-after-image-unready"]) {
    test(`fixture preparation reports unavailable storage without publishing workload inputs: ${scenario}`, async (t) => {
      const commands = await fixtureImageCommands(t, scenario);
      const result = await commands.prepare();
      assert.equal(result.status, 1);
      assertStderrMatch(result.stderr, /CI fixture storage controller is not ready/);
      assertStderrMatch(result.stderr, /CrashLoopBackOff/);
      assertStderrMatch(result.stderr, /fixture configuration rejected/);
      assertStderrMatch(result.stderr, /Unschedulable/);
      assertStderrMatch(result.stderr, /KubeletHasDiskPressure/);
      assert.doesNotMatch(result.stderr, /do-not-publish-pod-spec/);
      await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
      const state = await commands.readState();
      assert.equal(state.env, undefined);
      if (scenario === "storage-unready") {
        // The initial rollout failed. Preparation settles the concurrent import for
        // cleanup. It must not declare the cluster ready, pin the image or restart storage.
        const resource = (kind: string) => state.resources.find((entry) => entry.kind === kind);
        assert.equal(resource("k3d-image")?.status, "ready");
        assert.equal(resource("k3d-cluster")?.status, "planned");
        const calls = await commands.commands();
        assert.ok(!calls.some(({ args }) => args.includes("restart") || args.includes("apply")));
        const diagnostics = await readDiagnostics(commands);
        assert.equal(diagnostics.lane, state.lane);
      }
      await commands.cleanupSuccessfully();
    });
  }

  const faults: readonly [scenario: string, fault: "host inspection" | "missing manifest"][] = [
    ["storage-unready", "host inspection"],
    ["success", "host inspection"],
    ["success", "missing manifest"],
  ];
  for (const [scenario, fault] of faults) {
    test(`fixture image diagnostics for ${fault} with ${scenario}`, async (t) => {
      const commands = await fixtureImageCommands(t, scenario);
      const detail = "synthetic host inspection detail";
      let faults = 0;
      await interceptFixtureDocker(t, commands, (args) => {
        if (
          fault === "host inspection" &&
          args.length === 3 &&
          args[0] === "image" &&
          args[1] === "inspect"
        ) {
          faults += 1;
          return `printf '%s\\n' ${bashString(detail)} >&2; exit 1`;
        }
        // Both nodes received the stream, but the server cannot find its manifest.
        if (
          fault === "missing manifest" &&
          args[0] === "exec" &&
          args.slice(2).join(" ") === "ctr -n k8s.io images list"
        ) {
          faults += 1;
          return "exit 0";
        }
      });
      const result = await commands.prepare();
      assert.equal(result.status, 1);
      assert.equal(faults, 1);
      const storageFailed = scenario === "storage-unready";
      const primary = result.stderr.trimEnd().split("\n").at(-1);
      assert.ok(primary, "expected a preparation failure");
      if (storageFailed) {
        assert.match(primary, /CI fixture storage controller is not ready/);
        assert.ok(!result.stderr.includes(detail));
      } else if (fault === "host inspection") {
        assert.ok(primary.includes(detail));
      } else {
        assert.match(primary, /Unable to find imported OCI manifest digest/);
      }
      const diagnostic = await readFile(`${commands.statePath}.diagnostics.json`, "utf8");
      assert.equal(
        diagnosticsReport(diagnostic).failure,
        "Fixture image preparation failed during fixture-image-import.",
      );
      assert.ok(!diagnostic.includes(detail));
      const state = await commands.readState();
      const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
      assert.ok(cluster, "expected the k3d cluster cleanup receipt");
      assert.equal(cluster.status, storageFailed ? "planned" : "ready");
      assert.equal(state.env, undefined);
      await assert.rejects(stat(commands.githubEnv), { code: "ENOENT" });
      const calls = await commands.commands();
      const imports = calls.filter(({ args }) => args[0] === "exec" && args[1] === "-i");
      assert.equal(imports.length, fault === "missing manifest" ? 2 : 0);
      assert.ok(!calls.some(({ args }) => args.includes("apply") || args.includes("restart")));
      await commands.cleanupSuccessfully();
    });
  }
}

export function registerClusterImageImportCases() {
  test("fixture preparation times out a hung inspect of its own fixture image", async (t) => {
    const commands = await fixtureImageCommands(t, "hung-host-owned", undefined, {
      OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /The container engine did not answer within 3000 ms \(image inspect localhost\/\S+\/fixture:local\)\./,
    );
    await commands.cleanupSuccessfully();
  });

  test("ordinary k3d preparation forwards an immutable K3s override and retains the server version gate", async (t) => {
    const image = `registry.example/k3s:v1.35.8-k3s1@sha256:${digest}`;
    await eachSettled(["success", "wrong-server-version"], async (scenario: string) => {
      const commands = await fixtureImageCommands(t, scenario, "k3d-fixture-configuration", {
        OPENCLAW_CI_K3S_IMAGE: image,
      });
      const result = await commands.prepare();
      assert.equal(result.status, scenario === "success" ? 0 : 1, result.stderr);
      const state = await commands.readState();
      const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
      assert.ok(cluster, "expected the k3d cluster cleanup receipt");
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
      await commands.cleanupSuccessfully();
    });
  });

  // K3s installs the Gateway API CRDs with Traefik, and routing waits up to 180 s for each one.
  // A lane added to lanesWithoutK3sAddons that also sets up routing must fail at once instead.
  test("gateway routing refuses a cluster created without K3s's Traefik before any side effect", async (t) => {
    const commands = await fixtureImageCommands(t, "success", "k3d-fixture-configuration");
    const result = await commands.prepare();
    assert.equal(result.status, 0, result.stderr);
    const state = await commands.readState();
    const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
    assert.ok(cluster, "expected the k3d cluster cleanup receipt");
    const { name, directory, kubeconfig, context, disabledK3sAddons } = cluster;
    const expectedDisabledAddons = ["traefik", "servicelb", "metrics-server"];
    assert.deepEqual(disabledK3sAddons, expectedDisabledAddons);
    assert.ok(
      name && directory && typeof kubeconfig === "string" && typeof context === "string",
      "expected the fixture's owned routing cluster coordinates",
    );
    assert.ok(Array.isArray(disabledK3sAddons), "expected the recorded disabled add-ons");
    await assert.rejects(
      prepareGatewayRouting({
        cluster: { name, directory, kubeconfig, context, disabledK3sAddons },
        execFile: () => assert.fail("routing ran a command against a cluster without Traefik"),
      }),
      { message: /Gateway routing needs K3s's Traefik add-on/ },
    );
    await assert.rejects(stat(join(directory, "gateway-routing")), { code: "ENOENT" });
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation waits for a late worker and its containerd before importing", async (t) => {
    const commands = await fixtureImageCommands(t, "late-worker");
    const result = await commands.prepare();
    assert.equal(result.status, 0, result.stderr);
    assertStderrMatch(
      result.stderr,
      /containerd on k3d-\S+-agent-0 is not answering yet \(attempt 2\)/,
    );
    const calls = await commands.commands();
    const lastListing = calls
      .map(({ args }) => args.slice(-4).join(" "))
      .lastIndexOf("get nodes -o name");
    const listings = calls.filter(({ args }) => args.slice(-4).join(" ") === "get nodes -o name");
    // A refused listing, the server alone, then both nodes.
    assert.equal(listings.length, 3);
    // The Ready wait starts only once the worker is registered.
    assert.ok(lastListing < calls.findIndex(({ args }) => args.includes("--for=condition=Ready")));
    // The worker import starts only after its containerd answers.
    const agentProbe = calls
      .map(
        ({ args }) =>
          args[0] === "exec" && args[1]?.endsWith("-agent-0") && args.at(-1) === "version",
      )
      .lastIndexOf(true);
    const agentImport = calls.findIndex(
      ({ args }) => args[0] === "exec" && args[1] === "-i" && args[2]?.endsWith("-agent-0"),
    );
    assert.ok(agentProbe >= 0 && agentImport > agentProbe);
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation names the node whose containerd never answers and imports nothing", async (t) => {
    const commands = await fixtureImageCommands(t, "containerd-down", undefined, {
      OPENCLAW_CI_K3D_CONTAINERD_WAIT_MS: "2000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /containerd on k3d-\S+-agent-0 did not answer within 2000 ms: .*connect: connection refused/,
    );
    assert.equal(
      (await commands.commands()).some(({ args }) => args[0] === "exec" && args[1] === "-i"),
      false,
    );
    const state = await commands.readState();
    assert.equal(state.env, undefined);
    // The failure keeps node diagnostics for the outage.
    const evidence = await readDiagnostics(commands);
    assert.ok(typeof evidence.failure === "string", "expected the recorded import failure");
    assert.match(
      evidence.failure,
      /image import into k3d nodes failed: containerd on k3d-\S+-agent-0 did not answer/,
    );
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation drains the active sibling probe before collecting diagnostics", async (t) => {
    const commands = await fixtureImageCommands(t, "success", undefined, {
      OPENCLAW_CI_K3D_CONTAINERD_WAIT_MS: "1",
      OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
    });
    const pidFile = join(dirname(commands.statePath), "server-probe.pid");
    const pidPath = bashString(pidFile);
    const probes: string[] = [];
    const siblingAliveAtDiagnostics: boolean[] = [];
    await interceptFixtureDocker(t, commands, async (args) => {
      if (args[0] === "exec" && args.slice(2).join(" ") === "ctr -n k8s.io version") {
        const node = args[1];
        assert.ok(node, "expected the target containerd node");
        probes.push(node);
        if (node.endsWith("-server-0")) {
          // This probe outlives the worker's refusal and ends at the command timeout.
          return `printf '%s\\n' "$$" > ${pidPath}; exec "$__sleep" 120`;
        }
        return (
          `while [[ ! -s ${pidPath} ]]; do "$__sleep" 0.01; done; ` +
          `read -r pid < ${pidPath}; kill -0 "$pid" || exit 2; ` +
          "echo 'first probe refusal' >&2; exit 1"
        );
      }
      if (args[0] === "inspect" && args[2] === "{{json .State}}") {
        siblingAliveAtDiagnostics.push(processRunning(Number(await readFile(pidFile, "utf8"))));
      }
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    const finalLine = result.stderr.trimEnd().split("\n").at(-1);
    assert.ok(finalLine, "expected a preparation failure");
    assert.match(finalLine, /containerd on \S+-agent-0.*first probe refusal/);
    assert.equal(probes.length, 2);
    assert.equal(new Set(probes).size, 2);
    assert.deepEqual(siblingAliveAtDiagnostics, [false, false]);
    assert.equal((await commands.readState()).env, undefined);
    await assert.rejects(stat(commands.githubEnv), { code: "ENOENT" });
    await commands.cleanupSuccessfully();
  });

  test("fixture preparation fails on a hung containerd probe without polling again", async (t) => {
    const commands = await fixtureImageCommands(t, "hung-containerd-probe", undefined, {
      OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS: "3000",
    });
    const result = await commands.prepare();
    assert.equal(result.status, 1);
    assertStderrMatch(
      result.stderr,
      /containerd on k3d-\S+-agent-0 did not answer within 3000 ms \(ctr -n k8s\.io version\)\./,
    );
    const calls = await commands.commands();
    const probes = (suffix: string) =>
      calls.filter(
        ({ args }) => args[0] === "exec" && args[1]?.endsWith(suffix) && args.at(-1) === "version",
      ).length;
    assert.equal(probes("-agent-0"), 1);
    // The refusing server stops polling once the hang fails the wait, well before its own
    // 60 s deadline (about 30 probes).
    assert.ok(probes("-server-0") <= 10, `${probes("-server-0")} server probes`);
    assert.equal(
      calls.some(({ args }) => args[0] === "exec" && args[1] === "-i"),
      false,
    );
    await commands.cleanupSuccessfully();
  });

  // Only the node's own containerd socket (refused or missing) gets the one retry.
  for (const { scenario, retried, imported, error } of [
    { scenario: "containerd-restart", retried: true, imported: true },
    { scenario: "containerd-socket-missing", retried: true, imported: true },
    {
      scenario: "containerd-refuses-imports",
      retried: true,
      error: /containerd\.sock: connect: connection refused/,
    },
    {
      scenario: "other-socket-refused",
      retried: false,
      error: /\/run\/other\.sock: connect: connection refused/,
    },
  ]) {
    test(`fixture preparation retries an import once only for the node socket: ${scenario}`, async (t) => {
      const commands = await fixtureImageCommands(t, scenario);
      const result = await commands.prepare();
      assert.equal(result.status, imported ? 0 : 1, result.stderr);
      assert.equal(
        /containerd refused the image import; waiting for it/.test(result.stderr),
        retried,
      );
      const calls = await commands.commands();
      const agentImports = calls.flatMap(({ args }, index) =>
        args[0] === "exec" && args[1] === "-i" && args[2]?.endsWith("-agent-0") ? [index] : [],
      );
      assert.equal(agentImports.length, retried ? 2 : 1);
      if (retried) {
        const [firstImport, secondImport] = agentImports;
        assert.ok(
          firstImport !== undefined && secondImport !== undefined,
          "expected two worker imports",
        );
        // The retry waits for the worker's containerd to answer again.
        assert.ok(
          calls
            .slice(firstImport, secondImport)
            .some(
              ({ args }) =>
                args[0] === "exec" && args[1]?.endsWith("-agent-0") && args.at(-1) === "version",
            ),
          "a containerd probe precedes the second import",
        );
      }
      if (imported) {
        // A recovered import writes no failure diagnostics.
        await assert.rejects(() => stat(`${commands.statePath}.diagnostics.json`), {
          code: "ENOENT",
        });
      } else {
        assert.ok(error, "expected the scenario's containerd failure");
        assertStderrMatch(result.stderr, error);
        const evidence = await readDiagnostics(commands);
        assert.ok(typeof evidence.failure === "string", "expected the recorded import failure");
        assert.match(evidence.failure, /image import into k3d nodes failed/);
      }
      await commands.cleanupSuccessfully();
    });
  }
}
