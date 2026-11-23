import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  occApiRoutes,
  type UpdateTokenServiceSourceBody,
} from "../../packages/contracts/src/index.ts";

import { createRouteGenerationApp } from "../../apps/controller/src/route-generation-app.ts";

const uuid = "0000000a-0000-4000-8000-00000000000b";
const id = `cs_${uuid}`;
const namespaceId = `ns_${uuid}`;

async function publishedCredentialComponents(t: TestContext) {
  const app = createRouteGenerationApp();
  t.after(() => app.close());

  // Use the source route's validator and serializer to verify that it can resolve the shared schemas.
  const route = { method: "POST", url: `/namespaces/${namespaceId}/credential-sources` } as const;
  let validatorCompiler: typeof app.validatorCompiler;
  let serializerCompiler: typeof app.serializerCompiler;
  app.addHook("onRequest", async (request) => {
    ({ validatorCompiler, serializerCompiler } = request.server);
  });
  await app.inject(route);
  assert.ok(validatorCompiler && serializerCompiler, "Fastify compiled the source routes");

  const document = app.swagger();
  assert.ok("components" in document && document.components?.schemas);
  const components = document.components.schemas;
  function published(name: string) {
    const schema = components[name];
    assert.ok(schema, `Missing OpenAPI component ${name}`);
    return schema;
  }
  return { route, validatorCompiler, serializerCompiler, published };
}

test("published TokenService source request schemas validate managed static material and config", async (t) => {
  const { route, validatorCompiler, published } = await publishedCredentialComponents(t);
  const writeOnlySecret = { properties: { secret: { writeOnly: true } } };
  assert.partialDeepStrictEqual(published("RegisterTokenServiceSourceBody"), writeOnlySecret);
  assert.partialDeepStrictEqual(published("UpdateTokenServiceSourceBody"), writeOnlySecret);

  const credential = { api_key: "synthetic-registration-material" };
  const refs = { api_key: { kind: "secret", namespaceId, id: `sec_${uuid}` } };
  const source = { name: "Model access", type: "static" };
  const config = {};
  const connectionTemplateId = `ctp_${uuid}`;

  // Compile the controller's registered references and the schemas at the public OpenAPI keys.
  const registered = (name: string) => ({ $ref: `${name}#` });
  for (const resolve of [registered, published]) {
    const register = validatorCompiler({
      ...route,
      schema: resolve("RegisterTokenServiceSourceBody"),
    });
    const update = validatorCompiler({ ...route, schema: resolve("UpdateTokenServiceSourceBody") });
    assert.equal(register({ ...source, config, secret: credential }), true);
    // Static custody accepts one opaque value without assigning authority to its field name.
    assert.equal(register({ ...source, secret: { "client-id": "synthetic-material" } }), true);
    // Source enrollment selects a Template by identity; version selection belongs to admission.
    assert.equal(register({ ...source, connectionTemplateId, secret: credential }), true);
    assert.equal(
      register({
        ...source,
        connectionTemplateId,
        connectionTemplateVersion: 1,
        secret: credential,
      }),
      false,
    );
    assert.equal(register(source), false);
    assert.equal(register({ ...source, secret: refs }), false);
    assert.equal(register({ ...source, secrets: refs }), false);
    assert.equal(register({ ...source, driverId: "chosen-owner" }), false);
    assert.equal(update({ secret: credential } satisfies UpdateTokenServiceSourceBody), true);
    assert.equal(update({ config } satisfies UpdateTokenServiceSourceBody), true);
    assert.equal(
      update({ config, secret: credential } satisfies UpdateTokenServiceSourceBody),
      true,
    );
    assert.equal(update({}), false);
    assert.equal(update({ secret: credential, driverId: "chosen-owner" }), false);
    assert.equal(update({ config, connectionTemplateId }), false);

    const invalidConfig = { "client-id": 42 };
    assert.equal(register({ ...source, config: invalidConfig, secret: credential }), false);
    assert.equal(update({ config: invalidConfig }), false);
  }
});

test("namespace Source writes accept static material and reject legacy Secret references or direct OAuth enrollment", async (t) => {
  const { route, validatorCompiler } = await publishedCredentialComponents(t);
  const create = occApiRoutes.find(
    (candidate) => candidate.operationId === "createCredentialSource",
  );
  const update = occApiRoutes.find(
    (candidate) => candidate.operationId === "updateCredentialSource",
  );
  assert.ok(create && "body" in create.schema);
  assert.ok(update && "body" in update.schema);
  const register = validatorCompiler({ ...route, schema: create.schema.body });
  const patch = validatorCompiler({ ...route, method: "PATCH", schema: update.schema.body });
  const material = { opaque: "synthetic-registration-material" };
  const reference = { kind: "secret", namespaceId, id: `sec_${uuid}` };
  const managed = {
    name: "Model access",
    type: "static",
    secret: material,
    config: { provider_preset: "openai" },
  };
  const legacy = { name: "Legacy access", type: "openai", secrets: { api_key: reference } };

  assert.equal(register(managed), true);
  assert.equal(register(legacy), false);
  assert.equal(register({ name: managed.name, type: "static" }), false);
  assert.equal(register({ ...managed, type: "oauth2-refresh-token" }), false);
  assert.equal(register({ ...managed, secrets: legacy.secrets }), false);
  assert.equal(register({ ...managed, type: "openai" }), false);
  assert.equal(register({ ...managed, secret: { first: "one", second: "two" } }), false);
  assert.equal(register({ ...managed, ownerCapability: "token_service" }), false);
  assert.equal(patch({ secret: material }), true);
  assert.equal(patch({ config: { provider_preset: "openai" } }), true);
  assert.equal(patch({ secrets: legacy.secrets }), false);
  assert.equal(patch({ secret: material, secrets: legacy.secrets }), false);
  assert.equal(patch({ secret: material, ownerCapability: "token_service" }), false);
});

test("existing Source responses serialize sanitized managed metadata for detail and list", async (t) => {
  const { route, validatorCompiler, serializerCompiler } = await publishedCredentialComponents(t);
  const list = occApiRoutes.find((candidate) => candidate.operationId === "listCredentialSources");
  const get = occApiRoutes.find((candidate) => candidate.operationId === "getCredentialSource");
  assert.ok(list && get);
  const identity = {
    id,
    namespaceId,
    ref: { kind: "credential_source", namespaceId, id },
    name: "Model access",
    state: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const metadata = { ...identity, type: "static", config: { provider_preset: "openai" } };
  const meta = { requestId: `req_${uuid}` };
  const oauth = {
    ...identity,
    type: "oauth2-refresh-token",
    connectionTemplateId: `ctp_${uuid}`,
    consent: {
      version: 1,
      oauthClientId: `oac_${uuid}`,
      ownerPrincipalId: `prn_${uuid}`,
      requestedScopes: ["read"],
      grantedScopes: ["read"],
      issuer: "https://issuer.example.test",
      tokenUrl: "https://issuer.example.test/token",
      clientId: "public-client",
      destinations: [{ host: "api.example.test", port: 443, path: "/v1/**" }],
    },
  };
  for (const source of [metadata, oauth]) {
    const privateSource = {
      ...source,
      secret: { opaque: "synthetic-material" },
      ownerCapability: "token_service",
      secrets: {},
      tokenServiceInstanceId: "private-instance",
      ...("consent" in source
        ? { consent: { ...source.consent, refreshToken: "synthetic-refresh" } }
        : {}),
    };
    const responseCases: readonly (readonly [
      Parameters<typeof validatorCompiler>[0]["schema"],
      unknown,
      unknown,
    ])[] = [
      [get.schema.response[200], { data: source, meta }, { data: privateSource, meta }],
      [list.schema.response[200], { data: [source], meta }, { data: [privateSource], meta }],
    ];
    for (const [schema, publicPayload, internal] of responseCases) {
      const validate = validatorCompiler({ ...route, schema });
      const serialize = serializerCompiler({ ...route, schema });
      assert.equal(validate(publicPayload), true);
      assert.equal(validate(internal), false);
      assert.deepEqual(JSON.parse(serialize(publicPayload)), publicPayload);
      assert.throws(() => serialize(internal), TypeError);
    }
  }
});

test("published manual delivery retry schemas require an explicit selection and return per-source outcomes", async (t) => {
  const { route, validatorCompiler, serializerCompiler, published } =
    await publishedCredentialComponents(t);
  const select = validatorCompiler({ ...route, schema: published("PushAgentCredentialsBody") });
  const secondId = "cs_0000000a-0000-4000-8000-00000000000c";
  assert.equal(select({ sources: "all" }), true);
  assert.equal(select({ sources: [id, secondId] }), true);
  const maxSelection = Array.from(
    { length: 64 },
    (_, index) => `cs_0000000a-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  );
  assert.equal(select({ sources: maxSelection }), true);
  const overLimitSelection = [...maxSelection, "cs_0000000a-0000-4000-8000-000000000040"];
  assert.equal(select({ sources: overLimitSelection }), false);
  assert.equal(select({}), false);
  assert.equal(select({ sources: [] }), false);
  assert.equal(select({ sources: [id, id] }), false);
  assert.equal(select({ sources: [namespaceId] }), false);

  const response = {
    data: {
      results: [
        { sourceId: id, outcome: "succeeded" },
        { sourceId: secondId, outcome: "delivery_failed" },
        { sourceId: "cs_0000000a-0000-4000-8000-00000000000d", outcome: "resolution_failed" },
      ],
    },
    meta: { requestId: `req_${uuid}` },
  };
  const responseSchema = published("PushAgentCredentialsResponse");
  const validResponse = validatorCompiler({ ...route, schema: responseSchema });
  assert.equal(validResponse(response), true);
  // Clients can distinguish owner resolution failures from proxy failures. A preflight
  // denial belongs to the request's error response, never to an individual source.
  assert.equal(
    validResponse({ ...response, data: { results: [{ sourceId: id, outcome: "denied" }] } }),
    false,
  );

  // Internal backend data must never reach the caller alongside partial success.
  const internal = {
    ...response,
    data: {
      results: response.data.results.map((item) => ({
        ...item,
        credential: "synthetic",
        backendMessage: "private diagnostic",
      })),
    },
  };
  assert.equal(validResponse(internal), false);
  const serialize = serializerCompiler({ ...route, schema: responseSchema });
  assert.deepEqual(JSON.parse(serialize(internal)), response);
});
