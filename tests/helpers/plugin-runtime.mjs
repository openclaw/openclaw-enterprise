import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import vm from "node:vm";
import {
  GATEWAY_RUNTIME_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

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
    ...(options.files ?? []),
    ...(options.workspaceNodeId === undefined
      ? []
      : [[WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding(options.workspaceNodeId)]]),
  ]);
  let temporaryDirectory = 0;
  // A Gateway RPC through the OpenClaw CLI; options.gatewayCall(method) answers
  // with a JSON value, or undefined for a failed call.
  const gatewayCall = (method) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      const value = options.gatewayCall?.(method);
      if (value !== undefined) {
        child.stdout.emit("data", Buffer.from(JSON.stringify(value)));
      }
      child.emit("close", value === undefined ? 1 : 0, null);
    });
    return child;
  };
  const sandbox = {
    Buffer,
    files,
    process: {
      env: {
        OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
        HOME: "/home/node",
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
      if (specifier === "node:child_process") {
        return {
          spawn(command, args) {
            calls.push({ command, args });
            if (args?.[1] === "gateway" && args[2] === "call") {
              return gatewayCall(args[3]);
            }
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
        : GATEWAY_RUNTIME_ENTRYPOINT,
      sandbox,
    );
    if (gatewayRuntime) {
      return execution.then(() => ({ calls, files, sandbox }));
    }
  } catch (error) {
    if (options.captureError === true) {
      return { calls, files, error };
    }
    throw error;
  }
  return { calls, files, value: sandbox.result.value };
}
