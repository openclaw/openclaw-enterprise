import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  ConfigurationValidationError,
  type CredentialProxyDriver,
} from "../../packages/contracts/src/index.ts";
import {
  InMemoryPlatformState,
  OpenClawController,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import {
  KubernetesSecretDriver,
  SecretBackendUnavailableError,
} from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/access/clock.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  createCredentialProxyInstallationConfiguration,
  createInstallationDriverConfiguration as installation,
} from "../helpers/installation-driver-configuration.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { FakeSecretCoreV1Api } from "../helpers/kubernetes-secret-core.mjs";
import { testPool } from "../helpers/postgres-database.mjs";
import { fixtureAppId, startGitHubFixture } from "../fixtures/repository-credentials/github.ts";
import { sharedRsaKeyPair } from "../fixtures/repository-credentials/shared-keys.ts";

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
  let deliveredCredential: string | undefined;
  let initialDrivers: Awaited<ReturnType<typeof loadInstallationFile>>;
  const notify: NonNullable<CredentialProxyDriver["notifyCredentialUpdated"]> = async (
    _notification,
    resolveCredential,
  ) => {
    deliveredCredential = (await resolveCredential()).credential;
  };

  async function start(secretId: string, role: "api" | "worker" = "api") {
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
    const proxy = drivers.credentialDeliveryRegistration?.require("credential_proxy_delivery");
    assert.ok(proxy);
    if (initialDrivers === undefined && role === "api") {
      initialDrivers = drivers;
    }
    // Control only the delivery boundary; production composition must bind this registered Proxy
    // before the controller has selected its Sandbox or delivery capability.
    assert.equal(Reflect.set(proxy, "notifyCredentialUpdated", notify), true);
    const controller = new OpenClawController(installation, { state });
    await installTokenServiceDriver(controller, drivers, state, { role });
    return controller;
  }

  // Worker startup must never initialize private custody using its read/delete role.
  await assert.rejects(start("secret-a", "worker"), SecretBackendUnavailableError);
  assert.equal(core.secrets.size, 0);
  const initial = await start("secret-a");
  const initialInstance = initial.currentTokenServiceInstanceId();
  // An API restart can reuse the same loaded native registration and replace its resolver.
  assert.ok(initialDrivers);
  const restartedApi = new OpenClawController(installation, { state });
  await installTokenServiceDriver(restartedApi, initialDrivers, state);
  assert.equal(restartedApi.currentTokenServiceInstanceId(), initialInstance);
  assert.equal(
    (await start("secret-a", "worker")).currentTokenServiceInstanceId(),
    initialInstance,
  );
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
  const missingClientOperation = Object.create(owner);
  Object.defineProperties(missingClientOperation, {
    id: { value: "missing-client-operation" },
    registerClientSecret: { value: undefined },
  });
  assert.throws(() => initial.registerDriver(missingClientOperation), /capability contract/);
  const unsupportedClientScope = Object.create(owner);
  Object.defineProperties(unsupportedClientScope, {
    id: { value: "unsupported-client-scope" },
    clientScopes: { value: { "github-app": ["namespace"] } },
  });
  assert.throws(() => initial.registerDriver(unsupportedClientScope), /capability contract/);
  assert.deepEqual(owner.clientScopes, {
    oauth2: ["installation", "namespace"],
    "github-app": ["installation"],
  });
  const client = {
    kind: "oauth2" as const,
    namespaceId,
    id: `ccr_${randomUUID()}`,
    tokenServiceInstanceId: initialInstance,
    tokenUrl: "https://issuer.example.org/token",
  };
  const firstClientSecret = randomUUID();
  await owner.registerClientSecret(client, firstClientSecret, AbortSignal.timeout(5_000));
  assert.equal(
    await owner.resolveClientSecret(client, AbortSignal.timeout(5_000)),
    firstClientSecret,
  );

  // TokenService custody is scoped to the exact selected owner, Namespace and approved endpoint.
  await assert.rejects(
    owner.resolveClientSecret(
      { ...client, tokenUrl: "https://other.example.org/token" },
      AbortSignal.timeout(5_000),
    ),
    SecretBackendUnavailableError,
  );
  const { namespaceId: _namespace, ...unscopedClient } = client;
  await assert.rejects(
    owner.resolveClientSecret(unscopedClient, AbortSignal.timeout(5_000)),
    SecretBackendUnavailableError,
  );
  await assert.rejects(
    owner.resolveClientSecret(
      { ...client, tokenServiceInstanceId: randomUUID() },
      AbortSignal.timeout(5_000),
    ),
    ScopeViolationError,
  );
  // An invalid signing key must be refused before contacting GitHub or storing custody.
  const countBeforeInvalidClient = core.secrets.size;
  await assert.rejects(
    owner.registerClientSecret(
      {
        kind: "github-app",
        id: `ccr_${randomUUID()}`,
        tokenServiceInstanceId: initialInstance,
        appId: "123",
      },
      randomUUID(),
      AbortSignal.timeout(5_000),
    ),
    ScopeViolationError,
  );
  assert.equal(core.secrets.size, countBeforeInvalidClient);
  const nextClientSecret = randomUUID();
  await owner.updateClientSecret(client, nextClientSecret, AbortSignal.timeout(5_000));
  assert.equal(
    await owner.resolveClientSecret(client, AbortSignal.timeout(5_000)),
    nextClientSecret,
  );
  await owner.removeClientSecret(client, AbortSignal.timeout(5_000));
  const source = await owner.createSource(
    {
      type: "static",
      namespaceId,
      name: "Active source",
      lifecycleConfig: { settings: {} },
      secret: randomUUID(),
      config: {},
    },
    AbortSignal.timeout(5_000),
  );
  const sourceInstance = {
    sourceRef: { kind: "credential_source" as const, namespaceId, id: source.id },
    tokenServiceInstanceId: initialInstance,
  };
  const refreshedCredential = randomUUID();
  await owner.updateSource(
    sourceInstance,
    { secret: refreshedCredential },
    AbortSignal.timeout(5_000),
  );
  assert.equal(deliveredCredential, refreshedCredential);

  // A new private owner can establish its own marker, but live source custody
  // still prevents selecting a replacement TokenService instance.
  await assert.rejects(start("secret-b"), /still has registrations/);
  await state.transact(({ credentialSources }) =>
    credentialSources.markCredentialSourceDeleting(namespaceId, source.id),
  );
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

test("TokenService verifies the GitHub App before private custody and hot key replacement", async (t) => {
  const gh = await startGitHubFixture(t, { clock: createSystemClock() });
  const core = new FakeSecretCoreV1Api();
  const secretDriver = new KubernetesSecretDriver({ authentication: { mode: "inCluster" } });
  Reflect.set(secretDriver, "client", Promise.resolve(core));
  const installationId = `ins_${randomUUID()}`;
  const instanceId = randomUUID();
  const owner = new OCCTokenServiceDriver(
    "occ",
    installationId,
    secretDriver.privateSecrets,
    instanceId,
    new InMemoryPlatformState(),
    undefined,
    undefined,
    { apiOrigin: gh.origin, ca: gh.tls.ca },
  );
  const client = {
    kind: "github-app" as const,
    id: `ccr_${randomUUID()}`,
    tokenServiceInstanceId: instanceId,
    appId: fixtureAppId,
  };
  const firstKey = gh.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  // The common custody identity does not enable an unsupported Client registration scope.
  await assert.rejects(
    owner.registerClientSecret({ ...client, namespaceId: "ns_unsupported" }, firstKey, t.signal),
    ScopeViolationError,
  );
  assert.equal(gh.trace.length, 0);
  assert.equal(core.secrets.size, 0);
  await owner.registerClientSecret(client, firstKey, t.signal);
  assert.deepEqual(
    gh.trace.map(({ method, target }) => ({ method, target })),
    [{ method: "GET", target: "/app" }],
  );
  assert.equal(gh.issuesOfTokens.length, 0, "App verification must not mint an installation token");
  assert.equal(core.secrets.size, 1);

  // Compare only the fixture-owned private-store digest; assertion output never contains a key.
  const privateDigest = () => {
    const [secret] = core.secrets.values();
    assert.ok(secret?.data);
    const [encoded] = Object.values(secret.data);
    assert.ok(typeof encoded === "string");
    return createHash("sha256").update(encoded).digest("hex");
  };
  const firstDigest = privateDigest();
  const untrustedOwner = new OCCTokenServiceDriver(
    "occ",
    installationId,
    secretDriver.privateSecrets,
    instanceId,
    new InMemoryPlatformState(),
    undefined,
    undefined,
    { apiOrigin: gh.origin },
  );
  const requestsBeforeUntrusted = gh.trace.length;
  await assert.rejects(
    untrustedOwner.updateClientSecret(client, firstKey, t.signal),
    ScopeViolationError,
  );
  assert.equal(
    gh.trace.length,
    requestsBeforeUntrusted,
    "an untrusted peer cannot receive the JWT",
  );
  assert.ok(privateDigest() === firstDigest, "failed TLS verification must preserve custody");

  gh.setAppIdentityId(Number(fixtureAppId) + 1);
  await assert.rejects(owner.updateClientSecret(client, firstKey, t.signal), ScopeViolationError);
  assert.ok(privateDigest() === firstDigest, "a mismatched App must preserve the prior key");
  gh.setAppIdentityId(Number(fixtureAppId));

  const next = sharedRsaKeyPair("github-app-client-replacement");
  const nextKey = next.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  // A valid RSA key for another App must reach GitHub verification and leave current custody intact.
  const requestsBeforeWrongKey = gh.trace.length;
  await assert.rejects(owner.updateClientSecret(client, nextKey, t.signal), ScopeViolationError);
  assert.equal(gh.trace.length, requestsBeforeWrongKey + 1);
  assert.deepEqual(
    { method: gh.trace.at(-1)?.method, target: gh.trace.at(-1)?.target },
    { method: "GET", target: "/app" },
  );
  assert.ok(
    privateDigest() === firstDigest,
    "an unauthorized signature must preserve the prior key",
  );

  gh.setAppPublicKey(next.publicKey);
  await owner.updateClientSecret(client, nextKey, t.signal);
  assert.ok(privateDigest() !== firstDigest, "rotation replaces the current private reference");
  assert.equal(gh.issuesOfTokens.length, 0);

  // The OAuth resolution operation must never disclose a GitHub App signing key.
  await assert.rejects(
    Reflect.apply(owner.resolveClientSecret, owner, [client, t.signal]),
    ScopeViolationError,
  );
  await owner.removeClientSecret(client, t.signal);
  assert.equal(core.secrets.size, 0);
});
