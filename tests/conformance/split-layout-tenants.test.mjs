import assert from "node:assert/strict";
import test from "node:test";
import { PERMISSION_ACTIONS, RESOURCE_KINDS } from "../../packages/contracts/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  createTenantReaderFixture,
  tenantRequest as request,
} from "../helpers/tenant-reader-app.mjs";
import {
  BUNDLE_FORMAT,
  checkImport,
  createOccApi,
  currentHarnessAuth,
  discardTenants,
  exportTenants,
  importTenants,
  remap,
} from "../../scripts/split-layout-tenants.mjs";

const installationId = "ins_5633697e-6397-4cc6-9b04-8ec17af78cf1";
const noSleep = async () => {};

async function createFixture() {
  const fixture = await createTenantReaderFixture({
    installationId,
    label: "split-layout-tenants",
    administratorName: "Split layout administrator",
    readerName: "Split layout reader",
    administratorPermissions: RESOURCE_KINDS.flatMap((resourceKind) =>
      PERMISSION_ACTIONS.map((action) => ({ action, resourceKind })),
    ),
    computeDriver: createReadyComputeDriver("compute-split-layout-tenants"),
    secretDriver: createTestSecretDriver(),
  });
  const bootstrap = await request(fixture.app, "/installation/bootstrap", {
    body: { name: "Split layout test installation" },
  });
  assert.equal(bootstrap.response.status, 201);
  // The script's own transport, sent to the real app as the signed-in administrator.
  fixture.api = createOccApi({
    baseUrl: "http://127.0.0.1",
    fetchImpl: (url, init) =>
      fixture.app.fetch(
        new Request(url, {
          ...init,
          headers: authenticatedHeaders(fixture.app.defaultSession, init.headers),
        }),
      ),
  });
  return fixture;
}

async function created(fixture, pathname, body) {
  const result = await request(fixture.app, pathname, { body });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload.error));
  return result.payload.data;
}

async function markReady(fixture, namespaceId) {
  await fixture.controller.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
  );
}

async function seedTenant(fixture) {
  const namespace = await created(fixture, "/namespaces", { name: "team-a" });
  await markReady(fixture, namespace.id);
  const base = `/namespaces/${namespace.id}`;
  const secret = await created(fixture, `${base}/secrets`, {
    name: "model-key",
    value: "old-value",
  });
  const configuration = await created(fixture, `${base}/configurations`, {
    kind: "agent",
    values: { model: "example-model" },
    secretBindings: {
      MODEL_API_KEY: { source: { kind: "secret", namespaceId: namespace.id, id: secret.id } },
    },
  });
  const agent = await created(fixture, `${base}/agents`, {
    name: "a1",
    configurationId: configuration.id,
  });
  const role = await created(fixture, `${base}/iam/roles`, {
    name: "agent readers",
    permissions: [{ action: "read", resourceKind: "configuration" }],
  });
  // An Agent's own ServicePrincipal, which the import must map to the new Agent's.
  const binding = await created(fixture, `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "configuration",
    resourceId: configuration.id,
  });
  return { namespace, secret, configuration, agent, role, binding };
}

test("export reads every tenant resource the import needs, without Secret values", async () => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  const bundle = await exportTenants(fixture.api);
  assert.equal(bundle.format, BUNDLE_FORMAT);
  const tenant = bundle.namespaces.find(({ name }) => name === "team-a");
  assert.equal(tenant.id, seeded.namespace.id);
  assert.deepEqual(tenant.secrets, [{ id: seeded.secret.id, name: "model-key" }]);
  assert.doesNotMatch(JSON.stringify(bundle), /old-value/u);
  assert.deepEqual(
    tenant.configurations.map(({ id, secretBindings }) => ({ id, secretBindings })),
    [{ id: seeded.configuration.id, secretBindings: seeded.configuration.secretBindings }],
  );
  assert.deepEqual(
    tenant.agents.map(({ id, configurationId }) => ({ id, configurationId })),
    [{ id: seeded.agent.id, configurationId: seeded.configuration.id }],
  );
  assert.deepEqual(
    tenant.roles.map(({ id }) => id),
    [seeded.role.id],
  );
  assert.ok(tenant.accessBindings.some(({ id }) => id === seeded.binding.id));
});

test("import re-creates tenants under new IDs, waits for readiness, and resumes", async () => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  const bundle = await exportTenants(fixture.api);
  const others = bundle.namespaces.map(({ name }) => name).filter((name) => name !== "team-a");
  assert.ok(others.length > 0, "bootstrap's default Namespace is in the bundle too");
  // A deleted Namespace's name stays reserved, so the copy is renamed; the rest are skipped.
  const names = { "team-a": "team-a restored" };
  const scope = { names, skip: others };
  assert.deepEqual(checkImport(bundle, {}), ["no value for Secret team-a/model-key"]);
  await assert.rejects(importTenants(fixture.api, bundle, {}, scope), /no value for Secret/u);
  const values = { "team-a": { "model-key": "new-value" } };
  let saved;
  const options = {
    ...scope,
    save: (state) => (saved = structuredClone(state)),
    sleep: noSleep,
    intervalMs: 0,
    readyTimeoutMs: 0,
  };
  const first = await importTenants(fixture.api, bundle, values, options);
  assert.equal(first.complete, false);
  const namespaceId = saved.ids[seeded.namespace.id];
  assert.match(namespaceId, /^ns_/u);
  assert.notEqual(namespaceId, seeded.namespace.id);
  assert.deepEqual(first.pendingNamespaces, [`team-a restored (${namespaceId})`]);

  await markReady(fixture, namespaceId);
  // An earlier run created this Secret but stopped before saving its ID.
  const interrupted = await created(fixture, `/namespaces/${namespaceId}/secrets`, {
    name: "model-key",
    value: "new-value",
  });
  const second = await importTenants(fixture.api, bundle, values, { ...options, state: saved });
  assert.equal(second.complete, true);
  const namespaces = (await request(fixture.app, "/namespaces")).payload.data;
  assert.equal(namespaces.filter(({ name }) => name === "team-a restored").length, 1);

  const base = `/namespaces/${namespaceId}`;
  const secrets = (await request(fixture.app, `${base}/secrets`)).payload.data;
  assert.deepEqual(
    secrets.map(({ id, name }) => ({ id, name })),
    [{ id: interrupted.id, name: "model-key" }],
  );
  const configuration = (
    await request(fixture.app, `${base}/configurations/${saved.ids[seeded.configuration.id]}`)
  ).payload.data;
  assert.deepEqual(configuration.values, { model: "example-model" });
  assert.deepEqual(configuration.secretBindings.MODEL_API_KEY.source, {
    kind: "secret",
    namespaceId,
    id: saved.ids[seeded.secret.id],
  });
  const agent = (await request(fixture.app, `${base}/agents/${saved.ids[seeded.agent.id]}`)).payload
    .data;
  assert.equal(agent.name, "a1");
  assert.equal(agent.configurationId, configuration.id);
  assert.notEqual(agent.servicePrincipalId, seeded.agent.servicePrincipalId);
  const bindings = (await request(fixture.app, `${base}/iam/access-bindings`)).payload.data;
  assert.ok(
    bindings.some(
      (binding) =>
        binding.subjectId === agent.servicePrincipalId &&
        binding.roleId === saved.ids[seeded.role.id] &&
        binding.resourceId === configuration.id,
    ),
  );

  // A third run creates nothing new.
  const before = JSON.stringify(saved.ids);
  const third = await importTenants(fixture.api, bundle, values, { ...options, state: saved });
  assert.equal(third.complete, true);
  assert.equal(JSON.stringify(saved.ids), before);
  assert.equal((await request(fixture.app, `${base}/agents`)).payload.data.length, 1);

  // A run that stopped after creating the Agent, before saving its principal or binding.
  const bindingCount = bindings.length;
  const resumed = structuredClone(saved);
  delete resumed.ids[seeded.agent.servicePrincipalId];
  delete resumed.ids[seeded.binding.id];
  const fourth = await importTenants(fixture.api, bundle, values, { ...options, state: resumed });
  assert.deepEqual(fourth.skippedBindings, []);
  assert.equal(resumed.ids[seeded.agent.servicePrincipalId], agent.servicePrincipalId);
  assert.ok(bindings.some(({ id }) => id === resumed.ids[seeded.binding.id]));
  assert.equal(
    (await request(fixture.app, `${base}/iam/access-bindings`)).payload.data.length,
    bindingCount,
  );

  // Renaming onto a populated live Namespace is refused instead of merging into it.
  await assert.rejects(
    importTenants(fixture.api, bundle, values, {
      ...options,
      state: { ids: {}, deployed: [] },
      names: { "team-a": "team-a restored" },
    }),
    /Namespace team-a restored already exists and holds Agents or Secrets; add --rename/u,
  );
});

test("discard refuses a stale bundle or one missing workspace files, before deleting", async () => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  const bundle = await exportTenants(fixture.api);
  // This app has no Gateway to read workspace files from, as for a stopped Agent.
  const exported = bundle.namespaces.find(({ name }) => name === "team-a");
  assert.equal(exported.agents[0].unreadWorkspaceFiles.length, 4);
  const discard = (options = {}) =>
    discardTenants(fixture.api, bundle, { sleep: noSleep, intervalMs: 0, ...options });
  await assert.rejects(
    discard(),
    /lacks workspace files of team-a\/a1; deploy those Agents and export again/u,
  );
  await created(fixture, `/namespaces/${seeded.namespace.id}/secrets`, {
    name: "late",
    value: "x",
  });
  await assert.rejects(
    discard({ allowUnreadWorkspaceFiles: true }),
    /team-a has resources the bundle lacks .*export again/u,
  );
  const agents = (await request(fixture.app, `/namespaces/${seeded.namespace.id}/agents`)).payload
    .data;
  assert.equal(agents.length, 1);
  const secrets = (await request(fixture.app, `/namespaces/${seeded.namespace.id}/secrets`)).payload
    .data;
  assert.equal(secrets.length, 2);
});

test("remap replaces exact IDs only, and the retired ChatGPT method becomes a service-account PAT", () => {
  const ids = new Map([
    ["ns_old", "ns_new"],
    ["sa_old", "sa_new"],
  ]);
  assert.deepEqual(remap({ a: ["ns_old", "ns_old-suffix"], b: { c: "sa_old" }, d: 1 }, ids), {
    a: ["ns_new", "ns_old-suffix"],
    b: { c: "sa_new" },
    d: 1,
  });
  assert.deepEqual(
    remap(
      currentHarnessAuth(
        { method: "chatgpt_service_account", serviceAccountId: "sa_old" },
        "ns_old",
      ),
      ids,
    ),
    {
      method: "codex_pat",
      source: { kind: "service_account", namespaceId: "ns_new", id: "sa_new" },
    },
  );
  const runtime = { method: "runtime" };
  assert.equal(currentHarnessAuth(runtime, "ns_old"), runtime);
});
