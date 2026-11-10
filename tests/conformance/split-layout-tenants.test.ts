import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { OpenClawController, type PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PERMISSION_ACTIONS, RESOURCE_KINDS } from "../../packages/contracts/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { listen } from "../helpers/listen.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { temporaryDirectorySync } from "../helpers/temporary-directory.mjs";
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
  main,
  remap,
} from "../../scripts/split-layout-tenants.ts";

type BaseFixture = Awaited<ReturnType<typeof createTenantReaderFixture>>;
type Fixture = BaseFixture & {
  api: ReturnType<typeof createOccApi>;
  controller: OpenClawController;
};
type SavedState = { ids: Record<string, string>; deployed: string[] };
type CreatedResource = Record<string, unknown> & { id: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function hasStringId(value: Record<string, unknown>): value is CreatedResource {
  return typeof value.id === "string";
}

function createdResource(value: unknown): CreatedResource {
  const result = object(value);
  assert.ok(hasStringId(result));
  return result;
}

function resources(value: unknown): CreatedResource[] {
  assert.ok(Array.isArray(value));
  return value.map((item: unknown) => createdResource(item));
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

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
  const api = createOccApi({
    baseUrl: "https://console.oce.localhost",
    fetchImpl: asAdministrator(fixture),
  });
  const controller: unknown = fixture.controller;
  assert.ok(controller instanceof OpenClawController);
  return { ...fixture, api, controller };
}

/** A fetch function that sends each request to the fixture's real app as its administrator. */
function asAdministrator(fixture: BaseFixture) {
  return (url: string, init: RequestInit) =>
    fixture.app.fetch(
      new Request(url, {
        ...init,
        headers: authenticatedHeaders(fixture.session(fixture.administrator), init.headers),
      }),
    );
}

async function created(
  fixture: Fixture,
  pathname: string,
  body: unknown,
): Promise<CreatedResource> {
  const result = await request(fixture.app, pathname, { body });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload.error));
  return createdResource(result.payload.data);
}

async function markReady(fixture: Fixture, namespaceId: string) {
  await fixture.controller.transact((unit: PlatformUnitOfWork) =>
    unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
  );
}

async function seedTenant(fixture: Fixture) {
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
  const createdAgent = await created(fixture, `${base}/agents`, {
    name: "a1",
    configurationId: configuration.id,
  });
  const agent = { ...createdAgent, servicePrincipalId: string(createdAgent.servicePrincipalId) };
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
  assert.ok(tenant);
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

  // Damage the real collection response after its successful HTTP status. A
  // missing envelope must stop export, not become an empty Namespace inventory.
  for (const damage of ["malformed", "empty", "missing-data"]) {
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      async fetchImpl(url, init) {
        const response = await asAdministrator(fixture)(url, init);
        assert.equal(response.status, 200);
        const text = await response.text();
        const payload = object(JSON.parse(text) as unknown);
        assert.ok(resources(payload.data).some(({ id }) => id === seeded.namespace.id));
        delete payload.data;
        const damaged =
          damage === "malformed"
            ? text.slice(0, -1)
            : damage === "empty"
              ? ""
              : JSON.stringify(payload);
        return new Response(damaged, { status: response.status });
      },
    });
    await assert.rejects(
      exportTenants(api),
      /GET \/namespaces: HTTP 200 returned no data envelope/u,
      damage,
    );
  }

  // OCC can return Agent metadata while its saved settings are unreadable. That
  // documented response must not become a bundle that silently drops bindings.
  const unreadableApi = createOccApi({
    baseUrl: "https://console.oce.localhost",
    async fetchImpl(url, init) {
      const response = await asAdministrator(fixture)(url, init);
      if (
        new URL(url).pathname !== `/namespaces/${seeded.namespace.id}/agents/${seeded.agent.id}`
      ) {
        return response;
      }
      assert.equal(response.status, 200);
      const payload = object((await response.json()) as unknown);
      const metadata = object(payload.data);
      for (const field of [
        "pluginDriver",
        "plugins",
        "pluginApprovers",
        "repositoryBindings",
        "repositoryAccess",
        "harnessAuth",
        "credentialSources",
      ]) {
        delete metadata[field];
      }
      metadata.configurationReadError = {
        code: "SAVED_CONFIGURATION_UNREADABLE",
        field: "plugins",
      };
      return Response.json({ ...payload, data: metadata }, { status: 200 });
    },
  });
  await assert.rejects(
    exportTenants(unreadableApi),
    /saved configuration is unreadable.*Keep the original bundle and map/u,
  );
  const incompleteConfigurationApi = createOccApi({
    baseUrl: "https://console.oce.localhost",
    async fetchImpl(url, init) {
      const response = await asAdministrator(fixture)(url, init);
      if (
        new URL(url).pathname !==
        `/namespaces/${seeded.namespace.id}/configurations/${seeded.configuration.id}`
      ) {
        return response;
      }
      const payload = object((await response.json()) as unknown);
      delete object(payload.data).values;
      return Response.json(payload, { status: response.status });
    },
  });
  await assert.rejects(exportTenants(incompleteConfigurationApi), /configurations\[\]\.values/u);

  // An old incomplete bundle must also stop before either destructive operation
  // or destination import makes its first request.
  for (const field of ["agents", "configurations"] as const) {
    const incomplete = structuredClone(bundle);
    const selected = incomplete.namespaces.find(({ id }) => id === seeded.namespace.id)!;
    if (field === "agents") {
      selected.agents[0]!.configurationReadError = {
        code: "SAVED_CONFIGURATION_UNREADABLE",
        field: "plugins",
      };
    } else {
      delete selected.configurations[0]!.values;
    }
    let calls = 0;
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      fetchImpl(url, init) {
        calls += 1;
        return asAdministrator(fixture)(url, init);
      },
    });
    await assert.rejects(discardTenants(api, incomplete), /unreadable|configurations\[\]\.values/u);
    await assert.rejects(
      importTenants(api, incomplete, { "team-a": { "model-key": "synthetic-value" } }),
      /unreadable|configurations\[\]\.values/u,
    );
    assert.equal(calls, 0);
  }

  const invalidPermissions: unknown[] = [
    undefined,
    null,
    [],
    [null],
    [{ action: "read" }],
    [{ resourceKind: "configuration" }],
    [{ action: 42, resourceKind: "configuration" }],
    [{ action: "read", resourceKind: 42 }],
    [{ action: "", resourceKind: "configuration" }],
    [{ action: "read", resourceKind: " " }],
    Array.from({ length: 65 }, () => ({ action: "read", resourceKind: "configuration" })),
  ];
  const sourceId = "cs_00000000-0000-4000-8000-000000000001";
  // This fixture selects no Credential Gateway. The source is a local bundle
  // record shaped by CredentialSourceSchema, not proof of source registration.
  const offlineSource = {
    id: sourceId,
    namespaceId: seeded.namespace.id,
    name: "model-account",
    type: "openai",
    ownerCapability: "credential_gateway",
    config: {},
    secrets: {
      api_key: { kind: "secret", namespaceId: seeded.namespace.id, id: seeded.secret.id },
    },
    state: "ready",
    ref: { kind: "credential_source", namespaceId: seeded.namespace.id, id: sourceId },
  };
  const incompleteFields = [
    ...invalidPermissions.map((value) => ({
      field: "roles" as const,
      property: "permissions",
      value,
      diagnostic: /roles\[\]\.permissions/u,
    })),
    ...[undefined, null, 42, "", " "].map((value) => ({
      field: "credentialSources" as const,
      property: "type",
      value,
      diagnostic: /credentialSources\[\]\.type/u,
    })),
    ...[
      { property: "subjectKind", value: undefined },
      { property: "subjectId", value: null },
      { property: "roleId", value: 42 },
      { property: "resourceId", value: "" },
      // The wire contract counts Unicode code points, not UTF-16 code units.
      ...["subjectId", "roleId", "resourceId"].flatMap((property) =>
        ["x".repeat(201), "😀".repeat(201), "bad\u0000id", "bad\ud800id"].map((value) => ({
          property,
          value,
        })),
      ),
    ].map(({ property, value }) => ({
      field: "accessBindings" as const,
      property,
      value,
      diagnostic: /accessBindings\[\]\.(subjectKind|subjectId|roleId|resourceId)/u,
    })),
  ];
  for (const { field, property, value, diagnostic } of incompleteFields) {
    const incomplete = structuredClone(bundle);
    const selected = incomplete.namespaces.find(({ id }) => id === seeded.namespace.id)!;
    if (field === "credentialSources") {
      selected.credentialSources = [structuredClone(offlineSource)];
    }
    const record = selected[field][0]!;
    if (value === undefined) {
      delete record[property];
    } else {
      record[property] = value;
    }

    if (field === "roles" || field === "accessBindings") {
      // Preserve the real policy resource ID while damaging only required fields
      // in the successful HTTP response. Export must not publish this bundle.
      const resourcePath = field === "roles" ? "roles" : "access-bindings";
      const api = createOccApi({
        baseUrl: "https://console.oce.localhost",
        async fetchImpl(url, init) {
          assert.equal(init.method, "GET");
          const response = await asAdministrator(fixture)(url, init);
          if (new URL(url).pathname !== `/namespaces/${seeded.namespace.id}/iam/${resourcePath}`) {
            return response;
          }
          assert.equal(response.status, 200);
          const payload = object((await response.json()) as unknown);
          const roles = resources(payload.data);
          assert.ok(roles.some(({ id }) => id === record.id));
          return Response.json(
            {
              ...payload,
              data: roles.map((role) => (role.id === record.id ? record : role)),
            },
            { status: 200 },
          );
        },
      });
      await assert.rejects(exportTenants(api), diagnostic);
    }

    // A saved bundle must fail before touching the old tenant or attempting
    // any destination writes, even when unread workspace files are accepted.
    let calls = 0;
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      fetchImpl(url, init) {
        calls += 1;
        return asAdministrator(fixture)(url, init);
      },
    });
    await assert.rejects(
      discardTenants(api, incomplete, {
        allowUnreadWorkspaceFiles: true,
        timeoutMs: 0,
        intervalMs: 0,
        sleep: noSleep,
      }),
      diagnostic,
    );
    await assert.rejects(
      importTenants(api, incomplete, {
        "team-a": { "model-key": "synthetic-value" },
      }),
      diagnostic,
    );
    assert.equal(calls, 0);
  }

  // These are valid wire-contract bundle inputs; NativeIAM need not generate these IDs.
  for (const opaqueId of [" ", "😀".repeat(200), "percent%2e/slash?#\\name"]) {
    const compatible = structuredClone(bundle);
    const tenant = compatible.namespaces.find(({ id }) => id === seeded.namespace.id)!;
    const role = tenant.roles[0]!;
    const binding = tenant.accessBindings.find(({ id }) => id === seeded.binding.id)!;
    const agent = tenant.agents.find(({ id }) => id === seeded.agent.id)!;
    role.id = opaqueId;
    binding.roleId = opaqueId;
    binding.subjectId = agent.servicePrincipalId;
    binding.resourceId = opaqueId;
    assert.deepEqual(checkImport(compatible, { "team-a": { "model-key": "synthetic" } }), []);
  }

  // Empty successful deletes and accepted missing resources are valid on the
  // same API; they must not acquire the collection response requirement.
  const base = `/namespaces/${seeded.namespace.id}`;
  assert.equal(
    (
      await fixture.api.expect(
        "DELETE",
        `${base}/iam/access-bindings/${seeded.binding.id}`,
        undefined,
        [204],
      )
    ).status,
    204,
  );
  assert.equal(
    (await fixture.api.expect("DELETE", `${base}/iam/roles/${seeded.role.id}`, undefined, [204]))
      .status,
    204,
  );
  assert.equal(
    (await fixture.api.expect("DELETE", `${base}/iam/roles/${seeded.role.id}`, undefined, [404]))
      .status,
    404,
  );
});

test("import re-creates tenants under new IDs, waits for readiness, and resumes", async () => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  const account = await created(fixture, `/namespaces/${seeded.namespace.id}/service-accounts`, {
    name: "managed-harness",
  });
  const preset = await created(fixture, `/namespaces/${seeded.namespace.id}/presets`, {
    name: "managed-harness-preset",
    template: {
      agent: {
        harnessAuth: {
          method: "codex_pat",
          source: { kind: "service_account", namespaceId: seeded.namespace.id, id: account.id },
        },
      },
    },
  });
  const legacyPreset = await created(fixture, `/namespaces/${seeded.namespace.id}/presets`, {
    name: "released-managed-harness-preset",
    template: preset.template,
  });
  const bundle = await exportTenants(fixture.api);
  // The released bundle used this retired spelling; the importer upgrades it to codex_pat.
  const legacyPresetResource = bundle.namespaces
    .find(({ id }) => id === seeded.namespace.id)
    ?.presets.find(({ id }) => id === legacyPreset.id);
  assert.ok(legacyPresetResource);
  const legacyTemplate = object(object(legacyPresetResource.template).agent);
  legacyTemplate.harnessAuth = {
    method: "chatgpt_service_account",
    serviceAccountId: account.id,
  };
  const others = bundle.namespaces.map(({ name }) => name).filter((name) => name !== "team-a");
  assert.ok(others.length > 0, "bootstrap's default Namespace is in the bundle too");
  // A deleted Namespace's name stays reserved, so the copy is renamed; the rest are skipped.
  const names = { "team-a": "team-a restored" };
  const scope = { names, skip: others };
  assert.deepEqual(checkImport(bundle, {}), ["no value for Secret team-a/model-key"]);
  await assert.rejects(importTenants(fixture.api, bundle, {}, scope), /no value for Secret/u);
  const values = { "team-a": { "model-key": "new-value" } };
  let saved: SavedState = { ids: {}, deployed: [] };
  const options = {
    ...scope,
    save: (state: unknown) => {
      const snapshot = object(structuredClone(state));
      const ids = Object.fromEntries(
        Object.entries(object(snapshot.ids)).map(([id, value]) => [id, string(value)]),
      );
      assert.ok(Array.isArray(snapshot.deployed));
      saved = { ids, deployed: snapshot.deployed.map((value: unknown) => string(value)) };
    },
    sleep: noSleep,
    intervalMs: 0,
    readyTimeoutMs: 0,
  };
  const first = await importTenants(fixture.api, bundle, values, options);
  assert.equal(first.complete, false);
  const namespaceId = saved.ids[seeded.namespace.id];
  assert.ok(namespaceId);
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
  const namespaces = resources((await request(fixture.app, "/namespaces")).payload.data);
  assert.equal(namespaces.filter(({ name }) => name === "team-a restored").length, 1);

  const base = `/namespaces/${namespaceId}`;
  const secrets = resources((await request(fixture.app, `${base}/secrets`)).payload.data);
  assert.deepEqual(
    secrets.map(({ id, name }) => ({ id, name })),
    [{ id: interrupted.id, name: "model-key" }],
  );
  const configuration = createdResource(
    (await request(fixture.app, `${base}/configurations/${saved.ids[seeded.configuration.id]}`))
      .payload.data,
  );
  assert.deepEqual(configuration.values, { model: "example-model" });
  assert.deepEqual(object(object(configuration.secretBindings).MODEL_API_KEY).source, {
    kind: "secret",
    namespaceId,
    id: saved.ids[seeded.secret.id],
  });
  const agent = createdResource(
    (await request(fixture.app, `${base}/agents/${saved.ids[seeded.agent.id]}`)).payload.data,
  );
  assert.equal(agent.name, "a1");
  assert.equal(agent.configurationId, configuration.id);
  assert.notEqual(agent.servicePrincipalId, seeded.agent.servicePrincipalId);
  const bindings = resources(
    (await request(fixture.app, `${base}/iam/access-bindings`)).payload.data,
  );
  assert.ok(
    bindings.some(
      (binding) =>
        binding.subjectId === agent.servicePrincipalId &&
        binding.roleId === saved.ids[seeded.role.id] &&
        binding.resourceId === configuration.id,
    ),
  );

  for (const original of [preset, legacyPreset]) {
    const restored = createdResource(
      (await request(fixture.app, `${base}/presets/${saved.ids[original.id]}`)).payload.data,
    );
    assert.deepEqual(object(object(restored.template).agent).harnessAuth, {
      method: "codex_pat",
      source: { kind: "service_account", namespaceId, id: saved.ids[account.id] },
    });
  }
  assert.notEqual(saved.ids[account.id], account.id);
  assert.equal(
    (await request(fixture.app, `${base}/service-accounts/${saved.ids[account.id]}`)).response
      .status,
    200,
  );
  assert.equal(
    (await request(fixture.app, `${base}/service-accounts/${account.id}`)).response.status,
    404,
  );

  // A third run creates nothing new.
  const before = JSON.stringify(saved.ids);
  const third = await importTenants(fixture.api, bundle, values, { ...options, state: saved });
  assert.equal(third.complete, true);
  assert.equal(JSON.stringify(saved.ids), before);
  assert.equal((await request(fixture.app, `${base}/agents`)).payload.data.length, 1);

  assert.equal((await request(fixture.app, `${base}/service-accounts`)).payload.data.length, 1);
  for (const original of [preset, legacyPreset]) {
    const restored = createdResource(
      (await request(fixture.app, `${base}/presets/${saved.ids[original.id]}`)).payload.data,
    );
    assert.equal(
      object(object(object(object(restored.template).agent).harnessAuth).source).id,
      saved.ids[account.id],
    );
  }

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

  // Released forms belong only in the bundle; the live grant inventory must not grow.
  const resourceLess: CreatedResource = { ...seeded.binding, id: "legacy-resource-less" };
  delete resourceLess.resourceKind;
  delete resourceLess.resourceId;
  const manual = [
    { ...seeded.binding, id: "legacy-group", subjectKind: "group" },
    {
      ...seeded.binding,
      id: "legacy-installation",
      resourceKind: "installation",
      resourceId: installationId,
    },
    resourceLess,
  ];
  const revisions = ["identity", "group", "service_account"].map((subjectKind) => ({
    ...seeded.binding,
    id: `legacy-revision-${subjectKind}`,
    subjectKind,
    resourceKind: "agent_revision",
    resourceId: "old-revision",
  }));
  const legacy = structuredClone(bundle);
  const legacyTenant = legacy.namespaces.find(({ id }) => id === seeded.namespace.id);
  assert.ok(legacyTenant);
  legacyTenant.accessBindings = [seeded.binding, ...manual, ...revisions];
  const state = structuredClone(saved);
  const messages: string[] = [];
  const beforeLegacy = resources(
    (await fixture.api.expect("GET", `${base}/iam/access-bindings`)).data,
  );
  const result = await importTenants(fixture.api, legacy, values, {
    ...options,
    state,
    save: () => {},
    log: (message) => messages.push(message),
  });
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.skippedBindings.map((entry) => entry.split(":")[0]),
    manual.map(({ id }) => `team-a/${id}`),
  );
  const revisionLogs = messages.filter((message) => message.includes("legacy-"));
  assert.equal(revisionLogs.length, revisions.length);
  for (const { id } of revisions) {
    assert.ok(
      revisionLogs.some((message) => message.includes(id)),
      id,
    );
  }
  assert.deepEqual(state, saved);
  assert.ok(beforeLegacy.some(({ id }) => id === state.ids[seeded.binding.id]));
  assert.deepEqual(
    (await fixture.api.expect("GET", `${base}/iam/access-bindings`)).data,
    beforeLegacy,
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

  // Simulate an accepted deploy with a lost response envelope at the importer's HTTP
  // boundary. This checks the resume state without starting a runtime.
  const rollout = structuredClone(bundle);
  const rolloutAgent = rollout.namespaces
    .find(({ id }) => id === seeded.namespace.id)
    ?.agents.find(({ id }) => id === seeded.agent.id);
  assert.ok(rolloutAgent);
  rolloutAgent.desiredRuntimeState = "running";
  const deployPath = `${base}/agents/${saved.ids[seeded.agent.id]}/deploy`;
  const damagedDeploys = [
    { status: 202, body: {}, diagnostic: "HTTP 202 returned no data envelope." },
    {
      status: 200,
      body: { data: { id: seeded.agent.id } },
      diagnostic: "ambiguous HTTP 200 response.",
    },
    {
      status: 202,
      body: {
        data: { id: seeded.agent.id, namespaceId: saved.ids[seeded.namespace.id] },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
      },
      diagnostic: "invalid OCC response id: invalid resource ID.",
    },
    {
      status: 202,
      body: {
        data: {
          id: "rev_00000000-0000-4000-8000-000000000001",
          namespaceId: saved.ids[seeded.namespace.id],
          agentId: seeded.agent.id,
          revision: 1,
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
      },
      diagnostic: "returned resource identity does not match the request.",
    },
  ];
  for (const damaged of damagedDeploys) {
    let deployRequests = 0;
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      async fetchImpl(url, init) {
        if (init.method === "POST" && new URL(url).pathname === deployPath) {
          deployRequests += 1;
          return Response.json(damaged.body, { status: damaged.status });
        }
        return asAdministrator(fixture)(url, init);
      },
    });
    const deployState = structuredClone(saved);
    await assert.rejects(importTenants(api, rollout, values, { ...options, state: deployState }), {
      message:
        `POST ${deployPath}: ${damaged.diagnostic} ` +
        "Keep the original bundle and map, if present. Correct the OCC endpoint and reconcile " +
        "any earlier writes before resuming the original operation.",
    });
    assert.equal(deployRequests, 1);
    assert.deepEqual(deployState, saved);
  }
});

test("export command reports an invalid Namespace response without writing a bundle", async (t) => {
  const directory = temporaryDirectorySync(t, "split-layout-tenants-");
  const keyFile = join(directory, "key.json");
  const output = join(directory, "bundle.json");
  const key = "service-key-from-file";
  writeFileSync(keyFile, JSON.stringify({ data: { key } }));

  // A successful HTTP status can still carry invalid inventory from a misconfigured endpoint.
  const requests: [string | undefined, string | undefined, string | string[] | undefined][] = [];
  const server = createServer((request, response) => {
    requests.push([request.method, request.url, request.headers["x-api-key"]]);
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        data: [null],
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
      }),
    );
  });
  await listen(t, server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const command = fileURLToPath(new URL("../../scripts/split-layout-tenants.ts", import.meta.url));
  await assert.rejects(
    promisify(execFile)(process.execPath, [command, "export", "--out", output], {
      env: {
        ...process.env,
        OCC_URL: `http://127.0.0.1:${address.port}`,
        OCC_SERVICE_KEY_FILE: keyFile,
      },
    }),
    {
      code: 1,
      stderr:
        "GET /namespaces: invalid OCC collection response; expected an object in data[0]. " +
        "Keep the original bundle and map, if present. Correct the OCC endpoint and reconcile " +
        "any earlier writes before resuming the original operation.\n",
    },
  );
  assert.deepEqual(requests, [["GET", "/namespaces", key]]);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.partial`), false);
});

test("import command exits 4 while bindings need manual recovery, again on rerun", async (t) => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  const exported = await exportTenants(fixture.api);
  const directory = temporaryDirectorySync(t, "split-layout-tenants-");
  const key = "service-key-from-file";
  writeFileSync(join(directory, "key.json"), JSON.stringify({ data: { key } }));
  writeFileSync(join(directory, "values.json"), JSON.stringify({ "team-a": { "model-key": "v" } }));
  let malformedBindingBody: string | ((body: string) => string) | undefined;
  let malformedBindingStatus = 201;
  let bindingCreated: boolean;

  // A thin loopback adapter, not the production listener: it checks that the command sends
  // the service key from OCC_SERVICE_KEY_FILE, then forwards the request to the real app as
  // the signed-in administrator. It proves the command's exit codes and saved map only.
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request as AsyncIterable<unknown>) {
      assert.ok(chunk instanceof Uint8Array);
      chunks.push(chunk);
    }
    if (request.headers["x-api-key"] !== key) {
      response.writeHead(401).end();
      return;
    }
    const answer = await asAdministrator(fixture)(`https://console.oce.localhost${request.url}`, {
      ...(request.method === undefined ? {} : { method: request.method }),
      headers: request.headers["content-type"]
        ? { "content-type": request.headers["content-type"] }
        : {},
      ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
    });
    const body = await answer.text();
    if (
      malformedBindingBody !== undefined &&
      request.method === "POST" &&
      request.url?.endsWith("/iam/access-bindings") &&
      answer.status === 201
    ) {
      bindingCreated = true;
      response.writeHead(malformedBindingStatus, { "content-type": "application/json" });
      response.end(
        typeof malformedBindingBody === "function"
          ? malformedBindingBody(body)
          : malformedBindingBody,
      );
      return;
    }
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(body);
  });
  await listen(t, server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for (const [name, value] of Object.entries({
    OCC_URL: `http://127.0.0.1:${address.port}`,
    OCC_SERVICE_KEY_FILE: join(directory, "key.json"),
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() =>
      previous === undefined ? delete process.env[name] : (process.env[name] = previous),
    );
  }
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));

  const extras = {
    // Old Agent revisions are intentionally not carried over: logged, not reported.
    revision: { ...seeded.binding, id: "old-revision", resourceKind: "agent_revision" },
    // Only an operator can re-create a group grant.
    group: { ...seeded.binding, id: "group-grant", subjectKind: "group" },
    // A supported shape whose resource the import cannot map: the API refuses the create.
    refused: {
      ...seeded.binding,
      id: "refused-grant",
      resourceId: "cfg_00000000-0000-4000-8000-0000000000ff",
    },
  };
  type ExtraKind = keyof typeof extras;
  const run = async (name: string, extra: ExtraKind[]) => {
    const bundle = structuredClone(exported);
    bundle.namespaces = bundle.namespaces.filter(({ id }) => id === seeded.namespace.id);
    assert.ok(bundle.namespaces[0]);
    bundle.namespaces[0].accessBindings = [seeded.binding, ...extra.map((kind) => extras[kind])];
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(bundle));
    lines.length = 0;
    return main([
      "import",
      ...["--bundle", join(directory, `${name}.json`)],
      ...["--secret-values", join(directory, "values.json")],
      ...["--map", join(directory, `${name}-map.json`)],
      ...["--rename", `team-a=${name}`],
      "--no-deploy",
    ]);
  };
  const savedIds = (name: string) =>
    object(
      object(JSON.parse(readFileSync(join(directory, `${name}-map.json`), "utf8")) as unknown).ids,
    );

  const cases: [string, ExtraKind[], number][] = [
    ["clean", [], 0],
    // Exit 0 can still omit old Agent revision bindings; the guide says so.
    ["revision-only", ["revision"], 0],
    ["group", ["group"], 4],
    ["refused", ["refused"], 4],
  ];
  for (const [name, extra, code] of cases) {
    // An empty, ready destination stands in for one whose tenant RoleBindings were granted.
    await markReady(fixture, (await created(fixture, "/namespaces", { name })).id);
    assert.equal(await run(name, extra), code, `${name}: ${lines.join("\n")}`);
    assert.ok(savedIds(name)[seeded.binding.id], name);
    for (const kind of extra) {
      assert.equal(savedIds(name)[extras[kind].id], undefined, `${name}: ${kind}`);
    }
  }

  // Reported bindings are never saved, so a rerun lists them again and still exits 4, even
  // after the operator re-created them by hand.
  assert.equal(await run("group", ["group"]), 4);
  assert.ok(
    lines.some((line) => line.includes("access binding not re-created: team-a/group-grant: ")),
    lines.join("\n"),
  );

  // OCC created the binding. A lost response envelope leaves its saved ID unknown, so
  // the operator must reconcile it before resuming instead of treating it as rejected.
  const malformedCases = [
    ["missing-data", 201, "{}", "HTTP 201 returned no data envelope."],
    [
      "missing-id",
      201,
      (body: string) => JSON.stringify({ ...object(JSON.parse(body) as unknown), data: {} }),
      "invalid OCC response data; expected a nonempty string in id.",
    ],
    [
      "mixed-success-error",
      201,
      (body: string) =>
        JSON.stringify({
          ...object(JSON.parse(body) as unknown),
          error: { code: "FORBIDDEN", message: "Access denied." },
        }),
      "HTTP 201 returned an invalid success envelope.",
    ],
    [
      "success-without-request-id",
      201,
      (body: string) => JSON.stringify({ data: object(JSON.parse(body) as unknown).data }),
      "HTTP 201 returned an invalid success envelope.",
    ],
    ["gateway-error", 502, "null", "ambiguous HTTP 502 response."],
    ["unexpected-success", 204, "", "ambiguous HTTP 204 response."],
    ["malformed-refusal", 403, "null", "ambiguous HTTP 403 response."],
    ["wrong-success-status", 202, (body: string) => body, "ambiguous HTTP 202 response."],
    [
      "wrong-resource-owner",
      201,
      (body: string) => {
        const envelope = object(JSON.parse(body) as unknown);
        return JSON.stringify({
          ...envelope,
          data: { ...object(envelope.data), namespaceId: seeded.namespace.id },
        });
      },
      "returned resource identity does not match the request.",
    ],
    [
      "missing-request-id",
      403,
      JSON.stringify({ error: { code: "FORBIDDEN", message: "Access denied." } }),
      "ambiguous HTTP 403 response.",
    ],
    [
      "empty-error-message",
      403,
      (body: string) =>
        JSON.stringify({
          meta: object(JSON.parse(body) as unknown).meta,
          error: { code: "FORBIDDEN", message: "" },
        }),
      "ambiguous HTTP 403 response.",
    ],
    [
      "wrong-refusal-status",
      409,
      (body: string) =>
        JSON.stringify({
          meta: object(JSON.parse(body) as unknown).meta,
          error: { code: "FORBIDDEN", message: "Access denied." },
        }),
      "ambiguous HTTP 409 response.",
    ],
  ] as const;
  for (const [name, status, body, error] of malformedCases) {
    const destination = await created(fixture, "/namespaces", { name });
    await markReady(fixture, destination.id);
    malformedBindingBody = body;
    malformedBindingStatus = status;
    bindingCreated = false;
    await assert.rejects(run(name, []), {
      message:
        `POST /namespaces/${destination.id}/iam/access-bindings: ${error} ` +
        "Keep the original bundle and map, if present. Correct the OCC endpoint and reconcile " +
        "any earlier writes before resuming the original operation.",
    });
    assert.equal(bindingCreated, true);
    assert.equal(savedIds(name)[seeded.namespace.id], destination.id);
    assert.equal(savedIds(name)[seeded.binding.id], undefined);
  }
});

test("import refuses overlapping tenant destinations before changing the map or target", async () => {
  const fixture = await createFixture();
  const sources: CreatedResource[] = [];
  for (const name of ["source-a", "source-b"]) {
    const namespace = await created(fixture, "/namespaces", { name });
    await markReady(fixture, namespace.id);
    await created(fixture, `/namespaces/${namespace.id}/iam/roles`, {
      name: `${name} readers`,
      permissions: [{ action: "read", resourceKind: "configuration" }],
    });
    sources.push(namespace);
  }
  const target = await created(fixture, "/namespaces", { name: "restored" });
  await markReady(fixture, target.id);
  const bundle = await exportTenants(fixture.api);
  bundle.namespaces = bundle.namespaces.filter(({ id }) =>
    sources.some((source) => source.id === id),
  );
  // Distinct destination names do not isolate tenants if the bundle repeats a
  // source ID: the map would otherwise send both tenants to the first target.
  const isolatedTargets = [];
  for (const name of ["isolated-a", "isolated-b"]) {
    const namespace = await created(fixture, "/namespaces", { name });
    await markReady(fixture, namespace.id);
    isolatedTargets.push(namespace);
  }
  const duplicate = structuredClone(bundle);
  assert.equal(duplicate.namespaces.length, 2);
  duplicate.namespaces[1]!.id = duplicate.namespaces[0]!.id;
  for (const skip of [[], ["source-b"]]) {
    const map: SavedState = { ids: {}, deployed: [] };
    const before = structuredClone(map);
    let calls = 0;
    let saves = 0;
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      fetchImpl(url, init) {
        calls += 1;
        return asAdministrator(fixture)(url, init);
      },
    });
    await assert.rejects(
      importTenants(
        api,
        duplicate,
        {},
        {
          state: map,
          save: () => {
            saves += 1;
          },
          names: { "source-a": "isolated-a", "source-b": "isolated-b" },
          skip,
          deploy: false,
        },
      ),
      (error: unknown) => {
        assert.equal(calls, 0);
        assert.equal(saves, 0);
        assert.ok(error instanceof Error);
        assert.match(error.message, /duplicate|repeated/iu);
        return true;
      },
    );
    assert.deepEqual(map, before);
    for (const namespace of isolatedTargets) {
      assert.deepEqual(
        (await fixture.api.expect("GET", `/namespaces/${namespace.id}/iam/roles`)).data,
        [],
      );
    }
  }

  const state: SavedState = { ids: {}, deployed: [] };
  let saves = 0;
  const options = {
    state,
    save: () => saves++,
    names: { "source-a": "restored", "source-b": "restored" },
    deploy: false,
  };
  await assert.rejects(
    importTenants(fixture.api, bundle, {}, options),
    /Namespaces source-a and source-b both target restored/u,
  );
  assert.deepEqual(state, { ids: {}, deployed: [] });
  assert.equal(saves, 0);
  assert.deepEqual(
    (await fixture.api.expect("GET", `/namespaces/${target.id}/iam/roles`)).data,
    [],
  );

  // A not-yet-existing target must not be partly created before the second source conflicts.
  await assert.rejects(
    importTenants(
      fixture.api,
      bundle,
      {},
      {
        ...options,
        names: { "source-a": "not-created", "source-b": "not-created" },
      },
    ),
    /Namespaces source-a and source-b both target not-created/u,
  );
  assert.equal(
    resources((await fixture.api.expect("GET", "/namespaces")).data).some(
      ({ name }) => name === "not-created",
    ),
    false,
  );
  assert.deepEqual(state, { ids: {}, deployed: [] });
  assert.equal(saves, 0);

  // A map saved by an older import can carry the same conflict even after renames change.
  const overlapping = {
    ids: Object.fromEntries(sources.map(({ id }) => [id, target.id])),
    deployed: [],
  };
  const before = structuredClone(overlapping);
  await assert.rejects(
    importTenants(fixture.api, bundle, {}, { ...options, state: overlapping, names: {} }),
    /Namespaces source-a and source-b both resolve to Namespace/u,
  );
  assert.deepEqual(overlapping, before);
  assert.equal(saves, 0);
  assert.deepEqual(
    (await fixture.api.expect("GET", `/namespaces/${target.id}/iam/roles`)).data,
    [],
  );

  // Persisted IDs must be checked before any request: an array containing an ID
  // has a different Map identity but becomes the same destination in a URL.
  for (const invalidId of [[target.id], {}, null, 42, "", " ", "x".repeat(201)]) {
    const invalidState = {
      ids: Object.fromEntries([
        [sources[0]!.id, target.id],
        [sources[1]!.id, invalidId],
      ]),
      deployed: [],
    };
    const unchanged = structuredClone(invalidState);
    let requests = 0;
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      fetchImpl(url, init) {
        requests += 1;
        return asAdministrator(fixture)(url, init);
      },
    });
    await assert.rejects(
      importTenants(api, bundle, {}, { ...options, state: invalidState, names: {} }),
      /ID map \(--map\)\.ids: (expected nonempty string values|invalid resource ID)/u,
    );
    assert.equal(requests, 0);
    assert.equal(saves, 0);
    assert.deepEqual(invalidState, unchanged);
  }

  // A skipped source without a saved destination does not prevent a normal one-tenant import.
  const imported = await importTenants(fixture.api, bundle, {}, { ...options, skip: ["source-b"] });
  assert.equal(imported.complete, true);
  assert.equal(Object.entries(state.ids).find(([id]) => id === sources[0]?.id)?.[1], target.id);
  assert.equal(Object.entries(state.ids).find(([id]) => id === sources[1]?.id)?.[1], undefined);
  assert.deepEqual(
    resources((await fixture.api.expect("GET", `/namespaces/${target.id}/iam/roles`)).data).map(
      ({ name }) => name,
    ),
    ["source-a readers"],
  );

  // A partial resume must compare saved IDs with targets resolved by live names, too.
  const partial = structuredClone(state);
  const savesBeforeResume = saves;
  await assert.rejects(
    importTenants(
      fixture.api,
      bundle,
      {},
      {
        ...options,
        names: { "source-b": "restored" },
      },
    ),
    /Namespaces source-a and source-b both resolve to Namespace/u,
  );
  assert.deepEqual(state, partial);
  assert.equal(saves, savesBeforeResume);
  assert.deepEqual(
    resources((await fixture.api.expect("GET", `/namespaces/${target.id}/iam/roles`)).data).map(
      ({ name }) => name,
    ),
    ["source-a readers"],
  );

  // A previously imported source retains its destination when the skip selection changes.
  const swappedTarget = await created(fixture, "/namespaces", { name: "swapped" });
  await markReady(fixture, swappedTarget.id);
  const swappedState: SavedState = { ids: {}, deployed: [] };
  const firstPass = await importTenants(
    fixture.api,
    bundle,
    {},
    {
      ...options,
      state: swappedState,
      names: { "source-b": "swapped" },
      skip: ["source-a"],
    },
  );
  assert.equal(firstPass.complete, true);
  const swappedBefore = structuredClone(swappedState);
  const savedBeforeSwap = saves;
  await assert.rejects(
    importTenants(
      fixture.api,
      bundle,
      {},
      {
        ...options,
        state: swappedState,
        names: { "source-a": "swapped" },
        skip: ["source-b"],
      },
    ),
    /both resolve to Namespace.*swapped/u,
  );
  assert.deepEqual(swappedState, swappedBefore);
  assert.equal(saves, savedBeforeSwap);
  assert.deepEqual(
    resources(
      (await fixture.api.expect("GET", `/namespaces/${swappedTarget.id}/iam/roles`)).data,
    ).map(({ name }) => name),
    ["source-b readers"],
  );
});

test("import requires own object mappings and restores literal names or explicit renames", async () => {
  const source = await createFixture();
  const namespace = await created(source, "/namespaces", { name: "__proto__" });
  await markReady(source, namespace.id);
  for (const name of ["constructor", "0"]) {
    await created(source, `/namespaces/${namespace.id}/secrets`, { name, value: "source" });
  }
  const bundle = await exportTenants(source.api);
  bundle.namespaces = bundle.namespaces.filter(({ id }) => id === namespace.id);
  const values = object(
    JSON.parse('{"__proto__":{"constructor":"restored","0":"indexed"}}') as unknown,
  );
  const destination = await createFixture();
  const state: SavedState = { ids: {}, deployed: [] };
  let saves = 0;
  const options = { state, save: () => saves++, deploy: false };
  const before = (await destination.api.expect("GET", "/namespaces")).data;
  // An inherited tenant map and an inherited string inside an own tenant map are distinct gaps.
  const invalidCases: [unknown, string[]][] = [
    [Object.create(values), ["constructor", "0"]],
    [{ ["__proto__"]: Object.create(object(values.__proto__)) }, ["constructor", "0"]],
    [{ ["__proto__"]: "abc" }, ["constructor", "0"]],
    [{ ["__proto__"]: ["indexed"] }, ["constructor", "0"]],
    [{ ["__proto__"]: { constructor: "restored" } }, ["0"]],
  ];
  for (const [invalid, missing] of invalidCases) {
    await assert.rejects(importTenants(destination.api, bundle, invalid, options), {
      message: bundle.namespaces[0]!.secrets.filter(({ name }) => missing.includes(name))
        .map(({ name }) => `no value for Secret __proto__/${name}`)
        .join("\n"),
    });
    assert.deepEqual(state, { ids: {}, deployed: [] });
    assert.equal(saves, 0);
    assert.deepEqual((await destination.api.expect("GET", "/namespaces")).data, before);
  }
  assert.deepEqual(
    checkImport(bundle, JSON.parse('{"__proto__":{"constructor":"restored","0":""}}')),
    [],
  );

  // Ignore inherited renames; an explicit own __proto__ rename must still work.
  const renameCases: [string, Record<string, string>][] = [
    ["__proto__", Object.create(JSON.parse('{"__proto__":"wrong destination"}'))],
    ["constructor", JSON.parse('{"__proto__":"constructor"}')],
  ];
  for (const [name, names] of renameCases) {
    const target = await created(destination, "/namespaces", { name });
    await markReady(destination, target.id);
    const restored: SavedState = { ids: { "unused-opaque-source": " " }, deployed: [] };
    const result = await importTenants(destination.api, bundle, values, {
      ...options,
      state: restored,
      names,
    });
    assert.equal(result.complete, true);
    assert.equal(restored.ids[namespace.id], target.id);
    assert.equal(restored.ids["unused-opaque-source"], " ");
    const secrets = resources(
      (await destination.api.expect("GET", `/namespaces/${target.id}/secrets`)).data,
    );
    assert.deepEqual(
      secrets.map(({ id, name }) => ({ id, name })),
      bundle.namespaces[0]!.secrets.map((secret) => ({
        id: restored.ids[secret.id],
        name: secret.name,
      })),
    );
  }
});

test("discard refuses a stale bundle or one missing workspace files, before deleting", async () => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  const bundle = await exportTenants(fixture.api);
  // This app has no Gateway to read workspace files from, as for a stopped Agent.
  const exported = bundle.namespaces.find(({ name }) => name === "team-a");
  assert.equal(exported?.agents[0]?.unreadWorkspaceFiles?.length, 4);
  const discard = (options = {}) =>
    discardTenants(fixture.api, bundle, { sleep: noSleep, intervalMs: 0, ...options });
  await assert.rejects(
    discard(),
    /lacks workspace files of team-a\/a1; deploy those Agents and export again/u,
  );
  // Damage only the workspace HTTP response. Neither an unverified 404 nor
  // mixed success/error data proves that the source files can be discarded.
  for (const damage of ["unverified-404", "mixed-success", "wrong-file-name", "verified-404"]) {
    let deletes = 0;
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      async fetchImpl(url, init) {
        if (init.method === "DELETE") {
          deletes += 1;
        }
        const response = await asAdministrator(fixture)(url, init);
        if (!new URL(url).pathname.includes("/workspace/files/")) {
          return response;
        }
        const envelope = object((await response.json()) as unknown);
        assert.notEqual(response.status, 200);
        if (damage === "verified-404") {
          // Use OCC's actual missing-Agent envelope at this transport boundary;
          // this exercises response handling, not an installed workspace read.
          const missingUrl = url.replace(
            seeded.agent.id,
            "agt_ffffffff-ffff-4fff-8fff-ffffffffffff",
          );
          const missing = await asAdministrator(fixture)(missingUrl, init);
          assert.equal(missing.status, 404);
          return missing;
        }
        if (damage === "unverified-404") {
          return Response.json(
            { error: { code: "NOT_FOUND", message: "Not found." } },
            { status: 404 },
          );
        }
        if (damage === "wrong-file-name") {
          return Response.json(
            { meta: envelope.meta, data: { name: "wrong-file", content: "untrusted file" } },
            { status: 200 },
          );
        }
        return Response.json({ ...envelope, data: { content: "untrusted file" } }, { status: 200 });
      },
    });
    const damaged = await exportTenants(api);
    const agent = damaged.namespaces.find(({ name }) => name === "team-a")?.agents[0];
    assert.deepEqual(agent?.workspaceFiles, {});
    assert.equal(agent?.unreadWorkspaceFiles.length, damage === "verified-404" ? 0 : 4);
    if (damage === "verified-404") {
      continue;
    }
    await assert.rejects(
      discardTenants(api, damaged, { sleep: noSleep, intervalMs: 0 }),
      /lacks workspace files/u,
    );
    assert.equal(deletes, 0);
  }
  await created(fixture, `/namespaces/${seeded.namespace.id}/secrets`, {
    name: "late",
    value: "x",
  });
  await assert.rejects(
    discard({ allowUnreadWorkspaceFiles: true }),
    /team-a has resources the bundle lacks .*export again/u,
  );
  const agents = resources(
    (await request(fixture.app, `/namespaces/${seeded.namespace.id}/agents`)).payload.data,
  );
  assert.equal(agents.length, 1);
  const secrets = resources(
    (await request(fixture.app, `/namespaces/${seeded.namespace.id}/secrets`)).payload.data,
  );
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

test("import refuses non-array destination inventories before adopting a populated Namespace", async () => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  const exported = await exportTenants(fixture.api);
  const bundle = {
    ...exported,
    namespaces: exported.namespaces.filter(({ id }) => id === seeded.namespace.id),
  };
  const destination = await created(fixture, "/namespaces", { name: "existing-destination" });
  await markReady(fixture, destination.id);
  const base = `/namespaces/${destination.id}`;
  const configuration = await created(fixture, `${base}/configurations`, {
    kind: "agent",
    values: { model: "destination-model" },
  });
  const existingAgent = await created(fixture, `${base}/agents`, {
    name: "existing-agent",
    configurationId: configuration.id,
  });
  assert.deepEqual((await fixture.api.expect("GET", `${base}/secrets`)).data, []);
  const before = (await fixture.api.expect("GET", `${base}/agents`)).data;

  for (const data of [null, "", "not-an-array", {}, 0, false]) {
    const state: SavedState = { ids: {}, deployed: [] };
    let saves = 0;
    let writes = 0;
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      async fetchImpl(url, init) {
        if (init.method !== "GET") {
          writes += 1;
        }
        const response = await asAdministrator(fixture)(url, init);
        if (init.method !== "GET" || new URL(url).pathname !== `${base}/agents`) {
          return response;
        }
        assert.equal(response.status, 200);
        const payload = object((await response.json()) as unknown);
        assert.ok(resources(payload.data).some(({ id }) => id === existingAgent.id));
        return Response.json({ ...payload, data }, { status: 200 });
      },
    });
    await assert.rejects(
      importTenants(
        api,
        bundle,
        { "team-a": { "model-key": "synthetic-value" } },
        {
          state,
          save: () => {
            saves += 1;
          },
          deploy: false,
          names: { "team-a": string(destination.name) },
        },
      ),
      {
        message: `GET ${base}/agents: invalid OCC collection response; expected an array in data. Keep the original bundle and map, if present. Correct the OCC endpoint and reconcile any earlier writes before resuming the original operation.`,
      },
    );
    assert.equal(saves, 0);
    assert.equal(writes, 0);
    assert.deepEqual(state, { ids: {}, deployed: [] });
    assert.deepEqual((await fixture.api.expect("GET", `${base}/agents`)).data, before);
  }

  // A stale child mapping does not mean this source Namespace has already been
  // adopted. Its exact-name destination still needs the population check.
  const childOnlyState: SavedState = {
    ids: { [seeded.role.id]: destination.id },
    deployed: [],
  };
  const childOnlyBefore = structuredClone(childOnlyState);
  let childOnlySaves = 0;
  let childOnlyWrites = 0;
  const childOnlyApi = createOccApi({
    baseUrl: "https://console.oce.localhost",
    fetchImpl(url, init) {
      if (init.method !== "GET") {
        childOnlyWrites += 1;
      }
      return asAdministrator(fixture)(url, init);
    },
  });
  await assert.rejects(
    importTenants(
      childOnlyApi,
      bundle,
      { "team-a": { "model-key": "synthetic-value" } },
      {
        state: childOnlyState,
        save: () => {
          childOnlySaves += 1;
        },
        deploy: false,
        names: { "team-a": string(destination.name) },
      },
    ),
    (error: unknown) => {
      assert.equal(childOnlyWrites, 0);
      assert.equal(childOnlySaves, 0);
      assert.ok(error instanceof Error);
      assert.match(error.message, /already exists and holds Agents or Secrets/u);
      return true;
    },
  );
  assert.deepEqual(childOnlyState, childOnlyBefore);
  assert.deepEqual((await fixture.api.expect("GET", `${base}/agents`)).data, before);
  assert.deepEqual((await fixture.api.expect("GET", `${base}/secrets`)).data, []);

  // A genuinely empty, ready destination still follows the normal import path.
  const empty = await created(fixture, "/namespaces", { name: "empty-destination" });
  await markReady(fixture, empty.id);
  const state: SavedState = { ids: {}, deployed: [] };
  const result = await importTenants(
    fixture.api,
    bundle,
    { "team-a": { "model-key": "synthetic-value" } },
    {
      state,
      deploy: false,
      names: { "team-a": string(empty.name) },
    },
  );
  assert.equal(result.complete, true);
  assert.equal(state.ids[seeded.namespace.id], empty.id);
  assert.notEqual(state.ids[seeded.agent.id], existingAgent.id);
  assert.deepEqual((await fixture.api.expect("GET", `${base}/agents`)).data, before);
});

test("discard validates every tenant's late collections before deleting any Agent", async () => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  // A second real tenant has a Configuration that comes after Agent deletion.
  const laterNamespace = await created(fixture, "/namespaces", { name: "late-config-tenant" });
  await markReady(fixture, laterNamespace.id);
  const laterConfiguration = await created(
    fixture,
    `/namespaces/${laterNamespace.id}/configurations`,
    {
      kind: "agent",
      values: { model: "later-model" },
    },
  );
  await created(fixture, `/namespaces/${laterNamespace.id}/agents`, {
    name: "later-agent",
    configurationId: laterConfiguration.id,
  });
  const exported = await exportTenants(fixture.api);
  const populated = exported.namespaces.find(({ id }) => id === seeded.namespace.id);
  const later = exported.namespaces.find(({ id }) => id === laterNamespace.id);
  assert.ok(populated);
  assert.ok(later);

  // A later tenant's malformed input must not partially destroy the valid first
  // tenant, even when the operator explicitly accepts unavailable workspace files.
  const cases = [
    { field: "presets", value: {}, diagnostic: /presets; expected an array/u },
    { field: "roles", value: [null], diagnostic: /roles\[0\].*expected an object/u },
    { field: "roles", value: [{ ...seeded.role, id: 42 }], diagnostic: /roles\[\]\.id/u },
    // These satisfy the opaque length bound, but cannot retain their exact ID
    // through URI encoding and WHATWG URL construction. Catch every tenant's
    // failure before deleting the first tenant's Agent.
    ...[".", "..", "\ud800", "\udc00"].map((id) => ({
      field: "roles",
      value: [{ ...seeded.role, namespaceId: laterNamespace.id, id }],
      diagnostic: /roles\[\]\.id/u,
    })),
    // Nonblank IDs must still satisfy the Configuration DELETE route's format.
    ...[
      "not-a-configuration-id",
      "cfg_00000000-0000-1000-8000-000000000001",
      "sec_00000000-0000-4000-8000-000000000001",
    ].map((id) => ({
      field: "configurations",
      value: [{ ...laterConfiguration, id }],
      diagnostic: /configurations\[\]\.id/u,
    })),
  ];
  for (const { field, value, diagnostic } of cases) {
    const bundle = structuredClone({ ...exported, namespaces: [populated, later] });
    object(bundle.namespaces[1])[field] = value;
    let deletes = 0;
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      fetchImpl(url, init) {
        if (init.method === "DELETE") {
          deletes += 1;
        }
        return asAdministrator(fixture)(url, init);
      },
    });
    await assert.rejects(
      discardTenants(api, bundle, {
        allowUnreadWorkspaceFiles: true,
        sleep: noSleep,
        timeoutMs: 0,
        intervalMs: 0,
      }),
      (error: unknown) => {
        assert.equal(deletes, 0);
        assert.ok(error instanceof Error);
        assert.match(error.message, diagnostic);
        return true;
      },
    );
    const agents = resources(
      (await fixture.api.expect("GET", `/namespaces/${seeded.namespace.id}/agents`)).data,
    );
    assert.ok(agents.some(({ id }) => id === seeded.agent.id));
  }
});

test("command redacts malformed private JSON before issuing requests", async (t) => {
  const directory = temporaryDirectorySync(t, "split-layout-private-json-");
  const fixture = await createFixture();
  const bundle = await exportTenants(fixture.api);
  const files = {
    bundle: join(directory, "bundle.json"),
    "service-key file": join(directory, "key.json"),
    "Secret-values file": join(directory, "values.json"),
    "ID map": join(directory, "map.json"),
  };
  const contents = {
    bundle,
    "service-key file": { data: { key: "synthetic-service-key" } },
    "Secret-values file": {},
    "ID map": { ids: {}, deployed: [] },
  };
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  await listen(t, server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const command = fileURLToPath(new URL("../../scripts/split-layout-tenants.ts", import.meta.url));
  const marker = "SYNTHETIC_PRIVATE_VALUE";
  for (const [label, path] of Object.entries(files)) {
    for (const [name, value] of Object.entries(contents)) {
      const file = files[name as keyof typeof files];
      writeFileSync(file, JSON.stringify(value));
    }
    // Native JSON syntax errors can quote this text. Exercise the shipped
    // executable's stderr handler, rather than only rejecting inside main().
    writeFileSync(path, marker);
    const before = readFileSync(files["ID map"], "utf8");
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          command,
          "import",
          "--bundle",
          files.bundle,
          "--secret-values",
          files["Secret-values file"],
          "--map",
          files["ID map"],
          "--no-deploy",
        ],
        {
          env: {
            ...process.env,
            OCC_URL: `http://127.0.0.1:${address.port}`,
            OCC_SERVICE_KEY_FILE: files["service-key file"],
          },
        },
      ),
      (error: unknown) => {
        const failure = object(error);
        assert.equal(failure.code, 1);
        const stderr = string(failure.stderr);
        assert.equal(stderr, `Invalid JSON in ${label}.\n`);
        assert.equal(stderr.includes(marker), false);
        return true;
      },
    );
    assert.equal(requests, 0);
    assert.equal(readFileSync(files["ID map"], "utf8"), before);
    assert.equal(existsSync(`${files["ID map"]}.partial`), false);
  }
});

test("import waits only for provisioning and preserves mappings on invalid readiness", async () => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  const exported = await exportTenants(fixture.api);
  const bundle = {
    ...exported,
    namespaces: exported.namespaces.filter(({ id }) => id === seeded.namespace.id),
  };
  const cases: {
    name: string;
    storedStatus: "provisioning" | "failed" | "deleting";
    damaged?: { status: unknown };
  }[] = [
    { name: "pending", storedStatus: "provisioning" },
    { name: "failed", storedStatus: "failed" },
    { name: "deleting", storedStatus: "deleting" },
    { name: "missing", storedStatus: "provisioning", damaged: { status: undefined } },
    { name: "null", storedStatus: "provisioning", damaged: { status: null } },
    { name: "number", storedStatus: "provisioning", damaged: { status: 7 } },
    { name: "unknown", storedStatus: "provisioning", damaged: { status: "unknown" } },
  ];
  for (const { name, storedStatus, damaged } of cases) {
    const destination = await created(fixture, "/namespaces", { name: `readiness-${name}` });
    if (storedStatus !== "provisioning") {
      // These are real supported states, persisted through the same repository
      // transition contract used by Namespace reconciliation and deletion.
      await fixture.controller.transact((unit: PlatformUnitOfWork) =>
        unit.namespaces.transitionNamespaceStatus(destination.id, "provisioning", storedStatus),
      );
    }
    const state: SavedState = { ids: { [seeded.namespace.id]: destination.id }, deployed: [] };
    const before = structuredClone(state);
    let writes = 0;
    let saves = 0;
    const api = createOccApi({
      baseUrl: "https://console.oce.localhost",
      async fetchImpl(url, init) {
        if (init.method !== "GET") {
          writes += 1;
        }
        const response = await asAdministrator(fixture)(url, init);
        if (new URL(url).pathname !== `/namespaces/${destination.id}`) {
          return response;
        }
        assert.equal(response.status, 200);
        const payload = object((await response.json()) as unknown);
        assert.equal(object(payload.data).status, storedStatus);
        if (damaged) {
          // Damage only the HTTP response; no unsupported lifecycle state is
          // inserted into storage and no importer decision is mocked.
          object(payload.data).status = damaged.status;
        }
        return Response.json(payload, { status: 200 });
      },
    });
    const run = () =>
      importTenants(
        api,
        bundle,
        { "team-a": { "model-key": "restored" } },
        {
          state,
          save: () => {
            saves += 1;
          },
          names: { "team-a": string(destination.name) },
          deploy: false,
          sleep: noSleep,
          readyTimeoutMs: 0,
          intervalMs: 0,
        },
      );
    if (storedStatus === "provisioning" && !damaged) {
      const result = await run();
      assert.equal(result.complete, false);
      assert.deepEqual(result.pendingNamespaces, [`${destination.name} (${destination.id})`]);
    } else {
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof Error);
        if (damaged) {
          assert.match(error.message, /invalid Namespace status/u);
        } else {
          assert.ok(error.message.startsWith(`Namespace ${destination.id} is ${storedStatus}.`));
        }
        assert.doesNotMatch(error.message, /Grant.*RoleBindings|waiting for tenant RoleBindings/u);
        return true;
      });
    }
    assert.equal(writes, 0);
    assert.equal(saves, 0);
    assert.deepEqual(state, before);
  }
});

test("Namespace write refusals require the OCC error envelope before offering recovery", async () => {
  const fixture = await createFixture();
  const namespace = await created(fixture, "/namespaces", { name: "reserved-source" });
  await markReady(fixture, namespace.id);
  // An unreferenced Configuration is intentionally absent from the export and makes
  // the real Namespace DELETE refuse. Damage only that refusal's response envelope.
  await created(fixture, `/namespaces/${namespace.id}/configurations`, {
    kind: "agent",
    values: {},
  });
  const bundle = await exportTenants(fixture.api);
  bundle.namespaces = bundle.namespaces.filter(({ id }) => id === namespace.id);
  const state: SavedState = { ids: {}, deployed: [] };
  let saves = 0;
  const refused: string[] = [];
  const api = createOccApi({
    baseUrl: "https://console.oce.localhost",
    async fetchImpl(url, init) {
      const path = new URL(url).pathname;
      const response = await asAdministrator(fixture)(url, init);
      if (init.method === "GET" && path === "/namespaces") {
        // Model the inventory becoming stale before POST, without inventing its refusal.
        const envelope = object((await response.json()) as unknown);
        return Response.json({ ...envelope, data: [] }, { status: response.status });
      }
      if (
        (init.method === "POST" && path === "/namespaces") ||
        (init.method === "DELETE" && path === `/namespaces/${namespace.id}`)
      ) {
        assert.equal(response.status, 409);
        const envelope = object((await response.json()) as unknown);
        assert.equal(
          object(envelope.error).code,
          init.method === "POST" ? "RESOURCE_CONFLICT" : "NAMESPACE_NOT_EMPTY",
        );
        refused.push(init.method);
        return Response.json({ error: envelope.error }, { status: 409 });
      }
      return response;
    },
  });
  await assert.rejects(
    importTenants(api, bundle, {}, { state, save: () => saves++, deploy: false }),
    /ambiguous HTTP 409 response/u,
  );
  assert.deepEqual(state, { ids: {}, deployed: [] });
  assert.equal(saves, 0);
  await assert.rejects(
    discardTenants(api, bundle, { sleep: noSleep, intervalMs: 0, timeoutMs: 0 }),
    /ambiguous HTTP 409 response/u,
  );
  assert.deepEqual(refused, ["POST", "DELETE"]);
  assert.equal(
    object((await fixture.api.expect("GET", `/namespaces/${namespace.id}`)).data).status,
    "ready",
  );
});

test("credentialed writes stop before following a cross-origin HTTP redirect", async (t) => {
  const destinationRequests: string[] = [];
  const destination = createServer((request, response) => {
    destinationRequests.push(`${request.method} ${request.url}`);
    response.writeHead(201, { "content-type": "application/json" }).end(
      JSON.stringify({
        data: {
          id: "ns_00000000-0000-4000-8000-000000000001",
          name: "redirect-probe",
          status: "provisioning",
          createdAt: "2026-11-10T00:00:00.000Z",
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
      }),
    );
  });
  await listen(t, destination);
  const destinationAddress = destination.address();
  assert.ok(destinationAddress && typeof destinationAddress !== "string");

  const originRequests: {
    method: string | undefined;
    path: string | undefined;
    key: string | string[] | undefined;
    body: string;
  }[] = [];
  const origin = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    originRequests.push({
      method: request.method,
      path: request.url,
      key: request.headers["x-api-key"],
      body,
    });
    response
      .writeHead(307, {
        location: `http://127.0.0.1:${destinationAddress.port}/namespaces`,
      })
      .end();
  });
  await listen(t, origin);
  const originAddress = origin.address();
  assert.ok(originAddress && typeof originAddress !== "string");

  // Use native fetch against both listeners: a mocked fetch would not exercise
  // Node's redirect replay of the POST body and custom credential header.
  const key = "synthetic-redirect-service-key";
  const body = { name: "redirect-probe" };
  const api = createOccApi({
    baseUrl: `http://127.0.0.1:${originAddress.port}`,
    headers: { "x-api-key": key },
  });
  const failure: unknown = await api.expect("POST", "/namespaces", body).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.deepEqual(destinationRequests, []);
  assert.deepEqual(originRequests, [
    {
      method: "POST",
      path: "/namespaces",
      key,
      body: JSON.stringify(body),
    },
  ]);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /redirect|ambiguous HTTP 307/u);
  assert.match(failure.message, /reconcil/iu);
});

test("discard preserves encoded opaque Role IDs through real HTTP deletion", async () => {
  const fixture = await createFixture();
  const namespace = await created(fixture, "/namespaces", { name: "opaque-deletion" });
  await markReady(fixture, namespace.id);
  const ids = [
    "role/with/slashes",
    "role%2e",
    "role?#fragment",
    "role\\backslash",
    "😀".repeat(200),
  ];
  await fixture.controller.transact(async (unit: PlatformUnitOfWork) => {
    for (const [index, id] of ids.entries()) {
      await unit.iamPolicy.createRole({
        id,
        namespaceId: namespace.id,
        name: `Encoded role ${index}`,
        permissions: [{ action: "read", resourceKind: "configuration" }],
      });
    }
  });
  const bundle = await exportTenants(fixture.api);
  bundle.namespaces = bundle.namespaces.filter(({ id }) => id === namespace.id);
  const removed: string[] = [];
  const api = createOccApi({
    baseUrl: "https://console.oce.localhost",
    fetchImpl(url, init) {
      if (init.method === "DELETE" && new URL(url).pathname.includes("/iam/roles/")) {
        removed.push(decodeURIComponent(new URL(url).pathname.split("/").at(-1)!));
      }
      return asAdministrator(fixture)(url, init);
    },
  });
  // This fixture has no Namespace deletion worker. Child deletion succeeds;
  // the command truthfully reports the still-deleting Namespace at its deadline.
  await assert.rejects(
    discardTenants(api, bundle, { timeoutMs: 0, intervalMs: 0, sleep: noSleep }),
    /Namespaces still present/u,
  );
  assert.deepEqual([...removed].sort(), [...ids].sort());
  assert.deepEqual(
    (await fixture.api.expect("GET", `/namespaces/${namespace.id}/iam/roles`)).data,
    [],
  );
});

test("import refuses ambiguous source identities before requests or map saves", async (t) => {
  const fixture = await createFixture();
  const source = await created(fixture, "/namespaces", { name: "map-key-source" });
  const target = await created(fixture, "/namespaces", { name: "map-key-target" });
  await markReady(fixture, source.id);
  await markReady(fixture, target.id);
  // Existing IAM Role IDs are opaque and scoped independently of Namespace IDs.
  // Public Role creation generates an ID; the repository can retain this valid collision.
  await fixture.controller.transact((unit: PlatformUnitOfWork) =>
    unit.iamPolicy.createRole({
      id: source.id,
      namespaceId: source.id,
      name: "Role sharing a Namespace ID",
      permissions: [{ action: "read", resourceKind: "configuration" }],
    }),
  );
  const role = createdResource(
    (await fixture.api.expect("GET", `/namespaces/${source.id}/iam/roles/${source.id}`)).data,
  );
  assert.equal(role.id, source.id);
  const bundle = await exportTenants(fixture.api);
  bundle.namespaces = bundle.namespaces.filter(({ id }) => id === source.id);
  assert.equal(bundle.namespaces[0]!.roles[0]!.id, source.id);

  for (const [label, initialIds] of [
    ["empty map", {}],
    ["valid Namespace destination", { [source.id]: target.id }],
    ["opaque destination", { [source.id]: "role-destination" }],
  ] as const) {
    await t.test(label, async () => {
      const state: SavedState = { ids: { ...initialIds }, deployed: [] };
      const before = structuredClone(state);
      let requests = 0;
      let saves = 0;
      const api = createOccApi({
        baseUrl: "https://console.oce.localhost",
        fetchImpl(url, init) {
          requests += 1;
          return asAdministrator(fixture)(url, init);
        },
      });
      // One flat entry cannot describe both a Namespace and a Role destination.
      // Even a valid Namespace mapping would otherwise silently skip Role creation.
      await assert.rejects(
        importTenants(
          api,
          bundle,
          {},
          {
            state,
            save: () => {
              saves += 1;
            },
            names: { "map-key-source": "map-key-target" },
            deploy: false,
          },
        ),
        /source IDs overlap/u,
      );
      assert.equal(requests, 0);
      assert.equal(saves, 0);
      assert.deepEqual(state, before);
      assert.deepEqual(
        (await fixture.api.expect("GET", `/namespaces/${target.id}/iam/roles`)).data,
        [],
      );
    });
  }
});

test("discard refuses identity collisions before deleting restorable resources", async () => {
  const fixture = await createFixture();
  const source = await created(fixture, "/namespaces", { name: "discard-map-key-source" });
  await markReady(fixture, source.id);
  await fixture.controller.transact((unit: PlatformUnitOfWork) =>
    unit.iamPolicy.createRole({
      id: source.id,
      namespaceId: source.id,
      name: "Role sharing a Namespace ID",
      permissions: [{ action: "read", resourceKind: "configuration" }],
    }),
  );
  const bundle = await exportTenants(fixture.api);
  bundle.namespaces = bundle.namespaces.filter(({ id }) => id === source.id);
  let requests = 0;
  const api = createOccApi({
    baseUrl: "https://console.oce.localhost",
    fetchImpl(url, init) {
      requests += 1;
      return asAdministrator(fixture)(url, init);
    },
  });
  // Discard must not destroy valid source data the automatic importer cannot represent.
  await assert.rejects(
    discardTenants(api, bundle, { timeoutMs: 0, intervalMs: 0, sleep: noSleep }),
    /source IDs overlap/u,
  );
  assert.equal(requests, 0);
  const role = createdResource(
    (await fixture.api.expect("GET", `/namespaces/${source.id}/iam/roles/${source.id}`)).data,
  );
  assert.equal(role.id, source.id);
});

test("resumed imports retain identity ownership for skipped tenants", async () => {
  const fixture = await createFixture();
  const selected = await seedTenant(fixture);
  const skipped = await created(fixture, "/namespaces", { name: "previous-source" });
  await markReady(fixture, skipped.id);
  // Different resource collections can retain the same opaque ID. The old Role
  // mapping must not masquerade as completion of another tenant's AccessBinding.
  await fixture.controller.transact((unit: PlatformUnitOfWork) =>
    unit.iamPolicy.createRole({
      id: selected.binding.id,
      namespaceId: skipped.id,
      name: "previous-source-role",
      permissions: [{ action: "read", resourceKind: "configuration" }],
    }),
  );
  const bundle = await exportTenants(fixture.api);
  bundle.namespaces = bundle.namespaces.filter(
    ({ id }) => id === selected.namespace.id || id === skipped.id,
  );
  const oldTarget = await created(fixture, "/namespaces", { name: "previous-target" });
  const target = await created(fixture, "/namespaces", { name: "next-target" });
  await markReady(fixture, oldTarget.id);
  await markReady(fixture, target.id);
  const oldRole = await created(fixture, `/namespaces/${oldTarget.id}/iam/roles`, {
    name: "previous-source-role",
    permissions: [{ action: "read", resourceKind: "configuration" }],
  });
  // This is the map an earlier import of only previous-source retained. Keeping
  // the same bundle while changing --skip must not erase its identity ownership.
  const state: SavedState = {
    ids: { [skipped.id]: oldTarget.id, [selected.binding.id]: oldRole.id },
    deployed: [],
  };
  const before = structuredClone(state);
  let requests = 0;
  let saves = 0;
  const api = createOccApi({
    baseUrl: "https://console.oce.localhost",
    fetchImpl(url, init) {
      requests += 1;
      return asAdministrator(fixture)(url, init);
    },
  });
  await assert.rejects(
    importTenants(
      api,
      bundle,
      { "team-a": { "model-key": "synthetic" } },
      {
        state,
        save: () => {
          saves += 1;
        },
        skip: [string(skipped.name)],
        names: { "team-a": "next-target" },
        deploy: false,
      },
    ),
    /source IDs overlap/u,
  );
  assert.equal(requests, 0);
  assert.equal(saves, 0);
  assert.deepEqual(state, before);
  assert.deepEqual(
    (await fixture.api.expect("GET", `/namespaces/${target.id}/iam/access-bindings`)).data,
    [],
  );
});
