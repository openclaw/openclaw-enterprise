import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { custodyOriginWire } from "./egress-custody-origin-wire.mjs";

export const credentialFreeRepository = { id: 7311, full_name: "fixture/credential-free" };

export async function startCustodyRepositoryOrigin(t, configuration) {
  const observations = [];
  const server = custodyOriginWire(
    {
      cert: await readFile(configuration.certificatePath),
      key: await readFile(configuration.privateKeyPath),
    },
    async (req, res) => {
      let bodyBytes = 0;
      for await (const chunk of req) {
        bodyBytes += chunk.length;
      }
      const exactCredentialFreeRead =
        req.method === "GET" &&
        req.url === "/repos/" + credentialFreeRepository.full_name &&
        bodyBytes === 0 &&
        Object.keys(req.headers).every((name) =>
          ["host", "connection", "content-length", "accept", "user-agent"].includes(name),
        );
      const entry = { exactCredentialFreeRead, finished: false };
      observations.push(entry);
      if (!exactCredentialFreeRead) {
        res.writeHead(403).end();
        return;
      }
      assert.ok(server.requestOnWire(req.socket), "observe the request on TLS before parsing it");
      res.once("finish", () => {
        entry.finished = true;
      });
      res
        .writeHead(200, { "content-type": "application/json", connection: "close" })
        .end(JSON.stringify({ ...credentialFreeRepository, description: "omit-from-response" }));
    },
  );

  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuration.bindPort, configuration.bindHost, resolve);
  });
  return {
    observations,
    businessOrigin: new URL(configuration.origin).origin,
    get wireRequests() {
      return server.wireCount();
    },
  };
}
