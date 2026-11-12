import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import {
  AgentCallerPermissionsResponse,
  AgentDeviceAuthorizationResponse,
  AgentPluginCatalogResponse,
  AgentPluginDetailsResponse,
  CredentialSourceListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { Identity } from "../../packages/contracts/src/index.ts";
import { DEVICE_ACCESS_TOKEN } from "../helpers/device-credential-gateway.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { bindRole, grantRole } from "../helpers/iam-grants.mjs";
import {
  assertDeviceAudit,
  assertNoCredentials,
  createFixture,
  devicePluginId,
  readyLogin,
} from "./device-authorization-api-fixture.ts";

export function registerDeviceAuthorizationAgentCases(): void {
  test("Gateway device login saves a source-backed Agent and reuses discovery after closing its login", async (t) => {
    let approved = false;
    const fixture = await createFixture(t, { approve: async () => approved });
    const login = await fixture.start();
    assertDeviceAudit(fixture, "start");
    const startResponse = fixture.responses.at(-1);
    assert.ok(Check(AgentDeviceAuthorizationResponse, startResponse), "start response envelope");
    const startRequestId = startResponse.meta.requestId;
    const sourceId = (await fixture.stored(login)).sourceId;
    const startEvents = fixture.auditSink.events.filter(
      (event) => event.action === "openclaw.agents.device_authorization.start",
    );
    // A completed start records each saved phase once and ties the private session to its source.
    assert.deepEqual(
      startEvents.map((event) => event.details?.phase),
      ["source_registering", "source_ready", "session_pending"],
    );
    for (const event of startEvents) {
      assert.equal(event.actorId, fixture.principal.id);
      assert.equal(event.requestId, startRequestId);
      const { details } = event;
      assert.ok(details, "start audit must identify the source and phase");
      assert.equal(details.sourceId, sourceId);
      assert.deepEqual(event.resource, {
        kind: details.phase === "session_pending" ? "agent" : "credential_source",
        id: details.phase === "session_pending" ? fixture.namespace.id : sourceId,
        namespaceId: fixture.namespace.id,
      });
    }
    assert.equal(login.verificationUrl, "https://auth.openai.com/codex/device");
    assert.equal(login.intervalSeconds, 5);
    const earlyPoll = await fixture.poll(login);
    const early = fixture.fixtureResponse(
      earlyPoll,
      200,
      AgentDeviceAuthorizationResponse,
      "poll before the device interval",
    ).data;
    assert.equal(early.status, "pending");
    assert.equal(
      fixture.gateway.calls.some((call) => call.operation === "pollDeviceAuthorization"),
      false,
    );
    const audited = fixture.auditSink.events.length;
    await fixture.clock.advance(5000);
    const pendingPoll = await fixture.poll(login);
    const pending = fixture.fixtureResponse(
      pendingPoll,
      200,
      AgentDeviceAuthorizationResponse,
      "poll before device approval",
    ).data;
    assert.equal(pending.status, "pending");
    assert.equal(
      fixture.auditSink.events.length,
      audited,
      "pending polls are not audited transitions",
    );
    approved = true;
    await fixture.clock.advance(5000);
    const readyPoll = await fixture.poll(login);
    const ready = fixture.fixtureResponse(
      readyPoll,
      200,
      AgentDeviceAuthorizationResponse,
      "poll after device approval",
    ).data;
    assert.equal(ready.status, "ready");
    assert.equal(ready.source?.kind, "credential_source");
    assertDeviceAudit(fixture, "poll");
    const stored: Record<string, unknown> = await fixture.stored(login);
    assert.equal(stored.sourceId, ready.source.id);
    assert.equal(stored.version, 2);
    assert.equal(stored.credentialGatewayId, fixture.gateway.id);
    assert.equal(stored.credentialRefreshId, fixture.refresh.id);
    assert.equal(stored.privateState, undefined);
    assert.equal(stored.credential, undefined);
    assert.equal(JSON.stringify(stored).includes(DEVICE_ACCESS_TOKEN), false);

    const list = await fixture.request("POST", fixture.pluginsPath, {
      body: { harnessId: "codex", credentialSource: ready.source, q: "knowledge" },
    });
    const catalog = fixture.fixtureResponse(
      list,
      200,
      AgentPluginCatalogResponse,
      "discover plugins",
    );
    assert.equal(catalog.data.plugins[0]?.remoteId, devicePluginId);
    const details = await fixture.request("POST", `${fixture.pluginsPath}/details`, {
      body: { harnessId: "codex", credentialSource: ready.source, pluginId: devicePluginId },
    });
    const pluginDetails = fixture.fixtureResponse(
      details,
      200,
      AgentPluginDetailsResponse,
      "discover plugin details",
    );
    assert.equal(pluginDetails.data.tools?.[0]?.id, "fixture-app/search");

    const harnessAuth = { method: "credential_source", sourceId: ready.source.id };
    const agent = await fixture.createAgent(
      fixture.namespace.id,
      "OAuth Agent",
      createHarnessConfiguration("codex", "gpt-5.1"),
      {
        executionMode: "dedicated",
        harnessAuth,
        credentialSources: [{ sourceId: harnessAuth.sourceId }],
      },
    );
    const identities: Identity[] = fixture.policy.identities;
    identities.push({
      id: agent.servicePrincipalId,
      kind: "service_principal",
      namespaceId: agent.namespaceId,
      agentId: agent.id,
    });
    grantRole(fixture.policy, agent.servicePrincipalId, {
      id: "agent-source",
      namespaceId: fixture.namespace.id,
      permissions: { credential_source: ["operate"] },
      resource: ready.source,
    });
    const plugins = {
      [pluginDetails.data.id]: {
        enabled: true,
        tools: { "fixture-app/search": { enabled: true } },
      },
    };
    const updated = await fixture.updateAgent(fixture.namespace.id, agent.id, {
      configurationId: agent.configurationId,
      plugins,
    });
    const revision = await fixture.deployAgent(fixture.namespace.id, agent.id);
    assert.deepEqual(updated.harnessAuth, harnessAuth);
    assert.deepEqual(revision.harnessAuth, harnessAuth);
    assert.deepEqual(revision.plugins?.plugins, plugins);
    fixture.responses.push(agent, updated, revision);

    // Closing the UI login erases only its opaque handle. The source remains usable
    // by the saved Agent without another login, including after the handle expires.
    const closed = await fixture.request("DELETE", `${fixture.path}/${login.session.id}`);
    assert.equal(closed.status, 204);
    assertDeviceAudit(fixture, "cancel");
    assert.equal((await fixture.poll(login)).status, 409);
    await fixture.clock.advance(24 * 60 * 60 * 1000);
    const saved = await fixture.request(
      "POST",
      `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins`,
      { body: { q: "knowledge" } },
    );
    const savedCatalog = fixture.fixtureResponse(
      saved,
      200,
      AgentPluginCatalogResponse,
      "discover plugins for the saved Agent",
    );
    assert.equal(savedCatalog.data.plugins[0]?.remoteId, devicePluginId);
    assert.equal(
      fixture.gateway.calls.filter((call) => call.operation === "startDeviceAuthorization").length,
      1,
    );
    assert.equal(fixture.gateway.sources.get(ready.source.id), "ready");
    assert.equal(
      fixture.gateway.calls.some((call) => call.operation === "removeSource"),
      false,
    );
    const sources = await fixture.request("GET", fixture.sourcesPath);
    const {
      data: [source],
    } = fixture.fixtureResponse(
      sources,
      200,
      CredentialSourceListResponse,
      "list credential sources",
    );
    assert.equal(source?.id, ready.source.id);
    assert.deepEqual(source.secrets, {});
    assertNoCredentials(fixture);
  });

  test("login handles are actor and Agent scoped while source discovery uses exact Namespace operate grants", async (t) => {
    const fixture = await createFixture(t);
    const account = await fixture.createAccountWithPolicy("other-actor", (principal) => {
      grantRole(fixture.policy, principal.id, {
        id: "reader-role",
        namespaceId: fixture.namespace.id,
        permissions: { namespace: ["read"] },
        resource: undefined,
      });
    });
    const otherSession = await fixture.signIn(account.credentials);
    assert.equal(
      (
        await fixture.request("POST", fixture.path, {
          session: otherSession,
          body: { harnessId: "codex" },
        })
      ).status,
      403,
    );
    assert.deepEqual(fixture.gateway.calls, []);
    const [adminRole] = fixture.policy.roles;
    assert.ok(adminRole, "the fixture must provision its administrator role");
    bindRole(fixture.policy, account.principal.id, {
      id: "other-admin-binding",
      roleId: adminRole.id,
      namespaceId: undefined,
      resource: undefined,
    });
    const login = await readyLogin(fixture);
    const before = fixture.gateway.calls.length;
    assert.equal((await fixture.poll(login, fixture.path, otherSession)).status, 404);
    assert.equal(
      (
        await fixture.request("DELETE", `${fixture.path}/${login.session.id}`, {
          session: otherSession,
        })
      ).status,
      404,
    );
    const otherNamespace = await fixture.createNamespace("Other Namespace", { ready: true });
    assert.equal(
      (await fixture.poll(login, `/namespaces/${otherNamespace.id}/agents/device-authorizations`))
        .status,
      404,
    );
    const agent = await fixture.createAgent(
      fixture.namespace.id,
      "Exact Agent",
      createHarnessConfiguration("codex", "gpt-5.1"),
      { executionMode: "dedicated", harnessAuth: null },
    );
    const agentPath = `/namespaces/${fixture.namespace.id}/agents/${agent.id}/device-authorizations`;
    assert.equal((await fixture.poll(login, agentPath)).status, 404);
    assert.equal(
      (await fixture.request("POST", fixture.path, { body: { harnessId: "openclaw" } })).status,
      501,
    );
    assert.equal(
      fixture.gateway.calls.length,
      before,
      "scope refusals must precede external operations",
    );

    // A CredentialSource is independently managed: an authorized second operator
    // may discover with it, but cannot take over the first actor's login handle.
    assert.equal(
      (
        await fixture.request("POST", fixture.pluginsPath, {
          session: otherSession,
          body: { harnessId: "codex", credentialSource: login.source, q: "knowledge" },
        })
      ).status,
      200,
    );
    fixture.policy.bindings = fixture.policy.bindings.filter(
      (binding) => binding.id !== "other-admin-binding",
    );
    grantRole(fixture.policy, account.principal.id, {
      id: "agent-creator",
      namespaceId: fixture.namespace.id,
      permissions: { agent: ["create"] },
      resource: undefined,
    });
    const denied = await fixture.request("POST", fixture.pluginsPath, {
      session: otherSession,
      body: { harnessId: "codex", credentialSource: login.source, q: "knowledge" },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    for (const [credentialSource, status] of [
      [{ ...login.source, namespaceId: otherNamespace.id }, 400],
      [{ ...login.source, id: `cs_${crypto.randomUUID()}` }, 409],
    ] as const) {
      const refused = await fixture.request("POST", fixture.pluginsPath, {
        body: { harnessId: "codex", credentialSource, q: "knowledge" },
      });
      assert.equal(refused.status, status, JSON.stringify(refused.body));
    }
    const savedLogin = await readyLogin(fixture, agentPath);
    assertDeviceAudit(fixture, "start", agent.id);
    assertDeviceAudit(fixture, "poll", agent.id);
    assert.equal((await fixture.poll(savedLogin)).status, 404);
    assert.equal(
      (await fixture.request("DELETE", `${agentPath}/${savedLogin.session.id}`)).status,
      204,
    );
    assertDeviceAudit(fixture, "cancel", agent.id);
    assertNoCredentials(fixture);
  });

  // Each Agent update checks credential source operate on every source the Agent lists, so the
  // caller permissions answer for Agent saves covers them (finding 2441); the same real PATCH
  // proves each answer. The Harness source and a second listed source have distinct ids, so the
  // answer is shown to cover the listed sources and not only the Harness one.
  test("the Agent sources answer covers the credential sources an Agent update checks", async (t) => {
    const fixture = await createFixture(t);
    const login = await readyLogin(fixture);
    const listed = await readyLogin(fixture);
    assert.notEqual(listed.source.id, login.source.id);
    const harnessAuth = { method: "credential_source", sourceId: login.source.id };
    const agent = await fixture.createAgent(
      fixture.namespace.id,
      "Source editor Agent",
      createHarnessConfiguration("codex", "gpt-5.1"),
      {
        executionMode: "dedicated",
        harnessAuth,
        credentialSources: [{ sourceId: login.source.id }, { sourceId: listed.source.id }],
      },
    );
    const account = await fixture.createAccountWithPolicy("source-editor", (principal) => {
      grantRole(fixture.policy, principal.id, {
        id: "source-editor-role",
        namespaceId: fixture.namespace.id,
        permissions: { namespace: ["read"], agent: ["read", "update"], configuration: ["read"] },
        resource: undefined,
      });
    });
    const session = await fixture.signIn(account.credentials);
    const agentPath = `/namespaces/${fixture.namespace.id}/agents/${agent.id}`;
    const answer = async () => {
      const response = await fixture.request("GET", `${agentPath}/permissions`, { session });
      return fixture.fixtureResponse(
        response,
        200,
        AgentCallerPermissionsResponse,
        "read Agent caller permissions",
      ).data.agentSourcesOperate;
    };
    const save = () =>
      fixture.request("PATCH", agentPath, {
        session,
        body: { configurationId: agent.configurationId },
      });
    // Agent update and Configuration read, but no operate on the bound sources.
    assert.equal(await answer(), false);
    assert.equal((await save()).status, 403);
    // Operate on the Harness source only: the other listed source still refuses the update.
    grantRole(fixture.policy, account.principal.id, {
      id: "source-editor-source",
      namespaceId: fixture.namespace.id,
      permissions: { credential_source: ["operate"] },
      resource: login.source,
    });
    assert.equal(await answer(), false);
    assert.equal((await save()).status, 403);
    grantRole(fixture.policy, account.principal.id, {
      id: "source-editor-listed-source",
      namespaceId: fixture.namespace.id,
      permissions: { credential_source: ["operate"] },
      resource: listed.source,
    });
    assert.equal(await answer(), true);
    const saved = await save();
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  });
}
