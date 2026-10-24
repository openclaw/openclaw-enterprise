import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { PostgresPlatformState, PostgresWorkQueue } from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { setup, requiresPostgres } from "../helpers/compute-singleton-worker.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { Pool } = require("pg");
const binding = {
  stage: "runtime",
  installationId: "ins_00000000-0000-4000-8000-000000000001",
  namespaceId: "ns_00000000-0000-4000-8000-000000000002",
  uid: "00000000-0000-4000-8000-000000000003",
  startupCycle: "independent",
};
const hash = (value: string, length: number) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

test(
  "named runtime uses real API readiness, immutable identity and authenticated startup reads before claims and recovery",
  requiresPostgres,
  async (t) => {
    let worker: ReturnType<typeof createControllerWorker> | undefined;
    t.after(async () => {
      await worker?.stop();
    });
    const fixture = await setup(t);
    const state = new PostgresPlatformState(fixture.observerPool);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    // Fresh bootstrap leaves logical provisioning; no ready-to-provisioning reset.
    const freshNamespace = {
      ...fixture.namespace,
      id: `ns_${randomUUID()}`,
      name: `fresh-${randomUUID()}`,
      status: "provisioning" as const,
    };
    await state.transact((unit) => unit.namespaces.createNamespace(freshNamespace));
    const selected = {
      ...binding,
      installationId: installation.id,
      namespaceId: fixture.namespace.id,
    };
    let namespaceName = `oce-${hash(selected.namespaceId, 15)}`;
    let physicalLogicalId = selected.namespaceId;
    const tls = await harnessTlsFixture(t);
    let physicalUid = selected.uid;
    let namespaceStatus = 200;
    let physicalPhase = "Active";
    const reads: string[] = [];
    const unexpected: string[] = [];
    const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
      const target = `${request.method} ${request.url}`;
      reads.push(target);
      assert.equal(request.headers.authorization, "Bearer synthetic-kubernetes-identity");
      response.setHeader("content-type", "application/json");
      if (target === "GET /version") {
        response.end(JSON.stringify({ gitVersion: "v1.35.0" }));
      } else if (target === `GET /api/v1/namespaces/${namespaceName}`) {
        response.statusCode = namespaceStatus;
        response.end(
          JSON.stringify(
            namespaceStatus === 200
              ? {
                  apiVersion: "v1",
                  kind: "Namespace",
                  metadata: {
                    name: namespaceName,
                    uid: physicalUid,
                    annotations: {
                      "openclaw.dev/namespace-lifecycle": "preprovisioned",
                      "openclaw.dev/namespace-id": physicalLogicalId,
                    },
                    labels: {
                      "app.kubernetes.io/managed-by": "openclaw-enterprise",
                      "openclaw.dev/namespace": physicalLogicalId,
                      "openclaw.dev/gateway-namespace": physicalLogicalId,
                      "openclaw-enterprise.io/gateway": hash("openclaw-system/private-gateway", 12),
                      ...Object.fromEntries(
                        ["enforce", "audit", "warn"].map((key) => [
                          `pod-security.kubernetes.io/${key}`,
                          "restricted",
                        ]),
                      ),
                    },
                  },
                  status: { phase: physicalPhase },
                }
              : {
                  kind: "Status",
                  status: "Failure",
                  reason: namespaceStatus === 403 ? "Forbidden" : "NotFound",
                  code: namespaceStatus,
                },
          ),
        );
      } else {
        unexpected.push(target);
        response.statusCode = 404;
        response.end(JSON.stringify({ kind: "Status", reason: "NotFound", code: 404 }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const kubeconfigPath = join(tls.directory, "kubeconfig.json");
    await writeFile(
      kubeconfigPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        "current-context": "private",
        clusters: [
          {
            name: "private",
            cluster: {
              server: `https://localhost:${address.port}`,
              "certificate-authority": tls.rootCertificatePath,
            },
          },
        ],
        contexts: [{ name: "private", context: { cluster: "private", user: "private" } }],
        users: [{ name: "private", user: { token: "synthetic-kubernetes-identity" } }],
      }),
    );
    const authentication = { mode: "kubeconfig", kubeconfigPath, context: "private" };
    const base = createInstallationDriverConfiguration();
    const configuration = {
      ...base,
      backend: [
        {
          id: "openshell",
          type: "openshell",
          configuration: {
            serviceName: "private-gateway",
            port: 50051,
            insecureTransport: "network-policy",
          },
          drivers: { sandbox: "openshell-sandbox" },
        },
      ],
      drivers: {
        ...base.drivers,
        configuration: { ...base.drivers.configuration, configuration: { authentication } },
        secret: { ...base.drivers.secret, configuration: { authentication } },
        compute: {
          ...base.drivers.compute,
          configuration: {
            ...base.drivers.compute.configuration,
            authentication,
            network: { ...base.drivers.compute.configuration.network, gatewayClients: undefined },
            gatewayRouting: {
              hostname: "private-gateway.example.invalid",
              gatewayName: "private-gateway",
              gatewayNamespace: "openclaw-system",
              envoyNamespace: "envoy-system",
            },
          },
        },
        sandbox: {
          id: "openshell-sandbox",
          configuration: {
            gateway: { workspaceMode: "operator" },
            kubernetes: {
              runtimeClassName: "openshell-sandbox",
              userNamespaces: false,
              serviceAccount: { mode: "gatewayConfigured" },
              sandboxDataMount: {
                subPath: "workspace",
                mountPath: "/sandbox/enterprise",
                readOnly: false,
              },
            },
            policy: {
              process: { runAsUser: "1000", runAsGroup: "1000" },
              networkPolicies: [
                { name: "deny-egress", binaries: [{ path: "/usr/bin/true" }], endpoints: [] },
              ],
            },
          },
        },
      },
    };
    const configPath = join(tls.directory, "installation.json");
    const load = async (selection = selected, extra: Record<string, string> = {}) => {
      await writeFile(configPath, JSON.stringify(configuration));
      const runtime = await loadInstallationConfiguration({
        mode: "production",
        environment: {
          OCC_CONFIG_PATH: configPath,
          OCC_NAMED_WORKSPACE: JSON.stringify(selection),
          ...extra,
        },
      });
      assert.ok(runtime);
      return runtime;
    };
    const runtime = await load();
    assert.equal(runtime.startupDependency, undefined);
    assert.equal(runtime.proxyDriver, undefined);
    assert.equal(runtime.repositoryOwner, undefined);
    await assert.rejects(
      load(selected, { OCC_PREPROVISIONED_NAMESPACE: JSON.stringify(selected) }),
      /mutually exclusive/,
    );
    await assert.rejects(load({ ...selected, uid: "wrong" }), /OCC_NAMED_WORKSPACE/);
    await assert.rejects(load({ ...selected, stage: "bootstrap" }), /OCC_NAMED_WORKSPACE/);
    await assert.rejects(
      load({ ...selected, extra: true } as typeof selected),
      /OCC_NAMED_WORKSPACE/,
    );
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: {
          OCC_CONFIG_PATH: configPath,
          OCC_PREPROVISIONED_NAMESPACE: JSON.stringify({
            namespaceId: selected.namespaceId,
            uid: selected.uid,
          }),
        },
      }),
      /Credential Proxy/,
    );
    Object.assign(configuration.drivers, {
      credential_gateway: {
        id: "synthetic-credentials",
        configuration: { binaries: ["/app/bin/model-client"] },
      },
    });
    Object.assign(configuration.backend[0]!.drivers, {
      credential_gateway: "synthetic-credentials",
    });
    await assert.rejects(load(), /Git-disabled authority/);
    Reflect.deleteProperty(configuration.drivers, "credential_gateway");
    Reflect.deleteProperty(configuration.backend[0]!.drivers, "credential_gateway");
    const compose = (
      drivers = runtime,
      overrides: Partial<Parameters<typeof composeProduction>[0]> = {},
    ) =>
      composeProduction({
        mode: "production",
        host: "127.0.0.1",
        databaseUrl: process.env.OCC_TEST_DATABASE_URL!,
        authSecret: "synthetic-auth-secret-at-least-32-bytes",
        authBaseURL: "http://127.0.0.1:3000",
        drivers,
        ...overrides,
      });
    await assert.rejects(compose(runtime, { nativeAdmin: { enabled: true } }), /guarded GitHub/);
    await assert.rejects(
      compose(runtime, {
        github: {
          clientId: "synthetic-client",
          clientSecret: "synthetic-secret",
          recoveryUserId: "synthetic-user",
        },
      }),
      /guarded GitHub/,
    );
    // Prove fresh logical provisioning serves API readiness without changing it.
    // Recovery below uses the existing ready fixture: the read-only Kubernetes
    // peer does not implement tenant provisioning writes.
    physicalLogicalId = freshNamespace.id;
    namespaceName = `oce-${hash(freshNamespace.id, 15)}`;
    const provisioningApi = await compose(
      await load({ ...selected, namespaceId: freshNamespace.id }),
    );
    try {
      assert.equal(
        (await provisioningApi.inject({ method: "GET", url: "/readyz" })).statusCode,
        200,
      );
      assert.equal(
        (await state.read((view) => view.namespaces.findNamespace(freshNamespace.id)))?.status,
        "provisioning",
      );
    } finally {
      await provisioningApi.close();
    }
    physicalLogicalId = selected.namespaceId;
    namespaceName = `oce-${hash(selected.namespaceId, 15)}`;
    const api = await compose();
    t.after(() => api.close());
    assert.equal((await api.inject({ method: "GET", url: "/readyz" })).statusCode, 200);
    assert.ok(reads.includes(`GET /api/v1/namespaces/${namespaceName}`));
    assert.deepEqual(unexpected, []);
    // Exhaust one direct peer's budget without time-dependent refill. Queries
    // still execute against PostgreSQL; the spy observes, rather than replaces, them.
    let probeTime = performance.now();
    const clock = t.mock.method(performance, "now", () => probeTime);
    const queries = t.mock.method(Pool.prototype, "query");
    const noisyPeer = { method: "GET" as const, url: "/readyz", remoteAddress: "192.0.2.1" };
    try {
      for (let i = 0; i < 10; i++) {
        assert.equal((await api.inject(noisyPeer)).statusCode, 200);
      }
      const queryCount = queries.mock.callCount();
      const readCount = reads.length;
      const denied = await api.inject({
        ...noisyPeer,
        headers: { "x-forwarded-for": "192.0.2.99" },
      });
      assert.equal(denied.statusCode, 429);
      assert.equal(denied.headers["retry-after"], "1");
      assert.equal((await api.inject({ ...noisyPeer, url: "/healthz" })).statusCode, 200);
      assert.equal(queries.mock.callCount(), queryCount, "denial and liveness do no database work");
      assert.equal(reads.length, readCount, "denial and liveness do no Kubernetes work");
      assert.equal(
        (await api.inject({ ...noisyPeer, remoteAddress: "192.0.2.2" })).statusCode,
        200,
      );
      assert.ok(queries.mock.callCount() > queryCount);
      assert.ok(reads.length > readCount, "a second peer performs fresh readiness checks");
      // The advertised retry admits a real probe and observes changed identity.
      probeTime += 1000;
      physicalUid = randomUUID();
      const readsBeforeRetry = reads.length;
      assert.equal((await api.inject(noisyPeer)).statusCode, 500);
      assert.ok(reads.length > readsBeforeRetry);
    } finally {
      clock.mock.restore();
      queries.mock.restore();
      physicalUid = selected.uid;
    }
    physicalUid = randomUUID();
    assert.notEqual((await api.inject({ method: "GET", url: "/readyz" })).statusCode, 200);
    await assert.rejects(compose(), /Namespace|namespace|403|404/);
    physicalUid = selected.uid;
    namespaceStatus = 403;
    await assert.rejects(compose(), /Namespace|namespace|403|404/);
    namespaceStatus = 404;
    await assert.rejects(compose(), /Namespace|namespace|403|404/);
    namespaceStatus = 200;
    physicalPhase = "Terminating";
    await assert.rejects(compose(), /Namespace|namespace/);
    physicalPhase = "Active";
    await assert.rejects(
      compose(await load({ ...selected, installationId: binding.installationId })),
      /original Installation/,
    );
    const deletingNamespace = {
      ...freshNamespace,
      id: `ns_${randomUUID()}`,
      name: `deleting-${randomUUID()}`,
      status: "deleting" as const,
    };
    await state.transact((unit) => unit.namespaces.createNamespace(deletingNamespace));
    await assert.rejects(
      compose(await load({ ...selected, namespaceId: deletingNamespace.id })),
      /provisioning or ready/,
    );
    await assert.rejects(
      compose(await load({ ...selected, namespaceId: `ns_${randomUUID()}` })),
      /OCE-owned logical Namespace/,
    );
    assert.equal((await api.inject({ method: "GET", url: "/readyz" })).statusCode, 200);

    // Stock Health is public. Only GetCurrentUser checks the configured bearer;
    // permissive stock deployments can instead return a local_dev principal.
    const grpc = require("@grpc/grpc-js");
    const loader = require("@grpc/proto-loader");
    const proto = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
      { keepCase: true, enums: String },
    );
    const service = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
    const gateway = new grpc.Server();
    let healthCode = 14;
    let healthCalls = 0;
    let identityCode = 0;
    let identityCalls = 0;
    let identityRefusals = 0;
    let identity: { subject?: string; identity_provider?: string } = {
      subject: "synthetic-caller",
      identity_provider: "oidc",
    };
    let holdIdentity = false;
    let identityCancelled = false;
    let expectedGatewayToken = "synthetic-gateway-identity";
    gateway.addService(service.service, {
      Health(_call: unknown, callback: (error: unknown, value?: unknown) => void) {
        healthCalls++;
        callback(healthCode ? { code: healthCode, details: "synthetic readiness" } : null, {
          status: "SERVICE_STATUS_HEALTHY",
        });
      },
      GetCurrentUser(
        call: { metadata: { get(key: string): string[] }; on(event: string, fn: () => void): void },
        callback: (error: unknown, value?: unknown) => void,
      ) {
        identityCalls++;
        if (holdIdentity) {
          call.on("cancelled", () => {
            identityCancelled = true;
          });
          return;
        }
        if (
          identity.identity_provider !== "local_dev" &&
          call.metadata.get("authorization")[0] !== `Bearer ${expectedGatewayToken}`
        ) {
          identityRefusals++;
          callback({ code: 16, details: "Synthetic identity unavailable" });
          return;
        }
        callback(
          identityCode ? { code: identityCode, details: "synthetic identity read" } : null,
          identity,
        );
      },
    });
    const port = await new Promise<number>((resolve, reject) =>
      gateway.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createSsl(null, [
          { private_key: Buffer.from(tls.key), cert_chain: Buffer.from(tls.cert) },
        ]),
        (error: Error | null, value: number) => (error ? reject(error) : resolve(value)),
      ),
    );
    t.after(() => gateway.forceShutdown());
    const tokenPath = join(tls.directory, "gateway-token");
    await writeFile(tokenPath, "synthetic-gateway-identity", { mode: 0o600 });
    Object.assign(configuration.backend[0]!.configuration, {
      endpoint: `https://localhost:${port}`,
      rootCertificatePath: tls.rootCertificatePath,
      auth: { mode: "bearerTokenFile", path: tokenPath },
    });
    delete (configuration.backend[0]!.configuration as { insecureTransport?: string })
      .insecureTransport;
    const gated = await load({ ...selected, startupCycle: "gateway-readiness" });
    assert.ok(gated.startupDependency);
    assert.equal(await gated.startupDependency.check(AbortSignal.timeout(2000)), "pending");
    assert.equal(identityCalls, 0, "an unavailable gateway cannot pass startup");
    healthCode = 0;
    expectedGatewayToken = "synthetic-rotated-gateway-identity";
    assert.equal(
      await gated.startupDependency.check(AbortSignal.timeout(2000)),
      "identity-unavailable",
    );
    // A caller can select a permissive gateway that ignores the revoked bearer.
    // Its successful local_dev response must still leave the startup gate closed.
    identity = { subject: "unauthenticated-local-dev", identity_provider: "local_dev" };
    assert.equal(
      await gated.startupDependency.check(AbortSignal.timeout(2000)),
      "identity-unavailable",
    );
    await writeFile(tokenPath, expectedGatewayToken, { mode: 0o600 });
    for (const invalid of [
      {},
      { subject: " ", identity_provider: "oidc" },
      { subject: "synthetic-caller" },
      { subject: "synthetic-caller", identity_provider: "unknown" },
      { subject: "synthetic-caller", identity_provider: "mtls" },
    ]) {
      identity = invalid;
      assert.equal(
        await gated.startupDependency.check(AbortSignal.timeout(2000)),
        "identity-unavailable",
      );
    }
    identity = { subject: "synthetic-caller", identity_provider: "cloudflare_access" };
    assert.equal(await gated.startupDependency.check(AbortSignal.timeout(2000)), "ready");
    identity.identity_provider = "oidc";
    assert.equal(await gated.startupDependency.check(AbortSignal.timeout(2000)), "ready");
    for (const [code, expected] of [
      [14, "pending"],
      [4, "pending"],
      [16, "identity-unavailable"],
      [7, "forbidden"],
      [12, "identity-unavailable"],
      [0, "ready"],
    ] as const) {
      identityCode = code;
      assert.equal(await gated.startupDependency.check(AbortSignal.timeout(2000)), expected);
    }
    // Abort the real in-flight identity RPC, rather than converting cancellation to readiness.
    holdIdentity = true;
    const abort = new AbortController();
    const callsBeforeAbort = identityCalls;
    const checking = gated.startupDependency.check(abort.signal);
    const cancelled = assert.rejects(checking, /synthetic cancellation/);
    await waitFor(
      "identity RPC in flight",
      async () => identityCalls > callsBeforeAbort || undefined,
    );
    abort.abort(new Error("synthetic cancellation"));
    await cancelled;
    await waitFor("identity RPC cancelled", async () => identityCancelled || undefined);
    holdIdentity = false;
    for (const scheme of ["HTTPS", "hTtPs"]) {
      Object.assign(configuration.backend[0]!.configuration, {
        endpoint: `${scheme}://localhost:${port}`,
      });
      const { startupDependency } = await load({ ...selected, startupCycle: "gateway-readiness" });
      assert.ok(startupDependency);
      const before = healthCalls;
      const beforeIdentity: number = identityCalls;
      assert.equal(await startupDependency.check(AbortSignal.timeout(2000)), "ready");
      assert.equal(healthCalls, before + 1);
      assert.equal(identityCalls, beforeIdentity + 1);
    }
    // A bare address is valid for the Backend, but cannot satisfy this TLS startup gate.
    Object.assign(configuration.backend[0]!.configuration, {
      endpoint: "[::1]:443",
      insecureTransport: "network-policy",
    });
    await assert.rejects(
      load({ ...selected, startupCycle: "gateway-readiness" }),
      /authenticated TLS gateway readiness check/,
    );
    const queue = new PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 100,
      maxAttempts: 2,
    });
    const workKey = `named-runtime-${randomUUID()}`;
    await queue.enqueue({
      idempotencyKey: workKey,
      namespaceId: selected.namespaceId,
      namespaceTarget: "ready",
      actorId: fixture.actor.id,
      availableAt: new Date(0),
    });
    assert.ok(await queue.claim());
    const initialKey = `named-initial-${randomUUID()}`;
    await queue.enqueue({
      idempotencyKey: initialKey,
      namespaceId: selected.namespaceId,
      namespaceTarget: "ready",
      actorId: fixture.actor.id,
    });
    const snapshot = async (key = workKey) =>
      (
        await fixture.observerPool.query(
          "SELECT state, attempt_count, claim_token, lease_expires_at, created_at, row_to_json(w)::text AS row_bytes FROM occ.controller_work w WHERE idempotency_key = $1",
          [key],
        )
      ).rows[0];
    await delay(150);
    const before = await snapshot();
    const beforeInitial = await snapshot(initialKey);
    const events: Record<string, unknown>[] = [];
    healthCode = 14;
    const startWorker = async (drivers = gated, timeout = 900_000, maxAttempts = 2) => {
      const worker = createControllerWorker({
        pool: new Pool({ connectionString: process.env.OCC_TEST_DATABASE_URL }),
        mode: "production",
        drivers,
        pollIntervalMs: 20,
        convergenceTimeoutMs: timeout,
        leaseDurationMs: 5000,
        maxAttempts,
        emit: (event) => {
          events.push(event);
        },
      });
      await worker.start();
      return worker;
    };
    worker = await startWorker();
    await waitFor(
      "pending gateway health",
      async () => events.some((e) => e.status === "pending") || undefined,
    );
    assert.deepEqual(await snapshot(), before, "expired claim is not recovered while gated");
    assert.equal((await queue.findWork(initialKey))?.attemptCount, 0);
    assert.equal((await queue.findWork(initialKey))?.state, "queued");
    await worker.stop();
    events.length = 0;
    worker = await startWorker();
    await waitFor(
      "restart closes recovery",
      async () => events.some((e) => e.status === "pending") || undefined,
    );
    assert.deepEqual(await snapshot(), before);
    physicalUid = randomUUID();
    healthCode = 0;
    await waitFor(
      "changed UID closes gate",
      async () => events.some((e) => e.status === "identity-unavailable") || undefined,
    );
    assert.deepEqual(await snapshot(), before);
    // Health now succeeds, but the nonempty owning token file holds a revoked bearer.
    // Neither expired claimed work nor fresh queued work may change before rotation.
    expectedGatewayToken = "synthetic-worker-rotated-identity";
    const refusalsBefore = identityRefusals;
    physicalUid = selected.uid;
    // Both failures report identity-unavailable only on transition. Observe the worker
    // polling again after an actual refused identity read, then check the durable work.
    await waitFor(
      "healthy gateway refuses revoked bearer and worker remains gated",
      async () => identityRefusals >= refusalsBefore + 2 || undefined,
    );
    assert.deepEqual(await snapshot(), before, "revoked bearer cannot release an expired claim");
    assert.deepEqual(
      await snapshot(initialKey),
      beforeInitial,
      "revoked bearer cannot claim fresh work",
    );
    await writeFile(tokenPath, expectedGatewayToken, { mode: 0o600 });
    await waitFor(
      "readiness releases original recovery",
      async () =>
        ((await snapshot()).state === "succeeded" &&
          (await queue.findWork(initialKey))?.state === "succeeded") ||
        undefined,
    );
    await worker.stop();
    assert.equal((await snapshot()).created_at.getTime(), before.created_at.getTime());
    assert.equal((await snapshot()).attempt_count, 2);
    assert.equal((await queue.findWork(initialKey))?.attemptCount, 1);
    assert.equal(
      reads.some((r) => r === "GET /api/v1/namespaces" || !r.startsWith("GET ")),
      false,
    );

    // Fault-inject unknown age through the migrator; the application cannot alter it.
    // Positive old work with an expired final lease receives normal recovery disposition.
    const migrator = new Pool({ connectionString: process.env.OCC_MIGRATION_DATABASE_URL });
    t.after(() => migrator.end());
    for (const age of ["infinity", "2000-01-01T00:00:00Z"]) {
      const key = `named-age-${randomUUID()}`;
      await queue.enqueue({
        idempotencyKey: key,
        namespaceId: selected.namespaceId,
        namespaceTarget: "ready",
        actorId: fixture.actor.id,
      });
      await migrator.query(
        "UPDATE occ.controller_work SET created_at = $2 WHERE idempotency_key = $1",
        [key, age],
      );
      if (age !== "infinity") {
        const oldClaim = await queue.claim();
        assert.equal(oldClaim?.idempotencyKey, key);
        await delay(150);
      }
      events.length = 0;
      worker = await startWorker(gated, 1000, 1);
      await waitFor(
        "age disposition",
        async () =>
          events.some(
            (e) => e.status === (age === "infinity" ? "work-age-unknown" : "work-too-old"),
          ) || undefined,
      );
      if (age === "infinity") {
        assert.equal(
          (
            await fixture.observerPool.query(
              "SELECT attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
              [key],
            )
          ).rows[0].attempt_count,
          0,
        );
        await worker.stop();
        await migrator.query(
          "UPDATE occ.controller_work SET created_at = clock_timestamp() WHERE idempotency_key = $1",
          [key],
        );
        const beforeIndependent = healthCalls;
        const identityBeforeIndependent: number = identityCalls;
        healthCode = 14;
        events.length = 0;
        worker = await startWorker(runtime);
        await waitFor(
          "independent work completes without gateway readiness",
          async () => (await queue.findWork(key))?.state === "succeeded" || undefined,
        );
        await worker.stop();
        assert.equal(healthCalls, beforeIndependent);
        assert.equal(identityCalls, identityBeforeIndependent);
        assert.equal(
          events.some((event) => event.event === "worker.startup-gate"),
          false,
        );
        healthCode = 0;
      } else {
        await waitFor(
          "old work terminal",
          async () => (await queue.findWork(key))?.state === "failed_permanent" || undefined,
        );
        await worker.stop();
        assert.equal((await queue.findWork(key))?.attemptCount, 1);
      }
    }
  },
);
