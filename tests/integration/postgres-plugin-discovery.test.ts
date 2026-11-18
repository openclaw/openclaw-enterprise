import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { deferred } from "../helpers/deferred.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "saved Agent catalog discovery releases the database connection while reading Configuration",
  requiresPostgres,
  async (t) => {
    const { controller, inject, pool, principal } = await createPostgresAgentApp(t, {
      label: "plugin-discovery",
      authSecret: "plugin-discovery-postgres-auth-secret-minimum-32",
      poolOptions: { max: 1 },
    });
    controller.installPluginDrivers([new OCCPluginDriver()]);
    const namespace = await inject("POST", "/namespaces", { name: `Plugins ${randomUUID()}` });
    assert.equal(namespace.statusCode, 201, namespace.body);
    const namespaceId = namespace.json().data.id;
    const path = `/namespaces/${namespaceId}`;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const config = await inject("POST", `${path}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(config.statusCode, 201, config.body);
    const agent = await inject("POST", `${path}/agents`, {
      name: "Dedicated OpenClaw",
      executionMode: "dedicated",
      configurationId: config.json().data.id,
    });
    assert.equal(agent.statusCode, 201, agent.body);

    // A slow Configuration Driver must leave the only PostgreSQL connection available to other requests.
    const configuration = controller.selectedDriver("configuration");
    const read = configuration.read.bind(configuration);
    const entered = deferred();
    const resume = deferred();
    t.mock.method(configuration, "read", async (...args: Parameters<typeof read>) => {
      entered.resolve();
      await resume.promise;
      return read(...args);
    });
    const catalog = inject("POST", `${path}/agents/${agent.json().data.id}/plugins`, {});
    let result;
    try {
      await Promise.race([
        entered.promise,
        catalog.then((reply) =>
          assert.fail(`Discovery returned before reading Configuration: ${reply.body}`),
        ),
      ]);
      assert.equal(pool.idleCount, 1, "discovery held the sole database connection");
      const otherRequest = await inject("GET", path);
      assert.equal(otherRequest.statusCode, 200, otherRequest.body);
    } finally {
      resume.resolve();
      result = await catalog;
    }
    assert.equal(result.statusCode, 200, result.body);
  },
);
