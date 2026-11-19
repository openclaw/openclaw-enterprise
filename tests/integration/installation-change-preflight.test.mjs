import { selectedImageMigrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { captureChild } from "../helpers/child-processes.mjs";
import {
  createCredentialProxyInstallationConfiguration as credentialProxyInstallation,
  createInstallationDriverConfiguration as installation,
} from "../helpers/installation-driver-configuration.ts";
import {
  chartTooling,
  parseProductionChart,
  renderProductionChart,
} from "../helpers/production-chart.ts";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";
import {
  chartListeners,
  requireChartListener,
} from "../../apps/controller/src/composition/installation-fields.ts";
import { openShellGitChartListener } from "../../apps/controller/src/drivers/egress-proxy/openshell-configuration.ts";
import { generateInstallationCheck } from "../../deploy/helm/src/generate-installation-check.ts";
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
const gatewayValues = {
  "gatewayRouting.enabled": "true",
  "gatewayRouting.gatewayClassName": "eg",
  "gatewayRouting.apiKeySecretName": "private-gateway-key",
};
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
const tokenGrantValues = {
  ...preparedGitHubValues,
  "egressAuthority.tokenGrant.enabled": "true",
  "egressAuthority.tokenGrant.bundleConfigMapName": "supervisor-jwt-bundle",
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
  "install and upgrade hooks load the Installation with the API's files before migration",
  tooling,
  async () => {
    assert.equal(
      await generateInstallationCheck(),
      checkScript,
      "Regenerate the Installation check with node deploy/helm/src/generate-installation-check.ts",
    );
    for (const values of [
      {},
      repositoryCredentialValues,
      themeValues,
      gatewayValues,
      { ...repositoryCredentialValues, ...themeValues },
      preparedGitHubValues,
      issuerCaValues,
      tokenGrantValues,
    ]) {
      const { job, hook, api } = await render(values, true);
      const install = await render(values, false);
      assert.deepEqual(install.hook.initContainers[0], hook.initContainers[0]);
      assert.deepEqual(
        install.hook.volumes.filter(({ name }) => name !== "bootstrap-credentials"),
        hook.volumes,
      );
      assert.ok(!hook.volumes.some(({ name }) => name === "bootstrap-credentials"));
      assert.deepEqual(
        install.hook.volumes.find(({ name }) => name === "bootstrap-credentials").secret.items,
        [
          { key: "admin-password", path: "admin-password" },
          { key: "admin-service-key", path: "admin-service-key" },
        ],
      );
      assert.deepEqual(
        install.hook.initContainers.map(({ name }) => name),
        ["installation-check", "migration"],
      );
      assert.deepEqual(install.hook.initContainers[1].args, [
        ...selectedImageMigrationEntry,
        "--expect-empty",
      ]);
      const installedBootstrap = install.hook.containers.find(({ name }) => name === "bootstrap");
      const upgradedBootstrap = hook.containers.find(({ name }) => name === "bootstrap");
      assert.deepEqual(
        installedBootstrap.volumeMounts.find(({ name }) => name === "bootstrap-credentials"),
        {
          name: "bootstrap-credentials",
          mountPath: "/run/openclaw-bootstrap",
          readOnly: true,
        },
      );
      assert.ok(
        !(upgradedBootstrap.volumeMounts ?? []).some(
          ({ name }) => name === "bootstrap-credentials",
        ),
      );
      assert.deepEqual(
        installedBootstrap.env.filter(({ name }) => name.endsWith("_INPUT_FILE")),
        [
          {
            name: "OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE",
            value: "/run/openclaw-bootstrap/admin-password",
          },
          {
            name: "OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE",
            value: "/run/openclaw-bootstrap/admin-service-key",
          },
        ],
      );
      assert.ok(!upgradedBootstrap.env.some(({ name }) => name.endsWith("_INPUT_FILE")));
      assert.deepEqual(installedBootstrap.args, [
        "scripts/bootstrap-installation.mjs",
        "--require-fresh",
      ]);
      assert.deepEqual(upgradedBootstrap.args, ["scripts/bootstrap-installation.mjs"]);
      assert.deepEqual(
        {
          ...installedBootstrap,
          args: upgradedBootstrap.args,
          env: installedBootstrap.env.filter(({ name }) => !name.endsWith("_INPUT_FILE")),
          volumeMounts: installedBootstrap.volumeMounts.filter(
            ({ name }) => name !== "bootstrap-credentials",
          ),
        },
        { ...upgradedBootstrap, volumeMounts: upgradedBootstrap.volumeMounts ?? [] },
      );
      // Pre-upgrade hooks finish before Helm updates the Deployments.
      assert.match(job.metadata.annotations["helm.sh/hook"], /(^|,)pre-upgrade(,|$)/);
      assert.equal(job.spec.backoffLimit, 0);
      assert.deepEqual(
        hook.initContainers.map(({ name }) => name),
        ["installation-check", "migration"],
      );
      const [check, migration] = hook.initContainers;
      const server = api.containers.find(({ name }) => name === "api");
      assert.deepEqual(migration.args, selectedImageMigrationEntry);
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
        environment(server, "OCC_TOKEN_GRANT_PORT"),
        ...("gatewayRouting.enabled" in values
          ? [environment(server, "OCC_CHART_GATEWAY_ROUTING")]
          : []),
        ...(theme ? [environment(server, "OCC_CONSOLE_THEME_DIR")] : []),
      ]);
      // The check compares the Installation's listeners with the ports the chart routes.
      assert.equal(
        environment(check, "OCC_EGRESS_AUTHORITY_PORT").value,
        "egressAuthority.enabled" in values ? "9444" : "disabled",
      );
      assert.equal(environment(check, "OCC_OPENSHELL_GIT_PORT").value, "disabled");
      assert.equal(
        environment(check, "OCC_TOKEN_GRANT_PORT").value,
        "egressAuthority.tokenGrant.enabled" in values ? "9445" : "disabled",
      );
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
      if ("egressAuthority.tokenGrant.enabled" in values) {
        expected.push("token-grant-bundle");
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

test(
  "a separate database deployment requires current history only on upgrade",
  tooling,
  async () => {
    const values = { "database.upgradeMigration": "separate" };
    for (const isUpgrade of [false, true]) {
      const { hook } = await render(values, isUpgrade);
      const migration = hook.initContainers.find(({ name }) => name === "migration");
      assert.deepEqual(migration.args, [
        ...selectedImageMigrationEntry,
        isUpgrade ? "--require-current" : "--expect-empty",
      ]);
    }
    await assert.rejects(
      render({ "database.upgradeMigration": "seperate" }, true),
      /must be hook or separate/,
    );
  },
);

function runCheck(t, configuration, files, environment) {
  return runHook(t, configuration, { files, environment });
}

async function runHook(t, configuration, { files = {}, environment, refusal }) {
  const directory = await temporaryDirectory(t, "occ-installation-check-");
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration), "utf8");
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(directory, name, ".."), { recursive: true });
    await writeFile(join(directory, name), contents, "utf8");
  }
  // The chart's environment only (plus the lane's compile cache): the image's working
  // directory holds apps/.
  const env = {
    ...compileCacheEnvironment,
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    ...environment?.(directory),
  };
  const expectedStderr = refusal?.expected(directory);
  const timeout = 30_000;
  const result = await captureChild(process.execPath, ["--input-type=module", "-e", checkScript], {
    cwd: process.cwd(),
    env,
    timeout,
    expectedStderr,
  });
  let message = result.stderr;
  if (refusal && result.signal) {
    const {
      firstStderrMs,
      expectedPrefixMs,
      exactStderr,
      parentSentSignal,
      exitMs,
      exitToCloseMs,
    } = result.timing;
    message = [
      `hook=${refusal.phase}`,
      `status=${result.status}`,
      `signal=${result.signal}`,
      `parentSentSignal=${parentSentSignal}`,
      `cache=${Boolean(env.NODE_COMPILE_CACHE)}`,
      `deadlineMs=${timeout}`,
      `exactStderr=${exactStderr}`,
      `firstStderrMs=${firstStderrMs ?? "unobserved"}`,
      `expectedPrefixMs=${expectedPrefixMs ?? "unobserved"}`,
      `exitMs=${exitMs ?? "unobserved"}`,
      `exitToCloseMs=${exitToCloseMs ?? "unobserved"}`,
    ].join(" ");
  }
  assert.equal(result.signal ?? null, null, message);
  if (refusal) {
    assert.equal(result.status, 1);
    assert.equal(result.stderr, expectedStderr);
  }
  return { ...result, directory };
}

test(
  "the first-install check refuses malformed Compute configuration before migration",
  tooling,
  async (t) => {
    const { hook } = await render({}, false);
    const [check] = hook.initContainers;
    assert.equal(check.name, "installation-check");
    assert.deepEqual(check.args, ["--input-type=module", "-e", checkScript]);
    const environment = () =>
      Object.fromEntries(
        check.env
          .filter(({ name }) => name !== "OCC_CONFIG_PATH")
          .map(({ name, value }) => [name, value]),
      );
    const configuration = installation();
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
  },
);

test("the upgrade hook check passes an Installation API startup accepts", async (t) => {
  const configuration = installation();
  configuration.presets = { includeDefaults: true, files: ["presets/team.json"] };
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
});

test("the upgrade hook checks the public token grant bundle before migration", async (t) => {
  const directory = await temporaryDirectory(t, "occ-token-grant-bundle-");
  const bundlePath = join(directory, "bundle.json");
  const configuration = credentialProxyInstallation();
  configuration.drivers.credential_proxy.configuration.tokenGrant = {
    endpoint: "https://authority.example.test:9445/token",
    port: 9445,
    trustDomain: "example.test",
    bundlePath,
  };

  const result = await runCheck(t, configuration);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /token grant JWT trust bundle/i);
  assert.equal(result.stdout, "");

  const invalidKey = { use: "jwt-svid", kty: "EC", kid: "private-fixture-marker", crv: "P-256" };
  const { publicKey: weakKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  for (const invalid of [
    '{"private-fixture-marker":',
    JSON.stringify({ keys: [] }),
    JSON.stringify({ keys: [invalidKey] }),
    JSON.stringify({
      keys: [{ ...weakKey.export({ format: "jwk" }), kid: "weak", use: "jwt-svid" }],
    }),
  ]) {
    await writeFile(bundlePath, invalid, "utf8");
    const result = await runCheck(t, configuration);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /token grant JWT trust bundle/i);
    assert.doesNotMatch(result.stderr, /private-fixture-marker/);
    assert.equal(result.stdout, "");
  }

  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  await writeFile(
    bundlePath,
    JSON.stringify({
      keys: [invalidKey, { ...publicKey.export({ format: "jwk" }), kid: "test", use: "jwt-svid" }],
    }),
    "utf8",
  );
  const accepted = await runCheck(t, configuration);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, "installation-startup-ready\n");
});

test(
  "the upgrade hook refuses private Gateway routing that differs from the chart",
  tooling,
  async (t) => {
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
      const gateway = objects.find(({ kind }) => kind === "Gateway");
      const [check] = objects.find(
        ({ kind, metadata }) =>
          kind === "Job" && metadata.labels["app.kubernetes.io/component"] === "initialization",
      ).spec.template.spec.initContainers;
      const environment = Object.fromEntries(
        check.env
          .filter(({ name }) => name === "OCC_CHART_GATEWAY_ROUTING")
          .map(({ name, value }) => [name, value]),
      );
      const configuration = installation();
      const compute = configuration.drivers.compute.configuration;
      delete compute.network.gatewayClients;
      compute.gatewayRouting = {
        gatewayName,
        gatewayNamespace: namespace,
        envoyNamespace,
        ...(hostname === undefined ? {} : { hostname }),
      };

      // Both automatic Service DNS and custom routing must pass the actual chart hook.
      // An explicit spelling of the automatic hostname is equivalent to omitting it.
      const hostnames =
        hostname === undefined
          ? [undefined, "", gateway.spec.listeners.find(({ name }) => name === "https").hostname]
          : [hostname];
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
      const mismatches = [
        ["gatewayName", "other-gateway"],
        ["gatewayNamespace", "other-namespace"],
        ["envoyNamespace", "other-namespace"],
        ["hostname", "other.example"],
        ...(hostname === undefined ? [] : [["hostname", undefined]]),
      ];
      for (const [field, value] of mismatches) {
        const different = structuredClone(configuration);
        different.drivers.compute.configuration.gatewayRouting[field] = value;
        const refused = await runCheck(t, different, {}, () => environment);
        assert.equal(refused.status, 1, `${field}: ${refused.stderr}`);
        assert.equal(refused.stdout, "");
        assert.match(refused.stderr, /\(CHART_LISTENER_MISMATCH\)/);
        assert.ok(refused.stderr.includes(`drivers.compute.configuration.gatewayRouting.${field}`));
        assert.doesNotMatch(refused.stderr, /other\.example|other-namespace|other-gateway/);
      }
    }
  },
);

test("the upgrade hook check names the key and file of a refused Installation", async (t) => {
  const prefix = "installation-check: API and worker startup would refuse the Installation";
  // D407: presets.files names a file the image lacks.
  const missing = installation();
  missing.presets = { files: ["presets/missing.json"] };
  const absent = await runHook(t, missing, {
    refusal: {
      phase: "missing-preset",
      expected: (directory) =>
        `${prefix} (PRESET_FILE_INVALID): presets.files: Preset file ${join(directory, "presets/missing.json")} is unavailable.\n`,
    },
  });
  assert.equal(absent.stdout, "");

  // A loader message that already names the key is not prefixed twice.
  const blank = installation();
  blank.presets = { files: ["  "] };
  await runHook(t, blank, {
    refusal: {
      phase: "blank-preset",
      expected: () =>
        `${prefix} (PRESET_FILE_INVALID): presets.files entries must be nonempty file paths.\n`,
    },
  });

  // Other startup refusals keep the loader's message, which names the setting.
  const observability = installation();
  observability.observability = { url: "ftp://metrics.example.test" };
  await runHook(t, observability, {
    refusal: {
      phase: "invalid-observability",
      expected: () =>
        `${prefix}: observability.url must be an absolute HTTP or HTTPS URL without credentials or a fragment.\n`,
    },
  });
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
          .filter(({ name }) =>
            [
              "OCC_EGRESS_AUTHORITY_PORT",
              "OCC_OPENSHELL_GIT_PORT",
              "OCC_TOKEN_GRANT_PORT",
            ].includes(name),
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

    // The same preflight guards the request token listener before a Recreate upgrade stops the API.
    const requestCredentials = structuredClone(reachable);
    requestCredentials.drivers.credential_proxy.configuration.tokenGrant = {
      endpoint: "https://authority.example.test:9445/token",
      port: 9445,
      trustDomain: "example.test",
      bundlePath: "/etc/openclaw/egress/token-grant/bundle.json",
    };
    const tokenEnvironment = await chartEnvironment(tokenGrantValues);
    const wrongBundle = structuredClone(requestCredentials);
    wrongBundle.drivers.credential_proxy.configuration.tokenGrant.bundlePath =
      "/unmounted/bundle.json";
    for (const [configuration, environment, diagnostic] of [
      [requestCredentials, enabled, /Helm egressAuthority.tokenGrant.enabled is false/],
      [
        requestCredentials,
        { ...tokenEnvironment, OCC_TOKEN_GRANT_PORT: "9555" },
        /Helm egressAuthority.tokenGrant.port is 9555/,
      ],
      [
        wrongBundle,
        tokenEnvironment,
        /bundlePath must be \/etc\/openclaw\/egress\/token-grant\/bundle.json/,
      ],
    ]) {
      const refused = await runCheck(t, configuration, {}, () => environment);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /CHART_LISTENER_MISMATCH/);
      assert.match(refused.stderr, diagnostic);
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
      [openShellGitChartListener, mounted(worker, "worker")],
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
        Object.entries(openShellGitChartListener.files).map(([key, [path]]) => [key, path]),
      ),
    };
    const declared = { OCC_OPENSHELL_GIT_PORT: "8445" };
    requireChartListener(transport, declared, openShellGitChartListener);
    assert.throws(
      () =>
        requireChartListener(
          { ...transport, issuerPublicKeyPath: "/etc/openclaw/openshell-git/issuer.pub" },
          declared,
          openShellGitChartListener,
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
    // The same code and field detail as the API and worker startup logs (finding 2226).
    'installation-check: API and worker startup would refuse the Installation: DRIVER_CONFIGURATION_INVALID: [{"path":"/drivers/compute/configuration/network/repositoryCredentials","code":"INVALID_VALUE","message":"drivers.compute.configuration.network.repositoryCredentials requires repository.nativeSender; remove it for protected Git or when no repository is configured."}]\n',
  );
  // The documented recovery deletes only the peer; the rest of the Installation is unchanged.
  delete leftover.drivers.compute.configuration.network.repositoryCredentials;
  const recovered = await runCheck(t, leftover);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, "installation-startup-ready\n");
});
