import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runtimeAuditReference } from "./runtime-reference.ts";

const auditPath = "/internal/runtime-audit";
const destinationFile = "/etc/openclaw-runtime-audit/destination.json";
// "state" is on the Agent's private Gateway volume and survives Pod replacement.
const queueDirectory = "/home/node/.openclaw/state/pending-runtime-audit";
const scopeCapacity = 256;
// Keep room for a new revision when its predecessor has a full backlog.
const totalCapacity = 2 * scopeCapacity;
const retryMs = 15_000;

function encode(event) {
  const sessionId = event.sessionId && runtimeAuditReference(event.sessionId);
  // Message lookup needs both the original physical session ID and the original message ID.
  const canLink =
    sessionId === event.sessionId &&
    event.messageId &&
    runtimeAuditReference(event.messageId) === event.messageId;
  return JSON.stringify({
    ...event,
    sessionId,
    turnId: event.turnId && runtimeAuditReference(event.turnId),
    modelCallId: event.modelCallId && runtimeAuditReference(event.modelCallId),
    messageId: canLink ? event.messageId : undefined,
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

function openQueue(command) {
  if (!command) {
    mkdirSync(queueDirectory, { mode: 0o700, recursive: true });
  }
  const dir = lstatSync(queueDirectory);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) !== 0) {
    throw new Error("Invalid runtime audit queue directory.");
  }
  const path = join(queueDirectory, "observations.sqlite");
  const stat = lstatSync(path, { throwIfNoEntry: !!command });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.uid !== dir.uid)) {
    throw new Error("Invalid runtime audit queue file.");
  }
  const db = new DatabaseSync(path, {
    readOnly: command === "status",
    // A manual retry briefly takes the same SQLite write lock as a new event.
    timeout: command ? 1000 : 25,
  });
  if (command) {
    return db;
  }
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA max_page_count = 1024;
      CREATE TABLE IF NOT EXISTS observations (
        scope TEXT NOT NULL,
        body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 4096),
        held_status INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS by_scope ON observations(scope, held_status);
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function readDestination() {
  const destination = JSON.parse(readFileSync(destinationFile, "utf8"));
  const url = new URL(destination.url);
  const source = destination.source;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== auditPath ||
    typeof destination.revisionId !== "string" ||
    !destination.revisionId ||
    (source !== "openclaw" && source !== "codex")
  ) {
    throw new Error("Invalid runtime audit destination.");
  }
  // Credentials can rotate. A different revision or destination must never claim old rows.
  const scope = createHash("sha256")
    .update(JSON.stringify([source, url.href, destination.revisionId]))
    .digest("hex");
  return { endpoint: new URL(auditPath, url.origin), source, scope };
}

export function createAuditSink() {
  if (!existsSync(destinationFile)) {
    return undefined;
  }
  const { endpoint, source, scope } = readDestination();
  const ca = readFileSync("/etc/openclaw-runtime-audit/ca.pem");
  const token = readFileSync("/var/run/openclaw-runtime-audit/token", "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Invalid runtime audit credential.");
  }
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "X-OpenClaw-Runtime-Audit-Source": source,
  };
  const db = openQueue();
  const enqueue = db.prepare(`
    INSERT INTO observations(scope, body)
    SELECT ?, ? WHERE (SELECT count(*) FROM observations) < ?
      AND (SELECT count(*) FROM observations WHERE scope = ?) < ?
  `);
  const next = db.prepare(
    "SELECT rowid, body FROM observations WHERE scope = ? AND held_status IS NULL ORDER BY rowid LIMIT 1",
  );
  const remove = db.prepare("DELETE FROM observations WHERE scope = ? AND rowid = ? AND body = ?");
  const hold = db.prepare(
    "UPDATE observations SET held_status = ? WHERE scope = ? AND rowid = ? AND body = ?",
  );
  if (db.prepare("SELECT 1 FROM observations WHERE scope <> ? LIMIT 1").get(scope)) {
    process.emitWarning(
      "The runtime audit queue retains events for another revision or destination.",
    );
  }
  let sending = false;
  let closed = false;
  let deliveryDelayed = false;
  let retryTimer;
  const shutdown = new AbortController();

  function send(body) {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(2000)]);
    return post(endpoint, headers, ca, body, signal);
  }

  async function drain() {
    if (sending || closed || retryTimer) {
      return;
    }
    sending = true;
    try {
      for (let row = next.get(scope); row; row = next.get(scope)) {
        const status = await send(row.body);
        if (closed) {
          return;
        }
        if (status !== 204) {
          if (status === 408 || status === 429 || status >= 500) {
            throw new Error("Temporary audit service failure.");
          }
          hold.run(status, scope, row.rowid, row.body);
          process.emitWarning("Runtime audit event held for manual retry (HTTP " + status + ").");
          continue;
        }
        // Only a 204 confirms the original observation was committed.
        remove.run(scope, row.rowid, row.body);
        deliveryDelayed = false;
      }
    } catch {
      if (!closed) {
        if (!deliveryDelayed) {
          process.emitWarning("Runtime audit delivery is delayed. The Gateway will retry.");
          deliveryDelayed = true;
        }
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void drain();
        }, retryMs);
        retryTimer.unref();
      }
    } finally {
      sending = false;
    }
  }

  // A separate operator process can release a held row while chat is idle.
  const poll = setInterval(() => void drain(), retryMs);
  poll.unref();
  void drain();
  return {
    source,
    emit(event) {
      if (closed) {
        return;
      }
      try {
        const body = encode(event);
        if (
          Buffer.byteLength(body) <= 4096 &&
          enqueue.run(scope, body, totalCapacity, scope, scopeCapacity).changes === 1
        ) {
          void drain();
          return;
        }
      } catch {
        // A storage error must not interrupt the turn that produced the observation.
      }
      process.emitWarning(
        "The Gateway could not queue a runtime audit event. The record is missing.",
      );
    },
    close() {
      if (!closed) {
        closed = true;
        clearInterval(poll);
        clearTimeout(retryTimer);
        shutdown.abort();
        db.close();
      }
    },
  };
}

// Pod operators may release an existing record. They cannot supply a body, token or destination.
function manageQueue([command, eventId, ...extra]) {
  if (
    extra.length ||
    !((command === "status" && eventId === undefined) || (command === "retry" && eventId))
  ) {
    throw new Error("Use status or retry <eventId>.");
  }
  const { scope } = readDestination();
  using db = openQueue(command);
  if (command === "retry") {
    const result = db
      .prepare(
        `
      UPDATE observations SET held_status = NULL
      WHERE scope = ? AND held_status IS NOT NULL AND json_extract(body, '$.eventId') = ?
    `,
      )
      .run(scope, eventId);
    if (result.changes !== 1) {
      throw new Error("No matching held record for this Gateway.");
    }
    return;
  }
  db.exec("BEGIN");
  const counts = db
    .prepare(
      `
    SELECT count(*) FILTER (WHERE scope = ? AND held_status IS NULL) AS pending,
           count(*) FILTER (WHERE scope <> ?) AS otherScope FROM observations
  `,
    )
    .get(scope, scope);
  const held = db
    .prepare(
      `
    SELECT json_extract(body, '$.eventId') AS eventId, held_status AS status
    FROM observations WHERE scope = ? AND held_status IS NOT NULL ORDER BY rowid
  `,
    )
    .all(scope);
  db.exec("COMMIT");
  process.stdout.write(JSON.stringify({ ...counts, held }) + "\n");
}

if (import.meta.main) {
  manageQueue(process.argv.slice(2));
}
