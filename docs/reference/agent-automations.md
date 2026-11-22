# Agent automations

The OpenClaw Control Plane (OCC) automation broker derives a ceiling of Agent-shared,
preapproved static Model Context Protocol (MCP) operations for scheduled turns. A qualified Agent with no eligible operations receives an
explicit empty ceiling, `[]`, for model-only execution. OCC owns authorization,
creator records and the saved grant; OpenClaw owns scheduling, execution and
history. Use the [scheduling guide](../guides/agent-automations.md) for HTTP operations.

The approved-MCP pilot is under qualification. Its implementation and earlier
model-only results do not establish MCP execution safety on every supported
Harness. See [verification status](#verification-status).

## Execution qualification

The selected runtime owner must qualify the deployed Agent's standing authority.
A raw native filter is not an authorization grant. Eligible operations must have:

- An enabled static MCP server with a nonempty, finite list of exact raw operations.
- Unambiguous canonical runtime aliases allowed by the Agent's Gateway tool policy
  and confirmed by effective native tool evidence.
- The same endpoint, workload credential identity, permitted provider actions and
  standing approval as ordinary unattended Agent execution.

The Kubernetes pilot may qualify explicitly trusted anonymous HTTPS MCP endpoints
for embedded OpenClaw. Dedicated Codex refuses nonempty MCP grants with
`503 AUTOMATIONS_UNQUALIFIED`; it does not silently downgrade them to `[]`.
Qualified model-only scheduling remains available. Stdio and general
credential-bearing MCP are not qualified. An
Installation administrator supplies the exact endpoint attestation through
[`automations.trustedAnonymousMcpEndpoints`](drivers/kubernetes-compute.md#automation-mcp-endpoints).
This is an operator trust decision, not permission inferred from an Agent's raw filter.

OCC saves the exact tool ceiling and opaque binding fingerprints. It stores no
credential values in this record. Clients cannot supply a ceiling, native aliases,
credentials or approval decisions. A tool that needs interactive approval or
requester-specific authority is ineligible. Approval of a tool does not approve
every action its arguments can request.

Approval settings belong to their runtime owner. Interactive approval cannot
qualify. A server's `codex.defaultToolsApprovalMode: "approve"` does not qualify
dedicated scheduling or grant additional operations or provider actions. The [Plugin Driver's app approval mapping](drivers/plugin-bundled.md#native-mappings-and-limits)
is a separate contract, outside this pilot.

For a nonempty MCP grant, Code Mode and tool search must already be off. OCC
refuses an incompatible configuration; automation admission does not turn these
features off for ordinary chat. Native shell/file tools, code, discovery,
delegation, messaging and apps are outside the tool-bearing pilot. Current managed
MCP Sandbox and native app topologies do not supply its qualification contract.

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
`defaultToolsApprovalMode: "approve"`. Plugin entries support only boolean `enabled`.
Unsupported extra settings in these controls refuse qualification.

The nonempty-grant pilot also requires immutable runtime image references and a
restricted native plugin namespace. Channel entries, selected managed/native
plugins and local plugin load paths are not qualified. Only the pinned core plugin
IDs verified not to add MCP declarations are admitted. Agent/model overrides must
not re-enable Code Mode or tool search. `gateway.nodes.pluginTools.enabled` and
`gateway.nodes.allowSkills` must be `false`; environment overrides, Secret bindings
and repository credentials are not qualified.

The deployed Gateway must use the version-bound, controller-rendered plugin-origin
guard and endpoint network/trust assets. Verification requires a read-only root
filesystem with no mounts replacing `/app`. The guard rechecks disabled Code Mode,
tool search and node plugin/skill controls, including Agent/model overrides. It
checks writable plugin discovery roots and installed-plugin state before each native Gateway spawn, including
respawns and container startup. Unsafe or unrecognized origins prevent startup.
Admission also checks `plugins.inspect` and `tools.catalog` for bundled provenance
and alias collisions, then corroborates MCP bindings with bounded `sessions.list`
and `tools.effective` reads. These checks do not grant authority or continuously
monitor a running process.

These limits govern model-requested tools. Scheduler housekeeping, bootstrap,
history processing and configured failure alerts can still occur. Ordinary chat
and native administration retain their existing policies and remain trusted.
Native writers can change jobs outside OCC. There is no native-edit import,
automatic adoption or tamper-resistant sole-writer guarantee.

## Ownership and authority

A human controller session needs exact-Agent `operate` to create a job. The same
permission admits reads and mutations of that creator's records. Exact-Agent
`administer` admits management of all OCE-owned jobs for the Agent, but does not
replace `operate` for creation. Service keys are refused. Foreign and absent
ownership records return the same 404 response.

Native edits, imports and reconciliation are outside the supported workflow.
Native jobs without an OCC ownership record are not exposed through this API.

Creation delegates the Agent's already-approved shared workload authority. It does
not capture the creator's personal account, provider credentials, session or
approval. The ceiling is relative to that Agent authority, not the creator's
personal provider permissions. Model requests use the Agent's runtime authentication.

Revoking the creator's `operate` removes management and history access unless
another grant permits it; it does not cancel existing jobs. An Agent administrator
can manage those jobs. A provider call already issued can complete after access
or configuration changes.

## Requests and responses

All paths start with `/namespaces/{namespaceId}/agents/{agentId}/automations`.

| Method | Suffix                 | Request                                           | Success                   |
| ------ | ---------------------- | ------------------------------------------------- | ------------------------- |
| POST   | Collection             | Required `name`, `enabled`, `schedule`, `prompt`  | 201, normalized job       |
| GET    | Collection             | Optional `offset`, `limit`                        | 200, authorized summaries |
| GET    | `/{automationId}`      | No query                                          | 200, job                  |
| PATCH  | `/{automationId}`      | Expected revision and at least one editable field | 200, job                  |
| DELETE | `/{automationId}`      | `expectedConfigRevision` query                    | 204                       |
| GET    | `/{automationId}/runs` | Optional `offset`, `limit`                        | 200, run history          |

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

Lists omit prompts and filter ownership before paging and totals. The public
`snapshotRevision` describes only authorized summaries. Restart a paged scan if
it changes. A registered unsupported job returns only ID, name, enabled state,
schedule kind and revision; GET and PATCH reject it. An Agent administrator can
remove it using the observed revision.

Automation IDs are UUIDs. Malformed IDs return 400 before persistence lookup;
well-formed missing IDs return 404. List disclosure uses the final authority mode,
so losing `administer` cannot expose rows loaded under the earlier grant.

PATCH checks its `expectedConfigRevision` against the full job read used for
eligibility, then passes that revision to the native atomic mutation. DELETE
also uses a native revision precondition. Refresh after a 409; do not overwrite
another request's changes blindly.

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

Ownership records survive native one-shot deletion and explicit deletion, so OCC
can authorize history afterward. Native history retention still applies; an
expired history or a deleted job that never ran returns 404. Agent
deletion removes its ownership rows with its lifecycle. There is no native-edit
import or automatic ownership adoption.

History returns run IDs, start/finish timestamps, execution and completion status,
delivery status, and available summary/error fields. Native payloads and history
content are excluded from OCC mutation audit.

## Policy changes and retained grants

Policy additions do not expand an existing automation. Admission and deployment
compare its saved grant with the selected runtime owner's qualified authority.
The captured grant must remain a subset of the successor's qualified operations,
with each captured binding unchanged. Unrelated operation additions can be
compatible, but cannot enlarge an existing job. Removing a captured operation,
even to narrow the Agent's policy, blocks the successor until the affected grant
is retired. Reusing its name for another endpoint, workload identity, action scope
or standing approval is also refused. Runtime image identity is part of the binding,
so an image change can require retiring and recreating affected automations.
Paused jobs and unresolved creation records retain their grants. Stopping an Agent does not retire those records.

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

Both Installation and Agent native access must be enabled. OCC requires a running
selected revision, matching Compute ownership, a usable private endpoint and
runtime-image provenance for each main Gateway/Harness container. The current
source eligibility pin is `cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef`; a new pin
needs management-protocol proof before admission is extended. This pin does not
qualify scheduled execution. Missing provenance or
an unsupported source is refused before native cron dispatch.

Compute opens a transport bound to the selected running Gateway instance. The
Kubernetes implementation uses a revision-specific Service and operator HTTPRoute
through existing Envoy authentication and filters. It verifies the sole live Pod,
container/image identity and EndpointSlice targets. The broker validates
`system.info` hostname against the expected Pod name on the handshake WebSocket.
It checks that the handshake boot ID and reported process-instance ID are bounded,
nonempty strings and that PID is positive; it does not compare those IDs with a
previously known process. Mutations require that captured identity and an unchanged
handshake boot ID. It rechecks the Pod/container instance before requests.
A closed connection is not reconnected or replayed. The Agent-wide route is not
an automation transport. Revision cleanup removes its route and Service.

Missing policy qualification permits only inventory, inspection, history,
disable-only updates and deletion under existing authorization and native-shape
checks. It never permits creation, other edits or re-enablement. Recovery still
requires the instance-bound transport and supported runtime provenance; it does
not fall back to another route.

The private connection must grant native administration, advertise all six cron
methods and identify one unambiguous native Agent. The native inspection methods
listed under [execution qualification](#execution-qualification) are private
qualification reads, not public operations or new mutation authority. OCC's typed adapter enforces the six cron
operations; the underlying native credential has broader authority
and never reaches the caller. Browser chat scopes are unchanged.

A stopped, replacing or unavailable runtime returns `503 DEPENDENCY_UNAVAILABLE`.
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
Use the response's `Location` path to inspect the automation or its `/runs`
history before deciding whether to issue another mutation. A missing live job
does not prove it never ran. A disconnect cannot guarantee cancellation of a
native effect, and a lost HTTP response can also lose its recovery reference.

## Verification status

The [implementation plan](../../specs/plans/20261121-agent-automations.md) records
results and remaining acceptance gates. Earlier model-only management, execution
and empty-cap refusal results remain historical evidence for that narrower
contract. They do not qualify a nonempty MCP grant, shared credential identity,
action restrictions, standing approval or policy-change handling.

The approved-MCP path needs real positive calls and independent provider-side
effects, followed by denied calls after narrowing or withdrawal, for each selected
Harness and packaged version. Source filters, rendered configuration and passing
fixture tests do not substitute for that proof. Testing setup and evidence belong
in the [runtime testing guide](../testing/docker.md); the
[source-backed flow](../flows/agent-automations.md) describes implementation order.
