import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "PostgreSQL preserves managed adoption and enforces unique external ownership through the Agent API",
  requiresPostgres,
  async (t) => {
    // Production Fastify, PostgreSQL State/authentication and Native IAM. Configuration
    // and runtime Drivers are test adapters; this is not live-runtime proof.
    const f = await createPostgresAgentApp(t, {
      label: "external-management",
      authSecret: "external-management-fixture-signing-secret",
    });
    const { namespace, agent: first, secretRef } = await f.deployAgent("external-management");
    const configuration = await f.inject("POST", `/namespaces/${namespace.id}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(configuration.statusCode, 201, configuration.body);
    const created = await f.inject("POST", `/namespaces/${namespace.id}/agents`, {
      name: `second-managed-${randomUUID()}`,
      configurationId: configuration.json().data.id,
      harnessAuth: { method: "api_key", source: secretRef },
    });
    assert.equal(created.statusCode, 201, created.body);
    const second = created.json().data;
    const sourceId = `persistent-controller/${randomUUID()}`;
    const adopt = async (agent: { id: string }) => {
      const path = `/namespaces/${namespace.id}/agents/${agent.id}/management`;
      const observed = await f.inject("GET", path);
      assert.equal(observed.statusCode, 200, observed.body);
      const snapshot = observed.json().data.adoption;
      return f.inject("PUT", path, {
        sourceId,
        expectedConfigurationId: snapshot.configurationId,
        expectedConfigurationGeneration: snapshot.configurationGeneration,
        expectedFingerprint: snapshot.fingerprint,
        ...(snapshot.activeRevisionId === undefined
          ? {}
          : { expectedActiveRevisionId: snapshot.activeRevisionId }),
        expectedManagementVersion: 0,
      });
    };
    const accepted = await adopt(first);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((await adopt(second)).statusCode, 409);
    // A new repository instance must see the committed owner, not a process-local cache.
    const restored = await new PostgresPlatformState(f.pool).read((view) =>
      view.agents.findAgent(namespace.id, first.id),
    );
    assert.equal(restored?.externalManagement?.sourceId, sourceId);
    assert.equal(restored?.externalManagement?.version, 1);
    const edit = await f.inject(
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${first.configurationId}`,
      { values: {}, expectedGeneration: 1 },
    );
    assert.equal(edit.statusCode, 409);
    const path = `/namespaces/${namespace.id}/agents/${first.id}/management`;
    const saved = await f.inject(
      "GET",
      `/namespaces/${namespace.id}/configurations/${first.configurationId}`,
    );
    const values = { ...saved.json().data.values, messages: { visibleReplies: "automatic" } };
    const input = {
      sourceId,
      sourceGeneration: 2,
      expectedVersion: 1,
      requestKey: "generation-2",
      desiredRuntimeState: "running",
      configuration: { values },
    };
    const applied = await f.inject("POST", `${path}/apply`, input);
    assert.equal(applied.statusCode, 200, applied.body);
    const replayed = await f.inject("POST", `${path}/apply`, input);
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.deepEqual(replayed.json().data, applied.json().data);
    const receipt = await new PostgresPlatformState(f.pool).read((view) =>
      view.agents.findAgent(namespace.id, first.id),
    );
    assert.equal(receipt?.externalManagement?.request?.key, input.requestKey);
    assert.equal(
      receipt?.externalManagement?.request?.revisionId,
      applied.json().data.management.requestedRevisionId,
    );
    // A newer lease holder may know the current version; an older desired generation
    // still cannot overwrite already accepted state.
    const stale = await f.inject("POST", `${path}/apply`, {
      ...input,
      sourceGeneration: 1,
      expectedVersion: applied.json().data.management.version,
      requestKey: "delayed-generation-1",
    });
    assert.equal(stale.statusCode, 409, stale.body);
  },
);
