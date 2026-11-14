import { asRecord } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Socket } from "node:net";
import {
  constants as http2Constants,
  createServer as createH2cServer,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import { join } from "node:path";
import { TransientDependencyError } from "../../packages/occ/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import {
  addWireService,
  bindWireServer,
  grpc,
  shutdownWireServer,
  boundPort,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

export function registerOutagesCases(): void {
  test("OpenShell client retries setup after a failed first connection", async (t) => {
    const directory = await temporaryDirectory(t, "openshell-client-");
    const rootCertificatePath = join(directory, "ca.pem");
    // Nothing listens here; once setup succeeds the call fails on the transport.
    const client = new GrpcOpenShellGatewayClient({
      endpoint: "https://127.0.0.1:1",
      rootCertificatePath,
      requestTimeoutMs: 1_000,
    });
    const signal = new AbortController().signal;
    try {
      await assert.rejects(client.health(signal), { code: "ENOENT" });
      await writeFile(
        rootCertificatePath,
        "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n",
      );
      await assert.rejects(client.health(signal), (error) => {
        assert.ok(error instanceof DependencyUnavailableError);
        assert.equal(asRecord(error)?.grpcStatus, grpc.status.UNAVAILABLE);
        return true;
      });
    } finally {
      client.close();
    }
  });

  // Findings 2040, 2042 and 2048-2050: only a gateway that did not answer (grpc-js reached nothing
  // at its address, lost the connection under the call, or had no connection by the deadline) is a
  // Sandbox gateway outage, which a revision pass waits out instead of spending its attempt budget.
  // It stays a DependencyUnavailableError (HTTP 503, other work's retries), keeps its gRPC status,
  // and never carries the gateway's text. A status the gateway answers itself (at the pinned
  // OpenShell: resource admission's Kubernetes 403/401/TLS errors, credential driver errors, or an
  // interceptor's chosen reason, even one that reads like grpc-js's own) and every other failure
  // keep the ordinary class, so they spend the attempt budget and fail within it.
  test("OpenShell client names only an unanswered gateway request a Sandbox gateway outage", async (t) => {
    // The class the worker's revision pass waits on.
    const { SandboxGatewayUnavailableError } = await import("../../packages/occ/src/index.ts");

    // The pinned gateway's resource admission answer to a Kubernetes 403.
    const refusal =
      "gateway is forbidden from reading metadata for Secret tenant/model (Kubernetes 403); check gateway RBAC";
    const answers = [
      grpc.status.UNAVAILABLE,
      grpc.status.INTERNAL,
      grpc.status.DEADLINE_EXCEEDED,
      grpc.status.UNKNOWN,
    ].map((code) => ({ code, details: refusal }));
    // Finding 2048: an interceptor relays the reason and status it chooses, so the gateway can
    // answer with the very details grpc-js uses for an unanswered request.
    const lookalikes: [number, string][] = [
      [grpc.status.UNAVAILABLE, "Connection dropped"],
      [grpc.status.UNAVAILABLE, "read ECONNRESET"],
      [grpc.status.UNAVAILABLE, "Stream refused by server"],
      [grpc.status.UNAVAILABLE, "Name resolution failed for target dns:openshell:8080"],
      [
        grpc.status.UNAVAILABLE,
        "No connection established. Last error: connect ECONNREFUSED 10.0.0.1:8080. Resolution note: ",
      ],
      [grpc.status.DEADLINE_EXCEEDED, "Deadline exceeded after 1.000s,Waiting for LB pick"],
    ];
    answers.push(...lookalikes.map(([code, details]) => ({ code, details })));
    const server = new grpc.Server();
    addWireService(server, {
      Health(_call, callback) {
        const answer = answers.shift();
        assert.ok(answer);
        callback(answer);
      },
      CreateSandbox: (_call, callback) =>
        callback({ code: grpc.status.UNAVAILABLE, details: refusal }),
      ExecSandbox: (call) =>
        call.emit("error", { code: grpc.status.UNAVAILABLE, details: refusal }),
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    // A gateway scaled to zero: nothing listens at its address.
    const stopped = new GrpcOpenShellGatewayClient({
      endpoint: "127.0.0.1:1",
      requestTimeoutMs: 2_000,
    });
    t.after(async () => {
      client.close();
      stopped.close();
      await shutdownWireServer(server);
    });
    const sandbox = {
      name: "outage",
      workspace: "tenant-workspace",
      requestId: "0b0f7c43-3c55-4a8a-9d1c-b3f3a0b1d1c9",
      labels: {},
      annotations: {},
      spec: {},
      serviceExposures: [],
    };
    const exec = {
      workspace: "tenant-workspace",
      sandbox: "outage",
      command: ["/bin/true"],
      environment: {},
      stdin: "",
      timeoutSeconds: 5,
    };
    const outage = (error: unknown, code = grpc.status.UNAVAILABLE) => {
      assert.ok(error instanceof SandboxGatewayUnavailableError, String(error));
      assert.ok(error instanceof DependencyUnavailableError);
      assert.ok(!(error instanceof TransientDependencyError));
      assert.equal(asRecord(error)?.grpcStatus, code);
      return true;
    };
    const answered = (code: number) => (error: unknown) => {
      assert.ok(error instanceof DependencyUnavailableError, String(error));
      assert.ok(!(error instanceof SandboxGatewayUnavailableError), String(error));
      assert.equal(asRecord(error)?.grpcStatus, code);
      assert.equal(error.message.includes(refusal), false);
      return true;
    };

    // The gateway answered UNAVAILABLE with its reason: an ordinary failed request.
    await assert.rejects(
      client.health(AbortSignal.timeout(2_000)),
      answered(grpc.status.UNAVAILABLE),
    );
    for (const code of [grpc.status.INTERNAL, grpc.status.DEADLINE_EXCEEDED, grpc.status.UNKNOWN]) {
      await assert.rejects(client.health(AbortSignal.timeout(2_000)), answered(code));
    }
    // The gateway answered in its own response (grpc-js keeps its content-type and date headers as
    // the status metadata), so even grpc-js's own wording is an ordinary failed request.
    for (const [code, details] of lookalikes) {
      await assert.rejects(client.health(AbortSignal.timeout(2_000)), (error) => {
        assert.ok(error instanceof DependencyUnavailableError, details);
        assert.ok(!(error instanceof SandboxGatewayUnavailableError), details);
        assert.equal(asRecord(error)?.grpcStatus, code);
        return true;
      });
    }
    // CreateSandbox keeps closed diagnostics (finding 2040): the gateway's reason stays out of
    // the message, which HTTP dependency logging also emits.
    await assert.rejects(client.createSandbox(sandbox, AbortSignal.timeout(2_000)), (error) => {
      assert.ok(error instanceof DependencyUnavailableError, String(error));
      assert.ok(!(error instanceof SandboxGatewayUnavailableError), String(error));
      assert.equal(asRecord(error)?.grpcStatus, grpc.status.UNAVAILABLE);
      assert.equal(
        error.message,
        `OpenShell CreateSandbox failed with gRPC status ${grpc.status.UNAVAILABLE}.`,
      );
      assert.equal(error.message.includes(refusal), false);
      return true;
    });
    await assert.rejects(
      client.execSandbox(exec, AbortSignal.timeout(2_000)),
      answered(grpc.status.UNAVAILABLE),
    );

    // Nothing listens at the gateway's address.
    await assert.rejects(stopped.health(AbortSignal.timeout(3_000)), outage);
    await assert.rejects(stopped.createSandbox(sandbox, AbortSignal.timeout(3_000)), outage);
    await assert.rejects(stopped.execSandbox(exec, AbortSignal.timeout(3_000)), outage);

    // The gateway process goes away under a call it received: the connection drops.
    const received = Promise.withResolvers<void>();
    const connections: Socket[] = [];
    const dropping = createH2cServer();
    dropping.on("connection", (socket) => connections.push(socket));
    dropping.on("stream", () => received.resolve());
    await new Promise<void>((resolve) => dropping.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => dropping.close(() => resolve())));
    const dropped = new GrpcOpenShellGatewayClient({
      endpoint: `127.0.0.1:${boundPort(dropping)}`,
    });
    t.after(() => dropped.close());
    const inFlight = dropped.health(AbortSignal.timeout(5_000));
    await received.promise;
    for (const socket of connections) {
      socket.destroy();
    }
    await assert.rejects(inFlight, outage);

    // The gateway refuses every stream before handling it, as while it shuts down.
    const refusing = createH2cServer();
    refusing.on("stream", (stream) => {
      stream.on("error", () => {});
      stream.close(http2Constants.NGHTTP2_REFUSED_STREAM);
    });
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => refusing.close(() => resolve())));
    const refused = new GrpcOpenShellGatewayClient({
      endpoint: `127.0.0.1:${boundPort(refusing)}`,
    });
    t.after(() => refused.close());
    await assert.rejects(refused.health(AbortSignal.timeout(5_000)), outage);

    // The gateway's host goes away under a call: its TCP reset reaches grpc-js as "read ECONNRESET".
    const resetSockets: Socket[] = [];
    const reset = createH2cServer();
    reset.on("connection", (socket) => resetSockets.push(socket));
    reset.on("stream", (stream) => {
      stream.on("error", () => {});
      for (const socket of resetSockets) {
        socket.resetAndDestroy();
      }
    });
    await new Promise<void>((resolve) => reset.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => reset.close(() => resolve())));
    const resetClient = new GrpcOpenShellGatewayClient({
      endpoint: `127.0.0.1:${boundPort(reset)}`,
    });
    t.after(() => resetClient.close());
    await assert.rejects(resetClient.health(AbortSignal.timeout(5_000)), outage);

    // The gateway's Service name no longer resolves (a deleted Service). The .invalid name never
    // resolves (RFC 6761); a resolver that cannot be reached fails the lookup the same way.
    const deleted = new GrpcOpenShellGatewayClient({ endpoint: "openshell-gone.invalid:8080" });
    t.after(() => deleted.close());
    await assert.rejects(deleted.health(AbortSignal.timeout(15_000)), outage);

    // A connection that never gets as far as HTTP/2 (a lost node or a stale Service address drops
    // the connect; here a listener accepts and stays silent) leaves the request unsent until its
    // deadline: grpc-js answers DEADLINE_EXCEEDED while it still waits for a connection.
    const silentSockets: Socket[] = [];
    const silent = createNetServer((socket) => {
      silentSockets.push(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      for (const socket of silentSockets) {
        socket.destroy();
      }
      return new Promise<void>((resolve) => silent.close(() => resolve()));
    });
    const blackholed = new GrpcOpenShellGatewayClient({
      endpoint: `127.0.0.1:${boundPort(silent)}`,
      requestTimeoutMs: 1_000,
    });
    t.after(() => blackholed.close());
    await assert.rejects(blackholed.health(AbortSignal.timeout(5_000)), (error) =>
      outage(error, grpc.status.DEADLINE_EXCEEDED),
    );

    // A gateway that received the request but never answered it is not an outage: grpc-js sent the
    // request, so its DEADLINE_EXCEEDED names the remote address, not "Waiting for LB pick", and the
    // request spends the attempt budget like any other failed request.
    const hungSessions: ServerHttp2Session[] = [];
    const hung = createH2cServer();
    hung.on("session", (session) => hungSessions.push(session));
    hung.on("stream", (stream) => stream.on("error", () => {}));
    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      for (const session of hungSessions) {
        session.destroy();
      }
      return new Promise<void>((resolve) => hung.close(() => resolve()));
    });
    const unanswering = new GrpcOpenShellGatewayClient({
      endpoint: `127.0.0.1:${boundPort(hung)}`,
      requestTimeoutMs: 1_000,
    });
    t.after(() => unanswering.close());
    await assert.rejects(unanswering.health(AbortSignal.timeout(5_000)), (error) => {
      assert.ok(error instanceof DependencyUnavailableError, String(error));
      assert.ok(!(error instanceof SandboxGatewayUnavailableError), String(error));
      assert.equal(asRecord(error)?.grpcStatus, grpc.status.DEADLINE_EXCEEDED);
      return true;
    });

    // A status sent in trailers after the response headers carries no other metadata, so only its
    // code and exact details tell it from grpc-js's own: none of these is an unanswered request.
    const trailers: [number, string][] = [
      [grpc.status.UNAVAILABLE, "Connection dropped by gateway policy"],
      [grpc.status.UNAVAILABLE, "policy: Connection dropped"],
      [grpc.status.INTERNAL, "Connection dropped"],
    ];
    const trailing = createH2cServer();
    trailing.on("stream", (stream: ServerHttp2Stream) => {
      const trailer = trailers.shift();
      assert.ok(trailer);
      const [code, details] = trailer;
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": String(code), "grpc-message": encodeURI(details) }),
      );
      stream.end();
    });
    await new Promise<void>((resolve) => trailing.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => trailing.close(() => resolve())));
    const trailed = new GrpcOpenShellGatewayClient({
      endpoint: `127.0.0.1:${boundPort(trailing)}`,
    });
    t.after(() => trailed.close());
    for (const [code, details] of [...trailers]) {
      await assert.rejects(trailed.health(AbortSignal.timeout(5_000)), (error) => {
        assert.ok(error instanceof DependencyUnavailableError, details);
        assert.ok(!(error instanceof SandboxGatewayUnavailableError), details);
        assert.equal(asRecord(error)?.grpcStatus, code);
        return true;
      });
    }

    // Finding 2104: a kubectl port-forward whose Pod is gone accepts one connection, closes it
    // before the HTTP/2 handshake ("Failed to connect"), then exits. That close is not an
    // unanswered request, and grpc-js repeats it until its next connection attempt (about a
    // second later); only once nothing listens is it an outage. The OpenShell k3d proof closes
    // its forward before stopping the gateway, so its passes see only the refusal.
    const staleSockets: Socket[] = [];
    const stale = createNetServer((socket) => {
      staleSockets.push(socket);
      socket.on("error", () => {});
      socket.end();
      stale.close();
    });
    await new Promise<void>((resolve) => stale.listen(0, "127.0.0.1", resolve));
    // grpc-js leaves its end of the closed connection open, so the test destroys this one.
    t.after(() => {
      for (const socket of staleSockets) {
        socket.destroy();
      }
      if (stale.listening) {
        stale.close();
      }
    });
    const forwarded = new GrpcOpenShellGatewayClient({
      endpoint: `127.0.0.1:${boundPort(stale)}`,
    });
    t.after(() => forwarded.close());
    const ordinary = (error: unknown) => {
      assert.ok(error instanceof DependencyUnavailableError, String(error));
      assert.ok(!(error instanceof SandboxGatewayUnavailableError), String(error));
      assert.equal(asRecord(error)?.grpcStatus, grpc.status.UNAVAILABLE);
      return true;
    };
    await assert.rejects(forwarded.health(AbortSignal.timeout(5_000)), ordinary);
    let closed: InstanceType<typeof SandboxGatewayUnavailableError> | undefined;
    for (const deadline = Date.now() + 10_000; closed === undefined && Date.now() < deadline;) {
      const error: unknown = await forwarded.health(AbortSignal.timeout(5_000)).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.notEqual(error, null, "a stale forward's health retry must not succeed");
      if (error instanceof SandboxGatewayUnavailableError) {
        closed = error;
      } else {
        ordinary(error);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(closed !== undefined, "a closed forward must read as an outage");
    outage(closed);
  });
}
