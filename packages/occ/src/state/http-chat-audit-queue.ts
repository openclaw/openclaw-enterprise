import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  API_REQUEST_AUDIT_ACTIONS,
  type AuditEvent,
  type Installation,
} from "@openclaw-enterprise/contracts";
import { AuditAppendUnavailableError } from "../errors.ts";

const productionDirectory = "/var/lib/occ/http-chat-audit/pending";
const retryMs = 15_000;
const capacity = 4096;
// An unauthenticated client must not use the last slots needed by authorized chats.
const unresolvedLimit = capacity - 1024;

function isChatEvidence(event: AuditEvent) {
  if (event.kind === "api_request") {
    return (
      (event.action === API_REQUEST_AUDIT_ACTIONS.received ||
        event.action === API_REQUEST_AUDIT_ACTIONS.admitted ||
        event.action === API_REQUEST_AUDIT_ACTIONS.result) &&
      event.details?.operationId === "chatWithAgent"
    );
  }
  return (
    event.kind === "mutation" &&
    [
      "openclaw.agents.chat.admitted",
      "openclaw.agents.chat.completed",
      "openclaw.agents.chat.interrupted",
      "openclaw.agents.chat.failed",
    ].includes(event.action)
  );
}

function checkScope(event: AuditEvent, installationId: string) {
  const validResource =
    event.kind === "api_request"
      ? event.resource.kind === "installation" && event.resource.id === installationId
      : event.resource.kind === "agent" && !!event.namespaceId;
  if (
    !validResource ||
    event.namespaceId !== event.resource.namespaceId ||
    event.installationId !== installationId ||
    !isChatEvidence(event)
  ) {
    throw new AuditAppendUnavailableError();
  }
}

function openQueue(directory: string, command?: "status" | "retry") {
  if (command === undefined && !lstatSync(directory, { throwIfNoEntry: false })) {
    // In production the parent must already exist on the API volume.
    mkdirSync(directory, { recursive: directory !== productionDirectory, mode: 0o700 });
  }
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) {
    throw new AuditAppendUnavailableError();
  }
  const path = join(directory, "events.sqlite");
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (
    (!file && command) ||
    (file && (!file.isFile() || file.nlink !== 1 || file.uid !== dir.uid))
  ) {
    throw new AuditAppendUnavailableError();
  }
  const db = new DatabaseSync(path, {
    readOnly: command === "status",
    timeout: command ? 1000 : 25,
  });
  if (command) {
    return db;
  }
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA max_page_count=32768;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY NOT NULL,
        installation_id TEXT NOT NULL,
        installation_created_at TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) <= 8192),
        retry_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS due ON events(installation_id, installation_created_at, retry_at);
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Only the API's HTTP chat evidence uses this queue. State mutations stay transactional. */
export function startHttpChatAuditQueue(
  installation: Installation,
  mode: "production" | "development",
  commit: (event: AuditEvent) => Promise<void>,
) {
  const scope = [installation.id, installation.createdAt] as const;
  const directory =
    mode === "production"
      ? productionDirectory
      : join(
          ".development/http-chat-audit",
          createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
        );
  let db: DatabaseSync | undefined;
  let delivery: Promise<void> | undefined;
  let closed = false;
  let warned = false;
  let resumeAt = 0;

  function warn() {
    if (!warned) {
      process.emitWarning("HTTP chat audit delivery is delayed. Queued events will be retried.");
      warned = true;
    }
  }

  async function drain() {
    if (!db && !lstatSync(join(directory, "events.sqlite"), { throwIfNoEntry: false })) {
      return;
    }
    const queue = (db ??= openQueue(directory));
    let failures = 0;
    while (!closed) {
      const row = queue
        .prepare(
          `SELECT id, payload FROM events
           WHERE installation_id=? AND installation_created_at=? AND retry_at<=?
           ORDER BY retry_at, rowid LIMIT 1`,
        )
        .get(...scope, Date.now());
      if (!row) {
        return;
      }
      const id = String(row.id);
      const payload = String(row.payload);
      try {
        const event: AuditEvent = JSON.parse(payload);
        checkScope(event, installation.id);
        if (event.id !== id) {
          throw new AuditAppendUnavailableError();
        }
        // Never hold a local write lock during a PostgreSQL outage. If we crash after
        // commit, the ledger checks the original ID and fields when we retry.
        await commit(event);
        queue.prepare("DELETE FROM events WHERE id=? AND payload=?").run(id, payload);
        failures = 0;
        warned = false;
      } catch {
        warn();
        queue.prepare("UPDATE events SET retry_at=? WHERE id=?").run(Date.now() + retryMs, id);
        if (++failures >= 3) {
          resumeAt = Date.now() + retryMs;
          return;
        }
      }
    }
  }

  function wake() {
    if (closed || delivery || Date.now() < resumeAt) {
      return;
    }
    delivery = drain()
      .catch(warn)
      .finally(() => {
        delivery = undefined;
      });
  }

  const poll = setInterval(wake, retryMs);
  poll.unref();
  wake();
  return {
    enqueue(event: AuditEvent): boolean {
      if (!isChatEvidence(event)) {
        return false;
      }
      checkScope(event, installation.id);
      if (closed) {
        throw new AuditAppendUnavailableError();
      }
      try {
        db ??= openQueue(directory);
        const result = db
          .prepare(
            `INSERT INTO events (id, installation_id, installation_created_at, payload, retry_at)
             SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM events) < ?`,
          )
          .run(
            event.id,
            ...scope,
            JSON.stringify(event),
            Date.now(),
            event.actorId === "unresolved" ? unresolvedLimit : capacity,
          );
        if (result.changes !== 1) {
          throw new AuditAppendUnavailableError("AUDIT_CAPACITY_EXCEEDED");
        }
      } catch (error) {
        throw error instanceof AuditAppendUnavailableError
          ? error
          : new AuditAppendUnavailableError();
      }
      wake();
      return true;
    },
    async close() {
      closed = true;
      clearInterval(poll);
      await delivery;
      db?.close();
    },
  };
}

// Operators can inspect delivery metadata or retry a saved event. No payload edits or chat replay.
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (
    (command !== "status" && command !== "retry") ||
    (command === "status" && args.length > 1) ||
    (command === "retry" && (!args[0] || args.length > 2))
  ) {
    throw new Error("Use status [directory] or retry <id> [directory].");
  }
  const dir = args[command === "status" ? 0 : 1] ?? productionDirectory;
  const db = openQueue(dir, command);
  try {
    if (command === "status") {
      const rows = db
        .prepare(
          `SELECT id, installation_id, json_extract(payload, '$.action') AS action, retry_at
           FROM events ORDER BY rowid`,
        )
        .all();
      process.stdout.write(JSON.stringify(rows) + "\n");
    } else if (db.prepare("UPDATE events SET retry_at=0 WHERE id=?").run(args[0]!).changes !== 1) {
      throw new Error("No queued event has this ID.");
    }
  } finally {
    db.close();
  }
}
