import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runtimeAuditReference } from "./runtime-reference.ts";
import { createRuntimeAuditReplaySigner } from "./runtime-replay.ts";

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
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const hasTable = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observations'")
      .get();
    if ((hasTable && version !== 1) || (!hasTable && (command || version !== 0))) {
      throw new Error("Unsupported runtime audit queue format. Signed observations are required.");
    }
    if (command) {
      return db;
    }
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA max_page_count = 1024;
      CREATE TABLE IF NOT EXISTS observations (
        scope TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('openclaw', 'codex')),
        endpoint TEXT NOT NULL,
        body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 4096),
        verifier TEXT NOT NULL CHECK(length(verifier) = 43),
        signature TEXT NOT NULL CHECK(length(signature) = 86),
        held_status INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS by_scope ON observations(scope, held_status);
      PRAGMA user_version = 1;
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
  // The original revision and destination remain part of each signed observation.
  const scope = createHash("sha256")
    .update(JSON.stringify([source, url.href, destination.revisionId]))
    .digest("hex");
  return {
    endpoint: new URL(auditPath, url.origin),
    source,
    scope,
    revisionId: destination.revisionId,
  };
}

export function createAuditSink() {
  if (!existsSync(destinationFile)) {
    return undefined;
  }
  const { endpoint, source, scope, revisionId } = readDestination();
  const ca = readFileSync("/etc/openclaw-runtime-audit/ca.pem");
  const token = readFileSync("/var/run/openclaw-runtime-audit/token", "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Invalid runtime audit credential.");
  }
  const signReplay = createRuntimeAuditReplaySigner(token);
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "X-OpenClaw-Runtime-Audit-Source": source,
  };
  const db = openQueue();
  const enqueue = db.prepare(`
    INSERT INTO observations(scope, revision_id, source, endpoint, body, verifier, signature)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM observations) < ?
      AND (SELECT count(*) FROM observations WHERE scope = ?) < ?
  `);
  const next = db.prepare(
    `SELECT rowid, scope, revision_id, source, endpoint, body, verifier, signature
     FROM observations WHERE endpoint = ? AND held_status IS NULL
       AND scope NOT IN (SELECT value FROM json_each(?))
     ORDER BY rowid LIMIT 1`,
  );
  const remove = db.prepare("DELETE FROM observations WHERE scope = ? AND rowid = ? AND body = ?");
  const hold = db.prepare(
    "UPDATE observations SET held_status = ? WHERE scope = ? AND rowid = ? AND body = ?",
  );
  if (db.prepare("SELECT 1 FROM observations WHERE endpoint <> ? LIMIT 1").get(endpoint.href)) {
    process.emitWarning(
      "The runtime audit queue retains events for a different destination. They were not sent.",
    );
  }
  let sending = false;
  let closed = false;
  let deliveryDelayed = false;
  let retryTimer;
  let globalRetryAt = 0;
  const deferredScopes = new Map();
  const shutdown = new AbortController();

  function warnDelay() {
    if (!deliveryDelayed) {
      process.emitWarning("Runtime audit delivery is delayed. The Gateway will retry.");
      deliveryDelayed = true;
    }
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    const times = globalRetryAt > Date.now() ? [globalRetryAt] : [...deferredScopes.values()];
    if (!closed && times.length) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void drain();
      }, Math.max(0, Math.min(...times) - Date.now()));
      retryTimer.unref();
    }
  }

  function send(row) {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(2000)]);
    if (row.scope === scope) {
      if (
        row.revision_id !== revisionId ||
        row.source !== source ||
        row.endpoint !== endpoint.href
      ) {
        throw new Error("Invalid runtime audit queue scope.");
      }
      return post(endpoint, headers, ca, row.body, signal);
    }
    const body = JSON.stringify({
      version: 1,
      revisionId: row.revision_id,
      source: row.source,
      endpoint: row.endpoint,
      body: row.body,
      verifier: row.verifier,
      signature: row.signature,
    });
    if (Buffer.byteLength(body) > 16_384) {
      throw new Error("Runtime audit replay exceeds the request limit.");
    }
    return post(new URL(endpoint.href + "/replay"), headers, ca, body, signal);
  }

  async function drain() {
    if (sending || closed) {
      return;
    }
    const now = Date.now();
    if (globalRetryAt > now) {
      scheduleRetry();
      return;
    }
    globalRetryAt = 0;
    for (const [deferred, until] of deferredScopes) {
      if (until <= now) {
        deferredScopes.delete(deferred);
      }
    }
    sending = true;
    try {
      for (
        let row = next.get(endpoint.href, JSON.stringify([...deferredScopes.keys()]));
        row;
        row = next.get(endpoint.href, JSON.stringify([...deferredScopes.keys()]))
      ) {
        const status = await send(row);
        if (closed) {
          return;
        }
        if (status !== 204) {
          if (status === 408 || status === 429 || status >= 500) {
            // A refusal for one old revision must not stop delivery for another.
            deferredScopes.set(row.scope, Date.now() + retryMs);
            warnDelay();
            continue;
          }
          hold.run(status, row.scope, row.rowid, row.body);
          process.emitWarning("Runtime audit event held for manual retry (HTTP " + status + ").");
          continue;
        }
        // Only a 204 confirms the original observation was committed.
        remove.run(row.scope, row.rowid, row.body);
        if (deferredScopes.size === 0) {
          deliveryDelayed = false;
        }
      }
    } catch {
      if (!closed) {
        globalRetryAt = Date.now() + retryMs;
        warnDelay();
      }
    } finally {
      sending = false;
      scheduleRetry();
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
        if (Buffer.byteLength(body) > 4096) {
          throw new Error("Runtime audit observation exceeds the queue limit.");
        }
        const { verifier, signature } = signReplay({
          revisionId,
          source,
          endpoint: endpoint.href,
          body,
        });
        if (
          enqueue.run(
            scope,
            revisionId,
            source,
            endpoint.href,
            body,
            verifier,
            signature,
            totalCapacity,
            scope,
            scopeCapacity,
          ).changes === 1
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
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db
        .prepare(
          "SELECT rowid FROM observations WHERE held_status IS NOT NULL AND json_extract(body, '$.eventId') = ?",
        )
        .all(eventId);
      if (rows.length !== 1) {
        throw new Error("No unique held record for this Gateway.");
      }
      db.prepare("UPDATE observations SET held_status = NULL WHERE rowid = ?").run(rows[0].rowid);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
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
    FROM observations WHERE held_status IS NOT NULL ORDER BY rowid
  `,
    )
    .all();
  db.exec("COMMIT");
  process.stdout.write(JSON.stringify({ ...counts, held }) + "\n");
}

if (import.meta.main) {
  manageQueue(process.argv.slice(2));
}
