import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:https";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfSigned } from "../helpers/certificates.ts";
import { browserRevisionTls } from "../../apps/controller/src/gateway/browser-revision-tls.ts";

test("a replacement revision on the same port receives no stale browser request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "revision-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await selfSigned(directory, { name: "original" });
  const replacement = await selfSigned(directory, { name: "replacement" });
  let seen = 0;
  const server = createServer(original, (req, res) => {
    assert.equal(req.headers["x-test-identity"], "test");
    seen++;
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const request = (cert: string) =>
    new Promise<void>((resolve, reject) => {
      get(
        {
          host: "127.0.0.1",
          port,
          ...browserRevisionTls(cert),
          headers: { "x-test-identity": "test" },
        },
        (res) => {
          res.on("end", resolve);
          res.resume();
        },
      ).on("error", reject);
    });
  await request(original.cert);
  server.setSecureContext(replacement);
  await assert.rejects(request(original.cert));
  assert.equal(seen, 1);
  await request(replacement.cert);
  assert.equal(seen, 2);
});
