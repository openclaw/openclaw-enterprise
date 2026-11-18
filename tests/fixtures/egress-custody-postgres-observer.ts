import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, rmdir } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";

import { validateConnectedDatabaseUrl } from "../helpers/egress-connected-inputs.mjs";
import { commitAckProxy } from "./postgres-commit-ack-proxy.mjs";

// Run before installing the disposable controller. Publish only the data-plane
// loopback port to its disposable network, never this owner's local control socket.
const [directory, rawPort] = process.argv.slice(2);
const database = validateConnectedDatabaseUrl(process.env.OCC_TEST_DATABASE_URL);
const port = Number(rawPort);
assert.ok(
  directory && isAbsolute(directory) && Number.isInteger(port) && port > 1024 && port < 65536,
);
// A fresh directory gives this process exclusive ownership of its socket path.
await mkdir(directory, { mode: 0o700 });
const path = join(directory, "control.sock");
const proxy = await commitAckProxy(database, { port, egressDispatch: true }).catch(
  async (error: unknown) => {
    await rmdir(directory);
    throw error;
  },
);
const server = createServer({ allowHalfOpen: true }, (socket) => {
  let request = "";
  // The control protocol is ASCII. Latin-1 preserves one character per byte.
  socket.setEncoding("latin1");
  socket.setTimeout(3000, () => socket.destroy());
  socket.on("error", () => {});
  socket.on("data", (data) => {
    request += data;
    if (request.length > 256) {
      socket.destroy();
    }
  });
  socket.on("end", () => {
    try {
      if (request !== "status") {
        const selection = /^drop (.*)$/.exec(request);
        assert.ok(selection);
        proxy.arm({ instanceId: selection[1] });
      }
      socket.end(JSON.stringify(proxy.egress));
    } catch {
      socket.end('{"error":"invalid or consumed observer operation"}');
    }
  });
});
try {
  server.listen(path);
  await once(server, "listening");
  await chmod(path, 0o600);
  console.log("Disposable exact dispatch COMMIT observer ready on loopback port", port);
} catch (error) {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((closeError) => (closeError ? reject(closeError) : resolve()));
    });
  }
  await proxy.close();
  await rmdir(directory);
  throw error;
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    server.close();
    await proxy.close();
  });
}
