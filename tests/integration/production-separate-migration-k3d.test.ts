import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { createServer } from "node:tls";
import test from "node:test";
import { promisify } from "node:util";
import { Check } from "typebox/value";
import { AgentId, NamespaceId } from "../../packages/contracts/src/index.ts";
import { run as runCommand } from "../fixtures/repository-credentials/process.ts";
import { createRealKubernetesFixture, kubectlArguments } from "../helpers/kubernetes-real.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { listen } from "../helpers/listen.ts";
import { canonicalizeDumpRows } from "../helpers/postgres-dump.ts";
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
    // Use the same approved manifest in both runtime slots. The explicit incumbent
    // tag makes the dedicated slot a distinct reference for the image upgrade.
    const f = await installObservabilityControlPlane(t, { initialAgentImageTag: "incumbent" });
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
    // no Agent is admitted until these checks finish.
    const occ = join(f.directory, "occ");
    await f.run("go", ["build", "-trimpath", "-o", occ, "./cmd/occ"]);
    const source = (await f.run("git", ["rev-parse", "HEAD"])).trim();
    const keyPath = join(f.directory, "service-key.json");
    // The fixture has already removed the fresh-install credential Secret.
    // Resolve the real administrator identity from auth storage, then issue a
    // normal CLI key through the API instead of extracting bootstrap output.
    const principalId = (
      await sql("SELECT reference_id FROM occ.apikey WHERE name = 'bootstrap-admin'")
    ).trim();
    assert.ok(
      principalId && !principalId.includes("\n"),
      "one bootstrap service identity is required",
    );
    const serviceKey = record(
      await f.api(
        "POST",
        "/api/auth/service-keys",
        {
          servicePrincipalId: principalId,
          name: "migration-preflight",
        },
        201,
      ),
    );
    const serviceKeyId = string(serviceKey.id);
    f.secrets.push(string(serviceKey.key));
    await writeFile(keyPath, JSON.stringify({ data: serviceKey }), { mode: 0o600 });
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
    const valuesPath = join(f.directory, "values.json");
    const upgradeTimeout = ["--timeout-seconds", "120"];
    const upgradeExecution = { timeout: 240_000, env: cliEnvironment };
    const preflight = (name: string) =>
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
          valuesPath,
          "--installation",
          installationPath,
          "--runtime-image",
          f.images.runtime,
          "--source-revision",
          source,
          "--evidence-dir",
          join(f.directory, name),
          "--occ",
          occ,
          ...upgradeTimeout,
          "--preflight-only",
        ],
        upgradeExecution,
      );
    // Keep full dumps private. Authenticating the real CLI updates exactly this
    // key's last_request and updated_at. Ignore COPY row order, but retain every
    // value, duplicate and non-COPY byte, including all other keys' timestamps.
    // Verify the two expected timestamps independently.
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
      const timestampNormalized = dump.replace(
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
      const normalized = canonicalizeDumpRows(timestampNormalized);
      return {
        hash: createHash("sha256").update(normalized).digest("hex"),
        normalized,
        timestamps: captured.timestamps,
      };
    };
    const assertDatabase = async (
      before: Awaited<ReturnType<typeof databaseSnapshot>>,
      name: string,
    ) => {
      const after = await databaseSnapshot(name);
      // Report table names and ordering only; snapshot values remain private.
      const sections = (dump: string) =>
        new Map(
          Array.from(dump.matchAll(/^COPY ([^\n]+) FROM stdin;\n([\s\S]*?)\n\\\.\n/gm)).map(
            ([, header, rows]) => [header, (rows ?? "").split("\n").sort().join("\n")] as const,
          ),
        );
      const previous = sections(before.normalized);
      const current = sections(after.normalized);
      const changed = [...new Set([...previous.keys(), ...current.keys()])].filter(
        (header) => previous.get(header) !== current.get(header),
      );
      const nonCopy = (dump: string) =>
        dump.replace(/^COPY [^\n]+ FROM stdin;\n[\s\S]*?\n\\\.\n/gm, "");
      const orderingOnly =
        changed.length === 0 && nonCopy(before.normalized) === nonCopy(after.normalized);
      assert.equal(
        after.hash,
        before.hash,
        `only the CLI key's authentication timestamps may change; COPY ordering only: ${orderingOnly}; changed COPY contents: ${changed.join("; ") || "none"}`,
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
    const assertPreflightClean = async () => {
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
    };

    // The production CLI checks the same retained database while both writers
    // serve. The reviewed configuration change never becomes the Helm release.
    const profileDirectory = join(f.directory, "migration-profile");
    await mkdir(profileDirectory, { mode: 0o700 });
    await writeFile(join(profileDirectory, "values.yaml"), await readFile(valuesPath), {
      mode: 0o600,
    });
    const targetProfile = {
      kubeconfig: kubeconfigPath,
      context: kubernetesContext,
      namespace: f.system,
      release: f.release,
      installationDirectory: profileDirectory,
      sourceRevision: source,
    };
    const profile = join(profileDirectory, "upgrade.json");
    await writeFile(
      profile,
      JSON.stringify({ ...targetProfile, images: { controller: f.images.controller } }),
      { mode: 0o600 },
    );
    const helmRevision = async () =>
      number(
        record(
          JSON.parse(
            await f.run("helm", [
              "status",
              f.release,
              "--kubeconfig",
              kubeconfigPath,
              "--kube-context",
              kubernetesContext,
              "--namespace",
              f.system,
              "--output",
              "json",
            ]),
          ),
        ).version,
      );
    const revision = await helmRevision();
    const candidate = {
      ...f.values,
      api: { ...record(f.values.api), consoleTheme: { configMapName: "reviewed-theme" } },
    };
    const migrationCheck = async (directory: string, values: object) => {
      const candidatePath = join(profileDirectory, `${directory}.json`);
      await writeFile(candidatePath, JSON.stringify(values), { mode: 0o600 });
      return f.run(
        occ,
        [
          "installation",
          "upgrade",
          "migration",
          "check",
          "--profile",
          profile,
          "--evidence-dir",
          join(f.directory, directory),
          "--",
          "--candidate-values",
          candidatePath,
          "--timeout-seconds",
          "120",
        ],
        {
          timeout: 240_000,
          env: { ...process.env, OCC_URL: "", OCC_CA_BUNDLE: "", OCC_SERVICE_KEY_FILE: "" },
        },
      );
    };
    const migrationResult = await migrationCheck("migration-check", candidate);
    assert.match(migrationResult, /Migration check passed \(history: completed\)/);
    assert.equal(
      await readFile(join(f.directory, "migration-check", "migration-check-passed"), "utf8"),
      "completed\n",
    );
    assert.equal(await receipts(), before);
    await assertIncumbent();
    await assertPreflightClean();
    await assert.rejects(
      migrationCheck("wrong-migrator", {
        ...candidate,
        database: { ...record(f.values.database), migrationUrlKey: "other-migrator-url" },
      }),
      /candidate changes the deployed release's migrator database connection inputs/,
    );
    const refusedEvidence = join(f.directory, "wrong-migrator");
    const [refusedAttempt] = (await readdir(refusedEvidence)).filter((name) =>
      name.startsWith("migration-preflight."),
    );
    assert.ok(refusedAttempt, "the refusal must come from the rendered candidate check");
    assert.ok(
      !(await readdir(join(refusedEvidence, refusedAttempt))).includes("preflight-plan.json"),
    );
    assert.equal(await helmRevision(), revision);
    assert.equal(await receipts(), before);
    await assertIncumbent();
    await assertPreflightClean();

    const interior = record(array(JSON.parse(before))[14]);
    const interiorHash = string(interior.hash);
    const interiorId = number(interior.id);
    assert.match(interiorHash, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(interiorId));
    await sql(`UPDATE drizzle.__drizzle_migrations SET hash=repeat('0',64) WHERE id=${interiorId}`);
    const corruptSnapshot = await databaseSnapshot("corrupt-before");
    // The earlier migration check runs without installation.yaml. Stage
    // the same Installation bytes and runtime image as standalone preflight for apply.
    await writeFile(join(profileDirectory, "installation.yaml"), await readFile(installationPath), {
      mode: 0o600,
    });
    const applyProfile = join(profileDirectory, "apply.json");
    await writeFile(
      applyProfile,
      JSON.stringify({ ...targetProfile, occ, images: { runtime: f.images.runtime } }),
      { mode: 0o600 },
    );
    const applyUpgrade = (name: string) =>
      f.run(
        occ,
        [
          "installation",
          "upgrade",
          "apply",
          "--profile",
          applyProfile,
          "--auto-approve",
          "--evidence-dir",
          join(f.directory, name),
          "--",
          ...upgradeTimeout,
        ],
        upgradeExecution,
      );
    for (const [name, run] of [
      ["incompatible-preflight", preflight],
      ["incompatible-upgrade", applyUpgrade],
    ] as const) {
      await assert.rejects(run(name), /migration.*preflight|migration history/i);
      const log = await readFile(join(f.directory, name, "preflight-migration.log"), "utf8");
      assert.match(log, /MIGRATION_HISTORY_UNSUPPORTED/);
      await assertDatabase(corruptSnapshot, `${name}-after`);
      assert.equal(await helmRevision(), revision);
      await assertIncumbent();
      await assertPreflightClean();
    }
    // Restore only the exact injected fault. A successful read-only check must
    // leave the full database and the serving Deployments untouched as well.
    await sql(
      `UPDATE drizzle.__drizzle_migrations SET hash='${interiorHash}' WHERE id=${interiorId}`,
    );
    const repairedSnapshot = await databaseSnapshot("repaired-before");
    await preflight("compatible-preflight");
    assert.match(
      await readFile(join(f.directory, "compatible-preflight", "preflight-migration.log"), "utf8"),
      /"event":"migration.checked","history":"completed"/,
    );
    await assertDatabase(repairedSnapshot, "compatible-after");
    await assertIncumbent();

    // Retain a provisioned, undeployed Agent through the handoff. The fixture
    // runtime cannot run Doctor for a fleet replacement, so deploy this Agent
    // through the real API after the verified resume.
    const agent = await f.createAgent();
    const agentId = agent.agent.id;
    assert.ok(Check(AgentId, agentId));
    assert.equal(agent.agent.desiredRuntimeState, "stopped");
    const revisionIds = async () =>
      array(await f.api("GET", `${agent.path}/revisions`)).map((revision) => record(revision).id);
    assert.deepEqual(await revisionIds(), []);
    const candidateValues = join(profileDirectory, "separate-migration.json");
    await writeFile(
      candidateValues,
      JSON.stringify({
        ...f.values,
        database: { ...record(f.values.database), upgradeMigration: "separate" },
      }),
      { mode: 0o600 },
    );
    const upgradeRun = join(f.directory, "separate-migration-upgrade");
    const upgradeExpertOptions = [...upgradeTimeout, "--candidate-values", candidateValues];
    const upgradeArguments = (operation: string[], attestations: string[], approved: boolean) => [
      "installation",
      "upgrade",
      ...operation,
      "--profile",
      applyProfile,
      ...(approved ? ["--auto-approve"] : []),
      "--",
      ...upgradeExpertOptions,
      ...attestations,
    ];
    const runUpgrade = (operation: string[], attestations: string[] = []) =>
      runCommand(occ, upgradeArguments(operation, attestations, true), {
        ...upgradeExecution,
        timeout: 360_000,
        allowFailure: true,
      });
    const assertMigrationPause = (result: Awaited<ReturnType<typeof runUpgrade>>) => {
      assert.equal(result.code, 3, "the installed CLI must preserve the migration handoff status");
      assert.ok(
        result.stderr.includes("API and worker stopped for the separate database deployment"),
        "the native process must identify the stopped-writer handoff",
      );
    };
    // The real CLI stops the writers and records their identity before submitting Helm.
    const paused = await runUpgrade(["apply", "--evidence-dir", upgradeRun]);
    assertMigrationPause(paused);
    assert.match(
      await readFile(join(upgradeRun, "preflight-migration.log"), "utf8"),
      /"event":"migration.checked-for-installation","history":"completed"/,
    );
    const evidenceIdentity = await stat(upgradeRun);
    const handoffFile = join(upgradeRun, "database-migration-handoff.json");
    const handoffBytes = await readFile(handoffFile, "utf8");
    const handoff = record(JSON.parse(handoffBytes));
    const assertWriterFence = async () => {
      assert.equal(await helmRevision(), revision);
      assert.equal(await receipts(), before);
      assert.equal(
        (await sql(`SELECT count(*) FROM occ.agent_revisions WHERE agent_id='${agentId}'`)).trim(),
        "0",
        "the fenced upgrade must leave the retained Agent without a revision",
      );
      assert.equal(await readFile(handoffFile, "utf8"), handoffBytes);
      const currentEvidence = await stat(upgradeRun);
      assert.equal(currentEvidence.dev, evidenceIdentity.dev);
      assert.equal(currentEvidence.ino, evidenceIdentity.ino);
      const markers = await readdir(upgradeRun);
      assert.ok(markers.includes("prepared"));
      assert.ok(!markers.includes("helm-started"));
      assert.ok(!markers.includes("completed"));
      for (const component of ["api", "worker"]) {
        const current = deployment(await f.get("deployment", `openclaw-enterprise-${component}`));
        const previous = incumbent[component];
        assert.ok(previous);
        assert.equal(current.metadata.uid, previous.metadata.uid);
        assert.ok(current.metadata.generation > previous.metadata.generation);
        assert.deepEqual(current.metadata, handoff[component]);
        assert.equal(current.spec.replicas, 0);
        assert.equal((await f.pods(component)).length, 0);
      }
      await assertPreflightClean();
    };
    await assertWriterFence();

    const attempt = record(
      JSON.parse(await readFile(join(upgradeRun, "prepared-helm-attempt.json"), "utf8")),
    );
    const hookName = `${f.release}-initialization`;
    const hook = record(
      JSON.parse(
        await f.run("yq", [
          "-o=json",
          `select(.kind == "Job" and .metadata.name == "${hookName}")`,
          join(upgradeRun, "helm-attempts", string(attempt.nonce), "rendered.yaml"),
        ]),
      ),
    );
    const template = record(record(record(hook.spec).template).spec);
    const migration = array(template.initContainers).find(
      (container) => named(container) && container.name === "migration",
    );
    assert.ok(named(migration));
    assert.equal(migration.image, f.images.controller);
    assert.equal(array(migration.args).at(-1), "--require-current");
    // PostgreSQL compatibility tests cover applying pending SQL from a canonical
    // predecessor. Here the installed release starts current, so applying and
    // verifying through the real Jobs must preserve its schema, data and receipts.
    const fencedDatabase = await databaseSnapshot("migration-fenced-before");

    // Declining approval must leave the original run untouched while Helm and
    // both writers stay fenced.
    const migrationApply = ["migration", "apply", upgradeRun];
    const beforeDecline = (await readdir(upgradeRun)).sort();
    const declined = await runCommand(
      "python3",
      [
        "-c",
        "import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))",
        occ,
        ...upgradeArguments(migrationApply, [], false),
      ],
      { ...upgradeExecution, input: "no\n", allowFailure: true },
    );
    assert.equal(declined.code, 1, declined.stdout + declined.stderr);
    assert.match(declined.stdout, /cancelled; no command dispatched/);
    assert.deepEqual((await readdir(upgradeRun)).sort(), beforeDecline);
    await assert.rejects(stat(`${upgradeRun}.migration-state.json`), { code: "ENOENT" });
    await assertDatabase(fencedDatabase, "migration-declined-after");
    await assertWriterFence();

    // Both Jobs must complete and clean up before the explicit resume.
    const applied = await runUpgrade(migrationApply);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    assert.match(applied.stdout, /Database migration verified and its Jobs and Pods are gone/);
    for (const [stage, option] of [
      ["apply", "--apply-for-installation"],
      ["verify", "--require-current-for-installation"],
    ]) {
      const path = join(upgradeRun, `migration-deploy-${stage}`, "preflight-migration-job.json");
      const job = record(JSON.parse(await readFile(path, "utf8")));
      const template = record(record(job.spec).template);
      const migrator = record(array(record(template.spec).containers)[0]);
      assert.deepEqual(array(migrator.args).slice(-2), [option, installationId]);
    }
    assert.match(
      await readFile(join(upgradeRun, "migration-deploy-apply", "preflight-migration.log"), "utf8"),
      /"event":"migration.completed","history":"completed"/,
    );
    assert.match(
      await readFile(
        join(upgradeRun, "migration-deploy-verify", "preflight-migration.log"),
        "utf8",
      ),
      /"event":"migration.checked","history":"completed"/,
    );
    await assertDatabase(fencedDatabase, "migration-verified-after");
    await assertWriterFence();

    // The original run also needs the explicit resume attestation.
    const resume = ["resume", upgradeRun];
    assertMigrationPause(await runUpgrade(resume));
    await assertWriterFence();

    const resumed = await runUpgrade(resume, ["--migration-history-checked"]);
    assert.equal(resumed.code, 0, "verified history must allow the original CLI run to finish");
    assert.equal(await helmRevision(), revision + 1);
    const submittedHook = record(await f.get("job", hookName));
    assert.equal(
      record(record(submittedHook.metadata).annotations)["openclaw.dev/upgrade-attempt"],
      attempt.nonce,
    );
    assert.ok((await readdir(upgradeRun)).includes("completed"));
    const checked = await f.kubectl("-n", f.system, "logs", `job/${hookName}`, "-c", "migration");
    assert.match(checked, /"event":"migration.checked","history":"completed"/);
    await connection.stop();
    const writerComponents = ["api", "worker"];
    const assertServingWriters = async () => {
      for (const component of writerComponents) {
        await f.currentPod(component);
        assert.equal(
          deployment(await f.get("deployment", "openclaw-enterprise-" + component)).spec.replicas,
          1,
        );
      }
    };
    await assertServingWriters();
    assert.equal(await receipts(), before);
    const retainedAgent = record(await f.api("GET", agent.path));
    assert.equal(retainedAgent.id, agentId);
    assert.equal(retainedAgent.desiredRuntimeState, "stopped");
    assert.deepEqual(await revisionIds(), []);
    const admission = await agent.deploy();
    assert.equal(admission.agentId, agentId);
    assert.deepEqual(await revisionIds(), [admission.id]);
    await agent.stop();

    // Separately submit a real chart upgrade to exercise Helm's own safety gate
    // without the CLI's earlier compatibility check. Use the exact deployed values
    // so the deliberate privilege drift is the only reason the hook can refuse.
    const deployedValues = record(
      JSON.parse(
        await f.run("helm", [
          "get",
          "values",
          f.release,
          "--kubeconfig",
          kubeconfigPath,
          "--kube-context",
          kubernetesContext,
          "--namespace",
          f.system,
          "--output",
          "json",
        ]),
      ),
    );
    assert.equal(record(deployedValues.database).upgradeMigration, "separate");
    await f.kubectl(
      "-n",
      f.system,
      "scale",
      ...writerComponents.map((component) => "deployment/openclaw-enterprise-" + component),
      "--replicas=0",
    );
    await f.waitFor(
      "both writers stopped for the independent Helm check",
      async () => (await f.pods("api")).length === 0 && (await f.pods("worker")).length === 0,
    );
    const writerState = () =>
      Promise.all(
        writerComponents.map(async (component) =>
          deployment(await f.get("deployment", "openclaw-enterprise-" + component)),
        ),
      );
    const stopped = await writerState();
    assert.ok(stopped.every(({ spec }) => spec.replicas === 0));
    await sql("REVOKE SELECT ON occ.iam_identities FROM occ_app");
    try {
      await assert.rejects(f.upgrade(deployedValues), /failed pre-upgrade|BackoffLimitExceeded/);
      const logs = await f.kubectl("-n", f.system, "logs", "job/" + hookName, "-c", "migration");
      assert.match(logs, /MIGRATION_HISTORY_UNSUPPORTED/);
      assert.equal(await helmRevision(), revision + 2);
      assert.equal(await receipts(), before);
      assert.deepEqual(await writerState(), stopped);
      for (const component of writerComponents) {
        assert.equal((await f.pods(component)).length, 0);
      }
    } finally {
      await sql("GRANT SELECT ON occ.iam_identities TO occ_app");
    }

    await f.upgrade(deployedValues);
    const restored = await f.kubectl("-n", f.system, "logs", "job/" + hookName, "-c", "migration");
    assert.match(restored, /"event":"migration.checked","history":"completed"/);
    await assertServingWriters();
    assert.equal(await receipts(), before);
    assert.equal(string(record(await f.api("GET", "/installation")).id), installationId);
    assert.equal(record(await f.api("GET", agent.path)).id, agentId);
    assert.deepEqual(await revisionIds(), [admission.id]);
  },
);
