import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import type { ConnectionTemplate } from "../../packages/contracts/src/index.ts";
import {
  ConnectionTemplateResponse,
  OAuthClientResponse,
} from "../../packages/contracts/src/api/connection-templates.ts";
import { DEVICE_ACCOUNT_ID, DEVICE_OAUTH_ACCESS_TOKEN } from "../helpers/device-token-service.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.ts";
import { startProviderServer } from "../helpers/provider-http-transport.ts";
import { createFixture, readyLogin } from "./device-authorization-api-fixture.ts";

export async function discoversTokenServiceAccountApps(t: TestContext) {
  const fixture = await createFixture(t);
  const login = await readyLogin(fixture);
  fixture.controller.installPluginDrivers([new CodexPluginDriver()]);
  const source = {
    kind: "credential_source" as const,
    namespaceId: fixture.namespace.id,
    id: login.source.id,
  };
  const path = `/namespaces/${fixture.namespace.id}/agents/plugins`;
  const plugin = {
    id: "remote-skill",
    name: "skill",
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: { display_name: "Skill", interface: {}, app_ids: [], skills: [{}], mcp_servers: [] },
  };
  const providerErrors: unknown[] = [];
  const provider = await startProviderServer(t, (request, response) => {
    try {
      assert.equal(request.method, "GET");
      assert.equal(request.headers.authorization, `Bearer ${DEVICE_OAUTH_ACCESS_TOKEN}`);
      assert.equal(request.headers["chatgpt-account-id"], DEVICE_ACCOUNT_ID);
      if (request.url?.startsWith("/backend-api/ps/plugins/list?")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ plugins: [plugin], pagination: { next_page_token: null } }));
      } else if (request.url === "/backend-api/ps/plugins/remote-skill?includeDownloadUrls=true") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(plugin));
      } else {
        throw new Error("Unexpected hosted catalog request");
      }
    } catch (error) {
      providerErrors.push(error);
      response.writeHead(500).end();
    }
  });
  const fetchThroughFixture = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.origin === "https://chatgpt.com"
      ? fetchThroughFixture(
          new URL(url.pathname + url.search, `http://127.0.0.1:${provider.port}`),
          init,
        )
      : fetchThroughFixture(input, init);
  });

  const actor = await fixture.createAccountWithPolicy("apps-reader", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "apps-agent-reader",
      namespaceId: fixture.namespace.id,
      permissions: { agent: ["create", "read", "update"] },
    });
  });
  const session = await fixture.signIn(actor.credentials);
  const selected = { harnessId: "codex", credentialSource: source };
  assert.equal((await fixture.request("POST", path, { session, body: selected })).status, 403);
  assert.equal(provider.requests.length, 0, "Source authorization must precede hosted I/O");
  grantRole(fixture.policy, actor.principal.id, {
    id: "apps-source-reader",
    namespaceId: fixture.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: source,
  });
  // An approved Template/client grant is a valid OAuth Source, but it cannot claim
  // the built-in Codex account provenance required by the hosted Apps catalog.
  const issuer = "https://issuer.example.test";
  const template = fixture.fixtureResponse(
    await fixture.request("POST", "/connection-templates", {
      body: {
        namespaceId: fixture.namespace.id,
        displayName: "External account",
        mode: "manual",
        issuer,
        authorizationUrl: `${issuer}/authorize`,
        tokenUrl: `${issuer}/token`,
        scopes: ["read"],
        destinations: [{ host: "api.example.test", path: "/v1/**" }],
      },
    }),
    201,
    ConnectionTemplateResponse,
    "create OAuth Template",
  ).data as ConnectionTemplate;
  const client = fixture.fixtureResponse(
    await fixture.request("POST", "/oauth-clients", {
      body: {
        namespaceId: fixture.namespace.id,
        issuer,
        tokenUrl: `${issuer}/token`,
        displayName: "External application",
        clientId: "public-fixture-client",
        tokenEndpointAuthMethod: "none",
      },
    }),
    201,
    OAuthClientResponse,
    "register approved OAuth client",
  ).data;
  const approved = fixture.fixtureResponse(
    await fixture.request("GET", `/connection-templates/${template.id}`),
    200,
    ConnectionTemplateResponse,
    "read approved OAuth Template",
  ).data as ConnectionTemplate;
  const templateSource = await fixture.owner.createSource(
    {
      kind: "oauth_refresh_token",
      namespaceId: fixture.namespace.id,
      name: "External OAuth account",
      connectionTemplateId: approved.id,
      consent: {
        kind: "connection_template",
        version: approved.current.version,
        oauthClientId: client.id,
        ownerPrincipalId: actor.principal.id,
      },
      grant: {
        accessToken: "external-access-fixture",
        refreshToken: "external-refresh-fixture",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        requestedScopes: ["read"],
        grantedScopes: ["read"],
      },
    },
    AbortSignal.timeout(5_000),
  );
  const templateRef = { ...source, id: templateSource.id };
  grantRole(fixture.policy, actor.principal.id, {
    id: "apps-template-source-reader",
    namespaceId: fixture.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: templateRef,
  });
  const resolution = t.mock.method(
    fixture.owner,
    "resolveCredential",
    fixture.owner.resolveCredential.bind(fixture.owner),
  );
  const rejectedTemplate = await fixture.request("POST", path, {
    session,
    body: { harnessId: "codex", credentialSource: templateRef },
  });
  assert.equal(rejectedTemplate.status, 409, JSON.stringify(rejectedTemplate.body));
  assert.equal(
    resolution.mock.calls.length,
    0,
    "provenance refusal precedes TokenService resolution",
  );
  assert.equal(provider.requests.length, 0, "a Template grant cannot reach the hosted origin");
  const catalog = await fixture.request("POST", path, { session, body: selected });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.equal(JSON.stringify(catalog.body).includes(DEVICE_OAUTH_ACCESS_TOKEN), false);
  const details = await fixture.request("POST", `${path}/details`, {
    session,
    body: { ...selected, pluginId: plugin.id },
  });
  assert.equal(details.status, 200, JSON.stringify(details.body));

  const agent = await fixture.createAgent(
    fixture.namespace.id,
    "Apps Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    {
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    },
  );
  fixture.policy.identities.push({
    id: agent.servicePrincipalId,
    kind: "service_principal",
    namespaceId: fixture.namespace.id,
    agentId: agent.id,
  });
  const savedPath = `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins`;
  const beforeDenied = provider.requests.length;
  assert.equal((await fixture.request("POST", savedPath, { session, body: {} })).status, 403);
  assert.equal(
    provider.requests.length,
    beforeDenied,
    "Agent service-principal authorization must precede hosted I/O",
  );
  grantRole(fixture.policy, agent.servicePrincipalId, {
    id: "apps-agent-source-reader",
    namespaceId: fixture.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: source,
  });
  const saved = await fixture.request("POST", savedPath, { session, body: {} });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(JSON.stringify(saved.body).includes(DEVICE_OAUTH_ACCESS_TOKEN), false);
  assert.equal(
    (await fixture.request("POST", savedPath, { session, body: { credentialSource: source } }))
      .status,
    200,
  );

  // A caller and service principal having Source authority does not bind it to this Agent.
  const otherLogin = await readyLogin(fixture);
  const otherSource = { ...source, id: otherLogin.source.id };
  for (const [index, principalId] of [actor.principal.id, agent.servicePrincipalId].entries()) {
    grantRole(fixture.policy, principalId, {
      id: `apps-unbound-source-${index}`,
      namespaceId: fixture.namespace.id,
      permissions: { credential_source: ["operate"] },
      resource: otherSource,
    });
  }
  const beforeUnbound = provider.requests.length;
  assert.equal(
    (await fixture.request("POST", savedPath, { session, body: { credentialSource: otherSource } }))
      .status,
    409,
  );
  assert.equal(
    provider.requests.length,
    beforeUnbound,
    "an unbound Source must not reach the hosted origin",
  );
  assert.deepEqual(providerErrors, []);
}
