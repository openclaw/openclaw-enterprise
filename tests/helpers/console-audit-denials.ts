import assert from "node:assert/strict";
import type { InMemoryAuditSink } from "../../packages/audit/src/index.ts";

// Returns authorization denials, optionally filtered by their top-level action.
export function authorizationDenials(
  auditSink: Pick<InMemoryAuditSink, "list">,
  action?: string | RegExp,
) {
  // A global or sticky filter has a cursor. Match each action independently without
  // changing the expression the caller supplied.
  const filter = action === undefined || typeof action === "string" ? action : new RegExp(action);

  return auditSink.list().filter((event) => {
    if (event.kind !== "authorization_denial") {
      return false;
    }
    if (filter instanceof RegExp) {
      filter.lastIndex = 0;
      return filter.test(event.action);
    }
    return filter === undefined || event.action === filter;
  });
}

// Returns the response and the authorization checks denied during this send.
export async function denialsDuring<T>(auditSink: Pick<InMemoryAuditSink, "list">, send: () => T) {
  const before = authorizationDenials(auditSink).length;
  const response = await send();
  const denials = authorizationDenials(auditSink)
    .slice(before)
    .map(({ authorization }) => {
      assert.ok(authorization, "New authorization denial is missing authorization details");
      const { action, resource } = authorization;
      return { action, kind: resource.kind, id: resource.id };
    });
  return { response, denials };
}
