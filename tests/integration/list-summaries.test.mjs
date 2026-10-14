import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";

// Finding 1323: list routes returned every Preset template and revision snapshot (up to 1 MiB
// each), and revisions are never pruned. Lists now return summaries, and revisions page.
const PRESET_SUMMARY_KEYS = ["createdAt", "id", "name", "namespaceId"];
const REVISION_SUMMARY_KEYS = [
  "agentId",
  "backendId",
  "configurationGeneration",
  "configurationId",
  "createdAt",
  "harness",
  "id",
  "namespaceId",
  "revision",
];

async function listFixture(t, name) {
  const state = new InMemoryPlatformState();
  const fixture = await createConsoleAppFixture(t, { state });
  await fixture.bootstrap(name);
  const namespace = await fixture.createNamespace(name, { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Listed Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const first = await fixture.deployAgent(namespace.id, agent.id);
  const revisionsPath = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  // Later revisions of the same Agent, as repeated deploys leave them: copies of the admitted
  // snapshot under new identities and numbers, with `configuration` replaced when given.
  const seedRevisions = async (count, configuration) => {
    const admitted = await state.read((view) =>
      view.revisions.findRevision(namespace.id, agent.id, first.id),
    );
    const latest = await state.read((view) =>
      view.revisions.listRevisionMetadata(namespace.id, agent.id),
    );
    const seeded = [];
    await state.transact(async (transaction) => {
      for (let offset = 1; offset <= count; offset += 1) {
        seeded.push(
          await transaction.revisions.createRevision({
            ...admitted,
            id: `rev_${randomUUID()}`,
            revision: latest.length + offset,
            ...(configuration === undefined ? {} : { configuration }),
          }),
        );
      }
    });
    return seeded;
  };
  const page = async (query = "", options = {}) => {
    const response = await fixture.request("GET", `${revisionsPath}${query}`, options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return {
      numbers: response.data.map(({ revision }) => revision),
      nextCursor: response.body.meta.nextCursor,
      data: response.data,
    };
  };
  return { state, fixture, namespace, agent, first, revisionsPath, seedRevisions, page };
}

test("Preset and revision lists return summaries, not the stored documents", async (t) => {
  const { state, fixture, namespace, agent, first, revisionsPath, seedRevisions } =
    await listFixture(t, "Heavy lists");
  // Documents of about 0.9 MB, bughunt-69's size. The in-memory store copies its whole state
  // on every read, so this proves response shape and size; the 64-document timing runs
  // against PostgreSQL in postgres-platform-state.test.mjs.
  const large = Object.fromEntries(Array.from({ length: 70_000 }, (_, i) => [`k${i}`, "v"]));
  const heavy = await seedRevisions(4, { ...first.configuration, env: { vars: large } });
  const presets = [];
  await state.transact(async (transaction) => {
    for (let index = 0; index < 4; index += 1) {
      presets.push(
        await transaction.presets.createPreset({
          id: `pre_${randomUUID()}`,
          namespaceId: namespace.id,
          name: `Heavy ${index}`,
          template: { configuration: { values: { env: { vars: large } } } },
          createdAt: new Date().toISOString(),
        }),
      );
    }
  });

  const listedPresets = await fixture.request("GET", `/namespaces/${namespace.id}/presets`);
  assert.equal(listedPresets.status, 200);
  assert.deepEqual(
    listedPresets.data.map(({ id }) => id).sort(),
    presets.map(({ id }) => id).sort(),
  );
  for (const summary of listedPresets.data) {
    // A summary carries identity only: no template, so nothing the full Preset hides either.
    assert.deepEqual(Object.keys(summary).sort(), PRESET_SUMMARY_KEYS);
  }
  assert.ok(
    JSON.stringify(listedPresets.body).length < 4 * 300,
    "Preset summaries stay a few hundred bytes each",
  );

  const listedRevisions = await fixture.request("GET", revisionsPath);
  assert.equal(listedRevisions.status, 200);
  assert.deepEqual(
    listedRevisions.data.map(({ revision }) => revision),
    [5, 4, 3, 2, 1],
  );
  for (const summary of listedRevisions.data) {
    assert.deepEqual(Object.keys(summary).sort(), REVISION_SUMMARY_KEYS);
    assert.equal(summary.agentId, agent.id);
  }
  assert.ok(
    JSON.stringify(listedRevisions.body).length < 5 * 500,
    "revision summaries stay a few hundred bytes each",
  );

  // The full documents stay on the exact reads, and a summary repeats the exact read's fields.
  const preset = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/presets/${presets[0].id}`,
  );
  assert.equal(Object.keys(preset.data.template.configuration.values.env.vars).length, 70_000);
  const revision = await fixture.request("GET", `${revisionsPath}/${heavy.at(-1).id}`);
  assert.equal(Object.keys(revision.data.configuration.env.vars).length, 70_000);
  assert.deepEqual(listedRevisions.data[0], {
    id: revision.data.id,
    namespaceId: revision.data.namespaceId,
    agentId: revision.data.agentId,
    revision: revision.data.revision,
    backendId: revision.data.backendId,
    configurationId: revision.data.configurationId,
    configurationGeneration: revision.data.configurationGeneration,
    harness: revision.data.harness,
    createdAt: revision.data.createdAt,
  });
});

test("revision pages run newest first and a cursor continues below a deploy between pages", async (t) => {
  const { fixture, namespace, agent, revisionsPath, seedRevisions, page } = await listFixture(
    t,
    "Revision pages",
  );
  // An Agent with no revision lists one empty last page.
  const empty = await fixture.createAgent(
    namespace.id,
    "Undeployed",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const none = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${empty.id}/revisions`,
  );
  assert.equal(none.status, 200);
  assert.deepEqual([none.data, none.body.meta.nextCursor], [[], null]);
  // One revision fits one page.
  const single = await page();
  assert.deepEqual([single.numbers, single.nextCursor], [[1], null]);

  await seedRevisions(4);
  const first = await page("?limit=2");
  assert.deepEqual([first.numbers, first.nextCursor], [[5, 4], "v1.4"]);
  // A deploy between pages takes the next number; the cursor still continues below 4, so the
  // walk neither repeats nor skips a revision.
  const deployed = await fixture.deployAgent(namespace.id, agent.id);
  assert.equal(deployed.revision, 6);
  const second = await page(`?limit=2&cursor=${first.nextCursor}`);
  assert.deepEqual([second.numbers, second.nextCursor], [[3, 2], "v1.2"]);
  const last = await page(`?limit=2&cursor=${second.nextCursor}`);
  assert.deepEqual([last.numbers, last.nextCursor], [[1], null]);
  // A fresh walk starts at the new revision.
  assert.deepEqual((await page("?limit=2")).numbers, [6, 5]);

  // The default page is 50; 100 is the most a page holds.
  await seedRevisions(100);
  const byDefault = await page();
  assert.deepEqual(
    [byDefault.data.length, byDefault.numbers[0], byDefault.nextCursor],
    [50, 106, "v1.57"],
  );
  const largest = await page("?limit=100");
  assert.deepEqual([largest.data.length, largest.nextCursor], [100, "v1.7"]);
  assert.deepEqual(
    (await page(`?limit=100&cursor=${largest.nextCursor}`)).numbers,
    [6, 5, 4, 3, 2, 1],
  );
  // Query strings are exact text: out-of-range sizes and foreign cursors are refused, not clamped.
  for (const query of [
    "?limit=101",
    "?limit=0",
    "?limit=-1",
    "?limit=1.5",
    "?cursor=v1.0",
    "?cursor=v1.9999999999999999",
    "?cursor=v2.4",
    "?cursor=4",
    "?cursor=v1.4&extra=1",
  ]) {
    const refused = await fixture.request("GET", `${revisionsPath}${query}`);
    assert.equal(refused.status, 400, `${query}: ${JSON.stringify(refused.body)}`);
  }
});

test("a revision page leaves out revisions the caller cannot read and still continues", async (t) => {
  const { fixture, namespace, agent, first, seedRevisions, page } = await listFixture(
    t,
    "Partial revision reads",
  );
  const [second, third] = await seedRevisions(4);
  // Read on the Agent opens its revision list; each revision still needs its own read grant.
  const reader = await fixture.createAccountWithPolicy("revision-reader", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: `agent-reader-${randomUUID()}`,
      namespaceId: namespace.id,
      permissions: { agent: ["read"] },
      resource: { kind: "agent", id: agent.id },
    });
    for (const revision of [first, third]) {
      grantRole(fixture.policy, principal.id, {
        id: `revision-reader-${revision.id}`,
        namespaceId: namespace.id,
        permissions: { agent_revision: ["read"] },
        resource: { kind: "agent_revision", id: revision.id },
      });
    }
  });
  const session = await fixture.signIn(reader.credentials);
  // Revisions 5, 4 and 2 are unreadable. A page scans past them, so it fills with readable
  // revisions and its cursor names only a readable one: nothing about the hidden revisions,
  // not even their numbers, reaches the caller.
  const both = await page("?limit=2", { session });
  assert.deepEqual([both.numbers, both.nextCursor], [[3, 1], null]);
  const newest = await page("?limit=1", { session });
  assert.deepEqual([newest.numbers, newest.nextCursor], [[3], "v1.3"]);
  assert.equal(newest.data[0].id, third.id);
  const last = await page(`?limit=1&cursor=${newest.nextCursor}`, { session });
  assert.deepEqual([last.numbers, last.nextCursor], [[1], null]);
  // Below the oldest revision the page is empty and ends the walk.
  const afterLast = await page("?limit=1&cursor=v1.1", { session });
  assert.deepEqual([afterLast.numbers, afterLast.nextCursor], [[], null]);
  assert.equal(second.revision, 2);
  // The unreadable revision stays refused on its exact read as well.
  const refused = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${second.id}`,
    { session },
  );
  assert.equal(refused.status, 403);
});
