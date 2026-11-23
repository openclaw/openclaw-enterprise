import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  managedMcpCredentialBindings,
  managedCliInstalls,
  managedMcpInstalls,
  type ManagedMcpInstall,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { googleWorkspaceDestinations } from "../../apps/controller/src/drivers/plugin/google-workspace/operations.ts";
import {
  codexOpenClawConfiguration,
  openClawRuntimeArtifact,
  validatePolicies,
} from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import type {
  PluginCredentialSource,
  PluginApprover,
  PluginApprovers,
  PluginDriver,
  StaticKeyDestination,
} from "../../packages/contracts/src/index.ts";
import { PluginPolicyValidationError } from "../../packages/occ/src/index.ts";
import {
  calendarPluginId,
  codexSelection,
  configurationObject,
  context,
  linearPluginId,
  occSelection,
  unvalidatedPluginSelections,
} from "./plugin-driver-fixtures.ts";

const OCC_DIFFS_DIGEST =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

test("managed MCP policy asks once before dispatch and refuses unselected tools", async () => {
  const { default: plugin } = await import(
    new URL("../../deploy/runtime/managed-mcp-policy/index.mjs", import.meta.url).href
  );
  let policy:
    | {
        allowLocalMcpTool: (ctx: Record<string, unknown>) => boolean;
        handle: (ctx: Record<string, unknown>) => Promise<{ ok: boolean; code?: string }>;
      }
    | undefined;
  plugin.register({
    registerNodeInvokePolicy(value: typeof policy) {
      policy = value;
    },
  });
  assert.ok(policy);
  const pluginConfig = {
    nodeId: "node-one",
    servers: { oce_mcp_slack: { slack_search_public: "allow", slack_send_message: "ask" } },
  };
  const local = (tool: string) =>
    policy!.allowLocalMcpTool({ nodeId: "node-one", server: "oce_mcp_slack", tool, pluginConfig });
  assert.equal(local("slack_search_public"), true);
  assert.equal(local("slack_send_message"), false);
  assert.equal(local("disabled"), false);
  let upstreamCalls = 0;
  const prompts: Record<string, unknown>[] = [];
  const run = (tool: string, decision: string) =>
    policy!.handle({
      nodeId: "node-one",
      params: { server: "oce_mcp_slack", tool, arguments: { text: "example" } },
      pluginConfig,
      approvals: {
        async request(request: Record<string, unknown>) {
          prompts.push(request);
          return { decision };
        },
      },
      async invokeNode() {
        upstreamCalls += 1;
        return { ok: true };
      },
    });
  assert.equal((await run("slack_send_message", "deny")).code, "APPROVAL_DENIED");
  assert.equal(upstreamCalls, 0);
  assert.equal((await run("disabled", "allow-once")).code, "MCP_TOOL_DISABLED");
  assert.equal(upstreamCalls, 0);
  assert.equal((await run("slack_send_message", "allow-once")).ok, true);
  assert.equal(upstreamCalls, 1);
  assert.match(String(prompts.at(-1)?.description), /oce_mcp_slack\/slack_send_message/);
  assert.deepEqual(prompts.at(-1)?.allowedDecisions, ["allow-once", "deny"]);
});

test("OpenClaw Plugin Driver lists the vetted Diffs catalog entry", async () => {
  const driver = new OCCPluginDriver(
    {},
    { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
  );

  const [catalogEntry] = await driver.listCatalog(context("embedded"));
  assert.deepEqual(catalogEntry, {
    id: "occ-plugin:diffs",
    name: "Diffs",
    tools: [{ id: "diffs", name: "diffs", ownerId: "diffs" }],
  });
});

test("dedicated OpenClaw admits Google and Slack together and validates Slack's reviewed account binding", async () => {
  const driver = new OCCPluginDriver();
  const dedicated = context("dedicated");
  const [google, slack] = await driver.listCatalog({
    ...dedicated,
    harness: { ...dedicated.harness, id: "openclaw" },
  });
  assert.ok(google);
  assert.ok(slack);
  assert.equal(google.id, "occ-plugin:google@1.0.0");
  assert.equal(slack.id, "occ-plugin:slack@1.0.0");
  assert.equal(driver.policyCapabilities.policyScopeByPlugin?.[slack.id], "tool_human_approval");
  assert.deepEqual((await driver.discoverCatalog({ q: "SLACK" })).plugins, [slack]);
  driver.validatePolicies({ [slack.id]: { enabled: false } });
  const slackInstall = managedMcpInstalls.find(({ id }) => id === slack.id);
  assert.ok(slackInstall);
  const slackSourceId = "cs_00000000-0000-4000-8000-000000000001";
  const slackPolicy = {
    releaseSha256: slackInstall.releaseSha256,
    credentials: { account: slackSourceId },
  };
  const selections = {
    [google.id]: { enabled: true },
    [slack.id]: { enabled: true, driverPolicy: slackPolicy },
  };
  driver.validatePolicies(selections);
  assert.throws(
    () =>
      driver.validatePolicies({
        [slack.id]: { enabled: true, driverPolicy: { credentials: { account: slackSourceId } } },
      }),
    /Slack release has changed/,
  );
  driver.validatePolicies({
    [slack.id]: {
      enabled: true,
      driverPolicy: { ...slackPolicy, toolNames: ["slack_search_public", "slack_send_message"] },
      tools: { slack_send_message: { approval: "all_actions" } },
    },
  });
  assert.throws(
    () =>
      driver.validatePolicies({
        [slack.id]: {
          enabled: true,
          driverPolicy: { ...slackPolicy, toolNames: ["slack_search_public"] },
          tools: { slack_send_message: { approval: "all_actions" } },
        },
      }),
    /Select an enabled Slack tool/,
  );
  // Selections are literal upstream names. Globs and colliding aliases would broaden access.
  for (const toolNames of [["slack_*"], ["Search", "search"], ["x".repeat(64)], null]) {
    assert.throws(
      () =>
        driver.validatePolicies({
          [slack.id]: { enabled: true, driverPolicy: { ...slackPolicy, toolNames } },
        }),
      /Select distinct literal Slack tool names/,
    );
  }
  const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
  const templateId = "ctp_00000000-0000-4000-8000-000000000001";
  const createdAt = "2026-09-08T00:00:00.000Z";
  const source = {
    id: slackSourceId,
    name: "Slack test account",
    namespaceId,
    ref: { kind: "credential_source", id: slackSourceId, namespaceId },
    type: "static",
    connectionTemplateId: templateId,
    createdAt,
    state: "ready",
    config: {},
    currentTemplate: {
      templateId,
      version: 1,
      createdAt,
      mode: "static_bearer",
      destinations: [{ host: "mcp.slack.com", port: 443, path: "/mcp", method: "POST" }],
    },
  } satisfies PluginCredentialSource;
  const broaderRestSource = {
    ...source,
    id: "cs_00000000-0000-4000-8000-000000000002",
    connectionTemplateId: "ctp_00000000-0000-4000-8000-000000000003",
    ref: {
      ...source.ref,
      id: "cs_00000000-0000-4000-8000-000000000002",
    },
    currentTemplate: {
      ...source.currentTemplate,
      templateId: "ctp_00000000-0000-4000-8000-000000000003",
      destinations: [{ host: "mcp.slack.com", port: 443, path: "/api/**", method: "POST" }],
    },
  };
  const credentials: NonNullable<PluginDriver["credentials"]> = driver.credentials;
  const slots = credentials.choices([source, broaderRestSource]);
  const slackSlot = slots.find(({ pluginId }) => pluginId === slack.id);
  assert.ok(slackSlot);
  assert.equal(slackSlot.id, "account");
  assert.equal(slackSlot.label, "Slack user account");
  assert.deepEqual(slackSlot.sources, [{ id: source.id, name: source.name }]);
  const staticMcp = (destinations: readonly StaticKeyDestination[]) => ({
    ...source,
    currentTemplate: { ...source.currentTemplate, destinations },
  });
  const mcpDestination = { host: "mcp.slack.com", port: 443, path: "/mcp/**" };
  const postOnly = staticMcp([{ ...mcpDestination, method: "POST" }]);
  assert.deepEqual(credentials.mcpToolDiscovery?.(slack.id, "account", postOnly), {
    endpoint: slackInstall.url,
    methods: ["POST"],
  });
  assert.equal(
    credentials.mcpToolDiscovery?.(
      slack.id,
      "account",
      staticMcp([{ ...mcpDestination, method: "GET" }]),
    ),
    undefined,
  );
  assert.deepEqual(
    credentials.mcpToolDiscovery?.(
      slack.id,
      "account",
      staticMcp([
        { ...mcpDestination, method: "POST" },
        { ...mcpDestination, method: "GET", path: "/different" },
        { ...mcpDestination, method: "DELETE" },
      ]),
    ),
    { endpoint: slackInstall.url, methods: ["POST", "DELETE"] },
  );
  const oauthId = "cs_00000000-0000-4000-8000-000000000004";
  const slot = slackInstall.credentials[slackInstall.slotId]!;
  const oauth = {
    id: oauthId,
    namespaceId,
    name: "Slack OAuth account",
    state: "ready",
    createdAt,
    ref: { kind: "credential_source", id: oauthId, namespaceId },
    type: "oauth2-refresh-token",
    connectionTemplateId: templateId,
    consent: {
      kind: "connection_template",
      ownerPrincipalId: "p-test",
      version: 1,
      oauthClientId: "oc-test",
      requestedScopes: [],
      grantedScopes: [],
      issuer: slot.issuer,
      tokenUrl: "https://mcp.slack.com/token",
      clientId: "client",
      destinations: [],
      resource: slot.mcp.resource,
      mcpServerUrl: slackInstall.url,
    },
    currentTemplate: {
      templateId,
      version: 2,
      createdAt,
      mode: "mcp_discovery",
      issuer: slot.issuer,
      authorizationUrl: "https://mcp.slack.com/authorize",
      tokenUrl: "https://mcp.slack.com/token",
      scopes: [],
      authorizationParameters: {},
      destinations: [{ host: "mcp.slack.com", port: 443, path: "/mcp" }],
      mcp: { resource: slot.mcp.resource, serverUrl: slackInstall.url },
    },
  } satisfies PluginCredentialSource;
  assert.deepEqual(
    credentials.choices([oauth]).find(({ pluginId }) => pluginId === slack.id)?.sources,
    [{ id: oauth.id, name: oauth.name }],
  );
  assert.equal(
    credentials
      .choices([
        {
          ...oauth,
          currentTemplate: {
            ...oauth.currentTemplate,
            destinations: [{ host: "mcp.slack.com", port: 443, path: "/mcp/**" }],
          },
        },
      ])
      .find(({ pluginId }) => pluginId === slack.id)?.sources.length,
    1,
  );
  for (const invalid of [
    { ...oauth, consent: { ...oauth.consent, issuer: "https://other.example" } },
    { ...oauth, consent: { ...oauth.consent, resource: "https://other.example" } },
    {
      ...oauth,
      currentTemplate: {
        ...oauth.currentTemplate,
        mcp: { ...oauth.currentTemplate.mcp, serverUrl: "https://other.example/mcp" },
      },
    },
    { ...oauth, currentTemplate: { ...oauth.currentTemplate, destinations: [] } },
    {
      ...oauth,
      currentTemplate: {
        ...oauth.currentTemplate,
        destinations: [{ host: "mcp.slack.com", port: 443, path: "/mc/**" }],
      },
    },
  ]) {
    assert.deepEqual(
      credentials.choices([invalid]).find(({ pluginId }) => pluginId === slack.id)?.sources,
      [],
    );
  }
  await driver.credentials.validate(selections, [source]);
  await assert.rejects(
    async () =>
      driver.credentials.validate(selections, [
        { ...broaderRestSource, id: source.id, ref: source.ref },
      ]),
    /Select a ready Slack account/,
  );

  const googleInstall = managedCliInstalls.find(({ id }) => id === google.id);
  assert.ok(googleInstall);
  const googleSourceId = "cs_00000000-0000-4000-8000-000000000003";
  const googleTemplateId = "ctp_00000000-0000-4000-8000-000000000002";
  const destinations = [{ host: "gmail.googleapis.com", port: 443, path: "/gmail/v1/**" }];
  const googleSource = {
    id: googleSourceId,
    name: "Google account",
    namespaceId,
    ref: { kind: "credential_source", id: googleSourceId, namespaceId },
    type: "oauth2-refresh-token",
    state: "ready",
    createdAt,
    connectionTemplateId: googleTemplateId,
    consent: {
      kind: "connection_template",
      version: 1,
      oauthClientId: "oc_00000000-0000-4000-8000-000000000001",
      ownerPrincipalId: "pr_00000000-0000-4000-8000-000000000001",
      requestedScopes: [],
      grantedScopes: [],
      issuer: "https://accounts.google.com",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "google-client-id",
      destinations,
    },
    currentTemplate: {
      templateId: googleTemplateId,
      version: 2,
      createdAt,
      mode: "manual",
      issuer: "https://accounts.google.com",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      oauthClientId: "oc_00000000-0000-4000-8000-000000000001",
      scopes: [],
      authorizationParameters: {},
      destinations,
    },
  } satisfies PluginCredentialSource;
  const otherIssuer = {
    ...googleSource,
    id: "cs_00000000-0000-4000-8000-000000000004",
    ref: { ...googleSource.ref, id: "cs_00000000-0000-4000-8000-000000000004" },
    connectionTemplateId: "ctp_00000000-0000-4000-8000-000000000004",
    consent: {
      ...googleSource.consent,
      oauthClientId: "oc_00000000-0000-4000-8000-000000000002",
      issuer: "https://other.example.test",
      tokenUrl: "https://other.example.test/token",
      clientId: "other-client-id",
    },
    currentTemplate: {
      ...googleSource.currentTemplate,
      templateId: "ctp_00000000-0000-4000-8000-000000000004",
      issuer: "https://other.example.test",
      authorizationUrl: "https://other.example.test/authorize",
      tokenUrl: "https://other.example.test/token",
      oauthClientId: "oc_00000000-0000-4000-8000-000000000002",
    },
  };
  const googleSlot = credentials
    .choices([
      googleSource,
      otherIssuer,
      {
        ...googleSource,
        consent: { ...googleSource.consent, tokenUrl: "https://other.example.test/token" },
        currentTemplate: {
          ...googleSource.currentTemplate,
          tokenUrl: "https://other.example.test/token",
        },
      },
    ])
    .find(({ pluginId }) => pluginId === google.id);
  assert.deepEqual(googleSlot?.sources, [{ id: googleSourceId, name: googleSource.name }]);
  for (const [host, path, accepted] of [
    ["gmail.googleapis.com", "/gmail/v1/users/me/messages", true],
    ["gmail.googleapis.com", "/gmail/v1/users/me/messages/**", true],
    [
      "admin.googleapis.com",
      "/admin/directory/v1/customer/my_customer/orgunits/Engineering/Subteam/**",
      false,
    ],
    ["gmail.googleapis.com", "/gmail/v1/users/me/not-a-google-operation", false],
    ["gmail.googleapis.com", "/gmail/v1/users/me/not-a-google-operation/**", false],
  ] as const) {
    const edited = {
      ...googleSource,
      currentTemplate: {
        ...googleSource.currentTemplate,
        destinations: [{ host, port: 443, path }],
      },
    };
    assert.equal(
      credentials.choices([edited]).find(({ pluginId }) => pluginId === google.id)?.sources.length,
      accepted ? 1 : 0,
      `${host}${path}`,
    );
  }
  // A mixed Gmail Template cannot widen the Plugin's exact credential requirements.
  const mixedGoogleSource = {
    ...googleSource,
    currentTemplate: {
      ...googleSource.currentTemplate,
      destinations: [
        { host: "gmail.googleapis.com", port: 443, path: "/gmail/v1/users/me/messages" },
        {
          host: "gmail.googleapis.com",
          port: 443,
          path: "/gmail/v1/users/me/not-a-google-operation",
        },
      ],
    },
  };
  assert.deepEqual(
    credentials.choices([mixedGoogleSource]).find(({ pluginId }) => pluginId === google.id)
      ?.sources,
    [{ id: googleSourceId, name: googleSource.name }],
  );
  const googleSelection = {
    enabled: true,
    driverPolicy: {
      releaseSha256: googleInstall.releaseSha256,
      credentials: { account: googleSourceId },
    },
  };
  const deployment = await driver.describeDeployment({
    plugin: { catalog: "driver", pluginId: google.id },
    selection: googleSelection,
    connections: { account: { default: googleSource.ref } },
  });
  const ids = new Set(deployment.credentials.account!.default!.networkRequirementIds);
  const gmailRules = deployment.networkRequirements.filter(
    ({ id, match }) => ids.has(id) && match.host === "gmail.googleapis.com",
  );
  assert.ok(
    gmailRules.some(
      ({ match }) =>
        match.requestPolicy?.type === "http" &&
        match.requestPolicy.method === "GET" &&
        match.requestPolicy.path === "/gmail/v1/users/me/messages",
    ),
  );
  assert.ok(
    !gmailRules.some(
      ({ match }) =>
        match.requestPolicy?.type === "http" &&
        match.requestPolicy.path === "/gmail/v1/users/me/messages" &&
        match.requestPolicy.method !== "GET",
    ),
  );
  assert.ok(
    gmailRules.every(
      ({ match }) =>
        match.requestPolicy?.type === "http" &&
        !match.requestPolicy.path.endsWith("/**") &&
        match.requestPolicy.path !== "/gmail/v1/users/me/not-a-google-operation",
    ),
  );
  await credentials.validate({ [google.id]: googleSelection }, [mixedGoogleSource]);
  const builtInTemplate = {
    ...googleSource,
    currentTemplate: { ...googleSource.currentTemplate, destinations: googleWorkspaceDestinations },
  };
  await assert.rejects(
    async () => credentials.validate({ [google.id]: googleSelection }, [builtInTemplate]),
    /Select a ready Google Workspace account/,
    "the built-in broad Template still includes other services whose operations cannot be enforced",
  );
  // A different service's literal can still be unsafe when an advertised method covers it
  // but the reviewed operation catalog does not (DELETE on the group collection).
  const unsafeGroup = {
    ...googleSource,
    currentTemplate: {
      ...googleSource.currentTemplate,
      destinations: [
        { host: "admin.googleapis.com", port: 443, path: "/admin/directory/v1/groups" },
      ],
    },
  };
  await assert.rejects(
    async () => credentials.validate({ [google.id]: googleSelection }, [unsafeGroup]),
    /Select a ready Google Workspace account/,
  );
  // Consent v1 remains tied to Gmail and the provider's actual grant; an admin's current
  // manual Template v2 can authorize a different reviewed Google destination for that account.
  const currentAdminDestination = {
    ...googleSource,
    consent: {
      ...googleSource.consent,
      requestedScopes: ["mail.read"],
      grantedScopes: ["profile"],
    },
    currentTemplate: {
      ...googleSource.currentTemplate,
      destinations: [{ host: "adsense.googleapis.com", port: 443, path: "/v2/accounts" }],
    },
  };
  assert.deepEqual(
    credentials.choices([currentAdminDestination]).find(({ pluginId }) => pluginId === google.id)
      ?.sources,
    [{ id: googleSourceId, name: googleSource.name }],
  );
  // A provider may grant no known scopes; issuer and approved destination establish slot eligibility.
  await credentials.validate(
    {
      ...selections,
      [google.id]: {
        enabled: true,
        driverPolicy: {
          releaseSha256: googleInstall.releaseSha256,
          credentials: { account: googleSourceId },
        },
      },
    },
    [source, googleSource],
  );
  const mixedPlacement = { ...selections, ...occSelection() };
  driver.validatePolicies(mixedPlacement);
  assert.throws(
    () =>
      driver.validatePlacement(
        mixedPlacement,
        { id: "openclaw", mode: "dedicated" },
        "occ/kubernetes",
      ),
    /Select occ-plugin:diffs on an embedded OpenClaw Agent. Use a dedicated OpenClaw Agent for Google Workspace, Slack/,
  );
  assert.throws(
    () =>
      driver.validatePolicies({
        ...selections,
        ...occSelection({ tools: { unknown: { enabled: true } } }),
      }),
    { name: "PluginPolicyValidationError" },
  );
  assert.throws(
    () =>
      driver.validatePolicies(
        unvalidatedPluginSelections({
          ...selections,
          [slack.id]: { enabled: true, credentialSourceId: "src_personal" },
        }),
      ),
    /Slack package supports enablement, a credential slot, and per-tool human approval/,
  );
});

test("managed MCP bindings preserve both servers' credentials and require unambiguous runtime names", () => {
  const [first] = managedMcpInstalls;
  assert.ok(first);
  const second = {
    ...first,
    id: "occ-plugin:team@1.0.0",
    runtimeName: "team",
    server: first.server + "_team",
    url: "https://team.example.test/mcp",
    endpoint: { ...first.endpoint, host: "team.example.test" },
    credentialEnvironment: "TEAM_MCP_TOKEN",
  };
  const installs = [first, second];
  const select = (install: ManagedMcpInstall, sourceId: string, tool: string) => ({
    enabled: true,
    driverPolicy: {
      releaseSha256: install.releaseSha256,
      credentials: { [install.slotId]: sourceId },
      toolNames: [tool],
    },
  });
  const selections = {
    [first.id]: select(first, "cs_first", "team_read"),
    [second.id]: select(second, "cs_second", "write"),
  };
  assert.deepEqual(
    managedMcpCredentialBindings(selections, installs).map(({ install, sourceId, toolNames }) => [
      install.id,
      sourceId,
      toolNames,
    ]),
    [
      [first.id, "cs_first", ["team_read"]],
      [second.id, "cs_second", ["write"]],
    ],
  );
  assert.throws(
    () =>
      managedMcpCredentialBindings(
        {
          ...selections,
          [second.id]: select(second, "cs_second", "READ"),
        },
        installs,
      ),
    /same Gateway name/,
  );
  assert.throws(
    () =>
      managedMcpCredentialBindings(
        {
          [first.id]: { enabled: true },
          [second.id]: { enabled: true },
        },
        [first, { ...second, server: first.server }],
      ),
    /same worker server name/,
  );
});

test("OpenClaw plugin startup translation renders native install and enablement", () => {
  const enabled = openClawRuntimeArtifact(occSelection());
  assert.deepEqual(enabled.installs, [
    {
      pluginId: "occ-plugin:diffs",
      nativeId: "diffs",
      packageName: "@openclaw/diffs",
      version: "2026.8.2",
      integrity: OCC_DIFFS_DIGEST,
    },
  ]);
  assert.deepEqual(configurationObject(enabled.configuration, "plugins", "entries").diffs, {
    enabled: true,
  });
  assert.deepEqual(enabled.configuration.tools, { alsoAllow: ["diffs"] });

  const blocked = openClawRuntimeArtifact(occSelection({ enabled: false }));
  assert.deepEqual(configurationObject(blocked.configuration, "plugins", "entries").diffs, {
    enabled: false,
  });
  assert.equal(Object.hasOwn(blocked.configuration, "tools"), false);
});

test("Plugin approver translation keeps Agent, plugin, and exact scoped tool overrides", () => {
  const first = { channel: "slack", id: "team:T123:user:U123" };
  const second = { channel: "slack", id: "U456" };
  const toolId = "asdk_app_69a089a326dc8191b32a3f2553f5be2c/repos%2Fread";
  const codex = codexOpenClawConfiguration(
    codexSelection(linearPluginId, {
      approvers: [],
      tools: { [toolId]: { approvers: [second] } },
    }),
    [],
    { pluginApprovers: [first] },
  );
  assert.deepEqual(configurationObject(codex, "approvals", "plugin").slack, {
    approvers: [first.id],
    plugins: {
      linear: { approvers: [], tools: { [toolId]: { approvers: [second.id] } } },
    },
  });
  assert.deepEqual(codexOpenClawConfiguration({}, [], { pluginApprovers: [] })?.approvals, {
    plugin: { slack: { approvers: [] } },
  });
  assert.deepEqual(
    configurationObject(
      codexOpenClawConfiguration(codexSelection(linearPluginId, { approvers: [] })),
      "approvals",
      "plugin",
    ).slack,
    { plugins: { linear: { approvers: [] } } },
  );

  const native = openClawRuntimeArtifact(
    occSelection({ approvers: [second], tools: { diffs: { approvers: [] } } }),
    [],
    [first],
  );
  assert.deepEqual(configurationObject(native.configuration, "approvals", "plugin").slack, {
    approvers: [first.id],
    plugins: { diffs: { approvers: [second.id], tools: { diffs: { approvers: [] } } } },
  });
  assert.throws(
    () =>
      validatePolicies(
        "openclaw",
        unvalidatedPluginSelections({
          "occ-plugin:diffs": { enabled: true, toolDefaults: { approvers: [] } },
        }),
      ),
    { message: "Plugin tool defaults contains unsupported policy fields." },
  );
  // Each input breaks one approver rule; Slack approvers are user IDs, never channels.
  const approver = (id: string): PluginApprover => ({ channel: "slack", id });
  const invalidApprovers: [PluginApprovers | PluginApprover, string][] = [
    [[approver("team:X123:user:Y456")], "Plugin approver must identify a Slack user."],
    [[approver("C123")], "Plugin approver must identify a Slack user."],
    [approver("U123"), "Plugin approvers must be a bounded list."],
    [
      Array.from({ length: 65 }, (_, index) => approver(`U${index}`)),
      "Plugin approvers must be a bounded list.",
    ],
    [[approver("U123"), approver("U123")], "Plugin approvers must be unique."],
  ];
  for (const [approvers, message] of invalidApprovers) {
    // The persisted value can be one object where the contract requires a list.
    assert.throws(() => validatePolicies("openclaw", {}, approvers as PluginApprovers), {
      message,
    });
  }
});

test("Codex Plugin Driver admits only Agent-wide approvers; OpenClaw keeps plugin and tool overrides", () => {
  const approver = { channel: "slack", id: "team:T123:user:U123" };
  const toolId = "asdk_app_69a089a326dc8191b32a3f2553f5be2c/repos%2Fread";
  const codex = new CodexPluginDriver();
  const occ = new OCCPluginDriver();
  // Codex approval requests carry no plugin or tool identity, so OpenClaw's Slack resolver
  // denies every Codex request once any plugin list exists. Only the Agent default works.
  assert.deepEqual(codex.policyCapabilities.approvers, {
    agent: true,
    plugin: false,
    tools: false,
  });
  assert.deepEqual(occ.policyCapabilities.approvers, { agent: true, plugin: true, tools: true });
  codex.validatePolicies(codexSelection(), [approver]);
  for (const selection of [
    codexSelection(linearPluginId, { approvers: [] }),
    codexSelection(linearPluginId, { tools: { [toolId]: { approvers: [approver] } } }),
    // A disabled plugin still renders its list into approvals.plugin.slack.plugins.
    codexSelection(linearPluginId, { enabled: false, approvers: [approver] }),
  ]) {
    assert.throws(
      () => codex.validatePolicies(selection, [approver]),
      (error: unknown) =>
        error instanceof PluginPolicyValidationError &&
        /does not support plugin or tool approvers.*Agent-wide pluginApprovers/.test(error.message),
    );
  }
  occ.validatePolicies(
    occSelection({ approvers: [approver], tools: { diffs: { approvers: [] } } }),
    [approver],
  );
});

test("Plugin Drivers refuse two selection keys for the same native plugin", () => {
  const aliased = (error: unknown) =>
    error instanceof PluginPolicyValidationError &&
    /same plugin.*Keep one selection per plugin/.test(error.message);
  const occ = new OCCPluginDriver();
  const codex = new CodexPluginDriver();
  for (const enabled of [true, false]) {
    assert.throws(
      () => occ.validatePolicies({ diffs: { enabled: true }, "occ-plugin:diffs": { enabled } }),
      aliased,
    );
    assert.throws(
      () =>
        codex.validatePolicies({
          [linearPluginId]: { enabled: true },
          "linear@openai-curated-remote": { enabled },
        }),
      aliased,
    );
  }
  occ.validatePolicies({ diffs: { enabled: true } });
  codex.validatePolicies({
    ...codexSelection(linearPluginId),
    ...codexSelection(calendarPluginId),
  });
  // Admission-only: revisions admitted before the check still render.
  validatePolicies("openclaw", { diffs: { enabled: true }, "occ-plugin:diffs": { enabled: true } });
});

test("Plugin Drivers name themselves when a selection names a plugin they do not offer", () => {
  const occ = new OCCPluginDriver();
  const codex = new CodexPluginDriver();
  // The error names the Driver and the rejected selection key, which HTTP reports as a
  // /plugins/<id> detail.
  const unknownFor = (driverId: string, pluginId: string) => (error: unknown) =>
    error instanceof PluginPolicyValidationError &&
    error.pluginId === pluginId &&
    error.message.startsWith(
      `A plugin selection names a plugin that the selected Plugin Driver (${driverId}) does not offer: ${pluginId}.`,
    );
  // The other Driver's plugin, as after an Installation switches its single Plugin Driver.
  assert.throws(
    () => codex.validatePolicies(occSelection()),
    unknownFor("codex-plugin", "occ-plugin:diffs"),
  );
  assert.throws(
    () => occ.validatePolicies(codexSelection(linearPluginId)),
    unknownFor("occ-plugin", linearPluginId),
  );
  assert.throws(
    () => occ.validatePolicies({ "occ-plugin:unknown": { enabled: true } }),
    unknownFor("occ-plugin", "occ-plugin:unknown"),
  );
  assert.throws(
    () => codex.validatePolicies({ "codex-plugin:linear": { enabled: true } }),
    unknownFor("codex-plugin", "codex-plugin:linear"),
  );
  // With several selections, the error names the one the Driver does not offer.
  assert.throws(
    () => occ.validatePolicies({ ...occSelection(), ...codexSelection(linearPluginId) }),
    unknownFor("occ-plugin", linearPluginId),
  );
  // The ID mismatch wins over a policy field the selected Driver does not support.
  assert.throws(
    () =>
      occ.validatePolicies(codexSelection(linearPluginId, { toolDefaults: { reviewer: "human" } })),
    unknownFor("occ-plugin", linearPluginId),
  );
  // Policy errors on an offered plugin keep their own message.
  assert.throws(
    () => occ.validatePolicies(occSelection({ toolDefaults: { approval: "all_actions" } })),
    { name: "PluginPolicyValidationError", message: "The supplied plugin policies are invalid." },
  );
});

test("OpenClaw plugin startup translation rejects unsupported policies", () => {
  // Each selection breaks exactly one admission rule, named by its message.
  const invalidPolicies: [unknown, string][] = [
    [
      occSelection({ toolDefaults: { approval: "all_actions" } }),
      "OpenClaw plugin all_actions approval is unsupported.",
    ],
    [
      occSelection({ toolDefaults: { approval: "write_actions" } }),
      "OpenClaw plugin write_actions approval is unsupported.",
    ],
    [
      occSelection({ toolDefaults: { reviewer: "auto" } }),
      "This runtime does not support toolDefaults.reviewer; omit it to inherit.",
    ],
    [
      occSelection({ tools: { unknown: { enabled: false } } }),
      "Unknown OpenClaw plugin tool selection.",
    ],
    [
      occSelection({ tools: { diffs: { approval: "all_actions" } } }),
      "OpenClaw plugin all_actions approval is unsupported.",
    ],
    [
      occSelection({ tools: { diffs: { approval: "write_actions" } } }),
      "OpenClaw plugin write_actions approval is unsupported.",
    ],
    [
      {
        "occ-plugin:diffs": {
          enabled: true,
          toolDefaults: { approval: "none" },
          approvalMode: "never",
        },
      },
      "Plugin selection contains unsupported policy fields.",
    ],
    [{ "occ-plugin:unknown": { enabled: true } }, "Unknown OpenClaw plugin selection."],
    [null, "Plugin selections must be an object."],
    [{ "occ-plugin:diffs": true }, "Plugin selection must be an object."],
    [{ "occ-plugin:diffs": {} }, "Plugin enabled must be a boolean."],
    [
      { "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "none" }, tools: [] } },
      "Plugin tool policies must be an object.",
    ],
    [
      {
        "occ-plugin:diffs": {
          enabled: true,
          toolDefaults: { approval: "none" },
          tools: { diffs: { enabled: "yes" } },
        },
      },
      "Tool enabled must be a boolean.",
    ],
    [
      {
        "occ-plugin:diffs": {
          enabled: true,
          toolDefaults: { approval: "none" },
          tools: { diffs: { approval: "sometimes" } },
        },
      },
      "Tool approval policy is unsupported.",
    ],
    [
      occSelection({ tools: { diffs: { reviewer: "human" } } }),
      "Per-tool reviewer selection is unsupported; omit tools[id].reviewer.",
    ],
    [
      occSelection({ driverPolicy: { any: true } }),
      "OpenClaw driver policy contains unsupported policy fields.",
    ],
  ];
  for (const [selection, message] of invalidPolicies) {
    assert.throws(() => openClawRuntimeArtifact(unvalidatedPluginSelections(selection)), {
      message,
    });
  }
  // Admission refuses an unknown plugin on its own; translation repeats the check with the
  // same message, so only a direct admission call shows the admission check exists.
  assert.throws(() => validatePolicies("openclaw", { "occ-plugin:unknown": { enabled: true } }), {
    message: "Unknown OpenClaw plugin selection.",
  });
});

test("OpenClaw tool enablement overrides tool defaults without enabling a disabled plugin", () => {
  const selections = occSelection({
    toolDefaults: { enabled: false },
    tools: { diffs: { enabled: true } },
  });
  assert.deepEqual(openClawRuntimeArtifact(selections).configuration, {
    plugins: { entries: { diffs: { enabled: true } } },
    tools: { alsoAllow: ["diffs"] },
  });
  const disabledTool = openClawRuntimeArtifact(
    occSelection({ tools: { diffs: { enabled: false, approval: "none" } } }),
  );
  assert.deepEqual(disabledTool.configuration.tools, { alsoAllow: ["diffs"], deny: ["diffs"] });
  selections["occ-plugin:diffs"].enabled = false;
  assert.deepEqual(openClawRuntimeArtifact(selections).configuration, {
    plugins: { entries: { diffs: { enabled: false } } },
  });
});
