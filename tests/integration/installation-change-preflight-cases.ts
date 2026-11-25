import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import Type from "typebox";
import { Check } from "typebox/value";

import type {
  KubernetesComputeDriverOptions,
  KubernetesGatewayRoutingOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { selectedImageMigrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.ts";
import {
  parseProductionChart,
  renderProductionChart,
  type ChartValues,
} from "../helpers/production-chart.ts";

type CheckResult = { status: number | null; stdout: string; stderr: string };
type CheckEnvironment = (directory: string) => Record<string, string>;
type RunCheck = (
  t: TestContext,
  configuration: object,
  files?: Record<string, string>,
  environment?: CheckEnvironment,
) => Promise<CheckResult>;
type RunHook = (
  t: TestContext,
  configuration: object,
  options: { refusal: { phase: string; expected: (directory: string) => string } },
) => Promise<CheckResult>;

const namedEnvironment = Type.Array(
  Type.Object({ name: Type.String(), value: Type.Optional(Type.String()) }),
);
const namedContainer = Type.Object({
  name: Type.String(),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(namedEnvironment),
});
const initializationJob = Type.Object({
  kind: Type.Literal("Job"),
  metadata: Type.Object({ labels: Type.Record(Type.String(), Type.String()) }),
  spec: Type.Object({
    template: Type.Object({ spec: Type.Object({ initContainers: Type.Array(namedContainer) }) }),
  }),
});
const apiDeployment = Type.Object({
  kind: Type.Literal("Deployment"),
  metadata: Type.Object({ name: Type.Literal("openclaw-enterprise-api") }),
  spec: Type.Object({
    template: Type.Object({ spec: Type.Record(Type.String(), Type.Unknown()) }),
  }),
});
const checkContainer = Type.Object({
  name: Type.Literal("installation-check"),
  args: Type.Array(Type.String()),
  env: Type.Array(Type.Object({ name: Type.String(), value: Type.String() })),
});
const migrationContainer = Type.Object({
  name: Type.Literal("migration"),
  args: Type.Array(Type.String()),
});
const gatewayResource = Type.Object({
  kind: Type.Literal("Gateway"),
  spec: Type.Object({
    listeners: Type.Array(
      Type.Object({ name: Type.String(), hostname: Type.Optional(Type.String()) }),
    ),
  }),
});

function findInitializationJob(objects: readonly unknown[]) {
  const job = objects.find((object) => {
    const resource = asRecord(object);
    return (
      resource?.kind === "Job" &&
      asRecord(asRecord(resource.metadata)?.labels)?.["app.kubernetes.io/component"] ===
        "initialization"
    );
  });
  assert.ok(
    Check(initializationJob, job),
    "Expected the chart's initialization Job and init containers",
  );
  return job;
}

function findCheck(job: ReturnType<typeof findInitializationJob>) {
  const [check] = job.spec.template.spec.initContainers;
  assert.ok(
    Check(checkContainer, check),
    "Expected the first initialization container to run the installation check",
  );
  return check;
}

export async function renderPreflightChart(values: ChartValues, isUpgrade: boolean) {
  const objects = await parseProductionChart(
    (await renderProductionChart(values, { isUpgrade })).stdout,
  );
  const job = findInitializationJob(objects);
  const api = objects.find((object) => {
    const resource = asRecord(object);
    return (
      resource?.kind === "Deployment" &&
      asRecord(resource.metadata)?.name === "openclaw-enterprise-api"
    );
  });
  assert.ok(Check(apiDeployment, api), "Expected the chart's API Deployment and Pod spec");
  return { job, hook: job.spec.template.spec, api: api.spec.template.spec };
}

export async function separateDatabaseUpgradeCase() {
  const values = { "database.upgradeMigration": "separate" };
  for (const isUpgrade of [false, true]) {
    const { hook } = await renderPreflightChart(values, isUpgrade);
    const migration = hook.initContainers.find(({ name }) => name === "migration");
    assert.ok(
      Check(migrationContainer, migration),
      "Expected the migration init container and arguments",
    );
    assert.deepEqual(migration.args, [
      ...selectedImageMigrationEntry,
      isUpgrade ? "--require-current" : "--expect-empty",
    ]);
  }
  await assert.rejects(
    renderPreflightChart({ "database.upgradeMigration": "seperate" }, true),
    /must be hook or separate/,
  );
}

export async function malformedComputeCase(
  t: TestContext,
  runCheck: RunCheck,
  checkScript: string,
  makeInstallation: typeof installation,
) {
  const { job } = await renderPreflightChart({}, false);
  const check = findCheck(job);
  assert.equal(check.name, "installation-check");
  assert.deepEqual(check.args, ["--input-type=module", "-e", checkScript]);
  const environment = () =>
    Object.fromEntries(
      check.env
        .filter(({ name }) => name !== "OCC_CONFIG_PATH")
        .map(({ name, value }) => [name, value]),
    );
  const configuration = makeInstallation();
  const accepted = await runCheck(t, configuration, {}, environment);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, "installation-startup-ready\n");
  configuration.drivers.compute.configuration.network.gatewayTrustedProxyCidrs = [];
  const refused = await runCheck(t, configuration, {}, environment);
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /DRIVER_CONFIGURATION_INVALID.*\/network\/gatewayTrustedProxyCidrs.*INVALID_FORMAT/,
  );
  assert.equal(refused.stdout, "");
}

export async function acceptedStartupCase(t: TestContext, runCheck: RunCheck) {
  const configuration = {
    ...installation(),
    presets: { includeDefaults: true, files: ["presets/team.json"] },
  };
  const result = await runCheck(
    t,
    configuration,
    {
      "presets/team.json": JSON.stringify({ name: "Team Codex", template: {} }),
      "unavailable-transport.mjs": `
        import { registerHooks } from "node:module";
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier === "@grpc/grpc-js") {
              throw new Error("OpenShell transport is unavailable");
            }
            return nextResolve(specifier, context);
          },
        });
      `,
    },
    (directory) => ({
      OCC_CONSOLE_THEME_DIR: resolve("deploy/examples/console-theme"),
      NODE_OPTIONS: `--import=${pathToFileURL(join(directory, "unavailable-transport.mjs")).href}`,
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "installation-startup-ready\n");
  assert.equal(result.stderr, "");
}

type MutableRouting = {
  gatewayName: KubernetesGatewayRoutingOptions["gatewayName"];
  gatewayNamespace: KubernetesGatewayRoutingOptions["gatewayNamespace"];
  envoyNamespace: KubernetesGatewayRoutingOptions["envoyNamespace"];
  hostname?: KubernetesGatewayRoutingOptions["hostname"];
};
type Mismatch =
  | ["gatewayName" | "gatewayNamespace" | "envoyNamespace", string]
  | ["hostname", string | undefined];

export async function gatewayRoutingCase(
  t: TestContext,
  runCheck: RunCheck,
  gatewayValues: ChartValues,
) {
  for (const variant of ["default", "custom-automatic", "custom-hostname"]) {
    const custom = variant !== "default";
    const hostname = variant === "custom-hostname" ? "agents.internal.example" : undefined;
    const namespace = custom ? "team-control" : "openclaw-system";
    const gatewayName = custom ? "private-agents" : "oce-agent-gateways";
    const envoyNamespace = custom ? "private-proxy" : "envoy-gateway-system";
    const objects = await parseProductionChart(
      (
        await renderProductionChart(
          {
            ...gatewayValues,
            ...(custom
              ? {
                  "gatewayRouting.gatewayName": gatewayName,
                  "gatewayRouting.envoyNamespace": envoyNamespace,
                }
              : {}),
            ...(hostname === undefined ? {} : { "gatewayRouting.hostname": hostname }),
          },
          { isUpgrade: true, namespace },
        )
      ).stdout,
    );
    const gateway = objects.find((object) => asRecord(object)?.kind === "Gateway");
    assert.ok(Check(gatewayResource, gateway), "Expected the chart's Gateway listeners");
    const check = findCheck(findInitializationJob(objects));
    const environment = Object.fromEntries(
      check.env
        .filter(({ name }) => name === "OCC_CHART_GATEWAY_ROUTING")
        .map(({ name, value }) => [name, value]),
    );
    const base = installation();
    const network: Omit<typeof base.drivers.compute.configuration.network, "gatewayClients"> & {
      gatewayClients?: typeof base.drivers.compute.configuration.network.gatewayClients;
    } = { ...base.drivers.compute.configuration.network };
    delete network.gatewayClients;
    const routing: MutableRouting = {
      gatewayName,
      gatewayNamespace: namespace,
      envoyNamespace,
      ...(hostname === undefined ? {} : { hostname }),
    };
    const compute = { ...base.drivers.compute.configuration, network, gatewayRouting: routing };
    const configuration = {
      ...base,
      drivers: { ...base.drivers, compute: { ...base.drivers.compute, configuration: compute } },
    };

    // Both automatic Service DNS and custom routing must pass the actual chart hook.
    // An explicit spelling of the automatic hostname is equivalent to omitting it.
    const https = gateway.spec.listeners.find(({ name }) => name === "https");
    assert.ok(https, "Expected the chart's HTTPS Gateway listener");
    const hostnames = hostname === undefined ? [undefined, "", https.hostname] : [hostname];
    for (const selectedHostname of hostnames) {
      if (selectedHostname === undefined) {
        delete compute.gatewayRouting.hostname;
      } else {
        compute.gatewayRouting.hostname = selectedHostname;
      }
      const accepted = await runCheck(t, configuration, {}, () => environment);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout, "installation-startup-ready\n");
    }

    // Each mismatch previously passed startup, then sent Agent routes or clients to a
    // different Gateway. Refuse it before the upgrade replaces the serving API Pod.
    const mismatches: Mismatch[] = [
      ["gatewayName", "other-gateway"],
      ["gatewayNamespace", "other-namespace"],
      ["envoyNamespace", "other-namespace"],
      ["hostname", "other.example"],
      ...(hostname === undefined ? [] : [["hostname", undefined] satisfies Mismatch]),
    ];
    for (const [field, value] of mismatches) {
      const different = structuredClone(configuration);
      if (field === "hostname") {
        different.drivers.compute.configuration.gatewayRouting.hostname = value;
      } else {
        different.drivers.compute.configuration.gatewayRouting[field] = value;
      }
      const refused = await runCheck(t, different, {}, () => environment);
      assert.equal(refused.status, 1, `${field}: ${refused.stderr}`);
      assert.equal(refused.stdout, "");
      assert.match(refused.stderr, /\(CHART_LISTENER_MISMATCH\)/);
      assert.ok(refused.stderr.includes(`drivers.compute.configuration.gatewayRouting.${field}`));
      assert.doesNotMatch(refused.stderr, /other\.example|other-namespace|other-gateway/);
    }
  }
}

export async function refusalDetailsCase(t: TestContext, runHook: RunHook) {
  const prefix = "installation-check: API and worker startup would refuse the Installation";
  // D407: presets.files names a file the image lacks.
  const missing = { ...installation(), presets: { files: ["presets/missing.json"] } };
  const absent = await runHook(t, missing, {
    refusal: {
      phase: "missing-preset",
      expected: (directory) =>
        `${prefix} (PRESET_FILE_INVALID): presets.files: Preset file ${join(directory, "presets/missing.json")} is unavailable.\n`,
    },
  });
  assert.equal(absent.stdout, "");

  // A loader message that already names the key is not prefixed twice.
  const blank = { ...installation(), presets: { files: ["  "] } };
  await runHook(t, blank, {
    refusal: {
      phase: "blank-preset",
      expected: () =>
        `${prefix} (PRESET_FILE_INVALID): presets.files entries must be nonempty file paths.\n`,
    },
  });

  // Other startup refusals keep the loader's message, which names the setting.
  const observability = { ...installation(), observability: { url: "ftp://metrics.example.test" } };
  await runHook(t, observability, {
    refusal: {
      phase: "invalid-observability",
      expected: () =>
        `${prefix}: observability.url must be an absolute HTTP or HTTPS URL without credentials or a fragment.\n`,
    },
  });
}

export async function refusedThemeCase(t: TestContext, runCheck: RunCheck) {
  // A valid Installation with a bad bundle: the API's own loader fails the hook, so the
  // upgrade stops before the API rolls instead of at API startup.
  const themed = await runCheck(
    t,
    installation(),
    { "theme/theme.json": JSON.stringify({ schemaVersion: 1, colors: { accent: "blue" } }) },
    (directory) => ({ OCC_CONSOLE_THEME_DIR: join(directory, "theme") }),
  );
  assert.equal(themed.status, 1);
  assert.equal(themed.stdout, "");
  assert.equal(
    themed.stderr,
    "installation-check: API startup would refuse (CONSOLE_THEME_INVALID): Console theme: colors must use supported roles and six- or eight-digit hex colors.\n",
  );
}

export async function leftoverBrokerPeerCase(t: TestContext, runCheck: RunCheck) {
  // Finding 2212: an Installation that left native repository delivery but kept the Compute
  // broker peer made every stop, retire and delete list Secrets the chart no longer lets the
  // worker list. The hook refuses it before migration, so the old Pods keep serving.
  const leftover = installation();
  const network: typeof leftover.drivers.compute.configuration.network & {
    repositoryCredentials?: NonNullable<
      KubernetesComputeDriverOptions["network"]["repositoryCredentials"]
    >;
  } = leftover.drivers.compute.configuration.network;
  network.repositoryCredentials = {
    namespace: "openclaw-system",
    podLabels: {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/component": "worker",
    },
    port: 8443,
  };
  const refused = await runCheck(t, leftover);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.equal(
    refused.stderr,
    // The same code and field detail as the API and worker startup logs (finding 2226).
    'installation-check: API and worker startup would refuse the Installation: DRIVER_CONFIGURATION_INVALID: [{"path":"/drivers/compute/configuration/network/repositoryCredentials","code":"INVALID_VALUE","message":"drivers.compute.configuration.network.repositoryCredentials requires repository.nativeSender; remove it for protected Git or when no repository is configured."}]\n',
  );
  // The documented recovery deletes only the peer; the rest of the Installation is unchanged.
  delete network.repositoryCredentials;
  const recovered = await runCheck(t, leftover);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, "installation-startup-ready\n");
}
