import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import { CredentialSourceResponse } from "../../packages/contracts/src/api/resources.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { staticEgressAdmissionFixture } from "../helpers/static-egress.mjs";

export function registerStartupAdmissionCases(): void {
  test("Source enrollment preserves Gateway-only registration and refuses retired protected static providers", async (t) => {
    for (const gatewayOnly of [false, true]) {
      const f = await staticEgressAdmissionFixture(t, { gatewayOnly });
      const controller: unknown = f.controller;
      assert.ok(controller instanceof OpenClawController);
      const before = {
        reads: { ...f.materialReads },
        secretReads: f.countSecretReads(),
        effects: [...f.gatewayEffects],
        rows: await controller.transact((unit) =>
          unit.credentialSources.listCredentialSources(f.namespace.id),
        ),
      };
      const result = await f.request("POST", f.path, {
        body: {
          name: "model-source-retirement",
          type: "openai",
          config: { authorized_base_url: f.modelProvider.baseUrl },
          secrets: { api_key: f.secret.ref },
        },
      });
      const rows = await controller.transact((unit) =>
        unit.credentialSources.listCredentialSources(f.namespace.id),
      );
      if (gatewayOnly) {
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.ok(Check(CredentialSourceResponse, result.body));
        const source = result.body.data;
        assert.ok("ownerCapability" in source);
        assert.equal(source.ownerCapability, "credential_gateway");
        assert.deepEqual(source.secrets, { api_key: f.secret.ref });
        assert.equal(f.materialReads.ordinary, before.reads.ordinary + 1);
        assert.equal(f.materialReads.versioned, before.reads.versioned);
        assert.deepEqual(f.gatewayEffects, [...before.effects, "registerSource"]);
        assert.equal(rows.length, before.rows.length + 1);
        assert.equal(
          rows.find((row) => row.id === source.id)?.ownerCapability,
          "credential_gateway",
        );
        continue;
      }
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.ok(Check(ErrorResponse, result.body));
      assert.equal(result.body.error.code, "RESOURCE_CONFLICT");
      assert.match(
        result.body.error.message,
        /retired new uses of this protected static credential provider/,
      );
      assert.deepEqual(f.materialReads, before.reads);
      assert.equal(f.countSecretReads(), before.secretReads);
      assert.deepEqual(f.gatewayEffects, before.effects);
      assert.deepEqual(rows, before.rows);
    }
  });
}
