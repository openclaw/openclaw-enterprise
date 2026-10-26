import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { resolveConfiguredHarnessId } from "../../packages/occ/src/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { codexGatewayModelConfiguration } from "../../apps/controller/src/drivers/compute/codex-model-configuration.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  imageTestOptions,
  runDocker,
  commandOutput,
  createAdmittedRuntimeImageConfiguration,
  jsonLogEntries,
  runGatewaySmoke,
  assertGatewayLogEntry,
} from "../helpers/runtime-image-startup.mjs";

// Codex Gateway cases on the real runtime image, split from
// runtime-image-startup.test.mjs by measured case durations so CI runs them
// beside it: the Gateway hot-loads its workspace node binding in place, and
// custom-provider subagents keep their native model IDs in the remote workspace.

test(
  "runtime image Gateway hot-loads its workspace node binding without restarting OpenClaw",
  imageTestOptions,
  async (t) => {
    // The Gateway starts before its node pairs, as on a first dedicated deploy:
    // the binding volume is empty and file-transfer is not allowed yet.
    const gatewayWorkspace = "/home/node/gateway-workspace";
    const admitted = createAdmittedRuntimeImageConfiguration("codex");
    const configuration = {
      ...admitted,
      agents: {
        ...admitted.agents,
        defaults: { ...admitted.agents?.defaults, workspace: gatewayWorkspace },
      },
    };
    // An owner's codex row with a reachable transport and request overrides, which
    // would let OpenClaw's built-in runtime reach a model from the Gateway.
    const codexProvider = configuration.models.providers.codex;
    configuration.models = {
      ...configuration.models,
      providers: {
        ...configuration.models.providers,
        codex: {
          ...codexProvider,
          baseUrl: "https://model.example.test/v1",
          headers: { "x-route": "owner" },
          request: { allowPrivateNetwork: true },
        },
        // Codex's other provider, with an owner transport of its own.
        openai: {
          baseUrl: "https://model.example.test/v1",
          headers: { "x-route": "owner" },
          models: codexProvider.models,
        },
      },
    };
    const directory = await temporaryDirectory(t, "oce-runtime-image-config-");
    const configurationPath = join(directory, "openclaw.json");
    await writeFile(configurationPath, JSON.stringify(configuration));
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
      extraEnvironment: [
        "OPENCLAW_WORKSPACE_NODE_PATH=/home/node/workspace-node-binding/workspace-node.json",
        "OPENCLAW_AGENT_REVISION_ID=revision-workspace-node",
        "OPENCLAW_RUNTIME_STATUS_PORT=18791",
        "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
        "OPENCLAW_POD_UID=pod-workspace-node",
      ],
    });
    const source = await readFile(
      new URL("../fixtures/runtime-workspace-node-hot-apply.mjs", import.meta.url),
      "utf8",
    );
    const { stdout } = await runDocker(
      [
        "exec",
        "-e",
        `OCC_TEST_GATEWAY_WORKSPACE=${gatewayWorkspace}`,
        containerName,
        "node",
        "--input-type=module",
        "-e",
        source,
      ],
      { timeout: 300_000 * imageSmokeTimeoutMultiplier },
    );
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(result.sameProcesses, true);
    assert.equal(result.fileTransferAfter.state, "active");
    assert.equal(result.readBefore, "served by the Gateway host");
    assert.equal(result.readAfter, "served by the workspace node");
    const inspect = await runDocker([
      "inspect",
      containerName,
      "--format",
      "{{.State.Running}} {{.RestartCount}}",
    ]);
    assert.equal(inspect.stdout.trim(), "true 0");
    const logs = await runDocker(["logs", containerName]);
    const entries = jsonLogEntries(`${logs.stdout}\n${logs.stderr}`);
    assertGatewayLogEntry(
      entries,
      (entry) =>
        entry.event === "runtime.startup_phase" &&
        entry.phase === "workspace-node" &&
        entry.outcome === "ok",
      "the wrapper's workspace-node ack",
    );
    // OpenClaw applied the plugins.* change in place (and replaced the Codex
    // plugin runtime with it); nothing restarted the Gateway.
    assertGatewayLogEntry(
      entries,
      (entry) =>
        entry.subsystem === "gateway/reload" &&
        /^config hot reload applied \(.*plugins\.entries\.file-transfer/.test(entry.message),
      "OpenClaw's hot reload of file-transfer",
    );
    const output = `${logs.stdout}\n${logs.stderr}`;
    assert.doesNotMatch(output, /config reload failed|config restart|workspace-node-changed/);
    // The Gateway's own workspace is empty, so Codex gets no OpenClaw tool that would
    // act on it, run commands or terminals in the Gateway, or change its configuration,
    // automation triggers cannot run commands there, and a built-in runtime run has no
    // reachable model; the pinned OpenClaw accepts it.
    const effective = await runDocker([
      "exec",
      containerName,
      "node",
      "-e",
      `const fs = require("node:fs");
const cp = require("node:child_process");
// The wrapper writes the effective configuration it starts OpenClaw with here.
const path = "/home/node/.openclaw/openclaw.json";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
const validation = cp.spawnSync("node", ["/app/openclaw.mjs", "config", "validate", "--json"], {
  env: { ...process.env, OPENCLAW_CONFIG_PATH: path }, encoding: "utf8", timeout: 60000,
});
process.stdout.write(JSON.stringify({
  excluded: config.plugins.entries.codex.config.codexDynamicToolsExclude,
  triggers: config.cron.triggers,
  memoryFlush: config.agents.defaults.compaction.memoryFlush,
  codexProvider: config.models.providers.codex,
  openaiProvider: config.models.providers.openai,
  valid: JSON.parse(validation.stdout).valid,
}));`,
    ]);
    assert.deepEqual(JSON.parse(effective.stdout), {
      excluded: [
        "ls",
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "gateway_exec",
        "gateway_process",
        "terminal",
        "portal",
        "openclaw",
        "plugins",
        "gateway",
      ],
      triggers: { enabled: false },
      memoryFlush: { enabled: false },
      codexProvider: {
        models: codexProvider.models,
        baseUrl: "http://127.0.0.1:9",
        api: "openai-responses",
      },
      openaiProvider: {
        models: codexProvider.models,
        baseUrl: "http://127.0.0.1:9",
        api: "openai-responses",
      },
      valid: true,
    });
    t.diagnostic(`workspace node ack after ${result.ackMs} ms: ${JSON.stringify(result)}`);
  },
);

test(
  "runtime image spawns custom-provider subagents with intact native model IDs in the remote workspace",
  imageTestOptions,
  async (t) => {
    const nativeIds = {
      parent: "vendor/organization/parent",
      main: "vendor/organization/default-child",
      string: "vendor/organization/string-child",
      object: "vendor/organization/object-child",
      fallback: "codex/child-fallback",
    };
    const ref = (name) => `codex/${nativeIds[name]}`;
    const source = createHarnessConfiguration("codex", nativeIds.parent);
    source.agents.ownership = "explicit";
    source.agents.defaults.systemAgent = { agentId: "main" };
    source.agents.defaults.models = Object.fromEntries(
      Object.keys(nativeIds).map((name) => [
        ref(name),
        {
          agentRuntime: { id: "codex" },
          ...(name === "parent" ? { alias: "codex" } : {}),
        },
      ]),
    );
    source.agents.defaults.subagents = { model: ref("main") };
    source.agents.entries = {
      main: {},
      string: { subagents: { model: ref("string") } },
      object: { subagents: { model: { primary: ref("object"), fallbacks: [ref("fallback")] } } },
      alias: { subagents: { model: "codex" } },
    };
    for (const [id, entry] of Object.entries(source.agents.entries)) {
      entry.workspace = `/home/node/workspace/${id}`;
    }
    source.gateway.tools = { allow: ["sessions_spawn"] };
    source.tools = {
      codeMode: false,
      toolSearch: false,
      allow: ["sessions_spawn"],
    };
    const admitted = admitLoggingConfiguration(source, "info");
    assert.equal(resolveConfiguredHarnessId(admitted), "codex");
    const before = structuredClone(admitted);
    const configuration = codexGatewayModelConfiguration(admitted, {
      baseUrl: "https://models.example.test/v1",
      modelProvider: "openai-compatible",
    });
    assert.deepEqual(admitted, before);
    // The Gateway prepares each Agent's writable local workspace, then the
    // plugin maps its native cwd to the provider-owned Harness filesystem.
    const remoteWorkspaceRoot = "/sandbox/enterprise";
    configuration.plugins.entries.codex.config.appServer.remoteWorkspaceRoot = remoteWorkspaceRoot;

    // Keep the real packaged Gateway and Codex plugin; replace only the native peer
    // at its authenticated WebSocket boundary. The network-none container cannot
    // call a provider, and the peer deliberately refuses before any model turn.
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configuration,
      collectPlugins: false,
      waitUntilReady: false,
      extraEnvironment: ["APP_SERVER_URL=ws://127.0.0.1:4500", "OPENCLAW_DEBUG=1"],
    });
    const fixture = await readFile(
      new URL("../fixtures/runtime-codex-subagent-model.mjs", import.meta.url),
      "utf8",
    );
    const dockerfile = await readFile(
      new URL("../../deploy/runtime/Dockerfile", import.meta.url),
      "utf8",
    );
    const commit = dockerfile.match(/^ARG OPENCLAW_COMMIT=([0-9a-f]{40})$/m)?.[1];
    assert.ok(commit, "The image source pin must be explicit.");
    const cases = ["main", "string", "object", "alias"].map((agentId) => ({
      agentId,
      model: nativeIds[agentId === "alias" ? "parent" : agentId],
      cwd: remoteWorkspaceRoot,
    }));
    let stdout;
    try {
      ({ stdout } = await runDocker(
        [
          "exec",
          "-e",
          `OCC_TEST_SUBAGENT_CASES=${JSON.stringify(cases)}`,
          "-e",
          `OCC_TEST_SUBAGENT_MODELS=${JSON.stringify(Object.values(nativeIds))}`,
          "-e",
          `OCC_TEST_OPENCLAW_COMMIT=${commit}`,
          containerName,
          "node",
          "--input-type=module",
          "-e",
          fixture,
        ],
        { timeout: 480_000 * imageSmokeTimeoutMultiplier },
      ));
    } catch (error) {
      const logs = await runDocker(["logs", containerName]).catch((cause) => cause);
      t.diagnostic(commandOutput(logs));
      throw error;
    }
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.commit, commit);
    assert.deepEqual(
      result.observed.map(({ agentId, modelProvider, model, cwd }) => ({
        agentId,
        modelProvider,
        model,
        cwd,
      })),
      cases.map((scenario) => ({ ...scenario, modelProvider: "openai-compatible" })),
    );
    assert.ok(
      result.observed.every(({ childSessionKey }) => childSessionKey.includes(":subagent:")),
    );
  },
);
