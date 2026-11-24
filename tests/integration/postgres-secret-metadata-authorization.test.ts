import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import type { Namespace, Secret } from "../../packages/contracts/src/index.ts";
import { createBootstrapAdministratorSeed, NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  createPostgresPool,
  OpenClawController,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const origin = "https://console.oce.localhost";
const readOnlyBegin = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const namespaceLookup = "FROM occ.namespaces WHERE id = $1 AND deleted_at IS NULL";

type ReadTarget = {
  kind: "namespace" | "secret" | "configuration";
  namespaceId: string;
  id: string;
};

type LookupGate = {
  namespaceId: string;
  entered: () => void;
  released: Promise<void>;
  policyRead: boolean;
  lookups: number;
  readUnits: number;
};

const lookupGate = new AsyncLocalStorage<LookupGate>();

type StatePool = ConstructorParameters<typeof PostgresPlatformState>[0];

function observeLookup(pool: StatePool): StatePool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        release: client.release.bind(client),
        ...(client.on === undefined ? {} : { on: client.on.bind(client) }),
        ...(client.removeListener === undefined
          ? {}
          : { removeListener: client.removeListener.bind(client) }),
        async query(statement, parameters) {
          const gate = lookupGate.getStore();
          if (gate && statement === readOnlyBegin) {
            gate.readUnits += 1;
          }
          if (gate && statement.includes(namespaceLookup) && parameters?.[0] === gate.namespaceId) {
            gate.lookups += 1;
            assert.equal(gate.lookups, 1);
            assert.ok(gate.policyRead, "Native IAM must have loaded policy before the lookup");
            gate.entered();
            await gate.released;
          }
          const result = await client.query(statement, parameters);
          if (gate && statement.includes("FROM occ.iam_identities) v")) {
            gate.policyRead = true;
          }
          return result;
        },
      };
    },
    end: () => pool.end(),
  } satisfies ConstructorParameters<typeof PostgresPlatformState>[0];
}

function namespace(): Namespace {
  return {
    id: "ns_" + randomUUID(),
    name: "Metadata namespace " + randomUUID(),
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

function secret(namespaceId: string): Secret {
  return {
    id: "sec_" + randomUUID(),
    namespaceId,
    name: "Metadata Secret " + randomUUID(),
    driverId: "fixture-secret-storage",
    backendRef: {
      namespaceName: "fixture-namespace",
      name: "backend-" + randomUUID(),
      key: "value",
      uid: randomUUID(),
    },
    createdAt: new Date().toISOString(),
  };
}

function credentials() {
  return {
    email: "metadata-" + randomUUID() + "@example.test",
    password: "test-password-" + randomUUID(),
  };
}

let closePool: (() => Promise<void>) | undefined;
let closeApp: (() => Promise<void>) | undefined;

async function createFixture(url: string) {
  const pool = await createPostgresPool(url);
  closePool = () => pool.end();
  const state = new PostgresPlatformState(observeLookup(pool));
  assert.equal(await state.loadInstallation(), undefined, "the file owns a fresh database");
  const installation = {
    id: "ins_" + randomUUID(),
    name: "Secret metadata authorization",
    createdAt: new Date().toISOString(),
  };
  const authOptions = {
    mode: "development" as const,
    installationId: installation.id,
    baseURL: origin,
    agentDomain: "agents.oce.localhost",
    secret: "test-auth-secret-" + randomUUID(),
    pool,
  };
  const bootstrapAuth = await createPostgresControllerAuth(authOptions);
  const admin = credentials();
  const account = await bootstrapAuth.createAccount({ ...admin, name: "Metadata administrator" });
  const seed = createBootstrapAdministratorSeed(installation.id, bootstrapAuth.issuer, account);
  state.setBootstrapNativeIAM({
    identities: [seed.principal, seed.servicePrincipal],
    roles: seed.roles,
    bindings: seed.bindings,
    groups: [],
    memberships: [],
    restrictions: [],
  });

  const local = namespace();
  const foreign = namespace();
  const target = secret(local.id);
  const hidden = secret(local.id);
  const visibleConfiguration = "cfg_" + randomUUID();
  const hiddenConfiguration = "cfg_" + randomUUID();
  const metadata = {
    id: target.id,
    namespaceId: local.id,
    name: target.name,
    ref: { kind: "secret", id: target.id, namespaceId: local.id },
  } as const;
  await state.transact(async (unit) => {
    await unit.installations.createInstallation(installation);
    await unit.namespaces.createNamespace(local);
    await unit.namespaces.createNamespace(foreign);
    await unit.secrets.createSecret(target);
    await unit.secrets.createSecret(hidden);
    await unit.secrets.createSecret(secret(foreign.id));
    for (const id of [visibleConfiguration, hiddenConfiguration]) {
      await unit.configurations.createConfiguration({
        id,
        namespaceId: local.id,
        kind: "agent",
        generation: 1,
        createdAt: local.createdAt,
        secretBindings: { SERVICE_TOKEN: { source: metadata.ref, delivery: { type: "env" } } },
      });
    }
  });

  const controller = new OpenClawController(installation, { state });
  const iam = new NativeIAMDriver(state);
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const auth = await createPostgresControllerAuth({ ...authOptions, state, iamDriver: iam });
  const app = createFastifyApp({
    controller,
    iamDriver: iam,
    auth,
    auditSink: state.auditSink,
    resolveHarness: () => assert.fail("Secret metadata does not resolve a harness"),
    development: { enabled: true, installationId: installation.id, browserOrigin: origin },
  });
  closeApp = () => app.close();

  async function signIn(input: ReturnType<typeof credentials>) {
    const session = await signInToControllerApp(app, input, { origin });
    return { ...authenticatedHeaders(session), host: new URL(origin).host };
  }

  const adminHeaders = await signIn(admin);
  const iamPath = "/namespaces/" + local.id + "/iam";

  async function createGrant(principalId: string, resource: ReadTarget) {
    const role = await app.inject({
      method: "POST",
      url: iamPath + "/roles",
      headers: adminHeaders,
      payload: { permissions: [{ action: "read", resourceKind: resource.kind }] },
    });
    assert.equal(role.statusCode, 201, role.body);
    const binding = await app.inject({
      method: "POST",
      url: iamPath + "/access-bindings",
      headers: adminHeaders,
      payload: {
        subjectKind: "identity",
        subjectId: principalId,
        roleId: role.json<{ data: { id: string } }>().data.id,
        resourceKind: resource.kind,
        resourceId: resource.id,
      },
    });
    assert.equal(binding.statusCode, 201, binding.body);
    return binding.json<{ data: { id: string } }>().data.id;
  }

  async function revoke(bindingId: string) {
    const response = await app.inject({
      method: "DELETE",
      url: iamPath + "/access-bindings/" + bindingId,
      headers: adminHeaders,
    });
    assert.equal(response.statusCode, 204, response.body);
  }

  return {
    app,
    iam,
    controller,
    local,
    target,
    visibleConfiguration,
    hiddenConfiguration,
    metadata,
    createGrant,
    revoke,
    async reader() {
      const input = credentials();
      const created = await auth.createAccount({ ...input, name: "Metadata reader" });
      const readerSeed = auth.principalSeed(created, { grant: "none" });
      await state.appendNativeIAMPrincipal(readerSeed);
      return { id: readerSeed.principal.id, headers: await signIn(input) };
    },
  };
}

let fixture: Awaited<ReturnType<typeof createFixture>>;
before(async () => {
  if (databaseUrl) {
    fixture = await createFixture(databaseUrl);
  }
});
after(async () => {
  try {
    await closeApp?.();
  } finally {
    await closePool?.();
  }
});

async function expectOnePolicy(t: TestContext, route: "collection" | "detail") {
  const f = fixture;
  const reader = await f.reader();
  const namespaceId = f.local.id;
  const collection = "/namespaces/" + namespaceId + "/secrets";
  const read = () =>
    f.app.inject({
      method: "GET",
      url: route === "collection" ? collection : collection + "/" + f.target.id,
      headers: reader.headers,
    });
  const primary: ReadTarget =
    route === "collection"
      ? { kind: "namespace", namespaceId, id: namespaceId }
      : { kind: "secret", namespaceId, id: f.target.id };
  const dependent: ReadTarget =
    route === "collection"
      ? { kind: "secret", namespaceId, id: f.target.id }
      : { kind: "configuration", namespaceId, id: f.visibleConfiguration };

  async function assertPolicy(primaryAllowed: boolean, dependentAllowed: boolean) {
    const outcomes = await Promise.all(
      [primary, dependent].map((resource) =>
        f.iam.authorize({ principalId: reader.id, action: "read", resource }),
      ),
    );
    assert.deepEqual(
      outcomes.map(({ allowed }) => allowed),
      [primaryAllowed, dependentAllowed],
    );
  }

  function assertMetadata(response: Awaited<ReturnType<typeof read>>, dependentAllowed: boolean) {
    assert.equal(response.statusCode, 200, response.body);
    const { data } = response.json<{ data: unknown }>();
    if (route === "collection") {
      assert.deepEqual(data, dependentAllowed ? [f.metadata] : []);
      if (!dependentAllowed) {
        assert.equal(response.body.includes(f.target.id), false);
      }
    } else {
      assert.deepEqual(data, {
        ...f.metadata,
        consumers: {
          agents: [],
          configurations: dependentAllowed ? [f.visibleConfiguration] : [],
          credentialSources: [],
          provisioningRequests: [],
          unreadable: dependentAllowed ? 1 : 2,
          truncated: false,
        },
        callerPermissions: { update: false, delete: false },
      });
    }
    assert.equal(response.body.includes(f.hiddenConfiguration), false);
    if (route === "detail" && !dependentAllowed) {
      assert.equal(response.body.includes(f.visibleConfiguration), false);
    }
    assert.equal(response.body.includes(f.target.driverId), false);
    assert.equal(response.body.includes(f.target.backendRef.name), false);
    assert.equal(response.body.includes(f.target.backendRef.uid), false);
  }

  const prerequisite = await f.createGrant(reader.id, primary);
  const allowedDependent = await f.createGrant(reader.id, dependent);
  await assertPolicy(true, true);
  assertMetadata(await read(), true);
  await f.revoke(allowedDependent);
  await assertPolicy(true, false);

  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate: LookupGate = {
    namespaceId,
    entered: markEntered,
    released,
    policyRead: false,
    lookups: 0,
    readUnits: 0,
  };
  // Scope the timing hook to one invocation of the owning controller method.
  if (route === "collection") {
    const list = f.controller.listSecrets.bind(f.controller);
    t.mock.method(
      f.controller,
      "listSecrets",
      (...args: Parameters<typeof list>) => lookupGate.run(gate, () => list(...args)),
      { times: 1 },
    );
  } else {
    const detail = f.controller.readSecret.bind(f.controller);
    t.mock.method(
      f.controller,
      "readSecret",
      (...args: Parameters<typeof detail>) => lookupGate.run(gate, () => detail(...args)),
      { times: 1 },
    );
  }

  const inFlight = read();
  const timer = new AbortController();
  try {
    try {
      await Promise.race([
        entered,
        inFlight.then(() => assert.fail("The reader completed before the Namespace lookup gate")),
        delay(10_000, undefined, { signal: timer.signal }).then(() =>
          assert.fail("The reader did not reach the Namespace lookup"),
        ),
      ]);
    } finally {
      timer.abort();
    }
    // These administrator requests run outside the reader's async State context.
    await f.revoke(prerequisite);
    await assertPolicy(false, false);
    await f.createGrant(reader.id, dependent);
    await assertPolicy(false, true);
  } finally {
    release();
    await inFlight.catch(() => {});
  }

  // The crossed response must contain only the disclosures permitted by policy A.
  assertMetadata(await inFlight, false);
  assert.equal(gate.lookups, 1);
  assert.equal(gate.readUnits, 1, "the response decisions must share a read unit");

  // A later request sees policy B and refuses the prerequisite despite its dependent grant.
  const denied = await read();
  assert.equal(denied.statusCode, 403, denied.body);
  const deniedBody = denied.json<{ error: { code: string }; data?: unknown }>();
  assert.equal(deniedBody.error.code, "FORBIDDEN");
  assert.equal(deniedBody.data, undefined);
  assert.equal(denied.body.includes(f.visibleConfiguration), false);
  if (route === "collection") {
    assert.equal(denied.body.includes(f.target.id), false);
  }
}

test(
  "Secret collection keeps Namespace and candidate grants in one PostgreSQL snapshot",
  { ...requiresPostgres, timeout: 45_000 },
  async (t) => expectOnePolicy(t, "collection"),
);

test(
  "Secret detail keeps its grant and consumer grants in one PostgreSQL snapshot",
  { ...requiresPostgres, timeout: 45_000 },
  async (t) => expectOnePolicy(t, "detail"),
);
