import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  createCredentialProxyInstallationConfiguration,
  createInstallationDriverConfiguration as installation,
} from "../helpers/installation-driver-configuration.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { FakeSecretCoreV1Api } from "../helpers/kubernetes-secret-core.mjs";
import { testPool } from "../helpers/postgres-database.mjs";

test("secret-driver-startup constructs the bundled KubernetesSecretDriver from Installation YAML", async (t) => {
  const drivers = await loadInstallationFile(t, installation());
  assert.ok(drivers);

  const { definition, ...selection } = drivers.installation.drivers.secret;
  assert.equal(definition, KubernetesSecretDriver);
  assert.deepEqual(selection, {
    id: "secret-kubernetes",
    implementation: "occ/kubernetes-secret",
    configuration: { authentication: { mode: "inCluster" } },
    startupConfiguration: { authentication: { mode: "inCluster" } },
  });
  assert.ok(drivers.secretDriver instanceof KubernetesSecretDriver);
  assert.equal(drivers.secretDriver.capability, "secret");
  assert.equal(drivers.secretDriver.id, "secret-kubernetes");
  assert.equal(drivers.secretDriver.implementation, "occ/kubernetes-secret");

  const pool = testPool(t, { connectionString: "postgresql://127.0.0.1:1/occ" });
  assert.doesNotThrow(() =>
    createControllerWorker({
      pool,
      mode: "production",
      drivers,
      emit: () => {},
    }),
  );
});

test("secret-driver-startup requires one bundled SecretDriver selection and validates its configuration", async (t) => {
  const missing = installation();
  Reflect.deleteProperty(missing.drivers, "secret");
  await assert.rejects(loadInstallationFile(t, missing), /drivers\.secret/);

  const packageSelection = installation();
  Object.assign(packageSelection.drivers.secret, { package: "@example/secret-driver" });
  await assert.rejects(
    loadInstallationFile(t, packageSelection),
    /drivers\.secret contains unsupported option package/,
  );

  const invalid = installation();
  Object.assign(invalid.drivers.secret.configuration, {
    authentication: {
      mode: "kubeconfig",
      kubeconfigPath: "relative",
      context: "default",
    },
  });
  await assert.rejects(loadInstallationFile(t, invalid), (error) => {
    assert.ok(error instanceof ConfigurationValidationError);
    assert.deepEqual(error.error.details, [
      {
        path: "/authentication/kubeconfigPath",
        code: "INVALID_FORMAT",
        message: "Dedicated kubeconfig path must be absolute.",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(error.error.details), /relative/);
    return true;
  });
});

test("TokenService startup keeps marker ownership with the selected private Secret Driver", async (t) => {
  const core = new FakeSecretCoreV1Api();
  const state = new InMemoryPlatformState();
  const createdAt = new Date().toISOString();
  const installation = { id: `ins_${randomUUID()}`, name: "TokenService startup", createdAt };
  await state.transact((unit) => unit.installations.createInstallation(installation));

  async function start(secretId: string) {
    const base = createCredentialProxyInstallationConfiguration();
    base.drivers.secret.id = secretId;
    const configuration = {
      ...base,
      drivers: { ...base.drivers, token_service: { id: "occ", configuration: {} } },
    };
    const drivers = await loadInstallationFile(t, configuration);
    assert.ok(drivers);
    assert.ok(drivers.secretDriver instanceof KubernetesSecretDriver);
    // Substitute only the Core API transport; ownership checks remain in the real Driver.
    Reflect.set(drivers.secretDriver, "client", Promise.resolve(core));
    const controller = new OpenClawController(installation, { state });
    await installTokenServiceDriver(controller, drivers);
    return controller;
  }

  const initial = await start("secret-a");
  const initialInstance = initial.currentTokenServiceInstanceId();
  assert.equal((await start("secret-a")).currentTokenServiceInstanceId(), initialInstance);
  assert.equal(core.secrets.size, 1);

  const namespaceId = `ns_${randomUUID()}`;
  await state.transact((unit) =>
    unit.namespaces.createNamespace({
      id: namespaceId,
      name: "Source owner",
      status: "provisioning",
      createdAt,
    }),
  );
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
  );
  const owner = initial.selectedDriver("token_service");
  const source = await owner.createSource(
    {
      namespaceId,
      name: "Active source",
      lifecycleConfig: { type: "static", settings: {} },
      secret: { credential: randomUUID() },
      config: {},
    },
    AbortSignal.timeout(5_000),
  );
  // A new private owner can establish its own marker, but live source custody
  // still prevents selecting a replacement TokenService instance.
  await assert.rejects(start("secret-b"), /still has registrations/);
  const sourceInstance = {
    sourceRef: { kind: "credential_source" as const, namespaceId, id: source.id },
    tokenServiceInstanceId: initialInstance,
  };
  await owner.prepareSourceRetirement(sourceInstance, AbortSignal.timeout(5_000));
  await owner.removeSource(sourceInstance, AbortSignal.timeout(5_000));

  const replacement = await start("secret-b");
  assert.notEqual(replacement.currentTokenServiceInstanceId(), initialInstance);
  assert.equal(
    (await start("secret-b")).currentTokenServiceInstanceId(),
    replacement.currentTokenServiceInstanceId(),
  );
  assert.equal(core.secrets.size, 2);
  assert.deepEqual(
    [...core.secrets.values()]
      .map((secret) => secret.metadata.annotations["openclaw.dev/secret-driver-id"])
      .sort(),
    ["secret-a", "secret-b"],
  );
});
