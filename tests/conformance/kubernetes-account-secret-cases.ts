import { ChatGPTClient } from "../../apps/controller/src/backends/chatgpt.ts";
import type {
  AgentRevision,
  ComputeRevisionContext,
  HarnessAuthSnapshot,
  ResolvedHarnessAuth,
  ServiceAccount,
} from "../../packages/contracts/src/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { TestContext } from "node:test";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  DependencyUnavailableError,
  OpenClawController,
  PostgresPlatformState,
  ResourceConflictError,
  ResourceStateConflictError,
  ServiceAccountCredentialSecretExistsError,
} from "../../packages/occ/src/index.ts";
import { EMBEDDED_API_KEY_REQUIRED } from "../helpers/refusal-text.mjs";
import {
  admitRevisionHarness,
  apiKeyAuth,
  authContext,
  options,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

type WorkspaceFixture = ReturnType<typeof workspaceSetupFixture>;
type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type DeleteSecretRequest = Parameters<
  InstanceType<KubernetesSdk["CoreV1Api"]>["deleteNamespacedSecret"]
>[0];
type SecretPreconditions = NonNullable<DeleteSecretRequest["body"]>["preconditions"];
type Deployment = Awaited<
  ReturnType<InstanceType<KubernetesSdk["AppsV1Api"]>["readNamespacedDeployment"]>
>;
type SecretMutation = (secret: ReturnType<typeof storedSecret>) => void;

function storedSecret(objects: WorkspaceFixture["objects"], key: string) {
  const secret = objects.get(key);
  assert.ok(secret?.metadata.annotations && secret.metadata.labels && secret.data);
  return {
    metadata: secret.metadata,
    annotations: secret.metadata.annotations,
    labels: secret.metadata.labels,
    data: secret.data,
  };
}

function credentialSecretTransport(clients: WorkspaceFixture["clients"]) {
  const { core } = clients;
  // The workspace transport installs these two Secret methods dynamically.
  assert.ok("readNamespacedSecret" in core && typeof core.readNamespacedSecret === "function");
  assert.ok("createNamespacedSecret" in core && typeof core.createNamespacedSecret === "function");
  return core as typeof core & {
    readNamespacedSecret: typeof core.readNamespace;
    createNamespacedSecret: typeof clients.apps.patchNamespacedDeployment;
  };
}

export async function checkAccountSecretInput() {
  const driver = createKubernetesComputeDriver(options());
  let clusterAccesses = 0;
  driver["createClients"] = async () => {
    clusterAccesses += 1;
    assert.fail("invalid account credentials must be refused before cluster access");
  };
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;

  for (const invalid of [
    { namespaceId: "", serviceAccountId, credentialId: "cred", accessToken: "token" },
    { namespaceId: tenant.id, serviceAccountId: "", credentialId: "cred", accessToken: "token" },
    { namespaceId: tenant.id, serviceAccountId, credentialId: "", accessToken: "token" },
    { namespaceId: tenant.id, serviceAccountId, credentialId: "cred", accessToken: "" },
  ]) {
    // Incomplete account credentials cannot trigger Kubernetes requests or Secret mutations.
    await assert.rejects(driver.storeServiceAccountCredential(invalid), /must be explicitly/i);
  }

  for (const secretRef of [
    { name: "another-account-secret", key: "token" },
    { name: secretName, key: "another-key" },
  ]) {
    // Rollback and deletion are restricted to the deterministic Secret owned by this account.
    await assert.rejects(
      driver.deleteServiceAccountCredential({
        namespaceId: tenant.id,
        serviceAccountId,
        secretRef,
      }),
      /another ServiceAccount/i,
    );
  }
  assert.equal(clusterAccesses, 0);
}

export async function checkUnconfirmedAccountSecretCreate(t: TestContext) {
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const input = {
    namespaceId: tenant.id,
    serviceAccountId,
    credentialId: "cred-request-fixture",
    accessToken: "at-request-fixture",
  };
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;
  const secretRef = { name: secretName, key: "token" };
  const dropped = Object.assign(new Error("dropped"), { statusCode: 500 });
  const unconfirmed = (error: unknown) =>
    error instanceof DependencyUnavailableError &&
    error.message === "The ServiceAccount credential Secret create outcome could not be confirmed.";
  // Faults injected around the fixture's in-memory Secret calls.
  const harness = ({
    applied,
    mutate,
    readStatus,
    deleteStatus,
  }: {
    applied: boolean;
    mutate?: SecretMutation;
    readStatus?: number;
    deleteStatus?: number;
  }) => {
    const { driver, namespace, objects, clients } = workspaceSetupFixture(false);
    const core = credentialSecretTransport(clients);
    const key = `Secret:${namespace}:${secretName}`;
    const calls: { creates: number; reads: number; deletes: SecretPreconditions[] } = {
      creates: 0,
      reads: 0,
      deletes: [],
    };
    const create = core.createNamespacedSecret;
    core.createNamespacedSecret = async (request) => {
      calls.creates += 1;
      if (applied) {
        await create(request);
        mutate?.(storedSecret(objects, key));
      }
      throw dropped;
    };
    const read = core.readNamespacedSecret;
    core.readNamespacedSecret = async (request) => {
      if (calls.creates > 0 && request.name === secretName) {
        calls.reads += 1;
        if (readStatus !== undefined) {
          throw Object.assign(new Error("read failed"), { statusCode: readStatus });
        }
      }
      return read(request);
    };
    const remove = core.deleteNamespacedSecret;
    core.deleteNamespacedSecret = async (request) => {
      calls.deletes.push(request.body?.preconditions);
      if (deleteStatus !== undefined) {
        throw Object.assign(new Error("delete failed"), { statusCode: deleteStatus });
      }
      return remove(request);
    };
    return { driver, namespace, objects, key, calls };
  };

  await t.test("applied, reply lost: the exact Secret confirms storage and stays", async () => {
    const { driver, objects, key, calls } = harness({ applied: true });
    assert.deepEqual(await driver.storeServiceAccountCredential(input), secretRef);
    assert.equal(calls.creates, 1);
    assert.equal(calls.reads, 1);
    const stored = storedSecret(objects, key);
    assert.equal(stored.metadata.uid, `${secretName}-uid`);
    assert.equal(stored.metadata.resourceVersion, "1");
    assert.equal(stored.annotations["openclaw.dev/provider-credential-id"], input.credentialId);
    assert.ok(stored.data.token);
    assert.equal(Buffer.from(stored.data.token, "base64").toString(), input.accessToken);
    // Only the ServiceAccount Driver can confirm provider revocation before exact cleanup.
    assert.deepEqual(
      await driver.findServiceAccountCredential({ namespaceId: tenant.id, serviceAccountId }),
      {
        secretNamespace: key.split(":")[1],
        secretRef,
        credentialId: input.credentialId,
      },
    );
    assert.deepEqual(calls.deletes, []);
  });

  await t.test("never applied: nothing is deleted and the create keeps its error", async () => {
    const { driver, objects, key, calls } = harness({ applied: false });
    await assert.rejects(driver.storeServiceAccountCredential(input), (error) => error === dropped);
    assert.equal(objects.has(key), false);
    assert.deepEqual(calls, { creates: 1, reads: 1, deletes: [] });
  });

  for (const [name, mutate] of [
    [
      "a foreign owner annotation",
      (stored) => {
        stored.annotations["openclaw.dev/service-account-id"] = "sa_another";
      },
    ],
    [
      "a foreign owner label",
      (stored) => {
        stored.labels["openclaw.dev/service-account"] = "sa_another";
      },
    ],
    [
      "another token",
      (stored) => {
        stored.data.token = Buffer.from("at-another-request").toString("base64");
      },
    ],
    [
      "another provider credential ID",
      (stored) => {
        stored.annotations["openclaw.dev/provider-credential-id"] = "cred-another";
      },
    ],
    [
      "no provider credential ID",
      (stored) => {
        delete stored.annotations["openclaw.dev/provider-credential-id"];
      },
    ],
  ] satisfies [string, SecretMutation][]) {
    await t.test(`an object with ${name} is kept and the create keeps its error`, async () => {
      const { driver, objects, key, calls } = harness({ applied: true, mutate });
      await assert.rejects(
        driver.storeServiceAccountCredential(input),
        (error) => error === dropped,
      );
      assert.equal(objects.has(key), true);
      assert.deepEqual(calls, { creates: 1, reads: 1, deletes: [] });
    });
  }

  await t.test("the read-back fails: the outcome is reported as unknown", async () => {
    const { driver, objects, key, calls } = harness({ applied: true, readStatus: 403 });
    await assert.rejects(driver.storeServiceAccountCredential(input), unconfirmed);
    assert.equal(objects.has(key), true);
    assert.deepEqual(calls, { creates: 1, reads: 1, deletes: [] });
  });

  for (const field of ["uid", "resourceVersion"] as const) {
    for (const value of [undefined, ""]) {
      await t.test(
        `a Secret with ${value === undefined ? "missing" : "empty"} ${field} remains unknown`,
        async () => {
          const { driver, objects, key, calls } = harness({
            applied: true,
            mutate: (stored) => {
              if (value === undefined) {
                delete stored.metadata[field];
              } else {
                stored.metadata[field] = value;
              }
            },
          });
          await assert.rejects(driver.storeServiceAccountCredential(input), unconfirmed);
          assert.equal(objects.has(key), true);
          assert.deepEqual(calls, { creates: 1, reads: 1, deletes: [] });
        },
      );
    }
  }

  await t.test("a later exact cleanup failure retains the confirmed receipt", async () => {
    const { driver, objects, key, calls } = harness({ applied: true, deleteStatus: 503 });
    assert.deepEqual(await driver.storeServiceAccountCredential(input), secretRef);
    assert.deepEqual(calls, { creates: 1, reads: 1, deletes: [] });
    const receipt = structuredClone(objects.get(key));
    assert.ok(receipt);
    // This explicit call is the cleanup the ServiceAccount Driver owns after revocation.
    await assert.rejects(driver.deleteServiceAccountCredential({ ...input, secretRef }), {
      message: "delete failed",
      statusCode: 503,
    });
    assert.deepEqual(objects.get(key), receipt);
    assert.deepEqual(calls.deletes, [
      { uid: receipt.metadata.uid, resourceVersion: receipt.metadata.resourceVersion },
    ]);
  });

  await t.test(
    "a leftover Secret blocks the retry with a conflict that names it, not an outage",
    async () => {
      const { driver, namespace, objects, key, calls } = harness({ applied: true });
      assert.deepEqual(await driver.storeServiceAccountCredential(input), secretRef);
      const leftover = structuredClone(objects.get(key));
      const retry = {
        ...input,
        credentialId: "cred-retry-fixture",
        accessToken: "at-retry-fixture",
      };
      await assert.rejects(driver.storeServiceAccountCredential(retry), (error) => {
        // Before finding 935 this was a ConfigurationFailure the controller hid behind 503.
        assert.ok(error instanceof ServiceAccountCredentialSecretExistsError, String(error));
        assert.ok(error instanceof ResourceStateConflictError);
        assert.ok(!(error instanceof DependencyUnavailableError));
        assert.equal(error.secretNamespace, namespace);
        assert.equal(error.secretName, secretName);
        assert.equal(
          error.message,
          `Kubernetes Secret ${namespace}/${secretName} from an earlier issuance blocks this one. An operator must delete it, then retry; see https://docs-enterprise.openclaw.org/reference/service-accounts/`,
        );
        assert.doesNotMatch(error.message, /at-request-fixture|at-retry-fixture/);
        return true;
      });
      // Compute cannot revoke the provider credential, so it leaves the receipt untouched.
      assert.deepEqual(objects.get(key), leftover);
      assert.equal(calls.creates, 1);
      assert.deepEqual(calls.deletes, []);
    },
  );

  await t.test("a foreign object under the name keeps the ownership failure", async () => {
    const { driver, objects, key, calls } = harness({
      applied: true,
      mutate: (stored) => {
        stored.labels["openclaw.dev/service-account"] = "sa_another";
      },
    });
    await assert.rejects(driver.storeServiceAccountCredential(input), (error) => error === dropped);
    const foreign = structuredClone(objects.get(key));
    await assert.rejects(
      driver.storeServiceAccountCredential(input),
      // Not the account's own leftover, so the Driver's ownership refusal stands (still 503).
      (error) =>
        error instanceof Error &&
        error.constructor.name === "OwnershipFailure" &&
        !(error instanceof ResourceStateConflictError),
    );
    assert.deepEqual(objects.get(key), foreign);
    assert.equal(calls.creates, 1);
    assert.deepEqual(calls.deletes, []);
  });
}

/**
 * The fixture's account Secret, with a delete that enforces uid and resourceVersion
 * preconditions the way the API server does and records each request's preconditions.
 */
function serviceAccountSecretFixture(deleteStatus?: number) {
  const { driver, namespace, objects, clients } = workspaceSetupFixture(false);
  const { core } = clients;
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;
  const key = `Secret:${namespace}:${secretName}`;
  const deletes: SecretPreconditions[] = [];
  core.deleteNamespacedSecret = async ({
    name,
    body,
  }: Pick<DeleteSecretRequest, "name" | "body">) => {
    deletes.push(body?.preconditions);
    if (deleteStatus !== undefined) {
      throw Object.assign(new Error("delete failed"), { statusCode: deleteStatus });
    }
    const existing = objects.get(`Secret:${namespace}:${name}`);
    if (existing === undefined) {
      throw Object.assign(new Error("Not found"), { statusCode: 404 });
    }
    const { uid, resourceVersion } = body?.preconditions ?? {};
    if (
      (uid !== undefined && uid !== existing.metadata.uid) ||
      (resourceVersion !== undefined && resourceVersion !== existing.metadata.resourceVersion)
    ) {
      throw Object.assign(new Error("Conflict"), { statusCode: 409 });
    }
    objects.delete(`Secret:${namespace}:${name}`);
  };
  const storedToken = () => {
    const token = objects.get(key)?.data?.token;
    return token === undefined ? undefined : Buffer.from(token, "base64").toString();
  };
  return { driver, clients, objects, key, deletes, serviceAccountId, secretName, storedToken };
}

/**
 * The real ChatGPT ServiceAccount Driver over the fixture's Kubernetes Compute Driver, with an
 * in-memory provider and binding row. Each `request()` is one OCC request: its compensations
 * are collected and run the way OCC runs them after a ROLLBACK, newest first, or never, when
 * the process crashes or its COMMIT outcome is unknown.
 */
async function chatgptIssuanceFixture() {
  const { ChatGPTServiceAccountDriver } =
    await import("../../apps/controller/src/drivers/service-account/chatgpt.ts");
  const secrets = serviceAccountSecretFixture();
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const binding: {
    backendId: string;
    driverId: string;
    externalAccountId: string;
    externalCredentialId: string | null;
    workspaceId: string;
  } = {
    backendId: "openai",
    driverId: "chatgpt-service-accounts",
    externalAccountId: "acct-fixture",
    externalCredentialId: null,
    workspaceId,
  };
  const revoked: string[] = [];
  const deletedAccounts: string[] = [];
  let issued = 0;
  const client = new ChatGPTClient({ workspaceId, adminKey: "synthetic-test-key" });
  client.createCredential = async () => {
    issued += 1;
    return { id: `cred-${issued}`, accessToken: `at-request-fixture-${issued}` };
  };
  client.deleteCredential = async ({ accountId, credentialId }) => {
    assert.equal(accountId, binding.externalAccountId);
    revoked.push(credentialId);
  };
  client.deleteServiceAccount = async (accountId) => {
    deletedAccounts.push(accountId);
  };
  const state = new PostgresPlatformState({
    async connect() {
      assert.fail("unexpected database connection");
    },
    async end() {},
  });
  state.queryInTransaction = async (_unit, statement, parameters) => {
    if (statement.trimStart().startsWith("SELECT")) {
      return { rows: [{ ...binding }], rowCount: 1 };
    }
    const credentialId = parameters?.[3];
    assert.ok(typeof credentialId === "string" || credentialId === null);
    binding.externalCredentialId = credentialId;
    return { rows: [], rowCount: 1 };
  };
  const request = () => {
    const rollbacks: (() => Promise<void>)[] = [];
    const controller = new OpenClawController({
      id: "installation-service-account-secret",
      name: "ServiceAccount Secret conformance",
      createdAt: tenant.createdAt,
    });
    controller.registerRollback = (rollback) => {
      rollbacks.push(rollback);
    };
    const driver = new ChatGPTServiceAccountDriver(
      { id: "openai", drivers: { service_account: "chatgpt-service-accounts" }, client },
      controller,
      state,
      secrets.driver,
    );
    const rollBack = async () => {
      for (const rollback of rollbacks.reverse()) {
        await rollback();
      }
    };
    return { driver, rollBack };
  };
  // An issuance whose Driver call stored its token Secret, after which the process crashed
  // (or its COMMIT failed with an unknown outcome): the binding update never committed and
  // none of its compensations ran, so its provider credential and Secret stay behind.
  const crashedIssuance = async (account: ServiceAccount) => {
    await request().driver.createCredential(account);
    binding.externalCredentialId = null;
  };
  const afterSecretRead = (afterRead: () => void) => {
    const core = credentialSecretTransport(secrets.clients);
    const read = core.readNamespacedSecret;
    core.readNamespacedSecret = async (request) => {
      const result = await read(request);
      afterRead();
      return result;
    };
  };
  const account = { id: secrets.serviceAccountId, namespaceId: tenant.id, name: "issued" };
  return {
    ...secrets,
    account,
    afterSecretRead,
    binding,
    crashedIssuance,
    deletedAccounts,
    request,
    revoked,
    state,
  };
}

export async function checkIssuanceRollbackKeepsLaterSecret() {
  const { account, binding, deletes, objects, key, secretName, request, revoked, storedToken } =
    await chatgptIssuanceFixture();

  // Request A stores its Secret, then its transaction fails after the Driver call. ROLLBACK
  // releases the account row lock before A's compensations run (finding 944).
  const failed = request();
  const original = await failed.driver.createCredential(account);
  assert.deepEqual(original, {
    kind: "access_token",
    secretRef: { name: secretName, key: "token" },
  });
  assert.equal(binding.externalCredentialId, "cred-1");
  assert.equal(storedToken(), "at-request-fixture-1");
  binding.externalCredentialId = null;
  const leftover = structuredClone(storedSecret(objects, key).metadata);

  // In that window request B holds the lock and finds A's Secret: OCC records no credential,
  // so B revokes the credential the Secret records and removes exactly that Secret (finding
  // 1397; it used to answer a 409 an operator had to clear), then stores its own.
  const retry = request();
  assert.deepEqual(await retry.driver.createCredential(account), {
    kind: "access_token",
    secretRef: { name: secretName, key: "token" },
  });
  storedSecret(objects, key).metadata.uid = "retry-secret-uid";

  // A's compensation then finds B's Secret under the same name: it must keep it, so B's
  // recorded credential still has its Secret.
  await failed.rollBack();
  const reissued = storedSecret(objects, key);
  assert.equal(reissued.metadata.uid, "retry-secret-uid");
  assert.equal(reissued.annotations["openclaw.dev/provider-credential-id"], "cred-2");
  assert.equal(storedToken(), "at-request-fixture-2");
  assert.equal(binding.externalCredentialId, "cred-2");
  assert.deepEqual(deletes, [{ uid: leftover.uid, resourceVersion: leftover.resourceVersion }]);
  assert.deepEqual(revoked, ["cred-1", "cred-1"]);
}

export async function checkLeftoverAccountSecretReclaim(t: TestContext) {
  await t.test(
    "the token Secret names its provider credential in metadata that holds no token",
    async () => {
      const { account, crashedIssuance, objects, key } = await chatgptIssuanceFixture();
      await crashedIssuance(account);
      const { annotations } = storedSecret(objects, key);
      assert.equal(annotations["openclaw.dev/provider-credential-id"], "cred-1");
      assert.equal(JSON.stringify(annotations).includes("at-request-fixture"), false);
    },
  );

  await t.test("a re-issue revokes the leftover credential and replaces its Secret", async () => {
    const { account, binding, crashedIssuance, request, revoked, storedToken } =
      await chatgptIssuanceFixture();
    await crashedIssuance(account);

    // Before finding 1397 every re-issue stopped at the leftover Secret's 409 until an
    // operator deleted it, and the crashed issuance's credential stayed live at the provider.
    await request().driver.createCredential(account);
    assert.deepEqual(revoked, ["cred-1"]);
    assert.equal(storedToken(), "at-request-fixture-2");
    assert.equal(binding.externalCredentialId, "cred-2");
  });

  await t.test(
    "deleting the account revokes the leftover credential and removes its Secret",
    async () => {
      const { account, crashedIssuance, deletedAccounts, objects, key, request, revoked } =
        await chatgptIssuanceFixture();
      await crashedIssuance(account);

      // OCC records no credential, so the delete used to skip the Secret, which then outlived
      // the account (and, in an adopted namespace, the OCC Namespace) holding a live token.
      await request().driver.delete(account);
      assert.deepEqual(revoked, ["cred-1"]);
      assert.equal(objects.has(key), false);
      assert.deepEqual(deletedAccounts, ["acct-fixture"]);
    },
  );

  await t.test(
    "a reclaim whose lock was lost while reading the Secret touches nothing a later issuance committed",
    async () => {
      const { account, afterSecretRead, binding, crashedIssuance, objects, key, request, revoked } =
        await chatgptIssuanceFixture();
      await crashedIssuance(account);
      // The request's PostgreSQL session ends during the Kubernetes read, releasing the account
      // lock; another issuance records the Secret it now holds before the read returns. The
      // binding reread after the read sees that record, so nothing is revoked or deleted.
      afterSecretRead(() => {
        binding.externalCredentialId = "cred-1";
      });
      await assert.rejects(
        request().driver.createCredential(account),
        (error) =>
          error instanceof ResourceConflictError &&
          error.message === "The service account credential changed during cleanup.",
      );
      assert.deepEqual(revoked, []);
      assert.equal(objects.has(key), true);
    },
  );

  await t.test(
    "a reclaim whose session ended while reading the Secret fails without touching it",
    async () => {
      const { account, afterSecretRead, crashedIssuance, objects, key, request, revoked, state } =
        await chatgptIssuanceFixture();
      await crashedIssuance(account);
      // The PostgreSQL session ends during the Kubernetes read, so the binding reread on the
      // transaction's connection fails: no proof the lock still holds, so nothing is revoked.
      const lost = new DependencyUnavailableError("The database session ended.");
      afterSecretRead(() => {
        state.queryInTransaction = async () => {
          throw lost;
        };
      });
      await assert.rejects(request().driver.createCredential(account), (error) => error === lost);
      assert.deepEqual(revoked, []);
      assert.equal(objects.has(key), true);
    },
  );

  for (const [label, recorded] of [
    ["names no credential", undefined],
    // Anyone with Secret write can edit the annotation. `..` as a provider path segment would
    // resolve to the provider account itself, so it must never reach a revocation.
    ["names a path segment instead of a credential", ".."],
  ]) {
    await t.test(`a leftover that ${label} blocks issuance and goes with the account`, async () => {
      const { account, crashedIssuance, objects, key, request, revoked, storedToken } =
        await chatgptIssuanceFixture();
      await crashedIssuance(account);
      const { annotations } = storedSecret(objects, key);
      if (recorded === undefined) {
        delete annotations["openclaw.dev/provider-credential-id"];
      } else {
        annotations["openclaw.dev/provider-credential-id"] = recorded;
      }

      // Nothing proves which provider credential is the leftover's, so issuance answers the
      // 409 that names the Secret for an operator before issuing or revoking anything.
      const blocked = request();
      await assert.rejects(
        blocked.driver.createCredential(account),
        ServiceAccountCredentialSecretExistsError,
      );
      await blocked.rollBack();
      assert.deepEqual(revoked, []);
      assert.equal(storedToken(), "at-request-fixture-1");

      // Deleting the account removes the Secret anyway, without a revocation it cannot name:
      // the provider account goes with it.
      await request().driver.delete(account);
      assert.equal(objects.has(key), false);
      assert.deepEqual(revoked, []);
    });
  }
}

export async function checkAccountSecretRollback(t: TestContext) {
  const input = (
    fixture: ReturnType<typeof serviceAccountSecretFixture>,
    accessToken?: string,
  ) => ({
    namespaceId: tenant.id,
    serviceAccountId: fixture.serviceAccountId,
    secretRef: { name: fixture.secretName, key: "token" },
    ...(accessToken === undefined ? {} : { accessToken }),
  });
  const stored = async (
    fixture: ReturnType<typeof serviceAccountSecretFixture>,
    accessToken = "at-request-fixture",
  ) => {
    await fixture.driver.storeServiceAccountCredential({
      namespaceId: tenant.id,
      serviceAccountId: fixture.serviceAccountId,
      credentialId: "cred-request-fixture",
      accessToken,
    });
    return storedSecret(fixture.objects, fixture.key).metadata;
  };

  await t.test("its own Secret is deleted with uid and resourceVersion preconditions", async () => {
    const fixture = serviceAccountSecretFixture();
    const { uid, resourceVersion } = await stored(fixture);
    await fixture.driver.deleteServiceAccountCredential(input(fixture, "at-request-fixture"));
    assert.equal(fixture.objects.has(fixture.key), false);
    assert.deepEqual(fixture.deletes, [{ uid, resourceVersion }]);
  });

  await t.test("another issuance's Secret is kept", async () => {
    const fixture = serviceAccountSecretFixture();
    await stored(fixture, "at-another-request");
    await fixture.driver.deleteServiceAccountCredential(input(fixture, "at-request-fixture"));
    assert.equal(fixture.storedToken(), "at-another-request");
    assert.deepEqual(fixture.deletes, []);
  });

  await t.test("a Secret already gone counts as removed", async () => {
    const fixture = serviceAccountSecretFixture(404);
    await stored(fixture);
    await fixture.driver.deleteServiceAccountCredential(input(fixture, "at-request-fixture"));
    assert.equal(fixture.deletes.length, 1);
  });

  await t.test("a Secret replaced before the delete is kept and the rollback fails", async () => {
    const fixture = serviceAccountSecretFixture(409);
    await stored(fixture);
    await assert.rejects(
      fixture.driver.deleteServiceAccountCredential(input(fixture, "at-request-fixture")),
      { message: "delete failed", statusCode: 409 },
    );
    assert.equal(fixture.storedToken(), "at-request-fixture");
  });

  await t.test("a Secret without a resource version is not deleted blindly", async () => {
    const fixture = serviceAccountSecretFixture();
    await stored(fixture);
    delete storedSecret(fixture.objects, fixture.key).metadata.resourceVersion;
    await assert.rejects(
      fixture.driver.deleteServiceAccountCredential(input(fixture, "at-request-fixture")),
      (error) =>
        error instanceof DependencyUnavailableError &&
        error.message === "The ServiceAccount credential Secret has no exact identity to delete.",
    );
    assert.equal(fixture.storedToken(), "at-request-fixture");
    assert.deepEqual(fixture.deletes, []);
  });

  await t.test("another owner's object under the name is kept", async () => {
    const fixture = serviceAccountSecretFixture();
    await stored(fixture);
    storedSecret(fixture.objects, fixture.key).annotations["openclaw.dev/service-account-id"] =
      "sa_another";
    await fixture.driver.deleteServiceAccountCredential(input(fixture, "at-request-fixture"));
    assert.equal(fixture.storedToken(), "at-request-fixture");
    assert.deepEqual(fixture.deletes, []);
    // Account deletion still refuses it instead of passing over it silently.
    await assert.rejects(fixture.driver.deleteServiceAccountCredential(input(fixture)), {
      message: /^Refusing unowned Kubernetes Secret service-account-[a-f0-9]{32}\.$/,
    });
    assert.deepEqual(fixture.deletes, []);
  });

  await t.test("account deletion passes no token and removes the account's Secret", async () => {
    const fixture = serviceAccountSecretFixture();
    const { uid } = await stored(fixture, "at-another-request");
    await fixture.driver.deleteServiceAccountCredential(input(fixture));
    assert.equal(fixture.objects.has(fixture.key), false);
    assert.deepEqual(fixture.deletes, [{ uid }]);
  });
}

export async function checkManagedPatPreparation() {
  const fixture = workspaceSetupFixture(false);
  const { driver, namespace, objects, records } = fixture;
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretRef = await driver.storeServiceAccountCredential({
    namespaceId: tenant.id,
    serviceAccountId,
    credentialId: "cred-managed-fixture",
    accessToken: "at-managed-fixture",
  });
  const managedAuth = {
    method: "codex_pat",
    source: { kind: "service_account", namespaceId: tenant.id, id: serviceAccountId },
    credential: { kind: "access_token", secretRef },
    backendBinding: {
      backendId: "provider-chatgpt",
      driverId: "chatgpt",
      workspaceId: "ws_1",
      credentialIssued: true,
    },
  } satisfies HarnessAuthSnapshot;
  const revision = { ...fixture.revision, harnessAuth: managedAuth };
  const context: ComputeRevisionContext = {
    ...fixture.context,
    harnessAuth: managedAuth,
    secretEnvironment: [],
  };
  admitRevisionHarness(driver, revision);
  await driver.prepareRevision(revision, context);
  const source = storedSecret(objects, `Secret:${namespace}:${secretRef.name}`);
  const material = [...objects.values()].find(
    ({ kind, metadata }) => kind === "Secret" && metadata.name.startsWith("harness-secrets-"),
  );
  assert.ok(material?.data);
  assert.equal(material.data.CODEX_ACCESS_TOKEN, source.data.token);
  assert.deepEqual(Object.keys(material.data).sort(), ["CODEX_ACCESS_TOKEN", "app-server-token"]);

  // Delivery uses exactly the admitted account snapshot, from the revision's own Namespace.
  const otherAccountId = "sa_00000000-0000-4000-8000-000000000002";
  for (const harnessAuth of [
    {
      ...managedAuth,
      credential: {
        kind: "access_token",
        secretRef: {
          name: `service-account-${createHash("sha256").update(otherAccountId).digest("hex").slice(0, 32)}`,
          key: "token",
        },
      },
    },
    { ...managedAuth, source: { ...managedAuth.source, id: otherAccountId } },
    {
      ...managedAuth,
      backendBinding: { ...managedAuth.backendBinding, workspaceId: "ws_2" },
    },
  ] satisfies ResolvedHarnessAuth[]) {
    await assert.rejects(
      driver.prepareRevision(revision, { ...context, harnessAuth }),
      /does not match the admitted account/,
    );
  }
  const foreignAuth = {
    ...managedAuth,
    source: {
      ...managedAuth.source,
      namespaceId: "ns_00000000-0000-4000-8000-0000000000ff",
    },
  };
  await assert.rejects(
    driver.prepareRevision(
      { ...revision, harnessAuth: foreignAuth },
      { ...context, harnessAuth: foreignAuth },
    ),
    /does not match the admitted account/,
  );

  // Sharing the PAT login mode must retain the managed source's account ownership fence.
  source.annotations["openclaw.dev/service-account-id"] = "another-account";
  const before = records.length;
  await assert.rejects(
    driver.prepareRevision(revision, context),
    /Refusing unowned Kubernetes Secret/,
  );
  assert.equal(
    records.slice(before).some(({ kind }) => kind === "Deployment"),
    false,
  );
}

export function checkDirectPatPlacement() {
  const driver = createKubernetesComputeDriver(options());
  const namespace = kubernetesNamespaceName(tenant.id);
  const snapshot = {
    ...apiKeyAuth,
    method: "codex_pat",
    source: { ...apiKeyAuth.source, kind: "secret" },
  } satisfies HarnessAuthSnapshot;
  const revision: AgentRevision = {
    ...routedRevision(driver),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated", overrides: {}, configuration: {} },
    harnessAuth: snapshot,
    configuration: { agents: { defaults: { model: "codex/discovered-model" } } },
  };
  driver.validateHarnessAuth(revision.harness, revision.harnessAuth, revision.configuration);
  const harnessAuth: Extract<ResolvedHarnessAuth, { method: "codex_pat"; secretDriverId: string }> =
    authContext(revision, namespace).harnessAuth;
  const context = { harnessAuth, secretEnvironment: [] } satisfies ComputeRevisionContext;
  const prepared = driver["harnessAuthForRevision"](revision, context, {
    name: namespace,
    plane: "execution",
  });
  const ownership = { namespaceId: tenant.id, agentId: "direct-pat-agent" };
  for (const role of ["agent", "gateway"] as const) {
    const workload = driver["deployment"](
      "direct-pat",
      ownership,
      { name: namespace, plane: "execution" },
      "runtime:local",
      "direct-pat",
      role,
      {},
      "info",
      undefined,
      false,
      undefined,
      role === "agent" ? prepared : undefined,
    );
    assert.equal(workload.kind, "Deployment");
    const pod = (workload.spec as Deployment["spec"])?.template.spec;
    const entries = pod?.containers[0]?.env;
    assert.ok(entries);
    const env = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_CHATGPT_WORKSPACE_ID, undefined);
    if (role === "agent") {
      assert.equal(env.CODEX_LOGIN_MODE?.value, "codex_pat");
      assert.deepEqual(env.CODEX_ACCESS_TOKEN?.valueFrom?.secretKeyRef, {
        name: "occ-model-key",
        key: "value",
      });
    } else {
      assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
    }
  }
  for (const harnessAuth of [
    { ...context.harnessAuth, method: "api_key" },
    { ...context.harnessAuth, secretDriverId: "different-driver" },
    { ...context.harnessAuth, backendRef: { ...context.harnessAuth.backendRef, uid: "" } },
  ] satisfies ResolvedHarnessAuth[]) {
    assert.throws(
      () =>
        driver["harnessAuthForRevision"](
          revision,
          { ...context, harnessAuth },
          { name: namespace, plane: "execution" },
        ),
      /authentication.*(?:invalid|admitted source)/i,
    );
  }
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        { id: "openclaw", version: "1.0.0", mode: "embedded" },
        revision.harnessAuth,
        revision.configuration,
      ),
    { message: EMBEDDED_API_KEY_REQUIRED },
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(revision.harness, revision.harnessAuth, {
        agents: { defaults: { model: "anthropic/claude" } },
      }),
    /compatible model provider/i,
  );
}
