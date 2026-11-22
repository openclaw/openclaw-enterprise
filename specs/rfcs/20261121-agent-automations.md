---
status: Accepted
implementation_status: Implemented
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
Operators can schedule **Agent-shared, preapproved static Model Context Protocol
(MCP) operations** available to the deployed Agent unattended. OCC owns
authorization, creator records, binding identity and audit; OpenClaw owns job
definitions, scheduling, execution and history. OCC derives a finite exact-name
cap from deployed provisioning and Gateway policy. Clients supply schedule and
prompt. A qualified Agent with no eligible operations uses `[]` for model-only
execution; unknown qualification or ambiguous bindings refuse admission.

## Execution authority

The human needs exact-Agent `operate` to create the job. Creation authorizes
standing use of the Agent's shared workload authority through a trusted native
operator job limited to admitted MCP operations. It captures no creator account,
requester session, delegated credential or approval. The ordinary Agent and
scheduled turn must use the same server endpoint, tools, permitted provider
actions, workload credential identity and standing approval. Interactive approval or requester-specific grants are
ineligible; approve actions separately. The provider or adapter enforces the same action
restrictions on both paths.

Creator access loss removes management/history access, but not standing
delegation. Agent administrators can disable or remove jobs. Controller
configuration cannot revoke running cron; retire the job or deny at the MCP
service. Issued calls can complete.

<a id="unresolved-execution-authority"></a>

## Select eligible tools

Both Harnesses validate enabled servers' nonempty literal raw include filters
before Gateway, Agent or caller subsets. Reject entries starting case-insensitively
with that server's normalized safe prefix plus `__`; native treats them as alias
selectors. Unrelated `foo__bar` remains valid; refuse selectors without probe or fallback. Check standing approval,
Gateway policy, alias, raw tool, server, endpoint, actions and anonymous identity.
Reject patterns, collisions, missing evidence, personal or interactive grants and
utility names `resources_list`, `resources_read`, `prompts_list`, `prompts_get`
(case-insensitive). Bind approval to Namespace, Agent and revision.

For fresh embedded native state, Compute renders schema-valid configuration with
server-owned `meta.lastTouchedVersion` matching the exact reviewed native
image/source version; reject caller-owned or conflicting `meta`. This prevents
stock compat inference and suppresses configured-plugin release bookkeeping/restamp.
Doctor and missing-plugin repair still run. Requalify each pin. Existing
persisted compat remains unqualified; never write directly to native databases.

Embedded corroborates through `sessions.list` and
[`tools.effective`](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/src/gateway/server-methods/tools-effective.ts#L474)
from an existing ordinary same-Agent session. Exclude cron, subagent, system,
dock, foreign and unknown scopes. Refuse missing or exhausted evidence, session
denials, mismatched MCP descriptors and stale catalogs. Check `plugins.inspect`
and `tools.catalog` for origins/collisions. Never guess keys or create turns.

Dedicated ordinary Standard deployment requires reviewer exactly `user`, no
`auto_review`, and an enabled native Codex `networkProxy` in `limited` mode with finite domain
decisions. Preserve denies; refuse dangerous, local-binding or socket overrides.
Bind the canonical full reviewer and proxy descriptors to the grant. Each
approved MCP server retains `codex.defaultToolsApprovalMode: "approve"`.
Use immutable operator-attested Agent server/filter, Gateway/main allow lists,
identity, endpoint, images, revision, plugin and launcher. Verify live route/boot
and `plugins.inspect`/`tools.catalog` across the complete allocated source
namespace. Refuse suffix ambiguity, core/plugin/node collisions, dynamic
exclusions and reserved `mcp__` names (case-insensitive). Apply the finite native
cron cap. Do not read `sessions.list`, `tools.effective`, `sessions.get` or
history, or inherit chat denials. Packaged proof establishes ordinary/scheduled
identity, source and cap parity.

For a nonempty cap, bind the sole canonical `agents.entries.main.identity.name`
exactly. Embedded may use identity alone; dedicated also requires exact
`tools.allow`. Code Mode and tool search must be off; refuse `agents.list`.
Exclude native shell, files, code execution, delegation, messaging, dynamic
discovery and app tools. Creation and runs cannot introduce tools through discovery, wrappers or aliases. Qualify the packaged embedded
OpenClaw and ordinary dedicated Codex independently. Managed MCP Sandbox and apps
are ineligible; chat and native administration remain trusted.

Both Harnesses qualify enabled anonymous static `transport: "streamable-http"`
at an exact reviewed HTTPS URL. Legacy SSE is unqualified. Each Compute `automations.trustedAnonymousMcpEndpoints` entry
has `url`, exact host `egressCidrs` (/32 or /128) and optional public PEM
`caBundle`. Refuse stdio, wildcard destinations, credentials and private keys;
attest identical anonymous actions.

Compute renders server-owned opaque Gateway loopback routes. Each MCP-tool grant
binds the full canonical enabled route map and all endpoint attestations to original
HTTPS targets, revision and CAs. Pinned Harnesses skip MCP acquisition for
`toolsAllow: []`. Public source stays original; successor changes invalidate grants.
Native discovery may initialize/list siblings before cap filtering; forbidden calls
remain denied.

Before Doctor/native startup, a Gateway Node supervisor listens and forwards only
to fixed targets with verified TLS. Resolve the approved hostname, refuse addresses
outside admitted endpoint CIDRs, and pin the actual upstream socket to the checked
address without a second lookup. Separate model TCP/443 egress makes NetworkPolicy
alone insufficient. Enforce strict method/route/headers and bounded streaming;
refuse all 3xx without Location/replay, generic URL/CONNECT, auth or cookie
forwarding. Bind, fail, hold and attest the proxy/map throughout the lifecycle.

The URL determines TCP port (default 443); only the Gateway NetworkPolicy
receives listed endpoint IP/port pairs. Validate upstream TLS hostname and chain;
supply the public automation CA only to the fixed target's proxy TLS request. Never
expand process-wide Gateway/model or dedicated Agent trust. Dedicated Agents receive
no automation-specific endpoint rule, CA map/mount or `CODEX_CA_CERTIFICATE`.
Retain default-deny, independent model/workload routes and unrelated Codex trust. Keep model credentials
out of the dedicated Gateway; refuse unenforceable topologies.

Native administrators and chat remain trusted writers outside OCC. OCC does
not adopt native jobs. The pinned [operator execution context](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/src/cron/execution-context.ts#L322)
and [Codex native tool construction](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/extensions/codex/src/app-server/dynamic-tool-build.ts#L523)
require origin checks in addition to tool names.

## Goals and non-goals

Support one-shot, interval and cron, CRUD, pause/resume, native normalization and
history. Exclude immediate execution, new destinations, scripts, triggers,
service-principal HTTP, Console and CLI. Scheduler housekeeping/failure notices can occur.

## Authorization and interface

All paths start with `/namespaces/{namespaceId}/agents/{agentId}/automations`.
Public automation UUIDs differ from native job IDs.

| Method and path  | Request                                 | Result                                      |
| ---------------- | --------------------------------------- | ------------------------------------------- |
| POST collection  | `name`, `enabled`, `schedule`, `prompt` | 201 and normalized job, after qualification |
| GET collection   | Optional `offset`, `limit`, `view`      | 200 and authorized selected-view entries    |
| GET `/{id}`      | No query                                | 200 and supported job                       |
| PATCH `/{id}`    | Expected revision and editable fields   | 200 and updated job                         |
| DELETE `/{id}`   | `expectedConfigRevision` query          | 204                                         |
| GET `/{id}/runs` | Optional `offset`, `limit`              | 200 and authorized native history           |

Creation requires a human session and exact-Agent `operate`; `administer` alone
does not substitute. Management and history require creator `operate` or
exact-Agent `administer`. Reuse these IAM actions and the Agent resource kind.
Service keys are refused. Mutations retain existing CSRF and Origin checks.

Authorize before native access or disclosure; foreign and absent ownership
records both return 404. Filter by the final
authority decision before public pagination, totals and snapshot hashes; losing
administration must not expose a previously loaded all-creator view. Malformed UUIDs return 400.

The collection defaults to the job view. `view=pending` selects pending
reservations from OCC records without native access, including when the runtime
is unavailable. Each pending entry has `id`, `status: "pending"`, `createdAt` and
server-issued `configRevision: "reservation:<id>"`, without native name or schedule. `offset`, `limit`, `total`, `nextOffset` and `snapshotRevision` apply
to the selected, authorized view. The job view returns `pendingReservations: []`;
the pending view returns `jobs: []`. Cancel an unbound reservation through DELETE with that revision in
`expectedConfigRevision`.

Bodies are closed. Clients cannot select native Agent IDs, creators, tool grants,
RPC methods, native scopes, credentials or delivery targets. PATCH can edit the
name, prompt, schedule and enabled state. Stale native revisions return 409.

## Native contract and ownership

Require the selected Driver's instance-pinned transport, native administrative
access, required methods and an unambiguous server-selected native Agent.
OCC invokes only `cron.add`, `cron.list`, `cron.get`, `cron.update`,
`cron.remove` and `cron.runs`, plus bounded qualification reads and `system.info` for peer identity.
Keep the administrative credential private.

Creation uses `sessionTarget: "isolated"`, `wakeMode: "now"`, an `agentTurn`
prompt with explicit `toolsAllow`, and `delivery.mode: "none"`. Preserve native
normalization (generated interval anchors and cron staggering) in reads and edits.
Persist immutable cap/bindings with the reservation; reassert the cap on update.
Policy additions never expand jobs. Each captured operation must retain its binding;
a missing alias cannot prove withdrawal because another tool or wrapper could reuse
its name. Narrowing, removal, remapping or unverifiable binding blocks enablement
and successor admission/startup while active, paused or uncertain records retain
the grant. Retire affected jobs, deploy narrower policy, then create new jobs;
never shrink a persisted cap. An empty MCP include can be unrestricted; disable or
omit the server instead of serializing `[]` as a restriction.

Before native create, reserve a public OCC UUID with its exact Namespace, Agent,
human creator, selected native Agent and creation time. Commit reservation and
admission audit atomically. Supply `occ-automation:<OCC UUID>` as the native
declaration key and create disabled. OpenClaw allocates the native ID. Bind it
durably once before a separate update enables the job if requested.

Creator/target fields are immutable; native IDs cannot be rebound or shared
within an Agent. Store no prompt, credential, duplicate definition or scheduler. Agent deletion removes its ownership rows. Native job deletion
retains them so the same creator/admin boundary authorizes history afterward.
Native history expiry still applies, and a deleted job that never ran returns 404.

A lost reply can leave a disabled job. Recovery matches the declaration key and
fills a missing binding once with audit; never replay create or enable. If transport
proves no send, or native rejects create and inventory confirms absence, discard
only the creator's unbound reservation atomically with audit. Concurrent binding
or failed audit prevents deletion. Keep admission evidence.

After uncertain create with no job, the creator with `operate` or exact-Agent
administrator can cancel the pending reservation using its revision. Atomically
discard the unbound record with audit; binding and cancellation cannot both succeed.
A delayed add can leave a disabled orphan. OCC cannot bind, enable, replay or
automatically clean it; a trusted native administrator removes it.

## Concurrency, failures and audit

PATCH sends the revision from its eligibility read to native atomic update.
DELETE also requires a revision. Inventory uses a consistent native snapshot and
exposes only authorized summaries.

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

Optional Compute operation `openAgentAutomationTransport(revision, qualification | undefined)`
returns a private connection to the verified instance. Creation, edits and
re-enablement require current qualification of the guarded launcher/version,
effective policy and trust. Redeploy a missing guard. After withdrawal,
`undefined` permits disable, delete and history under existing authorization.

Compute provisions a revision-specific Service and private operator HTTPRoute,
including for model-only jobs, with existing Envoy authentication, trusted
headers, scopes and NetworkPolicy. Ready EndpointSlice target UIDs must match the
sole live Gateway Pod before and after handshake. On the authenticated WebSocket,
verify `system.info` hostname against that Pod, retain `server.bootId`, and
recheck Pod UID, container ID and image. Refuse rollover; pin the socket through
read and mutation without reconnect or replay. Lost possibly sent writes return
`UNKNOWN_OUTCOME`. Exclude the Agent-wide route; remove revision routes at retirement.

Before **every** native Gateway process spawn, including supervisor respawn
and kubelet container restart, the launcher verifies the effective plugin
allowlist, plugin origins and package digests against the approved image. Reject
native tracked installs, mutable global extension roots, unapproved plugins,
digest mismatches and Node startup switches or module-loading overrides outside
the qualified allowlist. Compare embedded entries/MCP with the immutable mounted
source, and dedicated entries/MCP with the immutable rendered ConfigMap. Check
canonical switches and refuse `agents.list` before plugin loading or catch-up.

Serialize admission and enablement with deployment, or refuse a conflicting
successor. Before start, rollback or recovery, the worker checks every retained
grant, including paused and uncertain records, against the successor's operations
and bindings. Refuse startup on mismatch. Additions cannot widen a cap. A
same-revision restart repeats the local origin check; worker observation cannot
stop a running scheduler.

## Qualification and acceptance

- **AC1. Genuine execution.** Through OCC, exercise each schedule type on both
  packaged Harnesses. Provider or service records must prove a real permitted
  scheduled MCP operation has the same action, workload identity and standing
  approval as ordinary Agent chat.
- **AC2. Restricted execution.** On both Harnesses, verify forbidden sibling tool,
  second server, forbidden action, shell/file, delegation, messaging, app and
  discovery requests produce no provider effects; inspect the effective surface.
  Personal credentials or interactive approval cannot qualify. Refuse invalid
  provisioning before native access. Embedded rejects foreign, cron, dock,
  subagent or absent ordinary sessions, mismatched MCP identities and exhausted
  reads; dedicated reads no session/history. Check explicit model-only execution
  and refusal of Code Mode/tool search on nonempty caps.
- **AC3. Ownership and persistence.** Verify CSRF/Origin, service-key refusal,
  exact-Agent create and creator/admin management, UUID validation and native
  history after deletion. Demote the creator and verify the job still uses the
  shared Agent identity. An administrator can stop it. Pause, resume, edit
  and delete with native CAS. Preserve cap, binding, identity, paused state
  and retained history across compatible Gateway and Agent revision replacement.
- **AC4. Policy and recovery.** Narrow a literal filter, remove a trusted endpoint,
  and remap the same alias to another server or principal. With active, paused
  and uncertain records, verify successor admission/startup refuses each change.
  Retire affected jobs before narrowing. Race enablement with deployment; verify
  overdue recovery, rollback, refusal before catch-up, unchanged caps after
  additions, running-Gateway withdrawal limits and issued calls. Check native CAS,
  lost replies, failed audit and revision changes without duplicate dispatch.
- **AC5. Durable records.** Verify PostgreSQL reservation, binding and audit
  atomicity, lost-response pending discovery, authorized cancellation racing with
  binding, disabled late-add orphan handling, failed-create cleanup racing with binding, Agent deletion with
  sibling retention, and history access after deletion. Use packaged Harnesses and real endpoint, credential, model and database evidence
  as applicable.

- **AC6. Runtime and egress.** On both Harnesses, prove positive forwarding,
  zero redirect-sink effects, malformed/mutation denial, TLS with the projected CA,
  and rejection of an untrusted certificate, wrong hostname, sibling IP and port. On dedicated Codex verify credential isolation. Reject an old launcher,
  stale Pod/container evidence, mutable plugin origin, changed digest and
  unsupported Node switch or legacy `agents.list`. Repeat after native respawn and container restart
  with an overdue job. Race RPC admission with old and new Pods during
  cutover. Verify the checked instance receives the mutation or the request
  fails, and that the other instance receives no mutation.

## Delivery status

The [current reference](../../docs/reference/agent-automations.md) owns supported
behavior. Merge requires same-head genuine permitted and forbidden HTTPS checks
on both packaged Harnesses; synthetic bridge diagnostics do not qualify. The
[implementation plan](../plans/20261121-agent-automations.md) records evidence and gaps.
