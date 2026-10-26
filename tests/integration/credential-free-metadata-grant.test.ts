import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import test, { type TestContext } from "node:test";
import {
  credentialFreeMetadataGrant,
  type Agent,
  type CredentialProviderDefinition,
  type Namespace,
} from "../../packages/contracts/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import type { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { captureMetadata } from "../helpers/github-metadata-exchange.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

const digest = (grant: unknown) => createHash("sha256").update(JSON.stringify(grant)).digest("hex");
type FixtureApp = {
  controller: OpenClawController;
  request: (
    method: string,
    path: string,
    options: { body: object },
  ) => ReturnType<Awaited<ReturnType<typeof createConsoleAppFixture>>["request"]>;
};

async function metadataFixture(t: TestContext, reordered: boolean) {
  let driverGrant!: object;
  let setGrant!: (grant: unknown) => void;
  let restoreProvider!: () => void;
  let countSecretReads!: () => number;
  let originRequests = 0;
  const options = {
    admitRevision: reordered,
    providerServer: new Proxy(createHttpsServer, {
      apply(target, receiver, args) {
        const server = Reflect.apply(target, receiver, args) as ReturnType<
          typeof createHttpsServer
        >;
        server.on("request", () => originRequests++);
        return server;
      },
    }),
    async admitSource({
      app,
      agent,
      namespace,
      path,
      origin,
      countSecretReads: readCount,
    }: {
      app: FixtureApp;
      agent: Agent;
      namespace: Namespace;
      path: string;
      origin: string;
      countSecretReads: () => number;
    }) {
      countSecretReads = readCount;
      const providers = app.controller.selectedDriver("credential_proxy").sourceControl
        .providers as CredentialProviderDefinition[];
      const index = providers.findIndex(
        (entry) => entry.ref.id === "credential-free-repository-metadata",
      );
      const provider = providers[index];
      assert.ok(provider);
      setGrant = (grant) => {
        // Replace only the fixture's Driver output; admission and authorization remain real.
        providers[index] = {
          ...provider,
          normalizeGrant: () => grant as ReturnType<CredentialProviderDefinition["normalizeGrant"]>,
        };
      };
      restoreProvider = () => {
        providers[index] = provider;
      };
      const created = await app.request("POST", path, {
        body: {
          name: "metadata-order",
          type: "credential-free-repository-metadata",
          config: {
            origin,
            repository_id: "7311",
            repository: "fixture/credential-free",
            agent_id: agent.id,
            authority: "execution",
          },
        },
      });
      assert.equal(created.status, 201);
      driverGrant = provider.normalizeGrant([], created.data.config);
      if (reordered) {
        driverGrant = Object.fromEntries(Object.entries(driverGrant).reverse());
        setGrant(driverGrant);
      }
      const bound = await app.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        body: {
          configurationId: agent.configurationId,
          harnessAuth: { method: "runtime" },
          credentialSources: [{ sourceId: created.data.id }],
        },
      });
      assert.equal(bound.status, 200);
      return { agent: bound.data, source: created.data };
    },
  };
  const f = await staticEgressFixture(t, options);
  return {
    f,
    driverGrant,
    setGrant,
    restoreProvider,
    effects: () => ({ originRequests, secretReads: countSecretReads() }),
  };
}

test("credential-free metadata exchange accepts a reordered Driver grant", async (t) => {
  const { f, driverGrant } = await metadataFixture(t, true);
  assert.ok("revision" in f && f.revision?.egressPlan);
  const canonical = credentialFreeMetadataGrant(f.source.config);
  assert.notEqual(digest(driverGrant), digest(canonical));
  const binding = f.revision.egressPlan.routes[0]?.binding;
  assert.ok(binding);
  assert.equal(binding.grantHash, digest(canonical));
  const reads = f.secretReads;
  const captured = captureMetadata(f);
  const resolution = await f.resolve(captured);
  assert.ok(resolution.ready_without_material);
  const permit = f.permitRequest(captured, resolution.ready_without_material, { noMaterial: true });
  assert.equal((await f.authorize(permit)).allowed.no_material_required, true);
  const identity = { id: 7311, full_name: "fixture/credential-free" };
  f.setResponse({ status: 200, body: { ...identity, private: "must not escape" } });
  const released = await f.protect(captured, await f.send(captured, { credential_headers: [] }));
  assert.equal(released.response_complete, true);
  assert.deepEqual(JSON.parse(released.body), identity);
  assert.equal(f.providerRequests.length, 1);
  assert.equal(f.providerRequests[0]?.authorization, undefined);
  assert.equal(f.secretReads, reads);
});

test("credential-free route admission rejects changed, missing and undefined extra grant fields", async (t) => {
  const { f, setGrant, restoreProvider, effects } = await metadataFixture(t, false);
  const before = effects();
  const controller: OpenClawController = f.controller;
  const revisions = () =>
    controller.transact((state) => state.revisions.listRevisions(f.namespace.id, f.agent.id));
  assert.deepEqual(await revisions(), []);
  const canonical = credentialFreeMetadataGrant(f.source.config);
  const { repositoryId: _repositoryId, ...missingRepositoryId } = canonical;
  for (const [name, grant] of [
    ["changed repositoryId", { ...canonical, repositoryId: "7312" }],
    ["missing repositoryId", missingRepositoryId],
    ["undefined extra field", { ...canonical, extra: undefined }],
  ] as const) {
    setGrant(grant);
    const result = await f.request(
      "POST",
      `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`,
    );
    assertApiError(result, 404, "NOT_FOUND", name);
    assert.deepEqual(await revisions(), [], name);
    assert.deepEqual(effects(), before, name);
  }
  // The same Agent admits a valid grant, making the masked refusals meaningful.
  restoreProvider();
  await f.deployAgent(f.namespace.id, f.agent.id);
  assert.equal((await revisions()).length, 1);
  assert.deepEqual(effects(), before);
});
