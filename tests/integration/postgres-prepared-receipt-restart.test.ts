import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import {
  createServer as httpServer,
  request,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { connect, createServer as tcpServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import type { TLSSocket } from "node:tls";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { RepositoryReceiptStore } from "../../apps/controller/src/backends/repository-credentials/receipt-store.ts";
import { RepositoryReceiptClient } from "../../apps/controller/src/drivers/repo/credentials/receipt-client.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { PreparedRepositoryGitStore } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-repository-git.ts";
import { createPreparedGitHubRegistryFactory } from "../../apps/controller/src/drivers/repo/github/credentials/warm-registry-factory.ts";
import { sessionAttempt } from "../conformance/repository-sessions.contract.mjs";
import { disposeBrokerSession, fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import {
  createLoopbackServiceConfiguration,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { startServiceListeners } from "../fixtures/repository-credentials/service-resources.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";

type Resources = ReturnType<typeof createTestResourceScope>;

type DisposalCommand = {
  kind: string;
  admissionId: string;
  generation: string;
  status: { sessionId: string };
};

/** Forward the real receipt protocol, then drop one acknowledged disposal response. */
async function loseCommittedDisposal(
  resources: Resources,
  socketPath: string,
  ownerSocket: string,
  verifyCommit: (command: DisposalCommand) => Promise<void>,
) {
  const kinds: string[] = [];
  const dropped = Promise.withResolvers<void>();
  let droppedCount = 0;
  const relay = httpServer(async (incoming, response) => {
    try {
      const data = await buffer(incoming);
      const command = JSON.parse(data.toString()) as DisposalCommand;
      kinds.push(command.kind);
      const outbound = request({
        socketPath: ownerSocket,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
        agent: false,
      });
      const waiting = once(outbound, "response");
      outbound.end(data);
      const [reply] = await waiting;
      const result = await buffer(reply);
      if (command.kind === "dispose" && droppedCount === 0) {
        assert.equal(reply.statusCode, 200);
        assert.deepEqual(JSON.parse(result.toString()), { kind: "acknowledged" });
        await verifyCommit(command);
        droppedCount++;
        response.destroy();
        dropped.resolve();
      } else {
        response.writeHead(reply.statusCode, reply.headers).end(result);
      }
    } catch (error) {
      dropped.reject(error);
      response.destroy();
    }
  });
  relay.listen(socketPath);
  await once(relay, "listening");
  resources.after(() => relay[Symbol.asyncDispose]());
  return { kinds, dropped: dropped.promise };
}

/** Pass issuer traffic through, then hold the sender before the real API TLS handshake. */
async function gateApiHandshake(resources: Resources, upstreamOrigin: string) {
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let holding = false;
  let connections = 0;
  const gate = tcpServer((socket) => {
    if (holding) {
      connections++;
      paused.resolve();
    }
    void (holding ? resume.promise : Promise.resolve()).then(() => {
      const upstream = connect(Number(new URL(upstreamOrigin).port), "127.0.0.1");
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
  });
  gate.listen(0, "127.0.0.1");
  await once(gate, "listening");
  resources.after(() => gate[Symbol.asyncDispose]());
  resources.after(() => resume.resolve());
  return {
    origin: `https://127.0.0.1:${(gate.address() as AddressInfo).port}`,
    paused: paused.promise,
    hold: () => {
      holding = true;
    },
    release: () => resume.resolve(),
    connections: () => connections,
  };
}

test(
  "original prepared exchange preserves expiry and committed disposal across receipt authority restart",
  { ...requiresPostgres, timeout: 45_000 },
  async (t) => {
    const resources = createTestResourceScope(t);
    let useSocket = "";
    const fixtureOptions = {
      draftPull: true,
      openBroker(input: { socketPath: string }) {
        useSocket = input.socketPath;
      },
    };
    const f = await fixture(resources, fixtureOptions);
    await disposeBrokerSession(f);
    const { revision, state, binding, registry, gh } = f;
    const { namespaceId } = revision;
    const admissionId = Date.now() + "-" + randomUUID();
    const wire = {
      namespaceId,
      repositoryRef: binding.repositoryRef,
      profile: binding.profile,
      durationSeconds: 3600,
      deadlineWallMs: f.deadlineWallMs,
      expectedBinding: binding.grant,
      durableAdmission: true as const,
      preparedOnly: true as const,
    };
    await state.transact((u) =>
      u.repositorySessions.createAttempt(
        sessionAttempt(revision, {
          admissionId,
          durationSeconds: wire.durationSeconds,
          brokerProtocol: 3,
        }),
      ),
    );
    const row = async () => {
      const receipt = await state.read((v) => v.repositorySessions.findBrokerReceipt(admissionId));
      assert.ok(receipt);
      return receipt;
    };
    const ownerDir = await socketDirectory(resources, "journal-");
    const receiptOptions = {
      controlSocket: join(ownerDir, "control.sock"),
      driverId: revision.repositoryCredentials.driver.id,
      implementation: "github",
      backendId: registry.backendId,
    };
    // Register the future pools before the listener so teardown closes the listener first.
    const restartPools = Array.from({ length: 2 }, () =>
      testPool(resources, { connectionString: databaseUrl, max: 2 }),
    );
    let journal = await startRepositoryReceiptServer({ ...receiptOptions, state });
    resources.after(() => journal.close());
    const controlSocket = join(dirname(useSocket), "control.sock");
    const { kinds, dropped } = await loseCommittedDisposal(
      resources,
      join(dirname(useSocket), "receipt.sock"),
      join(ownerDir, "receipt.sock"),
      async (command) => {
        assert.equal(command.admissionId, admissionId);
        const committed = await row();
        assert.equal(committed.state, "disposed");
        assert.equal(committed.generation, command.generation);
        assert.equal(committed.sessionId, command.status.sessionId);
      },
    );
    const gitOptions = { tls: gh.tls, authorize: gh.authorize };
    const git = await startGitSmartHttpFixture(t, gitOptions);
    const gate = await gateApiHandshake(resources, gh.origin);
    const apiOrigin = gate.origin;
    // The original issuer and the sender pin the same API authority through this gate.
    const issuerDir = await socketDirectory(resources, "issuer-");
    const owner = await f.startOwner({ controlSocket: join(issuerDir, "control.sock"), apiOrigin });
    const real = createSystemClock();
    let observedWall: number | undefined;
    const clock = { ...real, wallNow: () => observedWall ?? real.wallNow() };
    const base = await createLoopbackServiceConfiguration(resources);
    const config = { ...base, gateway: { ...base.gateway, controlSocket } };
    const factory = createPreparedGitHubRegistryFactory({
      registry,
      socketPath: join(issuerDir, "prepared-git-use.sock"),
      clock,
      limits: config.limits,
      gatewayOrigin: config.gateway.publicOrigin,
      gitOrigin: git.origin,
      apiOrigin,
    });
    const { listeners } = await startServiceListeners(resources, {
      config,
      factory,
      clock,
      tls: gh.tls,
      trustedUpstreamOrigins: new Set(factory.trustedUpstreamOrigins),
      upstreamOrigins: undefined,
      providerQueue: undefined,
      log: undefined,
    });
    const client = new UnixRepositoryCredentialControlClient({ controlSocket });
    const opened = await client.open(wire, admissionId, t.signal);
    assert.equal(opened.kind, "created");
    const { session, bearer } = opened.result;
    assert.deepEqual(session.binding, binding.grant);
    const sessionId = session.sessionId;
    const original = await row();
    assert.equal(original.state, "active");
    assert.equal(original.sessionId, sessionId);
    assert.ok(
      await state.transact((u) =>
        u.repositorySessions.advanceAttempt({
          admissionId,
          expectedPhase: "opening",
          phase: "open",
          sessionId,
          updatedAt: new Date().toISOString(),
        }),
      ),
    );
    await prepare({ ...f, owner });
    const gateway = { config, listeners, tls: gh.tls, opened: opened.result };
    const repo = git.repository;
    const gitPath = "/" + repo + ".git/info/refs?service=git-upload-pack";
    const pullPath = "/repos/" + repo + "/pulls";
    const operationId = randomUUID();
    const permits = () =>
      f.pool
        .query(
          "SELECT exchange_id,operation,send_start_by FROM occ.prepared_repository_git_uses WHERE admission_id=$1 ORDER BY operation",
          [admissionId],
        )
        .then((r) => r.rows);
    const pull = () =>
      f.pool
        .query(
          "SELECT receipt_id,admission_id,outcome,settled_at FROM occ.prepared_repository_draft_pulls WHERE operation_id=$1 AND grant_id=$2",
          [operationId, binding.grant.grantId],
        )
        .then((r) => r.rows);
    const finish = t.mock.method(PreparedRepositoryGitStore.prototype, "finishPull");
    const dispose = t.mock.method(RepositoryReceiptStore.prototype, "dispose");
    const read = t.mock.method(RepositoryReceiptStore.prototype, "status");
    const positive = await gatewayRequest(gateway, gitPath, {
      headers: {
        authorization: "Basic " + Buffer.from("gateway-session:" + bearer).toString("base64"),
      },
    });
    assert.equal(positive.status, 200);
    assert.equal(git.traffic().requests, 1);
    assert.equal(git.trace.length, 1);
    assert.deepEqual(
      (await permits()).map((p) => p.operation),
      ["advertise-upload-pack"],
    );
    // Instrument just the original outbound draft request and its actual provider. Also count
    // the passing agent-to-gateway POST to distinguish the two HTTPS origins.
    const created = channel("http.client.request.created");
    const inbound = channel("http.server.request.start");
    let verifiedTls = 0;
    let permitWallDeadline = 0;
    let permitMonoDeadline = 0;
    let withinPermitAtVerifiedTls = false;
    let gatewayPosts = 0;
    let originPosts = 0;
    let writes = 0;
    const onCreate = (event: unknown) => {
      const { request: req } = event as { request: ClientRequest };
      if (req.path !== pullPath || req.getHeader("host") !== new URL(apiOrigin).host) {
        return;
      }
      const flush = req.flushHeaders;
      req.flushHeaders = function () {
        writes++;
        return flush.call(this);
      };
      req.once("socket", (sock: TLSSocket) => {
        sock.once("secureConnect", () => {
          if (sock.authorized && !req.headersSent) {
            verifiedTls++;
            withinPermitAtVerifiedTls =
              clock.wallNow() < permitWallDeadline && clock.monotonicNow() < permitMonoDeadline;
          }
        });
      });
    };
    const onInbound = (event: unknown) => {
      const { request: req } = event as { request: IncomingMessage };
      if (req.url !== pullPath || req.method !== "POST") {
        return;
      }
      if (req.socket.localPort === Number(new URL(gh.origin).port)) {
        originPosts++;
      }
      if (req.socket.localPort === listeners.address.port) {
        gatewayPosts++;
      }
    };
    created.subscribe(onCreate);
    inbound.subscribe(onInbound);
    resources.after(() => {
      created.unsubscribe(onCreate);
      inbound.unsubscribe(onInbound);
    });
    gate.hold();
    const pullRequest = {
      method: "POST",
      headers: { "x-oce-operation-id": operationId },
      body: { title: "Prepared pull", head: "prepared-fixture", base: "main", draft: true },
    };
    const op = gatewayRequest(gateway, pullPath, pullRequest);
    await Promise.race([
      gate.paused,
      op.then((r) => {
        throw Error("draft did not reach TLS, status " + r.status);
      }),
    ]);
    try {
      const uses = await permits();
      assert.deepEqual(
        uses.map((p) => p.operation),
        ["advertise-upload-pack", "create-draft-pull"],
      );
      const permit = uses[1];
      permitWallDeadline = new Date(permit.send_start_by).valueOf();
      permitMonoDeadline = clock.monotonicNow() + permitWallDeadline - real.wallNow() - 50;
      const [pending] = await pull();
      assert.equal(pending.receipt_id, permit.exchange_id);
      assert.equal(pending.admission_id, admissionId);
      assert.equal(pending.settled_at, null);
      assert.equal(pending.outcome, "outcome_unknown");
      const status = async () => {
        const value = await client.status(sessionId, t.signal);
        assert.ok(value);
        return value;
      };
      const before = await status();
      assert.equal(before.state, "OPEN");
      assert.equal(before.activeUses, 0); // A prepared use becomes active only at dispatch.
      const split = kinds.length;
      const beforeMono = clock.monotonicNow();
      observedWall = session.deadlineWallMs + 1;
      const expired = await status();
      assert.equal(expired.state, "CLOSED");
      observedWall = undefined;
      assert.equal((await status()).state, "CLOSED");
      assert.ok(clock.wallNow() < new Date(permit.send_start_by).valueOf());
      assert.ok(clock.monotonicNow() >= beforeMono && clock.monotonicNow() - beforeMono < 5000);
      assert.equal((await row()).state, "active");
      assert.deepEqual(kinds.slice(split), []);
      gate.release();
      const result = await op;
      assert.equal(result.status, 409);
      assert.deepEqual(JSON.parse(result.body), {
        operationId,
        receiptId: permit.exchange_id,
        error: "not-submitted",
      });
      assert.deepEqual(
        [gate.connections(), verifiedTls, writes, gatewayPosts, originPosts],
        [1, 1, 0, 1, 0],
      );
      assert.equal(withinPermitAtVerifiedTls, true);
      assert.deepEqual(
        finish.mock.calls.map((c) => c.arguments),
        [[permit.exchange_id, "not-submitted"]],
      );
      const [settled] = await pull();
      assert.equal(settled.receipt_id, permit.exchange_id);
      assert.equal(settled.outcome, "not-submitted");
      assert.ok(settled.settled_at instanceof Date);
      assert.equal((await permits()).length, 2);
      assert.equal(gh.pulls.size, 0);
      assert.equal((await row()).state, "active");
      await assert.rejects(client.close(sessionId, t.signal), {
        name: "RepositoryCredentialControlError",
        retryable: true,
      });
      await dropped;
      const terminal = await row();
      assert.equal(terminal.state, "disposed");
      assert.equal(terminal.sessionId, sessionId);
      assert.equal(terminal.generation, original.generation);
      assert.equal(terminal.deadlineWallMs, session.deadlineWallMs);
      const expected = {
        ...session,
        state: "DISPOSED",
        activeUses: 0,
        cleanup: {
          active: 0,
          pending: 0,
          revoked: terminal.revoked,
          expired: terminal.expired,
          uncertain: 0,
          auxiliaryPending: false,
        },
      };
      // The original service sends its captured disposal once more without reopening or
      // repeating cleanup. PostgreSQL accepts the identical repeat without recording again,
      // and later reads answer from the acknowledged outcome.
      const readsBefore = read.mock.callCount();
      const recoveryStart = kinds.length;
      assert.deepEqual(await status(), expected);
      assert.deepEqual(await status(), expected);
      assert.deepEqual(kinds.slice(recoveryStart), ["dispose"]);
      assert.equal(dispose.mock.callCount(), 2);
      for (const call of dispose.mock.calls) {
        assert.deepEqual(call.arguments.slice(2), [original.generation, expected]);
      }
      assert.equal(read.mock.callCount() - readsBefore, 0);
      assert.deepEqual(await row(), terminal);
      // Each fresh authority and database pool must recover the original receipt independently.
      // The session service remains running; this does not test restoration of its local map.
      for (const restartPool of restartPools) {
        await journal.close();
        const restartedState = new PostgresPlatformState(restartPool);
        journal = await startRepositoryReceiptServer({ ...receiptOptions, state: restartedState });
        const restartedReader = new RepositoryReceiptClient(
          receiptOptions.controlSocket,
          randomUUID(),
        );
        assert.deepEqual(await restartedReader.status(sessionId), expected);
        assert.equal(dispose.mock.callCount(), 2);
        assert.deepEqual(
          await restartedState.read((v) => v.repositorySessions.findBrokerReceipt(admissionId)),
          terminal,
        );
      }
    } finally {
      gate.release();
      await op.catch(() => {});
    }
  },
);
