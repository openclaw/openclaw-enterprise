# Agent automations

OpenClaw Control Plane (OCC) derives a ceiling of Agent-shared approved static
Model Context Protocol (MCP) operations for scheduled turns. Qualified `[]` permits
model-only execution. OCC owns authorization, creators and grants; OpenClaw owns
scheduling and history. See the [guide](../guides/agent-automations.md) and
[verification status](#verification-status).

## Execution qualification

The runtime owner must qualify deployed Agent standing authority; a raw native
filter is not a grant. Eligible operations require:

- An enabled static MCP server with a finite nonempty list of exact raw operations.
- Unambiguous canonical aliases allowed by Gateway policy and confirmed by
  effective native evidence.
- The same endpoint, workload credential identity, permitted provider actions and
  standing approval as ordinary unattended execution.

Kubernetes Compute qualifies Installation-attested anonymous HTTPS MCP for embedded
OpenClaw and ordinary deployment-backed dedicated Codex. Nonempty grants reject
provider-owned Sandbox, protected/credential deployments, native Git v9, stdio
and credential-bearing MCP. Each packaged Harness needs genuine permitted and
forbidden HTTPS execution proof. Unsupported qualification returns
`503 AUTOMATIONS_UNQUALIFIED` without fallback. The Installation administrator
supplies [endpoint attestations](drivers/kubernetes-compute.md#automation-mcp-endpoints).
For nonempty grants, every enabled server requires attested `streamable-http`.
Reject SSE, HTTP, caller loopback, more than 64 routes and Gateway port 47730/47731
without holding chat; reject
equivalent duplicate IPv6 host CIDRs. Public source retains HTTPS URLs; Compute
projects Gateway loopback routes. Each grant binds the full enabled map and its
attestations, so sibling changes invalidate it. Catalog setup may initialize/list
siblings before filtering; forbidden calls remain denied. Model-only
`toolsAllow: []` skips MCP acquisition.

The Gateway proxy pins the checked DNS address, verifies target TLS with route-local
CA when set,
rejects 3xx without Location or replay, and permits GET/POST/DELETE and protocol
headers. Limits are 32 concurrent exchanges, 4 MiB request, 32 MiB response, 60-second idle
and 300-second deadline. Proxy failure holds the Gateway unready. Endpoint egress
is Gateway-only; automation CA does not expand Gateway/model or Agent trust.

OCC saves ceilings and binding fingerprints, never credentials. Clients cannot
choose tools, credentials or approvals. Interactive or requester-specific authority
is ineligible; approve actions separately.

Dedicated Codex requires `harnessAuth.method: "api_key"` and both raw Agent
revision settings `tools.codeMode: false` and
`tools.gatewayPolicy.automations: {scope: "caller", allowCommandJobs: false}`
for every grant, including `[]`. Rendered Gateway defaults do not opt in.
Runtime, PAT, OAuth, ChatGPT and `credential_source` authentication do not
qualify. Dedicated grants refuse repository credentials, repository
NetworkPolicy, protected native Git and Driver `beforeWorkloadStart` callbacks. Compute mounts revision-owned Codex
requirements read-only in the Agent Pod. They pin `code_mode_host`, `code_mode`, `code_mode_only` and `sleep_tool`
to `false`; Agent-local readiness confirms the effective requirements. Admission
requires the exact Ready Pod, probe, mount, image and source. These pins remove
Code Mode and native sleep from ordinary Agent chat.

Each dedicated HTTPS server requires `codex.defaultToolsApprovalMode: "approve"`;
this grants no provider actions. The Standard guardian requires
`approvalPolicy: "on-request"`, `approvalsReviewer: "user"` (not `auto_review`),
and `sandbox: "workspace-write"`. Its `networkProxy` requires `enabled: true`,
`baseProfile: "workspace"`, `mode: "limited"`, 1–64 canonical lowercase
multi-label DNS `domains` mapped to `allow` or `deny`, and empty `unixSockets`.
Set `enableSocks5`, `enableSocks5Udp`, `allowUpstreamProxy`,
`allowLocalBinding`, `dangerouslyAllowNonLoopbackProxy` and
`dangerouslyAllowAllUnixSockets` to `false`. Reject IPs, wildcards, localhost,
extra keys, overrides and caller `readOnlyPaths`. Grants bind reviewer/proxy,
filesystem permissions and ordered server-owned `readOnlyPaths`
(`/app/node_modules/openclaw`, `/home/node/.codex/skills/.system`). Proxy hosts
do not authorize MCP access. [App approval mapping](drivers/plugin-bundled.md#native-mappings-and-limits)
is outside this pilot.

Dedicated grants require tool search off; embedded nonempty grants require Code
Mode and tool search off. Shell/file tools,
code, discovery, delegation, messaging, apps and managed MCP Sandbox are outside
this pilot. Approved dedicated MCP calls use direct dynamic-tool declarations;
a native `exec` wrapper does not qualify.

Native writes set explicit `payload.toolsAllow`. The empty cap disables
model-selected tools. Trusted administrator hooks and required runtime setup can
still run. Refuse automatic/default-tool flags, triggers, non-isolated payloads,
delivery, unknown qualification, ambiguous bindings and unsupported state; check
eligibility/native revision from one read before mutation.

An empty MCP `toolFilter.include` can mean **all tools**. To revoke all operations,
disable or omit the server; never use `[]` as a restriction.

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

Dedicated grants and embedded nonempty grants require immutable images and a
restricted plugin namespace.
Channel entries, selected managed/native plugins and local load paths are
unqualified; only pinned core plugin IDs without MCP declarations qualify. OCC
binds sole `agents.entries.main.identity.name` under the
[API Name rule](../../packages/contracts/src/api/plain-text.ts). Embedded may use
identity alone; dedicated needs matching `main.tools.allow` and Gateway allow
lists (`[]` for model-only), plus literal MCP filters. Bindings include workspace, guardian
posture and exclusions, never app-server token or URL. Refuse legacy `agents.list`,
environment overrides, Secret bindings and repository credentials. Agent/model
overrides cannot re-enable Code Mode or tool search; `gateway.nodes.pluginTools.enabled`
and `gateway.nodes.allowSkills` must be `false`.

For qualified embedded MCP, Compute supplies `meta.lastTouchedVersion: "2026.11.5"`;
caller `meta` and existing `compat` are refused. Discovery, Doctor and package
checks follow the [startup flow](../flows/agent-automations.md#2-qualify-the-selected-runtime-and-effective-mcp-operations).
Requalify pin changes.

A version-bound guard checks rendered entries/MCP, Code Mode/tool search, node
plugin/skill controls, Agent/model overrides and plugin discovery before every
Gateway spawn. Unknown origins block startup. Require a read-only root and no
`/app` replacement mounts. `plugins.inspect` and `tools.catalog` verify provenance
and collisions; include filters precede alias allocation. Dedicated rejects
collisions, suffix ambiguity and reserved `mcp__` prefixes before subsets,
ignoring case. Embedded reads at most 100 `sessions.list` rows and probes at
most 20 `tools.effective` sessions. Trusted hello `mainSessionKey` prioritizes
an eligible canonical browser `main` in inventory; otherwise inspect the first
20 rows in native order. Main outside inventory may be unavailable. Require
unparented ordinary same-Agent scope; grouped New Chat roots with parent lineage
are ineligible. Exclude cron, subagent, system, dock, foreign, unknown and
session-denied scopes/tools. Dedicated skips session/effective/history reads and
chat denials; packaged parity replaces discovery. Both Harnesses reject raw
includes beginning with their normalized server prefix plus `__`, and utility
names `resources_list`, `resources_read`, `prompts_list`, `prompts_get`
(case-insensitive), before subsets without probe or fallback; unrelated raw
`foo__bar` remains valid.

Scheduler housekeeping, history and failure alerts remain outside model-requested
limits. Chat and native administrators are trusted writers outside OCC; OCC does
not adopt their jobs.

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

The default view returns native summaries in `jobs` and `pendingReservations: []`.
`view=pending` returns unbound OCC reservations in `pendingReservations` and
`jobs: []` without native access. Entries contain `id`, `status: "pending"`,
`createdAt` and `configRevision: "reservation:<id>"`, never native name or schedule.

Both views filter by authority before paging; `total`, `nextOffset` and
`snapshotRevision` describe the selected authorized view. Restart a scan if its
snapshot changes. Summaries omit prompts. A registered unsupported job exposes
only ID, name, enabled state, schedule kind and revision; GET/PATCH reject it.
An Agent administrator can remove it with the observed revision.

Malformed automation UUIDs return 400; missing valid UUIDs return 404. List disclosure uses the final authority mode,
so losing `administer` cannot expose rows loaded under the earlier grant.

PATCH checks its `expectedConfigRevision` against the full job read used for
eligibility, then passes that revision to the native atomic mutation. DELETE of a
job also uses a native revision precondition. For an unbound reservation, DELETE
accepts its `reservation:<id>` revision and uses local conditional deletion; it
does not contact the native runtime. Refresh after a 409; do not overwrite another
request's changes blindly.

## Persistence and history

Before native create, OCC reserves a UUID, creator, exact Namespace, Agent and
native Agent. Under Namespace and Agent locks, OCC rechecks revision and authority,
then atomically commits the reservation, immutable grant, binding snapshot and
admission audit. OpenClaw chooses the native ID; OCC creates disabled with a unique
declaration key, durably binds the ID and enables if requested. Native IDs cannot
be rebound or shared within an Agent.

A reservation does not prove a native job exists. Inventory or exact lookup can
recover a disabled job and fill its binding with OCC bookkeeping and audit only;
it never replays create or activates the job. Failed create can leave a disabled job.

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

Each saved grant must remain a subset of successor qualified operations with
unchanged bindings; additions cannot enlarge jobs. Removing an operation or
reusing its name for another endpoint, identity, action scope or approval blocks
the successor until retirement. Image changes can require retirement/recreation.
Paused jobs and unresolved reservations retain grants; stopping an Agent does not retire them.

Admission and the worker recheck retained grants before successor startup and during
OCC-managed preparation, recovery and maintenance. Kubelet restart of the same
immutable revision has no controller callback and may run native cron catch-up
under the captured grant. Review the
[replacement boundary](agents/planned-replacement.md) before changing inputs.

Grant retirement is separate from history retention. Confirmed native DELETE
atomically retires the grant with audit. For a bound job already deleted by the
scheduler, authorized DELETE can retire after definite native absence while
returning 404. A 404 alone cannot prove retirement: foreign and absent records
share that response. Retired rows keep immutable grant and native identity for
history but no longer constrain successors. Pause, lost reply or unconfirmed
absence does not release a grant.

To narrow a captured grant, delete and retire the affected automation, deploy the
narrower Agent policy, then create a new automation. Retirement preserves history;
it does not authorize reusing the old job with new authority.

Removing an endpoint from the Installation attestation blocks new eligibility and
startup qualification. Neither that change nor readiness loss closes an established
Gateway-to-Agent connection or stops native cron.
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

Compute binds selected running Gateway transport through revision Service/operator
HTTPRoute with Envoy authentication/filters. Verify the sole
live Pod, container/image and EndpointSlices; nonempty grants also verify Gateway
ServiceAccount, embedded ServicePrincipal/projected identity and immutable
revision-owned mounted ConfigMap with exact rendered `openclaw.json`, even without
a CA. Match `system.info` hostname to the Pod. Boot/process-instance IDs are 1–128
characters, PID positive; no prior values are expected. Mutations need
captured identity and unchanged boot ID; recheck Pod/container per request. Never
reconnect/replay or use the Agent-wide route; cleanup removes route and Service.

Without policy qualification, permit only authorized inventory, inspection, history,
disable-only PATCH and DELETE with normal native-shape and instance-bound transport
checks. Pending view and reservation cancellation need no native access.

The private connection requires native administration and one unambiguous native
Agent. Inspection methods under
[execution qualification](#execution-qualification) are private reads, not public
operations or mutation authority. OCC's typed adapter enforces six cron operations;
the broader native credential never reaches callers. Browser chat authorization scopes stay unchanged.

A stopped, replacing or unavailable runtime returns `503 DEPENDENCY_UNAVAILABLE`
for native-dependent requests.
Missing automation transport returns `503 AUTOMATIONS_UNQUALIFIED`. Editing or
re-enabling requires current captured-grant qualification; unsupported native job
shapes cannot be edited or enabled.
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
