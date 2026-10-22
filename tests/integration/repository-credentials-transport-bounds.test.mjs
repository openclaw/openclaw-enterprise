import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import { createServer, request } from "node:https";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import {
  fixtureRepository,
  startGitHubFixture,
} from "../fixtures/repository-credentials/github.mjs";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";
import {
  appModule,
  eventually,
  createLoopbackServiceConfiguration,
} from "../fixtures/repository-credentials/service.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import {
  createGitHubTokenServiceFactory,
  startServiceListeners,
} from "../fixtures/repository-credentials/service-resources.mjs";

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
async function startTransport(t, onRequest, limits = {}) {
  const resources = createTestResourceScope(t);
  const { createSystemClock } = await appModule("drivers/repo/credentials/clock");
  const clock = createSystemClock();
  const tls = await createTlsMaterial(resources);
  // One exchange slot makes leaked reservations visible to the following request.
  const config = await createLoopbackServiceConfiguration(resources, {
    exchanges: 1,
    exchangesPerSession: 1,
    exchangeMs: 10000,
    firstHeaderMs: 5000,
    gitFetchExchangeMs: limits.exchangeMs ?? 10000,
    gitFetchFirstHeaderMs: limits.firstHeaderMs ?? 5000,
    gitFetchStallMs: limits.stallMs ?? 5000,
    ...limits,
  });
  const github = await startGitHubFixture(resources, { clock, tls });
  const received = [];
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
  const token = `gho_${"t".repeat(36)}`;
  github.acceptStatic(token);
  const factory = await createGitHubTokenServiceFactory(resources, {
    config,
    clock,
    token,
    trustedEndpoints: { apiOrigin: github.origin, gitOrigin: origin, ca: tls.ca },
  });
  const { service, listeners } = await startServiceListeners(resources, {
    config,
    factory,
    clock,
    tls,
    // Pass the caller's original set so production owns the security-relevant copy.
    trustedUpstreamOrigins: trustedOrigins,
  });
  const opened = service.open({ durationSeconds: 300, profile: "git-write" });
  return { config, tls, service, listeners, opened, github, received, resources, trustedOrigins };
}

function startRequest(
  fixture,
  {
    method = "GET",
    path = discovery,
    headers = {},
    opened = fixture.opened,
    socket,
    onResponse,
  } = {},
) {
  let incoming;
  let bytes = 0;
  let timer;
  const hash = createHash("sha256");
  const { promise: result, resolve } = Promise.withResolvers();
  const finish = (kind) => {
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
      response.on("data", (chunk) => {
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
  timer = setTimeout(() => {
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

function startUpload(fixture, headers, options) {
  return startRequest(fixture, {
    ...options,
    method: "POST",
    path: upload,
    headers: { "content-type": "application/x-git-upload-pack-request", ...headers },
  });
}

async function readDiscovery(fixture, options) {
  const client = startRequest(fixture, options);
  client.outgoing.end();
  return client.result;
}

function released(fixture, opened = fixture.opened) {
  return eventually(() => fixture.service.status(opened.session.sessionId).activeUses === 0);
}

function assertRefused(result) {
  assert.equal(result.kind, "completed");
  assert.equal(result.status, 503);
  assert.equal(result.complete, true);
  assert.ok(result.bytes > 0 && result.bytes <= 256);
}

async function closeSession(fixture, sessionId) {
  const { callControl } = await appModule("drivers/repo/github/credentials/client/operator");
  return callControl(fixture.config.gateway.controlSocket, {
    method: "POST",
    path: `/v1/sessions/${sessionId}/close`,
  });
}

function connectTlsClient(fixture) {
  const socket = connectTls({
    host: "127.0.0.1",
    port: fixture.listeners.address.port,
    ca: fixture.tls.ca,
  });
  const state = { socket, secure: false, closed: false };
  socket.once("secureConnect", () => (state.secure = true));
  // Capacity rejection can surface as either an error or a clean close.
  socket.on("error", () => {});
  const closed = new Promise((resolve) =>
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

const streamBytes = 64 * 1024 * 1024;
const streamChunk = Buffer.alloc(64 * 1024, 42);
const producerPauseTimeoutMs = 1000;
const producerStableMs = 200;
// Hashed once up front, not inside two cases, to keep it off the shared event loop.
const payloadDigest = (() => {
  const hash = createHash("sha256");
  for (let offset = 0; offset < streamBytes; offset += streamChunk.length) {
    hash.update(streamChunk);
  }
  return hash.digest("hex");
})();

function writePayload(outgoing) {
  let producedBytes = 0;
  let observedBackpressure = false;
  const { promise: blocked, resolve: resolveBlocked } = Promise.withResolvers();
  const write = () => {
    while (producedBytes < streamBytes) {
      producedBytes += streamChunk.length;
      if (!outgoing.write(streamChunk)) {
        if (!observedBackpressure) {
          observedBackpressure = true;
          resolveBlocked(producedBytes);
        }
        outgoing.once("drain", write);
        return;
      }
    }
    outgoing.end();
    if (!observedBackpressure) {
      resolveBlocked(producedBytes);
    }
  };
  outgoing.once("close", () => outgoing.off("drain", write));
  write();
  return { blocked, producedBytes: () => producedBytes };
}

async function assertProducerBlocked(producer) {
  await Promise.race([
    producer.blocked,
    delay(producerPauseTimeoutMs).then(() => {
      assert.fail("producer did not observe backpressure while consumer was paused");
    }),
  ]);
  const deadline = Date.now() + producerPauseTimeoutMs;
  let observed = producer.producedBytes();
  let lastProgressAt = Date.now();
  assert.ok(observed > 0, "producer did not start while consumer was paused");
  // Keep the consumer paused for the entire window: an early plateau can be
  // followed by more socket-buffer progress without the consumer resuming.
  while (Date.now() < deadline) {
    await delay(50);
    const current = producer.producedBytes();
    assert.ok(
      current < streamBytes,
      `producer completed ${current} bytes while consumer was paused`,
    );
    if (current !== observed) {
      observed = current;
      lastProgressAt = Date.now();
    }
  }
  assert.ok(
    Date.now() - lastProgressAt >= producerStableMs,
    `producer kept advancing while consumer was paused; last observed ${observed} bytes`,
  );
  return observed;
}

// Every case owns its listeners, upstream and sessions, and most of each case is
// spent waiting on a deliberate deadline, so two cases overlap their waits (the
// upstream-timing case runs its three light subtests together). The cases share one
// event loop: with three or more, CPU starvation (4 copies on one CPU) broke the
// producer stability windows and the 150 ms header deadline.
describe("repository credential transport bounds", { concurrency: 2 }, () => {
  const bounded = (name, fn, options) => test(name, { timeout: 15000, ...options }, fn);

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
        const close = new Promise((resolve) =>
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

  bounded(
    "occupied per-session and total exchange limits refuse excess traffic and recover",
    async (t) => {
      const heldResponses = [];
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
            incoming.on("data", (chunk) => (delivered[index] += chunk.length)),
        }),
      );
      const eightZeros = createHash("sha256").update("00000000").digest("hex");
      heldClients[0].outgoing.end();
      await eventually(() => delivered[0] === 4);

      // One total slot is still free: this refusal belongs to the session bound.
      assertRefused(await readDiscovery(fixture, { opened: first }));
      assert.equal(fixture.service.status(first.session.sessionId).activeUses, 1);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.received.length, 1);

      // An independent session can occupy the other slot while the first stays live.
      heldClients[1].outgoing.end();
      await eventually(() => delivered[1] === 4);
      assert.equal(fixture.service.status(second.session.sessionId).activeUses, 1);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.received.length, 2);

      assertRefused(await readDiscovery(fixture, { opened: third }));
      assert.equal(fixture.service.status(third.session.sessionId).activeUses, 0);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.received.length, 2);

      // Denial cannot cancel either admitted stream or replace its credential.
      for (const response of heldResponses) {
        response.write("0000");
      }
      await eventually(() => delivered.every((bytes) => bytes === 8));
      for (const opened of [first, second]) {
        assert.equal(fixture.service.status(opened.session.sessionId).activeUses, 1);
      }
      heldResponses[0].end();
      assert.deepEqual(await heldClients[0].result, completed(8));
      assert.equal(heldClients[0].digest(), eightZeros);
      await released(fixture, first);

      // Both previously denied callers recover while the second stream still owns a slot.
      for (const opened of [first, third]) {
        assert.deepEqual(await readDiscovery(fixture, { opened }), completed());
        await released(fixture, opened);
      }
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.received.length, 4);
      assert.equal(fixture.service.status(second.session.sessionId).activeUses, 1);
      heldResponses[1].end();
      assert.deepEqual(await heldClients[1].result, completed(8));
      assert.equal(heldClients[1].digest(), eightZeros);
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
      assert.equal(fixture.service.status(fixture.opened.session.sessionId).activeUses, 0);
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
    assert.equal(fixture.github.trace.filter((entry) => entry.target === target).length, 0);
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
          incoming.on("data", (chunk) => (receivedBytes += chunk.length));
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
      let answeredAt;
      client.socket.on("data", (chunk) => {
        answer += chunk.toString("latin1");
        answeredAt ??= Date.now();
      });
      const chunk = Buffer.alloc(16384, 42);
      const pump = setInterval(() => client.closed || client.socket.write(chunk), 2);
      t.after(() => clearInterval(pump));
      await eventually(() => answeredAt !== undefined, { message: "refusal was not answered" });
      // The sole exchange slot is free while the refused upload still lingers.
      assert.deepEqual(await readDiscovery(fixture), completed());
      assert.equal(client.closed, false);
      await eventually(() => client.closed, {
        timeoutMs: 5000,
        message: "refused upload kept lingering",
      });
      clearInterval(pump);
      assert.match(answer, /^HTTP\/1\.1 413 /);
      assert.match(answer, /"limit-exceeded"/);
      // The answer arrived at once; the connection stayed only for the linger bound.
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
        incoming.on("data", (chunk) => (receivedBytes += chunk.length));
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
        fixture.service.status(fixture.opened.session.sessionId).activeUses === 0,
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
      const chunks = [];
      const client = startRequest(fixture, {
        onResponse: (incoming) => incoming.on("data", (chunk) => chunks.push(chunk)),
      });
      client.outgoing.end();
      const result = await client.result;
      assert.equal(result.kind, "completed");
      assert.equal(result.status, 502);
      assert.equal(result.complete, true);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), {
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
      const chunks = [];
      assert.deepEqual(
        await readDiscovery(fixture, {
          onResponse: (incoming) => incoming.on("data", (chunk) => chunks.push(chunk)),
        }),
        scenario.expected,
      );
      if (scenario.expected.status === 502) {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks)), {
          error: { code: "exchange-uncertain" },
        });
      }
      await released(fixture);
      assert.deepEqual(fixture.received, discoveryOnly);
    });
  }

  bounded("a chunked response overflow truncates the exchange without replay", async (t) => {
    let upstreamResponse;
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
      onResponse: (incoming) => incoming.on("data", (chunk) => (delivered += chunk.length)),
    });
    client.outgoing.end();
    await eventually(() => delivered === 2048);
    // The client has a successful prefix, so an overflow must terminate that
    // exchange rather than append a service error or retry it as a new request.
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
              incoming.on("data", (chunk) => (receivedBytes += chunk.length));
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
        let inputFinishedAt;
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
      let upstreamRequest;
      let receivedBytes = 0;
      const hash = createHash("sha256");
      const fixture = await startTransport(
        t,
        (incoming, outgoing) => {
          upstreamRequest = incoming;
          incoming.pause();
          incoming.on("data", (chunk) => {
            receivedBytes += chunk.length;
            hash.update(chunk);
          });
          incoming.once("end", () => outgoing.writeHead(200, uploadReplyHeaders).end("0000"));
        },
        { gitFetchInputBytes: streamBytes },
      );
      const client = startUpload(fixture, { "content-length": streamBytes });
      const producer = writePayload(client.outgoing);
      await eventually(() => upstreamRequest !== undefined);
      const pausedBytes = await assertProducerBlocked(producer);
      t.diagnostic(
        `Upload producer stopped at ${pausedBytes} of ${streamBytes} bytes before upstream resumed.`,
      );
      assert.equal(receivedBytes, 0);
      upstreamRequest.resume();
      assert.deepEqual(await client.result, completed());
      assert.equal(producer.producedBytes(), streamBytes);
      assert.equal(receivedBytes, streamBytes);
      assert.equal(hash.digest("hex"), payloadDigest);
      assert.deepEqual(fixture.received, uploadOnly);
    },
  );

  bounded(
    "a paused client bounds response producer progress and resumes without data loss",
    async (t) => {
      let producer;
      const fixture = await startTransport(t, (incoming, outgoing) => {
        incoming.resume();
        outgoing.writeHead(200, replyHeaders);
        producer = writePayload(outgoing);
      });
      let incomingResponse;
      const client = startRequest(fixture, {
        onResponse(incoming) {
          incoming.pause();
          incomingResponse = incoming;
        },
      });
      client.outgoing.end();
      await eventually(() => incomingResponse !== undefined);
      const pausedBytes = await assertProducerBlocked(producer);
      t.diagnostic(
        `Response producer stopped at ${pausedBytes} of ${streamBytes} bytes before client resumed.`,
      );
      incomingResponse.resume();
      assert.deepEqual(await client.result, completed(streamBytes));
      assert.equal(producer.producedBytes(), streamBytes);
      assert.equal(client.digest(), payloadDigest);
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
          onResponse: (incoming) => incoming.on("data", (chunk) => (delivered += chunk.length)),
        });
        client.outgoing.end();
        // Consume the complete input before closing. With no response headers,
        // revocation must still abort where an upstream failure could report 502.
        await eventually(() => (responseStarted ? delivered === 4 : inputReceived));
        const sessionId = fixture.opened.session.sessionId;
        assert.equal(fixture.service.status(sessionId).activeUses, 1);
        const closed = await closeSession(fixture, sessionId);
        assert.equal(closed.state, "CLOSED");
        // Closure must cancel active I/O before the independent five-second stall
        // timer could do so; eventual timeout is not proof of session cancellation.
        await eventually(
          () => upstreamCancelled && fixture.service.status(sessionId).state === "DISPOSED",
          { timeoutMs: 1000 },
        );
        assert.deepEqual(await client.result, {
          kind: "closed",
          status: responseStarted ? 200 : undefined,
          bytes: responseStarted ? 4 : 0,
          complete: false,
        });
        const status = fixture.service.status(sessionId);
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
