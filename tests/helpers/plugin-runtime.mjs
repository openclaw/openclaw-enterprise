import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import {
  GATEWAY_RUNTIME_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { GATEWAY_TOOL_POLICY_SOURCE_COMMIT } from "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts";

const nodeRequire = createRequire(import.meta.url);

export const WORKSPACE_NODE_BINDING_PATH = "/run/openclaw-workspace-node/workspace-node.json";
export const WORKSPACE_NODE_REVISION_ID = "revision-1";

// A Codex Gateway receives its node through the controller's binding file;
// options.workspaceNodeId writes that file before launch.
export function workspaceNodeBinding(deviceId, revisionId = WORKSPACE_NODE_REVISION_ID) {
  return JSON.stringify({ revisionId, deviceId });
}

export function runOpenClawRuntimeHelper(runtime, responses, options = {}) {
  const gatewayRuntime =
    options.launcher === "docker" ||
    options.env?.OPENCLAW_NATIVE_WORKER_PROFILE !== undefined ||
    options.workspaceNodeId !== undefined ||
    options.workspaceNodeBindingPath === true ||
    options.env?.APP_SERVER_URL !== undefined;
  const calls = options.calls ?? [];
  const intervals = options.intervals ?? [];
  const kills = options.kills ?? [];
  const bindingEnvironment =
    options.workspaceNodeId !== undefined || options.workspaceNodeBindingPath === true
      ? {
          OPENCLAW_WORKSPACE_NODE_PATH: WORKSPACE_NODE_BINDING_PATH,
          OPENCLAW_AGENT_REVISION_ID: WORKSPACE_NODE_REVISION_ID,
        }
      : {};
  const files = new Map([
    [
      "/etc/openclaw/openclaw.json",
      JSON.stringify(
        options.baseConfig ?? {
          gateway: { port: 8080 },
          plugins: { installs: { keep: { source: "npm" } }, load: { paths: ["existing"] } },
          tools: { alsoAllow: ["existing-tool"] },
        },
      ),
    ],
    // Launcher tests supply the candidate image identity. Native image tests
    // separately verify the built runtime's source and enforcement behavior.
    [
      "/opt/oce/runtime/provenance.json",
      JSON.stringify({
        source: "https://github.com/openclaw/openclaw",
        commit: GATEWAY_TOOL_POLICY_SOURCE_COMMIT,
      }),
    ],
    ...(options.files ?? []),
    ...(options.workspaceNodeId === undefined
      ? []
      : [[WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding(options.workspaceNodeId)]]),
  ]);
  let temporaryDirectory = 0;
  const gatewayUnavailable = new Error("Gateway unavailable");
  const sandbox = {
    AbortController,
    Buffer,
    structuredClone,
    files,
    process: {
      env: {
        OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
        HOME: "/home/node",
        ...(options.launcher === "docker"
          ? { OPENCLAW_CONFIG_JSON: files.get("/etc/openclaw/openclaw.json") }
          : {}),
        ...bindingEnvironment,
        ...(options.env ?? {}),
      },
      on() {},
      exit(code) {
        kills.push({ exit: code });
      },
    },
    setInterval(callback, ms) {
      intervals.push({ callback, ms });
      return { unref() {} };
    },
    ...(options.setTimeout === undefined ? {} : { setTimeout: options.setTimeout }),
    ...(options.Date === undefined ? {} : { Date: options.Date }),
    ...(options.console === undefined ? {} : { console: options.console }),
    clearInterval() {},
    clearTimeout() {},
    require(specifier) {
      if (specifier === "openclaw/plugin-sdk/gateway-runtime") {
        return {
          isGatewayTransportError: (error) => error === gatewayUnavailable,
          // OpenClaw's predicate for a request or connect refusal the Gateway answered.
          isGatewayClientRequestError: (error) =>
            error instanceof Error &&
            error.name === "GatewayClientRequestError" &&
            typeof error.gatewayCode === "string" &&
            typeof error.retryable === "boolean",
          async callGatewayFromCli(method, rpcOptions, params, extra) {
            assert.equal(extra.sharedStateMode, "read-only");
            calls.push({ method, params });
            const value = await options.gatewayCall?.(method, extra.signal);
            if (value === undefined) {
              throw gatewayUnavailable;
            }
            return value;
          },
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn(command, args) {
            calls.push({ command, args });
            return {
              on() {},
              kill(signal) {
                kills.push({ signal });
              },
            };
          },
          spawnSync(command, args, spawnOptions) {
            options.beforeSpawn?.(command, args, sandbox, spawnOptions);
            calls.push({ command, args, options: spawnOptions });
            if (
              command === "node" &&
              args[0] === "/app/openclaw.mjs" &&
              args[1] === "config" &&
              args[2] === "validate" &&
              args[3] === "--json"
            ) {
              return (
                options.configValidationResponse ?? {
                  status: 0,
                  stdout: JSON.stringify({ valid: true }),
                  stderr: "",
                }
              );
            }
            return responses.shift() ?? { status: 0, stdout: "", stderr: "" };
          },
        };
      }
      if (specifier === "node:fs") {
        return {
          existsSync(path) {
            return files.has(path);
          },
          mkdirSync() {},
          chmodSync() {},
          mkdtempSync(prefix) {
            if (options.mkdtempError !== undefined) {
              throw options.mkdtempError;
            }
            return `${prefix}${++temporaryDirectory}`;
          },
          rmSync(path) {
            for (const file of files.keys()) {
              if (file === path || file.startsWith(`${path}/`)) {
                files.delete(file);
              }
            }
          },
          readFileSync(path) {
            if (!files.has(path)) {
              throw new Error(`Missing mocked file: ${path}`);
            }
            return files.get(path);
          },
          writeFileSync(path, data) {
            files.set(path, String(data));
          },
          renameSync(from, to) {
            files.set(to, files.get(from));
            files.delete(from);
          },
        };
      }
      return nodeRequire(specifier);
    },
    result: {},
  };
  try {
    const execution = vm.runInNewContext(
      !gatewayRuntime
        ? `${PLUGIN_RUNTIME_HELPERS}
result.value = installOpenClawPlugins(${JSON.stringify(runtime)}, ${JSON.stringify(options.failures ?? [])});`
        : options.launcher === "docker"
          ? DOCKER_GATEWAY_RUNTIME_ENTRYPOINT
          : GATEWAY_RUNTIME_ENTRYPOINT,
      sandbox,
    );
    if (gatewayRuntime) {
      return Promise.resolve(execution).then(() => ({ calls, files, sandbox }));
    }
  } catch (error) {
    if (options.captureError === true) {
      return { calls, files, error };
    }
    throw error;
  }
  return { calls, files, value: sandbox.result.value };
}
