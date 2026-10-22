import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { captureChild } from "../helpers/child-processes.mjs";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";
import {
  chartTooling,
  parseProductionChart,
  renderProductionChart,
} from "../helpers/production-chart.mjs";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";
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
