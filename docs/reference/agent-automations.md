# Agent automations

The OpenClaw Control Plane (OCC) automation broker schedules turns in a deployed
Agent. OCC owns human authorization and immutable creator records. OpenClaw owns
job definitions, scheduling, execution and run history.

This implementation is under verification. See [verification status](#verification-status)
before relying on a particular runtime or Harness. Start with the
[scheduling guide](../guides/agent-automations.md) for HTTP usage.

## Ownership and authority

A human controller session needs exact-Agent `operate` to create a job. The same
permission admits reads and mutations of that creator's records. Exact-Agent
`administer` admits management of all OCE-owned jobs for the Agent, but does not
replace `operate` for creation. Service keys are refused. Foreign and absent
ownership records return the same 404 response.

OCE is the sole automation manager. Native edits, imports and reconciliation with
other managers are outside the supported workflow. Native jobs without an OCC
ownership record are not exposed through this API.

Execution uses the deployed Agent's service credentials and approved tool policy,
not the human creator's personal credentials. Runtime, sandbox, Harness and tool
restrictions still apply. Revoking the creator's `operate` grant removes their
management access; existing jobs continue unless disabled or stopped with the Agent.

## Requests and responses

All paths start with `/namespaces/{namespaceId}/agents/{agentId}/automations`.

| Method | Suffix                 | Request                                           | Success                   |
| ------ | ---------------------- | ------------------------------------------------- | ------------------------- |
| POST   | Collection             | Required `name`, `enabled`, `schedule`, `prompt`  | 201, job                  |
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

PATCH checks its `expectedConfigRevision` against the full job read used for
eligibility, then passes that revision to the native atomic mutation. DELETE
also uses a native revision precondition. Refresh after a 409; do not overwrite
another request's changes blindly.

## Persistence and history

OCC reserves a new UUID and its creator, exact Namespace, Agent and native Agent
before native create. The reservation and admission audit commit together.
OpenClaw chooses the native job ID. OCC creates disabled using its unique
declaration key, binds the returned native ID durably, then enables the job if
requested. A native ID cannot be rebound or shared by two records for the Agent.

A reservation does not prove a native job exists. Inventory or exact lookup can
recover a disabled native job and fill the missing ID binding. This writes only
OCC bookkeeping and audit; it never replays create or activates the job. A create
that fails after native creation can therefore leave a disabled job to inspect.

Ownership records survive native one-shot deletion and explicit deletion, so OCC
can authorize history afterward. Native history retention still applies; an
expired history or a deleted job that never ran returns 404. Agent
deletion removes its ownership rows with its lifecycle. There is no native-edit
import or automatic ownership adoption.

History returns run IDs, start/finish timestamps, execution and completion status,
delivery status, and available summary/error fields. Native payloads and history
content are excluded from OCC mutation audit.

## Runtime and failure boundaries

Both Installation and Agent native access must be enabled. OCC requires a running
selected revision, matching Compute ownership, a usable private endpoint and
runtime-image provenance for each main Gateway/Harness container. The current
source eligibility pin is `cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef`; a new pin
needs the automation proof before admission is extended. Missing provenance or
an unsupported source is refused before native cron dispatch.

The private connection must grant native administration, advertise all six cron
methods and identify one unambiguous native Agent. OCC's typed adapter enforces
the six-method surface; the underlying native credential has broader authority
and never reaches the caller. Browser chat scopes are unchanged.

A stopped, replacing or unavailable runtime returns `503 DEPENDENCY_UNAVAILABLE`.
A controller without automation transport returns `503 AUTOMATIONS_UNQUALIFIED`.
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

The refusal and ownership checks exercise the real HTTP application, session and
Native IAM boundaries. PostgreSQL coverage checks durable ownership, immutable
application-role access and atomic reservation/audit rollback. These checks do
not prove native model execution.

The native protocol case in `tests/integration/workspace-files-native.test.ts`
uses a real Gateway with a transparent fault proxy and in-memory OCC persistence.
It checks CRUD, owner filtering, lost replies, post-commit audit failure and revision
fencing without running a model. Its Compute fixture is not production placement proof.

The `agent-automations` [QA scenario](../testing/ci/qa-advisory.md) exercises the
regular deployed Agent workflow, including a scheduled tool effect, native one-shot
history and redeployment. Required model/tool-policy and production-runtime proof
remain recorded in the [implementation plan](../../specs/plans/20261121-agent-automations.md).
See the [source-backed flow](../flows/agent-automations.md) for implementation order.
