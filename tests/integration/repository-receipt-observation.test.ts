import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import test from "node:test";
import { createSecureContext } from "node:tls";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import type { PreparedRepositoryBackendFactory } from "../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import {
  createControlAdmission,
  handleControl,
} from "../../apps/controller/src/drivers/repo/credentials/control.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import type { SessionStatus } from "../../apps/controller/src/drivers/repo/credentials/service-contracts.ts";
import { createAgentHandler } from "../../apps/controller/src/drivers/repo/credentials/transport/agent.ts";
import { createGatewayAuthentication } from "../../apps/controller/src/drivers/repo/github/credentials/gateway-authentication.ts";
import { planDraftPull } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-draft-pull.ts";
import { serviceConfigurationData } from "../fixtures/repository-credentials/builders.mjs";
import {
  createTlsMaterial,
  listen as listenOrigin,
} from "../fixtures/repository-credentials/process.mjs";
import { startReceiptState } from "../fixtures/repository-credentials/receipt-state.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";

async function body(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listen(server: Server, path: string) {
  server.listen(path);
  await once(server, "listening");
}

for (const delivery of [
  "before",
  "after",
  "wrong-session",
  "stale-state",
  "expiry-identify",
  "expiry-reserve",
] as const) {
  test(`status observes the original receipt without mutation: ${delivery}`, async (t) => {
    const resources = createTestResourceScope(t);
    const broker = await socketDirectory(resources, "receipt-broker-");
    const owner = await socketDirectory(resources, "receipt-owner-");
    const controlSocket = join(broker, "control.sock");
    const binding = {
      providerInstanceId: "provider",
      repositoryId: "repository",
      grantId: "grant",
    };
    const namespaceId = `ns_${randomUUID()}`;
    const wall = Date.now();
    const admissionId = `${wall}-${randomUUID()}`;
    const deadlineWallMs = wall + 30_000;
    const fixture = {
      namespaceId,
      backendId: "backend",
      config: { gateway: { controlSocket: join(owner, "control.sock") } },
    };
    const receipt = await startReceiptState(
      resources,
      fixture,
      [{ repositoryRef: "project", profile: "read", backendId: fixture.backendId, grant: binding }],
      deadlineWallMs,
    );
    await receipt.prepare(admissionId, "project", 60);
    const wire: string[] = [];
    let receiptUnavailable = false;
    const relay = createServer(async (incoming, response) => {
      const bytes = await body(incoming);
      const { kind, sessionId } = JSON.parse(bytes.toString()) as {
        kind: string;
        sessionId?: string;
      };
      wire.push(kind);
      if (kind === "status" && receiptUnavailable) {
        response.destroy();
        return;
      }
      if (kind === "dispose" && delivery === "before") {
        response.destroy();
        return;
      }
      const outgoing = request({
        socketPath: join(owner, "receipt.sock"),
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      });
      const connected = once(outgoing, "response");
      outgoing.end(bytes);
      const [reply] = await connected;
      const result = await body(reply);
      if (
        kind === "dispose" &&
        (delivery === "after" || delivery === "wrong-session" || delivery === "stale-state")
      ) {
        response.destroy();
        return;
      }
      if (kind === "status" && (delivery === "wrong-session" || delivery === "stale-state")) {
        assert.equal(reply.statusCode, 200);
        const captured = JSON.parse(result.toString()) as { kind: string; status: SessionStatus };
        assert.equal(captured.kind, "disposed");
        assert.equal(captured.status.sessionId, sessionId);
        assert.equal(captured.status.state, "DISPOSED");
        const status = {
          ...captured.status,
          ...(delivery === "wrong-session"
            ? { sessionId: `wrong-${captured.status.sessionId}` }
            : { state: "OPEN" }),
        };
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ...captured, status }));
        return;
      }
      response.writeHead(reply.statusCode, reply.headers).end(result);
    });
    resources.after(() => relay[Symbol.asyncDispose]());
    await listen(relay, join(broker, "receipt.sock"));
    let wallElapsed = 0;
    let monotonicElapsed = 0;
    const clock = {
      wallNow: () => wall + wallElapsed,
      monotonicNow: () => monotonicElapsed,
      schedule: () => () => {},
    };
    let plans = 0;
    const config = validateServiceConfig(
      serviceConfigurationData({
        gateway: { controlSocket, publicOrigin: "https://git.example", listen: "127.0.0.1:443" },
        sessionPolicy: {
          defaultProfile: "read",
          allowedProfiles: ["read"],
          maximumDurationSeconds: 60,
        },
      }),
    );
    const service = createCredentialService({
      config,
      clock,
      factory: {
        resolve: () => {
          throw new Error("unbound selection is unavailable");
        },
        resolveBound: () => ({
          binding,
          client: {
            gatewayOrigin: "https://git.example",
            gitRemote: "https://git.example/a/b.git",
            gitUsername: "git",
            canonicalApiHost: "api.example",
            apiHost: "git.example",
            repository: "a/b",
          },
        }),
        parseAuthentication: () => ({ kind: "denied", status: 401, code: "unused" }),
        unauthenticated: () => ({ kind: "denied", status: 401, code: "unused" }),
        createPrepared: () => ({
          binding,
          plan: () => {
            plans++;
            return { kind: "denied", status: 403, code: "unused" };
          },
          authorize: async () => {
            throw new Error("unused");
          },
        }),
      },
    });
    const admissions = createControlAdmission(service, config, clock, true, true);
    resources.after(() => admissions.dispose());
    service.observeDisposal(admissions.observe);
    const server = createServer((incoming, response) => {
      void handleControl(incoming, response, config, clock, admissions);
    });
    resources.after(() => server[Symbol.asyncDispose]());
    await listen(server, controlSocket);
    const client = new UnixRepositoryCredentialControlClient({ controlSocket });
    const opened = await client.open(
      {
        expectedBinding: binding,
        namespaceId,
        repositoryRef: "project",
        profile: "read",
        durationSeconds: 60,
        deadlineWallMs,
        preparedOnly: true,
        durableAdmission: true,
      },
      admissionId,
      AbortSignal.timeout(5_000),
    );
    assert.equal(opened.kind, "created");
    if (opened.kind !== "created") {
      throw new Error("session was not created");
    }
    const session = opened.result.session;
    const stored = () =>
      receipt.state.read((view) => view.repositorySessions.findBrokerReceipt(admissionId));
    if (delivery === "expiry-identify" || delivery === "expiry-reserve") {
      const split = wire.length;
      assert.equal(
        (await client.status(session.sessionId, AbortSignal.timeout(5_000)))?.state,
        "OPEN",
      );
      assert.notEqual(service.identify(opened.result.bearer), undefined);
      // Wall time reaches the absolute deadline before the monotonic lease expires.
      wallElapsed = 31_000;
      monotonicElapsed = 1_000;
      assert.equal(
        (await client.status(session.sessionId, AbortSignal.timeout(5_000)))?.state,
        "CLOSED",
      );
      wallElapsed = 2_000;
      monotonicElapsed = 2_000;
      for (let index = 0; index < 2; index++) {
        assert.equal(
          (await client.status(session.sessionId, AbortSignal.timeout(5_000)))?.state,
          "CLOSED",
        );
      }
      assert.deepEqual(wire.slice(split), [], "observation must not initiate cleanup");
      assert.equal((await stored())?.state, "active");
      const identify = () => assert.equal(service.identify(opened.result.bearer), undefined);
      const reserve = () =>
        assert.deepEqual(
          service.reserve(
            opened.result.bearer,
            {
              method: "GET",
              rawTarget: "/",
              headers: {},
              receivedMonoMs: monotonicElapsed,
              contentEncoding: "identity",
              framing: { kind: "none", bytes: undefined },
            },
            AbortSignal.timeout(5_000),
          ),
          { kind: "denied", status: 401, code: "session-unavailable" },
        );
      // Each authorization entry point must reject when it is the first post-observation use.
      if (delivery === "expiry-identify") {
        identify();
        reserve();
      } else {
        reserve();
        identify();
      }
      assert.equal(plans, 0, "an expired bearer must not reach request planning");
      await admissions.flush();
      assert.equal(
        (await stored())?.state,
        "disposed",
        "expiry enforcement retains cleanup ownership",
      );
      assert.equal(wire.filter((kind) => kind === "dispose").length, 1);
      return;
    }
    await assert.rejects(client.close(session.sessionId, AbortSignal.timeout(5_000)), {
      name: "RepositoryCredentialControlError",
      retryable: true,
    });
    assert.equal((await stored())?.state, delivery === "before" ? "active" : "disposed");
    const split = wire.length;
    for (let index = 0; index < 2; index++) {
      if (delivery === "after") {
        assert.deepEqual(await client.status(session.sessionId, AbortSignal.timeout(5_000)), {
          ...session,
          state: "DISPOSED",
        });
      } else {
        await assert.rejects(client.status(session.sessionId, AbortSignal.timeout(5_000)), {
          name: "RepositoryCredentialControlError",
          retryable: true,
        });
      }
    }
    assert.deepEqual(wire.slice(split), ["status", "status"]);
    if (delivery === "after") {
      // Once the correlation window ends, repeated close must still consult the
      // original receipt while the service retains the disposed session.
      monotonicElapsed = 61_000;
      const closeStart = wire.length;
      for (let index = 0; index < 2; index++) {
        assert.deepEqual(await client.close(session.sessionId, AbortSignal.timeout(5_000)), {
          ...session,
          state: "DISPOSED",
        });
      }
      assert.deepEqual(wire.slice(closeStart), ["status", "status"]);
      receiptUnavailable = true;
      await assert.rejects(client.close(session.sessionId, AbortSignal.timeout(5_000)), {
        name: "RepositoryCredentialControlError",
        retryable: true,
      });
      assert.deepEqual(wire.slice(closeStart), ["status", "status", "status"]);
    } else {
      await assert.rejects(client.close(session.sessionId, AbortSignal.timeout(5_000)), {
        name: "RepositoryCredentialControlError",
        retryable: true,
      });
      assert.deepEqual(wire.slice(split), ["status", "status", "status"]);
    }
    assert.equal(wire.filter((kind) => kind === "dispose").length, 1);
    assert.equal((await stored())?.state, delivery === "before" ? "active" : "disposed");
  });
}

for (const stage of ["reserved", "authorizing", "dispatch"] as const) {
  test(`observed expiry denies a prepared exchange at ${stage}`, { timeout: 15_000 }, async (t) => {
    const resources = createTestResourceScope(t);
    const directory = await socketDirectory(resources, "receipt-expiry-");
    const controlSocket = join(directory, "control.sock");
    const agentSocket = join(directory, "agent.sock");
    const paused = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const tls = await createTlsMaterial(resources);
    const secureContext = createSecureContext(tls);
    let originRequests = 0;
    const originServer = createHttpsServer(
      {
        ...tls,
        SNICallback(_servername, callback) {
          if (stage === "dispatch") {
            // Hold verified TLS setup after the permit exists, before the sender's first write.
            paused.resolve();
            void released.promise.then(() => callback(null, secureContext));
          } else {
            callback(null, secureContext);
          }
        },
      },
      (_incoming, response) => {
        originRequests++;
        response.writeHead(500).end();
      },
    );
    const origin = (await listenOrigin(resources, originServer)).replace("127.0.0.1", "localhost");
    const startWall = Date.now();
    let wallElapsed = 0;
    let monotonicElapsed = 0;
    const clock = {
      wallNow: () => startWall + wallElapsed,
      monotonicNow: () => monotonicElapsed,
      schedule: () => () => {},
    };
    const binding = {
      providerInstanceId: "provider",
      repositoryId: "repository",
      grantId: "grant",
    };
    const operationId = randomUUID();
    const receipt = {
      kind: "recorded" as const,
      status: 409,
      body: { operationId, error: "not-submitted" },
    };
    let authorizations = 0;
    const settlements: unknown[] = [];
    const factory: PreparedRepositoryBackendFactory = {
      ...createGatewayAuthentication({ isGitRoute: () => false }),
      resolve: () => ({
        binding,
        client: {
          gatewayOrigin: "https://credentials.example",
          gitRemote: "https://credentials.example/a/b.git",
          gitUsername: "gateway-session",
          canonicalApiHost: "api.example",
          apiHost: "credentials.example",
          repository: "a/b",
        },
      }),
      createPrepared: () => ({
        binding,
        plan({ head }) {
          const plan = planDraftPull(
            head,
            {
              apiOrigin: origin,
              repository: "a/b",
              repositoryId: binding.repositoryId,
              head: "topic",
              base: "main",
            },
            () => {},
          );
          if (stage === "reserved") {
            paused.resolve();
          }
          return plan;
        },
        async authorize(plan) {
          authorizations++;
          if (stage === "authorizing") {
            paused.resolve();
            await released.promise;
          }
          return {
            headers: plan.requestHeaders,
            assertSendStart() {},
            async settle(result) {
              settlements.push(result);
              return receipt;
            },
          };
        },
      }),
    };
    const config = validateServiceConfig(serviceConfigurationData({ gateway: { controlSocket } }));
    const service = createCredentialService({ config, factory, clock });
    const opened = service.open({ durationSeconds: 30, profile: "git-write" });
    resources.after(() => service.close(opened.session.sessionId));
    let disposals = 0;
    service.observeDisposal(() => disposals++);
    const admissions = createControlAdmission(service, config, clock, false, true);
    resources.after(() => admissions.dispose());
    const control = createServer((incoming, response) => {
      void handleControl(incoming, response, config, clock, admissions);
    });
    resources.after(() => control[Symbol.asyncDispose]());
    await listen(control, controlSocket);
    const agent = createServer(
      createAgentHandler({
        config,
        service,
        factory,
        clock,
        trustedUpstreamOrigins: new Set([origin]),
        upstreamCa: tls.ca,
      }),
    );
    resources.after(() => agent[Symbol.asyncDispose]());
    await listen(agent, agentSocket);
    const payload = Buffer.from(
      JSON.stringify({ title: "Draft", head: "topic", base: "main", draft: true }),
    );
    const outgoing = request({
      socketPath: agentSocket,
      path: "/repos/a/b/pulls",
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        host: "credentials.example",
        authorization: `Bearer ${opened.bearer}`,
        "content-type": "application/json",
        "content-length": payload.length,
        "x-oce-operation-id": operationId,
      },
    });
    resources.after(() => {
      released.resolve();
      outgoing.destroy();
    });
    const responseReady = once(outgoing, "response");
    if (stage === "reserved") {
      outgoing.flushHeaders();
    } else {
      outgoing.end(payload);
    }
    await Promise.race([
      paused.promise,
      responseReady.then(() => {
        throw new Error("exchange responded before reaching the selected stage");
      }),
    ]);
    wallElapsed = 31_000;
    monotonicElapsed = 1_000;
    const client = new UnixRepositoryCredentialControlClient({ controlSocket });
    assert.equal(
      (await client.status(opened.session.sessionId, AbortSignal.timeout(5_000)))?.state,
      "CLOSED",
    );
    assert.equal(disposals, 0, "status observation must not initiate cleanup");
    wallElapsed = 2_000;
    monotonicElapsed = 2_000;
    if (stage === "reserved") {
      outgoing.end(payload);
    } else {
      released.resolve();
    }
    const [response] = await responseReady;
    const responseBody = JSON.parse((await body(response)).toString()) as unknown;
    assert.equal(authorizations, stage === "reserved" ? 0 : 1);
    assert.equal(originRequests, 0, "expired sessions must not write an origin request");
    if (stage === "reserved") {
      assert.equal(response.statusCode, 503);
      assert.deepEqual(settlements, []);
    } else {
      assert.equal(response.statusCode, receipt.status);
      assert.deepEqual(responseBody, receipt.body);
      assert.deepEqual(settlements, ["not-submitted"]);
    }
  });
}
