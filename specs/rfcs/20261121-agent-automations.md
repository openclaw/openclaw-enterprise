---
status: Proposed
implementation_status: Partially implemented
author: kevinlin-openai
---

# Proposal: Schedule Agent automations with approved MCP tools

- **ID:** RFC-20261121-agent-automations
- **Created:** 2026-11-21
- **Last updated:** 2026-11-22
- **RFC PR:** [#6850](https://github.com/openclaw/openclaw-enterprise/pull/6850)
- **Implementation plan:** [Broker implementation](../plans/20261121-agent-automations.md)
- **Related:** [Native administration](../../docs/reference/agent-native-admin.md), [Gateway managed mode](../../docs/reference/agents/gateway-managed-mode.md), [runtime pin](../../deploy/runtime/openclaw-source.json)

## Decision and scope

OpenClaw Control Plane (OCC) brokers six HTTP operations for timed Agent turns.
An operator can schedule the same **Agent-shared, preapproved static Model Context
Protocol (MCP) operations** that the deployed Agent can perform unattended. OCC
owns caller authorization, creator records, binding identity and audit. OpenClaw
owns job definitions, scheduling, execution and history.

The cap is a finite list of exact native tool names. The server derives it from
the deployed Agent's explicit provisioning and Gateway tool policy. The client
supplies the schedule and prompt. When the Agent has no eligible operations, the
cap is explicitly `[]` and the scheduled turn can use the model alone. Unknown
qualification or an ambiguous binding refuses admission.

## Execution authority

The human needs exact-Agent `operate` to create the job. Creation authorizes
standing use of the Agent's shared workload authority. The native administrative
connection can create a trusted operator job. This design grants it only the
admitted MCP operations. It never captures the creator's personal account,
requester session, delegated user credential or approval. The ordinary Agent and
scheduled turn must use the same server endpoint, tools, permitted provider
actions, workload credential identity and standing approval. An operation that
needs an interactive approval or a requester-specific grant is ineligible.
Approval of one tool does not imply approval of each action accepted by it.
The provider or its adapter must enforce the same action restrictions on both paths.

An existing job retains the Agent's delegation after its creator loses access.
The creator then loses management and history access unless separately authorized.
An Agent administrator can disable or remove the job. Withdrawal requires
deleting or retiring the job, or denial by the MCP service. Changing controller
configuration alone does not revoke running native cron. A call already issued
can complete.

<a id="unresolved-execution-authority"></a>

## Select eligible tools

The provisioning Driver checks the Agent's standing approval, explicit nonempty
literal include filter and deployed Gateway policy before discovery. Match the
catalog's native alias, raw tool, server, endpoint, permitted actions and
anonymous identity. Reject patterns, collisions, missing evidence and personal
or interactive grants. Bind the approved operations and approval identity to
the exact Namespace, Agent and revision. Store no credential values.

Use read-only `sessions.list` for the selected native `agentId`, with explicit
row, page, response-size and time limits enforced by the adapter. Exclude cron,
subagent, system and dock sessions; omit global and unknown scope. Select an
existing ordinary session whose returned ownership and provenance identify the
same Agent. Refuse missing or ambiguous scope and exhausted limits. Never guess
a session key or create a synthetic turn to obtain an inventory.

Use the persisted session key and native Agent ID with
[`tools.effective`](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/src/gateway/server-methods/tools-effective.ts#L474).
Verify the returned Agent and each entry's `source: "mcp"`, `id`, `mcpServer`
and `mcpToolName`. Refuse session-denied entries and stale catalogs. Use bounded
`tools.catalog` and `plugins.inspect` on supported versions to detect native
name conflicts and verify loaded plugin origins. Require evidence for every
check. Apply time, page, row and byte limits to qualification RPCs. A session
inventory cannot grant personal authority.

For a nonempty cap the effective Code Mode and tool search must both be off.
Exclude native shell, files, code execution, delegation, messaging, dynamic
discovery and app tools. Neither creation nor a later run can introduce another
tool through discovery, a wrapper or alias. Qualify the packaged embedded
OpenClaw Harness and ordinary dedicated Codex Harness independently. Current
managed MCP Sandbox and Codex app topologies cannot supply this contract.
Ordinary chat and native administration keep their existing policies.

Both Harnesses accept only operator-attested anonymous HTTPS. Each Compute
`automations.trustedAnonymousMcpEndpoints` entry has `url`, `egressCidrs`
and optional public PEM `caBundle`. Require an exact normalized HTTPS URL
and exact host addresses (/32 or /128). Refuse stdio, wildcard destinations,
credentials, private keys and redirects to unapproved origins. The operator
attests identical anonymous actions from the Gateway and dedicated Agent.
Tool annotations and successful discovery cannot establish approval.

The Driver derives the TCP port from the URL (default 443). Add only the listed
IP/port pairs to the Gateway and, for dedicated Codex, Agent NetworkPolicies.
Retain default-deny egress and unrelated required workload routes. Validate TLS
hostname and chain. Project the public CA only into the relevant workload:
merge it with required Gateway Node trust via `NODE_EXTRA_CA_CERTS` and with
dedicated Codex PEM trust via `CODEX_CA_CERTIFICATE`. These roots affect other
TLS connections in that workload. Keep model credentials out of the dedicated
Gateway. Refuse a topology that cannot enforce these boundaries.

Native administrators and chat remain trusted writers outside OCC. OCC does
not adopt native jobs. The pinned [operator execution context](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/src/cron/execution-context.ts#L322)
and [Codex native tool construction](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/extensions/codex/src/app-server/dynamic-tool-build.ts#L523)
require origin checks in addition to tool names.

## Goals and non-goals

Support one-shot, interval and cron schedules, CRUD, pause/resume, native
normalization and retained history. Immediate execution, new result
destinations, scripts, event triggers, service-principal HTTP access, Console
controls and CLI commands are outside this proposal. Scheduler housekeeping
and configured failure notifications can still occur.

## Authorization and interface

All paths start with `/namespaces/{namespaceId}/agents/{agentId}/automations`.
Public automation IDs are UUIDs; they are distinct from native job IDs.

| Method and path  | Request                                 | Result                                      |
| ---------------- | --------------------------------------- | ------------------------------------------- |
| POST collection  | `name`, `enabled`, `schedule`, `prompt` | 201 and normalized job, after qualification |
| GET collection   | Optional `offset`, `limit`              | 200 and authorized summaries                |
| GET `/{id}`      | No query                                | 200 and supported job                       |
| PATCH `/{id}`    | Expected revision and editable fields   | 200 and updated job                         |
| DELETE `/{id}`   | `expectedConfigRevision` query          | 204                                         |
| GET `/{id}/runs` | Optional `offset`, `limit`              | 200 and authorized native history           |

Creation requires a human session and exact-Agent `operate`; `administer` alone
does not substitute. Management and history require creator `operate` or
exact-Agent `administer`. Reuse these IAM actions and the Agent resource kind.
Service keys are refused. Mutations retain existing CSRF and Origin checks.

Authorize before native access or resource disclosure. Foreign and absent
ownership records return indistinguishable 404 responses. Filter by the final
authority decision before public pagination, totals and snapshot hashes; losing
administration must not expose a previously loaded all-creator view. Malformed
UUIDs are 400 input errors, not database errors.

Bodies are closed. Clients cannot select native Agent IDs, creators, tool grants,
RPC methods, native scopes, credentials or delivery targets. PATCH can edit the
name, prompt, schedule and enabled state. Stale native revisions return 409.

## Native contract and ownership

Require the selected Driver's instance-pinned transport, native administrative
access, required methods and an unambiguous server-selected native Agent.
OCC invokes only `cron.add`, `cron.list`, `cron.get`, `cron.update`,
`cron.remove` and `cron.runs`, plus the bounded qualification reads above.
The underlying administrative credential stays private.

Creation maps to `sessionTarget: "isolated"`, `wakeMode: "now"`, an `agentTurn`
payload with the requested prompt and explicit `toolsAllow`, and
`delivery.mode: "none"`. Preserve native schedule normalization, including generated
interval anchors and cron staggering, in reads and subsequent edits. Persist the immutable ceiling and binding identities
with the OCC reservation. Reassert the permitted cap on update. Additions to
the Agent policy never expand an existing job. All captured operations must
remain present with the same binding identity. A missing alias does not prove
safe withdrawal: a core/plugin tool or wrapper could reuse its name. Therefore
narrowing, removal, remapping or unverifiable binding blocks enablement and
successor admission/startup while any active, paused or uncertain ownership
record retains the grant. Delete or retire affected jobs, deploy the narrower
policy, then create new jobs. Do not automatically shrink a persisted cap. An empty MCP include filter can mean unrestricted access. Disable or omit that server when its permitted set is empty.
Never serialize an empty include list as a restriction.

Before native create, reserve a public OCC UUID with its exact Namespace, Agent,
human creator, selected native Agent and creation time. Commit reservation and
admission audit atomically. Supply `occ-automation:<OCC UUID>` as the native
declaration key and create disabled. OpenClaw allocates the native ID. Bind it
durably once before a separate update enables the job if requested.

Creator/target fields are immutable; a native ID cannot be rebound or shared by
two records for one Agent. Store no prompt, credential value, duplicate definition or
second scheduler. Agent deletion removes its ownership rows. Native job deletion
retains them so the same creator/admin boundary authorizes history afterward.
Native history expiry still applies, and a deleted job that never ran returns 404.

A lost create reply can leave a disabled job. Read recovery matches the reserved
declaration key and fills a missing binding once, with audit; it neither replays
create nor automatically enables the job. If transport proves no send, or native
rejects create and inventory confirms absence, conditionally discard only the
original creator's unbound reservation with audit in the same transaction.
Concurrent binding and failed audit must prevent deletion. Admission evidence
survives cleanup.

## Concurrency, failures and audit

PATCH uses the same full native read for eligibility and revision comparison,
then sends that revision to native atomic update. DELETE also uses a revision
precondition. A concurrent edit cannot silently overwrite the winner. Inventory
reads require a consistent native snapshot and expose only authorized summaries.

Recheck session, authority and selected revision around dispatch and before
returning a result. A sent mutation with a lost/malformed reply, changed revision
or failed post-commit audit returns `503 UNKNOWN_OUTCOME`. Keep the ownership
record and return its `Location` when known. Do not automatically replay. A
missing live job does not prove it never ran; consult retained history.

Use ordinary 400/403/404/409 errors for invalid input, denied authority, hidden or
missing records, and conflicts. Unsupported or unqualified execution remains a
503 refusal. Stopped or unavailable runtimes do not admit native access.

Audit admission, successful mutations, binding/recovery, definite-create cleanup,
denials and uncertain outcomes with Principal, Namespace, Agent, selected
revision, operation and known public/native IDs. Exclude prompts, transcripts,
credentials and native payloads. Preserve metadata established before a denial.

## Interface changes and deployment

The public HTTP and IAM contract above stays the same. Extend the PostgreSQL
ownership record to persist the immutable cap and binding snapshot atomically
with reservation. Existing rows without trusted binding evidence are eligible
only for their proven model-only ceiling. Never infer a tool-bearing grant by
scanning an existing job or current catalog.

Add one optional Compute Driver operation,
`openAgentAutomationTransport(revision, qualification)`. It returns a private
RPC connection bound to the exact verified Gateway instance. Before dispatch,
verify the selected revision, Pod UID, container ID, actual image, guarded
launcher/version, effective policy and trust configuration. Require a fresh
deployment if the guard is missing. Refuse absent or stale evidence.

For Kubernetes, open a controller-private, single-use loopback WebSocket
tunnel to the exact Pod through the Kubernetes `pods/proxy` GET operation.
The Driver owns Kubernetes authentication and TLS. The transport exposes
instance assertion and close operations. Recheck Pod UID, container ID and
image after handshake and before RPC dispatch. An Agent-wide Service can route
to another revision during cutover. Pin one connection through the eligibility
read and mutation, then close it. On replacement, stop dispatch. After a
possibly sent write, return `UNKNOWN_OUTCOME` without reconnecting or replaying.
Runtime details belong
to the Driver and Harness. Submit the contract before implementation.

Before **every** native Gateway process spawn, including supervisor respawn
and kubelet container restart, the launcher verifies the effective plugin
allowlist, plugin origins and package digests against the approved image. Reject
native tracked installs, mutable global extension roots, unapproved plugins,
digest mismatches and Node startup switches or module-loading overrides outside
the qualified allowlist. Check the effective node/tool switches for the selected
Harness. Fail before plugin loading, scheduler startup or catch-up.

Serialize job admission and enablement with deployment or refuse while a pending
successor could change bindings. Before start, rollback or recovery, the worker
checks that every grant (including paused and uncertain reservations) remains a
subset of the successor's eligible operations with identical bindings. Additional
eligible operations never widen a saved cap. Keep the scheduler stopped if any
check fails. A same-revision restart retains its standing grant and repeats the
local origin check. Worker observation alone cannot stop a running scheduler.
Retire the job or deny at the service to withdraw a running grant.

## Qualification and acceptance

- **AC1. Genuine execution.** Through OCC, exercise each schedule type. On
  each packaged Harness, run a real scheduled turn against a provisioned static
  MCP service. Observe a permitted operation on the service with the same
  verified workload identity and approval as ordinary Agent chat. Use provider
  or service records to verify the action and credential identity.
- **AC2. Restricted execution.** On both Harnesses, request a forbidden sibling
  tool, a second server and a forbidden action on the allowed tool. Verify
  refusals and absence of provider effects. Attempt native shell/file actions,
  delegation, messaging, app tools and discovery. Verify the effective tool
  surface and absence of effects. A personal credential or an interactive
  approval requirement cannot qualify. Verify refusal before discovery for invalid
  provisioning, and reject foreign, cron, unknown or absent ordinary sessions,
  mismatched MCP identities and exhausted discovery limits. Check explicit
  model-only execution with no eligible operations, and refusal of Code Mode/tool
  search on a nonempty cap.
- **AC3. Ownership and persistence.** Verify CSRF/Origin, service-key refusal,
  exact-Agent create and creator/admin management, UUID validation and native
  history after deletion. Demote the creator and verify the job still uses the
  shared Agent identity. An administrator can stop it. Pause, resume, edit
  and delete with native CAS. Preserve cap, binding, identity, paused state
  and retained history across compatible Gateway and Agent revision replacement.
- **AC4. Policy and recovery.** Narrow a literal filter, remove a trusted endpoint,
  and remap the same alias to another server or principal. With active, paused
  and uncertain records, verify successor admission/startup refuses each change.
  Delete or retire affected jobs before deploying the narrower policy and
  recreating them. Race enablement with a pending revision; recover an overdue
  job through OCC-managed replacement and roll back. Prove startup refusal precedes catch-up and later additions
  cannot widen a cap. Distinguish the running-Gateway withdrawal limit and
  already issued calls. Check native CAS, lost replies, failed audit and revision
  changes without duplicate dispatch.
- **AC5. Durable records.** Verify PostgreSQL reservation, binding and audit
  atomicity, failed-create cleanup racing with binding, Agent deletion with
  sibling retention, and history access after deletion. Use the actual packaged
  Harnesses and real endpoint, credential, model and database evidence for
  their relevant criteria. A native CRUD fixture alone cannot qualify execution.

- **AC6. Runtime and egress.** On both Harnesses, prove TLS with the projected CA
  and rejection of an untrusted certificate, wrong hostname, sibling IP and
  port. On dedicated Codex verify credential isolation. Reject an old launcher,
  stale Pod/container evidence, mutable plugin origin, changed digest and
  unsupported Node switch. Repeat after native respawn and container restart
  with an overdue job. Race RPC admission with old and new Pods during
  cutover. Verify the checked instance receives the mutation or the request
  fails, and that the other instance receives no mutation.

## Delivery status

The broker is partially implemented. Tool-bearing scheduling stays gated until
the relevant Driver and packaged Harness satisfy the criteria above. The
[implementation plan](../plans/20261121-agent-automations.md) records delivery
evidence. RFC submission permits implementation of the proposed Driver contract.
Production qualification remains outstanding.
