import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import {
  jsonLogEntries,
  runDocker,
  runGatewaySmoke,
  runtimeImageModel,
} from "../helpers/runtime-image-startup.mjs";
import {
  assertBundledPluginLoaded,
  assertGatewayModelLog,
  assertGatewayReadyLog,
  assertNoPackagingFailure,
} from "./runtime-image-startup-assertions.ts";

async function probeCodexAppServerHandshake(timeoutMs: number): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  const pluginDist = "/app/node_modules/openclaw/dist";
  const sharedClientChunk = readdirSync(pluginDist).find((name) =>
    /^shared-client-.*\.mjs$/.test(name),
  );
  if (sharedClientChunk === undefined) {
    throw new Error("Bundled Codex shared-client chunk was not found under " + pluginDist);
  }

  const sharedClientExports: Record<string, unknown> = await import(
    pathToFileURL(join(pluginDist, sharedClientChunk)).href
  );
  const createIsolatedCodexAppServerClient = Object.values(sharedClientExports).find(
    (value): value is (...args: unknown[]) => unknown =>
      typeof value === "function" && value.name === "createIsolatedCodexAppServerClient",
  );
  if (createIsolatedCodexAppServerClient === undefined) {
    throw new Error(
      "Bundled Codex shared-client export did not expose createIsolatedCodexAppServerClient.",
    );
  }
  const configChunk = readdirSync(pluginDist).find((name) => /^config-options-.*\.mjs$/.test(name));
  if (configChunk === undefined) {
    throw new Error("Bundled Codex config chunk was not found under " + pluginDist);
  }
  const configExports: Record<string, unknown> = await import(
    pathToFileURL(join(pluginDist, configChunk)).href
  );
  const createCodexAppServerConfig = Object.values(configExports).find(
    (value): value is (...args: unknown[]) => unknown =>
      typeof value === "function" && value.name === "createCodexAppServerConfig",
  );
  if (createCodexAppServerConfig === undefined) {
    throw new Error("Bundled Codex config export did not expose createCodexAppServerConfig.");
  }
  const providerAuthModule = "openclaw/plugin-sdk/provider-auth-aliases";
  const { resolveProviderIdForAuth }: Record<string, unknown> = await import(providerAuthModule);
  if (typeof resolveProviderIdForAuth !== "function") {
    throw new Error("Bundled provider auth aliases did not expose the auth resolver.");
  }
  const config = createCodexAppServerConfig({ resolveProviderIdForAuth });
  if (!isRecord(config) || typeof config.resolveCodexAppServerRuntimeOptions !== "function") {
    throw new Error("Bundled Codex config did not expose runtime options.");
  }
  const { resolveCodexAppServerRuntimeOptions } = config;
  const versionOutput = execFileSync("codex", ["--version"], { encoding: "utf8" });
  const installedVersion = versionOutput.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (installedVersion === undefined) {
    throw new Error("Unable to parse installed Codex version from: " + versionOutput);
  }

  const agentDir = mkdtempSync(join(tmpdir(), "openclaw-codex-agent-"));
  const codexHome = join(agentDir, "codex-home");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const runtime: unknown = resolveCodexAppServerRuntimeOptions({
    env: {
      OPENCLAW_CODEX_APP_SERVER_BIN: "codex",
      OPENCLAW_CODEX_APP_SERVER_ARGS: "app-server --listen stdio://",
    },
  });
  if (!isRecord(runtime) || !isRecord(runtime.start)) {
    throw new Error("Bundled Codex runtime options did not expose start options.");
  }
  const client = await createIsolatedCodexAppServerClient({
    agentDir,
    authProfileId: null,
    timeoutMs,
    startOptions: {
      ...runtime.start,
      env: {
        CODEX_HOME: codexHome,
        HOME: "/home/node",
      },
      clearEnv: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
    },
  });
  if (!isRecord(client) || typeof client.close !== "function") {
    throw new Error("Bundled Codex app-server client could not be closed.");
  }
  try {
    if (typeof client.getServerVersion !== "function") {
      throw new Error("Bundled Codex app-server client did not expose its server version.");
    }
    const serverVersion: unknown = client.getServerVersion();
    if (serverVersion !== installedVersion) {
      throw new Error(
        `Codex app-server initialized as ${String(serverVersion)}, but codex --version reported ${installedVersion}.`,
      );
    }
    process.stdout.write(JSON.stringify({ installedVersion, serverVersion }));
  } finally {
    client.close();
  }
}

async function assertCodexAppServerHandshake(containerName: string): Promise<void> {
  const { stdout } = await runDocker(
    [
      "exec",
      containerName,
      "node",
      "--input-type=module",
      "-e",
      `await (${probeCodexAppServerHandshake.toString()})(${10_000 * imageSmokeTimeoutMultiplier})`,
    ],
    { timeout: 20_000 * imageSmokeTimeoutMultiplier },
  );
  const result: unknown = JSON.parse(stdout);
  assert.ok(typeof result === "object" && result !== null);
  assert.ok("serverVersion" in result && typeof result.serverVersion === "string");
  assert.ok("installedVersion" in result && typeof result.installedVersion === "string");
  assert.equal(result.serverVersion, result.installedVersion);
}

export async function verifyBundledCodexStartup(
  t: TestContext,
  { entrypoint }: { entrypoint: string | undefined },
): Promise<void> {
  const gateway = await runGatewaySmoke(t, "codex", {
    entrypoint,
    collectPlugins: true,
  });
  const { logs, containerName } = gateway;
  const pluginList: unknown = gateway.pluginList;
  assert.ok(typeof logs === "string");
  const entries: unknown[] = jsonLogEntries(logs);
  assertGatewayReadyLog(entries);
  assertGatewayModelLog(entries, `codex/${runtimeImageModel}`);
  assertBundledPluginLoaded(pluginList, "codex");
  await assertCodexAppServerHandshake(containerName);
  assertNoPackagingFailure(logs);
}
