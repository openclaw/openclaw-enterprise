import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { waitForRelayFile } from "../fixtures/workspace-relay-engine.mjs";
import { boundedTeardown } from "./bounded-teardown.ts";
import { registerQaSecret } from "./qa-secrets.mjs";
import { fileTemporaryDirectory } from "./temporary-directory.mjs";
import { startWorkspaceGatewayRelayContainer } from "./workspace-gateway-relay-container.mjs";

const executeFile = promisify(execFile);
const containerEngine = process.env.OCC_DOCKER_BIN ?? "docker";
const image = process.env.OCC_TEST_RUNTIME_IMAGE;
// Allow two bounded 120s fixture launches, a 30s wait, the helper's 120s
// launch, its 5s diagnostic/cleanup commands, and final verification.
const options = { skip: !image && "OCC_TEST_RUNTIME_IMAGE is required", timeout: 480_000 };
const commandOptions = { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 };
const root = fileTemporaryDirectory("oce-workspace-relay-");
const helperUrl = new URL("./workspace-gateway-relay-container.mjs", import.meta.url).href;
const teardownUrl = new URL("./bounded-teardown.ts", import.meta.url).href;
const fixtureUrl = new URL("../fixtures/workspace-relay-engine.mjs", import.meta.url).href;

async function engineWrapper(mode, partialOutput, launchFiles) {
  const path = join(root, `${randomUUID()}.mjs`);
  await writeFile(
    path,
    `#!${process.execPath}\nimport { relayEngine } from ${JSON.stringify(fixtureUrl)};\nrelayEngine(${JSON.stringify({ engine: containerEngine, mode, partialOutput, launchFiles })});\n`,
    { mode: 0o700 },
  );
  return path;
}

// Direct fixture commands deliberately report only stage/status: raw execFile
// errors include the selected private image and inline program in their argv.
async function engineCommand(stage, args, options = {}) {
  try {
    return await executeFile(containerEngine, args, { ...commandOptions, ...options });
  } catch (error) {
    const failure = new Error(
      `Relay fixture ${stage} failed: exit=${error.code ?? "unknown"} signal=${error.signal ?? "none"}`,
    );
    failure.indeterminate = Boolean(
      error.killed || error.signal || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    );
    throw failure;
  }
}

function ownedFixture(context) {
  const label = `org.openclaw.test.relay-fixture=${randomUUID()}`;
  let launch = Promise.resolve();
  let indeterminate = false;
  const find = async () => {
    const { stdout } = await engineCommand("ownership", [
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=${label}`,
    ]);
    const id = stdout.trim();
    if (id === "") {
      return undefined;
    }
    assert.ok(/^[a-f0-9]{64}$/.test(id), "fixture ownership must resolve to one full container ID");
    return id;
  };
  // Register before acquisition: even a rejected run may leave a created container.
  context.after(async () => {
    await launch.catch(() => undefined);
    const id = await find();
    if (id !== undefined) {
      await engineCommand("removal", ["rm", "--force", "--volumes", id]);
    }
    assert.equal(await find(), undefined, "fixture cleanup must remove its owned container");
    assert.equal(indeterminate, false, "fixture launch outcome is indeterminate");
  });
  return {
    label,
    find,
    run(args) {
      launch = engineCommand("launch", ["run", "-d", "--label", label, ...args], {
        timeout: 120_000,
      }).catch((error) => {
        indeterminate = error.indeterminate;
        throw error;
      });
      return launch;
    },
  };
}

async function runChildTest(source) {
  try {
    await executeFile(process.execPath, ["--input-type=module", "-e", source], {
      ...commandOptions,
      timeout: 190_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
  } catch (error) {
    // Never leak the inline test source or incomplete output on a failed child.
    assert.ok(
      !error.killed && !error.signal && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      "child test must settle within its output and time budgets",
    );
    assert.equal(error.code, 1, "child must report its expected test failure");
    return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
  assert.fail("child test must report its expected failure");
}

function runArguments(entrypoint, args) {
  return ["--pull=never", "--network=none", "--entrypoint", entrypoint, image, ...args];
}

function relay(t, entrypoint, args, engine = containerEngine) {
  const relayName = `oce-relay-diagnostic-${randomUUID()}`;
  const started = startWorkspaceGatewayRelayContainer(t, {
    containerEngine: engine,
    relayName,
    runArguments: runArguments(entrypoint, args),
  });
  // The real TestContext runs the helper's teardown before this hook. Check
  // removal after both successful and failed starts, including stopped containers.
  t.after(async () => {
    const { stdout } = await engineCommand("final absence", [
      "ps",
      "-aq",
      "--filter",
      `name=^/${relayName}$`,
    ]);
    assert.equal(stdout.trim(), "", "the owned relay must be removed during cleanup");
  });
  return started;
}

test(
  "relay startup retains exit evidence and redacts bounded container logs",
  options,
  async (t) => {
    const secret = randomUUID();
    registerQaSecret(secret);
    // The delayed exit deliberately outlasts the production 250ms sample. The
    // real-engine wrapper waits for exit before the helper receives run's result.
    const program =
      'setTimeout(() => { require("node:fs").writeSync(2, process.argv[1]); process.exit(23); }, 1500);';
    const logOutput = `${"x".repeat(10000)}\n${secret}\nrelay startup diagnostic marker\n`;
    await assert.rejects(
      relay(t, "node", ["-e", program, logOutput], await engineWrapper("wait-for-exit")),
      (error) => {
        assert.match(error.message, /not observed running/);
        assert.match(error.message, /status=exited running=false exit=23/);
        assert.match(error.message, /relay startup diagnostic marker/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.ok(error.message.length < 8000, "startup diagnostics must stay bounded");
        return true;
      },
    );
  },
);

test("relay startup omits container output cut at the capture limit", options, async (t) => {
  const secret = randomUUID();
  registerQaSecret(secret);
  // Put the bisected secret on a fresh printable line. Rendering the partial
  // buffer would expose both this marker and the secret prefix in the tail.
  const program = `require("node:fs").writeSync(2, "x".repeat(65509) + "\\nWITNESS:" + ${JSON.stringify(secret)} + "tail"); process.exit(24);`;
  await assert.rejects(
    relay(t, "node", ["-e", program], await engineWrapper("wait-for-exit")),
    (error) => {
      assert.match(error.message, /status=exited running=false exit=24/);
      assert.match(error.message, /Output exceeded the 64 KiB capture limit/);
      assert.doesNotMatch(error.message, /WITNESS:/);
      assert.doesNotMatch(error.message, new RegExp(secret.slice(0, 16)));
      return true;
    },
  );
});

test("relay startup omits interrupted diagnostic output", options, async (t) => {
  const secret = randomUUID();
  registerQaSecret(secret);
  const wrapper = await engineWrapper("interrupted-logs", `WITNESS:${secret.slice(0, 16)}`);
  await assert.rejects(relay(t, "node", ["-e", "process.exit(25)"], wrapper), (error) => {
    assert.match(error.message, /exit=25/);
    assert.match(error.message, /Interrupted command output omitted/);
    assert.doesNotMatch(error.message, /WITNESS:/);
    assert.doesNotMatch(error.message, new RegExp(secret.slice(0, 16)));
    return true;
  });
});

test("relay startup preserves engine launch errors before cleanup", options, async (t) => {
  // The run command itself rejects and leaves a created container.
  await assert.rejects(relay(t, "/missing-oce-relay-entrypoint", []), (error) => {
    assert.match(error.message, /run: exit=/);
    assert.match(error.message, /missing-oce-relay-entrypoint/);
    assert.match(error.message, /state:/);
    return true;
  });
});

test("running relay survives startup and is removed by context cleanup", options, async (t) => {
  await relay(t, "node", ["-e", "setInterval(() => {}, 1000)"]);
});

test(
  "relay name conflicts neither disclose nor remove the existing container",
  options,
  async (t) => {
    const relayName = `oce-relay-conflict-${randomUUID()}`;
    const unrelatedMarker = `unrelated-relay-${randomUUID()}`;
    const context = boundedTeardown(t).context;
    const fixture = ownedFixture(context);
    await fixture.run([
      "--name",
      relayName,
      ...runArguments("node", [
        "-e",
        `require("node:fs").writeSync(2, ${JSON.stringify(unrelatedMarker)}); process.exit(26);`,
      ]),
    ]);
    const originalId = await fixture.find();
    assert.ok(originalId, "conflicting fixture must be acquired");
    // The parent disposal helper must also leave another owner's name alone
    // when its own direct acquisition fails.
    const conflictedFixture = ownedFixture(context);
    await assert.rejects(
      conflictedFixture.run([
        "--name",
        relayName,
        ...runArguments("node", ["-e", "process.exit(0)"]),
      ]),
      /Relay fixture launch failed/,
    );
    assert.equal(await conflictedFixture.find(), undefined);

    await engineCommand("wait", ["wait", originalId], { timeout: 30_000 });
    const logged = await engineCommand("logs", ["logs", originalId]);
    assert.match(`${logged.stdout}${logged.stderr}`, new RegExp(unrelatedMarker));
    // Bounded teardown runs newest-first: helper cleanup, survival check, then
    // fixture disposal. Each still runs if an earlier step fails.
    context.after(async () => {
      const inspected = await engineCommand("inspect", ["inspect", "--format={{.Id}}", originalId]);
      assert.equal(
        inspected.stdout.trim(),
        originalId,
        "the conflicting container must survive helper teardown",
      );
    });
    const started = startWorkspaceGatewayRelayContainer(context, {
      containerEngine,
      relayName,
      runArguments: runArguments("node", ["-e", "process.exit(27)"]),
    });
    await assert.rejects(started, (error) => {
      assert.match(error.message, /run: exit=/);
      assert.match(error.message, /No verified owned container; state and logs were not read/);
      assert.doesNotMatch(error.message, new RegExp(unrelatedMarker));
      return true;
    });
  },
);

test("relay cleanup reports removal failure alongside the startup failure", options, async (t) => {
  const relayName = `oce-relay-removal-${randomUUID()}`;
  const wrapper = await engineWrapper("fail-removal");
  // The parent has an independent ownership label; a reused name is never
  // sufficient authority to inspect or remove a container after child failure.
  const fixture = ownedFixture(t);
  const source = `import test from "node:test";
    import { startWorkspaceGatewayRelayContainer } from ${JSON.stringify(helperUrl)};
    import { boundedTeardown } from ${JSON.stringify(teardownUrl)};
    test("startup and cleanup failure", { timeout: 180000 }, async (t) => {
      await startWorkspaceGatewayRelayContainer(boundedTeardown(t).context, ${JSON.stringify({ containerEngine: wrapper, relayName, runArguments: ["--label", fixture.label, ...runArguments("node", ["-e", "process.exit(28)"])] })});
    });`;
  const output = await runChildTest(source);
  assert.match(output, /exit=28/);
  assert.match(output, /Host routing relay cleanup failed/);
  assert.match(output, /invalid-relay-cleanup-option/);
  const id = await fixture.find();
  assert.ok(id, "the child must have acquired its labelled container");
  const retained = await engineCommand("inspect", ["inspect", "--format={{.State.Status}}", id]);
  assert.equal(retained.stdout.trim(), "exited");
});

test(
  "relay cleanup accepts a lost removal acknowledgement only after confirming absence",
  options,
  async (t) => {
    await assert.rejects(
      relay(t, "node", ["-e", "process.exit(29)"], await engineWrapper("lost-removal-ack")),
      (error) => {
        assert.match(error.message, /exit=29/);
        return true;
      },
    );
  },
);

test("fixture cleanup owns containers left by a rejected launch", options, async (t) => {
  const fixture = ownedFixture(t);
  t.after(async () => {
    assert.equal(await fixture.find(), undefined, "failed acquisition must still be disposed");
  });
  await assert.rejects(
    fixture.run(runArguments("/missing-oce-relay-fixture-entrypoint", [])),
    (error) => {
      assert.match(error.message, /^Relay fixture launch failed: exit=\d+ signal=none$/);
      assert.doesNotMatch(error.message, /missing-oce-relay-fixture-entrypoint/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.ok(await fixture.find(), "a failed run still creates a container requiring disposal");
});

async function delegatedLaunchTest(t, mode) {
  const context = boundedTeardown(t).context;
  const fixture = ownedFixture(context);
  const launchFiles = Object.fromEntries(
    ["ready", "release", "finished"].map((name) => [name, join(root, `${randomUUID()}-${name}`)]),
  );
  // Always release and await the delegated engine call before parent disposal,
  // including when the assertion or the child test fails unexpectedly.
  context.after(async () => {
    await writeFile(launchFiles.release, "release");
    await waitForRelayFile(launchFiles.finished);
  });
  const wrapper = await engineWrapper(mode, undefined, launchFiles);
  const source = `import test from "node:test";
    import { writeFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import { waitForRelayFile } from ${JSON.stringify(fixtureUrl)};
    import { startWorkspaceGatewayRelayContainer } from ${JSON.stringify(helperUrl)};
    import { boundedTeardown } from ${JSON.stringify(teardownUrl)};
    const abort = new AbortController();
    test("delegated launch", { timeout: 180000, signal: abort.signal }, async (t) => {
      const started = startWorkspaceGatewayRelayContainer(boundedTeardown(t).context, ${JSON.stringify({ containerEngine: wrapper, relayName: `oce-relay-delegated-${randomUUID()}`, runArguments: ["--label", fixture.label, ...runArguments("node", ["-e", "setInterval(() => {}, 1000)"])] })});
      started.catch((error) => { process.stderr.write(error.message + "\\n"); });
      await waitForRelayFile(${JSON.stringify(launchFiles.ready)});
      if (${JSON.stringify(mode)} === "cancelled-launch") {
        abort.abort();
        // Cleanup must join this still-pending launch before reconciling ownership.
        await delay(1000);
        await writeFile(${JSON.stringify(launchFiles.release)}, "release");
      }
      await started;
    });`;
  const output = await runChildTest(source);
  // In the interrupted case the child has completed its empty ownership lookup
  // before the delegate may create the late container.
  if (mode === "interrupted-launch") {
    await writeFile(launchFiles.release, "release");
  }
  await waitForRelayFile(launchFiles.finished);
  if (mode === "cancelled-launch") {
    assert.match(output, /testAborted/);
    assert.match(output, /observation: cancelled before the running-state check/);
    assert.doesNotMatch(output, /run: exit=ABORT_ERR/);
    assert.equal(
      await fixture.find(),
      undefined,
      "cleanup must join the delegated launch and remove its result",
    );
  } else {
    assert.match(output, /Launch outcome is indeterminate; absence cannot be confirmed/);
    assert.ok(await fixture.find(), "the late container is owned by the parent for disposal");
  }
}

test("relay cleanup waits for a delegated launch when setup is cancelled", options, async (t) => {
  await delegatedLaunchTest(t, "cancelled-launch");
});

test(
  "relay cleanup reports an interrupted delegated launch as indeterminate",
  options,
  async (t) => {
    await delegatedLaunchTest(t, "interrupted-launch");
  },
);
