import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { staticEgressAdmissionFixture } from "../helpers/static-egress.mjs";

export function registerStartupAdmissionCases(): void {
  test("public Source enrollment rejects Gateway credential bodies before material or registration", async (t) => {
    for (const gatewayOnly of [false, true]) {
      const f = await staticEgressAdmissionFixture(t, { gatewayOnly });
      const before = {
        reads: { ...f.materialReads },
        secretReads: f.countSecretReads(),
        effects: [...f.gatewayEffects],
        rows: await f.controller.transact((unit: PlatformUnitOfWork) =>
          unit.credentialSources.listCredentialSources(f.namespace.id),
        ),
      };
      const result = await f.request("POST", f.path, {
        body: {
          name: "unsupported-gateway-source",
          type: "openai",
          config: { authorized_base_url: f.modelProvider.baseUrl },
          secrets: { api_key: f.secret.ref },
        },
      });
      assert.equal(result.status, 400, JSON.stringify(result.body));
      assert.ok(Check(ErrorResponse, result.body));
      assert.equal(result.body.error.code, "INVALID_REQUEST");
      assert.deepEqual(f.materialReads, before.reads);
      assert.equal(f.countSecretReads(), before.secretReads);
      assert.deepEqual(f.gatewayEffects, before.effects);
      assert.deepEqual(
        await f.controller.transact((unit: PlatformUnitOfWork) =>
          unit.credentialSources.listCredentialSources(f.namespace.id),
        ),
        before.rows,
      );
    }
  });
}
