import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

type ProcessClose = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | undefined;
};

type ReadParams = { remoteMarketplaceName: string; pluginName: string };
type DisabledSelection = { enabled: false; toolDefaults: { approval: "provider_default" } };
type NativeStartupReceipt = {
  version: string;
  nativeReadCount: number;
  maxOutstanding: number;
  drainedNativeError: true;
  recovered: true;
  disabledAppPolicy: true;
  disabledStartupSelections: number;
};
type NativeRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type Preparation = {
  codexAppServerRequest: NativeRequest;
  CodexAppServerRequestError: new (method: string, message: string) => Error & { method: string };
  pluginRuntimeDelay(ms: number): Promise<void>;
  readCodexPluginDetails<Detail>(
    params: readonly ReadParams[],
    read: (params: ReadParams, index: number) => Promise<Detail>,
  ): Promise<Detail[]>;
  installCodexPlugins(
    runtime: { manifest: { kind: "codex"; selections: Record<string, DisabledSelection> } },
    failures: unknown[],
    request: NativeRequest,
  ): Promise<unknown>;
  readCodexPluginConfiguration(): Promise<unknown>;
};

// Register immediately after spawn. A completed process can be awaited again
// during rollback, and close guarantees that its pipes have drained.
export function observeProcessClose(child: ChildProcess): Promise<ProcessClose> {
  return new Promise((resolve) => {
    let failure: Error | undefined;
    child.on("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => resolve({ code, signal, error: failure }));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNativeStartupReceipt(value: unknown): value is NativeStartupReceipt {
  const expected: NativeStartupReceipt = {
    version: "codex-cli 0.164.0",
    nativeReadCount: 6,
    maxOutstanding: 4,
    drainedNativeError: true,
    recovered: true,
    disabledAppPolicy: true,
    disabledStartupSelections: 4,
  };
  return (
    isRecord(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, field]) => value[key] === field)
  );
}

export function parseNativeStartupReceipt(output: string): NativeStartupReceipt {
  // A syntax error may include stdout. Only report the fixed proof fields.
  let receipt: unknown;
  try {
    receipt = JSON.parse(output);
  } catch {
    assert.fail("native startup proof did not return JSON");
  }
  assert.ok(isNativeStartupReceipt(receipt), "native startup proof returned an unexpected receipt");
  return receipt;
}

async function verifyStartupReads(
  assert: typeof import("node:assert/strict"),
  preparation: Preparation,
  server: ChildProcess,
  serverClosed: Promise<ProcessClose>,
  version: string,
): Promise<NativeStartupReceipt> {
  const {
    codexAppServerRequest,
    CodexAppServerRequestError,
    pluginRuntimeDelay,
    readCodexPluginDetails,
    installCodexPlugins,
    readCodexPluginConfiguration,
  } = preparation;

  let catalog: { reply: unknown } | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      catalog = { reply: await codexAppServerRequest("plugin/list", {}) };
      break;
    } catch (error) {
      if (server.pid === undefined || server.exitCode !== null || server.signalCode !== null) {
        const { code, signal, error: serverError } = await serverClosed;
        throw (
          serverError ??
          new Error(`native Codex app-server exited (${code ?? signal})`, { cause: error })
        );
      }
      await pluginRuntimeDelay(250);
    }
  }
  assert.ok(catalog, "native catalog must become available");
  const { reply } = catalog;
  assert.ok(
    isRecord(reply) && Array.isArray(reply.marketplaces),
    "malformed native plugin catalog",
  );
  const marketplaceName = "openai-curated-remote";
  const marketplaces: unknown[] = reply.marketplaces;
  const marketplace = marketplaces.find((value) => {
    assert.ok(isRecord(value) && typeof value.name === "string", "malformed native marketplace");
    return value.name === marketplaceName;
  });
  assert.ok(isRecord(marketplace), "native curated catalog is required");
  assert.ok(Array.isArray(marketplace.plugins), "malformed native marketplace plugin list");
  const plugins: unknown[] = marketplace.plugins;
  const candidates = plugins
    .flatMap((entry) => {
      assert.ok(
        isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0,
        "malformed native plugin summary",
      );
      const { id, remotePluginId } = entry;
      assert.ok(
        remotePluginId == null || (typeof remotePluginId === "string" && remotePluginId.length > 0),
        "malformed native remote plugin ID",
      );
      return typeof remotePluginId === "string" ? [{ id, remotePluginId }] : [];
    })
    .slice(0, 6);
  assert.equal(candidates.length, 6, "native catalog must provide two bounded read batches");

  const params = candidates.map(({ remotePluginId }) => ({
    remoteMarketplaceName: marketplaceName,
    pluginName: remotePluginId,
  }));
  const pluginIds = candidates.map(({ remotePluginId }) => remotePluginId);
  let outstanding = 0;
  let maximum = 0;
  const read = async (params: ReadParams) => {
    outstanding++;
    maximum = Math.max(maximum, outstanding);
    try {
      const detail = await codexAppServerRequest("plugin/read", params);
      assert.ok(isRecord(detail) && isRecord(detail.plugin), "malformed native plugin detail");
      const { summary, apps } = detail.plugin;
      assert.ok(
        isRecord(summary) && typeof summary.remotePluginId === "string" && Array.isArray(apps),
        "malformed native plugin summary or app list",
      );
      const appSummaries: unknown[] = apps;
      const appIds = appSummaries.map((app) => {
        assert.ok(
          isRecord(app) && typeof app.id === "string" && app.id.length > 0,
          "malformed native app ID",
        );
        return app.id;
      });
      return { remotePluginId: summary.remotePluginId, appIds };
    } finally {
      outstanding--;
    }
  };
  const details = await readCodexPluginDetails(params, read);
  assert.equal(maximum, 4);
  assert.equal(outstanding, 0);
  assert.deepEqual(
    details.map(({ remotePluginId }) => remotePluginId),
    pluginIds,
  );
  await assert.rejects(
    readCodexPluginDetails(
      [
        {
          remoteMarketplaceName: marketplaceName,
          pluginName: "plugin_nonexistent_native_startup_proof",
        },
        ...params.slice(0, 3),
      ],
      read,
    ),
    (error: unknown) =>
      error instanceof CodexAppServerRequestError && error.method === "plugin/read",
  );
  assert.equal(outstanding, 0, "native error must drain the whole batch before retry");
  const recovered = await readCodexPluginDetails(params, read);
  assert.deepEqual(
    recovered.map(({ remotePluginId }) => remotePluginId),
    pluginIds,
  );

  const selections = Object.fromEntries(
    candidates
      .slice(0, 4)
      .map(({ id }): [string, DisabledSelection] => [
        "codex-plugin:" + id,
        { enabled: false, toolDefaults: { approval: "provider_default" } },
      ]),
  );
  assert.deepEqual(
    await installCodexPlugins(
      { manifest: { kind: "codex", selections } },
      [],
      codexAppServerRequest,
    ),
    { successfulPluginIds: [], failures: [] },
  );
  const effective = await readCodexPluginConfiguration();
  assert.ok(
    isRecord(effective) && isRecord(effective.apps) && isRecord(effective.plugins),
    "malformed effective plugin configuration",
  );
  for (const fallback of [effective.apps._default, effective.plugins._default]) {
    assert.ok(
      isRecord(fallback) && fallback.enabled === false,
      "default app and plugin policy must be off",
    );
  }
  for (const { appIds } of details.slice(0, 4)) {
    for (const id of appIds) {
      if (Object.hasOwn(effective.apps, id)) {
        const policy: unknown = effective.apps[id];
        assert.ok(
          isRecord(policy) && policy.enabled === false,
          "disabled selections must not enable native app bindings",
        );
      }
    }
  }
  return {
    version,
    nativeReadCount: params.length,
    maxOutstanding: maximum,
    drainedNativeError: true,
    recovered: true,
    disabledAppPolicy: true,
    disabledStartupSelections: Object.keys(selections).length,
  };
}

// This function and its helpers are serialized after Node strips their types.
// The callback evaluates the generated runtime helpers with the child environment.
async function runNativeStartup(
  token: string,
  loadPreparation: () => Preparation,
): Promise<NativeStartupReceipt> {
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { spawn, spawnSync } = await import("node:child_process");
  const { createHash, randomBytes } = await import("node:crypto");

  const home = "/tmp/native-codex-proof";
  const workspace = "/home/node/workspace";
  const credential = randomBytes(32).toString("hex");
  process.env.CODEX_HOME = home;
  process.env.APP_SERVER_PORT = "4500";
  process.env.APP_SERVER_TOKEN = credential;
  process.env.OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS = "30000";
  process.env.OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS = "60000";
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    home + "/config.toml",
    "[features]\napps = true\nplugins = true\nremote_plugin = true\n",
  );

  const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (version.error !== undefined) {
    throw version.error;
  }
  assert.equal(version.status, 0);
  assert.equal(
    version.stdout.trim(),
    "codex-cli 0.164.0",
    "native proof is pinned to the reviewed runtime",
  );
  const login = spawnSync(
    "codex",
    ["-c", "cli_auth_credentials_store=file", "login", "--with-access-token"],
    {
      input: token,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (login.error !== undefined) {
    throw login.error;
  }
  assert.equal(login.status, 0, "native service-account login must succeed");

  const server = spawn(
    "codex",
    [
      "-c",
      'otel.exporter="none"',
      "app-server",
      "--listen",
      "ws://127.0.0.1:4500",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      createHash("sha256").update(credential).digest("hex"),
    ],
    { cwd: workspace, stdio: "ignore" },
  );
  const serverClosed = observeProcessClose(server);
  let receipt: NativeStartupReceipt;
  let stopping = false;
  try {
    receipt = await verifyStartupReads(
      assert,
      loadPreparation(),
      server,
      serverClosed,
      version.stdout.trim(),
    );
  } finally {
    let force: ReturnType<typeof setTimeout> | undefined;
    if (server.pid !== undefined && server.exitCode === null && server.signalCode === null) {
      stopping = server.kill("SIGTERM");
      if (stopping) {
        force = setTimeout(() => server.kill("SIGKILL"), 2_000);
        force.unref();
      }
    }
    await serverClosed;
    clearTimeout(force);
  }
  const { error, code, signal } = await serverClosed;
  if (error !== undefined) {
    throw error;
  }
  assert.ok(stopping, `native Codex app-server exited early (${code ?? signal})`);
  return receipt;
}

export function nativeStartupScript(token: string): string {
  return `
const isRecord = ${isRecord.toString()};
const observeProcessClose = ${observeProcessClose.toString()};
const verifyStartupReads = ${verifyStartupReads.toString()};
(${runNativeStartup.toString()})(${JSON.stringify(token)}, () => {
${PLUGIN_RUNTIME_HELPERS}
return {
  codexAppServerRequest,
  CodexAppServerRequestError,
  pluginRuntimeDelay,
  readCodexPluginDetails,
  installCodexPlugins,
  readCodexPluginConfiguration,
};
}).then(
  (receipt) => console.log(JSON.stringify(receipt)),
  (error) => {
    console.error(error instanceof Error ? error.name + ": " + error.message : String(error));
    process.exitCode = 1;
  },
);
`;
}
