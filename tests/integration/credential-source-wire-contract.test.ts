import assert from "node:assert/strict";
import test from "node:test";

import { createRouteGenerationApp } from "../../apps/controller/src/route-generation-app.ts";

test("published TokenService source schemas accept registration material and serialize only metadata", async (t) => {
  const app = createRouteGenerationApp();
  t.after(() => app.close());

  const uuid = "0000000a-0000-4000-8000-00000000000b";
  const id = `cs_${uuid}`;
  const namespaceId = `ns_${uuid}`;

  // A request to the existing source collection exposes the compiler configuration
  // of the plugin that registered the standalone components.
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
  const components = Object.values(document.components.schemas);
  function component(name: string) {
    const schema = components.find((entry) => "title" in entry && entry.title === name);
    assert.ok(schema, `Missing OpenAPI component ${name}`);
    return schema;
  }
  const register = validatorCompiler({
    ...route,
    schema: component("RegisterTokenServiceSourceBody"),
  });
  const update = validatorCompiler({ ...route, schema: component("UpdateTokenServiceSourceBody") });
  const metadataSchema = component("TokenServiceSourceMetadata");
  const validMetadata = validatorCompiler({ ...route, schema: metadataSchema });
  const serializeMetadata = serializerCompiler({ ...route, schema: metadataSchema });

  const credential = { api_key: "synthetic-registration-material" };
  const refs = { api_key: { kind: "secret", namespaceId, id: `sec_${uuid}` } };
  const source = { name: "Model access", type: "openai" };
  const config = { authorized_base_url: "https://models.example.test/v1" };

  // The caller supplies material and lifecycle settings. The controller assigns the owner.
  assert.equal(register({ ...source, config, secret: credential }), true);
  assert.equal(register({ ...source, secret: refs }), false);
  assert.equal(register({ ...source, secrets: refs }), false);
  assert.equal(register({ ...source, driverId: "chosen-owner" }), false);
  assert.equal(update({ secret: credential }), true);
  assert.equal(update({ config }), true);
  assert.equal(update({}), false);
  assert.equal(update({ secret: credential, driverId: "chosen-owner" }), false);

  const metadata = {
    ...source,
    id,
    namespaceId,
    ref: { kind: "credential_source", namespaceId, id },
    config,
    state: "ready",
    ownerCapability: "token_service",
    driverId: "model-credentials",
    delivery: "push",
    version: "v2",
  };
  // Verify both the published read shape and the bytes a Fastify serializer
  // emits when an internal record contains fields reserved for the owner.
  const internal = {
    ...metadata,
    secret: credential,
    secrets: refs,
    backendRef: { key: "private" },
  };
  assert.equal(validMetadata(metadata), true);
  assert.equal(validMetadata(internal), false);
  assert.deepEqual(JSON.parse(serializeMetadata(internal)), metadata);
});
