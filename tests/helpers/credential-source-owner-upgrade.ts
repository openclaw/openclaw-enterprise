import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  credentialFreeMetadataGrant,
  credentialFreeProviderRef,
  githubMetadataGrant,
  preparedGitHubProviderRef,
} from "../../packages/contracts/src/index.ts";

/** Insert into real 0066, where owner_capability does not exist. No credential or issuer is used. */
export async function retainGatewaySourcesAcrossProxyAdmission(
  app: pg.Client,
  migrator: pg.Client,
  namespaceId: string,
) {
  const generation = 1;
  const ref = { id: "source-owner", generation };
  const config = {
    origin: "https://fixture.example.test",
    repository_id: "7",
    repository: "fixture/metadata",
    authority: "execution",
    agent_id: `agt_${randomUUID()}`,
    app_id: "8",
    installation_id: "9",
  };
  for (const [provider, grant, schemaVersion, adoption] of [
    [credentialFreeProviderRef, credentialFreeMetadataGrant(config), 3, "credential_free"],
    [preparedGitHubProviderRef, githubMetadataGrant(config), 2, "prepared"],
  ] as const) {
    const id = `cs_${randomUUID()}`;
    const egress = {
      key: {
        installationId: `ins_${randomUUID()}`,
        namespaceId,
        source: { id, generation },
        backend: ref,
        provider,
      },
      grant,
      schemaVersion,
      adoption,
      retention: "none",
      origin: config.origin,
      sender: ref,
      resolver: ref,
    };
    await app.query(
      `INSERT INTO occ.credential_sources(id,namespace_id,name,type,config,driver_id,state,created_at,egress)
       VALUES($1,$2,$3,$3,$4,$5,'ready',clock_timestamp(),$6)`,
      [id, namespaceId, provider.id, config, ref.id, egress],
    );
  }
  async function sources(omitOwner: boolean) {
    return (
      await app.query(
        `SELECT to_jsonb(s) ${omitOwner ? "- 'owner_capability'" : ""} AS source
       FROM occ.credential_sources s WHERE namespace_id=$1 ORDER BY id`,
        [namespaceId],
      )
    ).rows.map((row) => row.source);
  }
  const before = await sources(false);
  assert.equal(before.length, 2);
  return async function assertOwnershipAfterUpgrade() {
    assert.deepEqual(
      await sources(true),
      before,
      "every historical source field survives unchanged",
    );
    assert.deepEqual(
      (await sources(false)).map(({ owner_capability }) => owner_capability),
      ["credential_gateway", "credential_gateway"],
      "protected sources were admitted by the Gateway through 0066",
    );
    const id = before[0].id;
    const relabel =
      "UPDATE occ.credential_sources SET owner_capability='credential_proxy' WHERE id=$1";
    await assert.rejects(app.query(relabel, [id]), { code: "42501" });
    await assert.rejects(migrator.query(relabel, [id]), { code: "55000" });
    // A stale writer after the cutover must fail, rather than implicitly create a Gateway owner.
    await assert.rejects(
      app.query(
        `INSERT INTO occ.credential_sources(id,namespace_id,name,type,config,driver_id,state,created_at)
       VALUES($1,$2,'unspecified owner','openai','{}',$3,'ready',now())`,
        [`cs_${randomUUID()}`, namespaceId, ref.id],
      ),
      { code: "23502", column: "owner_capability" },
    );
  };
}
