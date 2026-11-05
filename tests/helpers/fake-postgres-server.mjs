import { createServer } from "node:net";

// A PostgreSQL server for the CI preparation and cleanup tests (ci-prepare*.test.mjs,
// ci-cleanup.test.mjs): scripts/ci/postgres-admin.mjs connects to a lane server's published
// port, and this listens on one in the test process. It speaks just enough of the frontend/
// backend protocol for node-postgres: startup, a cleartext password request, and simple
// queries, each answered with an empty CommandComplete. It records every session's user,
// password and database and each query it receives, in order.
//
// `onQuery(query, session)` decides an answer: undefined (success), `{ error: "message" }`
// (an ErrorResponse; the session stays usable, as on a real server), `{ hang: true }` (no
// answer until the client goes away), or a promise of one of these (a slow statement).
// The server must be running on the event loop: drive the code under test with an
// asynchronous child process, never spawnSync.
//
// With `socketPath`, it listens on that Unix socket instead and reports `port` as given.
export async function startFakePostgres({ port = 0, socketPath, onQuery = () => undefined } = {}) {
  const sessions = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    serveSession(socket, sessions, onQuery);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (socketPath) {
      server.listen(socketPath, resolve);
    } else {
      server.listen(port, "127.0.0.1", resolve);
    }
  });
  return {
    port: socketPath ? port : server.address().port,
    sessions,
    // Every query, as "<database>\t<query>", in arrival order.
    queries: () =>
      sessions.flatMap(({ database, queries }) => queries.map((query) => `${database}\t${query}`)),
    // One line per session: "<database>\t<query>\t<query>...", the shape the docker-exec
    // fakes logged for one psql command.
    sessionLines: () =>
      sessions
        .filter(({ queries }) => queries.length > 0)
        .map(({ database, queries }) => [database, ...queries].join("\t")),
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function message(type, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function int32(...values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeInt32BE(value, index * 4));
  return buffer;
}

const cstring = (value) => Buffer.from(`${value}\0`, "utf8");
const readyForQuery = () => message("Z", Buffer.from("I", "latin1"));

function errorResponse(text) {
  return message(
    "E",
    Buffer.concat([
      Buffer.from("S", "latin1"),
      cstring("ERROR"),
      Buffer.from("C", "latin1"),
      cstring("XX000"),
      Buffer.from("M", "latin1"),
      cstring(text),
      Buffer.from([0]),
    ]),
  );
}

function serveSession(socket, sessions, onQuery) {
  let buffer = Buffer.alloc(0);
  let session;
  let queue = Promise.resolve();
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!session) {
        if (buffer.length < 8) {
          return;
        }
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) {
          return;
        }
        const code = buffer.readInt32BE(4);
        const body = buffer.subarray(8, length);
        buffer = buffer.subarray(length);
        if (code === 80877103) {
          // SSLRequest: refused, the client continues in plain text.
          socket.write("N");
          continue;
        }
        const fields = body.toString("utf8").split("\0");
        const parameters = new Map();
        for (let index = 0; index + 1 < fields.length; index += 2) {
          if (fields[index]) {
            parameters.set(fields[index], fields[index + 1]);
          }
        }
        session = {
          user: parameters.get("user"),
          database: parameters.get("database") ?? parameters.get("user"),
          password: undefined,
          queries: [],
        };
        sessions.push(session);
        socket.write(message("R", int32(3)));
        continue;
      }
      if (buffer.length < 5) {
        return;
      }
      const type = String.fromCharCode(buffer[0]);
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) {
        return;
      }
      const body = buffer.subarray(5, length + 1);
      buffer = buffer.subarray(length + 1);
      if (type === "p") {
        session.password = body.toString("utf8").replace(/\0$/, "");
        socket.write(
          Buffer.concat([
            message("R", int32(0)),
            message("K", int32(process.pid, 1)),
            readyForQuery(),
          ]),
        );
      } else if (type === "Q") {
        const query = body.toString("utf8").replace(/\0$/, "");
        session.queries.push(query);
        queue = queue.then(async () => {
          const answer = await onQuery(query, session);
          if (answer?.hang || socket.destroyed) {
            return new Promise(() => {});
          }
          socket.write(
            Buffer.concat([
              answer?.error ? errorResponse(answer.error) : message("C", cstring("OK")),
              readyForQuery(),
            ]),
          );
        });
      } else if (type === "X") {
        socket.end();
        return;
      }
    }
  });
}
