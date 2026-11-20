import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { UpdateTokenServiceSourceBody } from "@openclaw-enterprise/contracts";

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

test("published TokenService source schemas accept registration material and serialize only metadata", async (t) => {
  const { route, validatorCompiler, serializerCompiler, published } =
    await publishedCredentialComponents(t);
  const writeOnlySecret = { properties: { secret: { writeOnly: true } } };
  assert.partialDeepStrictEqual(published("RegisterTokenServiceSourceBody"), writeOnlySecret);
  assert.partialDeepStrictEqual(published("UpdateTokenServiceSourceBody"), {
    anyOf: [writeOnlySecret, writeOnlySecret],
  });

  const credential = { api_key: "synthetic-registration-material" };
  const refs = { api_key: { kind: "secret", namespaceId, id: `sec_${uuid}` } };
  const source = { name: "Model access", type: "openai" };
  const config = {};
  const connectionTemplateId = `ctp_${uuid}`;

  const metadata = {
    ...source,
    id,
    namespaceId,
    ref: { kind: "credential_source", namespaceId, id },
    config,
    connectionTemplateId,
    state: "ready",
    version: "v2",
  };
  const internal = {
    ...metadata,
    ownerCapability: "token_service",
    tokenServiceInstanceId: "private-instance",
    driverId: "model-credentials",
    delivery: "push",
    secret: credential,
    secrets: refs,
    backendRef: { key: "private" },
  };
  // Compile the controller's registered references and the schemas at the public OpenAPI keys.
  const registered = (name: string) => ({ $ref: `${name}#` });
  for (const resolve of [registered, published]) {
    const register = validatorCompiler({
      ...route,
      schema: resolve("RegisterTokenServiceSourceBody"),
    });
    const update = validatorCompiler({ ...route, schema: resolve("UpdateTokenServiceSourceBody") });
    const metadataSchema = resolve("TokenServiceSourceMetadata");
    const validMetadata = validatorCompiler({ ...route, schema: metadataSchema });
    const serializeMetadata: (value: unknown) => string = serializerCompiler({
      ...route,
      schema: metadataSchema,
    });

    assert.equal(register({ ...source, config, secret: credential }), true);
    // The selected source type owns its material field names.
    assert.equal(register({ ...source, secret: { "client-id": "synthetic-material" } }), true);
    // The source attaches the template identity rather than pinning one template version.
    assert.equal(register({ ...source, connectionTemplateId, secret: credential }), true);
    assert.equal(register({ ...source, connectionTemplateId: "invalid" }), false);
    assert.equal(register({ ...source, secret: refs }), false);
    assert.equal(register({ ...source, secrets: refs }), false);
    assert.equal(register({ ...source, driverId: "chosen-owner" }), false);
    assert.equal(update({ secret: credential } satisfies UpdateTokenServiceSourceBody), true);
    assert.equal(update({ config } satisfies UpdateTokenServiceSourceBody), true);
    assert.equal(
      update({ config, secret: credential } satisfies UpdateTokenServiceSourceBody),
      true,
    );
    // @ts-expect-error Both the client type and the wire contract require at least one change.
    assert.equal(update({} satisfies UpdateTokenServiceSourceBody), false);
    assert.equal(update({ secret: credential, driverId: "chosen-owner" }), false);
    assert.equal(update({ config, connectionTemplateId }), false);

    const invalidConfig = { "client-id": 42 };
    assert.equal(register({ ...source, config: invalidConfig }), false);
    assert.equal(update({ config: invalidConfig }), false);
    assert.equal(validMetadata({ ...metadata, config: invalidConfig }), false);
    assert.equal(validMetadata(metadata), true);
    assert.equal(validMetadata(internal), false);
    // Private ownership, delivery, backend, and material fields never enter public metadata.
    assert.deepEqual(JSON.parse(serializeMetadata(internal)), metadata);
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
