import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { createServer } from "node:tls";
import test from "node:test";
import { promisify } from "node:util";
import { Check } from "typebox/value";
import { NamespaceId } from "../../packages/contracts/src/index.ts";
import { createRealKubernetesFixture, kubectlArguments } from "../helpers/kubernetes-real.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.ts";
import {
  installObservabilityControlPlane,
  observabilitySelection,
} from "../helpers/production-observability-k3d.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function number(value: unknown): number {
  assert.ok(typeof value === "number");
  return value;
}

function named(value: unknown): value is Record<string, unknown> & { name: string } {
  return (
    typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
  );
}

function deployment(value: unknown) {
  const object = record(value);
  const metadata = record(object.metadata);
  const spec = record(object.spec);
  return {
    metadata: { uid: string(metadata.uid), generation: number(metadata.generation) },
    spec: { replicas: number(spec.replicas) },
  };
}

test(
  "separate migration Helm upgrades keep writers stopped until the database passes verification",
  observabilitySelection,
  async (t) => {
    const f = await installObservabilityControlPlane(t);
    const installation = record(await f.api("GET", "/installation"));
    const installationId = string(installation.id);
    const { kubeconfigPath, kubernetesContext } = f.selection;
    const sql = (statement: string) =>
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
    const defaultNamespace = array(await f.api("GET", "/namespaces")).find(
      (namespace) => named(namespace) && namespace.name === "default",
    );
    assert.ok(defaultNamespace, "The default Namespace must be present.");
    const namespaceId = record(defaultNamespace).id;
    assert.ok(
      Check(NamespaceId, namespaceId),
      "The default Namespace ID must match the API contract.",
    );
    await f.readyNamespace({ id: namespaceId });
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
      `openclaw.dev/installation-id=${installationId}`,
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
    const serviceKey = record(record(JSON.parse(key)).data);
    const serviceKeyId = string(serviceKey.id);
    f.secrets.push(string(serviceKey.key));
    await writeFile(keyPath, key, { mode: 0o600 });
    const startup = record(await f.get("secret", "occ-installation-startup"));
    const installationPath = join(f.directory, "installation.json");
    await writeFile(
      installationPath,
      Buffer.from(string(record(startup.data)["installation.yaml"]), "base64"),
      {
        mode: 0o600,
      },
    );
    // Production listens on the Pod IP, while kubectl forwards to loopback.
    // Relay through the fixture's allowed operator without widening API ingress.
    const relay = spawn(
      "kubectl",
      [
        "--kubeconfig",
        kubeconfigPath,
        "--context",
        kubernetesContext,
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
    await new Promise<void>((resolve, reject: (error: unknown) => void) => {
      relay.once("error", reject);
      relay.once("exit", (code) => reject(new Error(`operator relay exited (${code})`)));
      relay.stdout.once("data", () => resolve());
    });
    const connection: { url: unknown; stop: () => Promise<void> } =
      await createRealKubernetesFixture({
        ...f.selection,
        gatewayImage: undefined,
        codexImage: undefined,
        databaseUrl: undefined,
      }).startPortForwardTarget(f.system, "pod/operator", "0:3101");
    t.after(() => connection.stop());
    // Terminate verified test-owned TLS on loopback and relay bytes to the real
    // installed API; no HTTP operation or response is replaced by this transport.
    const tls = await harnessTlsFixture(t);
    const ingress = createServer(tls, (client) => {
      const upstream = connect(Number(new URL(string(connection.url)).port), "127.0.0.1");
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
    const connected = record(
      JSON.parse(
        await f.run(occ, ["--output", "json", "installation", "get"], {
          env: cliEnvironment,
        }),
      ),
    );
    assert.equal(string(connected.id), installationId);
    const preflight = (name: string, preflightOnly: boolean) =>
      f.run(
        "bash",
        [
          "scripts/upgrade-production-images",
          "--kubeconfig",
          kubeconfigPath,
          "--context",
          kubernetesContext,
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
    const databaseSnapshot = async (name: string) => {
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
      const captured: { timestamps?: number[] } = {};
      const normalized = dump.replace(
        /^COPY occ\.apikey \(([^\n]+)\) FROM stdin;\n([\s\S]*?)\n\\\.\n/m,
        (_section: string, header: string, data: string) => {
          const columns = header.split(", ");
          const idIndex = columns.indexOf("id");
          const indices = ["last_request", "updated_at"].map((column) => columns.indexOf(column));
          assert.ok(idIndex >= 0 && indices.every((index) => index >= 0));
          const rows = data.split("\n").map((row) => {
            const values = row.split("\t");
            if (values[idIndex] !== serviceKeyId) {
              return row;
            }
            assert.equal(captured.timestamps, undefined, "exactly one CLI service key must match");
            captured.timestamps = indices.map((index) => Date.parse(values[index] ?? ""));
            assert.ok(
              captured.timestamps.every(Number.isFinite),
              "authentication timestamps must be valid",
            );
            for (const index of indices) {
              values[index] = "<authentication timestamp>";
            }
            return values.join("\t");
          });
          return `COPY occ.apikey (${header}) FROM stdin;\n${rows.join("\n")}\n\\.\n`;
        },
      );
      assert.ok(captured.timestamps, "full dump must include the exact CLI service key");
      return {
        hash: createHash("sha256").update(normalized).digest("hex"),
        timestamps: captured.timestamps,
      };
    };
    const assertDatabase = async (
      before: Awaited<ReturnType<typeof databaseSnapshot>>,
      name: string,
    ) => {
      const after = await databaseSnapshot(name);
      assert.equal(
        after.hash,
        before.hash,
        "only the CLI key's authentication timestamps may change",
      );
      after.timestamps.forEach((timestamp, index) =>
        assert.ok(timestamp >= number(before.timestamps[index])),
      );
    };
    const incumbent: Record<string, ReturnType<typeof deployment>> = {};
    for (const component of ["api", "worker"]) {
      incumbent[component] = deployment(
        await f.get("deployment", `openclaw-enterprise-${component}`),
      );
    }
    const assertIncumbent = async () => {
      for (const component of ["api", "worker"]) {
        const actual = deployment(await f.get("deployment", `openclaw-enterprise-${component}`));
        const previous = incumbent[component];
        assert.ok(previous);
        assert.equal(actual.metadata.uid, previous.metadata.uid);
        assert.equal(actual.metadata.generation, previous.metadata.generation);
        assert.equal(actual.spec.replicas, previous.spec.replicas);
        assert.ok(actual.spec.replicas > 0);
      }
    };
    const interior = record(array(JSON.parse(before))[14]);
    const interiorHash = string(interior.hash);
    const interiorId = number(interior.id);
    assert.match(interiorHash, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(interiorId));
    await sql(`UPDATE drizzle.__drizzle_migrations SET hash=repeat('0',64) WHERE id=${interiorId}`);
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
      const remaining = record(
        JSON.parse(
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
        ),
      );
      assert.deepEqual(
        array(remaining.items).filter((item) =>
          string(record(record(item).metadata).name).includes("-upgrade-preflight-"),
        ),
        [],
        "preflight resources must be removed before return",
      );
    }
    // Restore only the exact injected fault. A successful read-only check must
    // leave the full database and the serving Deployments untouched as well.
    await sql(
      `UPDATE drizzle.__drizzle_migrations SET hash='${interiorHash}' WHERE id=${interiorId}`,
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
    const stopped: Record<string, ReturnType<typeof deployment>> = {};
    for (const component of ["api", "worker"]) {
      stopped[component] = deployment(
        await f.get("deployment", `openclaw-enterprise-${component}`),
      );
    }

    // A real privilege drift must fail the chart's migration init container before
    // Helm restores either Deployment. Rendering the right argument alone cannot prove this.
    await sql("REVOKE SELECT ON occ.iam_identities FROM occ_app");
    await assert.rejects(
      f.upgrade({
        database: { ...record(f.values.database), upgradeMigration: "separate" },
      }),
      /failed pre-upgrade|BackoffLimitExceeded/,
    );
    const hook = record(await f.get("job", `${f.release}-initialization`));
    const hookName = string(record(hook.metadata).name);
    const logs = await f.kubectl("-n", f.system, "logs", `job/${hookName}`, "-c", "migration");
    assert.match(logs, /MIGRATION_HISTORY_UNSUPPORTED/);
    assert.equal(await receipts(), before);
    for (const component of ["api", "worker"]) {
      const currentDeployment = deployment(
        await f.get("deployment", `openclaw-enterprise-${component}`),
      );
      const previous = stopped[component];
      assert.ok(previous);
      assert.equal(currentDeployment.metadata.uid, previous.metadata.uid);
      assert.equal(currentDeployment.metadata.generation, previous.metadata.generation);
      assert.equal(currentDeployment.spec.replicas, 0);
      assert.equal((await f.pods(component)).length, 0);
    }

    // Reconcile the known fault, then use the documented independent migration Job
    // with the same candidate image, migrator Secret, and initialization network policy.
    await sql("GRANT SELECT ON occ.iam_identities TO occ_app");
    const template = record(record(record(hook.spec).template).spec);
    const migration = array(template.initContainers).find(
      (container) => named(container) && container.name === "migration",
    );
    assert.ok(named(migration));
    const mounts = new Set(
      array(migration.volumeMounts ?? []).map((mount) => string(record(mount).name)),
    );
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
            serviceAccountName: string(template.serviceAccountName),
            automountServiceAccountToken: false,
            restartPolicy: "Never",
            securityContext: record(template.securityContext),
            containers: [{ ...migration, args: ["scripts/migrate-production.mjs"] }],
            volumes: array(template.volumes).filter((volume) =>
              mounts.has(string(record(volume).name)),
            ),
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
    const checked = await f.kubectl("-n", f.system, "logs", `job/${hookName}`, "-c", "migration");
    assert.match(checked, /"event":"migration.checked","history":"completed"/);
    for (const component of ["api", "worker"]) {
      await f.currentPod(component);
      assert.equal(
        deployment(await f.get("deployment", `openclaw-enterprise-${component}`)).spec.replicas,
        1,
      );
    }
    assert.equal(await receipts(), before);
    assert.equal(string(record(await f.api("GET", "/installation")).id), installationId);
    // Prove the recovered API and worker can still deploy an Agent through their real caller.
    const agent = await f.createAgent();
    await agent.deploy();
    await agent.stop();
  },
);
