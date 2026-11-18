import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mts";
import { asRecord } from "../../packages/utils/src/index.ts";

const executeFile = promisify(execFile);

export const podmanSelected = process.env.OCC_TEST_PODMAN_COMPUTE_REAL === "1";
export const engineBinary = podmanSelected ? "podman" : "docker";
export const engineName = podmanSelected ? "Podman" : "Docker";
export const executionModes = ["embedded", "dedicated"] as const;
export const selected =
  podmanSelected ||
  process.env.OCC_TEST_DOCKER_COMPUTE_REAL === "1" ||
  process.env.OCC_TEST_OTEL_LOGS === "1" ||
  [
    process.env.OCC_DOCKER_RUNTIME_IMAGE,
    process.env.OCC_DOCKER_GATEWAY_IMAGE,
    process.env.OCC_DOCKER_AGENT_IMAGE,
  ].some((value) => typeof value === "string" && value.trim().length > 0);

const LABEL_MANAGED = "org.openclaw.enterprise.managed";
const LABEL_DRIVER = "org.openclaw.enterprise.compute-driver";
export const LABEL_NAMESPACE = "org.openclaw.enterprise.namespace-id";
export const LABEL_AGENT = "org.openclaw.enterprise.agent-id";
export const LABEL_ROLE = "org.openclaw.enterprise.role";

export function runtimeImages() {
  const runtime =
    process.env.OCC_DOCKER_RUNTIME_IMAGE ?? "oce-harness-real:pr26-compatible-runtime";
  return {
    runtime,
    gateway: process.env.OCC_DOCKER_GATEWAY_IMAGE ?? runtime,
    agent: process.env.OCC_DOCKER_AGENT_IMAGE ?? runtime,
  };
}

// Dedicated Codex app-server execution sends Codex custom tools, so explicit model overrides
// must support those tools.
export const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel).replace(
  /^(?:openai|codex)\//,
  "",
);

export function nonempty(value: unknown, name: string): string {
  assert.ok(typeof value === "string", `${name} must be configured.`);
  assert.ok(value.trim().length > 0, `${name} must be nonempty.`);
  return value;
}

export function sanitize(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (current, secret) => (secret ? current.replaceAll(secret, "[REDACTED]") : current),
    text,
  );
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  secrets?: readonly string[];
}

export async function command(
  file: string,
  args: readonly string[],
  { env = process.env, timeoutMs = 120_000, secrets = [] }: CommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await executeFile(file, args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch (error) {
    const failure = asRecord(error);
    const display = sanitize(`${file} ${args.join(" ")}`, secrets);
    const stdout = typeof failure?.stdout === "string" ? failure.stdout : "";
    const stderr = typeof failure?.stderr === "string" ? failure.stderr : "";
    const code = failure?.code;
    const exit = typeof code === "number" || typeof code === "string" ? code : "unknown";
    // The raw execFile error embeds arguments and output, which may carry credentials.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `${display} failed with exit ${sanitize(String(exit), secrets)}.\n${sanitize(stdout + stderr, secrets)}`,
    );
  }
}

export function docker(args: readonly string[], options?: CommandOptions) {
  return command(engineBinary, args, options);
}

export function parseJson(text: string, description: string): unknown {
  try {
    const result: unknown = JSON.parse(text);
    return result;
  } catch {
    throw new Error(`${description} did not return valid JSON.`);
  }
}

export function inspectedObjects(value: unknown, description: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), `${description} must be an array.`);
  const entries: readonly unknown[] = value;
  return entries.map((entry) => {
    const record = asRecord(entry);
    assert.ok(record, `${description} must contain objects.`);
    return record;
  });
}

export async function dockerJson(
  args: readonly string[],
  options?: CommandOptions,
): Promise<unknown> {
  const { stdout } = await docker(args, options);
  return parseJson(stdout, `${engineName} ${args[0]}`);
}

export async function dockerLines(
  args: readonly string[],
  options?: CommandOptions,
): Promise<string[]> {
  const { stdout } = await docker(args, options);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function waitFor<T>(
  description: string,
  operation: () => Promise<T | false | undefined>,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(750);
  }
  assert.fail(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }.`,
  );
}

export type Label = readonly [name: string, value: string];

export function labelFilters(labels: readonly Label[]) {
  return labels.flatMap(([name, value]) => ["--filter", `label=${name}=${value}`]);
}

export function managedNamespaceLabels(namespaceId: string): Label[] {
  return [
    [LABEL_MANAGED, "true"],
    [LABEL_DRIVER, "docker"],
    [LABEL_NAMESPACE, namespaceId],
  ];
}

async function inspectContainers(
  filters: readonly Label[],
  options?: CommandOptions,
): Promise<Record<string, unknown>[]> {
  const ids = await dockerLines(
    ["ps", "-aq", ...labelFilters([[LABEL_MANAGED, "true"], [LABEL_DRIVER, "docker"], ...filters])],
    options,
  );
  if (ids.length === 0) {
    return [];
  }
  return inspectedObjects(await dockerJson(["inspect", ...ids], options), "Container inspection");
}

export async function containerCount(filters: readonly Label[], options?: CommandOptions) {
  return (await inspectContainers(filters, options)).length;
}

export async function waitForContainers(
  filters: readonly Label[],
  expected: number,
  description: string,
) {
  return waitFor(description, async () => {
    const containers = await inspectContainers(filters);
    const running = containers.filter((container) => asRecord(container.State)?.Running === true);
    return running.length === expected ? running : undefined;
  });
}
