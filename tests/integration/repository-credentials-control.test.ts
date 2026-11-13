import { startReceiptState } from "../fixtures/repository-credentials/receipt-state.mjs";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, connect, Socket } from "node:net";
import { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  defaultRegistryRepositories,
  startRegistryCredentialServiceFixture,
} from "../fixtures/repository-credentials/registry.mjs";
import {
  createResourceScope,
  createTestResourceScope,
} from "../fixtures/repository-credentials/resources.mjs";
import {
  createServer as createTlsServer,
  request as tlsRequest,
  type RequestOptions,
} from "node:https";
import { startRegistryProviderFixtures } from "../fixtures/repository-credentials/registry/provider.ts";
import { chmod, lstat, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startAlternateUpstream } from "../fixtures/repository-credentials/alternate.mjs";
import { createAlternateFixtureFactory } from "../fixtures/repository-credentials/alternate-shape.ts";
import {
  fixtureRepository,
  type startGitHubFixture,
} from "../fixtures/repository-credentials/github.mjs";
import {
  createTlsMaterial,
  listen,
  temporaryDirectory,
  run,
} from "../fixtures/repository-credentials/process.mjs";
import {
  githubProviderModule,
  appModule,
  appRoot,
  appExtension,
  controlRequest,
  createServiceConfiguration,
  eventually,
  createLoopbackServiceConfiguration,
  startTokenServiceScope,
} from "../fixtures/repository-credentials/service.mjs";
import {
  createStaticTokenServiceFactory,
  startServiceListeners,
  startStaticTokenService,
} from "../fixtures/repository-credentials/service-resources.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";
import type {
  Clock,
  RepositoryBackendFactory,
} from "../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type { ControlRequest } from "../../apps/controller/src/drivers/repo/access/control-contracts.ts";
import type {
  CredentialServiceOwner,
  ExchangeOutcome,
} from "../../apps/controller/src/drivers/repo/access/internal-contracts.ts";
import type {
  RepositoryCredentialBoundSessionInput,
  ServiceConfig,
  ServiceLimits,
  SessionStatus,
} from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type { BoundListeners } from "../../apps/controller/src/drivers/repo/access/server.ts";
import type { GitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/state/platform-state.ts";

type ResourceOwner = Pick<TestContext, "after">;
type ControlledClock = Clock & { advance(milliseconds: number): Promise<void> };
type TokenScope<C extends Clock> = {
  resources: ResourceOwner;
  clock: C;
  config: ServiceConfig;
  tls: Awaited<ReturnType<typeof createTlsMaterial>>;
  github: Awaited<ReturnType<typeof startGitHubFixture>> | undefined;
};
type RegistryFixture = {
  clock: ControlledClock;
  config: ServiceConfig;
  registry: GitHubRepositoryRegistry;
  service: CredentialServiceOwner;
  namespaceId: string;
  backendId: string;
  repositories: readonly { github: { trace: readonly object[] } }[];
  restart(): Promise<void>;
};
type AlternateUpstream = {
  origin: string;
  accepted: Map<string, number>;
  trace: { committed?: boolean }[];
};
type RepositoryDefinition = Readonly<{
  repositoryRef: string;
  repository: string;
  repositoryId: string;
}>;
type SessionResult = {
  session: Record<string, unknown> & {
    sessionId: string;
    state: string;
    deadlineWallMs: number;
    binding: { grantId: string };
  };
  bearer: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function isSessionResult(value: unknown): value is SessionResult {
  return (
    isRecord(value) &&
    isRecord(value.session) &&
    isRecord(value.session.binding) &&
    typeof value.session.sessionId === "string" &&
    typeof value.session.state === "string" &&
    typeof value.session.deadlineWallMs === "number" &&
    typeof value.session.binding.grantId === "string" &&
    typeof value.bearer === "string"
  );
}

function sessionResult(value: unknown): SessionResult {
  assert.ok(isSessionResult(value));
  return value;
}

function currentStatus(service: CredentialServiceOwner, sessionId: string): SessionStatus {
  const status = service.status(sessionId);
  assert.ok(status);
  return status;
}

function isSessionStatus(
  value: unknown,
): value is Record<string, unknown> & { sessionId: string; state: string } {
  return isRecord(value) && typeof value.sessionId === "string" && typeof value.state === "string";
}

function sessionStatus(value: unknown) {
  assert.ok(isSessionStatus(value));
  return value;
}

// Session opens need an admission id; a fresh one per call unless the test names it.
const control = async (
  socketPath: string,
  method: string,
  path: string,
  value?: object,
  extra: Record<string, string> = {},
) => {
  const response: { status: number | undefined; body: unknown } = await controlRequest(
    socketPath,
    method,
    path,
    value,
    {
      ...(path === "/v1/sessions" ? { "x-admission-id": `${Date.now()}-${randomUUID()}` } : {}),
      ...extra,
    },
  );
  return { ...response, body: record(response.body) };
};

// The relay consumes the real listener's response but disconnects its caller,
// reproducing ambiguous loss after admission without replacing control behavior.
async function dropControlResponse(t: ResourceOwner, target: string) {
  const directory = await socketDirectory(t, "rcs-loss-");
  const socketPath = join(directory, "relay.sock");
  const sockets = new Set<Socket>();
  const { promise: receipt, resolve: admitted } = Promise.withResolvers<SessionResult>();
  const relay = createNetServer((caller) => {
    const upstream = connect(target);
    for (const socket of [caller, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    }
    const chunks: Buffer[] = [];
    upstream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      caller.destroy();
    });
    upstream.once("end", () => {
      const response = Buffer.concat(chunks).toString();
      admitted(sessionResult(JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4))));
    });
    caller.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => relay.close(resolve));
  });
  return { socketPath, receipt };
}

async function admissionFixture(t: TestContext, onCreate?: (sessionId: string) => void) {
  const scopeOptions = { limits: { sessions: 1 }, github: false };
  const { resources, clock, tls, config }: TokenScope<ControlledClock> =
    await startTokenServiceScope(t, scopeOptions);
  const {
    callControl,
  }: typeof import("../../apps/controller/src/drivers/repo/github/access/client/operator.ts") =
    await appModule("drivers/repo/github/access/client/operator");
  const upstreamOptions = { clock, tls };
  const upstream: AlternateUpstream = await startAlternateUpstream(resources, upstreamOptions);
  const driverFactory = createAlternateFixtureFactory({
    origin: upstream.origin,
    gatewayOrigin: config.gateway.publicOrigin,
    clock,
    accepted: upstream.accepted,
    lifetimeMs: 600_000,
  });
  const factory = onCreate
    ? {
        ...driverFactory,
        create(input: Parameters<RepositoryBackendFactory["create"]>[0]) {
          const driver = driverFactory.create(input);
          onCreate(input.authority.sessionId);
          return driver;
        },
      }
    : driverFactory;
  const { service, listeners }: { service: CredentialServiceOwner; listeners: BoundListeners } =
    await startServiceListeners(resources, {
      config,
      tls,
      factory,
      clock,
      upstreamOrigins: [upstream.origin],
      log: undefined,
    });
  return {
    resources,
    clock,
    tls,
    config,
    upstream,
    driverFactory,
    service,
    listeners,
    callControl,
  };
}

test(
  "lost control admission response recovers one session and never replays provider writes",
  { timeout: 15000 },
  async (t) => {
    const fixture = await admissionFixture(t);
    const { clock, config, service, callControl, driverFactory, upstream } = fixture;
    const relay = await dropControlResponse(fixture.resources, config.gateway.controlSocket);
    const admissionId = `${clock.wallNow()}-${randomUUID()}`;
    const input: ControlRequest = {
      method: "POST",
      path: "/v1/sessions",
      body: { durationSeconds: 3600, profile: "git-write" },
    };
    await assert.rejects(
      callControl(relay.socketPath, input, admissionId),
      /control-request-failed/,
    );
    const original = await relay.receipt;
    assert.equal(currentStatus(service, original.session.sessionId).state, "OPEN");
    const recover = () => callControl(config.gateway.controlSocket, input, admissionId);
    const [recovery, again] = await Promise.all([recover(), recover()]);
    const recovered = sessionStatus(recovery);
    assert.deepEqual(recovered, original.session);
    assert.deepEqual(again, original.session);
    assert.equal(recovered.bearer, undefined);
    assert.equal(driverFactory.drivers.length, 1);
    assert.deepEqual(
      await callControl(
        config.gateway.controlSocket,
        {
          ...input,
          body: { ...input.body, durationSeconds: 7200 },
        },
        admissionId,
      ),
      { error: "invalid-request" },
    );
    const freshId = () => `${clock.wallNow()}-${randomUUID()}`;
    assert.deepEqual(await callControl(config.gateway.controlSocket, input, freshId()), {
      error: "overloaded",
    });
    await callControl(config.gateway.controlSocket, {
      method: "POST",
      path: `/v1/sessions/${recovered.sessionId}/close`,
    });
    await clock.advance(0);
    await eventually(() => currentStatus(service, recovered.sessionId).state === "DISPOSED");
    assert.equal(sessionStatus(await recover()).state, "DISPOSED");
    // Reconciliation does not reissue a bearer. The operator explicitly replaces
    // the closed session, and the service recovers its capacity immediately.
    const replacementId = freshId();
    const replacement = sessionResult(
      await callControl(config.gateway.controlSocket, input, replacementId),
    );
    assert.notEqual(replacement.session.sessionId, recovered.sessionId);

    // The replacement performs one actual upstream mutation through the HTTPS owner.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = tlsRequest(
        {
          hostname: "127.0.0.1",
          port: fixture.listeners.address.port,
          path: "/team/nested/project",
          method: "POST",
          ca: fixture.tls.ca,
          agent: false,
          headers: {
            host: "credentials.example.test",
            authorization: `Bearer ${replacement.bearer}`,
            "content-type": "application/json",
            "content-length": "2",
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
        },
      );
      outgoing.once("error", reject);
      outgoing.end("{}");
    });
    assert.equal(status, 200);
    assert.equal(upstream.trace.length, 1);
    assert.equal(upstream.trace[0]?.committed, true);
    assert.deepEqual(await recover(), { error: "admission-missing" });
    assert.equal(
      sessionStatus(await callControl(config.gateway.controlSocket, input, replacementId))
        .sessionId,
      replacement.session.sessionId,
    );
    assert.equal(upstream.trace.length, 1, "admission recovery must never replay a provider write");
    await callControl(config.gateway.controlSocket, {
      method: "POST",
      path: `/v1/sessions/${replacement.session.sessionId}/close`,
    });
    await clock.advance(0);
    await eventually(
      () => currentStatus(service, replacement.session.sessionId).state === "DISPOSED",
    );
    assert.equal(upstream.accepted.size, 0);
    // The registry has one active allowance and one tombstone allowance per session.
    assert.deepEqual(await callControl(config.gateway.controlSocket, input, freshId()), {
      error: "overloaded",
    });
    await clock.advance(60_001);
    assert.deepEqual(await recover(), { error: "admission-missing" });
    const nextId = freshId();
    const next = sessionResult(await callControl(config.gateway.controlSocket, input, nextId));
    assert.equal(next.session.state, "OPEN");
    await clock.advance(3_600_001);
    assert.deepEqual(await callControl(config.gateway.controlSocket, input, nextId), {
      error: "admission-missing",
    });
    const afterExpiry = sessionResult(
      await callControl(config.gateway.controlSocket, input, freshId()),
    );
    assert.equal(afterExpiry.session.state, "OPEN");
    assert.equal(driverFactory.drivers.length, 4);
  },
);

test(
  "known control nondelivery closes the actual admitted session",
  { timeout: 10000 },
  async (t) => {
    const requests = channel("http.server.request.start");
    let socket: Socket | undefined;
    let sessionId: string | undefined;
    const observe = (event: unknown) => {
      const message = record(event);
      if (message.request instanceof IncomingMessage && message.request.url === "/v1/sessions") {
        assert.ok(message.socket instanceof Socket);
        socket = message.socket;
      }
    };
    requests.subscribe(observe);
    t.after(() => requests.unsubscribe(observe));
    const fixture = await admissionFixture(t, (id) => {
      sessionId = id;
      // Destroy the actual protected-listener socket during real driver construction,
      // before the handler can hand any admission response bytes to the transport.
      assert.ok(socket);
      socket.destroy();
    });
    const input: ControlRequest = {
      method: "POST",
      path: "/v1/sessions",
      body: { durationSeconds: 3600, profile: "git-write" },
    };
    const admissionId = `${fixture.clock.wallNow()}-${randomUUID()}`;
    await assert.rejects(
      fixture.callControl(fixture.config.gateway.controlSocket, input, admissionId),
      /control-request-failed/,
    );
    await fixture.clock.advance(0);
    assert.ok(sessionId);
    const admittedSessionId = sessionId;
    await eventually(() => currentStatus(fixture.service, admittedSessionId).state === "DISPOSED");
    const recovered = sessionStatus(
      await fixture.callControl(fixture.config.gateway.controlSocket, input, admissionId),
    );
    assert.equal(recovered.state, "DISPOSED");
    assert.equal(recovered.sessionId, sessionId);
    assert.equal(recovered.bearer, undefined);
    assert.equal(fixture.driverFactory.drivers.length, 1);
    assert.equal(fixture.upstream.trace.length, 0);
  },
);

test(
  "private control socket opens, inspects and closes real sessions with bounded input",
  { timeout: 10000 },
  async (t) => {
    const scopeOptions: { clock: "system"; github?: boolean } = { clock: "system" };
    const { resources, clock, tls, config, github }: TokenScope<Clock> =
      await startTokenServiceScope(t, scopeOptions);
    assert.ok(github);
    const { listeners }: { listeners: BoundListeners } = await startStaticTokenService(resources, {
      config,
      clock,
      tls,
      github,
    });
    assert.equal((await lstat(config.gateway.controlSocket)).mode & 0o777, 0o600);
    // Standalone services do not implement registry-backed durable admission.
    assert.equal(
      (await control(config.gateway.controlSocket, "GET", "/v1/capabilities")).status,
      404,
    );
    const opened = await control(config.gateway.controlSocket, "POST", "/v1/sessions", {
      durationSeconds: 86400,
    });
    assert.equal(opened.status, 201);
    const openedBody = sessionResult(opened.body);
    assert.equal(openedBody.session.state, "OPEN");
    assert.match(openedBody.session.binding.grantId, /^sha256:[a-f0-9]{64}$/);
    assert.ok(openedBody.bearer.length >= 43);
    const id = openedBody.session.sessionId;
    const status = await control(config.gateway.controlSocket, "GET", `/v1/sessions/${id}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.sessionId, id);
    assert.equal(status.body.bearer, undefined);
    const closed = await control(config.gateway.controlSocket, "POST", `/v1/sessions/${id}/close`);
    assert.equal(closed.status, 200);
    assert.notEqual(closed.body.state, "OPEN");
    assert.equal(closed.body.bearer, undefined);
    const invalidInputs = [
      {
        name: "unrecognized read-write profile",
        input: { durationSeconds: 86400, profile: "read-write" },
        status: 400,
      },
      {
        name: "unrecognized app-full profile",
        input: { durationSeconds: 86400, profile: "app-full" },
        status: 400,
      },
      { name: "zero duration", input: { durationSeconds: 0 }, status: 400 },
      {
        name: "caller-selected provider",
        input: { durationSeconds: 86400, provider: "caller-selected" },
        status: 400,
      },
      { name: "oversized control body", input: { padding: "x".repeat(17000) }, status: 413 },
    ];
    for (const scenario of invalidInputs) {
      await t.test(scenario.name, async () => {
        const response = await control(
          config.gateway.controlSocket,
          "POST",
          "/v1/sessions",
          scenario.input,
        );
        assert.equal(response.status, scenario.status);
      });
    }
    const agentStatus = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = tlsRequest(
        {
          hostname: "127.0.0.1",
          port: listeners.address.port,
          path: "/v1/sessions",
          ca: tls.ca,
          headers: { host: "credentials.example.test" },
          agent: false,
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
    assert.equal(agentStatus, 401);
    const clientParent = await temporaryDirectory(resources);
    const clientDirectory = join(clientParent, "session");
    const operator = join(appRoot, "drivers/repo/github/access/client", `operator.${appExtension}`);
    const relay = await dropControlResponse(resources, config.gateway.controlSocket);
    const admissionId = `${Date.now()}-${randomUUID()}`;
    const failed = await run(
      process.execPath,
      [
        operator,
        "open",
        "--socket",
        relay.socketPath,
        "--duration-seconds",
        "86400",
        "--profile",
        "git-write",
        "--output",
        clientDirectory,
        "--admission-id",
        admissionId,
      ],
      { allowFailure: true },
    );
    assert.equal(failed.code, 1);
    assert.ok(failed.stderr.includes(admissionId));
    const admitted = await relay.receipt;
    const cliRecovered = await run(process.execPath, [
      operator,
      "open",
      "--socket",
      config.gateway.controlSocket,
      "--duration-seconds",
      "86400",
      "--profile",
      "git-write",
      "--output",
      clientDirectory,
      "--admission-id",
      admissionId,
    ]);
    const recovered = sessionStatus(JSON.parse(cliRecovered.stdout));
    assert.equal(recovered.sessionId, admitted.session.sessionId);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.bearer, undefined);
    await run(process.execPath, [
      operator,
      "close",
      "--socket",
      config.gateway.controlSocket,
      "--session",
      recovered.sessionId,
    ]);
    const cliOpened = await run(process.execPath, [
      operator,
      "open",
      "--socket",
      config.gateway.controlSocket,
      "--duration-seconds",
      "86400",
      "--profile",
      "git-write",
      "--output",
      clientDirectory,
      "--ca",
      tls.certFile,
    ]);
    const cliSession = sessionStatus(JSON.parse(cliOpened.stdout));
    const clientBearer = (await readFile(join(clientDirectory, "bearer"), "utf8")).trim();
    assert.equal(cliSession.state, "OPEN");
    assert.notEqual(cliSession.sessionId, admitted.session.sessionId);
    assert.notEqual(clientBearer, admitted.bearer);
    assert.ok(!cliOpened.stdout.includes(clientBearer) && !cliOpened.stderr.includes(clientBearer));
    const cliClosed = await run(process.execPath, [
      operator,
      "close",
      "--socket",
      config.gateway.controlSocket,
      "--session",
      cliSession.sessionId,
    ]);
    assert.notEqual(record(JSON.parse(cliClosed.stdout)).state, "OPEN");
    assert.ok(!cliClosed.stdout.includes(clientBearer));
  },
);

test(
  "control startup rejects unsafe parents and refuses existing paths",
  { timeout: 10000 },
  async (t) => {
    const [{ createSystemClock }, { createCredentialService }, { startListeners }]: [
      typeof import("../../apps/controller/src/drivers/repo/access/clock.ts"),
      typeof import("../fixtures/repository-credentials/service.ts"),
      typeof import("../../apps/controller/src/drivers/repo/access/server.ts"),
    ] = await Promise.all([
      appModule("drivers/repo/access/clock"),
      import("../fixtures/repository-credentials/service.ts"),
      appModule("drivers/repo/access/server"),
    ]);
    const clock = createSystemClock();
    const tls = await createTlsMaterial(t);
    const base: ServiceConfig = await createServiceConfiguration(t);
    const directory = await socketDirectory(t, "rcs-control-");
    const target = join(directory, "control.sock");
    const config = {
      ...base,
      gateway: { ...base.gateway, listen: "127.0.0.1:0", controlSocket: target },
    };
    const factory = createAlternateFixtureFactory({
      origin: "https://upstream.example.test",
      gatewayOrigin: config.gateway.publicOrigin,
      clock,
    });
    const service = createCredentialService({ config, factory, clock });
    const options = {
      config,
      tls,
      service,
      factory,
      clock,
      trustedUpstreamOrigins: new Set<string>(),
    };
    await chmod(directory, 0o755);
    await assert.rejects(startListeners(options), /unsafe-control-directory/);
    await chmod(directory, 0o700);
    await symlink("/does-not-exist", target);
    await assert.rejects(startListeners(options), /control-socket-exists/);
    assert.ok((await lstat(target)).isSymbolicLink());
    await service.shutdown(1000);
  },
);

test(
  "close after asynchronous authentication prevents actual upstream dispatch",
  { timeout: 10000 },
  async (t) => {
    const resources = createTestResourceScope(t);
    const {
      createSystemClock,
    }: typeof import("../../apps/controller/src/drivers/repo/access/clock.ts") = await appModule(
      "drivers/repo/access/clock",
    );
    const clock = createSystemClock();
    const tls = await createTlsMaterial(resources);
    const upstreamOptions: { tls: typeof tls; clock?: Clock } = { tls };
    const upstream: AlternateUpstream = await startAlternateUpstream(resources, upstreamOptions);
    const config: ServiceConfig = await createLoopbackServiceConfiguration(resources);
    const { promise: barrier, resolve: resume } = Promise.withResolvers<void>();
    const factory = createAlternateFixtureFactory({
      origin: upstream.origin,
      gatewayOrigin: config.gateway.publicOrigin,
      clock,
      accepted: upstream.accepted,
      controls: { beforeSend: () => barrier },
    });
    const { service, listeners }: { service: CredentialServiceOwner; listeners: BoundListeners } =
      await startServiceListeners(resources, {
        config,
        tls,
        factory,
        clock,
        upstreamOrigins: [upstream.origin],
        log: undefined,
      });
    resources.after(resume);
    const opened = service.open({ durationSeconds: 86400, profile: "git-write" });
    const result = new Promise<number | "closed" | undefined>((resolve) => {
      const outgoing = tlsRequest(
        {
          hostname: "127.0.0.1",
          port: listeners.address.port,
          path: "/team/nested/project",
          ca: tls.ca,
          headers: { host: "credentials.example.test", authorization: `Bearer ${opened.bearer}` },
          agent: false,
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
        },
      );
      outgoing.once("error", () => resolve("closed"));
      outgoing.end();
    });
    await waitUntil(
      "the authentication event",
      () => factory.events.some((event) => record(event).kind === "authentication"),
      { timeoutMs: 2000, intervalMs: 5 },
    );
    service.close(opened.session.sessionId);
    resume();
    const responseStatus = await result;
    assert.ok(responseStatus === 503 || responseStatus === "closed");
    await service.shutdown(1000);
    assert.equal(upstream.trace.length, 0);
  },
);

test(
  "Agent response completion and premature close preserve lifecycle outcomes",
  { timeout: 10000 },
  async (t) => {
    const scopeOptions: { clock: "system"; github?: boolean; limits: Partial<ServiceLimits> } = {
      clock: "system",
      // A single exchange slot makes leaked ownership observable on the next request.
      limits: { exchanges: 1, exchangesPerSession: 1 },
    };
    const { resources, clock, tls, config, github }: TokenScope<Clock> =
      await startTokenServiceScope(t, scopeOptions);
    assert.ok(github);
    const [{ createCredentialService }, { startListeners }]: [
      typeof import("../fixtures/repository-credentials/service.ts"),
      typeof import("../../apps/controller/src/drivers/repo/access/server.ts"),
    ] = await Promise.all([
      import("../fixtures/repository-credentials/service.ts"),
      appModule("drivers/repo/access/server"),
    ]);
    const received: { method: string | undefined; body: string }[] = [];
    let upstreamCancelled = false;
    const upstream = createTlsServer(tls, async (request, response) => {
      if (!github.authorize(request.headers.authorization)) {
        response.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<unknown>) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      received.push({ method: request.method, body: Buffer.concat(chunks).toString() });
      if (request.method === "POST") {
        response.once("close", () => {
          upstreamCancelled = !response.writableFinished;
        });
        // Leave a write response unfinished so only cancellation closes upstream I/O.
        response.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
        response.write("0008NAK\n");
      } else {
        response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
        response.end("0000");
      }
    });
    const origin = await listen(resources, upstream);
    const { factory }: { factory: RepositoryBackendFactory } =
      await createStaticTokenServiceFactory(resources, {
        config,
        clock,
        tls,
        github,
        gitOrigin: origin,
        configuration: undefined,
      });
    const actual = createCredentialService({ config, factory, clock });
    const outcomes: ExchangeOutcome[] = [];
    // Observe the actual owner's outcome without replacing execution or settlement.
    const service = {
      ...actual,
      async execute(...args: Parameters<CredentialServiceOwner["execute"]>) {
        const outcome = await actual.execute(...args);
        outcomes.push(outcome);
        return outcome;
      },
    };
    const listeners = await startListeners({
      config,
      tls,
      service,
      factory,
      clock,
      trustedUpstreamOrigins: new Set([origin, github.origin]),
      upstreamCa: tls.ca,
    });
    resources.after(async () => {
      listeners.stopAdmission();
      try {
        const summary = await actual.shutdown(1000);
        assert.equal(summary.graceExpired, false);
        assert.equal(summary.pendingActions, 0);
        assert.equal(summary.pendingCredentials, 0);
        assert.equal(summary.pendingAuxiliary, 0);
        assert.equal(summary.disposedSessions, summary.closedSessions);
      } finally {
        await listeners.close();
      }
    });
    const opened = actual.open({ durationSeconds: 86400, profile: "git-write" });
    const authorization = `Basic ${Buffer.from(`gateway-session:${opened.bearer}`).toString("base64")}`;
    const send = (disconnect = false) =>
      new Promise<{ status: number | undefined; body: string; complete: boolean }>(
        (resolve, reject) => {
          const outgoing = tlsRequest(
            {
              hostname: "127.0.0.1",
              port: listeners.address.port,
              path: `/${fixtureRepository}.git/${disconnect ? "git-receive-pack" : "info/refs?service=git-upload-pack"}`,
              method: disconnect ? "POST" : "GET",
              ca: tls.ca,
              headers: {
                host: "credentials.example.test",
                authorization,
                ...(disconnect
                  ? {
                      "content-type": "application/x-git-receive-pack-request",
                      "content-length": 4,
                    }
                  : {}),
              },
              agent: false,
            },
            (incoming) => {
              const chunks: Buffer[] = [];
              incoming.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
                if (disconnect) {
                  incoming.destroy();
                }
              });
              incoming.once("error", reject);
              incoming.once(disconnect ? "close" : "end", () =>
                resolve({
                  status: incoming.statusCode,
                  body: Buffer.concat(chunks).toString(),
                  complete: incoming.complete,
                }),
              );
            },
          );
          outgoing.once("error", reject);
          outgoing.end(disconnect ? "0000" : undefined);
        },
      );
    const settled = async (index: number) => {
      await eventually(
        () =>
          outcomes.length > index &&
          currentStatus(actual, opened.session.sessionId).activeUses === 0,
      );
      const outcome = outcomes[index];
      assert.ok(outcome);
      return outcome;
    };

    await t.test("full HTTP 200 records completion and releases the exchange slot", async () => {
      for (let request = 0; request < 2; request++) {
        const index = outcomes.length;
        assert.deepEqual(await send(), { status: 200, body: "0000", complete: true });
        assert.deepEqual(await settled(index), { kind: "completed", status: 200 });
      }
    });
    await t.test("early client disconnect cancels a dispatched write without replay", async () => {
      const index = outcomes.length;
      const before = received.length;
      assert.deepEqual(await send(true), { status: 200, body: "0008NAK\n", complete: false });
      assert.equal((await settled(index)).kind, "possibly-dispatched");
      await eventually(() => upstreamCancelled);
      assert.equal(received.length, before + 1);
      assert.deepEqual(received.at(-1), { method: "POST", body: "0000" });
      const next = outcomes.length;
      assert.deepEqual(await send(), { status: 200, body: "0000", complete: true });
      assert.deepEqual(await settled(next), { kind: "completed", status: 200 });
      assert.equal(received.filter((entry) => entry.method === "POST").length, 1);
    });
  },
);

test(
  "registry provider transports reject origin overrides and preserve valid requests",
  { timeout: 15000 },
  async (t) => {
    const resources = createTestResourceScope(t);
    const tls = await createTlsMaterial(resources);
    const definition = defaultRegistryRepositories[0];
    assert.ok(definition);
    const { apiOrigin, gitOrigin, repositories } = await startRegistryProviderFixtures(resources, {
      definitions: [definition],
      clock: createControlledClock(),
      tls,
    });
    const [repository] = repositories;
    assert.ok(repository);
    const outsideRequests: (string | undefined)[] = [];
    const outside = createTlsServer(tls, (request, response) => {
      outsideRequests.push(request.url);
      response.writeHead(204).end();
    });
    let outsideConnections = 0;
    outside.on("connection", () => outsideConnections++);
    // The proxy trusts this listener's certificate too, so TLS alone cannot prevent a misroute.
    const outsideOrigin = new URL(await listen(resources, outside));
    const send = (origin: string, path: string, options: RequestOptions = {}, body?: string) =>
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const outgoing = tlsRequest(
          new URL(origin),
          { ...options, path, ca: tls.ca, agent: false, signal: t.signal },
          (incoming) => {
            let body = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk: string) => (body += chunk));
            incoming.once("error", reject);
            incoming.once("end", () => resolve({ status: incoming.statusCode, body }));
          },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
      });
    const apiPath = `/repos/${repository.repository}/issues`;
    const gitPath = `/${repository.repository}.git/git-upload-pack`;
    const refusals = [];
    for (const [origin, path] of [
      [apiOrigin, `${apiPath}?per_page=1`],
      [gitOrigin, gitPath],
    ] as const) {
      // Each invalid target still has a registered repository path after URL parsing.
      for (const target of [
        `${outsideOrigin.origin}${path}`,
        `//${outsideOrigin.host}${path}`,
        `/\\${outsideOrigin.host}${path}`,
        `/%2e%2e${path}`,
      ]) {
        refusals.push({ target, status: (await send(origin, target)).status });
      }
    }
    assert.deepEqual(outsideRequests, []);
    assert.equal(outsideConnections, 0);
    for (const { target, status } of refusals) {
      assert.equal(status, 400, target);
    }
    assert.equal(repository.github.trace.length, 0);
    assert.deepEqual(repository.git.traffic(), { connections: 0, requests: 0 });

    // The real API fixture echoes the issue body, and Git needs the protocol packet to list refs.
    const token = randomUUID();
    repository.github.acceptStatic(token);
    const issue = { title: "Registry proxy fixture", body: "Synthetic issue body" };
    const created = await send(
      apiOrigin,
      apiPath,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      },
      JSON.stringify(issue),
    );
    assert.equal(created.status, 201);
    const createdIssue = record(JSON.parse(created.body));
    assert.equal(createdIssue.title, issue.title);
    assert.equal(createdIssue.body, issue.body);
    assert.equal(repository.github.trace[0]?.method, "POST");
    assert.equal(repository.github.trace[0]?.target, apiPath);
    const listing = `${apiPath}?per_page=1&labels=needs%20review`;
    const listed = await send(apiOrigin, listing, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(JSON.parse(listed.body), [createdIssue]);
    assert.equal(repository.github.trace[1]?.target, listing);

    const gitBody = "0014command=ls-refs\n00010000";
    const refs = await send(
      gitOrigin,
      gitPath,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`fixture:${token}`).toString("base64")}`,
          "content-type": "application/x-git-upload-pack-request",
          "content-length": Buffer.byteLength(gitBody),
          "git-protocol": "version=2",
        },
      },
      gitBody,
    );
    assert.equal(refs.status, 200);
    assert.match(refs.body, / refs\/heads\/main\n/);
    assert.equal(repository.git.trace[0]?.method, "POST");
    assert.equal(repository.git.trace[0]?.path, gitPath);
  },
);

async function boundControlFixture(
  t: TestContext,
  limits: Partial<ServiceLimits> = {},
  repositories?: readonly RepositoryDefinition[],
) {
  // One scope owns every cleanup of these tests. node:test stops a test's after hooks at
  // the first failure, so a failed fixture cleanup used to skip the receipt listener and
  // relay hooks registered after it and leave their servers holding the file open. The scope
  // runs cleanups in reverse and keeps going past a failure. The service reports to the
  // receipt listener while it stops, so that listener's own scope closes last.
  const resources = createTestResourceScope(t);
  const receiptResources = createResourceScope();
  resources.after(() => receiptResources.close());
  const fixture: RegistryFixture | undefined = await startRegistryCredentialServiceFixture(
    resources,
    {
      namespaceId: `ns_${randomUUID()}`,
      autoOpen: false,
      maximumDurationSeconds: 1200,
      durationSeconds: 600,
      gateway: { listen: "127.0.0.1:0" },
      limits,
      ...(repositories === undefined ? {} : { repositories }),
    },
  );
  assert.ok(fixture);
  const {
    resolveGitHubRepositoryBinding,
  }: typeof import("../../apps/controller/src/drivers/repo/github/access/registry.ts") =
    await githubProviderModule("registry");
  const deadlineWallMs = fixture.clock.wallNow() + 90_000;
  const bindings = (repositories ?? [{ repositoryRef: "repo-a" }]).map(({ repositoryRef }) =>
    resolveGitHubRepositoryBinding(fixture.registry, {
      namespaceId: fixture.namespaceId,
      repositoryRef,
      profile: "git-write",
    }),
  );
  const inputFor = (repositoryRef: string): RepositoryCredentialBoundSessionInput => {
    const binding = bindings.find((entry) => entry.repositoryRef === repositoryRef);
    assert.ok(binding);
    return {
      namespaceId: fixture.namespaceId,
      repositoryRef: binding.repositoryRef,
      profile: binding.profile,
      expectedBinding: binding.grant,
      durationSeconds: 600,
      deadlineWallMs,
      preparedOnly: true,
    };
  };
  const firstBinding = bindings[0];
  assert.ok(firstBinding);
  const input = inputFor(firstBinding.repositoryRef);
  const receipts = await startReceiptState(receiptResources, fixture, bindings, deadlineWallMs);
  const freshId = () => `${fixture.clock.wallNow()}-${randomUUID()}`;
  const send = (value: object, id = freshId(), socketPath = fixture.config.gateway.controlSocket) =>
    control(
      socketPath,
      "POST",
      "/v1/sessions",
      { ...value, durableAdmission: true },
      { "x-admission-id": id },
    );
  return { ...fixture, resources, input, inputFor, freshId, send, receipts };
}

test(
  "registry control requires exact bound inputs and retains the original absolute expiry on recovery",
  { timeout: 15000 },
  async (t) => {
    const fixture = await boundControlFixture(t);
    const { input, send, freshId, clock } = fixture;
    assert.deepEqual(await control(fixture.config.gateway.controlSocket, "GET", "/healthz"), {
      status: 200,
      body: { ready: true, protocolVersion: 1 },
    });
    assert.deepEqual(
      await control(fixture.config.gateway.controlSocket, "GET", "/v1/capabilities"),
      {
        status: 200,
        body: { durableAdmissionVersion: 1 },
      },
    );
    assert.equal((await send({ durationSeconds: 600, profile: "git-full" })).status, 400);
    for (const field of [
      "namespaceId",
      "repositoryRef",
      "profile",
      "expectedBinding",
      "deadlineWallMs",
    ] as const) {
      const incomplete: Partial<RepositoryCredentialBoundSessionInput> = { ...input };
      delete incomplete[field];
      assert.equal((await send(incomplete)).status, 400, field);
    }
    const id = freshId();
    await fixture.receipts.prepare(id, input.repositoryRef, input.durationSeconds);
    const created = await send(input, id);
    assert.equal(created.status, 201);
    const createdBody = sessionResult(created.body);
    assert.equal(createdBody.session.deadlineWallMs, input.deadlineWallMs);
    assert.deepEqual(createdBody.session.binding, input.expectedBinding);
    assert.match(createdBody.bearer, /^[A-Za-z0-9_-]{43}$/);
    // Every authority-bearing admission field participates in recovery identity.
    for (const changed of [
      { durationSeconds: 601 },
      { profile: "git-read" },
      { namespaceId: "another-namespace" },
      { repositoryRef: "repo-b" },
      { deadlineWallMs: input.deadlineWallMs + 1 },
      ...["providerInstanceId", "repositoryId", "grantId"].map((field) => ({
        expectedBinding: { ...input.expectedBinding, [field]: "another-binding" },
      })),
    ]) {
      assert.deepEqual(await send({ ...input, ...changed }, id), {
        status: 400,
        body: { error: "invalid-request" },
      });
    }
    const recovered = await send({ ...input, recoverOnly: true }, id);
    assert.deepEqual(recovered, { status: 200, body: createdBody.session });
    assert.equal(recovered.body.bearer, undefined);
    assert.equal((await send({ ...input, recoverOnly: false }, id)).status, 400);
    assert.equal(
      (await send({ ...input, expectedBinding: { ...input.expectedBinding, grantId: "obsolete" } }))
        .status,
      503,
    );
    assert.equal((await send({ ...input, deadlineWallMs: clock.wallNow() })).status, 503);

    // Recovery after freshness expires still returns the existing session, never a
    // fresh duration or another bearer. The original 90-second deadline then closes it.
    await clock.advance(60_001);
    const lateRecovery = await send(input, id);
    assert.equal(lateRecovery.status, 200);
    assert.equal(lateRecovery.body.state, "OPEN");
    assert.equal(lateRecovery.body.deadlineWallMs, input.deadlineWallMs);
    await clock.advance(30_000);
    assert.notEqual(currentStatus(fixture.service, createdBody.session.sessionId).state, "OPEN");
    const terminal = await send(input, id);
    assert.equal(terminal.status, 200);
    assert.equal(terminal.body.state, "DISPOSED");
    assert.deepEqual(
      await control(fixture.config.gateway.controlSocket, "GET", "/v1/sessions/unknown"),
      {
        status: 404,
        body: { error: "not-found" },
      },
    );
  },
);

test("control refuses loose requests before acting on them", { timeout: 15000 }, async (t) => {
  const fixture = await boundControlFixture(t);
  const { input, send, freshId, clock } = fixture;
  const socket = fixture.config.gateway.controlSocket;
  const refused = { status: 400, body: { error: "invalid-request" } };
  const plainText = { "content-type": "text/plain" };
  const id = freshId();
  await fixture.receipts.prepare(id, input.repositoryRef, input.durationSeconds);
  const body = { ...input, durableAdmission: true };
  assert.deepEqual(
    await control(socket, "POST", "/v1/sessions", body, { ...plainText, "x-admission-id": id }),
    refused,
  );
  // The refused request reserved nothing: the same admission id still creates the session.
  const created = await send(input, id);
  assert.equal(created.status, 201);
  const sessionId = sessionResult(created.body).session.sessionId;

  assert.equal((await control(socket, "POST", "/v1/repository-descriptions", {})).status, 404);

  // Reads and close carry no body. The request head refuses a GET body and the handler a
  // close body; neither changes the session.
  for (const [method, path] of [
    ["GET", "/healthz"],
    ["GET", "/v1/capabilities"],
    ["GET", `/v1/sessions/${sessionId}`],
    ["POST", `/v1/sessions/${sessionId}/close`],
  ] as const) {
    assert.deepEqual(await control(socket, method, path, {}), refused, `${method} ${path}`);
  }
  await clock.advance(0);
  assert.equal(currentStatus(fixture.service, sessionId).state, "OPEN");
});

async function holdControlRequest(owner: ResourceOwner, target: string) {
  const directory = await socketDirectory(owner, "rcs-held-");
  const socketPath = join(directory, "relay.sock");
  const sockets = new Set<Socket>();
  const { promise: received, resolve: captured } = Promise.withResolvers<void>();
  let release: (() => void) | undefined;
  const relay = createNetServer((caller) => {
    sockets.add(caller);
    caller.on("error", () => caller.destroy());
    const chunks: Buffer[] = [];
    const collect = (chunk: Buffer) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      const end = data.indexOf("\r\n\r\n");
      const length = /content-length: ([0-9]+)/i.exec(data.toString());
      if (end < 0 || !length || data.length < end + 4 + Number(length[1])) {
        return;
      }
      caller.off("data", collect);
      caller.pause();
      release = () => {
        const upstream = connect(target);
        sockets.add(upstream);
        upstream.on("error", () => caller.destroy());
        upstream.once("connect", () => {
          upstream.write(data);
          caller.pipe(upstream);
          caller.resume();
        });
        upstream.pipe(caller);
      };
      captured();
    };
    caller.on("data", collect);
  });
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  owner.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => relay.close(resolve));
  });
  return {
    socketPath,
    received,
    release: () => {
      assert.ok(release);
      release();
    },
  };
}

test(
  "lookup-only missing durably fences a delayed first admission across restart",
  { timeout: 15000 },
  async (t) => {
    const fixture = await boundControlFixture(t, { sessions: 1 });
    const { input, send, freshId, clock } = fixture;
    const held = await holdControlRequest(fixture.resources, fixture.config.gateway.controlSocket);
    const id = freshId();
    await fixture.receipts.prepare(id, input.repositoryRef, input.durationSeconds);
    const delayed = send(input, id, held.socketPath);
    await held.received;
    // Cleanup observes absence while the first create request is still in transport.
    // The real control owner must fence that request before it can report missing.
    assert.deepEqual(await send({ ...input, recoverOnly: true }, id), {
      status: 404,
      body: { error: "admission-missing" },
    });
    held.release();
    assert.deepEqual(await delayed, { status: 404, body: { error: "admission-missing" } });
    assert.equal((await send({ ...input, durationSeconds: 601 }, id)).status, 503);
    for (const entry of fixture.repositories) {
      assert.equal(entry.github.trace.length, 0);
    }
    // The durable fence survives service replacement and later clock advances.
    await fixture.restart();
    await clock.advance(60_001);
    assert.deepEqual(await send(input, id), { status: 404, body: { error: "admission-missing" } });
  },
);

test(
  "a refused bound open leaves no durable reservation, so retry and recovery converge",
  { timeout: 15000 },
  async (t) => {
    const fixture = await boundControlFixture(t, { sessions: 1 }, [
      ...defaultRegistryRepositories,
      { repositoryRef: "repo-c", repository: "fixture/third", repositoryId: "75" },
    ]);
    const { inputFor, send, freshId, clock } = fixture;
    const prepared = async (input: RepositoryCredentialBoundSessionInput) => {
      const id = freshId();
      await fixture.receipts.prepare(id, input.repositoryRef, input.durationSeconds);
      return id;
    };
    const first = inputFor("repo-a");
    const retried = inputFor("repo-b");
    const recovered = inputFor("repo-c");
    // Without a worker attempt the journal refuses before constructing a session.
    assert.deepEqual(await send(first, freshId()), {
      status: 503,
      body: { error: "unavailable" },
    });
    const opened = await send(first, await prepared(first));
    assert.equal(opened.status, 201);
    // Session capacity refuses these opens; neither may strand a durable reservation.
    const retriedId = await prepared(retried);
    const recoveredId = await prepared(recovered);
    for (const [input, id] of [
      [retried, retriedId],
      [recovered, recoveredId],
    ] as const) {
      assert.deepEqual(await send(input, id), { status: 503, body: { error: "overloaded" } });
    }
    assert.deepEqual(await send({ ...recovered, recoverOnly: true }, recoveredId), {
      status: 404,
      body: { error: "admission-missing" },
    });
    const openedBody = sessionResult(opened.body);
    fixture.service.close(openedBody.session.sessionId);
    await clock.advance(0);
    await eventually(
      () => currentStatus(fixture.service, openedBody.session.sessionId).state === "DISPOSED",
    );
    // The fence stands: the journal answers missing before session construction.
    assert.deepEqual(await send(recovered, recoveredId), {
      status: 404,
      body: { error: "admission-missing" },
    });
    const reopened = await send(retried, retriedId);
    assert.equal(reopened.status, 201);
    assert.equal(sessionResult(reopened.body).session.state, "OPEN");
  },
);

test(
  "a session disposed and evicted while its binding awaits the journal still settles the receipt",
  { timeout: 15000 },
  async (t) => {
    const fixture = await boundControlFixture(t, { sessions: 2 }, defaultRegistryRepositories);
    const { inputFor, send, freshId, clock, receipts } = fixture;
    const input = { ...inputFor("repo-a"), durationSeconds: 1 };
    const id = freshId();
    await receipts.prepare(id, input.repositoryRef, input.durationSeconds);
    const replacement = inputFor("repo-b");
    const replacementId = freshId();
    await receipts.prepare(replacementId, replacement.repositoryRef, replacement.durationSeconds);
    // Reservation must finish before construction. Hold the subsequent bind until
    // the session expires and another accepted admission evicts it.
    const transact = receipts.state.transact;
    let transactions = 0;
    const { promise: reached, resolve: entered } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    receipts.state.transact = async function <T>(
      work: (state: PlatformUnitOfWork) => Promise<T>,
    ): Promise<T> {
      if (transactions++ === 1) {
        entered();
        await gate;
      }
      return transact.bind(this)(work);
    };
    fixture.resources.after(() => {
      receipts.state.transact = transact;
      release();
    });
    const disposed: SessionStatus[] = [];
    fixture.resources.after(fixture.service.observeDisposal((status) => disposed.push(status)));
    const pending = send(input, id);
    await reached;
    await clock.advance(1000);
    await eventually(() => disposed.length === 1);
    const disposedStatus = disposed[0];
    assert.ok(disposedStatus);
    const { sessionId } = disposedStatus;
    assert.equal((await send(replacement, replacementId)).status, 201);
    assert.equal(fixture.service.status(sessionId), undefined);
    release();
    const answered = await pending;
    assert.equal(answered.status, 200);
    assert.equal(answered.body.sessionId, sessionId);
    assert.equal(answered.body.state, "DISPOSED");
    assert.equal(answered.body.bearer, undefined);
    const receipt = await receipts.state.read((view) =>
      view.repositorySessions.findBrokerReceipt(id),
    );
    assert.ok(receipt);
    assert.equal(receipt.state, "disposed");
    assert.equal(receipt.sessionId, sessionId);
    assert.deepEqual(await send({ ...input, recoverOnly: true }, id), answered);
    assert.deepEqual(
      await control(fixture.config.gateway.controlSocket, "GET", `/v1/sessions/${sessionId}`),
      answered,
    );
  },
);

test(
  "a reservation the broker cannot bind is fenced, so retry and recovery answer missing",
  { timeout: 15000 },
  async (t) => {
    const fixture = await boundControlFixture(t, {}, [
      ...defaultRegistryRepositories,
      { repositoryRef: "repo-c", repository: "fixture/third", repositoryId: "75" },
      { repositoryRef: "repo-d", repository: "fixture/fourth", repositoryId: "76" },
    ]);
    const { inputFor, send, freshId, receipts } = fixture;
    const receipt = async (id: string) => {
      const value = await receipts.state.read((view) =>
        view.repositorySessions.findBrokerReceipt(id),
      );
      assert.ok(value);
      return value;
    };
    const prepared = async (input: RepositoryCredentialBoundSessionInput) => {
      const id = freshId();
      await receipts.prepare(id, input.repositoryRef, input.durationSeconds);
      return id;
    };
    const missing = { status: 404, body: { error: "admission-missing" } };

    // The journal reserves an admission the broker then refuses as invalid.
    const invalid = { ...inputFor("repo-a"), durationSeconds: 172_801 };
    const invalidId = await prepared(invalid);
    assert.deepEqual(await send(invalid, invalidId), {
      status: 400,
      body: { error: "invalid-request" },
    });
    assert.equal((await receipt(invalidId)).state, "fenced");
    assert.deepEqual(await send(invalid, invalidId), missing);
    assert.deepEqual(await send({ ...invalid, recoverOnly: true }, invalidId), missing);

    // The journal reserves, then fails to record the opened session.
    const transact = receipts.state.transact;
    fixture.resources.after(() => {
      receipts.state.transact = transact;
    });
    let calls = 0;
    let outcome: "refused" | "away" | "lost" | undefined;
    receipts.state.transact = async function <T>(
      work: (state: PlatformUnitOfWork) => Promise<T>,
    ): Promise<T> {
      calls += 1;
      if (
        (calls === 2 && outcome === "refused") ||
        (calls >= 2 && calls <= 3 && outcome === "away")
      ) {
        throw new Error("fixture-unavailable");
      }
      const result = await transact.bind(this)(work);
      if (calls === 2 && outcome === "lost") {
        throw new Error("fixture-response-lost");
      }
      return result;
    };
    const unbound = inputFor("repo-b");
    const unboundId = await prepared(unbound);
    calls = 0;
    outcome = "refused";
    assert.deepEqual(await send(unbound, unboundId), {
      status: 503,
      body: { error: "unavailable" },
    });
    assert.equal((await receipt(unboundId)).state, "fenced");
    assert.deepEqual(await send(unbound, unboundId), missing);
    assert.deepEqual(await send({ ...unbound, recoverOnly: true }, unboundId), missing);

    // The journal is away for the bind and the fence; a retry fences instead.
    const away = inputFor("repo-d");
    const awayId = await prepared(away);
    calls = 0;
    outcome = "away";
    assert.deepEqual(await send(away, awayId), { status: 503, body: { error: "unavailable" } });
    assert.equal((await receipt(awayId)).state, "reserved");
    outcome = undefined;
    assert.deepEqual(await send(away, awayId), missing);
    assert.equal((await receipt(awayId)).state, "fenced");
    assert.deepEqual(await send({ ...away, recoverOnly: true }, awayId), missing);

    // The bind is recorded but its answer is lost: the fence cannot apply, and the
    // closed session's disposal is recorded instead.
    const lost = inputFor("repo-c");
    const lostId = await prepared(lost);
    calls = 0;
    outcome = "lost";
    assert.deepEqual(await send(lost, lostId), { status: 503, body: { error: "unavailable" } });
    outcome = undefined;
    await waitUntil(
      "the lost session's receipt to be disposed",
      async () => (await receipt(lostId)).state === "disposed",
      { timeoutMs: 5000, intervalMs: 10 },
    );
    const recovered = await send({ ...lost, recoverOnly: true }, lostId);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.state, "DISPOSED");
    assert.equal(recovered.body.sessionId, (await receipt(lostId)).sessionId);
  },
);

test(
  "a refused admission keeps a reservation whose fence did not commit and the next recovery fences it",
  { timeout: 15000 },
  async (t) => {
    const fixture = await boundControlFixture(t, {}, defaultRegistryRepositories);
    const { inputFor, send, freshId, receipts } = fixture;
    const receipt = async (id: string) => {
      const value = await receipts.state.read((view) =>
        view.repositorySessions.findBrokerReceipt(id),
      );
      assert.ok(value);
      return value;
    };
    const invalid = { ...inputFor("repo-a"), durationSeconds: 172_801 };
    const id = freshId();
    await receipts.prepare(id, invalid.repositoryRef, invalid.durationSeconds);
    const transact = receipts.state.transact;
    let calls = 0;
    receipts.state.transact = async function <T>(
      work: (state: PlatformUnitOfWork) => Promise<T>,
    ): Promise<T> {
      calls += 1;
      // The first transaction reserves the receipt. The second is the fence.
      if (calls === 2) {
        throw new Error("fixture-unavailable");
      }
      return transact.bind(this)(work);
    };
    t.after(() => {
      receipts.state.transact = transact;
    });
    // Reservation commits, then the fence transaction fails. The refusal is still
    // invalid input, and the receipt must stay reserved for a later fence.
    const missing = { status: 404, body: { error: "admission-missing" } };
    assert.deepEqual(await send(invalid, id), {
      status: 400,
      body: { error: "invalid-request" },
    });
    assert.equal((await receipt(id)).state, "reserved");
    receipts.state.transact = transact;
    assert.deepEqual(await send({ ...invalid, recoverOnly: true }, id), missing);
    assert.equal((await receipt(id)).state, "fenced");
    assert.deepEqual(await send(invalid, id), missing);
  },
);

test(
  "reservations whose fence did not commit are fenced again and forgotten past their window",
  { timeout: 15000 },
  async (t) => {
    // Capacity is two admission records. A repository has one active attempt, so each
    // admission that reaches the journal uses its own repository: repo-a is refused,
    // repo-b fails to bind and repo-c opens.
    const fixture = await boundControlFixture(t, { sessions: 1 }, [
      ...defaultRegistryRepositories,
      { repositoryRef: "repo-c", repository: "fixture/third", repositoryId: "75" },
    ]);
    const { inputFor, send, freshId, clock, receipts } = fixture;
    const receipt = async (id: string) => {
      const value = await receipts.state.read((view) =>
        view.repositorySessions.findBrokerReceipt(id),
      );
      assert.ok(value);
      return value;
    };
    const prepared = async (input: RepositoryCredentialBoundSessionInput) => {
      const id = freshId();
      await receipts.prepare(id, input.repositoryRef, input.durationSeconds);
      return id;
    };
    const transact = receipts.state.transact;
    // Each entry decides one transaction: true fails it. Past the plan, `down` decides.
    let plan: boolean[] = [];
    let down = false;
    receipts.state.transact = async function <T>(
      work: (state: PlatformUnitOfWork) => Promise<T>,
    ): Promise<T> {
      if (plan.length > 0 ? plan.shift() : down) {
        throw new Error("fixture-unavailable");
      }
      return transact.bind(this)(work);
    };
    t.after(() => {
      receipts.state.transact = transact;
    });
    const refused: [RepositoryCredentialBoundSessionInput, string][] = [];
    // A refused open: the reservation commits, then the fence transaction fails.
    const invalid = { ...inputFor("repo-a"), durationSeconds: 172_801 };
    const invalidId = await prepared(invalid);
    plan = [false, true];
    assert.deepEqual(await send(invalid, invalidId), {
      status: 400,
      body: { error: "invalid-request" },
    });
    refused.push([invalid, invalidId]);
    // A failed bind: the reservation commits, then the bind and the fence fail. The
    // broker closes the session it never handed out.
    const unbound = inputFor("repo-b");
    const unboundId = await prepared(unbound);
    plan = [false, true, true];
    assert.deepEqual(await send(unbound, unboundId), {
      status: 503,
      body: { error: "unavailable" },
    });
    refused.push([unbound, unboundId]);
    for (const [, id] of refused) {
      assert.equal((await receipt(id)).state, "reserved");
    }
    const valid = inputFor("repo-c");
    // Both records fill capacity inside their admission window.
    plan = [];
    assert.deepEqual(await send(valid, freshId()), {
      status: 503,
      body: { error: "overloaded" },
    });
    await clock.advance(60_001);
    // Past the window the sweep fences them again. While the journal stays away the
    // fences fail and the records still count.
    down = true;
    assert.deepEqual(await send(valid, freshId()), {
      status: 503,
      body: { error: "overloaded" },
    });
    for (const [, id] of refused) {
      assert.equal((await receipt(id)).state, "reserved");
    }
    // Once a fence commits, its record is forgotten and the next admission opens.
    down = false;
    const opened = await send(valid, await prepared(valid));
    assert.equal(opened.status, 201);
    assert.equal(sessionResult(opened.body).session.state, "OPEN");
    for (const [input, id] of refused) {
      assert.equal((await receipt(id)).state, "fenced");
      assert.deepEqual(await send(input, id), {
        status: 404,
        body: { error: "admission-missing" },
      });
    }
  },
);

test("the control client refuses socket paths over 103 bytes before connecting", async () => {
  const {
    callControl,
  }: typeof import("../../apps/controller/src/drivers/repo/github/access/client/operator.ts") =
    await appModule("drivers/repo/github/access/client/operator");
  const request = { method: "GET", path: "/v1/sessions" };
  // The deliberately unsupported GET path keeps this runtime input outside ControlRequest.
  // 104 ASCII bytes, and 61 characters that encode to 115 bytes. Neither file exists,
  // so only the length guard can produce invalid-control-request.
  for (const socket of [`/${"a".repeat(103)}`, `/${"\u00e9".repeat(54)}x.sock`]) {
    assert.ok(Buffer.byteLength(socket) > 103);
    await assert.rejects(callControl(socket, request as ControlRequest), {
      message: "invalid-control-request",
    });
  }
});
