import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { codexRuntimeArtifact } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import type { SecretDriver } from "../../packages/contracts/src/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentPluginCatalogResponse,
  AgentPluginDetailsResponse,
  SecretResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  accessToken,
  catalogEntry,
  createDiscoveryLogger,
  createFixture,
  pluginDetails,
  remoteId,
  secretValueReadCount,
  fetchUrl,
} from "./plugin-discovery-api-fixture.ts";

export async function authorizesSelectedSecretBeforeDriverSupport(t: TestContext) {
  const fixture = await createFixture(t, { supported: false });
  const secret = await fixture.createSecret(fixture.namespace.id, "selected-pat", accessToken);
  const account = await fixture.createAccountWithPolicy(
    "unsupported-discovery-creator",
    (principal) => {
      grantRole(fixture.policy, principal.id, {
        id: "unsupported-discovery-agent-create",
        bindingId: "unsupported-discovery-agent-create-binding",
        namespaceId: fixture.namespace.id,
        permissions: { agent: ["create"] },
        resource: undefined,
      });
    },
  );
  const session = await fixture.signIn(account.credentials);
  // An unsupported PluginDriver must never ask the Secret backend for the value.
  const readsBefore = secretValueReadCount(fixture.secretDriver);
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ] as const) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { harnessId: "codex", secretRef: secret.ref, ...extra },
    });
    assert.equal(denied.status, 403);
    const denial = fixture.auditSink.events.at(-1);
    assert.ok(denial);
    assert.deepEqual(denial.authorization, {
      principalId: account.principal.id,
      action: "operate",
      resource: secret.ref,
    });
    assert.equal(denial.kind, "authorization_denial");
  }
  grantRole(fixture.policy, account.principal.id, {
    id: "unsupported-discovery-secret-operator",
    bindingId: "unsupported-discovery-secret-binding",
    namespaceId: fixture.namespace.id,
    permissions: { secret: ["operate"] },
    resource: { kind: "secret", id: secret.id },
  });
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ] as const) {
    const unsupported = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { harnessId: "codex", secretRef: secret.ref, ...extra },
    });
    assert.equal(unsupported.status, 501);
    assert.equal(
      fixture.fixtureResponse(unsupported, 501, ErrorResponse, "unsupported").error.code,
      "NOT_IMPLEMENTED",
    );
  }
  assert.equal(secretValueReadCount(fixture.secretDriver), readsBefore);
}

export async function rechecksSelectedSecretGrant(t: TestContext) {
  const fixture = await createFixture(t);
  const secret = await fixture.createSecret(fixture.namespace.id, "revoked-pat", accessToken);
  const account = await fixture.createAccountWithPolicy("discovery-revoked", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "revoked-discovery-agent-create",
      bindingId: "revoked-discovery-agent-create-binding",
      namespaceId: fixture.namespace.id,
      permissions: { agent: ["create"] },
      resource: undefined,
    });
    grantRole(fixture.policy, principal.id, {
      id: "revoked-discovery-secret-operator",
      bindingId: "revoked-discovery-secret-binding",
      namespaceId: fixture.namespace.id,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: secret.id },
    });
  });
  const session = await fixture.signIn(account.credentials);
  const withValue = fixture.secretDriver.withValue.bind(fixture.secretDriver);
  let secretReads = 0;
  fixture.secretDriver.withValue = (source, use) =>
    withValue(source, (value) => {
      secretReads++;
      // Revoke the caller's Secret grant after the backend yields the value, before the
      // stored credential is sent to the external catalog.
      const index = fixture.policy.bindings.findIndex(
        (binding) => binding.id === "revoked-discovery-secret-binding",
      );
      if (index !== -1) {
        fixture.policy.bindings.splice(index, 1);
      }
      return use(value);
    });

  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ] as const) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { harnessId: "codex", secretRef: secret.ref, ...extra },
    });
    // The first request reads the value and is then refused; the second is refused before it.
    assertApiError(denied, 403, "FORBIDDEN");
  }
  assert.equal(secretReads, 1);
  assert.deepEqual(fixture.calls, []);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(accessToken), false);
}

export async function usesSameNamespaceSecret(t: TestContext) {
  const fixture = await createFixture(t);
  const stored = await fixture.request("POST", `/namespaces/${fixture.namespace.id}/secrets`, {
    body: { name: "discovery-pat", value: accessToken },
  });
  const secret = fixture.fixtureResponse(
    stored,
    201,
    SecretResponse,
    "create discovery Secret",
  ).data;
  for (const [suffix, extra, schema, expected] of [
    ["", {}, AgentPluginCatalogResponse, { plugins: [catalogEntry], nextCursor: "second-page" }],
    ["/details", { pluginId: remoteId }, AgentPluginDetailsResponse, pluginDetails],
  ] as const) {
    const response = await fixture.request("POST", `${fixture.path}${suffix}`, {
      body: { harnessId: "codex", secretRef: secret.ref, ...extra },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      fixture.fixtureResponse(response, 200, schema, "same-Namespace Secret discovery").data,
      expected,
    );
    assert.equal(JSON.stringify(response.body).includes(accessToken), false);
  }
  assert.deepEqual(fixture.calls, [
    { operation: "list", input: { accessToken } },
    { operation: "details", input: { accessToken, pluginId: remoteId } },
  ]);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(accessToken), false);
}

export async function usesCurrentHostedCredential(t: TestContext) {
  const { logger, logs } = createDiscoveryLogger();
  const fixture = await createFixture(t, { logger });
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const secret = await fixture.createSecret(fixture.namespace.id, "hosted-pat", accessToken);
  const rotated = "at-rotated-private-fixture";
  const originalFetch = globalThis.fetch;
  const credentials: string[] = [];
  const catalogRequests: { path: string; q: string | null }[] = [];
  let echoCredential = false;
  const plugin = {
    id: "remote-fixture",
    name: "fixture",
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: {
      display_name: "Fixture",
      description: "Hosted fixture",
      interface: {},
      requires_local_executor: true,
      app_ids: ["fixture-app"],
      app_manifest: null,
      skills: [{ name: "knowledge-workflow" }],
      mcp_servers: [],
    },
  };
  // Replace only provider HTTP; the actual routes, IAM, Secret and Plugin Drivers execute.
  const fetchProvider: typeof fetch = async (url, init) => {
    const address = fetchUrl(url).href;
    if (
      !address.startsWith("https://auth.openai.com/") &&
      !address.startsWith("https://chatgpt.com/backend-api/ps/")
    ) {
      return originalFetch(url, init);
    }
    const headers = new Headers(
      init?.headers ?? (url instanceof Request ? url.headers : undefined),
    );
    const authorization = headers.get("authorization");
    assert.ok(authorization && authorization.startsWith("Bearer "));
    const token = authorization.slice("Bearer ".length);
    credentials.push(token);
    if (token === "at-revoked-private-fixture") {
      return Response.json({ error: token }, { status: 401 });
    }
    if (address.includes("/whoami")) {
      return Response.json({
        chatgpt_account_id: "account-fixture",
        chatgpt_account_is_fedramp: false,
      });
    }
    assert.equal(headers.get("chatgpt-account-id"), "account-fixture");
    if (address.includes("plugins/list") || address.includes("plugins/search")) {
      const request = new URL(address);
      catalogRequests.push({ path: request.pathname, q: request.searchParams.get("q") });
      return Response.json({
        plugins: [
          {
            ...plugin,
            release: { ...plugin.release, display_name: echoCredential ? token : "Fixture" },
          },
        ],
        pagination: { next_page_token: null },
      });
    }
    if (address.includes("plugins/remote-fixture")) {
      return Response.json({
        ...plugin,
        release: { ...plugin.release, display_name: echoCredential ? token : "Fixture" },
      });
    }
    assert.ok(address.endsWith("apps/batch"));
    return Response.json({
      apps: [
        {
          id: "fixture-app",
          status: "ENABLED",
          tools: [{ name: "search", title: "Search", is_enabled: true, is_read_only: true }],
        },
      ],
    });
  };
  t.mock.method(globalThis, "fetch", fetchProvider);

  const list = await fixture.request("POST", fixture.path, {
    body: { harnessId: "codex", secretRef: secret.ref, q: "fixture" },
  });
  const page = fixture.fixtureResponse(
    list,
    200,
    AgentPluginCatalogResponse,
    "hosted catalog",
  ).data;
  const listed = page.plugins[0];
  assert.ok(listed);
  assert.equal(listed.remoteId, "remote-fixture");
  assert.equal(listed.available, true);
  assert.deepEqual(catalogRequests, [{ path: "/backend-api/ps/plugins/search", q: "fixture" }]);
  const details = await fixture.request("POST", `${fixture.path}/details`, {
    body: { harnessId: "codex", secretRef: secret.ref, pluginId: "remote-fixture" },
  });
  const discovered = fixture.fixtureResponse(
    details,
    200,
    AgentPluginDetailsResponse,
    "hosted plugin details",
  ).data;
  assert.equal(discovered.available, true);
  const discoveredTool = discovered.tools?.[0];
  assert.ok(discoveredTool);
  assert.equal(discoveredTool.id, "fixture-app/search");
  assert.ok(credentials.length > 0);
  assert.equal(
    credentials.every((value) => value === accessToken),
    true,
  );

  // Skills must not prevent a discovered plugin from entering a real Agent revision.
  const agent = await fixture.createAgent(
    fixture.namespace.id,
    "Knowledge agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated" },
  );
  const plugins = { [discovered.id]: { enabled: true } };
  await fixture.updateAgent(fixture.namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins,
  });
  const revision = await fixture.deployAgent(fixture.namespace.id, agent.id);
  assert.deepEqual(revision.plugins?.plugins, plugins);

  // A discovered policy must reach the raw native tool despite its renamed prefix.
  const artifact = codexRuntimeArtifact(
    {
      [discovered.id]: {
        enabled: true,
        tools: { [discoveredTool.id]: { enabled: true, approval: "all_actions" } },
      },
    },
    [
      {
        plugin: {
          summary: {
            id: "fixture@openai-curated-remote",
            remotePluginId: plugin.id,
            version: "1.0.0",
          },
          apps: [{ id: "fixture-app" }],
          skills: [{ name: "knowledge-workflow" }],
          hooks: [],
          mcpServers: [],
        },
      },
    ],
    [],
    [
      {
        name: "codex_apps",
        tools: {
          "renamed_123.search": {
            name: "renamed_123.search",
            inputSchema: { type: "object", properties: {} },
            _meta: {
              connector_id: "fixture-app",
              _codex_apps: { resource_uri: "/fixture-app/link_fixture/search" },
            },
          },
        },
      },
    ],
  );
  const apps = artifact.configuration.apps;
  assert.ok(typeof apps === "object" && apps !== null && "fixture-app" in apps);
  const app = apps["fixture-app"];
  assert.ok(typeof app === "object" && app !== null && "tools" in app);
  assert.deepEqual(app.tools, {
    "renamed_123.search": { enabled: true, approval_mode: "prompt" },
  });
  // Skill-only plugins are available with a known empty tool inventory.
  plugin.release.app_ids = [];
  const skillsOnly = await fixture.request("POST", `${fixture.path}/details`, {
    body: { harnessId: "codex", secretRef: secret.ref, pluginId: "remote-fixture" },
  });
  const skillPlugin = fixture.fixtureResponse(
    skillsOnly,
    200,
    AgentPluginDetailsResponse,
    "skill-only plugin details",
  ).data;
  assert.equal(skillPlugin.available, true);
  assert.deepEqual(skillPlugin.tools, []);

  // Rotation is observed by the next request without persisting the old or new value in discovery state.
  const updatePath = `/namespaces/${fixture.namespace.id}/secrets/${secret.id}`;
  assert.equal(
    (await fixture.request("PATCH", updatePath, { body: { value: rotated } })).status,
    200,
  );
  credentials.length = 0;
  assert.equal(
    (
      await fixture.request("POST", fixture.path, {
        body: { harnessId: "codex", secretRef: secret.ref },
      })
    ).status,
    200,
  );
  assert.ok(credentials.length > 0 && credentials.every((value) => value === rotated));

  echoCredential = true;
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: "remote-fixture" }],
  ] as const) {
    const response = await fixture.request("POST", `${fixture.path}${suffix}`, {
      body: { harnessId: "codex", secretRef: secret.ref, ...extra },
    });
    assert.equal(
      fixture.fixtureResponse(response, 503, ErrorResponse, "response").error.code,
      "PLUGIN_DISCOVERY_INVALID_RESPONSE",
    );
    assert.equal(JSON.stringify(response.body).includes(rotated), false);
  }
  echoCredential = false;
  for (const [value, code] of [
    ["not-a-pat", "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED"],
    ["at-revoked-private-fixture", "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED"],
  ] as const) {
    assert.equal((await fixture.request("PATCH", updatePath, { body: { value } })).status, 200);
    const response = await fixture.request("POST", fixture.path, {
      body: { harnessId: "codex", secretRef: secret.ref },
    });
    assert.equal(
      fixture.fixtureResponse(response, 400, ErrorResponse, "rejected credential").error.code,
      code,
    );
    assert.equal(JSON.stringify(response.body).includes(value), false);
  }
  const persisted = await fixture.controller.transact((unit) =>
    unit.secrets.findSecret(fixture.namespace.id, secret.id),
  );
  assert.doesNotMatch(
    JSON.stringify(persisted),
    /at-plugin-discovery-private-fixture|at-rotated-private-fixture|at-revoked-private-fixture/,
  );
  const deletion = await fixture.rawRequest("DELETE", updatePath, {
    headers: authenticatedHeaders(await fixture.signIn()),
  });
  assert.equal(deletion.response.status, 204);
  const deleted = await fixture.request("POST", fixture.path, {
    body: { harnessId: "codex", secretRef: secret.ref },
  });
  assert.equal(deleted.status, 404);
  assert.doesNotMatch(
    JSON.stringify([list.body, details.body, deleted.body, fixture.auditSink.events, logs]),
    /at-plugin-discovery-private-fixture|at-rotated-private-fixture|at-revoked-private-fixture/,
  );
}

export async function requiresExactSecretGrantAndOwnership(t: TestContext) {
  const fixture = await createFixture(t);
  const secret = await fixture.createSecret(fixture.namespace.id, "selected-pat", accessToken);
  const another = await fixture.createSecret(
    fixture.namespace.id,
    "other-pat",
    "at-other-private-fixture",
  );
  const otherNamespace = await fixture.createNamespace("Other Namespace", { ready: true });
  const foreign = await fixture.createSecret(
    otherNamespace.id,
    "foreign-pat",
    "at-foreign-private-fixture",
  );
  const account = await fixture.createAccountWithPolicy("discovery-creator", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "discovery-agent-create",
      bindingId: "discovery-agent-create-binding",
      namespaceId: fixture.namespace.id,
      permissions: { agent: ["create"] },
      resource: undefined,
    });
  });
  const session = await fixture.signIn(account.credentials);
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ] as const) {
    const denied = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { harnessId: "codex", secretRef: secret.ref, ...extra },
    });
    assert.equal(denied.status, 403);
    const evidence = fixture.auditSink.events.at(-1);
    assert.ok(evidence);
    assert.equal(evidence.kind, "authorization_denial");
    assert.deepEqual(evidence.authorization, {
      principalId: account.principal.id,
      action: "operate",
      resource: secret.ref,
    });
  }
  assert.deepEqual(fixture.calls, []);
  grantRole(fixture.policy, account.principal.id, {
    id: "selected-secret-operator",
    bindingId: "selected-secret-binding",
    namespaceId: fixture.namespace.id,
    permissions: { secret: ["operate"] },
    resource: { kind: "secret", id: secret.id },
  });
  assert.equal(
    (
      await fixture.request("POST", fixture.path, {
        session,
        body: { harnessId: "codex", secretRef: secret.ref },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fixture.request("POST", fixture.path, {
        session,
        body: { harnessId: "codex", secretRef: another.ref },
      })
    ).status,
    403,
  );
  fixture.calls.length = 0;
  // A reference to another Namespace breaks a static rule, so it is an invalid request with
  // that rule's message; a Secret this Namespace does not hold stays a not-found.
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ] as const) {
    for (const [description, ref, status, code, message] of [
      [
        "cross-Namespace Secret",
        foreign.ref,
        400,
        "INVALID_REQUEST",
        "Secret references cannot cross Namespaces.",
      ],
      [
        "missing Secret",
        { ...foreign.ref, namespaceId: fixture.namespace.id },
        404,
        "NOT_FOUND",
        undefined,
      ],
    ] as const) {
      const response = await fixture.request("POST", `${fixture.path}${suffix}`, {
        body: { harnessId: "codex", secretRef: ref, ...extra },
      });
      const label = `${suffix || "list"} secretRef, ${description}: ${JSON.stringify(response.body)}`;
      assert.equal(response.status, status, label);
      assert.equal(
        fixture.fixtureResponse(response, status, ErrorResponse, label).error.code,
        code,
        label,
      );
      if (message !== undefined) {
        assert.equal(
          fixture.fixtureResponse(response, status, ErrorResponse, label).error.message,
          message,
          label,
        );
      }
    }
  }
  assert.deepEqual(fixture.calls, []);
  for (const body of [
    { accessToken, secretRef: secret.ref },
    { oauthLogin: secret.ref },
    { secretRef: secret.ref, accountId: "untrusted" },
  ]) {
    assert.equal(
      (await fixture.request("POST", fixture.path, { body: { harnessId: "codex", ...body } }))
        .status,
      400,
    );
  }
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(accessToken), false);
}

export async function suppressesSecretBackendErrors(t: TestContext) {
  const secretDriver = createTestSecretDriver();
  const fixture = await createFixture(t, { secretDriver });
  const secret = await fixture.createSecret(fixture.namespace.id, "unavailable-pat", accessToken);
  secretDriver.withValue = async () => {
    throw new Error(`inaccessible ${accessToken}`);
  };
  for (const [suffix, extra] of [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ] as const) {
    const response = await fixture.request("POST", `${fixture.path}${suffix}`, {
      body: { harnessId: "codex", secretRef: secret.ref, ...extra },
    });
    assert.equal(response.status, 503);
    assert.equal(
      fixture.fixtureResponse(response, 503, ErrorResponse, "response").error.code,
      "DEPENDENCY_UNAVAILABLE",
    );
    assert.doesNotMatch(JSON.stringify(response.body), /inaccessible|at-plugin-discovery/);
  }
  assert.deepEqual(fixture.calls, []);
  const withoutValue: SecretDriver = secretDriver;
  delete withoutValue.withValue;
  const unsupported = await fixture.request("POST", fixture.path, {
    body: { harnessId: "codex", secretRef: secret.ref },
  });
  assert.equal(unsupported.status, 503);
  assert.equal(
    (await fixture.request("POST", fixture.path, { body: { harnessId: "codex", accessToken } }))
      .status,
    200,
  );
}
