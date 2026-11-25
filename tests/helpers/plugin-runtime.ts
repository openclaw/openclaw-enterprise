import assert from "node:assert/strict";
import type { SpawnOptions, SpawnSyncOptions } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";
import {
  GATEWAY_RUNTIME_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { GATEWAY_TOOL_POLICY_SOURCE_COMMIT } from "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts";

const nodeRequire = createRequire(import.meta.url);

// The in-memory rename mock also retains an undefined value for a missing source.
type RuntimeFiles = Map<string, string | undefined>;

interface SpawnResponse {
  status: number | null;
  signal?: NodeJS.Signals;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

// Callers can supply observation arrays that only expose part of each call.
interface RuntimeCall {
  command?: string | undefined;
  args?: (string | undefined)[] | undefined;
  options?: SpawnOptions | SpawnSyncOptions | undefined;
  method?: string | undefined;
  params?: unknown;
}

interface RuntimeInterval {
  callback: () => unknown;
  ms: number;
}

type RuntimeKill = { exit: number } | { signal: NodeJS.Signals };

interface RuntimeSandboxState {
  files: RuntimeFiles;
  process: { env: NodeJS.ProcessEnv };
}

type RpcOptions = Readonly<Record<string, unknown>>;
type GatewayCallExtra = RpcOptions & { signal: AbortSignal; sharedStateMode: string };

interface RuntimeOptions {
  launcher?: "docker" | undefined;
  env?: Readonly<NodeJS.ProcessEnv>;
  baseConfig?: unknown;
  files?: Iterable<readonly [string, string | undefined]> | undefined;
  workspaceNodeId?: string | undefined;
  workspaceNodeBindingPath?: boolean;
  gatewayEntrypoint?: string;
  failures?: readonly unknown[];
  captureError?: boolean;
  calls?: RuntimeCall[];
  intervals?: RuntimeInterval[];
  kills?: RuntimeKill[];
  configValidationResponse?: SpawnResponse | undefined;
  mkdtempError?: unknown;
  beforeSpawn?: (
    command: string,
    args: (string | undefined)[],
    sandbox: RuntimeSandboxState,
    options: SpawnSyncOptions | undefined,
  ) => void;
  gatewayCall?: (
    method: string,
    signal: AbortSignal,
    transport: { rpcOptions: RpcOptions; extra: GatewayCallExtra },
  ) => unknown;
  setTimeout?: (callback: () => void, ms: number) => { unref(): void };
  Date?: Pick<DateConstructor, "now">;
  console?: Pick<Console, "error">;
}

export const WORKSPACE_NODE_BINDING_PATH = "/run/openclaw-workspace-node/workspace-node.json";
export const WORKSPACE_NODE_REVISION_ID = "revision-1";

// A Codex Gateway receives its node through the controller's binding file;
// options.workspaceNodeId writes that file before launch.
export function workspaceNodeBinding(deviceId: string, revisionId = WORKSPACE_NODE_REVISION_ID) {
  return JSON.stringify({ revisionId, deviceId });
}

export function runOpenClawRuntimeHelper(
  runtime: unknown,
  responses: SpawnResponse[],
  options: RuntimeOptions = {},
) {
  const gatewayRuntime =
    options.launcher === "docker" ||
    options.env?.OPENCLAW_NATIVE_WORKER_PROFILE !== undefined ||
    options.workspaceNodeId !== undefined ||
    options.workspaceNodeBindingPath === true ||
    options.env?.APP_SERVER_URL !== undefined;
  const calls: RuntimeCall[] = options.calls ?? [];
  const intervals: RuntimeInterval[] = options.intervals ?? [];
  const kills: RuntimeKill[] = options.kills ?? [];
  const bindingEnvironment =
    options.workspaceNodeId !== undefined || options.workspaceNodeBindingPath === true
      ? {
          OPENCLAW_WORKSPACE_NODE_PATH: WORKSPACE_NODE_BINDING_PATH,
          OPENCLAW_AGENT_REVISION_ID: WORKSPACE_NODE_REVISION_ID,
        }
      : {};
  const files: RuntimeFiles = new Map([
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
      : ([[WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding(options.workspaceNodeId)]] satisfies [
          string,
          string,
        ][])),
  ]);
  const writeDescriptors = new Map<number, string>();
  let nextDescriptor = 3;
  let temporaryDirectory = 0;
  const gatewayUnavailable = new Error("Gateway unavailable");
  const result: { value?: unknown } = {};
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
      exit(code: number) {
        kills.push({ exit: code });
      },
    },
    setInterval(callback: RuntimeInterval["callback"], ms: number) {
      intervals.push({ callback, ms });
      return { unref() {} };
    },
    ...(options.setTimeout === undefined ? {} : { setTimeout: options.setTimeout }),
    ...(options.Date === undefined ? {} : { Date: options.Date }),
    ...(options.console === undefined ? {} : { console: options.console }),
    clearInterval() {},
    clearTimeout() {},
    require(specifier: string): unknown {
      if (specifier === "openclaw/plugin-sdk/gateway-runtime") {
        return {
          isGatewayTransportError: (error: unknown) => error === gatewayUnavailable,
          // OpenClaw's predicate for a request or connect refusal the Gateway answered.
          isGatewayClientRequestError: (error: unknown) =>
            error instanceof Error &&
            error.name === "GatewayClientRequestError" &&
            typeof Reflect.get(error, "gatewayCode") === "string" &&
            typeof Reflect.get(error, "retryable") === "boolean",
          async callGatewayFromCli(
            method: string,
            rpcOptions: RpcOptions,
            params: unknown,
            extra: GatewayCallExtra,
          ) {
            assert.equal(extra.sharedStateMode, "read-only");
            calls.push({ method, params });
            const value = await options.gatewayCall?.(method, extra.signal, { rpcOptions, extra });
            if (value === undefined) {
              throw gatewayUnavailable;
            }
            return value;
          },
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn(command: string, args: (string | undefined)[], spawnOptions?: SpawnOptions) {
            calls.push({
              command,
              args,
              ...(options.gatewayEntrypoint === undefined ? {} : { options: spawnOptions }),
            });
            return {
              on() {},
              kill(signal: NodeJS.Signals) {
                kills.push({ signal });
              },
            };
          },
          spawnSync(
            command: string,
            args: (string | undefined)[],
            spawnOptions?: SpawnSyncOptions,
          ): SpawnResponse {
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
          chmodSync() {},
          mkdtempSync(prefix: string) {
            if (options.mkdtempError !== undefined) {
              throw options.mkdtempError;
            }
            return `${prefix}${++temporaryDirectory}`;
          },
          rmSync(path: string) {
            for (const file of files.keys()) {
              if (file === path || file.startsWith(`${path}/`)) {
                files.delete(file);
              }
            }
          },
          readFileSync(path: string) {
            if (!files.has(path)) {
              throw new Error(`Missing mocked file: ${path}`);
            }
            return files.get(path);
          },
          openSync(path: string, flags: string) {
            assert.equal(flags, "w");
            const descriptor = nextDescriptor++;
            files.set(path, "");
            writeDescriptors.set(descriptor, path);
            return descriptor;
          },
          closeSync(descriptor: number) {
            assert.ok(writeDescriptors.delete(descriptor), "unknown file descriptor");
          },
          writeFileSync(file: string | number, data: unknown) {
            const path = typeof file === "number" ? writeDescriptors.get(file) : file;
            assert.ok(path !== undefined, "unknown file descriptor");
            files.set(path, String(data));
          },
          renameSync(from: string, to: string) {
            files.set(to, files.get(from));
            files.delete(from);
          },
        };
      }
      return nodeRequire(specifier);
    },
    result,
  };
  try {
    const execution: unknown = vm.runInNewContext(
      !gatewayRuntime
        ? `${PLUGIN_RUNTIME_HELPERS}
result.value = installOpenClawPlugins(${JSON.stringify(runtime)}, ${JSON.stringify(options.failures ?? [])});`
        : options.launcher === "docker"
          ? DOCKER_GATEWAY_RUNTIME_ENTRYPOINT
          : (options.gatewayEntrypoint ?? GATEWAY_RUNTIME_ENTRYPOINT),
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
