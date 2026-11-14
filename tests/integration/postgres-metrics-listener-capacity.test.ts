import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { startMetricsListener } from "../../apps/controller/src/metrics/listener.ts";
import {
  createPostgresPool,
  PostgresMetricsSnapshot,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { databaseUrl } from "../helpers/postgres-database.mjs";

const migrationUrl = process.env.OCC_METRICS_TEST_MIGRATION_DATABASE_URL;

let requestsSent = 0;
function recordRequests(count: number): void {
  requestsSent += count;
  assert.ok(requestsSent <= 224, "fixed regression request budget");
}

const httpSockets = new Set<Socket>();
let peakSockets = 0;
function observeSocket(socket: Socket): void {
  httpSockets.add(socket);
  peakSockets = Math.max(peakSockets, httpSockets.size);
  assert.ok(peakSockets <= 4, "HTTP socket budget");
  socket.once("close", () => httpSockets.delete(socket));
}

type WireResponse = { status: number; headers: string; bodyBytes: number };
function parseResponse(bytes: Buffer): (WireResponse & { consumed: number }) | undefined {
  const headerEnd = bytes.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    return undefined;
  }
  const headers = bytes.subarray(0, headerEnd).toString("ascii");
  const status = Number(/^HTTP\/1\.[01] (\d{3}) /.exec(headers)?.[1]);
  assert.ok(status >= 100 && status <= 599, "valid HTTP status");
  const start = headerEnd + 4;
  if (status < 200) {
    return { status, headers, bodyBytes: 0, consumed: start };
  }
  const length = /^content-length:\s*(\d+)\s*$/im.exec(headers)?.[1];
  if (length !== undefined) {
    const bodyBytes = Number(length);
    return bytes.length < start + bodyBytes
      ? undefined
      : { status, headers, bodyBytes, consumed: start + bodyBytes };
  }
  if (/^transfer-encoding:\s*chunked\s*$/im.test(headers)) {
    let cursor = start;
    let bodyBytes = 0;
    for (;;) {
      const end = bytes.indexOf("\r\n", cursor);
      if (end < 0) {
        return undefined;
      }
      const sizeText = bytes.subarray(cursor, end).toString("ascii").split(";")[0]!;
      assert.match(sizeText, /^[0-9a-fA-F]+$/);
      const size = Number.parseInt(sizeText, 16);
      cursor = end + 2;
      if (size === 0) {
        if (bytes.length < cursor + 2) {
          return undefined;
        }
        assert.equal(bytes.subarray(cursor, cursor + 2).toString("ascii"), "\r\n");
        return { status, headers, bodyBytes, consumed: cursor + 2 };
      }
      if (bytes.length < cursor + size + 2) {
        return undefined;
      }
      assert.equal(bytes.subarray(cursor + size, cursor + size + 2).toString("ascii"), "\r\n");
      cursor += size + 2;
      bodyBytes += size;
    }
  }
  assert.fail("response has explicit HTTP framing");
}

async function until(check: () => boolean, message: string, milliseconds = 2500): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!check() && Date.now() < end) {
    await delay(5);
  }
  assert.ok(check(), message);
}

function openPipeline(url: string, requests: readonly string[], paused = false) {
  assert.ok(requests.length <= 32);
  const target = new URL(url);
  const socket = createConnection({ host: "127.0.0.1", port: Number(target.port) });
  observeSocket(socket);
  const responses: WireResponse[] = [];
  let bytes = Buffer.alloc(0);
  let failure: Error | undefined;
  const connected = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      if (paused) {
        socket.pause();
      }
      recordRequests(requests.length);
      socket.write(requests.join(""));
      resolve();
    });
    socket.once("error", reject);
  });
  socket.on("data", (chunk: Buffer) => {
    try {
      bytes = Buffer.concat([bytes, chunk]);
      for (;;) {
        const parsed = parseResponse(bytes);
        if (parsed === undefined) {
          break;
        }
        bytes = bytes.subarray(parsed.consumed);
        responses.push(parsed);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error("invalid response");
      socket.destroy();
    }
  });
  socket.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "ECONNRESET") {
      failure ??= error;
    }
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.setTimeout(4000, () => {
    failure ??= new Error("pipeline did not close");
    socket.destroy();
  });
  return {
    socket,
    responses,
    connected,
    closed,
    async finish() {
      socket.resume();
      await closed;
      if (failure) {
        throw failure;
      }
      assert.equal(bytes.length, 0, "every delivered response has complete framing");
      return responses;
    },
  };
}

const requestText = (method = "GET", path = "/metrics", close = false) =>
  method +
  " " +
  path +
  " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: " +
  (close ? "close" : "keep-alive") +
  "\r\n\r\n";

const missingHost = "GET /metrics HTTP/1.1\r\nConnection: keep-alive\r\n\r\n";
const expectRequest = (value: string, close = false) =>
  requestText("GET", "/metrics", close).replace(
    "\r\n\r\n",
    `\r\nExpect: ${value}\r\nContent-Length: 0\r\n\r\n`,
  );
const invalidHeaders = "GET /metrics HTTP/1.1\r\nHost: 127.0.0.1\r\nBad Header: value\r\n\r\n";
const connectRequest = "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
const upgradeRequest = (close = false) =>
  requestText("GET", "/metrics", close).replace(
    `Connection: ${close ? "close" : "keep-alive"}`,
    `Connection: Upgrade${close ? ", close" : ""}\r\nUpgrade: metrics-test`,
  );

function scrape(url: string): Promise<number> {
  recordRequests(1);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url + "/metrics",
      { agent: false, headers: { Connection: "close" } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
        response.once("error", reject);
      },
    );
    request.once("socket", observeSocket);
    request.once("error", reject);
    request.setTimeout(4000, () => request.destroy(new Error("scrape timed out")));
    request.end();
  });
}

test(
  "metrics listener bounds PostgreSQL scrape waiters and pipelined responses",
  {
    skip:
      databaseUrl && migrationUrl
        ? false
        : "Set OCC_TEST_DATABASE_URL and OCC_METRICS_TEST_MIGRATION_DATABASE_URL to the same migrated disposable PostgreSQL database (docs/testing/postgresql.md).",
    timeout: 30_000,
  },
  async (context) => {
    assert.ok(databaseUrl);
    assert.ok(migrationUrl, "the prepared CI fixture supplies its migrator URL");
    const appUrl = new URL(databaseUrl);
    const migrator = new URL(migrationUrl);
    assert.equal(appUrl.hostname, "127.0.0.1");
    assert.equal(migrator.host, appUrl.host);
    assert.equal(migrator.pathname, appUrl.pathname);
    const owner = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const locks = new pg.Pool({ connectionString: migrationUrl, max: 1 });
    const pool = await createPostgresPool(databaseUrl, {
      authMode: "password",
      max: 1,
      connectionTimeoutMillis: 500,
      statement_timeout: 1500,
      query_timeout: 1500,
      options: "-c default_transaction_read_only=on",
    });
    let databaseClients = 0;
    let peakDatabaseClients = 0;
    let maxHeldLockMs = 0;
    for (const selected of [owner, locks, pool]) {
      selected.on("connect", (client: pg.PoolClient) => {
        databaseClients++;
        peakDatabaseClients = Math.max(peakDatabaseClients, databaseClients);
        assert.ok(peakDatabaseClients <= 4, "database client budget");
        client.once("end", () => {
          databaseClients--;
        });
      });
    }
    let poolsClosed: Promise<void[]> | undefined;
    const closePools = () => (poolsClosed ??= Promise.all([pool.end(), locks.end(), owner.end()]));
    context.after(async () => {
      await closePools();
    });
    const state = new PostgresPlatformState(owner);
    await state.transact(async (transaction) => {
      if (await transaction.installations.getInstallation()) {
        return;
      }
      await transaction.installations.createInstallation({
        id: `ins_${randomUUID()}`,
        name: "Metrics capacity test",
        createdAt: new Date().toISOString(),
      });
    });
    const snapshot = new PostgresMetricsSnapshot(pool);
    let snapshots = 0;
    let admitted = 0;
    let pending = 0;
    let peak = 0;
    const actual = createOccMetrics("worker", () => {
      snapshots++;
      return snapshot.collect();
    });
    const observed = {
      ...actual,
      exposition() {
        admitted++;
        pending++;
        peak = Math.max(peak, pending);
        return actual.exposition().finally(() => {
          pending--;
        });
      },
    };
    const listener = await startMetricsListener(observed, { host: "127.0.0.1", port: 0 });
    const port = Number(new URL(listener.url).port);
    const active = new Set<Socket>();
    const responses: ServerResponse[] = [];
    const observe = (message: unknown) => {
      const value = message as { request: IncomingMessage; response: ServerResponse };
      if (value.request.socket.localPort === port) {
        responses.push(value.response);
      }
    };
    const requests = channel("http.server.request.start");
    requests.subscribe(observe);
    const pipeline = (messages: readonly string[], paused = false) => {
      const wire = openPipeline(listener.url, messages, paused);
      active.add(wire.socket);
      wire.socket.once("close", () => active.delete(wire.socket));
      return wire;
    };
    const withLock = async (work: (pid: number) => Promise<void>) => {
      const locker = await locks.connect();
      let heldAt: number | undefined;
      let timer: NodeJS.Timeout | undefined;
      let rollback: Promise<pg.QueryResult> | undefined;
      const release = () => (rollback ??= locker.query("ROLLBACK"));
      try {
        await locker.query("SET idle_in_transaction_session_timeout = '2500ms'");
        await locker.query("SET transaction_timeout = '2800ms'");
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE occ.agents IN ACCESS EXCLUSIVE MODE");
        heldAt = Date.now();
        timer = setTimeout(() => {
          void release().catch(() => {});
        }, 2200);
        const pid = Number((await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await work(pid);
      } finally {
        clearTimeout(timer);
        try {
          await release();
        } finally {
          locker.release();
          if (heldAt !== undefined) {
            maxHeldLockMs = Math.max(maxHeldLockMs, Date.now() - heldAt);
            assert.ok(maxHeldLockMs < 3000, "owned table lock stays within three seconds");
          }
        }
      }
    };
    const checkImplicitPipeline = async (kind: "missing-host" | "unsupported-expect") => {
      await withLock(async (pid) => {
        const before = responses.length;
        const beforeAdmitted = admitted;
        const beforeSnapshots = snapshots;
        const malformed = kind === "missing-host" ? missingHost : expectRequest("unsupported");
        const wire = pipeline(
          [requestText(), ...Array.from({ length: 24 }, () => malformed)],
          true,
        );
        await wire.connected;
        await until(
          () =>
            responses.length - before >= 25 ||
            responses.slice(before).some((response) => response.req.socket.destroyed),
          "implicit response pipeline is parsed or terminated",
        );
        const wait = await owner.query<{ wait_event_type: string }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        assert.equal(
          wait.rows[0]?.wait_event_type,
          "Lock",
          "real PostgreSQL collection is pending",
        );
        const queued = responses.slice(before).filter((response) => response.headersSent);
        const statuses = queued.map((response) => response.statusCode);
        context.diagnostic(
          JSON.stringify({
            scenario: kind,
            parsed: responses.length - before,
            queued: queued.length,
            statuses,
            admitted: admitted - beforeAdmitted,
            snapshots: snapshots - beforeSnapshots,
          }),
        );
        assert.equal(admitted - beforeAdmitted, 1, "implicit refusals do not collect metrics");
        assert.equal(snapshots - beforeSnapshots, 1, "the genuine collector remains single-flight");
        assert.ok(queued.length <= 17, "implicit final responses share the per-socket bound");
        if (kind === "missing-host") {
          assert.deepEqual(statuses, [400], "missing Host closes with one admitted 400");
          assert.equal(queued[0]?.getHeader("Connection"), "close");
        } else {
          assert.deepEqual(
            statuses,
            [...Array.from({ length: 15 }, () => 417), 503],
            "unsupported expectations use the remaining slots and one closing refusal",
          );
          assert.equal(queued.at(-1)?.getHeader("Connection"), "close");
        }
        const closing = Date.now();
        await wire.finish();
        assert.ok(Date.now() - closing < 1500, "implicit overflow terminates promptly");
        assert.ok(wire.responses.length <= 17);
        await until(() => pending === 0, "implicit-pipeline collection settles");
      });
      assert.equal(
        await scrape(listener.url),
        200,
        "a fresh scrape recovers after implicit refusal",
      );
    };
    const checkProtocolTeardown = async (kind: "connect" | "upgrade") => {
      const scenarioStart = requestsSent;
      await withLock(async (pid) => {
        const beforeAdmitted = admitted;
        const beforeSnapshots = snapshots;
        const wire = pipeline(Array.from({ length: 4 }, () => requestText()));
        await wire.connected;
        await until(() => pending === 4, "four admitted scrapes are pending");
        const wait = await owner.query<{ wait_event_type: string }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        assert.equal(wait.rows[0]?.wait_event_type, "Lock", "the real collection is blocked");
        recordRequests(1);
        wire.socket.write(kind === "connect" ? connectRequest : upgradeRequest());
        if (kind === "upgrade") {
          // With no upgrade listener, Node keeps this request on the HTTP path.
          await until(() => pending === 5, "unsupported upgrade remains an ordinary scrape");
          wire.socket.destroy();
        }
        await wire.finish();
        assert.deepEqual(wire.responses, [], "teardown does not emit a partial response");
        assert.equal(admitted - beforeAdmitted, kind === "connect" ? 4 : 5);
        assert.equal(snapshots - beforeSnapshots, 1, "the actual collector stays single-flight");
        assert.equal(
          pending,
          kind === "connect" ? 4 : 5,
          "socket closure does not settle collection",
        );
        await until(() => pending === 0, "the real collection settles after socket closure");
      });
      await withLock(async (pid) => {
        const beforeAdmitted = admitted;
        const beforeSnapshots = snapshots;
        const beforeResponses = responses.length;
        const batch = () =>
          pipeline(Array.from({ length: 8 }, (_, i) => requestText("GET", "/metrics", i === 7)));
        const a = batch();
        const b = batch();
        await Promise.all([a.connected, b.connected]);
        await until(
          () =>
            admitted - beforeAdmitted === 16 ||
            responses.slice(beforeResponses).some((response) => response.headersSent),
          "concurrent recovery reaches admission or a refusal",
        );
        const wait = await owner.query<{ wait_event_type: string }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        context.diagnostic(
          JSON.stringify({
            scenario: `${kind}-recovery`,
            admitted: admitted - beforeAdmitted,
            pending,
            snapshots: snapshots - beforeSnapshots,
            waitEventType: wait.rows[0]?.wait_event_type,
          }),
        );
        assert.equal(wait.rows[0]?.wait_event_type, "Lock", "recovery uses blocked PostgreSQL");
        assert.equal(
          admitted - beforeAdmitted,
          16,
          "socket teardown restores all sixteen scrape slots",
        );
        assert.equal(snapshots - beforeSnapshots, 1, "concurrent recovery remains single-flight");
        assert.equal(await scrape(listener.url), 503, "the full recovered budget refuses overflow");
        for (const wire of [a, b]) {
          assert.deepEqual(
            (await wire.finish()).map(({ status }) => status),
            Array.from({ length: 8 }, () => 503),
            "recovered requests retain ordered and complete response framing",
          );
        }
        assert.equal(pending, 0, "the recovery collection has settled");
      });
      assert.equal(await scrape(listener.url), 200, "settled recovery permits a successful scrape");
      assert.ok(requestsSent - scenarioStart <= 32, "protocol teardown scenario request budget");
    };
    try {
      assert.equal(await scrape(listener.url), 200);
      await withLock(async (pid) => {
        const before = admitted;
        const beforeSnapshots = snapshots;
        const wire = pipeline(
          Array.from({ length: 24 }, (_, i) => requestText("GET", "/metrics", i === 23)),
          true,
        );
        await wire.connected;
        await until(() => pending >= 16, "pipeline reaches the admitted waiters");
        const wait = await owner.query<{ wait_event_type: string }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        assert.equal(
          wait.rows[0]?.wait_event_type,
          "Lock",
          "the genuine collector waits on PostgreSQL",
        );
        context.diagnostic(
          JSON.stringify({
            scenario: "fixed24",
            admitted: admitted - before,
            pending,
            snapshots: snapshots - beforeSnapshots,
          }),
        );
        assert.equal(
          admitted - before,
          16,
          "one socket admits at most sixteen real exposition waiters",
        );
        assert.equal(snapshots - beforeSnapshots, 1, "the actual collector remains single-flight");
        await wire.finish();
        assert.ok(wire.responses.length <= 17, "overflow cannot enqueue one refusal per request");
        await until(() => pending === 0, "database deadline settles abandoned collections");
      });
      assert.equal(await scrape(listener.url), 200, "a fresh scrape recovers");

      await withLock(async () => {
        const wire = pipeline(
          Array.from({ length: 4 }, (_, i) => requestText("GET", "/metrics", i === 3)),
        );
        await wire.connected;
        assert.deepEqual(
          (await wire.finish()).map(({ status }) => status),
          [503, 503, 503, 503],
          "ordinary admitted requests retain ordered and complete 503 framing",
        );
      });

      await withLock(async () => {
        const before = admitted;
        const a = pipeline(Array.from({ length: 8 }, () => requestText()));
        const b = pipeline(Array.from({ length: 8 }, () => requestText()));
        await Promise.all([a.connected, b.connected]);
        await until(() => pending === 16, "two sockets fill the listener-wide budget");
        assert.equal(await scrape(listener.url), 503, "overflow on another socket is refused");
        a.socket.destroy();
        b.socket.destroy();
        await Promise.all([a.closed, b.closed]);
        assert.equal(
          await scrape(listener.url),
          503,
          "disconnect cannot release unsettled collection slots",
        );
        assert.equal(
          admitted - before,
          16,
          "refused and disconnected requests create no replacement collection",
        );
        await until(() => pending === 0, "aborted collection eventually settles");
      });
      assert.equal(await scrape(listener.url), 200, "settlement releases the admission slots");

      await withLock(async () => {
        const before = responses.length;
        const wire = pipeline(
          [
            requestText(),
            ...Array.from({ length: 16 }, (_, i) =>
              requestText(i % 2 ? "POST" : "GET", i % 2 ? "/metrics" : "/missing"),
            ),
          ],
          true,
        );
        await wire.connected;
        await until(
          () =>
            responses
              .slice(before)
              .some((response) => response.statusCode === 503 && response.headersSent),
          "mixed pipelining reaches the one closing refusal",
        );
        const queued = responses.slice(before).filter((response) => response.headersSent);
        assert.ok(queued.length <= 17, "all route responses share the per-socket bound");
        assert.equal(queued.filter((response) => response.statusCode === 503).length, 1);
        assert.equal(
          queued.find((response) => response.statusCode === 503)?.getHeader("Connection"),
          "close",
        );
        recordRequests(15);
        wire.socket.write(
          Array.from({ length: 15 }, () => requestText("POST", "/missing")).join(""),
        );
        await wire.finish();
        assert.ok(
          responses.slice(before).filter((response) => response.headersSent).length <= 17,
          "additional requests cannot accumulate queued refusal responses",
        );
        await until(() => pending === 0, "slow-reader collection settles");
      });
      assert.equal(await scrape(listener.url), 200);
      await checkImplicitPipeline("missing-host");
      await checkImplicitPipeline("unsupported-expect");
      await checkProtocolTeardown("connect");
      await checkProtocolTeardown("upgrade");

      for (const [message, expected] of [
        [missingHost, [400]],
        [expectRequest("unsupported", true), [417]],
        [expectRequest("100-continue", true), [100, 200]],
        [expectRequest("100-continue", true).replace("Host: 127.0.0.1\r\n", ""), [400]],
        [invalidHeaders, [400]],
        [upgradeRequest(true), [200]],
      ] as const) {
        const wire = pipeline([message]);
        await wire.connected;
        assert.deepEqual(
          (await wire.finish()).map(({ status }) => status),
          expected,
        );
      }

      await withLock(async () => {
        const before = responses.length;
        const beforeAdmitted = admitted;
        const wire = pipeline([
          requestText(),
          ...Array.from({ length: 15 }, () => expectRequest("unsupported")),
          invalidHeaders,
        ]);
        await wire.connected;
        await wire.finish();
        assert.equal(admitted - beforeAdmitted, 1);
        assert.deepEqual(
          responses
            .slice(before)
            .filter((response) => response.headersSent)
            .map((response) => response.statusCode),
          Array.from({ length: 15 }, () => 417),
          "a parser error cannot insert raw response bytes before pending responses",
        );
        assert.deepEqual(wire.responses, []);
        await until(() => pending === 0, "parser-error collection settles");
      });
      assert.equal(await scrape(listener.url), 200, "parser termination releases settled capacity");
      assert.ok(peak <= 16);
      const closing = Date.now();
      await listener.close();
      assert.ok(Date.now() - closing < 1000, "listener closes promptly");
      context.diagnostic(
        JSON.stringify({
          scenario: "terminal",
          peak,
          pending,
          admitted,
          snapshots,
          cleanup: "listener-closed",
        }),
      );
    } finally {
      for (const socket of active) {
        socket.destroy();
      }
      requests.unsubscribe(observe);
      context.diagnostic(
        JSON.stringify({
          scenario: "request-accounting",
          requestsSent,
          peakSockets,
          peakDatabaseClients,
          maxHeldLockMs,
        }),
      );
      await listener.close();
      await closePools();
    }
  },
);
