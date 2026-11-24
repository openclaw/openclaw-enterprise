---
created: "2026-11-16"
updated: "2026-11-24 10:21"
last_updated_session: "authoring-run/e84c6230-3e81-429a-93ee-4459af104384"
---

# Agent HTTP chat flow

## Overview

A human or service submits `POST /agents/:agentId/chat`. OCC authenticates,
authorizes the stored Agent, pins its running revision, and relays one native
HTTP completion through the Compute-owned private route. The Gateway and
selected Harness own execution and history. A disconnect does not undo tool
effects. OCC can deliver queued audit records after the relay closes.

## Entry Points

- Source: `apps/controller/src/index.ts:perform`
- Source: `packages/occ/src/index.ts:resolveAgentChat`
- Source: `apps/controller/src/http/agent-chat.ts:relayAgentChat`
- Assumptions: selected IAM and Compute Drivers, an authenticated session or
  service key, exact-Agent `operate`, and an enabled private runtime route.

## Flow

The diagram follows the current source. Live runtime qualification is separate.

```mermaid
graph TD
  A["<b>POST Agent chat</b><br/>Session or service key"] --> B["<b>OCC admission</b><br/>Authenticate and check CSRF"]
  B -->|audit on| R["Queue API admission"]
  R -->|write fails| V
  R -->|saved| C
  B -->|audit off| C["<b>Controller</b><br/>Resolve stored ownership<br/>Authorize exact Agent"]
  C --> D{"Compute capability?"}
  D -->|absent| U["Return 501"]
  D -->|present| E{"Running revision<br/>and matching owner?"}
  E -->|no| V["Return 503"]
  E -->|yes| F["<b>Compute</b><br/>Resolve private endpoint"]
  F -->|unsupported| U
  F -->|disabled or unavailable| V
  F -->|available| G["<b>OCC relay</b><br/>Scope conversation<br/>Queue chat admission"]
  G -->|write fails| V
  G -->|saved| H["<b>Private proxy</b><br/>Set chat-only authority"]
  H --> I["<b>Gateway and Harness</b><br/>Run turn and emit response"]
  I --> J["<b>OCC relay</b><br/>Forward JSON or SSE<br/>Apply backpressure"]
  J --> K{"Response completed?"}
  K -->|yes| N["Recheck caller and revision"]
  N -->|current| L["Queue chat result"]
  N -->|changed or unavailable| M
  K -->|deadline, disconnect<br/>or failed recheck| M["Abort upstream<br/>Queue uncertain outcome"]
  classDef gate fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  classDef process fill:#E9F4F1,stroke:#83A99E,color:#29443D,stroke-width:1px
  class D,E,K gate
  class B,C,F,G,H,I,J,R process
```

## Execution Trace

### 1. Authenticate and select authority

`apps/controller/src/index.ts:admit` and `resolveIdentity` use the existing
session/CSRF or service-key verifier and selected IAM Driver. With Control
Plane audit on, `requireRequestAuditAdmission` queues
`openclaw.api.request.admitted` before the handler runs.
The HTTP route has no Namespace input. `packages/occ/src/index.ts:resolveAgentChat` finds stored
ownership once per check, enforces a service key's Namespace scope and authorizes `operate`.
Denial audit uses the error's authoritative resource; the route does not copy
stored ownership into request parameters.
A caller with only `read` gets `403`; a hidden or absent Agent gets `404`.

### 2. Select the running revision and private route

`packages/occ/src/index.ts:resolveAgentChat` checks capability absence before
lifecycle availability, then checks the saved Compute owner before invoking the
Driver. It returns the selected revision with the endpoint result.

`apps/controller/src/drivers/compute/kubernetes/index.ts:getChatCompletionsEndpoint`
checks supported topology and authority, explicit opt-out and route availability
in that order. Compute records HTTP-default admission on new revisions; rendering
and endpoint resolution use that saved decision. A revision without it keeps its
existing settings until redeployment. `reconcileGatewayRoute` creates a revision-specific Service and HTTPRoute
for the exact completion POST. The Service selects only that revision. The route
rewrites the path and supplies the chat scope header. Existing Kubernetes
retirement removes both resources. Core code does not construct Kubernetes paths.

### 3. Forward one request

`apps/controller/src/http/agent-chat.ts:relayAgentChat` rejects native routing
headers, replaces the model target and hashes an explicit conversation label
with stable principal and Agent identities. It constructs upstream headers
without copying caller credentials. With audit on or off, the relay queues
`openclaw.agents.chat.admitted` through the State audit sink. If PostgreSQL
cannot confirm a required queue write, OCC returns `503`.
Otherwise, the relay sends the HTTP request once.

### 4. Bound the relay and record the result

`apps/controller/src/http/agent-chat.ts:relayAgentChat` streams bytes with
backpressure. A timer reauthenticates and reauthorizes the pinned revision.
After the native body completes, terminal delivery awaits any in-flight periodic
check and its cleanup, then starts a fresh bounded admission/revision check.
Checks do not overlap, and terminal bytes stay withheld until the fresh check
succeeds. A check started before body completion cannot authorize delivery.
Failure, revision change, client disconnect or deadline aborts the upstream
connection. One outer cleanup clears the timers and disconnect listeners, aborts
the upstream and queues one chat result. Before headers, OCC can return its
error envelope. After headers, it closes the response. The result identifies
the principal and revision without message content. If OCC cannot queue the
result, it logs `http.audit_append_failed`.

### 5. Deliver queued records

`packages/occ/src/state/postgres-state.ts:PostgresPlatformState.enqueueHttpChatAudit`
saves the event in `occ.http_chat_audit_queue`. The relay does not wait for
the final write to `occ.audit_events`.

`startHttpChatAuditDelivery` checks pending records at startup and every
15 seconds. A new record also triggers delivery. `deliverHttpChatAudit`
writes the record to the audit log and removes it from the queue in one
transaction. After a failed delivery, OCC warns and schedules a retry
after 15 seconds. It keeps the original ID and event in the queue.
Other events can arrive first. A retry sends only the record.

## Debugging and Verification

- For delayed records, follow [HTTP chat audit recovery](../guides/agent-http-chat.md#retry-delayed-http-chat-audit-records).

- `node --test tests/integration/agent-http-chat.test.ts` checks Fastify and IAM
  admission only; it does not prove PostgreSQL or model execution.
- Select `http-chat` in the [real QA matrix](../testing/ci/qa-advisory.md) for
  normal provisioning, real completions and selected Harness tool effects.
- Inspect request IDs, HTTP statuses and revision IDs in audit evidence. A `502`
  after successful resolution points to transport or interruption; `503` can
  precede any upstream request. A `503` `text/plain` body from the route's proxy
  is passed on unchanged: a graceful Gateway Pod deletion cut a non-stream
  request. Do not infer tool rollback from either status.

## Related docs

- [HTTP chat contract](../reference/agent-http-chat.md)
- [Operator procedure](../guides/agent-http-chat.md)
- [Native browser access](agent-native-admin.md)
- [Implementation plan](../../specs/plans/0040-agent-chat-completions.md)

## Manual Notes

## Changelog

- 2026-11-24 10:21: Trace HTTP chat admission, result and background audit delivery. (authoring-run/e84c6230-3e81-429a-93ee-4459af104384 - de7a98fdbb33b5ed3ac59b2a8ca004b2aeb5f705)

- 2026-11-18 05:48: Note that the route proxy's `503` reaches a non-stream caller when a Gateway Pod is deleted. (fix-interrupted-turns-1118 - 8cbb31a68)

- 2026-11-17 02:02: Await the periodic check, then require a fresh post-body delivery check. (authoring-run/28767d0f-55e0-4d91-abb6-1f25ff793a2a - d7c1c305e)

- 2026-11-17 01:37: Share one admission recheck and relay cleanup owner; use stored denial resources. (authoring-run/28767d0f-55e0-4d91-abb6-1f25ff793a2a - 8d3f95dd5)

- 2026-11-16 23:42: Recheck authority before terminal delivery after the real stop-during-stream regression. (authoring-run/e151ca6f-93f3-4976-bad1-585c8dde1264 - 9f342c940)

- 2026-11-16 19:13: Document the accompanying HTTP chat implementation; runtime proof remains pending (authoring-run/e151ca6f-93f3-4976-bad1-585c8dde1264 - 292afc4c5)
