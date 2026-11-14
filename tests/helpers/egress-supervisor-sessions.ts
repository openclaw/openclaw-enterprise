import assert from "node:assert/strict";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { connectedReceiptRevision } from "./egress-connected-inputs.mjs";

export type ObservedSession = { sessionId: string; epoch: string; at: string };

type LifecycleEnding = "inbound_eof" | "gateway_closed" | "ended";
type LifecycleEvent =
  | (ObservedSession & { event: "accepted" })
  | { sessionId: string; at: string; event: LifecycleEnding };

const lifecycleEndings = new Map<string, LifecycleEnding>([
  ["stream closed by supervisor", "inbound_eof"],
  ["superseded or closed by the gateway, shutting down", "gateway_closed"],
  ["ended", "ended"],
]);

export function isSupervisorUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Reconnect counts each accepted session once, in first-observed order.
export function acceptedSupervisorSessions(
  text: string,
  sandboxId: string,
  instanceId: string,
): ObservedSession[] {
  const sessions = new Map<string, ObservedSession>();
  for (const raw of text.split("\n")) {
    const session = readAcceptedSession(stripVTControlCharacters(raw), sandboxId, instanceId);
    if (!session) {
      continue;
    }
    const prior = sessions.get(session.sessionId);
    assert.ok(!prior || isDeepStrictEqual(prior, session), "conflicting accepted session event");
    sessions.set(session.sessionId, session);
  }
  return [...sessions.values()];
}

// Failure diagnostics keep occurrences in log order. The custody event carries
// no association between these observed sessions and a particular request.
export function supervisorSessionLifecycle(
  text: string,
  sandboxId: string,
  instanceId: string,
): { total: number; truncated: boolean; events: LifecycleEvent[] } {
  const events: LifecycleEvent[] = [];
  for (const raw of text.split("\n")) {
    const line = stripVTControlCharacters(raw);
    const session = readAcceptedSession(line, sandboxId, instanceId);
    if (session) {
      events.push({ ...session, event: "accepted" });
      continue;
    }
    const match = line.match(
      /^(\S+) \S+ +INFO +openshell_server::supervisor_session: supervisor session: (stream closed by supervisor|superseded or closed by the gateway, shutting down|ended) sandbox_id=(\S+) session_id=(\S+)$/,
    );
    if (!match || match[3] !== sandboxId) {
      continue;
    }
    const [, at, ending, , sessionId] = match;
    assert.ok(
      sessionId !== undefined && isSupervisorUuid(sessionId),
      "invalid lifecycle session ID",
    );
    assert.ok(
      at !== undefined && Number.isFinite(Date.parse(at)),
      "lifecycle event needs a timestamp",
    );
    const event = lifecycleEndings.get(ending ?? "");
    assert.ok(event, "invalid lifecycle ending");
    events.push({ sessionId, at, event });
  }
  return { total: events.length, truncated: events.length > 9, events: events.slice(-9) };
}

// Only the authenticated server's acceptance record proves a new session.
function readAcceptedSession(
  line: string,
  sandboxId: string,
  instanceId: string,
): ObservedSession | undefined {
  const match = line.match(
    /^(\S+) \S+ +INFO +openshell_server::supervisor_session: supervisor session: accepted /,
  );
  if (!match) {
    return;
  }
  const fields = new Map<string, string>();
  for (const [, name, value] of line.matchAll(
    /\b(sandbox_id|session_id|instance_id|connection_epoch)=([^\s]+)/g,
  )) {
    if (name !== undefined && value !== undefined) {
      fields.set(name, value);
    }
  }
  if (fields.get("sandbox_id") !== sandboxId) {
    return;
  }
  assert.equal(fields.get("instance_id"), instanceId, "accepted supervisor instance changed");
  const sessionId = fields.get("session_id");
  assert.ok(sessionId !== undefined && isSupervisorUuid(sessionId), "invalid accepted session ID");
  const epoch = fields.get("connection_epoch");
  connectedReceiptRevision(epoch);
  assert.ok(
    epoch !== undefined && BigInt(epoch) > 0n,
    "accepted session needs a positive connection epoch",
  );
  const [, at] = match;
  assert.ok(
    at !== undefined && Number.isFinite(Date.parse(at)),
    "accepted event needs a Kubernetes timestamp",
  );
  return { sessionId, epoch, at };
}
