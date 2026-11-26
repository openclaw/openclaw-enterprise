import { createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";
import { listen } from "./listen.ts";

// A PostgreSQL server for the CI preparation and cleanup tests (ci-prepare test suites,
// ci-cleanup-postgres-cases.ts): scripts/ci/postgres-admin.ts connects to a lane server's
// published port, and this listens on one in the test process. It speaks just enough of the frontend/
// backend protocol for node-postgres: startup, a cleartext password request, and simple
// queries, each answered with an empty CommandComplete. It records every session's user,
// password and database and each query it receives, in order.
//
// `onQuery(query, session)` decides an answer: undefined (success), `{ error: "message" }`
// (an ErrorResponse; the session stays usable, as on a real server), `{ hang: true }` (no
// answer until the client goes away), `{ rows: [{ column: "text" }] }` (text results),
// or a promise of one of these (a slow statement).
// The server must be running on the event loop: drive the code under test with an
// asynchronous child process, never spawnSync.
//
// With `socketPath`, it listens on that Unix socket instead and reports `port` as given.
type FakePostgresSession = {
  user: string | undefined;
  database: string | undefined;
  password: string | undefined;
  queries: string[];
};

type FakePostgresAnswer = {
  error?: string;
  hang?: boolean;
  rows?: Record<string, string>[];
};

export type FakePostgresQuery = (
  query: string,
  session: FakePostgresSession,
) => FakePostgresAnswer | void | Promise<FakePostgresAnswer | void>;

type FakePostgresOptions = {
  port?: number;
  socketPath?: string;
  onQuery?: FakePostgresQuery;
};

export async function startFakePostgres({
  port = 0,
  socketPath,
  onQuery = () => undefined,
}: FakePostgresOptions = {}) {
  const sessions: FakePostgresSession[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    serveSession(socket, sessions, onQuery);
  });
  await new Promise<void>((resolve, reject) => {
    const listening = () => {
      server.off("error", reject);
      resolve();
    };
    server.once("error", reject);
    if (socketPath) {
      server.listen(socketPath, listening);
    } else {
      server.listen(port, "127.0.0.1", listening);
    }
  });
  const address = server.address();
  if (!socketPath && (address === null || typeof address === "string")) {
    server.close();
    throw new Error("PostgreSQL fixture did not bind a TCP port");
  }
  return {
    port: typeof address === "object" && address !== null ? address.port : port,
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Keep the port owned while pg connects. Closing an accepted socket before startup
// makes connect() fail without exposing the port to another PostgreSQL fixture.
export async function rejectPostgresStartup(t: Pick<TestContext, "after">, port = 0) {
  const connections: Promise<void>[] = [];
  const server = createServer((socket) => {
    connections.push(new Promise<void>((resolve) => socket.once("close", () => resolve())));
    socket.destroy();
  });
  return { port: await listen(t, server, "127.0.0.1", { port }), connections };
}

function message(type: string, body: Buffer = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function int32(...values: number[]) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeInt32BE(value, index * 4));
  return buffer;
}

const cstring = (value: string) => Buffer.from(`${value}\0`, "utf8");
const readyForQuery = () => message("Z", Buffer.from("I", "latin1"));

function textRows(rows: Record<string, string>[]) {
  const columns = Object.keys(rows[0] ?? {});
  const count = (value: number) => {
    const bytes = Buffer.alloc(2);
    bytes.writeInt16BE(value);
    return bytes;
  };
  return [
    message(
      "T",
      Buffer.concat([
        count(columns.length),
        ...columns.map((column) =>
          Buffer.concat([
            cstring(column),
            int32(0),
            count(0),
            int32(25),
            count(-1),
            int32(-1),
            count(0),
          ]),
        ),
      ]),
    ),
    ...rows.map((row) =>
      message(
        "D",
        Buffer.concat([
          count(columns.length),
          ...columns.map((column) => {
            const text = row[column];
            if (typeof text !== "string") {
              throw new Error(`PostgreSQL fixture row is missing text column ${column}`);
            }
            const value = Buffer.from(text, "utf8");
            return Buffer.concat([int32(value.length), value]);
          }),
        ]),
      ),
    ),
  ];
}

function errorResponse(text: string) {
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

function serveSession(socket: Socket, sessions: FakePostgresSession[], onQuery: FakePostgresQuery) {
  let buffer: Buffer = Buffer.alloc(0);
  let session: FakePostgresSession | undefined;
  let queue = Promise.resolve();
  socket.on("data", (chunk) => {
    if (!Buffer.isBuffer(chunk)) {
      socket.destroy();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!session) {
        if (buffer.length < 8) {
          return;
        }
        const length = buffer.readInt32BE(0);
        if (length < 8) {
          socket.destroy();
          return;
        }
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
        const parameters = new Map<string, string>();
        for (let index = 0; index + 1 < fields.length; index += 2) {
          const key = fields[index];
          const value = fields[index + 1];
          if (key && value !== undefined) {
            parameters.set(key, value);
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
      const type = buffer.toString("latin1", 0, 1);
      const length = buffer.readInt32BE(1);
      if (length < 4) {
        socket.destroy();
        return;
      }
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
        const activeSession = session;
        queue = queue.then(async () => {
          const answer = await onQuery(query, activeSession);
          if (answer?.hang || socket.destroyed) {
            return new Promise<void>(() => {});
          }
          socket.write(
            Buffer.concat([
              ...(answer?.rows ? textRows(answer.rows) : []),
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
