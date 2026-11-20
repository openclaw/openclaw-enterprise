import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const destinationFile = "/etc/openclaw-runtime-audit/destination.json";
const queueDirectory = "/home/node/.openclaw/pending-runtime-audit";
const capacity = 256;
const maxEventBytes = 4096;

function encodeEvent(event) {
  return JSON.stringify({
    ...event,
    eventId: event.eventId ?? randomUUID(),
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  });
}

function post(url, headers, ca, body, signal) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", ca, headers, signal }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end(body);
  });
}

function openQueue(scope, directory) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) !== 0) {
    throw new Error("Invalid runtime audit queue directory.");
  }
  const path = join(directory, "observations.sqlite");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.uid !== dir.uid)) {
    throw new Error("Invalid runtime audit queue file.");
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA busy_timeout = 500;
      PRAGMA max_page_count = 1024;
      CREATE TABLE IF NOT EXISTS observations (
        scope TEXT NOT NULL, body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 4096)
      ) STRICT;
    `);
    db.prepare("DELETE FROM observations WHERE scope <> ?").run(scope);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function hasAuditDestination() {
  return existsSync(destinationFile);
}

export function readAuditDestination() {
  return hasAuditDestination() ? JSON.parse(readFileSync(destinationFile, "utf8")) : undefined;
}

export function createAuditSink() {
  const destination = readAuditDestination();
  if (destination === undefined) {
    return undefined;
  }
  const ca = readFileSync("/etc/openclaw-runtime-audit/ca.pem");
  const token = readFileSync("/var/run/openclaw-runtime-audit/token", "utf8").trim();
  return createAuditDelivery(destination, ca, token, queueDirectory);
}

export function createAuditDelivery(destination, ca, token, directory) {
  const url = new URL(destination.url);
  const source = destination.source;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/internal/runtime-audit" ||
    (source !== "openclaw" && source !== "codex")
  ) {
    throw new Error("Invalid runtime audit destination.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Invalid runtime audit credential.");
  }
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "X-OpenClaw-Runtime-Audit-Source": source,
  };
  const scope = createHash("sha256")
    .update(JSON.stringify([source, url.href, token]))
    .digest("hex");
  const db = openQueue(scope, directory);
  const enqueue = db.prepare(`
    INSERT INTO observations(scope, body)
    SELECT ?, ? WHERE (SELECT count(*) FROM observations) < ?
  `);
  const next = db.prepare(
    "SELECT rowid, body FROM observations WHERE scope = ? ORDER BY rowid LIMIT 1",
  );
  const remove = db.prepare("DELETE FROM observations WHERE scope = ? AND rowid = ? AND body = ?");
  let sending = false;
  let closed = false;
  let retryTimer;
  const shutdown = new AbortController();

  async function drain() {
    if (sending || closed || retryTimer) {
      return;
    }
    sending = true;
    try {
      for (let row = next.get(scope); row; row = next.get(scope)) {
        const status = await post(
          url,
          headers,
          ca,
          row.body,
          AbortSignal.any([shutdown.signal, AbortSignal.timeout(2000)]),
        );
        if (closed) {
          return;
        }
        if (status < 200 || status >= 300) {
          if (status === 408 || status === 429 || status >= 500) {
            throw new Error("Temporary audit service failure.");
          }
          process.emitWarning(
            "The control plane rejected a runtime audit event (HTTP " + status + ").",
          );
        }
        remove.run(scope, row.rowid, row.body);
      }
    } catch {
      if (!closed) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void drain();
        }, 15_000);
        retryTimer.unref();
      }
    } finally {
      sending = false;
    }
  }

  void drain();
  return {
    source,
    emit(event) {
      if (closed) {
        return;
      }
      const body = encodeEvent(event);
      try {
        if (
          Buffer.byteLength(body) <= maxEventBytes &&
          enqueue.run(scope, body, capacity).changes === 1
        ) {
          void drain();
          return;
        }
      } catch {
        // A storage error must not interrupt the turn that produced the observation.
      }
      process.emitWarning("The Gateway could not queue a runtime audit event.");
    },
    async requireRecord(event, signal) {
      // An admission belongs to this waiting operation. Replaying it from the
      // observation queue cannot release work after the original caller ends.
      if (closed) {
        throw new Error("Runtime audit delivery is closed.");
      }
      const body = encodeEvent(event);
      if (Buffer.byteLength(body) > maxEventBytes) {
        throw new Error("Runtime audit event is too large.");
      }
      const signals = [shutdown.signal, AbortSignal.timeout(2000)];
      if (signal) {
        signals.push(signal);
      }
      const delivery = AbortSignal.any(signals);
      delivery.throwIfAborted();
      const status = await post(url, headers, ca, body, delivery);
      delivery.throwIfAborted();
      if (status !== 204) {
        throw new Error("The control plane did not acknowledge the runtime audit event.");
      }
    },
    close() {
      if (!closed) {
        closed = true;
        clearTimeout(retryTimer);
        shutdown.abort();
        db.close();
      }
    },
  };
}
