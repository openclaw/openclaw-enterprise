import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { registerQaSecret } from "./qa-secrets.mjs";
import { fileTemporaryDirectory } from "./temporary-directory.mjs";
import { startWorkspaceGatewayRelayContainer } from "./workspace-gateway-relay-container.mjs";

const executeFile = promisify(execFile);
const containerEngine = process.env.OCC_DOCKER_BIN ?? "docker";
const image = process.env.OCC_TEST_RUNTIME_IMAGE;
// Allow the conflict fixture's own 120s launch and 30s wait, then the helper's
// 120s launch, its 5s diagnostic/cleanup commands, and final verification.
const options = { skip: !image && "OCC_TEST_RUNTIME_IMAGE is required", timeout: 360_000 };
const commandOptions = { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 };
const root = fileTemporaryDirectory("oce-workspace-relay-");
const helperUrl = new URL("./workspace-gateway-relay-container.mjs", import.meta.url).href;
const teardownUrl = new URL("./bounded-teardown.ts", import.meta.url).href;
const fixtureUrl = new URL("../fixtures/workspace-relay-engine.mjs", import.meta.url).href;

async function engineWrapper(mode, partialOutput) {
  const path = join(root, `${randomUUID()}.mjs`);
  await writeFile(
    path,
    `#!${process.execPath}\nimport { relayEngine } from ${JSON.stringify(fixtureUrl)};\nrelayEngine(${JSON.stringify({ engine: containerEngine, mode, partialOutput })});\n`,
    { mode: 0o700 },
  );
  return path;
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
    const { stdout } = await executeFile(
      containerEngine,
      ["ps", "-aq", "--filter", `name=^/${relayName}$`],
      commandOptions,
    );
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
    const program = `setTimeout(() => { require("node:fs").writeSync(2, ${JSON.stringify(`${"x".repeat(10000)}\n${secret}\nrelay startup diagnostic marker\n`)}); process.exit(23); }, 1500);`;
    await assert.rejects(
      relay(t, "node", ["-e", program], await engineWrapper("wait-for-exit")),
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
    const { stdout } = await executeFile(
      containerEngine,
      [
        "run",
        "-d",
        "--name",
        relayName,
        ...runArguments("node", [
          "-e",
          `require("node:fs").writeSync(2, ${JSON.stringify(unrelatedMarker)}); process.exit(26);`,
        ]),
      ],
      { ...commandOptions, timeout: 120_000 },
    );
    const originalId = stdout.trim();
    // Acquire an unrelated, already-exited container with readable logs. It has
    // the conflicting name but no label belonging to the helper invocation.
    try {
      await executeFile(containerEngine, ["wait", originalId], {
        ...commandOptions,
        timeout: 30_000,
      });
      const logged = await executeFile(containerEngine, ["logs", originalId], commandOptions);
      assert.match(`${logged.stdout}${logged.stderr}`, new RegExp(unrelatedMarker));
    } catch (error) {
      await executeFile(
        containerEngine,
        ["rm", "--force", "--volumes", originalId],
        commandOptions,
      );
      throw error;
    }
    const started = startWorkspaceGatewayRelayContainer(t, {
      containerEngine,
      relayName,
      runArguments: runArguments("node", ["-e", "process.exit(27)"]),
    });
    t.after(async () => {
      try {
        const inspected = await executeFile(
          containerEngine,
          ["inspect", "--format={{.Id}}", originalId],
          commandOptions,
        );
        assert.equal(
          inspected.stdout.trim(),
          originalId,
          "the conflicting container must survive helper teardown",
        );
      } finally {
        await executeFile(
          containerEngine,
          ["rm", "--force", "--volumes", originalId],
          commandOptions,
        );
      }
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
  // The child uses a real TestContext: its expected teardown failure must not
  // mark this parent failed. The parent owns final disposal even if assertions fail.
  t.after(() =>
    executeFile(containerEngine, ["rm", "--force", "--volumes", relayName], commandOptions),
  );
  const source = `import test from "node:test";
    import { startWorkspaceGatewayRelayContainer } from ${JSON.stringify(helperUrl)};
    import { boundedTeardown } from ${JSON.stringify(teardownUrl)};
    test("startup and cleanup failure", { timeout: 180000 }, async (t) => {
      await startWorkspaceGatewayRelayContainer(boundedTeardown(t).context, ${JSON.stringify({ containerEngine: wrapper, relayName, runArguments: runArguments("node", ["-e", "process.exit(28)"]) })});
    });`;
  await assert.rejects(
    executeFile(process.execPath, ["--input-type=module", "-e", source], {
      ...commandOptions,
      timeout: 190_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    }),
    (error) => {
      assert.equal(error.code, 1, "the child must fail its test, not time out");
      const output = `${error.stdout}\n${error.stderr}`;
      assert.match(output, /exit=28/);
      assert.match(output, /Host routing relay cleanup failed/);
      assert.match(output, /invalid-relay-cleanup-option/);
      return true;
    },
  );
  const retained = await executeFile(
    containerEngine,
    ["inspect", "--format={{.State.Status}}", relayName],
    commandOptions,
  );
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
