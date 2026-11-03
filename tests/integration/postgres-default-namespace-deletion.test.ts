import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

const AGENT_CREATOR_BINDING = "binding_builtin_default_users_agent_create";

// Its own file: each file gets a fresh database, and this test deletes the Namespace named
// default that bootstrap created, which other Default users tests use.
test(
  "deleting the default Namespace removes its Default users binding with the rest of its policy",
  requiresPostgres,
  async (t) => {
    const { pool, inject, controller, principal } = await createPostgresAgentApp(t, {
      label: "default-namespace-deletion",
      authSecret: "default-namespace-deletion-postgres-auth-secret-32",
    });
    const namespaces = await inject("GET", "/namespaces");
    assert.equal(namespaces.statusCode, 200, namespaces.body);
    const namespace = namespaces
      .json()
      .data.find(({ name }: { name: string }) => name === "default");
    assert.ok(namespace, "bootstrap creates the Namespace named default");
    if (namespace.status !== "ready") {
      await controller.handleNamespaceLifecycle(principal.id, namespace.id, "ready");
    }
    const bindings = async () =>
      (
        await pool.query("SELECT id FROM occ.iam_access_bindings WHERE namespace_id = $1", [
          namespace.id,
        ])
      ).rows.map(({ id }) => id as string);
    assert.ok((await bindings()).includes(AGENT_CREATOR_BINDING));

    // While the Namespace exists, not even an administrator can remove the Agent Creator binding.
    const refused = await inject(
      "DELETE",
      `/namespaces/${namespace.id}/iam/access-bindings/${AGENT_CREATOR_BINDING}`,
    );
    assert.notEqual(refused.statusCode, 204, refused.body);
    assert.ok((await bindings()).includes(AGENT_CREATOR_BINDING));

    // Deletion cleanup with the fixture Compute Driver tombstones the Namespace and removes all
    // of its bindings in one transaction, so no grant outlives it and the delete can finish.
    const admitted = await inject("DELETE", `/namespaces/${namespace.id}`);
    assert.equal(admitted.statusCode, 202, admitted.body);
    await controller.handleNamespaceLifecycle(principal.id, namespace.id, "deleted");
    const tombstone = await pool.query(
      "SELECT deleted_at IS NOT NULL AS deleted FROM occ.namespaces WHERE id = $1",
      [namespace.id],
    );
    assert.equal(tombstone.rows[0].deleted, true);
    assert.deepEqual(await bindings(), []);
  },
);
