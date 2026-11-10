import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { createServer } from "node:tls";
import test from "node:test";
import { promisify } from "node:util";
import { createRealKubernetesFixture, kubectlArguments } from "../helpers/kubernetes-real.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.mjs";
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
    // Finish real bootstrap provisioning so active writers have no deferred work
    // whose legitimate progress could obscure a migration-side database write.
    const defaultNamespace = (await f.api("GET", "/namespaces")).find(
      ({ name }) => name === "default",
    );
    assert.ok(defaultNamespace);
    await f.readyNamespace(defaultNamespace);
    await f.waitFor(
      "bootstrap work settled",
      async () =>
        (
          await sql("SELECT count(*) FROM occ.controller_work WHERE state IN ('queued', 'claimed')")
        ).trim() === "0",
    );
    // The upgrade workflow requires the same Installation binding as prepare.
    await f.kubectl(
      "-n",
      f.system,
      "annotate",
      "secret/occ-installation-startup",
      `openclaw.dev/installation-id=${installation.id}`,
    );

    // Exercise the ordinary helper against this installed API and database. A
    // runtime-only plan selects the incumbent controller for compatibility checks;
    // no Agent is admitted until these checks finish. The imported Node image
    // is only an unlaunched candidate input; this proves no runtime usability.
    const occ = join(f.directory, "occ");
    await f.run("go", ["build", "-trimpath", "-o", occ, "./cmd/occ"]);
    const source = (await f.run("git", ["rev-parse", "HEAD"])).trim();
    const keyPath = join(f.directory, "service-key.json");
    const key = await f.kubectl(
      "-n",
      f.system,
      "exec",
      "operator",
      "--",
      "cat",
      "/bootstrap/initial-admin-service-key.json",
    );
    const serviceKey = JSON.parse(key).data;
    f.secrets.push(serviceKey.key);
    await writeFile(keyPath, key, { mode: 0o600 });
    const startup = await f.get("secret", "occ-installation-startup");
    const installationPath = join(f.directory, "installation.json");
    await writeFile(installationPath, Buffer.from(startup.data["installation.yaml"], "base64"), {
      mode: 0o600,
    });
    // Production listens on the Pod IP, while kubectl forwards to loopback.
    // Relay through the fixture's allowed operator without widening API ingress.
    const relay = spawn(
      "kubectl",
      [
        "--kubeconfig",
        f.selection.kubeconfigPath,
        "--context",
        f.selection.kubernetesContext,
        "-n",
        f.system,
        "exec",
        "operator",
        "--",
        "node",
        "-e",
        `const net=require('node:net');
       net.createServer(client=>{
         const upstream=net.connect(8080,'openclaw-enterprise-api');
         client.on('error',()=>upstream.destroy());
         client.on('close',()=>upstream.destroy());
         upstream.on('error',()=>client.destroy());
         client.pipe(upstream).pipe(client);
       }).listen(3101,'127.0.0.1',()=>console.log('ready'));`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => relay.kill("SIGTERM"));
    await new Promise((resolve, reject) => {
      relay.once("error", reject);
      relay.once("exit", (code) => reject(new Error(`operator relay exited (${code})`)));
      relay.stdout.once("data", resolve);
    });
    const connection = await createRealKubernetesFixture(f.selection).startPortForwardTarget(
      f.system,
      "pod/operator",
      "0:3101",
    );
    t.after(() => connection.stop());
    // Terminate verified test-owned TLS on loopback and relay bytes to the real
    // installed API; no HTTP operation or response is replaced by this transport.
    const tls = await harnessTlsFixture(t);
    const ingress = createServer(tls, (client) => {
      const upstream = connect(Number(new URL(connection.url).port), "127.0.0.1");
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    const origin = `https://localhost:${await listen(t, ingress)}`;
    const cliEnvironment = {
      ...process.env,
      OCC_URL: origin,
      OCC_CA_BUNDLE: tls.rootCertificatePath,
      OCC_SERVICE_KEY_FILE: keyPath,
    };
    const connected = JSON.parse(
      await f.run(occ, ["--output", "json", "installation", "get"], {
        env: cliEnvironment,
      }),
    );
    assert.equal(connected.id, installation.id);
    const preflight = (name, preflightOnly) =>
      f.run(
        "bash",
        [
          "scripts/upgrade-production-images",
          "--kubeconfig",
          f.selection.kubeconfigPath,
          "--context",
          f.selection.kubernetesContext,
          "--namespace",
          f.system,
          "--release",
          f.release,
          "--values",
          join(f.directory, "values.json"),
          "--installation",
          installationPath,
          "--runtime-image",
          f.images.node,
          "--source-revision",
          source,
          "--evidence-dir",
          join(f.directory, name),
          "--occ",
          occ,
          "--timeout-seconds",
          "120",
          ...(preflightOnly ? ["--preflight-only"] : []),
        ],
        {
          timeout: 240_000,
          env: cliEnvironment,
        },
      );
    // Keep full dumps private. Authenticating the real CLI updates exactly this
    // key's last_request and updated_at; compare every other byte, including all
    // other keys, and verify the two expected timestamps independently.
    const databaseSnapshot = async (name) => {
      // Decode only after complete byte capture: pipe chunks can split UTF-8 characters.
      // Keep command failures generic because both streams may contain private data.
      const { stdout: bytes } = await promisify(execFile)(
        process.env.OCC_KUBECTL_BIN ?? "kubectl",
        kubectlArguments(f.selection, [
          "-n",
          f.system,
          "exec",
          "postgres",
          "--",
          "pg_dump",
          "-U",
          "postgres",
          "--restrict-key=OceMigrationPreflight",
          `openclaw_k8s_observability_${f.suffix}`,
        ]),
        { encoding: "buffer", timeout: 180_000, maxBuffer: 2 * 1024 * 1024 },
      ).catch(() => {
        throw new Error("database snapshot capture failed");
      });
      await writeFile(join(f.directory, `${name}.sql`), bytes, { mode: 0o600 });
      const dump = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      let timestamps;
      const normalized = dump.replace(
        /^COPY occ\.apikey \(([^\n]+)\) FROM stdin;\n([\s\S]*?)\n\\\.\n/m,
        (section, header, data) => {
          const columns = header.split(", ");
          const idIndex = columns.indexOf("id");
          const indices = ["last_request", "updated_at"].map((column) => columns.indexOf(column));
          assert.ok(idIndex >= 0 && indices.every((index) => index >= 0));
          const rows = data.split("\n").map((row) => {
            const values = row.split("\t");
            if (values[idIndex] !== serviceKey.id) {
              return row;
            }
            assert.equal(timestamps, undefined, "exactly one CLI service key must match");
            timestamps = indices.map((index) => Date.parse(values[index]));
            assert.ok(timestamps.every(Number.isFinite), "authentication timestamps must be valid");
            for (const index of indices) {
              values[index] = "<authentication timestamp>";
            }
            return values.join("\t");
          });
          return `COPY occ.apikey (${header}) FROM stdin;\n${rows.join("\n")}\n\\.\n`;
        },
      );
      assert.ok(timestamps, "full dump must include the exact CLI service key");
      return { hash: createHash("sha256").update(normalized).digest("hex"), timestamps };
    };
    const assertDatabase = async (before, name) => {
      const after = await databaseSnapshot(name);
      assert.equal(
        after.hash,
        before.hash,
        "only the CLI key's authentication timestamps may change",
      );
      after.timestamps.forEach((timestamp, index) =>
        assert.ok(timestamp >= before.timestamps[index]),
      );
    };
    const incumbent = {};
    for (const component of ["api", "worker"]) {
      incumbent[component] = await f.get("deployment", `openclaw-enterprise-${component}`);
    }
    const assertIncumbent = async () => {
      for (const component of ["api", "worker"]) {
        const actual = await f.get("deployment", `openclaw-enterprise-${component}`);
        assert.equal(actual.metadata.uid, incumbent[component].metadata.uid);
        assert.equal(actual.metadata.generation, incumbent[component].metadata.generation);
        assert.equal(actual.spec.replicas, incumbent[component].spec.replicas);
        assert.ok(actual.spec.replicas > 0);
      }
    };
    const interior = JSON.parse(before)[14];
    assert.match(interior.hash, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(interior.id));
    await sql(
      `UPDATE drizzle.__drizzle_migrations SET hash=repeat('0',64) WHERE id=${interior.id}`,
    );
    const corruptSnapshot = await databaseSnapshot("corrupt-before");
    for (const preflightOnly of [true, false]) {
      const name = preflightOnly ? "incompatible-preflight" : "incompatible-upgrade";
      await assert.rejects(
        preflight(name, preflightOnly),
        /migration.*preflight|migration history/i,
      );
      const log = await readFile(join(f.directory, name, "preflight-migration.log"), "utf8");
      assert.match(log, /MIGRATION_HISTORY_UNSUPPORTED/);
      await assertDatabase(corruptSnapshot, `${name}-after`);
      await assertIncumbent();
      const remaining = JSON.parse(
        await f.kubectl(
          "-n",
          f.system,
          "get",
          "jobs,pods,secrets,networkpolicies",
          "-l",
          `app.kubernetes.io/instance=${f.release}`,
          "-o",
          "json",
        ),
      );
      assert.deepEqual(
        remaining.items.filter(({ metadata }) => metadata.name.includes("-upgrade-preflight-")),
        [],
        "preflight resources must be removed before return",
      );
    }
    // Restore only the exact injected fault. A successful read-only check must
    // leave the full database and the serving Deployments untouched as well.
    await sql(
      `UPDATE drizzle.__drizzle_migrations SET hash='${interior.hash}' WHERE id=${interior.id}`,
    );
    const repairedSnapshot = await databaseSnapshot("repaired-before");
    await preflight("compatible-preflight", true);
    assert.match(
      await readFile(join(f.directory, "compatible-preflight", "preflight-migration.log"), "utf8"),
      /"event":"migration.checked","history":"completed"/,
    );
    await assertDatabase(repairedSnapshot, "compatible-after");
    await assertIncumbent();
    await connection.stop();

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
