import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { boundedTeardown } from "../helpers/bounded-teardown.ts";
import { createOpenShellNamespaceLifecycle } from "../helpers/openshell-namespace-lifecycle.ts";

function uid(resource: unknown) {
  const value = asRecord(asRecord(resource)?.metadata)?.uid;
  assert.ok(typeof value === "string" && value.length > 0, "expected a Kubernetes resource UID");
  return value;
}

function signingIdentity(secret: unknown) {
  const data = asRecord(asRecord(secret)?.data);
  const fields = ["signing.pem", "public.pem", "kid"].map((name) => data?.[name]);
  assert.ok(
    fields.every((value) => typeof value === "string" && value.length > 0),
    "gateway signing material is incomplete",
  );
  return {
    uid: uid(secret),
    digest: createHash("sha256").update(JSON.stringify(fields)).digest("hex"),
  };
}

test(
  "OpenShell recovers a failed Namespace in place without rotating its signing key",
  {
    skip:
      process.env.OCC_TEST_NAMESPACE_OPENSHELL_RECOVERY_REAL !== "1" &&
      "Select the openshell-namespace-recovery lane with disposable k3d infrastructure.",
    timeout: 1_200_000,
  },
  async (t) => {
    const { context } = boundedTeardown(t, { label: "OpenShell Namespace recovery" });
    const {
      fixture,
      configuration,
      originalQuota,
      startupPath,
      initial,
      worker,
      startWorker,
      loadDrivers,
      prepareNamespace,
      placements,
      request,
      service,
      connected,
      pool,
      namespaceOutcomes,
    } = await createOpenShellNamespaceLifecycle(context, true);
    // The authenticated creator must also be the actor that requests recovery.
    const created = await request("POST", "/namespaces", { name: "quota-recoverable" });
    assert.equal(created.status, 201);
    const namespaceId: string = created.data.id;
    placements.push(kubernetesNamespaceName(initial[0].id));
    const namespacePath = `/namespaces/${namespaceId}`;
    await worker.start();
    const placement = await prepareNamespace(namespaceId);
    const keyName = `${service}-jwt-keys`;

    // The quota must block the Service after the Sandbox Driver creates its signing Secret.
    await fixture.waitFor("Namespace reaches terminal failure", async () => {
      const observed = await request("GET", namespacePath);
      assert.equal(observed.status, 200);
      assert.notEqual(
        observed.data.status,
        "ready",
        "the Service quota did not block provisioning",
      );
      return observed.data.status === "failed" ? true : undefined;
    });
    const initialBackingUid = uid(await fixture.resource("namespace", placement));
    const initialKey = signingIdentity(await fixture.resource("secret", keyName, placement));
    assert.equal(await fixture.maybeResource("service", service, placement), undefined);
    const readWork = async () =>
      (
        await pool.query(
          "select idempotency_key, state, provisioning_retry_at from occ.controller_work where namespace_id = $1 and namespace_target = 'ready'",
          [namespaceId],
        )
      ).rows;
    const failedWork = await readWork();
    assert.equal(failedWork.length, 1);
    assert.equal(failedWork[0].state, "failed_permanent");

    // Repair the installed configuration, then ask the API to requeue the same Namespace.
    await worker.stop();
    configuration.drivers.compute.configuration.resources.namespace.quota = originalQuota;
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    const successor = startWorker(await loadDrivers());
    context.after(() => successor.stop());
    const retry = await request("POST", `${namespacePath}/provision/retry`);
    assert.equal(retry.status, 202);
    const queued = await readWork();
    assert.equal(queued.length, 1, "retry must reuse the ready operation");
    assert.equal(queued[0].idempotency_key, failedWork[0].idempotency_key);
    assert.equal(queued[0].state, "queued");
    assert.ok(queued[0].provisioning_retry_at, "retry must record a new provisioning window");
    await successor.start();
    await fixture.waitFor(
      "the same Namespace becomes ready",
      async () => {
        const observed = await request("GET", namespacePath);
        assert.equal(observed.status, 200);
        assert.equal(observed.data.id, namespaceId);
        assert.equal(observed.data.name, "quota-recoverable");
        assert.notEqual(
          observed.data.status,
          "failed",
          JSON.stringify(namespaceOutcomes.slice(-5)),
        );
        return observed.data.status === "ready" ? true : undefined;
      },
      300_000,
    );

    assert.equal(uid(await fixture.resource("namespace", placement)), initialBackingUid);
    const recoveredKey = signingIdentity(await fixture.resource("secret", keyName, placement));
    assert.equal(recoveredKey.uid, initialKey.uid, "retry replaced the signing Secret");
    assert.ok(recoveredKey.digest === initialKey.digest, "retry rotated gateway signing material");
    const work = await readWork();
    assert.equal(work.length, 1, "retry must reuse the ready operation");
    assert.equal(work[0].state, "succeeded");

    const { client } = await connected(placement);
    await client.health(AbortSignal.timeout(10_000));
    const workspace = await client.getWorkspace(placement, AbortSignal.timeout(10_000));
    assert.equal(workspace?.labels["openclaw.dev/namespace-id"], namespaceId);
    assert.equal(
      (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
      0,
      "Namespace recovery must not require any Agent",
    );
  },
);
