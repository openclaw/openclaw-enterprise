# Feature Spec: Agent creation, channels, and revision inspection

**Date:** 2026-09-01
**Status:** Completed scoped UI; Agent deletion remains deferred
**Owner:** Platform console

Current behavior is maintained in the [console reference](../../docs/reference/console.md).

## Problem and Decision

The console lists Agents but cannot create or inspect them. Extend the existing
same-origin console with a creation form, Agent detail, readable Slack and
Microsoft Teams configuration, and immutable revision browsing. Present
interactive wireframes before implementing
the screens. The archived console screenshots guide layout and interactions;
current [Agent](../../docs/reference/agents.md) and
[Configuration](../../docs/reference/configuration.md) contracts own behavior.

## Scope

- Create a Namespace-owned Configuration from editable starter JSON, then create
  an Agent with an explicit execution mode and optional listed associations.
- Inspect the saved editable Configuration separately from AgentRevisions.
- Browse the active and historical revisions without mutation controls.
- Configure Slack and Microsoft Teams in the saved Configuration.
- Design a delete confirmation. Implementation depends on the deletion decision
  below because the current backend has no Agent deletion operation.

Tools, workspace-file editing, other channel providers, rollback, deployment
controls, credential provisioning, and live channel-health probing are excluded.

## Contract

The existing controller serves all pages and assets. Session authentication,
exact-resource IAM, Namespace selection, error envelopes, and no-store behavior
remain authoritative. Navigation clears old private content; late responses
cannot replace a newer page or revision selection.

Creation starts with editable native Configuration JSON for the selected execution
mode. The starter is an example, not discovered Installation or model defaults;
credentials still require operator provisioning. A mode change updates untouched
JSON; replacing edits requires **Reset template**. Invalid JSON or a non-object
value blocks submission. The form first posts `{kind: "agent", values}` to
`POST /namespaces/:namespaceId/configurations`, then uses the returned ID with
`name`, `executionMode`, and selected association IDs in
`POST /namespaces/:namespaceId/agents`. Creation does not deploy or create a revision.
If Configuration creation succeeds but Agent creation fails, the form retains its
ID, locks the saved JSON and execution mode, and offers an explicit Agent retry without another
Configuration write. Other failures retain inputs; mutations never retry automatically.

Provider and service-account associations use optional select lists. Providers
come from Installation-admin-authorized discovery; service accounts come from the
selected Namespace, filtered by exact read access. The two associations are independent.
Loading and unavailable discovery have explicit field status and no freeform
fallback. Leaving an association unset remains supported.

Agent detail distinguishes the saved draft from an explicitly selected immutable
revision. A revision selector names its number, ID, timestamp, and active marker.
The newest admitted revision is not necessarily active. The UI never equates an
active reference with runtime health. Revision reads stay under the exact Agent;
an inaccessible selection shows an error instead of substituting another snapshot.
Historical selection is read-only, with older/newer navigation and a return to the
active revision or saved draft.

Channels are native `values.channels.slack` and `values.channels.msteams`. The
UI offers only those providers and displays fixed native environment SecretRefs
as read-only text; operators provision the credential values. It preserves unrelated
keys from the loaded native document and omits `secretBindings` from PATCH, so
the backend retains the latest bindings.
Configuration PATCH replaces the complete `values` object and increments its
generation. Save re-reads the Configuration and refuses a detected generation
change; this is a browser freshness check, not an atomic API precondition. A write
arriving between that read and PATCH can still be overwritten by the API's existing
last-writer-wins behavior. Atomic conflict protection requires a separate backend
contract and is not claimed here.
The form explicitly identifies the Configuration as potentially shared. Saving
affects future deployments using it and does not mutate existing AgentRevisions.

Configured, disabled, and absent channels have distinct labels. Live connection
health is unavailable. Kubernetes channels require dedicated execution plus
operator-provisioned credential projection; the UI explains the boundary and
does not change an Agent's execution mode silently. Teams requires separately
configured Bot Framework ingress. Multi-account/native options outside the simple
editor remain inspectable; the editor must not flatten or discard them.

## Implementation

1. Add the wireframe gallery covering list/empty, create, detail, history,
   channels, Slack/Teams drawers, delete confirmation, and failure states.
2. Extend console routing, static route handling, and the existing shell; keep
   Agent detail URLs scoped by Namespace and preserve revision selection in URLs.
3. Add Agent creation, immutable revision views, and narrowly scoped channel
   editing through existing public APIs. Use accessible forms, focus handling,
   pending states, and explicit mutation errors.
4. Update the console reference, request flow, and existing startup guidance.
   Add browser coverage against the real Fastify/OCC/IAM test fixture and preserve
   its explicit in-memory persistence/runtime limitations.

## Verification

| Required outcome                                                        | How to verify                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Wireframes precede UI implementation                                    | Open the gallery and capture its principal states before editing production UI.                                    |
| Creation saves edited JSON and selected associations without deployment | Browser create followed by actual Configuration/Agent/revision reads; exercise invalid JSON and Agent-only retry.  |
| Historical selection never mutates or substitutes configuration         | Two real admitted snapshots; edit saved Configuration, switch revisions, inspect exact values and network methods. |
| Slack/Teams editing preserves native data and uses SecretRefs           | Browser save followed by exact Configuration read; include unrelated keys and Secret bindings.                     |
| Errors retain context without unauthorized writes                       | Real IAM denial, missing resource, duplicate name, expired session, and stale-read browser cases.                  |
| Clear desktop and narrow layouts                                        | Screenshots, keyboard drawer/dialog traversal, and viewport overflow checks.                                       |

## Open Decisions

- Agent deletion: user decision requested on 2026-09-01. The backend currently
  has no operation, state primitive, or worker lifecycle for deleting Agents.
  Never-deployed-only deletion is a bounded addition; full deletion requires
  lifecycle fencing, durable cleanup, Driver teardown, and a history-retention
  decision. A wireframe must not imply these effects already exist.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01: Recorded the supported UI scope and pending deletion decision
  before implementation (01a05f89-ff1c-7643-a77f-7e1e3aed9e5f; b02a07f).

- 2026-09-01 17:50: Implemented and interactively verified creation, draft channels,
  and read-only history. Deletion scope remains pending user decision. Browser
  suite execution is blocked by managed Chrome policy; API reads verified saved
  state and unchanged revisions after in-app browser actions.
- 2026-09-01 18:07: Specify association selectors and editable starter JSON with
  Configuration-first creation and explicit Agent retry. (01a05f89-ff1c-7643-a77f-7e1e3aed9e5f - 1dd4b6b)

- 2026-09-02 07:42: Completed the scoped creation, channel editing, and revision UI.
  Verified 18 API tests, all three startup tests against the rebuilt runtime image,
  and a console-saved Slack draft through real PostgreSQL, Kubernetes deployment,
  a dedicated Codex turn, a gateway-authored reply, and persisted user/assistant
  transcript messages. Agent deletion remains the open decision above. Retained
  this numbered path under the repository specification policy.
  (01a05f89-ff1c-7643-a77f-7e1e3aed9e5f - 9e3932e)
