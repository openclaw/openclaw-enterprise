import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentReadResponse,
  AgentResponse,
  AgentRevisionListResponse,
  ConfigurationResponse,
  ErrorResponse,
  InstallationResponse,
  NamespaceResponse,
  ServiceAccountForceDeletionResponse,
  ServiceAccountListResponse,
  ServiceAccountResponse,
  type ErrorCode,
  type HarnessAuthBinding,
  type ServiceAccountCredential,
} from "../../packages/contracts/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { assertSameAnswer } from "../helpers/refusal-answers.mjs";
import {
  callerDenied,
  SERVICE_ACCOUNT_CROSS_NAMESPACE,
  SERVICE_ACCOUNT_NAME_CONFLICT,
} from "../helpers/refusal-text.mjs";
import {
  createInjectedControllerFixture,
  createServiceAccount,
  identifier,
  injectedRequest,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createInjectedControllerFixture>>;
type Reply = Awaited<ReturnType<typeof injectedRequest>>;

function checkedBody<Schema extends TSchema>(
  reply: Reply,
  status: number,
  schema: Schema,
): Static<Schema> {
  assert.equal(reply.status, status, JSON.stringify(reply.body));
  assert(Check(schema, reply.body), JSON.stringify(reply.body));
  return reply.body;
}

function checkRefusal(reply: Reply, status: number, code: ErrorCode) {
  const { error } = checkedBody(reply, status, ErrorResponse);
  assert.equal(error.code, code, JSON.stringify(error));
  return error;
}

async function setupServiceAccounts({ recordOperations = false } = {}) {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createInjectedControllerFixture(
    { auditSink, recordOperations },
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries, ...options }) {
        assert.equal(backendSummaries, undefined);
        return factory(options);
      },
    },
  );
  const request: FixtureRequest = (method, path, requestOptions) =>
    injectedRequest(fixture.app, method, path, requestOptions);
  const name = "Enterprise development";
  const { data } = checkedBody(
    await request("POST", "/installation/bootstrap", {
      body: { name },
    }),
    201,
    InstallationResponse,
  );
  assert.equal(data.name, name);
  assert.match(data.id, identifier("ins"));
  assert.equal(Number.isNaN(Date.parse(data.createdAt)), false);
  return { fixture, request, auditSink };
}

async function createNamespace(request: FixtureRequest, name: string) {
  const { data } = checkedBody(
    await request("POST", "/namespaces", {
      body: { name },
    }),
    201,
    NamespaceResponse,
  );
  assert.equal(data.name, name);
  assert.match(data.id, identifier("ns"));
  assert.equal(data.status, "provisioning");
  assert.equal(Object.hasOwn(data, "installationId"), false);
  return data;
}

async function createConfiguration(request: FixtureRequest, namespaceId: string) {
  const { data } = checkedBody(
    await request("POST", `/namespaces/${namespaceId}/configurations`, {
      body: { kind: "agent", values: {} },
    }),
    201,
    ConfigurationResponse,
  );
  assert.match(data.id, identifier("cfg"));
  assert.equal(data.namespaceId, namespaceId);
  assert.deepEqual(data.values, {});
  return data;
}

function serviceAccountHarnessAuth(
  namespaceId: string,
  id: string,
): Extract<HarnessAuthBinding, { method: "codex_pat" }> {
  return { method: "codex_pat", source: { kind: "service_account", namespaceId, id } };
}

function assertAssociatedAccount(
  agent: AgentResponse["data"] | AgentReadResponse["data"],
  id: string,
) {
  assert("harnessAuth" in agent);
  const { harnessAuth } = agent;
  assert(harnessAuth?.method === "codex_pat" && harnessAuth.source.kind === "service_account");
  assert.equal(harnessAuth.source.id, id);
}

async function assertBodylessDelete(fixture: Fixture, path: string) {
  const response = await fixture.app.fetch(
    new Request(`https://console.oce.localhost${path}`, {
      method: "DELETE",
      headers: authenticatedHeaders(fixture.session),
    }),
  );
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
}

test("a forced ServiceAccount delete without a ChatGPT Backend removes an account whose token nothing can revoke and audits it", async () => {
  const { fixture, request, auditSink } = await setupServiceAccounts();
  const namespace = await createNamespace(request, "service-account-force-delete");
  const account = await createServiceAccount(request, namespace.id, "orphaned-token");
  const accountsPath = `/namespaces/${namespace.id}/service-accounts`;
  const accountPath = `${accountsPath}/${account.id}`;
  const missingId = "sa_00000000-0000-4000-8000-000000000000";
  const missingPath = `${accountsPath}/${missingId}`;
  // Seed the state left by a previously issued token after the Backend is removed.
  const { controller } = fixture;
  assert(controller);
  await controller.transact((unit) =>
    unit.serviceAccounts.updateCredential(namespace.id, account.id, {
      kind: "access_token",
      secretRef: { name: `account-${account.id.slice(3)}`, key: "token" },
    }),
  );

  // Without force, and with an explicit force=false, deletion still refuses and names both ways out.
  for (const path of [accountPath, `${accountPath}?force=false`]) {
    const refused = await request("DELETE", path);
    const error = checkRefusal(refused, 409, "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED");
    assert.match(error.message, /force the delete and revoke the token at the provider/);
  }
  const malformed = await request("DELETE", `${accountPath}?force=yes`);
  checkRefusal(malformed, 400, "INVALID_REQUEST");

  // Force adds no oracle: a caller without delete gets the same 403 for a real and an unknown
  // account, and the grant holder the usual 404 for an unknown one.
  const outsider = await fixture.createAuthPrincipal("service-account-force-outsider");
  fixture.state.identities.push(outsider.principal);
  assert(outsider.session);
  const denied = await assertSameAnswer(
    async (id: string) => {
      const reply = await request("DELETE", `${accountsPath}/${id}?force=true`, {
        session: outsider.session,
      });
      return { status: reply.status, error: checkRefusal(reply, 403, "FORBIDDEN") };
    },
    [account.id, missingId],
  );
  // The denial names the account ID its request sent, and nothing else about it.
  assert.equal(denied.message, callerDenied("ServiceAccount delete", "ServiceAccount <id>"));
  const unknown = await request("DELETE", `${missingPath}?force=true`);
  assert.equal(unknown.status, 404, JSON.stringify(unknown.body));

  const forced = await request("DELETE", `${accountPath}?force=true`);
  const { data: deleted } = checkedBody(forced, 200, ServiceAccountForceDeletionResponse);
  // The in-memory state keeps no Backend binding, so no binding identity is reported.
  assert.deepEqual(deleted, {
    id: account.id,
    namespaceId: namespace.id,
    revocation: "skipped",
  });
  assert.equal((await request("GET", accountPath)).status, 404);

  const deletion = auditSink.events
    .filter((event) => event.action === "openclaw.service_accounts.delete")
    .at(-1);
  assert(deletion?.kind === "mutation" && deletion.details);
  assert.equal(deletion.outcome, "success");
  assert.equal(deletion.actorId, fixture.principal.id);
  assert.deepEqual(deletion.resource, {
    kind: "service_account",
    id: account.id,
    namespaceId: namespace.id,
  });
  // `revocation` survives audit redaction, which a `tokenRevoked` key would not.
  assert.equal(deletion.details.force, true);
  assert.equal(deletion.details.revocation, "skipped");

  // An account without an issued token never needed revocation: force answers the usual 204.
  const native = await createServiceAccount(request, namespace.id, "native");
  await assertBodylessDelete(fixture, `${accountsPath}/${native.id}?force=true`);
  const nativeEvent = auditSink.events
    .filter((event) => event.action === "openclaw.service_accounts.delete")
    .at(-1);
  assert(nativeEvent?.kind === "mutation" && nativeEvent.details);
  assert.equal(nativeEvent.resource.id, native.id);
  // The requested force is recorded, but nothing was skipped.
  assert.equal(nativeEvent.details.force, true);
  assert.equal(Object.hasOwn(nativeEvent.details, "revocation"), false);
});

test("native ServiceAccounts keep private credential references and cannot admit Harness authentication", async () => {
  const { fixture, request, auditSink } = await setupServiceAccounts({ recordOperations: true });
  const namespace = await createNamespace(request, "service-account-lifecycle");
  const namespacePath = `/namespaces/${namespace.id}`;
  const accountsPath = `${namespacePath}/service-accounts`;
  const agentsPath = `${namespacePath}/agents`;
  const account = await createServiceAccount(request, namespace.id, "model-provider");
  const accountPath = `${accountsPath}/${account.id}`;
  const credentialPath = `${accountPath}/credential`;

  const detail = await request("GET", accountPath);
  assert.deepEqual(checkedBody(detail, 200, ServiceAccountResponse).data, account);

  const configuration = await createConfiguration(request, namespace.id);
  const agentResult = await request("POST", agentsPath, {
    body: {
      name: "service-account-agent",
      configurationId: configuration.id,
      harnessAuth: serviceAccountHarnessAuth(account.namespaceId, account.id),
    },
  });
  const { data: agent } = checkedBody(agentResult, 201, AgentResponse);
  assertAssociatedAccount(agent, account.id);
  const agentPath = `${agentsPath}/${agent.id}`;
  const deploymentPath = `${agentPath}/deploy`;

  // A ready Namespace is insufficient: associated accounts without credentials cannot admit revisions.
  const { controller } = fixture;
  assert(controller);
  await fixture.markNamespaceReady(namespace.id);
  // This Installation has no ChatGPT Backend: issuance is a conflict naming the fix, not an
  // outage, and only after the caller's grant and the account lookup.
  const issuance = await request("POST", `${accountPath}/credentials`, { body: {} });
  const issuanceError = checkRefusal(issuance, 409, "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED");
  assert.equal(
    issuanceError.message,
    "This Installation has no ChatGPT Backend, so it cannot issue service-account credentials. An Installation administrator must configure it and select its ServiceAccount Driver; see https://docs-enterprise.openclaw.org/guides/integrations/chatgpt/",
  );
  const unknownIssuance = await request(
    "POST",
    `${accountsPath}/sa_00000000-0000-4000-8000-000000000000/credentials`,
    { body: {} },
  );
  assert.equal(unknownIssuance.status, 404, JSON.stringify(unknownIssuance.body));
  const issuer = await fixture.createAuthPrincipal("service-account-no-backend-issuer");
  fixture.state.identities.push(issuer.principal);
  assert(issuer.session);
  const deniedIssuance = await request("POST", `${accountPath}/credentials`, {
    body: {},
    session: issuer.session,
  });
  assert.equal(deniedIssuance.status, 403, JSON.stringify(deniedIssuance.body));

  // Without a Backend no account can hold an access token, so deployment names the Backend too.
  const missingCredential = await request("POST", deploymentPath);
  const missingCredentialError = checkRefusal(
    missingCredential,
    409,
    "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED",
  );
  assert.equal(
    missingCredentialError.message,
    "ChatGPT Harness authentication needs an issued access-token credential, and this Installation has no ChatGPT Backend to issue one. An Installation administrator must configure it; see https://docs-enterprise.openclaw.org/guides/integrations/chatgpt/",
  );

  const initialCredential: ServiceAccountCredential = {
    kind: "api_key",
    secretRef: { name: "namespace-provider-source", key: "provider-api-key" },
  };
  const assigned = await request("PATCH", credentialPath, {
    body: initialCredential,
  });
  assert.deepEqual(checkedBody(assigned, 200, ServiceAccountResponse).data.credential, {
    kind: initialCredential.kind,
  });
  assert.deepEqual(
    (await controller.getServiceAccount(fixture.principal.id, namespace.id, account.id)).credential,
    initialCredential,
  );

  const nativeDeployment = await request("POST", deploymentPath);
  const nativeDeploymentError = checkRefusal(
    nativeDeployment,
    409,
    "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED",
  );
  // A PAT source admits only an access-token credential, never an API key in its place.
  assert.match(nativeDeploymentError.message, /needs an issued access-token credential/);

  // OAuth references are representable, but no refresh or OAuth execution exists yet.
  const oauthCredential: ServiceAccountCredential = {
    kind: "oauth_access_token",
    secretRef: { name: "namespace-oauth-source", key: "access-token" },
  };
  const oauthUpdate = await request("PATCH", credentialPath, {
    body: oauthCredential,
  });
  assert.equal(oauthUpdate.status, 200);
  const oauthDeployment = await request("POST", deploymentPath);
  const oauthDeploymentError = checkRefusal(
    oauthDeployment,
    409,
    "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED",
  );
  assert.match(oauthDeploymentError.message, /needs an issued access-token credential/);

  const replacementCredential: ServiceAccountCredential = {
    kind: "api_key",
    secretRef: { name: "namespace-provider-rotated", key: "rotated-api-key" },
  };
  const replaced = await request("PATCH", credentialPath, {
    body: replacementCredential,
  });
  assert.deepEqual(checkedBody(replaced, 200, ServiceAccountResponse).data.credential, {
    kind: replacementCredential.kind,
  });
  assert.deepEqual(
    (await controller.getServiceAccount(fixture.principal.id, namespace.id, account.id)).credential,
    replacementCredential,
  );
  const revisions = await request("GET", `${agentPath}/revisions`);
  assert.deepEqual(checkedBody(revisions, 200, AgentRevisionListResponse).data, []);

  // The caller holds delete on the account, so the conflict names what still depends on it.
  const boundDeletion = await request("DELETE", accountPath);
  const boundDeletionError = checkRefusal(boundDeletion, 409, "RESOURCE_CONFLICT");
  assert.equal(
    boundDeletionError.message,
    "An Agent draft, active revision, pending deployment, or pending Agent provisioning request still references the ServiceAccount. Remove those references, or let provisioning finish, first.",
  );
  // Authorization precedes the reference check: a caller without delete learns nothing about references.
  const outsider = await fixture.createAuthPrincipal("service-account-outsider");
  fixture.state.identities.push(outsider.principal);
  assert(outsider.session);
  const forbidden = await request("DELETE", accountPath, { session: outsider.session });
  checkRefusal(forbidden, 403, "FORBIDDEN");

  const detached = await request("PATCH", agentPath, {
    body: { configurationId: configuration.id, harnessAuth: null },
  });
  assert.equal(checkedBody(detached, 200, AgentResponse).data.harnessAuth, null);

  // Failed admissions create no pending revision that could keep a detached account referenced.
  await assertBodylessDelete(fixture, accountPath);

  const unusedAccount = await createServiceAccount(request, namespace.id, "unused-provider");
  const unusedAccountPath = `${accountsPath}/${unusedAccount.id}`;
  // Successful DELETE is intentionally bodyless, unlike canonical JSON resource responses.
  await assertBodylessDelete(fixture, unusedAccountPath);
  const missingAccount = await request("GET", unusedAccountPath);
  assert.equal(missingAccount.status, 404);

  const accountEvents = auditSink.events.filter(
    (event) => event.kind === "mutation" && event.resource.kind === "service_account",
  );
  assert.deepEqual(
    new Set(accountEvents.map(({ action }) => action)),
    new Set([
      "openclaw.service_accounts.create",
      "openclaw.service_accounts.update",
      "openclaw.service_accounts.delete",
    ]),
  );
  const creation = accountEvents[0];
  assert(creation?.authorization);
  assert.deepEqual(creation.authorization.resource, {
    kind: "service_account",
    id: namespace.id,
    namespaceId: namespace.id,
  });
  const deletion = accountEvents.at(-1);
  assert(deletion?.authorization);
  assert.deepEqual(deletion.authorization.resource, {
    kind: "service_account",
    id: unusedAccount.id,
    namespaceId: namespace.id,
  });
});

test("native ServiceAccounts reject invalid references and enforce exact Namespace-scoped access", async () => {
  const { fixture, request, auditSink } = await setupServiceAccounts();
  const namespaceA = await createNamespace(request, "service-account-namespace-a");
  const namespaceB = await createNamespace(request, "service-account-namespace-b");
  const accountA = await createServiceAccount(request, namespaceA.id, "account-a");
  const accountB = await createServiceAccount(request, namespaceA.id, "account-b");
  const namespaceAPath = `/namespaces/${namespaceA.id}`;
  const namespaceBPath = `/namespaces/${namespaceB.id}`;
  const accountsPath = `${namespaceAPath}/service-accounts`;
  const agentsPath = `${namespaceAPath}/agents`;
  const exactAccountPath = `${accountsPath}/${accountA.id}`;
  const credentialPath = `${exactAccountPath}/credential`;

  const duplicate = await request("POST", accountsPath, {
    body: { name: "account-a" },
  });
  const duplicateError = checkRefusal(duplicate, 409, "RESOURCE_CONFLICT");
  // The caller chose only the name, so the conflict says the name is taken here.
  assert.equal(duplicateError.message, SERVICE_ACCOUNT_NAME_CONFLICT);

  // Account ownership participates in Namespace emptiness even before any Agent is created.
  const occupiedNamespace = await request("DELETE", namespaceAPath);
  checkRefusal(occupiedNamespace, 409, "NAMESPACE_NOT_EMPTY");

  for (const invalid of [
    { name: "unrecognized-field", implementation: "native" },
    { name: "cross-namespace", namespaceId: namespaceB.id },
  ]) {
    const rejected = await request("POST", accountsPath, { body: invalid });
    assert.equal(rejected.status, 400);
  }

  for (const invalid of [
    ...[".", ".."].map((key) => ({ kind: "api_key", secretRef: { name: "valid-source", key } })),
    { kind: "api_key", secretRef: { name: "valid-source", key: "credential", namespace: "other" } },
    { kind: "provider_token", secretRef: { name: "valid-source", key: "credential" } },
  ]) {
    const rejected = await request("PATCH", credentialPath, {
      body: invalid,
    });
    checkRefusal(rejected, 400, "INVALID_REQUEST");
  }

  const credential: ServiceAccountCredential = {
    kind: "api_key",
    secretRef: { name: "account-a-source", key: "api-key" },
  };
  const assigned = await request("PATCH", credentialPath, {
    body: credential,
  });
  const { data: updatedAccount } = checkedBody(assigned, 200, ServiceAccountResponse);

  // A real account ID never becomes accessible by substituting a sibling Namespace in the URL.
  for (const { method, suffix, options } of [
    { method: "GET", suffix: "" },
    { method: "PATCH", suffix: "/credential", options: { body: credential } },
    { method: "DELETE", suffix: "" },
  ]) {
    const crossNamespace = await request(
      method,
      `${namespaceBPath}/service-accounts/${accountA.id}${suffix}`,
      options,
    );
    assert.equal(crossNamespace.status, 404);
  }

  const configurationB = await createConfiguration(request, namespaceB.id);
  const configurationA = await createConfiguration(request, namespaceA.id);
  const crossNamespaceAssociation = await request("POST", `${namespaceBPath}/agents`, {
    body: {
      name: "cross-namespace-agent",
      configurationId: configurationB.id,
      harnessAuth: serviceAccountHarnessAuth(namespaceB.id, accountA.id),
    },
  });
  assert.equal(crossNamespaceAssociation.status, 404);
  // A source naming another Namespace is refused as such, even when the route Namespace holds
  // an account with that id: the reference itself must not cross Namespaces.
  const foreignSourceAssociation = await request("POST", agentsPath, {
    body: {
      name: "foreign-source-agent",
      configurationId: configurationA.id,
      harnessAuth: serviceAccountHarnessAuth(namespaceB.id, accountA.id),
    },
  });
  // The rule reads only the request, before any account lookup, so the API names it as a request
  // error instead of a 404 (finding 2536): the text is the same whether the account exists.
  const foreignSourceError = checkRefusal(foreignSourceAssociation, 400, "INVALID_REQUEST");
  assert.equal(foreignSourceError.message, SERVICE_ACCOUNT_CROSS_NAMESPACE);
  const missingForeignSource = await request("POST", agentsPath, {
    body: {
      name: "foreign-source-agent",
      configurationId: configurationA.id,
      harnessAuth: serviceAccountHarnessAuth(namespaceB.id, `sa_${randomUUID()}`),
    },
  });
  assert.deepEqual(checkRefusal(missingForeignSource, 400, "INVALID_REQUEST"), foreignSourceError);

  // Namespace-wide Agent authority never substitutes for an exact ServiceAccount binding.
  fixture.state.roles.push(
    {
      id: "role-service-account-namespace-reader",
      namespaceId: namespaceA.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "configuration" },
        { action: "create", resourceKind: "agent" },
        { action: "read", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
      ],
    },
    {
      id: "role-exact-service-account-reader",
      namespaceId: namespaceA.id,
      permissions: [{ action: "read", resourceKind: "service_account" }],
    },
  );
  async function exactReader(suffix: string, accountId: string) {
    const { principal: identity, session } = await fixture.createAuthPrincipal(suffix);
    assert(session);
    fixture.state.identities.push(identity);
    fixture.state.bindings.push(
      {
        id: `binding-${suffix}-namespace`,
        namespaceId: namespaceA.id,
        subjectKind: "identity",
        subjectId: identity.id,
        roleId: "role-service-account-namespace-reader",
      },
      {
        id: `binding-${suffix}-account`,
        namespaceId: namespaceA.id,
        subjectKind: "identity",
        subjectId: identity.id,
        roleId: "role-exact-service-account-reader",
        resourceKind: "service_account",
        resourceId: accountId,
      },
    );
    return { identity, app: fixture.createApp(identity) };
  }

  const { identity: reader, app: readerApp } = await exactReader(
    "existing-account-reader",
    accountA.id,
  );

  const authorizedAccount = await injectedRequest(readerApp, "GET", exactAccountPath);
  assert.equal(authorizedAccount.status, 200);

  const accountList = await injectedRequest(readerApp, "GET", accountsPath);
  const { data: visibleAccounts } = checkedBody(accountList, 200, ServiceAccountListResponse);
  assert.deepEqual(visibleAccounts, [updatedAccount]);
  assert.equal(JSON.stringify(visibleAccounts).includes(accountB.id), false);
  const [visibleAccount] = visibleAccounts;
  assert(visibleAccount);
  assert.equal(Object.hasOwn(visibleAccount, "backendId"), false);

  const denied = await injectedRequest(readerApp, "GET", `${accountsPath}/${accountB.id}`);
  checkRefusal(denied, 403, "FORBIDDEN");
  const denial = auditSink.events.at(-1);
  assert(denial?.kind === "authorization_denial");
  assert.deepEqual(denial.resource, {
    kind: "service_account",
    id: accountB.id,
    namespaceId: namespaceA.id,
  });
  assert.equal(denial.action, "openclaw.service_accounts.read");

  // Agent creation still needs read permission on its exact associated account, not a sibling.
  const deniedAssociation = await injectedRequest(readerApp, "POST", agentsPath, {
    body: {
      name: "denied-account-association",
      configurationId: configurationA.id,
      harnessAuth: serviceAccountHarnessAuth(accountB.namespaceId, accountB.id),
    },
  });
  assert.equal(deniedAssociation.status, 403);
  const deniedAssociationAudit = auditSink.events.at(-1);
  assert(deniedAssociationAudit?.kind === "authorization_denial");
  assert.equal(deniedAssociationAudit.action, "openclaw.agents.create");
  assert.deepEqual(deniedAssociationAudit.authorization, {
    principalId: reader.id,
    action: "read",
    resource: { kind: "service_account", id: accountB.id, namespaceId: namespaceA.id },
  });

  const allowedAssociation = await injectedRequest(readerApp, "POST", agentsPath, {
    body: {
      name: "allowed-account-association",
      configurationId: configurationA.id,
      harnessAuth: serviceAccountHarnessAuth(accountA.namespaceId, accountA.id),
    },
  });
  const { data: associatedAgent } = checkedBody(allowedAssociation, 201, AgentResponse);
  assertAssociatedAccount(associatedAgent, accountA.id);
  const associatedAgentPath = `${agentsPath}/${associatedAgent.id}`;

  // Replacing A with B requires exact read on the new account, not merely authority over A.
  const deniedNewAccount = await injectedRequest(readerApp, "PATCH", associatedAgentPath, {
    body: {
      configurationId: configurationA.id,
      harnessAuth: serviceAccountHarnessAuth(accountB.namespaceId, accountB.id),
    },
  });
  assert.equal(deniedNewAccount.status, 403);
  const unchangedAfterNewAccountDenial = await injectedRequest(
    readerApp,
    "GET",
    associatedAgentPath,
  );
  assertAssociatedAccount(
    checkedBody(unchangedAfterNewAccountDenial, 200, AgentReadResponse).data,
    accountA.id,
  );

  const deniedCreation = await injectedRequest(readerApp, "POST", accountsPath, {
    body: { name: "unauthorized-account" },
  });
  assert.equal(deniedCreation.status, 403);
  const deniedCreationAudit = auditSink.events.at(-1);
  assert(deniedCreationAudit?.kind === "authorization_denial");
  assert.deepEqual(deniedCreationAudit.resource, {
    kind: "service_account",
    id: namespaceA.id,
    namespaceId: namespaceA.id,
  });

  // Reading replacement account B cannot authorize detaching or replacing the existing account A.
  const { identity: replacementOnlyReader, app: replacementOnlyApp } = await exactReader(
    "replacement-only-reader",
    accountB.id,
  );

  for (const harnessAuth of [null, serviceAccountHarnessAuth(namespaceA.id, accountB.id)]) {
    const deniedOldAccount = await injectedRequest(
      replacementOnlyApp,
      "PATCH",
      associatedAgentPath,
      {
        body: {
          configurationId: configurationA.id,
          harnessAuth,
        },
      },
    );
    assert.equal(deniedOldAccount.status, 403);
    const deniedOldAccountAudit = auditSink.events.at(-1);
    assert(deniedOldAccountAudit?.kind === "authorization_denial");
    assert.equal(deniedOldAccountAudit.action, "openclaw.agents.update");
    assert.deepEqual(deniedOldAccountAudit.authorization, {
      principalId: replacementOnlyReader.id,
      action: "read",
      resource: {
        kind: "service_account",
        id: accountA.id,
        namespaceId: namespaceA.id,
      },
    });

    const unchanged = await injectedRequest(replacementOnlyApp, "GET", associatedAgentPath);
    assertAssociatedAccount(checkedBody(unchanged, 200, AgentReadResponse).data, accountA.id);
  }
});
