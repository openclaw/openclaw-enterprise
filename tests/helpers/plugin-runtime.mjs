import { createRequire } from "node:module";
import vm from "node:vm";
import {
  GATEWAY_RUNTIME_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const nodeRequire = createRequire(import.meta.url);

export function runOpenClawRuntimeHelper(runtime, responses, options = {}) {
  const gatewayRuntime =
    options.workspaceNodeId !== undefined || options.env?.APP_SERVER_URL !== undefined;
  const calls = options.calls ?? [];
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
  ]);
  const sandbox = {
    Buffer,
    JSON,
    files,
    process: {
      env: {
        OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
        HOME: "/home/node",
        ...(options.env ?? {}),
        ...(options.workspaceNodeId === undefined
          ? {}
          : { OPENCLAW_WORKSPACE_NODE_ID: options.workspaceNodeId }),
      },
      on() {},
    },
    require(specifier) {
      if (specifier === "node:child_process") {
        return {
          spawn(command, args) {
            calls.push({ command, args });
            return { on() {} };
          },
          spawnSync(command, args, spawnOptions) {
            options.beforeSpawn?.(command, args, sandbox);
            calls.push({ command, args, options: spawnOptions });
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
          readFileSync(path) {
            if (!files.has(path)) {
              throw new Error(`Missing mocked file: ${path}`);
            }
            return files.get(path);
          },
          writeFileSync(path, data) {
            files.set(path, String(data));
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
      return execution.then(() => ({ calls, files }));
    }
  } catch (error) {
    if (options.captureError === true) {
      return { calls, files, error };
    }
    throw error;
  }
  return { calls, files, value: sandbox.result.value };
}
