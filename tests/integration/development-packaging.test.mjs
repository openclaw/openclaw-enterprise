import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { composeConfiguration, composeConfigurationProvider } from "../helpers/compose.ts";

import { firstAgentComposeImages } from "../helpers/local-first-agent-stack.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

function volumeMounts(service) {
  // podman-compose preserves short syntax; Docker Compose expands it.
  return (service.volumes ?? []).map((mount) => {
    if (typeof mount !== "string") {
      return mount;
    }
    const [source, target, options = ""] = mount.split(":");
    return { source, target, read_only: options.split(",").includes("ro") };
  });
}

test("development packaging isolates precreated credential inputs to the bootstrap service", async () => {
  const configuration = composeConfiguration();
  const { bootstrap, controller, migrate, worker } = configuration.services;
  assert.ok(bootstrap);
  assert.ok(controller);
  assert.ok(migrate);
  assert.ok(worker);

  assert.deepEqual(bootstrap.command, ["scripts/bootstrap-installation.mjs"]);
  assert.equal(bootstrap.environment.NODE_ENV, "development");
  assert.equal(
    bootstrap.environment.OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE,
    "/run/secrets/admin-password",
  );
  assert.equal(
    bootstrap.environment.OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE,
    "/run/secrets/admin-service-key",
  );
  const secretName = (secret) => (typeof secret === "string" ? secret : secret.source);
  assert.deepEqual(bootstrap.secrets.map(secretName).sort(), [
    "bootstrap-admin-password",
    "bootstrap-admin-service-key",
  ]);
  assert.deepEqual(bootstrap.secrets.map(({ target }) => target).sort(), [
    "admin-password",
    "admin-service-key",
  ]);
  assert.equal(
    configuration.secrets["bootstrap-admin-password"].file,
    "/tmp/occ-packaging-admin-password",
  );
  assert.equal(
    configuration.secrets["bootstrap-admin-service-key"].file,
    "/tmp/occ-packaging-admin-service-key",
  );
  assert.equal(bootstrap.environment.OPENCLAW_DEV_EMAIL, "admin@openclaw.local");
  assert.equal(bootstrap.environment.OPENCLAW_DEV_PASSWORD, undefined);
  assert.equal(bootstrap.environment.OPENCLAW_DEV_INSTALLATION_NAME, "OpenClaw Local Development");
  assert.equal(controller.environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, undefined);
  assert.equal(controller.environment.OPENCLAW_DEV_EMAIL, undefined);
  assert.equal(controller.environment.OPENCLAW_DEV_PASSWORD, undefined);
  assert.equal(controller.environment.OPENCLAW_DEV_INSTALLATION_NAME, undefined);
  assert.equal(migrate.environment?.OCC_BOOTSTRAP_SERVICE_KEY_FILE, undefined);
  assert.equal(worker.environment?.OCC_BOOTSTRAP_SERVICE_KEY_FILE, undefined);

  assert.equal(controller.depends_on.bootstrap.condition, "service_completed_successfully");
  assert.equal(controller.depends_on.bootstrap.required ?? true, true);
  assert.equal(controller.depends_on.migrate, undefined);
  assert.equal(bootstrap.depends_on.migrate.condition, "service_completed_successfully");
  assert.equal(bootstrap.depends_on.migrate.required ?? true, true);

  assert.equal(Object.hasOwn(configuration.volumes, "occ_bootstrap_data"), false);
  for (const service of Object.values(configuration.services)) {
    assert.equal(service.environment?.OCC_BOOTSTRAP_PASSWORD_FILE, undefined);
    assert.equal(service.environment?.OCC_BOOTSTRAP_SERVICE_KEY_FILE, undefined);
    assert.ok(
      volumeMounts(service).every(
        ({ source, target }) =>
          source !== "occ_bootstrap_data" && target !== "/var/lib/openclaw/bootstrap",
      ),
    );
    if (service !== bootstrap) {
      assert.equal(service.environment?.OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE, undefined);
      assert.equal(service.environment?.OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE, undefined);
      assert.ok(
        (service.secrets ?? []).every(
          (secret) =>
            !["bootstrap-admin-password", "bootstrap-admin-service-key"].includes(
              secretName(secret),
            ),
        ),
      );
    }
  }
});

// A plain `build: null` does not remove inherited builds. Exercise Compose's
// real merge so the prepared-image path cannot silently rebuild every service
// or alter the bootstrap, credential-mount and readiness dependencies.
test("prepared first-Agent Compose images replace builds and preserve service contracts", async (t) => {
  if (composeConfigurationProvider().format !== "json") {
    t.skip("The prepared first-Agent image path uses Docker Compose.");
    return;
  }
  const directory = await temporaryDirectory(t, "first-agent-compose-images-");
  const image = `127.0.0.1:5000/openclaw-ci-first-images-test/controller@sha256:${"a".repeat(64)}`;
  const file = join(directory, "images.yaml");
  await writeFile(file, firstAgentComposeImages(image));
  const files = ["compose.yaml", "compose.kubernetes.yaml", "compose.native-admin.yaml"];
  const environment = {
    OCC_DEVELOPMENT_INSTALLATION_CONFIG: join(directory, "installation.yaml"),
    OCC_DEVELOPMENT_KUBECONFIG: join(directory, "kubeconfig"),
    OCC_DEVELOPMENT_NETWORK_NAME: "first-agent-compose-config",
    OCC_DEVELOPMENT_BROWSER_ORIGIN: "https://console.example.test:8443",
    OCC_DEVELOPMENT_AGENT_NATIVE_ADMIN_DOMAIN: "agents.example.test",
    OCC_DEVELOPMENT_BROWSER_PORT: "8443",
    OCC_DEVELOPMENT_BROWSER_TLS_CERT: join(directory, "tls.crt"),
    OCC_DEVELOPMENT_BROWSER_TLS_KEY: join(directory, "tls.key"),
  };
  const source = composeConfiguration(files, environment);
  const selected = composeConfiguration([...files, file], environment);
  for (const name of ["migrate", "bootstrap", "controller", "worker-kubernetes", "browser-proxy"]) {
    assert.ok(source.services[name].build);
    delete source.services[name].build;
    source.services[name].image = image;
  }
  assert.deepEqual(selected, source);
  assert.throws(() => firstAgentComposeImages(image.replace(/@.*/, ":latest")), /immutable/);
});
