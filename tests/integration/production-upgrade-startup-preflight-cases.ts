import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { kubernetesGatewayNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { continuityNamespace } from "../helpers/production-upgrade-continuity-fixture.ts";
import { assertStoppedBeforeWriters } from "../helpers/production-upgrade-recovery-evidence.ts";
import type {
  RecoveryFixture,
  RecoveryFixtureFactory,
} from "../helpers/production-upgrade-recovery-fixture.ts";
import { yamlFile } from "../helpers/production-upgrade-recovery-render.ts";
import {
  field,
  list,
  requireRecoveryPreflight,
} from "../helpers/production-upgrade-recovery-state.ts";
import { controller, newController } from "../helpers/production-upgrade-recovery-tools.ts";
import { registerPreflightCleanupTests } from "../helpers/production-upgrade-preflight-cleanup.ts";
import { createCredentialProxyInstallationConfiguration } from "../helpers/installation-driver-configuration.mjs";
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
  test(
    "the image-upgrade startup preflight validates the API's mounted theme before stopping writers",
    { concurrency: true },
    async (t) => {
      if (!realHelm) {
        t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
      if (!realHelm) {
        t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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

  test("startup preflight retains the failed API CA assembler's guidance", async (t) => {
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
      args: ["scripts/migrate-production.mjs", "--check"],
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
      if (!realHelm) {
        t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
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
