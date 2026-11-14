import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { Installation } from "../../packages/contracts/src/index.ts";
import { createBootstrapAdministratorSeed, NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  createPostgresPool,
  OpenClawController,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { kubernetesRequest } from "../../apps/controller/src/drivers/kubernetes/request.ts";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  explicitK3dSelection,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";

const requested = process.env.OCC_TEST_KUBERNETES_CONFIGURATION === "1";
const origin = "https://console.oce.localhost";
const runId = randomUUID();
const namespace = "oce-private-create-" + runId.slice(0, 12);
const ownerLabel = "openclaw.dev/test-run";
const authSecret = "private-real-auth-" + randomUUID();
const administrator = {
  email: "private-real-" + randomUUID() + "@example.test",
  password: "private-real-auth-" + randomUUID(),
};
const manual = {
  displayName: "Private real API registration",
  mode: "manual",
  issuer: "https://accounts.example.test",
  authorizationUrl: "https://accounts.example.test/authorize",
  tokenUrl: "https://accounts.example.test/token",
  scopes: ["mail.read"],
  destinations: [{ host: "mail.example.test", path: "/v1/**" }],
};
const authOptions = (installationId: string) => ({
  mode: "development" as const,
  installationId,
  baseURL: origin,
  agentDomain: "agents.oce.localhost",
  secret: authSecret,
});

async function clients(
  authentication: ConstructorParameters<typeof KubernetesSecretDriver>[0]["authentication"],
) {
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    authentication,
    () => new Error("The selected Kubernetes client configuration is invalid."),
  );
  return {
    core: new sdk.CoreV1Api(clientConfiguration),
    corePrototype: sdk.CoreV1Api.prototype,
    authorization: new sdk.AuthorizationV1Api(clientConfiguration),
  };
}
type Core = Awaited<ReturnType<typeof clients>>["core"];
type CreateRequest = Parameters<Core["createNamespacedSecret"]>[0];
type DeleteRequest = Parameters<Core["deleteNamespacedSecret"]>[0];
type SecretObject = Awaited<ReturnType<Core["readNamespacedSecret"]>>;
type Identity = { name: string; uid: string; resourceVersion: string };
type Scenario = "refused-create" | "denied-registration" | "replacement-uid" | "newer-version";
type Attempt = {
  scenario: Scenario;
  original?: Identity;
  survivor?: Identity;
  body?: CreateRequest["body"];
  conflictStatus?: number | undefined;
  deletes: number;
};

function identity(object: {
  metadata?: { name?: string; uid?: string; resourceVersion?: string };
}): Identity {
  const { name, uid, resourceVersion } = object.metadata ?? {};
  assert.ok(name && uid && resourceVersion, "Kubernetes must return complete object identity");
  return { name, uid, resourceVersion };
}
function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  for (const key of ["code", "statusCode", "status"] as const) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }
  return undefined;
}
class RequestNotSentError extends Error {}

function checkpoint(value: Record<string, string | number | boolean | null>) {
  writeSync(
    2,
    "PRIVATE_CREATE_REAL_API " +
      JSON.stringify({ at: new Date().toISOString(), namespace, ...value }) +
      "\n",
  );
}
function observation(t: TestContext, value: Record<string, string | number | boolean | null>) {
  t.diagnostic("PRIVATE_CREATE_REAL_API " + JSON.stringify(value));
}

test(
  "real Kubernetes API enforces Installation-private create compensation and authorization",
  {
    skip: requested ? false : "Select the disposable k3d-fixture-configuration lane.",
    timeout: 180_000,
  },
  async (t) => {
    const selection = explicitK3dSelection();
    const configuration = await validateExplicitK3dLoopbackContext(selection);
    assert.notEqual(
      configuration.clusters[0].cluster["insecure-skip-tls-verify"],
      true,
      "certificate verification must remain enabled",
    );
    assert.ok(databaseUrl, "a dedicated migrated PostgreSQL database is required");
    const database = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
    assert.match(database.pathname, /^\/openclaw_k8s_[a-z0-9_]+$/);
    assert.ok(selection.kubeconfigPath && selection.kubernetesContext);
    const authentication = {
      mode: "kubeconfig" as const,
      kubeconfigPath: selection.kubeconfigPath,
      context: selection.kubernetesContext,
    };
    const { core, corePrototype, authorization } = await clients(authentication);
    const pending = new Set<string>();
    const unknown = new Set<string>();
    const retained = new Map<string, Identity>();
    const teardown: {
      ownedNamespace?: Identity;
      closeApplication?: () => Promise<void>;
      closeDatabase?: () => Promise<void>;
    } = {};
    let attempt: Attempt | undefined;
    let driverMutations = 0;

    // Observer and setup calls use the production deadline wrapper in single-attempt
    // mode, including reads. Never include an SDK error body: a Kubernetes response can contain Secret data.
    // A write without a definitive rejection keeps teardown from replaying or deleting it.
    async function api<T>(
      phase: string,
      mutating: boolean,
      operation: () => Promise<T>,
      target: Record<string, string | number | boolean | null> = {},
    ): Promise<T> {
      assert.equal(unknown.size, 0, "an unknown write outcome requires separate reconciliation");
      const operationId = phase + ":" + (target.name ?? namespace);
      if (mutating) {
        pending.add(operationId);
      }
      checkpoint({ phase, ...target, state: "started", mutating });
      try {
        const result = await kubernetesRequest(
          operation,
          {
            cancelled: () => new Error("Kubernetes operation cancelled."),
            timedOut: () => new Error("Kubernetes operation timed out."),
            deadlineElapsed: () => new RequestNotSentError("Kubernetes operation was not sent."),
            failed: (error) => error,
          },
          { mutating: true },
        );
        checkpoint({ phase, ...target, state: "returned", mutating });
        return result;
      } catch (error) {
        const code = errorStatus(error);
        if (
          mutating &&
          !(error instanceof RequestNotSentError) &&
          ![400, 401, 403, 404, 409, 422].includes(code ?? 0)
        ) {
          unknown.add(operationId);
        }
        checkpoint({
          phase,
          ...target,
          state: "failed",
          status: code ?? null,
          outcomeUnknown: unknown.size > 0,
        });
        throw Object.assign(
          new Error("Kubernetes " + phase + " failed."),
          code === undefined ? {} : { code },
        );
      } finally {
        pending.delete(operationId);
      }
    }
    const create = core.createNamespacedSecret;
    const read = core.readNamespacedSecret.bind(core);
    const replace = core.replaceNamespacedSecret;
    const remove = core.deleteNamespacedSecret;
    const list = core.listNamespacedSecret.bind(core);
    const readSecret = (name: string) =>
      api("secret-read", false, () => read({ namespace, name }), { name });
    const inventory = async () =>
      (await api("secret-inventory", false, () => list({ namespace }))).items
        .map(identity)
        .sort((a, b) => a.name.localeCompare(b.name));
    async function storeSecret(
      request: CreateRequest,
      options?: Parameters<Core["createNamespacedSecret"]>[1],
      client: Core = core,
    ) {
      assert.equal(request.namespace, namespace);
      assert.match(request.body.metadata?.name ?? "", /^occ-private-[a-f0-9]{40}$/);
      const stored = await api("secret-create", true, () => create.call(client, request, options), {
        name: request.body.metadata?.name ?? null,
      });
      const current = identity(stored);
      retained.set(current.name, current);
      return stored;
    }
    async function updateSecret(
      request: Parameters<Core["replaceNamespacedSecret"]>[0],
      options?: Parameters<Core["replaceNamespacedSecret"]>[1],
      client: Core = core,
    ) {
      assert.equal(request.namespace, namespace);
      const stored = await api(
        "secret-update",
        true,
        () => replace.call(client, request, options),
        {
          name: request.name,
          resourceVersion: request.body.metadata?.resourceVersion ?? null,
        },
      );
      const current = identity(stored);
      retained.set(current.name, current);
      return stored;
    }
    async function deleteSecret(
      request: DeleteRequest,
      options?: Parameters<Core["deleteNamespacedSecret"]>[1],
      client: Core = core,
    ) {
      assert.equal(request.namespace, namespace);
      const result = await api("secret-delete", true, () => remove.call(client, request, options), {
        name: request.name,
        uid: request.body?.preconditions?.uid ?? null,
        resourceVersion: request.body?.preconditions?.resourceVersion ?? null,
      });
      retained.delete(request.name);
      return result;
    }
    const deleteIdentity = (current: Identity) =>
      deleteSecret({
        namespace,
        name: current.name,
        body: { preconditions: { uid: current.uid, resourceVersion: current.resourceVersion } },
      });

    // Register teardown before the first mutation. Unknown or still-running writes
    // retain the exact namespace for an operator; successful tests delete only known UIDs.
    t.after(
      async () => {
        const hadPendingWrite = pending.size > 0;
        await teardown.closeApplication?.();
        await teardown.closeDatabase?.();
        if (hadPendingWrite || unknown.size > 0 || pending.size > 0) {
          observation(t, {
            phase: "cleanup",
            state: "held",
            namespace,
            unknownWrites: unknown.size,
            unknownOperations: [...unknown].join(","),
            pendingWrites: pending.size,
            pendingOperations: [...pending].join(","),
          });
          return;
        }
        if (teardown.ownedNamespace === undefined) {
          return;
        }
        const currentNamespace = await api("namespace-read", false, () =>
          core.readNamespace({ name: namespace }),
        );
        assert.equal(identity(currentNamespace).uid, teardown.ownedNamespace.uid);
        assert.equal(currentNamespace.metadata?.labels?.[ownerLabel], runId);
        const currentSecrets = await inventory();
        assert.deepEqual(
          currentSecrets,
          [...retained.values()].sort((a, b) => a.name.localeCompare(b.name)),
          "cleanup may delete only the exact objects observed by this test",
        );
        for (const current of currentSecrets) {
          await deleteIdentity(current);
        }
        assert.equal((await inventory()).length, 0);
        const current = identity(
          await api("namespace-read", false, () => core.readNamespace({ name: namespace })),
        );
        assert.equal(current.uid, teardown.ownedNamespace.uid);
        await api("namespace-delete", true, () =>
          core.deleteNamespace({
            name: namespace,
            body: { preconditions: { uid: current.uid, resourceVersion: current.resourceVersion } },
          }),
        );
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            const observed = await api("namespace-read", false, () =>
              core.readNamespace({ name: namespace }),
            );
            assert.equal(identity(observed).uid, teardown.ownedNamespace.uid);
          } catch (error) {
            if (errorStatus(error) === 404) {
              observation(t, { phase: "cleanup", state: "complete", namespace });
              return;
            }
            throw error;
          }
          await delay(200);
        }
        throw new Error("The owned namespace still exists after bounded cleanup.");
      },
      { timeout: 60_000 },
    );

    const pool = await createPostgresPool(databaseUrl);
    teardown.closeDatabase = () => pool.end();
    const state = new PostgresPlatformState(pool);
    assert.equal(
      await state.loadInstallation(),
      undefined,
      "the file requires its own fresh database",
    );
    const role = await pool.query(
      "SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname=current_user",
    );
    assert.equal(role.rows[0].role, "occ_app");
    assert.equal(role.rows[0].rolsuper, false);

    // Authorization is inventoried before effects. The context is the explicitly
    // selected disposable cluster; this does not alter the user's current context.
    for (const [resource, verbs] of [
      ["namespaces", ["create", "get", "delete"]],
      ["secrets", ["create", "get", "list", "update", "delete"]],
    ] as const) {
      for (const verb of verbs) {
        const result = await api("permission-check", false, () =>
          authorization.createSelfSubjectAccessReview({
            body: {
              apiVersion: "authorization.k8s.io/v1",
              kind: "SelfSubjectAccessReview",
              spec: {
                resourceAttributes: {
                  group: "",
                  resource,
                  verb,
                  ...(resource === "secrets" ? { namespace } : {}),
                  ...(resource === "namespaces" && verb !== "create" ? { name: namespace } : {}),
                },
              },
            },
          }),
        );
        assert.equal(result.status?.allowed, true, "required disposable-cluster permission");
      }
    }
    teardown.ownedNamespace = identity(
      await api("namespace-create", true, () =>
        core.createNamespace({
          body: { metadata: { name: namespace, labels: { [ownerLabel]: runId } } },
        }),
      ),
    );
    observation(t, { phase: "namespace-owned", namespace, uid: teardown.ownedNamespace.uid });

    const installation: Installation = {
      id: "ins_" + randomUUID(),
      name: "Private registration real Kubernetes API",
      createdAt: new Date().toISOString(),
    };
    const bootstrapAuth = await createPostgresControllerAuth({
      ...authOptions(installation.id),
      pool,
    });
    const account = await bootstrapAuth.createAccount({
      ...administrator,
      name: "Registration administrator",
    });
    const seed = createBootstrapAdministratorSeed(installation.id, bootstrapAuth.issuer, account);
    state.setBootstrapNativeIAM({
      identities: [seed.principal, seed.servicePrincipal],
      groups: [],
      memberships: [],
      roles: seed.roles,
      bindings: seed.bindings,
      restrictions: [],
    });
    const controller = new OpenClawController(installation, { state });
    const iam = new NativeIAMDriver(state);
    controller.registerDriver(iam);
    controller.selectDriver("iam", iam.id);
    await controller.createNamespace(seed.principal.id, { name: "Default" });
    const driver = new KubernetesSecretDriver(
      { authentication },
      { id: "private-real-kubernetes", installationSecretNamespace: namespace },
    );
    controller.registerDriver(driver);
    controller.selectDriver("secret", driver.id);
    const auth = await createPostgresControllerAuth({
      ...authOptions(installation.id),
      pool,
      state,
      iamDriver: iam,
    });
    const app = createFastifyApp({
      controller,
      iamDriver: iam,
      resolveHarness: resolveApprovedHarness,
      auditSink: state.auditSink,
      auth,
      development: { enabled: true, installationId: installation.id, browserOrigin: origin },
    });
    teardown.closeApplication = () => app.close();
    const baseHeaders = { origin, host: new URL(origin).host, "content-type": "application/json" };
    async function signIn(credentials: typeof administrator) {
      const result = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: baseHeaders,
        payload: JSON.stringify(credentials),
      });
      assert.equal(result.statusCode, 200);
      const cookies = result.headers["set-cookie"];
      const cookie = (Array.isArray(cookies) ? cookies : [cookies])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.split(";")[0])
        .join("; ");
      assert.ok(cookie);
      return { ...baseHeaders, cookie };
    }
    const administratorHeaders = await signIn(administrator);
    function inject(
      method: "GET" | "POST",
      url: string,
      payload?: unknown,
      headers = administratorHeaders,
    ) {
      return app.inject({
        method,
        url,
        headers:
          payload === undefined
            ? Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "content-type"))
            : headers,
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    }
    async function input() {
      const draft = await inject("POST", "/connection-templates", manual);
      assert.equal(draft.statusCode, 201);
      return {
        connectionTemplateId: draft.json<{ data: { id: string } }>().data.id,
        connectionTemplateVersion: 1,
        displayName: "Private real API client",
        clientId: randomUUID(),
        tokenEndpointAuthMethod: "client_secret_basic" as const,
        clientSecret: "invented-noncredential-" + randomUUID(),
      };
    }
    async function assertHidden(
      value: Awaited<ReturnType<typeof input>>,
      response: { body: string },
    ) {
      assert.equal(response.body.includes(value.clientSecret), false);
      assert.equal(response.body.includes(driver.id), false);
      const listed = await inject("GET", "/oauth-clients");
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.body.includes(value.clientSecret), false);
      assert.equal(listed.body.includes(driver.id), false);
      assert.equal(
        listed
          .json<{ data: Array<{ clientId: string }> }>()
          .data.some((entry) => entry.clientId === value.clientId),
        false,
      );
      const audit = await pool.query("SELECT details FROM occ.audit_events");
      assert.equal(JSON.stringify(audit.rows).includes(value.clientSecret), false);
    }

    // The Driver constructs its normal SDK client. Only these transport methods
    // are interposed; original methods perform every API write and enforce preconditions.
    t.mock.method(
      corePrototype,
      "createNamespacedSecret",
      async function (this: Core, ...args: Parameters<Core["createNamespacedSecret"]>) {
        driverMutations += 1;
        assert.ok(attempt);
        const [request, options] = args;
        // Immutable is a normal, server-stored Secret property refused by the
        // existing private registration contract. Return the actual API response.
        attempt.body = { ...request.body, immutable: true };
        const stored = await storeSecret({ ...request, body: attempt.body }, options, this);
        attempt.original = identity(stored);
        return stored;
      },
    );
    t.mock.method(
      corePrototype,
      "replaceNamespacedSecret",
      async function (this: Core, ...args: Parameters<Core["replaceNamespacedSecret"]>) {
        driverMutations += 1;
        return updateSecret(args[0], args[1], this);
      },
    );
    t.mock.method(
      corePrototype,
      "deleteNamespacedSecret",
      async function (this: Core, ...args: Parameters<Core["deleteNamespacedSecret"]>) {
        driverMutations += 1;
        assert.ok(attempt?.original && attempt.body);
        attempt.deletes += 1;
        const [request, options] = args;
        const original = attempt.original;
        assert.equal(request.name, original.name);
        assert.deepEqual(request.body?.preconditions, {
          uid: original.uid,
          resourceVersion: original.resourceVersion,
        });
        if (attempt.scenario === "replacement-uid") {
          await deleteIdentity(original);
          attempt.survivor = identity(await storeSecret({ namespace, body: attempt.body }));
          assert.notEqual(attempt.survivor.uid, original.uid);
        } else if (attempt.scenario === "newer-version") {
          const current: SecretObject = await readSecret(original.name);
          attempt.survivor = identity(
            await updateSecret({
              namespace,
              name: original.name,
              body: {
                ...current,
                metadata: {
                  ...current.metadata,
                  annotations: {
                    ...current.metadata?.annotations,
                    "openclaw.dev/proof-version": "newer",
                  },
                },
              },
            }),
          );
          assert.equal(attempt.survivor.uid, original.uid);
          assert.notEqual(attempt.survivor.resourceVersion, original.resourceVersion);
        }
        try {
          return await deleteSecret(request, options, this);
        } catch (error) {
          attempt.conflictStatus = errorStatus(error);
          throw error;
        }
      },
    );

    for (const scenario of [
      "refused-create",
      "denied-registration",
      "replacement-uid",
      "newer-version",
    ] as const) {
      await t.test(scenario, async (s) => {
        assert.equal(unknown.size, 0, "do not start another effect after an unknown write");
        attempt = { scenario, deletes: 0 };
        const value = await input();
        const before = await inventory();
        const mutationsBefore = driverMutations;
        let headers = administratorHeaders;
        if (scenario === "denied-registration") {
          const credentials = {
            email: "private-reader-" + randomUUID() + "@example.test",
            password: "private-real-auth-" + randomUUID(),
          };
          const reader = await auth.createAccount({ ...credentials, name: "Reader" });
          await state.appendNativeIAMPrincipal(auth.principalSeed(reader, { grant: "none" }));
          headers = await signIn(credentials);
        }
        const response = await inject("POST", "/oauth-clients", value, headers);
        const expectedStatus = {
          "denied-registration": 403,
          "refused-create": 404,
          "replacement-uid": 503,
          "newer-version": 503,
        }[scenario];
        assert.equal(response.statusCode, expectedStatus);
        await assertHidden(value, response);
        const reserved = (
          await pool.query<{ hidden: boolean; driver: string }>(
            "SELECT cleanup_after IS NOT NULL AS hidden, secret_driver_id AS driver FROM occ.oauth_clients WHERE client_id=$1",
            [value.clientId],
          )
        ).rows;
        if (scenario === "denied-registration") {
          assert.equal(
            driverMutations,
            mutationsBefore,
            "denied IAM registration makes no backend mutation",
          );
          assert.deepEqual(await inventory(), before);
          assert.equal(reserved.length, 0);
          observation(s, {
            scenario,
            status: response.statusCode,
            backendMutations: 0,
            inventoryUnchanged: true,
          });
          return;
        }
        assert.ok(attempt.original);
        assert.deepEqual(reserved, [{ hidden: true, driver: driver.id }]);
        assert.equal(attempt.deletes, 1);
        const expectedCode = scenario === "refused-create" ? "NOT_FOUND" : "DEPENDENCY_UNAVAILABLE";
        assert.equal(response.json<{ error: { code: string } }>().error.code, expectedCode);
        if (scenario === "refused-create") {
          await assert.rejects(
            readSecret(attempt.original.name),
            (error: unknown) => errorStatus(error) === 404,
          );
          observation(s, {
            scenario,
            status: response.statusCode,
            conditionalDeletes: 1,
            objectAbsent: true,
          });
        } else {
          assert.equal(
            attempt.conflictStatus,
            409,
            "the real API must enforce the stale delete preconditions",
          );
          assert.ok(attempt.survivor);
          assert.deepEqual(identity(await readSecret(attempt.original.name)), attempt.survivor);
          observation(s, {
            scenario,
            status: response.statusCode,
            deleteStatus: 409,
            survivorUid: attempt.survivor.uid,
            survivorResourceVersion: attempt.survivor.resourceVersion,
          });
        }
      });
    }
  },
);
