import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ensureDevelopmentBootstrap } from "./bootstrap-installation.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import {
  configureExistingK3dLocalPathSharedFileSystem,
  createKubernetesInstallationConfiguration,
  createRealKubernetesFixture,
  kubernetesHash as hash,
} from "./kubernetes-real.mjs";

const authSecret = "plugin-driver-real-auth-secret-32-bytes";
const authBaseURL = "http://127.0.0.1";
const proofPrefix = "occ-plugin-01a08228";

export const realPluginProofSelected = process.env.OCC_TEST_PLUGIN_DRIVER_REAL === "1";

export function pluginProofSkipReason(scenario) {
  const key = `OCC_TEST_PLUGIN_DRIVER_${scenario.toUpperCase()}_REAL`;
  if (realPluginProofSelected || process.env[key] === "1") return false;
  return `Set ${key}=1 or OCC_TEST_PLUGIN_DRIVER_REAL=1 with disposable k3d/PostgreSQL, immutable real runtime images, model credentials, injected CODEX_ACCESS_TOKEN for Codex proofs, curated plugin proof prompts.`;
}

function requiredPluginProofEnv(name, description = name) {
  const value = process.env[name];
  assert.ok(value && value.trim().length > 0, `${description} (${name}) is required.`);
  return value;
}

export function optionalPluginProofModel() {
  return (process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-4.1").replace(/^(?:openai|codex)\//, "");
}

function selectPluginProofDatabaseUrl({ scenario, databaseUrl }) {
  if (realPluginProofSelected) {
    assert.ok(
      databaseUrl && databaseUrl.trim().length > 0,
      `${scenario} must pass an explicit scenario-specific database URL when OCC_TEST_PLUGIN_DRIVER_REAL=1 is selected.`,
    );
    const sibling =
      scenario === "openclaw"
        ? process.env.OCC_TEST_PLUGIN_DRIVER_CODEX_CALENDAR_DATABASE_URL
        : process.env.OCC_TEST_PLUGIN_DRIVER_OPENCLAW_DATABASE_URL;
    if (sibling !== undefined && sibling.trim().length > 0) {
      assert.notEqual(
        databaseUrl,
        sibling,
        "real plugin-driver scenarios must use separate dedicated databases.",
      );
    }
  }
  return databaseUrl ?? requiredPluginProofEnv("OCC_TEST_DATABASE_URL");
}

export function assertNoSecretMaterial(value, secrets, description) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) continue;
    assert.equal(serialized.includes(secret), false, description);
  }
}

function nativeConfiguration(harnessId) {
  const configuration = createHarnessConfiguration(harnessId, optionalPluginProofModel());
  if (harnessId === "openclaw") {
    configuration.secrets = {
      providers: {
        model: {
          source: "env",
          allowlist: ["OPENAI_API_KEY"],
        },
      },
    };
    configuration.models.providers.openai.apiKey = {
      source: "env",
      provider: "model",
      id: "OPENAI_API_KEY",
    };
  } else {
    configuration.tools = {
      fs: { workspaceOnly: true },
    };
  }
  return configuration;
}

function createServiceKeyControllerRequest(app, serviceKey) {
  assert.equal(typeof serviceKey, "string", "a bootstrap service API key is required");
  assert.ok(serviceKey.length > 0, "a bootstrap service API key is required");
  return async (method, url, payload) => {
    const response = await app.inject({
      method,
      url,
      headers: { "x-api-key": serviceKey, host: "127.0.0.1" },
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      ...(response.body.length === 0 ? {} : response.json()),
    };
  };
}

async function bootstrapServiceKeyFromFile(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(
    typeof parsed.data?.key,
    "string",
    "bootstrap service-key file must contain data.key",
  );
  assert.ok(parsed.data.key.length > 0, "bootstrap service-key file must contain data.key");
  return parsed.data.key;
}

function installationAdministratorServicePrincipal(iamState) {
  const administratorRoles = new Set(
    iamState.roles
      .filter((role) =>
        role.permissions.some(
          (permission) =>
            permission.action === "administer" && permission.resourceKind === "installation",
        ),
      )
      .map((role) => role.id),
  );
  const administratorPrincipals = new Set(
    iamState.bindings
      .filter(
        (binding) => binding.subjectKind === "identity" && administratorRoles.has(binding.roleId),
      )
      .map((binding) => binding.subjectId),
  );
  const principal = iamState.identities.find(
    (identity) => identity.kind === "service_principal" && administratorPrincipals.has(identity.id),
  );
  assert.ok(principal, "existing proof Installation must have a bootstrap service Principal");
  return principal;
}

function createAgentPluginApi({ request, namespaceId }) {
  async function createAgent({ harnessId, executionMode, name, serviceAccountId, providerId }) {
    const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      kind: "agent",
      values: nativeConfiguration(harnessId),
    });
    assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
    const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
      name,
      configurationId: configuration.data.id,
      executionMode,
      ...(providerId === undefined ? {} : { providerId }),
      ...(serviceAccountId === undefined ? {} : { serviceAccountId }),
    });
    assert.equal(agent.status, 201, JSON.stringify(agent.error));
    return agent.data;
  }

  async function getAgent(agentId) {
    const response = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
    assert.equal(response.status, 200, JSON.stringify(response.error));
    return response.data;
  }

  async function replaceAgentPlugins(agentId, plugins) {
    const current = await getAgent(agentId);
    const response = await request("PATCH", `/namespaces/${namespaceId}/agents/${agentId}`, {
      configurationId: current.configurationId,
      executionMode: current.executionMode,
      ...(current.providerId === undefined ? {} : { providerId: current.providerId }),
      ...(current.serviceAccountId === undefined
        ? {}
        : { serviceAccountId: current.serviceAccountId }),
      plugins,
    });
    assert.equal(response.status, 200, JSON.stringify(response.error));
    return response.data.plugins ?? {};
  }

  function installPolicy(payload) {
    const { pluginId: _pluginId, ...policy } = payload;
    return { enabled: true, ...policy };
  }

  async function selectPlugin(agentId, payload) {
    const current = await getAgent(agentId);
    const plugins = {
      ...(current.plugins ?? {}),
      [payload.pluginId]: installPolicy(payload),
    };
    const updated = await replaceAgentPlugins(agentId, plugins);
    return updated[payload.pluginId];
  }

  async function updatePluginPolicy(agentId, pluginId, payload) {
    const current = await getAgent(agentId);
    assert.ok(current.plugins?.[pluginId], `Plugin ${pluginId} must already be selected.`);
    const nextPolicy = { ...current.plugins[pluginId], ...payload };
    for (const [key, value] of Object.entries(nextPolicy)) {
      if (value === null || value === undefined) delete nextPolicy[key];
    }
    const updated = await replaceAgentPlugins(agentId, {
      ...current.plugins,
      [pluginId]: nextPolicy,
    });
    return updated[pluginId];
  }

  async function removePluginSelection(agentId, pluginId) {
    const current = await getAgent(agentId);
    const plugins = { ...(current.plugins ?? {}) };
    delete plugins[pluginId];
    await replaceAgentPlugins(agentId, plugins);
  }

  return { createAgent, getAgent, selectPlugin, updatePluginPolicy, removePluginSelection };
}

function installationConfiguration({
  authentication,
  platformNamespace,
  gatewayImage,
  codexImage,
  pluginDriverId,
  codexServiceAccountImport,
}) {
  const configuration = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage,
    codexImage,
    cluster: `k3d-${proofPrefix}`,
  });
  configuration.drivers.secret.configuration.authentication = authentication;
  configuration.drivers.configuration.id = "configuration-kubernetes-plugin-real";
  configuration.drivers.compute.id = "compute-kubernetes-plugin-real";
  configuration.drivers.plugin = { id: pluginDriverId, configuration: {} };
  if (codexServiceAccountImport !== undefined) {
    configuration.provider = [
      {
        id: "openai",
        type: "chatgpt",
        configuration: {
          workspaceId: codexServiceAccountImport.workspaceId,
          apiKeyPath: codexServiceAccountImport.apiKeyPath,
          credentialTtlSeconds: 3_600,
        },
        drivers: { service_account: "chatgpt-service-accounts" },
      },
    ];
    configuration.drivers.service_account = {
      id: "chatgpt-service-accounts",
      configuration: {},
    };
  }
  configuration.drivers.compute.configuration.resources.namespace.quota = {
    pods: "8",
    "requests.cpu": "2",
    "requests.memory": "2Gi",
    "limits.cpu": "8",
    "limits.memory": "4Gi",
  };
  configuration.drivers.compute.configuration.servicePrincipalCredentials.expirationSeconds = 3_600;
  return configuration;
}

async function codexServiceAccountImportConfiguration(directory, credential) {
  const imported = credential ?? (await readCodexServiceAccountCredential());
  const apiKeyPath = join(directory, "codex-service-account-import-provider-marker");
  await writeFile(apiKeyPath, "test-only-existing-codex-service-account-import\n", {
    mode: 0o600,
  });
  return { ...imported, apiKeyPath };
}

async function deriveCodexWorkspaceId(accessToken) {
  const response = await fetch(
    "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(response.status, 200, "the Codex service-account token must authenticate.");
  const body = await response.json();
  const accountId = body?.chatgpt_account_id;
  assert.equal(typeof accountId, "string", "whoami must return a ChatGPT account identity.");
  assert.match(accountId, /^[0-9a-f-]{36}$/i, "the ChatGPT account identity must be a UUID.");
  return accountId;
}

function createImportedCodexServiceAccountDriverFactory(imported, compute) {
  const driverId = "chatgpt-service-accounts";
  const providerId = "openai";
  return (controller, state) => {
    const driver = {
      capability: "service_account",
      implementation: "test-existing-codex-import",
      id: driverId,
      async create(account) {
        await controller.transact((unit) =>
          state.queryInTransaction(
            unit,
            `INSERT INTO occ.service_account_driver_bindings
               (service_account_id, namespace_id, provider_id, driver_id, external_account_id, workspace_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              account.id,
              account.namespaceId,
              providerId,
              driverId,
              `imported-${account.id}`,
              imported.workspaceId,
            ],
          ),
        );
      },
      async createCredential(account) {
        const secretRef = await compute.storeServiceAccountCredential({
          namespaceId: account.namespaceId,
          serviceAccountId: account.id,
          accessToken: imported.accessToken,
          workspaceId: imported.workspaceId,
        });
        controller.registerRollback(() =>
          compute.deleteServiceAccountCredential({
            namespaceId: account.namespaceId,
            serviceAccountId: account.id,
            secretRef,
          }),
        );
        const result = await controller.transact((unit) =>
          state.queryInTransaction(
            unit,
            `UPDATE occ.service_account_driver_bindings
             SET external_credential_id = $4
             WHERE service_account_id = $1 AND namespace_id = $2 AND driver_id = $3`,
            [account.id, account.namespaceId, driverId, `imported-credential-${account.id}`],
          ),
        );
        assert.equal(result.rowCount, 1, "imported ServiceAccount binding must be exact.");
        return { kind: "access_token", secretRef };
      },
      async delete(account) {
        if (account.credential?.kind === "access_token") {
          await compute.deleteServiceAccountCredential({
            namespaceId: account.namespaceId,
            serviceAccountId: account.id,
            secretRef: account.credential.secretRef,
          });
        }
        await controller.transact((unit) =>
          state.queryInTransaction(
            unit,
            `DELETE FROM occ.service_account_driver_bindings
             WHERE service_account_id = $1 AND namespace_id = $2 AND driver_id = $3`,
            [account.id, account.namespaceId, driverId],
          ),
        );
      },
    };
    controller.registerDriver(driver);
    if (controller.selectDriver("service_account", driver.id) !== driver) {
      throw new Error("The configured ServiceAccount Driver was not selected correctly.");
    }
  };
}

async function createOperatorSecret(kubectlArguments, namespace, name, values) {
  await new Promise((resolve, reject) => {
    const child = spawn("kubectl", kubectlArguments(["create", "-f", "-"]), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2048);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Operator Secret provisioning failed (${code}): ${stderr}`));
    });
    child.stdin.once("error", reject);
    child.stdin.end(
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { namespace, name },
        type: "Opaque",
        data: Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            Buffer.from(value).toString("base64"),
          ]),
        ),
      }),
    );
  });
}

async function waitForPluginProofWorkerSuccess(waitFor, events, revisionId, options) {
  const description = typeof options === "string" ? options : options.description;
  try {
    await waitFor(description, () =>
      events.find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === revisionId &&
          event.outcome === "success" &&
          ["REVISION_ACTIVATED", "REVISION_ALREADY_ACTIVE"].includes(event.code),
      ),
    );
  } catch (error) {
    const diagnostics = typeof options === "string" ? [] : options.diagnostics();
    throw new Error(`${error.message} Worker events: ${JSON.stringify(diagnostics)}`);
  }
}

function sanitizedPluginProofWorkerEvents(events, revisionId) {
  return events
    .filter((event) => event.revisionId === revisionId || event.event === "worker.error")
    .slice(-8)
    .map((event) => ({
      event: event.event,
      revisionId: event.revisionId,
      outcome: event.outcome,
      code: event.code,
    }));
}

const sessionEvidenceScript = String.raw`
  const { DatabaseSync } = require("node:sqlite");
  const sessionKey = process.argv[1];
  const marker = process.argv[2];
  const toolName = process.argv[3];
  const resultPattern = process.argv[4];
  const databasePath = "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  const db = new DatabaseSync(databasePath, { readOnly: true });
  function contains(value, needle) {
    if (!needle) return false;
    if (typeof value === "string") return value.includes(needle);
    if (Array.isArray(value)) return value.some((entry) => contains(entry, needle));
    if (value && typeof value === "object") {
      return Object.values(value).some((entry) => contains(entry, needle));
    }
    return false;
  }
  function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const session = db.prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?").get(sessionKey);
    if (!session) {
      process.stdout.write(JSON.stringify({ databasePath, sessionKey, exists: false }));
      process.exit(0);
    }
    const entry = JSON.parse(session.entry_json);
    const promptTools =
      entry?.systemPromptReport?.source === "run" &&
      Array.isArray(entry.systemPromptReport.tools?.entries)
        ? entry.systemPromptReport.tools.entries
            .map((tool) => tool?.name)
            .filter((name) => typeof name === "string")
        : undefined;
    const rows = db
      .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(session.current_session_id);
    const messages = [];
    const calls = [];
    const results = [];
    const eventTypeCounts = {};
    const roleCounts = {};
    const contentBlockTypeCounts = {};
    const observedToolNames = new Set();
    const resultToolNames = new Set();
    const finalAssistantDiagnostics = {
      mentionsUnavailable: false,
      mentionsAuth: false,
    };
    const codexTurns = new Map();
    function turn(prefix) {
      const current = codexTurns.get(prefix) ?? {
        turnPrefix: prefix,
        promptSeen: false,
        terminalAssistantSeen: false,
        toolCallMirrorSeen: false,
        toolResultMirrorSeen: false,
      };
      codexTurns.set(prefix, current);
      return current;
    }
    function prefixForMirrorIdentity(identity, suffix) {
      return typeof identity === "string" && identity.endsWith(suffix)
        ? identity.slice(0, -suffix.length)
        : undefined;
    }
    function prefixForToolMirrorIdentity(identity, suffix) {
      if (typeof identity !== "string" || !identity.endsWith(suffix)) return undefined;
      const withoutSuffix = identity.slice(0, -suffix.length);
      const marker = ":tool:";
      const index = withoutSuffix.lastIndexOf(marker);
      return index === -1 ? undefined : withoutSuffix.slice(0, index);
    }
    for (const row of rows) {
      const event = JSON.parse(row.event_json);
      eventTypeCounts[event.type ?? "unknown"] = (eventTypeCounts[event.type ?? "unknown"] ?? 0) + 1;
      if (event.type !== "message") continue;
      const message = event.message;
      const hasMarker = contains(message, marker);
      const mirrorIdentity = message?.__openclaw?.mirrorIdentity;
      roleCounts[message.role ?? "unknown"] = (roleCounts[message.role ?? "unknown"] ?? 0) + 1;
      const promptPrefix = prefixForMirrorIdentity(mirrorIdentity, ":prompt");
      if (message.role === "user" && hasMarker && promptPrefix !== undefined) {
        turn(promptPrefix).promptSeen = true;
      }
      const assistantPrefix = prefixForMirrorIdentity(mirrorIdentity, ":assistant");
      if (message.role === "assistant" && hasMarker && assistantPrefix !== undefined) {
        turn(assistantPrefix).terminalAssistantSeen = true;
      }
      messages.push({
        seq: row.seq,
        role: message.role,
        hasMarker,
        stopReason: message.stopReason,
        mirrorIdentity,
      });
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          const blockType = block?.type ?? "unknown";
          contentBlockTypeCounts[blockType] = (contentBlockTypeCounts[blockType] ?? 0) + 1;
          if (typeof block?.name === "string") observedToolNames.add(block.name);
          if (block?.type === "toolCall" && block.name === toolName) {
            const toolPrefix = prefixForToolMirrorIdentity(mirrorIdentity, ":call");
            if (toolPrefix !== undefined) turn(toolPrefix).toolCallMirrorSeen = true;
            calls.push({ seq: row.seq, id: block.id, name: block.name, mirrorIdentity });
          }
        }
        if (hasMarker) {
          const text = textOf(message.content).toLowerCase();
          finalAssistantDiagnostics.mentionsUnavailable ||=
            /unavailable|not available|unable|cannot|can't|could not|no access|not connected|not installed/.test(text);
          finalAssistantDiagnostics.mentionsAuth ||=
            /auth|permission|credential|login|connect|unauthoriz/.test(text);
        }
      }
      if (message.role === "toolResult" && calls.some((call) => call.id === message.toolCallId)) {
        const resultPrefix = prefixForToolMirrorIdentity(mirrorIdentity, ":result");
        if (resultPrefix !== undefined) turn(resultPrefix).toolResultMirrorSeen = true;
        results.push({
          seq: row.seq,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError === true,
          matchesResult: contains(message, resultPattern) || textOf(message.content).includes(resultPattern),
          mirrorIdentity,
        });
      }
      if (message.role === "toolResult" && typeof message.toolName === "string") {
        resultToolNames.add(message.toolName);
      }
    }
    process.stdout.write(JSON.stringify({
      databasePath,
      sessionKey,
      sessionId: session.current_session_id,
      exists: true,
      promptReportSource: entry?.systemPromptReport?.source,
      promptToolNames: promptTools,
      messageCount: messages.length,
      userMarkerSeen: messages.some((message) => message.role === "user" && message.hasMarker),
      assistantMarkerSeen: messages.some((message) => message.role === "assistant" && message.hasMarker),
      assistantError: messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
      calls,
      results,
      codexTurns: Array.from(codexTurns.values()),
      diagnostics: {
        eventCount: rows.length,
        eventTypeCounts,
        roleCounts,
        contentBlockTypeCounts,
        observedToolNames: Array.from(observedToolNames).sort(),
        resultToolNames: Array.from(resultToolNames).sort(),
        finalAssistantDiagnostics,
      },
    }));
  } finally {
    db.close();
  }
`;

function codexToolTurnPrefix(identity, suffix) {
  if (typeof identity !== "string" || !identity.endsWith(suffix)) return undefined;
  const withoutSuffix = identity.slice(0, -suffix.length);
  const marker = ":tool:";
  const index = withoutSuffix.lastIndexOf(marker);
  return index === -1 ? undefined : withoutSuffix.slice(0, index);
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
    }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ exists: false }));
`;

function httpErrorSummary(status, body, secrets) {
  const summary = { status };
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error ?? parsed;
    if (typeof error?.code === "string") summary.code = error.code;
    if (typeof error?.message === "string") {
      summary.message = assertDiagnosticText(error.message, secrets);
    }
  } catch {
    summary.body = "non-json";
  }
  return summary;
}

function assertDiagnosticText(value, secrets) {
  let text = String(value).slice(0, 240);
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  }
  text = text.replaceAll(/https?:\/\/[^\s"']*\/__openclaw__\/cap\/[^\s"']+/g, "[CAPABILITY_URL]");
  text = text.replaceAll(/\/__openclaw__\/cap\/[A-Za-z0-9._~-]+/g, "[CAPABILITY_URL]");
  return text;
}

function createNativePluginAssertions({ gatewayUrl, execGateway, proofMode = "openclaw" }) {
  assert.ok(
    proofMode === "openclaw" || proofMode === "codex",
    "native plugin proof mode must be openclaw or codex.",
  );

  async function assertGatewayChatCompletionsEnabled(agent) {
    const execution = await execGateway(agent, ["node", "-e", gatewayHttpConfigScript]);
    const summary = JSON.parse(execution.stdout);
    assert.equal(
      summary.chatCompletionsEnabled,
      true,
      `gateway runtime config must enable chat completions: ${JSON.stringify({
        runtime: execution.label,
        ...summary,
      })}`,
    );
    return { runtime: execution.label, ...summary };
  }

  async function normalGatewayTurn({
    agent,
    gatewayToken,
    sessionKey = `agent:main:plugin-proof-${randomUUID()}`,
    prompt,
    expectedPatterns,
    secrets = [],
  }) {
    const gateway = await gatewayUrl(agent);
    const token = gatewayToken ?? gateway.gatewayToken;
    assert.ok(token, "normal Agent turn requires a gateway token.");
    try {
      await assertGatewayChatCompletionsEnabled(agent);
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-openclaw-session-key": sessionKey,
        },
        body: JSON.stringify({
          model: "openclaw/default",
          stream: false,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(240_000),
      });
      const body = await response.text();
      assertNoSecretMaterial(
        body,
        [token, ...secrets],
        "normal Agent turn must not expose credentials.",
      );
      assert.equal(
        response.status,
        200,
        `plugin-backed Agent turn failed: ${JSON.stringify(
          httpErrorSummary(response.status, body, [token, ...secrets]),
        )}`,
      );
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        assert.fail("plugin-backed Agent turn returned invalid JSON.");
      }
      const content = parsed.choices?.[0]?.message?.content ?? "";
      for (const pattern of expectedPatterns) {
        assert.ok(new RegExp(pattern).test(content), `Agent response did not include ${pattern}.`);
      }
      return content;
    } finally {
      await gateway.close?.();
    }
  }

  async function sessionEvidence(agent, { sessionKey, turnMarker, toolName, resultPattern }) {
    const execution = await execGateway(agent, [
      "node",
      "-e",
      sessionEvidenceScript,
      sessionKey,
      turnMarker,
      toolName,
      resultPattern,
    ]);
    return { runtime: execution.label, ...JSON.parse(execution.stdout) };
  }

  async function assertSessionToolCallEvidence(agent, options) {
    const evidence = await sessionEvidence(agent, options);
    assert.equal(evidence.exists, true, `${options.sessionKey} must have a persisted transcript.`);
    assert.equal(
      evidence.userMarkerSeen,
      true,
      `${options.sessionKey} must include the marker-bearing user request.`,
    );
    assert.equal(
      evidence.assistantMarkerSeen,
      true,
      `${options.sessionKey} must include the completed marker-bearing assistant response.`,
    );
    assert.equal(
      evidence.assistantError,
      false,
      `${options.sessionKey} assistant turn must succeed.`,
    );
    if (proofMode === "openclaw") {
      assert.ok(
        Array.isArray(evidence.promptToolNames),
        `${options.sessionKey} must have a run-sourced systemPromptReport.tools.entries snapshot.`,
      );
      assert.ok(
        evidence.promptToolNames.includes(options.toolName),
        `${options.sessionKey} prompt tools must advertise ${options.toolName}: ${JSON.stringify({
          runtime: evidence.runtime,
          sessionId: evidence.sessionId,
          promptReportSource: evidence.promptReportSource,
          promptToolNames: evidence.promptToolNames,
        })}`,
      );
    }
    const matched = evidence.calls.find((call) =>
      evidence.results.some(
        (result) =>
          result.toolCallId === call.id &&
          result.isError === false &&
          result.matchesResult === true,
      ),
    );
    assert.ok(
      matched,
      `native transcript for ${options.sessionKey} did not include ${options.toolName} with a matching successful result: ${JSON.stringify(
        {
          runtime: evidence.runtime,
          sessionId: evidence.sessionId,
          calls: evidence.calls,
          results: evidence.results,
          diagnostics: evidence.diagnostics,
        },
      )}`,
    );
    const result = evidence.results.find(
      (candidate) =>
        candidate.toolCallId === matched.id &&
        candidate.isError === false &&
        candidate.matchesResult === true,
    );
    if (proofMode === "codex") {
      const callPrefix = codexToolTurnPrefix(matched.mirrorIdentity, ":call");
      const resultPrefix = codexToolTurnPrefix(result?.mirrorIdentity, ":result");
      assert.ok(
        callPrefix && callPrefix === resultPrefix,
        `${options.sessionKey} Codex native tool call/result must share one mirrored turn.`,
      );
      const turn = evidence.codexTurns.find((candidate) => candidate.turnPrefix === callPrefix);
      assert.ok(
        turn?.promptSeen &&
          turn.terminalAssistantSeen &&
          turn.toolCallMirrorSeen &&
          turn.toolResultMirrorSeen,
        `${options.sessionKey} Codex native turn must include prompt, tool call, tool result, and terminal assistant mirror identities: ${JSON.stringify(
          {
            runtime: evidence.runtime,
            sessionId: evidence.sessionId,
            turnPrefix: callPrefix,
            turn,
          },
        )}`,
      );
    }
    return {
      runtime: evidence.runtime,
      sessionId: evidence.sessionId,
      toolName: matched.name,
      toolCallId: matched.id,
      promptAdvertised: proofMode === "openclaw",
      ...(proofMode === "codex" ? { codexMirrorTurnVerified: true } : {}),
      resultMatched: true,
    };
  }

  async function assertNoSessionToolCallEvidence(agent, options) {
    const evidence = await sessionEvidence(agent, { ...options, resultPattern: "" });
    assert.equal(evidence.exists, true, `${options.sessionKey} must have a persisted transcript.`);
    assert.equal(
      evidence.userMarkerSeen,
      true,
      `${options.sessionKey} must include the marker-bearing user request.`,
    );
    assert.equal(
      evidence.assistantMarkerSeen,
      true,
      `${options.sessionKey} must include the completed marker-bearing assistant response.`,
    );
    assert.equal(
      evidence.assistantError,
      false,
      `${options.sessionKey} assistant turn must succeed.`,
    );
    assert.ok(
      Array.isArray(evidence.promptToolNames),
      `${options.sessionKey} must have a run-sourced systemPromptReport.tools.entries snapshot.`,
    );
    assert.equal(
      evidence.promptToolNames.includes(options.toolName),
      false,
      `${options.sessionKey} prompt tools still advertised ${options.toolName}: ${JSON.stringify({
        runtime: evidence.runtime,
        sessionId: evidence.sessionId,
        promptReportSource: evidence.promptReportSource,
        promptToolNames: evidence.promptToolNames,
      })}`,
    );
    assert.equal(
      evidence.calls.length,
      0,
      `disabled/removed/sibling turn ${options.sessionKey} still invoked ${options.toolName}: ${JSON.stringify(
        {
          runtime: evidence.runtime,
          sessionId: evidence.sessionId,
          calls: evidence.calls,
        },
      )}`,
    );
  }

  return { normalGatewayTurn, assertSessionToolCallEvidence, assertNoSessionToolCallEvidence };
}

export async function createPluginDriverRealFixture(
  context,
  { pluginDriverId, databaseUrl, codexCredential },
) {
  const kubeconfigPath = requiredPluginProofEnv("OCC_TEST_KUBERNETES_KUBECONFIG");
  const kubernetesContext = requiredPluginProofEnv("OCC_TEST_KUBERNETES_CONTEXT");
  const gatewayImage = requiredPluginProofEnv("OCC_TEST_KUBERNETES_GATEWAY_IMAGE");
  const scenario = pluginDriverId === "codex-plugin" ? "codex_calendar" : "openclaw";
  const codexImage =
    pluginDriverId === "codex-plugin"
      ? (process.env.OCC_TEST_KUBERNETES_CODEX_IMAGE ??
        requiredPluginProofEnv("OCC_TEST_KUBERNETES_AGENT_IMAGE", "Codex runtime image"))
      : (process.env.OCC_TEST_KUBERNETES_CODEX_IMAGE ??
        process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE ??
        gatewayImage);
  const selectedDatabaseUrl = selectPluginProofDatabaseUrl({ scenario, databaseUrl });
  const directory = await mkdtemp(join(tmpdir(), "occ-plugin-driver-real-"));
  const suffix = hash(`${proofPrefix}-${randomUUID()}`);
  const platformNamespace = `${proofPrefix}-${suffix}`;
  const credentials = {
    email: `plugin-driver-${suffix}@example.test`,
    password: `plugin-driver-password-${randomUUID()}`,
  };
  const {
    kubectlArguments,
    kubectl,
    resource,
    resources,
    createControllerIdentity,
    waitFor,
    validatePrerequisites,
    provisionAgentTransportSecret,
    startPortForward,
  } = createRealKubernetesFixture({
    kubeconfigPath,
    kubernetesContext,
    gatewayImage,
    codexImage,
    databaseUrl: selectedDatabaseUrl,
  });

  await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
  await validatePrerequisites();
  let worker;
  let app;
  let pool;
  const forwarders = [];
  const gatewayTokens = new Map();
  let tenantNamespace;

  context.after(async () => {
    const failures = [];
    async function cleanup(operation) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const forwarder of forwarders.splice(0)) forwarder.stop();
    if (worker !== undefined) await cleanup(() => worker.stop());
    if (app !== undefined) await cleanup(() => app.close());
    if (pool !== undefined) await cleanup(() => pool.end());
    if (tenantNamespace !== undefined)
      await cleanup(() =>
        kubectl("delete", "namespace", tenantNamespace, "--ignore-not-found=true"),
      );
    for (const role of ["api", "worker"]) {
      await cleanup(() =>
        kubectl(
          "delete",
          "clusterrolebinding",
          `${proofPrefix}-${role}-${suffix}`,
          "--ignore-not-found=true",
        ),
      );
    }
    await cleanup(() =>
      kubectl(
        "delete",
        "clusterrole",
        `${proofPrefix}-namespaces-${suffix}`,
        `${proofPrefix}-tenant-${suffix}`,
        `${proofPrefix}-secrets-${suffix}`,
        "--ignore-not-found=true",
      ),
    );
    await cleanup(() =>
      kubectl("delete", "namespace", platformNamespace, "--ignore-not-found=true"),
    );
    await cleanup(() => rm(directory, { recursive: true, force: true }));
    if (failures.length !== 0)
      throw new AggregateError(failures, "Plugin real proof cleanup failed.");
  });

  await kubectl("create", "namespace", platformNamespace);
  await kubectl(
    "create",
    "clusterrole",
    `${proofPrefix}-namespaces-${suffix}`,
    "--verb=create,get,list,patch,update,delete",
    "--resource=namespaces",
  );
  await kubectl(
    "create",
    "clusterrole",
    `${proofPrefix}-tenant-${suffix}`,
    "--verb=create,get,list,patch,update,delete",
    "--resource=deployments.apps,services,serviceaccounts,configmaps,endpointslices.discovery.k8s.io,networkpolicies.networking.k8s.io,resourcequotas,limitranges,persistentvolumeclaims",
  );
  await kubectl(
    "create",
    "clusterrole",
    `${proofPrefix}-secrets-${suffix}`,
    "--verb=get,create,patch,update,delete",
    "--resource=secrets",
  );

  const kubeconfig = JSON.parse(
    await kubectl("config", "view", "--minify", "--flatten", "-o", "json"),
  );
  const [api, workerIdentity] = await Promise.all(
    ["api", "worker"].map((role) =>
      createControllerIdentity({
        directory,
        platformNamespace,
        kubeconfig,
        account: `${proofPrefix}-${role}`,
        clusterRole: `${proofPrefix}-namespaces-${suffix}`,
        clusterRoleBinding: `${proofPrefix}-${role}-${suffix}`,
        context: `${proofPrefix}-${role}-${suffix}`,
      }),
    ),
  );

  const apiConfigurationPath = join(directory, "api-installation.yaml");
  const workerConfigurationPath = join(directory, "worker-installation.yaml");
  const codexServiceAccountImport =
    pluginDriverId === "codex-plugin"
      ? await codexServiceAccountImportConfiguration(directory, codexCredential)
      : undefined;
  await Promise.all([
    writeFile(
      apiConfigurationPath,
      JSON.stringify(
        installationConfiguration({
          authentication: api.authentication,
          platformNamespace,
          gatewayImage,
          codexImage,
          pluginDriverId,
          codexServiceAccountImport,
        }),
      ),
      { mode: 0o600 },
    ),
    writeFile(
      workerConfigurationPath,
      JSON.stringify(
        installationConfiguration({
          authentication: workerIdentity.authentication,
          platformNamespace,
          gatewayImage,
          codexImage,
          pluginDriverId,
          codexServiceAccountImport,
        }),
      ),
      { mode: 0o600 },
    ),
  ]);

  const [
    { PostgresPlatformState },
    { createPostgresControllerAuth },
    { loadInstallationConfiguration },
    { composeProduction },
    { createControllerWorker },
    { kubernetesNamespaceName },
  ] = await Promise.all([
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../apps/controller/src/auth/index.ts"),
    import("../../apps/controller/src/composition/installation-config.ts"),
    import("../../apps/controller/src/composition/production.ts"),
    import("../../apps/controller/src/worker.ts"),
    import("../../apps/controller/src/drivers/compute/kubernetes/index.ts"),
  ]);

  const [apiDrivers, workerDrivers] = await Promise.all([
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: apiConfigurationPath },
    }),
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: workerConfigurationPath },
    }),
  ]);
  assert.equal(apiDrivers.pluginDriver?.id, pluginDriverId);
  assert.equal(workerDrivers.pluginDriver?.id, pluginDriverId);

  const serviceAccountDriverFactory =
    codexServiceAccountImport === undefined
      ? undefined
      : createImportedCodexServiceAccountDriverFactory(
          codexServiceAccountImport,
          apiDrivers.computeDriver,
        );

  pool = new pg.Pool({ connectionString: selectedDatabaseUrl, max: 4 });
  const state = new PostgresPlatformState(pool);
  const existing = await state.loadInstallation();
  let serviceKey;
  if (existing !== undefined) {
    assert.equal(
      existing.name,
      `Plugin Driver real proof ${pluginDriverId}`,
      "refusing to modify a database Installation not owned by this disposable proof",
    );
    const auth = await createPostgresControllerAuth({
      mode: "production",
      installationId: existing.id,
      secret: authSecret,
      baseURL: authBaseURL,
      pool,
    });
    const servicePrincipal = installationAdministratorServicePrincipal(
      await state.loadNativeIAMState(existing.id),
    );
    serviceKey = (
      await auth.createServiceKey({
        principal: servicePrincipal,
        name: `plugin-driver-real-proof-${suffix}`,
      })
    ).key;
  } else {
    const bootstrap = await ensureDevelopmentBootstrap(context, {
      databaseUrl: selectedDatabaseUrl,
      email: credentials.email,
      password: credentials.password,
      authSecret,
      authBaseURL,
      installationName: `Plugin Driver real proof ${pluginDriverId}`,
    });
    serviceKey = await bootstrapServiceKeyFromFile(
      bootstrap.environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE,
    );
  }

  app = await composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl: selectedDatabaseUrl,
    authSecret,
    authBaseURL,
    drivers: apiDrivers,
    ...(serviceAccountDriverFactory === undefined ? {} : { serviceAccountDriverFactory }),
  });
  const request = createServiceKeyControllerRequest(app, serviceKey);
  const events = [];
  worker = createControllerWorker({
    mode: "production",
    pool: new pg.Pool({ connectionString: selectedDatabaseUrl, max: 6 }),
    drivers: workerDrivers,
    pollIntervalMs: 50,
    leaseDurationMs: 60_000,
    maxAttempts: 30,
    emit: (event) => events.push(event),
  });
  await worker.start();

  const createdNamespace = await request("POST", "/namespaces", {
    name: `${proofPrefix}-${suffix}`,
  });
  assert.equal(createdNamespace.status, 201, JSON.stringify(createdNamespace.error));
  tenantNamespace = kubernetesNamespaceName(createdNamespace.data.id);
  await waitFor(`the worker to create ${tenantNamespace}`, async () => {
    try {
      return await resource("namespace", tenantNamespace);
    } catch (error) {
      if (/NotFound|not found/i.test(error.stderr ?? error.message)) return undefined;
      throw error;
    }
  });
  for (const identity of [api, workerIdentity]) {
    await kubectl(
      "create",
      "rolebinding",
      `${proofPrefix}-${identity.account}`,
      "--namespace",
      tenantNamespace,
      `--clusterrole=${proofPrefix}-tenant-${suffix}`,
      `--serviceaccount=${platformNamespace}:${identity.account}`,
    );
  }
  await kubectl(
    "create",
    "rolebinding",
    `${proofPrefix}-api-secrets`,
    "--namespace",
    tenantNamespace,
    `--clusterrole=${proofPrefix}-secrets-${suffix}`,
    `--serviceaccount=${platformNamespace}:${api.account}`,
  );

  const agentApi = createAgentPluginApi({ request, namespaceId: createdNamespace.data.id });

  async function createCodexServiceAccountFromToken({ accessToken, name }) {
    assert.ok(
      serviceAccountDriverFactory,
      "Codex ServiceAccounts require the configured test import ServiceAccount Driver.",
    );
    assert.ok(
      accessToken === codexServiceAccountImport.accessToken,
      "Codex ServiceAccount import must use the configured existing test credential.",
    );
    const account = await request(
      "POST",
      `/namespaces/${createdNamespace.data.id}/service-accounts`,
      { name },
    );
    assert.equal(account.status, 201, JSON.stringify(account.error));
    const binding = await pool.query(
      `SELECT external_account_id, workspace_id, provider_id, driver_id
       FROM occ.service_account_driver_bindings
       WHERE namespace_id = $1 AND service_account_id = $2`,
      [createdNamespace.data.id, account.data.id],
    );
    assert.equal(binding.rowCount, 1, "ServiceAccount creation must persist provider binding.");
    assert.equal(binding.rows[0].external_account_id, `imported-${account.data.id}`);
    assert.equal(binding.rows[0].workspace_id, codexServiceAccountImport.workspaceId);
    assert.equal(binding.rows[0].provider_id, "openai");
    assert.equal(binding.rows[0].driver_id, "chatgpt-service-accounts");

    const issued = await request(
      "POST",
      `/namespaces/${createdNamespace.data.id}/service-accounts/${account.data.id}/credentials`,
      {},
    );
    assert.equal(issued.status, 201, JSON.stringify(issued.error));
    assert.equal(issued.data.credential.kind, "access_token");
    assertNoSecretMaterial(
      issued,
      [accessToken, codexServiceAccountImport.workspaceId],
      "service-account responses must not expose imported credential values.",
    );
    return issued.data;
  }

  async function deployAndWait(agent) {
    let gatewayToken = gatewayTokens.get(agent.id);
    if (gatewayToken === undefined) {
      gatewayToken = await provisionAgentTransportSecret(directory, tenantNamespace, agent.id);
      gatewayTokens.set(agent.id, gatewayToken);
    }
    const deployed = await request(
      "POST",
      `/namespaces/${createdNamespace.data.id}/agents/${agent.id}/deploy`,
    );
    assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
    await waitFor(`revision ${deployed.data.id} activation`, async () => {
      const observed = await request(
        "GET",
        `/namespaces/${createdNamespace.data.id}/agents/${agent.id}`,
      );
      assert.equal(observed.status, 200, JSON.stringify(observed.error));
      return observed.data.activeRevisionId === deployed.data.id ? observed.data : undefined;
    });
    await waitForPluginProofWorkerSuccess(waitFor, events, deployed.data.id, {
      description: `worker completion of ${deployed.data.id}`,
      diagnostics: () => sanitizedPluginProofWorkerEvents(events, deployed.data.id),
    });
    return { revision: deployed.data, gatewayToken };
  }

  async function gatewayPod(agent) {
    const pods = (await resources("pods", tenantNamespace)).filter(
      (pod) => pod.metadata.labels?.["openclaw.dev/agent"] === agent.id,
    );
    assert.ok(pods.length > 0, "the exact Agent must have running workload Pods to inspect.");
    const prefix = `gateway-${hash(agent.id)}`;
    const pod = pods.find((candidate) => candidate.metadata.name?.startsWith(prefix));
    assert.ok(pod, `the exact Agent gateway Pod ${prefix} must be running.`);
    return pod;
  }

  const nativeAssertions = createNativePluginAssertions({
    proofMode: pluginDriverId === "codex-plugin" ? "codex" : "openclaw",
    gatewayUrl: async (agent) => {
      const forwarding = await startPortForward(tenantNamespace, `gateway-${hash(agent.id)}`);
      forwarders.push(forwarding);
      return { url: forwarding.url };
    },
    execGateway: async (agent, argv) => {
      const pod = await gatewayPod(agent);
      return {
        label: pod.metadata.name,
        stdout: await kubectl(
          "exec",
          pod.metadata.name,
          "--namespace",
          tenantNamespace,
          "--",
          ...argv,
        ),
      };
    },
  });

  async function materializeOpenAIModelSecret(agentId) {
    const key = requiredPluginProofEnv("OPENAI_API_KEY", "OpenClaw embedded model credential");
    await createOperatorSecret(
      kubectlArguments,
      tenantNamespace,
      `openclaw-agent-model-${hash(agentId)}`,
      { OPENAI_API_KEY: key },
    );
    return key;
  }

  return {
    namespaceId: createdNamespace.data.id,
    tenantNamespace,
    request,
    events,
    pool,
    kubectl,
    resource,
    waitFor,
    createAgent: agentApi.createAgent,
    createCodexServiceAccountFromToken,
    selectPlugin: agentApi.selectPlugin,
    updatePluginPolicy: agentApi.updatePluginPolicy,
    removePluginSelection: agentApi.removePluginSelection,
    getAgent: agentApi.getAgent,
    deployAndWait,
    normalGatewayTurn: nativeAssertions.normalGatewayTurn,
    assertSessionToolCallEvidence: nativeAssertions.assertSessionToolCallEvidence,
    assertNoSessionToolCallEvidence: nativeAssertions.assertNoSessionToolCallEvidence,
    materializeOpenAIModelSecret,
  };
}

export async function readCodexServiceAccountCredential() {
  const accessToken = requiredPluginProofEnv(
    "CODEX_ACCESS_TOKEN",
    "Codex service-account access token",
  );
  const workspaceId = await deriveCodexWorkspaceId(accessToken);
  return { accessToken, workspaceId };
}
