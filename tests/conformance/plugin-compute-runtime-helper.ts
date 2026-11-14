import assert from "node:assert/strict";
import type { PluginRuntimeSpec } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import type { OpenClawConfigurationDocument } from "../../packages/contracts/src/index.ts";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";
import { items, property, record, text } from "./plugin-compute-fixtures.ts";

type RuntimeResponse = {
  status: number | null;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
};
type RuntimeOptions = {
  captureError?: true;
  baseConfig?: OpenClawConfigurationDocument;
  env?: NodeJS.ProcessEnv;
  workspaceNodeBindingPath?: true;
};
type RuntimeResult = {
  calls: readonly unknown[];
  files: ReadonlyMap<string, string>;
  error?: { message: string; diagnostic?: unknown };
};

const run: (
  runtime: { manifest: PluginRuntimeSpec },
  responses: RuntimeResponse[],
  options?: RuntimeOptions,
) => unknown = runOpenClawRuntimeHelper;

export function runRuntime(
  runtime: { manifest: PluginRuntimeSpec },
  responses: RuntimeResponse[],
  options?: RuntimeOptions,
): RuntimeResult | Promise<RuntimeResult> {
  const result = run(runtime, responses, options);
  return result instanceof Promise ? result.then(runtimeResult) : runtimeResult(result);
}

function runtimeResult(value: unknown): RuntimeResult {
  const { calls, files, error } = record(value);
  assert.ok(files instanceof Map);
  const entries: ReadonlyMap<unknown, unknown> = files;
  const checkedFiles = new Map<string, string>();
  for (const [path, content] of entries) {
    checkedFiles.set(text(path), text(content));
  }
  assert.ok(
    error === undefined || error instanceof Error || typeof property(error, "message") === "string",
  );
  return {
    calls: items(calls),
    files: checkedFiles,
    ...(error === undefined
      ? {}
      : {
          error: {
            message: text(property(error, "message")),
            diagnostic: property(error, "diagnostic"),
          },
        }),
  };
}

export function runRuntimeHelper(
  runtime: { manifest: PluginRuntimeSpec },
  responses: RuntimeResponse[],
  options?: RuntimeOptions,
): RuntimeResult {
  const result = runRuntime(runtime, responses, options);
  assert.ok(
    !(result instanceof Promise),
    "expected the helper to run without the Gateway launcher",
  );
  return result;
}
