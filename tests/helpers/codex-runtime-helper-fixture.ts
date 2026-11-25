import { createRequire } from "node:module";
import vm from "node:vm";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

export const CODEX_LINEAR_NATIVE_ID = "linear@openai-curated-remote";
export const CODEX_LINEAR_REMOTE_ID = "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c";
export const CODEX_LINEAR_APP_ID = "asdk_app_69a089a326dc8191b32a3f2553f5be2c";
export const CODEX_LINEAR_VERSION = "5.0.1";

const nodeRequire = createRequire(import.meta.url);

export function readCodexRuntimeTimers(env: NodeJS.ProcessEnv): readonly number[] {
  return JSON.parse(
    vm.runInNewContext(
      `${PLUGIN_RUNTIME_HELPERS}
JSON.stringify([CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS, CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS]);`,
      { Buffer, process: { env }, require: nodeRequire },
    ),
  );
}

type CodexPluginSummaryOptions = {
  nativeId?: string | null;
  remotePluginId?: string | null;
  name?: string | null;
  installed?: boolean | null;
  enabled?: boolean | null;
  version?: string | null;
};

type CodexSearchResponseOptions = Omit<CodexPluginSummaryOptions, "installed" | "enabled"> & {
  plugins?: readonly unknown[] | null;
};

type CodexReadResponseOptions = CodexPluginSummaryOptions & {
  skills?: unknown;
  apps?: unknown;
  appTemplates?: unknown;
  mcpServers?: unknown;
};

function codexPluginSummary(options: CodexPluginSummaryOptions, kind: "search" | "read") {
  return {
    id: options.nativeId ?? CODEX_LINEAR_NATIVE_ID,
    remotePluginId: options.remotePluginId ?? CODEX_LINEAR_REMOTE_ID,
    name: options.name ?? "linear",
    source: { type: "remote" },
    installed: kind === "search" ? false : (options.installed ?? true),
    enabled: kind === "search" ? false : (options.enabled ?? true),
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    version: options.version ?? CODEX_LINEAR_VERSION,
    interface: null,
  };
}

export function codexSearchResponse(options: CodexSearchResponseOptions = {}) {
  const plugins = options.plugins ?? [codexPluginSummary(options, "search")];
  return {
    data: plugins.map((plugin) => ({ marketplaceName: "openai-curated-remote", plugin })),
    nextCursor: null,
  };
}

export function codexReadResponse(options: CodexReadResponseOptions = {}) {
  return {
    plugin: {
      marketplaceName: "openai-curated-remote",
      marketplacePath: null,
      summary: codexPluginSummary(options, "read"),
      description: null,
      skills: options.skills ?? [],
      apps: options.apps ?? [{ id: CODEX_LINEAR_APP_ID, name: "Linear", needsAuth: false }],
      appTemplates: options.appTemplates ?? [],
      hooks: [],
      mcpServers: options.mcpServers ?? [],
      scheduledTasks: [],
    },
  };
}

type CodexApprovalMode = "auto" | "prompt" | "approve" | "writes";
type CodexApprovalsReviewer = "user" | "auto_review";

type CodexAccountPolicy = {
  default_tools_approval_mode?: CodexApprovalMode | null;
  approvals_reviewer?: CodexApprovalsReviewer | null;
};

export type CodexAppPolicy = CodexAccountPolicy & {
  enabled?: boolean;
  default_tools_enabled?: boolean | null;
  destructive_enabled?: boolean | null;
  open_world_enabled?: boolean | null;
  omit_tools_from?: readonly string[];
  tools?:
    | Record<string, { enabled?: boolean | null; approval_mode?: CodexApprovalMode | null }>
    | null
    | undefined;
  links?: Record<string, CodexAccountPolicy> | null | undefined;
};

export type CodexPluginPolicy = {
  enabled?: boolean | null;
  mcp_servers?: Record<string, object>;
};

export type CodexAppPolicies = Record<string, CodexAppPolicy> & { _default: CodexAppPolicy };
export type CodexPluginPolicies = Record<string, CodexPluginPolicy> & {
  _default: CodexPluginPolicy;
};

export function codexConfigReadResponse(
  appConfig: CodexAppPolicy | null = {},
  pluginEnabled: boolean | null = true,
) {
  const apps: CodexAppPolicies = {
    _default: { enabled: false },
    [CODEX_LINEAR_APP_ID]: {
      enabled: true,
      default_tools_approval_mode: "auto",
      ...appConfig,
    },
  };
  const plugins: CodexPluginPolicies = {
    _default: { enabled: false },
    [CODEX_LINEAR_NATIVE_ID]: { enabled: pluginEnabled },
  };
  return {
    config: {
      approval_policy: "on-request",
      model: "test-model",
      features: { apps: true, plugins: true, remote_plugin: true },
      apps,
      plugins,
    },
    origins: {},
  };
}

type CodexRequest = {
  method: string;
  params?: unknown;
  id?: number;
};

type CodexRequestHandler = (method: string, params: unknown, id: number | undefined) => unknown;

export function codexRequestDispatcher(
  responses: Readonly<Record<string, (params: unknown, id: number | undefined) => unknown>>,
): CodexRequestHandler {
  return (method, params, id) => {
    const respond =
      typeof method === "string" && Object.hasOwn(responses, method)
        ? responses[method]
        : undefined;
    if (respond === undefined) {
      throw new Error(`unexpected request ${method}`);
    }
    return respond(params, id);
  };
}

export function codexApiKeyDisabledResponses() {
  const disabledConfig = {
    config: {
      features: { apps: false, plugins: false, remote_plugin: false },
      apps: { _default: { enabled: false } },
      plugins: { _default: { enabled: false } },
    },
    origins: {},
  };
  return {
    initialize: () => ({ serverInfo: { name: "codex", version: "0.149.0" } }),
    "config/read": () => disabledConfig,
    "config/batchWrite": () => ({ status: "ok", version: "test-config-1" }),
  };
}

type CodexWebSocketOptions = { headers: { Authorization: string } };
type CodexInstallResult = {
  successfulPluginIds: string[];
  failures: { pluginId: string; code: string }[];
};

type WebSocketListener = (event: unknown) => void;
type TimerCallback = (...args: unknown[]) => void;

type CodexRuntimeHelperOptions = {
  files?: Iterable<readonly [string, unknown]> | null;
  refusedConnections?: number | null;
  Date?: Pick<DateConstructor, "now"> | null;
  setTimeout?: ((callback: TimerCallback, delay?: number, ...args: unknown[]) => unknown) | null;
  env?: Readonly<Record<string, unknown>> | null;
  failures?: unknown;
  captureError?: boolean;
};

export async function runCodexRuntimeHelper(
  runtime: unknown,
  handler: CodexRequestHandler,
  options: CodexRuntimeHelperOptions = {},
) {
  const requests: { method: string; params: unknown }[] = [];
  const sockets: FakeWebSocket[] = [];
  const files = new Map(options.files ?? []);
  // options.refusedConnections models an app-server that is not listening yet.
  const refusedConnections = options.refusedConnections ?? 0;
  class FakeWebSocket {
    declare readonly url: string;
    declare readonly options: CodexWebSocketOptions;
    declare readonly listeners: Map<string, WebSocketListener[]>;

    constructor(url: string, options: CodexWebSocketOptions) {
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      sockets.push(this);
      const refused = sockets.length <= refusedConnections;
      setTimeout(() => this.dispatch(refused ? "error" : "open", {}), 0);
    }

    on(name: string, listener: WebSocketListener) {
      const existing = this.listeners.get(name) ?? [];
      existing.push(listener);
      this.listeners.set(name, existing);
      return this;
    }

    dispatch(name: string, event: unknown) {
      for (const listener of this.listeners.get(name) ?? []) {
        listener(event);
      }
    }

    send(raw: string) {
      const request = JSON.parse(raw) as CodexRequest;
      if (request.method === "initialized") {
        return;
      }
      requests.push({ method: request.method, params: request.params });
      Promise.resolve()
        .then(() => handler(request.method, request.params, request.id))
        .then(
          (result) => {
            const response = result as { __rawMessage?: unknown } | null | undefined;
            if (response?.__rawMessage !== undefined) {
              this.dispatch(
                "message",
                Buffer.from(
                  typeof response.__rawMessage === "string"
                    ? response.__rawMessage
                    : JSON.stringify(response.__rawMessage),
                ),
              );
              return;
            }
            this.dispatch("message", Buffer.from(JSON.stringify({ id: request.id, result })));
          },
          (error: unknown) =>
            this.dispatch(
              "message",
              Buffer.from(
                JSON.stringify({
                  id: request.id,
                  error: { code: -32000, message: (error as { message?: unknown }).message },
                }),
              ),
            ),
        );
    }

    close() {}
  }
  // The helper's clock advances only through its own timer waits, so the 25 ms install
  // budget below counts retry delays, never host scheduling: a loaded runner cannot
  // expire a successful RPC (finding 3034). Expiry cases pass their own Date.
  let now = 0;
  class FixtureDate extends Date {
    static override now() {
      return now;
    }
  }
  const result: {
    resolve?: (value: CodexInstallResult) => void;
    reject?: (reason: unknown) => void;
  } = {};
  const sandbox = {
    JSON,
    Buffer,
    Date: options.Date ?? FixtureDate,
    WebSocket: FakeWebSocket,
    setTimeout:
      options.setTimeout ??
      ((callback: TimerCallback, delay?: number, ...args: unknown[]) =>
        setTimeout(() => {
          now += delay ?? 0;
          callback(...args);
        }, delay)),
    clearTimeout,
    process: {
      env: {
        APP_SERVER_PORT: "4321",
        APP_SERVER_TOKEN: "capability-token-test-value",
        CODEX_HOME: "/home/node/.codex",
        OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "25",
        ...(options.env ?? {}),
      },
    },
    require(specifier: string): unknown {
      if (specifier === "ws") {
        return FakeWebSocket;
      }
      if (specifier === "node:fs") {
        return {
          existsSync(path: string) {
            return files.has(path);
          },
          mkdirSync() {},
          readFileSync(path: string) {
            if (!files.has(path)) {
              throw new Error(`Missing mocked file: ${path}`);
            }
            return files.get(path);
          },
          writeFileSync(path: string, data: unknown) {
            files.set(path, String(data));
          },
        };
      }
      return nodeRequire(specifier);
    },
    result,
  };
  const completion = new Promise<CodexInstallResult>((resolve, reject) => {
    sandbox.result.resolve = resolve;
    sandbox.result.reject = reject;
  });
  try {
    vm.runInNewContext(
      `${PLUGIN_RUNTIME_HELPERS}
installCodexPlugins(
  ${JSON.stringify(runtime)},
  ${JSON.stringify(options.failures ?? [])},
  codexAppServerRequest
).then(result.resolve, result.reject);`,
      sandbox,
    );
  } catch (error) {
    if (options.captureError === true) {
      return { requests, sockets, files, error };
    }
    throw error;
  }
  try {
    const value = await completion;
    return { requests, sockets, files, value };
  } catch (error) {
    if (options.captureError === true) {
      return { requests, sockets, files, error };
    }
    throw error;
  }
}
