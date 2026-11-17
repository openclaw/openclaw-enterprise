import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { pluginRuntimeSpecForRevision } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  codexNoPluginState,
  gatewayRuntimeProvenance,
  nodeRequire,
  parseJson,
  plain,
  property,
  record,
  revision,
  runGeneratedProgram,
  waitForCondition,
} from "./plugin-compute-fixtures.ts";
import { type StatusHandler, readStatusFromHandler } from "./plugin-compute-status.ts";

export function registerGatewayBridge(): void {
  for (const [dedicated, withBroker, proxyEnabled] of [
    [true, true, true],
    [true, false, true],
    [false, true, true],
    [true, false, false],
  ]) {
    test(`Codex gateway supervisor applies plugin-free bridge runtime (dedicated=${dedicated}, broker=${withBroker}, proxy=${proxyEnabled})`, async () => {
      const revisionId = "revision-plugin-compute-1";
      const runtime = pluginRuntimeSpecForRevision(
        revision({ plugins: codexNoPluginState() }),
        withBroker
          ? {
              host: "git.oce.svc",
              domains: { "github.com": "allow", "*.oce.svc": "deny" },
            }
          : undefined,
      );
      const files = new Map([
        ["/opt/oce/runtime/provenance.json", gatewayRuntimeProvenance],
        [
          "/etc/openclaw/openclaw.json",
          JSON.stringify({
            ...record(
              property(
                parseJson(
                  readFileSync(
                    new URL("../../deploy/presets/standard-codex.json", import.meta.url),
                    "utf8",
                  ),
                ),
                "template",
                "configuration",
                "values",
              ),
            ),
            gateway: { port: 8080 },
          }),
        ],
      ]);
      if (!proxyEnabled) {
        const base = record(parseJson(files.get("/etc/openclaw/openclaw.json")));
        record(
          property(base, "plugins", "entries", "codex", "config", "appServer", "networkProxy"),
        ).enabled = false;
        files.set("/etc/openclaw/openclaw.json", JSON.stringify(base));
      }
      const intervals: (() => void)[] = [];
      let statusHandler: StatusHandler | undefined;
      let child: { kill(): void; on(): void } | undefined;
      const sandbox = {
        AbortSignal,
        Buffer,
        structuredClone,
        JSON,
        URL,
        console: { error() {} },
        fetch,
        process: {
          env: {
            APP_SERVER_TOKEN: "base-app-server-token",
            ...(dedicated ? { APP_SERVER_URL: "ws://harness.example.test:4500" } : {}),
            HOME: "/home/node",
            OPENCLAW_AGENT_REVISION_ID: revisionId,
            OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
            OPENCLAW_GATEWAY_PORT: "8080",
            OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: runtime }),
            OPENCLAW_PLUGIN_STATUS_CONTAINER: "gateway",
            OPENCLAW_PLUGIN_STATUS_PORT: "18791",
            OPENCLAW_POD_UID: "gateway-pod-1",
          },
          on() {},
          exit() {},
        },
        setInterval(callback: () => void) {
          intervals.push(callback);
          return { unref() {} };
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
              lstatSync(path: string) {
                if (!files.has(path)) {
                  throw Object.assign(new Error("File not found"), { code: "ENOENT" });
                }
                return { isFile: () => true, mode: 0o600 };
              },
              mkdirSync() {},
              readFileSync(path: string) {
                if (!files.has(path)) {
                  throw new Error(`Missing mocked file: ${path}`);
                }
                return files.get(path);
              },
              writeFileSync(path: string, data: unknown) {
                files.set(path, String(data));
              },
            };
          }
          if (specifier === "node:child_process") {
            return {
              spawn(command: string, args: string[]) {
                assert.equal(command, "node");
                assert.deepEqual(plain(args), ["/app/openclaw.mjs", "gateway", "--port", "8080"]);
                child = { kill() {}, on() {} };
                return child;
              },
              spawnSync(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
                assert.equal(dedicated, true);
                assert.equal(command, "node");
                assert.deepEqual(plain(args), [
                  "/app/openclaw.mjs",
                  "config",
                  "validate",
                  "--json",
                ]);
                assert.equal(options.env.OPENCLAW_CONFIG_READONLY, "1");
                return { status: 0, stdout: JSON.stringify({ valid: true }) };
              },
            };
          }
          return nodeRequire(specifier);
        },
      };

      runGeneratedProgram(GATEWAY_RUNTIME_ENTRYPOINT, sandbox);
      await waitForCondition("gateway supervisor start", () => child);
      assert.equal(intervals.length, 0);

      const effective = parseJson(files.get("/home/node/.openclaw/openclaw.json"));
      assert.equal(
        property(effective, "plugins", "entries", "codex", "config", "codexPlugins"),
        undefined,
      );
      const proxy = property(
        effective,
        "plugins",
        "entries",
        "codex",
        "config",
        "appServer",
        "networkProxy",
      );
      const presetProxy = record(
        property(
          parseJson(
            readFileSync(
              new URL("../../deploy/presets/standard-codex.json", import.meta.url),
              "utf8",
            ),
          ),
          "template",
          "configuration",
          "values",
          "plugins",
          "entries",
          "codex",
          "config",
          "appServer",
          "networkProxy",
        ),
      );
      assert.deepEqual(proxy, {
        ...presetProxy,
        enabled: proxyEnabled,
        ...(withBroker
          ? {
              enabled: true,
              mode: "full",
              allowLocalBinding: true,
              domains: {
                ...record(presetProxy.domains),
                "github.com": "allow",
                "*.oce.svc": "deny",
                "git.oce.svc": "allow",
              },
            }
          : {}),
        readOnlyPaths: withBroker
          ? [
              "/app/node_modules/openclaw",
              "/home/node/.openclaw/plugin-skills",
              "/home/node/openclaw-runtime-assets/plugin-skills",
              "/opt/oce/repository-credentials",
              "/run/oce/repository-credentials",
              ...(dedicated ? ["/home/node/.codex/skills/.system"] : []),
            ]
          : [
              "/app/node_modules/openclaw",
              ...(dedicated && proxyEnabled ? ["/home/node/.codex/skills/.system"] : []),
            ],
      });
      const status = readStatusFromHandler(statusHandler);
      assert.deepEqual(status, {
        revisionId,
        container: "gateway",
        startupId: status.startupId,
        podUid: "gateway-pod-1",
        phase: "ready",
        successfulPluginIds: [],
        failures: [],
      });
    });
  }
}
