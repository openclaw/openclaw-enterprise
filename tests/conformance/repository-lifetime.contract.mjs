import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";

export const repositoryNamespace = () => ({
  id: `ns_${randomUUID()}`,
  name: `Repository ${randomUUID()}`,
  status: "ready",
  createdAt: new Date().toISOString(),
});

/** Run identical lifetime observations against each real adapter. */
export async function verifyRepositoryLifetime(t, store) {
  await t.test("read projections expose only reads and retained handles close", async () => {
    let escaped;
    await store.read(async (view) => {
      escaped = view;
      assert.equal(Object.hasOwn(view.installations, "createInstallation"), false);
      assert.equal(Object.hasOwn(view.namespaces, "lockNamespace"), false);
      assert.equal(Object.hasOwn(view.configurations, "deleteConfiguration"), false);
      assert.ok(await view.installations.getInstallation());
    });
    await assert.rejects(escaped.installations.getInstallation(), ScopeViolationError);
    await assert.rejects(escaped.namespaces.listNamespaces(), ScopeViolationError);
  });
  await t.test("accepted multi-step resource operations finish before publication", async () => {
    const namespace = repositoryNamespace();
    await store.transact((unit) => unit.namespaces.createNamespace(namespace));
    const configuration = {
      id: `cfg_${randomUUID()}`,
      namespaceId: namespace.id,
      kind: "agent",
      generation: 1,
      createdAt: namespace.createdAt,
    };
    let accepted;
    let completed = false;
    let escaped;
    await store.transact(async (unit) => {
      escaped = unit;
      // Creation awaits a Namespace lookup internally. The owner must drain the
      // whole admitted operation, including its later write, before publishing.
      accepted = unit.configurations.createConfiguration(configuration).then((created) => {
        completed = true;
        return created;
      });
    });
    assert.equal(completed, true);
    assert.deepEqual(await accepted, configuration);
    assert.deepEqual(
      await store.read((view) =>
        view.configurations.findConfiguration(namespace.id, configuration.id),
      ),
      configuration,
    );
    await assert.rejects(
      escaped.configurations.deleteConfiguration(namespace.id, configuration.id),
      ScopeViolationError,
    );
  });
}
