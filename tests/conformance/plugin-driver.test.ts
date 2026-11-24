import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { NotImplementedError } from "../../packages/occ/src/index.ts";
import type {
  ConnectionTemplateVersion,
  CredentialSource,
} from "../../packages/contracts/src/index.ts";
import { context } from "./plugin-driver-fixtures.ts";

import "./plugin-driver-openclaw-policy-cases.ts";
import "./plugin-driver-openclaw-tool-denial-cases.ts";
import "./plugin-driver-codex-catalog-cases.ts";
import "./plugin-driver-codex-catalog-reader-cases.ts";
import "./plugin-driver-codex-configuration-cases.ts";

test("bundled Plugin Drivers enforce Harness identity", async () => {
  const occ = new OCCPluginDriver();
  const codex = new CodexPluginDriver();

  await assert.rejects(occ.listCatalog(context("dedicated")), NotImplementedError);
  await assert.rejects(codex.listCatalog(context("embedded")), NotImplementedError);
  await assert.rejects(
    occ.describeDeployment({
      plugin: {
        catalog: "codex-hosted",
        pluginId: "occ-plugin:diffs",
        remotePluginId: "hosted-diffs",
        appIds: ["diffs-app"],
        requiresSkillBundle: false,
      },
      selection: { enabled: true },
      connections: {},
    }),
    /OpenClaw deployment requires a Driver catalog selection/,
  );
});

test("credentialless Diffs keeps its pinned Gateway installation when its tool is disabled", async () => {
  const description = await new OCCPluginDriver().describeDeployment({
    plugin: { catalog: "driver", pluginId: "occ-plugin:diffs" },
    selection: { enabled: true, tools: { diffs: { enabled: false } } },
    connections: {},
  });
  assert.deepEqual(description.credentials, {});
  const [tool] = description.tools;
  assert.ok(tool);
  assert.equal(tool.kind, "installation");
  assert.equal(tool.role, "gateway");
  assert.deepEqual(tool.selectedTools, []);
  assert.ok(tool.installation.kind === "openclaw-package");
  assert.equal(tool.installation.package, "@openclaw/diffs@2026.8.2");
  assert.match(tool.installation.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.deepEqual(
    description.networkRequirements.map(({ toolId, purpose, match }) => [
      toolId,
      purpose,
      match.host,
    ]),
    [[tool.id, "installation", "registry.npmjs.org"]],
  );
});

test("OpenClaw reports selected credential Sources without validating the release", () => {
  const driver = new OCCPluginDriver();
  const pluginId = "occ-plugin:slack@1.0.0";
  const selection = {
    enabled: true,
    driverPolicy: { releaseSha256: "0".repeat(64), credentials: { account: "cs_selected" } },
  };
  const binding = { account: { default: "cs_selected" } };

  // An old selection must remain readable so an authorized edit can clear it.
  assert.deepEqual(driver.credentials.selectedBindings({ pluginId, selection }), binding);
  assert.throws(() => driver.validatePolicies({ [pluginId]: selection }), /release has changed/);
  assert.deepEqual(
    driver.credentials.selectedBindings({ pluginId: "occ-plugin:slack@0.9.0", selection }),
    binding,
  );
  assert.deepEqual(
    driver.credentials.selectedBindings({ pluginId, selection: { enabled: true } }),
    {},
  );
});

test("OpenClaw refuses malformed or disabled credential selections", () => {
  const driver = new OCCPluginDriver();
  const pluginId = "occ-plugin:slack@1.0.0";

  for (const selection of [
    { enabled: true, driverPolicy: { credentials: "cs_selected" } },
    { enabled: false, driverPolicy: { credentials: { account: "cs_selected" } } },
    { enabled: true, driverPolicy: { credentials: { account: "not-a-source" } } },
    { enabled: true, driverPolicy: { credentials: { "invalid slot": "cs_selected" } } },
  ]) {
    assert.throws(
      () => driver.credentials.selectedBindings({ pluginId, selection }),
      /Invalid credential/,
    );
  }
});

test("Google deployment describes only exact reviewed credential requests", async () => {
  const driver = new OCCPluginDriver();
  const slot = driver.credentials
    .choices([])
    .find(({ pluginId }) => pluginId === "occ-plugin:google@1.0.0");
  assert.ok(slot);
  const source = {
    kind: "credential_source",
    namespaceId: "ns_team",
    id: "cs_selected",
  } as const;
  const description = await driver.describeDeployment({
    plugin: { catalog: "driver", pluginId: slot.pluginId },
    selection: {
      enabled: true,
      driverPolicy: { releaseSha256: slot.releaseSha256, credentials: { account: source.id } },
    },
    connections: { account: { default: source } },
  });
  const ids = new Set(description.credentials.account?.default?.networkRequirementIds);
  const rules = description.networkRequirements.filter(({ id }) => ids.has(id));
  const gmail = rules.filter(({ match }) => match.host === "gmail.googleapis.com");
  assert.ok(
    rules.some(
      ({ match }) =>
        match.host === "chat.googleapis.com" &&
        match.requestPolicy?.type === "http" &&
        match.requestPolicy.method === "GET" &&
        match.requestPolicy.path === "/v1/spaces",
    ),
  );

  // A broad approved Template must not turn an unreviewed Gmail route into an injection rule.
  assert.ok(
    gmail.some(
      ({ match }) =>
        match.binary === "/usr/local/lib/oce/plugins/google/bin/gog" &&
        match.requestPolicy?.type === "http" &&
        match.requestPolicy.method === "GET" &&
        match.requestPolicy.path === "/gmail/v1/users/me/messages",
    ),
  );
  assert.deepEqual(
    gmail.flatMap(({ match }) =>
      match.requestPolicy?.type === "http" &&
      match.requestPolicy.path === "/gmail/v1/users/me/messages"
        ? [match.requestPolicy.method]
        : [],
    ),
    ["GET"],
  );
  assert.ok(
    gmail.some(
      ({ match }) =>
        match.requestPolicy?.type === "http" &&
        match.requestPolicy.method === "POST" &&
        match.requestPolicy.path === "/gmail/v1/users/me/messages/send",
    ),
  );
  assert.ok(
    rules.every(
      ({ match }) =>
        match.binary === "/usr/local/lib/oce/plugins/google/bin/gog" &&
        match.requestPolicy?.type === "http" &&
        !match.requestPolicy.path.includes("*") &&
        match.requestPolicy.path !== "/gmail/v1/users/me/not-a-google-operation",
    ),
  );
});

test("released Google and Slack slots accept authorized typed Template Sources without inspecting credential material", async () => {
  const driver = new OCCPluginDriver();
  const googleId = "occ-plugin:google@1.0.0";
  const slackId = "occ-plugin:slack@1.0.0";
  const createdAt = "2026-11-24T00:00:00.000Z";
  const id = (prefix: string) => `${prefix}_${randomUUID()}`;
  const googleTemplateId = id("ctp");
  const slackTemplateId = id("ctp");
  const staticTemplateId = id("ctp");
  const oauth = {
    ownerCapability: "token_service",
    type: "oauth2-refresh-token",
    tokenServiceInstanceId: randomUUID(),
    namespaceId: id("ns"),
    state: "ready",
    createdAt,
  } as const;
  const consent = {
    kind: "connection_template",
    ownerPrincipalId: "pr_user",
    version: 1,
    oauthClientId: id("ccr"),
    requestedScopes: [],
    grantedScopes: [],
  } as const;
  const slackConsent = { ...consent, oauthClientId: id("ccr") };
  const google: CredentialSource = {
    ...oauth,
    id: id("cs"),
    name: "Google account",
    connectionTemplateId: googleTemplateId,
    consent,
  };
  const slack: CredentialSource = {
    ...oauth,
    id: id("cs"),
    name: "Slack account",
    connectionTemplateId: slackTemplateId,
    consent: slackConsent,
  };
  const staticSlack: CredentialSource = {
    ownerCapability: "token_service",
    type: "static",
    tokenServiceInstanceId: oauth.tokenServiceInstanceId,
    namespaceId: oauth.namespaceId,
    state: "ready",
    createdAt,
    id: id("cs"),
    name: "Slack bearer",
    connectionTemplateId: staticTemplateId,
    config: {},
  };
  const common = {
    version: 1,
    createdAt,
    oauthClientId: consent.oauthClientId,
    scopes: [],
    authorizationParameters: {},
  } as const;
  const googleTemplate: ConnectionTemplateVersion = {
    ...common,
    templateId: google.connectionTemplateId,
    mode: "manual",
    issuer: "https://accounts.google.com",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    destinations: [{ host: "gmail.googleapis.com", port: 443, path: "/gmail/**" }],
  };
  const slackTemplate: ConnectionTemplateVersion = {
    ...common,
    oauthClientId: slackConsent.oauthClientId,
    templateId: slack.connectionTemplateId,
    mode: "mcp_discovery",
    issuer: "https://mcp.slack.com",
    authorizationUrl: "https://mcp.slack.com/authorize",
    tokenUrl: "https://mcp.slack.com/token",
    destinations: [{ host: "mcp.slack.com", port: 443, path: "/mcp" }],
    mcp: { serverUrl: "https://mcp.slack.com/mcp", resource: "https://mcp.slack.com" },
  };
  const templates = new Map<string, ConnectionTemplateVersion>([
    [google.id, googleTemplate],
    [slack.id, slackTemplate],
  ]);
  const staticTemplate: ConnectionTemplateVersion = {
    templateId: staticTemplateId,
    version: 1,
    createdAt,
    mode: "static_bearer",
    destinations: [{ method: "POST", host: "mcp.slack.com", port: 443, path: "/mcp" }],
  };
  templates.set(staticSlack.id, staticTemplate);
  const slots = driver.credentials.choices([google, slack, staticSlack], templates);
  const googleSlot = slots.find(({ pluginId }) => pluginId === googleId);
  const slackSlot = slots.find(({ pluginId }) => pluginId === slackId);
  assert.deepEqual(googleSlot?.sources, [{ id: google.id, name: google.name }]);
  assert.deepEqual(slackSlot?.sources, [
    { id: slack.id, name: slack.name },
    { id: staticSlack.id, name: staticSlack.name },
  ]);
  assert.ok(googleSlot && slackSlot);
  const selections = {
    [googleId]: {
      enabled: true,
      driverPolicy: {
        releaseSha256: googleSlot.releaseSha256,
        credentials: { account: google.id },
      },
    },
    [slackId]: {
      enabled: true,
      driverPolicy: {
        releaseSha256: slackSlot.releaseSha256,
        credentials: { account: slack.id },
        toolNames: ["slack_search_public"],
      },
    },
  };
  driver.validatePolicies(selections);
  await driver.credentials.validate(selections, [google, slack], undefined, templates);
  await driver.credentials.validate(
    {
      ...selections,
      [slackId]: {
        ...selections[slackId],
        driverPolicy: {
          ...selections[slackId].driverPolicy,
          credentials: { account: staticSlack.id },
        },
      },
    },
    [google, staticSlack],
    undefined,
    templates,
  );
  assert.deepEqual(
    driver.credentials.mcpToolDiscovery?.(slackId, "account", slack, slackTemplate),
    {
      endpoint: "https://mcp.slack.com/mcp",
    },
  );

  // A valid Source cannot be substituted across a reviewed issuer or protected MCP resource.
  const wrong = new Map(templates);
  wrong.set(google.id, { ...googleTemplate, issuer: "https://other.example" });
  wrong.set(slack.id, {
    ...slackTemplate,
    mcp: { ...slackTemplate.mcp!, resource: "https://other.example" },
  });
  wrong.set(staticSlack.id, {
    ...staticTemplate,
    destinations: [{ ...staticTemplate.destinations[0]!, method: "GET" }],
  });
  assert.deepEqual(
    driver.credentials
      .choices([google, slack, staticSlack], wrong)
      .filter(({ pluginId }) => [googleId, slackId].includes(pluginId))
      .map(({ sources }) => sources),
    [[], []],
  );
  await assert.rejects(
    async () => driver.credentials.validate(selections, [google, slack], undefined, wrong),
    /Select a ready Google Workspace account/,
  );
});

test("Slack describes only the selected account at its single default projection", async () => {
  const driver = new OCCPluginDriver();
  const slot = driver.credentials
    .choices([])
    .find(({ pluginId }) => pluginId === "occ-plugin:slack@1.0.0");
  assert.ok(slot);
  const selected = {
    kind: "credential_source",
    namespaceId: "ns_team",
    id: "cs_selected",
  } as const;
  const other = { ...selected, id: "cs_other" };
  const selection = {
    enabled: true,
    driverPolicy: { releaseSha256: slot.releaseSha256, credentials: { account: selected.id } },
  };
  // A second name cannot share SLACK_MCP_TOKEN, and a different source cannot stand in
  // for the account in the saved selection.
  for (const accounts of [{ default: selected, work: other }, { default: other }] as const) {
    await assert.rejects(
      driver.describeDeployment({
        plugin: { catalog: "driver", pluginId: slot.pluginId },
        selection,
        connections: { account: accounts },
      }),
      /Slack credential slot/,
    );
  }
});

test("staged Plugin placement exempts only authorized staged bindings from the legacy Gateway requirement", () => {
  const driver = new OCCPluginDriver();
  const slots = driver.credentials.choices([]);
  const google = slots.find(({ pluginId }) => pluginId === "occ-plugin:google@1.0.0")!;
  const slack = slots.find(({ pluginId }) => pluginId === "occ-plugin:slack@1.0.0")!;
  const selection = (slot: typeof google) => ({
    enabled: true,
    driverPolicy: {
      releaseSha256: slot.releaseSha256,
      credentials: { account: `cs_${randomUUID()}` },
    },
  });
  const plugins = { [google.pluginId]: selection(google), [slack.pluginId]: selection(slack) };
  const harness = { id: "openclaw", mode: "dedicated" } as const;
  const runtime = { sandbox: "openshell", gateway: undefined };

  // Staging Slack cannot bypass the legacy runtime prerequisite for a distinct Google binding.
  assert.throws(
    () => driver.validatePlacement(plugins, harness, "occ/kubernetes", runtime),
    /OpenShell Sandbox and Credential Gateway/,
  );
  assert.throws(
    () =>
      driver.validatePlacement(plugins, harness, "occ/kubernetes", {
        ...runtime,
        stagedPluginIds: new Set([slack.pluginId]),
      }),
    /OpenShell Sandbox and Credential Gateway/,
  );
  assert.doesNotThrow(() =>
    driver.validatePlacement(plugins, harness, "occ/kubernetes", {
      ...runtime,
      stagedPluginIds: new Set([google.pluginId, slack.pluginId]),
    }),
  );
  assert.doesNotThrow(() =>
    driver.validatePlacement(plugins, harness, "occ/kubernetes", {
      ...runtime,
      gateway: "openshell",
    }),
  );
});
