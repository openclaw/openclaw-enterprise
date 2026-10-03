import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

// Storage/admission integration only: the HTTP suite separately proves IAM
// authorization. These server-only operations model an already authorized key
// manager; referenceId can belong to an external IAM Driver, not a local user.
test(
  "PostgreSQL Better Auth keys remain hashed, scoped, and revocable across instances",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    let key;
    t.after(async () => {
      try {
        if (key) {
          await issuer.revokeServiceKey(key);
        }
      } finally {
        await pool.end();
      }
    });
    const installationId = `ins_${randomUUID()}`;
    const namespaceId = `ns_${randomUUID()}`;
    const options = {
      pool,
      installationId,
      mode: "development",
      baseURL: "http://127.0.0.1",
      secret: `storage-test-${randomUUID()}`,
      secureCookies: false,
    };
    const issuer = await createPostgresControllerAuth(options);
    const verifier = await createPostgresControllerAuth(options);
    const principal = {
      kind: "service_principal",
      id: `external-automation-${randomUUID()}`,
      namespaceId,
    };
    key = await issuer.createServiceKey({ principal, name: "storage-proof" });
    const stored = await pool.query(
      "SELECT key, reference_id, metadata FROM occ.apikey WHERE id = $1",
      [key.id],
    );
    assert.equal(stored.rowCount, 1);
    assert.notEqual(stored.rows[0].key, key.key);
    assert.equal(stored.rows[0].reference_id, principal.id);
    assert.deepEqual(JSON.parse(stored.rows[0].metadata), { installationId, namespaceId });
    const request = {
      requestId: `req_${randomUUID()}`,
      method: "GET",
      routeId: "getNamespace",
      requestedScope: { installationId, namespaceId },
      transport: { remoteAddress: "127.0.0.1" },
      headers: { "x-api-key": key.key },
    };
    const admitted = await verifier.admissionVerifier.verify(request);
    assert.equal(admitted.method, "api_key");
    assert.equal(admitted.externalIdentity.subject, principal.id);
    assert.deepEqual(admitted.admittedScope, { installationId, namespaceId });
    assert.equal((await verifier.getServiceKey(key.id)).id, key.id);
    await assert.rejects(
      verifier.admissionVerifier.verify({ ...request, headers: { "x-api-key": "forged" } }),
      { status: 401 },
    );

    // Sharing a physical auth store must not admit a key under another Installation.
    const foreignInstallation = `ins_${randomUUID()}`;
    const foreign = await createPostgresControllerAuth({
      ...options,
      installationId: foreignInstallation,
    });
    await assert.rejects(
      foreign.admissionVerifier.verify({
        ...request,
        requestedScope: { installationId: foreignInstallation, namespaceId },
      }),
      { status: 401 },
    );
    assert.equal(await foreign.getServiceKey(key.id), undefined);

    // Deletion cannot be undone by the plugin's concurrent verification updates.
    const inFlight = Array.from({ length: 4 }, () =>
      verifier.admissionVerifier.verify(request).catch((error) => {
        assert.equal(error.status, 401);
      }),
    );
    await issuer.revokeServiceKey(key);
    await Promise.all(inFlight);
    assert.equal(
      (await pool.query("SELECT id FROM occ.apikey WHERE id = $1", [key.id])).rowCount,
      0,
    );
    await assert.rejects(verifier.admissionVerifier.verify(request), { status: 401 });
    assert.equal(await verifier.getServiceKey(key.id), undefined);
  },
);
