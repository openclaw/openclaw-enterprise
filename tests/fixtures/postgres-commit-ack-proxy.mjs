import net from "node:net";
import { once } from "node:events";
import pg from "pg";

// Real PostgreSQL transport faults: drop the server's COMMIT completion, or
// pause the client's COMMIT request before forwarding it to the server.
export async function commitAckProxy(databaseUrl, { port = 0, egressDispatch = false } = {}) {
  const target = new URL(databaseUrl);
  // Resolve query-string and environment precedence with the same installed
  // driver as the caller. URL authority alone is not the effective destination.
  const effective = new pg.Client({ connectionString: databaseUrl });
  const upstreamHost = effective.host.replace(/^\[|\]$/g, "");
  const upstreamPort = effective.port;
  if (!["127.0.0.1", "localhost", "::1"].includes(upstreamHost)) {
    throw new Error("The commit fault requires a disposable loopback PostgreSQL database.");
  }
  // This fixture inspects PostgreSQL frames, so it cannot observe encrypted
  // COMMIT completion. Reject TLS intent rather than silently downgrading it.
  if (effective.ssl) {
    throw new Error("The commit fault requires an explicitly non-TLS PostgreSQL connection.");
  }
  let armed = false;
  let skipCommits = 0;
  let observed = false;
  let commits = 0;
  let pauseCommit = false;
  let heldCommit;
  const sockets = new Set();
  let expectedInstance;
  let dropped;
  let authorizations = 0;
  const dispatch = (params) => {
    const [instanceId, useId, attemptId] = params;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(useId) ||
      attemptId !== useId ||
      (expectedInstance && instanceId !== expectedInstance)
    ) {
      return;
    }
    return { instanceId, useId, attemptId };
  };
  const server = net.createServer((client) => {
    client.setNoDelay(true);
    const upstream = net.connect({
      host: upstreamHost,
      port: upstreamPort,
    });
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    let frontend = Buffer.alloc(0);
    let backend = Buffer.alloc(0);
    let startup = true;
    let dropping = false;
    let parsedDispatch = false;
    let selected;
    let updated;
    const close = () => {
      if (heldCommit?.upstream === upstream) {
        heldCommit = undefined;
      }
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    client.on("data", (chunk) => {
      frontend = Buffer.concat([frontend, chunk]);
      while (frontend.length >= (startup ? 4 : 5)) {
        const size = frontend.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (size < 4 || size > 16 * 1024 * 1024) {
          return close();
        }
        if (frontend.length < size) {
          return;
        }
        const frame = frontend.subarray(0, size);
        frontend = frontend.subarray(size);
        if (!startup && egressDispatch && frame[0] === 80) {
          // Parse. Match only the OCC authorization update, never a reservation or
          // an unrelated COMMIT. The product uses pg's unnamed extended query.
          const sql = frame.toString("utf8", 6, frame.indexOf(0, 6));
          parsedDispatch =
            frame[5] === 0 &&
            /^UPDATE occ[.]egress_send_receipts SET authorized_dispatch=\$6 WHERE /i.test(sql) &&
            sql.endsWith(
              " AND authorized_dispatch IS NULL AND NOT settled AND observation IS NULL RETURNING sender_id",
            );
        }
        if (!startup && parsedDispatch && frame[0] === 66) {
          // Bind. Inspect only the three nonsecret identity parameters, never $6.
          let offset = frame.indexOf(0, frame.indexOf(0, 5) + 1) + 1;
          offset += 2 + frame.readUInt16BE(offset) * 2;
          if (frame.readUInt16BE(offset) === 6) {
            offset += 2;
            const params = [];
            for (let n = 0; n < 5; ++n) {
              const size = frame.readInt32BE(offset);
              offset += 4;
              if (size < 0 || size > frame.length - offset) {
                return close();
              }
              if (n >= 2) {
                params.push(frame.toString("utf8", offset, offset + size));
              }
              offset += size;
            }
            selected = dispatch(params);
          }
          parsedDispatch = false;
        }
        if (
          !startup &&
          frame[0] === 81 &&
          frame.subarray(5, -1).toString().trim().toUpperCase() === "COMMIT" &&
          armed &&
          (!egressDispatch || updated)
        ) {
          if (skipCommits > 0) {
            skipCommits -= 1;
          } else {
            armed = false;
            if (pauseCommit) {
              // Delay the real request before PostgreSQL receives COMMIT; its
              // deferred constraints must decide whether the transaction can commit.
              observed = true;
              heldCommit = { upstream, frame };
              continue;
            }
            dropping = true;
          }
        }
        startup = false;
        upstream.write(frame);
      }
    });
    upstream.on("data", (chunk) => {
      backend = Buffer.concat([backend, chunk]);
      while (backend.length >= 5) {
        const size = backend.readInt32BE(1) + 1;
        if (size < 5 || size > 16 * 1024 * 1024) {
          return close();
        }
        if (backend.length < size) {
          return;
        }
        const frame = backend.subarray(0, size);
        backend = backend.subarray(size);
        if (
          frame[0] === 67 &&
          selected &&
          frame.toString("utf8", 5, frame.length - 1) === "UPDATE 1"
        ) {
          updated = selected;
          selected = undefined;
          authorizations++;
        }
        if (frame[0] === 67 && frame.subarray(5, -1).toString() === "COMMIT") {
          commits++;
          if (dropping) {
            dropped = updated;
          }
          updated = undefined;
        }
        if (
          egressDispatch &&
          (frame[0] === 69 || (frame[0] === 90 && frame[5] === 73 && !dropping))
        ) {
          // A failed/rolled-back transaction cannot arm an unrelated transaction.
          updated = selected = undefined;
        }
        if (dropping && frame[0] === 67 && frame.subarray(5, -1).toString() === "COMMIT") {
          observed = true;
          return close();
        }
        if (!dropping) {
          client.write(frame);
        }
      }
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const proxyUrl = new URL(target);
  proxyUrl.hostname = "127.0.0.1";
  proxyUrl.port = String(server.address().port);
  proxyUrl.searchParams.delete("host");
  proxyUrl.searchParams.delete("port");
  return {
    url: proxyUrl.toString(),
    arm(options = {}) {
      const skip = options.skipCommits ?? 0;
      if (!Number.isSafeInteger(skip) || skip < 0) {
        throw new Error("Skipped COMMIT count must be a nonnegative integer.");
      }
      if (armed || observed) {
        throw new Error("The single-use fault is already armed or consumed.");
      }
      if (egressDispatch) {
        if (!/^[a-f0-9-]{36}$/.test(options.instanceId)) {
          throw new Error("Expected supervisor instance UUID.");
        }
        expectedInstance = options.instanceId;
      }
      skipCommits = skip;
      pauseCommit = options.pauseCommit === true;
      armed = true;
    },
    get egress() {
      return { authorizations, dropped, observed, armed };
    },
    get commits() {
      return commits;
    },
    get observedCommit() {
      return observed;
    },
    get commitPaused() {
      return heldCommit !== undefined;
    },
    resumeCommit() {
      if (heldCommit === undefined) {
        throw new Error("No COMMIT request is paused.");
      }
      const held = heldCommit;
      heldCommit = undefined;
      held.upstream.write(held.frame);
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
