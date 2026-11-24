import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { ChatGPTClient } from "../../apps/controller/src/backends/chatgpt.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { ChatGPTServiceAccountDriver } from "../../apps/controller/src/drivers/service-account/chatgpt.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import type { Installation, Namespace, Principal } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
  ServiceAccountCredentialSecretExistsError,
} from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import {
  createDevelopmentComputeDriver,
  registerAndSelectDrivers,
} from "../helpers/development.ts";
import { authorizedPrincipal } from "../helpers/development-iam-state.ts";
import {
  apiKeyPath,
  backendId,
  createBackendFixture,
  databaseUrl,
  requiresPostgres,
  seedBackendBinding,
  serviceAccountDriverId,
  workspaceId,
} from "../helpers/postgres-backend-state.mjs";
import { testPool } from "../helpers/postgres-database.mjs";
import { waitForLockHolder } from "../helpers/postgres-locks.ts";

type CredentialStorage = ConstructorParameters<typeof ChatGPTServiceAccountDriver>[3];
type ProviderRevocation = Parameters<ChatGPTClient["deleteCredential"]>[0];

function accountSecretName(serviceAccountId: string): string {
  return `service-account-${createHash("sha256").update(serviceAccountId).digest("hex").slice(0, 32)}`;
}

/**
 * Finding 1397: an issuance whose token Secret was stored but whose transaction never committed
 * (a crash, or an unknown COMMIT that failed) skips its compensations. These cases run the real
 * OCC operations over PostgreSQL, so the account row lock, the Driver's binding reads on the
 * caller's transaction connection, and the rollback are real. The ChatGPT Driver is the
 * production class. The provider and the Secret store are in-memory stand-ins for its two
 * dependencies: the provider's HTTP handling and the Kubernetes Secret semantics (ownership,
 * uid and resourceVersion preconditions, the credential-ID annotation) are proved in
 * service-account-driver and kubernetes-compute conformance. No live provider or cluster runs.
 */
function dependencies(context: TestContext) {
  const provider: {
    live: Set<string>;
    revoked: string[];
    revocations: ProviderRevocation[];
    deletedAccounts: string[];
    issued: number;
  } = { live: new Set(), revoked: [], revocations: [], deletedAccounts: [], issued: 0 };
  const client = new ChatGPTClient({ workspaceId, adminKey: "synthetic-test-key" });
  const createCredential: ChatGPTClient["createCredential"] = async () => {
    provider.issued += 1;
    const id = `cred-${provider.issued}`;
    provider.live.add(id);
    return { id, accessToken: `synthetic-token-${provider.issued}` };
  };
  const deleteCredential: ChatGPTClient["deleteCredential"] = async (input) => {
    provider.revocations.push(input);
    provider.revoked.push(input.credentialId);
    provider.live.delete(input.credentialId);
  };
  const deleteServiceAccount: ChatGPTClient["deleteServiceAccount"] = async (accountId) => {
    provider.deletedAccounts.push(accountId);
  };
  context.mock.method(client, "createServiceAccount", async () => {
    assert.fail("This fixture seeds the provider account binding.");
  });
  context.mock.method(client, "createCredential", createCredential);
  context.mock.method(client, "deleteCredential", deleteCredential);
  context.mock.method(client, "deleteServiceAccount", deleteServiceAccount);

  // One token Secret per account under its deterministic name, recording its credential ID.
  const secrets = new Map<string, { credentialId: string; accessToken: string }>();
  const storage: CredentialStorage = {
    async storeServiceAccountCredential({ serviceAccountId, credentialId, accessToken }) {
      const name = accountSecretName(serviceAccountId);
      if (secrets.has(serviceAccountId)) {
        throw new ServiceAccountCredentialSecretExistsError("oce-control", name);
      }
      secrets.set(serviceAccountId, { credentialId, accessToken });
      return { name, key: "token" };
    },
    async findServiceAccountCredential({ serviceAccountId }) {
      const stored = secrets.get(serviceAccountId);
      return stored === undefined
        ? undefined
        : {
            secretNamespace: "oce-control",
            secretRef: { name: accountSecretName(serviceAccountId), key: "token" },
            credentialId: stored.credentialId,
          };
    },
    async deleteServiceAccountCredential({ serviceAccountId, accessToken, credentialId }) {
      const stored = secrets.get(serviceAccountId);
      if (
        stored === undefined ||
        (accessToken !== undefined && stored.accessToken !== accessToken) ||
        (credentialId !== undefined && stored.credentialId !== credentialId)
      ) {
        return;
      }
      secrets.delete(serviceAccountId);
    },
  };
  return { client, provider, secrets, storage };
}

/** An OCC API controller over `state` with the production ChatGPT ServiceAccount Driver. */
function apiController(
  installation: Installation,
  state: PostgresPlatformState,
  { client, storage }: Pick<ReturnType<typeof dependencies>, "client" | "storage">,
  compute:
    | KubernetesComputeDriver
    | ReturnType<typeof createDevelopmentComputeDriver> = createDevelopmentComputeDriver(),
) {
  const controller = new OpenClawController(installation, {
    state,
    backends: [
      {
        id: backendId,
        type: "chatgpt",
        configuration: { workspaceId, apiKeyPath },
        drivers: { service_account: serviceAccountDriverId },
      },
    ],
  });
  const driver = new ChatGPTServiceAccountDriver(
    { id: backendId, drivers: { service_account: serviceAccountDriverId }, client },
    controller,
    state,
    storage,
  );
  registerAndSelectDrivers(controller, [
    new NativeIAMDriver(state, { id: `issuance-recovery-iam-${randomUUID()}` }),
    compute,
    createTestConfigurationDriver(),
    driver,
  ]);
  return controller;
}

async function issuanceFixture(context: TestContext, options?: CredentialSecretFixtureOptions) {
  const fixture = await createBackendFixture(context);
  const { state, pool } = fixture;
  const actor: Principal | undefined = authorizedPrincipal(await state.loadNativeIAMState(), [
    ["read", "service_account"],
    ["update", "service_account"],
    ["delete", "service_account"],
  ]);
  assert.ok(actor, "persisted IAM must contain an unrestricted ServiceAccount Principal");
  const used = dependencies(context);
  const namespace: Namespace = fixture.track(
    await state.transact((unit) =>
      unit.namespaces.createNamespace({
        id: `ns_${randomUUID()}`,
        name: `issuance-recovery-${randomUUID()}`,
        status: "ready",
        createdAt: new Date().toISOString(),
      }),
    ),
  );
  const account = await state.transact((unit) =>
    unit.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `issuance-recovery-${randomUUID()}`,
    }),
  );
  await seedBackendBinding(pool, account, { credentialIssued: false });
  const kubernetes =
    options === undefined
      ? undefined
      : credentialSecretCompute(
          {
            namespaceId: namespace.id,
            serviceAccountId: account.id,
            credentialId: "cred-1",
            accessToken: "synthetic-token-1",
          },
          options,
          used.provider.revocations,
        );
  const controller = apiController(
    fixture.installation,
    state,
    { client: used.client, storage: kubernetes?.driver ?? used.storage },
    kubernetes?.driver,
  );
  const recordedCredentialId = async () =>
    (
      await pool.query<{ external_credential_id: string | null }>(
        "SELECT external_credential_id FROM occ.service_account_driver_bindings WHERE service_account_id = $1",
        [account.id],
      )
    ).rows[0]?.external_credential_id;
  const issue = () => controller.createServiceAccountCredential(actor.id, namespace.id, account.id);
  // The issuance runs to the end of its Driver call; then its COMMIT outcome is unknown and it
  // really failed. PostgreSQL rolls the transaction back and OCC runs no compensation, exactly
  // as for a crash after the Secret was stored.
  const abandonIssuance = async () => {
    await assert.rejects(
      controller.transact(async () => {
        await issue();
        throw new PostgresCommitOutcomeUnknownError();
      }),
      PostgresCommitOutcomeUnknownError,
    );
  };
  return {
    ...used,
    account,
    actor,
    controller,
    fixture,
    issue,
    abandonIssuance,
    kubernetes,
    namespace,
    recordedCredentialId,
  };
}

test(
  "an issuance that never committed is reclaimed by the next issuance under the account lock",
  requiresPostgres,
  async (context) => {
    const {
      abandonIssuance,
      account,
      actor,
      controller,
      issue,
      namespace,
      provider,
      recordedCredentialId,
      secrets,
    } = await issuanceFixture(context);
    await abandonIssuance();
    // The live credential and its Secret stayed, but nothing recorded them.
    assert.deepEqual([...provider.live], ["cred-1"]);
    assert.equal(secrets.get(account.id)?.credentialId, "cred-1");
    assert.equal(await recordedCredentialId(), null);
    assert.equal(
      (await controller.getServiceAccount(actor.id, namespace.id, account.id)).credential,
      undefined,
    );

    // Before finding 1397 this answered the leftover Secret's 409 until an operator deleted it.
    const issued = await issue();
    assert.equal(issued.credential?.kind, "access_token");
    assert.deepEqual(provider.revoked, ["cred-1"]);
    assert.deepEqual([...provider.live], ["cred-2"]);
    assert.equal(secrets.get(account.id)?.credentialId, "cred-2");
    assert.equal(await recordedCredentialId(), "cred-2");
  },
);

test(
  "deleting an account after an issuance that never committed revokes its credential and removes its Secret",
  requiresPostgres,
  async (context) => {
    const { abandonIssuance, account, actor, controller, namespace, provider, secrets } =
      await issuanceFixture(context);
    await abandonIssuance();

    // No credential is recorded, so the delete used to skip the Secret, which then outlived the
    // account holding a live token.
    await controller.deleteServiceAccount(actor.id, namespace.id, account.id);
    assert.deepEqual(provider.revoked, ["cred-1"]);
    assert.equal(provider.live.size, 0);
    assert.equal(secrets.has(account.id), false);
    assert.equal(provider.deletedAccounts.length, 1);
  },
);

test(
  "a reclaim whose PostgreSQL session ends during the Secret read leaves a later issuance intact",
  requiresPostgres,
  async (context) => {
    const issuing = await issuanceFixture(context);
    const { account, actor, fixture, issue, namespace, provider, recordedCredentialId, secrets } =
      issuing;
    const { pool } = fixture;
    // A second API process over its own pool: the later issuance must not share this request's
    // transaction context.
    const otherPool = testPool(context, { connectionString: databaseUrl, max: 4 });
    const other = apiController(
      fixture.installation,
      new PostgresPlatformState(otherPool),
      issuing,
    );

    const find = issuing.storage.findServiceAccountCredential;
    let intercept = true;
    issuing.storage.findServiceAccountCredential = async (input) => {
      if (!intercept) {
        return find(input);
      }
      intercept = false;
      // This request holds the account row lock. Find its backend through a probe that waits
      // for that lock, then end the session: PostgreSQL releases the lock.
      const probe = await pool.connect();
      try {
        await probe.query("BEGIN");
        const [probeBackend] = (
          await probe.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows;
        assert.ok(probeBackend);
        const waiting = probe.query(
          "SELECT id FROM occ.service_accounts WHERE id = $1 FOR UPDATE",
          [account.id],
        );
        waiting.catch(() => {});
        const holder = await waitForLockHolder(
          pool,
          probeBackend.pid,
          "the probe to wait for the account lock",
          { timeoutMs: 15_000, intervalMs: 50 },
        );
        assert.equal(typeof holder, "number");
        const [termination] = (
          await pool.query<{ terminated: boolean }>(
            "SELECT pg_terminate_backend($1) AS terminated",
            [holder],
          )
        ).rows;
        assert.equal(termination?.terminated, true);
        await waiting;
        await probe.query("ROLLBACK");
      } finally {
        probe.release();
      }
      // While this request still runs, a later issuance takes the released lock and commits
      // its credential and Secret.
      await other.createServiceAccountCredential(actor.id, namespace.id, account.id);
      // The Secret read returns that committed Secret.
      return find(input);
    };

    // The binding reread after the Secret read runs on the ended session, so this request fails
    // before it can revoke the later issuance's credential or delete its Secret.
    await assert.rejects(issue(), {
      name: "DependencyUnavailableError",
      message: "The selected ServiceAccount Driver is unavailable.",
    });
    assert.equal(intercept, false);
    assert.deepEqual(provider.revoked, []);
    assert.deepEqual([...provider.live], ["cred-1"]);
    assert.equal(secrets.get(account.id)?.credentialId, "cred-1");
    assert.equal(await recordedCredentialId(), "cred-1");
  },
);

type SecretMetadata = {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  uid?: string;
  resourceVersion?: string;
};

type CredentialSecret = {
  apiVersion: string;
  kind: string;
  type: string;
  metadata: SecretMetadata;
  data: { token: unknown };
};

interface CredentialSecretFixtureOptions {
  readonly transformReceipt?: (secret: CredentialSecret) => unknown;
  readonly transformStored?: (secret: CredentialSecret) => CredentialSecret;
}

const credentialIdAnnotation = "openclaw.dev/provider-credential-id";
const unavailableReceipt = {
  name: "DependencyUnavailableError",
  message: "The ServiceAccount credential Secret create outcome could not be confirmed.",
};
const storedIdentity = { uid: "fixture-secret-uid", resourceVersion: "7" };

function credentialSecretCompute(
  {
    namespaceId,
    serviceAccountId,
    credentialId,
    accessToken,
  }: Parameters<CredentialStorage["storeServiceAccountCredential"]>[0],
  options: CredentialSecretFixtureOptions,
  revocations: readonly ProviderRevocation[] = [],
) {
  const sizing = {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "1", memory: "256Mi" },
  };
  const driver = new KubernetesComputeDriver({
    authentication: { mode: "inCluster" },
    images: { gateway: "gateway:fixture", agent: "agent:fixture", requireImmutableDigest: false },
    resources: {
      gateway: sizing,
      agent: sizing,
      namespace: { quota: { pods: "20" }, containerDefaults: sizing },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 18789,
      gatewayTrustedProxyCidrs: ["192.0.2.10/32"],
      gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }],
    },
    servicePrincipalCredentials: { mode: "disabled" },
  });
  const namespace = kubernetesNamespaceName(namespaceId);
  const name = accountSecretName(serviceAccountId);
  const namespacePath = `/api/v1/namespaces/${namespace}`;
  const secretsPath = `${namespacePath}/secrets`;
  const secretPath = `${secretsPath}/${name}`;
  const ownedNamespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": namespaceId,
        "openclaw.dev/gateway-namespace": namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": namespaceId },
    },
    status: { phase: "Active" },
  };
  const manifest = {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": namespaceId,
        "openclaw.dev/service-account": serviceAccountId,
      },
      annotations: {
        "openclaw.dev/namespace-id": namespaceId,
        "openclaw.dev/service-account-id": serviceAccountId,
        [credentialIdAnnotation]: credentialId,
      },
    },
  };
  const requests: { method: string; url: string; status?: number }[] = [];
  const deletions: unknown[] = [];
  const revocationsAtRead: ProviderRevocation[][] = [];
  let stored: CredentialSecret | undefined;
  let storedAtCreate: string | undefined;
  const sdk = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
    "@kubernetes/client-node",
  ) as Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
  const endpoint = "https://127.0.0.1";
  const httpApi = sdk.wrapHttpLibrary({
    async send(request) {
      const method = request.getHttpMethod();
      const attempt: (typeof requests)[number] = { method, url: request.getUrl() };
      requests.push(attempt);
      const url = new URL(attempt.url);
      const headers = request.getHeaders();
      assert.equal(url.origin, endpoint);
      assert.equal(url.username || url.password || url.hash, "");
      assert.equal(
        Object.keys(headers).some((key) => ["authorization", "cookie"].includes(key.toLowerCase())),
        false,
      );
      const rawBody = request.getBody();
      if (method === "GET") {
        assert.equal(rawBody, undefined);
      }
      const respond = (status: number, value: unknown) => {
        const json = JSON.stringify(value);
        assert.ok(typeof json === "string");
        attempt.status = status;
        return new sdk.ResponseContext(
          status,
          { "content-type": "application/json" },
          new sdk.SelfDecodingBody(Promise.resolve(Buffer.from(json))),
        );
      };
      const jsonBody = (): unknown => {
        assert.equal(headers["Content-Type"], "application/json");
        assert.ok(typeof rawBody === "string");
        return JSON.parse(rawBody) as unknown;
      };
      if (method === "GET" && url.pathname === "/api/v1/namespaces") {
        assert.deepEqual([...url.searchParams.keys()].sort(), ["labelSelector", "timeoutSeconds"]);
        assert.equal(
          url.searchParams.get("labelSelector"),
          `openclaw.dev/namespace=${namespaceId}`,
        );
        assert.equal(url.searchParams.get("timeoutSeconds"), "10");
        return respond(200, { apiVersion: "v1", kind: "NamespaceList", items: [ownedNamespace] });
      }
      assert.equal(url.search, "");
      if (method === "GET" && url.pathname === namespacePath) {
        return respond(200, ownedNamespace);
      }
      if (method === "GET" && url.pathname === secretPath) {
        if (stored === undefined) {
          return respond(404, {
            apiVersion: "v1",
            kind: "Status",
            status: "Failure",
            reason: "NotFound",
            code: 404,
          });
        }
        revocationsAtRead.push(structuredClone([...revocations]));
        return respond(200, stored);
      }
      if (method === "POST" && url.pathname === secretsPath) {
        assert.equal(stored, undefined);
        assert.deepEqual(jsonBody(), { ...manifest, stringData: { token: accessToken } });
        const secret: CredentialSecret = {
          ...manifest,
          metadata: { ...manifest.metadata, ...storedIdentity },
          data: { token: Buffer.from(accessToken).toString("base64") },
        };
        stored = options.transformStored?.(structuredClone(secret)) ?? structuredClone(secret);
        storedAtCreate = JSON.stringify(stored);
        const receipt =
          options.transformReceipt === undefined
            ? secret
            : options.transformReceipt(structuredClone(secret));
        return respond(201, receipt);
      }
      if (method === "DELETE" && url.pathname === secretPath) {
        const body = jsonBody();
        deletions.push(body);
        assert.ok(stored);
        const { uid, resourceVersion } = stored.metadata;
        assert.ok(uid && resourceVersion);
        assert.deepEqual(body, { preconditions: { uid, resourceVersion } });
        stored = undefined;
        return respond(200, { apiVersion: "v1", kind: "Status", status: "Success" });
      }
      assert.fail(`Unexpected Kubernetes request ${method} ${url.pathname}`);
    },
  });
  // Replace only the transport beneath the SDK. Check every attempt outside it as well,
  // so a handled transport failure cannot conceal an unexpected request.
  const core = new sdk.CoreV1Api(
    sdk.createConfiguration({ baseServer: new sdk.ServerConfiguration(endpoint, {}), httpApi }),
  );
  Object.defineProperty(driver, "apiClients", { value: Promise.resolve({ core }) });
  const secretTrace = () => {
    assert.deepEqual(
      requests.filter(({ status }) => status === undefined),
      [],
    );
    return requests
      .filter(({ url }) => [secretsPath, secretPath].includes(new URL(url).pathname))
      .map(({ method, status }) => `${method} ${status}`);
  };
  return {
    driver,
    secretTrace,
    deletions,
    revocationsAtRead,
    readStored: () => stored,
    storedAtCreate: () => storedAtCreate,
  };
}

async function managedIssuancePost(
  context: TestContext,
  { account, controller, fixture, namespace }: Awaited<ReturnType<typeof issuanceFixture>>,
) {
  const { installation, state } = fixture;
  const credentials = await createTestAuthPrincipal({ installationId: installation.id });
  await state.seedNativeIAM({
    identities: [credentials.seed.principal],
    roles: credentials.seed.roles.map((role) => ({
      ...role,
      name: `ServiceAccount receipt test ${randomUUID()}`,
    })),
    bindings: credentials.seed.bindings,
    memberships: [],
    groups: [],
    restrictions: [],
  });
  const iamDriver = controller.selectedDriver("iam");
  assert.equal(iamDriver.capability, "iam");
  const origin = "https://console.oce.localhost";
  const app = createFastifyApp({
    controller,
    iamDriver,
    auth: credentials.auth,
    resolveHarness: () => assert.fail("Unexpected Harness lookup"),
    auditSink: state.auditSink,
    development: { enabled: true, installationId: installation.id, browserOrigin: origin },
  });
  context.after(async () => app.close());
  const session = await signInToControllerApp(app, credentials, { origin });
  return () =>
    app.inject({
      method: "POST",
      url: `/namespaces/${namespace.id}/service-accounts/${account.id}/credentials`,
      remoteAddress: "127.0.0.1",
      headers: authenticatedHeaders(session, {
        host: new URL(origin).host,
        "content-type": "application/json",
      }),
      payload: "{}",
    });
}

test("Kubernetes Compute validates successful ServiceAccount credential Secret receipts", async () => {
  const namespaceId = `ns_${randomUUID()}`;
  const input = {
    namespaceId,
    serviceAccountId: `sa_${randomUUID()}`,
    credentialId: "cred-fixture",
    accessToken: "synthetic-token-fixture",
  };
  const name = accountSecretName(input.serviceAccountId);
  const valid = credentialSecretCompute(input, {});
  assert.deepEqual(await valid.driver.storeServiceAccountCredential(input), { name, key: "token" });
  assert.deepEqual(valid.secretTrace(), ["GET 404", "POST 201"]);

  const transforms: Record<
    string,
    NonNullable<CredentialSecretFixtureOptions["transformReceipt"]>
  > = {
    body: () => null,
    kind: (secret) => ({ ...secret, kind: "ConfigMap" }),
    namespace: (secret) => ({ ...secret, metadata: { ...secret.metadata, namespace: "wrong" } }),
    name: (secret) => ({ ...secret, metadata: { ...secret.metadata, name: "wrong" } }),
    owner: (secret) => ({ ...secret, metadata: { ...secret.metadata, labels: {} } }),
    "credential ID": (secret) => {
      secret.metadata.annotations[credentialIdAnnotation] = "cred-other";
      return secret;
    },
    token: (secret) => ({ ...secret, data: { token: Buffer.from("wrong").toString("base64") } }),
    "non-string token": (secret) => ({
      ...secret,
      data: { token: [...Buffer.from(String(secret.data.token))] },
    }),
    uid: (secret) => ({ ...secret, metadata: { ...secret.metadata, uid: "" } }),
    resourceVersion: (secret) => ({
      ...secret,
      metadata: { ...secret.metadata, resourceVersion: "" },
    }),
  };
  for (const [field, transformReceipt] of Object.entries(transforms)) {
    const invalid = credentialSecretCompute(input, { transformReceipt });
    await assert.rejects(
      invalid.driver.storeServiceAccountCredential(input),
      unavailableReceipt,
      field,
    );
    assert.deepEqual(invalid.secretTrace(), ["GET 404", "POST 201"], field);
    assert.ok(invalid.readStored(), field);
  }
});

test(
  "managed HTTP issuance binds the exact Kubernetes credential Secret receipt",
  requiresPostgres,
  async (context) => {
    const issuing = await issuanceFixture(context, {});
    const { kubernetes, provider, recordedCredentialId, controller, actor, namespace, account } =
      issuing;
    assert.ok(kubernetes);
    assert.equal(controller.selectedDriver("compute"), kubernetes.driver);
    const issue = await managedIssuancePost(context, issuing);
    const response = await issue();
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json<{ data: { credential?: { kind: string } } }>().data.credential, {
      kind: "access_token",
    });
    assert.equal(response.body.includes("synthetic-token-1"), false);
    assert.equal(await recordedCredentialId(), "cred-1");
    assert.equal(provider.issued, 1);
    assert.deepEqual([...provider.live], ["cred-1"]);
    assert.deepEqual(provider.revoked, []);
    assert.deepEqual(kubernetes.secretTrace(), ["GET 404", "GET 404", "POST 201"]);
    const stored = kubernetes.readStored();
    assert.ok(stored);
    assert.equal(stored.metadata.annotations[credentialIdAnnotation], "cred-1");
    assert.equal(stored.data.token, Buffer.from("synthetic-token-1").toString("base64"));
    assert.deepEqual(
      (await controller.getServiceAccount(actor.id, namespace.id, account.id)).credential,
      {
        kind: "access_token",
        secretRef: { name: stored.metadata.name, key: "token" },
      },
    );
  },
);

test(
  "managed HTTP issuance compensates a transformed Kubernetes create receipt by exact readback",
  requiresPostgres,
  async (context) => {
    const cases = [
      { transformStored: (secret: CredentialSecret) => secret, expectDelete: true },
      {
        transformStored: (secret: CredentialSecret) => ({
          ...secret,
          data: { token: Buffer.from("other").toString("base64") },
        }),
        expectDelete: false,
      },
      {
        transformStored: (secret: CredentialSecret) => ({
          ...secret,
          metadata: { ...secret.metadata, uid: "" },
        }),
        expectDelete: false,
      },
    ];
    for (const { transformStored, expectDelete } of cases) {
      const issuing = await issuanceFixture(context, {
        transformReceipt: (secret) => ({
          ...secret,
          metadata: { ...secret.metadata, uid: "response-only-uid", resourceVersion: "99" },
          data: { token: Buffer.from("response-only").toString("base64") },
        }),
        transformStored,
      });
      const { kubernetes, provider, recordedCredentialId, controller, actor, namespace, account } =
        issuing;
      assert.ok(kubernetes);
      assert.equal(controller.selectedDriver("compute"), kubernetes.driver);
      const issue = await managedIssuancePost(context, issuing);
      const query = context.mock.method(issuing.fixture.state, "queryInTransaction");
      const response = await issue();
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(
        response.json<{ error: { code: string } }>().error.code,
        "DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(response.body.includes("synthetic-token-1"), false);
      assert.equal(response.body.includes("response-only-uid"), false);
      assert.equal(
        query.mock.calls.some(({ arguments: [, statement] }) =>
          statement.includes("UPDATE occ.service_account_driver_bindings"),
        ),
        false,
      );
      assert.equal(await recordedCredentialId(), null);
      assert.equal(
        (await controller.getServiceAccount(actor.id, namespace.id, account.id)).credential,
        undefined,
      );
      assert.equal(provider.issued, 1);
      const binding = await issuing.fixture.pool.query<{ external_account_id: string }>(
        `SELECT external_account_id FROM occ.service_account_driver_bindings
         WHERE service_account_id = $1 AND namespace_id = $2`,
        [account.id, namespace.id],
      );
      const providerAccountId = binding.rows[0]?.external_account_id;
      assert.ok(providerAccountId);
      const expectedRevocations = [{ accountId: providerAccountId, credentialId: "cred-1" }];
      assert.deepEqual(provider.revocations, expectedRevocations);
      assert.equal(provider.live.size, 0);
      assert.deepEqual(kubernetes.revocationsAtRead, [expectedRevocations, expectedRevocations]);
      assert.deepEqual(kubernetes.secretTrace(), [
        "GET 404",
        "GET 404",
        "POST 201",
        "GET 200",
        "GET 200",
        ...(expectDelete ? ["DELETE 200"] : []),
      ]);
      if (expectDelete) {
        assert.deepEqual(kubernetes.deletions, [{ preconditions: storedIdentity }]);
        assert.equal(kubernetes.readStored(), undefined);
      } else {
        const stored = kubernetes.readStored();
        assert.ok(stored);
        assert.equal(JSON.stringify(stored), kubernetes.storedAtCreate());
      }
    }
  },
);

test(
  "unknown managed issuance COMMIT retains an exact Kubernetes credential Secret",
  requiresPostgres,
  async (context) => {
    const { kubernetes, provider, recordedCredentialId, abandonIssuance } = await issuanceFixture(
      context,
      {},
    );
    assert.ok(kubernetes);
    await abandonIssuance();
    assert.equal(await recordedCredentialId(), null);
    assert.equal(kubernetes.readStored()?.metadata.annotations[credentialIdAnnotation], "cred-1");
    assert.deepEqual([...provider.live], ["cred-1"]);
    assert.deepEqual(provider.revoked, []);
    assert.deepEqual(kubernetes.secretTrace(), ["GET 404", "GET 404", "POST 201"]);
  },
);
