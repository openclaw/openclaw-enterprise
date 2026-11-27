import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { asRecord } from "../../packages/utils/src/index.ts";
import { composeConfiguration, composeConfigurationProvider } from "../helpers/compose.ts";
import { firstAgentComposeImages } from "../helpers/local-first-agent-stack.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

function composeRecord(value: unknown, field: string): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, `Expected Compose to render ${field} as an object`);
  return record;
}

function composeList(value: unknown, field: string): readonly unknown[] {
  assert.ok(Array.isArray(value), `Expected Compose to render ${field} as a list`);
  return value;
}

function volumeMounts(value: unknown, field: string) {
  // podman-compose preserves short syntax; Docker Compose expands it.
  return composeList(value ?? [], field).map((mount, index) => {
    if (typeof mount !== "string") {
      const { source, target } = composeRecord(mount, `${field}[${index}]`);
      assert.ok(
        source === undefined || typeof source === "string",
        `Expected ${field}[${index}].source to be a string when present`,
      );
      assert.ok(typeof target === "string", `Expected ${field}[${index}].target to be a string`);
      return { source, target };
    }
    const [source, target] = mount.split(":");
    return { source, target };
  });
}

function secretMounts(value: unknown, field: string) {
  return composeList(value, field).map((mount, index) => {
    if (typeof mount === "string") {
      return { source: mount, target: undefined };
    }
    const { source, target } = composeRecord(mount, `${field}[${index}]`);
    assert.ok(typeof source === "string", `Expected ${field}[${index}].source to be a string`);
    assert.ok(
      target === undefined || typeof target === "string",
      `Expected ${field}[${index}].target to be a string when present`,
    );
    return { source, target };
  });
}

test("development packaging isolates precreated credential inputs to the bootstrap service", async () => {
  const configuration = composeConfiguration();
  const services = composeRecord(configuration.services, "services");
  const bootstrap = composeRecord(services.bootstrap, "services.bootstrap");
  const controller = composeRecord(services.controller, "services.controller");
  composeRecord(services.migrate, "services.migrate");
  composeRecord(services.worker, "services.worker");
  const bootstrapEnvironment = composeRecord(bootstrap.environment, "bootstrap.environment");
  const controllerEnvironment = composeRecord(controller.environment, "controller.environment");
  const secrets = composeRecord(configuration.secrets, "secrets");
  const bootstrapSecrets = secretMounts(bootstrap.secrets, "bootstrap.secrets");

  assert.deepEqual(bootstrap.command, ["scripts/bootstrap-installation.mjs"]);
  assert.equal(bootstrapEnvironment.NODE_ENV, "development");
  assert.equal(
    bootstrapEnvironment.OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE,
    "/run/secrets/admin-password",
  );
  assert.equal(
    bootstrapEnvironment.OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE,
    "/run/secrets/admin-service-key",
  );
  assert.deepEqual(bootstrapSecrets.map(({ source }) => source).sort(), [
    "bootstrap-admin-password",
    "bootstrap-admin-service-key",
  ]);
  assert.deepEqual(bootstrapSecrets.map(({ target }) => target).sort(), [
    "admin-password",
    "admin-service-key",
  ]);
  assert.equal(
    composeRecord(secrets["bootstrap-admin-password"], "secrets.bootstrap-admin-password").file,
    "/tmp/occ-packaging-admin-password",
  );
  assert.equal(
    composeRecord(secrets["bootstrap-admin-service-key"], "secrets.bootstrap-admin-service-key")
      .file,
    "/tmp/occ-packaging-admin-service-key",
  );
  assert.equal(bootstrapEnvironment.OPENCLAW_DEV_EMAIL, "admin@openclaw.local");
  assert.equal(bootstrapEnvironment.OPENCLAW_DEV_PASSWORD, undefined);
  assert.equal(bootstrapEnvironment.OPENCLAW_DEV_INSTALLATION_NAME, "OpenClaw Local Development");
  assert.equal(controllerEnvironment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, undefined);
  assert.equal(controllerEnvironment.OPENCLAW_DEV_EMAIL, undefined);
  assert.equal(controllerEnvironment.OPENCLAW_DEV_PASSWORD, undefined);
  assert.equal(controllerEnvironment.OPENCLAW_DEV_INSTALLATION_NAME, undefined);

  const controllerDependencies = composeRecord(controller.depends_on, "controller.depends_on");
  const bootstrapDependency = composeRecord(
    controllerDependencies.bootstrap,
    "controller.depends_on.bootstrap",
  );
  assert.equal(bootstrapDependency.condition, "service_completed_successfully");
  assert.equal(bootstrapDependency.required ?? true, true);
  assert.equal(controllerDependencies.migrate, undefined);
  const bootstrapDependencies = composeRecord(bootstrap.depends_on, "bootstrap.depends_on");
  const migrateDependency = composeRecord(
    bootstrapDependencies.migrate,
    "bootstrap.depends_on.migrate",
  );
  assert.equal(migrateDependency.condition, "service_completed_successfully");
  assert.equal(migrateDependency.required ?? true, true);

  const volumes = composeRecord(configuration.volumes, "volumes");
  assert.equal(Object.hasOwn(volumes, "occ_bootstrap_data"), false);
  for (const [name, value] of Object.entries(services)) {
    const service = composeRecord(value, `services.${name}`);
    const environment = composeRecord(service.environment ?? {}, `${name}.environment`);
    assert.equal(environment.OCC_BOOTSTRAP_PASSWORD_FILE, undefined);
    assert.equal(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, undefined);
    assert.ok(
      volumeMounts(service.volumes, `${name}.volumes`).every(
        ({ source, target }) =>
          source !== "occ_bootstrap_data" && target !== "/var/lib/openclaw/bootstrap",
      ),
    );
    if (service !== bootstrap) {
      assert.equal(environment.OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE, undefined);
      assert.equal(environment.OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE, undefined);
      assert.ok(
        secretMounts(service.secrets ?? [], `${name}.secrets`).every(
          ({ source }) =>
            !["bootstrap-admin-password", "bootstrap-admin-service-key"].includes(source),
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
  const services = composeRecord(source.services, "services");
  for (const name of ["migrate", "bootstrap", "controller", "worker-kubernetes", "browser-proxy"]) {
    const service = composeRecord(services[name], `services.${name}`);
    assert.ok(service.build);
    delete service.build;
    service.image = image;
  }
  assert.deepEqual(selected, source);
  assert.throws(() => firstAgentComposeImages(image.replace(/@.*/, ":latest")), /immutable/);
});
