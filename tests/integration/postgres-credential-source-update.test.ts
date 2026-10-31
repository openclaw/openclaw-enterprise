import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";

import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  OpenShellProviderAlreadyExistsError,
  type OpenShellGatewayClient,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import {
  databaseUrl as configuredDatabaseUrl,
  requiresPostgres,
} from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

// Finding 1398: a credential source update writes the legacy Credential Gateway before its
// references and success audit commit. These cases run the real Fastify app, authentication,
// Native IAM, PostgreSQL State as the application role, and the OpenShell Credential Gateway
// Driver. Only the gateway's provider storage is a recording double; the commit faults are
// real PostgreSQL transport faults injected by a loopback proxy.

// requiresPostgres skips every case when no database is configured.
const databaseUrl = configuredDatabaseUrl ?? "";

type Provider = {
  workspace: string;
  name: string;
  credentials: Record<string, string>;
  [field: string]: unknown;
};

/** Gateway storage shared across controller restarts, as an external gateway would be. */
function recordingGateway() {
  const providers = new Map<string, Provider>();
  const profiles = new Map<string, { id: string }>();
  const writes: string[] = [];
  const hooks: { afterWrite?: (() => void | Promise<void>) | undefined } = {};
  const key = (workspace: string, name: string) => `${workspace}/${name}`;
  const client = {
    async getProviderProfile(workspace: string, id: string) {
      return profiles.get(key(workspace, id));
    },
    async importProviderProfile(workspace: string, profile: { id: string }) {
      profiles.set(key(workspace, profile.id), structuredClone(profile));
    },
    async deleteProviderProfile(workspace: string, id: string) {
      profiles.delete(key(workspace, id));
    },
    async createProvider(input: Provider) {
      const id = key(input.workspace, input.name);
      if (providers.has(id)) {
        throw new OpenShellProviderAlreadyExistsError(input.name);
      }
      providers.set(id, structuredClone(input));
      return providers.get(id);
    },
    async getProvider(workspace: string, name: string) {
      return providers.get(key(workspace, name));
    },
    async listProviders(workspace: string) {
      return [...providers.values()].filter((provider) => provider.workspace === workspace);
    },
    async deleteProvider(workspace: string, name: string) {
      providers.delete(key(workspace, name));
    },
    async updateProviderCredentials(
      workspace: string,
      name: string,
      credentials: Record<string, string>,
    ) {
      const provider = providers.get(key(workspace, name));
      assert.ok(provider);
      provider.credentials = structuredClone(credentials);
      writes.push(Object.values(credentials).join(","));
      const afterWrite = hooks.afterWrite;
      hooks.afterWrite = undefined;
      await afterWrite?.();
    },
    close() {},
  };
  const backend = createOpenShellBackend(
    {
      id: "openshell-pg-update",
      type: "openshell",
      configuration: { endpoint: "http://127.0.0.1:1" },
      drivers: {
        sandbox: "openshell-pg-update-sandbox",
        credential_gateway: "openshell-pg-update-credentials",
      },
    },
    { gatewayClient: client as unknown as OpenShellGatewayClient },
  );
  const driver = new OpenShellCredentialGatewayDriver(
    { binaries: ["/app/bin/codex"] },
    { id: "openshell-pg-update-credentials", backend },
  );
  /** The value the gateway holds for the source's only provider. */
  const held = () => {
    const [provider, ...others] = [...providers.values()];
    assert.ok(provider);
    assert.equal(others.length, 0);
    return Object.values(provider.credentials).join(",");
  };
  return { driver, writes, hooks, held };
}

type Gateway = ReturnType<typeof recordingGateway>;
type SecretDriver = ReturnType<typeof createTestSecretDriver>;

/**
 * One controller process: the real app over `transportDatabaseUrl`, with the shared gateway and
 * Secret storage selected. A restart is a second call with the same gateway and Secret Driver.
 */
async function controllerProcess(
  t: TestContext,
  gateway: Gateway,
  secretDriver: SecretDriver,
  transportDatabaseUrl: string,
) {
  // Compute owns the gateway's placement: a short Workspace name, as the paired Sandbox sees it.
  const computeDriver = {
    ...createDevelopmentComputeDriver(),
    async resolveSandboxNamespace(namespace: { id: string; name: string }) {
      return { ...namespace, name: `placed-${namespace.id.slice(-12)}` };
    },
  };
  const p = await createPostgresAgentApp(t, {
    label: "credential-source-update",
    authSecret: "credential-source-update-session-secret-2026",
    transportDatabaseUrl,
    appOptions: { computeDriver, secretDriver },
    controllerOptions: undefined,
    sandboxDriver: undefined,
    stateOptions: undefined,
  });
  // As the production pool does: an idle connection the proxy closes is discarded, not thrown.
  p.pool.on("error", () => {});
  // The JavaScript test doubles carry no Driver types.
  p.controller.registerDriver(computeDriver as never);
  p.controller.selectDriver("compute", computeDriver.id);
  p.controller.registerDriver(secretDriver as never);
  p.controller.selectDriver("secret", secretDriver.id);
  p.controller.registerDriver(gateway.driver);
  p.controller.selectDriver("credential_gateway", gateway.driver.id);
  const request = async (method: string, url: string, body?: unknown) => {
    const response = await p.inject(method, url, body);
    return {
      status: response.statusCode,
      body: response.statusCode === 204 ? {} : response.json(),
    };
  };
  return { ...p, request };
}

type Controller = Awaited<ReturnType<typeof controllerProcess>>;

/** A ready Namespace with an `openai` source recording Secret A. */
async function seedSource(f: Controller) {
  const created = await f.request("POST", "/namespaces", {
    name: `credential update ${randomUUID()}`,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const namespace = created.body.data;
  await f.controller.handleNamespaceLifecycle(f.principal.id, namespace.id, "ready");
  const secrets = `/namespaces/${namespace.id}/secrets`;
  const createSecret = async (label: string) => {
    const secret = await f.request("POST", secrets, {
      name: `${label} ${randomUUID()}`,
      value: `synthetic-${label}-${randomUUID()}`,
    });
    assert.equal(secret.status, 201, JSON.stringify(secret.body));
    return secret.body.data as { id: string; ref: Record<string, string> };
  };
  const recorded = await createSecret("recorded");
  const source = await f.request("POST", `/namespaces/${namespace.id}/credential-sources`, {
    name: `model ${randomUUID()}`,
    type: "openai",
    config: {},
    secrets: { api_key: recorded.ref },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  return {
    namespace,
    recorded,
    createSecret,
    sourcePath: `/namespaces/${namespace.id}/credential-sources/${source.body.data.id}`,
    sourceId: source.body.data.id as string,
    secretPath: (secret: { id: string }) => `${secrets}/${secret.id}`,
  };
}

test(
  "PATCH keeps every Secret the gateway may hold through a lost commit and a denied retry (finding 1398)",
  { ...requiresPostgres, timeout: 120_000 },
  async (t) => {
    const proxy = await commitAckProxy(databaseUrl);
    const gateway = recordingGateway();
    const secretDriver = createTestSecretDriver({ id: "credential-update-pg-secret" });
    const f = await controllerProcess(t, gateway, secretDriver, proxy.url);
    // After hooks run in order: the pool ends before the proxy closes its connections.
    t.after(() => proxy.close());
    const { namespace, recorded, createSecret, sourcePath, sourceId, secretPath } =
      await seedSource(f);

    // A to B: the gateway applies B, then the connection carrying the success COMMIT closes
    // before PostgreSQL receives it, so the references and audit roll back.
    const sent = await createSecret("sent");
    gateway.hooks.afterWrite = () => proxy.arm({ pauseCommit: true });
    const patch = f.request("PATCH", sourcePath, { secrets: { api_key: sent.ref } });
    await waitFor("the success COMMIT to pause", () => (proxy.commitPaused ? true : undefined));
    proxy.dropPausedCommit();
    const lost = await patch;
    assert.equal(lost.status, 503, JSON.stringify(lost.body));
    assert.equal(gateway.writes.length, 1);
    assert.equal(gateway.held(), secretDriver.valueFor(sent));
    assert.deepEqual((await f.request("GET", sourcePath)).body.data.secrets, {
      api_key: recorded.ref,
    });
    // The gateway holds B, so B cannot be deleted.
    assert.equal((await f.request("DELETE", secretPath(sent))).status, 409);

    // A request for C stages, and a deny Restriction on this source commits while it does.
    // Its gateway step is refused before any write, and staging C must not release B. C never
    // reached the gateway, so the refused request releases C alone.
    const staged = await createSecret("staged");
    const readValue = secretDriver.withValue.bind(secretDriver);
    let restricted = false;
    secretDriver.withValue = async (...args: Parameters<SecretDriver["withValue"]>) => {
      if (!restricted) {
        restricted = true;
        // OCC has no API that writes Restrictions; the application role may insert them.
        await f.pool.query(
          `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
           VALUES ($1, $2, 'update', 'credential_source', $3)`,
          [`restriction_${randomUUID()}`, namespace.id, sourceId],
        );
      }
      return readValue(...args);
    };
    t.after(() => {
      secretDriver.withValue = readValue;
    });
    const denied = await f.request("PATCH", sourcePath, { secrets: { api_key: staged.ref } });
    assert.equal(restricted, true);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(gateway.writes.length, 1, "the denied update never reached the gateway");
    assert.equal(gateway.held(), secretDriver.valueFor(sent));
    for (const [label, secret] of [
      ["recorded A", recorded],
      ["sent B, still held by the gateway", sent],
    ] as const) {
      assert.equal((await f.request("DELETE", secretPath(secret))).status, 409, label);
    }
    assert.equal((await f.request("DELETE", secretPath(staged))).status, 204, "staged C");
  },
);

test(
  "a controller that dies after the gateway write leaves the sent Secret retained for its successor (finding 1398)",
  { ...requiresPostgres, timeout: 120_000 },
  async (t) => {
    const proxy = await commitAckProxy(databaseUrl);
    const died = proxy.close.bind(proxy);
    let dead = false;
    t.after(() => (dead ? undefined : died()));
    const gateway = recordingGateway();
    const secretDriver = createTestSecretDriver({ id: "credential-update-pg-secret" });
    const first = await controllerProcess(t, gateway, secretDriver, proxy.url);
    const { recorded, createSecret, sourcePath, secretPath } = await seedSource(first);
    const sent = await createSecret("sent");

    // The gateway applies B; the process then dies with its success COMMIT unsent, and
    // every database connection closes.
    gateway.hooks.afterWrite = () => proxy.arm({ pauseCommit: true });
    const patch = first.request("PATCH", sourcePath, { secrets: { api_key: sent.ref } });
    await waitFor("the success COMMIT to pause", () => (proxy.commitPaused ? true : undefined));
    dead = true;
    await died();
    assert.notEqual((await patch).status, 200);
    assert.equal(gateway.held(), secretDriver.valueFor(sent));

    // The next controller reads only committed state: B is still a consumer.
    const second = await controllerProcess(t, gateway, secretDriver, databaseUrl);
    assert.equal((await second.request("DELETE", secretPath(sent))).status, 409);
    assert.deepEqual((await second.request("GET", sourcePath)).body.data.secrets, {
      api_key: recorded.ref,
    });

    // Repeating the request converges: the gateway is written again, and the commit records B
    // and releases the retained Secrets, so A can now be deleted.
    const repeated = await second.request("PATCH", sourcePath, {
      secrets: { api_key: sent.ref },
    });
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.deepEqual(repeated.body.data.secrets, { api_key: sent.ref });
    assert.equal(gateway.writes.length, 2);
    assert.equal((await second.request("DELETE", secretPath(recorded))).status, 204);
    assert.equal((await second.request("DELETE", secretPath(sent))).status, 409);
  },
);

test(
  "an update that waited for the source lock retains a Secret the record no longer names (finding 1398)",
  { ...requiresPostgres, timeout: 120_000 },
  async (t) => {
    const proxy = await commitAckProxy(databaseUrl);
    const gateway = recordingGateway();
    const secretDriver = createTestSecretDriver({ id: "credential-update-pg-secret" });
    const f = await controllerProcess(t, gateway, secretDriver, proxy.url);
    // After hooks run in order: the pool ends before the proxy closes its connections.
    t.after(() => proxy.close());
    const { recorded, createSecret, sourcePath, secretPath } = await seedSource(f);
    const replacement = await createSecret("replacement");

    // While the update to B holds the source lock for its gateway write, a request naming A
    // explicitly waits for that lock. Once B commits, A is no longer recorded, so the waiting
    // request must read B and retain A before it sends A to the gateway. The test starts that
    // request itself, outside the update's transaction context.
    let reachedGateway = () => {};
    const atGateway = new Promise<void>((resolve) => (reachedGateway = resolve));
    let resume = () => {};
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    gateway.hooks.afterWrite = async () => {
      // The resend writes A; its success COMMIT then never reaches PostgreSQL.
      gateway.hooks.afterWrite = () => proxy.arm({ pauseCommit: true });
      reachedGateway();
      await resumed;
    };
    const update = f.request("PATCH", sourcePath, { secrets: { api_key: replacement.ref } });
    await atGateway;
    const resend = f.request("PATCH", sourcePath, { secrets: { api_key: recorded.ref } });
    await waitFor("the request for A to wait for the source lock", async () =>
      (
        await f.pool.query(
          `SELECT 1 FROM pg_locks AS l JOIN pg_stat_activity AS a ON a.pid = l.pid
           WHERE NOT l.granted AND a.datname = current_database()`,
        )
      ).rowCount === 0
        ? undefined
        : true,
    );
    resume();
    const updated = await update;
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    await waitFor("the resend's success COMMIT to pause", () =>
      proxy.commitPaused ? true : undefined,
    );
    proxy.dropPausedCommit();
    const lost = await resend;
    assert.equal(lost.status, 503, JSON.stringify(lost.body));
    assert.equal(gateway.writes.length, 2);
    assert.equal(gateway.held(), secretDriver.valueFor(recorded));
    assert.deepEqual((await f.request("GET", sourcePath)).body.data.secrets, {
      api_key: replacement.ref,
    });
    // The gateway holds A although the record names B, so neither can be deleted.
    assert.equal((await f.request("DELETE", secretPath(recorded))).status, 409);
    assert.equal((await f.request("DELETE", secretPath(replacement))).status, 409);
  },
);
