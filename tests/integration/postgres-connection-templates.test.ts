import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { selectTemplateDrivers } from "../helpers/connection-template-drivers.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const fixtureOptions = {
  label: "connection-templates",
  authSecret: "connection-templates-test-session-secret",
};

function templateInput() {
  return {
    displayName: "Engineering mail",
    issuer: "https://accounts.example.test",
    authorizationUrl: "https://accounts.example.test/authorize",
    tokenUrl: "https://accounts.example.test/token",
    clientId: randomUUID(),
    clientSecret: randomUUID(),
    scopes: ["mail.read"],
    endpoint: { host: "mail.example.test", port: 443, path: "/**" },
    envVar: "MAIL_TOKEN",
  };
}

test(
  "template versions and OAuth client rotation respect the template's scope",
  requiresPostgres,
  async (t) => {
    const { controller, inject } = await createPostgresAgentApp(t, fixtureOptions);
    const { providers } = selectTemplateDrivers(controller);
    const ns = await inject("POST", "/namespaces", { name: `Template scope ${randomUUID()}` });
    assert.equal(ns.statusCode, 201, ns.body);
    const namespaceId = ns.json().data.id;
    const input = templateInput();
    const global = await inject("POST", "/connection-templates", input);
    assert.equal(global.statusCode, 201, global.body);
    const globalTemplate = global.json().data;
    const namespaceSecret = randomUUID();
    const local = await inject("POST", "/connection-templates", {
      ...input,
      namespaceId,
      clientSecret: namespaceSecret,
    });
    assert.equal(local.statusCode, 201, local.body);
    const localTemplate = local.json().data;
    assert.equal(localTemplate.namespaceId, namespaceId);
    assert.notEqual(
      globalTemplate.current.clientRegistrationId,
      localTemplate.current.clientRegistrationId,
    );

    const blocked = await inject("DELETE", `/namespaces/${namespaceId}`, undefined);
    assert.equal(blocked.statusCode, 409, blocked.body);

    const localPath = `/connection-templates/${localTemplate.id}`;
    const rename = await inject("PATCH", localPath, { displayName: "Engineering inbox" });
    assert.equal(rename.statusCode, 200, rename.body);
    assert.equal(rename.json().data.current.version, 1);
    const changed = await inject("PATCH", localPath, { scopes: ["calendar.read"] });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().data.current.version, 2);
    const freshSecret = randomUUID();
    const rotate = await inject("POST", `${localPath}/rotate-client-secret`, {
      clientSecret: freshSecret,
    });
    assert.equal(rotate.statusCode, 200, rotate.body);

    // Both templates use the same issuer and client ID. A rotation must touch only the local registration.
    const stored = [...providers.values()].flatMap((provider) =>
      Object.values(provider.credentials),
    );
    assert.ok(stored.includes(input.clientSecret));
    assert.ok(stored.includes(freshSecret));
    assert.ok(!stored.includes(namespaceSecret));
    const list = await inject("GET", "/connection-templates", undefined);
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(!list.body.includes(input.clientSecret) && !list.body.includes(freshSecret));
    assert.ok(
      list.json().data.some((template: { id: string }) => template.id === localTemplate.id),
    );
    const deleted = await inject("DELETE", localPath, undefined);
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal((await inject("GET", localPath, undefined)).statusCode, 404);
    assert.equal(
      (await inject("GET", `/connection-templates/${globalTemplate.id}`, undefined)).statusCode,
      200,
    );
    assert.equal(
      (await inject("DELETE", `/connection-templates/${globalTemplate.id}`, undefined)).statusCode,
      204,
    );
  },
);

test("template registrations survive an unacknowledged commit", requiresPostgres, async (t) => {
  for (const method of ["POST", "PATCH"]) {
    await t.test(method, async (t) => {
      const proxy = await commitAckProxy(databaseUrl);
      t.after(() => proxy.close());
      const { controller, inject } = await createPostgresAgentApp(t, {
        ...fixtureOptions,
        transportDatabaseUrl: proxy.url,
      });
      const { refresh } = selectTemplateDrivers(controller);
      const input = templateInput();
      let path = "/connection-templates";
      if (method === "PATCH") {
        const original = await inject("POST", path, input);
        assert.equal(original.statusCode, 201, original.body);
        path += `/${original.json().data.id}`;
      }
      // PostgreSQL commits the new version, but the controller loses the response after staging the client.
      const register = refresh.registerClient.bind(refresh);
      t.mock.method(
        refresh,
        "registerClient",
        async (...args: Parameters<typeof register>) => {
          await register(...args);
          proxy.arm();
        },
        { times: 1 },
      );
      const replacement = { clientId: randomUUID(), clientSecret: randomUUID() };
      const result = await inject(
        method,
        path,
        method === "POST" ? { ...input, ...replacement } : replacement,
      );
      assert.equal(result.statusCode, 503, result.body);
      assert.ok(proxy.observedCommit);
      const list = await inject("GET", "/connection-templates", undefined);
      assert.equal(list.statusCode, 200, list.body);
      const saved = list
        .json()
        .data.find(
          (template: { current: { clientId: string } }) =>
            template.current.clientId === replacement.clientId,
        );
      assert.ok(saved);
      const savedPath = `/connection-templates/${saved.id}`;
      const rotation = await inject("POST", `${savedPath}/rotate-client-secret`, {
        clientSecret: randomUUID(),
      });
      assert.equal(rotation.statusCode, 200, rotation.body);
      assert.equal((await inject("DELETE", savedPath, undefined)).statusCode, 204);
    });
  }
});
