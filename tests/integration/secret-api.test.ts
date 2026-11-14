/// <reference lib="es2023.array" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  createControllerApp,
  type ControllerApp,
  type ControllerAppOptions,
} from "../../apps/controller/src/index.ts";
import { ErrorResponse, Meta, RequestId } from "../../packages/contracts/src/api/common.ts";
import {
  AgentReadResponse,
  AgentResponse,
  AgentRevisionResponse,
  ConfigurationResponse,
  CredentialSourceResponse,
  NamespaceResponse,
  SecretDetailResponse,
  SecretResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type {
  CredentialGatewayDriver,
  CredentialSourceInput,
  HarnessAuthBinding,
  OpenClawConfigurationDocument,
  Permission,
  PermissionAction,
  ResourceKind,
  Principal,
  SecretReference,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole as grantIAMRole, restrict } from "../helpers/iam-grants.mjs";
import { agentPrincipalDenied } from "../helpers/refusal-text.mjs";

import { registerModelDiscoveryCases } from "./secret-api-model-discovery-cases.ts";

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const identifier = (prefix: string) => new RegExp(`^${prefix}_${uuidV4}$`);
// These cases use only the ID. Agent configuration values have a separate validation suite.
const configurationIdentityResponse = Type.Object({
  data: Type.Pick(ConfigurationResponse.properties.data, ["id"]),
  meta: Meta,
});
const revisionBindingResponse = Type.Object({
  data: Type.Pick(AgentRevisionResponse.properties.data, ["id", "harnessAuth"]),
  meta: Meta,
});
const defaultControllerBodyLimit = 64 * 1024;
const syntheticSecretSentinel = "synthetic-secret-boundary:";

function jsonBodyBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function bodyAtJsonLimit<Body>(limit: number, buildBody: (value: string) => Body) {
  const emptyBodyBytes = jsonBodyBytes(buildBody(""));
  const targetValueBytes = limit - emptyBodyBytes;
  assert.ok(targetValueBytes >= syntheticSecretSentinel.length);
  const value = `${syntheticSecretSentinel}${"x".repeat(
    targetValueBytes - syntheticSecretSentinel.length,
  )}`;
  assert.equal(Buffer.byteLength(value, "utf8"), targetValueBytes);

  const body = buildBody(value);
  assert.equal(jsonBodyBytes(body), limit);
  return { body, value };
}

type Session = Pick<Awaited<ReturnType<typeof signInToControllerApp>>, "cookie" | "origin">;
type SessionApp = ControllerApp & { defaultSession: Session | undefined };
type MutableIAMState = {
  -readonly [Key in Exclude<keyof NativeIAMState, "roles">]: Array<NativeIAMState[Key][number]>;
} & {
  roles: (Omit<NativeIAMState["roles"][number], "permissions"> & { permissions: Permission[] })[];
};

type GrantOptions = {
  id: string;
  bindingId?: string;
  namespaceId: string;
  permissions: Partial<Record<ResourceKind, PermissionAction[]>>;
  resource?: { kind: ResourceKind; id: string };
};

function grantRole(state: MutableIAMState, subjectId: string, options: GrantOptions): void {
  grantIAMRole(state, subjectId, { ...options, resource: options.resource });
}

type FixtureOptions = Pick<ControllerAppOptions, "computeDriver"> & {
  secretDriver?: ReturnType<typeof createTestSecretDriver>;
  recordOperations?: boolean;
  now?: () => Date;
};

async function createFixture(options: FixtureOptions = {}) {
  const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
  const authFixture = await createTestAuthPrincipal({
    installationId,
    email: `admin-${randomUUID()}@example.com`,
    password: `generated-password-${randomUUID()}`,
    name: "Secret API Administrator",
  });
  const principal: Principal = authFixture.seed.principal;
  const roles: NativeIAMState["roles"] = authFixture.seed.roles;
  const [adminRole] = roles;
  assert.ok(adminRole, "The seeded administrator must have a role");
  const state: MutableIAMState = {
    identities: [principal],
    groups: [],
    memberships: [],
    roles: roles.map((role) => ({ ...role, permissions: [...role.permissions] })),
    bindings: [
      {
        id: "binding-admin",
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: adminRole.id,
      },
    ],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => state },
    { id: "iam-secret-api" },
  );
  const auditSink = new InMemoryAuditSink();
  const secretDriver = options.secretDriver ?? createTestSecretDriver({ id: "secret-api-test" });
  let controller: OpenClawController | undefined;
  const sessionsByPrincipalId = new Map<string, Session>();

  function createApp(identity: Principal = principal): SessionApp {
    const app = createControllerApp({
      ...(controller
        ? { controller }
        : {
            createController(installation) {
              controller = new OpenClawController(installation, {
                state: new InMemoryPlatformState({ auditSink }),
                recordOperations: options.recordOperations ?? false,
                ...(options.now === undefined ? {} : { now: options.now }),
              });
              return controller;
            },
          }),
      iamDriver,
      computeDriver: options.computeDriver ?? createReadyComputeDriver("compute-secret-api"),
      configurationDriver: createTestConfigurationDriver({ id: "configuration-secret-api" }),
      secretDriver,
      resolveHarness: resolveApprovedDevelopmentHarness,
      auditSink,
      development: {
        enabled: true,
        installationId,
        browserOrigin: "https://console.oce.localhost",
      },
      auth: authFixture.auth,
    });
    return Object.assign(app, { defaultSession: sessionsByPrincipalId.get(identity.id) });
  }

  const app = createApp();
  sessionsByPrincipalId.set(principal.id, await signInToControllerApp(app, authFixture));
  app.defaultSession = sessionsByPrincipalId.get(principal.id);

  async function createPrincipal(name: string) {
    const email = `${name}-${randomUUID()}@example.com`;
    const password = `generated-password-${randomUUID()}`;
    const account = await authFixture.auth.createAccount({ email, password, name });
    const seed = authFixture.auth.principalSeed(account, { grant: "none" });
    state.identities.push(seed.principal);
    sessionsByPrincipalId.set(
      seed.principal.id,
      await signInToControllerApp(app, { email, password }),
    );
    return { principal: seed.principal, app: createApp(seed.principal) };
  }

  return {
    app,
    auditSink,
    controller() {
      assert.ok(controller, "Bootstrap must initialize the controller before it is used");
      return controller;
    },
    createPrincipal,
    principal,
    secretDriver,
    state,
  };
}

type RequestOptions = {
  body?: unknown;
};

type ApiResult<Data = unknown> = {
  status: number;
  headers: Headers;
  body: unknown;
  data: Data;
  requestId: string | undefined;
};

type DataSchema = TSchema & { properties: { data: TSchema } };

function request<Schema extends DataSchema>(
  app: SessionApp,
  method: string,
  pathname: string,
  options: RequestOptions & { schema: Schema },
): Promise<ApiResult<Static<Schema["properties"]["data"]>>>;
function request(
  app: SessionApp,
  method: string,
  pathname: string,
  options?: RequestOptions,
): Promise<ApiResult>;
async function request(
  app: SessionApp,
  method: string,
  pathname: string,
  options: RequestOptions & { schema?: DataSchema } = {},
): Promise<ApiResult> {
  assert.ok(app.defaultSession, "The request needs an authenticated test principal");
  const headers: Record<string, string> = authenticatedHeaders(app.defaultSession);
  const hasBody = Object.hasOwn(options, "body");
  if (hasBody) {
    headers["content-type"] ??= "application/json";
  }
  const response = await app.fetch(
    new Request(`https://console.oce.localhost${pathname}`, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) ?? null } : {}),
    }),
  );
  const body: unknown = response.status === 204 ? undefined : await response.json();
  const envelope = asRecord(body);
  const requestId = asRecord(envelope?.meta)?.requestId;
  if (body !== undefined) {
    assert.ok(Check(RequestId, requestId), "Expected a request ID in the response metadata");
  }
  if (options.schema !== undefined) {
    assert.ok(
      Check(options.schema, body),
      `Unexpected response contract for ${method} ${pathname} (HTTP ${response.status})`,
    );
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
    data: envelope?.data,
    requestId: typeof requestId === "string" ? requestId : undefined,
  };
}

function responseError(result: ApiResult): ErrorResponse["error"] {
  assert.ok(
    Check(ErrorResponse, result.body),
    `Expected an error envelope (HTTP ${result.status})`,
  );
  return result.body.error;
}

export type ModelDiscoveryFixture = {
  createFixture: typeof createFixture;
  bootstrapNamespace: typeof bootstrapNamespace;
  request: typeof request;
  responseError: typeof responseError;
  grantRole: typeof grantRole;
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function bootstrapNamespace(fixture: Fixture) {
  const bootstrapped = await request(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Secret API installation" },
  });
  assert.equal(bootstrapped.status, 201);

  const namespace = await request(fixture.app, "POST", "/namespaces", {
    schema: NamespaceResponse,
    body: { name: "secret-api-namespace" },
  });
  assert.equal(namespace.status, 201);
  await fixture
    .controller()
    .handleNamespaceLifecycle(fixture.principal.id, namespace.data.id, "ready");

  return namespace.data;
}

async function bootstrapAgent(
  fixture: Fixture,
  values: OpenClawConfigurationDocument = {},
  executionMode: AgentResponse["data"]["executionMode"] = "embedded",
) {
  const namespace = await bootstrapNamespace(fixture);
  const configuration = await request(
    fixture.app,
    "POST",
    `/namespaces/${namespace.id}/configurations`,
    { schema: configurationIdentityResponse, body: { kind: "agent", values } },
  );
  assert.equal(configuration.status, 201);

  const agent = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents`, {
    schema: AgentResponse,
    body: { name: "secret-api-agent", configurationId: configuration.data.id, executionMode },
  });
  assert.equal(agent.status, 201);
  return { namespace, configuration: configuration.data, agent: agent.data };
}

registerModelDiscoveryCases({
  createFixture,
  bootstrapNamespace,
  request,
  responseError,
  grantRole,
});

test("Secret API stores values through the selected driver and returns metadata only", async () => {
  const fixture = await createFixture();
  const { namespace, agent } = await bootstrapAgent(fixture);
  const originalValue = `secret-value-${randomUUID()}`;
  const rotatedValue = `rotated-value-${randomUUID()}`;

  const removedOwnerField = await request(
    fixture.app,
    "POST",
    `/namespaces/${namespace.id}/secrets`,
    {
      body: { agentId: agent.id, name: "Removed owner key", value: `secret-value-${randomUUID()}` },
    },
  );
  assertApiError(removedOwnerField, 400, "INVALID_REQUEST");

  const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    schema: SecretResponse,
    body: { name: "Backend API key", value: originalValue },
  });
  assert.equal(created.status, 201);
  assert.match(created.data.id, identifier("sec"));
  assert.deepEqual(created.data, {
    id: created.data.id,
    namespaceId: namespace.id,
    name: "Backend API key",
    ref: { kind: "secret", namespaceId: namespace.id, id: created.data.id },
  });
  assert.equal(JSON.stringify(created.body).includes(originalValue), false);
  assert.equal(JSON.stringify(created.body).includes("backendRef"), false);
  assert.equal(JSON.stringify(created.body).includes("driverId"), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), originalValue);

  const hidden = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    schema: SecretResponse,
    body: { name: "Hidden provider API key", value: `secret-value-${randomUUID()}` },
  });
  assert.equal(hidden.status, 201);
  restrict(fixture.state, "read", "secret", {
    namespaceId: namespace.id,
    resourceId: hidden.data.id,
  });
  const foreignNamespace = await request(fixture.app, "POST", "/namespaces", {
    schema: NamespaceResponse,
    body: { name: `foreign-secret-list-${randomUUID()}` },
  });
  assert.equal(foreignNamespace.status, 201);
  await fixture
    .controller()
    .handleNamespaceLifecycle(fixture.principal.id, foreignNamespace.data.id, "ready");
  const foreign = await request(
    fixture.app,
    "POST",
    `/namespaces/${foreignNamespace.data.id}/secrets`,
    {
      schema: SecretResponse,
      body: { name: "Foreign provider API key", value: `secret-value-${randomUUID()}` },
    },
  );
  assert.equal(foreign.status, 201);
  const listed = await request(fixture.app, "GET", `/namespaces/${namespace.id}/secrets`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data, [created.data]);
  assert.equal(JSON.stringify(listed.body).includes(originalValue), false);
  const hiddenValue = fixture.secretDriver.valueFor(hidden.data);
  assert.ok(typeof hiddenValue === "string");
  assert.equal(JSON.stringify(listed.body).includes(hiddenValue), false);
  assert.equal(JSON.stringify(listed.body).includes(foreign.data.id), false);

  const detail = await request(
    fixture.app,
    "GET",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(detail.status, 200);
  // The exact read adds the Secret's consumers, and what the caller may do to it; nothing
  // references this one yet, and the administrator may replace and delete it.
  assert.deepEqual(detail.data, {
    ...created.data,
    consumers: {
      agents: [],
      configurations: [],
      credentialSources: [],
      provisioningRequests: [],
      unreadable: 0,
      truncated: false,
    },
    callerPermissions: { update: true, delete: true },
  });

  const updated = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: { value: rotatedValue } },
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data, created.data);
  assert.equal(fixture.secretDriver.valueFor(created.data), rotatedValue);

  const nul = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: { value: "bad\u0000value" } },
  );
  assertApiError(nul, 400, "INVALID_REQUEST");
  // An empty value or name also names the schema's minimum length, so the caller can fix it.
  for (const [method, path, body, field] of [
    ["POST", `/namespaces/${namespace.id}/secrets`, { name: "Empty", value: "" }, "value"],
    ["POST", `/namespaces/${namespace.id}/secrets`, { name: "", value: "nonempty" }, "name"],
    ["PATCH", `/namespaces/${namespace.id}/secrets/${created.data.id}`, { value: "" }, "value"],
  ] as const) {
    const empty = await request(fixture.app, method, path, { body });
    assertApiError(empty, 400, "INVALID_REQUEST");
    assert.equal(
      responseError(empty).message,
      `The request does not match the operation contract: body /${field} has an unsupported value (expected at least 1 character).`,
    );
    assert.deepEqual(responseError(empty).details, [{ path: `/${field}`, code: "INVALID_VALUE" }]);
  }
  // A name over the schema's maximum length names that bound too.
  const longName = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "n".repeat(201), value: "nonempty" },
  });
  assert.equal(longName.status, 400);
  assert.equal(
    responseError(longName).message,
    "The request does not match the operation contract: body /name is too long (expected at most 200 characters).",
  );
  assert.deepEqual(responseError(longName).details, [{ path: "/name", code: "TOO_LONG" }]);
  const deleted = await request(
    fixture.app,
    "DELETE",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(deleted.status, 204);
  assert.equal(fixture.secretDriver.has(created.data), false);

  const missing = await request(
    fixture.app,
    "GET",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assert.equal(missing.status, 404);

  const audit = JSON.stringify(fixture.auditSink.events);
  assert.equal(audit.includes(originalValue), false);
  assert.equal(audit.includes(rotatedValue), false);
  assert.deepEqual(
    fixture.auditSink.events
      .filter((event) => event.resource.kind === "secret" && event.kind === "mutation")
      .map((event) => event.action),
    [
      "openclaw.secrets.create",
      "openclaw.secrets.create",
      "openclaw.secrets.create",
      "openclaw.secrets.update",
      "openclaw.secrets.delete",
    ],
  );
});

test("Secret API accepts the largest default JSON body and rejects one byte over", async () => {
  const fixture = await createFixture();
  const { namespace } = await bootstrapAgent(fixture);

  const createEnvelope = bodyAtJsonLimit(defaultControllerBodyLimit, (value) => ({
    name: "HTTP body boundary key",
    value,
  }));
  const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    schema: SecretResponse,
    body: createEnvelope.body,
  });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes(syntheticSecretSentinel), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), createEnvelope.value);

  const oversizedCreateBody = {
    ...createEnvelope.body,
    value: `${createEnvelope.value}x`,
  };
  assert.equal(jsonBodyBytes(oversizedCreateBody), defaultControllerBodyLimit + 1);
  const oversizedCreate = await request(
    fixture.app,
    "POST",
    `/namespaces/${namespace.id}/secrets`,
    {
      body: oversizedCreateBody,
    },
  );
  assertApiError(oversizedCreate, 413, "PAYLOAD_TOO_LARGE");
  assert.equal(JSON.stringify(oversizedCreate.body).includes(syntheticSecretSentinel), false);

  const updateEnvelope = bodyAtJsonLimit(defaultControllerBodyLimit, (value) => ({ value }));
  const updated = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: updateEnvelope.body },
  );
  assert.equal(updated.status, 200);
  assert.equal(JSON.stringify(updated.body).includes(syntheticSecretSentinel), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), updateEnvelope.value);

  const oversizedUpdateBody = { value: `${updateEnvelope.value}x` };
  assert.equal(jsonBodyBytes(oversizedUpdateBody), defaultControllerBodyLimit + 1);
  const oversizedUpdate = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
    { body: oversizedUpdateBody },
  );
  assertApiError(oversizedUpdate, 413, "PAYLOAD_TOO_LARGE");
  assert.equal(JSON.stringify(oversizedUpdate.body).includes(syntheticSecretSentinel), false);
  assert.equal(fixture.secretDriver.valueFor(created.data), updateEnvelope.value);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(syntheticSecretSentinel), false);
});

test("Secret API denial and storage failures return value-free errors", async () => {
  const fixture = await createFixture();
  const { namespace } = await bootstrapAgent(fixture);
  const value = `private-denied-value-${randomUUID()}`;
  const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    schema: SecretResponse,
    body: { name: "Denied metadata key", value },
  });
  assert.equal(created.status, 201);

  const { principal: reader, app: readerApp } = await fixture.createPrincipal("secret-reader");
  grantRole(fixture.state, reader.id, {
    id: "role-secret-reader-without-secret",
    bindingId: "binding-secret-reader-without-secret",
    namespaceId: namespace.id,
    permissions: { namespace: ["read"] },
  });

  const denied = await request(
    readerApp,
    "GET",
    `/namespaces/${namespace.id}/secrets/${created.data.id}`,
  );
  assertApiError(denied, 403, "FORBIDDEN");
  const denial = fixture.auditSink.events.at(-1);
  assert.ok(denial?.kind === "authorization_denial");
  assert.deepEqual(denial.authorization, {
    principalId: reader.id,
    action: "read",
    resource: { kind: "secret", id: created.data.id, namespaceId: namespace.id },
  });
  assert.equal(JSON.stringify(denial).includes(value), false);

  const leakedBackendValue = `backend-leak-${randomUUID()}`;
  const failingFixture = await createFixture({
    secretDriver: createTestSecretDriver({
      id: "secret-api-failing",
      createError: new Error(`must not leak ${leakedBackendValue}`),
    }),
  });
  const failing = await bootstrapAgent(failingFixture);
  const failed = await request(
    failingFixture.app,
    "POST",
    `/namespaces/${failing.namespace.id}/secrets`,
    {
      body: {
        name: "Backend failure key",
        value: leakedBackendValue,
      },
    },
  );
  assert.equal(failed.status, 503);
  assert.equal(responseError(failed).code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.body).includes(leakedBackendValue), false);
  assert.equal(JSON.stringify(failingFixture.auditSink.events).includes(leakedBackendValue), false);
});

// These tests exercise API validation, Native IAM, OCC admission, and state ownership.
// Passive Secret storage does not establish provider login or model execution proof.
for (const [model, method, executionMode] of [
  ["openai/gpt-5", "api_key", "embedded"],
  ["anthropic/claude-sonnet-4-5", "api_key", "embedded"],
  ["codex/gpt-5", "codex_pat", "dedicated"],
] as const) {
  test(`${model} Harness Secret binding preserves draft semantics, exact delivery grants, and revision source retention`, async () => {
    const harnessAuthDriver = createTestKubernetesComputeDriver("compute-harness-auth");
    const fixture = await createFixture({
      recordOperations: true,
      computeDriver: {
        ...createReadyComputeDriver("compute-secret-api"),
        validateHarnessAuth: harnessAuthDriver.validateHarnessAuth.bind(harnessAuthDriver),
      },
    });
    const draft = await bootstrapAgent(
      fixture,
      {
        ...(method === "codex_pat" ? createHarnessConfiguration("codex", "gpt-5") : {}),
        agents: {
          defaults: {
            model,
            models: {
              [model]: { agentRuntime: { id: method === "codex_pat" ? "codex" : "openclaw" } },
            },
          },
        },
      },
      executionMode,
    );
    const { namespace, configuration } = draft;
    let { agent } = draft;
    let path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    assert.equal(agent.harnessAuth, null);
    assert.equal((await request(fixture.app, "POST", `${path}/deploy`)).status, 409);
    const value = `synthetic-harness-key-${randomUUID()}`;
    const key = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
      schema: SecretResponse,
      body: { name: "Harness key", value },
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const binding = { method, source: key.data.ref };
    if (method === "codex_pat") {
      const created = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents`, {
        schema: AgentResponse,
        body: {
          name: "direct-pat-agent",
          configurationId: configuration.id,
          executionMode,
          harnessAuth: binding,
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.deepEqual(created.data.harnessAuth, binding);
      agent = created.data;
      path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    }

    const bound = await request(fixture.app, "PATCH", path, {
      schema: AgentResponse,
      body: { configurationId: configuration.id, harnessAuth: binding },
    });
    assert.equal(bound.status, 200);
    assert.deepEqual(bound.data.harnessAuth, binding);
    const unchanged = await request(fixture.app, "PATCH", path, {
      schema: AgentResponse,
      body: { configurationId: configuration.id },
    });
    assert.deepEqual(unchanged.data.harnessAuth, binding);
    // The caller holds delete on the Secret, so the conflict names what still depends on it.
    const blocked = await request(
      fixture.app,
      "DELETE",
      `/namespaces/${namespace.id}/secrets/${key.data.id}`,
    );
    assert.equal(blocked.status, 409);
    assert.equal(
      responseError(blocked).message,
      `The Secret is still referenced by Agent ${agent.id}. Remove those references first.`,
    );
    // Authorization precedes the reference check: a caller without delete learns nothing about references.
    const { app: outsiderApp } = await fixture.createPrincipal("secret-outsider");
    const forbidden = await request(
      outsiderApp,
      "DELETE",
      `/namespaces/${namespace.id}/secrets/${key.data.id}`,
    );
    assertApiError(forbidden, 403, "FORBIDDEN");
    // Administrative rights on the actor do not give the Agent permission to receive a key.
    const { servicePrincipalId } = await fixture
      .controller()
      .getAgent(fixture.principal.id, namespace.id, agent.id);
    assert.ok(servicePrincipalId);
    // The Agent's service principal exists but holds no grant on the key.
    fixture.state.identities.push({
      kind: "service_principal",
      id: servicePrincipalId,
      namespaceId: namespace.id,
    });
    const denied = await request(fixture.app, "POST", `${path}/deploy`);
    assert.equal(denied.status, 403);
    // The caller's own grants passed, so the denial audit records the caller's deploy request
    // and names the Agent service principal and the grant it lacks, never the caller as denied.
    const agentDenial = fixture.auditSink.events.findLast(
      (event) => event.kind === "authorization_denial",
    );
    assert.ok(agentDenial);
    assert.equal(agentDenial.reasonCode, "AGENT_PRINCIPAL_NOT_AUTHORIZED");
    // The caller may read the key, so the answer names it; it never names the principal, which
    // the audit event records (finding 2592).
    assert.equal(
      responseError(denied).message,
      agentPrincipalDenied(`Agent ${agent.id}`, `Secret ${key.data.id}`),
    );
    // The route's reason passes through the audit factory like any other: redacted and capped
    // at 120 characters. The details below still name the principal, action and resource.
    assert.equal(
      agentDenial.decisionReason,
      `The Agent service principal ${servicePrincipalId} is not authorized to operate secret ${key.data.id}. Grant that principal operate on the secret, then deploy again.`.slice(
        0,
        120,
      ),
    );
    assert.deepEqual(agentDenial.authorization, {
      principalId: fixture.principal.id,
      action: "deploy",
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
    });
    const details = agentDenial.details;
    assert.ok(details);
    assert.equal(details.servicePrincipalId, servicePrincipalId);
    assert.equal(details.action, "operate");
    assert.deepEqual(details.resource, key.data.ref);
    assert.equal(details.iamEvidence, undefined);
    assert.equal(asRecord(details.servicePrincipalEvidence)?.identityId, servicePrincipalId);
    grantRole(fixture.state, servicePrincipalId, {
      id: "harness-key-delivery",
      namespaceId: namespace.id,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: key.data.id },
    });
    const admitted = await request(fixture.app, "POST", `${path}/deploy`, {
      schema: revisionBindingResponse,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.deepEqual(admitted.data.harnessAuth, binding);
    const internal = await fixture
      .controller()
      .getRevision(fixture.principal.id, namespace.id, agent.id, admitted.data.id);
    assert.deepEqual(internal.harnessAuth, { ...binding, secretDriverId: fixture.secretDriver.id });
    assert.equal(JSON.stringify(admitted.body).includes("secretDriverId"), false);
    assert.equal(JSON.stringify(admitted.body).includes(value), false);
    const cleared = await request(fixture.app, "PATCH", path, {
      schema: AgentResponse,
      body: { configurationId: configuration.id, harnessAuth: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.harnessAuth, null);
    assert.deepEqual(
      (
        await fixture
          .controller()
          .getRevision(fixture.principal.id, namespace.id, agent.id, admitted.data.id)
      ).harnessAuth,
      internal.harnessAuth,
    );
    // Pending revision ownership outlives the current draft binding.
    assert.equal(
      (await request(fixture.app, "DELETE", `/namespaces/${namespace.id}/secrets/${key.data.id}`))
        .status,
      409,
    );
    assert.equal(JSON.stringify(fixture.auditSink.events).includes(value), false);
  });
}

// Exercises the HTTP routes, Native IAM and in-memory platform state; PostgreSQL's reference
// query is covered by the platform state store contract.
test("Secret consumers name only readable references, on GET and in the delete conflict", async () => {
  const harnessAuthDriver = createTestKubernetesComputeDriver("compute-secret-consumers");
  const fixture = await createFixture({
    computeDriver: {
      ...createReadyComputeDriver("compute-secret-api"),
      validateHarnessAuth: harnessAuthDriver.validateHarnessAuth.bind(harnessAuthDriver),
    },
  });
  const model = "openai/gpt-5";
  const { namespace, configuration, agent } = await bootstrapAgent(fixture, {
    agents: {
      defaults: { model, models: { [model]: { agentRuntime: { id: "openclaw" } } } },
    },
  });
  const secrets = `/namespaces/${namespace.id}/secrets`;
  const key = await request(fixture.app, "POST", secrets, {
    schema: SecretResponse,
    body: { name: "Shared key", value: `synthetic-shared-key-${randomUUID()}` },
  });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  const keyPath = `${secrets}/${key.data.id}`;
  const none = { agents: [], configurations: [], credentialSources: [], provisioningRequests: [] };
  // A new Secret has no consumers, and the field is on the exact read only.
  assert.deepEqual(
    (await request(fixture.app, "GET", keyPath, { schema: SecretDetailResponse })).data.consumers,
    {
      ...none,
      unreadable: 0,
      truncated: false,
    },
  );
  assert.equal(Object.hasOwn(key.data, "consumers"), false);

  const bindTo = async () => {
    const created = await request(
      fixture.app,
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      {
        schema: configurationIdentityResponse,
        body: {
          kind: "agent",
          values: {},
          secretBindings: { SLACK_BOT_TOKEN: { source: key.data.ref } },
        },
      },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.data.id;
  };
  const visible = await bindTo();
  const hidden = await bindTo();
  // The Agent's draft model credential is the third reference.
  const bound = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
    {
      body: {
        configurationId: configuration.id,
        harnessAuth: { method: "api_key", source: key.data.ref },
      },
    },
  );
  assert.equal(bound.status, 200, JSON.stringify(bound.body));

  const admin = await request(fixture.app, "GET", keyPath, { schema: SecretDetailResponse });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.data.consumers, {
    ...none,
    agents: [agent.id],
    configurations: [visible, hidden].sort(),
    unreadable: 0,
    truncated: false,
  });

  // A member who may read and delete the Secret and read one of the Configurations, nothing else.
  const { principal: member, app: memberApp } = await fixture.createPrincipal("secret-member");
  grantRole(fixture.state, member.id, {
    id: "role-consumer-secret",
    namespaceId: namespace.id,
    permissions: { secret: ["read", "delete"] },
    resource: { kind: "secret", id: key.data.id },
  });
  grantRole(fixture.state, member.id, {
    id: "role-consumer-configuration",
    namespaceId: namespace.id,
    permissions: { configuration: ["read"] },
    resource: { kind: "configuration", id: visible },
  });
  const read = await request(memberApp, "GET", keyPath, { schema: SecretDetailResponse });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  // The Agent and the other Configuration are counted, never named: no existence oracle.
  assert.deepEqual(read.data.consumers, {
    ...none,
    configurations: [visible],
    unreadable: 2,
    truncated: false,
  });
  const memberDelete = await request(memberApp, "DELETE", keyPath);
  assertApiError(memberDelete, 409, "RESOURCE_CONFLICT");
  assert.equal(
    responseError(memberDelete).message,
    `The Secret is still referenced by Configuration ${visible}; 2 resources you cannot read. Remove those references first.`,
  );
  for (const unreadable of [hidden, agent.id]) {
    assert.doesNotMatch(JSON.stringify(read.body), new RegExp(unreadable));
    assert.doesNotMatch(JSON.stringify(memberDelete.body), new RegExp(unreadable));
  }
  // Delete alone, without read on the Secret, gets the same answer: naming depends only on
  // reading the referencing resources.
  const { principal: deleter, app: deleterApp } = await fixture.createPrincipal("secret-deleter");
  grantRole(fixture.state, deleter.id, {
    id: "role-consumer-deleter",
    namespaceId: namespace.id,
    permissions: { secret: ["delete"] },
    resource: { kind: "secret", id: key.data.id },
  });
  grantRole(fixture.state, deleter.id, {
    id: "role-consumer-deleter-configuration",
    namespaceId: namespace.id,
    permissions: { configuration: ["read"] },
    resource: { kind: "configuration", id: visible },
  });
  assert.equal((await request(deleterApp, "GET", keyPath)).status, 403);
  assert.deepEqual(
    responseError(await request(deleterApp, "DELETE", keyPath)),
    responseError(memberDelete),
  );

  // The caller who can read everything sees every ID that fits the 256-character message.
  const adminDelete = await request(fixture.app, "DELETE", keyPath);
  assert.equal(adminDelete.status, 409);
  assert.equal(
    responseError(adminDelete).message,
    `The Secret is still referenced by Agent ${agent.id}; Configurations ${[visible, hidden].sort().join(", ")}. Remove those references first.`,
  );

  // Past the limit, OCC examines the first 50 references and says more exist; the message
  // keeps to the error contract's cap and names IDs of each kind in turn.
  const many = [visible, hidden];
  while (many.length < 50) {
    many.push(await bindTo());
  }
  const full = await request(fixture.app, "GET", keyPath, { schema: SecretDetailResponse });
  assert.equal(full.data.consumers.truncated, true);
  assert.deepEqual(full.data.consumers.agents, [agent.id]);
  assert.deepEqual(full.data.consumers.configurations, many.sort().slice(0, 49));
  const capped = await request(fixture.app, "DELETE", keyPath);
  assert.equal(capped.status, 409);
  assert.ok(responseError(capped).message.length <= 256, responseError(capped).message);
  assert.match(
    responseError(capped).message,
    new RegExp(
      `^The Secret is still referenced by Agent ${agent.id}; Configurations cfg_[^;]+ and \\d+ more; and more\\. Remove those references first\\.$`,
    ),
  );

  // Clearing every reference empties consumers and lets deletion proceed.
  const cleared = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
    {
      body: { configurationId: configuration.id, harnessAuth: null },
    },
  );
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  for (const id of many) {
    const removed = await request(
      fixture.app,
      "DELETE",
      `/namespaces/${namespace.id}/configurations/${id}`,
    );
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
  }
  assert.deepEqual(
    (await request(fixture.app, "GET", keyPath, { schema: SecretDetailResponse })).data.consumers,
    {
      ...none,
      unreadable: 0,
      truncated: false,
    },
  );
  assert.equal((await request(fixture.app, "DELETE", keyPath)).status, 204);
});

test("Changing Harness Secret bindings requires grants on both removed and replacement sources", async () => {
  const fixture = await createFixture();
  const { namespace, configuration, agent } = await bootstrapAgent(fixture);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const secrets = [];
  for (const name of ["Original", "Replacement"]) {
    const result = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
      schema: SecretResponse,
      body: { name, value: `synthetic-${randomUUID()}` },
    });
    assert.equal(result.status, 201);
    secrets.push(result.data);
  }
  const [originalSecret, replacementSecret] = secrets;
  assert.ok(originalSecret && replacementSecret);
  const original: HarnessAuthBinding = { method: "api_key", source: originalSecret.ref };
  const replacement: HarnessAuthBinding = { method: "api_key", source: replacementSecret.ref };
  assert.equal(
    (
      await request(fixture.app, "PATCH", path, {
        body: { configurationId: configuration.id, harnessAuth: original },
      })
    ).status,
    200,
  );
  const { principal, app } = await fixture.createPrincipal("harness-editor");
  grantRole(fixture.state, principal.id, {
    id: "harness-editor",
    namespaceId: namespace.id,
    permissions: { agent: ["update"], configuration: ["read"] },
  });
  grantRole(fixture.state, principal.id, {
    id: "harness-source",
    namespaceId: namespace.id,
    permissions: { secret: ["operate"] },
    resource: { kind: "secret", id: originalSecret.id },
  });
  const grant = fixture.state.bindings.find(({ id }) => id === "harness-source");
  assert.ok(grant);
  const patch = (harnessAuth: HarnessAuthBinding | null) =>
    request(app, "PATCH", path, { body: { configurationId: configuration.id, harnessAuth } });
  assert.equal((await patch(replacement)).status, 403); // Missing replacement authority.
  const grantIndex = fixture.state.bindings.indexOf(grant);
  fixture.state.bindings[grantIndex] = { ...grant, resourceId: replacementSecret.id };
  assert.equal((await patch(replacement)).status, 403); // Missing removed-source authority.
  assert.equal((await patch(null)).status, 403);
  fixture.state.bindings.push({
    ...grant,
    id: "harness-source-original",
    resourceId: originalSecret.id,
  });
  assert.equal((await patch(replacement)).status, 200);
  assert.equal(
    (
      await request(
        fixture.app,
        "DELETE",
        `/namespaces/${namespace.id}/secrets/${originalSecret.id}`,
      )
    ).status,
    204,
  );
  assert.equal((await patch(null)).status, 200);
  assert.equal(
    (
      await request(
        fixture.app,
        "DELETE",
        `/namespaces/${namespace.id}/secrets/${replacementSecret.id}`,
      )
    ).status,
    204,
  );
});

test("Harness source admission rejects foreign references and superseded model selectors", async () => {
  const fixture = await createFixture();
  const { namespace, configuration, agent } = await bootstrapAgent(fixture);
  const foreign = await request(fixture.app, "POST", "/namespaces", {
    schema: NamespaceResponse,
    body: { name: "foreign-harness-source" },
  });
  assert.equal(foreign.status, 201);
  await fixture
    .controller()
    .handleNamespaceLifecycle(fixture.principal.id, foreign.data.id, "ready");
  const foreignValue = `synthetic-${randomUUID()}`;
  const key = await request(fixture.app, "POST", `/namespaces/${foreign.data.id}/secrets`, {
    schema: SecretResponse,
    body: { name: "Foreign key", value: foreignValue },
  });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const localKey = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    schema: SecretResponse,
    body: { name: "Local model key", value: `synthetic-${randomUUID()}` },
  });
  assert.equal(localKey.status, 201);
  const patch = (source: SecretReference) =>
    request(fixture.app, "PATCH", path, {
      body: { configurationId: configuration.id, harnessAuth: { method: "api_key", source } },
    });
  assert.equal((await patch(localKey.data.ref)).status, 200);
  const before = await request(fixture.app, "GET", path, { schema: AgentReadResponse });
  assert.equal(before.status, 200);
  assert.ok("harnessAuth" in before.data);
  assert.deepEqual(before.data.harnessAuth, { method: "api_key", source: localKey.data.ref });

  // Foreign references fail validation before OCC looks up either Secret.
  for (const source of [key.data.ref, { ...key.data.ref, id: `sec_${randomUUID()}` }]) {
    const denied = await patch(source);
    assert.equal(
      JSON.stringify(denied.body).includes(foreignValue),
      false,
      "a denied binding must not disclose the Secret value",
    );
    assert.equal(denied.status, 400);
    assert.deepEqual(denied.body, {
      error: { code: "INVALID_REQUEST", message: "Secret references cannot cross Namespaces." },
      meta: { requestId: denied.requestId },
    });
    const after = await request(fixture.app, "GET", path);
    assert.equal(after.status, 200);
    assert.deepEqual(after.data, before.data);
  }
  for (const method of ["POST", "PATCH"]) {
    const rejected = await request(
      fixture.app,
      method,
      method === "POST" ? `/namespaces/${namespace.id}/agents` : path,
      {
        body: {
          ...(method === "POST" ? { name: "Legacy selector" } : {}),
          configurationId: configuration.id,
          serviceAccountId: `sa_${randomUUID()}`,
        },
      },
    );
    assert.equal(rejected.status, 400);
  }
  const malformed = await request(fixture.app, "PATCH", path, {
    body: {
      configurationId: configuration.id,
      harnessAuth: { method: "api_key", source: localKey.data.ref, credential: "plaintext" },
    },
  });
  assert.equal(malformed.status, 400);
  // Provider keys, reserved prefixes and process-control names, in any letter case. The
  // message names the rule and the destination, and the detail points at its binding.
  const reservedPrefix = (prefix: string, name: string) =>
    `A secret binding destination uses the reserved prefix ${prefix}*: ${name}.`;
  const reservedName = (name: string) =>
    `A secret binding destination is a reserved process or platform variable name: ${name}.`;
  for (const [destination, message] of [
    ["OPENAI_API_KEY", reservedPrefix("OPENAI_", "OPENAI_API_KEY")],
    ["ANTHROPIC_API_KEY", reservedPrefix("ANTHROPIC_", "ANTHROPIC_API_KEY")],
    ["ANTHROPIC_AUTH_TOKEN", reservedPrefix("ANTHROPIC_", "ANTHROPIC_AUTH_TOKEN")],
    ["openclaw_gateway_token", reservedPrefix("OPENCLAW_", "openclaw_gateway_token")],
    ["LD_PRELOAD", reservedPrefix("LD_", "LD_PRELOAD")],
    ["KUBECONFIG", reservedName("KUBECONFIG")],
    ["PATH", reservedName("PATH")],
    ["path", reservedName("path")],
    ["HTTPS_PROXY", reservedName("HTTPS_PROXY")],
  ] as const) {
    const reserved = await request(
      fixture.app,
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      {
        body: {
          kind: "agent",
          values: {},
          secretBindings: { [destination]: { source: localKey.data.ref } },
        },
      },
    );
    assert.equal(reserved.status, 400, destination);
    assert.equal(responseError(reserved).message, message, destination);
    assert.deepEqual(
      responseError(reserved).details,
      [{ path: `/secretBindings/${destination}`, code: "INVALID_VALUE" }],
      destination,
    );
    assert.doesNotMatch(
      JSON.stringify(reserved.body),
      new RegExp(localKey.data.ref.id),
      destination,
    );
  }
  assert.equal(
    (
      await request(fixture.app, "POST", `${path}/runtime-credentials`, {
        body: { modelApiKey: "synthetic-legacy-key" },
      })
    ).status,
    400,
  );
});

test("Contract messages give no bound hint for keywords inherited from Object.prototype", () => {
  for (const keyword of ["constructor", "toString", "__proto__"]) {
    const validation = Object.assign(new Error("body/x is invalid"), {
      statusCode: 400,
      validationContext: "body",
      validation: [
        {
          keyword,
          instancePath: "/x",
          schemaPath: `#/properties/x/${keyword}`,
          params: { limit: 1 },
        },
      ],
    });
    const failure = requestFailure(validation);
    assert.equal(failure.status, 400);
    assert.equal(
      failure.message,
      "The request does not match the operation contract: body /x has an unsupported value.",
    );
  }
});

/** Records gateway copies; OCC admission, IAM and the audit rows under test stay real. */
function createRecordingCredentialGateway() {
  const stored = new Map<string, CredentialSourceInput["secrets"]>();
  return {
    id: "credential-gateway-secret-api",
    capability: "credential_gateway",
    implementation: "test-recording-gateway",
    stored,
    validateSourceConfig() {},
    async listSourceTypes() {
      return [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
      ];
    },
    async registerSource(context, input) {
      stored.set(context.source.id, input.secrets);
      return { state: "ready" };
    },
    async updateSource(context, input) {
      stored.set(context.source.id, input.secrets);
      return { state: "ready" };
    },
    async sourceStatus(context) {
      return stored.has(context.source.id) ? { state: "ready" } : { state: "absent" };
    },
    async removeSource(context) {
      stored.delete(context.source.id);
    },
    async attachForRevision() {
      throw new Error("not exercised");
    },
    async attachmentStatus() {
      throw new Error("not exercised");
    },
    async withdraw() {
      throw new Error("not exercised");
    },
  } satisfies CredentialGatewayDriver & { stored: typeof stored };
}

test("credential source writes commit one value-free audit row each", async () => {
  let now = Date.now();
  const fixture = await createFixture({
    now: () => new Date(now),
    computeDriver: {
      ...createReadyComputeDriver("compute-secret-api"),
      async resolveSandboxNamespace(namespace) {
        return { ...namespace, name: `placed-${namespace.id.slice(-12)}` };
      },
    },
  });
  const namespace = await bootstrapNamespace(fixture);
  const gateway = createRecordingCredentialGateway();
  fixture.controller().registerDriver(gateway);
  fixture.controller().selectDriver("credential_gateway", gateway.id);
  const value = `credential-source-value-${randomUUID()}`;
  const rotated = `credential-source-rotated-${randomUUID()}`;
  const secret = await request(fixture.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    schema: SecretResponse,
    body: { name: "Source key", value },
  });
  assert.equal(secret.status, 201);
  const sources = `/namespaces/${namespace.id}/credential-sources`;

  const created = await request(fixture.app, "POST", sources, {
    schema: CredentialSourceResponse,
    body: { name: "openai", type: "openai", secrets: { api_key: secret.data.ref } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(gateway.stored.get(created.data.id), { api_key: value });
  const updatedSecret = await request(
    fixture.app,
    "PATCH",
    `/namespaces/${namespace.id}/secrets/${secret.data.id}`,
    { body: { value: rotated } },
  );
  assert.equal(updatedSecret.status, 200);
  const updated = await request(fixture.app, "PATCH", `${sources}/${created.data.id}`, {
    body: {},
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(gateway.stored.get(created.data.id), { api_key: rotated });
  // Past the registration fence: no timed-out registration could still create a gateway copy.
  now += 71_000;
  const deleted = await request(fixture.app, "DELETE", `${sources}/${created.data.id}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.equal(gateway.stored.has(created.data.id), false);

  const mutations = fixture.auditSink.events.filter(
    (event) => event.kind === "mutation" && event.resource.kind === "credential_source",
  );
  assert.deepEqual(
    mutations.map((event) => [event.action, event.resource]),
    ["create", "update", "delete"].map((verb) => [
      `openclaw.credential_sources.${verb}`,
      { kind: "credential_source", id: created.data.id, namespaceId: namespace.id },
    ]),
  );
  const audit = JSON.stringify(fixture.auditSink.events);
  assert.equal(audit.includes(value), false);
  assert.equal(audit.includes(rotated), false);
});
