import assert from "node:assert/strict";
import { assertGatewayLogEntry } from "../helpers/runtime-image-startup.mjs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function assertNoPackagingFailure(output: string): void {
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/);
  assert.doesNotMatch(output, /ENOENT: no such file or directory/);
  assert.doesNotMatch(output, /TypeScript .* is not supported in strip-only mode/);
}

export function assertGatewayReadyLog(entries: readonly unknown[]): void {
  assertGatewayLogEntry(
    entries,
    (entry: unknown) =>
      isRecord(entry) &&
      entry.subsystem === "gateway" &&
      entry.level === "info" &&
      entry.message === "gateway ready",
    "runtime image must emit gateway ready at native info level",
  );
}

export function assertGatewayModelLog(entries: readonly unknown[], modelReference: string): void {
  assertGatewayLogEntry(
    entries,
    (entry: unknown) =>
      isRecord(entry) &&
      entry.subsystem === "gateway" &&
      entry.level === "info" &&
      typeof entry.message === "string" &&
      entry.message.includes(`agent model: ${modelReference}`),
    `runtime image must emit ${modelReference} at native info level`,
  );
}

export function assertBundledPluginLoaded(pluginList: unknown, pluginId: "codex" | "slack"): void {
  assert.ok(isRecord(pluginList) && Array.isArray(pluginList.plugins));
  const plugins: unknown[] = pluginList.plugins;
  const plugin = plugins.find((entry) => isRecord(entry) && entry.id === pluginId);
  assert.ok(
    isRecord(plugin),
    `${pluginId} plugin must be present in OpenClaw plugin discovery output`,
  );
  assert.equal(plugin.origin, "bundled");
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.status, "loaded");
  assert.ok(typeof plugin.source === "string");
  assert.match(
    plugin.source,
    pluginId === "codex"
      ? /\/app\/node_modules\/openclaw\/dist\/extensions\/codex\/index\.js$/
      : /\/app\/node_modules\/openclaw\/dist\/extensions\/slack\/index\.js$/,
  );
  assert.ok(isRecord(plugin.dependencyStatus));
  assert.equal(plugin.dependencyStatus.requiredInstalled, true);
  assert.deepEqual(plugin.dependencyStatus.missing, []);
}

export function assertBundledSlackPluginLoaded(pluginList: unknown): void {
  assertBundledPluginLoaded(pluginList, "slack");
}
