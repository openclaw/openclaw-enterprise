import { selectedImageMigrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { kubernetesGatewayNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { bashString } from "../helpers/fixture-command-server.ts";
import { continuityNamespace } from "../helpers/production-upgrade-continuity-fixture.ts";
import {
  assertStoppedBeforeWriters,
  runWithInjectedFault,
} from "../helpers/production-upgrade-recovery-evidence.ts";
import type {
  RecoveryFixture,
  RecoveryFixtureFactory,
} from "../helpers/production-upgrade-recovery-fixture.ts";
import { renderedDocuments, yamlFile } from "../helpers/production-upgrade-recovery-render.ts";
import {
  field,
  list,
  requireRecoveryPreflight,
  type RecoveryState,
} from "../helpers/production-upgrade-recovery-state.ts";
import {
  controller,
  execute,
  newController,
  skipWithoutHelm,
} from "../helpers/production-upgrade-recovery-tools.ts";
import { registerPreflightCleanupTests } from "../helpers/production-upgrade-preflight-cleanup.ts";
import { createCredentialProxyInstallationConfiguration } from "../helpers/installation-driver-configuration.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { registerUpgradePreflightDraftBudgetTest } from "./production-upgrade-preflight-draft-budget.ts";

type StartupPreflightCases = {
  fixture: RecoveryFixtureFactory;
  realHelm: string | null;
  repository: string;
};

function commandStderr(error: unknown): string {
  const stderr = asRecord(error)?.stderr;
  assert.ok(typeof stderr === "string");
  return stderr;
}

function commandStdout(error: unknown): string {
  const stdout = asRecord(error)?.stdout;
  assert.ok(typeof stdout === "string");
  return stdout;
}

async function runForFailure(run: (...args: string[]) => Promise<unknown>, ...args: string[]) {
  try {
    await run(...args);
  } catch (error) {
    const code = asRecord(error)?.code;
    assert.ok(typeof code === "number");
    return { code, stderr: commandStderr(error), error };
  }
  assert.fail("expected the upgrade command to reject");
}

function evidenceObject(value: unknown, label: string) {
  const record = asRecord(value);
  assert.ok(record, `expected an object for ${label}`);
  return record;
}

function evidenceArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `expected an array for ${label}`);
  return value;
}

function jobTemplate(spec: Record<string, unknown>) {
  const template = evidenceObject(spec.template, "Job Pod template");
  return {
    spec: evidenceObject(template.spec, "Pod spec"),
    metadata: evidenceObject(template.metadata, "Pod metadata"),
  };
}

function podContainers(spec: Record<string, unknown>, field = "containers") {
  return evidenceArray(spec[field], field).map((value) => evidenceObject(value, field));
}

function podVolumes(spec: Record<string, unknown>) {
  return evidenceArray(spec.volumes, "volumes").map((value) => evidenceObject(value, "volume"));
}

function containerEnvironment(container: Record<string, unknown>) {
  return evidenceArray(container.env, "container environment").map((value) =>
    evidenceObject(value, "environment variable"),
  );
}

function readJsonObject(raw: string, label: string) {
  const value: unknown = JSON.parse(raw);
  return evidenceObject(value, label);
}

async function readEvidenceObject(fixture: Pick<RecoveryFixture, "readEvidence">, name: string) {
  return readJsonObject(await fixture.readEvidence(name), name);
}

async function readPreflightPod(fixture: Pick<RecoveryFixture, "readEvidence">, component: string) {
  const job = await readEvidenceObject(fixture, `preflight-${component}-job.json`);
  return jobTemplate(evidenceObject(job.spec, "Job spec"));
}

async function readStatus(fixture: Pick<RecoveryFixture, "readEvidence">, name: string) {
  return evidenceObject((await readEvidenceObject(fixture, name)).status, `${name} status`);
}

function openShellBackend(installation: Record<string, unknown>) {
  return evidenceObject(
    evidenceArray(installation.backend, "Installation backends")[0],
    "OpenShell Backend",
  );
}

export function registerStartupPreflightCases({
  fixture,
  realHelm,
  repository,
}: StartupPreflightCases): void {
  test("migration check uses the reviewed candidate without changing the deployed release", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    assert.ok(realHelm);
    const checked = (history: string | null) =>
      JSON.stringify({ event: "migration.checked", history }) + "\n";
    // Kubernetes combines the migrator's result with its structured stderr log.
    const telemetry = JSON.stringify({
      severity: "INFO",
      time: "2026-01-01T00:00:00.000Z",
      service: "occ-migration",
      event: "migration.checked",
    });
    const valid = checked("providerCompleted");
    for (const [scenario, log] of [
      ["configuration change", "Starting migration check\n" + valid + telemetry + "\n"],
      ["different CA key", null],
      ["empty history", checked("empty")],
      ["empty history with a trailing newline", checked("empty\n")],
      ["malformed and valid check results", checked(null) + valid],
      ["lost create", null],
    ] as const) {
      await t.test(scenario, async (t) => {
        const f = await fixture(t, {
          controllerOnly: true,
          chart: {
            values: (values) => ({
              ...values,
              database: { ...values.database, caSecretName: "database-ca", caKey: "ca.crt" },
            }),
            installation: (installation) => installation,
          },
          environment: { OCC_URL: "", OCC_SERVICE_KEY_FILE: "", OCC_CA_BUNDLE: "/missing-occ-ca" },
          preflightResults: log === null ? null : { migration: { phase: "Succeeded", log } },
          preflightFault: scenario === "lost create" ? { target: "migration", mode: "lost" } : null,
        });
        const valuesPath = join(f.directory, "values.json");
        const installed = await execute(
          realHelm,
          [
            "template",
            "oce",
            "deploy/helm/openclaw-enterprise",
            "--namespace",
            "system",
            "--values",
            valuesPath,
          ],
          { cwd: repository },
        );
        const initializer = renderedDocuments(installed.stdout).find(
          (resource) =>
            asRecord(resource)?.kind === "Job" &&
            asRecord(asRecord(resource)?.metadata)?.name === "oce-initialization",
        );
        assert.ok(initializer, "expected the installed chart's initializer");
        const statePath = join(f.directory, "state.json");
        await writeFile(
          statePath,
          JSON.stringify({
            ...(await f.state()),
            installationRelease: { hooks: [{ manifest: JSON.stringify(initializer) }] },
          }),
        );
        const baseline = await readFile(valuesPath, "utf8");
        const values = evidenceObject(await yamlFile(valuesPath), "installed values");
        const api = evidenceObject(values.api, "installed API values");
        const candidatePath = join(f.directory, "migration-candidate.json");
        await writeFile(
          candidatePath,
          JSON.stringify({
            ...values,
            api: { ...api, consoleTheme: { configMapName: "reviewed-theme" } },
            ...(scenario === "different CA key"
              ? {
                  database: {
                    ...evidenceObject(values.database, "installed database values"),
                    caKey: "other.crt",
                  },
                }
              : {}),
          }),
          { mode: 0o600 },
        );

        const check = f.run("--migration-check-only", "--candidate-values", candidatePath);
        if (scenario === "different CA key") {
          await assert.rejects(
            check,
            /candidate changes the deployed release's migrator database connection inputs/,
          );
          assert.equal(
            f.commands.includes("kubectl"),
            false,
            "the refusal must precede Job creation",
          );
        } else if (scenario === "lost create") {
          await assert.rejects(
            check,
            /reconcile the original Job create before starting another check/,
          );
          assert.ok(existsSync(join(f.evidence, ".upgrade-lock")));
          await assert.rejects(
            f.cleanup("--previous-process-settled", "--evidence-unrestored"),
            /preflight cleanup is incomplete/,
          );
          const preflight = requireRecoveryPreflight(await f.state());
          assert.equal(Object.keys(evidenceObject(preflight.jobs, "retained Jobs")).length, 1);
          assert.deepEqual(preflight.deleted ?? [], []);
        } else if (scenario !== "configuration change") {
          await assert.rejects(check, {
            code: 1,
            stderr: /did not report one nonempty, recognized migration history/,
          });
          const preflight = requireRecoveryPreflight(await assertStoppedBeforeWriters(f));
          assert.equal(evidenceArray(preflight.created, "preflight creations").length, 1);
        } else {
          const { stdout } = await check;
          assert.match(stdout, /Migration check passed \(history: providerCompleted\)/);
          assert.equal(await f.readEvidence("migration-check-passed"), "providerCompleted\n");
          const [attempt] = (await readdir(f.evidence)).filter((name) =>
            name.startsWith("migration-preflight."),
          );
          assert.ok(attempt, "expected the migration check evidence directory");
          const job = await readEvidenceObject(f, join(attempt, "preflight-migration-job.json"));
          const pod = jobTemplate(evidenceObject(job.spec, "migration Job spec"));
          assert.equal(podContainers(pod.spec).length, 1);
          assert.equal(pod.spec.initContainers, undefined);
          const [migrator] = podContainers(pod.spec);
          assert.deepEqual(migrator?.args, [...selectedImageMigrationEntry, "--check"]);
          assert.equal(migrator?.image, newController);
          const preflight = requireRecoveryPreflight(await assertStoppedBeforeWriters(f));
          assert.equal(evidenceArray(preflight.created, "preflight creations").length, 1);
          assert.equal(await readFile(valuesPath, "utf8"), baseline);
        }
        assert.equal(f.commands.includes("occ"), false);
        assert.equal(existsSync(join(f.evidence, "prepared")), false);
        assert.equal(existsSync(join(f.evidence, "helm-started")), false);
        assert.equal(
          existsSync(join(f.evidence, "migration-check-passed")),
          scenario === "configuration change",
        );
        assert.deepEqual(await f.events(), []);
      });
    }
  });

  test("upgrade retires unchanged legacy bootstrap output values before Helm render", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    assert.ok(realHelm);
    const helm = realHelm;
    // The predecessor production example and profile renderer wrote this
    // bootstrap object into Helm's user values. The old chart also accepted an
    // explicit service-key output file name.
    const historical = {
      adminEmail: "admin@example.invalid",
      password: { claimName: "occ-bootstrap-admin-password" },
    };
    for (const scenario of [
      "default candidate",
      "omitted output settings",
      "changed password claim",
      "changed service-key file",
      "changed admin email",
      "added credentials",
      "repointed credentials",
      "read-only check",
      "read-only check stale baseline",
      "read-only check replaces baseline during Helm read",
      "read-only check replaces candidate during parsing",
    ] as const) {
      await t.test(scenario, async (t) => {
        const credentials = { secretName: "retained-bootstrap-credentials" };
        const serviceKey = { fileName: "initial-admin-service-key.json" };
        const bootstrap = {
          ...historical,
          ...(scenario === "omitted output settings" || scenario === "changed service-key file"
            ? { serviceKey }
            : {}),
          ...(scenario === "repointed credentials" ? { credentials } : {}),
        };
        const f = await fixture(t, {
          controllerOnly: true,
          chart: {
            values: (values) => ({ ...values, bootstrap }),
            installation: (installation) => installation,
          },
          preflightResults: {
            migration: {
              phase: "Succeeded",
              log: '{"event":"migration.checked","history":"completed"}\n',
            },
          },
        });
        const valuesPath = join(f.directory, "values.json");
        const livePath = join(f.directory, "live-values");
        const candidatePath = join(f.directory, "reviewed-values.json");
        const baseline = await readFile(valuesPath, "utf8");
        const values = evidenceObject(await yamlFile(valuesPath), "installed Helm values");
        const retained = {
          adminEmail: bootstrap.adminEmail,
          ...(bootstrap.credentials ? { credentials } : {}),
        };
        const render = (path: string) =>
          execute(
            helm,
            [
              "template",
              "oce",
              "deploy/helm/openclaw-enterprise",
              "--namespace",
              "system",
              "--is-upgrade",
              "--values",
              path,
            ],
            { cwd: repository },
          );
        const replaceBaseline = scenario === "read-only check replaces baseline during Helm read";
        const replaceCandidate = scenario === "read-only check replaces candidate during parsing";
        const stale = scenario === "read-only check stale baseline" || replaceBaseline;
        const checkOnly = scenario === "read-only check" || stale || replaceCandidate;
        const omit = scenario === "omitted output settings";
        let requested: string | undefined;
        let replacement: string | undefined;
        let live = baseline;
        if (scenario === "default candidate") {
          await assert.rejects(render(valuesPath), /bootstrap output settings are removed/);
          await f.run("--preflight-only");
        } else if (checkOnly) {
          // The recorded Job supplies the real chart's unchanged migrator
          // connection contract. The persisted predecessor values stay legacy.
          await writeFile(candidatePath, JSON.stringify({ ...values, bootstrap: retained }), {
            mode: 0o600,
          });
          const { stdout } = await render(candidatePath);
          const initializer = renderedDocuments(stdout).find(
            (resource) =>
              asRecord(resource)?.kind === "Job" &&
              asRecord(asRecord(resource)?.metadata)?.name === "oce-initialization",
          );
          assert.ok(initializer);
          await writeFile(
            join(f.directory, "state.json"),
            JSON.stringify({
              ...(await f.state()),
              installationRelease: { hooks: [{ manifest: JSON.stringify(initializer) }] },
            }),
          );
          if (stale) {
            live = JSON.stringify({
              ...values,
              bootstrap: { ...bootstrap, adminEmail: "changed@example.invalid" },
            });
            await writeFile(livePath, live);
            if (replaceBaseline) {
              const mockHelm = join(f.directory, "bin", "helm");
              await writeFile(join(f.directory, "values.next"), live, { mode: 0o600 });
              await rename(mockHelm, `${mockHelm}.fixture`);
              await writeFile(
                mockHelm,
                `#!/bin/bash
set -eu
root=\${0%/bin/helm}
if [[ "$1" == get && "$2" == values ]]; then
  mv -- "$root/values.next" "$root/values.json"
fi
exec "$0.fixture" "$@"
`,
                { mode: 0o700 },
              );
            }
            await assert.rejects(
              f.run("--migration-check-only"),
              /protected values to match the live release/,
            );
          } else {
            if (replaceCandidate) {
              requested = await readFile(candidatePath, "utf8");
              replacement = JSON.stringify({
                ...values,
                bootstrap: { ...retained, adminEmail: "changed@example.invalid" },
              });
              await writeFile(join(f.directory, "reviewed-values.next"), replacement, {
                mode: 0o600,
              });
              const { stdout: yq } = await execute("/bin/sh", ["-c", "command -v yq"], {
                cwd: repository,
              });
              const parser = bashString(yq.trim());
              await writeFile(
                join(f.directory, "bin", "yq"),
                `#!/bin/bash
set -eu
root=\${0%/bin/yq}
if [[ $# == 4 && "$1" == -p=yaml && "$2" == -o=json && "$3" == . ]]; then
  case "$4" in
    "$root/reviewed-values.json"|"$root/evidence"/migration-preflight.*/requested-values.yaml)
      ${parser} "$@"
      mv -- "$root/reviewed-values.next" "$root/reviewed-values.json"
      exit 0
      ;;
  esac
fi
exec ${parser} "$@"
`,
                { mode: 0o700 },
              );
            }
            const args = replaceCandidate ? ["--candidate-values", candidatePath] : [];
            const { stdout: result } = await f.run("--migration-check-only", ...args);
            assert.match(result, /Migration check passed \(history: completed\)/);
          }
        } else {
          const edits = {
            "changed password claim": { password: { claimName: "another-claim" } },
            "changed service-key file": { serviceKey: { fileName: "other-key.json" } },
            "changed admin email": { adminEmail: "other@example.invalid" },
            "added credentials": { credentials },
            "repointed credentials": { credentials: { secretName: "other-bootstrap-credentials" } },
          };
          requested = JSON.stringify({
            ...values,
            bootstrap: omit ? retained : { ...bootstrap, ...edits[scenario] },
            ...(omit
              ? {
                  database: {
                    ...evidenceObject(values.database, "database values"),
                    upgradeMigration: "separate",
                  },
                }
              : {}),
          });
          await writeFile(candidatePath, requested, { mode: 0o600 });
          const run = f.run("--candidate-values", candidatePath);
          if (omit) {
            await assert.rejects(run, { code: 3, stderr: /separate database deployment/ });
            const frozen = await f.state();
            assert.deepEqual([frozen.api, frozen.worker], [0, 0]);
          } else {
            await assert.rejects(run, /candidate values change a protected bootstrap setting/);
          }
        }

        const observed = await f.state();
        assert.equal(observed.helmSubmissions ?? 0, 0);
        assert.equal(existsSync(join(f.evidence, "helm-started")), false);
        if (!omit) {
          assert.deepEqual([observed.api, observed.worker], [1, 1]);
        }
        assert.equal(await readFile(valuesPath, "utf8"), replaceBaseline ? live : baseline);
        assert.equal(await readFile(livePath, "utf8"), live);
        if (!checkOnly) {
          assert.equal(await f.readEvidence("before-values.yaml"), baseline);
        }
        if (requested !== undefined && !checkOnly) {
          assert.equal(await readFile(candidatePath, "utf8"), requested);
          assert.equal(await f.readEvidence("requested-values.yaml"), requested);
        }
        const checkAttempt = checkOnly
          ? (await readdir(f.evidence)).find((name) => name.startsWith("migration-preflight."))
          : undefined;
        if (checkOnly) {
          assert.ok(checkAttempt);
          const snapshot = join(f.evidence, checkAttempt, "before-values.yaml");
          assert.equal(await readFile(snapshot, "utf8"), baseline);
          assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
          if (replaceCandidate) {
            assert.equal(await readFile(candidatePath, "utf8"), replacement);
            const candidateSnapshot = join(f.evidence, checkAttempt, "requested-values.yaml");
            assert.equal(await readFile(candidateSnapshot, "utf8"), requested);
            assert.equal((await stat(candidateSnapshot)).mode & 0o777, 0o600);
          }
        }
        const succeeds = scenario === "default candidate" || omit || (checkOnly && !stale);
        if (succeeds) {
          const attempt = checkOnly
            ? checkAttempt
            : (await readdir(join(f.evidence, "helm-attempts")))[0];
          assert.ok(attempt);
          const directory = checkOnly
            ? join(f.evidence, attempt)
            : join(f.evidence, "helm-attempts", attempt);
          const candidate = await yamlFile(
            join(directory, checkOnly ? "candidate-values.yaml" : "values.yaml"),
          );
          assert.deepEqual(field(candidate, "bootstrap"), retained);
          const rendered = renderedDocuments(
            await readFile(join(directory, "rendered.yaml"), "utf8"),
          );
          assert.ok(
            rendered.some(
              (resource) =>
                asRecord(resource)?.kind === "Job" &&
                asRecord(asRecord(resource)?.metadata)?.name === "oce-initialization",
            ),
            "expected the normalized values to render the initialization Job",
          );
        } else {
          assert.deepEqual(await f.events(), []);
          assert.deepEqual(asRecord(observed.preflight)?.created ?? [], []);
        }
      });
    }
  });

  test("separate migration apply holds uncertain operations before Helm", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    assert.ok(realHelm);
    const helm = realHelm;
    for (const scenario of [
      "lost apply acknowledgement",
      "recovers unreadable successful Jobs by their original UID",
      "verification rejects pending history",
      "database credential changes before verification",
      "older candidate rejects guarded apply",
    ]) {
      await t.test(scenario, async (t) => {
        const f = await fixture(t, {
          controllerOnly: true,
          candidates: true,
          chart: { installation: (installation) => installation },
        });
        await writeFile(
          join(f.directory, "candidate-installation.json"),
          await readFile(join(f.directory, "installation.json")),
        );
        const valuesPath = join(f.directory, "values.json");
        const candidatePath = join(f.directory, "candidate-values.json");
        const values = evidenceObject(await yamlFile(valuesPath), "installed values");
        await writeFile(
          candidatePath,
          JSON.stringify({
            ...values,
            database: {
              ...evidenceObject(values.database, "database values"),
              upgradeMigration: "separate",
            },
          }),
        );
        const { stdout } = await execute(
          helm,
          [
            "template",
            "oce",
            "deploy/helm/openclaw-enterprise",
            "--namespace",
            "system",
            "--values",
            valuesPath,
          ],
          { cwd: repository },
        );
        const initializer = renderedDocuments(stdout).find(
          (resource) => asRecord(asRecord(resource)?.metadata)?.name === "oce-initialization",
        );
        assert.ok(initializer);
        const statePath = join(f.directory, "state.json");
        const installed = { hooks: [{ manifest: JSON.stringify(initializer) }] };
        await writeFile(
          statePath,
          JSON.stringify({ ...(await f.state()), installationRelease: installed }),
        );
        await assert.rejects(f.run(), { code: 3, stderr: /separate database deployment/ });
        const frozen = await f.state();
        const preflight = requireRecoveryPreflight(frozen);
        const installedPod = jobTemplate(
          evidenceObject(asRecord(initializer)?.spec, "initializer spec"),
        );
        const installedMigration = podContainers(installedPod.spec, "initContainers").find(
          ({ name }) => name === "migration",
        );
        assert.ok(installedMigration);
        const databaseEnv = containerEnvironment(installedMigration).find(
          ({ name }) => name === "OCC_MIGRATION_DATABASE_URL",
        );
        assert.ok(databaseEnv);
        const secretRef = evidenceObject(
          evidenceObject(databaseEnv.valueFrom, "migrator value source").secretKeyRef,
          "migrator Secret reference",
        );
        const databaseSecretName = secretRef.name;
        assert.ok(typeof databaseSecretName === "string");
        const secretIdentity = (name: string) => ({
          metadata: {
            name,
            namespace: "system",
            uid: `migration-secret-${name}`,
            resourceVersion: "1",
          },
        });
        const databaseSecret = secretIdentity(databaseSecretName);
        const migrationMounts = evidenceArray(
          installedMigration.volumeMounts ?? [],
          "migrator volume mounts",
        );
        const caSecrets = podVolumes(installedPod.spec)
          .filter(({ name }) => migrationMounts.some((mount) => field(mount, "name") === name))
          .map(({ secret }) => {
            const name = evidenceObject(secret, "mounted migrator CA Secret").secretName;
            assert.ok(typeof name === "string");
            return [name, secretIdentity(name)] as const;
          });
        const migrationSecrets = {
          ...Object.fromEntries(caSecrets),
          [databaseSecretName]: databaseSecret,
        };
        const stopped: RecoveryState = {
          ...frozen,
          preflight: { ...preflight, secrets: migrationSecrets },
        };
        const beforeJobs = evidenceArray(
          requireRecoveryPreflight(stopped).created,
          "preflight creations",
        ).length;
        const attempt = () => f.run("--migration-apply-only");
        const assertHeld = async (created: number) => {
          const current = await f.state();
          assert.deepEqual([current.api, current.worker], [0, 0]);
          assert.equal(current.helmSubmissions ?? 0, 0);
          assert.equal(existsSync(join(f.evidence, "helm-started")), false);
          assert.equal(
            evidenceArray(requireRecoveryPreflight(current).created, "preflight creations").length,
            beforeJobs + created,
          );
          return requireRecoveryPreflight(current);
        };

        if (scenario === "lost apply acknowledgement") {
          await writeFile(statePath, JSON.stringify(stopped));
          await chmod(f.directory, 0o777);
          try {
            await assert.rejects(attempt(), {
              stderr: /migration journal's parent must protect files/,
            });
            await assertHeld(0);
          } finally {
            await chmod(f.directory, 0o700);
          }
          // The Deployment name and zero replicas alone cannot authorize SQL.
          for (const worker of [{ uid: "replacement-worker" }, { generation: 999 }]) {
            await writeFile(
              statePath,
              JSON.stringify({
                ...stopped,
                deploymentIdentities: { ...asRecord(stopped.deploymentIdentities), worker },
              }),
            );
            await assert.rejects(attempt(), /worker Deployment changed/);
            await assertHeld(0);
          }
          // A changed migrator reference in the live hook invalidates the
          // original predecessor even with the same release revision.
          const otherInitializer = structuredClone(initializer);
          const pod = jobTemplate(
            evidenceObject(asRecord(otherInitializer)?.spec, "initializer spec"),
          );
          const migration = podContainers(pod.spec, "initContainers").find(
            ({ name }) => name === "migration",
          );
          assert.ok(migration);
          const database = containerEnvironment(migration).find(
            ({ name }) => name === "OCC_MIGRATION_DATABASE_URL",
          );
          assert.ok(database);
          evidenceObject(
            evidenceObject(database.valueFrom, "migrator value source").secretKeyRef,
            "migrator Secret reference",
          ).key = "replacement-key";
          await writeFile(
            statePath,
            JSON.stringify({
              ...stopped,
              installationRelease: { hooks: [{ manifest: JSON.stringify(otherInitializer) }] },
            }),
          );
          await assert.rejects(attempt(), /deployed Helm revision or hooks changed/);
          await assertHeld(0);

          await writeFile(
            statePath,
            JSON.stringify({
              ...stopped,
              preflightFault: { target: "migration", mode: "lost" },
            }),
          );
          await assert.rejects(attempt(), /apply Job create outcome is unknown/);
          const retained = await assertHeld(1);
          const jobs = evidenceObject(retained.jobs, "retained migration Jobs");
          assert.equal(Object.keys(jobs).length, 1);
          await assert.rejects(attempt(), /apply Job create outcome is unknown/);
          await assert.rejects(
            f.run("--resume", "--migration-history-checked"),
            /Job outcomes or cleanup are unresolved/,
          );
          await f.cleanup("--previous-process-settled", "--evidence-unrestored");
          assert.deepEqual((await assertHeld(1)).jobs, jobs);
          // Restoring in-directory evidence cannot reset the sibling create witness.
          await rm(join(f.evidence, "migration-deploy-apply"), { recursive: true });
          await assert.rejects(attempt(), /original separate migration journal/);
          await assertHeld(1);
        } else if (scenario === "recovers unreadable successful Jobs by their original UID") {
          const failedLogRead = {
            phase: "Succeeded",
            logExitCode: 1,
            logWarning: "log stream interrupted\n",
          };
          await writeFile(
            statePath,
            JSON.stringify({
              ...stopped,
              preflightResults: {
                "--apply-for-installation": {
                  ...failedLogRead,
                  log: '{"event":"migration.completed","history":"preAuthenticationStates"}\n',
                },
                "--require-current-for-installation": {
                  ...failedLogRead,
                  log: '{"event":"migration.checked","history":"completed"}\n',
                },
              },
            }),
          );
          const readStages = async () => {
            const raw = await readFile(`${f.evidence}.migration-state.json`, "utf8");
            return evidenceObject(
              readJsonObject(raw, "migration journal").stages,
              "journal stages",
            );
          };
          const receipts = new Map<string, { job: unknown; pod: unknown }>();
          for (const [index, stage] of ["apply", "verify"].entries()) {
            await assert.rejects(attempt(), /cannot read the original migration Pod logs/);
            const held = await assertHeld(index + 1);
            const stages = await readStages();
            assert.equal(Object.keys(stages).length, index + 1);
            const recorded = evidenceObject(stages[stage], `${stage} journal entry`);
            assert.equal(recorded.state, "creating");
            assert.equal(recorded.history, null);
            const jobs = Object.values(evidenceObject(held.jobs, "retained Jobs"));
            assert.equal(jobs.length, 1);
            const pods = Object.entries(evidenceObject(held.pods, "retained Pods"));
            const [onlyPod] = pods;
            assert.ok(pods.length === 1 && onlyPod);
            const [podName, pod] = onlyPod;
            const attemptPath = `migration-deploy-${stage}`;
            const jobReceipt = await readEvidenceObject(
              f,
              `${attemptPath}/preflight-migration-identity.json`,
            );
            const podReceipt = await readEvidenceObject(
              f,
              `${attemptPath}/preflight-migration-pod-identity.json`,
            );
            assert.equal(jobReceipt.uid, field(field(jobs[0], "metadata"), "uid"));
            assert.equal(podReceipt.uid, field(field(pod, "metadata"), "uid"));
            assert.equal(podReceipt.name, podName);
            assert.match(
              await f.readEvidence(`${attemptPath}/preflight-migration-logs.err`),
              /log stream interrupted/,
            );
            assert.equal(
              existsSync(join(f.evidence, attemptPath, "preflight-migration.log")),
              false,
            );
            await assert.rejects(
              f.run("--resume", "--migration-history-checked"),
              /Job outcomes or cleanup are unresolved/,
            );
            receipts.set(stage, { job: jobReceipt, pod: podReceipt });
            await writeFile(
              statePath,
              JSON.stringify({
                ...(await f.state()),
                preflight: {
                  ...held,
                  pods: { [podName]: { ...evidenceObject(pod, "original Pod"), logExitCode: 0 } },
                },
              }),
            );
          }
          await attempt();
          const cleaned = await assertHeld(2);
          assert.deepEqual(cleaned.jobs, {});
          assert.deepEqual(cleaned.pods, {});
          const stages = await readStages();
          assert.deepEqual(Object.keys(stages).sort(), ["apply", "verify"]);
          for (const [stage, expected] of receipts) {
            const completed = evidenceObject(stages[stage], `${stage} journal entry`);
            assert.equal(completed.state, "cleaned");
            assert.deepEqual({ job: completed.job, pod: completed.pod }, expected);
          }
          assert.equal(field(stages.verify, "history"), "completed");
        } else if (scenario === "verification rejects pending history") {
          // The first Job's classification describes pre-apply history. Only
          // the verification Job may authorize the later Helm phase.
          const applyResult = {
            phase: "Succeeded",
            log: '{"event":"migration.completed","history":"preAuthenticationStates"}\n',
          };
          await writeFile(
            statePath,
            JSON.stringify({
              ...stopped,
              preflightResults: {
                "--apply-for-installation": applyResult,
                "--require-current-for-installation": {
                  phase: "Failed",
                  log: '{"event":"migration.failed","code":"MIGRATION_HISTORY_PENDING"}\n',
                },
              },
            }),
          );
          await assert.rejects(attempt(), /verification Job did not report completed history/);
          const apply = await readEvidenceObject(
            f,
            "migration-deploy-apply/preflight-migration-job.json",
          );
          const verify = await readEvidenceObject(
            f,
            "migration-deploy-verify/preflight-migration-job.json",
          );
          assert.deepEqual(
            podContainers(jobTemplate(evidenceObject(apply.spec, "apply Job")).spec)[0]?.args,
            [...selectedImageMigrationEntry, "--apply-for-installation", "ins_test"],
          );
          assert.deepEqual(
            podContainers(jobTemplate(evidenceObject(verify.spec, "verify Job")).spec)[0]?.args,
            [...selectedImageMigrationEntry, "--require-current-for-installation", "ins_test"],
          );
          assert.deepEqual((await assertHeld(2)).jobs, {});
          await assert.rejects(
            f.run("--resume", "--migration-history-checked"),
            /Job outcomes or cleanup are unresolved/,
          );
          await assertHeld(2);
          const failed = await f.state();
          await writeFile(
            statePath,
            JSON.stringify({
              ...failed,
              preflightResults: {
                "--require-current-for-installation": {
                  phase: "Succeeded",
                  log: '{"event":"migration.checked","history":"completed"}\n',
                },
              },
            }),
          );
          await attempt();
          assert.deepEqual((await assertHeld(3)).jobs, {});
          const retried = await readEvidenceObject(
            f,
            "migration-deploy-verify-2/preflight-migration-job.json",
          );
          assert.notEqual(field(retried.metadata, "name"), field(verify.metadata, "name"));
          assert.deepEqual(
            podContainers(jobTemplate(evidenceObject(retried.spec, "retry Job")).spec)[0]?.args,
            [...selectedImageMigrationEntry, "--require-current-for-installation", "ins_test"],
          );

          const resume = ["--resume", "--migration-history-checked"];
          await runWithInjectedFault(f, "reject-helm-submission", ...resume);
          const rejected = await f.state();
          assert.equal(rejected.helmSubmissions, 1);
          assert.equal(existsSync(join(f.evidence, "helm-started")), true);
          await writeFile(
            statePath,
            JSON.stringify({
              ...rejected,
              preflight: {
                ...requireRecoveryPreflight(rejected),
                secrets: {
                  ...migrationSecrets,
                  [String(databaseSecretName)]: {
                    metadata: { ...databaseSecret.metadata, resourceVersion: "2" },
                  },
                },
              },
            }),
          );
          await assert.rejects(f.run(...resume), /migrator or database CA Secret changed/);
          assert.equal((await f.state()).helmSubmissions, 1);
        } else if (scenario === "older candidate rejects guarded apply") {
          await writeFile(
            statePath,
            JSON.stringify({
              ...stopped,
              preflightResults: {
                "--apply-for-installation": {
                  phase: "Failed",
                  log: '{"event":"migration.failed","code":"MIGRATION_FAILED"}\n',
                },
              },
            }),
          );
          await assert.rejects(
            attempt(),
            /apply Job did not succeed with a valid migration result/,
          );
          const retained = await assertHeld(1);
          assert.equal(Object.keys(evidenceObject(retained.jobs, "retained apply Job")).length, 1);
          const apply = await readEvidenceObject(
            f,
            "migration-deploy-apply/preflight-migration-job.json",
          );
          assert.deepEqual(
            podContainers(jobTemplate(evidenceObject(apply.spec, "apply Job")).spec)[0]?.args,
            [...selectedImageMigrationEntry, "--apply-for-installation", "ins_test"],
          );
          const journal = JSON.parse(await readFile(`${f.evidence}.migration-state.json`, "utf8"));
          assert.deepEqual(Object.keys(journal.stages), ["apply"]);
          assert.equal(journal.stages.apply.state, "creating");
          assert.equal(journal.stages.apply.history, null);
          await assert.rejects(
            attempt(),
            /apply Job did not succeed with a valid migration result/,
          );
          await assertHeld(1);
        } else {
          // Leave a terminal apply Job with a known deletion refusal before any
          // verification. Independently settle its resources in the fixture,
          // then change the credential's version to model a rotation.
          await writeFile(
            statePath,
            JSON.stringify({
              ...stopped,
              preflightFault: { target: "job.batch", mode: "delete-refused" },
              preflightResults: {
                migration: {
                  phase: "Succeeded",
                  log:
                    '{"event":"migration.completed","history":"preAuthenticationStates"}\n' +
                    '{"event":"migration.checked","history":"completed"}\n',
                },
              },
            }),
          );
          await assert.rejects(attempt(), /migration Job or Pod cleanup is unresolved/);
          const known = await f.state();
          await writeFile(
            statePath,
            JSON.stringify({
              ...known,
              preflightFault: null,
              preflight: {
                ...requireRecoveryPreflight(known),
                jobs: {},
                pods: {},
                secrets: {
                  ...migrationSecrets,
                  [String(databaseSecretName)]: {
                    metadata: { ...databaseSecret.metadata, resourceVersion: "2" },
                  },
                },
              },
            }),
          );
          await assert.rejects(attempt(), /migrator or database CA Secret changed/);
          await assertHeld(1);
        }
      });
    }
  });

  test(
    "the image-upgrade startup preflight validates the API's mounted theme before stopping writers",
    { concurrency: true },
    async (t) => {
      if (skipWithoutHelm(t, realHelm)) {
        return;
      }
      const runs: Promise<void>[] = [];
      for (const [name, theme, failure] of [
        [
          "valid",
          { schemaVersion: 1, displayName: "Example Console", colors: { accent: "#2457C5" } },
          null,
        ],
        [
          "invalid color",
          { schemaVersion: 1, colors: { accent: "blue" } },
          /colors must use supported roles/,
        ],
        [
          "missing image",
          { schemaVersion: 1, logo: "missing.png" },
          /cannot read the configured bundle/,
        ],
      ] as const) {
        runs.push(
          t.test(name, async (t) => {
            const themeName = "console-theme-reviewed";
            const f = await fixture(t, {
              controllerOnly: true,
              chart: {
                values: (values) => ({
                  ...values,
                  api: { ...values.api, consoleTheme: { configMapName: themeName } },
                }),
                installation: (installation) => installation,
                configMaps: { [themeName]: { data: { "theme.json": JSON.stringify(theme) } } },
              },
            });
            // Helm renders the real theme mount. The generated Pod command runs real source
            // loaders against actual files; only external cluster command protocols are fixtures.
            if (failure) {
              await assert.rejects(f.run("--preflight-only"), (error) => {
                const stderr = commandStderr(error);
                return (
                  /the selected controller image cannot start the api with the candidate Installation:/.test(
                    stderr,
                  ) &&
                  /No OCC writer was stopped/.test(stderr) &&
                  failure.test(stderr)
                );
              });
              const state = await assertStoppedBeforeWriters(f);
              assert.deepEqual(
                list(requireRecoveryPreflight(state).deleted, "preflight deletions")
                  .map((resource) => {
                    assert.ok(typeof resource === "string");
                    return resource.split("/")[0];
                  })
                  .sort(),
                [
                  "job.batch",
                  "job.batch",
                  "job.batch",
                  "networkpolicy.networking.k8s.io",
                  "secret",
                ],
              );
              assert.match(await f.readEvidence("preflight-api.log"), failure);
              assert.match(
                await f.readEvidence("preflight-worker.log"),
                /installation-startup-ready/,
              );
            } else {
              const result = await f.run("--preflight-only");
              assert.match(result.stdout, /preflight/i);
              await assertStoppedBeforeWriters(f);
            }
          }),
        );
      }
      await Promise.all(runs);
    },
  );

  // The 2026-09-28 release example offered DevDay Presets through presets.files; later
  // images no longer ship those files (finding 436). The selected controller image must
  // reject that Installation before quiescence, so the old release keeps serving.
  test("an Installation the selected controller image cannot load stops before any writer stops", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      chart: {
        installation: (installation) => ({
          ...installation,
          presets: { includeDefaults: true, files: ["/app/deploy/presets/devday.json"] },
        }),
      },
    });
    await assert.rejects(f.run(), (error) => {
      const stderr = commandStderr(error);
      return /cannot start the api with the candidate Installation: .*Preset file \/app\/deploy\/presets\/devday\.json is unavailable\..*No OCC writer was stopped/s.test(
        stderr,
      );
    });
    // All three preflight Jobs and their dependencies are removed after the refusal.
    const state = await assertStoppedBeforeWriters(f);
    // Both components fail the same way, and both logs are saved (finding 447).
    for (const component of ["api", "worker"]) {
      assert.match(
        await f.readEvidence(`preflight-${component}.log`),
        /Preset file \/app\/deploy\/presets\/devday\.json is unavailable\./,
      );
    }
    assert.deepEqual(
      list(requireRecoveryPreflight(state).deleted, "preflight deletions")
        .map((resource) => {
          assert.ok(typeof resource === "string");
          return resource.split("/")[0];
        })
        .sort(),
      ["job.batch", "job.batch", "job.batch", "networkpolicy.networking.k8s.io", "secret"],
    );
  });

  test("a Driver refusal preserves field diagnostics before upgrade quiescence", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      chart: {
        installation: (installation) => {
          installation.drivers.compute.configuration.runtime.gatewayStorageClassName = "Bad_Class";
          return installation;
        },
      },
    });
    await assert.rejects(f.run(), (error) => {
      const stderr = commandStderr(error);
      assert.match(
        stderr,
        /cannot start the api with the candidate Installation: .*DRIVER_CONFIGURATION_INVALID.*No OCC writer was stopped/s,
      );
      assert.doesNotMatch(stderr, /Bad_Class/);
      return true;
    });
    await assertStoppedBeforeWriters(f);
    for (const component of ["api", "worker"]) {
      const log = await f.readEvidence(`preflight-${component}.log`);
      const line = log
        .split("\n")
        .find((line) => line.startsWith("DRIVER_CONFIGURATION_INVALID: "));
      assert.ok(line, log);
      assert.deepEqual(JSON.parse(line.slice("DRIVER_CONFIGURATION_INVALID: ".length)), [
        {
          path: "/runtime/gatewayStorageClassName",
          code: "INVALID_FORMAT",
          message:
            "SQLite-compatible gateway storage class must be a DNS-safe Kubernetes resource name.",
        },
      ]);
    }
  });

  // The API and worker read the stored Installation name from the database and refuse
  // one that breaks the Name rule (INSTALLATION_NAME_INVALID). The preflight Pods check
  // the name OCC returns with the selected image's rule, so the refusal comes before any
  // writer stops instead of after (dogfood D525). The Pod carries the stored name as JSON,
  // so a trailing no-break space survives and a line break (a control character) gets the
  // same refusal rather than a parse failure. Each case reads a different component's Pod.
  for (const [name, installationName, component, ...flags] of [
    [
      "a stored Installation name that breaks the Name rule stops before any writer stops",
      "Production\u00a0",
      "api",
    ],
    [
      "preflight-only refuses a stored Installation name with a line break",
      "Production\n",
      "worker",
      "--preflight-only",
    ],
  ] as const) {
    test(name, async (t) => {
      if (skipWithoutHelm(t, realHelm)) {
        return;
      }
      const f = await fixture(t, {
        controllerOnly: true,
        installationName,
        chart: { installation: (installation) => installation },
      });
      await assert.rejects(f.run(...flags), (error) => {
        const stderr = commandStderr(error);
        for (const stopped of ["api", "worker"]) {
          assert.match(
            stderr,
            new RegExp(
              `the ${stopped} startup preflight stopped: The stored Installation name breaks the Name rule: 1 to 200 characters, .*\\. \\(INSTALLATION_NAME_INVALID\\) No OCC writer was stopped; the old release keeps serving\\. Rename the Installation as in docs/guides/deploy/production-upgrade-recovery\\.md#correct-an-invalid-installation-name`,
            ),
          );
        }
        return true;
      });
      await assertStoppedBeforeWriters(f);
      const pod = await readPreflightPod(f, component);
      const container = podContainers(pod.spec)[0];
      assert.ok(container);
      assert.deepEqual(
        containerEnvironment(container).find(
          (variable) => variable.name === "OCC_UPGRADE_PREFLIGHT_INSTALLATION_NAME",
        ),
        {
          name: "OCC_UPGRADE_PREFLIGHT_INSTALLATION_NAME",
          value: JSON.stringify(installationName),
        },
      );
    });
  }

  // An OCC that returns no stored name cannot be checked, so the upgrade stops while
  // building the first preflight Pod, before it creates one or stops a writer.
  test("an Installation read without a stored name stops before any preflight Pod", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      installationName: null,
      chart: { installation: (installation) => installation },
    });
    await assert.rejects(f.run(), (error) => {
      const stderr = commandStderr(error);
      assert.match(
        stderr,
        /upgrade-startup-preflight: OCC did not return the stored Installation name\./,
      );
      assert.match(
        stderr,
        /cannot build the api startup preflight Job from the rendered chart; no OCC writer was stopped\./,
      );
      return true;
    });
    // Only the NetworkPolicy and Secret were created, and both are removed again.
    const state = await assertStoppedBeforeWriters(f);
    assert.deepEqual(
      list(requireRecoveryPreflight(state).deleted, "preflight deletions")
        .map((resource) => {
          assert.ok(typeof resource === "string");
          return resource.split("/")[0];
        })
        .sort(),
      ["networkpolicy.networking.k8s.io", "secret"],
    );
  });

  test("startup preflight checks the OpenShell bearer file in each writer Pod", async (t) => {
    assert.ok(realHelm, "helm is required to exercise the stock chart");
    const directory = await temporaryDirectory(t, "openshell-bearer-");
    const token = join(directory, "synthetic-bearer");
    const f = await fixture(t, {
      controllerOnly: true,
      chart: {
        installation: (installation) => {
          const selected = evidenceObject(
            createCredentialProxyInstallationConfiguration(),
            "OpenShell Installation",
          );
          const backend = openShellBackend(selected);
          const configuration = evidenceObject(backend.configuration, "OpenShell configuration");
          evidenceObject(configuration.auth, "OpenShell bearer configuration").path = token;
          delete evidenceObject(backend.drivers, "OpenShell Driver links").credential_proxy;
          const drivers = evidenceObject(selected.drivers, "OpenShell Drivers");
          installation.backend = selected.backend;
          installation.drivers.sandbox = drivers.sandbox;
          installation.drivers.credential_gateway = drivers.credential_gateway;
          return installation;
        },
      },
    });
    await assert.rejects(f.run("--preflight-only"), (error) => {
      const stderr = commandStderr(error);
      assert.match(stderr, /OpenShell bearer token file must be readable in this Pod/);
      return true;
    });
    for (const component of ["api", "worker"]) {
      const log = await f.readEvidence(`preflight-${component}.log`);
      assert.match(log, /OpenShell bearer token file must be readable/);
      assert.ok(!log.includes(token));
    }
    await assertStoppedBeforeWriters(f);

    // Run the emitted commands with a synthetic file visible to the API only.
    await writeFile(token, "synthetic-file-content", { mode: 0o644 });
    const api = await f.runIdentityCheck("api", "job", undefined, [token]);
    assert.equal(api.phase, "Succeeded", typeof api.log === "string" ? api.log : "");
    assert.ok(typeof api.log === "string", "expected api preflight output");
    assert.match(api.log, /^installation-startup-ready$/m);
    assert.ok(!api.log.includes("synthetic-file-content"));
    await rm(token);
    const worker = await f.runIdentityCheck("worker", "job");
    assert.equal(worker.phase, "Failed", typeof worker.log === "string" ? worker.log : "");
    assert.ok(typeof worker.log === "string", "expected worker preflight output");
    assert.match(worker.log, /OpenShell bearer token file must be readable/);

    // mTLS has separate certificate projections and does not select a bearer file.
    const state = await f.state();
    const data = evidenceObject(
      evidenceObject(state.secret, "live Installation Secret").data,
      "live Installation Secret data",
    );
    const encodedInstallation = data["installation.yaml"];
    assert.ok(
      typeof encodedInstallation === "string",
      "expected the live Installation Secret data",
    );
    const installation = readJsonObject(
      Buffer.from(encodedInstallation, "base64").toString("utf8"),
      "live Installation",
    );
    const backend = openShellBackend(installation);
    evidenceObject(backend.configuration, "OpenShell configuration").auth = {
      mode: "mtls",
      certificatePath: "/synthetic/tls.crt",
      privateKeyPath: "/synthetic/tls.key",
    };
    data["installation.yaml"] = Buffer.from(JSON.stringify(installation)).toString("base64");
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const mtls = await f.runIdentityCheck("worker", "job");
    assert.equal(mtls.phase, "Succeeded", typeof mtls.log === "string" ? mtls.log : "");
  });

  // Releases with the shared tenant namespace refuse to start on a single-cluster
  // Installation that still has split-layout Gateway storage. The startup preflight
  // runs that Compute check with the selected image before quiescence, so the old
  // release keeps serving and the operator is pointed at the documented options.
  test("split-layout Gateway storage stops the startup preflight before any writer stops", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const namespaceId = "ns_split_00000000-0000-4000-8000-000000000001";
    const f = await fixture(t, {
      controllerOnly: true,
      chart: { installation: (installation) => installation },
      kubernetesNamespaces: [
        {
          metadata: {
            name: kubernetesGatewayNamespaceName(namespaceId),
            labels: { "openclaw.dev/gateway-namespace": namespaceId },
          },
        },
      ],
    });
    await assert.rejects(f.run(), (error) => {
      const stderr = commandStderr(error);
      for (const component of ["api", "worker"]) {
        assert.match(
          stderr,
          new RegExp(
            `the ${component} startup preflight stopped: Kubernetes Compute startup preflight refused the candidate release: Existing split-layout Gateway storage prevents this single-cluster upgrade\\..* No OCC writer was stopped; the old release keeps serving\\. See docs/reference/drivers/kubernetes-compute\\.md#existing-split-layout-installations\\.`,
          ),
        );
      }
      return true;
    });
    // Each Pod refused the layout during Compute preflight, before the database identity check.
    assert.equal(f.databaseSessions.length, 0);
    assert.equal(f.kubernetesReads.filter((path) => path === "/api/v1/namespaces").length, 2);
    await assertStoppedBeforeWriters(f);
  });

  // A Kubernetes API the preflight Pod cannot use is not a refusal of the release:
  // the helper says so, names the access the Pod had, and still stops first.
  test("a denied Kubernetes API stops the startup preflight as incomplete", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      chart: { installation: (installation) => installation },
      kubernetesDenied: true,
    });
    await assert.rejects(f.run(), (error) => {
      const stderr = commandStderr(error);
      for (const component of ["api", "worker"]) {
        assert.match(
          stderr,
          new RegExp(
            `the ${component} startup preflight stopped: Kubernetes Compute startup preflight could not complete: .* No OCC writer was stopped; the old release keeps serving\\. The Pod uses the installed release's service account and RBAC`,
          ),
        );
      }
      assert.doesNotMatch(stderr, /refused the candidate release|split-layout/);
      return true;
    });
    await assertStoppedBeforeWriters(f);
  });

  // Two-cluster tenant grants in the execution stand-in. Both preflight Pods share
  // one kubeconfig there, so a grant set is the union of the API and worker roles.
  const tenantNamespaces = ["oce-unbound", "oce-tenant"].map((name) => ({
    metadata: { name, labels: { "openclaw.dev/namespace": `ns_${name}` } },
  }));
  const rule = (attributes: Record<string, unknown>) =>
    [
      attributes.group || "core",
      attributes.verb,
      `${attributes.resource}${attributes.subresource ? `/${attributes.subresource}` : ""}`,
    ].join(" ");
  // The openclaw-execution release-era tenant roles: API Deployment lists; worker Pod
  // reads and proxy reads (plus writes the check never asks about).
  const releaseTenantRules = [
    "apps list deployments",
    "core get pods",
    "core list pods",
    "core get pods/proxy",
  ];
  // Bootstrap Jobs use the batch API even when runtime log access is disabled.
  const currentWorkerRules = [
    "core patch pods",
    "batch get jobs",
    "batch create jobs",
    "batch delete jobs",
  ];
  const currentTenantRules = [
    ...releaseTenantRules,
    ...currentWorkerRules,
    "core get pods/log",
    "core get events",
    "core list events",
  ];
  // oce-unbound has no tenant RoleBinding, so nothing is allowed there.
  const tenantGrants = (rules: readonly string[]) => (attributes: Record<string, unknown>) =>
    attributes.namespace === "oce-tenant" && rules.includes(rule(attributes));

  // The execution chart is a separate Helm release that the helper does not upgrade.
  // Each startup preflight Pod asks the execution cluster, as its own identity, for
  // the tenant rules this release needs, so a chart left at the release-era grants
  // stops the upgrade before any writer stops and names the documented step.
  test("a two-cluster execution chart without the new tenant grants stops the startup preflight", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      chart: { installation: (installation) => installation },
      executionCluster: { namespaces: tenantNamespaces, allows: tenantGrants(releaseTenantRules) },
    });
    await assert.rejects(f.run(), (error) => {
      const stderr = commandStderr(error);
      for (const [component, missing] of [
        ["api", "get pods/log, get events, list events"],
        ["worker", "patch pods, get jobs, create jobs, delete jobs"],
      ]) {
        assert.match(
          stderr,
          new RegExp(
            `the ${component} startup preflight stopped: Kubernetes Compute startup preflight refused the candidate release: The execution cluster's tenant ${component} grant in Namespace oce-tenant lacks ${missing}\\. Upgrade the openclaw-execution chart before this release\\. No OCC writer was stopped; the old release keeps serving\\. Upgrade the execution release as in docs/testing/kubernetes\\.md#upgrade-the-execution-chart`,
          ),
        );
      }
      return true;
    });
    // The unbound tenant Namespace was skipped after its baseline review.
    assert.deepEqual(
      f.accessReviews
        .filter((review) => review.namespace === "oce-unbound")
        .map(rule)
        .sort(),
      ["apps list deployments", "core get pods"],
    );
    await assertStoppedBeforeWriters(f);
  });

  test("a two-cluster execution chart with the new tenant grants passes the startup preflight", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      chart: { installation: (installation) => installation },
      executionCluster: { namespaces: tenantNamespaces, allows: tenantGrants(currentTenantRules) },
    });
    await f.run();
    assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
    // Each component asked for its own new rules in the bound tenant Namespace.
    assert.deepEqual(
      f.accessReviews
        .filter((review) => review.namespace === "oce-tenant")
        .map(rule)
        .sort(),
      [
        "apps list deployments",
        "batch create jobs",
        "batch delete jobs",
        "batch get jobs",
        "core get events",
        "core get pods",
        "core get pods",
        "core get pods/log",
        "core get pods/proxy",
        "core list events",
        "core list pods",
        "core patch pods",
      ],
    );
    assert.ok(
      f.accessReviews.every((review) => review.allowed === (review.namespace === "oce-tenant")),
    );
    assert.ok(f.executionReads.includes("/api/v1/namespaces/kube-system"));
  });

  // An execution authorizer that cannot evaluate the reviews leaves the check incomplete:
  // the helper says which kubeconfig and access the Pod needed, and still stops first.
  test("an unevaluated two-cluster tenant grant review stops the startup preflight as incomplete", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      chart: { installation: (installation) => installation },
      executionCluster: {
        namespaces: tenantNamespaces,
        allows: () => ({ allowed: false, evaluationError: "webhook authorizer unavailable" }),
      },
    });
    await assert.rejects(f.run(), (error) => {
      const stderr = commandStderr(error);
      for (const component of ["api", "worker"]) {
        assert.match(
          stderr,
          new RegExp(
            `the ${component} startup preflight stopped: Kubernetes Compute startup preflight could not complete: The execution cluster tenant grant review failed: could not evaluate .* in Namespace oce-unbound: webhook authorizer unavailable No OCC writer was stopped; the old release keeps serving\\. The Pod used its execution cluster kubeconfig, which must list Namespaces and create SelfSubjectAccessReviews there`,
          ),
        );
      }
      assert.doesNotMatch(stderr, /refused the candidate release|openclaw-execution chart/);
      return true;
    });
    assert.deepEqual(
      f.accessReviews.map((review) => review.allowed),
      [false, false],
    );
    await assertStoppedBeforeWriters(f);
  });

  // With runtime logs off, the release's tenant API role carries no log or Event reads, so
  // the preflight asks only for the rules that release needs.
  test("a two-cluster upgrade with runtime logs off needs no log grants in the execution chart", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      chart: {
        installation: (installation) => installation,
        values: (values) => ({ ...values, agentRuntimeLogs: { enabled: false } }),
      },
      executionCluster: {
        namespaces: tenantNamespaces,
        allows: tenantGrants([...releaseTenantRules, ...currentWorkerRules]),
      },
    });
    await f.run();
    assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
    assert.deepEqual(
      f.accessReviews
        .filter((review) => review.namespace === "oce-tenant")
        .map(rule)
        .sort(),
      [
        "apps list deployments",
        "batch create jobs",
        "batch delete jobs",
        "batch get jobs",
        "core get pods",
        "core get pods",
        "core get pods/proxy",
        "core list pods",
        "core patch pods",
      ],
    );
  });

  test("preprovisioned Namespace canaries refuse image upgrades before cluster access", async (t) => {
    const f = await fixture(t, { controllerOnly: true });
    const path = join(f.directory, "values.json");
    const values = evidenceObject(await yamlFile(path), "saved Helm values");
    values.preprovisionedNamespace = {
      namespaceId: continuityNamespace,
      uid: "0f4c2a9e-6b1d-4c3e-9a7f-2d5e8b1c4a60",
    };
    await writeFile(path, JSON.stringify(values));
    await writeFile(join(f.directory, "live-values"), JSON.stringify(values));
    // This closed canary omits the chart-owned initializer and migrator identity;
    // the upgrade must refuse before it creates any preflight workload.
    await assert.rejects(
      f.run("--preflight-only"),
      /production image upgrades require the chart initialization Job; preprovisioned Namespace canaries manage database upgrades separately/,
    );
    assert.ok(!f.commands.includes("kubectl"));
    assert.ok(!f.commands.includes("occ"));
    assert.deepEqual(await f.events(), []);
    const state = await f.state();
    assert.deepEqual([state.api, state.worker, state.version], [1, 1, 1]);
  });

  // The helper waits for every preflight Pod and saves its status and log before it
  // reports, so a refusal names each failing component, not only the first.
  test("a failed startup preflight reports and saves every component before cleanup", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightResults: {
        api: {
          status: {
            phase: "Pending",
            containerStatuses: [
              { name: "api", state: { waiting: { reason: "ImagePullBackOff" } } },
            ],
          },
        },
        worker: { phase: "Failed", log: "loading drivers\nworker cannot load the Installation\n" },
        migration: { phase: "Failed", log: "migration history is inconsistent\n" },
      },
    });
    await assert.rejects(f.run(), (error) => {
      const stderr = commandStderr(error);
      assert.match(
        stderr,
        /the api startup preflight Pod cannot start \(ImagePullBackOff\); no OCC writer was stopped\./,
      );
      assert.match(
        stderr,
        /cannot start the worker with the candidate Installation: loading drivers worker cannot load the Installation No OCC writer was stopped/,
      );
      assert.match(stderr, /could not confirm database migration compatibility/);
      return true;
    });
    const status = await readStatus(f, "preflight-api-status.json");
    const statuses = evidenceArray(status.containerStatuses, "container statuses");
    const container = evidenceObject(statuses[0], "API container status");
    const containerState = evidenceObject(container.state, "API container state");
    assert.equal(
      evidenceObject(containerState.waiting, "API waiting state").reason,
      "ImagePullBackOff",
    );
    assert.match(await f.readEvidence("preflight-api-logs.err"), /waiting to start/);
    assert.equal((await f.readEvidence("preflight-api.log")).trim(), "");
    assert.equal((await readStatus(f, "preflight-worker-status.json")).phase, "Failed");
    assert.equal(
      await f.readEvidence("preflight-worker.log"),
      "loading drivers\nworker cannot load the Installation\n",
    );
    assert.equal(
      await f.readEvidence("preflight-migration.log"),
      "migration history is inconsistent\n",
    );
    assert.equal((await readStatus(f, "preflight-migration-status.json")).phase, "Failed");
    const state = await assertStoppedBeforeWriters(f);
    assert.deepEqual(
      list(requireRecoveryPreflight(state).deleted, "preflight deletions")
        .map((resource) => {
          assert.ok(typeof resource === "string");
          return resource.split("/")[0];
        })
        .sort(),
      ["job.batch", "job.batch", "job.batch", "secret"],
    );
  });

  // A Pod that cannot reach the database is not refused by the Installation: its next step
  // names the database, the chart's database values and the egress policies. Other
  // refusals keep pointing at the Installation.
  test("a database connection refusal names its own inputs, not the Installation", async (t) => {
    const connection =
      "Candidate application database Installation identity could not be verified: this Pod could not open a connection to the database. Check that PostgreSQL is running and that the chart's database egress (database.cidrs) admits its current address; a refused sign-in or a failed TLS handshake also stops here.";
    const f = await fixture(t, {
      controllerOnly: true,
      preflightResults: {
        api: {
          phase: "Failed",
          log: `kubernetes-compute-preflight-passed\nagent-drafts-accepted\n${connection}\n`,
        },
        worker: { phase: "Failed", log: "loading drivers\nworker cannot load the Installation\n" },
      },
    });
    await assert.rejects(f.run(), (error) => {
      const lines = commandStderr(error).split("\n");
      const api = lines.find((line) => line.includes("cannot start the api"));
      const worker = lines.find((line) => line.includes("cannot start the worker"));
      assert.ok(api !== undefined && worker !== undefined, commandStderr(error));
      assert.ok(api.includes(connection), api);
      assert.match(
        api,
        /No OCC writer was stopped; correct the database, the chart's database values \(database\.cidrs\) or the network policies that admit this Pod's database egress, then start again with a new evidence directory\.$/,
      );
      assert.doesNotMatch(api, /correct the Installation/);
      assert.match(worker, /No OCC writer was stopped; correct the Installation and start again/);
      return true;
    });
    await assertStoppedBeforeWriters(f);
  });

  test("startup preflight retains the failed API CA assembler's guidance", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const guidance =
      'assemble-api-ca: auth.oidc.caSecretName Secret "idp-ca" key "ca.crt": certificate 1 of 1 has invalid base64';
    const f = await fixture(t, {
      controllerOnly: true,
      chart: {
        installation: (installation) => installation,
        values: (values) => ({
          ...values,
          auth: {
            ...values.auth,
            recoveryUserId: "existing-administrator",
            oidc: {
              enabled: true,
              issuer: "https://sso.example.test",
              authorizationUrl: "https://sso.example.test/authorize",
              tokenUrl: "https://sso.example.test/token",
              jwksUrl: "https://sso.example.test/jwks",
              caSecretName: "idp-ca",
              caSecretKey: "ca.crt",
            },
          },
        }),
      },
      preflightResults: {
        api: {
          status: {
            phase: "Failed",
            initContainerStatuses: [
              { name: "assemble-api-ca", state: { terminated: { exitCode: 1 } } },
            ],
          },
          initLogs: { "assemble-api-ca": guidance + "\n" },
        },
        worker: { phase: "Succeeded", log: "installation-startup-ready\n" },
      },
    });
    const failure = await runForFailure(f.run, "--preflight-only");
    assert.equal(failure.code, 1);
    assert.ok(failure.stderr.includes(guidance), failure.stderr);
    assert.equal(await f.readEvidence("preflight-api.log"), guidance + "\n");
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    await assertStoppedBeforeWriters(f);
  });

  // Bash must not remove a NUL and turn malformed output into the literal ready marker.
  test("startup preflight rejects a ready marker containing a NUL byte", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightResults: {
        api: { phase: "Succeeded", log: "installation-startup-\0ready\n" },
      },
    });
    await assert.rejects(f.run("--preflight-only"), /cannot read the api startup preflight logs/);
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    await assertStoppedBeforeWriters(f);
  });

  test("kubectl log warnings do not reject a valid migration check", async (t) => {
    const log = 'Starting migration check\n{"event":"migration.checked","history":"completed"}\n';
    const warning = "Warning: API server warning accompanying successful logs\n";
    const f = await fixture(t, {
      preflightResults: { migration: { phase: "Succeeded", log, logWarning: warning } },
    });
    // Container output and successful kubectl diagnostics are independent streams.
    // The real helper must find the check record without accepting a wrong marker.
    await f.run("--preflight-only");
    assert.equal(await f.readEvidence("preflight-migration.log"), log);
    assert.equal(await f.readEvidence("preflight-migration-logs.err"), warning);
    assert.ok(existsSync(join(f.evidence, "startup-preflight-passed")));
    await assertStoppedBeforeWriters(f);
  });

  test("a failed kubectl log read cannot authorize migration from partial stdout", async (t) => {
    const log = '{"event":"migration.checked","history":"completed"}\n';
    const f = await fixture(t, {
      preflightResults: {
        migration: {
          phase: "Succeeded",
          log,
          logWarning: "log stream interrupted\n",
          logExitCode: 1,
        },
      },
    });
    // A check marker received before a failed log request is not a successful observation.
    await assert.rejects(
      f.run("--preflight-only"),
      /cannot read the migration startup preflight logs/,
    );
    assert.equal(await f.readEvidence("preflight-migration.log"), log);
    assert.match(await f.readEvidence("preflight-migration-logs.err"), /log stream interrupted/);
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    await assertStoppedBeforeWriters(f);
  });

  test("a completed migration preflight without a valid check result leaves writers running", async (t) => {
    for (const log of [
      '{"event":"migration.completed","history":"providerCompleted"}\n',
      '{"event":"migration.checked","history":null}\n',
    ]) {
      const f = await fixture(t, {
        controllerOnly: true,
        preflightResults: { migration: { phase: "Succeeded", log } },
      });
      await assert.rejects(
        f.run("--preflight-only"),
        /migration preflight succeeded without migration.checked/,
      );
      assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
      await assertStoppedBeforeWriters(f);
    }
  });

  test("a preflight Pod that outlives the timeout does not hide another component's failure", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightResults: {
        api: {
          status: {
            phase: "Pending",
            conditions: [
              {
                type: "PodScheduled",
                status: "False",
                reason: "Unschedulable",
                message: "0/3 nodes are available",
              },
            ],
          },
        },
        worker: { phase: "Failed", log: "worker cannot load the Installation\n" },
      },
    });
    await assert.rejects(f.run("--timeout-seconds", "3"), (error) => {
      const stderr = commandStderr(error);
      assert.match(
        stderr,
        /the api startup preflight did not finish before the timeout \(Unschedulable: 0\/3 nodes are available\)/,
      );
      assert.match(stderr, /cannot start the worker with the candidate Installation/);
      return true;
    });
    assert.equal(
      await f.readEvidence("preflight-worker.log"),
      "worker cannot load the Installation\n",
    );
    await assertStoppedBeforeWriters(f);
  });

  test("an Installation the selected controller image loads passes the preflight and upgrades", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    // Truncating this valid release at 26 characters leaves a dot; derived Job
    // names must still meet Kubernetes admission rules after their suffix is added.
    const release = `${"a".repeat(25)}.b`;
    const f = await fixture(t, {
      controllerOnly: true,
      release,
      // A 200-character name: if Kubernetes expanded $(OCC_CONFIG_PATH) in the Pod's
      // environment, the preflight would see a longer name and refuse it.
      installationName: `${"A".repeat(182)}$(OCC_CONFIG_PATH)`,
      chart: { installation: (installation) => installation },
    });
    await f.run("--timeout-seconds", "60");
    const state = await f.state();
    assert.equal(state.controller, newController);
    assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
    const preflight = requireRecoveryPreflight(state);
    assert.deepEqual(preflight.secrets, {});
    assert.deepEqual(preflight.pods, {});
    assert.deepEqual(preflight.jobs, {});
    const created = list(preflight.created, "preflight creations");
    const deleted = list(preflight.deleted, "preflight deletions");
    const jobs = created.filter((resource) => field(resource, "kind") === "job.batch");
    assert.equal(jobs.length, 3);
    for (const job of jobs) {
      const name = field(job, "name");
      assert.ok(typeof name === "string");
      assert.ok(name.length <= 63, "Kubernetes Job names cannot exceed 63 characters");
      assert.match(name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/);
      assert.ok(deleted.includes(`job.batch/${name}`));
    }
    const secret = created.find((resource) => field(resource, "kind") === "secret");
    assert.ok(secret, "expected a temporary Installation Secret");
    const secretName = field(secret, "name");
    assert.ok(
      typeof secretName === "string" && secretName.startsWith(`${release}-upgrade-preflight-`),
    );
    const job = await readEvidenceObject(f, "preflight-worker-job.json");
    const jobSpec = evidenceObject(job.spec, "worker Job spec");
    const pod = jobTemplate(jobSpec);
    assert.equal(job.apiVersion, "batch/v1");
    assert.equal(job.kind, "Job");
    assert.equal(jobSpec.backoffLimit, 0);
    assert.equal(jobSpec.parallelism, 1);
    assert.equal(jobSpec.completions, 1);
    assert.equal(jobSpec.activeDeadlineSeconds, 60);
    assert.equal(pod.spec.restartPolicy, "Never");
    // The Pod runs the selected image with the chart's service account and Installation mount.
    assert.equal(podContainers(pod.spec)[0]?.image, newController);
    assert.equal(pod.spec.serviceAccountName, "openclaw-enterprise-worker");
    const installationMount = podVolumes(pod.spec).find(
      (volume) => volume.name === "installation-startup",
    );
    assert.ok(installationMount, "expected the worker's candidate Installation volume");
    const deletedSecret = deleted.find(
      (resource): resource is string =>
        typeof resource === "string" && resource.startsWith("secret/"),
    );
    assert.ok(deletedSecret, "expected the candidate Installation Secret to be cleaned up");
    assert.equal(
      evidenceObject(installationMount.secret, "worker Installation volume Secret").secretName,
      deletedSecret.slice("secret/".length),
    );
    // Both Pods ran Kubernetes Compute preflight on this shared-layout state.
    for (const component of ["api", "worker"]) {
      const log = await f.readEvidence(`preflight-${component}.log`);
      assert.match(log, /^kubernetes-compute-preflight-passed$/m);
      assert.match(log, /^installation-startup-ready$/m);
    }
    assert.equal(f.databaseSessions.length, 2);
    for (const session of f.databaseSessions) {
      assert.equal(session.user, "candidate_app");
      assert.equal(session.queries[0], "BEGIN READ ONLY");
    }
    assert.equal(f.kubernetesReads.filter((path) => path === "/api/v1/namespaces").length, 2);
    // The chart's default-deny policy selects the preflight Pods too. The temporary
    // policy selects exactly them and grants the candidate's dependency egress.
    const policy = await readEvidenceObject(f, "preflight-networkpolicy.json");
    const policySpec = evidenceObject(policy.spec, "preflight NetworkPolicy spec");
    assert.deepEqual(
      evidenceObject(policySpec.podSelector, "preflight NetworkPolicy Pod selector").matchLabels,
      pod.metadata.labels,
    );
    const rendered = (await f.readEvidence("preflight-rendered.jsonl"))
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => readJsonObject(line, "rendered chart resource"));
    const initialization = rendered.find(
      (document) =>
        document.apiVersion === "batch/v1" &&
        document.kind === "Job" &&
        asRecord(document.metadata)?.name === `${release}-initialization`,
    );
    assert.ok(initialization, "expected the chart initialization Job");
    const initializer = jobTemplate(evidenceObject(initialization.spec, "initialization Job spec"));
    const initContainers = podContainers(initializer.spec, "initContainers");
    assert.ok(
      initContainers.some((container) => container.name === "installation-check"),
      "the upgrade initialization Job includes the installation-check init container",
    );
    const migrationPod = await readPreflightPod(f, "migration");
    const migration = initContainers.find((container) => container.name === "migration");
    assert.ok(migration, "expected the chart's migration init container");
    // The read-only check uses the actual chart's migrator Secret, CA and Pod identity,
    // without replaying bootstrap or the initializer's schema-changing command.
    const migrationContainers = podContainers(migrationPod.spec);
    assert.equal(migrationContainers.length, 1);
    assert.equal(migrationPod.spec.initContainers, undefined);
    assert.deepEqual(migrationContainers[0], {
      ...migration,
      command: ["node"],
      args: [...selectedImageMigrationEntry, "--check"],
    });
    assert.ok(
      containerEnvironment(migration).some(
        (variable) =>
          variable.name === "OCC_MIGRATION_DATABASE_URL" &&
          asRecord(variable.valueFrom)?.secretKeyRef,
      ),
    );
    assert.equal(migrationPod.spec.serviceAccountName, initializer.spec.serviceAccountName);
    assert.equal(
      migrationPod.spec.automountServiceAccountToken,
      initializer.spec.automountServiceAccountToken,
    );
    assert.deepEqual(migrationPod.spec.securityContext, initializer.spec.securityContext);
    assert.deepEqual(migrationPod.metadata.labels, initializer.metadata.labels);
    const migrationMounts = evidenceArray(migration.volumeMounts, "migration volume mounts");
    assert.deepEqual(
      migrationPod.spec.volumes,
      podVolumes(initializer.spec).filter((volume) =>
        migrationMounts.some(
          (mount) => evidenceObject(mount, "migration volume mount").name === volume.name,
        ),
      ),
    );
    assert.ok(
      podVolumes(migrationPod.spec).some(
        (volume) => volume.name === "database-ca" && volume.secret,
      ),
    );
    assert.deepEqual(JSON.parse(await f.readEvidence("preflight-migration.log")), {
      event: "migration.checked",
      history: "providerCompleted",
    });
    const dependencyEgress = rendered.find(
      (document) =>
        document.kind === "NetworkPolicy" &&
        asRecord(document.metadata)?.name === "openclaw-enterprise-dependency-egress",
    );
    assert.ok(dependencyEgress, "expected the chart dependency egress NetworkPolicy");
    assert.deepEqual(
      policySpec.egress,
      evidenceObject(dependencyEgress.spec, "chart dependency egress spec").egress,
    );
    assert.deepEqual(preflight.networkpolicies, {});
    const policyName = evidenceObject(policy.metadata, "preflight NetworkPolicy metadata").name;
    assert.ok(typeof policyName === "string", "expected a named temporary NetworkPolicy");
    assert.ok(deleted.includes(`networkpolicy.networking.k8s.io/${policyName}`));
  });

  test("preflight-only checks the candidate without preparing or deploying it", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      agent: true,
      chart: { installation: (installation) => installation },
    });
    const state = await f.state();
    state.denyWorkerPatch = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(f.run("--resume", "--preflight-only"), /cannot be combined/);
    assert.equal(existsSync(f.evidence), false);
    assert.match((await f.run("--preflight-only")).stdout, /Preflight passed/);
    assert.match(await f.readEvidence("preflight-worker.log"), /^installation-startup-ready$/m);
    // The API Pod checked the recorded Agent's draft with the selected image's deploy rules.
    assert.match(await f.readEvidence("preflight-api.log"), /^agent-drafts-accepted$/m);
    assert.deepEqual(JSON.parse(await f.readEvidence("preflight-migration.log")), {
      event: "migration.checked",
      history: "providerCompleted",
    });
    assert.equal(existsSync(join(f.evidence, "prepared")), false);
    await assert.rejects(f.run("--resume"), /not a prepared deployment/);
    await assertStoppedBeforeWriters(f);
  });

  // A draft saved before the selected release retired one of its settings: deploy admission
  // refuses it, so before finding 2809 the upgrade moved the controller and then stopped at the
  // fleet deploy with the Agents on the old runtime. The API preflight Pod runs the selected
  // image's own stored-Configuration rules on each recorded Agent's draft, so the rehearsal and
  // the release itself stop before any writer stops, with OCC's deploy message for each Agent.
  for (const preflightOnly of [true, false]) {
    test(`${preflightOnly ? "preflight-only" : "the release"} refuses an Agent draft the selected image would not deploy`, async (t) => {
      if (skipWithoutHelm(t, realHelm)) {
        return;
      }
      const f = await fixture(t, {
        agent: true,
        chart: { installation: (installation) => installation },
        configurationValues: {
          cfg_agt_test: { security: { preset: "corporate" }, tools: { exec: { mode: "full" } } },
        },
      });
      await assert.rejects(f.run(...(preflightOnly ? ["--preflight-only"] : [])), (error) => {
        const stderr = commandStderr(error);
        assert.match(
          stderr,
          /the selected controller image refuses to deploy 1 recorded Agent draft\(s\):\n {2}- Agent agt_test "Mail triage" in Namespace ns_test: Configuration setting security\.preset must be removed: the OpenClaw runtime retired it \(configure the individual security controls explicitly\)\.\nNo OCC writer was stopped; the old release keeps serving\./,
        );
        return true;
      });
      const state = await assertStoppedBeforeWriters(f);
      assert.equal(state.dispatches, 0);
      assert.equal(existsSync(join(f.evidence, "prepared")), false);
      // Only the API Pod carries the drafts; the worker's check is unchanged.
      const api = await readPreflightPod(f, "api");
      const worker = await readPreflightPod(f, "worker");
      assert.ok(
        podVolumes(api.spec).some((volume) => volume.name === "upgrade-preflight-agent-drafts"),
      );
      assert.ok(
        !podVolumes(worker.spec).some((volume) => volume.name === "upgrade-preflight-agent-drafts"),
      );
    });
  }

  // Deploy admission checks the model provider settings before the other stored-value rules
  // (finding 1549), so the preflight runs them too: a baseUrl the runtime cannot use stops the
  // rehearsal with deploy's message instead of the fleet deploy (finding 2816).
  test("preflight-only refuses a draft's model provider setting that deploy refuses", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      agent: true,
      chart: { installation: (installation) => installation },
      configurationValues: {
        cfg_agt_test: { models: { providers: { openai: { baseUrl: "ftp://models.example/v1" } } } },
      },
    });
    await assert.rejects(f.run("--preflight-only"), (error) => {
      const stderr = commandStderr(error);
      assert.match(
        stderr,
        /refuses to deploy 1 recorded Agent draft\(s\):\n {2}- Agent agt_test "Mail triage" in Namespace ns_test: Configuration field \/models\/providers\/openai\/baseUrl must be an absolute http or https URL\.\n/,
      );
      return true;
    });
    await assertStoppedBeforeWriters(f);
  });

  // Run the generated API program with the real resolver. Catalog rows may use full refs or
  // remainders, but each must name a selected primary or fallback, including entry selections.
  test("the release checks saved model catalogs before stopping writers", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    for (const valid of [false, true]) {
      await t.test(valid ? "selected rows pass" : "an unselected row refuses", async (t) => {
        const values = {
          agents: {
            defaults: {
              model: {
                primary: "openai/synthetic-primary",
                fallbacks: ["openai/synthetic-fallback"],
              },
            },
            entries: {
              researcher: {
                model: {
                  primary: "openai/synthetic-primary",
                  fallbacks: ["openai/synthetic-entry"],
                },
              },
            },
          },
          models: {
            providers: {
              openai: {
                agentRuntime: { id: "openclaw" },
                models: [
                  { id: "synthetic-primary" },
                  { id: "openai/synthetic-fallback" },
                  { id: valid ? "synthetic-entry" : "synthetic-unselected-private-value" },
                ],
              },
            },
          },
        };
        const f = await fixture(t, {
          agent: true,
          chart: { installation: (installation) => installation },
          configurationValues: { cfg_agt_test: values },
        });
        if (valid) {
          await f.run();
          assert.equal((await f.state()).dispatches, 1);
          assert.match(await f.readEvidence("preflight-api.log"), /^agent-drafts-accepted$/m);
        } else {
          await assert.rejects(f.run(), (error) => {
            const stderr = commandStderr(error);
            assert.match(
              stderr,
              /Agent agt_test "Mail triage" in Namespace ns_test: Configuration setting models\.providers\.openai\.models may list only entries whose id names a primary or fallback model set in agents\.defaults\.model or agents\.entries\./,
            );
            assert.match(stderr, /No OCC writer was stopped; the old release keeps serving\./);
            assert.doesNotMatch(commandStdout(error) + stderr, /synthetic-/);
            return true;
          });
          const state = await assertStoppedBeforeWriters(f);
          assert.equal(state.dispatches, 0);
          assert.equal(existsSync(join(f.evidence, "prepared")), false);
          const log = await f.readEvidence("preflight-api.log");
          assert.doesNotMatch(log, /synthetic-|agent-drafts-accepted/);
        }
      });
    }
  });

  // The degraded draft-check paths. Each one either warns and lets OCC check the draft at deploy,
  // as before finding 2809, or stops before any writer stops; none reports drafts as checked
  // when they were not (finding 2815).

  // Shared rules are available, but the resolver capability is not callable.
  // Exercise the generated reporter and the ordinary release's log collector together.
  test("the release refuses an image with an unavailable draft resolver", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      agent: true,
      chart: { installation: (installation) => installation },
      configurationValues: { cfg_agt_test: {} },
      unavailableDraftResolver: true,
    });
    await assert.rejects(f.run(), (error) => {
      const stderr = commandStderr(error);
      assert.match(
        stderr,
        /upgrade-production-images: the selected controller image could not check saved Agent drafts because its configured Harness resolver is unavailable\. No OCC writer was stopped; the old release keeps serving\. Select a corrected controller image and start again with a new evidence directory\./,
      );
      assert.doesNotMatch(
        commandStdout(error) + stderr,
        /correct the Installation|cannot start the api|refuses to deploy|cannot check Agent drafts before the upgrade|agent-drafts-accepted|installation-startup-ready/,
      );
      return true;
    });
    const log = await f.readEvidence("preflight-api.log");
    assert.match(log, /^Agent draft check could not load the configured Harness resolver\.$/m);
    assert.doesNotMatch(
      log,
      /agent-draft-check-unavailable|agent-drafts-accepted|Agent draft refused:|installation-startup-ready/,
    );
    assert.equal((await readStatus(f, "preflight-api-status.json")).phase, "Failed");
    assert.match(await f.readEvidence("preflight-worker.log"), /^installation-startup-ready$/m);
    const state = await assertStoppedBeforeWriters(f);
    assert.equal(state.dispatches, 0);
    assert.equal(state.controller, controller);
    assert.equal(state.helmStatus, "deployed");
    assert.equal(existsSync(join(f.evidence, "prepared")), false);
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
  });

  // An image built before the shared rule cannot check drafts. Its preflight Pod runs and says
  // so; the helper warns and the upgrade deploys, so this draft, which a newer image would
  // refuse, is refused only by the deploy.
  test("an image without the draft rules warns, and the upgrade continues", async (t) => {
    if (skipWithoutHelm(t, realHelm)) {
      return;
    }
    const f = await fixture(t, {
      agent: true,
      chart: { installation: (installation) => installation },
      olderDraftRules: true,
      configurationValues: { cfg_agt_test: { security: { preset: "corporate" } } },
    });
    const result = await f.run();
    assert.match(
      result.stderr,
      /upgrade-production-images: the selected controller image cannot check Agent drafts before the upgrade; OCC checks each draft when the upgrade deploys it\./,
    );
    const log = await f.readEvidence("preflight-api.log");
    assert.match(log, /^agent-draft-check-unavailable$/m);
    assert.doesNotMatch(log, /^agent-drafts-accepted$/m);
    const state = await f.state();
    assert.equal(state.dispatches, 1);
    assert.deepEqual(requireRecoveryPreflight(state).secrets, {});
  });

  // The Secret's values may total 1 MiB. Drafts that do not fit beside the candidate
  // Installation are not sent: the helper warns and the preflight goes on. Random text does not
  // compress, so the drafts stay over 1 MiB gzipped.
  test("drafts that do not fit in the preflight Secret warn, and the preflight passes", async (t) => {
    const f = await fixture(t, {
      agent: true,
      configurationValues: {
        cfg_agt_test: {
          plugins: {
            entries: {
              knowledge: { config: { note: randomBytes(1100 * 1024).toString("base64") } },
            },
          },
        },
      },
    });
    const result = await f.run("--preflight-only");
    assert.match(result.stdout, /Preflight passed/);
    assert.match(
      result.stderr,
      /upgrade-production-images: the recorded Agents' drafts do not fit in the startup preflight Secret beside the candidate Installation, so it does not check them; OCC checks each draft when the upgrade deploys it\./,
    );
    // Neither the Secret nor the API Pod carried the drafts.
    const api = await readPreflightPod(f, "api");
    assert.ok(
      !podVolumes(api.spec).some((volume) => volume.name === "upgrade-preflight-agent-drafts"),
    );
    const container = podContainers(api.spec)[0];
    assert.ok(container);
    assert.ok(
      !containerEnvironment(container).some(
        (variable) => variable.name === "OCC_UPGRADE_PREFLIGHT_AGENT_DRAFTS",
      ),
    );
  });

  registerUpgradePreflightDraftBudgetTest(repository);

  // An API preflight that succeeds without either draft result, as an image that ignored the
  // drafts would, is not taken as a check: the helper stops before any writer stops.
  test("an API preflight that reports no draft result stops the upgrade", async (t) => {
    const f = await fixture(t, {
      agent: true,
      preflightResults: { api: { phase: "Succeeded", log: "installation-startup-ready\n" } },
    });
    await assert.rejects(
      f.run(),
      /the api startup preflight succeeded without checking the Agent drafts; no OCC writer was stopped\./,
    );
    const state = await assertStoppedBeforeWriters(f);
    assert.equal(state.dispatches, 0);
  });

  // Cleanup cases read the inventory after the script creates preflight state.
  registerPreflightCleanupTests(async (t, options) => {
    const f = await fixture(t, options);
    return {
      ...f,
      state: async () => {
        const state = await f.state();
        return { ...state, preflight: requireRecoveryPreflight(state) };
      },
    };
  });

  // The first observation establishes a Pod UID; a later same-name replacement must
  // not inherit permission to supply logs or the successful preflight result.
  for (const mode of ["replace-after-observation", "replace-during-logs"] as const) {
    test(`startup preflight discards unbound logs: ${mode}`, async (t) => {
      const f = await fixture(t, {
        controllerOnly: true,
        preflightFault: { target: "api", mode },
        ...(mode === "replace-after-observation"
          ? {
              preflightResults: { api: { phase: "Running", log: "unbound-log-sentinel\n" } },
            }
          : {}),
      });
      const failure = await runForFailure(f.run, "--preflight-only");
      assert.equal(failure.code, 1);
      assert.match(
        failure.stderr,
        mode === "replace-during-logs"
          ? /cannot bind the api startup preflight logs to the original child Pod; discarded unconfirmed output/
          : /cannot establish the api startup preflight child Pod identity/,
      );
      assert.match(failure.stderr, /no OCC writer was stopped/i);
      const state = await f.state();
      assert.equal(
        list(requireRecoveryPreflight(state).logRequests ?? [], "preflight log requests").includes(
          "api",
        ),
        mode === "replace-during-logs",
      );
      const log = await f.readEvidence("preflight-api.log").catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
        return "";
      });
      assert.doesNotMatch(log, /unbound-log-sentinel/);
      assert.doesNotMatch(commandStdout(failure.error) + failure.stderr, /unbound-log-sentinel/);
      assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
      assert.deepEqual(await f.events(), []);
    });
  }

  test("startup preflight refuses a failed Job even when its retained child succeeded", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightFault: { target: "api", mode: "job-deadline" },
    });
    const failure = await runForFailure(f.run, "--preflight-only");
    assert.equal(failure.code, 1);
    const jobStatus = await readStatus(f, "preflight-api-job-status.json");
    assert.deepEqual(jobStatus.conditions, [
      { type: "Failed", status: "True", reason: "DeadlineExceeded" },
    ]);
    assert.equal((await readStatus(f, "preflight-api-status.json")).phase, "Succeeded");
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    await assertStoppedBeforeWriters(f);
  });

  test("startup preflight without a child points to available timeout evidence", async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightFault: { target: "api", mode: "no-child" },
    });
    const failure = await runForFailure(f.run, "--preflight-only", "--timeout-seconds", "1");
    assert.equal(failure.code, 1);
    for (const file of ["preflight-api-job-status.json", "preflight-api-pods.json"]) {
      assert.ok(failure.stderr.includes(file));
      assert.doesNotThrow(() => {
        JSON.parse(readFileSync(join(f.evidence, file), "utf8"));
      });
    }
    assert.doesNotMatch(failure.stderr, /preflight-api-status\.json/);
    assert.equal(existsSync(join(f.evidence, "preflight-api-status.json")), false);
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    await assertStoppedBeforeWriters(f);
  });
}
