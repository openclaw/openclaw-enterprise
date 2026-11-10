import test, { type TestContext } from "node:test";
import type { RepositoryBackendFactory } from "../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import assert from "node:assert/strict";
import { request as httpsRequest, createServer as createHttpsServer } from "node:https";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { within } from "../helpers/wait-for.mjs";
import { listen } from "../fixtures/repository-credentials/process.mjs";
import { startTokenServiceScope } from "../fixtures/repository-credentials/service.mjs";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";
import {
  createStaticTokenServiceFactory,
  startServiceListeners,
} from "../fixtures/repository-credentials/service-resources.mjs";

async function fixture(t: TestContext) {
  const options = {
    github: true,
    clock: "system",
    limits: {
      headerMs: 200,
      stallMs: 2000,
      connectMs: 2000,
      firstHeaderMs: 2000,
      exchangeMs: 5000,
    },
  };
  const scope = await startTokenServiceScope(t, options);
  const { resources, tls, github } = scope;
  assert.ok(github);
  const headerMs: unknown = scope.config.limits.headerMs;
  assert.ok(typeof headerMs === "number");
  const upstream = createHttpsServer(tls, (request, response) => {
    if (!github.authorize(request.headers.authorization, "git")) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
    response.end("0000");
  });
  const upstreamOrigin = await listen(resources, upstream);
  const created = await createStaticTokenServiceFactory(resources, {
    config: scope.config,
    clock: scope.clock,
    tls,
    github,
    gitOrigin: upstreamOrigin,
    configuration: undefined,
  });
  const untypedFactory: unknown = created.factory;
  assert.ok(untypedFactory && typeof untypedFactory === "object");
  for (const method of ["parseAuthentication", "resolve", "create", "unauthenticated"]) {
    assert.equal(typeof Reflect.get(untypedFactory, method), "function");
  }
  const actualFactory = untypedFactory as RepositoryBackendFactory;
  let acquisitionStarted = false;
  let acquisitionFinished = Promise.resolve();
  const factory: RepositoryBackendFactory = {
    ...actualFactory,
    create(input) {
      const backend = actualFactory.create(input);
      return {
        ...backend,
        async acquire(...args) {
          acquisitionStarted = true;
          const completion = Promise.withResolvers<void>();
          acquisitionFinished = completion.promise;
          try {
            // Model a provider queue/acquisition delay after the authenticated
            // request has been admitted, before any provider dispatch occurs.
            await delay(headerMs * 3);
            return await backend.acquire(...args);
          } finally {
            completion.resolve();
          }
        },
      };
    },
  };
  resources.after(() => acquisitionFinished);
  const started = await startServiceListeners(resources, {
    config: scope.config,
    factory,
    clock: scope.clock,
    tls,
    upstreamOrigins: [github.origin, upstreamOrigin],
    log: undefined,
  });
  const port: unknown = started.listeners.address.port;
  assert.ok(typeof port === "number");
  return {
    resources,
    service: started.service,
    port,
    tls,
    acquisitionStarted: () => acquisitionStarted,
  };
}

test(
  "authenticated TLS request outlives the header timeout while acquiring credentials",
  { timeout: 10000 },
  async (t) => {
    const context = await fixture(t);
    const opened = context.service.open({ durationSeconds: 60, profile: "git-read" });
    const result = await new Promise((resolve, reject) => {
      const outgoing = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: context.port,
          path: `/${fixtureRepository}.git/info/refs?service=git-upload-pack`,
          ca: context.tls.ca,
          agent: false,
          headers: {
            host: "credentials.example.test",
            authorization: `Basic ${Buffer.from(`gateway-session:${opened.bearer}`).toString("base64")}`,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () =>
            resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      const closed = new Promise((done) => outgoing.once("close", done));
      context.resources.after(async () => {
        outgoing.destroy();
        await closed;
      });
      outgoing.once("error", reject);
      outgoing.end();
    }).finally(() =>
      assert.equal(context.acquisitionStarted(), true, "request must reach credential acquisition"),
    );
    assert.deepEqual(result, { status: 200, body: "0000" });
  },
);

for (const handshake of [false, true]) {
  test(
    `TLS listener bounds ${handshake ? "incomplete HTTP headers" : "incomplete TLS handshake"}`,
    { timeout: 10000 },
    async (t) => {
      const context = await fixture(t);
      const socket = handshake
        ? connectTls({
            host: "127.0.0.1",
            port: context.port,
            ca: context.tls.ca,
          })
        : connectTcp({ host: "127.0.0.1", port: context.port });
      const closed = new Promise((done) => socket.once("close", done));
      context.resources.after(async () => {
        socket.destroy();
        await closed;
      });
      socket.on("error", () => {});
      let tcpConnected = false;
      socket.once("connect", () => {
        tcpConnected = true;
      });
      let secureConnected = false;
      let headersWritten = false;
      if (handshake) {
        socket.once("secureConnect", () => {
          secureConnected = true;
          socket.write("GET / HTTP/1.1\r\nHost: credentials.example.test\r\n");
          headersWritten = true;
        });
      }
      await within(closed, "listener failed to close incomplete request", 1_000);
      if (handshake) {
        assert.equal(secureConnected, true, "TLS handshake must complete before the header bound");
        assert.equal(headersWritten, true, "incomplete HTTP headers must reach the TLS socket");
      } else {
        assert.equal(tcpConnected, true, "TCP must connect before the TLS handshake bound");
      }
    },
  );
}
