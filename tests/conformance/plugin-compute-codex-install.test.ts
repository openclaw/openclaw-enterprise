import assert from "node:assert/strict";
import test from "node:test";
import { types } from "node:util";

import { pluginRuntimeSpecForRevision } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  admitLoggingConfiguration,
  CODEX_PLUGIN_DRIVER_IMPLEMENTATION,
  type AgentRevision,
  type PluginDesiredSelection,
  type PluginRevisionState,
  type PluginReviewer,
  type PluginToolDefaults,
} from "../../packages/contracts/src/index.ts";
import { MAX_TIMER_DELAY_MS } from "../../packages/utils/src/index.ts";
import {
  CODEX_LINEAR_APP_ID,
  CODEX_LINEAR_NATIVE_ID,
  CODEX_LINEAR_REMOTE_ID,
  CODEX_LINEAR_VERSION,
  codexApiKeyDisabledResponses,
  codexConfigReadResponse,
  codexReadResponse,
  codexRequestDispatcher,
  codexSearchResponse,
  readCodexRuntimeTimers,
  runCodexRuntimeHelper,
  type CodexAppPolicies,
  type CodexAppPolicy,
  type CodexPluginPolicies,
  type CodexPluginPolicy,
} from "../helpers/codex-runtime-helper-fixture.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";

const CODEX_ASANA_NATIVE_ID = "asana@openai-curated-remote";
const CODEX_ASANA_REMOTE_ID = "plugin_asdk_app_asana";
const CODEX_ASANA_APP_ID = "asdk_app_asana";

function revision(plugins: PluginRevisionState): AgentRevision {
  const namespaceId = "ns_00000000-0000-4000-8000-000000000016";
  const native = createHarnessConfiguration("codex", "gpt-4.1");
  const { auth: _auth, ...gateway } = native.gateway;
  return {
    id: "revision-plugin-compute-1",
    executionAdmission: { version: 2, mode: "unprotected" },
    namespaceId,
    agentId: "agent-plugin-compute",
    revision: 1,
    backendId: null,
    configurationId: "cfg_00000000-0000-4000-8000-000000000016",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: true,
    configuration: admitLoggingConfiguration({ ...native, gateway }, "info"),
    harnessAuth: {
      method: "api_key",
      source: {
        kind: "secret",
        namespaceId,
        id: "sec_00000000-0000-4000-8000-000000000016",
      },
      secretDriverId: "secret-kubernetes",
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated", overrides: {}, configuration: {} },
    compute: { id: "compute-kubernetes", implementation: "kubernetes" },
    servicePrincipalId: "service-principal-plugin-compute",
    secretDriverId: "secret-kubernetes",
    createdAt: "2026-09-08T00:00:00.000Z",
    plugins,
  };
}

function codexPluginState(plugins: PluginRevisionState["plugins"]): PluginRevisionState {
  return {
    driver: { id: "codex-plugin", implementation: CODEX_PLUGIN_DRIVER_IMPLEMENTATION },
    plugins,
  };
}

function codexLinearPluginState(
  overrides: Partial<PluginDesiredSelection> = {},
): PluginRevisionState {
  return codexPluginState({
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
      ...overrides,
    },
  });
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

type CodexPluginRequestParams = { remoteMarketplaceName: string; pluginName: string };

type CodexConfigEdit = { mergeStrategy: "replace" } & (
  | { keyPath: "apps"; value: CodexAppPolicies }
  | { keyPath: "plugins"; value: CodexPluginPolicies }
  | { keyPath: `features.${string}` | `apps.${string}`; value: boolean | string }
);

function configEdits(params: unknown): readonly CodexConfigEdit[] {
  assert.ok(params !== null && typeof params === "object" && "edits" in params);
  const edits: unknown = params.edits;
  assert.ok(Array.isArray(edits));
  return edits as readonly CodexConfigEdit[];
}

type ReviewerScenario = {
  name: string;
  reviewer?: PluginReviewer | null;
  app?: CodexAppPolicy;
  config?: {
    approval_policy?: "never" | "untrusted" | { granular: Record<string, boolean> };
    model?: string | null;
  };
  requirements?: {
    allowedApprovalsReviewers?: readonly string[] | null;
    autoReview?: { requiredOnModels: readonly string[] };
  };
  response?: object;
  error?: RegExp;
};

type EffectivePolicyScenario = {
  name: string;
  defaults?: PluginToolDefaults;
  driverPolicy?: { destructiveEnabled: boolean };
  app?: CodexAppPolicy;
  workspaceApp?: CodexAppPolicy;
  global?: CodexAppPolicy;
  otherApps?: Record<string, CodexAppPolicy>;
  tools?: CodexAppPolicy["tools"];
  links?: CodexAppPolicy["links"];
  nativeApproval?: CodexAppPolicy["default_tools_approval_mode"];
  rejects?: boolean;
  error?: RegExp;
};

function assertStartupError(error: unknown): asserts error is Error & {
  startupCode?: unknown;
  diagnostic?: unknown;
} {
  assert.ok(types.isNativeError(error));
}

test("Codex runtime skips the plugin API when no plugins are selected", async () => {
  // A no-plugin Agent must reach readiness without the Codex plugin API, which a Sandbox
  // workload may not be able to reach. Salvaged from #146 by @sallyom.
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(codexPluginState({}))),
  };
  const { requests, sockets } = await runCodexRuntimeHelper(runtime, (method) => {
    throw new Error(`unexpected request ${method}`);
  });

  assert.deepEqual(requests, []);
  assert.deepEqual(sockets, []);
});

test("Codex runtime helper installs a plugin with skills and applies write action approval without tool inventory", async () => {
  const state = codexLinearPluginState({
    toolDefaults: { approval: "write_actions", reviewer: "auto" },
  });
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(state)),
  };
  let readCount = 0;
  const handleRequest = codexRequestDispatcher({
    initialize: () => ({ serverInfo: { name: "codex", version: "0.149.0" } }),
    "plugin/search": (params) => {
      assert.deepEqual(params, { searchTerm: "linear", scope: "global", limit: 100 });
      return codexSearchResponse();
    },
    "plugin/read": (params) => {
      assert.deepEqual(params, {
        remoteMarketplaceName: "openai-curated-remote",
        pluginName: CODEX_LINEAR_REMOTE_ID,
      });
      readCount += 1;
      return codexReadResponse({
        installed: readCount > 1,
        enabled: readCount > 2,
        skills: [{ name: "linear-workflow" }],
        // Template-only IDs must not enter the concrete app policy written below.
        appTemplates: [
          {
            templateId: "workspace_template",
            name: "Workspace app",
            materializedAppIds: ["template_only_app"],
            reason: null,
          },
        ],
      });
    },
    "config/batchWrite": (params) => {
      if (configEdits(params).length === 1) {
        assert.deepEqual(params, {
          edits: [
            {
              keyPath: "plugins",
              mergeStrategy: "replace",
              value: {
                _default: { enabled: false },
                [CODEX_LINEAR_NATIVE_ID]: { enabled: true },
              },
            },
          ],
          reloadUserConfig: true,
        });
        return { status: "ok", version: "selected-plugins" };
      }
      assert.deepEqual(params, {
        edits: [
          { keyPath: "features.apps", mergeStrategy: "replace", value: true },
          { keyPath: "features.plugins", mergeStrategy: "replace", value: true },
          { keyPath: "features.remote_plugin", mergeStrategy: "replace", value: true },
          {
            keyPath: "apps",
            mergeStrategy: "replace",
            value: {
              _default: { enabled: false },
              [CODEX_LINEAR_APP_ID]: {
                enabled: true,
                default_tools_approval_mode: "writes",
                approvals_reviewer: "auto_review",
              },
            },
          },
          {
            keyPath: "plugins",
            mergeStrategy: "replace",
            value: {
              _default: { enabled: false },
              [CODEX_LINEAR_NATIVE_ID]: { enabled: true },
            },
          },
        ],
        reloadUserConfig: true,
      });
      return { status: "ok", version: "test-config-1" };
    },
    "plugin/install": (params) => {
      assert.deepEqual(params, {
        remoteMarketplaceName: "openai-curated-remote",
        pluginName: CODEX_LINEAR_REMOTE_ID,
      });
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    },
    "config/read": (params) => {
      assert.deepEqual(params, { cwd: "/home/node/workspace" });
      return codexConfigReadResponse({
        default_tools_approval_mode: "writes",
        approvals_reviewer: "auto_review",
      });
    },
    "configRequirements/read": (params) => {
      assert.deepEqual(params, {});
      return { requirements: null };
    },
  });
  const { requests, sockets } = await runCodexRuntimeHelper(runtime, handleRequest);

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "plugin/search",
      "initialize",
      "plugin/read",
      "initialize",
      "config/batchWrite",
      "initialize",
      "plugin/install",
      "initialize",
      "plugin/read",
      "initialize",
      "config/read",
      "initialize",
      "config/batchWrite",
      "initialize",
      "plugin/read",
      "initialize",
      "config/read",
      "initialize",
      "configRequirements/read",
    ],
  );
  assert.equal(
    sockets.every(
      (socket) => socket.options.headers.Authorization === "Bearer capability-token-test-value",
    ),
    true,
  );
});

test("Codex startup explicitly denies inherited apps and replaces inherited approval exceptions", async () => {
  const state = codexLinearPluginState({ toolDefaults: { approval: "all_actions" } });
  const runtime = { manifest: pluginRuntimeSpecForRevision(revision(state)) };
  let written = false;
  const result = await runCodexRuntimeHelper(
    runtime,
    codexRequestDispatcher({
      initialize: () => ({ serverInfo: { name: "codex", version: "0.158.0" } }),
      "plugin/search": () => codexSearchResponse(),
      "plugin/read": () => codexReadResponse(),
      "plugin/install": () => ({ authPolicy: "ON_USE", appsNeedingAuth: [] }),
      "config/read": () => {
        // A lower-priority config can contribute an app through tool preferences.
        // Native AppConfig defaults its enabled field to true despite _default=false.
        const response = codexConfigReadResponse({
          default_tools_approval_mode: "prompt",
          tools: { "read issue": { enabled: null, approval_mode: written ? "prompt" : "approve" } },
          links: { account: { default_tools_approval_mode: written ? "prompt" : "approve" } },
        });
        response.config.apps.unselected = {
          enabled: !written,
          tools: { read: { approval_mode: "approve" } },
        };
        return response;
      },
      "config/batchWrite": (params) => {
        const config = configEdits(params);
        if (!config.some((edit) => edit.keyPath === "apps")) {
          return { status: "ok", version: "selected-plugins" };
        }
        const edits = new Map(config.map(({ keyPath, value }) => [keyPath, value] as const));
        assert.equal(edits.get("apps.unselected.enabled"), false);
        assert.equal(
          edits.get(`apps.${CODEX_LINEAR_APP_ID}.tools."read issue".approval_mode`),
          "prompt",
        );
        assert.equal(
          edits.get(`apps.${CODEX_LINEAR_APP_ID}.links.account.default_tools_approval_mode`),
          "prompt",
        );
        assert.equal(
          edits.has(`apps.${CODEX_LINEAR_APP_ID}.tools."read issue".enabled`),
          false,
          "approval repair must not bypass annotation-based tool enablement",
        );
        written = true;
        return { status: "ok", version: "selection-policy" };
      },
    }),
  );
  assert.equal(written, true);
  assert.equal(result.error, undefined);
  assert.ok(result.value);
  assert.deepEqual(plain(result.value.failures), []);
});

test("Codex runtime helper verifies explicit reviewers before readiness without constraining omission", async (t) => {
  const scenarios: readonly ReviewerScenario[] = [
    {
      name: "auto with never",
      config: { approval_policy: "never" },
      error: /requires session approval/,
    },
    {
      name: "auto with untrusted",
      config: { approval_policy: "untrusted" },
      error: /requires session approval/,
    },
    {
      name: "auto with granular",
      config: {
        approval_policy: {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: true,
            request_permissions: true,
            mcp_elicitations: true,
          },
        },
      },
    },
    {
      name: "managed reviewer exclusion",
      requirements: { allowedApprovalsReviewers: ["user"] },
      error: /managed requirements forbid/,
    },
    {
      name: "required model conflicts with human",
      reviewer: "human",
      app: { approvals_reviewer: "user" },
      config: { model: "provider/test-model" },
      requirements: { autoReview: { requiredOnModels: ["test-model"] } },
      error: /managed model requirements/,
    },
    {
      name: "unknown model cannot verify human",
      reviewer: "human",
      app: { approvals_reviewer: "user" },
      config: { model: null },
      requirements: { autoReview: { requiredOnModels: ["test-model"] } },
      error: /managed model requirements/,
    },
    {
      name: "unrelated requirements allow human",
      reviewer: "human",
      app: { approvals_reviewer: "user" },
      requirements: {
        allowedApprovalsReviewers: null,
        autoReview: { requiredOnModels: ["other-model"] },
      },
    },
    {
      name: "account reviewer conflicts",
      app: { links: { account: { approvals_reviewer: "user" } } },
      error: /effective app or account reviewer conflicts/,
    },
    {
      name: "app reviewer conflicts",
      app: { approvals_reviewer: "user" },
      error: /effective app or account reviewer conflicts/,
    },
    {
      name: "malformed requirements response",
      response: {},
      error: /reviewer requirements are unavailable/,
    },
    {
      name: "malformed reviewer allowlist",
      requirements: { allowedApprovalsReviewers: ["human"] },
      error: /reviewer requirements are invalid/,
    },
    {
      name: "omitted reviewer preserves native configuration",
      reviewer: null,
      config: { approval_policy: "never" },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const reviewer = scenario.reviewer === undefined ? "auto" : scenario.reviewer;
      const state = codexLinearPluginState({
        ...(reviewer === null ? {} : { toolDefaults: { reviewer } }),
      });
      const runtime = { manifest: pluginRuntimeSpecForRevision(revision(state)) };
      const result = await runCodexRuntimeHelper(
        runtime,
        codexRequestDispatcher({
          initialize: () => ({ serverInfo: { name: "codex", version: "0.156.0" } }),
          "plugin/search": () => codexSearchResponse(),
          "plugin/read": () => codexReadResponse(),
          "plugin/install": () => ({ authPolicy: "ON_USE", appsNeedingAuth: [] }),
          "config/batchWrite": () => ({ status: "ok", version: "reviewer-config" }),
          "config/read": () => {
            const response = codexConfigReadResponse({
              approvals_reviewer: "auto_review",
              ...scenario.app,
            });
            return { config: { ...response.config, ...scenario.config }, origins: {} };
          },
          "configRequirements/read": (params) => {
            assert.deepEqual(params, {});
            return scenario.response ?? { requirements: scenario.requirements ?? null };
          },
        }),
        { captureError: true },
      );
      if (scenario.error) {
        assertStartupError(result.error);
        assert.match(result.error.message, scenario.error);
        assert.equal(result.value, undefined, "unverifiable reviewer must prevent readiness");
      } else {
        assert.equal(result.error, undefined);
        assert.deepEqual(plain(result.value), {
          successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
          failures: [],
        });
      }
      if (reviewer === null) {
        assert.equal(
          result.requests.some(({ method }) => method === "configRequirements/read"),
          false,
        );
      }
    });
  }
});

test("Codex runtime helper discovers tool policy after installation and before readiness", async () => {
  const state = codexLinearPluginState({
    toolDefaults: { enabled: false, approval: "all_actions", reviewer: "human" },
    tools: { [CODEX_LINEAR_APP_ID + "/list_issues"]: { enabled: true, approval: "none" } },
  });
  const runtime = { manifest: pluginRuntimeSpecForRevision(revision(state)) };
  let apps: CodexAppPolicies | undefined;
  let plugins: CodexPluginPolicies | undefined;
  let installed = false;
  const { requests } = await runCodexRuntimeHelper(
    runtime,
    codexRequestDispatcher({
      initialize: () => ({ serverInfo: { name: "codex", version: "0.156.0" } }),
      "plugin/search": () => codexSearchResponse(),
      "plugin/read": () => {
        return codexReadResponse({
          installed,
          enabled: plugins?.[CODEX_LINEAR_NATIVE_ID]?.enabled === true,
        });
      },
      "plugin/install": () => {
        installed = true;
        return { authPolicy: "ON_USE", appsNeedingAuth: [] };
      },
      "mcpServerStatus/list": (params) => {
        assert.equal(installed, true, "tool discovery follows native installation");
        assert.equal(apps, undefined, "tool inventory precedes app grants");
        const { detail, cursor } = params as { detail: string; cursor?: string };
        assert.equal(detail, "toolsAndAuthOnly");
        if (cursor === undefined) {
          return { data: [{ name: "unrelated", tools: {} }], nextCursor: "apps-page" };
        }
        assert.equal(cursor, "apps-page");
        return {
          data: [
            {
              name: "codex_apps",
              toolsError: null,
              tools: {
                list_issues: {
                  name: "list_issues",
                  inputSchema: { type: "object" },
                  _meta: { connector_id: CODEX_LINEAR_APP_ID },
                  annotations: { readOnlyHint: true, destructiveHint: false },
                },
                create_issue: {
                  name: "create_issue",
                  inputSchema: { type: "object" },
                  _meta: { connector_id: CODEX_LINEAR_APP_ID },
                  annotations: { readOnlyHint: false, destructiveHint: false },
                },
              },
            },
          ],
          nextCursor: null,
        };
      },
      "config/batchWrite": (params) => {
        for (const edit of configEdits(params)) {
          if (edit.keyPath === "apps") {
            apps = edit.value;
          }
          if (edit.keyPath === "plugins") {
            plugins = edit.value;
          }
        }
        assert.deepEqual(plugins, {
          _default: { enabled: false },
          [CODEX_LINEAR_NATIVE_ID]: { enabled: true },
        });
        if (apps === undefined) {
          return { status: "ok", version: "selected-plugins" };
        }
        assert.equal(apps._default.enabled, false, "discovery must not grant unselected apps");
        assert.equal(
          apps[CODEX_LINEAR_APP_ID]?.enabled,
          true,
          "the tool exception keeps the app enabled",
        );
        const app = apps[CODEX_LINEAR_APP_ID];
        assert.ok(app?.tools);
        assert.equal(app.tools.list_issues?.enabled, true);
        assert.equal(app.tools.list_issues?.approval_mode, "approve");
        assert.equal(app.default_tools_enabled, false);
        assert.equal(app.default_tools_approval_mode, "prompt");
        assert.equal(app.tools.create_issue, undefined);
        return { status: "ok", version: "tool-policy" };
      },
      "config/read": () => ({ config: { ...codexConfigReadResponse().config, apps, plugins } }),
      "configRequirements/read": (params) => {
        assert.deepEqual(params, {});
        return { requirements: null };
      },
    }),
  );
  assert.deepEqual(
    requests.filter(({ method }) => method === "mcpServerStatus/list").map(({ params }) => params),
    [{ detail: "toolsAndAuthOnly" }, { detail: "toolsAndAuthOnly", cursor: "apps-page" }],
  );
  assert.equal(
    requests.filter(
      ({ method, params }) =>
        method === "config/batchWrite" &&
        configEdits(params).some((edit) => edit.keyPath === "apps"),
    ).length,
    1,
  );
});

test("Codex runtime helper rejects incomplete or unbounded tool discovery before writing app policy", async (t) => {
  const scenarios: readonly (readonly [string, (page: number) => unknown, RegExp])[] = [
    ["invalid data", () => ({ data: {}, nextCursor: null }), /invalid pagination data/],
    ["invalid cursor", () => ({ data: [], nextCursor: 1 }), /invalid pagination data/],
    ["repeated cursor", () => ({ data: [], nextCursor: "repeat" }), /repeated cursor/],
    ["page limit", (page) => ({ data: [], nextCursor: String(page) }), /page limit/],
    [
      "native discovery error",
      () => ({
        data: [{ name: "codex_apps", tools: {}, toolsError: "tool listing failed" }],
        nextCursor: null,
      }),
      /tool inventory is unavailable/,
    ],
  ];
  for (const [name, response, expected] of scenarios) {
    await t.test(name, async () => {
      // Keep startup time deterministic until the intended discovery failure.
      // Advancing there prevents a retry without racing the fixture's 25 ms budget.
      let now = 0;
      class FixtureDate extends Date {
        static override now() {
          return now;
        }
      }
      const state = codexLinearPluginState({
        tools: { [CODEX_LINEAR_APP_ID + "/list_issues"]: { enabled: false } },
      });
      const runtime = { manifest: pluginRuntimeSpecForRevision(revision(state)) };
      let page = 0;
      const result = await runCodexRuntimeHelper(
        runtime,
        codexRequestDispatcher({
          initialize: () => ({ serverInfo: { name: "codex", version: "0.156.0" } }),
          "plugin/search": () => codexSearchResponse(),
          "plugin/read": () => codexReadResponse(),
          "plugin/install": () => ({ authPolicy: "ON_USE", appsNeedingAuth: [] }),
          "config/batchWrite": () => ({ status: "ok", version: "selected-plugins" }),
          "mcpServerStatus/list": () => {
            now = 25;
            return response(page++);
          },
        }),
        { captureError: true, Date: FixtureDate },
      );
      assertStartupError(result.error);
      assert.match(result.error.message, expected);
      assert.equal(
        result.requests.some(
          ({ method, params }) =>
            method === "config/batchWrite" &&
            configEdits(params).some((edit) => edit.keyPath === "apps"),
        ),
        false,
      );
    });
  }
});

test("Codex runtime helper reports plugin install warnings without retrying", async () => {
  const state = codexLinearPluginState({
    toolDefaults: { approval: "provider_default", reviewer: "auto" },
  });
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(state)),
  };
  let readCount = 0;
  const result = await runCodexRuntimeHelper(
    runtime,
    codexRequestDispatcher({
      initialize: () => ({ serverInfo: { name: "codex", version: "0.149.0" } }),
      "plugin/search": () => codexSearchResponse(),
      "plugin/read": () => {
        readCount += 1;
        return codexReadResponse({ installed: readCount > 1, enabled: readCount > 1 });
      },
      "config/batchWrite": () => ({ status: "ok", version: "test-config-1" }),
      "plugin/install": () => {
        throw new Error("native install rejected");
      },
      "config/read": () => {
        // Native layers may retain overrides, but app disablement blocks every tool.
        return codexConfigReadResponse(
          {
            enabled: false,
            default_tools_enabled: true,
            tools: { list_issues: { enabled: true, approval_mode: "approve" } },
            links: { account: { default_tools_approval_mode: "approve" } },
          },
          false,
        );
      },
    }),
    {
      env: {
        OPENCLAW_PLUGIN_STATUS_PORT: "18791",
      },
    },
  );

  assert.deepEqual(plain(result.value), {
    successfulPluginIds: [],
    failures: [
      {
        pluginId: "codex-plugin:linear@openai-curated-remote",
        code: "PLUGIN_INSTALL_FAILED",
      },
    ],
  });
  assert.equal(result.requests.filter((request) => request.method === "plugin/install").length, 1);
  const write = result.requests.find(
    (request) =>
      request.method === "config/batchWrite" &&
      configEdits(request.params).some((edit) => edit.keyPath === "apps"),
  );
  assert.ok(write);
  assert.deepEqual(
    configEdits(write.params).find((edit) => edit.keyPath === "apps")?.value[CODEX_LINEAR_APP_ID],
    { enabled: false },
  );
  assert.deepEqual(configEdits(write.params).find((edit) => edit.keyPath === "plugins")?.value, {
    _default: { enabled: false },
    [CODEX_LINEAR_NATIVE_ID]: { enabled: false },
  });
});

test("Codex runtime helper reports connector-auth warnings with the admitted key", async () => {
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(
      revision(
        codexPluginState({
          "linear@openai-curated-remote": {
            enabled: true,
            toolDefaults: { approval: "provider_default" },
          },
        }),
      ),
    ),
  };
  let pluginEnabled = false;
  const result = await runCodexRuntimeHelper(
    runtime,
    codexRequestDispatcher({
      initialize: () => ({ serverInfo: { name: "codex", version: "0.149.0" } }),
      "plugin/search": () => codexSearchResponse(),
      "plugin/read": () => codexReadResponse(),
      "config/batchWrite": (params) => {
        pluginEnabled =
          configEdits(params).find((edit) => edit.keyPath === "plugins")?.value[
            CODEX_LINEAR_NATIVE_ID
          ]?.enabled === true;
        return { status: "ok", version: "test-config-1" };
      },
      "plugin/install": () => {
        return {
          authPolicy: "ON_USE",
          appsNeedingAuth: pluginEnabled
            ? [
                {
                  id: CODEX_LINEAR_APP_ID,
                  name: "Linear",
                  category: null,
                },
              ]
            : [],
        };
      },
      "config/read": () => codexConfigReadResponse({ enabled: false }, false),
    }),
    {
      env: {
        OPENCLAW_PLUGIN_STATUS_PORT: "18791",
      },
    },
  );

  assert.deepEqual(plain(result.value), {
    successfulPluginIds: [],
    failures: [{ pluginId: "linear@openai-curated-remote", code: "PLUGIN_AUTH_REQUIRED" }],
  });
  assert.equal(pluginEnabled, false, "auth failures revoke the startup plugin grant");
});

test("Codex runtime helper disables curated plugins at once under API-key login", async () => {
  // Codex rejects the remote catalog for API-key logins, so a selected plugin
  // can never install: report it and serve without plugins instead of retrying.
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(
      revision(
        codexPluginState({
          "codex-plugin:linear@openai-curated-remote": {
            enabled: true,
            toolDefaults: { approval: "provider_default" },
          },
          "codex-plugin:slack@openai-curated-remote": { enabled: false },
        }),
      ),
    ),
  };
  const result = await runCodexRuntimeHelper(
    runtime,
    codexRequestDispatcher(codexApiKeyDisabledResponses()),
    { env: { CODEX_LOGIN_MODE: "api_key", OPENCLAW_PLUGIN_STATUS_PORT: "18791" } },
  );

  assert.deepEqual(plain(result.value), {
    successfulPluginIds: [],
    failures: [
      { pluginId: "codex-plugin:linear@openai-curated-remote", code: "PLUGIN_AUTH_REQUIRED" },
    ],
  });
  const calls = result.requests.filter((request) => request.method !== "initialize");
  assert.deepEqual(
    calls.map((request) => request.method),
    ["config/read", "config/batchWrite", "config/read"],
  );
  assert.deepEqual(configEdits(calls[1]?.params), [
    { keyPath: "features.apps", mergeStrategy: "replace", value: false },
    { keyPath: "features.plugins", mergeStrategy: "replace", value: false },
    { keyPath: "features.remote_plugin", mergeStrategy: "replace", value: false },
    { keyPath: "apps", mergeStrategy: "replace", value: { _default: { enabled: false } } },
    { keyPath: "plugins", mergeStrategy: "replace", value: { _default: { enabled: false } } },
  ]);

  const strict = await runCodexRuntimeHelper(
    runtime,
    (method) => {
      throw new Error(`unexpected request ${method}`);
    },
    { env: { CODEX_LOGIN_MODE: "api_key" }, captureError: true },
  );
  assertStartupError(strict.error);
  assert.match(strict.error.message, /require a ChatGPT login/);
  assert.deepEqual(strict.requests, []);
});

test("Codex runtime helper waits for a late app-server before disabling API-key plugin selections", async () => {
  // D320: the Harness reached plugin setup before the Codex app-server accepted
  // connections; a single attempt failed the transport and restarted Codex forever.
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(codexLinearPluginState())),
  };
  const handler = codexRequestDispatcher(codexApiKeyDisabledResponses());
  const result = await runCodexRuntimeHelper(runtime, handler, {
    env: {
      CODEX_LOGIN_MODE: "api_key",
      OPENCLAW_PLUGIN_STATUS_PORT: "18791",
      OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "5000",
    },
    refusedConnections: 2,
  });
  assert.equal(result.sockets.length, 5);
  assert.deepEqual(plain(result.value), {
    successfulPluginIds: [],
    failures: [
      { pluginId: "codex-plugin:linear@openai-curated-remote", code: "PLUGIN_AUTH_REQUIRED" },
    ],
  });
  assert.deepEqual(
    result.requests
      .filter((request) => request.method !== "initialize")
      .map((request) => request.method),
    ["config/read", "config/batchWrite", "config/read"],
  );

  const neverReady = await runCodexRuntimeHelper(runtime, handler, {
    env: { CODEX_LOGIN_MODE: "api_key", OPENCLAW_PLUGIN_STATUS_PORT: "18791" },
    refusedConnections: Number.POSITIVE_INFINITY,
    captureError: true,
  });
  assertStartupError(neverReady.error);
  assert.match(
    neverReady.error.message,
    /plugin disable did not reach readiness: .*transport failed/,
  );
  assert.equal(neverReady.error.startupCode, "PLUGIN_NOT_READY");
});

test("Codex runtime helper keeps malformed matching install responses generic", async (t) => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(state)),
  };
  const malformedResponses: readonly (readonly [string, (id: number | undefined) => unknown])[] = [
    ["malformed error object", (id) => ({ id, error: {} })],
    ["string error", (id) => ({ id, error: "native install rejected" })],
    [
      "result and error",
      (id) => ({
        id,
        result: { authPolicy: "ON_USE", appsNeedingAuth: [] },
        error: { code: -32000, message: "native install rejected" },
      }),
    ],
    ["null response", () => "null"],
    [
      "malformed apps needing auth",
      (id) => ({
        id,
        result: { authPolicy: "ON_USE", appsNeedingAuth: [{ id: CODEX_LINEAR_APP_ID }] },
      }),
    ],
  ];
  for (const [name, response] of malformedResponses) {
    await t.test(name, async () => {
      let now = 0;
      class FixtureDate extends Date {
        static override now() {
          return now;
        }
      }
      const result = await runCodexRuntimeHelper(
        runtime,
        codexRequestDispatcher({
          initialize: () => ({ serverInfo: { name: "codex", version: "0.149.0" } }),
          "plugin/search": () => codexSearchResponse(),
          "plugin/read": () => codexReadResponse(),
          "config/batchWrite": () => ({ status: "ok", version: "test-config-1" }),
          "plugin/install": (_params, requestId) => {
            now = 1;
            return { __rawMessage: response(requestId) };
          },
        }),
        {
          captureError: true,
          Date: FixtureDate,
          env: {
            OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "1",
          },
        },
      );

      assertStartupError(result.error);
      assert.equal(result.error.diagnostic, undefined);
      assert.ok(result.requests.some((request) => request.method === "plugin/install"));
    });
  }
});

// Number() read "12abc" as NaN, "" as 0 and 3e9 as a request timeout that fires after 1 ms
// (finding 2312). The install deadline shares the bound.
test("Codex runtime refuses request timeouts and install deadlines outside 1 to 2147483647 ms", () => {
  assert.deepEqual(readCodexRuntimeTimers({}), [10_000, 60_000]);
  for (const name of [
    "OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS",
    "OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS",
  ]) {
    const accepted = readCodexRuntimeTimers({ [name]: String(MAX_TIMER_DELAY_MS) });
    assert.ok(accepted.includes(MAX_TIMER_DELAY_MS), name);
    for (const value of ["12abc", "", "0", "-5", "1.5", "3e9", String(MAX_TIMER_DELAY_MS + 1)]) {
      assert.throws(
        () => readCodexRuntimeTimers({ [name]: value }),
        { message: `${name} must be 1 to 2147483647 ms.` },
        `${name}=${JSON.stringify(value)}`,
      );
    }
  }
});

test("Codex runtime cannot report installation success when its deadline expires before the first attempt", async () => {
  let now = 0;
  class FixtureDate extends Date {
    static override now() {
      return now++;
    }
  }
  const result = await runCodexRuntimeHelper(
    { manifest: pluginRuntimeSpecForRevision(revision(codexLinearPluginState())) },
    () => assert.fail("An expired installation must not contact the app-server"),
    {
      captureError: true,
      Date: FixtureDate,
      env: { OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "1" },
    },
  );
  assertStartupError(result.error);
  assert.match(result.error.message, /did not reach readiness/);
  assert.equal(result.value, undefined);
  assert.deepEqual(result.requests, []);
});

test("Codex selected-plugin search stops before writes or continuation when its budget expires", async (t) => {
  for (const matching of [false, true]) {
    await t.test(matching ? "late exact match" : "late continuation", async () => {
      let now = 0;
      class FixtureDate extends Date {
        static override now() {
          return now;
        }
      }
      let pages = 0;
      const result = await runCodexRuntimeHelper(
        { manifest: pluginRuntimeSpecForRevision(revision(codexLinearPluginState())) },
        (method) => {
          if (method === "initialize") {
            return {};
          }
          assert.equal(
            method,
            "plugin/search",
            "expired search must not reach installation or writes",
          );
          assert.equal(++pages, 1, "the client must not fetch a continuation after expiry");
          now = 25;
          // Neither a late exact match nor another page may outlive the installation budget.
          return matching
            ? codexSearchResponse()
            : {
                ...codexSearchResponse({ nativeId: "other@openai-curated-remote", name: "other" }),
                nextCursor: "continuation",
              };
        },
        { captureError: true, Date: FixtureDate },
      );
      assertStartupError(result.error);
      assert.match(result.error.message, /search deadline expired/);
      assert.equal(result.value, undefined);
      assert.equal(pages, 1);
    });
  }
});

test("Codex runtime helper keeps pre-install native uncertainty generic", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(state)),
  };
  const result = await runCodexRuntimeHelper(
    runtime,
    (method) => {
      if (method === "initialize") {
        return { serverInfo: { name: "codex", version: "0.149.0" } };
      }
      if (method === "plugin/search") {
        return codexSearchResponse();
      }
      if (method === "plugin/read") {
        throw new Error("catalog read unavailable");
      }
      throw new Error(`unexpected request ${method}`);
    },
    {
      captureError: true,
      env: {
        OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "1",
      },
    },
  );

  assertStartupError(result.error);
  assert.match(result.error.message, /did not reach readiness/);
  assert.equal(result.error.diagnostic, undefined);
  assert.equal(result.error.startupCode, "PLUGIN_NOT_READY");
});

test("Codex runtime keeps disabled selected plugins default-denied while preserving install identity", async () => {
  for (const [name, selectionOverride] of [["disabled", { enabled: false }]] as const) {
    const state = codexLinearPluginState(selectionOverride);
    const runtime = {
      manifest: pluginRuntimeSpecForRevision(revision(state)),
    };
    let readCount = 0;
    const installRequests: unknown[] = [];
    const { requests, value } = await runCodexRuntimeHelper(runtime, (method, params) => {
      if (method === "initialize") {
        return { serverInfo: { name: "codex", version: "0.149.0" } };
      }
      if (method === "plugin/search") {
        return codexSearchResponse();
      }
      if (method === "plugin/read") {
        readCount += 1;
        return codexReadResponse({ installed: readCount > 1, enabled: readCount > 1 });
      }
      if (method === "config/batchWrite") {
        assert.deepEqual(configEdits(params).find((edit) => edit.keyPath === "plugins")?.value, {
          _default: { enabled: false },
          [CODEX_LINEAR_NATIVE_ID]: { enabled: false },
        });
        return { status: "ok", version: `${name}-config-1` };
      }
      if (method === "plugin/install") {
        installRequests.push(params);
        return { authPolicy: "ON_USE", appsNeedingAuth: [] };
      }
      if (method === "config/read") {
        return {
          config: {
            features: { apps: true, plugins: true, remote_plugin: true },
            apps: { _default: { enabled: false } },
            plugins: {
              _default: { enabled: false },
              [CODEX_LINEAR_NATIVE_ID]: { enabled: false },
            },
          },
          origins: {},
        };
      }
      throw new Error(`unexpected request ${method}`);
    });

    assert.deepEqual(
      installRequests,
      selectionOverride.enabled === false
        ? []
        : [
            {
              remoteMarketplaceName: "openai-curated-remote",
              pluginName: CODEX_LINEAR_REMOTE_ID,
            },
          ],
    );
    assert.deepEqual(plain(value), {
      successfulPluginIds:
        selectionOverride.enabled === false ? [] : ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    });
    assert.equal(
      requests.some(
        (request) =>
          request.method === "config/batchWrite" &&
          configEdits(request.params).some(
            (edit) => edit.keyPath === "apps" && CODEX_LINEAR_APP_ID in edit.value,
          ),
      ),
      false,
    );

    const gatewayRuntime = {
      manifest: pluginRuntimeSpecForRevision(revision(state)),
    };
    const gateway = runOpenClawRuntimeHelper(gatewayRuntime, []);
    assert.ok("files" in gateway);
    const configuration: unknown = gateway.files.get("/home/node/.openclaw/openclaw.json");
    assert.ok(typeof configuration === "string");
    const effective = JSON.parse(configuration) as {
      plugins: {
        entries: {
          codex: {
            config: {
              codexPlugins: {
                enabled: boolean;
                allow_all_plugins: boolean;
                plugins: Record<string, unknown>;
              };
            };
          };
        };
      };
    };
    const bridge = effective.plugins.entries.codex.config.codexPlugins;
    assert.equal(bridge.enabled, true);
    assert.equal(bridge.allow_all_plugins, false);
    assert.deepEqual(bridge.plugins.linear, {
      enabled: false,
      marketplaceName: "openai-curated-remote",
      pluginName: "linear",
      allow_destructive_actions: "auto",
    });
  }
});

test("Codex runtime installs and reports only enabled selections in mixed plugin sets", async () => {
  const state = codexPluginState({
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
    },
    "codex-plugin:asana@openai-curated-remote": {
      enabled: false,
      toolDefaults: { approval: "provider_default" },
    },
  });
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(state)),
  };
  const installRequests: unknown[] = [];
  const { requests, value } = await runCodexRuntimeHelper(runtime, (method, params) => {
    if (method === "initialize") {
      return { serverInfo: { name: "codex", version: "0.149.0" } };
    }
    if (method === "plugin/search") {
      return codexSearchResponse({
        plugins: [
          {
            id: CODEX_LINEAR_NATIVE_ID,
            remotePluginId: CODEX_LINEAR_REMOTE_ID,
            name: "linear",
            source: { type: "remote" },
            installed: false,
            enabled: false,
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
            availability: "AVAILABLE",
            version: CODEX_LINEAR_VERSION,
            interface: null,
          },
          {
            id: CODEX_ASANA_NATIVE_ID,
            remotePluginId: CODEX_ASANA_REMOTE_ID,
            name: "asana",
            source: { type: "remote" },
            installed: false,
            enabled: false,
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
            availability: "AVAILABLE",
            version: "2.0.0",
            interface: null,
          },
        ],
      });
    }
    if (method === "plugin/read") {
      if ((params as CodexPluginRequestParams).pluginName === CODEX_LINEAR_REMOTE_ID) {
        return codexReadResponse({
          installed: installRequests.length > 0,
          enabled: installRequests.length > 0,
        });
      }
      if ((params as CodexPluginRequestParams).pluginName === CODEX_ASANA_REMOTE_ID) {
        return codexReadResponse({
          nativeId: CODEX_ASANA_NATIVE_ID,
          remotePluginId: CODEX_ASANA_REMOTE_ID,
          name: "asana",
          version: "2.0.0",
          installed: false,
          enabled: false,
          apps: [{ id: CODEX_ASANA_APP_ID, name: "Asana", needsAuth: false }],
        });
      }
    }
    if (method === "plugin/install") {
      installRequests.push(params);
      assert.equal((params as CodexPluginRequestParams).pluginName, CODEX_LINEAR_REMOTE_ID);
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    }
    if (method === "config/batchWrite") {
      const appEdit = configEdits(params).find((edit) => edit.keyPath === "apps");
      if (appEdit !== undefined) {
        assert.deepEqual(appEdit.value, {
          _default: { enabled: false },
          [CODEX_LINEAR_APP_ID]: { enabled: true, default_tools_approval_mode: "auto" },
        });
      }
      assert.deepEqual(configEdits(params).find((edit) => edit.keyPath === "plugins")?.value, {
        _default: { enabled: false },
        [CODEX_LINEAR_NATIVE_ID]: { enabled: true },
        [CODEX_ASANA_NATIVE_ID]: { enabled: false },
      });
      return { status: "ok", version: "mixed-config-1" };
    }
    if (method === "config/read") {
      const response = codexConfigReadResponse();
      response.config.plugins[CODEX_ASANA_NATIVE_ID] = { enabled: false };
      return response;
    }
    throw new Error(`unexpected request ${method}`);
  });

  assert.deepEqual(installRequests, [
    { remoteMarketplaceName: "openai-curated-remote", pluginName: CODEX_LINEAR_REMOTE_ID },
  ]);
  assert.deepEqual(plain(value), {
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    failures: [],
  });
  assert.deepEqual(
    requests
      .filter((request) => request.method === "plugin/install")
      .map((request) => (request.params as CodexPluginRequestParams).pluginName),
    [CODEX_LINEAR_REMOTE_ID],
  );
});

test("Codex runtime helper fails before readiness when catalog identity is absent", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(state)),
  };
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") {
          return { serverInfo: { name: "codex", version: "0.149.0" } };
        }
        if (method === "plugin/search") {
          return codexSearchResponse({
            nativeId: "asana@openai-curated-remote",
            remotePluginId: "plugin_asdk_app_asana",
            name: "asana",
          });
        }
        throw new Error(`unexpected request ${method}`);
      }),
    (error: unknown) => {
      assertStartupError(error);
      assert.match(error.message, /catalog did not contain the selected plugin/);
      // The fixed code, not the message, is what the wrapper exports remotely.
      assert.equal(error.startupCode, "PLUGIN_NOT_IN_CATALOG");
      return true;
    },
  );
});

test("Codex runtime helper rejects catalog drift before app grants and readiness", async (t) => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(state)),
  };
  for (const [name, installedDetail, error] of [
    [
      "app mapping",
      { apps: [{ id: "asdk_app_changed", name: "Linear", needsAuth: false }] },
      /installed app mapping does not match startup resolution/,
    ],
    ["MCP servers", { mcpServers: ["workspace"] }, /unsupported mcpServers/],
    [
      "version",
      { version: "5.0.2" },
      /installed release metadata does not match startup resolution/,
    ],
  ] as const) {
    await t.test(name, async () => {
      let readCount = 0;
      let policyWritten = false;
      await assert.rejects(
        () =>
          runCodexRuntimeHelper(runtime, (method, params) => {
            if (method === "initialize") {
              return { serverInfo: { name: "codex", version: "0.149.0" } };
            }
            if (method === "plugin/search") {
              return codexSearchResponse();
            }
            if (method === "plugin/read") {
              // A post-install catalog read must still match the admitted capabilities.
              readCount += 1;
              return codexReadResponse(readCount === 1 ? {} : installedDetail);
            }
            if (method === "config/batchWrite") {
              policyWritten = configEdits(params).some((edit) => edit.keyPath === "apps");
              return { status: "ok", version: "test-config-1" };
            }
            if (method === "plugin/install") {
              assert.deepEqual(params, {
                remoteMarketplaceName: "openai-curated-remote",
                pluginName: CODEX_LINEAR_REMOTE_ID,
              });
              return { authPolicy: "ON_USE", appsNeedingAuth: [] };
            }
            throw new Error(`unexpected request ${method}`);
          }),
        error,
      );
      assert.equal(policyWritten, false, "catalog details must be revalidated before app grants");
    });
  }
});

test("Codex runtime helper verifies defaults and rejects inherited unselected app or plugin enablement", async (t) => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(state)),
  };
  for (const [table, id, policy] of [
    ["apps", "_default", { enabled: true }],
    ["plugins", "_default", { enabled: true }],
    ["apps", "unselected_app", { enabled: true }],
    ["apps", "unselected_app", {}],
    ["apps", "unselected_app", { enabled: false }],
    ["plugins", "unselected@openai-curated-remote", { enabled: true }],
    ["plugins", "unselected@openai-curated-remote", { mcp_servers: { example: {} } }],
    ["plugins", "unselected@openai-curated-remote", { enabled: false }],
  ] satisfies readonly (readonly ["apps" | "plugins", string, CodexPluginPolicy])[]) {
    await t.test(`${table}.${id} ${JSON.stringify(policy)}`, async () => {
      const result = await runCodexRuntimeHelper(
        runtime,
        (method) => {
          if (method === "initialize") {
            return { serverInfo: { name: "codex", version: "0.156.0" } };
          }
          if (method === "plugin/search") {
            return codexSearchResponse();
          }
          if (method === "plugin/read") {
            return codexReadResponse();
          }
          if (method === "config/batchWrite") {
            return { status: "ok", version: "inherited-policy" };
          }
          if (method === "plugin/install") {
            return { authPolicy: "ON_USE", appsNeedingAuth: [] };
          }
          if (method === "config/read") {
            // Native config merges inherited entries with the replaced user tables.
            const response = codexConfigReadResponse();
            response.config[table][id] = policy;
            return response;
          }
          throw new Error(`unexpected request ${method}`);
        },
        { captureError: true },
      );
      if (
        policy.enabled === false ||
        (table === "plugins" && id !== "_default" && policy.enabled !== true)
      ) {
        assert.equal(result.error, undefined);
        assert.deepEqual(plain(result.value), {
          successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
          failures: [],
        });
      } else {
        const unselectedError =
          table === "apps"
            ? /effective app policy conflicts/
            : /effective plugins configuration enables an unselected entry/;
        assertStartupError(result.error);
        assert.match(
          result.error.message,
          id === "_default"
            ? /effective config does not match admitted configuration/
            : unselectedError,
        );
        assert.equal(result.value, undefined, "unselected enablement must prevent readiness");
      }
    });
  }
});

test("Codex runtime helper checks effective app, tool, and account policy before readiness", async (t) => {
  const scenarios: readonly EffectivePolicyScenario[] = [
    {
      name: "inherited app enablement bypasses requested destructive denial",
      defaults: { approval: "all_actions" },
      driverPolicy: { destructiveEnabled: false },
      app: { default_tools_enabled: true },
      rejects: true,
    },
    {
      name: "workspace layer overrides tool enablement",
      defaults: { approval: "all_actions" },
      workspaceApp: { default_tools_enabled: true },
      rejects: true,
    },
    {
      name: "unrequested app category restriction conflicts",
      app: { open_world_enabled: false },
      rejects: true,
    },
    {
      name: "explicit workspace categories match inherited native defaults",
      defaults: { approval: "all_actions" },
      workspaceApp: { destructive_enabled: true, open_world_enabled: true },
      global: { destructive_enabled: true, open_world_enabled: true },
    },
    {
      name: "explicit destructive denial rejects native enablement",
      defaults: { approval: "all_actions" },
      driverPolicy: { destructiveEnabled: false },
      app: { destructive_enabled: true },
      rejects: true,
      error: /effective config does not match admitted configuration/,
    },
    {
      name: "unrequested app tool exposure changes",
      app: { omit_tools_from: ["search"] },
      rejects: true,
    },
    {
      name: "inherited global category default conflicts",
      global: { destructive_enabled: false },
      rejects: true,
    },
    {
      name: "unselected app enabled despite global deny",
      otherApps: { unselected: { enabled: true } },
      rejects: true,
    },
    {
      name: "serialized defaults and inherited reviewers remain valid",
      app: {
        destructive_enabled: null,
        open_world_enabled: null,
        omit_tools_from: [],
        approvals_reviewer: "user",
      },
      global: {
        destructive_enabled: true,
        open_world_enabled: true,
        approvals_reviewer: "auto_review",
      },
      otherApps: { disabled: { enabled: false } },
      tools: {},
      links: { account: { approvals_reviewer: "auto_review", default_tools_approval_mode: null } },
    },
    { name: "extra enabled tool", tools: { extra: { enabled: true } }, rejects: true },
    { name: "extra approved tool", tools: { extra: { approval_mode: "approve" } }, rejects: true },
    {
      name: "conflict after matching tool",
      tools: { matching: { enabled: false }, extra: { approval_mode: "approve" } },
      rejects: true,
    },
    {
      name: "matching defaults and serialized nulls",
      tools: {
        matching: { enabled: false, approval_mode: "prompt" },
        empty: { enabled: null, approval_mode: null },
      },
    },
    {
      name: "account approval weakens default",
      links: { account: { default_tools_approval_mode: "approve", approvals_reviewer: null } },
      rejects: true,
    },
    {
      name: "conflict after matching account",
      links: {
        matching: { default_tools_approval_mode: "prompt" },
        extra: { default_tools_approval_mode: "approve" },
      },
      rejects: true,
    },
    {
      name: "matching account default",
      links: { account: { default_tools_approval_mode: "prompt" } },
    },
    { name: "null maps inherit", tools: null, links: null },
    {
      name: "unrequested enablement bypasses native category defaults",
      defaults: { approval: "all_actions" },
      tools: { extra: { enabled: true } },
      rejects: true,
    },
    {
      name: "stricter unexpected approval also conflicts",
      defaults: { enabled: true, approval: "none" },
      nativeApproval: "approve",
      tools: { extra: { approval_mode: "prompt" } },
      rejects: true,
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const defaults = scenario.defaults ?? { enabled: false, approval: "all_actions" };
      const state = codexLinearPluginState({
        toolDefaults: defaults,
        ...(scenario.driverPolicy === undefined ? {} : { driverPolicy: scenario.driverPolicy }),
      });
      const runtime = { manifest: pluginRuntimeSpecForRevision(revision(state)) };
      // A second native layer can contribute descendants absent from the user
      // config OCE replaces. Return that merged readback through the real startup helper.
      const result = await runCodexRuntimeHelper(
        runtime,
        (method, params) => {
          if (method === "initialize") {
            return { serverInfo: { name: "codex", version: "0.156.0" } };
          }
          if (method === "plugin/search") {
            return codexSearchResponse();
          }
          if (method === "plugin/read") {
            return codexReadResponse();
          }
          if (method === "plugin/install") {
            return { authPolicy: "ON_USE", appsNeedingAuth: [] };
          }
          if (method === "config/batchWrite") {
            return { status: "ok", version: "nested-policy" };
          }
          if (method === "config/read") {
            const response = codexConfigReadResponse({
              default_tools_enabled: defaults.enabled ?? null,
              default_tools_approval_mode: scenario.nativeApproval ?? "prompt",
              ...(scenario.driverPolicy === undefined ? {} : { destructive_enabled: false }),
              tools: scenario.tools,
              links: scenario.links,
              ...scenario.app,
              // Codex includes project layers only when config/read receives cwd.
              ...((params as { cwd: string }).cwd === "/home/node/workspace"
                ? scenario.workspaceApp
                : {}),
            });
            Object.assign(response.config.apps._default, scenario.global);
            Object.assign(response.config.apps, scenario.otherApps);
            return response;
          }
          throw new Error(`unexpected request ${method}`);
        },
        { captureError: true },
      );
      if (scenario.rejects) {
        assertStartupError(result.error);
        assert.match(
          result.error.message,
          scenario.error ?? /effective (app|tool|account) policy conflicts/,
        );
        assert.equal(result.value, undefined, "conflicting nested policy must prevent readiness");
      } else {
        assert.equal(result.error, undefined);
        assert.deepEqual(plain(result.value), {
          successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
          failures: [],
        });
      }
    });
  }
});

test("Codex runtime helper fails before readiness when selected plugin lacks app mapping", async () => {
  const state = codexLinearPluginState();
  const runtime = {
    manifest: pluginRuntimeSpecForRevision(revision(state)),
  };
  await assert.rejects(
    () =>
      runCodexRuntimeHelper(runtime, (method) => {
        if (method === "initialize") {
          return { serverInfo: { name: "codex", version: "0.149.0" } };
        }
        if (method === "plugin/search") {
          return codexSearchResponse();
        }
        if (method === "plugin/read") {
          return codexReadResponse({ apps: [] });
        }
        throw new Error(`unexpected request ${method}`);
      }),
    /does not expose an app mapping/,
  );
});
