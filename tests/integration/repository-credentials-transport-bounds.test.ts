import assert from "node:assert/strict";
import { describe, test, type TestContext, type TestOptions } from "node:test";
import type {
  ClientRequest,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import type { TLSSocket } from "node:tls";
import type { ServiceLimits } from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type {
  AgentHandlerOptions,
  RefusalRecord,
} from "../../apps/controller/src/drivers/repo/access/transport/agent.ts";
import type { callControl as CallControl } from "../../apps/controller/src/drivers/repo/github/access/client/operator.ts";
import { createHash } from "node:crypto";
import { createServer, request } from "node:https";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";
import { listen } from "../fixtures/repository-credentials/process.mjs";
import {
  appModule,
  eventually,
  startTokenServiceScope,
} from "../fixtures/repository-credentials/service.mjs";
import { startStaticTokenService } from "../fixtures/repository-credentials/service-resources.mjs";

const discovery = `/${fixtureRepository}.git/info/refs?service=git-upload-pack`;
const upload = `/${fixtureRepository}.git/git-upload-pack`;
const replyHeaders = { "content-type": "application/x-git-upload-pack-advertisement" };
const uploadReplyHeaders = { "content-type": "application/x-git-upload-pack-result" };
const inputLimit = 4096;
const responseLimit = 4096;
const discoveryOnly = [{ method: "GET", path: discovery }];
const uploadOnly = [{ method: "POST", path: upload }];
const completed = (bytes = 4) => ({ kind: "completed", status: 200, bytes, complete: true });
// The peer controls only application bytes and when it reads or writes them.
// The listener, route policy, credential ownership and TLS sender are production code.
async function startTransport(
  t: TestContext,
  onRequest: (incoming: IncomingMessage, outgoing: ServerResponse) => void,
  limits: Partial<ServiceLimits> = {},
  { log }: { log?: AgentHandlerOptions["log"] } = {},
) {
  const options = {
    github: true,
    clock: "system",
    // One exchange slot makes leaked reservations visible to the following request.
    limits: {
      exchanges: 1,
      exchangesPerSession: 1,
      exchangeMs: 10000,
      firstHeaderMs: 5000,
      gitFetchExchangeMs: limits.exchangeMs ?? 10000,
      gitFetchFirstHeaderMs: limits.firstHeaderMs ?? 5000,
      gitFetchStallMs: limits.stallMs ?? 5000,
      ...limits,
    },
  };
  const scope = await startTokenServiceScope(t, options);
  const { resources, tls, github } = scope;
  assert.ok(github);
  const config: unknown = scope.config;
  assert.ok(config && typeof config === "object" && "gateway" in config);
  assert.ok(config.gateway && typeof config.gateway === "object");
  assert.ok("publicOrigin" in config.gateway && typeof config.gateway.publicOrigin === "string");
  assert.ok("controlSocket" in config.gateway && typeof config.gateway.controlSocket === "string");
  const received: { method: string | undefined; path: string | undefined }[] = [];
  const upstream = createServer(tls, (incoming, outgoing) => {
    incoming.on("error", () => {});
    if (!github.authorize(incoming.headers.authorization)) {
      outgoing.writeHead(401).end();
      return;
    }
    received.push({ method: incoming.method, path: incoming.url });
    onRequest(incoming, outgoing);
  });
  const origin = await listen(resources, upstream);
  const trustedOrigins = new Set([origin]);
  const logs: RefusalRecord[] = [];
  const started = await startStaticTokenService(resources, {
    config,
    clock: scope.clock,
    tls,
    github,
    gitOrigin: origin,
    // Pass the caller's original set so production owns the security-relevant copy.
    trustedUpstreamOrigins: trustedOrigins,
    log: log ?? ((record: RefusalRecord) => logs.push(record)),
  });
  const { service } = started;
  const listeners: unknown = started.listeners;
  assert.ok(listeners && typeof listeners === "object" && "address" in listeners);
  assert.ok(
    listeners.address && typeof listeners.address === "object" && "port" in listeners.address,
  );
  assert.ok(typeof listeners.address.port === "number");
  const opened = service.open({ durationSeconds: 300, profile: "git-write" });
  return {
    config: config as { gateway: { publicOrigin: string; controlSocket: string } },
    tls,
    service,
    listeners: listeners as { address: { port: number } },
    opened,
    github,
    received,
    resources,
    trustedOrigins,
    logs,
  };
}

type TransportFixture = Awaited<ReturnType<typeof startTransport>>;
type RequestOptions = {
  method?: string;
  path?: string;
  headers?: Record<string, string | number | readonly string[] | undefined>;
  opened?: TransportFixture["opened"];
  socket?: TLSSocket;
  onResponse?: (response: IncomingMessage) => void;
};
type RequestResult = {
  kind: "completed" | "closed" | "timeout";
  status: number | undefined;
  bytes: number;
  complete: boolean;
};

function startRequest(
  fixture: TransportFixture,
  {
    method = "GET",
    path = discovery,
    headers = {},
    opened = fixture.opened,
    socket,
    onResponse,
  }: RequestOptions = {},
) {
  let incoming: IncomingMessage | undefined;
  let bytes = 0;
  const hash = createHash("sha256");
  const { promise: result, resolve } = Promise.withResolvers<RequestResult>();
  const finish = (kind: RequestResult["kind"]) => {
    clearTimeout(timer);
    resolve({ kind, status: incoming?.statusCode, bytes, complete: incoming?.complete ?? false });
  };
  const outgoing = request(
    {
      hostname: "127.0.0.1",
      port: fixture.listeners.address.port,
      path,
      method,
      ca: fixture.tls.ca,
      ...(socket ? { createConnection: () => socket } : { agent: false }),
      headers: {
        host: new URL(fixture.config.gateway.publicOrigin).host,
        authorization: `Basic ${Buffer.from(
          `${opened.client.gitUsername}:${opened.bearer}`,
        ).toString("base64")}`,
        ...headers,
      },
    },
    (response) => {
      incoming = response;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      response.once("end", () => finish("completed"));
      response.once("error", () => finish("closed"));
      response.once("close", () => {
        if (!response.complete) {
          finish("closed");
        }
      });
      onResponse?.(response);
    },
  );
  const closed = new Promise((resolveClose) => outgoing.once("close", resolveClose));
  outgoing.on("error", () => finish("closed"));
  const timer = setTimeout(() => {
    finish("timeout");
    outgoing.destroy();
  }, 8000);
  fixture.resources.after(async () => {
    clearTimeout(timer);
    incoming?.destroy();
    outgoing.destroy();
    await closed;
  });
  return { outgoing, result, digest: () => hash.digest("hex") };
}

function startUpload(
  fixture: TransportFixture,
  headers: OutgoingHttpHeaders,
  options?: RequestOptions,
) {
  return startRequest(fixture, {
    ...options,
    method: "POST",
    path: upload,
    headers: { "content-type": "application/x-git-upload-pack-request", ...headers },
  });
}

async function readDiscovery(fixture: TransportFixture, options?: RequestOptions) {
  const client = startRequest(fixture, options);
  client.outgoing.end();
  return client.result;
}

function sessionStatus(fixture: TransportFixture, sessionId: string) {
  const status = fixture.service.status(sessionId);
  assert.ok(status);
  return status;
}

function released(fixture: TransportFixture, opened = fixture.opened) {
  return eventually(() => sessionStatus(fixture, opened.session.sessionId).activeUses === 0);
}

function assertRefused(result: RequestResult) {
  assert.equal(result.kind, "completed");
  assert.equal(result.status, 503);
  assert.equal(result.complete, true);
  assert.ok(result.bytes > 0 && result.bytes <= 256);
}

async function closeSession(fixture: TransportFixture, sessionId: string) {
  const module: unknown = await appModule("drivers/repo/github/access/client/operator");
  assert.ok(module && typeof module === "object" && "callControl" in module);
  assert.equal(typeof module.callControl, "function");
  const callControl = module.callControl as typeof CallControl;
  const response = await callControl(fixture.config.gateway.controlSocket, {
    method: "POST",
    path: `/v1/sessions/${sessionId}/close`,
  });
  assert.ok("state" in response);
  return response;
}

function connectTlsClient(fixture: TransportFixture) {
  const socket = connectTls({
    host: "127.0.0.1",
    port: fixture.listeners.address.port,
    ca: fixture.tls.ca,
  });
  const state = { socket, secure: false, closed: false };
  socket.once("secureConnect", () => (state.secure = true));
  // Capacity rejection can surface as either an error or a clean close.
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => {
      state.closed = true;
      resolve();
    }),
  );
  fixture.resources.after(async () => {
    socket.destroy();
    await closed;
  });
  return state;
}

// The producer has no fixed length: kernel socket buffers on two TCP hops can hold
// tens of MiB (about 60 MiB on CI runners), so any fixed payload is a guess about the
// host. It writes until the transport stops asking for more, and a cap far above any
// socket buffering catches a transport that keeps reading while its consumer is paused.
const producerCapBytes = 256 * 1024 * 1024;
const streamChunk = Buffer.alloc(64 * 1024, 42);
// Backpressure is the absence of "drain": the producer counts as stalled once a
// refused write sees no drain for this long.
const producerQuietMs = 200;

// `consumerHolding` says whether the paused consumer already holds the exchange: a
// quiet window before that proves nothing about the consumer, so it is not a stall.
function writePayload(outgoing: ClientRequest | ServerResponse, consumerHolding = () => true) {
  let producedBytes = 0;
  let refusals = 0;
  let quiet: NodeJS.Timeout | undefined;
  let stopped = false;
  const hash = createHash("sha256");
  const { promise: stalled, resolve, reject } = Promise.withResolvers<number>();
  // Callers may await this only after other setup; keep an early failure attributable.
  stalled.catch(() => {});
  const stop = () => {
    stopped = true;
    clearTimeout(quiet);
    outgoing.off("drain", write);
  };
  const settle = (refusal: number) => {
    // Timers run before I/O callbacks: let a drain the socket already reported run first.
    setImmediate(() => {
      if (stopped || refusal !== refusals) {
        return;
      }
      stop();
      // Everything produced so far is queued; the consumer must still get all of it.
      outgoing.end();
      resolve(producedBytes);
    });
  };
  // The quiet window starts only once the consumer is seen holding the exchange.
  const awaitQuiet = (refusal: number) => {
    quiet = consumerHolding()
      ? setTimeout(() => settle(refusal), producerQuietMs)
      : setTimeout(() => awaitQuiet(refusal), 10);
  };
  function write() {
    clearTimeout(quiet);
    while (producedBytes < producerCapBytes) {
      producedBytes += streamChunk.length;
      hash.update(streamChunk);
      if (!outgoing.write(streamChunk)) {
        outgoing.once("drain", write);
        awaitQuiet(++refusals);
        return;
      }
    }
    stop();
    reject(new Error(`producer wrote ${producedBytes} bytes while consumer was paused`));
  }
  outgoing.once("close", () => {
    stop();
    reject(new Error(`producer stream closed after ${producedBytes} bytes before it stalled`));
  });
  write();
  return { stalled, producedBytes: () => producedBytes, digest: () => hash.digest("hex") };
}

// Every case owns its listeners, upstream and sessions, and most of each case is
// spent waiting on a deliberate deadline, so two cases overlap their waits (the
// upstream-timing case runs its three light subtests together). The cases share one
// event loop: with three or more, CPU starvation (4 copies on one CPU) broke the
// producer quiet windows and the 150 ms header deadline.
describe("repository credential transport bounds", { concurrency: 2 }, () => {
  const bounded = (name: string, fn: (t: TestContext) => Promise<void>, options?: TestOptions) =>
    test(name, { timeout: 15000, ...options }, fn);

  bounded("listener header deadlines stop unauthenticated peers", async (t) => {
    const fixture = await startTransport(
      t,
      (incoming, outgoing) => {
        incoming.resume();
        outgoing.writeHead(200, replyHeaders).end("0000");
      },
      { headerMs: 150, stallMs: 3000 },
    );
    const port = fixture.listeners.address.port;
    for (const scenario of [
      {
        name: "an incomplete TLS handshake",
        open: () => connect({ host: "127.0.0.1", port }),
        ready: "connect",
      },
      {
        name: "a TLS peer without HTTP headers",
        open: () => connectTls({ host: "127.0.0.1", port, ca: fixture.tls.ca }),
        ready: "secureConnect",
      },
      {
        name: "a control peer without HTTP headers",
        open: () => connect(fixture.config.gateway.controlSocket),
        ready: "connect",
      },
    ]) {
      await t.test(scenario.name, async () => {
        const socket = scenario.open();
        let closed = false;
        socket.on("error", () => {});
        const close = new Promise<void>((resolve) =>
          socket.once("close", () => {
            closed = true;
            resolve();
          }),
        );
        fixture.resources.after(async () => {
          socket.destroy();
          await close;
        });
        await new Promise((resolve, reject) => {
          socket.once(scenario.ready, resolve);
          socket.once("error", reject);
        });
        // No request is admitted: handshake/header bounds must close the peer
        // before the independent three-second stall timeout could do so.
        await eventually(() => closed, { timeoutMs: 1000 });
      });
    }
    assert.equal(fixture.github.issuesOfTokens.length, 0);
    assert.equal(fixture.received.length, 0);
    assert.equal((await readDiscovery(fixture)).status, 200);
  });

  bounded("an admitted TLS request clears its header deadline", async (t) => {
    const fixture = await startTransport(
      t,
      (incoming, outgoing) => {
        incoming.resume();
        incoming.once("end", () => {
          // The response deliberately outlives header admission while remaining
          // inside the separate response-header, stall and exchange budgets.
          const timer = setTimeout(() => outgoing.writeHead(200, replyHeaders).end("0000"), 400);
          outgoing.once("close", () => clearTimeout(timer));
        });
      },
      { headerMs: 150, firstHeaderMs: 2000, stallMs: 2000 },
    );
    assert.deepEqual(await readDiscovery(fixture), completed());
    assert.deepEqual(fixture.received, discoveryOnly);
    await released(fixture);
  });

  // Finding 2411: the operator log cannot change what the Agent receives, even if it throws.
  bounded("a throwing operator log leaves the refusal and later requests unchanged", async (t) => {
    const fixture = await startTransport(
      t,
      (incoming, outgoing) => {
        incoming.resume();
        outgoing.writeHead(200, replyHeaders).end("0000");
      },
      {},
      {
        log: () => {
          throw new Error("operator log unavailable");
        },
      },
    );
    const unknown = { ...fixture.opened, bearer: "u".repeat(43) };
    const refused = await readDiscovery(fixture, { opened: unknown });
    assert.equal(refused.status, 401);
    assert.deepEqual(await readDiscovery(fixture), completed());
    await released(fixture);
  });

  // Finding 2429: a head refused after its fields are checked (here a wrong Host) is logged
  // when its one Authorization field, in any scheme Git or gh sends, names an open session.
  // A repeated field carries no single credential, so that refusal writes no line.
  bounded("head refusals are logged only for one attributable credential", async (t) => {
    const fixture = await startTransport(t, (incoming, outgoing) => {
      incoming.resume();
      outgoing.writeHead(200, replyHeaders).end("0000");
    });
    const { bearer, client, session } = fixture.opened;
    const basic = `Basic ${Buffer.from(`${client.gitUsername}:${bearer}`).toString("base64")}`;
    const refused = {
      event: "repository-credentials.denied",
      status: 400,
      reasonCode: "unsupported-request",
      reason: "request_refused",
      sessionId: session.sessionId,
    };
    for (const authorization of [basic, `Bearer ${bearer}`, `token ${bearer}`]) {
      const result = await readDiscovery(fixture, {
        headers: { host: "localhost", authorization },
      });
      const [scheme] = authorization.split(" ");
      assert.ok(scheme);
      assert.equal(result.status, 400, scheme);
      assert.deepEqual(fixture.logs.splice(0), [refused], scheme);
    }
    const repeated = await readDiscovery(fixture, { headers: { authorization: [basic, basic] } });
    assert.equal(repeated.status, 400);
    assert.deepEqual(fixture.logs, []);
    assert.equal(fixture.received.length, 0);
  });

  bounded(
    "occupied per-session and total exchange limits refuse excess traffic and recover",
    async (t) => {
      const heldResponses: ServerResponse[] = [];
      const fixture = await startTransport(
        t,
        (incoming, outgoing) => {
          incoming.resume();
          outgoing.writeHead(200, replyHeaders);
          if (heldResponses.length < 2) {
            heldResponses.push(outgoing);
            outgoing.write("0000");
          } else {
            outgoing.end("0000");
          }
        },
        { exchanges: 2, exchangesPerSession: 1, sockets: 8 },
      );
      const first = fixture.opened;
      const second = fixture.service.open({ durationSeconds: 300, profile: "git-write" });
      const third = fixture.service.open({ durationSeconds: 300, profile: "git-write" });
      const delivered = [0, 0];
      const heldClients = [first, second].map((opened, index) =>
        startRequest(fixture, {
          opened,
          onResponse: (incoming) =>
            incoming.on("data", (chunk: Buffer) => {
              assert.ok(delivered[index] !== undefined);
              delivered[index] += chunk.length;
            }),
        }),
      );
      const [firstClient, secondClient] = heldClients;
      assert.ok(firstClient && secondClient);
      const eightZeros = createHash("sha256").update("00000000").digest("hex");
      firstClient.outgoing.end();
      await eventually(() => delivered[0] === 4);

      // One total slot is still free: this refusal belongs to the session bound. Its log
      // record names the session, so an operator can tell it from a withdrawal (finding 2411).
      assertRefused(await readDiscovery(fixture, { opened: first }));
      assert.deepEqual(fixture.logs.splice(0), [
        {
          event: "repository-credentials.denied",
          status: 503,
          reasonCode: "exchange-capacity",
          reason: "capacity",
          sessionId: first.session.sessionId,
        },
      ]);
      assert.equal(sessionStatus(fixture, first.session.sessionId).activeUses, 1);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.received.length, 1);

      // An independent session can occupy the other slot while the first stays live.
      secondClient.outgoing.end();
      await eventually(() => delivered[1] === 4);
      assert.equal(sessionStatus(fixture, second.session.sessionId).activeUses, 1);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.received.length, 2);

      assertRefused(await readDiscovery(fixture, { opened: third }));
      assert.equal(sessionStatus(fixture, third.session.sessionId).activeUses, 0);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.received.length, 2);

      // Denial cannot cancel either admitted stream or replace its credential.
      for (const response of heldResponses) {
        response.write("0000");
      }
      await eventually(() => delivered.every((bytes) => bytes === 8));
      for (const opened of [first, second]) {
        assert.equal(sessionStatus(fixture, opened.session.sessionId).activeUses, 1);
      }
      assert.ok(heldResponses[0]);
      heldResponses[0].end();
      assert.deepEqual(await firstClient.result, completed(8));
      assert.equal(firstClient.digest(), eightZeros);
      await released(fixture, first);

      // Both previously denied callers recover while the second stream still owns a slot.
      for (const opened of [first, third]) {
        assert.deepEqual(await readDiscovery(fixture, { opened }), completed());
        await released(fixture, opened);
      }
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.received.length, 4);
      assert.equal(sessionStatus(fixture, second.session.sessionId).activeUses, 1);
      assert.ok(heldResponses[1]);
      heldResponses[1].end();
      assert.deepEqual(await secondClient.result, completed(8));
      assert.equal(secondClient.digest(), eightZeros);
      await released(fixture, second);
    },
  );

  bounded(
    "pre-authentication socket capacity preserves private control admission and recovers",
    async (t) => {
      const fixture = await startTransport(
        t,
        (incoming, outgoing) => {
          incoming.resume();
          outgoing.writeHead(200, { ...replyHeaders, "content-length": 4 }).end("0000");
        },
        { sockets: 1 },
      );
      // Completing TLS without sending HTTP consumes a socket, but no exchange or credential.
      const admitted = connectTlsClient(fixture);
      await eventually(() => admitted.secure);
      const excess = connectTlsClient(fixture);
      // Refusal must precede the independent five-second header/stall deadlines.
      await eventually(() => excess.closed, { timeoutMs: 1000 });
      assert.equal(excess.secure, false);
      assert.equal(admitted.closed, false);
      assert.equal(sessionStatus(fixture, fixture.opened.session.sessionId).activeUses, 0);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.received.length, 0);

      // A full public listener cannot prevent the operator from closing authority
      // through the production Unix-socket client and control handler.
      const other = fixture.service.open({ durationSeconds: 300, profile: "git-write" });
      const closed = await closeSession(fixture, other.session.sessionId);
      assert.notEqual(closed.state, "OPEN");
      assert.equal(admitted.closed, false);

      // The admitted socket remains usable after overload, including authentication.
      assert.deepEqual(await readDiscovery(fixture, { socket: admitted.socket }), completed());
      await eventually(() => admitted.closed);
      await released(fixture);
      assert.deepEqual(await readDiscovery(fixture), completed());
      assert.equal(fixture.received.length, 2);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
    },
  );

  bounded("an Agent listener retains its original upstream origins", async (t) => {
    const fixture = await startTransport(t, (incoming, outgoing) => {
      incoming.resume();
      outgoing.writeHead(200, replyHeaders).end("0000");
    });
    const api = fixture.service.open({ durationSeconds: 300, profile: "git-full" });
    // The listener was admitted with only the Git peer. Mutating its caller's
    // configuration afterward must not authorize the separate API destination.
    fixture.trustedOrigins.add(fixture.github.origin);
    const target = `/repos/${fixtureRepository}`;
    const client = startRequest(fixture, {
      path: target,
      opened: api,
      headers: { authorization: `Bearer ${api.bearer}` },
    });
    client.outgoing.end();
    assert.equal((await client.result).status, 503);
    assert.equal(
      fixture.github.trace.filter((entry: unknown) => {
        assert.ok(entry !== null && typeof entry === "object" && "target" in entry);
        return entry.target === target;
      }).length,
      0,
    );
    assert.equal((await readDiscovery(fixture)).status, 200);
    assert.deepEqual(fixture.received, discoveryOnly);
  });

  for (const scenario of [
    {
      name: "a declared request exactly at the wire limit is accepted",
      bytes: inputLimit,
      expected: {
        status: 200,
        upstreamRequests: 1,
        issuedCredentials: 0,
        receivedBytes: inputLimit,
      },
    },
    {
      name: "an oversized declared request is refused before acquisition or upstream dispatch",
      bytes: inputLimit + 1,
      expected: { status: 413, upstreamRequests: 0, issuedCredentials: 0, receivedBytes: 0 },
    },
  ]) {
    bounded(scenario.name, async (t) => {
      let receivedBytes = 0;
      const fixture = await startTransport(
        t,
        (incoming, outgoing) => {
          incoming.on("data", (chunk: Buffer) => (receivedBytes += chunk.length));
          incoming.once("end", () => outgoing.writeHead(200, uploadReplyHeaders).end("0000"));
        },
        { gitFetchInputBytes: inputLimit },
      );
      const client = startUpload(fixture, { "content-length": scenario.bytes });
      client.outgoing.end(Buffer.alloc(scenario.bytes, 42));
      const result = await client.result;
      assert.equal(result.kind, "completed");
      assert.equal(result.complete, true);
      assert.equal(result.status, scenario.expected.status);
      assert.equal(fixture.received.length, scenario.expected.upstreamRequests);
      assert.equal(fixture.github.issuesOfTokens.length, scenario.expected.issuedCredentials);
      assert.equal(receivedBytes, scenario.expected.receivedBytes);
    });
  }

  bounded(
    "a refused upload is answered while it still arrives, then cut after the linger bound",
    async (t) => {
      const fixture = await startTransport(
        t,
        (incoming, outgoing) => {
          incoming.resume();
          incoming.once("end", () => outgoing.writeHead(200, replyHeaders).end("0000"));
        },
        { gitFetchInputBytes: inputLimit, stallMs: 1000 },
      );
      // The declared size is refused before any body byte is read. This raw client keeps
      // sending regardless, so only the gateway's linger bound can end the connection.
      const client = connectTlsClient(fixture);
      const authorization = Buffer.from(
        `${fixture.opened.client.gitUsername}:${fixture.opened.bearer}`,
      ).toString("base64");
      client.socket.write(
        [
          `POST ${upload} HTTP/1.1`,
          `host: ${new URL(fixture.config.gateway.publicOrigin).host}`,
          `authorization: Basic ${authorization}`,
          "content-type: application/x-git-upload-pack-request",
          `content-length: ${1 << 30}`,
          "",
          "",
        ].join("\r\n"),
      );
      let answer = "";
      let answeredAt: number | undefined;
      client.socket.on("data", (chunk: Buffer) => {
        answer += chunk.toString("latin1");
        answeredAt ??= Date.now();
      });
      const chunk = Buffer.alloc(16384, 42);
      const pump = setInterval(() => client.closed || client.socket.write(chunk), 2);
      t.after(() => clearInterval(pump));
      await eventually(() => answeredAt !== undefined, { description: "the refusal answer" });
      // The sole exchange slot is free while the refused upload still lingers.
      assert.deepEqual(await readDiscovery(fixture), completed());
      assert.equal(client.closed, false);
      await eventually(() => client.closed, {
        timeoutMs: 5000,
        description: "the refused upload to close",
      });
      clearInterval(pump);
      assert.match(answer, /^HTTP\/1\.1 413 /);
      assert.match(answer, /"limit-exceeded"/);
      // The answer arrived at once; the connection stayed only for the linger bound.
      assert.ok(answeredAt !== undefined);
      const lingered = Date.now() - answeredAt;
      assert.ok(lingered >= 500 && lingered < 4000, `lingered ${lingered} ms`);
      // Only the discovery request reached upstream; the refused upload never did.
      assert.deepEqual(
        fixture.received.map((entry) => entry.method),
        ["GET"],
      );
    },
  );

  bounded("chunked gzip enforces the wire limit even when decoded input fits", async (t) => {
    let receivedBytes = 0;
    let incompleteRequestClosed = false;
    const fixture = await startTransport(
      t,
      (incoming, outgoing) => {
        incoming.on("data", (chunk: Buffer) => (receivedBytes += chunk.length));
        incoming.once("close", () => {
          if (!incoming.complete) {
            incompleteRequestClosed = true;
          }
        });
        incoming.once("end", () =>
          outgoing
            .writeHead(200, incoming.method === "POST" ? uploadReplyHeaders : replyHeaders)
            .end("0000"),
        );
      },
      { gitFetchInputBytes: inputLimit },
    );
    // Stored deflate keeps decoded bytes within the limit while gzip overhead
    // exceeds the independent wire allowance. No Content-Length precheck can help.
    const encoded = gzipSync(Buffer.alloc(inputLimit, 42), { level: 0 });
    assert.ok(encoded.length > inputLimit);
    const client = startUpload(fixture, {
      "content-encoding": "gzip",
      "transfer-encoding": "chunked",
    });
    client.outgoing.write(encoded.subarray(0, 1024));
    await eventually(() => receivedBytes > 0);
    client.outgoing.end(encoded.subarray(1024));
    assert.equal((await client.result).kind, "closed");
    await eventually(
      () =>
        incompleteRequestClosed &&
        sessionStatus(fixture, fixture.opened.session.sessionId).activeUses === 0,
    );
    assert.ok(receivedBytes < inputLimit);
    assert.deepEqual(fixture.received, uploadOnly);
    assert.equal(fixture.github.issuesOfTokens.length, 0);
    assert.deepEqual(await readDiscovery(fixture), completed());
    assert.equal(fixture.received.filter((entry) => entry.method === "POST").length, 1);
  });

  bounded(
    "an upstream disconnect before headers returns a sanitized error and releases the exchange slot",
    async (t) => {
      let requests = 0;
      const fixture = await startTransport(t, (incoming, outgoing) => {
        incoming.resume();
        incoming.once("end", () => {
          // The peer received the complete request but supplied no response. The
          // gateway may report uncertainty; it must not replay the operation.
          if (++requests === 1) {
            outgoing.destroy();
          } else {
            outgoing.writeHead(200, replyHeaders).end("0000");
          }
        });
      });
      const chunks: Buffer[] = [];
      const client = startRequest(fixture, {
        onResponse: (incoming) => incoming.on("data", (chunk: Buffer) => chunks.push(chunk)),
      });
      client.outgoing.end();
      const result = await client.result;
      assert.equal(result.kind, "completed");
      assert.equal(result.status, 502);
      assert.equal(result.complete, true);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        error: { code: "exchange-uncertain" },
      });
      await released(fixture);
      assert.deepEqual(fixture.received, discoveryOnly);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      // Reusing the sole slot proves failure settled I/O and credential ownership.
      assert.deepEqual(await readDiscovery(fixture), completed());
      assert.equal(fixture.received.length, 2);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
    },
  );

  for (const scenario of [
    {
      name: "a response exactly at the limit is delivered completely",
      bytes: responseLimit,
      expected: completed(responseLimit),
    },
    {
      name: "an oversized declared response returns a sanitized error before forwarding upstream bytes",
      bytes: responseLimit + 1,
      expected: {
        kind: "completed",
        status: 502,
        bytes: Buffer.byteLength('{"error":{"code":"exchange-uncertain"}}'),
        complete: true,
      },
    },
  ]) {
    bounded(scenario.name, async (t) => {
      const fixture = await startTransport(
        t,
        (incoming, outgoing) => {
          incoming.resume();
          incoming.once("end", () => {
            outgoing.writeHead(200, { ...replyHeaders, "content-length": scenario.bytes });
            outgoing.end(Buffer.alloc(scenario.bytes, 42));
          });
        },
        { gitResponseBytes: responseLimit },
      );
      const chunks: Buffer[] = [];
      assert.deepEqual(
        await readDiscovery(fixture, {
          onResponse: (incoming) => incoming.on("data", (chunk: Buffer) => chunks.push(chunk)),
        }),
        scenario.expected,
      );
      if (scenario.expected.status === 502) {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
          error: { code: "exchange-uncertain" },
        });
      }
      await released(fixture);
      assert.deepEqual(fixture.received, discoveryOnly);
    });
  }

  bounded("a chunked response overflow truncates the exchange without replay", async (t) => {
    let upstreamResponse: ServerResponse | undefined;
    const fixture = await startTransport(
      t,
      (incoming, outgoing) => {
        incoming.resume();
        upstreamResponse = outgoing;
        outgoing.writeHead(200, replyHeaders);
        outgoing.write(Buffer.alloc(2048, 42));
      },
      { gitResponseBytes: responseLimit },
    );
    let delivered = 0;
    const client = startRequest(fixture, {
      onResponse: (incoming) => incoming.on("data", (chunk: Buffer) => (delivered += chunk.length)),
    });
    client.outgoing.end();
    await eventually(() => delivered === 2048);
    // The client has a successful prefix, so an overflow must terminate that
    // exchange rather than append a service error or retry it as a new request.
    assert.ok(upstreamResponse);
    upstreamResponse.end(Buffer.alloc(2049, 42));
    assert.deepEqual(await client.result, {
      kind: "closed",
      status: 200,
      bytes: 2048,
      complete: false,
    });
    await released(fixture);
    assert.deepEqual(fixture.received, discoveryOnly);
  });

  // The three subtests own separate fixtures, so they overlap too.
  bounded(
    "upstream response timing follows completed upload",
    async (t) => {
      const progressing = t.test(
        "a progressing upload may outlast the first-header budget",
        async (t) => {
          let receivedBytes = 0;
          const fixture = await startTransport(
            t,
            (incoming, outgoing) => {
              incoming.on("data", (chunk: Buffer) => (receivedBytes += chunk.length));
              incoming.once("end", () => outgoing.writeHead(200, uploadReplyHeaders).end("0000"));
            },
            { exchangeMs: 3000, headerMs: 1000, firstHeaderMs: 200, stallMs: 1000 },
          );
          const chunk = Buffer.alloc(64, 42);
          const client = startUpload(fixture, { "content-length": 8 * chunk.length });
          client.outgoing.write(chunk);
          await eventually(() => receivedBytes === chunk.length);
          // Keep the upload progressing beyond the response-header budget while
          // staying inside its independent input, stall and total deadlines.
          for (let index = 1; index < 8; index++) {
            await delay(60);
            client.outgoing.write(chunk);
          }
          client.outgoing.end();
          assert.deepEqual(await client.result, completed());
          assert.equal(receivedBytes, 8 * chunk.length);
          assert.deepEqual(fixture.received, uploadOnly);
          await released(fixture);
        },
      );

      const missing = t.test("missing final headers release the completed upload", async (t) => {
        let inputFinishedAt: number | undefined;
        const fixture = await startTransport(
          t,
          (incoming, outgoing) => {
            incoming.resume();
            if (incoming.url === upload) {
              incoming.once("end", () => (inputFinishedAt = performance.now()));
            } else {
              incoming.once("end", () => outgoing.writeHead(200, replyHeaders).end("0000"));
            }
          },
          { exchangeMs: 5000, firstHeaderMs: 200, stallMs: 2000 },
        );
        const client = startUpload(fixture, { "content-length": 4 });
        client.outgoing.end("0000");
        await eventually(() => inputFinishedAt !== undefined);
        assert.equal((await client.result).kind, "closed");
        // This must be the first-header deadline, before the longer stall/total bounds.
        assert.ok(inputFinishedAt !== undefined);
        assert.ok(performance.now() - inputFinishedAt < 1500);
        await released(fixture);
        assert.equal((await readDiscovery(fixture)).status, 200);
        assert.deepEqual(fixture.received, [...uploadOnly, ...discoveryOnly]);
      });

      const early = t.test("early final headers cannot restart the header deadline", async (t) => {
        let receivedHeaders = false;
        const fixture = await startTransport(
          t,
          (incoming, outgoing) => {
            incoming.resume();
            outgoing.writeHead(200, uploadReplyHeaders);
            outgoing.write("0000");
            incoming.once("end", () => {
              let writes = 0;
              const timer = setInterval(() => {
                outgoing.write("0000");
                if (++writes === 6) {
                  clearInterval(timer);
                  outgoing.end();
                }
              }, 60);
              outgoing.once("close", () => clearInterval(timer));
            });
          },
          { exchangeMs: 3000, headerMs: 1000, firstHeaderMs: 150, stallMs: 1000 },
        );
        const client = startUpload(
          fixture,
          { "content-length": 8 },
          { onResponse: () => (receivedHeaders = true) },
        );
        client.outgoing.write("0000");
        await eventually(() => receivedHeaders);
        client.outgoing.end("0000");
        assert.deepEqual(await client.result, completed(28));
        assert.deepEqual(fixture.received, uploadOnly);
      });

      await Promise.all([progressing, missing, early]);
    },
    { concurrency: true },
  );

  bounded(
    "a paused upstream bounds upload producer progress and resumes without data loss",
    async (t) => {
      let upstreamRequest: IncomingMessage | undefined;
      let receivedBytes = 0;
      const hash = createHash("sha256");
      const fixture = await startTransport(
        t,
        (incoming, outgoing) => {
          upstreamRequest = incoming;
          incoming.pause();
          incoming.on("data", (chunk: Buffer) => {
            receivedBytes += chunk.length;
            hash.update(chunk);
          });
          incoming.once("end", () => outgoing.writeHead(200, uploadReplyHeaders).end("0000"));
        },
        { gitFetchInputBytes: producerCapBytes },
      );
      // Chunked framing lets the producer decide its length while it runs.
      const client = startUpload(fixture, { "transfer-encoding": "chunked" });
      const producer = writePayload(client.outgoing, () => upstreamRequest !== undefined);
      await eventually(() => upstreamRequest !== undefined);
      const pausedBytes = await producer.stalled;
      t.diagnostic(`Upload producer stalled at ${pausedBytes} bytes before upstream resumed.`);
      assert.equal(receivedBytes, 0);
      assert.ok(upstreamRequest);
      upstreamRequest.resume();
      assert.deepEqual(await client.result, completed());
      assert.equal(producer.producedBytes(), pausedBytes);
      assert.equal(receivedBytes, pausedBytes);
      assert.equal(hash.digest("hex"), producer.digest());
      assert.deepEqual(fixture.received, uploadOnly);
    },
  );

  bounded(
    "a paused client bounds response producer progress and resumes without data loss",
    async (t) => {
      let producer: ReturnType<typeof writePayload> | undefined;
      const fixture = await startTransport(t, (incoming, outgoing) => {
        incoming.resume();
        outgoing.writeHead(200, replyHeaders);
        producer = writePayload(outgoing, () => incomingResponse !== undefined);
      });
      let incomingResponse: IncomingMessage | undefined;
      const client = startRequest(fixture, {
        onResponse(incoming) {
          incoming.pause();
          incomingResponse = incoming;
        },
      });
      client.outgoing.end();
      await eventually(() => incomingResponse !== undefined);
      assert.ok(producer);
      const pausedBytes = await producer.stalled;
      t.diagnostic(`Response producer stalled at ${pausedBytes} bytes before client resumed.`);
      assert.ok(incomingResponse);
      incomingResponse.resume();
      assert.deepEqual(await client.result, completed(pausedBytes));
      assert.equal(producer.producedBytes(), pausedBytes);
      assert.equal(client.digest(), producer.digest());
      assert.deepEqual(fixture.received, discoveryOnly);
    },
  );

  for (const responseStarted of [false, true]) {
    bounded(
      `control close ${responseStarted ? "during a live response" : "before response headers"} releases its credential and exchange slot`,
      async (t) => {
        let upstreamCancelled = false;
        let inputReceived = false;
        let requests = 0;
        const fixture = await startTransport(t, (incoming, outgoing) => {
          incoming.once("end", () => {
            inputReceived = true;
            if (++requests === 1) {
              outgoing.once("close", () => (upstreamCancelled = !outgoing.writableFinished));
              if (responseStarted) {
                outgoing.writeHead(200, replyHeaders).write("0000");
              }
            } else {
              outgoing.writeHead(200, replyHeaders).end("0000");
            }
          });
          incoming.resume();
        });
        let delivered = 0;
        const client = startRequest(fixture, {
          onResponse: (incoming) =>
            incoming.on("data", (chunk: Buffer) => (delivered += chunk.length)),
        });
        client.outgoing.end();
        // Consume the complete input before closing. With no response headers,
        // revocation must still abort where an upstream failure could report 502.
        await eventually(() => (responseStarted ? delivered === 4 : inputReceived));
        const sessionId = fixture.opened.session.sessionId;
        assert.equal(sessionStatus(fixture, sessionId).activeUses, 1);
        const closed = await closeSession(fixture, sessionId);
        assert.equal(closed.state, "CLOSED");
        // Closure must cancel active I/O before the independent five-second stall
        // timer could do so; eventual timeout is not proof of session cancellation.
        await eventually(
          () => upstreamCancelled && sessionStatus(fixture, sessionId).state === "DISPOSED",
          { timeoutMs: 1000 },
        );
        assert.deepEqual(await client.result, {
          kind: "closed",
          status: responseStarted ? 200 : undefined,
          bytes: responseStarted ? 4 : 0,
          complete: false,
        });
        const status = sessionStatus(fixture, sessionId);
        assert.equal(status.activeUses, 0);
        assert.deepEqual(status.cleanup, {
          active: 0,
          pending: 0,
          revoked: 0,
          expired: 1,
          uncertain: 0,
          auxiliaryPending: false,
        });
        assert.equal(fixture.github.tokenState()[0].revoked, false);
        assert.equal((await readDiscovery(fixture)).status, 401);
        assert.equal(fixture.received.length, 1);
        assert.equal(fixture.github.issuesOfTokens.length, 0);
        // A new session uses the sole exchange slot after the cancelled I/O settles.
        fixture.opened = fixture.service.open({ durationSeconds: 300, profile: "git-write" });
        assert.deepEqual(await readDiscovery(fixture), completed());
        assert.equal(fixture.received.length, 2);
      },
    );
  }
});
