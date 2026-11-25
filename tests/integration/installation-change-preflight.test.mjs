import { selectedImageMigrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { captureChild } from "../helpers/child-processes.mjs";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.ts";
import { chartTooling } from "../helpers/production-chart.ts";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";
import { generateInstallationCheck } from "../../deploy/helm/src/generate-installation-check.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  acceptedStartupCase,
  gatewayRoutingCase,
  leftoverBrokerPeerCase,
  malformedComputeCase,
  refusalDetailsCase,
  refusedThemeCase,
  renderPreflightChart as render,
} from "./installation-change-preflight-cases.ts";

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
  "repositoryCredentials.serviceName": "git",
};
const themeValues = { "api.consoleTheme.configMapName": "console-theme-v2" };
const gatewayValues = {
  "gatewayRouting.enabled": "true",
  "gatewayRouting.gatewayClassName": "eg",
  "gatewayRouting.apiKeySecretName": "private-gateway-key",
};
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
        ...("gatewayRouting.enabled" in values
          ? [environment(server, "OCC_CHART_GATEWAY_ROUTING")]
          : []),
        ...(theme ? [environment(server, "OCC_CONSOLE_THEME_DIR")] : []),
      ]);
      // Each file the check reads comes from the API's own volume at the API's path.
      const expected = ["installation-startup"];
      if (theme) {
        expected.push("console-theme");
      }
      if ("repositoryCredentials.enabled" in values) {
        expected.push("repository-registry", "repository-public-ca");
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
      assert.equal(hook.automountServiceAccountToken, false);
    }
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
    await malformedComputeCase(t, runCheck, checkScript, installation);
  },
);

test("the upgrade hook check passes an Installation API startup accepts", async (t) => {
  await acceptedStartupCase(t, runCheck);
});

test(
  "the upgrade hook refuses private Gateway routing that differs from the chart",
  tooling,
  async (t) => {
    await gatewayRoutingCase(t, runCheck, gatewayValues);
  },
);

test("the upgrade hook check names the key and file of a refused Installation", async (t) => {
  await refusalDetailsCase(t, runHook);
});

test("the upgrade hook check refuses a Console theme the API would refuse", async (t) => {
  await refusedThemeCase(t, runCheck);
});

test("the upgrade hook check refuses a repository broker peer until the operator removes it", async (t) => {
  await leftoverBrokerPeerCase(t, runCheck);
});
