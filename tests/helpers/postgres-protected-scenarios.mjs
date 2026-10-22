import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { databaseUrl } from "./postgres-database.mjs";
import { postgresApp } from "./postgres-egress-app.mjs";
import { staticEgressFixture } from "./static-egress.mjs";

export async function bindRuntimeSource(app, namespace, agent, source) {
  const bound = await app.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: {
      configurationId: agent.configurationId,
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: source.id }],
    },
  });
  assert.equal(bound.status, 200);
  return { agent: bound.data, source };
}

export function noMaterialSelection(result, captured) {
  assert.equal(result.ready, undefined, "no credential-bearing selection");
  const selection = result.ready_without_material;
  assert.ok(selection, "explicit no-material selection");
  assert.ok(Buffer.isBuffer(selection.operation_handle) && selection.operation_handle.length > 0);
  assert.deepEqual(selection, {
    audience: captured.audience,
    operation_handle: selection.operation_handle,
    request_id: captured.request.context.request_id,
  });
  return selection;
}

export async function commitLossScenario(t, options) {
  const proxy = await commitAckProxy(databaseUrl, { egressDispatch: true });
  const f = await staticEgressFixture(t, {
    ...options,
    appFactory: (t, opts) => postgresApp(t, opts, proxy.url),
  });
  // Register after the app's pool shutdown; closing its transport early would inject a second fault.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  t.after(async () => {
    await pool.end();
    await proxy.close();
  });
  const receipt = async (captured) => {
    const { rows } = await pool.query(
      "SELECT binding, authorized_dispatch AS dispatch, outcome, observation, settled, feedback FROM occ.egress_send_receipts WHERE use_id=$1",
      [captured.request.context.request_id],
    );
    assert.equal(rows.length, 1, "only one receipt for this request");
    return rows[0];
  };
  return {
    f,
    proxy,
    pool,
    receipt,
    async assertLostDispatch(captured, { noMaterial = false } = {}) {
      const count = f.providerRequests.length;
      const authorizations = proxy.egress.authorizations;
      const custodyId = createHash("sha256").update(captured.response_custody).digest("hex");
      let committed;
      for (const phase of ["lose dispatch COMMIT reply", "retry after authority restart"]) {
        const result = await f.resolve(captured);
        const ready = noMaterial ? noMaterialSelection(result, captured) : result.ready;
        assert.ok(ready, phase + ": select again with the original request still live");
        const permit = f.permitRequest(captured, ready, { noMaterial });
        if (!committed) {
          proxy.arm({ instanceId: f.installation.enforcement.instanceId });
        }
        const decision = await f.authorize(permit);
        // Exercise a permit if one escapes, so the origin count is an independent observation.
        if (decision.allowed) {
          await f.send(captured, noMaterial ? { credential_headers: [] } : ready);
        }
        assert.ok(decision.refused, phase);
        assert.equal(proxy.observedCommit, true, "consumed the server's actual dispatch COMMIT");
        assert.equal(f.providerRequests.length, count, phase + ": no request reached the origin");
        assert.equal(
          proxy.egress.authorizations,
          authorizations + 1,
          "exactly one durable dispatch",
        );
        const row = await receipt(captured);
        if (committed) {
          assert.deepEqual(row, committed, "restart must not replay or rewrite uncertain dispatch");
        } else {
          assert.deepEqual(row.outcome, { kind: "uncertain", dispatch: "possible" });
          assert.equal(row.observation, null);
          assert.equal(row.dispatch.association.custodyId, custodyId);
          assert.equal(
            row.dispatch.injectionDigest,
            permit.credential_headers_sha256.toString("hex"),
          );
          committed = row;
          await f.restartAuthority();
        }
      }
    },
  };
}
