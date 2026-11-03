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

test("Gateway-owned source admission consults its catalog despite a matching Proxy offer", async (t) => {
  const f = await staticEgressFixture(t, { admitRevision: false });
  const controller: OpenClawController = f.controller;
  const gateway = controller.selectedDriver("credential_gateway");
  const providers = controller.selectedDriver("credential_proxy").sourceControl
    .providers as CredentialProviderDefinition[];
  const index = providers.findIndex(
    (provider) => provider.ref.id === "credential-free-repository-metadata",
  );
  const provider = providers[index];
  assert.ok(provider);
  // After the Gateway creates the source, make an offered Proxy provider advertise the same type.
  providers[index] = { ...provider, sourceType: { ...provider.sourceType, type: f.source.type } };
  const agentPath = `/namespaces/${f.namespace.id}/agents/${f.agent.id}`;
  const bound = await f.request("PATCH", agentPath, {
    body: {
      configurationId: f.agent.configurationId,
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: f.source.id }],
    },
  });
  assert.equal(bound.status, 200);
  const revisions = () =>
    controller.transact((state) => state.revisions.listRevisions(f.namespace.id, f.agent.id));
  await f.deployAgent(f.namespace.id, f.agent.id);
  const admitted = await revisions();
  assert.deepEqual(admitted[0]?.credentialSources, [
    { sourceId: f.source.id, sourceType: f.source.type, credentialGatewayId: gateway.id },
  ]);

  const list = gateway.listSourceTypes.bind(gateway);
  const catalog = t.mock.method(
    gateway,
    "listSourceTypes",
    async (...args: Parameters<typeof list>) =>
      (await list(...args)).filter((type) => type.type !== f.source.type),
  );
  const result = await f.request("POST", `${agentPath}/deploy`);
  assertApiError(result, 409, "RESOURCE_CONFLICT");
  assert.match(result.body.error.message, /Credential Gateway does not offer/);
  assert.equal(catalog.mock.callCount(), 1);
  assert.deepEqual(await revisions(), admitted);
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

test("source admission names the Proxy owner when its provider is no longer offered", async (t) => {
  const { f, effects } = await metadataFixture(t, false);
  const controller: OpenClawController = f.controller;
  const gatewayCatalog = t.mock.method(
    controller.selectedDriver("credential_gateway"),
    "listSourceTypes",
  );
  const providers = controller.selectedDriver("credential_proxy").sourceControl
    .providers as CredentialProviderDefinition[];
  const offered = [...providers];
  const restore = () => providers.splice(0, providers.length, ...offered);
  t.after(restore);
  const index = providers.findIndex((entry) => entry.sourceType.type === f.source.type);
  assert.notEqual(index, -1);
  const before = effects();
  // Remove only the provider for the API-created source; other offered types stay available.
  providers.splice(index, 1);
  const result = await f.request(
    "POST",
    `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`,
  );
  assertApiError(result, 409, "RESOURCE_CONFLICT");
  assert.equal(
    result.body.error.message,
    "The Credential Proxy does not offer this credential source type. An Installation administrator must check the selected Credential Proxy's provider configuration and any required token issuer.",
  );
  assert.equal(gatewayCatalog.mock.callCount(), 0);
  assert.deepEqual(effects(), before);
  // Restoring the same provider makes this Agent admissible again.
  restore();
  await f.deployAgent(f.namespace.id, f.agent.id);
  assert.equal(gatewayCatalog.mock.callCount(), 0);
});
