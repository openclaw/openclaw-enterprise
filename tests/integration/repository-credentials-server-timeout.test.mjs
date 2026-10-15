import test from "node:test";
import assert from "node:assert/strict";
import { request as httpsRequest, createServer as createHttpsServer } from "node:https";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { appModule } from "../fixtures/repository-credentials/runtime.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";
import { createLoopbackServiceConfiguration } from "../fixtures/repository-credentials/service.mjs";
import {
  startGitHubFixture,
  fixtureRepository,
} from "../fixtures/repository-credentials/github.mjs";
import {
  createGitHubServiceFactory,
  startServiceListeners,
} from "../fixtures/repository-credentials/service-resources.mjs";

async function fixture(t) {
  const resources = createTestResourceScope(t);
  const { createSystemClock } = await appModule("drivers/repo/credentials/clock");
  const clock = createSystemClock();
  const tls = await createTlsMaterial(resources);
  const config = await createLoopbackServiceConfiguration(resources, {
    headerMs: 200,
    stallMs: 2000,
    connectMs: 2000,
    firstHeaderMs: 2000,
    exchangeMs: 5000,
  });
  const github = await startGitHubFixture(resources, { clock, tls });
  const upstream = createHttpsServer(tls, (request, response) => {
    if (!github.authorize(request.headers.authorization, "git")) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
    response.end("0000");
  });
  const upstreamOrigin = await listen(resources, upstream);
  const actualFactory = await createGitHubServiceFactory(resources, {
    config,
    clock,
    privateKey: github.privateKey,
    trustedEndpoints: { apiOrigin: github.origin, gitOrigin: upstreamOrigin, ca: tls.ca },
  });
  let acquisitionStarted = false;
  let acquisitionFinished = Promise.resolve();
  const factory = {
    ...actualFactory,
    create(input) {
      const backend = actualFactory.create(input);
      return {
        ...backend,
        async acquire(...args) {
          acquisitionStarted = true;
          const completion = Promise.withResolvers();
          acquisitionFinished = completion.promise;
          try {
            // Model a provider queue/acquisition delay after the authenticated
            // request has been admitted, before any provider dispatch occurs.
            await delay(config.limits.headerMs * 3);
            return await backend.acquire(...args);
          } finally {
            completion.resolve();
          }
        },
      };
    },
  };
  resources.after(() => acquisitionFinished);
  const { service, listeners } = await startServiceListeners(resources, {
    config,
    factory,
    clock,
    tls,
    upstreamOrigins: [github.origin, upstreamOrigin],
  });
  return { resources, service, listeners, tls, acquisitionStarted: () => acquisitionStarted };
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
          port: context.listeners.address.port,
          path: `/${fixtureRepository}.git/info/refs?service=git-upload-pack`,
          ca: context.tls.ca,
          agent: false,
          headers: {
            host: "credentials.example.test",
            authorization: `Basic ${Buffer.from(`gateway-session:${opened.bearer}`).toString("base64")}`,
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
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
            port: context.listeners.address.port,
            ca: context.tls.ca,
          })
        : connectTcp({ host: "127.0.0.1", port: context.listeners.address.port });
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
      let deadline;
      try {
        await Promise.race([
          closed,
          new Promise((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("listener failed to close incomplete request")),
              1000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      if (handshake) {
        assert.equal(secureConnected, true, "TLS handshake must complete before the header bound");
        assert.equal(headersWritten, true, "incomplete HTTP headers must reach the TLS socket");
      } else {
        assert.equal(tcpConnected, true, "TCP must connect before the TLS handshake bound");
      }
    },
  );
}
