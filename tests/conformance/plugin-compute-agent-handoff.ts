import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  nodeRequire,
  pluginAppServerToken,
  runGeneratedProgram,
  sha256,
  text,
} from "./plugin-compute-fixtures.ts";
import { type StatusHandler, readStatusFromHandler } from "./plugin-compute-status.ts";

export function registerAgentHandoff(): void {
  test("Codex agent app-server uses a per-startup plugin status token", () => {
    const directory = mkdtempSync(join(tmpdir(), "oce-plugin-token-"));
    const marker = join(directory, "ready");
    const baseToken = "capability-token-test-value";
    const revisionId = "revision-plugin-compute-1";
    let statusHandler: StatusHandler | undefined;
    let appServerSpawn:
      { command: string; args: string[]; options: { env?: NodeJS.ProcessEnv } } | undefined;
    const files = new Map<string, string>();
    try {
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        APP_SERVER_PORT: "4321",
        APP_SERVER_TOKEN: baseToken,
        CODEX_HOME: join(directory, "codex-home"),
        CODEX_LOGIN_MODE: "api_key",
        OPENAI_API_KEY: "fixture-api-key",
        OPENCLAW_HARNESS_MODEL: "openai/gpt-5",
        OPENCLAW_AGENT_REVISION_ID: revisionId,
        OPENCLAW_PLUGIN_STATUS_CONTAINER: "agent",
        OPENCLAW_PLUGIN_STATUS_PORT: "18791",
        OPENCLAW_POD_UID: "pod-agent-token-1",
        OPENCLAW_PLUGIN_READY_MARKER: marker,
      };
      const sandbox = {
        AbortSignal,
        Buffer,
        JSON,
        URL,
        console: { error() {} },
        process: {
          env: environment,
          on() {},
          exit(code: number) {
            throw new Error(`unexpected process exit ${code}`);
          },
        },
        setTimeout() {
          return { unref() {} };
        },
        clearTimeout() {},
        require(specifier: string) {
          if (specifier === "node:http") {
            return {
              createServer(handler: StatusHandler) {
                statusHandler = handler;
                return { listen() {} };
              },
            };
          }
          if (specifier === "node:fs") {
            return {
              existsSync(path: string) {
                return files.has(path);
              },
              mkdirSync() {},
              mkdtempSync,
              readFileSync(path: string) {
                if (!files.has(path)) {
                  throw new Error(`Missing mocked file: ${path}`);
                }
                return files.get(path);
              },
              rmSync(path: string) {
                files.delete(path);
              },
              writeFileSync(path: string, data: unknown) {
                files.set(path, String(data));
              },
            };
          }
          if (specifier === "node:child_process") {
            let nativeCalls = 0;
            return {
              spawnSync() {
                nativeCalls += 1;
                return nativeCalls === 1
                  ? { status: 0 }
                  : {
                      status: 0,
                      stdout: [
                        { type: "thread.started" },
                        { type: "turn.started" },
                        {
                          type: "item.completed",
                          item: { type: "agent_message", text: "READY" },
                        },
                        { type: "turn.completed" },
                      ]
                        .map((event) => JSON.stringify(event))
                        .join("\n"),
                    };
              },
              spawn(command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) {
                appServerSpawn = { command, args, options };
                return { on() {}, kill() {} };
              },
            };
          }
          return nodeRequire(specifier);
        },
      };

      runGeneratedProgram(AGENT_RUNTIME_ENTRYPOINT, sandbox);

      assert.ok(statusHandler);
      assert.ok(appServerSpawn);
      assert.equal(appServerSpawn.command, "codex");
      const status = readStatusFromHandler(statusHandler);
      const startupId = text(status.startupId);
      assert.equal(status.revisionId, revisionId);
      assert.equal(status.container, "agent");
      assert.equal(status.podUid, "pod-agent-token-1");
      assert.match(startupId, /\S/);
      const expectedToken = pluginAppServerToken(baseToken, revisionId, startupId);
      const digestArgument =
        appServerSpawn.args[appServerSpawn.args.indexOf("--ws-token-sha256") + 1];
      assert.equal(digestArgument, sha256(expectedToken));
      assert.notEqual(digestArgument, sha256(baseToken));
      // Node inherits the wrapper environment when spawn does not supply one.
      const childEnvironment = appServerSpawn.options.env ?? sandbox.process.env;
      assert.equal(Object.hasOwn(childEnvironment, "APP_SERVER_TOKEN"), false);
      assert.equal(childEnvironment.PATH, sandbox.process.env.PATH);
      assert.equal(sandbox.process.env.APP_SERVER_TOKEN, expectedToken);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
