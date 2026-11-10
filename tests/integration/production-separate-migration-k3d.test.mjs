import assert from "node:assert/strict";
import test from "node:test";
import {
  installObservabilityControlPlane,
  observabilitySelection,
} from "../helpers/production-observability-k3d.mjs";

test(
  "separate migration Helm upgrades keep writers stopped until the database passes verification",
  observabilitySelection,
  async (t) => {
    const f = await installObservabilityControlPlane(t);
    const installation = await f.api("GET", "/installation");
    const sql = (statement) =>
      f.kubectl(
        "-n",
        f.system,
        "exec",
        "postgres",
        "--",
        "psql",
        "-U",
        "postgres",
        "-d",
        `openclaw_k8s_observability_${f.suffix}`,
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        statement,
      );
    const receipts = () =>
      sql("SELECT json_agg(m ORDER BY id) FROM drizzle.__drizzle_migrations m");
    const before = await receipts();

    // The operator's maintenance window stops both writers before either database phase.
    await f.kubectl(
      "-n",
      f.system,
      "scale",
      "deployment/openclaw-enterprise-api",
      "deployment/openclaw-enterprise-worker",
      "--replicas=0",
    );
    await f.waitFor(
      "both writers stopped",
      async () => (await f.pods("api")).length === 0 && (await f.pods("worker")).length === 0,
    );
    const stopped = {};
    for (const component of ["api", "worker"]) {
      stopped[component] = await f.get("deployment", `openclaw-enterprise-${component}`);
    }

    // A real privilege drift must fail the chart's migration init container before
    // Helm restores either Deployment. Rendering the right argument alone cannot prove this.
    await sql("REVOKE SELECT ON occ.iam_identities FROM occ_app");
    await assert.rejects(
      f.upgrade({ database: { ...f.values.database, upgradeMigration: "separate" } }),
      /failed pre-upgrade|BackoffLimitExceeded/,
    );
    const hook = await f.get("job", `${f.release}-initialization`);
    const logs = await f.kubectl(
      "-n",
      f.system,
      "logs",
      `job/${hook.metadata.name}`,
      "-c",
      "migration",
    );
    assert.match(logs, /MIGRATION_HISTORY_UNSUPPORTED/);
    assert.equal(await receipts(), before);
    for (const component of ["api", "worker"]) {
      const deployment = await f.get("deployment", `openclaw-enterprise-${component}`);
      assert.equal(deployment.metadata.uid, stopped[component].metadata.uid);
      assert.equal(deployment.metadata.generation, stopped[component].metadata.generation);
      assert.equal(deployment.spec.replicas, 0);
      assert.equal((await f.pods(component)).length, 0);
    }

    // Reconcile the known fault, then use the documented independent migration Job
    // with the same candidate image, migrator Secret, and initialization network policy.
    await sql("GRANT SELECT ON occ.iam_identities TO occ_app");
    const template = hook.spec.template;
    const migration = template.spec.initContainers.find(({ name }) => name === "migration");
    const mounts = new Set((migration.volumeMounts ?? []).map(({ name }) => name));
    const jobName = "separate-database-migration";
    await f.apply({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: f.metadata(jobName),
      spec: {
        backoffLimit: 0,
        template: {
          metadata: {
            labels: {
              "app.kubernetes.io/name": "openclaw-enterprise",
              "app.kubernetes.io/instance": f.release,
              "app.kubernetes.io/component": "initialization",
            },
          },
          spec: {
            serviceAccountName: template.spec.serviceAccountName,
            automountServiceAccountToken: false,
            restartPolicy: "Never",
            securityContext: template.spec.securityContext,
            containers: [{ ...migration, args: ["scripts/migrate-production.mjs"] }],
            volumes: template.spec.volumes.filter(({ name }) => mounts.has(name)),
          },
        },
      },
    });
    await f.kubectl(
      "-n",
      f.system,
      "wait",
      "--for=condition=Complete",
      `job/${jobName}`,
      "--timeout=180s",
    );
    const migrated = await f.kubectl("-n", f.system, "logs", `job/${jobName}`);
    assert.match(migrated, /"event":"migration.completed","history":"completed"/);
    await f.kubectl("-n", f.system, "delete", "job", jobName, "--wait=true", "--timeout=120s");

    await f.upgrade({});
    const checked = await f.kubectl(
      "-n",
      f.system,
      "logs",
      `job/${hook.metadata.name}`,
      "-c",
      "migration",
    );
    assert.match(checked, /"event":"migration.checked","history":"completed"/);
    for (const component of ["api", "worker"]) {
      await f.currentPod(component);
      assert.equal(
        (await f.get("deployment", `openclaw-enterprise-${component}`)).spec.replicas,
        1,
      );
    }
    assert.equal(await receipts(), before);
    assert.equal((await f.api("GET", "/installation")).id, installation.id);
    // Prove the recovered API and worker can still deploy an Agent through their real caller.
    const agent = await f.createAgent();
    await agent.deploy();
    await agent.stop();
  },
);
