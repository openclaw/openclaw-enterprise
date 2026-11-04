import assert from "node:assert/strict";
import { once } from "node:events";
import type { TestContext } from "node:test";
import type { RequestListener } from "node:http";
import type { Server } from "node:net";
import { connect, type TlsOptions, type TLSSocket } from "node:tls";
import { controlledTlsOrigin } from "./controlled-tls-origin.ts";
import { harnessTlsFixture } from "./harness-tls.mjs";
import { listen } from "./listen.mjs";

type Observation = ReturnType<ReturnType<typeof controlledTlsOrigin>["snapshot"]>;

/** Owns a real TLS client and origin; callers specify and assert their own observations. */
export async function controlledTlsOriginScenario(t: TestContext) {
  const peer = await tlsOriginPeer(t, (tls) =>
    controlledTlsOrigin(tls, (request, response) => {
      request.on("end", () => response.end("ok"));
      // This sink intentionally discards the body before acknowledging completion.
      request.resume();
    }),
  );
  const { origin } = peer;

  function observe(predicate: (observation: Observation) => boolean): Promise<Observation> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        origin.off("observation", check);
        reject(new Error(`Origin observation timed out: ${JSON.stringify(origin.snapshot())}`));
      }, 3000);
      function check() {
        const observation = origin.snapshot();
        if (predicate(observation)) {
          clearTimeout(timer);
          origin.off("observation", check);
          resolve(observation);
        }
      }
      origin.on("observation", check);
      check();
    });
  }

  return {
    ...peer,
    observe,
    async writeAndObserve(
      socket: TLSSocket,
      bytes: string,
      predicate: (observation: Observation) => boolean,
    ) {
      const observation = observe(predicate);
      socket.write(bytes);
      return observation;
    },
  };
}

/** Send a framed request and drain its fixed two-byte fixture reply without closing the socket. */
export async function writeAndDrain(socket: TLSSocket, request: string): Promise<string> {
  socket.write(request);
  let received = "";
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    received += chunk.toString();
    const boundary = received.indexOf("\r\n\r\n");
    if (boundary < 0) {
      continue;
    }
    const headers = received.slice(0, boundary).split("\r\n");
    assert.match(headers[0] ?? "", /^HTTP\/1\.1 200(?: |$)/, "fixture reply status");
    assert.deepEqual(
      headers
        .filter((line) => /^content-length:/i.test(line))
        .map((line) => line.slice(line.indexOf(":") + 1).trim()),
      ["2"],
      "fixture reply Content-Length",
    );
    const body = received.slice(boundary + 4);
    if (body.length >= 2) {
      assert.equal(body, "ok", "fixture reply body");
      return body;
    }
  }
  throw new Error("Origin reply ended before completion.");
}

/** Own a loopback server and certificate-verified clients for one test. */
export async function tlsOriginPeer<T extends Server>(
  t: TestContext,
  create: (tls: Awaited<ReturnType<typeof harnessTlsFixture>>) => T,
) {
  const tls = await harnessTlsFixture(t);
  const origin = create(tls);
  const port = await listen(t, origin);
  return { origin, connect: () => verifiedTlsClient(t, port, tls.caBundle) };
}

/** One permitted send may activate one connection; a partial second send is forbidden. */
export function assertSingleRequestWindow(observation: Observation) {
  assert.equal(observation.droppedRequests, 0, "no native parser drops in an allowed send");
  const active = observation.connections.filter((row) => row.decryptedBytes > 0);
  assert.equal(active.length, 1, "one application-bearing connection per allowed send");
  assert.ok(active[0]);
  assert.equal(active[0].completeRequests, 1, "the allowed connection completes one request");
  assert.equal(observation.completeRequests, 1);
}

export function singleRequestTlsOrigin(tls: TlsOptions, handle: RequestListener) {
  return controlledTlsOrigin(tls, handle, { maxRequestsPerSocket: 1 });
}

/**
 * Check the last acknowledged byte total at the verified grant, then observe the send.
 * Additional unframed bytes on the same socket inside this window cannot be attributed separately.
 */
export async function observeGrantedSend<T>(
  origin: ReturnType<typeof controlledTlsOrigin>,
  expectedBytes: number,
  grant: () => Promise<void>,
  send: () => Promise<T>,
): Promise<T> {
  await grant();
  assert.equal(
    origin.snapshot().decryptedBytes,
    expectedBytes,
    "origin bytes changed before granted send",
  );
  const mark = origin.mark();
  const result = await send();
  assertSingleRequestWindow(origin.since(mark));
  return result;
}

export function assertApplicationConnections(observation: Observation, expected: number) {
  assert.equal(observation.droppedRequests, 0, "no native parser drops across allowed sends");
  const active = observation.connections.filter((row) => row.decryptedBytes > 0);
  assert.deepEqual(
    active.map((row) => row.completeRequests),
    Array(expected).fill(1),
  );
  assert.equal(observation.completeRequests, expected);
}

/** Connect only to the test loopback origin and verify its fixture certificate. */
export async function verifiedTlsClient(
  t: TestContext,
  port: number,
  ca: TlsOptions["ca"],
): Promise<TLSSocket> {
  const socket = connect({ host: "127.0.0.1", port, servername: "localhost", ca });
  t.after(() => socket.destroy());
  await once(socket, "secureConnect");
  assert.equal(socket.authorized, true);
  return socket;
}
