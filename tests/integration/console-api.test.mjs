import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  authenticatedHeaders,
  cookieHeaderFromSetCookie,
  setCookieHeaders,
} from "../helpers/auth-session.mjs";

const contract = JSON.parse(
  await readFile(
    new URL("../../packages/contracts/openapi/occ-api.openapi.json", import.meta.url),
    "utf8",
  ),
);
const UNTRUSTED_ORIGIN_MESSAGE =
  "A trusted browser origin is required: session-cookie requests that change state must come from the console and send its Origin header.";

function noSecretProviderFields(backend) {
  assert.deepEqual(Object.keys(backend).sort(), ["id", "type"]);
  assert.equal(typeof backend.id, "string");
  assert.equal(backend.type, "chatgpt");
}

test("console Backend API returns only safe Installation-admin summaries", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();

  const backends = await fixture.request("GET", "/backends");
  assert.equal(backends.status, 200);
  assert.deepEqual(backends.data, [{ id: backendFixtures[0].id, type: "chatgpt" }]);
  backends.data.forEach(noSecretProviderFields);
  assert.doesNotMatch(JSON.stringify(backends.body), /apiKey|workspaceId|credential|drivers|path/i);

  const emptyFixture = await createConsoleAppFixture(t, { backends: [] });
  await emptyFixture.bootstrap("Console empty Backend Installation");
  const emptyProviders = await emptyFixture.request("GET", "/backends");
  assert.equal(emptyProviders.status, 200);
  assert.deepEqual(emptyProviders.data, []);

  const unavailableFixture = await createConsoleAppFixture(t, {
    backendSummaries: undefined,
  });
  await unavailableFixture.bootstrap("Console unavailable Backend Installation");
  const unavailable = await unavailableFixture.request("GET", "/backends");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "DEPENDENCY_UNAVAILABLE");
});

test("observability destination requires Installation administration", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Observability readers");

  const administrator = await fixture.request("GET", "/observability");
  assert.equal(administrator.status, 200);
  assert.deepEqual(administrator.data, { url });

  // A Namespace reader must not discover the Installation-wide external destination.
  const limited = await fixture.createAccountWithPolicy("namespace-observer", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-observability-reader",
      namespaceId: namespace.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    fixture.policy.bindings.push({
      id: "binding-console-observability-reader",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-observability-reader",
    });
  });
  const session = await fixture.signIn(limited.credentials);
  const denied = await fixture.request("GET", "/observability", { session });
  assertApiError(denied, 403, "FORBIDDEN");

  const absent = await createConsoleAppFixture(t);
  await absent.bootstrap("No observability destination");
  const response = await absent.request("GET", "/observability");
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { url: null });
});

test("console collection APIs keep exact Namespace and Agent IAM boundaries", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha");
  const beta = await fixture.createNamespace("Beta");
  const alphaAgent = await fixture.createAgent(alpha.id, "Alpha agent");
  const betaAgent = await fixture.createAgent(beta.id, "Beta agent");

  const limited = await fixture.createAccountWithPolicy("namespace-reader", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-alpha-reader",
      namespaceId: alpha.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-alpha-reader",
      namespaceId: alpha.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-alpha-reader",
    });
  });
  const limitedSession = await fixture.signIn(limited.credentials);

  const visibleNamespaces = await fixture.request("GET", "/namespaces", {
    session: limitedSession,
  });
  assert.equal(visibleNamespaces.status, 200);
  assert.deepEqual(
    visibleNamespaces.data.map((namespace) => namespace.id),
    [alpha.id],
  );

  const visibleAgents = await fixture.request("GET", `/namespaces/${alpha.id}/agents`, {
    session: limitedSession,
  });
  assert.equal(visibleAgents.status, 200);
  assert.deepEqual(
    visibleAgents.data.map((agent) => agent.id),
    [alphaAgent.id],
  );
  assert.equal(visibleAgents.data[0].name, alphaAgent.name);

  const hiddenAgents = await fixture.request("GET", `/namespaces/${beta.id}/agents`, {
    session: limitedSession,
  });
  assertApiError(hiddenAgents, 403, "FORBIDDEN");
  assert.equal(betaAgent.name, "Beta agent");

  const alphaImages = `/namespaces/${alpha.id}/agents/${alphaAgent.id}/runtime-images`;
  const images = await fixture.request("GET", alphaImages, { session: limitedSession });
  assert.equal(images.status, 200);
  assert.deepEqual(images.data, { status: "undeployed", images: [] });
  assert.equal((await fixture.request("GET", alphaImages, { session: null })).status, 401);
  const hiddenImages = await fixture.request(
    "GET",
    `/namespaces/${beta.id}/agents/${betaAgent.id}/runtime-images`,
    { session: limitedSession },
  );
  assert.equal(hiddenImages.status, 403);
  const wrongNamespace = await fixture.request(
    "GET",
    `/namespaces/${alpha.id}/agents/${betaAgent.id}/runtime-images`,
  );
  assert.equal(wrongNamespace.status, 404);

  const providerDenied = await fixture.request("GET", "/backends", { session: limitedSession });
  assertApiError(providerDenied, 403, "FORBIDDEN");

  fixture.policy.bindings.splice(
    fixture.policy.bindings.findIndex((binding) => binding.id === "binding-console-alpha-reader"),
    1,
  );
  const revokedNamespaces = await fixture.request("GET", "/namespaces", {
    session: limitedSession,
  });
  assert.equal(revokedNamespaces.status, 200);
  assert.deepEqual(revokedNamespaces.data, []);
  assert.equal(
    (await fixture.request("GET", alphaImages, { session: limitedSession })).status,
    403,
  );
});

// The Secrets page disables Create Secret on a false answer (finding 2365), so the answer must be
// the decision createSecret makes: Secret create on the Namespace collection, not Secret read and
// not Agent create. Each step proves the answer against the same real POST.
test("the Namespace Secret create answer matches what Secret creation checks", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret create answer", { ready: true });
  const permissionsPath = `/namespaces/${namespace.id}/permissions`;
  const secretsPath = `/namespaces/${namespace.id}/secrets`;
  // Namespace read lets the member ask; Secret read and Agent create are other decisions.
  const member = await fixture.createNamespaceMember("secret-create-answer", namespace.id, [
    ["read", "namespace"],
    ["read", "secret"],
    ["create", "agent"],
  ]);
  const session = await fixture.signIn(member.credentials);
  const answer = async () => {
    const summary = await fixture.request("GET", permissionsPath, { session });
    assert.equal(summary.status, 200);
    return summary.data;
  };
  const create = (name) =>
    fixture.request("POST", secretsPath, { session, body: { name, value: "synthetic-value" } });

  assert.deepEqual(await answer(), {
    agents: { create: true },
    secrets: { create: false },
    installation: { administer: false },
  });
  // A false answer is not an attempted operation: only the real POST is audited as denied.
  const denials = () => auditSink.list().filter((event) => event.kind === "authorization_denial");
  assert.equal(denials().length, 0);
  assertApiError(await create("Refused token"), 403, "FORBIDDEN");
  assert.deepEqual(
    denials().map((event) => event.action),
    ["openclaw.secrets.create"],
  );

  fixture.policy.roles
    .find((role) => role.id === "role-secret-create-answer")
    .permissions.push({ action: "create", resourceKind: "secret" });
  assert.deepEqual((await answer()).secrets, { create: true });
  assert.equal((await create("Created token")).status, 201);
});

// The console reads this answer instead of probing GET /observability, whose refusal the API
// audits, and gates Backends, Settings and the Access tab on it (findings 2620-2622). So it must
// be the decision Installation-wide operations make, and not one inferred from a Namespace grant:
// each step proves it against the real GET /backends.
test("the Namespace Installation administer answer matches what Installation-wide reads check", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  const installation = await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Administer answer", { ready: true });
  const permissionsPath = `/namespaces/${namespace.id}/permissions`;
  const answer = async (session) => {
    const summary = await fixture.request("GET", permissionsPath, { session });
    assert.equal(summary.status, 200);
    return summary.data;
  };
  const backends = (session) => fixture.request("GET", "/backends", { session });
  const denials = () => auditSink.list().filter((event) => event.kind === "authorization_denial");

  // A member with Namespace-wide Agent create does not administer the Installation.
  const member = await fixture.createNamespaceMember("administer-answer", namespace.id, [
    ["read", "namespace"],
    ["create", "agent"],
  ]);
  const session = await fixture.signIn(member.credentials);
  const memberAnswer = await answer(session);
  assert.deepEqual(memberAnswer.agents, { create: true });
  assert.deepEqual(memberAnswer.installation, { administer: false });
  // A false answer is not an attempted operation: only the real read is audited as denied.
  assert.deepEqual(denials(), []);
  assertApiError(await backends(session), 403, "FORBIDDEN");
  assert.deepEqual(
    denials().map((event) => event.action),
    ["openclaw.backends.list"],
  );

  // An administrator whose Restriction denies Agent create in this Namespace still administers
  // the Installation: Agent create says nothing about it. The Restriction is Namespace-wide, so
  // it applies to the member too; her answer was read above.
  fixture.policy.restrictions.push({
    id: "deny-agent-create-here",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const restricted = await answer();
  assert.deepEqual(restricted.agents, { create: false });
  assert.deepEqual(restricted.installation, { administer: true });
  assert.equal((await backends()).status, 200);

  // A Restriction on Installation administer changes the answer as it changes the read.
  fixture.policy.restrictions.push({
    id: "deny-installation-administer",
    resourceKind: "installation",
    resourceId: installation.id,
    action: "administer",
    effect: "deny",
  });
  assert.deepEqual((await answer()).installation, { administer: false });
  assertApiError(await backends(), 403, "FORBIDDEN");
});

// The console's Logs view skips the log text read for a caller whose Agent answer says readLogs
// is false, because the API audits each refused read as a denial (finding D758). So readLogs must
// be the decision the log read makes: read_logs, or administer in its place unless a Restriction
// denies read_logs. Each step proves it against the real read, and the answer audits nothing.
test("the Agent readLogs answer matches what the runtime log read checks", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, {
    auditSink,
    computeDriver: createRuntimeLogComputeDriver(),
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-api-logs-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Log text answer", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Log text agent");
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const readLogs = async (session) => {
    const summary = await fixture.request("GET", `${agentPath}/permissions`, { session });
    assert.equal(summary.status, 200);
    return summary.data.readLogs;
  };
  const logRead = (session) =>
    fixture.request(
      "GET",
      `${agentPath}/deployments/${active.revision.id}/runtime/logs?source=gateway`,
      { session },
    );
  const denials = () =>
    auditSink
      .list()
      .filter(
        (event) =>
          event.kind === "authorization_denial" &&
          event.action === "openclaw.agents.runtime_logs.view",
      );

  // A reader without read_logs: the answer is false, and only the real read is audited.
  const reader = await fixture.createNamespaceMember("log-text-reader", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
  ]);
  const readerSession = await fixture.signIn(reader.credentials);
  assert.equal(await readLogs(readerSession), false);
  assert.deepEqual(denials(), []);
  assertApiError(await logRead(readerSession), 403, "FORBIDDEN");
  assert.equal(denials().length, 1);

  // read_logs, as the Agent logs guide delegates it.
  fixture.policy.roles
    .find((role) => role.id === "role-log-text-reader")
    .permissions.push({ action: "read_logs", resourceKind: "agent" });
  assert.equal(await readLogs(readerSession), true);
  assert.equal((await logRead(readerSession)).status, 200);

  // An Installation administrator holds administer, which stands in for read_logs.
  assert.equal(await readLogs(), true);
  assert.equal((await logRead()).status, 200);

  // A Restriction on read_logs denies log text even to an administrator: administer cannot
  // bypass it.
  fixture.policy.restrictions.push({
    id: "deny-log-text",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
    action: "read_logs",
    effect: "deny",
  });
  assert.equal(await readLogs(), false);
  assert.equal(await readLogs(readerSession), false);
  assert.equal(denials().length, 1);
  assertApiError(await logRead(), 403, "FORBIDDEN");
  assertApiError(await logRead(readerSession), 403, "FORBIDDEN");
  assert.equal(denials().length, 3);
});

test("caller permission summaries report primary IAM decisions without authorizing a later operation", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Permission summaries", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Summarized agent");
  const other = await fixture.createAgent(namespace.id, "Unshared agent");
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const permissionsPath = `${agentPath}/permissions`;
  const namespacePath = `/namespaces/${namespace.id}/permissions`;

  const admin = await fixture.request("GET", permissionsPath);
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.data, {
    update: true,
    deploy: true,
    operate: true,
    delete: true,
    administer: true,
    configurationUpdate: true,
    configurationRead: true,
    configurationSecretsOperate: true,
    configurationSecretsOperateDeniedBindings: [],
    agentSourcesOperate: true,
    sandboxPolicyRead: true,
    readLogs: true,
  });
  const adminNamespace = await fixture.request("GET", namespacePath);
  assert.equal(adminNamespace.status, 200);
  assert.deepEqual(adminNamespace.data, {
    agents: { create: true },
    secrets: { create: true },
    installation: { administer: true },
  });

  // Namespace read plus exact read and deploy on one Agent: only deploy is reported.
  const limited = await fixture.createAccountWithPolicy("permission-summary", (principal) => {
    fixture.policy.roles.push(
      {
        id: "role-permission-summary-namespace",
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "namespace" }],
      },
      {
        id: "role-permission-summary-agent",
        namespaceId: namespace.id,
        permissions: [
          { action: "read", resourceKind: "agent" },
          { action: "deploy", resourceKind: "agent" },
        ],
      },
    );
    fixture.policy.bindings.push(
      {
        id: "binding-permission-summary-namespace",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "role-permission-summary-namespace",
      },
      {
        id: "binding-permission-summary-agent",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "role-permission-summary-agent",
        resourceKind: "agent",
        resourceId: agent.id,
      },
    );
  });
  const session = await fixture.signIn(limited.credentials);
  const summary = await fixture.request("GET", permissionsPath, { session });
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.data, {
    update: false,
    deploy: true,
    operate: false,
    delete: false,
    administer: false,
    configurationUpdate: false,
    configurationRead: false,
    configurationSecretsOperate: false,
    configurationSecretsOperateDeniedBindings: [],
    agentSourcesOperate: false,
    sandboxPolicyRead: false,
    readLogs: false,
  });
  // Reading the Agent's network policy and suggestions needs read on its SandboxPolicy, a grant
  // no other answer covers (finding 2454). The grant names only this Agent's policy, the
  // resource the policy and suggestion reads authorize.
  fixture.policy.roles.push({
    id: "role-permission-summary-sandbox-policy",
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "sandbox_policy" }],
  });
  fixture.policy.bindings.push({
    id: "binding-permission-summary-sandbox-policy",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: limited.principal.id,
    roleId: "role-permission-summary-sandbox-policy",
    resourceKind: "sandbox_policy",
    resourceId: `sbp_${agent.id.slice(4)}`,
  });
  const policySummary = await fixture.request("GET", permissionsPath, { session });
  assert.equal(policySummary.status, 200);
  assert.equal(policySummary.data.sandboxPolicyRead, true);
  assert.equal(policySummary.data.update, false);
  // The answer agrees with the real policy read it stands for.
  const policyRead = await fixture.request("GET", `${agentPath}/sandbox-policy/networking`, {
    session,
  });
  assert.equal(policyRead.status, 200);
  // An IAM failure on this decision is not a denial: the whole answer is unavailable, so the
  // console keeps reading the policy instead of hiding it.
  const policyOutage = await fixture.withIamOutage(
    (request) => request.resource.kind === "sandbox_policy",
    () => fixture.request("GET", permissionsPath, { session }),
  );
  assertApiError(policyOutage, 503, "DEPENDENCY_UNAVAILABLE");
  // Configuration update on the Agent's Configuration is its own grant (finding 2421).
  fixture.policy.roles.push({
    id: "role-permission-summary-configuration",
    namespaceId: namespace.id,
    permissions: [{ action: "update", resourceKind: "configuration" }],
  });
  fixture.policy.bindings.push({
    id: "binding-permission-summary-configuration",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: limited.principal.id,
    roleId: "role-permission-summary-configuration",
    resourceKind: "configuration",
    resourceId: agent.configurationId,
  });
  const configurationSummary = await fixture.request("GET", permissionsPath, { session });
  assert.equal(configurationSummary.status, 200);
  assert.equal(configurationSummary.data.configurationUpdate, true);
  assert.equal(configurationSummary.data.update, false);
  const namespaceSummary = await fixture.request("GET", namespacePath, { session });
  assert.equal(namespaceSummary.status, 200);
  assert.deepEqual(namespaceSummary.data, {
    agents: { create: false },
    secrets: { create: false },
    installation: { administer: false },
  });
  // A false flag is an answer, not an attempted operation, so nothing is audited as denied.
  const denials = () => auditSink.list().filter((event) => event.kind === "authorization_denial");
  assert.equal(denials().length, 0);

  // The summary itself requires Agent read and an existing Agent.
  const unshared = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${other.id}/permissions`,
    { session },
  );
  assertApiError(unshared, 403, "FORBIDDEN");
  assert.deepEqual(
    denials().map((event) => event.action),
    ["openclaw.agents.permissions.read"],
  );
  const missing = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/agt_00000000-0000-4000-8000-000000000000/permissions`,
  );
  assert.equal(missing.status, 404);

  // The summary reported deploy: true. This caller lacks the Configuration read needed to deploy.
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  assert.equal((await fixture.request("GET", configurationPath, { session })).status, 403);
  const revisionsPath = `${agentPath}/revisions`;
  const before = await fixture.request("GET", revisionsPath);
  assert.equal(before.status, 200);
  const deploy = await fixture.request("POST", `${agentPath}/deploy`, { session });
  assertApiError(deploy, 403, "FORBIDDEN");
  assert.equal(denials().at(-1).action, "openclaw.agents.deploy");
  const after = await fixture.request("GET", revisionsPath);
  assert.equal(after.status, 200);
  assert.deepEqual(after.data, before.data, "denied deployment created no revision");

  // Each Configuration save authorizes Secret operate on every Secret it binds, so Configuration
  // update alone does not say a save can succeed (finding 2437). The answer covers the bound
  // Secrets, and only for a caller who may read and update the Configuration.
  assert.equal(configurationSummary.data.configurationSecretsOperate, false);
  const bound = await fixture.createSecret(namespace.id, "Bound token", "bound-token-value");
  const second = await fixture.createSecret(namespace.id, "Second token", "second-token-value");
  // Two bound Secrets, one of them under two names: a save checks operate on each Secret.
  const boundAgent = await fixture.createAgent(
    namespace.id,
    "Bound agent",
    {},
    {
      secretBindings: {
        EXTERNAL_API_TOKEN: { source: bound.ref, delivery: { type: "env" } },
        EXTERNAL_API_TOKEN_ALIAS: { source: bound.ref, delivery: { type: "env" } },
        SECOND_API_TOKEN: { source: second.ref, delivery: { type: "env" } },
      },
    },
  );
  const boundPermissions = `/namespaces/${namespace.id}/agents/${boundAgent.id}/permissions`;
  const bindExact = (id, roleId, resourceKind, resourceId) =>
    fixture.policy.bindings.push({
      id,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: limited.principal.id,
      roleId,
      resourceKind,
      resourceId,
    });
  fixture.policy.roles.push(
    {
      id: "role-permission-summary-configuration-editor",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "configuration" },
        { action: "update", resourceKind: "configuration" },
      ],
    },
    {
      id: "role-permission-summary-secret-operator",
      namespaceId: namespace.id,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    },
  );
  bindExact("binding-bound-agent", "role-permission-summary-agent", "agent", boundAgent.id);
  // Configuration update without read: the answer says nothing about the bound Secrets.
  bindExact(
    "binding-bound-configuration-update",
    "role-permission-summary-configuration",
    "configuration",
    boundAgent.configurationId,
  );
  const updateOnly = await fixture.request("GET", boundPermissions, { session });
  assert.equal(updateOnly.data.configurationUpdate, true);
  assert.equal(updateOnly.data.configurationSecretsOperate, false);
  // Read and update, but no operate on the bound Secret: a save would be refused.
  bindExact(
    "binding-bound-configuration-editor",
    "role-permission-summary-configuration-editor",
    "configuration",
    boundAgent.configurationId,
  );
  const withoutOperate = await fixture.request("GET", boundPermissions, { session });
  assert.equal(withoutOperate.data.configurationUpdate, true);
  assert.equal(withoutOperate.data.configurationSecretsOperate, false);
  // Operate on only one of the two bound Secrets: a save still needs the other, so the answer
  // stays false. It covers every bound Secret, not any of them.
  bindExact(
    "binding-bound-secret-operator",
    "role-permission-summary-secret-operator",
    "secret",
    bound.id,
  );
  const partialOperate = await fixture.request("GET", boundPermissions, { session });
  assert.equal(partialOperate.data.configurationSecretsOperate, false);
  // The probes are answers, not attempted operations.
  assert.equal(denials().at(-1).action, "openclaw.agents.deploy");
  // The answer matches the real save: resaving the same values is refused now.
  const boundConfigurationPath = `/namespaces/${namespace.id}/configurations/${boundAgent.configurationId}`;
  const saved = await fixture.request("GET", boundConfigurationPath);
  assert.equal(saved.status, 200);
  const resave = () =>
    fixture.request("PATCH", boundConfigurationPath, {
      session,
      body: { values: saved.data.values },
    });
  assertApiError(await resave(), 403, "FORBIDDEN");
  // Operate on the other Secret completes what a save checks, and the same save succeeds.
  bindExact(
    "binding-bound-second-secret-operator",
    "role-permission-summary-secret-operator",
    "secret",
    second.id,
  );
  const withOperate = await fixture.request("GET", boundPermissions, { session });
  assert.equal(withOperate.data.configurationSecretsOperate, true);
  assert.equal((await resave()).status, 200);
});

// A Configuration save that submits Secret bindings is authorized on those bindings only, so the
// console's channel Secrets panel can save while a bound Secret the caller may not operate is
// replaced in the same save (finding 2444). The per-binding answer names each binding whose
// Secret the caller lacks operate on, and each step proves it against the same real PATCH.
test("the per-binding Secret answer names the bindings a Configuration save must replace", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Per-binding answer", { ready: true });
  // An administrator's bot token Secret, bound under two names, and an app token Secret.
  const adminBot = await fixture.createSecret(namespace.id, "Admin bot token", "admin-bot-value");
  const app = await fixture.createSecret(namespace.id, "App token", "app-value");
  const own = await fixture.createSecret(namespace.id, "Member bot token", "member-bot-value");
  const binding = (secret) => ({ source: secret.ref, delivery: { type: "env" } });
  const agent = await fixture.createAgent(
    namespace.id,
    "Per-binding agent",
    {},
    {
      secretBindings: {
        SLACK_BOT_TOKEN: binding(adminBot),
        SLACK_BOT_TOKEN_ALIAS: binding(adminBot),
        SLACK_APP_TOKEN: binding(app),
      },
    },
  );
  const permissionsPath = `/namespaces/${namespace.id}/agents/${agent.id}/permissions`;
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const member = await fixture.createNamespaceMember("per-binding-answer", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["read", "configuration"],
  ]);
  const session = await fixture.signIn(member.credentials);
  const grant = (id, permissions, resourceKind, resourceId) => {
    fixture.policy.roles.push({ id: `role-${id}`, namespaceId: namespace.id, permissions });
    fixture.policy.bindings.push({
      id: `binding-${id}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: member.principal.id,
      roleId: `role-${id}`,
      resourceKind,
      resourceId,
    });
  };
  const answer = async () => {
    const summary = await fixture.request("GET", permissionsPath, { session });
    assert.equal(summary.status, 200);
    return summary.data;
  };
  const denials = () => auditSink.list().filter((event) => event.kind === "authorization_denial");

  // Without Configuration update the answer is not reported: no names, as with the boolean. Agent
  // update reads the bindings for its own answer, which does not report them either.
  grant("per-binding-agent", [{ action: "update", resourceKind: "agent" }], "agent", agent.id);
  const unreported = await answer();
  assert.equal(unreported.update, true);
  assert.equal(unreported.agentSourcesOperate, false);
  assert.equal(unreported.configurationSecretsOperate, false);
  assert.deepEqual(unreported.configurationSecretsOperateDeniedBindings, []);

  // Configuration update, operate on the app token and on the member's own Secret only. Both
  // names that bind the administrator's Secret are listed, sorted; the operable one is not.
  grant(
    "per-binding-configuration",
    [{ action: "update", resourceKind: "configuration" }],
    "configuration",
    agent.configurationId,
  );
  const operate = [{ action: "operate", resourceKind: "secret" }];
  grant("per-binding-app", operate, "secret", app.id);
  grant("per-binding-own", operate, "secret", own.id);
  const partial = await answer();
  assert.equal(partial.configurationUpdate, true);
  assert.equal(partial.configurationSecretsOperate, false);
  assert.deepEqual(partial.configurationSecretsOperateDeniedBindings, [
    "SLACK_BOT_TOKEN",
    "SLACK_BOT_TOKEN_ALIAS",
  ]);
  // The probes are answers, not attempted operations.
  assert.equal(denials().length, 0);

  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.status, 200);
  const save = (secretBindings, expectedGeneration) =>
    fixture.request("PATCH", configurationPath, {
      session,
      body: { values: saved.data.values, secretBindings, expectedGeneration },
    });
  // A save that keeps a listed name on the administrator's Secret is refused, even when it
  // replaces another binding.
  assertApiError(
    await save(
      {
        SLACK_BOT_TOKEN: binding(own),
        SLACK_BOT_TOKEN_ALIAS: binding(adminBot),
        SLACK_APP_TOKEN: binding(app),
      },
      saved.data.generation,
    ),
    403,
    "FORBIDDEN",
  );
  assert.equal(denials().at(-1).action, "openclaw.configurations.update");
  // A save that rebinds every listed name to the member's own Secret succeeds: the Secret they
  // bound before is not checked.
  const replaced = await save(
    {
      SLACK_BOT_TOKEN: binding(own),
      SLACK_BOT_TOKEN_ALIAS: binding(own),
      SLACK_APP_TOKEN: binding(app),
    },
    saved.data.generation,
  );
  assert.equal(replaced.status, 200);
  assert.equal(replaced.data.secretBindings.SLACK_BOT_TOKEN.source.id, own.id);
  // Every bound Secret is operable now, so nothing is listed.
  const operable = await answer();
  assert.equal(operable.configurationSecretsOperate, true);
  assert.deepEqual(operable.configurationSecretsOperateDeniedBindings, []);
  // An IAM failure on a bound Secret's operate decision fails the whole answer: "an IAM failure
  // on any caller permission decision ..." proves it for a Configuration editor like this one.
});

// Binding a Secret to an Agent's Configuration, or as its Harness authentication source,
// authorizes Secret operate on it, so a Secret field that offered every readable Secret let a
// save be refused only after the click (finding 2453). The Secret answer names the readable
// Secrets the caller may not operate, only to a caller who could make such a save, and each
// step proves it against the same real Configuration PATCH.
async function secretAnswerFixture(t, options = {}) {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink, ...options });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret operate answer", { ready: true });
  const app = await fixture.createSecret(namespace.id, "App token", "app-value");
  const bot = await fixture.createSecret(namespace.id, "Bot token", "bot-value");
  const binding = (secret) => ({ source: secret.ref, delivery: { type: "env" } });
  const agent = await fixture.createAgent(
    namespace.id,
    "Secret answer agent",
    {},
    { secretBindings: { SLACK_APP_TOKEN: binding(app), SLACK_BOT_TOKEN: binding(bot) } },
  );
  const answerPath = `/namespaces/${namespace.id}/agents/${agent.id}/permissions/secrets`;
  // A member with read on the Agent, its Configuration and the named Secrets, plus `grants`.
  const member = async (label, grants, readable) => {
    const created = await fixture.createNamespaceMember(label, namespace.id, grants);
    const grant = (id, action, resourceKind, resourceId) => {
      fixture.policy.roles.push({
        id: `role-${label}-${id}`,
        namespaceId: namespace.id,
        permissions: [{ action, resourceKind }],
      });
      fixture.policy.bindings.push({
        id: `binding-${label}-${id}`,
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: created.principal.id,
        roleId: `role-${label}-${id}`,
        resourceKind,
        resourceId,
      });
    };
    for (const secret of readable) {
      grant(`read-${secret.id}`, "read", "secret", secret.id);
    }
    const session = await fixture.signIn(created.credentials);
    const data = async () => {
      const response = await fixture.request("GET", answerPath, { session });
      assert.equal(response.status, 200);
      return response.data;
    };
    const answer = async () => (await data()).operateDenied;
    return { session, grant, answer, data, principal: created.principal };
  };
  const denials = () => auditSink.list().filter((event) => event.kind === "authorization_denial");
  return { fixture, namespace, agent, app, bot, binding, answerPath, member, denials };
}

test("the Agent Secret answer names the readable Secrets a binding save would be refused on", async (t) => {
  const { fixture, namespace, agent, app, bot, binding, answerPath, member, denials } =
    await secretAnswerFixture(t);
  // Readable spare Secrets. The answer is sorted by ID; the Secret list is in creation order. A
  // spare is added until the two orders differ, so the sort is observable.
  const spares = [];
  const listedSpares = async () =>
    (await fixture.request("GET", `/namespaces/${namespace.id}/secrets`)).data
      .map((secret) => secret.id)
      .filter((id) => spares.some((spare) => spare.id === id));
  do {
    spares.push(
      await fixture.createSecret(namespace.id, `Spare token ${spares.length}`, "spare-value"),
    );
  } while (
    spares.length < 2 ||
    JSON.stringify(await listedSpares()) === JSON.stringify((await listedSpares()).toSorted())
  );
  const spareIds = spares.map((spare) => spare.id).sort();
  // A Secret the members cannot read: the answer never names it, operable or not.
  await fixture.createSecret(namespace.id, "Unread token", "unread-value");
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const readable = [app, bot, ...spares];
  const reads = [
    ["read", "namespace"],
    ["read", "agent"],
    ["read", "configuration"],
  ];

  // An administrator may operate every Secret, so nothing is listed.
  const admin = await fixture.request("GET", answerPath);
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.data, { operateDenied: [], unreadableOperateDenied: 0 });

  // The D710 persona: Configuration update without Agent update.
  const editor = await member("secret-answer-editor", reads, readable);
  // As a reader it can make no save that binds a Secret, so the answer is not reported.
  assert.deepEqual(await editor.answer(), []);
  // Configuration update without operate on any Secret: every readable Secret is listed, by ID.
  editor.grant("configuration", "update", "configuration", agent.configurationId);
  assert.deepEqual(await editor.answer(), [app.id, bot.id, ...spareIds].sort());
  // Operate on the two bound Slack Secrets, as in the dogfood walk: only the spares are listed.
  editor.grant("operate-app", "operate", "secret", app.id);
  editor.grant("operate-bot", "operate", "secret", bot.id);
  assert.deepEqual(await editor.answer(), spareIds);
  // The probes are answers, not attempted operations.
  assert.equal(denials().length, 0);

  // The answer matches the real save: binding a listed Secret is refused, and rebinding to the
  // operable ones succeeds.
  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.status, 200);
  const save = (secretBindings, expectedGeneration) =>
    fixture.request("PATCH", configurationPath, {
      session: editor.session,
      body: { values: saved.data.values, secretBindings, expectedGeneration },
    });
  assertApiError(
    await save(
      { SLACK_APP_TOKEN: binding(app), SLACK_BOT_TOKEN: binding(spares[0]) },
      saved.data.generation,
    ),
    403,
    "FORBIDDEN",
  );
  assert.equal(denials().at(-1).action, "openclaw.configurations.update");
  const swapped = await save(
    { SLACK_APP_TOKEN: binding(bot), SLACK_BOT_TOKEN: binding(app) },
    saved.data.generation,
  );
  assert.equal(swapped.status, 200);
  // Operate on a spare too: it is no longer listed, and the refused binding saves.
  editor.grant("operate-spare", "operate", "secret", spares[0].id);
  assert.deepEqual(
    await editor.answer(),
    spareIds.filter((id) => id !== spares[0].id),
  );
  const rebound = await save(
    { SLACK_APP_TOKEN: binding(app), SLACK_BOT_TOKEN: binding(spares[0]) },
    swapped.data.generation,
  );
  assert.equal(rebound.status, 200);

  // Agent update without Configuration update binds a Harness authentication Secret: reported.
  const agentEditor = await member("secret-answer-agent-editor", reads, readable);
  agentEditor.grant("agent", "update", "agent", agent.id);
  assert.deepEqual(await agentEditor.answer(), [app.id, bot.id, ...spareIds].sort());
  // Agent deploy without either update: deploying a draft authorizes Secret operate on every
  // Secret it binds, so the answer is reported (the iam.md operator, finding 2546). Such a caller
  // can bind nothing, so it covers only the Secrets the draft binds now: the Configuration's
  // bindings (the editor rebound them to app and the first spare) and the fixture's Harness
  // authentication Secret, readable here. The other readable Secrets stay unreported, since no
  // deployment checks them (finding 2565).
  const harnessSecret = agent.harnessAuth.source;
  const deniedBeforeDeployer = denials().length;
  const deployer = await member("secret-answer-deployer", reads, [...readable, harnessSecret]);
  assert.deepEqual(await deployer.answer(), []);
  deployer.grant("deploy", "deploy", "agent", agent.id);
  assert.deepEqual(await deployer.answer(), [app.id, spares[0].id, harnessSecret.id].sort());
  deployer.grant("operate-harness", "operate", "secret", harnessSecret.id);
  assert.deepEqual(await deployer.answer(), [app.id, spares[0].id].sort());
  // The narrowed answer still makes no refused, audited read.
  assert.equal(denials().length, deniedBeforeDeployer);
  // A bound Secret the caller may not read is never named, only counted, and only while she may
  // not operate it either: deploying checks operate alone (finding D756). This deployer reads
  // only app of the three Secrets the draft binds.
  const blind = await member("secret-answer-blind-deployer", reads, [app]);
  blind.grant("deploy", "deploy", "agent", agent.id);
  assert.deepEqual(await blind.data(), { operateDenied: [app.id], unreadableOperateDenied: 2 });
  blind.grant("operate-spare", "operate", "secret", spares[0].id);
  blind.grant("operate-app", "operate", "secret", app.id);
  assert.deepEqual(await blind.data(), { operateDenied: [], unreadableOperateDenied: 1 });
  assert.equal(denials().length, deniedBeforeDeployer);
  // The count matches the real deployment: refused while one is counted, authorized at 0.
  const deployPath = `/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  const refused = await fixture.request("POST", deployPath, { session: blind.session });
  assertApiError(refused, 403, "FORBIDDEN");
  assert.equal(denials().at(-1).action, "openclaw.agents.deploy");
  blind.grant("operate-harness", "operate", "secret", harnessSecret.id);
  assert.deepEqual(await blind.data(), { operateDenied: [], unreadableOperateDenied: 0 });
  // The deployment also checks the Agent's own access to the Secrets the editor rebound.
  for (const secret of [app, spares[0]]) {
    await fixture.grantAgentSecretOperate(agent, secret.ref);
  }
  // Every authorization check passes: this fixture's Compute Driver then refuses the topology,
  // which is no authorization denial.
  const deniedBeforeDeploy = denials().length;
  const admitted = await fixture.request("POST", deployPath, { session: blind.session });
  assertApiError(admitted, 409, "RESOURCE_CONFLICT");
  assert.equal(denials().length, deniedBeforeDeploy);
  const deniedAfterDeploy = denials().length;
  // A reader who may not deploy or update gets no count.
  const blindReader = await member("secret-answer-blind-reader", reads, []);
  assert.deepEqual(await blindReader.data(), { operateDenied: [], unreadableOperateDenied: 0 });
  assert.equal(denials().length, deniedAfterDeploy);
  // Both updates without Configuration read: no save can bind a Secret, so it is not reported.
  const unreadConfiguration = await member(
    "secret-answer-no-configuration-read",
    [
      ["read", "namespace"],
      ["read", "agent"],
      ["update", "agent"],
      ["update", "configuration"],
    ],
    readable,
  );
  assert.deepEqual(await unreadConfiguration.answer(), []);
  // Without Namespace read the Secrets cannot be listed: not reported, and the answer makes no
  // refused, audited Namespace read.
  const unreadNamespace = await member(
    "secret-answer-no-namespace-read",
    [
      ["read", "agent"],
      ["read", "configuration"],
      ["update", "agent"],
      ["update", "configuration"],
    ],
    readable,
  );
  const deniedBefore = denials().length;
  assert.deepEqual(await unreadNamespace.answer(), []);
  assert.equal(denials().length, deniedBefore);

  // An IAM failure on a Secret's operate decision is not a denial: the whole answer is
  // unavailable, so the console keeps every Secret choosable instead of marking some.
  const outage = await fixture.withIamOutage(
    (request) => request.action === "operate" && request.resource.kind === "secret",
    () => fixture.request("GET", answerPath, { session: editor.session }),
  );
  assertApiError(outage, 503, "DEPENDENCY_UNAVAILABLE");
  // The answer itself requires Agent read and an existing Agent.
  const missing = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/agt_00000000-0000-4000-8000-000000000000/permissions/secrets`,
  );
  assert.equal(missing.status, 404);
});

// The answer makes one decision per readable Secret. They share one platform read unit, so the
// native IAM Driver reads its policy once for all of them; outside a unit each would check out
// its own database connection and policy read (finding 2473). The units the answer opens do not
// grow with the number of Secrets.
test("the Agent Secret answer makes its Secret decisions in one read unit", async (t) => {
  const unit = new AsyncLocalStorage();
  let units = 0;
  const wrapState = (state) => ({
    read: (work) => {
      units += 1;
      return unit.run(true, () => state.read(work));
    },
    transact: (work) => state.transact(work),
  });
  const { fixture, namespace, agent, app, bot, member } = await secretAnswerFixture(t, {
    wrapState,
  });
  const editor = await member(
    "secret-answer-units",
    [
      ["read", "namespace"],
      ["read", "agent"],
      ["read", "configuration"],
      ["read", "secret"],
    ],
    [],
  );
  editor.grant("configuration", "update", "configuration", agent.configurationId);
  const decisions = [];
  const authorize = fixture.iamDriver.authorize;
  fixture.iamDriver.authorize = async (request) => {
    if (request.resource.kind === "secret") {
      decisions.push({ action: request.action, inUnit: unit.getStore() === true });
    }
    return authorize.call(fixture.iamDriver, request);
  };
  t.after(() => {
    fixture.iamDriver.authorize = authorize;
  });
  const measure = async () => {
    decisions.length = 0;
    units = 0;
    const denied = await editor.answer();
    return { denied, units, decisions: [...decisions] };
  };
  const few = await measure();
  // The bound Slack Secrets and the fixture's Harness authentication Secret.
  assert.equal(few.denied.length, 3);
  assert.ok([app.id, bot.id].every((id) => few.denied.includes(id)));
  for (let index = 0; index < 6; index += 1) {
    await fixture.createSecret(namespace.id, `Extra token ${index}`, "extra-value");
  }
  const many = await measure();
  assert.equal(many.denied.length, 9);
  // Each readable Secret costs a read and an operate decision, all inside a read unit.
  assert.equal(many.decisions.filter(({ action }) => action === "operate").length, 9);
  assert.ok(many.decisions.every(({ inUnit }) => inUnit));
  assert.equal(many.units, few.units);
});

// Agent create authorizes Secret operate on its Harness authentication source and on its
// Configuration's Secret bindings, so a Create Agent Secret field that offered every readable
// Secret let Create be refused only after the click (finding 2469). There is no Agent yet, so
// the Namespace Secret answer names the readable Secrets the caller may not operate, only to a
// caller who may create an Agent, and each step proves it against the same real creates.
async function namespaceSecretAnswerFixture(t, options = {}) {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink, ...options });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Create Secret answer", { ready: true });
  const model = await fixture.createSecret(namespace.id, "Model key", "model-value");
  const bot = await fixture.createSecret(namespace.id, "Bot token", "bot-value");
  const answerPath = `/namespaces/${namespace.id}/permissions/secrets`;
  // A member with `grants` across the Namespace, plus read on each of the `readable` Secrets.
  const member = async (label, grants, readable) => {
    const created = await fixture.createNamespaceMember(label, namespace.id, grants);
    const grant = (id, action, resourceKind, resourceId) => {
      fixture.policy.roles.push({
        id: `role-${label}-${id}`,
        namespaceId: namespace.id,
        permissions: [{ action, resourceKind }],
      });
      fixture.policy.bindings.push({
        id: `binding-${label}-${id}`,
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: created.principal.id,
        roleId: `role-${label}-${id}`,
        // A grant without a resource ID applies across the Namespace, as Agent create needs.
        ...(resourceId === undefined ? {} : { resourceKind, resourceId }),
      });
    };
    for (const secret of readable) {
      grant(`read-${secret.id}`, "read", "secret", secret.id);
    }
    const session = await fixture.signIn(created.credentials);
    const answer = async () => {
      const response = await fixture.request("GET", answerPath, { session });
      assert.equal(response.status, 200);
      return response.data.operateDenied;
    };
    return { session, grant, answer };
  };
  const denials = () => auditSink.list().filter((event) => event.kind === "authorization_denial");
  return { fixture, namespace, model, bot, answerPath, member, denials };
}

test("the Namespace Secret answer names the readable Secrets Agent creation would be refused on", async (t) => {
  const { fixture, namespace, model, bot, answerPath, member, denials } =
    await namespaceSecretAnswerFixture(t);
  // Readable spare Secrets. The answer is sorted by ID; the Secret list is in creation order. A
  // spare is added until the two orders differ, so the sort is observable.
  const spares = [];
  const listedSpares = async () =>
    (await fixture.request("GET", `/namespaces/${namespace.id}/secrets`)).data
      .map((secret) => secret.id)
      .filter((id) => spares.some((spare) => spare.id === id));
  do {
    spares.push(
      await fixture.createSecret(namespace.id, `Spare key ${spares.length}`, "spare-value"),
    );
  } while (
    spares.length < 2 ||
    JSON.stringify(await listedSpares()) === JSON.stringify((await listedSpares()).toSorted())
  );
  const spareIds = spares.map((spare) => spare.id).sort();
  // A Secret the member cannot read: the answer never names it, operable or not.
  await fixture.createSecret(namespace.id, "Unread key", "unread-value");
  const readable = [model, bot, ...spares];

  // An administrator may operate every Secret, so nothing is listed.
  const admin = await fixture.request("GET", answerPath);
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.data, { operateDenied: [] });

  // Everything Create Agent saves except Agent create: it can create no Agent, so no Secret
  // choice there can matter and the answer is not reported.
  const creator = await member(
    "create-secret-answer",
    [
      ["read", "namespace"],
      ["read", "configuration"],
      ["create", "configuration"],
    ],
    readable,
  );
  assert.deepEqual(await creator.answer(), []);
  // Agent create without operate on any Secret: every readable Secret is listed, by ID.
  creator.grant("agent-create", "create", "agent");
  assert.deepEqual(await creator.answer(), [model.id, bot.id, ...spareIds].sort());
  // Operate on the model key and the bot token: only the spares are listed.
  creator.grant("operate-model", "operate", "secret", model.id);
  creator.grant("operate-bot", "operate", "secret", bot.id);
  assert.deepEqual(await creator.answer(), spareIds);
  // The probes are answers, not attempted operations.
  assert.equal(denials().length, 0);

  // The answer matches the real Create Agent requests: a Configuration that binds a listed
  // Secret is refused, and so is an Agent that uses one as its Harness authentication source.
  const createConfiguration = (secret) =>
    fixture.request("POST", `/namespaces/${namespace.id}/configurations`, {
      session: creator.session,
      body: {
        kind: "agent",
        values: {},
        secretBindings: { SLACK_BOT_TOKEN: { source: secret.ref, delivery: { type: "env" } } },
      },
    });
  const createAgent = (name, configurationId, secret) =>
    fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      session: creator.session,
      body: { name, configurationId, harnessAuth: { method: "api_key", source: secret.ref } },
    });
  assertApiError(await createConfiguration(spares[0]), 403, "FORBIDDEN");
  assert.equal(denials().at(-1).action, "openclaw.configurations.create");
  const configuration = await createConfiguration(bot);
  assert.equal(configuration.status, 201);
  assertApiError(
    await createAgent("Refused create agent", configuration.data.id, spares[0]),
    403,
    "FORBIDDEN",
  );
  assert.equal(denials().at(-1).action, "openclaw.agents.create");
  // Operate on a spare too: it is no longer listed, and the Agent that uses it is created.
  creator.grant("operate-spare", "operate", "secret", spares[0].id);
  assert.deepEqual(
    await creator.answer(),
    spareIds.filter((id) => id !== spares[0].id),
  );
  const created = await createAgent("Created create agent", configuration.data.id, spares[0]);
  assert.equal(created.status, 201);

  // Without Namespace read the answer is refused and audited exactly like the Namespace
  // permission answer, whether or not the caller may create Agents, and so is an unknown
  // Namespace (finding 2478): the probe reveals nothing the Namespace answer does not.
  const permissionsPath = `/namespaces/${namespace.id}/permissions`;
  const missingNamespace = "/namespaces/ns_00000000-0000-4000-8000-000000000000/permissions";
  const sameAsNamespaceAnswer = async (session, path) => {
    const outcome = async (suffix) => {
      const before = denials().length;
      const response = await fixture.request("GET", path + suffix, { session });
      return {
        status: response.status,
        code: response.body?.error?.code,
        denials: denials().length - before,
      };
    };
    const namespaceAnswer = await outcome("");
    assert.equal(namespaceAnswer.status, 403);
    assert.equal(namespaceAnswer.denials, 1);
    assert.deepEqual(await outcome("/secrets"), namespaceAnswer);
  };
  const creatorWithoutRead = await member(
    "create-secret-answer-no-namespace-read",
    [
      ["create", "agent"],
      ["create", "configuration"],
    ],
    readable,
  );
  const stranger = await member("create-secret-answer-stranger", [["read", "configuration"]], []);
  for (const { session } of [creatorWithoutRead, stranger]) {
    await sameAsNamespaceAnswer(session, permissionsPath);
    await sameAsNamespaceAnswer(session, missingNamespace);
  }
  await sameAsNamespaceAnswer(creator.session, missingNamespace);

  // An IAM failure on a Secret's operate decision is not a denial: the whole answer is
  // unavailable, so the console keeps every Secret choosable instead of marking some.
  const deniedBefore = denials().length;
  const outage = await fixture.withIamOutage(
    (request) => request.action === "operate" && request.resource.kind === "secret",
    () => fixture.request("GET", answerPath, { session: creator.session }),
  );
  assertApiError(outage, 503, "DEPENDENCY_UNAVAILABLE");
  assert.equal(denials().length, deniedBefore);
});

// The answer makes one decision per readable Secret. They share one platform read unit, so the
// native IAM Driver reads its policy once for all of them, as for the Agent Secret answer
// (finding 2473). The units the answer opens do not grow with the number of Secrets.
test("the Namespace Secret answer makes its Secret decisions in one read unit", async (t) => {
  const unit = new AsyncLocalStorage();
  let units = 0;
  const wrapState = (state) => ({
    read: (work) => {
      units += 1;
      return unit.run(true, () => state.read(work));
    },
    transact: (work) => state.transact(work),
  });
  const { fixture, namespace, model, bot, member } = await namespaceSecretAnswerFixture(t, {
    wrapState,
  });
  const creator = await member(
    "create-secret-answer-units",
    [
      ["read", "namespace"],
      ["read", "secret"],
      ["create", "agent"],
    ],
    [],
  );
  const decisions = [];
  const authorize = fixture.iamDriver.authorize;
  fixture.iamDriver.authorize = async (request) => {
    if (request.resource.kind === "secret") {
      decisions.push({ action: request.action, inUnit: unit.getStore() === true });
    }
    return authorize.call(fixture.iamDriver, request);
  };
  t.after(() => {
    fixture.iamDriver.authorize = authorize;
  });
  const measure = async () => {
    decisions.length = 0;
    units = 0;
    const denied = await creator.answer();
    return { denied, units, decisions: [...decisions] };
  };
  const few = await measure();
  assert.deepEqual(few.denied, [model.id, bot.id].sort());
  for (let index = 0; index < 6; index += 1) {
    await fixture.createSecret(namespace.id, `Extra key ${index}`, "extra-value");
  }
  const many = await measure();
  assert.equal(many.denied.length, 8);
  // Each readable Secret costs a read and an operate decision, all inside a read unit.
  assert.equal(many.decisions.filter(({ action }) => action === "operate").length, 8);
  assert.ok(many.decisions.every(({ inUnit }) => inUnit));
  assert.equal(many.units, few.units);
});

// Each Agent update also checks the caller's grant on every source the Agent and its
// Configuration bind, so Agent update alone does not say a save of plugins, authentication or
// repository access can succeed (finding 2441). The answer covers the Configuration's bound
// Secrets and the Harness authentication Secret, and only for a caller who may update the Agent
// and read its Configuration. Each step proves the answer against the same real Agent PATCH.
test("the Agent sources answer matches what a real Agent update checks", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent sources", { ready: true });
  const bound = await fixture.createSecret(namespace.id, "Bound token", "bound-token-value");
  const second = await fixture.createSecret(namespace.id, "Second token", "second-token-value");
  // The fixture binds a Harness authentication Secret too; a Secret bound to two names is one
  // decision.
  const agent = await fixture.createAgent(
    namespace.id,
    "Sources agent",
    {},
    {
      secretBindings: {
        EXTERNAL_API_TOKEN: { source: bound.ref, delivery: { type: "env" } },
        EXTERNAL_API_TOKEN_ALIAS: { source: bound.ref, delivery: { type: "env" } },
        SECOND_API_TOKEN: { source: second.ref, delivery: { type: "env" } },
      },
    },
  );
  assert.equal(agent.harnessAuth.method, "api_key");
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const member = await fixture.createAccountWithPolicy("agent-sources", (principal) => {
    fixture.policy.roles.push({
      id: "role-agent-sources-editor",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-agent-sources-editor",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-agent-sources-editor",
    });
  });
  const session = await fixture.signIn(member.credentials);
  const grant = (id, action, resourceKind, resourceId) => {
    if (!fixture.policy.roles.some((role) => role.id === `role-${id}`)) {
      fixture.policy.roles.push({
        id: `role-${id}`,
        namespaceId: namespace.id,
        permissions: [{ action, resourceKind }],
      });
    }
    fixture.policy.bindings.push({
      id: `binding-${id}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: member.principal.id,
      roleId: `role-${id}`,
      resourceKind,
      resourceId,
    });
  };
  const summary = async () => {
    const response = await fixture.request("GET", `${agentPath}/permissions`, { session });
    assert.equal(response.status, 200);
    return response.data;
  };
  const answer = async () => {
    const data = await summary();
    assert.equal(data.update, true);
    return data.agentSourcesOperate;
  };
  // A no-op save, as the console's plugin, authentication and repository saves are on top.
  const save = () =>
    fixture.request("PATCH", agentPath, {
      session,
      body: { configurationId: agent.configurationId },
    });
  const denials = () => auditSink.list().filter((event) => event.kind === "authorization_denial");

  const revoke = (id) => {
    const index = fixture.policy.bindings.findIndex((binding) => binding.id === `binding-${id}`);
    assert.notEqual(index, -1);
    fixture.policy.bindings.splice(index, 1);
  };

  // Operate on every bound source, but no Configuration read: an update needs that read and the
  // bindings are not visible without it, so there is no answer.
  grant("agent-sources-bound", "operate", "secret", bound.id);
  grant("agent-sources-second", "operate", "secret", second.id);
  grant("agent-sources-harness", "operate", "secret", agent.harnessAuth.source.id);
  assert.equal(await answer(), false);
  // The console names the missing Configuration read rather than source operate.
  assert.equal((await summary()).configurationRead, false);
  assertApiError(await save(), 403, "FORBIDDEN");
  // With Configuration read the set is complete, and the same save succeeds.
  grant("agent-sources-configuration", "read", "configuration", agent.configurationId);
  assert.equal((await summary()).configurationRead, true);
  assert.equal(await answer(), true);
  assert.equal((await save()).status, 200);
  // Operate on one of the two Configuration Secrets is not enough: the answer covers every
  // bound Secret, not any of them.
  revoke("agent-sources-second");
  assert.equal(await answer(), false);
  assertApiError(await save(), 403, "FORBIDDEN");
  // Every Configuration Secret but not the Harness authentication Secret: still refused.
  grant("agent-sources-second", "operate", "secret", second.id);
  revoke("agent-sources-harness");
  const refusals = denials().length;
  assert.equal(await answer(), false);
  // The answers are not attempted operations; only the refused save is audited.
  assert.equal(denials().length, refusals);
  assertApiError(await save(), 403, "FORBIDDEN");
  assert.equal(denials().length, refusals + 1);

  // Every source grant and Configuration read, but no Agent update: an update is refused, so the
  // answer is false even though each source check would pass.
  grant("agent-sources-harness", "operate", "secret", agent.harnessAuth.source.id);
  assert.equal(await answer(), true);
  const editor = fixture.policy.roles.find((role) => role.id === "role-agent-sources-editor");
  editor.permissions = editor.permissions.filter((permission) => permission.action !== "update");
  const withoutUpdate = await summary();
  assert.equal(withoutUpdate.update, false);
  assert.equal(withoutUpdate.configurationRead, true);
  assert.equal(withoutUpdate.agentSourcesOperate, false);
  assertApiError(await save(), 403, "FORBIDDEN");

  // A ServiceAccount used for Harness authentication is checked with read, not operate: every
  // update reads it, so the answer needs that grant too (finding 2459).
  editor.permissions.push({ action: "update", resourceKind: "agent" });
  // Issuance is outside this test: the account is seeded through State as the console tests do.
  const account = await fixture.controller.transact((state) =>
    state.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: "Harness account",
    }),
  );
  const switched = await fixture.request("PATCH", agentPath, {
    body: {
      configurationId: agent.configurationId,
      harnessAuth: {
        method: "codex_pat",
        source: { kind: "service_account", namespaceId: namespace.id, id: account.id },
      },
    },
  });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  // Operate on every bound Secret and Configuration read, but no ServiceAccount read.
  assert.equal(await answer(), false);
  assertApiError(await save(), 403, "FORBIDDEN");
  grant("agent-sources-account", "read", "service_account", account.id);
  assert.equal(await answer(), true);
  assert.equal((await save()).status, 200);
});

test("console static routes expose only public assets and preserve API JSON failures", async (t) => {
  const fixture = await createConsoleAppFixture(t);

  for (const path of [
    "/console/",
    "/console/login",
    "/console/agents",
    "/console/agents/new",
    "/console/agents/agt_00000000-0000-4000-8000-000000000000",
    "/console/settings",
  ]) {
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 200, path);
    assert.match(result.response.headers.get("content-type") ?? "", /text\/html/i, path);
    assert.match(result.text, /<script[^>]+src="\/console\/console\.mjs"/i, path);
    assert.doesNotMatch(result.text, /\{\s*"error"\s*:/, path);
    assert.match(result.text, /<meta name="occ-build-revision" content="" \/>/, path);
  }

  for (const [path, mime] of [
    ["/console/oce-mascot.png", /image\/png/i],
    ["/console/oce-mascot-inverse.png", /image\/png/i],
    ["/console/favicon.ico", /image\/vnd\.microsoft\.icon/i],
    ["/console/workspace-defaults.mjs", /javascript/i],
    ["/console/preset-variables.mjs", /javascript/i],
    ["/console/default-codex-preset.mjs", /javascript/i],
    ["/console/console.css", /text\/css/i],
    ["/console/fonts/instrument-sans-latin.woff2", /font\/woff2/i],
    ["/console/console.mjs", /javascript/i],
    ["/console/agents.mjs", /javascript/i],
    ["/console/agents/harness-auth.mjs", /javascript/i],
    ["/console/channels.mjs", /javascript/i],
    ["/console/dom.mjs", /javascript/i],
    ["/console/channels.css", /text\/css/i],
  ]) {
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 200, path);
    assert.match(result.response.headers.get("content-type") ?? "", mime, path);
    assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  }

  for (const path of [
    "/console/dom.mts",
    "/console/index.ts",
    "/console/%2e%2e/index.ts",
    "/console/missing.css",
  ]) {
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 404, path);
    assert.doesNotMatch(result.text, /createFastifyApp|OCC_AUTH_SECRET|apiKeyPath/, path);
  }

  const apiMiss = await fixture.rawRequest("GET", "/api/does-not-exist");
  assert.equal(apiMiss.response.status, 404);
  assert.match(apiMiss.response.headers.get("content-type") ?? "", /application\/json/i);
  assert.equal(JSON.parse(apiMiss.text).error.code, "NOT_FOUND");

  const methodMiss = await fixture.rawRequest("POST", "/backends");
  assert.equal(methodMiss.response.status, 405);
  assert.equal(JSON.parse(methodMiss.text).error.code, "METHOD_NOT_ALLOWED");
});

test("console scripts and styles are compressed when accepted; the shell and binaries are not", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const host = new URL(fixture.origin).host;
  const consoleFile = (path) =>
    readFile(new URL(`../../apps/controller/src/console/${path}`, import.meta.url));
  // Read the wire bytes: Fetch decodes content codings before exposing its body.
  const fetchRaw = (url, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        new URL(url, fixture.origin),
        { method, headers: { host, ...headers } },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              statusCode: response.statusCode,
              headers: response.headers,
              rawPayload: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });

  const script = Buffer.from(
    stripTypeScriptTypes((await consoleFile("agents/detail.mts")).toString("utf8")),
  );
  const plain = await fetchRaw("/console/agents/detail.mjs");
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.headers.vary, "Accept-Encoding");
  assert.deepEqual(plain.rawPayload, script);
  const csp = plain.headers["content-security-policy"];
  assert.match(csp, /script-src 'self'/);

  for (const [acceptEncoding, encoding, decode] of [
    ["gzip", "gzip", gunzipSync],
    ["gzip, deflate, br, zstd", "br", brotliDecompressSync],
    ["br;q=0.5, gzip;q=1", "gzip", gunzipSync],
    ["identity;q=0.5, gzip;q=1", "gzip", gunzipSync],
    ["identity;q=0, gzip;q=0.5", "gzip", gunzipSync],
    ["identity;q=1, br;q=1, gzip;q=1", "br", brotliDecompressSync],
    ["*", "br", brotliDecompressSync],
  ]) {
    const result = await fetchRaw("/console/agents/detail.mjs", {
      "accept-encoding": acceptEncoding,
    });
    assert.equal(result.statusCode, 200, acceptEncoding);
    assert.equal(result.headers["content-encoding"], encoding, acceptEncoding);
    assert.equal(result.headers.vary, "Accept-Encoding", acceptEncoding);
    assert.match(result.headers["content-type"], /javascript/, acceptEncoding);
    assert.equal(Number(result.headers["content-length"]), result.rawPayload.length);
    assert.ok(result.rawPayload.length < script.length / 3, acceptEncoding);
    assert.deepEqual(decode(result.rawPayload), script, acceptEncoding);
    // Compression changes neither the CSP nor the API headers that keep assets uncached.
    assert.equal(result.headers["content-security-policy"], csp);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
  }

  for (const acceptEncoding of [
    "identity",
    "br;q=0, gzip;q=0",
    "deflate",
    "*;q=0",
    "identity;q=1, gzip;q=0.5",
    "br;q=0.5, identity;q=1",
    "identity;q=1, *;q=0.5",
  ]) {
    const result = await fetchRaw("/console/console.css", { "accept-encoding": acceptEncoding });
    assert.equal(result.headers["content-encoding"], undefined, acceptEncoding);
    assert.equal(result.headers.vary, "Accept-Encoding", acceptEncoding);
    assert.deepEqual(result.rawPayload, await consoleFile("console.css"), acceptEncoding);
  }

  // HEAD reports the GET representation. Range is unsupported: it must keep returning the whole
  // encoded body, never a slice of it, until someone adds range support on purpose.
  const gzipGet = await fetchRaw("/console/console.css", { "accept-encoding": "gzip" });
  const head = await fetchRaw("/console/console.css", { "accept-encoding": "gzip" }, "HEAD");
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal(head.headers["content-length"], gzipGet.headers["content-length"]);
  assert.equal(head.rawPayload.length, 0);
  const identityHead = await fetchRaw(
    "/console/console.css",
    { "accept-encoding": "identity;q=1, gzip;q=0.5" },
    "HEAD",
  );
  assert.equal(identityHead.statusCode, 200);
  assert.equal(identityHead.headers["content-encoding"], undefined);
  assert.equal(
    identityHead.headers["content-length"],
    String((await consoleFile("console.css")).length),
  );
  assert.equal(identityHead.rawPayload.length, 0);
  const ranged = await fetchRaw("/console/console.css", {
    "accept-encoding": "gzip",
    range: "bytes=0-9",
  });
  assert.equal(ranged.statusCode, 200);
  assert.deepEqual(ranged.rawPayload, gzipGet.rawPayload);

  // The generated preset module is compressed like the files beside it.
  const preset = await fetchRaw("/console/default-codex-preset.mjs", { "accept-encoding": "gzip" });
  assert.equal(preset.headers["content-encoding"], "gzip");
  assert.match(gunzipSync(preset.rawPayload).toString("utf8"), /^export default \{/);

  // The shell also answers the sign-in route; it and binary assets are always identity.
  for (const path of ["/console/login", "/console/", "/console/missing.css"]) {
    const result = await fetchRaw(path, { "accept-encoding": "gzip, br" });
    assert.equal(result.headers["content-encoding"], undefined, path);
    assert.equal(result.headers.vary, undefined, path);
    assert.deepEqual(result.rawPayload, await consoleFile("index.html"), path);
  }
  for (const path of ["/console/oce-mascot.png", "/console/fonts/instrument-sans-latin.woff2"]) {
    const result = await fetchRaw(path, { "accept-encoding": "gzip, br" });
    assert.equal(result.statusCode, 200, path);
    assert.equal(result.headers["content-encoding"], undefined, path);
  }
});

test("console auth routes reject untrusted browser origins and issue production session cookies", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    authMode: "production",
    development: { enabled: false },
  });

  const signInBody = {
    email: fixture.credentials.email,
    password: fixture.credentials.password,
  };
  const rejected = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    headers: { origin: "https://attacker.example.test" },
    body: signInBody,
  });
  assert.equal(rejected.response.status, 403);
  assert.equal(rejected.response.headers.get("set-cookie"), null);
  // A correct password with a foreign Origin is refused for the Origin, not the credentials.
  assert.equal(JSON.parse(rejected.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);
  // A browser that omits Origin still names a cross-site request in Sec-Fetch-Site.
  const crossSiteSignIn = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    headers: { "sec-fetch-site": "cross-site" },
    body: signInBody,
  });
  assert.equal(crossSiteSignIn.response.status, 403);
  assert.equal(crossSiteSignIn.response.headers.get("set-cookie"), null);
  assert.equal(JSON.parse(crossSiteSignIn.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);

  const cliAccepted = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    body: signInBody,
  });
  assert.equal(cliAccepted.response.status, 200, cliAccepted.text);

  const accepted = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    headers: { origin: fixture.origin },
    body: signInBody,
  });
  assert.equal(accepted.response.status, 200, accepted.text);
  const setCookies = setCookieHeaders(accepted.response);
  const setCookie = setCookies.join("\n");
  const requestCookie = cookieHeaderFromSetCookie(setCookies);
  assert.ok(requestCookie.length > 0);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);

  const rejectedSignOut = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: {
      cookie: requestCookie,
      origin: "https://attacker.example.test",
    },
  });
  assert.equal(rejectedSignOut.response.status, 403);
  assert.equal(JSON.parse(rejectedSignOut.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);

  const retainedSession = await fixture.rawRequest("GET", "/api/auth/session", {
    headers: { cookie: requestCookie },
  });
  assert.equal(retainedSession.response.status, 200, retainedSession.text);
  assert.equal(JSON.parse(retainedSession.text).data.authenticated, true);

  const crossSiteNoOrigin = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: {
      cookie: requestCookie,
      "sec-fetch-site": "cross-site",
    },
  });
  assert.equal(crossSiteNoOrigin.response.status, 403);
  assert.equal(JSON.parse(crossSiteNoOrigin.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);

  // Without the GitHub profile the session key still only narrows the cookie session.
  const providers = await fixture.rawRequest("GET", "/api/auth/providers");
  assert.deepEqual(JSON.parse(providers.text).data, {
    github: false,
    google: false,
    oidc: false,
    password: true,
    sessionBinding: false,
  });
  const sessionKey = JSON.parse(retainedSession.text).data.sessionKey;
  assert.match(sessionKey, /^[A-Za-z0-9_-]{43}$/);
  const foreignKey = "A".repeat(43);
  const foreignSession = await fixture.rawRequest("GET", "/api/auth/session", {
    headers: { cookie: requestCookie, "x-occ-session-key": foreignKey },
  });
  assert.equal(foreignSession.response.status, 401, foreignSession.text);
  const foreignSignOut = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: { cookie: requestCookie, origin: fixture.origin, "x-occ-session-key": foreignKey },
  });
  assert.equal(foreignSignOut.response.status, 401, foreignSignOut.text);
  assert.equal(foreignSignOut.response.headers.get("set-cookie"), null);
  const keptSession = await fixture.rawRequest("GET", "/api/auth/session", {
    headers: { cookie: requestCookie, "x-occ-session-key": sessionKey },
  });
  assert.equal(JSON.parse(keptSession.text).data.sessionKey, sessionKey);

  // The exact Origin check runs before the session key is considered.
  const originlessSignOut = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: { cookie: requestCookie, "x-occ-session-key": foreignKey },
  });
  assert.equal(originlessSignOut.response.status, 403);
  assert.equal(JSON.parse(originlessSignOut.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);

  const cliSignOut = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: { cookie: requestCookie, origin: fixture.origin, "x-occ-session-key": sessionKey },
  });
  assert.equal(cliSignOut.response.status, 200, cliSignOut.text);

  // A body that fails the sign-in schema is a 400 before any credential check.
  const malformedSignIn = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    headers: { origin: fixture.origin },
    body: { email: fixture.credentials.email },
  });
  assert.equal(malformedSignIn.response.status, 400, malformedSignIn.text);
  assert.equal(JSON.parse(malformedSignIn.text).error.code, "INVALID_REQUEST");
  assert.deepEqual(JSON.parse(malformedSignIn.text).error.details, [
    { path: "/password", code: "REQUIRED" },
  ]);

  // Every status answered above is in the checked-in OpenAPI contract, so clients generated
  // from it handle the Origin and schema refusals. The contract once listed neither.
  for (const [path, result] of [
    ["/api/auth/sign-in/email", rejected],
    ["/api/auth/sign-in/email", crossSiteSignIn],
    ["/api/auth/sign-in/email", accepted],
    ["/api/auth/sign-in/email", malformedSignIn],
    ["/api/auth/sign-out", rejectedSignOut],
    ["/api/auth/sign-out", crossSiteNoOrigin],
    ["/api/auth/sign-out", foreignSignOut],
    ["/api/auth/sign-out", originlessSignOut],
    ["/api/auth/sign-out", cliSignOut],
  ]) {
    const status = String(result.response.status);
    assert.ok(
      Object.hasOwn(contract.paths[path].post.responses, status),
      `POST ${path} answered ${status}, which its OpenAPI operation does not list`,
    );
  }
});

test("every /api/auth operation that takes a body answers the 400, 413 and 415 it lists", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    authMode: "production",
    development: { enabled: false },
  });
  const session = await fixture.signIn();
  const operations = Object.entries(contract.paths)
    .filter(([path]) => path.startsWith("/api/auth/"))
    .flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, operation]) => operation.requestBody !== undefined)
        .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation })),
    );
  // Fourteen such operations exist today; an empty scan would prove nothing.
  assert.ok(operations.length >= 14, `found ${operations.length} operations`);
  // An Installation administrator with a trusted Origin passes admission, so each refusal
  // comes from the body itself: the declared size before parsing, then the media type, then
  // the operation's schema.
  for (const { method, path, operation } of operations) {
    for (const [status, code, contentType, payload] of [
      ["413", "PAYLOAD_TOO_LARGE", "application/json", `{"pad":"${"x".repeat(70 * 1024)}"}`],
      ["415", "UNSUPPORTED_MEDIA_TYPE", "text/plain", "expectedVersion=1"],
      ["400", "INVALID_REQUEST", "application/json", JSON.stringify({ unexpected: true })],
    ]) {
      const response = await fixture.app.inject({
        method,
        url: path.replace("{userId}", "usr_unknown").replace("{methodId}", "method_unknown"),
        headers: authenticatedHeaders(session, {
          origin: fixture.origin,
          "content-type": contentType,
        }),
        payload,
      });
      const label = `${operation.operationId} ${status}`;
      assert.equal(String(response.statusCode), status, `${label}: ${response.body}`);
      assert.equal(JSON.parse(response.body).error.code, code, label);
      assert.ok(Object.hasOwn(operation.responses, status), `${label} is not in the contract`);
    }
  }
});

test("untrusted cookie mutations do not clean up an expired session", async (t) => {
  const fixture = await createConsoleAppFixture(t, { development: { enabled: false } });
  await fixture.bootstrap();
  const session = await fixture.signIn();
  const expired = fixture.memoryDatabase.session.at(-1);
  assert.ok(expired);
  expired.expiresAt = new Date(0);

  const denied = await fixture.rawRequest("POST", "/api/auth/service-keys", {
    headers: { cookie: session.cookie, origin: "http://127.0.0.1:1" },
  });
  assert.ok(fixture.memoryDatabase.session.includes(expired), "untrusted request changed session");
  assert.equal(denied.response.status, 403, denied.text);

  const trusted = await fixture.rawRequest("POST", "/api/auth/service-keys", {
    headers: { cookie: session.cookie, origin: fixture.origin },
  });
  assert.equal(trusted.response.status, 401, trusted.text);
  assert.equal(fixture.memoryDatabase.session.includes(expired), false);
});

test("public Agent revisions return the selected binding without private credential resolution metadata", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Public binding snapshot", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Bound Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  assert.deepEqual(revision.harnessAuth, agent.harnessAuth);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  for (const endpoint of [path, `${path}/${revision.id}`]) {
    const response = await fixture.request("GET", endpoint);
    assert.equal(response.status, 200);
    assert.doesNotMatch(
      JSON.stringify(response.data),
      /backendRef|secretDriverId|workspaceId|secretRef|test-api-key/,
    );
  }
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: null,
  });
  const historical = await fixture.request("GET", `${path}/${revision.id}`);
  assert.deepEqual(historical.data.harnessAuth, agent.harnessAuth);
});

// The Agent page skips its native admin status probe when this answer is false (review of
// #3600), so the answer must be the decision that probe makes: Agent administer on the exact
// Agent, not any other Agent action. Each step proves the answer against the real probe.
test("the Agent administer answer matches what native admin access checks", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Administer answer", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Administered agent");
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  // Every other Agent action, so an answer that reports any of them instead is caught.
  const member = await fixture.createNamespaceMember("administer-answer", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["update", "agent"],
    ["deploy", "agent"],
    ["operate", "agent"],
    ["delete", "agent"],
  ]);
  const session = await fixture.signIn(member.credentials);
  const answer = async () => {
    const summary = await fixture.request("GET", `${agentPath}/permissions`, { session });
    assert.equal(summary.status, 200);
    return summary.data.administer;
  };
  const probe = () => fixture.request("GET", `${agentPath}/native-admin`, { session });
  const denials = () => auditSink.list().filter((event) => event.kind === "authorization_denial");

  assert.equal(await answer(), false);
  // The answer is not an attempted operation: only the real probe is audited as denied.
  assert.equal(denials().length, 0);
  assertApiError(await probe(), 403, "FORBIDDEN");
  assert.deepEqual(
    denials().map((event) => event.action),
    ["openclaw.agents.native_admin.read"],
  );

  // Administer granted on this Agent alone: the answer probes this exact Agent, as the probe
  // does, so it is true here and stays false for another Agent the member can read.
  const other = await fixture.createAgent(namespace.id, "Other administered agent");
  fixture.policy.roles.push({
    id: "role-administer-exact",
    namespaceId: namespace.id,
    permissions: [{ action: "administer", resourceKind: "agent" }],
  });
  fixture.policy.bindings.push({
    id: "binding-administer-exact",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: member.principal.id,
    roleId: "role-administer-exact",
    resourceKind: "agent",
    resourceId: agent.id,
  });
  assert.equal(await answer(), true);
  const otherPath = `/namespaces/${namespace.id}/agents/${other.id}`;
  const otherSummary = await fixture.request("GET", `${otherPath}/permissions`, { session });
  assert.equal(otherSummary.status, 200);
  assert.equal(otherSummary.data.administer, false);
  assertApiError(
    await fixture.request("GET", `${otherPath}/native-admin`, { session }),
    403,
    "FORBIDDEN",
  );

  fixture.policy.roles
    .find((role) => role.id === "role-administer-answer")
    .permissions.push({ action: "administer", resourceKind: "agent" });
  assert.equal(await answer(), true);
  // This fixture does not enable native admin UI, so an authorized probe reports it disabled.
  const allowed = await probe();
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.data, { status: "disabled" });
});

// The console reads a false answer as "this caller may not", and disables or skips the matching
// action. An IAM failure is not a denial: each decision behind an answer fails the whole answer
// with 503, so the console keeps its usual rule instead of hiding an action the caller may take.
test("an IAM failure on any caller permission decision fails the whole answer instead of reading as a denial", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Answer outages", { ready: true });
  const bound = await fixture.createSecret(namespace.id, "Bound token", "bound-token-value");
  // The fixture binds a Harness authentication Secret besides the Configuration's bound one, so
  // the Configuration Secrets answers and the Agent sources answer probe different Secrets.
  const agent = await fixture.createAgent(
    namespace.id,
    "Outage agent",
    {},
    { secretBindings: { EXTERNAL_API_TOKEN: { source: bound.ref, delivery: { type: "env" } } } },
  );
  assert.equal(agent.harnessAuth.method, "api_key");
  assert.notEqual(agent.harnessAuth.source.id, bound.id);
  const agentPermissions = `/namespaces/${namespace.id}/agents/${agent.id}/permissions`;
  const namespacePermissions = `/namespaces/${namespace.id}/permissions`;
  const outage = (path, failing, session) =>
    fixture.withIamOutage(failing, () => fixture.request("GET", path, { session }));
  // One exact decision: an action on one resource.
  const decision = (action, kind, id) => (request) =>
    request.action === action && request.resource.kind === kind && request.resource.id === id;

  // The administrator's answers probe every decision; each one fails alone.
  for (const [label, failing] of [
    ["administer", decision("administer", "agent", agent.id)],
    ["configurationUpdate", decision("update", "configuration", agent.configurationId)],
    ["configurationRead", decision("read", "configuration", agent.configurationId)],
    ["agentSourcesOperate", decision("operate", "secret", agent.harnessAuth.source.id)],
  ]) {
    assertApiError(await outage(agentPermissions, failing), 503, "DEPENDENCY_UNAVAILABLE", label);
  }
  for (const [label, failing] of [
    ["agents.create", decision("create", "agent", namespace.id)],
    ["secrets.create", decision("create", "secret", namespace.id)],
  ]) {
    assertApiError(
      await outage(namespacePermissions, failing),
      503,
      "DEPENDENCY_UNAVAILABLE",
      label,
    );
  }

  // Without Agent update the Agent sources answer is false before any Secret decision, so the
  // bound Secret's operate decision is probed only for the Configuration Secrets answers.
  const member = await fixture.createNamespaceMember("answer-outage", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["read", "configuration"],
    ["update", "configuration"],
  ]);
  const session = await fixture.signIn(member.credentials);
  const answer = await fixture.request("GET", agentPermissions, { session });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.update, false);
  assert.deepEqual(answer.data.configurationSecretsOperateDeniedBindings, ["EXTERNAL_API_TOKEN"]);
  assertApiError(
    await outage(agentPermissions, decision("operate", "secret", bound.id), session),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
});
