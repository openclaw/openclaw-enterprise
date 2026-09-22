import { createRequire } from "node:module";
import vm from "node:vm";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const nodeRequire = createRequire(import.meta.url);

export function runOpenClawRuntimeHelper(runtime, responses, options = {}) {
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
      },
    },
    require(specifier) {
      if (specifier === "node:child_process") {
        return {
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
    vm.runInNewContext(
      `${PLUGIN_RUNTIME_HELPERS}
result.value = installOpenClawPlugins(${JSON.stringify(runtime)}, ${JSON.stringify(options.failures ?? [])});`,
      sandbox,
    );
  } catch (error) {
    if (options.captureError === true) {
      return { calls, files, error };
    }
    throw error;
  }
  return { calls, files, value: sandbox.result.value };
}
