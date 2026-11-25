import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  ConfigurationResponse,
  ErrorResponse,
  InstallationResponse,
  NamespaceResponse,
  ServiceAccountForceDeletionResponse,
  ServiceAccountListResponse,
  ServiceAccountResponse,
  type ErrorCode,
} from "../../packages/contracts/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.ts";
import { assertSameAnswer } from "../helpers/refusal-answers.ts";
import { callerDenied, SERVICE_ACCOUNT_NAME_CONFLICT } from "../helpers/refusal-text.mjs";
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
  await fixture.markNamespaceReady(namespace.id);
  await controller.transact(async (unit) => {
    const instance = await unit.installations.selectTokenServiceInstance({
      id: randomUUID(),
      driverId: "occ",
      storeIdentity: "force-delete-existing-custody",
    });
    const source = await unit.credentialSources.createCredentialSource({
      id: `cs_${randomUUID()}`,
      namespaceId: namespace.id,
      name: "Retained issued PAT",
      type: "static",
      config: { provider_preset: "codex-pat" },
      ownerCapability: "token_service",
      tokenServiceInstanceId: instance.id,
      state: "ready",
      createdAt: new Date().toISOString(),
    });
    await unit.serviceAccounts.setCredentialSource(namespace.id, account.id, source.id);
  });

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

test("ServiceAccounts reject retired manual credential attachment and require Source authentication", async () => {
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
      harnessAuth: {
        method: "codex_pat",
        source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
      },
    },
  });
  const refusal = checkRefusal(agentResult, 409, "RESOURCE_CONFLICT");
  assert.equal(refusal.message, "Bind the issued ServiceAccount's Credential Source instead.");

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

  const retired = await request("PATCH", credentialPath, {
    body: { kind: "api_key", secretRef: { name: "provider-key", key: "value" } },
  });
  assert.equal(retired.status, 404, "manual credential attachment is no longer offered");
  const outsider = await fixture.createAuthPrincipal("service-account-outsider");
  fixture.state.identities.push(outsider.principal);
  assert(outsider.session);
  const forbidden = await request("DELETE", accountPath, { session: outsider.session });
  checkRefusal(forbidden, 403, "FORBIDDEN");

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
    new Set(["openclaw.service_accounts.create", "openclaw.service_accounts.delete"]),
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
  const exactAccountPath = `${accountsPath}/${accountA.id}`;

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

  // A real account ID never becomes accessible by substituting a sibling Namespace in the URL.
  for (const { method, suffix } of [
    { method: "GET", suffix: "" },
    { method: "DELETE", suffix: "" },
  ]) {
    const crossNamespace = await request(
      method,
      `${namespaceBPath}/service-accounts/${accountA.id}${suffix}`,
    );
    assert.equal(crossNamespace.status, 404);
  }

  fixture.state.roles.push(
    {
      id: "role-service-account-namespace-reader",
      namespaceId: namespaceA.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
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

  const { app: readerApp } = await exactReader("existing-account-reader", accountA.id);

  const authorizedAccount = await injectedRequest(readerApp, "GET", exactAccountPath);
  assert.equal(authorizedAccount.status, 200);

  const accountList = await injectedRequest(readerApp, "GET", accountsPath);
  const { data: visibleAccounts } = checkedBody(accountList, 200, ServiceAccountListResponse);
  assert.deepEqual(visibleAccounts, [accountA]);
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
});
