# Agent automations

OpenClaw Control Plane (OCC) derives a ceiling of Agent-shared approved static
Model Context Protocol (MCP) operations for scheduled turns. Qualified `[]` permits
model-only execution. OCC owns authorization, creators and grants; OpenClaw owns
scheduling and history. See the [guide](../guides/agent-automations.md) and
[verification status](#verification-status).

## Execution qualification

The selected runtime owner must qualify the deployed Agent's standing authority.
A raw native filter is not an authorization grant. Eligible operations must have:

- An enabled static MCP server with a nonempty, finite list of exact raw operations.
- Unambiguous canonical runtime aliases allowed by the Agent's Gateway tool policy
  and confirmed by effective native tool evidence.
- The same endpoint, workload credential identity, permitted provider actions and
  standing approval as ordinary unattended Agent execution.

Only Kubernetes Compute can qualify operator-attested anonymous HTTPS MCP for
embedded OpenClaw or ordinary deployment-backed dedicated Codex. Provider-owned
Sandbox, protected-egress and credential deployment variants fail closed.
Qualify each packaged Harness with genuine permitted and forbidden HTTPS execution
proof before deployment. Unsupported qualification returns `503 AUTOMATIONS_UNQUALIFIED` without fallback;
qualified model-only scheduling remains available. Stdio and credential-bearing MCP
are unqualified. An Installation administrator supplies endpoint attestations through
[`automations.trustedAnonymousMcpEndpoints`](drivers/kubernetes-compute.md#automation-mcp-endpoints).

OCC saves ceilings and binding fingerprints, never credentials. Clients cannot
choose tools, credentials or approvals. Interactive or requester-specific authority
is ineligible; approve actions separately.

Dedicated requires `codex.defaultToolsApprovalMode: "approve"` on each HTTPS server;
this grants no provider actions. [App approval mapping](drivers/plugin-bundled.md#native-mappings-and-limits)
is outside this pilot.

For nonempty grants, Code Mode and tool search must already be off; admission
does not change ordinary chat. Shell/file tools, code, discovery, delegation,
messaging, apps and managed MCP Sandbox are outside this pilot.

Native writes carry an explicit `payload.toolsAllow`, including `[]` for a
model-only job. The adapter refuses automatic/default-tool flags, triggers,
non-isolated payloads and result delivery. It verifies eligibility and the native
revision from the same read before mutation. Unknown qualification, ambiguous
bindings or unsupported native state refuse admission rather than becoming an
implicit grant.

An empty MCP `toolFilter.include` can mean **all tools**. It is not an empty grant
or a revocation operation. When no operations remain, the supported policy
lifecycle must disable or omit the server; never replace its include list with
`[]` to restrict it.

For nonempty grants, `tools` supports only `profile`, `allow`, `alsoAllow`, `deny`,
`codeMode`, `toolSearch` and `gatewayPolicy`. Profiles are `minimal`, `coding`,
`messaging` or `full`. `gatewayPolicy` permits `allow`, per-tool `actions` and
`automations` (`scope: "caller"`, boolean `allowCommandJobs`). Enabled HTTPS servers
permit `enabled`, `url`, `transport`, `connectionTimeoutMs`, `requestTimeoutMs`,
`supportsParallelToolCalls`, `sslVerify`, `toolFilter` and `codex`. Timeouts must be
finite nonnegative numbers; `supportsParallelToolCalls` must be boolean and TLS
verification cannot be disabled. The `codex` object accepts only
`defaultToolsApprovalMode: "approve"`. Plugin entries accept `enabled`; dedicated Codex also requires its qualified
guardian WebSocket `config`.
Extra settings refuse qualification.

The nonempty-grant pilot also requires immutable runtime image references and a
restricted native plugin namespace. Channel entries, selected managed/native
plugins and local plugin load paths are not qualified. Only pinned core plugin IDs
without MCP declarations qualify. OCC admits sole
`agents.entries.main.identity.name` under the [API Name rule](../../packages/contracts/src/api/plain-text.ts).
The grant binds its exact value. Embedded may use identity alone;
dedicated also requires exact aliases in `main.tools.allow`, Gateway policy and
literal MCP filters. Bindings include workspace, guardian posture and exclusions;
no app-server token or URL.
Agent/model overrides cannot re-enable Code Mode or tool search; legacy
`agents.list` is refused. `gateway.nodes.pluginTools.enabled` and
`gateway.nodes.allowSkills` must be `false`; environment overrides, Secret bindings
and repository credentials are not qualified.

The deployed Gateway must use the version-bound, controller-rendered plugin-origin
guard and endpoint network/trust assets. Verification requires a read-only root
filesystem with no mounts replacing `/app`. The guard compares canonical entries
and MCP with immutable mounted source for embedded, or the immutable rendered
ConfigMap for dedicated. It rechecks Code Mode, tool search and node plugin/skill
controls, including Agent/model overrides. It
checks writable plugin discovery roots and installed-plugin state before each native Gateway spawn, including
respawns and container startup. Unsafe or unrecognized origins prevent startup.
Both paths check bundled plugin provenance and core or plugin collisions through
`plugins.inspect` and `tools.catalog`. Server include filters apply before native alias allocation. Dedicated checks the
complete resulting source namespace before Gateway, Agent or caller subsets, refusing
collisions, suffix ambiguity and reserved `mcp__` prefixes (case-insensitive). Embedded
corroborates MCP bindings using `sessions.list` and `tools.effective` from an
ordinary same-Agent session. Cron, subagent, system,
dock, foreign and unknown scopes or session-denied tools are ineligible. Dedicated
uses the standing Agent grant without session/effective/history reads or
chat-session-specific denial inheritance. Packaged-runtime parity is qualification
proof, not discovery during creation. Both Harnesses refuse enabled raw include
entries starting case-insensitively with their own normalized safe server prefix
plus `__` (alias selectors), or utility names `resources_list`, `resources_read`,
`prompts_list`, `prompts_get` (case-insensitive). Unrelated raw `foo__bar` remains valid. Refuse
before subsets without probe or fallback.

These limits govern model-requested tools, not scheduler housekeeping, bootstrap,
history or failure alerts. Ordinary chat and native administrators remain trusted
writers outside OCC; OCC does not import or adopt their native jobs.

## Ownership and authority

A human session needs exact-Agent `operate` to create, read and manage
records it created. Exact-Agent `administer` manages all OCC-owned records but
cannot replace `operate` for creation. OCC refuses service keys; foreign and absent
ownership records return the same 404.

Creation delegates the Agent's approved shared workload authority, never the
creator's personal account, provider credential, session or approval. Model
requests use the Agent's runtime authentication.

Revoking the creator's `operate` removes management and history access unless
another grant permits it; it does not cancel existing jobs. An Agent administrator
can manage those jobs. A provider call already issued can complete after access
or configuration changes.

## Requests and responses

All paths start with `/namespaces/{namespaceId}/agents/{agentId}/automations`.

| Method | Suffix                 | Request                                           | Success                 |
| ------ | ---------------------- | ------------------------------------------------- | ----------------------- |
| POST   | Collection             | Required `name`, `enabled`, `schedule`, `prompt`  | 201, normalized job     |
| GET    | Collection             | Optional `offset`, `limit`, `view`                | 200, authorized entries |
| GET    | `/{automationId}`      | No query                                          | 200, job                |
| PATCH  | `/{automationId}`      | Expected revision and at least one editable field | 200, job                |
| DELETE | `/{automationId}`      | `expectedConfigRevision` query                    | 204                     |
| GET    | `/{automationId}/runs` | Optional `offset`, `limit`                        | 200, run history        |

Create and edit accept `at` with an RFC3339 timestamp, `every` with a positive
integer `everyMs`, or `cron` with `expr` and an IANA `tz`. Native validation owns
schedule semantics. Responses preserve normalized `anchorMs` and `staggerMs`
when present. A job also returns `id`, `configRevision`, `name`, `enabled`,
`prompt`, `nextRunAtMs` and `lastRunStatus`.

Request limits are 200 characters for the name, 16,384 for the prompt, 256 for a
cron expression and 128 for its time zone. Page limits are 1–100 (default 50);
offsets are 0–999,999,999 (default 0). Expected revisions are nonempty strings of
at most 128 characters. Mutations require the configured Origin and existing
session CSRF checks. Native routing/authority headers and extra body fields are
rejected; callers cannot choose native Agent IDs, creators or tool grants.

The default collection view returns native job summaries in `jobs` and an empty
`pendingReservations` array. `view=pending` returns unbound OCC reservations in
`pendingReservations` and an empty `jobs` array; it does not contact the native
runtime. Each pending entry has `id`, `status: "pending"`, `createdAt` and
`configRevision: "reservation:<id>"`. It has no native name or schedule.

Both views filter by authority before paging. `total`, `nextOffset` and
`snapshotRevision` describe the selected authorized view. Restart a paged scan if
the snapshot changes. Job summaries omit prompts. A registered unsupported job
returns only ID, name, enabled state, schedule kind and revision; GET and PATCH
reject it. An Agent administrator can remove it using the observed revision.

Malformed automation UUIDs return 400; missing valid UUIDs return 404. List disclosure uses the final authority mode,
so losing `administer` cannot expose rows loaded under the earlier grant.

PATCH checks its `expectedConfigRevision` against the full job read used for
eligibility, then passes that revision to the native atomic mutation. DELETE of a
job also uses a native revision precondition. For an unbound reservation, DELETE
accepts its `reservation:<id>` revision and uses local conditional deletion; it
does not contact the native runtime. Refresh after a 409; do not overwrite another
request's changes blindly.

## Persistence and history

OCC reserves a new UUID and its creator, exact Namespace, Agent and native Agent
before native create. Under the Namespace and Agent locks, OCC rechecks the
selected revision and its qualified authority, then commits the immutable tool
grant, binding snapshot and admission audit with the reservation.
OpenClaw chooses the native job ID. OCC creates disabled using its unique
declaration key, binds the returned native ID durably, then enables the job if
requested. A native ID cannot be rebound or shared by two records for the Agent.

A reservation does not prove a native job exists. Inventory or exact lookup can
recover a disabled native job and fill the missing ID binding. This writes only
OCC bookkeeping and audit; it never replays create or activates the job. A create
that fails after native creation can therefore leave a disabled job to inspect.

If transport proves create was not sent, or native rejects create and a subsequent
inventory confirms no job exists, OCC conditionally removes the unbound reservation
and records that outcome in the same transaction. Admission audit remains. Cleanup
cannot remove another creator's reservation or a bound native identity. Lost replies,
failed absence checks and other uncertain outcomes retain the recovery record.

The creator with `operate`, or an exact-Agent administrator, can list and cancel
an unbound reservation even when the native runtime is unavailable. OCC commits
the conditional deletion and audit together. Binding and cancellation cannot
both succeed. Cancellation releases the reservation's grant. If a delayed native
add completes afterward, its job remains disabled because OCC cannot bind or
enable it. A trusted native administrator must remove that orphan; OCC does not
automatically adopt or clean it up.

Ownership records survive native one-shot deletion and explicit deletion, so OCC
can authorize history afterward. Native history retention still applies; an
expired history or a deleted job that never ran returns 404. Agent
deletion removes its ownership rows with its lifecycle. There is no native-edit
import or automatic ownership adoption.

History returns run IDs, start/finish timestamps, execution and completion status,
delivery status, and available summary/error fields. Native payloads and history
content are excluded from OCC mutation audit.

## Policy changes and retained grants

Admission and deployment require each saved grant to remain a subset of the
successor's qualified operations with unchanged bindings. Additions cannot enlarge
an existing job. Removing an operation or reusing its name for another endpoint,
identity, action scope or approval blocks the successor until grant retirement.
Image identity is part of the binding, so image changes can require retirement
and recreation. Paused jobs and unresolved reservations retain grants; stopping
an Agent does not retire them.

Deployment admission and the worker recheck retained grants before a successor
can run. OCC-managed preparation, recovery and maintenance repeat that check. A kubelet
restart of the same immutable live revision has no new controller callback and
can run native cron catch-up under its captured standing grant. A policy change is
refused when an unretired automation depends on a binding the successor no longer
preserves. Review the
[replacement boundary](agents/planned-replacement.md) before changing deployment inputs.

Grant retirement is separate from history retention. After a confirmed native
DELETE, OCC retires the grant and records that transition atomically with audit.
For a bound job already deleted by the native scheduler, an authorized DELETE
can retire the grant after definite native absence, while returning 404. A 404
alone does not establish retirement: foreign and absent records have the same
public response. Retired rows retain their immutable grant and native identity
for history, but no longer constrain successors. Pausing, a lost reply or an
unconfirmed absence does not release a grant.

To narrow a captured grant, delete and retire the affected automation, deploy the
narrower Agent policy, then create a new automation. Retirement preserves history;
it does not authorize reusing the old job with new authority.

Removing an endpoint from the Installation attestation blocks new eligibility and
startup qualification. It does not stop an already-running native scheduler.
Disable or delete jobs to stop future scheduling. For immediate denial of further
provider calls, use service-side denial; an in-flight call can still complete.

Do not overwrite a shared Secret to work around a binding refusal. A stable
Secret reference does not prove an unchanged workload identity or action scope.
General credentialed MCP and same-reference Secret rotation do not satisfy this
pilot's qualification. Secret APIs do not retire automation grants.

## Runtime and failure boundaries

Native operations require Installation and Agent native access, a running selected
revision, matching Compute ownership, a private endpoint and runtime-image
provenance for each main Gateway/Harness container. Source eligibility pins `cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef`; changing it
requires management-protocol proof; the pin alone does not qualify scheduled
execution. Refuse missing provenance or unsupported source before cron dispatch.

Compute opens a transport bound to the selected running Gateway instance. The
Kubernetes implementation uses a revision-specific Service and operator HTTPRoute
through existing Envoy authentication and filters. It verifies the sole live Pod,
container/image identity and EndpointSlices. For nonempty grants, it also verifies
the Gateway ServiceAccount, embedded ServicePrincipal and configured projected identity, and
immutable revision-owned mounted ConfigMap with exact rendered `openclaw.json`,
even without optional CA. The broker checks `system.info` hostname against the Pod
name. Boot and process-instance IDs must be 1–128 characters and PID positive;
neither ID has a prior expected value. Mutations require captured identity and
unchanged boot ID; each request rechecks the Pod and container.
A closed connection is not reconnected or replayed. The Agent-wide route is not
an automation transport. Revision cleanup removes its route and Service.

Missing policy qualification permits only inventory, inspection, history,
disable-only updates and deletion under existing authorization and native-shape
checks. It never permits creation, other edits or re-enablement. Native job recovery still requires the instance-bound transport and supported
runtime provenance; it does not fall back to another route. The pending view and
reservation cancellation do not require native access.

The private connection must grant native administration, advertise all six cron
methods and identify one unambiguous native Agent. The native inspection methods
listed under [execution qualification](#execution-qualification) are private
qualification reads, not public operations or new mutation authority. OCC's typed adapter enforces the six cron
operations; the underlying native credential has broader authority
and never reaches the caller. Browser chat scopes are unchanged.

A stopped, replacing or unavailable runtime returns `503 DEPENDENCY_UNAVAILABLE`
for native-dependent requests.
Missing automation transport returns `503 AUTOMATIONS_UNQUALIFIED`. Updates and
explicit re-enablement also require current qualification of the captured grant.
After policy withdrawal, disable-only PATCH, DELETE and history remain available,
subject to their normal authorization, transport and native-shape checks.
Unsupported native job shapes cannot be enabled or edited.
Invalid requests return 400; human/Agent denials return 403; absent or hidden jobs
return 404; conflicts and unsupported job shapes return 409.

A lost mutation reply, malformed acknowledgement, selected-revision change after
dispatch, or failed success-audit append returns `503 UNKNOWN_OUTCOME`. OCC records
an indeterminate outcome when audit is available and does not replay the request.
Inspect `Location` or `/runs` before another mutation. A missing job does not
prove it never ran. Disconnect does not cancel native effects; a lost response
can lose its recovery reference.

## Verification status

The [plan](../../specs/plans/20261121-agent-automations.md) records gates. Each
packaged Harness needs real permitted provider effects and denials after narrowing
or withdrawal; model-only fixtures and rendered settings do not qualify MCP. See
[testing](../testing/docker.md) and the [flow](../flows/agent-automations.md).
