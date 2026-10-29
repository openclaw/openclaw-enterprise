import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  main,
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
  fixture.api = createOccApi({ baseUrl: "http://127.0.0.1", fetchImpl: asAdministrator(fixture) });
  return fixture;
}

/** A fetch function that sends each request to the fixture's real app as its administrator. */
function asAdministrator(fixture) {
  return (url, init) =>
    fixture.app.fetch(
      new Request(url, {
        ...init,
        headers: authenticatedHeaders(fixture.app.defaultSession, init.headers),
      }),
    );
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

  // Damage the real collection response after its successful HTTP status. A
  // missing envelope must stop export, not become an empty Namespace inventory.
  for (const damage of ["malformed", "empty", "missing-data"]) {
    const api = createOccApi({
      baseUrl: "http://127.0.0.1",
      async fetchImpl(url, init) {
        const response = await asAdministrator(fixture)(url, init);
        assert.equal(response.status, 200);
        const text = await response.text();
        const payload = JSON.parse(text);
        assert.ok(payload.data.some(({ id }) => id === seeded.namespace.id));
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
  bundle.namespaces
    .find(({ id }) => id === seeded.namespace.id)
    .presets.find(({ id }) => id === legacyPreset.id).template.agent.harnessAuth = {
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

  for (const original of [preset, legacyPreset]) {
    const restored = (await request(fixture.app, `${base}/presets/${saved.ids[original.id]}`))
      .payload.data;
    assert.deepEqual(restored.template.agent.harnessAuth, {
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
    const restored = (await request(fixture.app, `${base}/presets/${saved.ids[original.id]}`))
      .payload.data;
    assert.equal(restored.template.agent.harnessAuth.source.id, saved.ids[account.id]);
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
  const resourceLess = { ...seeded.binding, id: "legacy-resource-less" };
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
  legacy.namespaces.find(({ id }) => id === seeded.namespace.id).accessBindings = [
    seeded.binding,
    ...manual,
    ...revisions,
  ];
  const state = structuredClone(saved);
  const messages = [];
  const beforeLegacy = (await fixture.api.expect("GET", `${base}/iam/access-bindings`)).data;
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
});

test("import command exits 4 while bindings need manual recovery, again on rerun", async (t) => {
  const fixture = await createFixture();
  const seeded = await seedTenant(fixture);
  const exported = await exportTenants(fixture.api);
  const directory = mkdtempSync(join(tmpdir(), "split-layout-tenants-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = "service-key-from-file";
  writeFileSync(join(directory, "key.json"), JSON.stringify({ data: { key } }));
  writeFileSync(join(directory, "values.json"), JSON.stringify({ "team-a": { "model-key": "v" } }));

  // A thin loopback adapter, not the production listener: it checks that the command sends
  // the service key from OCC_SERVICE_KEY_FILE, then forwards the request to the real app as
  // the signed-in administrator. It proves the command's exit codes and saved map only.
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    if (request.headers["x-api-key"] !== key) {
      response.writeHead(401).end();
      return;
    }
    const answer = await asAdministrator(fixture)(`http://127.0.0.1${request.url}`, {
      method: request.method,
      headers: request.headers["content-type"]
        ? { "content-type": request.headers["content-type"] }
        : {},
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(await answer.text());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const [name, value] of Object.entries({
    OCC_URL: `http://127.0.0.1:${server.address().port}`,
    OCC_SERVICE_KEY_FILE: join(directory, "key.json"),
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() =>
      previous === undefined ? delete process.env[name] : (process.env[name] = previous),
    );
  }
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(line));

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
  const run = async (name, extra) => {
    const bundle = structuredClone(exported);
    bundle.namespaces = bundle.namespaces.filter(({ id }) => id === seeded.namespace.id);
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
  const savedIds = (name) =>
    JSON.parse(readFileSync(join(directory, `${name}-map.json`), "utf8")).ids;

  for (const [name, extra, code] of [
    ["clean", [], 0],
    // Exit 0 can still omit old Agent revision bindings; the guide says so.
    ["revision-only", ["revision"], 0],
    ["group", ["group"], 4],
    ["refused", ["refused"], 4],
  ]) {
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
});

test("import refuses overlapping tenant destinations before changing the map or target", async () => {
  const fixture = await createFixture();
  const sources = [];
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
  const state = { ids: {}, deployed: [] };
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
    (await fixture.api.expect("GET", "/namespaces")).data.some(
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

  // A skipped source without a saved destination does not prevent a normal one-tenant import.
  const imported = await importTenants(fixture.api, bundle, {}, { ...options, skip: ["source-b"] });
  assert.equal(imported.complete, true);
  assert.equal(state.ids[sources[0].id], target.id);
  assert.equal(state.ids[sources[1].id], undefined);
  assert.deepEqual(
    (await fixture.api.expect("GET", `/namespaces/${target.id}/iam/roles`)).data.map(
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
    (await fixture.api.expect("GET", `/namespaces/${target.id}/iam/roles`)).data.map(
      ({ name }) => name,
    ),
    ["source-a readers"],
  );

  // A previously imported source retains its destination when the skip selection changes.
  const swappedTarget = await created(fixture, "/namespaces", { name: "swapped" });
  await markReady(fixture, swappedTarget.id);
  const swappedState = { ids: {}, deployed: [] };
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
    (await fixture.api.expect("GET", `/namespaces/${swappedTarget.id}/iam/roles`)).data.map(
      ({ name }) => name,
    ),
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
  const values = JSON.parse('{"__proto__":{"constructor":"restored","0":"indexed"}}');
  const destination = await createFixture();
  const state = { ids: {}, deployed: [] };
  let saves = 0;
  const options = { state, save: () => saves++, deploy: false };
  const before = (await destination.api.expect("GET", "/namespaces")).data;
  // An inherited tenant map and an inherited string inside an own tenant map are distinct gaps.
  for (const [invalid, missing] of [
    [Object.create(values), ["constructor", "0"]],
    [{ ["__proto__"]: Object.create(values.__proto__) }, ["constructor", "0"]],
    [{ ["__proto__"]: "abc" }, ["constructor", "0"]],
    [{ ["__proto__"]: ["indexed"] }, ["constructor", "0"]],
    [{ ["__proto__"]: { constructor: "restored" } }, ["0"]],
  ]) {
    await assert.rejects(importTenants(destination.api, bundle, invalid, options), {
      message: bundle.namespaces[0].secrets
        .filter(({ name }) => missing.includes(name))
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
  for (const [name, names] of [
    ["__proto__", Object.create(JSON.parse('{"__proto__":"wrong destination"}'))],
    ["constructor", JSON.parse('{"__proto__":"constructor"}')],
  ]) {
    const target = await created(destination, "/namespaces", { name });
    await markReady(destination, target.id);
    const restored = { ids: {}, deployed: [] };
    const result = await importTenants(destination.api, bundle, values, {
      ...options,
      state: restored,
      names,
    });
    assert.equal(result.complete, true);
    assert.equal(restored.ids[namespace.id], target.id);
    const secrets = (await destination.api.expect("GET", `/namespaces/${target.id}/secrets`)).data;
    assert.deepEqual(
      secrets.map(({ id, name }) => ({ id, name })),
      bundle.namespaces[0].secrets.map((secret) => ({
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
