import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Namespace } from "../../packages/contracts/src/index.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import type { ConfigurationOwnership } from "../../packages/occ/src/ports/configurations.ts";
import type { PlatformReadView } from "../../packages/occ/src/ports/platform-read-view.ts";
import type { PlatformStateStore } from "../../packages/occ/src/ports/platform-state-store.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/ports/platform-unit-of-work.ts";

const repositoryNamespace = (): Namespace => ({
  id: `ns_${randomUUID()}`,
  name: `Repository ${randomUUID()}`,
  status: "ready",
  createdAt: new Date().toISOString(),
});

/** Run identical lifetime observations against each real adapter. */
export async function verifyRepositoryLifetime(t: TestContext, store: PlatformStateStore) {
  await t.test("read projections expose only reads and retained handles close", async () => {
    const escaped = await store.read(async (view: PlatformReadView) => {
      assert.equal(Object.hasOwn(view.installations, "createInstallation"), false);
      assert.equal(Object.hasOwn(view.namespaces, "lockNamespace"), false);
      assert.equal(Object.hasOwn(view.configurations, "deleteConfiguration"), false);
      assert.ok(await view.installations.getInstallation());
      return view;
    });
    await assert.rejects(escaped.installations.getInstallation(), ScopeViolationError);
    await assert.rejects(escaped.namespaces.listNamespaces(), ScopeViolationError);
  });
  await t.test("accepted multi-step resource operations finish before publication", async () => {
    const namespace = repositoryNamespace();
    await store.transact((unit) => unit.namespaces.createNamespace(namespace));
    const configuration: ConfigurationOwnership = {
      id: `cfg_${randomUUID()}`,
      namespaceId: namespace.id,
      kind: "agent",
      generation: 1,
      createdAt: namespace.createdAt,
    };
    let completed = false;
    const { unit: escaped, accepted } = await store.transact(async (unit: PlatformUnitOfWork) => {
      // Creation awaits a Namespace lookup internally. The owner must drain the
      // whole admitted operation, including its later write, before publishing.
      const accepted = unit.configurations.createConfiguration(configuration).then((created) => {
        completed = true;
        return created;
      });
      return { unit, accepted };
    });
    assert.equal(completed, true);
    assert.deepEqual(await accepted, configuration);
    assert.deepEqual(
      await store.read((view) =>
        view.configurations.findConfiguration(namespace.id, configuration.id),
      ),
      configuration,
    );
    // The narrow proof capability must close with the rest of the unit, before
    // it can inspect arguments or touch a connection returned to the pool.
    // @ts-expect-error Missing proof inputs must still fail on the closed lifetime first.
    await assert.rejects(escaped.preparedTokenProof.current(), ScopeViolationError);
    await assert.rejects(
      escaped.configurations.deleteConfiguration(namespace.id, configuration.id),
      ScopeViolationError,
    );
  });
}
