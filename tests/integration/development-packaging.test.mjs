import assert from "node:assert/strict";
import test from "node:test";
import { composeConfiguration } from "../helpers/compose.mjs";

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

test("development packaging isolates bootstrap service key output to the bootstrap service", async () => {
  const configuration = composeConfiguration();
  const { bootstrap, controller, migrate, worker } = configuration.services;
  assert.ok(bootstrap);
  assert.ok(controller);
  assert.ok(migrate);
  assert.ok(worker);

  assert.deepEqual(bootstrap.command, ["scripts/bootstrap-installation.mjs"]);
  assert.equal(bootstrap.environment.NODE_ENV, "development");
  assert.equal(
    bootstrap.environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE,
    "/var/lib/openclaw/bootstrap/initial-admin-service-key.json",
  );
  assert.equal(bootstrap.environment.OPENCLAW_DEV_EMAIL, "admin@openclaw.local");
  assert.equal(bootstrap.environment.OPENCLAW_DEV_PASSWORD, "openclaw-development-password");
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

  assert.ok(Object.hasOwn(configuration.volumes, "occ_bootstrap_data"));
  const bootstrapMounts = volumeMounts(bootstrap).filter(
    ({ target }) => target === "/var/lib/openclaw/bootstrap",
  );
  assert.equal(bootstrapMounts.length, 1);
  assert.equal(bootstrapMounts[0].source, "occ_bootstrap_data");
  assert.equal(bootstrapMounts[0].type ?? "volume", "volume");
  assert.equal(bootstrapMounts[0].read_only ?? false, false);
  for (const service of [controller, migrate, worker]) {
    assert.ok(
      volumeMounts(service).every(({ source, target }) => {
        return source !== "occ_bootstrap_data" && target !== "/var/lib/openclaw/bootstrap";
      }),
    );
  }
});
