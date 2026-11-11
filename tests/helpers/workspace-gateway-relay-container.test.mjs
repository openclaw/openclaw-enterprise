import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { registerQaSecret } from "./qa-secrets.mjs";
import { startWorkspaceGatewayRelayContainer } from "./workspace-gateway-relay-container.mjs";

const executeFile = promisify(execFile);
const containerEngine = process.env.OCC_DOCKER_BIN ?? "docker";
const image = process.env.OCC_TEST_RUNTIME_IMAGE;
const options = { skip: !image && "OCC_TEST_RUNTIME_IMAGE is required", timeout: 30_000 };

function relay(t, entrypoint, args) {
  const relayName = `oce-relay-diagnostic-${randomUUID()}`;
  const started = startWorkspaceGatewayRelayContainer(t, {
    containerEngine,
    relayName,
    runArguments: ["--pull=never", "--network=none", "--entrypoint", entrypoint, image, ...args],
  });
  // The real TestContext runs the helper's teardown before this hook. Check
  // removal after both successful and failed starts, including stopped containers.
  t.after(async () => {
    const { stdout } = await executeFile(containerEngine, [
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
    // A real Node process exits before the readiness inspection. Its last stderr
    // lines must survive until the startup error is constructed, even with noise.
    const program = `
    console.error("x".repeat(10000));
    console.error(${JSON.stringify(secret)});
    console.error("relay startup diagnostic marker");
    process.exit(23);
  `;
    await assert.rejects(relay(t, "node", ["-e", program]), (error) => {
      assert.match(error.message, /not observed running/);
      assert.match(error.message, /status=exited running=false exit=23/);
      assert.match(error.message, /relay startup diagnostic marker/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.ok(error.message.length < 8000, "startup diagnostics must stay bounded");
      return true;
    });
  },
);

test("relay startup omits container output cut at the capture limit", options, async (t) => {
  const secret = randomUUID();
  registerQaSecret(secret);
  // The byte limit bisects a registered value. Publishing that partial buffer
  // would bypass exact-value redaction, so retain exit state without the output.
  const program = `
    require("node:fs").writeSync(2, "x".repeat(65520) + ${JSON.stringify(secret)} + "tail");
    process.exit(24);
  `;
  await assert.rejects(relay(t, "node", ["-e", program]), (error) => {
    assert.match(error.message, /status=exited running=false exit=24/);
    assert.match(error.message, /Output exceeded the 64 KiB capture limit/);
    assert.doesNotMatch(error.message, new RegExp(secret.slice(0, 16)));
    return true;
  });
});

test("relay startup preserves engine launch errors before cleanup", options, async (t) => {
  // The engine fails to launch this executable. This differs from a Node process
  // that starts and exits: the run command itself rejects, leaving a created container.
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
