import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { protectedMetadataFixture } from "../helpers/static-egress.mjs";

export function registerStartupAdmissionCases(): void {
  test("Source enrollment refuses retired Gateway inference without reading material", async (t) => {
    const f = await protectedMetadataFixture(t, { admitRevision: false });
    const sources = () =>
      f.controller.transact((unit: PlatformUnitOfWork) =>
        unit.credentialSources.listCredentialSources(f.namespace.id),
      );
    const before = await sources();
    const reads = f.countSecretReads();
    const result = await f.request("POST", f.path, {
      body: {
        name: "retired-model-source",
        type: "openai",
        config: { authorized_base_url: f.modelProvider.baseUrl },
        secrets: { api_key: f.secret.ref },
      },
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.code, "INVALID_REQUEST");
    assert.match(result.body.error.message, /through CredentialService/);
    assert.equal(f.countSecretReads(), reads);
    assert.deepEqual(await sources(), before);
  });
}
