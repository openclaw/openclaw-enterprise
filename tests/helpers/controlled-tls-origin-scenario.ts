import assert from "node:assert/strict";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { connect, type TLSSocket } from "node:tls";
import { controlledTlsOrigin } from "./controlled-tls-origin.ts";
import { harnessTlsFixture } from "./harness-tls.mjs";
import { listen } from "./listen.mjs";

type Observation = ReturnType<ReturnType<typeof controlledTlsOrigin>["snapshot"]>;

/** Owns a real TLS client and origin; callers specify and assert their own observations. */
export async function controlledTlsOriginScenario(t: TestContext) {
  const tls = await harnessTlsFixture(t);
  const origin = controlledTlsOrigin(tls, (request, response) => {
    request.on("end", () => response.end("ok"));
  });
  const port = await listen(t, origin);

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
    origin,
    observe,
    async connect() {
      const socket = connect({
        host: "127.0.0.1",
        port,
        servername: "localhost",
        ca: tls.caBundle,
      });
      t.after(() => socket.destroy());
      await once(socket, "secureConnect");
      assert.equal(socket.authorized, true);
      return socket;
    },
    async writeAndObserve(
      socket: TLSSocket,
      bytes: string,
      predicate: (observation: Observation) => boolean,
    ) {
      const observation = observe(predicate);
      socket.write(bytes);
      return observation;
    },
    async writeAndDrain(socket: TLSSocket, request: string) {
      const reply = completedReply(socket);
      socket.write(request);
      await reply;
    },
  };
}

async function completedReply(socket: TLSSocket): Promise<void> {
  let received = "";
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    received += chunk.toString();
    if (received.endsWith("\r\n\r\nok")) {
      return;
    }
  }
  throw new Error("Origin reply ended before completion.");
}
