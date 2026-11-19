import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentListResponse,
  AgentResponse,
  ConfigurationResponse,
  ErrorResponse,
  NamespaceListResponse,
  SecretListResponse,
  SecretResponse,
  type ErrorCode,
  type OpenClawConfigurationDocument,
  type Permission,
  type PluginDesiredState,
  type SecretBindings,
  type SecretReference,
} from "../../packages/contracts/src/index.ts";
import { BOOTSTRAP_DEFAULT_NAMESPACE_NAME } from "../../packages/occ/src/index.ts";
import { AGENT_NAME_CONFLICT, SECRET_NAME_CONFLICT } from "../helpers/refusal-text.mjs";
import {
  bootstrapInstallation as bootstrap,
  checkedInjectedBody,
  createAgent,
  createInjectedControllerFixture,
  createNamespace,
  createReadyNamespace,
  injectedRequest,
  readyNamespaceFixture as bootstrapReadyNamespace,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";
import {
  checkMalformedResourcePaths,
  checkPayloadLimitAndAllowedMethods,
  checkResourceCreationSchemas,
  withValidationBeforeIam,
} from "./occ-api-resource-route-cases.ts";

type InjectedReply = Awaited<ReturnType<FixtureRequest>>;

function assertApiError(
  reply: InjectedReply,
  status: number,
  code: ErrorCode,
  label?: string,
): asserts reply is InjectedReply & { body: ErrorResponse } {
  const message =
    label === undefined ? JSON.stringify(reply.body) : `${label}: ${JSON.stringify(reply.body)}`;
  const { error } = checkedInjectedBody(reply, status, ErrorResponse);
  assert.equal(error.code, code, message);
}

function createInjectedFixture() {
  return createInjectedControllerFixture(
    {},
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries, ...options }) {
        return factory(backendSummaries === undefined ? options : { ...options, backendSummaries });
      },
    },
  );
}

async function configuredController() {
  const fixture = await createInjectedFixture();
  const request: FixtureRequest = (method, pathname, options) =>
    injectedRequest(fixture.app, method, pathname, options);
  return { fixture, request };
}

async function readyNamespaceFixture(name: string) {
  return bootstrapReadyNamespace(await configuredController(), name);
}

function exactSecretRef(namespaceId: string, id: string): SecretReference {
  return { kind: "secret", namespaceId, id };
}

function pluginPolicy(): PluginDesiredState[string] {
  return { enabled: true, toolDefaults: { approval: "none" } };
}

function assertOnlyDefaultNamespace(reply: InjectedReply) {
  const { data } = checkedInjectedBody(reply, 200, NamespaceListResponse);
  assert.deepEqual(
    data.map((namespace) => namespace.name),
    [BOOTSTRAP_DEFAULT_NAMESPACE_NAME],
  );
}

test("credential withdrawal routes authorize the Agent, not the credential source", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "withdrawal-iam");
  const agent = await createAgent(controller, namespace.id, "withdrawal-agent");
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/credential-sources/cs_${randomUUID()}`;
  const memberWith = async (label: string, permissions: Permission[]) => {
    const { principal } = await fixture.createAuthPrincipal(label);
    fixture.state.identities.push(principal);
    fixture.state.roles.push({ id: `role-${label}`, namespaceId: namespace.id, permissions });
    fixture.state.bindings.push({
      id: `binding-${label}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: `role-${label}`,
    });
    return fixture.createApp(principal);
  };

  // Operating every credential source in the Namespace grants nothing on an Agent that uses one.
  const sourceOperator = await memberWith("withdrawal-source-operator", [
    { action: "read", resourceKind: "credential_source" },
    { action: "operate", resourceKind: "credential_source" },
  ]);
  for (const [method, suffix] of [
    ["POST", "withdraw"],
    ["GET", "withdrawal"],
  ] as const) {
    const denied = await injectedRequest(sourceOperator, method, `${path}/${suffix}`);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
  }

  // Operating the Agent admits both routes; this Agent has no active revision to withdraw from.
  const agentOperator = await memberWith("withdrawal-agent-operator", [
    { action: "read", resourceKind: "agent" },
    { action: "operate", resourceKind: "agent" },
  ]);
  const conflict = await injectedRequest(agentOperator, "POST", `${path}/withdraw`);
  assertApiError(conflict, 409, "RESOURCE_CONFLICT");
  assert.match(conflict.body.error.message, /has no active revision to withdraw/);
  const status = await injectedRequest(agentOperator, "GET", `${path}/withdrawal`);
  assert.notEqual(status.status, 403, JSON.stringify(status.body));

  // An in-use conflict names what blocks it instead of the generic "already exists" text.
  const configurationInUse = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assertApiError(configurationInUse, 409, "RESOURCE_CONFLICT");
  assert.match(
    configurationInUse.body.error.message,
    /An Agent still references the Configuration/,
  );

  // The denial's audit evidence names the Agent the route declares, not the source.
  assert(fixture.auditSink instanceof InMemoryAuditSink);
  const withdrawalEvents = fixture.auditSink.events.filter(
    (event) => event.action === "openclaw.agents.credential_sources.withdraw",
  );
  assert.deepEqual(
    withdrawalEvents.map((event) => [event.kind, event.resource]),
    [["authorization_denial", { kind: "agent", id: agent.id, namespaceId: namespace.id }]],
  );
});

test("credential source registration names the missing Credential Gateway", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "no-credential-gateway");
  // This Installation selects no Credential Gateway, like the Kubernetes production profile;
  // the missing gateway is reported before Namespace readiness or the source catalog.
  const rejected = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/credential-sources`,
    { body: { name: "openai-key", type: "openai" } },
  );
  assertApiError(rejected, 409, "CREDENTIAL_GATEWAY_NOT_CONFIGURED");
  assert.match(
    rejected.body.error.message,
    /no Credential Gateway.*docs-enterprise\.openclaw\.org\/reference\/credential-sources\//,
  );
});

test("a duplicate Secret name answers 409 naming the taken Secret name", async () => {
  const { controller, namespace } = await readyNamespaceFixture("secret-duplicate-name");
  const secret = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Model API key", value: "first-value" },
  });
  assert.equal(secret.status, 201, JSON.stringify(secret.body));

  // The caller chose only the name, so the conflict says the name is taken here.
  const duplicate = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Model API key", value: "second-value" },
  });
  assertApiError(duplicate, 409, "RESOURCE_CONFLICT");
  assert.equal(duplicate.body.error.message, SECRET_NAME_CONFLICT);
});

test("Secret values with an unpaired surrogate are refused as an invalid value", async () => {
  const { controller, namespace } = await readyNamespaceFixture("secret-value-validation");
  const secret = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "Valid value", value: "valid-secret-\u{1F511}" },
  });
  const { data: createdSecret } = checkedInjectedBody(secret, 201, SecretResponse);

  // The request schema admits these strings; every API route refuses them before validation
  // because they are not UTF-8 (OCC's own Secret value check would refuse them too).
  for (const value of ["\ud800", "prefix-\udfff-suffix"]) {
    for (const [method, path, body] of [
      ["POST", `/namespaces/${namespace.id}/secrets`, { name: "Unpaired surrogate", value }],
      ["PATCH", `/namespaces/${namespace.id}/secrets/${createdSecret.id}`, { value }],
    ] as const) {
      const rejected = await controller.request(method, path, { body });
      assertApiError(rejected, 400, "INVALID_REQUEST", method);
      assert.equal(
        rejected.body.error.message,
        "The request does not match the operation contract: body /value contains an unpaired UTF-16 surrogate.",
      );
      assert.deepEqual(rejected.body.error.details, [{ path: "/value", code: "INVALID_VALUE" }]);
    }
  }
});

test("a state conflict names what blocks the request, after authorization only", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const member = await fixture.createAuthPrincipal("state-conflict-member");
  fixture.state.identities.push(member.principal);
  await bootstrap(controller);
  const namespace = await createReadyNamespace(controller, "state-conflict");
  const deletion = await controller.request("DELETE", `/namespaces/${namespace.id}`);
  assert.equal(deletion.status, 202, JSON.stringify(deletion.body));

  // A plain conflict would answer "already exists"; the caller needs the actual reason.
  for (const [path, body, message] of [
    [
      "configurations",
      { kind: "agent", values: {} },
      "The Namespace does not accept new Configurations.",
    ],
    [
      "service-accounts",
      { name: "late-account" },
      "The Namespace does not accept new ServiceAccounts.",
    ],
    [
      "agents",
      { name: "late-agent", configurationId: "cfg_00000000-0000-4000-8000-000000000000" },
      "The Namespace does not accept new Agents.",
    ],
  ] as const) {
    const refused = await controller.request("POST", `/namespaces/${namespace.id}/${path}`, {
      body,
    });
    assertApiError(refused, 409, "RESOURCE_CONFLICT", path);
    assert.equal(refused.body.error.message, message);
  }

  const options = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/repository-options`,
  );
  const { error: optionsError } = checkedInjectedBody(options, 409, ErrorResponse);
  assert.equal(optionsError.message, "The Namespace does not accept new Agents.");

  // A caller without create permission learns nothing about the Namespace lifecycle.
  const memberApp = fixture.createApp(member.principal);
  for (const [method, path, body] of [
    ["POST", "configurations", { kind: "agent", values: {} }],
    ["POST", "service-accounts", { name: "late-account" }],
    [
      "POST",
      "agents",
      { name: "late-agent", configurationId: "cfg_00000000-0000-4000-8000-000000000000" },
    ],
    ["GET", "agents/repository-options"],
  ] as const) {
    const denied = await injectedRequest(
      memberApp,
      method,
      `/namespaces/${namespace.id}/${path}`,
      body === undefined ? {} : { body },
    );
    assertApiError(denied, 403, "FORBIDDEN", path);
  }
});

// Create Agent's preflight (#2830) applies Configuration create's content rules and Agent
// create's Namespace and plugin checks to an unsaved Configuration, so the console reports a
// refusal before it saves the Secret or Configuration. It writes nothing.
test("Create Agent's preflight refuses what Configuration and Agent create would, writing nothing", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "agent-preflight");
  const validate = (
    values: OpenClawConfigurationDocument,
    extra: { name?: string; plugins?: PluginDesiredState } = {},
  ) =>
    controller.request("POST", `/namespaces/${namespace.id}/agents/validate`, {
      body: { configuration: { kind: "agent", values }, ...extra },
    });

  // Agent create accepts a Namespace that is still provisioning, and so does its preflight.
  const accepted = await validate({});
  assert.equal(accepted.status, 204, JSON.stringify(accepted.body));

  // Configuration create's content rules, as the form's first save would answer.
  const inline = await validate({ gateway: { auth: { password: "literal-password" } } });
  const { error: inlineError } = checkedInjectedBody(inline, 400, ErrorResponse);
  assert.equal(
    inlineError.message,
    "Configuration field /gateway/auth/password holds a credential value inline, where a reference is required. Use the OPENCLAW_GATEWAY_PASSWORD environment reference, whose value the Compute Driver generates, instead.",
  );

  const pluginDriver = new OCCPluginDriver();
  const platformController = controller.fixture.controller;
  assert(platformController);
  platformController.registerDriver(pluginDriver);
  platformController.selectDriver("plugin", pluginDriver.id);
  // Agent create's plugin policy check, before the Plugin Driver reads the Configuration.
  const unknown = await validate({}, { plugins: { "occ-plugin:missing": pluginPolicy() } });
  const { error: unknownError } = checkedInjectedBody(unknown, 400, ErrorResponse);
  assert.equal(
    unknownError.message,
    "A plugin selection names a plugin that the selected Plugin Driver (occ-plugin) does not offer: occ-plugin:missing. Check each plugin ID and its Driver prefix against the catalog for the Agent's Harness.",
  );

  // No route lists Configurations; the Agent and Secret collections stay empty.
  for (const collection of ["agents", "secrets"]) {
    const listed = await controller.request("GET", `/namespaces/${namespace.id}/${collection}`);
    const schema = collection === "agents" ? AgentListResponse : SecretListResponse;
    assert.deepEqual(checkedInjectedBody(listed, 200, schema).data, [], collection);
  }

  // A name another Agent has gets Agent create's 409, so the form saves no Secret or
  // Configuration it would leave behind (finding 2420). Another name, or none, still passes.
  const taken = await createAgent(controller, namespace.id, "taken-agent");
  const duplicate = await validate({}, { name: "taken-agent" });
  assertApiError(duplicate, 409, "RESOURCE_CONFLICT");
  assert.equal(duplicate.body.error.message, AGENT_NAME_CONFLICT);
  for (const extra of [{ name: "free-agent" }, {}]) {
    const free = await validate({}, extra);
    assert.equal(free.status, 204, JSON.stringify(free.body));
  }
  const listed = await controller.request("GET", `/namespaces/${namespace.id}/agents`);
  assert.deepEqual(
    checkedInjectedBody(listed, 200, AgentListResponse).data.map(({ id }) => id),
    [taken.id],
  );

  // The check answers what the store's unique name would: in this Namespace only, case as typed,
  // an Agent being deleted included. Another Namespace's names stay private to it.
  const other = await createNamespace(controller, "agent-preflight-other");
  const elsewhere = await controller.request("POST", `/namespaces/${other.id}/agents/validate`, {
    body: { configuration: { kind: "agent", values: {} }, name: "taken-agent" },
  });
  assert.equal(elsewhere.status, 204, JSON.stringify(elsewhere.body));
  const recased = await validate({}, { name: "Taken-Agent" });
  assert.equal(recased.status, 204, JSON.stringify(recased.body));
  const leaving = await createAgent(controller, namespace.id, "leaving-agent");
  const deletion = await controller.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${leaving.id}`,
  );
  assert.equal(deletion.status, 202, JSON.stringify(deletion.body));
  assertApiError(await validate({}, { name: "leaving-agent" }), 409, "RESOURCE_CONFLICT");
  // The name check comes last, so a taken name with a content refusal gets the content refusal.
  const both = await validate(
    { gateway: { auth: { password: "literal-password" } } },
    { name: "taken-agent" },
  );
  assert.equal(both.status, 400, JSON.stringify(both.body));
});

test("OCC Fastify enforces strict schemas, canonical errors, and its real 64 KiB limit", async () => {
  const controller = await configuredController();

  const { namespace, agent } = await checkResourceCreationSchemas(controller);

  for (const configurationId of [null, [], "invalid"]) {
    const invalidCreation = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: { name: "invalid-configuration-agent", configurationId },
    });
    assert.equal(invalidCreation.status, 400);

    const invalidReplacement = await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      { body: { configurationId } },
    );
    assert.equal(invalidReplacement.status, 400);
  }

  for (const body of [{ configuration: {} }, { draft_spec: {} }]) {
    const invalidDeployment = await controller.request(
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
      { body },
    );
    assert.equal(invalidDeployment.status, 400);
  }

  for (const key of ["__proto__", "constructor", "prototype"]) {
    const unsafeConfiguration = await controller.request(
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      {
        rawBody: `{"kind":"agent","values":{"${key}":"polluted"}}`,
        headers: { "content-type": "application/json" },
      },
    );
    assertApiError(unsafeConfiguration, 400, "INVALID_REQUEST", key);
  }

  let deeplyNested: OpenClawConfigurationDocument = {};
  for (let depth = 0; depth < 26; depth += 1) {
    deeplyNested = { nested: deeplyNested };
  }
  const tooDeep = await controller.request("POST", `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: deeplyNested },
  });
  const { error: tooDeepError } = checkedInjectedBody(tooDeep, 400, ErrorResponse);
  assert(tooDeepError.details);
  assert.equal(tooDeepError.details[0]?.code, "TOO_DEEP");

  for (const extra of ["name", "namespaceId", "servicePrincipalId"]) {
    const injected = await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      { body: { configurationId: agent.configurationId, [extra]: "injected" } },
    );
    assert.equal(injected.status, 400, extra);
  }

  const foreignInstallation = await controller.request("POST", "/namespaces", {
    body: { name: "foreign", installationId: "installation-foreign" },
  });
  assert.equal(foreignInstallation.status, 400);

  const namespaceOverride = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "foreign",
      configurationId: agent.configurationId,
      namespaceId: "namespace-foreign",
    },
  });
  assert.equal(namespaceOverride.status, 400);

  const unexpectedQuery = await controller.request("GET", "/namespaces?owner=foreign");
  assertApiError(unexpectedQuery, 400, "INVALID_REQUEST");

  await checkMalformedResourcePaths(controller, namespace, agent);
  await checkPayloadLimitAndAllowedMethods(controller, namespace, agent);

  const fixture = await createInjectedFixture();
  const bootstrapped = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Validation-order installation" },
  });
  assert.equal(bootstrapped.status, 201);

  await withValidationBeforeIam(fixture, async (assertUnchanged) => {
    for (const options of [
      { rawBody: '{"name":' },
      { body: { name: "invalid-scope", installationId: fixture.installationId } },
    ]) {
      const invalid = await injectedRequest(fixture.app, "POST", "/namespaces", options);
      assertApiError(invalid, 400, "INVALID_REQUEST");
      assertUnchanged();
    }
  });

  const untouched = await injectedRequest(fixture.app, "GET", "/namespaces");
  assertOnlyDefaultNamespace(untouched);
});

test("Configuration and Agent writes reject invalid Secret bindings as invalid requests", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  await bootstrap(controller, "Binding validation installation");
  const { id: namespaceId } = await createReadyNamespace(controller, "binding-validation");
  const secret = await injectedRequest(fixture.app, "POST", `/namespaces/${namespaceId}/secrets`, {
    body: { name: "tool-api-key", value: `tool-key-${randomUUID()}` },
  });
  const { data: createdSecret } = checkedInjectedBody(secret, 201, SecretResponse);
  const own = exactSecretRef(namespaceId, createdSecret.id);
  const foreign = exactSecretRef(`ns_${randomUUID()}`, createdSecret.id);
  const missing = exactSecretRef(namespaceId, `sec_${randomUUID()}`);
  const values: OpenClawConfigurationDocument = {
    agents: { defaults: { model: "codex/gpt-6-astra" } },
  };
  const bindingsTo = (name: string, source: SecretReference): SecretBindings => ({
    [name]: { source, delivery: { type: "env" } },
  });

  const configuration = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceId}/configurations`,
    { body: { kind: "agent", values, secretBindings: bindingsTo("TOOL_API_KEY", own) } },
  );
  const { data: createdConfiguration } = checkedInjectedBody(
    configuration,
    201,
    ConfigurationResponse,
  );
  const configurationPath = `/namespaces/${namespaceId}/configurations/${createdConfiguration.id}`;
  const agent = await injectedRequest(fixture.app, "POST", `/namespaces/${namespaceId}/agents`, {
    body: { name: "binding-validation-agent", configurationId: createdConfiguration.id },
  });
  const { data: createdAgent } = checkedInjectedBody(agent, 201, AgentResponse);
  const agentPath = `/namespaces/${namespaceId}/agents/${createdAgent.id}`;

  const reserved =
    "A secret binding destination uses the reserved prefix OPENCLAW_*: OPENCLAW_TOKEN.";
  const crossNamespace = "Secret references cannot cross Namespaces.";
  type MutationMethod = "POST" | "PATCH";
  type ConfigurationWriteBody = {
    kind?: "agent";
    values: OpenClawConfigurationDocument;
    secretBindings: SecretBindings;
  };
  const writes: readonly [
    string,
    MutationMethod,
    string,
    (bindings: SecretBindings) => ConfigurationWriteBody,
  ][] = [
    [
      "Configuration create",
      "POST",
      `/namespaces/${namespaceId}/configurations`,
      (bindings) => ({
        kind: "agent",
        values,
        secretBindings: bindings,
      }),
    ],
    [
      "Configuration update",
      "PATCH",
      configurationPath,
      (bindings) => ({
        values,
        secretBindings: bindings,
      }),
    ],
  ];
  // Each invalid case must fail on its own rule (the exact message); a Secret the Namespace
  // does not hold stays a not-found.
  for (const [path, method, url, body] of writes) {
    for (const [description, bindings, status, message] of [
      ["reserved destination", bindingsTo("OPENCLAW_TOKEN", own), 400, reserved],
      ["cross-Namespace Secret", bindingsTo("TOOL_API_KEY", foreign), 400, crossNamespace],
      ["missing Secret", bindingsTo("TOOL_API_KEY", missing), 404, undefined],
    ] as const) {
      const result = await injectedRequest(fixture.app, method, url, { body: body(bindings) });
      const label = `${path}, ${description}: ${JSON.stringify(result.body)}`;
      assertApiError(result, status, status === 400 ? "INVALID_REQUEST" : "NOT_FOUND", label);
      if (message !== undefined) {
        assert.equal(result.body.error.message, message, label);
      }
      if (message === reserved) {
        assert.deepEqual(
          result.body.error.details,
          [{ path: "/secretBindings/OPENCLAW_TOKEN", code: "INVALID_VALUE" }],
          label,
        );
      }
    }
  }

  // Agents select Secrets only through their Harness authentication source.
  type HarnessAuthInput = {
    method: "api_key" | "runtime" | "password";
    source?: SecretReference;
  };
  type AgentWriteBody = {
    name?: string;
    configurationId: string;
    harnessAuth: HarnessAuthInput;
  };
  const agentWrites: readonly [
    string,
    MutationMethod,
    string,
    (harnessAuth: HarnessAuthInput) => AgentWriteBody,
  ][] = [
    [
      "Agent create",
      "POST",
      `/namespaces/${namespaceId}/agents`,
      (harnessAuth) => ({
        name: `binding-validation-${randomUUID().slice(0, 8)}`,
        configurationId: createdConfiguration.id,
        harnessAuth,
      }),
    ],
    [
      "Agent update",
      "PATCH",
      agentPath,
      (harnessAuth) => ({
        configurationId: createdConfiguration.id,
        harnessAuth,
      }),
    ],
  ];
  for (const [path, method, url, body] of agentWrites) {
    for (const [description, source, status, message] of [
      ["cross-Namespace Secret", foreign, 400, crossNamespace],
      ["missing Secret", missing, 404, undefined],
    ] as const) {
      const result = await injectedRequest(fixture.app, method, url, {
        body: body({ method: "api_key", source }),
      });
      const label = `${path}, ${description}: ${JSON.stringify(result.body)}`;
      assertApiError(result, status, status === 400 ? "INVALID_REQUEST" : "NOT_FOUND", label);
      if (message !== undefined) {
        assert.equal(result.body.error.message, message, label);
      }
    }
    // The method selects the api_key shape: only its missing source is reported. An unknown
    // method selects no shape, so every shape's problem stays.
    const withoutSource = await injectedRequest(fixture.app, method, url, {
      body: body({ method: "api_key" }),
    });
    assertApiError(withoutSource, 400, "INVALID_REQUEST", path);
    assert.equal(
      withoutSource.body.error.message,
      "The request does not match the operation contract: body /harnessAuth/source is required.",
      path,
    );
    assert.deepEqual(
      withoutSource.body.error.details,
      [{ path: "/harnessAuth/source", code: "REQUIRED" }],
      path,
    );
    // Switching to the runtime method while leaving the old source in place: the method
    // selects the runtime shape, so only the field it does not accept is reported.
    const runtimeWithSource = await injectedRequest(fixture.app, method, url, {
      body: body({ method: "runtime", source: foreign }),
    });
    assertApiError(runtimeWithSource, 400, "INVALID_REQUEST", path);
    assert.equal(
      runtimeWithSource.body.error.message,
      "The request does not match the operation contract: body /harnessAuth/source is not an accepted field.",
      path,
    );
    assert.deepEqual(
      runtimeWithSource.body.error.details,
      [{ path: "/harnessAuth/source", code: "UNKNOWN_FIELD" }],
      path,
    );
    const unknownMethod = await injectedRequest(fixture.app, method, url, {
      body: body({ method: "password" }),
    });
    assertApiError(unknownMethod, 400, "INVALID_REQUEST", path);
    assert.deepEqual(
      unknownMethod.body.error.details,
      [
        { path: "/harnessAuth/method", code: "INVALID_VALUE" },
        { path: "/harnessAuth/source", code: "REQUIRED" },
        { path: "/harnessAuth/sourceId", code: "REQUIRED" },
        { path: "/harnessAuth", code: "INVALID_VALUE" },
        { path: "/harnessAuth", code: "INVALID_TYPE" },
      ],
      path,
    );
  }

  // A resource the caller cannot find stays a not-found even when the request is invalid.
  for (const [path, url, body] of [
    [
      "Configuration update",
      `/namespaces/${namespaceId}/configurations/cfg_${randomUUID()}`,
      { values, secretBindings: bindingsTo("OPENCLAW_TOKEN", own) },
    ],
    [
      "Agent update",
      `/namespaces/${namespaceId}/agents/agt_${randomUUID()}`,
      {
        configurationId: createdConfiguration.id,
        harnessAuth: { method: "api_key", source: foreign },
      },
    ],
  ] as const) {
    const result = await injectedRequest(fixture.app, "PATCH", url, { body });
    assertApiError(result, 404, "NOT_FOUND", path);
  }

  // The rejected writes changed nothing.
  const stored = await injectedRequest(fixture.app, "GET", configurationPath);
  const { data: storedConfiguration } = checkedInjectedBody(stored, 200, ConfigurationResponse);
  assert.equal(storedConfiguration.generation, 1);
  assert.deepEqual(storedConfiguration.secretBindings, bindingsTo("TOOL_API_KEY", own));
  const storedAgent = await injectedRequest(fixture.app, "GET", agentPath);
  assert.deepEqual(
    checkedInjectedBody(storedAgent, 200, AgentResponse).data.harnessAuth,
    createdAgent.harnessAuth,
  );
});
