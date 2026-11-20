import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  CredentialSourceResponse,
  CredentialSourceSchema,
  SecretResponse,
  SecretSchema,
} from "../../packages/contracts/src/api/resources.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { staticEgressAdmissionFixture } from "../helpers/static-egress.mjs";

type AdmissionFixture = Awaited<ReturnType<typeof staticEgressAdmissionFixture>>;
type HttpResponse = { status: number; body: unknown };

function entries(map: ReadonlyMap<unknown, unknown>): [string, unknown][] {
  return [...map].map(([key, value]) => {
    assert.ok(typeof key === "string", "Gateway map key");
    return [key, value];
  });
}

function providerEntries(f: AdmissionFixture): [string, Record<string, unknown>][] {
  return entries(f.providers).map(([key, value]) => {
    const provider = asRecord(value);
    assert.ok(provider, "Gateway provider");
    return [key, provider];
  });
}

function wireRequestId(wire: readonly unknown[], index: number): string {
  const id = asRecord(asRecord(wire[index])?.request)?.request_id;
  assert.ok(typeof id === "string", "Gateway request ID");
  return id;
}

const retirementError = {
  code: "RESOURCE_CONFLICT",
  message:
    "The selected Driver has retired new uses of this protected static credential provider. Ask an Installation administrator to configure a supported model access path.",
};

function assertRetired(response: HttpResponse): void {
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(asRecord(response.body)?.error, retirementError);
}

async function admissionSnapshot(f: AdmissionFixture) {
  const controller = asRecord(f)?.controller;
  assert.ok(controller instanceof OpenClawController);
  const gatewayEffects: readonly unknown[] = f.gatewayEffects;
  const requests: readonly unknown[] = f.providerRequests;
  return {
    rows: structuredClone(
      await controller.transact((unit) =>
        unit.credentialSources.listCredentialSources(f.namespace.id),
      ),
    ),
    audit: structuredClone(await controller.transact((unit) => unit.audit.list())),
    materialReads: { ...f.materialReads },
    secretReads: f.countSecretReads(),
    gatewayEffects: [...gatewayEffects],
    providers: structuredClone(providerEntries(f)),
    requests: [...requests],
  };
}

async function assertAdmissionUnchanged(
  f: AdmissionFixture,
  before: Awaited<ReturnType<typeof admissionSnapshot>>,
): Promise<void> {
  const after = await admissionSnapshot(f);
  // Denial audit is allowed; neither registration nor another success may be recorded.
  assert.deepEqual(
    after.audit.filter((event) => event.outcome === "success"),
    before.audit.filter((event) => event.outcome === "success"),
  );
  assert.deepEqual({ ...after, audit: [] }, { ...before, audit: [] });
}

export function registerStartupAdmissionCases(): void {
  test("bundled OpenShell startup refuses mixed static CREATE before material or registration; Gateway-only CREATE and PATCH remain ordinary", async (t) => {
    for (const gatewayOnly of [false, true]) {
      const f = await staticEgressAdmissionFixture(t, { gatewayOnly });
      const controller = asRecord(f)?.controller;
      assert.ok(controller instanceof OpenClawController);
      assert.ok("fixtureResponse" in f, "console fixture response decoder");
      const secret: unknown = asRecord(f)?.secret;
      assert.ok(Check(SecretSchema, secret), "fixture Secret");
      const before = await admissionSnapshot(f);
      const result: HttpResponse = await f.request("POST", f.path, {
        body: {
          name: "retirement-control",
          type: "openai",
          config: { authorized_base_url: f.modelProvider.baseUrl },
          secrets: { api_key: secret.ref },
        },
      });
      if (!gatewayOnly) {
        assertRetired(result);
        await assertAdmissionUnchanged(f, before);
      } else {
        assert.equal(result.status, 201, JSON.stringify(result.body));
        const resultData = f.fixtureResponse(
          result,
          201,
          CredentialSourceResponse,
          "create credential source",
        ).data;
        assert.equal(resultData.egress, undefined);
        assert.equal(f.materialReads.ordinary, before.materialReads.ordinary + 1);
        assert.equal(f.materialReads.versioned, before.materialReads.versioned);
        assert.deepEqual(f.gatewayEffects, [...before.gatewayEffects, "registerSource"]);
        const rows = await controller.transact((unit) =>
          unit.credentialSources.listCredentialSources(f.namespace.id),
        );
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.ok(row);
        assert.equal(row.ownerCapability, "credential_gateway");
        assert.equal(row.driverId, "openshell-credentials");
        assert.deepEqual(row.secrets, { api_key: secret.ref });
        assert.equal(
          asRecord(providerEntries(f)[0]?.[1].credentials)?.OPENAI_API_KEY,
          "synthetic-key-initial",
        );
        assert.deepEqual(f.providerRequests, []);

        const replacement: HttpResponse = await f.request(
          "POST",
          `/namespaces/${f.namespace.id}/secrets`,
          {
            body: { name: "ordinary-replacement", value: "synthetic-key-replacement" },
          },
        );
        assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
        const replacementData = f.fixtureResponse(
          replacement,
          201,
          SecretResponse,
          "create replacement Secret",
        ).data;
        const original = structuredClone(row);
        const entry = structuredClone(providerEntries(f))[0];
        assert.ok(entry);
        const [name, provider] = entry;
        const metadata = asRecord(provider.metadata);
        assert.ok(metadata, "Gateway provider metadata");
        const profiles = structuredClone(entries(f.profiles));
        const updateBefore = await admissionSnapshot(f);
        const gatewayRequests: readonly unknown[] = f.gatewayRequests;
        const wireStart = gatewayRequests.length;
        const updated: HttpResponse = await f.request("PATCH", `${f.path}/${original.id}`, {
          body: { secrets: { api_key: replacementData.ref } },
        });
        assert.equal(updated.status, 200, JSON.stringify(updated.body));
        const updatedData = f.fixtureResponse(
          updated,
          200,
          CredentialSourceResponse,
          "update credential source",
        ).data;
        assert.deepEqual(updatedData, {
          ...resultData,
          secrets: { api_key: replacementData.ref },
          status: { state: "ready" },
        });
        const updatedRows = await controller.transact((unit) =>
          unit.credentialSources.listCredentialSources(f.namespace.id),
        );
        assert.deepEqual(updatedRows, [{ ...original, secrets: { api_key: replacementData.ref } }]);
        const updatedRow = updatedRows[0];
        assert.ok(updatedRow);
        assert.equal(updatedRow.egress, undefined);
        assert.equal(updatedRow.state, "ready");
        assert.deepEqual(providerEntries(f), [
          [
            name,
            {
              ...provider,
              metadata: { ...metadata, resource_version: "2" },
              credentials: { OPENAI_API_KEY: "synthetic-key-replacement" },
            },
          ],
        ]);
        assert.deepEqual(entries(f.profiles), profiles);
        const wire = gatewayRequests.slice(wireStart);
        assert.equal(wire.length, 2);
        assert.match(wireRequestId(wire, 1), /^[0-9a-f-]{36}$/);
        assert.deepEqual(wire, [
          {
            method: "GetProvider",
            request: { name, workspace_scope: { workspace: f.namespace.name } },
            found: true,
          },
          {
            method: "UpdateProvider",
            request: {
              provider: {
                metadata: { name },
                credentials: { OPENAI_API_KEY: "synthetic-key-replacement" },
              },
              workspace_scope: { workspace: f.namespace.name },
              // The empty credential_expiration_times map is omitted on the wire.
              request_id: wireRequestId(wire, 1),
            },
          },
        ]);
        assert.equal(f.materialReads.ordinary, updateBefore.materialReads.ordinary + 1);
        assert.equal(f.materialReads.versioned, updateBefore.materialReads.versioned);
        assert.equal(f.countSecretReads(), updateBefore.secretReads + 1);
        assert.deepEqual(f.gatewayEffects, [...updateBefore.gatewayEffects, "updateSource"]);
        assert.deepEqual(f.providerRequests, []);

        // A bound source must be unbound before adoption, even without a Proxy.
        const config = await f.createConfiguration(f.namespace.id, {
          agents: {
            defaults: {
              model: { primary: "codex/fixture-model" },
              models: { "codex/fixture-model": { agentRuntime: { id: "codex" } } },
            },
          },
        });
        const agent: HttpResponse = await f.request(
          "POST",
          `/namespaces/${f.namespace.id}/agents`,
          {
            body: {
              name: "bound-model",
              configurationId: config.id,
              executionMode: "dedicated",
              harnessAuth: { method: "credential_source", sourceId: original.id },
              credentialSources: [{ sourceId: original.id }],
            },
          },
        );
        assert.equal(agent.status, 201, JSON.stringify(agent.body));
        const prior = await admissionSnapshot(f);
        const bound: HttpResponse = await f.request("PATCH", `${f.path}/${original.id}`, {
          body: { adoption: "live", authorityScope: "execution" },
        });
        assert.deepEqual(
          { status: bound.status, reason: asRecord(asRecord(bound.body)?.error)?.message },
          { status: 409, reason: "Protected source changes require an unbound source." },
        );
        await assertAdmissionUnchanged(f, prior);
      }
    }
  });

  test("bundled OpenShell startup refuses unbound legacy adoption; original Gateway DELETE remains available", async (t) => {
    let clock = Date.now();
    const f = await staticEgressAdmissionFixture(t, {
      includeLegacy: true,
      now: () => new Date(clock),
    });
    const controller = asRecord(f)?.controller;
    assert.ok(controller instanceof OpenClawController);
    assert.ok("fixtureResponse" in f, "console fixture response decoder");
    const secret: unknown = asRecord(f)?.secret;
    assert.ok(Check(SecretSchema, secret), "fixture Secret");
    const legacySource: unknown = asRecord(f)?.legacySource;
    assert.ok(Check(CredentialSourceSchema, legacySource), "fixture legacy credential source");
    const replacement: HttpResponse = await f.request(
      "POST",
      `/namespaces/${f.namespace.id}/secrets`,
      {
        body: { name: "replacement", value: "synthetic-key-replacement" },
      },
    );
    assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
    const replacementData = f.fixtureResponse(
      replacement,
      201,
      SecretResponse,
      "create replacement Secret",
    ).data;
    const before = await admissionSnapshot(f);
    assertRetired(
      await f.request("PATCH", `${f.path}/${legacySource.id}`, {
        body: {
          adoption: "live",
          authorityScope: "execution",
          secrets: { api_key: replacementData.ref },
        },
      }),
    );
    await assertAdmissionUnchanged(f, before);

    // The original unbound Gateway copy remains deletable in the mixed installation.
    const legacy = await controller.transact((unit) =>
      unit.credentialSources.findCredentialSource(f.namespace.id, legacySource.id),
    );
    assert.ok(legacy);
    assert.equal(legacy.ownerCapability, "credential_gateway");
    assert.equal(legacy.driverId, "openshell-credentials");
    assert.equal(legacy.state, "ready");
    assert.equal(legacy.egress, undefined);
    assert.equal(legacy.createdAt, new Date(clock).toISOString());
    assert.deepEqual(legacy.secrets, { api_key: secret.ref });
    assert.deepEqual(legacySource.ref, {
      kind: "credential_source",
      namespaceId: f.namespace.id,
      id: legacy.id,
    });
    const entry = providerEntries(f)[0];
    assert.ok(entry);
    const [name, provider] = entry;
    const metadata = asRecord(provider.metadata);
    assert.ok(metadata, "Gateway provider metadata");
    const providers: Map<unknown, unknown> = f.providers;
    const profiles: ReadonlyMap<unknown, unknown> = f.profiles;
    assert.equal(providers.size, 1);
    assert.equal(asRecord(metadata.labels)?.["openclaw.dev/credential-source-id"], legacy.id);
    assert.ok(profiles.has(name));
    // An unrelated fake provider is a sentinel, never a substitute for the real target.
    const unrelated = structuredClone(provider);
    unrelated.metadata = {
      ...metadata,
      name: "unrelated-provider",
      id: "unrelated-id",
      labels: {},
    };
    const unrelatedMetadata = asRecord(unrelated.metadata);
    assert.ok(typeof unrelatedMetadata?.name === "string", "unrelated provider name");
    providers.set(unrelatedMetadata.name, unrelated);
    const deleteBefore = await admissionSnapshot(f);
    const profilesBefore = structuredClone(entries(profiles));
    const gatewayRequests: readonly unknown[] = f.gatewayRequests;
    const wireStart = gatewayRequests.length;
    // Two 30-second Gateway operation windows plus the 10-second registration grace.
    clock = Date.parse(legacy.createdAt) + 70_001;
    const deleted: HttpResponse = await f.request("DELETE", `${f.path}/${legacy.id}`);
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
    const wire = gatewayRequests.slice(wireStart);
    assert.equal(wire.length, 4);
    for (const index of [1, 3]) {
      assert.match(wireRequestId(wire, index), /^[0-9a-f-]{36}$/);
    }
    assert.deepEqual(wire, [
      {
        method: "GetProvider",
        request: { name, workspace_scope: { workspace: f.namespace.name } },
        found: true,
      },
      {
        method: "DeleteProvider",
        request: {
          name,
          workspace_scope: { workspace: f.namespace.name },
          allow_missing: true,
          request_id: wireRequestId(wire, 1),
        },
      },
      {
        method: "GetProvider",
        request: { name, workspace_scope: { workspace: f.namespace.name } },
        found: false,
      },
      {
        method: "DeleteProviderProfile",
        request: {
          id: name,
          workspace_scope: { workspace: f.namespace.name },
          allow_missing: true,
          request_id: wireRequestId(wire, 3),
        },
      },
    ]);
    assert.deepEqual(
      providerEntries(f),
      deleteBefore.providers.filter(([id]) => id !== name),
    );
    assert.equal(providers.has(name), false);
    assert.equal(profiles.has(name), false);
    assert.deepEqual(
      entries(profiles),
      profilesBefore.filter(([id]) => id !== name),
    );
    const deleteAfter = await admissionSnapshot(f);
    assert.deepEqual(
      deleteAfter.rows,
      deleteBefore.rows.filter((row) => row.id !== legacy.id),
    );
    assert.equal(
      await controller.transact((unit) =>
        unit.credentialSources.findCredentialSource(f.namespace.id, legacy.id),
      ),
      undefined,
    );
    assert.deepEqual(deleteAfter.materialReads, deleteBefore.materialReads);
    assert.equal(deleteAfter.secretReads, deleteBefore.secretReads);
    assert.deepEqual(f.gatewayEffects, [...deleteBefore.gatewayEffects, "removeSource"]);
    assert.deepEqual(f.providerRequests, []);
  });
}
