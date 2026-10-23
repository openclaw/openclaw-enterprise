import assert from "node:assert/strict";
import { mkdir, chmod } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { commitAckProxy } from "./postgres-commit-ack-proxy.mjs";
import { validateConnectedDatabaseUrl } from "../helpers/egress-connected-inputs.mjs";

// Run before installing the disposable controller. Publish only the data-plane
// loopback port to its disposable network, never this owner's local control socket.
const [directory, rawPort] = process.argv.slice(2);
const database = validateConnectedDatabaseUrl(process.env.OCC_TEST_DATABASE_URL);
const port = Number(rawPort);
assert.ok(isAbsolute(directory) && port > 1024 && port < 65536 && Number.isInteger(port));
await mkdir(directory, { mode: 0o700 }); // exclusive, not a reused/foreign endpoint
const path = join(directory, "control.sock");
const proxy = await commitAckProxy(database, { port, egressDispatch: true });
const server = createServer({ allowHalfOpen: true }, (socket) => {
  let request = "";
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
        const [, instanceId] = /^drop ([a-f0-9-]{36})$/.exec(request);
        proxy.arm({ instanceId });
      }
      socket.end(JSON.stringify(proxy.egress));
    } catch {
      socket.end('{"error":"invalid or consumed observer operation"}');
    }
  });
}).listen(path, async () => {
  await chmod(path, 0o600);
  console.log("Disposable exact dispatch COMMIT observer ready on loopback port", port);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    server.close();
    await proxy.close();
  });
}
