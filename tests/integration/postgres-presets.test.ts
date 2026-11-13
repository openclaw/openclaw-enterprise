import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { Namespace, Preset, PresetResponse } from "../../packages/contracts/src/index.ts";
import {
  InMemoryPlatformState,
  type PlatformStateStore,
} from "../../packages/occ/src/state/platform-state.ts";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { PRESET_NAME_CONFLICT } from "../helpers/refusal-text.mjs";
import { startController, request } from "../helpers/postgres-platform-state.ts";

const identifier = (kind: string) => `${kind}_${randomUUID()}`;

async function exercisePresets(store: PlatformStateStore, reopened = store) {
  const createdAt = new Date().toISOString();
  const namespace: Namespace = {
    id: identifier("ns"),
    name: `Presets ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const otherNamespace: Namespace = {
    ...namespace,
    id: identifier("ns"),
    name: `${namespace.name} other`,
  };
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
  const preset: Preset = {
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
  assert.ok(copy);
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
  // A duplicate name names the taken kind; only server-chosen identity collisions stay generic.
  const presetNameConflict = {
    name: "ResourceStateConflictError",
    message: PRESET_NAME_CONFLICT,
  };
  const refused = contenders.find((result) => result.status === "rejected");
  assert.ok(refused);
  const error: unknown = refused.reason;
  assert.ok(error instanceof Error);
  const { name, message } = error;
  assert.deepEqual({ name, message }, presetNameConflict);
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
    presetNameConflict,
  );
  assert.deepEqual(
    await reopened.read((state) => state.presets.findPreset(namespace.id, preset.id)),
    preset,
  );
  const renamed = await store.transact((state) =>
    state.presets.updatePreset(namespace.id, preset.id, { name: "Renamed" }),
  );
  assert.ok(renamed);
  assert.deepEqual(renamed.template, preset.template);
  const updated = await store.transact((state) =>
    state.presets.updatePreset(namespace.id, preset.id, { template: {} }),
  );
  assert.ok(updated);
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
  "shipped Preset API preserves contract-sized templates through PostgreSQL",
  requiresPostgres,
  async (context) => {
    assert.ok(databaseUrl);
    const api = await startController(context);
    const { PostgresPlatformState } =
      await import("../../packages/occ/src/state/postgres-state.ts");
    const pool = testPool(context, { connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    const namespace: Namespace = {
      id: identifier("ns"),
      name: `Preset HTTP fixture ${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    // Storage fixtures isolate HTTP/template persistence from Compute provisioning.
    await state.transact((store) => store.namespaces.createNamespace(namespace));
    const content = (
      "# Workspace guidance\n" + "Routine fixture instructions.\n".repeat(600)
    ).slice(0, 16 * 1024);
    const template = {
      agent: {
        initialWorkspaceFiles: Object.fromEntries(
          ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"].map((name) => [name, content]),
        ),
      },
    };
    const path = `/namespaces/${namespace.id}/presets`;
    const created = await request<PresetResponse["data"]>(api, "POST", path, {
      name: "Full workspace",
      template,
    });
    assert.equal(created.status, 201, JSON.stringify(created.error));
    const replacement = await request<PresetResponse["data"]>(api, "POST", path, {
      name: "Replacement",
      template: {},
    });
    assert.equal(replacement.status, 201);
    const updated = await request(api, "PATCH", `${path}/${replacement.data.id}`, { template });
    assert.equal(updated.status, 200, JSON.stringify(updated.error));
    const readback = await request<PresetResponse["data"]>(
      api,
      "GET",
      `${path}/${replacement.data.id}`,
    );
    assert.equal(readback.status, 200);
    assert.deepEqual(readback.data.template, template);
    const persisted = await state.read((store) =>
      store.presets.findPreset(namespace.id, created.data.id),
    );
    assert.ok(persisted);
    assert.deepEqual(persisted.template, template);
  },
);

test(
  "PostgreSQL Presets survive reopening and enforce names, ownership, and Namespace deletion",
  requiresPostgres,
  async (context) => {
    assert.ok(databaseUrl);
    const { PostgresPlatformState } =
      await import("../../packages/occ/src/state/postgres-state.ts");
    const pool = testPool(context, { connectionString: databaseUrl });
    const secondPool = testPool(context, { connectionString: databaseUrl });
    const { preset, otherNamespace } = await exercisePresets(
      new PostgresPlatformState(pool),
      new PostgresPlatformState(secondPool),
    );
    const stored = (
      await pool.query<{ id: string }>("SELECT id FROM occ.presets WHERE namespace_id = $1", [
        otherNamespace.id,
      ])
    ).rows[0];
    assert.ok(stored);
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
