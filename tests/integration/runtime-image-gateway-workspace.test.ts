import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { createContext, runInContext } from "node:vm";
import { readOpenclawSource } from "../../scripts/lib/openclaw-source.ts";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { resolveConfiguredHarnessId } from "../../packages/occ/src/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import type { OpenClawConfigurationDocument } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { codexGatewayModelConfiguration } from "../../apps/controller/src/drivers/compute/codex-model-configuration.ts";
import { OPENSHELL_CODEX_APP_SERVER_POLICY } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import type { WorkspaceNodeHotApplyReceipt } from "../fixtures/runtime-workspace-node-hot-apply.ts";
import { runDocker, commandOutput, waitForDockerLog } from "../helpers/runtime-image-docker.ts";
import { jsonLogEntries } from "../helpers/runtime-image-gateway-observations.ts";
import {
  imageTestOptions,
  createAdmittedRuntimeImageConfiguration,
  runGatewaySmoke,
  assertGatewayLogEntry,
} from "../helpers/runtime-image-startup.ts";

function requiredRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, "expected an object");
  return record;
}

function codexAppServer(configuration: OpenClawConfigurationDocument): Record<string, unknown> {
  const plugins = requiredRecord(configuration.plugins);
  const entries = requiredRecord(plugins.entries);
  const codex = requiredRecord(entries.codex);
  const config = requiredRecord(codex.config);
  return requiredRecord(config.appServer);
}

function lastOutputRecord(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").at(-1);
  assert.ok(line, "expected fixture output");
  return requiredRecord(JSON.parse(line));
}

async function workspaceConfigWriteFixture(t: TestContext) {
  const state = await temporaryDirectory(t, "oce-workspace-node-config-");
  const target = join(state, "openclaw.json");
  const staged = target + ".workspace-node-" + process.pid;
  const input = join(state, "initial.json");
  await writeFile(input, "{}");
  const env = { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: input };
  const require = createRequire(import.meta.url);
  const beforeRuntimeSetup = new Error("Stop before Gateway runtime directory setup");
  // Load the emitted program with no Kubernetes termination log, then stop before
  // it sets up runtime directories or starts OpenClaw. The writer uses the real filesystem.
  const context = createContext({
    require(specifier: string) {
      if (specifier === "node:fs") {
        return {
          ...fs,
          existsSync: () => false,
          mkdirSync() {
            throw beforeRuntimeSetup;
          },
        };
      }
      return require(specifier);
    },
    process: { env, pid: process.pid },
  });
  assert.throws(
    () => runInContext(KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT, context),
    (error) => error === beforeRuntimeSetup,
  );
  const replace = () => runInContext('replaceOpenClawConfig({ workspace: "test" });', context);
  return { state, target, staged, input, env, replace };
}

// The emitted Kubernetes runtime uses POSIX paths, file modes, and rename semantics.
describe(
  "Kubernetes Gateway workspace config writes",
  { skip: process.platform === "win32" },
  () => {
    test("Kubernetes Gateway selects the replacement workspace config after a successful rename", async (t) => {
      const { state, target, env, replace } = await workspaceConfigWriteFixture(t);
      await writeFile(target, "{}");
      replace();
      assert.equal(await readFile(target, "utf8"), '{"workspace":"test"}');
      assert.equal((await stat(target)).mode & 0o777, 0o600);
      assert.deepEqual((await readdir(state)).sort(), ["initial.json", "openclaw.json"]);
      assert.equal(env.OPENCLAW_CONFIG_PATH, target);
    });

    test("Kubernetes Gateway removes its staged workspace config after a failed rename", async (t) => {
      const { state, target, staged, input, env, replace } = await workspaceConfigWriteFixture(t);
      // A directory at the target path refuses replacement after the staging write succeeds.
      await mkdir(target);
      const sentinel = join(target, "sentinel");
      await writeFile(sentinel, "keep");
      assert.throws(replace, {
        code: "EISDIR",
        syscall: "rename",
        path: staged,
        dest: target,
      });
      assert.deepEqual((await readdir(state)).sort(), ["initial.json", "openclaw.json"]);
      assert.equal(await readFile(sentinel, "utf8"), "keep");
      assert.equal(env.OPENCLAW_CONFIG_PATH, input);
    });

    test("Kubernetes Gateway preserves an existing stage when workspace config open fails", async (t) => {
      const { state, target, staged, input, env, replace } = await workspaceConfigWriteFixture(t);
      // Probe the process's write permissions on a separate file so the writer owns the stage open.
      const control = join(state, "read-only-control");
      await writeFile(control, "", { mode: 0o400 });
      const writableControl = await open(control, "r+").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EACCES") {
          throw error;
        }
      });
      if (writableControl) {
        await writableControl.close();
        t.skip("This process can open a read-only file for writing");
        return;
      }
      await writeFile(target, "{}");
      // The parent is writable, so an unlink would delete the read-only stage despite open failing.
      await writeFile(staged, "keep", { mode: 0o400 });
      assert.throws(replace, { code: "EACCES", syscall: "open", path: staged });
      assert.equal(await readFile(staged, "utf8"), "keep");
      assert.equal(await readFile(target, "utf8"), "{}");
      assert.equal(env.OPENCLAW_CONFIG_PATH, input);
    });
  },
);

// Codex Gateway cases on the real runtime image, split from
// runtime-image-startup.test.ts by measured case durations so CI runs them
// beside it: the Gateway hot-loads its workspace node binding in place,
// custom-provider subagents keep their native model IDs in the remote workspace,
// and a write-scoped run's native command approval reaches the reviewer.

// Each case starts its own Gateway container (random name, no network) and owns its
// fixtures, so the three run at once, beside the lane's other files.
describe("runtime image Gateway workspace", { concurrency: 3 }, () => {
  test(
    "runtime image Gateway hot-loads its workspace node binding without restarting OpenClaw",
    imageTestOptions,
    async (t) => {
      // The Gateway starts before its node pairs, as on a first dedicated deploy:
      // the binding volume is empty and file-transfer is not allowed yet.
      const gatewayWorkspace = "/home/node/gateway-workspace";
      const admitted = createAdmittedRuntimeImageConfiguration("codex");
      const agents = requiredRecord(admitted.agents);
      const models = requiredRecord(admitted.models);
      const providers = requiredRecord(models.providers);
      const configuration = {
        ...admitted,
        agents: {
          ...agents,
          defaults: { ...requiredRecord(agents.defaults), workspace: gatewayWorkspace },
        },
        models,
      };
      // An owner's codex row with a reachable transport and request overrides, which
      // would let OpenClaw's built-in runtime reach a model from the Gateway.
      const codexProvider = requiredRecord(providers.codex);
      configuration.models = {
        ...configuration.models,
        providers: {
          ...providers,
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
      const source = stripTypeScriptTypes(
        await readFile(
          new URL("../fixtures/runtime-workspace-node-hot-apply.ts", import.meta.url),
          "utf8",
        ),
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
      const line = stdout.trim().split("\n").at(-1);
      assert.ok(line, "expected workspace node receipt");
      const result = JSON.parse(line) as WorkspaceNodeHotApplyReceipt;
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
      // OpenClaw publishes the replaced plugin before it logs the finished reload.
      await waitForDockerLog(
        containerName,
        /config hot reload applied \([^)\n]*plugins\.entries\.file-transfer/,
      );
      const logs = await runDocker(["logs", containerName]);
      const entries: readonly unknown[] = jsonLogEntries(`${logs.stdout}\n${logs.stderr}`);
      assertGatewayLogEntry(
        entries,
        (value: unknown) => {
          const entry = asRecord(value);
          return (
            entry?.event === "runtime.startup_phase" &&
            entry.phase === "workspace-node" &&
            entry.outcome === "ok"
          );
        },
        "the wrapper's workspace-node ack",
      );
      // OpenClaw applied the plugins.* change in place (and replaced the Codex
      // plugin runtime with it); nothing restarted the Gateway.
      assertGatewayLogEntry(
        entries,
        (value: unknown) => {
          const entry = asRecord(value);
          return (
            entry?.subsystem === "gateway/reload" &&
            typeof entry.message === "string" &&
            /^config hot reload applied \(.*plugins\.entries\.file-transfer/.test(entry.message)
          );
        },
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
      const ref = (name: keyof typeof nativeIds) => `codex/${nativeIds[name]}`;
      const base = createHarnessConfiguration("codex", nativeIds.parent);
      const entries = {
        main: {},
        string: { subagents: { model: ref("string") } },
        object: { subagents: { model: { primary: ref("object"), fallbacks: [ref("fallback")] } } },
        alias: { subagents: { model: "codex" } },
      };
      const source = {
        ...base,
        agents: {
          ...base.agents,
          ownership: "explicit",
          defaults: {
            ...base.agents.defaults,
            systemAgent: { agentId: "main" },
            models: Object.fromEntries(
              Object.entries(nativeIds).map(([name, id]) => [
                `codex/${id}`,
                {
                  agentRuntime: { id: "codex" },
                  ...(name === "parent" ? { alias: "codex" } : {}),
                },
              ]),
            ),
            subagents: { model: ref("main") },
          },
          entries: Object.fromEntries(
            Object.entries(entries).map(([id, entry]) => [
              id,
              { ...entry, workspace: `/home/node/workspace/${id}` },
            ]),
          ),
        },
        gateway: { ...base.gateway, tools: { allow: ["sessions_spawn"] } },
        tools: { codeMode: false, toolSearch: false, allow: ["sessions_spawn"] },
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
      codexAppServer(configuration).remoteWorkspaceRoot = remoteWorkspaceRoot;

      // Keep the real packaged Gateway and Codex plugin; replace only the native peer
      // at its authenticated WebSocket boundary. The network-none container cannot
      // call a provider, and the peer deliberately refuses before any model turn.
      const { containerName } = await runGatewaySmoke(t, "codex", {
        configuration,
        waitUntilReady: false,
        extraEnvironment: ["APP_SERVER_URL=ws://127.0.0.1:4500", "OPENCLAW_DEBUG=1"],
      });
      const fixture = stripTypeScriptTypes(
        await readFile(
          new URL("../fixtures/runtime-codex-subagent-model.ts", import.meta.url),
          "utf8",
        ),
      );
      const { commit } = await readOpenclawSource();
      const cases = (["main", "string", "object", "alias"] as const).map((agentId) => ({
        agentId,
        model: nativeIds[agentId === "alias" ? "parent" : agentId],
        cwd: remoteWorkspaceRoot,
      }));
      let stdout: string;
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
        const logs = await runDocker(["logs", containerName]).catch(
          (cause: unknown) => asRecord(cause) ?? {},
        );
        t.diagnostic(commandOutput(logs));
        throw error;
      }
      const result = lastOutputRecord(stdout);
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.commit, commit);
      assert.ok(Array.isArray(result.observed));
      const observed = result.observed.map(requiredRecord);
      assert.deepEqual(
        observed.map(({ agentId, modelProvider, model, cwd }) => ({
          agentId,
          modelProvider,
          model,
          cwd,
        })),
        cases.map((scenario) => ({ ...scenario, modelProvider: "openai-compatible" })),
      );
      assert.ok(
        observed.every(
          ({ childSessionKey }) =>
            typeof childSessionKey === "string" && childSessionKey.includes(":subagent:"),
        ),
      );
    },
  );

  test(
    "runtime image delivers a write-scoped run's Codex command approval to the reviewer and returns the verdict",
    imageTestOptions,
    async (t) => {
      // A dedicated Codex Agent's app-server policy: the OpenShell full-access profile with
      // human review by the user reviewer, asking before escalated commands.
      const configuration = codexGatewayModelConfiguration(
        admitLoggingConfiguration(createHarnessConfiguration("codex", "gpt-5.6-luna"), "info"),
        { baseUrl: "https://models.example.test/v1", modelProvider: "openai-compatible" },
      );
      Object.assign(codexAppServer(configuration), {
        ...OPENSHELL_CODEX_APP_SERVER_POLICY,
        approvalPolicy: "on-request",
        remoteWorkspaceRoot: "/sandbox/enterprise",
      });
      const { containerName } = await runGatewaySmoke(t, "codex", {
        configuration,
        waitUntilReady: false,
        extraEnvironment: ["APP_SERVER_URL=ws://127.0.0.1:4500"],
      });
      const fixture = stripTypeScriptTypes(
        await readFile(
          new URL("../fixtures/runtime-codex-command-approval.ts", import.meta.url),
          "utf8",
        ),
      );
      const { commit } = await readOpenclawSource();
      // A single command without shell separators: the approval bridge can bind it, so it
      // must reach a reviewer (compound bash -c payloads are refused before review).
      const command = "/bin/bash -c 'touch /etc/oce-approval-probe'";
      let stdout: string;
      try {
        ({ stdout } = await runDocker(
          [
            "exec",
            "-e",
            `OCC_TEST_APPROVAL_COMMAND=${command}`,
            "-e",
            `OCC_TEST_OPENCLAW_COMMIT=${commit}`,
            containerName,
            "node",
            "--input-type=module",
            "-e",
            fixture,
          ],
          { timeout: 240_000 * imageSmokeTimeoutMultiplier },
        ));
      } catch (error) {
        const logs = await runDocker(["logs", containerName]).catch(
          (cause: unknown) => asRecord(cause) ?? {},
        );
        t.diagnostic(commandOutput(logs));
        throw error;
      }
      const result = lastOutputRecord(stdout);
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.commit, commit);
      // The Gateway asks Codex for full access with the user reviewer, so Codex sends the
      // escalation to the Gateway's human reviewer. OpenClaw cannot use a model-backed reviewer
      // (auto_review, guardian_subagent) for this model: it would force the user reviewer with a
      // workspace-write sandbox, whose nested namespaces OpenShell blocks.
      assert.deepEqual(result.nativePolicies, [
        { method: "thread/start", reviewer: "user", access: "danger-full-access" },
        { method: "turn/start", reviewer: "user", access: "dangerFullAccess" },
      ]);
      // The reviewer saw the exact command and allowed it once, and Codex got that verdict.
      // Before the fix, the write-scoped run's wait failed with "missing scope:
      // operator.approvals", so the peer got "decline" even after the reviewer allowed it.
      assert.ok(Array.isArray(result.events));
      const events = result.events.map(requiredRecord);
      assert.deepEqual(
        events.map(({ event, pluginId, decision }) => ({ event, pluginId, decision })),
        [
          { event: "plugin.approval.requested", pluginId: "codex", decision: undefined },
          { event: "plugin.approval.resolved", pluginId: "codex", decision: "allow-once" },
        ],
      );
      const description = events[0]?.description;
      assert.ok(typeof description === "string");
      assert.match(description, /touch \/etc\/oce-approval-probe/u);
      assert.deepEqual(result.peerAnswer, { decision: "accept" });
      assert.equal(result.runStatus, "ok");
    },
  );
});
