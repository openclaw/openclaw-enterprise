import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import {
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  imageTestOptions,
  runDocker,
  commandOutput,
  createAdmittedRuntimeImageConfiguration,
  jsonLogEntries,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

// The dedicated Gateway's Harness peer scenarios on the real runtime image: an
// in-place OpenClaw respawn for a changed peer, and an exit when OpenClaw crashes
// during a peer status outage or a replacement peer changes. Split from
// runtime-image-startup.test.mjs by measured case durations.

test(
  "runtime image Gateway respawns OpenClaw in place when its Harness peer changes",
  imageTestOptions,
  async (t) => {
    // A dedicated Codex Gateway with a plugin selection follows its Harness
    // peer status and holds a workspace node binding, as after a first deploy.
    const workspaceNodeId = randomBytes(32).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "oce-runtime-image-config-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const configurationPath = join(directory, "openclaw.json");
    await writeFile(
      configurationPath,
      JSON.stringify(createAdmittedRuntimeImageConfiguration("codex")),
    );
    const bindingPath = join(directory, "workspace-node.json");
    await writeFile(
      bindingPath,
      JSON.stringify({ revisionId: "revision-peer-respawn", deviceId: workspaceNodeId }),
    );
    const manifest = {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
        },
      },
    };
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [
        `${configurationPath}:/etc/openclaw/openclaw.json:ro`,
        `${bindingPath}:/etc/openclaw-workspace-node/workspace-node.json:ro`,
      ],
      extraEnvironment: [
        // This isolated fixture uses synthetic credentials; retain startup causes.
        "OPENCLAW_DEBUG=1",
        "APP_SERVER_URL=ws://[::1]:4500",
        `OPENCLAW_PLUGIN_RUNTIME_JSON=${JSON.stringify({ manifest })}`,
        "OPENCLAW_PLUGIN_STATUS_CONTAINER=gateway",
        "OPENCLAW_PLUGIN_STATUS_PORT=18791",
        "OPENCLAW_RUNTIME_STATUS_PORT=18791",
        "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
        "OPENCLAW_WORKSPACE_NODE_PATH=/etc/openclaw-workspace-node/workspace-node.json",
        "OPENCLAW_AGENT_REVISION_ID=revision-peer-respawn",
        "OPENCLAW_POD_UID=pod-peer-respawn",
        "OPENCLAW_WORKSPACE_DIR=/home/node/workspace",
      ],
      // The wrapper waits for the Harness status, which the fixture serves.
      waitUntilReady: false,
    });
    const fixture = await readFile(
      new URL("../fixtures/runtime-gateway-peer-respawn.mjs", import.meta.url),
      "utf8",
    );
    let stdout;
    try {
      ({ stdout } = await runDocker(
        [
          "exec",
          "-e",
          `OCC_TEST_WORKSPACE_NODE_ID=${workspaceNodeId}`,
          "-e",
          `OCC_TEST_TOKEN_DOMAIN=${PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN}`,
          containerName,
          "node",
          "--input-type=module",
          "-e",
          fixture,
        ],
        { timeout: 780_000 * imageSmokeTimeoutMultiplier },
      ));
    } catch (error) {
      const logs = await runDocker(["logs", containerName]).catch((logsError) => logsError);
      // CI truncates error messages; preserve complete container logs separately.
      t.diagnostic(commandOutput(logs));
      const runtimeErrors = jsonLogEntries(commandOutput(logs))
        .filter((entry) => entry.level === "error")
        .map((entry) => entry.message)
        .join("\n");
      throw new Error(
        `Peer respawn fixture failed (code=${error.code}, signal=${error.signal}): ${runtimeErrors || commandOutput(error).trim() || "no fixture output"}`,
        { cause: error },
      );
    }
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.ok(result.samePeerOutageResponses >= 2);
    assert.ok(result.samePeerUnreadySamples >= 2);
    assert.ok(result.samePeerRecoveryResponses >= 1);
    assert.notDeepEqual(result.after, result.before);
    // The container, and the wrapper that is its main process, never restarted.
    const inspect = await runDocker([
      "inspect",
      containerName,
      "--format",
      "{{.State.Running}} {{.RestartCount}}",
    ]);
    assert.equal(inspect.stdout.trim(), "true 0");
    const logs = await runDocker(["logs", containerName]);
    const entries = jsonLogEntries(`${logs.stdout}\n${logs.stderr}`);
    const phases = entries
      .filter((entry) => entry.event === "runtime.startup_phase")
      .map((entry) => `${entry.phase}:${entry.outcome}`);
    assert.equal(phases.filter((phase) => phase === "native-spawn:ok").length, 1);
    assert.equal(phases.filter((phase) => phase === "runtime-assets:ok").length, 1);
    assert.ok(phases.includes("peer-status-changed:ok"), phases.join(", "));
    const respawn = entries.find(
      (entry) => entry.event === "runtime.startup_phase" && entry.phase === "gateway-respawn",
    );
    assert.equal(respawn?.outcome, "ok", phases.join(", "));
    const timeline = entries
      .filter((entry) => entry.event === "runtime.startup_phase")
      .map((entry) => `${entry.phase} ${entry.ms}/${entry.sinceStartMs} ms`);
    t.diagnostic(`in-place Gateway respawn took ${respawn.ms} ms: ${JSON.stringify(result)}`);
    t.diagnostic(`wrapper phases (duration/since start): ${timeline.join(", ")}`);
  },
);

async function assertGatewayExitsDuringPeerScenario(t, scenario, expectedPhase) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-image-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configurationPath = join(directory, "openclaw.json");
  await writeFile(
    configurationPath,
    JSON.stringify(createAdmittedRuntimeImageConfiguration("codex")),
  );
  const manifest = {
    kind: "codex",
    selections: {
      "codex-plugin:linear@openai-curated-remote": {
        enabled: true,
        toolDefaults: { approval: "provider_default" },
      },
    },
  };
  const { containerName } = await runGatewaySmoke(t, "codex", {
    configurationPath: "/etc/openclaw/openclaw.json",
    entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
    volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    extraEnvironment: [
      "APP_SERVER_URL=ws://[::1]:4500",
      `OPENCLAW_PLUGIN_RUNTIME_JSON=${JSON.stringify({ manifest })}`,
      "OPENCLAW_PLUGIN_STATUS_CONTAINER=gateway",
      "OPENCLAW_PLUGIN_STATUS_PORT=18791",
      "OPENCLAW_AGENT_REVISION_ID=revision-peer-respawn",
      "OPENCLAW_POD_UID=pod-peer-respawn",
      "OPENCLAW_WORKSPACE_DIR=/home/node/workspace",
      // The stale-replacement fixture answers its verification read only after
      // checking the replacement (an HTTP readiness request and two local reads), so
      // the wrapper's peer read must outlast that work on a slow runner.
      `OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS=${30_000 * imageSmokeTimeoutMultiplier}`,
    ],
    waitUntilReady: false,
  });
  const fixture = await readFile(
    new URL("../fixtures/runtime-gateway-peer-respawn.mjs", import.meta.url),
    "utf8",
  );
  let failure;
  try {
    await runDocker(
      [
        "exec",
        "-e",
        `OCC_TEST_GATEWAY_SCENARIO=${scenario}`,
        "-e",
        `OCC_TEST_TOKEN_DOMAIN=${PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN}`,
        containerName,
        "node",
        "--input-type=module",
        "-e",
        fixture,
      ],
      { timeout: 300_000 * imageSmokeTimeoutMultiplier },
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `the container should exit for ${scenario}`);
  if (!(failure.stdout ?? "").includes(`"phase":"${expectedPhase}"`)) {
    const logs = await runDocker(["logs", containerName]).catch((error) => error);
    assert.fail(
      `Expected ${expectedPhase} was not observed.\n${commandOutput(failure)}\n${commandOutput(logs)}`,
    );
  }
  // The fixture fails on its own only when the wrapper outlives its deadline;
  // otherwise it dies with the container.
  assert.doesNotMatch(
    commandOutput(failure),
    /remained running after its child exited|did not reject the stale replacement peer/,
  );
  // Its `docker exec` can return before Docker has recorded the container's own
  // exit, so wait for that record (bounded) before inspecting the state.
  const exited = await runDocker(["wait", containerName], {
    timeout: 30_000 * imageSmokeTimeoutMultiplier,
  }).catch(async (error) => {
    const logs = await runDocker(["logs", containerName]).catch((logsError) => logsError);
    assert.fail(`The Gateway container did not exit.\n${error.message}\n${commandOutput(logs)}`);
  });
  assert.equal(exited.stdout.trim(), "1");
  const inspect = await runDocker(["inspect", containerName, "--format", "{{json .State}}"]);
  const state = JSON.parse(inspect.stdout);
  assert.equal(state.Status, "exited");
  assert.equal(state.ExitCode, 1);
  if (scenario === "stale-replacement") {
    const logs = await runDocker(["logs", containerName]);
    const entries = jsonLogEntries(`${logs.stdout}\n${logs.stderr}`);
    assert.ok(
      entries.some(
        (entry) =>
          entry.event === "runtime.startup_phase" &&
          entry.phase === "peer-verification-changed" &&
          entry.outcome === "failed",
      ),
      "the Gateway must reject the changed peer, not merely fail its status request",
    );
  }
}

test(
  "runtime image Gateway exits if OpenClaw crashes during a peer status outage",
  imageTestOptions,
  async (t) => {
    await assertGatewayExitsDuringPeerScenario(t, "peer-outage-exit", "peer-unready");
  },
);

test(
  "runtime image Gateway rejects a peer changed during replacement startup",
  imageTestOptions,
  async (t) => {
    await assertGatewayExitsDuringPeerScenario(t, "stale-replacement", "stale-peer-verified");
  },
);
