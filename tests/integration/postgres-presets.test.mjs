import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const identifier = (kind) => `${kind}_${randomUUID()}`;

async function exercisePresets(store, reopened = store) {
  const createdAt = new Date().toISOString();
  const namespace = {
    id: identifier("ns"),
    name: `Presets ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const otherNamespace = { ...namespace, id: identifier("ns"), name: `${namespace.name} other` };
  await store.transact(async (state) => {
    if ((await state.installations.getInstallation()) === undefined) {
      await state.installations.createInstallation({
        id: identifier("ins"),
        name: "Preset persistence",
        createdAt,
      });
    }
    await state.namespaces.createNamespace(namespace);
    await state.namespaces.createNamespace(otherNamespace);
  });
  const preset = {
    id: identifier("pre"),
    namespaceId: namespace.id,
    name: "Chat assistant",
    createdAt,
    template: {
      variables: { model: { type: "string", default: "openai/example" } },
      agent: { name: "Assistant", executionMode: "embedded" },
      configuration: {
        values: {
          agents: { defaults: { model: "{{ vars.model }}" } },
          gateway: { auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" } },
        },
      },
    },
  };
  await store.transact((state) => state.presets.createPreset(preset));
  // A fresh storage instance reads the complete unresolved template, not rendered launch data.
  const copy = await reopened.read((state) => state.presets.findPreset(namespace.id, preset.id));
  assert.deepEqual(copy, preset);
  assert.equal(Object.isFrozen(copy.template), true);
  await reopened.read(async (state) => {
    assert.equal(await state.presets.findPreset(otherNamespace.id, preset.id), undefined);
    assert.deepEqual(await state.presets.listPresets(otherNamespace.id), []);
    assert.deepEqual(await state.presets.listPresets(namespace.id), [preset]);
  });
  assert.equal(await store.transact((state) => state.namespaces.hasPresets(namespace.id)), true);

  // Names are unique only inside their owning Namespace, including concurrent creation.
  const duplicate = { ...preset, id: identifier("pre"), name: "Concurrent name" };
  const contenders = await Promise.allSettled([
    store.transact((state) => state.presets.createPreset(duplicate)),
    reopened.transact((state) =>
      state.presets.createPreset({ ...duplicate, id: identifier("pre") }),
    ),
  ]);
  assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    contenders.find((result) => result.status === "rejected").reason.name,
    "ResourceConflictError",
  );
  await store.transact((state) =>
    state.presets.createPreset({
      ...preset,
      id: identifier("pre"),
      namespaceId: otherNamespace.id,
    }),
  );
  await assert.rejects(
    store.transact((state) =>
      state.presets.updatePreset(namespace.id, preset.id, { name: duplicate.name, template: {} }),
    ),
    { name: "ResourceConflictError" },
  );
  assert.deepEqual(
    await reopened.read((state) => state.presets.findPreset(namespace.id, preset.id)),
    preset,
  );
  const renamed = await store.transact((state) =>
    state.presets.updatePreset(namespace.id, preset.id, { name: "Renamed" }),
  );
  assert.deepEqual(renamed.template, preset.template);
  const updated = await store.transact((state) =>
    state.presets.updatePreset(namespace.id, preset.id, { template: {} }),
  );
  assert.deepEqual(updated.template, {});
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.createdAt, preset.createdAt);
  assert.deepEqual(copy.template, preset.template);
  assert.equal(
    await store.transact((state) => state.presets.deletePreset(otherNamespace.id, preset.id)),
    false,
  );

  // Namespace deletion must retain its tombstone guard even when Presets are its only children.
  await store.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "ready", "deleting"),
  );
  await assert.rejects(
    store.transact((state) =>
      state.namespaces.markNamespaceDeleted(namespace.id, new Date().toISOString()),
    ),
    { name: "ScopeViolationError" },
  );
  await assert.rejects(
    store.transact((state) =>
      state.presets.createPreset({ ...preset, id: identifier("pre"), name: "Late" }),
    ),
    { name: "ScopeViolationError" },
  );
  await store.transact(async (state) => {
    for (const remaining of await state.presets.listPresets(namespace.id)) {
      assert.equal(await state.presets.deletePreset(namespace.id, remaining.id), true);
    }
    assert.equal(await state.namespaces.hasPresets(namespace.id), false);
    assert.ok(await state.namespaces.markNamespaceDeleted(namespace.id, new Date().toISOString()));
  });
  assert.equal(
    await reopened.read((state) => state.presets.findPreset(namespace.id, preset.id)),
    undefined,
  );
  return { preset, otherNamespace };
}

test("in-memory Presets preserve template copies, Namespace isolation, and deletion boundaries", async () => {
  await exercisePresets(new InMemoryPlatformState());
});

test(
  "PostgreSQL Presets survive reopening and enforce names, ownership, and Namespace deletion",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
  },
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    const secondPool = new Pool({ connectionString: databaseUrl });
    context.after(() => Promise.all([pool.end(), secondPool.end()]));
    const { preset, otherNamespace } = await exercisePresets(
      new PostgresPlatformState(pool),
      new PostgresPlatformState(secondPool),
    );
    const stored = (
      await pool.query("SELECT id FROM occ.presets WHERE namespace_id = $1", [otherNamespace.id])
    ).rows[0];
    // The application role cannot rewrite identity/ownership or bypass the namespace FK.
    await assert.rejects(
      pool.query("UPDATE occ.presets SET namespace_id = $2 WHERE id = $1", [
        stored.id,
        identifier("ns"),
      ]),
      { code: "42501" },
    );
    await assert.rejects(
      pool.query("UPDATE occ.presets SET created_at = now() WHERE id = $1", [stored.id]),
      { code: "42501" },
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO occ.presets (id, namespace_id, name, template, created_at) VALUES ($1, $2, $3, $4, now())",
        [identifier("pre"), identifier("ns"), "Unowned", "{}"],
      ),
      { code: "23503" },
    );
    await assert.rejects(
      pool.query("UPDATE occ.presets SET template = '[]'::jsonb WHERE id = $1", [stored.id]),
      { code: "23514" },
    );
    // Restrictions exercise the real database scope trigger with application-role privileges.
    await pool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'preset', $3, 'deny')`,
      [identifier("restriction"), otherNamespace.id, stored.id],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'preset', $3, 'deny')`,
        [identifier("restriction"), preset.namespaceId, stored.id],
      ),
      { code: "23514" },
    );
  },
);
