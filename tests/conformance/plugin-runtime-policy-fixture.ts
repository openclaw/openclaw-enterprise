import assert from "node:assert/strict";

import type { PluginRuntimeSpec } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import type {
  PluginApprovers,
  PluginDesiredSelection,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";

export const OCC_DIFFS_DIGEST =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

export function openClawRuntime(
  selection: Partial<PluginDesiredSelection> = {},
  pluginApprovers?: PluginApprovers,
) {
  const manifest: Extract<PluginRuntimeSpec, { kind: "openclaw" }> = {
    kind: "openclaw",
    selections: {
      "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "none" }, ...selection },
    },
    ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
  };
  return { manifest };
}

export function installedPluginResponses(): SpawnResponse[] {
  return [
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
    {
      status: 0,
      stdout: JSON.stringify({
        plugin: {
          id: "diffs",
          version: "2026.8.2",
          rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
        },
        install: {
          source: "npm",
          resolvedName: "@openclaw/diffs",
          resolvedVersion: "2026.8.2",
          installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
          integrity: OCC_DIFFS_DIGEST,
        },
      }),
      stderr: "",
    },
  ];
}

export const GATEWAY_LOCAL_CODEX_TOOLS = [
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
];

interface CodexGatewayConfig {
  gateway: { port: number; nodes: { commands: { allow: string[] } }; auth?: unknown };
  plugins: {
    allow: string[];
    entries: {
      codex?: {
        enabled: boolean;
        config: {
          appServer: {
            transport: string;
            url: string;
            nativeHookRelay?: { url: string; credentialDirectory: string };
          };
          codexDynamicToolsExclude?: unknown;
        };
      };
    };
  };
  tools: {
    profile?: string;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
    exec?: { applyPatch: { workspaceOnly: boolean } };
    gatewayPolicy?: { allow: string[]; actions?: Record<string, string[]> };
  };
  // Native configuration exercises both valid and malformed owner inputs.
  models?: unknown;
  cron?: unknown;
  agents?: unknown;
  messages?: unknown;
}

export function codexGatewayConfig() {
  const codex: NonNullable<CodexGatewayConfig["plugins"]["entries"]["codex"]> = {
    enabled: true,
    config: { appServer: { transport: "websocket", url: "wss://harness.example.test" } },
  };
  const config: CodexGatewayConfig = {
    gateway: { port: 8080, nodes: { commands: { allow: ["existing.command"] } } },
    plugins: { allow: ["codex"], entries: { codex } },
    tools: { alsoAllow: ["existing-tool"] },
  };
  return { config, codex };
}

export type SpawnResponse =
  { status: number; stdout: string; stderr: string } | { status: null; error: Error };

interface SpawnOptions {
  env?: Record<string, string | undefined>;
  timeout?: number;
  maxBuffer?: number;
}

export type RuntimeCall =
  | {
      command: string;
      args: (string | undefined)[];
      method?: undefined;
      options?: SpawnOptions | undefined;
    }
  | { method: string; params: unknown; command?: undefined; args?: undefined; options?: undefined };

export interface RuntimeInterval {
  callback: () => Promise<void> | void;
  ms: number;
}

export type RuntimeKill = { exit: number } | { signal: NodeJS.Signals };

export interface RuntimeSandbox {
  process: { env: Record<string, unknown> };
  files: Map<string, string>;
}

interface RuntimeFiles {
  calls: RuntimeCall[];
  files: Map<string, string>;
}

interface RuntimeOptions {
  baseConfig?: unknown;
  files?: readonly (readonly [string, string])[] | undefined;
  calls?: RuntimeCall[];
  configValidationResponse?: SpawnResponse | undefined;
  env?: Readonly<Record<string, string | undefined>>;
}

interface InstallOptions extends RuntimeOptions {
  captureError?: boolean;
  mkdtempError?: Error;
  beforeSpawn?: (
    command: string,
    args: string[],
    sandbox: RuntimeSandbox,
    options: SpawnOptions,
  ) => void;
}

export interface GatewayOptions extends RuntimeOptions {
  launcher?: "docker" | undefined;
  workspaceNodeId?: string | undefined;
  workspaceNodeBindingPath?: true;
  intervals?: RuntimeInterval[];
  kills?: RuntimeKill[];
  gatewayCall?: (
    method: string,
    signal: AbortSignal,
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  setTimeout?: (callback: () => void, ms: number) => { unref(): void };
  Date?: Pick<DateConstructor, "now">;
  console?: { error(line: string): void };
}

export function record(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  assert.ok(result, "expected an object in the runtime observation");
  return result;
}

export function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((owner, key) => record(owner)[key], value);
}

export function stringList(value: unknown): string[] {
  assert.ok(
    Array.isArray(value) && value.every((item: unknown) => typeof item === "string"),
    "expected a list of strings in the runtime observation",
  );
  return value;
}

function isFileMap(value: unknown): value is Map<string, string> {
  if (!(value instanceof Map)) {
    return false;
  }
  const files: Map<unknown, unknown> = value;
  for (const [path, contents] of files) {
    if (typeof path !== "string" || typeof contents !== "string") {
      return false;
    }
  }
  return true;
}

function isSpawnOptions(value: unknown): value is SpawnOptions {
  const options = asRecord(value);
  const env = asRecord(options?.env);
  return (
    options !== undefined &&
    (options.env === undefined ||
      (env !== undefined &&
        Object.values(env).every((item) => item === undefined || typeof item === "string"))) &&
    (options.timeout === undefined || typeof options.timeout === "number") &&
    (options.maxBuffer === undefined || typeof options.maxBuffer === "number")
  );
}

function isRuntimeCall(value: unknown): value is RuntimeCall {
  const call = asRecord(value);
  if (typeof call?.method === "string") {
    return call.command === undefined && call.args === undefined && call.options === undefined;
  }
  return (
    call?.method === undefined &&
    typeof call?.command === "string" &&
    Array.isArray(call.args) &&
    call.args.every((arg: unknown) => arg === undefined || typeof arg === "string") &&
    (call.options === undefined || isSpawnOptions(call.options))
  );
}

function isRuntimeSandbox(value: unknown): value is RuntimeSandbox {
  const sandbox = asRecord(value);
  return isFileMap(sandbox?.files) && asRecord(asRecord(sandbox?.process)?.env) !== undefined;
}

function readRun(value: unknown): RuntimeFiles {
  const { calls, files } = record(value);
  assert.ok(Array.isArray(calls) && calls.every(isRuntimeCall), "expected VM call records");
  assert.ok(isFileMap(files), "expected the VM filesystem");
  return { calls, files };
}

export type RuntimeInput = { manifest: PluginRuntimeSpec };

export function runPluginInstall(
  runtime: RuntimeInput,
  responses: SpawnResponse[],
  options: InstallOptions = {},
): RuntimeFiles & { error?: { message: string } | undefined; value: unknown } {
  const { beforeSpawn, ...rest } = options;
  const observed: unknown = runOpenClawRuntimeHelper(runtime, responses, {
    ...rest,
    ...(beforeSpawn === undefined
      ? {}
      : {
          beforeSpawn(command: unknown, args: unknown, sandbox: unknown, spawnOptions: unknown) {
            assert.ok(typeof command === "string", "expected a native spawn command");
            assert.ok(isRuntimeSandbox(sandbox), "expected the VM sandbox");
            assert.ok(isSpawnOptions(spawnOptions), "expected synchronous spawn options");
            beforeSpawn(command, stringList(args), sandbox, spawnOptions);
          },
        }),
  });
  const { error, value } = record(observed);
  const errorRecord = asRecord(error);
  const message = errorRecord?.message;
  assert.ok(error === undefined || typeof message === "string", "expected a VM error message");
  return {
    ...readRun(observed),
    error: typeof message === "string" ? { message } : undefined,
    value,
  };
}

export async function launchGateway(
  runtime: RuntimeInput | undefined,
  responses: SpawnResponse[],
  options: GatewayOptions,
): Promise<RuntimeFiles & { sandbox: RuntimeSandbox }> {
  const observed: unknown = await runOpenClawRuntimeHelper(runtime, responses, options);
  const { sandbox } = record(observed);
  assert.ok(isRuntimeSandbox(sandbox), "expected the launched Gateway VM sandbox");
  return { ...readRun(observed), sandbox };
}

export function nativeGatewaySpawns(calls: RuntimeCall[]) {
  return calls.filter(
    ({ command, args }) =>
      command === "node" && args?.[0] === "/app/openclaw.mjs" && args[1] === "gateway",
  );
}

export function commandArgs(call: RuntimeCall | undefined): (string | undefined)[] {
  assert.ok(call?.args, "expected a native command invocation");
  // The native arguments are VM arrays. Copy them before comparing with host fixtures.
  return Array.from(call.args);
}

export function parseJson(text: string | undefined): unknown {
  assert.ok(typeof text === "string", "expected JSON text in the VM observation");
  const value: unknown = JSON.parse(text);
  return value;
}

export function readConfig(
  files: ReadonlyMap<string, string>,
  path = "/home/node/.openclaw/openclaw.json",
): Record<string, unknown> {
  return record(parseJson(files.get(path)));
}

export function configPath(value: unknown): string {
  assert.ok(typeof value === "string", "expected the launcher configuration path");
  return value;
}
