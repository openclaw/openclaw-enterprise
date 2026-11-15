import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { GatewayClient } from "../../apps/controller/node_modules/@openclaw/gateway-client/dist/index.mjs";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createCodexPolicyMetadataReader } from "./codex-policy-thread-evidence.ts";
import {
  createGatewaySessionEvidence,
  type AgentSelection,
  type SessionEvidenceOptions,
} from "./plugin-gateway-session-evidence.ts";
import {
  createPluginRevisionFailureLogs,
  pluginRevisionLogTarget,
} from "./plugin-revision-failure-logs.ts";
import { createPluginTranscriptAssertions } from "./plugin-transcript-assertions.ts";

type GatewayClientOptions = ConstructorParameters<typeof GatewayClient>[0];
type GatewayEvidenceOptions = Parameters<typeof createGatewaySessionEvidence>[0];
type Exec = GatewayEvidenceOptions["execGateway"];
type WaitFor = <Result>(
  description: string,
  observe: () => Promise<Result | undefined>,
  timeoutMs?: number,
) => Promise<Result>;
type GatewayEndpoint = {
  url: string;
  gatewayPassword?: string;
  close?: () => void | Promise<void>;
};
type NativePluginOptions = Parameters<typeof createPluginRevisionFailureLogs>[0] & {
  gatewayUrl?: (agent: AgentSelection) => Promise<GatewayEndpoint>;
  execGateway: Exec;
  execCodex?: Exec;
  waitFor?: WaitFor;
  proofMode?: GatewayEvidenceOptions["proofMode"];
};
type HumanReview = Omit<SessionEvidenceOptions, "sessionKey" | "resultPattern"> & {
  decision: "allow-once" | "deny";
};
type GatewayTurnOptions = {
  agent: AgentSelection;
  gatewayPassword?: string;
  sessionKey?: string;
  prompt: string;
  expectedPatterns: readonly (string | RegExp)[];
  secrets?: readonly (string | undefined)[];
  humanReview?: HumanReview;
};
type CatalogSelection = { id: string; appIds?: readonly string[] };
type EnabledConfiguration = Record<string, unknown> & { enabled?: boolean | null };
type HttpErrorSummary = { status: number; code?: string; message?: string; body?: "non-json" };

function readJsonRecord(text: string): Record<string, unknown> {
  const record = asRecord(JSON.parse(text));
  assert.ok(record, "native runtime observation must be a JSON object");
  return record;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function readOptionalStringList(value: unknown): string[] | undefined {
  assert.ok(value === undefined || isStringList(value), "native policy must contain a string list");
  return value;
}

function readEnabledConfiguration(value: unknown): EnabledConfiguration | undefined {
  if (value === undefined) {
    return undefined;
  }
  const entry = asRecord(value);
  assert.ok(entry, "native configuration entry must be an object");
  const { enabled } = entry;
  assert.ok(
    enabled == null || typeof enabled === "boolean",
    "native configuration entry enabled flag must be boolean when set",
  );
  return enabled === undefined ? entry : { ...entry, enabled };
}

function readAppCount(value: unknown): number {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "native Codex app count must be a nonnegative integer",
  );
  return value;
}

export function assertNoSecretMaterial(
  value: unknown,
  secrets: readonly (string | undefined)[],
  description: string,
) {
  const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) {
      continue;
    }
    assert.equal(serialized.includes(secret), false, description);
  }
}

function codexBridgeSlug(pluginId: string) {
  const prefix = "codex-plugin:";
  const marketplaceSuffix = "@openai-curated-remote";
  assert.ok(
    pluginId.startsWith(prefix) && pluginId.endsWith(marketplaceSuffix),
    `Codex plugin ID ${pluginId} must identify the curated remote marketplace.`,
  );
  return pluginId.slice(prefix.length, -marketplaceSuffix.length);
}

const gatewayHttpConfigScript = String.raw`
  const { existsSync, readFileSync } = require("node:fs");
  const candidates = [
    "/home/node/.openclaw/openclaw.json",
    process.env.OPENCLAW_CONFIG_PATH,
  ].filter((path) => typeof path === "string" && path.length > 0);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const config = JSON.parse(readFileSync(path, "utf8"));
    process.stdout.write(JSON.stringify({
      configPath: path,
      exists: true,
      chatCompletionsEnabled:
        config?.gateway?.http?.endpoints?.chatCompletions?.enabled === true,
      hasCodexPluginEntry: config?.plugins?.entries?.codex?.enabled === true,
      hasAppsFeature: config?.features?.apps === true,
      hasRemotePluginFeature: config?.features?.remote_plugin === true,
      codexPlugins:
        config?.plugins?.entries?.codex?.config?.codexPlugins?.plugins ?? {},
    }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ exists: false }));
`;

const codexLocalAppServerTokenScript = String.raw`
async function useLocalPluginRuntimeAppServerToken() {
  const port = pluginRuntimeStatusPort();
  if (port === undefined) {
    throw new Error("Local plugin runtime status port is required for app-server authentication.");
  }
  const response = await fetch("http://127.0.0.1:" + port + PLUGIN_STATUS_PATH, {
    signal: AbortSignal.timeout(CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error("Local plugin runtime status is unavailable.");
  }
  const status = await response.json();
  if (
    !isPlainObject(status) ||
    status.revisionId !== pluginRuntimeRevisionId() ||
    status.container !== "agent" ||
    status.phase !== "ready" ||
    typeof status.startupId !== "string" ||
    status.startupId.length === 0
  ) {
    throw new Error("Local plugin runtime status is not ready.");
  }
  process.env.APP_SERVER_TOKEN = derivePluginAppServerToken(status.startupId);
}
`;

// Query the already authenticated Agent app-server through the same protocol client
// used by startup; a separate gateway never receives the model credential.
const codexNativeCatalogScript = String.raw`
${PLUGIN_RUNTIME_HELPERS}
${codexLocalAppServerTokenScript}
let catalogStage = "local app-server authentication";
(async () => {
  await useLocalPluginRuntimeAppServerToken();
  const deadline = Date.now() + CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS;
  const entries = [];
  for (const id of new Set(JSON.parse(process.argv[1]))) {
    // Look up only the requested plugin, through the same paginated search as startup.
    catalogStage = "plugin/search";
    let params;
    try {
      [params] = await searchCodexSelectionParams({ [id]: {} }, codexAppServerRequest, deadline);
    } catch (error) {
      // The plugin-driver scenario supplies alternative candidates that may be absent.
      if (error.message === "Codex plugin catalog did not contain the selected plugin.") {
        continue;
      }
      throw error;
    }
    catalogStage = "plugin/read";
    try {
      const detail = await codexAppServerRequest("plugin/read", params);
      if (!isPlainObject(detail?.plugin) || !Array.isArray(detail.plugin.apps)) {
        throw new Error("Native plugin detail is incomplete.");
      }
      const appIds = detail.plugin.apps
        .map((app) => app?.id)
        .filter((id) => typeof id === "string" && id.length > 0);
      entries.push({ id, remotePluginId: params.pluginName,
        detailAvailable: true, appCount: detail.plugin.apps.length, appIds });
    } catch {
      entries.push({ id, remotePluginId: params.pluginName, detailAvailable: false });
    }
  }
  process.stdout.write(JSON.stringify({ entries }));
})().catch((error) => {
  // RPC errors can contain upstream response text. Emit only locally classified facts.
  const timedOut = error.message?.startsWith("Codex app-server plugin runtime request timed out during ");
  const reason = timedOut ? "timed out" : "failed";
  const categories = new Map([
    ["Codex app-server plugin runtime transport failed.", "transport-failed"],
    ["Codex app-server plugin runtime transport closed.", "transport-closed"],
    ["Codex app-server plugin runtime response was invalid JSON.", "invalid-json"],
    ["Codex app-server plugin runtime response was malformed.", "malformed-response"],
    ["Codex plugin search deadline expired.", "search-deadline"],
    ["Codex plugin search repeated its cursor.", "repeated-cursor"],
    ["Local plugin runtime status is unavailable.", "local-status-unavailable"],
    ["Local plugin runtime status is not ready.", "local-status-not-ready"],
  ]);
  const rpcError = error instanceof CodexAppServerRequestError;
  const category = timedOut ? "request-timeout" :
    rpcError ? "rpc-error" : categories.get(error.message) ?? "unknown";
  // Keep only a numeric HTTP status, never the surrounding upstream text or URLs.
  const httpStatus = rpcError && typeof error.message === "string"
    ? error.message.slice(0, 4096).match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?[:=]?\s+)([45]\d{2})\b/i)?.[1]
    : undefined;
  const rpcMethod = rpcError && ["initialize", "plugin/search", "plugin/read"].includes(error.method)
    ? ", RPC method: " + error.method : "";
  const status = httpStatus === undefined ? "" : ", HTTP status: " + httpStatus;
  process.stderr.write("Native Codex catalog query " + reason + " during " + catalogStage +
    " (category: " + category + rpcMethod + status + ").");
  process.exitCode = 1;
});
`;

const codexNativePluginReadScript = String.raw`
${PLUGIN_RUNTIME_HELPERS}
${codexLocalAppServerTokenScript}
(async () => {
  await useLocalPluginRuntimeAppServerToken();
  const detail = await codexAppServerRequest("plugin/read", {
    remoteMarketplaceName: "openai-curated-remote",
    pluginName: process.argv[1],
  });
  const plugin = detail?.plugin;
  const summary = plugin?.summary;
  if (!isPlainObject(summary) || !Array.isArray(plugin.apps)) {
    throw new Error("Native plugin detail is incomplete.");
  }
  process.stdout.write(JSON.stringify({
    summaryId: summary.id,
    remotePluginId: summary.remotePluginId,
    installed: summary.installed === true,
    enabled: summary.enabled === true,
    marketplaceName: plugin.marketplaceName,
    appCount: plugin.apps.length,
    appIds: plugin.apps
      .map((app) => app?.id)
      .filter((id) => typeof id === "string" && id.length > 0),
  }));
})().catch(() => {
  process.stderr.write("Native Codex installed-plugin query failed.");
  process.exitCode = 1;
});
`;

// Read raw names and connector ownership from the authenticated native catalog.
// This is discovery metadata; it is not a policy-filtered model tool inventory.
const codexPluginToolInventoryScript = String.raw`
${PLUGIN_RUNTIME_HELPERS}
${codexLocalAppServerTokenScript}
(async () => {
  await useLocalPluginRuntimeAppServerToken();
  const appIds = new Set(JSON.parse(process.argv[1]));
  const servers = (await readCodexToolStatuses()).filter((server) => server.name === "codex_apps");
  const server = servers[0];
  if (servers.length !== 1 || !isPlainObject(server.tools) || server.toolsError != null) {
    throw new Error("Native app tool inventory is unavailable.");
  }
  const tools = Object.values(server.tools).flatMap((tool) => {
    const appId = tool?._meta?.connector_id;
    if (!appIds.has(appId)) return [];
    if (typeof tool.name !== "string" || !tool.name) throw new Error("Native tool name is missing.");
    return [{
      appId, name: tool.name, transcriptName: server.name + "." + tool.name,
      annotations: tool.annotations ?? {},
    }];
  });
  process.stdout.write(JSON.stringify(tools));
})().catch(() => {
  process.stderr.write("Native Codex tool inventory query failed.");
  process.exitCode = 1;
});
`;

const codexAppConfigurationScript = String.raw`
${PLUGIN_RUNTIME_HELPERS}
${codexLocalAppServerTokenScript}
(async () => {
  await useLocalPluginRuntimeAppServerToken();
  const config = await readCodexPluginConfiguration();
  process.stdout.write(JSON.stringify({
    apps: config?.apps ?? {},
    features: config?.features ?? {},
  }));
})().catch(() => {
  process.stderr.write("Native Codex app configuration query failed.");
  process.exitCode = 1;
});
`;

const workspaceSentinelScript = String.raw`
  const { createHash } = require("node:crypto");
  const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const operation = process.argv[1];
  const name = process.argv[2];
  const content = process.argv[3] ?? "";
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(name)) {
    throw new Error("workspace sentinel name is invalid.");
  }
  const path = join("/home/node/workspace", name);
  mkdirSync("/home/node/workspace", { recursive: true });
  if (operation === "write") {
    writeFileSync(path, content, "utf8");
  } else if (operation !== "read") {
    throw new Error("workspace sentinel operation is invalid.");
  }
  const value = readFileSync(path, "utf8");
  process.stdout.write(JSON.stringify({
    path,
    sha256: createHash("sha256").update(value).digest("hex"),
    length: value.length,
    content: value,
  }));
`;

function httpErrorSummary(
  status: number,
  body: string,
  secrets: readonly (string | undefined)[],
): HttpErrorSummary {
  const summary: HttpErrorSummary = { status };
  try {
    const parsed = asRecord(JSON.parse(body));
    const error = asRecord(parsed?.error ?? parsed);
    if (typeof error?.code === "string") {
      summary.code = error.code;
    }
    if (typeof error?.message === "string") {
      summary.message = assertDiagnosticText(error.message, secrets);
    }
  } catch {
    summary.body = "non-json";
  }
  return summary;
}

function assertDiagnosticText(value: string, secrets: readonly (string | undefined)[]) {
  let text = value.slice(0, 240);
  for (const secret of secrets) {
    if (secret) {
      text = text.replaceAll(secret, "[REDACTED]");
    }
  }
  text = text.replaceAll(/https?:\/\/[^\s"']*\/__openclaw__\/cap\/[^\s"']+/g, "[CAPABILITY_URL]");
  text = text.replaceAll(/\/__openclaw__\/cap\/[A-Za-z0-9._~-]+/g, "[CAPABILITY_URL]");
  return text;
}

export function createNativePluginAssertions({
  gatewayUrl,
  execGateway,
  execCodex,
  waitFor,
  proofMode = "openclaw",
  readRuntimeLogs,
  recordRuntimeLogs,
}: NativePluginOptions) {
  assert.ok(
    proofMode === "openclaw" || proofMode === "codex",
    "native plugin proof mode must be openclaw or codex.",
  );

  const { sessionEvidence, readCodexSessionBinding, readConversationReply } =
    createGatewaySessionEvidence({ execGateway, proofMode });
  const transcriptAssertions = createPluginTranscriptAssertions(sessionEvidence, proofMode);
  const { captureRuntimeFailureLogs, withRuntimeFailureLogs } = createPluginRevisionFailureLogs({
    ...(readRuntimeLogs === undefined ? {} : { readRuntimeLogs }),
    ...(recordRuntimeLogs === undefined ? {} : { recordRuntimeLogs }),
  });

  const runCodex: Exec = (agent, argv) => {
    assert.ok(execCodex, "native Codex proof requires a Codex executor");
    return execCodex(agent, argv);
  };

  async function assertGatewayChatCompletionsEnabled(agent: AgentSelection) {
    const execution = await execGateway(agent, ["node", "-e", gatewayHttpConfigScript]);
    const summary = readJsonRecord(execution.stdout);
    assert.equal(
      summary.chatCompletionsEnabled,
      true,
      `gateway runtime config must enable chat completions: ${JSON.stringify({
        runtime: execution.label,
        ...summary,
      })}`,
    );
    return { runtime: execution.label, codexPlugins: summary.codexPlugins };
  }

  async function readOpenClawPluginPolicy(agent: AgentSelection, pluginId: string) {
    const execution = await execGateway(agent, [
      "node",
      "-e",
      `const { readFileSync } = require("node:fs");
       const config = JSON.parse(readFileSync("/home/node/.openclaw/openclaw.json", "utf8"));
       process.stdout.write(JSON.stringify({
         plugins: {
           allow: config.plugins?.allow,
           deny: config.plugins?.deny,
           enabled: config.plugins?.entries?.[process.argv[1]]?.enabled,
         },
         tools: { allow: config.tools?.allow, alsoAllow: config.tools?.alsoAllow, deny: config.tools?.deny },
       }));`,
      pluginId,
    ]);
    const policy = readJsonRecord(execution.stdout);
    const plugins = asRecord(policy.plugins);
    const tools = asRecord(policy.tools);
    assert.ok(plugins && tools, "native policy must contain plugin and tool configuration");
    const { enabled } = plugins;
    assert.ok(
      enabled === undefined || typeof enabled === "boolean",
      "plugin enabled must be boolean",
    );
    const pluginAllow = readOptionalStringList(plugins.allow);
    const pluginDeny = readOptionalStringList(plugins.deny);
    const toolAllow = readOptionalStringList(tools.allow);
    const toolAlsoAllow = readOptionalStringList(tools.alsoAllow);
    const toolDeny = readOptionalStringList(tools.deny);
    return {
      plugins: {
        ...(pluginAllow === undefined ? {} : { allow: pluginAllow }),
        ...(pluginDeny === undefined ? {} : { deny: pluginDeny }),
        ...(enabled === undefined ? {} : { enabled }),
      },
      tools: {
        ...(toolAllow === undefined ? {} : { allow: toolAllow }),
        ...(toolAlsoAllow === undefined ? {} : { alsoAllow: toolAlsoAllow }),
        ...(toolDeny === undefined ? {} : { deny: toolDeny }),
      },
    };
  }

  function isTransientGatewayReadinessAssertion(error: unknown) {
    return (
      error instanceof Error &&
      error.name === "AssertionError" &&
      (error.message.includes("the exact Agent must have running workload Pods") ||
        error.message.includes("the exact Agent gateway Pod"))
    );
  }

  async function waitForGatewayChatCompletionsEnabled(agent: AgentSelection) {
    assert.ok(waitFor, "native configuration proof requires polling");
    return waitFor("gateway runtime configuration readiness", async () => {
      try {
        return await assertGatewayChatCompletionsEnabled(agent);
      } catch (error) {
        if (isTransientGatewayReadinessAssertion(error)) {
          return undefined;
        }
        throw error;
      }
    });
  }

  async function normalGatewayTurn({
    agent,
    gatewayPassword,
    sessionKey = `agent:main:plugin-proof-${randomUUID()}`,
    prompt,
    expectedPatterns,
    secrets = [],
    humanReview,
  }: GatewayTurnOptions) {
    // Snapshot the turn's admitted identity; later fixture changes must not retarget logs.
    const logTarget = pluginRevisionLogTarget(agent);
    assert.ok(gatewayUrl, "normal Agent turn requires a Gateway endpoint");
    const gateway = await gatewayUrl(agent);
    const password = gatewayPassword ?? gateway.gatewayPassword;
    assert.ok(password, "normal Agent turn requires a gateway password.");
    const abort = new AbortController();
    let reviewer: GatewayClient | undefined;
    let approvalCount = 0;
    let approvalCompleted = Promise.resolve();
    const approvalFailure = Promise.withResolvers<never>();
    // Attach before connecting so a rejected handshake cannot become unhandled.
    approvalFailure.promise.catch(() => undefined);
    try {
      await assertGatewayChatCompletionsEnabled(agent);
      if (humanReview !== undefined) {
        // Use the controller's installed Gateway client, loaded only when human review is needed.
        const { GatewayClient: GatewayReviewer } =
          await import("../../apps/controller/node_modules/@openclaw/gateway-client/dist/index.mjs");
        const connected = Promise.withResolvers<void>();
        const reviewerOptions: GatewayClientOptions = {
          url: gateway.url.replace(/^http/, "ws"),
          password,
          clientName: "gateway-client",
          mode: "backend",
          role: "operator",
          // This test operator owns the disposable gateway; the HTTP turn has
          // a different requester connection, so approval visibility needs admin.
          scopes: ["operator.admin"],
          caps: ["plugin-approvals"],
          deviceIdentity: null,
          onHelloOk: (hello: Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]) => {
            if (!hello.auth?.scopes?.includes("operator.admin")) {
              connected.reject(new Error("plugin approval reviewer requires operator.admin"));
              return;
            }
            connected.resolve();
          },
          onConnectError: (error: Error) => {
            connected.reject(error);
            approvalFailure.reject(error);
          },
          onEvent: (event: Parameters<NonNullable<GatewayClientOptions["onEvent"]>>[0]) => {
            if (event.event !== "plugin.approval.requested") {
              return;
            }
            const approval = asRecord(event.payload);
            const request = asRecord(approval?.request);
            if (request?.sessionKey !== sessionKey) {
              return;
            }
            approvalCount += 1;
            approvalCompleted = (async () => {
              assert.equal(approvalCount, 1, "each requested read must require its own approval");
              assert.equal(request.toolName, "codex_mcp_tool_approval");
              const decisions = request.allowedDecisions;
              assert.ok(isStringList(decisions), "approval must identify its allowed decisions");
              assert.deepEqual([...decisions].sort(), ["allow-once", "deny"]);
              const pending = await sessionEvidence(agent, {
                sessionKey,
                ...humanReview,
                resultPattern: "",
              });
              assert.equal(
                pending.exists,
                true,
                "the pending approval must belong to the live session",
              );
              assert.equal(
                pending.userMarkerSeen,
                true,
                "the pending approval must follow this request",
              );
              assert.ok(
                Array.isArray(pending.results),
                "the pending session must have tool evidence",
              );
              assert.equal(pending.results.length, 0, "a pending read must not have a tool result");
              const id = approval?.id;
              assert.ok(
                typeof id === "string" && id.length > 0,
                "approval must identify its request",
              );
              await approvalClient.request<unknown>("plugin.approval.resolve", {
                id,
                decision: humanReview.decision,
              });
            })();
            approvalCompleted.catch(approvalFailure.reject);
          },
        };
        const approvalClient = new GatewayReviewer(reviewerOptions);
        reviewer = approvalClient;
        const connectTimer = setTimeout(
          () => connected.reject(new Error("plugin approval reviewer connection timed out")),
          15_000,
        );
        try {
          approvalClient.start();
          await connected.promise;
        } finally {
          clearTimeout(connectTimer);
        }
      }
      const { response, body } = await Promise.race([
        fetch(`${gateway.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${password}`,
            "content-type": "application/json",
            "x-openclaw-session-key": sessionKey,
          },
          body: JSON.stringify({
            model: "openclaw/default",
            stream: false,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(240_000)]),
        }).then(async (response) => ({ response, body: await response.text() })),
        approvalFailure.promise,
      ]);
      await approvalCompleted;
      if (humanReview !== undefined) {
        assert.equal(approvalCount, 1, "the normal Agent turn must request human review");
      }
      assertNoSecretMaterial(
        body,
        [password, ...secrets],
        "normal Agent turn must not expose credentials.",
      );
      assert.equal(
        response.status,
        200,
        `plugin-backed Agent turn failed: ${JSON.stringify(
          httpErrorSummary(response.status, body, [password, ...secrets]),
        )}`,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        assert.fail("plugin-backed Agent turn returned invalid JSON.");
      }
      const choices = asRecord(parsed)?.choices;
      const items: readonly unknown[] = Array.isArray(choices) ? choices : [];
      const content = asRecord(asRecord(items[0])?.message)?.content ?? "";
      assert.ok(typeof content === "string", "plugin-backed Agent reply content must be a string");
      for (const pattern of expectedPatterns) {
        assert.ok(new RegExp(pattern).test(content), `Agent response did not include ${pattern}.`);
      }
      return content;
    } catch (error) {
      await captureRuntimeFailureLogs(logTarget, [password, ...secrets]);
      throw error;
    } finally {
      abort.abort();
      reviewer?.stop();
      await reviewer?.stopAndWait?.({ timeoutMs: 1_000 });
      await gateway.close?.();
    }
  }

  async function listCodexNativeCatalog(agent: AgentSelection, pluginIds: readonly string[]) {
    assert.equal(proofMode, "codex", "native Codex catalog discovery requires Codex proof mode.");
    const execution = await runCodex(agent, [
      "node",
      "-e",
      codexNativeCatalogScript,
      JSON.stringify(pluginIds),
    ]);
    const { entries } = readJsonRecord(execution.stdout);
    assert.ok(Array.isArray(entries), "native Codex catalog discovery must return entries.");
    return entries.map((value: unknown) => {
      const entry = asRecord(value);
      assert.ok(entry, "native Codex catalog entry must be an object");
      const { id, remotePluginId, detailAvailable, appCount, appIds } = entry;
      assert.ok(
        typeof id === "string" && id.length > 0,
        "native Codex catalog entry must have an ID",
      );
      assert.ok(
        typeof remotePluginId === "string" && remotePluginId.length > 0,
        "native Codex catalog entry must have a remote ID",
      );
      assert.ok(
        typeof detailAvailable === "boolean",
        "native Codex entry must indicate detail availability",
      );
      if (!detailAvailable) {
        return { id, remotePluginId, detailAvailable, appCount: undefined, appIds: [] };
      }
      assert.ok(isStringList(appIds), "native Codex catalog app IDs must be strings");
      return { id, remotePluginId, detailAvailable, appCount: readAppCount(appCount), appIds };
    });
  }

  async function codexNativePluginDetail(agent: AgentSelection, entry: { remotePluginId: string }) {
    assert.equal(proofMode, "codex", "native Codex plugin detail requires Codex proof mode.");
    const execution = await runCodex(agent, [
      "node",
      "-e",
      codexNativePluginReadScript,
      entry.remotePluginId,
    ]);
    const detail = readJsonRecord(execution.stdout);
    const { summaryId, remotePluginId, installed, enabled, appCount, appIds } = detail;
    assert.ok(
      typeof summaryId === "string" && summaryId.length > 0,
      "native Codex detail must identify its summary",
    );
    assert.ok(
      remotePluginId == null || (typeof remotePluginId === "string" && remotePluginId.length > 0),
      "native Codex detail remote plugin ID must be a nonempty string when set",
    );
    assert.ok(typeof installed === "boolean", "native Codex detail must indicate installation");
    assert.ok(typeof enabled === "boolean", "native Codex detail must indicate enablement");
    assert.ok(isStringList(appIds), "native Codex detail app IDs must be strings");
    return {
      runtime: execution.label,
      ...detail,
      summaryId,
      ...(remotePluginId === undefined ? {} : { remotePluginId }),
      installed,
      enabled,
      appCount: readAppCount(appCount),
      appIds,
    };
  }

  async function codexPluginToolInventory(
    agent: AgentSelection,
    entry: { appIds: readonly string[] },
  ) {
    assert.equal(proofMode, "codex", "native tool inventory requires Codex proof mode.");
    const execution = await runCodex(agent, [
      "node",
      "-e",
      codexPluginToolInventoryScript,
      JSON.stringify(entry.appIds),
    ]);
    const tools: unknown = JSON.parse(execution.stdout);
    assert.ok(Array.isArray(tools) && tools.length > 0, "selected app tool inventory is empty.");
    const inventory: unknown[] = tools;
    return inventory;
  }

  async function codexAppConfiguration(agent: AgentSelection) {
    assert.equal(proofMode, "codex", "native Codex app configuration requires Codex proof mode.");
    const execution = await runCodex(agent, ["node", "-e", codexAppConfigurationScript]);
    const config = readJsonRecord(execution.stdout);
    const apps = asRecord(config.apps);
    assert.ok(apps, "native Codex app configuration must contain an app map");
    return { runtime: execution.label, ...config, apps };
  }

  async function codexEffectivePluginConfiguration(
    agent: AgentSelection,
    {
      successEntry,
      failureEntry,
    }: { successEntry: CatalogSelection; failureEntry: CatalogSelection },
  ) {
    assert.equal(
      proofMode,
      "codex",
      "native Codex effective plugin configuration requires Codex proof mode.",
    );
    const [gateway, appConfig] = await Promise.all([
      waitForGatewayChatCompletionsEnabled(agent),
      codexAppConfiguration(agent),
    ]);
    const bridgePlugins = asRecord(gateway.codexPlugins ?? {});
    assert.ok(bridgePlugins, "Gateway Codex plugin configuration must contain a plugin map");
    const successBridgeSlug = codexBridgeSlug(successEntry.id);
    const failureBridgeSlug = codexBridgeSlug(failureEntry.id);
    const successBridge = readEnabledConfiguration(bridgePlugins[successBridgeSlug]);
    const failureBridge = readEnabledConfiguration(bridgePlugins[failureBridgeSlug]);
    const successAppIds = new Set(successEntry.appIds ?? []);
    const failedOnlyAppIds = (failureEntry.appIds ?? []).filter(
      (appId) => !successAppIds.has(appId),
    );
    assert.ok(
      failedOnlyAppIds.length > 0,
      `Codex failure proof requires at least one app mapped only to ${failureEntry.id}.`,
    );
    const appEntries = (ids: Iterable<string>) =>
      Object.fromEntries(
        Array.from(ids, (id) => [id, readEnabledConfiguration(appConfig.apps[id])] as const),
      );
    return {
      gatewayRuntime: gateway.runtime,
      codexRuntime: appConfig.runtime,
      bridgePluginKeys: Object.keys(bridgePlugins).sort(),
      successBridgeSlug,
      failureBridgeSlug,
      successBridge,
      failureBridge,
      successApps: appEntries(successAppIds),
      failedOnlyApps: appEntries(failedOnlyAppIds),
    };
  }

  async function workspaceSentinel(
    agent: AgentSelection,
    ...args: [operation: "read", name: string] | [operation: "write", name: string, content: string]
  ) {
    const execution = await execGateway(agent, ["node", "-e", workspaceSentinelScript, ...args]);
    const result = readJsonRecord(execution.stdout);
    const { path, sha256, length, content } = result;
    assert.ok(typeof path === "string", "workspace sentinel path must be a string");
    assert.ok(typeof sha256 === "string", "workspace sentinel digest must be a string");
    assert.ok(typeof content === "string", "workspace sentinel content must be a string");
    assert.ok(
      typeof length === "number" && Number.isSafeInteger(length),
      "workspace sentinel length must be an integer",
    );
    return { runtime: execution.label, ...result, path, sha256, length, content };
  }

  function writeWorkspaceSentinel(
    agent: AgentSelection,
    { name, content }: { name: string; content: string },
  ) {
    return workspaceSentinel(agent, "write", name, content);
  }

  function readWorkspaceSentinel(agent: AgentSelection, { name }: { name: string }) {
    return workspaceSentinel(agent, "read", name);
  }

  return {
    normalGatewayTurn,
    withRuntimeFailureLogs,
    readCodexSessionBinding,
    readConversationReply,
    readCodexThreadMetadata: createCodexPolicyMetadataReader(proofMode, runCodex),
    ...transcriptAssertions,
    readOpenClawPluginPolicy,
    listCodexNativeCatalog,
    codexNativePluginDetail,
    codexPluginToolInventory,
    codexAppConfiguration,
    codexEffectivePluginConfiguration,
    writeWorkspaceSentinel,
    readWorkspaceSentinel,
  };
}
