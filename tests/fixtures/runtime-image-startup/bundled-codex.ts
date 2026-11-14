import type { record } from "./wire.ts";

type OpenClawOptions = Record<string, unknown>;
type CodexNotification = (notification: unknown) => void;

type CodexClient = {
  request(
    method: string,
    params: OpenClawOptions,
    options?: { timeoutMs: number },
  ): Promise<unknown>;
  initialize(): Promise<unknown>;
  close(): void;
  closeAndWait(options: { exitTimeoutMs: number; forceKillDelayMs: number }): Promise<unknown>;
  getServerVersion(): unknown;
  addNotificationHandler(handler: CodexNotification): void;
};

export async function bundledExport(prefix: string, symbol: string, matchSource = true) {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dist = "/app/node_modules/openclaw/dist";
  const chunk = readdirSync(dist).find(
    (name) =>
      name.startsWith(prefix + "-") &&
      name.endsWith(".mjs") &&
      (!matchSource || readFileSync(join(dist, name), "utf8").includes(" " + symbol)),
  );
  if (chunk === undefined) {
    throw new Error("Missing packaged chunk for " + symbol);
  }
  const exports: Record<string, unknown> = await import(pathToFileURL(join(dist, chunk)).href);
  const result = Object.values(exports).find(
    (value): value is (...args: unknown[]) => unknown =>
      typeof value === "function" && value.name === symbol,
  );
  if (result === undefined) {
    throw new Error("Missing packaged export " + symbol);
  }
  return result;
}

export async function loadCodexConfig(
  load: typeof bundledExport,
  read: typeof record,
  matchSource = true,
) {
  const createConfig = await load("config-options", "createCodexAppServerConfig", matchSource);
  const aliasPath = "openclaw/plugin-sdk/provider-auth-aliases";
  const aliases: Record<string, unknown> = await import(aliasPath);
  const resolveProviderIdForAuth = aliases.resolveProviderIdForAuth;
  if (typeof resolveProviderIdForAuth !== "function") {
    throw new Error("Missing packaged provider-auth resolver.");
  }
  const config = read(createConfig({ resolveProviderIdForAuth }));
  const resolve = config.resolveCodexAppServerRuntimeOptions;
  if (typeof resolve !== "function") {
    throw new Error("Missing packaged Codex runtime resolver.");
  }
  const resolveOptions = resolve as (input: OpenClawOptions) => unknown;
  return (options: OpenClawOptions) => read(resolveOptions(options));
}

export async function loadCodexClient(load: typeof bundledExport, read: typeof record) {
  const clientClass = await load("client", "CodexAppServerClient");
  if (!("start" in clientClass) || typeof clientClass.start !== "function") {
    throw new Error("Missing packaged Codex client starter.");
  }
  const start = clientClass.start as (this: typeof clientClass, input: OpenClawOptions) => unknown;
  return async (options: OpenClawOptions): Promise<CodexClient> => {
    const client: unknown = await start.call(clientClass, options);
    const candidate = read(client);
    if (
      typeof candidate.request !== "function" ||
      typeof candidate.initialize !== "function" ||
      typeof candidate.close !== "function" ||
      typeof candidate.closeAndWait !== "function" ||
      typeof candidate.getServerVersion !== "function" ||
      typeof candidate.addNotificationHandler !== "function"
    ) {
      throw new Error("Invalid packaged Codex client.");
    }
    return candidate as CodexClient;
  };
}
