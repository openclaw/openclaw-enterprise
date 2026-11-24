import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentCallerPermissionsResponse,
  AgentDeviceAuthorizationResponse,
  AgentRevisionResponse,
  CredentialSourceListResponse,
  CredentialSourceResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { bindRole, grantRole } from "../helpers/iam-grants.ts";
import {
  assertDeviceAudit,
  assertNoCredentials,
  createFixture,
  readyLogin,
} from "./device-authorization-api-fixture.ts";

export function registerDeviceAuthorizationAgentCases(): void {
  test("Codex device login creates a canonical OAuth Source only after the grant", async (t) => {
    let approved = false;
    const fixture = await createFixture(t, { approve: async () => approved });
    const login = await fixture.start();
    assertDeviceAudit(fixture, "start");
    assert.equal((await fixture.stored(login)).sourceId, undefined);
    const list = async () =>
      fixture.fixtureResponse(
        await fixture.request("GET", fixture.sourcesPath),
        200,
        CredentialSourceListResponse,
        "list Sources",
      ).data;
    assert.deepEqual(await list(), [], "starting login creates only temporary state");
    const early = fixture.fixtureResponse(
      await fixture.poll(login),
      200,
      AgentDeviceAuthorizationResponse,
      "early poll",
    ).data;
    assert.equal(early.status, "pending");
    assert.deepEqual(fixture.issuer.operations, ["start"]);
    await fixture.clock.advance(5000);
    assert.equal(
      fixture.fixtureResponse(
        await fixture.poll(login),
        200,
        AgentDeviceAuthorizationResponse,
        "pending poll",
      ).data.status,
      "pending",
    );
    assert.deepEqual(await list(), []);
    approved = true;
    await fixture.clock.advance(5000);
    const ready = fixture.fixtureResponse(
      await fixture.poll(login),
      200,
      AgentDeviceAuthorizationResponse,
      "approved poll",
    ).data;
    assert.equal(ready.status, "ready");
    assert.ok(ready.source);
    assertDeviceAudit(fixture, "poll");
    assert.deepEqual(fixture.issuer.operations, ["start", "poll", "poll", "exchange"]);
    const source = (await list()).find((entry) => entry.id === ready.source?.id);
    assert.equal(source?.type, "oauth2-refresh-token");
    assert.equal(source?.state, "ready");
    assert.ok(
      source &&
        "consent" in source &&
        source.type === "oauth2-refresh-token" &&
        source.consent.kind === "builtin_codex",
    );
    assert.deepEqual(
      { issuer: source.consent.issuer, tokenUrl: source.consent.tokenUrl },
      { issuer: "https://auth.openai.com", tokenUrl: "https://auth.openai.com/oauth/token" },
    );
    assert.ok(source.consent.clientId);
    const fetched = fixture.fixtureResponse(
      await fixture.request("GET", `${fixture.sourcesPath}/${source.id}`),
      200,
      CredentialSourceResponse,
      "read completed Codex Source",
    ).data;
    assert.equal(fetched.type, "oauth2-refresh-token");
    assert.ok("consent" in fetched && fetched.type === "oauth2-refresh-token");
    assert.deepEqual(fetched.consent, source.consent, "read and list derive the same fixed preset");
    assert.equal((await fixture.stored(login)).sourceId, ready.source.id);
    assert.equal(
      (await fixture.request("DELETE", `${fixture.path}/${login.session.id}`)).status,
      204,
    );
    assertDeviceAudit(fixture, "cancel");
    assert.equal((await fixture.poll(login)).status, 409);
    assert.equal(
      (await list()).some((entry) => entry.id === ready.source?.id),
      true,
      "closing a ready login retains its Source",
    );
    assertNoCredentials(fixture);
  });

  test("a completed Codex OAuth Source admits only the authorized native model routes", async (t) => {
    const grant = {
      id: "codex-model",
      binary:
        "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
      host: "chatgpt.com",
      ports: [{ from: 443, to: 443 }],
    };
    const fixture = await createFixture(t, { native: true, ceiling: [grant] });
    const login = await readyLogin(fixture);
    const auth = { method: "credential_source", sourceId: login.source.id };
    const agent = await fixture.createAgent(
      fixture.namespace.id,
      "OAuth Agent",
      createHarnessConfiguration("codex", "gpt-5.1"),
      {
        executionMode: "dedicated",
        harnessAuth: auth,
        credentialSources: [{ sourceId: login.source.id }],
      },
    );
    assert.deepEqual(agent.harnessAuth, auth);
    assert.ok(agent.servicePrincipalId);
    // This fixture's Native IAM Driver reads its configured identity and exact bindings.
    fixture.policy.identities.push({
      id: agent.servicePrincipalId,
      kind: "service_principal",
      namespaceId: agent.namespaceId,
      agentId: agent.id,
    });
    grantRole(fixture.policy, agent.servicePrincipalId, {
      id: "codex-agent-source",
      namespaceId: fixture.namespace.id,
      permissions: { credential_source: ["operate"] },
      resource: login.source,
    });
    const agentPath = `/namespaces/${fixture.namespace.id}/agents/${agent.id}`;
    const refused = await fixture.request("POST", `${agentPath}/deploy`, { body: {} });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(
      (
        await fixture.request("PATCH", `${agentPath}/sandbox-policy/networking/editing`, {
          body: { enabled: true },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fixture.request("PUT", `${agentPath}/sandbox-policy/networking`, {
          body: { expectedVersion: 1, additions: [grant] },
        })
      ).status,
      200,
    );
    const deployment = await fixture.request("POST", `${agentPath}/deploy`, { body: {} });
    assert.equal(deployment.status, 202, JSON.stringify(deployment.body));
    const publicRevision = fixture.fixtureResponse(
      deployment,
      202,
      AgentRevisionResponse,
      "admit Codex Source deployment",
    ).data;
    const deployed = await fixture.state.read((view) =>
      view.revisions.findRevision(fixture.namespace.id, agent.id, publicRevision.id),
    );
    assert.ok(deployed);
    assert.equal(deployed.credentialDeployment?.bindings.length, 1);
    assert.deepEqual(
      deployed.credentialDeployment?.injectionPolicies[0]?.allowedRequests.map(
        ({ binary, host, requestPolicy }) => [binary, host, requestPolicy],
      ),
      [
        [
          grant.binary,
          grant.host,
          { type: "http", method: "POST", path: "/backend-api/codex/responses" },
        ],
        [
          grant.binary,
          grant.host,
          { type: "http", method: "GET", path: "/backend-api/wham/accounts/check" },
        ],
        [
          grant.binary,
          grant.host,
          { type: "http", method: "GET", path: "/backend-api/wham/config/bundle" },
        ],
      ],
    );
    // Source deletion cannot revoke a credential that this admitted Agent still needs.
    const custody = await fixture.state.read((view) =>
      view.oauthCredentials.findTokenCustody(fixture.namespace.id, login.source.id),
    );
    assert.ok(custody);
    const deletion = await fixture.request("DELETE", `${fixture.sourcesPath}/${login.source.id}`);
    assert.equal(deletion.status, 409, JSON.stringify(deletion.body));
    const retained = await fixture.state.read((view) =>
      view.credentialSources.findCredentialSource(fixture.namespace.id, login.source.id),
    );
    assert.equal(retained?.state, "ready");
    assert.ok(
      retained?.ownerCapability === "token_service" && retained.type === "oauth2-refresh-token",
    );
    assert.equal(retained.consent.revocationRequestedBy, undefined);
    assert.deepEqual(
      await fixture.state.read((view) =>
        view.oauthCredentials.findTokenCustody(fixture.namespace.id, login.source.id),
      ),
      custody,
    );
    assert.equal(
      fixture.secretDriver.calls.some(
        (call) => call.operation === "delete" && call.secret.id === custody.secret.id,
      ),
      false,
    );
    assertNoCredentials(fixture);
  });

  test("login handles remain actor, Namespace and Agent scoped before issuer I/O", async (t) => {
    const fixture = await createFixture(t);
    const other = await fixture.createAccountWithPolicy("other-actor", (principal) =>
      grantRole(fixture.policy, principal.id, {
        id: "other-reader",
        namespaceId: fixture.namespace.id,
        permissions: { namespace: ["read"] },
      }),
    );
    const session = await fixture.signIn(other.credentials);
    assert.equal(
      (await fixture.request("POST", fixture.path, { session, body: { harnessId: "codex" } }))
        .status,
      403,
    );
    assert.deepEqual(fixture.issuer.operations, []);
    const [admin] = fixture.policy.roles;
    assert.ok(admin);
    bindRole(fixture.policy, other.principal.id, { id: "other-admin", roleId: admin.id });
    const login = await fixture.start();
    const before = [...fixture.issuer.operations];
    assert.equal((await fixture.poll(login, fixture.path, session)).status, 404);
    assert.equal(
      (await fixture.request("DELETE", `${fixture.path}/${login.session.id}`, { session })).status,
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
    const path = `/namespaces/${fixture.namespace.id}/agents/${agent.id}/device-authorizations`;
    assert.equal((await fixture.poll(login, path)).status, 404);
    assert.deepEqual(fixture.issuer.operations, before);
    const saved = await readyLogin(fixture, path);
    assertDeviceAudit(fixture, "start", agent.id);
    assertDeviceAudit(fixture, "poll", agent.id);
    assert.equal((await fixture.poll(saved)).status, 404);
    assert.equal((await fixture.request("DELETE", `${path}/${saved.session.id}`)).status, 204);
    assertDeviceAudit(fixture, "cancel", agent.id);
    assertNoCredentials(fixture);
  });

  test("starting and finishing device login require exact Agent and Source creation authority without session Secret grants", async (t) => {
    const fixture = await createFixture(t);
    const operator = await fixture.createAccountWithPolicy("device-operator", (principal) =>
      grantRole(fixture.policy, principal.id, {
        id: "device-operator",
        permissions: { agent: ["create"], credential_source: ["create"] },
      }),
    );
    const session = await fixture.signIn(operator.credentials);
    const login = await fixture.start(fixture.path, session);
    const role = fixture.policy.roles.find(({ id }) => id === "device-operator");
    assert.ok(role);
    role.permissions = role.permissions.filter(
      ({ resourceKind }) => resourceKind !== "credential_source",
    );
    await fixture.clock.advance(5000);
    const denied = await fixture.poll(login, fixture.path, session);
    assert.equal(denied.status, 403);
    assert.deepEqual(
      fixture.issuer.operations,
      ["start", "poll", "exchange"],
      "issuer grant precedes the final authority check and Source publication",
    );
    const sources = await fixture.controller.transact((unit) =>
      unit.credentialSources.listCredentialSources(fixture.namespace.id),
    );
    assert.deepEqual(sources, []);
  });

  test("the Agent sources answer checks the Codex Source and each bound Secret", async (t) => {
    const fixture = await createFixture(t, { native: true });
    const login = await readyLogin(fixture);
    const listed = await fixture.createSecret(
      fixture.namespace.id,
      "Bound tool token",
      "synthetic-token",
    );
    const harnessAuth = { method: "credential_source", sourceId: login.source.id };
    const agent = await fixture.createAgent(
      fixture.namespace.id,
      "Source editor Agent",
      createHarnessConfiguration("codex", "gpt-5.1"),
      {
        executionMode: "dedicated",
        harnessAuth,
        credentialSources: [{ sourceId: login.source.id }],
        secretBindings: { EXTERNAL_API_TOKEN: { source: listed.ref, delivery: { type: "env" } } },
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
    // The model Source alone is insufficient when the Configuration also binds a Secret.
    grantRole(fixture.policy, account.principal.id, {
      id: "source-editor-source",
      namespaceId: fixture.namespace.id,
      permissions: { credential_source: ["operate"] },
      resource: login.source,
    });
    assert.equal(await answer(), false);
    assert.equal((await save()).status, 403);
    grantRole(fixture.policy, account.principal.id, {
      id: "source-editor-bound-secret",
      namespaceId: fixture.namespace.id,
      permissions: { secret: ["operate"] },
      resource: listed.ref,
    });
    assert.equal(await answer(), true);
    const saved = await save();
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  });
}
