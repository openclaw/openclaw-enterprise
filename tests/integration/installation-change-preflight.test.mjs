import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { captureChild } from "../helpers/child-processes.mjs";
import {
  createCredentialProxyInstallationConfiguration as credentialProxyInstallation,
  createInstallationDriverConfiguration as installation,
} from "../helpers/installation-driver-configuration.mjs";
import {
  chartTooling,
  parseProductionChart,
  renderProductionChart,
} from "../helpers/production-chart.mjs";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";
import {
  chartListeners,
  requireChartListener,
} from "../../apps/controller/src/composition/installation-fields.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

// An Installation change restarts the API with the Recreate strategy, so an Installation
// it refuses kept the API down until the operator restored it (D407: 324 s of 503). The
// pre-upgrade initialization hook now loads the Installation first and fails the upgrade
// while the old Pods keep serving.
const checkScript = await readFile(
  new URL("../../deploy/helm/openclaw-enterprise/files/check-installation.mjs", import.meta.url),
  "utf8",
);
const tooling = await chartTooling();
const repositoryCredentialValues = {
  "repositoryCredentials.enabled": "true",
  "repositoryCredentials.authority": "prepared-git",
  "repositoryCredentials.preparedCustodySecretName": "repository-custody",
  "repositoryCredentials.image": `registry.example.invalid/repository-credentials@sha256:${"b".repeat(64)}`,
  "repositoryCredentials.backendId": "github-primary",
  "repositoryCredentials.registryConfigMapName": "repository-registry-v1",
  "repositoryCredentials.serviceConfigSecretName": "repository-config",
  "repositoryCredentials.appKeySecretName": "repository-app-key",
  "repositoryCredentials.tlsSecretName": "repository-tls",
  "repositoryCredentials.publicCaSecretName": "repository-public-ca",
  "repositoryCredentials.upstreamCidrs[0]": "198.51.100.0/24",
  "repositoryCredentials.serviceName": "git",
};
const themeValues = { "api.consoleTheme.configMapName": "console-theme-v2" };
// Prepared GitHub custody for the Credential Proxy authority, without and with a private issuer CA.
const preparedGitHubValues = {
  "egressAuthority.enabled": "true",
  "egressAuthority.tlsSecretName": "authority-server-tls",
  "egressAuthority.issuerSecretName": "gateway-jwt-keys",
  "egressAuthority.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
    "openshell-system",
  "egressAuthority.clients[0].podSelector.matchLabels.app": "openshell-gateway",
  "preparedGitHub.custodySecretName": "prepared-github-custody",
  "preparedGitHub.issuerCidrs[0]": "192.0.2.3/32",
};
const issuerCaValues = {
  ...preparedGitHubValues,
  "preparedGitHub.issuerCaConfigMapName": "prepared-github-issuer-ca",
};

async function render(values, isUpgrade) {
  const objects = await parseProductionChart(
    (await renderProductionChart(values, { isUpgrade })).stdout,
  );
  const job = objects.find(
    ({ kind, metadata }) =>
      kind === "Job" && metadata.labels["app.kubernetes.io/component"] === "initialization",
  );
  const api = objects.find(
    ({ kind, metadata }) => kind === "Deployment" && metadata.name === "openclaw-enterprise-api",
  );
  return { job, hook: job.spec.template.spec, api: api.spec.template.spec };
}

test(
  "the upgrade hook loads the Installation with the API's files before migration",
  tooling,
  async () => {
    // A fresh install has no running API to protect and may create the Secret alongside.
    const install = await render({}, false);
    assert.deepEqual(
      install.hook.initContainers.map(({ name }) => name),
      ["migration"],
    );
    assert.ok(!install.hook.volumes.some(({ name }) => name === "installation-startup"));

    for (const values of [
      {},
      repositoryCredentialValues,
      themeValues,
      { ...repositoryCredentialValues, ...themeValues },
      preparedGitHubValues,
      issuerCaValues,
    ]) {
      const { job, hook, api } = await render(values, true);
      // Pre-upgrade hooks finish before Helm updates the Deployments.
      assert.match(job.metadata.annotations["helm.sh/hook"], /(^|,)pre-upgrade(,|$)/);
      assert.equal(job.spec.backoffLimit, 0);
      assert.deepEqual(
        hook.initContainers.map(({ name }) => name),
        ["installation-check", "migration"],
      );
      const [check, migration] = hook.initContainers;
      const server = api.containers.find(({ name }) => name === "api");
      assert.deepEqual(migration.args, ["scripts/migrate-production.mjs"]);
      assert.equal(check.image, server.image);
      assert.deepEqual(check.command, ["node"]);
      assert.deepEqual(check.args, ["--input-type=module", "-e", checkScript]);
      // Kubernetes expands $(VAR) and turns $$ into $ in args; the script must not contain either.
      assert.doesNotMatch(checkScript, /\$\(|\$\$/);
      assert.deepEqual(check.securityContext, migration.securityContext);
      assert.deepEqual(check.resources, migration.resources);
      const environment = (container, name) =>
        container.env.find((variable) => variable.name === name);
      // A theme bundle the API would refuse fails the hook rather than the API rollout.
      const theme = "api.consoleTheme.configMapName" in values;
      assert.deepEqual(check.env, [
        environment(server, "NODE_ENV"),
        environment(server, "OCC_CONFIG_PATH"),
        environment(server, "OCC_EGRESS_AUTHORITY_PORT"),
        environment(server, "OCC_OPENSHELL_GIT_PORT"),
        ...(theme ? [environment(server, "OCC_CONSOLE_THEME_DIR")] : []),
      ]);
      // The check compares the Installation's listeners with the ports the chart routes.
      assert.equal(
        environment(check, "OCC_EGRESS_AUTHORITY_PORT").value,
        "egressAuthority.enabled" in values ? "9444" : "disabled",
      );
      assert.equal(environment(check, "OCC_OPENSHELL_GIT_PORT").value, "disabled");
      // Each file the check reads comes from the API's own volume at the API's path.
      const expected = ["installation-startup"];
      if (theme) {
        expected.push("console-theme");
      }
      if ("repositoryCredentials.enabled" in values) {
        expected.push("repository-registry", "repository-public-ca");
      }
      // Loading the Installation reads preparedGitHub.issuerCaPath (finding 2205). The worker
      // reads the custody key only after it opens the database, so the hook never mounts it.
      if ("preparedGitHub.issuerCaConfigMapName" in values) {
        expected.push("prepared-github-issuer-ca");
      }
      assert.deepEqual(
        check.volumeMounts.map(({ name }) => name),
        expected,
      );
      for (const mount of check.volumeMounts) {
        assert.deepEqual(
          mount,
          server.volumeMounts.find(({ name }) => name === mount.name),
        );
        assert.deepEqual(
          hook.volumes.find(({ name }) => name === mount.name),
          api.volumes.find(({ name }) => name === mount.name),
        );
      }
      assert.ok(!hook.volumes.some(({ name }) => name === "prepared-github-custody"));
      assert.equal(hook.automountServiceAccountToken, false);
    }
  },
);

async function runCheck(t, configuration, files = {}, environment = () => ({})) {
  const directory = await temporaryDirectory(t, "occ-installation-check-");
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration), "utf8");
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(directory, name, ".."), { recursive: true });
    await writeFile(join(directory, name), contents, "utf8");
  }
  // The chart's environment only (plus the lane's compile cache): the image's working
  // directory holds apps/.
  const result = await captureChild(process.execPath, ["--input-type=module", "-e", checkScript], {
    cwd: process.cwd(),
    env: {
      ...compileCacheEnvironment,
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: path,
      ...environment(directory),
    },
    timeout: 30_000,
  });
  assert.equal(result.signal ?? null, null, result.stderr);
  return { ...result, directory };
}

test("the upgrade hook check passes an Installation API startup accepts", async (t) => {
  const configuration = installation();
  configuration.presets = { includeDefaults: true, files: ["presets/team.json"] };
  const result = await runCheck(
    t,
    configuration,
    { "presets/team.json": JSON.stringify({ name: "Team Codex", template: {} }) },
    // The documented example bundle, as the chart mounts it for the API.
    () => ({ OCC_CONSOLE_THEME_DIR: resolve("deploy/examples/console-theme") }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "installation-startup-ready\n");
  assert.equal(result.stderr, "");
});

test("the upgrade hook check names the key and file of a refused Installation", async (t) => {
  const prefix = "installation-check: API and worker startup would refuse the Installation";
  // D407: presets.files names a file the image lacks.
  const missing = installation();
  missing.presets = { files: ["presets/missing.json"] };
  const absent = await runCheck(t, missing);
  assert.equal(absent.status, 1);
  assert.equal(absent.stdout, "");
  assert.equal(
    absent.stderr,
    `${prefix} (PRESET_FILE_INVALID): presets.files: Preset file ${join(absent.directory, "presets/missing.json")} is unavailable.\n`,
  );

  // A loader message that already names the key is not prefixed twice.
  const blank = installation();
  blank.presets = { files: ["  "] };
  const empty = await runCheck(t, blank);
  assert.equal(empty.status, 1);
  assert.equal(
    empty.stderr,
    `${prefix} (PRESET_FILE_INVALID): presets.files entries must be nonempty file paths.\n`,
  );

  // Other startup refusals keep the loader's message, which names the setting.
  const observability = installation();
  observability.observability = { url: "ftp://metrics.example.test" };
  const refused = await runCheck(t, observability);
  assert.equal(refused.status, 1);
  assert.equal(
    refused.stderr,
    `${prefix}: observability.url must be an absolute HTTP or HTTPS URL without credentials or a fragment.\n`,
  );
});

test(
  "the upgrade hook check refuses a Credential Proxy listener the chart Service cannot reach",
  tooling,
  async (t) => {
    // The chart routes egressAuthority.port to the API Pod's address. An Installation authority on
    // another port, on loopback, or without the chart listener passed install and readiness, then
    // refused every protected request at first use (finding 2213). `::` binds all addresses too.
    const prefix =
      "installation-check: API and worker startup would refuse the Installation (CHART_LISTENER_MISMATCH)";
    const chartEnvironment = async (values) => {
      const [check] = (await render(values, true)).hook.initContainers;
      return Object.fromEntries(
        check.env
          .filter(
            ({ name }) => name === "OCC_EGRESS_AUTHORITY_PORT" || name === "OCC_OPENSHELL_GIT_PORT",
          )
          .map(({ name, value }) => [name, value]),
      );
    };
    const enabled = await chartEnvironment(preparedGitHubValues);
    const reachable = credentialProxyInstallation();
    reachable.drivers.credential_proxy.configuration.authority.host = "0.0.0.0";
    for (const host of ["0.0.0.0", "::"]) {
      reachable.drivers.credential_proxy.configuration.authority.host = host;
      const accepted = await runCheck(t, reachable, {}, () => enabled);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout, "installation-startup-ready\n");
    }

    const loopback = structuredClone(reachable);
    loopback.drivers.credential_proxy.configuration.authority.host = "127.0.0.1";
    for (const [configuration, environment, message] of [
      [
        reachable,
        await chartEnvironment({ ...preparedGitHubValues, "egressAuthority.port": "9555" }),
        "drivers.credential_proxy.configuration.authority.port is 9444, but Helm egressAuthority.port is 9555.",
      ],
      [
        reachable,
        await chartEnvironment({}),
        "drivers.credential_proxy.configuration.authority.port is 9444, but Helm egressAuthority.enabled is false, so no chart Service reaches it.",
      ],
      [
        loopback,
        enabled,
        "drivers.credential_proxy.configuration.authority.host is 127.0.0.1, but the chart's egressAuthority Service on port 9444 reaches only a listener on all addresses: use 0.0.0.0 or ::.",
      ],
    ]) {
      const refused = await runCheck(t, configuration, {}, () => environment);
      assert.equal(refused.status, 1);
      assert.equal(refused.stdout, "");
      assert.equal(refused.stderr, `${prefix}: ${message}\n`);
    }
  },
);

test(
  "the upgrade hook check refuses authority files where the chart mounts none",
  tooling,
  async (t) => {
    // The listener reads its TLS and issuer files only when it starts, which a Recreate
    // upgrade does after stopping the old Pod: a wrong path was an outage, not a refusal.
    const pod = async (values, name) =>
      (await parseProductionChart((await renderProductionChart(values)).stdout)).find(
        ({ kind, metadata }) => kind === "Deployment" && metadata.name === name,
      ).spec.template.spec;
    const mounted = (spec, container) =>
      spec.containers
        .find(({ name }) => name === container)
        .volumeMounts.flatMap(({ name, mountPath }) => {
          const volume = spec.volumes.find((candidate) => candidate.name === name);
          const items = [
            ...(volume.secret?.items ?? []),
            ...(volume.projected?.sources ?? []).flatMap(
              (source) => (source.secret ?? source.configMap)?.items ?? [],
            ),
          ];
          return items.map(({ path }) => `${mountPath}/${path}`);
        });
    // The paths startup compares are the ones the chart renders, for both listeners.
    const api = await pod(preparedGitHubValues, "openclaw-enterprise-api");
    const worker = await pod(
      {
        ...repositoryCredentialValues,
        "repositoryCredentials.enabled": "false",
        "openshellGit.enabled": "true",
        "openshellGit.tlsSecretName": "openshell-git-tls",
        "openshellGit.issuerPublicKeyConfigMapName": "openshell-gateway-public",
        "openshellGit.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
          "openshell-system",
        "openshellGit.clients[0].podSelector.matchLabels.app": "openshell-supervisor",
      },
      "openclaw-enterprise-worker",
    );
    for (const [listener, files] of [
      [chartListeners.egressAuthority, mounted(api, "api")],
      [chartListeners.openshellGit, mounted(worker, "worker")],
    ]) {
      for (const [path] of Object.values(listener.files)) {
        assert.ok(files.includes(path), `${listener.chart}: ${path} in ${files.join(", ")}`);
      }
    }

    const prefix =
      "installation-check: API and worker startup would refuse the Installation (CHART_LISTENER_MISMATCH)";
    const [check] = (await render(preparedGitHubValues, true)).hook.initContainers;
    const environment = Object.fromEntries(
      check.env
        .filter(
          ({ name }) => name === "OCC_EGRESS_AUTHORITY_PORT" || name === "OCC_OPENSHELL_GIT_PORT",
        )
        .map(({ name, value }) => [name, value]),
    );
    const authority = "drivers.credential_proxy.configuration.authority";
    for (const [field, configured, message] of [
      [
        "certificatePath",
        "/etc/openclaw/egress/tls/server.crt",
        `${authority}.certificatePath must be /etc/openclaw/egress/tls/tls.crt, where the chart mounts the file from Helm egressAuthority.tlsSecretName.`,
      ],
      [
        "privateKeyPath",
        "/etc/openclaw/openshell/tls.key",
        `${authority}.privateKeyPath must be /etc/openclaw/egress/tls/tls.key, where the chart mounts the file from Helm egressAuthority.tlsSecretName.`,
      ],
      [
        "issuerPublicKeyPath",
        "/etc/openclaw/egress/issuer/public.pem",
        `${authority}.issuerPublicKeyPath must be /etc/openclaw/egress/issuer/issuer.pub, where the chart mounts the file from Helm egressAuthority.issuerSecretName.`,
      ],
    ]) {
      const configuration = credentialProxyInstallation();
      configuration.drivers.credential_proxy.configuration.authority.host = "0.0.0.0";
      configuration.drivers.credential_proxy.configuration.authority[field] = configured;
      const refused = await runCheck(t, configuration, {}, () => environment);
      assert.equal(refused.status, 1, field);
      assert.equal(refused.stdout, "");
      // Only the chart's path is named; the configured path is the operator's layout.
      assert.equal(refused.stderr, `${prefix}: ${message}\n`);
    }

    // The repository transport compares its own block with the openshellGit mounts.
    const transport = {
      ...credentialProxyInstallation().drivers.credential_proxy.configuration.authority,
      host: "0.0.0.0",
      port: 8445,
      ...Object.fromEntries(
        Object.entries(chartListeners.openshellGit.files).map(([key, [path]]) => [key, path]),
      ),
    };
    const declared = { OCC_OPENSHELL_GIT_PORT: "8445" };
    requireChartListener(transport, declared, chartListeners.openshellGit);
    assert.throws(
      () =>
        requireChartListener(
          { ...transport, issuerPublicKeyPath: "/etc/openclaw/openshell-git/issuer.pub" },
          declared,
          chartListeners.openshellGit,
        ),
      {
        name: "ChartListenerMismatchError",
        path: "/repository/openShell/authority/issuerPublicKeyPath",
        message:
          "repository.openShell.authority.issuerPublicKeyPath must be /etc/openclaw/openshell-git/gateway-public.pem, where the chart mounts the file from Helm openshellGit.issuerPublicKeyConfigMapName.",
      },
    );
  },
);

test("the upgrade hook check refuses a Console theme the API would refuse", async (t) => {
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
});

test("the upgrade hook check refuses a repository broker peer until the operator removes it", async (t) => {
  // Finding 2212: an Installation that left native repository delivery but kept the Compute
  // broker peer made every stop, retire and delete list Secrets the chart no longer lets the
  // worker list. The hook refuses it before migration, so the old Pods keep serving.
  const leftover = installation();
  leftover.drivers.compute.configuration.network.repositoryCredentials = {
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
    "installation-check: API and worker startup would refuse the Installation: drivers.compute.configuration.network.repositoryCredentials requires repository.nativeSender; remove it for protected Git or when no repository is configured.\n",
  );
  // The documented recovery deletes only the peer; the rest of the Installation is unchanged.
  delete leftover.drivers.compute.configuration.network.repositoryCredentials;
  const recovered = await runCheck(t, leftover);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, "installation-startup-ready\n");
});
